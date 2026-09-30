import { randomBytes, randomUUID } from 'node:crypto';

import {
  ROOM_CHECKPOINT_SCHEMA,
  ROOM_EPOCH_SCHEMA,
  ROOM_ORIGIN_SCHEMA
} from '../contracts/lineage-contracts.js';
import { canonicalStringify, hmacSha256, sha256Hex } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { ACTION_REQUEST_SCHEMA } from '../domain/action-turn.js';
import {
  createExistingSaveGenesisState,
  createNewMultiplayerGenesisState,
  selectSingleplayerGenesisSnapshot,
  stableRoomGenesisActorIds
} from './genesis-state.js';

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;
const NARRATIVE_MODES = new Set(['shared', 'dual_pov']);
const READABLE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const OPENING_ANCHOR_TEXT =
  '服务器开场锚点：本席位尚未提交玩家行动；请建立初始场景并把实质选择留给玩家。';

function fail(code, message, details = {}, status = 400) {
  throw new DomainError(code, message, details, { status });
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL_PATTERN.test(value)) {
    fail('ROOM_APPLICATION_REQUEST_INVALID', 'authenticated_user_id is invalid', {}, 401);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('ROOM_APPLICATION_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function exactRequest(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('ROOM_APPLICATION_REQUEST_INVALID', `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail('ROOM_APPLICATION_REQUEST_INVALID', `${label} contains an unknown field`, {
        field: key
      });
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail('ROOM_APPLICATION_REQUEST_INVALID', `${label} is missing ${key}`, { field: key });
    }
  }
  return value;
}

function generatedId(idFactory, kind) {
  return identifier(idFactory(kind), `${kind}_id`);
}

function readableCode(bytes, length) {
  return Array.from(bytes.subarray(0, length), value => (
    READABLE_CODE_ALPHABET[value & 31]
  )).join('');
}

function groupedCode(value) {
  return value.match(/.{1,4}/gu).join('-');
}

function defaultApplicationIdFactory(kind) {
  if (kind === 'room_code') {
    return `R-${groupedCode(readableCode(randomBytes(12), 12))}`;
  }
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

function optionalRoomCode(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    fail('ROOM_CODE_INVALID', '房间号必须是文本', { field: 'room_code' });
  }
  const roomCode = value.trim();
  return roomCode === '' ? null : roomCode.toUpperCase();
}

function normalizeRoomPassword(value, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    fail('INVITE_TOKEN_INVALID', '请输入房间密码', {}, 404);
  }
  if (typeof value !== 'string') {
    fail(
      optional ? 'INVITE_CODE_INVALID' : 'INVITE_TOKEN_INVALID',
      '房间密码必须是文本',
      { field: optional ? 'invite_code' : 'token' },
      optional ? 400 : 404
    );
  }
  const password = value.trim();
  if (password !== '') return password;
  if (optional) return null;
  fail('INVITE_TOKEN_INVALID', '请输入房间密码', { field: 'token' }, 404);
}

function roomLocator(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('ROOM_APPLICATION_REQUEST_INVALID', '请输入房间号', { field: 'room_id' });
  }
  return value.trim();
}

export function deterministicRoomActorBindingMaterial(secret, room, seat, actorId) {
  const digest = hmacSha256(secret, {
    schema: 'naruto.multiplayer-room-actor-binding-bootstrap/v1',
    room_id: room.room_id,
    lineage_id: room.lineage_id,
    genesis_checkpoint_id: room.genesis_checkpoint_id,
    seat,
    room_actor_id: actorId
  });
  return Object.freeze({
    binding_id: `binding_${digest.slice(0, 40)}`,
    room_actor_id: actorId,
    original_seat: seat,
    opaque_binding_token: `room-binding-${digest}`
  });
}

function requestHash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function defaultNewRoomOpeningDrafts(profile = {}) {
  const startTime = profile.start_time ?? { year: 48, month: 1, day: 1, phase: 'DAWN' };
  const draft = (seat, actor = {}) => ({
    start_time: startTime,
    display_name: actor.display_name ?? (seat === 'A' ? '玩家一' : '玩家二'),
    rank: actor.rank ?? '下忍',
    affiliation: actor.affiliation ?? '木叶隐村',
    background: actor.background ?? '一名刚刚踏上忍者道路的年轻忍者。',
    location: actor.location ?? '木叶隐村',
    goal: actor.goal ?? '在忍界中写下自己的故事',
    opening_hook: actor.opening_hook ?? '从一个看似平常的清晨开始。'
  });
  return Object.freeze({
    A: Object.freeze(draft('A', profile.actor_a)),
    B: Object.freeze(draft('B', profile.actor_b))
  });
}

/**
 * Application workflow for immutable save staging, room genesis, readiness,
 * original actor binding and starting the server-generated opening turn.
 */
