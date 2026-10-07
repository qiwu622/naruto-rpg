import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { normalizeTurnReceipt } from '../core/turn-receipt.js';
import { prepareMemoryCorrection } from '../core/memory-corrections.js';
import {
  assertTimelineSave,
  findForbiddenTimelineMedia,
  sanitizeTimelineNode,
  sanitizeTimelinePersistenceValue,
  sanitizeTimelineSnapshot
} from '../core/timeline-save-schema.js';
import {
  diffContinuityLedgers,
  prepareContinuityCommit,
  remapContinuityDelta,
  remapContinuityLedger
} from '../core/continuity-ledger.js';
import { encodeTimelineSave } from '../core/timeline-file-codec.js';
import { exportFile } from '../core/file-export.js';
import {
  TIMELINE_HOT_WINDOW,
  collectHotNodeIds,
  compressTimelineNode,
  decompressTimelineNode,
  estimateTimelineNodeBytes,
  isCompressedTimelineNode
} from '../core/timeline-node-codec.js';
import { formatGameTime, generateId, generateNodeId, truncate, getNextBranchColor, deepClone } from '../utils/format.js';

const ARCHIVE_ANCESTOR_KEEP = TIMELINE_HOT_WINDOW;
const IMAGE_STATE_SNAPSHOT_SLICES = new Set(['_relationships', '_image_worldbook_overlay']);
const NON_AGENT_MULTIPLAYER_META_FIELD = '_multiplayer_non_agent_metadata';

// Atomic branch operations decompress a read copy, without changing IndexedDB
// first. Reject a changed source before using that copy inside the transaction.
function sameTimelineNodeRead(left, right) {
  if (!left || !right) return false;
  const { payload: leftPayload, ...leftFields } = left;
  const { payload: rightPayload, ...rightFields } = right;
  if (JSON.stringify(leftFields) !== JSON.stringify(rightFields)) return false;
  if (leftPayload == null || rightPayload == null) return leftPayload == null && rightPayload == null;
  const bytes = value => value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : Array.isArray(value) ? Uint8Array.from(value) : null;
  const a = bytes(leftPayload), b = bytes(rightPayload);
  return Boolean(a && b && a.length === b.length && a.every((value, index) => value === b[index]));
}
const PERSONAL_MULTIPLAYER_TIMELINE_SCHEMA = 'naruto.multiplayer-personal-timeline/v1';
const MULTIPLAYER_TO_SINGLEPLAYER_CODEC = 'naruto.multiplayer-to-singleplayer/v1';
const MULTIPLAYER_RECORD_SIDECAR_SCHEMA = 'naruto.multiplayer-record-sidecar/v1';
const SERVER_REIMPORT_CAPSULE_SCHEMA = 'naruto.multiplayer-server-reimport-capsule/v1';
export const LINGXI_TIMELINE_IMPACT_SCHEMA = 'naruto.lingxi-timeline-impact/v1';

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNonAgentMultiplayerMetadata(data) {
  const fields = [
    'schema',
    'codec',
    'multiplayer_export',
    'multiplayer_record_sidecar'
  ];
  const multiplayerFieldsPresent = [
    'multiplayer_export',
    'multiplayer_record_sidecar'
  ].some(field => Object.prototype.hasOwnProperty.call(data, field));
  if (!multiplayerFieldsPresent) return null;
  const present = fields.filter(field => Object.prototype.hasOwnProperty.call(data, field));
  if (present.length !== fields.length
    || data.schema !== PERSONAL_MULTIPLAYER_TIMELINE_SCHEMA
    || data.codec !== MULTIPLAYER_TO_SINGLEPLAYER_CODEC
    || !isPlainRecord(data.multiplayer_export)
    || !isPlainRecord(data.multiplayer_record_sidecar)) {
    throw new Error('联机个人存档的 non-Agent 元数据不完整');
  }
  const sidecar = data.multiplayer_record_sidecar;
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
  if (sidecar.actor_bindings.some(binding => (
    !isPlainRecord(binding)
    || binding.inject_to_agent !== false
    || typeof binding.opaque_binding_token !== 'string'
    || !binding.opaque_binding_token
  )) || sidecar.multiplayer_records.some(record => (
    !isPlainRecord(record) || record.inject_to_agent !== false
  ))) {
    throw new Error('联机个人存档包含可注入 Agent 的 sidecar 条目');
  }
  const agentVisibleTimeline = JSON.stringify({
    nodes: data.nodes,
    branches: data.branches,
    meta: data.meta
  });
  if (sidecar.actor_bindings.some(binding => (
    agentVisibleTimeline.includes(binding.opaque_binding_token)
  ))) {
    throw new Error('联机角色绑定 token 不能进入 Agent 可见时间线');
  }
  return sanitizeTimelinePersistenceValue({
    schema: data.schema,
    codec: data.codec,
    multiplayer_export: data.multiplayer_export,
    multiplayer_record_sidecar: sidecar
  }, 'timeline_non_agent_multiplayer_metadata');
}

function splitPersistedTimelineMeta(metaEntry) {
  if (!isPlainRecord(metaEntry) || !isPlainRecord(metaEntry.value)) {
    return { meta: metaEntry, multiplayer: null };
  }
  const {
    [NON_AGENT_MULTIPLAYER_META_FIELD]: multiplayer,
    ...value
  } = metaEntry.value;
  return {
    meta: { ...metaEntry, value },
    multiplayer: isPlainRecord(multiplayer)
      ? sanitizeTimelinePersistenceValue(multiplayer, 'timeline_non_agent_multiplayer_metadata')
      : null
  };
}

function persistenceValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => persistenceValuesEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && persistenceValuesEqual(left[key], right[key])
    ));
}

function compareTimelinePosition(left, right) {
  return (Number(left?.depth) || 0) - (Number(right?.depth) || 0)
    || (Number(left?.turn_number) || 0) - (Number(right?.turn_number) || 0)
    || (Number(left?.created_at || left?.real_timestamp) || 0)
      - (Number(right?.created_at || right?.real_timestamp) || 0)
    || String(left?.id || '').localeCompare(String(right?.id || ''));
}

function latestTimelineNode(nodes = []) {
  return [...nodes].sort(compareTimelinePosition).at(-1) || null;
}

function collectForwardDescendantIds(targetNodeId, nodes = []) {
  const byId = new Map(nodes.filter(node => node?.id).map(node => [node.id, node]));
  const descendantIds = new Set();
  const pending = [];
  const target = byId.get(targetNodeId);
  if (Array.isArray(target?.children_ids)) pending.push(...target.children_ids);
  while (pending.length) {
    const nodeId = pending.pop();
    if (!nodeId || nodeId === targetNodeId || descendantIds.has(nodeId)) continue;
    const node = byId.get(nodeId);
    if (!node) continue;
    descendantIds.add(nodeId);
    if (!Array.isArray(node.children_ids)) throw new Error(`节点 ${nodeId} children_ids 无效`);
    pending.push(...node.children_ids);
  }
  for (const node of nodes) {
    if (!node?.id || node.id === targetNodeId || descendantIds.has(node.id)) continue;
    const visited = new Set();
    let cursor = node;
    while (cursor?.parent_id) {
      if (visited.has(cursor.id)) break;
      visited.add(cursor.id);
      if (cursor.parent_id === targetNodeId) {
        descendantIds.add(node.id);
        break;
      }
      cursor = byId.get(cursor.parent_id);
    }
  }
  return descendantIds;
}

function remapNodeRuntimeBranch(node, branchId) {
  const next = { ...node, branch_id: branchId };
  if (!node?.state_snapshot || typeof node.state_snapshot !== 'object' || Array.isArray(node.state_snapshot)) {
    return next;
  }
  const snapshot = deepClone(node.state_snapshot);
  snapshot._meta = snapshot._meta && typeof snapshot._meta === 'object' && !Array.isArray(snapshot._meta)
    ? snapshot._meta
    : {};
  snapshot._meta.current_node_id = node.id;
  snapshot._meta.active_branch = branchId;
  for (const key of ['_story_direction', '_agent_story_plan']) {
    if (!snapshot[key] || typeof snapshot[key] !== 'object' || Array.isArray(snapshot[key])) continue;
    if (snapshot[key].branchId === node.branch_id) snapshot[key].branchId = branchId;
  }
  next.state_snapshot = snapshot;
  return next;
}

function timelineStoryState(snapshot = {}) {
  return {
    direction: deepClone(snapshot?._story_direction ?? null),
    plan: deepClone(snapshot?._agent_story_plan ?? null),
    invalidated: snapshot?._agent_story_plan_invalidated === true
  };
}

function staleStoryPersistence(message, details = null) {
  const error = new Error(message);
  error.code = 'LINGXI_PROPOSAL_STALE';
  if (details) error.details = details;
  return error;
}

function maintenanceTimelineImpact(parentNode, activeBranchId) {
  const parentNodeId = String(parentNode?.id || '');
  const branchId = String(activeBranchId || 'branch_main');
  return {
    schema: LINGXI_TIMELINE_IMPACT_SCHEMA,
    operation: 'create-maintenance-checkpoint',
    parentNodeId,
    activeBranchId: branchId,
    createsIfBranch: false,
    createsTurn: false,
    updatesNode: true,
    branchName: null
  };
}

function assertMaintenanceTimelineImpact(expected, actual) {
  const valid = expected
    && typeof expected === 'object'
    && !Array.isArray(expected)
    && expected.schema === actual.schema
    && expected.operation === actual.operation
    && expected.parentNodeId === actual.parentNodeId
    && expected.activeBranchId === actual.activeBranchId
    && expected.createsIfBranch === actual.createsIfBranch
    && expected.createsTurn === actual.createsTurn
    && expected.updatesNode === actual.updatesNode
    && expected.branchName === actual.branchName;
  if (valid) return;
  const error = new Error('时间线影响已变化，原批准提案不再适用');
  error.code = 'LINGXI_PROPOSAL_STALE';
  error.details = { expected, actual };
  throw error;
}

function buildIllustrationMedia(nodeId, imageContract = null) {
  return {
    illustration: {
      contract_id: imageContract ? `turn:${nodeId}:visual-contract:v1` : null,
      contract: imageContract
        ? sanitizeTimelinePersistenceValue(imageContract, `timeline_node.${nodeId}.media.illustration.contract`)
        : null,
      selected_asset_id: null,
      version_group_id: `turn:${nodeId}:illustration`,
      binding_revision: 0,
      updated_at: Date.now()
    }
  };
}

class TimelineSystem {
  constructor() {
    this._initialized = false;
    this._nodeCache = new Map();
    this._pendingBranchFrom = null;
    this._archiveRunning = false;
    this._archiveQueue = Promise.resolve();
  }

  async init() {
    if (this._initialized) return;
    await stateManager.initDB();
    await this._sanitizeStoredTimelineNodes();
    await this._migrateLegacyMaintenanceNodes();
    this._maybeArchive().catch(err => console.warn('[Timeline] archive failed:', err.message));
    const meta = await stateManager.dbGet('timeline_meta', 'root');
    if (meta) {
      const metaState = stateManager.getSub('_meta') || {};
      metaState.current_node_id = meta.value?.current_id || null;
      metaState.active_branch = meta.value?.active_branch || 'branch_main';
      stateManager.setSub('_meta', metaState);
    }
    this._initialized = true;
  }

  async createRootNode({ summary, stateSnapshot, chatHistory = [], continuityDelta = [] }) {
    const nodeId = generateNodeId(1);
    const createdAt = Date.now();
    const baseSnapshot = this._buildNodeSnapshot(stateSnapshot, nodeId, 'branch_main');
    const { snapshot, delta: committedContinuityDelta } = this._prepareContinuitySnapshot(baseSnapshot, {
      nodeId,
      branchId: 'branch_main',
      turnNumber: 1,
      gameTime: stateSnapshot?.['世界·时间'] || '',
      recordedAt: createdAt,
      continuityDelta
    });
    const node = {
      id: nodeId,
      parent_id: null,
      children_ids: [],
      branch_id: 'branch_main',
      turn_number: 1,
      depth: 0,
      real_timestamp: createdAt,
      game_time: stateSnapshot?.['世界·时间']
        ? formatGameTime(stateSnapshot['世界·时间'])
        : '游戏开始',
      player_input: '(游戏开始 - 角色创建完成)',
      ai_response_summary: summary || '冒险开始',
      state_snapshot: snapshot,
      continuity_delta: committedContinuityDelta,
      continuity_revision: snapshot._continuity.revision,
      chat_history_delta: deepClone(chatHistory).slice(-40),
      chat_history: null,
      summary: summary || '冒险开始',
      tags: [],
      is_checkpoint: false,
      created_at: createdAt,
      accessed_count: 0,
      archived: false,
      archived_at: null
    };

    const branch = {
      id: 'branch_main',
      name: '主线',
      color: '#eb613f',
      description: '默认时间线',
      created_at: Date.now(),
      diverged_from: null,
      diverged_at_turn: null,
      head_node_id: nodeId,
      node_count: 1,
      is_active: true
    };
    const metaEntry = {
      key: 'root',
      value: { root_id: nodeId, current_id: nodeId, active_branch: 'branch_main', total_nodes: 1 }
    };
    await this._commitInitialTimeline(node, branch, metaEntry);

    const metaState = stateManager.getSub('_meta') || {};
    metaState.current_node_id = nodeId;
    metaState.active_branch = 'branch_main';
    stateManager.setSub('_meta', metaState);
    this._commitLiveContinuity(node);

    this._cacheTreeSummary();
    eventBus.emit('timeline:node-created', node);
    eventBus.emit('timeline:branch-created', branch);

    return node;
  }

