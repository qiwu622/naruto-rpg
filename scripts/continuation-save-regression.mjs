import assert from 'node:assert/strict';
import { buildContinuationCopy, continuationSaveScope, planContinuationCopy } from '../js/core/continuation-save.js';
import { assertTimelineSave } from '../js/core/timeline-save-schema.js';
import { rebuildContinuityFromAncestry } from '../js/core/continuity-ledger.js';
import { decodeTimelineSaveFile, encodeTimelineSave } from '../js/core/timeline-file-codec.js';
import { createSavePackage, PERSONAL_SAVE_KIND, validateSavePackage } from '../js/core/save-library.js';
import { PersonalSaveLibrary } from '../js/core/personal-save-library.js';
import { timelineSystem } from '../js/systems/timeline-system.js';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';

let passed = 0;
async function test(label, run) { await run(); console.log(`PASS ${label}`); passed++; }
const source = makeContinuationFixture();
assertTimelineSave(source);
const before = JSON.stringify(source);
const copy = buildContinuationCopy(source, { sourceId: 'solo:original', sourceLabel: '完整故事' });

await test('default copy retains 50 turns of the selected route; original/future/IF archives remain unchanged', () => {
  assert.equal(copy.nodes.length, 50);
  assert.equal(copy.nodes[0].turn_number, 71);
  assert.equal(copy.nodes.at(-1).turn_number, 120);
  assert.equal(copy.branches.length, 1);
  assert.equal(copy.branches[0].id, 'branch_main');
  assert.equal(JSON.stringify(source), before);
  assert.ok(copy.nodes.every(node => node.id.startsWith('if_')));
  assert.equal(copy.meta.value.continuation.source_save_id, 'solo:original');
  assertTimelineSave(copy);
});

await test('each rollback point preserves its own memories, relationships and plans with no sibling/future leakage', () => {
  for (const node of copy.nodes) {
    const original = source.nodes.find(item => item.id === node.id);
    for (const key of ['_memory', '_relationships', '_continuity', 'marker']) assert.deepEqual(node.state_snapshot[key], original.state_snapshot[key]);
    assert.equal(node.state_snapshot._meta.current_node_id, node.id);
    assert.equal(node.state_snapshot._agent_story_plan.branchId, 'branch_main');
    assert.equal(node.state_snapshot._story_direction.branchId, 'branch_main');
    assert.equal(node.clean_response, original.clean_response);
    assert.deepEqual(node.shinobi_daily, original.shinobi_daily);
    assert.deepEqual(node.media, original.media);
  }
  const memory = copy.nodes[0].state_snapshot._continuity.events;
  assert.equal(memory.length, 71);
  assert.ok(!memory.some(event => event.value === '主线61' || event.value === 'IF120'));
  assert.equal(copy.nodes.at(-1).state_snapshot._continuity.events.length, 120);
});

await test('delta-only reconstruction retains earlier facts at the new root', () => {
  assert.deepEqual(rebuildContinuityFromAncestry(copy.nodes, copy.nodes.at(-1).id, { preferSnapshot: false }), copy.nodes.at(-1).state_snapshot._continuity);
});

await test('copying an earlier saved position cannot choose the later branch head', () => {
  const earlier = structuredClone(source);
  earlier.meta.value.current_id = 'if_75';
  const result = buildContinuationCopy(earlier, { keepTurns: 20 });
  assert.equal(result.nodes.at(-1).id, 'if_75');
  assert.equal(result.nodes[0].turn_number, 56);
  assert.equal(result.nodes.at(-1).state_snapshot._continuity.events.length, 75);
  assert.ok(!JSON.stringify(result.nodes).includes('IF120'));
});

await test('IF anchor at the same turn does not consume an extra retained turn or duplicate chat', () => {
  const data = structuredClone(source);
  const parent = data.nodes.at(-1);
  const anchor = { ...structuredClone(parent), id: 'anchor', parent_id: parent.id, depth: parent.depth + 1, children_ids: [], branch_anchor: true, continuity_delta: [], chat_history_delta: [], chat_history: parent.chat_history_delta };
  parent.children_ids.push(anchor.id);
  data.nodes.push(anchor);
  data.branches[1].head_node_id = anchor.id;
  data.branches[1].node_count++;
  data.meta.value.current_id = anchor.id;
  data.meta.value.total_nodes++;
  const result = buildContinuationCopy(data, { keepTurns: 1 });
  assert.equal(result.nodes.length, 2);
  assert.equal(result.meta.value.continuation.retained_turns, 1);
  assert.deepEqual(result.nodes.at(-1).chat_history_delta, []);
  assert.equal(result.nodes.at(-1).chat_history, null);
});

