import { isWorldbookEntryEnabled, normalizeWorldbookActivation } from './activation.js';

export const WORLD_BOOK_V2_SCHEMA_VERSION = '2.0';

export const WORLD_BOOK_V2_VISIBILITIES = Object.freeze([
  'public',
  'restricted',
  'secret',
  'backstage'
]);

export const WORLD_BOOK_V2_AUDIENCES = Object.freeze([
  'narrator',
  'writer',
  'updater',
  'reviewer',
  'planner',
  'npc'
]);

export const WORLD_BOOK_V2_JSON_SCHEMA = Object.freeze({
  $id: 'naruto-rpg/worldbook-entry-v2',
  type: 'object',
  required: [
    'id', 'schema_version', 'title', 'keys', 'category', 'enabled', 'status',
    'priority', 'activation', 'validity', 'knowledge', 'entity_ids',
    'organization_ids', 'content', 'source', 'safety'
  ],
  properties: {
    id: { type: 'string', pattern: '^wb2-[a-z_]+-[a-f0-9]{8}(?:-[a-f0-9]{8})?$' },
    schema_version: { const: WORLD_BOOK_V2_SCHEMA_VERSION },
    title: { type: 'string', minLength: 1 },
    keys: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    category: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    status: {
      enum: ['active', 'legacy_reference', 'legacy_trusted_public', 'disabled', 'quarantined']
    },
    priority: { type: 'number', minimum: 0, maximum: 100 },
    activation: {
      type: 'object',
      required: ['mode', 'keys'],
      properties: {
        mode: { enum: ['keyword', 'always', 'manual'] },
        keys: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        secondary_keys: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        selective: { type: 'boolean' },
        selective_logic: { enum: ['and_any', 'not_all', 'not_any', 'and_all'] },
        case_sensitive: { type: 'boolean' },
        match_whole_words: { type: 'boolean' }
      }
    },
    validity: {
      type: 'object',
      required: ['from', 'until', 'precision', 'source_text'],
      properties: {
        from: { type: ['string', 'null'] },
        until: { type: ['string', 'null'] },
        precision: { enum: ['unbounded', 'year', 'day'] },
        source_text: { type: ['string', 'null'] }
      }
    },
    knowledge: {
      type: 'object',
      required: ['visibility', 'audience', 'reveal_conditions'],
      properties: {
        visibility: { enum: WORLD_BOOK_V2_VISIBILITIES },
        audience: {
          type: 'array',
          items: { enum: WORLD_BOOK_V2_AUDIENCES },
          uniqueItems: true
        },
        reveal_conditions: { type: 'array' }
      }
    },
    entity_ids: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    organization_ids: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    content: { type: 'string' },
    character_profile: {
      type: ['object', 'null'],
      required: [
        'entity_id', 'names', 'aliases', 'phase_label', 'personality_core',
        'values', 'goals', 'weaknesses', 'speech_style', 'mannerisms',
        'behavior_bounds', 'combat_temperament', 'social_baseline',
        'safe_appearance', 'knowledge_baseline', 'era_states'
      ],
      properties: {
        entity_id: { type: 'string', minLength: 1 },
        names: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
        aliases: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
        phase_label: { type: 'string' },
        personality_core: { type: 'array', items: { type: 'string' } },
        values: { type: 'array', items: { type: 'string' } },
        goals: { type: 'array', items: { type: 'string' } },
        weaknesses: { type: 'array', items: { type: 'string' } },
        speech_style: { type: 'array', items: { type: 'string' } },
        mannerisms: { type: 'array', items: { type: 'string' } },
        behavior_bounds: { type: 'array', items: { type: 'string' } },
        combat_temperament: { type: 'array', items: { type: 'string' } },
        social_baseline: { type: 'array', items: { type: 'string' } },
        safe_appearance: { type: 'array', items: { type: 'string' } },
        knowledge_baseline: { type: 'array', items: { type: 'string' } },
        era_states: { type: 'array', items: { type: 'object' } }
      }
    },
    source: {
      type: 'object',
      required: ['kind'],
      properties: { kind: { type: 'string', minLength: 1 } }
    },
    safety: {
      type: 'object',
      required: ['runtime_safe', 'sanitized', 'removed_fragment_count'],
      properties: {
        runtime_safe: { const: true },
        sanitized: { type: 'boolean' },
        removed_fragment_count: { type: 'number', minimum: 0 }
      }
    }
  }
});

