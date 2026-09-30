import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createOpeningContract,
  deriveOpeningState,
  formatOpeningContractPrompt,
  resolveOpeningContract,
  validateOpeningContractWrite
} from '../js/systems/opening-contract.js';
import { stateManager } from '../js/core/state-manager.js';
import { MessagePipeline } from '../js/core/pipeline.js';
import { AgentRunner } from '../js/core/agent-runner.js';
import { AGENT_MANIFESTS } from '../js/core/agent-manifests.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const customState = {
  '玩家·姓名': '雨宫澪',
  '玩家·性别': '女性',
  '玩家·出身': '雨隐叛忍',
  '玩家·所属村': '雨隐村',
  '玩家·忍阶': '精英上忍',
  '玩家·正式忍阶': '精英上忍',
  '玩家·战力等级': 'A级',
  '玩家·公开身份': '流浪忍者',
  '玩家·当前目标': '寻找失踪的姐姐',
  '世界·地点': '波之国港口',
  '世界·年代': '木叶52年',
  '世界·时间': '木叶52年1月1日·清晨'
};

const choices = {
  persona: '银发独眼，沉默寡言；真实身份不能被普通木叶忍者知道。',
  talent: '__custom_talent__',
  customTalent: { description: '雨虎血继：能感知雨滴，但在晴天完全无效。' },
  background: '__custom_background__',
  customBackground: {
    name: '雨隐叛忍',
    description: '曾是雨隐精英上忍，现为流浪忍者。目标：寻找失踪的姐姐。',
    location: '波之国港口'
  },
  customSkill: { description: '雨感术：只能在降雨范围内感知敌意。' },
  timeline: 'konoha_52'
};

test('contract preserves verbatim custom settings', () => {
  const contract = createOpeningContract({ choices, state: customState });
  assert.equal(contract.version, 1);
  assert.equal(contract.raw.persona, choices.persona);
  assert.equal(contract.raw.talent, choices.customTalent.description);
  assert.equal(contract.raw.background.description, choices.customBackground.description);
  assert.equal(contract.raw.skill, choices.customSkill.description);
  assert.equal(contract.initial_conditions.location, '波之国港口');
  assert.equal(contract.initial_conditions.gender, '女性');
  assert.equal(contract.initial_conditions.rank, '精英上忍');
  assert.equal(contract.initial_conditions.goal, '寻找失踪的姐姐');
});

test('explicit custom opening details override generic defaults', () => {
  const overrides = deriveOpeningState(choices, stateManager.getDefaultState());
  assert.equal(overrides['玩家·忍阶'], '精英上忍');
  assert.equal(overrides['玩家·正式忍阶'], '精英上忍');
  assert.equal(overrides['玩家·战力等级'], 'A级');
  assert.equal(overrides['玩家·所属村'], '雨隐村');
  assert.equal(overrides['玩家·公开身份'], '雨隐叛忍');
  assert.equal(overrides['玩家·当前目标'], '寻找失踪的姐姐');
  assert.equal(overrides['世界·地点'], '波之国港口');
});

test('future ambitions do not become initial rank', () => {
  const overrides = deriveOpeningState({
    persona: '普通忍校学生，梦想成为精英上忍。',
    background: '__custom_background__',
    customBackground: { name: '木叶平民', description: '目标：晋升上忍。', location: '木叶村' }
  }, stateManager.getDefaultState());
  assert.equal(overrides['玩家·忍阶'], '忍校学生');
  assert.equal(overrides['玩家·正式忍阶'], '忍校学生');
});

test('contract prompt establishes precedence and does not reset initial state', () => {
  const contract = createOpeningContract({ choices, state: customState });
  const prompt = formatOpeningContractPrompt(contract);
  assert.match(prompt, /玩家开局契约/);
  assert.match(prompt, /高于世界书与默认开局/);
  assert.match(prompt, /不得用初始地点重置当前地点/);
  assert.match(prompt, /发生转性术/);
  assert.match(prompt, /雨虎血继/);
  assert.match(prompt, /寻找失踪的姐姐/);
});

