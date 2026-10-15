import assert from 'node:assert/strict';
import { AIClient } from '../js/core/ai-client.js';
import { runVariableUpdater } from '../js/core/variable-updater.js';
import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
globalThis.customElements ||= { get: () => null };
const base = { backend: 'openai', apiUrl: 'https://model.invalid/v1', apiKey: 'fixture-only', model: 'gemini-3-flash-preview' };
const json = () => Response.json({ choices: [{ message: { content: 'test' }, finish_reason: 'stop' }] });
const sse = (content, finish) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
const originalFetch = globalThis.fetch;
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  await test('Gemini requests omit unsupported penalty defaults without altering the prompt', async () => {
    for (const model of ['gemini-3-flash-preview', 'provider/gemini-3-flash-preview', '假流式-gemini-3.8-flash']) {
      let body;
      globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return json(); };
      const client = new AIClient(); client.configure({ ...base, model });
      const messages = [{ role: 'system', content: '固定变量规则' }, { role: 'user', content: '本轮事实' }];
      await client.chatDetailed(messages);
      assert.equal(Object.hasOwn(body, 'frequency_penalty'), false, model);
      assert.deepEqual(body.messages, messages);
    }
  });
  await test('other providers retain their previous default sampling parameters', async () => {
    let body;
    globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return json(); };
    const client = new AIClient(); client.configure({ ...base, model: 'gpt-fixture' });
    await client.chatDetailed([{ role: 'user', content: 'test' }]);
    assert.equal(body.frequency_penalty, 0.2);
    assert.equal(body.temperature, 0.9);
  });
  await test('permanent request errors do not repeat the same paid model request', async () => {
    for (const backend of ['openai', 'claude']) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('unsupported parameter', { status: 400 }); };
      const client = new AIClient(); client.configure({ ...base, backend });
      await assert.rejects(() => client.chatStream([{ role: 'user', content: 'test' }], { retryDelay: 0 }, () => {}));
      assert.equal(calls, 1, backend);
    }
  });
  await test('stream finish reason reaches the variable updater on direct and proxy paths', async () => {
    const stateText = '<variable_thinking>已核对</variable_thinking><variable>{"path":"progression.exp","op":"add","value":3}</variable><memory>{"summary":"完成训练"}</memory>';
    const text = `${stateText}<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`;
    for (const useProxy of [false, true]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return sse(text, 'length'); };
      await assert.rejects(() => runVariableUpdater({ mainConfig: { ...base, useProxy,
        variableUpdater: { enabled: true, streaming: true } },
        state: { '系统·回合数': 8 }, userInput: '训练', narrativeResponse: '训练完成' }), error => {
        assert.equal(error.failureKind, 'truncated'); return true;
      });
      assert.equal(calls, 1);
    }
  });
  await test('Claude message_delta and non-SSE responses report their terminal reason', async () => {
    for (const useProxy of [false, true]) for (const streamed of [false, true]) {
      globalThis.fetch = async () => streamed
        ? new Response([
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'test' } },
          { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
          { type: 'message_stop' }
        ].map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
        : Response.json({ content: [{ type: 'text', text: 'test' }], stop_reason: 'max_tokens' });
      const client = new AIClient(); client.configure({ ...base, backend: 'claude', useProxy });
      const reasons = [];
      const output = await client.chatStream([{ role: 'user', content: 'test' }], { onFinish: value => reasons.push(value.finishReason) });
      assert.equal(output, 'test');
      assert.deepEqual(reasons, ['max_tokens']);
    }
  });
  await test('temporary server errors can still retry before any visible text', async () => {
    let calls = 0;
    globalThis.fetch = async () => ++calls === 1
      ? new Response('temporarily unavailable', { status: 503 }) : sse('recovered', 'stop');
    const client = new AIClient(); client.configure(base);
    assert.equal(await client.chatStream([{ role: 'user', content: 'test' }], { retryDelay: 0 }), 'recovered');
    assert.equal(calls, 2);
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`${passed} AI compatibility tests passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
