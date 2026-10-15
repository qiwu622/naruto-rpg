import { readDB, SUMMARY_STORE, timelineRevision } from './timeline-db.js';
import { listingTimelineNode, decompressTimelineNode, compressTimelineNode, estimateTimelineNodeBytes, TIMELINE_HOT_WINDOW } from './timeline-node-codec.js';
import { sanitizeTimelineNode, sanitizeTimelinePersistenceValue } from './timeline-save-schema.js';
import { cleanSaveData } from './save-library.js';
import { createSaveJsonByteStream } from './save-json-stream.js';
import { buildContinuationNode, buildContinuationHeader, DEFAULT_CONTINUATION_TURNS } from './continuation-save.js';

const stores = ['timeline_nodes', 'timeline_branches', 'timeline_meta', SUMMARY_STORE, 'timeline_archives', 'timeline_archive_nodes'];
const archiveRange = id => IDBKeyRange.only(id);
const newId = () => `archive:${crypto.randomUUID()}`;
const cancelled = () => new DOMException('已取消，原存档保留', 'AbortError');
function storageFailure(error) {
  if (error?.name === 'QuotaExceededError') return new Error('本地空间不足，本次操作已撤销，原档未删除。可先导出备份或清理其他档案。');
  return error || new Error('存档事务未完成，原档保留');
}

export async function archiveEntry(db, id) {
  const entry = await readDB(db, 'timeline_archives', id);
  if (!entry || entry.complete !== true) throw new Error('找不到完整的原档备份');
  return entry;
}

// The archive and active timeline live in the same database so backup + switch
// can be one atomic transaction. Only a single original record is held at once.
export function captureTimelineArchive(db, { label = '', reason = 'manual', reset = false, restore = null } = {}, { onProgress = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const tx = db.transaction(stores, 'readwrite');
    const nodes = tx.objectStore('timeline_nodes'), branches = tx.objectStore('timeline_branches');
    const meta = tx.objectStore('timeline_meta'), archives = tx.objectStore('timeline_archives');
    const records = tx.objectStore('timeline_archive_nodes'), summaries = tx.objectStore(SUMMARY_STORE);
    const id = newId(), now = Date.now();
    let count = 0, bytes = 0, sharedPayload = false, root, branchList, latest, current, result, failure, revision;
    const abort = () => { failure = cancelled(); try { tx.abort(); } catch {} };
    signal?.addEventListener('abort', abort, { once: true });
    const fail = error => { failure = error; try { tx.abort(); } catch {} };
    tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(result); };
    tx.onabort = () => { signal?.removeEventListener('abort', abort); reject(storageFailure(failure || tx.error)); };
    tx.onerror = () => {};
    const switchAfterBackup = () => {
      if (!reset && !restore) return;
      try {
        nodes.clear(); branches.clear(); summaries.clear(); meta.delete('root');
        meta.put({ key: 'summary-index-v1', value: true });
        meta.put(restore?.snapshotRevision ? { key: 'archive-revision', value: restore.snapshotRevision } : timelineRevision());
        if (!restore) return;
        for (const branch of restore.branches) branches.put(branch);
        meta.put(restore.meta);
        let restored = 0;
        const request = records.index('archiveId').openCursor(archiveRange(restore.id));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            if (restored !== restore.nodeCount) fail(new Error('备份节点数不匹配，读取已撤销，当前档和原备份保留'));
            return;
          }
          try {
            const node = cursor.value.node;
            const write = nodes.put(node);
            summaries.put(listingTimelineNode(node));
            write.onsuccess = () => { restored++; if (restored % 50 === 0) onProgress(`正在恢复：${restored} / ${restore.nodeCount}`); cursor.continue(); };
          } catch (error) { fail(error); }
        };
      } catch (error) { fail(error); }
    };
    const finishBackup = () => {
      if (!count) { result = null; switchAfterBackup(); return; }
      const chosen = current || latest;
      result = { id, storage: 'timeline_archive', kind: 'personal_timeline', owner: 'device',
        label: String(label || `${chosen?.character || '冒险'} · 第 ${chosen?.turn_number || 0} 回合`).slice(0, 100), reason,
        character: chosen?.character || '', snapshotRevision: revision,
        createdAt: now, updatedAt: now, snapshotAt: new Date(now).toISOString(),
        turn: chosen?.turn_number || 0, rootId: root?.value?.root_id, nodeCount: count,
        branchCount: branchList.filter(branch => branch.id !== 'branch_main').length,
        branchName: branchList.find(branch => branch.id === root?.value?.active_branch)?.name || '主线',
        summary: chosen?.summary || '', location: chosen?.location || '',
        continuation: root?.value?.continuation || null,
        meta: root, branches: branchList, bytes, sharedPayload, complete: true };
      // Count the committed raw records before exposing the backup or clearing
      // anything. An error/quota failure aborts every write in this transaction.
      const check = records.index('archiveId').count(archiveRange(id));
      check.onsuccess = () => {
        if (check.result !== count) { fail(new Error('备份校验未完成，原存档保留')); return; }
        try { archives.put(result); switchAfterBackup(); } catch (error) { fail(error); }
      };
    };
    const rootRequest = meta.get('root');
    rootRequest.onsuccess = () => { root = rootRequest.result || null; };
    const branchRequest = branches.getAll();
    branchRequest.onsuccess = () => { branchList = branchRequest.result; };
    const revisionRequest = meta.get('archive-revision');
    revisionRequest.onsuccess = () => { revision = revisionRequest.result?.value; };
    const prior = archives.getAll();
    prior.onsuccess = () => {
      const existing = revision && prior.result.find(entry => entry.complete && entry.snapshotRevision === revision && (!label || entry.label === label));
      if (existing) {
        try { result = { ...existing, updatedAt: now }; archives.put(result); switchAfterBackup(); } catch (error) { fail(error); }
        return;
      }
      const request = nodes.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { finishBackup(); return; }
        try {
          const node = cursor.value;
          bytes += estimateTimelineNodeBytes(node);
          sharedPayload ||= node.payload_encoding === 'shared-json-v1';
          const listed = { id: node.id, turn_number: node.turn_number,
            character: String(node.state_snapshot?.['玩家·姓名'] || node.state_snapshot?.player?.name || '').slice(0, 100),
            summary: String(node.summary || '').slice(0, 220), location: String(node.location || node.payload_location || node.state_snapshot?.['世界·地点'] || '').slice(0, 120) };
          if (!latest || listed.turn_number > latest.turn_number) latest = listed;
          if (node.id === root?.value?.current_id) current = listed;
          const write = records.add({ archiveId: id, id: node.id, node });
          write.onsuccess = () => { count++; if (count % 50 === 0) onProgress(`正在保留原档：${count} 回合…`); cursor.continue(); };
        } catch (error) { fail(error); }
      };
    };
  });
}

