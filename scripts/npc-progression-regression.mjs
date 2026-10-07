import assert from 'node:assert/strict';
import { stateManager } from '../js/core/state-manager.js';
import { instructionParser } from '../js/core/instruction-parser.js';
import { MessagePipeline } from '../js/core/pipeline.js';
import { relationshipSystem } from '../js/systems/relationship-system.js';
import { combatSystem } from '../js/systems/combat-system.js';
import { generateMainVarInstructions, NPC_GROWTH_GUIDANCE } from '../js/data/var-schema.js';
import { buildVariableUpdaterRuntimeContract } from '../js/core/variable-updater.js';

const pipeline = new MessagePipeline({ relationshipSystem });
const npc = '成长测试忍者';
const apply = combat_stats => pipeline._applyInstructions(instructionParser.parse(
  `<relationship>${JSON.stringify({ npc, combatant: true, combat_stats })}</relationship>`
));
const card = () => relationshipSystem.getRelationship(npc).combat_stats;
function seed() {
  stateManager.reset();
  apply({ rank: '下忍', chakra_max: 150, chakra: 40, vitality_max: 180, vitality: 80,
    stamina_max: 150, stamina: 50, spirit_max: 110, spirit: 35, speed: 40, ninjutsu: 40,
    chakra_nature: ['风'], jutsu: [
      { name: '自创·风刃', rank: 'D', power: 24, cost: 9, mastery: 20, description: '训练掌握的风刃。' },
      { name: '自创·闪身', rank: 'D', power: 12, cost: 6, mastery: 30 }
    ] });
}
let passed = 0;
const failures = [];
function test(name, fn) {
  try { seed(); fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

test('relationship tags retain evidenced growth beyond the administrative rank benchmark', () => {
  apply({ chakra_max: 240, speed: 80, ninjutsu: 70 });
  assert.deepEqual([card().查克拉上限, card().速度, card().忍术造诣], [240, 80, 70]);
  assert.equal(card().忍阶, '下忍');
  assert.equal(card().查克拉, 40, 'raising a maximum alone must not heal current resources');
  const snapshot = stateManager.snapshot();
  stateManager.restore(snapshot);
  assert.equal(card().查克拉上限, 240, 'loading and reading the card must not truncate growth');
  const encounter = combatSystem.createCombatState({ enemy_name: npc }, stateManager.get());
  assert.equal(encounter.enemy_chakra_max, 240, 'the next encounter must use the grown card');
  assert.equal(encounter.enemy_speed, 80);
});

test('explicit healing restores all resources while omitted resources retain wounds and exhaustion', () => {
  apply({ chakra: 120, vitality: 150, stamina: 100, spirit: 80 });
  assert.deepEqual([card().查克拉, card().生命力, card().体力, card().精神力], [120, 150, 100, 80]);
  apply({ speed: 50 });
  assert.deepEqual([card().查克拉, card().生命力, card().体力, card().精神力], [120, 150, 100, 80]);
  apply({ chakra: 0, vitality: 0, stamina: 0, spirit: 0 });
  apply({ rank: '中忍' });
  assert.deepEqual([card().查克拉, card().生命力, card().体力, card().精神力], [0, 0, 0, 0]);
});

test('incremental practice and learning preserve unmentioned techniques and existing metadata', () => {
  apply({ jutsu: [{ name: '自创·风刃', mastery: 80 }, { name: '自创·水矢', rank: 'C', power: 40, mastery: 10 }] });
  assert.deepEqual(card().忍术.map(technique => technique.名称), ['自创·风刃', '自创·闪身', '自创·水矢']);
  assert.equal(card().忍术[0].熟练度, 80);
  assert.equal(card().忍术[0].威力, 24);
  assert.equal(card().忍术[0].描述, '训练掌握的风刃。');
  apply({ jutsu: [] });
  assert.equal(card().忍术.length, 3, 'an empty unknown list is not an instruction to forget skills');
});

test('newly learned chakra natures append without erasing already known natures', () => {
  apply({ chakra_nature: ['水', '风'] });
  assert.deepEqual(card().查克拉属性, ['风', '水']);
  apply({ chakra_nature: [] });
  assert.deepEqual(card().查克拉属性, ['风', '水']);
});

test('canonical aliases update one technique without replacing the rest of the dossier', () => {
  apply({ jutsu: [{ name: 'Amaterasu', mastery: 50 }] });
  apply({ jutsu: [{ name: '天照', mastery: 90, cost: 7 }] });
  assert.equal(card().忍术.length, 3);
  const technique = card().忍术.find(item => item.数据库ID === 'JT-FIRE-0003');
  assert.equal(technique.熟练度, 90);
  assert.equal(technique.消耗, 7);
});

test('ordinary social updates cannot reset progressed attributes or techniques', () => {
  apply({ chakra_max: 240, jutsu: [{ name: '自创·风刃', mastery: 80 }] });
  const before = structuredClone(card());
  relationshipSystem.processInstruction({ npc, affection_change: 2, reason: '一起完成修行' });
  assert.deepEqual(card(), before);
});

test('legacy English fields cannot override the new canonical combat values', () => {
  stateManager.setSub('_relationships', { [npc]: { combat_stats: {
    rank: '下忍', chakra_max: 150, chakra: 40, ninjutsu: 20, jutsu: []
  } } });
  apply({ chakra_max: 240, ninjutsu: 90 });
  assert.equal(card().查克拉上限, 240);
  assert.equal(card().查克拉, 40);
  assert.equal(card().忍术造诣, 90);
  assert.equal(Object.hasOwn(card(), 'ninjutsu'), false);
  assert.equal(Object.hasOwn(card(), 'chakra_max'), false);
});

test('growth guidance reaches primary and independent/agent updater contracts in both combat modes', () => {
  for (const tacticalCombat of [false, true]) {
    assert.ok(generateMainVarInstructions(false, { tacticalCombat }).includes(NPC_GROWTH_GUIDANCE));
    assert.ok(buildVariableUpdaterRuntimeContract({ tacticalCombat }).includes(NPC_GROWTH_GUIDANCE));
    assert.doesNotMatch(generateMainVarInstructions(false, { tacticalCombat }), /限制在忍阶基准内/);
  }
});

console.log(`${passed}/8 NPC progression regression tests passed.`);
if (failures.length) process.exitCode = 1;
