import {
  WORLD_BOOK_V2_ENTRIES,
  compareWorldbookDates,
  migrateCustomWorldbookEntriesV1ToV2,
  toRuntimeWorldbookEntry
} from './v2.js';
import { normalizeNpcIdentity } from '../npc-identity.js';
import { matchesWorldbookActivation, normalizeCustomWorldbookEntry } from './activation.js';
import { KNOWLEDGE_BASE } from '../knowledge-base.js';

const DEFAULT_CUSTOM_STORAGE_KEY = 'naruto_worldbook_custom';

function uniqueStrings(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function collectCharacterMentions(candidates, query) {
  const queryText = String(query || '').normalize('NFKC').toLocaleLowerCase('zh-CN');
  if (!queryText) return [];
  const mentions = new Map();
  for (const { entry } of candidates) {
    const profile = entry?.character_profile;
    if (!profile) continue;
    const names = uniqueStrings(profile.names).map(normalizeNpcIdentity).filter(Boolean);
    const canonicalName = names[0];
    if (!canonicalName || !names.some(name => queryText.includes(name.toLocaleLowerCase('zh-CN')))) continue;
    const entityId = String(profile.entity_id || entry?.entity_ids?.[0] || '').trim();
    const key = entityId || canonicalName;
    const previous = mentions.get(key);
    mentions.set(key, {
      ...(entityId ? { entity_id: entityId } : {}),
      canonical_name: previous?.canonical_name || canonicalName,
      names: uniqueStrings([...(previous?.names || []), ...names])
    });
  }
  return [...mentions.values()];
}

function tokenize(value) {
  const text = String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN');
  const terms = new Set(text.split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2));
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    terms.add(run);
    for (let size = 2; size <= Math.min(4, run.length); size++) {
      for (let index = 0; index <= run.length - size; index++) terms.add(run.slice(index, index + size));
    }
  }
  return [...terms];
}

function stateSkillSearchValues(state = {}) {
  const values = [];
  const categories = ['血继限界', '天赋', '忍术', '体术', '幻术', '辅助'];
  const fieldSuffixes = ['名称', '等级', '熟练度', '描述', '属性', '类型', '消耗', '消耗资源', '威力', '数据库ID', '来源'];
  for (const [key, value] of Object.entries(state)) {
    const category = categories.find(item => key.startsWith(`技能·${item}·`));
    if (!category) continue;
    const remainder = key.slice(`技能·${category}·`.length);
    const suffix = fieldSuffixes.find(field => remainder.endsWith(`·${field}`));
    const name = suffix ? remainder.slice(0, -(suffix.length + 1)) : remainder;
    if (name) values.push(name);
    if (suffix === '名称' || ((category === '血继限界' || category === '天赋') && suffix === '描述')) {
      values.push(value);
    }
  }

  const structured = state.skills && typeof state.skills === 'object' ? state.skills : {};
  for (const category of ['kekkei_genkai', 'talents', 'jutsu', 'taijutsu', 'genjutsu', 'support']) {
    const collection = structured[category];
    if (!collection || typeof collection !== 'object') continue;
    for (const [name, entry] of Object.entries(collection)) {
      values.push(name, entry?.name);
      if (category === 'kekkei_genkai' || category === 'talents') values.push(entry?.description);
    }
  }
  return values.filter(Boolean);
}

function stateSearchText(state = {}) {
  const missionValues = Object.values(state?._missions?.active || {});
  const parts = [
    state['世界·地点'],
    state['玩家·所属村'],
    state['玩家·出身'],
    state['玩家·查克拉属性'],
    state['技能·血继限界'],
    ...stateSkillSearchValues(state),
    state?._combat?.enemy_name,
    ...Object.keys(state?._relationships || {}),
    ...missionValues.flatMap(mission => [mission?.title, mission?.location, mission?.objective])
  ];
  return parts.filter(Boolean).join('\n');
}

function scoreEntry(entry, terms, directText) {
  if (entry.activation?.mode === 'always') return 1_000_000 + Number(entry.priority || 0);
  const title = String(entry.title || '').toLocaleLowerCase('zh-CN');
  const keys = uniqueStrings([...(entry.keys || []), ...(entry.activation?.keys || [])])
    .map(key => key.toLocaleLowerCase('zh-CN'));
  const content = String(entry.content || '').toLocaleLowerCase('zh-CN');
  let score = Number(entry.priority || 0) / 20;
  if (title && directText.includes(title)) score += 120;
  for (const key of keys) {
    if (!key) continue;
    if (directText.includes(key)) score += Math.min(80, 18 + key.length * 4);
  }
  for (const term of terms) {
    if (term.length < 2) continue;
    if (title.includes(term)) score += 16;
    if (keys.some(key => key.includes(term) || term.includes(key))) score += 12;
    if (content.includes(term)) score += 1;
  }
  return score;
}

function eraStateIsActive(state, currentDate) {
  if (!currentDate) return false;
  if (state?.from && compareWorldbookDates(currentDate, state.from) < 0) return false;
  if (state?.until && compareWorldbookDates(currentDate, state.until) >= 0) return false;
  return true;
}