async function logicalArchiveNode(db, id, nodeId) {
  const record = await readDB(db, 'timeline_archive_nodes', [id, nodeId]);
  if (!record?.node) throw new Error(`原档缺少回合 ${nodeId}，未修改原档`);
  return sanitizeTimelineNode(await decompressTimelineNode(record.node, { db }));
}

// Immutable backups allow one small readonly transaction per record, avoiding
// a long-lived transaction across asynchronous compression/stream backpressure.
export async function* archiveNodes(db, entry, signal) {
  let previous;
  let count = 0;
  while (true) {
    if (signal?.aborted) throw cancelled();
    const record = await new Promise((resolve, reject) => {
      const store = entry.live ? 'timeline_nodes' : 'timeline_archive_nodes';
      const tx = db.transaction(store);
      const range = entry.live ? (previous ? IDBKeyRange.lowerBound(previous, true) : null)
        : previous ? IDBKeyRange.lowerBound([entry.id, previous], true) : IDBKeyRange.lowerBound([entry.id]);
      const request = tx.objectStore(store).openCursor(range);
      tx.oncomplete = () => resolve(request.result?.value);
      tx.onabort = () => reject(tx.error);
    });
    if (!record || (!entry.live && record.archiveId !== entry.id)) break;
    previous = record.id; count++;
    yield entry.live ? record : record.node;
  }
  if (count !== entry.nodeCount) throw new Error('备份节点不完整，导出已停止，原档保留');
  if (entry.live && (await readDB(db, 'timeline_meta', 'archive-revision'))?.value !== entry.snapshotRevision) {
    throw new Error('导出期间存档发生变化，请停止其他回合操作后重新导出。当前档未修改。');
  }
}

function portableHeader(entry) {
  const { _multiplayer_non_agent_metadata: multiplayer, ...value } = entry.meta?.value || {};
  const meta = { ...entry.meta, value };
  return cleanSaveData({ ...(multiplayer || {}), export_version: '2.0', include_archive: true, meta, branches: entry.branches });
}

