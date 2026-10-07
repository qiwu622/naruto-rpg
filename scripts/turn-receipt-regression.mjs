import assert from 'node:assert/strict';
import { buildTurnReceipt, normalizeTurnReceipt, withTurnReceiptSaveResult, createTurnStageTracker, TURN_RECEIPT_LIMITS } from '../js/core/turn-receipt.js';

let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const beforeState = {
  '属性·当前查克拉': 50, '进度·金钱': 500, '世界·地点': '训练场',
  _memory: { facts: '已知事实', recent_summary: '上一回合' },
  _relationships: { 鹿丸: { trust: 10, inner_thoughts: '旧秘密' } }
};
const afterState = {
  ...beforeState, '属性·当前查克拉': 35, '进度·金钱': 700, '系统·回合数': 8,
  '物品·道具·苦无·数量': 3,
  _memory: { facts: '已知事实\n完成训练', recent_summary: '与同伴完成训练', npc_notes: 'NPC 私有计划' },
  _relationships: { 鹿丸: { trust: 12, inner_thoughts: '新的私密推理' } },
  _agent_memories: { secret: 'PRIVATE_NPC_REASONING' }, _api: { apiKey: 'sk-NOT_FOR_RECEIPT_123456789' }
};
const make = overrides => buildTurnReceipt({ beforeState, afterState, turnNumber: 8,
  variables: { status: 'success' }, memory: { status: 'success' }, daily: { status: 'success', issue: '第 8 号' }, save: { status: 'pending' }, ...overrides });

test('diff records accepted player state, memory additions and replacements, without private state', () => {
  const receipt = make();
  assert.deepEqual(receipt.variables.changes.find(item => item.label === '当前查克拉'), { label: '当前查克拉', before: '50', after: '35', delta: -15 });
  assert.equal(receipt.variables.changes.find(item => item.label === '苦无 · 数量').after, '3');
  assert.ok(receipt.variables.changes.some(item => item.label === '鹿丸 · 信任' && item.delta === 2));
  assert.ok(receipt.memory.changes.some(item => item.kind === 'added' && item.text === '完成训练'));
  assert.ok(receipt.memory.changes.some(item => item.kind === 'updated' && item.text === '与同伴完成训练'));
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_NPC|私密推理|NPC 私有|sk-|apiKey|inner_thoughts|系统·/);
});

test('missing receipts and unknown schemas never become successful legacy records', () => {
  for (const value of [null, undefined, {}, [], { schema: 'turn-receipt.v2', save: { status: 'success' } }]) assert.equal(normalizeTurnReceipt(value), null);
  const receipt = buildTurnReceipt();
  assert.equal(receipt.save.status, 'unknown');
  assert.equal(receipt.variables.status, 'unknown');
  assert.equal(receipt.variables.comparisonKnown, false);
  assert.equal(receipt.durationMs, null);
});

test('variable skip and save failure preserve the recorded narrative outcomes honestly', () => {
  const receipt = make({ variables: { status: 'skipped' }, save: { status: 'failed', reasonCode: 'quota', error: 'apiKey=secret' } });
  assert.equal(receipt.variables.status, 'skipped');
  assert.equal(receipt.save.status, 'failed');
  assert.equal(receipt.memory.status, 'success');
  assert.equal(receipt.save.reasonCode, 'quota');
  assert.equal(receipt.save.error, undefined);
  const saved = withTurnReceiptSaveResult(receipt, { status: 'success' });
  assert.equal(saved.save.status, 'success');
  assert.equal(receipt.save.status, 'failed');
  assert.equal(withTurnReceiptSaveResult(null, { status: 'success' }), null);
});

test('round trip is stable and summaries remain bounded while retaining total counts', () => {
  const state = { ...afterState, _memory: { facts: Array.from({ length: 80 }, (_, index) => `事实${index} ${'很长'.repeat(150)}`).join('\n') } };
  for (let index = 0; index < 60; index++) state[`物品·道具·道具${index}·数量`] = index;
  const receipt = make({ afterState: state });
  assert.equal(receipt.variables.changes.length, TURN_RECEIPT_LIMITS.variables);
  assert.equal(receipt.memory.changes.length, TURN_RECEIPT_LIMITS.memories);
  assert.ok(receipt.variables.total > receipt.variables.changes.length);
  assert.ok(receipt.memory.total > receipt.memory.changes.length);
  assert.ok(receipt.memory.changes.every(item => item.text.length <= TURN_RECEIPT_LIMITS.text));
  assert.deepEqual(normalizeTurnReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
});

test('import projection drops raw model data, strips private wrappers and does not invent timings', () => {
  const receipt = normalizeTurnReceipt({ ...make(), rawPrompt: 'NEVER_PERSIST',
    memory: { status: 'success', changes: [{ label: 'facts', kind: 'added', text: '<think>PRIVATE_THOUGHT</think>公开 sk-secret123456789' }] },
    stages: [{ key: 'narrative', status: 'success', raw: 'PRIVATE_STAGE' }, { key: 'secret-agent', status: 'success' }] });
  assert.doesNotMatch(JSON.stringify(receipt), /NEVER_PERSIST|PRIVATE_|sk-secret/);
  assert.equal(receipt.stages.length, 1);
  assert.equal(receipt.stages[0].retries, null);
  assert.equal(receipt.stages[0].durationMs, null);
  assert.equal(receipt.memory.changes[0].label, '记忆');
});

test('stage tracker measures explicit starts, finishes and retries without inferring success', () => {
  let now = 100;
  const tracker = createTurnStageTracker({ now: () => now });
  tracker.start('narrative'); now = 200; tracker.start('narrative'); now = 900;
  tracker.retry('narrative'); tracker.finish('narrative', 'success');
  now = 1200; tracker.finish('narrative', 'success');
  tracker.start('variables'); tracker.retry('variables'); now = 1700;
  tracker.finish('variables', 'skipped'); tracker.start('save'); now = 1750;
  const records = tracker.snapshot();
  assert.deepEqual(records[0], { key: 'narrative', status: 'success', durationMs: 800, retries: 1 });
  assert.deepEqual(records[1], { key: 'variables', status: 'skipped', durationMs: 500, retries: 1 });
  assert.deepEqual(records[2], { key: 'save', status: 'pending', durationMs: 50, retries: 0 });
  tracker.start('not-player-visible'); assert.equal(tracker.snapshot().length, 3);
});

test('receipt generation failure is contained and cannot reject the narrative', () => {
  const before = new Proxy({}, { ownKeys() { throw new Error('bad snapshot'); } });
  assert.equal(buildTurnReceipt({ beforeState: before, afterState: {} }), null);
  assert.equal(normalizeTurnReceipt(new Proxy({}, { get() { throw new Error('bad receipt'); } })), null);
});

console.log(`turn receipt regression: ${passed} passed`);
