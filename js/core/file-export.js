import { isNativeAndroidApp } from './runtime-platform.js';
import { timelineStorageTask } from './timeline-storage-client.js';

const CHUNK_BYTES = 256 * 1024;

export function getNativeFilePlugin() {
  const bridge = globalThis.Capacitor;
  if (!isNativeAndroidApp()) return null;
  if (typeof bridge?.registerPlugin === 'function') return bridge.registerPlugin('NarutoFiles');
  return bridge?.Plugins?.NarutoFiles || null;
}

export async function bytesToBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

async function base64Chunk(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function canStreamExportDirect({ useFilePicker = false } = {}) {
  const plugin = getNativeFilePlugin();
  if (isNativeAndroidApp() && plugin && typeof plugin.beginStreamSave === 'function') return true;
  if (useFilePicker && !isNativeAndroidApp() && typeof globalThis.showSaveFilePicker === 'function') return true;
  return false;
}

/**
 * Streams a Worker archive export directly into native Android SAF (via NarutoFiles)
 * or (when opted-in via useFilePicker) Desktop Web File System Access writable stream.
 */
export async function exportStreamFromWorker({
  action = 'export',
  options = {},
  fileName,
  useFilePicker = false,
  onProgress = () => {},
  signal = null
} = {}) {
  const gzip = options?.compression !== 'json' && typeof CompressionStream === 'function';
  const extension = gzip ? '.json.gz' : '.json';
  const format = gzip ? 'gzip' : 'json';
  const mimeType = gzip ? 'application/gzip' : 'application/json';
  const resolvedName = fileName.endsWith(extension) ? fileName : `${fileName}${extension}`;
  const plugin = getNativeFilePlugin();

  if (isNativeAndroidApp() && plugin && typeof plugin.beginStreamSave === 'function') {
    const started = await plugin.beginStreamSave({ fileName: resolvedName, mimeType });
    if (started?.cancelled) return { cancelled: true, fileName: resolvedName, extension, format, mimeType };
    const id = started?.id;
    if (!id) throw new Error('未能开启本机导出会话');
    let pending = new Uint8Array(0);
    const flushChunk = async chunk => {
      const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
      merged.set(pending);
      merged.set(chunk, pending.byteLength);
      let offset = 0;
      while (merged.byteLength - offset >= CHUNK_BYTES) {
        const slice = merged.subarray(offset, offset + CHUNK_BYTES);
        await plugin.appendStreamSave({ id, data: await bytesToBase64(slice) });
        offset += CHUNK_BYTES;
      }
      pending = merged.slice(offset);
    };
    try {
      const result = await timelineStorageTask(action, { ...options, streamExportChunks: true }, {
        onProgress,
        signal,
        onStreamChunk: flushChunk,
        onStreamEnd: async () => {
          if (pending.byteLength) {
            await plugin.appendStreamSave({ id, data: await bytesToBase64(pending) });
            pending = new Uint8Array(0);
          }
          await plugin.finishStreamSave({ id });
        }
      });
      return { ...result, cancelled: false, fileName: resolvedName, extension, format, mimeType };
    } finally {
      await plugin.cancelSave?.({ id }).catch(() => {});
    }
  }

  if (useFilePicker && !isNativeAndroidApp() && typeof globalThis.showSaveFilePicker === 'function') {
    let handle;
    try {
      handle = await globalThis.showSaveFilePicker({ suggestedName: resolvedName });
    } catch (err) {
      if (err?.name === 'AbortError') return { cancelled: true, fileName: resolvedName, extension, format, mimeType };
      throw err;
    }
    const writable = await handle.createWritable();
    let aborted = false;
    try {
      const result = await timelineStorageTask(action, { ...options, streamExportChunks: true }, {
        onProgress,
        signal,
        onStreamChunk: async chunk => { await writable.write(chunk); },
        onStreamEnd: async () => { await writable.close(); }
      });
      return { ...result, cancelled: false, fileName: resolvedName, extension, format, mimeType };
    } catch (err) {
      aborted = true;
      await writable.abort().catch(() => {});
      throw err;
    } finally {
      if (!aborted) await writable.close?.().catch(() => {});
    }
  }

  const encoded = await timelineStorageTask(action, options, { onProgress, signal });
  const download = await exportFile(encoded.blob, fileName.endsWith(encoded.extension) ? fileName : `${fileName}${encoded.extension}`);
  return { ...encoded, cancelled: download.cancelled === true, fileName: download.fileName || resolvedName };
}

/** A native export resolves only after the chosen document is fully written. */
export async function exportFile(blob, fileName) {
  if (isNativeAndroidApp()) {
    const plugin = getNativeFilePlugin();
    if (!plugin) throw new Error('当前安装包缺少文件保存功能，请更新 App');
    const { id } = await plugin.beginSave({ fileName, mimeType: blob.type || 'application/octet-stream', size: blob.size });
    try {
      for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
        const data = await base64Chunk(blob.slice(offset, offset + CHUNK_BYTES));
        await plugin.appendSave({ id, offset, data });
      }
      return await plugin.finishSave({ id });
    } finally {
      await plugin.cancelSave({ id }).catch(() => {});
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body?.appendChild(link);
  link.click();
  link.remove?.();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { cancelled: false, fileName };
}

export async function openAndroidDownload(url) {
  const plugin = getNativeFilePlugin();
  if (!plugin) throw new Error('当前安装包缺少外部下载功能，请更新 App');
  await plugin.openDownload({ url });
  return true;
}