const DATE_KEY_RE = /^K-?\d{3,4}-\d{2}-\d{2}$/;
const ID_RE = /^wb2-[a-z_]+-[a-f0-9]{8}(?:-[a-f0-9]{8})?$/;
const ALLOWED_STATUSES = new Set(WORLD_BOOK_V2_JSON_SCHEMA.properties.status.enum);
const ALLOWED_ACTIVATION_MODES = new Set(['keyword', 'always', 'manual']);
const ALLOWED_PRECISIONS = new Set(['unbounded', 'year', 'day']);
const ALLOWED_VISIBILITIES = new Set(WORLD_BOOK_V2_VISIBILITIES);
const ALLOWED_AUDIENCES = new Set(WORLD_BOOK_V2_AUDIENCES);

// 这些词只用于运行时净化。原文仍保存在 source_fragments 中，供迁移审计查看。
const EXPLICIT_SEXUAL_CONTENT_RE = /(?:乳头|乳晕|双乳|巨乳|阴毛|小穴|大阴唇|小阴唇|后穴|穴口|爱液|媚肉|花壶|蜜穴|肉棒|阴茎|阴囊|龟头|包皮|阴蒂|性器|性征|床笫|未经人事|处女膜|发情|性交|交媾|强奸|奸淫|高潮|勃起|乳交|肛交|被填满|痴女|肉欲|情欲|欲火|吸吮力|性经验|神秘花园)/i;
const SEXUALIZED_LANGUAGE_RE = /(?:性感|妖娆|火辣|惹火|撩人|肉感|香艳|色气|妩媚|荷尔蒙|费洛蒙|春情|肉浪|欲望颤动|成熟女人的|少妇|女体|禁忌.*诱惑|(?:身材|身段|身体|胸|臀|腿|腰|肌肤|女人|少女).{0,24}诱惑|诱惑.{0,24}(?:身材|身段|身体|胸|臀|腿|腰|肌肤|女人|少女))/i;
const MINOR_BODY_SEXUALIZATION_RE = /(?:胸(?:部|前|脯).{0,30}(?:丰满|高耸|隆起|发育|平坦|曲线|晃动|颤动|肉感|诱人)|(?:丰满|高耸|隆起|发育).{0,30}胸(?:部|前|脯)|身体发育|早熟.{0,12}(?:身材|身体)|隐秘地带)/i;
const MINOR_WORD_RE = /(?:未成年|婴儿|婴幼儿|幼儿|幼童|幼女|幼男|小女孩|小男孩|儿童|孩童|少年|少女|襁褓|刚出生|年幼|幼年)/i;

const PROFILE_SECTION_LABELS = Object.freeze({
  personality_core: ['核心性格', '性格特质'],
  values: ['价值观', '原则', '信念'],
  goals: ['动机', '目标', '核心目标'],
  weaknesses: ['弱点', '短板'],
  speech_style: ['说话方式', '语言风格'],
  mannerisms: ['动作习惯', '习惯', '表情习惯'],
  behavior_bounds: ['行为边界', '行为禁区'],
  combat_temperament: ['战斗风格', '战斗性格', '能力特色'],
  social_baseline: ['社交方式', '人际关系', '与玩家关系'],
  safe_appearance: ['外貌特征', '安全外貌'],
  knowledge_baseline: ['当前状态', '知识边界']
});

const ALL_PROFILE_LABELS = Object.values(PROFILE_SECTION_LABELS).flat();

export function stableWorldbookHash(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value ?? '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeWorldbookTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value ?? '').normalize('NFKC').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeCategory(value) {
  const normalized = String(value || 'reference')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'reference';
}

export function canonicalCharacterName(title) {
  return normalizeWorldbookTitle(title)
    .replace(/^【[^】]+】/, '')
    .replace(/^(?:早期|疾风传|战后|新时代)[·:：\s-]*/, '')
    .replace(/(?:·(?:性格细节|外貌细节|外貌|人物细节|角色细节))$/, '')
    .trim();
}

