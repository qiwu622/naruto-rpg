import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
  FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA,
  RESUME_ROOM_CHECKPOINT_SCHEMA,
  ROOM_ACTOR_BINDING_SCHEMA,
  ROOM_CHECKPOINT_SCHEMA,
  ROOM_EPOCH_SCHEMA,
  SOURCE_IMPORT_SCHEMA,
  assertAudienceSafeImportDiff,
  assertForkFromLatestSourceSave,
  assertOriginalActorBindingBijection,
  assertResumeRoomCheckpoint,
  assertRoomActorBinding,
  assertRoomCheckpoint,
  assertRoomEpoch,
  assertSourceImport
} from '../contracts/lineage-contracts.js';
import {
  assertJsonSafe,
  canonicalStringify,
  canonicalizeJson,
  hmacSha256,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

const ROOM_SEATS = Object.freeze(['A', 'B']);
const VOIDABLE_TURN_STATUSES = new Set([
  'COLLECTING_ACTIONS',
  'ONE_ACTION_LOCKED',
  'SEALED',
  'AWAITING_BILLING_AUTHORIZATION',
  'REPAIRING_DRAFT',
  'REPAIR_PAUSED',
  'RETRYABLE_FAILED',
  'AUDITING'
]);
const EVENT_PROJECTION_VERSION = 'naruto.multiplayer-lineage-event-projection/v1';
const EXPORT_CODEC = 'naruto.multiplayer-to-singleplayer/v1';
const ID_REGEXP = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL_REGEXP = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;
const HASH_REGEXP = /^sha256:[a-f0-9]{64}$/u;

function fail(code, message, details = {}, status = undefined) {
  throw new DomainError(code, message, details, status === undefined ? {} : { status });
}

function assertConnection(connection) {
  if (!connection
    || typeof connection.read !== 'function'
    || typeof connection.write !== 'function') {
    fail(
      'LINEAGE_REPOSITORY_CONFIGURATION_INVALID',
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

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH_REGEXP.test(value)) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must be a sha256 hash`, { field: label });
  }
  return value;
}

function assertNonEmptyString(value, label, max = 2_048) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must be a non-empty string`, { field: label });
  }
  return value;
}

