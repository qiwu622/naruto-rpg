import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const output = path.resolve(process.argv[2] || 'reports/android/device');
const adb = process.env.NARUTO_ANDROID_ADB;
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
assert.ok(adb, 'Set NARUTO_ANDROID_ADB to platform-tools/adb');
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(run('shell', 'getprop', 'ro.kernel.qemu').trim(), '1', 'These fixture tests may only change a dedicated emulator');
await fs.mkdir(output, { recursive: true });
const receiptPath = path.join(output, 'verification.json');
const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
const installedApk = run('shell', 'pm', 'path', 'asia.qiwu.narutorpg').trim().replace(/^package:/, '');
const installedBytes = execFileSync(adb, ['-s', serial, 'exec-out', 'cat', installedApk], { timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
assert.equal(createHash('sha256').update(installedBytes).digest('hex'), receipt.sha256, 'Installed APK must match this build receipt');
let browser, forward, server;
let cancellationObserved = false;
const passed = [];
const ok = label => { passed.push(label); console.log(`PASS ${label}`); };
try {
  const runtime = run('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'asia.qiwu.narutorpg.NativeRuntimeTest',
    'asia.qiwu.narutorpg.test/androidx.test.runner.AndroidJUnitRunner');
  await fs.writeFile(path.join(output, 'instrumentation.txt'), runtime);
  assert.match(runtime, /OK \(1 test\)/);
  ok('actual Android package, local shared UI and both native bridges boot');
  run('shell', 'am', 'start', '-n', 'asia.qiwu.narutorpg/.MainActivity');
  let socket;
  for (let i = 0; i < 60; i++) {
    socket = run('shell', 'cat', '/proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1];
    if (socket) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(socket, 'Native WebView debug socket is missing');
  forward = run('forward', 'tcp:0', 'localabstract:' + socket).trim();
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + forward, { noDefaults: true });
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#btn-save-library');
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth }));
  assert.ok(viewport.width <= 500);
  assert.ok(viewport.scroll <= viewport.width + 1, JSON.stringify(viewport));
  const header = await page.evaluate(() => {
    const left = document.querySelector('.topbar-left').getBoundingClientRect();
    const right = document.querySelector('.topbar-right').getBoundingClientRect();
    return { titleRight: left.right, buttonsLeft: right.left, buttonsRight: right.right, width: innerWidth,
      logo: document.querySelector('.topbar-logo img').getAttribute('src') };
  });
  assert.ok(header.titleRight <= header.buttonsLeft + 1 && header.buttonsRight <= header.width + 1, JSON.stringify(header));
  assert.equal(header.logo, '/img/app-mark.png');
  await page.screenshot({ path: path.join(output, 'startup.png') });
  await page.locator('#btn-save-library').click();
  await page.waitForFunction(() => document.querySelector('game-modal')?.shadowRoot?.querySelector('naruto-save-library')?.shadowRoot?.querySelector('#list'));
  assert.ok(await page.locator('naruto-save-library #import').isVisible());
  await page.screenshot({ path: path.join(output, 'save-library.png') });
  assert.ok((await page.locator('naruto-save-library #storage-place').textContent()).includes('本机 App'));
  await page.evaluate(() => document.querySelector('game-modal').close());
  ok('mobile shared save library opens without horizontal page overflow');

  const chunk = text => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n';
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    if (req.url === '/error') { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":{"message":"fixture invalid key"}}'); return; }
    if (req.url === '/gzip') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }).end(gzipSync('{"正文":"中文压缩响应"}')); return; }
    if (req.url === '/redirect') { res.writeHead(307, { Location: 'http://127.0.0.1:9/do-not-contact' }).end(); return; }
    if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(chunk('已开始'));
      const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 20000);
      res.on('close', () => { cancellationObserved = true; clearTimeout(timer); }); return;
    }
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    assert.equal(JSON.parse(body).stream, true);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chinese = Buffer.from(chunk('清晨，木叶。'));
    // Deliberately split the UTF-8 character 木 across network writes.
    const split = chinese.indexOf(Buffer.from('木')) + 1;
    res.write(chinese.subarray(0, split));
    setTimeout(() => res.write(chinese.subarray(split)), 100);
    setTimeout(() => { res.write(chunk('忍者出发。')); res.end('data: [DONE]\n\n'); }, 1600);
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const origin = `http://10.0.2.2:${server.address().port}`;
  const stream = await page.evaluate(async origin => {
    const { AIClient } = await import('./js/core/ai-client.js');
    const client = new AIClient();
    client.configure({ backend: 'openai', apiUrl: origin + '/v1', apiKey: 'fixture-key', model: 'fixture' });
    const start = performance.now(), chunks = [];
    const text = await client.chatStream([{ role: 'user', content: '开局' }], { maxRetries: 0, timeout: 0 }, text => chunks.push({ text, ms: performance.now() - start }));
    return { text, chunks, doneMs: performance.now() - start };
  }, origin);
  assert.equal(stream.text, '清晨，木叶。忍者出发。');
  assert.ok(stream.chunks[0].ms < stream.doneMs - 800, JSON.stringify(stream));
  assert.ok(stream.doneMs > 1500);
  ok('shared AI client streams real native HTTP Chinese chunks before completion');
  console.log(`STREAM_FIRST_MS=${Math.round(stream.chunks[0].ms)}; STREAM_DONE_MS=${Math.round(stream.doneMs)}`);
  const agent = await page.evaluate(async origin => {
    await import('./js/vendor/agent-sdk.js');
    const { runAgent } = globalThis.NarutoAgentSDK;
    const start = performance.now(), chunks = [];
    const result = await runAgent({ config: { backend: 'openai', apiUrl: origin + '/v1', apiKey: 'fixture-key', model: 'fixture', disableStreaming: false },
      definition: { id: 'android-fixture', instructions: '只返回正文' }, messages: [{ role: 'user', content: '开局' }], budget: { maxSteps: 1 },
      onEvent(event) { if (event.type === 'text-delta') chunks.push({ text: event.delta, ms: performance.now() - start }); } });
    return { text: result.text, chunks, doneMs: performance.now() - start };
  }, origin);
  assert.equal(agent.text, '清晨，木叶。忍者出发。');
  assert.ok(agent.chunks[0].ms < agent.doneMs - 800);
  ok('the bundled shared Agent SDK uses the same native streaming transport');
  const network = await page.evaluate(async origin => {
    const { fetchAI } = await import('./js/core/native-ai-fetch.js');
    const gzip = await (await fetchAI(origin + '/gzip')).json();
    const response = await fetchAI(origin + '/error');
    let redirect;
    try { await fetchAI(origin + '/redirect'); } catch (error) { redirect = error.message; }
    return { gzip, error: await response.json(), status: response.status, redirect };
  }, origin);
  assert.equal(network.gzip.正文, '中文压缩响应');
  assert.equal(network.status, 401);
  assert.equal(network.error.error.message, 'fixture invalid key');
  assert.match(network.redirect, /跨域重定向/);
  ok('native gzip decoding, HTTP error bodies and redirect credential isolation');
  const cancellation = await page.evaluate(async origin => {
    const { fetchAI } = await import('./js/core/native-ai-fetch.js');
    const controller = new AbortController();
    const response = await fetchAI(origin + '/slow', { signal: controller.signal });
    const reader = response.body.getReader(); await reader.read();
    const next = reader.read(); controller.abort();
    try { await next; return 'unexpected success'; } catch (error) { return error.name; }
  }, origin);
  assert.equal(cancellation, 'AbortError');
  for (let i = 0; i < 20 && !cancellationObserved; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(cancellationObserved, 'Stop must close the actual native socket');
  ok('stop generation aborts the shared reader and closes the native HTTP connection');

  const fileName = 'naruto-native-qa-' + Date.now() + '.json';
  const text = JSON.stringify({ title: '安卓存档中文验证', body: '清晨，木叶。'.repeat(40000) });
  await page.evaluate(async ({ text, fileName }) => {
    const { exportFile } = await import('./js/core/file-export.js');
    window.__nativeExportResult = null;
    window.__nativeExportPromise = exportFile(new Blob([text], { type: 'application/json' }), fileName)
      .then(result => window.__nativeExportResult = result, error => window.__nativeExportResult = { error: error.message });
  }, { text, fileName });
  let xml;
  for (let i = 0; i < 10; i++) {
    const result = await page.evaluate(() => window.__nativeExportResult);
    assert.ok(!result?.error, JSON.stringify(result));
    run('shell', 'uiautomator', 'dump', '/sdcard/naruto-qa-window.xml');
    xml = run('shell', 'cat', '/sdcard/naruto-qa-window.xml');
    if (xml.includes('android:id/button1')) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await fs.writeFile(path.join(output, 'system-save-picker.xml'), xml);
  const save = xml.match(/<node\b[^>]*resource-id="android:id\/button1"[^>]*>/)?.[0];
  assert.ok(save, 'Android system file save button was not found');
  const bounds = save.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  run('shell', 'input', 'tap', String(Math.round((+bounds[1] + +bounds[3]) / 2)), String(Math.round((+bounds[2] + +bounds[4]) / 2)));
  await page.waitForFunction(() => window.__nativeExportResult !== null);
  assert.equal((await page.evaluate(() => window.__nativeExportResult)).cancelled, false);
  const saved = execFileSync(adb, ['-s', serial, 'exec-out', 'cat', '/sdcard/Download/' + fileName], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  assert.deepEqual(saved, Buffer.from(text));
  ok('Android system picker saves a real multi-chunk UTF-8 archive byte for byte');

  await page.evaluate(async () => {
    const { exportFile } = await import('./js/core/file-export.js');
    window.__nativeExportResult = null;
    window.__nativeExportPromise = exportFile(new Blob(['cancel fixture']), 'naruto-cancel-qa.txt').then(result => window.__nativeExportResult = result);
  });
  run('shell', 'uiautomator', 'dump', '/sdcard/naruto-qa-window.xml');
  run('shell', 'input', 'keyevent', 'BACK');
  await new Promise(resolve => setTimeout(resolve, 300));
  // If the file-name keyboard was open, the first Back only dismisses it.
  if (await page.evaluate(() => window.__nativeExportResult === null)) run('shell', 'input', 'keyevent', 'BACK');
  await page.waitForFunction(() => window.__nativeExportResult !== null);
  assert.equal((await page.evaluate(() => window.__nativeExportResult)).cancelled, true);
  ok('cancelling the native file picker reports cancellation and keeps the game alive');

  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'native-import-fixture'; input.type = 'file'; input.accept = 'application/json';
    input.style.cssText = 'position:fixed;top:120px;left:10px;width:250px;height:44px;z-index:999999';
    window.__nativeImportResult = null;
    input.onchange = async () => { window.__nativeImportResult = await input.files[0].text(); input.remove(); };
    document.body.append(input);
  });
  await page.locator('#native-import-fixture').click();
  let picked;
  for (let i = 0; i < 10; i++) {
    run('shell', 'uiautomator', 'dump', '/sdcard/naruto-qa-window.xml');
    const picker = run('shell', 'cat', '/sdcard/naruto-qa-window.xml');
    picked = [...picker.matchAll(/<node\b[^>]*>/g)].map(match => match[0])
      .find(node => node.includes(`text="${fileName}"`) && node.includes('package="com.android.documentsui"'));
    if (picked) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(picked, 'Exported file was not available in the system import picker');
  const selected = picked.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  run('shell', 'input', 'tap', String(Math.round((+selected[1] + +selected[3]) / 2)), String(Math.round((+selected[2] + +selected[4]) / 2)));
  await page.waitForFunction(() => window.__nativeImportResult !== null);
  assert.equal(await page.evaluate(() => window.__nativeImportResult), text);
  ok('the native HTML file picker can read the exported Unicode JSON without corruption');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'device-verification.json'), JSON.stringify({
    testedAt: new Date().toISOString(), serial, api: run('shell', 'getprop', 'ro.build.version.sdk').trim(),
    apkSha256: receipt.sha256, viewport, passed, streaming: stream, agentFirstMs: agent.chunks[0].ms, paidModelCalls: 0
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (forward) run('forward', '--remove', 'tcp:' + forward);
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
console.log(`Android device regression: ${passed.length} groups passed`);
