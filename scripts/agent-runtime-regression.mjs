import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.customElements ||= { get: () => null };

const [
  { AgentRunner, evidenceAudienceForAgent },
  { AgentPipeline, AGENT_PIPELINE_REVISION, normalizeWritingOutlineResult },
  agentManifestModule,
  { MessagePipeline },
  { aiClient },
  { stateManager }
] = await Promise.all([
  import('../js/core/agent-runner.js'),
  import('../js/core/agent-pipeline.js'),
  import('../js/core/agent-manifests.js'),
  import('../js/core/pipeline.js'),
  import('../js/core/ai-client.js'),
  import('../js/core/state-manager.js')
]);

const { SHINOBI_DAILY_EXAMPLE } = await import('../js/core/shinobi-daily.js');
const { VARIABLE_UPDATER_MIXED_EXAMPLE } = await import('../js/data/prompts.js');

function updaterThinking(userInput = '继续') {
  return `<variable_thinking>请求复述：${userInput}
1. 时间地点与地图：旧值 -> 最终正文事实 -> 新值；已核对。
2. 资源与属性成长：旧值 -> 最终正文事实 -> 新值；已核对。
3. 技能与能力：旧值 -> 最终正文事实 -> 新值；已核对。
4. 物品、金钱与装备：旧值 -> 最终正文事实 -> 新值；已核对。
5. 任务、目标、声望与历练：旧值 -> 最终正文事实 -> 新值；已核对。
6. 人物关系与NPC状态：旧值 -> 最终正文事实 -> 新值；已核对。
7. 战斗、伤势与世界事件：旧值 -> 最终正文事实 -> 新值；已核对。
8. 记忆、线索、约定与待办：旧值 -> 最终正文事实 -> 新值；已核对。</variable_thinking>`;
}

function updaterManifest({ relationships = false } = {}) {
  return `<update_manifest>${JSON.stringify({
    domains: {
      world: 'unchanged', attributes: 'unchanged', skills: 'unchanged', equipment: 'unchanged',
      missions: 'unchanged', relationships: relationships ? 'updated' : 'unchanged',
      combat: 'unchanged', events: 'unchanged'
    },
    present_npcs: relationships ? { 旗木卡卡西: 'updated' } : {},
    active_missions: {}
  })}</update_manifest>`;
}

function completeUpdaterOutput({ relationship = false } = {}) {
  return [
    updaterThinking(),
    updaterManifest({ relationships: relationship }),
    relationship
      ? '<relationship>{"npc":"旗木卡卡西","history":"愿意继续指导玩家。"}</relationship>'
      : '',
    '<memory>{"summary":"本回合连续性已经核对。"}</memory>',
    `<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`
  ].filter(Boolean).join('\n');
}

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function after(ms, value) {
  return new Promise(resolve => setTimeout(() => resolve(value), ms));
}

await test('agent stages run without an internal deadline', async () => {
  assert.equal('AGENT_TIMEOUTS' in agentManifestModule, false, 'legacy stage deadlines must be removed');
  let cancelCalls = 0;
  let receivedOptions = null;
  const runner = new AgentRunner({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) }
  });
  runner._models = { main: 'test-agent', critic: 'test-agent' };
  runner._mainClient = {
    isConfigured: () => true,
    async chatStream(_messages, options, onChunk) {
      receivedOptions = options;
      await after(40);
      onChunk?.('{"beats":[]}');
      return '{"beats":[]}';
    },
    cancel: () => { cancelCalls++; }
  };
  const result = await runner.run('outliner', {
    state: {}, userInput: '继续', taskPrompt: '生成大纲', onChunk: () => {}
  });
  assert.deepEqual(result, { beats: [] });
  assert.equal(receivedOptions.timeout, 0, '0 is the explicit no-timeout contract');
  assert.equal(receivedOptions.max_tokens, 0, '0 tells compatible providers to omit an Agent output cap');
  assert.equal(cancelCalls, 0);
});

await test('continuity updater receives updater evidence rather than writer evidence', () => {
  assert.equal(evidenceAudienceForAgent('continuity-updater'), 'updater');
  let requestedAudience = '';
  const runner = new AgentRunner({
    pipeline: {
      getTurnEvidenceView: audience => {
        requestedAudience = audience;
        return {
          audience,
          current_state: {},
          update_obligations: { fixed_domains: [], present_npcs: [], active_missions: [] }
        };
      }
    }
  });
  const messages = runner._buildMessages('continuity-updater', agentManifestModule.AGENT_MANIFESTS['continuity-updater'], {
    state: { _ui: { settings: { tacticalCombat: true } } }, userInput: '继续', taskPrompt: '更新连续性', extraContext: {}
  });
  assert.equal(requestedAudience, 'updater');
  const prompt = messages.map(message => message.content).join('\n');
  assert.match(prompt, /audience=updater|update_obligations|本回合更新义务/);
  assert.ok(prompt.includes(VARIABLE_UPDATER_MIXED_EXAMPLE));
  assert.match(prompt, /忍界日报结构契约/);
  assert.equal(prompt.split(JSON.stringify(SHINOBI_DAILY_EXAMPLE)).length - 1, 1);
});

await test('continuity updater call receives final-narrative update obligations', async () => {
  let compileArgs = null;
  let runnerParams = null;
  const evidenceView = {
    audience: 'updater', current_state: {},
    update_obligations: {
      fixed_domains: [],
      present_npcs: [{ npc: '旗木卡卡西' }],
      active_missions: []
    }
  };
  const pipeline = new AgentPipeline({
    pipeline: {
      _lastTurnEvidencePacket: { current_plot: null },
      _compileUpdaterEvidence: args => {
        compileArgs = args;
        return evidenceView;
      }
    },
    memorySystem: null
  });
  pipeline.runner.run = async (_agentType, params) => {
    runnerParams = params;
    return completeUpdaterOutput({ relationship: true });
  };
  const text = await pipeline._appendContinuityUpdates(
    { _relationships: { 旗木卡卡西: { combatant: false } } },
    '继续',
    '旗木卡卡西继续指导玩家。',
    ['旗木卡卡西'],
    { participants: ['旗木卡卡西'] }
  );
  assert.match(text, /<update_manifest>/);
  assert.equal(compileArgs.narrativeResponse, '旗木卡卡西继续指导玩家。');
  assert.equal(runnerParams.extraContext.evidenceView, evidenceView);
  assert.deepEqual(runnerParams.extraContext.updateObligations, evidenceView.update_obligations);
});

