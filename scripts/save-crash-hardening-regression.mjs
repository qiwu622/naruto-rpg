import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import '../js/vendor/save-codec.js';
import { stateManager } from '../js/core/state-manager.js';
import { timelineSystem } from '../js/systems/timeline-system.js';
import {
  compressTimelineNode,
  decompressTimelineNode,
  getTimelineMemoryCacheLimit,
  isCompressedTimelineNode,
  listingTimelineNode,
  TIMELINE_HOT_WINDOW
} from '../js/core/timeline-node-codec.js';
import { LingXiProjectStateAdapter } from '../js/core/lingxi/adapters/project-state-adapter.js';
import { TimelineActionAdapter } from '../js/core/lingxi/adapters/timeline-action-adapter.js';
import {
  BOOT_WATCHDOG_KEY,
  getBootWatchdogState,
  inspectSaveHealth,
  markBootHealthy,
  pruneAutoBackups,
  resetBootWatchdog,
  shouldThrottleCloudAutoSync
} from '../js/core/save-health.js';
import { validateSavePackage, SAVE_PACKAGE_SCHEMA_V2 } from '../js/core/save-library.js';
import { streamParseSaveJson, checksumSaveJson } from '../js/core/save-json-stream.js';

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

function makeSnapshot(marker, branchId = 'branch_main') {
  return {
    _version: '5.0',
    marker,
    _meta: { current_node_id: null, active_branch: branchId, turn_count: 1 },
    _story_direction: { branchId, text: `direction-${marker}` },
    '系统·回合数': 1,
    '玩家·姓名': '漩涡鸣人',
    '世界·地点': '木叶隐村'
  };
}

async function withNoFullScanDb(seed, fn) {
  const stores = {
    timeline_nodes: new Map((seed.nodes || []).map(item => [item.id, clone(item)])),
    timeline_branches: new Map((seed.branches || []).map(item => [item.id, clone(item)])),
    timeline_meta: new Map((seed.meta || []).map(item => [item.key, clone(item)]))
  };
  const methods = [
    'initDB', 'dbGet', 'dbGetAll', 'dbTimelineSummaries', 'dbPut', 'dbDelete',
    'dbClear', 'dbReplaceTimeline', 'dbCommitTimeline', 'dbMutateTimeline', 'getDB'
  ];
  const originals = Object.fromEntries(methods.map(name => [name, stateManager[name]]));
  let forbidTimelineNodesScan = false;

  stateManager.initDB = async () => ({});
  stateManager.getDB = () => null;
  stateManager.dbGet = async (name, key) => clone(stores[name].get(key));
  stateManager.dbGetAll = async name => {
    if (forbidTimelineNodesScan && name === 'timeline_nodes') {
      throw new Error('Unexpected full-table dbGetAll("timeline_nodes") scan');
    }
    return [...stores[name].values()].map(clone);
  };
  stateManager.dbTimelineSummaries = async () => [...stores.timeline_nodes.values()].map(listingTimelineNode);
  stateManager.dbPut = async (name, value) => { stores[name].set(value.id ?? value.key, clone(value)); };
  stateManager.dbDelete = async (name, key) => { stores[name].delete(key); };
  stateManager.dbClear = async name => { stores[name].clear(); };
  stateManager.dbReplaceTimeline = async ({ nodes, branches, meta }) => {
    stores.timeline_nodes = new Map(nodes.map(item => [item.id, clone(item)]));
    stores.timeline_branches = new Map(branches.map(item => [item.id, clone(item)]));
    stores.timeline_meta = new Map([[meta.key, clone(meta)]]);
  };
  stateManager.dbCommitTimeline = async ({ nodes = [], branches = [], meta = null }) => {
    for (const node of nodes) stores.timeline_nodes.set(node.id, clone(node));
    for (const branch of branches) stores.timeline_branches.set(branch.id, clone(branch));
    if (meta) stores.timeline_meta.set(meta.key, clone(meta));
  };
  stateManager.dbMutateTimeline = async (mutator, { nodeKeys = null, branchKeys = null } = {}) => {
    if (forbidTimelineNodesScan && !Array.isArray(nodeKeys)) {
      throw new Error('Unexpected full-table scan inside dbMutateTimeline (nodeKeys not specified)');
    }
    const mutation = mutator({
      nodes: Array.isArray(nodeKeys)
        ? nodeKeys.map(k => stores.timeline_nodes.get(k)).filter(Boolean).map(clone)
        : [...stores.timeline_nodes.values()].map(clone),
      branches: Array.isArray(branchKeys)
        ? branchKeys.map(k => stores.timeline_branches.get(k)).filter(Boolean).map(clone)
        : [...stores.timeline_branches.values()].map(clone),
      meta: clone(stores.timeline_meta.get('root'))
    });
    if (mutation.replace === true) {
      stores.timeline_nodes.clear();
      stores.timeline_branches.clear();
      stores.timeline_meta.clear();
    }
    for (const id of mutation.deleteNodeIds || []) stores.timeline_nodes.delete(id);
    for (const id of mutation.deleteBranchIds || []) stores.timeline_branches.delete(id);
    for (const node of mutation.nodes || []) stores.timeline_nodes.set(node.id, clone(node));
    for (const branch of mutation.branches || []) stores.timeline_branches.set(branch.id, clone(branch));
    if (mutation.meta) stores.timeline_meta.set(mutation.meta.key, clone(mutation.meta));
    return mutation.result;
  };

  try {
    await fn({
      stores,
      setStrictNoScan: value => { forbidTimelineNodesScan = value; }
    });
  } finally {
    Object.assign(stateManager, originals);
    stateManager.reset();
    timelineSystem._nodeCache.clear();
    timelineSystem._pendingBranchFrom = null;
    timelineSystem._initialized = false;
  }
}

