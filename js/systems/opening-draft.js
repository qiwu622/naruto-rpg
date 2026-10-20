import { GAME_DATA } from '../data/game-data.js';
import {
  calculateCombatLevel,
  combatMasteriesFromAbilities,
  combatMasteriesFromPlayerState
} from './combat-level.js';

export { calculateCombatLevel, combatMasteriesFromAbilities };

export const OPENING_DRAFT_VERSION = 3;
export const START_PRESET_V1_KEY = 'naruto_start_preset_v1';
export const START_PRESET_V2_KEY = 'naruto_start_preset_v2';

export const OPENING_DIFFICULTIES = Object.freeze([
  { id: 'relaxed', label: '轻松', description: '更宽松的判定与资源压力，侧重剧情推进' },
  { id: 'standard', label: '标准', description: '风险、成长与资源消耗保持均衡' },
  { id: 'hard', label: '困难', description: '敌人更主动，失败代价更明显' },
  { id: 'brutal', label: '残酷', description: '情报、伤势与资源管理都更严苛' },
  { id: 'legendary', label: '传说', description: '高压忍界，重大决策可能永久改变局势' }
]);

export const AI_COMPLETION_MODES = Object.freeze([
  { id: 'strict', label: '严格档案', description: '只使用已填写内容，不补充角色能力与资产' },
  { id: 'fill', label: '补全空白', description: '只补未填写的类别，绝不覆盖玩家条目' },
  { id: 'expand', label: '自由扩写', description: '可补充相容细节，但玩家填写内容仍是最高事实' }
]);

export const OFFICIAL_RANKS = Object.freeze([
  '无正式忍阶',
  ...Object.keys(GAME_DATA.rankBenchmarks)
]);

const BASE_DRAFT = {
  version: OPENING_DRAFT_VERSION,
  templateId: 'academy',
  identity: {
    name: '',
    physicalAge: 12,
    soulAge: 12,
    gender: '男性',
    bodySetting: '男性身体',
    presentation: '男性化',
    address: '他 / 君',
    appearance: '',
    personality: '',
    background: '木叶平民',
    publicIdentity: '忍校学生',
    secrets: ''
  },
  campaign: {
    timeline: 'konoha_59',
    customYear: 59,
    month: 1,
    day: 1,
    affiliation: '木叶隐村',
    location: '木叶忍者学校',
    difficulty: 'standard',
    goal: '通过毕业考核，成为正式忍者',
    canonInvolvement: '平行参与',
    storyTone: '成长与羁绊',
    storyFocus: '任务、修行、队友关系',
    openingHook: '毕业考核前夕，一份被临时更换的名单打乱了所有安排。',
    aiCompletionMode: 'fill'
  },
  power: {
    officialRank: '忍校学生',
    combatLevel: 'E级',
    attributes: { chakra: 60, vitality: 140, spirit: 45, stamina: 100, speed: 35, luck: 15 },
    chakraNatures: ['火']
  },
  resources: { ryo: 500 },
  talents: [],
  abilities: [],
  equipment: [],
  relationships: []
};

