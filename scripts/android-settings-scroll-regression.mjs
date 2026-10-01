import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const output = path.resolve(process.argv[2]);
const adb = process.env.NARUTO_ANDROID_ADB;
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
assert.ok(adb, 'Set NARUTO_ANDROID_ADB');
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 });
assert.equal(run('shell', 'getprop', 'ro.kernel.qemu').trim(), '1', 'Only a dedicated emulator may be reconfigured');
const proof = JSON.parse(await fs.readFile(path.join(output, 'verification.json'), 'utf8'));
const apk = run('shell', 'pm', 'path', 'asia.qiwu.narutorpg').trim().replace(/^package:/, '');
const bytes = execFileSync(adb, ['-s', serial, 'exec-out', 'cat', apk], { maxBuffer: 64 * 1024 * 1024 });
assert.equal(createHash('sha256').update(bytes).digest('hex'), proof.sha256);
const rotation = run('shell', 'settings', 'get', 'system', 'user_rotation').trim();
const automatic = run('shell', 'settings', 'get', 'system', 'accelerometer_rotation').trim();
const passed = [];
let browser, forward;
try {
  run('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  run('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  run('shell', 'am', 'force-stop', 'asia.qiwu.narutorpg');
  run('shell', 'am', 'start', '-n', 'asia.qiwu.narutorpg/.MainActivity');
  let socket;
  for (let i = 0; i < 60 && !socket; i++) {
    socket = run('shell', 'cat', '/proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1];
    if (!socket) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(socket);
  forward = run('forward', 'tcp:0', 'localabstract:' + socket).trim();
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + forward, { noDefaults: true });
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => innerWidth > 0 && innerHeight > innerWidth);
  await page.waitForSelector('#btn-settings');
  await page.locator('#btn-settings').click();
  const settings = page.locator('settings-panel');
  await expect(settings).toBeVisible();
  const cdp = await browser.contexts()[0].newCDPSession(page);
  const checkSwipe = async label => {
    const layout = settings.locator('.layout');
    const bounds = await layout.boundingBox();
    const actions = await settings.locator('.actions').boundingBox();
    assert.ok(bounds.height > 60 && bounds.y + bounds.height <= actions.y + 1, JSON.stringify({ bounds, actions }));
    const before = await layout.evaluate(e => e.scrollTop);
    const x = bounds.x + bounds.width * .8;
    const remaining = await layout.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop);
    const upwards = remaining > 40;
    const y = upwards ? bounds.y + bounds.height - 15 : bounds.y + 15;
    const travel = Math.min(bounds.height - 30, 200);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 10; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (upwards ? -1 : 1) * travel * step / 10 }] });
      await page.waitForTimeout(35);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => layout.evaluate((e, start) => Math.abs(e.scrollTop - start), before)).toBeGreaterThan(25);
    const after = await layout.evaluate(e => e.scrollTop);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    passed.push({ label, before, after, viewport });
    await page.screenshot({ path: path.join(output, 'settings-' + label + '.png') });
    console.log('PASS settings native WebView touch: ' + label + '; ' + before + ' -> ' + after);
  };

  for (const mode of ['player', 'creator']) {
    if (mode === 'creator') await settings.locator('[data-action="open-creator-workbench"]').click();
    for (const orientation of ['portrait', 'landscape']) {
      run('shell', 'settings', 'put', 'system', 'user_rotation', orientation === 'portrait' ? '0' : '1');
      await page.waitForFunction(portrait => (innerHeight > innerWidth) === portrait, orientation === 'portrait');
      // A tab switch is also the real UI path that restores the scroll start.
      await settings.locator(mode === 'player' ? '[data-section="appearance"]' : '[data-tool="pipeline"]').click();
      await checkSwipe(mode + '-' + orientation);
    }
  }
  run('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  await page.waitForFunction(() => innerHeight > innerWidth);
  await settings.locator('[data-action="open-player-settings"]').click();
  await settings.locator('[data-section="connection"]').click();
  const fullHeight = await page.evaluate(() => innerHeight);
  const input = settings.locator('api-config-form #settings-api-url');
  await input.click();
  await page.waitForFunction(height => innerHeight < height - 100, fullHeight);
  await checkSwipe('player-keyboard');
  run('shell', 'input', 'keyevent', '4');
  await page.waitForFunction(height => innerHeight === height, fullHeight);
  await settings.locator('.close').click();
  const liveCheck = await page.evaluate(async () => {
    const { appUpdateService } = await import('/js/core/app-update.js');
    return appUpdateService.check();
  });
  assert.equal(liveCheck.supported, true);
  assert.equal(liveCheck.currentVersionCode, proof.versionCode);
  assert.ok(liveCheck.latestVersionCode > 0);
  passed.push({ label: 'native-public-update-endpoint', current: liveCheck.currentVersion, latest: liveCheck.latestVersion });
  console.log('PASS native update endpoint: installed ' + liveCheck.currentVersion + ', server ' + liveCheck.latestVersion);
  await page.evaluate(async () => {
    const { appUpdateService, ANDROID_APP_DOWNLOAD_URL } = await import('/js/core/app-update.js');
    const { NarutoRPGApp } = await import('/js/app.js');
    const saved = { fetch: appUpdateService.fetchImpl, result: appUpdateService._lastResult,
      known: localStorage.getItem('naruto_android_known_update'), snoozed: localStorage.getItem('naruto_android_update_snoozed') };
    appUpdateService.fetchImpl = async () => ({ ok: true, json: async () => ({
      version: '9.0.0-test', versionCode: 90000, apkUrl: ANDROID_APP_DOWNLOAD_URL,
      releaseNotes: ['设置滑动修复', '角色按需调用'], announcement: '测试公告：现有存档保留'
    }) });
    const app = new NarutoRPGApp();
    window.__NATIVE_UPDATE_TEST__ = { app, restore() {
      app._stopAppUpdateChecks?.();
      appUpdateService.fetchImpl = saved.fetch;
      appUpdateService._lastResult = saved.result;
      for (const [key, value] of [['naruto_android_known_update', saved.known], ['naruto_android_update_snoozed', saved.snoozed]]) {
        if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
      }
    } };
    app._scheduleAppUpdateCheck();
  });
  try {
    const notice = page.locator('game-modal');
    await expect(notice).toContainText('9.0.0-test 更新公告');
    await expect(notice).toContainText('设置滑动修复');
    await expect(notice).toContainText('测试公告：现有存档保留');
    await page.screenshot({ path: path.join(output, 'settings-update-announcement.png') });
    await notice.getByRole('button', { name: '稍后提醒', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await page.evaluate(() => { void window.__NATIVE_UPDATE_TEST__.app._checkAppUpdate(); });
    await expect(notice).toContainText('9.0.0-test 更新公告');
    await notice.getByRole('button', { name: '稍后提醒', exact: true }).click();
    passed.push({ label: 'native-startup-notes-announcement-and-manual-check' });
    console.log('PASS native automatic update announcement, later reminder and manual check');
  } finally { await page.evaluate(() => { window.__NATIVE_UPDATE_TEST__?.restore(); delete window.__NATIVE_UPDATE_TEST__; }); }
  await fs.writeFile(path.join(output, 'settings-scroll-verification.json'), JSON.stringify({
    apkSha256: proof.sha256, passed, failed: []
  }, null, 2) + '\n');
} finally {
  if (browser) await browser.close();
  if (forward) run('forward', '--remove', 'tcp:' + forward);
  run('shell', 'settings', 'put', 'system', 'user_rotation', rotation);
  run('shell', 'settings', 'put', 'system', 'accelerometer_rotation', automatic);
}