await test('mobile UA tightens runtime node cache window without altering desktop TIMELINE_HOT_WINDOW', async () => {
  assert.equal(TIMELINE_HOT_WINDOW, 20);
  assert.equal(getTimelineMemoryCacheLimit(), 20);
  const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile' }
    });
    assert.equal(getTimelineMemoryCacheLimit(), 5);
    for (let i = 0; i < 12; i++) {
      timelineSystem._cacheNode(`n_${i}`, { id: `n_${i}`, state_snapshot: makeSnapshot(i) });
    }
    assert.equal(timelineSystem._nodeCache.size, 5);
  } finally {
    if (origNav) Object.defineProperty(globalThis, 'navigator', origNav);
    timelineSystem._nodeCache.clear();
  }
});

await test('branch ops, pruneForward and LingXi adapters avoid full-table timeline_nodes scans and preserve cold compression', async () => {
  const coldMain1 = await compressTimelineNode({
    id: 'node_1', parent_id: null, children_ids: ['node_2'], branch_id: 'branch_main',
    turn_number: 1, depth: 0, archived: true, created_at: 100,
    state_snapshot: makeSnapshot('main-1', 'branch_main')
  });
  const hotMain2 = {
    id: 'node_2', parent_id: 'node_1', children_ids: ['node_if_1'], branch_id: 'branch_main',
    turn_number: 2, depth: 1, archived: false, created_at: 200,
    state_snapshot: makeSnapshot('main-2', 'branch_main')
  };
  const coldIf1 = await compressTimelineNode({
    id: 'node_if_1', parent_id: 'node_2', children_ids: ['node_if_2'], branch_id: 'branch_if',
    turn_number: 3, depth: 2, archived: true, created_at: 300,
    state_snapshot: makeSnapshot('if-1', 'branch_if')
  });
  const hotIf2 = {
    id: 'node_if_2', parent_id: 'node_if_1', children_ids: [], branch_id: 'branch_if',
    turn_number: 4, depth: 3, archived: false, created_at: 400,
    state_snapshot: makeSnapshot('if-2', 'branch_if')
  };
  const branches = [
    { id: 'branch_main', name: '主线', head_node_id: 'node_2', diverged_from: null, node_count: 2, is_active: false },
    { id: 'branch_if', name: 'IF 线', head_node_id: 'node_if_2', diverged_from: 'node_2', diverged_at_turn: 2, node_count: 2, is_active: true }
  ];
  const meta = { key: 'root', value: { root_id: 'node_1', current_id: 'node_if_2', active_branch: 'branch_if', total_nodes: 4 } };

  await withNoFullScanDb({ nodes: [coldMain1, hotMain2, coldIf1, hotIf2], branches, meta: [meta] }, async ({ stores, setStrictNoScan }) => {
    stateManager.restore(makeSnapshot('if-2', 'branch_if'));
    stateManager.setSub('_meta', { current_node_id: 'node_if_2', active_branch: 'branch_if' });
    setStrictNoScan(true);

    // 1. LingXi adapters inspect without scanning full timeline_nodes
    const projectAdapter = new LingXiProjectStateAdapter({ stateManager, timelineSystem });
    const timelineOverview = await projectAdapter.inspectTimeline({ includeArchived: true });
    assert.equal(timelineOverview.nodes.length, 4);
    assert.equal(timelineOverview.nodes.some(n => n.id === 'node_1' && n.compressed), true);

    const actionAdapter = new TimelineActionAdapter({
      stateManager, timelineSystem, executeTimelineAction: async () => ({ ok: true })
    });
    const actionSnap = await actionAdapter._snapshot();
    assert.equal(actionSnap.nodes.length, 4);

    // 2. Rename & promote branch WITHOUT hydrating cold compressed nodes
    await timelineSystem.renameBranch('branch_if', { name: '佐助线' });
    assert.equal(stores.timeline_branches.get('branch_if').name, '佐助线');

    await timelineSystem.promoteBranchToMain('branch_if');
    const storedColdPromoted = stores.timeline_nodes.get('node_if_1');
    assert.equal(isCompressedTimelineNode(storedColdPromoted), true, 'cold node stayed compressed during promotion');
    assert.equal(storedColdPromoted.branch_id, 'branch_main');

    // Hydrating promoted compressed node realigns _meta.active_branch and _story_direction.branchId
    const hydratedPromoted = await timelineSystem._hydrateNode(storedColdPromoted);
    assert.equal(hydratedPromoted.state_snapshot._meta.active_branch, 'branch_main');
    assert.equal(hydratedPromoted.state_snapshot._story_direction.branchId, 'branch_main');

    // 3. Create new IF branch & delete branch without full scans
    const secondIf = await timelineSystem.createIfBranch({ fromNodeId: 'node_2', name: '第二分岐' });
    const createdAnchorId = stores.timeline_branches.get(secondIf.id).head_node_id;
    assert.ok(createdAnchorId);

    const delRes = await timelineSystem.deleteBranch(secondIf.id);
    assert.equal(delRes.deletedNodes, 1);

    // 4. Prune forward without full scans
    const pruneRes = await timelineSystem.pruneForward('node_2');
    assert.equal(pruneRes.pruned, 2);
  });
});