const TEMPLATE_DATA = {
  academy: {
    label: '忍校学生',
    eyebrow: '从第一枚护额开始',
    description: '适合成长、同窗关系与毕业考核开局。',
    accent: '#e15b3d',
    draft: {
      identity: { physicalAge: 12, soulAge: 12, background: '木叶平民', publicIdentity: '忍校学生' },
      campaign: { timeline: 'konoha_59', affiliation: '木叶隐村', location: '木叶忍者学校', goal: '通过毕业考核，成为正式忍者', storyTone: '成长与羁绊', storyFocus: '忍校生活、修行、同窗关系', openingHook: '毕业考核前夕，一份被临时更换的名单打乱了所有安排。' },
      power: { officialRank: '忍校学生', combatLevel: 'E级', attributes: { chakra: 60, vitality: 140, spirit: 45, stamina: 100, speed: 35, luck: 15 }, chakraNatures: ['火'] },
      talents: [{ type: 'talent', name: '努力的天才', rank: '基础', mastery: 20, description: '依靠稳定训练积累优势。', limitations: '没有血继或特殊资源。' }],
      abilities: [
        { type: 'jutsu', name: '分身术', rank: 'E', element: '无', cost: 8, power: 0, mastery: 25, description: '制造没有实体的分身。', limitations: '只能用于干扰视线。' },
        { type: 'taijutsu', name: '忍校基础体术', rank: 'E', element: '无', cost: 3, power: 12, mastery: 30, description: '基础架势、闪避与投掷衔接。', limitations: '' }
      ],
      equipment: [
        { category: 'tools', name: '练习苦无', quantity: 3, quality: '普通', description: '忍校配发的练习忍具。', equippedSlot: 'accessory1' },
        { category: 'consumables', name: '绷带', quantity: 2, quality: '普通', description: '简单处理擦伤。', equippedSlot: '' }
      ]
    }
  },
  genin_team: {
    label: '新晋下忍',
    eyebrow: '第一次小队集合',
    description: '已获得护额，从带队上忍与首个任务开始。',
    accent: '#d8a34b',
    draft: {
      identity: { physicalAge: 13, soulAge: 13, background: '木叶忍者家族', publicIdentity: '木叶下忍' },
      campaign: { timeline: 'konoha_64', affiliation: '木叶隐村', location: '第三演习场', goal: '通过带队上忍的生存演习', storyTone: '小队冒险', storyFocus: '任务、战术协作、队友羁绊', openingHook: '新小队第一次集合，迟到的带队上忍只留下了一张演习通知。' },
      power: { officialRank: '下忍', combatLevel: 'C级', attributes: { chakra: 110, vitality: 210, spirit: 85, stamina: 170, speed: 60, luck: 22 }, chakraNatures: ['火'] },
      abilities: [
        { type: 'jutsu', name: '替身术', rank: 'E', element: '无', cost: 12, power: 0, mastery: 55, description: '在受击前用附近物体替换本体。', limitations: '需要预判与可用替身物。' },
        { type: 'jutsu', name: '变身术', rank: 'E', element: '无', cost: 8, power: 0, mastery: 50, description: '改变外表用于伪装。', limitations: '受击或专注中断时容易解除。' }
      ],
      equipment: [
        { category: 'tools', name: '苦无', quantity: 5, quality: '普通', description: '标准制式苦无。', equippedSlot: 'accessory1' },
        { category: 'tools', name: '手里剑', quantity: 8, quality: '普通', description: '标准制式手里剑。', equippedSlot: 'accessory2' },
        { category: 'consumables', name: '兵粮丸', quantity: 2, quality: '普通', description: '短时补充体力。', equippedSlot: '' }
      ]
    }
  },
  chunin: {
    label: '中忍行动员',
    eyebrow: '独立带队与现场判断',
    description: '从边境任务、情报护送或小队指挥开始。',
    accent: '#3f9a78',
    draft: {
      identity: { physicalAge: 19, soulAge: 19, background: '职业忍者', publicIdentity: '木叶中忍' },
      campaign: { timeline: 'konoha_64', affiliation: '木叶隐村', location: '木叶任务集会所', difficulty: 'hard', goal: '查明一支失联巡逻队的下落', canonInvolvement: '边缘交汇', storyTone: '任务与悬疑', storyFocus: '带队、侦查、忍村政治', openingHook: '一份原定为 C 级的搜救委托，被情报班悄悄换成了封口卷轴。' },
      power: { officialRank: '中忍', combatLevel: 'B级', attributes: { chakra: 230, vitality: 330, spirit: 180, stamina: 280, speed: 95, luck: 32 }, chakraNatures: ['火', '风'] },
      talents: [{ type: 'talent', name: '现场指挥', rank: '熟练', mastery: 68, description: '能快速拆分任务并调整队形。', limitations: '错误情报会显著降低判断质量。' }],
      equipment: [
        { category: 'weapons', name: '制式查克拉短刀', quantity: 1, quality: '精良', description: '可传导查克拉的短刃。', equippedSlot: 'weapon' },
        { category: 'tools', name: '起爆符', quantity: 6, quality: '普通', description: '标准爆破忍具。', equippedSlot: 'accessory1' }
      ]
    }
  },
  anbu: {
    label: '暗部行动员',
    eyebrow: '面具后的命令',
    description: '适合潜入、清除、护卫与高层暗线。',
    accent: '#8b7cb7',
    draft: {
      identity: { physicalAge: 24, soulAge: 24, background: '暗部体系', publicIdentity: '木叶普通上忍' },
      campaign: { timeline: 'konoha_59', affiliation: '木叶隐村·暗部', location: '火影岩下暗部集结室', difficulty: 'brutal', goal: '在天亮前确认密令真伪', canonInvolvement: '深度交汇', storyTone: '冷峻谍战', storyFocus: '潜入、秘密身份、忠诚冲突', openingHook: '面具内侧出现了不属于暗部制式的第二道密令。' },
      power: { officialRank: '上忍', combatLevel: 'A级', attributes: { chakra: 520, vitality: 590, spirit: 430, stamina: 510, speed: 165, luck: 38 }, chakraNatures: ['雷', '风'] },
      talents: [{ type: 'talent', name: '暗部之姿', rank: '精通', mastery: 88, description: '擅长潜入、追踪与无声协作。', limitations: '公开身份与真实任务必须严格隔离。' }],
      equipment: [
        { category: 'weapons', name: '暗部忍刀', quantity: 1, quality: '优秀', description: '适合狭窄环境快速拔刀。', equippedSlot: 'weapon' },
        { category: 'armor', name: '暗部轻甲', quantity: 1, quality: '精良', description: '兼顾隐蔽与要害防护。', equippedSlot: 'armor' },
        { category: 'tools', name: '暗部面具', quantity: 1, quality: '精良', description: '遮蔽身份的制式面具。', equippedSlot: 'accessory1' }
      ]
    }
  },
  missing_nin: {
    label: '叛忍逃亡者',
    eyebrow: '通缉令已经上路',
    description: '从追捕、旧债与不可公开的真相开始。',
    accent: '#b84b53',
    draft: {
      identity: { physicalAge: 26, soulAge: 26, background: '前忍村行动员', publicIdentity: '流浪商旅', secrets: '真实身份已被原忍村列入通缉册。' },
      campaign: { timeline: 'konoha_67', affiliation: '无所属', location: '川之国边境驿站', difficulty: 'brutal', goal: '甩开追踪并找到通缉令背后的签发者', canonInvolvement: '边缘交汇', storyTone: '逃亡与阴谋', storyFocus: '追捕、身份伪装、灰色交易', openingHook: '驿站墙上的新通缉令用了一个只有旧队友知道的名字。' },
      power: { officialRank: '无正式忍阶', combatLevel: 'A级', attributes: { chakra: 480, vitality: 540, spirit: 400, stamina: 480, speed: 150, luck: 30 }, chakraNatures: ['水', '雷'] },
      equipment: [
        { category: 'weapons', name: '无铭忍刀', quantity: 1, quality: '精良', description: '磨掉了所有村落标记。', equippedSlot: 'weapon' },
        { category: 'consumables', name: '易容药膏', quantity: 3, quality: '优秀', description: '短时间改变面部细节。', equippedSlot: '' }
      ]
    }
  },
  wanderer: {
    label: '无所属浪忍',
    eyebrow: '边界之外没有护额',
    description: '自由决定来历、路线与与各村的距离。',
    accent: '#6e9a8f',
    draft: {
      identity: { physicalAge: 22, soulAge: 22, background: '流浪忍者', publicIdentity: '旅行忍者' },
      campaign: { timeline: 'konoha_52', affiliation: '无所属', location: '火之国北部商道', goal: '寻找一处可以暂时落脚的地方', canonInvolvement: '完全原创', storyTone: '公路冒险', storyFocus: '探索、委托、地方势力', openingHook: '暴雨冲垮商道后，一只装着忍村机密的信鹰落在了营火旁。' },
      power: { officialRank: '无正式忍阶', combatLevel: 'B级', attributes: { chakra: 260, vitality: 360, spirit: 200, stamina: 300, speed: 105, luck: 42 }, chakraNatures: ['土', '风'] },
      equipment: [
        { category: 'weapons', name: '旅行短刀', quantity: 1, quality: '普通', description: '兼作野外工具。', equippedSlot: 'weapon' },
        { category: 'tools', name: '旅行斗笠', quantity: 1, quality: '普通', description: '遮雨并隐藏面容。', equippedSlot: 'accessory1' }
      ]
    }
  },
  bloodline_heir: {
    label: '血继家族继承人',
    eyebrow: '家名既是庇护也是枷锁',
    description: '围绕家族责任、继承权和血继秘密展开。',
    accent: '#c96f87',
    draft: {
      identity: { physicalAge: 16, soulAge: 16, background: '水无月一族（雪之一族）', publicIdentity: '家族继承候补', secrets: '血继能力仍存在一次未公开的异常觉醒。' },
      campaign: { timeline: 'konoha_59', affiliation: '雾隐村', location: '水之国·水无月一族隐居地', difficulty: 'hard', goal: '通过族内继承试炼并查明异常觉醒原因', canonInvolvement: '平行参与', storyTone: '家族政治', storyFocus: '血继修行、继承权、秘密盟友', openingHook: '封存多年的族谱在继承仪式前夜自行翻到了被撕去的一页。' },
      power: { officialRank: '下忍', combatLevel: 'B级', attributes: { chakra: 310, vitality: 330, spirit: 290, stamina: 310, speed: 100, luck: 28 }, chakraNatures: ['水', '风', '冰遁'] },
      talents: [{ type: 'kekkei_genkai', name: '冰遁', rank: '初醒', mastery: 48, description: '融合水与风形成冰晶。', limitations: '情绪失控时精度明显下降。' }],
      equipment: [{ category: 'tools', name: '家族封印坠饰', quantity: 1, quality: '优秀', description: '抑制血继暴走的家传忍具。', equippedSlot: 'accessory1' }]
    }
  },
  scientific: {
    label: '科学忍具路线',
    eyebrow: '战后的新忍者',
    description: '研究、试验任务与传统忍术冲突并行。',
    accent: '#4c9fb6',
    draft: {
      identity: { physicalAge: 20, soulAge: 20, background: '科学忍具研究班', publicIdentity: '忍具测试员' },
      campaign: { timeline: 'konoha_72', affiliation: '木叶隐村·研究班', location: '科学忍具研究所', difficulty: 'standard', goal: '完成新型查克拉模块的首次实战测试', canonInvolvement: '边缘交汇', storyTone: '战后革新', storyFocus: '技术试验、产业冲突、和平时代任务', openingHook: '封存中的原型模块在没有操作者的情况下记录到了一次查克拉反应。' },
      power: { officialRank: '中忍', combatLevel: 'B级', attributes: { chakra: 240, vitality: 300, spirit: 260, stamina: 280, speed: 90, luck: 45 }, chakraNatures: ['雷'] },
      talents: [{ type: 'talent', name: '忍具工程', rank: '熟练', mastery: 72, description: '能诊断、改装并临场维护科学忍具。', limitations: '依赖备件与能源。' }],
      equipment: [
        { category: 'weapons', name: '查克拉脉冲刃', quantity: 1, quality: '优秀', description: '可调节输出的实验短刃。', equippedSlot: 'weapon' },
        { category: 'tools', name: '原型查克拉模块', quantity: 1, quality: '史诗', description: '尚未完成安全认证。', equippedSlot: 'accessory1' }
      ]
    }
  },
  custom: {
    label: '空白自定义',
    eyebrow: '从一张白纸开始',
    description: '不套用身份、阵营或能力限制。',
    accent: '#9b9388',
    draft: {
      identity: { physicalAge: 18, soulAge: 18, gender: '', bodySetting: '', presentation: '', address: '', background: '', publicIdentity: '' },
      campaign: { timeline: 'konoha_52', affiliation: '', location: '', goal: '', canonInvolvement: '自定义', storyTone: '', storyFocus: '', openingHook: '' },
      power: { officialRank: '', combatLevel: '', attributes: { chakra: 100, vitality: 200, spirit: 100, stamina: 160, speed: 60, luck: 20 }, chakraNatures: [] },
      resources: { ryo: 0 }, talents: [], abilities: [], equipment: [], relationships: []
    }
  }
};

