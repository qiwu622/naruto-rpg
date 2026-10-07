import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key)
};
globalThis.customElements ||= { get: () => null };
globalThis.fetch = async () => { throw new Error('Live requests are forbidden in receipt tests'); };
localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
localStorage.setItem('naruto_memory_config', JSON.stringify({ recallEnabled: false }));
localStorage.setItem('naruto_api_config', JSON.stringify({
  backend: 'tavern', model: 'receipt-fixture', disableStreaming: true,
  aiCallPolicy: { strictSingleCall: false }, variableUpdater: { enabled: true, model: 'receipt-fixture' },
  narrativeReview: { enabled: false }
}));
const [{ MessagePipeline }, { stateManager }, { memorySystem }, { aiClient }, { eventBus }] = await Promise.all([
  import('../js/core/pipeline.js'), import('../js/core/state-manager.js'),
  import('../js/systems/memory-system.js'), import('../js/core/ai-client.js'), import('../js/core/event-bus.js')
]);
aiClient.configure({ backend: 'tavern', model: 'receipt-fixture' });
const story = '训练结束后，你收好忍具，与同伴约好明天再来，随后沿小路返回木叶。';
const output = '<variable>{"key":"进度·经验","op":"+","value":4}</variable>'
  + '<memory>{"facts":["完成协作训练"],"summary":"完成训练，与同伴约好明天再来。"}</memory>';
const daily = { issue: '第 8 号' };
let passed = 0;
async function test(name, run) {
  await run(); passed++; console.log(`PASS ${name}`);
}
function fixture({ save = 'success', withMemory = true } = {}) {
  stateManager.state = { ...stateManager.getDefaultState(),
    '玩家·姓名': '回执测试者', '玩家·存活': '是', '世界·时间': 'K052-01-01',
    '世界·年代': 'K052', '世界·地点': '木叶第三训练场', '系统·回合数': 7, '进度·经验': 10
  };
  stateManager._stateVersion++;
  stateManager._apiConfigCache = null;
  globalThis.generateRaw = async () => story;
  const captured = { commits: [], completed: [], errors: [] };
  const dispose = [eventBus.on('pipeline:complete', value => captured.completed.push(value)),
    eventBus.on('pipeline:error', value => captured.errors.push(value))];
  const pipeline = new MessagePipeline({
    memorySystem: withMemory ? memorySystem : null,
    timelineSystem: save === 'none' ? null : { async createNode(value) {
      captured.commits.push(structuredClone(value));
      if (save === 'quota') { const error = new Error('storage full'); error.name = 'QuotaExceededError'; throw error; }
      // Delay across a clock boundary: final runtime duration must include save.
      await new Promise(resolve => setTimeout(resolve, 12));
      return save === 'legacy' ? { id: 'legacy-node' } : { id: 'receipt-node', turn_receipt: structuredClone(value.turnReceipt) };
    } }
  });
  pipeline._runSecondaryVariableUpdate = async () => ({ output, shinobiDaily: daily });
  return { pipeline, captured, close: () => dispose.forEach(fn => fn()) };
}

await test('successful full turn records accepted changes and commits its bounded receipt', async () => {
  const { pipeline, captured, close } = fixture();
  try {
    const result = await pipeline.process('完成训练');
    const receipt = result.turnReceipt;
    assert.equal(receipt.save.status, 'success');
    assert.equal(receipt.variables.status, 'success');
    assert.equal(receipt.memory.status, 'success');
    assert.equal(receipt.daily.status, 'success');
    assert.equal(receipt.variables.changes.find(value => value.label === '经验')?.delta, 4);
    assert.ok(receipt.memory.changes.some(value => value.text.includes('完成协作训练')));
    assert.equal(captured.commits[0].turnReceipt.save.status, 'success');
    assert.equal(captured.commits[0].turnReceipt.durationMs, null, 'elapsed total at atomic save is not the completed total');
    assert.equal(captured.commits[0].turnReceipt.stages.find(value => value.key === 'save').durationMs, null);
    assert.ok(receipt.stages.find(value => value.key === 'save').durationMs >= 10);
    assert.ok(receipt.durationMs >= receipt.stages.find(value => value.key === 'save').durationMs);
    assert.deepEqual(captured.completed[0].turnReceipt, receipt);
  } finally { close(); }
});

await test('safe recovery reports partial variables and the actual retry count', async () => {
  const { pipeline, captured, close } = fixture();
  let attempts = 0;
  pipeline._runSecondaryVariableUpdate = async () => {
    attempts++;
    const error = new Error('invalid updater candidate');
    error.code = 'VARIABLE_UPDATER_OUTPUT_INCONSISTENT';
    error.recovery = { output, appliedCount: 1, droppedCount: 1 };
    error.shinobiDaily = daily;
    throw error;
  };
  pipeline._requestVariableRecoveryDecision = async () => ({ action: 'apply-safe' });
  try {
    const { turnReceipt } = await pipeline.process('完成训练');
    assert.equal(attempts, 2);
    assert.equal(turnReceipt.variables.status, 'partial');
    assert.equal(turnReceipt.stages.find(value => value.key === 'variables').retries, attempts - 1);
    assert.equal(stateManager.get('进度·经验'), 14, 'rejected attempts must not apply twice');
    assert.equal(captured.commits.length, 1);
  } finally { close(); }
});