await test('save health diagnostics, boot watchdog, cloud sync throttling, and auto-backup GC work as specified', async () => {
  storage.clear();
  resetBootWatchdog();
  assert.equal(getBootWatchdogState().attempts, 0);
  globalThis.localStorage.setItem(BOOT_WATCHDOG_KEY, JSON.stringify({ attempts: 2, lastStartAt: Date.now(), lastHealthyAt: 0 }));
  assert.equal(getBootWatchdogState().attempts, 2);
  markBootHealthy();
  assert.equal(getBootWatchdogState().attempts, 0);

  // Rolling backup retention
  const pruned = pruneAutoBackups([
    { id: 'm1', reason: 'manual', updatedAt: 10 },
    { id: 'a1', reason: 'before-load', updatedAt: 100 },
    { id: 'a2', reason: 'before-load', updatedAt: 200 },
    { id: 'a3', reason: 'before-new-game', updatedAt: 300 },
    { id: 'a4', reason: 'before-load', updatedAt: 400 },
    { id: 'a5', reason: 'before-rescue', updatedAt: 500 },
    { id: 'a6', reason: 'before-load', updatedAt: 600 },
    { id: 'a7', reason: 'before-load', updatedAt: 700 }
  ], { keep: 5 });
  assert.deepEqual(pruned, ['a2', 'a1']);

  // Cloud auto-sync throttling
  assert.equal(shouldThrottleCloudAutoSync({ totalNodes: 20, estimatedBytes: 1e6, lastSyncAt: 1000, now: 2000 }).throttle, false);
  assert.equal(shouldThrottleCloudAutoSync({ totalNodes: 220, estimatedBytes: 80e6, lastSyncAt: 10000, now: 20000 }).throttle, true);
  assert.equal(shouldThrottleCloudAutoSync({ totalNodes: 220, estimatedBytes: 80e6, lastSyncAt: 10000, now: 200000 }).throttle, false);

  // Health inspection
  const danger = await inspectSaveHealth({
    summaries: Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, payload_encoding: null, estimated_bytes: 2e6 })),
    quota: { usage: 900e6, quota: 1000e6 },
    persisted: false
  });
  assert.equal(danger.level, 'danger');
  assert.equal(danger.reasons.length >= 2, true);
});

