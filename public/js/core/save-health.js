import { getNativeFilePlugin } from './file-export.js';

export const BOOT_WATCHDOG_KEY = 'naruto_boot_watchdog_v1';

const DEFAULT_WATCHDOG = Object.freeze({
  attempts: 0,
  lastStartAt: 0,
  lastHealthyAt: 0
});

export function getBootWatchdogState() {
  try {
    const raw = globalThis.localStorage?.getItem(BOOT_WATCHDOG_KEY);
    if (!raw) return { ...DEFAULT_WATCHDOG };
    const parsed = JSON.parse(raw);
    return {
      attempts: Math.max(0, Math.trunc(Number(parsed?.attempts) || 0)),
      lastStartAt: Number(parsed?.lastStartAt) || 0,
      lastHealthyAt: Number(parsed?.lastHealthyAt) || 0
    };
  } catch {
    return { ...DEFAULT_WATCHDOG };
  }
}

export function resetBootWatchdog() {
  try {
    const current = getBootWatchdogState();
    globalThis.localStorage?.setItem(BOOT_WATCHDOG_KEY, JSON.stringify({
      attempts: 0,
      lastStartAt: current.lastStartAt,
      lastHealthyAt: current.lastHealthyAt || Date.now()
    }));
  } catch { /* storage unavailable */ }
}

export function markBootHealthy() {
  try {
    const current = getBootWatchdogState();
    globalThis.localStorage?.setItem(BOOT_WATCHDOG_KEY, JSON.stringify({
      attempts: 0,
      lastStartAt: current.lastStartAt,
      lastHealthyAt: Date.now()
    }));
  } catch { /* storage unavailable */ }
  try {
    const plugin = getNativeFilePlugin();
    if (plugin && typeof plugin.markBootHealthy === 'function') {
      void plugin.markBootHealthy().catch(() => {});
    }
  } catch { /* native bridge unavailable */ }
}

export async function requestPersistentStorage() {
  try {
    if (!globalThis.navigator?.storage?.persist) {
      return { supported: false, persisted: false };
    }
    const already = await globalThis.navigator.storage.persisted?.().catch(() => false);
    if (already) return { supported: true, persisted: true };
    const granted = await globalThis.navigator.storage.persist();
    return { supported: true, persisted: Boolean(granted) };
  } catch {
    return { supported: false, persisted: false };
  }
}

export function pruneAutoBackups(entries = [], { keep = 5 } = {}) {
  const limit = Math.max(1, Math.trunc(Number(keep) || 5));
  const autoEntries = entries
    .filter(item => item && typeof item.reason === 'string' && item.reason.startsWith('before-') && item.complete !== false)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  return autoEntries.slice(limit).map(item => item.id).filter(Boolean);
}

export function shouldThrottleCloudAutoSync({
  totalNodes = 0,
  estimatedBytes = 0,
  lastSyncAt = 0,
  now = Date.now(),
  minIntervalMs = null
} = {}) {
  const nodes = Number(totalNodes) || 0;
  const bytes = Number(estimatedBytes) || 0;
  let interval = Number.isFinite(minIntervalMs) ? minIntervalMs : 0;
  if (interval === 0) {
    if (nodes >= 200 || bytes >= 64 * 1024 * 1024) interval = 120 * 1000;
    else if (nodes >= 60 || bytes >= 16 * 1024 * 1024) interval = 45 * 1000;
  }
  if (!interval || !lastSyncAt) return { throttle: false, minIntervalMs: interval, remainingMs: 0 };
  const elapsed = Math.max(0, now - lastSyncAt);
  return elapsed < interval
    ? { throttle: true, minIntervalMs: interval, remainingMs: interval - elapsed }
    : { throttle: false, minIntervalMs: interval, remainingMs: 0 };
}

export async function inspectSaveHealth({
  summaries = null,
  storageStats = null,
  quota = null,
  persisted = null
} = {}) {
  let resolvedSummaries = summaries;
  if (!Array.isArray(resolvedSummaries)) {
    try {
      const { timelineSystem } = await import('../systems/timeline-system.js');
      resolvedSummaries = await timelineSystem.getNodeSummaries();
    } catch {
      resolvedSummaries = [];
    }
  }
  let resolvedQuota = quota;
  if (resolvedQuota === null && globalThis.navigator?.storage?.estimate) {
    resolvedQuota = await globalThis.navigator.storage.estimate().catch(() => null);
  }
  let resolvedPersisted = persisted;
  if (resolvedPersisted === null) {
    resolvedPersisted = await globalThis.navigator?.storage?.persisted?.().catch(() => false);
  }

  const totalNodes = resolvedSummaries.length;
  let compressedNodes = 0;
  let estimatedBytes = 0;
  for (const node of resolvedSummaries) {
    if (node?.payload_encoding) compressedNodes++;
    estimatedBytes += Number(node?.estimated_bytes) || 0;
  }
  const uncompressedNodes = Math.max(0, totalNodes - compressedNodes);
  const compressedRatio = totalNodes ? compressedNodes / totalNodes : 1;
  const quotaUsage = Number(resolvedQuota?.usage) || 0;
  const quotaTotal = Number(resolvedQuota?.quota) || 0;
  const quotaRatio = quotaTotal > 0 ? quotaUsage / quotaTotal : 0;

  const reasons = [];
  let level = 'ok';
  if (quotaRatio >= 0.85) {
    level = 'danger';
    reasons.push(`站点存储空间已用 ${Math.round(quotaRatio * 100)}%`);
  } else if (quotaRatio >= 0.65) {
    level = 'warn';
    reasons.push(`站点存储空间已用 ${Math.round(quotaRatio * 100)}%`);
  }

  if (estimatedBytes >= 256 * 1024 * 1024 || (totalNodes >= 180 && uncompressedNodes > 45)) {
    level = 'danger';
    reasons.push(`当前时间线体积较大（${totalNodes} 回合，约 ${Math.ceil(estimatedBytes / 1024 / 1024)} MB）`);
  } else if (totalNodes >= 100 || estimatedBytes >= 96 * 1024 * 1024) {
    if (level !== 'danger') level = 'warn';
    reasons.push(`时间线已累计 ${totalNodes} 个回合`);
  }

  if (!resolvedPersisted && totalNodes >= 30 && level === 'ok') {
    level = 'warn';
    reasons.push('浏览器尚未授予持久存储权限，长期档建议导出外部备份');
  }

  return {
    level,
    totalNodes,
    compressedNodes,
    uncompressedNodes,
    compressedRatio,
    estimatedBytes,
    quotaUsage,
    quotaTotal,
    quotaRatio,
    persisted: Boolean(resolvedPersisted),
    storageStats,
    reasons,
    recommendation: level === 'danger'
      ? '建议立即导出 v2 紧凑备份，或使用“轻量续玩副本”缩小体积。'
      : level === 'warn'
        ? '建议启用外部自动备份或定期使用“无损整理”节省空间。'
        : '存档状态健康。'
  };
}
