import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';

const output = path.resolve(process.argv[2]);
const receipt = JSON.parse(await readFile(path.join(output, 'verification.json'), 'utf8'));
const adb = process.env.NARUTO_ANDROID_ADB;
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(run('shell', 'getprop', 'ro.kernel.qemu').trim(), '1', 'Only use the dedicated emulator');
const packageName = 'asia.qiwu.narutorpg';
const previousVersion = run('shell', 'dumpsys', 'package', packageName).match(/versionName=(\S+)/)?.[1];
let browser, port;
async function connect() {
  run('shell', 'am', 'start', '-n', `${packageName}/.MainActivity`);
  let socket;
  for (let attempt = 0; attempt < 80; attempt++) {
    socket = run('shell', 'cat', '/proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1];
    if (socket) break;
    await new Promise(resolve => setTimeout(resolve, 250));
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
try {
  const before = await connect();
  await before.evaluate(async fixture => {
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    await timelineSystem.init(); await timelineSystem.importTimeline(fixture);
    localStorage.setItem('naruto_upgrade_preservation_probe', 'v3.6.4-keep-original');
  }, makeContinuationFixture(4));
  await disconnect();
  assert.match(run('install', '-r', path.join(output, `naruto-rpg-${receipt.version}-debug.apk`)), /Success/);
  const after = await connect();
  const preserved = await after.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    await stateManager.initDB();
    const root = await stateManager.dbGet('timeline_nodes', 'main_1');
    const head = await stateManager.dbGet('timeline_nodes', 'if_4');
    return { marker: localStorage.getItem('naruto_upgrade_preservation_probe'), root: root?.summary, head: head?.summary,
      pins: head?.state_snapshot?._memory?.pins, nodeCount: (await stateManager.dbGetAll('timeline_nodes')).length,
      updater: Capacitor.isPluginAvailable('NarutoUpdater'), origin: location.origin };
  });
  assert.equal(preserved.marker, 'v3.6.4-keep-original');
  assert.equal(preserved.root, '主线1'); assert.equal(preserved.head, 'IF4');
  assert.equal(preserved.nodeCount, 6); assert.equal(preserved.pins, '保留最初的约定');
  assert.equal(preserved.updater, true);
  await writeFile(path.join(output, 'upgrade-preservation.json'), JSON.stringify({ previousVersion, version: receipt.version, apkSha256: receipt.sha256, preserved }, null, 2));
  console.log(`PASS Android ${previousVersion} -> ${receipt.version} cover install preserves LocalStorage, six timeline nodes, both branches and existing memory; native updater registered`);
} finally { await disconnect(); }