  async createNode({
    turnNumber,
    playerInput,
    aiResponse,
    cleanResponse,
    stateSnapshot,
    chatHistory = [],
    memorySummary = null,
    imageContract = null,
    shinobiDaily = null,
    turnReceipt = null,
    continuityDelta = [],
    maintenance = null,
    expectedMaintenanceImpact = null
  }, { validateCurrent = null } = {}) {
    validateCurrent?.();
    if (maintenance !== null || expectedMaintenanceImpact !== null) {
      const error = new Error('createNode 不接受维护写入，请使用 createMaintenanceCheckpoint');
      error.code = 'TIMELINE_MAINTENANCE_REQUIRES_ATTACHMENT';
      throw error;
    }
    const meta = stateManager.getSub('_meta') || {};
    const currentId = meta.current_node_id;
    const activeBranch = meta.active_branch;
    const turnCount = turnNumber !== undefined
      ? turnNumber
      : Math.max(1, Number(stateManager.get('系统·回合数')) || 1);

    if (!currentId) {
      const nodeId = generateNodeId(turnCount);
      const createdAt = Date.now();
      const baseSnapshot = this._buildNodeSnapshot(stateSnapshot, nodeId, 'branch_main');
      const { snapshot, delta: committedContinuityDelta } = this._prepareContinuitySnapshot(baseSnapshot, {
        nodeId,
        branchId: 'branch_main',
        turnNumber: turnCount,
        gameTime: stateSnapshot?.['世界·时间'] || '',
        recordedAt: createdAt,
        continuityDelta
      });
      const cleanAiResponse = (aiResponse || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '').trim();
      const cleanPlayerInput = (playerInput || '').replace(/<[^>]*>/g, '').trim();
      const summary = truncate(memorySummary || cleanAiResponse || cleanPlayerInput, 200);
      const delta = this._extractChatDelta(chatHistory);
      const node = {
        id: nodeId, parent_id: null, children_ids: [], branch_id: 'branch_main',
        turn_number: turnCount, depth: 0, real_timestamp: createdAt,
        game_time: stateSnapshot?.['世界·时间'] ? formatGameTime(stateSnapshot['世界·时间']) : '游戏开始',
        player_input: truncate(cleanPlayerInput, 200),
        ai_response_summary: truncate(cleanAiResponse, 200),
        clean_response: cleanResponse || aiResponse || '',
        turn_receipt: normalizeTurnReceipt(turnReceipt),
        shinobi_daily: shinobiDaily
          ? sanitizeTimelinePersistenceValue(shinobiDaily, `timeline_node.${nodeId}.shinobi_daily`)
          : null,
        media: buildIllustrationMedia(nodeId, imageContract),
        state_snapshot: snapshot,
        continuity_delta: committedContinuityDelta,
        continuity_revision: snapshot._continuity.revision,
        chat_history_delta: delta,
        chat_history: null,
        summary: summary,
        tags: [],
        is_checkpoint: true,
        created_at: createdAt,
        accessed_count: 0,
        archived: false, archived_at: null
      };
      const branch = { id: 'branch_main', name: '主线', color: '#eb613f', description: '默认时间线', created_at: Date.now(), diverged_from: null, diverged_at_turn: null, head_node_id: nodeId, node_count: 1, is_active: true };
      const metaEntry = { key: 'root', value: { root_id: nodeId, current_id: nodeId, active_branch: 'branch_main', total_nodes: 1 } };
      await this._commitInitialTimeline(node, branch, metaEntry, { validateCurrent });
      validateCurrent?.();
      const metaState = stateManager.getSub('_meta') || {};
      metaState.current_node_id = nodeId;
      metaState.active_branch = 'branch_main';
      stateManager.setSub('_meta', metaState);
      this._commitLiveContinuity(node);
      this._cacheTreeSummary();
      eventBus.emit('timeline:node-created', node);
      eventBus.emit('timeline:branch-created', branch);
      return node;
    }

    const nodeId = generateNodeId(turnCount);
    const cleanAiResponse = (aiResponse || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '').trim();
    const cleanPlayerInput = (playerInput || '').replace(/<[^>]*>/g, '').trim();
    const summary = truncate(memorySummary || cleanPlayerInput || cleanAiResponse, 200);
    const delta = this._extractChatDelta(chatHistory);
    const shouldCreateBranch = this._pendingBranchFrom === currentId;
    const newBranchId = shouldCreateBranch ? generateId('branch') : null;
    const expectedBranchId = activeBranch || 'branch_main';
    const createdAt = Date.now();
    await this._hydratePersistedNode(currentId, { validateCurrent });
    validateCurrent?.();
    const transactionResult = await stateManager.dbMutateTimeline(({ nodes, branches, meta: storedMetaEntry }) => {
      validateCurrent?.();
      if (!storedMetaEntry?.value) throw new Error('时间线元数据不存在，无法追加节点');
      const parentNode = nodes.find(candidate => candidate.id === currentId);
      if (!parentNode) throw new Error(`当前父节点不存在: ${currentId}`);
      if (storedMetaEntry.value.current_id !== currentId) {
        throw new Error('当前时间线节点已变化，本次追加请求已过期');
      }
      if (!Array.isArray(parentNode.children_ids)) throw new Error(`当前父节点 children_ids 无效: ${currentId}`);
      if (nodes.some(candidate => candidate.id === nodeId)) throw new Error(`时间线节点 ID 已存在: ${nodeId}`);

      const storedActiveBranch = storedMetaEntry.value.active_branch;
      if (storedActiveBranch !== expectedBranchId) {
        throw new Error('当前活动分支已变化，本次追加请求已过期');
      }
      const currentBranch = branches.find(candidate => candidate.id === storedActiveBranch);
      if (!currentBranch) throw new Error(`活动分支不存在: ${storedActiveBranch}`);

      const createBranch = shouldCreateBranch && parentNode.children_ids.length > 0;
      const branchId = createBranch ? newBranchId : storedActiveBranch;
      const baseSnapshot = this._buildNodeSnapshot(stateSnapshot, nodeId, branchId);
      const { snapshot, delta: committedContinuityDelta } = this._prepareContinuitySnapshot(baseSnapshot, {
        parentNode,
        nodeId,
        branchId,
        turnNumber: turnCount,
        gameTime: stateSnapshot?.['世界·时间'] || '',
        recordedAt: createdAt,
        continuityDelta
      });
      const node = {
        id: nodeId,
        parent_id: currentId,
        children_ids: [],
        branch_id: branchId,
        turn_number: turnCount,
        depth: (parentNode.depth || 0) + 1,
        real_timestamp: createdAt,
        game_time: stateSnapshot?.['世界·时间']
          ? formatGameTime(stateSnapshot['世界·时间'])
          : '',
        player_input: truncate(cleanPlayerInput, 200),
        ai_response_summary: truncate(cleanAiResponse, 200),
        clean_response: cleanResponse || aiResponse || '',
        turn_receipt: normalizeTurnReceipt(turnReceipt),
        shinobi_daily: shinobiDaily
          ? sanitizeTimelinePersistenceValue(shinobiDaily, `timeline_node.${nodeId}.shinobi_daily`)
          : null,
        media: buildIllustrationMedia(nodeId, imageContract),
        state_snapshot: snapshot,
        continuity_delta: committedContinuityDelta,
        continuity_revision: snapshot._continuity.revision,
        chat_history_delta: delta,
        chat_history: null,
        summary,
        tags: [],
        is_checkpoint: false,
        created_at: createdAt,
        accessed_count: 0,
        archived: false,
        archived_at: null
      };
      const updatedParent = {
        ...parentNode,
        children_ids: [...parentNode.children_ids, nodeId]
      };

      let createdBranch = null;
      let branchesToCommit;
      if (createBranch) {
        if (branches.some(branch => branch.id === newBranchId)) {
          throw new Error(`时间线分支 ID 已存在: ${newBranchId}`);
        }
        createdBranch = {
          id: newBranchId,
          name: `IF线·${parentNode.summary || '新选择'}`,
          color: getNextBranchColor(),
          description: `从"${parentNode.summary || ''}"分歧`,
          created_at: Date.now(),
          diverged_from: parentNode.id,
          diverged_at_turn: parentNode.turn_number,
          head_node_id: nodeId,
          node_count: 1,
          is_active: true
        };
        branchesToCommit = [
          ...branches.filter(branch => branch.is_active === true).map(branch => ({ ...branch, is_active: false })),
          createdBranch
        ];
      } else {
        if (!Number.isInteger(currentBranch.node_count) || currentBranch.node_count < 0) {
          throw new Error(`活动分支 node_count 无效: ${branchId}`);
        }
        branchesToCommit = [{
          ...currentBranch,
          head_node_id: nodeId,
          node_count: currentBranch.node_count + 1,
          is_active: true
        }];
      }

      if (!Number.isInteger(storedMetaEntry.value.total_nodes) || storedMetaEntry.value.total_nodes < 0) {
        throw new Error('时间线元数据 total_nodes 无效');
      }
      const metaEntry = {
        ...storedMetaEntry,
        value: {
          ...storedMetaEntry.value,
          current_id: nodeId,
          active_branch: branchId,
          total_nodes: storedMetaEntry.value.total_nodes + 1
        }
      };
      return {
        nodes: [node, updatedParent],
        branches: branchesToCommit,
        meta: metaEntry,
        result: { node, createdBranch, branchId }
      };
    }, {
      nodeKeys: [currentId, nodeId],
      branchKeys: shouldCreateBranch ? null : [expectedBranchId],
      validateCurrent
    });
    validateCurrent?.();
    const { node, createdBranch, branchId } = transactionResult;
    if (createdBranch) {
      this._pendingBranchFrom = null;
      eventBus.emit('timeline:branch-created', createdBranch);
    }

    validateCurrent?.();
    const metaState = stateManager.getSub('_meta') || {};
    metaState.current_node_id = nodeId;
    metaState.active_branch = branchId;
    stateManager.setSub('_meta', metaState);
    this._commitLiveContinuity(node);

    this._cacheTreeSummary();
    eventBus.emit('timeline:node-created', node);

    this._maybeArchive().catch(err => console.warn('[Timeline] archive failed:', err.message));
    return node;
  }

  // A correction is a new restorable checkpoint, never an edit to a shared
  // ancestor. It keeps the same story turn and does not duplicate chat history.
  async commitMemoryCorrection(request = {}) {
    await this._archiveQueue;
    const initial = stateManager.snapshot();
    const currentId = initial._meta?.current_node_id;
    const activeBranch = initial._meta?.active_branch;
    if (!currentId) throw new Error('请先开始剧情，再修订本分支的记忆');
    const expected = request.expected;
    if (expected && (expected.nodeId !== currentId || expected.branchId !== activeBranch
      || expected.memory !== JSON.stringify(initial._memory))) {
      throw new Error('记忆或时间线已变化，请刷新后再操作');
    }
    const initialText = JSON.stringify(initial);
    const validateCurrent = () => {
      if (JSON.stringify(stateManager.snapshot()) !== initialText) throw new Error('当前进度已变化，本次记忆修订未保存，请重试');
    };
    const corrected = prepareMemoryCorrection(initial, request);
    const stored = await stateManager.dbGet('timeline_nodes', currentId);
    const source = stored ? await this._hydrateNode(stored) : null;
    if (!source) throw new Error('记忆所在的时间线节点不存在');
    const history = await this._reconstructChatHistory(source);
    const nodeId = generateNodeId(source.turn_number);
    const forkId = generateId('branch');
    const now = Date.now();
    const result = await stateManager.dbMutateTimeline(({ nodes, branches, meta }) => {
      validateCurrent();
      if (meta?.value?.current_id !== currentId || meta.value.active_branch !== activeBranch) throw new Error('当前存档已变化，请重新修订');
      const parent = nodes.find(node => node.id === currentId);
      if (!sameTimelineNodeRead(stored, parent)) throw new Error('当前节点已更新，请重新修订');
      const branch = branches.find(item => item.id === activeBranch);
      if (!branch) throw new Error('当前线路不存在');
      const fork = branch.head_node_id !== currentId || parent.branch_id !== activeBranch || parent.children_ids?.length > 0;
      const branchId = fork ? forkId : activeBranch;
      const anchor = remapNodeRuntimeBranch({
        ...deepClone(source), id: nodeId, parent_id: currentId, children_ids: [],
        depth: (parent.depth || 0) + 1, branch_anchor: true, player_input: '',
        state_snapshot: this._buildNodeSnapshot(corrected, nodeId, activeBranch),
        chat_history: history, chat_history_delta: [], continuity_delta: [],
        maintenance_history: [], maintenance: null, memory_correction: true,
        tags: ['记忆修订'], created_at: now, real_timestamp: now,
        is_checkpoint: true, archived: false, archived_at: null, accessed_count: 0
      }, branchId);
      const updatedParent = { ...parent, children_ids: [...(parent.children_ids || []), nodeId] };
      const nextBranch = fork ? {
        id: branchId, name: 'IF线·记忆修订', description: '从历史节点修订记忆，原线路保留',
        color: getNextBranchColor(), created_at: now, diverged_from: currentId,
        diverged_at_turn: parent.turn_number, head_node_id: nodeId, node_count: 1, is_active: true
      } : { ...branch, head_node_id: nodeId, node_count: branch.node_count + 1 };
      return {
        nodes: [updatedParent, anchor],
        branches: fork ? [...branches.map(item => ({ ...item, is_active: false })), nextBranch] : [nextBranch],
        meta: { ...meta, value: { ...meta.value, current_id: nodeId, active_branch: branchId, total_nodes: meta.value.total_nodes + 1 } },
        result: { anchor, updatedParent, branch: nextBranch, fork, prepared: this._prepareNodeRestore(anchor) }
      };
    }, { nodeKeys: [currentId, nodeId], validateCurrent });
    stateManager.commitPreparedRestore(result.prepared);
    this._pendingBranchFrom = null;
    this._nodeCache.set(nodeId, result.anchor);
    this._nodeCache.set(currentId, result.updatedParent);
    this._cacheTreeSummary();
    if (result.fork) eventBus.emit('timeline:branch-created', result.branch);
    eventBus.emit('timeline:node-created', result.anchor);
    eventBus.emit('memory:corrected', { nodeId, action: request.action });
    return result.anchor;
  }

