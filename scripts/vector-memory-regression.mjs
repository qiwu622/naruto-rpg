import assert from 'node:assert/strict';
import { VectorMemory, vectorDocuments, requestEmbeddings } from '../js/core/vector-memory.js';
import { getMemoryConfig, saveMemoryConfig, resetMemoryConfig } from '../js/data/memory-config.js';
import { createContinuityLedger, appendMemoryEvents } from '../js/core/continuity-ledger.js';
import { memorySystem } from '../js/systems/memory-system.js';
import { stateManager } from '../js/core/state-manager.js';

let passed = 0;
const check = async (name, run) => { await run(); console.log(`PASS ${name}`); passed++; };
const cfg = { vectorEnabled: true, vectorEndpoint: 'https://embedding.example/v1', vectorModel: 'embedding-test' };
const makeCache = () => { const rows = new Map(); return { rows, async getMany(ids) { return new Map(ids.filter(id => rows.has(id)).map(id => [id, rows.get(id)])); }, async putMany(items) { for (const item of items) rows.set(item.id, item.vector); } }; };
const cache = makeCache(), calls = [];
const embed = async input => { calls.push(input); return input.map(text => text.includes('木叶') ? [1, 0] : [0, 1]); };
let ledger = createContinuityLedger();
for (const [id, node, branch, turn, truth, type, text] of [
  ['past', 'main1', 'branch_main', 1, 'confirmed', 'fact', '木叶的同伴交付了卷轴'],
  ['future', 'main9', 'branch_main', 9, 'confirmed', 'fact', '未来尚未发生'],
  ['if', 'if2', 'branch_if', 2, 'confirmed', 'fact', '其他 IF 线事件'],
  ['option', 'main2', 'branch_main', 2, 'confirmed', 'action_option', '未选行动：去砂隐村'],
  ['rumor', 'main2', 'branch_main', 2, 'reported', 'fact', '传闻被误当成事实']
]) ledger = appendMemoryEvents(ledger, { event_id: id, type, truth, value: text }, { nodeId: node, branchId: branch, turn }).ledger;
const state = { ...stateManager.getDefaultState(), '系统·回合数': 2, _continuity: ledger,
  _memory: { facts: '木叶的街道下过雨', chapters: JSON.stringify([{ id: 1, to: 1, summary: '木叶任务的约定' }, { id: 2, to: 20, summary: '未来章节' }]) } };
const ancestors = new Set(['main1', 'main2']);

await check('disabled by default, no embedding/cache calls, identical local context', async () => {
  resetMemoryConfig(); assert.equal(getMemoryConfig().vectorEnabled, false);
  const service = new VectorMemory({ cache: { getMany: () => { throw new Error('must not read cache'); } }, embed: () => { throw new Error('must not call API'); } });
  assert.deepEqual(await service.recall({ state, query: '木叶', scope: 'save-A', ancestors }), []);
  stateManager.restore(state);
  const before = memorySystem.buildPromptContext(state._memory, { userInput: '木叶' });
  saveMemoryConfig({ vectorEnabled: false, vectorEndpoint: cfg.vectorEndpoint, vectorModel: cfg.vectorModel });
  assert.equal(memorySystem.buildPromptContext(state._memory, { userInput: '木叶' }), before);
});
await check('only current ancestry, past turns and confirmed facts become vector documents', () => {
  const text = vectorDocuments(state, ancestors).map(doc => doc.text).join('\n');
  assert.match(text, /同伴交付/); assert.doesNotMatch(text, /未来|其他 IF|未选行动|误当成事实/);
});
await check('rejected and superseded facts are removed before embedding', () => {
  const corrected = structuredClone(state);
  corrected._continuity = appendMemoryEvents(ledger, { type: 'retraction', retracts: ['past'], value: '修订' }, { nodeId: 'main2', branchId: 'branch_main', turn: 2 }).ledger;
  corrected._memory.corrections = [{ id: 'reject', action: 'reject', field: 'facts', targetText: '街道下过雨' }];
  const text = vectorDocuments(corrected, ancestors).map(doc => doc.text).join('\n');
  assert.doesNotMatch(text, /同伴交付|街道下过雨/);
});
await check('a continuation can retrieve ancestor facts retained before its new root', () => {
  const docs = vectorDocuments(state, new Set(['main2']), 2);
  assert.ok(docs.some(item => item.id === 'event:past'));
  assert.ok(!docs.some(item => item.id === 'event:if' || item.id === 'event:future'));
});
const service = new VectorMemory({ cache, embed, config: () => cfg });
await check('cache reuses unchanged documents and queries; changed text/model/save has distinct cache keys', async () => {
  const args = { state, query: '木叶', scope: 'save-A:main', ancestors };
  const hits = await service.recall(args); assert.ok(hits.length); assert.equal(calls.length, 1);
  await service.recall(args); assert.equal(calls.length, 1);
  await service.recall({ ...args, state: { ...state, _memory: { ...state._memory, facts: '木叶的街道已经放晴' } } });
  assert.equal(calls.length, 2); assert.equal(calls[1].length, 1);
  await service.recall({ ...args, scope: 'save-B:main' }); assert.equal(calls.length, 3);
  cfg.vectorModel = 'embedding-other'; await service.recall(args); assert.equal(calls.length, 4);
});
await check('initial indexing is bounded to 12 documents plus one query', async () => {
  const before = calls.length;
  await service.recall({ state: { ...state, _memory: { facts: Array.from({ length: 100 }, (_, i) => `木叶任务${i}`).join('\n') } }, query: '任务', scope: 'batch', ancestors });
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).length, 13);
});
await check('network errors and timeouts fall back without failing a turn', async () => {
  const fail = new VectorMemory({ cache: makeCache(), config: () => cfg, embed: async () => { throw new Error('network'); } });
  assert.deepEqual(await fail.recall({ state, query: '木叶', scope: 'fail', ancestors }), []);
  const slow = new VectorMemory({ cache: makeCache(), config: () => cfg, embed: async (_input, _config, { signal }) => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  assert.deepEqual(await slow.recall({ state, query: '木叶', scope: 'slow', ancestors, timeoutMs: 20 }), []);
  const stuckCache = new VectorMemory({ cache: { getMany: () => new Promise(() => {}) }, config: () => cfg, embed: () => { throw new Error('must not embed'); } });
  assert.deepEqual(await stuckCache.recall({ state, query: '木叶', scope: 'stuck', ancestors, timeoutMs: 20 }), []);
});
await check('embedding request uses the existing proxy contract and verifies vector dimensions', async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => { seen = { url, options }; return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 }); };
  try { assert.deepEqual(await requestEmbeddings(['木叶'], cfg, {}), [[1, 0]]); assert.ok(seen.url.endsWith('/embeddings') || seen.url === '/api/ai-proxy'); }
  finally { globalThis.fetch = originalFetch; }
});
resetMemoryConfig();
console.log(`${passed} vector memory regression groups passed; no live model requests.`);
