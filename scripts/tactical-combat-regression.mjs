import assert from 'node:assert/strict';
import { listTacticalMoves, previewTacticalAction, resolveTacticalRound } from '../js/systems/tactical-combat.js';
import { normalizeTechnique } from '../js/systems/npc-balance.js';

const copy = value => structuredClone(value);
function fixture() {
  return {
    '玩家·姓名': '训练者', '属性·生命力': 500, '属性·当前生命力': 500,
    '属性·查克拉': 100, '属性·当前查克拉': 100, '属性·体力': 100, '属性·当前体力': 100,
    '属性·精神力': 100, '属性·当前精神力': 100, '属性·速度': 30, '属性·幸运': 10,
    '进度·忍术熟练度': 60, '进度·体术熟练度': 60, '进度·幻术熟练度': 60,
    '技能·忍术·试验火球·名称': '试验火球', '技能·忍术·试验火球·威力': 30,
    '技能·忍术·试验火球·属性': '火', '技能·忍术·试验火球·消耗': 20,
    '技能·忍术·试验火球·熟练度': 60, '技能·忍术·试验火球·命中率': 90,
    '物品·消耗品·兵粮丸·数量': 2, '物品·忍具·烟雾弹·数量': 1,
    '物品·武器·手里剑·数量': 3, '物品·消耗品·绷带·数量': 2,
    _combat: { id: 'training', is_active: true, turn: 0, enemy_name: '训练对手', enemy_known: true,
      enemy_vitality: 500, enemy_vitality_max: 500, enemy_chakra: 100, enemy_chakra_max: 100,
      enemy_stamina: 100, enemy_stamina_max: 100, enemy_spirit: 100, enemy_spirit_max: 100,
      enemy_speed: 10, enemy_luck: 10, enemy_ninjutsu: 60, enemy_taijutsu: 60, enemy_genjutsu: 60,
      enemy_jutsu: [{ 名称: '训练拳', 类型: '体术', 威力: 12, 熟练度: 60, 消耗: 2 }], distance: '中' }
  };
}
const FIRE = 'skill:忍术:试验火球';
const resolve = (state, moveId = FIRE, extra = {}) => resolveTacticalRound(state, { moveId, actionId: 'turn-one', seed: 'fixed', ...extra });
const patch = (state, plan) => Object.assign(copy(state), Object.fromEntries([...plan.updates, ...plan.inventoryUpdates].map(item => [item.key, item.value])), { _combat: copy(plan.nextCombat) });
const playerDamage = plan => plan.events.find(event => event.actor === 'player' && event.type === 'damage')?.damage || 0;
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test('flat and nested learned skills, genuine inventory, no synthetic jutsu', () => {
  const state = fixture();
  state.skills = { taijutsu: { 旋风: { name: '旋风', power: 28, cost: 7, mastery: 80 } }, support: { 替身术: { name: '替身术', cost: 9 } } };
  state.equipment = { tools: { 苦无: { quantity: 4 } } };
  const moves = listTacticalMoves(state);
  assert.equal(moves.find(move => move.id === FIRE).cost, 20);
  assert.equal(moves.find(move => move.name === '旋风').resource, '体力');
  assert.equal(moves.find(move => move.name === '替身术').kind, 'substitute');
  assert.equal(moves.find(move => move.name === '苦无').quantity, 4);
  assert.ok(moves.some(move => move.id === 'basic:improvise'));
  assert.equal(moves.filter(move => move.name === '豪火球之术').length, 0);
});
test('explicit power never guessed from numeric coincidence; marked legacy corrected once', () => {
  const state = fixture();
  state.skills = { jutsu: { 明示: { rank: 'C', power: 24, mastery: 20 }, 默认: { rank: 'C', mastery: 20 }, 标记: { rank: 'C', power: 23.8, mastery: 20, power_includes_mastery: true }, 基础: { rank: 'C', power: 23.8, base_power: 34, mastery: 20 } } };
  const moves = listTacticalMoves(state);
  assert.equal(moves.find(move => move.name === '明示').power, 24);
  assert.equal(moves.find(move => move.name === '默认').power, 34);
  assert.ok(Math.abs(moves.find(move => move.name === '标记').power - 34) < 0.0001);
  assert.equal(moves.find(move => move.name === '基础').power, 34);
});
test('pure and deterministic; committed action replay causes no charges', () => {
  const state = fixture(); const snapshot = copy(state);
  const first = resolve(state); const second = resolve(state);
  assert.deepEqual(first, second); assert.deepEqual(state, snapshot);
  const replay = resolve(patch(state, first));
  assert.equal(replay.replayed, true); assert.deepEqual(replay.updates, []); assert.deepEqual(replay.inventoryUpdates, []);
  assert.deepEqual(replay.events, first.events); assert.equal(replay.nextCombat.turn, 1);
});
test('normalized NPC provenance applies mastery once and edited powers shed provenance', () => {
  const skill = normalizeTechnique({ 名称: '训练忍术', 等级: 'C', 熟练度: 20 });
  assert.equal(skill.威力, 24);
  const state = fixture(); state.skills = { jutsu: { 训练忍术: skill } };
  assert.equal(listTacticalMoves(state).find(move => move.name === '训练忍术').power, 34);
  const again = normalizeTechnique(skill);
  state.skills.jutsu.训练忍术 = again;
  assert.equal(listTacticalMoves(state).find(move => move.name === '训练忍术').power, 34);
  const edited = normalizeTechnique({ ...again, 威力: 25 });
  assert.equal(edited._power_basis, undefined);
  state.skills.jutsu.训练忍术 = edited;
  assert.equal(listTacticalMoves(state).find(move => move.name === '训练忍术').power, 25);
});
test('chakra maximum affects output sublinearly; current chakra only pays cost', () => {
  const base = fixture(); base['属性·当前查克拉'] = 60;
  const half = fixture(); half['属性·当前查克拉'] = 30;
  assert.deepEqual(previewTacticalAction(base, FIRE).damageRange, previewTacticalAction(half, FIRE).damageRange);
  const large = fixture(); large['属性·查克拉'] = 400;
  const lowDamage = previewTacticalAction(base, FIRE).damageRange[0];
  const highDamage = previewTacticalAction(large, FIRE).damageRange[0];
  assert.ok(highDamage > lowDamage && highDamage < lowDamage * 2);
  const plan = resolve(base);
  assert.equal(plan.updates.find(item => item.key === '属性·当前查克拉').value, 40);
});
test('resource shortage is weakened action, preview agrees and no negative resources', () => {
  const state = fixture(); state['属性·当前查克拉'] = 2;
  const preview = previewTacticalAction(state, FIRE);
  assert.equal(preview.strength, 0.1); assert.ok(preview.accuracy <= 50); assert.ok(preview.damageRange[1] < 10);
  const plan = resolve(state);
  assert.ok(plan.events.some(event => event.type === 'weakened'));
  assert.equal(plan.updates.find(item => item.key === '属性·当前查克拉').value, 0);
});
test('both sides use identical defense formula; legacy linear defense ignored', () => {
  const base = fixture(); const other = copy(base); other._combat.enemy_defense = 9000;
  assert.deepEqual(previewTacticalAction(base, 'basic:attack').damageRange, previewTacticalAction(other, 'basic:attack').damageRange);
});
test('priority precedes speed, speed resolves ordinary actions', () => {
  const state = fixture(); state['属性·速度'] = 1000;
  let found = false;
  for (let seed = 0; seed < 30; seed++) {
    const plan = resolve(state, FIRE, { seed });
    if (plan.nextCombat.last_round.enemy_move.kind === 'guard') { assert.equal(plan.nextCombat.last_round.order[0], 'enemy'); found = true; break; }
    assert.equal(plan.nextCombat.last_round.order[0], 'player');
  }
  assert.ok(found);
});
test('enemy move frozen independent of player choice and hit result', () => {
  const state = fixture(); const one = resolve(state, FIRE);
  const two = resolve(state, 'basic:guard');
  assert.deepEqual(one.nextCombat.last_round.enemy_move, two.nextCombat.last_round.enemy_move);
  assert.deepEqual(one.nextCombat.last_round.rolls.enemy, two.nextCombat.last_round.rolls.enemy);
});
test('damage not multiplied by innate enemy element, real barrier matchup applies', () => {
  const state = fixture(); const a = copy(state); a._combat.enemy_element = '水';
  const b = copy(state); b._combat.enemy_element = '风';
  assert.deepEqual(previewTacticalAction(a, FIRE).damageRange, previewTacticalAction(b, FIRE).damageRange);
  a._combat.enemy_statuses = [{ id: 'barrier', element: '水', potency: 1, turns: 2 }];
  b._combat.enemy_statuses = [{ id: 'barrier', element: '风', potency: 1, turns: 2 }];
  assert.ok(previewTacticalAction(a, FIRE).damageRange[1] < previewTacticalAction(b, FIRE).damageRange[0]);
  const weak = copy(a); weak._combat.enemy_statuses[0].potency = 0.1;
  assert.ok(previewTacticalAction(weak, FIRE).damageRange[0] > previewTacticalAction(a, FIRE).damageRange[1]);
});
test('unknown opponent preview hides actual stats and approximation does not depend on hidden stats', () => {
  const state = fixture(); state._combat.enemy_known = false;
  const first = previewTacticalAction(state, FIRE);
  state._combat.enemy_vitality_max = 999999; state._combat.enemy_speed = 999;
  const second = previewTacticalAction(state, FIRE);
  assert.equal(first.accuracy, null); assert.equal(first.damageRange, null);
  assert.deepEqual(first.accuracyRange, second.accuracyRange);
});
test('unknown opponent probability range applies partial and empty resource penalties', () => {
  const state = fixture(); state._combat.enemy_known = false;
  const full = previewTacticalAction(state, FIRE);
  state['属性·当前查克拉'] = 2;
  const weakened = previewTacticalAction(state, FIRE);
  assert.equal(weakened.accuracy, null);
  assert.deepEqual(weakened.accuracyRange, full.accuracyRange.map(value => Math.round(value * 0.55)));
  state._combat.enemy_speed = 999; state._combat.enemy_vitality_max = 999999;
  assert.deepEqual(previewTacticalAction(state, FIRE).accuracyRange, weakened.accuracyRange);
  state['属性·当前查克拉'] = 0;
  assert.deepEqual(previewTacticalAction(state, FIRE).accuracyRange, [0, 0]);
});
test('far melee approaches without hidden damage and preview states this', () => {
  const state = fixture(); state._combat.distance = '远';
  assert.equal(previewTacticalAction(state, 'basic:attack').approaching, true);
  assert.equal(previewTacticalAction(state, 'basic:attack').damageRange, null);
  const plan = resolve(state, 'basic:attack');
  assert.ok(plan.events.some(event => event.type === 'approach' && event.actor === 'player'));
  assert.equal(playerDamage(plan), 0); assert.equal(plan.nextCombat.distance, '中');
});
test('zero-power illusion and changes never inflict damage', () => {
  const state = fixture(); state.skills = { genjutsu: { 扰乱: { name: '扰乱', power: 0, cost: 4, mastery: 60 } } };
  const move = listTacticalMoves(state).find(item => item.name === '扰乱');
  assert.equal(move.kind, 'control'); assert.equal(move.power, 0);
  const plan = resolve(state, move.id);
  assert.equal(playerDamage(plan), 0);
  assert.ok(plan.nextCombat.enemy_statuses.some(status => status.id === 'genjutsu'));
  assert.ok(!plan.nextCombat.player_statuses.some(status => status.id === 'advantage'));
});
test('finite statuses expire, do not stack indefinitely', () => {
  const state = fixture(); state._combat.player_statuses = [{ id: 'burn', turns: 1, potency: 1 }];
  const plan = resolve(state, 'basic:guard');
  assert.ok(plan.events.some(event => event.type === 'residual'));
  assert.ok(!plan.nextCombat.player_statuses.some(status => status.id === 'burn'));
  assert.ok(!plan.nextCombat.player_statuses.some(status => status.id === 'guard'));
});
test('guard protects this exchange; observe persists for and is consumed by a later hit', () => {
  const state = fixture();
  let guardCompared = false;
  for (let seed = 0; seed < 30; seed++) {
    const guard = resolve(state, 'basic:guard', { seed });
    const observe = resolve(state, 'basic:observe', { seed });
    const damage = plan => plan.events.find(event => event.actor === 'enemy' && event.type === 'damage')?.damage || 0;
    if (damage(observe) > 0) { assert.ok(damage(guard) < damage(observe)); guardCompared = true; break; }
  }
  assert.ok(guardCompared);
  const first = resolve(state, 'basic:observe');
  assert.ok(first.nextCombat.player_statuses.some(status => status.id === 'observe' && status.turns === 1));
  const prepared = patch(state, first);
  assert.ok(previewTacticalAction(prepared, FIRE).accuracy > previewTacticalAction(state, FIRE).accuracy);
  let consumed = false;
  for (let seed = 0; seed < 10; seed++) {
    const second = resolve(prepared, FIRE, { actionId: 'turn-two', seed });
    if (playerDamage(second)) { assert.ok(!second.nextCombat.player_statuses.some(status => status.id === 'observe')); consumed = true; break; }
  }
  assert.ok(consumed);
});
test('learned substitute can evade, learned clone and barrier create bounded protection', () => {
  const state = fixture(); state.skills = { support: {
    替身术: { name: '替身术', cost: 8, mastery: 60 },
    影分身: { name: '影分身', cost: 12, mastery: 60 },
    土流壁: { name: '土流壁', element: '土', cost: 15, mastery: 60 }
  } };
  let evaded = false;
  for (let seed = 0; seed < 30; seed++) {
    const plan = resolve(state, 'skill:支援:替身术', { seed });
    if (plan.events.some(event => event.type === 'evade' && event.target === 'player')) { evaded = true; break; }
  }
  assert.ok(evaded);
  const clone = resolve(state, 'skill:支援:影分身');
  assert.ok(clone.nextCombat.player_statuses.some(status => status.id === 'clone' && status.turns === 1));
  const barrier = resolve(state, 'skill:支援:土流壁');
  assert.ok(barrier.nextCombat.player_statuses.some(status => status.id === 'barrier' && status.element === '土'));
  assert.equal(playerDamage(barrier), 0);
});
test('free tactic explicitly yields chance/position, no phantom attack or learned skill', () => {
  const plan = resolve(fixture(), 'basic:improvise', { text: '借树木绕到侧面' });
  assert.equal(playerDamage(plan), 0); assert.equal(plan.actionText, '借树木绕到侧面');
  assert.match(plan.prompt, /执行招式：自由战术/); assert.match(plan.prompt, /借树木绕到侧面/);
  assert.ok(plan.events.some(event => event.actor === 'player' && ['tactic', 'miss'].includes(event.type)));
});
test('genuine items decrement once, restore only actual deficit', () => {
  const state = fixture(); state['属性·当前查克拉'] = 95;
  const plan = resolve(state, 'item:消耗品:兵粮丸');
  assert.deepEqual(plan.inventoryUpdates, [{ key: '物品·消耗品·兵粮丸·数量', op: '=', value: 1 }]);
  assert.equal(plan.updates.find(item => item.key === '属性·当前查克拉').value, 100);
  assert.deepEqual(resolve(patch(state, plan), 'item:消耗品:兵粮丸').inventoryUpdates, []);
  const empty = fixture(); empty['物品·消耗品·兵粮丸·数量'] = 0;
  assert.deepEqual(resolve(empty, 'item:消耗品:兵粮丸').inventoryUpdates, []);
});
test('smoke changes distance; healing removes burns and caps at maximum', () => {
  const state = fixture();
  assert.equal(resolve(state, 'item:忍具:烟雾弹').nextCombat.distance, '远');
  state['属性·当前生命力'] = 490; state._combat.player_statuses = [{ id: 'burn', turns: 3 }];
  const plan = resolve(state, 'item:消耗品:绷带');
  assert.ok(!plan.nextCombat.player_statuses.some(status => status.id === 'burn'));
  assert.ok(plan.updates.every(item => item.key !== '属性·当前生命力' || item.value <= 500));
});
test('victory and defeat mean incapacitation; no forced death variable or extra action', () => {
  const win = fixture(); win._combat.enemy_vitality = 1;
  let victory;
  for (let seed = 0; seed < 20; seed++) { const plan = resolve(win, FIRE, { seed }); if (plan.nextCombat.result === 'victory') { victory = plan; break; } }
  assert.ok(victory); assert.equal(victory.nextCombat.is_active, false); assert.equal(victory.nextCombat.incapacitated, 'enemy');
  const lose = fixture(); lose['属性·当前生命力'] = 1;
  let defeat;
  for (let seed = 0; seed < 30; seed++) { const plan = resolve(lose, 'basic:observe', { seed }); if (plan.nextCombat.result === 'defeat') { defeat = plan; break; } }
  assert.ok(defeat); assert.equal(defeat.nextCombat.incapacitated, 'player');
  assert.ok(!defeat.updates.some(item => /存活|死因/.test(item.key))); assert.match(defeat.prompt, /不代表死亡/);
});
test('retreat ends combat and surviving pending attacks are cancelled', () => {
  const state = fixture(); state['属性·速度'] = 100;
  let retreated;
  for (let seed = 0; seed < 30; seed++) { const plan = resolve(state, 'basic:retreat', { seed }); if (plan.nextCombat.result === 'retreat') { retreated = plan; break; } }
  assert.ok(retreated); assert.equal(retreated.nextCombat.is_active, false);
  const index = retreated.events.findIndex(event => event.type === 'retreat');
  assert.ok(retreated.events.slice(index + 1).every(event => event.type === 'skipped'));
});
test('seed sampling verifies actual hit and conditional secondary-effect probabilities', () => {
  const state = fixture(); let hits = 0; let burns = 0; const samples = 5000;
  for (let seed = 0; seed < samples; seed++) {
    const plan = resolve(state, FIRE, { seed });
    hits += Number(plan.events.some(event => event.type === 'damage' && event.actor === 'player'));
    burns += Number(plan.events.some(event => event.type === 'status' && event.actor === 'player' && event.status === 'burn'));
  }
  assert.ok(Math.abs(hits / samples - 0.9) < 0.025, `hit ${hits / samples}`);
  assert.ok(Math.abs(burns / samples - 0.18) < 0.02, `burn ${burns / samples}`);
  console.log(`  sampled hit ${(hits / samples * 100).toFixed(2)}%; burn ${(burns / samples * 100).toFixed(2)}%`);
});
console.log(`Tactical combat regressions: ${passed} passed`);