  async createMaintenanceCheckpoint({
    label = '变量维护',
    reason = '',
    proposalId = '',
    stateSnapshot = null,
    expectedImpact = null
  } = {}) {
    const meta = stateManager.getSub('_meta') || {};
    const previousNodeId = meta.current_node_id;
    if (!previousNodeId) throw new Error('当前没有可作为维护检查点父级的时间线节点');
    const expectedBranchId = String(meta.active_branch || 'branch_main');

    const safeLabel = truncate(String(label || '变量维护').replace(/[<>]/g, ''), 80);
    const safeReason = truncate(String(reason || '').replace(/[<>]/g, ''), 300);
    const createdAt = Date.now();
    const sourceSnapshot = stateSnapshot || stateManager.snapshot();
    if (!sourceSnapshot || typeof sourceSnapshot !== 'object' || Array.isArray(sourceSnapshot)) {
      throw new TypeError('灵希维护需要有效的状态快照');
    }
    // Sanitize before opening the transaction. The transaction mutator must
    // remain synchronous and must never persist live object references.
    await this._hydratePersistedNode(previousNodeId);
    const approvedSnapshot = sanitizeTimelineSnapshot(sourceSnapshot);
    const maintenance = {
      type: 'lingxi-variable-maintenance',
      label: safeLabel,
      proposal_id: truncate(String(proposalId || ''), 240),
      previous_node_id: previousNodeId,
      reason: safeReason,
      created_at: createdAt
    };
    const mutation = await stateManager.dbMutateTimeline(({ nodes, meta: storedMeta }) => {
      if (!storedMeta?.value
        || storedMeta.value.current_id !== previousNodeId
        || storedMeta.value.active_branch !== expectedBranchId) {
        const error = new Error('当前时间线节点或分支已经变化，维护提案已过期');
        error.code = 'LINGXI_PROPOSAL_STALE';
        error.details = {
          expectedNodeId: previousNodeId,
          currentNodeId: storedMeta?.value?.current_id || null,
          expectedBranchId,
          currentBranchId: storedMeta?.value?.active_branch || null
        };
        throw error;
      }
      const node = nodes.find(candidate => candidate?.id === previousNodeId);
      if (!node || node.branch_id !== expectedBranchId) {
        const error = new Error('当前时间线节点不存在或不属于活动分支，维护提案已过期');
        error.code = 'LINGXI_PROPOSAL_STALE';
        throw error;
      }
      const actualImpact = maintenanceTimelineImpact(node, expectedBranchId);
      if (expectedImpact !== null) assertMaintenanceTimelineImpact(expectedImpact, actualImpact);

      const beforeSnapshot = node.state_snapshot && typeof node.state_snapshot === 'object'
        ? deepClone(node.state_snapshot)
        : null;
      let nextSnapshot = this._buildNodeSnapshot(approvedSnapshot, node.id, node.branch_id);

      // A variable maintenance must not silently remove continuity events
      // already committed to the current turn. Preserve the existing ledger
      // when a caller supplies a partial snapshot; reject destructive changes.
      const previousLedger = beforeSnapshot?._continuity;
      if (previousLedger && !nextSnapshot._continuity) {
        nextSnapshot._continuity = deepClone(previousLedger);
      }
      let appendedContinuity = [];
      if (Number.isInteger(previousLedger?.revision)
        && Number.isInteger(nextSnapshot._continuity?.revision)
        && nextSnapshot._continuity.revision < previousLedger.revision) {
        const stale = new Error('灵希维护提交的连续性账本版本过旧');
        stale.code = 'LINGXI_PROPOSAL_STALE';
        throw stale;
      }
      try {
        const prepared = this._prepareContinuitySnapshot(nextSnapshot, {
          parentNode: node,
          nodeId: node.id,
          branchId: node.branch_id,
          turnNumber: node.turn_number,
          gameTime: nextSnapshot?.['世界·时间'] || node.game_time || '',
          recordedAt: createdAt,
          continuityDelta: []
        });
        nextSnapshot = prepared.snapshot;
        appendedContinuity = prepared.delta;
      } catch (error) {
        const stale = new Error(`灵希维护不能覆盖当前回合的连续性账本: ${error.message}`);
        stale.code = 'LINGXI_PROPOSAL_STALE';
        stale.cause = error;
        throw stale;
      }
      const existingDelta = Array.isArray(node.continuity_delta)
        ? deepClone(node.continuity_delta)
        : [];
      const existingEventIds = new Set(existingDelta.map(event => event?.event_id).filter(Boolean));
      const continuityDelta = existingDelta.concat(
        appendedContinuity.filter(event => event?.event_id && !existingEventIds.has(event.event_id))
      );

      const existingHistory = Array.isArray(node.maintenance_history)
        ? node.maintenance_history.map(item => sanitizeTimelinePersistenceValue(item, `timeline_node.${node.id}.maintenance_history`))
        : [];
      const maintenanceRecord = sanitizeTimelinePersistenceValue({
        ...maintenance,
        before_state_snapshot: beforeSnapshot
          ? sanitizeTimelineSnapshot(beforeSnapshot)
          : null
      }, `timeline_node.${node.id}.maintenance`);
      const updatedNode = {
        ...node,
        state_snapshot: nextSnapshot,
        continuity_delta: continuityDelta,
        continuity_revision: Number.isInteger(nextSnapshot._continuity?.revision)
          ? nextSnapshot._continuity.revision
          : node.continuity_revision,
        maintenance_history: [...existingHistory, maintenanceRecord],
        maintenance: maintenanceRecord
      };
      return {
        nodes: [updatedNode],
        result: { node: updatedNode, maintenance: maintenanceRecord, previousNodeId }
      };
    }, { nodeKeys: [previousNodeId], branchKeys: [] });

    const node = mutation.node;
    this._nodeCache.set(node.id, node);
    this._commitLiveContinuity(node);
    this._cacheTreeSummary();
    eventBus.emit('timeline:node-updated', node);
    eventBus.emit('timeline:maintenance-attached', {
      node,
      previousNodeId,
      proposalId: maintenance.proposal_id,
      maintenance: mutation.maintenance
    });
    // Compatibility event for integrations that still use the old name. It
    // deliberately carries the existing node and never represents a new turn.
    eventBus.emit('timeline:maintenance-checkpoint', {
      node,
      previousNodeId,
      proposalId: maintenance.proposal_id,
      attached: true
    });
    return node;
  }

  async previewMaintenanceCheckpoint() {
    const meta = stateManager.getSub('_meta') || {};
    const parentNodeId = meta.current_node_id;
    const activeBranchId = meta.active_branch || 'branch_main';
    if (!parentNodeId) throw new Error('当前没有可作为维护检查点父级的时间线节点');

    const [parentNode, storedMeta] = await Promise.all([
      stateManager.dbGet('timeline_nodes', parentNodeId),
      stateManager.dbGet('timeline_meta', 'root')
    ]);
    if (!parentNode) throw new Error(`当前时间线父节点不存在: ${parentNodeId}`);
    if (!storedMeta?.value
      || storedMeta.value.current_id !== parentNodeId
      || storedMeta.value.active_branch !== activeBranchId) {
      const error = new Error('时间线状态与持久化元数据不一致，不能创建维护提案');
      error.code = 'LINGXI_PROPOSAL_STALE';
      throw error;
    }
    return maintenanceTimelineImpact(parentNode, activeBranchId);
  }

  async setIllustrationContract(nodeId, imageContract) {
    const updatedNode = await stateManager.dbMutateTimeline(({ nodes }) => {
      const node = nodes.find(candidate => candidate?.id === nodeId);
      if (!node) {
        const error = new Error(`时间线节点不存在: ${nodeId}`);
        error.code = 'TARGET_GONE';
        throw error;
      }
      const current = node.media?.illustration || buildIllustrationMedia(nodeId).illustration;
      const updated = {
        ...node,
        media: {
          ...(node.media || {}),
          illustration: {
            ...current,
            contract_id: imageContract ? `turn:${nodeId}:visual-contract:v1` : null,
            contract: imageContract
              ? sanitizeTimelinePersistenceValue(imageContract, `timeline_node.${nodeId}.media.illustration.contract`)
              : null,
            updated_at: Date.now()
          }
        }
      };
      return { nodes: [updated], result: updated };
    }, { nodeKeys: [nodeId], branchKeys: [] });
    this._nodeCache.set(nodeId, updatedNode);
    eventBus.emit('timeline:media-changed', { nodeId, media: updatedNode.media });
    return updatedNode.media.illustration;
  }

  async bindIllustration(nodeId, {
    assetId = null,
    expectedRevision = null,
    authoritativeRevision = null,
    versionGroupId = null,
    jobId = null
  } = {}) {
    const mutation = await stateManager.dbMutateTimeline(({ nodes }) => {
      const node = nodes.find(candidate => candidate?.id === nodeId);
      if (!node) return { result: { status: 'missing', nodeId } };
      const current = node.media?.illustration || buildIllustrationMedia(nodeId).illustration;
      const revision = Number(current.binding_revision) || 0;
      const hasAuthoritativeRevision = authoritativeRevision !== null
        && Number.isSafeInteger(Number(authoritativeRevision))
        && Number(authoritativeRevision) >= 0;
      const remoteRevision = hasAuthoritativeRevision ? Number(authoritativeRevision) : null;
      if (hasAuthoritativeRevision && remoteRevision < revision) {
        return { result: { status: 'stale', nodeId, revision, selectedAssetId: current.selected_asset_id || null } };
      }
      if (!hasAuthoritativeRevision && expectedRevision !== null && Number(expectedRevision) !== revision) {
        return { result: { status: 'stale', nodeId, revision, selectedAssetId: current.selected_asset_id || null } };
      }
      if (hasAuthoritativeRevision
        && remoteRevision === revision
        && (current.selected_asset_id || null) === (assetId || null)) {
        return { result: { status: 'unchanged', nodeId, ...current } };
      }
      const illustration = {
        ...current,
        selected_asset_id: assetId || null,
        version_group_id: versionGroupId || current.version_group_id || `turn:${nodeId}:illustration`,
        binding_revision: hasAuthoritativeRevision ? remoteRevision : revision + 1,
        last_job_id: jobId || current.last_job_id || null,
        updated_at: Date.now()
      };
      const updated = { ...node, media: { ...(node.media || {}), illustration } };
      return { nodes: [updated], result: { status: 'updated', node: updated, illustration } };
    }, { nodeKeys: [nodeId], branchKeys: [] });
    if (mutation.status !== 'updated') return mutation;
    this._nodeCache.set(nodeId, mutation.node);
    eventBus.emit('timeline:media-changed', { nodeId, media: mutation.node.media });
    return { status: 'updated', ...mutation.illustration };
  }

  async syncCurrentImageStateSlices(sliceKeys = []) {
    if (!Array.isArray(sliceKeys)) throw new TypeError('图片状态切片必须是数组');
    const requested = [...new Set(sliceKeys.map(String))];
    const unsupported = requested.filter(key => !IMAGE_STATE_SNAPSHOT_SLICES.has(key));
    if (unsupported.length) throw new TypeError(`不允许同步到时间线的图片状态切片: ${unsupported.join(', ')}`);
    if (!requested.length) return { status: 'noop', slices: [] };

    const liveMeta = stateManager.getSub('_meta') || {};
    const nodeId = liveMeta.current_node_id;
    if (!nodeId) return { status: 'missing-current', slices: requested };

    // Capture and validate before opening the IndexedDB transaction. The
    // transaction mutator must stay synchronous, and image bytes belong in the
    // dedicated image store rather than a timeline/save snapshot.
    const captured = Object.fromEntries(requested.map(key => [
      key,
      sanitizeTimelinePersistenceValue(stateManager.getSub(key), `state_snapshot.${key}`)
    ]));
    await this._hydratePersistedNode(nodeId);

    const mutation = await stateManager.dbMutateTimeline(({ nodes, meta }) => {
      if (meta?.value?.current_id !== nodeId) {
        return {
          result: {
            status: 'stale',
            nodeId,
            currentNodeId: meta?.value?.current_id || null,
            slices: requested
          }
        };
      }
      const node = nodes.find(candidate => candidate?.id === nodeId);
      if (!node) return { result: { status: 'missing', nodeId, slices: requested } };
      if (!node.state_snapshot || typeof node.state_snapshot !== 'object'
        || Array.isArray(node.state_snapshot)) {
        return { result: { status: 'invalid-snapshot', nodeId, slices: requested } };
      }
      const stateSnapshot = deepClone(node.state_snapshot);
      for (const key of requested) stateSnapshot[key] = captured[key];
      const updatedNode = { ...node, state_snapshot: stateSnapshot };
      return {
        nodes: [updatedNode],
        result: { status: 'updated', nodeId, slices: requested, node: updatedNode }
      };
    }, { nodeKeys: [nodeId], branchKeys: [] });

    if (mutation.status !== 'updated') return mutation;
    this._nodeCache.set(nodeId, mutation.node);
    eventBus.emit('timeline:image-state-synced', { nodeId, slices: requested });
    return { status: 'updated', nodeId, slices: requested };
  }

  async persistCurrentStoryState({
    expectedNodeId,
    expectedBranchId,
    before,
    after
  } = {}) {
    const nodeId = String(expectedNodeId || '').trim();
    const branchId = String(expectedBranchId || '').trim();
    if (!nodeId || !branchId) throw new TypeError('剧情方向持久化需要当前节点和分支');
    if (!before || typeof before !== 'object' || Array.isArray(before)
      || !after || typeof after !== 'object' || Array.isArray(after)) {
      throw new TypeError('剧情方向持久化需要 before/after 对象');
    }
    if (typeof before.invalidated !== 'boolean' || typeof after.invalidated !== 'boolean') {
      throw new TypeError('剧情规划失效标记必须是布尔值');
    }

    const expectedBefore = {
      direction: sanitizeTimelinePersistenceValue(before.direction ?? null, 'story_state.before.direction'),
      plan: sanitizeTimelinePersistenceValue(before.plan ?? null, 'story_state.before.plan'),
      invalidated: before.invalidated
    };
    const approvedAfter = {
      direction: sanitizeTimelinePersistenceValue(after.direction ?? null, 'story_state.after.direction'),
      plan: sanitizeTimelinePersistenceValue(after.plan ?? null, 'story_state.after.plan'),
      invalidated: after.invalidated
    };
    await this._hydratePersistedNode(nodeId);

    const mutation = await stateManager.dbMutateTimeline(({ nodes, meta }) => {
      if (!meta?.value
        || meta.value.current_id !== nodeId
        || meta.value.active_branch !== branchId) {
        throw staleStoryPersistence('当前时间线节点或分支已经变化，剧情方向未持久化', {
          expectedNodeId: nodeId,
          currentNodeId: meta?.value?.current_id || null,
          expectedBranchId: branchId,
          currentBranchId: meta?.value?.active_branch || null
        });
      }
      const node = nodes.find(candidate => candidate?.id === nodeId);
      if (!node || node.branch_id !== branchId) {
        throw staleStoryPersistence('当前时间线节点不存在或不属于已批准分支');
      }
      if (!node.state_snapshot || typeof node.state_snapshot !== 'object'
        || Array.isArray(node.state_snapshot)) {
        throw staleStoryPersistence('当前时间线节点没有可更新的状态快照');
      }
      const storedBefore = timelineStoryState(node.state_snapshot);
      if (!persistenceValuesEqual(storedBefore, expectedBefore)) {
        throw staleStoryPersistence('时间线中的剧情方向已被其他提交更新，本次批准内容未覆盖它');
      }
      const stateSnapshot = deepClone(node.state_snapshot);
      stateSnapshot._story_direction = approvedAfter.direction;
      stateSnapshot._agent_story_plan = approvedAfter.plan;
      stateSnapshot._agent_story_plan_invalidated = approvedAfter.invalidated;
      const updatedNode = { ...node, state_snapshot: stateSnapshot };
      return {
        nodes: [updatedNode],
        result: { status: 'updated', nodeId, branchId, node: updatedNode }
      };
    }, { nodeKeys: [nodeId], branchKeys: [] });

    this._nodeCache.set(nodeId, mutation.node);
    eventBus.emit('timeline:story-state-synced', { nodeId, branchId });
    return { status: 'updated', nodeId, branchId };
  }

  async _commitInitialTimeline(node, branch, metaEntry, { validateCurrent = null } = {}) {
    validateCurrent?.();
    return await stateManager.dbMutateTimeline(({ nodes, branches, meta }) => {
      validateCurrent?.();
      if (meta || nodes.length > 0 || branches.length > 0) {
        throw new Error('时间线已经初始化，本次根节点创建请求已过期');
      }
      return {
        nodes: [node],
        branches: [branch],
        meta: metaEntry,
        result: node
      };
    }, { validateCurrent });
  }

  async _sanitizeStoredTimelineNodes() {
    const updatedNodes = await stateManager.dbMutateTimeline(({ nodes }) => {
      const updates = nodes
        .filter(node => !isCompressedTimelineNode(node)
          && findForbiddenTimelineMedia(node, `timeline_node.${node?.id || 'unknown'}`))
        .map(node => sanitizeTimelineNode(node, `timeline_node.${node?.id || 'unknown'}`));
      return { nodes: updates, result: updates };
    }, { branchKeys: [] });
    for (const node of updatedNodes) this._nodeCache.set(node.id, node);
    return updatedNodes.length;
  }

