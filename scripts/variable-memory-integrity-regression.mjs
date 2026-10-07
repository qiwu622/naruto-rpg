import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key), clear: () => storage.clear(),
  key: index => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};
globalThis.fetch = async () => { throw new Error('Regression tests must not call a live model'); };
const [
  { stateManager }, { memorySystem }, { MessagePipeline }, { AIClient },
  { resetMemoryConfig }, { instructionParser },
  { migrateLegacyMemory, prepareContinuityCommit }, { buildContinuityDelta },
  { buildUpdaterObligations }, { projectNarrativeForMemory },
  { AgentContextBroker }, { AgentPipeline }, { buildVariableUpdaterMessages },
  { DEFAULT_VARIABLE_UPDATER_PRESET }
] = await Promise.all([
  import('../js/core/state-manager.js'), import('../js/systems/memory-system.js'),
  import('../js/core/pipeline.js'), import('../js/core/ai-client.js'),
  import('../js/data/memory-config.js'), import('../js/core/instruction-parser.js'),
  import('../js/core/continuity-ledger.js'), import('../js/core/continuity-delta.js'),
  import('../js/core/turn-evidence.js'), import('../js/core/narrative-memory.js'),
  import('../js/core/agent-context-broker.js'), import('../js/core/agent-pipeline.js'),
  import('../js/core/variable-updater.js'), import('../js/data/variable-updater-preset.js')
]);
const pipeline = new MessagePipeline({ memorySystem });
let passed = 0;
let failed = 0;
async function test(name, run) {
  stateManager.reset();
  resetMemoryConfig();
  memorySystem._pendingRecall = [];
  pipeline.chatHistory = [];
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
}
function applyVariables(updates) {
  pipeline._applyInstructions(instructionParser.parse(`<variable>${updates.map(JSON.stringify).join('\n')}</variable>`));
}

await test('inventory gain then consumption uses the quantity at that point in the batch', () => {
  stateManager.update([
    { key: '物品·道具·苦无·数量', op: '=', value: 1 },
    { key: '物品·道具·苦无·品质', op: '=', value: '普通' }
  ]);
  applyVariables([
    { path: 'equipment.tools.苦无.quantity', op: 'add', value: 2 },
    { path: 'equipment.tools.苦无.quantity', op: 'sub', value: 1 }
  ]);
  assert.equal(stateManager.get('物品·道具·苦无·数量'), 2);
  assert.equal(stateManager.get('物品·道具·苦无·品质'), '普通');
});

await test('unselected options do not become fallback memory or model history', () => {
  const story = '你仍在训练场休息。\n[行动] 前往雨隐村夺取秘密卷轴。\n[行动] 与香燐签下血契。';
  const summary = memorySystem.rememberRecentTurn('原地休息', story);
  assert.ok(summary.includes('训练场休息'));
  assert.ok(!summary.includes('血契') && !summary.includes('秘密卷轴'), summary);
  pipeline.chatHistory = [{ role: 'assistant', content: story }];
  const messages = pipeline._buildPrompt('', stateManager.get(), '继续休息', { updaterEnabled: true });
  assert.ok(!messages.some(message => /秘密卷轴|血契/.test(message.content)));
  assert.equal(pipeline.chatHistory[0].content, story, 'old save/display text remains intact');
});

await test('an NPC named only in an option is not evidence of being present', () => {
  stateManager.setSub('_relationships', { 香燐: { name: '香燐', affection: 5 } });
  const obligations = buildUpdaterObligations({ state: stateManager.get(), narrativeResponse: '训练场空无一人。\n[行动] 去找香燐。' });
  assert.ok(!JSON.stringify(obligations.present_npcs).includes('香燐'));
  const events = buildContinuityDelta({ beforeState: stateManager.snapshot(), afterState: stateManager.snapshot(), displayText: '训练场空无一人。\n[行动] 去找香燐。', turn: 1 });
  assert.ok(!JSON.stringify(events).includes('去找香燐'));
});

