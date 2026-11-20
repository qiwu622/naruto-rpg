import { isNativeAndroidApp } from './runtime-platform.js';
import { bytesToBase64 } from './file-export.js';
import { timelineStorageTask } from './timeline-storage-client.js';

const AUTO_BACKUP_PREF_KEY = 'naruto_external_auto_backup';
const PREF_DB_NAME = 'naruto_rpg_external_backup';
const PREF_STORE = 'handles';
const WEB_DIR_KEY = 'backup_dir_handle';
const CHUNK_BYTES = 256 * 1024;
const AUTO_COOLDOWN_MS = 30 * 1000;

let lastAutoBackupAt = 0;
let autoBackupTimer = null;
let autoBackupRunning = false;

export function getVaultPlugin() {
  const bridge = globalThis.Capacitor;
  if (!isNativeAndroidApp()) return null;
  if (typeof bridge?.registerPlugin === 'function') return bridge.registerPlugin('NarutoVault');
  return bridge?.Plugins?.NarutoVault || null;
}

function openPrefDB() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('浏览器不支持本地目录记忆')); return; }
    const req = globalThis.indexedDB.open(PREF_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PREF_STORE)) req.result.createObjectStore(PREF_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法读取备份目录设置'));
  });
}

async function getSavedWebDirHandle() {
  if (typeof globalThis.showDirectoryPicker !== 'function') return null;
  let db;
  try {
    db = await openPrefDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PREF_STORE, 'readonly');
      const req = tx.objectStore(PREF_STORE).get(WEB_DIR_KEY);
      tx.oncomplete = () => resolve(req.result || null);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function saveWebDirHandle(handle) {
  let db;
  try {
    db = await openPrefDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PREF_STORE, 'readwrite');
      if (handle) tx.objectStore(PREF_STORE).put(handle, WEB_DIR_KEY);
      else tx.objectStore(PREF_STORE).delete(WEB_DIR_KEY);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db?.close();
  }
}

async function ensureDirPermission(handle, promptIfNeeded = false) {
  if (!handle) return false;
  try {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission?.(opts)) === 'granted') return true;
    if (!promptIfNeeded) return false;
    return (await handle.requestPermission?.(opts)) === 'granted';
  } catch {
    return false;
  }
}

export function isAutoBackupEnabledSync() {
  try {
    const raw = globalThis.localStorage?.getItem(AUTO_BACKUP_PREF_KEY);
    return raw == null ? isNativeAndroidApp() : raw === 'true';
  } catch {
    return isNativeAndroidApp();
  }
}

export async function getExternalBackupStatus() {
  const vault = getVaultPlugin();
  if (vault) {
    const config = await vault.getConfig().catch(() => ({}));
    return {
      supported: true,
      mode: 'android-vault',
      autoEnabled: config?.autoEnabled !== false,
      defaultPath: config?.defaultPath || 'Documents/NarutoRPG/Saves',
      customDirectoryLabel: config?.customDirectoryLabel || '',
      backupCount: Number(config?.backupCount) || 0,
      latestBackup: config?.latestBackup || null
    };
  }
  if (typeof globalThis.showDirectoryPicker === 'function') {
    const handle = await getSavedWebDirHandle();
    const granted = handle ? await ensureDirPermission(handle, false) : false;
    return {
      supported: true,
      mode: 'web-directory',
      autoEnabled: isAutoBackupEnabledSync() && Boolean(handle),
      defaultPath: '未选择本机备份文件夹',
      customDirectoryLabel: handle ? `${handle.name}${granted ? '' : '（需重新授权）'}` : '',
      hasHandle: Boolean(handle),
      granted,
      backupCount: 0,
      latestBackup: null
    };
  }
  return {
    supported: false,
    mode: 'unsupported',
    autoEnabled: false,
    defaultPath: '',
    customDirectoryLabel: '',
    backupCount: 0,
    latestBackup: null
  };
}

export async function setAutoBackupEnabled(enabled) {
  const flag = Boolean(enabled);
  try { globalThis.localStorage?.setItem(AUTO_BACKUP_PREF_KEY, String(flag)); } catch {}
  const vault = getVaultPlugin();
  if (vault && typeof vault.setAutoBackup === 'function') {
    return vault.setAutoBackup({ enabled: flag });
  }
  return { autoEnabled: flag };
}

export async function chooseBackupDirectory() {
  const vault = getVaultPlugin();
  if (vault) {
    return vault.chooseBackupDirectory();
  }
  if (typeof globalThis.showDirectoryPicker !== 'function') {
    throw new Error('当前浏览器不支持选择本机备份文件夹，请使用导出功能备份文件');
  }
  const handle = await globalThis.showDirectoryPicker({ mode: 'readwrite', id: 'naruto-rpg-backups' });
  const ok = await ensureDirPermission(handle, true);
  if (!ok) throw new Error('未获得文件夹写入权限');
  await saveWebDirHandle(handle);
  return { cancelled: false, label: handle.name };
}

export async function clearBackupDirectory() {
  const vault = getVaultPlugin();
  if (vault) return vault.clearBackupDirectory();
  await saveWebDirHandle(null);
  return { cleared: true };
}

async function rotateWebAutoBackups(dirHandle, keep = 3) {
  const autos = [];
  for await (const [name] of dirHandle.entries()) {
    if (name.startsWith('auto-') && name.endsWith('.json.gz')) autos.push(name);
  }
  autos.sort().reverse();
  for (const stale of autos.slice(keep)) {
    await dirHandle.removeEntry(stale).catch(() => {});
  }
}

