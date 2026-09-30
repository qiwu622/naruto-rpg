import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
  clear: () => storage.clear(),
  key: index => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};

const [
  { MessagePipeline },
  presetModule,
  { AgentRunner },
  { AgentPipeline },
  { AGENT_MANIFESTS },
  compatibilityModule,
  { stateManager },
  { aiClient }
] = await Promise.all([
  import('../js/core/pipeline.js'),
  import('../js/data/default-preset.js'),
  import('../js/core/agent-runner.js'),
  import('../js/core/agent-pipeline.js'),
  import('../js/core/agent-manifests.js'),
  import('../js/core/main-preset-compatibility.js'),
  import('../js/core/state-manager.js'),
  import('../js/core/ai-client.js')
]);

const {
  DEFAULT_MAIN_PRESET_VERSION,
  MAIN_PRESET_STORAGE_KEY,
  invalidateMainPresetCache
} = presetModule;
const {
  IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT,
  buildImportedPresetOutputCompatibilityPrompt
} = compatibilityModule;

const syntheticPreset = {
  name: '合成 SillyTavern 预设',
  _version: DEFAULT_MAIN_PRESET_VERSION,
  _sourceFormat: 'sillytavern',
  _importMode: 'replace',
  entries: [
    {
      id: 'set-prefill-var', name: '设置预填充变量', enabled: true, role: 'system',
      content: '{{setvar::prefill_name::FIELD_PREFIX}}', tavernPosition: 'top', sourceOrder: 0
    },
    {
      id: 'top', name: 'Top', enabled: true, role: 'system', content: 'TOP_ENTRY',
      tavernPosition: 'top', sourceOrder: 1
    },
    {
      id: 'thinking-contract', name: '原生思考容器', enabled: true, role: 'system',
      content: '思考过程必须使用 <think_fox~>原生思考</think_fox~> 完整包裹。',
      tavernPosition: 'top', sourceOrder: 1.5
    },
    {
      id: 'misleading-marker', name: '⬆️回映层⬆️', enabled: true, role: 'system',
      content: 'MARKER_MUST_NOT_APPEAR', isMarker: true, tavernPosition: 'top', sourceOrder: 2
    },
    {
      id: 'depth-low', name: 'Depth low', enabled: true, role: 'system', content: 'DEPTH_LOW',
      tavernPosition: 'top', sourceOrder: 3,
      sourceMeta: { injectionPosition: 1, injectionDepth: 1, injectionOrder: 20 }
    },
    {
      id: 'depth-high', name: 'Depth high', enabled: true, role: 'system', content: 'DEPTH_HIGH',
      tavernPosition: 'bottom', sourceOrder: 4,
      sourceMeta: { injectionPosition: 1, injectionDepth: 1, injectionOrder: 90 }
    },
    {
      id: 'bottom', name: 'Bottom', enabled: true, role: 'system', content: 'BOTTOM_ENTRY',
      tavernPosition: 'bottom', sourceOrder: 5,
      sourceMeta: { injectionPosition: 0, injectionDepth: 4, injectionOrder: 100 }
    },
    {
      id: 'ordered-prefill', name: 'Ordered prefill', enabled: true, role: 'assistant',
      content: 'ORDERED_PREFIX RAW\n<think_fox~>', tavernPosition: 'bottom', sourceOrder: 6,
      sourceMeta: { injectionPosition: 0, injectionDepth: 4, injectionOrder: 100 }
    }
  ],
  assistantPrefill: '{{getvar::prefill_name}}',
  regexScripts: [
    {
      id: 'user-source', name: 'user source', enabled: true,
      findRegex: '/SECRET/g', replaceString: 'USER_RX', placement: [1]
    },
    {
      id: 'assistant-prompt', name: 'assistant prompt', enabled: true, promptOnly: true,
      findRegex: '/RAW/g', replaceString: 'ASSIST_RX', placement: [2]
    },
    {
      id: 'assistant-depth-one', name: 'assistant depth one', enabled: true, promptOnly: true,
      findRegex: '/LATEST/g', replaceString: 'DEPTH_ONE', placement: [2], minDepth: 1, maxDepth: 1
    },
    {
      id: 'assistant-wrong-depth', name: 'assistant wrong depth', enabled: true, promptOnly: true,
      findRegex: '/LATEST/g', replaceString: 'WRONG_DEPTH', placement: [2], minDepth: 2, maxDepth: 2
    }
  ]
};

