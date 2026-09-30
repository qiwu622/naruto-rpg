import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'reports', 'save-library-if');
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/components.css"><style>body{background:#15171b;color:#eee;margin:0}#app{min-height:100vh}</style><main id="app"></main>');
    if (pathname === '/auth/me') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"if-test-a","username":"IF 测试"}');
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { NarutoRPGApp } = await import('/js/app.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
    const { localSaveLibrary, PERSONAL_SAVE_KIND } = await import('/js/core/save-library.js');
    const { authClient } = await import('/js/core/auth-client.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    const { assertTimelineSave } = await import('/js/core/timeline-save-schema.js');
    const { SHINOBI_DAILY_EXAMPLE } = await import('/js/core/shinobi-daily.js');
    authClient._user = { id: 'if-test-a' }; authClient._checked = true;
    Object.assign(window, { stateManager, timelineSystem, personalSaveLibrary, localSaveLibrary, PERSONAL_SAVE_KIND, eventBus, assertTimelineSave });
    appShell.init(document.querySelector('#app'));
    await timelineSystem.init();
    window.app = new NarutoRPGApp();
    app.pipeline = { isProcessing: false, setHistory: history => { window.aiHistory = history; }, clearHistory: () => {} };
    app._bindEvents();
    window.appendStory = async (turn, marker, text) => {
      stateManager.setSub('marker', marker);
      const history = [...await timelineSystem._reconstructChatHistory(await timelineSystem.getCurrentNode()), { role: 'user', content: `行动${turn}` }, { role: 'assistant', content: text }];
      return timelineSystem.createNode({ turnNumber: turn, playerInput: `行动${turn}`, aiResponse: text, cleanResponse: text, stateSnapshot: stateManager.snapshot(), chatHistory: history, shinobiDaily: { ...structuredClone(SHINOBI_DAILY_EXAMPLE), issue: `第 ${turn} 号` } });
    };
    stateManager.update([{ key: '玩家·姓名', op: '=', value: '起物' }, { key: '世界·地点', op: '=', value: '木叶隐村' }]);
    stateManager.setSub('marker', 'root');
    window.rootNode = await timelineSystem.createRootNode({ summary: '清晨的木叶，忍者学校传来钟声。', stateSnapshot: stateManager.snapshot(), chatHistory: [{ role: 'assistant', content: '开场正文' }] });
    window.middleNode = await appendStory(2, 'middle', '你在任务大厅遇见带队上忍，收到两条去向不同的线索。');
    window.mainHead = await appendStory(3, 'main-future', '你离开村子，走上通往波之国的道路。');
    window.initialHistory = await timelineSystem._reconstructChatHistory(middleNode);
    window.initialBranch = await timelineSystem.getActiveBranch();
    await eventBus.request('app:open-saves', { kind: 'if_lines' });
  });
  const library = page.locator('naruto-save-library');
  const ready = () => page.waitForFunction(() => {
    const panel = document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library');
    return panel && !panel.busy;
  });
  const statusReady = async text => { await ready(); assert.ok((await library.locator('#status').innerText()).includes(text), await library.locator('#status').innerText()); };
  await library.getByRole('button', { name: '创建 IF 线', exact: true }).click();
  await page.getByRole('button', { name: '创建并切换', exact: true }).click();
  assert.equal(await page.locator('#line-name').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await library.count(), 1);
  await library.getByRole('button', { name: '创建 IF 线', exact: true }).click();
  await page.locator('#line-name').fill('留在木叶');
  await page.locator('#line-description').fill('如果当时没有离村，而是追查任务大厅的线索。');
  await page.locator('#line-origin').selectOption(await page.evaluate(() => middleNode.id));
  await page.getByRole('button', { name: '创建并切换', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library')?.busy);
  assert.match(await library.locator('#status').innerText(), /IF 线已创建/);
  const fork = await page.evaluate(async () => {
    window.ifBranch = await timelineSystem.getActiveBranch();
    window.anchor = await timelineSystem.getCurrentNode();
    assertTimelineSave(await timelineSystem.getExportData());
    return { parent: anchor.parent_id, depth: anchor.depth, turn: anchor.turn_number, marker: stateManager.snapshot().marker, history: aiHistory, main: await stateManager.dbGet('timeline_branches', 'branch_main'), anchorFlag: anchor.branch_anchor, current: stateManager.getSub('_meta'), count: (await timelineSystem.getAllNodes()).length };
  });
  assert.equal(fork.parent, await page.evaluate(() => middleNode.id));
  assert.equal(fork.depth, 2); assert.equal(fork.turn, 2); assert.equal(fork.count, 4); assert.equal(fork.marker, 'middle'); assert.ok(fork.anchorFlag);
  assert.deepEqual(fork.history, await page.evaluate(() => initialHistory));
  assert.equal(fork.main.head_node_id, await page.evaluate(() => mainHead.id)); assert.equal(fork.main.node_count, 3); assert.equal(fork.main.is_active, false);
  ok('historical fork restores the exact turn/state/history without a fabricated turn or overwriting the main future; Escape cancels only the child form');

  const ifId = await page.evaluate(() => ifBranch.id);
  const ifCard = library.locator(`[data-branch-id="${ifId}"]`);
  await ifCard.getByRole('button', { name: '编辑线路', exact: true }).click();
  const untrustedName = '留在木叶 "IF" <img src=x onerror=alert(1)>';
  await page.locator('#line-name').fill(untrustedName);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await ifCard.locator('h3').filter({ hasText: untrustedName }).waitFor();
  assert.equal(await ifCard.locator('img').count(), 0);
  await ifCard.getByRole('button', { name: '编辑线路', exact: true }).click();
  assert.equal(await page.locator('#line-name').inputValue(), untrustedName);
  await page.locator('#line-name').fill('留在木叶');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await library.getByRole('searchbox', { name: '搜索存档' }).fill('任务大厅');
  assert.equal(await library.locator('.entry').count(), 1);
  await library.getByRole('searchbox', { name: '搜索存档' }).fill('');
  assert.equal(await library.locator('.entry').count(), 2);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'if-desktop.png') });
  ok('IF names/notes can be edited and searched; HTML/quoted input stays plain text in cards and forms');

  await library.locator('[data-branch-id="branch_main"]').getByRole('button', { name: '切换', exact: true }).click();
  await statusReady('已切换线路');
  assert.equal(await page.evaluate(() => stateManager.snapshot().marker), 'main-future');
  assert.equal(await page.evaluate(() => aiHistory.at(-1).content), '你离开村子，走上通往波之国的道路。');
  await ifCard.getByRole('button', { name: '切换', exact: true }).click();
  await statusReady('已切换线路');
  assert.equal(await page.evaluate(() => stateManager.snapshot().marker), 'middle');
  await page.evaluate(async () => { window.ifHead = await appendStory(3, 'if-future', '你留下来，发现任务单背面有一行暗号。'); });
  const historyAfterCompression = await page.evaluate(async () => {
    const { compressTimelineNode } = await import('/js/core/timeline-node-codec.js');
    const compressed = await compressTimelineNode(await stateManager.dbGet('timeline_nodes', anchor.id));
    await stateManager.dbPut('timeline_nodes', compressed);
    return timelineSystem._reconstructChatHistory({ ...ifHead, chat_history: null });
  });
  assert.deepEqual(historyAfterCompression.slice(0, 3), await page.evaluate(() => initialHistory));
  assert.equal(historyAfterCompression.at(-1).content, '你留下来，发现任务单背面有一行暗号。');
  assert.ok(!historyAfterCompression.some(item => item.content.includes('波之国')));
  await library.getByRole('button', { name: '刷新', exact: true }).click(); await ready();
  ok('switching preserves each future and reconstructs only the selected context through a compressed IF anchor');

  await ifCard.getByRole('button', { name: '从此分叉', exact: true }).click();
  await page.locator('#line-name').fill('暗号的另一种解读');
  await page.getByRole('button', { name: '创建并切换', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library')?.busy);
  assert.match(await library.locator('#status').innerText(), /IF 线已创建/);
  const childId = await page.evaluate(async () => (await timelineSystem.getActiveBranch()).id);
  assert.equal(await library.locator(`[data-branch-id="${childId}"]`).getByRole('button', { name: '设为主线', exact: true }).isDisabled(), true);
  await library.getByRole('button', { name: '保存当前个人档', exact: true }).click();
  await statusReady('个人档已保存');
  const roundtrip = await page.evaluate(async () => {
    window.savedIF = (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).find(entry => entry.reason === 'manual');
    window.ifPack = await localSaveLibrary.readPackage(savedIF.id, PERSONAL_SAVE_KIND);
    const { encodeTimelineSave, decodeTimelineSaveFile } = await import('/js/core/timeline-file-codec.js');
    const encoded = await encodeTimelineSave(ifPack, { compression: 'gzip' });
    const data = await decodeTimelineSaveFile(encoded.blob);
    assertTimelineSave(data.payload);
    const before = JSON.stringify(await stateManager.dbGet('timeline_meta', 'root'));
    await personalSaveLibrary.importData(data);
    return { names: data.payload.branches.map(branch => branch.name), unchanged: before === JSON.stringify(await stateManager.dbGet('timeline_meta', 'root')), entryCount: savedIF.branchCount };
  });
  assert.deepEqual(new Set(roundtrip.names), new Set(['主线', '留在木叶', '暗号的另一种解读'])); assert.equal(roundtrip.entryCount, 2); assert.ok(roundtrip.unchanged);
  await page.setViewportSize({ width: 390, height: 844 });
  await library.locator('#workspace').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'if-mobile.png') });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await library.evaluate(el => {
      const bounds = el.getBoundingClientRect();
      const workspace = el.shadowRoot.querySelector('.workspace');
      return bounds.left >= 0 && bounds.right <= innerWidth && workspace.scrollWidth <= workspace.clientWidth + 1;
    }), `no horizontal overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  ok('nested IF lines round-trip in complete gzip saves without changing the working game; cards fit 320/390/768px screens');

  const aborted = await page.evaluate(async () => {
    const before = JSON.stringify(await timelineSystem.getExportData());
    const live = JSON.stringify(stateManager.snapshot());
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'timeline_branches') throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, value, ...args);
    };
    const failures = [];
    try {
      for (const action of [{ action: 'switch', branchId: 'branch_main' }, { action: 'create', name: '失败分支', fromNodeId: middleNode.id }]) {
        try { await eventBus.request('app:if-line-action', action); } catch (error) { failures.push(error.message); }
      }
    } finally { IDBObjectStore.prototype.put = original; }
    const after = JSON.stringify(await timelineSystem.getExportData());
    // exported_at is a clock field, not timeline state.
    const clean = value => { const data = JSON.parse(value); delete data.exported_at; return data; };
    const differences = [];
    const compare = (a, b, at = '') => {
      if (differences.length >= 8 || JSON.stringify(a) === JSON.stringify(b)) return;
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[key], b[key], `${at}.${key}`);
      } else differences.push({ at, id: /^\.nodes\.(\d+)/.test(at) ? clean(before).nodes[Number(at.split('.')[2])]?.id : undefined, before: a, after: b });
    };
    compare(clean(before), clean(after));
    return { failures, differences, same: JSON.stringify(clean(before)) === JSON.stringify(clean(after)), runtime: live === JSON.stringify(stateManager.snapshot()) };
  });
  assert.equal(aborted.failures.length, 2); assert.ok(aborted.same, JSON.stringify(aborted.differences)); assert.ok(aborted.runtime);
  ok('real IndexedDB aborts leave graph, branch flags, metadata and live state unchanged for create and switch');

  const guards = await page.evaluate(async () => {
    const before = JSON.stringify(stateManager.getSub('_meta'));
    app.pipeline.isProcessing = true;
    let generating = '', multiplayer = '';
    try { await eventBus.request('app:if-line-action', { action: 'switch', branchId: 'branch_main' }); } catch (e) { generating = e.message; }
    app.pipeline.isProcessing = false;
    app._multiplayerOverlay = { panel: { controller: { state: { roomId: 'active-room' } } } };
    try { await eventBus.request('app:if-line-action', { action: 'create', fromNodeId: middleNode.id, name: '非法并发' }); } catch (e) { multiplayer = e.message; }
    app._multiplayerOverlay = null;
    return { generating, multiplayer, same: before === JSON.stringify(stateManager.getSub('_meta')) };
  });
  assert.match(guards.generating, /正在生成/); assert.match(guards.multiplayer, /先退出联机/); assert.ok(guards.same);
  ok('personal IF operations cannot race model generation or change an active multiplayer room');

  await ifCard.getByRole('button', { name: '删除 IF 线', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await library.getByRole('button', { name: '刷新', exact: true }).click(); await ready();
  assert.equal(await library.locator('.entry').count(), 3);
  await ifCard.getByRole('button', { name: '删除 IF 线', exact: true }).click();
  await page.getByRole('button', { name: '备份并删除', exact: true }).click();
  await statusReady('线路已更新');
  assert.equal(await library.locator('.entry').count(), 1);
  const deleted = await page.evaluate(async () => {
    assertTimelineSave(await timelineSystem.getExportData());
    return { branch: stateManager.getSub('_meta').active_branch, id: stateManager.getSub('_meta').current_node_id, marker: stateManager.snapshot().marker, backup: (await localSaveLibrary.readPackage(savedIF.id, PERSONAL_SAVE_KIND)).payload.branches.length };
  });
  assert.equal(deleted.branch, 'branch_main'); assert.equal(deleted.id, await page.evaluate(() => middleNode.id)); assert.equal(deleted.marker, 'middle'); assert.equal(deleted.backup, 3);
  await library.getByRole('button', { name: '回到最新进度', exact: true }).click();
  await statusReady('已切换线路');
  assert.equal(await page.evaluate(() => stateManager.snapshot().marker), 'main-future');
  await page.evaluate(() => eventBus.request('app:load-personal-save', { id: savedIF.id }));
  assert.equal(await library.count(), 1);
  await library.getByRole('button', { name: '刷新', exact: true }).click(); await ready();
  assert.equal(await library.locator('.entry').count(), 3);
  ok('delete cancellation preserves every line; deletion cascades and restores its ancestor; same-branch latest and full-save recovery both work');

  await ifCard.getByRole('button', { name: '设为主线', exact: true }).click();
  await page.getByRole('button', { name: '备份并设为主线', exact: true }).click();
  await statusReady('线路已更新');
  const promoted = await page.evaluate(async () => {
    const data = await timelineSystem.getExportData(); assertTimelineSave(data);
    return { main: data.branches.find(branch => branch.id === 'branch_main'), future: data.nodes.find(node => node.id === mainHead.id), nodes: data.nodes.length, branches: data.branches.length };
  });
  assert.equal(promoted.main.head_node_id, await page.evaluate(() => ifHead.id)); assert.notEqual(promoted.future.branch_id, 'branch_main'); assert.equal(promoted.nodes, 6); assert.equal(promoted.branches, 3);
  ok('promoting an IF line preserves the old main future and nested IF descendants in a valid graph');

  await library.getByRole('tab', { name: /个人存档/ }).click(); await ready();
  await library.locator('#workspace').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'personal-desktop.png') });
  await library.locator(`[data-save-id="${await page.evaluate(() => savedIF.id)}"]`).getByRole('button', { name: '查看快照', exact: true }).click();
  await library.locator('#preview').waitFor({ state: 'visible' });
  assert.match(await library.locator('#snapshot-story').innerText(), /暗号/);
  assert.match(await library.locator('#snapshot-daily').innerText(), /第 3 号/);
  await library.getByRole('button', { name: '收起快照', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await library.locator('#workspace').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'personal-mobile.png') });
  const downloadPromise = page.waitForEvent('download');
  await library.locator(`[data-save-id="${await page.evaluate(() => savedIF.id)}"]`).getByRole('button', { name: '导出', exact: true }).click();
  assert.match((await downloadPromise).suggestedFilename(), /\.json(?:\.gz)?$/);
  ok('personal cards preview the stored body and daily and export complete IF packages on mobile');

  const persisted = await page.evaluate(async () => ({ meta: await stateManager.dbGet('timeline_meta', 'root'), names: (await timelineSystem.getAllBranches()).map(branch => branch.name).sort() }));
  await page.reload();
  const restored = await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    await timelineSystem.init();
    const { assertTimelineSave } = await import('/js/core/timeline-save-schema.js');
    assertTimelineSave(await timelineSystem.getExportData());
    return { meta: await stateManager.dbGet('timeline_meta', 'root'), names: (await timelineSystem.getAllBranches()).map(branch => branch.name).sort() };
  });
  assert.deepEqual(restored, persisted);
  ok('promoted/nested IF graphs persist across a complete page reload');
  assert.deepEqual(errors, []);
  console.log(`\n${passed} save-library IF browser regression groups passed; no model calls.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
