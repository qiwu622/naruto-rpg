import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  tacticalCombatEnabled, tacticalSourceFingerprint, tacticalTurnIdentity,
  inferTacticalMoveId, buildTacticalPlan, filterTacticalInstructions
} from '../js/systems/tactical-combat-session.js';
import { listTacticalMoves } from '../js/systems/tactical-combat.js';

let passed = 0;
const test = (name, run) => { run(); passed++; console.log(`PASS ${name}`); };
const fixture = () => ({
  _ui: { settings: { tacticalCombat: true } },
  _meta: { current_node_id: 'node-one', active_branch: 'branch-main' },
  '系统·回合数': 6, '玩家·姓名': '测试忍者', '玩家·忍阶': '下忍', '玩家·存活': '是',
  '属性·当前生命力': 100, '属性·生命力': 100,
  '属性·当前查克拉': 100, '属性·查克拉': 100,
  '属性·当前体力': 100, '属性·体力': 100,
  '属性·当前精神力': 100, '属性·精神力': 100,
  '属性·速度': 20, '属性·幸运': 5,
  '技能·忍术·豪火球之术·等级': 3,
  '技能·忍术·豪火球之术·消耗': 8,
  '技能·忍术·豪火球之术·威力': 20,
  '技能·忍术·豪火球之术·属性': '火',
  '技能·忍术·豪火球之术·熟练度': 50,
  '技能·忍术·水龙弹之术·等级': 3,
  '技能·忍术·水龙弹之术·消耗': 10,
  '技能·忍术·水龙弹之术·威力': 20,
  '技能·忍术·水龙弹之术·属性': '水',
  '物品·道具·手里剑·数量': 3,
  _relationships: { '敌方忍者': { trust: 0, combat_stats: { 生命力: 150, 生命力上限: 150, 速度: 15 } } },
  _combat: {
    id: 'battle-one', is_active: true, state: 'player_turn', turn: 1,
    enemy_name: '敌方忍者', enemy_vitality: 150, enemy_vitality_max: 150,
    enemy_chakra: 60, enemy_chakra_max: 60,
    enemy_stamina: 70, enemy_stamina_max: 70,
    enemy_spirit: 60, enemy_spirit_max: 60, enemy_speed: 15,
    enemy_jutsu: [], log: []
  }
});
const filterPlan = { id: 'plan-one', sourceEnemyName: '敌方忍者', nextCombat: { enemy_name: '敌方忍者' } };

test('tactical mode is opt-in and inactive sessions do not prepare rounds', () => {
  assert.equal(tacticalCombatEnabled({}), false);
  assert.equal(tacticalCombatEnabled({ _ui: { settings: { tacticalCombat: 'true' } } }), false);
  assert.equal(tacticalCombatEnabled(fixture()), true);
  assert.equal(buildTacticalPlan({ ...fixture(), _ui: {} }, { moveId: 'basic:attack' }), null);
  assert.equal(buildTacticalPlan({ ...fixture(), _combat: { is_active: false } }, { moveId: 'basic:attack' }), null);
});

test('simple basic actions resolve, free tactics and negated moves do not silently become attacks', () => {
  const state = fixture();
  for (const input of ['攻击', '我攻击敌人', '打拳', '踢击', '我使用体术向敌人发起近身攻击！']) {
    assert.equal(inferTacticalMoveId(state, input), 'basic:attack', input);
  }
  for (const input of ['闪避', '防御', '我摆出防御态势，准备格挡下一次攻击。']) {
    assert.equal(inferTacticalMoveId(state, input), 'basic:guard', input);
  }
  assert.equal(inferTacticalMoveId(state, '我决定暂时撤退，寻找有利时机。'), 'basic:retreat');
  assert.equal(inferTacticalMoveId(state, '观察敌人的动作'), 'basic:observe');
  assert.equal(inferTacticalMoveId(state, '虚晃一招'), 'basic:feint');
  assert.equal(inferTacticalMoveId(state, '我使用戒备防御，借岩石挡住来袭的苦无。'), 'basic:guard');
  assert.equal(inferTacticalMoveId(state, '我不使用戒备防御，而是使用豪火球之术。'), 'skill:忍术:豪火球之术');
  for (const input of ['不要攻击', '不使用豪火球之术', '如果他靠近就攻击', '观察后绕到树后封住他的退路',
    '先防御再用豪火球之术', '我准备使用忍术攻击敌人。', '我从忍具袋中取出道具。']) {
    assert.equal(inferTacticalMoveId(state, input), null, input);
  }
});

