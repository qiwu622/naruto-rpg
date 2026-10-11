import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';

const app = express();
let requests = 0, fail = false;
app.use(express.json());
app.post('/api/ai-proxy', (req, res) => {
  requests++;
  assert.equal(req.headers['x-target-url'], 'https://embedding.invalid/v1/embeddings');
  assert.equal(req.headers['x-user-api-key'], 'test-only-key');
  if (fail) return res.status(503).json({ error: 'synthetic offline service' });
  res.json({ data: req.body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
});
app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><main></main>'));
app.use(express.static(process.cwd()));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const mount = () => page.evaluate(async () => {
    await import('/js/ui/memory-panel.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { vectorMemory } = await import('/js/core/vector-memory.js');
    const { getMemoryConfig } = await import('/js/data/memory-config.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    Object.assign(window, { stateManager, vectorMemory, getMemoryConfig });
    stateManager.state._memory.facts = '卡卡西曾在演习场教你雷遁。';
    window.recall = async (query = '卡卡西教过什么？') => {
      const result = await vectorMemory.recall({ state: stateManager.state, query, scope: 'browser-test:main' });
      eventBus.emit('memory:vector-status', { text: vectorMemory.status });
      return result;
    };
    document.querySelector('main').append(document.createElement('memory-panel'));
  });
  await mount();
  const enabled = page.locator('[name="memVectorEnabled"]');
  assert.equal(await enabled.isChecked(), false);
  assert.deepEqual(await page.evaluate(() => recall()), []);
  assert.equal(requests, 0);
  assert.equal(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'naruto_memory_vectors')), false);
  for (const [name, value] of [['memVectorEndpoint', 'https://embedding.invalid/v1'], ['memVectorModel', 'embedding-test'], ['memVectorKey', 'test-only-key']]) {
    await page.locator(`[name="${name}"]`).fill(value);
    await page.locator(`[name="${name}"]`).blur();
  }
  await enabled.check();
  assert.equal((await page.evaluate(() => recall())).length, 1);
  assert.equal(requests, 1);
  assert.match(await page.locator('[data-vector-status]').innerText(), /本次召回 1 条/);
  assert.equal((await page.evaluate(() => recall())).length, 1);
  assert.equal(requests, 1, 'second recall reuses the real IndexedDB cache');
  assert.equal(await page.evaluate(() => JSON.stringify(stateManager.snapshot()).includes('test-only-key')), false);
  await page.getByRole('button', { name: '清除向量缓存' }).click();
  await page.waitForFunction(() => document.querySelector('[data-vector-status]').textContent.includes('缓存已清除'));
  assert.equal(await page.evaluate(() => stateManager.state._memory.facts), '卡卡西曾在演习场教你雷遁。');
  fail = true;
  assert.deepEqual(await page.evaluate(() => recall('换一条检索')), []);
  assert.match(await page.locator('[data-vector-status]').innerText(), /已使用原有本地记忆/);
  assert.equal(requests, 2);
  await enabled.uncheck();
  await page.reload(); await mount();
  assert.equal(await enabled.isChecked(), false);
  assert.equal(await page.locator('[name="memVectorModel"]').inputValue(), 'embedding-test');
  assert.deepEqual(await page.evaluate(() => recall()), []);
  assert.equal(requests, 2);
  assert.deepEqual(errors, []);
  console.log('PASS real memory settings, default-off/no database or API, mock proxy, persistent vector reuse, separate credentials, cache clearing, offline fallback, reload');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
