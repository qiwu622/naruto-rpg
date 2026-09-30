import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 确保读取项目根目录的 .env 文件
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_BYPASS_REQUESTED = process.env.AUTH_BYPASS === 'true';
const MULTIPLAYER_ENABLED = process.env.MULTIPLAYER_ENABLED !== 'false';

/** 开发兜底密钥：生产环境使用它意味着 JWT 可被任何人伪造，配置校验会点名告警 */
const DEV_FALLBACK_JWT_SECRET = 'naruto-rpg-dev-only-not-for-production';

/**
 * 环境变量安全取整：空值、非数字（NaN）一律回退到默认值。
 * @param {string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/** 首次请求以外的重试次数；0 明确关闭重试。 */
export function resolveAiProxyRetryMaxAttempts(env = process.env) {
  const raw = String(env.AI_PROXY_RETRY_MAX_ATTEMPTS ?? '').trim();
  if (!/^\d+$/.test(raw)) return 2;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : 2;
}

/**
 * Express trust proxy 配置。默认不信任请求头；只有部署在明确的可信反代后方时才应配置。
 * 支持 true、正整数跳数，以及 Express/proxy-addr 接受的地址或命名网段字符串。
 * @param {string | undefined} value
 * @returns {boolean | number | string}
 */
function parseTrustProxy(value) {
  const normalized = value?.trim();
  if (!normalized || normalized === '0' || normalized.toLowerCase() === 'false') return false;
  if (normalized.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(normalized)) return Number.parseInt(normalized, 10);
  return normalized;
}

function parseOriginList(value) {
  return [...new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    try {
      const url = new URL(item);
      return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ? url.origin : '';
    } catch { return ''; }
  }).filter(Boolean))];
}

function developmentSecret(label) {
  return createHash('sha256')
    .update(`${process.env.JWT_SECRET || DEV_FALLBACK_JWT_SECRET}\u0000${label}`, 'utf8')
    .digest('base64');
}

function multiplayerSecret(name, label) {
  const configured = String(process.env[name] || '').trim();
  if (configured) return configured;
  return NODE_ENV === 'production' ? '' : developmentSecret(label);
}

/**
 * Clash/Mihomo 的 fake-IP DNS 通常使用 198.18.0.0/15。开发环境默认兼容，
 * 生产环境保持关闭；两种环境都允许通过显式 true/false 覆盖。
 */
export function resolveAiProxyAllowFakeIpDns(env = process.env) {
  const explicit = String(env.AI_PROXY_ALLOW_FAKE_IP_DNS ?? '').trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return String(env.NODE_ENV || 'development').trim().toLowerCase() !== 'production';
}

/**
 * AI 代理明文 HTTP 上游白名单：逗号分隔的「域名[:端口]」列表，如
 *   new.fangxiaobai.store:8050,*.example.com
 * 仅白名单命中的域名允许 http:// 目标，其余上游仍强制 HTTPS。
 * 条目支持：example.com（任意端口）、example.com:8050（精确端口）、
 * *.example.com（含 apex 的任意子域，可带端口）。返回 null 表示未配置，
 * 保持旧行为：一律拒绝明文 HTTP 目标。
 */
export function resolveAiProxyAllowHttpTargets(env = process.env) {
  const entries = [...new Set(
    String(env.AI_PROXY_ALLOW_HTTP_TARGETS ?? '')
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean)
  )];
  return entries.length ? entries : null;
}