export async function exportTimelineArchive(db, entry, { onProgress = () => {}, signal, payloadOnly = false, compression = 'auto' } = {}) {
  const encoder = new TextEncoder();
  const digest = globalThis.NarutoSaveCodec.sha256.create();
  async function* json(value) {
    const reader = createSaveJsonByteStream(value).getReader();
    try { while (true) { const next = await reader.read(); if (next.done) return; yield next.value; } }
    finally { reader.releaseLock(); }
  }
  async function* payload() {
    const header = portableHeader(entry);
    yield encoder.encode('{');
    let comma = false;
    for (const [key, value] of Object.entries(header)) {
      yield encoder.encode(`${comma ? ',' : ''}${JSON.stringify(key)}:`); comma = true;
      yield* json(value);
    }
    yield encoder.encode(`${comma ? ',' : ''}"nodes":[`);
    let count = 0;
    for await (const raw of archiveNodes(db, entry, signal)) {
      if (count) yield encoder.encode(',');
      const { memory_snapshot, payload, payload_encoding, payload_bytes, ...node } = await decompressTimelineNode(raw, { db });
      yield* json(cleanSaveData(sanitizeTimelinePersistenceValue(node, 'timeline_export')));
      count++; onProgress(`正在导出：${count} / ${entry.nodeCount}`);
    }
    yield encoder.encode(']}');
  }
  async function* packaged() {
    yield encoder.encode(`{"schema":"naruto.save-package/v1","kind":"personal_timeline","saved_at":${JSON.stringify(entry.snapshotAt)},"label":${JSON.stringify(entry.label)},"payload":`);
    for await (const chunk of payload()) { digest.update(chunk); yield chunk; }
    const checksum = Array.from(digest.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
    yield encoder.encode(`,"checksum":{"algorithm":"SHA-256","value":"${checksum}"}}`);
  }
  const iterator = payloadOnly ? payload() : packaged();
  let streamFailure;
  const stream = new ReadableStream({
    async pull(controller) { try { const item = await iterator.next(); if (item.done) controller.close(); else controller.enqueue(item.value); } catch (error) { streamFailure = error; controller.error(error); } },
    cancel() { return iterator.return(); }
  });
  try {
    const gzip = compression !== 'json' && typeof CompressionStream === 'function';
    const blob = await new Response(gzip ? stream.pipeThrough(new CompressionStream('gzip')) : stream).blob();
    return { blob, extension: gzip ? '.json.gz' : '.json', format: gzip ? 'gzip' : 'json', mimeType: gzip ? 'application/gzip' : 'application/json' };
  } catch (error) {
    // Chromium can turn a stream rejection into an opaque "Failed to fetch".
    // Keep the useful cause (changed timeline, damaged node, cancellation).
    throw streamFailure || error;
  } finally { digest.destroy(); }
}

function archiveWrite(db, write, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['timeline_archives', 'timeline_archive_nodes'], 'readwrite');
    let failure;
    const abort = () => { try { tx.abort(); } catch {} };
    const fail = error => { failure = error; abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(); };
    tx.onabort = () => { signal?.removeEventListener('abort', abort); reject(signal?.aborted ? cancelled() : storageFailure(failure || tx.error)); };
    tx.onerror = () => {};
    try { write(tx, fail); } catch (error) { fail(error); }
  });
}

