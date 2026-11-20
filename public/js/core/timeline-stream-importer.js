import { readDB } from './timeline-db.js';
import {
  cleanSaveData,
  PERSONAL_SAVE_KIND,
  SAVE_PACKAGE_SCHEMA,
  SAVE_PACKAGE_SCHEMA_V2
} from './save-library.js';
import { checksumSaveJson, streamParseSaveJson } from './save-json-stream.js';
import {
  assertTimelineSave,
  inspectTimelineNodeContent,
  sanitizeTimelineNode,
  sanitizeTimelinePersistenceValue
} from './timeline-save-schema.js';
import { decompressTimelineNode, estimateTimelineNodeBytes, isCompressedTimelineNode, prepareSharedTimelineNode } from './timeline-node-codec.js';
import { PAYLOAD_CHUNK_STORE, putPayloadChunks, SHARED_PAYLOAD_ENCODING } from './timeline-payload-chunks.js';
import { continuationSaveScope } from './continuation-save.js';

const PACKAGE_SCHEMAS = new Set([SAVE_PACKAGE_SCHEMA, SAVE_PACKAGE_SCHEMA_V2]);
const SECRET_KEYS = /^(?:_api|api_config|apiConfig|apiKey|api_key|access_token|refresh_token|authorization|csrf_token|invite_token|password|credential_secret)$/i;
const PERSONAL_MULTIPLAYER_TIMELINE_SCHEMA = 'naruto.multiplayer-personal-timeline/v1';
const MULTIPLAYER_TO_SINGLEPLAYER_CODEC = 'naruto.multiplayer-to-singleplayer/v1';
const MULTIPLAYER_RECORD_SIDECAR_SCHEMA = 'naruto.multiplayer-record-sidecar/v1';
const SERVER_REIMPORT_CAPSULE_SCHEMA = 'naruto.multiplayer-server-reimport-capsule/v1';
const NON_AGENT_MULTIPLAYER_META_FIELD = '_multiplayer_non_agent_metadata';
const CHUNK_BATCH_LIMIT = 24;
const NODE_BATCH_LIMIT = 16;

