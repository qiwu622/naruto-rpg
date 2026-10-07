import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/components.css"><style>body{background:#15171b;color:#eee;margin:0}#app{min-height:100vh}</style><main id="app"></main>');
    if (pathname === '/auth/me') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"save-test-a","username":"存档测试"}');
    const target = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!target.startsWith(root + path.sep) || !/\.(?:js|css|json|png|webp|jpg|svg|woff2?)$/u.test(target)) throw new Error('unavailable');
    res.writeHead(200, { 'Content-Type': target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream' }).end(await readFile(target));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let passed = 0;
const ok = label => { passed++; console.log(`PASS ${label}`); };
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.evaluate(async () => {
    // Import after DOMContentLoaded so the full app's auto-boot listener does
    // not run; bind its real UI handlers without any model/API generation.
    const { NarutoRPGApp } = await import('/js/app.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
    const { localSaveLibrary, PERSONAL_SAVE_KIND, ROOM_SAVE_KIND, createSavePackage } = await import('/js/core/save-library.js');
    const { localRoomHistory } = await import('/js/multiplayer/local-room-history.js');
    const { authClient } = await import('/js/core/auth-client.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    authClient._user = { id: 'save-test-a' }; authClient._checked = true;
    Object.assign(window, { stateManager, timelineSystem, personalSaveLibrary, localSaveLibrary, localRoomHistory, authClient, eventBus, createSavePackage, PERSONAL_SAVE_KIND, ROOM_SAVE_KIND });
    appShell.init(document.querySelector('#app'));
    await timelineSystem.init();
    window.app = new NarutoRPGApp();
    app.pipeline = { isProcessing: false, setHistory: () => {}, clearHistory: () => {} };
    app._bindEvents();
    window.seed = async name => {
      await timelineSystem.emergencyReset();
      const state = stateManager.snapshot();
      state['玩家·姓名'] = name;
      state._ui.testConnection = { apiKey: 'never-export-this-key' };
      await timelineSystem.createRootNode({ summary: `${name}的正文`, stateSnapshot: state });
    };
    await seed('旧档甲');
    window.oldA = await eventBus.request('app:save-personal');
  });
  assert.equal(await page.evaluate(async () => (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length), 1);
  ok('existing personal timeline is saved in a separate real IndexedDB library');

  await page.evaluate(() => { window.newGameResult = eventBus.request('app:new-personal-save'); });
  await page.getByRole('button', { name: '保存并开新档', exact: true }).click();
  assert.equal(await page.evaluate(() => newGameResult), true);
  assert.equal(await page.evaluate(async () => (await stateManager.dbGetAll('timeline_nodes')).length), 0);
  assert.equal(await page.evaluate(async () => (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length), 1);
  ok('new-game UI preserves old archive before atomically clearing the working timeline');

  await page.evaluate(async () => {
    await seed('新档乙');
    await eventBus.request('app:load-personal-save', { id: oldA.id });
    window.oldB = (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).find(entry => entry.character === '新档乙');
  });
  assert.equal(await page.evaluate(() => stateManager.get('玩家·姓名')), '旧档甲');
  assert.ok(await page.evaluate(() => Boolean(oldB)));
  await page.evaluate(() => eventBus.request('app:load-personal-save', { id: oldB.id }));
  assert.equal(await page.evaluate(() => stateManager.get('玩家·姓名')), '新档乙');
  ok('A -> new B -> load A -> load B retains both full personal adventures');

  const busyGuard = await page.evaluate(async () => {
    const before = stateManager.get('玩家·姓名');
    app.pipeline.isProcessing = true;
    let error = '';
    try { await eventBus.request('app:load-personal-save', { id: oldA.id }); } catch (e) { error = e.message; }
    finally { app.pipeline.isProcessing = false; }
    return { error, same: before === stateManager.get('玩家·姓名') };
  });
  assert.match(busyGuard.error, /正在生成/); assert.ok(busyGuard.same);
  ok('loading another save cannot race an in-flight narrative generation');

  const integrity = await page.evaluate(async () => {
    const pack = await localSaveLibrary.readPackage(oldA.id, PERSONAL_SAVE_KIND);
    const before = await stateManager.dbGet('timeline_meta', 'root');
    const { encodeTimelineSave, decodeTimelineSaveFile } = await import('/js/core/timeline-file-codec.js');
    const gzip = await encodeTimelineSave(pack, { compression: 'gzip' });
    await personalSaveLibrary.importData(await decodeTimelineSaveFile(gzip.blob));
    const legacy = structuredClone(pack.payload);
    delete legacy.meta; // legacy export lacks metadata, normalization derives it
    await personalSaveLibrary.importData(await decodeTimelineSaveFile(new Blob([JSON.stringify(legacy)])));
    const corrupted = structuredClone(pack); corrupted.payload.nodes[0].summary += '损坏';
    let damaged = '', version = '', tree = '';
    try { await personalSaveLibrary.importData(corrupted); } catch (e) { damaged = e.message; }
    try { await personalSaveLibrary.importData({ ...pack, schema: 'naruto.save-package/v99' }); } catch (e) { version = e.message; }
    const bad = structuredClone(pack.payload); bad.nodes[0].parent_id = bad.nodes[0].id;
    try { await personalSaveLibrary.importData(bad); } catch (e) { tree = e.message; }
    return { damaged, version, tree, unchanged: JSON.stringify(before) === JSON.stringify(await stateManager.dbGet('timeline_meta', 'root')), safe: !JSON.stringify(pack).includes('never-export-this-key') };
  });
  assert.match(integrity.damaged, /完整性/); assert.match(integrity.version, /版本/); assert.ok(integrity.tree); assert.ok(integrity.unchanged); assert.ok(integrity.safe);
  ok('gzip and legacy JSON imports coexist; corruption, future schema and cyclic tree reject without overwrite or credentials');

  const quota = await page.evaluate(async () => {
    // Force a failure inside the actual entries/files transaction, after the
    // metadata read, not a mock of the high-level save operation.
    await seed('配额测试丙');
    const before = await stateManager.dbGetAll('timeline_nodes');
    const count = (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'files') throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, value, ...args);
    };
    let error = '';
    try { await personalSaveLibrary.startNew(); } catch (e) { error = e.message; }
    finally { IDBObjectStore.prototype.put = original; }
    return { error, unchanged: JSON.stringify(before) === JSON.stringify(await stateManager.dbGetAll('timeline_nodes')), noPartialEntry: count === (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length };
  });
  assert.match(quota.error, /空间不足/); assert.ok(quota.unchanged); assert.ok(quota.noPartialEntry);
  ok('IndexedDB quota abort leaves the current game and save directory untouched');

  await page.evaluate(async () => {
    window.roomState = {
      roomId: 'room:save-test', room: { room_id: 'room:save-test', room_code: 'R-SAVE-TEST', lifecycle: 'ACTIVE', viewer_seat: 'A', active_epoch_id: 'epoch:save', origin_type: 'new_multiplayer_save', members: [] },
      invite: { token: 'do-not-persist-invite' }, credentials: [{ api_key: 'do-not-persist-api' }],
      latestCommittedTurn: { status: 'COMMITTED', epoch_id: 'epoch:save', turn_id: 'turn:save', turn_no: 7, commit: {
        narratives: [{ audience: 'shared', text: '第七回合：村口传来脚步声。' }],
        shinobi_daily: [{ daily: { title: '第七回合日报' } }], state: { viewer_seat: 'A', actors: { A: { player: { display_name: '档案忍者' } } } }, checkpoint: { checkpoint_id: 'checkpoint:save' }
      } }
    };
    window.roomEntry = await localRoomHistory.remember(roomState, { snapshot: true });
  });
  const isolation = await page.evaluate(async () => {
    const pack = await localSaveLibrary.readPackage(roomEntry.id, ROOM_SAVE_KIND, localRoomHistory.owner);
    authClient._user = { id: 'save-test-b' };
    const count = (await localRoomHistory.list()).length;
    let error = ''; try { await localRoomHistory.importPackage(pack); } catch (e) { error = e.message; }
    authClient._user = { id: 'save-test-a' };
    const imported = await localRoomHistory.importPackage(pack);
    const same = await localSaveLibrary.readPackage(roomEntry.id, ROOM_SAVE_KIND, localRoomHistory.owner);
    let crossType = ''; try { await personalSaveLibrary.importData(pack); } catch (e) { crossType = e.message; }
    return { count, error, crossType, distinct: imported.id !== roomEntry.id, safe: !JSON.stringify(same).includes('do-not-persist'), text: same.payload.publication.narratives[0].text };
  });
  assert.equal(isolation.count, 0); assert.match(isolation.error, /其他账号/); assert.match(isolation.crossType, /联机/); assert.ok(isolation.distinct); assert.ok(isolation.safe); assert.match(isolation.text, /第七回合/);
  ok('member-local room snapshots are account-separated, import as copies and never become personal timelines');

  const failedResume = await page.evaluate(async () => {
    const before = (await localRoomHistory.list()).length;
    let error = '';
    try { await localRoomHistory.resume(roomEntry.id, async () => { throw new Error('房间不存在'); }); }
    catch (e) { error = e.message; }
    return { error, kept: before === (await localRoomHistory.list()).length };
  });
  assert.match(failedResume.error, /本地记录仍保留/); assert.ok(failedResume.kept);
  ok('an unavailable server room does not delete the local snapshot or history');

  await page.evaluate(() => eventBus.request('app:open-saves', { kind: ROOM_SAVE_KIND }));
  const library = page.locator('naruto-save-library').last();
  assert.equal(await page.locator('#btn-multiplayer').count(), 1);
  assert.equal(await library.getByRole('button', { name: '重新进入', exact: true }).count(), 2);
  await library.getByRole('button', { name: '查看快照', exact: true }).first().click();
  await library.locator('#preview').waitFor({ state: 'visible' });
  assert.match(await library.locator('#preview').innerText(), /村口传来脚步声/);
  await library.getByRole('button', { name: '改名', exact: true }).first().click();
  await page.locator('#save-name').fill('我们的第七回合');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library')?.shadowRoot.textContent.includes('我们的第七回合'));
  await page.setViewportSize({ width: 390, height: 844 });
  await library.getByRole('button', { name: '收起快照', exact: true }).click();
  await page.locator('game-modal').evaluate(el => { el.shadowRoot.querySelector('.modal').scrollTop = 0; });
  await mkdir(path.join(root, 'reports', 'save-library'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'reports', 'save-library', 'mobile.png') });
  assert.ok(await library.evaluate(el => el.getBoundingClientRect().width <= innerWidth));
  const downloadPromise = page.waitForEvent('download');
  await library.getByRole('button', { name: '导出', exact: true }).first().click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /联机房间.*\.json(?:\.gz)?$/);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  ok('room list, read-only body/daily/variables, rename and file download work on narrow screens');

  await page.setViewportSize({ width: 1280, height: 960 });
  await page.evaluate(async () => {
    // Exercise the retained component directly while public entry is paused.
    const { openMultiplayerOverlay } = await import('/js/ui/multiplayer-overlay.js');
    window.overlay = openMultiplayerOverlay({ host: document.querySelector('#app') });
    overlay.panel.controller.store.patch(roomState);
  });
  await page.locator('naruto-multiplayer-panel #active-exit-room').click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('[data-multiplayer-overlay]').count(), 1);
  await page.evaluate(() => {
    window.originalRemember = localRoomHistory.remember.bind(localRoomHistory);
    localRoomHistory.remember = async () => { throw new Error('模拟空间不足'); };
  });
  await page.locator('naruto-multiplayer-panel #active-exit-room').click();
  await page.getByRole('button', { name: '保存并退出', exact: true }).click();
  await page.getByRole('dialog', { name: '保存失败，尚未退出' }).waitFor();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  assert.equal(await page.locator('[data-multiplayer-overlay]').count(), 1);
  await page.evaluate(() => { localRoomHistory.remember = originalRemember; });
  await page.locator('naruto-multiplayer-panel #active-exit-room').click();
  await page.getByRole('button', { name: '保存并退出', exact: true }).click();
  await page.locator('[data-multiplayer-overlay]').waitFor({ state: 'detached' });
  ok('cancel and failed save keep the session connected; save-and-exit disconnects only after persistence');

  await page.evaluate(async () => {
    const { openMultiplayerOverlay } = await import('/js/ui/multiplayer-overlay.js');
    window.overlay = openMultiplayerOverlay({ host: document.querySelector('#app') });
    window.reconnected = null;
    overlay.panel.controller.connectRoom = async roomId => { reconnected = roomId; overlay.panel.controller.store.patch(roomState); };
  });
  await page.locator('naruto-multiplayer-panel #local-room-history').getByRole('button', { name: '重新进入' }).first().click();
  await page.waitForFunction(() => window.reconnected !== null);
  assert.equal(await page.evaluate(() => reconnected), 'room:save-test');
  const savedBefore = await page.evaluate(async () => (await localSaveLibrary.readPackage(roomEntry.id, ROOM_SAVE_KIND, localRoomHistory.owner)).checksum.value);
  await page.locator('naruto-multiplayer-panel #active-exit-room').click();
  await page.getByRole('button', { name: '仅退出', exact: true }).click();
  await page.locator('[data-multiplayer-overlay]').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(async () => (await localSaveLibrary.readPackage(roomEntry.id, ROOM_SAVE_KIND, localRoomHistory.owner)).checksum.value), savedBefore);
  ok('history reconnect routes to the original room; exit-without-save preserves the last snapshot');

  const restoredEntry = await page.evaluate(async () => {
    localStorage.setItem('naruto_multiplayer_last_room:save-test-a', 'room:save-test');
    authClient._checked = true; authClient._user = { id: 'save-test-a' };
    const checkAuth = authClient.checkAuth;
    authClient.checkAuth = async () => authClient._user;
    const scheduled = app._scheduleMultiplayerRestore();
    const opened = await eventBus.request('app:open-multiplayer');
    await new Promise(resolve => setTimeout(resolve, 50));
    authClient.checkAuth = checkAuth;
    return {
      scheduled,
      opened: Boolean(opened),
      remembered: localStorage.getItem('naruto_multiplayer_last_room:save-test-a')
    };
  });
  assert.equal(restoredEntry.scheduled, true);
  assert.equal(restoredEntry.opened, true);
  assert.equal(restoredEntry.remembered, 'room:save-test');
  ok('public entry and automatic reconnect are available without erasing the remembered room');

  await page.reload();
  const durable = await page.evaluate(async () => {
    const { LocalSaveLibrary, PERSONAL_SAVE_KIND, ROOM_SAVE_KIND } = await import('/js/core/save-library.js');
    const library = new LocalSaveLibrary();
    return { personal: (await library.list(PERSONAL_SAVE_KIND)).length, rooms: (await library.list(ROOM_SAVE_KIND, 'user:save-test-a')).length };
  });
  assert.ok(durable.personal >= 2); assert.equal(durable.rooms, 2);
  ok('personal archives and account-scoped room history survive a page reload');
  assert.deepEqual(errors, []);
  console.log(`\n${passed} save-library browser regression groups passed; no model calls.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
