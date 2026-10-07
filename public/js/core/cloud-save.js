// cloud-save.js — 云存档客户端
// ES Module — 通过 REST API 管理游戏云存档

import { encodeTimelineSave } from './timeline-file-codec.js';
import { authClient } from './auth-client.js';
import { CloudSyncState, cloudSyncState, cloudScopeKey } from './cloud-sync-state.js';
import { fetchProjectServer } from './project-server.js';
import { isNativeAndroidApp } from './runtime-platform.js';

const GZIP_MULTIPART_PROTOCOL = 'gzip-multipart-v1';
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const DEFAULT_LEGACY_JSON_MAX_BYTES = 16 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;
const OPERATION_GENERATION = Symbol('cloud-save-operation-generation');

function finitePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeCapabilities(value) {
  const source = value && typeof value === 'object' ? value : {};
  const protocols = [
    ...(Array.isArray(source.upload_protocols) ? source.upload_protocols : []),
    ...(Array.isArray(source.protocols) ? source.protocols : [])
  ];
  const protocol = source.preferred_upload_protocol === GZIP_MULTIPART_PROTOCOL
    || source.protocol === GZIP_MULTIPART_PROTOCOL
    || protocols.includes(GZIP_MULTIPART_PROTOCOL)
    || source.gzip_multipart === true
    ? GZIP_MULTIPART_PROTOCOL
    : null;
  const limits = source.limits && typeof source.limits === 'object' ? source.limits : source;
  return Object.freeze({
    protocol,
    max_uncompressed_bytes: finitePositiveInteger(
      limits.max_uncompressed_bytes ?? limits.max_decompressed_bytes,
      DEFAULT_MAX_UNCOMPRESSED_BYTES
    ),
    max_compressed_bytes: finitePositiveInteger(
      limits.max_compressed_bytes,
      DEFAULT_MAX_COMPRESSED_BYTES
    ),
    legacy_json_max_bytes: finitePositiveInteger(
      limits.max_legacy_json_bytes ?? limits.legacy_json_max_bytes,
      DEFAULT_LEGACY_JSON_MAX_BYTES
    )
  });
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  if (!Number.isFinite(delay) || delay <= 0) return null;
  return Math.min(Math.ceil(delay), MAX_RETRY_AFTER_MS);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${Math.ceil(bytes / 1024 / 1024)} MiB`;
}

export class CloudSaveError extends Error {
  constructor(message, { status = 0, code = 'CLOUD_SAVE_ERROR', retryAfterMs = null, details = null } = {}) {
    const retryHint = retryAfterMs ? `（请在 ${Math.ceil(retryAfterMs / 1000)} 秒后重试）` : '';
    super(`${message}${retryHint}`);
    this.name = 'CloudSaveError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

export class CloudSaveClient {
  constructor({ auth = null, syncState = new CloudSyncState(), storage = globalThis.localStorage } = {}) {
    this.auth = auth;
    this.storage = storage;
    this.syncState = syncState;
    this._revisions = new Map();
    this._bindings = new Map();
    this._failedSync = new Map();
    this._sequences = new Map();
    this._capabilitiesPromise = null;
    this._nextSyncId = 0;
    this._pendingSync = new Map();
    this._syncRunner = null;
    this._syncWaiters = [];
    this._contextGeneration = 0;
    this._accountGeneration = 0;
    this._bindingGenerations = new Map();
    this._activeOperations = new Set();
    this._localRevisions = new Map();
  }

  setSyncContext(scope = {}) {
    const previous = this.syncState.active;
    if (cloudScopeKey(previous) !== cloudScopeKey(scope)) this._contextGeneration++;
    if (previous.userId !== String(scope.userId || '')) this._accountGeneration++;
    this.syncState.setContext(scope);
    this._invalidateOperations();
    return this.getSyncState();
  }
  getSyncState(scope) { return this.syncState.get(scope); }
  subscribeSync(listener) { return this.syncState.subscribe(listener); }
  getSaveRevision(saveId, options = {}) { return this._revisions.get(this._revisionKey(saveId, this._scope(options))); }
  bindSyncSave({ saveId, revision, slotName = '默认云存档', ...options } = {}) {
    const scope = this._scope(options);
    const key = cloudScopeKey(scope);
    // Explicit loads/imports start a new incarnation even if their root ID did not change.
    this._bindingGenerations.set(key, (this._bindingGenerations.get(key) || 0) + 1);
    const binding = this._commitSyncBinding({ saveId, revision, slotName }, scope);
    this._invalidateOperations();
    this.syncState.set(scope, { status: 'local', message: '本地已保存', errorCode: '', errorMessage: '', canRetry: false, canKeepBoth: false });
    return binding;
  }

  _commitSyncBinding({ saveId, revision, slotName = '默认云存档' }, scope) {
    const binding = { id: saveId || '', slotName, revision: Number.isSafeInteger(revision) ? revision : undefined, forceNew: !saveId };
    this._bindings.set(cloudScopeKey(scope), binding);
    if (saveId) this._rememberRevision(saveId, revision, scope, true);
    try { this.storage?.setItem(`naruto_cloud_binding:${cloudScopeKey(scope)}`, JSON.stringify(binding)); } catch { /* IndexedDB/local save remains authoritative. */ }
    return binding;
  }

  _readBinding(scope) {
    const key = cloudScopeKey(scope);
    if (this._bindings.has(key)) return this._bindings.get(key);
    try {
      const binding = JSON.parse(this.storage?.getItem(`naruto_cloud_binding:${key}`) || 'null');
      if (binding && typeof binding.id === 'string' && typeof binding.slotName === 'string') {
        this._bindings.set(key, binding);
        this._rememberRevision(binding.id, binding.revision, scope, true);
        return binding;
      }
    } catch { /* Ignore malformed status metadata without touching game saves. */ }
    return null;
  }
  markLocalSaved(scope = this.syncState.active) {
    const key = cloudScopeKey(scope);
    const localRevision = this._localRevision(scope) + 1;
    this._localRevisions.set(key, localRevision);
    const previous = this.syncState.get(scope);
    if (['uploading', 'retry', 'conflict'].includes(previous.status)) return this.syncState.set(scope, { localRevision, dirty: true });
    return this.syncState.set(scope, { status: 'local', message: '本地已保存', localRevision, dirty: true, canRetry: false, canKeepBoth: false });
  }

  _localRevision(scope) { return this._localRevisions.get(cloudScopeKey(scope)) || 0; }

  _scope(options = {}, fallback = '') {
    const active = this.syncState.active;
    const scope = {
      userId: String(options.userId ?? active.userId ?? ''),
      saveKey: String(options.saveKey ?? (active.saveKey || fallback)),
      enforceCurrent: options.enforceCurrent ?? Boolean(active.saveKey)
    };
    scope[OPERATION_GENERATION] = options[OPERATION_GENERATION] || {
      context: this._contextGeneration,
      account: this._accountGeneration,
      binding: this._bindingGenerations.get(cloudScopeKey(scope)) || 0
    };
    return scope;
  }

  _assertCurrentScope(scope) {
    const generation = scope[OPERATION_GENERATION];
    if (generation && generation.account !== this._accountGeneration) {
      throw new CloudSaveError('登录账号已改变，请在当前账号重新选择存档', { code: 'CLOUD_ACCOUNT_CHANGED' });
    }
    if ((generation && generation.binding !== (this._bindingGenerations.get(cloudScopeKey(scope)) || 0))
      || (scope.enforceCurrent && (cloudScopeKey(scope) !== cloudScopeKey(this.syncState.active)
        || (generation && generation.context !== this._contextGeneration)))) {
      throw new CloudSaveError('当前账号或存档已改变，请回到原存档后重试', { code: 'CLOUD_CONTEXT_CHANGED' });
    }
  }

  _invalidateOperations() {
    const invalid = new Map();
    const check = scope => {
      try { this._assertCurrentScope(scope); return null; }
      catch (error) { invalid.set(cloudScopeKey(scope), scope); return error; }
    };
    for (const [key, request] of this._pendingSync) {
      if (check(request.scope)) this._pendingSync.delete(key);
    }
    const waiters = this._syncWaiters;
    this._syncWaiters = [];
    for (const waiter of waiters) {
      const error = check(waiter.scope);
      if (error) waiter.reject(error);
      else this._syncWaiters.push(waiter);
    }
    for (const [key, operation] of this._failedSync) {
      if (check(operation.scope)) this._failedSync.delete(key);
    }
    for (const operation of this._activeOperations) {
      if (check(operation.scope)) this._activeOperations.delete(operation);
    }
    for (const scope of invalid.values()) {
      this._nextSequence(scope);
      this.syncState.set(scope, { status: 'local', message: '本地已保存', errorCode: '', errorMessage: '', canRetry: false, canKeepBoth: false });
    }
  }

  async _assertScope(scope) {
    this._assertCurrentScope(scope);
    if (scope.userId && this.auth) {
      const user = await this.auth.checkAuth(true);
      if (isNativeAndroidApp() && this.auth.getCloudError?.()) throw this.auth.getCloudError();
      if (user?.id !== scope.userId) throw new CloudSaveError('登录账号已改变，请在当前账号重新选择存档', { code: 'CLOUD_ACCOUNT_CHANGED' });
    }
    this._assertCurrentScope(scope);
  }

  _revisionKey(id, scope) { return cloudScopeKey({ userId: scope.userId, saveKey: id }); }
  _rememberRevision(id, revision, scope, replace = false) {
    const key = this._revisionKey(id, scope);
    if (Number.isSafeInteger(revision) && revision >= 0 && (replace || !this._revisions.has(key))) this._revisions.set(key, revision);
  }

  _nextSequence(scope) {
    const key = cloudScopeKey(scope);
    const sequence = (this._sequences.get(key) || 0) + 1;
    this._sequences.set(key, sequence);
    return sequence;
  }

  async _trackOperation(operation, execute, sequence = this._nextSequence(operation.scope)) {
    const key = cloudScopeKey(operation.scope);
    const current = () => {
      try { this._assertCurrentScope(operation.scope); }
      catch { return false; }
      return this._sequences.get(key) === sequence;
    };
    this._activeOperations.add(operation);
    if (current()) this.syncState.set(operation.scope, { status: 'uploading', message: '正在上传云存档', canRetry: false, canKeepBoth: false });
    try {
      await this._assertScope(operation.scope);
      const result = await execute();
      this._assertCurrentScope(operation.scope);
      if (current()) {
        this._failedSync.delete(key);
        const dirty = operation.localRevision !== this._localRevision(operation.scope);
        this.syncState.set(operation.scope, { status: dirty ? 'local' : 'synced', message: dirty ? '本地有新进度，尚未同步' : '已同步到云端', dirty, cloudSaveId: result?.id, errorCode: '', canRetry: false, canKeepBoth: false, lastSyncedAt: Date.now() });
      }
      return result;
    } catch (error) {
      if (current()) {
        this._failedSync.set(key, operation);
        const conflict = error?.code === 'SAVE_REVISION_CONFLICT';
        const changed = ['CLOUD_ACCOUNT_CHANGED', 'CLOUD_CONTEXT_CHANGED'].includes(error?.code);
        this.syncState.set(operation.scope, { status: conflict ? 'conflict' : 'retry', message: conflict ? '云端有另一份进度，请保留双方副本' : (changed ? '账号或存档已切换，原进度保留在本机' : '本地已保存，云端同步待重试'), errorCode: error?.code || '', errorMessage: error.message, canRetry: !conflict && !changed, canKeepBoth: conflict });
      }
      throw error;
    } finally {
      this._activeOperations.delete(operation);
    }
  }

  async retrySync(options = {}) {
    const scope = this._scope(options);
    const operation = this._failedSync.get(cloudScopeKey(scope));
    if (!operation || !this.getSyncState(scope).canRetry) throw new CloudSaveError('当前存档没有可以重试的同步', { code: 'NO_PENDING_SYNC' });
    return this._trackOperation(operation, () => this._executeOperation(operation));
  }

  async keepBothCopies({ slotName, ...options } = {}) {
    const scope = this._scope(options);
    const operation = this._failedSync.get(cloudScopeKey(scope));
    if (!operation || !this.getSyncState(scope).canKeepBoth) throw new CloudSaveError('当前存档没有待处理的云端冲突', { code: 'NO_SAVE_CONFLICT' });
    const copy = { ...operation, type: 'upload', bindQuick: operation.type === 'quick', slotName: String(slotName || `${operation.slotName}（本机副本）`).slice(0, 50) };
    return this._trackOperation(copy, () => this._executeOperation(copy));
  }

  async _executeOperation(operation) {
    if (operation.type === 'quick') return this._performQuickSave(operation.slotName, operation.saveData, operation.previewData, operation.scope);
    const result = await this._saveRequest(operation.type === 'update' ? `/api/saves/${encodeURIComponent(operation.saveId)}` : '/api/saves', operation.type === 'update' ? 'PUT' : 'POST', operation.slotName, operation.saveData, operation.previewData, operation.type === 'update' ? '更新存档失败' : '上传存档失败', operation);
    this._assertCurrentScope(operation.scope);
    if (operation.bindQuick) this._commitSyncBinding({ saveId: result.id, revision: result.revision, slotName: operation.slotName }, operation.scope);
    return result;
  }

  async _fetch(url, options = {}, failMsg = '请求失败') {
    let res;
    try {
      res = await fetchProjectServer(url, {
        credentials: 'same-origin',
        timeoutMs: /\/content$/.test(url) || options.body ? 90_000 : 15_000,
        ...options,
      });
    } catch (error) {
      throw new CloudSaveError(`${failMsg}: ${error?.message || '网络连接失败'}`, {
        code: error?.code || 'NETWORK_ERROR'
      });
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const error = new CloudSaveError(body.error || failMsg, {
        status: res.status,
        code: typeof body.code === 'string' && body.code ? body.code : `HTTP_${res.status}`,
        retryAfterMs,
        details: body.details ?? null
      });

      if (res.status === 401 && !isNativeAndroidApp() && typeof window !== 'undefined') {
        window.location.href = '/login.html';
      }
      throw error;
    }
    return res;
  }

  async _request(url, options = {}, failMsg = '请求失败') {
    const res = await this._fetch(url, options, failMsg);
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) return res.json();
    return null;
  }

  async getCapabilities({ force = false } = {}) {
    if (force) this._capabilitiesPromise = null;
    if (!this._capabilitiesPromise) {
      this._capabilitiesPromise = this._request(
        '/api/saves/capabilities',
        {},
        '获取云存档能力失败'
      ).then(normalizeCapabilities).catch(error => {
        // 老版本服务没有能力端点；仅允许小存档走受限 JSON 兼容路径。
        if (error instanceof CloudSaveError && error.status === 404) {
          return normalizeCapabilities(null);
        }
        this._capabilitiesPromise = null;
        throw error;
      });
    }
    return this._capabilitiesPromise;
  }

  async listSaves(options = {}) {
    const scope = this._scope(options);
    const saves = await this._request('/api/saves', scope.userId ? { headers: { 'X-Cloud-User-Id': scope.userId } } : {}, '获取存档列表失败');
    for (const save of saves) this._rememberRevision(save.id, save.revision, scope);
    return saves;
  }

  async getStorage() {
    try { return await this._request('/api/saves/storage', {}, '获取云端容量失败'); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }

  async renameSave(saveId, slotName) {
    const options = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot_name: slotName }) };
    try { return await this._request(`/api/saves/${encodeURIComponent(saveId)}/metadata`, options, '云存档改名失败'); }
    catch (error) {
      // The existing PUT API already supports metadata-only JSON updates.
      if (error.status !== 404 && error.status !== 405) throw error;
      return this._request(`/api/saves/${encodeURIComponent(saveId)}`, { ...options, method: 'PUT' }, '云存档改名失败');
    }
  }

  async _buildMultipart(slotName, saveData, previewData, capabilities, expectedRevision) {
    const encoded = await encodeTimelineSave(saveData, { compression: 'gzip' });
    if (encoded.blob.size > capabilities.max_compressed_bytes) {
      throw new CloudSaveError(
        `压缩后的存档超过 ${formatBytes(capabilities.max_compressed_bytes)} 上限`,
        { status: 413, code: 'COMPRESSED_SAVE_TOO_LARGE' }
      );
    }
    const form = new FormData();
    form.append('metadata', JSON.stringify({
      slot_name: slotName,
      preview_data: previewData ?? {},
      ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision })
    }));
    form.append('save', encoded.blob, 'timeline.json.gz');
    return form;
  }

  async _buildLegacyJsonBody(slotName, saveData, previewData, capabilities, expectedRevision) {
    const encoded = await encodeTimelineSave(saveData, { compression: 'json' });
    if (encoded.blob.size > capabilities.legacy_json_max_bytes) {
      throw new CloudSaveError(
        `服务器不支持 gzip 上传，普通 JSON 存档超过 ${formatBytes(capabilities.legacy_json_max_bytes)} 兼容上限`,
        { status: 413, code: 'GZIP_UPLOAD_REQUIRED' }
      );
    }
    const saveJson = await encoded.blob.text();
    return `{"slot_name":${JSON.stringify(slotName)},"save_data":${saveJson},"preview_data":${JSON.stringify(previewData ?? {})}${expectedRevision === undefined ? '' : `,"expected_revision":${expectedRevision}`}}`;
  }

  async _saveRequest(url, method, slotName, saveData, previewData, failMsg, operation = {}) {
    const capabilities = await this.getCapabilities();
    const scope = operation.scope || this._scope();
    const headers = scope.userId ? { 'X-Cloud-User-Id': scope.userId } : {};
    let body;
    if (capabilities.protocol === GZIP_MULTIPART_PROTOCOL) {
      body = await this._buildMultipart(slotName, saveData, previewData, capabilities, operation.expectedRevision);
    } else {
      body = await this._buildLegacyJsonBody(slotName, saveData, previewData, capabilities, operation.expectedRevision);
      headers['Content-Type'] = 'application/json';
    }
    await this._assertScope(scope);
    const result = await this._request(url, { method, ...(Object.keys(headers).length ? { headers } : {}), body }, failMsg);
    this._assertCurrentScope(scope);
    this._rememberRevision(result?.id || operation.saveId, result?.revision, scope, true);
    return result;
  }

  async uploadSave(slotName, saveData, previewData = null, options = {}) {
    const operation = { type: 'upload', slotName, saveData, previewData, scope: this._scope(options, slotName) };
    operation.localRevision = this._localRevision(operation.scope);
    return options.track === false ? this._executeOperation(operation) : this._trackOperation(operation, () => this._executeOperation(operation));
  }

  async downloadSave(saveId, options = {}) {
    const scope = this._scope(options);
    const requestOptions = scope.userId ? { headers: { 'X-Cloud-User-Id': scope.userId } } : {};
    const capabilities = await this.getCapabilities();
    if (capabilities.protocol !== GZIP_MULTIPART_PROTOCOL) {
      const legacy = await this._request(`/api/saves/${saveId}`, requestOptions, '下载存档失败');
      this._rememberRevision(saveId, legacy.revision ?? 0, scope, true);
      const blob = new Blob([JSON.stringify(legacy.save_data)], { type: 'application/json' });
      return typeof File === 'function'
        ? new File([blob], 'cloud_save.json', { type: blob.type })
        : blob;
    }

    const res = await this._fetch(`/api/saves/${saveId}/content`, requestOptions, '下载存档失败');
    const revision = res.headers?.get('X-Save-Revision');
    if (revision !== null && revision !== undefined) this._rememberRevision(saveId, Number(revision), scope, true);
    const source = await res.blob();
    const blob = new Blob([source], { type: 'application/gzip' });
    return typeof File === 'function'
      ? new File([blob], 'cloud_save.json.gz', { type: blob.type })
      : blob;
  }

  async updateSave(saveId, slotName, saveData, previewData = null, options = {}) {
    const scope = this._scope(options, saveId);
    const localRevision = this._localRevision(scope);
    let expectedRevision = options.expectedRevision ?? this._revisions.get(this._revisionKey(saveId, scope));
    if (expectedRevision === undefined) {
      const entry = (await this.listSaves(scope)).find(save => save.id === saveId);
      expectedRevision = entry?.revision ?? 0;
    }
    const operation = { type: 'update', saveId, slotName, saveData, previewData, expectedRevision, scope, localRevision };
    return options.track === false ? this._executeOperation(operation) : this._trackOperation(operation, () => this._executeOperation(operation));
  }

  async deleteSave(saveId) {
    return this._request(`/api/saves/${saveId}`, {
      method: 'DELETE',
    }, '删除存档失败');
  }

  async _performQuickSave(slotName, saveData, previewData, scope = this._scope({}, slotName)) {
    const key = cloudScopeKey(scope);
    let binding = this._readBinding(scope);
    if (!binding) {
      const knownRevisions = new Map(this._revisions);
      const saves = await this.listSaves(scope);
      this._assertCurrentScope(scope);
      const existing = saves.find(save => save.preview_data?.sync_save_key === scope.saveKey)
        || saves.find(save => save.slot_name === slotName && !save.preview_data?.sync_save_key);
      if (existing) {
        binding = { id: existing.id, slotName: existing.slot_name };
        this._bindings.set(key, binding);
        // With no baseline for an existing game, a scoped automatic upload must
        // not silently adopt the latest remote revision and overwrite it.
        if (scope.enforceCurrent && !knownRevisions.has(this._revisionKey(existing.id, scope))) this._rememberRevision(existing.id, 0, scope, true);
      }
    }
    const preview = { ...(previewData || {}), sync_save_key: scope.saveKey };
    const result = binding?.id
      ? await this.updateSave(binding.id, binding.slotName, saveData, preview, { ...scope, track: false })
      : await this.uploadSave(slotName, saveData, preview, { ...scope, track: false });
    this._assertCurrentScope(scope);
    this._commitSyncBinding({ saveId: result.id, slotName: binding?.slotName || slotName, revision: result.revision }, scope);
    return result;
  }

  quickSave(slotName, saveData, previewData = null) {
    return this.scheduleQuickSave(slotName, () => ({ saveData, previewData }));
  }

  scheduleQuickSave(slotName, createPayload, options = {}) {
    if (typeof createPayload !== 'function') {
      return Promise.reject(new TypeError('云存档同步需要存档快照生成函数'));
    }
    const id = ++this._nextSyncId;
    const scope = this._scope(options, slotName);
    const key = cloudScopeKey(scope);
    const sequence = this._nextSequence(scope);
    this._pendingSync.set(key, { id, key, sequence, scope, slotName, createPayload, localRevision: this._localRevision(scope) });
    const promise = new Promise((resolve, reject) => {
      this._syncWaiters.push({ id, key, scope, resolve, reject });
    });
    this._ensureSyncRunner();
    return promise;
  }

  _ensureSyncRunner() {
    if (this._syncRunner) return;
    // 先占位，避免 createPayload 的同步前半段重入 scheduleQuickSave 时启动第二个 runner。
    this._syncRunner = { starting: true };
    const runner = this._drainQuickSaves();
    this._syncRunner = runner;
    void runner.then(() => {
      if (this._syncRunner !== runner) return;
      this._syncRunner = null;
      // 已完成调用方的 Promise 回调可能正好排在 runner 收尾之前，并新增 dirty 请求。
      if (this._pendingSync.size) this._ensureSyncRunner();
    });
  }

  _settleSyncWaiters(throughId, key, error, value) {
    const settled = [];
    const remaining = [];
    for (const waiter of this._syncWaiters) {
      if (waiter.key === key && waiter.id <= throughId) settled.push(waiter);
      else remaining.push(waiter);
    }
    this._syncWaiters = remaining;
    for (const waiter of settled) {
      if (error) waiter.reject(error);
      else waiter.resolve(value);
    }
  }

  async _drainQuickSaves() {
    while (this._pendingSync.size) {
      const request = this._pendingSync.values().next().value;
      this._pendingSync.delete(request.key);
      try {
        this._assertCurrentScope(request.scope);
        const payload = await request.createPayload();
        this._assertCurrentScope(request.scope);
        if (!payload || typeof payload !== 'object') {
          throw new TypeError('云存档快照生成函数必须返回对象');
        }
        const operation = { type: 'quick', slotName: request.slotName, saveData: payload.saveData, previewData: payload.previewData ?? null, scope: request.scope, localRevision: request.localRevision };
        const value = await this._trackOperation(operation, () => this._executeOperation(operation), request.sequence);
        this._settleSyncWaiters(request.id, request.key, null, value);
      } catch (error) {
        this._settleSyncWaiters(request.id, request.key, error);
      }
    }
  }
}

export const cloudSave = new CloudSaveClient({ auth: authClient, syncState: cloudSyncState });
