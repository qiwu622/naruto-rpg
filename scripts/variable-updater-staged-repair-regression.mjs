import assert from 'node:assert/strict';
import {
  runVariableUpdater,
  validateVariableUpdaterOutput,
  VARIABLE_UPDATE_DOMAINS
} from '../js/core/variable-updater.js';
import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';
import { instructionParser } from '../js/core/instruction-parser.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.customElements ||= { get: () => null };

let passed = 0;
const failures = [];
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
  finally { delete globalThis.generateRaw; }
}
const headings = ['时间地点与地图', '资源与属性成长', '技能与能力', '物品、金钱与装备',
  '任务、目标、声望与历练', '人物关系与NPC状态', '战斗、伤势与世界事件', '记忆、线索、约定与待办'];
const thinking = `<variable_thinking>请求复述：完成训练\n${headings.join('\n')}</variable_thinking>`;
const manifest = `<update_manifest>${JSON.stringify({
  domains: Object.fromEntries(VARIABLE_UPDATE_DOMAINS.map(({ id }) => [id, id === 'attributes' ? 'updated' : 'unchanged'])),
  present_npcs: {}, active_missions: {}
})}</update_manifest>`;
const stateOutput = `${thinking}\n${manifest}\n<variable>{"path":"progression.exp","op":"add","value":3}</variable>\n<memory>{"summary":"训练完成，获得3点经验。"}</memory>`;
const daily = value => `<shinobi_daily>${JSON.stringify(value)}</shinobi_daily>`;
const validDaily = daily(SHINOBI_DAILY_EXAMPLE);
const invalidDaily = daily({ ...SHINOBI_DAILY_EXAMPLE, headline: { ...SHINOBI_DAILY_EXAMPLE.headline, title: '木叶交通' } });
const params = {
  mainConfig: { backend: 'tavern', model: 'mock-main', variableUpdater: {
    enabled: true, backend: 'inherit', model: 'mock-updater', streaming: false
  } },
  userInput: '完成训练', enrichedInput: '完成训练', narrativeResponse: '训练完成，获得3点经验。',
  state: { '系统·回合数': 8, _missions: { active: {} }, _relationships: {} },
  compactState: { turn: 8 }, updateObligations: { present_npcs: [], active_missions: [] }
};
async function reject(output, overrides = {}) {
  globalThis.generateRaw = async () => output;
  try { await runVariableUpdater({ ...params, ...overrides }); }
  catch (error) { return error; }
  assert.fail('fixture should be rejected');
}
const promptText = options => [...(options.ordered_prompts || []).filter(x => typeof x === 'object').map(x => x.content), options.user_input].join('\n');

await test('audit wording cannot reject otherwise valid state updates', () => {
  const result = validateVariableUpdaterOutput(stateOutput.replace('技能与能力', '技能'), params);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.ok(result.warnings.some(x => x.includes('技能与能力')));
});

await test('domain coverage is computed locally without concealing a missing promised mission', () => {
  const result = validateVariableUpdaterOutput(stateOutput.replace(manifest, ''), params);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.manifest.domains.attributes, 'updated');
  assert.equal(result.manifest.domains.equipment, 'unchanged');
  const promised = stateOutput.replace('"active_missions":{}', '"active_missions":{"training":"updated"}');
  const invalid = validateVariableUpdaterOutput(promised, { ...params, updateObligations: { active_missions: [{ id: 'training' }] } });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(x => x.includes('training')));
});

await test('daily-only repair preserves validated variables even if the model attempts to rewrite them', async () => {
  const error = await reject(`${stateOutput}\n${invalidDaily}`);
  assert.equal(error.failureKind, 'daily');
  assert.equal(error.repairContext.stage, 'daily');
  assert.equal(error.repairContext.stateOutput, stateOutput);
  let prompt;
  let receivedDaily;
  globalThis.generateRaw = async options => {
    prompt = promptText(options);
    return `${stateOutput.replace('"value":3', '"value":999')}\n${validDaily}`;
  };
  const output = await runVariableUpdater({ ...params, repairContext: error.repairContext,
    repairCandidate: error.failedOutput, correctionInstruction: error.message,
    onShinobiDaily: value => { receivedDaily = value; } });
  assert.equal(output, stateOutput);
  assert.equal(instructionParser.parse(output).variables[0].value, 3);
  assert.deepEqual(receivedDaily, SHINOBI_DAILY_EXAMPLE);
  assert.match(prompt, /只修复.*日报/);
  assert.doesNotMatch(prompt, /完成全部变量标签后/);
});

await test('derived manifests still reject missing or duplicate new mission writes and invalid section types', () => {
  const declared = stateOutput.replace('"active_missions":{}', '"active_missions":{"M_NEW":"updated"}');
  assert.equal(validateVariableUpdaterOutput(declared, params).valid, false);
  const mission = '<mission>{"id":"M_NEW","status":"active","title":"巡逻","rank":"D","objective":"完成巡逻"}</mission>';
  assert.equal(validateVariableUpdaterOutput(`${stateOutput}\n${mission}\n${mission}`, params).valid, false);
  for (const value of ['null', 'false', '[]']) {
    const invalid = stateOutput.replace('"active_missions":{}', `"active_missions":${value}`);
    assert.equal(validateVariableUpdaterOutput(invalid, params).valid, false);
  }
});

