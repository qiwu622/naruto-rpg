import { readDB, SUMMARY_STORE, timelineRevision } from './timeline-db.js';
import {
  TIMELINE_HOT_WINDOW,
  collectHotNodeIds,
  decompressTimelineNode,
  prepareSharedTimelineNode,
  estimateTimelineNodeBytes,
  isCompressedTimelineNode,
  listingTimelineNode
} from './timeline-node-codec.js';
import { PAYLOAD_CHUNK_STORE, SHARED_PAYLOAD_ENCODING, payloadChunkIds, putPayloadChunks } from './timeline-payload-chunks.js';
import { sanitizeTimelineNode } from './timeline-save-schema.js';
import { checksumSaveJson } from './save-json-stream.js';

const STORES = ['timeline_nodes', 'timeline_archives', 'timeline_archive_nodes', PAYLOAD_CHUNK_STORE];
const abortError = () => new DOMException('整理已暂停，可在空间管理中继续。原档未修改。', 'AbortError');

// Web Locks survive neither a closed tab nor a killed Worker. A persisted
// checkpoint is resumable immediately after either, without stale busy flags.
export async function withStorageMaintenanceLock(operation) {
  if (!globalThis.navigator?.locks) throw new Error('当前浏览器不支持安全的后台整理，请更新浏览器；保存和游玩仍可继续');
  return navigator.locks.request('naruto-storage-maintenance', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('另一个页面正在整理存档，请等待它完成或暂停');
    return operation();
  });
}

function write(db, callback, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, 'readwrite'); let failure;
    const abort = () => { try { tx.abort(); } catch {} };
    signal?.addEventListener('abort', abort, { once: true });
    const fail = error => { failure = error; abort(); };
    tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(); };
    tx.onabort = () => {
      signal?.removeEventListener('abort', abort);
      const error = failure || tx.error;
      reject(signal?.aborted ? abortError() : error?.name === 'QuotaExceededError'
        ? new Error('本机空间不足，整理已暂停。原档保留，可清理其他文件后继续。') : error);
    };
    tx.onerror = () => {};
    try { callback(tx, fail); } catch (error) { fail(error); }
  });
}

async function nextArchiveNode(db, archiveId, previous) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('timeline_archive_nodes');
    const range = previous ? IDBKeyRange.lowerBound([archiveId, previous], true) : IDBKeyRange.lowerBound([archiveId]);
    const request = tx.objectStore('timeline_archive_nodes').openCursor(range);
    tx.oncomplete = () => resolve(request.result?.value?.archiveId === archiveId ? request.result.value.node : null);
    tx.onabort = () => reject(tx.error);
  });
}

async function archiveFootprint(db, id, signal) {
  const ids = new Set(); let indexBytes = 0, previous;
  while (true) {
    if (signal?.aborted) throw abortError();
    const node = await nextArchiveNode(db, id, previous); if (!node) break;
    previous = node.id; indexBytes += estimateTimelineNodeBytes(node);
    for (const key of payloadChunkIds(node)) ids.add(key);
  }
  let sharedPayloadBytes = 0;
  for (const key of ids) {
    if (signal?.aborted) throw abortError();
    const record = await readDB(db, PAYLOAD_CHUNK_STORE, key);
    if (!record) throw new Error('副本缺少数据块，原档保留，请重新整理');
    sharedPayloadBytes += record.bytes.byteLength;
  }
  return { indexBytes, sharedPayloadBytes, bytes: indexBytes + sharedPayloadBytes };
}

