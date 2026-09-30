import { randomUUID } from 'node:crypto';

import { assertTimelineSave } from '../../../js/core/timeline-save-schema.js';
import {
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { roomCheckpointStateHash } from '../domain/lineage.js';
import { assertReducerDomainState } from '../domain/reducers/index.js';

const STAGED_PAYLOAD_SCHEMA = 'naruto.multiplayer-save-import-staged-payload/v1';
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;

function fail(code, message, details = {}, status = 400, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('SAVE_IMPORT_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL_PATTERN.test(value)) {
    fail('SAVE_IMPORT_REQUEST_INVALID', 'authenticated_user_id is invalid');
  }
  return value;
}

function boundedText(value, label, { nullable = false, max = 200 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail('SAVE_IMPORT_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function hash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function stateHash(value) {
  return roomCheckpointStateHash(value, {
    A: value.actors.A.room_actor_id,
    B: value.actors.B.room_actor_id
  });
}

function timelineMeta(timeline) {
  return timeline.meta?.value ?? timeline.timeline?.meta ?? timeline.meta;
}

function sourceTimeline(value, sourceBranchId, sourceNodeId) {
  if (value === null || value === undefined) return null;
  let timeline;
  try {
    timeline = canonicalizeJson(value);
    assertTimelineSave(timeline);
  } catch (error) {
    fail(
      'SOURCE_OWNER_TIMELINE_INVALID',
      'source_timeline failed the existing timeline constraints',
      {},
      400,
      error
    );
  }
  const meta = timelineMeta(timeline);
  const branch = timeline.branches.find(candidate => candidate.id === sourceBranchId);
  const node = timeline.nodes.find(candidate => candidate.id === sourceNodeId);
  if (!branch
    || !node
    || branch.head_node_id !== sourceNodeId
    || node.branch_id !== sourceBranchId
    || meta?.active_branch !== sourceBranchId
    || meta?.current_id !== sourceNodeId) {
    fail(
      'SOURCE_OWNER_TIMELINE_CHANGED',
      'source branch and node must be the current active branch head',
      { source_branch_id: sourceBranchId, source_node_id: sourceNodeId },
      409
    );
  }
  return timeline;
}

function stagedPayload(state, timeline) {
  return {
    schema: STAGED_PAYLOAD_SCHEMA,
    state,
    source_timeline: timeline
  };
}

function decodeStagedPayload(contentCodec, row) {
  let opened;
  try {
    opened = contentCodec.openJson(envelope(row), context(row));
  } catch (error) {
    if (error?.code === 'SAVE_IMPORT_CORRUPT') throw error;
    fail('SAVE_IMPORT_CORRUPT', 'save import envelope could not be authenticated', {}, 500, error);
  }
  if (opened?.schema !== STAGED_PAYLOAD_SCHEMA) {
    try {
      return { state: assertReducerDomainState(opened), source_timeline: null };
    } catch (error) {
      fail('SAVE_IMPORT_CORRUPT', 'legacy save import state is invalid', {}, 500, error);
    }
  }
  if (!opened || typeof opened !== 'object' || Array.isArray(opened)
    || !Object.prototype.hasOwnProperty.call(opened, 'state')
    || !Object.prototype.hasOwnProperty.call(opened, 'source_timeline')) {
    fail('SAVE_IMPORT_CORRUPT', 'save import staged payload is malformed', {}, 500);
  }
  try {
    return {
      state: assertReducerDomainState(opened.state),
      source_timeline: sourceTimeline(
        opened.source_timeline,
        row.source_branch_id,
        row.source_node_id
      )
    };
  } catch (error) {
    fail('SAVE_IMPORT_CORRUPT', 'save import staged payload failed validation', {}, 500, error);
  }
}

function context(row) {
  return {
    schema: 'naruto.multiplayer-save-import-staging-context/v1',
    import_id: row.import_id,
    owner_user_id: row.owner_user_id,
    source_save_id: row.source_save_id,
    client_save_instance_id: row.client_save_instance_id,
    source_branch_id: row.source_branch_id,
    source_node_id: row.source_node_id,
    state_hash: row.state_hash
  };
}

function envelope(row) {
  return {
    action_ciphertext: row.snapshot_ciphertext,
    wrapped_data_key: row.wrapped_data_key,
    nonce: row.nonce,
    auth_tag: row.auth_tag,
    master_key_version: row.master_key_version
  };
}

function projection(row) {
  return Object.freeze({
    import_id: row.import_id,
    source_save_id: row.source_save_id,
    client_save_instance_id: row.client_save_instance_id,
    source_branch_id: row.source_branch_id,
    source_node_id: row.source_node_id,
    cloud_revision: row.cloud_revision,
    state_hash: row.state_hash,
    status: row.import_status,
    consumed_room_id: row.consumed_room_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at
  });
}

export function createSqliteSaveImportStagingRepository(connection, {
  contentCodec,
  clock = () => new Date().toISOString(),
  idFactory = () => `import_${randomUUID().replaceAll('-', '')}`,
  ttlMs = 24 * 60 * 60 * 1_000
} = {}) {
  if (!connection || typeof connection.read !== 'function' || typeof connection.write !== 'function'
    || typeof contentCodec?.sealJson !== 'function' || typeof contentCodec?.openJson !== 'function') {
    fail('SAVE_IMPORT_REPOSITORY_INVALID', 'SQLite connection and content codec are required', {}, 500);
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) {
    fail('SAVE_IMPORT_REPOSITORY_INVALID', 'save import TTL must be at least one minute', {}, 500);
  }

  return Object.freeze({
    async create({
      authenticated_user_id,
      source_save_id,
      client_save_instance_id,
      source_branch_id,
      source_node_id,
      cloud_revision = null,
      state,
      source_timeline = null,
      idempotency_key
    }) {
      const ownerUserId = principal(authenticated_user_id);
      const sourceBranchId = identifier(source_branch_id, 'source_branch_id');
      const sourceNodeId = identifier(source_node_id, 'source_node_id');
      const request = {
        source_save_id: identifier(source_save_id, 'source_save_id'),
        client_save_instance_id: identifier(client_save_instance_id, 'client_save_instance_id'),
        source_branch_id: sourceBranchId,
        source_node_id: sourceNodeId,
        cloud_revision: cloud_revision === null
          ? null
          : boundedText(cloud_revision, 'cloud_revision', { max: 160 }),
        state: assertReducerDomainState(state),
        source_timeline: sourceTimeline(source_timeline, sourceBranchId, sourceNodeId),
        idempotency_key: boundedText(idempotency_key, 'idempotency_key')
      };
      const requestHash = hash(request);
      const stagedStateHash = stateHash(request.state);
      const importId = identifier(idFactory('import'), 'import_id');
      const createdAt = clock();
      const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
      const rowForCodec = {
        import_id: importId,
        owner_user_id: ownerUserId,
        ...request,
        state_hash: stagedStateHash
      };
      const sealed = contentCodec.sealJson(
        stagedPayload(request.state, request.source_timeline),
        context(rowForCodec)
      );
      return connection.write(database => {
        const existing = database.prepare(`
          SELECT * FROM save_import_staging
           WHERE owner_user_id = ? AND idempotency_key = ?
        `).get(ownerUserId, request.idempotency_key);
        if (existing) {
          if (existing.request_hash !== requestHash) {
            fail('IDEMPOTENCY_CONFLICT', 'save import idempotency key was reused with another payload', {}, 409);
          }
          return Object.freeze({ import: projection(existing), replayed: true });
        }
        database.prepare(`
          INSERT INTO save_import_staging (
            import_id, owner_user_id, idempotency_key, request_hash,
            source_save_id, client_save_instance_id, source_branch_id,
            source_node_id, cloud_revision, state_hash, snapshot_ciphertext,
            wrapped_data_key, nonce, auth_tag, master_key_version,
            import_status, consumed_room_id, created_at, expires_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'READY', NULL, ?, ?, NULL)
        `).run(
          importId,
          ownerUserId,
          request.idempotency_key,
          requestHash,
          request.source_save_id,
          request.client_save_instance_id,
          request.source_branch_id,
          request.source_node_id,
          request.cloud_revision,
          stagedStateHash,
          sealed.action_ciphertext,
          sealed.wrapped_data_key,
          sealed.nonce,
          sealed.auth_tag,
          sealed.master_key_version,
          createdAt,
          expiresAt
        );
        return Object.freeze({
          import: projection(database.prepare(`SELECT * FROM save_import_staging WHERE import_id = ?`)
            .get(importId)),
          replayed: false
        });
      });
    },

    get({ authenticated_user_id, import_id }) {
      const ownerUserId = principal(authenticated_user_id);
      const importId = identifier(import_id, 'import_id');
      return connection.read(database => {
        const row = database.prepare(`
          SELECT * FROM save_import_staging WHERE import_id = ? AND owner_user_id = ?
        `).get(importId, ownerUserId);
        if (!row) fail('SAVE_IMPORT_NOT_FOUND', 'save import does not exist', {}, 404);
        return projection(row);
      });
    },

    prepareForRoom({ authenticated_user_id, import_id }) {
      const ownerUserId = principal(authenticated_user_id);
      const importId = identifier(import_id, 'import_id');
      return connection.read(database => {
        const row = database.prepare(`
          SELECT * FROM save_import_staging WHERE import_id = ? AND owner_user_id = ?
        `).get(importId, ownerUserId);
        if (!row) fail('SAVE_IMPORT_NOT_FOUND', 'save import does not exist', {}, 404);
        if (row.import_status !== 'READY') {
          fail('SAVE_IMPORT_NOT_READY', 'save import is already consumed or expired', {}, 409);
        }
        if (Date.parse(row.expires_at) <= Date.parse(clock())) {
          fail('SAVE_IMPORT_EXPIRED', 'save import staging record has expired', {}, 409);
        }
        const { state, source_timeline: preservedTimeline } = decodeStagedPayload(contentCodec, row);
        if (stateHash(state) !== row.state_hash) {
          fail('SAVE_IMPORT_CORRUPT', 'save import state hash does not match its envelope', {}, 500);
        }
        return Object.freeze({
          import: projection(row),
          state,
          source_timeline: preservedTimeline
        });
      });
    },

    prepareConsumedForRoom({ room_id, import_id }) {
      const roomId = identifier(room_id, 'room_id');
      const importId = identifier(import_id, 'import_id');
      return connection.read(database => {
        const row = database.prepare(`
          SELECT s.*
            FROM save_import_staging AS s
            JOIN multiplayer_rooms AS r
              ON r.room_id = s.consumed_room_id
             AND r.origin_snapshot_id = s.import_id
           WHERE s.import_id = ? AND s.consumed_room_id = ?
             AND s.import_status = 'CONSUMED'
        `).get(importId, roomId);
        if (!row) {
          fail(
            'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
            'consumed Room origin source is unavailable',
            {},
            409
          );
        }
        const payload = decodeStagedPayload(contentCodec, row);
        if (stateHash(payload.state) !== row.state_hash) {
          fail('SAVE_IMPORT_CORRUPT', 'save import state hash does not match its envelope', {}, 500);
        }
        if (payload.source_timeline === null) {
          fail(
            'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
            'Room origin did not preserve a validated single-player timeline',
            {},
            409
          );
        }
        return Object.freeze({
          import: projection(row),
          state: payload.state,
          source_timeline: payload.source_timeline
        });
      });
    },

    getSourceTimelineForRoom({ authenticated_user_id, room_id, import_id }) {
      const authenticatedUserId = principal(authenticated_user_id);
      const roomId = identifier(room_id, 'room_id');
      const importId = identifier(import_id, 'import_id');
      return connection.read(database => {
        const row = database.prepare(`
          SELECT s.*, r.origin_type, r.origin_owner_user_id, r.origin_snapshot_id
            FROM multiplayer_rooms AS r
            JOIN save_import_staging AS s
              ON s.import_id = r.origin_snapshot_id
             AND s.consumed_room_id = r.room_id
           WHERE r.room_id = ? AND s.import_id = ?
        `).get(roomId, importId);
        if (!row
          || row.origin_type !== 'existing_save_derived'
          || row.origin_snapshot_id !== importId) {
          fail(
            'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
            'Room origin source timeline is unavailable',
            {},
            409
          );
        }
        if (row.origin_owner_user_id !== authenticatedUserId
          || row.owner_user_id !== authenticatedUserId) {
          fail(
            'SOURCE_OWNER_REQUIRED',
            'only the immutable source owner may read the Room origin timeline',
            {},
            403
          );
        }
        const payload = decodeStagedPayload(contentCodec, row);
        if (stateHash(payload.state) !== row.state_hash) {
          fail('SAVE_IMPORT_CORRUPT', 'save import state hash does not match its envelope', {}, 500);
        }
        if (payload.source_timeline === null) {
          fail(
            'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
            'legacy save import did not preserve a trusted source timeline',
            {},
            409
          );
        }
        return Object.freeze({
          timeline: payload.source_timeline,
          source_branch_id: row.source_branch_id,
          source_node_id: row.source_node_id
        });
      });
    }
  });
}
