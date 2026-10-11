import { listingTimelineNode } from '../js/core/timeline-node-codec.js';
import assert from 'node:assert/strict';

import { stateManager } from '../js/core/state-manager.js';
import { inspectTimelineSave } from '../js/core/timeline-save-schema.js';
import { timelineSystem } from '../js/systems/timeline-system.js';

const clone = value => structuredClone(value);
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(String(key)) ?? null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: key => storage.delete(String(key))
};

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.stack || error.message}`);
  }
}

function snapshot(marker, nodeId, branchId) {
  return {
    _version: '5.0',
    marker,
    _meta: { current_node_id: nodeId, active_branch: branchId }
  };
}

function node(id, parentId, branchId, turn, children = []) {
  return {
    id,
    parent_id: parentId,
    children_ids: [...children],
    branch_id: branchId,
    turn_number: turn,
    depth: turn,
    state_snapshot: snapshot(id, id, branchId),
    archived: false,
    accessed_count: 0
  };
}

function branch(id, headNodeId, nodeCount, {
  active = false,
  divergedFrom = null,
  name = id
} = {}) {
  return {
    id,
    name,
    head_node_id: headNodeId,
    diverged_from: divergedFrom,
    node_count: nodeCount,
    is_active: active
  };
}

function meta(currentId, activeBranch, totalNodes) {
  return {
    key: 'root',
    value: {
      root_id: 'node_root',
      current_id: currentId,
      active_branch: activeBranch,
      total_nodes: totalNodes
    }
  };
}

async function withTimelineDb(seed, fn) {
  const stores = {
    timeline_nodes: new Map(seed.nodes.map(item => [item.id, clone(item)])),
    timeline_branches: new Map(seed.branches.map(item => [item.id, clone(item)])),
    timeline_meta: new Map([['root', clone(seed.meta)]])
  };
  const methods = [
    'initDB', 'dbGet', 'dbGetAll', 'dbTimelineSummaries', 'dbPut', 'dbDelete', 'dbClear',
    'dbReplaceTimeline', 'dbCommitTimeline', 'dbMutateTimeline'
  ];
  const originals = Object.fromEntries(methods.map(name => [name, stateManager[name]]));
  const originalEmergencyReset = timelineSystem.emergencyReset;
  let emergencyResetCalls = 0;
  let queue = Promise.resolve();

  stateManager.initDB = async () => ({});
  stateManager.dbGet = async (name, key) => clone(stores[name].get(key));
  stateManager.dbGetAll = async name => [...stores[name].values()].map(clone);
  stateManager.dbTimelineSummaries = async () => [...stores.timeline_nodes.values()].map(listingTimelineNode);
  stateManager.dbPut = async (name, value) => {
    stores[name].set(value.id ?? value.key, clone(value));
  };
  stateManager.dbDelete = async (name, key) => { stores[name].delete(key); };
  stateManager.dbClear = async name => { stores[name].clear(); };
  stateManager.dbMutateTimeline = (mutator, { nodeKeys = null, branchKeys = null } = {}) => {
    const execute = async () => {
      const next = Object.fromEntries(
        Object.entries(stores).map(([name, values]) => [
          name,
          new Map([...values].map(([key, value]) => [key, clone(value)]))
        ])
      );
      const mutation = mutator({
        nodes: Array.isArray(nodeKeys)
          ? nodeKeys.map(key => next.timeline_nodes.get(key)).filter(Boolean).map(clone)
          : [...next.timeline_nodes.values()].map(clone),
        branches: Array.isArray(branchKeys)
          ? branchKeys.map(key => next.timeline_branches.get(key)).filter(Boolean).map(clone)
          : [...next.timeline_branches.values()].map(clone),
        meta: clone(next.timeline_meta.get('root'))
      });
      if (!mutation || typeof mutation !== 'object' || typeof mutation.then === 'function') {
        throw new TypeError('invalid timeline mutation');
      }
      for (const id of mutation.deleteNodeIds || []) next.timeline_nodes.delete(id);
      for (const id of mutation.deleteBranchIds || []) next.timeline_branches.delete(id);
      for (const item of mutation.nodes || []) next.timeline_nodes.set(item.id, clone(item));
      for (const item of mutation.branches || []) next.timeline_branches.set(item.id, clone(item));
      if (mutation.meta) next.timeline_meta.set(mutation.meta.key, clone(mutation.meta));
      Object.assign(stores, next);
      return mutation.result;
    };
    const operation = queue.then(execute, execute);
    queue = operation.catch(() => {});
    return operation;
  };
  timelineSystem.emergencyReset = async () => { emergencyResetCalls += 1; };
  timelineSystem._nodeCache.clear();
  timelineSystem._pendingBranchFrom = null;
  stateManager.reset();
  stateManager.setSub('_meta', {
    current_node_id: seed.meta.value.current_id,
    active_branch: seed.meta.value.active_branch
  });

  try {
    return await fn(stores, () => emergencyResetCalls);
  } finally {
    for (const [name, method] of Object.entries(originals)) stateManager[name] = method;
    timelineSystem.emergencyReset = originalEmergencyReset;
    timelineSystem._nodeCache.clear();
    timelineSystem._pendingBranchFrom = null;
  }
}

function timelineData(stores) {
  return {
    nodes: [...stores.timeline_nodes.values()].map(clone),
    branches: [...stores.timeline_branches.values()].map(clone),
    meta: clone(stores.timeline_meta.get('root'))
  };
}

function assertValidTimeline(stores) {
  const result = inspectTimelineSave(timelineData(stores));
  assert.equal(result.valid, true, result.errors.join('\n'));
}

await test('pruning across a fork deletes empty descendant branches and recomputes counters', async () => {
  const nodes = [
    node('node_root', null, 'branch_main', 0, ['node_main_1']),
    node('node_main_1', 'node_root', 'branch_main', 1, ['node_main_2', 'node_if_1']),
    node('node_main_2', 'node_main_1', 'branch_main', 2),
    node('node_if_1', 'node_main_1', 'branch_if', 2, ['node_if_2']),
    node('node_if_2', 'node_if_1', 'branch_if', 3)
  ];
  const branches = [
    branch('branch_main', 'node_main_2', 3),
    branch('branch_if', 'node_if_2', 2, { active: true, divergedFrom: 'node_main_1' })
  ];
  await withTimelineDb({ nodes, branches, meta: meta('node_if_2', 'branch_if', 5) }, async stores => {
    const result = await timelineSystem.pruneForward('node_main_1');
    assert.equal(result.pruned, 3);
    assert.deepEqual([...stores.timeline_nodes.keys()].sort(), ['node_main_1', 'node_root']);
    assert.equal(stores.timeline_branches.has('branch_if'), false);
    const main = stores.timeline_branches.get('branch_main');
    assert.equal(main.head_node_id, 'node_main_1');
    assert.equal(main.node_count, 2);
    assert.equal(main.is_active, true);
    assert.deepEqual(stores.timeline_meta.get('root').value, {
      root_id: 'node_root', current_id: 'node_main_1', active_branch: 'branch_main', total_nodes: 2
    });
    assert.equal(stateManager.getSub('_meta').active_branch, 'branch_main');
    assertValidTimeline(stores);
  });
});

await test('promoting a non-active IF branch keeps the current node on the demoted branch consistently', async () => {
  const nodes = [
    node('node_root', null, 'branch_main', 0, ['node_main_1']),
    node('node_main_1', 'node_root', 'branch_main', 1, ['node_main_2', 'node_if_1']),
    node('node_main_2', 'node_main_1', 'branch_main', 2),
    node('node_if_1', 'node_main_1', 'branch_if', 2)
  ];
  const branches = [
    branch('branch_main', 'node_main_2', 3, { active: true, name: '主线' }),
    branch('branch_if', 'node_if_1', 1, { divergedFrom: 'node_main_1', name: '调查线' })
  ];
  await withTimelineDb({ nodes, branches, meta: meta('node_main_2', 'branch_main', 4) }, async stores => {
    await timelineSystem.promoteBranchToMain('branch_if');
    const current = stores.timeline_nodes.get('node_main_2');
    const activeBranchId = stores.timeline_meta.get('root').value.active_branch;
    assert.notEqual(activeBranchId, 'branch_main');
    assert.equal(current.branch_id, activeBranchId);
    assert.equal(stores.timeline_nodes.get('node_if_1').branch_id, 'branch_main');
    assert.equal(stores.timeline_meta.get('root').value.current_id, 'node_main_2');
    assert.equal(stateManager.getSub('_meta').active_branch, activeBranchId);
    assert.equal([...stores.timeline_branches.values()].filter(item => item.is_active).length, 1);
    assertValidTimeline(stores);
  });
});

await test('deleting a parent IF branch cascades through nested child branches', async () => {
  const nodes = [
    node('node_root', null, 'branch_main', 0, ['node_a_1']),
    node('node_a_1', 'node_root', 'branch_a', 1, ['node_a_2', 'node_b_1']),
    node('node_a_2', 'node_a_1', 'branch_a', 2),
    node('node_b_1', 'node_a_1', 'branch_b', 2, ['node_b_2']),
    node('node_b_2', 'node_b_1', 'branch_b', 3)
  ];
  const branches = [
    branch('branch_main', 'node_root', 1, { active: true, name: '主线' }),
    branch('branch_a', 'node_a_2', 2, { divergedFrom: 'node_root' }),
    branch('branch_b', 'node_b_2', 2, { divergedFrom: 'node_a_1' })
  ];
  await withTimelineDb({ nodes, branches, meta: meta('node_root', 'branch_main', 5) }, async stores => {
    const result = await timelineSystem.deleteBranch('branch_a');
    assert.equal(result.deletedNodes, 4);
    assert.deepEqual(result.deletedBranchIds.sort(), ['branch_a', 'branch_b']);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
    assert.deepEqual([...stores.timeline_branches.keys()], ['branch_main']);
    assert.deepEqual(stores.timeline_nodes.get('node_root').children_ids, []);
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 1);
    assertValidTimeline(stores);
  });
});

await test('active branch deletion preflights fallback restore and never expands into emergency reset', async () => {
  const root = node('node_root', null, 'branch_main', 0, ['node_if_1']);
  root.state_snapshot = null;
  const child = node('node_if_1', 'node_root', 'branch_if', 1);
  const seed = {
    nodes: [root, child],
    branches: [
      branch('branch_main', 'node_root', 1, { name: '主线' }),
      branch('branch_if', 'node_if_1', 1, { active: true, divergedFrom: 'node_root' })
    ],
    meta: meta('node_if_1', 'branch_if', 2)
  };
  await withTimelineDb(seed, async (stores, emergencyResetCalls) => {
    const before = timelineData(stores);
    await assert.rejects(() => timelineSystem.deleteBranch('branch_if'), /缺少完整状态快照/);
    assert.deepEqual(timelineData(stores), before);
    assert.equal(emergencyResetCalls(), 0);
  });
});

if (failures.length) {
  console.error(`\n${failures.length} Ling Xi timeline-action regression test(s) failed; ${passed} passed.`);
  process.exitCode = 1;
} else {
  console.log(`\nLing Xi timeline-action regression passed (${passed} tests).`);
}
