import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';

const serverApp = express();
serverApp.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><main id="app"></main>'));
serverApp.use(express.static(process.cwd()));
const server = await new Promise(resolve => { const s = serverApp.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let passed = 0;
const ok = message => { passed++; console.log(`PASS ${message}`); };

async function mount(page, seed = false) {
  await page.evaluate(async seed => {
    const { NarutoRPGApp } = await import('/js/app.js');
    const { MessagePipeline } = await import('/js/core/pipeline.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
    const { localSaveLibrary, PERSONAL_SAVE_KIND } = await import('/js/core/save-library.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    const { authClient } = await import('/js/core/auth-client.js');
    const { makeContinuationFixture } = await import('/scripts/helpers/continuation-save-fixture.mjs');
    authClient._checked = true; authClient._user = null;
    appShell.init(document.querySelector('#app'));
    await timelineSystem.init();
    if (seed) await timelineSystem.importTimeline(makeContinuationFixture(10));
    const app = new NarutoRPGApp();
    app.pipeline = new MessagePipeline({ timelineSystem });
    app._bindEvents();
    await app._checkSavedGame();
    Object.assign(window, { app, eventBus, stateManager, timelineSystem, personalSaveLibrary, localSaveLibrary, PERSONAL_SAVE_KIND });
    window.exportCalls = 0;
    const getExportData = timelineSystem.captureArchive.bind(timelineSystem);
    timelineSystem.captureArchive = async (...args) => {
      exportCalls++;
      // Hold the real archive transaction seam to make a slow large-save operation
      // deterministic; after release the actual export and IndexedDB run.
      if (window.exportGate) await window.exportGate;
      return getExportData(...args);
    };
    window.holdExport = () => { window.exportGate = new Promise(resolve => { window.releaseExport = () => { window.exportGate = null; resolve(); }; }); };
  }, seed);
}

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(origin);
  await mount(page, true);
  await page.reload();
  await mount(page);
  const panel = page.locator('naruto-save-library');
  const ready = () => page.waitForFunction(() => {
    const panel = document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library');
    return panel && !panel.busy && panel.current;
  });

  // A second click on the library entry is natural when the first click has
  // not displayed anything. The very first Save click must not race an
  // invisible migration backup started by that navigation.
  await page.evaluate(() => holdExport());
  await page.locator('#btn-save-library').click();
  await page.locator('#btn-save-library').click({ force: true });
  await ready();
  await panel.locator('#capture').click();
  const observed = await page.evaluate(() => {
    const panel = document.querySelector('game-modal').shadowRoot.querySelector('naruto-save-library');
    return { generating: app.pipeline.isProcessing, switching: Boolean(app._saveTransition), message: panel.shadowRoot.querySelector('#status').textContent, calls: exportCalls };
  });
  console.log(`First save after reload: ${JSON.stringify(observed)}`);
  await page.evaluate(() => releaseExport());
  assert.doesNotMatch(observed.message, /正文正在生成或存档正在切换/);
  await page.waitForFunction(() => document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library')?.shadowRoot.querySelector('#status')?.textContent.includes('个人档已保存'));
  assert.equal(await page.locator('naruto-save-library').count(), 1);
  assert.equal(await page.evaluate(() => exportCalls), 1, 'navigation does not trigger another full backup');
  ok('first save after reload and repeated library-entry clicks performs one explicit backup without false generation errors');

  await panel.locator('#close').click();
  const callsBefore = await page.evaluate(() => exportCalls);
  await page.locator('#btn-save-library').click();
  await ready();
  assert.equal(await page.evaluate(() => exportCalls), callsBefore);
  assert.equal(await page.evaluate(() => Boolean(app._saveTransition)), false);
  ok('reopening the library only lists archives and does not start a hidden save or lock gameplay');

  await page.evaluate(() => { app.pipeline.isProcessing = true; });
  await panel.locator('#capture').click();
  await ready();
  assert.match(await panel.locator('#status').innerText(), /正在生成正文或更新变量/);
  assert.equal(await page.evaluate(() => exportCalls), callsBefore);
  await page.evaluate(() => { app.pipeline.isProcessing = false; });
  ok('a real narrative generation still blocks archive mutation');

  await page.evaluate(() => holdExport());
  await panel.locator('#capture').click();
  await page.waitForFunction(() => exportCalls > 1 && app._saveTransition);
  await panel.locator('#close').click();
  await page.locator('#btn-save-library').click();
  await ready();
  await panel.locator('#capture').click();
  await ready();
  assert.match(await panel.locator('#status').innerText(), /存档.*(?:进行|保存|处理)|正在保存/);
  assert.doesNotMatch(await panel.locator('#status').innerText(), /正文正在生成/);
  await page.evaluate(() => releaseExport());
  await page.waitForFunction(() => !app._saveTransition);
  await panel.locator('#capture').click(); await ready();
  assert.match(await panel.locator('#status').innerText(), /个人档已保存/);
  ok('reopening during a genuine save reports saving accurately and saving works again when it completes');

  await page.evaluate(() => {
    window.capture = personalSaveLibrary.capture.bind(personalSaveLibrary);
    personalSaveLibrary.capture = async () => { throw new Error('模拟磁盘空间不足'); };
  });
  await panel.locator('#capture').click(); await ready();
  assert.match(await panel.locator('#status').innerText(), /模拟磁盘空间不足/);
  assert.equal(await page.evaluate(() => Boolean(app._saveTransition)), false);
  await page.evaluate(() => { personalSaveLibrary.capture = capture; });
  await panel.locator('#capture').click(); await ready();
  assert.match(await panel.locator('#status').innerText(), /个人档已保存/);
  ok('failed persistence releases the operation and a later explicit retry succeeds');

  await panel.locator('#new-game').click();
  await page.getByRole('dialog', { name: '保留旧档并开始新冒险' }).waitFor();
  await page.keyboard.press('Escape');
  await ready();
  assert.equal(await page.evaluate(() => Boolean(app._saveTransition)), false);
  assert.equal(await page.evaluate(async () => (await timelineSystem.getCurrentNode()).turn_number), 10);
  await panel.locator('#capture').click(); await ready();
  assert.match(await panel.locator('#status').innerText(), /个人档已保存/);
  ok('dismissing new-game confirmation leaves progress intact and releases the operation');
  console.log(`Save library busy regression: ${passed} groups passed; real UI and IndexedDB, no model calls.`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
