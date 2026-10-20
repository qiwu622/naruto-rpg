// 记忆系统参数配置 — 单一来源
// 深度整理/分层窗口/检索参数均从此处读取,设置面板「记忆」板块写入

const STORAGE_KEY = 'naruto_memory_config';

export const MEMORY_CONFIG_DEFAULTS = {
  // AI 后台任务默认全部关闭；本地压缩、章节投影和检索不消耗 API。
  aiCompressionEnabled: false,
  // 深度整理
  deepEnabled: false,
  deepCycle: 36,              // 每 N 回合整理一次 (12-100)
  deepModel: 'main',          // 'main' | 'updater' — 整理用哪个模型配置
  // 分层窗口
  chapterWindow: 10,          // 每 N 回合固化一章
  maxTurnSummaries: 8,        // 活跃回合小结窗口，原始记录完整保存
  promptBudget: 7200,         // 注入总预算(字符)
  factsLimit: 90,             // 活跃事实窗口，溢出完整归档
  archivedLimit: 600,         // 归档数量提醒，不删除内容
  // 检索
  recallEnabled: true,        // <recall> 协议
  recallLifetime: 3,          // 召回单有效回合数
  vectorEnabled: false,
  vectorEndpoint: '',
  vectorModel: '',
  // 置顶角色自动总结
  npcSummaryEnabled: false,
  npcSummaryFrequency: 10,      // 每 N 次互动总结一次 (5-30)
};

const CLAMPS = {
  deepCycle: [12, 100],
  chapterWindow: [5, 30],
  maxTurnSummaries: [4, 20],
  promptBudget: [3000, 20000],
  factsLimit: [30, 300],
  archivedLimit: [100, 2000],
  recallLifetime: [1, 10],
  npcSummaryFrequency: [5, 30]
};

function clampConfig(cfg) {
  const out = { ...MEMORY_CONFIG_DEFAULTS, ...cfg };
  for (const [key, [min, max]] of Object.entries(CLAMPS)) {
    const n = Number(out[key]);
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : MEMORY_CONFIG_DEFAULTS[key];
  }
  out.aiCompressionEnabled = out.aiCompressionEnabled === true;
  out.deepEnabled = out.deepEnabled === true;
  out.recallEnabled = out.recallEnabled !== false;
  out.vectorEnabled = out.vectorEnabled === true;
  out.vectorEndpoint = String(out.vectorEndpoint || '').trim().slice(0, 1000);
  out.vectorModel = String(out.vectorModel || '').trim().slice(0, 200);
  out.npcSummaryEnabled = out.npcSummaryEnabled === true;
  out.deepModel = out.deepModel === 'updater' ? 'updater' : 'main';
  return out;
}

let _cache = null;

export function getMemoryConfig() {
  if (_cache) return _cache;
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { _cache = clampConfig(JSON.parse(raw)); return _cache; }
    }
  } catch { /* corrupted config falls back to defaults */ }
  _cache = { ...MEMORY_CONFIG_DEFAULTS };
  return _cache;
}

export function saveMemoryConfig(partial) {
  const merged = clampConfig({ ...getMemoryConfig(), ...partial });
  _cache = merged;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    }
  } catch { /* quota errors are non-fatal for config */ }
  return merged;
}

export function resetMemoryConfig() {
  _cache = { ...MEMORY_CONFIG_DEFAULTS };
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY); } catch {}
  return _cache;
}
