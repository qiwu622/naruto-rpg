import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { stateManager } from '../js/core/state-manager.js';
import { findForbiddenTimelineMedia, inspectTimelineSave } from '../js/core/timeline-save-schema.js';
import {
  compressTimelineNode,
  decompressTimelineNode,
  isCompressedTimelineNode
} from '../js/core/timeline-node-codec.js';
import { timelineSystem } from '../js/systems/timeline-system.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

const clone = value => structuredClone(value);
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(String(key)) ?? null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: key => storage.delete(String(key))
};

async function withTimelineDb(seed, fn, { failReplace = false, failCreate = false, archive = false } = {}) {
  const stores = {
    timeline_nodes: new Map((seed.nodes || []).map(item => [item.id, clone(item)])),
    timeline_branches: new Map((seed.branches || []).map(item => [item.id, clone(item)])),
    timeline_meta: new Map((seed.meta || []).map(item => [item.key, clone(item)]))
  };
  const stats = { mutationCount: 0 };
  const methods = [
    'initDB', 'dbGet', 'dbGetAll', 'dbPut', 'dbDelete', 'dbClear',
    'dbReplaceTimeline', 'dbCommitTimeline', 'dbMutateTimeline'
  ];
  const originals = Object.fromEntries(methods.map(name => [name, stateManager[name]]));
  let putCount = 0;
  stateManager.initDB = async () => ({});
  stateManager.dbGet = async (name, key) => clone(stores[name].get(key));
  stateManager.dbGetAll = async name => [...stores[name].values()].map(clone);
  stateManager.dbPut = async (name, value) => {
    putCount++;
    if (failCreate && putCount === 2) throw new Error('synthetic create transaction failure');
    stores[name].set(value.id ?? value.key, clone(value));
  };
  stateManager.dbDelete = async (name, key) => { stores[name].delete(key); };
  stateManager.dbClear = async name => { stores[name].clear(); };
  stateManager.dbReplaceTimeline = async ({ nodes, branches, meta }) => {
    if (failReplace) throw new Error('synthetic transaction failure');
    stores.timeline_nodes = new Map(nodes.map(item => [item.id, clone(item)]));
    stores.timeline_branches = new Map(branches.map(item => [item.id, clone(item)]));
    stores.timeline_meta = new Map([[meta.key, clone(meta)]]);
  };
  stateManager.dbCommitTimeline = async ({ nodes = [], branches = [], meta = null }) => {
    if (failCreate) throw new Error('synthetic create transaction failure');
    const next = Object.fromEntries(
      Object.entries(stores).map(([name, values]) => [name, new Map(values)])
    );
    for (const node of nodes) next.timeline_nodes.set(node.id, clone(node));
    for (const branch of branches) next.timeline_branches.set(branch.id, clone(branch));
    if (meta) next.timeline_meta.set(meta.key, clone(meta));
    Object.assign(stores, next);
  };
  let mutationQueue = Promise.resolve();
  stateManager.dbMutateTimeline = (mutator, { nodeKeys = null, branchKeys = null } = {}) => {
    const execute = async () => {
      stats.mutationCount += 1;
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
      if (failCreate) throw new Error('synthetic create transaction failure');
      if (mutation.replace === true) {
        next.timeline_nodes.clear();
        next.timeline_branches.clear();
        next.timeline_meta.clear();
      }
      for (const id of mutation.deleteNodeIds || []) next.timeline_nodes.delete(id);
      for (const id of mutation.deleteBranchIds || []) next.timeline_branches.delete(id);
      for (const key of mutation.deleteMetaKeys || []) next.timeline_meta.delete(key);
      for (const node of mutation.nodes || []) next.timeline_nodes.set(node.id, clone(node));
      for (const branch of mutation.branches || []) next.timeline_branches.set(branch.id, clone(branch));
      if (mutation.meta) next.timeline_meta.set(mutation.meta.key, clone(mutation.meta));
      Object.assign(stores, next);
      return mutation.result;
    };
    const operation = mutationQueue.then(execute, execute);
    mutationQueue = operation.catch(() => {});
    return operation;
  };
  timelineSystem._nodeCache.clear();
  timelineSystem._initialized = false;
  timelineSystem._pendingBranchFrom = null;
  timelineSystem._archiveRunning = false;
  timelineSystem._archiveQueue = Promise.resolve();
  const originalMaybeArchive = timelineSystem._maybeArchive;
  if (!archive) timelineSystem._maybeArchive = async () => 0;
  stateManager.reset();
  try {
    return await fn(stores, stats);
  } finally {
    for (const [name, method] of Object.entries(originals)) stateManager[name] = method;
    timelineSystem._maybeArchive = originalMaybeArchive;
    timelineSystem._nodeCache.clear();
    timelineSystem._initialized = false;
    timelineSystem._pendingBranchFrom = null;
    timelineSystem._archiveRunning = false;
    timelineSystem._archiveQueue = Promise.resolve();
  }
}

const snapshot = marker => ({ _version: '5.0', marker, _meta: {} });
const snapshotWithLegacyMedia = marker => ({
  ...snapshot(marker),
  _ui: {
    settings: {
      backgroundImage: 'data:image/png;base64,TEVHQUNZX0JBQ0tHUk9VTkQ='
    }
  },
  nested_media: {
    blob: new Blob(['legacy-image'], { type: 'image/png' }),
    array_buffer: new Uint8Array([1, 2, 3]).buffer,
    typed_array: new Uint16Array([4, 5, 6]),
    blob_url: 'blob:https://naruto.local/legacy-image',
    inline_image: 'before data:image/webp;base64,TEVHQUNZ after',
    list: [new Uint8Array([7, 8]), 'blob:https://naruto.local/list-image']
  }
});
const rootNode = {
  id: 'node_root', parent_id: null, children_ids: [], branch_id: 'branch_main',
  turn_number: 0, state_snapshot: snapshot('root'), archived: false
};
const mainBranch = {
  id: 'branch_main', name: '主线', head_node_id: 'node_root', diverged_from: null,
  node_count: 1, is_active: true
};
const rootMeta = {
  key: 'root', value: { root_id: 'node_root', current_id: 'node_root', active_branch: 'branch_main', total_nodes: 1 }
};

function legacyMaintenanceSave({ scalarTag = false, withLaterTurn = false } = {}) {
  const maintenanceId = 'node_legacy_maintenance';
  const laterId = 'node_after_maintenance';
  const maintenance = {
    ...rootNode,
    id: maintenanceId,
    parent_id: rootNode.id,
    children_ids: withLaterTurn ? [laterId] : [],
    turn_number: 0,
    depth: 1,
    state_snapshot: snapshot('legacy-approved'),
    summary: '灵希维护 · 属性·当前查克拉',
    tags: scalarTag ? '灵希维护' : ['灵希维护'],
    is_checkpoint: true,
    maintenance: {
      ...(scalarTag ? {} : { type: 'lingxi-variable-maintenance' }),
      label: '属性·当前查克拉',
      proposal_id: 'proposal_legacy_import',
      previous_node_id: rootNode.id,
      reason: '旧存档变量修复',
      created_at: 1700000000000
    }
  };
  const later = {
    ...rootNode,
    id: laterId,
    parent_id: maintenanceId,
    children_ids: [],
    turn_number: 1,
    depth: 2,
    state_snapshot: snapshot('later-turn'),
    summary: '维护后的正常剧情'
  };
  const nodes = [
    { ...rootNode, children_ids: [maintenanceId] },
    maintenance,
    ...(withLaterTurn ? [later] : [])
  ];
  const currentId = withLaterTurn ? laterId : maintenanceId;
  return {
    nodes,
    branches: [{
      ...mainBranch,
      head_node_id: currentId,
      node_count: nodes.length
    }],
    meta: {
      key: 'root',
      value: {
        ...rootMeta.value,
        current_id: currentId,
        total_nodes: nodes.length
      }
    }
  };
}

await test('overwrite import failure leaves the previous timeline untouched', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.restore(snapshot('runtime-before-db-failure'));
    const incoming = {
      nodes: [{ ...rootNode, id: 'node_new', state_snapshot: snapshot('new') }],
      branches: [{ ...mainBranch, head_node_id: 'node_new' }],
      meta: { key: 'root', value: { root_id: 'node_new', current_id: 'node_new', active_branch: 'branch_main' } }
    };
    await assert.rejects(() => timelineSystem.importTimeline(incoming), /synthetic transaction failure/);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
    assert.equal(stores.timeline_nodes.get('node_root').state_snapshot.marker, 'root');
    assert.deepEqual([...stores.timeline_branches.keys()], ['branch_main']);
    assert.equal(stateManager.snapshot().marker, 'runtime-before-db-failure');
  }, { failReplace: true });
});

await test('overwrite restore failure leaves both the previous timeline and runtime state untouched', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.restore(snapshot('runtime-before-import'));
    const incoming = {
      nodes: [{ ...rootNode, id: 'node_new_root', state_snapshot: snapshot('incoming-root') }],
      branches: [{ ...mainBranch, head_node_id: 'node_new_root' }],
      meta: {
        key: 'root',
        value: {
          root_id: 'node_new_root',
          current_id: 'node_new_root',
          active_branch: 'branch_main',
          total_nodes: 1
        }
      }
    };
    const originalMigrateEquipmentSlots = stateManager._migrateEquipmentSlots;
    let restoreAttempts = 0;
    stateManager._migrateEquipmentSlots = function (state) {
      restoreAttempts++;
      if (restoreAttempts === 1) throw new Error('synthetic restore failure');
      return originalMigrateEquipmentSlots.call(this, state);
    };
    try {
      await assert.rejects(() => timelineSystem.importTimeline(incoming), /synthetic restore failure/);
    } finally {
      stateManager._migrateEquipmentSlots = originalMigrateEquipmentSlots;
    }
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
    assert.equal(stores.timeline_nodes.get('node_root').state_snapshot.marker, 'root');
    assert.equal(stateManager.snapshot().marker, 'runtime-before-import');
  });
});

await test('overwrite rejects unsupported snapshot versions without changing database or runtime state', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.restore(snapshot('runtime-before-unknown-version'));
    const incoming = {
      nodes: [{
        ...rootNode,
        id: 'node_future',
        state_snapshot: { ...snapshot('future'), _version: '6.0', '玩家·姓名': 'FutureName' }
      }],
      branches: [{ ...mainBranch, head_node_id: 'node_future' }],
      meta: {
        key: 'root',
        value: {
          root_id: 'node_future',
          current_id: 'node_future',
          active_branch: 'branch_main',
          total_nodes: 1
        }
      }
    };
    await assert.rejects(() => timelineSystem.importTimeline(incoming), /版本不受支持/);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
    assert.equal(stateManager.snapshot().marker, 'runtime-before-unknown-version');
  });
});

await test('unsafe snapshot keys are rejected before overwrite or merge can mutate state', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.restore(snapshot('runtime-before-unsafe-snapshot'));
    const unsafeSnapshot = JSON.parse('{"_version":"5.0","nested":{"__proto__":{"polluted":"yes"}}}');
    const incoming = {
      nodes: [{ ...rootNode, id: 'node_unsafe', state_snapshot: unsafeSnapshot }],
      branches: [{ ...mainBranch, head_node_id: 'node_unsafe' }],
      meta: {
        key: 'root',
        value: {
          root_id: 'node_unsafe',
          current_id: 'node_unsafe',
          active_branch: 'branch_main',
          total_nodes: 1
        }
      }
    };
    assert.throws(() => stateManager.prepareRestore(unsafeSnapshot), /不安全键/);
    await assert.rejects(() => timelineSystem.importTimeline(incoming), /不安全键/);
    await assert.rejects(() => timelineSystem.importTimeline(incoming, { mode: 'merge' }), /不安全键/);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
    assert.equal(stateManager.snapshot().marker, 'runtime-before-unsafe-snapshot');
    assert.equal(stateManager.snapshot().polluted, undefined);
    assert.equal(({}).polluted, undefined);
  });
});

