import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reports = path.join(root, 'reports', 'npc-progression');
await mkdir(reports, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/layout.css"><div id="app"><info-panel></info-panel></div></html>'
    );
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('outside');
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const { relationshipSystem } = await import('/js/systems/relationship-system.js');
    const { imageStudio } = await import('/js/core/image-studio/index.js');
    await import('/js/ui/panel.js');
    imageStudio.read = async () => ({ binding: null, assets: [] });
    imageStudio.subscribe = () => () => {};
    relationshipSystem.ensureVisualProfile = () => ({ visual_subject_id: 'npc-test', visual_profile: {} });
    Object.assign(window, { stateManager, relationshipSystem });
    stateManager.reset();
    relationshipSystem.processInstruction({ npc: '训练中的同伴', combat_stats: {
      rank: '下忍', chakra_max: 150, chakra: 40, jutsu: [{ name: '自创·风刃', power: 24, mastery: 20 }]
    } });
    document.querySelector('info-panel').showRelModal('训练中的同伴');
  });
  const modal = page.locator('game-modal');
  await modal.locator('.npc-stat-val').first().waitFor();
  const before = await modal.locator('.npc-stat-val').first().textContent();
  assert.equal(before, '40/150');
  await page.evaluate(() => relationshipSystem.processInstruction({ npc: '训练中的同伴', combat_stats: { chakra_max: 156 } }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await modal.locator('.npc-stat-val').first().textContent(), '40/156', 'an already open dossier must update without reopening');
  console.log('PASS open dossier refreshes after a relationship update');

  const portraitControls = modal.locator('#npc-portrait-controls');
  await portraitControls.evaluate(el => { el.dataset.keepDraft = 'preserve'; });
  const scrollTop = await modal.locator('.modal').evaluate(el => { el.scrollTop = 100; return el.scrollTop; });
  await page.evaluate(() => relationshipSystem.processInstruction({ npc: '训练中的同伴', combat_stats: {
    chakra_max: 240, chakra: 120, speed: 80, ninjutsu: 70,
    jutsu: [{ name: '自创·风刃', mastery: 80 }, { name: '自创·水矢', power: 40, mastery: 30 }]
  } }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await modal.locator('.npc-stat-val').first().textContent(), '120/240');
  assert.equal(await portraitControls.getAttribute('data-keep-draft'), 'preserve', 'refreshing combat info must not replace portrait controls');
  assert.equal(await modal.locator('.modal').evaluate(el => el.scrollTop), scrollTop, 'an update must preserve dossier scroll position');
  assert.match(await modal.locator('[data-npc-combat-rating]').textContent(), /级/);
  assert.equal(await modal.locator('.npc-jutsu-card').count(), 2);
  assert.equal(await modal.locator('[data-stat="mastery"] strong').first().textContent(), '80');
  await modal.locator('.modal').evaluate(el => { el.scrollTop = 0; });
  await modal.screenshot({ path: path.join(reports, 'npc-desktop.png') });
  console.log('PASS growth, recovery, learned techniques and combat rating stay visible');

  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await modal.locator('.modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  await modal.screenshot({ path: path.join(reports, 'npc-mobile.png') });
  await modal.locator('.npc-jutsu-card').first().scrollIntoViewIfNeeded();
  await modal.screenshot({ path: path.join(reports, 'npc-mobile-combat.png') });
  await page.evaluate(() => stateManager.restore(stateManager.getDefaultState()));
  assert.equal(await modal.count(), 0, 'restoring a different save must close the old NPC dossier');
  await page.evaluate(() => relationshipSystem.processInstruction({ npc: '另一位同伴', combat_stats: { rank: '中忍' } }));
  assert.deepEqual(errors, []);
  console.log('PASS mobile layout and dossier cleanup on save restore');

  await page.evaluate(async () => {
    const { appShell } = await import('/js/ui/app-shell.js');
    document.querySelector('#app').replaceChildren();
    appShell.init(document.querySelector('#app'));
    appShell.renderSinglePage('本地测试：同伴完成修行，打开面板查看新的属性。');
    appShell._closeRightPanel();
  });
  await page.locator('#btn-panel').click();
  await page.locator('info-panel .panel-close-btn-mobile').click();
  await page.waitForFunction(() => !document.querySelector('.app-panel').classList.contains('panel-open'), null, { timeout: 3000 });
  await page.locator('#chat-input').fill('关闭角色面板后继续输入。');
  assert.equal(await page.locator('#chat-input').inputValue(), '关闭角色面板后继续输入。');
  assert.deepEqual(errors, []);
  console.log('PASS mobile close button closes the real app drawer and releases the composer');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