await test('deep consolidation preserves every fact omitted from its bounded input', async () => {
  stateManager.update([{ key: '系统·回合数', op: '=', value: 50 }]);
  const facts = Array.from({ length: 90 }, (_, i) => `#${i + 1} 独有事实-${i + 1}: ${'不会重复的历史线索'.repeat(14)}`);
  stateManager.setSub('_memory', { facts: facts.join('\n'), meta: { updated_at: 1, sources: {}, last_deep_turn: 0 } });
  let input;
  await memorySystem.deepConsolidate({ chat: async messages => {
    input = JSON.parse(messages.at(-1).content);
    return JSON.stringify({ facts: input.facts, npc_digest: {}, resolved_clues: [], pins: input.pins, era_note: '' });
  }}, { force: true });
  const after = stateManager.getSub('_memory');
  const unseen = facts.filter(fact => !input.facts.includes(fact));
  assert.ok(unseen.length > 0);
  assert.ok(unseen.every(fact => after.facts.includes(fact) || after.archived.includes(fact)), 'unsent facts were lost');
});

await test('NPC summary finishing after loading another branch does not change it', async () => {
  stateManager.update([{ key: '系统·回合数', op: '=', value: 30 }]);
  stateManager.setSub('_meta', { current_node_id: 'node-A', active_branch: 'branch-A' });
  stateManager.setSub('_relationships', { 香燐: {
    pinned: true, summary_turn_counter: 10, summaries: [],
    history: Array.from({ length: 10 }, (_, i) => ({ turn: 30-i, summary: '只在旧分支发生的共同突围' }))
  } });
  let resolveModel;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const original = AIClient.prototype.chatDetailed;
  AIClient.prototype.chatDetailed = async () => {
    signalStarted();
    return new Promise(resolve => { resolveModel = resolve; });
  };
  try {
    const task = pipeline._checkPinnedNpcSummaries({ backend: 'openai', apiUrl: 'https://fixture.invalid/v1', model: 'fixture' });
    await started;
    const branchB = stateManager.snapshot();
    branchB._meta = { ...branchB._meta, current_node_id: 'node-B', active_branch: 'branch-B' };
    branchB._relationships.香燐 = { pinned: true, summary_turn_counter: 4, summaries: [], history: [{ turn: 3, summary: '新分支刚刚相识' }] };
    stateManager.restore(branchB);
    const expected = structuredClone(stateManager.getSub('_relationships'));
    resolveModel({ text: '只在旧分支发生的共同突围让香燐与玩家建立了深厚的信任，他们约定共同调查敌人的藏身之处。'.repeat(3), finishReason: 'stop' });
    await task;
    assert.deepEqual(stateManager.getSub('_relationships'), expected);
  } finally { AIClient.prototype.chatDetailed = original; }
});

await test('facts and pins added after legacy migration still reach the writer', () => {
  stateManager.update([{ key: '系统·回合数', op: '=', value: 20 }]);
  stateManager.setSub('_continuity', migrateLegacyMemory(stateManager.getSub('_continuity'), stateManager.getSub('_memory'), { nodeId: 'node-19', branchId: 'branch_main' }).ledger);
  const before = stateManager.snapshot();
  memorySystem.apply({ summary: '本回合只是正常休息。', facts: ['休息地点记录 MEMORY_FACT_7302'], pins: ['MEMORY_PROMISE_5921'] });
  const events = buildContinuityDelta({ beforeState: before, afterState: stateManager.snapshot(), displayText: '本回合只是正常休息。', memorySummary: '本回合只是正常休息。', turn: 20 });
  stateManager.setSub('_continuity', prepareContinuityCommit({ ledger: stateManager.getSub('_continuity'), legacyMemory: stateManager.getSub('_memory'), events, context: { nodeId: 'node-20', branchId: 'branch_main', turn: 20 } }).ledger);
  const prompt = JSON.stringify(pipeline._buildPrompt('', stateManager.get(), '继续休息', { updaterEnabled: true }));
  assert.ok(prompt.includes('MEMORY_FACT_7302'));
  assert.ok(prompt.includes('MEMORY_PROMISE_5921'));
});

await test('mixed flat/path updates and remove-then-recreate retain chronological order', () => {
  stateManager.update([{ key: '物品·道具·苦无·数量', op: '=', value: 1 }]);
  applyVariables([
    { path: 'equipment.tools.苦无.quantity', op: 'set', value: 5 },
    { key: '物品·道具·苦无·数量', op: '+', value: 2 }
  ]);
  assert.equal(stateManager.get('物品·道具·苦无·数量'), 7);
  applyVariables([
    { path: 'equipment.tools', op: 'remove', key: '苦无' },
    { path: 'equipment.tools.苦无', op: 'set', value: { quantity: 3, description: '新买的苦无' } }
  ]);
  assert.equal(stateManager.get('物品·道具·苦无·数量'), 3);
  assert.equal(stateManager.get('物品·道具·苦无·描述'), '新买的苦无');
});