await test('streamParseSaveJson parses v2 chunks/nodes incrementally and verifies payload digest', async () => {
  const payload = {
    export_version: '2.0',
    include_archive: true,
    meta: { key: 'root', value: { root_id: 'n1', current_id: 'n1', active_branch: 'branch_main', total_nodes: 1 } },
    branches: [{ id: 'branch_main', head_node_id: 'n1' }],
    chunks: { abc: { encoding: 'raw', rawBytes: 2, data: 'e30=' } },
    nodes: [{ id: 'n1', payload_encoding: 'shared-json-v1', payload: { chunks: ['abc'], byteLength: 2, checksum: 'x'.repeat(64) } }]
  };
  const pkg = {
    schema: SAVE_PACKAGE_SCHEMA_V2,
    kind: 'personal_timeline',
    saved_at: new Date().toISOString(),
    label: 'test',
    payload,
    checksum: { algorithm: 'SHA-256', value: await checksumSaveJson(payload) }
  };
  await validateSavePackage(pkg);

  const seenNodes = [];
  const seenChunks = [];
  const res = await streamParseSaveJson(new Blob([JSON.stringify(pkg)]).stream(), {
    paths: ['$.schema', '$.kind', '$.checksum', '$.payload.chunks.*', '$.payload.nodes.*'],
    digestPayload: true,
    onValue: ({ key, value, stack }) => {
      if (stack.length === 3 && stack[2]?.key === 'chunks') seenChunks.push([key, value]);
      if (stack.length === 3 && stack[2]?.key === 'nodes') seenNodes.push(value);
    }
  });
  assert.equal(res.payloadDigest, pkg.checksum.value);
  assert.equal(seenChunks.length, 1);
  assert.equal(seenNodes.length, 1);

  const unsafeStream = new Blob(['{"payload":{"__proto__":{"polluted":true}}}']).stream();
  await assert.rejects(() => streamParseSaveJson(unsafeStream, { paths: ['$'] }), /不安全字段/);
});

// Part B: Real Chromium Worker + IndexedDB v2 compact roundtrip + recovery.html responsive check
function startStaticServer(rootDir) {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
    const reqPath = new URL(req.url, 'http://127.0.0.1').pathname;
    const rel = reqPath === '/' ? '/index.html' : reqPath;
    const target = path.resolve(rootDir, '.' + rel);
    if (!target.startsWith(rootDir)) { res.writeHead(403).end(); return; }
    try {
      const content = await readFile(target);
      res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404).end('Not Found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolve({ server, url: `http://127.0.0.1:${addr.port}` });
  }));
}

