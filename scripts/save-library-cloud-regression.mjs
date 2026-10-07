import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startCloudSaveTestServer } from './helpers/cloud-save-test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'reports', 'save-library-cloud');
const server = await startCloudSaveTestServer({ staticFiles: true });
let browser;
let passed = 0;
const ok = label => { passed++; console.log(`PASS ${label}`); };
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const cookie = user => ({ name: 'naruto_token', value: server.tokens[user], url: server.url, httpOnly: true });
  await context.addCookies([cookie('cloud-test-a')]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.evaluate(async () => {
    const { NarutoRPGApp } = await import('/js/app.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
    const { localSaveLibrary, PERSONAL_SAVE_KIND } = await import('/js/core/save-library.js');
    const { cloudSave } = await import('/js/core/cloud-save.js');
    const { saveLibraryCloud } = await import('/js/core/save-library-cloud.js');
    const { authClient } = await import('/js/core/auth-client.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    const { decodeTimelineSaveFile } = await import('/js/core/timeline-file-codec.js');
    Object.assign(window, { stateManager, timelineSystem, personalSaveLibrary, localSaveLibrary, PERSONAL_SAVE_KIND, cloudSave, saveLibraryCloud, eventBus, decodeTimelineSaveFile });
    await authClient.checkAuth(true);
    appShell.init(document.querySelector('#app')); await timelineSystem.init();
    window.app = new NarutoRPGApp();
    app.pipeline = { isProcessing: false, setHistory: history => { window.aiHistory = history; }, clearHistory: () => {} }; app._bindEvents();
    stateManager.update([{ key: '玩家·姓名', op: '=', value: '起物' }, { key: '世界·地点', op: '=', value: '木叶隐村' }]);
    window.append = async (turn, marker) => {
      stateManager.setSub('marker', marker);
      const history = [...await timelineSystem._reconstructChatHistory(await timelineSystem.getCurrentNode()), { role: 'user', content: `行动${turn}` }, { role: 'assistant', content: `正文${marker}` }];
      return timelineSystem.createNode({ turnNumber: turn, playerInput: `行动${turn}`, aiResponse: `正文${marker}`, cleanResponse: `正文${marker}`, stateSnapshot: stateManager.snapshot(), chatHistory: history });
    };
    await timelineSystem.createRootNode({ summary: '木叶清晨', stateSnapshot: stateManager.snapshot(), chatHistory: [{ role: 'assistant', content: '清晨正文' }] });
    const middle = await append(2, 'middle'); await append(3, 'main-future');
    await timelineSystem.createIfBranch({ fromNodeId: middle.id, name: '留在木叶', description: '留村追查线索' });
    window.localEntry = await personalSaveLibrary.capture({ label: '木叶主线与 IF' });
    window.original = personalSaveLibrary.normalize(await timelineSystem.getExportData({ includeArchive: true }));
    await app._queueCloudSave();
    await eventBus.request('app:open-saves');
  });
  const library = page.locator('naruto-save-library');
  const ready = () => page.waitForFunction(() => {
    const panel = document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library');
    return panel && !panel.busy;
  });
  const status = async text => {
    await page.waitForFunction(text => {
      const panel = document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library');
      return panel && !panel.busy && panel.shadowRoot.querySelector('#status')?.textContent.includes(text);
    }, text);
    assert.ok((await library.locator('#status').innerText()).includes(text), await library.locator('#status').innerText());
  };
  await ready();
  assert.deepEqual(await page.evaluate(async () => cloudSave.syncState.active), await page.evaluate(async () => ({ userId: 'cloud-test-a', saveKey: (await stateManager.dbGet('timeline_meta', 'root')).value.root_id })));
  assert.match(await library.locator('#current-sync cloud-sync-status .message').innerText(), /已同步到云端/);
  ok('the mounted current-save status follows the authenticated account and persisted timeline root');
  const defaultCloud = await page.evaluate(async () => {
    const saved = (await cloudSave.listSaves()).find(save => save.slot_name === '默认云存档');
    window.defaultCloudId = saved.id;
    return personalSaveLibrary.normalize(await decodeTimelineSaveFile(await cloudSave.downloadSave(saved.id)));
  });
  assert.deepEqual(defaultCloud, await page.evaluate(() => original));
  ok('automatic sync keeps the complete archived main future and IF anchors/history, rather than only hot nodes');

  await mkdir(output, { recursive: true });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await library.evaluate(element => element.shadowRoot.querySelector('.library').scrollWidth <= element.clientWidth + 1));
    const overflow = await library.evaluate(element => [...element.shadowRoot.querySelectorAll('.entry')].some(card => card.scrollWidth > card.clientWidth + 1));
    assert.equal(overflow, false, `personal cloud action row at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const localId = await page.evaluate(() => localEntry.id);
  const localSync = library.locator(`[data-save-id="${localId}"] cloud-sync-status`);
  await page.route('**/api/saves', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await library.locator(`[data-save-id="${localId}"]`).getByRole('button', { name: '上传到云端', exact: true }).click();
  await page.locator('#cloud-name').fill('木叶完整档');
  await page.getByRole('button', { name: '上传', exact: true }).click();
  await ready();
  await localSync.getByRole('button', { name: '重试同步', exact: true }).waitFor();
  assert.match(await localSync.locator('.message').innerText(), /本地已保存/);
  assert.match(await library.locator('#current-sync cloud-sync-status .message').innerText(), /已同步到云端/);
  assert.deepEqual(await localSync.evaluate(element => element.scope), { userId: 'cloud-test-a', saveKey: localId, enforceCurrent: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await localSync.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'sync-retry-mobile.png') });
  assert.ok(await library.locator(`[data-save-id="${localId}"]`).evaluate(card => card.scrollWidth <= card.clientWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.unroute('**/api/saves');
  await localSync.getByRole('button', { name: '重试同步', exact: true }).click();
  await status('云端同步已完成');
  assert.match(await localSync.locator('.message').innerText(), /已同步到云端/);
  ok('failed manual archive uploads have their own mounted retry control and do not replace current-game sync status');
  const cloud = await page.evaluate(async () => {
    window.cloudEntry = (await cloudSave.listSaves()).find(entry => entry.slot_name === '木叶完整档');
    return { entry: cloudEntry, data: personalSaveLibrary.normalize(await decodeTimelineSaveFile(await cloudSave.downloadSave(cloudEntry.id))) };
  });
  assert.deepEqual(cloud.data, await page.evaluate(() => original)); assert.equal(cloud.entry.preview_data.branch_count, 1);
  await library.getByRole('button', { name: '云端管理', exact: true }).click(); await ready();
  assert.equal(await library.locator('[data-cloud-id]').count(), 2);
  assert.match(await library.locator('#current-info').innerText(), /2 \/ 3 个槽位/);
  assert.equal(await library.getByRole('button', { name: '返回本机', exact: true }).count(), 1);
  assert.match(await library.locator('#storage-note').innerText(), /不会删除云端/);
  await page.screenshot({ path: path.join(output, 'cloud-desktop.png') });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await library.evaluate(element => element.shadowRoot.querySelector('.library').scrollWidth <= element.clientWidth + 1));
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(output, 'cloud-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  ok('personal cards upload through the real gzip API; cloud manager shows multiple slots, IF counts and fits 320/390/768px screens');

  const cloudId = cloud.entry.id;
  const card = () => library.locator(`[data-cloud-id="${cloudId}"]`);
  await card().getByRole('button', { name: '云档改名', exact: true }).click();
  await page.locator('#save-name').fill('留村 "IF" <img src=x>'); await page.getByRole('button', { name: '保存', exact: true }).click(); await status('名称已更新');
  assert.equal(await card().locator('img').count(), 0);
  assert.equal((await server.db.getSaveMetaById(cloudId)).revision, 1);
  assert.equal(await card().locator('h3').innerText(), '留村 "IF" <img src=x>');
  ok('cloud rename uses metadata PATCH and displays untrusted names as text without replacing content');

  await page.evaluate(() => append(3, 'if-future'));
  const beforeDownload = await page.evaluate(() => ({ meta: stateManager.getSub('_meta'), marker: stateManager.snapshot().marker }));
  await card().getByRole('button', { name: '下载到本地存档库', exact: true }).click(); await status('当前游戏进度没有改变');
  assert.deepEqual(await page.evaluate(() => ({ meta: stateManager.getSub('_meta'), marker: stateManager.snapshot().marker })), beforeDownload);
  assert.equal(await library.locator('[data-cloud-id]').count(), 0);
  await library.getByRole('button', { name: '云端管理', exact: true }).click(); await ready();
  await card().getByRole('button', { name: '读取云档', exact: true }).click(); await library.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => stateManager.snapshot().marker), 'middle');
  assert.equal(await page.evaluate(async () => (await timelineSystem.getAllBranches()).length), 2);
  assert.deepEqual(await page.evaluate(() => {
    const binding = cloudSave._readBinding(cloudSave.syncState.active);
    return { id: binding.id, revision: binding.revision };
  }), { id: cloudId, revision: 1 });
  assert.ok(await page.evaluate(async () => {
    for (const entry of await localSaveLibrary.list(PERSONAL_SAVE_KIND)) {
      const pack = await localSaveLibrary.readPackage(entry.id, PERSONAL_SAVE_KIND);
      const current = pack.payload.nodes.find(node => node.id === pack.payload.meta.value.current_id);
      if (current?.state_snapshot?.marker === 'if-future') return true;
    }
    return false;
  }));
  ok('download creates a validated local archive without changing play; cloud read restores its IF line and backs up prior progress');

  await page.evaluate(() => app._openProfilePanel());
  assert.equal(await page.locator('#btn-cloud-download').count(), 0);
  await page.getByRole('button', { name: '管理云存档', exact: true }).click(); await ready();
  assert.equal(await library.locator('[data-cloud-id]').count(), 2);
  await library.getByRole('button', { name: '关闭', exact: true }).click();
  ok('profile cloud management opens the same library instead of restoring or deleting the first slot');

  await page.evaluate(async () => {
    await append(3, 'updated-if'); window.updatedLocal = await personalSaveLibrary.capture({ label: '更新后的 IF' });
    await eventBus.request('app:open-saves');
  }); await ready();
  const updatedId = await page.evaluate(() => updatedLocal.id);
  async function beginOverwrite() {
    await library.locator(`[data-save-id="${updatedId}"]`).getByRole('button', { name: '上传到云端', exact: true }).click();
    await page.locator('#cloud-name').fill('更新的云档'); await page.locator('#cloud-target').selectOption(cloudId);
  }
  await beginOverwrite();
  await page.evaluate(() => { window.importData = personalSaveLibrary.importData; personalSaveLibrary.importData = async () => { throw new Error('模拟本机空间不足'); }; });
  await page.getByRole('button', { name: '上传', exact: true }).click(); await status('模拟本机空间不足');
  assert.equal((await server.db.getSaveMetaById(cloudId)).revision, 1);
  await page.evaluate(() => { personalSaveLibrary.importData = importData; });
  await beginOverwrite(); await page.getByRole('button', { name: '上传', exact: true }).click(); await status('已上传');
  assert.equal((await server.db.getSaveMetaById(cloudId)).revision, 2);
  const afterOverwrite = await page.evaluate(async () => {
    const data = await decodeTimelineSaveFile(await cloudSave.downloadSave(cloudEntry.id));
    const current = data.nodes.find(node => node.id === data.meta.value.current_id);
    return { marker: current.state_snapshot.marker, branches: data.branches.length, defaultRevision: (await cloudSave.listSaves()).find(save => save.id === defaultCloudId).revision };
  });
  assert.deepEqual(afterOverwrite, { marker: 'updated-if', branches: 2, defaultRevision: 1 });
  ok('overwrite stops on local-backup failure; successful overwrite preserves the old version locally and leaves the automatic slot untouched');

  await library.getByRole('button', { name: '云端管理', exact: true }).click(); await ready();
  await page.evaluate(() => { personalSaveLibrary.importData = async () => { throw new Error('模拟备份失败'); }; });
  await card().getByRole('button', { name: '删除云档', exact: true }).click(); await page.getByRole('button', { name: '备份并删除云档', exact: true }).click(); await status('模拟备份失败');
  assert.ok(await server.db.getSaveMetaById(cloudId));
  await page.evaluate(() => { personalSaveLibrary.importData = importData; });
  await card().getByRole('button', { name: '删除云档', exact: true }).click(); await page.getByRole('button', { name: '取消', exact: true }).click(); await ready();
  assert.ok(await server.db.getSaveMetaById(cloudId));
  await card().getByRole('button', { name: '删除云档', exact: true }).click(); await page.getByRole('button', { name: '备份并删除云档', exact: true }).click(); await status('完整备份保留');
  assert.equal(await server.db.getSaveMetaById(cloudId), null);
  assert.ok(await page.evaluate(async () => (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).some(entry => entry.id === updatedLocal.id)));
  ok('delete supports cancel, refuses to remove an unbacked cloud save, and retains a local copy after successful deletion');

  await page.evaluate(async () => {
    cloudSave.bindSyncSave({ ...cloudSave.syncState.active, saveId: defaultCloudId, revision: 1, slotName: '默认云存档' });
    const response = await fetch(`/api/saves/${defaultCloudId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot_name: '另一台设备的进度', save_data: original, expected_revision: 1 }) });
    if (!response.ok) throw new Error(await response.text());
    try { await app._queueCloudSave(); throw new Error('expected conflict'); }
    catch (error) { if (error.code !== 'SAVE_REVISION_CONFLICT') throw error; }
  });
  const currentSync = library.locator('#current-sync cloud-sync-status');
  await page.setViewportSize({ width: 390, height: 844 });
  await currentSync.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'sync-conflict-mobile.png') });
  assert.ok(await currentSync.evaluate(element => element.shadowRoot.querySelector('.status').scrollWidth <= element.clientWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await currentSync.getByRole('button', { name: '保留双方副本', exact: true }).click();
  await status('云端同步已完成');
  assert.equal(await library.locator('[data-cloud-id]').count(), 2);
  assert.match(await currentSync.locator('.message').innerText(), /已同步到云端/);
  const copies = await page.evaluate(async () => {
    const active = cloudSave._readBinding(cloudSave.syncState.active);
    const originalCloud = await decodeTimelineSaveFile(await cloudSave.downloadSave(defaultCloudId));
    const copy = await decodeTimelineSaveFile(await cloudSave.downloadSave(active.id));
    const marker = data => data.nodes.find(node => node.id === data.meta.value.current_id).state_snapshot.marker;
    return { originalId: defaultCloudId, copyId: active.id, originalMarker: marker(originalCloud), copyMarker: marker(copy) };
  });
  assert.notEqual(copies.originalId, copies.copyId);
  assert.equal(copies.originalMarker, 'middle'); assert.equal(copies.copyMarker, 'updated-if');
  ok('mounted conflict control preserves both real server copies, binds the new copy and refreshes the cloud list');

  const triggerChecks = await page.evaluate(async () => {
    const { aiClient } = await import('/js/core/ai-client.js');
    const isConfigured = aiClient.isConfigured, schedule = cloudSave.scheduleQuickSave;
    const beforeProcess = app.pipeline.process;
    const calls = [];
    aiClient.isConfigured = () => true;
    cloudSave.scheduleQuickSave = async (_name, factory, scope) => { calls.push({ data: await factory(), scope }); return { id: 'captured-only' }; };
    localStorage.setItem('naruto_auto_cloud_sync', 'true');
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));
    try {
      app.pipeline.process = async () => ({ cancelled: true });
      await app._handleUserInput('取消的回合'); await settle();
      const afterCancel = calls.length;
      app.pipeline.process = async () => { eventBus.emit('pipeline:complete', { isPartial: true, timelineNodeId: null }); return { partialResponse: '未完成正文' }; };
      await app._handleUserInput('中断的回合'); await settle();
      const afterPartial = calls.length;
      eventBus.emit('pipeline:complete', { timelineNodeId: 'not-persisted' }); await settle();
      const afterMissing = calls.length;
      const node = await timelineSystem.getCurrentNode();
      eventBus.emit('pipeline:complete', { timelineNodeId: node.id, timelineError: '本地保存失败' }); await settle();
      const afterFailure = calls.length;
      eventBus.emit('pipeline:complete', { timelineNodeId: node.id }); await settle();
      return { afterCancel, afterPartial, afterMissing, afterFailure, count: calls.length, root: calls[0]?.scope.saveKey, payloadRoot: calls[0]?.data.saveData.meta.value.root_id };
    } finally {
      localStorage.removeItem('naruto_auto_cloud_sync'); aiClient.isConfigured = isConfigured; cloudSave.scheduleQuickSave = schedule; app.pipeline.process = beforeProcess;
    }
  });
  assert.deepEqual([triggerChecks.afterCancel, triggerChecks.afterPartial, triggerChecks.afterMissing, triggerChecks.afterFailure, triggerChecks.count], [0, 0, 0, 0, 1]);
  assert.equal(triggerChecks.root, triggerChecks.payloadRoot);
  ok('cancelled, partial and unpersisted turns never schedule cloud uploads; a persisted complete turn schedules one scoped snapshot');

  await page.evaluate(async () => {
    const imported = await personalSaveLibrary.importData(original, '同一根节点的本地导入');
    await eventBus.request('app:timeline-import-file', { file: new File([JSON.stringify(original)], 'local-import.json', { type: 'application/json' }) });
    await eventBus.request('app:load-personal-save', { id: imported.id });
  });
  assert.deepEqual(await page.evaluate(() => {
    const binding = cloudSave._readBinding(cloudSave.syncState.active);
    return { id: binding.id, forceNew: binding.forceNew, saveKey: cloudSave.syncState.active.saveKey };
  }), { id: '', forceNew: true, saveKey: triggerChecks.root });
  ok('loading a local import with the same timeline root clears the previous cloud binding');
  await ready();
  await library.getByRole('button', { name: '云端管理', exact: true }).click(); await ready();

  await context.addCookies([cookie('cloud-test-b')]);
  await library.getByRole('button', { name: '刷新', exact: true }).click(); await ready();
  assert.equal(await library.locator('[data-cloud-id]').count(), 0); assert.match(await library.locator('#current-info').innerText(), /云端测试 B/);
  assert.match(await library.locator('#current-info').innerText(), /0 KB/);
  assert.equal(await page.evaluate(() => cloudSave.syncState.active.userId), 'cloud-test-b');
  await context.clearCookies();
  await library.getByRole('button', { name: '刷新', exact: true }).click(); await status('请先登录');
  assert.equal(await library.locator('[data-cloud-id]').count(), 0); assert.equal(page.url(), server.url + '/');
  assert.deepEqual(errors, []);
  ok('refresh switches to the current account and clears stale cloud cards; signed-out users keep local progress and get a visible login message');
  console.log(`Save library cloud regression: ${passed} groups passed`);
} finally { await browser?.close(); await server.close(); }