await test('continuity updater only receives visible narrative facts', async () => {
  let compileArgs = null;
  let runnerParams = null;
  const pipeline = new AgentPipeline({
    pipeline: {
      _compileUpdaterEvidence: args => {
        compileArgs = args;
        return {
          audience: 'updater',
          current_state: {},
          update_obligations: {
            fixed_domains: [], present_npcs: [], active_missions: []
          }
        };
      }
    },
    memorySystem: null
  });
  pipeline.runner.run = async (_agentType, params) => {
    runnerParams = params;
    return completeUpdaterOutput();
  };
  const raw = '<reasoning>NPC 私密计划：今夜背叛。</reasoning><final>公开正文：他点头告别。</final>';
  const result = await pipeline._appendContinuityUpdates({}, '继续', raw, [], null);

  assert.equal(compileArgs.narrativeResponse, '公开正文：他点头告别。');
  assert.equal(runnerParams.extraContext.draft, '公开正文：他点头告别。');
  assert.doesNotMatch([
    runnerParams.taskPrompt,
    runnerParams.extraContext.draft,
    JSON.stringify(runnerParams.extraContext.evidenceView),
    JSON.stringify(runnerParams.extraContext.updateObligations)
  ].join('\n'), /今夜背叛|私密计划/);
  assert.match(result, /<memory>/);
});

await test('manual cancellation still aborts an unbounded agent stage', async () => {
  let cancelCalls = 0;
  const runner = new AgentRunner({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) }
  });
  runner._models = { main: 'test-agent', critic: 'test-agent' };
  runner._mainClient = {
    isConfigured: () => true,
    chatStream: () => new Promise(() => {}),
    cancel: () => { cancelCalls++; }
  };
  const pending = runner.run('outliner', {
    state: {}, userInput: '继续', taskPrompt: '生成大纲', onChunk: () => {}
  }).then(() => 'resolved', error => error);
  await after(0);
  runner.abort(new Error('manual cancel'));
  const outcome = await Promise.race([pending, after(120, 'still-pending')]);
  assert.ok(outcome instanceof Error, 'manual cancellation must reject the stage');
  assert.match(outcome.message, /manual cancel/);
  assert.equal(cancelCalls, 1);
});

await test('parallel agent batches default to one in-flight model call and preserve result order', async () => {
  const runner = new AgentRunner({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) }
  });
  let active = 0;
  let peak = 0;
  runner.run = async (_type, params) => {
    active++;
    peak = Math.max(peak, active);
    await after(params.delay);
    active--;
    return params.value;
  };

  const results = await runner.runParallel([
    { type: 'critic-realism', key: 'first', params: { delay: 30, value: 'A' } },
    { type: 'critic-character', key: 'second', params: { delay: 5, value: 'B' } },
    { type: 'critic-style', key: 'third', params: { delay: 1, value: 'C' } }
  ]);

  assert.equal(peak, 1, 'default Agent model concurrency must be one');
  assert.deepEqual([...results.keys()], ['first', 'second', 'third']);
  assert.deepEqual([...results.values()].map(result => result.data), ['A', 'B', 'C']);
});

await test('parallel agent batches honor an explicit bounded concurrency', async () => {
  const runner = new AgentRunner({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    maxConcurrency: 2
  });
  let active = 0;
  let peak = 0;
  runner.run = async (_type, params) => {
    active++;
    peak = Math.max(peak, active);
    await after(params.delay);
    active--;
    return params.value;
  };

  const results = await runner.runParallel([
    { type: 'critic-realism', key: 'slow', params: { delay: 30, value: 1 } },
    { type: 'critic-character', key: 'fast', params: { delay: 1, value: 2 } },
    { type: 'critic-style', key: 'last', params: { delay: 1, value: 3 } }
  ]);

  assert.equal(peak, 2);
  assert.deepEqual([...results.keys()], ['slow', 'fast', 'last']);
});

await test('manual cancellation rejects a parallel batch before queued agents start', async () => {
  const runner = new AgentRunner({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) }
  });
  runner._models = { main: 'test-agent', critic: 'test-agent' };
  let started = 0;
  runner._criticClient = {
    isConfigured: () => true,
    chat: () => {
      started++;
      return new Promise(() => {});
    },
    cancel() {}
  };

  const pending = runner.runParallel([
    { type: 'critic-realism', key: 'first', params: { state: {}, taskPrompt: '一' } },
    { type: 'critic-character', key: 'queued', params: { state: {}, taskPrompt: '二' } }
  ]).then(() => 'resolved', error => error);
  await after(0);
  runner.abort(new Error('stop queued batch'));
  const outcome = await Promise.race([pending, after(120, 'still-pending')]);

  assert.ok(outcome instanceof Error, 'batch cancellation must reject promptly');
  assert.match(outcome.message, /stop queued batch/);
  assert.equal(started, 1, 'queued model calls must not start after cancellation');
});

await test('agent pipeline has no total deadline and waits for completion', async () => {
  localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: true, mode: 'standard' }));
  let abortCalls = 0;
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  pipeline.runner = {
    configure() {},
    abort() { abortCalls++; }
  };
  pipeline._run = async () => {
    await after(40);
    return '完整正文';
  };
  const pending = pipeline.execute({ '玩家·姓名': '测试忍者' }, '继续');
  await after(0);
  assert.equal('_totalTimer' in pipeline, false, 'pipeline must not own a deadline timer');
  assert.equal(await pending, '完整正文');
  assert.equal(abortCalls, 0);
});