test('real learned technique names resolve before generic actions', () => {
  const state = fixture();
  const move = listTacticalMoves(state).find(item => item.name === '豪火球之术');
  assert.ok(move, 'fixture must expose its actual learned technique');
  assert.equal(inferTacticalMoveId(state, move.id), move.id);
  assert.equal(inferTacticalMoveId(state, move.name), move.id);
  assert.equal(inferTacticalMoveId(state, '我使用豪火球之术攻击敌人！'), move.id);
  assert.equal(inferTacticalMoveId(state, '我向敌人施展豪火球之术！'), move.id);
  assert.equal(inferTacticalMoveId(state, '我使用豪火球，借树木掩护从侧面攻击'), move.id);
  assert.equal(inferTacticalMoveId(state, '我不用豪火球之术攻击敌人'), null);
  const water = listTacticalMoves(state).find(item => item.name === '水龙弹之术');
  assert.ok(water);
  assert.equal(inferTacticalMoveId(state, '我不用豪火球，而是用水龙弹从侧面攻击'), water.id);
  assert.equal(inferTacticalMoveId(state, '我使用豪火球，但不使用水龙弹'), move.id);
  assert.equal(inferTacticalMoveId(state, '我使用豪火球，同时发动水龙弹'), null);
  for (const input of ['如果敌人靠近，我使用豪火球', '我说“使用豪火球”，随后继续等待',
    '“豪火球之术”', '我尚未掌握豪火球，只能躲避', '我考虑使用豪火球']) {
    assert.equal(inferTacticalMoveId(state, input), null, input);
  }
});

test('battle source and action identity ignore unrelated background updates but guard tactical changes', () => {
  const state = fixture(), before = tacticalSourceFingerprint(state);
  const same = structuredClone(state);
  same._memory = { recent_summary: '后台记忆' };
  same._ui.settings.panelOpen = 'inventory';
  same._api = { model: 'changed' }; same._prompttrace = { request: 2 }; same._meta.savedAt = Date.now();
  same._relationships['敌方忍者'].trust = 3;
  assert.equal(tacticalSourceFingerprint(same), before);
  assert.equal(tacticalSourceFingerprint(Object.fromEntries(Object.entries(state).reverse())), before);
  const beforeEncounter = { ...state, _combat: null };
  const initialEnemy = tacticalSourceFingerprint(beforeEncounter, { enemyName: '敌方忍者' });
  const changedEnemy = structuredClone(beforeEncounter); changedEnemy._relationships['敌方忍者'].combat_stats.速度++;
  assert.notEqual(tacticalSourceFingerprint(changedEnemy, { enemyName: '敌方忍者' }), initialEnemy);
  const legacy = fixture(); delete legacy._combat.id;
  const legacyFingerprint = tacticalSourceFingerprint(legacy); legacy['世界·时间'] = '次日';
  assert.notEqual(tacticalSourceFingerprint(legacy), legacyFingerprint, 'legacy combat ID depends on world time');
  for (const mutate of [
    draft => { draft._meta.active_branch = 'branch-other'; },
    draft => { draft._meta.current_node_id = 'node-other'; },
    draft => { draft['系统·回合数']++; },
    draft => { draft['属性·当前生命力']--; },
    draft => { draft['技能·忍术·豪火球之术·消耗']++; },
    draft => { draft['物品·道具·手里剑·数量']--; },
    draft => { draft._combat.enemy_vitality--; },
    draft => { draft._relationships['敌方忍者'].combat_stats.速度++; }
  ]) {
    const changed = structuredClone(state); mutate(changed);
    assert.notEqual(tacticalSourceFingerprint(changed), before);
  }
  const identity = tacticalTurnIdentity(state, '攻击', 'basic:attack');
  assert.equal(tacticalTurnIdentity(same, '攻击', 'basic:attack'), identity);
  assert.notEqual(tacticalTurnIdentity(state, '踢击', 'basic:attack'), identity);
  assert.notEqual(tacticalTurnIdentity(state, '攻击', 'basic:guard'), identity);
});

test('preparing an action is pure and a retry on the same source reuses the deterministic plan', () => {
  const state = fixture(), snapshot = structuredClone(state);
  const first = buildTacticalPlan(state, { moveId: 'basic:attack', text: '我攻击敌人' });
  const retry = buildTacticalPlan(state, { moveId: 'basic:attack', text: '我攻击敌人' });
  assert.deepEqual(state, snapshot);
  assert.deepEqual(retry, first);
  assert.equal(first.id, tacticalTurnIdentity(state, '我攻击敌人', 'basic:attack'));
  assert.equal(first.sourceFingerprint, tacticalSourceFingerprint(state));
  assert.equal(first.sourceEnemyName, '敌方忍者');
  assert.ok(first.nextCombat && Array.isArray(first.updates) && Array.isArray(first.inventoryUpdates));
  assert.throws(() => buildTacticalPlan(state, { text: '绕树后利用地形诱敌' }), error => error.code === 'TACTICAL_ACTION_REQUIRED');
  assert.throws(() => buildTacticalPlan(state, { moveId: 'skill:missing' }), error => error.code === 'TACTICAL_ACTION_INVALID');
});

