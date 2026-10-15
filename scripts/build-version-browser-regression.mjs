import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const helper = await readFile(new URL('../js/utils/build-version.js', import.meta.url), 'utf8');
let authenticatedBuild = '261015-node-read-fix';
let publishedBuild = '2610151746';
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const send = (type, body) => {
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(body);
  };
  // Production's authenticated HTML entry and nginx static manifest are separate files.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    send('text/html', `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Update regression</title><script type="module" src="/js/app.js?v=${authenticatedBuild}"></script><main>游戏进度保留</main>`);
  } else if (url.pathname === '/version.json') {
    send('application/json', JSON.stringify({ build: publishedBuild, environment: 'production' }));
  } else if (url.pathname === '/js/utils/build-version.js') {
    send('text/javascript', helper);
  } else if (url.pathname === '/js/app.js') {
    send('text/javascript', `import { inspectRuntimeBuild, showStaleBuildNotice } from './utils/build-version.js';
      const result = await inspectRuntimeBuild(); showStaleBuildNotice(result); window.__buildResult = result;`);
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const notice = page.locator('#runtime-build-stale-notice');
  const ready = () => page.waitForFunction(() => Boolean(window.__buildResult));
  const refresh = async () => {
    await Promise.all([page.waitForNavigation(), notice.getByRole('button', { name: '立即刷新' }).click()]);
    await ready();
  };
  await page.goto(`${origin}/?tab=opening#draft`);
  await ready();
  assert.equal(await notice.isVisible(), true);
  await page.evaluate(async () => {
    localStorage.setItem('save-preservation-check', 'original-save');
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('update-save-regression', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('saves');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('saves', 'readwrite');
        transaction.objectStore('saves').put({ turn: 393, branch: 'main' }, 'original');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const rect = await notice.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width, `banner fits ${width}px screen`);
    assert.ok(rect.height <= 90, `banner remains compact on ${width}px screen`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const evidence = new URL('../reports/release-v3.7.1/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('banner-mobile.png', evidence)) });

  await refresh();
  assert.equal((await page.evaluate(() => window.__buildResult)).stale, true, 'reproduces the loop when only static files have been published');
  assert.ok(new URL(page.url()).searchParams.get('_app_update').startsWith(`${publishedBuild}-`));
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'opening');
  assert.equal(new URL(page.url()).hash, '#draft');

  authenticatedBuild = publishedBuild;
  await refresh();
  assert.equal((await page.evaluate(() => window.__buildResult)).stale, false, 'matching the authenticated entry to the published build ends the loop');
  assert.equal(await notice.count(), 0);
  const retained = await page.evaluate(async () => {
    const save = await new Promise((resolve, reject) => {
      const request = indexedDB.open('update-save-regression', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('saves').objectStore('saves').get('original');
        read.onsuccess = () => { db.close(); resolve(read.result); };
        read.onerror = () => reject(read.error);
      };
    });
    return { local: localStorage.getItem('save-preservation-check'), save };
  });
  assert.deepEqual(retained, { local: 'original-save', save: { turn: 393, branch: 'main' } });

  publishedBuild = 'next-build';
  await page.reload(); await ready();
  await notice.getByRole('button', { name: '暂时关闭更新提示' }).click();
  assert.equal(await notice.count(), 0);
  await page.reload(); await ready();
  assert.equal(await notice.count(), 0, 'dismissal survives refresh for the same build');
  publishedBuild = 'future-build';
  await page.reload(); await ready();
  assert.equal(await notice.isVisible(), true, 'future releases can still be announced');
  assert.deepEqual(errors, []);
  console.log('PASS browser: refresh loop reproduced and resolved, 320/390/1280px layout, dismissal, localStorage and IndexedDB preservation');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