await test('state-only repair keeps the previously validated daily and accepts no regenerated daily', async () => {
  const broken = stateOutput.replace('progression.exp', 'attributes.not_real');
  const error = await reject(`${broken}\n${validDaily}`);
  assert.equal(error.failureKind, 'state');
  assert.equal(error.repairContext.stage, 'state');
  let receivedDaily;
  let prompt;
  globalThis.generateRaw = async options => { prompt = promptText(options); return stateOutput; };
  const output = await runVariableUpdater({ ...params, repairContext: error.repairContext,
    repairCandidate: error.failedOutput, correctionInstruction: error.message,
    onShinobiDaily: value => { receivedDaily = value; } });
  assert.equal(output, stateOutput);
  assert.deepEqual(receivedDaily, SHINOBI_DAILY_EXAMPLE);
  assert.match(prompt, /日报已通过校验/);
});

await test('failed and empty daily repairs retain the original valid state for the next attempt', async () => {
  const first = await reject(`${stateOutput}\n${invalidDaily}`);
  const second = await reject('', { repairContext: first.repairContext });
  assert.equal(second.repairContext.stage, 'daily');
  assert.equal(second.repairContext.stateOutput, stateOutput);
  const third = await reject(invalidDaily, { repairContext: second.repairContext });
  assert.equal(third.repairContext.stateOutput, stateOutput);
  assert.match(third.failedOutput, /progression.exp/);
});

await test('a candidate from a different turn cannot reuse validated state', async () => {
  const error = await reject(`${stateOutput}\n${invalidDaily}`);
  const nextTurn = { ...params, userInput: '领取奖励', narrativeResponse: '领取50两。', repairContext: error.repairContext };
  globalThis.generateRaw = async () => validDaily;
  await assert.rejects(() => runVariableUpdater(nextTurn), nextError => {
    assert.equal(nextError.repairContext.stateOutput, '');
    return true;
  });
});

await test('invalid variable types remain hard errors', async () => {
  const error = await reject(`${stateOutput.replace('"value":3', '"value":"not-a-number"')}\n${validDaily}`);
  assert.equal(error.failureKind, 'state');
  assert.ok(error.validation.errors.some(x => x.includes('数字')));
});

await test('pipeline repairs only the daily and commits the original variables exactly once', async () => {
  const [{ MessagePipeline }, { stateManager }, { aiClient }, { eventBus }] = await Promise.all([
    import('../js/core/pipeline.js'), import('../js/core/state-manager.js'),
    import('../js/core/ai-client.js'), import('../js/core/event-bus.js')
  ]);
  localStorage.setItem('naruto_api_config', JSON.stringify({ ...params.mainConfig,
    disableStreaming: true, aiCallPolicy: { strictSingleCall: false }, narrativeReview: { enabled: false } }));
  localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
  localStorage.setItem('naruto_memory_config', JSON.stringify({
    aiCompressionEnabled: false, deepEnabled: false, npcSummaryEnabled: false, recallEnabled: false
  }));
  localStorage.setItem('naruto_rpg_image_settings_v1', JSON.stringify({ enabled: false }));
  const snapshot = stateManager.getDefaultState();
  Object.assign(snapshot, { '玩家·姓名': '分段修复测试', '玩家·存活': '是', '世界·时间': 'K052-01-01',
    '世界·年代': 'K052', '系统·回合数': 8, '进度·经验': 10 });
  stateManager.state = snapshot;
  stateManager._stateVersion++;
  stateManager._apiConfigCache = null;
  aiClient.configure({ backend: 'tavern', model: 'mock-main' });
  let updaterCalls = 0;
  let dialogs = 0;
  const off = eventBus.on('pipeline:variable-recovery-decision', () => { dialogs++; return { action: 'skip' }; });
  globalThis.generateRaw = async options => {
    if (options?.custom_api?.model !== 'mock-updater') return params.narrativeResponse;
    updaterCalls++;
    assert.equal(stateManager.get('进度·经验'), 10, 'no state mutation until both components validate');
    if (updaterCalls === 1) return `${stateOutput}\n${invalidDaily}`;
    assert.match(promptText(options), /只修复.*日报/);
    return validDaily;
  };
  try {
    const result = await new MessagePipeline({}).process('完成训练');
    assert.equal(updaterCalls, 2);
    assert.equal(dialogs, 0);
    assert.equal(stateManager.get('进度·经验'), 13);
    assert.equal(stateManager.get('系统·回合数'), 9);
    assert.deepEqual(result.shinobiDaily, SHINOBI_DAILY_EXAMPLE);
  } finally { off(); }
});

console.log(`\n${passed} staged updater repair tests passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