export function buildStableWorldbookId(title, category = 'reference', salt = '') {
  const safeCategory = normalizeCategory(category);
  const identity = `${normalizeWorldbookTitle(title).toLocaleLowerCase('zh-CN')}|${salt}`;
  return `wb2-${safeCategory}-${stableWorldbookHash(identity)}`;
}

export function buildStableEntityId(name) {
  const canonical = canonicalCharacterName(name);
  return canonical ? `character-${stableWorldbookHash(canonical.toLocaleLowerCase('zh-CN'))}` : '';
}

function formatKonohaDate(year, month = 1, day = 1) {
  const numericYear = Number(year);
  if (!Number.isFinite(numericYear)) return null;
  const sign = numericYear < 0 ? '-' : '';
  const paddedYear = String(Math.abs(Math.trunc(numericYear))).padStart(3, '0');
  return `K${sign}${paddedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseLegacyValidity(content) {
  const text = String(content || '');
  const tag = text.match(/\[适用年代:\s*([^\]]+)\]/);
  if (!tag) {
    return { from: null, until: null, precision: 'unbounded', source_text: null };
  }

  const sourceText = tag[0];
  const value = tag[1].trim();
  const range = value.match(/木叶(-?\d+)年\s*(?:至|到|[-—~～])\s*木叶(-?\d+)年/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return {
      from: formatKonohaDate(start),
      until: formatKonohaDate(end + 1),
      precision: 'year',
      source_text: sourceText
    };
  }

  const before = value.match(/木叶(-?\d+)年\s*及以前/);
  if (before) {
    return {
      from: null,
      until: formatKonohaDate(Number(before[1]) + 1),
      precision: 'year',
      source_text: sourceText
    };
  }

  const after = value.match(/木叶(-?\d+)年\s*及以后/);
  if (after) {
    return {
      from: formatKonohaDate(Number(after[1])),
      until: null,
      precision: 'year',
      source_text: sourceText
    };
  }

  const single = value.match(/木叶(-?\d+)年/);
  if (single) {
    const year = Number(single[1]);
    return {
      from: formatKonohaDate(year),
      until: formatKonohaDate(year + 1),
      precision: 'year',
      source_text: sourceText
    };
  }

  return { from: null, until: null, precision: 'unbounded', source_text: sourceText };
}

function parseAgeMentions(text) {
  const ages = [];
  for (const match of String(text || '').matchAll(/(?:约|大约)?\s*(\d{1,2})\s*岁/g)) {
    ages.push(Number(match[1]));
  }
  return ages;
}

export function isMinorWorldbookContext(text) {
  const value = String(text || '');
  return MINOR_WORD_RE.test(value) || parseAgeMentions(value).some(age => age < 18);
}

function splitContentFragments(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  const fragments = [];
  let buffer = '';
  for (const char of text) {
    buffer += char;
    if (char === '\n' || char === '。' || char === '！' || char === '？' || char === '；') {
      fragments.push(buffer);
      buffer = '';
    }
  }
  if (buffer) fragments.push(buffer);
  return fragments;
}

function isolateContaminatedAppearanceSections(content, minorContext, removedFragments) {
  const heading = '(?:外貌特征|身体特征|私密描写|成人外貌)';
  const nextHeading = '(?:核心身份|大事记与状态|核心性格|性格特质|价值观|动机|目标|弱点|说话方式|行为边界|战斗风格|当前状态|知识边界|木叶-?\\d+年)';
  const pattern = new RegExp(`(^|\\n)(\\s*${heading}\\s*[:：][\\s\\S]*?)(?=\\n\\s*(?:[-•]\\s*)?${nextHeading}\\s*[:：]|$)`, 'g');
  return String(content || '').replace(pattern, (whole, prefix, section) => {
    const explicitReason = fragmentSafetyReason(section, minorContext);
    const minorBodyRisk = minorContext && (MINOR_BODY_SEXUALIZATION_RE.test(section) || SEXUALIZED_LANGUAGE_RE.test(section));
    if (!explicitReason && !minorBodyRisk) return whole;
    const reason = minorContext ? 'minor_sexualization' : (explicitReason || 'sexualized_description');
    removedFragments.push({
      reason,
      fragment: section,
      fragment_hash: stableWorldbookHash(section.trim()),
      fragment_kind: 'appearance_section'
    });
    return prefix;
  });
}

function fragmentSafetyReason(fragment, minorContext) {
  if (EXPLICIT_SEXUAL_CONTENT_RE.test(fragment)) {
    return minorContext ? 'minor_sexualization' : 'explicit_sexual_content';
  }
  if (SEXUALIZED_LANGUAGE_RE.test(fragment)) {
    return minorContext ? 'minor_sexualization' : 'sexualized_description';
  }
  if (minorContext && MINOR_BODY_SEXUALIZATION_RE.test(fragment)) {
    return 'minor_sexualization';
  }
  return null;
}

export function inspectWorldbookRuntimeSafety(content, { title = '', keys = [] } = {}) {
  const combinedContext = `${title}\n${(keys || []).join(' ')}\n${content}`;
  const minorContext = isMinorWorldbookContext(combinedContext);
  const violations = [];
  for (const fragment of splitContentFragments(content)) {
    const reason = fragmentSafetyReason(fragment, minorContext);
    if (reason) {
      violations.push({ reason, fragment_hash: stableWorldbookHash(fragment.trim()) });
    }
  }
  return { safe: violations.length === 0, minor_context: minorContext, violations };
}

export function sanitizeWorldbookContent(content, { title = '', keys = [] } = {}) {
  const original = String(content || '');
  const combinedContext = `${title}\n${(keys || []).join(' ')}\n${original}`;
  const minorContext = isMinorWorldbookContext(combinedContext);
  const kept = [];
  const removedFragments = [];
  const contentWithoutContaminatedSections = isolateContaminatedAppearanceSections(
    original,
    minorContext,
    removedFragments
  );

  for (const fragment of splitContentFragments(contentWithoutContaminatedSections)) {
    const reason = fragmentSafetyReason(fragment, minorContext);
    if (!reason) {
      kept.push(fragment);
      continue;
    }
    removedFragments.push({
      reason,
      fragment,
      fragment_hash: stableWorldbookHash(fragment.trim())
    });
  }

  let sanitized = kept.join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (!sanitized && normalizeWorldbookTitle(title)) {
    sanitized = `[${normalizeWorldbookTitle(title)}]\n该条目的不适合片段已被隔离；运行时不得从原文补全被隔离内容。`;
  }

  return {
    content: sanitized,
    changed: removedFragments.length > 0,
    minor_context: minorContext,
    removed_fragments: removedFragments,
    reasons: [...new Set(removedFragments.map(item => item.reason))]
  };
}

function sanitizeKeys(keys, minorContextText) {
  const minorContext = isMinorWorldbookContext(minorContextText);
  return uniqueStrings(keys).filter(key => !fragmentSafetyReason(key, minorContext));
}

function extractProfileSection(content, labels) {
  const text = String(content || '');
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const otherLabels = ALL_PROFILE_LABELS
      .filter(item => item !== label)
      .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const boundary = `(?=\\n\\s*(?:[-•]\\s*)?(?:(?:${otherLabels})|木叶-?\\d+年(?:前后|以前|以后)?|[^\\n:：]{1,18})\\s*[:：]|$)`;
    const match = text.match(new RegExp(`(?:^|\\n)${escaped}\\s*[:：]\\s*([\\s\\S]*?)${boundary}`, 'i'));
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return '';
}

function extractEraStates(content, title, keys) {
  const states = [];
  const text = String(content || '');
  const pattern = /(?:^|\n)\s*[-•]?\s*(木叶(-?\d+)年(?:前后|以前|以后)?)\s*[:：]\s*([^\n]+)/g;
  for (const match of text.matchAll(pattern)) {
    const label = match[1];
    const year = Number(match[2]);
    const safe = sanitizeWorldbookContent(match[3], { title, keys }).content;
    if (!safe) continue;
    states.push({
      label,
      from: label.endsWith('以前') ? null : formatKonohaDate(year),
      until: label.endsWith('以后') ? null : formatKonohaDate(year + 1),
      content: safe
    });
  }
  return states;
}

function listifyProfileValue(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  const text = String(value || '').trim();
  if (!text) return [];
  return uniqueStrings(text.split(/\n+|；/).map(item => item.replace(/^[-•]\s*/, '').trim()));
}

function normalizeProfile(profile, { title, keys, content, entityIds }) {
  const supplied = profile && typeof profile === 'object' ? profile : {};
  const name = canonicalCharacterName(supplied.name || title);
  const inferredAliases = keys
    .map(key => key.replace(/(?:性格|细节|说话方式|行为边界|外貌|状态|规则)$/g, '').trim())
    .filter(Boolean);
  const safeProfile = {
    entity_id: String(supplied.entity_id || entityIds[0] || buildStableEntityId(name)),
    names: uniqueStrings(supplied.names?.length ? supplied.names : [name]),
    aliases: uniqueStrings(supplied.aliases?.length ? supplied.aliases : inferredAliases),
    phase_label: String(supplied.phase_label || title.match(/^【([^】]+)】/)?.[1] || '').trim(),
    personality_core: listifyProfileValue(supplied.personality_core || extractProfileSection(content, PROFILE_SECTION_LABELS.personality_core)),
    values: listifyProfileValue(supplied.values || extractProfileSection(content, PROFILE_SECTION_LABELS.values)),
    goals: listifyProfileValue(supplied.goals || extractProfileSection(content, PROFILE_SECTION_LABELS.goals)),
    weaknesses: listifyProfileValue(supplied.weaknesses || extractProfileSection(content, PROFILE_SECTION_LABELS.weaknesses)),
    speech_style: listifyProfileValue(supplied.speech_style || extractProfileSection(content, PROFILE_SECTION_LABELS.speech_style)),
    mannerisms: listifyProfileValue(supplied.mannerisms || extractProfileSection(content, PROFILE_SECTION_LABELS.mannerisms)),
    behavior_bounds: listifyProfileValue(supplied.behavior_bounds || extractProfileSection(content, PROFILE_SECTION_LABELS.behavior_bounds)),
    combat_temperament: listifyProfileValue(supplied.combat_temperament || extractProfileSection(content, PROFILE_SECTION_LABELS.combat_temperament)),
    social_baseline: listifyProfileValue(supplied.social_baseline || extractProfileSection(content, PROFILE_SECTION_LABELS.social_baseline)),
    safe_appearance: listifyProfileValue(supplied.safe_appearance || extractProfileSection(content, PROFILE_SECTION_LABELS.safe_appearance)),
    knowledge_baseline: listifyProfileValue(supplied.knowledge_baseline || extractProfileSection(content, PROFILE_SECTION_LABELS.knowledge_baseline)),
    era_states: Array.isArray(supplied.era_states)
      ? supplied.era_states.map(item => ({ ...item }))
      : extractEraStates(content, title, keys)
  };

  // 即使调用方直接传入 profile，也必须再次净化所有可进入提示词的字段。
  for (const key of [
    'personality_core', 'values', 'goals', 'weaknesses', 'speech_style', 'mannerisms',
    'behavior_bounds', 'combat_temperament', 'social_baseline',
    'safe_appearance', 'knowledge_baseline'
  ]) {
    safeProfile[key] = safeProfile[key]
      .map(item => sanitizeWorldbookContent(item, { title, keys }).content)
      .filter(Boolean);
  }
  safeProfile.era_states = safeProfile.era_states
    .map(item => ({
      label: String(item?.label || '').trim(),
      from: item?.from == null ? null : String(item.from),
      until: item?.until == null ? null : String(item.until),
      content: sanitizeWorldbookContent(item?.content || '', { title, keys }).content
    }))
    .filter(item => item.label && item.content);
  return safeProfile;
}

function normalizeValidity(validity, content) {
  const parsed = parseLegacyValidity(content);
  if (!validity || typeof validity !== 'object') return parsed;
  return {
    from: validity.from == null ? null : String(validity.from),
    until: validity.until == null ? null : String(validity.until),
    precision: ALLOWED_PRECISIONS.has(validity.precision) ? validity.precision : parsed.precision,
    source_text: validity.source_text == null ? parsed.source_text : String(validity.source_text)
  };
}

function normalizeKnowledge(knowledge, { sourceKind = 'builtin' } = {}) {
  const supplied = knowledge && typeof knowledge === 'object' ? knowledge : {};
  const isTrustedCustom = sourceKind === 'custom';
  const visibility = isTrustedCustom
    ? 'public'
    : (ALLOWED_VISIBILITIES.has(supplied.visibility) ? supplied.visibility : 'public');
  const defaultAudience = visibility === 'public'
    ? [...WORLD_BOOK_V2_AUDIENCES]
    : ['narrator', 'reviewer', 'planner'];
  return {
    visibility,
    audience: uniqueStrings(supplied.audience?.length ? supplied.audience : defaultAudience)
      .filter(item => ALLOWED_AUDIENCES.has(item)),
    reveal_conditions: Array.isArray(supplied.reveal_conditions)
      ? supplied.reveal_conditions.map(item => typeof item === 'string' ? item.trim() : item).filter(Boolean)
      : []
  };
}

export function normalizeWorldbookEntryV2(input, options = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const title = normalizeWorldbookTitle(raw.title || options.title || '未命名世界书条目');
  const rawKeys = uniqueStrings(raw.keys || []);
  const sourceKind = String(options.sourceKind || raw.source?.kind || raw.source || 'builtin');
  const rawContent = String(raw.content || '');
  const sanitized = sanitizeWorldbookContent(rawContent, { title, keys: rawKeys });
  const keys = sanitizeKeys(rawKeys, `${title}\n${rawContent}`);
  const category = normalizeCategory(options.category || raw.category || 'reference');
  const isCharacter = category === 'character' || category === 'character_profile' || Boolean(raw.character_profile);
  const defaultEntityIds = isCharacter ? [buildStableEntityId(title)].filter(Boolean) : [];
  const entityIds = uniqueStrings(raw.entity_ids?.length ? raw.entity_ids : defaultEntityIds);
  const isTrustedCustom = sourceKind === 'custom';
  const activation = normalizeWorldbookActivation({ ...raw, keys });
  const status = isTrustedCustom && !['disabled', 'quarantined'].includes(raw.status)
    ? 'legacy_trusted_public'
    : (ALLOWED_STATUSES.has(raw.status) ? raw.status : 'active');
  const id = String(raw.id || options.id || buildStableWorldbookId(title, category));

  const normalized = {
    id,
    schema_version: WORLD_BOOK_V2_SCHEMA_VERSION,
    title,
    keys,
    category,
    enabled: isWorldbookEntryEnabled(raw),
    status,
    priority: Math.max(0, Math.min(100, Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 50)),
    activation,
    validity: normalizeValidity(raw.validity, rawContent),
    knowledge: normalizeKnowledge(raw.knowledge, { sourceKind }),
    entity_ids: entityIds,
    organization_ids: uniqueStrings(raw.organization_ids || []),
    content: sanitized.content,
    character_profile: null,
    source: {
      kind: sourceKind,
      file: String(options.sourceFile || raw.source?.file || ''),
      export_name: String(options.exportName || raw.source?.export_name || ''),
      entry_index: Number.isInteger(options.sourceIndex)
        ? options.sourceIndex
        : (Number.isInteger(raw.source?.entry_index) ? raw.source.entry_index : null)
    },
    safety: {
      runtime_safe: true,
      sanitized: sanitized.changed,
      minor_context: sanitized.minor_context,
      removed_fragment_count: sanitized.removed_fragments.length,
      reasons: sanitized.reasons,
      removed_fragment_hashes: sanitized.removed_fragments.map(item => item.fragment_hash)
    }
  };

  if (isCharacter) {
    normalized.character_profile = normalizeProfile(raw.character_profile, {
      title,
      keys,
      content: normalized.content,
      entityIds
    });
  }
  if (Array.isArray(raw.source_fragments)) normalized.source_fragments = raw.source_fragments;
  if (raw.migration && typeof raw.migration === 'object') normalized.migration = { ...raw.migration };
  return normalized;
}

function validateStringArray(value, path, errors, allowed = null) {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`);
    return;
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !item.trim()) errors.push(`${path}[${index}]: expected non-empty string`);
    if (seen.has(item)) errors.push(`${path}[${index}]: duplicate value`);
    seen.add(item);
    if (allowed && !allowed.has(item)) errors.push(`${path}[${index}]: unsupported value ${item}`);
  }
}

