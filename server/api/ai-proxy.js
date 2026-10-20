import { Router } from 'express';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/async-route.js';
import {
  createAdmissionController,
  createAdmissionMiddleware
} from '../middleware/admission.js';
import { config } from '../config.js';

const router = Router();

// index.js authenticates and performs admission before parsing JSON. Keep a
// defensive auth boundary for tests or future mounts that use this router directly.
router.use(asyncRoute((req, res, next) => (
  req.user?.id ? next() : requireAuth(req, res, next)
)));

export const aiProxyAdmissionController = createAdmissionController({
  text: { perUser: config.admission.textPerUser, global: config.admission.textGlobal },
  image: { perUser: config.admission.imagePerUser, global: config.admission.imageGlobal }
});

export function resolveAdmissionCategory(rawPurpose) {
  const purpose = String(rawPurpose || 'generic').trim().toLowerCase();
  return purpose === 'image-generation' || purpose === 'image-download' ? 'image' : 'text';
}

export const aiProxyAdmission = createAdmissionMiddleware({
  controller: aiProxyAdmissionController,
  selectCategory: (req) => resolveAdmissionCategory(req.headers['x-proxy-purpose']),
  identify: (req) => req.user?.id
});

/** 仅转发白名单内的请求头，避免把 Cookie / 内部头泄露给上游 */
const FORWARDABLE_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'user-agent'];
/** 仅回传白名单内的响应头 */
// Node's http/https client forwards compressed bytes unchanged. Keep their
// encoding so the browser can decode gzip/br before consuming JSON or ZIP.
const FORWARDABLE_RESPONSE_HEADERS = ['content-type', 'content-encoding', 'cache-control', 'retry-after'];

function mediaTypeEntries(value) {
  const source = Array.isArray(value) ? value.join(',') : String(value || '');
  return source.split(',').map(entry => {
    const [type, ...parameters] = entry.split(';');
    return {
      type: type.trim().toLowerCase(),
      parameters: parameters.map(parameter => parameter.trim().toLowerCase())
    };
  }).filter(entry => entry.type);
}

export function hasEventStreamMediaType(value) {
  return mediaTypeEntries(value).some(entry => entry.type === 'text/event-stream');
}

export function acceptsEventStream(value) {
  return mediaTypeEntries(value).some(entry => {
    if (entry.type !== 'text/event-stream') return false;
    const quality = entry.parameters.find(parameter => parameter.startsWith('q='));
    if (!quality) return true;
    const parsed = Number(quality.slice(2));
    return Number.isFinite(parsed) && parsed > 0;
  });
}

export function shouldStreamResponse({ statusCode, method, contentType, accept, body } = {}) {
  if (hasEventStreamMediaType(contentType)) return true;
  const status = Number(statusCode);
  const canStreamRequestedResponse = method !== 'HEAD'
    && status >= 200
    && status < 300
    && status !== 204
    && status !== 205;
  return canStreamRequestedResponse
    && (body?.stream === true || acceptsEventStream(accept));
}

const blockedIPv4 = new BlockList();
const blockedIPv6 = new BlockList();
const fakeIpIPv4 = new BlockList();
fakeIpIPv4.addSubnet('198.18.0.0', 15, 'ipv4');
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blockedIPv4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) blockedIPv6.addSubnet(address, prefix, 'ipv6');

function isPrivateAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blockedIPv4.check(mapped[1], 'ipv4');
  const family = isIP(normalized);
  if (!family) return false;
  return family === 4
    ? blockedIPv4.check(normalized, 'ipv4')
    : blockedIPv6.check(normalized, 'ipv6');
}

function isFakeIpAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const candidate = mapped?.[1] || normalized;
  return isIP(candidate) === 4 && fakeIpIPv4.check(candidate, 'ipv4');
}

/**
 * 判断是否允许对指定「域名:端口」使用明文 HTTP 上游。
 * 白名单条目：example.com（任意端口）、example.com:8050（精确端口）、
 * *.example.com（含 apex 的任意子域，可带端口）。未配置白名单时一律拒绝。
 */
