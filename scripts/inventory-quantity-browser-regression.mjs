import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><style>body{margin:0;background:#101317}info-panel{display:block;max-width:520px;height:900px}</style><div id="app"><info-panel></info-panel></div>'
    );
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('outside');
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'text/css' }).end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    await import('/js/ui/panel.js');
    stateManager.reset();
    stateManager.batchUpdate([{ path: 'equipment.consumables.兵粮丸', op: 'set',
      value: { quantity: 1000002, quality: '普通', description: '大数量回归测试' } }]);
    document.querySelector('info-panel').openTab('equipment');
    window.testState = stateManager;
  });
  const panel = page.locator('info-panel');
  assert.match(await panel.locator('.eq-item-meta').innerText(), /持有 × 1000002/);
  await panel.locator('.eq-use-btn[data-name="兵粮丸"]').click();
  await page.waitForFunction(() => testState.get('物品·消耗品·兵粮丸·数量') === 1000001);
  await panel.locator('.eq-discard-btn[data-name="兵粮丸"]').click();
  await page.locator('game-modal').getByRole('button', { name: '丢弃', exact: true }).click();
  await page.waitForFunction(() => testState.get('物品·消耗品·兵粮丸·数量') === undefined);
  assert.equal(await panel.locator('.eq-discard-btn[data-name="兵粮丸"]').count(), 0, 'discard all removes more than 999999 items');

  await page.evaluate(async () => {
    await import('/js/ui/character-creator.js');
    const { createOpeningDraft } = await import('/js/systems/opening-draft.js');
    const creator = document.createElement('character-creator');
    creator.setDraftMode(createOpeningDraft('custom', { equipment: [{ name: '苦无', category: 'tools', quantity: 1 }] }));
    document.querySelector('#app').replaceChildren(creator);
    creator._stage = 3; creator._render();
  });
  const quantity = page.locator('character-creator input[data-path="equipment.0.quantity"]');
  assert.equal(await quantity.getAttribute('max'), null);
  await quantity.fill('1000000');
  await quantity.dispatchEvent('change');
  assert.equal(await quantity.evaluate(input => input.validity.rangeOverflow), false);
  assert.equal(await page.evaluate(() => document.querySelector('character-creator')._draft.equipment[0].quantity), 1000000);
  assert.deepEqual(errors, []);
  console.log('PASS browser: seven-digit inventory display, use, confirmed discard-all and uncapped opening quantity input');
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