const cancelled = () => new DOMException('已取消，原存档保留', 'AbortError');

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function decodeBase64Bytes(base64) {
  if (typeof base64 !== 'string') throw new Error('共享数据块格式无效');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hexSha256(bytes) {
  return Array.from(globalThis.NarutoSaveCodec.sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

async function isGzipBlob(blob) {
  const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b;
}

function migrateNodeV1ToV2(node, index) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const migrated = { ...node };
  delete migrated.memory_snapshot;
  if (Array.isArray(migrated.chat_history) && migrated.chat_history.length > 0 && !migrated.chat_history_delta) {
    migrated.chat_history_delta = structuredClone(migrated.chat_history.slice(-2));
  }
  if (migrated.archived === undefined) migrated.archived = false;
  if (migrated.archived_at === undefined) migrated.archived_at = null;
  if (migrated.continuity_delta === undefined) migrated.continuity_delta = [];
  if (migrated.continuity_revision === undefined
    && Number.isInteger(migrated.state_snapshot?._continuity?.revision)) {
    migrated.continuity_revision = migrated.state_snapshot._continuity.revision;
  }
  const clean = sanitizeTimelinePersistenceValue(migrated, `timeline_node.${migrated.id || 'unknown'}`);
  return {
    ...clean,
    parent_id: clean.parent_id ?? null,
    turn_number: Number.isInteger(clean.turn_number) ? clean.turn_number : index,
    children_ids: Array.isArray(clean.children_ids)
      ? [...clean.children_ids]
      : (clean.children_ids == null ? [] : clean.children_ids)
  };
}

function assertMultiplayerSidecarHeader(header) {
  const fields = ['schema', 'codec', 'multiplayer_export', 'multiplayer_record_sidecar'];
  const presentFlags = ['multiplayer_export', 'multiplayer_record_sidecar']
    .some(field => Object.prototype.hasOwnProperty.call(header, field));
  if (!presentFlags) return null;
  const present = fields.filter(field => Object.prototype.hasOwnProperty.call(header, field));
  if (present.length !== fields.length
    || header.schema !== PERSONAL_MULTIPLAYER_TIMELINE_SCHEMA
    || header.codec !== MULTIPLAYER_TO_SINGLEPLAYER_CODEC
    || !isPlainRecord(header.multiplayer_export)
    || !isPlainRecord(header.multiplayer_record_sidecar)) {
    throw new Error('联机个人存档的 non-Agent 元数据不完整');
  }
  const sidecar = header.multiplayer_record_sidecar;
  const capsule = sidecar.server_reimport_capsule;
  if (sidecar.schema !== MULTIPLAYER_RECORD_SIDECAR_SCHEMA
    || sidecar.inject_to_agent !== false
    || sidecar.counterpart_private_pov_included !== false
    || !Array.isArray(sidecar.actor_bindings)
    || sidecar.actor_bindings.length !== 2
    || !Array.isArray(sidecar.multiplayer_records)
    || !isPlainRecord(capsule)
    || capsule.schema !== SERVER_REIMPORT_CAPSULE_SCHEMA
    || capsule.inject_to_agent !== false) {
    throw new Error('联机个人存档的 sidecar 不是可隔离的 non-Agent 元数据');
  }
  if (sidecar.actor_bindings.some(b => !isPlainRecord(b) || b.inject_to_agent !== false || typeof b.opaque_binding_token !== 'string' || !b.opaque_binding_token)
    || sidecar.multiplayer_records.some(r => !isPlainRecord(r) || r.inject_to_agent !== false)) {
    throw new Error('联机个人存档包含可注入 Agent 的 sidecar 条目');
  }
  return sanitizeTimelinePersistenceValue({
    schema: header.schema,
    codec: header.codec,
    multiplayer_export: header.multiplayer_export,
    multiplayer_record_sidecar: sidecar
  }, 'timeline_non_agent_multiplayer_metadata');
}

function canonicalNodeDigestSource(node) {
  const {
    payload,
    payload_encoding,
    payload_bytes,
    payload_location,
    payload_has_chat_history,
    memory_snapshot,
    chat_history,
    exported_at,
    ...rest
  } = node || {};
  if (Array.isArray(chat_history) && chat_history.length > 0) rest.chat_history = chat_history;
  return rest;
}

function validateStreamedNode(node, continuityEventOwners, multiplayerTokens = []) {
  const id = node?.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('存档格式无效: 时间线节点缺少有效 ID');
  if (multiplayerTokens.length) {
    const serialized = JSON.stringify(node);
    if (multiplayerTokens.some(token => serialized.includes(token))) {
      throw new Error('联机角色绑定 token 不能进入 Agent 可见时间线');
    }
  }
  const errors = inspectTimelineNodeContent(node, continuityEventOwners);
  if (errors.length) {
    throw new Error(`存档格式无效: ${errors.slice(0, 4).join('; ')}`);
  }
}

function writeStageBatch(db, { chunks = [], archiveNodes = [], entry = null }, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  if (!chunks.length && !archiveNodes.length && !entry) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stores = ['timeline_archives', 'timeline_archive_nodes', PAYLOAD_CHUNK_STORE];
    const tx = db.transaction(stores, 'readwrite');
    let failure;
    const abort = () => { failure = cancelled(); try { tx.abort(); } catch {} };
    const fail = error => { failure = error; try { tx.abort(); } catch {} };
    signal?.addEventListener('abort', abort, { once: true });
    tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(); };
    tx.onabort = () => {
      signal?.removeEventListener('abort', abort);
      const err = failure || tx.error;
      reject(signal?.aborted ? cancelled() : err?.name === 'QuotaExceededError'
        ? new Error('本地空间不足，保存未完成。请先导出或清理旧档，当前进度仍保留。')
        : err || new Error('流式导入写入失败'));
    };
    tx.onerror = () => {};
    try {
      if (chunks.length) putPayloadChunks(tx, chunks, fail);
      if (archiveNodes.length) {
        const nodeStore = tx.objectStore('timeline_archive_nodes');
        for (const record of archiveNodes) nodeStore.put(record);
      }
      if (entry) tx.objectStore('timeline_archives').put(entry);
    } catch (error) {
      fail(error);
    }
  });
}

