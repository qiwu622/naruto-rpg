import { decodeTimelineSaveFile, encodeTimelineSave } from './timeline-file-codec.js';
import { exportFile } from './file-export.js';

export const SAVE_PACKAGE_SCHEMA = 'naruto.save-package/v1';
export const PERSONAL_SAVE_KIND = 'personal_timeline';
export const ROOM_SAVE_KIND = 'multiplayer_room';
const KINDS = new Set([PERSONAL_SAVE_KIND, ROOM_SAVE_KIND]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_KEYS = /^(?:_api|api_config|apiConfig|apiKey|api_key|access_token|refresh_token|authorization|csrf_token|invite_token|password|credential_secret)$/i;

// Files contain game data only. Connection settings and login credentials are
// owned by their existing stores and must never become portable save data.
export function cleanSaveData(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (UNSAFE_KEYS.has(key)) throw new Error('存档包含不安全字段');
    return SECRET_KEYS.test(key) ? undefined : item;
  }));
}

export async function saveChecksum(payload) {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持存档完整性校验，请使用 HTTPS 或 localhost');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
  if (JSON.stringify(cleanSaveData(value.payload)) !== JSON.stringify(value.payload)) {
    throw new Error('存档混入连接凭证，请重新导出');
  }
  return value;
}

export const downloadSaveFile = exportFile;

function storageError(error) {
  return new Error(error?.name === 'QuotaExceededError'
    ? '本地空间不足，保存未完成。请先导出或清理旧档，当前进度仍保留。'
    : `本地存档操作失败：${error?.message || '浏览器存储不可用'}`, { cause: error });
}

/** Separate database: resetting the working timeline never clears the library. */
export class LocalSaveLibrary {
  constructor({ indexedDB = globalThis.indexedDB, name = 'naruto_rpg_save_library' } = {}) {
    this.indexedDB = indexedDB;
    this.name = name;
    this._opening = null;
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
    return (await this._read('entries')).filter(entry => entry.kind === kind && entry.owner === owner)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id, kind, owner = 'device') {
    const entry = await this._read('entries', id);
    if (!entry || entry.kind !== kind || entry.owner !== owner) throw new Error('找不到当前账号的这份存档');
    return entry;
  }

  async readPackage(id, kind, owner = 'device') {
    await this.get(id, kind, owner);
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
    return this.put({ ...entry, label: name });
  }

  async remove(id, kind, owner = 'device') {
    await this.get(id, kind, owner);
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
    const pack = await this.readPackage(id, kind, owner);
    const encoded = await encodeTimelineSave({ ...pack, label: entry.label });
    const name = `${kind === ROOM_SAVE_KIND ? '联机房间' : '个人存档'}-${entry.label || '存档'}`.replace(/[\\/:*?"<>|]/g, '_');
    const download = await downloadSaveFile(encoded.blob, `${name}${encoded.extension}`);
    return { ...encoded, cancelled: download.cancelled === true };
  }
}

export const localSaveLibrary = new LocalSaveLibrary();