function projectCharacterRuntime(entry, currentDate) {
  const profile = entry?.character_profile;
  if (!profile) return entry;
  const activeEraStates = (profile.era_states || [])
    .filter(state => eraStateIsActive(state, currentDate))
    .map(state => ({ ...state }));
  const projectedProfile = { ...profile, era_states: activeEraStates };
  const fieldLabels = [
    ['personality_core', '稳定性格核心'], ['values', '价值观'], ['goals', '动机与目标'],
    ['weaknesses', '弱点'], ['speech_style', '说话方式'], ['mannerisms', '动作习惯'],
    ['behavior_bounds', '行为边界'], ['combat_temperament', '战斗倾向'],
    ['social_baseline', '社交基线'], ['safe_appearance', '安全外观'],
    ['knowledge_baseline', '本人知识基线']
  ];
  const lines = [
    `[角色运行时档案: ${entry.title}]`,
    `当前日期: ${currentDate || '未明确'}`,
    '时间约束: 当前年龄、身份与当期状态高于成熟期稳定特征；任何不适合当前年龄/阶段的性格、能力、经历与说话方式都不得倒灌。'
  ];
  if (profile.phase_label) lines.push(`档案阶段: ${profile.phase_label}`);
  for (const state of activeEraStates) lines.push(`当前适用状态(${state.label}): ${state.content}`);
  for (const [field, label] of fieldLabels) {
    const values = projectedProfile[field] || [];
    if (values.length) lines.push(`${label}: ${values.join('；')}`);
  }
  return {
    ...entry,
    content: lines.join('\n'),
    character_profile: projectedProfile,
    runtime_temporal: {
      current_date: currentDate,
      active_era_labels: activeEraStates.map(state => state.label),
      stable_traits_require_age_compatibility: true,
      raw_biography_excluded_from_runtime: true
    }
  };
}

function defaultCustomLoader(storageKey) {
  try {
    if (typeof localStorage === 'undefined') return [];
    if (storageKey === DEFAULT_CUSTOM_STORAGE_KEY) return KNOWLEDGE_BASE.getCustomEntries();
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[WorldbookV2Resolver] 自定义世界书读取失败:', error.message);
    return [];
  }
}

/**
 * 唯一允许进入模型提示词的旧世界书解析器。
 * 审计目录中的 V2 原始条目保留来源与隔离片段；这里永远只返回 runtime projection。
 */
export class WorldbookV2Resolver {
  constructor({
    builtinEntries = WORLD_BOOK_V2_ENTRIES,
    customLoader = null,
    customStorageKey = DEFAULT_CUSTOM_STORAGE_KEY
  } = {}) {
    this.builtinEntries = Array.isArray(builtinEntries) ? builtinEntries : [];
    this.customLoader = customLoader || (() => defaultCustomLoader(customStorageKey));
  }

  _customEntries() {
    const legacy = this.customLoader?.() || [];
    if (!Array.isArray(legacy) || !legacy.length) return [];
    return migrateCustomWorldbookEntriesV1ToV2(legacy.map(normalizeCustomWorldbookEntry), { strict: true }).entries;
  }

  resolve({
    query = '',
    state = {},
    currentDate = null,
    audience = 'writer',
    maxEntries = 12,
    budget = 9000
  } = {}) {
    const triggerText = `${query}\n${stateSearchText(state)}`;
    const directText = triggerText.normalize('NFKC').toLocaleLowerCase('zh-CN');
    const terms = tokenize(directText);
    const customIds = new Set();
    const candidates = [];

    for (const entry of this._customEntries()) {
      if (!currentDate && (entry.validity?.from || entry.validity?.until)) continue;
      const baseRuntime = toRuntimeWorldbookEntry(entry, { audience, date: currentDate });
      const runtime = baseRuntime ? projectCharacterRuntime(baseRuntime, currentDate) : null;
      if (!runtime || !matchesWorldbookActivation(runtime, triggerText)) continue;
      customIds.add(runtime.id);
      candidates.push({ entry: runtime, score: 2_000_000 + Number(runtime.priority || 0), required: runtime.activation.mode === 'always', budgetExempt: false });
    }
    for (const entry of this.builtinEntries) {
      if (!currentDate && (entry.validity?.from || entry.validity?.until)) continue;
      if (!currentDate && entry.character_profile) continue;
      const baseRuntime = toRuntimeWorldbookEntry(entry, { audience, date: currentDate });
      const runtime = baseRuntime ? projectCharacterRuntime(baseRuntime, currentDate) : null;
      if (!runtime || runtime.activation?.mode === 'manual' || customIds.has(runtime.id)) continue;
      const score = scoreEntry(runtime, terms, directText);
      const required = runtime.activation?.mode === 'always';
      if (required || score > 5) candidates.push({ entry: runtime, score, required, budgetExempt: required });
    }

    candidates.sort((left, right) => Number(right.required) - Number(left.required)
      || right.score - left.score
      || left.entry.title.localeCompare(right.entry.title, 'zh-CN'));

    const characterMentions = collectCharacterMentions(candidates, query);

    const selected = [];
    let optionalUsed = 0;
    let optionalSelected = 0;
    const budgetSkippedIds = [];
    for (const candidate of candidates) {
      const cost = JSON.stringify(candidate.entry).length + (optionalSelected ? 1 : 2);
      // Only the finite, bundled core rules retain their reserved allocation.
      // Imported blue entries are prioritized, but never exempt from the cap.
      if (!candidate.budgetExempt && (optionalSelected >= Math.max(0, Number(maxEntries) || 0)
        || optionalUsed + cost > Math.max(0, Number(budget) || 0))) {
        budgetSkippedIds.push(candidate.entry.id);
        continue;
      }
      selected.push(candidate.entry);
      if (!candidate.budgetExempt) {
        optionalSelected++;
        optionalUsed += cost;
      }
    }
    return {
      schema: 'naruto.worldbook-runtime-resolution/v2',
      audience,
      current_date: currentDate,
      entries: selected,
      character_mentions: characterMentions,
      selected_ids: selected.map(entry => entry.id),
      custom_always_on_count: selected.filter(entry => entry.source?.kind === 'custom' && entry.activation?.mode === 'always').length,
      budget_used_chars: optionalUsed,
      budget_skipped_ids: budgetSkippedIds
    };
  }
}

export const worldbookV2Resolver = new WorldbookV2Resolver();

export default worldbookV2Resolver;
