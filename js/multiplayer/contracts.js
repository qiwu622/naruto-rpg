// Browser-only multiplayer transport contracts.
//
// This module intentionally contains no imports from the single-player
// MessagePipeline, InstructionParser or stateManager. The browser submits
// player intent and renders member-projected server responses only.

export const MULTIPLAYER_API_BASE = '/api/multiplayer';

export const ROOM_ORIGIN_TYPES = Object.freeze([
  'existing_save_derived',
  'new_multiplayer_save'
]);

export const NARRATIVE_MODES = Object.freeze(['shared', 'dual_pov']);
export const ACTION_VISIBILITIES = Object.freeze(['open', 'sealed']);
export const NARRATION_PREFERENCES = Object.freeze(['full', 'summarize_intent']);
export const ROOM_SEATS = Object.freeze(['A', 'B']);
export const CREDENTIAL_USAGE_POLICIES = Object.freeze([
  'A_ONLY',
  'B_ONLY',
  'ALTERNATE'
]);

export const GUEST_CHARACTER_IMPORT_SCHEMA =
  'naruto.multiplayer-guest-character-import/v1';

export const BILLABLE_MODEL_STAGES = Object.freeze([
  'referee',
  'resolution_completeness_reviewer',
  'resolution_repair',
  'continuity_steward',
  'continuity_repair',
  'narrative_grounding_reviewer',
  'writer'
]);

export const SHARED_STAGE_DATA_CATEGORIES = Object.freeze([
  'audience_private_projections',
  'both_action_originals',
  'canonical_room_state',
  'dual_pov_drafts',
  'relevant_private_memories',
  'reviewer_outputs'
]);

export const POV_WRITER_DATA_CATEGORIES = Object.freeze([
  'audience_action_original',
  'audience_private_memory',
  'audience_projection',
  'narration_preferences'
]);

export const DATA_PROCESSING_TERMS_REVISION =
  'naruto.multiplayer-byok-data-processing/v1';

/**
 * Named SSE events must be registered explicitly with EventSource. Unknown
 * future events remain harmless: a reconnect still advances from the last
 * event that this client understood and the authoritative REST projection is
 * refreshed by room.snapshot/turn events.
 */
export const MULTIPLAYER_EVENT_TYPES = Object.freeze([
  'room.snapshot',
  'room.invite_created',
  'room.invite_revoked',
  'room.opening_changed',
  'room.opening_committed',
  'member.presence_changed',
  'chat.message_created',
  'narrative_mode.changed',
  'room.narrative_preset_changed',
  'narrative_mode.queued',
  'billing.credential_policy_changed',
  'turn.opened',
  'billing.payer_selection_required',
  'billing.payer_selection_changed',
  'action.locked',
  'action.revealed_pre_resolution',
  'turn.sealed',
  'billing.plan_ready',
  'billing.plan_amended',
  'billing.grant_changed',
  'billing.consent_required',
  'billing.authorization_required',
  'resolution.progress',
  'turn.repairing_draft',
  'turn.repair_paused',
  'turn.repair_resumed',
  'turn.retryable_failed',
  'action.revealed_after_commit',
  'turn.committed',
  'room.archived',
  'room.continuation_prepared',
  'room.epoch_activated',
  'room.singleplayer_export_ready',
  'lineage.source_import_validated',
  'lineage.proposal_created',
  'lineage.proposal_acceptance_changed',
  'lineage.room_archived',
  'lineage.epoch_activated',
  'turn.void_requested',
  'turn.voided'
]);

export const TURN_WAITING_STATUSES = Object.freeze([
  'AWAITING_PAYER_SELECTION',
  'COLLECTING_ACTIONS',
  'ONE_ACTION_LOCKED',
  'SEALED',
  'AWAITING_BILLING_AUTHORIZATION',
  'REPAIRING_DRAFT',
  'REPAIR_PAUSED',
  'RETRYABLE_FAILED'
]);