test('legacy state can rebuild a contract from persistent facts', () => {
  const contract = resolveOpeningContract({
    ...customState,
    '玩家·个性': '谨慎而重视承诺',
    _memory: {
      facts: '自定义天赋: 雨虎血继 - 只能在雨中感知\n自定义初始技能: 雨感术 - 不能在晴天使用'
    }
  });
  assert.ok(contract);
  assert.match(contract.raw.talent, /雨虎血继/);
  assert.match(contract.raw.skill, /雨感术/);
});

test('name and origin stay protected while gender can change', () => {
  const contract = createOpeningContract({ choices, state: customState });
  assert.equal(validateOpeningContractWrite(contract, '玩家·姓名', '另一个名字').allowed, false);
  assert.equal(validateOpeningContractWrite(contract, 'player.gender', '男性').allowed, true);
  assert.equal(validateOpeningContractWrite(contract, '玩家·出身', '木叶平民').allowed, false);
  assert.equal(validateOpeningContractWrite(contract, '玩家·姓名', '雨宫澪').allowed, true);
  assert.equal(validateOpeningContractWrite(contract, 'world_state.current_location', '木叶村').allowed, true);
});

test('old contracts automatically release legacy gender protection', () => {
  const legacyContract = createOpeningContract({ choices, state: customState });
  legacyContract.protected_fields['玩家·性别'] = '女性';
  const migrated = resolveOpeningContract({ ...customState, _opening_contract: legacyContract });
  assert.equal(migrated.protected_fields['玩家·性别'], undefined);
  assert.equal(validateOpeningContractWrite(migrated, 'player.gender', '男性').allowed, true);
});

test('main and agent prompts always receive the opening contract', () => {
  const contract = createOpeningContract({ choices, state: customState });
  const state = {
    ...stateManager.getDefaultState(),
    ...customState,
    _opening_contract: contract
  };
  const pipeline = new MessagePipeline({});
  const mainMessages = pipeline._buildPrompt('继续行动', state, '继续行动');
  const contractMessages = mainMessages.filter(message => message.content?.includes('玩家开局契约'));
  assert.ok(contractMessages.length >= 2);
  assert.ok(contractMessages.some(message => message.role === 'system' && message.content.includes('雨虎血继')));

  const runner = new AgentRunner();
  const agentMessages = runner._buildMessages('brainstormer', AGENT_MANIFESTS.brainstormer, {
    state,
    userInput: '继续行动',
    taskPrompt: '提出剧情方向',
    extraContext: {}
  });
  assert.ok(agentMessages.some(message => message.role === 'system' && message.content.includes('玩家开局契约')));
  assert.ok(agentMessages.some(message => message.content.includes('雨虎血继')));

  const characterMessages = runner._buildMessages('character', AGENT_MANIFESTS.character, {
    state,
    userInput: '继续行动',
    taskPrompt: '扮演当前NPC',
    extraContext: {}
  });
  const npcContract = characterMessages.find(message => message.content?.includes('NPC可知范围'))?.content || '';
  assert.doesNotMatch(npcContract, /真实身份不能被普通木叶忍者知道/);
  assert.match(npcContract, /银发独眼/);
});

test('pipeline rejects AI attempts to overwrite protected identity', () => {
  const contract = createOpeningContract({ choices, state: customState });
  stateManager.restore({
    ...stateManager.getDefaultState(),
    ...customState,
    _opening_contract: contract
  });
  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({
    variables: [
      { key: '玩家·姓名', op: '=', value: '错误名字' },
      { path: 'player.gender', op: 'set', value: '男性' },
      { path: 'world_state.current_location', op: 'set', value: '木叶村' }
    ]
  });
  assert.equal(stateManager.get('玩家·姓名'), '雨宫澪');
  assert.equal(stateManager.get('玩家·性别'), '男性');
  assert.equal(stateManager.get('世界·地点'), '木叶村');
});

test('character creation emits a structured payload and app reads state contract', () => {
  const creatorSource = readFileSync(new URL('../js/ui/character-creator.js', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(creatorSource, /eventBus\.emit\('character:created',\s*payload\)/);
  assert.match(creatorSource, /contract:\s*initialized\._opening_contract/);
  assert.doesNotMatch(creatorSource, /eventBus\.emit\('character:created',\s*s\['玩家·姓名'\]\)/);
  assert.match(appSource, /state\._opening_contract\s*\|\|\s*payload\.contract/);
  assert.doesNotMatch(appSource, /player\.custom_profile/);
});

console.log(`\n${passed} opening contract regression tests passed.`);
