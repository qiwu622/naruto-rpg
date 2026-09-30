import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CloudSaveClient, CloudSaveError } from '../js/core/cloud-save.js';
import { decodeTimelineSaveFile } from '../js/core/timeline-file-codec.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
}

async function withFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const save = {
  export_version: '2.0',
  nodes: [{ id: 'node_root', children_ids: [], branch_id: 'branch_main' }],
  branches: [{ id: 'branch_main', head_node_id: 'node_root' }],
  meta: { root_id: 'node_root', current_id: 'node_root', active_branch: 'branch_main' }
};

const capabilities = {
  preferred_upload_protocol: 'gzip-multipart-v1',
  upload_protocols: ['gzip-multipart-v1', 'legacy-json-v1'],
  limits: {
    max_uncompressed_bytes: 200 * 1024 * 1024,
    max_compressed_bytes: 64 * 1024 * 1024,
    max_legacy_json_bytes: 16 * 1024 * 1024
  }
};

await test('modern uploads probe capabilities and send gzip multipart without a manual content type', async () => {
  let uploadOptions;
  await withFetch(async (url, options = {}) => {
    if (url === '/api/saves/capabilities') return jsonResponse(capabilities);
    assert.equal(url, '/api/saves');
    uploadOptions = options;
    return jsonResponse({ id: 'save-modern' }, { status: 201 });
  }, async () => {
    const client = new CloudSaveClient();
    const result = await client.uploadSave('默认云存档', save, { name: '鸣人' });
    assert.equal(result.id, 'save-modern');
  });

  assert.equal(uploadOptions.method, 'POST');
  assert.equal(uploadOptions.headers, undefined);
  assert.ok(uploadOptions.body instanceof FormData);
  assert.deepEqual(JSON.parse(uploadOptions.body.get('metadata')), {
    slot_name: '默认云存档',
    preview_data: { name: '鸣人' }
  });
  const gzip = uploadOptions.body.get('save');
  assert.equal(gzip.type, 'application/gzip');
  assert.deepEqual(await decodeTimelineSaveFile(gzip), save);
});

await test('cloud content download stays compressed and can enter the shared import decoder', async () => {
  const encoded = await (await import('../js/core/timeline-file-codec.js'))
    .encodeTimelineSave(save, { compression: 'gzip' });
  await withFetch(async url => {
    if (url === '/api/saves/capabilities') return jsonResponse(capabilities);
    assert.equal(url, '/api/saves/save-modern/content');
    return new Response(encoded.blob, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(encoded.blob.size)
      }
    });
  }, async () => {
    const file = await new CloudSaveClient().downloadSave('save-modern');
    assert.equal(file.type, 'application/gzip');
    assert.deepEqual(await decodeTimelineSaveFile(file), save);
  });
});

await test('download does not reuse the compressed upload limit for existing large gzip saves', async () => {
  const client = new CloudSaveClient();
  const encoded = await (await import('../js/core/timeline-file-codec.js'))
    .encodeTimelineSave(save, { compression: 'gzip' });
  Object.defineProperty(encoded.blob, 'size', { value: 181 * 1024 * 1024 });
  client.getCapabilities = async () => ({
    protocol: 'gzip-multipart-v1',
    max_uncompressed_bytes: 200 * 1024 * 1024,
    max_compressed_bytes: 64 * 1024 * 1024,
    legacy_json_max_bytes: 16 * 1024 * 1024
  });
  client._fetch = async () => ({
    headers: new Headers({ 'Content-Length': String(181 * 1024 * 1024) }),
    blob: async () => encoded.blob
  });
  const downloaded = await client.downloadSave('large-existing-save');
  assert.equal(downloaded.type, 'application/gzip');
  assert.deepEqual(await decodeTimelineSaveFile(downloaded), save);
});

await test('legacy JSON fallback is size-limited and never used for an oversized save', async () => {
  let requestBody = '';
  await withFetch(async (url, options = {}) => {
    if (url === '/api/saves/capabilities') return jsonResponse({
      protocol: null,
      legacy_json_max_bytes: 1024 * 1024
    });
    requestBody = options.body;
    return jsonResponse({ id: 'save-legacy' }, { status: 201 });
  }, async () => {
    await new CloudSaveClient().uploadSave('兼容槽', save, null);
  });
  assert.deepEqual(JSON.parse(requestBody).save_data, save);

  await withFetch(async url => {
    if (url === '/api/saves/capabilities') return jsonResponse({
      protocol: null,
      legacy_json_max_bytes: 32
    });
    throw new Error('oversized legacy save must fail before upload');
  }, async () => {
    await assert.rejects(
      () => new CloudSaveClient().uploadSave('兼容槽', save, null),
      error => error instanceof CloudSaveError && error.code === 'GZIP_UPLOAD_REQUIRED'
    );
  });
});

