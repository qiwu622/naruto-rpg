import { resolveAlias, STRUCTURED_SCALAR_PATH_MAP } from '../data/var-schema.js';
import { normalizeNpcIdentity } from '../data/npc-identity.js';
import { listTacticalMoves, resolveTacticalRound } from './tactical-combat.js';

const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => value == null ? value : structuredClone(value);
const textOf = value => String(value ?? '').trim();
const compact = value => textOf(value).replace(/[\s，。！？、,!?；;：:“”"'「」《》]/gu, '');
const PLAYER_RESOURCES = new Set([
  '属性·当前查克拉', '属性·当前体力', '属性·当前精神力', '属性·当前生命力',
  // Lowering a maximum also clamps the current resource in StateManager.
  '属性·查克拉', '属性·体力', '属性·精神力', '属性·生命力',
  '玩家·存活', '玩家·死因'
]);
const NPC_COMBAT_FIELDS = new Set([
  'combat_stats', 'attributes', '属性', 'masteries', '造诣', 'combatant', 'is_combatant', '战斗型', '战斗人员',
  '查克拉', '查克拉上限', '生命力', '生命力上限', '体力', '体力上限', '速度', '精神力', '精神力上限', '幸运',
  '忍术造诣', '体术造诣', '幻术造诣', '忍阶', '查克拉属性', '忍术',
  'chakra', 'chakra_max', 'vitality', 'vitality_max', 'stamina', 'stamina_max', 'spirit', 'spirit_max',
  'chakra_current', 'vitality_current', 'stamina_current', 'spirit_current', 'hp', 'hp_max', 'speed', 'luck',
  'ninjutsu', 'taijutsu', 'genjutsu', 'rank', 'enemy_rank', 'chakra_nature', 'jutsu',
  'alive', 'dead', 'is_dead', 'death_cause', '存活', '死因', '死亡'
]);
const COMBAT_STATES = new Set(['start', 'round_start', 'player_turn', 'enemy_turn', 'in_progress', 'victory', 'defeat', 'retreat', 'player_retreat']);
const LIST_FIELDS = ['variables', 'missions', 'relationships', 'events', 'mission', 'relationship', 'event'];
const ITEM_METADATA = new Set(['description', 'quality', '描述', '品质', '说明']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => [key, stableValue(value[key])]));
}

function hash(value) {
  let result = 14695981039346656037n;
  for (const char of JSON.stringify(stableValue(value))) {
    result = BigInt.asUintN(64, (result ^ BigInt(char.codePointAt(0))) * 1099511628211n);
  }
  return result.toString(16).padStart(16, '0');
}

function flatOrNested(state, prefix, nested) {
  const entries = Object.entries(state || {}).filter(([key]) => prefix.test(key));
  return entries.length ? Object.fromEntries(entries) : nested || {};
}

export function tacticalCombatEnabled(state) {
  return state?._ui?.settings?.tacticalCombat === true;
}

/** A narrow guard: prompt traces, memory, UI and provider settings cannot expire a plan. */
export function tacticalSourceFingerprint(state = {}, { enemyName: requestedEnemyName } = {}) {
  const combat = state._combat ?? state.combat ?? null;
  const enemyName = requestedEnemyName || combat?.enemy_name || '';
  const relationships = state._relationships ?? state.relationships ?? {};
  const player = state.player || {};
  return `tactical-source:${hash({
    node: state._meta?.current_node_id || null,
    branch: state._meta?.active_branch || null,
    turn: state['系统·回合数'] ?? state._meta?.turn_count ?? 0,
    combat,
    legacyCombatSeedTime: combat && !combat.id && !combat.combat_id ? state['世界·时间'] || '' : null,
    attributes: flatOrNested(state, /^属性·/u, state.attributes),
    masteries: flatOrNested(state, /^进度·(?:忍术|体术|幻术|防御)熟练度$/u, state.progression && {
      jutsu_mastery: state.progression.jutsu_mastery, taijutsu_mastery: state.progression.taijutsu_mastery,
      genjutsu_mastery: state.progression.genjutsu_mastery, defense_mastery: state.progression.defense_mastery
    }),
    skills: flatOrNested(state, /^技能·/u, state.skills),
    equipment: flatOrNested(state, /^物品·/u, state.equipment),
    // The engine merges structured and flat skills/items; capture that effective catalogue too.
    moves: listTacticalMoves(state).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    equipped: state._equipped ?? state.equipment?.equipped ?? null,
    player: {
      name: state['玩家·姓名'] ?? player.name,
      rank: state['玩家·忍阶'] ?? player.rank,
      nature: state['玩家·查克拉属性'] ?? player.chakra_nature,
      difficulty: state['玩家·难度'] ?? player.difficulty,
      alive: state['玩家·存活'] ?? player.alive,
      deathCause: state['玩家·死因'] ?? player.death_cause
    },
    enemyName,
    enemy: relationships[enemyName]?.combat_stats || null
  })}`;
}