export const OPENING_TEMPLATES = Object.freeze(Object.entries(TEMPLATE_DATA).map(([id, template]) => ({
  id,
  label: template.label,
  eyebrow: template.eyebrow,
  description: template.description,
  accent: template.accent
})));

const SKILL_CATEGORY_CN = { jutsu: '忍术', taijutsu: '体术', genjutsu: '幻术', support: '支援' };
const ITEM_CATEGORY_CN = { weapons: '武器', armor: '防具', tools: '道具', consumables: '消耗品' };
const DIFFICULTY_V1_MAP = { '忍者学校': 'relaxed', '下忍': 'standard', '中忍': 'hard', '上忍': 'brutal', '影': 'legendary' };
const DIFFICULTY_LABEL = Object.fromEntries(OPENING_DIFFICULTIES.map(item => [item.id, item.label]));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function number(value, fallback = 0, min = 0, max = 9999) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function deepMerge(base, override) {
  if (Array.isArray(override)) return clone(override);
  if (!override || typeof override !== 'object') return override === undefined ? clone(base) : override;
  const result = base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(result[key], value)
      : clone(value);
  }
  return result;
}

function normalizeTalent(entry = {}) {
  return {
    type: entry.type === 'kekkei_genkai' ? 'kekkei_genkai' : 'talent',
    name: text(entry.name),
    rank: text(entry.rank, '未定'),
    mastery: number(entry.mastery, 0, 0, 100),
    description: text(entry.description),
    limitations: text(entry.limitations)
  };
}