await test('new skill canonicalization does not move a later removal before its creation', () => {
  applyVariables([
    { path: 'skills.jutsu.影分身之术', op: 'set', value: { name: '影分身之术', mastery: 10 } },
    { path: 'skills.jutsu', op: 'remove', key: '影分身之术' }
  ]);
  assert.equal(stateManager.get().skills.jutsu['影分身之术'], undefined);
});

await test('native, imported and HTML choices are excluded while actual dialogue survives', () => {
  const variants = [
    '你留在训练场。\n[行动 1] 秘密卷轴\n[行动 2] 血契',
    '你留在训练场。\n### 行动选项\n1. 秘密卷轴\n2. 血契\n\n暮色渐浓。',
    '<content>你留在训练场。</content><fox_selc><option>秘密卷轴</option><option>血契</option></fox_selc>',
    '<div>你留在训练场。</div><button data-option="秘密卷轴"><span>秘密卷轴</span></button><a role="button">血契</a>',
    '你留在训练场。\n1.「秘密卷轴」\n2.「血契」',
    '<story_scene>你留在训练场。</story_scene><dream_options>秘密卷轴\n血契</dream_options>'
  ];
  for (const text of variants) {
    const projected = projectNarrativeForMemory(text);
    assert.ok(projected.includes('你留在训练场。'), text);
    assert.ok(!/秘密卷轴|血契/.test(projected), projected);
    assert.equal(projectNarrativeForMemory(projected), projected, 'projection is stable when repeated by downstream consumers');
  }
  assert.equal(projectNarrativeForMemory('「我会回来的。」\n他转身离开。'), '「我会回来的。」\n他转身离开。');
  assert.equal(projectNarrativeForMemory('「我会回来的。」\n「我等你。」'), '「我会回来的。」\n「我等你。」');
  assert.equal(projectNarrativeForMemory('她把写着“行动选项”的卷轴收进背包。'), '她把写着“行动选项”的卷轴收进背包。');
  assert.ok(projectNarrativeForMemory(variants[1]).includes('暮色渐浓。'));
  assert.equal(projectNarrativeForMemory('<think>准备用 <options> 输出选项。</think><content>你仍在训练场。</content><options>去雨隐村</options>'), '你仍在训练场。');
});

await test('updater and agent continuity prompts only receive factual prose, preserving chosen intent', async () => {
  const raw = '<content>你仍在训练场，尚未出发。</content><fox_selc>秘密卷轴\n血契</fox_selc>';
  const messages = buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, {
    state: stateManager.get(), compactState: {}, userInput: '我想去买苦无', enrichedInput: '', narrativeResponse: raw
  });
  const prompt = JSON.stringify(messages);
  assert.ok(prompt.includes('尚未出发'));
  assert.ok(prompt.includes('我想去买苦无'));
  assert.ok(!/秘密卷轴|血契/.test(prompt));
  let request;
  await AgentPipeline.prototype._runContinuityUpdater.call({
    runner: { run: async (_agent, options) => { request = options; return ''; } }, pipeline
  }, stateManager.get(), '我想去买苦无', raw, [], {});
  assert.ok(!/秘密卷轴|血契/.test(request.extraContext.draft));
  assert.equal(request.userInput, '我想去买苦无');
  const { buildNarrativeReviewMessages } = await import('../js/core/narrative-review.js');
  const reviewMessages = buildNarrativeReviewMessages({ candidateResponse: raw });
  assert.ok(reviewMessages.at(-1).content.includes('<fox_selc>秘密卷轴\n血契</fox_selc>'), 'optional review retains the choice boundary');
  assert.ok(reviewMessages[0].content.includes('尚未执行的建议'));
});

