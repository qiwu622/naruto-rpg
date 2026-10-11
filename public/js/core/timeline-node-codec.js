import { TIMELINE_NODE_PAYLOAD_ENCODING, findForbiddenTimelineMedia } from './timeline-save-schema.js';

export { TIMELINE_NODE_PAYLOAD_ENCODING };
export const TIMELINE_HOT_WINDOW = 20;
export const DEFAULT_MAX_NODE_PAYLOAD_BYTES = 32 * 1024 * 1024;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${Math.ceil(bytes / 1024 / 1024)} MiB`;
}

export function payloadByteLength(payload) {
  if (!payload) return 0;
  if (typeof payload.byteLength === 'number') return payload.byteLength;
  if (typeof payload.size === 'number') return payload.size;
  return 0;
}

export function isCompressedTimelineNode(node) {
  return isRecord(node)
    && node.payload_encoding === TIMELINE_NODE_PAYLOAD_ENCODING
    && node.payload != null;
}

export function listingTimelineNode(node) {
  if (!isRecord(node)) return node;
  const rest = {};
  // An allow-list prevents future snapshot/memory fields from silently making
  // the directory as large as the archive it is meant to index.
  for (const key of ['id', 'parent_id', 'children_ids', 'branch_id', 'turn_number', 'depth',
    'created_at', 'real_timestamp', 'archived', 'archived_at', 'is_checkpoint', 'branch_anchor', 'tags', 'payload_encoding']) {
    if (node[key] !== undefined) rest[key] = node[key];
  }
  rest.summary = String(node.summary || node.ai_response_summary || node.player_input || '').slice(0, 1000);
  rest.game_time = node.game_time || node.state_snapshot?.['世界·时间'] || '';
  rest.location = String(node.location || snapshotLocation(node.state_snapshot)).slice(0, 120);
  const smallRecord = record => record && Object.fromEntries(['type', 'label', 'title', 'reason', 'created_at', 'createdAt', 'proposal_id', 'proposalId', 'previous_node_id']
    .filter(key => record[key] != null).map(key => [key, typeof record[key] === 'string' ? record[key].slice(0, 500) : record[key]]));
  if (node.maintenance) rest.maintenance = smallRecord(node.maintenance);
  if (node.maintenance_history?.length) rest.maintenance_history = node.maintenance_history.map(smallRecord);
  rest.needs_media_cleanup = !isCompressedTimelineNode(node) && Boolean(findForbiddenTimelineMedia(node));
  rest.estimated_bytes = estimateTimelineNodeBytes(node);
  if (isCompressedTimelineNode(node)) rest.payload_bytes = payloadByteLength(node.payload);
  return rest;
}

export function estimateTimelineNodeBytes(node) {
  if (!isRecord(node)) return 0;
  const payloadBytes = payloadByteLength(node.payload);
  try {
    const { payload, ...rest } = node;
    return payloadBytes + JSON.stringify(rest).length;
  } catch {
    return payloadBytes;
  }
}

async function normalizePayloadBytes(payload) {
  if (payload instanceof Uint8Array) return payload;
  if (typeof ArrayBuffer !== 'undefined' && payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof Blob !== 'undefined' && payload instanceof Blob) {
    return new Uint8Array(await payload.arrayBuffer());
  }
  throw new Error('gzip 载荷格式无效');
}

async function gzipJson(value) {
  if (typeof globalThis.CompressionStream !== 'function') {
    throw new Error('当前浏览器缺少 CompressionStream，无法压缩时间线节点');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const compressed = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

async function gunzipJson(payload, maxBytes) {
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw new Error('当前浏览器缺少 DecompressionStream，无法解压时间线节点');
  }
  const bytes = await normalizePayloadBytes(payload);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value?.byteLength || 0;
      if (totalBytes > maxBytes) {
        await reader.cancel('timeline node exceeds configured limit');
        throw new Error(`时间线节点解压后超过 ${formatBytes(maxBytes)} 上限`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(chunks.join(''));
}

function snapshotLocation(snapshot) {
  if (!isRecord(snapshot)) return '';
  const value = snapshot['世界·地点'] ?? snapshot.world_state?.current_location;
  return typeof value === 'string' ? value : '';
}

function buildPayload(node) {
  const payload = {};
  if (isRecord(node.state_snapshot)) payload.state_snapshot = node.state_snapshot;
  const before = node.maintenance?.before_state_snapshot;
  if (isRecord(before)) payload.before_state_snapshot = before;
  if (Array.isArray(node.maintenance_history)) {
    const historySnapshots = node.maintenance_history
      .map((record, index) => (isRecord(record?.before_state_snapshot) ? [index, record.before_state_snapshot] : null))
      .filter(Boolean);
    if (historySnapshots.length) payload.maintenance_history_snapshots = historySnapshots;
  }
  return payload;
}

function hasCompressiblePayload(payload) {
  return Object.keys(payload).length > 0;
}

export async function compressTimelineNode(node) {
  if (!isRecord(node) || isCompressedTimelineNode(node)) return node;
  const payload = buildPayload(node);
  if (!hasCompressiblePayload(payload)) return node;
  let bytes;
  try {
    bytes = await gzipJson(payload);
  } catch (error) {
    if (String(error?.message || '').includes('CompressionStream')) return node;
    throw error;
  }
  const next = {
    ...node,
    payload_encoding: TIMELINE_NODE_PAYLOAD_ENCODING,
    payload: bytes
  };
  delete next.state_snapshot;
  const location = node.location || snapshotLocation(payload.state_snapshot);
  if (location) next.location = location;
  if (isRecord(next.maintenance) && Object.prototype.hasOwnProperty.call(next.maintenance, 'before_state_snapshot')) {
    const { before_state_snapshot, ...maintenance } = next.maintenance;
    next.maintenance = maintenance;
  }
  if (Array.isArray(next.maintenance_history)) {
    next.maintenance_history = next.maintenance_history.map(record => {
      if (!isRecord(record) || !Object.prototype.hasOwnProperty.call(record, 'before_state_snapshot')) return record;
      const { before_state_snapshot, ...rest } = record;
      return rest;
    });
  }
  return next;
}

export async function decompressTimelineNode(node, {
  maxDecompressedBytes = DEFAULT_MAX_NODE_PAYLOAD_BYTES
} = {}) {
  if (!isCompressedTimelineNode(node)) return node;
  const payload = await gunzipJson(node.payload, maxDecompressedBytes);
  const next = { ...node };
  delete next.payload;
  delete next.payload_encoding;
  delete next.payload_bytes;
  if (isRecord(payload.state_snapshot)) next.state_snapshot = payload.state_snapshot;
  if (isRecord(payload.before_state_snapshot)) {
    next.maintenance = {
      ...(isRecord(next.maintenance) ? next.maintenance : {}),
      before_state_snapshot: payload.before_state_snapshot
    };
  }
  if (Array.isArray(payload.maintenance_history_snapshots) && Array.isArray(next.maintenance_history)) {
    const restored = next.maintenance_history.map(record => (isRecord(record) ? { ...record } : record));
    for (const entry of payload.maintenance_history_snapshots) {
      const index = Array.isArray(entry) ? entry[0] : entry?.index;
      const snapshot = Array.isArray(entry) ? entry[1] : entry?.snapshot;
      if (!Number.isInteger(index) || !isRecord(restored[index]) || !isRecord(snapshot)) continue;
      restored[index].before_state_snapshot = snapshot;
    }
    next.maintenance_history = restored;
  }
  return next;
}

export function collectHotNodeIds(nodes, currentId, keep = TIMELINE_HOT_WINDOW) {
  const hot = new Set();
  if (!Array.isArray(nodes) || !currentId || !Number.isInteger(keep) || keep <= 0) return hot;
  const byId = new Map(nodes.filter(node => node?.id).map(node => [node.id, node]));
  let cursor = byId.get(currentId);
  let remaining = keep;
  const visited = new Set();
  while (cursor?.id && remaining > 0) {
    if (visited.has(cursor.id)) break;
    visited.add(cursor.id);
    hot.add(cursor.id);
    remaining -= 1;
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : null;
  }
  return hot;
}