export const CUSTOM_TALENT_PLACEHOLDER = '自定义天赋组合';

export function isCustomTalentPlaceholder(value) {
  return text(value) === CUSTOM_TALENT_PLACEHOLDER;
}

export function parseCustomTalentDescription(value) {
  const source = text(value);
  if (!source) return [];
  const matches = [...source.matchAll(/(?:^|\s)(\d+)[.．、]\s*([^：:。；;]+)[：:]\s*([\s\S]*?)(?=(?:\s+\d+[.．、])|$)/g)];
  if (matches.length) {
    return matches.map(match => ({
      type: 'talent',
      name: text(match[2]),
      rank: '自创',
      mastery: 0,
      description: text(match[3]).replace(/[。；;]+$/, ''),
      limitations: ''
    })).filter(item => item.name);
  }
  const named = source.match(/^([^：:。；;]{2,24})[：:]\s*([\s\S]+)$/);
  return named ? [{
    type: 'talent', name: text(named[1]), rank: '自创', mastery: 0,
    description: text(named[2]), limitations: ''
  }] : [];
}

function expandCustomTalentPlaceholders(entries) {
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isCustomTalentPlaceholder(entry?.name)) {
      result.push(entry);
      continue;
    }
    const parsed = parseCustomTalentDescription(entry?.description);
    if (parsed.length) result.push(...parsed);
    else result.push(entry);
  }
  return result;
}

function normalizeAbility(entry = {}) {
  const allowed = ['jutsu', 'taijutsu', 'genjutsu', 'support'];
  const type = allowed.includes(entry.type) ? entry.type : 'jutsu';
  const rankText = text(entry.rank, 'E').toUpperCase();
  const rank = rankText === '特' ? '特' : (rankText.match(/[EDCBAS]/)?.[0] || 'D');
  const resourceType = text(entry.resourceType || entry.resource_type || entry.resource,
    type === 'genjutsu' ? '精神力' : type === 'taijutsu' ? '体力' : '查克拉');
  const normalized = {
    type,
    name: text(entry.name),
    rank,
    element: text(entry.element, '无'),
    cost: number(entry.cost, 0, 0, 9999),
    resourceType,
    power: number(entry.power, 0),
    mastery: number(entry.mastery, 0, 0, 100),
    description: text(entry.description),
    limitations: text(entry.limitations)
  };
  const techniqueId = text(entry.technique_id || entry.techniqueId);
  const source = text(entry.source);
  if (techniqueId) normalized.technique_id = techniqueId;
  if (source) normalized.source = source;
  return normalized;
}

function normalizeEquipment(entry = {}) {
  const allowed = ['weapons', 'armor', 'tools', 'consumables'];
  return {
    category: allowed.includes(entry.category) ? entry.category : 'tools',
    name: text(entry.name),
    quantity: Math.max(1, Math.round(number(entry.quantity, 1, 1, Infinity))),
    quality: text(entry.quality, '普通'),
    description: text(entry.description),
    equippedSlot: ['weapon', 'armor', 'accessory1', 'accessory2'].includes(entry.equippedSlot) ? entry.equippedSlot : ''
  };
}

