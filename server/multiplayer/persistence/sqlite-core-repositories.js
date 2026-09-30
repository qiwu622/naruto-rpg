import { randomBytes, randomUUID } from 'node:crypto';
import { readTurnGenerationProgress } from './turn-generation-progress.js';
import { normalizeNarrativePreset, narrativePresetSummary, snapshotNarrativePreset } from '../contracts/narrative-preset.js';
import { detailedOpeningDraft, visibleOpeningDraft } from '../../../js/multiplayer/opening-draft-bridge.js';

import {
  ACTION_TURN_MEMBER_PROJECTION_SCHEMA,
  COMMITTED_TURN_PUBLICATION_SCHEMA,
  assertActionRequest,
  assertActionTurnMemberProjection
} from '../contracts/action-contracts.js';
import {
  ROOM_CHAT_MESSAGE_SCHEMA,
  assertRoomChatMessage,
  assertRoomChatMessageRequest
} from '../contracts/chat-contracts.js';
import { NARRATIVE_MODES } from '../contracts/enums.js';
import {
  ROOM_CHECKPOINT_SCHEMA,
  ROOM_EPOCH_SCHEMA,
  assertRoomCheckpoint,
  assertRoomEpoch,
  assertRoomOrigin
} from '../contracts/lineage-contracts.js';
import {
  assertNarrativeModeChangeRequest,
  assertTurnExecutionPlan
} from '../contracts/room-contracts.js';
import {
  canonicalStringify,
  canonicalizeJson,
  hmacSha256,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { projectMemberRoomState } from '../domain/member-state-projector.js';
import {
  openNarrativeDeliveryContent
} from '../security/narrative-delivery-content-codec.js';
import {
  assertActionContentCodec,
  assertMultiplayerCoreRepositoryBundle
} from './core-repository-interfaces.js';

const ACTION_CONTENT_SCHEMA = 'naruto.multiplayer-action-content/v1';
const EVENT_PROJECTION_VERSION = 'naruto.multiplayer-room-event-projection/v1';
const ROOM_SEATS = Object.freeze(['A', 'B']);
const OPENING_PHASES = Object.freeze(['DAWN', 'DAY', 'DUSK', 'NIGHT']);
const OPENING_TEXT_LIMITS = Object.freeze({
  display_name: 80,
  rank: 80,
  affiliation: 160,
  background: 2_000,
  location: 160,
  goal: 1_000,
  opening_hook: 2_000
});
const READABLE_INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Retained only for the legacy NOT NULL column; room passwords do not expire.
const ROOM_PASSWORD_COMPATIBILITY_EXPIRY = '9999-12-31T23:59:59.999Z';
const TERMINAL_TURN_STATUSES = new Set([
  'TURN_VOIDED',
  'COMMITTED',
  'CONSISTENCY_FAULT'
]);
const ID_REGEXP = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL_REGEXP = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;

function fail(code, message, details = {}, status = undefined) {
  throw new DomainError(code, message, details, status === undefined ? {} : { status });
}

function assertConnection(connection) {
  if (!connection
    || typeof connection.read !== 'function'
    || typeof connection.write !== 'function') {
    fail(
      'MULTIPLAYER_REPOSITORY_CONFIGURATION_INVALID',
      'a multiplayer SQLite connection is required'
    );
  }
  return connection;
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !ID_REGEXP.test(value)) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must be a valid identifier`, { field: label });
  }
  return value;
}

function assertPrincipal(value, label = 'authenticated_user_id') {
  if (typeof value !== 'string' || !PRINCIPAL_REGEXP.test(value)) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must be a valid authenticated principal`, {
      field: label
    });
  }
  return value;
}

function assertRevision(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must be a safe integer of at least ${min}`, {
      field: label
    });
  }
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('REPOSITORY_CLOCK_INVALID', `${label} must be an ISO timestamp`, { field: label });
  }
  return value;
}

function readableInviteFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    fail(
      'MULTIPLAYER_REPOSITORY_CONFIGURATION_INVALID',
      'invite token generator must return exactly 32 random bytes'
    );
  }
  const symbols = Array.from(bytes.subarray(0, 16), value => (
    READABLE_INVITE_ALPHABET[value & 31]
  )).join('');
  return `N-${symbols.match(/.{1,4}/gu).join('-')}`;
}

function normalizeIssuedInviteToken(value, randomTokenBytes) {
  if (value === undefined || value === null) {
    return readableInviteFromBytes(randomTokenBytes(32));
  }
  if (typeof value !== 'string' || value.trim() === '') {
    fail(
      'REPOSITORY_INPUT_INVALID',
      'room_password must be a non-empty string',
      { field: 'invite_token' }
    );
  }
  return value.trim();
}

function normalizeInviteTokenForLookup(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVITE_TOKEN_INVALID', '房间密码不正确', {}, 404);
  }
  return value.trim();
}

function normalizeRoomCode(value, fallbackRoomId) {
  const candidate = value === undefined || value === null ? fallbackRoomId : value;
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    fail('REPOSITORY_INPUT_INVALID', 'room_code must be a non-empty string', {
      field: 'room_code'
    });
  }
  return candidate.trim().toUpperCase();
}

function assertSyncResult(value, label) {
  if (value && typeof value.then === 'function') {
    fail(
      'ASYNC_SQLITE_TRANSACTION_FORBIDDEN',
      `${label} must be synchronous because it runs inside BEGIN IMMEDIATE`
    );
  }
  return value;
}

function immutable(value) {
  return freezeDeep(canonicalizeJson(value));
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function parseProjectedJson(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('PERSISTED_EVENT_CORRUPT', `${label} is not valid JSON`);
  }
  return immutable(parsed);
}

function hashCanonical(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function normalizeOpeningText(value, field) {
  if (typeof value !== 'string') {
    fail('ROOM_OPENING_INVALID', `${field} must be text`, { field });
  }
  const normalized = value.trim();
  if (!normalized
    || normalized.length > OPENING_TEXT_LIMITS[field]
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    fail('ROOM_OPENING_INVALID', `${field} is invalid`, { field });
  }
  return normalized;
}

function normalizeOpeningDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('ROOM_OPENING_INVALID', 'opening draft must be an object');
  }
  const allowed = new Set(['start_time', ...Object.keys(OPENING_TEXT_LIMITS)]);
  const unknown = Object.keys(value).find(key => !allowed.has(key) && key !== 'detailed_draft');
  if (unknown) {
    fail('ROOM_OPENING_INVALID', 'opening draft contains an unknown field', { field: unknown });
  }
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      fail('ROOM_OPENING_INVALID', `opening draft is missing ${field}`, { field });
    }
  }
  const start = value.start_time;
  if (!start || typeof start !== 'object' || Array.isArray(start)) {
    fail('ROOM_OPENING_INVALID', 'start_time must be an object', { field: 'start_time' });
  }
  const timeFields = ['year', 'month', 'day', 'phase'];
  const unknownTime = Object.keys(start).find(key => !timeFields.includes(key));
  if (unknownTime || timeFields.some(key => !Object.prototype.hasOwnProperty.call(start, key))) {
    fail('ROOM_OPENING_INVALID', 'start_time must contain only year, month, day and phase', {
      field: unknownTime ? `start_time.${unknownTime}` : 'start_time'
    });
  }
  const bounded = (field, min, max) => {
    const candidate = start[field];
    if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
      fail('ROOM_OPENING_INVALID', `start_time.${field} is invalid`, {
        field: `start_time.${field}`
      });
    }
    return candidate;
  };
  if (!OPENING_PHASES.includes(start.phase)) {
    fail('ROOM_OPENING_INVALID', 'start_time.phase is invalid', { field: 'start_time.phase' });
  }
  let detailed = {};
  if (value.detailed_draft !== undefined) {
    if (!value.detailed_draft || typeof value.detailed_draft !== 'object'
      || Array.isArray(value.detailed_draft) || JSON.stringify(value.detailed_draft).length > 128_000) {
      fail('ROOM_OPENING_INVALID', '详细开局格式无效或内容过长', { field: 'detailed_draft' });
    }
    try { detailed = { detailed_draft: detailedOpeningDraft(value) }; }
    catch { fail('ROOM_OPENING_INVALID', '详细开局格式无效', { field: 'detailed_draft' }); }
  }
  return immutable({
    start_time: {
      year: bounded('year', 0, 9_999),
      month: bounded('month', 1, 12),
      day: bounded('day', 1, 31),
      phase: start.phase
    },
    ...detailed,
    ...Object.fromEntries(
      Object.keys(OPENING_TEXT_LIMITS).map(field => [field, normalizeOpeningText(value[field], field)])
    )
  });
}

function openingDraftRow(row) {
  let draft;
  try {
    draft = normalizeOpeningDraft(JSON.parse(row.draft_json));
  } catch (error) {
    if (error instanceof DomainError && error.code === 'ROOM_OPENING_INVALID') {
      fail('ROOM_OPENING_CORRUPT', 'persisted opening draft is invalid', {
        room_id: row.room_id,
        seat: row.seat_id
      });
    }
    throw error;
  }
  if (hashCanonical(draft) !== row.draft_commitment) {
    fail('ROOM_OPENING_CORRUPT', 'persisted opening commitment does not match its draft', {
      room_id: row.room_id,
      seat: row.seat_id
    });
  }
  return {
    seat: row.seat_id,
    revision: row.revision,
    commitment: row.draft_commitment,
    confirmed: row.confirmed_revision === row.revision
      && row.confirmed_commitment === row.draft_commitment
      && row.confirmed_at !== null,
    confirmed_at: row.confirmed_at,
    updated_at: row.updated_at,
    draft
  };
}

function openingProjection(database, roomId, viewerSeat, includePrivate = false) {
  const rows = database.prepare(`
    SELECT room_id, seat_id, revision, draft_json, draft_commitment,
           confirmed_revision, confirmed_commitment, confirmed_at, updated_at
      FROM room_opening_drafts
     WHERE room_id = ?
     ORDER BY seat_id
  `).all(roomId);
  if (rows.length === 0) return null;
  const drafts = Object.fromEntries(rows.map(row => {
    const opening = openingDraftRow(row);
    return [opening.seat, opening];
  }));
  const conflicts = [];
  const a = drafts.A?.draft;
  const b = drafts.B?.draft;
  if (!a || !b) {
    conflicts.push({
      code: 'OPENING_DRAFT_MISSING',
      severity: 'blocking',
      message: '双方都需要保存自己的开局。'
    });
  } else {
    if (canonicalStringify(a.start_time) !== canonicalStringify(b.start_time)) {
      conflicts.push({
        code: 'OPENING_TIME_MISMATCH',
        severity: 'blocking',
        message: 'A 与 B 的开局时间不一致，统一时间后才能开局。'
      });
    }
    if (a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }) === 0) {
      conflicts.push({
        code: 'OPENING_NAME_DUPLICATE',
        severity: 'warning',
        message: '两名角色使用了相同名字，请确认是否符合设定。'
      });
    }
    if (a.location !== b.location) {
      conflicts.push({
        code: 'OPENING_LOCATION_SPLIT',
        severity: 'info',
        message: '双方起点不同，将按分线开场处理；这不会阻止开局。'
      });
    }
  }
  const blocking = conflicts.some(item => item.severity === 'blocking');
  return immutable({
    schema: 'naruto.multiplayer-room-opening/v1',
    viewer_seat: viewerSeat,
    drafts: Object.fromEntries(ROOM_SEATS.map(seat => [seat, drafts[seat]
      ? { ...drafts[seat], draft: visibleOpeningDraft(drafts[seat].draft, includePrivate || seat === viewerSeat) } : null])),
    conflicts,
    blocking,
    ready: !blocking && Boolean(drafts.A?.confirmed && drafts.B?.confirmed)
  });
}

function defaultOpeningDraft(seat, profile = {}, startTime = undefined) {
  const fallbackName = seat === 'A' ? '玩家一' : '玩家二';
  return normalizeOpeningDraft({
    start_time: startTime ?? { year: 48, month: 1, day: 1, phase: 'DAWN' },
    display_name: profile.display_name ?? fallbackName,
    rank: profile.rank ?? '下忍',
    affiliation: profile.affiliation ?? '木叶隐村',
    background: profile.background ?? '一名刚刚踏上忍者道路的年轻忍者。',
    location: profile.location ?? '木叶隐村',
    goal: profile.goal ?? '在忍界中写下自己的故事',
    opening_hook: profile.opening_hook ?? '从一个看似平常的清晨开始。'
  });
}

function defaultIdFactory(kind) {
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

function normalizeGeneratedId(idFactory, kind) {
  return assertIdentifier(idFactory(kind), `${kind}_id`);
}

function activeMemberRows(database, roomId) {
  return database.prepare(`
    SELECT member_id, user_id, seat_id, ready_at
      FROM multiplayer_members
     WHERE room_id = ? AND member_status = 'ACTIVE'
     ORDER BY seat_id
  `).all(roomId);
}

function requireActiveMember(database, roomId, authenticatedUserId) {
  const row = database.prepare(`
    SELECT m.member_id, m.room_id, m.user_id, m.seat_id, m.member_status,
           r.room_code, r.origin_type, r.lifecycle, r.active_epoch_id, r.current_turn_id,
           r.state_revision, r.control_revision, r.event_seq,
           r.active_narrative_mode, r.queued_narrative_mode
      FROM multiplayer_members AS m
      JOIN multiplayer_rooms AS r ON r.room_id = m.room_id
     WHERE m.room_id = ? AND m.user_id = ? AND m.member_status = 'ACTIVE'
  `).get(roomId, authenticatedUserId);
  if (!row) {
    fail('ROOM_MEMBERSHIP_REQUIRED', 'the authenticated user is not an active room member', {
      room_id: roomId
    }, 403);
  }
  return row;
}

function requireWritableRoom(member) {
  if (member.lifecycle === 'ARCHIVED') {
    fail('ROOM_ARCHIVED_READ_ONLY', 'an archived room is read-only', {
      room_id: member.room_id
    }, 409);
  }
}

function updateEpochControl(database, epochId, controlRevision) {
  if (epochId === null) return;
  const updated = database.prepare(`
    UPDATE room_epochs
       SET control_revision = ?
     WHERE epoch_id = ? AND epoch_state = 'ACTIVE'
  `).run(controlRevision, epochId);
  if (updated.changes !== 1) {
    fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'active room and epoch control revisions diverged', {
      epoch_id: epochId,
      control_revision: controlRevision
    });
  }
}

function selectionSupportsNarrativeMode(turnMode, row) {
  if (!row) return false;
  if (row.scope === 'shared' && row.audience === 'shared') {
    return turnMode === 'shared'
      ? row.selected_narrative_mode === 'shared'
      : NARRATIVE_MODES.includes(row.selected_narrative_mode);
  }
  return turnMode === 'dual_pov'
    && row.scope === 'writer'
    && ROOM_SEATS.includes(row.audience)
    && row.selected_narrative_mode === 'dual_pov'
    && row.payer_accepted_at !== null;
}

function refreshZeroActionTurnSelectionStatus(database, turn, narrativeMode, changedAt) {
  if (!['AWAITING_PAYER_SELECTION', 'COLLECTING_ACTIONS'].includes(turn.turn_status)) {
    return turn.turn_status;
  }
  const rows = database.prepare(`
    SELECT scope, audience, selected_narrative_mode, payer_accepted_at
      FROM turn_model_selections
     WHERE turn_id = ? AND active = 1
     ORDER BY scope, audience
  `).all(turn.turn_id);
  const shared = rows.find(row => row.scope === 'shared' && row.audience === 'shared');
  const ready = selectionSupportsNarrativeMode(narrativeMode, shared)
    && (narrativeMode === 'shared' || ROOM_SEATS.every(audience => (
      selectionSupportsNarrativeMode(
        narrativeMode,
        rows.find(row => row.scope === 'writer' && row.audience === audience)
      )
    )));
  const nextStatus = ready ? 'COLLECTING_ACTIONS' : 'AWAITING_PAYER_SELECTION';
  const updated = database.prepare(`
    UPDATE multiplayer_turns
       SET turn_status = ?, updated_at = ?
     WHERE turn_id = ?
       AND turn_status IN ('AWAITING_PAYER_SELECTION', 'COLLECTING_ACTIONS')
       AND NOT EXISTS (
         SELECT 1 FROM action_submissions WHERE turn_id = ?
       )
  `).run(nextStatus, changedAt, turn.turn_id, turn.turn_id);
  if (updated.changes !== 1) {
    fail('NARRATIVE_MODE_CAS_FAILED', 'an action locked while refreshing payer selections');
  }
  return nextStatus;
}

function modeChangeResult(row, replayed) {
  return immutable({
    disposition: row.result_disposition,
    mode: row.requested_mode,
    control_revision: row.result_control_revision,
    replayed,
    changed: row.result_changed === 1
  });
}

function insertProjectedEvents(database, {
  roomId,
  epochId = null,
  turnId = null,
  endEventSeq,
  events,
  createdAt,
  idFactory
}) {
  if (events.length === 0) return Object.freeze([]);
  const firstEventSeq = endEventSeq - events.length + 1;
  const inserted = [];
  const insertEvent = database.prepare(`
    INSERT INTO room_events (
      event_id, room_id, event_seq, epoch_id, turn_id, event_type, audience,
      projection_version, projected_payload_json, payload_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOutbox = database.prepare(`
    INSERT INTO room_outbox (
      outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
      lease_fence, lease_expires_at, claimed_at, dispatched_at,
      attempt_count, created_at
    ) VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, 0, ?)
  `);

  events.forEach((event, offset) => {
    if (!['A', 'B', 'BOTH', 'SERVER'].includes(event.audience)) {
      fail('EVENT_PROJECTION_INVALID', 'room event audience is invalid');
    }
    if (typeof event.event_type !== 'string' || !event.event_type.trim()) {
      fail('EVENT_PROJECTION_INVALID', 'room event type is required');
    }
    const eventSeq = firstEventSeq + offset;
    const eventId = normalizeGeneratedId(idFactory, 'event');
    const outboxId = normalizeGeneratedId(idFactory, 'outbox');
    const payload = canonicalizeJson(event.payload);
    const payloadJson = canonicalStringify(payload);
    const payloadHash = `sha256:${sha256Hex(payloadJson)}`;
    insertEvent.run(
      eventId,
      roomId,
      eventSeq,
      epochId,
      turnId,
      event.event_type,
      event.audience,
      EVENT_PROJECTION_VERSION,
      payloadJson,
      payloadHash,
      createdAt
    );
    insertOutbox.run(outboxId, roomId, eventId, createdAt);
    inserted.push(Object.freeze({
      event_id: eventId,
      room_id: roomId,
      event_seq: eventSeq,
      audience: event.audience,
      event_type: event.event_type,
      payload: immutable(payload),
      outbox_id: outboxId
    }));
  });
  return Object.freeze(inserted);
}

function eventsForSeats(seats, eventType, payloadForSeat) {
  return seats.map(seat => ({
    audience: seat,
    event_type: eventType,
    payload: payloadForSeat(seat)
  }));
}

function epochContract(row) {
  return assertRoomEpoch({
    schema: ROOM_EPOCH_SCHEMA,
    epoch_id: row.epoch_id,
    room_id: row.room_id,
    lineage_id: row.lineage_id,
    epoch_no: row.epoch_no,
    base: {
      type: row.base_type,
      ref_id: row.base_ref_id,
      state_hash: row.base_state_hash
    },
    genesis_checkpoint_id: row.genesis_checkpoint_id,
    head_checkpoint_id: row.head_checkpoint_id,
    state_revision: row.state_revision,
    control_revision: row.control_revision,
    state: row.epoch_state,
    created_from_proposal_id: row.created_from_proposal_id,
    activated_at: row.activated_at
  });
}

function checkpointContract(row) {
  return assertRoomCheckpoint({
    schema: ROOM_CHECKPOINT_SCHEMA,
    checkpoint_id: row.checkpoint_id,
    room_id: row.room_id,
    lineage_id: row.lineage_id,
    epoch_id: row.epoch_id,
    turn_no: row.turn_no,
    kind: row.checkpoint_kind,
    parent_checkpoint_id: row.parent_checkpoint_id,
    turn_id: row.turn_id,
    commit_id: row.commit_id,
    state_revision: row.state_revision,
    state_hash: row.state_hash,
    snapshot_ref: row.snapshot_ref,
    created_at: row.created_at
  });
}

function roomProjection(database, roomId, viewerSeat) {
  const room = database.prepare(`
    SELECT room_id, room_code, origin_type, lineage_id, lifecycle, active_epoch_id,
           current_turn_id, state_revision, control_revision, event_seq,
           active_narrative_mode, queued_narrative_mode, narrative_preset_seat, narrative_presets_json, created_at,
           updated_at, archived_at
      FROM multiplayer_rooms WHERE room_id = ?
  `).get(roomId);
  if (!room) fail('ROOM_NOT_FOUND', 'room does not exist', { room_id: roomId }, 404);
  const members = database.prepare(`
    SELECT seat_id, member_status, joined_at, ready_at, left_at
      FROM multiplayer_members WHERE room_id = ? ORDER BY seat_id
  `).all(roomId).map(row => ({
    seat: row.seat_id,
    status: row.member_status,
    joined_at: row.joined_at,
    ready_at: row.ready_at,
    left_at: row.left_at
  }));
  const opening = room.origin_type === 'new_multiplayer_save'
    ? openingProjection(database, roomId, viewerSeat)
    : null;
  const frozenPreset = room.current_turn_id ? database.prepare('SELECT writer_preset_json FROM multiplayer_turns WHERE turn_id = ?').get(room.current_turn_id)?.writer_preset_json : null;
  const currentPreset = frozenPreset ? JSON.parse(frozenPreset) : null;
  return immutable({
    room_id: room.room_id,
    room_code: room.room_code,
    origin_type: room.origin_type,
    lineage_id: room.lineage_id,
    lifecycle: room.lifecycle,
    viewer_seat: viewerSeat,
    active_epoch_id: room.active_epoch_id,
    current_turn_id: room.current_turn_id,
    state_revision: room.state_revision,
    control_revision: room.control_revision,
    event_seq: room.event_seq,
    active_narrative_mode: room.active_narrative_mode,
    queued_narrative_mode: room.queued_narrative_mode,
    narrative_preset: { ...narrativePresetSummary(room), current_turn: currentPreset ? {
      source_seat: currentPreset.source_seat, name: currentPreset.preset?.name ?? '项目默认正文预设', hash: currentPreset.preset?.hash ?? null
    } : null },
    opening,
    members,
    created_at: room.created_at,
    updated_at: room.updated_at,
    archived_at: room.archived_at
  });
}

function validateSealedContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('ACTION_CONTENT_CODEC_INVALID', 'action codec returned an invalid envelope');
  }
  const bytes = (field, min) => {
    const candidate = value[field];
    if (!(candidate instanceof Uint8Array) || candidate.byteLength < min) {
      fail('ACTION_CONTENT_CODEC_INVALID', `action codec ${field} is invalid`);
    }
    return Buffer.from(candidate);
  };
  if (typeof value.master_key_version !== 'string' || value.master_key_version.length < 1) {
    fail('ACTION_CONTENT_CODEC_INVALID', 'action codec master_key_version is invalid');
  }
  return Object.freeze({
    action_ciphertext: bytes('action_ciphertext', 1),
    wrapped_data_key: bytes('wrapped_data_key', 16),
    nonce: bytes('nonce', 8),
    auth_tag: bytes('auth_tag', 8),
    master_key_version: value.master_key_version
  });
}

