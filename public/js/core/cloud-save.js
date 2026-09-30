// cloud-save.js — 云存档客户端
// ES Module — 通过 REST API 管理游戏云存档

import { encodeTimelineSave } from './timeline-file-codec.js';

const GZIP_MULTIPART_PROTOCOL = 'gzip-multipart-v1';
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const DEFAULT_LEGACY_JSON_MAX_BYTES = 16 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

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
  constructor() {
    this._capabilitiesPromise = null;
    this._nextSyncId = 0;
    this._pendingSync = null;
    this._syncRunner = null;
    this._syncWaiters = [];
  }

  async _fetch(url, options = {}, failMsg = '请求失败') {
    let res;
    try {
      res = await fetch(url, {
        credentials: 'same-origin',
        ...options,
      });
    } catch (error) {
      throw new CloudSaveError(`${failMsg}: ${error?.message || '网络连接失败'}`, {
        code: 'NETWORK_ERROR'
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

      if (res.status === 401 && typeof window !== 'undefined') {
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

  async listSaves() {
    return this._request('/api/saves', {}, '获取存档列表失败');
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

  async _buildMultipart(slotName, saveData, previewData, capabilities) {
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
      preview_data: previewData
    }));
    form.append('save', encoded.blob, 'timeline.json.gz');
    return form;
  }

  async _buildLegacyJsonBody(slotName, saveData, previewData, capabilities) {
    const encoded = await encodeTimelineSave(saveData, { compression: 'json' });
    if (encoded.blob.size > capabilities.legacy_json_max_bytes) {
      throw new CloudSaveError(
        `服务器不支持 gzip 上传，普通 JSON 存档超过 ${formatBytes(capabilities.legacy_json_max_bytes)} 兼容上限`,
        { status: 413, code: 'GZIP_UPLOAD_REQUIRED' }
      );
    }
    const saveJson = await encoded.blob.text();
    return `{"slot_name":${JSON.stringify(slotName)},"save_data":${saveJson},"preview_data":${JSON.stringify(previewData)}}`;
  }

  async _saveRequest(url, method, slotName, saveData, previewData, failMsg) {
    const capabilities = await this.getCapabilities();
    if (capabilities.protocol === GZIP_MULTIPART_PROTOCOL) {
      const body = await this._buildMultipart(slotName, saveData, previewData, capabilities);
      return this._request(url, { method, body }, failMsg);
    }
    const body = await this._buildLegacyJsonBody(
      slotName,
      saveData,
      previewData,
      capabilities
    );
    return this._request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body
    }, failMsg);
  }

  async uploadSave(slotName, saveData, previewData = null) {
    return this._saveRequest(
      '/api/saves',
      'POST',
      slotName,
      saveData,
      previewData,
      '上传存档失败'
    );
  }

  async downloadSave(saveId) {
    const capabilities = await this.getCapabilities();
    if (capabilities.protocol !== GZIP_MULTIPART_PROTOCOL) {
      const legacy = await this._request(`/api/saves/${saveId}`, {}, '下载存档失败');
      const blob = new Blob([JSON.stringify(legacy.save_data)], { type: 'application/json' });
      return typeof File === 'function'
        ? new File([blob], 'cloud_save.json', { type: blob.type })
        : blob;
    }

    const res = await this._fetch(`/api/saves/${saveId}/content`, {}, '下载存档失败');
    const source = await res.blob();
    const blob = new Blob([source], { type: 'application/gzip' });
    return typeof File === 'function'
      ? new File([blob], 'cloud_save.json.gz', { type: blob.type })
      : blob;
  }

  async updateSave(saveId, slotName, saveData, previewData = null) {
    return this._saveRequest(
      `/api/saves/${saveId}`,
      'PUT',
      slotName,
      saveData,
      previewData,
      '更新存档失败'
    );
  }

  async deleteSave(saveId) {
    return this._request(`/api/saves/${saveId}`, {
      method: 'DELETE',
    }, '删除存档失败');
  }

  async _performQuickSave(slotName, saveData, previewData) {
    const saves = await this.listSaves();
    const existing = saves.find(save => save.slot_name === slotName);
    if (existing) return this.updateSave(existing.id, slotName, saveData, previewData);
    return this.uploadSave(slotName, saveData, previewData);
  }

  quickSave(slotName, saveData, previewData = null) {
    return this.scheduleQuickSave(slotName, () => ({ saveData, previewData }));
  }

  scheduleQuickSave(slotName, createPayload) {
    if (typeof createPayload !== 'function') {
      return Promise.reject(new TypeError('云存档同步需要存档快照生成函数'));
    }
    const id = ++this._nextSyncId;
    this._pendingSync = { id, slotName, createPayload };
    const promise = new Promise((resolve, reject) => {
      this._syncWaiters.push({ id, resolve, reject });
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
      if (this._pendingSync) this._ensureSyncRunner();
    });
  }

  _settleSyncWaiters(throughId, error, value) {
    const settled = [];
    const remaining = [];
    for (const waiter of this._syncWaiters) {
      if (waiter.id <= throughId) settled.push(waiter);
      else remaining.push(waiter);
    }
    this._syncWaiters = remaining;
    for (const waiter of settled) {
      if (error) waiter.reject(error);
      else waiter.resolve(value);
    }
  }

  async _drainQuickSaves() {
    while (this._pendingSync) {
      const request = this._pendingSync;
      this._pendingSync = null;
      try {
        const payload = await request.createPayload();
        if (!payload || typeof payload !== 'object') {
          throw new TypeError('云存档快照生成函数必须返回对象');
        }
        const value = await this._performQuickSave(
          request.slotName,
          payload.saveData,
          payload.previewData ?? null
        );
        this._settleSyncWaiters(request.id, null, value);
      } catch (error) {
        this._settleSyncWaiters(request.id, error);
      }
    }
  }
}

export const cloudSave = new CloudSaveClient();