await test('legacy full chat histories shrink to per-turn evidence; display choices remain outside AI memory', () => {
  const legacy = structuredClone(source);
  for (const node of legacy.nodes) {
    node.chat_history = [{ role: 'assistant', content: '很早的完整聊天原文'.repeat(50) }, ...node.chat_history_delta];
    node.chat_history.at(-1).content = node.clean_response;
    delete node.chat_history_delta;
  }
  const result = buildContinuationCopy(legacy, { keepTurns: 1 });
  assert.equal(result.nodes[0].chat_history, null);
  assert.equal(result.nodes[0].chat_history_delta.length, 2);
  assert.ok(!JSON.stringify(result.nodes[0].chat_history_delta).includes('尚未选择'));
  assert.match(result.nodes[0].clean_response, /尚未选择/);
});

await test('one-turn and short archives stay playable; invalid counts and missing states fail before producing data', () => {
  assert.equal(buildContinuationCopy(source, { keepTurns: 1 }).nodes.length, 1);
  const short = makeContinuationFixture(4);
  assert.equal(planContinuationCopy(short).retainedTurns, 4);
  for (const keepTurns of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => buildContinuationCopy(source, { keepTurns }), /整数/);
  const broken = structuredClone(source);
  broken.nodes.at(-1).state_snapshot = null;
  assert.throws(() => buildContinuationCopy(broken), /缺少完整状态/);
});

await test('save packages stream their nested payload and round-trip JSON/gzip, scope and checksum', async () => {
  const pack = await createSavePackage(PERSONAL_SAVE_KIND, copy, '轻量副本');
  const stringify = JSON.stringify;
  JSON.stringify = function(value, ...args) {
    if (value === pack || value === pack.payload) throw new Error('Do not serialize a complete package/payload at once');
    return stringify.call(this, value, ...args);
  };
  try {
    for (const compression of ['json', 'gzip']) {
      const decoded = await decodeTimelineSaveFile((await encodeTimelineSave(pack, { compression })).blob);
      assert.deepEqual(decoded, pack);
      assert.equal(continuationSaveScope(decoded.payload).from_turn, 71);
      await validateSavePackage(decoded);
    }
  } finally { JSON.stringify = stringify; }
  const cyclic = {}; cyclic.child = cyclic;
  await assert.rejects(encodeTimelineSave(cyclic, { compression: 'json' }), /循环/);
});

await test('scope survives normalization and grows after continuation play', () => {
  const normalized = new PersonalSaveLibrary().normalize(copy);
  assert.equal(normalized.meta.value.continuation.from_turn, 71);
  const next = structuredClone(normalized.nodes.at(-1));
  next.id = 'continued'; next.turn_number = 121;
  normalized.nodes.push(next); normalized.meta.value.current_id = next.id;
  assert.equal(continuationSaveScope(normalized).through_turn, 121);
  const nested = buildContinuationCopy(copy, { keepTurns: 10 });
  assert.equal(nested.meta.value.continuation.from_turn, 111);
  assert.equal(nested.meta.value.continuation.source_was_continuation, true);
});

await test('old snapshot formats remain migratable and multiplayer sidecars remain outside Agent-visible data', () => {
  const legacy = structuredClone(source);
  legacy.nodes.forEach(node => { node.state_snapshot._version = '3.0'; });
  const converted = new PersonalSaveLibrary().normalize(buildContinuationCopy(legacy, { keepTurns: 2 }));
  assert.equal(converted.nodes.length, 2);
  const linked = { ...source,
    schema: 'naruto.multiplayer-personal-timeline/v1', codec: 'naruto.multiplayer-to-singleplayer/v1',
    multiplayer_export: { room_id: 'original-room' },
    multiplayer_record_sidecar: {
      schema: 'naruto.multiplayer-record-sidecar/v1', inject_to_agent: false,
      counterpart_private_pov_included: false,
      actor_bindings: ['binding-A', 'binding-B'].map(opaque_binding_token => ({ opaque_binding_token, inject_to_agent: false })),
      multiplayer_records: [{ inject_to_agent: false, checkpoint_id: 'original-checkpoint' }],
      server_reimport_capsule: { schema: 'naruto.multiplayer-server-reimport-capsule/v1', inject_to_agent: false }
    }
  };
  const result = new PersonalSaveLibrary().normalize(buildContinuationCopy(linked, { keepTurns: 2 }));
  assert.deepEqual(result.multiplayer_record_sidecar, linked.multiplayer_record_sidecar);
  assert.deepEqual(result.multiplayer_export, linked.multiplayer_export);
  assert.ok(!JSON.stringify(result.nodes).includes('binding-A'));
});

await test('failed original backup cannot create a partial copy or switch the current game', async () => {
  let reset = false, putCalls = 0;
  const personal = new PersonalSaveLibrary({
    timeline: { getExportData: async () => source, normalizeImportForArchive: data => timelineSystem.normalizeImportForArchive(data), emergencyReset: () => { reset = true; } },
    library: { list: async () => [], put: async () => { putCalls++; throw new Error('磁盘已满'); } }
  });
  await assert.rejects(personal.createContinuation(), /磁盘已满/);
  assert.equal(putCalls, 1); assert.equal(reset, false);
  assert.equal(JSON.stringify(source), before);
});

console.log(`\n${passed} continuation save regression groups passed; no model calls.`);
