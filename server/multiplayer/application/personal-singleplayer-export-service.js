import { DomainError } from '../domain/errors.js';
import { deterministicRoomActorBindingMaterial } from './room-application-service.js';

const ID = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;
const FAILURE_CODE = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const ALLOWED_BEGIN_FIELDS = new Set([
  'idempotency_key',
  'projection_version',
  'output_format'
]);

function fail(code, message, details = {}, status = 400, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL.test(value)) {
    fail('PERSONAL_EXPORT_REQUEST_INVALID', 'authenticated_user_id is invalid', {}, 401);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('PERSONAL_EXPORT_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function beginRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PERSONAL_EXPORT_REQUEST_INVALID', 'personal export request must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_BEGIN_FIELDS.has(key)) {
      fail(
        'PERSONAL_EXPORT_REQUEST_INVALID',
        'personal export request contains an authority or unknown field',
        { field: key }
      );
    }
  }
  if (typeof value.idempotency_key !== 'string'
    || !value.idempotency_key
    || value.idempotency_key.length > 200) {
    fail('PERSONAL_EXPORT_REQUEST_INVALID', 'idempotency_key is invalid');
  }
  const projectionVersion = value.projection_version ?? 'projection-v1';
  const outputFormat = value.output_format ?? 'timeline-json-v1';
  identifier(projectionVersion, 'projection_version');
  identifier(outputFormat, 'output_format');
  if (outputFormat !== 'timeline-json-v1') {
    fail(
      'UNSUPPORTED_EXPORT_FORMAT',
      'personal playable exports currently require timeline-json-v1'
    );
  }
  return Object.freeze({
    idempotency_key: value.idempotency_key,
    projection_version: projectionVersion,
    output_format: outputFormat
  });
}

function assertDependencies(dependencies) {
  const checks = [
    ['lineageRepository.personalExports.begin', dependencies.lineageRepository?.personalExports?.begin],
    ['lineageRepository.personalExports.complete', dependencies.lineageRepository?.personalExports?.complete],
    ['lineageRepository.personalExports.markFailed', dependencies.lineageRepository?.personalExports?.markFailed],
    ['lineageRepository.personalExports.getForDownload',
      dependencies.lineageRepository?.personalExports?.getForDownload],
    ['lineageRepository.bindings.verifyPairForPersonalExport',
      dependencies.lineageRepository?.bindings?.verifyPairForPersonalExport],
    ['coreRepositories.turns/actions.getForMember',
      dependencies.coreRepositories?.actions?.getForMember
        ?? dependencies.coreRepositories?.turns?.getForMember],
    ['snapshotService.readInternal', dependencies.snapshotService?.readInternal],
    ['exportSourceRepository.loadCheckpointChain',
      dependencies.exportSourceRepository?.loadCheckpointChain],
    ['exportSourceRepository.getNarrativeForMember',
      dependencies.exportSourceRepository?.getNarrativeForMember],
    ['sourceTimelineReader.getForOwner', dependencies.sourceTimelineReader?.getForOwner],
    ['outputStore.put', dependencies.outputStore?.put],
    ['outputStore.get', dependencies.outputStore?.get],
    ['codec.encode', dependencies.codec?.encode],
    ['codec.assertOutput', dependencies.codec?.assertOutput],
    ['codec.outputHash', dependencies.codec?.outputHash]
  ];
  const missing = checks.filter(([, method]) => typeof method !== 'function').map(([name]) => name);
  if (missing.length > 0
    || typeof dependencies.bindingTokenSecret !== 'string'
    || !dependencies.bindingTokenSecret) {
    fail(
      'PERSONAL_EXPORT_SERVICE_CONFIGURATION_INVALID',
      'personal export service dependencies are incomplete',
      { missing },
      500
    );
  }
}

function failureCode(error) {
  if (typeof error?.code === 'string' && FAILURE_CODE.test(error.code)) return error.code;
  return 'PERSONAL_EXPORT_GENERATION_FAILED';
}

