import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const app = express();
app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#0b1015}</style><main id="app"></main>'));
app.use(express.static(process.cwd()));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { NarutoRPGApp } = await import('/js/app.js');
    const { appUpdateService: service, ANDROID_APP_DOWNLOAD_URL } = await import('/js/core/app-update.js');
    window.nativeState = { status: 'idle' };
    window.counts = { downloads: 0, installs: 0, cancellations: 0 };
    window.permission = true; window.offline = false;
    service.nativeCheck = () => true;
    service.fetchImpl = async () => {
      if (offline) throw new Error('网络未连接，请稍后重试');
      return { ok: true, json: async () => ({ version: '9.0.0', versionCode: 90000, apkUrl: ANDROID_APP_DOWNLOAD_URL,
        sha256: 'a'.repeat(64), sizeBytes: 30000000, releaseNotes: ['存档优化', '<script>不应执行</script>'], announcement: '覆盖安装保留旧档' }) };
    };
    service.nativeUpdater = () => ({
      getStatus: async () => ({ ...nativeState }),
      download: async () => { counts.downloads++; return nativeState = { status: 'downloading', versionCode: 90000, receivedBytes: 10000000, totalBytes: 30000000 }; },
      cancel: async () => { counts.cancellations++; return nativeState = { status: 'idle' }; },
      install: async () => { counts.installs++; return { requiresPermission: permission }; }
    });
    window.game = new NarutoRPGApp(); game.pipeline = { isProcessing: false };
    window.result = await service.check();
    window.openUpdate = () => { void game._presentAppUpdate(result); };
    openUpdate();
  });
  const modal = page.locator('game-modal');
  await modal.getByRole('button', { name: '下载更新', exact: true }).click();
  await page.waitForFunction(() => counts.downloads === 1);
  await modal.getByText(/9.5 MB \/ 28.6 MB/).waitFor();
  assert.equal(await modal.locator('script').count(), 0);
  await modal.getByRole('button', { name: '稍后 / 继续游玩' }).click();
  assert.equal(await page.evaluate(() => counts.cancellations), 0, 'closing dialog must not cancel system download');
  await page.evaluate(() => { nativeState = { ...nativeState, status: 'ready' }; game.pipeline.isProcessing = true; openUpdate(); });
  await modal.getByRole('button', { name: '等待当前回合保存' }).waitFor();
  assert.equal(await modal.getByRole('button', { name: '等待当前回合保存' }).isDisabled(), true);
  await page.evaluate(() => { game.pipeline.isProcessing = false; });
  await modal.getByRole('button', { name: '立即安装', exact: true }).click();
  await modal.getByText(/请在系统页面允许此 App 安装更新/).waitFor();
  await page.evaluate(() => { permission = false; });
  await modal.getByRole('button', { name: '立即安装', exact: true }).click();
  await modal.getByText(/已打开系统安装页面/).waitFor();
  assert.equal(await page.evaluate(() => counts.installs), 2);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const box = await modal.getByRole('dialog').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await mkdir('reports/android-update', { recursive: true });
  await page.screenshot({ path: 'reports/android-update/update-mobile.png' });
  await modal.getByRole('button', { name: '取消下载', exact: true }).click();
  await page.waitForFunction(() => counts.cancellations === 1);
  await page.evaluate(() => { offline = true; });
  await modal.getByRole('button', { name: '下载更新', exact: true }).click();
  await modal.getByText('网络未连接，请稍后重试', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => counts.downloads), 1);
  await modal.getByRole('button', { name: '稍后 / 继续游玩' }).click();
  assert.equal(await modal.count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS actual app update entry, native download progress, background continuation, generation gate, permission/install handoff, cancellation, offline retry, safe release text and 320/390/768 px layout');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
