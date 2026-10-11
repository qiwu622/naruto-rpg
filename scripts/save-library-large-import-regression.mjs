import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { chromium } from 'playwright';
import { encodeTimelineSave, decodeTimelineSaveFile } from '../js/core/timeline-file-codec.js';
import { assertTimelineSave } from '../js/core/timeline-save-schema.js';
import { PERSONAL_SAVE_KIND, SAVE_PACKAGE_SCHEMA } from '../js/core/save-library.js';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'naruto-large-import-'));
let browser, server, passed = 0;
const ok = message => { passed++; console.log(`PASS ${message}`); };

// Generate real playable data, not whitespace padding or an invalid payload.
// Fixtures are temporary files; no giant strings cross the browser RPC boundary.
async function createFixtures() {
  const data = makeContinuationFixture(134);
  const body = '木叶大档正文🌸\\\"\n' + 'x'.repeat(1024 * 1024);
  for (const node of data.nodes) node.clean_response = body + node.id;
  assertTimelineSave(data);
  const plain = path.join(temporary, 'legacy-large.json');
  const gzip = path.join(temporary, 'signed-large.json.gz');
  const checksum = createHash('sha256');
  let bytes = 0;
  const encoded = await encodeTimelineSave(data, { compression: 'json' });
  await pipeline(Readable.fromWeb(encoded.blob.stream()), new Transform({
    transform(chunk, _encoding, callback) { bytes += chunk.length; checksum.update(chunk); callback(null, chunk); }
  }), createWriteStream(plain));
  assert.ok(bytes > 200 * 1024 * 1024, 'exercise the actual former 200 MiB boundary');
  const prefix = JSON.stringify({ schema: SAVE_PACKAGE_SCHEMA, kind: PERSONAL_SAVE_KIND,
    label: '完整大档与 IF 线', saved_at: '2026-10-09T00:00:00Z',
    checksum: { algorithm: 'SHA-256', value: checksum.digest('hex') }
  }).slice(0, -1) + ',"payload":';
  async function* chunks() {
    yield prefix;
    yield* createReadStream(plain);
    yield '}';
  }
  await pipeline(Readable.from(chunks()), createGzip(), createWriteStream(gzip));
  return { plain, gzip, bytes, nodes: data.nodes.length, bodyLength: body.length };
}