function normalizeGenesisSnapshot(value) {
  if (value === null || value === undefined) return null;
  const sealed = validateSealedContent({
    action_ciphertext: value.snapshot_ciphertext,
    wrapped_data_key: value.wrapped_data_key,
    nonce: value.nonce,
    auth_tag: value.auth_tag,
    master_key_version: value.master_key_version
  });
  return Object.freeze({
    snapshot_id: assertIdentifier(value.snapshot_id, 'genesis_snapshot.snapshot_id'),
    state_hash: typeof value.state_hash === 'string' ? value.state_hash : '',
    snapshot_ciphertext: sealed.action_ciphertext,
    wrapped_data_key: sealed.wrapped_data_key,
    nonce: sealed.nonce,
    auth_tag: sealed.auth_tag,
    master_key_version: sealed.master_key_version
  });
}

function normalizePendingGenesis(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('ROOM_GENESIS_INVALID', 'pending_genesis must be an object');
  }
  const allowed = new Set([
    'epoch',
    'genesis_checkpoint',
    'genesis_snapshot',
    'source_import_id',
    'source_state_hash'
  ]);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) {
    fail('ROOM_GENESIS_INVALID', 'pending_genesis contains an unknown field', { field: unknown });
  }
  const epoch = assertRoomEpoch(value.epoch, { origin_type: 'existing_save_derived' });
  const checkpoint = assertRoomCheckpoint(value.genesis_checkpoint);
  const snapshot = normalizeGenesisSnapshot(value.genesis_snapshot);
  const sourceImportId = assertIdentifier(value.source_import_id, 'pending_genesis.source_import_id');
  if (typeof value.source_state_hash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(value.source_state_hash)) {
    fail('ROOM_GENESIS_INVALID', 'pending_genesis.source_state_hash is invalid');
  }
  if (!snapshot
    || epoch.room_id !== checkpoint.room_id
    || epoch.lineage_id !== checkpoint.lineage_id
    || epoch.epoch_id !== checkpoint.epoch_id
    || epoch.epoch_no !== 1
    || epoch.base.type !== 'origin_snapshot'
    || epoch.base.ref_id !== sourceImportId
    || epoch.genesis_checkpoint_id !== checkpoint.checkpoint_id
    || epoch.head_checkpoint_id !== checkpoint.checkpoint_id
    || epoch.state !== 'ACTIVE'
    || epoch.created_from_proposal_id !== null
    || checkpoint.kind !== 'genesis'
    || epoch.state_revision !== checkpoint.state_revision
    || epoch.base.state_hash !== checkpoint.state_hash
    || snapshot.snapshot_id !== checkpoint.snapshot_ref
    || snapshot.state_hash !== checkpoint.state_hash
    || epoch.activated_at !== checkpoint.created_at) {
    fail('ROOM_GENESIS_INVALID', 'pending genesis lineage and snapshot do not form one basis');
  }
  return Object.freeze({
    epoch,
    checkpoint,
    snapshot,
    source_import_id: sourceImportId,
    source_state_hash: value.source_state_hash
  });
}

function actionCodecContext(row) {
  return Object.freeze({
    purpose: ACTION_CONTENT_SCHEMA,
    room_id: row.room_id,
    epoch_id: row.epoch_id,
    turn_id: row.turn_id,
    submission_id: row.submission_id,
    member_id: row.member_id,
    seat_id: row.seat_id
  });
}

function openActionContent(codec, row) {
  const value = assertSyncResult(codec.openJson({
    action_ciphertext: Buffer.from(row.action_ciphertext),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  }, actionCodecContext(row)), 'action content codec openJson');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== ACTION_CONTENT_SCHEMA
    || typeof value.text !== 'string'
    || typeof value.request_hash !== 'string') {
    fail('ACTION_CONTENT_CORRUPT', 'decrypted action content failed its storage contract', {
      submission_id: row.submission_id
    });
  }
  return value;
}

function openCommittedSnapshot(codec, row) {
  const state = codec.openJson({
    action_ciphertext: Buffer.from(row.snapshot_ciphertext),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  }, {
    schema: 'naruto.multiplayer-room-snapshot-context/v1',
    room_id: row.room_id,
    epoch_id: row.epoch_id,
    checkpoint_id: row.checkpoint_id,
    snapshot_id: row.snapshot_id,
    state_revision: row.state_revision,
    state_hash: row.state_hash
  });
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || state.meta?.state_revision !== row.state_revision) {
    fail('SNAPSHOT_CORRUPT', 'committed snapshot projection cannot be authenticated');
  }
  return state;
}

function committedTurnPublication(database, {
  turn,
  member,
  contentCodec,
  narrativeContentCodec
}) {
  const commit = database.prepare(`
    SELECT tc.commit_id, tc.checkpoint_id, tc.after_state_revision,
           tc.committed_at, c.snapshot_ref
      FROM turn_commits AS tc
      JOIN room_checkpoints AS c
        ON c.checkpoint_id = tc.checkpoint_id AND c.turn_id = tc.turn_id
     WHERE tc.turn_id = ? AND tc.room_id = ? AND tc.epoch_id = ?
  `).get(turn.turn_id, turn.room_id, turn.epoch_id);
  if (!commit) {
    fail('TURN_COMMIT_CONSISTENCY_FAULT', 'COMMITTED turn has no atomic commit record', {
      turn_id: turn.turn_id
    });
  }
  const expectedAudience = turn.narrative_mode === 'shared' ? 'shared' : member.seat_id;
  const narrativeRow = database.prepare(`
    SELECT d.*, t.room_id, t.epoch_id
      FROM narrative_deliveries AS d
      JOIN multiplayer_turns AS t ON t.turn_id = d.turn_id
     WHERE d.turn_id = ? AND d.audience = ?
  `).get(turn.turn_id, expectedAudience);
  if (!narrativeRow) {
    fail('TURN_NARRATIVE_CONSISTENCY_FAULT', 'member narrative delivery is missing', {
      turn_id: turn.turn_id,
      audience: expectedAudience
    });
  }
  const narrative = openNarrativeDeliveryContent(narrativeContentCodec, narrativeRow);
  const snapshotRow = database.prepare(`
    SELECT * FROM room_snapshots
     WHERE room_id = ? AND epoch_id = ? AND checkpoint_id = ? AND snapshot_id = ?
  `).get(turn.room_id, turn.epoch_id, commit.checkpoint_id, commit.snapshot_ref);
  if (!snapshotRow) {
    fail('TURN_COMMIT_CONSISTENCY_FAULT', 'committed checkpoint snapshot is missing', {
      checkpoint_id: commit.checkpoint_id
    });
  }
  const state = openCommittedSnapshot(contentCodec, snapshotRow);
  const dailyEntries = state.shared_world?.continuity_ledger?.shinobi_daily;
  const turnDaily = Array.isArray(dailyEntries)
    ? dailyEntries.filter(item => item?.source_turn_id === turn.turn_id)
    : [];
  if (turnDaily.length !== 1) {
    fail('TURN_DAILY_CONSISTENCY_FAULT', 'committed turn must publish exactly one shinobi daily', {
      turn_id: turn.turn_id,
      count: turnDaily.length
    });
  }
  return {
    schema: COMMITTED_TURN_PUBLICATION_SCHEMA,
    checkpoint: {
      checkpoint_id: commit.checkpoint_id,
      commit_id: commit.commit_id,
      state_revision: commit.after_state_revision,
      created_at: commit.committed_at
    },
    state: projectMemberRoomState(state, member.seat_id),
    narratives: [narrative],
    shinobi_daily: turnDaily.map(item => ({
      daily_id: item.daily_id,
      source_turn_id: item.source_turn_id,
      daily: item.daily
    }))
  };
}

