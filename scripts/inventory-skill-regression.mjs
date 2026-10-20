import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { stateManager } from '../js/core/state-manager.js';
import { instructionParser } from '../js/core/instruction-parser.js';
import { MessagePipeline } from '../js/core/pipeline.js';
import { buildVariableUpdaterMessages } from '../js/core/variable-updater.js';
import { generateMainVarInstructions, resolveAlias } from '../js/data/var-schema.js';
import { DEFAULT_VARIABLE_UPDATER_PRESET } from '../js/data/variable-updater-preset.js';
import { resolveCanonTechnique } from '../js/data/canon-database.js';
import { equipmentSystem } from '../js/systems/equipment-system.js';
import {
  CUSTOM_TALENT_PLACEHOLDER,
  buildOpeningState,
  createOpeningDraft
} from '../js/systems/opening-draft.js';
import { createOpeningContract } from '../js/systems/opening-contract.js';
import { skillSystem } from '../js/systems/skill-system.js';

let passed = 0;

function test(name, fn) {
  stateManager.reset();
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

test('variable JSON aliases write the canonical flat keys', () => {
  const parsed = instructionParser.parse('<variable>{"key":"查克拉","op":"=","value":7}</variable>');
  assert.deepEqual(parsed.variables, [{ key: '属性·当前查克拉', op: '=', value: 7 }]);
  stateManager.update(parsed.variables);
  assert.equal(stateManager.get('属性·当前查克拉'), 7);
  assert.equal(Object.prototype.hasOwnProperty.call(stateManager.state, '查克拉'), false);
});

test('status aliases resolve when written through StateManager', () => {
  stateManager.update([{ key: '状态·生命力', op: '=', value: 12 }]);
  assert.equal(stateManager.get('属性·当前生命力'), 12);
  assert.equal(Object.prototype.hasOwnProperty.call(stateManager.state, '状态·生命力'), false);
});

test('inventory quantities above 99 survive updates, consumptions and save restoration', () => {
  for (const category of ['道具', '消耗品', '武器', '防具', '忍具', '素材', '食物', '卷轴', '其他']) {
    const key = `物品·${category}·批量物品·数量`;
    stateManager.update([{ key, op: '=', value: 12000 }, { key, op: '+', value: 300 }]);
    assert.equal(stateManager.get(resolveAlias(key)), 12300, category);
  }
  stateManager.restore(stateManager.snapshot());
  assert.equal(stateManager.get('物品·道具·批量物品·数量'), 12300);
  equipmentSystem.addItem('consumables', '兵粮丸', 1000001);
  assert.equal(equipmentSystem.getConsumables()['兵粮丸'].quantity, 1000001);
  assert.equal(equipmentSystem.useItem('兵粮丸'), true);
  assert.equal(equipmentSystem.getConsumables()['兵粮丸'].quantity, 1000000);
  assert.equal(equipmentSystem.removeItem('consumables', '兵粮丸', Number.POSITIVE_INFINITY), true);
  assert.equal(equipmentSystem.getConsumables()['兵粮丸'], undefined);
});

test('opening inventory quantities are not capped at 9999', () => {
  const draft = createOpeningDraft('custom', { equipment: [{ name: '苦无', category: 'tools', quantity: 1000000 }] });
  assert.equal(draft.equipment[0].quantity, 1000000);
  assert.equal(buildOpeningState(draft)['物品·道具·苦无·数量'], 1000000);
});

test('reducing item quantity to zero removes leftover item fields', () => {
  stateManager.update([
    { key: '物品·消耗品·绷带·数量', op: '=', value: 1 },
    { key: '物品·消耗品·绷带·品质', op: '=', value: '普通' },
    { key: '物品·消耗品·绷带·描述', op: '=', value: '旧绷带' }
  ]);
  stateManager.update([{ key: '物品·消耗品·绷带·数量', op: '-', value: 1 }]);
  assert.deepEqual(
    Object.keys(stateManager.state).filter(key => key.startsWith('物品·消耗品·绷带')),
    []
  );
});

test('discarding all equipment removes every stored field', () => {
  stateManager.update([
    { key: '物品·武器·测试刀·数量', op: '=', value: 3 },
    { key: '物品·武器·测试刀·品质', op: '=', value: '精良' },
    { key: '物品·武器·测试刀·描述', op: '=', value: '用于回归测试' }
  ]);
  assert.equal(equipmentSystem.removeItem('weapons', '测试刀', 999999), true);
  const keys = Object.keys(stateManager.state).filter(key => key.startsWith('物品·武器·测试刀'));
  assert.deepEqual(keys, []);
  assert.equal(stateManager.get().equipment.weapons['测试刀'], undefined);
});

test('discarding a legacy field-only item removes the visible remnant', () => {
  stateManager.update([
    { key: '物品·防具·旧护甲·品质', op: '=', value: '普通' },
    { key: '物品·防具·旧护甲·描述', op: '=', value: '没有数量字段' }
  ]);
  assert.equal(equipmentSystem.removeItem('armor', '旧护甲', 999999), true);
  const keys = Object.keys(stateManager.state).filter(key => key.startsWith('物品·防具·旧护甲'));
  assert.deepEqual(keys, []);
});

test('discarding equipped gear clears its slot and bonus', () => {
  stateManager.update([
    { key: '物品·武器·装备刀·数量', op: '=', value: 1 },
    { key: '物品·武器·装备刀·品质', op: '=', value: '精良' }
  ]);
  const initialSpeed = stateManager.get('属性·速度');
  assert.equal(equipmentSystem.equip('weapon', '装备刀', 'weapons'), true);
  assert.ok(stateManager.get('属性·速度') > initialSpeed);
  assert.equal(equipmentSystem.removeItem('weapons', '装备刀', 999999), true);
  assert.equal(stateManager.get('物品·已装备·武器'), '');
  assert.equal(stateManager.get('属性·速度'), initialSpeed);
});

test('forgetting a flat skill removes every field', () => {
  stateManager.update([
    { key: '技能·忍术·豪火球·等级', op: '=', value: 'C' },
    { key: '技能·忍术·豪火球·熟练度', op: '=', value: 60 },
    { key: '技能·忍术·豪火球·描述', op: '=', value: '喷出火球' }
  ]);
  assert.equal(skillSystem.forgetSkill('jutsu', '豪火球'), true);
  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.startsWith('技能·忍术·豪火球')), []);
});

