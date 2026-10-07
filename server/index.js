import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getUser, initDb } from './db/index.js';
import authRouter, { ensureCsrfCookie } from './auth/discord.js';
import appLinkRouter from './auth/app-link.js';
import savesRouter from './api/saves.js';
import aiProxyRouter, { aiProxyAdmission, getProxyAgent } from './api/ai-proxy.js';
import musicFavoritesRouter from './api/music-favorites.js';
import adminRouter from './api/admin.js';
import imageAssetsRouter from './api/image-assets.js';
import { requireAuth, requireHtmlAuth } from './middleware/auth.js';
import { asyncRoute } from './middleware/async-route.js';
import { createResponseCompression } from './middleware/response-compression.js';
import { createMultiplayerRuntime } from './multiplayer/application/runtime.js';
import {
  MULTIPLAYER_HTTP_MOUNT_PATH,
  createRepositoryBackedMultiplayerHttpRouter
} from './multiplayer/http/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTP_HEADERS_TIMEOUT_MS = 70_000;
const HTTP_REQUEST_TIMEOUT_MS = 360_000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

function errorFields(error) {
  if (error instanceof Error) {
    const fields = {
      name: error.name,
      code: typeof error.code === 'string' ? error.code : undefined,
      message: String(error.message || error.name).slice(0, 2000)
    };
    if (error.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
      const details = {};
      for (const field of [
        'provider_request_id',
        'upstream_error_code',
        'upstream_error_type',
        'upstream_error_summary'
      ]) {
        if (typeof error.details[field] === 'string' && error.details[field]) {
          details[field] = error.details[field].slice(
            0,
            field === 'upstream_error_summary' ? 500 : 200
          );
        }
      }
      if (Number.isSafeInteger(error.details.upstream_status)) {
        details.upstream_status = error.details.upstream_status;
      }
      if (Object.keys(details).length > 0) fields.details = details;
    }
    return fields;
  }
  return { message: String(error).slice(0, 2000) };
}

function logRuntimeEvent(level, event, details = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

async function authorizeLiveMultiplayerSession(req) {
  const userId = typeof req.user?.id === 'string' ? req.user.id : '';
  if (!userId) return false;
  if (Number.isFinite(req.authExpiresAt) && Date.now() >= req.authExpiresAt) return false;
  if (config.auth.bypass && req.authSource === 'bypass') return userId === 'dev_user';
  const currentUser = await getUser(userId);
  return Boolean(currentUser && !currentUser.banned);
}

let multiplayerRuntime = null;

// 1. 初始化数据库（ESM 顶层 await：持久层就绪前不接收任何请求）
try {
  await initDb();
  if (config.multiplayer.enabled) {
    multiplayerRuntime = await createMultiplayerRuntime(config.multiplayer, {
      sessionAuthorizer: authorizeLiveMultiplayerSession,
      modelHttpGatewayOptions: {
        forward_proxy_agent: getProxyAgent('https:', config.proxy),
        allow_fake_ip_dns: config.proxy.allowFakeIpDns
      },
      onBackgroundError(error, context = {}) {
        logRuntimeEvent('error', 'multiplayer_background_error', {
          context,
          error: errorFields(error)
        });
      }
    });
  }
} catch (error) {
  logRuntimeEvent('error', 'fatal', { source: 'runtime_init', error: errorFields(error) });
  process.exit(1);
}

const app = express();
app.set('trust proxy', config.http.trustProxy);
let serviceReady = false;
let shuttingDown = false;

// 2. 安全与性能中间件配置
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://cdn.discordapp.com",
        "https://i.postimg.cc",
        "https://api.vkeys.cn"
      ],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: [
        "'self'", "https:", "wss:",
        "http://127.0.0.1:*", "http://localhost:*",
        "ws://127.0.0.1:*", "ws://localhost:*",
        ...config.imageAssets.connectSources
      ],
      mediaSrc: ["'self'", "https:", "http:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // Superconductor preview is embedded in an authenticated iframe during development.
      frameAncestors: ["'self'", "https://discord.com", "https://superconductor.com", "https://*.superconductor.com"]
    }
  },
  crossOriginEmbedderPolicy: false, // 允许加载跨域图片/音乐资源
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // CSP frame-ancestors controls embedding; X-Frame-Options cannot allow Superconductor.
  xFrameOptions: false
}));

app.use(createResponseCompression());
app.use(cookieParser());

app.get('/health/live', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ status: 'ok' });
});

app.get('/health/ready', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ready = serviceReady && !shuttingDown;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
});

// 3. 速率限制中间件 (防暴破/恶意请求)
const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 分钟
  max: 15,
  message: { error: '请求过于频繁，请稍后再试' }
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 分钟
  max: 120,
  message: { error: '请求已触发限流，请稍后' }
});

const staticLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 600,
  message: { error: '静态资源请求过于频繁' }
});

// 4. 路由挂载
const defaultJsonParser = express.json({ limit: '2mb' });

// App polling has its own budget; it must not consume Discord's login budget.
app.use('/auth/app', rateLimit({ windowMs: 60_000, max: 60, message: { error: '连接请求过多，请稍后重试' } }),
  express.json({ limit: '4kb' }), express.urlencoded({ extended: false, limit: '4kb' }), appLinkRouter);
