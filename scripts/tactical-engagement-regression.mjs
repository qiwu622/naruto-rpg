import assert from 'node:assert/strict';
import { detectTacticalEngagement, buildTacticalEncounterGuidance, TACTICAL_ENCOUNTER_GUIDANCE, TACTICAL_ENCOUNTER_REGISTRATION_GUIDANCE } from '../js/systems/tactical-engagement.js';

const state = { '玩家·姓名': '起物', _relationships: { 训练对手: { combatant: true }, 场外人物: { combatant: true } } };
const history = story => [{ role: 'assistant', content: story }];
const scene = '训练对手站在你的对面，正在等待回应。';
let passed = 0;
const test = (name, run) => { run(); passed++; console.log(`PASS ${name}`); };
test('clear present player attacks retain stable trigger', () => {
  for (const input of ['我向训练对手发起攻击', '向训练对手发起攻击', '我立即攻击训练对手', '起物对训练对手发动攻击']) {
    assert.equal(detectTacticalEngagement(state, input, history(scene))?.enemy_name, '训练对手', input);
  }
});
test('refusal, invitations, questions and quoted NPC speech do not auto-charge', () => {
  for (const input of ['我拒绝与训练对手交战', '我向训练对手提出切磋邀请，等待他的答复', '我问训练对手：你愿意切磋吗？', '我向训练对手发起攻击吗', '训练对手说“准备开战”，我保持沉默', '我说“向训练对手发起攻击”，随后等待答复', '训练对手向我发起攻击，我观察情况']) {
    assert.equal(detectTacticalEngagement(state, input, history(scene)), null, input);
  }
});
test('hypothetical, future, past, negated and planned statements remain narration', () => {
  for (const input of ['如果训练对手同意，我向训练对手发起攻击', '我计划向训练对手发起攻击', '我准备向训练对手发起攻击', '我不会向训练对手发起攻击', '昨天我向训练对手发起攻击', '我向训练对手发起攻击前先询问意见', '我考虑攻击训练对手', '我拒绝攻击训练对手，保持戒备']) {
    assert.equal(detectTacticalEngagement(state, input, history(scene)), null, input);
  }
});
test('unchosen action options cannot supply input or presence evidence', () => {
  assert.equal(detectTacticalEngagement(state, '<options>我向训练对手发起攻击</options>', history(scene)), null);
  assert.equal(detectTacticalEngagement(state, '我向训练对手发起攻击', history('你独自在训练场。<options>训练对手站在对面，可以攻击。</options>')), null);
  assert.equal(detectTacticalEngagement(state, '我向训练对手发起攻击', history('你独自在训练场。\n行动选项：\n1. 训练对手站在对面，可以攻击。')), null);
});
test('mere relationship and historical mentions do not establish physical presence', () => {
  for (const story of ['你想起训练对手站在这里的往事。', '训练对手不在场。', '训练对手不在你对面。', '训练对手已经离开了训练场。', '训练对手在远方执行任务。', '你读到训练对手的来信，他说要切磋。', '你望着训练对手的画像。', '鸣人提起训练对手曾经的战绩。', '训练对手站在面前。随后训练对手已离开。', '鸣人说“训练对手就在面前”，随后笑起来。']) {
    assert.equal(detectTacticalEngagement(state, '我向训练对手发起攻击', history(story)), null, story);
  }
  const absent = structuredClone(state); absent._relationships.训练对手.present = false;
  assert.equal(detectTacticalEngagement(absent, '我向训练对手发起攻击', history(scene)), null);
});
test('sparring requires accepted invitation and actual start, not mere challenge', () => {
  assert.equal(detectTacticalEngagement(state, '我与训练对手开始切磋', history(scene)), null);
  assert.equal(detectTacticalEngagement(state, '我与训练对手开始切磋', history('训练对手站在面前，但没有同意切磋。')), null);
  assert.equal(detectTacticalEngagement(state, '我向训练对手发起挑战', history(scene)), null);
  const agreed = '训练对手站在你面前，点头同意了切磋邀请。';
  assert.equal(detectTacticalEngagement(state, '我与训练对手开始切磋', history(agreed))?.objective, '切磋');
  assert.equal(detectTacticalEngagement(state, '我与训练对手开始切磋', history('昨天训练对手答应了切磋。今天你独自站在训练场。')), null);
});
test('multiple actual targets and already active combats defer to existing combat flow', () => {
  const present = history('训练对手站在你面前。场外人物来到身旁。');
  assert.equal(detectTacticalEngagement(state, '我向训练对手发起攻击，同时攻击场外人物', present), null);
  assert.equal(detectTacticalEngagement({ ...state, _combat: { is_active: true } }, '我向训练对手发起攻击', history(scene)), null);
});
test('single-model contract registers actual combat with a literal structured example', () => {
  const prompt = buildTacticalEncounterGuidance({ updaterOwned: false });
  assert.equal(TACTICAL_ENCOUNTER_GUIDANCE, prompt);
  assert.match(prompt, /正文主模型在完成故事后同时承担战斗状态登记/u);
  const example = prompt.match(/<combat state="start">([^<]+)<\/combat>/u);
  assert.ok(example);
  assert.deepEqual(JSON.parse(example[1]), { enemy_name: '训练对手', enemy_rank: '下忍', objective: '切磋', distance: '中', environment: { terrain: '训练场', weather: '晴' } });
  assert.match(prompt, /不会自动开战/u);
  assert.match(prompt, /不要用变量写入 _combat 或 _ui/u);
  assert.match(prompt, /不要创建“显示战斗面板”等平行布尔变量/u);
  assert.match(prompt, /已有活动战斗不重复输出 start/u);
});
test('updater-owned main writer gets narrative duties without conflicting tag example', () => {
  const prompt = buildTacticalEncounterGuidance({ updaterOwned: true });
  assert.match(prompt, /由后续独立变量模型或 Agent 连续性更新模型负责/u);
  assert.match(prompt, /不要输出任何 combat 或变量结构标签/u);
  assert.ok(!prompt.includes('<combat'));
  assert.match(prompt, /不能根据未执行的玩家意图启动战斗/u);
  assert.ok(TACTICAL_ENCOUNTER_REGISTRATION_GUIDANCE.includes('<combat state="start">'));
  assert.match(TACTICAL_ENCOUNTER_REGISTRATION_GUIDANCE, /最终正文/u);
});
console.log(`Tactical engagement regressions: ${passed} passed`);
