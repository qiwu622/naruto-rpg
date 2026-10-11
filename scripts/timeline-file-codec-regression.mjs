import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  TIMELINE_FILE_ACCEPT,
  decodeTimelineSaveFile,
  encodeTimelineSave
} from '../js/core/timeline-file-codec.js';
import { timelineSystem } from '../js/systems/timeline-system.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

const save = {
  export_version: '2.0',
  exported_at: '2026-07-28T00:00:00.000Z',
  include_archive: false,
  meta: { key: 'root', value: { current_id: 'node_root' } },
  branches: [{ id: 'branch_main', name: '主线' }],
  nodes: [{ id: 'node_root', state_snapshot: { player: { name: '漩涡鸣人' } } }]
};

await test('gzip export round-trips Unicode timeline JSON', async () => {
  const encoded = await encodeTimelineSave(save, { compression: 'gzip' });
  assert.equal(encoded.format, 'gzip');
  assert.equal(encoded.extension, '.json.gz');
  assert.equal(encoded.blob.type, 'application/gzip');
  assert.deepEqual(await decodeTimelineSaveFile(encoded.blob), save);
});

await test('plain JSON remains a lossless supported format', async () => {
  const encoded = await encodeTimelineSave(save, { compression: 'json' });
  assert.equal(encoded.format, 'json');
  assert.equal(encoded.extension, '.json');
  assert.equal(encoded.blob.type, 'application/json');
  assert.deepEqual(await decodeTimelineSaveFile(encoded.blob), save);
});

await test('encoder streams top-level arrays without stringifying the complete save object', async () => {
  const largeSave = {
    ...save,
    branches: Array.from({ length: 20 }, (_, index) => ({ id: `branch_${index}`, name: `分支${index}` })),
    nodes: Array.from({ length: 200 }, (_, index) => ({
      id: `node_${index}`,
      state_snapshot: { text: `第${index}回合`.repeat(128) }
    }))
  };
  const originalStringify = JSON.stringify;
  JSON.stringify = function guardedStringify(value, ...args) {
    if (value === largeSave) throw new Error('complete save object must not be stringified at once');
    return originalStringify.call(JSON, value, ...args);
  };
  try {
    const encoded = await encodeTimelineSave(largeSave, { compression: 'gzip' });
    assert.deepEqual(await decodeTimelineSaveFile(encoded.blob), largeSave);
  } finally {
    JSON.stringify = originalStringify;
  }
});

await test('decoder detects gzip from magic bytes instead of the file name', async () => {
  const encoded = await encodeTimelineSave(save, { compression: 'gzip' });
  const misleadingName = new Blob([await encoded.blob.arrayBuffer()], { type: 'application/json' });
  Object.defineProperty(misleadingName, 'name', { value: 'timeline.json' });
  assert.deepEqual(await decodeTimelineSaveFile(misleadingName), save);

  const jsonWithGzipName = new Blob([JSON.stringify(save)], { type: 'application/gzip' });
  Object.defineProperty(jsonWithGzipName, 'name', { value: 'timeline.json.gz' });
  assert.deepEqual(await decodeTimelineSaveFile(jsonWithGzipName), save);
});

await test('automatic export falls back to JSON when CompressionStream is unavailable', async () => {
  const original = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    const encoded = await encodeTimelineSave(save, { compression: 'auto' });
    assert.equal(encoded.format, 'json');
    assert.equal(encoded.extension, '.json');
    assert.match(encoded.fallbackReason, /CompressionStream|压缩/);
  } finally {
    globalThis.CompressionStream = original;
  }
});

await test('gzip import reports missing DecompressionStream support clearly', async () => {
  const encoded = await encodeTimelineSave(save, { compression: 'gzip' });
  const original = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    await assert.rejects(
      () => decodeTimelineSaveFile(encoded.blob),
      /DecompressionStream|不支持.*gzip/
    );
  } finally {
    globalThis.DecompressionStream = original;
  }
});

await test('corrupted gzip and invalid JSON return actionable errors', async () => {
  const corrupted = new Blob([new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff])]);
  await assert.rejects(() => decodeTimelineSaveFile(corrupted), /损坏|解压/);
  await assert.rejects(
    () => decodeTimelineSaveFile(new Blob(['{"nodes":'])) ,
    /JSON|解析/
  );
});

await test('decompressed data is rejected as soon as it exceeds the configured limit', async () => {
  const encoded = await encodeTimelineSave(save, { compression: 'gzip' });
  await assert.rejects(
    () => decodeTimelineSaveFile(encoded.blob, { maxDecompressedBytes: 32 }),
    /32 B|上限|过大/
  );
  assert.equal(DEFAULT_MAX_DECOMPRESSED_BYTES, Infinity);
});

await test('default local import has no fixed byte cap; explicit caps remain validated', async () => {
  const encoded = await encodeTimelineSave(save, { compression: 'json' });
  assert.deepEqual(await decodeTimelineSaveFile(encoded.blob, { maxDecompressedBytes: Infinity }), save);
  await assert.rejects(() => decodeTimelineSaveFile(encoded.blob, { maxDecompressedBytes: 32 }), /32 B|上限/);
  for (const maxDecompressedBytes of [0, -1, -Infinity, NaN, 1.5, null]) {
    await assert.rejects(() => decodeTimelineSaveFile(encoded.blob, { maxDecompressedBytes }), /上限必须/);
  }
});

await test('timeline download defaults to gzip and keeps plain JSON as an explicit option', async () => {
  const originalDocument = globalThis.document;
  const originalGetExportData = timelineSystem.getExportData;
  const downloads = [];
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return {
        href: '',
        download: '',
        click() {
          downloads.push(this.download);
        }
      };
    }
  };
  timelineSystem.getExportData = async () => save;
  try {
    const compressed = await timelineSystem.exportTimeline();
    assert.equal(compressed.format, 'gzip');
    assert.match(compressed.fileName, /\.json\.gz$/);
    assert.deepEqual(await decodeTimelineSaveFile(compressed.blob), save);

    const plain = await timelineSystem.exportTimeline({ compression: 'json' });
    assert.equal(plain.format, 'json');
    assert.match(plain.fileName, /\.json$/);
    assert.doesNotMatch(plain.fileName, /\.json\.gz$/);
    assert.deepEqual(downloads, [compressed.fileName, plain.fileName]);
  } finally {
    timelineSystem.getExportData = originalGetExportData;
    globalThis.document = originalDocument;
  }
});

await test('every local timeline import entry accepts gzip and uses the shared decoder', async () => {
  assert.match(TIMELINE_FILE_ACCEPT, /\.json/);
  assert.match(TIMELINE_FILE_ACCEPT, /\.json\.gz/);
  assert.match(TIMELINE_FILE_ACCEPT, /\.gz/);
  const sources = await Promise.all([
    readFile(new URL('../js/ui/app-shell.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/ui/character-creator.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/app.js', import.meta.url), 'utf8')
  ]);
  for (const source of sources) assert.match(source, /TIMELINE_FILE_ACCEPT/);
  assert.match(sources[2], /decodeTimelineSaveFile\(file\)/);
  assert.doesNotMatch(sources[2], /const text = await file\.text\(\)/);
});

console.log(`\n${passed} timeline file codec regression tests passed.`);