localStorage.setItem(MAIN_PRESET_STORAGE_KEY, JSON.stringify(syntheticPreset));
invalidateMainPresetCache();

const pipeline = new MessagePipeline({});
pipeline.chatHistory = [
  { role: 'user', content: '[玩家操作]\nold SECRET' },
  { role: 'assistant', content: 'RAW LATEST' }
];
const persistedHistory = JSON.stringify(pipeline.chatHistory);
const messages = pipeline._buildPrompt('玩家状态', { '玩家·姓名': '漩涡鸣人' }, 'SECRET', {
  updaterEnabled: true,
  strictSingleCall: true
});

assert.equal(JSON.stringify(pipeline.chatHistory), persistedHistory, '正则不得改写持久对话历史');
assert.equal(pipeline.chatHistory[1].content, 'RAW LATEST');

const contents = messages.map(message => String(message.content || ''));
const indexOfExact = content => contents.findIndex(value => value === content);
const currentUserIndex = contents.findIndex(content => content.includes('[玩家操作]\nUSER_RX'));
const historicalUser = contents.find(content => content.includes('old USER_RX'));
const historicalAssistant = contents.find(content => content.includes('ASSIST_RX DEPTH_ONE'));
const expectedPrefill = 'ORDERED_PREFIX ASSIST_RX\n<think_fox~>\nFIELD_PREFIX';
const prefillIndex = contents.findIndex(content => content === expectedPrefill);

assert.ok(currentUserIndex >= 0, '当前 user 必须以 placement=1 投影');
assert.ok(historicalUser, '历史 user 必须以 placement=1 投影');
assert.ok(historicalAssistant, '历史 assistant 必须以 placement=2 和正确 depth 投影');
assert.doesNotMatch(historicalAssistant, /WRONG_DEPTH/);
assert.equal(contents.some(content => content.includes('MARKER_MUST_NOT_APPEAR')), false);

assert.ok(indexOfExact('TOP_ENTRY') < contents.findIndex(content => content.includes('old USER_RX')));
assert.ok(indexOfExact('DEPTH_LOW') < indexOfExact('DEPTH_HIGH'), '同深度按 injection order 升序组装');
assert.ok(indexOfExact('DEPTH_HIGH') < currentUserIndex, 'depth=1 位于当前 user 之前');
assert.ok(indexOfExact('BOTTOM_ENTRY') > currentUserIndex, 'bottom 条目位于当前 user 之后');
assert.ok(prefillIndex > indexOfExact('BOTTOM_ENTRY'), '主预设 assistant 条目与 assistant_prefill 必须合并保留');
assert.equal(messages[prefillIndex].role, 'assistant');
assert.doesNotMatch(contents[prefillIndex], /RAW/, 'assistant prefill 必须经过 placement=2 prompt 投影');

const compatibilityIndex = contents.indexOf(IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT);
assert.ok(compatibilityIndex >= 0 && compatibilityIndex < prefillIndex,
  '兼容 system 条目必须位于最终 assistant prefill 之前');
assert.equal(messages.at(-1)?.role, 'assistant');
assert.equal(messages.at(-1)?.content, expectedPrefill);
assert.match(contents[compatibilityIndex], /wrapper/);
assert.match(contents[compatibilityIndex], /机器标签/);
assert.equal(contents[compatibilityIndex].includes('ORDERED_PREFIX'), false,
  '兼容指令不得复制或硬编码导入预设内容');
assert.deepEqual(pipeline._lastImportedPresetProfile.privateWrappers, ['think_fox~']);
assert.ok(contents.some(content => content.includes('后续变量模型负责')),
  'updater/Agent 模式必须明确把变量、记忆与日报交给后续模型');
assert.equal(contents.some(content => content.includes('后台独立变量更新模型已启用。主模型必须先输出 <reasoning>')), false,
  '外部原生思考 wrapper 不得被项目固定 <reasoning> 覆盖');

const trace = pipeline._lastPromptTrace?.presetRegex;
assert.deepEqual(new Set(trace?.appliedScripts), new Set([
  'user-source', 'assistant-prompt', 'assistant-depth-one'
]));
assert.deepEqual(trace?.warnings, []);

