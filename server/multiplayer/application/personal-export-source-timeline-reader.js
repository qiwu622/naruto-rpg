import { assertTimelineSave } from '../../../js/core/timeline-save-schema.js';
import { canonicalizeJson } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

const ID = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;

function fail(code, message, details = {}, status = 400, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('SOURCE_OWNER_TIMELINE_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL.test(value)) {
    fail('SOURCE_OWNER_TIMELINE_REQUEST_INVALID', 'authenticated_user_id is invalid', {}, 401);
  }
  return value;
}

function opaqueReference(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) {
    fail('SOURCE_OWNER_TIMELINE_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function timelineMeta(timeline) {
  return timeline.meta?.value ?? timeline.timeline?.meta ?? timeline.meta;
}

function authenticatedTimeline(read, sourceBasis) {
  if (!read?.timeline) {
    fail(
      'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
      'immutable source storage returned no authenticated timeline',
      {},
      409
    );
  }
  let timeline;
  try {
    timeline = canonicalizeJson(read.timeline);
    assertTimelineSave(timeline);
  } catch (error) {
    fail(
      'SOURCE_OWNER_TIMELINE_INVALID',
      'immutable source timeline failed the existing timeline constraints',
      {},
      409,
      error
    );
  }
  const meta = timelineMeta(timeline);
  const branch = timeline.branches.find(candidate => (
    candidate.id === sourceBasis.source_branch_id
  ));
  const node = timeline.nodes.find(candidate => candidate.id === sourceBasis.source_node_id);
  if (!branch
    || !node
    || branch.head_node_id !== node.id
    || node.branch_id !== branch.id
    || meta?.active_branch !== branch.id
    || meta?.current_id !== node.id
    || (read.source_branch_id !== undefined
      && read.source_branch_id !== sourceBasis.source_branch_id)
    || (read.source_node_id !== undefined
      && read.source_node_id !== sourceBasis.source_node_id)) {
    fail(
      'SOURCE_OWNER_TIMELINE_CHANGED',
      'immutable source timeline no longer matches its selected branch head',
      {
        source_branch_id: sourceBasis.source_branch_id,
        source_node_id: sourceBasis.source_node_id
      },
      409
    );
  }
  return Object.freeze({
    timeline,
    source_branch_id: sourceBasis.source_branch_id,
    source_node_id: sourceBasis.source_node_id
  });
}

/**
 * Resolves the real singleplayer timeline at the source basis selected by the
 * checkpoint ancestry. The origin staging repository and the later-source
 * snapshot store remain separate authority boundaries; neither is allowed to
 * synthesize a timeline from multiplayer state.
 */
export function createPersonalExportSourceTimelineReader({
  saveImportRepository,
  latestSourceSnapshotStore = null
}) {
  if (typeof saveImportRepository?.getSourceTimelineForRoom !== 'function') {
    fail(
      'SOURCE_OWNER_TIMELINE_CONFIGURATION_INVALID',
      'origin save import timeline reader is required',
      {},
      500
    );
  }
  if (latestSourceSnapshotStore !== null
    && typeof latestSourceSnapshotStore?.getSourceTimelineForRoom !== 'function') {
    fail(
      'SOURCE_OWNER_TIMELINE_CONFIGURATION_INVALID',
      'latest source snapshot store must expose getSourceTimelineForRoom',
      {},
      500
    );
  }

  async function getForOwner({ authenticated_user_id, room_id, source_basis }) {
    const authenticatedUserId = principal(authenticated_user_id);
    const roomId = identifier(room_id, 'room_id');
    if (!source_basis || typeof source_basis !== 'object' || Array.isArray(source_basis)) {
      fail('SOURCE_OWNER_TIMELINE_REQUEST_INVALID', 'source_basis is invalid');
    }
    const basis = {
      type: source_basis.type,
      ref_id: opaqueReference(source_basis.ref_id, 'source_basis.ref_id'),
      source_branch_id: identifier(
        source_basis.source_branch_id,
        'source_basis.source_branch_id'
      ),
      source_node_id: identifier(source_basis.source_node_id, 'source_basis.source_node_id')
    };
    let read;
    if (basis.type === 'origin_snapshot') {
      read = await saveImportRepository.getSourceTimelineForRoom({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId,
        import_id: identifier(basis.ref_id, 'source_basis.ref_id')
      });
    } else if (basis.type === 'latest_source_import') {
      if (latestSourceSnapshotStore === null) {
        fail(
          'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
          'latest source snapshot storage is not configured for personal export',
          {},
          409
        );
      }
      read = await latestSourceSnapshotStore.getSourceTimelineForRoom({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId,
        source_import_id: identifier(
          source_basis.source_import_id,
          'source_basis.source_import_id'
        ),
        source_snapshot_ref: basis.ref_id
      });
    } else {
      fail(
        'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
        'checkpoint ancestry does not reference a playable source timeline',
        {},
        409
      );
    }
    return authenticatedTimeline(read, basis);
  }

  return Object.freeze({ getForOwner });
}