await test('message pipeline never calls direct generation for an empty agent result', async () => {
  const previousAgentConfig = localStorage.getItem('naruto_agent_config');
  const previousApiConfig = localStorage.getItem('naruto_api_config');
  const originalExecute = AgentPipeline.prototype.execute;
  const originalChat = aiClient.chat;
  const originalChatStream = aiClient.chatStream;
  let directCalls = 0;
  localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: true, mode: 'standard' }));
  localStorage.setItem('naruto_api_config', JSON.stringify({
    backend: 'openai',
    model: 'test-model',
    aiCallPolicy: { strictSingleCall: false }
  }));
  stateManager._apiConfigCache = null;
  stateManager.reset();
  stateManager.update([{ key: '玩家·姓名', op: '=', value: '测试忍者' }]);
  AgentPipeline.prototype.execute = async () => null;
  aiClient.chat = async () => { directCalls++; throw new Error('DIRECT_FALLBACK_CALLED'); };
  aiClient.chatStream = async () => { directCalls++; throw new Error('DIRECT_FALLBACK_CALLED'); };

  const host = new MessagePipeline({
    knowledgeBase: { invalidateCache() {} },
    timelineSystem: null,
    uiRenderer: null,
    combatSystem: null,
    missionSystem: null,
    relationshipSystem: null,
    memorySystem: null,
    worldStateSystem: null
  });
  host._rollDice = () => ({ d20: 10 });
  host._preprocessInput = input => input;
  host._formatDiceBlock = () => '';
  host._buildPrompt = () => [{ role: 'user', content: '继续' }];
  host._getGenerationOptions = () => ({});

  try {
    const outcome = await host.process('继续').then(() => 'resolved', error => error);
    assert.ok(outcome instanceof Error, 'empty agent result must reject the turn');
    assert.equal(outcome.code, 'AGENT_PIPELINE_EMPTY_RESULT');
    assert.equal(directCalls, 0, 'main model must not replace a failed agent turn');
    assert.equal(host._agentPipeline, null, 'failed agent instance must be released');
  } finally {
    AgentPipeline.prototype.execute = originalExecute;
    aiClient.chat = originalChat;
    aiClient.chatStream = originalChatStream;
    stateManager.reset();
    stateManager._apiConfigCache = null;
    if (previousAgentConfig === null) localStorage.removeItem('naruto_agent_config');
    else localStorage.setItem('naruto_agent_config', previousAgentConfig);
    if (previousApiConfig === null) localStorage.removeItem('naruto_api_config');
    else localStorage.setItem('naruto_api_config', previousApiConfig);
  }
});

await test('agent fallback commits through the main transport and agent model when the updater is disabled', async () => {
  const storageKeys = [
    'naruto_agent_config',
    'naruto_api_config',
    'naruto_memory_config',
    'naruto_rpg_image_settings_v1'
  ];
  const previousStorage = new Map(storageKeys.map(key => [key, localStorage.getItem(key)]));
  const previousState = structuredClone(stateManager.state);
  const originalExecute = AgentPipeline.prototype.execute;
  const originalGenerateRaw = globalThis.generateRaw;
  const requestedModels = [];

  localStorage.setItem('naruto_agent_config', JSON.stringify({
    enabled: true,
    mode: 'standard',
    agentModel: 'agent-continuity-fallback-model'
  }));
  localStorage.setItem('naruto_api_config', JSON.stringify({
    backend: 'tavern',
    model: 'main-transport-model',
    aiCallPolicy: { strictSingleCall: false },
    variableUpdater: {
      enabled: false,
      backend: 'openai',
      apiUrl: 'https://stale-updater.invalid/v1',
      apiKey: 'stale-updater-key',
      model: 'stale-updater-model',
      temperature: 0.2,
      maxTokens: 8192,
      streaming: false
    },
    narrativeReview: { enabled: false }
  }));
  localStorage.setItem('naruto_memory_config', JSON.stringify({
    aiCompressionEnabled: false,
    deepEnabled: false,
    npcSummaryEnabled: false,
    recallEnabled: false
  }));
  localStorage.setItem('naruto_rpg_image_settings_v1', JSON.stringify({ enabled: false }));

  const state = stateManager.getDefaultState();
  state['玩家·姓名'] = 'Agent兜底测试者';
  state['系统·回合数'] = 7;
  state._missions = { active: {}, available: {}, completed: {}, failed: {}, log: {}, stats: {} };
  state._relationships = {};
  stateManager.state = state;
  stateManager._stateVersion++;
  stateManager._apiConfigCache = null;

  AgentPipeline.prototype.execute = async function () {
    this._agentSelfUpdater = false;
    return '训练场的风吹过空旷地面，玩家收好忍具。\n<memory>不是JSON</memory>';
  };
  globalThis.generateRaw = async options => {
    requestedModels.push(options?.custom_api?.model || '');
    return completeUpdaterOutput();
  };

  const host = new MessagePipeline({
    knowledgeBase: { invalidateCache() {} },
    timelineSystem: null,
    memorySystem: null
  });
  host._rollDice = () => ({ d20: 10 });
  host._preprocessInput = input => input;
  host._formatDiceBlock = () => '';

  try {
    const result = await host.process('继续');
    assert.deepEqual(requestedModels, ['agent-continuity-fallback-model']);
    assert.match(result.cleanResponse, /玩家收好忍具/);
    assert.doesNotMatch(result.cleanResponse, /<memory>|不是JSON/);
    assert.deepEqual(result.shinobiDaily, SHINOBI_DAILY_EXAMPLE);
    assert.equal(stateManager.get('系统·回合数'), 8, '标准 updater 兜底完成后回合必须提交');
  } finally {
    AgentPipeline.prototype.execute = originalExecute;
    if (originalGenerateRaw === undefined) delete globalThis.generateRaw;
    else globalThis.generateRaw = originalGenerateRaw;
    stateManager.state = previousState;
    stateManager._stateVersion++;
    stateManager._apiConfigCache = null;
    for (const [key, value] of previousStorage) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }
});