export async function compactTimelineArchive(db, { id, resume = false, label }, { signal, onProgress = () => {} } = {}) {
  let entry = resume ? await readDB(db, 'timeline_archives', id) : null;
  if (resume && (entry?.complete || entry?.job?.type !== 'compact')) throw new Error('这项整理已经完成或不能续做，请刷新列表');
  const source = await readDB(db, 'timeline_archives', resume ? entry.job.sourceId : id);
  if (!source?.complete) throw new Error('原存档不存在或尚未保存完整');
  if (!entry) {
    const now = Date.now();
    entry = { ...source, id: `archive:${crypto.randomUUID()}`, label: String(label || `${source.label} · 无损整理`).slice(0, 100),
      snapshotRevision: crypto.randomUUID(), reason: 'compaction', createdAt: now, updatedAt: now,
      complete: false, bytes: 0, compacted: true,
      job: { type: 'compact', sourceId: source.id, sourceRevision: source.snapshotRevision, completed: 0, lastNodeId: null } };
    await write(db, tx => tx.objectStore('timeline_archives').add(entry), signal);
  }
  if (entry.job.sourceRevision !== source.snapshotRevision) throw new Error('原存档版本已变化，旧整理任务保留，请重新开始');
  // A checkpoint is advanced only AFTER a database readback and a complete
  // logical round-trip check. A crash before that redoes just that one node.
  while (true) {
    if (signal?.aborted) throw abortError();
    const raw = await nextArchiveNode(db, source.id, entry.job.lastNodeId);
    if (!raw) break;
    const logical = await decompressTimelineNode(raw, { db });
    const prepared = await prepareSharedTimelineNode(logical, { signal });
    const expected = { ...logical };
    if (prepared.node.location !== undefined) expected.location = prepared.node.location;
    const checksum = await checksumSaveJson(expected, { canonical: true });
    await write(db, (tx, fail) => {
      putPayloadChunks(tx, prepared.records, fail);
      tx.objectStore('timeline_archive_nodes').put({ archiveId: entry.id, id: raw.id, node: prepared.node });
    }, signal);
    const saved = await readDB(db, 'timeline_archive_nodes', [entry.id, raw.id]);
    const verified = await decompressTimelineNode(saved.node, { db, verifyStorage: true });
    if (await checksumSaveJson(verified, { canonical: true }) !== checksum) throw new Error(`第 ${raw.turn_number} 回合校验未通过，原档保留`);
    entry.job = { ...entry.job, completed: entry.job.completed + 1, lastNodeId: raw.id };
    entry.updatedAt = Date.now();
    await write(db, tx => tx.objectStore('timeline_archives').put(entry), signal);
    onProgress(`正在无损整理并校验：${entry.job.completed} / ${source.nodeCount}，关闭后可继续`);
  }
  if (entry.job.completed !== source.nodeCount) throw new Error('整理回合数与原档不一致，原档保留');
  onProgress('回合校验完成，正在统计整理后的占用…');
  Object.assign(entry, await archiveFootprint(db, entry.id, signal));
  entry.compactionSourceBytes = (await archiveFootprint(db, source.id, signal)).bytes;
  await write(db, (tx, fail) => {
    const count = tx.objectStore('timeline_archive_nodes').index('archiveId').count(IDBKeyRange.only(entry.id));
    count.onsuccess = () => {
      if (count.result !== source.nodeCount) { fail(new Error('副本不完整，原档保留')); return; }
      entry.complete = true; delete entry.job;
      tx.objectStore('timeline_archives').put(entry);
    };
  }, signal);
  return entry;
}

export function inspectTimelineStorage(db, { signal, onProgress = () => {} } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES);
    const referenced = new Set(), stats = { currentBytes: 0, archiveBytes: 0, temporaryBytes: 0, sharedBytes: 0, unusedBytes: 0,
      currentNodes: 0, archiveNodes: 0, chunkCount: 0, jobs: [] };
    let seen = 0, complete = new Map();
    const entries = tx.objectStore('timeline_archives').getAll();
    entries.onsuccess = () => {
      complete = new Map(entries.result.map(entry => [entry.id, entry.complete]));
      stats.jobs = entries.result.filter(entry => !entry.complete).map(entry => ({ id: entry.id, label: entry.label,
        resumable: entry.job?.type === 'compact', completed: entry.job?.completed || 0, total: entry.nodeCount, updatedAt: entry.updatedAt }));
      let pending = 2;
      for (const name of ['timeline_nodes', 'timeline_archive_nodes']) {
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          if (signal?.aborted) { tx.abort(); return; }
          const cursor = request.result;
          if (!cursor) { if (--pending === 0) scanChunks(); return; }
          const node = name === 'timeline_nodes' ? cursor.value : cursor.value.node;
          const bytes = estimateTimelineNodeBytes(node);
          if (name === 'timeline_nodes') { stats.currentBytes += bytes; stats.currentNodes++; }
          else if (complete.get(cursor.value.archiveId)) { stats.archiveBytes += bytes; stats.archiveNodes++; }
          else stats.temporaryBytes += bytes;
          for (const id of payloadChunkIds(node)) referenced.add(id);
          if (++seen % 50 === 0) onProgress(`正在统计空间：已检查 ${seen} 个回合…`);
          cursor.continue();
        };
      }
    };
    const scanChunks = () => {
      const request = tx.objectStore(PAYLOAD_CHUNK_STORE).openCursor();
      request.onsuccess = () => {
        if (signal?.aborted) { tx.abort(); return; }
        const cursor = request.result; if (!cursor) return;
        const bytes = cursor.value.bytes.byteLength;
        if (referenced.has(cursor.key)) stats.sharedBytes += bytes; else stats.unusedBytes += bytes;
        stats.chunkCount++; cursor.continue();
      };
    };
    tx.oncomplete = () => resolve(stats);
    tx.onabort = () => reject(signal?.aborted ? abortError() : tx.error);
    tx.onerror = () => {};
  });
}

