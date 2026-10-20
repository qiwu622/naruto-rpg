import { inspectContinuityLedger, inspectMemoryEvent } from './continuity-ledger.js';
import { validateShinobiDaily } from './shinobi-daily.js';
import { SHARED_PAYLOAD_ENCODING } from './timeline-payload-chunks.js';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

function validColor(value) {
  return typeof value === 'string'
    && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SUPPORTED_SNAPSHOT_VERSIONS = new Set(['3.0', '4.0', '5.0']);
const OMIT_PERSISTED_VALUE = Symbol('omit-persisted-value');
// Memory JSON contains authored text, including literal examples of URLs.
// Media-field rules must not silently empty an entire memory string.
const isMemoryTextPath = path => /(?:^|\.)(?:_memory|memory)(?:\.|\[|$)/.test(path);
const FORBIDDEN_IMAGE_REFERENCE = /(?:data:image\/[^,\s;]+(?:;[^,\s]*)*;base64,|blob:)/i;
export const TIMELINE_NODE_PAYLOAD_ENCODING = 'gzip-json-v1';

function isBinaryValue(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (typeof ArrayBuffer !== 'undefined'
      && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return true;
  return typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;
}

function sanitizePersistenceValue(value, path, visiting) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return !isMemoryTextPath(path) && FORBIDDEN_IMAGE_REFERENCE.test(value) ? '' : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return OMIT_PERSISTED_VALUE;
  }
  if (typeof value === 'bigint') {
    throw new TypeError(`时间线持久化值不能包含 BigInt: ${path}`);
  }
  if (isBinaryValue(value)) return OMIT_PERSISTED_VALUE;
  if (visiting.has(value)) throw new TypeError(`时间线持久化值不能包含循环引用: ${path}`);
  visiting.add(value);

  let sanitized;
  if (Array.isArray(value)) {
    sanitized = value.map((item, index) => {
      const child = sanitizePersistenceValue(item, `${path}[${index}]`, visiting);
      return child === OMIT_PERSISTED_VALUE ? null : child;
    });
  } else if (value instanceof Date) {
    sanitized = Number.isNaN(value.getTime()) ? null : value.toISOString();
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`时间线持久化值包含非普通对象: ${path}`);
    }
    sanitized = {};
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw new TypeError(`时间线持久化值包含不安全键: ${path}.${key}`);
      const child = sanitizePersistenceValue(item, `${path}.${key}`, visiting);
      if (child !== OMIT_PERSISTED_VALUE) sanitized[key] = child;
    }
  }
  visiting.delete(value);
  return sanitized;
}

export function sanitizeTimelinePersistenceValue(value, path = 'timeline') {
  const sanitized = sanitizePersistenceValue(value, path, new WeakSet());
  return sanitized === OMIT_PERSISTED_VALUE ? null : sanitized;
}

function clonePayloadBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value.slice();
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return null;
}

export function sanitizeTimelineNode(node, path = 'timeline_node') {
  if (!isRecord(node)) return sanitizeTimelinePersistenceValue(node, path);
  const encoding = node.payload_encoding;
  const payload = Object.prototype.hasOwnProperty.call(node, 'payload') ? node.payload : undefined;
  const withoutPayload = { ...node };
  delete withoutPayload.payload;
  const sanitized = sanitizeTimelinePersistenceValue(withoutPayload, path);
  if (!isRecord(sanitized)) return sanitized;
  if (encoding === TIMELINE_NODE_PAYLOAD_ENCODING && payload != null) {
    const bytes = clonePayloadBytes(payload);
    if (bytes) {
      sanitized.payload_encoding = TIMELINE_NODE_PAYLOAD_ENCODING;
      sanitized.payload = bytes;
    }
  }
  if (encoding === SHARED_PAYLOAD_ENCODING && isRecord(payload)) {
    sanitized.payload = sanitizeTimelinePersistenceValue(payload, `${path}.payload`);
  }
  return sanitized;
}

export function sanitizeTimelineSnapshot(snapshot) {
  if (!isRecord(snapshot)) throw new TypeError('状态快照必须是 JSON 对象');
  const sanitized = sanitizeTimelinePersistenceValue(snapshot, 'state_snapshot');
  if (!isRecord(sanitized)) throw new TypeError('净化后的状态快照必须是 JSON 对象');
  return sanitized;
}

