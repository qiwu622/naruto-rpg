import assert from 'node:assert/strict';
import { CloudSaveClient, CloudSaveError } from '../js/core/cloud-save.js';

const scope = { userId: 'user-a', saveKey: 'game-a' };
const timeline = marker => ({ export_version: '2.0', nodes: [{ id: 'root', branch_id: 'main', children_ids: [], marker }], branches: [{ id: 'main', head_node_id: 'root' }], meta: { root_id: 'root', current_id: 'root', active_branch: 'main' } });
let passed = 0;
const test = async (name, fn) => { await fn(); console.log(`PASS ${name}`); passed++; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value) }; };

await test('failed sync keeps its captured snapshot and exposes retry and success states', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope);
  const states = []; const unsubscribe = client.subscribeSync(state => states.push(state.status));
  let attempts = 0, factories = 0;
  client._performQuickSave = async (_name, save) => {
    assert.equal(save.nodes[0].marker, 'captured');
    if (++attempts === 1) throw new CloudSaveError('offline', { code: 'NETWORK_ERROR' });
    return { id: 'cloud-a', revision: 1 };
  };
  await assert.rejects(client.scheduleQuickSave('默认云存档', () => { factories++; return { saveData: timeline('captured') }; }, scope));
  assert.equal(client.getSyncState().status, 'retry'); assert.equal(client.getSyncState().canRetry, true);
  await client.retrySync(); assert.equal(factories, 1);
  assert.equal(client.getSyncState().status, 'synced');
  assert.ok(states.includes('uploading') && states.includes('retry') && states.includes('synced')); unsubscribe();
});

await test('retry and conflict-copy completion cannot mark newer unscheduled local progress as synced', async () => {
  for (const conflict of [false, true]) {
    const client = new CloudSaveClient(); client.setSyncContext(scope); client.markLocalSaved(scope);
    let attempts = 0;
    client._performQuickSave = async () => {
      if (++attempts === 1) throw new CloudSaveError('pending', { code: conflict ? 'SAVE_REVISION_CONFLICT' : 'NETWORK_ERROR' });
      return { id: 'old-snapshot', revision: 1 };
    };
    client._saveRequest = async () => ({ id: 'conflict-copy', revision: 1 });
    await assert.rejects(client.scheduleQuickSave('默认云存档', () => ({ saveData: timeline('old') })));
    // Auto-sync has been disabled; a later locally committed turn is not queued.
    client.markLocalSaved(scope);
    if (conflict) await client.keepBothCopies(); else await client.retrySync();
    assert.equal(client.getSyncState().status, 'local');
    assert.equal(client.getSyncState().dirty, true);
    assert.match(client.getSyncState().message, /新进度.*尚未同步/);
    assert.equal(client.getSyncState().canRetry, false); assert.equal(client.getSyncState().canKeepBoth, false);
  }
});

await test('an upload finishing after local progress stays dirty until the latest snapshot succeeds', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope); client.markLocalSaved(scope);
  const started = deferred(), gate = deferred();
  client._performQuickSave = async (_name, save) => {
    if (save.nodes[0].marker === 'old') { started.resolve(); await gate.promise; }
    return { id: 'cloud-a', revision: 1 };
  };
  const old = client.scheduleQuickSave('默认云存档', () => ({ saveData: timeline('old') }));
  await started.promise; client.markLocalSaved(scope); gate.resolve(); await old;
  assert.equal(client.getSyncState().status, 'local'); assert.equal(client.getSyncState().dirty, true);
  await client.scheduleQuickSave('默认云存档', () => ({ saveData: timeline('latest') }));
  assert.equal(client.getSyncState().status, 'synced'); assert.equal(client.getSyncState().dirty, false);
});

