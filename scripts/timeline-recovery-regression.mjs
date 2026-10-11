import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';
import { mkdir } from 'node:fs/promises';

const app = express();
app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8">'));
app.use(express.static(process.cwd()));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async fixture => {
    const { stateManager: sm } = await import('/js/core/state-manager.js');
    const { timelineStorageTask: task } = await import('/js/core/timeline-storage-client.js');
    const { captureTimelineArchive, runArchiveTask } = await import('/js/core/timeline-archive.js');
    const { decompressTimelineNode, compressTimelineNode } = await import('/js/core/timeline-node-codec.js');
    const { decodeTimelineSaveFile } = await import('/js/core/timeline-file-codec.js');
    const { validateSavePackage, localSaveLibrary } = await import('/js/core/save-library.js');
    const { assertTimelineSave } = await import('/js/core/timeline-save-schema.js');
    await sm.initDB();
    for (let i = 0; i < fixture.nodes.length - 4; i++) fixture.nodes[i] = await compressTimelineNode(fixture.nodes[i]);
    await sm.dbReplaceTimeline(fixture);
    const count = store => new Promise(resolve => { const r = sm._db.transaction(store).objectStore(store).count(); r.onsuccess = () => resolve(r.result); });
    const original = await sm.dbGet('timeline_nodes', 'main_1');
    const revision = await sm.dbGet('timeline_meta', 'archive-revision');
    const originalPut = IDBObjectStore.prototype.put;
    let summaryFailed = false;
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'timeline_summaries') throw new DOMException('synthetic summary quota failure', 'QuotaExceededError');
      return originalPut.apply(this, args);
    };
    try { await sm.dbPut('timeline_nodes', { ...original, summary: 'must roll back' }); }
    catch { summaryFailed = true; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    if (!summaryFailed || JSON.stringify(await sm.dbGet('timeline_nodes', 'main_1')) !== JSON.stringify(original)
      || (await sm.dbGet('timeline_meta', 'archive-revision')).value !== revision.value) throw new Error('summary failure left a partially committed node');
    const abort = new AbortController();
    let cancelled = false;
    try { await captureTimelineArchive(sm._db, { reset: true }, { signal: abort.signal, onProgress: () => abort.abort() }); }
    catch (error) { cancelled = error.name === 'AbortError'; }
    if (!cancelled || await count('timeline_nodes') !== fixture.nodes.length || await count('timeline_archives') !== 0 || await count('timeline_archive_nodes') !== 0) throw new Error('cancel did not roll back all backup writes');
    const put = IDBObjectStore.prototype.add;
    let writes = 0, failed = false;
    IDBObjectStore.prototype.add = function(...args) {
      if (this.name === 'timeline_archive_nodes' && ++writes === 25) throw new DOMException('synthetic quota failure', 'QuotaExceededError');
      return put.apply(this, args);
    };
    try { await captureTimelineArchive(sm._db, { reset: true }); } catch { failed = true; }
    finally { IDBObjectStore.prototype.add = put; }
    if (!failed || await count('timeline_nodes') !== fixture.nodes.length || await count('timeline_archive_nodes') !== 0) throw new Error('quota did not preserve original');
    const entry = await task('capture', { label: '原始 IF 档' });
    const raw = await sm.dbGet('timeline_archive_nodes', [entry.id, 'main_1']);
    if (JSON.stringify(raw.node) !== JSON.stringify(original)) throw new Error('raw original changed');
    const encoded = await task('export', { id: entry.id });
    const pack = await validateSavePackage(await decodeTimelineSaveFile(encoded.blob));
    assertTimelineSave(pack.payload);
    if (pack.payload.nodes.length !== fixture.nodes.length || pack.payload.branches.length !== 2) throw new Error('export omitted history');
    let concurrentWrite, exportRejected = false, exportError;
    try {
      await runArchiveTask(sm._db, 'export-current', {}, { onProgress: () => {
        concurrentWrite ||= sm.dbPut('timeline_nodes', { ...original, summary: '导出期间继续游玩' });
      } });
    } catch (error) { exportError = error.message; exportRejected = error.message.includes('导出期间存档发生变化'); }
    await concurrentWrite;
    if (!exportRejected || (await sm.dbGet('timeline_nodes', 'main_1')).summary !== '导出期间继续游玩') throw new Error(`concurrent export mixed revisions or overwrote current progress: ${exportError}`);
    await sm.dbPut('timeline_nodes', original);
    const continuation = await task('create-continuation', { id: entry.id, keepTurns: 10 });
    const copy = (await validateSavePackage(await decodeTimelineSaveFile((await task('export', { id: continuation.id })).blob))).payload;
    assertTimelineSave(copy);
    if (copy.nodes.length !== 10 || copy.nodes.at(-1).state_snapshot.marker !== 'IF120' || copy.nodes[0].state_snapshot.marker !== 'IF111') throw new Error('continuation mixed historical state');
    if (copy.nodes[0].state_snapshot._continuity.events.some(event => event.value === '主线120')) throw new Error('future mainline leaked');
    const originalCount = await count('timeline_nodes');
    await task('capture', { reset: true, reason: 'before-new-game' });
    if (await count('timeline_nodes') !== 0) throw new Error('reset did not switch');
    await task('restore', { id: entry.id });
    if (await count('timeline_nodes') !== originalCount) throw new Error('restore omitted original');
    const rescued = await task('rescue', { id: entry.id, keepTurns: 10 });
    if (await count('timeline_nodes') !== 10 || (await task('get', { id: entry.id })).nodeCount !== originalCount) throw new Error('rescue destroyed old archive');
    const library = await localSaveLibrary.list('personal_timeline');
    if (!library.some(item => item.id === entry.id) || !library.some(item => item.id === rescued.id)) throw new Error('rescue not visible in library');
    const badHead = await sm.dbGet('timeline_nodes', 'if_120');
    await sm.dbPut('timeline_nodes', { ...badHead, state_snapshot: null, payload_encoding: 'gzip-json-v1', payload: new Uint8Array([1, 2, 3]) });
    const damaged = await task('capture', { label: '损坏顶部，原样备份' });
    let invalid = false;
    try { await task('preview', { id: damaged.id }); } catch { invalid = true; }
    if (!invalid) throw new Error('invalid head unexpectedly restored');
    await task('rescue', { id: damaged.id, nodeId: 'if_119', keepTurns: 1 });
    if (await count('timeline_nodes') !== 1 || (await task('get', { id: damaged.id })).nodeCount !== 10) throw new Error('earlier checkpoint recovery lost damaged original');
    return { originalCount, exportedCount: pack.payload.nodes.length, rescuedCount: await count('timeline_nodes'), libraryCount: library.length, cancelled, quotaPreserved: failed, summaryRollback: summaryFailed, concurrentExportRejected: exportRejected };
  }, makeContinuationFixture(120));
  console.log(result);
  assert.equal(result.cancelled, true); assert.equal(result.quotaPreserved, true);
  await page.goto(`http://127.0.0.1:${server.address().port}/recovery.html`);
  await page.getByText('原始 IF 档', { exact: true }).waitFor();
  assert.ok(await page.locator('.archive').count() >= 2);
  assert.equal(await page.evaluate(() => Boolean(window.__NARUTO_APP__)), false);
  const originalCard = page.locator('.archive').filter({ has: page.getByRole('heading', { name: '原始 IF 档', exact: true }) });
  await originalCard.getByRole('button', { name: '选择其他恢复点' }).click();
  await originalCard.getByRole('combobox', { name: '恢复回合' }).waitFor();
  assert.equal(await originalCard.locator('option').count(), 30);
  await originalCard.getByRole('combobox', { name: '恢复回合' }).selectOption('if_119');
  await mkdir('reports/large-save-rescue', { recursive: true });
  await page.screenshot({ path: 'reports/large-save-rescue/recovery-desktop.png', fullPage: true });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px recovery overflow`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'reports/large-save-rescue/recovery-mobile.png', fullPage: true });
  console.log('PASS cancel/quota atomic rollback, raw preservation, gzip checksum roundtrip, branch-scoped continuation, restore, independent rescue UI');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
