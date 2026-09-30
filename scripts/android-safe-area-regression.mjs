import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const output = path.resolve(process.argv[2]);
const adb = process.env.NARUTO_ANDROID_ADB;
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
assert.ok(adb, 'Set NARUTO_ANDROID_ADB');
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(run('shell', 'getprop', 'ro.kernel.qemu').trim(), '1', 'Only a dedicated emulator may be reconfigured');
const proof = JSON.parse(await fs.readFile(path.join(output, 'verification.json'), 'utf8'));
const apkPath = run('shell', 'pm', 'path', 'asia.qiwu.narutorpg').trim().replace(/^package:/, '');
const apkBytes = execFileSync(adb, ['-s', serial, 'exec-out', 'cat', apkPath], { timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
assert.equal(createHash('sha256').update(apkBytes).digest('hex'), proof.sha256);
const rotation = run('shell', 'settings', 'get', 'system', 'user_rotation').trim();
const automatic = run('shell', 'settings', 'get', 'system', 'accelerometer_rotation').trim();
const cutout = 'com.android.internal.display.cutout.emulation.tall';
const cutoutEnabled = run('shell', 'cmd', 'overlay', 'list').includes('[x] ' + cutout);
const states = [];
let browser, forward;
const screenshot = name => fs.writeFile(path.join(output, name + '.png'), execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }));
try {
  run('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  for (const state of [
    { name: 'portrait', rotation: '0', cutout: false },
    { name: 'landscape', rotation: '1', cutout: false },
    { name: 'portrait-cutout', rotation: '0', cutout: true },
    { name: 'landscape-cutout', rotation: '1', cutout: true },
  ]) {
    run('shell', 'cmd', 'overlay', state.cutout ? 'enable' : 'disable', cutout);
    run('shell', 'settings', 'put', 'system', 'user_rotation', state.rotation);
    const result = run('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'asia.qiwu.narutorpg.NativeRuntimeTest', 'asia.qiwu.narutorpg.test/androidx.test.runner.AndroidJUnitRunner');
    await fs.writeFile(path.join(output, 'safe-area-' + state.name + '.txt'), result);
    assert.match(result, /OK \(1 test\)/, result);
    const geometry = run('logcat', '-d', '-s', 'NarutoSafeArea:I', '*:S').split('\n').filter(line => line.includes('window=')).at(-1)?.trim();
    assert.ok(geometry, 'Native window geometry missing');
    states.push({ ...state, geometry });
    run('shell', 'am', 'start', '-n', 'asia.qiwu.narutorpg/.MainActivity');
    await screenshot('safe-area-' + state.name);
    console.log('PASS native system bars and cutout: ' + state.name + '; ' + geometry);
  }
  run('shell', 'cmd', 'overlay', 'disable', cutout);
  run('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  run('shell', 'am', 'start', '-n', 'asia.qiwu.narutorpg/.MainActivity');
  let socket;
  for (let i = 0; i < 40 && !socket; i++) {
    socket = run('shell', 'cat', '/proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1];
    if (!socket) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(socket);
  forward = run('forward', 'tcp:0', 'localabstract:' + socket).trim();
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + forward, { noDefaults: true });
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('api-config-form #settings-api-url');
  const fullHeight = await page.evaluate(() => innerHeight);
  await page.locator('api-config-form #settings-api-url').click();
  await page.waitForFunction(height => innerHeight < height - 100, fullHeight, { timeout: 15000 });
  const keyboardHeight = await page.evaluate(() => innerHeight);
  const field = await page.locator('api-config-form #settings-api-url').boundingBox();
  assert.ok(field && field.y >= 0 && field.y + field.height <= keyboardHeight + 1, JSON.stringify(field));
  await screenshot('safe-area-keyboard');
  run('shell', 'input', 'keyevent', '4');
  await page.waitForFunction(height => innerHeight >= height - 1 && document.querySelector('#app-shell').getBoundingClientRect().height >= height - 1, fullHeight);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await screenshot('safe-area-final');
  await fs.writeFile(path.join(output, 'safe-area-verification.json'), JSON.stringify({ testedAt: new Date().toISOString(), apkSha256: proof.sha256, states, keyboard: { fullHeight, keyboardHeight, visibleField: field }, oldBuildReproduced: 'Top controls overlap status bar or cutout' }, null, 2) + '\n');
  console.log(`PASS native keyboard resize and recovery: ${fullHeight} -> ${keyboardHeight} -> ${fullHeight}`);
} finally {
  if (browser) await browser.close();
  if (forward) run('forward', '--remove', 'tcp:' + forward);
  run('shell', 'cmd', 'overlay', cutoutEnabled ? 'enable' : 'disable', cutout);
  for (const [name, value] of [['user_rotation', rotation], ['accelerometer_rotation', automatic]]) {
    run('shell', 'settings', value === 'null' ? 'delete' : 'put', 'system', name, ...(value === 'null' ? [] : [value]));
  }
}
