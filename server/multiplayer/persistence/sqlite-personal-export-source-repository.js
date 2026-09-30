import {
  ROOM_CHECKPOINT_SCHEMA,
  assertRoomCheckpoint
} from '../contracts/lineage-contracts.js';
import { canonicalizeJson } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import {
  narrativeDeliveryText,
  openNarrativeDeliveryContent
} from '../security/narrative-delivery-content-codec.js';

const ID = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;

function fail(code, message, details = {}, status = 400) {
  throw new DomainError(code, message, details, { status });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('PERSONAL_EXPORT_SOURCE_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL.test(value)) {
    fail('PERSONAL_EXPORT_SOURCE_INVALID', 'authenticated_user_id is invalid', {}, 401);
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

function requireMember(database, roomId, authenticatedUserId) {
  const member = database.prepare(`
    SELECT m.member_id, m.user_id, m.seat_id,
           r.room_id, r.origin_type, r.lineage_id, r.origin_owner_user_id,
           r.origin_snapshot_id, r.host_user_id
      FROM multiplayer_members AS m
      JOIN multiplayer_rooms AS r ON r.room_id = m.room_id
     WHERE m.room_id = ? AND m.user_id = ? AND m.member_status = 'ACTIVE'
  `).get(roomId, authenticatedUserId);
  if (!member) {
    fail(
      'ROOM_MEMBERSHIP_REQUIRED',
      'the authenticated user is not an active Room member',
      { room_id: roomId },
      403
    );
  }
  return member;
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

function sourceBasis(database, member, epoch) {
  if (epoch.base_type === 'origin_snapshot') {
    const staged = database.prepare(`
      SELECT source_branch_id, source_node_id
        FROM save_import_staging
       WHERE import_id = ? AND owner_user_id = ? AND consumed_room_id = ?
    `).get(epoch.base_ref_id, member.origin_owner_user_id, member.room_id);
    if (!staged) {
      fail(
        'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
        'the immutable origin source reference is unavailable',
        {},
        409
      );
    }
    return {
      type: 'origin_snapshot',
      ref_id: epoch.base_ref_id,
      source_branch_id: staged.source_branch_id,
      source_node_id: staged.source_node_id
    };
  }
  if (epoch.base_type === 'latest_source_import') {
    const source = database.prepare(`
      SELECT source_snapshot_ref, source_branch_id, source_node_id
        FROM room_source_imports
       WHERE source_import_id = ? AND room_id = ? AND validation_status = 'VALID'
    `).get(epoch.base_ref_id, member.room_id);
    if (!source) {
      fail(
        'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
        'latest source import reference is unavailable',
        {},
        409
      );
    }
    return {
      type: 'latest_source_import',
      ref_id: source.source_snapshot_ref,
      source_import_id: epoch.base_ref_id,
      source_branch_id: source.source_branch_id,
      source_node_id: source.source_node_id
    };
  }
  fail(
    'PERSISTED_LINEAGE_CORRUPT',
    'checkpoint ancestry did not terminate at a source basis',
    {},
    500
  );
}

function readChain(database, member, checkpointId) {
  const visiting = new Set();
  const reverse = [];
  let cursorId = checkpointId;
  let basisEpoch = null;
  while (cursorId !== null) {
    if (visiting.has(cursorId)) {
      fail('PERSISTED_LINEAGE_CORRUPT', 'checkpoint ancestry contains a cycle', {}, 500);
    }
    visiting.add(cursorId);
    const row = database.prepare(`
      SELECT * FROM room_checkpoints
       WHERE checkpoint_id = ? AND room_id = ? AND lineage_id = ?
    `).get(cursorId, member.room_id, member.lineage_id);
    if (!row) {
      fail(
        'CHECKPOINT_NOT_COMMITTED',
        'personal export checkpoint ancestry is incomplete',
        { checkpoint_id: cursorId },
        409
      );
    }
    const epoch = database.prepare(`
      SELECT * FROM room_epochs
       WHERE epoch_id = ? AND room_id = ? AND lineage_id = ?
    `).get(row.epoch_id, member.room_id, member.lineage_id);
    if (!epoch) fail('PERSISTED_LINEAGE_CORRUPT', 'checkpoint epoch is missing', {}, 500);
    let turn = null;
    if (row.checkpoint_kind === 'turn_commit') {
      turn = database.prepare(`
        SELECT turn_id, epoch_id, turn_no, turn_status, narrative_mode
          FROM multiplayer_turns
         WHERE turn_id = ? AND room_id = ? AND epoch_id = ?
      `).get(row.turn_id, member.room_id, row.epoch_id);
      if (!turn
        || turn.turn_status !== 'COMMITTED'
        || turn.turn_no !== row.turn_no) {
        fail(
          'CHECKPOINT_NOT_COMMITTED',
          'turn checkpoint is not backed by one committed turn',
          { checkpoint_id: row.checkpoint_id },
          409
        );
      }
    }
    reverse.push({ checkpoint: checkpointContract(row), turn });
    if (row.parent_checkpoint_id !== null) {
      cursorId = row.parent_checkpoint_id;
      continue;
    }
    if (epoch.base_type === 'room_checkpoint') {
      cursorId = epoch.base_ref_id;
      continue;
    }
    basisEpoch = epoch;
    cursorId = null;
  }
  reverse.reverse();
  if (reverse[0]?.checkpoint.kind !== 'genesis' || basisEpoch === null) {
    fail('PERSISTED_LINEAGE_CORRUPT', 'checkpoint ancestry has no valid genesis', {}, 500);
  }
  return {
    entries: reverse,
    source_basis: sourceBasis(database, member, basisEpoch)
  };
}

export function createSqlitePersonalExportSourceRepository(connection, {
  narrativeContentCodec
} = {}) {
  if (!connection || typeof connection.read !== 'function'
    || typeof narrativeContentCodec?.openJson !== 'function') {
    fail(
      'PERSONAL_EXPORT_SOURCE_CONFIGURATION_INVALID',
      'SQLite connection and narrative content codec are required',
      {},
      500
    );
  }

  function loadCheckpointChain({ authenticated_user_id, room_id, checkpoint_id }) {
    const authenticatedUserId = principal(authenticated_user_id);
    const roomId = identifier(room_id, 'room_id');
    const checkpointId = identifier(checkpoint_id, 'checkpoint_id');
    return connection.read(database => {
      const member = requireMember(database, roomId, authenticatedUserId);
      const members = database.prepare(`
        SELECT user_id, seat_id
          FROM multiplayer_members
         WHERE room_id = ? AND member_status = 'ACTIVE'
         ORDER BY seat_id
      `).all(roomId);
      if (members.length !== 2 || members[0].seat_id !== 'A' || members[1].seat_id !== 'B') {
        fail('ROOM_NOT_READY', 'personal export requires both original members', {}, 409);
      }
      const chain = readChain(database, member, checkpointId);
      const bindings = database.prepare(`
        SELECT binding_id, room_actor_id, original_seat_id, genesis_checkpoint_id
          FROM room_actor_bindings
         WHERE room_id = ?
         ORDER BY original_seat_id
      `).all(roomId);
      if (bindings.length !== 2
        || bindings[0].original_seat_id !== 'A'
        || bindings[1].original_seat_id !== 'B') {
        fail(
          'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
          'personal export requires the complete original binding pair',
          {},
          409
        );
      }
      return immutable({
        room: {
          room_id: member.room_id,
          origin_type: member.origin_type,
          lineage_id: member.lineage_id,
          origin_owner_user_id: member.origin_owner_user_id,
          origin_snapshot_id: member.origin_snapshot_id,
          host_user_id: member.host_user_id
        },
        exporting_member: {
          member_id: member.member_id,
          user_id: member.user_id,
          seat: member.seat_id
        },
        members_by_seat: Object.fromEntries(
          members.map(row => [row.seat_id, row.user_id])
        ),
        binding_bootstrap: bindings.map(row => ({
          binding_id: row.binding_id,
          room_actor_id: row.room_actor_id,
          original_seat: row.original_seat_id,
          genesis_checkpoint_id: row.genesis_checkpoint_id
        })),
        source_basis: chain.source_basis,
        checkpoint_chain: chain.entries
      });
    });
  }

  function getNarrativeForMember({ authenticated_user_id, room_id, turn_id }) {
    const authenticatedUserId = principal(authenticated_user_id);
    const roomId = identifier(room_id, 'room_id');
    const turnId = identifier(turn_id, 'turn_id');
    return connection.read(database => {
      const member = requireMember(database, roomId, authenticatedUserId);
      const turn = database.prepare(`
        SELECT turn_id, room_id, epoch_id, turn_status, narrative_mode
          FROM multiplayer_turns
         WHERE turn_id = ? AND room_id = ?
      `).get(turnId, roomId);
      if (!turn || turn.turn_status !== 'COMMITTED') {
        fail('CHECKPOINT_NOT_COMMITTED', 'narrative export requires a committed turn', {}, 409);
      }
      // The SQL predicate is audience-scoped. In dual POV mode the opposite
      // delivery is never fetched or decrypted and therefore cannot leak via
      // later in-memory filtering.
      const audience = turn.narrative_mode === 'shared' ? 'shared' : member.seat_id;
      const row = database.prepare(`
        SELECT d.*, t.room_id, t.epoch_id
          FROM narrative_deliveries AS d
          JOIN multiplayer_turns AS t ON t.turn_id = d.turn_id
         WHERE d.turn_id = ? AND d.audience = ?
           AND d.narrative_mode = t.narrative_mode
      `).get(turnId, audience);
      if (!row) {
        fail(
          'NARRATIVE_DELIVERY_CORRUPT',
          'authenticated member narrative delivery is missing',
          { turn_id: turnId, audience },
          500
        );
      }
      const delivery = openNarrativeDeliveryContent(narrativeContentCodec, row);
      return immutable({
        turn_id: turnId,
        mode: turn.narrative_mode,
        audience,
        text: narrativeDeliveryText(delivery)
      });
    });
  }

  return Object.freeze({ loadCheckpointChain, getNarrativeForMember });
}
