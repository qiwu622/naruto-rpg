import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LocalSaveLibrary, PERSONAL_SAVE_KIND, ROOM_SAVE_KIND, createSavePackage } from '../js/core/save-library.js';
import { encodeTimelineSave, decodeTimelineSaveFile, DEFAULT_MAX_DECOMPRESSED_BYTES } from '../js/core/timeline-file-codec.js';

// Exercise the actual library -> native file export boundary. Storage is the
// only substitute: no user's IndexedDB or real phone filesystem is touched.
const entry = { id: 'large-export', kind: PERSONAL_SAVE_KIND, owner: 'device', label: '完整备份/新名称' };
const library = new LocalSaveLibrary();
let stored, bytes, hash, begin, cancelled = false, cancelCount = 0;
library._read = async (store, id) => id === entry.id ? (store === 'entries' ? entry : stored) : undefined;
const priorBridge = globalThis.Capacitor;
const plugin = {
  async beginSave(options) { begin = options; bytes = 0; hash = createHash('sha256'); return { id: 'native-export' }; },
  async appendSave({ offset, data }) {
    assert.equal(offset, bytes);
    const chunk = Buffer.from(data, 'base64'); bytes += chunk.length; hash.update(chunk);
  },
  async finishSave() { return { cancelled }; },
  async cancelSave() { cancelCount++; }
};
globalThis.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, registerPlugin: () => plugin };
let passed = 0;
const ok = name => { passed++; console.log(`PASS ${name}`); };
try {
  // Valid JSON exceeding the real production boundary, created in small chunks
  // so the regression itself need not retain a 201 MiB string/object graph.
  const padding = new TextEncoder().encode('x'.repeat(1024 * 1024));
  const checksum = createHash('sha256').update('{"history":"');
  for (let i = 0; i < 201; i++) checksum.update(padding);
  checksum.update('"}');
  const prefix = JSON.stringify({ schema: 'naruto.save-package/v1', kind: PERSONAL_SAVE_KIND,
    saved_at: '2026-10-03T00:00:00Z', label: '完整备份', checksum: { algorithm: 'SHA-256', value: checksum.digest('hex') } }).slice(0, -1) + ',"payload":{"history":"';
  let index = -1;
  const source = new ReadableStream({ pull(controller) {
    index++;
    if (index === 0) controller.enqueue(new TextEncoder().encode(prefix));
    else if (index <= 201) controller.enqueue(padding);
    else if (index === 202) controller.enqueue(new TextEncoder().encode('"}}'));
    else controller.close();
  } });
  const largeBlob = await new Response(source.pipeThrough(new CompressionStream('gzip'))).blob();
  stored = { id: entry.id, blob: largeBlob };
  // Establish the old failure at the exact 200 MiB boundary before export.
  await assert.rejects(decodeTimelineSaveFile(largeBlob), /超过 200 MiB.*停止导入/);
  const result = await library.export(entry.id, PERSONAL_SAVE_KIND);
  assert.equal(result.format, 'gzip');
  assert.equal(result.cancelled, false);
  assert.equal(result.blob.size, largeBlob.size);
  assert.equal(bytes, largeBlob.size);
  assert.match(begin.fileName, /完整备份_新名称\.json\.gz$/);
  assert.equal(begin.mimeType, 'application/gzip');
  assert.equal(hash.digest('hex'), createHash('sha256').update(Buffer.from(await largeBlob.arrayBuffer())).digest('hex'));
  ok('201 MiB original archive exports byte-for-byte through Android without decompression');

  const pack = await createSavePackage(PERSONAL_SAVE_KIND, { nodes: [{ id: '旧档', summary: '正文、记忆、IF 分支均完整保留' }], branches: [{ id: 'if-a' }] }, '快照原名');
  for (const compression of ['json', 'gzip']) {
    const encoded = await encodeTimelineSave(pack, { compression });
    stored = { id: entry.id, blob: new Blob([encoded.blob], { type: 'application/octet-stream' }) };
    const result = await library.export(entry.id, PERSONAL_SAVE_KIND);
    assert.equal(result.format, compression);
    assert.deepEqual(await decodeTimelineSaveFile(result.blob), pack, 'stored snapshot and checksum are preserved');
    assert.equal(bytes, encoded.blob.size);
  }
  ok('JSON fallback and gzip are detected by bytes, preserve complete signed snapshot and use current filename');

  cancelled = true;
  assert.equal((await library.export(entry.id, PERSONAL_SAVE_KIND)).cancelled, true);
  await assert.rejects(library.export(entry.id, ROOM_SAVE_KIND), /找不到当前账号/);
  await assert.rejects(library.export(entry.id, PERSONAL_SAVE_KIND, 'another-account'), /找不到当前账号/);
  stored = null;
  await assert.rejects(library.export(entry.id, PERSONAL_SAVE_KIND), /快照|文件|存档/);
  assert.equal(cancelCount, 4);
  assert.equal(DEFAULT_MAX_DECOMPRESSED_BYTES, 200 * 1024 * 1024, 'external import limit is unchanged');
  ok('cancel, wrong partition/account and missing snapshot remain safe; external import policy is unchanged');
} finally {
  if (priorBridge === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = priorBridge;
}
console.log(`Large save library export regression: ${passed} groups passed.`);