app.use('/auth', authLimiter, defaultJsonParser, authRouter);
if (multiplayerRuntime) {
  const multiplayerRouter = createRepositoryBackedMultiplayerHttpRouter({
    core_repositories: multiplayerRuntime.repositories.core,
    billing_repository: multiplayerRuntime.repositories.billing,
    lineage_repository: multiplayerRuntime.repositories.lineage,
    application_services: multiplayerRuntime.services,
    event_hub: multiplayerRuntime.eventHub,
    room_event_stream_handler: multiplayerRuntime.sseHandler,
    chat_rate_limiter: multiplayerRuntime.chatRateLimiter,
    error_logger(error, context = {}) {
      logRuntimeEvent('error', 'multiplayer_request_error', {
        context,
        error: errorFields(error)
      });
    }
  });
  app.use(
    MULTIPLAYER_HTTP_MOUNT_PATH,
    apiLimiter,
    (req, res, next) => {
      if (!shuttingDown && multiplayerRuntime.isAcceptingWork()) return next();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({
        error: {
          code: 'MULTIPLAYER_RUNTIME_QUIESCING',
          message: '联机服务正在安全停止，请在服务恢复后重试',
          details: {}
        }
      });
    },
    asyncRoute(requireAuth),
    multiplayerRouter
  );
}
app.use('/api/saves', apiLimiter, savesRouter);
// Authenticate and reject excess concurrency before spending memory on JSON parsing.
app.use(
  '/api/ai-proxy',
  apiLimiter,
  asyncRoute(requireAuth),
  aiProxyAdmission,
  defaultJsonParser,
  aiProxyRouter
);
app.use('/api/music', apiLimiter, defaultJsonParser, musicFavoritesRouter);
app.use('/api/admin', authLimiter, defaultJsonParser, adminRouter);
// This router owns its bounded JSON/multipart parsers so authentication runs first.
app.use('/api/image-assets', apiLimiter, imageAssetsRouter);

// 5. 网页认证入口拦截
// 玩家在请求根路径 / 或 index.html 时，必须通过身份验证，否则重定向到登录页面
app.get('/', asyncRoute(requireHtmlAuth), (req, res) => {
  ensureCsrfCookie(req, res);
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/index.html', asyncRoute(requireHtmlAuth), (req, res) => {
  ensureCsrfCookie(req, res);
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 6. 静态文件托管
// index: false 禁止自动返回 index.html，全部由上面的路由守卫拦截处理
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// 7. 未匹配的 404 处理
app.use((req, res) => {
  res.status(404).json({ error: '资源未找到' });
});

// 8. 全局错误捕获中间件 — 不泄露内部细节给客户端
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体超过允许的大小' });
  }
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && err?.status === 400)) {
    return res.status(400).json({ error: '请求体不是有效的 JSON' });
  }
  logRuntimeEvent('error', 'request_error', {
    method: req.method,
    error: errorFields(err)
  });
  return res.status(500).json({ error: '服务器内部错误，请稍后重试' });
});

// 9. 启动服务
const server = app.listen(config.port, () => {
  serviceReady = true;
  logRuntimeEvent('info', 'server_listening', {
    environment: config.nodeEnv,
    port: config.port
  });
});

server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;

const sockets = new Set();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

let shutdownFinished = false;
let requestedExitCode = 0;
let shutdownPromise = null;

function completeShutdown(reason, error) {
  if (shutdownFinished) return;
  shutdownFinished = true;
  logRuntimeEvent(error ? 'error' : 'info', 'server_stopped', {
    reason,
    error: error ? errorFields(error) : undefined
  });
  process.exit(error ? 1 : requestedExitCode);
}

function drainHttpServer(reason) {
  return new Promise(resolve => {
    let finished = false;
    let forceTimer = null;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      resolve(error?.code === 'ERR_SERVER_NOT_RUNNING' ? null : error ?? null);
    };
    forceTimer = setTimeout(() => {
      logRuntimeEvent('warn', 'shutdown_forced', {
        reason,
        activeConnections: sockets.size
      });
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      finish(requestedExitCode === 0
        ? null
        : new Error('Forced shutdown after drain timeout'));
    }, SHUTDOWN_DRAIN_TIMEOUT_MS);
    forceTimer.unref?.();

    server.close(finish);
    server.closeIdleConnections?.();
  });
}

function beginShutdown(reason, exitCode = 0) {
  requestedExitCode = Math.max(requestedExitCode, exitCode);
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  serviceReady = false;
  logRuntimeEvent('info', 'shutdown_started', {
    reason,
    drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
    activeConnections: sockets.size
  });

  shutdownPromise = (async () => {
    let shutdownError = null;
    try {
      await multiplayerRuntime?.quiesce();
    } catch (error) {
      shutdownError = error;
      requestedExitCode = Math.max(requestedExitCode, 1);
      logRuntimeEvent('error', 'multiplayer_quiesce_failed', { error: errorFields(error) });
    }
    const drainError = await drainHttpServer(reason);
    if (drainError) {
      shutdownError ??= drainError;
      requestedExitCode = Math.max(requestedExitCode, 1);
    }
    try {
      await multiplayerRuntime?.close();
    } catch (error) {
      shutdownError ??= error;
      requestedExitCode = Math.max(requestedExitCode, 1);
      logRuntimeEvent('error', 'multiplayer_close_failed', { error: errorFields(error) });
    }
    completeShutdown(reason, shutdownError);
  })();
  return shutdownPromise;
}

server.on('error', (error) => {
  logRuntimeEvent('error', 'server_error', { error: errorFields(error) });
  beginShutdown('server_error', 1);
});

function handleFatal(source, error) {
  logRuntimeEvent('error', 'fatal', { source, error: errorFields(error) });
  beginShutdown(source, 1);
}

process.once('SIGTERM', () => beginShutdown('SIGTERM'));
process.once('SIGINT', () => beginShutdown('SIGINT'));
process.once('uncaughtException', (error) => handleFatal('uncaughtException', error));
process.once('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));
