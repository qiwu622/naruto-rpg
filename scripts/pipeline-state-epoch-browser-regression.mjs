import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8">');
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('outside');
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/plain' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let passed = 0;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.goto(origin);
  await page.evaluate(async () => {
    localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
    localStorage.setItem('naruto_memory_config', JSON.stringify({ recallEnabled: false }));
    localStorage.setItem('naruto_api_config', JSON.stringify({ backend: 'tavern', model: 'epoch-fixture', disableStreaming: true,
      aiCallPolicy: { strictSingleCall: false }, variableUpdater: { enabled: true, model: 'epoch-fixture' }, narrativeReview: { enabled: false } }));
    const [{ MessagePipeline }, { stateManager }, { timelineSystem }, { memorySystem }, { aiClient }, { eventBus }] = await Promise.all([
      import('/js/core/pipeline.js'), import('/js/core/state-manager.js'), import('/js/systems/timeline-system.js'),
      import('/js/systems/memory-system.js'), import('/js/core/ai-client.js'), import('/js/core/event-bus.js')
    ]);
    Object.assign(window, { MessagePipeline, stateManager, timelineSystem, memorySystem, aiClient, eventBus });
    await stateManager.initDB();
    timelineSystem._maybeArchive = async () => {};
    aiClient.configure({ backend: 'tavern', model: 'epoch-fixture' });
    window.makeState = (name, turn = 7) => {
      const state = stateManager.getDefaultState();
      Object.assign(state, { '玩家·姓名': name, '玩家·存活': '是', '玩家·忍阶': '下忍', '系统·回合数': turn,
        '世界·地点': '训练场', '世界·时间': '木叶48年1月1日', '属性·生命力': 250, '属性·当前生命力': 250,
        '属性·查克拉': 120, '属性·当前查克拉': 120, '属性·体力': 120, '属性·当前体力': 120,
        '属性·精神力': 80, '属性·当前精神力': 80 });
      state._ui.settings.tacticalCombat = false;
      return state;
    };
    window.prepare = async ({ initial = false, compressed = false } = {}) => {
      for (const store of ['timeline_nodes', 'timeline_branches', 'timeline_meta']) await stateManager.dbClear(store);
      stateManager.state = makeState('旧存档玩家'); stateManager._stateVersion++; stateManager._apiConfigCache = null;
      timelineSystem._nodeCache.clear(); timelineSystem._pendingBranchFrom = null;
      let parent = null;
      if (!initial) {
        parent = await timelineSystem.createRootNode({ summary: '旧存档开场', stateSnapshot: stateManager.snapshot(), chatHistory: [] });
        if (compressed) {
          const { compressTimelineNode } = await import('/js/core/timeline-node-codec.js');
          const stored = await compressTimelineNode(parent);
          await stateManager.dbPut('timeline_nodes', stored);
        }
      }
      const pipeline = new MessagePipeline({ memorySystem, timelineSystem });
      pipeline.setHistory([{ role: 'assistant', content: '旧存档历史' }]);
      window.generateRaw = async () => '你整理好训练器材，在树荫下休息。';
      pipeline._runSecondaryVariableUpdate = async () => ({ output: '<memory>{"facts":["旧回合的事实"]}</memory>' });
      return { pipeline, parent };
    };
  });

  for (const mode of ['hydrate-read', 'mutator', 'queued-writes', 'initial-writes', 'compressed-hydration', 'after-commit', 'initial-after-commit']) {
    const outcome = await page.evaluate(async mode => {
      const initial = mode.startsWith('initial-');
      const { pipeline, parent } = await prepare({ initial, compressed: mode === 'compressed-hydration' });
      const dbGet = stateManager.dbGet, dbMutate = stateManager.dbMutateTimeline, nativePut = IDBObjectStore.prototype.put;
      const beforeCount = (await stateManager.dbGetAll('timeline_nodes')).length;
      const oldRoot = await stateManager.dbGet('timeline_meta', 'root');
      const oldParent = parent && await stateManager.dbGet('timeline_nodes', parent.id);
      let selected = null;
      let mutationCalls = 0;
      let guardSeen = false;
      const published = [];
      const stops = ['timeline:node-created', 'pipeline:complete', 'turn:committed', 'pipeline:error']
        .map(event => eventBus.on(event, () => published.push(event)));
      const selectNew = () => {
        if (selected) return;
        const state = makeState('新存档玩家', 40);
        state._meta.current_node_id = 'new-save-node'; state._meta.active_branch = 'new-save-branch';
        stateManager.restore(state);
        pipeline.setHistory([{ role: 'assistant', content: '新存档历史' }]);
        selected = { state: JSON.stringify(stateManager.snapshot()), history: JSON.stringify(pipeline.getHistory()) };
      };
      if (mode === 'hydrate-read') {
        stateManager.dbGet = async function(store, id) {
          const value = await dbGet.call(this, store, id);
          if (store === 'timeline_nodes' && id === parent.id) selectNew();
          return value;
        };
      }
      stateManager.dbMutateTimeline = async function(mutator, options) {
        mutationCalls++;
        guardSeen ||= typeof options?.validateCurrent === 'function';
        const result = await dbMutate.call(this, data => {
          const mutation = mutator(data);
          if (mode === 'mutator' || mode === 'compressed-hydration') selectNew();
          return mutation;
        }, options);
        if (mode.endsWith('after-commit')) selectNew();
        return result;
      };
      if (mode === 'queued-writes' || mode === 'initial-writes') {
        let scheduled = false;
        IDBObjectStore.prototype.put = function(value, ...args) {
          const request = nativePut.call(this, value, ...args);
          if (!scheduled && this.name === 'timeline_nodes' && value.id !== parent?.id) {
            scheduled = true;
            queueMicrotask(selectNew);
          }
          return request;
        };
      }
      let result;
      try { result = await pipeline.process('整理训练器材'); }
      finally {
        stateManager.dbGet = dbGet; stateManager.dbMutateTimeline = dbMutate;
        IDBObjectStore.prototype.put = nativePut; stops.forEach(stop => stop());
      }
      const afterNodes = await stateManager.dbGetAll('timeline_nodes');
      const nowRoot = await stateManager.dbGet('timeline_meta', 'root');
      const storedParent = parent && await stateManager.dbGet('timeline_nodes', parent.id);
      return { result, selected: Boolean(selected), unchanged: selected?.state === JSON.stringify(stateManager.snapshot()),
        historyUnchanged: selected?.history === JSON.stringify(pipeline.getHistory()), beforeCount, afterCount: afterNodes.length,
        sameRoot: JSON.stringify(nowRoot) === JSON.stringify(oldRoot), published, mutationCalls, guardSeen,
        sameParent: JSON.stringify(storedParent) === JSON.stringify(oldParent) };
    }, mode);
    assert.ok(outcome.selected, `${mode}: test must reach its switch point`);
    assert.deepEqual(outcome.result, { cancelled: true, contextChanged: true, partialResponse: '' });
    assert.ok(outcome.unchanged, `${mode}: selected live state is preserved`);
    assert.ok(outcome.historyUnchanged, `${mode}: selected history is preserved`);
    assert.deepEqual(outcome.published, [], `${mode}: no old completion or retry is published in the new save`);
    if (mode.endsWith('after-commit')) {
      assert.equal(outcome.afterCount, outcome.beforeCount + 1, 'already durable source turn remains saved without moving the newly selected runtime');
    } else {
      assert.equal(outcome.afterCount, outcome.beforeCount, `${mode}: aborted transaction leaves no node`);
      assert.ok(outcome.sameRoot, `${mode}: aborted transaction leaves the database root unchanged`);
      assert.ok(outcome.sameParent, `${mode}: aborted transaction leaves the parent and its compressed payload unchanged`);
    }
    if (mode === 'hydrate-read') assert.equal(outcome.mutationCalls, 0);
    else assert.ok(outcome.guardSeen, `${mode}: the validator reaches the real transaction`);
    passed++;
    console.log(`PASS real IndexedDB ${mode} preserves the selected save and ${mode.endsWith('after-commit') ? 'the already durable source node' : 'aborts obsolete writes'}`);
  }

  const ordinary = await page.evaluate(async () => {
    const { pipeline } = await prepare();
    const result = await pipeline.process('整理训练器材');
    return { id: result.timelineNodeId, current: stateManager.getSub('_meta').current_node_id,
      nodes: (await stateManager.dbGetAll('timeline_nodes')).length, turn: stateManager.get('系统·回合数') };
  });
  assert.ok(ordinary.id); assert.equal(ordinary.current, ordinary.id); assert.equal(ordinary.nodes, 2); assert.equal(ordinary.turn, 8);
  passed++;
  console.log('PASS normal real IndexedDB commit still advances state, history and timeline');
  console.log(`Pipeline state epoch browser regression: ${passed} passed.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
