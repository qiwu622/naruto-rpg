import {
  assertJsonSafe,
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { roomCheckpointStateHash } from '../domain/lineage.js';
import { assertReducerDomainState } from '../domain/reducers/index.js';
import { assertTimelineSave } from '../../../js/core/timeline-save-schema.js';

const PAYLOAD_SCHEMA = 'naruto.multiplayer-latest-source-snapshot/v1';
const ID = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;

function fail(code, message, details = {}, status = 400, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('LATEST_SOURCE_SNAPSHOT_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL.test(value)) {
    fail('LATEST_SOURCE_SNAPSHOT_INVALID', 'authenticated_user_id is invalid', {}, 401);
  }
  return value;
}

function sha(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail('LATEST_SOURCE_SNAPSHOT_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function hash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function normalizedStateHash(value) {
  const state = canonicalizeJson(assertReducerDomainState(value));
  delete state.meta;
  return hash(state);
}

function context(row) {
  return {
    schema: 'naruto.multiplayer-latest-source-snapshot-context/v1',
    snapshot_ref: row.snapshot_ref,
    source_import_id: row.source_import_id,
    room_id: row.room_id,
    lineage_id: row.lineage_id,
    owner_user_id: row.owner_user_id,
    request_hash: row.request_hash,
    raw_source_hash: row.raw_source_hash,
    normalized_source_hash: row.normalized_source_hash,
    normalization_and_rebind_diff_hash: row.normalization_and_rebind_diff_hash,
    genesis_state_hash: row.genesis_state_hash
  };
}

function envelope(row) {
  return {
    action_ciphertext: Buffer.from(row.payload_ciphertext),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  };
}

function validatePayload(value, row) {
  assertJsonSafe(value, { maxDepth: 128, maxNodes: 1_000_000 });
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== PAYLOAD_SCHEMA
    || !value.actor_control_by_seat
    || !value.rebind_diff) {
    fail('LATEST_SOURCE_SNAPSHOT_CORRUPT', 'latest-source snapshot payload is malformed', {}, 500);
  }
  let timeline;
  let normalized;
  let genesis;
  try {
    timeline = canonicalizeJson(value.raw_source_document);
    assertTimelineSave(timeline);
    normalized = canonicalizeJson(assertReducerDomainState(value.normalized_room_state));
    genesis = canonicalizeJson(assertReducerDomainState(value.genesis_room_state));
  } catch (error) {
    fail(
      'LATEST_SOURCE_SNAPSHOT_CORRUPT',
      'latest-source snapshot payload failed its schema validators',
      {},
      500,
      error
    );
  }
  const control = value.actor_control_by_seat;
  if (!control || typeof control !== 'object' || Array.isArray(control)
    || typeof control.A !== 'string' || typeof control.B !== 'string'
    || control.A === control.B
    || hash(timeline) !== row.raw_source_hash
    || normalizedStateHash(normalized) !== row.normalized_source_hash
    || hash(value.rebind_diff) !== row.normalization_and_rebind_diff_hash
    || roomCheckpointStateHash(genesis, control) !== row.genesis_state_hash) {
    fail('LATEST_SOURCE_SNAPSHOT_CORRUPT', 'latest-source snapshot hash closure failed', {}, 500);
  }
  return Object.freeze({
    raw_source_document: timeline,
    normalized_room_state: normalized,
    genesis_room_state: genesis,
    actor_control_by_seat: canonicalizeJson(control),
    rebind_diff: canonicalizeJson(value.rebind_diff)
  });
}

function openPayload(contentCodec, row) {
  try {
    return validatePayload(contentCodec.openJson(envelope(row), context(row)), row);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail(
      'LATEST_SOURCE_SNAPSHOT_CORRUPT',
      'latest-source snapshot envelope could not be authenticated',
      {},
      500,
      error
    );
  }
}

export function createSqliteLatestSourceSnapshotStore(connection, {
  contentCodec,
  clock = () => new Date().toISOString()
} = {}) {
  if (!connection || typeof connection.read !== 'function'
    || typeof connection.write !== 'function'
    || typeof contentCodec?.sealJson !== 'function'
    || typeof contentCodec?.openJson !== 'function') {
    fail(
      'LATEST_SOURCE_SNAPSHOT_CONFIGURATION_INVALID',
      'SQLite connection and encrypted content codec are required',
      {},
      500
    );
  }

  async function put(value) {
    const row = {
      snapshot_ref: identifier(value.snapshot_ref, 'snapshot_ref'),
      source_import_id: identifier(value.source_import_id, 'source_import_id'),
      room_id: identifier(value.room_id, 'room_id'),
      lineage_id: identifier(value.lineage_id, 'lineage_id'),
      owner_user_id: principal(value.owner_user_id),
      source_save_id: identifier(value.source_save_id, 'source_save_id'),
      client_save_instance_id: identifier(
        value.client_save_instance_id,
        'client_save_instance_id'
      ),
      source_branch_id: identifier(value.source_branch_id, 'source_branch_id'),
      source_node_id: identifier(value.source_node_id, 'source_node_id'),
      cloud_revision: value.cloud_revision ?? null,
      derived_from_export_id: identifier(
        value.derived_from_export_id,
        'derived_from_export_id'
      ),
      request_hash: sha(value.request_hash, 'request_hash'),
      raw_source_hash: sha(value.raw_source_hash, 'raw_source_hash'),
      normalized_source_hash: sha(value.normalized_source_hash, 'normalized_source_hash'),
      normalization_and_rebind_diff_hash: sha(
        value.normalization_and_rebind_diff_hash,
        'normalization_and_rebind_diff_hash'
      ),
      genesis_state_hash: sha(value.genesis_state_hash, 'genesis_state_hash')
    };
    if (row.cloud_revision !== null
      && (typeof row.cloud_revision !== 'string' || row.cloud_revision.length > 160)) {
      fail('LATEST_SOURCE_SNAPSHOT_INVALID', 'cloud_revision is invalid');
    }
    const payload = {
      schema: PAYLOAD_SCHEMA,
      raw_source_document: value.raw_source_document,
      normalized_room_state: value.normalized_room_state,
      genesis_room_state: value.genesis_room_state,
      actor_control_by_seat: value.actor_control_by_seat,
      rebind_diff: value.rebind_diff
    };
    validatePayload(payload, row);
    const sealed = contentCodec.sealJson(payload, context(row));
    const createdAt = clock();
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
      fail('LATEST_SOURCE_SNAPSHOT_CONFIGURATION_INVALID', 'clock returned an invalid timestamp', {}, 500);
    }
    return connection.write(database => {
      const existing = database.prepare(`
        SELECT * FROM latest_source_snapshots
         WHERE snapshot_ref = ? OR source_import_id = ?
         LIMIT 1
      `).get(row.snapshot_ref, row.source_import_id);
      if (existing) {
        if (existing.snapshot_ref !== row.snapshot_ref
          || existing.source_import_id !== row.source_import_id
          || existing.request_hash !== row.request_hash) {
          fail('SOURCE_IMPORT_CHANGED', 'latest-source snapshot identity was reused', {}, 409);
        }
        openPayload(contentCodec, existing);
        return Object.freeze({ snapshot_ref: existing.snapshot_ref, replayed: true });
      }
      database.prepare(`
        INSERT INTO latest_source_snapshots (
          snapshot_ref, source_import_id, room_id, lineage_id, owner_user_id,
          source_save_id, client_save_instance_id, source_branch_id,
          source_node_id, cloud_revision, derived_from_export_id, request_hash,
          raw_source_hash, normalized_source_hash,
          normalization_and_rebind_diff_hash, genesis_state_hash,
          payload_ciphertext, wrapped_data_key, nonce, auth_tag,
          master_key_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.snapshot_ref,
        row.source_import_id,
        row.room_id,
        row.lineage_id,
        row.owner_user_id,
        row.source_save_id,
        row.client_save_instance_id,
        row.source_branch_id,
        row.source_node_id,
        row.cloud_revision,
        row.derived_from_export_id,
        row.request_hash,
        row.raw_source_hash,
        row.normalized_source_hash,
        row.normalization_and_rebind_diff_hash,
        row.genesis_state_hash,
        sealed.action_ciphertext,
        sealed.wrapped_data_key,
        sealed.nonce,
        sealed.auth_tag,
        sealed.master_key_version,
        createdAt
      );
      return Object.freeze({ snapshot_ref: row.snapshot_ref, replayed: false });
    });
  }

  function validatedRow({ roomId, sourceImportId, sourceSnapshotRef }) {
    return connection.read(database => database.prepare(`
      SELECT s.*
        FROM latest_source_snapshots AS s
        JOIN room_source_imports AS i
          ON i.source_import_id = s.source_import_id
         AND i.room_id = s.room_id
         AND i.source_snapshot_ref = s.snapshot_ref
         AND i.validation_status = 'VALID'
       WHERE s.room_id = ? AND s.source_import_id = ? AND s.snapshot_ref = ?
    `).get(roomId, sourceImportId, sourceSnapshotRef));
  }

  async function readLatestSourceState({
    authenticated_user_id,
    room_id,
    source_import_id,
    source_snapshot_ref
  }) {
    const authenticatedUserId = principal(authenticated_user_id);
    const roomId = identifier(room_id, 'room_id');
    const sourceImportId = identifier(source_import_id, 'source_import_id');
    const sourceSnapshotRef = identifier(source_snapshot_ref, 'source_snapshot_ref');
    const authorized = connection.read(database => database.prepare(`
      SELECT 1 AS present
        FROM multiplayer_members
       WHERE room_id = ? AND user_id = ? AND member_status = 'ACTIVE'
    `).get(roomId, authenticatedUserId));
    if (!authorized) fail('ROOM_MEMBERSHIP_REQUIRED', 'active Room membership is required', {}, 403);
    const row = validatedRow({ roomId, sourceImportId, sourceSnapshotRef });
    if (!row) fail('SOURCE_IMPORT_CHANGED', 'validated latest-source snapshot is unavailable', {}, 409);
    const payload = openPayload(contentCodec, row);
    return Object.freeze({ state: payload.genesis_room_state });
  }

  async function getSourceTimelineForRoom({
    authenticated_user_id,
    room_id,
    source_import_id,
    source_snapshot_ref
  }) {
    const authenticatedUserId = principal(authenticated_user_id);
    const roomId = identifier(room_id, 'room_id');
    const sourceImportId = identifier(source_import_id, 'source_import_id');
    const sourceSnapshotRef = identifier(source_snapshot_ref, 'source_snapshot_ref');
    const room = connection.read(database => database.prepare(`
      SELECT origin_type, origin_owner_user_id, lineage_id
        FROM multiplayer_rooms WHERE room_id = ?
    `).get(roomId));
    if (!room || room.origin_type !== 'existing_save_derived') {
      fail('SOURCE_OWNER_TIMELINE_UNAVAILABLE', 'latest source timeline is unavailable', {}, 409);
    }
    if (room.origin_owner_user_id !== authenticatedUserId) {
      fail('SOURCE_OWNER_REQUIRED', 'only the immutable source owner may read the source timeline', {}, 403);
    }
    const row = validatedRow({ roomId, sourceImportId, sourceSnapshotRef });
    if (!row || row.owner_user_id !== authenticatedUserId || row.lineage_id !== room.lineage_id) {
      fail('SOURCE_OWNER_TIMELINE_UNAVAILABLE', 'validated latest source timeline is unavailable', {}, 409);
    }
    const payload = openPayload(contentCodec, row);
    return Object.freeze({
      timeline: payload.raw_source_document,
      source_branch_id: row.source_branch_id,
      source_node_id: row.source_node_id
    });
  }

  return Object.freeze({ put, readLatestSourceState, getSourceTimelineForRoom });
}

export { PAYLOAD_SCHEMA as LATEST_SOURCE_SNAPSHOT_PAYLOAD_SCHEMA };