test('forgetting support and legacy object skills uses the correct category', () => {
  const snapshot = stateManager.getDefaultState();
  snapshot['技能·支援·医疗术·等级'] = 'B';
  snapshot['技能·支援·医疗术·熟练度'] = 40;
  snapshot['技能·体术·木叶旋风'] = { rank: 'C', mastery: 30 };
  stateManager.restore(snapshot);
  assert.equal(skillSystem.forgetSkill('support', '医疗术'), true);
  assert.equal(skillSystem.forgetSkill('taijutsu', '木叶旋风'), true);
  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.includes('医疗术') || key.includes('木叶旋风')), []);
});

test('skill forget buttons bind outside the equipment-only block', () => {
  const source = readFileSync(new URL('../js/ui/panel.js', import.meta.url), 'utf8');
  assert.match(source, /}\s*this\.shadowRoot\.querySelectorAll\('\.skill-forget-btn'\)/);
  assert.match(source, /skillSystem\.forgetSkill\(type, name\)/);
  assert.doesNotMatch(source, /support:\s*'辅助'/);
});

test('AI collection remove deletes every flat item and skill field', () => {
  stateManager.update([
    { key: '技能·忍术·火遁·豪火球·等级', op: '=', value: 'C' },
    { key: '技能·忍术·火遁·豪火球·描述', op: '=', value: '喷出火球' },
    { key: '物品·消耗品·绷带·数量', op: '=', value: 2 },
    { key: '物品·消耗品·绷带·品质', op: '=', value: '普通' },
    { key: '物品·消耗品·绷带·描述', op: '=', value: '止血用品' }
  ]);

  stateManager.batchUpdate([
    { path: 'skills.jutsu', op: 'remove', key: '火遁·豪火球' },
    { path: 'equipment.consumables', op: 'remove', key: '绷带' }
  ]);

  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.includes('火遁·豪火球')), []);
  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.includes('物品·消耗品·绷带')), []);
});

