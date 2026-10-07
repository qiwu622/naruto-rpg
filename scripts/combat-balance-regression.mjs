import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { stateManager } from '../js/core/state-manager.js';
import { instructionParser } from '../js/core/instruction-parser.js';
import { MessagePipeline } from '../js/core/pipeline.js';
import { generateMainVarInstructions } from '../js/data/var-schema.js';
import { CANON_DATABASE } from '../js/data/canon-database.js';
import { DEFAULT_VARIABLE_UPDATER_PRESET } from '../js/data/variable-updater-preset.js';
import { calculateCombatLevel } from '../js/systems/combat-level.js';
import {
  normalizeNpcCombatStats,
  normalizeTechnique,
  getTechniqueCostGuidance,
  evaluateTechniqueCostBalance,
  resolveTechniqueCost,
  resolveTechniqueUsage
} from '../js/systems/npc-balance.js';
import { combatSystem } from '../js/systems/combat-system.js';
import { relationshipSystem } from '../js/systems/relationship-system.js';

let passed = 0;

function test(name, fn) {
  stateManager.reset();
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

test('v4 resources migrate losslessly into the v5 vitality and stamina model', () => {
  const legacy = stateManager.getDefaultState();
  legacy._version = '4.0';
  delete legacy._resource_model_version;
  delete legacy['属性·生命力'];
  delete legacy['属性·当前生命力'];
  legacy['属性·体力'] = 300;
  legacy['属性·当前体力'] = 210;
  legacy['属性·意志力'] = 120;
  legacy['属性·当前意志力'] = 75;
  legacy._relationships = {
    旧敌人: { combat_stats: { 体力上限: 200, 体力: 130, 意志力: 90, 精神力: 70 } }
  };

  stateManager.restore(legacy);
  assert.equal(stateManager.get('属性·生命力'), 300);
  assert.equal(stateManager.get('属性·当前生命力'), 210);
  assert.equal(stateManager.get('属性·体力'), 120);
  assert.equal(stateManager.get('属性·当前体力'), 75);
  assert.equal(stateManager.get('属性·意志力'), undefined);
  const npc = stateManager.getSub('_relationships').旧敌人.combat_stats;
  assert.equal(npc.生命力上限, 200);
  assert.equal(npc.生命力, 130);
  assert.equal(npc.体力上限, 90);
  assert.equal(npc.体力, 90);
});

test('NPC rank benchmarks do not truncate supplied stats; numeric domains still apply', () => {
  const card = normalizeNpcCombatStats({
    忍阶: '中忍',
    查克拉: 9999,
    查克拉上限: 9999,
    生命力: 9999,
    生命力上限: 9999,
    体力: 9999,
    体力上限: 9999,
    速度: 9999,
    精神力: 9999,
    精神力上限: 9999,
    幸运: 9999,
    忍术造诣: 999,
    体术造诣: 999,
    幻术造诣: 999
  });

  assert.equal(card.查克拉上限, 9999);
  assert.equal(card.生命力上限, 9999);
  assert.equal(card.体力上限, 9999);
  assert.equal(card.速度, 9999);
  assert.equal(card.精神力, 9999);
  assert.equal(card.精神力上限, 9999);
  assert.equal(card.幸运, 9999);
  assert.equal(card.忍术造诣, 100);
  assert.equal(card.查克拉, card.查克拉上限);
  assert.equal(card.生命力, card.生命力上限);
  assert.equal(card.体力, card.体力上限);
});

test('every opening difficulty label maps to the intended NPC pressure tier', () => {
  const standard = normalizeNpcCombatStats({ 忍阶: '下忍' }, null, { difficulty: '标准' });
  const brutal = normalizeNpcCombatStats({ 忍阶: '下忍' }, null, { difficulty: '残酷' });
  const extremeAlias = normalizeNpcCombatStats({ 忍阶: '下忍' }, null, { difficulty: '极难' });
  const legendary = normalizeNpcCombatStats({ 忍阶: '下忍' }, null, { difficulty: '传说' });

  assert.ok(brutal.生命力上限 > standard.生命力上限, '残酷难度不应回退为标准难度');
  assert.equal(brutal.生命力上限, extremeAlias.生命力上限, '残酷应使用 0.8 压力档');
  assert.ok(legendary.生命力上限 > brutal.生命力上限, '传说难度应继续高于残酷');
});

test('NPC combat level uses the shared attribute and mastery calculation', () => {
  const card = normalizeNpcCombatStats({
    忍阶: '特别上忍',
    查克拉上限: 350,
    生命力上限: 400,
    体力上限: 350,
    精神力上限: 300,
    速度: 120,
    幸运: 30,
    忍术造诣: 90,
    体术造诣: 90,
    幻术造诣: 90
  });
  assert.equal(card.战力等级, 'A级', 'NPC mastery should contribute to the same combat rating as the player');
  assert.equal(card.战力等级, calculateCombatLevel({
    chakra: card.查克拉上限,
    vitality: card.生命力上限,
    stamina: card.体力上限,
    spirit: card.精神力上限,
    speed: card.速度,
    luck: card.幸运
  }, {
    ninjutsu: card.忍术造诣,
    taijutsu: card.体术造诣,
    genjutsu: card.幻术造诣
  }));
});

test('restored NPC cards are upgraded to the shared combat calculation', () => {
  const snapshot = stateManager.getDefaultState();
  snapshot._relationships = {
    测试特上: {
      affection: 0,
      combat_stats: {
        忍阶: '特别上忍',
        查克拉上限: 350,
        查克拉: 350,
        生命力上限: 400,
        生命力: 400,
        体力上限: 350,
        体力: 350,
        精神力上限: 300,
        精神力: 300,
        速度: 120,
        幸运: 30,
        忍术造诣: 90,
        体术造诣: 90,
        幻术造诣: 90,
        战力等级: 'B级'
      }
    }
  };

  stateManager.restore(snapshot);
  assert.equal(stateManager.getSub('_relationships').测试特上.combat_stats.战力等级, 'A级');
});

test('later NPC updates preserve wounded resources and an existing valid card', () => {
  const existing = normalizeNpcCombatStats({
    忍阶: '下忍',
    查克拉: 35,
    查克拉上限: 120,
    生命力: 80,
    生命力上限: 200,
    忍术: [{ 名称: '火遁·炎弹', 等级: 'C', 熟练度: 60, 类型: '忍术' }]
  });
  const updated = normalizeNpcCombatStats({ 忍阶: '下忍' }, existing);

  assert.equal(updated.查克拉, 35);
  assert.equal(updated.生命力, 80);
  assert.deepEqual(updated.忍术, existing.忍术);
});

test('same-rank techniques preserve their independently authored database costs', () => {
  const firstSkill = normalizeTechnique({ rank: 'C', mastery: 60, type: '忍术', cost: 18 });
  const secondSkill = normalizeTechnique({ 等级: 'C', 熟练度: 60, 类型: '忍术', 消耗: 43 });

  assert.equal(resolveTechniqueCost(firstSkill), 18);
  assert.equal(resolveTechniqueCost(secondSkill), 43);
});

test('technique type selects the resource while keeping each database cost', () => {
  const ninjutsu = resolveTechniqueUsage({ rank: 'C', mastery: 0, type: '忍术', cost: 11 });
  const genjutsu = resolveTechniqueUsage({ rank: 'C', mastery: 100, type: '幻术', cost: 37 });
  const taijutsu = resolveTechniqueUsage({ rank: 'C', mastery: 60, type: '体术', cost: 6 });
  assert.deepEqual([ninjutsu.resource, genjutsu.resource, taijutsu.resource], ['查克拉', '精神力', '体力']);
  assert.deepEqual([ninjutsu.cost, genjutsu.cost, taijutsu.cost], [11, 37, 6]);
});

test('cost guidance uses rank-specific chakra spirit and stamina pools', () => {
  const chakra = getTechniqueCostGuidance({ referenceRank: '下忍', resource: '查克拉', pressure: 'standard' });
  const spirit = getTechniqueCostGuidance({ referenceRank: '下忍', resource: '精神力', pressure: 'standard' });
  const stamina = getTechniqueCostGuidance({ referenceRank: '下忍', resource: '体力', pressure: 'standard' });
  assert.deepEqual([chakra.referencePool, spirit.referencePool, stamina.referencePool], [100, 88, 170]);
  assert.deepEqual([chakra.minCost, chakra.maxCost], [13, 20]);
  assert.deepEqual([spirit.minCost, spirit.maxCost], [11, 18]);
  assert.deepEqual([stamina.minCost, stamina.maxCost], [21, 34]);
});

test('database-authored costs are diagnosed without being overwritten', () => {
  const balanced = evaluateTechniqueCostBalance(
    { type: '幻术', cost: 15 },
    { referenceRank: '下忍', pressure: 'standard' }
  );
  const outlier = evaluateTechniqueCostBalance(
    { type: '体术', cost: 80 },
    { referenceRank: '下忍', pressure: 'standard' }
  );
  assert.equal(balanced.status, 'within');
  assert.equal(outlier.status, 'over');
  assert.equal(outlier.cost, 80);
});

test('relationship updates normalize new combat cards without regenerating old ones', () => {
  const first = relationshipSystem.processInstruction({
    npc: '测试中忍',
    忍阶: '中忍',
    查克拉: 5000,
    查克拉上限: 5000,
    生命力: 5000,
    生命力上限: 5000,
    体力: 5000,
    体力上限: 5000,
    速度: 5000,
    精神力: 5000,
    精神力上限: 5000,
    幸运: 5000,
    忍术: [{ 名称: '水遁·水乱波', 等级: 'C', 熟练度: 60, 消耗: 1, 威力: 999 }]
  });
  const originalCard = structuredClone(first.combat_stats);
  const second = relationshipSystem.processInstruction({
    npc: '测试中忍', affection_change: 1, reason: '完成一次对话'
  });

  assert.equal(first.combat_stats.查克拉上限, 5000);
  assert.equal(first.combat_stats['\u5fcd\u672f'][0]['\u6d88\u8017'], 28);
  assert.equal(first.combat_stats['\u5fcd\u672f'][0]['\u6570\u636e\u5e93ID'], 'JT-WATER-0043');
  assert.deepEqual(second.combat_stats, originalCard);
});

test('relationship updates accept nested combat_stats and build a complete NPC card', () => {
  const relationship = relationshipSystem.processInstruction({
    npc: '雾隐追忍',
    combatant: true,
    combat_stats: {
      rank: '中忍',
      attributes: { chakra: 260, vitality: 330, stamina: 290, spirit: 210, speed: 88, luck: 24 },
      masteries: { ninjutsu: 68, taijutsu: 52, genjutsu: 41 },
      chakra_nature: ['水'],
      jutsu: [{ name: '水遁·水乱波', rank: 'C', mastery: 64, type: '忍术' }]
    }
  });

  assert.equal(relationship.combatant, true);
  assert.equal(relationship.combat_stats.忍阶, '中忍');
  assert.equal(relationship.combat_stats.查克拉上限, 260);
  assert.equal(relationship.combat_stats.生命力上限, 330);
  assert.equal(relationship.combat_stats.体力上限, 290);
  assert.equal(relationship.combat_stats.精神力上限, 210);
  assert.equal(relationship.combat_stats.速度, 88);
  assert.equal(relationship.combat_stats.幸运, 24);
  assert.equal(relationship.combat_stats.忍术造诣, 68);
  assert.equal(relationship.combat_stats.忍术[0].名称, '水遁·水乱波');
});

test('civilian relationships can explicitly opt out of combat-card initialization', () => {
  const relationship = relationshipSystem.processInstruction({
    npc: '茶店老板', combatant: false, role: '商人', info: '经营街角茶店。'
  });
  assert.equal(relationship.combatant, false);
  assert.equal(relationship.combat_stats, undefined);
});

test('combat initialization reuses the relationship combat card', () => {
  relationshipSystem.processInstruction({
    npc: '测试对手',
    忍阶: '下忍',
    查克拉: 90,
    查克拉上限: 120,
    生命力: 150,
    生命力上限: 200,
    体力: 140,
    体力上限: 180,
    速度: 50,
    精神力: 80,
    精神力上限: 100,
    幸运: 20,
    忍术: [{ 名称: '火遁·炎弹', 等级: 'C', 熟练度: 60, 类型: '忍术' }]
  });

  combatSystem.processInstruction({
    state: 'start', enemy_name: '测试对手', enemy_rank: '影级', enemy_chakra: 9999
  });
  const combat = combatSystem.getCombatState();

  assert.equal(combat.enemy_rank, '下忍');
  assert.equal(combat.enemy_chakra, 90);
  assert.equal(combat.enemy_chakra_max, 120);
  assert.equal(combat.enemy_jutsu[0].名称, '火遁·炎弹');
});

test('one player action deducts canonical chakra exactly once', () => {
  stateManager.update([
    { key: '属性·查克拉', op: '=', value: 100 },
    { key: '属性·当前查克拉', op: '=', value: 100 },
    { key: '技能·忍术·火遁·炎弹·等级', op: '=', value: 'C' },
    { key: '技能·忍术·火遁·炎弹·消耗', op: '=', value: 25 },
    { key: '技能·忍术·火遁·炎弹·熟练度', op: '=', value: 60 },
    { key: '技能·忍术·火遁·炎弹·类型', op: '=', value: '忍术' }
  ]);
  combatSystem.processInstruction({ state: 'start', enemy_name: '木桩', enemy_rank: '下忍' });
  const pipeline = new MessagePipeline({ combatSystem, relationshipSystem });
  const parsed = instructionParser.parse([
    '<variable>{"path":"attributes.chakra_current","op":"sub","value":25}</variable>',
    '<combat state="player_turn">{"action_name":"火遁·炎弹","chakra_cost":1,"log":"命中"}</combat>'
  ].join('\n'));

  pipeline._applyInstructions(parsed);

  assert.equal(stateManager.get('属性·当前查克拉'), 75);
  assert.equal(combatSystem.getCombatState().last_player_chakra_cost, 25);
});

test('player genjutsu and taijutsu deduct spirit and stamina respectively', () => {
  stateManager.update([
    { key: '属性·精神力', op: '=', value: 100 },
    { key: '属性·当前精神力', op: '=', value: 100 },
    { key: '属性·体力', op: '=', value: 100 },
    { key: '属性·当前体力', op: '=', value: 100 },
    { key: '技能·幻术·奈落见·等级', op: '=', value: 'C' },
    { key: '技能·幻术·奈落见·消耗', op: '=', value: 20 },
    { key: '技能·幻术·奈落见·熟练度', op: '=', value: 60 },
    { key: '技能·幻术·奈落见·类型', op: '=', value: '幻术' },
    { key: '技能·体术·木叶旋风·等级', op: '=', value: 'C' },
    { key: '技能·体术·木叶旋风·消耗', op: '=', value: 30 },
    { key: '技能·体术·木叶旋风·熟练度', op: '=', value: 60 },
    { key: '技能·体术·木叶旋风·类型', op: '=', value: '体术' }
  ]);
  combatSystem.processInstruction({ state: 'start', enemy_name: '木桩' });
  combatSystem.processInstruction({ state: 'player_turn', action_name: '奈落见' });
  assert.equal(stateManager.get('属性·当前精神力'), 80);
  assert.equal(stateManager.get('属性·当前体力'), 100);
  combatSystem.processInstruction({ state: 'player_turn', action_name: '木叶旋风' });
  assert.equal(stateManager.get('属性·当前精神力'), 80);
  assert.equal(stateManager.get('属性·当前体力'), 70);
});

test('insufficient player resource cancels cost and damage', () => {
  stateManager.update([
    { key: '属性·精神力', op: '=', value: 100 },
    { key: '属性·当前精神力', op: '=', value: 10 },
    { key: '技能·幻术·奈落见·等级', op: '=', value: 'C' },
    { key: '技能·幻术·奈落见·消耗', op: '=', value: 25 },
    { key: '技能·幻术·奈落见·类型', op: '=', value: '幻术' }
  ]);
  combatSystem.processInstruction({ state: 'start', enemy_name: '木桩' });
  const before = combatSystem.getCombatState().enemy_vitality;
  combatSystem.processInstruction({ state: 'player_turn', action_name: '奈落见', damage_to_enemy: 50, log: '命中' });
  const combat = combatSystem.getCombatState();
  assert.equal(stateManager.get('属性·当前精神力'), 10);
  assert.equal(combat.enemy_vitality, before);
  assert.equal(combat.player_resource_insufficient, true);
});

test('one enemy action deducts enemy chakra exactly once', () => {
  const canonicalCost = CANON_DATABASE.resolveTechnique('火遁·炎弹').cost;
  relationshipSystem.processInstruction({
    npc: '测试对手', 忍阶: '下忍', 查克拉: 100, 查克拉上限: 120,
    忍术: [{ 名称: '火遁·炎弹', 等级: 'C', 熟练度: 60, 类型: '忍术', 消耗: 25 }]
  });
  combatSystem.processInstruction({ state: 'start', enemy_name: '测试对手' });
  const pipeline = new MessagePipeline({ combatSystem, relationshipSystem });
  const parsed = instructionParser.parse(
    '<combat state="enemy_turn">{"action_name":"火遁·炎弹","chakra_cost":1,"log":"攻击"}</combat>'
  );

  pipeline._applyInstructions(parsed);

  assert.equal(combatSystem.getCombatState().enemy_chakra, 100 - canonicalCost);
  assert.equal(combatSystem.getCombatState().last_enemy_chakra_cost, canonicalCost);
});

test('insufficient NPC resource follows the same failure rule', () => {
  relationshipSystem.processInstruction({
    npc: '幻术测试者', 忍阶: '下忍', 精神力: 10, 精神力上限: 100,
    忍术: [{ 名称: '奈落见', 等级: 'C', 熟练度: 60, 类型: '幻术', 消耗: 25 }]
  });
  stateManager.update([
    { key: '属性·生命力', op: '=', value: 100 },
    { key: '属性·当前生命力', op: '=', value: 100 }
  ]);
  combatSystem.processInstruction({ state: 'start', enemy_name: '幻术测试者' });
  combatSystem.processInstruction({ state: 'enemy_turn', action_name: '奈落见', damage_to_player: 50, log: '命中' });
  const combat = combatSystem.getCombatState();
  assert.equal(combat.enemy_spirit, 10);
  assert.equal(stateManager.get('属性·当前生命力'), 100);
  assert.equal(combat.enemy_resource_insufficient, true);
});

test('secondary updater context includes the existing NPC combat card', () => {
  const pipeline = new MessagePipeline({});
  const evidence = pipeline._compileUpdaterEvidence({
    state: { _relationships: { 卡卡西: {
      affection: 5,
      role: '指导上忍',
      combat_stats: normalizeNpcCombatStats({
        忍阶: '上忍', 查克拉: 200, 查克拉上限: 400,
        忍术: [{ 名称: '雷切', 等级: 'A', 熟练度: 90, 类型: '忍术' }]
      })
    } } },
    userInput: '查看卡卡西',
    narrativeResponse: '卡卡西仍在场。'
  });
  const summary = evidence.current_state.relationships;

  assert.equal(summary.卡卡西.combat_stats.忍阶, '上忍');
  assert.equal(summary.卡卡西.combat_stats.查克拉, 200);
  assert.equal(summary.卡卡西.combat_stats.忍术[0].名称, '雷切');
});

test('main and secondary prompts no longer force unsupported NPC abilities', () => {
  const mainPrompt = generateMainVarInstructions(false);
  const secondaryPrompt = DEFAULT_VARIABLE_UPDATER_PRESET.entries.map(entry => entry.content).join('\n');
  const pipelineSource = readFileSync(new URL('../js/core/pipeline.js', import.meta.url), 'utf8');

  assert.doesNotMatch(mainPrompt, /每个有名字的NPC都必须填写完整战斗数值/);
  assert.doesNotMatch(mainPrompt, /必须使用火影原作中该角色的招牌技能名称/);
  assert.match(mainPrompt, /已有NPC战斗卡/);
  assert.match(secondaryPrompt, /禁止重复生成整张战斗卡/);
  assert.doesNotMatch(pipelineSource, /任何有名字的NPC登场，都必须确保/);
});

test('NPC new canon techniques use database values and keep AI mastery', () => {
  const card = normalizeNpcCombatStats({
    rank: '\u4e0a\u5fcd',
    jutsu: [{ name: 'Amaterasu', rank: 'E', cost: 1, power: 1, mastery: 88 }]
  });
  const skill = card['\u5fcd\u672f'][0];
  assert.equal(skill['\u6570\u636e\u5e93ID'], 'JT-FIRE-0003');
  assert.equal(skill['\u6765\u6e90'], 'canon');
  assert.equal(skill['\u6d88\u8017'], 105);
  assert.equal(skill['\u5a01\u529b'], 200);
  assert.equal(skill['\u719f\u7ec3\u5ea6'], 88);
});

test('NPC new original techniques keep valid AI values and clamp unsafe values', () => {
  const card = normalizeNpcCombatStats({
    rank: '\u4e2d\u5fcd',
    jutsu: [
      { name: 'Original Spear', type: 'jutsu', cost: 22, power: 88, mastery: 55 },
      { name: 'Unsafe Dream', type: 'genjutsu', cost: -9, power: 999, mastery: 140 }
    ]
  });
  const [valid, unsafe] = card['\u5fcd\u672f'];
  assert.deepEqual([valid['\u6d88\u8017'], valid['\u5a01\u529b'], valid['\u6765\u6e90']], [22, 88, 'ai_original']);
  assert.deepEqual([unsafe['\u6d88\u8017'], unsafe['\u5a01\u529b'], unsafe['\u719f\u7ec3\u5ea6']], [1, 300, 100]);
  assert.equal(unsafe['\u6d88\u8017\u8d44\u6e90'], '\u7cbe\u795e\u529b');
});

test('NPC existing canon techniques remain editable while preserving provenance', () => {
  const first = normalizeNpcCombatStats({ rank: '\u4e0a\u5fcd', jutsu: [{ name: 'Amaterasu', mastery: 80 }] });
  const updated = normalizeNpcCombatStats({
    jutsu: [{ name: '\u5929\u7167', rank: 'E', cost: 7, power: 8, mastery: 90 }]
  }, first, { fallbackRank: '\u4e0a\u5fcd' });
  const skill = updated['\u5fcd\u672f'][0];
  assert.equal(skill['\u6570\u636e\u5e93ID'], 'JT-FIRE-0003');
  assert.equal(skill['\u6765\u6e90'], 'canon');
  assert.deepEqual([skill['\u7b49\u7ea7'], skill['\u6d88\u8017'], skill['\u5a01\u529b'], skill['\u719f\u7ec3\u5ea6']], ['E', 7, 8, 90]);
});

console.log(`\n${passed} combat balance regression tests passed.`);