function isHttpTargetAllowed(hostname, port, allowHttpTargets) {
  if (!allowHttpTargets || allowHttpTargets.length === 0) return false;
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  const numericPort = port ? Number(port) : null;
  for (const entry of allowHttpTargets) {
    const wildcard = entry.startsWith('*.');
    let entryName = wildcard ? entry.slice(2) : entry;
    let entryPort = null;
    const colonIndex = entryName.lastIndexOf(':');
    if (colonIndex !== -1 && /^\d+$/.test(entryName.slice(colonIndex + 1))) {
      entryPort = Number(entryName.slice(colonIndex + 1));
      entryName = entryName.slice(0, colonIndex);
    }
    entryName = entryName.replace(/^\[|\]$/g, '').toLowerCase();
    const hostMatches = wildcard
      ? host === entryName || host.endsWith(`.${entryName}`)
      : host === entryName;
    const portMatches = entryPort === null || numericPort === entryPort;
    if (hostMatches && portMatches) return true;
  }
  return false;
}

/**
 * 校验目标 URL：必须是合法的 HTTPS 公网地址。
 * @param {string} targetUrl
 * @returns {Promise<{url?: URL, addresses?: Array<{address: string, family: number}>, errorStatus?: number, errorBody?: {error: string}}>}
 */
function createAbortError(reason) {
  const error = new Error(reason?.message || 'The operation was aborted');
  error.name = 'AbortError';
  if (reason instanceof Error) error.cause = reason;
  return error;
}