test('AI deletion supports every skill category including legacy support fields', () => {
  const snapshot = stateManager.getDefaultState();
  snapshot['技能·辅助·医疗术·等级'] = 'B';
  stateManager.restore(snapshot);
  stateManager.update([
    { key: '技能·天赋·查克拉控制·描述', op: '=', value: '控制精准' },
    { key: '技能·血继限界·写轮眼·熟练度', op: '=', value: 50 }
  ]);

  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [
    { path: 'skills.support', op: 'remove', key: '医疗术' },
    { path: 'skills.talents', op: 'remove', key: '查克拉控制' },
    { path: 'skills.kekkei_genkai', op: 'remove', key: '写轮眼' }
  ] }, true);

  assert.deepEqual(Object.keys(stateManager.state).filter(key => (
    key.includes('医疗术') || key.includes('查克拉控制') || key.includes('写轮眼')
  )), []);
});

test('opening bloodline flat fields project to one normalized nested skill', () => {
  stateManager.update([
    { key: '技能·血继限界·磁遁·名称', op: '=', value: '磁遁' },
    { key: '技能·血继限界·磁遁·等级', op: '=', value: '初醒' },
    { key: '技能·血继限界·磁遁·熟练度', op: '=', value: 40 },
    { key: '技能·血继限界·磁遁·描述', op: '=', value: '操纵细小金属。' }
  ]);

  assert.deepEqual(stateManager.get().skills.kekkei_genkai['磁遁'], {
    name: '磁遁',
    rank: '初醒',
    mastery: 40,
    description: '操纵细小金属。'
  });
});

test('opening bloodline details stay readable in the AI skill summary', () => {
  stateManager.update([
    { key: '技能·血继限界·磁遁·名称', op: '=', value: '磁遁' },
    { key: '技能·血继限界·磁遁·等级', op: '=', value: '初醒' },
    { key: '技能·血继限界·磁遁·熟练度', op: '=', value: 40 },
    { key: '技能·血继限界·磁遁·描述', op: '=', value: '操纵细小金属。' }
  ]);

  const pipeline = new MessagePipeline({});
  const summary = pipeline._summarizeSkillsCompact(pipeline._scanFlatSkills(stateManager.state), 5);
  assert.match(summary, /磁遁/);
  assert.match(summary, /初醒/);
  assert.match(summary, /40/);
  assert.match(summary, /操纵细小金属/);
  assert.doesNotMatch(summary, /\[object Object\]/);
});

test('AI can progress an explicit opening bloodline during the first story turn', () => {
  const draft = createOpeningDraft('custom', {
    identity: { name: '磁遁测试者' },
    campaign: { aiCompletionMode: 'fill' },
    talents: [{
      type: 'kekkei_genkai',
      name: '磁遁',
      rank: '初醒',
      mastery: 40,
      description: '操纵细小金属。',
      limitations: '大质量目标无效。'
    }]
  });
  const openingState = buildOpeningState(draft, stateManager.getDefaultState());
  openingState._opening_contract = createOpeningContract({ choices: draft, state: openingState });
  stateManager.restore(openingState);

  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [
    { path: 'skills.kekkei_genkai.磁遁.mastery', op: 'set', value: 47 },
    { path: 'skills.kekkei_genkai.磁遁.description', op: 'set', value: '磁场控制比开局时更加稳定。' }
  ] }, true);

  assert.equal(stateManager.get('技能·血继限界·磁遁·熟练度'), 47);
  assert.equal(stateManager.get('技能·血继限界·磁遁·描述'), '磁场控制比开局时更加稳定。');
});

