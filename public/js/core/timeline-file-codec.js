import { createSaveJsonByteStream, parseSaveJsonByteStream } from './save-json-stream.js';

// Local imports must accept the complete archives this app can export. Cloud
// quotas are enforced by the cloud API; callers may still opt into a byte cap.
export const DEFAULT_MAX_DECOMPRESSED_BYTES = Infinity;
export const TIMELINE_FILE_ACCEPT = 'application/json,application/gzip,application/x-gzip,.json,.json.gz,.gz';

const JSON_MIME_TYPE = 'application/json';
const GZIP_MIME_TYPE = 'application/gzip';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${Math.ceil(bytes / 1024 / 1024)} MiB`;
}

function assertCompressionMode(compression) {
  if (!['auto', 'gzip', 'json'].includes(compression)) {
    throw new Error(`不支持的存档压缩格式: ${compression}`);
  }
}

async function jsonResult(data, fallbackReason = '') {
  const blob = await new Response(createSaveJsonByteStream(data), {
    headers: { 'Content-Type': JSON_MIME_TYPE }
  }).blob();
  return {
    blob,
    format: 'json',
    extension: '.json',
    mimeType: JSON_MIME_TYPE,
    fallbackReason
  };
}

async function gzipResult(data) {
  if (typeof globalThis.CompressionStream !== 'function') {
    throw new Error('当前浏览器缺少 CompressionStream，无法压缩 gzip 存档');
  }
  const compressedStream = createSaveJsonByteStream(data).pipeThrough(new CompressionStream('gzip'));
  const compressed = await new Response(compressedStream).blob();
  return {
    blob: new Blob([compressed], { type: GZIP_MIME_TYPE }),
    format: 'gzip',
    extension: '.json.gz',
    mimeType: GZIP_MIME_TYPE,
    fallbackReason: ''
  };
}

export async function encodeTimelineSave(data, { compression = 'auto' } = {}) {
  assertCompressionMode(compression);
  if (compression === 'json') return jsonResult(data);

  try {
    return await gzipResult(data);
  } catch (error) {
    if (compression === 'gzip') throw error;
    return jsonResult(data, `gzip 压缩不可用: ${error?.message || '未知错误'}`);
  }
}

function normalizeFile(file) {
  if (file instanceof Blob) return file;
  if (file instanceof ArrayBuffer) return new Blob([file]);
  if (ArrayBuffer.isView(file)) {
    return new Blob([file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)]);
  }
  throw new Error('存档文件无效: 请选择 .json、.json.gz 或 .gz 文件');
}

function assertReadLimit(maxDecompressedBytes) {
  if (maxDecompressedBytes === Infinity) return;
  if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes <= 0) {
    throw new Error('存档解压上限必须是正整数或 Infinity');
  }
}

function limitError(maxDecompressedBytes) {
  return new Error(`存档解压后超过 ${formatBytes(maxDecompressedBytes)} 上限，已停止导入`);
}

export async function decodeTimelineSaveFile(file, {
  maxDecompressedBytes = DEFAULT_MAX_DECOMPRESSED_BYTES
} = {}) {
  assertReadLimit(maxDecompressedBytes);
  const blob = normalizeFile(file);
  const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzip = header.length === 2 && header[0] === 0x1f && header[1] === 0x8b;
  if (!gzip && blob.size > maxDecompressedBytes) throw limitError(maxDecompressedBytes);
  if (gzip && typeof globalThis.DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持 gzip 导入: 缺少 DecompressionStream，请改用普通 JSON 存档');
  }
  try {
    const stream = gzip ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob.stream();
    return await parseSaveJsonByteStream(stream, {
      maxBytes: maxDecompressedBytes, limitError: () => limitError(maxDecompressedBytes)
    });
  } catch (error) {
    if (String(error?.message || '').includes('上限')) throw error;
    const message = gzip ? 'gzip 存档损坏、解压或 JSON 解析失败' : '存档 JSON 解析失败';
    throw new Error(`${message}: ${error?.message || '文件内容无效'}`, { cause: error });
  }
}