await test('Browser E2E: v2 compact deduplicated export/import, dedup, rollback, and recovery responsive layout', async () => {
  const { server, url } = await startStaticServer(path.resolve(process.cwd(), 'public'));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${url}/recovery.html`, { waitUntil: 'networkidle' });

    const e2e = await page.evaluate(async () => {
      const { stateManager } = await import('/js/core/state-manager.js');
      const { timelineSystem } = await import('/js/systems/timeline-system.js');
      const { timelineStorageTask } = await import('/js/core/timeline-storage-client.js');
      const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
      const { localSaveLibrary, PERSONAL_SAVE_KIND } = await import('/js/core/save-library.js');

      await stateManager.initDB();
      let seedNum = 1337;
      const nextText = (len) => {
        let out = '';
        for (let i = 0; i < len; i++) {
          seedNum = (seedNum * 1664525 + 1013904223) >>> 0;
          out += String.fromCharCode(65 + (seedNum % 26));
        }
        return out;
      };
      const baseLor = { entries: Array.from({ length: 80 }, (_, i) => ({ id: `w_${i}`, title: `木叶条令-${i}`, content: nextText(1100) })) };
      const makeTurnSnap = turn => ({
        _version: '5.0',
        _meta: { current_node_id: `node_${turn}`, active_branch: 'branch_main', turn_count: turn },
        '系统·回合数': turn,
        '玩家·姓名': '漩涡鸣人',
        '世界·地点': '木叶隐村',
        worldbook_blob: baseLor,
        turn_marker: turn
      });

      const nodes = [];
      for (let t = 1; t <= 45; t++) {
        nodes.push({
          id: `node_${t}`,
          parent_id: t === 1 ? null : `node_${t - 1}`,
          children_ids: t === 45 ? [] : [`node_${t + 1}`],
          branch_id: 'branch_main',
          turn_number: t,
          depth: t - 1,
          archived: false,
          archived_at: null,
          summary: `第 ${t} 回合剧情摘要`,
          player_input: `行动 ${t}`,
          clean_response: `第 ${t} 回合正文。\n`.repeat(12),
          chat_history_delta: [{ role: 'user', content: `行动 ${t}` }, { role: 'assistant', content: `第 ${t} 回合回复` }],
          continuity_delta: [],
          state_snapshot: makeTurnSnap(t),
          created_at: 100000 + t * 1000,
          real_timestamp: 100000 + t * 1000
        });
      }
      await stateManager.dbReplaceTimeline({
        nodes,
        branches: [{ id: 'branch_main', name: '主线', head_node_id: 'node_45', diverged_from: null, node_count: 45, is_active: true, color: '#d48259' }],
        meta: { key: 'root', value: { root_id: 'node_1', current_id: 'node_45', active_branch: 'branch_main', total_nodes: 45 } }
      });

      // Test Worker cold compression
      const coldRes = await timelineSystem._compressColdNodes();
      // 45 nodes total, keep hot window 20 -> 25 compressed cold nodes!
      const summaries = await timelineSystem.getNodeSummaries();
      const compressedCount = summaries.filter(s => s.payload_encoding === 'shared-json-v1').length;

      // Capture archive & export v1 vs v2
      const captured = await personalSaveLibrary.capture({ label: '实测长档', reason: 'manual' });
      const v1Export = await timelineStorageTask('export', { id: captured.id, formatVersion: 1 });
      const v2Export = await timelineStorageTask('export', { id: captured.id, formatVersion: 2 });

      // Import v2 + import v1 of the SAME timeline -> must deduplicate cleanly and roundtrip!
      const impV2 = await personalSaveLibrary.importFile(new File([v2Export.blob], 'save.v2.json.gz', { type: v2Export.mimeType }));
      const impV1 = await personalSaveLibrary.importFile(new File([v1Export.blob], 'save.v1.json.gz', { type: v1Export.mimeType }));

      // Tampered checksum rollback check
      const badJson = new Blob([JSON.stringify({ schema: 'naruto.save-package/v2', kind: 'personal_timeline', payload: { nodes: [] }, checksum: { algorithm: 'SHA-256', value: '0'.repeat(64) } })]);
      let tamperedRejected = false;
      try { await personalSaveLibrary.importFile(badJson); } catch { tamperedRejected = true; }

      const allEntries = await localSaveLibrary.list(PERSONAL_SAVE_KIND);
      // Restore imported v2 and verify turn count & worldbook intact
      const restoredCurrent = await personalSaveLibrary.load(impV2.id);

      // Test auto-maintain pruning excess before-* backups
      for (let k = 0; k < 7; k++) {
        await stateManager.dbMutateTimeline(() => ({ meta: { key: 'archive-revision', value: `rev-${k}` } }));
        await timelineStorageTask('capture', { label: `auto-${k}`, reason: 'before-load' });
      }
      const maint = await timelineStorageTask('auto-maintain', { keepAutoBackups: 5 });

      return {
        coldCompressed: coldRes.compressed,
        compressedCount,
        v1Bytes: v1Export.blob.size,
        v2Bytes: v2Export.blob.size,
        impV2Id: impV2.id,
        impV1Id: impV1.id,
        deduped: impV1.id === impV2.id,
        tamperedRejected,
        entriesCount: allEntries.length,
        restoredTurn: restoredCurrent.turn_number,
        prunedAutoBackups: maint.prunedArchives
      };
    });

    assert.equal(e2e.compressedCount, 25);
    assert.ok(e2e.v2Bytes < e2e.v1Bytes, `expected v2 (${e2e.v2Bytes}) < v1 (${e2e.v1Bytes})`);
    assert.equal(e2e.deduped, true);
    assert.equal(e2e.tamperedRejected, true);
    assert.equal(e2e.entriesCount, 2); // captured + imported(deduped across v1/v2)
    assert.equal(e2e.restoredTurn, 45);
    assert.ok(e2e.prunedAutoBackups >= 2);

    // Check recovery.html responsive zero horizontal overflow at 320, 390, 768
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth
      }));
      assert.ok(overflow.scrollW <= overflow.clientW, `recovery.html overflows horizontally at ${width}px: ${overflow.scrollW} > ${overflow.clientW}`);
    }

    // Check index.html boot watchdog banner trigger after 2 interrupted starts + reset
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seed_done')) {
        localStorage.setItem('naruto_boot_watchdog_v1', JSON.stringify({ attempts: 1, lastStartAt: Date.now() - 1000, lastHealthyAt: 0 }));
        sessionStorage.setItem('seed_done', '1');
      }
    });
    await page.goto(`${url}/index.html`, { waitUntil: 'domcontentloaded' });
    const watchdogUi = await page.evaluate(() => ({
      text: document.getElementById('boot-recovery')?.textContent || '',
      state: JSON.parse(localStorage.getItem('naruto_boot_watchdog_v1') || '{}')
    }));
    assert.match(watchdogUi.text, /连续启动异常/);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

console.log(`Save crash hardening regression passed (${passed} tests).`);