const runner = new AgentRunner();
const agentMessages = runner._buildMessages('final-writer', AGENT_MANIFESTS['final-writer'], {
  state: { '玩家·姓名': '漩涡鸣人' },
  userInput: 'SECRET',
  taskPrompt: '生成正文',
  extraContext: {
    _inheritFromMainPipeline: true,
    _mainMessages: messages,
    _pipeline: pipeline
  }
});
assert.equal(agentMessages.at(-1)?.content, expectedPrefill,
  'Agent final-writer 必须保留最终 assistant prefill');
assert.ok(agentMessages.findIndex(message => (
  message.content === IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT
)) < agentMessages.length - 1,
  'Agent final-writer 必须在 prefill 前重申外部展示兼容');
assert.equal(agentMessages.filter(message => (
  message.content === IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT
)).length, 1);
const importedWriterConstraint = String(agentMessages.find(message => (
  String(message.content || '').includes('【Agent 写作参考】')
))?.content || '');
assert.match(importedWriterConstraint, /不要额外生成项目默认 <reasoning>/);
assert.match(importedWriterConstraint, /篇幅、文风与输出格式完全遵循用户导入预设/);
assert.doesNotMatch(importedWriterConstraint, /900-1500|具体克制|【字数要求】|【文风要求】/,
  'Agent final-writer 不得用项目默认篇幅或文风覆盖导入预设');

const builtInWriterConstraint = runner._buildWriterConstraint({}, {});
assert.match(builtInWriterConstraint, /900-1500/,
  '内置预设仍应保留项目默认篇幅约束');
assert.match(builtInWriterConstraint, /具体克制/,
  '内置预设仍应保留项目默认文风约束');

let toolWriterMessages = null;
const agentPipeline = new AgentPipeline({ pipeline });
agentPipeline._createToolRuntime = () => ({
  runAgent: async request => {
    toolWriterMessages = request.messages;
    return { text: '合成 Agent 正文' };
  }
});
agentPipeline._releaseToolRuntime = () => {};
await agentPipeline._writeFinalText(
  { '玩家·姓名': '漩涡鸣人' },
  'SECRET',
  {},
  null,
  {},
  new Map(),
  [],
  messages
);
assert.equal(toolWriterMessages?.at(-1)?.content, expectedPrefill,
  'Agent tool final-writer 也必须把 assistant prefill 保持为最后一条');
assert.equal(toolWriterMessages.filter(message => (
  message.content === IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT
)).length, 1);
assert.deepEqual(
  toolWriterMessages.slice(0, messages.length - 2),
  messages.slice(0, -2),
  'Agent tool final-writer 必须保留导入预设跨 role 的 top/history/depth/bottom 顺序'
);

const savedImportedPreset = localStorage.getItem(MAIN_PRESET_STORAGE_KEY);
const singlePipeline = new MessagePipeline({});
const singleMessages = singlePipeline._buildPrompt('玩家状态', { '玩家·姓名': '漩涡鸣人' }, 'SECRET', {
  updaterEnabled: false,
  strictSingleCall: true
});
const singlePrompt = singleMessages.map(message => String(message.content || '')).join('\n\n');
assert.equal(localStorage.getItem(MAIN_PRESET_STORAGE_KEY), savedImportedPreset,
  '运行时兼容条目不得写回或改动用户导入预设');
assert.match(singlePrompt, /【地点变更规则——每次移动必须同步更新坐标】/,
  '外部预设单模型模式必须得到完整变量字段协议');
assert.match(singlePrompt, /唯一 <state_update>/);
assert.match(singlePrompt, /唯一 <memory>/);
assert.match(singlePrompt, /唯一 <shinobi_daily>/);
assert.match(singlePrompt, /仅示范项目机器尾部/);
assert.doesNotMatch(singlePrompt, /1\. 本轮请求原文：/,
  '外部预设单模型模式不得注入默认固定八项 reasoning 示例');
assert.equal(singleMessages.at(-1)?.content, expectedPrefill);