await test('overwrite import publishes prepared runtime state only after the database commit succeeds', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async () => {
    stateManager.restore(snapshot('runtime-before-commit'));
    const incoming = {
      nodes: [{ ...rootNode, id: 'node_new', state_snapshot: snapshot('runtime-after-commit') }],
      branches: [{ ...mainBranch, head_node_id: 'node_new' }],
      meta: {
        key: 'root',
        value: {
          root_id: 'node_new',
          current_id: 'node_new',
          active_branch: 'branch_main',
          total_nodes: 1
        }
      }
    };
    const commit = stateManager.dbReplaceTimeline;
    stateManager.dbReplaceTimeline = async payload => {
      assert.equal(stateManager.snapshot().marker, 'runtime-before-commit');
      const result = await commit(payload);
      assert.equal(stateManager.snapshot().marker, 'runtime-before-commit');
      return result;
    };
    await timelineSystem.importTimeline(incoming);
    assert.equal(stateManager.snapshot().marker, 'runtime-after-commit');
  });
});

await test('overwrite import rejects narrative-only replay instead of restoring an ancestor state', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    const incomingRoot = {
      ...rootNode,
      id: 'node_new_root',
      children_ids: ['node_new_current'],
      state_snapshot: snapshot('incoming-root')
    };
    const incomingCurrent = {
      ...rootNode,
      id: 'node_new_current',
      parent_id: 'node_new_root',
      turn_number: 1,
      state_snapshot: null,
      clean_response: '玩家离开木叶，任务与关系都发生了变化。'
    };
    const incoming = {
      nodes: [incomingRoot, incomingCurrent],
      branches: [{ ...mainBranch, head_node_id: 'node_new_current', node_count: 2 }],
      meta: {
        key: 'root',
        value: {
          root_id: 'node_new_root',
          current_id: 'node_new_current',
          active_branch: 'branch_main',
          total_nodes: 2
        }
      }
    };
    await assert.rejects(() => timelineSystem.importTimeline(incoming), /无法精确恢复/);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
  });
});

await test('snapshotless archived nodes reject jump, branch switch, and prune before persistence changes', async () => {
  const archived = {
    ...rootNode,
    id: 'node_archived',
    parent_id: 'node_root',
    children_ids: ['node_archived_head'],
    branch_id: 'branch_if',
    turn_number: 1,
    state_snapshot: null,
    clean_response: '普通叙事，没有可验证的状态增量。',
    archived: true
  };
  const archivedHead = {
    ...archived,
    id: 'node_archived_head',
    parent_id: 'node_archived',
    children_ids: [],
    turn_number: 2
  };
  const parent = { ...rootNode, children_ids: ['node_archived'] };
  const ifBranch = {
    ...mainBranch,
    id: 'branch_if',
    head_node_id: 'node_archived_head',
    diverged_from: 'node_root',
    node_count: 2,
    is_active: false
  };
  const meta = { ...rootMeta, value: { ...rootMeta.value, total_nodes: 3 } };
  await withTimelineDb({ nodes: [parent, archived, archivedHead], branches: [mainBranch, ifBranch], meta: [meta] }, async stores => {
    stateManager.restore(snapshot('runtime-before-archive-actions'));
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    await assert.rejects(() => timelineSystem._replayStateFromAncestor(archived), /缺少完整状态快照/);
    await assert.rejects(() => timelineSystem.jumpToNode('node_archived'), /缺少完整状态快照/);
    await assert.rejects(() => timelineSystem.switchBranch('branch_if'), /缺少完整状态快照/);
    await assert.rejects(() => timelineSystem.pruneForward('node_archived'), /缺少完整状态快照/);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root', 'node_archived', 'node_archived_head']);
    assert.equal(stores.timeline_meta.get('root').value.current_id, 'node_root');
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 3);
    assert.equal(stores.timeline_branches.get('branch_main').is_active, true);
    assert.equal(stores.timeline_branches.get('branch_if').is_active, false);
    assert.equal(stateManager.snapshot().marker, 'runtime-before-archive-actions');
  });
});

await test('timeline replacement uses one IndexedDB transaction for all three stores', async () => {
  const previousDb = stateManager._db;
  const operations = [];
  let transactionStores = null;
  stateManager._db = {
    transaction(names, mode) {
      transactionStores = [...names];
      const tx = {
        error: null,
        objectStore(name) {
          return {
            clear() { operations.push(`${name}:clear`); },
            put(value) { operations.push(`${name}:put:${value.id ?? value.key}`); }
          };
        },
        abort() { tx.onabort?.(); }
      };
      assert.equal(mode, 'readwrite');
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    }
  };
  try {
    await stateManager.dbReplaceTimeline({ nodes: [rootNode], branches: [mainBranch], meta: rootMeta });
    assert.deepEqual(transactionStores, ['timeline_nodes', 'timeline_branches', 'timeline_meta']);
    assert.deepEqual(operations, [
      'timeline_nodes:clear', 'timeline_branches:clear', 'timeline_meta:clear',
      'timeline_nodes:put:node_root', 'timeline_branches:put:branch_main', 'timeline_meta:put:root'
    ]);
  } finally {
    stateManager._db = previousDb;
  }
});

await test('createNode failure leaves no partially written timeline data', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    await assert.rejects(() => timelineSystem.createNode({
      turnNumber: 1,
      playerInput: '前进',
      aiResponse: '你向前走了一步。',
      stateSnapshot: snapshot('next'),
      chatHistory: []
    }), /synthetic create transaction failure/);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
    assert.deepEqual(stores.timeline_nodes.get('node_root').children_ids, []);
    assert.equal(stores.timeline_branches.get('branch_main').head_node_id, 'node_root');
    assert.equal(stores.timeline_meta.get('root').value.current_id, 'node_root');
  }, { failCreate: true });
});

await test('createNode rejects legacy maintenance metadata without creating a turn', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    timelineSystem._pendingBranchFrom = 'node_root';
    await assert.rejects(() => timelineSystem.createNode({
      turnNumber: 1,
      playerInput: '',
      aiResponse: '',
      stateSnapshot: snapshot('legacy-maintenance'),
      chatHistory: [],
      maintenance: {
        type: 'lingxi-variable-maintenance',
        label: '属性·当前查克拉',
        previous_node_id: 'node_root'
      },
      expectedMaintenanceImpact: {
        schema: 'naruto.lingxi-timeline-impact/v1',
        operation: 'create-maintenance-checkpoint',
        parentNodeId: 'node_root',
        activeBranchId: 'branch_main',
        createsIfBranch: false,
        createsTurn: false,
        updatesNode: true,
        branchName: null
      }
    }), /createMaintenanceCheckpoint/);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
    assert.equal(stores.timeline_meta.get('root').value.current_id, 'node_root');
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 1);
    assert.equal(timelineSystem._pendingBranchFrom, 'node_root');
  });
});

await test('Ling Xi maintenance attaches its snapshot and metadata to the current turn without creating a node', async () => {
  await withTimelineDb(
    { nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] },
    async (stores, stats) => {
      stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
      const approvedSnapshot = snapshot('lingxi-approved');
      const expectedImpact = await timelineSystem.previewMaintenanceCheckpoint();
      assert.deepEqual(expectedImpact, {
        schema: 'naruto.lingxi-timeline-impact/v1',
        operation: 'create-maintenance-checkpoint',
        parentNodeId: 'node_root',
        activeBranchId: 'branch_main',
        createsIfBranch: false,
        createsTurn: false,
        updatesNode: true,
        branchName: null
      });
      const updatedNode = await timelineSystem.createMaintenanceCheckpoint({
        label: '属性·当前查克拉',
        reason: '修复当前查克拉',
        proposalId: 'proposal_atomic',
        stateSnapshot: approvedSnapshot,
        expectedImpact
      });

      assert.equal(stats.mutationCount, 1);
      assert.equal(updatedNode.id, 'node_root');
      assert.equal(stores.timeline_nodes.size, 1);
      assert.equal(stores.timeline_meta.get('root').value.current_id, 'node_root');
      assert.equal(stores.timeline_branches.get('branch_main').head_node_id, 'node_root');
      assert.equal(stores.timeline_branches.get('branch_main').node_count, 1);
      assert.deepEqual(stores.timeline_nodes.get('node_root').children_ids, []);
      const persisted = stores.timeline_nodes.get('node_root');
      assert.equal(persisted.state_snapshot.marker, 'lingxi-approved');
      assert.notEqual(persisted.is_checkpoint, true);
      assert.equal(Array.isArray(persisted.tags) && persisted.tags.includes('灵希维护'), false);
      assert.equal(persisted.maintenance_history.length, 1);
      assert.equal(persisted.maintenance.type, 'lingxi-variable-maintenance');
      assert.equal(persisted.maintenance.label, '属性·当前查克拉');
      assert.equal(persisted.maintenance.proposal_id, 'proposal_atomic');
      assert.equal(persisted.maintenance.previous_node_id, 'node_root');
      assert.equal(persisted.maintenance.reason, '修复当前查克拉');
      assert.equal(persisted.maintenance.before_state_snapshot.marker, 'root');
      assert.equal(persisted.maintenance_history[0].created_at, persisted.maintenance.created_at);
    }
  );
});