await test('post-cleanup imported envelope guard rejects a truncated machine tail before commit', async () => {
  const {
    MAIN_PRESET_STORAGE_KEY,
    invalidateMainPresetCache
  } = await import('../js/data/default-preset.js');
  const storageKeys = [
    MAIN_PRESET_STORAGE_KEY,
    'naruto_agent_config',
    'naruto_api_config',
    'naruto_memory_config',
    'naruto_rpg_image_settings_v1'
  ];
  const previousStorage = new Map(storageKeys.map(key => [key, localStorage.getItem(key)]));
  const previousState = structuredClone(stateManager.state);
  const previousAiConfig = aiClient.getConfig();
  const originalGenerateRaw = globalThis.generateRaw;
  let generationCalls = 0;
  const rawModelResponse = `<dream_plot>
<dream_body>安全正文。</dream_body>
<dream_after_format>
<memory>{"summary":"未闭合的记忆尾部"}
</dream_after_format>
</dream_plot>`;

  localStorage.setItem(MAIN_PRESET_STORAGE_KEY, JSON.stringify({
    name: 'Dream single-root guard fixture',
    _version: 1,
    _sourceFormat: 'sillytavern',
    _importMode: 'replace',
    entries: [{
      id: 'dream-envelope',
      name: '单根输出格式',
      enabled: true,
      role: 'system',
      content: `整份输出的根节点必须是 <dream_plot>。
<dream_plot>
<dream_body>正文</dream_body>
<dream_after_format>展示尾部</dream_after_format>
</dream_plot>`
    }]
  }));
  invalidateMainPresetCache();
  localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
  localStorage.setItem('naruto_api_config', JSON.stringify({
    backend: 'tavern',
    model: 'dream-main-model',
    aiCallPolicy: { strictSingleCall: false },
    variableUpdater: { enabled: true, backend: 'inherit', model: 'dream-updater-model', streaming: false },
    narrativeReview: { enabled: false }
  }));
  localStorage.setItem('naruto_memory_config', JSON.stringify({
    aiCompressionEnabled: false,
    deepEnabled: false,
    npcSummaryEnabled: false,
    recallEnabled: false
  }));
  localStorage.setItem('naruto_rpg_image_settings_v1', JSON.stringify({ enabled: false }));

  const state = stateManager.getDefaultState();
  state['玩家·姓名'] = '单根校验测试者';
  state['系统·回合数'] = 7;
  state._missions = { active: {}, available: {}, completed: {}, failed: {}, log: {}, stats: {} };
  state._relationships = {};
  stateManager.state = state;
  stateManager._stateVersion++;
  stateManager._apiConfigCache = null;
  aiClient.configure(stateManager.getAPIConfig());

  globalThis.generateRaw = async () => {
    generationCalls++;
    return rawModelResponse;
  };

  const host = new MessagePipeline({
    knowledgeBase: { invalidateCache() {} },
    timelineSystem: null,
    memorySystem: null
  });
  host._rollDice = () => ({ d20: 10 });
  host._preprocessInput = input => input;
  host._formatDiceBlock = () => '';

  try {
    const outcome = await host.process('继续').then(() => null, error => error);
    assert.ok(outcome instanceof Error, '根节点闭合被清理吞掉时必须拒绝回合');
    assert.equal(outcome.code, 'IMPORTED_PRESET_OUTPUT_INCOMPLETE');
    assert.match(outcome.message, /dream_plot|dream_after_format/);
    assert.equal(generationCalls, 1, '失败应发生在二次 updater 请求之前');
    assert.equal(stateManager.get('系统·回合数'), 7, '不完整 envelope 不得提交任何状态');
    assert.equal(globalThis.__NARUTO_PRESET_DEBUG__?.rawResponse, rawModelResponse,
      '失败诊断必须保留模型返回的逐字完整原文');
    assert.equal(globalThis.__NARUTO_PRESET_DEBUG__?.stage, 'post-machine-processing');
    assert.equal(host.chatHistory.length, 0, '诊断原文不得进入聊天历史');
  } finally {
    if (originalGenerateRaw === undefined) delete globalThis.generateRaw;
    else globalThis.generateRaw = originalGenerateRaw;
    stateManager.state = previousState;
    stateManager._stateVersion++;
    stateManager._apiConfigCache = null;
    if (previousAiConfig) aiClient.configure(previousAiConfig);
    else {
      aiClient.adapter = null;
      aiClient._config = null;
    }
    for (const [key, value] of previousStorage) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    invalidateMainPresetCache();
  }
});

function validStoryPlan() {
  return {
    schema: 'naruto.story-arc-plan/v1',
    id: 'story-plan:test',
    branchId: 'branch_main',
    basedOnNodeId: 'node:test',
    startDate: 'K048-01-01',
    premise: '当前局势保持开放推进',
    days: [0, 1, 2].map(dayOffset => ({
      dayOffset,
      date: dayOffset === 0 ? 'K048-01-01' : `K048-01-0${dayOffset + 1}`,
      pressures: ['当前矛盾可能升级'],
      opportunities: ['玩家可继续调查'],
      triggers: ['玩家主动推进'],
      invalidationConditions: ['关键前提改变']
    })),
    refreshTriggers: ['日期变化']
  };
}

function validSceneBrief(participants = ['测试忍者']) {
  return {
    schema: 'naruto.scene-brief/v1',
    id: 'scene:test',
    location: '木叶隐村',
    time: 'K048-01-01',
    participants,
    playerIntent: '继续',
    facts: ['当前场景安静'],
    constraints: ['NPC 行动由角色代理决定'],
    tensions: [],
    evidenceRefs: ['state:test']
  };
}

function validWritingOutline(decisionRefs = []) {
  return {
    schema: 'naruto.writing-outline/v1',
    beats: [{
      id: 1,
      sourceBeatId: '1',
      scene: '空旷的街道仍保持安静',
      narrativeGoal: '承接玩家输入并给出世界回应',
      participants: ['测试忍者'],
      decisionRefs,
      environmentBeats: ['风吹动屋檐下的纸灯'],
      continuityChecks: ['保持当前日期与地点'],
      variableEvidence: [],
      playerBoundary: '不替测试忍者追加动作或台词',
      stopPoint: '在新的可回应局势出现时停下'
    }],
    estimatedLength: 1200,
    variableEvidence: [],
    finalChecks: ['终稿必须把下一步交还玩家']
  };
}

await test('writing stays an outline until final review, then prose and variables are produced in order', async () => {
  const hostPipeline = { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) };
  const pipeline = new AgentPipeline({ pipeline: hostPipeline, memorySystem: null });
  const plan = validStoryPlan();
  const writingOutline = validWritingOutline();
  const order = [];
  pipeline.contextBroker.preflight = async () => ({
    domains: { dialogue: { items: [] }, world: { items: [] } },
    sources: [],
    cache: {},
    durationMs: 0
  });
  pipeline._generateOutline = async () => ({ beats: [{ id: 1, scene: '空旷的街道', participants: [] }] });
  pipeline._reviewOutline = async () => new Map();
  pipeline._writeWritingOutline = async () => {
    order.push('writing-outline');
    return writingOutline;
  };
  pipeline._reviewWritingOutline = async (_state, candidate, { final }) => {
    assert.strictEqual(candidate, writingOutline);
    order.push(final ? 'final-outline-review' : 'outline-review');
    return new Map([[
      final ? 'final-preset-and-character' : 'writing-outline-quality',
      { success: true, data: { approved: true, issues: [], summary: '通过' } }
    ]]);
  };
  pipeline._reviewWithSearch = async () => null;
  let auditCalls = 0;
  pipeline._auditFinalOutput = ({ finalText, rejectPlanningArtifact = false }) => {
    auditCalls++;
    if (auditCalls === 1) {
      assert.equal(JSON.parse(finalText).schema, 'naruto.writing-outline/v1');
      assert.equal(rejectPlanningArtifact, false, 'outline audit must accept the planning artifact');
    } else {
      assert.equal(finalText, 'FINAL_PROSE_SENTINEL');
      assert.equal(rejectPlanningArtifact, true, 'final narrative audit must reject planning artifacts');
    }
    return {
      schema: 'naruto.agent-audit/v1',
      valid: true,
      errors: [],
      warnings: [],
      checks: {},
      auditedAt: Date.now(),
      evidenceRefs: []
    };
  };
  pipeline._writeFinalText = async (_state, _input, _scene, _storyPlan, candidate) => {
    assert.strictEqual(candidate, writingOutline);
    order.push('final-writer');
    return 'FINAL_PROSE_SENTINEL';
  };
  pipeline._appendContinuityUpdates = async (_state, _input, candidate) => {
    assert.equal(candidate, 'FINAL_PROSE_SENTINEL');
    order.push('variables');
    return `${candidate}\n<var path="进度·金钱">1</var>`;
  };

  const output = await pipeline._run({
    '玩家·姓名': '测试忍者',
    '世界·地点': '木叶隐村',
    '世界·时间': 'K048-01-01',
    '系统·回合数': 1,
    _meta: { active_branch: 'branch_main', current_node_id: 'node:test' },
    _agent_story_plan: plan,
    _relationships: {}
  }, '继续', () => {}, false, false, []);
  assert.deepEqual(order, [
    'writing-outline',
    'outline-review',
    'final-outline-review',
    'final-writer',
    'variables'
  ]);
  assert.doesNotMatch(output, /空旷的街道仍保持安静/);
  assert.match(output, /FINAL_PROSE_SENTINEL/);
  assert.match(output, /<var/);
  assert.equal(auditCalls, 2, 'outline and final narrative must each be audited once');
});

