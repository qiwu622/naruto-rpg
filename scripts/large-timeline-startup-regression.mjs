import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const turns = Number(process.env.SAVE_STRESS_TURNS || 1650);
const padding = Number(process.env.SAVE_STRESS_PADDING || 1000);
const legacy = process.env.SAVE_STRESS_LEGACY === '1';
const keepTurns = Number(process.env.SAVE_STRESS_KEEP_TURNS || 10);

const serverApp = express();
serverApp.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><main id="app"></main>'));
serverApp.use(express.static(process.cwd()));
const server = await new Promise(resolve => { const s = serverApp.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.evaluate(async ({ turns, padding, legacy }) => {
    const { stateManager: sm } = await import('/js/core/state-manager.js');
    const base = sm.getDefaultState();
    const nodes = Array.from({ length: turns }, (_, i) => ({
      id: `turn_${String(i + 1).padStart(5, '0')}`, parent_id: i ? `turn_${String(i).padStart(5, '0')}` : null,
      children_ids: i < turns - 1 ? [`turn_${String(i + 2).padStart(5, '0')}`] : [],
      branch_id: 'branch_main', turn_number: i + 1, depth: i, created_at: i + 1,
      clean_response: `第 ${i + 1} 回合正文`, summary: `第 ${i + 1} 回合`,
      chat_history_delta: [{ role: 'user', content: `行动 ${i + 1}` }, { role: 'assistant', content: `正文 ${i + 1}` }],
      state_snapshot: { ...base, '系统·回合数': i + 1, '玩家·姓名': '大档回归',
        _meta: { current_node_id: `turn_${String(i + 1).padStart(5, '0')}`, active_branch: 'branch_main' },
        _large_test_detail: '长期游玩原始记录'.repeat(padding) },
      archived: false, is_checkpoint: false,
    }));
    const data = { nodes,
      branches: [{ id: 'branch_main', name: '主线', color: '#eb613f', head_node_id: `turn_${String(turns).padStart(5, '0')}`, node_count: turns, is_active: true }],
      meta: { key: 'root', value: { root_id: 'turn_00001', current_id: `turn_${String(turns).padStart(5, '0')}`, active_branch: 'branch_main', total_nodes: turns } },
    };
    if (legacy) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('naruto_rpg', 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('timeline_nodes', { keyPath: 'id' });
          for (const key of ['parent_id', 'branch_id', 'turn_number', 'real_timestamp']) store.createIndex(key, key);
          request.result.createObjectStore('timeline_branches', { keyPath: 'id' });
          request.result.createObjectStore('timeline_meta', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['timeline_nodes', 'timeline_branches', 'timeline_meta'], 'readwrite');
        for (const node of data.nodes) tx.objectStore('timeline_nodes').put(node);
        for (const branch of data.branches) tx.objectStore('timeline_branches').put(branch);
        tx.objectStore('timeline_meta').put(data.meta);
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
      db.close();
    } else { await sm.initDB(); await sm.dbReplaceTimeline(data); }
  }, { turns, padding, legacy });
  await page.reload();
  const profiler = await page.context().newCDPSession(page);
  await profiler.send('HeapProfiler.collectGarbage');
  const profileStartup = process.env.SAVE_STRESS_PROFILE === '1';
  if (profileStartup) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
  const result = await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { NarutoRPGApp } = await import('/js/app.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    const { MessagePipeline } = await import('/js/core/pipeline.js');
    const reads = [];
    const original = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function(...args) {
      if (this.name === 'timeline_nodes') reads.push({ count: args[1] ?? null });
      return original.apply(this, args);
    };
    let maxLag = 0, tick = performance.now(), peakHeap = 0;
    const sample = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - tick - 25); tick = now; peakHeap = Math.max(peakHeap, performance.memory?.usedJSHeapSize || 0); }, 25);
    const start = performance.now();
    await stateManager.initDB();
    stateManager.state._ui.settings.autoArchive = false;
    appShell.init(document.querySelector('#app'));
    await timelineSystem.init();
    const app = new NarutoRPGApp();
    app.pipeline = new MessagePipeline({ timelineSystem });
    app._bindEvents();
    await app._checkSavedGame();
    await new Promise(resolve => setTimeout(resolve, 200));
    clearInterval(sample);
    return { reads, maxLag, peakHeap, elapsedMs: performance.now() - start,
      heapBytes: performance.memory?.usedJSHeapSize,
      turn: stateManager.get('系统·回合数'),
      text: document.querySelector('#app').textContent,
      nodes: await new Promise(resolve => { const r = stateManager._db.transaction('timeline_nodes').objectStore('timeline_nodes').count(); r.onsuccess = () => resolve(r.result); }) };
  });
  console.log(JSON.stringify({ ...result, text: result.text.slice(-80) }));
  if (profileStartup) {
    const { profile } = await profiler.send('Profiler.stop');
    await mkdir('reports/large-save-rescue', { recursive: true });
    await writeFile('reports/large-save-rescue/startup.cpuprofile', JSON.stringify(profile));
    console.log(profile.nodes.filter(node => node.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 15).map(node => ({ hits: node.hitCount, ...node.callFrame })));
  }
  await profiler.detach();
  assert.equal(result.turn, turns);
  assert.equal(result.nodes, turns, 'startup must preserve all original nodes');
  assert.equal(result.reads.filter(read => read.count == null).length, 0, 'startup and timeline UI must not materialize the entire archive');
  const recovery = await page.evaluate(async keepTurns => {
    const { timelineStorageTask: task } = await import('/js/core/timeline-storage-client.js');
    let tick = performance.now(), maxLag = 0, peakHeap = 0;
    const sample = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - tick - 25); tick = now; peakHeap = Math.max(peakHeap, performance.memory?.usedJSHeapSize || 0); }, 25);
    const start = performance.now();
    const original = await task('capture', { reason: 'stress-backup' });
    const exported = await task('export-current');
    const copy = await task('rescue', { id: original.id, keepTurns });
    clearInterval(sample);
    return { elapsedMs: performance.now() - start, maxLag, peakHeap, originalNodes: original.nodeCount, copyNodes: copy.nodeCount, gzipBytes: exported.blob.size };
  }, keepTurns);
  assert.equal(recovery.originalNodes, turns); assert.equal(recovery.copyNodes, Math.min(turns, keepTurns));
  await mkdir('reports/large-save-rescue', { recursive: true });
  await writeFile(`reports/large-save-rescue/${turns}-${legacy ? 'legacy' : 'indexed'}${keepTurns === 10 ? '' : `-keep${keepTurns}`}.json`, JSON.stringify({ turns, padding, legacy, keepTurns, startup: { ...result, text: undefined }, recovery }, null, 2));
  console.log(JSON.stringify({ recovery }));
  console.log(`PASS ${turns}-turn real browser startup, backup, export and rescue preserve original data without unbounded timeline reads`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