test('AI-generated talent replaces the legacy custom talent placeholder', () => {
  stateManager.update([
    { key: `技能·天赋·${CUSTOM_TALENT_PLACEHOLDER}·名称`, op: '=', value: CUSTOM_TALENT_PLACEHOLDER },
    { key: `技能·天赋·${CUSTOM_TALENT_PLACEHOLDER}·描述`, op: '=', value: '等待AI生成具体天赋' }
  ]);
  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [{
    path: 'skills.talents.天才武感', op: 'set',
    value: { name: '天才武感', rank: '先天', mastery: 20, description: '体术学习速度极快。' }
  }] }, true);
  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.includes(CUSTOM_TALENT_PLACEHOLDER)), []);
  assert.equal(stateManager.get('技能·天赋·天才武感·名称'), '天才武感');
});

test('AI-generated bloodline also replaces the legacy custom talent placeholder', () => {
  stateManager.update([
    { key: `技能·天赋·${CUSTOM_TALENT_PLACEHOLDER}·名称`, op: '=', value: CUSTOM_TALENT_PLACEHOLDER },
    { key: `技能·天赋·${CUSTOM_TALENT_PLACEHOLDER}·描述`, op: '=', value: '等待AI生成具体血继' }
  ]);
  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [{
    path: 'skills.kekkei_genkai.磁遁', op: 'set',
    value: { name: '磁遁', rank: '初醒', mastery: 20, description: '操纵金属砂。' }
  }] }, true);
  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.includes(CUSTOM_TALENT_PLACEHOLDER)), []);
  assert.equal(stateManager.get('技能·血继限界·磁遁·名称'), '磁遁');
});

test('legacy AI bloodline collection writes are not silently discarded', () => {
  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [{
    path: 'skills.kekkei_genkai', op: 'set', value: '写轮眼·单勾玉'
  }] }, true);

  assert.equal(stateManager.get('技能·血继限界'), '写轮眼·单勾玉');
});

test('secondary calendar writes synchronize the numeric world month', () => {
  stateManager.batchUpdate([{
    path: 'world_state.calendar', op: 'set', value: '木叶64年7月15日·正午'
  }]);

  assert.equal(stateManager.get('世界·时间'), '木叶64年7月15日·正午');
  assert.equal(stateManager.get('世界·月份'), 7);
});

test('AI removal of equipped gear clears its slot and applied bonus', () => {
  stateManager.update([
    { key: '物品·武器·查克拉刀·数量', op: '=', value: 1 },
    { key: '物品·武器·查克拉刀·品质', op: '=', value: '精良' }
  ]);
  const initialSpeed = stateManager.get('属性·速度');
  assert.equal(equipmentSystem.equip('weapon', '查克拉刀', 'weapons'), true);
  assert.ok(stateManager.get('属性·速度') > initialSpeed);

  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({
    variables: [{ path: 'equipment.weapons', op: 'remove', key: '查克拉刀' }]
  }, true);

  assert.equal(stateManager.get('物品·已装备·武器'), '');
  assert.equal(stateManager.get('属性·速度'), initialSpeed);
  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.startsWith('物品·武器·查克拉刀')), []);
});

test('multiple AI removals on the same collection are not deduplicated', () => {
  stateManager.update([
    { key: '技能·忍术·火遁·豪火球·等级', op: '=', value: 'C' },
    { key: '技能·忍术·水遁·水乱波·等级', op: '=', value: 'C' }
  ]);

  const pipeline = new MessagePipeline({});
  const parsed = instructionParser.parse([
    '<variable>{"path":"skills.jutsu","op":"remove","key":"火遁·豪火球"}</variable>',
    '<variable>{"path":"skills.jutsu","op":"remove","key":"水遁·水乱波"}</variable>'
  ].join('\n'));
  assert.equal(parsed.variables.length, 2);
  pipeline._applyInstructions(parsed, true);

  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.includes('豪火球') || key.includes('水乱波')), []);
});