// Mark and sweep in ONE transaction with every reference store. Even a game
// turn committing concurrently cannot lose its blocks. Incomplete jobs are
// roots too, unless the user explicitly discards that particular job.
export async function cleanTimelineStorage(db, { discardId = '' } = {}, { signal } = {}) {
  const referenced = new Set(); let freedBytes = 0, removedChunks = 0;
  await write(db, (tx, fail) => {
    const scan = () => {
      let pending = 2;
      for (const name of ['timeline_nodes', 'timeline_archive_nodes']) {
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { if (--pending === 0) sweep(); return; }
          if (name === 'timeline_archive_nodes' && cursor.value.archiveId === discardId) cursor.delete();
          else for (const id of payloadChunkIds(name === 'timeline_nodes' ? cursor.value : cursor.value.node)) referenced.add(id);
          cursor.continue();
        };
      }
    };
    const sweep = () => {
      const request = tx.objectStore(PAYLOAD_CHUNK_STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result; if (!cursor) return;
        if (!referenced.has(cursor.key)) { freedBytes += cursor.value.bytes.byteLength; removedChunks++; cursor.delete(); }
        cursor.continue();
      };
    };
    if (discardId) {
      const request = tx.objectStore('timeline_archives').get(discardId);
      request.onsuccess = () => {
        if (!request.result || request.result.complete) { fail(new Error('只能清理未完成的副本；完整原档不会被删除')); return; }
        tx.objectStore('timeline_archives').delete(discardId); scan();
      };
    } else scan();
  }, signal);
  return { freedBytes, removedChunks };
}

function sameNodeVersion(left, right) {
  if (!left || !right) return false;
  const { payload: leftPayload, ...leftFields } = left;
  const { payload: rightPayload, ...rightFields } = right;
  if (JSON.stringify(leftFields) !== JSON.stringify(rightFields)) return false;
  if (leftPayload == null || rightPayload == null) return leftPayload == null && rightPayload == null;
  if (left.payload_encoding === SHARED_PAYLOAD_ENCODING) {
    return JSON.stringify(leftPayload) === JSON.stringify(rightPayload);
  }
  const toBytes = value => value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : Array.isArray(value) ? Uint8Array.from(value) : null;
  const a = toBytes(leftPayload), b = toBytes(rightPayload);
  return Boolean(a && b && a.length === b.length && a.every((value, index) => value === b[index]));
}