/** 应用全局配置（deepFreeze 防止运行期被意外篡改） */
export const config = deepFreeze({
  port: toPositiveInt(process.env.PORT, 3000),
  nodeEnv: NODE_ENV,
  auth: {
    bypass: AUTH_BYPASS_REQUESTED && NODE_ENV !== 'production'
  },
  http: {
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY)
  },
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: process.env.DISCORD_REDIRECT_URI,
    requiredGuildId: process.env.DISCORD_REQUIRED_GUILD_ID
  },
  jwt: {
    secret: process.env.JWT_SECRET || DEV_FALLBACK_JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },
  saves: {
    maxSlots: toPositiveInt(process.env.MAX_SAVE_SLOTS, 1),
    maxSizeMb: toPositiveInt(process.env.MAX_SAVE_SIZE_MB, 200),
    maxPreviewSizeKb: toPositiveInt(process.env.MAX_SAVE_PREVIEW_SIZE_KB, 64),
    maxCompressedSizeMb: toPositiveInt(process.env.MAX_SAVE_COMPRESSED_SIZE_MB, 64),
    legacyMaxSizeMb: toPositiveInt(process.env.MAX_LEGACY_SAVE_SIZE_MB, 16),
    maxJsonDepth: toPositiveInt(process.env.MAX_SAVE_JSON_DEPTH, 256),
    uploadGlobalConcurrency: toPositiveInt(process.env.SAVE_UPLOAD_GLOBAL_CONCURRENCY, 2)
  },
  imageAssets: {
    maxBytes: toPositiveInt(process.env.IMAGE_ASSET_QUOTA_MB, 1024) * 1024 * 1024,
    maxAssets: toPositiveInt(process.env.IMAGE_ASSET_MAX_COUNT, 500),
    maxOriginalBytes: toPositiveInt(process.env.IMAGE_ASSET_MAX_ORIGINAL_MB, 20) * 1024 * 1024,
    maxThumbnailBytes: toPositiveInt(process.env.IMAGE_ASSET_MAX_THUMBNAIL_KB, 512) * 1024,
    maxMetadataBytes: toPositiveInt(process.env.IMAGE_ASSET_MAX_METADATA_KB, 32) * 1024,
    maxPixels: toPositiveInt(process.env.IMAGE_ASSET_MAX_PIXELS, 16000000),
    maxSide: toPositiveInt(process.env.IMAGE_ASSET_MAX_SIDE, 8192),
    maxSelections: toPositiveInt(process.env.IMAGE_ASSET_MAX_SELECTIONS, 5000),
    uploadGlobalConcurrency: toPositiveInt(process.env.IMAGE_ASSET_UPLOAD_GLOBAL_CONCURRENCY, 4),
    activeReferenceTtlMs: toPositiveInt(process.env.IMAGE_ASSET_ACTIVE_REFERENCE_TTL_MINUTES, 60) * 60 * 1000,
    connectSources: parseOriginList(process.env.IMAGE_LOCAL_CONNECT_SOURCES)
  },
  storage: {
    dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'))
  },
  multiplayer: {
    enabled: MULTIPLAYER_ENABLED,
    databasePath: path.resolve(
      process.env.MULTIPLAYER_DATABASE_PATH
        || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'multiplayer', 'multiplayer.sqlite')
    ),
    backupDir: path.resolve(
      process.env.MULTIPLAYER_BACKUP_DIR
        || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'multiplayer', 'backups')
    ),
    backupIntervalMs: toPositiveInt(
      process.env.MULTIPLAYER_BACKUP_INTERVAL_MINUTES,
      360
    ) * 60 * 1000,
    keyVersion: String(process.env.MULTIPLAYER_KEY_VERSION || 'v1'),
    contentMasterKey: multiplayerSecret(
      'MULTIPLAYER_CONTENT_MASTER_KEY',
      'multiplayer-content-master-key-v1'
    ),
    credentialMasterKey: multiplayerSecret(
      'MULTIPLAYER_CREDENTIAL_MASTER_KEY',
      'multiplayer-credential-master-key-v1'
    ),
    credentialFingerprintKey: multiplayerSecret(
      'MULTIPLAYER_CREDENTIAL_FINGERPRINT_KEY',
      'multiplayer-credential-fingerprint-key-v1'
    ),
    actionCommitmentSecret: multiplayerSecret(
      'MULTIPLAYER_ACTION_COMMITMENT_SECRET',
      'multiplayer-action-commitment-secret-v1'
    ),
    lineageSigningSecret: multiplayerSecret(
      'MULTIPLAYER_LINEAGE_SIGNING_SECRET',
      'multiplayer-lineage-signing-secret-v1'
    ),
    proposalCommitmentSecret: multiplayerSecret(
      'MULTIPLAYER_PROPOSAL_COMMITMENT_SECRET',
      'multiplayer-proposal-commitment-secret-v1'
    )
  },
  proxy: {
    enabled: process.env.PROXY_ENABLED === 'true',
    url: process.env.PROXY_URL || '',
    // AI 代理专属正向代理（Clash/Mihomo 等 HTTP CONNECT 代理，如 http://127.0.0.1:7890）。
    // 与 PROXY_URL（Discord 专用）互不干扰；留空 = AI 代理直连。
    aiForwardUrl: String(process.env.AI_PROXY_FORWARD_URL || '').trim(),
    allowFakeIpDns: resolveAiProxyAllowFakeIpDns(process.env),
    // 明文 HTTP 上游白名单（默认 null = 禁止）；见 resolveAiProxyAllowHttpTargets
    allowHttpTargets: resolveAiProxyAllowHttpTargets(process.env),
    // 文本 AI 不再施加上游超时（由用户手动停止）；AI_PROXY_TIMEOUT_MS 已停用。
    maxResponseMb: toPositiveInt(process.env.AI_PROXY_MAX_RESPONSE_MB, 20),
    imageTimeoutMs: toPositiveInt(process.env.IMAGE_PROXY_TIMEOUT_MS, 300000),
    imageMaxResponseMb: toPositiveInt(process.env.IMAGE_PROXY_MAX_RESPONSE_MB, 32),
    // 上游 429 限流自动重试：提供方（OpenAI/DeepSeek/中转站）每分钟请求/令牌
    // 窗口耗尽时返回 429，灵希/Agent 多步工具调用会稳定踩中。服务端在转发前
    // 等待（优先尊重上游 Retry-After，截断到 maxPerRetryMs）后重新发起同一请求。
    upstreamRetry: {
      // 首次请求之外的重试次数（总请求数 = 1 + 该值）
      maxAttempts: resolveAiProxyRetryMaxAttempts(process.env),
      // 单次等待上限（毫秒）：尊重上游 Retry-After，但截断过长等待
      maxPerRetryMs: toPositiveInt(process.env.AI_PROXY_RETRY_MAX_PER_RETRY_MS, 30000),
      // 所有重试的累计等待预算（毫秒）
      maxTotalRetryMs: toPositiveInt(process.env.AI_PROXY_RETRY_TOTAL_BUDGET_MS, 60000)
    }
  },
  // AI 代理并发闸门：文本（主叙事 + Agent 协作）默认每用户同时 10 个、全局 32 个；
  // 图像生成独立计数。Agent 完整模式单回合峰值依赖该额度，调低会立刻引发 429。
  admission: {
    textPerUser: toPositiveInt(process.env.AI_PROXY_ADMISSION_TEXT_PER_USER, 10),
    textGlobal: toPositiveInt(process.env.AI_PROXY_ADMISSION_TEXT_GLOBAL, 32),
    imagePerUser: toPositiveInt(process.env.AI_PROXY_ADMISSION_IMAGE_PER_USER, 1),
    imageGlobal: toPositiveInt(process.env.AI_PROXY_ADMISSION_IMAGE_GLOBAL, 4)
  }
});

