import assert from 'node:assert/strict';

import {
  collectHotNodeIds,
  compressTimelineNode,
  decompressTimelineNode,
  estimateTimelineNodeBytes,
  isCompressedTimelineNode,
  listingTimelineNode,
  TIMELINE_HOT_WINDOW
} from '../js/core/timeline-node-codec.js';
import { sanitizeTimelineNode } from '../js/core/timeline-save-schema.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

const snapshot = {
  _version: '5.0',
  '世界·地点': '木叶隐村',
  '系统·回合数': 21,
  marker: 'codec-roundtrip',
  _continuity: { schema: 'naruto.continuity-ledger/v1', revision: 1, legacy_migration_version: 0, events: [] }
};

await test('gzip node codec round-trips snapshots and stamps location', async () => {
  const node = {
    id: 'node_cold',
    parent_id: 'node_hot',
    turn_number: 21,
    chat_history_delta: [{ role: 'user', content: 'keep' }],
    continuity_delta: [{ event_id: 'event_1' }],
    maintenance: { label: '变量维护', before_state_snapshot: { ...snapshot, marker: 'before' } },
    state_snapshot: snapshot
  };
  const compressed = await compressTimelineNode(node);
  assert.equal(isCompressedTimelineNode(compressed), true);
  assert.equal(compressed.state_snapshot, undefined);
  assert.equal(compressed.location, '木叶隐村');
  assert.equal(compressed.maintenance.before_state_snapshot, undefined);
  assert.deepEqual(compressed.chat_history_delta, node.chat_history_delta);
  assert.ok(compressed.payload.byteLength > 0);

  const restored = await decompressTimelineNode(compressed);
  assert.equal(isCompressedTimelineNode(restored), false);
  assert.equal(restored.state_snapshot.marker, 'codec-roundtrip');
  assert.equal(restored.maintenance.before_state_snapshot.marker, 'before');
  assert.deepEqual(restored.chat_history_delta, node.chat_history_delta);
});

await test('sanitize keeps gzip payload bytes on compressed nodes', async () => {
  const compressed = await compressTimelineNode({
    id: 'node_sanitized',
    state_snapshot: snapshot
  });
  const sanitized = sanitizeTimelineNode(compressed, 'timeline_node.node_sanitized');
  assert.equal(isCompressedTimelineNode(sanitized), true);
  assert.deepEqual([...sanitized.payload], [...compressed.payload]);
});

await test('listing helper strips binary payload for fingerprints', async () => {
  const compressed = await compressTimelineNode({
    id: 'node_list',
    summary: '旧回合',
    state_snapshot: snapshot
  });
  const listed = listingTimelineNode(compressed);
  assert.equal(Object.hasOwn(listed, 'payload'), false);
  assert.equal(Object.hasOwn(listed, 'state_snapshot'), false);
  assert.ok(listed.payload_bytes > 0);
  assert.equal(listed.summary, '旧回合');
  JSON.stringify(listed);
});

await test('hot window keeps the current node and 19 ancestors', () => {
  const nodes = Array.from({ length: 25 }, (_, index) => ({
    id: `node_${index}`,
    parent_id: index === 0 ? null : `node_${index - 1}`
  }));
  const hot = collectHotNodeIds(nodes, 'node_24', TIMELINE_HOT_WINDOW);
  assert.equal(hot.size, 20);
  assert.equal(hot.has('node_24'), true);
  assert.equal(hot.has('node_5'), true);
  assert.equal(hot.has('node_4'), false);
});

await test('missing CompressionStream leaves the node uncompressed', async () => {
  const original = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  try {
    const node = { id: 'node_plain', state_snapshot: snapshot };
    const result = await compressTimelineNode(node);
    assert.equal(isCompressedTimelineNode(result), false);
    assert.equal(result.state_snapshot.marker, 'codec-roundtrip');
  } finally {
    globalThis.CompressionStream = original;
  }
});

await test('storage estimate uses payload byteLength instead of expanding typed arrays', async () => {
  const compressed = await compressTimelineNode({
    id: 'node_bytes',
    state_snapshot: { ...snapshot, blob: 'x'.repeat(4000) }
  });
  const estimated = estimateTimelineNodeBytes(compressed);
  const naive = JSON.stringify({ ...compressed, payload: undefined }).length + compressed.payload.length * 8;
  assert.ok(estimated < naive);
  assert.ok(estimated > compressed.payload.byteLength);
});

await test('large legacy nodes remain readable without rewriting the compressed original', async () => {
  // 36 MiB of UTF-8 memory is a valid old node, even though its compressed
  // representation is tiny. The writer has never imposed a 32 MiB limit.
  const memory = '记忆'.repeat(3 * 1024 * 1024);
  const node = {
    id: 'large-legacy-node',
    state_snapshot: { ...snapshot, _memory: { facts: memory, archived: memory } },
    maintenance: { before_state_snapshot: { ...snapshot, marker: 'before-large-node' } },
    maintenance_history: [{ before_state_snapshot: { ...snapshot, marker: 'old-maintenance' } }]
  };
  const compressed = await compressTimelineNode(node);
  const original = compressed.payload.slice();
  const restored = await decompressTimelineNode(compressed);
  assert.equal(restored.state_snapshot._memory.facts, memory);
  assert.equal(restored.state_snapshot._memory.archived, memory);
  assert.equal(restored.maintenance.before_state_snapshot.marker, 'before-large-node');
  assert.equal(restored.maintenance_history[0].before_state_snapshot.marker, 'old-maintenance');
  assert.deepEqual(compressed.payload, original);
  assert.equal(compressed.state_snapshot, undefined);
});

await test('explicit node read limits count UTF-8 bytes and preserve the source on failure', async () => {
  const state_snapshot = { marker: '忍者记忆' };
  const compressed = await compressTimelineNode({ id: 'bounded-node', state_snapshot });
  const original = compressed.payload.slice();
  const byteLength = new TextEncoder().encode(JSON.stringify({ state_snapshot })).byteLength;
  assert.deepEqual((await decompressTimelineNode(compressed, { maxDecompressedBytes: byteLength })).state_snapshot, state_snapshot);
  await assert.rejects(decompressTimelineNode(compressed, { maxDecompressedBytes: byteLength - 1 }), /时间线节点解压后超过.*上限/);
  assert.deepEqual(compressed.payload, original);
  for (const maxDecompressedBytes of [0, -1, NaN, null, 1.5, -Infinity]) {
    await assert.rejects(decompressTimelineNode(compressed, { maxDecompressedBytes }), /上限必须/);
  }
});

await test('corrupted gzip nodes still fail without changing their original payload', async () => {
  const node = await compressTimelineNode({ id: 'damaged-node', state_snapshot: snapshot });
  node.payload = node.payload.slice(0, -8);
  const original = node.payload.slice();
  await assert.rejects(decompressTimelineNode(node));
  assert.deepEqual(node.payload, original);
});

console.log(`\n${passed} timeline node codec regression tests passed.`);
