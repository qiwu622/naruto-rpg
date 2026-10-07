import { GAME_DATA, getMasteryTier } from '../data/game-data.js';
import { resolveCanonTechnique, toCanonicalStateSkill } from '../data/canon-database.js';
import {
  calculateCombatLevel,
  combatAttributesFromNpcCard,
  combatMasteriesFromNpcCard
} from './combat-level.js';

const DEFAULT_RANK = '下忍';

const RANK_ALIASES = Object.freeze({
  忍者学校: '忍校学生',
  忍校生: '忍校学生',
  忍者学校学生: '忍校学生',
  学生: '忍校学生',
  特上: '特别上忍',
  精英: '精英上忍',
  影: '影级',
  火影: '影级',
  风影: '影级',
  水影: '影级',
  土影: '影级',
  雷影: '影级',
  S级: '影级',
  A级: '上忍',
  B级: '中忍',
  C级: '下忍'
});

const DIFFICULTY_PERCENTILES = Object.freeze({
  轻松: 0.3,
  忍者学校: 0.3,
  标准: 0.5,
  普通: 0.5,
  下忍: 0.5,
  困难: 0.65,
  中忍: 0.65,
  残酷: 0.8,
  极难: 0.8,
  上忍: 0.8,
  传说: 0.95,
  影: 0.95
});

export const TECHNIQUE_POWER_RULES = Object.freeze({
  E: { power: 8 },
  D: { power: 16 },
  C: { power: 34 },
  B: { power: 62 },
  A: { power: 105 },
  S: { power: 180 }
});

const STAT_FIELDS = Object.freeze({
  chakra: ['查克拉上限', 'chakra_max', 'enemy_chakra_max'],
  vitality: ['生命力上限', 'vitality_max', 'enemy_vitality_max', 'enemy_hp_max'],
  stamina: ['体力上限', 'stamina_max', 'enemy_stamina_max'],
  speed: ['速度', 'speed', 'enemy_speed'],
  spirit: ['精神力上限', 'spirit_max', 'enemy_spirit_max'],
  luck: ['幸运', 'luck', 'enemy_luck']
});

const OUTPUT_FIELDS = Object.freeze({
  chakra: '查克拉上限',
  vitality: '生命力上限',
  stamina: '体力上限',
  speed: '速度',
  spirit: '精神力上限',
  luck: '幸运'
});

export const COST_PRESSURE_PROFILES = Object.freeze({
  light: Object.freeze({ minRatio: 0.05, maxRatio: 0.10, expectedUses: [10, 20], label: '轻量/基础' }),
  standard: Object.freeze({ minRatio: 0.125, maxRatio: 0.20, expectedUses: [5, 8], label: '常规主力' }),
  heavy: Object.freeze({ minRatio: 0.25, maxRatio: 0.40, expectedUses: [2, 4], label: '高消耗强力' }),
  extreme: Object.freeze({ minRatio: 0.50, maxRatio: 1.00, expectedUses: [1, 2], label: '决胜/禁术' })
});

const RESOURCE_BENCHMARK_KEYS = Object.freeze({
  查克拉: 'chakra',
  精神力: 'spirit',
  体力: 'stamina'
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNumber(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    if (source[key] === undefined || source[key] === null || source[key] === '') continue;
    const number = finiteNumber(source[key]);
    if (number !== null) return number;
  }
  return null;
}

function firstValue(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return undefined;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function benchmarkValue(range, percentile) {
  return Math.round(range[0] + (range[1] - range[0]) * percentile);
}

function normalizeTechniqueRank(value) {
  const match = String(value || 'D').toUpperCase().match(/[EDCBAS]/);
  return match?.[0] || 'D';
}

function normalizeTechniqueType(value) {
  const raw = String(value || '忍术').trim().toLowerCase();
  if (raw.includes('体') || raw === 'taijutsu') return '体术';
  if (raw.includes('幻') || raw === 'genjutsu') return '幻术';
  if (raw.includes('支') || raw.includes('辅') || raw === 'support') return '支援';
  return '忍术';
}

export function normalizeTechniqueResource(value, type = '忍术') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.includes('精神') || raw === 'spirit') return '精神力';
  if (raw.includes('体力') || raw === 'stamina') return '体力';
  if (raw.includes('查克拉') || raw === 'chakra') return '查克拉';
  if (type === '幻术') return '精神力';
  if (type === '体术') return '体力';
  return '查克拉';
}

