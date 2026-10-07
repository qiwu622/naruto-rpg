import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startCloudSaveTestServer } from './helpers/cloud-save-test-server.mjs';

const server = await startCloudSaveTestServer({ staticFiles: true });
const output = path.resolve('reports/deepseek-mode');
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const { aiClient } = await import('/js/core/ai-client.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    await import('/js/ui/settings-panel.js');
    stateManager.state = stateManager.getDefaultState();
    await stateManager.saveAPIConfig({ backend: 'deepseek', apiUrl: 'https://relay.test/v1', apiKey: 'browser-test-only', model: 'deepseek-flash', disableStreaming: false });
    Object.assign(window, { stateManager, aiClient, eventBus });
    const panel = document.createElement('settings-panel'); document.querySelector('#app').append(panel);
    panel.open({ section: 'connection' });
  });
  const panel = page.locator('settings-panel');
  const form = panel.locator('api-config-form');
  const select = async (id, label) => {
    const wrapper = form.locator(`.ns-select-wrapper:has(select#${id})`);
    await wrapper.locator('.ns-select-trigger').click();
    await wrapper.locator('.ns-select-option').filter({ hasText: label }).click();
  };
  assert.equal(await form.locator('#settings-api-adaptation').inputValue(), 'standard');
  assert.equal(await form.locator('#settings-deepseek-options').isVisible(), false);
  await select('settings-api-adaptation', 'DeepSeek 专用 · 缓存优化');
  assert.equal(await form.locator('#settings-deepseek-options').isVisible(), true);
  await select('settings-deepseek-thinking', '低 · 轻量推理');
  await panel.getByRole('button', { name: '应用', exact: true }).click();
  await page.waitForFunction(() => aiClient.getConfig()?.deepseekThinking === 'low');
  assert.equal(await page.evaluate(() => aiClient.getConfig().adaptationMode), 'deepseek');
  assert.equal(await page.evaluate(() => aiClient.getConfig().apiUrl), 'https://relay.test/v1', 'enabling never rewrites the endpoint');
  console.log('PASS default off, opt in and apply through the real settings panel');

  await form.locator('#scheme-name').fill('DeepSeek 低思考');
  await form.locator('#scheme-save').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('naruto_api_schemes') || '[]').length === 1);
  await select('settings-api-adaptation', '通用兼容');
  await panel.getByRole('button', { name: '应用', exact: true }).click();
  await page.waitForFunction(() => aiClient.getConfig().adaptationMode === 'standard');
  const schemeId = await page.evaluate(() => JSON.parse(localStorage.getItem('naruto_api_schemes'))[0].id);
  await form.locator('#scheme-select').selectOption('', { force: true });
  await form.locator('#scheme-select').selectOption(schemeId, { force: true });
  await page.waitForFunction(() => aiClient.getConfig().adaptationMode === 'deepseek');
  assert.equal(await form.locator('#settings-deepseek-thinking').inputValue(), 'low');
  console.log('PASS disable is reversible and a saved API scheme restores the chosen mode/effort');

  await page.evaluate(() => eventBus.emit('ai:usage', { model: 'deepseek-flash', prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens_details: { reasoning_tokens: 30 } }));
  assert.match(await form.locator('#settings-api-usage').textContent(), /缓存命中 800.*80%/);
  assert.match(await form.locator('#settings-api-usage').textContent(), /思考 30/);
  await form.locator('.ns-select-wrapper:has(#settings-api-adaptation)').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'desktop.png'), animations: 'disabled' });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await form.locator('.ns-select-wrapper:has(#settings-deepseek-thinking)').scrollIntoViewIfNeeded();
    await form.locator('#settings-api-usage').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true);
    if (width === 390) await page.screenshot({ path: path.join(output, 'mobile.png'), animations: 'disabled' });
  }
  await page.evaluate(() => eventBus.emit('ai:usage', { prompt_tokens: 1000, completion_tokens: 100 }));
  assert.match(await form.locator('#settings-api-usage').textContent(), /未返回缓存命中量/);
  console.log('PASS desktop/mobile controls scroll and usage distinguishes missing metrics from zero hits');
  await form.locator('#settings-deepseek-official').click();
  assert.equal(await form.locator('#settings-api-url').inputValue(), 'https://api.deepseek.com/v1');
  assert.equal(await form.locator('#settings-api-model').inputValue(), 'deepseek-flash');
  await select('settings-api-backend', 'Claude / Anthropic');
  assert.equal(await form.locator('#settings-deepseek-options').isVisible(), false);
  assert.equal(await form.locator('#settings-api-adaptation').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS official fields change only by explicit button; unrelated backends hide the mode');
  console.log('\n4 DeepSeek settings browser groups passed; isolated local browser, no paid calls.');
} finally { await browser?.close(); await server.close(); }
