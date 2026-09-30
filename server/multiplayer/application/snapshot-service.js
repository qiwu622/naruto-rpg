import { canonicalizeJson } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { roomCheckpointStateHash } from '../domain/lineage.js';
import { assertReducerDomainState } from '../domain/reducers/index.js';

function fail(code, message, details = {}, status = 500) {
  throw new DomainError(code, message, details, { status });
}

function stateHash(value) {
  return roomCheckpointStateHash(value, {
    A: value.actors.A.room_actor_id,
    B: value.actors.B.room_actor_id
  });
}

function snapshotContext(value) {
  return {
    schema: 'naruto.multiplayer-room-snapshot-context/v1',
    room_id: value.room_id,
    epoch_id: value.epoch_id,
    checkpoint_id: value.checkpoint_id,
    snapshot_id: value.snapshot_id,
    state_revision: value.state_revision,
    state_hash: value.state_hash
  };
}

function openEnvelope(row) {
  return {
    action_ciphertext: Buffer.from(row.snapshot_ciphertext),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  };
}

export function createAuthoritativeSnapshotService({ connection, contentCodec }) {
  if (!connection || typeof connection.read !== 'function'
    || typeof contentCodec?.sealJson !== 'function'
    || typeof contentCodec?.openJson !== 'function') {
    fail('SNAPSHOT_SERVICE_INVALID', 'connection and content codec are required');
  }

  function seal({
    room_id,
    epoch_id,
    checkpoint_id,
    snapshot_id,
    state_revision,
    state
  }) {
    const candidate = assertReducerDomainState(state);
    if (candidate.meta.state_revision !== state_revision) {
      fail('SNAPSHOT_REVISION_MISMATCH', 'state meta revision differs from snapshot revision');
    }
    const hash = stateHash(candidate);
    const context = snapshotContext({
      room_id,
      epoch_id,
      checkpoint_id,
      snapshot_id,
      state_revision,
      state_hash: hash
    });
    const envelope = contentCodec.sealJson(candidate, context);
    return Object.freeze({
      snapshot_id,
      state_revision,
      state_hash: hash,
      snapshot_ciphertext: envelope.action_ciphertext,
      wrapped_data_key: envelope.wrapped_data_key,
      nonce: envelope.nonce,
      auth_tag: envelope.auth_tag,
      master_key_version: envelope.master_key_version
    });
  }

  /**
   * Rebinds an authenticated snapshot to a new epoch/checkpoint envelope while
   * allocating the caller-supplied monotonic revision. The checkpoint content
   * hash intentionally remains stable because state_revision is not story
   * content (design section 10).
   */
  function rebase({
    source,
    room_id,
    epoch_id,
    checkpoint_id,
    snapshot_id,
    state_revision
  }) {
    if (!source || source.room_id !== room_id) {
      fail('SNAPSHOT_REBASE_INVALID', 'source snapshot belongs to another room');
    }
    if (!Number.isSafeInteger(state_revision) || state_revision < 0
      || state_revision <= source.state_revision) {
      fail(
        'SNAPSHOT_REBASE_INVALID',
        'rebased snapshot revision must increase monotonically'
      );
    }
    const state = canonicalizeJson(assertReducerDomainState(source.state));
    state.meta.state_revision = state_revision;
    const rebased = seal({
      room_id,
      epoch_id,
      checkpoint_id,
      snapshot_id,
      state_revision,
      state
    });
    if (rebased.state_hash !== source.state_hash) {
      fail(
        'BASE_HASH_MISMATCH',
        'rebasing a snapshot revision changed canonical state content'
      );
    }
    return rebased;
  }

  function readRow({ room_id, checkpoint_id = null, epoch_id = null, state_revision = null }) {
    return connection.read(database => {
      let row;
      if (checkpoint_id !== null) {
        row = database.prepare(`
          SELECT * FROM room_snapshots WHERE room_id = ? AND checkpoint_id = ?
        `).get(room_id, checkpoint_id);
      } else if (epoch_id !== null && state_revision !== null) {
        row = database.prepare(`
          SELECT * FROM room_snapshots
           WHERE room_id = ? AND epoch_id = ? AND state_revision = ?
        `).get(room_id, epoch_id, state_revision);
      } else {
        row = database.prepare(`
          SELECT s.* FROM multiplayer_rooms AS r
          JOIN room_epochs AS e ON e.epoch_id = r.active_epoch_id
          JOIN room_snapshots AS s ON s.checkpoint_id = e.head_checkpoint_id
           WHERE r.room_id = ?
        `).get(room_id);
      }
      if (!row) fail('SNAPSHOT_NOT_FOUND', 'authoritative room snapshot does not exist', {}, 404);
      const state = assertReducerDomainState(contentCodec.openJson(
        openEnvelope(row),
        snapshotContext(row)
      ));
      if (state.meta.state_revision !== row.state_revision || stateHash(state) !== row.state_hash) {
        fail('SNAPSHOT_CORRUPT', 'authoritative snapshot revision or hash does not match');
      }
      return Object.freeze({
        snapshot_id: row.snapshot_id,
        room_id: row.room_id,
        epoch_id: row.epoch_id,
        checkpoint_id: row.checkpoint_id,
        state_revision: row.state_revision,
        state_hash: row.state_hash,
        state,
        created_at: row.created_at
      });
    });
  }

  return Object.freeze({ seal, rebase, readInternal: readRow, stateHash });
}

