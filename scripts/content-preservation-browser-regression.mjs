import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><style>body{margin:0;background:#101317;color:#ddd}memory-facts-editor{display:block}</style><memory-facts-editor></memory-facts-editor>');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('outside root');
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    stateManager.setSub('_memory', { facts: '事实原文。'.repeat(450) + 'FACT_TAIL', source_records: Array.from({ length: 25 }, (_, i) => ({ turn: i + 1, source: '<img src=x onerror=window.injected=true>', update: { summary: '原始记录\n'.repeat(2500) + `SOURCE_TAIL_${i}` + '<script>window.injected=true</script>' } })) });
    const { eventBus } = await import('/js/core/event-bus.js');
    const { prepareMemoryCorrection } = await import('/js/core/memory-corrections.js');
    eventBus.request = async (event, payload) => {
      if (event !== 'memory:correction-requested') throw new Error(event);
      const next = prepareMemoryCorrection(stateManager.snapshot(), payload);
      stateManager.setSub('_memory', next._memory);
      return { id: 'local-test' };
    };
    await import('/js/ui/memory-facts-editor.js');
    window.testState = stateManager;
  });
  const editor = page.locator('memory-facts-editor');
  await editor.getByRole('button', { name: '修改', exact: true }).click();
  const draft = editor.getByRole('textbox', { name: '纠正内容', exact: true });
  assert.equal(await draft.getAttribute('maxlength'), null);
  const correction = '完整纠正。'.repeat(650) + 'CORRECTION_TAIL';
  await draft.fill(correction);
  await editor.getByRole('button', { name: '保存纠正', exact: true }).click();
  await page.waitForFunction(() => testState.getSub('_memory').corrections?.[0]?.replacement.endsWith('CORRECTION_TAIL'));
  assert.ok((await editor.locator('.mf-card .mf-text').first().innerText()).endsWith('CORRECTION_TAIL'));
  const originals = editor.locator('[data-memory-originals]');
  await originals.locator('summary').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-action="source-original"]').length === 20);
  assert.equal(await originals.locator('pre:visible').count(), 0, 'original content is lazy');
  await originals.getByRole('button', { name: '展开完整原文', exact: true }).first().click();
  assert.match(await originals.locator('pre:visible').innerText(), /SOURCE_TAIL_24/);
  await originals.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await originals.getByRole('button', { name: '展开完整原文', exact: true }).count(), 5);
  await originals.getByRole('button', { name: '展开完整原文', exact: true }).last().click();
  assert.match(await originals.locator('pre:visible').innerText(), /SOURCE_TAIL_0/);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.evaluate(async () => {
    const { mountPresetOutputSandbox } = await import('/js/ui/preset-output-sandbox.js');
    const container = document.createElement('div'); document.body.replaceChildren(container);
    window.longAction = '完整选项文字。'.repeat(500) + 'CLICK_TAIL';
    mountPresetOutputSandbox(container, `<button id="long-action" data-option-text="${window.longAction}">选择完整行动</button>`, { onAction: action => { window.receivedAction = action; } });
  });
  await page.frameLocator('iframe').locator('#long-action').click();
  await page.waitForFunction(() => window.receivedAction === window.longAction);
  assert.deepEqual(errors, []);
  console.log('PASS mobile browser: long correction, complete source records, lazy pagination, escaped markup, no horizontal overflow and full sandbox action delivery');
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