await test('Ling Xi maintenance never creates an IF branch, even when a pending branch is armed', async () => {
  const parent = { ...rootNode, children_ids: ['node_existing'], summary: '已经发生的未来' };
  const existing = {
    ...rootNode,
    id: 'node_existing',
    parent_id: 'node_root',
    children_ids: [],
    depth: 1,
    turn_number: 2,
    summary: '原有后续'
  };
  const branch = { ...mainBranch, head_node_id: 'node_existing', node_count: 2 };
  const meta = {
    key: 'root',
    value: { ...rootMeta.value, current_id: 'node_root', active_branch: 'branch_main', total_nodes: 2 }
  };
  await withTimelineDb({ nodes: [parent, existing], branches: [branch], meta: [meta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    timelineSystem._pendingBranchFrom = 'node_root';
    const expectedImpact = await timelineSystem.previewMaintenanceCheckpoint();
    assert.equal(expectedImpact.createsIfBranch, false);
    assert.equal(expectedImpact.createsTurn, false);
    assert.equal(expectedImpact.updatesNode, true);
    assert.equal(expectedImpact.branchName, null);

    await assert.rejects(
      () => timelineSystem.createMaintenanceCheckpoint({
        proposalId: 'proposal_stale_impact',
        stateSnapshot: snapshot('stale-impact'),
        expectedImpact: { ...expectedImpact, createsIfBranch: true, createsTurn: true, updatesNode: false, branchName: 'IF线·错误影响' }
      }),
      error => error?.code === 'LINGXI_PROPOSAL_STALE'
    );
    assert.equal(stores.timeline_nodes.size, 2);
    assert.equal(stores.timeline_branches.size, 1);
    assert.equal(stores.timeline_meta.get('root').value.current_id, 'node_root');

    const updatedNode = await timelineSystem.createMaintenanceCheckpoint({
      proposalId: 'proposal_exact_impact',
      stateSnapshot: snapshot('exact-impact'),
      expectedImpact
    });
    assert.equal(updatedNode.id, 'node_root');
    assert.equal(stores.timeline_nodes.size, 2);
    assert.equal(stores.timeline_branches.size, 1);
    assert.equal(stores.timeline_branches.get('branch_main').head_node_id, 'node_existing');
    assert.equal(stores.timeline_branches.get('branch_main').node_count, 2);
    assert.equal(stores.timeline_meta.get('root').value.current_id, 'node_root');
    assert.equal(stores.timeline_meta.get('root').value.active_branch, 'branch_main');
    assert.equal(stores.timeline_nodes.get('node_root').state_snapshot.marker, 'exact-impact');
    // A pending branch represents a user's later narrative choice. Maintenance
    // must leave it armed so the next real turn can still create that branch.
    assert.equal(timelineSystem._pendingBranchFrom, 'node_root');
  });
});

await test('init folds legacy Ling Xi maintenance nodes into their modified turn', async () => {
  const legacyMaintenance = {
    ...rootNode,
    id: 'node_legacy_maintenance',
    parent_id: 'node_root',
    children_ids: ['node_after_maintenance'],
    turn_number: 0,
    state_snapshot: snapshot('legacy-approved'),
    summary: '灵希维护 · 属性·当前查克拉',
    tags: ['灵希维护'],
    is_checkpoint: true,
    maintenance: {
      type: 'lingxi-variable-maintenance',
      label: '属性·当前查克拉',
      proposal_id: 'proposal_legacy',
      previous_node_id: 'node_root',
      reason: '旧存档变量修复',
      created_at: 1700000000000
    }
  };
  const laterTurn = {
    ...rootNode,
    id: 'node_after_maintenance',
    parent_id: legacyMaintenance.id,
    children_ids: [],
    depth: 2,
    turn_number: 1,
    state_snapshot: snapshot('later-turn'),
    summary: '维护后的正常剧情'
  };
  const parent = { ...rootNode, children_ids: [legacyMaintenance.id] };
  const branch = {
    ...mainBranch,
    head_node_id: laterTurn.id,
    node_count: 3
  };
  const meta = {
    ...rootMeta,
    value: {
      ...rootMeta.value,
      current_id: legacyMaintenance.id,
      total_nodes: 3
    }
  };

  await withTimelineDb(
    { nodes: [parent, legacyMaintenance, laterTurn], branches: [branch], meta: [meta] },
    async stores => {
      await timelineSystem.init();

      assert.deepEqual([...stores.timeline_nodes.keys()].sort(), ['node_after_maintenance', 'node_root']);
      const migratedRoot = stores.timeline_nodes.get('node_root');
      const migratedLater = stores.timeline_nodes.get('node_after_maintenance');
      assert.deepEqual(migratedRoot.children_ids, ['node_after_maintenance']);
      assert.equal(migratedLater.parent_id, 'node_root');
      assert.equal(migratedLater.depth, 1);
      assert.equal(migratedRoot.state_snapshot.marker, 'legacy-approved');
      assert.equal(migratedRoot.maintenance_history.length, 1);
      assert.equal(migratedRoot.maintenance_history[0].migrated_from_node_id, legacyMaintenance.id);
      assert.equal(migratedRoot.maintenance_history[0].previous_node_id, 'node_root');
      assert.equal(migratedRoot.maintenance_history[0].before_state_snapshot.marker, 'root');
      assert.equal(migratedRoot.maintenance.proposal_id, 'proposal_legacy');
      assert.equal(Boolean(migratedRoot.tags?.includes('灵希维护')), false);

      assert.equal(stores.timeline_branches.get('branch_main').head_node_id, laterTurn.id);
      assert.equal(stores.timeline_branches.get('branch_main').node_count, 2);
      assert.equal(stores.timeline_meta.get('root').value.current_id, 'node_root');
      assert.equal(stores.timeline_meta.get('root').value.total_nodes, 2);
      assert.equal(stateManager.getSub('_meta').current_node_id, 'node_root');
      assert.equal(stateManager.getSub('_meta').active_branch, 'branch_main');
    }
  );
});

await test('overwrite import folds scalar-tagged legacy maintenance before restoring runtime state', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    timelineSystem._initialized = true;
    stateManager.restore(snapshot('runtime-before-legacy-import'));

    const importedCurrent = await timelineSystem.importTimeline(
      legacyMaintenanceSave({ scalarTag: true })
    );

    assert.equal(importedCurrent.id, rootNode.id);
    assert.deepEqual([...stores.timeline_nodes.keys()], [rootNode.id]);
    const migratedRoot = stores.timeline_nodes.get(rootNode.id);
    assert.equal(migratedRoot.state_snapshot.marker, 'legacy-approved');
    assert.equal(migratedRoot.maintenance_history.length, 1);
    assert.equal(migratedRoot.maintenance_history[0].label, '属性·当前查克拉');
    assert.equal(stores.timeline_branches.get('branch_main').head_node_id, rootNode.id);
    assert.equal(stores.timeline_branches.get('branch_main').node_count, 1);
    assert.equal(stores.timeline_meta.get('root').value.current_id, rootNode.id);
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 1);
    assert.equal(stateManager.snapshot().marker, 'legacy-approved');
    assert.equal(stateManager.getSub('_meta').current_node_id, rootNode.id);
  });
});

await test('merge import folds legacy maintenance before exposing the imported branch', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    timelineSystem._initialized = true;
    stateManager.setSub('_meta', { current_node_id: rootNode.id, active_branch: 'branch_main' });

    const importedRoot = await timelineSystem.importTimeline(
      legacyMaintenanceSave({ withLaterTurn: true }),
      { mode: 'merge' }
    );

    assert.ok(importedRoot);
    assert.notEqual(importedRoot.id, rootNode.id);
    assert.equal(stores.timeline_nodes.size, 3);
    const attachedRoot = stores.timeline_nodes.get(importedRoot.id);
    assert.equal(attachedRoot.parent_id, rootNode.id);
    assert.equal(attachedRoot.state_snapshot.marker, 'legacy-approved');
    assert.equal(attachedRoot.maintenance_history.length, 1);
    const importedLater = [...stores.timeline_nodes.values()]
      .find(node => node.summary === '维护后的正常剧情');
    assert.equal(importedLater.parent_id, attachedRoot.id);
    assert.equal(importedLater.depth, attachedRoot.depth + 1);
    assert.equal([...stores.timeline_nodes.values()].some(node => (
      (Array.isArray(node.tags) && node.tags.includes('灵希维护'))
      || node.tags === '灵希维护'
    )), false);
    const importedBranch = [...stores.timeline_branches.values()]
      .find(branch => branch.id !== 'branch_main');
    assert.equal(importedBranch.node_count, 2);
    assert.equal(stores.timeline_meta.get('root').value.current_id, rootNode.id);
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 3);
  });
});

await test('Ling Xi maintenance transaction failure leaves graph and live node unchanged', async () => {
  await withTimelineDb(
    { nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] },
    async stores => {
      stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
      await assert.rejects(
        () => timelineSystem.createMaintenanceCheckpoint({
          label: '属性·当前查克拉',
          reason: '故障注入',
          proposalId: 'proposal_failed',
          stateSnapshot: snapshot('must-not-persist')
        }),
        /synthetic create transaction failure/
      );
      assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
      assert.deepEqual(stores.timeline_nodes.get('node_root').children_ids, []);
      assert.equal(stores.timeline_branches.get('branch_main').head_node_id, 'node_root');
      assert.equal(stores.timeline_branches.get('branch_main').node_count, 1);
      assert.equal(stores.timeline_meta.get('root').value.current_id, 'node_root');
      assert.equal(stores.timeline_meta.get('root').value.total_nodes, 1);
      assert.equal(stateManager.getSub('_meta').current_node_id, 'node_root');
    },
    { failCreate: true }
  );
});

await test('concurrent appends use compare-and-swap and preserve timeline counters', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    const results = await Promise.allSettled([
      timelineSystem.createNode({
        turnNumber: 1,
        playerInput: '向左',
        aiResponse: '你向左走。',
        stateSnapshot: snapshot('left'),
        chatHistory: []
      }),
      timelineSystem.createNode({
        turnNumber: 1,
        playerInput: '向右',
        aiResponse: '你向右走。',
        stateSnapshot: snapshot('right'),
        chatHistory: []
      })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /已变化|过期|stale/i);

    const parent = stores.timeline_nodes.get('node_root');
    assert.equal(parent.children_ids.length, 1);
    assert.equal(stores.timeline_nodes.size, 2);
    assert.equal(stores.timeline_branches.get('branch_main').node_count, 2);
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 2);
    assert.equal(stores.timeline_meta.get('root').value.current_id, parent.children_ids[0]);
  });
});

await test('concurrent first-node creation permits exactly one graph root', async () => {
  await withTimelineDb({ nodes: [], branches: [], meta: [] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: null, active_branch: 'branch_main' });
    const results = await Promise.allSettled([
      timelineSystem.createNode({
        turnNumber: 1,
        playerInput: '开始 A',
        aiResponse: '冒险 A。',
        stateSnapshot: snapshot('root-a'),
        chatHistory: []
      }),
      timelineSystem.createNode({
        turnNumber: 1,
        playerInput: '开始 B',
        aiResponse: '冒险 B。',
        stateSnapshot: snapshot('root-b'),
        chatHistory: []
      })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /已经初始化|过期/);
    assert.equal(stores.timeline_nodes.size, 1);
    assert.equal(stores.timeline_branches.size, 1);
    assert.equal([...stores.timeline_nodes.values()].filter(node => node.parent_id == null).length, 1);
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 1);
  });
});

await test('createNode throws when its current parent is missing', async () => {
  await withTimelineDb({ nodes: [], branches: [mainBranch], meta: [rootMeta] }, async () => {
    stateManager.setSub('_meta', { current_node_id: 'node_missing', active_branch: 'branch_main' });
    await assert.rejects(() => timelineSystem.createNode({
      turnNumber: 1,
      playerInput: '继续',
      aiResponse: '继续。',
      stateSnapshot: snapshot('missing-parent'),
      chatHistory: []
    }), /父节点.*不存在|current.*missing/i);
  });
});

await test('fork creation deactivates every stale active branch in the same transaction', async () => {
  const mainChild = {
    ...rootNode,
    id: 'node_main_child',
    parent_id: 'node_root',
    turn_number: 1,
    state_snapshot: snapshot('main-child')
  };
  const staleNode = {
    ...rootNode,
    id: 'node_stale',
    parent_id: 'node_root',
    branch_id: 'branch_stale',
    turn_number: 1,
    state_snapshot: snapshot('stale')
  };
  const parent = { ...rootNode, children_ids: ['node_main_child', 'node_stale'] };
  const activeMain = { ...mainBranch, head_node_id: 'node_main_child', node_count: 2, is_active: true };
  const staleBranch = {
    ...mainBranch,
    id: 'branch_stale',
    head_node_id: 'node_stale',
    node_count: 1,
    is_active: true
  };
  const meta = { ...rootMeta, value: { ...rootMeta.value, total_nodes: 3 } };
  await withTimelineDb({ nodes: [parent, mainChild, staleNode], branches: [activeMain, staleBranch], meta: [meta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    timelineSystem._pendingBranchFrom = 'node_root';
    await timelineSystem.createNode({
      turnNumber: 2,
      playerInput: '选择另一条路',
      aiResponse: '新的可能性展开。',
      stateSnapshot: snapshot('fork'),
      chatHistory: []
    });
    const branches = [...stores.timeline_branches.values()];
    assert.equal(branches.filter(branch => branch.is_active).length, 1);
    assert.equal(branches.find(branch => branch.id === 'branch_stale').is_active, false);
  });
});

await test('merge import attaches the incoming root and keeps one valid graph root', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    const incoming = {
      nodes: [{ ...rootNode, state_snapshot: snapshot('imported') }],
      branches: [{ ...mainBranch }],
      meta: clone(rootMeta)
    };
    await timelineSystem.importTimeline(incoming, { mode: 'merge' });

    const merged = {
      nodes: [...stores.timeline_nodes.values()],
      branches: [...stores.timeline_branches.values()],
      meta: stores.timeline_meta.get('root')
    };
    const inspection = inspectTimelineSave(merged);
    assert.equal(inspection.valid, true, inspection.errors.join('\n'));
    assert.equal(merged.nodes.filter(node => node.parent_id == null).length, 1);
    const importedRoot = merged.nodes.find(node => node.id !== 'node_root');
    assert.equal(importedRoot.parent_id, 'node_root');
    assert.ok(merged.nodes.find(node => node.id === 'node_root').children_ids.includes(importedRoot.id));
    assert.equal(merged.meta.value.current_id, 'node_root');
    assert.equal(merged.meta.value.active_branch, 'branch_main');
  });
});

