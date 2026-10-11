import { decodeTimelineSaveFile, encodeTimelineSave } from './timeline-file-codec.js';
import { exportFile } from './file-export.js';
import { checksumSaveJson } from './save-json-stream.js';
import { timelineStorageTask } from './timeline-storage-client.js';

export const SAVE_PACKAGE_SCHEMA = 'naruto.save-package/v1';
export const PERSONAL_SAVE_KIND = 'personal_timeline';
export const ROOM_SAVE_KIND = 'multiplayer_room';
const KINDS = new Set([PERSONAL_SAVE_KIND, ROOM_SAVE_KIND]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_KEYS = /^(?:_api|api_config|apiConfig|apiKey|api_key|access_token|refresh_token|authorization|csrf_token|invite_token|password|credential_secret)$/i;

// Files contain game data only. Connection settings and login credentials are
// owned by their existing stores and must never become portable save data.
function visitSaveData(value, key, visiting, validateOnly = false) {
  if (UNSAFE_KEYS.has(key)) throw new Error('存档包含不安全字段');
  if (SECRET_KEYS.test(key)) {
    if (validateOnly && value !== undefined && !['function', 'symbol'].includes(typeof value)) throw new Error('存档混入连接凭证，请重新导出');
    return undefined;
  }
  if (value && typeof value.toJSON === 'function') value = value.toJSON(key);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  if (typeof value === 'bigint') throw new TypeError('存档不能包含 BigInt');
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value || typeof value !== 'object') return value;
  if (visiting.has(value)) throw new Error('存档包含循环引用，无法保存');
  visiting.add(value);
  const array = Array.isArray(value);
  const result = validateOnly ? undefined : array ? [] : {};
  const keys = array ? Array.from({ length: value.length }, (_, i) => String(i)) : Object.keys(value);
  for (const childKey of keys) {
    const item = visitSaveData(value[childKey], childKey, visiting, validateOnly);
    if (!validateOnly && (item !== undefined || array)) result[childKey] = item === undefined ? null : item;
  }
  visiting.delete(value);
  return result;
}

export function cleanSaveData(value) {
  return visitSaveData(value, '', new WeakSet());
}

export async function saveChecksum(payload) {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持存档完整性校验，请使用 HTTPS 或 localhost');
  return checksumSaveJson(payload);
}

export async function createSavePackage(kind, payload, label = '') {
  if (!KINDS.has(kind)) throw new Error('未知存档类型');
  const cleaned = cleanSaveData(payload);
  return {
    schema: SAVE_PACKAGE_SCHEMA,
    kind,
    saved_at: new Date().toISOString(),
    label: String(label).trim().slice(0, 100),
    checksum: { algorithm: 'SHA-256', value: await saveChecksum(cleaned) },
    payload: cleaned
  };
}

export async function validateSavePackage(value) {
  if (value?.schema !== SAVE_PACKAGE_SCHEMA || !KINDS.has(value?.kind)) {
    throw new Error('不支持的存档类型或版本，请使用兼容版本导出的存档');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)
    || value.checksum?.algorithm !== 'SHA-256'
    || value.checksum?.value !== await saveChecksum(value.payload)) {
    throw new Error('存档完整性校验失败，文件可能损坏或被修改');
  }
  // Reject, rather than quietly alter, a signed package with unsafe/config data.
  visitSaveData(value.payload, '', new WeakSet(), true);
  return value;
}

export const downloadSaveFile = exportFile;

function storageError(error) {
  return new Error(error?.name === 'QuotaExceededError'
    ? '本地空间不足，保存未完成。请先导出或清理旧档，当前进度仍保留。'
    : `本地存档操作失败：${error?.message || '浏览器存储不可用'}`, { cause: error });
}

/** Legacy files use a separate database; raw archives use dedicated timeline
 * stores for atomic backup + switch. Resetting a timeline preserves both. */
export class LocalSaveLibrary {
  constructor({ indexedDB = globalThis.indexedDB, name = 'naruto_rpg_save_library', archiveTask = name === 'naruto_rpg_save_library' && typeof Worker === 'function' ? timelineStorageTask : null } = {}) {
    this.indexedDB = indexedDB;
    this.name = name;
    this._opening = null;
    this.archiveTask = archiveTask;
  }