// Only a directory of IDs is retained. Full snapshots are read, transformed,
// compressed and committed one at a time, even for thousands of retained turns.
export async function createContinuationArchive(db, source, { keepTurns = DEFAULT_CONTINUATION_TURNS, nodeId, label, reason = 'continuation' } = {}, context = {}) {
  if (!Number.isSafeInteger(keepTurns) || keepTurns < 1) throw new Error('保留回合数必须是大于 0 的整数');
  const { signal, onProgress = () => {} } = context;
  const retained = [], seen = new Set(), turns = new Set();
  let cursor = nodeId || source.meta?.value?.current_id;
  while (cursor) {
    if (signal?.aborted) throw cancelled();
    if (seen.has(cursor)) throw new Error('原档父节点存在循环，未修改原档');
    const record = await readDB(db, 'timeline_archive_nodes', [source.id, cursor]);
    if (!record?.node || record.node.id !== cursor) throw new Error('原档父节点缺失，请选择其他恢复点');
    const node = record.node;
    if (!turns.has(node.turn_number) && turns.size >= keepTurns) break;
    seen.add(cursor); turns.add(node.turn_number);
    retained.push({ id: node.id, branch_id: node.branch_id, turn_number: node.turn_number });
    cursor = node.parent_id;
    if (retained.length % 50 === 0) onProgress(`正在读取回合目录：${retained.length}…`);
  }
  if (!retained.length) throw new Error('没有可恢复的回合，请选择其他恢复点');
  retained.reverse();
  const first = retained[0], last = retained.at(-1), now = Date.now();
  const data = portableHeader(source);
  data.meta.value.current_id = last.id;
  data.meta.value.active_branch = last.branch_id;
  const plan = { retained, keepTurns, retainedTurns: turns.size, fromTurn: first.turn_number, toTurn: last.turn_number,
    omittedNodes: source.nodeCount - retained.length,
    sourceBranchName: source.branches.find(branch => branch.id === last.branch_id)?.name || '主线' };
  const header = buildContinuationHeader(data, plan, { sourceId: source.id, sourceLabel: source.label });
  // Validate the selected head before writing any part of the new copy.
  const head = await logicalArchiveNode(db, source.id, last.id);
  const { stateManager } = await import('./state-manager.js');
  stateManager.prepareRestore(head.state_snapshot);
  const persistedMeta = header.multiplayer_export ? { ...header.meta, value: { ...header.meta.value,
    _multiplayer_non_agent_metadata: { schema: header.schema, codec: header.codec, multiplayer_export: header.multiplayer_export, multiplayer_record_sidecar: header.multiplayer_record_sidecar }
  } } : header.meta;
  const entry = { ...source, id: newId(), label: String(label || `${source.label} · ${reason === 'rescue' ? '救援续玩' : '轻量续玩'}`).slice(0, 100), reason,
    snapshotRevision: crypto.randomUUID(), createdAt: now, updatedAt: now, snapshotAt: new Date(now).toISOString(),
    rootId: first.id, meta: persistedMeta, branches: header.branches, nodeCount: retained.length, branchCount: 0,
    branchName: header.branches[0].name, turn: last.turn_number, continuation: header.meta.value.continuation,
    summary: String(head.summary || '').slice(0, 220), location: String(head.location || head.state_snapshot?.['世界·地点'] || '').slice(0, 120),
    complete: false, bytes: 0 };
  for (const key of ['compacted', 'sharedPayload', 'indexBytes', 'sharedPayloadBytes', 'compactionSourceBytes']) delete entry[key];
  try {
    await archiveWrite(db, tx => tx.objectStore('timeline_archives').add(entry), signal);
    for (let index = 0; index < retained.length; index++) {
      if (signal?.aborted) throw cancelled();
      const sourceNode = await logicalArchiveNode(db, source.id, retained[index].id);
      let node = buildContinuationNode(sourceNode, index, retained);
      if (index < retained.length - TIMELINE_HOT_WINDOW) {
        node.archived = true; node.archived_at = now;
        node = await compressTimelineNode(node);
      }
      entry.bytes += estimateTimelineNodeBytes(node);
      await archiveWrite(db, tx => tx.objectStore('timeline_archive_nodes').add({ archiveId: entry.id, id: node.id, node }), signal);
      onProgress(`正在保存续玩副本：${index + 1} / ${retained.length}`);
    }
    await archiveWrite(db, (tx, fail) => {
      const check = tx.objectStore('timeline_archive_nodes').index('archiveId').count(archiveRange(entry.id));
      check.onsuccess = () => {
        if (check.result !== retained.length) { fail(new Error('续玩副本校验未完成，原档保留')); return; }
        try {
          entry.complete = true;
          tx.objectStore('timeline_archives').put(entry);
        } catch (error) { fail(error); }
      };
    }, signal);
    return entry;
  } catch (error) {
    // Only this newly-created staging copy is removed. Original and working
    // timelines are never modified during extraction, including on cancellation.
    await archiveWrite(db, (tx, fail) => {
      tx.objectStore('timeline_archives').delete(entry.id);
      const request = tx.objectStore('timeline_archive_nodes').index('archiveId').openCursor(archiveRange(entry.id));
      request.onsuccess = () => {
        try { const record = request.result; if (record) { record.delete(); record.continue(); } }
        catch (error) { fail(error); }
      };
    }).catch(() => {});
    throw error;
  }
}

export async function runArchiveTask(db, action, options = {}, context = {}) {
  if (['compact', 'resume-compaction', 'cleanup', 'discard-job', 'remove', 'create-continuation', 'rescue'].includes(action)) {
    // Older WebViews can still use the existing archive operations. Only the
    // new resumable maintenance/GC features require cross-context locking.
    if (!globalThis.navigator?.locks && ['remove', 'create-continuation', 'rescue'].includes(action)) {
      return executeArchiveTask(db, action, options, context);
    }
    const { withStorageMaintenanceLock } = await import('./timeline-storage-maintenance.js');
    return withStorageMaintenanceLock(() => executeArchiveTask(db, action, options, context));
  }
  return executeArchiveTask(db, action, options, context);
}