await test('merge import rebases turn numbers after the attachment node', async () => {
  const attachment = { ...rootNode, turn_number: 100 };
  await withTimelineDb({ nodes: [attachment], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    const importedRoot = {
      ...rootNode,
      children_ids: ['node_import_child'],
      turn_number: 0,
      state_snapshot: { ...snapshot('imported-root'), '系统·回合数': 1 }
    };
    const importedChild = {
      ...rootNode,
      id: 'node_import_child',
      parent_id: 'node_root',
      turn_number: 2,
      state_snapshot: { ...snapshot('imported-child'), '系统·回合数': 3 }
    };
    const incoming = {
      nodes: [importedRoot, importedChild],
      branches: [{ ...mainBranch, head_node_id: 'node_import_child', node_count: 2 }],
      meta: {
        key: 'root',
        value: { ...rootMeta.value, current_id: 'node_import_child', total_nodes: 2 }
      }
    };
    const mergedRoot = await timelineSystem.importTimeline(incoming, { mode: 'merge' });
    const mergedChild = [...stores.timeline_nodes.values()].find(node => node.parent_id === mergedRoot.id);
    const mergedBranch = [...stores.timeline_branches.values()].find(branch => branch.id === mergedRoot.branch_id);
    assert.equal(mergedRoot.turn_number, 101);
    assert.equal(mergedChild.turn_number, 103);
    assert.equal(mergedRoot.state_snapshot['系统·回合数'], 101);
    assert.equal(mergedChild.state_snapshot['系统·回合数'], 103);
    assert.equal(mergedBranch.diverged_at_turn, 100);
    assert.ok(mergedRoot.turn_number > attachment.turn_number);
  });
});

await test('merge import failure rolls every node, branch, and parent update back', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    const incoming = {
      nodes: [{ ...rootNode, state_snapshot: snapshot('imported') }],
      branches: [{ ...mainBranch }],
      meta: clone(rootMeta)
    };
    await assert.rejects(
      () => timelineSystem.importTimeline(incoming, { mode: 'merge' }),
      /synthetic create transaction failure/
    );
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
    assert.deepEqual(stores.timeline_nodes.get('node_root').children_ids, []);
    assert.deepEqual([...stores.timeline_branches.keys()], ['branch_main']);
    assert.deepEqual(stores.timeline_meta.get('root'), rootMeta);
  }, { failCreate: true });
});

await test('overwrite import rejects a current node that cannot be restored exactly', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    const child = {
      ...rootNode,
      id: 'node_child',
      parent_id: 'node_root',
      branch_id: 'branch_main',
      turn_number: 1,
      state_snapshot: null,
      clean_response: '',
      children_ids: []
    };
    const incomingRoot = { ...rootNode, children_ids: ['node_child'] };
    const incoming = {
      nodes: [incomingRoot, child],
      branches: [{ ...mainBranch, head_node_id: 'node_child', node_count: 2 }],
      meta: {
        key: 'root',
        value: { ...rootMeta.value, current_id: 'node_child', total_nodes: 2 }
      }
    };
    await assert.rejects(() => timelineSystem.importTimeline(incoming), /无法精确恢复|缺少.*快照/);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['node_root']);
    assert.equal(stores.timeline_nodes.get('node_root').state_snapshot.marker, 'root');
  });
});

await test('legacy overwrite import derives missing timeline metadata before strict validation', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    const incoming = {
      export_version: '1.0',
      nodes: [{
        id: 'legacy_root',
        parent_id: null,
        branch_id: 'branch_main',
        turn_number: 3,
        state_snapshot: snapshot('legacy-root')
      }, {
        id: 'legacy_current',
        parent_id: 'legacy_root',
        children_ids: [],
        branch_id: 'branch_main',
        turn_number: 4,
        state_snapshot: snapshot('legacy-current')
      }],
      branches: [{
        id: 'branch_main',
        name: '主线',
        diverged_from: null
      }]
    };
    await timelineSystem.importTimeline(incoming);
    assert.deepEqual([...stores.timeline_nodes.keys()], ['legacy_root', 'legacy_current']);
    assert.deepEqual(stores.timeline_nodes.get('legacy_root').children_ids, ['legacy_current']);
    assert.equal(stores.timeline_nodes.get('legacy_root').depth, 0);
    assert.equal(stores.timeline_nodes.get('legacy_current').depth, 1);
    assert.deepEqual(stores.timeline_meta.get('root').value, {
      root_id: 'legacy_root',
      current_id: 'legacy_current',
      active_branch: 'branch_main',
      total_nodes: 2
    });
    assert.equal(stores.timeline_branches.get('branch_main').is_active, true);
    assert.equal(stores.timeline_branches.get('branch_main').head_node_id, 'legacy_current');
  });
});

await test('legacy import derives a missing current node from the explicit active branch', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    const incoming = {
      export_version: '1.0',
      nodes: [{
        ...rootNode,
        id: 'legacy_root',
        children_ids: ['legacy_main', 'legacy_if'],
        state_snapshot: snapshot('legacy-root')
      }, {
        ...rootNode,
        id: 'legacy_main',
        parent_id: 'legacy_root',
        turn_number: 1,
        state_snapshot: snapshot('legacy-main')
      }, {
        ...rootNode,
        id: 'legacy_if',
        parent_id: 'legacy_root',
        branch_id: 'branch_if',
        turn_number: 2,
        state_snapshot: snapshot('legacy-if')
      }],
      branches: [{
        id: 'branch_main',
        name: '主线',
        head_node_id: 'legacy_main',
        diverged_from: null
      }, {
        id: 'branch_if',
        name: 'IF线',
        head_node_id: 'legacy_if',
        diverged_from: 'legacy_root'
      }],
      meta: { root_id: 'legacy_root', active_branch: 'branch_main' }
    };
    await timelineSystem.importTimeline(incoming);
    assert.equal(stores.timeline_meta.get('root').value.current_id, 'legacy_main');
    assert.equal(stores.timeline_meta.get('root').value.active_branch, 'branch_main');
    assert.equal(stores.timeline_branches.get('branch_main').is_active, true);
    assert.equal(stores.timeline_branches.get('branch_if').is_active, false);
  });
});

await test('deleting an IF branch removes stale child links and updates total_nodes', async () => {
  const parent = { ...rootNode, children_ids: ['node_if'] };
  const child = {
    id: 'node_if', parent_id: 'node_root', children_ids: [], branch_id: 'branch_if',
    turn_number: 1, state_snapshot: snapshot('if'), archived: false
  };
  const branch = {
    id: 'branch_if', name: 'IF线', head_node_id: 'node_if', diverged_from: 'node_root',
    node_count: 1, is_active: false
  };
  const meta = { ...rootMeta, value: { ...rootMeta.value, total_nodes: 2 } };
  await withTimelineDb({ nodes: [parent, child], branches: [mainBranch, branch], meta: [meta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    await timelineSystem.deleteBranch('branch_if');
    assert.deepEqual(stores.timeline_nodes.get('node_root').children_ids, []);
    assert.equal(stores.timeline_nodes.has('node_if'), false);
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 1);
  });
});