try {
  const fixture = await createFixtures();
  console.log(`Fixture: ${(fixture.bytes / 1024 / 1024).toFixed(2)} MiB decompressed, ${fixture.nodes} nodes, 2 branches.`);
  server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/') return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><main></main>');
      const target = path.resolve(root, '.' + decodeURIComponent(pathname));
      if (!target.startsWith(root + path.sep) || !/\.(?:js|css|json|png|webp|svg)$/u.test(target)) throw new Error('unavailable');
      response.writeHead(200, { 'Content-Type': target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream' }).end(await readFile(target));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { openSaveLibrary } = await import('/js/ui/save-library-panel.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { localSaveLibrary, PERSONAL_SAVE_KIND } = await import('/js/core/save-library.js');
    const { personalSaveLibrary } = await import('/js/core/personal-save-library.js');
    const { authClient } = await import('/js/core/auth-client.js');
    authClient._user = null; authClient._checked = true;
    Object.assign(window, { timelineSystem, stateManager, localSaveLibrary, personalSaveLibrary, PERSONAL_SAVE_KIND });
    await timelineSystem.init();
    const state = stateManager.snapshot(); state['玩家·姓名'] = '导入前的旧档';
    await timelineSystem.createRootNode({ summary: '当前进度保持原样', stateSnapshot: state });
    window.original = await personalSaveLibrary.capture({ label: '已有旧档' });
    window.originalChecksum = (await localSaveLibrary.readPackage(original.id, PERSONAL_SAVE_KIND)).checksum.value;
    window.currentId = (await timelineSystem.getCurrentNode()).id;
    await openSaveLibrary();
  });
  const panel = page.locator('naruto-save-library');
  const ready = () => page.waitForFunction(() => {
    const element = document.querySelector('game-modal')?.shadowRoot.querySelector('naruto-save-library');
    return element && !element.busy;
  }, undefined, { timeout: 120000 });
  await ready();

  // This is the real file-input handler shared by website and bundled Android,
  // including package validation, timeline migration and IndexedDB writes.
  for (const [format, file] of [['signed gzip', fixture.gzip], ['legacy JSON', fixture.plain]]) {
    await panel.locator('#file').setInputFiles(file);
    await ready();
    assert.match(await panel.locator('#status').innerText(), /导入成功/, `${format} must import rather than show the old size error`);
    const result = await page.evaluate(async ({ bodyLength, nodes }) => {
      const entries = await localSaveLibrary.list(PERSONAL_SAVE_KIND);
      const imported = entries.find(entry => entry.reason === 'import');
      const pack = await localSaveLibrary.readPackage(imported.id, PERSONAL_SAVE_KIND);
      const data = pack.payload;
      return {
        count: entries.length, nodes: data.nodes.length, branches: data.branches.length,
        bodiesIntact: data.nodes.every(node => node.clean_response.length === bodyLength + node.id.length && node.clean_response.startsWith('木叶大档正文🌸\\\"\n') && node.clean_response.endsWith(node.id)),
        memories: data.nodes.at(-1).state_snapshot._memory.pins,
        ledgerCount: data.nodes.at(-1).state_snapshot._continuity.events.length,
        daily: data.nodes.every(node => node.shinobi_daily?.headline?.title),
        oldChecksum: (await localSaveLibrary.readPackage(original.id, PERSONAL_SAVE_KIND)).checksum.value === originalChecksum,
        currentUnchanged: (await timelineSystem.getCurrentNode()).id === currentId,
        declaredCount: imported.nodeCount === nodes
      };
    }, { bodyLength: fixture.bodyLength, nodes: fixture.nodes });
    // The two formats contain the same timeline. Existing checksum-based import
    // deduplication keeps one copy, alongside the untouched pre-existing save.
    assert.equal(result.count, 2);
    assert.equal(result.nodes, fixture.nodes); assert.equal(result.branches, 2);
    assert.ok(result.bodiesIntact && result.daily && result.oldChecksum && result.currentUnchanged && result.declaredCount, JSON.stringify(result));
    assert.match(result.memories, /最初的约定/); assert.equal(result.ledgerCount, 134);
    ok(`${format} larger than 200 MiB imports and reopens with all body/daily/memory/IF data; current game and old archive unchanged`);
  }

  const protection = await page.evaluate(async () => {
    const { encodeTimelineSave, decodeTimelineSaveFile } = await import('/js/core/timeline-file-codec.js');
    const before = (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length;
    const pack = await localSaveLibrary.readPackage(original.id, PERSONAL_SAVE_KIND);
    pack.payload.nodes[0].summary += '被修改';
    let checksum = '', brokenGzip = '';
    try { await personalSaveLibrary.importData(await decodeTimelineSaveFile((await encodeTimelineSave(pack)).blob)); } catch (error) { checksum = error.message; }
    try { await decodeTimelineSaveFile(new Blob([new Uint8Array([0x1f, 0x8b, 0x08, 0xff])])); } catch (error) { brokenGzip = error.message; }
    return { checksum, brokenGzip, unchanged: before === (await localSaveLibrary.list(PERSONAL_SAVE_KIND)).length && (await timelineSystem.getCurrentNode()).id === currentId };
  });
  assert.match(protection.checksum, /完整性/); assert.match(protection.brokenGzip, /损坏|解压/); assert.ok(protection.unchanged);
  assert.deepEqual(errors, []);
  ok('corrupt packages and gzip still fail without modifying existing saves');

  await assert.rejects(decodeTimelineSaveFile(new Blob([await readFile(fixture.gzip)]), { maxDecompressedBytes: 200 * 1024 * 1024 }), /超过 200 MiB/);
  ok('callers that explicitly request a bounded decoder still stop at their configured limit');
  console.log(`Large save import regression: ${passed} groups passed; disposable IndexedDB and files, no model calls.`);
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temporary, { recursive: true, force: true });
}
