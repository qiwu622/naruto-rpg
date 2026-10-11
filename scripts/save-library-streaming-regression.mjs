import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cleanSaveData, saveChecksum, createSavePackage, validateSavePackage, PERSONAL_SAVE_KIND } from '../js/core/save-library.js';
import { encodeTimelineSave, decodeTimelineSaveFile } from '../js/core/timeline-file-codec.js';
import { saveJsonContainsText } from '../js/core/save-json-stream.js';

let failed = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
const fixture = {
  meta: { current: 'node-393' },
  nodes: Array.from({ length: 393 }, (_, i) => ({ id: `node-${i+1}`, text: '完整正文🌸\\"\n'.repeat(100), state_snapshot: { _memory: { facts: `第${i}回合已发生` } } }))
};
const stringify = JSON.stringify;
const parse = JSON.parse;
async function withoutWholeArchiveString(operation) {
  JSON.stringify = function(value, ...args) {
    if (value?.nodes?.length > 100 || value?.payload?.nodes?.length > 100 || (Array.isArray(value) && value.length > 100)) throw new RangeError('Invalid string length: whole archive serialization');
    return stringify(value, ...args);
  };
  try { return await operation(); } finally { JSON.stringify = stringify; }
}

await test('cleaning does not stringify the entire 393-turn archive', async () => {
  const data = { ...fixture, settings: { apiKey: 'never-save', colour: 'gold' } };
  const cleaned = await withoutWholeArchiveString(() => cleanSaveData(data));
  assert.equal(cleaned.nodes.length, 393); assert.equal(cleaned.settings.apiKey, undefined);
  assert.equal(cleaned.settings.colour, 'gold'); assert.equal(data.settings.apiKey, 'never-save');
  assert.notEqual(cleaned.nodes, data.nodes);
});
await test('incremental checksums match the legacy SHA-256 bytes exactly', async () => {
  const expected = createHash('sha256').update(stringify(fixture)).digest('hex');
  assert.equal(await withoutWholeArchiveString(() => saveChecksum(fixture)), expected);
  const pack = await withoutWholeArchiveString(() => createSavePackage(PERSONAL_SAVE_KIND, fixture));
  assert.equal(pack.checksum.value, expected);
  assert.equal(await withoutWholeArchiveString(() => validateSavePackage(pack)), pack);
});
await test('cleaning preserves JSON value semantics and removes credentials recursively', () => {
  const value = { a: undefined, b: Infinity, date: new Date('2026-10-10T00:00:00Z'), array: [undefined, NaN, , { access_token: 'secret', keep: '正文' }], nested: { api_key: 'secret', keep: false } };
  const expected = parse(stringify(value, (key, item) => /^(api_key|access_token)$/.test(key) ? undefined : item));
  assert.deepEqual(cleanSaveData(value), expected);
  assert.throws(() => cleanSaveData({ a: 1n }), /BigInt|bigint/);
  const cycle = {}; cycle.self = cycle; assert.throws(() => cleanSaveData(cycle), /循环|circular/);
  assert.throws(() => cleanSaveData(parse('{"nested":{"__proto__":{"polluted":true}}}')), /不安全/);
});
await test('JSON and gzip decode incrementally without parsing one complete string', async () => {
  for (const compression of ['json', 'gzip']) {
    const encoded = await withoutWholeArchiveString(() => encodeTimelineSave(fixture, { compression }));
    JSON.parse = function(text, ...args) {
      if (text.length > 65536) throw new RangeError('Invalid string length: whole archive parsing');
      return parse(text, ...args);
    };
    try { assert.deepEqual(await decodeTimelineSaveFile(encoded.blob), fixture); }
    finally { JSON.parse = parse; }
  }
});
await test('encoding retains legacy escaping, ordering, scalars, dates and nested arrays', async () => {
  const value = { 10: 'ten', 2: 'two', nested: [undefined, NaN, -0, { b: true, text: '🌸\ud800x\udfff\n\t\\"' }], date: new Date('2026-10-10T00:00:00Z'), omitted: undefined };
  const encoded = await encodeTimelineSave(value, { compression: 'json' });
  assert.equal(await encoded.blob.text(), stringify(value));
  assert.deepEqual(await decodeTimelineSaveFile(encoded.blob), parse(stringify(value)));
  const splitSurrogate = { text: 'x'.repeat(256*1024-1) + '🌸' + 'y'.repeat(256*1024) };
  assert.equal(await (await encodeTimelineSave(splitSurrogate, { compression: 'json' })).blob.text(), stringify(splitSurrogate));
  assert.equal(await decodeTimelineSaveFile(new Blob(['\ufeff{"text":"忍者🌸"}'])).then(v => v.text), '忍者🌸');
  for (const value of [null, 42, false, '正文', [1, 2]]) assert.deepEqual(await decodeTimelineSaveFile(new Blob([stringify(value)])), value);
});
await test('malformed JSON, unsafe keys, credentials and changed signatures still reject', async () => {
  for (const text of ['', '01', '[1,]', '{"x":1,}', '{}{}', 'null false', '"unterminated', '{"x":', '[1', '"bad\u0001control"']) {
    await assert.rejects(decodeTimelineSaveFile(new Blob([text])), /JSON|解析/, text);
  }
  await assert.rejects(decodeTimelineSaveFile(new Blob([new Uint8Array([0x22,0xc3,0x28,0x22])])), /UTF|utf-8|编码|JSON|解析/);
  const polluted = await decodeTimelineSaveFile(new Blob(['{"__proto__":{"savePolluted":true}}'])).catch(error => error);
  if (!(polluted instanceof Error)) assert.throws(() => cleanSaveData(polluted), /不安全/);
  assert.equal({}.savePolluted, undefined);
  const withSecret = { nodes: [], config: { apiKey: 'secret' } };
  const signed = { schema: 'naruto.save-package/v1', kind: PERSONAL_SAVE_KIND, checksum: { algorithm: 'SHA-256', value: createHash('sha256').update(stringify(withSecret)).digest('hex') }, payload: withSecret };
  await assert.rejects(validateSavePackage(signed), /凭证/);
  const pack = await createSavePackage(PERSONAL_SAVE_KIND, { text: '原正文' }); pack.payload.text = '已损坏';
  await assert.rejects(validateSavePackage(pack), /完整性/);
});
await test('stream boundaries preserve escaped quotes, Unicode, numbers and duplicate-key semantics', async () => {
  const source = '\ufeff{"duplicate":1,"duplicate":2,"text":"\\ud800x\\udfff\\n🌸\\\\\\\"","array":[-0,1.25e+20,true,null,{"nested":"结束"}]}';
  const bytes = new TextEncoder().encode(source);
  const expected = parse(source.replace(/^\uFEFF/, ''));
  for (const size of [1, 2, 3, 7, 31]) {
    class ChunkedFile extends Blob {
      stream() {
        let offset = 0;
        return new ReadableStream({ pull(controller) {
          if (offset === bytes.length) { controller.close(); return; }
          controller.enqueue(bytes.slice(offset, offset + size)); offset = Math.min(bytes.length, offset + size);
        } });
      }
    }
    assert.deepEqual(await decodeTimelineSaveFile(new ChunkedFile([bytes])), expected);
  }
});
await test('multiplayer sidecar isolation scans JSON chunks without materializing the whole personal archive', async () => {
  for (const token of ['不存在的绑定', 'node-393', '\\n', '"},{"id"', '正文🌸']) {
    assert.equal(await withoutWholeArchiveString(() => saveJsonContainsText(fixture, [token])), stringify(fixture).includes(token));
  }
  const boundary = { text: 'x'.repeat(64*1024-3) + 'binding-token-crosses-chunks' };
  assert.equal(saveJsonContainsText(boundary, ['binding-token-crosses-chunks']), true);
});
console.log(`Save streaming regression: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