await test('agent retrieval projects both saved timeline text and old live history', async () => {
  stateManager.setSub('_meta', { current_node_id: 'node-1', active_branch: 'branch_main' });
  stateManager.update([{ key: '系统·回合数', op: '=', value: 2 }]);
  const story = '你在训练场休息。\n[行动] 秘密卷轴\n[行动] 血契';
  const node = { id: 'node-1', branch_id: 'branch_main', turn_number: 1, player_input: '休息', clean_response: story, chat_history_delta: [{ role: 'assistant', content: story }] };
  const broker = new AgentContextBroker({ timelineSystem: { getAllNodes: async () => [node] } });
  for (const domain of ['world', 'dialogue']) {
    const result = await broker.searchContext({ state: stateManager.get(), domain, query: '训练场' });
    assert.ok(JSON.stringify(result).includes('训练场休息'));
    assert.ok(!/秘密卷轴|血契/.test(JSON.stringify(result)));
  }
  broker.configure({ pipeline: { getHistory: () => [{ role: 'assistant', content: story }, { role: 'user', content: '决定去买苦无' }] } });
  broker.invalidate();
  const live = await broker.searchContext({ state: stateManager.get(), domain: 'dialogue' });
  assert.ok(!/秘密卷轴|血契/.test(JSON.stringify(live)));
  assert.ok(JSON.stringify(live).includes('决定去买苦无'));
  assert.equal(node.clean_response, story);
});

await test('deep consolidation retains unseen NPC notes, pins, clues and history buffer', async () => {
  stateManager.update([{ key: '系统·回合数', op: '=', value: 50 }]);
  const notes = Array.from({ length: 40 }, (_, i) => `人物${i}: ${'独有互动'.repeat(20)}-${i}`);
  const buffer = Array.from({ length: 30 }, (_, i) => `人物${i}: ${'旧时约定'.repeat(18)}-${i}`);
  const pins = Array.from({ length: 8 }, (_, i) => `置顶${i}-${'未解悬念'.repeat(34)}`);
  const clues = Array.from({ length: 25 }, (_, i) => JSON.stringify({ title: `线索${i}`, detail: '情报'.repeat(30), status: '未解' }));
  stateManager.setSub('_memory', {
    facts: '#1 训练场休息。', npc_notes: notes.join('\n'), pins: pins.join('\n'), clues: clues.join('\n'),
    _relationship_buffer: buffer.join('\n'), relationship_history: JSON.stringify({ 人物39: { summary: '先前未展示的编年史' } }),
    meta: { sources: {}, last_deep_turn: 0 }
  });
  let payload;
  let summarizedName;
  await memorySystem.deepConsolidate({ chat: async messages => {
    payload = JSON.parse(messages.at(-1).content);
    summarizedName = payload.npc_notes.at(-1).split(': ')[0];
    return JSON.stringify({ facts: payload.facts, npc_digest: { [summarizedName]: { history: '本次互动摘要', recent: '仍在训练' } }, pins: [], resolved_clues: [{ title: '线索0', resolution: '未提供的内容不应被改写' }] });
  }}, { force: true });
  const after = stateManager.getSub('_memory');
  assert.ok(notes.filter(line => !payload.npc_notes.includes(line) || !line.startsWith(`${summarizedName}: `)).every(line => after.npc_notes.includes(line)));
  assert.ok(pins.filter(line => !payload.pins.includes(line)).every(line => after.pins.includes(line)));
  assert.ok(!payload.clues.includes(clues[0]));
  assert.ok(after.clues.includes(clues[0]));
  assert.ok(buffer.every(line => after._relationship_buffer.includes(line)), 'no buffer entry for this NPC was summarized');
  assert.ok(after.relationship_history.includes('先前未展示的编年史'));
});

await test('an empty NPC digest leaves pending relationship history untouched', async () => {
  stateManager.setSub('_memory', { facts: `#1 ${'休息。'.repeat(40)}`, _relationship_buffer: '香燐: 曾一起突围。', npc_notes: '香燐: 如今在休息。', meta: { sources: {} } });
  let calls = 0;
  await memorySystem.deepConsolidate({ chat: async () => { calls++; return JSON.stringify({ facts: ['#1 休息'], npc_digest: {}, pins: [], era_note: '休息与整理。' }); } }, { force: true });
  assert.equal(calls, 1);
  assert.equal(stateManager.getSub('_memory')._relationship_buffer, '香燐: 曾一起突围。');
});