function assertSyncResult(value, label) {
  if (value && typeof value.then === 'function') {
    fail(
      'ASYNC_SQLITE_TRANSACTION_FORBIDDEN',
      `${label} must be synchronous; network work is forbidden in lineage persistence`
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

function hashCanonical(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function defaultIdFactory(kind) {
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

function generatedId(idFactory, kind) {
  return assertIdentifier(idFactory(kind), `${kind}_id`);
}

function parseCanonicalJson(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('PERSISTED_LINEAGE_CORRUPT', `${label} is not valid JSON`);
  }
  assertJsonSafe(parsed, { maxDepth: 64, maxNodes: 300_000 });
  return parsed;
}

function requireMember(database, roomId, authenticatedUserId) {
  const row = database.prepare(`
    SELECT m.member_id, m.user_id, m.seat_id, m.member_status,
           r.room_id, r.origin_type, r.lineage_id, r.origin_owner_user_id,
           r.origin_snapshot_id, r.host_user_id, r.lifecycle, r.active_epoch_id,
           r.current_turn_id, r.state_revision, r.control_revision,
           r.event_seq, r.active_narrative_mode
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

function originalMembers(database, roomId) {
  const rows = database.prepare(`
    SELECT member_id, user_id, seat_id
      FROM multiplayer_members
     WHERE room_id = ? AND member_status = 'ACTIVE'
     ORDER BY seat_id
  `).all(roomId);
  if (rows.length !== 2 || rows[0].seat_id !== 'A' || rows[1].seat_id !== 'B') {
    fail('ROOM_NOT_READY', 'both original active members are required', { room_id: roomId }, 409);
  }
  return rows;
}

function membersBySeat(rows) {
  return Object.fromEntries(rows.map(row => [row.seat_id, row.user_id]));
}

function memberRowBySeat(rows) {
  return Object.fromEntries(rows.map(row => [row.seat_id, row]));
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

function sourceImportContract(row) {
  return assertSourceImport({
    schema: SOURCE_IMPORT_SCHEMA,
    source_import_id: row.source_import_id,
    room_id: row.room_id,
    lineage_id: row.lineage_id,
    origin_owner_user_id: row.origin_owner_user_id,
    source_save_id: row.source_save_id,
    client_save_instance_id: row.client_save_instance_id,
    source_branch_id: row.source_branch_id,
    source_node_id: row.source_node_id,
    cloud_revision: row.cloud_revision,
    canonical_content_hash: row.canonical_content_hash,
    selected_state_hash: row.selected_state_hash,
    raw_source_hash: row.raw_source_hash,
    normalized_source_hash: row.normalized_source_hash,
    normalization_and_rebind_diff_hash: row.normalization_and_rebind_diff_hash,
    genesis_state_hash: row.genesis_state_hash,
    privacy_normalizer_version: row.privacy_normalizer_version,
    derived_from_export_id: row.derived_from_export_id,
    audience_diff_commitments: {
      A: row.audience_diff_a_commitment,
      B: row.audience_diff_b_commitment
    },
    server_hmac_commitment: row.server_hmac_commitment,
    imported_at: row.imported_at
  });
}

function insertEvents(database, {
  roomId,
  epochId = null,
  endEventSeq,
  events,
  createdAt,
  idFactory
}) {
  if (events.length === 0) return [];
  const firstEventSeq = endEventSeq - events.length + 1;
  const insertEvent = database.prepare(`
    INSERT INTO room_events (
      event_id, room_id, event_seq, epoch_id, turn_id, event_type,
      audience, projection_version, projected_payload_json, payload_hash,
      created_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `);
  const insertOutbox = database.prepare(`
    INSERT INTO room_outbox (
      outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
      lease_fence, lease_expires_at, claimed_at, dispatched_at,
      attempt_count, created_at
    ) VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, 0, ?)
  `);
  return events.map((event, offset) => {
    const eventId = generatedId(idFactory, 'event');
    const outboxId = generatedId(idFactory, 'outbox');
    const payload = canonicalizeJson(event.payload);
    const payloadJson = canonicalStringify(payload);
    const eventSeq = firstEventSeq + offset;
    insertEvent.run(
      eventId,
      roomId,
      eventSeq,
      epochId,
      event.event_type,
      event.audience,
      EVENT_PROJECTION_VERSION,
      payloadJson,
      `sha256:${sha256Hex(payloadJson)}`,
      createdAt
    );
    insertOutbox.run(outboxId, roomId, eventId, createdAt);
    return { event_id: eventId, outbox_id: outboxId, event_seq: eventSeq };
  });
}

function seatEvents(eventType, payloadForSeat) {
  return ROOM_SEATS.map(seat => ({
    audience: seat,
    event_type: eventType,
    payload: payloadForSeat(seat)
  }));
}

function allocateEventOnlyRevision(database, roomId, expectedEventSeq, count, updatedAt) {
  const row = database.prepare(`
    UPDATE multiplayer_rooms
       SET event_seq = event_seq + ?, updated_at = ?
     WHERE room_id = ? AND event_seq = ?
    RETURNING event_seq
  `).get(count, updatedAt, roomId, expectedEventSeq);
  if (!row) fail('LINEAGE_EVENT_CAS_FAILED', 'room event sequence changed during lineage write');
  return row.event_seq;
}

function bindingSignaturePayload(binding, opaqueBindingToken, signatureVersion) {
  return {
    schema: 'naruto.multiplayer-room-actor-binding-signature/v1',
    binding_id: binding.binding_id,
    room_id: binding.room_id,
    lineage_id: binding.lineage_id,
    room_actor_id: binding.room_actor_id,
    original_member_user_id: binding.original_member_user_id,
    original_seat: binding.original_seat,
    genesis_checkpoint_id: binding.genesis_checkpoint_id,
    opaque_binding_token: opaqueBindingToken,
    signature_version: signatureVersion
  };
}

function signBinding(secret, payload) {
  return Buffer.from(hmacSha256(secret, payload), 'hex');
}

function verifyBindingSignature(secret, payload, storedSignature) {
  const expected = signBinding(secret, payload);
  const actual = Buffer.from(storedSignature);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function equalBytes(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function assertAudienceDiffCodec(codec) {
  if (!codec || typeof codec !== 'object'
    || typeof codec.codecVersion !== 'string' || codec.codecVersion.length < 2
    || typeof codec.sealJson !== 'function'
    || typeof codec.openJson !== 'function') {
    fail(
      'LINEAGE_REPOSITORY_CONFIGURATION_INVALID',
      'an encrypted audience-diff codec with codecVersion/sealJson/openJson is required'
    );
  }
  return codec;
}

function sealAudienceDiff(codec, value, context) {
  const result = assertSyncResult(codec.sealJson(value, context), 'audience diff sealJson');
  if (!(result instanceof Uint8Array) || result.byteLength < 1) {
    fail('AUDIENCE_DIFF_CODEC_INVALID', 'audience diff codec returned invalid ciphertext');
  }
  return Buffer.from(result);
}

function openAudienceDiff(codec, ciphertext, context) {
  const result = assertSyncResult(
    codec.openJson(Buffer.from(ciphertext), context),
    'audience diff openJson'
  );
  assertJsonSafe(result, { maxDepth: 32, maxNodes: 30_000 });
  return result;
}

function normalizeSnapshotEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('REPOSITORY_INPUT_INVALID', 'snapshot must be an encrypted snapshot envelope');
  }
  const bytes = (field, min) => {
    const candidate = value[field];
    if (!(candidate instanceof Uint8Array) || candidate.byteLength < min) {
      fail('REPOSITORY_INPUT_INVALID', `snapshot.${field} is invalid`);
    }
    return Buffer.from(candidate);
  };
  return Object.freeze({
    snapshot_id: assertIdentifier(value.snapshot_id, 'snapshot.snapshot_id'),
    state_hash: assertHash(value.state_hash, 'snapshot.state_hash'),
    snapshot_ciphertext: bytes('snapshot_ciphertext', 1),
    wrapped_data_key: bytes('wrapped_data_key', 16),
    nonce: bytes('nonce', 8),
    auth_tag: bytes('auth_tag', 8),
    master_key_version: assertNonEmptyString(
      value.master_key_version,
      'snapshot.master_key_version',
      160
    )
  });
}

function assertSecret(value, label) {
  const valid = typeof value === 'string'
    ? Buffer.byteLength(value) > 0
    : value instanceof Uint8Array && value.byteLength > 0;
  if (!valid) {
    fail('LINEAGE_REPOSITORY_CONFIGURATION_INVALID', `${label} must be non-empty`);
  }
  return value;
}

function proposalCommitment(secret, payload) {
  return `hmac-sha256:${hmacSha256(secret, payload)}`;
}

function proposalRequestHash(payload, proposedByMemberId) {
  return hashCanonical({ payload, proposed_by_member_id: proposedByMemberId });
}

function assertProposalIntegrity(row, commitmentSecret) {
  const payload = parseCanonicalJson(row.proposal_payload_json, 'proposal payload');
  const { server_hmac_commitment: storedCommitment, ...unsignedPayload } = payload;
  if (payload.proposal_id !== row.proposal_id
    || payload.proposal_revision !== row.proposal_revision
    || payload.room_id !== row.room_id
    || storedCommitment !== proposalCommitment(commitmentSecret, unsignedPayload)) {
    fail('PERSISTED_LINEAGE_CORRUPT', 'proposal payload commitment is invalid');
  }
  if (row.request_hash !== proposalRequestHash(payload, row.proposed_by_member_id)) {
    fail('PERSISTED_LINEAGE_CORRUPT', 'proposal request hash is invalid');
  }
  return payload;
}

function proposalProjection(row, viewerSeat, commitmentSecret) {
  const payload = assertProposalIntegrity(row, commitmentSecret);
  const ownPrefix = viewerSeat === 'A' ? 'accepted_by_a' : 'accepted_by_b';
  return immutable({
    proposal_id: row.proposal_id,
    proposal_revision: row.proposal_revision,
    proposal_type: row.proposal_type,
    status: row.proposal_status,
    target_turn_id: row.target_turn_id,
    target_checkpoint_id: row.target_checkpoint_id,
    source_import_id: row.source_import_id,
    accepted_by_seat: {
      A: row.accepted_by_a_at !== null,
      B: row.accepted_by_b_at !== null
    },
    viewer_acceptance: row[`${ownPrefix}_at`] === null
      ? null
      : {
          accepted_at: row[`${ownPrefix}_at`],
          proposal_revision: row[`${ownPrefix}_revision`],
          audience_diff_commitment: row[`${ownPrefix}_diff_commitment`]
        },
    server_hmac_commitment: payload.server_hmac_commitment,
    created_at: row.created_at,
    applied_at: row.applied_at
  });
}

export function createSqliteLineageRepository(connectionValue, options = {}) {
  const connection = assertConnection(connectionValue);
  const idFactory = typeof options.idFactory === 'function'
    ? options.idFactory
    : defaultIdFactory;
  const clock = typeof options.clock === 'function'
    ? options.clock
    : () => new Date().toISOString();
  const audienceDiffCodec = assertAudienceDiffCodec(options.audienceDiffCodec);
  const bindingSignatureSecret = assertSecret(
    options.bindingSignatureSecret,
    'bindingSignatureSecret'
  );
  const proposalCommitmentSecret = assertSecret(
    options.proposalCommitmentSecret,
    'proposalCommitmentSecret'
  );
  const bindingSignatureVersion = assertIdentifier(
    options.bindingSignatureVersion ?? 'room_actor_binding_hmac_v1',
    'bindingSignatureVersion'
  );
  const now = () => assertTimestamp(clock(), 'clock result');

  const bindings = {
    async createPair({ authenticated_user_id, room_id, actor_bindings }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      if (!Array.isArray(actor_bindings) || actor_bindings.length !== 2) {
        fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'exactly two actor bindings are required');
      }
      const createdAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const memberRows = originalMembers(database, roomId);
        const bySeat = memberRowBySeat(memberRows);
        const initialEpoch = database.prepare(`
          SELECT * FROM room_epochs
           WHERE room_id = ? AND epoch_no = 1
        `).get(roomId);
        if (!initialEpoch) fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'initial epoch is missing');

        const seenSeats = new Set();
        const seenActors = new Set();
        const seenTokens = new Set();
        const contracts = actor_bindings.map((input, index) => {
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            fail('RETURN_ACTOR_BINDING_INVALID', `actor_bindings[${index}] is invalid`);
          }
          const seat = input.original_seat;
          if (!ROOM_SEATS.includes(seat) || seenSeats.has(seat)) {
            fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'binding seats must be exactly A and B');
          }
          const actorId = assertIdentifier(input.room_actor_id, `actor_bindings[${index}].room_actor_id`);
          const token = assertNonEmptyString(
            input.opaque_binding_token,
            `actor_bindings[${index}].opaque_binding_token`,
            2_048
          );
          if (token.length < 16 || seenActors.has(actorId) || seenTokens.has(token)) {
            fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'binding actors and tokens must be distinct');
          }
          seenSeats.add(seat);
          seenActors.add(actorId);
          seenTokens.add(token);
          return assertRoomActorBinding({
            schema: ROOM_ACTOR_BINDING_SCHEMA,
            binding_id: assertIdentifier(input.binding_id, `actor_bindings[${index}].binding_id`),
            room_id: roomId,
            lineage_id: member.lineage_id,
            room_actor_id: actorId,
            original_member_user_id: bySeat[seat].user_id,
            original_seat: seat,
            genesis_checkpoint_id: initialEpoch.genesis_checkpoint_id,
            signature_version: bindingSignatureVersion,
            opaque_binding_token: token,
            created_at: createdAt
          });
        });
        assertOriginalActorBindingBijection(contracts, {
          lineage_id: member.lineage_id,
          expected_members_by_seat: membersBySeat(memberRows)
        });

        const existing = database.prepare(`
          SELECT b.*, m.user_id AS original_member_user_id
            FROM room_actor_bindings AS b
            JOIN multiplayer_members AS m ON m.member_id = b.original_member_id
           WHERE b.room_id = ? ORDER BY b.original_seat_id
        `).all(roomId);
        if (existing.length > 0) {
          if (existing.length !== 2) {
            fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'stored binding pair is incomplete');
          }
          const contractBySeat = Object.fromEntries(
            contracts.map(contract => [contract.original_seat, contract])
          );
          for (const row of existing) {
            const contract = contractBySeat[row.original_seat_id];
            const signaturePayload = bindingSignaturePayload(
              contract,
              contract.opaque_binding_token,
              bindingSignatureVersion
            );
            if (!contract
              || row.binding_id !== contract.binding_id
              || row.room_actor_id !== contract.room_actor_id
              || row.opaque_binding_token_hash !== `sha256:${sha256Hex(contract.opaque_binding_token)}`
              || row.signature_version !== bindingSignatureVersion
              || !verifyBindingSignature(
                bindingSignatureSecret,
                signaturePayload,
                row.server_signature
              )) {
              fail('RETURN_ACTOR_BINDING_INVALID', 'stored binding pair differs from this request');
            }
          }
          return immutable({ bindings: contracts, replayed: true });
        }
        if (authenticatedUserId !== member.host_user_id) {
          fail(
            'ROOM_HOST_REQUIRED',
            'only the authoritative room host may create the original binding pair',
            {},
            403
          );
        }

        const insert = database.prepare(`
          INSERT INTO room_actor_bindings (
            binding_id, room_id, lineage_id, room_actor_id,
            original_member_id, original_seat_id, genesis_checkpoint_id,
            opaque_binding_token_hash, signature_version, server_signature,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const contract of contracts) {
          const signaturePayload = bindingSignaturePayload(
            contract,
            contract.opaque_binding_token,
            bindingSignatureVersion
          );
          insert.run(
            contract.binding_id,
            roomId,
            member.lineage_id,
            contract.room_actor_id,
            bySeat[contract.original_seat].member_id,
            contract.original_seat,
            contract.genesis_checkpoint_id,
            `sha256:${sha256Hex(contract.opaque_binding_token)}`,
            bindingSignatureVersion,
            signBinding(bindingSignatureSecret, signaturePayload),
            createdAt
          );
        }
        return immutable({ bindings: contracts, replayed: false });
      });
    },

    listMetadata({ authenticated_user_id, room_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      return connection.read(database => {
        requireMember(database, roomId, authenticatedUserId);
        const rows = database.prepare(`
          SELECT binding_id, room_actor_id, original_seat_id,
                 genesis_checkpoint_id, signature_version, created_at
            FROM room_actor_bindings
           WHERE room_id = ? ORDER BY original_seat_id
        `).all(roomId);
        return immutable(rows.map(row => ({
          binding_id: row.binding_id,
          room_actor_id: row.room_actor_id,
          original_seat: row.original_seat_id,
          genesis_checkpoint_id: row.genesis_checkpoint_id,
          signature_version: row.signature_version,
          created_at: row.created_at
        })));
      });
    },

    verifyPairForPersonalExport({ authenticated_user_id, room_id, actor_bindings }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      if (!Array.isArray(actor_bindings) || actor_bindings.length !== 2) {
        fail(
          'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
          'personal export requires exactly two issued actor bindings'
        );
      }
      return connection.read(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const memberRows = originalMembers(database, roomId);
        const expectedMembersBySeat = membersBySeat(memberRows);
        const candidatesBySeat = {};
        for (let index = 0; index < actor_bindings.length; index += 1) {
          const candidate = actor_bindings[index];
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            fail('RETURN_ACTOR_BINDING_INVALID', `actor_bindings[${index}] is invalid`);
          }
          const originalSeat = candidate.original_seat;
          if (!ROOM_SEATS.includes(originalSeat) || candidatesBySeat[originalSeat]) {
            fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'binding seats must be exactly A and B');
          }
          candidatesBySeat[originalSeat] = {
            binding_id: assertIdentifier(
              candidate.binding_id,
              `actor_bindings[${index}].binding_id`
            ),
            room_actor_id: assertIdentifier(
              candidate.room_actor_id,
              `actor_bindings[${index}].room_actor_id`
            ),
            original_seat: originalSeat,
            opaque_binding_token: assertNonEmptyString(
              candidate.opaque_binding_token,
              `actor_bindings[${index}].opaque_binding_token`,
              2_048
            )
          };
        }
        const rows = database.prepare(`
          SELECT b.*, m.user_id AS original_member_user_id
            FROM room_actor_bindings AS b
            JOIN multiplayer_members AS m ON m.member_id = b.original_member_id
           WHERE b.room_id = ?
           ORDER BY b.original_seat_id
        `).all(roomId);
        if (rows.length !== 2) {
          fail(
            'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
            'stored original actor binding pair is incomplete'
          );
        }
        const contracts = rows.map(row => {
          const candidate = candidatesBySeat[row.original_seat_id];
          if (!candidate
            || candidate.binding_id !== row.binding_id
            || candidate.room_actor_id !== row.room_actor_id
            || row.lineage_id !== member.lineage_id
            || row.opaque_binding_token_hash
              !== `sha256:${sha256Hex(candidate.opaque_binding_token)}`) {
            fail(
              'RETURN_ACTOR_BINDING_INVALID',
              'issued actor binding does not match the immutable Room binding'
            );
          }
          const contract = assertRoomActorBinding({
            schema: ROOM_ACTOR_BINDING_SCHEMA,
            binding_id: row.binding_id,
            room_id: row.room_id,
            lineage_id: row.lineage_id,
            room_actor_id: row.room_actor_id,
            original_member_user_id: row.original_member_user_id,
            original_seat: row.original_seat_id,
            genesis_checkpoint_id: row.genesis_checkpoint_id,
            signature_version: row.signature_version,
            opaque_binding_token: candidate.opaque_binding_token,
            created_at: row.created_at
          });
          if (row.signature_version !== bindingSignatureVersion
            || !verifyBindingSignature(
              bindingSignatureSecret,
              bindingSignaturePayload(
                contract,
                candidate.opaque_binding_token,
                row.signature_version
              ),
              row.server_signature
            )) {
            fail(
              'RETURN_ACTOR_BINDING_INVALID',
              'stored actor binding signature failed verification'
            );
          }
          return contract;
        });
        assertOriginalActorBindingBijection(contracts, {
          lineage_id: member.lineage_id,
          expected_members_by_seat: expectedMembersBySeat
        });
        return immutable({ bindings: contracts, exporting_seat: member.seat_id });
      });
    },

    resolveLatestSourcePair({
      authenticated_user_id,
      room_id,
      lineage_id,
      checkpoint_id,
      derived_from_export_id,
      exporting_seat,
      actor_binding_matches
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const lineageId = assertIdentifier(lineage_id, 'lineage_id');
      const checkpointId = assertIdentifier(checkpoint_id, 'checkpoint_id');
      const exportId = assertIdentifier(derived_from_export_id, 'derived_from_export_id');
      if (!ROOM_SEATS.includes(exporting_seat)) {
        fail('RETURN_ACTOR_BINDING_INVALID', 'exporting_seat must be A or B');
      }
      return connection.read(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        if (member.origin_type !== 'existing_save_derived') {
          fail(
            'CONTINUATION_MODE_NOT_ALLOWED',
            'new_multiplayer_save cannot accept a latest source save'
          );
        }
        if (member.origin_owner_user_id !== authenticatedUserId) {
          fail('SOURCE_OWNER_REQUIRED', 'only the immutable origin owner may upload latest source');
        }
        if (member.lifecycle !== 'ARCHIVED' || member.active_epoch_id !== null) {
          fail('ROOM_NOT_AT_CHECKPOINT', 'latest source import requires an archived Room');
        }
        if (member.lineage_id !== lineageId || member.seat_id !== exporting_seat) {
          fail('SOURCE_IMPORT_CHANGED', 'source export metadata belongs to another Room authority');
        }
        const derived = database.prepare(`
          SELECT e.export_id, e.checkpoint_id, e.exporting_seat_id,
                 e.export_status, e.output_hash, m.user_id AS exporting_user_id
            FROM singleplayer_exports AS e
            JOIN multiplayer_members AS m ON m.member_id = e.exporting_member_id
           WHERE e.export_id = ? AND e.room_id = ?
        `).get(exportId, roomId);
        if (!derived
          || derived.export_status !== 'READY'
          || derived.output_hash === null
          || derived.exporting_user_id !== authenticatedUserId
          || derived.exporting_seat_id !== exporting_seat
          || derived.checkpoint_id !== checkpointId) {
          fail(
            'SOURCE_OWNER_REQUIRED',
            'latest source must descend from an authenticated source-owner export',
            {},
            403
          );
        }
        const memberRows = originalMembers(database, roomId);
        const expectedMembersBySeat = membersBySeat(memberRows);
        const resolved = resolveSignedBindingMatches(
          database,
          roomId,
          actor_binding_matches,
          expectedMembersBySeat
        );
        return immutable({
          room_id: roomId,
          lineage_id: member.lineage_id,
          origin_owner_user_id: member.origin_owner_user_id,
          owner_seat: member.seat_id,
          members_by_seat: expectedMembersBySeat,
          state_revision: member.state_revision,
          control_revision: member.control_revision,
          derived_export: derived,
          actor_rebind_entries: resolved.entries
        });
      });
    }
  };

  function resolveSignedBindingMatches(database, roomId, matchesValue, expectedMembersBySeat) {
    if (!Array.isArray(matchesValue) || matchesValue.length !== 2) {
      fail(
        'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
        'latest source must contain exactly two signed actor binding tokens'
      );
    }
    const rows = database.prepare(`
      SELECT b.*, m.user_id AS original_member_user_id
        FROM room_actor_bindings AS b
        JOIN multiplayer_members AS m ON m.member_id = b.original_member_id
       WHERE b.room_id = ?
       ORDER BY b.original_seat_id
    `).all(roomId);
    if (rows.length !== 2) {
      fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'room does not have a complete binding pair');
    }
    const rowByTokenHash = new Map(rows.map(row => [row.opaque_binding_token_hash, row]));
    const matchedRows = new Set();
    const sourceEntities = new Set();
    const contracts = [];
    const rebindEntries = [];
    for (let index = 0; index < matchesValue.length; index += 1) {
      const match = matchesValue[index];
      if (!match || typeof match !== 'object' || Array.isArray(match)) {
        fail('RETURN_ACTOR_BINDING_INVALID', `actor_binding_matches[${index}] is invalid`);
      }
      const sourceEntityId = assertIdentifier(
        match.source_entity_id,
        `actor_binding_matches[${index}].source_entity_id`
      );
      const token = assertNonEmptyString(
        match.opaque_binding_token,
        `actor_binding_matches[${index}].opaque_binding_token`,
        2_048
      );
      if (token.length < 16) {
        fail('RETURN_ACTOR_BINDING_INVALID', 'opaque actor binding token is malformed');
      }
      const row = rowByTokenHash.get(`sha256:${sha256Hex(token)}`);
      if (!row) {
        fail('RETURN_ACTOR_BINDING_INVALID', 'latest source actor token is not authoritative');
      }
      if (matchedRows.has(row.binding_id)) {
        fail('RETURN_ACTOR_AMBIGUOUS', 'an original actor binding appears more than once');
      }
      if (sourceEntities.has(sourceEntityId)) {
        fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'two bindings point to one source entity');
      }
      const contract = assertRoomActorBinding({
        schema: ROOM_ACTOR_BINDING_SCHEMA,
        binding_id: row.binding_id,
        room_id: row.room_id,
        lineage_id: row.lineage_id,
        room_actor_id: row.room_actor_id,
        original_member_user_id: row.original_member_user_id,
        original_seat: row.original_seat_id,
        genesis_checkpoint_id: row.genesis_checkpoint_id,
        signature_version: row.signature_version,
        opaque_binding_token: token,
        created_at: row.created_at
      });
      const payload = bindingSignaturePayload(contract, token, row.signature_version);
      if (row.signature_version !== bindingSignatureVersion
        || !verifyBindingSignature(bindingSignatureSecret, payload, row.server_signature)) {
        fail('RETURN_ACTOR_BINDING_INVALID', 'latest source actor binding signature is invalid');
      }
      matchedRows.add(row.binding_id);
      sourceEntities.add(sourceEntityId);
      contracts.push(contract);
      rebindEntries.push({
        binding_id: row.binding_id,
        original_seat: row.original_seat_id,
        source_entity_id: sourceEntityId,
        room_actor_id: row.room_actor_id,
        signature_version: row.signature_version
      });
    }
    assertOriginalActorBindingBijection(contracts, {
      lineage_id: rows[0].lineage_id,
      expected_members_by_seat: expectedMembersBySeat,
      source_actor_matches: matchesValue,
      verify_binding_token: (token, binding) => {
        const row = rows.find(candidate => candidate.binding_id === binding.binding_id);
        return Boolean(row) && verifyBindingSignature(
          bindingSignatureSecret,
          bindingSignaturePayload(binding, token, row.signature_version),
          row.server_signature
        );
      }
    });
    rebindEntries.sort((left, right) => left.original_seat.localeCompare(right.original_seat));
    const actorRebind = immutable({
      schema: 'naruto.multiplayer-persisted-actor-rebind/v1',
      entries: rebindEntries
    });
    return Object.freeze({
      actor_rebind_json: canonicalStringify(actorRebind),
      actor_binding_set_hash: hashCanonical(actorRebind),
      entries: actorRebind.entries
    });
  }

  const sourceImports = {
    async saveValidated({
      authenticated_user_id,
      room_id,
      source_import: sourceImportValue,
      audience_diffs,
      actor_binding_matches,
      validation_result,
      source_snapshot_ref
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const sourceImport = assertSourceImport(sourceImportValue, {
        authenticated_user_id: authenticatedUserId
      });
      if (!audience_diffs || typeof audience_diffs !== 'object' || Array.isArray(audience_diffs)) {
        fail('REPOSITORY_INPUT_INVALID', 'audience_diffs must contain A and B projections');
      }
      const diffs = {
        A: assertAudienceSafeImportDiff(audience_diffs.A),
        B: assertAudienceSafeImportDiff(audience_diffs.B)
      };
      if (diffs.A.audience !== 'A' || diffs.B.audience !== 'B'
        || diffs.A.proposal_id !== diffs.B.proposal_id
        || diffs.A.proposal_revision !== diffs.B.proposal_revision) {
        fail('SOURCE_IMPORT_CHANGED', 'audience diffs do not bind one proposal revision');
      }
      assertJsonSafe(validation_result, { maxDepth: 32, maxNodes: 30_000 });
      if (!validation_result
        || typeof validation_result !== 'object'
        || Array.isArray(validation_result)
        || validation_result.valid !== true) {
        fail('SOURCE_IMPORT_CHANGED', 'only an explicitly valid normalized source may be stored');
      }
      const validationResultJson = canonicalStringify(validation_result);
      const sourceSnapshotRef = assertNonEmptyString(
        source_snapshot_ref,
        'source_snapshot_ref',
        2_048
      );
      const codecContext = seat => Object.freeze({
        purpose: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
        codec_version: audienceDiffCodec.codecVersion,
        room_id: roomId,
        source_import_id: sourceImport.source_import_id,
        proposal_id: diffs[seat].proposal_id,
        proposal_revision: diffs[seat].proposal_revision,
        audience: seat
      });
      // Diff encryption is completed before BEGIN IMMEDIATE. The transaction
      // only persists already validated ciphertext and small metadata.
      const ciphertext = {
        A: sealAudienceDiff(audienceDiffCodec, diffs.A, codecContext('A')),
        B: sealAudienceDiff(audienceDiffCodec, diffs.B, codecContext('B'))
      };
      const importRequestHash = hashCanonical({
        source_import: sourceImport,
        audience_diff_hashes: {
          A: hashCanonical(diffs.A),
          B: hashCanonical(diffs.B)
        },
        actor_binding_matches,
        validation_result,
        source_snapshot_ref: sourceSnapshotRef
      });
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        if (member.origin_type !== 'existing_save_derived') {
          fail(
            'CONTINUATION_MODE_NOT_ALLOWED',
            'new_multiplayer_save cannot accept a latest source import'
          );
        }
        if (member.origin_owner_user_id !== authenticatedUserId) {
          fail('SOURCE_OWNER_REQUIRED', 'only the immutable origin owner may upload latest source');
        }
        if (sourceImport.room_id !== roomId
          || sourceImport.lineage_id !== member.lineage_id
          || sourceImport.origin_owner_user_id !== member.origin_owner_user_id
          || sourceImport.normalization_and_rebind_diff_hash === null) {
          fail('SOURCE_IMPORT_CHANGED', 'source import authority or normalized basis is invalid');
        }
        const existing = database.prepare(`
          SELECT * FROM room_source_imports WHERE source_import_id = ?
        `).get(sourceImport.source_import_id);
        if (existing) {
          if (existing.room_id !== roomId || existing.import_request_hash !== importRequestHash) {
            fail('SOURCE_IMPORT_CHANGED', 'source import ID was reused with different content');
          }
          return immutable({
            source_import_id: existing.source_import_id,
            proposal_id: existing.proposal_id,
            proposal_revision: existing.proposal_revision,
            replayed: true
          });
        }
        if (member.lifecycle !== 'ARCHIVED' || member.active_epoch_id !== null) {
          fail('ROOM_NOT_AT_CHECKPOINT', 'latest source import requires an archived room');
        }
        const memberRows = originalMembers(database, roomId);
        const expectedMembersBySeat = membersBySeat(memberRows);
        for (const seat of ROOM_SEATS) {
          const diff = diffs[seat];
          const expectedRole = expectedMembersBySeat[seat] === member.origin_owner_user_id
            ? 'source_owner'
            : 'guest';
          if (diff.room_id !== roomId
            || diff.lineage_id !== member.lineage_id
            || diff.source_import_id !== sourceImport.source_import_id
            || diff.audience_user_id !== expectedMembersBySeat[seat]
            || diff.audience_role !== expectedRole
            || diff.projection_commitment !== sourceImport.audience_diff_commitments[seat]) {
            fail('SOURCE_IMPORT_CHANGED', `audience ${seat} diff does not match the source import`);
          }
        }
        if (sourceImport.derived_from_export_id !== null) {
          const derived = database.prepare(`
            SELECT e.export_status, m.user_id AS exporting_user_id
              FROM singleplayer_exports AS e
              JOIN multiplayer_members AS m ON m.member_id = e.exporting_member_id
             WHERE e.export_id = ? AND e.room_id = ?
          `).get(sourceImport.derived_from_export_id, roomId);
          if (!derived
            || derived.export_status !== 'READY'
            || derived.exporting_user_id !== member.origin_owner_user_id) {
            fail(
              'SOURCE_OWNER_REQUIRED',
              'a guest or unpublished personal export cannot become the Room latest source'
            );
          }
        }
        const bindingMatch = resolveSignedBindingMatches(
          database,
          roomId,
          actor_binding_matches,
          expectedMembersBySeat
        );
        const duplicateSource = database.prepare(`
          SELECT source_import_id, import_request_hash
            FROM room_source_imports
           WHERE room_id = ? AND source_save_id = ? AND client_save_instance_id = ?
             AND source_branch_id = ? AND source_node_id = ?
             AND canonical_content_hash = ?
        `).get(
          roomId,
          sourceImport.source_save_id,
          sourceImport.client_save_instance_id,
          sourceImport.source_branch_id,
          sourceImport.source_node_id,
          sourceImport.canonical_content_hash
        );
        if (duplicateSource) {
          fail('SOURCE_IMPORT_CHANGED', 'the selected source node was already imported differently', {
            source_import_id: duplicateSource.source_import_id
          });
        }
        database.prepare(`
          INSERT INTO room_source_imports (
            source_import_id, room_id, lineage_id, proposal_id,
            proposal_revision, origin_owner_user_id, source_save_id,
            client_save_instance_id, source_branch_id, source_node_id,
            cloud_revision, canonical_content_hash, selected_state_hash,
            raw_source_hash, normalized_source_hash,
            normalization_and_rebind_diff_hash, genesis_state_hash,
            privacy_normalizer_version, derived_from_export_id,
            import_request_hash, validation_status, validation_result_json,
            actor_rebind_json, actor_binding_set_hash, audience_diff_codec,
            audience_diff_a_ciphertext, audience_diff_b_ciphertext,
            audience_diff_a_commitment, audience_diff_b_commitment,
            source_snapshot_ref, server_hmac_commitment, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, 'VALID', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sourceImport.source_import_id,
          roomId,
          member.lineage_id,
          diffs.A.proposal_id,
          diffs.A.proposal_revision,
          member.origin_owner_user_id,
          sourceImport.source_save_id,
          sourceImport.client_save_instance_id,
          sourceImport.source_branch_id,
          sourceImport.source_node_id,
          sourceImport.cloud_revision,
          sourceImport.canonical_content_hash,
          sourceImport.selected_state_hash,
          sourceImport.raw_source_hash,
          sourceImport.normalized_source_hash,
          sourceImport.normalization_and_rebind_diff_hash,
          sourceImport.genesis_state_hash,
          sourceImport.privacy_normalizer_version,
          sourceImport.derived_from_export_id,
          importRequestHash,
          validationResultJson,
          bindingMatch.actor_rebind_json,
          bindingMatch.actor_binding_set_hash,
          audienceDiffCodec.codecVersion,
          ciphertext.A,
          ciphertext.B,
          sourceImport.audience_diff_commitments.A,
          sourceImport.audience_diff_commitments.B,
          sourceSnapshotRef,
          sourceImport.server_hmac_commitment,
          sourceImport.imported_at
        );
        const endEventSeq = allocateEventOnlyRevision(
          database,
          roomId,
          member.event_seq,
          1,
          sourceImport.imported_at
        );
        insertEvents(database, {
          roomId,
          epochId: null,
          endEventSeq,
          createdAt: sourceImport.imported_at,
          idFactory,
          events: [{
            audience: member.seat_id,
            event_type: 'lineage.source_import_validated',
            payload: {
              source_import_id: sourceImport.source_import_id,
              proposal_id: diffs.A.proposal_id,
              proposal_revision: diffs.A.proposal_revision,
              validation_status: 'VALID'
            }
          }]
        });
        return immutable({
          source_import_id: sourceImport.source_import_id,
          proposal_id: diffs.A.proposal_id,
          proposal_revision: diffs.A.proposal_revision,
          replayed: false
        });
      });
    },

    getForMember({ authenticated_user_id, room_id, source_import_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const sourceImportId = assertIdentifier(source_import_id, 'source_import_id');
      const stored = connection.read(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const row = database.prepare(`
          SELECT * FROM room_source_imports
           WHERE source_import_id = ? AND room_id = ?
        `).get(sourceImportId, roomId);
        if (!row) fail('SOURCE_IMPORT_NOT_FOUND', 'source import does not exist', {}, 404);
        return { row: { ...row }, member: { ...member } };
      });
      const { row, member } = stored;
      if (row.audience_diff_codec !== audienceDiffCodec.codecVersion) {
        fail('PERSISTED_LINEAGE_CORRUPT', 'audience diff codec version is unavailable');
      }
      const seat = member.seat_id;
      const diff = openAudienceDiff(
        audienceDiffCodec,
        row[`audience_diff_${seat.toLowerCase()}_ciphertext`],
        Object.freeze({
          purpose: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
          codec_version: row.audience_diff_codec,
          room_id: roomId,
          source_import_id: sourceImportId,
          proposal_id: row.proposal_id,
          proposal_revision: row.proposal_revision,
          audience: seat
        })
      );
      assertAudienceSafeImportDiff(diff, {
        expected_members_by_seat: connection.read(database => membersBySeat(
          originalMembers(database, roomId)
        )),
        origin_owner_user_id: member.origin_owner_user_id
      });
      const owner = authenticatedUserId === member.origin_owner_user_id;
      const result = {
        source_import_id: row.source_import_id,
        room_id: row.room_id,
        lineage_id: row.lineage_id,
        proposal_id: row.proposal_id,
        proposal_revision: row.proposal_revision,
        validation_status: row.validation_status,
        privacy_normalizer_version: row.privacy_normalizer_version,
        audience_diff: diff,
        audience_diff_commitment: row[`audience_diff_${seat.toLowerCase()}_commitment`],
        server_hmac_commitment: row.server_hmac_commitment,
        imported_at: row.imported_at
      };
      if (owner) {
        result.source = {
          source_save_id: row.source_save_id,
          client_save_instance_id: row.client_save_instance_id,
          source_branch_id: row.source_branch_id,
          source_node_id: row.source_node_id,
          cloud_revision: row.cloud_revision,
          derived_from_export_id: row.derived_from_export_id
        };
      }
      return immutable(result);
    }
  };

  function persistOpenProposal(database, {
    member,
    memberRows,
    proposalId,
    proposalRevision,
    proposalType,
    epochId,
    targetTurnId = null,
    targetCheckpointId = null,
    sourceImportId = null,
    expectedControlRevision,
    unsignedPayload,
    createdAt
  }) {
    const payload = immutable({
      ...unsignedPayload,
      server_hmac_commitment: proposalCommitment(proposalCommitmentSecret, unsignedPayload)
    });
    const requestHash = proposalRequestHash(payload, member.member_id);
    const existing = database.prepare(`
      SELECT * FROM room_control_proposals WHERE proposal_id = ?
    `).get(proposalId);
    if (existing) {
      assertProposalIntegrity(existing, proposalCommitmentSecret);
      if (existing.room_id !== member.room_id
        || existing.proposal_revision !== proposalRevision
        || existing.request_hash !== requestHash) {
        fail('IDEMPOTENCY_KEY_REUSED', 'proposal ID was reused with different parameters');
      }
      return Object.freeze({ row: existing, replayed: true });
    }
    if (member.control_revision !== expectedControlRevision) {
      fail('STALE_CONTROL_REVISION', 'room control revision changed before proposal creation', {
        expected: expectedControlRevision,
        actual: member.control_revision
      }, 409);
    }
    database.prepare(`
      INSERT INTO room_control_proposals (
        proposal_id, room_id, epoch_id, proposal_type, proposal_revision,
        target_turn_id, target_checkpoint_id, source_import_id,
        base_control_revision, request_hash, proposal_payload_json,
        proposed_by_member_id, accepted_by_a_at, accepted_by_a_revision,
        accepted_by_a_diff_commitment, accepted_by_b_at,
        accepted_by_b_revision, accepted_by_b_diff_commitment,
        proposal_status, created_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
        NULL, NULL, NULL, 'OPEN', ?, NULL)
    `).run(
      proposalId,
      member.room_id,
      epochId,
      proposalType,
      proposalRevision,
      targetTurnId,
      targetCheckpointId,
      sourceImportId,
      expectedControlRevision,
      requestHash,
      canonicalStringify(payload),
      member.member_id,
      createdAt
    );
    const endEventSeq = allocateEventOnlyRevision(
      database,
      member.room_id,
      member.event_seq,
      memberRows.length,
      createdAt
    );
    const ownCommitment = seat => proposalType === 'fork_from_latest_source_save'
      ? unsignedPayload.audience_diff_commitments[seat]
      : null;
    insertEvents(database, {
      roomId: member.room_id,
      epochId,
      endEventSeq,
      createdAt,
      idFactory,
      events: seatEvents('lineage.proposal_created', seat => ({
        proposal_id: proposalId,
        proposal_revision: proposalRevision,
        proposal_type: proposalType,
        target_turn_id: targetTurnId,
        target_checkpoint_id: targetCheckpointId,
        source_import_id: sourceImportId,
        viewer_audience_diff_commitment: ownCommitment(seat)
      }))
    });
    return Object.freeze({
      row: database.prepare(`
        SELECT * FROM room_control_proposals WHERE proposal_id = ?
      `).get(proposalId),
      replayed: false
    });
  }

  function replayExistingProposal(database, {
    member,
    proposalId,
    proposalRevision,
    proposalType,
    targetTurnId = null,
    targetCheckpointId = null,
    sourceImportId = null,
    expectedControlRevision
  }) {
    const existing = database.prepare(`
      SELECT * FROM room_control_proposals WHERE proposal_id = ?
    `).get(proposalId);
    if (!existing) return null;
    assertProposalIntegrity(existing, proposalCommitmentSecret);
    if (existing.room_id !== member.room_id
      || existing.proposed_by_member_id !== member.member_id
      || existing.proposal_revision !== proposalRevision
      || existing.proposal_type !== proposalType
      || existing.target_turn_id !== targetTurnId
      || existing.target_checkpoint_id !== targetCheckpointId
      || existing.source_import_id !== sourceImportId
      || existing.base_control_revision !== expectedControlRevision) {
      fail('IDEMPOTENCY_KEY_REUSED', 'proposal ID was reused with different parameters');
    }
    return immutable({
      proposal: proposalProjection(existing, member.seat_id, proposalCommitmentSecret),
      replayed: true
    });
  }

  const proposals = {
    async createTurnVoid({
      authenticated_user_id,
      room_id,
      epoch_id,
      turn_id,
      proposal_id,
      proposal_revision,
      expected_control_revision
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const turnId = assertIdentifier(turn_id, 'turn_id');
      const proposalId = assertIdentifier(proposal_id, 'proposal_id');
      const proposalRevision = assertRevision(proposal_revision, 'proposal_revision', { min: 1 });
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const createdAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const memberRows = originalMembers(database, roomId);
        const replay = replayExistingProposal(database, {
          member,
          proposalId,
          proposalRevision,
          proposalType: 'void_turn',
          targetTurnId: turnId,
          expectedControlRevision
        });
        if (replay) return replay;
        if (member.lifecycle === 'ARCHIVED'
          || member.active_epoch_id !== epochId
          || member.current_turn_id !== turnId) {
          fail('TURN_NOT_FOUND', 'void proposal must target the active room turn', {}, 404);
        }
        const turn = database.prepare(`
          SELECT turn_status FROM multiplayer_turns
           WHERE turn_id = ? AND room_id = ? AND epoch_id = ?
        `).get(turnId, roomId, epochId);
        if (!turn) fail('TURN_NOT_FOUND', 'void proposal target does not exist', {}, 404);
        if (!VOIDABLE_TURN_STATUSES.has(turn.turn_status)) {
          fail('TURN_VOID_NOT_ALLOWED', 'turn cannot be voided from its current state', {
            turn_status: turn.turn_status
          }, 409);
        }
        const unsignedPayload = {
          schema: 'naruto.multiplayer-void-turn-proposal/v1',
          proposal_id: proposalId,
          proposal_revision: proposalRevision,
          room_id: roomId,
          epoch_id: epochId,
          turn_id: turnId,
          expected_control_revision: expectedControlRevision
        };
        const result = persistOpenProposal(database, {
          member,
          memberRows,
          proposalId,
          proposalRevision,
          proposalType: 'void_turn',
          epochId,
          targetTurnId: turnId,
          expectedControlRevision,
          unsignedPayload,
          createdAt
        });
        return immutable({
          proposal: proposalProjection(
            result.row,
            member.seat_id,
            proposalCommitmentSecret
          ),
          replayed: result.replayed
        });
      });
    },

    async createArchive({
      authenticated_user_id,
      room_id,
      proposal_id,
      proposal_revision,
      checkpoint_id,
      expected_control_revision
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const proposalId = assertIdentifier(proposal_id, 'proposal_id');
      const proposalRevision = assertRevision(proposal_revision, 'proposal_revision', { min: 1 });
      const checkpointId = assertIdentifier(checkpoint_id, 'checkpoint_id');
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const createdAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const memberRows = originalMembers(database, roomId);
        const replay = replayExistingProposal(database, {
          member,
          proposalId,
          proposalRevision,
          proposalType: 'archive_room',
          targetCheckpointId: checkpointId,
          expectedControlRevision
        });
        if (replay) return replay;
        if (member.lifecycle === 'ARCHIVED' || member.active_epoch_id === null) {
          fail('ROOM_NOT_AT_CHECKPOINT', 'room is already archived');
        }
        const epoch = database.prepare(`
          SELECT * FROM room_epochs
           WHERE room_id = ? AND epoch_id = ? AND epoch_state = 'ACTIVE'
        `).get(roomId, member.active_epoch_id);
        if (!epoch || epoch.head_checkpoint_id !== checkpointId) {
          fail('ROOM_NOT_AT_CHECKPOINT', 'archive must target the active epoch head checkpoint');
        }
        const unsignedPayload = {
          schema: 'naruto.multiplayer-archive-room-proposal/v1',
          proposal_id: proposalId,
          proposal_revision: proposalRevision,
          room_id: roomId,
          lineage_id: member.lineage_id,
          checkpoint_id: checkpointId,
          expected_control_revision: expectedControlRevision
        };
        const result = persistOpenProposal(database, {
          member,
          memberRows,
          proposalId,
          proposalRevision,
          proposalType: 'archive_room',
          epochId: epoch.epoch_id,
          targetCheckpointId: checkpointId,
          expectedControlRevision,
          unsignedPayload,
          createdAt
        });
        return immutable({
          proposal: proposalProjection(
            result.row,
            member.seat_id,
            proposalCommitmentSecret
          ),
          replayed: result.replayed
        });
      });
    },

    async createCheckpointResume({
      authenticated_user_id,
      room_id,
      proposal_id,
      proposal_revision,
      checkpoint_id,
      expected_control_revision
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const proposalId = assertIdentifier(proposal_id, 'proposal_id');
      const proposalRevision = assertRevision(proposal_revision, 'proposal_revision', { min: 1 });
      const checkpointId = assertIdentifier(checkpoint_id, 'checkpoint_id');
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const createdAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const memberRows = originalMembers(database, roomId);
        const replay = replayExistingProposal(database, {
          member,
          proposalId,
          proposalRevision,
          proposalType: 'resume_room_checkpoint',
          targetCheckpointId: checkpointId,
          expectedControlRevision
        });
        if (replay) return replay;
        if (member.lifecycle !== 'ARCHIVED' || member.active_epoch_id !== null) {
          fail('ROOM_NOT_AT_CHECKPOINT', 'checkpoint resume requires an archived room');
        }
        const checkpointRow = database.prepare(`
          SELECT * FROM room_checkpoints
           WHERE room_id = ? AND checkpoint_id = ?
        `).get(roomId, checkpointId);
        if (!checkpointRow) {
          fail('CHECKPOINT_NOT_COMMITTED', 'resume checkpoint does not belong to this room');
        }
        const latestEpoch = database.prepare(`
          SELECT * FROM room_epochs WHERE room_id = ? ORDER BY epoch_no DESC LIMIT 1
        `).get(roomId);
        const unsignedPayload = {
          schema: RESUME_ROOM_CHECKPOINT_SCHEMA,
          continuation_mode: 'resume_room_checkpoint',
          proposal_id: proposalId,
          proposal_revision: proposalRevision,
          room_id: roomId,
          lineage_id: member.lineage_id,
          checkpoint_id: checkpointId,
          base_checkpoint_state_hash: checkpointRow.state_hash,
          expected_control_revision: expectedControlRevision
        };
        const result = persistOpenProposal(database, {
          member,
          memberRows,
          proposalId,
          proposalRevision,
          proposalType: 'resume_room_checkpoint',
          epochId: latestEpoch.epoch_id,
          targetCheckpointId: checkpointId,
          expectedControlRevision,
          unsignedPayload,
          createdAt
        });
        return immutable({
          proposal: proposalProjection(
            result.row,
            member.seat_id,
            proposalCommitmentSecret
          ),
          replayed: result.replayed
        });
      });
    },

    async createLatestSource({
      authenticated_user_id,
      room_id,
      proposal_id,
      proposal_revision,
      source_import_id,
      expected_control_revision
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const proposalId = assertIdentifier(proposal_id, 'proposal_id');
      const proposalRevision = assertRevision(proposal_revision, 'proposal_revision', { min: 1 });
      const sourceImportId = assertIdentifier(source_import_id, 'source_import_id');
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const createdAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const memberRows = originalMembers(database, roomId);
        if (member.origin_type !== 'existing_save_derived') {
          fail(
            'CONTINUATION_MODE_NOT_ALLOWED',
            'new_multiplayer_save cannot fork from a latest source save'
          );
        }
        if (authenticatedUserId !== member.origin_owner_user_id) {
          fail('SOURCE_OWNER_REQUIRED', 'only the immutable origin owner may propose latest source');
        }
        const replay = replayExistingProposal(database, {
          member,
          proposalId,
          proposalRevision,
          proposalType: 'fork_from_latest_source_save',
          sourceImportId,
          expectedControlRevision
        });
        if (replay) return replay;
        if (member.lifecycle !== 'ARCHIVED' || member.active_epoch_id !== null) {
          fail('ROOM_NOT_AT_CHECKPOINT', 'latest source continuation requires an archived room');
        }
        const sourceRow = database.prepare(`
          SELECT * FROM room_source_imports
           WHERE room_id = ? AND source_import_id = ? AND validation_status = 'VALID'
        `).get(roomId, sourceImportId);
        if (!sourceRow
          || sourceRow.lineage_id !== member.lineage_id
          || sourceRow.origin_owner_user_id !== member.origin_owner_user_id
          || sourceRow.proposal_id !== proposalId
          || sourceRow.proposal_revision !== proposalRevision
          || sourceRow.actor_binding_set_hash === null) {
          fail('SOURCE_IMPORT_CHANGED', 'validated source import does not match this proposal revision');
        }
        const latestEpoch = database.prepare(`
          SELECT * FROM room_epochs WHERE room_id = ? ORDER BY epoch_no DESC LIMIT 1
        `).get(roomId);
        const unsignedPayload = {
          schema: FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA,
          continuation_mode: 'fork_from_latest_source_save',
          proposal_id: proposalId,
          proposal_revision: proposalRevision,
          room_id: roomId,
          lineage_id: member.lineage_id,
          source_import_id: sourceImportId,
          origin_owner_user_id: member.origin_owner_user_id,
          expected_control_revision: expectedControlRevision,
          audience_diff_commitments: {
            A: sourceRow.audience_diff_a_commitment,
            B: sourceRow.audience_diff_b_commitment
          }
        };
        const result = persistOpenProposal(database, {
          member,
          memberRows,
          proposalId,
          proposalRevision,
          proposalType: 'fork_from_latest_source_save',
          epochId: latestEpoch.epoch_id,
          sourceImportId,
          expectedControlRevision,
          unsignedPayload,
          createdAt
        });
        return immutable({
          proposal: proposalProjection(
            result.row,
            member.seat_id,
            proposalCommitmentSecret
          ),
          replayed: result.replayed
        });
      });
    },

    getForMember({ authenticated_user_id, room_id, proposal_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const proposalId = assertIdentifier(proposal_id, 'proposal_id');
      return connection.read(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const row = database.prepare(`
          SELECT * FROM room_control_proposals
           WHERE room_id = ? AND proposal_id = ?
        `).get(roomId, proposalId);
        if (!row) fail('PROPOSAL_NOT_FOUND', 'lineage proposal does not exist', {}, 404);
        return proposalProjection(row, member.seat_id, proposalCommitmentSecret);
      });
    },

    async accept({
      authenticated_user_id,
      room_id,
      proposal_id,
      proposal_revision,
      expected_control_revision,
      audience_diff_commitment = null
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const proposalId = assertIdentifier(proposal_id, 'proposal_id');
      const proposalRevision = assertRevision(proposal_revision, 'proposal_revision', { min: 1 });
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const acceptedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        originalMembers(database, roomId);
        const row = database.prepare(`
          SELECT * FROM room_control_proposals
           WHERE room_id = ? AND proposal_id = ?
        `).get(roomId, proposalId);
        if (!row) fail('PROPOSAL_NOT_FOUND', 'lineage proposal does not exist', {}, 404);
        const payload = assertProposalIntegrity(row, proposalCommitmentSecret);
        if (row.proposal_revision !== proposalRevision) {
          fail('STALE_PROPOSAL_REVISION', 'member attempted to accept another proposal revision');
        }
        const prefix = member.seat_id === 'A' ? 'accepted_by_a' : 'accepted_by_b';
        const storedCommitment = row[`${prefix}_diff_commitment`];
        const expectedDiffCommitment = row.proposal_type === 'fork_from_latest_source_save'
          ? payload.audience_diff_commitments[member.seat_id]
          : null;
        if ((audience_diff_commitment ?? null) !== expectedDiffCommitment) {
          fail('SOURCE_IMPORT_CHANGED', 'member accepted a different audience-safe diff commitment');
        }
        if (row[`${prefix}_at`] !== null) {
          if (member.control_revision !== expectedControlRevision
            || row.base_control_revision !== expectedControlRevision) {
            fail('STALE_CONTROL_REVISION', 'proposal acceptance replay uses another control revision', {
              expected: expectedControlRevision,
              actual: member.control_revision
            }, 409);
          }
          if (row[`${prefix}_revision`] !== proposalRevision
            || storedCommitment !== expectedDiffCommitment) {
            fail('SOURCE_IMPORT_CHANGED', 'stored member acceptance no longer matches');
          }
          return immutable({
            proposal: proposalProjection(row, member.seat_id, proposalCommitmentSecret),
            replayed: true
          });
        }
        if (row.proposal_status === 'APPLIED' || row.proposal_status === 'CANCELLED') {
          fail('PROPOSAL_NOT_OPEN', 'lineage proposal no longer accepts decisions');
        }
        if (member.control_revision !== expectedControlRevision
          || row.base_control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed before proposal acceptance', {
            expected: expectedControlRevision,
            actual: member.control_revision
          }, 409);
        }
        const otherAccepted = member.seat_id === 'A'
          ? row.accepted_by_b_at !== null
          : row.accepted_by_a_at !== null;
        const nextStatus = otherAccepted ? 'ACCEPTED' : 'OPEN';
        const seatColumn = member.seat_id.toLowerCase();
        const changed = database.prepare(`
          UPDATE room_control_proposals
             SET accepted_by_${seatColumn}_at = ?,
                 accepted_by_${seatColumn}_revision = ?,
                 accepted_by_${seatColumn}_diff_commitment = ?,
                 proposal_status = ?
           WHERE proposal_id = ? AND room_id = ? AND proposal_revision = ?
             AND accepted_by_${seatColumn}_at IS NULL
             AND proposal_status IN ('OPEN', 'ACCEPTED')
        `).run(
          acceptedAt,
          proposalRevision,
          expectedDiffCommitment,
          nextStatus,
          proposalId,
          roomId,
          proposalRevision
        );
        if (changed.changes !== 1) {
          fail('PROPOSAL_ACCEPTANCE_CAS_FAILED', 'proposal acceptance changed concurrently');
        }
        const endEventSeq = allocateEventOnlyRevision(
          database,
          roomId,
          member.event_seq,
          2,
          acceptedAt
        );
        insertEvents(database, {
          roomId,
          epochId: row.epoch_id,
          endEventSeq,
          createdAt: acceptedAt,
          idFactory,
          events: seatEvents('lineage.proposal_acceptance_changed', viewerSeat => ({
            proposal_id: proposalId,
            proposal_revision: proposalRevision,
            accepted_seat: member.seat_id,
            viewer_seat: viewerSeat,
            proposal_status: nextStatus
          }))
        });
        const current = database.prepare(`
          SELECT * FROM room_control_proposals WHERE proposal_id = ?
        `).get(proposalId);
        return immutable({
          proposal: proposalProjection(current, member.seat_id, proposalCommitmentSecret),
          replayed: false
        });
      });
    },

    async applyArchive({
      authenticated_user_id,
      room_id,
      proposal_id,
      proposal_revision,
      expected_control_revision
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const proposalId = assertIdentifier(proposal_id, 'proposal_id');
      const proposalRevision = assertRevision(proposal_revision, 'proposal_revision', { min: 1 });
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const archivedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        originalMembers(database, roomId);
        const proposal = database.prepare(`
          SELECT * FROM room_control_proposals
           WHERE room_id = ? AND proposal_id = ?
        `).get(roomId, proposalId);
        if (!proposal) fail('PROPOSAL_NOT_FOUND', 'archive proposal does not exist', {}, 404);
        assertProposalIntegrity(proposal, proposalCommitmentSecret);
        if (proposal.proposal_type !== 'archive_room'
          || proposal.proposal_revision !== proposalRevision) {
          fail('STALE_PROPOSAL_REVISION', 'archive proposal revision does not match');
        }
        if (proposal.proposal_status === 'APPLIED') {
          if (proposal.base_control_revision !== expectedControlRevision) {
            fail('STALE_CONTROL_REVISION', 'archive replay uses another base control revision', {
              expected: expectedControlRevision,
              actual: proposal.base_control_revision
            }, 409);
          }
          const archivedEpoch = database.prepare(`
            SELECT epoch_id, head_checkpoint_id, control_revision, archived_at
              FROM room_epochs WHERE epoch_id = ? AND room_id = ?
          `).get(proposal.epoch_id, roomId);
          if (!archivedEpoch
            || archivedEpoch.archived_at === null
            || archivedEpoch.control_revision !== expectedControlRevision + 1) {
            fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'applied archive has no matching archived epoch');
          }
          return immutable({
            room_id: roomId,
            archived_epoch_id: archivedEpoch.epoch_id,
            archived_checkpoint_id: archivedEpoch.head_checkpoint_id,
            control_revision: archivedEpoch.control_revision,
            archived_at: archivedEpoch.archived_at,
            replayed: true
          });
        }
        if (proposal.proposal_status !== 'ACCEPTED'
          || proposal.accepted_by_a_revision !== proposalRevision
          || proposal.accepted_by_b_revision !== proposalRevision) {
          fail('PROPOSAL_NOT_ACCEPTED', 'both original members must accept this archive revision');
        }
        if (member.lifecycle === 'ARCHIVED' || member.active_epoch_id !== proposal.epoch_id) {
          fail('ROOM_NOT_AT_CHECKPOINT', 'room no longer has the proposed active epoch');
        }
        if (member.control_revision !== expectedControlRevision
          || proposal.base_control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'archive control revision changed', {
            expected: expectedControlRevision,
            actual: member.control_revision
          }, 409);
        }
        const epoch = database.prepare(`
          SELECT * FROM room_epochs
           WHERE room_id = ? AND epoch_id = ? AND epoch_state = 'ACTIVE'
        `).get(roomId, proposal.epoch_id);
        if (!epoch || epoch.head_checkpoint_id !== proposal.target_checkpoint_id) {
          fail('ROOM_NOT_AT_CHECKPOINT', 'archive target is no longer the active epoch head');
        }
        if (member.current_turn_id !== null) {
          const turn = database.prepare(`
            SELECT turn_status FROM multiplayer_turns WHERE turn_id = ? AND room_id = ?
          `).get(member.current_turn_id, roomId);
          if (!turn) {
            fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'room current turn reference is missing');
          }
          const terminal = new Set(['COMMITTED', 'TURN_VOIDED', 'CONSISTENCY_FAULT']);
          if (!terminal.has(turn.turn_status)) {
            const actionCount = database.prepare(`
              SELECT COUNT(*) AS count FROM action_submissions WHERE turn_id = ?
            `).get(member.current_turn_id).count;
            const canDiscardUnstarted = actionCount === 0
              && ['AWAITING_PAYER_SELECTION', 'COLLECTING_ACTIONS'].includes(turn.turn_status);
            if (!canDiscardUnstarted) {
              fail(
                'ROOM_NOT_AT_CHECKPOINT',
                'locked actions or an active generation block archive at this checkpoint'
              );
            }
            const voided = database.prepare(`
              UPDATE multiplayer_turns
                 SET turn_status = 'TURN_VOIDED', voided_at = ?, updated_at = ?
               WHERE turn_id = ? AND turn_status = ?
            `).run(archivedAt, archivedAt, member.current_turn_id, turn.turn_status);
            if (voided.changes !== 1) {
              fail('ROOM_NOT_AT_CHECKPOINT', 'unstarted turn changed while archiving');
            }
          }
        }
        const nextControlRevision = member.control_revision + 1;
        const roomUpdate = database.prepare(`
          UPDATE multiplayer_rooms
             SET lifecycle = 'ARCHIVED', active_epoch_id = NULL,
                 current_turn_id = NULL, control_revision = ?,
                 event_seq = event_seq + 2, updated_at = ?, archived_at = ?
           WHERE room_id = ? AND active_epoch_id = ?
             AND control_revision = ? AND lifecycle != 'ARCHIVED'
          RETURNING event_seq
        `).get(
          nextControlRevision,
          archivedAt,
          archivedAt,
          roomId,
          epoch.epoch_id,
          expectedControlRevision
        );
        if (!roomUpdate) fail('STALE_CONTROL_REVISION', 'archive room CAS failed');
        const epochUpdate = database.prepare(`
          UPDATE room_epochs
             SET epoch_state = 'ARCHIVED', control_revision = ?, archived_at = ?
           WHERE epoch_id = ? AND room_id = ? AND epoch_state = 'ACTIVE'
             AND head_checkpoint_id = ?
        `).run(
          nextControlRevision,
          archivedAt,
          epoch.epoch_id,
          roomId,
          proposal.target_checkpoint_id
        );
        if (epochUpdate.changes !== 1) fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'epoch archive CAS failed');
        const proposalUpdate = database.prepare(`
          UPDATE room_control_proposals
             SET proposal_status = 'APPLIED', applied_at = ?
           WHERE proposal_id = ? AND proposal_status = 'ACCEPTED'
        `).run(archivedAt, proposalId);
        if (proposalUpdate.changes !== 1) fail('PROPOSAL_ACCEPTANCE_CAS_FAILED', 'archive proposal changed');
        insertEvents(database, {
          roomId,
          epochId: epoch.epoch_id,
          endEventSeq: roomUpdate.event_seq,
          createdAt: archivedAt,
          idFactory,
          events: seatEvents('lineage.room_archived', seat => ({
            room_id: roomId,
            viewer_seat: seat,
            archived_epoch_id: epoch.epoch_id,
            archived_checkpoint_id: proposal.target_checkpoint_id,
            control_revision: nextControlRevision
          }))
        });
        return immutable({
          room_id: roomId,
          archived_epoch_id: epoch.epoch_id,
          archived_checkpoint_id: proposal.target_checkpoint_id,
          control_revision: nextControlRevision,
          archived_at: archivedAt,
          replayed: false
        });
      });
    },

    async applyTurnVoid({
      authenticated_user_id,
      room_id,
      proposal_id,
      proposal_revision,
      expected_control_revision
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const proposalId = assertIdentifier(proposal_id, 'proposal_id');
      const proposalRevision = assertRevision(proposal_revision, 'proposal_revision', { min: 1 });
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const changedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        originalMembers(database, roomId);
        const proposal = database.prepare(`
          SELECT * FROM room_control_proposals
           WHERE room_id = ? AND proposal_id = ?
        `).get(roomId, proposalId);
        if (!proposal) fail('PROPOSAL_NOT_FOUND', 'void proposal does not exist', {}, 404);
        assertProposalIntegrity(proposal, proposalCommitmentSecret);
        if (proposal.proposal_type !== 'void_turn'
          || proposal.proposal_revision !== proposalRevision) {
          fail('STALE_PROPOSAL_REVISION', 'void proposal revision does not match');
        }
        if (proposal.base_control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'void proposal uses another base control revision', {
            expected: expectedControlRevision,
            actual: proposal.base_control_revision
          }, 409);
        }
        const turn = database.prepare(`
          SELECT * FROM multiplayer_turns
           WHERE turn_id = ? AND room_id = ? AND epoch_id = ?
        `).get(proposal.target_turn_id, roomId, proposal.epoch_id);
        if (!turn) fail('TURN_NOT_FOUND', 'void proposal target no longer exists', {}, 404);

        const unresolved = () => Boolean(database.prepare(`
          SELECT 1 AS present
            FROM resolution_runs
           WHERE turn_id = ? AND run_status IN ('CLAIMED', 'RUNNING')
          UNION ALL
          SELECT 1 AS present
            FROM ai_usage_ledger
           WHERE turn_id = ? AND usage_status IN ('IN_FLIGHT', 'UNKNOWN')
          LIMIT 1
        `).get(turn.turn_id, turn.turn_id));

        const publishState = ({ nextStatus, markApplied, replayed }) => {
          const currentMember = requireMember(database, roomId, authenticatedUserId);
          if (currentMember.lifecycle === 'ARCHIVED'
            || currentMember.active_epoch_id !== proposal.epoch_id
            || currentMember.current_turn_id !== turn.turn_id) {
            fail('TURN_NOT_FOUND', 'void target is no longer the active room turn', {}, 404);
          }
          const nextControlRevision = currentMember.control_revision + 1;
          const turnUpdate = database.prepare(`
            UPDATE multiplayer_turns
               SET turn_status = ?, voided_at = ?, updated_at = ?
             WHERE turn_id = ? AND turn_status = ?
          `).run(
            nextStatus,
            nextStatus === 'TURN_VOIDED' ? changedAt : null,
            changedAt,
            turn.turn_id,
            turn.turn_status
          );
          if (turnUpdate.changes !== 1) {
            fail('TURN_VOID_CAS_FAILED', 'turn changed before the void safe boundary', {}, 409);
          }
          database.prepare(`
            UPDATE resolution_runs
               SET run_status = 'ABANDONED', owner_boot_id = NULL,
                   owner_task_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
                   lease_expires_at = NULL, updated_at = ?
             WHERE turn_id = ? AND run_status IN ('QUEUED', 'PAUSED', 'FAILED')
          `).run(changedAt, turn.turn_id);
          if (nextStatus === 'TURN_VOIDED') {
            database.prepare(`
              UPDATE turn_drafts SET draft_status = 'DISCARDED', updated_at = ?
               WHERE turn_id = ? AND draft_status != 'DISCARDED'
            `).run(changedAt, turn.turn_id);
            database.prepare(`
              UPDATE agent_stage_sessions SET session_status = 'FAILED', updated_at = ?
               WHERE run_id IN (SELECT run_id FROM resolution_runs WHERE turn_id = ?)
                 AND session_status != 'FAILED'
            `).run(changedAt, turn.turn_id);
          }
          const roomUpdate = database.prepare(`
            UPDATE multiplayer_rooms
               SET control_revision = ?, event_seq = event_seq + 2, updated_at = ?
             WHERE room_id = ? AND active_epoch_id = ? AND current_turn_id = ?
               AND control_revision = ? AND lifecycle != 'ARCHIVED'
            RETURNING event_seq
          `).get(
            nextControlRevision,
            changedAt,
            roomId,
            proposal.epoch_id,
            turn.turn_id,
            currentMember.control_revision
          );
          if (!roomUpdate) fail('TURN_VOID_CAS_FAILED', 'room changed while voiding turn', {}, 409);
          const epochUpdate = database.prepare(`
            UPDATE room_epochs SET control_revision = ?
             WHERE epoch_id = ? AND room_id = ? AND epoch_state = 'ACTIVE'
          `).run(nextControlRevision, proposal.epoch_id, roomId);
          if (epochUpdate.changes !== 1) {
            fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'active epoch control revision did not advance');
          }
          if (markApplied) {
            const proposalUpdate = database.prepare(`
              UPDATE room_control_proposals
                 SET proposal_status = 'APPLIED', applied_at = ?
               WHERE proposal_id = ? AND proposal_revision = ?
                 AND proposal_status = 'ACCEPTED'
            `).run(changedAt, proposalId, proposalRevision);
            if (proposalUpdate.changes !== 1) {
              fail('PROPOSAL_ACCEPTANCE_CAS_FAILED', 'void proposal changed before application');
            }
          }
          insertEvents(database, {
            roomId,
            epochId: proposal.epoch_id,
            endEventSeq: roomUpdate.event_seq,
            createdAt: changedAt,
            idFactory,
            events: seatEvents(
              nextStatus === 'TURN_VOIDED' ? 'turn.voided' : 'turn.void_requested',
              seat => ({
                turn_id: turn.turn_id,
                turn_no: turn.turn_no,
                viewer_seat: seat,
                status: nextStatus,
                control_revision: nextControlRevision
              })
            )
          });
          return immutable({
            room_id: roomId,
            epoch_id: proposal.epoch_id,
            turn_id: turn.turn_id,
            turn_no: turn.turn_no,
            turn_status: nextStatus,
            control_revision: nextControlRevision,
            replayed
          });
        };

        if (proposal.proposal_status === 'APPLIED') {
          if (turn.turn_status === 'TURN_VOIDED') {
            return immutable({
              room_id: roomId,
              epoch_id: proposal.epoch_id,
              turn_id: turn.turn_id,
              turn_no: turn.turn_no,
              turn_status: turn.turn_status,
              control_revision: member.control_revision,
              replayed: true
            });
          }
          if (turn.turn_status !== 'VOID_REQUESTED') {
            fail('PERSISTED_LINEAGE_CORRUPT', 'applied void proposal has an invalid turn state');
          }
          if (unresolved()) {
            return immutable({
              room_id: roomId,
              epoch_id: proposal.epoch_id,
              turn_id: turn.turn_id,
              turn_no: turn.turn_no,
              turn_status: 'VOID_REQUESTED',
              control_revision: member.control_revision,
              replayed: true
            });
          }
          return publishState({
            nextStatus: 'TURN_VOIDED',
            markApplied: false,
            replayed: false
          });
        }
        if (proposal.proposal_status !== 'ACCEPTED'
          || proposal.accepted_by_a_revision !== proposalRevision
          || proposal.accepted_by_b_revision !== proposalRevision) {
          fail('PROPOSAL_NOT_ACCEPTED', 'both members must accept this void revision');
        }
        if (member.lifecycle === 'ARCHIVED'
          || member.active_epoch_id !== proposal.epoch_id
          || member.current_turn_id !== turn.turn_id
          || member.control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'void target changed before application', {
            expected: expectedControlRevision,
            actual: member.control_revision
          }, 409);
        }
        if (!VOIDABLE_TURN_STATUSES.has(turn.turn_status)) {
          if (['COMMITTING', 'RECOVERING_COMMIT'].includes(turn.turn_status)) {
            fail(
              'TURN_VOID_COMMIT_RECOVERY_REQUIRED',
              'commit outcome must be recovered before this turn can be voided',
              { turn_status: turn.turn_status },
              409
            );
          }
          fail('TURN_VOID_NOT_ALLOWED', 'turn cannot be voided from its current state', {
            turn_status: turn.turn_status
          }, 409);
        }
        return publishState({
          nextStatus: unresolved() ? 'VOID_REQUESTED' : 'TURN_VOIDED',
          markApplied: true,
          replayed: false
        });
      });
    }
  };

  function storedAcceptancePair(proposal, memberRows, diffRequired) {
    const users = membersBySeat(memberRows);
    const acceptance = {};
    for (const seat of ROOM_SEATS) {
      const prefix = seat === 'A' ? 'accepted_by_a' : 'accepted_by_b';
      if (proposal[`${prefix}_at`] === null
        || proposal[`${prefix}_revision`] !== proposal.proposal_revision) {
        fail('PROPOSAL_NOT_ACCEPTED', 'both original members must accept the same proposal revision');
      }
      acceptance[seat] = {
        accepted_by_user_id: users[seat],
        accepted_at: proposal[`${prefix}_at`],
        audience_diff_commitment: diffRequired
          ? proposal[`${prefix}_diff_commitment`]
          : null
      };
    }
    return acceptance;
  }

  function validatePersistedActorRebind(database, sourceRow) {
    if (sourceRow.actor_rebind_json === null || sourceRow.actor_binding_set_hash === null) {
      fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'source import has no validated actor rebind');
    }
    const actorRebind = parseCanonicalJson(sourceRow.actor_rebind_json, 'actor rebind');
    if (hashCanonical(actorRebind) !== sourceRow.actor_binding_set_hash
      || actorRebind.schema !== 'naruto.multiplayer-persisted-actor-rebind/v1'
      || !Array.isArray(actorRebind.entries)
      || actorRebind.entries.length !== 2) {
      fail('PERSISTED_LINEAGE_CORRUPT', 'source actor rebind commitment is invalid');
    }
    const rows = database.prepare(`
      SELECT binding_id, room_actor_id, original_seat_id, signature_version
        FROM room_actor_bindings WHERE room_id = ?
    `).all(sourceRow.room_id);
    const rowBySeat = Object.fromEntries(rows.map(row => [row.original_seat_id, row]));
    const sourceEntities = new Set();
    for (const entry of actorRebind.entries) {
      const binding = rowBySeat[entry.original_seat];
      if (!binding
        || binding.binding_id !== entry.binding_id
        || binding.room_actor_id !== entry.room_actor_id
        || binding.signature_version !== entry.signature_version
        || sourceEntities.has(entry.source_entity_id)) {
        fail('RETURN_ACTOR_BINDING_INVALID', 'validated actor rebind no longer matches Room bindings');
      }
      sourceEntities.add(entry.source_entity_id);
    }
    if (rows.length !== 2 || sourceEntities.size !== 2) {
      fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'actor rebind is not a complete two-actor bijection');
    }
    return actorRebind;
  }

  proposals.activateContinuation = async ({
    authenticated_user_id,
    room_id,
    proposal_id,
    proposal_revision,
    expected_control_revision,
    new_epoch_id,
    new_genesis_checkpoint_id,
    snapshot: snapshotValue
  }) => {
    const authenticatedUserId = assertPrincipal(authenticated_user_id);
    const roomId = assertIdentifier(room_id, 'room_id');
    const proposalId = assertIdentifier(proposal_id, 'proposal_id');
    const proposalRevision = assertRevision(proposal_revision, 'proposal_revision', { min: 1 });
    const expectedControlRevision = assertRevision(
      expected_control_revision,
      'expected_control_revision'
    );
    const newEpochId = assertIdentifier(new_epoch_id, 'new_epoch_id');
    const newGenesisCheckpointId = assertIdentifier(
      new_genesis_checkpoint_id,
      'new_genesis_checkpoint_id'
    );
    const snapshot = normalizeSnapshotEnvelope(snapshotValue);
    const activatedAt = now();
    return connection.write(database => {
      const member = requireMember(database, roomId, authenticatedUserId);
      const memberRows = originalMembers(database, roomId);
      const expectedMembersBySeat = membersBySeat(memberRows);
      const proposal = database.prepare(`
        SELECT * FROM room_control_proposals
         WHERE room_id = ? AND proposal_id = ?
      `).get(roomId, proposalId);
      if (!proposal) fail('PROPOSAL_NOT_FOUND', 'continuation proposal does not exist', {}, 404);
      const payload = assertProposalIntegrity(proposal, proposalCommitmentSecret);
      if (!['resume_room_checkpoint', 'fork_from_latest_source_save'].includes(
        proposal.proposal_type
      ) || proposal.proposal_revision !== proposalRevision) {
        fail('STALE_PROPOSAL_REVISION', 'continuation proposal revision does not match');
      }
      if (proposal.proposal_status === 'APPLIED') {
        const existingEpoch = database.prepare(`
          SELECT * FROM room_epochs WHERE created_from_proposal_id = ?
        `).get(proposalId);
        const existingCheckpoint = existingEpoch
          ? database.prepare(`SELECT * FROM room_checkpoints WHERE checkpoint_id = ?`)
            .get(existingEpoch.genesis_checkpoint_id)
          : null;
        const existingSnapshot = existingCheckpoint
          ? database.prepare(`SELECT * FROM room_snapshots WHERE snapshot_id = ?`)
            .get(existingCheckpoint.snapshot_ref)
          : null;
        if (!existingEpoch || !existingCheckpoint || !existingSnapshot) {
          fail('PERSISTED_LINEAGE_CORRUPT', 'applied continuation has no epoch/genesis snapshot');
        }
        if (proposal.base_control_revision !== expectedControlRevision
          || existingEpoch.epoch_id !== newEpochId
          || existingCheckpoint.checkpoint_id !== newGenesisCheckpointId
          || existingCheckpoint.snapshot_ref !== snapshot.snapshot_id
          || existingCheckpoint.state_hash !== snapshot.state_hash
          || existingSnapshot.state_hash !== snapshot.state_hash
          || existingSnapshot.master_key_version !== snapshot.master_key_version
          || !equalBytes(existingSnapshot.snapshot_ciphertext, snapshot.snapshot_ciphertext)
          || !equalBytes(existingSnapshot.wrapped_data_key, snapshot.wrapped_data_key)
          || !equalBytes(existingSnapshot.nonce, snapshot.nonce)
          || !equalBytes(existingSnapshot.auth_tag, snapshot.auth_tag)) {
          fail('IDEMPOTENCY_KEY_REUSED', 'applied proposal was replayed with different epoch output');
        }
        return immutable({
          epoch: epochContract(existingEpoch),
          genesis_checkpoint: checkpointContract(existingCheckpoint),
          control_revision: existingEpoch.control_revision,
          replayed: true
        });
      }
      if (proposal.proposal_status !== 'ACCEPTED') {
        fail('PROPOSAL_NOT_ACCEPTED', 'continuation requires both member acceptances');
      }
      if (member.lifecycle !== 'ARCHIVED'
        || member.active_epoch_id !== null
        || member.current_turn_id !== null) {
        fail('EPOCH_ALREADY_ACTIVE', 'room is no longer archived without an active epoch');
      }
      if (member.control_revision !== expectedControlRevision
        || proposal.base_control_revision !== expectedControlRevision) {
        fail('STALE_CONTROL_REVISION', 'continuation control revision changed', {
          expected: expectedControlRevision,
          actual: member.control_revision
        }, 409);
      }
      let baseType;
      let baseRefId;
      let expectedStateHash;
      if (proposal.proposal_type === 'resume_room_checkpoint') {
        const sourceCheckpointRow = database.prepare(`
          SELECT * FROM room_checkpoints
           WHERE room_id = ? AND checkpoint_id = ?
        `).get(roomId, proposal.target_checkpoint_id);
        if (!sourceCheckpointRow) {
          fail('CHECKPOINT_NOT_COMMITTED', 'resume source checkpoint disappeared');
        }
        const fullProposal = {
          ...payload,
          member_acceptances: storedAcceptancePair(proposal, memberRows, false)
        };
        assertResumeRoomCheckpoint(fullProposal, {
          room_archived: true,
          expected_members_by_seat: expectedMembersBySeat,
          checkpoint: checkpointContract(sourceCheckpointRow)
        });
        baseType = 'room_checkpoint';
        baseRefId = sourceCheckpointRow.checkpoint_id;
        expectedStateHash = sourceCheckpointRow.state_hash;
      } else {
        if (member.origin_type !== 'existing_save_derived') {
          fail(
            'CONTINUATION_MODE_NOT_ALLOWED',
            'new_multiplayer_save cannot fork from a latest source save'
          );
        }
        const sourceRow = database.prepare(`
          SELECT * FROM room_source_imports
           WHERE room_id = ? AND source_import_id = ? AND validation_status = 'VALID'
        `).get(roomId, proposal.source_import_id);
        if (!sourceRow
          || sourceRow.proposal_id !== proposalId
          || sourceRow.proposal_revision !== proposalRevision
          || sourceRow.origin_owner_user_id !== member.origin_owner_user_id) {
          fail('SOURCE_IMPORT_CHANGED', 'accepted source import changed before activation');
        }
        const sourceImport = sourceImportContract(sourceRow);
        const fullProposal = {
          ...payload,
          member_acceptances: storedAcceptancePair(proposal, memberRows, true)
        };
        assertForkFromLatestSourceSave(fullProposal, {
          origin_type: member.origin_type,
          origin_owner_user_id: member.origin_owner_user_id,
          room_archived: true,
          expected_members_by_seat: expectedMembersBySeat,
          source_import: sourceImport
        });
        validatePersistedActorRebind(database, sourceRow);
        baseType = 'latest_source_import';
        baseRefId = sourceRow.source_import_id;
        expectedStateHash = sourceRow.genesis_state_hash;
      }
      if (snapshot.state_hash !== expectedStateHash) {
        fail('BASE_HASH_MISMATCH', 'continuation genesis snapshot hash differs from its accepted basis');
      }
      const collision = database.prepare(`
        SELECT 1 AS present FROM room_epochs WHERE epoch_id = ?
        UNION ALL
        SELECT 1 AS present FROM room_checkpoints WHERE checkpoint_id = ?
        LIMIT 1
      `).get(newEpochId, newGenesisCheckpointId);
      if (collision) {
        fail('IDEMPOTENCY_KEY_REUSED', 'new epoch or genesis checkpoint ID is already used');
      }
      const nextEpochNo = database.prepare(`
        SELECT COALESCE(MAX(epoch_no), 0) + 1 AS value
          FROM room_epochs WHERE room_id = ?
      `).get(roomId).value;
      const nextStateRevision = member.state_revision + 1;
      const nextControlRevision = member.control_revision + 1;
      database.prepare(`
        INSERT INTO room_epochs (
          epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
          base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
          state_revision, control_revision, epoch_state,
          created_from_proposal_id, activated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NULL)
      `).run(
        newEpochId,
        roomId,
        member.lineage_id,
        nextEpochNo,
        baseType,
        baseRefId,
        expectedStateHash,
        newGenesisCheckpointId,
        newGenesisCheckpointId,
        nextStateRevision,
        nextControlRevision,
        proposalId,
        activatedAt
      );
      database.prepare(`
        INSERT INTO room_checkpoints (
          checkpoint_id, room_id, lineage_id, epoch_id, turn_no,
          checkpoint_kind, parent_checkpoint_id, turn_id, commit_id,
          state_revision, state_hash, snapshot_ref, created_at
        ) VALUES (?, ?, ?, ?, 0, 'genesis', NULL, NULL, NULL, ?, ?, ?, ?)
      `).run(
        newGenesisCheckpointId,
        roomId,
        member.lineage_id,
        newEpochId,
        nextStateRevision,
        expectedStateHash,
        snapshot.snapshot_id,
        activatedAt
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
        newEpochId,
        newGenesisCheckpointId,
        nextStateRevision,
        expectedStateHash,
        snapshot.snapshot_ciphertext,
        snapshot.wrapped_data_key,
        snapshot.nonce,
        snapshot.auth_tag,
        snapshot.master_key_version,
        activatedAt
      );
      const roomUpdate = database.prepare(`
        UPDATE multiplayer_rooms
           SET lifecycle = 'ACTIVE', active_epoch_id = ?, current_turn_id = NULL,
               state_revision = ?, control_revision = ?,
               event_seq = event_seq + 2, updated_at = ?, archived_at = NULL
         WHERE room_id = ? AND lifecycle = 'ARCHIVED'
           AND active_epoch_id IS NULL AND current_turn_id IS NULL
           AND state_revision = ? AND control_revision = ?
        RETURNING event_seq
      `).get(
        newEpochId,
        nextStateRevision,
        nextControlRevision,
        activatedAt,
        roomId,
        member.state_revision,
        expectedControlRevision
      );
      if (!roomUpdate) fail('STALE_CONTROL_REVISION', 'continuation room activation CAS failed');
      const proposalUpdate = database.prepare(`
        UPDATE room_control_proposals
           SET proposal_status = 'APPLIED', applied_at = ?
         WHERE proposal_id = ? AND proposal_revision = ?
           AND proposal_status = 'ACCEPTED'
      `).run(activatedAt, proposalId, proposalRevision);
      if (proposalUpdate.changes !== 1) {
        fail('PROPOSAL_ACCEPTANCE_CAS_FAILED', 'continuation proposal changed before activation');
      }
      insertEvents(database, {
        roomId,
        epochId: newEpochId,
        endEventSeq: roomUpdate.event_seq,
        createdAt: activatedAt,
        idFactory,
        events: seatEvents('lineage.epoch_activated', seat => ({
          room_id: roomId,
          viewer_seat: seat,
          epoch_id: newEpochId,
          epoch_no: nextEpochNo,
          genesis_checkpoint_id: newGenesisCheckpointId,
          base_type: baseType,
          state_revision: nextStateRevision,
          control_revision: nextControlRevision
        }))
      });
      const epochRow = database.prepare(`SELECT * FROM room_epochs WHERE epoch_id = ?`)
        .get(newEpochId);
      const checkpointRow = database.prepare(`
        SELECT * FROM room_checkpoints WHERE checkpoint_id = ?
      `).get(newGenesisCheckpointId);
      return immutable({
        epoch: epochContract(epochRow),
        genesis_checkpoint: checkpointContract(checkpointRow),
        control_revision: nextControlRevision,
        replayed: false
      });
    });
  };

  function exportProjection(row, replayed = undefined) {
    const value = {
      export_id: row.export_id,
      room_id: row.room_id,
      checkpoint_id: row.checkpoint_id,
      exporting_seat: row.exporting_seat_id,
      codec: row.codec,
      projection_version: row.projection_version,
      output_format: row.output_format,
      idempotency_key: row.idempotency_key,
      request_hash: row.request_hash,
      output_hash: row.output_hash,
      status: row.export_status,
      failure_code: row.failure_code,
      created_at: row.created_at,
      completed_at: row.completed_at
    };
    if (replayed !== undefined) value.replayed = replayed;
    return immutable(value);
  }

  const personalExports = {
    async begin({
      authenticated_user_id,
      room_id,
      checkpoint_id,
      projection_version = 'projection-v1',
      codec = EXPORT_CODEC,
      output_format = 'timeline-json-v1',
      idempotency_key
    }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const checkpointId = assertIdentifier(checkpoint_id, 'checkpoint_id');
      const projectionVersion = assertIdentifier(projection_version, 'projection_version');
      const codecValue = assertNonEmptyString(codec, 'codec', 160);
      if (codecValue !== EXPORT_CODEC) {
        fail('UNSUPPORTED_EXPORT_CODEC', `playable exports require ${EXPORT_CODEC}`);
      }
      const outputFormat = assertIdentifier(output_format, 'output_format');
      const idempotencyKey = assertNonEmptyString(idempotency_key, 'idempotency_key', 200);
      const requestHash = hashCanonical({
        checkpoint_id: checkpointId,
        codec: codecValue,
        output_format: outputFormat,
        projection_version: projectionVersion
      });
      const exportId = generatedId(idFactory, 'export');
      const createdAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        if (member.origin_type !== 'existing_save_derived') {
          fail(
            'PLAYABLE_EXPORT_NOT_ALLOWED',
            'new_multiplayer_save cannot produce a playable singleplayer export'
          );
        }
        const existing = database.prepare(`
          SELECT * FROM singleplayer_exports
           WHERE room_id = ? AND exporting_member_id = ? AND idempotency_key = ?
        `).get(roomId, member.member_id, idempotencyKey);
        if (existing) {
          if (existing.request_hash !== requestHash) {
            fail(
              'IDEMPOTENCY_KEY_REUSED',
              'export idempotency key was reused with different canonical parameters'
            );
          }
          return exportProjection(existing, true);
        }
        const checkpoint = database.prepare(`
          SELECT checkpoint_id FROM room_checkpoints
           WHERE room_id = ? AND checkpoint_id = ?
        `).get(roomId, checkpointId);
        if (!checkpoint) {
          fail('CHECKPOINT_NOT_COMMITTED', 'personal export requires a Room checkpoint');
        }
        const bindingCount = database.prepare(`
          SELECT COUNT(*) AS count FROM room_actor_bindings WHERE room_id = ?
        `).get(roomId).count;
        if (bindingCount !== 2) {
          fail(
            'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
            'playable export requires the complete original actor binding pair'
          );
        }
        database.prepare(`
          INSERT INTO singleplayer_exports (
            export_id, room_id, checkpoint_id, exporting_member_id,
            exporting_seat_id, codec, projection_version, output_format,
            idempotency_key, request_hash, output_hash, output_ref,
            export_status, failure_code, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
            'PENDING', NULL, ?, NULL)
        `).run(
          exportId,
          roomId,
          checkpointId,
          member.member_id,
          member.seat_id,
          codecValue,
          projectionVersion,
          outputFormat,
          idempotencyKey,
          requestHash,
          createdAt
        );
        const row = database.prepare(`SELECT * FROM singleplayer_exports WHERE export_id = ?`)
          .get(exportId);
        return exportProjection(row, false);
      });
    },

    async complete({ authenticated_user_id, room_id, export_id, output_hash, output_ref }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const exportId = assertIdentifier(export_id, 'export_id');
      const outputHash = assertHash(output_hash, 'output_hash');
      const outputRef = assertNonEmptyString(output_ref, 'output_ref', 4_096);
      const completedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const existing = database.prepare(`
          SELECT * FROM singleplayer_exports
           WHERE export_id = ? AND room_id = ? AND exporting_member_id = ?
        `).get(exportId, roomId, member.member_id);
        if (!existing) {
          fail('EXPORT_NOT_FOUND', 'personal export is not available to this member', {}, 404);
        }
        if (existing.export_status === 'READY') {
          if (existing.output_hash !== outputHash || existing.output_ref !== outputRef) {
            fail('IDEMPOTENCY_KEY_REUSED', 'ready export was completed with different output');
          }
          return exportProjection(existing, true);
        }
        if (existing.export_status !== 'PENDING') {
          fail('EXPORT_NOT_PENDING', 'failed export cannot publish output');
        }
        const changed = database.prepare(`
          UPDATE singleplayer_exports
             SET output_hash = ?, output_ref = ?, export_status = 'READY',
                 failure_code = NULL, completed_at = ?
           WHERE export_id = ? AND room_id = ? AND exporting_member_id = ?
             AND export_status = 'PENDING'
        `).run(outputHash, outputRef, completedAt, exportId, roomId, member.member_id);
        if (changed.changes !== 1) fail('EXPORT_COMPLETION_CAS_FAILED', 'export status changed');
        const row = database.prepare(`SELECT * FROM singleplayer_exports WHERE export_id = ?`)
          .get(exportId);
        return exportProjection(row, false);
      });
    },

    async markFailed({ authenticated_user_id, room_id, export_id, failure_code }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const exportId = assertIdentifier(export_id, 'export_id');
      const failureCode = assertIdentifier(failure_code, 'failure_code');
      const completedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const existing = database.prepare(`
          SELECT * FROM singleplayer_exports
           WHERE export_id = ? AND room_id = ? AND exporting_member_id = ?
        `).get(exportId, roomId, member.member_id);
        if (!existing) {
          fail('EXPORT_NOT_FOUND', 'personal export is not available to this member', {}, 404);
        }
        if (existing.export_status === 'FAILED') {
          if (existing.failure_code !== failureCode) {
            fail('IDEMPOTENCY_KEY_REUSED', 'failed export was replayed with another failure code');
          }
          return exportProjection(existing, true);
        }
        if (existing.export_status !== 'PENDING') {
          fail('EXPORT_NOT_PENDING', 'ready export cannot be changed to failed');
        }
        const changed = database.prepare(`
          UPDATE singleplayer_exports
             SET export_status = 'FAILED', failure_code = ?, completed_at = ?
           WHERE export_id = ? AND room_id = ? AND exporting_member_id = ?
             AND export_status = 'PENDING'
        `).run(failureCode, completedAt, exportId, roomId, member.member_id);
        if (changed.changes !== 1) fail('EXPORT_COMPLETION_CAS_FAILED', 'export status changed');
        const row = database.prepare(`SELECT * FROM singleplayer_exports WHERE export_id = ?`)
          .get(exportId);
        return exportProjection(row, false);
      });
    },

    getStatus({ authenticated_user_id, room_id, export_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const exportId = assertIdentifier(export_id, 'export_id');
      return connection.read(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const row = database.prepare(`
          SELECT * FROM singleplayer_exports
           WHERE export_id = ? AND room_id = ? AND exporting_member_id = ?
        `).get(exportId, roomId, member.member_id);
        if (!row) fail('EXPORT_NOT_FOUND', 'personal export is not available to this member', {}, 404);
        return exportProjection(row);
      });
    },

    getForDownload({ authenticated_user_id, room_id, export_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const exportId = assertIdentifier(export_id, 'export_id');
      return connection.read(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const row = database.prepare(`
          SELECT * FROM singleplayer_exports
           WHERE export_id = ? AND room_id = ? AND exporting_member_id = ?
        `).get(exportId, roomId, member.member_id);
        if (!row) fail('EXPORT_NOT_FOUND', 'personal export is not available to this member', {}, 404);
        if (row.export_status !== 'READY') {
          fail('EXPORT_NOT_READY', 'personal export output has not been published');
        }
        return immutable({
          export_id: row.export_id,
          checkpoint_id: row.checkpoint_id,
          exporting_seat: row.exporting_seat_id,
          codec: row.codec,
          projection_version: row.projection_version,
          output_format: row.output_format,
          output_hash: row.output_hash,
          output_ref: row.output_ref,
          completed_at: row.completed_at
        });
      });
    }
  };

  const lineage = {
    getForMember({ authenticated_user_id, room_id }) {
      const authenticatedUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      return connection.read(database => {
        const member = requireMember(database, roomId, authenticatedUserId);
        const epochs = database.prepare(`
          SELECT epoch_id, epoch_no, base_type, base_ref_id,
                 genesis_checkpoint_id, head_checkpoint_id,
                 state_revision, control_revision, epoch_state,
                 created_from_proposal_id, activated_at, archived_at
            FROM room_epochs WHERE room_id = ? ORDER BY epoch_no
        `).all(roomId).map(row => ({
          epoch_id: row.epoch_id,
          epoch_no: row.epoch_no,
          base_type: row.base_type,
          base_ref_id: row.base_ref_id,
          genesis_checkpoint_id: row.genesis_checkpoint_id,
          head_checkpoint_id: row.head_checkpoint_id,
          state_revision: row.state_revision,
          control_revision: row.control_revision,
          state: row.epoch_state,
          created_from_proposal_id: row.created_from_proposal_id,
          activated_at: row.activated_at,
          archived_at: row.archived_at
        }));
        const checkpoints = database.prepare(`
          SELECT checkpoint_id, epoch_id, turn_no, checkpoint_kind,
                 parent_checkpoint_id, turn_id, state_revision, created_at
            FROM room_checkpoints WHERE room_id = ?
           ORDER BY state_revision, epoch_id, turn_no
        `).all(roomId).map(row => ({
          checkpoint_id: row.checkpoint_id,
          epoch_id: row.epoch_id,
          turn_no: row.turn_no,
          kind: row.checkpoint_kind,
          parent_checkpoint_id: row.parent_checkpoint_id,
          turn_id: row.turn_id,
          state_revision: row.state_revision,
          created_at: row.created_at
        }));
        const sourceImportRows = database.prepare(`
          SELECT * FROM room_source_imports
           WHERE room_id = ? AND validation_status = 'VALID'
           ORDER BY imported_at, source_import_id
        `).all(roomId);
        // A newly created lobby legitimately has only its host. The original
        // A/B pair is required only when opening audience-bound source-import
        // projections; base epoch/checkpoint lineage is safe for the host to
        // read while waiting for the invited member.
        const expectedMembersBySeat = sourceImportRows.length > 0
          ? membersBySeat(originalMembers(database, roomId))
          : null;
        const sourceImports = sourceImportRows.map(row => {
          if (row.audience_diff_codec !== audienceDiffCodec.codecVersion) {
            fail('PERSISTED_LINEAGE_CORRUPT', 'audience diff codec version is unavailable');
          }
          const seat = member.seat_id;
          const diff = openAudienceDiff(
            audienceDiffCodec,
            row[`audience_diff_${seat.toLowerCase()}_ciphertext`],
            Object.freeze({
              purpose: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
              codec_version: row.audience_diff_codec,
              room_id: roomId,
              source_import_id: row.source_import_id,
              proposal_id: row.proposal_id,
              proposal_revision: row.proposal_revision,
              audience: seat
            })
          );
          assertAudienceSafeImportDiff(diff, {
            expected_members_by_seat: expectedMembersBySeat,
            origin_owner_user_id: member.origin_owner_user_id
          });
          const projection = {
            source_import_id: row.source_import_id,
            proposal_id: row.proposal_id,
            proposal_revision: row.proposal_revision,
            validation_status: row.validation_status,
            privacy_normalizer_version: row.privacy_normalizer_version,
            audience_diff: diff,
            audience_diff_commitment:
              row[`audience_diff_${seat.toLowerCase()}_commitment`],
            server_hmac_commitment: row.server_hmac_commitment,
            imported_at: row.imported_at
          };
          if (authenticatedUserId === member.origin_owner_user_id) {
            projection.source = {
              source_save_id: row.source_save_id,
              client_save_instance_id: row.client_save_instance_id,
              source_branch_id: row.source_branch_id,
              source_node_id: row.source_node_id,
              cloud_revision: row.cloud_revision,
              derived_from_export_id: row.derived_from_export_id
            };
          }
          return projection;
        });
        return immutable({
          room_id: roomId,
          lineage_id: member.lineage_id,
          origin_type: member.origin_type,
          lifecycle: member.lifecycle,
          viewer_seat: member.seat_id,
          active_epoch_id: member.active_epoch_id,
          state_revision: member.state_revision,
          control_revision: member.control_revision,
          epochs,
          checkpoints,
          source_imports: sourceImports,
          actor_bindings: database.prepare(`
            SELECT binding_id, room_actor_id, original_seat_id,
                   genesis_checkpoint_id, signature_version
              FROM room_actor_bindings WHERE room_id = ? ORDER BY original_seat_id
          `).all(roomId).map(row => ({
            binding_id: row.binding_id,
            room_actor_id: row.room_actor_id,
            original_seat: row.original_seat_id,
            genesis_checkpoint_id: row.genesis_checkpoint_id,
            signature_version: row.signature_version
          }))
        });
      });
    }
  };

  return Object.freeze({
    bindings: Object.freeze(bindings),
    sourceImports: Object.freeze(sourceImports),
    proposals: Object.freeze(proposals),
    personalExports: Object.freeze(personalExports),
    lineage: Object.freeze(lineage)
  });
}

export {
  EVENT_PROJECTION_VERSION,
  EXPORT_CODEC
};