function actionReceipt(row) {
  return immutable({
    submission_id: row.submission_id,
    seat: row.seat_id,
    receipt_seq: row.receipt_seq,
    received_at: row.received_at,
    content_commitment: row.content_commitment,
    base_state_revision: row.base_state_revision
  });
}

function mapChatMessage(row) {
  return assertRoomChatMessage({
    schema: ROOM_CHAT_MESSAGE_SCHEMA,
    message_id: row.message_id,
    room_id: row.room_id,
    epoch_id: row.epoch_id,
    sender_seat: row.sender_seat_id,
    text: row.message_text,
    created_at: row.created_at,
    event_seq: row.event_seq
  });
}

/**
 * SQLite implementation of the core multiplayer persistence ports.
 *
 * Every mutation delegates to connection.write(), whose boundary is the
 * serialized BEGIN IMMEDIATE transaction from sqlite-connection.js. The
 * injected execution-plan resolver and content codec must be local,
 * synchronous operations; AI/network work is rejected from this boundary.
 */
export function createSqliteMultiplayerCoreRepositories(connectionValue, options = {}) {
  const connection = assertConnection(connectionValue);
  const contentCodec = assertActionContentCodec(options.actionContentCodec);
  const narrativeContentCodec = assertActionContentCodec(
    options.narrativeContentCodec ?? contentCodec
  );
  const includeCommittedPublications = options.includeCommittedPublications === true;
  const idFactory = typeof options.idFactory === 'function'
    ? options.idFactory
    : defaultIdFactory;
  const clock = typeof options.clock === 'function'
    ? options.clock
    : () => new Date().toISOString();
  const randomTokenBytes = typeof options.randomTokenBytes === 'function'
    ? options.randomTokenBytes
    : size => randomBytes(size);
  const executionPlanResolver = options.executionPlanResolver;
  const sealedTurnFinalizer = options.sealedTurnFinalizer;
  if (sealedTurnFinalizer !== undefined && typeof sealedTurnFinalizer !== 'function') {
    fail(
      'MULTIPLAYER_REPOSITORY_CONFIGURATION_INVALID',
      'sealedTurnFinalizer must be a synchronous function'
    );
  }
  const inputHashRulesVersion = options.inputHashRulesVersion
    ?? 'naruto.multiplayer-resolution-input/v1';
  const commitmentSecret = options.actionCommitmentSecret;
  if (!((typeof commitmentSecret === 'string' && Buffer.byteLength(commitmentSecret) > 0)
    || (commitmentSecret instanceof Uint8Array && commitmentSecret.byteLength > 0))) {
    fail(
      'MULTIPLAYER_REPOSITORY_CONFIGURATION_INVALID',
      'a non-empty server action commitment secret is required'
    );
  }
  const now = () => assertTimestamp(clock(), 'clock result');

  const rooms = {
    async createPendingGenesis({
      authenticated_user_id,
      origin: originValue,
      room_code = undefined,
      source_import_id = null,
      opening_drafts = null,
      narrative_mode = 'shared',
      issue_invite = true,
      invite_token = null
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const origin = assertRoomOrigin(originValue);
      const roomCode = normalizeRoomCode(room_code, origin.room_id);
      const existing = origin.origin_type === 'existing_save_derived';
      const sourceImportId = source_import_id === null
        ? null
        : assertIdentifier(source_import_id, 'source_import_id');
      if (existing && (
        origin.origin_owner_user_id !== authenticatedUserId
        || sourceImportId === null
        || origin.origin_snapshot_id !== sourceImportId
      )) {
        fail(
          'ROOM_GENESIS_INVALID',
          'pending genesis requires the authenticated owner staged source import',
          {},
          403
        );
      }
      if (!existing && (
        origin.origin_owner_user_id !== null
        || sourceImportId !== null
        || !opening_drafts
        || typeof opening_drafts !== 'object'
      )) {
        fail('ROOM_GENESIS_INVALID', 'new multiplayer lobby requires two opening drafts');
      }
      const normalizedOpenings = existing ? null : Object.freeze({
        A: normalizeOpeningDraft(opening_drafts.A),
        B: normalizeOpeningDraft(opening_drafts.B)
      });
      if (!NARRATIVE_MODES.includes(narrative_mode) || issue_invite !== true) {
        fail(
          'REPOSITORY_INPUT_INVALID',
          'pending genesis requires a narrative mode and one guest invite'
        );
      }
      const createdAt = now();
      const memberId = normalizeGeneratedId(idFactory, 'member');
      const inviteId = normalizeGeneratedId(idFactory, 'invite');
      const inviteToken = normalizeIssuedInviteToken(invite_token, randomTokenBytes);
      const inviteTokenHash = `sha256:${sha256Hex(inviteToken)}`;
      const inviteExpiresAt = ROOM_PASSWORD_COMPATIBILITY_EXPIRY;
      return connection.write(database => {
        if (existing) {
          const staged = database.prepare(`
            SELECT owner_user_id, import_status, expires_at
              FROM save_import_staging WHERE import_id = ?
          `).get(sourceImportId);
          if (!staged || staged.owner_user_id !== authenticatedUserId) {
            fail(
              'SAVE_IMPORT_NOT_FOUND',
              'staged save import does not belong to the room creator',
              {},
              404
            );
          }
          if (staged.import_status !== 'READY'
            || Date.parse(staged.expires_at) <= Date.parse(createdAt)) {
            fail('SAVE_IMPORT_NOT_READY', 'staged save import changed or expired', {}, 409);
          }
        }
        database.prepare(`
          INSERT INTO multiplayer_rooms (
            room_id, room_code, origin_type, lineage_id, origin_owner_user_id,
            origin_snapshot_id, lifecycle, host_user_id, active_epoch_id,
            current_turn_id, state_revision, control_revision, event_seq,
            active_narrative_mode, queued_narrative_mode, created_at,
            updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'LOBBY', ?, NULL,
            NULL, 0, 0, 0, ?, NULL, ?, ?, NULL)
        `).run(
          origin.room_id,
          roomCode,
          origin.origin_type,
          origin.lineage_id,
          origin.origin_owner_user_id,
          origin.origin_snapshot_id,
          authenticatedUserId,
          narrative_mode,
          createdAt,
          createdAt
        );
        if (normalizedOpenings) {
          const insertOpening = database.prepare(`
            INSERT INTO room_opening_drafts (
              room_id, seat_id, revision, draft_json, draft_commitment,
              confirmed_revision, confirmed_commitment, confirmed_at,
              created_at, updated_at
            ) VALUES (?, ?, 1, ?, ?, NULL, NULL, NULL, ?, ?)
          `);
          for (const seat of ROOM_SEATS) {
            const draft = normalizedOpenings[seat];
            insertOpening.run(
              origin.room_id,
              seat,
              canonicalStringify(draft),
              hashCanonical(draft),
              createdAt,
              createdAt
            );
          }
        }
        database.prepare(`
          INSERT INTO multiplayer_members (
            member_id, room_id, user_id, seat_id, member_status,
            joined_at, left_at
          ) VALUES (?, ?, ?, 'A', 'ACTIVE', ?, NULL)
        `).run(memberId, origin.room_id, authenticatedUserId, createdAt);
        database.prepare(`
          INSERT INTO room_invites (
            invite_id, room_id, token_hash, created_by_member_id,
            intended_seat_id, expires_at, max_uses, use_count, revoked,
            created_at
          ) VALUES (?, ?, ?, ?, 'B', ?, 1, 0, 0, ?)
        `).run(
          inviteId,
          origin.room_id,
          inviteTokenHash,
          memberId,
          inviteExpiresAt,
          createdAt
        );
        if (existing) {
          const consumed = database.prepare(`
            UPDATE save_import_staging
               SET import_status = 'CONSUMED', consumed_room_id = ?, consumed_at = ?
             WHERE import_id = ? AND owner_user_id = ? AND import_status = 'READY'
          `).run(origin.room_id, createdAt, sourceImportId, authenticatedUserId);
          if (consumed.changes !== 1) {
            fail('SAVE_IMPORT_NOT_READY', 'staged save import was consumed concurrently', {}, 409);
          }
        }
        const roomRevision = database.prepare(`
          UPDATE multiplayer_rooms
             SET event_seq = event_seq + 1, updated_at = ?
           WHERE room_id = ? AND active_epoch_id IS NULL
          RETURNING event_seq
        `).get(createdAt, origin.room_id);
        if (!roomRevision) fail('ROOM_GENESIS_CONFLICT', 'pending room creation CAS failed');
        insertProjectedEvents(database, {
          roomId: origin.room_id,
          epochId: null,
          endEventSeq: roomRevision.event_seq,
          createdAt,
          idFactory,
          events: [{
            audience: 'A',
            event_type: 'room.snapshot',
            payload: {
              room_id: origin.room_id,
              room_code: roomCode,
              viewer_seat: 'A',
              lifecycle: 'LOBBY',
              active_epoch_id: null,
              state_revision: 0,
              control_revision: 0,
              active_narrative_mode: narrative_mode,
              genesis_status: existing
                ? 'AWAITING_GUEST_CHARACTER'
                : 'AWAITING_OPENING_CONFIRMATION',
              opening: normalizedOpenings
                ? openingProjection(database, origin.room_id, 'A')
                : null
            }
          }]
        });
        return immutable({
          room: roomProjection(database, origin.room_id, 'A'),
          invite: {
            invite_id: inviteId,
            room_id: origin.room_id,
            room_code: roomCode,
            intended_seat: 'B',
            token: inviteToken
          }
        });
      });
    },

    async createWithGenesis({
      authenticated_user_id,
      origin: originValue,
      room_code = undefined,
      epoch: epochValue,
      genesis_checkpoint: checkpointValue,
      genesis_snapshot: snapshotValue = null,
      source_import_id = null,
      narrative_mode = 'shared',
      issue_invite = false,
      invite_token = null
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      if (typeof issue_invite !== 'boolean') {
        fail('REPOSITORY_INPUT_INVALID', 'issue_invite must be a boolean');
      }
      if (!NARRATIVE_MODES.includes(narrative_mode)) {
        fail('REPOSITORY_INPUT_INVALID', 'narrative_mode must be shared or dual_pov');
      }
      const origin = assertRoomOrigin(originValue);
      const roomCode = normalizeRoomCode(room_code, origin.room_id);
      const epoch = assertRoomEpoch(epochValue, { origin_type: origin.origin_type });
      const checkpoint = assertRoomCheckpoint(checkpointValue);
      const genesisSnapshot = normalizeGenesisSnapshot(snapshotValue);
      const sourceImportId = source_import_id === null
        ? null
        : assertIdentifier(source_import_id, 'source_import_id');
      if (origin.room_id !== epoch.room_id
        || origin.room_id !== checkpoint.room_id
        || origin.lineage_id !== epoch.lineage_id
        || origin.lineage_id !== checkpoint.lineage_id
        || epoch.epoch_id !== checkpoint.epoch_id
        || epoch.epoch_no !== 1
        || epoch.base.type !== 'origin_snapshot'
        || epoch.base.ref_id !== origin.origin_snapshot_id
        || epoch.genesis_checkpoint_id !== checkpoint.checkpoint_id
        || epoch.head_checkpoint_id !== checkpoint.checkpoint_id
        || epoch.state !== 'ACTIVE'
        || epoch.created_from_proposal_id !== null
        || checkpoint.kind !== 'genesis'
        || epoch.state_revision !== checkpoint.state_revision
        || epoch.base.state_hash !== checkpoint.state_hash) {
        fail(
          'ROOM_GENESIS_INVALID',
          'room origin, initial epoch and genesis checkpoint do not form one lineage'
        );
      }
      if (origin.origin_type === 'existing_save_derived'
        && origin.origin_owner_user_id !== authenticatedUserId) {
        fail('SOURCE_OWNER_REQUIRED', 'the authenticated source owner must create this room', {}, 403);
      }
      if ((origin.origin_type === 'existing_save_derived') !== (sourceImportId !== null)) {
        fail('ROOM_GENESIS_INVALID', 'existing-save rooms require one staged source import');
      }
      if (sourceImportId !== null && origin.origin_snapshot_id !== sourceImportId) {
        fail('ROOM_GENESIS_INVALID', 'room origin snapshot must reference the staged source import');
      }
      if (genesisSnapshot !== null
        && (genesisSnapshot.snapshot_id !== checkpoint.snapshot_ref
          || genesisSnapshot.state_hash !== checkpoint.state_hash)) {
        fail('ROOM_GENESIS_INVALID', 'genesis snapshot does not match its checkpoint');
      }
      const createdAt = now();
      if (epoch.activated_at !== checkpoint.created_at) {
        fail('ROOM_GENESIS_INVALID', 'epoch activation and genesis checkpoint timestamps must match');
      }
      const memberId = normalizeGeneratedId(idFactory, 'member');
      const inviteId = issue_invite ? normalizeGeneratedId(idFactory, 'invite') : null;
      const inviteToken = issue_invite
        ? normalizeIssuedInviteToken(invite_token, randomTokenBytes)
        : null;
      const inviteTokenHash = issue_invite
        ? `sha256:${sha256Hex(inviteToken)}`
        : null;
      const inviteExpiresAt = issue_invite ? ROOM_PASSWORD_COMPATIBILITY_EXPIRY : null;
      return connection.write(database => {
        database.prepare(`
          INSERT INTO multiplayer_rooms (
            room_id, room_code, origin_type, lineage_id, origin_owner_user_id,
            origin_snapshot_id, lifecycle, host_user_id, active_epoch_id,
            current_turn_id, state_revision, control_revision, event_seq,
            active_narrative_mode, queued_narrative_mode, created_at,
            updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'LOBBY', ?, NULL, NULL, ?, ?, 0,
            ?, NULL, ?, ?, NULL)
        `).run(
          origin.room_id,
          roomCode,
          origin.origin_type,
          origin.lineage_id,
          origin.origin_owner_user_id,
          origin.origin_snapshot_id,
          authenticatedUserId,
          epoch.state_revision,
          epoch.control_revision,
          narrative_mode,
          createdAt,
          createdAt
        );
        database.prepare(`
          INSERT INTO multiplayer_members (
            member_id, room_id, user_id, seat_id, member_status,
            joined_at, left_at
          ) VALUES (?, ?, ?, 'A', 'ACTIVE', ?, NULL)
        `).run(memberId, origin.room_id, authenticatedUserId, createdAt);
        if (issue_invite) {
          database.prepare(`
            INSERT INTO room_invites (
              invite_id, room_id, token_hash, created_by_member_id,
              intended_seat_id, expires_at, max_uses, use_count, revoked,
              created_at
            ) VALUES (?, ?, ?, ?, 'B', ?, 1, 0, 0, ?)
          `).run(
            inviteId,
            origin.room_id,
            inviteTokenHash,
            memberId,
            inviteExpiresAt,
            createdAt
          );
        }
        database.prepare(`
          INSERT INTO room_epochs (
            epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
            base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
            state_revision, control_revision, epoch_state,
            created_from_proposal_id, activated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, NULL)
        `).run(
          epoch.epoch_id,
          epoch.room_id,
          epoch.lineage_id,
          epoch.epoch_no,
          epoch.base.type,
          epoch.base.ref_id,
          epoch.base.state_hash,
          epoch.genesis_checkpoint_id,
          epoch.head_checkpoint_id,
          epoch.state_revision,
          epoch.control_revision,
          epoch.activated_at
        );
        database.prepare(`
          INSERT INTO room_checkpoints (
            checkpoint_id, room_id, lineage_id, epoch_id, turn_no,
            checkpoint_kind, parent_checkpoint_id, turn_id, commit_id,
            state_revision, state_hash, snapshot_ref, created_at
          ) VALUES (?, ?, ?, ?, 0, 'genesis', NULL, NULL, NULL, ?, ?, ?, ?)
        `).run(
          checkpoint.checkpoint_id,
          checkpoint.room_id,
          checkpoint.lineage_id,
          checkpoint.epoch_id,
          checkpoint.state_revision,
          checkpoint.state_hash,
          checkpoint.snapshot_ref,
          checkpoint.created_at
        );
        if (genesisSnapshot !== null) {
          database.prepare(`
            INSERT INTO room_snapshots (
              snapshot_id, room_id, epoch_id, checkpoint_id, state_revision,
              state_hash, snapshot_ciphertext, wrapped_data_key, nonce,
              auth_tag, master_key_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            genesisSnapshot.snapshot_id,
            origin.room_id,
            epoch.epoch_id,
            checkpoint.checkpoint_id,
            checkpoint.state_revision,
            genesisSnapshot.state_hash,
            genesisSnapshot.snapshot_ciphertext,
            genesisSnapshot.wrapped_data_key,
            genesisSnapshot.nonce,
            genesisSnapshot.auth_tag,
            genesisSnapshot.master_key_version,
            checkpoint.created_at
          );
        }
        if (sourceImportId !== null) {
          const staged = database.prepare(`
            SELECT owner_user_id, state_hash, import_status, expires_at
              FROM save_import_staging WHERE import_id = ?
          `).get(sourceImportId);
          if (!staged || staged.owner_user_id !== authenticatedUserId) {
            fail('SAVE_IMPORT_NOT_FOUND', 'staged save import does not belong to the room creator', {}, 404);
          }
          if (staged.import_status !== 'READY'
            || staged.state_hash !== checkpoint.state_hash
            || Date.parse(staged.expires_at) <= Date.parse(createdAt)) {
            fail('SAVE_IMPORT_NOT_READY', 'staged save import changed or expired', {}, 409);
          }
          const consumed = database.prepare(`
            UPDATE save_import_staging
               SET import_status = 'CONSUMED', consumed_room_id = ?, consumed_at = ?
             WHERE import_id = ? AND owner_user_id = ? AND import_status = 'READY'
          `).run(origin.room_id, createdAt, sourceImportId, authenticatedUserId);
          if (consumed.changes !== 1) {
            fail('SAVE_IMPORT_NOT_READY', 'staged save import was consumed concurrently', {}, 409);
          }
        }
        const room = database.prepare(`
          UPDATE multiplayer_rooms
             SET active_epoch_id = ?, event_seq = event_seq + 1, updated_at = ?
           WHERE room_id = ? AND active_epoch_id IS NULL
          RETURNING event_seq
        `).get(epoch.epoch_id, createdAt, origin.room_id);
        if (!room) fail('ROOM_GENESIS_CONFLICT', 'room genesis activation CAS failed');
        insertProjectedEvents(database, {
          roomId: origin.room_id,
          epochId: epoch.epoch_id,
          endEventSeq: room.event_seq,
          createdAt,
          idFactory,
          events: [{
            audience: 'A',
            event_type: 'room.snapshot',
            payload: {
              room_id: origin.room_id,
              room_code: roomCode,
              viewer_seat: 'A',
              lifecycle: 'LOBBY',
              active_epoch_id: epoch.epoch_id,
              state_revision: epoch.state_revision,
              control_revision: epoch.control_revision,
              active_narrative_mode: narrative_mode
            }
          }]
        });
        const projectedRoom = roomProjection(database, origin.room_id, 'A');
        if (!issue_invite) return projectedRoom;
        return immutable({
          room: projectedRoom,
          invite: {
            invite_id: inviteId,
            room_id: origin.room_id,
            room_code: roomCode,
            intended_seat: 'B',
            token: inviteToken
          }
        });
      });
    },

    async activatePendingGenesis({
      authenticated_user_id,
      room_id,
      epoch: epochValue,
      genesis_checkpoint: checkpointValue,
      genesis_snapshot: snapshotValue,
      expected_opening_commitments
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epoch = assertRoomEpoch(epochValue, { origin_type: 'new_multiplayer_save' });
      const checkpoint = assertRoomCheckpoint(checkpointValue);
      const snapshot = normalizeGenesisSnapshot(snapshotValue);
      if (!snapshot
        || !expected_opening_commitments
        || typeof expected_opening_commitments !== 'object') {
        fail('ROOM_GENESIS_INVALID', 'pending genesis activation is incomplete');
      }
      for (const seat of ROOM_SEATS) {
        if (typeof expected_opening_commitments[seat] !== 'string'
          || !/^sha256:[a-f0-9]{64}$/u.test(expected_opening_commitments[seat])) {
          fail('ROOM_GENESIS_INVALID', 'opening commitment is invalid', { seat });
        }
      }
      const activatedAt = now();
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        requireWritableRoom(member);
        const room = database.prepare(`
          SELECT room_id, origin_type, lineage_id, origin_snapshot_id,
                 active_epoch_id, state_revision, control_revision
            FROM multiplayer_rooms WHERE room_id = ?
        `).get(roomId);
        if (room.active_epoch_id !== null) {
          return immutable({
            room: roomProjection(database, roomId, member.seat_id),
            replayed: true
          });
        }
        const opening = openingProjection(database, roomId, member.seat_id);
        const memberRows = activeMemberRows(database, roomId);
        if (room.origin_type !== 'new_multiplayer_save'
          || memberRows.length !== 2
          || memberRows.some(row => row.ready_at === null)
          || !opening?.ready) {
          fail('ROOM_OPENING_NOT_READY', 'both players must confirm compatible openings', {}, 409);
        }
        for (const seat of ROOM_SEATS) {
          if (opening.drafts[seat].commitment !== expected_opening_commitments[seat]) {
            fail('ROOM_OPENING_CHANGED', 'an opening changed before genesis activation', {
              seat,
              expected: expected_opening_commitments[seat],
              actual: opening.drafts[seat].commitment
            }, 409);
          }
        }
        if (epoch.room_id !== roomId
          || checkpoint.room_id !== roomId
          || epoch.lineage_id !== room.lineage_id
          || checkpoint.lineage_id !== room.lineage_id
          || epoch.epoch_id !== checkpoint.epoch_id
          || epoch.epoch_no !== 1
          || epoch.base.type !== 'origin_snapshot'
          || epoch.base.ref_id !== room.origin_snapshot_id
          || epoch.genesis_checkpoint_id !== checkpoint.checkpoint_id
          || epoch.head_checkpoint_id !== checkpoint.checkpoint_id
          || epoch.state !== 'ACTIVE'
          || epoch.created_from_proposal_id !== null
          || epoch.state_revision !== room.state_revision
          || epoch.control_revision !== room.control_revision
          || checkpoint.kind !== 'genesis'
          || checkpoint.state_revision !== room.state_revision
          || epoch.base.state_hash !== checkpoint.state_hash
          || snapshot.snapshot_id !== checkpoint.snapshot_ref
          || snapshot.state_hash !== checkpoint.state_hash
          || epoch.activated_at !== checkpoint.created_at) {
          fail('ROOM_GENESIS_INVALID', 'pending genesis does not match the confirmed lobby');
        }
        database.prepare(`
          INSERT INTO room_epochs (
            epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
            base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
            state_revision, control_revision, epoch_state,
            created_from_proposal_id, activated_at, archived_at
          ) VALUES (?, ?, ?, 1, 'origin_snapshot', ?, ?, ?, ?, ?, ?,
            'ACTIVE', NULL, ?, NULL)
        `).run(
          epoch.epoch_id,
          roomId,
          room.lineage_id,
          epoch.base.ref_id,
          epoch.base.state_hash,
          epoch.genesis_checkpoint_id,
          epoch.head_checkpoint_id,
          epoch.state_revision,
          epoch.control_revision,
          epoch.activated_at
        );
        database.prepare(`
          INSERT INTO room_checkpoints (
            checkpoint_id, room_id, lineage_id, epoch_id, turn_no,
            checkpoint_kind, parent_checkpoint_id, turn_id, commit_id,
            state_revision, state_hash, snapshot_ref, created_at
          ) VALUES (?, ?, ?, ?, 0, 'genesis', NULL, NULL, NULL, ?, ?, ?, ?)
        `).run(
          checkpoint.checkpoint_id,
          roomId,
          room.lineage_id,
          epoch.epoch_id,
          checkpoint.state_revision,
          checkpoint.state_hash,
          checkpoint.snapshot_ref,
          checkpoint.created_at
        );
        database.prepare(`
          INSERT INTO room_snapshots (
            snapshot_id, room_id, epoch_id, checkpoint_id, state_revision,
            state_hash, snapshot_ciphertext, wrapped_data_key, nonce,
            auth_tag, master_key_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          snapshot.snapshot_id,
          roomId,
          epoch.epoch_id,
          checkpoint.checkpoint_id,
          checkpoint.state_revision,
          snapshot.state_hash,
          snapshot.snapshot_ciphertext,
          snapshot.wrapped_data_key,
          snapshot.nonce,
          snapshot.auth_tag,
          snapshot.master_key_version,
          checkpoint.created_at
        );
        const control = database.prepare(`
          UPDATE multiplayer_rooms
             SET active_epoch_id = ?, lifecycle = 'READY',
                 event_seq = event_seq + ?, updated_at = ?
           WHERE room_id = ? AND active_epoch_id IS NULL
             AND state_revision = ? AND control_revision = ?
          RETURNING event_seq
        `).get(
          epoch.epoch_id,
          memberRows.length,
          activatedAt,
          roomId,
          room.state_revision,
          room.control_revision
        );
        if (!control) fail('ROOM_GENESIS_CONFLICT', 'pending genesis activation CAS failed', {}, 409);
        insertProjectedEvents(database, {
          roomId,
          epochId: epoch.epoch_id,
          endEventSeq: control.event_seq,
          createdAt: activatedAt,
          idFactory,
          events: eventsForSeats(
            memberRows.map(row => row.seat_id),
            'room.opening_committed',
            viewerSeat => ({
              room_id: roomId,
              viewer_seat: viewerSeat,
              active_epoch_id: epoch.epoch_id,
              lifecycle: 'READY',
              opening: openingProjection(database, roomId, viewerSeat)
            })
          )
        });
        return immutable({
          room: roomProjection(database, roomId, member.seat_id),
          replayed: false
        });
      });
    },

    getForMember({ authenticated_user_id, room_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      return connection.read(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        return roomProjection(database, roomId, member.seat_id);
      });
    }
  };

  const openings = {
    getForGenesis({ authenticated_user_id, room_id }) {
      return connection.read(database => {
        const member = requireActiveMember(database, assertIdentifier(room_id, 'room_id'), assertPrincipal(authenticated_user_id));
        return openingProjection(database, room_id, member.seat_id, true);
      });
    },
    getForMember({ authenticated_user_id, room_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      return connection.read(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        const projection = openingProjection(database, roomId, member.seat_id);
        if (!projection) {
          fail('ROOM_OPENING_NOT_AVAILABLE', 'this room does not use editable openings', {}, 409);
        }
        return projection;
      });
    },

    async saveOwn({
      authenticated_user_id,
      room_id,
      expected_revision,
      draft: draftValue
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const expectedRevision = assertRevision(expected_revision, 'expected_revision', { min: 1 });
      const draft = normalizeOpeningDraft(draftValue);
      const commitment = hashCanonical(draft);
      const savedAt = now();
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        requireWritableRoom(member);
        const room = database.prepare(`
          SELECT origin_type, active_epoch_id, control_revision
            FROM multiplayer_rooms WHERE room_id = ?
        `).get(roomId);
        if (room.origin_type !== 'new_multiplayer_save' || room.active_epoch_id !== null) {
          fail('ROOM_OPENING_LOCKED', 'opening drafts can only change before a new room starts', {}, 409);
        }
        const current = database.prepare(`
          SELECT revision, draft_commitment
            FROM room_opening_drafts WHERE room_id = ? AND seat_id = ?
        `).get(roomId, member.seat_id);
        if (!current) fail('ROOM_OPENING_NOT_AVAILABLE', 'opening draft is missing', {}, 409);
        if (current.revision !== expectedRevision) {
          fail('STALE_OPENING_REVISION', 'opening draft changed', {
            expected: expectedRevision,
            actual: current.revision
          }, 409);
        }
        if (current.draft_commitment === commitment) {
          return immutable({
            room: roomProjection(database, roomId, member.seat_id),
            opening: openingProjection(database, roomId, member.seat_id),
            replayed: true
          });
        }
        if (member.control_revision !== room.control_revision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed', {
            expected: member.control_revision,
            actual: room.control_revision
          }, 409);
        }
        database.prepare(`
          UPDATE room_opening_drafts
             SET confirmed_revision = NULL, confirmed_commitment = NULL,
                 confirmed_at = NULL
           WHERE room_id = ?
        `).run(roomId);
        const updated = database.prepare(`
          UPDATE room_opening_drafts
             SET revision = revision + 1, draft_json = ?, draft_commitment = ?,
                 updated_at = ?
           WHERE room_id = ? AND seat_id = ? AND revision = ?
          RETURNING revision
        `).get(
          canonicalStringify(draft),
          commitment,
          savedAt,
          roomId,
          member.seat_id,
          expectedRevision
        );
        if (!updated) fail('STALE_OPENING_REVISION', 'opening draft save CAS failed', {}, 409);
        database.prepare(`
          UPDATE multiplayer_members SET ready_at = NULL WHERE room_id = ?
        `).run(roomId);
        const memberRows = activeMemberRows(database, roomId);
        const control = database.prepare(`
          UPDATE multiplayer_rooms
             SET lifecycle = 'LOBBY', control_revision = control_revision + 1,
                 event_seq = event_seq + ?, updated_at = ?
           WHERE room_id = ? AND active_epoch_id IS NULL AND control_revision = ?
          RETURNING control_revision, event_seq
        `).get(memberRows.length, savedAt, roomId, room.control_revision);
        if (!control) fail('STALE_CONTROL_REVISION', 'opening draft room CAS failed', {}, 409);
        insertProjectedEvents(database, {
          roomId,
          epochId: null,
          endEventSeq: control.event_seq,
          createdAt: savedAt,
          idFactory,
          events: eventsForSeats(
            memberRows.map(row => row.seat_id),
            'room.opening_changed',
            viewerSeat => ({
              room_id: roomId,
              viewer_seat: viewerSeat,
              changed_seat: member.seat_id,
              lifecycle: 'LOBBY',
              control_revision: control.control_revision,
              opening: openingProjection(database, roomId, viewerSeat)
            })
          )
        });
        return immutable({
          room: roomProjection(database, roomId, member.seat_id),
          opening: openingProjection(database, roomId, member.seat_id),
          replayed: false
        });
      });
    }
  };

  const members = {
    resolve({ authenticated_user_id, room_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      return connection.read(database => {
        const row = requireActiveMember(database, roomId, authenticatedUserId);
        return immutable({
          member_id: row.member_id,
          room_id: row.room_id,
          seat: row.seat_id,
          status: row.member_status
        });
      });
    },

    async markReady({
      authenticated_user_id,
      room_id,
      expected_control_revision,
      opening_revision = null,
      opening_commitment = null
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const readyAt = now();
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        requireWritableRoom(member);
        const opening = openingProjection(database, roomId, member.seat_id);
        const currentMember = database.prepare(`
          SELECT ready_at FROM multiplayer_members WHERE member_id = ?
        `).get(member.member_id);
        const beforeRows = activeMemberRows(database, roomId);
        if (currentMember.ready_at !== null) {
          return immutable({
            room: roomProjection(database, roomId, member.seat_id),
            all_ready: beforeRows.length === 2
              && beforeRows.every(row => row.ready_at !== null),
            replayed: true
          });
        }
        if (member.control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed', {
            expected: expectedControlRevision,
            actual: member.control_revision
          }, 409);
        }
        if (opening) {
          const own = opening.drafts?.[member.seat_id];
          if (opening.blocking) {
            fail('ROOM_OPENING_CONFLICT', 'opening conflicts must be resolved before confirmation', {
              conflicts: opening.conflicts
            }, 409);
          }
          if (!own
            || !Number.isSafeInteger(opening_revision)
            || opening_revision !== own.revision
            || typeof opening_commitment !== 'string'
            || opening_commitment !== own.commitment) {
            fail('ROOM_OPENING_CHANGED', 'confirm the latest saved opening revision', {
              expected_revision: own?.revision ?? null,
              actual_revision: opening_revision
            }, 409);
          }
          const confirmed = database.prepare(`
            UPDATE room_opening_drafts
               SET confirmed_revision = revision,
                   confirmed_commitment = draft_commitment,
                   confirmed_at = ?
             WHERE room_id = ? AND seat_id = ? AND revision = ?
               AND draft_commitment = ? AND confirmed_at IS NULL
          `).run(
            readyAt,
            roomId,
            member.seat_id,
            opening_revision,
            opening_commitment
          );
          if (confirmed.changes !== 1) {
            fail('ROOM_OPENING_CHANGED', 'opening confirmation CAS failed', {}, 409);
          }
        }
        const marked = database.prepare(`
          UPDATE multiplayer_members SET ready_at = ?
           WHERE member_id = ? AND member_status = 'ACTIVE' AND ready_at IS NULL
        `).run(readyAt, member.member_id);
        if (marked.changes !== 1) {
          fail('ROOM_READY_CAS_FAILED', 'member readiness changed concurrently', {}, 409);
        }
        const memberRows = activeMemberRows(database, roomId);
        const allReady = memberRows.length === 2
          && memberRows.every(row => row.ready_at !== null);
        const lifecycle = allReady ? 'READY' : member.lifecycle;
        const control = database.prepare(`
          UPDATE multiplayer_rooms
             SET lifecycle = ?, control_revision = control_revision + 1,
                 event_seq = event_seq + ?, updated_at = ?
           WHERE room_id = ? AND control_revision = ? AND lifecycle != 'ARCHIVED'
          RETURNING control_revision, event_seq, active_epoch_id
        `).get(
          lifecycle,
          memberRows.length,
          readyAt,
          roomId,
          expectedControlRevision
        );
        if (!control) fail('STALE_CONTROL_REVISION', 'room readiness CAS failed', {}, 409);
        updateEpochControl(database, control.active_epoch_id, control.control_revision);
        insertProjectedEvents(database, {
          roomId,
          epochId: control.active_epoch_id,
          endEventSeq: control.event_seq,
          createdAt: readyAt,
          idFactory,
          events: eventsForSeats(
            memberRows.map(row => row.seat_id),
            'member.presence_changed',
            viewerSeat => ({
              room_id: roomId,
              viewer_seat: viewerSeat,
              member_seat: member.seat_id,
              member_status: 'ACTIVE',
              ready: true,
              lifecycle,
              control_revision: control.control_revision,
              opening: opening ? openingProjection(database, roomId, viewerSeat) : null
            })
          )
        });
        return immutable({
          room: roomProjection(database, roomId, member.seat_id),
          opening: opening ? openingProjection(database, roomId, member.seat_id) : null,
          all_ready: allReady,
          replayed: false
        });
      });
    }
  };

  const invites = {
    async create({ authenticated_user_id, room_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const token = normalizeIssuedInviteToken(null, randomTokenBytes);
      const tokenHash = `sha256:${sha256Hex(token)}`;
      const inviteId = normalizeGeneratedId(idFactory, 'invite');
      const createdAt = now();
      const expiresAt = ROOM_PASSWORD_COMPATIBILITY_EXPIRY;
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        requireWritableRoom(member);
        // Original room seats are stable identities. A historical LEFT row is
        // still occupied for invitation purposes and cannot be replaced by a
        // different principal.
        const occupiedSeats = new Set(database.prepare(`
          SELECT seat_id FROM multiplayer_members WHERE room_id = ?
        `).all(roomId).map(row => row.seat_id));
        const intendedSeat = ROOM_SEATS.find(seat => !occupiedSeats.has(seat));
        if (!intendedSeat) fail('ROOM_FULL', 'both room seats are already occupied', {}, 409);
        database.prepare(`
          INSERT INTO room_invites (
            invite_id, room_id, token_hash, created_by_member_id,
            intended_seat_id, expires_at, max_uses, use_count, revoked,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?)
        `).run(
          inviteId,
          roomId,
          tokenHash,
          member.member_id,
          intendedSeat,
          expiresAt,
          createdAt
        );
        const control = database.prepare(`
          UPDATE multiplayer_rooms
             SET control_revision = control_revision + 1,
                 event_seq = event_seq + 1,
                 updated_at = ?
           WHERE room_id = ? AND lifecycle != 'ARCHIVED'
          RETURNING control_revision, event_seq, active_epoch_id
        `).get(createdAt, roomId);
        if (!control) fail('ROOM_ARCHIVED_READ_ONLY', 'an archived room is read-only');
        updateEpochControl(database, control.active_epoch_id, control.control_revision);
        insertProjectedEvents(database, {
          roomId,
          epochId: control.active_epoch_id,
          endEventSeq: control.event_seq,
          createdAt,
          idFactory,
          events: [{
            audience: member.seat_id,
            event_type: 'room.invite_created',
            payload: {
              invite_id: inviteId,
              room_code: member.room_code,
              intended_seat: intendedSeat,
              control_revision: control.control_revision
            }
          }]
        });
        return immutable({
          invite_id: inviteId,
          room_id: roomId,
          room_code: member.room_code,
          intended_seat: intendedSeat,
          token
        });
      });
    },

    async join({
      authenticated_user_id,
      room_id,
      token: tokenValue,
      pending_genesis = null
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const pendingGenesis = normalizePendingGenesis(pending_genesis);
      const expectedRoomId = assertIdentifier(room_id, 'room_id');
      const normalizedToken = normalizeInviteTokenForLookup(tokenValue);
      const tokenHash = `sha256:${sha256Hex(normalizedToken)}`;
      const joinedAt = now();
      return connection.write(database => {
        const invite = database.prepare(`
          SELECT i.*, r.room_code, r.lifecycle, r.active_epoch_id, r.origin_type,
                 r.lineage_id, r.origin_snapshot_id, r.state_revision,
                 r.control_revision
            FROM room_invites AS i
            JOIN multiplayer_rooms AS r ON r.room_id = i.room_id
           WHERE i.room_id = ? AND i.token_hash = ?
        `).get(expectedRoomId, tokenHash);
        if (!invite) fail('INVITE_TOKEN_INVALID', '房间号或房间密码不正确', {}, 404);
        const needsGenesis = invite.active_epoch_id === null;
        const needsImportedGenesis = needsGenesis
          && invite.origin_type === 'existing_save_derived';
        if (needsImportedGenesis && pendingGenesis === null) {
          fail(
            'GUEST_CHARACTER_IMPORT_REQUIRED',
            'existing-save lobby requires the guest character before join',
            {},
            409
          );
        }
        if (needsImportedGenesis && (
          pendingGenesis.epoch.room_id !== invite.room_id
          || pendingGenesis.epoch.lineage_id !== invite.lineage_id
          || pendingGenesis.source_import_id !== invite.origin_snapshot_id
          || pendingGenesis.epoch.state_revision !== invite.state_revision
          || pendingGenesis.epoch.control_revision !== invite.control_revision
        )) {
          fail('ROOM_GENESIS_INVALID', 'pending genesis does not match the invited lobby', {}, 409);
        }

        const existing = database.prepare(`
          SELECT member_id, seat_id, member_status
            FROM multiplayer_members
           WHERE room_id = ? AND user_id = ?
        `).get(invite.room_id, authenticatedUserId);
        if (existing) {
          if (existing.member_status === 'ACTIVE'
            && existing.seat_id === invite.intended_seat_id) {
            return immutable({
              room_id: invite.room_id,
              room_code: invite.room_code,
              viewer_seat: existing.seat_id,
              replayed: true
            });
          }
          fail('ROOM_MEMBER_ALREADY_EXISTS', 'the authenticated user already occupies another room seat', {}, 409);
        }
        if (!needsGenesis && pendingGenesis !== null) {
          fail('ROOM_GENESIS_ALREADY_ACTIVE', 'room genesis is already active', {}, 409);
        }
        if (invite.lifecycle === 'ARCHIVED') {
          fail('ROOM_ARCHIVED_READ_ONLY', 'an archived room cannot accept an invite', {}, 409);
        }
        if (invite.revoked === 1) {
          fail('INVITE_NOT_USABLE', '房间密码已被房主停用', {}, 409);
        }
        const occupied = database.prepare(`
          SELECT 1 AS present FROM multiplayer_members
           WHERE room_id = ? AND seat_id = ?
        `).get(invite.room_id, invite.intended_seat_id);
        if (occupied) fail('ROOM_SEAT_OCCUPIED', 'the invited room seat is already occupied', {}, 409);

        const memberId = normalizeGeneratedId(idFactory, 'member');
        database.prepare(`
          INSERT INTO multiplayer_members (
            member_id, room_id, user_id, seat_id, member_status,
            joined_at, left_at
          ) VALUES (?, ?, ?, ?, 'ACTIVE', ?, NULL)
        `).run(
          memberId,
          invite.room_id,
          authenticatedUserId,
          invite.intended_seat_id,
          joinedAt
        );
        if (needsImportedGenesis) {
          const staged = database.prepare(`
            SELECT state_hash, import_status, consumed_room_id
              FROM save_import_staging WHERE import_id = ?
          `).get(pendingGenesis.source_import_id);
          if (!staged
            || staged.import_status !== 'CONSUMED'
            || staged.consumed_room_id !== invite.room_id
            || staged.state_hash !== pendingGenesis.source_state_hash) {
            fail('SOURCE_IMPORT_CHANGED', 'consumed source basis changed before guest join', {}, 409);
          }
          const { epoch, checkpoint, snapshot } = pendingGenesis;
          database.prepare(`
            INSERT INTO room_epochs (
              epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
              base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
              state_revision, control_revision, epoch_state,
              created_from_proposal_id, activated_at, archived_at
            ) VALUES (?, ?, ?, 1, 'origin_snapshot', ?, ?, ?, ?, ?, ?,
              'ACTIVE', NULL, ?, NULL)
          `).run(
            epoch.epoch_id,
            epoch.room_id,
            epoch.lineage_id,
            epoch.base.ref_id,
            epoch.base.state_hash,
            epoch.genesis_checkpoint_id,
            epoch.head_checkpoint_id,
            epoch.state_revision,
            epoch.control_revision,
            epoch.activated_at
          );
          database.prepare(`
            INSERT INTO room_checkpoints (
              checkpoint_id, room_id, lineage_id, epoch_id, turn_no,
              checkpoint_kind, parent_checkpoint_id, turn_id, commit_id,
              state_revision, state_hash, snapshot_ref, created_at
            ) VALUES (?, ?, ?, ?, 0, 'genesis', NULL, NULL, NULL, ?, ?, ?, ?)
          `).run(
            checkpoint.checkpoint_id,
            checkpoint.room_id,
            checkpoint.lineage_id,
            checkpoint.epoch_id,
            checkpoint.state_revision,
            checkpoint.state_hash,
            checkpoint.snapshot_ref,
            checkpoint.created_at
          );
          database.prepare(`
            INSERT INTO room_snapshots (
              snapshot_id, room_id, epoch_id, checkpoint_id, state_revision,
              state_hash, snapshot_ciphertext, wrapped_data_key, nonce,
              auth_tag, master_key_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            snapshot.snapshot_id,
            invite.room_id,
            epoch.epoch_id,
            checkpoint.checkpoint_id,
            checkpoint.state_revision,
            snapshot.state_hash,
            snapshot.snapshot_ciphertext,
            snapshot.wrapped_data_key,
            snapshot.nonce,
            snapshot.auth_tag,
            snapshot.master_key_version,
            checkpoint.created_at
          );
        }

        const memberRows = activeMemberRows(database, invite.room_id);
        const lifecycle = memberRows.length === 2
          && invite.lifecycle === 'LOBBY'
          && (!needsGenesis || invite.origin_type === 'existing_save_derived')
          ? 'READY'
          : invite.lifecycle;
        const control = database.prepare(`
          UPDATE multiplayer_rooms
             SET lifecycle = ?,
                 active_epoch_id = CASE
                   WHEN active_epoch_id IS NULL THEN ?
                   ELSE active_epoch_id
                 END,
                 control_revision = control_revision + 1,
                 event_seq = event_seq + ?, updated_at = ?
           WHERE room_id = ? AND lifecycle != 'ARCHIVED'
          RETURNING control_revision, event_seq, active_epoch_id, lifecycle
        `).get(
          lifecycle,
          pendingGenesis?.epoch.epoch_id ?? invite.active_epoch_id,
          memberRows.length,
          joinedAt,
          invite.room_id
        );
        if (!control) fail('ROOM_ARCHIVED_READ_ONLY', 'room changed while consuming invite');
        updateEpochControl(database, control.active_epoch_id, control.control_revision);
        insertProjectedEvents(database, {
          roomId: invite.room_id,
          epochId: control.active_epoch_id,
          endEventSeq: control.event_seq,
          createdAt: joinedAt,
          idFactory,
          events: eventsForSeats(
            memberRows.map(row => row.seat_id),
            'member.presence_changed',
            viewerSeat => ({
              room_id: invite.room_id,
              viewer_seat: viewerSeat,
              member_seat: invite.intended_seat_id,
              member_status: 'ACTIVE',
              lifecycle: control.lifecycle,
              control_revision: control.control_revision,
              opening: invite.origin_type === 'new_multiplayer_save'
                ? openingProjection(database, invite.room_id, viewerSeat)
                : null
            })
          )
        });
        return immutable({
          room_id: invite.room_id,
          room_code: invite.room_code,
          viewer_seat: invite.intended_seat_id,
          replayed: false
        });
      });
    },

    async revoke({ authenticated_user_id, room_id, invite_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const inviteId = assertIdentifier(invite_id, 'invite_id');
      const revokedAt = now();
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        requireWritableRoom(member);
        const invite = database.prepare(`
          SELECT invite_id, revoked FROM room_invites
           WHERE invite_id = ? AND room_id = ?
        `).get(inviteId, roomId);
        if (!invite) fail('INVITE_NOT_FOUND', 'invite does not exist', {}, 404);
        if (invite.revoked === 1) {
          return immutable({ invite_id: inviteId, revoked: true, replayed: true });
        }
        database.prepare(`UPDATE room_invites SET revoked = 1 WHERE invite_id = ?`)
          .run(inviteId);
        const seats = activeMemberRows(database, roomId).map(row => row.seat_id);
        const control = database.prepare(`
          UPDATE multiplayer_rooms
             SET control_revision = control_revision + 1,
                 event_seq = event_seq + ?, updated_at = ?
           WHERE room_id = ? AND lifecycle != 'ARCHIVED'
          RETURNING control_revision, event_seq, active_epoch_id
        `).get(seats.length, revokedAt, roomId);
        if (!control) fail('ROOM_ARCHIVED_READ_ONLY', 'an archived room is read-only');
        updateEpochControl(database, control.active_epoch_id, control.control_revision);
        insertProjectedEvents(database, {
          roomId,
          epochId: control.active_epoch_id,
          endEventSeq: control.event_seq,
          createdAt: revokedAt,
          idFactory,
          events: eventsForSeats(seats, 'room.invite_revoked', viewerSeat => ({
            invite_id: inviteId,
            viewer_seat: viewerSeat,
            control_revision: control.control_revision
          }))
        });
        return immutable({ invite_id: inviteId, revoked: true, replayed: false });
      });
    }
  };

  const epochs = {
    getActive({ authenticated_user_id, room_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      return connection.read(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        if (!member.active_epoch_id) return null;
        const row = database.prepare(`SELECT * FROM room_epochs WHERE epoch_id = ? AND room_id = ?`)
          .get(member.active_epoch_id, roomId);
        if (!row) fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'active epoch is missing');
        return epochContract(row);
      });
    },

    getGenesis({ authenticated_user_id, room_id, epoch_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      return connection.read(database => {
        requireActiveMember(database, roomId, authenticatedUserId);
        const row = database.prepare(`
          SELECT c.*
            FROM room_epochs AS e
            JOIN room_checkpoints AS c
              ON c.checkpoint_id = e.genesis_checkpoint_id AND c.epoch_id = e.epoch_id
           WHERE e.room_id = ? AND e.epoch_id = ?
        `).get(roomId, epochId);
        if (!row) fail('CHECKPOINT_NOT_FOUND', 'genesis checkpoint does not exist', {}, 404);
        return checkpointContract(row);
      });
    }
  };

  const turns = {
    async changeNarrativePreset({ authenticated_user_id, room_id, request }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const expected = assertRevision(request.expected_control_revision, 'expected_control_revision');
      if (request.source_seat !== undefined && !ROOM_SEATS.includes(request.source_seat)) fail('NARRATIVE_PRESET_INVALID', '请选择玩家 A 或 B 的正文预设');
      const preset = request.preset === undefined ? null : normalizeNarrativePreset(request.preset);
      if (!preset && request.source_seat === undefined) fail('NARRATIVE_PRESET_INVALID', '请选择预设来源或同步本人预设');
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, userId);
        requireWritableRoom(member);
        if (member.control_revision !== expected) fail('STALE_CONTROL_REVISION', '房间设置已更新，请刷新后重试', {}, 409);
        const room = database.prepare('SELECT * FROM multiplayer_rooms WHERE room_id = ?').get(roomId);
        const presets = JSON.parse(room.narrative_presets_json);
        const source = request.source_seat ?? room.narrative_preset_seat;
        const previousHash = presets[source]?.hash;
        const changedAt = now();
        const presetHash = preset ? hashCanonical(preset) : null;
        const sameBinding = !preset || presets[member.seat_id]?.hash === presetHash;
        if (sameBinding && source === room.narrative_preset_seat) return { room: roomProjection(database, roomId, member.seat_id) };
        if (preset) presets[member.seat_id] = { ...preset, hash: presetHash, updated_at: changedAt };
        if (request.source_seat && !presets[source]) fail('NARRATIVE_PRESET_MISSING', `玩家 ${source} 尚未同步正文预设`, {}, 409);
        const seats = activeMemberRows(database, roomId).map(row => row.seat_id);
        const changed = database.prepare(`UPDATE multiplayer_rooms SET narrative_preset_seat = ?, narrative_presets_json = ?,
          control_revision = control_revision + 1, event_seq = event_seq + ?, updated_at = ?
          WHERE room_id = ? AND control_revision = ? RETURNING *`).get(source, canonicalStringify(presets), seats.length, changedAt, roomId, expected);
        if (!changed) fail('STALE_CONTROL_REVISION', '房间设置已更新', {}, 409);
        if (room.lifecycle === 'LOBBY' && (source !== room.narrative_preset_seat || previousHash !== presets[source]?.hash)) {
          database.prepare('UPDATE multiplayer_members SET ready_at = NULL WHERE room_id = ?').run(roomId);
          database.prepare('UPDATE room_opening_drafts SET confirmed_revision = NULL, confirmed_commitment = NULL, confirmed_at = NULL WHERE room_id = ?').run(roomId);
        }
        updateEpochControl(database, changed.active_epoch_id, changed.control_revision);
        insertProjectedEvents(database, { roomId, epochId: changed.active_epoch_id, turnId: changed.current_turn_id,
          endEventSeq: changed.event_seq, createdAt: changedAt, idFactory,
          events: eventsForSeats(seats, 'room.narrative_preset_changed', viewerSeat => ({
            viewer_seat: viewerSeat, control_revision: changed.control_revision, narrative_preset: narrativePresetSummary(changed)
          })) });
        return { room: roomProjection(database, roomId, member.seat_id) };
      });
    },
    async open({
      authenticated_user_id,
      room_id,
      expected_control_revision,
      turn_kind = 'ACTION'
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const turnKind = String(turn_kind);
      if (!['ACTION', 'OPENING'].includes(turnKind)) {
        fail('TURN_KIND_INVALID', 'turn_kind must be ACTION or OPENING');
      }
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const openedAt = now();
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        requireWritableRoom(member);
        if (member.control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed', {
            expected: expectedControlRevision,
            actual: member.control_revision
          }, 409);
        }
        const memberRows = activeMemberRows(database, roomId);
        if (memberRows.length !== 2) {
          fail('ROOM_NOT_READY', 'both active room members are required before opening a turn', {}, 409);
        }
        if (!member.active_epoch_id) fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'room has no active epoch');
        if (member.current_turn_id) {
          const current = database.prepare(`
            SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
          `).get(member.current_turn_id);
          if (current && !TERMINAL_TURN_STATUSES.has(current.turn_status)) {
            fail('ACTIVE_TURN_EXISTS', 'the room already has an unfinished turn', {}, 409);
          }
          if (current?.turn_status === 'CONSISTENCY_FAULT') {
            fail('ROOM_CONSISTENCY_FAULT', 'a consistency fault blocks new turns', {}, 409);
          }
        }
        const epoch = database.prepare(`
          SELECT * FROM room_epochs
           WHERE epoch_id = ? AND room_id = ? AND epoch_state = 'ACTIVE'
        `).get(member.active_epoch_id, roomId);
        if (!epoch) fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'active epoch is missing');
        const checkpoint = database.prepare(`
          SELECT * FROM room_checkpoints
           WHERE checkpoint_id = ? AND epoch_id = ?
        `).get(epoch.head_checkpoint_id, epoch.epoch_id);
        if (!checkpoint
          || checkpoint.state_revision !== member.state_revision
          || epoch.state_revision !== member.state_revision
          || checkpoint.state_hash !== epoch.base_state_hash && checkpoint.turn_no === 0) {
          fail('ROOM_CHECKPOINT_CONSISTENCY_FAULT', 'room head checkpoint is inconsistent');
        }
        const turnNo = database.prepare(`
          SELECT COALESCE(MAX(turn_no), 0) + 1 AS next_turn_no
            FROM multiplayer_turns WHERE epoch_id = ?
        `).get(epoch.epoch_id).next_turn_no;
        const turnId = normalizeGeneratedId(idFactory, 'turn');
        const narrativeMode = member.queued_narrative_mode ?? member.active_narrative_mode;
        if (turnKind === 'OPENING' && (
          member.origin_type !== 'new_multiplayer_save'
          || turnNo !== 1
          || checkpoint.checkpoint_kind !== 'genesis'
        )) {
          fail(
            'OPENING_TURN_INVALID',
            'an opening turn must be the pristine first turn of a new multiplayer save',
            {},
            409
          );
        }
        database.prepare(`
          INSERT INTO multiplayer_turns (
            turn_id, room_id, epoch_id, turn_no, turn_status, narrative_mode, turn_kind,
            base_checkpoint_id, base_state_revision, base_state_hash,
            execution_plan_json, execution_plan_hash, input_hash, sealed_at,
            committed_at, voided_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'AWAITING_PAYER_SELECTION', ?, ?, ?, ?, ?,
            NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          turnId,
          roomId,
          epoch.epoch_id,
          turnNo,
          narrativeMode,
          turnKind,
          checkpoint.checkpoint_id,
          member.state_revision,
          checkpoint.state_hash,
          openedAt,
          openedAt
        );
        const eventCount = memberRows.length * 2;
        const control = database.prepare(`
          UPDATE multiplayer_rooms
             SET lifecycle = 'ACTIVE', current_turn_id = ?,
                 active_narrative_mode = ?, queued_narrative_mode = NULL,
                 control_revision = control_revision + 1,
                 event_seq = event_seq + ?, updated_at = ?
           WHERE room_id = ? AND active_epoch_id = ?
             AND control_revision = ? AND lifecycle != 'ARCHIVED'
          RETURNING control_revision, event_seq
        `).get(
          turnId,
          narrativeMode,
          eventCount,
          openedAt,
          roomId,
          epoch.epoch_id,
          expectedControlRevision
        );
        if (!control) fail('STALE_CONTROL_REVISION', 'turn opening CAS failed', {}, 409);
        updateEpochControl(database, epoch.epoch_id, control.control_revision);
        const seats = memberRows.map(row => row.seat_id);
        const projectedEvents = [
          ...eventsForSeats(seats, 'turn.opened', viewerSeat => ({
            turn_id: turnId,
            turn_no: turnNo,
            turn_kind: turnKind,
            viewer_seat: viewerSeat,
            status: 'AWAITING_PAYER_SELECTION',
            narrative_mode: narrativeMode,
            base_state_revision: member.state_revision,
            control_revision: control.control_revision
          })),
          ...eventsForSeats(seats, 'billing.payer_selection_required', viewerSeat => ({
            turn_id: turnId,
            turn_no: turnNo,
            viewer_seat: viewerSeat,
            shared_stage_payer_selected: false,
            narrative_mode: narrativeMode
          }))
        ];
        insertProjectedEvents(database, {
          roomId,
          epochId: epoch.epoch_id,
          turnId,
          endEventSeq: control.event_seq,
          createdAt: openedAt,
          idFactory,
          events: projectedEvents
        });
        return immutable({
          turn_id: turnId,
          room_id: roomId,
          epoch_id: epoch.epoch_id,
          turn_no: turnNo,
          status: 'AWAITING_PAYER_SELECTION',
          turn_kind: turnKind,
          narrative_mode: narrativeMode,
          base_checkpoint_id: checkpoint.checkpoint_id,
          base_state_revision: member.state_revision,
          base_state_hash: checkpoint.state_hash,
          control_revision: control.control_revision
        });
      });
    },

    async changeNarrativeMode({ authenticated_user_id, room_id, request: requestValue }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const request = assertNarrativeModeChangeRequest(requestValue);
      const requestHash = hashCanonical(request);
      const changedAt = now();
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        const replay = database.prepare(`
          SELECT request_hash, requested_mode, result_disposition,
                 result_control_revision, result_changed
            FROM narrative_mode_change_requests
           WHERE room_id = ? AND member_id = ? AND idempotency_key = ?
        `).get(roomId, member.member_id, request.idempotency_key);
        if (replay) {
          if (replay.request_hash !== requestHash) {
            fail(
              'IDEMPOTENCY_CONFLICT',
              'narrative-mode key was reused with different parameters',
              {},
              409
            );
          }
          return modeChangeResult(replay, true);
        }
        requireWritableRoom(member);
        if (member.control_revision !== request.expected_control_revision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed', {
            expected: request.expected_control_revision,
            actual: member.control_revision
          }, 409);
        }
        let currentTurn = null;
        let actionCount = 0;
        if (member.current_turn_id) {
          currentTurn = database.prepare(`SELECT * FROM multiplayer_turns WHERE turn_id = ?`)
            .get(member.current_turn_id);
          if (currentTurn) {
            actionCount = database.prepare(`
              SELECT COUNT(*) AS count FROM action_submissions WHERE turn_id = ?
            `).get(currentTurn.turn_id).count;
          }
        }
        const canApplyCurrent = !currentTurn
          || actionCount === 0
          || TERMINAL_TURN_STATUSES.has(currentTurn.turn_status);
        const nextActiveMode = canApplyCurrent ? request.mode : member.active_narrative_mode;
        const nextQueuedMode = canApplyCurrent
          ? null
          : (request.mode === member.active_narrative_mode ? null : request.mode);
        const unchanged = nextActiveMode === member.active_narrative_mode
          && nextQueuedMode === member.queued_narrative_mode
          && (!currentTurn || !canApplyCurrent || currentTurn.narrative_mode === request.mode);
        const disposition = canApplyCurrent ? 'applied_current_turn' : 'queued_next_turn';
        if (unchanged) {
          const receipt = {
            result_disposition: disposition,
            requested_mode: request.mode,
            result_control_revision: member.control_revision,
            result_changed: 0
          };
          database.prepare(`
            INSERT INTO narrative_mode_change_requests (
              mode_change_id, room_id, member_id, idempotency_key, request_hash,
              expected_control_revision, requested_mode, result_disposition,
              result_control_revision, result_changed, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          `).run(
            normalizeGeneratedId(idFactory, 'mode_change'),
            roomId,
            member.member_id,
            request.idempotency_key,
            requestHash,
            request.expected_control_revision,
            request.mode,
            disposition,
            member.control_revision,
            changedAt
          );
          return modeChangeResult(receipt, false);
        }
        const seats = activeMemberRows(database, roomId).map(row => row.seat_id);
        const control = database.prepare(`
          UPDATE multiplayer_rooms
             SET active_narrative_mode = ?, queued_narrative_mode = ?,
                 control_revision = control_revision + 1,
                 event_seq = event_seq + ?, updated_at = ?
           WHERE room_id = ? AND control_revision = ? AND lifecycle != 'ARCHIVED'
          RETURNING control_revision, event_seq, active_epoch_id
        `).get(
          nextActiveMode,
          nextQueuedMode,
          seats.length,
          changedAt,
          roomId,
          request.expected_control_revision
        );
        if (!control) fail('STALE_CONTROL_REVISION', 'narrative mode CAS failed', {}, 409);
        if (currentTurn && canApplyCurrent && actionCount === 0) {
          const previousTurnMode = currentTurn.narrative_mode;
          const changed = database.prepare(`
            UPDATE multiplayer_turns
               SET narrative_mode = ?, updated_at = ?
             WHERE turn_id = ? AND NOT EXISTS (
               SELECT 1 FROM action_submissions WHERE turn_id = ?
             )
          `).run(request.mode, changedAt, currentTurn.turn_id, currentTurn.turn_id);
          if (changed.changes !== 1) {
            fail('NARRATIVE_MODE_CAS_FAILED', 'an action locked while changing narrative mode');
          }
          if (previousTurnMode === 'dual_pov' && request.mode === 'shared') {
            database.prepare(`
              UPDATE turn_model_selections
                 SET active = 0
               WHERE turn_id = ? AND active = 1
                 AND (
                   scope = 'writer'
                   OR (
                     scope = 'shared'
                     AND (
                       selected_narrative_mode IS NULL
                       OR selected_narrative_mode != 'shared'
                     )
                   )
                 )
            `).run(currentTurn.turn_id);
          }
          refreshZeroActionTurnSelectionStatus(
            database,
            currentTurn,
            request.mode,
            changedAt
          );
        }
        updateEpochControl(database, control.active_epoch_id, control.control_revision);
        const eventType = canApplyCurrent
          ? 'narrative_mode.changed'
          : 'narrative_mode.queued';
        insertProjectedEvents(database, {
          roomId,
          epochId: control.active_epoch_id,
          turnId: currentTurn?.turn_id ?? null,
          endEventSeq: control.event_seq,
          createdAt: changedAt,
          idFactory,
          events: eventsForSeats(seats, eventType, viewerSeat => ({
            viewer_seat: viewerSeat,
            changed_by_seat: member.seat_id,
            mode: request.mode,
            control_revision: control.control_revision
          }))
        });
        const receipt = {
          result_disposition: disposition,
          requested_mode: request.mode,
          result_control_revision: control.control_revision,
          result_changed: 1
        };
        database.prepare(`
          INSERT INTO narrative_mode_change_requests (
            mode_change_id, room_id, member_id, idempotency_key, request_hash,
            expected_control_revision, requested_mode, result_disposition,
            result_control_revision, result_changed, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          normalizeGeneratedId(idFactory, 'mode_change'),
          roomId,
          member.member_id,
          request.idempotency_key,
          requestHash,
          request.expected_control_revision,
          request.mode,
          disposition,
          control.control_revision,
          changedAt
        );
        return modeChangeResult(receipt, false);
      });
    },

    async lockAction({
      authenticated_user_id,
      room_id,
      epoch_id,
      turn_no,
      request: requestValue,
      submission_kind = 'PLAYER'
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const turnNo = assertRevision(turn_no, 'turn_no', { min: 1 });
      const submissionKind = String(submission_kind);
      if (!['PLAYER', 'SERVER_OPENING_ANCHOR'].includes(submissionKind)) {
        fail('ACTION_SUBMISSION_KIND_INVALID', 'submission_kind is invalid', {}, 500);
      }
      const request = assertActionRequest(requestValue);
      const incomingRequestHash = hashCanonical(request);
      const receivedAt = now();
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        requireWritableRoom(member);
        if (member.active_epoch_id !== epochId) {
          fail('STALE_ACTIVE_EPOCH', 'action targets a non-active room epoch', {}, 409);
        }
        const turn = database.prepare(`
          SELECT * FROM multiplayer_turns
           WHERE room_id = ? AND epoch_id = ? AND turn_no = ?
        `).get(roomId, epochId, turnNo);
        if (!turn || member.current_turn_id !== turn.turn_id) {
          fail('TURN_NOT_FOUND', 'active turn does not match the requested epoch/number', {}, 404);
        }
        if (turn.turn_kind === 'OPENING' && submissionKind !== 'SERVER_OPENING_ANCHOR') {
          fail(
            'OPENING_TURN_SERVER_CONTROLLED',
            'the opening turn is generated from confirmed setup and does not accept player actions',
            {},
            409
          );
        }
        if (turn.turn_kind !== 'OPENING' && submissionKind === 'SERVER_OPENING_ANCHOR') {
          fail('OPENING_TURN_INVALID', 'a server opening anchor can target only an opening turn', {}, 409);
        }
        const existing = database.prepare(`
          SELECT a.*, t.room_id, t.epoch_id
            FROM action_submissions AS a
            JOIN multiplayer_turns AS t ON t.turn_id = a.turn_id
           WHERE a.turn_id = ? AND a.seat_id = ?
        `).get(turn.turn_id, member.seat_id);
        if (existing) {
          if (existing.idempotency_key !== request.idempotency_key) {
            fail('ACTION_ALREADY_LOCKED', 'this member already locked an action', {
              turn_id: turn.turn_id
            }, 409);
          }
          const content = openActionContent(contentCodec, existing);
          if (content.request_hash !== incomingRequestHash) {
            fail(
              'IDEMPOTENCY_CONFLICT',
              'idempotency key was reused with different action content',
              { turn_id: turn.turn_id },
              409
            );
          }
          return immutable({
            receipt: actionReceipt(existing),
            replayed: true,
            turn_status: turn.turn_status,
            control_revision: member.control_revision
          });
        }
        if (!['COLLECTING_ACTIONS', 'ONE_ACTION_LOCKED'].includes(turn.turn_status)) {
          fail('INVALID_TURN_STATE', 'turn is not collecting actions', {
            turn_status: turn.turn_status
          }, 409);
        }
        if (request.base_state_revision !== turn.base_state_revision
          || request.base_state_revision !== member.state_revision) {
          fail('STALE_STATE_REVISION', 'action uses a stale state revision', {
            expected: turn.base_state_revision,
            actual: request.base_state_revision
          }, 409);
        }
        const actionRows = database.prepare(`
          SELECT seat_id, receipt_seq FROM action_submissions
           WHERE turn_id = ? ORDER BY receipt_seq
        `).all(turn.turn_id);
        if ((turn.turn_status === 'COLLECTING_ACTIONS' && actionRows.length !== 0)
          || (turn.turn_status === 'ONE_ACTION_LOCKED' && actionRows.length !== 1)) {
          fail('TURN_ACTION_CONSISTENCY_FAULT', 'turn status and locked action count disagree');
        }
        let executionPlanJson = turn.execution_plan_json;
        let executionPlanHash = turn.execution_plan_hash;
        if (actionRows.length === 0) {
          if (typeof executionPlanResolver !== 'function') {
            fail(
              'TURN_EXECUTION_PLAN_NOT_READY',
              'the first action cannot lock without a server execution-plan resolver',
              {},
              409
            );
          }
          const plan = assertSyncResult(executionPlanResolver({
            database,
            room: Object.freeze({
              room_id: roomId,
              epoch_id: epochId,
              state_revision: member.state_revision,
              control_revision: member.control_revision
            }),
            turn: Object.freeze({ ...turn }),
            member: Object.freeze({
              member_id: member.member_id,
              seat_id: member.seat_id,
              authenticated_user_id: authenticatedUserId
            })
          }), 'execution plan resolver');
          const normalizedPlan = assertTurnExecutionPlan(plan);
          if (normalizedPlan.narrative_mode !== turn.narrative_mode) {
            fail('EXECUTION_PLAN_MODE_MISMATCH', 'execution plan narrative mode is stale');
          }
          executionPlanJson = canonicalStringify(normalizedPlan);
          executionPlanHash = `sha256:${sha256Hex(executionPlanJson)}`;
        } else if (!executionPlanJson || !executionPlanHash) {
          fail('TURN_ACTION_CONSISTENCY_FAULT', 'first action did not freeze an execution plan');
        }

        const submissionId = normalizeGeneratedId(idFactory, 'action');
        const receiptSeq = actionRows.length + 1;
        const contentCommitment = `hmac-sha256:${hmacSha256(commitmentSecret, {
          schema: 'naruto.multiplayer-action-commitment/v1',
          room_id: roomId,
          epoch_id: epochId,
          turn_id: turn.turn_id,
          seat: member.seat_id,
          text: request.text
        })}`;
        const content = {
          schema: ACTION_CONTENT_SCHEMA,
          text: request.text,
          narration_note: Object.prototype.hasOwnProperty.call(request, 'narration_note')
            ? request.narration_note
            : null,
          request_hash: incomingRequestHash
        };
        const codecContext = actionCodecContext({
          room_id: roomId,
          epoch_id: epochId,
          turn_id: turn.turn_id,
          submission_id: submissionId,
          member_id: member.member_id,
          seat_id: member.seat_id
        });
        const sealed = validateSealedContent(assertSyncResult(
          contentCodec.sealJson(immutable(content), codecContext),
          'action content codec sealJson'
        ));
        const preRevealedAt = actionRows.length === 0
          && request.pre_resolution_visibility === 'open'
          ? receivedAt
          : null;
        database.prepare(`
          INSERT INTO action_submissions (
            submission_id, turn_id, member_id, seat_id, idempotency_key,
            action_ciphertext, wrapped_data_key, nonce, auth_tag,
            master_key_version, content_commitment,
            pre_resolution_visibility, narration_preference,
            base_state_revision, receipt_seq, received_at,
            opponent_pre_revealed_at, full_disclosed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          submissionId,
          turn.turn_id,
          member.member_id,
          member.seat_id,
          request.idempotency_key,
          sealed.action_ciphertext,
          sealed.wrapped_data_key,
          sealed.nonce,
          sealed.auth_tag,
          sealed.master_key_version,
          contentCommitment,
          request.pre_resolution_visibility,
          request.narration_preference,
          request.base_state_revision,
          receiptSeq,
          receivedAt,
          preRevealedAt
        );
        const nextStatus = actionRows.length === 0 ? 'ONE_ACTION_LOCKED' : 'SEALED';
        let inputHash = null;
        if (nextStatus === 'SEALED') {
          const sealedRows = database.prepare(`
            SELECT a.*, t.room_id, t.epoch_id
              FROM action_submissions AS a
              JOIN multiplayer_turns AS t ON t.turn_id = a.turn_id
             WHERE a.turn_id = ? ORDER BY a.seat_id
          `).all(turn.turn_id);
          if (sealedRows.length !== 2
            || sealedRows[0].seat_id !== 'A'
            || sealedRows[1].seat_id !== 'B') {
            fail('TURN_ACTION_CONSISTENCY_FAULT', 'sealed turn must contain exactly A and B actions');
          }
          const texts = Object.fromEntries(sealedRows.map(row => [
            row.seat_id,
            openActionContent(contentCodec, row).text
          ]));
          inputHash = `hmac-sha256:${hmacSha256(commitmentSecret, {
            schema: 'naruto.multiplayer-resolution-input-commitment/v1',
            rules_version: inputHashRulesVersion,
            room_id: roomId,
            epoch_id: epochId,
            turn_id: turn.turn_id,
            base_state_revision: turn.base_state_revision,
            base_state_hash: turn.base_state_hash,
            actions: { A: texts.A, B: texts.B }
          })}`;
        }
        const changedTurn = database.prepare(`
          UPDATE multiplayer_turns
             SET turn_status = ?, execution_plan_json = ?,
                 execution_plan_hash = ?, input_hash = COALESCE(?, input_hash),
                 sealed_at = ?, updated_at = ?, writer_preset_json = COALESCE(writer_preset_json, ?)
           WHERE turn_id = ? AND turn_status = ?
          RETURNING turn_status
        `).get(
          nextStatus,
          executionPlanJson,
          executionPlanHash,
          inputHash,
          nextStatus === 'SEALED' ? receivedAt : null,
          receivedAt,
          canonicalStringify(snapshotNarrativePreset(database.prepare('SELECT narrative_preset_seat, narrative_presets_json FROM multiplayer_rooms WHERE room_id = ?').get(roomId))),
          turn.turn_id,
          turn.turn_status
        );
        if (!changedTurn) fail('ACTION_LOCK_CAS_FAILED', 'turn changed while locking action', {}, 409);

        let sealedFinalization = null;
        let resultingTurnStatus = nextStatus;
        if (nextStatus === 'SEALED' && typeof sealedTurnFinalizer === 'function') {
          sealedFinalization = assertSyncResult(sealedTurnFinalizer({
            database,
            authenticated_user_id: authenticatedUserId,
            room_id: roomId,
            epoch_id: epochId,
            turn_id: turn.turn_id,
            input_hash: inputHash,
            created_at: receivedAt,
            turn: Object.freeze(database.prepare(`
              SELECT * FROM multiplayer_turns WHERE turn_id = ?
            `).get(turn.turn_id))
          }), 'sealed turn finalizer');
          if (!sealedFinalization
            || typeof sealedFinalization !== 'object'
            || !Array.isArray(sealedFinalization.events)
            || typeof sealedFinalization.turn_status !== 'string') {
            fail('SEALED_TURN_FINALIZER_INVALID', 'sealed turn finalizer returned an invalid result');
          }
          resultingTurnStatus = sealedFinalization.turn_status;
        }

        const receipt = actionReceipt({
          submission_id: submissionId,
          seat_id: member.seat_id,
          receipt_seq: receiptSeq,
          received_at: receivedAt,
          content_commitment: contentCommitment,
          base_state_revision: request.base_state_revision
        });
        const memberRows = activeMemberRows(database, roomId);
        if (memberRows.length !== 2) {
          fail('ROOM_NOT_READY', 'both room members are required to lock actions', {}, 409);
        }
        const projectedEvents = eventsForSeats(
          memberRows.map(row => row.seat_id),
          'action.locked',
          viewerSeat => viewerSeat === member.seat_id
            ? {
                turn_id: turn.turn_id,
                seat: member.seat_id,
                locked: true,
                receipt
              }
            : {
                turn_id: turn.turn_id,
                seat: member.seat_id,
                locked: true
              }
        );
        if (preRevealedAt !== null) {
          const opponentSeat = member.seat_id === 'A' ? 'B' : 'A';
          projectedEvents.push({
            audience: opponentSeat,
            event_type: 'action.revealed_pre_resolution',
            // The event grants access; it intentionally contains no text,
            // commitment, length, hash, receipt sequence or timestamp.
            payload: { submission_id: submissionId }
          });
        }
        if (nextStatus === 'SEALED') {
          projectedEvents.push(...eventsForSeats(
            memberRows.map(row => row.seat_id),
            'turn.sealed',
            viewerSeat => ({
              turn_id: turn.turn_id,
              turn_no: turn.turn_no,
              viewer_seat: viewerSeat,
              status: 'SEALED'
            })
          ));
          if (sealedFinalization !== null) {
            projectedEvents.push(...sealedFinalization.events);
          }
        }
        const control = database.prepare(`
          UPDATE multiplayer_rooms
             SET control_revision = control_revision + 1,
                 event_seq = event_seq + ?, updated_at = ?
           WHERE room_id = ? AND active_epoch_id = ? AND current_turn_id = ?
             AND control_revision = ? AND lifecycle != 'ARCHIVED'
          RETURNING control_revision, event_seq
        `).get(
          projectedEvents.length,
          receivedAt,
          roomId,
          epochId,
          turn.turn_id,
          member.control_revision
        );
        if (!control) fail('ACTION_LOCK_CAS_FAILED', 'room changed while locking action', {}, 409);
        updateEpochControl(database, epochId, control.control_revision);
        insertProjectedEvents(database, {
          roomId,
          epochId,
          turnId: turn.turn_id,
          endEventSeq: control.event_seq,
          createdAt: receivedAt,
          idFactory,
          events: projectedEvents
        });
        return immutable({
          receipt,
          replayed: false,
          turn_status: resultingTurnStatus,
          control_revision: control.control_revision,
          sealed_finalization: sealedFinalization === null
            ? null
            : immutable({
                plan_hash: sealedFinalization.plan?.plan_hash ?? null,
                plan_revision: sealedFinalization.plan?.plan_revision ?? null,
                run_id: sealedFinalization.run?.run_id ?? null
              })
        });
      });
    },

    getForMember({ authenticated_user_id, room_id, epoch_id, turn_no }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const turnNo = assertRevision(turn_no, 'turn_no', { min: 1 });
      return connection.read(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        const turn = database.prepare(`
          SELECT * FROM multiplayer_turns
           WHERE room_id = ? AND epoch_id = ? AND turn_no = ?
        `).get(roomId, epochId, turnNo);
        if (!turn) fail('TURN_NOT_FOUND', 'turn does not exist', {}, 404);
        const rows = database.prepare(`
          SELECT a.*, ? AS room_id, ? AS epoch_id
            FROM action_submissions AS a
           WHERE a.turn_id = ? ORDER BY a.receipt_seq
        `).all(roomId, epochId, turn.turn_id);
        if (turn.turn_status === 'COMMITTED'
          && (rows.length !== 2 || rows.some(row => row.full_disclosed_at === null))) {
          fail(
            'ACTION_DISCLOSURE_CONSISTENCY_FAULT',
            'COMMITTED turn is missing its atomic full-disclosure markers',
            { turn_id: turn.turn_id }
          );
        }
        const rowBySeat = new Map(rows.map(row => [row.seat_id, row]));
        const actions = {};
        for (const seat of ROOM_SEATS) {
          const row = rowBySeat.get(seat);
          if (!row) {
            actions[seat] = { seat, locked: false };
            continue;
          }
          const owner = seat === member.seat_id;
          const committed = turn.turn_status === 'COMMITTED';
          const preRevealed = !owner && row.opponent_pre_revealed_at !== null;
          if (!owner && !committed && !preRevealed) {
            actions[seat] = { seat, locked: true };
            continue;
          }
          const content = openActionContent(contentCodec, row);
          actions[seat] = {
            seat,
            locked: true,
            submission_id: row.submission_id,
            text: content.text,
            disclosure: owner
              ? 'owner'
              : (committed ? 'full_after_commit' : 'open_pre_resolution')
          };
          if (owner) actions[seat].receipt = actionReceipt(row);
        }
        const projection = {
          schema: ACTION_TURN_MEMBER_PROJECTION_SCHEMA,
          turn_id: turn.turn_id,
          turn_no: turn.turn_no,
          turn_kind: turn.turn_kind,
          viewer_seat: member.seat_id,
          status: turn.turn_status,
          active_narrative_mode: turn.narrative_mode,
          post_commit_disclosure: 'full_after_commit',
          actions
        };
        const generation = readTurnGenerationProgress(database, turn, member.seat_id);
        if (generation) projection.generation = generation;
        if (turn.turn_status === 'COMMITTED' && !includeCommittedPublications) {
          fail(
            'COMMITTED_PUBLICATION_DISABLED',
            'committed turn reads require member publication projection support'
          );
        }
        if (turn.turn_status === 'COMMITTED') {
          projection.commit = committedTurnPublication(database, {
            turn,
            member,
            contentCodec,
            narrativeContentCodec
          });
        }
        return assertActionTurnMemberProjection(projection);
      });
    }
  };

  const chat = {
    async append({ authenticated_user_id, room_id, request: requestValue }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const request = assertRoomChatMessageRequest(requestValue);
      const createdAt = now();
      return connection.write(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        const existing = database.prepare(`
          SELECT * FROM room_chat_messages
           WHERE room_id = ? AND sender_member_id = ? AND idempotency_key = ?
        `).get(roomId, member.member_id, request.idempotency_key);
        if (existing) {
          if (existing.message_text !== request.text) {
            fail(
              'IDEMPOTENCY_CONFLICT',
              'chat idempotency key was reused with different text',
              {},
              409
            );
          }
          return immutable({ message: mapChatMessage(existing), replayed: true });
        }
        requireWritableRoom(member);
        const messageId = normalizeGeneratedId(idFactory, 'message');
        const sequence = database.prepare(`
          UPDATE multiplayer_rooms
             SET event_seq = event_seq + 1, updated_at = ?
           WHERE room_id = ? AND lifecycle != 'ARCHIVED'
          RETURNING event_seq, active_epoch_id
        `).get(createdAt, roomId);
        if (!sequence) fail('ROOM_ARCHIVED_READ_ONLY', 'an archived room is read-only');
        const message = assertRoomChatMessage({
          schema: ROOM_CHAT_MESSAGE_SCHEMA,
          message_id: messageId,
          room_id: roomId,
          epoch_id: sequence.active_epoch_id,
          sender_seat: member.seat_id,
          text: request.text,
          created_at: createdAt,
          event_seq: sequence.event_seq
        });
        insertProjectedEvents(database, {
          roomId,
          epochId: sequence.active_epoch_id,
          endEventSeq: sequence.event_seq,
          createdAt,
          idFactory,
          events: [{
            audience: 'BOTH',
            event_type: 'chat.message_created',
            // Chat is identically visible to both members, so BOTH is itself
            // the final common projection rather than a full object to hide.
            payload: message
          }]
        });
        database.prepare(`
          INSERT INTO room_chat_messages (
            message_id, room_id, epoch_id, sender_member_id, sender_seat_id,
            idempotency_key, message_text, event_seq, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          message.message_id,
          roomId,
          message.epoch_id,
          member.member_id,
          member.seat_id,
          request.idempotency_key,
          message.text,
          message.event_seq,
          message.created_at
        );
        return immutable({ message, replayed: false });
      });
    },

    listHistory({ authenticated_user_id, room_id, before = null, limit = 50 }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      if (before !== null) assertIdentifier(before, 'before');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        fail('REPOSITORY_INPUT_INVALID', 'chat history limit must be between 1 and 100');
      }
      return connection.read(database => {
        requireActiveMember(database, roomId, authenticatedUserId);
        let beforeEventSeq = Number.MAX_SAFE_INTEGER;
        if (before !== null) {
          const anchor = database.prepare(`
            SELECT event_seq FROM room_chat_messages
             WHERE room_id = ? AND message_id = ?
          `).get(roomId, before);
          if (!anchor) fail('CHAT_CURSOR_NOT_FOUND', 'chat history cursor does not exist', {}, 404);
          beforeEventSeq = anchor.event_seq;
        }
        const rows = database.prepare(`
          SELECT * FROM room_chat_messages
           WHERE room_id = ? AND event_seq < ?
           ORDER BY event_seq DESC
           LIMIT ?
        `).all(roomId, beforeEventSeq, limit);
        const messages = rows.map(mapChatMessage);
        return immutable({
          messages,
          next_before: rows.length === limit ? rows[rows.length - 1].message_id : null
        });
      });
    }
  };

  const events = {
    listAfter({ authenticated_user_id, room_id, after_event_seq = 0, limit = 200 }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const afterEventSeq = assertRevision(after_event_seq, 'after_event_seq');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        fail('REPOSITORY_INPUT_INVALID', 'event page limit must be between 1 and 500');
      }
      return connection.read(database => {
        const member = requireActiveMember(database, roomId, authenticatedUserId);
        const rows = database.prepare(`
          SELECT event_id, room_id, event_seq, epoch_id, turn_id, event_type,
                 audience, projection_version, projected_payload_json,
                 payload_hash, created_at
            FROM room_events
           WHERE room_id = ? AND event_seq > ?
             AND audience IN (?, 'BOTH')
           ORDER BY event_seq
           LIMIT ?
        `).all(roomId, afterEventSeq, member.seat_id, limit);
        return Object.freeze(rows.map(row => Object.freeze({
          event_id: row.event_id,
          room_id: row.room_id,
          event_seq: row.event_seq,
          epoch_id: row.epoch_id,
          turn_id: row.turn_id,
          event_type: row.event_type,
          audience: row.audience,
          projection_version: row.projection_version,
          payload: parseProjectedJson(row.projected_payload_json, 'projected room event payload'),
          payload_hash: row.payload_hash,
          created_at: row.created_at
        })));
      });
    }
  };

  const outbox = {
    async claim({ dispatcher_owner_id, now: nowValue, expires_at, limit = 100 }) {
      const ownerId = assertIdentifier(dispatcher_owner_id, 'dispatcher_owner_id');
      const claimedAt = assertTimestamp(nowValue, 'now');
      const expiresAt = assertTimestamp(expires_at, 'expires_at');
      if (Date.parse(expiresAt) <= Date.parse(claimedAt)) {
        fail('OUTBOX_LEASE_INVALID', 'outbox lease expiry must be after claim time');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        fail('REPOSITORY_INPUT_INVALID', 'outbox claim limit must be between 1 and 500');
      }
      return connection.write(database => {
        const candidates = database.prepare(`
          SELECT o.outbox_id
            FROM room_outbox AS o
            JOIN room_events AS e ON e.event_id = o.event_id
           WHERE o.outbox_status = 'PENDING'
              OR (o.outbox_status = 'CLAIMED' AND o.lease_expires_at <= ?)
           ORDER BY e.room_id, e.event_seq
           LIMIT ?
        `).all(claimedAt, limit);
        const claimed = [];
        const update = database.prepare(`
          UPDATE room_outbox
             SET outbox_status = 'CLAIMED', dispatcher_owner_id = ?,
                 lease_fence = lease_fence + 1, lease_expires_at = ?,
                 claimed_at = ?, dispatched_at = NULL,
                 attempt_count = attempt_count + 1
           WHERE outbox_id = ?
             AND (outbox_status = 'PENDING'
               OR (outbox_status = 'CLAIMED' AND lease_expires_at <= ?))
          RETURNING outbox_id, room_id, event_id, lease_fence, attempt_count
        `);
        for (const candidate of candidates) {
          const row = update.get(
            ownerId,
            expiresAt,
            claimedAt,
            candidate.outbox_id,
            claimedAt
          );
          if (!row) continue;
          const event = database.prepare(`
            SELECT event_seq, epoch_id, turn_id, event_type, audience,
                   projection_version, projected_payload_json, payload_hash,
                   created_at
              FROM room_events WHERE event_id = ? AND room_id = ?
          `).get(row.event_id, row.room_id);
          claimed.push(Object.freeze({
            outbox_id: row.outbox_id,
            room_id: row.room_id,
            event_id: row.event_id,
            event_seq: event.event_seq,
            epoch_id: event.epoch_id,
            turn_id: event.turn_id,
            event_type: event.event_type,
            audience: event.audience,
            projection_version: event.projection_version,
            payload: parseProjectedJson(event.projected_payload_json, 'outbox event payload'),
            payload_hash: event.payload_hash,
            created_at: event.created_at,
            lease_fence: row.lease_fence,
            attempt_count: row.attempt_count,
            lease_expires_at: expiresAt
          }));
        }
        return Object.freeze(claimed);
      });
    },

    async markDispatched({
      outbox_id,
      dispatcher_owner_id,
      lease_fence,
      dispatched_at
    }) {
      const outboxId = assertIdentifier(outbox_id, 'outbox_id');
      const ownerId = assertIdentifier(dispatcher_owner_id, 'dispatcher_owner_id');
      const fence = assertRevision(lease_fence, 'lease_fence', { min: 1 });
      const dispatchedAt = assertTimestamp(dispatched_at, 'dispatched_at');
      return connection.write(database => {
        const row = database.prepare(`
          UPDATE room_outbox
             SET outbox_status = 'DISPATCHED', dispatched_at = ?
           WHERE outbox_id = ? AND outbox_status = 'CLAIMED'
             AND dispatcher_owner_id = ? AND lease_fence = ?
          RETURNING outbox_id, room_id, event_id, lease_fence,
                    attempt_count, dispatched_at
        `).get(dispatchedAt, outboxId, ownerId, fence);
        if (row) return immutable({ ...row, replayed: false });
        const existing = database.prepare(`
          SELECT outbox_id, room_id, event_id, lease_fence,
                 attempt_count, dispatched_at, dispatcher_owner_id,
                 outbox_status
            FROM room_outbox WHERE outbox_id = ?
        `).get(outboxId);
        if (existing?.outbox_status === 'DISPATCHED'
          && existing.dispatcher_owner_id === ownerId
          && existing.lease_fence === fence
          && existing.dispatched_at === dispatchedAt) {
          const { dispatcher_owner_id: ignoredOwner, outbox_status: ignoredStatus, ...result } = existing;
          return immutable({ ...result, replayed: true });
        }
        fail('STALE_OUTBOX_LEASE', 'outbox dispatch CAS was rejected', {}, 409);
      });
    },

    async release({ outbox_id, dispatcher_owner_id, lease_fence }) {
      const outboxId = assertIdentifier(outbox_id, 'outbox_id');
      const ownerId = assertIdentifier(dispatcher_owner_id, 'dispatcher_owner_id');
      const fence = assertRevision(lease_fence, 'lease_fence', { min: 1 });
      return connection.write(database => {
        const row = database.prepare(`
          UPDATE room_outbox
             SET outbox_status = 'PENDING', dispatcher_owner_id = NULL,
                 lease_expires_at = NULL, claimed_at = NULL,
                 dispatched_at = NULL
           WHERE outbox_id = ? AND outbox_status = 'CLAIMED'
             AND dispatcher_owner_id = ? AND lease_fence = ?
          RETURNING outbox_id, room_id, event_id, lease_fence, attempt_count
        `).get(outboxId, ownerId, fence);
        if (!row) fail('STALE_OUTBOX_LEASE', 'outbox release CAS was rejected', {}, 409);
        return immutable(row);
      });
    }
  };

  return assertMultiplayerCoreRepositoryBundle(Object.freeze({
    rooms: Object.freeze(rooms),
    openings: Object.freeze(openings),
    invites: Object.freeze(invites),
    members: Object.freeze(members),
    epochs: Object.freeze(epochs),
    turns: Object.freeze(turns),
    chat: Object.freeze(chat),
    events: Object.freeze(events),
    outbox: Object.freeze(outbox)
  }));
}

export {
  ACTION_CONTENT_SCHEMA,
  EVENT_PROJECTION_VERSION,
  normalizeOpeningDraft
};