await test('queued factories cannot read a newly selected game and waiters never cross scopes', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope);
  const gate = deferred(), started = deferred(); const uploaded = [];
  client._performQuickSave = async (_name, save) => { uploaded.push(save.marker); if (save.marker === 'first') { started.resolve(); await gate.promise; } return save.marker; };
  const first = client.scheduleQuickSave('默认云存档', () => ({ saveData: { marker: 'first' } }), scope);
  const rejectedFirst = assert.rejects(first, error => error.code === 'CLOUD_CONTEXT_CHANGED');
  await started.promise;
  let oldFactoryCalls = 0;
  const old = client.scheduleQuickSave('默认云存档', () => { oldFactoryCalls++; return { saveData: { marker: 'wrong' } }; }, scope);
  const rejectedOld = assert.rejects(old, error => error.code === 'CLOUD_CONTEXT_CHANGED');
  client.setSyncContext({ ...scope, saveKey: 'game-b' });
  const next = client.scheduleQuickSave('默认云存档', () => ({ saveData: { marker: 'next' } }));
  gate.resolve();
  await rejectedFirst; await rejectedOld; assert.equal(await next, 'next');
  assert.equal(oldFactoryCalls, 0); assert.deepEqual(uploaded, ['first', 'next']);
  assert.equal(client.getSyncState().status, 'synced');
});

await test('A to B to A permanently cancels queued factories and old waiter generations', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope);
  const gate = deferred(), started = deferred(); const uploaded = [];
  client._performQuickSave = async (_name, save) => {
    uploaded.push(save.marker);
    if (save.marker === 'first') { started.resolve(); await gate.promise; }
    return save.marker;
  };
  const first = client.scheduleQuickSave('默认云存档', () => ({ saveData: { marker: 'first' } }));
  const rejectedFirst = assert.rejects(first, error => error.code === 'CLOUD_CONTEXT_CHANGED');
  await started.promise;
  let oldFactoryCalls = 0;
  const old = client.scheduleQuickSave('默认云存档', () => { oldFactoryCalls++; return { saveData: { marker: 'old' } }; });
  const rejectedOld = assert.rejects(old, error => error.code === 'CLOUD_CONTEXT_CHANGED');
  client.setSyncContext({ ...scope, saveKey: 'game-b' });
  client.setSyncContext(scope);
  const fresh = client.scheduleQuickSave('默认云存档', () => ({ saveData: { marker: 'fresh' } }));
  gate.resolve();
  await rejectedFirst; await rejectedOld; assert.equal(await fresh, 'fresh');
  assert.equal(oldFactoryCalls, 0); assert.deepEqual(uploaded, ['first', 'fresh']);
  assert.equal(client.getSyncState().status, 'synced');
});

await test('scope changes during compression stay cancelled after returning to the same root', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope);
  const gate = deferred(), started = deferred(); let uploads = 0;
  client.getCapabilities = async () => ({});
  client._buildLegacyJsonBody = async () => { started.resolve(); await gate.promise; return '{}'; };
  client._request = async () => { uploads++; return { id: 'remote-old', revision: 2 }; };
  const operation = client.uploadSave('save', timeline('old'));
  const rejected = assert.rejects(operation, error => error.code === 'CLOUD_CONTEXT_CHANGED');
  await started.promise;
  client.setSyncContext({ ...scope, saveKey: 'game-b' }); client.setSyncContext(scope);
  gate.resolve(); await rejected;
  assert.equal(uploads, 0); assert.equal(client.getSyncState().status, 'local');
  await assert.rejects(client.retrySync(), error => error.code === 'NO_PENDING_SYNC');
});

await test('same-root binding resets cancel a pending snapshot factory', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope);
  const gate = deferred(), started = deferred(); let uploads = 0;
  client._performQuickSave = async () => { uploads++; return { id: 'wrong', revision: 1 }; };
  const operation = client.scheduleQuickSave('默认云存档', async () => {
    started.resolve(); await gate.promise; return { saveData: timeline('pre-import') };
  });
  const rejected = assert.rejects(operation, error => error.code === 'CLOUD_CONTEXT_CHANGED');
  await started.promise;
  client.bindSyncSave({ ...scope, saveId: 'imported', revision: 7 });
  gate.resolve(); await rejected; await client._syncRunner;
  assert.equal(uploads, 0); assert.equal(client._readBinding(scope).id, 'imported');
  assert.equal(client.getSyncState().status, 'local');
});