function normalizeRelationship(entry = {}) {
  return {
    name: text(entry.name),
    relation: text(entry.relation),
    publicHistory: text(entry.publicHistory),
    secret: text(entry.secret),
    affection: number(entry.affection, 0, -100, 100),
    trust: number(entry.trust, 0, -100, 100),
    respect: number(entry.respect, 0, -100, 100)
  };
}

export function createOpeningDraft(templateId = 'academy', overrides = {}) {
  const resolvedId = TEMPLATE_DATA[templateId] ? templateId : 'academy';
  const templateDraft = TEMPLATE_DATA[resolvedId].draft || {};
  return normalizeOpeningDraft(deepMerge(deepMerge(BASE_DRAFT, { templateId: resolvedId }), deepMerge(templateDraft, overrides)));
}

export function applyOpeningTemplate(currentDraft = {}, templateId = 'academy') {
  const preserved = {
    identity: {
      name: currentDraft.identity?.name || '',
      gender: currentDraft.identity?.gender,
      bodySetting: currentDraft.identity?.bodySetting,
      presentation: currentDraft.identity?.presentation,
      address: currentDraft.identity?.address,
      appearance: currentDraft.identity?.appearance,
      personality: currentDraft.identity?.personality,
      secrets: currentDraft.identity?.secrets
    },
    campaign: {
      month: currentDraft.campaign?.month,
      day: currentDraft.campaign?.day,
      aiCompletionMode: currentDraft.campaign?.aiCompletionMode || 'fill'
    }
  };
  for (const group of Object.values(preserved)) {
    for (const key of Object.keys(group)) if (group[key] === undefined) delete group[key];
  }
  return createOpeningDraft(templateId, preserved);
}

export function normalizeOpeningDraft(input = {}) {
  const source = clone(input && typeof input === 'object' ? input : {});
  const legacyAttributes = source.power?.attributes;
  if (Number(source.version) < 3 && legacyAttributes && !('vitality' in legacyAttributes)) {
    const oldVitality = legacyAttributes.stamina;
    const oldStamina = legacyAttributes.willpower;
    legacyAttributes.vitality = oldVitality;
    legacyAttributes.stamina = oldStamina;
    delete legacyAttributes.willpower;
  }
  const merged = deepMerge(BASE_DRAFT, source);
  const difficulty = OPENING_DIFFICULTIES.some(item => item.id === merged.campaign?.difficulty)
    ? merged.campaign.difficulty : (DIFFICULTY_V1_MAP[merged.campaign?.difficulty] || 'standard');
  const mode = AI_COMPLETION_MODES.some(item => item.id === merged.campaign?.aiCompletionMode)
    ? merged.campaign.aiCompletionMode : 'fill';
  const officialRankRaw = text(merged.power?.officialRank);
  const officialRank = OFFICIAL_RANKS.includes(officialRankRaw) ? officialRankRaw : '无正式忍阶';
  const attributes = merged.power?.attributes || {};
  const normalizedAttributes = {
    chakra: number(attributes.chakra, 10),
    vitality: number(attributes.vitality, 100),
    spirit: number(attributes.spirit, 10),
    stamina: number(attributes.stamina, 80),
    speed: number(attributes.speed, 5),
    luck: number(attributes.luck, 10)
  };
  const normalizedAbilities = (Array.isArray(merged.abilities) ? merged.abilities : [])
    .map(normalizeAbility)
    .filter(item => item.name);
  return {
    version: OPENING_DRAFT_VERSION,
    templateId: TEMPLATE_DATA[merged.templateId] ? merged.templateId : 'custom',
    identity: {
      name: text(merged.identity?.name),
      physicalAge: Math.round(number(merged.identity?.physicalAge, 12, 0, 999)),
      soulAge: Math.round(number(merged.identity?.soulAge, 12, 0, 9999)),
      gender: text(merged.identity?.gender),
      bodySetting: text(merged.identity?.bodySetting),
      presentation: text(merged.identity?.presentation),
      address: text(merged.identity?.address),
      appearance: text(merged.identity?.appearance),
      personality: text(merged.identity?.personality),
      background: text(merged.identity?.background),
      publicIdentity: text(merged.identity?.publicIdentity),
      secrets: text(merged.identity?.secrets)
    },
    campaign: {
      timeline: text(merged.campaign?.timeline, 'konoha_52'),
      customYear: Math.round(number(merged.campaign?.customYear, 52, 1, 9999)),
      month: Math.round(number(merged.campaign?.month, 1, 1, 12)),
      day: Math.round(number(merged.campaign?.day, 1, 1, 30)),
      affiliation: text(merged.campaign?.affiliation),
      location: text(merged.campaign?.location),
      difficulty,
      goal: text(merged.campaign?.goal),
      canonInvolvement: text(merged.campaign?.canonInvolvement),
      storyTone: text(merged.campaign?.storyTone),
      storyFocus: text(merged.campaign?.storyFocus),
      openingHook: text(merged.campaign?.openingHook),
      aiCompletionMode: mode
    },
    power: {
      officialRank,
      combatLevel: calculateCombatLevel(normalizedAttributes, combatMasteriesFromAbilities(normalizedAbilities)),
      attributes: normalizedAttributes,
      chakraNatures: [...new Set((Array.isArray(merged.power?.chakraNatures) ? merged.power.chakraNatures : String(merged.power?.chakraNatures || '').split(/[,，、]/)).map(item => text(item)).filter(Boolean))]
    },
    resources: { ryo: Math.round(number(merged.resources?.ryo, 500, 0, 999999999)) },
    talents: expandCustomTalentPlaceholders(merged.talents).map(normalizeTalent).filter(item => item.name),
    abilities: normalizedAbilities,
    equipment: (Array.isArray(merged.equipment) ? merged.equipment : []).map(normalizeEquipment).filter(item => item.name),
    relationships: (Array.isArray(merged.relationships) ? merged.relationships : []).map(normalizeRelationship).filter(item => item.name)
  };
}