  /**
   * Older builds represented a Ling Xi variable write as a real checkpoint
   * node.  Fold those nodes back into the turn they modified so loading an
   * existing save cannot manufacture an extra turn or branch.  The mutation
   * is deliberately idempotent: attached nodes have maintenance_history and
   * are ignored on subsequent initialisations.
   */
  async _migrateLegacyMaintenanceNodes() {
    const migration = await stateManager.dbMutateTimeline(({ nodes, branches, meta }) => {
      if (!meta?.value || !Array.isArray(nodes) || nodes.length === 0) {
        return { result: { migrated: 0, removedNodeIds: [], removedBranchIds: [] } };
      }

      const nodeById = new Map(nodes.filter(node => node?.id).map(node => [node.id, node]));
      const hasMaintenanceMarker = node => {
        if (!node || !node.id) return false;
        // A node produced by the new implementation is a normal turn with an
        // attached history. Do not mistake it for a legacy checkpoint.
        if (Array.isArray(node.maintenance_history) && node.maintenance_history.length > 0) {
          return false;
        }
        const tagged = (Array.isArray(node.tags) && node.tags.includes('灵希维护'))
          || node.tags === '灵希维护';
        const typed = node.maintenance?.type === 'lingxi-variable-maintenance';
        if (!tagged && !typed) return false;
        // Keep deliberately marked, old checkpoint nodes eligible. Some saves
        // lost the tag but retained the maintenance object, hence both tests.
        return Boolean(node.is_checkpoint || typed || tagged);
      };
      const legacyIds = new Set(nodes.filter(hasMaintenanceMarker).map(node => node.id));
      if (legacyIds.size === 0) {
        return { result: { migrated: 0, removedNodeIds: [], removedBranchIds: [] } };
      }

      const targetMemo = new Map();
      const resolving = new Set();
      const resolveTarget = nodeId => {
        if (!nodeId) return null;
        if (targetMemo.has(nodeId)) return targetMemo.get(nodeId);
        const node = nodeById.get(nodeId);
        if (!node) return null;
        if (!legacyIds.has(nodeId)) {
          targetMemo.set(nodeId, node);
          return node;
        }
        if (resolving.has(nodeId)) return null;
        resolving.add(nodeId);
        const candidates = [
          node.maintenance?.previous_node_id,
          node.parent_id
        ].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index && candidate !== nodeId);
        let target = null;
        for (const candidate of candidates) {
          target = resolveTarget(candidate);
          if (target) break;
        }
        resolving.delete(nodeId);
        targetMemo.set(nodeId, target || null);
        return target || null;
      };

      // A malformed orphan cannot safely be removed. Leave it intact and
      // migrate all well-formed legacy checkpoints in the same transaction.
      const removableIds = new Set();
      const targetByLegacyId = new Map();
      for (const legacyId of legacyIds) {
        const target = resolveTarget(legacyId);
        if (!target || legacyIds.has(target.id)) continue;
        removableIds.add(legacyId);
        targetByLegacyId.set(legacyId, target.id);
      }
      if (removableIds.size === 0) {
        return { result: { migrated: 0, removedNodeIds: [], removedBranchIds: [] } };
      }

      const originalParentById = new Map(nodes.map(node => [node.id, node.parent_id || null]));
      const originalOrder = new Map();
      for (const parent of nodes) {
        if (!Array.isArray(parent.children_ids)) continue;
        parent.children_ids.forEach((childId, index) => {
          originalOrder.set(`${parent.id}:${childId}`, index);
        });
      }

      const retainedNodes = nodes
        .filter(node => !removableIds.has(node.id))
        .map(node => deepClone(node));
      const retainedById = new Map(retainedNodes.map(node => [node.id, node]));
      const targetUpdates = new Map();
      const recordsByTarget = new Map();
      const continuityByTarget = new Map();
      const legacyNodes = nodes
        .filter(node => removableIds.has(node.id))
        .sort((left, right) => (
          (Number(left.created_at || left.real_timestamp || 0) - Number(right.created_at || right.real_timestamp || 0))
          || String(left.id).localeCompare(String(right.id))
        ));

      const safeHistory = node => (Array.isArray(node?.maintenance_history)
        ? node.maintenance_history
          .map(item => sanitizeTimelinePersistenceValue(item, `timeline_node.${node.id}.maintenance_history`))
          .filter(Boolean)
        : []);
      const maintenanceLabel = (source, record) => {
        const raw = record?.label || '';
        if (raw) return truncate(String(raw).replace(/[<>]/g, ''), 80);
        const summary = String(source?.summary || source?.ai_response_summary || '').trim();
        return truncate(summary.replace(/^灵希维护\s*[·:：\-]?\s*/u, '') || '变量维护', 80);
      };

      for (const source of legacyNodes) {
        const targetId = targetByLegacyId.get(source.id);
        const target = retainedById.get(targetId);
        if (!target) continue;
        const raw = source.maintenance && typeof source.maintenance === 'object'
          ? source.maintenance
          : {};
        const before = raw.before_state_snapshot && typeof raw.before_state_snapshot === 'object'
          ? raw.before_state_snapshot
          : (nodeById.get(originalParentById.get(source.id))?.state_snapshot || target.state_snapshot || null);
        const record = sanitizeTimelinePersistenceValue({
          type: 'lingxi-variable-maintenance',
          label: maintenanceLabel(source, raw),
          reason: truncate(String(raw.reason || '').replace(/[<>]/g, ''), 300),
          proposal_id: truncate(String(raw.proposal_id || raw.proposalId || ''), 240),
          created_at: Number.isFinite(Number(raw.created_at))
            ? Number(raw.created_at)
            : Number(source.created_at || source.real_timestamp || Date.now()),
          previous_node_id: target.id,
          before_state_snapshot: before ? sanitizeTimelineSnapshot(before) : null,
          migrated_from_node_id: source.id
        }, `timeline_node.${target.id}.maintenance_history`);
        if (!recordsByTarget.has(target.id)) recordsByTarget.set(target.id, []);
        recordsByTarget.get(target.id).push(record);
        if (Array.isArray(source.continuity_delta) && source.continuity_delta.length > 0) {
          if (!continuityByTarget.has(target.id)) continuityByTarget.set(target.id, []);
          continuityByTarget.get(target.id).push(...deepClone(source.continuity_delta));
        }

        // The approved maintenance snapshot is authoritative for the turn it
        // modified. Use the latest source in chronological order when several
        // old maintenance nodes target the same turn.
        if (source.state_snapshot && typeof source.state_snapshot === 'object') {
          const nextSnapshot = this._buildNodeSnapshot(source.state_snapshot, target.id, target.branch_id);
          const previousLedger = target.state_snapshot?._continuity;
          if (previousLedger && !nextSnapshot._continuity) {
            nextSnapshot._continuity = deepClone(previousLedger);
          }
          targetUpdates.set(target.id, {
            state_snapshot: nextSnapshot,
            continuity_revision: Number.isInteger(nextSnapshot._continuity?.revision)
              ? nextSnapshot._continuity.revision
              : target.continuity_revision
          });
        }
      }

      for (const target of retainedNodes) {
        const records = recordsByTarget.get(target.id);
        const update = targetUpdates.get(target.id);
        if (!records && !update) continue;
        const priorHistory = safeHistory(target);
        const known = new Set(priorHistory.map(item => [
          item.migrated_from_node_id,
          item.proposal_id,
          item.created_at
        ].filter(Boolean).join('|')));
        const mergedHistory = [...priorHistory];
        for (const record of records || []) {
          const identity = [record.migrated_from_node_id, record.proposal_id, record.created_at]
            .filter(Boolean).join('|');
          if (!identity || !known.has(identity)) {
            mergedHistory.push(record);
            if (identity) known.add(identity);
          }
        }
        const latest = mergedHistory.at(-1) || null;
        const existingDelta = Array.isArray(target.continuity_delta)
          ? deepClone(target.continuity_delta)
          : [];
        const eventIds = new Set(existingDelta.map(event => event?.event_id).filter(Boolean));
        for (const event of continuityByTarget.get(target.id) || []) {
          if (!event?.event_id || eventIds.has(event.event_id)) continue;
          existingDelta.push(event);
          eventIds.add(event.event_id);
        }
        existingDelta.sort((left, right) => (left?.sequence || 0) - (right?.sequence || 0));
        Object.assign(target, update || {}, {
          continuity_delta: existingDelta,
          maintenance_history: mergedHistory,
          ...(latest ? { maintenance: latest } : {})
        });
        // Attached maintenance is metadata on a regular turn; retaining the
        // old visual tag would make the navigator render it as a checkpoint.
        if (Array.isArray(target.tags)) {
          target.tags = target.tags.filter(tag => tag !== '灵希维护');
        } else if (target.tags === '灵希维护') {
          target.tags = [];
        }
      }

      // Continuity events may retain the removed checkpoint as their source
      // node. Remap those references in every surviving snapshot and delta so
      // later history searches never point at a node that no longer exists.
      for (const node of retainedNodes) {
        if (node.state_snapshot?._continuity) {
          node.state_snapshot._continuity = remapContinuityLedger(
            node.state_snapshot._continuity,
            { nodeIds: targetByLegacyId }
          );
          node.continuity_revision = node.state_snapshot._continuity.revision;
        }
        if (Array.isArray(node.continuity_delta)) {
          node.continuity_delta = remapContinuityDelta(node.continuity_delta, {
            nodeIds: targetByLegacyId
          });
        }
        const snapshotMeta = node.state_snapshot?._meta;
        if (snapshotMeta?.current_node_id && removableIds.has(snapshotMeta.current_node_id)) {
          snapshotMeta.current_node_id = targetByLegacyId.get(snapshotMeta.current_node_id) || node.id;
        }
      }

      // Rebuild parent/child links after removing checkpoint nodes. This also
      // repairs saves where a later normal turn was accidentally parented to a
      // maintenance node.
      for (const node of retainedNodes) {
        const oldParent = originalParentById.get(node.id);
        if (oldParent && removableIds.has(oldParent)) {
          node.parent_id = targetByLegacyId.get(oldParent) || null;
        }
        node.children_ids = [];
      }
      const retainedOriginalParent = new Map(
        retainedNodes.map(node => [node.id, originalParentById.get(node.id) || null])
      );
      for (const child of retainedNodes) {
        const parent = child.parent_id ? retainedById.get(child.parent_id) : null;
        if (!parent) continue;
        parent.children_ids.push(child.id);
      }
      for (const parent of retainedNodes) {
        parent.children_ids.sort((leftId, rightId) => {
          const left = retainedById.get(leftId);
          const right = retainedById.get(rightId);
          const leftOldParent = retainedOriginalParent.get(leftId);
          const rightOldParent = retainedOriginalParent.get(rightId);
          const leftOrder = originalOrder.get(`${leftOldParent}:${leftId}`) ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = originalOrder.get(`${rightOldParent}:${rightId}`) ?? Number.MAX_SAFE_INTEGER;
          return (leftOrder - rightOrder)
            || ((left?.turn_number || 0) - (right?.turn_number || 0))
            || ((left?.created_at || 0) - (right?.created_at || 0))
            || String(leftId).localeCompare(String(rightId));
        });
      }

      // Recompute depths from the unique root. Removing a checkpoint reduces
      // every descendant depth by one without touching turn numbers.
      const root = retainedNodes.find(node => node.parent_id == null)
        || retainedNodes.slice().sort((left, right) => (left.depth || 0) - (right.depth || 0))[0];
      if (root) {
        const queue = [{ node: root, depth: 0 }];
        const visited = new Set();
        while (queue.length) {
          const { node, depth } = queue.shift();
          if (!node || visited.has(node.id)) continue;
          visited.add(node.id);
          node.depth = depth;
          for (const childId of node.children_ids || []) {
            const child = retainedById.get(childId);
            if (child) queue.push({ node: child, depth: depth + 1 });
          }
        }
      }

      const removedBranchIds = new Set();
      const currentBefore = meta.value.current_id;
      let currentId = removableIds.has(currentBefore)
        ? targetByLegacyId.get(currentBefore)
        : currentBefore;
      if (!retainedById.has(currentId)) currentId = root?.id || retainedNodes[0]?.id || null;
      const currentNode = retainedById.get(currentId);
      let activeBranchId = currentNode?.branch_id || meta.value.active_branch || 'branch_main';
      const updatedBranches = [];
      for (const branch of branches) {
        const members = retainedNodes.filter(node => node.branch_id === branch.id);
        if (members.length === 0 && branch.id !== 'branch_main') {
          removedBranchIds.add(branch.id);
          continue;
        }
        const memberIds = new Set(members.map(node => node.id));
        const tips = members.filter(node => !members.some(candidate => memberIds.has(candidate.id)
          && candidate.parent_id === node.id));
        tips.sort((left, right) => (
          ((left.turn_number || 0) - (right.turn_number || 0))
          || ((left.depth || 0) - (right.depth || 0))
          || ((left.created_at || 0) - (right.created_at || 0))
          || String(left.id).localeCompare(String(right.id))
        ));
        const oldDiverged = branch.diverged_from;
        const divergedFrom = removableIds.has(oldDiverged)
          ? targetByLegacyId.get(oldDiverged)
          : oldDiverged;
        updatedBranches.push({
          ...branch,
          head_node_id: tips.at(-1)?.id || members.at(-1)?.id || branch.head_node_id,
          node_count: members.length,
          diverged_from: divergedFrom || null,
          diverged_at_turn: divergedFrom
            ? (retainedById.get(divergedFrom)?.turn_number ?? branch.diverged_at_turn ?? null)
            : branch.diverged_at_turn ?? null,
          is_active: branch.id === activeBranchId
        });
      }
      if (!updatedBranches.some(branch => branch.id === activeBranchId)) {
        activeBranchId = currentNode?.branch_id || 'branch_main';
        for (const branch of updatedBranches) branch.is_active = branch.id === activeBranchId;
      }
      const rootId = root?.id || meta.value.root_id;
      const updatedMeta = {
        ...meta,
        value: {
          ...meta.value,
          root_id: rootId,
          current_id: currentId,
          active_branch: activeBranchId,
          total_nodes: retainedNodes.length
        }
      };

      return {
        deleteNodeIds: [...removableIds],
        deleteBranchIds: [...removedBranchIds],
        nodes: retainedNodes,
        branches: updatedBranches,
        meta: updatedMeta,
        result: {
          migrated: removableIds.size,
          removedNodeIds: [...removableIds],
          removedBranchIds: [...removedBranchIds],
          currentId,
          activeBranchId,
          updatedNodes: retainedNodes.filter(node => recordsByTarget.has(node.id)).map(node => node.id),
          targetByLegacyId: Object.fromEntries(targetByLegacyId)
        }
      };
    });

