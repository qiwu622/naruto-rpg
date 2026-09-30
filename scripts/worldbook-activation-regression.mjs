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
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><style>body{background:#15171b;color:#eee;margin:0}</style>');
    const target = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!target.startsWith(root + path.sep) || !/\.(?:js|css|json)$/u.test(target)) throw new Error('unavailable');
    res.writeHead(200, { 'Content-Type': target.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(await readFile(target));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const failures = [];
let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`PASS ${label}`); }
  catch (error) { failures.push(label); console.error(`FAIL ${label}: ${error.message}`); }
}
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    await import('/js/ui/worldbook-editor.js');
    const { KNOWLEDGE_BASE } = await import('/js/data/knowledge-base.js');
    const { WorldbookV2Resolver } = await import('/js/data/worldbook/runtime-resolver.js');
    const { TurnEvidenceCompiler, renderEvidenceView } = await import('/js/core/turn-evidence.js');
    Object.assign(window, { KNOWLEDGE_BASE, WorldbookV2Resolver });
    // Real localStorage loader and production prompt projection; only unrelated
    // builtin lore is removed so sentinel membership is deterministic.
    window.resolver = new WorldbookV2Resolver({ builtinEntries: [] });
    window.compiler = new TurnEvidenceCompiler({ worldbookResolver: resolver });
    window.promptFor = query => {
      const packet = compiler.compile({ userInput: query, state: {} });
      return renderEvidenceView(compiler.project(packet, { audience: 'writer' }));
    };
    document.body.append(document.createElement('worldbook-editor'));
  });
  const imported = {
    entries: {
      0: { uid: 0, comment: '关闭条目', key: ['关闭密钥'], content: 'DISABLED_SENTINEL。' + '禁止注入的内容。'.repeat(1600), constant: true, disable: true },
      1: { uid: 1, comment: '绿灯条目', key: ['青叶密钥'], content: 'GREEN_SENTINEL。' + '等待关键词的内容。'.repeat(1600), constant: false, disable: false },
      2: { uid: 2, comment: '蓝灯条目', key: [], content: 'BLUE_SENTINEL。始终有效的世界规则。', constant: true, disable: false }
    }
  };
  await page.locator('#file-import').setInputFiles({ name: 'activation-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await page.waitForFunction(() => KNOWLEDGE_BASE.getCustomEntries().length === 3);
  const noMatch = await page.evaluate(() => promptFor('我在空地上等待。'));
  check('disabled import never reaches the writer prompt', () => assert.equal(noMatch.includes('DISABLED_SENTINEL'), false));
  check('untriggered green import never reaches the writer prompt', () => assert.equal(noMatch.includes('GREEN_SENTINEL'), false));
  check('explicit blue import is retained without keyword matches', () => assert.equal(noMatch.includes('BLUE_SENTINEL'), true));
  const triggered = await page.evaluate(() => resolver.resolve({ query: '青叶密钥和关闭密钥', audience: 'writer', budget: 100_000 }).entries);
  check('matching a disabled entry still does not enable it', () => assert.equal(JSON.stringify(triggered).includes('DISABLED_SENTINEL'), false));
  check('a primary key activates a green entry when budget permits', () => assert.equal(JSON.stringify(triggered).includes('GREEN_SENTINEL'), true));
  const stored = await page.evaluate(() => KNOWLEDGE_BASE.getCustomEntries());
  check('import persists off, green and blue instead of erasing their modes', () => {
    assert.equal(stored[0].enabled, false);
    assert.equal(stored[1].activation.mode, 'keyword');
    assert.equal(stored[2].activation.mode, 'always');
  });
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.locator('.wb-item[data-type="custom"][data-idx="2"]').click();
  const displayedMode = await page.locator('#entry-mode').inputValue();
  check('editor shows imported blue mode', () => assert.equal(displayedMode, 'always'));
  assert.equal(await page.locator('#entry-content').isVisible(), true);
  await page.locator('#entry-mode').selectOption('keyword');
  assert.equal(await page.evaluate(() => promptFor('我在空地等待').includes('BLUE_SENTINEL')), false);
  check('switching blue to keyless green removes it from the very next prompt', () => {});
  await page.locator('#entry-keys').fill('编辑触发词');
  await page.locator('#entry-keys').press('Tab');
  assert.equal(await page.evaluate(() => promptFor('编辑触发词').includes('BLUE_SENTINEL')), true);
  await page.locator('#entry-secondary-keys').fill('必要条件');
  await page.locator('#entry-selective').selectOption('and_any');
  assert.equal(await page.evaluate(() => promptFor('编辑触发词').includes('BLUE_SENTINEL')), false);
  assert.equal(await page.evaluate(() => promptFor('编辑触发词和必要条件').includes('BLUE_SENTINEL')), true);
  check('editing both key groups immediately changes the production prompt', () => {});
  await page.locator('#entry-toggle').click();
  assert.equal(await page.evaluate(() => promptFor('编辑触发词和必要条件').includes('BLUE_SENTINEL')), false);
  await page.locator('#entry-toggle').click();
  assert.equal(await page.evaluate(() => promptFor('编辑触发词和必要条件').includes('BLUE_SENTINEL')), true);
  check('UI disable and re-enable preserve the trigger rules', () => {});
  await page.locator('#entry-content').fill('BLUE_SENTINEL。可编辑的条目正文。');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export').click()]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  check('UI export preserves mode, disabled switch and secondary filter', () => {
    assert.equal(exported.custom[0].enabled, false);
    assert.equal(exported.custom[2].activation.mode, 'keyword');
    assert.deepEqual(exported.custom[2].activation.secondary_keys, ['必要条件']);
    assert.equal(exported.custom[2].activation.selective_logic, 'and_any');
    assert.equal(exported.custom[2].content, 'BLUE_SENTINEL。可编辑的条目正文。');
  });
  await page.locator('#file-import').setInputFiles({ name: 'round-trip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await page.getByRole('button', { name: '确定', exact: true }).click();
  assert.equal(await page.evaluate(() => KNOWLEDGE_BASE.getCustomEntries().length), 3);
  assert.equal(await page.evaluate(() => promptFor('编辑触发词和必要条件').includes('BLUE_SENTINEL')), true);
  assert.equal(await page.evaluate(() => promptFor('我在空地等待').includes('BLUE_SENTINEL')), false);
  check('exported file reimports through the real editor with unchanged triggers', () => {});
  await mkdir(path.join(root, 'reports/worldbook-activation'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'reports/worldbook-activation/desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#entry-mode').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'reports/worldbook-activation/mobile.png') });
  await page.locator('#entry-content').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#entry-content').isVisible(), true);
  await page.screenshot({ path: path.join(root, 'reports/worldbook-activation/mobile-content.png') });
  const siblings = { entries: {
    0: { uid: 20, comment: '同名测试', key: ['同名钥'], content: 'ENABLED_SIBLING', disable: false },
    1: { uid: 21, comment: '同名测试', key: ['同名钥'], content: 'DISABLED_SIBLING', disable: true }
  } };
  await page.locator('#file-import').setInputFiles({ name: 'same-title.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(siblings)) });
  await page.getByRole('button', { name: '确定', exact: true }).click();
  assert.equal(await page.evaluate(() => KNOWLEDGE_BASE.getCustomEntries().length), 5);
  const siblingPrompt = await page.evaluate(() => promptFor('同名钥'));
  check('same-title imports preserve separate entries and never merge the disabled body', () => {
    assert.equal(siblingPrompt.includes('ENABLED_SIBLING'), true);
    assert.equal(siblingPrompt.includes('DISABLED_SIBLING'), false);
  });
  check('worldbook editor imports without browser errors', () => assert.deepEqual(errors, []));
  console.log(`worldbook-activation-regression: ${passed} passed, ${failures.length} failed; unmatched writer prompt ${noMatch.length} characters`);
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