async function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw createAbortError(signal.reason);
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(createAbortError(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/**
 * 解析 Retry-After 响应头为整秒数（RFC 7231 §7.1.3：整秒数或 HTTP-date）。
 * 缺失或不可解析返回 null，由调用方回退到指数退避。
 */
function parseRetryAfterSeconds(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Math.max(0, Number(trimmed)); // delta-seconds
  const dateMs = Date.parse(trimmed); // HTTP-date (IMF-fixdate)
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  return null;
}

async function validateTargetUrl(targetUrl, {
  signal,
  lookupImpl = lookup,
  allowFakeIpDns = config.proxy.allowFakeIpDns,
  allowHttpTargets = config.proxy.allowHttpTargets
} = {}) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { errorStatus: 400, errorBody: { error: '无效的目标 URL' } };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { errorStatus: 403, errorBody: { error: '仅允许 HTTPS 目标' } };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (/^\d+$/.test(hostname) || hostname.toLowerCase() === 'localhost' || isPrivateAddress(hostname)) {
    console.warn(`[AI PROXY] Blocked internal target: ${targetUrl}`);
    return { errorStatus: 403, errorBody: { error: '禁止代理到内网地址' } };
  }
  // 明文 HTTP 仅对显式白名单域名放行，其余一律保持 HTTPS-only
  if (parsed.protocol === 'http:' && !isHttpTargetAllowed(parsed.hostname, parsed.port, allowHttpTargets)) {
    console.warn(`[AI PROXY] Blocked plain-HTTP target outside allowlist: ${targetUrl}`);
    return { errorStatus: 403, errorBody: { error: '仅允许 HTTPS 目标' } };
  }
  try {
    if (signal?.aborted) throw createAbortError(signal.reason);
    const addresses = await awaitWithAbort(lookupImpl(hostname, { all: true, verbatim: true }), signal);
    const resolvesToBlockedAddress = addresses.some(({ address }) => (
      isPrivateAddress(address) && !(allowFakeIpDns && isFakeIpAddress(address))
    ));
    if (!addresses.length || resolvesToBlockedAddress) {
      console.warn(`[AI PROXY] Blocked DNS target: ${targetUrl}`);
      return { errorStatus: 403, errorBody: { error: '目标域名解析到受限地址' } };
    }
    return { url: parsed, addresses };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return { errorStatus: 400, errorBody: { error: '目标域名无法解析' } };
  }
}

/**
 * 正向代理 Agent 缓存（按 AI_PROXY_FORWARD_URL 惰性创建，可跨请求复用）。
 * 仅当 proxyConfig.aiForwardUrl 非空时返回；否则返回 null（保持直连）。
 * 与 Discord 专用的 PROXY_URL 无关，互不干扰。
 */
let proxyAgents = null;
export function getProxyAgent(protocol, proxyConfig = config.proxy) {
  const forwardUrl = proxyConfig.aiForwardUrl;
  if (!forwardUrl) return null;
  if (!proxyAgents || proxyAgents.url !== forwardUrl) {
    proxyAgents = {
      url: forwardUrl,
      https: new HttpsProxyAgent(forwardUrl),
      http: new HttpProxyAgent(forwardUrl)
    };
  }
  return protocol === 'http:' ? proxyAgents.http : proxyAgents.https;
}

export function requestUpstream(url, { method, headers, body, signal }, addresses) {
  const agent = getProxyAgent(url.protocol);
  const requestOptions = { method, headers, signal };
  if (agent) {
    // 走正向代理：连接与 DNS 由代理负责（目标域名已在 validateTargetUrl 校验过）。
    // 国内服务器访问被墙的 AI 上游（如 image.novelai.net）时依赖此路径。
    requestOptions.agent = agent;
  } else {
    // 直连：固定到已校验的公网地址，防止 DNS rebinding / 内网地址逃逸。
    const pinned = addresses.map(item => ({ address: item.address, family: item.family }));
    requestOptions.lookup = (_hostname, options, callback) => {
      const opts = typeof options === 'number' ? { family: options } : (options || {});
      const candidates = opts.family ? pinned.filter(item => item.family === opts.family) : pinned;
      if (!candidates.length) {
        const error = new Error('No validated address matches the requested family');
        error.code = 'EAI_ADDRFAMILY';
        callback(error);
        return;
      }
      if (opts.all) callback(null, candidates);
      else callback(null, candidates[0].address, candidates[0].family);
    };
  }

  return new Promise((resolve, reject) => {
    // 白名单命中的 http: 目标走明文请求，其余 https: 目标维持 TLS
    const request = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const upstreamRequest = request(url, requestOptions, resolve);
    upstreamRequest.on('error', reject);
    if (body) upstreamRequest.write(body);
    upstreamRequest.end();
  });
}

/**
 * 发起上游请求，对可重试状态（默认 429 限流）做有界重试：等待（优先尊重上游
 * Retry-After，截断到 maxPerRetryMs）后重新发起同一步请求。返回第一个不可重试
 * 的响应；重试耗尽或累计等待超预算时返回最后一个 429。
 *
 * @param {() => Promise<import('node:http').IncomingMessage>} doRequest
 * @param {object} options
 * @param {AbortSignal} [options.signal] — 中止等待与在途请求（客户端断开/上游超时）
 * @param {number} options.maxAttempts — 首次之外的重试次数
 * @param {number} options.maxPerRetryMs — 单次等待上限（毫秒）
 * @param {number} options.maxTotalRetryMs — 所有重试的累计等待预算（毫秒）
 */
export async function requestUpstreamWithRetry(doRequest, {
  signal,
  maxAttempts = 0,
  maxPerRetryMs = 30000,
  maxTotalRetryMs = 60000
} = {}) {
  let attempts = 0;
  let totalWaitMs = 0;
  // 仅 429：不重试 5xx，避免放大上游过载（429 已被拒绝，重发安全不双计费）
  const retryableStatuses = new Set([429]);

  while (true) {
    if (signal?.aborted) throw createAbortError(signal.reason);

    const response = await doRequest();
    const status = response.statusCode || 502;
    attempts++;

    // 非可重试状态，或已用完重试次数 — 原样返回
    if (!retryableStatuses.has(status) || attempts > maxAttempts) return response;

    const retryAfterSec = parseRetryAfterSeconds(response.headers['retry-after']);
    let waitMs;
    if (retryAfterSec != null) {
      waitMs = Math.min(retryAfterSec * 1000, maxPerRetryMs);
    } else {
      // 无 Retry-After 时指数退避：2^attempts 秒，截断到 maxPerRetryMs
      waitMs = Math.min(Math.pow(2, attempts) * 1000, maxPerRetryMs);
    }
    if (totalWaitMs + waitMs > maxTotalRetryMs) return response;

    // 丢弃中间 429 响应体，尽快释放 socket
    response.destroy();
    totalWaitMs += waitMs;

    console.warn(`[AI PROXY] Upstream 429 (attempt ${attempts}/${maxAttempts + 1}), waiting ${waitMs}ms (Retry-After: ${retryAfterSec ?? 'absent'})`);
    await awaitWithAbort(new Promise(resolve => setTimeout(resolve, waitMs)), signal);
  }
}

function createByteLimit(maxBytes) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        const error = new Error(`AI 上游响应超过 ${maxBytes} 字节限制`);
        error.code = 'ERR_AI_STREAM_TOO_LARGE';
        callback(error);
        return;
      }
      callback(null, chunk);
    }
  });
}

export async function forwardBoundedResponse(upstreamResponse, res, {
  signal,
  maxResponseBytes
} = {}) {
  const streams = [upstreamResponse];
  if (Number.isFinite(maxResponseBytes) && maxResponseBytes > 0) {
    streams.push(createByteLimit(maxResponseBytes));
  }
  streams.push(res);
  await pipeline(...streams, { signal });
}