export function tacticalTurnIdentity(state, text, moveId) {
  return `tactical-turn:${hash([tacticalSourceFingerprint(state), textOf(text), textOf(moveId)])}`;
}

function moveNames(move) {
  const name = compact(move.name);
  const aliases = [name];
  if (String(move.id).startsWith('skill:')) {
    aliases.push(name.replace(/之术$/u, ''));
    const unprefixed = name.split(/[·・]/u).at(-1);
    if (unprefixed !== name) aliases.push(unprefixed, unprefixed.replace(/之术$/u, ''));
  }
  return [...new Set(aliases)].filter(value => value.length >= 2);
}

function selectedNamedMoves(moves, text) {
  // Quoted dialogue, hypothetical plans and negated alternatives are not selections.
  const input = textOf(text).replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|‘[^’]*’/gu, ' ')
    .replace(/\s+/gu, '');
  const selected = new Set();
  const matches = [];
  for (const move of moves) {
    for (const name of moveNames(move)) {
      for (let position = input.indexOf(name); position >= 0; position = input.indexOf(name, position + name.length)) {
        matches.push({ move, name, position });
      }
    }
  }
  matches.sort((left, right) => right.name.length - left.name.length);
  const claimed = [];
  for (const match of matches) {
    const { move, name, position } = match;
    if (claimed.some(span => position >= span.start && position + name.length <= span.end
      && (span.id === move.id || name.length < span.end - span.start))) continue;
    const prefix = input.slice(0, position);
    const clause = prefix.split(/[，,。；;！？!?]|而是|改为|转而|不过|但是/gu).at(-1);
    const marker = clause.match(/(?:使用|施展|施放|发动|使出|释放|用|投掷|扔出|服用|挥动)(?:一枚|一颗|一个|一把|一次|一发)?$/u);
    if (!marker) continue;
    const beforeMarker = clause.slice(0, marker.index);
    if (/(?:不|别|未|没|禁止|取消|放弃|无须|无需|不能|莫)(?:.{0,5})$/u.test(beforeMarker)) continue;
    if (/先(?:防御|攻击|观察|撤退|佯攻).*(?:再|然后|接着)/u.test(beforeMarker)) continue;
    if (/(?:如果|假如|假设|要是|一旦|除非|万一|能否|是否|要不要|尚未掌握|没学会|考虑|设想|幻想|想象)/u.test(clause)) continue;
    // A conditional leading clause governs the following action as well.
    const sentence = prefix.split(/[。；;！？!?]|而是|改为|转而/gu).at(-1);
    if (/(?:如果|假如|假设|要是|一旦|除非|万一)/u.test(sentence)) continue;
    claimed.push({ id: move.id, start: position, end: position + name.length });
    selected.add(move.id);
  }
  return selected;
}

