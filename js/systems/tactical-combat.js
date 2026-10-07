import { getMasteryTier } from '../data/game-data.js';

// Pure combat rules. The caller commits the returned patch with the story, once.
export const TACTICAL_RULES_VERSION = 'tactical-v1';
const POWER = { E: 8, D: 16, C: 34, B: 62, A: 105, S: 180 };
const RESOURCE = { 查克拉: 'chakra', 体力: 'stamina', 精神力: 'spirit' };
const PLAYER_KEYS = { vitality: '属性·当前生命力', chakra: '属性·当前查克拉', stamina: '属性·当前体力', spirit: '属性·当前精神力' };
const STATUS_NAMES = { burn: '灼伤', bind: '束缚', stagger: '失衡', observe: '洞察', guard: '戒备', substitute: '替身准备', clone: '分身牵制', barrier: '防护', genjutsu: '幻术干扰', advantage: '先机' };
const NEGATIVE = new Set(['burn', 'bind', 'stagger', 'genjutsu']);
const clone = value => JSON.parse(JSON.stringify(value ?? null));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback = 0) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : fallback;
const first = (source, ...keys) => keys.map(key => source?.[key]).find(value => value !== undefined && value !== null && value !== '');
const array = value => Array.isArray(value) ? value : [];
const combatOf = state => state?._combat && typeof state._combat === 'object' ? state._combat : state?.combat || {};
function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) result = Math.imul(result ^ char.codePointAt(0), 16777619);
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  return (result ^ result >>> 16) >>> 0;
}
const roll = (seed, label) => (hash(`${seed}|${label}`) + 0.5) / 4294967296;
const percentage = value => clamp(number(value, 100) <= 1 && number(value, 100) > 0 ? number(value) * 100 : number(value, 100), 0, 100);
const normalizeName = value => String(value || '').replace(/[\s·:：]/g, '');