export async function backupCurrentToExternal({
  reason = 'manual',
  formatVersion = 2,
  onProgress = () => {},
  signal = null,
  promptPermission = reason === 'manual'
} = {}) {
  const kind = reason === 'auto' ? 'auto' : 'manual';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `${kind}-naruto-save-${ts}.v2.json.gz`;
  const vault = getVaultPlugin();

  if (vault) {
    const started = await vault.beginBackup({
      kind,
      fileName,
      mimeType: 'application/gzip'
    });
    const backupId = started?.id;
    if (!backupId) throw new Error('无法开启外部备份会话');
    let pending = new Uint8Array(0);
    const flushChunk = async chunk => {
      const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
      merged.set(pending);
      merged.set(chunk, pending.byteLength);
      let offset = 0;
      while (merged.byteLength - offset >= CHUNK_BYTES) {
        await vault.appendBackup({ id: backupId, data: await bytesToBase64(merged.subarray(offset, offset + CHUNK_BYTES)) });
        offset += CHUNK_BYTES;
      }
      pending = merged.slice(offset);
    };
    let finished = false;
    try {
      const exported = await timelineStorageTask(
        'export-current',
        { payloadOnly: false, compression: 'gzip', formatVersion, streamExportChunks: true },
        {
          onProgress,
          signal,
          onStreamChunk: flushChunk,
          onStreamEnd: async () => {
            if (pending.byteLength) {
              await vault.appendBackup({ id: backupId, data: await bytesToBase64(pending) });
              pending = new Uint8Array(0);
            }
          }
        }
      );
      const saved = await vault.finishBackup({
        id: backupId,
        turn: exported?.current?.turn_number ?? 0,
        character: exported?.current?.state_snapshot?.['玩家·姓名'] || ''
      });
      finished = true;
      return { ...saved, fileName, mode: 'android-vault' };
    } finally {
      if (!finished) await vault.cancelBackup?.({ id: backupId }).catch(() => {});
    }
  }

  const handle = await getSavedWebDirHandle();
  if (!handle) {
    if (reason === 'auto') return { skipped: true, reason: 'no-directory' };
    throw new Error('请先选择一个本机备份文件夹');
  }
  const permitted = await ensureDirPermission(handle, promptPermission);
  if (!permitted) {
    if (reason === 'auto') return { skipped: true, reason: 'permission-needed' };
    throw new Error('未获得文件夹写入权限，请重新选择备份文件夹');
  }

  const fileHandle = await handle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  let committed = false;
  try {
    const exported = await timelineStorageTask(
      'export-current',
      { payloadOnly: false, compression: 'gzip', formatVersion, streamExportChunks: true },
      {
        onProgress,
        signal,
        onStreamChunk: async chunk => { await writable.write(chunk); },
        onStreamEnd: async () => { await writable.close(); committed = true; }
      }
    );
    if (kind === 'auto') await rotateWebAutoBackups(handle, 3);
    return {
      fileName,
      bytes: exported?.byteLength || 0,
      turn: exported?.current?.turn_number ?? 0,
      mode: 'web-directory'
    };
  } catch (err) {
    if (!committed) await writable.abort().catch(() => {});
    throw err;
  }
}

export function scheduleAutoExternalBackup() {
  if (!isAutoBackupEnabledSync()) return;
  if (autoBackupTimer) clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(async () => {
    autoBackupTimer = null;
    if (autoBackupRunning) return;
    if (Date.now() - lastAutoBackupAt < AUTO_COOLDOWN_MS) return;
    autoBackupRunning = true;
    try {
      await backupCurrentToExternal({ reason: 'auto', promptPermission: false });
      lastAutoBackupAt = Date.now();
    } catch (error) {
      console.warn('[ExternalBackup] 自动外部备份跳过:', error?.message || error);
    } finally {
      autoBackupRunning = false;
    }
  }, 3500);
}

export async function listNativeBackups() {
  const vault = getVaultPlugin();
  if (!vault) return [];
  const res = await vault.listBackups();
  return Array.isArray(res?.backups) ? res.backups : [];
}

export async function exportNativeBackup(id) {
  const vault = getVaultPlugin();
  if (!vault) throw new Error('仅 Android App 支持原生保险箱导出');
  return vault.exportBackup({ id });
}

export async function restoreNativeBackup(id, { onProgress = () => {}, signal } = {}) {
  const vault = getVaultPlugin();
  if (!vault) throw new Error('仅 Android App 支持原生保险箱恢复');
  const backups = await listNativeBackups();
  const target = backups.find(item => item.id === id);
  if (!target) throw new Error('找不到指定的外部保险箱备份');
  const totalBytes = Number(target.bytes) || 0;
  const parts = [];
  let offset = 0;
  onProgress('正在读取外部保险箱备份…');
  while (offset < totalBytes || totalBytes === 0) {
    signal?.throwIfAborted?.();
    const res = await vault.readBackupChunk({ id, offset, length: CHUNK_BYTES });
    const data = res?.data;
    if (!data) break;
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    parts.push(bytes);
    offset += bytes.byteLength;
    if (res?.eof || bytes.byteLength < CHUNK_BYTES) break;
  }
  const file = new Blob(parts, { type: target.mimeType || 'application/gzip' });
  const imported = await timelineStorageTask('import-stream', { file, label: target.fileName, reason: 'vault-restore' }, { onProgress, signal });
  const { current } = await timelineStorageTask('restore', { id: imported.id }, { onProgress, signal });
  return { imported, current };
}

export async function exportEmergencyBundle() {
  const vault = getVaultPlugin();
  if (!vault) throw new Error('仅 Android App 支持系统级急救压缩包导出');
  return vault.exportEmergencyBundle();
}
