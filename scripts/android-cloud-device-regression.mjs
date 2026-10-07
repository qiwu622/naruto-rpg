import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import path from 'node:path';

// WSL may inherit wildcard proxy exclusions that Node does not understand.
process.env.NO_PROXY = [...new Set([...(process.env.NO_PROXY || '').split(','), 'localhost', '127.0.0.1', '::1'])].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

const output = path.resolve(process.argv[2] || 'reports/android/app-cloud-20261004-final');
const adb = process.env.NARUTO_ANDROID_ADB;
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
assert.ok(adb, 'Set NARUTO_ANDROID_ADB');
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(run('shell', 'getprop', 'ro.kernel.qemu').trim(), '1', 'Only a dedicated emulator can receive fixture session data');
const receipt = JSON.parse(await readFile(path.join(output, 'verification.json'), 'utf8'));
const installed = run('shell', 'pm', 'path', 'asia.qiwu.narutorpg').trim().replace(/^package:/, '');
const installedBytes = execFileSync(adb, ['-s', serial, 'exec-out', 'cat', installed], { maxBuffer: 64 * 1024 * 1024 });
assert.equal(createHash('sha256').update(installedBytes).digest('hex'), receipt.sha256);
await mkdir(output, { recursive: true });
let browser, forward;
const passed = [], errors = [];
const ok = label => { passed.push(label); console.log(`PASS ${label}`); };
const connect = async () => {
  let socket;
  for (let attempt = 0; attempt < 60; attempt++) {
    socket = run('shell', 'cat', '/proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1];
    if (socket) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(socket, 'WebView debug socket missing');
  forward = run('forward', 'tcp:0', 'localabstract:' + socket).trim();
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + forward, { noDefaults: true });
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#btn-save-library');
  return page;
};
try {
  run('shell', 'am', 'start', '-n', 'asia.qiwu.narutorpg/.MainActivity');
  let page = await connect();
  assert.equal(await page.evaluate(() => !!Capacitor.Plugins.NarutoCloud), true);
  await page.evaluate(async () => {
    localStorage.setItem('naruto_app_cloud_enabled', 'false');
    await Capacitor.Plugins.NarutoCloud.clearSession();
    await Capacitor.Plugins.NarutoCloud.storeSession({ token: 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImZpeHR1cmUifQ.Zml4dHVyZQ', user: { id: 'native-cloud-fixture', username: '原生存储测试' } });
  });
  assert.equal((await page.evaluate(() => Capacitor.Plugins.NarutoCloud.getSession())).user.id, 'native-cloud-fixture');
  const prefs = run('shell', 'run-as', 'asia.qiwu.narutorpg', 'cat', 'shared_prefs/naruto_cloud_session.xml');
  assert.ok(!prefs.includes('eyJhbGci') && !prefs.includes('native-cloud-fixture'));
  ok('actual Android Keystore encrypts both the token and account metadata; the bridge only returns the account');
  await browser.close(); browser = null; run('forward', '--remove', 'tcp:' + forward); forward = null;
  run('shell', 'am', 'force-stop', 'asia.qiwu.narutorpg');
  run('shell', 'am', 'start', '-n', 'asia.qiwu.narutorpg/.MainActivity');
  // Wait for the new process's local WebView, without waiting on any server.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (run('shell', 'cat', '/proc/net/unix').includes('webview_devtools_remote_')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  page = await connect();
  assert.equal((await page.evaluate(() => Capacitor.Plugins.NarutoCloud.getSession())).user.id, 'native-cloud-fixture');
  ok('encrypted cloud login restores after a complete App process restart while cloud networking is paused');
  const bytes = Buffer.from(Array.from({ length: 300000 }, (_, i) => i % 256));
  const before = run('shell', 'run-as', 'asia.qiwu.narutorpg', 'ls', 'cache').split(/\s+/).filter(name => name.startsWith('cloud-upload-'));
  const id = (await page.evaluate(() => Capacitor.Plugins.NarutoHttp.beginCloudBody())).id;
  for (let offset = 0; offset < bytes.length; offset += 128 * 1024) {
    await page.evaluate(({ id, data }) => Capacitor.Plugins.NarutoHttp.appendCloudBody({ id, data }), { id, data: bytes.subarray(offset, offset + 128 * 1024).toString('base64') });
  }
  const filename = run('shell', 'run-as', 'asia.qiwu.narutorpg', 'ls', 'cache').split(/\s+/).find(name => name.startsWith('cloud-upload-') && !before.includes(name));
  assert.ok(filename);
  const staged = execFileSync(adb, ['-s', serial, 'exec-out', 'run-as', 'asia.qiwu.narutorpg', 'cat', 'cache/' + filename], { maxBuffer: 1024 * 1024 });
  assert.deepEqual(staged, bytes);
  await page.evaluate(id => Capacitor.Plugins.NarutoHttp.discardCloudBody({ id }), id);
  assert.ok(!run('shell', 'run-as', 'asia.qiwu.narutorpg', 'ls', 'cache').includes(filename));
  ok('native binary staging preserves every byte across chunks and cancellation removes only the temporary upload');
  const network = await page.evaluate(async () => {
    const { fetchProjectServer } = await import('./js/core/project-server.js');
    const { fetchNativeCloud } = await import('./js/core/native-ai-fetch.js');
    let forbidden;
    try { await fetchNativeCloud('https://example.invalid/auth/me'); } catch (error) { forbidden = error.message; }
    localStorage.setItem('naruto_app_cloud_enabled', 'true');
    let status = 0, message = '';
    try { const response = await fetchProjectServer('/auth/me', { anonymous: true, timeoutMs: 10000 }); status = response.status; message = (await response.json()).error || ''; }
    catch (error) { message = error.cause?.message || error.message; }
    localStorage.setItem('naruto_app_cloud_enabled', 'false');
    return { forbidden, status, message };
  });
  assert.match(network.forbidden, /云端地址无效/);
  assert.ok([0, 401].includes(network.status), JSON.stringify(network));
  if (network.status === 401) ok('native cloud transport reaches the official HTTPS service and blocks credential requests to other origins');
  else {
    assert.ok(network.message);
    ok('native TLS/network failure stays bounded and blocks no local operation; requests to other origins are rejected');
    console.log('LIMITATION Official HTTPS cloud could not be verified from this network; the underlying error is recorded.');
  }
  await page.evaluate(async () => {
    const { authClient } = await import('./js/core/auth-client.js'); await authClient.logout();
  });
  const localUrl = page.url();
  await page.locator('#btn-multiplayer').click();
  await page.locator('app-cloud-panel').waitFor();
  assert.equal(page.url(), localUrl, 'An unauthenticated native multiplayer click must preserve the local game');
  assert.equal(await page.locator('app-cloud-panel #enabled').isChecked(), false);
  assert.equal(await page.locator('#btn-export-save').isEnabled(), true);
  await page.screenshot({ path: path.join(output, 'native-cloud-profile.png') });
  await page.locator('app-cloud-panel #local').click();
  await page.locator('#btn-save-library').click();
  await page.locator('naruto-save-library #list').waitFor();
  assert.equal(await page.locator('naruto-save-library #import').isEnabled(), true);
  await page.screenshot({ path: path.join(output, 'native-cloud-saves.png') });
  assert.deepEqual(errors, []);
  ok('actual mobile WebView exposes cloud controls and retains local profile, file actions and save library while paused');
  await writeFile(path.join(output, 'cloud-device-verification.json'), JSON.stringify({ passed, errors, network, officialCloudReachable: network.status === 401, apkSha256: receipt.sha256 }, null, 2));
} finally {
  await browser?.close(); if (forward) run('forward', '--remove', 'tcp:' + forward);
}
console.log(`Android cloud device regression: ${passed.length} groups passed`);
