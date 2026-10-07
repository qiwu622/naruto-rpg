export const DEFAULT_MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;
export const TIMELINE_FILE_ACCEPT = 'application/json,application/gzip,application/x-gzip,.json,.json.gz,.gz';

const JSON_MIME_TYPE = 'application/json';
const GZIP_MIME_TYPE = 'application/gzip';
const ENCODE_CHUNK_CHARACTERS = 256 * 1024;

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

function *serializeTimelineChunks(data, visiting = new WeakSet()) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.toJSON === 'function'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(data))) {
    const text = JSON.stringify(data);
    if (text === undefined) throw new Error('存档没有可序列化的内容');
    yield text;
    return;
  }
  if (visiting.has(data)) throw new Error('存档包含循环引用，无法导出');
  visiting.add(data);
  yield '{';
  let wroteField = false;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
    if (wroteField) yield ',';
    wroteField = true;
    yield `${JSON.stringify(key)}:`;
    if (!Array.isArray(value)) {
      // Save packages wrap the timeline in `payload`. Traverse that object too,
      // rather than creating a second giant string of its entire node history.
      yield* serializeTimelineChunks(value, visiting);
      continue;
    }
    yield '[';
    for (let index = 0; index < value.length; index++) {
      if (index > 0) yield ',';
      const text = JSON.stringify(value[index]);
      yield text === undefined ? 'null' : text;
    }
    yield ']';
  }
  yield '}';
  visiting.delete(data);
}

function createUtf8Stream(data) {
  const encoder = new TextEncoder();
  const chunks = serializeTimelineChunks(data);
  let pending = '';
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      while (offset >= pending.length) {
        const next = chunks.next();
        if (next.done) {
          controller.close();
          return;
        }
        pending = next.value;
        offset = 0;
      }
      let end = Math.min(pending.length, offset + ENCODE_CHUNK_CHARACTERS);
      const lastCodeUnit = pending.charCodeAt(end - 1);
      if (end < pending.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
      controller.enqueue(encoder.encode(pending.slice(offset, end)));
      offset = end;
    }
  });
}

async function jsonResult(data, fallbackReason = '') {
  const blob = await new Response(createUtf8Stream(data), {
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
  const compressedStream = createUtf8Stream(data).pipeThrough(new CompressionStream('gzip'));
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
  if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes <= 0) {
    throw new Error('存档解压上限必须是正整数');
  }
}

function limitError(maxDecompressedBytes) {
  return new Error(`存档解压后超过 ${formatBytes(maxDecompressedBytes)} 上限，已停止导入`);
}

async function decodeUtf8Stream(stream, maxDecompressedBytes) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value?.byteLength || 0;
      if (totalBytes > maxDecompressedBytes) {
        await reader.cancel('timeline save exceeds configured limit');
        throw limitError(maxDecompressedBytes);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

async function readJsonText(blob, maxDecompressedBytes) {
  if (blob.size > maxDecompressedBytes) throw limitError(maxDecompressedBytes);
  return decodeUtf8Stream(blob.stream(), maxDecompressedBytes);
}

async function readGzipText(blob, maxDecompressedBytes) {
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持 gzip 导入: 缺少 DecompressionStream，请改用普通 JSON 存档');
  }
  try {
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    return await decodeUtf8Stream(stream, maxDecompressedBytes);
  } catch (error) {
    if (String(error?.message || '').includes('上限')) throw error;
    throw new Error(`gzip 存档损坏或解压失败: ${error?.message || '文件内容无效'}`);
  }
}

export async function decodeTimelineSaveFile(file, {
  maxDecompressedBytes = DEFAULT_MAX_DECOMPRESSED_BYTES
} = {}) {
  assertReadLimit(maxDecompressedBytes);
  const blob = normalizeFile(file);
  const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzip = header.length === 2 && header[0] === 0x1f && header[1] === 0x8b;
  const text = gzip
    ? await readGzipText(blob, maxDecompressedBytes)
    : await readJsonText(blob, maxDecompressedBytes);
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`存档 JSON 解析失败: ${error?.message || '文件内容无效'}`);
  }
}
