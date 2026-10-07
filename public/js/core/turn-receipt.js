import { VAR_SCHEMA } from '../data/var-schema.js';

export const TURN_RECEIPT_SCHEMA = 'turn-receipt.v1';
export const TURN_RECEIPT_LIMITS = Object.freeze({ variables: 12, memories: 8, stages: 18, text: 140 });
export const TURN_STAGE_LABELS = Object.freeze({
  context_search: '历史检索', story_plan: '故事规划', brainstorm: '剧情构思',
  outline: '场景安排', review_outline: '场景检查', character_agents: '人物行动',
  writing: '详纲整理', review_draft: '详纲检查', final_audit: '建议整理',
  final_write: '正文生成', narrative: '正文生成', review: '正文复检',
  continuity_updater: '变量结算', variables: '变量结算', archive: '记忆整理',
  memory: '记忆整理', daily: '忍界日报', save: '本地保存'
});

const STATUSES = new Set(['success', 'partial', 'skipped', 'failed', 'pending', 'unknown']);
const SAVE_REASONS = new Set(['quota', 'unavailable', 'write_failed', 'receipt_failed']);
const MEMORY_LABELS = Object.freeze({
  facts: '事实记忆', long_term: '长期记忆', pins: '重要约定', clues: '线索',
  important_events: '重要事件', recent_summary: '最近剧情', compressed_summary: '前情提要',
  turn_summaries: '回合记忆', chapters: '章节记忆', volumes: '篇章记忆'
});
const SUMMARY_MEMORY_FIELDS = new Set(['recent_summary', 'compressed_summary', 'chapters', 'volumes']);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const statusOf = value => STATUSES.has(value) ? value : 'unknown';
const numberOf = (value, maximum = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(maximum, Math.floor(value)) : null;

// Persist only a bounded player projection. Never copy model output, error
// objects, prompts, configuration, or private NPC memory into this artifact.
function text(value, maximum = TURN_RECEIPT_LIMITS.text) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '';
  return String(value)
    .replace(/<(think|thinking|reasoning|analysis|inner_thoughts|private|system|prompt)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1>|$)/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/\b(?:api[_-]?key|authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._-]+/gi, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function visibleValue(value) {
  if (value === undefined || value === null || value === '') return '无';
  if (!['string', 'number', 'boolean'].includes(typeof value)) return '内容已调整';
  return text(value) || '内容已隐藏';
}

function variableLabel(key) {
  if (own(VAR_SCHEMA, key) && !key.startsWith('系统·')) return key.slice(key.indexOf('·') + 1);
  let match = /^(?:物品|装备)·(?:道具|消耗品|武器|防具|装备|关键|忍具|素材|食物|卷轴|其他)·(.+)·(数量|品质)$/.exec(key);
  if (match) return `${text(match[1], 45)} · ${match[2]}`;
  match = /^技能·(?:忍术|体术|幻术|支援|天赋)·(.+)·(等级|熟练度|消耗|威力)$/.exec(key);
  if (match) return `${text(match[1], 45)} · ${match[2]}`;
  match = /^物品·已装备·(武器|防具|饰品[12])$/.exec(key);
  if (match) return `装备 · ${match[1]}`;
  match = /^进度·声望·(.+)$/.exec(key);
  return match ? `${text(match[1], 45)} · 声望` : '';
}

function variableChanges(before, after) {
  const changes = [];
  const add = (label, previous, current) => {
    if (previous === current || (!label)) return;
    changes.push({ label: text(label, 70), before: visibleValue(previous), after: visibleValue(current),
      delta: typeof previous === 'number' && typeof current === 'number' && Number.isFinite(current - previous) ? current - previous : null });
  };
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const label = variableLabel(key);
    if (label && ['string', 'number', 'boolean', 'undefined'].includes(typeof before[key])
      && ['string', 'number', 'boolean', 'undefined'].includes(typeof after[key])) add(label, before[key], after[key]);
  }
  // These three scores already appear in the player's relationship panel.
  // Do not project inner_thoughts, known_secrets, histories, or Agent memories.
  const relationsBefore = isObject(before._relationships) ? before._relationships : {};
  const relationsAfter = isObject(after._relationships) ? after._relationships : {};
  for (const name of [...new Set([...Object.keys(relationsBefore), ...Object.keys(relationsAfter)])].sort()) {
    for (const [field, label] of Object.entries({ affection: '好感', trust: '信任', respect: '尊重' })) {
      const previous = relationsBefore[name]?.[field];
      const current = relationsAfter[name]?.[field];
      if ((previous == null || Number.isFinite(previous)) && (current == null || Number.isFinite(current))) add(`${text(name, 40)} · ${label}`, previous, current);
    }
  }
  return { changes: changes.slice(0, TURN_RECEIPT_LIMITS.variables), total: changes.length };
}

