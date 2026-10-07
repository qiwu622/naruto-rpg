import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reports = path.join(root, 'reports', 'tactical-combat');
await mkdir(reports, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/components.css"><main id="app" class="standalone-mode is-mobile-view"></main></html>');
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('outside');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/css' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    const { combatSystem } = await import('/js/systems/combat-system.js');
    await import('/js/ui/combat-arena.js');
    stateManager.state = stateManager.getDefaultState();
    stateManager.saveUIPrefs = async () => { window.preferenceSaves++; };
    Object.assign(stateManager.state, { '玩家·姓名': '望月', '玩家·忍阶': '下忍', '玩家·存活': '是', '属性·生命力': 100, '属性·当前生命力': 100, '属性·查克拉': 100, '属性·当前查克拉': 100 });
    Object.assign(window, { stateManager, appShell, eventBus, combatSystem, preferenceSaves: 0, toasts: [], clears: 0 });
    appShell.init(document.querySelector('#app'));
    appShell._showToast = value => toasts.push(value);
    eventBus.on('combat:select-action', ({ moveId }) => { if (!moveId) clears++; });
    appShell.renderSinglePage('训练场的风吹过树梢，你停下脚步，等待同伴。');
  });
  if (await page.locator('#btn-panel').getAttribute('aria-pressed') === 'true') await page.locator('#btn-panel').click();
  assert.equal(await page.locator('combat-arena').count(), 0);
  assert.equal(await page.locator('#btn-combat').getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => { combatSystem.processInstruction({ state: 'start', enemy_name: '训练对手' }); });
  assert.equal(await page.locator('combat-arena').count(), 0, 'AI state must never open a closed panel');
  assert.deepEqual(await page.evaluate(() => toasts), []);
  await page.evaluate(() => stateManager.setSub('_combat', null));
  await page.locator('#btn-combat').click();
  await page.locator('combat-arena .waiting-scene').waitFor();
  assert.equal(await page.locator('#btn-combat').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => stateManager.getSub('_combat')), null, 'opening panel does not create an enemy or spend resources');
  await page.locator('combat-arena').screenshot({ path: path.join(reports, 'manual-open-waiting-mobile.png') });
  console.log('PASS default closed, no AI auto-popup, manual opening has waiting state');

  await page.evaluate(() => {
    appShell._setProcessing(true);
    combatSystem.processInstruction({ state: 'start', enemy_name: '训练对手', objective: '切磋' });
    appShell.renderSinglePage('对手摆开架势，双方正式开始切磋。');
  });
  await page.locator('combat-arena [data-move]').first().waitFor();
  assert.equal(await page.locator('#btn-combat').isDisabled(), true);
  assert.equal(await page.locator('combat-arena [data-close-panel]').isDisabled(), true);
  assert.equal(await page.locator('combat-arena [data-move]:not(:disabled)').count(), 0);
  await page.evaluate(() => eventBus.emit('combat:panel-close'));
  assert.equal(await page.locator('combat-arena').count(), 1, 'cannot change prompt ownership while processing');
  await page.evaluate(() => appShell._setProcessing(false));
  await page.waitForFunction(() => !document.querySelector('combat-arena').shadowRoot.querySelector('[data-move]').disabled);
  assert.equal(await page.locator('combat-arena').count(), 1);
  await page.locator('combat-arena [data-close-panel]').click();
  assert.equal(await page.locator('combat-arena').count(), 0);
  assert.equal(await page.evaluate(() => stateManager.getSub('_combat').is_active), true, 'closing preserves recorded encounter');
  assert.equal(await page.evaluate(() => clears), 1);
  await page.evaluate(() => eventBus.emit('combat:started', { enemy_name: '训练对手' }));
  assert.equal(await page.locator('combat-arena').count(), 0);
  console.log('PASS newly mounted busy arena is disabled, completion unlocks, close stays closed');

  await page.evaluate(() => {
    const ui = stateManager.getSub('_ui');
    ui.settings.tacticalCombat = true;
    stateManager.update([{ key: '_ui.settings', op: '=', value: ui.settings }]);
  });
  assert.equal(await page.locator('combat-arena').count(), 1, 'settings gateway nested update opens panel too');
  await page.evaluate(() => {
    eventBus.emit('state:restored');
  });
  assert.equal(await page.locator('combat-arena').count(), 1);
  assert.equal(await page.locator('#btn-combat').getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => {
    const ui = stateManager.getSub('_ui');
    ui.settings.tacticalCombat = false;
    stateManager.setSub('_ui', ui);
    eventBus.emit('state:restored');
  });
  assert.equal(await page.locator('combat-arena').count(), 0);
  assert.equal(await page.locator('#btn-combat').getAttribute('aria-pressed'), 'false');
  assert.ok(await page.evaluate(() => preferenceSaves >= 2));
  assert.deepEqual(errors, []);
  console.log('PASS restored open/closed preference matches button and panel');
  console.log('Manual combat panel UI regression: 3 groups passed.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