async function rollbackStagedArchive(db, archiveId) {
  if (!db || !archiveId) return;
  await new Promise(resolve => {
    try {
      const tx = db.transaction(['timeline_archives', 'timeline_archive_nodes'], 'readwrite');
      tx.objectStore('timeline_archives').delete(archiveId);
      const req = tx.objectStore('timeline_archive_nodes').index('archiveId').openCursor(IDBKeyRange.only(archiveId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function decodeV2ChunkRecord(id, rawChunk) {
  let bytes;
  let encoding = 'gzip';
  let rawBytes = 0;
  if (typeof rawChunk === 'string') {
    bytes = decodeBase64Bytes(rawChunk);
    const inflated = typeof DecompressionStream === 'function'
      ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
      : bytes;
    rawBytes = inflated.byteLength;
    if (hexSha256(inflated) !== id) throw new Error(`共享数据块校验失败: ${id}`);
  } else if (isPlainRecord(rawChunk) && typeof rawChunk.data === 'string' && ['raw', 'gzip'].includes(rawChunk.encoding)) {
    bytes = decodeBase64Bytes(rawChunk.data);
    encoding = rawChunk.encoding;
    rawBytes = Number(rawChunk.rawBytes);
    const inflated = encoding === 'gzip'
      ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
      : bytes;
    if (inflated.byteLength !== rawBytes || hexSha256(inflated) !== id) {
      throw new Error(`共享数据块校验失败: ${id}`);
    }
  } else {
    throw new Error('共享数据块结构无效');
  }
  return { id, encoding, rawBytes, bytes };
}

export async function importTimelineArchiveStream(db, file, {
  label = '',
  reason = 'import',
  maxDecompressedBytes = Infinity,
  onProgress = () => {},
  signal = null
} = {}) {
  if (!(file instanceof Blob)) throw new Error('请选择有效的本地存档文件');
  if (!db) throw new Error('缺少存档数据库');

  const gzipped = await isGzipBlob(file);
  if (gzipped && typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器缺少 DecompressionStream，无法解压此存档');
  }

  const archiveId = `archive:${crypto.randomUUID()}`;
  const now = Date.now();
  let placeholderWritten = false;
  let abortedForRoomPackage = false;

  const pkg = {};
  const header = {};
  const summaries = [];
  const summaryById = new Map();
  const seenNodeIds = new Set();
  const nodeDigests = new Map();
  const continuityEventOwners = new Map();
  const deferredV2NodeIds = [];
  let chunkBatch = [];
  let nodeBatch = [];
  let rawIndex = 0;
  let totalIndexBytes = 0;
  let sharedBytesEstimate = 0;
  let seenSharedPayload = false;
  const countedChunkIds = new Set();

  const ensurePlaceholder = async () => {
    if (placeholderWritten) return;
    placeholderWritten = true;
    await writeStageBatch(db, {
      entry: {
        id: archiveId,
        storage: 'timeline_archive',
        kind: PERSONAL_SAVE_KIND,
        owner: 'device',
        label: String(label || '正在导入存档…').slice(0, 100),
        reason: 'import-staging',
        createdAt: now,
        updatedAt: now,
        complete: false,
        nodeCount: 0,
        bytes: 0
      }
    }, signal);
  };

  const flushChunks = async () => {
    if (!chunkBatch.length) return;
    await ensurePlaceholder();
    const batch = chunkBatch;
    chunkBatch = [];
    await writeStageBatch(db, { chunks: batch }, signal);
  };

  const flushNodes = async () => {
    if (!nodeBatch.length && !chunkBatch.length) return;
    await ensurePlaceholder();
    const chunks = chunkBatch;
    const nodes = nodeBatch;
    chunkBatch = [];
    nodeBatch = [];
    await writeStageBatch(db, { chunks, archiveNodes: nodes }, signal);
  };

  const acceptLogicalNode = async (logical, rawNode, index) => {
    const clean = cleanSaveData(logical);
    const migrated = migrateNodeV1ToV2(clean, index);
    const sanitized = sanitizeTimelineNode(migrated, `timeline_node.${migrated.id || 'unknown'}`);
    validateStreamedNode(sanitized, continuityEventOwners);

    if (seenNodeIds.has(sanitized.id)) {
      throw new Error(`存档格式无效: 时间线节点 ID 重复: ${sanitized.id}`);
    }
    seenNodeIds.add(sanitized.id);

    const snapshot = sanitized.state_snapshot;
    summaryById.set(sanitized.id, {
      id: sanitized.id,
      parent_id: sanitized.parent_id ?? null,
      children_ids: Array.isArray(sanitized.children_ids) ? [...sanitized.children_ids] : [],
      branch_id: sanitized.branch_id,
      turn_number: sanitized.turn_number,
      depth: sanitized.depth,
      created_at: sanitized.created_at,
      real_timestamp: sanitized.real_timestamp,
      archived: Boolean(sanitized.archived),
      wasMissingChildren: rawNode.children_ids == null,
      has_snapshot: Boolean(snapshot && typeof snapshot === 'object'),
      state_snapshot_version: snapshot?._version,
      player_name: String(snapshot?.['玩家·姓名'] || snapshot?.player?.name || '').slice(0, 100),
      location: String(sanitized.location || sanitized.payload_location || snapshot?.['世界·地点'] || snapshot?.world_state?.current_location || '').slice(0, 120),
      summary: String(sanitized.summary || sanitized.ai_response_summary || sanitized.player_input || '').slice(0, 220),
      game_time: String(sanitized.game_time || '')
    });
    summaries.push(summaryById.get(sanitized.id));

    const digest = await checksumSaveJson(canonicalNodeDigestSource(sanitized), { canonical: true });
    nodeDigests.set(sanitized.id, digest);

    let storedNode = sanitized;
    let records = [];
    if (isPlainRecord(rawNode) && rawNode.payload_encoding === SHARED_PAYLOAD_ENCODING && isPlainRecord(rawNode.payload)) {
      storedNode = {
        ...sanitized,
        payload_encoding: SHARED_PAYLOAD_ENCODING,
        payload: rawNode.payload
      };
      if (Array.isArray(sanitized.chat_history) && sanitized.chat_history.length) storedNode.payload_has_chat_history = true;
      delete storedNode.state_snapshot;
      delete storedNode.chat_history;
      delete storedNode.memory_snapshot;
      if (storedNode.maintenance) {
        const { before_state_snapshot, ...rest } = storedNode.maintenance;
        storedNode.maintenance = rest;
      }
      if (Array.isArray(storedNode.maintenance_history)) {
        storedNode.maintenance_history = storedNode.maintenance_history.map(item => {
          if (!isPlainRecord(item)) return item;
          const { before_state_snapshot, ...rest } = item;
          return rest;
        });
      }
      seenSharedPayload = true;
    } else if (sanitized.state_snapshot || sanitized.maintenance?.before_state_snapshot) {
      const prepared = await prepareSharedTimelineNode(sanitized, { signal });
      storedNode = prepared.node;
      records = prepared.records;
      seenSharedPayload = prepared.node.payload_encoding === SHARED_PAYLOAD_ENCODING;
    }

    for (const record of records) {
      if (!countedChunkIds.has(record.id)) {
        countedChunkIds.add(record.id);
        sharedBytesEstimate += record.bytes.byteLength;
        chunkBatch.push(record);
      }
    }
    totalIndexBytes += estimateTimelineNodeBytes(storedNode);
    nodeBatch.push({ archiveId, id: storedNode.id, node: storedNode });
    if (chunkBatch.length >= CHUNK_BATCH_LIMIT || nodeBatch.length >= NODE_BATCH_LIMIT) {
      await flushNodes();
    }
  };

  try {
    const baseStream = gzipped
      ? file.stream().pipeThrough(new DecompressionStream('gzip'))
      : file.stream();

    const STREAM_PATHS = [
      '$.schema', '$.kind', '$.saved_at', '$.label', '$.checksum',
      '$.export_version', '$.exported_at', '$.include_archive',
      '$.codec', '$.multiplayer_export', '$.multiplayer_record_sidecar',
      '$.meta', '$.branches', '$.nodes.*', '$.room', '$.rooms',
      '$.payload.export_version', '$.payload.exported_at', '$.payload.include_archive',
      '$.payload.schema', '$.payload.codec', '$.payload.multiplayer_export', '$.payload.multiplayer_record_sidecar',
      '$.payload.meta', '$.payload.branches',
      '$.payload.chunks.*', '$.payload.nodes.*'
    ];

    const streamController = new AbortController();
    const forwardAbort = () => streamController.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    let parseResult;
    try {
      parseResult = await streamParseSaveJson(baseStream, {
        paths: STREAM_PATHS,
        keepStack: false,
        maxBytes: maxDecompressedBytes,
        limitError: () => new Error('存档解压体积超过读取上限'),
        signal: signal ? streamController.signal : null,
        digestPayload: true,
        onKey: (key, stack) => {
          if (stack.length >= 2 && stack[1]?.key === 'payload' && SECRET_KEYS.test(String(key))) {
            throw new Error('存档混入连接凭证，请重新导出');
          }
        },
        onValue: async ({ value, key, stack }) => {
          if (abortedForRoomPackage) return;
          if (stack.length === 1) {
            if (key === 'kind') {
              pkg.kind = value;
              if (value === 'multiplayer_room') {
                abortedForRoomPackage = true;
                streamController.abort();
                return;
              }
            } else if (key === 'room' || key === 'rooms') {
              if (!pkg.schema) {
                abortedForRoomPackage = true;
                streamController.abort();
                return;
              }
            } else if (['schema', 'saved_at', 'label', 'checksum'].includes(key)) {
              pkg[key] = value;
            } else {
              header[key] = value;
            }
            return;
          }

          if (stack.length === 2 && stack[1]?.key === 'payload') {
            header[key] = value;
            return;
          }

          if (stack.length === 3 && stack[1]?.key === 'payload' && stack[2]?.key === 'chunks') {
            const chunkId = String(key);
            if (!/^[a-f0-9]{64}$/.test(chunkId)) throw new Error(`共享数据块编号无效: ${chunkId}`);
            const decoded = await decodeV2ChunkRecord(chunkId, value);
            if (!countedChunkIds.has(chunkId)) {
              countedChunkIds.add(chunkId);
              sharedBytesEstimate += decoded.bytes.byteLength;
              chunkBatch.push(decoded);
            }
            if (chunkBatch.length >= CHUNK_BATCH_LIMIT) await flushChunks();
            return;
          }

          const isPayloadNode = stack.length === 3 && stack[1]?.key === 'payload' && stack[2]?.key === 'nodes';
          const isRawNode = stack.length === 2 && stack[1]?.key === 'nodes';
          if (isPayloadNode || isRawNode) {
            const idx = rawIndex++;
            if (idx % 25 === 0) onProgress(`正在流式校验并保存：已处理 ${idx} 个回合…`);
            if (isCompressedTimelineNode(value)) {
              if (value.payload_encoding === SHARED_PAYLOAD_ENCODING) {
                await flushChunks();
                try {
                  const logical = await decompressTimelineNode(value, { db, verifyStorage: true });
                  await acceptLogicalNode(logical, value, idx);
                } catch (err) {
                  if (String(err?.message || '').includes('缺少数据块') && pkg.schema === SAVE_PACKAGE_SCHEMA_V2) {
                    if (!value?.id || typeof value.id !== 'string') throw err;
                    deferredV2NodeIds.push({ index: idx, id: value.id });
                    nodeBatch.push({ archiveId, id: value.id, node: value });
                    if (nodeBatch.length >= NODE_BATCH_LIMIT) await flushNodes();
                  } else {
                    throw err;
                  }
                }
              } else {
                const logical = await decompressTimelineNode(value, { db });
                await acceptLogicalNode(logical, value, idx);
              }
            } else {
              await acceptLogicalNode(value, value, idx);
            }
          }
        }
      });
    } catch (error) {
      if (abortedForRoomPackage) return { isRoomPackage: true };
      throw error;
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
    }

    if (abortedForRoomPackage) return { isRoomPackage: true };

    await flushNodes();

    // Verify package wrapper if present
    const hasPackageMeta = Object.prototype.hasOwnProperty.call(pkg, 'schema')
      || Object.prototype.hasOwnProperty.call(pkg, 'kind')
      || Object.prototype.hasOwnProperty.call(pkg, 'checksum');
    if (hasPackageMeta) {
      if (!PACKAGE_SCHEMAS.has(pkg.schema) || ![PERSONAL_SAVE_KIND, 'multiplayer_room'].includes(pkg.kind)) {
        throw new Error('不支持的存档类型或版本，请使用兼容版本导出的存档');
      }
      if (pkg.kind === 'multiplayer_room') return { isRoomPackage: true };
      if (pkg.checksum?.algorithm !== 'SHA-256'
        || !parseResult.payloadDigest
        || pkg.checksum?.value !== parseResult.payloadDigest) {
        throw new Error('存档完整性校验失败，文件可能损坏或被修改');
      }
    }

    // Handle any v2 nodes encountered before their chunks finished arriving
    if (deferredV2NodeIds.length) {
      for (const deferred of deferredV2NodeIds) {
        const record = await readDB(db, 'timeline_archive_nodes', [archiveId, deferred.id]);
        if (!record?.node) throw new Error(`共享存档缺少节点: ${deferred.id}`);
        const logical = await decompressTimelineNode(record.node, { db, verifyStorage: true });
        await acceptLogicalNode(logical, record.node, deferred.index);
      }
      await flushNodes();
    }

    const incomingBranches = Array.isArray(header.branches) ? header.branches : [];
    if (!summaries.length || !incomingBranches.length) {
      throw new Error('存档缺少时间线节点或分支数据');
    }

    const rawMetaWrapped = header.meta && typeof header.meta === 'object' && !Array.isArray(header.meta)
      && Object.prototype.hasOwnProperty.call(header.meta, 'value');
    const rawMeta = rawMetaWrapped ? header.meta.value : header.meta;
    if (rawMeta != null && (typeof rawMeta !== 'object' || Array.isArray(rawMeta))) {
      throw new Error('存档格式无效: 时间线元数据必须是 JSON 对象');
    }
    const importedMeta = rawMeta || {};
    const multiplayerMetadata = assertMultiplayerSidecarHeader(header);
    const multiplayerTokens = multiplayerMetadata?.multiplayer_record_sidecar?.actor_bindings?.map(b => b.opaque_binding_token) || [];
    if (multiplayerTokens.length) {
      const metaBranchText = JSON.stringify({ meta: importedMeta, branches: incomingBranches });
      if (multiplayerTokens.some(token => metaBranchText.includes(token))) {
        throw new Error('联机角色绑定 token 不能进入 Agent 可见时间线');
      }
    }

    const { [NON_AGENT_MULTIPLAYER_META_FIELD]: _dropped, ...publicImportedMeta } = importedMeta;
    const validBranches = incomingBranches.filter(b => isPlainRecord(b)).map(b => cleanSaveData(b));
    const soleBranchId = validBranches.length === 1 ? validBranches[0].id : null;

    // Normalize metadata fields on summaries (and record IDs whose stored wrapper needs metadata update)
    const changedWrapperIds = new Set();
    for (const s of summaries) {
      if (s.branch_id == null && soleBranchId) {
        s.branch_id = soleBranchId;
        changedWrapperIds.add(s.id);
      }
    }
    for (const s of summaries) {
      if (!s.parent_id) continue;
      const parent = summaryById.get(s.parent_id);
      if (parent && parent.wasMissingChildren && !parent.children_ids.includes(s.id)) {
        parent.children_ids.push(s.id);
        changedWrapperIds.add(parent.id);
      }
    }
    for (const s of summaries) {
      const visited = new Set();
      let cursor = s;
      let depth = 0;
      let ok = true;
      while (cursor.parent_id != null) {
        if (visited.has(cursor.id)) { ok = false; break; }
        visited.add(cursor.id);
        cursor = summaryById.get(cursor.parent_id);
        if (!cursor) { ok = false; break; }
        depth++;
      }
      if (ok && s.depth !== depth) {
        s.depth = depth;
        changedWrapperIds.add(s.id);
      }
    }

    if (changedWrapperIds.size) {
      const updates = [];
      for (const id of changedWrapperIds) {
        const record = await readDB(db, 'timeline_archive_nodes', [archiveId, id]);
        if (!record?.node) continue;
        const s = summaryById.get(id);
        updates.push({
          ...record,
          node: {
            ...record.node,
            branch_id: s.branch_id,
            children_ids: [...s.children_ids],
            depth: s.depth
          }
        });
        if (updates.length >= NODE_BATCH_LIMIT) {
          await writeStageBatch(db, { archiveNodes: updates.splice(0, updates.length) }, signal);
        }
      }
      if (updates.length) await writeStageBatch(db, { archiveNodes: updates }, signal);
    }

    const newestSummary = candidates => candidates.reduce((latest, candidate) => {
      if (!latest) return candidate;
      const turnDelta = (candidate.turn_number || 0) - (latest.turn_number || 0);
      if (turnDelta !== 0) return turnDelta > 0 ? candidate : latest;
      const timeDelta = (candidate.created_at || candidate.real_timestamp || 0) - (latest.created_at || latest.real_timestamp || 0);
      return timeDelta >= 0 ? candidate : latest;
    }, null);

    const roots = summaries.filter(s => s.parent_id == null);
    const derivedRootId = roots.length === 1 ? roots[0].id : undefined;
    const requestedBranch = validBranches.find(b => b.id === importedMeta.active_branch);
    const requestedHead = requestedBranch ? summaryById.get(requestedBranch.head_node_id) : null;
    const derivedCurrent = importedMeta.current_id == null && requestedBranch
      ? ((requestedHead?.branch_id === requestedBranch.id ? requestedHead : null)
        || newestSummary(summaries.filter(s => s.branch_id === requestedBranch.id)))
      : newestSummary(summaries);

    const rootId = importedMeta.root_id ?? derivedRootId;
    const currentId = importedMeta.current_id ?? derivedCurrent?.id;
    const currentSummary = summaryById.get(currentId);
    const activeBranch = importedMeta.active_branch ?? currentSummary?.branch_id ?? soleBranchId;

    const normalizedBranches = incomingBranches.map(branch => {
      if (!isPlainRecord(branch)) return branch;
      const cleanedBranch = cleanSaveData(branch);
      const branchNodes = summaries.filter(s => s.branch_id === cleanedBranch.id);
      const branchHead = branchNodes.length ? newestSummary(branchNodes) : null;
      return {
        ...cleanedBranch,
        head_node_id: cleanedBranch.head_node_id ?? branchHead?.id,
        node_count: cleanedBranch.node_count ?? branchNodes.length,
        is_active: Object.prototype.hasOwnProperty.call(cleanedBranch, 'is_active')
          ? cleanedBranch.is_active
          : cleanedBranch.id === activeBranch
      };
    });

    const normalizedMeta = {
      key: 'root',
      value: {
        ...cleanSaveData(publicImportedMeta),
        ...(multiplayerMetadata ? { [NON_AGENT_MULTIPLAYER_META_FIELD]: multiplayerMetadata } : {}),
        root_id: rootId,
        current_id: currentId,
        active_branch: activeBranch,
        total_nodes: summaries.length
      }
    };

    // Validate complete graph invariants on light summary stubs (zero snapshot memory retention)
    const graphStubs = summaries.map(s => ({
      id: s.id,
      parent_id: s.parent_id,
      children_ids: s.children_ids,
      branch_id: s.branch_id,
      turn_number: s.turn_number,
      depth: s.depth,
      archived: s.archived,
      state_snapshot: s.has_snapshot ? { _version: s.state_snapshot_version } : null
    }));
    assertTimelineSave({
      export_version: '2.0',
      include_archive: true,
      meta: normalizedMeta,
      branches: normalizedBranches,
      nodes: graphStubs
    });

    // Validate exact runtime restoration of current node BEFORE publishing
    const storedCurrentRecord = await readDB(db, 'timeline_archive_nodes', [archiveId, currentId]);
    if (!storedCurrentRecord?.node) throw new Error('导入的当前节点不存在');
    const logicalCurrent = await decompressTimelineNode(storedCurrentRecord.node, { db, verifyStorage: true });
    if (!logicalCurrent.state_snapshot || !isPlainRecord(logicalCurrent.state_snapshot)) {
      throw new Error(`导入状态恢复失败: 当前节点 ${currentId} 缺少有效状态快照，无法精确恢复`);
    }
    const { stateManager } = await import('./state-manager.js');
    stateManager.prepareRestore(logicalCurrent.state_snapshot);

    // Compute canonical digest across formats (v1 gzip / v2 compact / raw JSON)
    const canonicalChecksum = await checksumSaveJson({
      export_version: '2.0',
      include_archive: true,
      branches: [...normalizedBranches].sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || ''))),
      meta: normalizedMeta,
      nodeDigests: [...nodeDigests.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    }, { canonical: true });

    const existingArchives = await readDB(db, 'timeline_archives');
    const duplicate = reason !== 'manual' && existingArchives.find(
      item => item.complete && (item.canonicalChecksum === canonicalChecksum || item.checksum === canonicalChecksum)
    );
    if (duplicate) {
      await rollbackStagedArchive(db, archiveId);
      onProgress('该存档已存在，已自动去重跳过重复写入');
      return duplicate;
    }

    const name = currentSummary.player_name || '忍者冒险';
    const entryLabel = String(label || pkg.label || `${name} · 第 ${currentSummary.turn_number ?? 1} 回合`).trim().slice(0, 100);
    const scope = continuationSaveScope({ meta: normalizedMeta, nodes: graphStubs });
    const entry = {
      id: archiveId,
      storage: 'timeline_archive',
      kind: PERSONAL_SAVE_KIND,
      owner: 'device',
      label: entryLabel,
      reason,
      rootId,
      turn: currentSummary.turn_number ?? 0,
      character: name,
      location: currentSummary.location || '',
      nodeCount: summaries.length,
      nodeOrder: summaries.map(s => s.id),
      branchCount: normalizedBranches.filter(b => b.id !== 'branch_main').length,
      branchName: normalizedBranches.find(b => b.id === activeBranch)?.name || '主线',
      gameTime: currentSummary.game_time || '',
      summary: currentSummary.summary || '',
      continuation: scope,
      meta: normalizedMeta,
      branches: normalizedBranches,
      snapshotRevision: crypto.randomUUID(),
      snapshotAt: pkg.saved_at || new Date(now).toISOString(),
      createdAt: now,
      updatedAt: now,
      checksum: canonicalChecksum,
      canonicalChecksum,
      indexBytes: totalIndexBytes,
      sharedPayloadBytes: sharedBytesEstimate,
      bytes: totalIndexBytes + sharedBytesEstimate,
      sharedPayload: seenSharedPayload,
      complete: true
    };
    await writeStageBatch(db, { entry }, signal);
    onProgress(`导入完成：共 ${summaries.length} 个回合`);
    return entry;
  } catch (error) {
    await rollbackStagedArchive(db, archiveId);
    throw error;
  }
}