function memoryLines(value) {
  return (typeof value === 'string' ? value.split('\n') : Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
    .map(line => line.trim()).filter(Boolean);
}

function memoryChanges(before, after) {
  const changes = [];
  for (const [field, label] of Object.entries(MEMORY_LABELS)) {
    const previous = before?._memory?.[field];
    const current = after?._memory?.[field];
    if (previous === current) continue;
    if (SUMMARY_MEMORY_FIELDS.has(field)) {
      if (typeof current === 'string' && current.trim()) changes.push({ label, kind: previous ? 'updated' : 'added', text: field === 'chapters' || field === 'volumes' ? '已整理本回合相关记忆' : text(current) });
      else if (typeof previous === 'string' && previous.trim() && !current) changes.push({ label, kind: 'removed', text: text(previous) });
      continue;
    }
    const oldLines = new Set(memoryLines(previous));
    const newLines = new Set(memoryLines(current));
    for (const line of newLines) if (!oldLines.has(line)) changes.push({ label, kind: 'added', text: text(line) });
    for (const line of oldLines) if (!newLines.has(line)) changes.push({ label, kind: 'removed', text: text(line) });
  }
  return { changes: changes.filter(change => change.text).slice(0, TURN_RECEIPT_LIMITS.memories), total: changes.filter(change => change.text).length };
}

function normalizeStage(stage) {
  if (!isObject(stage) || !own(TURN_STAGE_LABELS, stage.key)) return null;
  return { key: stage.key, status: statusOf(stage.status), durationMs: numberOf(stage.durationMs), retries: numberOf(stage.retries, 999) };
}

/** Sanitizes imported/persisted receipts; unknown schemas are not success. */
export function normalizeTurnReceipt(value) {
  try {
    if (!isObject(value) || value.schema !== TURN_RECEIPT_SCHEMA) return null;
    const variables = Array.isArray(value.variables?.changes) ? value.variables.changes : [];
    const memories = Array.isArray(value.memory?.changes) ? value.memory.changes : [];
    const stages = Array.isArray(value.stages) ? value.stages : [];
    const changes = variables.slice(0, TURN_RECEIPT_LIMITS.variables).filter(isObject).map(change => ({
      label: text(change.label, 70), before: visibleValue(change.before), after: visibleValue(change.after),
      delta: typeof change.delta === 'number' && Number.isFinite(change.delta) ? change.delta : null
    })).filter(change => change.label);
    const memory = memories.slice(0, TURN_RECEIPT_LIMITS.memories).filter(isObject).map(change => ({
      label: Object.values(MEMORY_LABELS).includes(change.label) ? change.label : '记忆',
      kind: ['added', 'updated', 'removed'].includes(change.kind) ? change.kind : 'updated', text: text(change.text)
    })).filter(change => change.text);
    return {
      schema: TURN_RECEIPT_SCHEMA, turnNumber: numberOf(value.turnNumber), durationMs: numberOf(value.durationMs),
      variables: { status: statusOf(value.variables?.status), comparisonKnown: value.variables?.comparisonKnown === true, changes, total: Math.max(changes.length, numberOf(value.variables?.total, 100000) || 0) },
      memory: { status: statusOf(value.memory?.status), comparisonKnown: value.memory?.comparisonKnown === true, changes: memory, total: Math.max(memory.length, numberOf(value.memory?.total, 100000) || 0) },
      daily: { status: statusOf(value.daily?.status), issue: text(value.daily?.issue, 40) },
      save: { status: statusOf(value.save?.status), reasonCode: SAVE_REASONS.has(value.save?.reasonCode) ? value.save.reasonCode : '' },
      stages: stages.slice(0, TURN_RECEIPT_LIMITS.stages).map(normalizeStage).filter(Boolean)
    };
  } catch { return null; }
}

/** Call with accepted state snapshots and explicit subsystem outcomes. */
export function buildTurnReceipt({ beforeState, afterState, turnNumber, variables = {}, memory = {}, daily = {}, save = {}, stages = [], durationMs } = {}) {
  try {
    const snapshotsKnown = isObject(beforeState) && isObject(afterState);
    return normalizeTurnReceipt({
      schema: TURN_RECEIPT_SCHEMA, turnNumber, durationMs,
      variables: { status: variables.status, comparisonKnown: snapshotsKnown, ...(snapshotsKnown ? variableChanges(beforeState, afterState) : { changes: [], total: 0 }) },
      memory: { status: memory.status, comparisonKnown: snapshotsKnown, ...(snapshotsKnown ? memoryChanges(beforeState, afterState) : { changes: [], total: 0 }) },
      daily, save, stages
    });
  } catch { return null; } // A receipt failure must never reject the narrative.
}

export function withTurnReceiptSaveResult(receipt, result = {}) {
  const normalized = normalizeTurnReceipt(receipt);
  return normalized ? normalizeTurnReceipt({ ...normalized, save: result }) : null;
}

/** Timings come only from measured boundaries; missing counts remain null. */
export function createTurnStageTracker({ now = () => performance.now() } = {}) {
  const records = new Map();
  const at = () => { const value = now(); return Number.isFinite(value) ? value : 0; };
  return {
    start(key) {
      if (!own(TURN_STAGE_LABELS, key)) return;
      const prior = records.get(key);
      if (prior?.startedAt != null) return;
      if (!prior && records.size >= TURN_RECEIPT_LIMITS.stages) return;
      records.set(key, { key, status: 'pending', durationMs: prior?.durationMs ?? 0, retries: prior?.retries ?? 0, startedAt: at() });
    },
    retry(key) {
      const entry = records.get(key);
      if (entry) entry.retries = Math.min(999, entry.retries + 1);
    },
    finish(key, status = 'unknown') {
      const entry = records.get(key);
      if (!entry) return;
      if (entry.startedAt != null) entry.durationMs += Math.max(0, at() - entry.startedAt);
      entry.startedAt = null;
      entry.status = statusOf(status);
    },
    snapshot() {
      const time = at();
      return [...records.values()].map(entry => normalizeStage({ ...entry, durationMs: entry.durationMs + (entry.startedAt == null ? 0 : Math.max(0, time - entry.startedAt)) }));
    }
  };
}