const nativePreset = {
  name: 'Native',
  _version: DEFAULT_MAIN_PRESET_VERSION,
  _sourceFormat: 'naruto-main-preset',
  _importMode: 'replace',
  entries: [{ id: 'native', name: 'Native', enabled: true, role: 'system', content: 'NATIVE' }]
};
localStorage.setItem(MAIN_PRESET_STORAGE_KEY, JSON.stringify(nativePreset));
invalidateMainPresetCache();
const nativePipeline = new MessagePipeline({});
const nativeMessages = nativePipeline._buildPrompt('状态摘要', {}, '继续', {
  updaterEnabled: true,
  strictSingleCall: true
});
assert.equal(nativeMessages.some(message => (
  message.content === IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT
)), true, '任何 replace 模式导入预设都必须启用通用输出桥接');
const nativeAgentMessages = runner._buildMessages('final-writer', AGENT_MANIFESTS['final-writer'], {
  state: {},
  userInput: '继续',
  taskPrompt: '生成正文',
  extraContext: { _inheritFromMainPipeline: true, _mainMessages: nativeMessages }
});
assert.equal(nativeAgentMessages.some(message => (
  message.content === IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT
)), true, 'Agent 必须继承 native replace 导入预设的通用桥接');

const dedicatedPresets = [
  {
    id: 'fox-v18',
    expected: /think_fox~.*content.*fox_selc.*fox_tip/s,
    preset: {
      name: 'Fox fixture', _version: DEFAULT_MAIN_PRESET_VERSION,
      _sourceFormat: 'sillytavern', _importMode: 'replace', regexScripts: [],
      assistantPrefill: 'OUTPUT\n<think_fox~>',
      entries: [{ id: 'fox', name: 'Fox', enabled: true, role: 'system',
        content: '<think_fox~>思考</think_fox~><content>正文</content><fox_selc>选项</fox_selc><fox_tip>留言</fox_tip>' }]
    }
  },
  {
    id: 'izumi-0707',
    expected: /konatan_planning~.*纯文本正文.*current_event.*progress.*tucao/s,
    preset: {
      name: 'Izumi fixture', _version: DEFAULT_MAIN_PRESET_VERSION,
      _sourceFormat: 'sillytavern', _importMode: 'replace', regexScripts: [],
      assistantPrefill: '日本語で考える：\n<konatan_planning~>',
      entries: [{ id: 'izumi', name: 'Izumi', enabled: true, role: 'system',
        content: '<konatan_planning~>规划</konatan_planning~><current_event>事件</current_event><progress>进度</progress><tucao>吐槽</tucao>' }]
    }
  },
  {
    id: 'dream-whale-v4',
    expected: /主 <think>.*dream_plot.*dream_body.*dream_after_format.*dream_parallel_event.*simple_thinking/s,
    preset: {
      name: 'Dream fixture', _version: DEFAULT_MAIN_PRESET_VERSION,
      _sourceFormat: 'sillytavern', _importMode: 'replace', regexScripts: [],
      entries: [{ id: 'dream', name: 'Dream', enabled: true, role: 'system',
        content: '最终回复的根节点必须是 <dream_plot>，模板：<dream_plot><dream_body><dream_scene>场景</dream_scene>正文</dream_body><dream_after_format><dream_parallel_event><simple_thinking>局部</simple_thinking>事件</dream_parallel_event></dream_after_format></dream_plot>。主思考使用 <think>思考</think>。' }]
    }
  },
  {
    id: 'miemie-v5',
    expected: /continuation 从 <acg_think>.*combat_driver.*story_driver.*story_scene.*memory_log.*wlog.*status.*affinity/s,
    preset: {
      name: 'Miemie fixture', _version: DEFAULT_MAIN_PRESET_VERSION,
      _sourceFormat: 'sillytavern', _importMode: 'replace', regexScripts: [],
      assistantPrefill: '<think>think is over...</think>',
      entries: [{ id: 'miemie', name: 'Miemie', enabled: true, role: 'system',
        content: '<acg_think>判断</acg_think><combat_driver>无</combat_driver><story_driver>推演</story_driver><story_scene>正文</story_scene><memory_log>记忆</memory_log><wlog>世界</wlog><status>状态</status><affinity>关系</affinity>' }]
    }
  }
];

