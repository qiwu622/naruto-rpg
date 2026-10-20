import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';

const output = path.resolve(process.argv[2]);
const proof = JSON.parse(await readFile(path.join(output, 'verification.json'), 'utf8'));
const adb = process.env.NARUTO_ANDROID_ADB;
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const appId = 'asia.qiwu.narutorpg';
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(run('shell', 'getprop', 'ro.kernel.qemu').trim(), '1', 'Only use a dedicated emulator');
let browser, port;
const passed = [];
const ok = message => { passed.push(message); console.log('PASS ' + message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 400));
async function connect() {
  run('shell', 'am', 'start', '-n', `${appId}/.MainActivity`);
  let socket;
  for (let attempt = 0; attempt < 80; attempt++) {
    socket = run('shell', 'cat', '/proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1];
    if (socket) break;
    await pause();
  }
  assert.ok(socket, 'WebView did not start');
  port = run('forward', 'tcp:0', 'localabstract:' + socket).trim();
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true });
  const page = browser.contexts()[0].pages()[0];
  await page.locator('#btn-save-library').waitFor({ timeout: 45000 });
  return page;
}
async function disconnect() {
  await browser?.close(); browser = null;
  if (port) { run('forward', '--remove', 'tcp:' + port); port = null; }
}
async function systemUI(name) {
  run('shell', 'uiautomator', 'dump', '/sdcard/naruto-update-test.xml');
  const xml = run('exec-out', 'cat', '/sdcard/naruto-update-test.xml');
  await writeFile(path.join(output, name + '.xml'), xml);
  await writeFile(path.join(output, name + '.png'), execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }));
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(match => Object.fromEntries(
    [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(item => [item[1], item[2]])));
}
function tap(node) {
  assert.ok(node, 'Expected Android control is missing; inspect the saved XML/screenshot');
  const bounds = node.bounds.match(/\d+/g).map(Number);
  run('shell', 'input', 'tap', String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2)));
}
async function waitSystemUI(name, ready) {
  const deadline = Date.now() + 20000;
  do {
    const controls = await systemUI(name);
    if (ready(controls)) return controls;
    await pause();
  } while (Date.now() < deadline);
  assert.fail('Android control did not become interactive; inspect ' + name);
}
async function openPanel(page) {
  await page.evaluate(async proof => {
    for (const modal of document.querySelectorAll('game-modal')) modal.close();
    const { openAndroidUpdatePanel } = await import('/js/ui/android-update-panel.js');
    // The unpublished binary is served by instrumentation's loopback fixture.
    // All status, signature verification, permission and installation calls use
    // the real production bridge. There is no alternate URL in the JS bridge.
    void openAndroidUpdatePanel({ updateAvailable: true, currentVersion: 'upgrade fixture', latestVersion: proof.version,
      latestVersionCode: proof.versionCode, releaseNotes: ['系统下载和安装验收'], announcement: '保留现有本地存档' });
  }, proof);
  await page.getByRole('button', { name: '立即安装', exact: true }).waitFor({ timeout: 15000 });
}
try {
  // An interrupted fixture may leave a resumable task pointing at its now-closed
  // ephemeral HTTP port. Clear that test task before preparing a fresh fixture.
  const initial = await connect();
  await initial.evaluate(async () => {
    const { getNativeUpdater } = await import('/js/core/app-update.js');
    await getNativeUpdater().cancel();
  });
  await disconnect();
  const instrumentation = run('shell', 'am', 'instrument', '-w', '-r', '-e', 'class',
    'asia.qiwu.narutorpg.NativeUpdaterTest#prepareInstallerFixture', `${appId}.test/androidx.test.runner.AndroidJUnitRunner`);
  await writeFile(path.join(output, 'installer-fixture.txt'), instrumentation);
  assert.match(instrumentation, /OK \(1 test\)/, instrumentation);
  run('shell', 'appops', 'set', appId, 'REQUEST_INSTALL_PACKAGES', 'deny');
  let page = await connect();
  await page.evaluate(async fixture => {
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    await timelineSystem.init(); await timelineSystem.importTimeline(fixture);
    localStorage.setItem('naruto_in_app_upgrade_probe', 'keep-me');
  }, makeContinuationFixture(4));
  await openPanel(page);
  await page.screenshot({ path: path.join(output, 'in-app-update-ready.png') });
  await page.getByRole('button', { name: '立即安装', exact: true }).click();
  let controls = await waitSystemUI('in-app-install-permission', nodes => nodes.some(node => node.checkable === 'true' && node.clickable === 'true' && node.checked === 'false' && node.enabled === 'true'));
  assert.ok(controls.some(node => node.package === 'com.android.settings'), 'Expected the real install permission settings');
  const toggle = controls.find(node => node.checkable === 'true' && node.clickable === 'true' && node.checked === 'false');
  tap(toggle);
  ok('real native bridge opens Android install permission and allows user confirmation');
  run('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  run('shell', 'am', 'start', '-n', `${appId}/.MainActivity`);
  await page.getByRole('button', { name: '立即安装', exact: true }).waitFor();
  await page.getByRole('button', { name: '立即安装', exact: true }).click();
  controls = await waitSystemUI('in-app-system-installer', nodes => nodes.some(node => /^(Update|Install|更新|安装)$/i.test(node.text) && node.enabled === 'true'));
  assert.ok(controls.some(node => /packageinstaller/.test(node.package)), 'Expected Android package installer');
  const update = controls.find(node => /^(Update|Install|更新|安装)$/i.test(node.text) && node.enabled === 'true');
  await disconnect();
  tap(update);
  let installed = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await pause();
    controls = await systemUI('in-app-install-result');
    if (controls.some(node => /App installed|应用已安装|安装完成/i.test(node.text))) { installed = true; break; }
  }
  assert.equal(installed, true, 'Android installer must report completed installation');
  ok('Android system installer completes the downloaded update');
  const installedPath = run('shell', 'pm', 'path', appId).trim().replace(/^package:/, '');
  const bytes = execFileSync(adb, ['-s', serial, 'exec-out', 'cat', installedPath], { maxBuffer: 64 * 1024 * 1024, timeout: 20000 });
  assert.equal(createHash('sha256').update(bytes).digest('hex'), proof.sha256);
  page = await connect();
  const data = await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    await stateManager.initDB();
    const { getNativeUpdater } = await import('/js/core/app-update.js');
    await getNativeUpdater().cancel();
    return { marker: localStorage.getItem('naruto_in_app_upgrade_probe'), root: (await stateManager.dbGet('timeline_nodes', 'main_1'))?.summary,
      head: (await stateManager.dbGet('timeline_nodes', 'if_4'))?.summary, count: (await stateManager.dbGetAll('timeline_nodes')).length };
  });
  assert.deepEqual(data, { marker: 'keep-me', root: '主线1', head: 'IF4', count: 6 });
  ok('system-installed APK matches tested hash and preserves game data and both branches');
  await writeFile(path.join(output, 'in-app-update-device.json'), JSON.stringify({ apkSha256: proof.sha256, version: proof.version, passed, preserved: data,
    downloadFixture: 'Current signed APK downloaded by real DownloadManager from instrumentation loopback HTTP; no production bridge URL override',
    device: run('shell', 'getprop', 'ro.build.version.release').trim() }, null, 2));
} finally { await disconnect(); }