function migrateGender(value, customValue = '') {
  if (value === '女性') return { gender: '女性', bodySetting: '女性身体', presentation: '女性化', address: '她 / 酱', publicIdentity: '少女' };
  if (value === '伪娘') return { gender: '男性', bodySetting: '男性身体', presentation: '女性化', address: '她 / 酱', publicIdentity: '少女' };
  if (value === '假小子') return { gender: '女性', bodySetting: '女性身体', presentation: '男性化', address: '他 / 君', publicIdentity: '少年' };
  if (value === '扶她') return { gender: '双性', bodySetting: '双性身体', presentation: '自由呈现', address: '自定义', publicIdentity: '旅行者' };
  if (value === '__custom_gender__') {
    const custom = text(customValue, '自定义');
    return { gender: custom, bodySetting: custom, presentation: custom, address: '自定义', publicIdentity: custom };
  }
  return { gender: '男性', bodySetting: '男性身体', presentation: '男性化', address: '他 / 君', publicIdentity: '少年' };
}

export function migrateStartPresetV1(saved = {}) {
  const choices = saved?.choices || {};
  const gender = migrateGender(choices.gender, choices.customGender);
  const background = choices.background === '__custom_background__'
    ? choices.customBackground || {}
    : GAME_DATA.getBackground(choices.background || '平民出身');
  const oldAttrs = saved.attrs || choices.attributes || { chakra: 5, spirit: 5, willpower: 5, speed: 5, luck: 5 };
  const directAttrs = GAME_DATA.buildInitialAttributes(oldAttrs);
  const timeline = choices.timeline || 'konoha_52';
  const timelinePreset = GAME_DATA.getTimelinePreset(timeline);
  const customTalents = choices.talent === '__custom_talent__'
    ? parseCustomTalentDescription(choices.customTalent?.description)
    : [];
  const talent = choices.talent === '__custom_talent__'
    ? null
    : choices.talent && choices.talent !== '__no_talent__'
      ? { type: 'talent', name: choices.talent, rank: '初始', mastery: 20, description: GAME_DATA.getTalent(choices.talent)?.description || '', limitations: '' }
      : null;
  const abilityText = text(choices.customSkill?.description);
  const draft = createOpeningDraft('custom', {
    identity: {
      name: text(choices.name),
      physicalAge: 12,
      soulAge: 12,
      ...gender,
      appearance: '',
      personality: text(choices.persona),
      background: text(background?.id || background?.name, '平民出身'),
      publicIdentity: gender.publicIdentity,
      secrets: ''
    },
    campaign: {
      timeline,
      customYear: number(choices.customTimelineYear, timelinePreset?.year || 52, 1, 9999),
      affiliation: /流浪|无所属/.test(text(background?.id || background?.name)) ? '无所属' : '木叶隐村',
      location: text(background?.location, '木叶隐村'),
      difficulty: DIFFICULTY_V1_MAP[choices.difficulty] || 'standard',
      goal: '开始新的忍者生涯',
      canonInvolvement: '平行参与',
      storyTone: '忍者冒险',
      storyFocus: '任务、成长、羁绊',
      openingHook: '',
      aiCompletionMode: 'fill'
    },
    power: {
      officialRank: '忍校学生',
      combatLevel: 'E级',
      attributes: directAttrs,
      chakraNatures: choices.chakraNature || ['火']
    },
    resources: { ryo: Number(background?.ryo) || 500 },
    talents: customTalents.length ? customTalents
      : choices.talent === '__custom_talent__' && text(choices.customTalent?.description)
        ? [{ type: 'talent', name: CUSTOM_TALENT_PLACEHOLDER, rank: '待生成', mastery: 0, description: text(choices.customTalent.description), limitations: '' }]
        : talent ? [talent] : [],
    abilities: abilityText ? [{ type: 'jutsu', name: '自定义初始能力组合', rank: '特', element: '无', cost: 0, power: 0, mastery: 100, description: abilityText, limitations: '' }] : [],
    equipment: []
  });

  for (const [category, items] of Object.entries(background?.equipment || {})) {
    for (const [name, item] of Object.entries(items || {})) {
      draft.equipment.push(normalizeEquipment({ category, name, ...item }));
    }
  }
  return normalizeOpeningDraft(draft);
}