for (const fixture of dedicatedPresets) {
  const sourceSnapshot = JSON.stringify(fixture.preset);
  localStorage.setItem(MAIN_PRESET_STORAGE_KEY, sourceSnapshot);
  invalidateMainPresetCache();
  const dedicatedPipeline = new MessagePipeline({});
  const dedicatedMessages = dedicatedPipeline._buildPrompt('状态摘要', {}, '继续', {
    updaterEnabled: true,
    strictSingleCall: true
  });
  const profile = dedicatedPipeline._lastImportedPresetProfile;
  assert.equal(profile.adapterId, fixture.id);
  const modePrompt = dedicatedMessages.find(message => (
    String(message.content || '').includes(`【用户导入预设 · ${fixture.id} 专属交付条目】`)
  ))?.content || '';
  assert.match(modePrompt, fixture.expected);
  const compatibilityPrompt = buildImportedPresetOutputCompatibilityPrompt(profile);
  assert.equal(dedicatedMessages.filter(message => message.content === compatibilityPrompt).length, 1);
  assert.equal(dedicatedMessages.some(message => (
    message.content === IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT
  )), false, `${fixture.id} must not stack the generic final wrapper prompt`);
  assert.equal(localStorage.getItem(MAIN_PRESET_STORAGE_KEY), sourceSnapshot,
    `${fixture.id} runtime prompt must not rewrite imported JSON`);

  const writerMessages = runner._buildMessages('final-writer', AGENT_MANIFESTS['final-writer'], {
    state: {},
    userInput: '继续',
    taskPrompt: '生成正文',
    extraContext: {
      _inheritFromMainPipeline: true,
      _mainMessages: dedicatedMessages,
      _pipeline: dedicatedPipeline,
      importedPresetProfile: profile
    }
  });
  assert.equal(writerMessages.filter(message => message.content === compatibilityPrompt).length, 1,
    `${fixture.id} Agent writer must inherit exactly one dedicated prompt`);
}

const builtInPreset = {
  name: 'Built-in shaped fixture',
  _version: DEFAULT_MAIN_PRESET_VERSION,
  _sourceFormat: 'naruto-main-preset',
  entries: [{ id: 'builtin', name: 'Builtin', enabled: true, role: 'system', content: 'BUILTIN' }]
};
localStorage.setItem(MAIN_PRESET_STORAGE_KEY, JSON.stringify(builtInPreset));
invalidateMainPresetCache();
const builtInMessages = new MessagePipeline({})._buildPrompt('状态摘要', {}, '继续', {
  updaterEnabled: true,
  strictSingleCall: true
});
assert.equal(builtInMessages.some(message => (
  message.content === IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT
)), false, '非 replace 的默认/native 预设不得启用导入桥接');

const runtimeDreamPreset = dedicatedPresets.find(fixture => fixture.id === 'dream-whale-v4').preset;
localStorage.setItem(MAIN_PRESET_STORAGE_KEY, JSON.stringify(runtimeDreamPreset));
localStorage.setItem('naruto_api_config', JSON.stringify({
  backend: 'tavern',
  model: 'dream-continuation-main',
  disableStreaming: false,
  aiCallPolicy: { strictSingleCall: false },
  variableUpdater: { enabled: true, backend: 'inherit', model: 'dream-continuation-updater' },
  narrativeReview: { enabled: false }
}));
localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
localStorage.setItem('naruto_memory_config', JSON.stringify({
  aiCompressionEnabled: false,
  deepEnabled: false,
  npcSummaryEnabled: false,
  recallEnabled: false
}));
localStorage.setItem('naruto_rpg_image_settings_v1', JSON.stringify({ enabled: false }));
invalidateMainPresetCache();

const runtimeState = stateManager.getDefaultState();
runtimeState['玩家·姓名'] = '水无月·凛';
runtimeState['玩家·存活'] = '是';
runtimeState['世界·时间'] = 'K052-01-01';
runtimeState['世界·年代'] = 'K052';
runtimeState['世界·地点'] = '木叶隐村·南大门内侧岗亭';
runtimeState['系统·回合数'] = 5;
stateManager.state = runtimeState;
stateManager._stateVersion++;
stateManager._apiConfigCache = null;
aiClient.configure({ backend: 'tavern', model: 'dream-continuation-main' });