async function executeArchiveTask(db, action, options = {}, context = {}) {
  if (['compact', 'resume-compaction', 'storage-stats', 'cleanup', 'discard-job'].includes(action)) {
    const maintenance = await import('./timeline-storage-maintenance.js');
    if (action === 'storage-stats') return maintenance.inspectTimelineStorage(db, context);
    if (action === 'cleanup' || action === 'discard-job') return maintenance.cleanTimelineStorage(db, { discardId: action === 'discard-job' ? options.id : '' }, context);
    return maintenance.compactTimelineArchive(db, { ...options, resume: action === 'resume-compaction' }, context);
  }
  if (action === 'capture') return captureTimelineArchive(db, options, context);
  if (action === 'list') return (await readDB(db, 'timeline_archives')).filter(entry => entry.complete);
  if (action === 'status') return { meta: await readDB(db, 'timeline_meta', 'root'), archives: await readDB(db, 'timeline_archives') };
  if (action === 'export-current') {
    const revision = await readDB(db, 'timeline_meta', 'archive-revision');
    const meta = await readDB(db, 'timeline_meta', 'root');
    if (!meta?.value?.current_id) throw new Error('缺少保存位置，请先保留原档，再选择恢复回合');
    const branches = await readDB(db, 'timeline_branches');
    const raw = await readDB(db, 'timeline_nodes', meta.value.current_id);
    if (!raw) throw new Error('保存位置对应的回合不存在，请先保留原档');
    const current = sanitizeTimelineNode(await decompressTimelineNode(raw, { db }));
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction('timeline_nodes'), request = tx.objectStore('timeline_nodes').count();
      tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error);
    });
    const live = { live: true, snapshotRevision: revision?.value, meta, branches, nodeCount: count,
      label: `冒险 · 第 ${current.turn_number} 回合`, snapshotAt: new Date().toISOString() };
    const encoded = await exportTimelineArchive(db, live, { ...context, payloadOnly: options.payloadOnly === true, compression: options.compression });
    return { ...encoded, meta, branches, current };
  }
  const entry = await archiveEntry(db, options.id);
  if (action === 'get') return entry;
  if (action === 'preview') return logicalArchiveNode(db, entry.id, options.nodeId || entry.meta?.value?.current_id);
  if (action === 'candidates') {
    const recent = [];
    for await (const node of archiveNodes(db, entry, context.signal)) {
      if (!node.state_snapshot && !node.payload) continue;
      recent.push({ id: node.id, turn: node.turn_number, summary: String(node.summary || '').slice(0, 90), branch: node.branch_id });
      recent.sort((a, b) => b.turn - a.turn);
      if (recent.length > 30) recent.pop();
    }
    return recent;
  }
  if (action === 'export') return exportTimelineArchive(db, entry, { ...context, payloadOnly: options.payloadOnly === true, compression: options.compression });
  if (action === 'create-continuation') return createContinuationArchive(db, entry, options, context);
  if (action === 'rescue') {
    const saved = await createContinuationArchive(db, entry, { ...options, reason: 'rescue' }, context);
    await captureTimelineArchive(db, { reason: 'before-rescue-switch', restore: saved }, context);
    return saved;
  }
  if (action === 'restore') {
    const current = await logicalArchiveNode(db, entry.id, entry.meta?.value?.current_id);
    if (!current.state_snapshot) throw new Error('恢复点缺少状态，请在救援页选择其他回合');
    const { stateManager } = await import('./state-manager.js');
    stateManager.prepareRestore(current.state_snapshot);
    const backup = await captureTimelineArchive(db, { reason: 'before-load', restore: entry }, context);
    return { backup, current };
  }
  if (action === 'rename' || action === 'remove') return new Promise((resolve, reject) => {
    let failure;
    const tx = db.transaction(['timeline_archives', 'timeline_archive_nodes'], 'readwrite');
    if (action === 'rename') {
      if (!String(options.label || '').trim()) throw new Error('请输入存档名称');
      entry.label = String(options.label).trim().slice(0, 100); entry.updatedAt = Date.now();
      tx.objectStore('timeline_archives').put(entry);
    } else {
      const pending = tx.objectStore('timeline_archives').getAll();
      pending.onsuccess = () => {
        if (pending.result.some(item => !item.complete && item.job?.sourceId === entry.id)) {
          failure = new Error('有未完成的整理任务正在使用这个原档，请先完成或清理该任务'); tx.abort();
        }
      };
      tx.objectStore('timeline_archives').delete(entry.id);
      const request = tx.objectStore('timeline_archive_nodes').index('archiveId').openCursor(archiveRange(entry.id));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
    }
    tx.oncomplete = () => resolve(action === 'rename' ? entry : null);
    tx.onabort = () => reject(failure || tx.error); tx.onerror = () => {};
  });
  throw new Error('未知存档后台操作');
}