test('both resource syntaxes, alias writes, combat paths, maxima and player death remain engine-owned', () => {
  const blocked = [
    { key: '属性·当前生命力', op: '-', value: 50 },
    { key: '查克拉', op: '+', value: 50 },
    { key: '状态·体力', op: '=', value: 1 },
    { key: '生命力上限', op: '=', value: 1 },
    { key: '玩家·存活', op: '=', value: '否' },
    { path: 'player.death_cause', op: 'set', value: 'AI判定死亡' },
    { path: 'attributes.spirit_current', op: 'set', value: 0 },
    { path: 'attributes.willpower_current', op: 'sub', value: 10 },
    { path: 'attributes', op: 'assign', key: 'chakra_current', value: 0 },
    { path: 'attributes["vitality_current"]', op: 'set', value: 0 },
    { path: 'attributes', op: 'set', value: { vitality_current: 0 } },
    { path: '_combat.enemy_vitality', op: 'set', value: 0 },
    { key: '_combat', op: '=', value: { is_active: false } },
    { path: 'combat', op: 'assign', key: 'result', value: 'victory' }
  ];
  const safe = { path: 'progression.exp', op: 'add', value: 10 };
  const original = { variables: [...blocked, safe], combat: { state: 'victory' }, combats: [{ state: 'enemy_turn', damage_to_player: 90 }] };
  const snapshot = structuredClone(original);
  const filtered = filterTacticalInstructions(original, filterPlan);
  assert.deepEqual(filtered.variables, [safe]);
  assert.equal(filtered.combat, null); assert.deepEqual(filtered.combats, []);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(filterTacticalInstructions(filtered, filterPlan), filtered, 'primary and secondary filtering is idempotent');
});

test('AI cannot double-consume, recreate or remove deterministic inventory items', () => {
  const safe = { path: 'equipment.tools.手里剑.description', op: 'set', value: '磨损的忍具' };
  const filtered = filterTacticalInstructions({ variables: [
    { key: '物品·忍具·手里剑·数量', op: '-', value: 1 },
    { key: '物品·道具·手里剑', op: '=', value: true },
    { path: 'equipment.tools.手里剑.quantity', op: 'sub', value: 1 },
    { path: 'equipment.tools.手里剑', op: 'set', value: { quantity: 9 } },
    { path: 'equipment.tools', op: 'remove', key: '手里剑' },
    { path: 'equipment', op: 'set', value: { tools: {} } }, safe
  ] }, filterPlan);
  assert.deepEqual(filtered.variables, [safe]);
});

test('enemy card resource and death writes are stripped while relationship and quest changes survive', () => {
  const relationship = { npc: '敌方忍者', trust_change: -3, reason: '互相试探', status: '已死亡',
    combat_stats: { 生命力: 0 }, chakra: 0, attributes: { vitality_current: 0 }, alive: false };
  const ally = { npc: '队友', trust_change: 2, combat_stats: { 生命力: 80 } };
  const mission = { id: 'task-one', status: 'completed' };
  const memories = [{ summary: '双方交手，仍待下一回合。' }];
  const filtered = filterTacticalInstructions({
    relationships: [relationship, ally, { npc: '敌方忍者', op: 'delete' }],
    relationship, missions: [mission], memories,
    variables: [
      { path: 'relationships.敌方忍者.combat_stats.生命力', op: 'set', value: 0 },
      { path: 'relationships', op: 'assign', key: '敌方忍者', value: { combat_stats: { 生命力: 0 } } },
      { path: '_relationships.敌方忍者.status', op: 'set', value: '死亡' },
      { path: 'relationships.敌方忍者.trust', op: 'add', value: 2 }
    ]
  }, filterPlan);
  assert.deepEqual(filtered.relationships, [{ npc: '敌方忍者', trust_change: -3, reason: '互相试探' }, ally]);
  assert.deepEqual(filtered.relationship, filtered.relationships[0]);
  assert.equal(filtered.variables.length, 1);
  assert.deepEqual(filtered.missions, [mission]); assert.deepEqual(filtered.memories, memories);
  assert.deepEqual(filterTacticalInstructions({ relationship: { npc: ' 敌方忍者 ', trust_change: 1, vitality: 0 } }, filterPlan).relationship,
    { npc: ' 敌方忍者 ', trust_change: 1 });
});

test('mis-tagged instructions cannot bypass the shared router protection; no-plan calls preserve behavior', () => {
  const input = {
    missions: [{ key: '属性·当前查克拉', op: '-', value: 8 }, { id: 'task-one', status: 'active' }],
    events: [{ state: 'victory' }, { id: 'EV-TEST', status: 'triggered' }],
    relationships: [{ path: 'equipment.consumables.兵粮丸.quantity', op: 'sub', value: 1 }]
  };
  assert.deepEqual(filterTacticalInstructions(input, null), input);
  const result = filterTacticalInstructions(input, filterPlan);
  assert.equal(result.missions.length, 1); assert.equal(result.events.length, 1);
  assert.deepEqual(result.relationships, []);
});

test('browser mirror matches the session module', () => {
  assert.equal(readFileSync(new URL('../js/systems/tactical-combat-session.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../public/js/systems/tactical-combat-session.js', import.meta.url), 'utf8'));
});

console.log(`Tactical combat session regression: ${passed} groups passed`);