await test('unavailable character material still reaches prose and continuity updates', async () => {
  const hostPipeline = { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) };
  const pipeline = new AgentPipeline({ pipeline: hostPipeline, memorySystem: null });
  pipeline._shouldRefreshStoryPlan = () => false;
  let writerCalls = 0;
  pipeline.contextBroker.preflight = async () => ({
    domains: { dialogue: { items: [] }, world: { items: [] } },
    sources: [],
    cache: {},
    durationMs: 0
  });
  pipeline._generateOutline = async () => ({
    characterRequests: [{ npc: '旗木卡卡西', reason: '回应玩家' }],
    beats: [{ id: 1, scene: '木叶街道', participants: ['旗木卡卡西'] }]
  });
  pipeline._reviewOutline = async () => new Map();
  pipeline._runCharacterAgents = async () => { throw new Error('character batch failed'); };
  pipeline._writeWritingOutline = async () => {
    writerCalls++;
    return validWritingOutline();
  };
  pipeline._reviewWritingOutline = async () => new Map();
  pipeline._reviewWithSearch = async () => null;
  pipeline._writeFinalText = async () => '卡卡西抬眼看向来人。';
  pipeline._appendContinuityUpdates = async (_state, _input, text) => text;
  pipeline._auditFinalOutput = () => ({
    schema: 'naruto.agent-audit/v1',
    valid: true,
    errors: [],
    warnings: [],
    checks: {},
    auditedAt: Date.now(),
    evidenceRefs: []
  });

  const outcome = await pipeline._run({
    '玩家·姓名': '测试忍者',
    '世界·地点': '木叶隐村',
    '世界·时间': 'K048-01-01',
    '系统·回合数': 1,
    _meta: { active_branch: 'branch_material_missing', current_node_id: 'node:test' },
    _agent_story_plan: validStoryPlan(),
    _relationships: { '旗木卡卡西': { location: '木叶隐村' } }
  }, '继续', () => {}, false, false, []);

  assert.equal(outcome, '卡卡西抬眼看向来人。');
  assert.equal(writerCalls, 1, 'missing optional character material must not block the writer');
});

await test('character agents use bounded concurrency and preserve NPC order', async () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  let active = 0;
  let peak = 0;
  pipeline._runOneCharacterAgent = async ({ npcName }) => {
    active++;
    peak = Math.max(peak, active);
    await after(npcName === '旗木卡卡西' ? 20 : 1);
    active--;
    return {
      id: `decision:${npcName}`,
      npc: npcName,
      provenance: { source: 'test' },
      observable: { action: `${npcName}行动` }
    };
  };

  const decisions = await pipeline._runCharacterAgents(
    {},
    '继续',
    ['旗木卡卡西', '宇智波佐助', '春野樱'],
    { id: 'scene:test' },
    { beats: [] },
    validStoryPlan()
  );

  assert.equal(peak, 1, 'character sub-agents must default to one model call at a time');
  assert.deepEqual(decisions.map(decision => decision.npc), ['旗木卡卡西', '宇智波佐助', '春野樱']);
  assert.deepEqual(pipeline._characterDecisions.map(decision => decision.npc), [
    '旗木卡卡西', '宇智波佐助', '春野樱'
  ]);
});

await test('character batch skips one failed material and preserves the remaining NPC order', async () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  pipeline.runner.setMaxConcurrency(2);
  const started = [];
  pipeline._runOneCharacterAgent = async ({ npcName }) => {
    started.push(npcName);
    if (npcName === '旗木卡卡西') throw new Error('character batch failure');
    await after(5);
    return {
      id: `decision:${npcName}`,
      npc: npcName,
      provenance: { source: 'test' },
      observable: { action: `${npcName}行动` }
    };
  };
  const names = ['旗木卡卡西', '宇智波佐助', '春野樱', '日向雏田'];
  const inputs = await pipeline._runCharacterAgents({}, '继续', names, { id: 'scene:test' }, { beats: [] }, validStoryPlan());
  assert.deepEqual(started, names);
  assert.deepEqual(inputs.map(item => item.npc), names.slice(1));
  assert.deepEqual(pipeline._characterDecisions.map(item => item.npc), names.slice(1));
});

await test('character batch cancellation stops queued agents immediately', async () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  pipeline.runner.setMaxConcurrency(3);
  const started = [];
  pipeline._runOneCharacterAgent = async ({ npcName }) => {
    started.push(npcName);
    if (npcName === '旗木卡卡西') {
      pipeline.abort(new Error('cancel character batch'));
      throw new Error('cancel character batch');
    }
    await after(3);
    return {
      id: `decision:${npcName}`,
      npc: npcName,
      provenance: { source: 'test' },
      observable: { action: `${npcName}行动` }
    };
  };
  const names = ['旗木卡卡西', '宇智波佐助', '春野樱', '日向雏田', '秋道丁次', '山中井野'];
  await assert.rejects(
    pipeline._runCharacterAgents({}, '继续', names, { id: 'scene:test' }, { beats: [] }, validStoryPlan()),
    /cancel character batch/
  );
  // 取消后：只允许已在途的子代理完成，排队中的角色子代理必须立即停止。
  assert.ok(started.length < names.length, `queued agents must stop after cancellation (started=${started.length})`);
  assert.equal(started.includes('山中井野'), false, 'agent queued before cancellation must not start');
});

