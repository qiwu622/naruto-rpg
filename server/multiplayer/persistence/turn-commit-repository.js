import { randomUUID } from 'node:crypto';

import { assertCommitPreconditionSet } from '../contracts/commit-contracts.js';
import { canonicalStringify, sha256Hex } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details);
}

function hash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function assertIdentifier(value, label, prefix = null) {
  const pattern = prefix
    ? new RegExp(`^${prefix}[A-Za-z0-9_-]+$`, 'u')
    : /^[A-Za-z][A-Za-z0-9:_-]+$/u;
  if (typeof value !== 'string' || value.length > 160 || !pattern.test(value)) {
    fail('COMMIT_REQUEST_INVALID', `${label} is invalid`);
  }
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('COMMIT_REQUEST_INVALID', `${label} must be an ISO timestamp`);
  }
  return value;
}

function assertBytes(value, label, minimum) {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum) {
    fail('COMMIT_REQUEST_INVALID', `${label} is invalid`);
  }
  return Buffer.from(value);
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('COMMIT_REQUEST_INVALID', `${label} must be an object`);
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('COMMIT_REQUEST_INVALID', `${label} contains an unknown property`, { key });
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail('COMMIT_REQUEST_INVALID', `${label} is missing a required property`, { key });
    }
  }
  return value;
}

function normalizeCommitRequest(value) {
  assertExactKeys(value, [
    'preconditions',
    'checkpoint_id',
    'snapshot_id',
    'snapshot',
    'committed_at'
  ], 'turn commit request');
  const preconditions = assertCommitPreconditionSet(value.preconditions);
  const snapshotId = assertIdentifier(value.snapshot_id, 'snapshot_id', 'snapshot_');
  const snapshot = assertExactKeys(value.snapshot, [
    'snapshot_id',
    'state_revision',
    'state_hash',
    'snapshot_ciphertext',
    'wrapped_data_key',
    'nonce',
    'auth_tag',
    'master_key_version'
  ], 'sealed authoritative snapshot');
  if (snapshot.snapshot_id !== snapshotId
    || snapshot.state_revision !== preconditions.concurrency.base_state_revision + 1
    || snapshot.state_hash !== preconditions.result.candidate_state_hash) {
    fail('COMMIT_REQUEST_INVALID', 'sealed snapshot does not match commit preconditions');
  }
  if (typeof snapshot.master_key_version !== 'string' || !snapshot.master_key_version) {
    fail('COMMIT_REQUEST_INVALID', 'sealed snapshot master_key_version is invalid');
  }
  return Object.freeze({
    preconditions,
    checkpoint_id: assertIdentifier(value.checkpoint_id, 'checkpoint_id', 'checkpoint_'),
    snapshot_id: snapshotId,
    snapshot: Object.freeze({
      snapshot_id: snapshotId,
      state_revision: snapshot.state_revision,
      state_hash: snapshot.state_hash,
      snapshot_ciphertext: assertBytes(
        snapshot.snapshot_ciphertext,
        'snapshot.snapshot_ciphertext',
        1
      ),
      wrapped_data_key: assertBytes(snapshot.wrapped_data_key, 'snapshot.wrapped_data_key', 16),
      nonce: assertBytes(snapshot.nonce, 'snapshot.nonce', 8),
      auth_tag: assertBytes(snapshot.auth_tag, 'snapshot.auth_tag', 8),
      master_key_version: snapshot.master_key_version
    }),
    committed_at: assertTimestamp(value.committed_at, 'committed_at')
  });
}