export function getTechniqueCostGuidance({ referenceRank = DEFAULT_RANK, resource = '查克拉', pressure = 'standard' } = {}) {
  const rank = canonicalizeNpcRank(referenceRank, DEFAULT_RANK);
  const normalizedResource = normalizeTechniqueResource(resource);
  const benchmarkKey = RESOURCE_BENCHMARK_KEYS[normalizedResource];
  const range = GAME_DATA.getRankBenchmark(rank)[benchmarkKey];
  const profile = COST_PRESSURE_PROFILES[pressure] || COST_PRESSURE_PROFILES.standard;
  const referencePool = Math.round((range[0] + range[1]) / 2);
  return {
    referenceRank: rank,
    resource: normalizedResource,
    pressure: COST_PRESSURE_PROFILES[pressure] ? pressure : 'standard',
    label: profile.label,
    poolRange: [...range],
    referencePool,
    minCost: Math.max(1, Math.round(referencePool * profile.minRatio)),
    maxCost: Math.max(1, Math.round(referencePool * profile.maxRatio)),
    expectedUses: [...profile.expectedUses]
  };
}

export function evaluateTechniqueCostBalance(input = {}, options = {}) {
  const usage = resolveTechniqueUsage(input);
  const guidance = getTechniqueCostGuidance({
    referenceRank: options.referenceRank,
    resource: usage.resource,
    pressure: options.pressure
  });
  const status = usage.cost < guidance.minCost ? 'under' : usage.cost > guidance.maxCost ? 'over' : 'within';
  return {
    ...guidance,
    cost: usage.cost,
    status,
    estimatedUses: usage.cost > 0 ? Math.floor(guidance.referencePool / usage.cost) : null
  };
}

function normalizeNature(value) {
  if (Array.isArray(value)) return [...new Set(value.map(item => String(item).trim()).filter(Boolean))];
  if (value === undefined || value === null || value === '') return [];
  return [...new Set(String(value).split(/[,，、]/).map(item => item.trim()).filter(Boolean))];
}

export function canonicalizeNpcRank(value, fallback = DEFAULT_RANK) {
  const raw = String(value || '').trim();
  if (GAME_DATA.rankBenchmarks[raw]) return raw;
  if (RANK_ALIASES[raw]) return RANK_ALIASES[raw];
  if (raw.includes('精英') && raw.includes('上忍')) return '精英上忍';
  if ((raw.includes('特别') || raw.includes('特殊')) && raw.includes('上忍')) return '特别上忍';
  if (raw.includes('影')) return '影级';
  if (raw.includes('上忍')) return '上忍';
  if (raw.includes('中忍')) return '中忍';
  if (raw.includes('下忍')) return '下忍';
  if (raw.includes('忍校') || raw.includes('学校') || raw.includes('学生')) return '忍校学生';
  if (raw && fallback !== DEFAULT_RANK) return canonicalizeNpcRank(fallback, DEFAULT_RANK);
  return GAME_DATA.rankBenchmarks[fallback] ? fallback : DEFAULT_RANK;
}