await test('agent messages keep a stable prefix before volatile evidence', async () => {
  const runner = new AgentRunner({
    pipeline: {
      getTurnEvidenceView: () => ({
        audience: 'planner',
        current_state: { '系统·回合数': 5 },
        evidence: [{ kind: 'plot', id: 'P1', summary: '缓存顺序验证' }]
      }),
      getHistory: () => [
        { role: 'user', content: '历史用户消息' },
        { role: 'assistant', content: '历史助手消息' }
      ]
    }
  });
  const manifest = agentManifestModule.AGENT_MANIFESTS.outliner;
  const messages = runner._buildMessages('outliner', manifest, {
    state: { '玩家·姓名': '测试忍者' },
    userInput: '继续',
    taskPrompt: '生成大纲',
    extraContext: { _pipeline: runner._pipeline }
  });
  const roles = messages.map(message => message.role);
  // 稳定前缀在前：人设(system) → 历史(user/assistant) → 易变证据(system) → 任务(user)。
  // 证据必须位于历史之后，否则会打断 DeepSeek 的自动前缀缓存。
  const firstHistory = roles.findIndex((role, index) => role === 'user' && index !== roles.length - 1);
  assert.ok(firstHistory > 0, 'history must follow the persona system prompt');
  const evidenceIdx = messages.findIndex(message => message.role === 'system' && message !== messages[0]);
  assert.ok(evidenceIdx > firstHistory, 'volatile evidence must come after history');
  assert.equal(roles[roles.length - 1], 'user', 'task prompt must remain last');
});

await test('planning writer cannot inherit prose delivery instructions before final review', () => {
  const runner = new AgentRunner({
    pipeline: {
      getHistory: () => [],
      getTurnEvidenceView: () => ({ current_state: {}, evidence: [] })
    }
  });
  const mainMessages = [{
    role: 'system',
    content: 'MAIN_PROSE_CONTRACT_SENTINEL：输出 900-1500 字完整正文。'
  }];
  const outlineMessages = runner._buildMessages(
    'writer-outline',
    agentManifestModule.AGENT_MANIFESTS['writer-outline'],
    {
      state: { '玩家·姓名': '测试忍者' },
      userInput: '继续',
      taskPrompt: '只生成结构化详细写作大纲。',
      extraContext: {
        outline: { beats: [{ id: 1, scene: '街道' }] },
        _pipeline: runner._pipeline,
        _inheritFromMainPipeline: true,
        _mainMessages: mainMessages
      }
    }
  );
  const outlinePrompt = outlineMessages.map(message => message.content).join('\n');
  assert.doesNotMatch(outlinePrompt, /MAIN_PROSE_CONTRACT_SENTINEL/);
  assert.doesNotMatch(outlinePrompt, /900-1500/);
  assert.match(outlinePrompt, /只生成结构化详细写作大纲/);

  const finalMessages = runner._buildMessages(
    'final-writer',
    agentManifestModule.AGENT_MANIFESTS['final-writer'],
    {
      state: { '玩家·姓名': '测试忍者' },
      userInput: '继续',
      taskPrompt: '生成最终正文。',
      extraContext: {
        writingOutline: validWritingOutline(),
        _pipeline: runner._pipeline,
        _inheritFromMainPipeline: true,
        _mainMessages: mainMessages
      }
    }
  );
  const finalPrompt = finalMessages.map(message => message.content).join('\n');
  assert.match(finalPrompt, /MAIN_PROSE_CONTRACT_SENTINEL/);
  assert.match(finalPrompt, /详细写作大纲（可按剧情需要调整）/);
  assert.match(finalPrompt, /900-1500/);
});

await test('writing outline tolerates extra fields and missing references without forcing every NPC into prose', () => {
  const withExtra = normalizeWritingOutlineResult({
    ...validWritingOutline(['decision:卡卡西']),
    beats: [{ ...validWritingOutline(['decision:卡卡西']).beats[0], action: '卡卡西抬手。' }]
  }, { decisionIds: ['decision:卡卡西'] });
  assert.equal(withExtra.beats[0].action, undefined);
  assert.ok(withExtra.advisories.length);

  const withoutRefs = normalizeWritingOutlineResult(
    validWritingOutline(),
    { decisionIds: ['decision:卡卡西'] }
  );
  assert.deepEqual(withoutRefs.beats[0].decisionRefs, []);
  assert.ok(withoutRefs.advisories.length);

  const accepted = normalizeWritingOutlineResult(
    validWritingOutline(['decision:卡卡西']),
    { decisionIds: ['decision:卡卡西'] }
  );
  assert.equal(accepted.schema, 'naruto.writing-outline/v1');
  assert.deepEqual(accepted.beats[0].decisionRefs, ['decision:卡卡西']);
});

await test('agent writer defers variable tags to the secondary updater', () => {
  const runner = new AgentRunner();
  const constraint = runner._buildWriterConstraint({}, {});
  assert.doesNotMatch(constraint, /正文末尾必须附上/,
    'writer must not be told to emit variable/memory tags itself');
  assert.match(constraint, /禁止输出任何结构标签/,
    'writer must receive the defer-to-secondary instruction');
});

await test('critic-search error findings remain nonblocking writing advice', () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  const report = pipeline._auditFinalOutput({
    state: { '玩家·姓名': '测试忍者', _meta: { active_branch: 'branch_main' } },
    finalText: '测试正文',
    sceneBrief: validSceneBrief(),
    storyPlan: validStoryPlan(),
    involvedNPCs: [],
    reviews: new Map([
      ['final-preset-and-character', { success: true, data: { approved: true, issues: [], suggestions: [] } }],
      ['critic-search', {
        success: true,
        data: {
          approved: false,
          issues: [{ severity: 'error', dimension: '时间', description: '时间线冲突', suggestion: '修正日期' }],
          suggestions: []
        }
      }]
    ])
  });
  assert.ok(
    report.warnings.some(warning => /critic-search.*时间线冲突/.test(warning)),
    JSON.stringify(report.warnings)
  );
  assert.equal(report.valid, true);
  assert.deepEqual(report.errors, []);
});