export function loadOpeningPreset(storage) {
  if (!storage) return { draft: createOpeningDraft(), migrated: false, loaded: false };
  try {
    const v2 = JSON.parse(storage.getItem(START_PRESET_V2_KEY) || 'null');
    if (Number(v2?.version) >= 2 && Number(v2?.version) <= OPENING_DRAFT_VERSION) {
      return { draft: normalizeOpeningDraft(v2.draft || v2), migrated: Number(v2.version) < OPENING_DRAFT_VERSION, loaded: true };
    }
    const v1 = JSON.parse(storage.getItem(START_PRESET_V1_KEY) || 'null');
    if (v1?.choices) return { draft: migrateStartPresetV1(v1), migrated: true, loaded: true };
  } catch (error) {
    console.warn('[OpeningDraft] Failed to load opening preset:', error.message);
  }
  return { draft: createOpeningDraft(), migrated: false, loaded: false };
}

export function serializeOpeningPreset(draft) {
  return {
    version: OPENING_DRAFT_VERSION,
    saved_at: new Date().toISOString(),
    draft: normalizeOpeningDraft(draft)
  };
}

function timelineValues(draft) {
  const preset = GAME_DATA.timelinePresets[draft.campaign.timeline] || GAME_DATA.timelinePresets.konoha_52;
  const year = draft.campaign.timeline === '__custom_timeline__' ? draft.campaign.customYear : (preset?.year || draft.campaign.customYear || 52);
  return { preset, year, month: draft.campaign.month || 1, day: draft.campaign.day || 1 };
}

function descriptionWithLimit(entry) {
  return [entry.description, entry.limitations ? `限制：${entry.limitations}` : ''].filter(Boolean).join('\n');
}

export function buildOpeningState(input, baseState = {}) {
  const draft = normalizeOpeningDraft(input);
  const state = clone(baseState);
  const { preset, year, month, day } = timelineValues(draft);
  const attrs = draft.power.attributes;
  const rank = draft.power.officialRank || '无正式忍阶';

  Object.assign(state, {
    '玩家·姓名': draft.identity.name,
    '玩家·年龄': draft.identity.physicalAge,
    '玩家·灵魂年龄': draft.identity.soulAge,
    '玩家·性别': draft.identity.gender,
    '玩家·忍阶': rank,
    '玩家·正式忍阶': rank,
    '玩家·战力等级': draft.power.combatLevel || '未评定',
    '玩家·所属村': draft.campaign.affiliation || '无所属',
    '玩家·出身': draft.identity.background || '未公开',
    '玩家·查克拉属性': draft.power.chakraNatures,
    '玩家·难度': DIFFICULTY_LABEL[draft.campaign.difficulty] || '标准',
    '玩家·个性': draft.identity.personality,
    '玩家·公开身份': draft.identity.publicIdentity || '身份未公开',
    '玩家·当前目标': draft.campaign.goal,
    '玩家·声望标签': draft.identity.publicIdentity || rank,
    '玩家·存活': '是',
    '玩家·死因': '',
    '属性·查克拉': attrs.chakra,
    '属性·当前查克拉': attrs.chakra,
    '属性·生命力': attrs.vitality,
    '属性·当前生命力': attrs.vitality,
    '属性·精神力': attrs.spirit,
    '属性·当前精神力': attrs.spirit,
    '属性·体力': attrs.stamina,
    '属性·当前体力': attrs.stamina,
    '属性·速度': attrs.speed,
    '属性·幸运': attrs.luck,
    '进度·经验': 0,
    '进度·下一级经验': 100,
    '进度·忍术熟练度': Math.max(0, ...draft.abilities.filter(item => item.type === 'jutsu').map(item => item.mastery)),
    '进度·体术熟练度': Math.max(0, ...draft.abilities.filter(item => item.type === 'taijutsu').map(item => item.mastery)),
    '进度·幻术熟练度': Math.max(0, ...draft.abilities.filter(item => item.type === 'genjutsu').map(item => item.mastery)),
    '进度·防御熟练度': Math.round((attrs.vitality + attrs.stamina) / 20),
    '进度·已完成任务': 0,
    '进度·突破待处理': 0,
    '进度·金钱': draft.resources.ryo,
    '进度·称号': draft.identity.publicIdentity || rank,
    '世界·地点': draft.campaign.location || draft.campaign.affiliation || '未知地点',
    '世界·年代': `木叶${year}年`,
    '世界·时间': `木叶${year}年${month}月${day}日·清晨`,
    '世界·月份': month,
    '世界·天气': '晴',
    '系统·回合数': 0,
    '系统·当前节点': null,
    '系统·当前分支': 'branch_main'
  });

  for (const talent of draft.talents) {
    const category = talent.type === 'kekkei_genkai' ? '血继限界' : '天赋';
    const base = `技能·${category}·${talent.name}`;
    state[`${base}·名称`] = talent.name;
    state[`${base}·等级`] = talent.rank;
    state[`${base}·熟练度`] = talent.mastery;
    state[`${base}·描述`] = descriptionWithLimit(talent);
  }
  for (const ability of draft.abilities) {
    const category = SKILL_CATEGORY_CN[ability.type] || '忍术';
    const base = `技能·${category}·${ability.name}`;
    state[`${base}·名称`] = ability.name;
    state[`${base}·等级`] = ability.rank;
    state[`${base}·属性`] = ability.element;
    state[`${base}·消耗`] = ability.cost;
    state[`${base}·消耗资源`] = ability.resourceType;
    state[`${base}·威力`] = ability.power;
    state[`${base}·熟练度`] = ability.mastery;
    state[`${base}·描述`] = descriptionWithLimit(ability);
    state[`${base}·类型`] = category;
    if (ability.technique_id) state[`${base}·数据库ID`] = ability.technique_id;
    if (ability.source) state[`${base}·来源`] = ability.source;
  }
  for (const item of draft.equipment) {
    const category = ITEM_CATEGORY_CN[item.category] || '道具';
    const base = `物品·${category}·${item.name}`;
    state[`${base}·数量`] = item.quantity;
    state[`${base}·品质`] = item.quality;
    state[`${base}·描述`] = item.description;
  }

  state._relationships = {};
  for (const relation of draft.relationships) {
    const time = state['世界·时间'];
    state._relationships[relation.name] = {
      affection: relation.affection,
      trust: relation.trust,
      respect: relation.respect,
      role: relation.relation,
      info: relation.publicHistory,
      pinned: true,
      status: 'active',
      tags: ['初始羁绊'],
      history: relation.publicHistory ? [{ turn: 0, time, summary: relation.publicHistory }] : [],
      inner_thoughts: relation.secret ? [{ turn: 0, time, summary: relation.secret }] : []
    };
  }

  state._memory = state._memory || {};
  state._memory.recent_summary = preset?.era_summary ? `[开局时代] ${preset.era_summary}` : '';
  state._memory.facts = [
    draft.campaign.openingHook ? `开场钩子: ${draft.campaign.openingHook}` : '',
    draft.identity.secrets ? `玩家秘密: ${draft.identity.secrets}` : ''
  ].filter(Boolean).join('\n');
  return state;
}