/** Select one explicitly named move, or a simple unambiguous basic action. */
export function inferTacticalMoveId(state, text) {
  const moves = listTacticalMoves(state);
  const input = compact(text);
  if (!input) return null;
  const quoted = /["“”「」『』‘’]/u.test(textOf(text));
  const exact = moves.filter(move => textOf(text) === move.id || (!quoted && input === compact(move.name)));
  if (exact.length) return exact.length === 1 ? exact[0].id : null;
  const named = selectedNamedMoves(moves, text);
  if (named.size) return named.size === 1 ? [...named][0] : null;
  if (quoted) return null;
  // Named techniques may themselves contain 不; only unmatched prose reaches this guard.
  if (/(?:不|别|莫|禁止|取消|如果|假如|假设|除非|是否|要不要|能否|不能)/u.test(input)) return null;
  if (/(?:然后|接着|同时|之后|先.+再|并且|一边|趁机|佯装|假装)/u.test(input)) return null;
  const simple = input.replace(/^(?:我)?(?:决定|准备|尝试)?/u, '');
  const basics = [
    ['basic:attack', /^(?:攻击|普通攻击|基础攻击|基础体术|体术攻击|近身攻击|打拳|踢击|挥拳|踢一脚|打一拳|(?:向|朝|对)?(?:敌人|对手)?(?:挥拳|出拳|踢击|踢一脚|打一拳)|(?:使用|用)?体术(?:向敌人发起近身攻击|攻击敌人|攻击)|(?:攻击|挥拳攻击|踢击)(?:敌人|对手))$/u],
    ['basic:guard', /^(?:防御|防守|格挡|闪避|躲避|躲闪|闪身躲避|格挡攻击|闪避攻击|躲避攻击|防御姿态|摆出防御态势准备格挡下一次攻击)$/u],
    ['basic:retreat', /^(?:撤退|逃跑|逃离|脱离战斗|尝试撤退|暂时撤退|暂时撤退寻找有利时机)$/u],
    ['basic:observe', /^(?:观察|观察敌人|观察对手|观察敌人的动作|观察对手动作|观察敌情|观察局势|分析敌情)$/u],
    ['basic:feint', /^(?:佯攻|试探|试探攻击|虚晃一招|使用佯攻|佯攻敌人)$/u]
  ];
  return basics.find(([id, pattern]) => moves.some(move => move.id === id) && pattern.test(simple))?.[0] || null;
}

export function buildTacticalPlan(state, { moveId, text = '' } = {}) {
  if (!tacticalCombatEnabled(state) || !(state?._combat ?? state?.combat)?.is_active) return null;
  const selected = moveId || inferTacticalMoveId(state, text);
  if (!selected) {
    const error = new Error('请明确选择本回合的招式或战术');
    error.code = 'TACTICAL_ACTION_REQUIRED';
    throw error;
  }
  if (!listTacticalMoves(state).some(move => move.id === selected)) {
    const error = new Error('所选招式已变化或不在当前可用招式中');
    error.code = 'TACTICAL_ACTION_INVALID';
    throw error;
  }
  const actionId = tacticalTurnIdentity(state, text, selected);
  const plan = resolveTacticalRound(state, { moveId: selected, actionId, text });
  return { ...plan, sourceFingerprint: tacticalSourceFingerprint(state),
    sourceEnemyName: (state._combat ?? state.combat)?.enemy_name || '', moveId: selected };
}

function protectedPath(rawPath, operation, enemyName) {
  const path = textOf(rawPath).replace(/\[(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/gu,
    (_match, quoted, singleQuoted, bare) => `.${quoted || singleQuoted || bare}`);
  const canonical = resolveAlias(STRUCTURED_SCALAR_PATH_MAP[path] || path);
  if (PLAYER_RESOURCES.has(canonical)) return true;
  if (/^(?:_combat|combat)(?:[.\[]|$)/u.test(path)) return true;
  if (['attributes', 'player', '属性', '玩家'].includes(path)) return true;
  if (/^物品·/u.test(canonical)) {
    const parts = canonical.split('·');
    return parts.length < 4 || !ITEM_METADATA.has(parts.at(-1));
  }
  if (path === 'equipment') return true;
  if (/^equipment\.(?:weapons|armor|tools|consumables)(?:[.\[]|$)/u.test(path)) {
    const parts = path.split('.');
    return parts.length < 4 || !ITEM_METADATA.has(parts.at(-1)) || ['remove', 'delete', 'del'].includes(operation);
  }
  for (const root of ['relationships', '_relationships']) {
    if (path === root) return true;
    const base = `${root}.${enemyName}`;
    if (!enemyName || (path !== base && !path.startsWith(`${base}.`))) continue;
    if (path === base) return true;
    const field = path.slice(base.length + 1).split('.')[0];
    if (NPC_COMBAT_FIELDS.has(field) || field === 'status') return true;
  }
  return false;
}

function filterObject(value, enemyName) {
  if (!record(value)) return value;
  if (COMBAT_STATES.has(value.state)) return null;
  if (value.key && !value.path && protectedPath(value.key, value.op, enemyName)) return null;
  if (value.path) {
    const path = ['assign', 'remove'].includes(value.op) && typeof value.key === 'string'
      ? `${value.path}.${value.key}` : value.path;
    if (protectedPath(path, value.op, enemyName)) return null;
  }
  if (enemyName && normalizeNpcIdentity(value.npc) === normalizeNpcIdentity(enemyName)) {
    if (['delete', 'remove', 'rename'].includes(value.action) || ['delete', 'remove', 'rename'].includes(value.op)
      || value.rename_to || value.new_name || value.new_npc) return null;
    const safe = Object.fromEntries(Object.entries(value).filter(([key, item]) => !NPC_COMBAT_FIELDS.has(key)
      && !(key === 'status' && /死亡|阵亡|已死|死者|dead|killed/iu.test(textOf(item)))));
    return safe;
  }
  return value;
}

/** Run on both primary and secondary parsed instructions, before routing tags. */
export function filterTacticalInstructions(instructions, plan) {
  const filtered = clone(instructions);
  if (!plan || !record(filtered)) return filtered;
  const enemyName = plan.sourceEnemyName || plan.nextCombat?.enemy_name || '';
  filtered.combat = null;
  filtered.combats = [];
  for (const key of LIST_FIELDS) {
    if (Array.isArray(filtered[key])) filtered[key] = filtered[key].map(value => filterObject(value, enemyName)).filter(value => value != null);
    else if (filtered[key] != null) filtered[key] = filterObject(filtered[key], enemyName);
  }
  return filtered;
}