await test('outline audit accepts the planning artifact while final narrative audit rejects it', () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  const reviews = new Map([[
    'final-preset-and-character',
    { success: true, data: { approved: true, issues: [], suggestions: [] } }
  ]]);
  const common = {
    state: { '玩家·姓名': '测试忍者', _meta: { active_branch: 'branch_main' } },
    sceneBrief: validSceneBrief(),
    storyPlan: validStoryPlan(),
    involvedNPCs: [],
    reviews
  };
  const outlineText = JSON.stringify(validWritingOutline());

  const outlineAudit = pipeline._auditFinalOutput({
    ...common,
    finalText: outlineText
  });
  assert.equal(outlineAudit.valid, true, JSON.stringify(outlineAudit.errors));
  assert.equal(
    outlineAudit.errors.some(error => /planning outline/.test(error)),
    false,
    JSON.stringify(outlineAudit.errors)
  );

  const finalAudit = pipeline._auditFinalOutput({
    ...common,
    finalText: outlineText,
    rejectPlanningArtifact: true
  });
  assert.equal(finalAudit.valid, false, 'final narrative audit must reject an outline payload');
  assert.ok(
    finalAudit.errors.some(error => /planning outline/.test(error)),
    JSON.stringify(finalAudit.errors)
  );
});

await test('search reviewer receives serialized writing-outline JSON instead of object coercion', async () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  let reviewPrompt = '';
  pipeline._createToolRuntime = () => ({
    runAgent: async ({ messages }) => {
      reviewPrompt = messages[0]?.content || '';
      return { output: { approved: true, issues: [], summary: '通过' } };
    }
  });
  pipeline._releaseToolRuntime = () => {};

  const result = await pipeline._reviewWithSearch(
    { '玩家·姓名': '测试忍者' },
    '继续',
    validWritingOutline(),
    { outline: true }
  );
  assert.equal(result.success, true);
  assert.match(reviewPrompt, /"schema":"naruto\.writing-outline\/v1"/);
  assert.doesNotMatch(reviewPrompt, /\[object Object\]/);
});

await test('continuity updater tags are appended and mark agent-self-update', async () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  pipeline._runContinuityUpdater = async () => completeUpdaterOutput({ relationship: true });
  const text = await pipeline._appendContinuityUpdates({}, '继续', '正文内容', ['旗木卡卡西'], { participants: ['旗木卡卡西'] });
  assert.ok(text.includes('<relationship>'), 'relationship tag must be appended');
  assert.ok(text.includes('history'), 'relationship must carry the observable turn history');
  assert.ok(text.includes('本回合连续性已经核对'), 'memory tag must be appended');
  assert.equal(pipeline.didAgentProduceUpdaterTags(), true, 'agent self-updater flag must be set');

  const dreamPipeline = new AgentPipeline({
    pipeline: {
      getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }),
      _lastImportedPresetProfile: {
        active: true,
        rootWrapper: 'dream_plot',
        requiredDisplayWrappers: ['dream_body', 'dream_after_format'],
        machineTailContainer: 'dream_after_format'
      }
    },
    memorySystem: null
  });
  dreamPipeline._runContinuityUpdater = async () => completeUpdaterOutput();
  const dream = '<dream_plot>\n<dream_body>正文内容</dream_body>\n<dream_after_format>\n<dream_done/>\n</dream_after_format>\n</dream_plot>';
  const dreamResult = await dreamPipeline._appendContinuityUpdates({}, '继续', dream, [], null);
  assert.ok(dreamResult.indexOf('<variable_thinking>') < dreamResult.indexOf('</dream_after_format>'));
  assert.ok(dreamResult.indexOf('</dream_after_format>') < dreamResult.indexOf('</dream_plot>'));
  assert.equal(dreamResult.trim().endsWith('</dream_plot>'), true,
    'single-root imported XML must remain the outer response envelope');
});

await test('continuity updater marks ownership only after machine-tail insertion succeeds', async () => {
  const pipeline = new AgentPipeline({
    pipeline: {
      getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }),
      _lastImportedPresetProfile: {
        active: true,
        rootWrapper: 'dream_plot',
        requiredDisplayWrappers: ['dream_body', 'dream_after_format'],
        machineTailContainer: 'dream_after_format'
      }
    },
    memorySystem: null
  });
  pipeline._runContinuityUpdater = async () => completeUpdaterOutput();
  const incomplete = '<dream_plot><dream_body>正文</dream_body></dream_plot>';
  const result = await pipeline._appendContinuityUpdates({}, '继续', incomplete, [], null);

  assert.equal(result, incomplete);
  assert.equal(pipeline.didAgentProduceUpdaterTags(), false);
});

await test('continuity updater cannot suppress the standard updater with malformed or incomplete output', async () => {
  const cases = [
    '<var path="当前状态·查克拉">35</var><memory>{"summary":"旧格式。"}</memory>',
    `${updaterThinking()}\n${updaterManifest()}\n<memory>不是JSON</memory>\n<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`,
    `${updaterThinking()}\n${updaterManifest()}\n<memory>{"summary":"缺少日报。"}</memory>`
  ];
  for (const candidate of cases) {
    const pipeline = new AgentPipeline({
      pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
      memorySystem: null
    });
    pipeline._runContinuityUpdater = async () => candidate;
    const text = await pipeline._appendContinuityUpdates({}, '继续', '正文内容', [], null);
    assert.equal(text, '正文内容');
    assert.equal(pipeline.didAgentProduceUpdaterTags(), false);
  }
});

await test('stage cache persists across pipeline instances and clears on success', () => {
  const mkPipeline = () => new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  const state = { '系统·回合数': 1, _meta: { active_branch: 'branch_main' } };
  const userInput = '继续';
  assert.equal(AGENT_PIPELINE_REVISION, 'narrative-agent-selection-v3');

  const p1 = mkPipeline();
  const { entry } = p1._beginStageCache(state, userInput);
  p1._storeStage(entry, 'story_plan', { storyPlan: { days: [{ dayOffset: 0 }, { dayOffset: 1 }, { dayOffset: 2 }] } });
  p1._storeStage(entry, 'writing_outline', { writingOutline: validWritingOutline() });

  // 新实例(模拟重试)能读回同一缓存 → 从失败阶段续跑，复用上方正确环节。
  const p2 = mkPipeline();
  const restored = p2._beginStageCache(state, userInput);
  assert.ok(restored.entry.complete.has('story_plan'), 'story_plan must be cached');
  assert.ok(restored.entry.complete.has('writing_outline'), 'writing outline must be cached');
  assert.equal(restored.entry.data.writingOutline.schema, 'naruto.writing-outline/v1');
  assert.equal(restored.entry.data.storyPlan.days.length, 3);

  // 完整成功 → 清缓存。
  p2._clearStageCache();
  const after = p2._beginStageCache(state, userInput);
  assert.equal(after.entry.complete.size, 0, 'cache must be cleared after success');
});