function assertSnapshotBinding(snapshot, entry) {
  if (!snapshot
    || snapshot.room_id !== entry.checkpoint.room_id
    || snapshot.epoch_id !== entry.checkpoint.epoch_id
    || snapshot.checkpoint_id !== entry.checkpoint.checkpoint_id
    || snapshot.state_revision !== entry.checkpoint.state_revision
    || snapshot.state_hash !== entry.checkpoint.state_hash) {
    fail(
      'SNAPSHOT_CORRUPT',
      'authoritative snapshot does not match its immutable checkpoint',
      { checkpoint_id: entry.checkpoint.checkpoint_id },
      500
    );
  }
  // state_hash authority remains inside snapshotService. This application
  // layer deliberately does not re-hash a revision-bearing room state.
  return snapshot.state;
}

function assertTurnProjection(turn, sourceEntry, exportingSeat) {
  if (!turn
    || turn.turn_id !== sourceEntry.turn.turn_id
    || turn.turn_no !== sourceEntry.turn.turn_no
    || turn.viewer_seat !== exportingSeat
    || turn.status !== 'COMMITTED'
    || turn.active_narrative_mode !== sourceEntry.turn.narrative_mode) {
    fail(
      'ACTION_DISCLOSURE_CONSISTENCY_FAULT',
      'committed action projection does not match the checkpoint turn',
      { turn_id: sourceEntry.turn.turn_id },
      500
    );
  }
  for (const seat of ['A', 'B']) {
    const action = turn.actions?.[seat];
    const expectedDisclosure = seat === exportingSeat ? 'owner' : 'full_after_commit';
    if (!action?.locked
      || typeof action.text !== 'string'
      || action.disclosure !== expectedDisclosure) {
      fail(
        'ACTION_DISCLOSURE_CONSISTENCY_FAULT',
        'committed turn is missing an authorized action projection',
        { turn_id: sourceEntry.turn.turn_id, seat },
        500
      );
    }
  }
  return {
    A: { text: turn.actions.A.text, disclosure: turn.actions.A.disclosure },
    B: { text: turn.actions.B.text, disclosure: turn.actions.B.disclosure }
  };
}

function assertNarrativeBinding(narrative, sourceEntry, exportingSeat) {
  const expectedAudience = sourceEntry.turn.narrative_mode === 'shared'
    ? 'shared'
    : exportingSeat;
  if (!narrative
    || narrative.turn_id !== sourceEntry.turn.turn_id
    || narrative.mode !== sourceEntry.turn.narrative_mode
    || narrative.audience !== expectedAudience
    || typeof narrative.text !== 'string'
    || !narrative.text.trim()) {
    fail(
      'NARRATIVE_DELIVERY_CORRUPT',
      'narrative reader returned a delivery outside the authenticated audience',
      { turn_id: sourceEntry.turn.turn_id },
      500
    );
  }
  return narrative;
}

function publicExportRecord(record) {
  return Object.freeze({
    export_id: record.export_id,
    room_id: record.room_id,
    checkpoint_id: record.checkpoint_id,
    exporting_seat: record.exporting_seat,
    codec: record.codec,
    projection_version: record.projection_version,
    output_format: record.output_format,
    request_hash: record.request_hash,
    output_hash: record.output_hash,
    status: record.status,
    failure_code: record.failure_code,
    created_at: record.created_at,
    completed_at: record.completed_at,
    replayed: record.replayed === true
  });
}

/**
 * Application port intended for direct composition as:
 *
 *   services.lineage.beginSinglePlayerExport
 *   services.lineage.downloadSinglePlayerExport
 *
 * Authentication supplies the exporter. Neither request body can report a
 * member ID or seat.
 */