await test('promoting the active IF branch leaves exactly the main branch active', async () => {
  const mainFuture = {
    id: 'node_main_2', parent_id: 'node_root', children_ids: [], branch_id: 'branch_main',
    turn_number: 2, state_snapshot: snapshot('old-main'), archived: false
  };
  const ifNode = {
    id: 'node_if', parent_id: 'node_root', children_ids: [], branch_id: 'branch_if',
    turn_number: 1, state_snapshot: snapshot('if'), archived: false
  };
  const targetBranch = {
    id: 'branch_if', name: 'IF线', head_node_id: 'node_if', diverged_from: 'node_root',
    node_count: 1, is_active: true
  };
  const inactiveMain = { ...mainBranch, head_node_id: 'node_main_2', node_count: 2, is_active: false };
  const meta = {
    ...rootMeta,
    value: { ...rootMeta.value, current_id: 'node_if', active_branch: 'branch_if', total_nodes: 3 }
  };
  await withTimelineDb({ nodes: [rootNode, mainFuture, ifNode], branches: [inactiveMain, targetBranch], meta: [meta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_if', active_branch: 'branch_if' });
    await timelineSystem.promoteBranchToMain('branch_if');
    const branches = [...stores.timeline_branches.values()];
    assert.equal(branches.find(item => item.id === 'branch_main').is_active, true);
    assert.equal(branches.filter(item => item.is_active).length, 1);
    assert.equal(stores.timeline_meta.get('root').value.active_branch, 'branch_main');
  });
});

await test('default export keeps archived state snapshots', async () => {
  const archived = { ...rootNode, archived: true, archived_at: Date.now() };
  await withTimelineDb({ nodes: [archived], branches: [mainBranch], meta: [rootMeta] }, async () => {
    const data = await timelineSystem.getExportData();
    assert.equal(data.include_archive, false);
    assert.equal(data.nodes[0].archived, true);
    assert.equal(data.nodes[0].state_snapshot.marker, 'root');
    assert.equal(data.nodes[0].chat_history, undefined);
  });
});

await test('default export keeps chat deltas needed to rebuild AI context', async () => {
  const chatDelta = [
    { role: 'user', content: '[玩家操作]\n侦察前方' },
    { role: 'assistant', content: '你发现林间有埋伏。' }
  ];
  const node = { ...rootNode, chat_history_delta: chatDelta, chat_history: null };
  await withTimelineDb({ nodes: [node], branches: [mainBranch], meta: [rootMeta] }, async () => {
    const data = await timelineSystem.getExportData();
    assert.deepEqual(data.nodes[0].chat_history_delta, chatDelta);
    assert.equal(data.nodes[0].chat_history, null);
  });
});

await test('timeline save validation rejects cyclic parent graphs', async () => {
  const loop = { ...rootNode, id: 'node_loop', parent_id: 'node_loop', children_ids: ['node_loop'] };
  const data = {
    nodes: [loop],
    branches: [{ ...mainBranch, head_node_id: 'node_loop' }],
    meta: { key: 'root', value: { ...rootMeta.value, root_id: 'node_loop', current_id: 'node_loop' } }
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /环/);
});

await test('timeline save validation requires reciprocal parent and child links', async () => {
  const child = {
    ...rootNode,
    id: 'node_child',
    parent_id: 'node_root',
    turn_number: 1,
    state_snapshot: snapshot('child')
  };
  const data = {
    nodes: [rootNode, child],
    branches: [{ ...mainBranch, head_node_id: 'node_child', node_count: 2 }],
    meta: { key: 'root', value: { ...rootMeta.value, current_id: 'node_child', total_nodes: 2 } }
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /父子关系不一致/);
});

await test('timeline save validation rejects a child turn earlier than its parent', async () => {
  const parent = { ...rootNode, turn_number: 2, children_ids: ['node_child'] };
  const child = {
    ...rootNode,
    id: 'node_child',
    parent_id: 'node_root',
    turn_number: 1,
    state_snapshot: snapshot('child')
  };
  const data = {
    nodes: [parent, child],
    branches: [{ ...mainBranch, head_node_id: 'node_child', node_count: 2 }],
    meta: { key: 'root', value: { ...rootMeta.value, current_id: 'node_child', total_nodes: 2 } }
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /turn_number.*父节点/);
});

await test('timeline save validation requires exactly one graph root', async () => {
  const secondRoot = {
    ...rootNode,
    id: 'node_second_root',
    branch_id: 'branch_if',
    state_snapshot: snapshot('second-root')
  };
  const data = {
    nodes: [rootNode, secondRoot],
    branches: [
      mainBranch,
      { ...mainBranch, id: 'branch_if', name: 'IF线', head_node_id: 'node_second_root', is_active: false }
    ],
    meta: rootMeta
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /恰好一个根节点/);
});

await test('timeline save validation rejects unsafe branch colors', async () => {
  const data = {
    nodes: [rootNode],
    branches: [{ ...mainBranch, color: '#fff" onmouseover="alert(1)' }],
    meta: rootMeta
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /颜色/);
});

await test('timeline save validation and state restore reject non-object snapshots', async () => {
  const data = {
    nodes: [{ ...rootNode, state_snapshot: 'not-a-state-object' }],
    branches: [mainBranch],
    meta: rootMeta
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /state_snapshot|状态快照/);
  assert.throws(() => stateManager.restore('not-a-state-object'), /快照非法/);

  const versionless = inspectTimelineSave({
    nodes: [{ ...rootNode, state_snapshot: {} }],
    branches: [mainBranch],
    meta: rootMeta
  });
  assert.equal(versionless.valid, false);
  assert.match(versionless.errors.join('\n'), /版本不受支持/);
  assert.throws(() => stateManager.restore({}), /版本不受支持/);
});

await test('versioned v3 state snapshots remain migratable', async () => {
  const prepared = stateManager.prepareRestore({
    _version: '3.0',
    player: { name: '旧版忍者', age: 13 },
    attributes: { chakra: 24, chakra_current: 17 }
  });
  assert.equal(prepared.state._version, '5.0');
  assert.equal(prepared.state['玩家·姓名'], '旧版忍者');
  assert.equal(prepared.state['属性·查克拉'], 24);
  assert.equal(prepared.state['属性·当前查克拉'], 17);
});

await test('timeline save validation binds meta.root_id to the unique graph root', async () => {
  const child = {
    ...rootNode,
    id: 'node_child',
    parent_id: 'node_root',
    children_ids: [],
    turn_number: 1,
    state_snapshot: snapshot('child')
  };
  const data = {
    nodes: [{ ...rootNode, children_ids: ['node_child'] }, child],
    branches: [{ ...mainBranch, head_node_id: 'node_child', node_count: 2 }],
    meta: { key: 'root', value: { ...rootMeta.value, root_id: 'node_child', current_id: 'node_child', total_nodes: 2 } }
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /root_id|根节点.*一致/);
});

await test('timeline save validation requires branch heads to belong to their branch', async () => {
  const child = {
    ...rootNode,
    id: 'node_if',
    parent_id: 'node_root',
    children_ids: [],
    branch_id: 'branch_if',
    turn_number: 1,
    state_snapshot: snapshot('if')
  };
  const data = {
    nodes: [{ ...rootNode, children_ids: ['node_if'] }, child],
    branches: [
      { ...mainBranch, head_node_id: 'node_if', node_count: 1, is_active: true },
      { ...mainBranch, id: 'branch_if', head_node_id: 'node_if', node_count: 1, is_active: false }
    ],
    meta: { key: 'root', value: { ...rootMeta.value, total_nodes: 2 } }
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /头节点.*分支|不属于/);
});

await test('timeline save validation binds current node and active flag to active_branch', async () => {
  const child = {
    ...rootNode,
    id: 'node_if',
    parent_id: 'node_root',
    children_ids: [],
    branch_id: 'branch_if',
    turn_number: 1,
    state_snapshot: snapshot('if')
  };
  const data = {
    nodes: [{ ...rootNode, children_ids: ['node_if'] }, child],
    branches: [
      { ...mainBranch, node_count: 1, is_active: true },
      { ...mainBranch, id: 'branch_if', head_node_id: 'node_if', node_count: 1, is_active: true }
    ],
    meta: {
      key: 'root',
      value: { ...rootMeta.value, current_id: 'node_if', active_branch: 'branch_main', total_nodes: 2 }
    }
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /当前节点.*活动分支|is_active|活动标记/);
});

await test('timeline save validation checks optional numeric counters when present', async () => {
  const data = {
    nodes: [{ ...rootNode, turn_number: -1 }],
    branches: [{ ...mainBranch, node_count: 2.5 }],
    meta: { key: 'root', value: { ...rootMeta.value, total_nodes: -3 } }
  };
  const result = inspectTimelineSave(data);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /turn_number|node_count|total_nodes/);
});

await test('timeline navigator safely renders untrusted node and branch fields', async () => {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousCustomElements = globalThis.customElements;
  class FakeHTMLElement {
    attachShadow() {
      this.shadowRoot = {
        innerHTML: '',
        querySelector: () => null,
        querySelectorAll: () => []
      };
      return this.shadowRoot;
    }
  }
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.customElements = { define() {}, get() { return undefined; } };
  try {
    const { default: TimelineNavigator } = await import(`../js/ui/timeline-navigator.js?regression=${Date.now()}`);
    const navigator = new TimelineNavigator();
    const nodeId = 'node" onmouseover="alert(1)';
    const branchId = 'branch" onfocus="alert(2)';
    navigator._nodes = [{
      ...rootNode,
      id: nodeId,
      branch_id: branchId,
      turn_number: '<img src=x onerror=alert(3)>'
    }];
    navigator._branches = [{
      ...mainBranch,
      id: branchId,
      name: '<img src=x onerror=alert(4)>',
      color: 'red;position:fixed;inset:0',
      head_node_id: 'another-node'
    }];
    navigator._selectedId = nodeId;
    navigator._render();
    assert.doesNotMatch(
      navigator.shadowRoot.innerHTML,
      /data-id="[^"]*"\s+(?:onmouseover|onfocus)=/i
    );
    assert.match(navigator.shadowRoot.innerHTML, /data-id="node&quot; onmouseover=&quot;alert\(1\)"/);
    // Branch management now lives in the unified library, so the navigator
    // renders an escaped branch label without a branch-action data attribute.
    assert.match(navigator.shadowRoot.innerHTML, /&lt;img src=x onerror=alert\(4\)&gt;/);
    assert.doesNotMatch(navigator.shadowRoot.innerHTML, /<img\s+src=x|color:red;position:fixed;inset:0/i);
    // The compact timeline deliberately truncates untrusted turn labels
    // before escaping them; assert the escaped prefix rather than requiring
    // the full payload to be rendered into a fixed-width card.
    assert.match(navigator.shadowRoot.innerHTML, /&lt;img src=x onerror=a\.\.\./);
    assert.match(navigator.shadowRoot.innerHTML, /color:#eb613f/);
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
    if (previousCustomElements === undefined) delete globalThis.customElements;
    else globalThis.customElements = previousCustomElements;
  }
});

await test('timeline navigator keeps turns with attached Ling Xi maintenance visible', async () => {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousCustomElements = globalThis.customElements;
  class FakeHTMLElement {
    attachShadow() {
      this.shadowRoot = {
        innerHTML: '',
        querySelector: () => null,
        querySelectorAll: () => []
      };
      return this.shadowRoot;
    }
  }
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.customElements = { define() {}, get() { return undefined; } };
  try {
    const { default: TimelineNavigator } = await import(`../js/ui/timeline-navigator.js?attached-maintenance=${Date.now()}`);
    const navigator = new TimelineNavigator();
    const nodeId = 'node_attached_maintenance';
    const maintenance = {
      type: 'lingxi-variable-maintenance',
      label: '属性·当前查克拉',
      reason: '修复当前查克拉',
      previous_node_id: nodeId,
      created_at: 1700000000000
    };
    navigator._nodes = [{
      ...rootNode,
      id: nodeId,
      summary: '任务结束后返回木叶',
      maintenance,
      maintenance_history: [maintenance]
    }];
    navigator._branches = [{ ...mainBranch, head_node_id: nodeId }];
    navigator._selectedId = nodeId;

    assert.equal(navigator._isMaintenanceNode(navigator._nodes[0]), false);
    assert.equal(navigator._storyNodeId(nodeId), nodeId);
    navigator._render();
    assert.match(navigator.shadowRoot.innerHTML, /任务结束后返回木叶/);
    assert.match(navigator.shadowRoot.innerHTML, /有维护记录/);
    assert.match(navigator.shadowRoot.innerHTML, /本回合存档变更/);
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
    if (previousCustomElements === undefined) delete globalThis.customElements;
    else globalThis.customElements = previousCustomElements;
  }
});

await test('import state restoration explicitly rejects an unvalidated parent cycle', async () => {
  const first = { id: 'node_first', parent_id: 'node_second', state_snapshot: null };
  const second = { id: 'node_second', parent_id: 'node_first', state_snapshot: null };
  await assert.rejects(
    () => timelineSystem._restoreImportedState(first, [first, second]),
    /父节点关系包含环/
  );
});

await test('import state restoration rejects variable tags in display text without a current snapshot', async () => {
  const ancestor = {
    ...rootNode,
    children_ids: ['node_replay'],
    state_snapshot: { ...snapshot('ancestor'), '系统·回合数': 1 }
  };
  const current = {
    ...rootNode,
    id: 'node_replay',
    parent_id: 'node_root',
    turn_number: 2,
    state_snapshot: null,
    clean_response: '<variable>{"key":"系统·回合数","op":"=","value":7}</variable>'
  };
  await assert.rejects(
    () => timelineSystem._restoreImportedState(current, [ancestor, current]),
    /无法精确恢复|当前节点.*快照/
  );
});

