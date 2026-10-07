import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startCloudSaveTestServer } from './helpers/cloud-save-test-server.mjs';

const server = await startCloudSaveTestServer({ staticFiles: true });
const output = 'reports/app-cloud';
await mkdir(output, { recursive: true });
let browser;
const passed = [];
const ok = label => { passed.push(label); console.log(`PASS ${label}`); };
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.cloudMode = 'hang'; window.cloudRequests = []; window.cloudCancels = 0;
    window.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: {
      NarutoCloud: { async getSession() { return { user: { id: 'cloud-test-a', username: '云端测试忍者' } }; }, async clearSession() {} },
      NarutoHttp: { async cancel() { window.cloudCancels++; }, async request(options, callback) {
        window.cloudRequests.push(options.url);
        if (window.cloudMode === 'offline') throw new Error('fixture offline');
        // Intentionally never deliver headers. Native auth's 5s deadline owns cancellation.
      } }
    } };
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  const startup = await page.evaluate(async () => {
    const { NarutoRPGApp } = await import('/js/app.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    const { authClient } = await import('/js/core/auth-client.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    Object.assign(window, { stateManager, timelineSystem, personalSaveLibrary, eventBus, authClient, appShell });
    window.app = new NarutoRPGApp();
    const started = performance.now(); await app.init();
    return { elapsed: performance.now() - started, ready: app._state };
  });
  assert.equal(startup.ready, 'ready'); assert.ok(startup.elapsed < 3000, JSON.stringify(startup));
  await page.waitForFunction(() => cloudRequests.some(url => url.endsWith('/auth/me')));
  ok('the actual shared App initializes while the optional native cloud request is still hanging');
  await page.evaluate(async () => {
    stateManager.update([{ key: '玩家·姓名', op: '=', value: '断网测试忍者' }]);
    await timelineSystem.createRootNode({ summary: '木叶清晨', stateSnapshot: stateManager.snapshot(), chatHistory: [{ role: 'assistant', content: '木叶的清晨。' }] });
    await eventBus.request('app:open-saves');
  });
  const library = page.locator('naruto-save-library');
  await page.waitForFunction(() => { const p = document.querySelector('game-modal')?.shadowRoot?.querySelector('naruto-save-library'); return p && !p.busy; });
  assert.equal(await library.locator('#capture').isEnabled(), true);
  assert.equal(await library.locator('#import').isEnabled(), true);
  await library.locator('#cloud-manager').click();
  await library.locator('app-cloud-panel #local').click();
  await page.waitForFunction(() => { const p = document.querySelector('game-modal')?.shadowRoot?.querySelector('naruto-save-library'); return p && !p.cloudView && !p.busy; });
  assert.equal(await library.locator('#capture').isEnabled(), true);
  assert.equal(await library.locator('#close').isEnabled(), true);
  ok('cloud list loading takes no global UI lock; returning to local saves and closing stay available before the timeout');
  await page.waitForFunction(() => cloudCancels > 0);
  await page.evaluate(() => { cloudMode = 'offline'; });
  await library.locator('app-cloud-panel #retry').click();
  await page.waitForFunction(() => document.querySelector('game-modal')?.shadowRoot?.querySelector('naruto-save-library')?.shadowRoot?.querySelector('app-cloud-panel')?.shadowRoot?.querySelector('#state').textContent.includes('无法连接'));
  await page.screenshot({ path: output + '/offline-saves-mobile.png' });
  const viewport = await library.evaluate(element => ({ width: element.clientWidth, scroll: element.shadowRoot.querySelector('.library').scrollWidth }));
  assert.ok(viewport.scroll <= viewport.width + 1, JSON.stringify(viewport));
  await library.locator('#close').click();
  await page.evaluate(async () => {
    window.offlineRoot = (await timelineSystem.getCurrentNode()).id;
    for (const turn of [2, 3]) {
      const parent = await timelineSystem.getCurrentNode();
      stateManager.update([{ key: '系统·回合数', op: '=', value: turn }]);
      await timelineSystem.createNode({ turnNumber: turn, playerInput: `本地行动 ${turn}`, aiResponse: `本地回合 ${turn} 正文`, cleanResponse: `本地回合 ${turn} 正文`, stateSnapshot: stateManager.snapshot(), chatHistory: [{ role: 'user', content: `本地行动 ${turn}` }, { role: 'assistant', content: `本地回合 ${turn} 正文` }] });
      eventBus.emit('pipeline:complete', { timelineNodeId: (await timelineSystem.getCurrentNode()).id });
    }
    window.archive = await personalSaveLibrary.capture({ label: '断网三回合' });
    await timelineSystem.jumpToNode(offlineRoot);
    await eventBus.request('app:load-personal-save', { id: archive.id });
  });
  assert.equal(await page.evaluate(async () => (await timelineSystem.getCurrentNode()).turn_number), 3);
  assert.equal(await page.evaluate(() => authClient.getUser().id), 'cloud-test-a');
  ok('cloud failures do not clear account identity or stop local turn commits, archive capture and restoring the previous archive');
  await page.evaluate(() => app._openProfilePanel({ loadRemote: false }));
  await page.locator('app-cloud-panel #enabled').uncheck();
  const before = await page.evaluate(() => cloudRequests.length);
  await page.evaluate(async () => { await authClient.checkAuth(true); });
  assert.equal(await page.evaluate(() => cloudRequests.length), before);
  assert.equal(await page.locator('#btn-export-save').isEnabled(), true);
  assert.equal(await page.locator('#btn-import-cloud').isEnabled(), true);
  await page.screenshot({ path: output + '/profile-cloud-mobile.png' });
  await page.locator('app-cloud-panel #local').click();
  assert.equal(await page.locator('game-modal').count(), 0);
  assert.equal(await page.locator('.topbar-btn--multiplayer').count(), 1);
  assert.deepEqual(errors, []);
  ok('the mobile profile exposes optional cloud controls; pause stops requests while local export/import and returning to the game remain usable');
  await page.evaluate(() => { app._stopAppCloudChecks?.(); app._stopAppUpdateChecks?.(); });
  await writeFile(output + '/verification.json', JSON.stringify({ startup, passed, errors, viewport }, null, 2));
} finally { await browser?.close(); await server.close(); }
console.log(`App cloud UI regression: ${passed.length} groups passed`);
