import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { decodeTimelineSaveFile } from '../js/core/timeline-file-codec.js';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';
import { startCloudSaveTestServer } from './helpers/cloud-save-test-server.mjs';

const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../reports/continuation-save');
const server = await startCloudSaveTestServer({ staticFiles: true });
let browser, passed = 0;
const ok = message => { console.log(`PASS ${message}`); passed++; };
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addCookies([{ name: 'naruto_token', value: server.tokens['cloud-test-a'], url: server.url, httpOnly: true }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.evaluate(async data => {
    const { NarutoRPGApp } = await import('/js/app.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { localSaveLibrary, PERSONAL_SAVE_KIND } = await import('/js/core/save-library.js');
    const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
    const { saveLibraryCloud } = await import('/js/core/save-library-cloud.js');
    const { cloudSave } = await import('/js/core/cloud-save.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    Object.assign(window, { timelineSystem, stateManager, localSaveLibrary, PERSONAL_SAVE_KIND, personalSaveLibrary, saveLibraryCloud, cloudSave, eventBus });
    appShell.init(document.querySelector('#app')); await timelineSystem.init();
    window.app = new NarutoRPGApp();
    app.pipeline = { isProcessing: false, setHistory: history => { window.aiHistory = history; }, clearHistory: () => {} };
    app._bindEvents();
    await timelineSystem.importTimeline(data);
    window.originalEntry = await personalSaveLibrary.capture({ label: '完整主线与 IF 原档' });
    window.originalChecksum = originalEntry.checksum;
    window.originalPosition = stateManager.getSub('_meta').current_node_id;
    await eventBus.request('app:open-saves');
  }, makeContinuationFixture());
  const library = page.locator('naruto-save-library');
  const ready = () => page.waitForFunction(() => {
    const panel = document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library');
    return panel && !panel.busy;
  });
  await ready();
  const count = await page.evaluate(async () => (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length);
  await library.locator('#continuation').click();
  assert.match(await page.locator('.save-form').innerText(), /更早的正文与其他 IF 线保留在原档/);
  await page.getByRole('button', { name: '取消', exact: true }).click(); await ready();
  assert.equal(await page.evaluate(async () => (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length), count);
  ok('cancel leaves both the working timeline and save library untouched');

  await library.locator('#continuation').click();
  await page.locator('#continuation-name').fill('木叶 <续玩>');
  await page.locator('#continuation-turns').fill('20');
  await page.getByRole('button', { name: '保留原档并生成', exact: true }).click(); await ready();
  assert.match(await library.locator('#status').innerText(), /101–120/);
  const generated = await page.evaluate(async () => {
    window.copyEntry = (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).find(entry => entry.label === '木叶 <续玩>');
    window.copyData = (await localSaveLibrary.readPackage(copyEntry.id, PERSONAL_SAVE_KIND)).payload;
    return {
      copy: copyEntry, nodes: copyData.nodes.length, branches: copyData.branches.length,
      original: (await localSaveLibrary.readPackage(originalEntry.id, PERSONAL_SAVE_KIND)).checksum.value === originalChecksum,
      current: stateManager.getSub('_meta').current_node_id === originalPosition
    };
  });
  assert.equal(generated.nodes, 20); assert.equal(generated.branches, 1);
  assert.equal(generated.original, true); assert.equal(generated.current, true);
  assert.ok(generated.copy.bytes > 0);
  assert.equal(await library.locator(`[data-save-id="${generated.copy.id}"] h3`).innerText(), '木叶 <续玩>');
  ok('current-game UI preserves the original and creates a labeled 20-turn copy without switching play');

  await page.screenshot({ path: path.join(output, 'library-desktop.png') });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await library.evaluate(element => [...element.shadowRoot.querySelectorAll('.library,.entry,.current')].some(item => item.scrollWidth > item.clientWidth + 1)), false, `${width}px overflow`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await library.locator(`[data-save-id="${generated.copy.id}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'library-mobile.png'), animations: 'disabled' });
  await library.locator('#continuation').click();
  await page.locator('#continuation-name').waitFor();
  await page.screenshot({ path: path.join(output, 'copy-dialog-mobile.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '取消', exact: true }).click(); await ready();
  await page.setViewportSize({ width: 1440, height: 1000 });
  ok('desktop and 320/390/768px mobile cards show range and controls without horizontal overflow');

  const copyCard = () => library.locator(`[data-save-id="${generated.copy.id}"]`);
  const downloadPromise = page.waitForEvent('download');
  await copyCard().getByRole('button', { name: '导出', exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  const exported = await decodeTimelineSaveFile(bytes);
  assert.equal(exported.payload.meta.value.continuation.from_turn, 101);
  assert.equal(exported.payload.nodes.at(-1).state_snapshot._continuity.events.length, 120);
  assert.ok(exported.payload.nodes[0].shinobi_daily);
  await ready();
  await page.evaluate(async () => localSaveLibrary.remove(copyEntry.id, PERSONAL_SAVE_KIND));
  await library.locator('#file').setInputFiles({ name: 'continuation.json.gz', mimeType: 'application/gzip', buffer: bytes }); await ready();
  const importedId = await page.evaluate(async () => {
    window.copyEntry = (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).find(entry => entry.label === '木叶 <续玩>');
    return copyEntry.id;
  });
  assert.ok(importedId);
  assert.match(await library.locator(`[data-save-id="${importedId}"] .save-scope`).innerText(), /101–120/);
  ok('real file download and gzip import preserve the copy range, daily and earlier factual memory');

  await library.locator(`[data-save-id="${importedId}"]`).getByRole('button', { name: '上传到云端', exact: true }).click();
  assert.match(await page.locator('.save-form').innerText(), /这是轻量副本/);
  await page.locator('#cloud-name').fill('轻量云档');
  await page.getByRole('button', { name: '上传', exact: true }).click(); await ready();
  await library.getByRole('button', { name: '云端管理', exact: true }).click(); await ready();
  assert.match(await library.locator('[data-cloud-id] .save-scope').innerText(), /101–120/);
  const remote = await page.evaluate(async () => {
    const cloud = (await cloudSave.listSaves()).find(entry => entry.slot_name === '轻量云档');
    const local = await saveLibraryCloud.download(cloud.id);
    const restored = await localSaveLibrary.readPackage(local.id, PERSONAL_SAVE_KIND);
    return { id: cloud.id, preview: cloud.preview_data, scope: restored.payload.meta.value.continuation, nodes: restored.payload.nodes.length };
  });
  assert.equal(remote.preview.continuation.from_turn, 101);
  assert.equal(remote.scope.from_turn, 101); assert.equal(remote.nodes, 20);
  ok('real cloud gzip upload/list/download retain the lightweight badge and memory range');

  await library.getByRole('button', { name: '返回本机', exact: true }).click(); await ready();
  await library.locator(`[data-save-id="${importedId}"]`).getByRole('button', { name: '读取', exact: true }).click();
  await library.waitFor({ state: 'detached' });
  const restored = await page.evaluate(async () => {
    const current = await timelineSystem.getCurrentNode();
    const headMemories = stateManager.getSub('_continuity').events.map(event => event.value);
    await timelineSystem.jumpToNode('if_101');
    const earlierMemories = stateManager.getSub('_continuity').events.map(event => event.value);
    await timelineSystem.jumpToNode(current.id);
    return { headMemories, earlierMemories, pins: stateManager.getSub('_memory').pins, count: (await timelineSystem.getAllNodes()).length };
  });
  assert.equal(restored.count, 20); assert.match(restored.pins, /最初的约定/);
  assert.ok(restored.headMemories.includes('主线1'));
  assert.ok(restored.headMemories.includes('IF120'));
  assert.ok(!restored.earlierMemories.includes('IF120'));
  assert.ok(!restored.headMemories.includes('主线61'));
  ok('read and rollback restore the precise turn: earlier facts survive and unplayed/future branches stay absent');

  await page.evaluate(async () => {
    stateManager.setSub('marker', '续玩121');
    await timelineSystem.createNode({ turnNumber: 121, cleanResponse: '新的续玩正文', aiResponse: '新的续玩正文', stateSnapshot: stateManager.snapshot(), chatHistory: [{ role: 'user', content: '继续调查' }, { role: 'assistant', content: '新的续玩正文' }] });
    await timelineSystem.createIfBranch({ fromNodeId: 'if_101', name: '续玩后的新 IF' });
    await timelineSystem.switchBranch('branch_main');
    await app._queueCloudSave();
  });
  const continued = await page.evaluate(async remoteId => ({ marker: stateManager.snapshot().marker, branches: (await timelineSystem.getAllBranches()).length, cloud: (await cloudSave.listSaves()).find(entry => entry.id === remoteId).preview_data.continuation }), remote.id);
  assert.equal(continued.marker, '续玩121'); assert.equal(continued.branches, 2);
  assert.deepEqual(continued.cloud, { from_turn: 101, through_turn: 121 });
  ok('continued turns, new IF lines and automatic cloud sync remain functional with updated scope');

  const fromArchive = await page.evaluate(async () => {
    const position = stateManager.getSub('_meta').current_node_id;
    const result = await eventBus.request('app:create-continuation-save', { sourceId: originalEntry.id, keepTurns: 10, label: '从旧档续玩' });
    const pack = await localSaveLibrary.readPackage(result.entry.id, PERSONAL_SAVE_KIND);
    app.pipeline.isProcessing = true;
    let busy;
    try { await eventBus.request('app:create-continuation-save', { sourceId: originalEntry.id }); }
    catch (error) { busy = error.message; }
    finally { app.pipeline.isProcessing = false; }
    return { same: stateManager.getSub('_meta').current_node_id === position, turn: pack.payload.nodes.at(-1).turn_number, first: pack.payload.nodes[0].turn_number, busy };
  });
  assert.equal(fromArchive.first, 111); assert.equal(fromArchive.turn, 120); assert.ok(fromArchive.same);
  assert.match(fromArchive.busy, /正在生成/);
  ok('saved-archive copies use their own position rather than the live game, and in-flight generation blocks capture');

  const failure = await page.evaluate(async () => {
    const count = (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length;
    const position = stateManager.getSub('_meta').current_node_id;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'files') throw new DOMException('full', 'QuotaExceededError');
      return put.call(this, value, ...args);
    };
    let error;
    try { await eventBus.request('app:create-continuation-save', { sourceId: originalEntry.id, keepTurns: 10 }); }
    catch (failure) { error = failure.message; }
    finally { IDBObjectStore.prototype.put = put; }
    return { error, same: stateManager.getSub('_meta').current_node_id === position, count: (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length === count, original: (await localSaveLibrary.readPackage(originalEntry.id, PERSONAL_SAVE_KIND)).checksum.value === originalChecksum };
  });
  assert.match(failure.error, /空间不足/);
  assert.ok(failure.same && failure.count && failure.original);
  assert.deepEqual(errors, []);
  ok('IndexedDB quota failure rolls back both directory/blob writes and preserves original/current progress');
  console.log(`\n${passed} continuation browser regression groups passed; disposable data, no model calls.`);
} finally { await browser?.close(); await server.close(); }
