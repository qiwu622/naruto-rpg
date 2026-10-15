import { createSaveJsonByteStream, parseSaveJsonByteStream } from './save-json-stream.js';

export const PAYLOAD_CHUNK_STORE = 'timeline_payload_chunks';
export const SHARED_PAYLOAD_ENCODING = 'shared-json-v1';
const MIN_CHUNK = 2048, MAX_CHUNK = 32768, CACHE_BYTES = 8 * 1024 * 1024;
// Content-defined boundaries resynchronize after an inserted memory/event. A
// fixed byte offset would otherwise rewrite every following chunk each turn.
const gear = Uint32Array.from({ length: 256 }, (_, i) => {
  let x = (i + 1) * 2654435761;
  x ^= x >>> 16; x = Math.imul(x, 2246822507); x ^= x >>> 13;
  return x >>> 0;
});
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const hash = bytes => hex(globalThis.NarutoSaveCodec.sha256(bytes));

function byteCache() {
  const values = new Map(); let bytes = 0;
  return {
    get(id) { const item = values.get(id); if (item) { values.delete(id); values.set(id, item); } return item; },
    set(id, item) {
      bytes -= values.get(id)?.bytes.byteLength || 0;
      values.delete(id); values.set(id, item); bytes += item.bytes.byteLength;
      while ((bytes > CACHE_BYTES || values.size > 2048) && values.size) {
        const first = values.keys().next().value; bytes -= values.get(first).bytes.byteLength; values.delete(first);
      }
    }
  };
}
const encodedCache = byteCache();

export async function encodeSharedPayload(value, { signal } = {}) {
  const digest = globalThis.NarutoSaveCodec.sha256.create();
  const reader = createSaveJsonByteStream(value).getReader();
  const chunks = [], records = new Map();
  let buffer = new Uint8Array(MAX_CHUNK), used = 0, rolling = 0, byteLength = 0;
  let yieldedAt = performance.now();
  async function flush() {
    if (!used) return;
    const raw = buffer.slice(0, used), id = hash(raw);
    let record = encodedCache.get(id);
    if (!record) {
      let bytes = raw, encoding = 'raw';
      if (typeof CompressionStream === 'function') {
        const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        if (packed.byteLength < raw.byteLength) { bytes = packed; encoding = 'gzip'; }
      }
      record = { id, encoding, rawBytes: raw.byteLength, bytes };
      encodedCache.set(id, record);
    }
    records.set(id, record); chunks.push(id); used = 0; rolling = 0;
  }
  try {
    while (true) {
      signal?.throwIfAborted();
      const item = await reader.read(); if (item.done) break;
      digest.update(item.value); byteLength += item.value.byteLength;
      for (const b of item.value) {
        buffer[used++] = b; rolling = ((rolling << 1) + gear[b]) >>> 0;
        if (used === MAX_CHUNK || (used >= MIN_CHUNK && (rolling & 8191) === 0)) await flush();
      }
      if (performance.now() - yieldedAt > 16) {
        await new Promise(resolve => setTimeout(resolve, 0)); yieldedAt = performance.now();
      }
    }
    await flush();
    return { manifest: { chunks, byteLength, checksum: hex(digest.digest()) }, records: [...records.values()] };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); digest.destroy(); }
}

export function payloadChunkIds(node) {
  return node?.payload_encoding === SHARED_PAYLOAD_ENCODING && Array.isArray(node.payload?.chunks) ? node.payload.chunks : [];
}

// Include this store in the SAME transaction that publishes the node. Readers
// and garbage collection can never observe dangling references.
export function putPayloadChunks(tx, records = [], onError = () => tx.abort()) {
  if (!records.length) return;
  const store = tx.objectStore(PAYLOAD_CHUNK_STORE);
  for (const record of records) {
    const request = store.getKey(record.id);
    request.onsuccess = () => {
      try { if (request.result === undefined) store.add(record); } catch (error) { onError(error); }
    };
  }
}

const dbCaches = new WeakMap();
export async function decodeSharedPayload(manifest, { db, maxBytes, verifyStorage = false } = {}) {
  if (!db) throw new Error('缺少存档数据库，无法读取共享存档');
  if (!Array.isArray(manifest?.chunks) || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 0
      || !/^[a-f0-9]{64}$/.test(manifest.checksum || '')) throw new Error('共享存档目录损坏，原档仍保留');
  if (manifest.byteLength > maxBytes) throw new Error('单个回合状态过大，无法读取共享存档');
  let cache = dbCaches.get(db);
  if (!cache) { cache = byteCache(); dbCaches.set(db, cache); }
  const digest = globalThis.NarutoSaveCodec.sha256.create();
  let index = 0, total = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (index === manifest.chunks.length) {
          if (total !== manifest.byteLength || hex(digest.digest()) !== manifest.checksum) throw new Error('共享存档校验失败，请从保留的原档恢复');
          controller.close(); return;
        }
        const id = manifest.chunks[index++];
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('共享存档数据块编号无效');
        let cached = !verifyStorage && cache.get(id);
        if (!cached) {
          const record = await new Promise((resolve, reject) => {
            const tx = db.transaction(PAYLOAD_CHUNK_STORE), request = tx.objectStore(PAYLOAD_CHUNK_STORE).get(id);
            tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error);
          });
          if (!record || !['raw', 'gzip'].includes(record.encoding) || record.rawBytes > MAX_CHUNK) throw new Error('共享存档缺少数据块，请从保留的原档恢复');
          // Limit decompression before allocating: even corrupted chunks cannot
          // expand into an unbounded buffer.
          const source = record.encoding === 'gzip' ? new Blob([record.bytes]).stream().pipeThrough(new DecompressionStream('gzip')) : new Blob([record.bytes]).stream();
          const reader = source.getReader(), parts = []; let length = 0;
          try {
            while (true) {
              const item = await reader.read(); if (item.done) break;
              length += item.value.byteLength;
              if (length > MAX_CHUNK) throw new Error('共享存档数据块超过读取上限');
              parts.push(item.value);
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          const bytes = new Uint8Array(length); let offset = 0;
          for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
          if (length !== record.rawBytes || hash(bytes) !== id) throw new Error('共享存档数据块校验失败，请从保留的原档恢复');
          cached = { bytes }; cache.set(id, cached);
        }
        total += cached.bytes.byteLength;
        if (total > manifest.byteLength) throw new Error('共享存档长度不一致');
        digest.update(cached.bytes); controller.enqueue(cached.bytes);
      } catch (error) { controller.error(error); }
    }
  });
  try { return await parseSaveJsonByteStream(stream, { maxBytes }); }
  finally { digest.destroy(); }
}