export async function forwardStreamingResponse(upstreamResponse, res, {
  setEventStreamContentType = true,
  signal,
  maxResponseBytes
} = {}) {
  if (setEventStreamContentType) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  }
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  await forwardBoundedResponse(upstreamResponse, res, { signal, maxResponseBytes });
}

const PROXY_PURPOSES = new Set(['generic', 'models', 'agent', 'image-generation', 'image-download']);

export function resolveProxyPurposePolicy(rawPurpose, proxyConfig = config.proxy) {
  const purpose = String(rawPurpose || 'generic').trim().toLowerCase();
  if (!PROXY_PURPOSES.has(purpose)) return null;
  const imagePurpose = purpose === 'image-generation' || purpose === 'image-download';
  return {
    purpose,
    // 文本 AI（generic/models/agent）不再设置上游截止时间：慢生成由用户手动停止。
    // 仅文生图用途保留可配置超时。
    timeoutMs: imagePurpose ? proxyConfig.imageTimeoutMs : 0,
    maxResponseMb: imagePurpose ? proxyConfig.imageMaxResponseMb : proxyConfig.maxResponseMb
  };
}

/**
 * /api/ai-proxy — AI 接口代理（开放模式 + 内网防护）
 *
 * 客户端设置以下请求头：
 *   x-target-url       — 目标 API 完整地址（如 https://api.openai.com/v1/chat/completions）
 *   x-user-api-key     — 用户的 API Key（免密上游可为空）
 *   x-api-key-header   — 注入 Key 的请求头名称（默认 Authorization，Claude 用 x-api-key）
 *
 * 所有流量经 HTTPS 传输，API Key 仅在服务端内存短暂驻留，不落盘不记录。
 */
