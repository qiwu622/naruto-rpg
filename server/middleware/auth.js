import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getUser } from '../db/index.js';

/**
 * 提取请求中的 JWT 令牌
 */
function extractCredential(req) {
  // 1. 从 HttpOnly Cookie 中提取
  if (req.cookies && req.cookies.naruto_token) {
    return { token: req.cookies.naruto_token, source: 'cookie' };
  }
  // 2. 从 Authorization: Bearer 头中提取
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return { token: authHeader.substring(7), source: 'bearer' };
  }
  return null;
}

/**
 * 强制身份验证中间件 (针对 API)
 */
export async function requireAuth(req, res, next) {
  if (config.auth.bypass) {
    req.user = { id: 'dev_user', username: 'dev_tester', avatar: '' };
    req.authSource = 'bypass';
    req.authExpiresAt = Infinity;
    return next();
  }
  const credential = extractCredential(req);

  if (!credential?.token) {
    return res.status(401).json({ error: '未登录，请先进行身份验证' });
  }

  try {
    const decoded = jwt.verify(credential.token, config.jwt.secret);

    // 验证用户在数据库中是否确实存在
    const user = await getUser(decoded.id);
    if (!user) {
      return res.status(401).json({ error: '账户不存在或已被删除' });
    }

    // 封禁即时生效：不等 7 天 JWT 过期
    if (user.banned) {
      res.clearCookie('naruto_token', { path: '/' });
      return res.status(403).json({ error: `账户已被封禁${user.ban_reason ? `：${user.ban_reason}` : ''}` });
    }

    req.user = user;
    req.authSource = credential.source;
    req.authExpiresAt = Number.isFinite(decoded.exp) ? decoded.exp * 1000 : null;
    next();
  } catch (err) {
    console.error('[AUTH] Token verification failed:', err.message);
    res.clearCookie('naruto_token', { path: '/' });
    return res.status(401).json({ error: '登录会话已过期，请重新登录' });
  }
}

/**
 * 强制身份验证中间件 (针对 HTML 页面访问)
 */
export async function requireHtmlAuth(req, res, next) {
  if (config.auth.bypass) {
    req.user = { id: 'dev_user', username: 'dev_tester', avatar: '' };
    return next();
  }
  const credential = extractCredential(req);

  // 禁用 HTML 页面和重定向的缓存，防止 CDN 缓存导致无限重定向
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  if (!credential?.token) {
    return res.redirect('/login.html');
  }

  try {
    const decoded = jwt.verify(credential.token, config.jwt.secret);
    const user = await getUser(decoded.id);
    if (!user) {
      res.clearCookie('naruto_token');
      return res.redirect('/login.html');
    }

    // 封禁即时生效
    if (user.banned) {
      res.clearCookie('naruto_token');
      return res.redirect('/login.html?error=banned');
    }

    req.user = user;
    next();
  } catch (err) {
    res.clearCookie('naruto_token');
    return res.redirect('/login.html?error=session_expired');
  }
}

/**
 * 可选身份验证中间件 (不拦截请求，仅解析用户信息)
 */
export async function optionalAuth(req, res, next) {
  const credential = extractCredential(req);

  if (!credential?.token) {
    return next();
  }

  try {
    const decoded = jwt.verify(credential.token, config.jwt.secret);
    const user = await getUser(decoded.id);
    if (user && !user.banned) {
      req.user = user;
    }
  } catch (err) {
    // 忽略错误，继续传递请求
  }
  next();
}
