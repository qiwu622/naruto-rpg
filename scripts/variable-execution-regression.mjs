import assert from 'node:assert/strict';
import { runVariableUpdater, validateVariableUpdaterOutput, sanitizeVariableUpdaterOutput, buildVariableUpdaterRuntimeContract } from '../js/core/variable-updater.js';
import { instructionParser } from '../js/core/instruction-parser.js';
import { stateManager } from '../js/core/state-manager.js';
import { MessagePipeline } from '../js/core/pipeline.js';
import { AIClient } from '../js/core/ai-client.js';
import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';
import { missionSystem } from '../js/systems/mission-system.js';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
globalThis.customElements ||= { get: () => null };
globalThis.fetch = async () => { throw new Error('No live model in regression tests'); };
const memory = '<memory>{"summary":"本轮训练完成，获得3点经验。"}</memory>';
const update = '<variable>{"path":"progression.exp","op":"add","value":3}</variable>';
const audit = '<variable_thinking>请求复述：完成训练。各领域已核对。</variable_thinking>';
const daily = `<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`;
const pipeline = new MessagePipeline({});
let passed = 0;
const failures = [];
async function test(name, fn) {
  stateManager.state = { ...stateManager.getDefaultState(), '玩家·姓名': '变量回归测试', '系统·回合数': 8, '进度·经验': 10 };
  stateManager._stateVersion++;
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
function apply(output) {
  const cleaned = sanitizeVariableUpdaterOutput(output);
  const validation = validateVariableUpdaterOutput(cleaned, { state: stateManager.get() });
  assert.equal(validation.valid, true, validation.errors.join('; '));
  const parsed = instructionParser.parse(cleaned);
  pipeline._applyInstructions(parsed, true);
  return parsed;
}

await test('validated mixed-case business tags actually execute', () => {
  const parsed = apply(audit + update.replaceAll('variable', 'VARIABLE') + memory);
  assert.equal(parsed.variables.length, 1);
  assert.equal(stateManager.get('进度·经验'), 13);
});

await test('legacy and structured variables execute in the model output order', () => {
  apply(audit + '<variable>{"path":"progression.exp","op":"set","value":20}</variable><var>进度·经验 + 3</var>' + memory);
  assert.equal(stateManager.get('进度·经验'), 23);
});

await test('quoted example in variable audit never becomes an executable update', () => {
  const nested = `<variable_thinking>本次不要执行这个示例：${update.replace('3}', '999}')}</variable_thinking>`;
  const parsed = apply(nested + update + memory);
  assert.equal(parsed.variables.length, 1);
  assert.equal(stateManager.get('进度·经验'), 13);
});

await test('generic reasoning examples cannot survive updater sanitization as real writes', () => {
  const nested = `<thinking>这是未采用方案：${update.replace('3}', '999}')}</thinking>`;
  const parsed = apply(nested + audit + update + memory);
  assert.equal(parsed.variables.length, 1);
  assert.equal(stateManager.get('进度·经验'), 13);
});

await test('missing audit prose is advisory when executable state and factual memory are valid', () => {
  const cleaned = sanitizeVariableUpdaterOutput(update + memory);
  const validation = validateVariableUpdaterOutput(cleaned, { state: stateManager.get(), updateObligations: {} });
  assert.equal(validation.valid, true, validation.errors.join('; '));
  assert.ok(validation.warnings.some(message => message.includes('variable_thinking')));
  apply(cleaned);
  assert.equal(stateManager.get('进度·经验'), 13);
});

await test('all JSON business tag readers use the same audit boundary and casing', () => {
  const fake = '<mission>{"id":"fake","status":"completed"}</mission><relationship>{"npc":"假的人物"}</relationship><memory>{"summary":"未发生"}</memory>';
  const parsed = instructionParser.parse(`<variable_thinking>${fake}</variable_thinking><MISSION>{"id":"real","status":"progress"}</MISSION><RELATIONSHIP>{"npc":"山田","trust_change":2}</RELATIONSHIP><EVENT>{"id":"event-real","status":"occurred","description":"已发生"}</EVENT><MEMORY>{"summary":"实际发生"}</MEMORY>`);
  assert.deepEqual(parsed.missions.map(value => value.id), ['real']);
  assert.deepEqual(parsed.relationships.map(value => value.npc), ['山田']);
  assert.deepEqual(parsed.events.map(value => value.id), ['event-real']);
  assert.deepEqual(parsed.memories.map(value => value.summary), ['实际发生']);
});

await test('combat executes the validated tag state even if JSON repeats a contradictory state', () => {
  const parsed = apply(audit + '<combat state="start">{"state":"defeat","enemy_name":"对练忍者","enemy_rank":"下忍"}</combat>' + memory);
  assert.equal(parsed.combat.state, 'start');
});

await test('consecutive JSON objects keep braces and escaped quotes inside strings as data', () => {
  const npcA = { npc: '山田', trust_change: 2, reason: '信封上写着 { 未完，另有 "字迹"' };
  const npcB = { npc: '茶店老板', affection_change: 1, reason: '归还物品' };
  const parsed = apply(audit + `<relationship>${JSON.stringify(npcA)}${JSON.stringify(npcB)}</relationship>` + memory);
  assert.deepEqual(parsed.relationships.map(value => value.npc), ['山田', '茶店老板']);
  assert.equal(parsed.relationships[0].reason, npcA.reason);
});

await test('an agreed mission reward is recorded without prematurely crediting money or experience', () => {
  const beforeMoney = stateManager.get('进度·金钱');
  const beforeExp = stateManager.get('进度·经验');
  const output = audit + '<mission>{"id":"escort","status":"active","title":"护送药材","rank":"C","objective":"明天护送车队","deadline":"明天","reward_ryo":3000}</mission>' + memory;
  const validation = validateVariableUpdaterOutput(output, { state: stateManager.get() });
  assert.equal(validation.valid, true, validation.errors.join('; '));
  const parsed = instructionParser.parse(output);
  new MessagePipeline({ missionSystem })._applyInstructions(parsed, true);
  assert.equal(stateManager.getSub('_missions').active.escort.reward_ryo, 3000);
  assert.equal(stateManager.getSub('_missions').active.escort.deadline, '明天');
  assert.equal(stateManager.get('进度·金钱'), beforeMoney);
  assert.equal(stateManager.get('进度·经验'), beforeExp);
  const contract = buildVariableUpdaterRuntimeContract({ state: stateManager.get(), includeDaily: false });
  assert.match(contract, /尚未领取.*漏掉.*报酬/);
  assert.match(contract, /reward_ryo.*reward_exp/);
});

await test('a token-limit ending cannot be silently accepted as a complete variable result', async () => {
  const original = AIClient.prototype.chatDetailed;
  AIClient.prototype.chatDetailed = async () => ({ text: audit + update + memory + daily, finishReason: 'length' });
  try {
    await assert.rejects(() => runVariableUpdater({ mainConfig: { backend: 'tavern', model: 'fixture',
      variableUpdater: { enabled: true, streaming: false } }, state: stateManager.get(),
      userInput: '完成训练', narrativeResponse: '训练完成，获得3点经验。' }), error => {
      assert.equal(error.failureKind, 'truncated');
      assert.equal(error.repairContext.stateOutput, '', 'a possibly incomplete set of writes must not be locked in');
      return true;
    });
  } finally { AIClient.prototype.chatDetailed = original; }
});

console.log(`${passed} variable execution tests passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
