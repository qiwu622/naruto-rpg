import assert from 'node:assert/strict';
import { AgentToolRuntime } from '../js/core/agent-tool-runtime.js';
import { LingXiContextBroker } from '../js/core/lingxi/lingxi-context-broker.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}

function harness({ native, responses }) {
  const requests = [];
  const runtime = new AgentToolRuntime({
    contextBroker: new LingXiContextBroker(),
    sdk: native ? { runAgent: native } : {},
    clientFactory: () => ({
      configure() {}, isConfigured: () => true,
      async chat(messages) { requests.push(structuredClone(messages)); return responses.shift(); }
    })
  });
  runtime.configure({ model: 'test', disableStreaming: true });
  return { runtime, requests };
}
const input = { target: 'save-a', value: 1 };
const options = tools => ({
  definition: { id: 'fallback-regression', instructions: 'Use tools and report their receipts.' },
  messages: [{ role: 'user', content: 'Apply the requested change.' }],
  tools, budget: { maxSteps: 4 }
});

await test('native-to-text fallback reuses a completed write instead of executing it twice', async () => {
  let writes = 0;
  const tools = { change: { effect: 'propose-write', execute: async () => ({ receiptId: `applied-${++writes}` }) } };
  const { runtime, requests } = harness({
    native: async ({ tools }) => { await tools.change.execute(input); throw new Error('native connection lost'); },
    responses: [JSON.stringify({ tool: 'change', input: { value: 1, target: 'save-a' } }), JSON.stringify({ final: 'Done' })]
  });
  await runtime.runAgent(options(tools));
  assert.equal(writes, 1);
  assert.match(JSON.stringify(requests[0]), /applied-1/);
});

await test('text-to-plain fallback retains completed tool results', async () => {
  const { runtime, requests } = harness({ responses: [
    JSON.stringify({ tool: 'inspect', input: {} }), 'not a protocol message', 'The measured value is 47.'
  ] });
  const result = await runtime.runAgent(options({
    inspect: { effect: 'read', execute: async () => ({ measuredValue: 47 }) }
  }));
  assert.equal(result.mode, 'plain-chat');
  assert.match(JSON.stringify(requests.at(-1)), /measuredValue/);
});

await test('fallback does not repeat a write with an uncertain failed outcome', async () => {
  let writes = 0;
  const tools = { change: { effect: 'ui-action', execute: async () => { writes++; throw new Error('receipt unavailable'); } } };
  const { runtime, requests } = harness({
    native: async ({ tools }) => { await tools.change.execute(input); },
    responses: [JSON.stringify({ tool: 'change', input }), JSON.stringify({ final: 'Check the current state.' })]
  });
  await runtime.runAgent(options(tools));
  assert.equal(writes, 1);
  assert.match(JSON.stringify(requests[0]), /receipt unavailable/);
});

await test('two intentional writes in one protocol still execute, and later runs start fresh', async () => {
  let writes = 0;
  const tools = { change: { effect: 'propose-write', execute: async () => ({ count: ++writes }) } };
  const { runtime } = harness({ responses: [
    JSON.stringify({ tool: 'change', input }), JSON.stringify({ tool: 'change', input }), JSON.stringify({ final: 'Done' }),
    JSON.stringify({ tool: 'change', input }), JSON.stringify({ final: 'Done again' })
  ] });
  await runtime.runAgent(options(tools));
  await runtime.runAgent(options(tools));
  assert.equal(writes, 3);
});

await test('fallback re-reads live observations instead of reusing old reads', async () => {
  let reads = 0;
  const tools = { inspect: { effect: 'read', execute: async () => ({ revision: ++reads }) } };
  const { runtime } = harness({
    native: async ({ tools }) => { await tools.inspect.execute({}); throw new Error('native connection lost'); },
    responses: [JSON.stringify({ tool: 'inspect', input: {} }), JSON.stringify({ final: 'Done' })]
  });
  await runtime.runAgent(options(tools));
  assert.equal(reads, 2);
});

await test('large completed tool results stay bounded when switching protocols', async () => {
  const { runtime, requests } = harness({
    native: async ({ tools }) => {
      for (let index = 0; index < 4; index++) await tools.inspect.execute({ index });
      throw new Error('native connection lost');
    },
    responses: [JSON.stringify({ final: 'Done' })]
  });
  await runtime.runAgent(options({
    inspect: { effect: 'read', execute: async () => ({ content: '大'.repeat(100_000) }) }
  }));
  const receipts = requests[0].at(-1).content;
  assert.match(receipts, /tool_result_budget/);
  assert.ok(receipts.length < 16_500, `oversized receipt history: ${receipts.length}`);
});

if (failures.length) process.exitCode = 1;
console.log(`Tool fallback regression: ${passed} passed, ${failures.length} failed.`);