  async open() {
    if (!this._opening) {
      this._opening = new Promise((resolve, reject) => {
        if (!this.indexedDB) return reject(new Error('此浏览器不支持本地存档库'));
        const request = this.indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('entries', { keyPath: 'id' });
          db.createObjectStore('files', { keyPath: 'id' });
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this._opening = null; };
          resolve(db);
        };
        request.onerror = () => reject(storageError(request.error));
        request.onblocked = () => reject(new Error('请关闭其他游戏标签页后重试存档操作'));
      }).catch(error => { this._opening = null; throw error; });
    }
    return this._opening;
  }

  async _read(store, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => {};
    });
  }

  async list(kind, owner = 'device') {
    const archives = kind === PERSONAL_SAVE_KIND && owner === 'device' && this.archiveTask ? await this.archiveTask('list') : [];
    return [...await this._read('entries'), ...archives].filter(entry => entry.kind === kind && entry.owner === owner)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id, kind, owner = 'device') {
    const entry = String(id).startsWith('archive:') && this.archiveTask ? await this.archiveTask('get', { id }) : await this._read('entries', id);
    if (!entry || entry.kind !== kind || entry.owner !== owner) throw new Error('找不到当前账号的这份存档');
    return entry;
  }

  async readPackage(id, kind, owner = 'device') {
    const entry = await this.get(id, kind, owner);
    if (entry.storage === 'timeline_archive') {
      const encoded = await this.archiveTask('export', { id });
      return validateSavePackage(await decodeTimelineSaveFile(encoded.blob));
    }
    const stored = await this._read('files', id);
    if (!stored?.blob) throw new Error('此房间只有历史记录，尚未保存本地快照');
    const pack = await validateSavePackage(await decodeTimelineSaveFile(stored.blob));
    if (pack.kind !== kind) throw new Error('存档分区与文件类型不一致');
    return pack;
  }

  async put(entry, pack = null) {
    if (!KINDS.has(entry?.kind) || !entry?.id || !entry?.owner) throw new Error('存档目录信息不完整');
    if (pack) {
      await validateSavePackage(pack);
      if (pack.kind !== entry.kind) throw new Error('不能将联机档写入个人存档分区');
    }
    const encoded = pack ? await encodeTimelineSave(pack) : null;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['entries', 'files'], 'readwrite');
      const entries = tx.objectStore('entries');
      const lookup = entries.get(entry.id);
      let result;
      let writeError;
      lookup.onsuccess = () => {
        try {
          const prior = lookup.result;
          if (prior && (prior.kind !== entry.kind || prior.owner !== entry.owner)) throw new Error('存档归属不匹配');
          result = { ...prior, ...entry, updatedAt: Date.now(), createdAt: prior?.createdAt ?? Date.now() };
          if (encoded) {
            result.bytes = encoded.blob.size;
            result.snapshotAt = pack.saved_at;
            result.checksum = pack.checksum.value;
            tx.objectStore('files').put({ id: entry.id, blob: encoded.blob });
          }
          entries.put(result);
        } catch (error) { writeError = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(storageError(writeError || tx.error));
      tx.onerror = () => {};
    });
  }

  async rename(id, kind, owner, label) {
    const entry = await this.get(id, kind, owner);
    const name = String(label ?? '').trim().slice(0, 100);
    if (!name) throw new Error('请输入存档名称');
    if (entry.storage === 'timeline_archive') return this.archiveTask('rename', { id, label: name });
    return this.put({ ...entry, label: name });
  }

  async remove(id, kind, owner = 'device') {
    const entry = await this.get(id, kind, owner);
    if (entry.storage === 'timeline_archive') return this.archiveTask('remove', { id });
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['entries', 'files'], 'readwrite');
      tx.objectStore('entries').delete(id);
      tx.objectStore('files').delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => {};
    });
  }

  async export(id, kind, owner = 'device') {
    const entry = await this.get(id, kind, owner);
    if (entry.storage === 'timeline_archive') {
      const encoded = await this.archiveTask('export', { id });
      const name = `个人存档-${entry.label}`.replace(/[\\/:*?"<>|]/g, '_');
      const download = await downloadSaveFile(encoded.blob, `${name}${encoded.extension}`);
      return { ...encoded, cancelled: download.cancelled === true };
    }
    const stored = await this._read('files', id);
    if (!(stored?.blob instanceof Blob) || !stored.blob.size) throw new Error('此存档尚未保存本地快照文件');
    // A library snapshot was validated when stored. Backup copies its exact
    // bytes; decoding here needlessly inflated the entire archive and
    // doubled the memory cost for large saves. The captured label/checksum stay
    // intact; later library renames are reflected in the download filename.
    const header = new Uint8Array(await stored.blob.slice(0, 2).arrayBuffer());
    const gzip = header[0] === 0x1f && header[1] === 0x8b;
    const mimeType = gzip ? 'application/gzip' : 'application/json';
    const encoded = {
      blob: stored.blob.slice(0, stored.blob.size, mimeType),
      format: gzip ? 'gzip' : 'json',
      extension: gzip ? '.json.gz' : '.json',
      mimeType,
      fallbackReason: ''
    };
    const name = `${kind === ROOM_SAVE_KIND ? '联机房间' : '个人存档'}-${entry.label || '存档'}`.replace(/[\\/:*?"<>|]/g, '_');
    const download = await downloadSaveFile(encoded.blob, `${name}${encoded.extension}`);
    return { ...encoded, cancelled: download.cancelled === true };
  }
}

export const localSaveLibrary = new LocalSaveLibrary();