const runtimeDreamContinuation = [
  '一、检设定：格式示例 `<dream_plot>`、`<dream_body>`、`<dream_after_format>`。',
  '二、辨视角：凛保持惊恐伪装。',
  '</think>',
  '<dream_plot>',
  '<dream_body><dream_scene><date>木叶52年1月1日</date><time>清晨</time><location>南大门岗亭</location></dream_scene>凛拉好外袍，警员翻开登记册继续盘问。</dream_body>',
  '<dream_after_format><dream_parallel_event><simple_thinking>雨鸦评估撤退路线。</simple_thinking>林外的追踪者暂时退去。</dream_parallel_event></dream_after_format>',
  '</dream_plot>'
].join('\n');
globalThis.generateRaw = async () => runtimeDreamContinuation;
let runtimeSecondaryCalls = 0;
const runtimeDreamPipeline = new MessagePipeline({
  timelineSystem: { createNode: async () => ({ id: 'node_dream_continuation' }) }
});
runtimeDreamPipeline._runSecondaryVariableUpdate = async () => {
  runtimeSecondaryCalls++;
  return '<memory>{"summary":"凛在南大门岗亭接受警员盘问，下一回合继续处理身份登记。","facts":[],"clues":[],"pins":[],"npc_notes":{}}</memory>';
};
try {
  const runtimeResult = await runtimeDreamPipeline.process('配合医疗忍者处理伤口');
  assert.equal(runtimeSecondaryCalls, 1,
    '梦鲸 continuation 必须先通过主回复封装校验，再进入二次变量模型');
  assert.match(runtimeResult.cleanResponse, /凛拉好外袍|林外的追踪者暂时退去/u);
  assert.doesNotMatch(runtimeResult.cleanResponse, /一、检设定|二、辨视角|雨鸦评估撤退路线/u);
  assert.match(runtimeResult.rawResponse, /^<think>\s*一、检设定/u,
    '提交前的导入回复必须恢复完整 transport think 开始标签');
} finally {
  delete globalThis.generateRaw;
}

const runtimeIzumiPreset = dedicatedPresets.find(fixture => fixture.id === 'izumi-0707').preset;
localStorage.setItem(MAIN_PRESET_STORAGE_KEY, JSON.stringify(runtimeIzumiPreset));
invalidateMainPresetCache();
const runtimeIzumiState = stateManager.getDefaultState();
runtimeIzumiState['玩家·姓名'] = '水无月·凛';
runtimeIzumiState['玩家·存活'] = '是';
runtimeIzumiState['世界·时间'] = 'K052-01-01';
runtimeIzumiState['世界·年代'] = 'K052';
runtimeIzumiState['世界·地点'] = '木叶隐村·南大门内侧岗亭';
runtimeIzumiState['系统·回合数'] = 6;
stateManager.state = runtimeIzumiState;
stateManager._stateVersion++;

const runtimeIzumiContinuation = [
  '- 当前什么情况？',
  '<current_event>规划内旧事件快照</current_event>',
  '<progress>规划内旧进度快照</progress>',
  '- 综合细纲：治疗结束后由警员继续盘问。',
  '</konatan_planning~>',
  '凛重新拉好外袍，警员把登记册推到她面前。',
  '<current_event>身份登记盘问</current_event>',
  '<progress>治疗完成，进入警务问询。</progress>',
  '<tucao>危机仍未解除。</tucao>'
].join('\n');
globalThis.generateRaw = async () => runtimeIzumiContinuation;
let runtimeIzumiSecondaryCalls = 0;
const runtimeIzumiPipeline = new MessagePipeline({
  timelineSystem: { createNode: async () => ({ id: 'node_izumi_continuation' }) }
});
runtimeIzumiPipeline._runSecondaryVariableUpdate = async () => {
  runtimeIzumiSecondaryCalls++;
  return '<memory>{"summary":"凛完成伤口处理并进入身份登记盘问。","facts":[],"clues":[],"pins":[],"npc_notes":{}}</memory>';
};
try {
  const runtimeResult = await runtimeIzumiPipeline.process('继续配合检查');
  assert.equal(runtimeIzumiSecondaryCalls, 1,
    'Izumi continuation 必须通过私密快照隔离后进入二次变量模型');
  assert.match(runtimeResult.cleanResponse, /凛重新拉好外袍|身份登记盘问/u);
  assert.doesNotMatch(runtimeResult.cleanResponse, /规划内旧事件快照|规划内旧进度快照|综合细纲/u);
  assert.equal((runtimeResult.rawResponse.match(/<konatan_planning~>/gu) || []).length, 1);
} finally {
  delete globalThis.generateRaw;
}

console.log('✓ main preset pipeline regression passed');