test('legacy zero or depleted quantities are normalized to complete item deletion', () => {
  stateManager.update([
    { key: '物品·防具·忍甲·数量', op: '=', value: 1 },
    { key: '物品·防具·忍甲·品质', op: '=', value: '精良' },
    { key: '物品·消耗品·兵粮丸·数量', op: '=', value: 2 },
    { key: '物品·消耗品·兵粮丸·描述', op: '=', value: '恢复体力' }
  ]);
  assert.equal(equipmentSystem.equip('armor', '忍甲', 'armor'), true);

  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [
    { key: '物品·防具·忍甲·数量', op: '=', value: 0 },
    { path: 'equipment.consumables.兵粮丸.quantity', op: 'sub', value: 2 }
  ] }, true);

  assert.equal(stateManager.get('物品·已装备·防具'), '');
  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.includes('忍甲') || key.includes('兵粮丸')), []);
});

test('item-specific remove paths still use equipment cleanup', () => {
  stateManager.update([
    { key: '物品·道具·护符·数量', op: '=', value: 1 },
    { key: '物品·道具·护符·品质', op: '=', value: '精良' }
  ]);
  const initialLuck = stateManager.get('属性·幸运');
  assert.equal(equipmentSystem.equip('accessory1', '护符', 'tools'), true);
  assert.ok(stateManager.get('属性·幸运') > initialLuck);

  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({
    variables: [{ path: 'equipment.tools.护符', op: 'remove' }]
  }, true);

  assert.equal(stateManager.get('物品·已装备·饰品1'), '');
  assert.equal(stateManager.get('属性·幸运'), initialLuck);
  assert.deepEqual(Object.keys(stateManager.state).filter(key => key.includes('护符')), []);
});

test('valid entity removals do not emit invalid-variable warnings', () => {
  stateManager.update([{ key: '技能·忍术·分身术·等级', op: '=', value: 'E' }]);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const pipeline = new MessagePipeline({});
    pipeline._applyInstructions({
      variables: [{ path: 'skills.jutsu', op: 'remove', key: '分身术' }]
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.doesNotMatch(warnings.join('\n'), /invalid or duplicated/);
});

test('main and secondary prompts explain complete item and skill deletion', () => {
  const mainPrompt = generateMainVarInstructions(false);
  const secondaryPrompt = DEFAULT_VARIABLE_UPDATER_PRESET.entries.map(entry => entry.content).join('\n');

  assert.match(mainPrompt, /物品彻底删除[\s\S]*equipment\.consumables[\s\S]*"op":"remove"/);
  assert.match(mainPrompt, /忍术遗忘[\s\S]*skills\.jutsu[\s\S]*"op":"remove"/);
  assert.doesNotMatch(mainPrompt, /【物品删除】设0/);
  assert.match(secondaryPrompt, /学习\/创造\/练习\/升级\/遗忘\/删除/);
  assert.match(secondaryPrompt, /最后一件[\s\S]*"op":"remove"/);
});

test('runtime deletion protocol also upgrades saved legacy updater presets', () => {
  const legacyPreset = {
    name: '旧自定义预设',
    entries: [{
      id: 'legacy',
      enabled: true,
      role: 'system',
      content: '物品用完时，把 quantity 设置为 0。'
    }]
  };
  const messages = buildVariableUpdaterMessages(legacyPreset, {});
  const prompt = messages.map(message => message.content).join('\n');

  assert.match(prompt, /系统强制删除协议/);
  assert.match(prompt, /equipment\.分类[\s\S]*"op":"remove"/);
  assert.match(prompt, /skills\.分类[\s\S]*"op":"remove"/);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /系统强制删除协议[\s\S]*不得合并或遗漏。\s*$/);
  assert.ok(messages.slice(1).every(message => message.role !== 'system'));
});

test('empty legacy updater presets still receive raw input and runtime protocols', () => {
  const messages = buildVariableUpdaterMessages(
    { name: '空预设', entries: [] },
    { userInput: '丢掉最后一卷绷带' }
  );
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /系统强制删除协议/);
  assert.match(messages[0].content, /变量更新完整混合示例/);
  assert.equal(messages.at(-1).role, 'user');
  assert.match(messages.at(-1).content, /\[原始玩家输入\][\s\S]*丢掉最后一卷绷带/);
});

