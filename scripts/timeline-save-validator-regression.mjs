import assert from 'node:assert/strict';

import { inspectTimelineSave } from '../js/core/timeline-save-schema.js';
import {
  CONTINUITY_LEDGER_SCHEMA,
  inspectContinuityLedger
} from '../js/core/continuity-ledger.js';
import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

function createWideSave(count) {
  const childIds = Array.from({ length: count - 1 }, (_, index) => `node_${index + 1}`);
  const nodes = [{
    id: 'node_0', parent_id: null, children_ids: childIds,
    branch_id: 'branch_0', turn_number: 0, depth: 0, state_snapshot: null
  }];
  const branches = [{
    id: 'branch_0', head_node_id: 'node_0', node_count: 1, is_active: true
  }];
  for (let index = 1; index < count; index++) {
    nodes.push({
      id: `node_${index}`, parent_id: 'node_0', children_ids: [],
      branch_id: `branch_${index}`, turn_number: 1, depth: 1, state_snapshot: null
    });
    branches.push({
      id: `branch_${index}`, head_node_id: `node_${index}`, node_count: 1, is_active: false
    });
  }
  return {
    nodes,
    branches,
    meta: {
      root_id: 'node_0', current_id: 'node_0', active_branch: 'branch_0', total_nodes: count
    }
  };
}

test('wide timelines validate without repeated includes/filter scans', () => {
  const save = createWideSave(1200);
  const originalIncludes = Array.prototype.includes;
  const originalFilter = Array.prototype.filter;
  let includesCalls = 0;
  let filterCalls = 0;
  Array.prototype.includes = function countedIncludes(...args) {
    includesCalls++;
    return originalIncludes.apply(this, args);
  };
  Array.prototype.filter = function countedFilter(...args) {
    filterCalls++;
    return originalFilter.apply(this, args);
  };
  try {
    const result = inspectTimelineSave(save);
    assert.deepEqual(result, { valid: true, errors: [] });
  } finally {
    Array.prototype.includes = originalIncludes;
    Array.prototype.filter = originalFilter;
  }
  assert.ok(includesCalls < 10, `unexpected includes scans: ${includesCalls}`);
  assert.ok(filterCalls < 10, `unexpected filter scans: ${filterCalls}`);
});

test('continuity inspection reports non-array references instead of throwing', () => {
  const ledger = {
    schema: CONTINUITY_LEDGER_SCHEMA,
    revision: 0,
    legacy_migration_version: 0,
    events: [{
      schema: 'naruto.memory-event/v1', event_id: 'event_1', node_id: 'node_0',
      branch_id: 'branch_0', type: 'fact', subject_id: 'world', predicate: 'test',
      game_time: '', sequence: 1, turn: 0, recorded_at: 0, truth: 'confirmed',
      visibility: 'public', known_by: [], supersedes: { bad: true }, retracts: 42,
      importance: 1, source: { kind: 'test' }, evidence: [], value: null
    }]
  };
  let result;
  assert.doesNotThrow(() => { result = inspectContinuityLedger(ledger); });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /supersedes|retracts/);
});

test('timeline inspection is total for malformed JSON-shaped continuity fields', () => {
  const malformed = createWideSave(2);
  malformed.nodes[0].state_snapshot = {
    _version: '5.0',
    _continuity: {
      schema: CONTINUITY_LEDGER_SCHEMA,
      revision: 0,
      legacy_migration_version: 0,
      events: { not: 'an array' }
    }
  };
  malformed.nodes[0].continuity_delta = [{ supersedes: {}, retracts: false }];
  let result;
  assert.doesNotThrow(() => { result = inspectTimelineSave(malformed); });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /连续性|continuity_delta|events/);

  for (const value of [null, true, 7, 'save', [], {}, { nodes: {}, branches: 'bad' }]) {
    assert.doesNotThrow(() => inspectTimelineSave(value));
    assert.equal(inspectTimelineSave(value).valid, false);
  }
});

test('timeline import validation accepts a valid persisted shinobi daily', () => {
  const save = createWideSave(1);
  save.nodes[0].shinobi_daily = structuredClone(SHINOBI_DAILY_EXAMPLE);
  assert.deepEqual(inspectTimelineSave(save), { valid: true, errors: [] });
});

test('timeline import validation rejects locally gzipped node payloads', () => {
  const save = createWideSave(1);
  save.nodes[0].payload_encoding = 'gzip-json-v1';
  save.nodes[0].payload = new Uint8Array([1, 2, 3]);
  const result = inspectTimelineSave(save);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /gzip 载荷/);
});

test('timeline import validation rejects an invalid persisted shinobi daily', () => {
  const save = createWideSave(1);
  save.nodes[0].shinobi_daily = structuredClone(SHINOBI_DAILY_EXAMPLE);
  save.nodes[0].shinobi_daily.missions[0].rank = null;
  const result = inspectTimelineSave(save);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /node_0: shinobi_daily 忍界日报无效/);
  assert.match(result.errors.join('; '), /rank 必须是字符串/);
});

console.log(`\n${passed} timeline save validator regression tests passed.`);