await test('same-root import after a dispatched upload cannot restore its old binding or revision', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope);
  client.bindSyncSave({ ...scope, saveId: 'remote-a', revision: 1 });
  const gate = deferred(), started = deferred();
  client.getCapabilities = async () => ({});
  client._buildLegacyJsonBody = async () => '{}';
  client._request = async () => { started.resolve(); await gate.promise; return { id: 'remote-a', revision: 2 }; };
  const operation = client.scheduleQuickSave('默认云存档', () => ({ saveData: timeline('old') }));
  const rejected = assert.rejects(operation, error => error.code === 'CLOUD_CONTEXT_CHANGED');
  await started.promise;
  client.bindSyncSave({ ...scope, saveId: 'remote-a', revision: 8 });
  gate.resolve(); await rejected; await client._syncRunner;
  assert.equal(client.getSaveRevision('remote-a'), 8);
  assert.equal(client._readBinding(scope).revision, 8);
  assert.equal(client.getSyncState().status, 'local');
});

await test('manual save updates survive game switching but cannot survive an account round trip', async () => {
  for (const changeAccount of [false, true]) {
    const client = new CloudSaveClient(); client.setSyncContext(scope);
    const gate = deferred(), started = deferred(); let writes = 0;
    client.listSaves = async () => { started.resolve(); await gate.promise; return [{ id: 'manual', revision: 4 }]; };
    client.getCapabilities = async () => ({});
    client._buildLegacyJsonBody = async () => '{}';
    client._request = async () => { writes++; return { id: 'manual', revision: 5 }; };
    const operation = client.updateSave('manual', 'manual', timeline('manual'), null, { ...scope, saveKey: 'cloud:manual', enforceCurrent: false });
    const rejected = changeAccount ? assert.rejects(operation, error => error.code === 'CLOUD_ACCOUNT_CHANGED') : null;
    await started.promise;
    client.setSyncContext({ userId: changeAccount ? 'user-b' : scope.userId, saveKey: 'game-b' });
    client.setSyncContext(scope);
    gate.resolve();
    if (rejected) await rejected;
    else assert.equal((await operation).revision, 5);
    assert.equal(writes, changeAccount ? 0 : 1);
  }
});

await test('repeated same context does not cancel a legitimate upload', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope);
  client.getCapabilities = async () => ({});
  client._buildLegacyJsonBody = async () => { client.setSyncContext(scope); return '{}'; };
  client._request = async () => ({ id: 'remote-a', revision: 1 });
  const result = await client.uploadSave('save', timeline('a'));
  assert.equal(result.id, 'remote-a'); assert.equal(client.getSyncState().status, 'synced');
});

await test('cancelled in-flight work cannot clear the status of a new operation on the same root', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope);
  const oldGate = deferred(), oldStarted = deferred(), freshGate = deferred(), freshStarted = deferred();
  client.getCapabilities = async () => ({});
  client._buildLegacyJsonBody = async (_name, save) => save.nodes[0].marker;
  client._request = async (_url, options) => {
    if (options.body === 'old') { oldStarted.resolve(); await oldGate.promise; }
    else { freshStarted.resolve(); await freshGate.promise; }
    return { id: options.body, revision: 1 };
  };
  const old = client.uploadSave('save', timeline('old'));
  const rejected = assert.rejects(old, error => error.code === 'CLOUD_CONTEXT_CHANGED');
  await oldStarted.promise;
  client.setSyncContext({ ...scope, saveKey: 'game-b' }); client.setSyncContext(scope);
  const fresh = client.uploadSave('save', timeline('fresh'));
  await freshStarted.promise;
  client.setSyncContext(scope);
  assert.equal(client.getSyncState().status, 'uploading');
  freshGate.resolve(); await fresh;
  oldGate.resolve(); await rejected;
  assert.equal(client.getSyncState().status, 'synced');
  assert.equal(client.getSyncState().cloudSaveId, 'fresh');
});