await test('current timeline node persists only allowlisted live image state slices', async () => {
  const currentNode = {
    ...rootNode,
    id: 'node_current_image_state',
    parent_id: 'node_root',
    state_snapshot: snapshot('current-before-image-state')
  };
  const parentNode = { ...rootNode, children_ids: [currentNode.id] };
  const meta = {
    ...rootMeta,
    value: { ...rootMeta.value, current_id: currentNode.id, total_nodes: 2 }
  };
  await withTimelineDb({ nodes: [parentNode, currentNode], branches: [mainBranch], meta: [meta] }, async stores => {
    const relationships = {
      鸣人: {
        info: '第七班成员',
        visual_subject_id: 'subject-naruto',
        visual_profile: {
          subject_id: 'subject-naruto',
          canonical_description: '金发蓝眼，橙色忍者服',
          locked_traits: ['金发', '蓝眼'],
          revision: 2
        },
        portrait_binding: {
          selected_asset_id: 'asset-portrait-1',
          version_group_id: 'portrait:subject-naruto',
          binding_revision: 1
        }
      }
    };
    const overlay = {
      schema: 'naruto.image-worldbook/v1',
      version: 1,
      entries: [{ id: 'save-style', content: '木叶手绘动画质感', enabled: true }]
    };
    stateManager.setSub('_meta', { current_node_id: currentNode.id, active_branch: 'branch_main' });
    stateManager.setSub('_relationships', relationships);
    stateManager.setSub('_image_worldbook_overlay', overlay);

    const [relationshipResult, worldbookResult] = await Promise.all([
      timelineSystem.syncCurrentImageStateSlices(['_relationships']),
      timelineSystem.syncCurrentImageStateSlices(['_image_worldbook_overlay'])
    ]);
    assert.equal(relationshipResult.status, 'updated');
    assert.equal(worldbookResult.status, 'updated');

    const stored = stores.timeline_nodes.get(currentNode.id);
    assert.deepEqual(stored.state_snapshot._relationships, relationships);
    assert.deepEqual(stored.state_snapshot._image_worldbook_overlay, overlay);
    assert.equal(stored.state_snapshot.marker, 'current-before-image-state');
    assert.equal(stores.timeline_nodes.get('node_root').state_snapshot._relationships, undefined);

    stateManager.setSub('_relationships', {});
    stateManager.setSub('_image_worldbook_overlay', { entries: [] });
    stateManager.restore(stored.state_snapshot);
    assert.equal(
      stateManager.getSub('_relationships').鸣人.portrait_binding.selected_asset_id,
      'asset-portrait-1'
    );
    assert.equal(stateManager.getSub('_image_worldbook_overlay').entries[0].id, 'save-style');
  });
});

await test('image state slice sync sanitizes bytes/base64 and rejects unsafe or stale writes', async () => {
  const currentNode = {
    ...rootNode,
    id: 'node_image_state_candidate',
    state_snapshot: snapshot('unchanged')
  };
  const currentMeta = {
    ...rootMeta,
    value: { ...rootMeta.value, current_id: currentNode.id, total_nodes: 2 }
  };
  await withTimelineDb({ nodes: [rootNode, currentNode], branches: [mainBranch], meta: [currentMeta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: currentNode.id, active_branch: 'branch_main' });
    stateManager.setSub('_relationships', {
      测试人物: { visual_profile: { preview: 'data:image/png;base64,AAAA' } }
    });
    const relationshipResult = await timelineSystem.syncCurrentImageStateSlices(['_relationships']);
    assert.equal(relationshipResult.status, 'updated');
    assert.equal(
      stores.timeline_nodes.get(currentNode.id).state_snapshot._relationships.测试人物.visual_profile.preview,
      ''
    );

    stateManager.setSub('_image_worldbook_overlay', {
      schema: 'naruto.image-worldbook/v1', version: 1, entries: [], bytes: new Uint8Array([1, 2, 3])
    });
    const overlayResult = await timelineSystem.syncCurrentImageStateSlices(['_image_worldbook_overlay']);
    assert.equal(overlayResult.status, 'updated');
    assert.equal(
      Object.hasOwn(stores.timeline_nodes.get(currentNode.id).state_snapshot._image_worldbook_overlay, 'bytes'),
      false
    );

    stateManager.setSub('_relationships', JSON.parse('{"__proto__":{"polluted":true}}'));
    await assert.rejects(
      () => timelineSystem.syncCurrentImageStateSlices(['_relationships']),
      /不安全键/
    );
    await assert.rejects(
      () => timelineSystem.syncCurrentImageStateSlices(['_ui']),
      /不允许同步/
    );

    const snapshotBeforeStaleWrite = clone(stores.timeline_nodes.get(currentNode.id).state_snapshot);
    stores.timeline_meta.set('root', clone(rootMeta));
    stateManager.setSub('_relationships', { 测试人物: { visual_subject_id: 'subject-safe' } });
    const stale = await timelineSystem.syncCurrentImageStateSlices(['_relationships']);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.currentNodeId, 'node_root');
    assert.deepEqual(stores.timeline_nodes.get(currentNode.id).state_snapshot, snapshotBeforeStaleWrite);
  });
});

await test('current timeline node persists story state with node, branch, and before-value CAS', async () => {
  const beforeStory = {
    direction: null,
    plan: { id: 'old-plan', branchId: 'branch_main' },
    invalidated: false
  };
  const currentNode = {
    ...rootNode,
    id: 'node_story_state',
    state_snapshot: {
      ...snapshot('story-before'),
      _story_direction: beforeStory.direction,
      _agent_story_plan: beforeStory.plan,
      _agent_story_plan_invalidated: beforeStory.invalidated
    }
  };
  const currentMeta = {
    ...rootMeta,
    value: { ...rootMeta.value, current_id: currentNode.id, active_branch: 'branch_main', total_nodes: 2 }
  };
  await withTimelineDb({ nodes: [rootNode, currentNode], branches: [mainBranch], meta: [currentMeta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: currentNode.id, active_branch: 'branch_main' });
    const afterStory = {
      direction: {
        branchId: 'branch_main',
        direction: '先调查失踪案，再决定是否卷入大战',
        goals: ['保护同伴'],
        avoid: ['强制背叛'],
        updatedAt: '2026-08-07T12:00:00.000Z'
      },
      plan: null,
      invalidated: true
    };

    const result = await timelineSystem.persistCurrentStoryState({
      expectedNodeId: currentNode.id,
      expectedBranchId: 'branch_main',
      before: beforeStory,
      after: afterStory
    });
    assert.equal(result.status, 'updated');
    const persisted = stores.timeline_nodes.get(currentNode.id).state_snapshot;
    assert.deepEqual(persisted._story_direction, afterStory.direction);
    assert.equal(persisted._agent_story_plan, null);
    assert.equal(persisted._agent_story_plan_invalidated, true);
    assert.equal(persisted.marker, 'story-before');

    persisted._story_direction = { branchId: 'branch_main', direction: '并发更新' };
    stores.timeline_nodes.get(currentNode.id).state_snapshot = persisted;
    await assert.rejects(
      () => timelineSystem.persistCurrentStoryState({
        expectedNodeId: currentNode.id,
        expectedBranchId: 'branch_main',
        before: afterStory,
        after: { ...afterStory, invalidated: false }
      }),
      error => error?.code === 'LINGXI_PROPOSAL_STALE'
    );
    assert.equal(
      stores.timeline_nodes.get(currentNode.id).state_snapshot._story_direction.direction,
      '并发更新'
    );

    stores.timeline_meta.set('root', clone(rootMeta));
    await assert.rejects(
      () => timelineSystem.persistCurrentStoryState({
        expectedNodeId: currentNode.id,
        expectedBranchId: 'branch_main',
        before: afterStory,
        after: { ...afterStory, invalidated: false }
      }),
      error => error?.code === 'LINGXI_PROPOSAL_STALE'
    );
  });
});

await test('full timeline snapshots strip binary image payloads without clearing the live background', async () => {
  const runtimeBackground = 'data:image/png;base64,UlVOVElNRV9CQUNLR1JPVU5E';
  const ui = stateManager.getSub('_ui');
  ui.settings.backgroundImage = runtimeBackground;
  stateManager.setSub('_ui', ui);
  stateManager.setSub('_timeline_media_probe', snapshotWithLegacyMedia('runtime').nested_media);

  const cleanSnapshot = timelineSystem._buildNodeSnapshot(
    stateManager.snapshot(),
    'node_sanitized_snapshot',
    'branch_main'
  );

  assert.equal(cleanSnapshot._ui.settings.backgroundImage, '');
  assert.equal(Object.hasOwn(cleanSnapshot._timeline_media_probe, 'blob'), false);
  assert.equal(Object.hasOwn(cleanSnapshot._timeline_media_probe, 'array_buffer'), false);
  assert.equal(Object.hasOwn(cleanSnapshot._timeline_media_probe, 'typed_array'), false);
  assert.equal(cleanSnapshot._timeline_media_probe.blob_url, '');
  assert.equal(cleanSnapshot._timeline_media_probe.inline_image, '');
  assert.deepEqual(cleanSnapshot._timeline_media_probe.list, [null, '']);
  assert.equal(findForbiddenTimelineMedia(cleanSnapshot), null);
  assert.equal(stateManager.getSub('_ui').settings.backgroundImage, runtimeBackground);
  assert.ok(stateManager.getSub('_timeline_media_probe').blob instanceof Blob);

  stateManager.restore(cleanSnapshot);
  assert.equal(stateManager.getSub('_ui').settings.backgroundImage, runtimeBackground);
});

await test('export sanitizes legacy media and init migrates dirty stored timeline nodes', async () => {
  const dirtyNode = {
    ...rootNode,
    state_snapshot: snapshotWithLegacyMedia('legacy-stored')
  };
  await withTimelineDb({ nodes: [dirtyNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: rootNode.id, active_branch: 'branch_main' });

    const exported = await timelineSystem.getExportData();
    assert.equal(findForbiddenTimelineMedia(exported), null);
    assert.equal(exported.nodes[0].state_snapshot._ui.settings.backgroundImage, '');
    assert.equal(Object.hasOwn(exported.nodes[0].state_snapshot.nested_media, 'blob'), false);
    assert.equal(Object.hasOwn(exported.nodes[0].state_snapshot.nested_media, 'array_buffer'), false);
    assert.equal(Object.hasOwn(exported.nodes[0].state_snapshot.nested_media, 'typed_array'), false);
    assert.doesNotMatch(JSON.stringify(exported), /data:image\/|blob:/i);
    assert.equal(inspectTimelineSave(exported).valid, true);

    assert.notEqual(findForbiddenTimelineMedia(stores.timeline_nodes.get(rootNode.id)), null);
    await timelineSystem.init();
    const migrated = stores.timeline_nodes.get(rootNode.id);
    assert.equal(findForbiddenTimelineMedia(migrated), null);
    assert.equal(migrated.state_snapshot._ui.settings.backgroundImage, '');
    assert.deepEqual(migrated.state_snapshot.nested_media.list, [null, '']);
  });
});

await test('legacy timeline import accepts media payloads but only stores the sanitized snapshot', async () => {
  await withTimelineDb({ nodes: [rootNode], branches: [mainBranch], meta: [rootMeta] }, async stores => {
    const importedNode = {
      ...rootNode,
      id: 'legacy_media_root',
      state_snapshot: snapshotWithLegacyMedia('legacy-import')
    };
    const incoming = {
      export_version: '1.0',
      nodes: [importedNode],
      branches: [{ ...mainBranch, head_node_id: importedNode.id }],
      meta: {
        root_id: importedNode.id,
        current_id: importedNode.id,
        active_branch: 'branch_main'
      }
    };

    await timelineSystem.importTimeline(incoming);
    const stored = stores.timeline_nodes.get(importedNode.id);
    assert.ok(stored);
    assert.equal(findForbiddenTimelineMedia(stored), null);
    assert.equal(stored.state_snapshot._ui.settings.backgroundImage, '');
    assert.equal(Object.hasOwn(stored.state_snapshot.nested_media, 'blob'), false);
    assert.equal(Object.hasOwn(stored.state_snapshot.nested_media, 'array_buffer'), false);
    assert.equal(Object.hasOwn(stored.state_snapshot.nested_media, 'typed_array'), false);
    assert.deepEqual(stored.state_snapshot.nested_media.list, [null, '']);
  });
});