export function createPersonalSingleplayerExportService(dependencies) {
  assertDependencies(dependencies);
  const {
    lineageRepository,
    coreRepositories,
    snapshotService,
    exportSourceRepository,
    sourceTimelineReader,
    outputStore,
    codec,
    bindingTokenSecret
  } = dependencies;
  const getTurnForMember = coreRepositories.actions?.getForMember
    ?? coreRepositories.turns.getForMember;
  const inFlight = new Map();

  async function generate({ authenticatedUserId, roomId, begun }) {
    const source = await exportSourceRepository.loadCheckpointChain({
      authenticated_user_id: authenticatedUserId,
      room_id: roomId,
      checkpoint_id: begun.checkpoint_id
    });
    if (source.exporting_member.seat !== begun.exporting_seat
      || source.exporting_member.user_id !== authenticatedUserId) {
      fail('SOURCE_OWNER_REQUIRED', 'export record no longer matches authenticated membership', {}, 403);
    }
    const issuedBindings = source.binding_bootstrap.map(metadata => {
      const material = deterministicRoomActorBindingMaterial(
        bindingTokenSecret,
        {
          room_id: source.room.room_id,
          lineage_id: source.room.lineage_id,
          genesis_checkpoint_id: metadata.genesis_checkpoint_id
        },
        metadata.original_seat,
        metadata.room_actor_id
      );
      if (material.binding_id !== metadata.binding_id) {
        fail(
          'RETURN_ACTOR_BINDING_INVALID',
          'deterministically issued binding ID no longer matches persistence',
          {},
          500
        );
      }
      return material;
    });
    const verified = await lineageRepository.bindings.verifyPairForPersonalExport({
      authenticated_user_id: authenticatedUserId,
      room_id: roomId,
      actor_bindings: issuedBindings
    });
    if (verified.exporting_seat !== begun.exporting_seat) {
      fail('RETURN_ACTOR_BINDING_INVALID', 'binding verifier returned another member seat', {}, 500);
    }

    const checkpointChain = [];
    for (const sourceEntry of source.checkpoint_chain) {
      const snapshot = await snapshotService.readInternal({
        room_id: roomId,
        checkpoint_id: sourceEntry.checkpoint.checkpoint_id
      });
      const state = assertSnapshotBinding(snapshot, sourceEntry);
      if (sourceEntry.checkpoint.kind === 'genesis') {
        checkpointChain.push({
          checkpoint: sourceEntry.checkpoint,
          state,
          actions: null,
          narrative: null
        });
        continue;
      }
      const turn = await getTurnForMember({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId,
        epoch_id: sourceEntry.checkpoint.epoch_id,
        turn_no: sourceEntry.checkpoint.turn_no
      });
      const actions = assertTurnProjection(turn, sourceEntry, begun.exporting_seat);
      const narrative = await exportSourceRepository.getNarrativeForMember({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId,
        turn_id: sourceEntry.checkpoint.turn_id
      });
      checkpointChain.push({
        checkpoint: sourceEntry.checkpoint,
        state,
        actions,
        narrative: assertNarrativeBinding(narrative, sourceEntry, begun.exporting_seat)
      });
    }

    let sourceOwnerTimeline = null;
    if (authenticatedUserId === source.room.origin_owner_user_id) {
      const read = await sourceTimelineReader.getForOwner({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId,
        source_basis: source.source_basis
      });
      if (!read?.timeline) {
        fail(
          'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
          'source owner timeline reader returned no authenticated timeline',
          {},
          409
        );
      }
      sourceOwnerTimeline = {
        timeline: read.timeline,
        source_branch_id: source.source_basis.source_branch_id,
        source_node_id: source.source_basis.source_node_id
      };
    }

    const encoded = await codec.encode({
      export_id: begun.export_id,
      room: source.room,
      exporting_member_user_id: authenticatedUserId,
      exporting_seat: begun.exporting_seat,
      members_by_seat: source.members_by_seat,
      checkpoint_chain: checkpointChain,
      actor_bindings: verified.bindings,
      source_owner_timeline: sourceOwnerTimeline,
      projection_version: begun.projection_version,
      output_format: begun.output_format,
      idempotency_key: begun.idempotency_key,
      request_hash: begun.request_hash,
      created_at: begun.created_at
    });
    const stored = await outputStore.put({
      output_hash: encoded.output_hash,
      content: encoded.content
    });
    if (!stored || typeof stored.output_ref !== 'string') {
      fail('PERSONAL_EXPORT_OUTPUT_STORE_FAILED', 'output store returned no immutable reference');
    }
    const completed = await lineageRepository.personalExports.complete({
      authenticated_user_id: authenticatedUserId,
      room_id: roomId,
      export_id: begun.export_id,
      output_hash: encoded.output_hash,
      output_ref: stored.output_ref
    });
    return Object.freeze({ export: publicExportRecord(completed), replayed: completed.replayed === true });
  }

  async function runGeneration(context) {
    try {
      return await generate(context);
    } catch (error) {
      try {
        await lineageRepository.personalExports.markFailed({
          authenticated_user_id: context.authenticatedUserId,
          room_id: context.roomId,
          export_id: context.begun.export_id,
          failure_code: failureCode(error)
        });
      } catch (markError) {
        // Concurrent requests in this single instance join `inFlight`. A mark
        // failure therefore indicates a repository/state fault. Preserve the
        // original generation cause even when it is a frozen/non-extensible
        // error; repository diagnostics remain available in server logging.
        void markError;
      }
      throw error;
    }
  }

  async function beginSinglePlayerExport(contextValue) {
    const authenticatedUserId = principal(contextValue?.authenticated_user_id);
    const roomId = identifier(contextValue?.room_id, 'room_id');
    const checkpointId = identifier(contextValue?.checkpoint_id, 'checkpoint_id');
    const request = beginRequest(contextValue?.request);
    const begun = await lineageRepository.personalExports.begin({
      authenticated_user_id: authenticatedUserId,
      room_id: roomId,
      checkpoint_id: checkpointId,
      projection_version: request.projection_version,
      codec: codec.codec,
      output_format: request.output_format,
      idempotency_key: request.idempotency_key
    });
    if (begun.status === 'READY' || begun.status === 'FAILED') {
      return Object.freeze({ export: publicExportRecord(begun), replayed: true });
    }
    if (begun.status !== 'PENDING') {
      fail('PERSONAL_EXPORT_STATE_INVALID', 'personal export has an unknown status', {}, 500);
    }
    const existing = inFlight.get(begun.export_id);
    if (existing) return existing;
    const operation = runGeneration({ authenticatedUserId, roomId, begun })
      .finally(() => inFlight.delete(begun.export_id));
    inFlight.set(begun.export_id, operation);
    return operation;
  }

  async function downloadSinglePlayerExport(contextValue) {
    const authenticatedUserId = principal(contextValue?.authenticated_user_id);
    const roomId = identifier(contextValue?.room_id, 'room_id');
    const exportId = identifier(contextValue?.export_id, 'export_id');
    // Authorization happens before the output store is touched. An attacker
    // cannot use output refs/hashes as an oracle for another member's file.
    const metadata = await lineageRepository.personalExports.getForDownload({
      authenticated_user_id: authenticatedUserId,
      room_id: roomId,
      export_id: exportId
    });
    const stored = await outputStore.get({ output_ref: metadata.output_ref });
    const content = await codec.assertOutput(stored.content, {
      export_id: metadata.export_id,
      room_id: roomId,
      checkpoint_id: metadata.checkpoint_id,
      exporting_seat: metadata.exporting_seat
    });
    const actualHash = await codec.outputHash(content);
    if (stored.output_hash !== metadata.output_hash || actualHash !== metadata.output_hash) {
      fail(
        'PERSONAL_EXPORT_OUTPUT_CORRUPT',
        'downloaded personal export failed immutable hash verification',
        {},
        500
      );
    }
    return Object.freeze({
      export: Object.freeze({
        export_id: metadata.export_id,
        checkpoint_id: metadata.checkpoint_id,
        codec: metadata.codec,
        projection_version: metadata.projection_version,
        output_format: metadata.output_format,
        output_hash: metadata.output_hash,
        completed_at: metadata.completed_at,
        content_type: 'application/json; charset=utf-8',
        file_name: `naruto-singleplayer-${metadata.export_id}.json`
      }),
      content
    });
  }

  return Object.freeze({ beginSinglePlayerExport, downloadSinglePlayerExport });
}