/**
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

// 生产环境配置完整性检查（保持旧行为：告警但不中断启动，避免影响既有部署流程）
if (config.nodeEnv === 'production') {
  const missing = [];
  if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (!config.discord.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
  if (!config.discord.redirectUri) missing.push('DISCORD_REDIRECT_URI');
  if (!config.discord.requiredGuildId) missing.push('DISCORD_REQUIRED_GUILD_ID');
  if (config.jwt.secret === DEV_FALLBACK_JWT_SECRET) missing.push('JWT_SECRET (using default)');
  if (AUTH_BYPASS_REQUESTED) missing.push('AUTH_BYPASS (must be false in production)');
  if (config.multiplayer.enabled) {
    for (const [field, name] of [
      ['contentMasterKey', 'MULTIPLAYER_CONTENT_MASTER_KEY'],
      ['credentialMasterKey', 'MULTIPLAYER_CREDENTIAL_MASTER_KEY'],
      ['credentialFingerprintKey', 'MULTIPLAYER_CREDENTIAL_FINGERPRINT_KEY'],
      ['actionCommitmentSecret', 'MULTIPLAYER_ACTION_COMMITMENT_SECRET'],
      ['lineageSigningSecret', 'MULTIPLAYER_LINEAGE_SIGNING_SECRET'],
      ['proposalCommitmentSecret', 'MULTIPLAYER_PROPOSAL_COMMITMENT_SECRET']
    ]) {
      if (!config.multiplayer[field]) missing.push(name);
    }
  }

  if (missing.length > 0) {
    console.warn(`[WARNING] Production mode configuration check failed! Missing keys: ${missing.join(', ')}`);
  }
  if (config.jwt.secret === DEV_FALLBACK_JWT_SECRET
    || AUTH_BYPASS_REQUESTED
    || (config.multiplayer.enabled && [
      config.multiplayer.contentMasterKey,
      config.multiplayer.credentialMasterKey,
      config.multiplayer.credentialFingerprintKey,
      config.multiplayer.actionCommitmentSecret,
      config.multiplayer.lineageSigningSecret,
      config.multiplayer.proposalCommitmentSecret
    ].some(value => !value))) {
    console.error('[FATAL] Production security configuration is unsafe. Exiting.');
    process.exit(1);
  }
}