export const TURN_PROGRESS_LABELS = Object.freeze({
  AWAITING_PAYER_SELECTION: '等待本回合 API 付款与配置选择',
  COLLECTING_ACTIONS: '等待双方锁定行动',
  ONE_ACTION_LOCKED: '一方已锁定，继续无限等待另一方',
  SEALED: '双方行动已封盘',
  AWAITING_BILLING_AUTHORIZATION: '等待补充执行授权或预算',
  RESOLVING: '裁决双方行动',
  RENDERING: '生成剧情正文',
  STAGING_UPDATES: '暂存变量、记忆与日报',
  AUDITING: '核对完整义务与正文',
  REPAIRING_DRAFT: '原 Continuity 会话正在补齐缺项',
  RENDERING_REPAIR: '仅修复受影响的正文',
  RESOLUTION_HANDOFF: '裁决合同正在最小范围交接修复',
  REPAIR_PAUSED: '连续性修复已暂停，可从缺项继续',
  RETRYABLE_FAILED: '阶段失败，可从最近有效阶段重试',
  COMMITTING: '正在原子提交正文与世界状态',
  RECOVERING_COMMIT: '正在核对未知提交结果',
  COMMITTED: '本回合已完整提交',
  VOID_REQUESTED: '共同作废已请求，等待在途调用到达安全边界',
  TURN_VOIDED: '本回合已共同作废',
  CONSISTENCY_FAULT: '一致性故障，已停止猜测性写入'
});

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const AUTHORITY_FIELDS = new Set([
  'authenticated_user_id',
  'accepted_by_user_id',
  'audience_owner_user_id',
  'host_user_id',
  'member_id',
  'owner_user_id',
  'payer',
  'payer_id',
  'payer_seat',
  'payer_seat_id',
  'payer_user_id',
  'profile_owner_user_id',
  'room_owner',
  'room_owner_user_id',
  'seat',
  'seat_id',
  'subject_user_id',
  'user_id'
]);
const TOP_LEVEL_BINDING_FIELDS = new Set(['epoch_id', 'room_id', 'turn_id']);
const PROTOTYPE_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

export function normalizeFieldName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[-\s]+/gu, '_')
    .toLowerCase();
}

export function assertPathIdentifier(value, label = 'identifier') {
  const text = String(value ?? '');
  if (!IDENTIFIER_PATTERN.test(text)) {
    throw new TypeError(`${label} is not a valid multiplayer identifier`);
  }
  return text;
}

export function assertPositiveInteger(value, label = 'number') {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

/**
 * Mirrors the HTTP authority boundary so UI mistakes fail before a request is
 * sent. The server remains authoritative and performs the same check again.
 */
export function assertNoClientAuthorityFields(value, {
  opaqueDataFields = [],
  maxDepth = 32,
  maxNodes = 20_000
} = {}) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('multiplayer request body must be an object');
  }
  const opaqueData = new Set(opaqueDataFields.map(normalizeFieldName));
  const stack = [{ value, path: '$', depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) {
      throw new TypeError('multiplayer request body exceeds structural limits');
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => stack.push({
        value: child,
        path: `${current.path}[${index}]`,
        depth: current.depth + 1
      }));
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      const normalized = normalizeFieldName(key);
      const path = `${current.path}.${key}`;
      if (PROTOTYPE_FIELDS.has(key)
        || AUTHORITY_FIELDS.has(normalized)
        || (current.depth === 0 && TOP_LEVEL_BINDING_FIELDS.has(normalized))) {
        throw new TypeError(`client authority field is forbidden at ${path}`);
      }
      // Save/timeline documents and the versioned guest-character snapshot are
      // opaque untrusted data whose dedicated server codecs validate nested
      // semantics. Only the corresponding routes opt into exact top-level
      // exceptions; every request envelope remains under the authority scan.
      if (current.depth === 0 && opaqueData.has(normalized)) continue;
      stack.push({ value: child, path, depth: current.depth + 1 });
    }
  }
  return value;
}

export function createIdempotencyKey(prefix = 'mp') {
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 24) || 'mp';
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${safePrefix}-${globalThis.crypto.randomUUID()}`;
  }
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${safePrefix}-${hex}`;
  }
  throw new Error('secure browser randomness is required for multiplayer idempotency keys');
}

export function turnProgressLabel(status) {
  return TURN_PROGRESS_LABELS[status] ?? (status ? `服务端状态：${status}` : '等待房间状态');
}

export function isTerminalTurnStatus(status) {
  return ['COMMITTED', 'TURN_VOIDED', 'CONSISTENCY_FAULT'].includes(status);
}