export function normalizeTechnique(input = {}, options = {}) {
  const name = String(firstValue(input, ['name', '\u540d\u79f0', 'action_name']) || '\u672a\u547d\u540d\u62db\u5f0f').trim();
  const masteryRaw = firstNumber(input, ['mastery', '\u719f\u7ec3\u5ea6']);
  const mastery = Math.round(clamp(masteryRaw ?? 30, 0, 100));
  const resolution = options.canonicalize ? resolveCanonTechnique(name) : { status: 'unmatched' };
  if (resolution.status === 'matched') {
    const canonical = toCanonicalStateSkill(resolution.technique, { mastery });
    return {
      '\u6570\u636e\u5e93ID': canonical.technique_id,
      '\u6765\u6e90': 'canon',
      '\u540d\u79f0': canonical.name,
      '\u7b49\u7ea7': canonical.rank,
      '\u5c5e\u6027': canonical.element,
      '\u6d88\u8017': canonical.cost,
      '\u6d88\u8017\u8d44\u6e90': canonical.resource_type,
      '\u5a01\u529b': canonical.power,
      '\u719f\u7ec3\u5ea6': canonical.mastery,
      '\u63cf\u8ff0': canonical.description,
      '\u7c7b\u578b': normalizeTechniqueType(canonical.type)
    };
  }
  if (resolution.status === 'ambiguous') {
    console.warn('[NpcBalance] Ambiguous canonical technique alias:', name, resolution.candidates.map(candidate => candidate.id));
  }
  const rank = normalizeTechniqueRank(firstValue(input, ['rank', '\u7b49\u7ea7', 'action_rank']));
  const type = normalizeTechniqueType(firstValue(input, ['type', '\u7c7b\u578b', 'action_type']));
  const resource = normalizeTechniqueResource(firstValue(input, ['resource_type', 'resource', '\u6d88\u8017\u8d44\u6e90']), type);
  const tier = getMasteryTier(mastery);
  const rule = TECHNIQUE_POWER_RULES[rank];
  const explicitCost = firstNumber(input, ['cost', '\u6d88\u8017', 'resource_cost', 'chakra_cost']);
  const explicitPower = firstNumber(input, ['power', '\u5a01\u529b']);
  // Keep the legacy display value while recording the unmodified base for the
  // tactical resolver. An edited power invalidates this provenance marker.
  const normalizedPower = Math.round(clamp(explicitPower ?? (rule.power * tier.power_multiplier), 0, 300));
  const powerBasis = explicitPower === null
    ? { base: rule.power, displayed: normalizedPower }
    : input._power_basis?.displayed === explicitPower ? input._power_basis : null;
  const minCost = type === '\u652f\u63f4' ? 0 : 1;
  const technique = {
    '\u540d\u79f0': name,
    '\u7b49\u7ea7': rank,
    '\u5c5e\u6027': String(firstValue(input, ['element', '\u5c5e\u6027']) || '\u65e0').trim(),
    '\u6d88\u8017': Math.round(clamp(explicitCost ?? minCost, minCost, 300)),
    '\u6d88\u8017\u8d44\u6e90': resource,
    '\u5a01\u529b': normalizedPower,
    ...(powerBasis ? { _power_basis: powerBasis } : {}),
    '\u719f\u7ec3\u5ea6': mastery,
    '\u63cf\u8ff0': String(firstValue(input, ['description', '\u63cf\u8ff0']) || '').trim(),
    '\u7c7b\u578b': type
  };
  const existingTechniqueId = firstValue(input, ['\u6570\u636e\u5e93ID', 'technique_id']);
  const existingSource = firstValue(input, ['\u6765\u6e90', 'source']);
  if (existingTechniqueId) technique['\u6570\u636e\u5e93ID'] = existingTechniqueId;
  if (existingSource) technique['\u6765\u6e90'] = existingSource;
  else if (options.markOriginal) technique['\u6765\u6e90'] = 'ai_original';
  return technique;
}

export function resolveTechniqueCost(input = {}) {
  return normalizeTechnique(input).消耗;
}

// Backward-compatible export for older integrations; the cost may target spirit or stamina.
export function resolveTechniqueChakraCost(input = {}) {
  return resolveTechniqueCost(input);
}

export function resolveTechniqueUsage(input = {}) {
  const technique = normalizeTechnique(input);
  return {
    type: technique.类型,
    resource: technique.消耗资源,
    cost: technique.消耗,
    technique
  };
}

