import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const app = express();
app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8">'));
app.use(express.static(process.cwd()));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const fixture = makeContinuationFixture(80);
  // Nontrivial repeated state, growing arrays, Unicode and boundary edits.
  const history = Array.from({ length: 800 }, (_, i) => `约定${i}：${Math.imul(i + 1, 2654435761) >>> 0}，必须保留的历史细节。`);
  for (const node of fixture.nodes) {
    node.state_snapshot._memory.archived = history.join('\n');
    node.state_snapshot._memory.facts += `\n本回合 ${node.id}`;
    node.chat_history = [{ role: 'system', content: history.join('\n') }, ...node.chat_history_delta];
    node.maintenance = { type: 'memory', before_state_snapshot: structuredClone(node.state_snapshot) };
  }
  const result = await page.evaluate(async fixture => {
    const { stateManager: sm } = await import('/js/core/state-manager.js');
    const { timelineSystem: timeline } = await import('/js/systems/timeline-system.js');
    const { timelineStorageTask: task } = await import('/js/core/timeline-storage-client.js');
    const { runArchiveTask } = await import('/js/core/timeline-archive.js');
    const { compressTimelineNode, decompressTimelineNode, prepareSharedTimelineNode } = await import('/js/core/timeline-node-codec.js');
    const { PAYLOAD_CHUNK_STORE, putPayloadChunks, payloadChunkIds } = await import('/js/core/timeline-payload-chunks.js');
    const { decodeTimelineSaveFile } = await import('/js/core/timeline-file-codec.js');
    const { validateSavePackage, localSaveLibrary } = await import('/js/core/save-library.js');
    const { checksumSaveJson } = await import('/js/core/save-json-stream.js');
    const { assertTimelineSave } = await import('/js/core/timeline-save-schema.js');
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    for (let i = 0; i < fixture.nodes.length - 20; i++) fixture.nodes[i] = await compressTimelineNode(fixture.nodes[i]);
    let beforeUpgrade;
    // Upgrade an existing v2 database without rewriting any of its records.
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('naruto_rpg', 2);
      request.onupgradeneeded = () => { const db = request.result;
        for (const [name, keyPath] of [['timeline_nodes','id'],['timeline_branches','id'],['timeline_meta','key'],['timeline_summaries','id'],['timeline_archives','id'],['timeline_archive_nodes',['archiveId','id']]]) {
          const store = db.createObjectStore(name, { keyPath });
          if (name === 'timeline_archive_nodes') store.createIndex('archiveId', 'archiveId');
        }
      };
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['timeline_nodes', 'timeline_branches', 'timeline_meta'], 'readwrite');
        fixture.nodes.forEach(node => tx.objectStore('timeline_nodes').put(node));
        fixture.branches.forEach(branch => tx.objectStore('timeline_branches').put(branch));
        tx.objectStore('timeline_meta').put(fixture.meta);
        const saved = tx.objectStore('timeline_nodes').getAll();
        tx.oncomplete = async () => { db.close(); beforeUpgrade = await checksumSaveJson(saved.result); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      }; request.onerror = () => reject(request.error);
    });
    await sm.initDB(); check(sm.getDB().version === 3, 'database upgrade failed');
    check(await checksumSaveJson(await sm.dbGetAll('timeline_nodes')) === beforeUpgrade, 'v2 upgrade rewrote existing records');
    const source = await task('capture', { label: '原始 IF 档' });
    const exportPack = async id => validateSavePackage(await decodeTimelineSaveFile((await task('export', { id })).blob));
    const original = await exportPack(source.id);
    const rawDigest = await checksumSaveJson(await sm.dbGetAll('timeline_archive_nodes'));
    const currentDigest = await checksumSaveJson(await sm.dbGetAll('timeline_nodes'));
    // Terminate an actual Worker without a cooperative cancel or finally block.
    await new Promise((resolve, reject) => {
      const worker = new Worker('/js/core/timeline-storage-worker.js', { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.error) { worker.terminate(); reject(new Error(data.error.message)); }
        else if (data.progress?.includes('8 /')) { worker.terminate(); resolve(); }
        else if ('result' in data) { worker.terminate(); reject(new Error('worker completed before interruption')); }
      };
      worker.onerror = error => reject(error);
      worker.postMessage({ action: 'compact', options: { id: source.id } });
    });
    const interrupted = await task('storage-stats');
    const job = interrupted.jobs.find(job => job.resumable);
    check(job?.completed === 8, 'interrupted checkpoint missing');
    check(!(await task('list')).some(entry => entry.id === job.id), 'incomplete archive exposed for loading');
    let pinned = false;
    try { await task('remove', { id: source.id }); } catch (error) { pinned = error.message.includes('未完成'); }
    check(pinned, 'source of resumable job could be deleted');
    await task('cleanup'); // Must retain blocks owned by the interrupted job.
    const start = performance.now(); const progress = [];
    const compacted = await task('resume-compaction', { id: job.id }, { onProgress: text => progress.push(text) });
    check(progress[0].includes('9 /'), 'resume restarted from the beginning');
    const elapsed = performance.now() - start;
    const packed = await exportPack(compacted.id);
    assertTimelineSave(packed.payload);
    const difference = (a, b, path = '') => {
      if (a === b) return '';
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return path;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = difference(a[key], b[key], `${path}.${key}`); if (d) return d; }
      return '';
    };
    check(await checksumSaveJson(packed.payload, { canonical: true }) === await checksumSaveJson(original.payload, { canonical: true }), `portable export changed ${difference(packed.payload, original.payload)}`);
    check(await checksumSaveJson(await sm.dbGetAll('timeline_nodes')) === currentDigest, 'compaction changed active game');
    const rawSource = (await sm.dbGetAll('timeline_archive_nodes')).filter(item => item.archiveId === source.id);
    check(await checksumSaveJson(rawSource) === rawDigest, 'compaction changed original archive');
    check(compacted.bytes < source.bytes * 0.65, `dedup reduction too small: ${compacted.bytes} / ${source.bytes}`);
    check((await task('storage-stats')).jobs.length === 0, 'completed task still pending');
    const originalPut = IDBObjectStore.prototype.put;
    let quotaWrites = 0, quotaPaused = false;
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'timeline_archive_nodes' && ++quotaWrites === 3) throw new DOMException('synthetic full disk', 'QuotaExceededError');
      return originalPut.apply(this, args);
    };
    try { await runArchiveTask(sm.getDB(), 'compact', { id: source.id }); }
    catch (error) { quotaPaused = error.message.includes('空间不足'); }
    finally { IDBObjectStore.prototype.put = originalPut; }
    check(quotaPaused, 'quota failure did not leave a resumable task');
    const quotaJob = (await task('storage-stats')).jobs[0];
    check(quotaJob.completed === 2, 'quota checkpoint advanced past uncommitted data');
    await task('discard-job', { id: quotaJob.id });
    // Cancellation leaves a resumable copy. Explicit discard only removes that copy.
    const controller = new AbortController(); let paused = false;
    try { await runArchiveTask(sm.getDB(), 'compact', { id: source.id }, { signal: controller.signal, onProgress: () => controller.abort() }); }
    catch (error) { paused = error.name === 'AbortError'; }
    check(paused, 'cancel did not pause');
    const pausedJob = (await task('storage-stats')).jobs[0];
    await task('discard-job', { id: pausedJob.id });
    let protectedOriginal = false;
    try { await task('discard-job', { id: source.id }); } catch { protectedOriginal = true; }
    check(protectedOriginal, 'cleanup accepted a complete original');
    // A storage transaction failure cannot publish a partial node.
    const prepared = await prepareSharedTimelineNode({ ...fixture.nodes.at(-1), state_snapshot: { ...fixture.nodes.at(-1).state_snapshot, unique: crypto.randomUUID() } });
    const beforeChunks = (await task('storage-stats')).chunkCount;
    await new Promise(resolve => {
      const tx = sm.getDB().transaction(['timeline_nodes', PAYLOAD_CHUNK_STORE], 'readwrite');
      putPayloadChunks(tx, prepared.records); tx.objectStore('timeline_nodes').put({ ...prepared.node, id: 'rollback-node' });
      tx.onabort = resolve; tx.abort();
    });
    check(!await sm.dbGet('timeline_nodes', 'rollback-node') && (await task('storage-stats')).chunkCount === beforeChunks, 'aborted node left chunks behind');
    await timeline.restoreArchive(compacted.id);
    const current = await timeline.getCurrentNode();
    check(current.state_snapshot.marker === 'IF80', 'restore did not resolve shared state');
    const { memorySystem } = await import('/js/systems/memory-system.js');
    check(memorySystem.buildPromptContext(sm.getSub('_memory'), { userInput: '查看约定' }).includes('保留最初的约定'), 'restored memory cannot construct the next turn context');
    const historical = await timeline._hydrateNode(await sm.dbGet('timeline_nodes', 'main_10'));
    check(historical.state_snapshot.marker === '主线10', 'historical shared node cannot be read');
    const history = await timeline._reconstructChatHistory(await sm.dbGet('timeline_nodes', 'main_10'));
    check(await checksumSaveJson(history) === await checksumSaveJson(historical.chat_history), 'shared history anchor lost its captured dialogue');
    await timeline.switchBranch('branch_main');
    check(sm.get().marker === '主线80', 'shared main branch cannot be restored');
    await timeline.switchBranch('branch_if');
    check(sm.get().marker === 'IF80', 'shared IF branch cannot be restored');
    await timeline.manualArchive(); // Hot expansion, subsequent incremental compression.
    const future = await exportPack(source.id);
    check(future.checksum.value === original.checksum.value, 'hot expansion modified original');
    const continuation = await task('create-continuation', { id: compacted.id, keepTurns: 17 });
    const continuationPack = await exportPack(continuation.id); assertTimelineSave(continuationPack.payload);
    check(continuationPack.payload.nodes.length === 17 && continuationPack.payload.nodes.every(node => node.turn_number >= 64), 'continuation from shared storage changed scope');
    // The active game and a second archive must remain readable after deleting
    // the original compact copy and collecting unreferenced chunks.
    await task('remove', { id: compacted.id }); await task('cleanup');
    const live = await task('export-current');
    const livePack = await validateSavePackage(await decodeTimelineSaveFile(live.blob)); assertTimelineSave(livePack.payload);
    check(livePack.payload.nodes.length === fixture.nodes.length, 'garbage collection damaged active timeline');
    // Missing/corrupt chunks fail before a restore, rather than producing a
    // plausible but incomplete state. Other archives remain available.
    const cold = (await sm.dbGetAll('timeline_nodes')).find(node => payloadChunkIds(node).length);
    const chunkId = payloadChunkIds(cold)[0]; const chunk = await sm.dbGet(PAYLOAD_CHUNK_STORE, chunkId);
    await sm.dbDelete(PAYLOAD_CHUNK_STORE, chunkId);
    let corruptDetected = false;
    try { await decompressTimelineNode(cold, { db: sm.getDB(), verifyStorage: true }); } catch { corruptDetected = true; }
    await sm.dbPut(PAYLOAD_CHUNK_STORE, chunk);
    check(corruptDetected, 'missing chunk silently accepted');
    // Real library UI, compact action and manager at desktop/mobile widths.
    await import('/js/ui/modal.js');
    const { openSaveLibrary } = await import('/js/ui/save-library-panel.js');
    const modal = await openSaveLibrary();
    window.testSaveModal = modal;
    return { nodes: fixture.nodes.length, sourceBytes: source.bytes, compactedBytes: compacted.bytes,
      reduction: `${(100 * (1 - compacted.bytes / source.bytes)).toFixed(1)}%`, resumeMs: Math.round(elapsed),
      paused, quotaPaused, corruptDetected, rawOriginalPreserved: true, exportRoundtrip: true, activeAndIFPreserved: true,
      resumedFrom: job.completed, archiveCount: (await localSaveLibrary.list('personal_timeline')).length };
  }, fixture);
  await page.waitForFunction(() => window.testSaveModal?.shadowRoot.querySelector('naruto-save-library')?.shadowRoot.querySelector('button[data-action="compact"]'));
  const panel = page.locator('naruto-save-library');
  await panel.locator('button[data-action="compact"]').first().click();
  await page.getByRole('button', { name: '保留原档并整理', exact: true }).click();
  await page.waitForFunction(() => window.testSaveModal.shadowRoot.querySelector('naruto-save-library').shadowRoot.querySelector('#status').textContent.includes('正在无损整理并校验'));
  await panel.locator('#pause-maintenance').click();
  await page.waitForFunction(() => !window.testSaveModal.shadowRoot.querySelector('naruto-save-library').busy);
  assert.match(await panel.locator('#status').textContent(), /已暂停/);
  await panel.locator('#space-manager').click();
  await page.locator('storage-manager-panel').locator('#usage .tile').first().waitFor();
  const manager = page.locator('storage-manager-panel');
  await manager.getByRole('button', { name: '继续整理', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('game-modal').length && [...document.querySelectorAll('game-modal')].some(modal => modal.shadowRoot.querySelector('storage-manager-panel')?.shadowRoot.querySelector('#status')?.textContent.includes('已完成，可回到存档库读取')), undefined, { timeout: 90000 });
  assert.equal(await manager.locator('.job').count(), 0);
  result.uiPauseResume = true;
  await mkdir('reports/shared-timeline-storage', { recursive: true });
  await page.screenshot({ path: 'reports/shared-timeline-storage/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'reports/shared-timeline-storage/mobile.png' });
  assert.deepEqual(errors, []);
  await writeFile('reports/shared-timeline-storage/result.json', JSON.stringify(result, null, 2));
  console.log(result);
  console.log('PASS v2 upgrade, dedup, worker termination/resume, cancellation/discard, atomic rollback, originals, IF, continuation, export, garbage collection, corruption detection and desktop/mobile UI');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
