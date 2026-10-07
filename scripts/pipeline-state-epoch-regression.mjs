import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key)
};
globalThis.customElements ||= { get: () => null };
globalThis.fetch = async () => { throw new Error('Live requests forbidden in epoch tests'); };
localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
localStorage.setItem('naruto_memory_config', JSON.stringify({ recallEnabled: false }));
const [{ MessagePipeline }, { TurnCommitGuard }, { stateManager }, { memorySystem }, { aiClient }, { eventBus }] = await Promise.all([
  import('../js/core/pipeline.js'), import('../js/core/turn-commit.js'), import('../js/core/state-manager.js'),
  import('../js/systems/memory-system.js'), import('../js/core/ai-client.js'), import('../js/core/event-bus.js')
]);
aiClient.configure({ backend: 'tavern', model: 'epoch-fixture' });
const narrative = '你把训练场上的器材整理妥当，回到树荫下休息，准备下一步行动。';
const staleUpdate = '<variable>{"key":"属性·当前查克拉","op":"-","value":31}</variable>'
  + '<memory>{"facts":["旧回合才发生的事实"]}</memory>';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stateFor(name = '旧存档玩家', turn = 7) {
  const state = stateManager.getDefaultState();
  Object.assign(state, { '玩家·姓名': name, '玩家·存活': '是', '玩家·忍阶': '下忍', '世界·地点': '训练场',
    '世界·时间': '木叶48年1月1日', '系统·回合数': turn,
    '属性·生命力': 250, '属性·当前生命力': 250, '属性·查克拉': 120, '属性·当前查克拉': 120,
    '属性·体力': 120, '属性·当前体力': 120, '属性·精神力': 80, '属性·当前精神力': 80 });
  state._meta.current_node_id = `${name}-node`;
  state._meta.active_branch = 'branch_main';
  state._ui.settings.tacticalCombat = false;
  return state;
}
function fixture({ streaming = false, review = false } = {}) {
  localStorage.setItem('naruto_api_config', JSON.stringify({ backend: 'tavern', model: 'epoch-fixture', disableStreaming: !streaming,
    aiCallPolicy: { strictSingleCall: false }, variableUpdater: { enabled: true, model: 'epoch-fixture' },
    narrativeReview: { enabled: review, model: 'epoch-fixture' } }));
  stateManager.state = stateFor(); stateManager._stateVersion++; stateManager._apiConfigCache = null;
  const captured = { commits: [], chunks: [], complete: [], cancelled: [], errors: [] };
  const stops = ['chunk', 'complete', 'cancelled', 'error'].map(key => eventBus.on(`pipeline:${key}`, value => {
    captured[key === 'error' ? 'errors' : key === 'chunk' ? 'chunks' : key].push(value);
  }));
  const pipeline = new MessagePipeline({ memorySystem, timelineSystem: { async createNode(data, { validateCurrent } = {}) {
    validateCurrent?.();
    captured.commits.push(structuredClone(data));
    return { id: 'saved-node', turn_receipt: data.turnReceipt };
  } } });
  pipeline.setHistory([{ role: 'assistant', content: '旧存档历史' }]);
  globalThis.generateRaw = async () => narrative;
  pipeline._runSecondaryVariableUpdate = async () => ({ output: staleUpdate });
  return { pipeline, captured, close: () => stops.forEach(stop => stop()) };
}
function selectNewSave(pipeline) {
  stateManager.restore(stateFor('新存档玩家', 40));
  pipeline.setHistory([{ role: 'assistant', content: '新存档历史' }]);
  return { state: stateManager.snapshot(), history: pipeline.getHistory() };
}
function assertDiscarded(result, fixture, selected) {
  assert.deepEqual(result, { cancelled: true, contextChanged: true, partialResponse: '' });
  assert.deepEqual(stateManager.snapshot(), selected.state, 'old work must never mutate or roll back the selected save');
  assert.deepEqual(fixture.pipeline.getHistory(), selected.history, 'selected history must remain intact');
  assert.equal(fixture.captured.commits.length, 0);
  assert.equal(fixture.captured.complete.length, 0);
  assert.equal(fixture.captured.errors.length, 0, 'stale output must not offer an old-turn retry in the new save');
  assert.equal(fixture.captured.cancelled.length, 1);
  assert.equal(fixture.pipeline.isProcessing, false);
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

await test('abandon releases snapshots without restoring another save and cannot later commit or roll back', async () => {
  const manager = { state: { name: 'A' }, snapshot() { return structuredClone(this.state); }, restore(value) { this.state = value; } };
  const history = [{ content: 'A' }];
  const guard = new TurnCommitGuard({ stateManager: manager, chatHistory: history });
  manager.state = { name: 'B' }; history.splice(0, 1, { content: 'B' });
  assert.equal(guard.abandon(), true);
  assert.equal(guard.abandon(), false); assert.equal(guard.rollback(), false);
  assert.throws(() => guard.commit(), /abandoned/);
  assert.equal(guard.stateSnapshot, null); assert.equal(guard.historySnapshot, null);
  assert.deepEqual(manager.state, { name: 'B' }); assert.deepEqual(history, [{ content: 'B' }]);
});

await test('ordinary noncombat turns still commit variables, memory and history exactly once', async () => {
  const f = fixture();
  try {
    const result = await f.pipeline.process('整理训练器材');
    assert.equal(result.timelineNodeId, 'saved-node');
    assert.equal(f.captured.commits.length, 1);
    assert.equal(stateManager.get('属性·当前查克拉'), 89);
    assert.match(stateManager.getSub('_memory').facts, /旧回合才发生/);
    assert.equal(f.pipeline.getHistory().length, 3);
  } finally { f.close(); }
});

for (const rejects of [false, true]) {
  await test(`main generation ${rejects ? 'failure' : 'success'} after a save switch is discarded before display or writes`, async () => {
    const f = fixture(), started = deferred(), response = deferred();
    globalThis.generateRaw = () => { started.resolve(); return response.promise; };
    try {
      const processing = f.pipeline.process('整理训练器材');
      await started.promise;
      const selected = selectNewSave(f.pipeline);
      if (rejects) response.reject(Object.assign(new Error('late network error'), { partialResponse: narrative.repeat(5) }));
      else response.resolve(narrative);
      assertDiscarded(await processing, f, selected);
      assert.equal(f.captured.chunks.length, 0);
    } finally { f.close(); }
  });
}

await test('A to B to A restores still invalidate an old generation even with identical source state', async () => {
  const f = fixture(), started = deferred(), response = deferred();
  const source = stateManager.snapshot();
  globalThis.generateRaw = () => { started.resolve(); return response.promise; };
  try {
    const processing = f.pipeline.process('整理训练器材');
    await started.promise;
    selectNewSave(f.pipeline);
    stateManager.restore(source);
    f.pipeline.setHistory([{ role: 'assistant', content: '重新选择的旧存档历史' }]);
    const selected = { state: stateManager.snapshot(), history: f.pipeline.getHistory() };
    response.resolve(narrative);
    assertDiscarded(await processing, f, selected);
  } finally { f.close(); }
});

await test('replacing chat history without a restore event also invalidates the old generation', async () => {
  const f = fixture(), started = deferred(), response = deferred();
  globalThis.generateRaw = () => { started.resolve(); return response.promise; };
  try {
    const processing = f.pipeline.process('整理训练器材');
    await started.promise;
    f.pipeline.setHistory([{ role: 'assistant', content: '重新载入的历史' }]);
    const selected = { state: stateManager.snapshot(), history: f.pipeline.getHistory() };
    response.resolve(narrative);
    assertDiscarded(await processing, f, selected);
  } finally { f.close(); }
});

await test('stream callbacks after a restore cannot append stale prose to the newly selected save', async () => {
  const f = fixture({ streaming: true });
  const original = aiClient.chatStream;
  let selected;
  aiClient.chatStream = async (_messages, _options, onChunk) => {
    onChunk('可见的旧回合开头');
    selected = selectNewSave(f.pipeline);
    onChunk('切档后的旧正文');
    return narrative;
  };
  try {
    assertDiscarded(await f.pipeline.process('整理训练器材'), f, selected);
    assert.equal(f.captured.chunks.length, 1);
    assert.equal(f.captured.chunks[0].chunk, '可见的旧回合开头');
  } finally { aiClient.chatStream = original; f.close(); }
});

for (const rejects of [false, true]) {
  await test(`secondary updater ${rejects ? 'failure bypasses recovery' : 'success cannot write'} after a save switch`, async () => {
    const f = fixture(), started = deferred(), response = deferred();
    f.pipeline._runSecondaryVariableUpdate = () => { started.resolve(); return response.promise; };
    f.pipeline._requestVariableRecoveryDecision = () => { throw new Error('stale recovery must not open'); };
    try {
      const processing = f.pipeline.process('整理训练器材');
      await started.promise;
      assert.equal(f.pipeline.getHistory().length, 3, 'a draft transaction is already active');
      const selected = selectNewSave(f.pipeline);
      if (rejects) response.reject(Object.assign(new Error('late updater error'), { safeOutput: staleUpdate }));
      else response.resolve({ output: staleUpdate });
      assertDiscarded(await processing, f, selected);
    } finally { f.close(); }
  });
}

await test('a recovery decision accepted after switching saves cannot apply its safe subset', async () => {
  const f = fixture(), started = deferred(), decision = deferred();
  f.pipeline._runSecondaryVariableUpdate = async () => { throw Object.assign(new Error('invalid variables'), { safeOutput: staleUpdate }); };
  f.pipeline._requestVariableRecoveryDecision = () => { started.resolve(); return decision.promise; };
  try {
    const processing = f.pipeline.process('整理训练器材');
    await started.promise;
    const selected = selectNewSave(f.pipeline);
    decision.resolve({ action: 'apply-safe' });
    assertDiscarded(await processing, f, selected);
  } finally { f.close(); }
});

await test('a narrative review accepted after switching saves cannot display or commit its old artifact', async () => {
  const f = fixture({ review: true }), started = deferred(), decision = deferred();
  f.pipeline._resolveNarrativeReview = async ({ candidateArtifact }) => { started.resolve(); await decision.promise; return candidateArtifact; };
  try {
    const processing = f.pipeline.process('整理训练器材');
    await started.promise;
    const selected = selectNewSave(f.pipeline);
    decision.resolve();
    assertDiscarded(await processing, f, selected);
    assert.equal(f.captured.chunks.length, 0);
  } finally { f.close(); }
});

await test('save adapters receive a current-turn validator and stale save failures never roll back the new save', async () => {
  const f = fixture(), started = deferred(), write = deferred();
  f.pipeline.timelineSystem.createNode = async (_data, { validateCurrent } = {}) => {
    assert.equal(typeof validateCurrent, 'function');
    started.resolve(); await write.promise;
    validateCurrent();
    throw new Error('stale node should not reach durable write');
  };
  try {
    const processing = f.pipeline.process('整理训练器材');
    await started.promise;
    const selected = selectNewSave(f.pipeline);
    write.resolve();
    assertDiscarded(await processing, f, selected);
  } finally { f.close(); }
});

await test('ordinary disk failures still restore the original turn and permit a successful retry', async () => {
  const f = fixture(), source = stateManager.snapshot(), history = f.pipeline.getHistory();
  const createNode = f.pipeline.timelineSystem.createNode;
  f.pipeline.timelineSystem.createNode = async () => { throw new Error('synthetic disk failure'); };
  try {
    await assert.rejects(f.pipeline.process('整理训练器材'), { code: 'TURN_COMMIT_FAILED' });
    assert.equal(stateManager.get('属性·当前查克拉'), source['属性·当前查克拉']);
    assert.equal(stateManager.get('系统·回合数'), source['系统·回合数']);
    assert.deepEqual(stateManager.getSub('_memory'), source._memory);
    assert.deepEqual(f.pipeline.getHistory(), history);
    assert.equal(f.captured.cancelled.length, 0, 'our own rollback is not an external context cancellation');
    f.pipeline.timelineSystem.createNode = createNode;
    assert.equal((await f.pipeline.process('整理训练器材')).timelineNodeId, 'saved-node');
    assert.equal(stateManager.get('属性·当前查克拉'), 89);
  } finally { f.close(); }
});

await test('ordinary user cancellation still rolls back the same save instead of abandoning it', async () => {
  const f = fixture(), started = deferred(), response = deferred();
  const source = stateManager.snapshot(), history = f.pipeline.getHistory();
  f.pipeline._runSecondaryVariableUpdate = () => { started.resolve(); return response.promise; };
  try {
    const processing = f.pipeline.process('整理训练器材');
    await started.promise;
    f.pipeline.cancel();
    response.resolve({ output: staleUpdate });
    assert.deepEqual(await processing, { cancelled: true, partialResponse: '' });
    assert.equal(stateManager.get('属性·当前查克拉'), source['属性·当前查克拉']);
    assert.equal(stateManager.get('系统·回合数'), source['系统·回合数']);
    assert.deepEqual(stateManager.getSub('_memory'), source._memory);
    assert.deepEqual(f.pipeline.getHistory(), history);
    assert.equal(f.captured.commits.length, 0);
    assert.equal(f.captured.cancelled[0].contextChanged, undefined);
  } finally { f.close(); }
});

console.log(`Pipeline state epoch regression: ${passed} passed.`);