export function findForbiddenTimelineMedia(value, rootPath = 'timeline') {
  const seen = new WeakSet();
  const stack = [{ value, path: rootPath }];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current.value === 'string' && !isMemoryTextPath(current.path) && FORBIDDEN_IMAGE_REFERENCE.test(current.value)) {
      return current.path;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (isBinaryValue(current.value)) return current.path;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => stack.push({ value: item, path: `${current.path}[${index}]` }));
    } else {
      for (const [key, item] of Object.entries(current.value)) {
        if (key === 'payload' && current.value.payload_encoding === TIMELINE_NODE_PAYLOAD_ENCODING) continue;
        stack.push({ value: item, path: `${current.path}.${key}` });
      }
    }
  }
  return null;
}

function findUnsafeSnapshotKey(snapshot) {
  const seen = new WeakSet();
  const stack = [{ value: snapshot, path: 'state_snapshot' }];
  while (stack.length) {
    const { value, path } = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) return `${path}.${key}`;
      const child = value[key];
      if (child && typeof child === 'object') stack.push({ value: child, path: `${path}.${key}` });
    }
  }
  return null;
}

function inspectTimelineSaveInternal(data) {
  const errors = [];
  if (!isRecord(data)) return { valid: false, errors: ['存档根节点必须是 JSON 对象'] };

  const nodes = Array.isArray(data.nodes) ? data.nodes : null;
  const branches = Array.isArray(data.branches) ? data.branches : null;
  if (!nodes?.length) errors.push('存档缺少时间线节点');
  if (!branches?.length) errors.push('存档缺少时间线分支');
  if (!nodes?.length || !branches?.length) return { valid: false, errors };

  const nodeIds = new Set();
  const nodeById = new Map();
  const childIdsByNode = new Map();
  const branchNodeCounts = new Map();
  for (const node of nodes) {
    if (isRecord(node) && typeof node.branch_id === 'string') {
      branchNodeCounts.set(node.branch_id, (branchNodeCounts.get(node.branch_id) || 0) + 1);
    }
    if (!isRecord(node) || !validId(node.id)) {
      errors.push('时间线节点包含无效 ID');
      continue;
    }
    if (nodeIds.has(node.id)) errors.push(`时间线节点 ID 重复: ${node.id}`);
    nodeIds.add(node.id);
    nodeById.set(node.id, node);
    childIdsByNode.set(node.id, new Set(Array.isArray(node.children_ids) ? node.children_ids : []));
  }

  const branchIds = new Set();
  for (const branch of branches) {
    if (!isRecord(branch) || !validId(branch.id)) {
      errors.push('时间线分支包含无效 ID');
      continue;
    }
    if (branchIds.has(branch.id)) errors.push(`时间线分支 ID 重复: ${branch.id}`);
    branchIds.add(branch.id);
  }

  const continuityEventOwners = new Map();

  for (const node of nodes) {
    if (!isRecord(node) || !validId(node.id)) continue;
    if (node.parent_id != null && (!validId(node.parent_id) || !nodeIds.has(node.parent_id))) {
      errors.push(`${node.id}: 父节点引用无效`);
    }
    if (!Array.isArray(node.children_ids)) {
      errors.push(`${node.id}: children_ids 必须是数组`);
    } else {
      const children = new Set();
      for (const childId of node.children_ids) {
        if (!validId(childId) || !nodeIds.has(childId)) errors.push(`${node.id}: 子节点引用无效`);
        else if (children.has(childId)) errors.push(`${node.id}: 子节点引用重复`);
        children.add(childId);
      }
    }
    if (!validId(node.branch_id) || !branchIds.has(node.branch_id)) {
      errors.push(`${node.id}: 分支引用无效`);
    }
    if (hasOwn(node, 'turn_number') && !isNonNegativeInteger(node.turn_number)) {
      errors.push(`${node.id}: turn_number 必须是非负整数`);
    }
    if (hasOwn(node, 'depth') && !isNonNegativeInteger(node.depth)) {
      errors.push(`${node.id}: depth 必须是非负整数`);
    }
    if (node.shinobi_daily != null) {
      const dailyResult = validateShinobiDaily(node.shinobi_daily);
      if (!dailyResult.valid) {
        errors.push(`${node.id}: shinobi_daily 忍界日报无效 (${dailyResult.errors.slice(0, 3).join('; ')})`);
      }
    }
    if (node.payload_encoding != null || Object.prototype.hasOwnProperty.call(node, 'payload')) {
      errors.push(`${node.id}: 存档文件不能包含本地 gzip 载荷，导出前必须先解压`);
    }
    if (node.state_snapshot != null && !isRecord(node.state_snapshot)) {
      errors.push(`${node.id}: state_snapshot 状态快照必须是 JSON 对象或 null`);
    } else if (isRecord(node.state_snapshot) && findUnsafeSnapshotKey(node.state_snapshot)) {
      errors.push(`${node.id}: state_snapshot 状态快照包含不安全键`);
    } else if (isRecord(node.state_snapshot) && findForbiddenTimelineMedia(node.state_snapshot, 'state_snapshot')) {
      errors.push(`${node.id}: state_snapshot 状态快照包含图片二进制、Base64 或 blob URL`);
    } else if (isRecord(node.state_snapshot)
        && hasOwn(node.state_snapshot, '_meta')
        && node.state_snapshot._meta != null
        && !isRecord(node.state_snapshot._meta)) {
      errors.push(`${node.id}: state_snapshot._meta 必须是 JSON 对象或 null`);
    } else if (isRecord(node.state_snapshot)
        && !SUPPORTED_SNAPSHOT_VERSIONS.has(node.state_snapshot._version)) {
      errors.push(`${node.id}: state_snapshot 状态快照版本不受支持`);
    }
    const snapshotLedger = node.state_snapshot?._continuity;
    if (snapshotLedger != null) {
      const ledgerResult = inspectContinuityLedger(snapshotLedger);
      if (!ledgerResult.valid) {
        errors.push(`${node.id}: 连续性账本无效 (${ledgerResult.errors.slice(0, 3).join('; ')})`);
      }
    }
    if (hasOwn(node, 'continuity_revision')) {
      if (!isNonNegativeInteger(node.continuity_revision)) {
        errors.push(`${node.id}: continuity_revision 必须是非负整数`);
      } else if (snapshotLedger && node.continuity_revision !== snapshotLedger.revision) {
        errors.push(`${node.id}: continuity_revision 与状态快照账本版本不一致`);
      }
    }
    if (node.continuity_delta != null && !Array.isArray(node.continuity_delta)) {
      errors.push(`${node.id}: continuity_delta 必须是数组`);
    } else if (Array.isArray(node.continuity_delta)) {
      let previousSequence = -1;
      const snapshotEvents = new Map(
        (Array.isArray(snapshotLedger?.events) ? snapshotLedger.events : [])
          .filter(event => isRecord(event) && validId(event.event_id))
          .map(event => [event.event_id, event])
      );
      for (let index = 0; index < node.continuity_delta.length; index++) {
        const event = node.continuity_delta[index];
        const eventResult = inspectMemoryEvent(event);
        if (!eventResult.valid) {
          errors.push(`${node.id}: continuity_delta[${index}] 无效 (${eventResult.errors.join(', ')})`);
          continue;
        }
        const owner = continuityEventOwners.get(event.event_id);
        if (owner) errors.push(`${event.event_id}: continuity_delta 同时属于 ${owner} 与 ${node.id}`);
        else continuityEventOwners.set(event.event_id, node.id);
        if (event.sequence <= previousSequence) errors.push(`${node.id}: continuity_delta sequence 必须递增`);
        previousSequence = event.sequence;
        const snapshotEvent = snapshotEvents.get(event.event_id);
        if (snapshotLedger && !snapshotEvent) {
          errors.push(`${node.id}: continuity_delta 事件未写入同节点状态快照 (${event.event_id})`);
        } else if (snapshotEvent && JSON.stringify(snapshotEvent) !== JSON.stringify(event)) {
          errors.push(`${node.id}: continuity_delta 与状态快照事件内容不一致 (${event.event_id})`);
        }
      }
    }
  }

  const rootNodes = [];
  for (const node of nodeById.values()) {
    if (node.parent_id == null) rootNodes.push(node);
  }
  if (rootNodes.length !== 1) {
    errors.push(`时间线必须恰好一个根节点，实际为 ${rootNodes.length} 个`);
  }
  const childOwners = new Map();
  for (const node of nodeById.values()) {
    if (node.parent_id != null && nodeById.has(node.parent_id)) {
      const parent = nodeById.get(node.parent_id);
      if (!Array.isArray(parent.children_ids) || !childIdsByNode.get(parent.id)?.has(node.id)) {
        errors.push(`${node.id}: 父子关系不一致，父节点未引用该子节点`);
      }
    }
    if (!Array.isArray(node.children_ids)) continue;
    for (const childId of node.children_ids) {
      if (!nodeById.has(childId)) continue;
      const owner = childOwners.get(childId);
      if (owner && owner !== node.id) {
        errors.push(`${childId}: 被多个父节点引用`);
      } else {
        childOwners.set(childId, node.id);
      }
      if (nodeById.get(childId).parent_id !== node.id) {
        errors.push(`${node.id}: 父子关系不一致，子节点未反向引用该父节点`);
      }
      const child = nodeById.get(childId);
      if (Number.isInteger(node.turn_number)
          && Number.isInteger(child.turn_number)
          && child.turn_number < node.turn_number) {
        errors.push(`${childId}: turn_number 不能早于父节点 ${node.id}`);
      }
      if (Number.isInteger(node.depth)
          && Number.isInteger(child.depth)
          && child.depth !== node.depth + 1) {
        errors.push(`${childId}: depth 必须等于父节点 ${node.id} 的 depth + 1`);
      }
    }
  }
  const checkedParentChains = new Set();
  for (const startId of nodeById.keys()) {
    if (checkedParentChains.has(startId)) continue;
    const path = [];
    const pathPositions = new Map();
    let cursorId = startId;
    while (cursorId != null && nodeById.has(cursorId) && !checkedParentChains.has(cursorId)) {
      if (pathPositions.has(cursorId)) {
        errors.push(`时间线父节点关系包含环: ${path.slice(pathPositions.get(cursorId)).join(' -> ')} -> ${cursorId}`);
        break;
      }
      pathPositions.set(cursorId, path.length);
      path.push(cursorId);
      cursorId = nodeById.get(cursorId).parent_id;
    }
    for (const id of path) checkedParentChains.add(id);
  }

  for (const branch of branches) {
    if (!isRecord(branch) || !validId(branch.id)) continue;
    if (branch.color != null && !validColor(branch.color)) {
      errors.push(`${branch.id}: 分支颜色无效`);
    }
    if (!validId(branch.head_node_id) || !nodeIds.has(branch.head_node_id)) {
      errors.push(`${branch.id}: 头节点引用无效`);
    } else if (nodeById.get(branch.head_node_id)?.branch_id !== branch.id) {
      errors.push(`${branch.id}: 头节点不属于该分支`);
    }
    if (branch.diverged_from != null && (!validId(branch.diverged_from) || !nodeIds.has(branch.diverged_from))) {
      errors.push(`${branch.id}: 分歧节点引用无效`);
    }
    if (hasOwn(branch, 'node_count')) {
      if (!isNonNegativeInteger(branch.node_count)) {
        errors.push(`${branch.id}: node_count 必须是非负整数`);
      } else {
        const actualCount = branchNodeCounts.get(branch.id) || 0;
        if (branch.node_count !== actualCount) {
          errors.push(`${branch.id}: node_count 与分支节点数不一致`);
        }
      }
    }
    if (hasOwn(branch, 'is_active') && typeof branch.is_active !== 'boolean') {
      errors.push(`${branch.id}: is_active 必须是布尔值`);
    }
  }

  const meta = data.meta?.value || data.timeline?.meta || data.meta || {};
  if (!isRecord(meta)) errors.push('时间线元数据必须是对象');
  for (const [field, ids, label] of [
    ['root_id', nodeIds, '根节点'],
    ['current_id', nodeIds, '当前节点'],
    ['active_branch', branchIds, '活动分支']
  ]) {
    if (!validId(meta[field]) || !ids.has(meta[field])) {
      errors.push(`${label}引用无效`);
    }
  }

  if (rootNodes.length === 1 && meta.root_id !== rootNodes[0].id) {
    errors.push('meta.root_id 与唯一根节点不一致');
  }
  const currentNode = nodeById.get(meta.current_id);
  if (currentNode && validId(meta.active_branch) && currentNode.branch_id !== meta.active_branch) {
    errors.push('当前节点不属于活动分支');
  }

  const explicitActiveBranches = [];
  let hasAnyActiveFlag = false;
  for (const branch of branches) {
    if (!isRecord(branch)) continue;
    if (branch.is_active === true) explicitActiveBranches.push(branch);
    if (hasOwn(branch, 'is_active')) hasAnyActiveFlag = true;
  }
  if (hasAnyActiveFlag) {
    if (explicitActiveBranches.length !== 1) {
      errors.push(`分支 is_active 活动标记必须唯一，实际为 ${explicitActiveBranches.length} 个`);
    } else if (explicitActiveBranches[0].id !== meta.active_branch) {
      errors.push('分支 is_active 活动标记与 meta.active_branch 不匹配');
    }
  }

  if (hasOwn(meta, 'total_nodes')) {
    if (!isNonNegativeInteger(meta.total_nodes)) {
      errors.push('meta.total_nodes 必须是非负整数');
    } else if (meta.total_nodes !== nodes.length) {
      errors.push('meta.total_nodes 与实际节点数不一致');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function inspectTimelineSave(data) {
  try {
    return inspectTimelineSaveInternal(data);
  } catch (error) {
    return {
      valid: false,
      errors: [`存档包含无法校验的结构: ${error?.message || '未知错误'}`]
    };
  }
}

export function assertTimelineSave(data) {
  const result = inspectTimelineSave(data);
  if (!result.valid) throw new Error(`存档格式无效: ${result.errors.slice(0, 4).join('; ')}`);
  return data;
}