await test('continuity updater without tags leaves text unchanged and unmarked', async () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  pipeline._runContinuityUpdater = async () => '没有任何结构标签的普通文本';
  const text = await pipeline._appendContinuityUpdates({}, '继续', '正文内容', [], null);
  assert.equal(text, '正文内容');
  assert.equal(pipeline.didAgentProduceUpdaterTags(), false);

  const pipeline2 = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  pipeline2._runContinuityUpdater = async () => { throw new Error('boom'); };
  const text2 = await pipeline2._appendContinuityUpdates({}, '继续', '正文内容', [], null);
  assert.equal(text2, '正文内容');
  assert.equal(pipeline2.didAgentProduceUpdaterTags(), false);
});

await test('unavailable final reviewer is a diagnostic warning', () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  const report = pipeline._auditFinalOutput({
    state: { '玩家·姓名': '测试忍者', _meta: { active_branch: 'branch_main' } },
    finalText: '测试正文',
    sceneBrief: validSceneBrief(),
    storyPlan: validStoryPlan(),
    involvedNPCs: [],
    reviews: new Map([['final-preset-and-character', { success: false, error: 'reviewer offline' }]])
  });
  assert.ok(
    report.warnings.some(warning => /final-preset-and-character.*reviewer offline/.test(warning)),
    JSON.stringify(report.warnings)
  );
  assert.equal(report.valid, true);
});

await test('unusable review payloads and explicit rejection do not veto narrative', () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  const cases = [
    { label: 'missing data', result: { success: true } },
    { label: 'explicit rejection', result: { success: true, data: { approved: false, issues: [] } } },
    {
      label: 'parser fallback',
      result: {
        success: true,
        data: { approved: false, issues: [], summary: 'JSON解析失败' }
      }
    }
  ];
  for (const fixture of cases) {
    const report = pipeline._auditFinalOutput({
      state: { '玩家·姓名': '测试忍者', _meta: { active_branch: 'branch_main' } },
      finalText: '测试正文',
      sceneBrief: validSceneBrief(),
      storyPlan: validStoryPlan(),
      involvedNPCs: [],
      reviews: new Map([['final-preset-and-character', fixture.result]])
    });
    assert.ok(
      report.warnings.some(warning => warning.includes('final-preset-and-character')),
      `${fixture.label}: ${JSON.stringify(report.warnings)}`
    );
    assert.equal(report.valid, true);
    assert.deepEqual(report.errors, []);
  }
});

await test('final NPC scan uses evidence canonical names but ignores descriptive aliases', () => {
  const pipeline = new AgentPipeline({
    pipeline: {
      getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }),
      _lastTurnEvidencePacket: {
        character_mentions: [{ canonical_name: '月光千夏', names: ['千夏'] }],
        worldbook_entries: [{
          character_profile: {
            names: ['春野樱'],
            aliases: ['医疗忍者', '怪力']
          }
        }]
      }
    },
    memorySystem: null
  });
  const mentions = pipeline._extractKnownNpcMentions(
    { '玩家·姓名': '测试忍者' },
    '千夏从屋顶跃下。医疗忍者还在远处忙碌。',
    validSceneBrief(),
    []
  );
  assert.deepEqual(mentions, ['月光千夏']);
});

await test('NPC provenance matches relationship aliases and excludes the player identity first', () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  pipeline._characterDecisions = [{
    id: 'decision:sasuke:test',
    npc: '佐助',
    sceneId: 'scene:test',
    action: '佐助停在门边。',
    dialogue: '走吧。'
  }];
  const relationshipState = {
    '玩家·姓名': '测试忍者',
    _meta: { active_branch: 'branch_main' },
    _relationships: { '宇智波佐助': { aliases: ['佐助'] } }
  };
  const report = pipeline._auditFinalOutput({
    state: relationshipState,
    finalText: '佐助停在门边，低声说：“走吧。”',
    sceneBrief: validSceneBrief(),
    storyPlan: validStoryPlan(),
    involvedNPCs: [],
    reviews: new Map([[
      'final-preset-and-character',
      { success: true, data: { approved: true, issues: [], summary: '审查通过' } }
    ]])
  });
  assert.equal(
    report.errors.some(error => error.includes('character decision missing for')),
    false,
    JSON.stringify(report.errors)
  );

  const playerMentions = pipeline._extractKnownNpcMentions({
    ...relationshipState,
    '玩家·姓名': '佐助'
  }, '佐助走到门边。', validSceneBrief(['佐助']), []);
  assert.deepEqual(playerMentions, [], '玩家的主键与别名都不应进入 NPC 来源审计');
});

await test('writer may introduce a known NPC without a separate character decision', () => {
  const pipeline = new AgentPipeline({
    pipeline: { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) },
    memorySystem: null
  });
  const report = pipeline._auditFinalOutput({
    state: {
      '玩家·姓名': '测试忍者',
      _meta: { active_branch: 'branch_main' },
      _relationships: { '旗木卡卡西': { relationship: '陌生' } }
    },
    finalText: '旗木卡卡西推门而入，朝玩家点头后说：“跟我来。”',
    sceneBrief: validSceneBrief(),
    storyPlan: validStoryPlan(),
    involvedNPCs: [],
    reviews: new Map([[
      'final-preset-and-character',
      { success: true, data: { approved: true, issues: [], summary: '审查通过' } }
    ]])
  });
  assert.ok(
    report.warnings.some(warning => warning.includes('character decision missing for 旗木卡卡西')),
    JSON.stringify(report.warnings)
  );
  assert.equal(report.valid, true);
  assert.equal(report.checks.npcProvenance, false);
});

await test('nearest future plot context does not schedule an extra guardian agent', async () => {
  const hostPipeline = {
    _activeCallPolicy: { strictSingleCall: false, features: { agents: true } },
    _lastTurnEvidencePacket: {
      current_plot: { date_relation: 'nearest_future', scenes: [{ id: 'SCN-P2-RETURN' }] }
    },
    getTurnEvidenceView: () => ({ current_state: {}, evidence: [] })
  };
  const pipeline = new AgentPipeline({ pipeline: hostPipeline, memorySystem: null });
  const calls = [];
  pipeline.runner.run = async type => {
    calls.push(type);
    if (type === 'outliner') return { beats: [{ id: 7, scene: '林间' }] };
    throw new Error(`unexpected agent ${type}`);
  };
  const stages = [];
  const result = await pipeline._generateOutline({}, '继续', null, (stage, detail) => stages.push({ stage, detail }));
  assert.equal(result.beats.length, 1);
  assert.deepEqual(calls, ['outliner']);
  assert.ok(stages.every(item => item.stage !== 'guard_outline'), JSON.stringify(stages));
});

console.log(`\nagent-runtime-regression: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  throw new AggregateError(failures.map(item => item.error), `${failures.length} agent runtime regression test(s) failed`);
}
