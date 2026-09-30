import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { startCloudSaveTestServer } from './helpers/cloud-save-test-server.mjs';

const testServer = await startCloudSaveTestServer();
const { url, db, tokens } = testServer;
let passed = 0;
const ok = label => { passed++; console.log(`PASS ${label}`); };
const call = (suffix = '', { user = 'cloud-test-a', ...options } = {}) => fetch(`${url}/api/saves${suffix}`, { ...options, headers: { ...(user ? { Authorization: `Bearer ${tokens[user]}` } : {}), ...options.headers } });
const patch = (id, data, user) => call(`/${id}/metadata`, { user, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const timeline = marker => ({ nodes: [{ id: 'root', parent_id: null, children_ids: [], branch_id: 'main', state_snapshot: { _version: '5.0', marker } }], branches: [{ id: 'main', head_node_id: 'root', diverged_from: null }], meta: { root_id: 'root', current_id: 'root', active_branch: 'main' } });
async function upload(name, marker, user = 'cloud-test-a') {
  const form = new FormData();
  form.append('metadata', JSON.stringify({ slot_name: name, preview_data: { name: '起物', turn: 2 } }));
  form.append('save', new Blob([gzipSync(Buffer.from(JSON.stringify(timeline(marker))))], { type: 'application/gzip' }), 'save.json.gz');
  return call('', { method: 'POST', body: form, user });
}
try {
  assert.equal((await call('/storage', { user: null })).status, 401);
  assert.equal((await patch('not-found', { slot_name: '改名' }, null)).status, 401);
  assert.equal((await call('/capabilities')).status, 200);
  assert.equal((await (await call('/capabilities')).json()).limits.max_slots, 3);
  assert.deepEqual(await (await call('/storage')).json(), { used_slots: 0, max_slots: 3, remaining_slots: 3, used_uncompressed_bytes: 0, used_compressed_bytes: 0, max_save_bytes: 200 * 1024 * 1024, max_upload_bytes: 64 * 1024 * 1024 });
  ok('new management endpoints require a real account; capabilities/storage expose accurate slot and file limits');

  const created = await upload('原存档', 'old'); assert.equal(created.status, 201);
  const { id } = await created.json();
  const old = await db.getSaveContentById(id);
  const oldBlob = await readFile(old.file_path);
  const renamed = await patch(id, { slot_name: '  木叶 IF "<img>"  ' }); assert.equal(renamed.status, 200);
  const updated = await db.getSaveContentById(id);
  assert.equal(updated.slot_name, '木叶 IF "<img>"');
  for (const field of ['revision', 'blob_name', 'size_bytes', 'compressed_size_bytes', 'content_sha256', 'preview_data']) assert.deepEqual(updated[field], old[field], field);
  assert.equal(createHash('sha256').update(await readFile(updated.file_path)).digest('hex'), createHash('sha256').update(oldBlob).digest('hex'));
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await (await call(`/${id}/content`)).arrayBuffer()))), timeline('old'));
  ok('metadata-only rename trims names without rewriting the blob, revision, preview, IF graph or compressed content');

  for (const invalid of [{}, { slot_name: ' ' }, { slot_name: '长'.repeat(51) }, { slot_name: '新名', user_id: 'cloud-test-b' }, { slot_name: '新名', save_data: timeline('poison') }, []]) assert.equal((await patch(id, invalid)).status, 400);
  assert.equal((await call(`/${id}/metadata`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: 'name' })).status, 415);
  assert.equal((await patch('missing', { slot_name: '不存在' })).status, 404);
  assert.equal((await patch('bad.id', { slot_name: '错误' })).status, 400);
  assert.equal((await db.getSaveMetaById(id)).slot_name, updated.slot_name);
  ok('rename rejects oversized/blank names, content and ownership injection, bad media types and missing IDs');

  assert.equal((await patch(id, { slot_name: '越权' }, 'cloud-test-b')).status, 403);
  assert.equal((await call(`/${id}/content`, { user: 'cloud-test-b' })).status, 403);
  assert.equal((await call(`/${id}`, { user: 'cloud-test-b', method: 'DELETE' })).status, 403);
  assert.deepEqual(await (await call('', { user: 'cloud-test-b' })).json(), []);
  assert.equal((await (await call('/storage', { user: 'cloud-test-b' })).json()).used_slots, 0);
  await db.banUser('cloud-test-b', 'test');
  assert.equal((await call('/storage', { user: 'cloud-test-b' })).status, 403);
  await db.unbanUser('cloud-test-b');
  ok('accounts cannot list/read/rename/delete each other’s saves, and banned accounts lose access immediately');

  for (const name of ['并存旧档', '另一条线']) assert.equal((await upload(name, name)).status, 201);
  const full = await call('/storage'); assert.equal(full.headers.get('cache-control'), 'private, no-store');
  const quota = await full.json(); const saves = await (await call()).json();
  assert.equal(quota.used_slots, 3); assert.equal(quota.remaining_slots, 0);
  assert.equal(quota.used_uncompressed_bytes, saves.reduce((sum, save) => sum + save.size_bytes, 0));
  assert.equal(quota.used_compressed_bytes, saves.reduce((sum, save) => sum + save.compressed_size_bytes, 0));
  const overflow = await upload('超额', 'overflow'); assert.equal(overflow.status, 400); assert.equal((await overflow.json()).code, 'SAVE_SLOT_LIMIT_REACHED');
  assert.equal((await patch(id, { slot_name: '满槽时仍可改名' })).status, 200);
  assert.equal((await call(`/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await call('/storage')).json()).used_slots, 2);
  assert.equal((await upload('新档', 'new')).status, 201);
  ok('multiple old/new archives coexist; quota counts their total bytes, enforces slots and frees space on delete');
  console.log(`Cloud management regression: ${passed} groups passed`);
} finally { await testServer.close(); }