/**
 * Builds the local, pre-transaction snapshot step used by continuation
 * activation. Proposal authority and the final revision/control CAS remain in
 * sqlite-lineage-repository; this function only authenticates, rebases and
 * encrypts the selected immutable state before that short transaction.
 */
export function createContinuationSnapshotPreparer({
  connection,
  snapshotService,
  saveImportRepository,
  readLatestSourceState = null
}) {
  if (!connection || typeof connection.read !== 'function'
    || typeof snapshotService?.readInternal !== 'function'
    || typeof snapshotService?.rebase !== 'function'
    || typeof snapshotService?.seal !== 'function') {
    fail(
      'CONTINUATION_SNAPSHOT_CONFIGURATION_INVALID',
      'continuation snapshot dependencies are incomplete'
    );
  }
  const latestReader = readLatestSourceState ?? (async ({
    authenticated_user_id,
    source_snapshot_ref
  }) => {
    if (typeof saveImportRepository?.prepareForRoom !== 'function') {
      fail(
        'CONTINUATION_SNAPSHOT_CONFIGURATION_INVALID',
        'latest-source snapshot reader is not configured'
      );
    }
    const prepared = await saveImportRepository.prepareForRoom({
      authenticated_user_id,
      import_id: source_snapshot_ref
    });
    return prepared.state;
  });
  if (typeof latestReader !== 'function') {
    fail(
      'CONTINUATION_SNAPSHOT_CONFIGURATION_INVALID',
      'latest-source snapshot reader must be a function'
    );
  }

  return async function prepareContinuationSnapshot(context) {
    const basis = connection.read(database => database.prepare(`
      SELECT p.proposal_type, p.proposal_status, p.target_checkpoint_id,
             p.source_import_id, r.state_revision, r.lifecycle,
             s.genesis_state_hash, s.source_snapshot_ref
        FROM room_control_proposals AS p
        JOIN multiplayer_rooms AS r ON r.room_id = p.room_id
        LEFT JOIN room_source_imports AS s
          ON s.room_id = p.room_id AND s.source_import_id = p.source_import_id
       WHERE p.room_id = ? AND p.proposal_id = ?
    `).get(context.room_id, context.proposal.proposal_id));
    if (!basis || basis.proposal_status !== 'ACCEPTED') {
      fail(
        'PROPOSAL_NOT_ACCEPTED',
        'continuation snapshot requires the accepted authoritative proposal',
        {},
        409
      );
    }
    if (basis.lifecycle !== 'ARCHIVED') {
      fail('ROOM_NOT_AT_CHECKPOINT', 'continuation snapshot requires an archived room', {}, 409);
    }
    const nextStateRevision = basis.state_revision + 1;
    if (!Number.isSafeInteger(nextStateRevision)) {
      fail('STATE_REVISION_EXHAUSTED', 'room state revision cannot increase safely');
    }

    if (basis.proposal_type === 'resume_room_checkpoint') {
      const source = snapshotService.readInternal({
        room_id: context.room_id,
        checkpoint_id: basis.target_checkpoint_id
      });
      return snapshotService.rebase({
        source,
        room_id: context.room_id,
        epoch_id: context.new_epoch_id,
        checkpoint_id: context.new_genesis_checkpoint_id,
        snapshot_id: context.new_snapshot_id,
        state_revision: nextStateRevision
      });
    }
    if (basis.proposal_type !== 'fork_from_latest_source_save'
      || !basis.source_import_id
      || !basis.source_snapshot_ref
      || !basis.genesis_state_hash) {
      fail('SOURCE_IMPORT_CHANGED', 'accepted continuation source is incomplete', {}, 409);
    }
    const value = await latestReader(Object.freeze({
      authenticated_user_id: context.authenticated_user_id,
      room_id: context.room_id,
      source_import_id: basis.source_import_id,
      source_snapshot_ref: basis.source_snapshot_ref
    }));
    const state = canonicalizeJson(assertReducerDomainState(value?.state ?? value));
    state.meta.state_revision = nextStateRevision;
    if (snapshotService.stateHash(state) !== basis.genesis_state_hash) {
      fail(
        'BASE_HASH_MISMATCH',
        'latest-source snapshot differs from its accepted normalized genesis'
      );
    }
    return snapshotService.seal({
      room_id: context.room_id,
      epoch_id: context.new_epoch_id,
      checkpoint_id: context.new_genesis_checkpoint_id,
      snapshot_id: context.new_snapshot_id,
      state_revision: nextStateRevision,
      state
    });
  };
}