await test('skip keeps narrative and local fallback memory without claiming variables or daily', async () => {
  const { pipeline, close } = fixture();
  pipeline._runSecondaryVariableUpdate = async () => { throw new Error('updater offline'); };
  pipeline._requestVariableRecoveryDecision = async () => ({ action: 'skip' });
  try {
    const result = await pipeline.process('完成训练');
    assert.equal(result.cleanResponse, story);
    assert.equal(result.turnReceipt.variables.status, 'skipped');
    assert.equal(result.turnReceipt.daily.status, 'skipped');
    assert.equal(result.turnReceipt.memory.status, 'success');
    assert.equal(stateManager.get('进度·经验'), 10);
    assert.ok(result.turnReceipt.memory.changes.length);
  } finally { close(); }
});

await test('repair followed by success reports one retry and only final accepted values', async () => {
  const { pipeline, close } = fixture();
  let attempts = 0;
  pipeline._runSecondaryVariableUpdate = async () => {
    if (++attempts === 1) { const error = new Error('repair needed'); error.code = 'VARIABLE_UPDATER_OUTPUT_INCONSISTENT'; throw error; }
    return { output, shinobiDaily: daily };
  };
  try {
    const { turnReceipt } = await pipeline.process('完成训练');
    assert.equal(turnReceipt.variables.status, 'success');
    assert.equal(turnReceipt.stages.find(value => value.key === 'variables').retries, 1);
    assert.equal(turnReceipt.variables.changes.find(value => value.label === '经验')?.after, '14');
  } finally { close(); }
});

await test('disk failure restores state and history and emits failed receipt with readable draft', async () => {
  const { pipeline, captured, close } = fixture({ save: 'quota' });
  const before = stateManager.snapshot();
  try {
    await assert.rejects(pipeline.process('完成训练'), { code: 'TURN_COMMIT_FAILED' });
    // Prompt construction may hydrate legacy aliases before the turn guard.
    // All gameplay values, memories and the active node must still roll back.
    for (const key of Object.keys(before).filter(key => key.includes('·') || ['_memory', '_meta', '_relationships', '_missions'].includes(key))) {
      assert.deepEqual(stateManager.get(key), before[key], `${key} must roll back`);
    }
    assert.deepEqual(pipeline.chatHistory, []);
    assert.equal(captured.completed.length, 0);
    const failure = captured.errors[0];
    assert.equal(failure.draftResponse, story);
    assert.equal(failure.turnReceipt.save.status, 'failed');
    assert.equal(failure.turnReceipt.save.reasonCode, 'quota');
    assert.equal(failure.turnReceipt.variables.status, 'failed');
    assert.equal(failure.turnReceipt.memory.status, 'failed');
    assert.equal(failure.turnReceipt.variables.changes.length, 0);
    assert.equal(failure.turnReceipt.memory.changes.length, 0);
  } finally { close(); }
});

for (const save of ['legacy', 'none']) await test(`${save} adapter cannot invent durable receipt success`, async () => {
  const { pipeline, close } = fixture({ save, withMemory: false });
  try {
    const { turnReceipt } = await pipeline.process('完成训练');
    assert.equal(turnReceipt.save.status, save === 'legacy' ? 'unknown' : 'skipped');
    assert.equal(turnReceipt.memory.status, 'skipped');
  } finally { close(); }
});

await test('era fallback consumes corrected summaries while preserving the legacy path', () => {
  const pipeline = new MessagePipeline({});
  const state = { _memory: { recent_summary: '如今是木叶64年。', compressed_summary: '旧日回忆' } };
  assert.equal(pipeline._currentKonohaYear(state), 64);
  state._memory.corrections = [{ id: 'era-fix', action: 'correct', field: 'facts', targetText: '木叶64年', replacement: '木叶48年' }];
  assert.equal(pipeline._currentKonohaYear(state), 48);
  assert.equal(state._memory.recent_summary, '如今是木叶64年。', 'projection must preserve correction undo history');
  state['世界·时间'] = '木叶52年';
  assert.equal(pipeline._currentKonohaYear(state), 52, 'explicit state wins over memory fallback');
});

await test('Agent skipped stage stays skipped and optional review success is not invented', async () => {
  const { AgentPipeline } = await import('../js/core/agent-pipeline.js');
  const original = AgentPipeline.prototype.execute;
  localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: true, mode: 'standard' }));
  AgentPipeline.prototype.execute = async function(state, input, progress) {
    progress('brainstorm', 'test');
    eventBus.emit('agent:stage-skip', { stage: 'brainstorm', reason: 'optional provider unavailable' });
    progress('review_outline', 'test');
    progress('final_write', 'test');
    progress('continuity_updater', 'test');
    progress('done', 'test');
    return story;
  };
  const { pipeline, close } = fixture();
  const originalListenerCount = eventBus._listeners.get('agent:stage-skip')?.size || 0;
  try {
    const { turnReceipt } = await pipeline.process('完成训练');
    assert.equal(turnReceipt.stages.find(value => value.key === 'brainstorm')?.status, 'skipped');
    assert.equal(turnReceipt.stages.find(value => value.key === 'review_outline')?.status, 'unknown');
    assert.equal(turnReceipt.stages.find(value => value.key === 'final_write')?.status, 'success');
    assert.equal(turnReceipt.stages.find(value => value.key === 'continuity_updater')?.status, 'skipped');
    assert.equal(eventBus._listeners.get('agent:stage-skip')?.size || 0, originalListenerCount, 'turn listener must be disposed');
  } finally {
    close(); AgentPipeline.prototype.execute = original;
    localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
  }
});
delete globalThis.generateRaw;
console.log(`Turn receipt pipeline regression: ${passed} passed`);