await test('timeline export flushes live image slices before reading nodes', async () => {
  const currentNode = {
    ...rootNode,
    id: 'node_export_image_state',
    state_snapshot: snapshot('export-before-flush')
  };
  const meta = { ...rootMeta, value: { ...rootMeta.value, current_id: currentNode.id } };
  await withTimelineDb({ nodes: [currentNode], branches: [mainBranch], meta: [meta] }, async stores => {
    stateManager.setSub('_meta', { current_node_id: currentNode.id, active_branch: 'branch_main' });
    stateManager.setSub('_relationships', {
      佐助: {
        visual_subject_id: 'subject-sasuke',
        portrait_binding: { selected_asset_id: 'asset-sasuke', binding_revision: 3 }
      }
    });
    stateManager.setSub('_image_worldbook_overlay', {
      schema: 'naruto.image-worldbook/v1', version: 1,
      entries: [{ id: 'export-overlay', content: '夜景冷色调', enabled: true }]
    });

    const exported = await timelineSystem.getExportData();
    const exportedNode = exported.nodes.find(node => node.id === currentNode.id);
    assert.equal(exportedNode.state_snapshot._relationships.佐助.portrait_binding.selected_asset_id, 'asset-sasuke');
    assert.equal(exportedNode.state_snapshot._image_worldbook_overlay.entries[0].id, 'export-overlay');
    assert.deepEqual(exportedNode.state_snapshot, stores.timeline_nodes.get(currentNode.id).state_snapshot);
  });
});

await test('image integration persists relationship visuals, deletions, and save worldbook events', async () => {
  const currentNode = {
    ...rootNode,
    id: 'node_image_integration',
    state_snapshot: snapshot('integration')
  };
  const meta = { ...rootMeta, value: { ...rootMeta.value, current_id: currentNode.id } };
  await withTimelineDb({ nodes: [currentNode], branches: [mainBranch], meta: [meta] }, async stores => {
    const [{ ImageFeatureIntegration }, { eventBus }] = await Promise.all([
      import('../js/core/image-studio/integration.js'),
      import('../js/core/event-bus.js')
    ]);
    const studioListeners = new Set();
    const commands = [];
    const studio = {
      async ready() {},
      subscribe(listener) {
        studioListeners.add(listener);
        return () => studioListeners.delete(listener);
      },
      async execute(command) {
        commands.push(command);
        return { status: 'ok' };
      },
      async emit(event) {
        await Promise.all([...studioListeners].map(listener => listener(event)));
      }
    };
    const integration = new ImageFeatureIntegration({ studio });
    stateManager.setSub('_meta', { current_node_id: currentNode.id, active_branch: 'branch_main' });
    stateManager.setSub('_relationships', {
      小樱: {
        visual_subject_id: 'subject-sakura',
        visual_profile: { subject_id: 'subject-sakura', canonical_description: '粉发绿眼', revision: 1 },
        portrait_binding: { selected_asset_id: 'asset-sakura', binding_revision: 1 }
      }
    });
    stateManager.setSub('_image_worldbook_overlay', {
      schema: 'naruto.image-worldbook/v1', version: 1,
      entries: [{ id: 'costume', content: '任务服装连续一致', enabled: true }]
    });

    try {
      await integration.init();
      await studio.emit({ type: 'worldbook.changed' });
      eventBus.emit('relationship:visual-changed', { npc: '小樱', subjectId: 'subject-sakura' });
      await new Promise(resolve => setTimeout(resolve, 0));

      let stored = stores.timeline_nodes.get(currentNode.id).state_snapshot;
      assert.equal(stored._image_worldbook_overlay.entries[0].id, 'costume');
      assert.equal(stored._relationships.小樱.portrait_binding.selected_asset_id, 'asset-sakura');

      stateManager.setSub('_relationships', {});
      eventBus.emit('relationship:visual-deleted', { npc: '小樱', subjectId: 'subject-sakura' });
      await new Promise(resolve => setTimeout(resolve, 0));
      stored = stores.timeline_nodes.get(currentNode.id).state_snapshot;
      assert.deepEqual(stored._relationships, {});
      assert.ok(commands.some(command => command.type === 'detach'
        && command.target?.subjectId === 'subject-sakura'));
    } finally {
      integration.dispose();
    }
  });
});

await test('authoritative cloud bindings reconcile timeline and portrait revisions without local CAS gaps', async () => {
  const currentNode = {
    ...rootNode,
    id: 'node_cloud_binding_reconcile',
    media: {
      illustration: {
        selected_asset_id: 'asset-turn-old',
        binding_revision: 1,
        version_group_id: 'turn:node_cloud_binding_reconcile:versions'
      }
    },
    state_snapshot: snapshot('cloud-binding-reconcile')
  };
  const meta = { ...rootMeta, value: { ...rootMeta.value, current_id: currentNode.id } };
  await withTimelineDb({ nodes: [currentNode], branches: [mainBranch], meta: [meta] }, async stores => {
    const { ImageFeatureIntegration } = await import('../js/core/image-studio/integration.js');
    const listeners = new Set();
    const studio = {
      async ready() {},
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async execute() { return { status: 'ok' }; },
      async emit(event) {
        await Promise.all([...listeners].map(listener => listener(event)));
      }
    };
    const integration = new ImageFeatureIntegration({ studio });
    stateManager.setSub('_meta', { current_node_id: currentNode.id, active_branch: 'branch_main' });
    stateManager.setSub('_relationships', {
      井野: {
        visual_subject_id: 'subject-ino',
        visual_profile: { subject_id: 'subject-ino', canonical_description: '金发蓝眼', revision: 1 },
        portrait_binding: {
          selected_asset_id: 'asset-portrait-old',
          binding_revision: 2,
          version_group_id: 'portrait:subject-ino:versions'
        }
      }
    });

    try {
      await integration.init();
      await studio.emit({
        type: 'binding.changed', authoritative: true, source: 'cloud-hydration',
        target: { kind: 'turn', nodeId: currentNode.id },
        binding: {
          assetId: 'asset-turn-cloud', revision: 7,
          versionGroupId: 'turn:node_cloud_binding_reconcile:versions'
        }
      });
      await studio.emit({
        type: 'binding.changed', authoritative: true, source: 'cloud-hydration',
        target: { kind: 'portrait', subjectId: 'subject-ino' },
        binding: {
          assetId: 'asset-portrait-cloud', revision: 6,
          versionGroupId: 'portrait:subject-ino:versions'
        }
      });

      let storedNode = stores.timeline_nodes.get(currentNode.id);
      assert.equal(storedNode.media.illustration.selected_asset_id, 'asset-turn-cloud');
      assert.equal(storedNode.media.illustration.binding_revision, 7);
      assert.equal(stateManager.getSub('_relationships').井野.portrait_binding.selected_asset_id, 'asset-portrait-cloud');
      assert.equal(stateManager.getSub('_relationships').井野.portrait_binding.binding_revision, 6);
      assert.equal(
        storedNode.state_snapshot._relationships.井野.portrait_binding.selected_asset_id,
        'asset-portrait-cloud'
      );

      await studio.emit({
        type: 'binding.changed', authoritative: true, source: 'cloud-hydration',
        target: { kind: 'turn', nodeId: currentNode.id },
        binding: { assetId: 'asset-stale-cloud', revision: 5 }
      });
      storedNode = stores.timeline_nodes.get(currentNode.id);
      assert.equal(storedNode.media.illustration.selected_asset_id, 'asset-turn-cloud');
      assert.equal(storedNode.media.illustration.binding_revision, 7);

      await studio.emit({
        type: 'binding.detached', authoritative: true, source: 'cloud-hydration',
        target: { kind: 'turn', nodeId: currentNode.id },
        binding: { assetId: null, revision: 8 }
      });
      storedNode = stores.timeline_nodes.get(currentNode.id);
      assert.equal(storedNode.media.illustration.selected_asset_id, null);
      assert.equal(storedNode.media.illustration.binding_revision, 8);
    } finally {
      integration.dispose();
    }
  });
});

await test('restoring a node aligns live turn count to the node turn, not the next turn', async () => {
  const parent = {
    ...rootNode,
    turn_number: 1,
    children_ids: ['node_child'],
    state_snapshot: { ...snapshot('parent'), '系统·回合数': 2 }
  };
  const child = {
    ...rootNode,
    id: 'node_child',
    parent_id: 'node_root',
    turn_number: 2,
    children_ids: [],
    state_snapshot: { ...snapshot('child'), '系统·回合数': 3 }
  };
  await withTimelineDb({
    nodes: [parent, child],
    branches: [{ ...mainBranch, head_node_id: 'node_child', node_count: 2 }],
    meta: [{ key: 'root', value: { ...rootMeta.value, current_id: 'node_child', total_nodes: 2 } }]
  }, async () => {
    stateManager.restore({ ...snapshot('live'), '系统·回合数': 3 });
    await timelineSystem.jumpToNode('node_root');
    assert.equal(stateManager.get('系统·回合数'), 1);
    assert.equal(stateManager.snapshot().marker, 'parent');
  });
});

await test('gzip-compressed cold nodes restore on jump and export without payload', async () => {
  const old = {
    ...rootNode,
    id: 'node_old',
    parent_id: 'node_root',
    turn_number: 1,
    children_ids: [],
    chat_history_delta: [{ role: 'user', content: 'keep-me' }],
    state_snapshot: snapshot('compressed-old'),
    archived: true
  };
  const compressed = await compressTimelineNode(old);
  assert.equal(isCompressedTimelineNode(compressed), true);
  assert.equal(compressed.state_snapshot, undefined);
  assert.deepEqual(compressed.chat_history_delta, old.chat_history_delta);

  const parent = { ...rootNode, children_ids: ['node_old'] };
  await withTimelineDb({
    nodes: [parent, compressed],
    branches: [{ ...mainBranch, head_node_id: 'node_old', node_count: 2 }],
    meta: [{ key: 'root', value: { ...rootMeta.value, current_id: 'node_root', total_nodes: 2 } }]
  }, async stores => {
    await timelineSystem.jumpToNode('node_old');
    assert.equal(stateManager.snapshot().marker, 'compressed-old');
    const stored = stores.timeline_nodes.get('node_old');
    assert.equal(isCompressedTimelineNode(stored), false);
    assert.equal(stored.state_snapshot.marker, 'compressed-old');
    assert.equal(stored.archived, false);
    assert.deepEqual(stored.chat_history_delta, old.chat_history_delta);

    stores.timeline_nodes.set('node_old', clone(compressed));
    const exported = await timelineSystem.getExportData({ includeArchive: true });
    assert.equal(exported.nodes.find(node => node.id === 'node_old').state_snapshot.marker, 'compressed-old');
    assert.equal(Object.hasOwn(exported.nodes.find(node => node.id === 'node_old'), 'payload'), false);
    assert.deepEqual(inspectTimelineSave(exported), { valid: true, errors: [] });
  });
});

await test('cold window gzip keeps the latest 20 nodes uncompressed', async () => {
  const nodes = [];
  for (let index = 0; index < 25; index++) {
    nodes.push({
      id: `node_${index}`,
      parent_id: index === 0 ? null : `node_${index - 1}`,
      children_ids: index === 24 ? [] : [`node_${index + 1}`],
      branch_id: 'branch_main',
      turn_number: index,
      chat_history_delta: [{ role: 'user', content: `turn-${index}` }],
      state_snapshot: snapshot(`turn-${index}`),
      archived: false
    });
  }
  await withTimelineDb({
    nodes,
    branches: [{ ...mainBranch, head_node_id: 'node_24', node_count: 25 }],
    meta: [{ key: 'root', value: { root_id: 'node_0', current_id: 'node_24', active_branch: 'branch_main', total_nodes: 25 } }]
  }, async stores => {
    const result = await timelineSystem._compressColdNodes();
    assert.equal(result.compressed, 5);
    for (let index = 0; index < 5; index++) {
      const node = stores.timeline_nodes.get(`node_${index}`);
      assert.equal(isCompressedTimelineNode(node), true);
      assert.equal(node.archived, true);
      assert.deepEqual(node.chat_history_delta, [{ role: 'user', content: `turn-${index}` }]);
    }
    for (let index = 5; index < 25; index++) {
      const node = stores.timeline_nodes.get(`node_${index}`);
      assert.equal(isCompressedTimelineNode(node), false);
      assert.equal(node.state_snapshot.marker, `turn-${index}`);
      assert.equal(node.archived, false);
    }

    await timelineSystem.jumpToNode('node_0');
    assert.equal(stateManager.snapshot().marker, 'turn-0');
    await timelineSystem._compressColdNodes();
    assert.equal(isCompressedTimelineNode(stores.timeline_nodes.get('node_0')), false);
    assert.equal(stores.timeline_nodes.get('node_0').state_snapshot.marker, 'turn-0');
    assert.equal(isCompressedTimelineNode(stores.timeline_nodes.get('node_24')), true);
  });
});

