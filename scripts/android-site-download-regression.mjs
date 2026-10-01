import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';

const output = path.resolve(process.argv[2]);
const proof = JSON.parse(await fs.readFile(path.join(output, 'verification.json'), 'utf8'));
const apkUrl = 'https://www.qiwu.asia/app/android/naruto-rpg.apk';
const selectedOrigins = process.env.NARUTO_SITE_ORIGINS?.split(',').map(origin => origin.trim());
const viewports = [
  ['https://www.qiwu.asia', 360, 640],
  ['https://www.qiwu.asia:8080', 360, 640],
  ['https://www.qiwu.asia', 1280, 800],
].filter(([origin]) => !selectedOrigins || selectedOrigins.includes(origin));
assert.ok(viewports.length, 'NARUTO_SITE_ORIGINS must select at least one supported website');
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-http2'],
  ...(process.env.NARUTO_BROWSER_PROXY ? { proxy: { server: process.env.NARUTO_BROWSER_PROXY } } : {})
});
const context = await browser.newContext({ acceptDownloads: true });
const checks = [];
try {
  const response = await context.request.get('https://www.qiwu.asia/app/android/update.json');
  assert.equal(response.status(), 200);
  assert.ok(response.headers()['cache-control'].includes('no-store'));
  const manifest = await response.json();
  assert.equal(manifest.apkUrl, apkUrl);
  assert.equal(manifest.version, proof.version);
  assert.equal(manifest.versionCode, proof.versionCode);
  assert.equal(manifest.sha256, proof.sha256);
  assert.ok(manifest.releaseNotes?.length && manifest.announcement, 'release notes and announcement are published with the APK');
  const headers = await context.request.head(apkUrl);
  assert.equal(headers.status(), 200);
  assert.equal(headers.headers()['content-type'], 'application/vnd.android.package-archive');
  assert.ok(headers.headers()['content-disposition'].includes('attachment'));
  assert.equal(Number(headers.headers()['content-length']), manifest.sizeBytes);
  const range = await context.request.get(apkUrl, { headers: { Range: 'bytes=0-255' } });
  assert.equal(range.status(), 206);
  assert.equal(range.headers()['content-range'], 'bytes 0-255/' + manifest.sizeBytes);
  assert.equal((await range.body()).subarray(0, 4).toString('hex'), '504b0304');
  checks.push('anonymous update manifest, APK MIME, attachment, size and resumable range download');
  const page = await context.newPage();
  for (const [origin, width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto(origin + '/login.html?apk-check=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const button = page.locator('#android-download');
    await button.waitFor({ state: 'visible' });
    assert.equal(await button.getAttribute('href'), apkUrl);
    assert.equal(await button.textContent().then(text => text.trim()), '下载安卓测试版');
    assert.ok(await button.isVisible());
    const bounds = await button.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
    const horizontal = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert.ok(horizontal);
    await page.locator('.android-download details summary').click();
    assert.ok((await page.locator('.android-download details').textContent()).includes(manifest.version));
    assert.ok(await page.locator('.android-download details p').first().isVisible());
    await page.locator('.android-download details summary').click();
    await page.screenshot({ path: path.join(output, 'site-login-' + width + (origin.includes('8080') ? '-staging' : '') + '.png') });
    checks.push(`visible login download entry and announcement at ${width}x${height}: ${origin}`);
  }
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('https://www.qiwu.asia/login.html?apk-check=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  const promise = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('#android-download').click();
  const download = await promise;
  const file = path.join(output, 'website-downloaded.apk');
  let downloadTimer;
  try {
    await Promise.race([download.saveAs(file), new Promise((_, reject) => {
      downloadTimer = setTimeout(() => reject(new Error('APK download did not finish within 120 seconds')), 120000);
    })]);
  } catch (error) {
    await download.cancel().catch(() => {});
    throw error;
  } finally { clearTimeout(downloadTimer); }
  assert.equal(await download.failure(), null);
  const bytes = await fs.readFile(file);
  assert.equal(bytes.length, manifest.sizeBytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), proof.sha256);
  checks.push('the login button downloads every APK byte and matches the tested native build');
  await fs.writeFile(path.join(output, 'site-verification.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(), apkSha256: proof.sha256, manifest, suggestedFilename: download.suggestedFilename(), checks }, null, 2) + '\n');
  for (const check of checks) console.log('PASS ' + check);
} catch (error) {
  await fs.writeFile(path.join(output, 'site-verification.json'), JSON.stringify({
    passed: false, testedAt: new Date().toISOString(), apkSha256: proof.sha256,
    checks, error: error.message
  }, null, 2) + '\n');
  throw error;
} finally { await context.close(); await browser.close(); }