export async function compressColdNodesTask(db, { currentId = null, keep = TIMELINE_HOT_WINDOW } = {}, { signal, onProgress = () => {} } = {}) {
  const summaries = await readDB(db, SUMMARY_STORE);
  if (!summaries?.length) return { archived: 0, compressed: 0, expanded: 0, compressedIds: [], archivedIds: [], expandedIds: [] };
  const meta = await readDB(db, 'timeline_meta', 'root');
  const resolvedCurrentId = currentId || meta?.value?.current_id || null;
  const hotIds = collectHotNodeIds(summaries, resolvedCurrentId, keep);
  if (!hotIds.size) return { archived: 0, compressed: 0, expanded: 0, compressedIds: [], archivedIds: [], expandedIds: [] };

  let archived = 0, compressed = 0, expanded = 0;
  const compressedIds = [], archivedIds = [], expandedIds = [];

  for (const listed of summaries) {
    if (signal?.aborted) throw abortError();
    if (!listed?.id) continue;
    const shouldBeHot = hotIds.has(listed.id);
    if (!shouldBeHot && listed.archived && listed.payload_encoding) continue;
    if (shouldBeHot && !listed.archived && !listed.payload_encoding) continue;

    const latest = await readDB(db, 'timeline_nodes', listed.id);
    if (!latest) continue;

    let proposed = null;
    let payloadRecords = [];
    let didCompress = false, didArchive = false, didExpand = false;
    if (shouldBeHot) {
      if (isCompressedTimelineNode(latest)) {
        const logical = await decompressTimelineNode(latest, { db });
        logical.archived = false;
        logical.archived_at = null;
        proposed = logical;
        didExpand = true;
      } else if (latest.archived) {
        proposed = { ...latest, archived: false, archived_at: null };
      }
    } else {
      let next = latest;
      if (!isCompressedTimelineNode(latest)) {
        const prepared = await prepareSharedTimelineNode(latest, { signal });
        next = prepared.node;
        payloadRecords = prepared.records;
        if (isCompressedTimelineNode(next)) didCompress = true;
      }
      if (!next.archived) {
        next = { ...next, archived: true, archived_at: next.archived_at || Date.now() };
        didArchive = true;
      }
      if (next !== latest) proposed = next;
    }
    if (!proposed) continue;

    const committed = await new Promise((resolve, reject) => {
      const tx = db.transaction(['timeline_nodes', SUMMARY_STORE, 'timeline_meta', PAYLOAD_CHUNK_STORE], 'readwrite');
      let wrote = false, failure;
      const fail = error => { failure = error; try { tx.abort(); } catch {} };
      tx.oncomplete = () => resolve(wrote);
      tx.onabort = () => reject(failure || tx.error || new Error('冷节点压缩写入失败'));
      tx.onerror = () => {};
      const nodeStore = tx.objectStore('timeline_nodes');
      const req = nodeStore.get(listed.id);
      req.onsuccess = () => {
        try {
          const live = req.result;
          if (!live || !sameNodeVersion(latest, live)) return;
          const next = sanitizeTimelineNode({
            ...proposed,
            parent_id: live.parent_id ?? proposed.parent_id ?? null,
            children_ids: Array.isArray(live.children_ids) ? [...live.children_ids] : proposed.children_ids,
            branch_id: live.branch_id ?? proposed.branch_id
          }, `timeline_node.${listed.id}`);
          if (payloadRecords.length) putPayloadChunks(tx, payloadRecords, fail);
          nodeStore.put(next);
          tx.objectStore(SUMMARY_STORE).put(listingTimelineNode(next));
          tx.objectStore('timeline_meta').put(timelineRevision());
          wrote = true;
        } catch (err) {
          fail(err);
        }
      };
    });

    if (!committed) continue;
    if (shouldBeHot) {
      if (didExpand) { expanded++; expandedIds.push(listed.id); }
    } else {
      if (didCompress) { compressed++; compressedIds.push(listed.id); }
      if (didArchive) { archived++; archivedIds.push(listed.id); }
    }
    if ((compressed + expanded) % 10 === 0 && compressed + expanded > 0) {
      onProgress(`后台冷数据整理中：已处理 ${compressed + expanded} 个回合`);
    }
  }
  return { archived, compressed, expanded, compressedIds, archivedIds, expandedIds };
}

export async function autoMaintainTimelineStorage(db, { keepAutoBackups = 5 } = {}, context = {}) {
  const entries = await readDB(db, 'timeline_archives');
  const activeCompactSources = new Set(
    entries.filter(item => !item.complete && item.job?.type === 'compact' && item.job?.sourceId)
      .map(item => item.job.sourceId)
  );
  const autoBackups = entries
    .filter(item => item.complete && typeof item.reason === 'string' && item.reason.startsWith('before-') && !activeCompactSources.has(item.id))
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

  const toPrune = autoBackups.slice(Math.max(1, keepAutoBackups));
  let prunedArchives = 0;
  for (const old of toPrune) {
    if (context?.signal?.aborted) break;
    await write(db, tx => {
      tx.objectStore('timeline_archives').delete(old.id);
      const req = tx.objectStore('timeline_archive_nodes').index('archiveId').openCursor(IDBKeyRange.only(old.id));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    }, context?.signal).catch(() => {});
    prunedArchives++;
  }
  const swept = await cleanTimelineStorage(db, {}, context);
  return { prunedArchives, ...swept };
}