export function normalizeNpcCombatStats(input = {}, existing = null, options = {}) {
  const existingCard = existing && typeof existing === 'object' ? existing : {};
  const requestedRank = firstValue(input, ['忍阶', 'rank', 'enemy_rank']);
  const previousRank = firstValue(existingCard, ['忍阶', 'rank']);
  const rank = canonicalizeNpcRank(requestedRank || previousRank || options.fallbackRank || DEFAULT_RANK);
  const benchmark = GAME_DATA.getRankBenchmark(rank);
  const percentile = clamp(
    finiteNumber(options.percentile) ?? DIFFICULTY_PERCENTILES[options.difficulty] ?? 0.5,
    0,
    1
  );
  const card = { ...existingCard, 忍阶: rank };

  for (const [stat, inputKeys] of Object.entries(STAT_FIELDS)) {
    const outputKey = OUTPUT_FIELDS[stat];
    const range = benchmark[stat];
    const incoming = firstNumber(input, inputKeys);
    const previous = firstNumber(existingCard, inputKeys);
    const fallback = previous ?? benchmarkValue(range, percentile);
    // Rank describes a typical starting point, not a ceiling on an individual's
    // recorded growth. Keep the same numeric domain as player attributes.
    card[outputKey] = Math.round(clamp(incoming ?? fallback, 0, 9999));
  }

  const incomingChakra = firstNumber(input, ['查克拉', 'chakra', 'enemy_chakra']);
  const previousChakra = firstNumber(existingCard, ['查克拉', 'chakra']);
  const desiredChakra = incomingChakra ?? previousChakra ?? card.查克拉上限;
  card.查克拉 = Math.round(clamp(desiredChakra, 0, card.查克拉上限));

  const resourcePairs = [
    ['生命力', '生命力上限', ['生命力', 'vitality', 'enemy_vitality', 'enemy_hp']],
    ['体力', '体力上限', ['体力', 'stamina', 'enemy_stamina']],
    ['精神力', '精神力上限', ['精神力', 'spirit', 'enemy_spirit']]
  ];
  for (const [currentKey, maxKey, inputKeys] of resourcePairs) {
    const incoming = firstNumber(input, inputKeys);
    const previous = firstNumber(existingCard, inputKeys);
    // Omission preserves damage/exhaustion; an explicit value can also heal.
    const desired = incoming ?? previous ?? card[maxKey];
    card[currentKey] = Math.round(clamp(desired, 0, card[maxKey]));
  }

  const masteryRange = benchmark.skillMastery;
  const masteryDefault = benchmarkValue(masteryRange, percentile);
  const masteryFields = [
    ['忍术造诣', ['忍术造诣', 'ninjutsu']],
    ['体术造诣', ['体术造诣', 'taijutsu']],
    ['幻术造诣', ['幻术造诣', 'genjutsu']]
  ];
  for (const [outputKey, inputKeys] of masteryFields) {
    const incoming = firstNumber(input, inputKeys);
    const previous = firstNumber(existingCard, inputKeys);
    card[outputKey] = Math.round(clamp(incoming ?? previous ?? masteryDefault, 0, 100));
  }

  const incomingNatures = firstValue(input, ['查克拉属性', 'chakra_nature']);
  const existingNatures = firstValue(existingCard, ['查克拉属性', 'chakra_nature']);
  card.查克拉属性 = [...new Set([...normalizeNature(existingNatures), ...normalizeNature(incomingNatures)])];

  const incomingTechniques = firstValue(input, ['忍术', 'jutsu']);
  const existingTechniques = firstValue(existingCard, ['忍术', 'jutsu']);
  const existingTechniqueList = Array.isArray(existingTechniques) ? existingTechniques : [];
  const techniqueIdentity = technique => {
    const techniqueName = firstValue(technique, ['name', '\u540d\u79f0', 'action_name']);
    const resolution = resolveCanonTechnique(techniqueName);
    return resolution.status === 'matched'
      ? 'id:' + resolution.technique.id
      : 'name:' + String(techniqueName || '').normalize('NFKC').toLowerCase();
  };
  const techniques = new Map(existingTechniqueList.map(technique => [
    techniqueIdentity(technique), normalizeTechnique(technique)
  ]));
  // Relationship instructions carry increments. Practising one technique or
  // learning a new one must not replace the rest of the NPC's repertoire.
  for (const techniqueInput of Array.isArray(incomingTechniques) ? incomingTechniques : []) {
    const identity = techniqueIdentity(techniqueInput);
    const existingTechnique = techniques.get(identity);
    const isExisting = Boolean(existingTechnique);
    const mergedInput = isExisting ? { ...existingTechnique, ...techniqueInput } : techniqueInput;
    techniques.set(identity, normalizeTechnique(mergedInput, { canonicalize: !isExisting, markOriginal: !isExisting }));
  }
  const seenTechniques = new Set();
  card['\u5fcd\u672f'] = [...techniques.values()].filter(technique => {
    const key = technique['\u540d\u79f0'];
    if (!key || seenTechniques.has(key)) return false;
    seenTechniques.add(key);
    return true;
  });

  // Legacy English aliases must not keep competing with the updated canonical
  // values (combatMasteriesFromNpcCard also accepts those older shapes).
  const canonicalKeys = new Set([...Object.values(OUTPUT_FIELDS), '查克拉', '生命力', '体力', '精神力',
    '忍阶', '查克拉属性', '忍术', ...masteryFields.map(([key]) => key)]);
  const aliases = [...Object.values(STAT_FIELDS).flat(), 'chakra', 'enemy_chakra',
    ...resourcePairs.flatMap(([, , keys]) => keys), ...masteryFields.flatMap(([, keys]) => keys),
    'rank', 'enemy_rank', 'chakra_nature', 'jutsu'];
  for (const key of aliases) if (!canonicalKeys.has(key)) delete card[key];

  card.战力等级 = calculateCombatLevel(
    combatAttributesFromNpcCard(card),
    combatMasteriesFromNpcCard(card)
  );

  return card;
}

export function buildDefaultNpcCombatStats(options = {}) {
  return normalizeNpcCombatStats({ 忍阶: options.rank || DEFAULT_RANK }, null, options);
}