export function validateWorldbookEntryV2(entry, { runtime = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { valid: false, errors: ['entry: expected object'], warnings };
  }
  if (entry.schema_version !== WORLD_BOOK_V2_SCHEMA_VERSION) errors.push('schema_version: expected 2.0');
  if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) errors.push('id: invalid stable V2 id');
  if (typeof entry.title !== 'string' || !entry.title.trim()) errors.push('title: expected non-empty string');
  validateStringArray(entry.keys, 'keys', errors);
  if (typeof entry.category !== 'string' || !entry.category.trim()) errors.push('category: expected non-empty string');
  if (typeof entry.enabled !== 'boolean') errors.push('enabled: expected boolean');
  if (!ALLOWED_STATUSES.has(entry.status)) errors.push(`status: unsupported value ${entry.status}`);
  if (!Number.isFinite(entry.priority) || entry.priority < 0 || entry.priority > 100) errors.push('priority: expected number from 0 to 100');

  if (!entry.activation || typeof entry.activation !== 'object') {
    errors.push('activation: expected object');
  } else {
    if (!ALLOWED_ACTIVATION_MODES.has(entry.activation.mode)) errors.push(`activation.mode: unsupported value ${entry.activation.mode}`);
    validateStringArray(entry.activation.keys, 'activation.keys', errors);
  }

  if (!entry.validity || typeof entry.validity !== 'object') {
    errors.push('validity: expected object');
  } else {
    for (const field of ['from', 'until']) {
      const value = entry.validity[field];
      if (value !== null && (typeof value !== 'string' || !DATE_KEY_RE.test(value))) {
        errors.push(`validity.${field}: expected Konoha date key or null`);
      }
    }
    if (!ALLOWED_PRECISIONS.has(entry.validity.precision)) errors.push(`validity.precision: unsupported value ${entry.validity.precision}`);
    if (entry.validity.from && entry.validity.until && compareWorldbookDates(entry.validity.from, entry.validity.until) >= 0) {
      errors.push('validity: from must be earlier than until');
    }
  }

  if (!entry.knowledge || typeof entry.knowledge !== 'object') {
    errors.push('knowledge: expected object');
  } else {
    if (!ALLOWED_VISIBILITIES.has(entry.knowledge.visibility)) errors.push(`knowledge.visibility: unsupported value ${entry.knowledge.visibility}`);
    validateStringArray(entry.knowledge.audience, 'knowledge.audience', errors, ALLOWED_AUDIENCES);
    if (!Array.isArray(entry.knowledge.reveal_conditions)) errors.push('knowledge.reveal_conditions: expected array');
  }

  validateStringArray(entry.entity_ids, 'entity_ids', errors);
  validateStringArray(entry.organization_ids, 'organization_ids', errors);
  if (typeof entry.content !== 'string') errors.push('content: expected string');
  if (!entry.source || typeof entry.source !== 'object') errors.push('source: expected object');
  if (!entry.safety || typeof entry.safety !== 'object') errors.push('safety: expected object');

  const safety = inspectWorldbookRuntimeSafety(entry.content, { title: entry.title, keys: entry.keys });
  if (!safety.safe) errors.push(`content: ${safety.violations.length} unsafe runtime fragment(s)`);
  if (entry.character_profile) {
    const profile = entry.character_profile;
    if (typeof profile.entity_id !== 'string' || !profile.entity_id.trim()) {
      errors.push('character_profile.entity_id: expected non-empty string');
    }
    for (const field of [
      'names', 'aliases', 'personality_core', 'values', 'goals', 'weaknesses',
      'speech_style', 'mannerisms', 'behavior_bounds', 'combat_temperament',
      'social_baseline', 'safe_appearance', 'knowledge_baseline'
    ]) {
      validateStringArray(profile[field], `character_profile.${field}`, errors);
    }
    if (typeof profile.phase_label !== 'string') errors.push('character_profile.phase_label: expected string');
    if (!Array.isArray(profile.era_states)) {
      errors.push('character_profile.era_states: expected array');
    } else {
      for (const [index, state] of profile.era_states.entries()) {
        if (!state || typeof state !== 'object') {
          errors.push(`character_profile.era_states[${index}]: expected object`);
          continue;
        }
        if (typeof state.label !== 'string' || !state.label.trim()) errors.push(`character_profile.era_states[${index}].label: expected non-empty string`);
        if (typeof state.content !== 'string' || !state.content.trim()) errors.push(`character_profile.era_states[${index}].content: expected non-empty string`);
        for (const field of ['from', 'until']) {
          if (state[field] !== null && (typeof state[field] !== 'string' || !DATE_KEY_RE.test(state[field]))) {
            errors.push(`character_profile.era_states[${index}].${field}: expected Konoha date key or null`);
          }
        }
      }
    }
    const profileSafety = inspectWorldbookRuntimeSafety(JSON.stringify(entry.character_profile), {
      title: entry.title,
      keys: entry.keys
    });
    if (!profileSafety.safe) errors.push(`character_profile: ${profileSafety.violations.length} unsafe runtime fragment(s)`);
  }
  if (entry.safety?.runtime_safe !== true) errors.push('safety.runtime_safe: expected true');
  if (runtime && ('source_fragments' in entry || 'migration' in entry)) {
    errors.push('runtime entry: migration provenance must not be exposed');
  }
  if (entry.category === 'character_profile' && !entry.character_profile) {
    warnings.push('character_profile: missing structured profile');
  }
  return { valid: errors.length === 0, errors, warnings };
}