    if (!migration?.migrated) {
      return migration || { migrated: 0, removedNodeIds: [], removedBranchIds: [] };
    }
    for (const nodeId of migration.removedNodeIds || []) this._nodeCache.delete(nodeId);
    for (const node of await stateManager.dbGetAll('timeline_nodes')) this._nodeCache.set(node.id, node);
    if (migration.currentId) {
      const metaState = stateManager.getSub('_meta') || {};
      metaState.current_node_id = migration.currentId;
      metaState.active_branch = migration.activeBranchId || metaState.active_branch || 'branch_main';
      stateManager.setSub('_meta', metaState);
    }
    if (this._pendingBranchFrom && migration.targetByLegacyId?.[this._pendingBranchFrom]) {
      this._pendingBranchFrom = migration.targetByLegacyId[this._pendingBranchFrom];
    }
    this._cacheTreeSummary();
    eventBus.emit('timeline:maintenance-migrated', migration);
    return migration;
  }

  async prepareReroll(targetNodeId, { mode = 'branch' } = {}) {
    if (!['branch', 'replace'].includes(mode)) throw new TypeError('重推衍模式必须是 branch 或 replace');
    const targetNode = await stateManager.dbGet('timeline_nodes', targetNodeId);
    if (!targetNode) throw new Error('重推衍目标节点不存在');
    if (!targetNode.parent_id) throw new Error('初始节点无法快速重推衍');
    if (!String(targetNode.player_input || '').trim()) throw new Error('该节点缺少玩家输入，无法重推衍');

    await this.jumpToNode(targetNode.parent_id);
    let pruned = 0;
    if (mode === 'replace') {
      const result = await this.pruneForward(targetNode.parent_id);
      pruned = Math.max(0, Number(result?.pruned) || 0);
      this._pendingBranchFrom = null;
    } else {
      this._pendingBranchFrom = targetNode.parent_id;
    }

    const parentNode = await this.getCurrentNode();
    const history = await this._reconstructChatHistory(parentNode);
    return {
      mode,
      targetNodeId: targetNode.id,
      parentNodeId: targetNode.parent_id,
      playerInput: targetNode.player_input,
      pruned,
      history
    };
  }

  async pruneForward(targetNodeId) {
    await this._archiveQueue;
    const hydrated = await this._hydratePersistedNode(targetNodeId);
    if (!hydrated) throw new Error('目标节点不存在');
    const mutation = await stateManager.dbMutateTimeline(({ nodes, branches, meta }) => {
      if (!meta?.value) throw new Error('时间线元数据不存在，无法逆转');
      const byId = new Map(nodes.map(node => [node.id, node]));
      const targetNode = byId.get(targetNodeId);
      if (!targetNode) throw new Error('目标节点不存在');
      if (!Array.isArray(targetNode.children_ids)) throw new Error('目标节点 children_ids 无效');
      const preparedRestore = this._prepareNodeRestore(targetNode);
      const descendantIds = collectForwardDescendantIds(targetNodeId, nodes);

      const retainedNodes = nodes
        .filter(node => !descendantIds.has(node.id))
        .map(node => {
          if (node.id === targetNodeId) {
            return { ...node, children_ids: [], accessed_count: (node.accessed_count || 0) + 1 };
          }
          if (!Array.isArray(node.children_ids)) return node;
          const children = node.children_ids.filter(childId => !descendantIds.has(childId));
          return children.length === node.children_ids.length
            ? node
            : { ...node, children_ids: children };
        });
      const retainedById = new Map(retainedNodes.map(node => [node.id, node]));
      const deletedBranchIds = [];
      const updatedBranches = [];
      for (const branch of branches) {
        const originalBranchNodes = nodes.filter(node => node.branch_id === branch.id);
        if (!originalBranchNodes.length) throw new Error(`分支 ${branch.id} 没有节点，无法安全逆转`);
        const branchNodes = retainedNodes.filter(node => node.branch_id === branch.id);
        if (!branchNodes.length) {
          deletedBranchIds.push(branch.id);
          continue;
        }
        const retainedHead = retainedById.get(branch.head_node_id);
        const head = retainedHead?.branch_id === branch.id ? retainedHead : latestTimelineNode(branchNodes);
        updatedBranches.push({
          ...branch,
          head_node_id: head.id,
          node_count: branchNodes.length,
          is_active: branch.id === targetNode.branch_id
        });
      }
      if (deletedBranchIds.includes(targetNode.branch_id)
        || !updatedBranches.some(branch => branch.id === targetNode.branch_id)) {
        throw new Error('目标节点所属分支无法保留');
      }
      const updatedMeta = {
        ...meta,
        value: {
          ...meta.value,
          current_id: targetNodeId,
          active_branch: targetNode.branch_id,
          total_nodes: retainedNodes.length
        }
      };
      return {
        deleteNodeIds: [...descendantIds],
        deleteBranchIds: deletedBranchIds,
        nodes: retainedNodes.filter(node => {
          if (node.id === targetNodeId) return true;
          const previous = byId.get(node.id);
          return !persistenceValuesEqual(previous?.children_ids, node.children_ids);
        }),
        branches: updatedBranches,
        meta: updatedMeta,
        result: {
          node: retainedById.get(targetNodeId),
          preparedRestore,
          previousCurrentId: meta.value.current_id,
          prunedNodeIds: [...descendantIds],
          deletedBranchIds
        }
      };
    });

    stateManager.commitPreparedRestore(mutation.preparedRestore);
    const metaState = stateManager.getSub('_meta') || {};
    metaState.current_node_id = targetNodeId;
    metaState.active_branch = mutation.node.branch_id;
    stateManager.setSub('_meta', metaState);
    this._pendingBranchFrom = null;
    for (const nodeId of mutation.prunedNodeIds) this._nodeCache.delete(nodeId);
    this._nodeCache.set(mutation.node.id, mutation.node);

    if (mutation.prunedNodeIds.length) {
      eventBus.emit('timeline:nodes-deleted', { nodeIds: mutation.prunedNodeIds, reason: 'prune' });
    }
    for (const branchId of mutation.deletedBranchIds) {
      eventBus.emit('timeline:branch-deleted', { branchId, reason: 'prune' });
    }
    this._cacheTreeSummary();
    eventBus.emit('timeline:jumped', {
      fromNodeId: mutation.previousCurrentId,
      toNodeId: targetNodeId,
      branchId: mutation.node.branch_id,
      pruned: mutation.prunedNodeIds.length
    });
    this._maybeArchive().catch(err => console.warn('[Timeline] archive failed:', err.message));

    return {
      pruned: mutation.prunedNodeIds.length,
      prunedNodeIds: mutation.prunedNodeIds,
      deletedBranchIds: mutation.deletedBranchIds,
      node: mutation.node,
      restored: true
    };
  }

  async jumpToNode(targetNodeId) {
    const meta = stateManager.getSub('_meta') || {};
    const currentId = meta.current_node_id;
    if (currentId === targetNodeId) {
      this._pendingBranchFrom = null;
      return;
    }

    const targetNode = await this._hydratePersistedNode(targetNodeId);
    if (!targetNode) throw new Error('目标节点不存在');
    const preparedRestore = this._prepareNodeRestore(targetNode);
    stateManager.commitPreparedRestore(preparedRestore);

    const metaState = stateManager.getSub('_meta') || {};
    metaState.current_node_id = targetNodeId;
    metaState.active_branch = targetNode.branch_id || 'branch_main';
    stateManager.setSub('_meta', metaState);
    this._pendingBranchFrom = targetNode.children_ids?.length ? targetNodeId : null;

    targetNode.accessed_count = (targetNode.accessed_count || 0) + 1;
    targetNode.archived = false;
    targetNode.archived_at = null;
    await stateManager.dbPut('timeline_nodes', targetNode);

    const metaEntry = await stateManager.dbGet('timeline_meta', 'root');
    if (metaEntry) {
      metaEntry.value.current_id = targetNodeId;
      metaEntry.value.active_branch = targetNode.branch_id || 'branch_main';
      await stateManager.dbPut('timeline_meta', metaEntry);
    }
    await this._setActiveBranchFlags(targetNode.branch_id || 'branch_main');

    this._cacheTreeSummary();
    eventBus.emit('timeline:jumped', {
      fromNodeId: currentId,
      toNodeId: targetNodeId,
      branchId: targetNode.branch_id || 'branch_main',
      willBranchOnNextInput: Boolean(this._pendingBranchFrom)
    });
    this._maybeArchive().catch(err => console.warn('[Timeline] archive failed:', err.message));

    return targetNode;
  }

  async getAllNodes() {
    return await stateManager.dbGetAll('timeline_nodes');
  }

  async getAllBranches() {
    return await stateManager.dbGetAll('timeline_branches');
  }

  async createIfBranch({ fromNodeId, name, description = '' } = {}) {
    const label = String(name || '').trim();
    if (!label || label.length > 80) throw new Error('IF 线名称需要 1 至 80 个字');
    await this._archiveQueue;
    const expected = { ...(stateManager.getSub('_meta') || {}) };
    const storedSource = await stateManager.dbGet('timeline_nodes', fromNodeId);
    const source = storedSource ? await this._hydrateNode(storedSource) : null;
    if (!source) throw new Error('分歧起点不存在，请刷新后重试');
    const history = await this._reconstructChatHistory(source);
    const branchId = generateId('branch');
    const nodeId = generateNodeId(source.turn_number);
    const now = Date.now();
    const mutation = await stateManager.dbMutateTimeline(({ nodes, branches, meta }) => {
      if (!meta?.value || meta.value.current_id !== expected.current_node_id || meta.value.active_branch !== expected.active_branch) {
        throw new Error('当前存档已变化，请刷新后重新创建 IF 线');
      }
      const parent = nodes.find(node => node.id === fromNodeId);
      if (!sameTimelineNodeRead(storedSource, parent)) throw new Error('分歧起点已变化，请刷新后重试');
      if (nodes.some(node => node.id === nodeId) || branches.some(branch => branch.id === branchId)) throw new Error('线路编号冲突，请重试');
      // A branch has its own restorable anchor immediately, without inventing
      // a story turn, duplicating chat messages, or taking nodes from its parent.
      const anchor = remapNodeRuntimeBranch({
        ...deepClone(source), id: nodeId, parent_id: parent.id, children_ids: [],
        depth: parent.depth + 1, branch_anchor: true, player_input: '',
        state_snapshot: this._buildNodeSnapshot(source.state_snapshot, nodeId, parent.branch_id),
        chat_history: history, chat_history_delta: [], continuity_delta: [],
        maintenance_history: [], maintenance: null,
        tags: ['IF 起点'], created_at: now, real_timestamp: now,
        is_checkpoint: true, archived: false, archived_at: null, accessed_count: 0
      }, branchId);
      const preparedRestore = this._prepareNodeRestore(anchor);
      let branchColor = getNextBranchColor();
      for (let i = 0; i < 12 && branches.some(item => item.color === branchColor); i++) branchColor = getNextBranchColor();
      const branch = {
        id: branchId, name: label, description: String(description).trim().slice(0, 500),
        color: branchColor, created_at: now, diverged_from: parent.id,
        diverged_at_turn: parent.turn_number, head_node_id: nodeId, node_count: 1, is_active: true
      };
      const updatedParent = { ...parent, children_ids: [...new Set([...(parent.children_ids || []), nodeId])] };
      return {
        nodes: [updatedParent, anchor],
        branches: [...branches.map(item => ({ ...item, is_active: false })), branch],
        meta: { ...meta, value: { ...meta.value, current_id: nodeId, active_branch: branchId, total_nodes: nodes.length + 1 } },
        result: { branch, anchor, updatedParent, preparedRestore }
      };
    });
    stateManager.commitPreparedRestore(mutation.preparedRestore);
    this._pendingBranchFrom = null;
    this._nodeCache.set(mutation.anchor.id, mutation.anchor);
    this._nodeCache.set(mutation.updatedParent.id, mutation.updatedParent);
    this._cacheTreeSummary();
    eventBus.emit('timeline:branch-created', mutation.branch);
    eventBus.emit('timeline:branch-switched', { from: expected.active_branch, to: branchId });
    return mutation.branch;
  }

  async renameBranch(branchId, { name, description = '' } = {}) {
    const label = String(name || '').trim();
    if (!label || label.length > 80) throw new Error('线路名称需要 1 至 80 个字');
    const updated = await stateManager.dbMutateTimeline(({ branches }) => {
      const branch = branches.find(item => item.id === branchId);
      if (!branch) throw new Error('线路不存在，请刷新后重试');
      const next = { ...branch, name: label, description: String(description).trim().slice(0, 500) };
      return { branches: [next], result: next };
    });
    eventBus.emit('timeline:branch-renamed', updated);
    return updated;
  }

  async getCurrentNode() {
    const meta = stateManager.getSub('_meta') || {};
    const currentId = meta.current_node_id;
    if (!currentId) return null;
    return await this._hydratePersistedNode(currentId);
  }

  async getActiveBranch() {
    const meta = stateManager.getSub('_meta') || {};
    const branchId = meta.active_branch;
    return await stateManager.dbGet('timeline_branches', branchId);
  }

  async switchBranch(branchId) {
    await this._archiveQueue;
    const expected = { ...(stateManager.getSub('_meta') || {}) };
    const branch = await stateManager.dbGet('timeline_branches', branchId);
    if (!branch) throw new Error('分支不存在');
    if (!branch.head_node_id) throw new Error('这条线路没有可恢复的进度');
    const storedHead = await stateManager.dbGet('timeline_nodes', branch.head_node_id);
    const head = storedHead ? await this._hydrateNode(storedHead) : null;
    const mutation = await stateManager.dbMutateTimeline(({ nodes, branches, meta }) => {
      if (!meta?.value || meta.value.current_id !== expected.current_node_id || meta.value.active_branch !== expected.active_branch) {
        throw new Error('当前存档已变化，请刷新后重新切换线路');
      }
      const target = branches.find(item => item.id === branchId);
      if (!target || target.head_node_id !== branch.head_node_id) throw new Error('线路进度已变化，请刷新后重试');
      const liveHead = nodes.find(node => node.id === target.head_node_id);
      if (!head || head.branch_id !== branchId) throw new Error('分支头节点不存在或归属不匹配');
      if (!sameTimelineNodeRead(storedHead, liveHead)) throw new Error('线路节点已变化，请刷新后重试');
      const preparedRestore = this._prepareNodeRestore(head);
      return {
        branches: branches.map(item => ({ ...item, is_active: item.id === branchId })),
        meta: { ...meta, value: { ...meta.value, current_id: head.id, active_branch: branchId } },
        result: { head, preparedRestore }
      };
    }, { nodeKeys: [branch.head_node_id] });
    stateManager.commitPreparedRestore(mutation.preparedRestore);
    this._pendingBranchFrom = null;
    this._nodeCache.set(mutation.head.id, mutation.head);
    this._cacheTreeSummary();
    eventBus.emit('timeline:branch-switched', { from: expected.active_branch, to: branchId });
    this._maybeArchive().catch(err => console.warn('[Timeline] archive failed:', err.message));
    return mutation.head;
  }

  async _setActiveBranchFlags(branchId) {
    const branches = await stateManager.dbGetAll('timeline_branches');
    for (const branch of branches) {
      const shouldBeActive = branch.id === branchId;
      if (branch.is_active === shouldBeActive) continue;
      await stateManager.dbPut('timeline_branches', { ...branch, is_active: shouldBeActive });
    }
  }

  _extractChatDelta(chatHistory) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return [];
    const last2 = chatHistory.slice(-2);
    return deepClone(last2);
  }

  async _reconstructChatHistory(targetNode) {
    if (!targetNode) return [];
    if (Array.isArray(targetNode.chat_history) && targetNode.chat_history.length > 0) {
      return deepClone(targetNode.chat_history);
    }
    const chain = [];
    let cursor = targetNode;
    let safety = 0;
    while (cursor && safety < 200) {
      cursor = await this._hydrateNode(cursor);
      if (Array.isArray(cursor.chat_history) && cursor.chat_history.length > 0) {
        return [...deepClone(cursor.chat_history), ...chain].slice(-80);
      }
      if (Array.isArray(cursor.chat_history_delta) && cursor.chat_history_delta.length > 0) {
        chain.unshift(...deepClone(cursor.chat_history_delta));
      }
      if (!cursor.parent_id) break;
      cursor = await stateManager.dbGet('timeline_nodes', cursor.parent_id);
      safety++;
    }
    return chain.slice(-80);
  }

  _enqueueArchive(work) {
    const run = this._archiveQueue.then(async () => {
      this._archiveRunning = true;
      try {
        return await work();
      } finally {
        this._archiveRunning = false;
      }
    });
    this._archiveQueue = run.then(() => {}, () => {});
    return run;
  }

  async _maybeArchive() {
    const ui = stateManager.getSub('_ui') || {};
    const settings = ui.settings || {};
    if (settings?.autoArchive === false) return;
    return this._enqueueArchive(async () => {
      try {
        const result = await this._compressColdNodes();
        if ((result.archived || 0) > 0 || (result.compressed || 0) > 0) {
          eventBus.emit('timeline:archived', result);
        }
        return result;
      } catch (err) {
        console.warn('[Timeline] archive failed:', err.message);
        return { archived: 0, compressed: 0, expanded: 0, error: err.message };
      }
    });
  }

  async manualArchive() {
    return this._enqueueArchive(async () => {
      const result = await this._compressColdNodes();
      eventBus.emit('timeline:archived', { manual: true, ...result });
      return result;
    });
  }

  async _writeNodeIfPresent(nodeId, updater) {
    if (!nodeId) return null;
    const current = await stateManager.dbGet('timeline_nodes', nodeId);
    if (!current) return null;
    const proposed = await updater(current);
    if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return null;
    return await stateManager.dbMutateTimeline(({ nodes }) => {
      const live = nodes[0];
      if (!live) return { nodes: [], result: null };
      const next = {
        ...proposed,
        parent_id: live.parent_id ?? proposed.parent_id ?? null,
        children_ids: Array.isArray(live.children_ids) ? [...live.children_ids] : proposed.children_ids,
        branch_id: live.branch_id ?? proposed.branch_id
      };
      const sanitized = sanitizeTimelineNode(next, `timeline_node.${nodeId}`);
      return { nodes: [sanitized], result: sanitized };
    }, { nodeKeys: [nodeId], branchKeys: [] });
  }

  async _compressColdNodes() {
    const nodes = await stateManager.dbGetAll('timeline_nodes');
    if (!nodes.length) return { archived: 0, compressed: 0, expanded: 0 };
    const meta = await stateManager.dbGet('timeline_meta', 'root');
    const currentId = meta?.value?.current_id
      || stateManager.getSub('_meta')?.current_node_id
      || null;
    const hotIds = collectHotNodeIds(nodes, currentId, ARCHIVE_ANCESTOR_KEEP);
    if (hotIds.size === 0) {
      return { archived: 0, compressed: 0, expanded: 0 };
    }
    let archived = 0;
    let compressed = 0;
    let expanded = 0;
    for (const listed of nodes) {
      if (!listed?.id) continue;
      const shouldBeHot = hotIds.has(listed.id);
      let didCompress = false;
      let didArchive = false;
      let didExpand = false;
      const written = await this._writeNodeIfPresent(listed.id, async latest => {
        if (shouldBeHot) {
          if (isCompressedTimelineNode(latest)) {
            const logical = await decompressTimelineNode(latest);
            logical.archived = false;
            logical.archived_at = null;
            didExpand = true;
            return logical;
          }
          if (latest.archived) return { ...latest, archived: false, archived_at: null };
          return null;
        }
        let next = latest;
        if (!isCompressedTimelineNode(latest)) {
          next = await compressTimelineNode(latest);
          if (isCompressedTimelineNode(next)) didCompress = true;
        }
        if (!next.archived) {
          next = { ...next, archived: true, archived_at: next.archived_at || Date.now() };
          didArchive = true;
        }
        return next === latest ? null : next;
      });
      if (!written) continue;
      if (shouldBeHot) {
        if (didExpand) expanded++;
        this._nodeCache.set(written.id, written);
        continue;
      }
      if (didCompress) compressed++;
      if (didArchive) archived++;
      this._nodeCache.delete(written.id);
    }
    return { archived, compressed, expanded };
  }

  async getStorageStats() {
    const nodes = await this.getAllNodes();
    let totalBytes = 0;
    let archivedCount = 0;
    let activeCount = 0;
    let compressedCount = 0;
    for (const n of nodes) {
      totalBytes += estimateTimelineNodeBytes(n);
      if (isCompressedTimelineNode(n)) compressedCount++;
      if (n.archived) archivedCount++; else activeCount++;
    }
    return {
      totalNodes: nodes.length,
      archivedCount,
      activeCount,
      compressedCount,
      estimatedBytes: totalBytes
    };
  }

  async _replayStateFromAncestor(targetNode) {
    const node = isCompressedTimelineNode(targetNode)
      ? await decompressTimelineNode(targetNode)
      : targetNode;
    stateManager.commitPreparedRestore(this._prepareNodeRestore(node));
    return 0;
  }

  async _hydrateNode(node) {
    if (!isCompressedTimelineNode(node)) return node;
    return decompressTimelineNode(node);
  }

  async _hydratePersistedNode(nodeId, { validateCurrent = null } = {}) {
    validateCurrent?.();
    const node = await stateManager.dbGet('timeline_nodes', nodeId);
    validateCurrent?.();
    if (!node) return null;
    if (!isCompressedTimelineNode(node)) return node;
    const logical = await decompressTimelineNode(node);
    validateCurrent?.();
    logical.archived = false;
    logical.archived_at = null;
    const written = await stateManager.dbMutateTimeline(({ nodes }) => {
      validateCurrent?.();
      const live = nodes[0];
      if (!live) return { nodes: [], result: null };
      if (!isCompressedTimelineNode(live)) {
        const next = live.archived ? { ...live, archived: false, archived_at: null } : live;
        return { nodes: live.archived ? [next] : [], result: next };
      }
      const next = {
        ...logical,
        parent_id: live.parent_id ?? logical.parent_id ?? null,
        children_ids: Array.isArray(live.children_ids) ? [...live.children_ids] : logical.children_ids,
        branch_id: live.branch_id ?? logical.branch_id,
        archived: false,
        archived_at: null
      };
      return { nodes: [next], result: next };
    }, { nodeKeys: [nodeId], branchKeys: [], validateCurrent });
    validateCurrent?.();
    if (!written) return null;
    this._nodeCache.set(written.id, written);
    return written;
  }

  async _hydrateAllCompressedNodes() {
    const nodes = await stateManager.dbGetAll('timeline_nodes');
    for (const node of nodes) {
      if (!isCompressedTimelineNode(node)) continue;
      const logical = await decompressTimelineNode(node);
      await stateManager.dbPut('timeline_nodes', logical);
      this._nodeCache.set(logical.id, logical);
    }
  }

  _alignSnapshotTurnCount(snapshot, turnNumber) {
    const turn = Number(turnNumber);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
    if (!Number.isInteger(turn) || turn < 0) return snapshot;
    snapshot['系统·回合数'] = turn;
    if (snapshot._meta && typeof snapshot._meta === 'object' && !Array.isArray(snapshot._meta)) {
      snapshot._meta.turn_count = turn;
    }
    return snapshot;
  }

  _prepareNodeRestore(node) {
    if (isCompressedTimelineNode(node)) {
      throw new Error(`节点 ${node?.id || 'unknown'} 仍处于压缩状态，恢复前需要先解压`);
    }
    const snapshot = node?.state_snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error(`节点 ${node?.id || 'unknown'} 缺少完整状态快照，无法精确恢复`);
    }
    return stateManager.prepareRestore(this._alignSnapshotTurnCount(deepClone(snapshot), node.turn_number));
  }

  _buildNodeSnapshot(stateSnapshot, nodeId, branchId) {
    const source = stateSnapshot && typeof stateSnapshot === 'object' && !Array.isArray(stateSnapshot)
      ? stateSnapshot
      : stateManager.snapshot();
    const snapshot = sanitizeTimelineSnapshot(source);
    if (!snapshot._meta) snapshot._meta = {};
    snapshot._meta.current_node_id = nodeId;
    snapshot._meta.active_branch = branchId;
    return snapshot;
  }

  _prepareContinuitySnapshot(snapshot, {
    parentNode = null,
    nodeId,
    branchId,
    turnNumber = 0,
    gameTime = '',
    recordedAt = Date.now(),
    continuityDelta = []
  } = {}) {
    const prepared = prepareContinuityCommit({
      ledger: snapshot?._continuity,
      legacyMemory: snapshot?._memory,
      events: continuityDelta,
      context: {
        nodeId,
        branchId,
        turn: Number.isInteger(turnNumber) ? Math.max(0, turnNumber) : 0,
        gameTime,
        recordedAt,
        source: 'turn_commit'
      }
    });
    snapshot._continuity = prepared.ledger;
    const parentLedger = parentNode?.state_snapshot?._continuity;
    return {
      snapshot,
      delta: diffContinuityLedgers(parentLedger, prepared.ledger)
    };
  }

  _commitLiveContinuity(node) {
    const ledger = node?.state_snapshot?._continuity;
    if (ledger) stateManager.setSub('_continuity', deepClone(ledger));
  }

  async _createBranchFromNode(parentNode) {
    const meta = stateManager.getSub('_meta') || {};
    const oldBranchId = meta.active_branch;
    const oldBranch = await stateManager.dbGet('timeline_branches', oldBranchId);
    const previousBranch = oldBranch ? { ...oldBranch, is_active: false } : null;

    const newBranch = {
      id: generateId('branch'),
      name: `IF线·${parentNode.summary || '新选择'}`,
      color: getNextBranchColor(),
      description: `从"${parentNode.summary}"分歧`,
      created_at: Date.now(),
      diverged_from: parentNode.id,
      diverged_at_turn: parentNode.turn_number,
      head_node_id: null,
      node_count: 0,
      is_active: true
    };
    return { branch: newBranch, previousBranch };
  }

  _cacheTreeSummary() {
    try {
      const meta = stateManager.getSub('_meta') || {};
      localStorage.setItem('naruto_timeline_summary', JSON.stringify({
        current_id: meta.current_node_id,
        active_branch: meta.active_branch,
        cached_at: Date.now()
      }));
    } catch { console.warn('[Timeline] Failed to cache tree summary'); }
  }

  async getExportData({ includeArchive = false, onProgress = () => {} } = {}) {
    // Export/cloud-save is an explicit consistency boundary. Flush both small
    // live image slices first so an export started immediately after a profile
    // edit cannot race the event-driven persistence listener.
    await this.syncCurrentImageStateSlices([
      '_relationships',
      '_image_worldbook_overlay'
    ]);
    // Capture the graph and its saved position before yielding to decode work.
    const [allNodes, branches, persistedMetaEntry] = await Promise.all([
      this.getAllNodes(), this.getAllBranches(), stateManager.dbGet('timeline_meta', 'root')
    ]);
    const logicalNodes = [];
    // Bound simultaneous gzip decoders and yield between batches so large
    // archives can report progress without freezing the continuation dialog.
    for (let index = 0; index < allNodes.length; index += 8) {
      logicalNodes.push(...await Promise.all(allNodes.slice(index, index + 8).map(node => this._hydrateNode(node))));
      onProgress(`正在读取完整时间线：${logicalNodes.length} / ${allNodes.length} 个节点…`);
      if (index + 8 < allNodes.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const { meta: metaEntry, multiplayer } = splitPersistedTimelineMeta(persistedMetaEntry);

    const nodes = includeArchive
      ? logicalNodes.map(n => {
          const { memory_snapshot, payload, payload_encoding, payload_bytes, ...rest } = n;
          return rest;
        })
      : logicalNodes.map(n => {
          const { memory_snapshot, chat_history, payload, payload_encoding, payload_bytes, ...rest } = n;
          if (n.archived) {
            return { ...rest, archived: true };
          }
          return { ...rest, chat_history: null };
        });
    const multiplayerMetadata = multiplayer
      ? assertNonAgentMultiplayerMetadata({
          ...multiplayer,
          nodes,
          branches,
          meta: metaEntry
        })
      : null;

    return sanitizeTimelinePersistenceValue({
      ...(multiplayerMetadata ?? {}),
      export_version: '2.0',
      exported_at: new Date().toISOString(),
      include_archive: includeArchive,
      meta: metaEntry,
      branches,
      nodes
    }, 'timeline_export');
  }

  async exportTimeline({ includeArchive = false, compression = 'auto' } = {}) {
    const data = await this.getExportData({ includeArchive });
    const encoded = await encodeTimelineSave(data, { compression });
    const fileName = `naruto-timeline-${Date.now()}${includeArchive ? '-full' : ''}${encoded.extension}`;
    const download = await exportFile(encoded.blob, fileName);
    const result = { ...encoded, fileName, includeArchive, cancelled: download.cancelled === true };
    if (result.cancelled) return result;
    eventBus.emit('timeline:exported', {
      fileName,
      format: encoded.format,
      fallbackReason: encoded.fallbackReason,
      includeArchive
    });
    return result;
  }

  _migrateNodeV1ToV2(node) {
    if (!node || typeof node !== 'object') return node;
    const migrated = { ...node };
    delete migrated.memory_snapshot;
    if (Array.isArray(migrated.chat_history) && migrated.chat_history.length > 0 && !migrated.chat_history_delta) {
      migrated.chat_history_delta = deepClone(migrated.chat_history.slice(-2));
    }
    if (migrated.archived === undefined) migrated.archived = false;
    if (migrated.archived_at === undefined) migrated.archived_at = null;
    if (migrated.continuity_delta === undefined) migrated.continuity_delta = [];
    if (migrated.continuity_revision === undefined
        && Number.isInteger(migrated.state_snapshot?._continuity?.revision)) {
      migrated.continuity_revision = migrated.state_snapshot._continuity.revision;
    }
    return sanitizeTimelinePersistenceValue(migrated, `timeline_node.${migrated.id || 'unknown'}`);
  }

  _normalizeImportedTimeline(nodes, branches, data) {
    const wrappedMeta = data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta)
      && Object.prototype.hasOwnProperty.call(data.meta, 'value');
    const rawMeta = wrappedMeta ? data.meta.value : (data.timeline?.meta ?? data.meta);
    if (rawMeta != null && (typeof rawMeta !== 'object' || Array.isArray(rawMeta))) {
      throw new Error('存档格式无效: 时间线元数据必须是 JSON 对象');
    }
    const importedMeta = rawMeta || {};
    const multiplayerMetadata = assertNonAgentMultiplayerMetadata(data);
    const {
      [NON_AGENT_MULTIPLAYER_META_FIELD]: _untrustedInternalMetadata,
      ...publicImportedMeta
    } = importedMeta;
    const migratedNodes = nodes.map((node, index) => {
      const migrated = this._migrateNodeV1ToV2(node);
      if (!migrated || typeof migrated !== 'object' || Array.isArray(migrated)) return migrated;
      return {
        ...migrated,
        parent_id: migrated.parent_id ?? null,
        turn_number: Number.isInteger(migrated.turn_number) ? migrated.turn_number : index,
        children_ids: Array.isArray(migrated.children_ids)
          ? [...migrated.children_ids]
          : (migrated.children_ids == null ? [] : migrated.children_ids)
      };
    });

    const validNodes = migratedNodes.filter(node => node && typeof node === 'object' && !Array.isArray(node));
    const validBranches = branches.filter(branch => branch && typeof branch === 'object' && !Array.isArray(branch));
    const soleBranchId = validBranches.length === 1 ? validBranches[0].id : null;
    for (let index = 0; index < validNodes.length; index++) {
      const node = validNodes[index];
      if (node.branch_id == null && soleBranchId) node.branch_id = soleBranchId;
    }

    const nodeById = new Map(validNodes.filter(node => node.id).map(node => [node.id, node]));
    const nodesMissingChildren = new Set(
      nodes
        .filter(node => node && typeof node === 'object' && !Array.isArray(node) && node.children_ids == null)
        .map(node => node.id)
        .filter(Boolean)
    );
    for (const node of validNodes) {
      if (!node.parent_id || !nodeById.has(node.parent_id) || !nodesMissingChildren.has(node.parent_id)) continue;
      const parent = nodeById.get(node.parent_id);
      if (!parent.children_ids.includes(node.id)) parent.children_ids.push(node.id);
    }

    for (const node of validNodes) {
      const visited = new Set();
      let cursor = node;
      let depth = 0;
      let complete = true;
      while (cursor.parent_id != null) {
        if (visited.has(cursor.id)) {
          complete = false;
          break;
        }
        visited.add(cursor.id);
        cursor = nodeById.get(cursor.parent_id);
        if (!cursor) {
          complete = false;
          break;
        }
        depth++;
      }
      if (complete) node.depth = depth;
    }

    const newestNode = candidates => candidates.reduce((latest, candidate) => {
      if (!latest) return candidate;
      const turnDelta = (candidate.turn_number || 0) - (latest.turn_number || 0);
      if (turnDelta !== 0) return turnDelta > 0 ? candidate : latest;
      const timeDelta = (candidate.created_at || candidate.real_timestamp || 0)
        - (latest.created_at || latest.real_timestamp || 0);
      return timeDelta >= 0 ? candidate : latest;
    }, null);
    const roots = validNodes.filter(node => node.parent_id == null);
    const derivedRootId = roots.length === 1 ? roots[0].id : undefined;
    const requestedActiveBranch = importedMeta.active_branch;
    const requestedBranch = validBranches.find(branch => branch.id === requestedActiveBranch);
    const requestedHead = requestedBranch ? nodeById.get(requestedBranch.head_node_id) : null;
    const derivedCurrentNode = importedMeta.current_id == null && requestedBranch
      ? ((requestedHead?.branch_id === requestedBranch.id ? requestedHead : null)
        || newestNode(validNodes.filter(node => node.branch_id === requestedBranch.id)))
      : newestNode(validNodes);
    const rootId = importedMeta.root_id ?? derivedRootId;
    const currentId = importedMeta.current_id ?? derivedCurrentNode?.id;
    const currentNode = nodeById.get(currentId);
    const activeBranch = importedMeta.active_branch ?? currentNode?.branch_id ?? soleBranchId;

    const normalizedBranches = branches.map(branch => {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return branch;
      const branchNodes = validNodes.filter(node => node.branch_id === branch.id);
      const derivedHead = newestNode(branchNodes);
      return {
        ...branch,
        color: branch.color || '#eb613f',
        head_node_id: branch.head_node_id ?? derivedHead?.id,
        node_count: branchNodes.length,
        is_active: branch.id === activeBranch
      };
    });
    const metaEntry = {
      key: 'root',
      value: {
        ...publicImportedMeta,
        root_id: rootId,
        current_id: currentId,
        active_branch: activeBranch,
        total_nodes: migratedNodes.length,
        ...(multiplayerMetadata
          ? { [NON_AGENT_MULTIPLAYER_META_FIELD]: multiplayerMetadata }
          : {})
      }
    };
    const normalized = { nodes: migratedNodes, branches: normalizedBranches, meta: metaEntry };
    assertTimelineSave(normalized);
    return normalized;
  }

  normalizeImportForArchive(data) {
    if (!Array.isArray(data?.nodes) || !data.nodes.length || !Array.isArray(data?.branches) || !data.branches.length) {
      throw new Error('存档缺少时间线节点或分支');
    }
    const normalized = this._normalizeImportedTimeline(data.nodes, data.branches, data);
    const current = normalized.nodes.find(node => node.id === normalized.meta.value.current_id);
    this._prepareImportedState(current, normalized.nodes);
    // Internal DB meta contains a non-Agent sidecar. Portable files must keep
    // that sidecar outside agent-visible nodes/branches/meta on every roundtrip.
    const { meta, multiplayer } = splitPersistedTimelineMeta(normalized.meta);
    return { ...data, ...normalized, meta, ...(multiplayer ?? {}) };
  }

  async importTimeline(data, { mode = 'overwrite' } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('存档格式无效: 存档根节点必须是 JSON 对象');
    }
    const incomingNodes = Array.isArray(data.nodes) ? data.nodes : [];
    const incomingBranches = Array.isArray(data.branches) ? data.branches : [];
    if (!incomingNodes.length || !incomingBranches.length) throw new Error('存档缺少时间线节点或分支数据');

    const normalized = this._normalizeImportedTimeline(incomingNodes, incomingBranches, data);

    await stateManager.initDB();

    if (mode === 'merge') {
      return await this._importMerge(normalized.nodes, normalized.branches, normalized.meta);
    }

    const { nodes: migratedNodes, branches: normalizedBranches, meta: metaEntry } = normalized;
    const importedCurrentId = metaEntry.value.current_id;
    const importedCurrentNode = migratedNodes.find(node => node.id === importedCurrentId);
    // Validate and prepare the runtime restore before replacing IndexedDB so a
    // malformed snapshot cannot destroy the timeline that is already loaded.
    const preparedRestore = this._prepareImportedState(importedCurrentNode, migratedNodes);

    await stateManager.dbReplaceTimeline({
      nodes: migratedNodes,
      branches: normalizedBranches,
      meta: metaEntry
    });
    await this._migrateLegacyMaintenanceNodes();

    const [committedNodes, committedBranches, committedMetaEntry] = await Promise.all([
      stateManager.dbGetAll('timeline_nodes'),
      stateManager.dbGetAll('timeline_branches'),
      stateManager.dbGet('timeline_meta', 'root')
    ]);
    const currentId = committedMetaEntry?.value?.current_id;
    const activeBranch = committedMetaEntry?.value?.active_branch || 'branch_main';
    const currentNode = committedNodes.find(node => node.id === currentId);
    if (!currentNode) throw new Error('导入迁移后的当前时间线节点不存在');
    const preparedMeta = preparedRestore.state._meta && typeof preparedRestore.state._meta === 'object'
      && !Array.isArray(preparedRestore.state._meta)
      ? preparedRestore.state._meta
      : {};
    preparedRestore.state._meta = {
      ...preparedMeta,
      current_node_id: currentId,
      active_branch: activeBranch
    };
    stateManager.commitPreparedRestore(preparedRestore);

    this._pendingBranchFrom = null;
    this._initialized = true;
    this._nodeCache.clear();
    for (const node of committedNodes) this._nodeCache.set(node.id, node);
    this._cacheTreeSummary();
    eventBus.emit('timeline:imported', {
      node: currentNode,
      nodes: committedNodes,
      branches: committedBranches,
      mode: 'overwrite'
    });
    this._maybeArchive().catch(() => {});
    return currentNode;
  }

  async _importMerge(incomingNodes, incomingBranches, incomingMeta) {
    await this._hydrateAllCompressedNodes();
    const imported = await stateManager.dbMutateTimeline(({ nodes: existingNodes, branches: existingBranches, meta: existingMeta }) => {
      if (!existingMeta?.value) throw new Error('当前时间线元数据不存在，无法合并导入');
      const attachmentNode = existingNodes.find(node => node.id === existingMeta.value.current_id);
      if (!attachmentNode) throw new Error('当前时间线节点不存在，无法合并导入');
      if (!Array.isArray(attachmentNode.children_ids)) throw new Error('当前时间线节点 children_ids 无效');

      const existingNodeIds = new Set(existingNodes.map(node => node.id));
      const existingBranchIds = new Set(existingBranches.map(branch => branch.id));
      const branchIdMap = new Map();
      for (const branch of incomingBranches) {
        let newId = branch.id;
        let suffix = 0;
        while (existingBranchIds.has(newId)) newId = `${branch.id}_imp${++suffix}`;
        branchIdMap.set(branch.id, newId);
        existingBranchIds.add(newId);
      }

      const nodeIdMap = new Map();
      for (const node of incomingNodes) {
        let newId = node.id;
        let suffix = 0;
        while (existingNodeIds.has(newId)) newId = `${node.id}_imp${++suffix}`;
        nodeIdMap.set(node.id, newId);
        existingNodeIds.add(newId);
      }

      // An imported timeline is attached below an existing node. Memory event
      // IDs and their provenance therefore need the same collision-safe remap
      // as node/branch IDs; cumulative ledgers repeat the same immutable IDs.
      const incomingContinuityIds = new Set();
      for (const node of incomingNodes) {
        for (const event of node.continuity_delta || []) {
          if (event?.event_id) incomingContinuityIds.add(event.event_id);
        }
        for (const event of node.state_snapshot?._continuity?.events || []) {
          if (event?.event_id) incomingContinuityIds.add(event.event_id);
        }
      }
      const eventIdMap = new Map();
      const importEventPrefix = generateId('memory_import');
      let importEventIndex = 0;
      for (const eventId of incomingContinuityIds) {
        eventIdMap.set(eventId, `${importEventPrefix}_${++importEventIndex}`);
      }

      const importedRootOriginal = incomingNodes.find(node => node.id === incomingMeta.value.root_id);
      if (!importedRootOriginal) throw new Error('导入时间线根节点不存在');
      const importedRootId = nodeIdMap.get(importedRootOriginal.id);
      const importedRootBranchId = branchIdMap.get(importedRootOriginal.branch_id);
      const attachmentDepth = Number.isInteger(attachmentNode.depth) ? attachmentNode.depth : 0;
      const attachmentTurn = Number.isInteger(attachmentNode.turn_number) ? attachmentNode.turn_number : 0;
      const importedRootTurn = Number.isInteger(importedRootOriginal.turn_number) ? importedRootOriginal.turn_number : 0;
      const turnOffset = attachmentTurn + 1 - importedRootTurn;
      const incomingNodeById = new Map(incomingNodes.map(node => [node.id, node]));
      const remapMaintenanceRecord = record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
        const remapped = deepClone(record);
        if (remapped.previous_node_id && nodeIdMap.has(remapped.previous_node_id)) {
          remapped.previous_node_id = nodeIdMap.get(remapped.previous_node_id);
        }
        if (remapped.migrated_from_node_id && nodeIdMap.has(remapped.migrated_from_node_id)) {
          remapped.migrated_from_node_id = nodeIdMap.get(remapped.migrated_from_node_id);
        }
        return remapped;
      };
      const relativeDepth = node => {
        let depth = 0;
        let cursor = node;
        while (cursor.id !== importedRootOriginal.id) {
          cursor = incomingNodeById.get(cursor.parent_id);
          if (!cursor) throw new Error(`导入节点 ${node.id} 无法追溯到根节点`);
          depth++;
        }
        return depth;
      };

      const migratedIncoming = incomingNodes.map(node => {
        const id = nodeIdMap.get(node.id);
        const branchId = branchIdMap.get(node.branch_id);
        const turnNumber = node.turn_number + turnOffset;
        const snapshot = node.state_snapshot && typeof node.state_snapshot === 'object'
          ? deepClone(node.state_snapshot)
          : node.state_snapshot;
        if (snapshot) {
          if (!snapshot._meta) snapshot._meta = {};
          snapshot._meta.current_node_id = id;
          snapshot._meta.active_branch = branchId;
          if (snapshot._version !== '4.0' && snapshot._version !== '5.0') {
            snapshot._meta.turn_count = turnNumber;
          } else {
            snapshot['系统·回合数'] = turnNumber;
          }
          if (snapshot._continuity) {
            snapshot._continuity = remapContinuityLedger(snapshot._continuity, {
              nodeIds: nodeIdMap,
              branchIds: branchIdMap,
              eventIds: eventIdMap
            });
          }
        }
        return {
          ...node,
          id,
          parent_id: node.id === importedRootOriginal.id
            ? attachmentNode.id
            : nodeIdMap.get(node.parent_id),
          children_ids: node.children_ids.map(childId => nodeIdMap.get(childId)),
          branch_id: branchId,
          turn_number: turnNumber,
          depth: attachmentDepth + 1 + relativeDepth(node),
          state_snapshot: snapshot,
          continuity_delta: remapContinuityDelta(node.continuity_delta || [], {
            nodeIds: nodeIdMap,
            branchIds: branchIdMap,
            eventIds: eventIdMap
          }),
          ...(node.maintenance && typeof node.maintenance === 'object'
            ? { maintenance: remapMaintenanceRecord(node.maintenance) }
            : {}),
          ...(Array.isArray(node.maintenance_history)
            ? { maintenance_history: node.maintenance_history.map(remapMaintenanceRecord) }
            : {})
        };
      });
      const migratedNodeById = new Map(migratedIncoming.map(node => [node.id, node]));
      const updatedAttachment = {
        ...attachmentNode,
        children_ids: [...attachmentNode.children_ids, importedRootId]
      };

      const remappedBranches = incomingBranches.map(branch => {
        const id = branchIdMap.get(branch.id);
        const divergedFrom = id === importedRootBranchId
          ? attachmentNode.id
          : (branch.diverged_from == null ? null : nodeIdMap.get(branch.diverged_from));
        return {
          ...branch,
          id,
          name: `${branch.name || '导入分支'} (导入)`,
          is_active: false,
          head_node_id: nodeIdMap.get(branch.head_node_id),
          diverged_from: divergedFrom,
          diverged_at_turn: id === importedRootBranchId
            ? attachmentTurn
            : (migratedNodeById.get(divergedFrom)?.turn_number ?? branch.diverged_at_turn),
          node_count: migratedIncoming.filter(node => node.branch_id === id).length
        };
      });
      const normalizedExistingBranches = existingBranches.map(branch => ({
        ...branch,
        is_active: branch.id === existingMeta.value.active_branch,
        node_count: existingNodes.filter(node => node.branch_id === branch.id).length
      }));
      const mergedNodes = existingNodes.map(node => node.id === attachmentNode.id ? updatedAttachment : node)
        .concat(migratedIncoming)
        .map(node => sanitizeTimelinePersistenceValue(node, `timeline_node.${node.id || 'unknown'}`));
      const mergedBranches = normalizedExistingBranches.concat(remappedBranches);
      const mergedMeta = {
        ...existingMeta,
        value: {
          ...existingMeta.value,
          total_nodes: mergedNodes.length
        }
      };
      assertTimelineSave({ nodes: mergedNodes, branches: mergedBranches, meta: mergedMeta });
      return {
        replace: true,
        nodes: mergedNodes,
        branches: mergedBranches,
        meta: mergedMeta,
        result: { root: migratedIncoming.find(node => node.id === importedRootId), nodes: migratedIncoming, branches: remappedBranches }
      };
    });
    const maintenanceMigration = await this._migrateLegacyMaintenanceNodes();
    const committedRootId = maintenanceMigration?.targetByLegacyId?.[imported.root.id]
      || imported.root.id;
    const [committedRoot, committedNodes, committedBranches] = await Promise.all([
      stateManager.dbGet('timeline_nodes', committedRootId),
      stateManager.dbGetAll('timeline_nodes'),
      stateManager.dbGetAll('timeline_branches')
    ]);
    if (!committedRoot) throw new Error('合并导入迁移后的根节点不存在');
    this._nodeCache.clear();
    for (const node of committedNodes) this._nodeCache.set(node.id, node);
    this._cacheTreeSummary();
    eventBus.emit('timeline:imported', {
      nodes: committedNodes,
      branches: committedBranches,
      mode: 'merge'
    });
    this._maybeArchive().catch(() => {});
    return committedRoot;
  }

  _getImportedRestorePlan(currentNode, allNodes) {
    if (!currentNode?.id) throw new Error('导入的当前节点不存在');
    const nodeById = new Map((allNodes || []).filter(node => node?.id).map(node => [node.id, node]));
    const visited = new Set();
    const chain = [];
    let cursor = nodeById.get(currentNode?.id);
    while (cursor) {
      if (visited.has(cursor.id)) {
        throw new Error('导入状态恢复失败: 父节点关系包含环');
      }
      visited.add(cursor.id);
      chain.unshift(cursor);
      if (!cursor.parent_id) break;
      cursor = nodeById.get(cursor.parent_id);
      if (!cursor) throw new Error('导入状态恢复失败: 父节点不存在');
    }
    const snapshot = chain.at(-1)?.state_snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error(`导入状态恢复失败: 当前节点 ${currentNode.id} 缺少有效状态快照，无法精确恢复`);
    }
    return { snapshot: this._alignSnapshotTurnCount(deepClone(snapshot), currentNode.turn_number) };
  }

  _prepareImportedState(currentNode, allNodes) {
    const plan = this._getImportedRestorePlan(currentNode, allNodes);
    return stateManager.prepareRestore(plan.snapshot);
  }

  async _restoreImportedState(currentNode, allNodes) {
    stateManager.commitPreparedRestore(this._prepareImportedState(currentNode, allNodes));
  }

  async promoteBranchToMain(branchId) {
    if (branchId === 'branch_main') return { promoted: false, reason: 'already-main' };
    await this._hydrateAllCompressedNodes();
    const demotedBranchId = generateId('branch_alt');
    const changedAt = Date.now();
    const mutation = await stateManager.dbMutateTimeline(({ nodes, branches, meta }) => {
      if (!meta?.value) throw new Error('时间线元数据不存在，无法升格分支');
      const targetBranch = branches.find(branch => branch.id === branchId);
      const mainBranch = branches.find(branch => branch.id === 'branch_main');
      if (!targetBranch) throw new Error('分支不存在');
      if (!mainBranch) throw new Error('主线分支不存在');
      if (branches.some(branch => branch.id === demotedBranchId)) {
        throw new Error('降格分支 ID 冲突，请重试');
      }
      const byId = new Map(nodes.map(node => [node.id, node]));
      const targetNodes = nodes.filter(node => node.branch_id === branchId).sort(compareTimelinePosition);
      if (!targetNodes.length) throw new Error('目标分支没有节点，无法升格');
      const firstTargetNode = targetNodes[0];
      const divergenceId = targetBranch.diverged_from || firstTargetNode.parent_id;
      const divergenceNode = byId.get(divergenceId);
      if (!divergenceNode || divergenceNode.branch_id !== 'branch_main') {
        throw new Error('只有直接从主线分歧的 IF 分支可以升格');
      }

      const descendantIds = new Set();
      const pending = [...(Array.isArray(divergenceNode.children_ids) ? divergenceNode.children_ids : [])];
      while (pending.length) {
        const nodeId = pending.pop();
        if (!nodeId || descendantIds.has(nodeId)) continue;
        const node = byId.get(nodeId);
        if (!node) throw new Error(`时间线子节点不存在: ${nodeId}`);
        descendantIds.add(nodeId);
        if (!Array.isArray(node.children_ids)) throw new Error(`节点 ${nodeId} children_ids 无效`);
        pending.push(...node.children_ids);
      }
      const demotedIds = new Set(nodes
        .filter(node => node.branch_id === 'branch_main' && descendantIds.has(node.id))
        .map(node => node.id));
      const targetIds = new Set(targetNodes.map(node => node.id));
      const updatedNodes = nodes.map(node => {
        if (targetIds.has(node.id)) return remapNodeRuntimeBranch(node, 'branch_main');
        if (demotedIds.has(node.id)) return remapNodeRuntimeBranch(node, demotedBranchId);
        return node;
      });
      const updatedById = new Map(updatedNodes.map(node => [node.id, node]));
      const currentNode = updatedById.get(meta.value.current_id);
      if (!currentNode) throw new Error('当前时间线节点不存在，无法升格分支');
      const activeBranchId = currentNode.branch_id;
      const allMainNodes = updatedNodes.filter(node => node.branch_id === 'branch_main');
      const promotedHead = updatedById.get(targetBranch.head_node_id);
      if (!promotedHead || promotedHead.branch_id !== 'branch_main') {
        throw new Error('升格分支头节点无效');
      }

      const updatedBranches = branches
        .filter(branch => branch.id !== branchId)
        .map(branch => branch.id === 'branch_main'
          ? {
              ...branch,
              head_node_id: promotedHead.id,
              node_count: allMainNodes.length,
              is_active: activeBranchId === 'branch_main'
            }
          : { ...branch, is_active: branch.id === activeBranchId });
      let demotedBranch = null;
      if (demotedIds.size) {
        const demotedNodes = updatedNodes.filter(node => demotedIds.has(node.id));
        const demotedHead = latestTimelineNode(demotedNodes);
        demotedBranch = {
          id: demotedBranchId,
          name: `原主线 (自第 ${firstTargetNode.turn_number} 回)`,
          color: '#A9A9A9',
          description: `原主线分支，自第 ${firstTargetNode.turn_number} 回起降格为IF线`,
          created_at: changedAt,
          diverged_from: divergenceNode.id,
          diverged_at_turn: divergenceNode.turn_number,
          head_node_id: demotedHead.id,
          node_count: demotedNodes.length,
          is_active: activeBranchId === demotedBranchId
        };
        updatedBranches.push(demotedBranch);
      }
      if (!updatedBranches.some(branch => branch.id === activeBranchId)) {
        throw new Error('升格后当前节点所属分支不存在');
      }
      const updatedMeta = {
        ...meta,
        value: {
          ...meta.value,
          active_branch: activeBranchId,
          total_nodes: updatedNodes.length
        }
      };
      return {
        deleteBranchIds: [branchId],
        nodes: updatedNodes.filter(node => targetIds.has(node.id) || demotedIds.has(node.id)),
        branches: updatedBranches,
        meta: updatedMeta,
        result: {
          promotedNodeIds: [...targetIds],
          demotedNodeIds: [...demotedIds],
          demotedBranch,
          currentNodeId: currentNode.id,
          previousActiveBranchId: meta.value.active_branch,
          activeBranchId,
          updatedNodes: updatedNodes.filter(node => targetIds.has(node.id) || demotedIds.has(node.id))
        }
      };
    });

    for (const node of mutation.updatedNodes) this._nodeCache.set(node.id, node);
    const metaState = stateManager.getSub('_meta') || {};
    metaState.current_node_id = mutation.currentNodeId;
    metaState.active_branch = mutation.activeBranchId;
    stateManager.setSub('_meta', metaState);
    for (const key of ['_story_direction', '_agent_story_plan']) {
      const value = stateManager.getSub(key);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (value.branchId === mutation.previousActiveBranchId) {
        stateManager.setSub(key, { ...value, branchId: mutation.activeBranchId });
      }
    }
    this._cacheTreeSummary();
    eventBus.emit('timeline:branch-promoted', {
      oldBranchId: branchId,
      newMainBranchId: 'branch_main',
      demotedBranchId: mutation.demotedBranch?.id || null
    });
    if (mutation.previousActiveBranchId !== mutation.activeBranchId) {
      eventBus.emit('timeline:branch-switched', {
        from: mutation.previousActiveBranchId,
        to: mutation.activeBranchId,
        reason: 'promotion'
      });
    }
    this._maybeArchive().catch(err => console.warn('[Timeline] archive failed:', err.message));
    return {
      promoted: true,
      branchId,
      promotedNodeIds: mutation.promotedNodeIds,
      demotedNodeIds: mutation.demotedNodeIds,
      demotedBranchId: mutation.demotedBranch?.id || null,
      currentNodeId: mutation.currentNodeId,
      activeBranchId: mutation.activeBranchId
    };
  }

  async deleteBranch(branchId) {
    if (branchId === 'branch_main') throw new Error('Cannot delete main branch');
    await this._hydrateAllCompressedNodes();
    const mutation = await stateManager.dbMutateTimeline(({ nodes, branches, meta }) => {
      if (!meta?.value) throw new Error('时间线元数据不存在，无法删除分支');
      if (!branches.some(branch => branch.id === branchId)) throw new Error('分支不存在');
      const byId = new Map(nodes.map(node => [node.id, node]));
      const deleteIds = new Set(nodes.filter(node => node.branch_id === branchId).map(node => node.id));
      if (!deleteIds.size) throw new Error('目标分支没有节点，无法安全删除');

      let changed = true;
      while (changed) {
        changed = false;
        const pending = [...deleteIds];
        while (pending.length) {
          const node = byId.get(pending.pop());
          if (!node) continue;
          if (!Array.isArray(node.children_ids)) throw new Error(`节点 ${node.id} children_ids 无效`);
          for (const childId of node.children_ids) {
            if (!byId.has(childId)) throw new Error(`时间线子节点不存在: ${childId}`);
            if (deleteIds.has(childId)) continue;
            deleteIds.add(childId);
            pending.push(childId);
            changed = true;
          }
        }
        for (const branch of branches) {
          if (branch.id === 'branch_main' || !deleteIds.has(branch.diverged_from)) continue;
          for (const node of nodes) {
            if (node.branch_id !== branch.id || deleteIds.has(node.id)) continue;
            deleteIds.add(node.id);
            changed = true;
          }
        }
      }

      const deletedBranchIds = new Set([branchId]);
      for (const branch of branches) {
        const branchNodes = nodes.filter(node => node.branch_id === branch.id);
        if (branchNodes.some(node => deleteIds.has(node.id))) {
          if (branch.id === 'branch_main') {
            throw new Error('分支删除将影响主线节点，操作已拒绝');
          }
          for (const node of branchNodes) deleteIds.add(node.id);
          deletedBranchIds.add(branch.id);
        }
      }

      const retainedNodes = nodes
        .filter(node => !deleteIds.has(node.id))
        .map(node => ({
          ...node,
          children_ids: Array.isArray(node.children_ids)
            ? node.children_ids.filter(childId => !deleteIds.has(childId))
            : []
        }));
      const retainedById = new Map(retainedNodes.map(node => [node.id, node]));
      let currentNodeId = meta.value.current_id;
      let preparedRestore = null;
      if (deleteIds.has(currentNodeId)) {
        let cursor = byId.get(currentNodeId);
        const visited = new Set();
        while (cursor && deleteIds.has(cursor.id)) {
          if (visited.has(cursor.id)) throw new Error('时间线父节点关系包含环，无法删除分支');
          visited.add(cursor.id);
          cursor = cursor.parent_id ? byId.get(cursor.parent_id) : null;
        }
        if (!cursor || !retainedById.has(cursor.id)) {
          throw new Error('删除分支后没有可恢复的父节点');
        }
        preparedRestore = this._prepareNodeRestore(cursor);
        currentNodeId = cursor.id;
      }
      const currentNode = retainedById.get(currentNodeId);
      if (!currentNode) throw new Error('删除分支后的当前节点不存在');
      const activeBranchId = currentNode.branch_id;
      const retainedBranches = [];
      for (const branch of branches) {
        if (deletedBranchIds.has(branch.id)) continue;
        const branchNodes = retainedNodes.filter(node => node.branch_id === branch.id);
        if (!branchNodes.length) throw new Error(`保留分支 ${branch.id} 没有节点`);
        const retainedHead = retainedById.get(branch.head_node_id);
        const head = retainedHead?.branch_id === branch.id ? retainedHead : latestTimelineNode(branchNodes);
        retainedBranches.push({
          ...branch,
          head_node_id: head.id,
          node_count: branchNodes.length,
          is_active: branch.id === activeBranchId
        });
      }
      if (!retainedBranches.some(branch => branch.id === activeBranchId)) {
        throw new Error('删除分支后当前节点所属分支不存在');
      }
      const updatedMeta = {
        ...meta,
        value: {
          ...meta.value,
          current_id: currentNodeId,
          active_branch: activeBranchId,
          total_nodes: retainedNodes.length
        }
      };
      const updatedNodes = retainedNodes.filter(node => {
        const previous = byId.get(node.id);
        return !persistenceValuesEqual(previous?.children_ids, node.children_ids);
      });
      return {
        deleteNodeIds: [...deleteIds],
        deleteBranchIds: [...deletedBranchIds],
        nodes: updatedNodes,
        branches: retainedBranches,
        meta: updatedMeta,
        result: {
          activeBranchId,
          currentNodeId,
          deletedNodeIds: [...deleteIds],
          deletedBranchIds: [...deletedBranchIds],
          preparedRestore,
          previousCurrentId: meta.value.current_id,
          updatedNodes
        }
      };
    });

    if (mutation.preparedRestore) stateManager.commitPreparedRestore(mutation.preparedRestore);
    const metaState = stateManager.getSub('_meta') || {};
    metaState.current_node_id = mutation.currentNodeId;
    metaState.active_branch = mutation.activeBranchId;
    stateManager.setSub('_meta', metaState);
    for (const nodeId of mutation.deletedNodeIds) this._nodeCache.delete(nodeId);
    for (const node of mutation.updatedNodes) this._nodeCache.set(node.id, node);
    if (mutation.deletedNodeIds.length) {
      eventBus.emit('timeline:nodes-deleted', {
        nodeIds: mutation.deletedNodeIds,
        reason: 'branch-delete'
      });
    }
    if (mutation.previousCurrentId !== mutation.currentNodeId) {
      eventBus.emit('timeline:jumped', {
        fromNodeId: mutation.previousCurrentId,
        toNodeId: mutation.currentNodeId,
        branchId: mutation.activeBranchId,
        reason: 'branch-delete'
      });
    }
    this._cacheTreeSummary();
    eventBus.emit('timeline:branch-deleted', {
      branchId,
      deletedBranchIds: mutation.deletedBranchIds
    });
    this._maybeArchive().catch(err => console.warn('[Timeline] archive failed:', err.message));
    return {
      deletedNodes: mutation.deletedNodeIds.length,
      deletedNodeIds: mutation.deletedNodeIds,
      deletedBranchIds: mutation.deletedBranchIds,
      currentNodeId: mutation.currentNodeId,
      activeBranchId: mutation.activeBranchId
    };
  }

  async emergencyReset() {
    await stateManager.dbReplaceTimeline({ nodes: [], branches: [], meta: null });
    stateManager.reset();
    localStorage.removeItem('naruto_timeline_summary');
    this._nodeCache.clear();
    this._initialized = false;
  }
}

export const timelineSystem = new TimelineSystem();
export default timelineSystem;