export function collectOpeningStateRepairs(state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return [];
  const turn = Number(state['系统·回合数'] ?? state?._meta?.turn_count ?? 0);
  if (state?._meta?.current_node_id) return [];
  if (Number.isFinite(turn) && turn > 1) return [];

  const contract = state._opening_contract;
  if (!contract || Number(contract.version) < 2 || !contract.raw) return [];

  const repairs = [];
  const addMissing = (key, value) => {
    const current = state[key];
    if ((current !== undefined && current !== null && current !== '') || value === undefined) return;
    repairs.push({ key, op: '=', value: clone(value) });
  };

  for (const rawTalent of Array.isArray(contract.raw.talents) ? contract.raw.talents : []) {
    const talent = normalizeTalent(rawTalent);
    if (!talent.name || isCustomTalentPlaceholder(talent.name)) continue;
    const category = talent.type === 'kekkei_genkai' ? '血继限界' : '天赋';
    const base = `技能·${category}·${talent.name}`;
    addMissing(`${base}·名称`, talent.name);
    addMissing(`${base}·等级`, talent.rank);
    addMissing(`${base}·熟练度`, talent.mastery);
    addMissing(`${base}·描述`, descriptionWithLimit(talent));
  }

  for (const rawAbility of Array.isArray(contract.raw.abilities) ? contract.raw.abilities : []) {
    const ability = normalizeAbility(rawAbility);
    if (!ability.name) continue;
    const category = SKILL_CATEGORY_CN[ability.type] || '忍术';
    const base = `技能·${category}·${ability.name}`;
    addMissing(`${base}·名称`, ability.name);
    addMissing(`${base}·等级`, ability.rank);
    addMissing(`${base}·属性`, ability.element);
    addMissing(`${base}·消耗`, ability.cost);
    addMissing(`${base}·消耗资源`, ability.resourceType);
    addMissing(`${base}·威力`, ability.power);
    addMissing(`${base}·熟练度`, ability.mastery);
    addMissing(`${base}·描述`, descriptionWithLimit(ability));
    addMissing(`${base}·类型`, category);
    if (ability.technique_id) addMissing(`${base}·数据库ID`, ability.technique_id);
    if (ability.source) addMissing(`${base}·来源`, ability.source);
  }

  return repairs;
}

export function initializeOpeningRuntime(input, { stateManager, equipmentSystem, createOpeningContract } = {}) {
  if (!stateManager || !equipmentSystem || !createOpeningContract) throw new Error('Opening runtime dependencies are required');
  const draft = normalizeOpeningDraft(input);
  const state = buildOpeningState(draft, stateManager.getDefaultState());
  stateManager.restore(state);

  for (const item of draft.equipment.filter(entry => entry.equippedSlot)) {
    equipmentSystem.equip(item.equippedSlot, item.name, item.category);
  }

  const equippedState = stateManager.get();
  const finalAttributes = {
    chakra: equippedState['属性·查克拉'],
    vitality: equippedState['属性·生命力'],
    stamina: equippedState['属性·体力'],
    spirit: equippedState['属性·精神力'],
    speed: equippedState['属性·速度'],
    luck: equippedState['属性·幸运']
  };
  const finalCombatLevel = calculateCombatLevel(finalAttributes, combatMasteriesFromPlayerState(equippedState));
  stateManager.update([{ key: '玩家·战力等级', op: '=', value: finalCombatLevel }]);

  const initialized = stateManager.snapshot();
  const contractDraft = normalizeOpeningDraft({
    ...draft,
    power: { ...draft.power, attributes: finalAttributes }
  });
  const contract = createOpeningContract({ choices: contractDraft, state: initialized });
  stateManager.setSub('_opening_contract', contract);
  return stateManager.get();
}