router.all('/', asyncRoute(async (req, res) => {
  const targetUrl = req.headers['x-target-url'];
  const apiKey = req.headers['x-user-api-key'];
  const apiKeyHeaderName = req.headers['x-api-key-header'] || 'Authorization';
  const proxyPolicy = resolveProxyPurposePolicy(req.headers['x-proxy-purpose']);

  if (!targetUrl) {
    return res.status(400).json({ error: '缺少目标代理地址 x-target-url' });
  }
  if (!proxyPolicy) {
    return res.status(400).json({ error: '不支持的代理用途 x-proxy-purpose' });
  }
  // 白名单：仅允许标准的 API key 请求头名称
  const ALLOWED_KEY_HEADERS = ['authorization', 'x-api-key', 'api-key'];
  if (!ALLOWED_KEY_HEADERS.includes(apiKeyHeaderName.toLowerCase())) {
    return res.status(451).json({ error: '不允许的 x-api-key-header 值' });
  }

  // 客户端中途断开时立即中止上游请求，避免继续为已放弃的生成计费/占用连接
  const upstreamAbort = new AbortController();
  let upstreamTimedOut = false;
  const upstreamTimeout = proxyPolicy.timeoutMs > 0
    ? setTimeout(() => {
        upstreamTimedOut = true;
        upstreamAbort.abort();
      }, proxyPolicy.timeoutMs)
    : null;
  const abortForDisconnectedClient = () => {
    if (!res.writableEnded && !upstreamAbort.signal.aborted) upstreamAbort.abort();
  };
  res.once('close', abortForDisconnectedClient);
  req.once('aborted', abortForDisconnectedClient);

  try {
    const { url, addresses, errorStatus, errorBody } = await validateTargetUrl(targetUrl, {
      signal: upstreamAbort.signal,
      allowFakeIpDns: config.proxy.allowFakeIpDns
    });
    if (errorStatus) {
      return res.status(errorStatus).json(errorBody);
    }
    if (req.aborted || res.destroyed || upstreamAbort.signal.aborted) {
      if (!upstreamAbort.signal.aborted) upstreamAbort.abort();
      throw createAbortError(upstreamAbort.signal.reason);
    }

    const forwardHeaders = {};
    for (const key of FORWARDABLE_REQUEST_HEADERS) {
      if (req.headers[key]) forwardHeaders[key] = req.headers[key];
    }

    // 注入用户的 API Key（Authorization 走 Bearer 方案，其余按原样注入）
    if (apiKey) {
      if (apiKeyHeaderName.toLowerCase() === 'authorization') {
        forwardHeaders['Authorization'] = `Bearer ${apiKey}`;
      } else {
        forwardHeaders[apiKeyHeaderName] = apiKey;
      }
    }

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length > 0) {
      body = JSON.stringify(req.body);
    }

    const upstreamResponse = await requestUpstreamWithRetry(
      () => requestUpstream(url, {
        method: req.method,
        headers: forwardHeaders,
        body,
        signal: upstreamAbort.signal
      }, addresses),
      {
        signal: upstreamAbort.signal,
        maxAttempts: config.proxy.upstreamRetry.maxAttempts,
        maxPerRetryMs: config.proxy.upstreamRetry.maxPerRetryMs,
        maxTotalRetryMs: config.proxy.upstreamRetry.maxTotalRetryMs
      }
    );
    // 拒绝重定向 — AI API 不需要
    const upstreamStatus = upstreamResponse.statusCode || 502;
    if (upstreamStatus >= 300 && upstreamStatus < 400) {
      console.warn(`[AI PROXY] Blocked redirect to: ${upstreamResponse.headers.location || 'unknown'}`);
      upstreamResponse.destroy();
      return res.status(502).json({ error: `AI 代理拒绝重定向: ${upstreamStatus}` });
    }
    res.status(upstreamStatus);

    for (const key of FORWARDABLE_RESPONSE_HEADERS) {
      const value = upstreamResponse.headers[key];
      if (value) res.setHeader(key, value);
    }

    const contentType = upstreamResponse.headers['content-type'] || '';
    const upstreamIsEventStream = hasEventStreamMediaType(contentType);
    const wantsStream = shouldStreamResponse({
      statusCode: upstreamStatus,
      method: req.method,
      contentType,
      accept: req.headers['accept'],
      body: req.body
    });

    if (wantsStream) {
      // 流式响应（SSE）：逐块透传，不在内存中聚合
      try {
        await forwardStreamingResponse(upstreamResponse, res, {
          // 错标为 JSON 的兼容网关仍应逐块转发，但保留其原始媒体类型，
          // 让客户端在没有 SSE 事件时安全回退到普通 JSON。
          setEventStreamContentType: upstreamIsEventStream || !contentType,
          signal: upstreamAbort.signal,
          maxResponseBytes: proxyPolicy.maxResponseMb * 1024 * 1024
        });
      } catch (err) {
        // 客户端主动断开触发的 abort 属正常路径，其余错误记录后照常结束响应
        const normalDisconnect = !upstreamTimedOut
          && upstreamAbort.signal.aborted
          && (err.name === 'AbortError'
            || err.code === 'ERR_STREAM_PREMATURE_CLOSE'
            || err.code === 'ERR_STREAM_DESTROYED');
        if (upstreamTimedOut) {
          console.warn('[AI PROXY] Stream timed out');
        } else if (!normalDisconnect) {
          console.error('[AI PROXY] Stream error:', err.message);
        }
        if (!res.destroyed && !res.writableEnded) res.end();
      }
    } else {
      const maxResponseBytes = proxyPolicy.maxResponseMb * 1024 * 1024;
      const declaredLength = Number(upstreamResponse.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        upstreamResponse.destroy();
        return res.status(502).json({ error: `AI 上游响应超过 ${proxyPolicy.maxResponseMb}MB 限制` });
      }
      await forwardBoundedResponse(upstreamResponse, res, {
        signal: upstreamAbort.signal,
        maxResponseBytes
      });
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (upstreamTimedOut && !res.destroyed && !res.headersSent) {
        return res.status(504).json({ error: 'AI 上游请求超时' });
      }
      if (upstreamTimedOut && !res.destroyed && !res.writableEnded) res.end();
      return; // 客户端已断开或流式响应已结束，无需再次响应
    }
    if (error.code === 'ERR_AI_STREAM_TOO_LARGE') {
      console.warn(`[AI PROXY] Upstream response exceeded ${proxyPolicy.maxResponseMb}MB limit`);
      if (!res.destroyed && !res.headersSent) {
        return res.status(502).json({ error: `AI 上游响应超过 ${proxyPolicy.maxResponseMb}MB 限制` });
      }
      if (!res.destroyed) res.destroy(error);
      return;
    }
    if (res.destroyed) return;
    console.error('[AI PROXY] Upstream failed:', error.message, error.cause || '');
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(502).json({ error: `AI 代理请求上游失败: ${error.message} ${error.cause ? error.cause.message : ''}`.trim() });
  } finally {
    if (upstreamTimeout !== null) clearTimeout(upstreamTimeout);
    res.off('close', abortForDisconnectedClient);
    req.off('aborted', abortForDisconnectedClient);
  }
}));

export { isPrivateAddress, validateTargetUrl };
export default router;