function parseComparableDate(value) {
  const match = String(value || '').match(/^K(-?\d+)-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
}

export function compareWorldbookDates(left, right) {
  const a = parseComparableDate(left);
  const b = parseComparableDate(right);
  if (a == null || b == null) return String(left).localeCompare(String(right));
  return a - b;
}

export function isWorldbookEntryValidAt(entry, date) {
  if (!date) return true;
  const current = typeof date === 'number' ? formatKonohaDate(date) : String(date);
  if (!DATE_KEY_RE.test(current)) return false;
  if (entry.validity?.from && compareWorldbookDates(current, entry.validity.from) < 0) return false;
  if (entry.validity?.until && compareWorldbookDates(current, entry.validity.until) >= 0) return false;
  return true;
}

function cloneRuntimeProfile(profile, date = null) {
  if (!profile) return null;
  const runtime = Object.fromEntries(Object.entries(profile).map(([key, value]) => [
    key,
    Array.isArray(value)
      ? value.map(item => item && typeof item === 'object' ? { ...item } : item)
      : value
  ]));
  // 时代状态往往记录了角色未来遭遇甚至死亡。没有合法当前日期时宁可不注入
  // 阶段状态；有日期时也只保留此刻有效的状态，避免早期角色读到未来履历。
  const current = typeof date === 'number' ? formatKonohaDate(date) : String(date || '');
  runtime.era_states = DATE_KEY_RE.test(current)
    ? (runtime.era_states || []).filter(state => (
        (!state.from || compareWorldbookDates(state.from, current) <= 0)
        && (!state.until || compareWorldbookDates(current, state.until) < 0)
      ))
    : [];
  return runtime;
}

export function toRuntimeWorldbookEntry(entry, { audience = 'writer', date = null } = {}) {
  if (!entry?.enabled || entry.status === 'disabled' || entry.status === 'quarantined') return null;
  if (!entry.knowledge?.audience?.includes(audience)) return null;
  if (!isWorldbookEntryValidAt(entry, date)) return null;
  const runtime = {
    id: entry.id,
    schema_version: entry.schema_version,
    title: entry.title,
    keys: [...entry.keys],
    category: entry.category,
    enabled: entry.enabled,
    status: entry.status,
    priority: entry.priority,
    activation: normalizeWorldbookActivation(entry),
    validity: { ...entry.validity },
    knowledge: {
      visibility: entry.knowledge.visibility,
      audience: [...entry.knowledge.audience],
      reveal_conditions: entry.knowledge.reveal_conditions.map(item =>
        item && typeof item === 'object' ? { ...item } : item
      )
    },
    entity_ids: [...entry.entity_ids],
    organization_ids: [...entry.organization_ids],
    content: entry.content,
    character_profile: cloneRuntimeProfile(entry.character_profile, date),
    source: { kind: entry.source.kind },
    safety: {
      runtime_safe: true,
      sanitized: Boolean(entry.safety.sanitized),
      removed_fragment_count: Number(entry.safety.removed_fragment_count || 0)
    }
  };
  const validation = validateWorldbookEntryV2(runtime, { runtime: true });
  if (!validation.valid) {
    throw new Error(`Unsafe or invalid runtime worldbook entry ${entry.id}: ${validation.errors.join('; ')}`);
  }
  return runtime;
}