await test('server error code and bounded Retry-After reach the caller', async () => {
  await withFetch(async url => {
    if (url === '/api/saves/capabilities') return jsonResponse(capabilities);
    return jsonResponse(
      { error: '云存档服务繁忙', code: 'SAVE_OVERLOADED' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }, async () => {
    await assert.rejects(
      () => new CloudSaveClient().uploadSave('默认云存档', save, null),
      error => error instanceof CloudSaveError
        && error.status === 503
        && error.code === 'SAVE_OVERLOADED'
        && error.retryAfterMs === 5000
        && /5 秒/.test(error.message)
    );
  });
});

await test('quick saves are single-flight and coalesce dirty work into the newest snapshot', async () => {
  const client = new CloudSaveClient();
  const savedVersions = [];
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  client._performQuickSave = async (_slotName, saveData) => {
    active++;
    maxActive = Math.max(maxActive, active);
    savedVersions.push(saveData.version);
    if (saveData.version === 1) {
      markFirstStarted();
      await firstGate;
    }
    active--;
    return { savedVersion: saveData.version };
  };

  let secondFactoryCalls = 0;
  const first = client.scheduleQuickSave('默认云存档', () => ({ saveData: { version: 1 } }));
  await firstStarted;
  const second = client.scheduleQuickSave('默认云存档', () => {
    secondFactoryCalls++;
    return { saveData: { version: 2 } };
  });
  const third = client.scheduleQuickSave('默认云存档', () => ({ saveData: { version: 3 } }));
  releaseFirst();

  const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
  assert.deepEqual(savedVersions, [1, 3]);
  assert.equal(maxActive, 1);
  assert.equal(secondFactoryCalls, 0);
  assert.equal(firstResult.savedVersion, 1);
  assert.equal(secondResult.savedVersion, 3);
  assert.equal(thirdResult.savedVersion, 3);
});

await test('a save queued from a completed caller cannot be stranded during runner teardown', async () => {
  const client = new CloudSaveClient();
  const savedVersions = [];
  client._performQuickSave = async (_slotName, saveData) => {
    savedVersions.push(saveData.version);
    return { savedVersion: saveData.version };
  };
  const chained = client
    .scheduleQuickSave('默认云存档', () => ({ saveData: { version: 1 } }))
    .then(() => client.scheduleQuickSave('默认云存档', () => ({ saveData: { version: 2 } })));
  const result = await Promise.race([
    chained,
    new Promise((_, reject) => setTimeout(() => reject(new Error('runner teardown stranded a save')), 1000))
  ]);
  assert.deepEqual(savedVersions, [1, 2]);
  assert.equal(result.savedVersion, 2);
});

await test('a snapshot factory that queues another save cannot create two runners', async () => {
  const client = new CloudSaveClient();
  let active = 0;
  let maxActive = 0;
  let nested;
  client._performQuickSave = async (_slotName, saveData) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 0));
    active--;
    return { savedVersion: saveData.version };
  };
  const first = client.scheduleQuickSave('默认云存档', () => {
    nested = client.scheduleQuickSave('默认云存档', () => ({ saveData: { version: 2 } }));
    return { saveData: { version: 1 } };
  });
  const [firstResult, nestedResult] = await Promise.all([first, nested]);
  assert.equal(maxActive, 1);
  assert.equal(firstResult.savedVersion, 1);
  assert.equal(nestedResult.savedVersion, 2);
});

await test('app automatic cloud-save triggers share the scheduler and profile management uses the archive library', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(source, /cloudSave\.scheduleQuickSave\('默认云存档'/);
  assert.doesNotMatch(source, /cloudSave\.quickSave\(/);
  assert.match(source, /eventBus\.request\('app:open-saves', \{ cloud: true \}\)/);
  assert.doesNotMatch(source, /JSON\.stringify\(fullSave\.save_data\)/);
});

await test('metadata-only rename and storage remain compatible with older servers', async () => {
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/metadata') || url === '/api/saves/storage') return jsonResponse({}, { status: 404 });
    return jsonResponse({ id: 'old-slot' });
  }, async () => {
    const client = new CloudSaveClient();
    assert.equal(await client.getStorage(), null);
    assert.equal((await client.renameSave('old-slot', '旧服务器改名')).id, 'old-slot');
  });
  assert.equal(calls.at(-1).options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { slot_name: '旧服务器改名' });
  assert.equal(calls.some(call => call.options.body instanceof FormData), false);
});

console.log(`\n${passed} cloud save regression tests passed.`);
