import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';

const app = express();
app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8">'));
app.use(express.static(process.cwd()));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async fixture => {
    const { stateManager: sm } = await import('/js/core/state-manager.js');
    const { timelineStorageTask: task } = await import('/js/core/timeline-storage-client.js');
    const { createContinuationArchive, runArchiveTask } = await import('/js/core/timeline-archive.js');
    const { compressTimelineNode } = await import('/js/core/timeline-node-codec.js');
    const { decodeTimelineSaveFile } = await import('/js/core/timeline-file-codec.js');
    const { validateSavePackage } = await import('/js/core/save-library.js');
    const { buildContinuationCopy } = await import('/js/core/continuation-save.js');
    const { assertTimelineSave } = await import('/js/core/timeline-save-schema.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    // A real IF anchor shares a turn number with its parent and must not use
    // another slot in the player's chosen retained-turn count.
    const parent = fixture.nodes.at(-1);
    const anchor = { ...structuredClone(parent), id: 'anchor', parent_id: parent.id,
      depth: parent.depth + 1, children_ids: [], branch_anchor: true,
      continuity_delta: [], chat_history_delta: [], chat_history: parent.chat_history_delta };
    anchor.state_snapshot._meta.current_node_id = anchor.id;
    parent.children_ids.push(anchor.id); fixture.nodes.push(anchor);
    fixture.branches[1].head_node_id = anchor.id; fixture.branches[1].node_count++;
    fixture.meta.value.current_id = anchor.id; fixture.meta.value.total_nodes++;
    assertTimelineSave(fixture);
    const expected = buildContinuationCopy(fixture, { keepTurns: 225 });
    for (let index = 0; index < fixture.nodes.length - 20; index++) fixture.nodes[index] = await compressTimelineNode(fixture.nodes[index]);
    await sm.initDB(); await sm.dbReplaceTimeline(fixture);
    const original = await task('capture', { label: '完整原档与 IF' });
    const count = store => new Promise((resolve, reject) => {
      const tx = sm._db.transaction(store), request = tx.objectStore(store).count();
      tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error);
    });
    const fingerprint = store => new Promise((resolve, reject) => {
      const digest = globalThis.NarutoSaveCodec.sha256.create(), encoder = new TextEncoder();
      const tx = sm._db.transaction(store), request = tx.objectStore(store).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { digest.update(encoder.encode(JSON.stringify(cursor.value))); cursor.continue(); }
      };
      tx.oncomplete = () => { const hash = Array.from(digest.digest()).join(','); digest.destroy(); resolve(hash); };
      tx.onabort = () => { digest.destroy(); reject(tx.error); };
    });
    const originalWorking = await fingerprint('timeline_nodes');
    const originalMeta = JSON.stringify(await sm.dbGet('timeline_meta', 'root'));
    let fullReads = 0;
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function(...args) {
      if (['timeline_nodes', 'timeline_archive_nodes'].includes(this.name)) fullReads++;
      return getAll.apply(this, args);
    };
    const defaults = await task('create-continuation', { id: original.id });
    check(defaults.continuation.retained_turns === 100 && defaults.nodeCount === 101, 'default 100 or same-turn IF anchor changed');
    const large = await task('create-continuation', { id: original.id, keepTurns: 225 });
    check(large.nodeCount === 226 && large.continuation.from_turn === 36 && large.continuation.retained_turns === 225, '225-turn copy was capped');
    const exported = await task('export', { id: large.id });
    const actual = (await validateSavePackage(await decodeTimelineSaveFile(exported.blob))).payload;
    assertTimelineSave(actual);
    const byId = new Map(actual.nodes.map(node => [node.id, node]));
    for (const old of expected.nodes) {
      const node = byId.get(old.id);
      for (const key of ['state_snapshot', 'parent_id', 'children_ids', 'branch_id', 'depth',
        'clean_response', 'shinobi_daily', 'media', 'chat_history_delta', 'continuity_delta', 'continuity_revision']) {
        check(JSON.stringify(node[key]) === JSON.stringify(old[key]), `${old.id}.${key} changed in incremental extraction`);
      }
    }
    check(actual.nodes.filter(node => node.archived).length === 206, 'old copy records not compressed');
    const all = await task('create-continuation', { id: original.id, keepTurns: 9999 });
    check(all.nodeCount === 261 && all.continuation.retained_turns === 260, 'larger requested size did not use all available selected-route turns');
    const before = { records: await count('timeline_archive_nodes'), entries: await count('timeline_archives'), hash: await fingerprint('timeline_archive_nodes') };
    const preserved = async label => {
      check(await count('timeline_archive_nodes') === before.records && await count('timeline_archives') === before.entries, `${label} left partial archive records`);
      check(await fingerprint('timeline_archive_nodes') === before.hash, `${label} changed original archive bytes`);
      check(await fingerprint('timeline_nodes') === originalWorking, `${label} changed working nodes`);
      check(JSON.stringify(await sm.dbGet('timeline_meta', 'root')) === originalMeta, `${label} changed play position`);
    };
    const abort = new AbortController();
    let cancelled = false, progressCount = 0;
    try {
      await task('create-continuation', { id: original.id, keepTurns: 225 }, {
        signal: abort.signal, onProgress: text => { if (text.startsWith('正在保存续玩副本') && ++progressCount === 5) abort.abort(); }
      });
    } catch (error) { cancelled = error.name === 'AbortError'; }
    check(cancelled && progressCount >= 5, 'worker cancellation was not exercised mid-write');
    await preserved('cancellation');
    let quota = false, hiddenWhileWriting = false, added = 0;
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(...args) {
      if (this.name === 'timeline_archive_nodes' && ++added === 5) throw new DOMException('synthetic copy quota', 'QuotaExceededError');
      return add.apply(this, args);
    };
    let listing;
    try {
      await createContinuationArchive(sm._db, original, { keepTurns: 225 }, { onProgress: text => {
        if (text.startsWith('正在保存续玩副本') && !listing) listing = runArchiveTask(sm._db, 'list').then(entries => { hiddenWhileWriting = entries.length === before.entries; });
      } });
    } catch (error) { quota = error.message.includes('空间不足'); }
    finally { IDBObjectStore.prototype.add = add; }
    await listing;
    check(quota && hiddenWhileWriting, 'quota failure or hidden staging copy was not verified');
    await preserved('quota');
    const put = IDBObjectStore.prototype.put;
    let publishFailed = false;
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'timeline_archives' && args[0].complete) throw new DOMException('synthetic final publish quota', 'QuotaExceededError');
      return put.apply(this, args);
    };
    try { await createContinuationArchive(sm._db, original, { keepTurns: 5 }); }
    catch (error) { publishFailed = error.message.includes('空间不足'); }
    finally { IDBObjectStore.prototype.put = put; }
    check(publishFailed, 'final publish failure did not surface');
    await preserved('final publish failure');
    for (const keepTurns of [0, -1, 1.5, Infinity]) {
      let rejected = false;
      try { await createContinuationArchive(sm._db, original, { keepTurns }); } catch (error) { rejected = error.message.includes('整数'); }
      check(rejected, `invalid count ${keepTurns} was accepted`);
    }
    await preserved('invalid count');
    check(fullReads === 0, 'continuation path materialized full node stores');
    return { originalNodes: original.nodeCount, defaultNodes: defaults.nodeCount, largeNodes: large.nodeCount,
      allNodes: all.nodeCount, cancelled, quota, publishFailed, hiddenWhileWriting, fullReads };
  }, makeContinuationFixture(260));
  assert.deepEqual(errors, []);
  console.log(result);
  console.log('PASS incremental 100/225/all-turn IF copies, per-turn state/daily/media/chat equality, compression, gzip roundtrip, hidden staging, mid-copy cancellation/quota cleanup, byte-exact original preservation');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
