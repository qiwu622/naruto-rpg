import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getUser, recordLogin, upsertUser } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/async-route.js';
import { APP_LINK_CODE_PATTERN } from './app-link.js';

export const DISCORD_FETCH_TIMEOUT_MS = 15_000;
export const DISCORD_STANDARD_MAX_BYTES = 256 * 1024;
export const DISCORD_GUILDS_MAX_BYTES = 2 * 1024 * 1024;

function resolveDiscordUrl(url) {
  if (config.proxy?.enabled && config.proxy.url) {
    return url.replace('https://discord.com', config.proxy.url);
  }
  return url;
}

function createAbortError(message, code = 'DISCORD_REQUEST_ABORTED') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = code;
  return error;
}

async function discardResponseBody(response) {
  if (!response?.body || response.bodyUsed) return;
  await response.body.cancel().catch(() => {});
}

export async function readDiscordJsonLimited(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await discardResponseBody(response);
    const error = new Error(`Discord response exceeds ${maxBytes} bytes`);
    error.code = 'DISCORD_RESPONSE_TOO_LARGE';
    throw error;
  }
  if (!response.body) {
    const error = new Error('Discord response body is empty');
    error.code = 'DISCORD_RESPONSE_INVALID';
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let received = 0;
  let text = '';
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        const error = new Error(`Discord response exceeds ${maxBytes} bytes`);
        error.code = 'DISCORD_RESPONSE_TOO_LARGE';
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      error.code ||= 'DISCORD_RESPONSE_INVALID';
    }
    throw error;
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Fetches and parses one bounded Discord API response. The timeout remains
 * active until the complete response body has been consumed.
 */
export async function fetchDiscordJson(url, options = {}, {
  signal = options.signal,
  timeoutMs = DISCORD_FETCH_TIMEOUT_MS,
  maxBytes = DISCORD_STANDARD_MAX_BYTES,
  fetchImpl = globalThis.fetch
} = {}) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(
    signal?.reason || createAbortError('Discord request cancelled by caller')
  );
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });

  const timeout = setTimeout(() => {
    controller.abort(createAbortError('Discord request timed out', 'DISCORD_REQUEST_TIMEOUT'));
  }, timeoutMs);

  let response;
  try {
    response = await fetchImpl(resolveDiscordUrl(url), {
      ...options,
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) {
      await discardResponseBody(response);
      return { ok: false, status: response.status, data: null };
    }
    const data = await readDiscordJsonLimited(response, maxBytes);
    return { ok: true, status: response.status, data };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
    await discardResponseBody(response);
  }
}

const router = Router();

export function ensureCsrfCookie(req, res) {
  const existing = req.cookies?.naruto_csrf;
  if (typeof existing === 'string' && /^[a-f0-9]{64}$/u.test(existing)) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie('naruto_csrf', token, {
    httpOnly: false,
    secure: config.nodeEnv === 'production' && req.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  return token;
}

/**
 * GET /auth/discord - 发起 Discord 授权重定向
 */
router.get('/discord', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const appCode = String(req.query.app_code || '').toUpperCase();
  if (APP_LINK_CODE_PATTERN.test(appCode)) {
    res.cookie('discord_oauth_app_code', appCode, {
      httpOnly: true, secure: config.nodeEnv === 'production' && req.secure,
      sameSite: 'lax', path: '/', maxAge: 10 * 60 * 1000
    });
  } else res.clearCookie('discord_oauth_app_code', { path: '/' });
  
  // 将 state 存入 Cookie 以进行 CSRF 验证（有效时间 10 分钟）
  res.cookie('discord_oauth_state', state, {
    httpOnly: true,
    secure: config.nodeEnv === 'production' && req.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000
  });

  const authorizeUrl = `https://discord.com/api/oauth2/authorize?` + new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state: state
  }).toString();

  res.redirect(authorizeUrl);
});

/**
 * GET /auth/discord/callback - 处理 Discord 回调
 */
