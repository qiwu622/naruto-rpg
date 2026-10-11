import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/components.css"><main id="app"></main>'));
app.use(express.static(root));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'naruto-string-limit-'));
let browser, passed = 0;
const report = { groups: [], started: new Date().toISOString() };
const ok = message => { passed++; report.groups.push(message); console.log(`PASS ${message}`); };
try {
  browser = await chromium.launch({ headless: true, args: ['--js-flags=--max-old-space-size=4096'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  page.setDefaultTimeout(600000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().startsWith('[save-stress]')) console.log(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  console.log('Seeding real IndexedDB with turn 393, both branches and > 590 MiB of narrative…');
  const seed = await page.evaluate(async () => {
    const { makeContinuationFixture } = await import('/scripts/helpers/continuation-save-fixture.mjs');
    const { NarutoRPGApp } = await import('/js/app.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { localSaveLibrary, PERSONAL_SAVE_KIND } = await import('/js/core/save-library.js');
    const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    const { authClient } = await import('/js/core/auth-client.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    authClient._checked = true; authClient._user = null;
    Object.assign(window, { timelineSystem, stateManager, localSaveLibrary, personalSaveLibrary, PERSONAL_SAVE_KIND, eventBus });
    for (const [target, methods] of [[timelineSystem, ['getExportData']], [personalSaveLibrary, ['store']], [localSaveLibrary, ['put', 'readPackage']]]) {
      for (const name of methods) {
        const original = target[name];
        target[name] = async function(...args) {
          const start = performance.now(); console.log(`[save-stress] ${name} start`);
          const result = await original.apply(this, args);
          console.log(`[save-stress] ${name} completed in ${Math.round(performance.now()-start)} ms`);
          return result;
        };
      }
    }
    appShell.init(document.querySelector('#app')); await timelineSystem.init();
    const app = new NarutoRPGApp();
    app.pipeline = { isProcessing: false, setHistory() {}, clearHistory() {} }; app._bindEvents();
    const data = makeContinuationFixture(393);
    const body = 'x'.repeat(1024 * 1024);
    for (const node of data.nodes) node.clean_response = node.id + '|' + body + '|' + node.id;
    // Real browser engine boundary, rather than simulating a small byte limit.
    let oldError = '';
    try { JSON.stringify(data); } catch (error) { oldError = error.message; }
    await timelineSystem.importTimeline(data);
    window.originalPosition = data.meta.value.current_id;
    // Enter through the application handler: a direct component mount skips
    // navigation side effects and previously missed an invisible full backup.
    await eventBus.request('app:open-saves');
    return { nodes: data.nodes.length, bodyBytes: data.nodes.reduce((total, node) => total + node.clean_response.length, 0), oldError };
  });
  assert.match(seed.oldError, /Invalid string length/); assert.ok(seed.bodyBytes > 512 * 1024 * 1024);
  report.fixture = seed;
  ok('the real Chromium JSON.stringify boundary reproduces Invalid string length at turn 393');
  const panel = page.locator('naruto-save-library');
  const ready = () => page.waitForFunction(() => {
    const element = document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library');
    return element && !element.busy;
  }, undefined, { timeout: 600000 });
  await ready();
  assert.ok(await panel.evaluate(element => element.nodes.every(node => !node.state_snapshot && !node.clean_response && !node.payload)), 'the library holds only timeline listing metadata');
  console.log('Clicking save-current with the complete working timeline…');
  await panel.locator('#capture').click(); await ready();
  assert.match(await panel.locator('#status').innerText(), /个人档已保存/);
  const saved = await page.evaluate(async () => {
    const entries = await localSaveLibrary.list(PERSONAL_SAVE_KIND);
    window.originalEntry = entries[0];
    const pack = await localSaveLibrary.readPackage(originalEntry.id, PERSONAL_SAVE_KIND);
    const data = pack.payload;
    const stored = await localSaveLibrary._read('files', originalEntry.id);
    const reader = stored.blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    let decodedBytes = 0;
    while (true) { const { value, done } = await reader.read(); if (done) break; decodedBytes += value.length; }
    reader.releaseLock();
    return { id: originalEntry.id, checksum: originalEntry.checksum, nodes: data.nodes.length, branches: data.branches.length, decodedBytes,
      intact: data.nodes.every(node => node.clean_response.length === 1024*1024 + node.id.length*2+2 && node.clean_response.startsWith(node.id+'|') && node.clean_response.endsWith('|'+node.id)),
      daily: data.nodes.every(node => node.shinobi_daily?.headline?.title),
      pins: data.nodes.at(-1).state_snapshot._memory.pins,
      current: stateManager.getSub('_meta').current_node_id === originalPosition };
  });
  assert.equal(saved.nodes, seed.nodes); assert.equal(saved.branches, 2);
  assert.ok(saved.intact && saved.daily && saved.current); assert.match(saved.pins, /最初的约定/);
  report.saved = saved;
  ok('save-current and signed gzip reopening preserve every body, daily, memory and IF line above 512 MiB');
  console.log('Creating the last 100 turns through the actual continuation dialog…');
  await panel.locator('#continuation').click();
  await page.locator('#continuation-name').fill('第393回合·近100回合');
  await page.locator('#continuation-turns').fill('100');
  await page.getByRole('button', { name: '保留原档并生成', exact: true }).click(); await ready();
  assert.match(await panel.locator('#status').innerText(), /轻量副本已生成/);
  const copy = await page.evaluate(async () => {
    const entries = await localSaveLibrary.list(PERSONAL_SAVE_KIND);
    const entry = entries.find(item => item.reason === 'continuation');
    const data = (await localSaveLibrary.readPackage(entry.id, PERSONAL_SAVE_KIND)).payload;
    return { count:entries.length, nodes:data.nodes.length, first:data.nodes[0].turn_number, last:data.nodes.at(-1).turn_number,
      ledger:data.nodes.at(-1).state_snapshot._continuity.events.length,
      intact:data.nodes.every(node => node.clean_response.length === 1024*1024+node.id.length*2+2),
      original:entries.some(item => item.id === originalEntry.id && item.checksum === originalEntry.checksum),
      current:stateManager.getSub('_meta').current_node_id === originalPosition };
  });
  assert.equal(copy.nodes, 100); assert.equal(copy.first, 294); assert.equal(copy.last, 393); assert.equal(copy.ledger, 393);
  // Background cold-node archival may change storage metadata between captures,
  // legitimately producing another full backup. Assert preservation, not a
  // fixed count that would incorrectly require discarding that backup.
  assert.ok(copy.count >= 2); assert.ok(copy.intact && copy.original && copy.current);
  report.copy = copy;
  ok('100-turn continuation saves the full original first, retains historical memories and leaves the current game untouched');
  const downloadEvent = page.waitForEvent('download');
  const exportBytes = await page.evaluate(async () => {
    const result = await localSaveLibrary.export(originalEntry.id, PERSONAL_SAVE_KIND);
    const digest = await crypto.subtle.digest('SHA-256', await result.blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join('');
  });
  const download = await downloadEvent;
  await download.saveAs(path.join(temporary, 'full.json.gz'));
  assert.equal(createHash('sha256').update(await readFile(path.join(temporary, 'full.json.gz'))).digest('hex'), exportBytes);
  ok('full original downloads without changing the stored bytes');
  console.log('Opening a new game only after its full backup succeeds…');
  await panel.locator('#new-game').click();
  await page.getByRole('button', { name: '保存并开新档', exact: true }).click();
  await page.waitForFunction(() => new Promise((resolve, reject) => {
    const request = stateManager._db.transaction('timeline_nodes', 'readonly').objectStore('timeline_nodes').count();
    request.onsuccess = () => resolve(request.result === 0); request.onerror = () => reject(request.error);
  }), undefined, { timeout: 600000, polling: 2000 });
  assert.ok(await page.evaluate(async expected => {
    const entries = await localSaveLibrary.list(PERSONAL_SAVE_KIND);
    return entries.length >= expected && entries.some(entry => entry.id === originalEntry.id && entry.checksum === originalEntry.checksum);
  }, copy.count));
  ok('new-game preserves both archives and clears the working timeline only after backup commits');
  await page.reload();
  console.log('Reopening the original archive after a reload…');
  const restored = await page.evaluate(async id => {
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
    await timelineSystem.init();
    await personalSaveLibrary.load(id);
    const current = await timelineSystem.getCurrentNode();
    const count = await new Promise((resolve, reject) => { const request = stateManager._db.transaction('timeline_nodes','readonly').objectStore('timeline_nodes').count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return { count, turn: current.turn_number, bodyLength:current.clean_response.length, id:current.id, pins:stateManager.getSub('_memory').pins };
  }, saved.id);
  assert.equal(restored.count, seed.nodes); assert.equal(restored.turn, 393); assert.match(restored.pins, /最初的约定/);
  assert.equal(restored.bodyLength, 1024*1024+restored.id.length*2+2);
  assert.deepEqual(errors, []);
  report.restored = restored;
  ok('after reload the original full archive restores turn 393, its complete timeline and memories');
  report.completed = new Date().toISOString();
  await mkdir(path.join(root, 'reports/save-string-limit'), { recursive: true });
  await writeFile(path.join(root, 'reports/save-string-limit/result.json'), JSON.stringify(report,null,2));
  console.log(`String limit regression: ${passed} groups passed, ${(saved.decodedBytes/1024/1024).toFixed(2)} MiB decoded; disposable data, no model calls.`);
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