await test('explicit rebinding discards both failed retries and conflict snapshots', async () => {
  for (const code of ['NETWORK_ERROR', 'SAVE_REVISION_CONFLICT']) {
    const client = new CloudSaveClient(); client.setSyncContext(scope);
    client._performQuickSave = async () => { throw new CloudSaveError('failed', { code }); };
    await assert.rejects(client.scheduleQuickSave('默认云存档', () => ({ saveData: timeline('old') })));
    assert.equal(client.getSyncState().status, code === 'NETWORK_ERROR' ? 'retry' : 'conflict');
    client.bindSyncSave({ ...scope, saveId: 'imported', revision: 3 });
    assert.equal(client.getSyncState().status, 'local');
    await assert.rejects(client.retrySync(), error => error.code === 'NO_PENDING_SYNC');
    await assert.rejects(client.keepBothCopies(), error => error.code === 'NO_SAVE_CONFLICT');
  }
});

await test('account changes after compression stop upload and other accounts cannot retry its snapshot', async () => {
  let user = { id: scope.userId };
  const client = new CloudSaveClient({ auth: { checkAuth: async () => user } }); client.setSyncContext(scope);
  client.getCapabilities = async () => ({ protocol: 'gzip-multipart-v1', max_compressed_bytes: 1e7 });
  const original = client._buildMultipart.bind(client);
  client._buildMultipart = async (...args) => { const body = await original(...args); user = { id: 'user-b' }; return body; };
  client._request = async () => { throw new Error('must not issue upload'); };
  await assert.rejects(client.uploadSave('save', timeline('a')), error => error.code === 'CLOUD_ACCOUNT_CHANGED');
  assert.equal(client.getSyncState().canRetry, false);
  client.setSyncContext({ userId: 'user-b', saveKey: 'game-a' });
  await assert.rejects(client.retrySync(), error => error.code === 'NO_PENDING_SYNC');
  assert.equal(client.getSyncState().status, 'local');
});

await test('persisted baseline survives reload and list refresh; keep both creates and binds a new cloud copy', async () => {
  const persistence = storage();
  const first = new CloudSaveClient({ storage: persistence }); first.setSyncContext(scope);
  first.bindSyncSave({ ...scope, saveId: 'remote-a', revision: 1, slotName: '默认云存档' });
  const client = new CloudSaveClient({ storage: persistence }); client.setSyncContext(scope);
  client.getCapabilities = async () => ({ protocol: 'gzip-multipart-v1', max_compressed_bytes: 1e7 });
  const calls = [];
  client._request = async (url, options = {}) => {
    if (!options.method) return [{ id: 'remote-a', revision: 2, slot_name: '默认云存档', preview_data: { sync_save_key: scope.saveKey } }];
    const metadata = JSON.parse(options.body.get('metadata')); calls.push({ url, ...metadata });
    if (url === '/api/saves/remote-a') {
      assert.equal(metadata.expected_revision, 1);
      throw new CloudSaveError('remote newer', { status: 409, code: 'SAVE_REVISION_CONFLICT' });
    }
    return { id: 'remote-copy', revision: calls.length === 2 ? 1 : 2 };
  };
  await client.listSaves();
  await assert.rejects(client.scheduleQuickSave('默认云存档', () => ({ saveData: timeline('local') }), scope), error => error.code === 'SAVE_REVISION_CONFLICT');
  assert.equal(client.getSyncState().status, 'conflict'); assert.equal(client.getSyncState().canRetry, false);
  assert.equal((await client.keepBothCopies()).id, 'remote-copy');
  assert.equal(calls[1].url, '/api/saves'); assert.match(calls[1].slot_name, /本机副本/);
  await client.scheduleQuickSave('默认云存档', () => ({ saveData: timeline('local-next') }), scope);
  assert.equal(calls[2].url, '/api/saves/remote-copy'); assert.equal(calls[2].expected_revision, 1);
});

await test('new root cannot overwrite a default slot belonging to a different root', async () => {
  const client = new CloudSaveClient(); client.setSyncContext(scope);
  client.listSaves = async () => [{ id: 'other', revision: 3, slot_name: '默认云存档', preview_data: { sync_save_key: 'other-root' } }];
  client.uploadSave = async () => ({ id: 'new', revision: 1 });
  client.updateSave = async () => { throw new Error('must not overwrite another root'); };
  assert.equal((await client.scheduleQuickSave('默认云存档', () => ({ saveData: timeline('new') }))).id, 'new');
});

console.log(`Cloud sync state regression: ${passed} groups passed`);