await test('merge import hydrates gzip-compressed existing nodes before validation', async () => {
  const compressedRoot = await compressTimelineNode({
    ...rootNode,
    state_snapshot: snapshot('root')
  });
  assert.equal(isCompressedTimelineNode(compressedRoot), true);
  await withTimelineDb({
    nodes: [compressedRoot],
    branches: [mainBranch],
    meta: [rootMeta]
  }, async stores => {
    stateManager.setSub('_meta', { current_node_id: 'node_root', active_branch: 'branch_main' });
    const incoming = {
      nodes: [{ ...rootNode, state_snapshot: snapshot('imported') }],
      branches: [{ ...mainBranch }],
      meta: clone(rootMeta)
    };
    await timelineSystem.importTimeline(incoming, { mode: 'merge' });
    const storedRoot = stores.timeline_nodes.get('node_root');
    assert.equal(isCompressedTimelineNode(storedRoot), false);
    assert.equal(storedRoot.state_snapshot.marker, 'root');
    assert.equal(storedRoot.children_ids.length, 1);
  });
});

await test('queued archive after jump keeps the new current node uncompressed', async () => {
  const nodes = [];
  for (let index = 0; index < 25; index++) {
    nodes.push({
      id: `node_${index}`,
      parent_id: index === 0 ? null : `node_${index - 1}`,
      children_ids: index === 24 ? [] : [`node_${index + 1}`],
      branch_id: 'branch_main',
      turn_number: index,
      state_snapshot: snapshot(`turn-${index}`),
      archived: false
    });
  }
  await withTimelineDb({
    nodes,
    branches: [{ ...mainBranch, head_node_id: 'node_24', node_count: 25 }],
    meta: [{ key: 'root', value: { root_id: 'node_0', current_id: 'node_24', active_branch: 'branch_main', total_nodes: 25 } }]
  }, async stores => {
    await timelineSystem._compressColdNodes();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const originalCompress = timelineSystem._compressColdNodes.bind(timelineSystem);
    let started = 0;
    timelineSystem._compressColdNodes = async () => {
      started += 1;
      if (started === 1) await gate;
      return originalCompress();
    };
    try {
      const first = timelineSystem._maybeArchive();
      await timelineSystem.jumpToNode('node_0');
      const second = timelineSystem._maybeArchive();
      release();
      await Promise.all([first, second]);
    } finally {
      timelineSystem._compressColdNodes = originalCompress;
    }
    assert.equal(isCompressedTimelineNode(stores.timeline_nodes.get('node_0')), false);
    assert.equal(stores.timeline_nodes.get('node_0').state_snapshot.marker, 'turn-0');
  }, { archive: true });
});

await test('createNode hydrates a compressed current parent before appending', async () => {
  const compressed = await compressTimelineNode({
    ...rootNode,
    state_snapshot: snapshot('root')
  });
  await withTimelineDb({
    nodes: [compressed],
    branches: [mainBranch],
    meta: [rootMeta]
  }, async stores => {
    stateManager.restore({
      ...snapshot('root'),
      _meta: { current_node_id: 'node_root', active_branch: 'branch_main' }
    });
    const created = await timelineSystem.createNode({
      turnNumber: 1,
      playerInput: '继续前进',
      aiResponse: '道路向前延伸。',
      stateSnapshot: snapshot('child'),
      chatHistory: []
    });
    assert.equal(isCompressedTimelineNode(stores.timeline_nodes.get('node_root')), false);
    assert.equal(stores.timeline_nodes.get('node_root').state_snapshot.marker, 'root');
    assert.equal(created.state_snapshot.marker, 'child');
    assert.ok(Array.isArray(created.continuity_delta));
  });
});

await test('prepareReroll replace removes the rerolled turn and later turns', async () => {
  const turn1 = {
    ...rootNode,
    id: 'node_t1',
    parent_id: 'node_root',
    children_ids: ['node_t2'],
    turn_number: 1,
    player_input: '向前走',
    state_snapshot: snapshot('t1')
  };
  const turn2 = {
    ...rootNode,
    id: 'node_t2',
    parent_id: 'node_t1',
    children_ids: [],
    turn_number: 2,
    player_input: '再走',
    state_snapshot: snapshot('t2')
  };
  const parent = { ...rootNode, children_ids: ['node_t1'] };
  const branch = { ...mainBranch, head_node_id: 'node_t2', node_count: 3 };
  const meta = {
    ...rootMeta,
    value: { ...rootMeta.value, current_id: 'node_t2', total_nodes: 3 }
  };
  await withTimelineDb({ nodes: [parent, turn1, turn2], branches: [branch], meta: [meta] }, async stores => {
    stateManager.restore(snapshot('t2'));
    stateManager.setSub('_meta', { current_node_id: 'node_t2', active_branch: 'branch_main' });
    const prepared = await timelineSystem.prepareReroll('node_t1', { mode: 'replace' });
    assert.equal(prepared.parentNodeId, 'node_root');
    assert.equal(prepared.playerInput, '向前走');
    assert.equal(prepared.pruned, 2);
    assert.deepEqual([...stores.timeline_nodes.keys()].sort(), ['node_root']);
    assert.deepEqual(stores.timeline_nodes.get('node_root').children_ids, []);
    assert.equal(stores.timeline_branches.get('branch_main').head_node_id, 'node_root');
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 1);
    assert.equal(timelineSystem._pendingBranchFrom, null);
    assert.equal(stateManager.getSub('_meta').current_node_id, 'node_root');
  });
});

await test('pruneForward deletes subsequent turns missing from children_ids', async () => {
  const orphan = {
    ...rootNode,
    id: 'node_orphan',
    parent_id: 'node_root',
    children_ids: ['node_orphan_child'],
    turn_number: 1,
    state_snapshot: snapshot('orphan')
  };
  const orphanChild = {
    ...rootNode,
    id: 'node_orphan_child',
    parent_id: 'node_orphan',
    children_ids: [],
    turn_number: 2,
    state_snapshot: snapshot('orphan-child')
  };
  const parent = { ...rootNode, children_ids: ['node_missing'] };
  const branch = { ...mainBranch, head_node_id: 'node_orphan_child', node_count: 3 };
  const meta = {
    ...rootMeta,
    value: { ...rootMeta.value, current_id: 'node_orphan_child', total_nodes: 3 }
  };
  await withTimelineDb({ nodes: [parent, orphan, orphanChild], branches: [branch], meta: [meta] }, async stores => {
    stateManager.restore(snapshot('orphan-child'));
    stateManager.setSub('_meta', { current_node_id: 'node_orphan_child', active_branch: 'branch_main' });
    const result = await timelineSystem.pruneForward('node_root');
    assert.equal(result.pruned, 2);
    assert.deepEqual([...stores.timeline_nodes.keys()].sort(), ['node_root']);
    assert.deepEqual(stores.timeline_nodes.get('node_root').children_ids, []);
    assert.equal(stores.timeline_branches.get('branch_main').head_node_id, 'node_root');
    assert.equal(stores.timeline_meta.get('root').value.total_nodes, 1);
  });
});

await test('in-flight archive cannot resurrect turns deleted by pruneForward', async () => {
  const child = {
    ...rootNode,
    id: 'node_child',
    parent_id: 'node_root',
    children_ids: ['node_grandchild'],
    turn_number: 1,
    archived: true,
    state_snapshot: snapshot('child')
  };
  const grandchild = {
    ...rootNode,
    id: 'node_grandchild',
    parent_id: 'node_child',
    children_ids: [],
    turn_number: 2,
    archived: true,
    state_snapshot: snapshot('grandchild')
  };
  const parent = { ...rootNode, children_ids: ['node_child'], archived: true };
  const branch = { ...mainBranch, head_node_id: 'node_grandchild', node_count: 3 };
  const meta = {
    ...rootMeta,
    value: { ...rootMeta.value, current_id: 'node_grandchild', total_nodes: 3 }
  };
  await withTimelineDb({
    nodes: [parent, child, grandchild],
    branches: [branch],
    meta: [meta]
  }, async stores => {
    stateManager.restore(snapshot('grandchild'));
    stateManager.setSub('_meta', { current_node_id: 'node_grandchild', active_branch: 'branch_main' });

    const originalGetAll = stateManager.dbGetAll;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let held = false;
    stateManager.dbGetAll = async name => {
      const result = await originalGetAll(name);
      if (name === 'timeline_nodes' && !held) {
        held = true;
        await gate;
      }
      return result;
    };
    try {
      const archivePromise = timelineSystem._compressColdNodes();
      while (!held) await new Promise(resolve => setTimeout(resolve, 0));
      const result = await timelineSystem.pruneForward('node_root');
      assert.equal(result.pruned, 2);
      assert.deepEqual([...stores.timeline_nodes.keys()].sort(), ['node_root']);
      release();
      await archivePromise;
      assert.deepEqual([...stores.timeline_nodes.keys()].sort(), ['node_root']);
      assert.deepEqual(stores.timeline_nodes.get('node_root').children_ids, []);
      await timelineSystem.createNode({
        turnNumber: 1,
        playerInput: '重新推衍',
        aiResponse: '新的可能性展开。',
        stateSnapshot: snapshot('reroll'),
        chatHistory: []
      });
      assert.equal(stores.timeline_nodes.size, 2);
      assert.equal(stores.timeline_nodes.has('node_child'), false);
      assert.equal(stores.timeline_nodes.has('node_grandchild'), false);
      assert.equal(stores.timeline_nodes.get('node_root').children_ids.length, 1);
      await timelineSystem._archiveQueue;
    } finally {
      stateManager.dbGetAll = originalGetAll;
    }
  }, { archive: true });
});

await test('timeline reroll replace goes through prepareReroll so prune cannot drift', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const rerollAt = source.indexOf("eventBus.on('timeline:reroll-request'");
  const nextHandler = source.indexOf("eventBus.on('timeline:jump-request'", rerollAt);
  const handler = source.slice(rerollAt, nextHandler === -1 ? undefined : nextHandler);
  assert.ok(rerollAt >= 0);
  assert.match(handler, /prepareReroll/);
  assert.equal(handler.includes('pruneForward'), false);
});

await test('pipeline clears a stale timeline error after node creation succeeds', async () => {
  const source = await readFile(new URL('../js/core/pipeline.js', import.meta.url), 'utf8');
  const createAt = source.indexOf('await this.timelineSystem.createNode');
  const catchAt = source.indexOf('} catch (timelineErr)', createAt);
  const clearAt = source.indexOf('this._lastTimelineError = null', createAt);
  assert.ok(createAt >= 0 && catchAt > createAt);
  assert.ok(clearAt > createAt && clearAt < catchAt);
});

console.log(`\n${passed} timeline regression tests passed.`);
