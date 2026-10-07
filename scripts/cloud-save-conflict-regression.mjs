import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { startCloudSaveTestServer } from './helpers/cloud-save-test-server.mjs';

const server = await startCloudSaveTestServer();
const cookie = `naruto_token=${server.tokens['cloud-test-a']}`;
const data = marker => ({ nodes: [{ id: 'root', parent_id: null, children_ids: [], branch_id: 'main', state_snapshot: { _version: '5.0', marker } }], branches: [{ id: 'main', head_node_id: 'root' }], meta: { root_id: 'root', current_id: 'root', active_branch: 'main' } });
const request = (url, options = {}) => fetch(`${server.url}${url}`, { ...options, headers: { Cookie: cookie, ...options.headers } });
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const multipart = (marker, revision) => { const form = new FormData(); form.append('metadata', JSON.stringify({ slot_name: '并发测试', expected_revision: revision })); form.append('save', new Blob([gzipSync(JSON.stringify(data(marker)))], { type: 'application/gzip' }), 'save.gz'); return { method: 'PUT', body: form }; };
let passed = 0;
const ok = name => { passed++; console.log(`PASS ${name}`); };
const emptyStaging = async () => { assert.deepEqual(await fs.readdir(path.join(server.dataDir, 'save-staging')).catch(() => []), []); assert.equal((await fs.readdir(path.join(server.dataDir, 'saves'))).some(name => name.endsWith('.tmp')), false); };

try {
  const created = await request('/api/saves', json('POST', { slot_name: '并发测试', save_data: data('original') }));
  assert.equal(created.status, 201); const initial = await created.json(); assert.equal(initial.revision, 1);
  const url = `/api/saves/${initial.id}`;
  const concurrent = await Promise.all([request(url, multipart('a', 1)), request(url, multipart('b', 1))]);
  assert.equal(concurrent.filter(result => result.status === 200).length, 1);
  const losing = concurrent.find(result => result.status !== 200);
  assert.ok([409, 429].includes(losing.status));
  const retry = await request(url, multipart('loser-retry', 1));
  assert.equal(retry.status, 409); const conflict = await retry.json();
  assert.equal(conflict.code, 'SAVE_REVISION_CONFLICT'); assert.deepEqual(conflict.details, { id: initial.id, expected_revision: 1, actual_revision: 2 });
  assert.equal((await server.db.getSaveMetaById(initial.id)).revision, 2); await emptyStaging();
  ok('real concurrent HTTP uploads allow one success; retry after admission contention yields explicit version conflict without leftover files');

  // Bypass only HTTP resource admission to test the repository atomic compare
  // with two writes entering its transaction queue at exactly the same revision.
  const writes = ['repo-a', 'repo-b'].map(marker => server.db.updateSave(initial.id, { expected_revision: 2, save_data: gzipSync(JSON.stringify(data(marker))), size_bytes: Buffer.byteLength(JSON.stringify(data(marker))) }));
  const outcomes = await Promise.allSettled(writes);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'SAVE_REVISION_CONFLICT');
  assert.equal((await server.db.getSaveMetaById(initial.id)).revision, 3); await emptyStaging();
  ok('atomic repository compare rejects exactly one of two admitted writes using the same revision');

  const before = await server.db.getSaveMetaById(initial.id);
  const filesBefore = (await fs.readdir(path.join(server.dataDir, 'saves'))).sort();
  const originalWrite = fs.writeFile;
  fs.writeFile = async (file, ...args) => {
    if (String(file).includes('saves_index.json') && String(file).endsWith('.tmp')) throw new Error('injected index disk-full failure');
    return originalWrite(file, ...args);
  };
  let failed;
  try { failed = await request(url, multipart('must-not-commit', 3)); } finally { fs.writeFile = originalWrite; }
  assert.equal(failed.status, 500); assert.deepEqual(await server.db.getSaveMetaById(initial.id), before);
  assert.deepEqual((await fs.readdir(path.join(server.dataDir, 'saves'))).sort(), filesBefore); await emptyStaging();
  const recovered = await request(url, multipart('recovered', 3)); assert.equal(recovered.status, 200); assert.equal((await recovered.json()).revision, 4);
  ok('failed index commit preserves original content/revision, removes promoted and temporary files, and a later retry succeeds');

  const invalid = await request(url, json('PUT', { expected_revision: -1, save_data: data('bad') })); assert.equal(invalid.status, 400);
  const staleJson = await request(url, json('PUT', { expected_revision: 3, save_data: data('stale') })); assert.equal(staleJson.status, 409);
  const changedUser = await request(url, { ...multipart('wrong-account', 4), headers: { 'X-Cloud-User-Id': 'cloud-test-b' } }); assert.equal(changedUser.status, 409); assert.equal((await changedUser.json()).code, 'CLOUD_ACCOUNT_CHANGED');
  assert.equal((await server.db.getSaveMetaById(initial.id)).revision, 4); await emptyStaging();
  ok('legacy JSON also compares revisions and account-change guards reject uploads before mutation');

  const indexPath = path.join(server.dataDir, 'saves_index.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8')); delete index[initial.id].revision; await fs.writeFile(indexPath, JSON.stringify(index));
  const listed = await (await request('/api/saves')).json(); assert.equal(listed[0].revision, 0);
  assert.equal((await request(`${url}/content`)).headers.get('X-Save-Revision'), '0');
  const oldUpdate = await request(url, json('PUT', { expected_revision: 0, save_data: data('old-format') })); assert.equal(oldUpdate.status, 200); assert.equal((await oldUpdate.json()).revision, 1);
  const legacy = await request(url, json('PUT', { save_data: data('old-client') })); assert.equal(legacy.status, 200); assert.equal((await legacy.json()).revision, 2);
  ok('existing records without a revision expose baseline zero and legacy callers remain compatible');
  console.log(`Cloud save conflict regression: ${passed} groups passed`);
} finally { await server.close(); }