export function createRoomApplicationService({
  connection,
  coreRepositories,
  lineageRepository,
  saveImportRepository,
  genesisImportReviewRepository,
  snapshotService,
  bindingTokenSecret,
  idFactory = defaultApplicationIdFactory,
  clock = () => new Date().toISOString()
}) {
  if (!connection || typeof connection.read !== 'function'
    || typeof coreRepositories?.rooms?.createWithGenesis !== 'function'
    || typeof coreRepositories?.rooms?.createPendingGenesis !== 'function'
    || typeof coreRepositories?.invites?.join !== 'function'
    || typeof coreRepositories?.members?.markReady !== 'function'
    || typeof coreRepositories?.turns?.open !== 'function'
    || typeof lineageRepository?.bindings?.createPair !== 'function'
    || typeof saveImportRepository?.create !== 'function'
    || typeof saveImportRepository?.prepareConsumedForRoom !== 'function'
    || typeof genesisImportReviewRepository?.ensure !== 'function'
    || typeof genesisImportReviewRepository?.getForMember !== 'function'
    || typeof genesisImportReviewRepository?.accept !== 'function'
    || typeof snapshotService?.seal !== 'function'
    || typeof snapshotService?.readInternal !== 'function'
    || typeof bindingTokenSecret !== 'string'
    || bindingTokenSecret.length < 1) {
    fail(
      'ROOM_APPLICATION_CONFIGURATION_INVALID',
      'room application service dependencies are incomplete',
      {},
      500
    );
  }

  function resolveRoomIdForMember(authenticatedUserId, locatorValue) {
    const locator = roomLocator(locatorValue);
    const normalizedCode = locator.toUpperCase();
    const match = connection.read(database => database.prepare(`
      SELECT r.room_id
        FROM multiplayer_rooms AS r
        JOIN multiplayer_members AS member ON member.room_id = r.room_id
       WHERE member.user_id = ? AND member.member_status = 'ACTIVE'
         AND (r.room_id = ? OR r.room_code = ? COLLATE NOCASE)
       ORDER BY CASE WHEN r.room_id = ? THEN 0 ELSE 1 END,
                CASE WHEN r.lifecycle = 'ARCHIVED' THEN 1 ELSE 0 END,
                r.updated_at DESC
       LIMIT 1
    `).get(authenticatedUserId, locator, normalizedCode, locator));
    if (!match) {
      fail('ROOM_MEMBERSHIP_REQUIRED', '你不是该房间的成员', {
        room_code: normalizedCode
      }, 403);
    }
    return match.room_id;
  }

  function roomBootstrapRecord(roomId) {
    return connection.read(database => {
      const room = database.prepare(`
        SELECT r.room_id, r.room_code, r.origin_type, r.lineage_id, r.origin_snapshot_id,
               r.host_user_id, r.lifecycle, r.state_revision,
               r.active_epoch_id, r.current_turn_id, r.control_revision,
               e.epoch_no, e.genesis_checkpoint_id
          FROM multiplayer_rooms AS r
          LEFT JOIN room_epochs AS e ON e.epoch_id = r.active_epoch_id
         WHERE r.room_id = ?
      `).get(roomId);
      if (!room) fail('ROOM_NOT_FOUND', 'room does not exist', {}, 404);
      const members = database.prepare(`
        SELECT user_id, seat_id, ready_at
          FROM multiplayer_members
         WHERE room_id = ? AND member_status = 'ACTIVE'
         ORDER BY seat_id
      `).all(roomId);
      return Object.freeze({ ...room, members: Object.freeze(members) });
    });
  }

  function roomForMember(authenticatedUserId, roomId) {
    const room = coreRepositories.rooms.getForMember({
      authenticated_user_id: authenticatedUserId,
      room_id: roomId
    });
    const genesisReview = room.origin_type === 'existing_save_derived'
      ? genesisImportReviewRepository.getForMember({
          authenticated_user_id: authenticatedUserId,
          room_id: roomId
        })
      : null;
    return Object.freeze({ ...room, genesis_review: genesisReview });
  }

  async function ensureInitialGenesisReview({
    authenticatedUserId,
    roomId,
    sourceImportId,
    guestCharacter = undefined
  }) {
    const prepared = saveImportRepository.prepareConsumedForRoom({
      room_id: roomId,
      import_id: sourceImportId
    });
    const snapshot = snapshotService.readInternal({ room_id: roomId });
    if (guestCharacter !== undefined) {
      const selected = selectSingleplayerGenesisSnapshot({
        source_timeline: prepared.source_timeline,
        source_branch_id: prepared.import.source_branch_id,
        source_node_id: prepared.import.source_node_id
      });
      const replayState = createExistingSaveGenesisState({
        source_state: selected.state,
        guest_character: guestCharacter,
        actor_ids: stableRoomGenesisActorIds(roomId)
      });
      if (snapshotService.stateHash(replayState) !== snapshot.state_hash) {
        fail(
          'SOURCE_IMPORT_CHANGED',
          'replayed guest character does not match the authoritative genesis',
          {},
          409
        );
      }
    }
    await genesisImportReviewRepository.ensure({
      authenticated_user_id: authenticatedUserId,
      room_id: roomId,
      source_import_id: sourceImportId,
      source_basis_hash: prepared.import.state_hash,
      genesis_state_hash: snapshot.state_hash,
      state: snapshot.state
    });
    return genesisImportReviewRepository.getForMember({
      authenticated_user_id: authenticatedUserId,
      room_id: roomId
    });
  }

  async function roomForMemberWithReviewRecovery(authenticatedUserId, roomId) {
    let room = roomForMember(authenticatedUserId, roomId);
    if (room.origin_type !== 'existing_save_derived'
      || room.active_epoch_id === null
      || room.genesis_review !== null) {
      return room;
    }
    const recoverable = connection.read(database => database.prepare(`
      SELECT origin_snapshot_id
        FROM multiplayer_rooms
       WHERE room_id = ? AND origin_type = 'existing_save_derived'
         AND active_epoch_id IS NOT NULL
         AND (SELECT COUNT(*) FROM multiplayer_members
               WHERE room_id = ? AND member_status = 'ACTIVE') = 2
    `).get(roomId, roomId));
    if (!recoverable) return room;
    await ensureInitialGenesisReview({
      authenticatedUserId,
      roomId,
      sourceImportId: recoverable.origin_snapshot_id
    });
    room = roomForMember(authenticatedUserId, roomId);
    return room;
  }

  async function finishReadyBootstrap(authenticatedUserId, roomId) {
    let room = roomBootstrapRecord(roomId);
    if (room.members.length !== 2 || room.members.some(member => member.ready_at === null)) {
      return Object.freeze({ bootstrapped: false, turn: null });
    }
    if (room.origin_type === 'existing_save_derived') {
      const review = genesisImportReviewRepository.getForMember({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId
      });
      if (!review || review.status !== 'ACCEPTED') {
        return Object.freeze({ bootstrapped: false, turn: null });
      }
    }

    if (room.origin_type === 'new_multiplayer_save' && room.active_epoch_id === null) {
      if (typeof coreRepositories?.openings?.getForMember !== 'function'
        || typeof coreRepositories?.rooms?.activatePendingGenesis !== 'function') {
        fail('ROOM_APPLICATION_CONFIGURATION_INVALID', 'new-room opening bootstrap is unavailable', {}, 500);
      }
      const opening = (coreRepositories.openings.getForGenesis ?? coreRepositories.openings.getForMember)({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId
      });
      if (!opening?.ready) {
        return Object.freeze({ bootstrapped: false, turn: null });
      }
      const epochId = generatedId(idFactory, 'epoch');
      const checkpointId = generatedId(idFactory, 'checkpoint');
      const snapshotId = room.origin_snapshot_id;
      const activatedAt = clock();
      if (typeof activatedAt !== 'string' || !Number.isFinite(Date.parse(activatedAt))) {
        fail('ROOM_APPLICATION_CLOCK_INVALID', 'clock must return an ISO timestamp', {}, 500);
      }
      const state = createNewMultiplayerGenesisState({
        opening_drafts: {
          A: opening.drafts.A.draft,
          B: opening.drafts.B.draft
        },
        actor_ids: stableRoomGenesisActorIds(roomId)
      });
      const stateHash = snapshotService.stateHash(state);
      const epoch = {
        schema: ROOM_EPOCH_SCHEMA,
        epoch_id: epochId,
        room_id: roomId,
        lineage_id: room.lineage_id,
        epoch_no: 1,
        base: {
          type: 'origin_snapshot',
          ref_id: snapshotId,
          state_hash: stateHash
        },
        genesis_checkpoint_id: checkpointId,
        head_checkpoint_id: checkpointId,
        state_revision: room.state_revision,
        control_revision: room.control_revision,
        state: 'ACTIVE',
        created_from_proposal_id: null,
        activated_at: activatedAt
      };
      const checkpoint = {
        schema: ROOM_CHECKPOINT_SCHEMA,
        checkpoint_id: checkpointId,
        room_id: roomId,
        lineage_id: room.lineage_id,
        epoch_id: epochId,
        turn_no: 0,
        kind: 'genesis',
        parent_checkpoint_id: null,
        turn_id: null,
        commit_id: null,
        state_revision: room.state_revision,
        state_hash: stateHash,
        snapshot_ref: snapshotId,
        created_at: activatedAt
      };
      const snapshot = snapshotService.seal({
        room_id: roomId,
        epoch_id: epochId,
        checkpoint_id: checkpointId,
        snapshot_id: snapshotId,
        state_revision: room.state_revision,
        state
      });
      await coreRepositories.rooms.activatePendingGenesis({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId,
        epoch,
        genesis_checkpoint: checkpoint,
        genesis_snapshot: snapshot,
        expected_opening_commitments: {
          A: opening.drafts.A.commitment,
          B: opening.drafts.B.commitment
        }
      });
      room = roomBootstrapRecord(roomId);
    }

    const snapshot = snapshotService.readInternal({ room_id: roomId });
    const bindings = ['A', 'B'].map(seat => {
      const actorId = snapshot.state.actors?.[seat]?.room_actor_id;
      identifier(actorId, `actors.${seat}.room_actor_id`);
      return deterministicRoomActorBindingMaterial(bindingTokenSecret, room, seat, actorId);
    });
    await lineageRepository.bindings.createPair({
      authenticated_user_id: room.host_user_id,
      room_id: roomId,
      actor_bindings: bindings
    });

    room = roomBootstrapRecord(roomId);
    if (room.current_turn_id !== null) {
      const turn = connection.read(database => database.prepare(`
        SELECT turn_id, epoch_id, turn_no, turn_status AS status, turn_kind,
               narrative_mode, base_state_revision
          FROM multiplayer_turns WHERE turn_id = ?
      `).get(room.current_turn_id));
      return Object.freeze({ bootstrapped: true, turn: Object.freeze(turn) });
    }
    const opened = await coreRepositories.turns.open({
      authenticated_user_id: authenticatedUserId,
      room_id: roomId,
      expected_control_revision: room.control_revision,
      turn_kind: room.origin_type === 'new_multiplayer_save' ? 'OPENING' : 'ACTION'
    });
    const turn = Object.freeze({
      turn_id: opened.turn_id,
      room_id: opened.room_id,
      epoch_id: opened.epoch_id,
      turn_no: opened.turn_no,
      status: opened.status,
      turn_kind: opened.turn_kind,
      narrative_mode: opened.narrative_mode,
      base_state_revision: opened.base_state_revision,
      control_revision: opened.control_revision
    });
    return Object.freeze({ bootstrapped: true, turn });
  }

  /**
   * Seal the server-authored anchors for a new-save opening turn through the
   * same encrypted action, billing-plan and resolution-run path used by
   * ordinary turns. The persisted turn_kind is the trust boundary: anchor
   * text alone can never turn a player action into trusted opening context.
   */
  async function startOpeningTurn(authenticatedUserId, roomId) {
    roomForMember(authenticatedUserId, roomId);
    const openingTurn = connection.read(database => {
      const row = database.prepare(`
        SELECT room.origin_type, room.current_turn_id,
               turn.turn_id, turn.epoch_id, turn.turn_no, turn.turn_kind,
               turn.turn_status, turn.base_state_revision
          FROM multiplayer_rooms AS room
          LEFT JOIN multiplayer_turns AS turn ON turn.turn_id = room.current_turn_id
         WHERE room.room_id = ?
      `).get(roomId);
      if (!row) fail('ROOM_NOT_FOUND', 'room does not exist', {}, 404);
      const members = database.prepare(`
        SELECT user_id, seat_id
          FROM multiplayer_members
         WHERE room_id = ? AND member_status = 'ACTIVE'
         ORDER BY seat_id
      `).all(roomId);
      return Object.freeze({ ...row, members: Object.freeze(members) });
    });
    if (openingTurn.origin_type !== 'new_multiplayer_save'
      || openingTurn.turn_kind !== 'OPENING'
      || openingTurn.turn_no !== 1) {
      return Object.freeze({ started: false, turn: null, plan_hash: null });
    }
    if (openingTurn.members.length !== 2
      || openingTurn.members[0].seat_id !== 'A'
      || openingTurn.members[1].seat_id !== 'B') {
      fail('ROOM_NOT_READY', 'both room members are required for automatic opening', {}, 409);
    }

    const receipts = [];
    for (const member of openingTurn.members) {
      const idempotencyKey = `server-opening-${sha256Hex({
        schema: 'naruto.multiplayer-opening-anchor-idempotency/v1',
        room_id: roomId,
        turn_id: openingTurn.turn_id,
        seat: member.seat_id
      }).slice(0, 48)}`;
      receipts.push(await coreRepositories.turns.lockAction({
        authenticated_user_id: member.user_id,
        room_id: roomId,
        epoch_id: openingTurn.epoch_id,
        turn_no: openingTurn.turn_no,
        submission_kind: 'SERVER_OPENING_ANCHOR',
        request: {
          schema: ACTION_REQUEST_SCHEMA,
          base_state_revision: openingTurn.base_state_revision,
          text: OPENING_ANCHOR_TEXT,
          pre_resolution_visibility: 'sealed',
          narration_preference: 'summarize_intent',
          idempotency_key: idempotencyKey
        }
      }));
    }
    const persisted = connection.read(database => {
      const turn = database.prepare(`
        SELECT turn_id, epoch_id, turn_no, turn_kind,
               turn_status AS status, base_state_revision
          FROM multiplayer_turns WHERE turn_id = ?
      `).get(openingTurn.turn_id);
      const plan = database.prepare(`
        SELECT plan_hash
          FROM turn_billing_plans
         WHERE turn_id = ?
         ORDER BY plan_revision DESC LIMIT 1
      `).get(openingTurn.turn_id);
      return Object.freeze({ turn: Object.freeze(turn), plan_hash: plan?.plan_hash ?? null });
    });
    return Object.freeze({
      started: true,
      replayed: receipts.every(receipt => receipt.replayed === true),
      receipts: Object.freeze(receipts),
      ...persisted
    });
  }

  const saveImports = Object.freeze({
    create(context) {
      const authenticatedUserId = principal(context?.authenticated_user_id);
      const request = exactRequest(
        context?.request,
        [
          'source_save_id',
          'client_save_instance_id',
          'source_branch_id',
          'source_node_id',
          'cloud_revision',
          'state',
          'source_timeline',
          'idempotency_key'
        ],
        [
          'source_save_id',
          'client_save_instance_id',
          'source_branch_id',
          'source_node_id',
          'state',
          'idempotency_key'
        ],
        'save import request'
      );
      const selected = selectSingleplayerGenesisSnapshot({
        source_timeline: request.source_timeline,
        source_branch_id: request.source_branch_id,
        source_node_id: request.source_node_id,
        state: request.state
      });
      return saveImportRepository.create({
        authenticated_user_id: authenticatedUserId,
        ...request,
        state: createExistingSaveGenesisState({ source_state: selected.state }),
        source_timeline: selected.timeline,
        cloud_revision: request.cloud_revision ?? null
      });
    }
  });

  const rooms = Object.freeze({
    async create(context) {
      const authenticatedUserId = principal(context?.authenticated_user_id);
      const input = context?.request;
      if (!input || !['existing_save_derived', 'new_multiplayer_save'].includes(input.origin_type)) {
        fail('ROOM_ORIGIN_TYPE_REQUIRED', 'origin_type must select one documented room origin');
      }
      const existing = input.origin_type === 'existing_save_derived';
      const request = exactRequest(
        input,
        existing
          ? [
              'origin_type',
              'source_import_id',
              'default_narrative_mode',
              'room_code',
              'invite_code'
            ]
          : [
              'origin_type',
              'new_world_profile',
              'default_narrative_mode',
              'room_code',
              'invite_code'
            ],
        existing
          ? ['origin_type', 'source_import_id']
          : ['origin_type', 'new_world_profile'],
        'room creation request'
      );
      const narrativeMode = request.default_narrative_mode ?? 'shared';
      if (!NARRATIVE_MODES.has(narrativeMode)) {
        fail('ROOM_APPLICATION_REQUEST_INVALID', 'default_narrative_mode is invalid');
      }
      const requestedRoomCode = optionalRoomCode(request.room_code);
      const inviteCode = normalizeRoomPassword(request.invite_code, { optional: true });
      const roomId = generatedId(idFactory, 'room');
      const roomCode = requestedRoomCode ?? optionalRoomCode(idFactory('room_code'));
      if (roomCode === null) {
        fail('ROOM_APPLICATION_CONFIGURATION_INVALID', 'room code generator returned an empty value', {}, 500);
      }
      const roomCodeTaken = connection.read(database => database.prepare(`
        SELECT 1 AS found
          FROM multiplayer_rooms
         WHERE room_code = ? COLLATE NOCASE AND lifecycle != 'ARCHIVED'
      `).get(roomCode));
      if (roomCodeTaken) {
        fail('ROOM_CODE_TAKEN', '这个房间号正在使用，请换一个', { room_code: roomCode }, 409);
      }
      const persistCreation = async operation => {
        try {
          return await operation();
        } catch (error) {
          if (error instanceof DomainError) throw error;
          if (connection.read(database => database.prepare(`
            SELECT 1 AS found
              FROM multiplayer_rooms
             WHERE room_code = ? COLLATE NOCASE AND lifecycle != 'ARCHIVED'
          `).get(roomCode))) {
            fail('ROOM_CODE_TAKEN', '这个房间号正在使用，请换一个', {
              room_code: roomCode
            }, 409);
          }
          throw error;
        }
      };
      const lineageId = generatedId(idFactory, 'lineage');
      const createdAt = clock();
      if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
        fail('ROOM_APPLICATION_CLOCK_INVALID', 'clock must return an ISO timestamp', {}, 500);
      }

      if (existing) {
        const sourceImportId = identifier(request.source_import_id, 'source_import_id');
        saveImportRepository.prepareForRoom({
          authenticated_user_id: authenticatedUserId,
          import_id: sourceImportId
        });
        const origin = {
          schema: ROOM_ORIGIN_SCHEMA,
          room_id: roomId,
          origin_type: request.origin_type,
          lineage_id: lineageId,
          origin_owner_user_id: authenticatedUserId,
          origin_snapshot_id: sourceImportId
        };
        const result = await persistCreation(() => coreRepositories.rooms.createPendingGenesis({
          authenticated_user_id: authenticatedUserId,
          origin,
          room_code: roomCode,
          source_import_id: sourceImportId,
          narrative_mode: narrativeMode,
          issue_invite: true,
          invite_token: inviteCode
        }));
        return Object.freeze({
          ...result,
          genesis: Object.freeze({
            status: 'AWAITING_GUEST_CHARACTER',
            codec: 'naruto.singleplayer-to-multiplayer-genesis/v1',
            request_hash: requestHash(request)
          })
        });
      }

      if (typeof coreRepositories?.rooms?.activatePendingGenesis === 'function'
        && typeof coreRepositories?.openings?.getForMember === 'function') {
        const snapshotId = generatedId(idFactory, 'snapshot');
        const origin = {
          schema: ROOM_ORIGIN_SCHEMA,
          room_id: roomId,
          origin_type: request.origin_type,
          lineage_id: lineageId,
          origin_owner_user_id: null,
          origin_snapshot_id: snapshotId
        };
        const result = await persistCreation(() => coreRepositories.rooms.createPendingGenesis({
          authenticated_user_id: authenticatedUserId,
          origin,
          room_code: roomCode,
          source_import_id: null,
          opening_drafts: defaultNewRoomOpeningDrafts(request.new_world_profile),
          narrative_mode: narrativeMode,
          issue_invite: true,
          invite_token: inviteCode
        }));
        return Object.freeze({
          ...result,
          genesis: Object.freeze({
            status: 'AWAITING_OPENING_CONFIRMATION',
            request_hash: requestHash(request)
          })
        });
      }

      const epochId = generatedId(idFactory, 'epoch');
      const checkpointId = generatedId(idFactory, 'checkpoint');
      const snapshotId = generatedId(idFactory, 'snapshot');
      const state = createNewMultiplayerGenesisState({
        new_world_profile: request.new_world_profile,
        actor_ids: stableRoomGenesisActorIds(roomId)
      });
      const stateHash = snapshotService.stateHash(state);
      const origin = {
        schema: ROOM_ORIGIN_SCHEMA,
        room_id: roomId,
        origin_type: request.origin_type,
        lineage_id: lineageId,
        origin_owner_user_id: null,
        origin_snapshot_id: snapshotId
      };
      const epoch = {
        schema: ROOM_EPOCH_SCHEMA,
        epoch_id: epochId,
        room_id: roomId,
        lineage_id: lineageId,
        epoch_no: 1,
        base: {
          type: 'origin_snapshot',
          ref_id: snapshotId,
          state_hash: stateHash
        },
        genesis_checkpoint_id: checkpointId,
        head_checkpoint_id: checkpointId,
        state_revision: 0,
        control_revision: 0,
        state: 'ACTIVE',
        created_from_proposal_id: null,
        activated_at: createdAt
      };
      const checkpoint = {
        schema: ROOM_CHECKPOINT_SCHEMA,
        checkpoint_id: checkpointId,
        room_id: roomId,
        lineage_id: lineageId,
        epoch_id: epochId,
        turn_no: 0,
        kind: 'genesis',
        parent_checkpoint_id: null,
        turn_id: null,
        commit_id: null,
        state_revision: 0,
        state_hash: stateHash,
        snapshot_ref: snapshotId,
        created_at: createdAt
      };
      const snapshot = snapshotService.seal({
        room_id: roomId,
        epoch_id: epochId,
        checkpoint_id: checkpointId,
        snapshot_id: snapshotId,
        state_revision: 0,
        state
      });
      const result = await persistCreation(() => coreRepositories.rooms.createWithGenesis({
        authenticated_user_id: authenticatedUserId,
        origin,
        room_code: roomCode,
        epoch,
        genesis_checkpoint: checkpoint,
        genesis_snapshot: snapshot,
        source_import_id: null,
        narrative_mode: narrativeMode,
        issue_invite: true,
        invite_token: inviteCode
      }));
      return Object.freeze({
        ...result,
        genesis: Object.freeze({
          checkpoint_id: checkpointId,
          state_revision: 0,
          state_hash: stateHash,
          request_hash: requestHash(request)
        })
      });
    },

    async join(context) {
      const authenticatedUserId = principal(context?.authenticated_user_id);
      const locator = roomLocator(context?.room_id);
      const request = exactRequest(
        context?.request,
        ['token', 'guest_character'],
        ['token'],
        'room join request'
      );
      const inviteToken = normalizeRoomPassword(request.token);
      const normalizedRoomCode = locator.toUpperCase();
      const invite = connection.read(database => database.prepare(`
        SELECT r.room_id, r.room_code, r.origin_type, r.lineage_id, r.origin_snapshot_id,
               r.active_epoch_id, r.state_revision, r.control_revision
          FROM room_invites AS i
          JOIN multiplayer_rooms AS r ON r.room_id = i.room_id
         WHERE i.token_hash = ? AND r.lifecycle != 'ARCHIVED'
           AND (r.room_id = ? OR r.room_code = ? COLLATE NOCASE)
         ORDER BY CASE WHEN r.room_code = ? COLLATE NOCASE THEN 0 ELSE 1 END
         LIMIT 1
      `).get(
        `sha256:${sha256Hex(inviteToken)}`,
        locator,
        normalizedRoomCode,
        normalizedRoomCode
      ));
      if (!invite) fail('INVITE_TOKEN_INVALID', '房间号或房间密码不正确', {}, 404);
      const roomId = invite.room_id;

      if (invite.active_epoch_id !== null) {
        if (request.guest_character !== undefined && invite.origin_type !== 'existing_save_derived') {
          fail(
            'ROOM_APPLICATION_REQUEST_INVALID',
            'new multiplayer rooms do not accept a guest character import'
          );
        }
        const joined = await coreRepositories.invites.join({
          authenticated_user_id: authenticatedUserId,
          room_id: roomId,
          token: inviteToken
        });
        const genesisReview = invite.origin_type === 'existing_save_derived'
          ? await ensureInitialGenesisReview({
              authenticatedUserId,
              roomId,
              sourceImportId: invite.origin_snapshot_id,
              guestCharacter: request.guest_character
            })
          : null;
        return Object.freeze({
          ...joined,
          room: roomForMember(authenticatedUserId, roomId),
          genesis_review: genesisReview
        });
      }

      if (invite.origin_type === 'new_multiplayer_save') {
        if (request.guest_character !== undefined) {
          fail(
            'ROOM_APPLICATION_REQUEST_INVALID',
            'new multiplayer rooms use the editable seat opening instead of guest_character'
          );
        }
        const joined = await coreRepositories.invites.join({
          authenticated_user_id: authenticatedUserId,
          room_id: roomId,
          token: inviteToken
        });
        return Object.freeze({
          ...joined,
          room: roomForMember(authenticatedUserId, roomId),
          genesis: Object.freeze({ status: 'AWAITING_OPENING_CONFIRMATION' })
        });
      }

      if (invite.origin_type !== 'existing_save_derived') {
        fail('ROOM_GENESIS_CONSISTENCY_FAULT', 'only an existing-save lobby may await genesis', {}, 500);
      }
      if (!Object.prototype.hasOwnProperty.call(request, 'guest_character')) {
        fail(
          'GUEST_CHARACTER_IMPORT_REQUIRED',
          'guest_character is required when joining an existing-save lobby',
          {},
          409
        );
      }
      const prepared = saveImportRepository.prepareConsumedForRoom({
        room_id: roomId,
        import_id: invite.origin_snapshot_id
      });
      const selected = selectSingleplayerGenesisSnapshot({
        source_timeline: prepared.source_timeline,
        source_branch_id: prepared.import.source_branch_id,
        source_node_id: prepared.import.source_node_id
      });
      const state = createExistingSaveGenesisState({
        source_state: selected.state,
        guest_character: request.guest_character,
        actor_ids: stableRoomGenesisActorIds(roomId)
      });
      const epochId = generatedId(idFactory, 'epoch');
      const checkpointId = generatedId(idFactory, 'checkpoint');
      const snapshotId = generatedId(idFactory, 'snapshot');
      const createdAt = clock();
      if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
        fail('ROOM_APPLICATION_CLOCK_INVALID', 'clock must return an ISO timestamp', {}, 500);
      }
      const stateHash = snapshotService.stateHash(state);
      const epoch = {
        schema: ROOM_EPOCH_SCHEMA,
        epoch_id: epochId,
        room_id: roomId,
        lineage_id: invite.lineage_id,
        epoch_no: 1,
        base: {
          type: 'origin_snapshot',
          ref_id: invite.origin_snapshot_id,
          state_hash: stateHash
        },
        genesis_checkpoint_id: checkpointId,
        head_checkpoint_id: checkpointId,
        state_revision: invite.state_revision,
        control_revision: invite.control_revision,
        state: 'ACTIVE',
        created_from_proposal_id: null,
        activated_at: createdAt
      };
      const checkpoint = {
        schema: ROOM_CHECKPOINT_SCHEMA,
        checkpoint_id: checkpointId,
        room_id: roomId,
        lineage_id: invite.lineage_id,
        epoch_id: epochId,
        turn_no: 0,
        kind: 'genesis',
        parent_checkpoint_id: null,
        turn_id: null,
        commit_id: null,
        state_revision: invite.state_revision,
        state_hash: stateHash,
        snapshot_ref: snapshotId,
        created_at: createdAt
      };
      const snapshot = snapshotService.seal({
        room_id: roomId,
        epoch_id: epochId,
        checkpoint_id: checkpointId,
        snapshot_id: snapshotId,
        state_revision: invite.state_revision,
        state
      });
      const joined = await coreRepositories.invites.join({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId,
        token: inviteToken,
        pending_genesis: {
          epoch,
          genesis_checkpoint: checkpoint,
          genesis_snapshot: snapshot,
          source_import_id: invite.origin_snapshot_id,
          source_state_hash: prepared.import.state_hash
        }
      });
      const genesisReview = await ensureInitialGenesisReview({
        authenticatedUserId,
        roomId,
        sourceImportId: invite.origin_snapshot_id,
        guestCharacter: request.guest_character
      });
      return Object.freeze({
        ...joined,
        room: roomForMember(authenticatedUserId, roomId),
        genesis_review: genesisReview,
        genesis: Object.freeze({
          status: 'AWAITING_IMPORT_DIFF_CONFIRMATION',
          checkpoint_id: checkpointId,
          codec: 'naruto.singleplayer-to-multiplayer-genesis/v1'
        })
      });
    },

    async get(context) {
      const authenticatedUserId = principal(context?.authenticated_user_id);
      const roomId = resolveRoomIdForMember(authenticatedUserId, context?.room_id);
      return roomForMemberWithReviewRecovery(authenticatedUserId, roomId);
    },

    async ready(context) {
      const authenticatedUserId = principal(context?.authenticated_user_id);
      const roomId = identifier(context?.room_id, 'room_id');
      const roomBefore = await roomForMemberWithReviewRecovery(authenticatedUserId, roomId);
      const existing = roomBefore.origin_type === 'existing_save_derived';
      const editableOpening = !existing && roomBefore.opening !== null
        && roomBefore.opening !== undefined;
      const request = exactRequest(
        context?.request,
        existing
          ? [
              'expected_control_revision',
              'proposal_revision',
              'audience_diff_commitment'
            ]
          : (editableOpening
              ? ['expected_control_revision', 'opening_revision', 'opening_commitment']
              : ['expected_control_revision']),
        existing
          ? [
              'expected_control_revision',
              'proposal_revision',
              'audience_diff_commitment'
            ]
          : (editableOpening
              ? ['expected_control_revision', 'opening_revision', 'opening_commitment']
              : ['expected_control_revision']),
        'room ready request'
      );
      if (!Number.isSafeInteger(request.expected_control_revision)
        || request.expected_control_revision < 0) {
        fail('ROOM_APPLICATION_REQUEST_INVALID', 'expected_control_revision is invalid');
      }
      if (existing) {
        await genesisImportReviewRepository.accept({
          authenticated_user_id: authenticatedUserId,
          room_id: roomId,
          proposal_revision: request.proposal_revision,
          audience_diff_commitment: request.audience_diff_commitment
        });
      }
      const readiness = await coreRepositories.members.markReady({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId,
        expected_control_revision: request.expected_control_revision,
        ...(editableOpening
          ? {
              opening_revision: request.opening_revision,
              opening_commitment: request.opening_commitment
            }
          : {})
      });
      const bootstrap = readiness.all_ready
        ? await finishReadyBootstrap(authenticatedUserId, roomId)
        : Object.freeze({ bootstrapped: false, turn: null });
      const room = roomForMember(authenticatedUserId, roomId);
      return Object.freeze({
        room,
        opening: room.opening ?? null,
        genesis_review: room.genesis_review,
        all_ready: readiness.all_ready,
        turn: bootstrap.turn,
        replayed: readiness.replayed
      });
    },

    startOpening(context) {
      const authenticatedUserId = principal(context?.authenticated_user_id);
      const roomId = identifier(context?.room_id, 'room_id');
      return startOpeningTurn(authenticatedUserId, roomId);
    }
  });

  return Object.freeze({ saveImports, rooms });
}
