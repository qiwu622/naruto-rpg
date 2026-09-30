import { isNativeAndroidApp } from './runtime-platform.js';

const CHUNK_BYTES = 256 * 1024;

export function getNativeFilePlugin() {
  const bridge = globalThis.Capacitor;
  if (!isNativeAndroidApp()) return null;
  if (typeof bridge?.registerPlugin === 'function') return bridge.registerPlugin('NarutoFiles');
  return bridge?.Plugins?.NarutoFiles || null;
}

async function base64Chunk(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
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