function categoryOf(value) {
  const raw = String(value || '忍术');
  if (/体|taijutsu/i.test(raw)) return '体术';
  if (/幻|genjutsu/i.test(raw)) return '幻术';
  if (/支援|辅助|变化|support/i.test(raw)) return '变化';
  return '忍术';
}
function resourceOf(value, category) {
  const raw = String(value || '');
  if (/体力|stamina/.test(raw)) return '体力';
  if (/精神|spirit/.test(raw)) return '精神力';
  if (/查克拉|chakra/.test(raw)) return '查克拉';
  return category === '体术' ? '体力' : category === '幻术' ? '精神力' : '查克拉';
}
function elementOf(value) {
  return ({ fire: '火', wind: '风', lightning: '雷', earth: '土', water: '水' })[value] || String(value || '无').replace(/遁$/, '');
}
function effectOf(effect) {
  if (!effect || typeof effect !== 'object') return null;
  const id = String(effect.id || effect.status || '');
  if (!STATUS_NAMES[id]) return null;
  return { id, chance: percentage(first(effect, 'chance', 'probability') ?? 100), turns: clamp(number(effect.turns, 2), 1, 5), target: effect.target === 'self' ? 'self' : 'enemy', potency: clamp(number(effect.potency, 1), 0, 2) };
}
function normalizeMove(raw = {}, name, category, id) {
  category = categoryOf(first(raw, '类型', 'type') || category);
  name = String(first(raw, '名称', 'name') || name || '未命名招式');
  const rank = String(first(raw, '等级', 'rank') || 'D').match(/[EDCBAS]/i)?.[0]?.toUpperCase() || 'D';
  const mastery = clamp(number(first(raw, '熟练度', 'mastery'), 30), 0, 100);
  const explicit = first(raw, '基础威力', 'basePower', 'base_power', '威力', 'power');
  const source = first(raw, '来源', 'source');
  let power = Math.max(0, number(explicit, POWER[rank]));
  let powerSource = explicit === undefined ? 'rank-base' : 'stored-base';
  const basis = raw._power_basis;
  if (first(raw, '基础威力', 'basePower', 'base_power') === undefined && basis
    && number(basis.displayed, -1) === power && number(basis.base, -1) >= 0) {
    power = number(basis.base);
    powerSource = 'normalized-base';
  }
  // Numeric coincidence cannot establish provenance: an explicitly edited power is
  // always a base value. Recover legacy multiplication only with an explicit marker.
  if (source !== 'canon' && first(raw, '基础威力', 'basePower', 'base_power') === undefined
    && powerSource !== 'normalized-base' && explicit !== undefined && (raw.power_includes_mastery === true || raw.威力已含熟练修正 === true)) {
    power /= getMasteryTier(mastery).power_multiplier;
    powerSource = 'legacy-marked-recovered';
  }
  let kind = power > 0 && category !== '变化' ? 'attack' : 'maneuver';
  if (/替身/.test(name)) kind = 'substitute';
  else if (/分身/.test(name)) kind = 'clone';
  else if (/土流壁|水阵壁|结界|防护|护盾/.test(name)) kind = 'barrier';
  else if (/医疗|掌仙|治愈/.test(name)) kind = 'heal';
  else if (/束缚|影子模仿|水牢/.test(name) || category === '幻术' && power === 0) kind = 'control';
  if (['substitute', 'clone', 'barrier', 'heal', 'maneuver', 'control'].includes(kind)) power = 0;
  const element = elementOf(first(raw, '属性', 'element'));
  const explicitEffects = array(first(raw, '效果', 'effects')).map(effectOf).filter(Boolean);
  const effects = explicitEffects.length ? explicitEffects : kind === 'attack' && element === '火'
    ? [{ id: 'burn', chance: 20, turns: 3, target: 'enemy', potency: 1 }]
    : category === '幻术' ? [{ id: 'genjutsu', chance: 100, turns: 2, target: 'enemy', potency: 1 }]
      : /束缚|影子模仿|水牢/.test(name) ? [{ id: 'bind', chance: 100, turns: 2, target: 'enemy', potency: 1 }] : [];
  return {
    id, name, category, rank, element, power, basePower: power, powerSource, mastery,
    accuracy: percentage(first(raw, '命中率', 'accuracy') ?? (kind === 'attack' ? 90 : 100)),
    priority: clamp(number(first(raw, '先制', 'priority'), kind === 'substitute' ? 2 : kind === 'barrier' ? 1 : 0), -3, 3),
    resource: resourceOf(first(raw, '消耗资源', 'resource_type', 'resource'), category),
    cost: Math.max(0, number(first(raw, '消耗', 'cost'), category === '变化' ? 0 : 1)),
    description: String(first(raw, '描述', '说明', 'description') || '依据招式、攻防与战场状态判定。'),
    range: first(raw, '射程', 'range') || (category === '体术' ? '近' : '中远'),
    kind, effects
  };
}
function collectSkills(state) {
  const records = new Map();
  const groupMap = { jutsu: '忍术', taijutsu: '体术', genjutsu: '幻术', support: '支援', 忍术: '忍术', 体术: '体术', 幻术: '幻术', 支援: '支援' };
  for (const [group, entries] of Object.entries(state?.skills || state?.技能 || {})) {
    if (!groupMap[group]) continue;
    for (const [name, value] of Object.entries(entries || {})) {
      if (value && typeof value === 'object') records.set(`${groupMap[group]}:${value.name || value.名称 || name}`, { ...value, _name: value.name || value.名称 || name, _group: groupMap[group] });
    }
  }
  for (const [key, value] of Object.entries(state || {})) {
    const match = key.match(/^技能·(忍术|体术|幻术|支援)·(.+)·([^·]+)$/u);
    if (!match) continue;
    const [, group, name, field] = match;
    const id = `${group}:${name}`;
    records.set(id, { ...(records.get(id) || {}), _name: name, _group: group, [field]: value });
  }
  return [...records.entries()].map(([id, raw]) => normalizeMove(raw, raw._name, raw._group, `skill:${id}`));
}
function inventoryMoves(state) {
  const records = new Map();
  const groupMap = { tools: '道具', consumables: '消耗品', weapons: '武器', 道具: '道具', 消耗品: '消耗品', 忍具: '忍具', 武器: '武器', 食物: '食物' };
  for (const [group, entries] of Object.entries(state?.equipment || state?.inventory || state?.物品 || {})) {
    if (!groupMap[group]) continue;
    for (const [name, value] of Object.entries(entries || {})) {
      if (value && typeof value === 'object') records.set(`${groupMap[group]}:${name}`, { ...value, _group: groupMap[group], _name: name });
    }
  }
  for (const [key, value] of Object.entries(state || {})) {
    const match = key.match(/^物品·(道具|消耗品|忍具|武器|食物)·(.+)·([^·]+)$/u);
    if (!match) continue;
    const [, group, name, field] = match;
    const id = `${group}:${name}`;
    records.set(id, { ...(records.get(id) || {}), _name: name, _group: group, [field]: value });
  }
  return [...records.entries()].flatMap(([id, raw]) => {
    const name = raw._name;
    const quantity = Math.max(0, number(first(raw, '数量', 'quantity')));
    const kind = /兵粮|军粮|补充查克拉/.test(name) ? 'restore' : /药|绷带|医疗/.test(name) ? 'heal'
      : /烟雾/.test(name) ? 'smoke' : /苦无|手里剑|千本|起爆/.test(name) ? 'attack' : null;
    if (!kind) return [];
    return [{ id: `item:${id}`, name, category: '忍具', kind: 'item', itemKind: kind, element: /起爆/.test(name) ? '火' : '无', power: kind === 'attack' ? number(first(raw, '威力', 'power'), /起爆/.test(name) ? 32 : 14) : 0,
      mastery: 60, accuracy: kind === 'attack' ? 92 : 100, priority: kind === 'smoke' ? 1 : 0, resource: null, cost: 0, quantity,
      inventoryKey: `物品·${raw._group}·${name}·数量`, range: '中远', effects: [], description: String(first(raw, '描述', 'description') || '消耗背包中的 1 个物品。') }];
  });
}
function baseMoves() {
  return [
    { id: 'basic:attack', name: '基础体术', category: '体术', kind: 'attack', power: 12, resource: '体力', cost: 2, accuracy: 95, range: '近', description: '接近目标，以基础体术攻击。远距离时先完成接近。' },
    { id: 'basic:guard', name: '戒备防御', kind: 'guard', priority: 2, description: '本回合受到的伤害减少 45%。连续防御的效果逐步下降。' },
    { id: 'basic:observe', name: '观察破绽', kind: 'observe', description: '观察敌方招式，获得持续至下回合的命中与暴击优势。' },
    { id: 'basic:feint', name: '佯攻', kind: 'feint', accuracy: 90, resource: '体力', cost: 2, description: '不造成直接伤害；成功使目标失衡，降低其闪避与防护。' },
    { id: 'basic:improvise', name: '自由战术', kind: 'maneuver', accuracy: 80, resource: '体力', cost: 2, description: '尝试走位、利用地形或制造先机；不凭空施展未掌握的术。' },
    { id: 'basic:retreat', name: '撤离', kind: 'retreat', accuracy: 70, priority: 0, description: '尝试脱离战斗；速度、束缚与烟雾影响成功率。失败后仍可能遭到攻击。' }
  ].map(move => ({ category: '变化', element: '无', power: 0, mastery: 60, accuracy: 100, priority: 0, resource: null, cost: 0, effects: [], range: '任意', ...move }));
}
function statusesOf(combat, actor) {
  const source = combat[`${actor}_statuses`] || [...array(combat[`${actor}_buffs`]), ...array(combat[`${actor}_debuffs`])];
  return array(source).flatMap(item => {
    if (!item || typeof item !== 'object' || !STATUS_NAMES[item.id]) return [];
    return [{ ...clone(item), name: STATUS_NAMES[item.id], turns: Math.max(0, number(item.turns, 1)) }];
  }).filter(item => item.turns > 0);
}
function actorOf(state, actor, combat = combatOf(state)) {
  const enemy = actor === 'enemy';
  const a = state?.attributes || {};
  const p = state?.progression || {};
  const stat = (name, cn, fallback) => enemy ? number(combat[`enemy_${name}`], fallback) : number(state?.[`属性·${cn}`], number(a[name], fallback));
  const max = (name, cn, fallback) => enemy ? number(combat[`enemy_${name}_max`], number(combat[`enemy_${name}`], fallback)) : stat(name, cn, fallback);
  const result = { id: actor, name: enemy ? combat.enemy_name || '对手' : state?.['玩家·姓名'] || state?.player?.name || '你', statuses: statusesOf(combat, actor) };
  for (const [name, cn, fallback] of [['vitality', '生命力', 100], ['chakra', '查克拉', 30], ['stamina', '体力', 80], ['spirit', '精神力', 30]]) {
    result[`${name}Max`] = Math.max(0, max(name, cn, fallback));
    result[name] = clamp(enemy ? number(combat[`enemy_${name}`], result[`${name}Max`]) : number(state?.[`属性·当前${cn}`], number(a[`${name}_current`], result[`${name}Max`])), 0, result[`${name}Max`]);
  }
  result.speed = Math.max(1, stat('speed', '速度', 10));
  result.luck = clamp(stat('luck', '幸运', 10), 0, 100);
  for (const [key, cn, compat] of [['ninjutsu', '忍术', 'jutsu_mastery'], ['taijutsu', '体术', 'taijutsu_mastery'], ['genjutsu', '幻术', 'genjutsu_mastery']]) {
    result[key] = clamp(enemy ? number(combat[`enemy_${key}`], 30) : number(state?.[`进度·${cn}熟练度`], number(p[compat], 30)), 0, 100);
  }
  const defenseMastery = enemy ? number(combat.enemy_defense_mastery) : number(state?.['进度·防御熟练度'], number(p.defense_mastery));
  result.defense = Math.sqrt(result.vitalityMax) * 1.8 + Math.sqrt(result.staminaMax) * 1.2 + clamp(defenseMastery, 0, 100) * 0.15;
  return result;
}
const has = (actor, id) => actor.statuses.find(status => status.id === id && status.turns > 0);
const isKnown = combat => combat.enemy_known === true || ['known', 'full'].includes(combat.enemy_intel);
function availableMove(move, actor) {
  const enough = move.kind === 'item' ? move.quantity > 0 : !move.resource || actor[RESOURCE[move.resource]] >= move.cost;
  return { ...move, available: enough, reason: enough ? '' : move.kind === 'item' ? '背包数量不足' : `${move.resource}不足，勉强施术效果会减弱` };
}
export function listTacticalMoves(state = {}) {
  const actor = actorOf(state, 'player');
  return [...collectSkills(state), ...inventoryMoves(state), ...baseMoves()].map(move => availableMove(move, actor));
}
function enemyMoves(combat, actor) {
  const techniques = Array.isArray(combat.enemy_jutsu) ? combat.enemy_jutsu : Object.values(combat.enemy_jutsu || {});
  const skills = techniques.map((raw, index) => normalizeMove(raw, raw?.名称 || raw?.name || `招式${index + 1}`, raw?.类型 || raw?.type, `enemy:${raw?.名称 || raw?.name || index}`));
  return [...skills, ...baseMoves().filter(move => !['retreat', 'maneuver'].includes(move.kind))].map(move => availableMove(move, actor));
}
function accuracyFor(move, attacker, defender, combat) {
  if (['guard', 'observe', 'substitute', 'clone', 'barrier', 'heal'].includes(move.kind) || move.kind === 'item' && move.itemKind !== 'attack') return 100;
  let chance = move.accuracy + (move.mastery - 60) * 0.1;
  if (has(attacker, 'observe')) chance += 12;
  if (has(attacker, 'advantage')) chance += 8;
  if (has(attacker, 'bind') || has(attacker, 'genjutsu')) chance -= 15;
  if (has(defender, 'stagger')) chance += 12;
  if (has(defender, 'clone')) chance -= 15 * number(has(defender, 'clone').potency, 1);
  if (move.kind === 'retreat') chance += clamp((attacker.speed - defender.speed) * 0.4, -25, 25) + (has(attacker, 'advantage') ? 15 : 0) - (has(attacker, 'bind') ? 25 : 0);
  if (move.kind === 'attack' || move.itemKind === 'attack') {
    if (combat.distance === '远' && move.range === '近') chance -= 20;
    if (combat.environment?.[`${defender.id}_cover`] || (defender.id === 'enemy' && combat.environment?.cover === true)) chance -= 15;
  }
  return clamp(Math.round(chance), move.accuracy === 0 ? 0 : 5, 100);
}
function matchup(element, shieldElement) {
  const strong = { 火: '风', 风: '雷', 雷: '土', 土: '水', 水: '火' };
  return strong[element] === shieldElement ? 1.5 : strong[shieldElement] === element ? 0.65 : 1;
}
function damageBase(move, attacker, defender) {
  if (!move.power) return 0;
  const physical = move.category === '体术' || move.category === '忍具';
  const illusion = move.category === '幻术';
  const offense = physical ? 16 + Math.sqrt(attacker.staminaMax) * 3 + attacker.taijutsu * 0.5
    : illusion ? 16 + Math.sqrt(attacker.spiritMax) * 4 + attacker.genjutsu * 0.5
      : 16 + Math.sqrt(attacker.chakraMax) * 3 + Math.sqrt(attacker.spiritMax) + attacker.ninjutsu * 0.5;
  const defense = physical ? defender.defense : illusion ? 20 + Math.sqrt(defender.spiritMax) * 3 + defender.genjutsu * 0.35
    : 20 + Math.sqrt(defender.chakraMax) * 2 + Math.sqrt(defender.spiritMax) + defender.ninjutsu * 0.25;
  let amount = move.power * (0.45 + clamp(offense / Math.max(1, defense), 0.2, 3) * 0.55) * getMasteryTier(move.mastery).power_multiplier;
  if (has(defender, 'stagger')) amount *= 1.15;
  if (has(attacker, 'burn') && physical) amount *= 0.9;
  const guard = has(defender, 'guard');
  if (guard) amount *= 1 - guard.potency;
  const barrier = has(defender, 'barrier');
  // Chakra nature is never a creature weakness. Only an actual active barrier is matched.
  if (barrier) amount *= 1 - (1 - clamp(0.5 * matchup(move.element, barrier.element), 0.3, 0.8)) * clamp(number(barrier.potency, 1), 0, 1);
  return Math.max(1, amount);
}
export function previewTacticalAction(state = {}, moveId) {
  const combat = combatOf(state);
  const move = listTacticalMoves(state).find(item => item.id === moveId) || listTacticalMoves(state).find(item => item.id === 'basic:improvise');
  const attacker = actorOf(state, 'player');
  const defender = actorOf(state, 'enemy');
  const strength = move.resource && move.cost > 0 ? Math.min(1, attacker[RESOURCE[move.resource]] / move.cost) : move.kind === 'item' && move.quantity <= 0 ? 0 : 1;
  const approaching = move.range === '近' && combat.distance === '远' && move.kind === 'attack';
  const accuracy = strength <= 0 ? 0 : Math.round(accuracyFor(move, attacker, defender, combat) * (0.5 + strength * 0.5));
  const damage = approaching ? 0 : damageBase(move, attacker, defender) * strength;
  const known = isKnown(combat);
  const selfAction = ['guard', 'observe', 'substitute', 'clone', 'barrier', 'heal'].includes(move.kind) || move.kind === 'item' && move.itemKind !== 'attack';
  const resourceAccuracyFactor = strength <= 0 ? 0 : 0.5 + strength * 0.5;
  const unknownAccuracyRange = [Math.max(5, Math.floor((move.accuracy - 20) / 10) * 10), Math.min(100, move.accuracy + 10)]
    .map(value => Math.round(value * resourceAccuracyFactor));
  return { move, accuracy: known || selfAction ? accuracy : null, accuracyRange: known || selfAction ? [accuracy, accuracy] : unknownAccuracyRange,
    damageRange: known && damage > 0 ? [Math.max(1, Math.round(damage * 0.9)), Math.max(1, Math.round(damage * 1.1))] : null,
    known, approaching, strength, reason: move.reason, summary: !move.available ? move.reason : approaching ? '距离过远，本回合先接近目标，不造成直接伤害。' : selfAction ? move.description : known ? `预计命中 ${accuracy}%${damage ? '，普通命中伤害 ' + Math.round(damage * 0.9) + '–' + Math.round(damage * 1.1) : ''}` : '敌情尚不明确，实际命中和效果按交锋时的状态判定。' };
}
function chooseEnemy(moves, enemy, seed) {
  const candidates = moves.filter(move => move.available && (move.kind !== 'heal' || enemy.vitality < enemy.vitalityMax * 0.7));
  const weighted = candidates.map(move => ({ move, weight: move.kind === 'attack' ? 5 : move.kind === 'guard' ? (enemy.vitality < enemy.vitalityMax * 0.3 ? 3 : 0.7) : move.kind === 'observe' ? 0.5 : 1.5 }));
  let pick = roll(seed, 'enemy-choice') * weighted.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weighted) { pick -= item.weight; if (pick <= 0) return item.move; }
  return weighted.at(-1)?.move || baseMoves()[1];
}
function addStatus(actor, id, turns, turn, extra = {}) {
  actor.statuses = actor.statuses.filter(status => status.id !== id);
  actor.statuses.push({ id, name: STATUS_NAMES[id], turns, born_turn: turn, potency: 1, ...extra });
}
function resultPrompt(combat, receipt, text) {
  return ['【本回合战斗已结算】', `玩家原始声明：${text || receipt.player_move.name}`, `执行招式：${receipt.player_move.name}；对手已预先选择：${receipt.enemy_move.name}。`,
    ...receipt.events.map(event => event.message), combat.is_active ? '战斗继续，停在下一次玩家行动之前。' : `战斗结束：${combat.result === 'victory' ? '对手失去战斗能力' : combat.result === 'defeat' ? '玩家失去战斗能力' : '成功撤离'}。失去战斗能力不代表死亡。`,
    '请按所选预设写自然的战斗正文，只描写上述已发生结果。玩家战术可用于表现动作，但不能额外增加伤害、消耗、招式、状态、死亡或后续行动。不要在正文解释规则、概率或防御性提示；未选择的招式不算发生。'].join('\n');
}
export function resolveTacticalRound(state = {}, { moveId, actionId, text = '', seed } = {}) {
  const original = combatOf(state);
  const combat = clone(original);
  const combatId = String(combat.id || combat.combat_id || `combat:${hash(`${combat.enemy_name || ''}|${state['世界·时间'] || ''}`)}`);
  const id = String(actionId || `${combatId}:round:${number(combat.turn) + 1}`);
  if (combat.last_round?.action_id === id) {
    return { id, combatId, nextCombat: combat, updates: [], inventoryUpdates: [], events: clone(combat.last_round.events), prompt: resultPrompt(combat, combat.last_round, text || combat.last_round.action_text), actionText: text || combat.last_round.action_text, replayed: true };
  }
  const round = number(combat.turn) + 1;
  const randomSeed = `${seed ?? id}|${combatId}`;
  const player = actorOf(state, 'player', combat);
  const enemy = actorOf(state, 'enemy', combat);
  let selected = listTacticalMoves(state).find(move => move.id === moveId);
  const events = [];
  const emit = (type, actor, target, message, extra = {}) => events.push({ type, actor: actor.id, target: target?.id || actor.id, message, ...extra });
  if (!selected) {
    selected = baseMoves().find(move => move.id === 'basic:improvise');
    emit('adapted', player, player, '本次声明作为自由战术尝试，争取先机，不会凭空施展未掌握的招式。');
  }
  // Freeze both moves and all random draws before executing either side.
  const enemyMove = chooseEnemy(enemyMoves(combat, enemy), enemy, randomSeed);
  const selections = { player: selected, enemy: enemyMove };
  const rolls = Object.fromEntries(['player', 'enemy'].map(actor => [actor, { hit: roll(randomSeed, `${actor}:hit`) * 100, critical: roll(randomSeed, `${actor}:critical`) * 100, variance: roll(randomSeed, `${actor}:variance`), evade: roll(randomSeed, `${actor}:evade`) * 100, effects: selections[actor].effects.map((_, index) => roll(randomSeed, `${actor}:effect:${index}`) * 100) }]));
  const speed = actor => actor.speed * (has(actor, 'bind') ? 0.6 : 1);
  const order = [player, enemy].sort((a, b) => selections[b.id].priority - selections[a.id].priority || speed(b) - speed(a) || (roll(randomSeed, 'speed-tie') < 0.5 ? (a.id === 'player' ? -1 : 1) : (a.id === 'enemy' ? -1 : 1)));
  const inventoryUpdates = [];
  combat.id = combatId;
  combat.rules_version = TACTICAL_RULES_VERSION;
  combat.turn = round;
  combat.distance ||= '中';
  combat.is_active = true;
  combat.result = null;
  combat.state = 'player_turn';
  let escaped = false;
  for (const actor of order) {
    const target = actor.id === 'player' ? enemy : player;
    const move = selections[actor.id];
    const dice = rolls[actor.id];
    if (escaped || actor.vitality <= 0 || target.vitality <= 0) {
      emit('skipped', actor, target, `${actor.name}本回合未继续行动，交锋已经结束。`);
      continue;
    }
    if (move.kind === 'item' && move.quantity <= 0) {
      emit('unavailable', actor, actor, `${actor.name}没有剩余的${move.name}，本次准备未能产生效果。`);
      continue;
    }
    let strength = 1;
    let spent = 0;
    if (move.resource) {
      const key = RESOURCE[move.resource];
      spent = Math.min(actor[key], move.cost);
      strength = move.cost > 0 ? spent / move.cost : 1;
      actor[key] -= spent;
      if (strength < 1) emit('weakened', actor, actor, `${actor.name}${move.resource}不足，${move.name}只能完成${strength > 0 ? '弱化的一部分' : '准备动作'}。`, { resource: move.resource, spent, required: move.cost });
    }
    combat[`last_${actor.id}_resource`] = move.resource;
    combat[`last_${actor.id}_resource_cost`] = spent;
    combat[`last_${actor.id}_required_cost`] = move.cost;
    combat[`last_${actor.id}_chakra_cost`] = move.resource === '查克拉' ? spent : 0;
    if (move.kind === 'item') inventoryUpdates.push({ key: move.inventoryKey, op: '=', value: move.quantity - 1 });
    if (strength <= 0) continue;
    if (move.range === '近' && combat.distance === '远' && move.kind === 'attack') {
      combat.distance = '中';
      emit('approach', actor, target, `${actor.name}使用${move.name}接近目标，距离缩短；本回合尚未击中。`, { resource: move.resource, spent });
      continue;
    }
    const accuracy = Math.round(accuracyFor(move, actor, target, combat) * (0.5 + strength * 0.5));
    const hit = dice.hit < accuracy;
    if (!hit) {
      emit('miss', actor, target, `${actor.name}的${move.name}${move.kind === 'retreat' ? '未能脱离交锋' : '未成功'}。`, { move: move.name, accuracy, roll: dice.hit, resource: move.resource, spent });
      continue;
    }
    if (move.kind === 'retreat') { escaped = true; emit('retreat', actor, target, `${actor.name}抓住空隙，成功撤离战斗。`, { accuracy, roll: dice.hit }); continue; }
    if (move.kind === 'guard') {
      const previous = number(combat[`${actor.id}_guard_streak`]);
      combat[`${actor.id}_guard_streak`] = previous + 1;
      addStatus(actor, 'guard', 1, round, { potency: Math.max(0.15, 0.45 - previous * 0.1) * strength });
    } else combat[`${actor.id}_guard_streak`] = 0;
    if (move.kind === 'observe') addStatus(actor, 'observe', 2, round);
    if (move.kind === 'feint') addStatus(target, 'stagger', 2, round);
    if (move.kind === 'maneuver') addStatus(actor, 'advantage', 2, round, { potency: strength });
    if (move.kind === 'substitute') {
      const previous = combat.last_round?.[`${actor.id}_move`]?.kind === 'substitute';
      addStatus(actor, 'substitute', 1, round, { potency: (previous ? 0.4 : 0.8) * strength });
    }
    if (move.kind === 'clone') addStatus(actor, 'clone', 2, round, { potency: strength });
    if (move.kind === 'barrier') addStatus(actor, 'barrier', 2, round, { element: move.element, potency: strength });
    if (move.kind === 'heal' || move.kind === 'item' && move.itemKind === 'heal') {
      const restored = Math.min(actor.vitalityMax - actor.vitality, Math.max(1, Math.round(actor.vitalityMax * (move.kind === 'item' ? 0.2 : 0.15) * strength)));
      actor.vitality += restored;
      actor.statuses = actor.statuses.filter(status => status.id !== 'burn');
      emit('heal', actor, actor, `${actor.name}使用${move.name}，恢复 ${restored} 点生命力并处理灼伤。`, { healed: restored });
    } else if (move.kind === 'item' && move.itemKind === 'restore') {
      const restored = Math.min(actor.chakraMax - actor.chakra, Math.max(1, Math.round(actor.chakraMax * 0.25)));
      actor.chakra += restored;
      emit('restore', actor, actor, `${actor.name}使用${move.name}，恢复 ${restored} 点查克拉。`, { restored });
    } else if (move.kind === 'item' && move.itemKind === 'smoke') {
      addStatus(actor, 'advantage', 2, round);
      combat.distance = '远';
      emit('smoke', actor, actor, `${actor.name}使用${move.name}遮蔽视线，拉开距离并获得撤离先机。`);
    } else if (move.power > 0) {
      const substitute = has(target, 'substitute');
      if (substitute && dice.evade < substitute.potency * 100) {
        target.statuses = target.statuses.filter(status => status.id !== 'substitute');
        emit('evade', actor, target, `${target.name}以替身避开了${actor.name}的${move.name}。`, { accuracy, roll: dice.hit, evadeRoll: dice.evade });
        continue;
      }
      const criticalChance = clamp(5 + actor.luck * 0.03 + (has(actor, 'observe') ? 10 : 0), 5, 20);
      const critical = dice.critical < criticalChance;
      const damage = Math.min(target.vitality, Math.max(1, Math.round(damageBase(move, actor, target) * strength * (0.9 + dice.variance * 0.2) * (critical ? 1.4 : 1))));
      target.vitality -= damage;
      actor.statuses = actor.statuses.filter(status => !['observe', 'advantage'].includes(status.id));
      emit('damage', actor, target, `${actor.name}的${move.name}${critical ? '抓住破绽，' : '命中，'}造成 ${damage} 点伤害。`, { move: move.name, damage, critical, accuracy, roll: dice.hit, criticalChance, criticalRoll: dice.critical, resource: move.resource, spent });
    } else {
      emit('tactic', actor, target, `${actor.name}完成${move.name}${move.kind === 'maneuver' ? '，获得短暂先机' : move.kind === 'feint' ? '，使对手失衡' : ''}。`, { move: move.name, accuracy, roll: dice.hit, resource: move.resource, spent });
    }
    move.effects.forEach((effect, index) => {
      const recipient = effect.target === 'self' ? actor : target;
      if (recipient.vitality > 0 && dice.effects[index] < effect.chance * strength) {
        addStatus(recipient, effect.id, effect.turns, round, { potency: effect.potency * strength });
        emit('status', actor, recipient, `${recipient.name}进入${STATUS_NAMES[effect.id]}状态。`, { status: effect.id, chance: effect.chance * strength, roll: dice.effects[index] });
      }
    });
  }
  if (!escaped && player.vitality > 0 && enemy.vitality > 0) {
    for (const actor of [player, enemy]) {
      const burn = has(actor, 'burn');
      if (burn) {
        const damage = Math.min(actor.vitality, Math.max(1, Math.round(actor.vitalityMax * 0.04 * burn.potency)));
        actor.vitality -= damage;
        emit('residual', actor, actor, `${actor.name}因灼伤损失 ${damage} 点生命力。`, { damage, status: 'burn' });
      }
    }
  }
  for (const actor of [player, enemy]) {
    actor.statuses = actor.statuses.map(status => ({ ...status, turns: status.turns - 1 })).filter(status => status.turns > 0);
    combat[`${actor.id}_statuses`] = clone(actor.statuses);
    combat[`${actor.id}_buffs`] = clone(actor.statuses.filter(status => !NEGATIVE.has(status.id)));
    combat[`${actor.id}_debuffs`] = clone(actor.statuses.filter(status => NEGATIVE.has(status.id)));
  }
  combat.enemy_status = enemy.statuses.map(status => status.name);
  for (const key of ['vitality', 'chakra', 'stamina', 'spirit']) combat[`enemy_${key}`] = enemy[key];
  if (escaped || player.vitality <= 0 || enemy.vitality <= 0) {
    combat.is_active = false;
    combat.state = 'peace';
    combat.result = escaped ? 'retreat' : player.vitality <= 0 ? 'defeat' : 'victory';
    combat.incapacitated = player.vitality <= 0 ? 'player' : enemy.vitality <= 0 ? 'enemy' : null;
  }
  const receipt = { action_id: id, action_text: text || selected.name, turn: round, player_move: clone(selected), enemy_move: clone(enemyMove), order: order.map(actor => actor.id), rolls, events: clone(events), result: combat.result };
  combat.last_round = receipt;
  combat.log = [...array(combat.log), ...events.map(event => ({ turn: round, actor: event.actor, action_type: event.type, action_name: event.move || selections[event.actor]?.name || '', result: event.message, damage: event.damage || 0, resource_cost: event.spent || 0 }))].slice(-120);
  const updates = Object.entries(PLAYER_KEYS).filter(([key]) => player[key] !== actorOf(state, 'player')[key]).map(([key, field]) => ({ key: field, op: '=', value: player[key] }));
  return { id, combatId, nextCombat: combat, updates, inventoryUpdates, events, prompt: resultPrompt(combat, receipt, text), actionText: text || selected.name, replayed: false };
}
