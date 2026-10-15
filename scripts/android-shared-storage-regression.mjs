import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';

const output = path.resolve(process.argv[2]);
const proof = JSON.parse(await readFile(path.join(output, 'verification.json'), 'utf8'));
const adb = process.env.NARUTO_ANDROID_ADB;
assert.ok(adb, 'Set NARUTO_ANDROID_ADB');
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000 });
assert.equal(run('shell', 'getprop', 'ro.kernel.qemu').trim(), '1', 'Only use the dedicated emulator');
let browser, port;
try {
  run('shell', 'am', 'start', '-n', 'asia.qiwu.narutorpg/.MainActivity');
  const socket = run('shell', 'cat', '/proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1];
  assert.ok(socket, 'WebView socket missing');
  port = run('forward', 'tcp:0', 'localabstract:' + socket).trim();
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true });
  const page = browser.contexts()[0].pages()[0];
  await page.locator('#btn-save-library').waitFor({ timeout: 45000 });
  const result = await page.evaluate(async fixture => {
    const { stateManager: sm } = await import('/js/core/state-manager.js');
    const { timelineSystem: timeline } = await import('/js/systems/timeline-system.js');
    const { timelineStorageTask: task } = await import('/js/core/timeline-storage-client.js');
    const { compressTimelineNode, decompressTimelineNode } = await import('/js/core/timeline-node-codec.js');
    const { checksumSaveJson } = await import('/js/core/save-json-stream.js');
    const { decodeTimelineSaveFile } = await import('/js/core/timeline-file-codec.js');
    const { validateSavePackage } = await import('/js/core/save-library.js');
    const check = (ok, label) => { if (!ok) throw new Error(label); };
    await sm.initDB();
    const head = fixture.nodes.at(-1), memory = '档'.repeat(12 * 1024 * 1024);
    head.state_snapshot._memory.archived = memory;
    fixture.nodes[fixture.nodes.length - 1] = await compressTimelineNode(head);
    const originalDigest = await checksumSaveJson(fixture.nodes.at(-1));
    await sm.dbReplaceTimeline(fixture);
    const original = await task('capture', { label: '安卓大节点原始档' });
    const preview = await task('preview', { id: original.id });
    check(preview.state_snapshot._memory.archived === memory, 'legacy worker preview lost memory');
    const compacted = await task('compact', { id: original.id });
    const shared = (await sm.dbGet('timeline_archive_nodes', [compacted.id, head.id])).node;
    check(shared.payload_encoding === 'shared-json-v1' && shared.payload.byteLength > 32 * 1024 * 1024, 'shared fixture too small');
    check((await decompressTimelineNode(shared, { db: sm.getDB(), verifyStorage: true })).state_snapshot._memory.archived === memory, 'shared roundtrip lost memory');
    const pack = await validateSavePackage(await decodeTimelineSaveFile((await task('export', { id: compacted.id })).blob));
    check(pack.payload.nodes.find(node => node.id === head.id).state_snapshot._memory.archived === memory, 'portable export lost memory');
    await timeline.restoreArchive(compacted.id);
    check(sm.getSub('_memory').archived === memory, 'restore lost memory');
    check(await checksumSaveJson((await sm.dbGet('timeline_archive_nodes', [original.id, head.id])).node) === originalDigest, 'raw original changed');
    localStorage.setItem('naruto_android_shared_storage_probe', original.id);
    return { bytes: shared.payload.byteLength, originalId: original.id, originalDigest, nodeId: head.id,
      dbVersion: sm.getDB().version, nodeCount: pack.payload.nodes.length, legacyPreview: true,
      sharedRoundtrip: true, portableExport: true, originalPreserved: true };
  }, makeContinuationFixture(4));
  await page.reload();
  await page.locator('#btn-save-library').waitFor({ timeout: 45000 });
  const reloaded = await page.evaluate(async data => {
    const { stateManager: sm } = await import('/js/core/state-manager.js');
    const { timelineSystem: timeline } = await import('/js/systems/timeline-system.js');
    const { checksumSaveJson } = await import('/js/core/save-json-stream.js');
    await sm.initDB();
    const head = await timeline._hydrateNode(await sm.dbGet('timeline_nodes', data.nodeId));
    return head.state_snapshot._memory.archived.length === 12 * 1024 * 1024
      && localStorage.getItem('naruto_android_shared_storage_probe') === data.originalId
      && await checksumSaveJson((await sm.dbGet('timeline_archive_nodes', [data.originalId, data.nodeId])).node) === data.originalDigest;
  }, result);
  assert.equal(reloaded, true);
  await writeFile(path.join(output, 'shared-storage-device.json'), JSON.stringify({ ...result, reload: reloaded, version: proof.version, apkSha256: proof.sha256 }, null, 2));
  console.log('PASS real Android WebView: >32 MiB legacy/shared reads, worker compaction, portable export, restore, reload and original preservation');
} finally {
  await browser?.close();
  if (port) run('forward', '--remove', 'tcp:' + port);
}