test('new player canon technique replaces AI fields but keeps mastery', () => {
  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [{
    path: 'skills.jutsu.Amaterasu', op: 'set',
    value: { name: 'Amaterasu', rank: 'E', cost: 1, power: 1, mastery: 72, description: 'wrong AI data' }
  }] }, true);

  const skill = stateManager.get().skills.jutsu['\u5929\u7167'];
  assert.equal(skill.technique_id, 'JT-FIRE-0003');
  assert.equal(skill.source, 'canon');
  assert.equal(skill.rank, '\u7279');
  assert.equal(skill.resource_type, '\u67e5\u514b\u62c9');
  assert.equal(skill.cost, 105);
  assert.equal(skill.power, 200);
  assert.equal(skill.mastery, 72);
  assert.notEqual(skill.description, 'wrong AI data');
});

test('new player original technique keeps AI values within safe bounds', () => {
  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [{
    path: 'skills.genjutsu.Original Dream', op: 'set',
    value: { name: 'Original Dream', type: 'genjutsu', cost: -5, power: 999, mastery: 140 }
  }] }, true);

  const skill = stateManager.get().skills.genjutsu['Original Dream'];
  assert.equal(skill.source, 'ai_original');
  assert.equal(skill.resource_type, '\u7cbe\u795e\u529b');
  assert.equal(skill.cost, 1);
  assert.equal(skill.power, 300);
  assert.equal(skill.mastery, 100);
});

test('ambiguous canon alias stays original and existing skills remain editable', () => {
  assert.equal(resolveCanonTechnique('Suiton: Mizurappa').status, 'ambiguous');
  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [{
    path: 'skills.jutsu.Suiton: Mizurappa', op: 'set',
    value: { name: 'Suiton: Mizurappa', cost: 22, power: 66, mastery: 44 }
  }, {
    path: 'skills.jutsu.\u706b\u9041\u00b7\u8c6a\u706b\u7403\u4e4b\u672f', op: 'set',
    value: { name: '\u706b\u9041\u00b7\u8c6a\u706b\u7403\u4e4b\u672f', cost: 1, power: 1, mastery: 61 }
  }] }, true);

  assert.equal(stateManager.get().skills.jutsu['Suiton: Mizurappa'].source, 'ai_original');
  const canonicalName = '\u706b\u9041\u00b7\u8c6a\u706b\u7403\u4e4b\u672f';
  assert.equal(stateManager.get().skills.jutsu[canonicalName].technique_id, 'JT-FIRE-0024');
  pipeline._applyInstructions({ variables: [{
    path: 'skills.jutsu.' + canonicalName + '.cost', op: 'set', value: 9
  }] }, true);
  assert.equal(stateManager.get().skills.jutsu[canonicalName].cost, 9);
});

test('renaming an existing player technique does not canonicalize it as new', () => {
  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({ variables: [{
    path: 'skills.genjutsu.Original Dream', op: 'set',
    value: { name: 'Original Dream', type: 'genjutsu', cost: 12, power: 34, mastery: 56 }
  }] }, true);

  pipeline._applyInstructions({ variables: [{
    path: 'skills.genjutsu.Original Dream.name', op: 'set', value: 'Amaterasu'
  }] }, true);

  const skill = stateManager.get().skills.genjutsu['Original Dream'];
  assert.equal(skill.name, 'Amaterasu');
  assert.equal(skill.source, 'ai_original');
  assert.equal(skill.cost, 12);
  assert.equal(stateManager.get().skills.jutsu['\u5929\u7167'], undefined);
});

console.log(`\n${passed} inventory/skill regression tests passed.`);
