import assert from 'node:assert/strict';
import { AIClient, normalizeOpenAIMessageOrder } from '../js/core/ai-client.js';
import { eventBus } from '../js/core/event-bus.js';
import { applyDeepSeekRequest, prepareDeepSeekMessages, markTurnContext, readTokenUsage,
  inheritAPIAdaptation, deepSeekSdkUsage } from '../js/core/deepseek-mode.js';
import { runAgent } from './vendor/agent-sdk-entry.js';

const store = new Map();
globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
const base = { backend: 'deepseek', model: 'deepseek-flash', apiUrl: 'https://api.deepseek.test/v1', apiKey: 'test-key', adaptationMode: 'deepseek' };
const usage = { prompt_tokens: 1000, completion_tokens: 120, total_tokens: 1120,
  prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens_details: { reasoning_tokens: 20 } };
const fixture = turn => [
  { role: 'system', content: '固定世界规则\n固定输出规则' },
  { role: 'user', content: '上一回合的行动' },
  { role: 'assistant', content: '上一回合已发生的正文' },
  markTurnContext({ role: 'system', content: `当前变量与记忆 ${turn}` }),
  { role: 'user', content: `玩家输入 ${turn}` },
  { role: 'system', content: '固定机器标签契约' },
  { role: 'assistant', content: '预填充' }
];
const jsonResponse = (message = { role: 'assistant', content: '测试正文' }, finish = 'stop') => Response.json({
  choices: [{ index: 0, message, finish_reason: finish }], usage
});
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
  headers: { 'Content-Type': 'text/event-stream' }
});
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(error); console.error(`FAIL ${name}\n${error.stack}`); }
}
const originalFetch = globalThis.fetch;
try {
  await test('opt-in only: absent/standard mode leaves the original wire context byte-identical', async () => {
    for (const useProxy of [false, true]) for (const adaptationMode of [undefined, 'standard']) {
      let body;
      globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return jsonResponse(); };
      const client = new AIClient(); client.configure({ ...base, useProxy, adaptationMode, deepseekThinking: 'max' });
      await client.chat(fixture(1));
      const original = normalizeOpenAIMessageOrder(JSON.parse(JSON.stringify(fixture(1))));
      assert.equal(JSON.stringify(body.messages), JSON.stringify(original));
      assert.equal(body.thinking, undefined); assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.temperature, 0.9);
    }
  });
  await test('dedicated requests preserve a stable prefix through history and retain the exact current facts/prefill', async () => {
    const one = normalizeOpenAIMessageOrder(prepareDeepSeekMessages(fixture(1)));
    const two = normalizeOpenAIMessageOrder(prepareDeepSeekMessages(fixture(2)));
    assert.deepEqual(one.slice(0, 3), two.slice(0, 3));
    assert.deepEqual(one[3], { role: 'user', content: '当前变量与记忆 1' });
    assert.equal(one.at(-1).content, '预填充');
    assert.equal(one[0].content.includes('当前变量'), false);
    assert.equal(fixture(1)[3].role, 'system', 'source messages are not mutated');
    const imported = [{ role: 'system', content: '{{自定义预设}}' }, { role: 'assistant', content: '原样预填充' }];
    assert.deepEqual(prepareDeepSeekMessages(imported), imported);
  });
  await test('thinking controls are explicit; no obsolete cache directives or short output cap', async () => {
    const wire = { model: base.model, temperature: 0.8, top_p: 0.3, frequency_penalty: 0.2, stream: true };
    const off = applyDeepSeekRequest(wire, base);
    assert.deepEqual(off.thinking, { type: 'disabled' }); assert.equal(off.temperature, 0.8);
    assert.equal(off.top_p, undefined); assert.equal(off.max_tokens, undefined); assert.equal(off.cache_control, undefined);
    for (const effort of ['low', 'high', 'max']) {
      const body = applyDeepSeekRequest(wire, { ...base, deepseekThinking: effort });
      assert.equal(body.thinking.type, 'enabled'); assert.equal(body.reasoning_effort, effort);
      assert.equal(body.top_p, 0.95); assert.equal(body.temperature, undefined); assert.equal(body.frequency_penalty, undefined);
    }
    assert.equal(applyDeepSeekRequest(wire, { ...base, backend: 'claude' }), wire);
    assert.equal(applyDeepSeekRequest(wire, { ...base, backend: 'tavern' }), wire);
  });
  await test('both transports report streaming, JSON and non-SSE usage exactly once, including zero hit and usage-only tails', async () => {
    for (const useProxy of [false, true]) for (const shape of ['json', 'sse', 'stream-json']) {
      const reports = []; const off = eventBus.on('ai:usage', value => reports.push(value));
      let request;
      globalThis.fetch = async (_url, init) => {
        request = JSON.parse(init.body);
        return shape === 'sse' ? sse([
          { choices: [{ delta: { reasoning_content: '内部测试', content: '' } }] },
          { choices: [{ delta: { content: '测试正文' }, finish_reason: 'stop' }] },
          { choices: [], usage: { ...usage, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000, total_tokens: undefined } }
        ]) : jsonResponse();
      };
      try {
        const client = new AIClient(); client.configure({ ...base, useProxy });
        const text = shape === 'json' ? await client.chat(fixture(1)) : await client.chatStream(fixture(1), {}, () => {});
        assert.equal(text, '测试正文'); assert.equal(reports.length, 1);
        assert.equal(readTokenUsage(reports[0]).hit, shape === 'sse' ? 0 : 800);
        assert.equal(request.thinking.type, 'disabled');
        assert.equal(request.messages[3].content, '当前变量与记忆 1');
      } finally { off(); }
    }
  });
  await test('empty reasoning-only completion and strict-single proxy do not trigger a second paid request', async () => {
    for (const useProxy of [false, true]) for (const adaptationMode of ['deepseek', 'standard']) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return sse([{ choices: [{ delta: { reasoning_content: '只有思考' }, finish_reason: 'length' }], usage }]); };
      const client = new AIClient(); client.configure({ ...base, useProxy, adaptationMode });
      await assert.rejects(client.chatStream(fixture(1), { strictSingleRequest: true, maxRetries: 0 }), /没有返回有效正文/);
      assert.equal(calls, 1);
    }
  });
  await test('cache counts are disjoint and missing provider fields remain unknown', () => {
    assert.deepEqual(readTokenUsage(usage), { input: 1000, output: 120, reasoning: 20, hit: 800, miss: 200, cacheKnown: true });
    const sdk = deepSeekSdkUsage(usage);
    assert.equal(sdk.inputTokens.noCache + sdk.inputTokens.cacheRead, sdk.inputTokens.total);
    assert.equal(sdk.outputTokens.text + sdk.outputTokens.reasoning, sdk.outputTokens.total);
    assert.equal(readTokenUsage({ prompt_tokens: 1000 }).cacheKnown, false);
    assert.equal(readTokenUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 0 }).hit, 0);
    assert.equal(readTokenUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } }).miss, 200);
    assert.equal(readTokenUsage({ input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 }).input, 1000);
  });
  await test('shared proxy metering preserves split Anthropic usage without adding DeepSeek options', async () => {
    const reports = []; const off = eventBus.on('ai:usage', value => reports.push(value));
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body); assert.equal(body.thinking, undefined);
      return sse([
        { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 } } },
        { type: 'content_block_delta', delta: { text: '完成' } },
        { type: 'message_delta', usage: { output_tokens: 25 } },
        { type: 'message_stop' }
      ]);
    };
    try {
      const client = new AIClient(); client.configure({ ...base, backend: 'claude', useProxy: true });
      assert.equal(await client.chatStream([{ role: 'user', content: '继续' }]), '完成');
      assert.equal(reports.length, 1); assert.equal(readTokenUsage(reports[0]).input, 1000);
      assert.equal(readTokenUsage(reports[0]).output, 25);
    } finally { off(); }
  });
  await test('separate auxiliary models do not inherit DeepSeek parameters accidentally', () => {
    assert.equal(inheritAPIAdaptation(base, { ...base, model: 'gpt-other' }).adaptationMode, 'standard');
    assert.equal(inheritAPIAdaptation(base, { ...base, model: 'deepseek-v4-pro' }).adaptationMode, 'deepseek');
    assert.equal(inheritAPIAdaptation(base, { ...base, backend: 'claude', apiUrl: 'https://other.test' }).adaptationMode, 'standard');
  });
  await test('API scheme and settings gateway persist modes without changing auxiliary settings', async () => {
    const { saveApiScheme, getApiScheme } = await import('../js/core/api-schemes.js');
    const { SettingsConfigGateway } = await import('../js/ui/settings-config-gateway.js');
    const id = await saveApiScheme({ name: 'test', ...base, deepseekThinking: 'low' });
    assert.equal((await getApiScheme(id)).deepseekThinking, 'low');
    await saveApiScheme({ id, name: 'renamed' }); assert.equal((await getApiScheme(id)).adaptationMode, 'deepseek');
    let config = { variableUpdater: { enabled: true }, backend: 'openai' };
    await new SettingsConfigGateway({ getAPIConfig: () => config, saveAPIConfig: value => { config = value; } })
      .saveMainAIConnection({ adaptationMode: 'deepseek', deepseekThinking: 'high' });
    assert.equal(config.deepseekThinking, 'high'); assert.deepEqual(config.variableUpdater, { enabled: true });
  });
  await test('real main prompt and variable prompt only move runtime context in opted-in requests', async () => {
    const { MessagePipeline } = await import('../js/core/pipeline.js');
    const { buildVariableUpdaterMessages } = await import('../js/core/variable-updater.js');
    const { DEFAULT_VARIABLE_UPDATER_PRESET } = await import('../js/data/variable-updater-preset.js');
    const pipeline = new MessagePipeline({});
    pipeline.chatHistory = [{ role: 'user', content: '历史操作' }, { role: 'assistant', content: '历史正文' }];
    pipeline._buildMemoryContext = () => '本回合专用记忆';
    const main = pipeline._buildPrompt('状态摘要', { '玩家·姓名': '测试忍者' }, '继续', { updaterEnabled: true });
    const oldWire = normalizeOpenAIMessageOrder(JSON.parse(JSON.stringify(main)));
    assert.equal(oldWire[0].content.includes('本回合专用记忆'), true);
    const newWire = normalizeOpenAIMessageOrder(prepareDeepSeekMessages(main));
    assert.equal(newWire[0].content.includes('本回合专用记忆'), false);
    assert.ok(newWire.findIndex(message => message.content.includes('本回合专用记忆')) > newWire.findIndex(message => message.content === '历史正文'));
    const context = { state: {}, userInput: '等待', narrativeResponse: '片刻过去', memoryContext: '变量阶段专用记忆' };
    const standard = buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, context);
    const explicitOff = buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, { ...context, optimizeContext: false });
    assert.equal(JSON.stringify(standard), JSON.stringify(explicitOff));
    const special = buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, { ...context, optimizeContext: true });
    assert.equal(special[0].content.includes('变量阶段专用记忆'), false);
    assert.equal(standard[0].content.includes('变量阶段专用记忆'), true);
    assert.ok(special.some(message => message.role === 'user' && message.content.includes('变量阶段专用记忆')));
  });
  await test('Android shared adapter sends the same opt-in body through its native bridge', async () => {
    const previous = globalThis.Capacitor;
    let request;
    globalThis.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, registerPlugin: () => ({
      request: async (options, callback) => {
        request = options;
        callback({ type: 'headers', status: 200, headers: { 'Content-Type': 'application/json' }, url: options.url });
        callback({ type: 'data', data: Buffer.from(JSON.stringify({ choices: [{ message: { content: '原生正文' } }], usage })).toString('base64') });
        callback({ type: 'end' }); return options.id;
      }, cancel: async () => {}
    }) };
    try {
      const client = new AIClient(); client.configure({ ...base, useProxy: true });
      assert.equal(await client.chat(fixture(1)), '原生正文');
      assert.equal(request.url, `${base.apiUrl}/chat/completions`);
      assert.equal(JSON.parse(request.body).thinking.type, 'disabled');
    } finally { globalThis.Capacitor = previous; }
  });
  await test('native Agent tool loop uses DeepSeek controls, returns exact thinking history and counts all calls', async () => {
    for (const adaptationMode of ['deepseek', 'standard']) {
      const requests = [];
      const stepUsage = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body); requests.push(body);
        if (requests.length === 1) return jsonResponse({ role: 'assistant', content: '', reasoning_content: '工具调用的思考原文',
          tool_calls: [{ id: 'call-test', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, 'tool_calls');
        return jsonResponse();
      };
      const result = await runAgent({ config: { ...base, adaptationMode, deepseekThinking: 'low' },
        onEvent: event => { if (event.type === 'step-end' && event.usage) stepUsage.push(event.usage); },
        definition: { id: 'test', instructions: '固定 Agent 规则' }, messages: fixture(1).slice(0, -1),
        tools: { lookup: { description: '读状态', inputSchema: { type: 'object', properties: {} }, execute: async () => ({ location: '木叶' }) } },
        budget: { maxSteps: 2 } });
      assert.equal(requests.length, 2); assert.equal(result.text, '测试正文');
      assert.equal(stepUsage.length, 2, 'each billed native step reports usage before later fallback');
      const toolMessage = requests[1].messages.find(message => message.tool_calls?.length);
      assert.equal(toolMessage.reasoning_content, '工具调用的思考原文');
      if (adaptationMode === 'deepseek') {
        assert.equal(requests[0].thinking.type, 'enabled'); assert.equal(requests[1].reasoning_effort, 'low');
        assert.equal(result.usage.inputTokenDetails.cacheReadTokens, 1600);
        assert.equal(result.usage.inputTokenDetails.noCacheTokens, 400);
        assert.equal(requests[0].messages.find(message => message.content === '当前变量与记忆 1').role, 'user');
      } else {
        assert.equal(requests[0].thinking, undefined);
        assert.equal(requests[0].messages.find(message => message.content === '当前变量与记忆 1').role, 'system');
      }
      assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
    }
  });
} finally { globalThis.fetch = originalFetch; }
if (failures.length) process.exitCode = 1;
else console.log(`\n${passed} DeepSeek mode regression groups passed; no paid model calls.`);