function defaultIdFactory(kind) {
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

function rowMismatch(path, expected, actual) {
  fail('COMMIT_PRECONDITION_FAILED', 'final commit precondition does not match authoritative state', {
    path,
    expected,
    actual
  });
}

function expectEqual(path, expected, actual) {
  if (expected !== actual) rowMismatch(path, expected, actual);
}

function assertBillingProvenance(database, turnId, expectedTailHash) {
  const inFlight = database.prepare(`
    SELECT invocation_id, usage_status
      FROM ai_usage_ledger
     WHERE turn_id = ? AND usage_status IN ('IN_FLIGHT', 'UNKNOWN')
     LIMIT 1
  `).get(turnId);
  if (inFlight) {
    fail('COMMIT_BILLING_PROVENANCE_INVALID', 'an adopted turn still has unresolved model usage', {
      invocation_id: inFlight.invocation_id,
      usage_status: inFlight.usage_status
    });
  }

  const rows = database.prepare(`
    SELECT provenance_hash, previous_provenance_hash
      FROM turn_output_adoption_events
     WHERE turn_id = ?
  `).all(turnId);
  if (!rows.length) {
    fail('COMMIT_BILLING_PROVENANCE_INVALID', 'turn has no output-adoption provenance');
  }
  const byHash = new Map(rows.map(row => [row.provenance_hash, row]));
  if (byHash.size !== rows.length) {
    fail('COMMIT_BILLING_PROVENANCE_INVALID', 'output-adoption provenance hashes are not unique');
  }
  const childCount = new Map();
  let roots = 0;
  for (const row of rows) {
    if (row.previous_provenance_hash === null) {
      roots += 1;
      continue;
    }
    if (!byHash.has(row.previous_provenance_hash)) {
      fail('COMMIT_BILLING_PROVENANCE_INVALID', 'output-adoption provenance has a broken link');
    }
    const count = (childCount.get(row.previous_provenance_hash) ?? 0) + 1;
    childCount.set(row.previous_provenance_hash, count);
    if (count > 1) {
      fail('COMMIT_BILLING_PROVENANCE_INVALID', 'output-adoption provenance branches unexpectedly');
    }
  }
  if (roots !== 1) {
    fail('COMMIT_BILLING_PROVENANCE_INVALID', 'output-adoption provenance must have one root');
  }
  const tails = rows.filter(row => !childCount.has(row.provenance_hash));
  if (tails.length !== 1 || tails[0].provenance_hash !== expectedTailHash) {
    fail('COMMIT_BILLING_PROVENANCE_INVALID', 'billing provenance tail does not match the READY draft');
  }
}

function verifyNarrativeSet(database, turnId, mode, resolutionHash) {
  const rows = database.prepare(`
    SELECT audience, narrative_mode, resolution_hash
      FROM narrative_deliveries
     WHERE turn_id = ?
     ORDER BY audience
  `).all(turnId);
  const expectedAudiences = mode === 'shared' ? ['shared'] : ['A', 'B'];
  if (rows.length !== expectedAudiences.length
    || rows.some((row, index) => row.audience !== expectedAudiences[index]
      || row.narrative_mode !== mode
      || row.resolution_hash !== resolutionHash)) {
    fail('COMMIT_NARRATIVE_SET_INVALID', 'turn narrative deliveries do not match its frozen mode/resolution');
  }
}

function verifyReadyDraft(database, preconditions) {
  const { identity, concurrency, frozen_inputs, billing, result } = preconditions;
  const row = database.prepare(`
    SELECT d.*, t.turn_status, t.narrative_mode, t.input_hash AS turn_input_hash,
           t.execution_plan_hash AS turn_execution_plan_hash,
           t.base_checkpoint_id, t.turn_no,
           r.run_status, r.input_hash AS run_input_hash, r.lease_fence AS run_lease_fence
      FROM turn_drafts d
      JOIN multiplayer_turns t ON t.turn_id = d.turn_id
      JOIN resolution_runs r ON r.run_id = d.run_id
     WHERE d.draft_id = ? AND d.turn_id = ? AND d.run_id = ?
       AND d.room_id = ? AND d.epoch_id = ?
  `).get(
    identity.draft_id,
    identity.turn_id,
    identity.run_id,
    identity.room_id,
    identity.epoch_id
  );
  if (!row) fail('COMMIT_PRECONDITION_FAILED', 'turn draft identity does not exist');
  const checks = [
    ['/lifecycle/turn_status', preconditions.lifecycle.turn_status, row.turn_status],
    ['/concurrency/base_state_revision', concurrency.base_state_revision, row.base_state_revision],
    ['/concurrency/base_state_hash', concurrency.base_state_hash, row.base_state_hash],
    ['/concurrency/lease_fence', concurrency.lease_fence, row.lease_fence],
    ['/concurrency/lease_fence', concurrency.lease_fence, row.run_lease_fence],
    ['/concurrency/draft_revision', concurrency.draft_revision, row.draft_revision],
    ['/concurrency/draft_status', concurrency.draft_status, row.draft_status],
    ['/frozen_inputs/input_hash', frozen_inputs.input_hash, row.turn_input_hash],
    ['/frozen_inputs/input_hash', frozen_inputs.input_hash, row.run_input_hash],
    ['/frozen_inputs/resolution_hash', frozen_inputs.resolution_hash, row.resolution_hash],
    ['/frozen_inputs/obligation_set_hash', frozen_inputs.obligation_set_hash, row.obligation_set_hash],
    ['/frozen_inputs/execution_plan_hash', frozen_inputs.execution_plan_hash, row.execution_plan_hash],
    ['/frozen_inputs/execution_plan_hash', frozen_inputs.execution_plan_hash, row.turn_execution_plan_hash],
    ['/billing/billing_provenance_hash', billing.billing_provenance_hash, row.billing_provenance_hash],
    ['/result/candidate_state_hash', result.candidate_state_hash, row.candidate_state_hash],
    ['/result/artifact_bundle_hash', result.artifact_bundle_hash, row.artifact_set_hash],
    ['/result/narrative_bundle_hash', result.narrative_bundle_hash, row.narrative_set_hash],
    ['/result/semantic_draft_hash', result.semantic_draft_hash, row.semantic_hash],
    ['/result/commit_envelope_hash', result.commit_envelope_hash, row.commit_envelope_hash]
  ];
  for (const [path, expected, actual] of checks) expectEqual(path, expected, actual);
  if (!ACTIVE_RUN_STATUS_SET.has(row.run_status)) {
    rowMismatch('/concurrency/lease_fence', 'active run lease', row.run_status);
  }
  if (!row.candidate_state_ciphertext
    || !row.wrapped_data_key
    || !row.nonce
    || !row.auth_tag
    || !row.master_key_version) {
    fail('COMMIT_PRECONDITION_FAILED', 'READY draft has no encrypted candidate state');
  }

  const pending = database.prepare(`
    SELECT obligation_id, obligation_status
      FROM turn_draft_obligations
     WHERE draft_id = ? AND obligation_status != 'SATISFIED'
     LIMIT 1
  `).get(identity.draft_id);
  if (pending) {
    fail('COMMIT_PRECONDITION_FAILED', 'READY draft still has an unsatisfied obligation', pending);
  }
  const resolution = database.prepare(`
    SELECT resolution_hash FROM canonical_resolutions
     WHERE turn_id = ? AND run_id = ?
  `).get(identity.turn_id, identity.run_id);
  expectEqual('/frozen_inputs/resolution_hash', frozen_inputs.resolution_hash, resolution?.resolution_hash ?? null);
  verifyNarrativeSet(database, identity.turn_id, row.narrative_mode, frozen_inputs.resolution_hash);
  assertBillingProvenance(database, identity.turn_id, billing.billing_provenance_hash);
  return row;
}

const ACTIVE_RUN_STATUS_SET = new Set(['CLAIMED', 'RUNNING']);

function existingCommitReceipt(database, request, preconditionHash) {
  const { preconditions, checkpoint_id, snapshot_id, snapshot, committed_at } = request;
  const { identity, concurrency, result } = preconditions;
  const row = database.prepare(`
    SELECT tc.*, c.snapshot_ref, c.created_at AS checkpoint_created_at,
           s.state_revision AS snapshot_state_revision,
           s.state_hash AS snapshot_state_hash,
           s.snapshot_ciphertext, s.wrapped_data_key, s.nonce, s.auth_tag,
           s.master_key_version AS snapshot_master_key_version
      FROM turn_commits tc
      LEFT JOIN room_checkpoints c ON c.checkpoint_id = tc.checkpoint_id
      LEFT JOIN room_snapshots s ON s.snapshot_id = c.snapshot_ref
     WHERE tc.turn_id = ? OR tc.commit_id = ?
  `).get(identity.turn_id, identity.commit_id);
  if (!row) return null;
  const matches = row.commit_id === identity.commit_id
    && row.turn_id === identity.turn_id
    && row.room_id === identity.room_id
    && row.epoch_id === identity.epoch_id
    && row.checkpoint_id === checkpoint_id
    && row.snapshot_ref === snapshot_id
    && row.committed_at === committed_at
    && row.checkpoint_created_at === committed_at
    && row.snapshot_state_revision === snapshot.state_revision
    && row.snapshot_state_hash === snapshot.state_hash
    && Buffer.from(row.snapshot_ciphertext).equals(snapshot.snapshot_ciphertext)
    && Buffer.from(row.wrapped_data_key).equals(snapshot.wrapped_data_key)
    && Buffer.from(row.nonce).equals(snapshot.nonce)
    && Buffer.from(row.auth_tag).equals(snapshot.auth_tag)
    && row.snapshot_master_key_version === snapshot.master_key_version
    && row.commit_precondition_hash === preconditionHash
    && row.before_state_revision === concurrency.base_state_revision
    && row.after_state_hash === result.candidate_state_hash
    && row.artifact_set_hash === result.artifact_bundle_hash
    && row.narrative_set_hash === result.narrative_bundle_hash
    && row.commit_envelope_hash === result.commit_envelope_hash
    && row.lease_fence === concurrency.lease_fence;
  if (!matches) fail('IDEMPOTENCY_CONFLICT', 'turn/commit ID already belongs to another commit payload');
  return Object.freeze({
    replayed: true,
    commit_id: row.commit_id,
    turn_id: row.turn_id,
    checkpoint_id: row.checkpoint_id,
    state_revision: row.after_state_revision,
    state_hash: row.after_state_hash,
    snapshot_id: row.snapshot_ref,
    committed_at: row.committed_at
  });
}

/**
 * Final authoritative commit. This method accepts only the complete section
 * 13.9 precondition contract and performs no model/network/large JSON work.
 */
export function createTurnCommitRepository(connection, { idFactory = defaultIdFactory } = {}) {
  if (!connection || typeof connection.write !== 'function') {
    fail('COMMIT_REPOSITORY_INVALID', 'a multiplayer SQLite connection is required');
  }
  if (typeof idFactory !== 'function') fail('COMMIT_REPOSITORY_INVALID', 'idFactory must be a function');

  async function commitTurn(requestValue) {
    const request = normalizeCommitRequest(requestValue);
    const { preconditions } = request;
    const { identity, lifecycle, concurrency, frozen_inputs, result } = preconditions;
    const sealedSnapshot = request.snapshot;
    const preconditionHash = hash(preconditions);
    return connection.write(database => {
      const replay = existingCommitReceipt(database, request, preconditionHash);
      if (replay) return replay;

      const roomEpoch = database.prepare(`
        SELECT r.lifecycle AS room_lifecycle, r.active_epoch_id, r.current_turn_id,
               r.state_revision AS room_state_revision, r.control_revision,
               r.event_seq, r.lineage_id, r.queued_narrative_mode,
               e.epoch_state, e.head_checkpoint_id,
               e.state_revision AS epoch_state_revision,
               c.state_hash AS head_state_hash
          FROM multiplayer_rooms r
          JOIN room_epochs e ON e.epoch_id = r.active_epoch_id AND e.room_id = r.room_id
          JOIN room_checkpoints c ON c.checkpoint_id = e.head_checkpoint_id
         WHERE r.room_id = ? AND e.epoch_id = ?
      `).get(identity.room_id, identity.epoch_id);
      if (!roomEpoch) fail('COMMIT_PRECONDITION_FAILED', 'active room/epoch identity does not exist');
      for (const [path, expected, actual] of [
        ['/lifecycle/room_lifecycle', lifecycle.room_lifecycle, roomEpoch.room_lifecycle],
        ['/lifecycle/epoch_state', lifecycle.epoch_state, roomEpoch.epoch_state],
        ['/lifecycle/current_turn_id', lifecycle.current_turn_id, roomEpoch.current_turn_id],
        ['/concurrency/base_state_revision', concurrency.base_state_revision, roomEpoch.room_state_revision],
        ['/concurrency/base_state_revision', concurrency.base_state_revision, roomEpoch.epoch_state_revision],
        ['/concurrency/base_state_hash', concurrency.base_state_hash, roomEpoch.head_state_hash]
      ]) expectEqual(path, expected, actual);

      const draft = verifyReadyDraft(database, preconditions);
      const nextStateRevision = concurrency.base_state_revision + 1;
      const nextControlRevision = roomEpoch.control_revision + 1;
      const eventCount = 2;
      const roomUpdate = database.prepare(`
        UPDATE multiplayer_rooms
           SET state_revision = ?,
               control_revision = ?,
               event_seq = event_seq + ?,
               updated_at = ?
         WHERE room_id = ? AND lifecycle = 'ACTIVE'
           AND active_epoch_id = ? AND current_turn_id = ?
           AND state_revision = ? AND control_revision = ? AND event_seq = ?
        RETURNING event_seq
      `).get(
        nextStateRevision,
        nextControlRevision,
        eventCount,
        request.committed_at,
        identity.room_id,
        identity.epoch_id,
        identity.turn_id,
        concurrency.base_state_revision,
        roomEpoch.control_revision,
        roomEpoch.event_seq
      );
      if (!roomUpdate) fail('COMMIT_CAS_FAILED', 'room state/control revision CAS failed');

      const checkpointRecord = {
        checkpoint_id: request.checkpoint_id,
        room_id: identity.room_id,
        lineage_id: roomEpoch.lineage_id,
        epoch_id: identity.epoch_id,
        turn_no: draft.turn_no,
        checkpoint_kind: 'turn_commit',
        parent_checkpoint_id: roomEpoch.head_checkpoint_id,
        turn_id: identity.turn_id,
        commit_id: identity.commit_id,
        state_revision: nextStateRevision,
        state_hash: result.candidate_state_hash,
        snapshot_ref: request.snapshot_id,
        created_at: request.committed_at
      };
      const checkpointHash = hash(checkpointRecord);
      database.prepare(`
        INSERT INTO room_checkpoints (
          checkpoint_id, room_id, lineage_id, epoch_id, turn_no, checkpoint_kind,
          parent_checkpoint_id, turn_id, commit_id, state_revision, state_hash,
          snapshot_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, 'turn_commit', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpointRecord.checkpoint_id,
        checkpointRecord.room_id,
        checkpointRecord.lineage_id,
        checkpointRecord.epoch_id,
        checkpointRecord.turn_no,
        checkpointRecord.parent_checkpoint_id,
        checkpointRecord.turn_id,
        checkpointRecord.commit_id,
        checkpointRecord.state_revision,
        checkpointRecord.state_hash,
        checkpointRecord.snapshot_ref,
        checkpointRecord.created_at
      );
      database.prepare(`
        INSERT INTO turn_commits (
          commit_id, turn_id, room_id, epoch_id, checkpoint_id,
          commit_precondition_hash, before_state_revision, after_state_revision,
          before_state_hash, after_state_hash, artifact_set_hash,
          narrative_set_hash, checkpoint_hash, commit_envelope_hash,
          lease_fence, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.commit_id,
        identity.turn_id,
        identity.room_id,
        identity.epoch_id,
        request.checkpoint_id,
        preconditionHash,
        concurrency.base_state_revision,
        nextStateRevision,
        concurrency.base_state_hash,
        result.candidate_state_hash,
        result.artifact_bundle_hash,
        result.narrative_bundle_hash,
        checkpointHash,
        result.commit_envelope_hash,
        concurrency.lease_fence,
        request.committed_at
      );
      database.prepare(`
        INSERT INTO room_snapshots (
          snapshot_id, room_id, epoch_id, checkpoint_id, state_revision,
          state_hash, snapshot_ciphertext, wrapped_data_key, nonce, auth_tag,
          master_key_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.snapshot_id,
        identity.room_id,
        identity.epoch_id,
        request.checkpoint_id,
        nextStateRevision,
        result.candidate_state_hash,
        sealedSnapshot.snapshot_ciphertext,
        sealedSnapshot.wrapped_data_key,
        sealedSnapshot.nonce,
        sealedSnapshot.auth_tag,
        sealedSnapshot.master_key_version,
        request.committed_at
      );

      const epochUpdate = database.prepare(`
        UPDATE room_epochs
           SET head_checkpoint_id = ?, state_revision = ?, control_revision = ?
         WHERE epoch_id = ? AND room_id = ? AND epoch_state = 'ACTIVE'
           AND head_checkpoint_id = ? AND state_revision = ?
      `).run(
        request.checkpoint_id,
        nextStateRevision,
        nextControlRevision,
        identity.epoch_id,
        identity.room_id,
        roomEpoch.head_checkpoint_id,
        concurrency.base_state_revision
      );
      if (epochUpdate.changes !== 1) fail('COMMIT_CAS_FAILED', 'epoch head CAS failed');
      const turnUpdate = database.prepare(`
        UPDATE multiplayer_turns
           SET turn_status = 'COMMITTED', committed_at = ?, updated_at = ?
         WHERE turn_id = ? AND room_id = ? AND epoch_id = ?
           AND turn_status = 'COMMITTING' AND input_hash = ?
      `).run(
        request.committed_at,
        request.committed_at,
        identity.turn_id,
        identity.room_id,
        identity.epoch_id,
        frozen_inputs.input_hash
      );
      if (turnUpdate.changes !== 1) fail('COMMIT_CAS_FAILED', 'turn COMMITTING CAS failed');
      const disclosure = database.prepare(`
        UPDATE action_submissions SET full_disclosed_at = ?
         WHERE turn_id = ? AND full_disclosed_at IS NULL
      `).run(request.committed_at, identity.turn_id);
      if (disclosure.changes !== 2) {
        fail('COMMIT_PRECONDITION_FAILED', 'turn must disclose exactly two locked actions');
      }
      const runUpdate = database.prepare(`
        UPDATE resolution_runs
           SET run_status = 'SUCCEEDED', owner_boot_id = NULL, owner_task_id = NULL,
               claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
               updated_at = ?
         WHERE run_id = ? AND turn_id = ? AND lease_fence = ?
           AND run_status IN ('CLAIMED', 'RUNNING')
      `).run(request.committed_at, identity.run_id, identity.turn_id, concurrency.lease_fence);
      if (runUpdate.changes !== 1) fail('STALE_LEASE_FENCE', 'run fence changed before final commit');

      const firstEventSeq = roomUpdate.event_seq - eventCount + 1;
      const events = [
        {
          event_type: 'action.revealed_after_commit',
          payload: {
            schema: 'naruto.multiplayer-event/action-revealed-after-commit/v1',
            turn_id: identity.turn_id,
            disclosure: 'full_after_commit'
          }
        },
        {
          event_type: 'turn.committed',
          payload: {
            schema: 'naruto.multiplayer-event/turn-committed/v1',
            turn_id: identity.turn_id,
            checkpoint_id: request.checkpoint_id,
            state_revision: nextStateRevision,
            state_hash: result.candidate_state_hash
          }
        }
      ];
      for (let index = 0; index < events.length; index += 1) {
        const eventId = assertIdentifier(idFactory('event', index), 'event_id');
        const outboxId = assertIdentifier(idFactory('outbox', index), 'outbox_id');
        const payloadJson = canonicalStringify(events[index].payload);
        database.prepare(`
          INSERT INTO room_events (
            event_id, room_id, event_seq, epoch_id, turn_id, event_type,
            audience, projection_version, projected_payload_json, payload_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'BOTH', 'projection-v1', ?, ?, ?)
        `).run(
          eventId,
          identity.room_id,
          firstEventSeq + index,
          identity.epoch_id,
          identity.turn_id,
          events[index].event_type,
          payloadJson,
          hash(events[index].payload),
          request.committed_at
        );
        database.prepare(`
          INSERT INTO room_outbox (
            outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
            lease_fence, lease_expires_at, claimed_at, dispatched_at,
            attempt_count, created_at
          ) VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, 0, ?)
        `).run(outboxId, identity.room_id, eventId, request.committed_at);
      }

      return Object.freeze({
        replayed: false,
        commit_id: identity.commit_id,
        turn_id: identity.turn_id,
        checkpoint_id: request.checkpoint_id,
        state_revision: nextStateRevision,
        state_hash: result.candidate_state_hash,
        snapshot_id: request.snapshot_id,
        event_seq_from: firstEventSeq,
        event_seq_to: roomUpdate.event_seq,
        committed_at: request.committed_at
      });
    });
  }

  return Object.freeze({ commitTurn });
}