router.get('/discord/callback', asyncRoute(async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('[DISCORD CALLBACK] OAuth error:', error, error_description);
    return res.redirect(`/login.html?error=access_denied&desc=${encodeURIComponent(error_description || '')}`);
  }

  // 1. 验证 state 防范 CSRF 攻击
  const savedState = req.cookies.discord_oauth_state;
  res.clearCookie('discord_oauth_state');
  const appCode = req.cookies.discord_oauth_app_code;
  res.clearCookie('discord_oauth_app_code', { path: '/' });

  if (!state || state !== savedState) {
    // 不记录 state 或 Cookie 内容：同一请求可能携带登录 JWT，写入日志会泄露凭证。
    console.warn('[DISCORD CALLBACK] OAuth state mismatch.');
    return res.redirect('/login.html?error=csrf_error');
  }

  if (!code) {
    return res.redirect('/login.html?error=missing_code');
  }

  const clientAbort = new AbortController();
  let clientDisconnected = false;
  const abortForDisconnectedClient = () => {
    if (res.writableEnded) return;
    clientDisconnected = true;
    clientAbort.abort(createAbortError('OAuth client disconnected'));
  };
  req.once('aborted', abortForDisconnectedClient);
  res.once('close', abortForDisconnectedClient);

  try {
    // 2. 用 code 换取 access_token
    const tokenResult = await fetchDiscordJson('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: config.discord.redirectUri
      }).toString()
    }, {
      signal: clientAbort.signal,
      maxBytes: DISCORD_STANDARD_MAX_BYTES
    });

    if (!tokenResult.ok) {
      console.error('[DISCORD CALLBACK] Failed to exchange code for token:', tokenResult.status);
      return res.redirect('/login.html?error=auth_failed');
    }

    const tokens = tokenResult.data;
    const accessToken = tokens.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('Discord token response did not include an access token');
    }

    // 3. 获取 Discord 用户个人资料
    const userResult = await fetchDiscordJson('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }, {
      signal: clientAbort.signal,
      maxBytes: DISCORD_STANDARD_MAX_BYTES
    });

    if (!userResult.ok) {
      console.error('[DISCORD CALLBACK] Failed to fetch user profile:', userResult.status);
      return res.redirect('/login.html?error=fetch_profile_failed');
    }

    const discordUser = userResult.data;
    if (!discordUser || typeof discordUser !== 'object' || typeof discordUser.id !== 'string') {
      throw new Error('Discord user response is invalid');
    }

    // 4. 校验用户是否属于指定的服务器群组之一。
    const rawGuildId = config.discord.requiredGuildId;
    const isBypass = !rawGuildId || rawGuildId === 'your_discord_server_id_here' || rawGuildId === 'your-discord-server-id';
    let isMember = isBypass;
    if (!isBypass) {
      const guildsResult = await fetchDiscordJson('https://discord.com/api/v10/users/@me/guilds', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }, {
        signal: clientAbort.signal,
        maxBytes: DISCORD_GUILDS_MAX_BYTES
      });
      if (!guildsResult.ok) {
        console.error('[DISCORD CALLBACK] Failed to fetch user guilds:', guildsResult.status);
        return res.redirect('/login.html?error=fetch_guilds_failed');
      }
      const guilds = guildsResult.data;
      if (!Array.isArray(guilds)) throw new Error('Discord guilds response is invalid');
      const targetGuildIds = rawGuildId.split(',').map(id => id.trim()).filter(Boolean);
      isMember = guilds.some(guild => targetGuildIds.includes(guild.id));
    }

    if (!isMember) {
      console.log(`[DISCORD CALLBACK] User ${discordUser.username} (${discordUser.id}) was rejected. Not a member of required guilds: ${rawGuildId}`);
      return res.redirect('/login.html?error=not_in_guild');
    }

    // 6. 验证成功，保存/更新用户到用户库；写入失败会走 catch 分支，避免「登录成功但账户不存在」的死循环
    await upsertUser({
      id: discordUser.id,
      username: discordUser.username,
      discriminator: discordUser.discriminator,
      avatar: discordUser.avatar,
      global_name: discordUser.global_name,
      last_login: new Date().toISOString()
    });

    // 检查封禁状态
    const storedUser = await getUser(discordUser.id);
    if (!storedUser) {
      throw new Error('Persisted Discord user could not be reloaded');
    }
    if (storedUser.banned) {
      return res.redirect('/login.html?error=banned');
    }

    // 记录登录日志
    await recordLogin(discordUser);

    // 7. 签发 JWT
    const token = jwt.sign(
      { id: discordUser.id, username: discordUser.username },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    // 8. 将 JWT 写入 HttpOnly Cookie
    res.cookie('naruto_token', token, {
      httpOnly: true,
      secure: config.nodeEnv === 'production' && req.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 天
    });
    ensureCsrfCookie(req, res);

    console.log(`[DISCORD CALLBACK] User ${discordUser.username} logged in successfully.`);
    return res.redirect(APP_LINK_CODE_PATTERN.test(appCode || '') ? `/auth/app/authorize?code=${appCode}` : '/');
  } catch (err) {
    if (clientDisconnected || res.destroyed || res.writableEnded) return;
    console.error('[DISCORD CALLBACK] Internal error during login callback:', {
      name: err?.name,
      code: err?.code,
      message: err?.message
    });
    return res.redirect('/login.html?error=server_error');
  } finally {
    req.off('aborted', abortForDisconnectedClient);
    res.off('close', abortForDisconnectedClient);
  }
}));

/**
 * GET /auth/me - 获取当前登录用户信息
 */
router.get('/me', requireAuth, (req, res) => {
  ensureCsrfCookie(req, res);
  const user = req.user;
  res.json({
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
    avatar: user.avatar,
    global_name: user.global_name
  });
});

/**
 * POST /auth/logout - 注销登录
 */
router.post('/logout', (req, res) => {
  res.clearCookie('naruto_token', { path: '/' });
  res.clearCookie('naruto_csrf', { path: '/' });
  res.json({ success: true, message: '已成功注销登录' });
});

export default router;