await test('NPC history consolidation consumes only the reviewed complete lines', async () => {
  const buffer = Array.from({ length: 35 }, (_, i) => `香燐: 第${i}次${'合作突围。'.repeat(15)}`);
  stateManager.setSub('_memory', { facts: '#1 休息', _relationship_buffer: buffer.join('\n'), meta: { sources: {} } });
  let reviewed;
  await memorySystem.deepConsolidate({ chat: async messages => {
    const input = JSON.parse(messages.at(-1).content);
    reviewed = input.npc_history_buffer.split('\n');
    return JSON.stringify({ npc_digest: { 香燐: { history: '数次共同突围增进了彼此信任。' } } });
  } }, { force: true });
  assert.ok(reviewed.length > 0 && reviewed.length < buffer.length);
  const remaining = stateManager.getSub('_memory')._relationship_buffer.split('\n');
  assert.deepEqual(remaining, buffer.filter(line => !reviewed.includes(line)));
});

const completeSummary = '香燐与玩家共同经历追捕与突围，双方的戒备逐渐转化为信任，他们约定抵达安全地点后交换情报。'.repeat(5);
for (const stage of ['repair', 'stage', 'grand']) {
  await test(`late ${stage} NPC summary cannot write after restoring the same node`, async () => {
    stateManager.setSub('_meta', { current_node_id: 'same-node', active_branch: 'same-branch' });
    stateManager.setSub('_relationships', { 香燐: {
      pinned: true, summary_turn_counter: stage === 'stage' ? 10 : 0,
      summaries: stage === 'repair' ? [{ content: '香燐与玩家在', covered_turns: [1] }] : stage === 'grand' ? Array.from({ length: 10 }, (_, i) => ({ turn: i, content: completeSummary })) : [],
      history: Array.from({ length: 10 }, (_, i) => ({ turn: i + 1, summary: '共同突围' }))
    } });
    let finish;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const original = AIClient.prototype.chatDetailed;
    AIClient.prototype.chatDetailed = async () => { started(); return new Promise(resolve => { finish = resolve; }); };
    try {
      const task = pipeline._checkPinnedNpcSummaries({ backend: 'openai', apiUrl: 'https://fixture.invalid/v1', model: 'fixture' });
      await ready;
      const restored = stateManager.snapshot();
      stateManager.restore(restored);
      const expected = stateManager.getSub('_relationships');
      finish({ text: completeSummary, finishReason: 'stop' });
      await task;
      assert.deepEqual(stateManager.getSub('_relationships'), expected);
    } finally { AIClient.prototype.chatDetailed = original; }
  });
}

for (const review of [false, true]) await test(`full turn keeps choices out of committed facts (review=${review})`, async () => {
  const { aiClient } = await import('../js/core/ai-client.js');
  const { createNarrativeArtifact } = await import('../js/core/narrative-artifact.js');
  localStorage.setItem('naruto_api_config', JSON.stringify({ backend: 'tavern', model: 'fixture', aiCallPolicy: { strictSingleCall: false }, variableUpdater: { enabled: true }, narrativeReview: { enabled: review } }));
  localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
  stateManager._apiConfigCache = null;
  stateManager.update([{ key: '玩家·姓名', op: '=', value: '回归测试者' }]);
  aiClient.configure({ backend: 'tavern', model: 'fixture' });
  const story = review ? '<content>你仍在训练场休息。</content><fox_selc>秘密卷轴\n血契</fox_selc>' : '你仍在训练场休息。\n[行动] 秘密卷轴\n[行动] 血契';
  globalThis.generateRaw = async () => story;
  let node;
  let updaterInput;
  const turnPipeline = new MessagePipeline({ memorySystem, timelineSystem: { createNode: async value => { node = value; return { id: 'test-node' }; } } });
  let reviewed = false;
  turnPipeline._resolveNarrativeReview = async ({ candidateArtifact }) => { reviewed = true; return createNarrativeArtifact(candidateArtifact); };
  turnPipeline._runSecondaryVariableUpdate = async request => { updaterInput = request; return null; };
  try {
    const result = await turnPipeline.process('原地休息');
    assert.ok(!result.error, result.error);
    assert.equal(reviewed, review);
    assert.ok(node.aiResponse.includes('秘密卷轴'), 'displayed choices must survive');
    assert.ok(!/秘密卷轴|血契/.test(updaterInput.narrativeResponse));
    assert.ok(!/秘密卷轴|血契/.test(JSON.stringify(node.continuityDelta)));
    assert.ok(!/秘密卷轴|血契/.test(JSON.stringify(node.chatHistory)));
    assert.ok(!/秘密卷轴|血契/.test(JSON.stringify(stateManager.getSub('_memory'))));
  } finally { delete globalThis.generateRaw; }
});

console.log(`Variable/memory integrity: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
