import { randomUUID } from 'node:crypto';

import {
  bindContinuityCommand,
  decodeContinuityCommand
} from '../domain/continuity-bundle.js';
import {
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import {
  createProtocolRetryResult,
  executeTurnBundleCommandWithCheckpoints,
  materializeReadyTurnDraft,
  rebindTurnDraftLease,
  turnDraftCandidateStateHash
} from '../domain/turn-draft.js';

const SESSION_STATE_SCHEMA = 'naruto.persisted-continuity-session/v1';
const SESSION_PURPOSE = 'naruto.continuity-session-state/v1';
const CANDIDATE_PURPOSE = 'naruto.turn-draft-candidate/v1';
const COMMAND_RESULT_PURPOSE = 'naruto.continuity-command-result/v1';
const EFFECT_OPERATION_PURPOSE = 'naruto.turn-draft-effect-operation/v1';
const ARTIFACT_PURPOSE = 'naruto.turn-draft-artifact/v1';
const ARTIFACT_REFS_PURPOSE = 'naruto.turn-draft-artifact-source-refs/v1';
const ACTIVE_RUN_STATUSES = new Set(['CLAIMED', 'RUNNING']);
const PAUSE_REASONS = new Set([
  'BILLING_AUTHORIZATION_REQUIRED',
  'LOOP_BREAKER',
  'MANUAL_PAUSE',
  'RECOVERABLE_RUNTIME_FAULT'
]);
const RESUME_STAGES = new Set([
  'STAGING_UPDATES',
  'AUDITING',
  'REPAIRING_DRAFT'
]);

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details);
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function immutable(value) {
  return freezeDeep(canonicalizeJson(value));
}

function hashJson(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    fail('CONTINUITY_REPOSITORY_INPUT_INVALID', `${label} must be a non-empty identifier`, {
      field: label
    });
  }
  return value;
}

function assertRevision(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail('CONTINUITY_REPOSITORY_INPUT_INVALID', `${label} is not a valid revision`, {
      field: label
    });
  }
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || value.length < 20 || !Number.isFinite(Date.parse(value))) {
    fail('CONTINUITY_REPOSITORY_CLOCK_INVALID', `${label} must be an ISO timestamp`);
  }
  return value;
}

function assertSync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(
      'ASYNC_SQLITE_TRANSACTION_FORBIDDEN',
      `${label} must be synchronous; encryption and network work cannot run in a SQLite transaction`
    );
  }
  return value;
}

function defaultIdFactory(kind) {
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

function generatedId(idFactory, kind) {
  return assertIdentifier(idFactory(kind), `${kind}_id`);
}

function assertCodec(codec) {
  if (!codec || typeof codec.sealJson !== 'function' || typeof codec.openJson !== 'function') {
    fail(
      'CONTINUITY_REPOSITORY_CONFIGURATION_INVALID',
      'a synchronous envelope codec with sealJson/openJson is required'
    );
  }
  return codec;
}

function sealedEnvelope(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CONTINUITY_ENVELOPE_CODEC_INVALID', `${label} codec result must be an envelope`);
  }
  const bytes = (field, minimum) => {
    const candidate = value[field];
    if (!(candidate instanceof Uint8Array) || candidate.byteLength < minimum) {
      fail('CONTINUITY_ENVELOPE_CODEC_INVALID', `${label} ${field} is invalid`);
    }
    return Buffer.from(candidate);
  };
  if (typeof value.master_key_version !== 'string' || value.master_key_version.length < 1) {
    fail('CONTINUITY_ENVELOPE_CODEC_INVALID', `${label} master_key_version is invalid`);
  }
  return Object.freeze({
    ciphertext: bytes('ciphertext', 1),
    wrapped_data_key: bytes('wrapped_data_key', 16),
    nonce: bytes('nonce', 8),
    auth_tag: bytes('auth_tag', 8),
    master_key_version: value.master_key_version
  });
}

function envelopeFromRow(row, ciphertextColumn) {
  return Object.freeze({
    ciphertext: Buffer.from(row[ciphertextColumn]),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  });
}

function packedEnvelope(envelope) {
  return Buffer.from(canonicalStringify({
    schema: 'naruto.packed-envelope/v1',
    ciphertext: envelope.ciphertext.toString('base64'),
    wrapped_data_key: envelope.wrapped_data_key.toString('base64'),
    nonce: envelope.nonce.toString('base64'),
    auth_tag: envelope.auth_tag.toString('base64'),
    master_key_version: envelope.master_key_version
  }), 'utf8');
}

function sessionContext(identity) {
  return Object.freeze({
    purpose: SESSION_PURPOSE,
    run_id: identity.run_id,
    continuity_session_id: identity.continuity_session_id,
    draft_id: identity.draft_id,
    turn_id: identity.turn_id
  });
}

function candidateContext(identity) {
  return Object.freeze({
    purpose: CANDIDATE_PURPOSE,
    run_id: identity.run_id,
    draft_id: identity.draft_id,
    turn_id: identity.turn_id
  });
}

function commandResultContext(command) {
  return Object.freeze({
    purpose: COMMAND_RESULT_PURPOSE,
    run_id: command.run_id,
    continuity_session_id: command.continuity_session_id,
    invocation_id: command.invocation_id,
    command_attempt_id: command.command_attempt_id,
    canonical_request_hash: command.canonical_request_hash
  });
}

function seal(codec, value, context, label) {
  return sealedEnvelope(
    assertSync(codec.sealJson(immutable(value), context), `${label} sealJson`),
    label
  );
}

function open(codec, envelope, context, label) {
  const value = assertSync(codec.openJson(envelope, context), `${label} openJson`);
  try {
    return canonicalizeJson(value);
  } catch (error) {
    fail('PERSISTED_CONTINUITY_STATE_CORRUPT', `${label} did not decrypt to canonical JSON`, {
      cause_code: error instanceof DomainError ? error.code : 'INVALID_JSON_VALUE'
    });
  }
}

function draftIdentity(draft) {
  return {
    run_id: draft.run_id,
    continuity_session_id: draft.continuity_session_id,
    draft_id: draft.draft_id,
    turn_id: draft.turn_id
  };
}

function sessionState(draft, pendingCommand = null, pause = null) {
  return immutable({
    schema: SESSION_STATE_SCHEMA,
    draft,
    pending_command: pendingCommand,
    pause
  });
}

function assertDraftShape(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)
    || draft.schema !== 'naruto.turn-draft/v1') {
    fail('CONTINUITY_REPOSITORY_INPUT_INVALID', 'a TurnDraft domain value is required');
  }
  for (const key of [
    'run_id',
    'continuity_session_id',
    'draft_id',
    'turn_id',
    'room_id',
    'epoch_id'
  ]) assertIdentifier(draft[key], `draft.${key}`);
  assertRevision(draft.lease_fence, 'draft.lease_fence', 1);
  assertRevision(draft.draft_revision, 'draft.draft_revision');
  if (!Array.isArray(draft.frozen_effects)
    || !Array.isArray(draft.obligations)
    || !Array.isArray(draft.effect_ledger)
    || !Array.isArray(draft.obligation_ledger)) {
    fail('CONTINUITY_REPOSITORY_INPUT_INVALID', 'TurnDraft ledgers are missing');
  }
  return draft;
}

function assertBoundContinuityContext(snapshot, binding) {
  const prototype = binding && typeof binding === 'object'
    ? Object.getPrototypeOf(binding)
    : undefined;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || (prototype !== Object.prototype && prototype !== null)) {
    fail('INVALID_BOUND_CONTEXT', 'BoundContinuityContext must be a server object');
  }
  const requireIdentifier = field => {
    if (!Object.prototype.hasOwnProperty.call(binding, field)) {
      fail('INVALID_BOUND_CONTEXT', `BoundContinuityContext is missing ${field}`, { field });
    }
    const value = binding[field];
    if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
      fail('INVALID_BOUND_CONTEXT', `${field} must be a non-empty server identifier`, { field });
    }
    return value;
  };
  const draft = snapshot.state.draft;
  const expectedIdentifiers = {
    room_id: draft.room_id,
    epoch_id: draft.epoch_id,
    turn_id: draft.turn_id,
    run_id: draft.run_id,
    continuity_session_id: draft.continuity_session_id,
    draft_id: draft.draft_id,
    resolution_hash: draft.resolution_hash,
    obligation_set_hash: draft.obligation_set_hash,
    execution_plan_hash: draft.execution_plan_hash,
    billing_provenance_hash: draft.billing_provenance_hash,
    prompt_version: draft.prompt_version
  };
  for (const [field, expected] of Object.entries(expectedIdentifiers)) {
    if (requireIdentifier(field) !== expected) {
      fail('INVALID_BOUND_CONTEXT', `${field} does not match the persisted TurnDraft`, {
        field
      });
    }
  }
  for (const field of ['invocation_id', 'command_attempt_id', 'stage_billing_plan_hash']) {
    requireIdentifier(field);
  }
  if (!Number.isSafeInteger(binding.base_state_revision) || binding.base_state_revision < 0) {
    fail('INVALID_BOUND_CONTEXT', 'base_state_revision must be a non-negative server revision', {
      field: 'base_state_revision'
    });
  }
  if (binding.base_state_revision !== draft.base_state_revision) {
    fail('INVALID_BOUND_CONTEXT', 'base_state_revision does not match the persisted TurnDraft', {
      field: 'base_state_revision'
    });
  }
  if (!Number.isSafeInteger(binding.lease_fence) || binding.lease_fence < 1) {
    fail('INVALID_BOUND_CONTEXT', 'lease_fence must be a positive server fence', {
      field: 'lease_fence'
    });
  }
  if (binding.agent_role !== 'continuity_steward') {
    fail('INVALID_BOUND_CONTEXT', 'agent_role must be continuity_steward', {
      field: 'agent_role'
    });
  }
  if (!['native_tools', 'json_protocol'].includes(binding.transport_mode)
    || binding.transport_mode !== snapshot.row.session_transport) {
    fail('CONTINUITY_TRANSPORT_MISMATCH', 'bound transport differs from the frozen session transport', {
      expected_transport: snapshot.row.session_transport
    });
  }
}

function dbObligationKind(kind) {
  if (kind === 'shinobi_daily') return 'daily';
  return kind;
}

function dbObligationStatus(status) {
  if (status === 'PENDING') return 'OPEN';
  if (status === 'CONSUMED') return 'SATISFIED';
  if (status === 'REOPENED') return 'REOPENED';
  fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'unknown draft obligation status', { status });
}

function projectionValues(draft, candidateEnvelope, now) {
  return [
    draft.lease_fence,
    draft.draft_revision,
    candidateEnvelope.ciphertext,
    candidateEnvelope.wrapped_data_key,
    candidateEnvelope.nonce,
    candidateEnvelope.auth_tag,
    candidateEnvelope.master_key_version,
    draft.candidate_state_hash,
    draft.artifact_bundle_hash,
    draft.narrative_bundle_hash,
    draft.semantic_draft_hash,
    draft.commit_envelope_hash,
    draft.ready_receipt ? hashJson(draft.ready_receipt) : null,
    draft.status,
    now
  ];
}

function sessionStatusForResult(result) {
  if (result.status === 'READY') return 'COMPLETE';
  if (result.status === 'REPAIR_REQUIRED') return 'WAITING_REPAIR';
  return 'OPEN';
}

function turnStatusForResult(result) {
  if (result.status === 'READY') return 'COMMITTING';
  if (result.status === 'REPAIR_REQUIRED') return 'REPAIRING_DRAFT';
  if (result.status === 'HANDOFF_REQUIRED') return 'RESOLUTION_HANDOFF';
  return null;
}

function snapshotQuery(database, runId, continuitySessionId) {
  return database.prepare(`
    SELECT s.stage_session_id, s.run_id, s.continuity_session_id,
           s.transport AS session_transport, s.session_state_ciphertext,
           s.wrapped_data_key AS session_wrapped_data_key,
           s.nonce AS session_nonce, s.auth_tag AS session_auth_tag,
           s.master_key_version AS session_master_key_version,
           s.session_state_hash, s.resume_cursor, s.session_status,
           s.latest_invocation_id, s.created_at AS session_created_at,
           s.updated_at AS session_updated_at,
           d.*, r.lease_fence AS run_lease_fence,
           r.run_status, t.turn_status
      FROM agent_stage_sessions AS s
      JOIN turn_drafts AS d ON d.run_id = s.run_id
      JOIN resolution_runs AS r ON r.run_id = s.run_id
      JOIN multiplayer_turns AS t ON t.turn_id = d.turn_id
     WHERE s.run_id = ? AND s.continuity_session_id = ?
       AND s.stage = 'continuity' AND s.audience = 'none'
  `).get(runId, continuitySessionId);
}

function sessionEnvelopeFromRow(row) {
  return Object.freeze({
    ciphertext: Buffer.from(row.session_state_ciphertext),
    wrapped_data_key: Buffer.from(row.session_wrapped_data_key),
    nonce: Buffer.from(row.session_nonce),
    auth_tag: Buffer.from(row.session_auth_tag),
    master_key_version: row.session_master_key_version
  });
}

function assertProjectionMatches(row, draft, { allowProjectionDrift = false } = {}) {
  const identityMatches = draft.run_id === row.run_id
    && draft.continuity_session_id === row.continuity_session_id
    && draft.draft_id === row.draft_id
    && draft.turn_id === row.turn_id
    && draft.room_id === row.room_id
    && draft.epoch_id === row.epoch_id;
  if (!identityMatches) {
    fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'session draft identity differs from its projection');
  }
  if (allowProjectionDrift) return;
  const projectionMatches = draft.lease_fence === row.lease_fence
    && draft.draft_revision === row.draft_revision
    && draft.status === row.draft_status
    && draft.candidate_state_hash === row.candidate_state_hash
    && draft.artifact_bundle_hash === row.artifact_set_hash
    && draft.semantic_draft_hash === row.semantic_hash
    && draft.commit_envelope_hash === row.commit_envelope_hash;
  if (!projectionMatches) {
    fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'session draft differs from its SQLite projection', {
      draft_revision: draft.draft_revision,
      projected_draft_revision: row.draft_revision
    });
  }
}

function assertLiveFence(row, binding) {
  if (!ACTIVE_RUN_STATUSES.has(row.run_status)
    || row.run_lease_fence !== binding.lease_fence
    || row.lease_fence !== binding.lease_fence) {
    fail('STALE_LEASE_FENCE', 'Continuity command lease fence is stale', {
      actual: binding.lease_fence,
      run_lease_fence: row.run_lease_fence,
      draft_lease_fence: row.lease_fence,
      run_status: row.run_status
    });
  }
}

function assertWritableContext(database, identity, revision, fence, commandAttemptId = null) {
  const row = database.prepare(`
    SELECT d.draft_revision, d.lease_fence, r.lease_fence AS run_lease_fence,
           r.run_status, s.session_state_hash,
           c.command_status, c.canonical_request_hash
      FROM turn_drafts AS d
      JOIN resolution_runs AS r ON r.run_id = d.run_id
      JOIN agent_stage_sessions AS s
        ON s.run_id = d.run_id AND s.continuity_session_id = ?
      LEFT JOIN turn_continuity_commands AS c
        ON c.command_attempt_id = ?
     WHERE d.draft_id = ? AND d.turn_id = ? AND d.run_id = ?
       AND d.draft_revision = ? AND d.lease_fence = ?
       AND r.lease_fence = ? AND r.run_status IN ('CLAIMED', 'RUNNING')
  `).get(
    identity.continuity_session_id,
    commandAttemptId,
    identity.draft_id,
    identity.turn_id,
    identity.run_id,
    revision,
    fence,
    fence
  );
  if (!row) {
    const current = database.prepare(`
      SELECT d.draft_revision, d.lease_fence, r.lease_fence AS run_lease_fence,
             r.run_status
        FROM turn_drafts AS d
        JOIN resolution_runs AS r ON r.run_id = d.run_id
       WHERE d.draft_id = ? AND d.run_id = ?
    `).get(identity.draft_id, identity.run_id);
    if (current && (current.lease_fence !== fence || current.run_lease_fence !== fence)) {
      fail('STALE_LEASE_FENCE', 'Continuity draft write was rejected by its lease fence', current);
    }
    fail('DRAFT_REVISION_CONFLICT', 'Continuity draft revision CAS failed', {
      expected_draft_revision: revision,
      actual_draft_revision: current?.draft_revision ?? null
    });
  }
  if (commandAttemptId && row.command_status !== 'IN_PROGRESS') {
    fail('CONTINUITY_COMMAND_NOT_IN_PROGRESS', 'Continuity command is no longer in progress');
  }
  return row;
}

function commandRow(database, attemptId) {
  return database.prepare(`
    SELECT * FROM turn_continuity_commands WHERE command_attempt_id = ?
  `).get(attemptId);
}

function assertSameAttempt(row, command) {
  const binding = command.binding;
  const sameIdentity = row.run_id === binding.run_id
    && row.continuity_session_id === binding.continuity_session_id
    && row.invocation_id === binding.invocation_id
    && row.command_attempt_id === binding.command_attempt_id;
  const sameContent = row.canonical_request_hash === command.canonical_request_hash
    && row.bundle_hash === command.canonical_bundle_hash
    && row.operation === command.operation;
  if (!sameIdentity || !sameContent) {
    fail('IDEMPOTENCY_CONFLICT', 'command attempt was reused with different identity or content', {
      command_attempt_id: binding.command_attempt_id,
      expected_hash: row.canonical_request_hash,
      actual_hash: command.canonical_request_hash
    });
  }
}

function itemDescriptors(command, draft) {
  const descriptors = [];
  const effectById = new Map(draft.frozen_effects.map(effect => [effect.effect_id, effect]));
  const effects = command.bundle.effect_ids.map((value, index) => ({
    kind: 'effect',
    id: typeof value === 'string' ? value : `effect_ids[${index}]`,
    value,
    path: `/effect_ids/${index}`,
    sort_seq: typeof value === 'string'
      ? effectById.get(value)?.effect_seq ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER,
    input_index: index
  })).sort((left, right) => left.sort_seq - right.sort_seq || left.input_index - right.input_index);
  descriptors.push(...effects);
  for (const [collection, kind] of [
    ['domain_checks', 'domain_check'],
    ['memories', 'memory'],
    ['shinobi_daily', 'shinobi_daily']
  ]) {
    command.bundle[collection].forEach((value, index) => descriptors.push({
      kind,
      id: value && typeof value === 'object' && typeof value.obligation_id === 'string'
        ? value.obligation_id
        : `${collection}[${index}]`,
      value,
      path: `/${collection}/${index}`,
      input_index: index
    }));
  }
  return descriptors.map((descriptor, index) => immutable({
    ...descriptor,
    item_seq: index + 1,
    canonical_item_hash: hashJson({
      kind: descriptor.kind,
      id: descriptor.id,
      value: descriptor.value
    })
  }));
}

function receiptFor(draft, kind, id) {
  if (kind === 'effect') {
    return draft.effect_ledger.find(row => row.effect_id === id)?.receipt ?? null;
  }
  return draft.obligation_ledger.find(row => row.obligation_id === id)?.receipt ?? null;
}

function checkpointByPath(checkpoints) {
  return new Map(checkpoints.map(checkpoint => [checkpoint.path, checkpoint]));
}

function outcomesForDescriptors(descriptors, execution) {
  const checkpoints = checkpointByPath(execution.item_checkpoints);
  const idempotent = [...execution.result.idempotent];
  return descriptors.map(descriptor => {
    const checkpoint = checkpoints.get(descriptor.path);
    if (checkpoint) return { status: 'ACCEPTED', checkpoint };
    const error = execution.result.errors.find(candidate => (
      candidate.path === descriptor.path || candidate.path.startsWith(`${descriptor.path}/`)
    ));
    if (error) return { status: 'REJECTED', error };
    const index = idempotent.findIndex(candidate => (
      candidate.kind === descriptor.kind && candidate.id === descriptor.id
    ));
    if (index >= 0) return { status: 'IDEMPOTENT', item: idempotent.splice(index, 1)[0] };
    return {
      status: 'REJECTED',
      error: {
        code: 'ITEM_OUTCOME_MISSING',
        path: descriptor.path,
        consumed: false
      }
    };
  });
}

function reconstructInterruptedCommandResult(execution, descriptors, persistedItems, command) {
  const acceptedBeforeCrash = new Map();
  for (const row of persistedItems) {
    const descriptor = descriptors[row.item_seq - 1];
    if (!descriptor
      || descriptor.canonical_item_hash !== row.canonical_item_hash
      || descriptor.kind !== row.item_kind
      || descriptor.id !== row.item_id) {
      fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'command item ledger differs from its pending command', {
        command_attempt_id: command.binding.command_attempt_id,
        item_seq: row.item_seq
      });
    }
    if (row.item_status === 'ACCEPTED') acceptedBeforeCrash.set(row.item_seq, descriptor);
  }
  if (acceptedBeforeCrash.size === 0) return execution;

  const newAcceptancePaths = new Set(
    execution.item_checkpoints.map(checkpoint => checkpoint.path)
  );
  const rawIdempotent = [...execution.result.idempotent];
  const accepted = [];
  const idempotent = [];
  for (const descriptor of descriptors) {
    const wasAccepted = acceptedBeforeCrash.has(descriptor.item_seq);
    const newlyAccepted = newAcceptancePaths.has(descriptor.path);
    if (wasAccepted || newlyAccepted) {
      const receipt = receiptFor(execution.draft, descriptor.kind, descriptor.id);
      if (!receipt?.receipt_id) {
        fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'accepted command item has no domain receipt', {
          command_attempt_id: command.binding.command_attempt_id,
          item_seq: descriptor.item_seq
        });
      }
      accepted.push({
        kind: descriptor.kind,
        id: descriptor.id,
        receipt_id: receipt.receipt_id
      });
      if (wasAccepted) {
        const replayIndex = rawIdempotent.findIndex(item => (
          item.kind === descriptor.kind && item.id === descriptor.id
        ));
        if (replayIndex < 0) {
          fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'accepted command item was not idempotent on resume', {
            command_attempt_id: command.binding.command_attempt_id,
            item_seq: descriptor.item_seq
          });
        }
        rawIdempotent.splice(replayIndex, 1);
      }
      continue;
    }
    const replayIndex = rawIdempotent.findIndex(item => (
      item.kind === descriptor.kind && item.id === descriptor.id
    ));
    if (replayIndex >= 0) idempotent.push(rawIdempotent.splice(replayIndex, 1)[0]);
  }
  idempotent.push(...rawIdempotent);

  const result = immutable({
    ...execution.result,
    accepted,
    idempotent
  });
  const commands = execution.draft.commands.map(record => {
    const sameAttempt = record.run_id === command.binding.run_id
      && record.continuity_session_id === command.binding.continuity_session_id
      && record.invocation_id === command.binding.invocation_id
      && record.command_attempt_id === command.binding.command_attempt_id;
    if (!sameAttempt) return record;
    return {
      ...record,
      result,
      result_hash: hashJson(result)
    };
  });
  const matchingCommands = commands.filter(record => (
    record.run_id === command.binding.run_id
      && record.continuity_session_id === command.binding.continuity_session_id
      && record.invocation_id === command.binding.invocation_id
      && record.command_attempt_id === command.binding.command_attempt_id
  ));
  if (matchingCommands.length !== 1) {
    fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'resumed command did not produce one domain command record');
  }
  return freezeDeep({
    ...execution,
    draft: immutable({ ...execution.draft, commands }),
    result
  });
}

function sourceRefsFor(kind, artifact) {
  if (artifact && Object.prototype.hasOwnProperty.call(artifact, 'source_refs')) {
    return artifact.source_refs;
  }
  if (kind === 'memory' && Array.isArray(artifact?.entries)) {
    return artifact.entries.map(entry => ({
      event_refs: entry?.event_refs ?? [],
      subject_refs: entry?.subject_refs ?? []
    }));
  }
  if (kind === 'domain_check') return artifact?.evidence_event_ids ?? [];
  return [];
}

function effectPersistenceMaterial(codec, checkpoint, command) {
  if (checkpoint.kind !== 'effect') return null;
  const effect = checkpoint.draft.frozen_effects.find(row => row.effect_id === checkpoint.id);
  const receipt = receiptFor(checkpoint.draft, checkpoint.kind, checkpoint.id);
  if (!effect || !receipt) {
    fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'accepted effect checkpoint lacks its contract/receipt');
  }
  const context = {
    purpose: EFFECT_OPERATION_PURPOSE,
    draft_id: checkpoint.draft.draft_id,
    effect_id: checkpoint.id,
    effect_hash: effect.effect_hash
  };
  const operationEnvelope = seal(codec, {
    effect,
    normalized_operations: receipt.normalized_operations,
    invariant_results: receipt.invariant_results
  }, context, 'effect operation');
  return {
    effect,
    receipt,
    canonical_operation_ciphertext: packedEnvelope(operationEnvelope),
    target_kind: effect.target_kind ?? effect.domain ?? 'state',
    target_id: effect.target_id ?? effect.target?.id ?? checkpoint.draft.turn_id,
    operation: effect.operation ?? effect.kind ?? effect.required_reducer,
    generated_by_invocation_id: command.binding.invocation_id
  };
}

function artifactPersistenceMaterial(codec, checkpoint, command) {
  if (!['memory', 'shinobi_daily'].includes(checkpoint.kind)) return null;
  const ledger = checkpoint.draft.obligation_ledger.find(row => row.obligation_id === checkpoint.id);
  if (!ledger?.receipt || !ledger.current_artifact) {
    fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'accepted artifact checkpoint lacks its artifact');
  }
  const baseContext = {
    draft_id: checkpoint.draft.draft_id,
    turn_id: checkpoint.draft.turn_id,
    obligation_id: checkpoint.id,
    artifact_revision: ledger.current_artifact_revision
  };
  const contentEnvelope = seal(codec, ledger.current_artifact, {
    purpose: ARTIFACT_PURPOSE,
    ...baseContext
  }, 'draft artifact');
  const refsEnvelope = seal(codec, sourceRefsFor(checkpoint.kind, ledger.current_artifact), {
    purpose: ARTIFACT_REFS_PURPOSE,
    ...baseContext
  }, 'artifact source refs');
  return {
    ledger,
    content_envelope: contentEnvelope,
    source_refs_ciphertext: packedEnvelope(refsEnvelope),
    generated_by_invocation_id: command.binding.invocation_id,
    generation_plan_hash: command.binding.stage_billing_plan_hash
      ?? checkpoint.draft.execution_plan_hash
  };
}

function insertCommandItem(database, {
  idFactory,
  descriptor,
  command,
  draft,
  status,
  receiptHash,
  errorCode,
  errorPath,
  beforeRevision,
  afterRevision,
  leaseFence,
  now
}) {
  const existing = database.prepare(`
    SELECT * FROM turn_continuity_command_items
     WHERE command_attempt_id = ? AND item_seq = ?
  `).get(command.binding.command_attempt_id, descriptor.item_seq);
  if (existing) {
    if (existing.canonical_item_hash !== descriptor.canonical_item_hash
      || existing.item_kind !== descriptor.kind
      || existing.item_id !== descriptor.id) {
      fail('IDEMPOTENCY_CONFLICT', 'persisted command item differs from its replay');
    }
    const compatibleStatus = existing.item_status === status
      || (existing.item_status === 'ACCEPTED' && status === 'IDEMPOTENT');
    if (!compatibleStatus) {
      fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'persisted command item outcome changed', {
        item_seq: descriptor.item_seq,
        persisted_status: existing.item_status,
        replay_status: status
      });
    }
    return false;
  }
  database.prepare(`
    INSERT INTO turn_continuity_command_items (
      command_item_id, command_attempt_id, draft_id, turn_id, run_id,
      continuity_session_id, item_seq, item_kind, item_id, item_status,
      consumed, canonical_item_hash, receipt_hash, error_code, error_path,
      before_draft_revision, after_draft_revision, lease_fence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generatedId(idFactory, 'command_item'),
    command.binding.command_attempt_id,
    draft.draft_id,
    draft.turn_id,
    draft.run_id,
    draft.continuity_session_id,
    descriptor.item_seq,
    descriptor.kind,
    descriptor.id,
    status,
    status === 'ACCEPTED' ? 1 : 0,
    descriptor.canonical_item_hash,
    receiptHash,
    errorCode,
    errorPath,
    beforeRevision,
    afterRevision,
    leaseFence,
    now
  );
  return true;
}

/**
 * Persistent Continuity/TurnDraft adapter. Domain execution and all envelope
 * encryption happen outside SQLite; every ledger mutation is a short,
 * serialized BEGIN IMMEDIATE write guarded by run/session/fence/revision CAS.
 */
export function createSqliteContinuityDraftRepository(connection, options = {}) {
  if (!connection || typeof connection.read !== 'function' || typeof connection.write !== 'function') {
    fail('CONTINUITY_REPOSITORY_CONFIGURATION_INVALID', 'a multiplayer SQLite connection is required');
  }
  const codec = assertCodec(options.envelopeCodec);
  const idFactory = options.idFactory ?? defaultIdFactory;
  const clock = options.clock ?? (() => new Date().toISOString());
  const faultInjector = options.faultInjector ?? null;
  if (typeof idFactory !== 'function' || typeof clock !== 'function'
    || (faultInjector !== null && typeof faultInjector !== 'function')) {
    fail('CONTINUITY_REPOSITORY_CONFIGURATION_INVALID', 'repository options are invalid');
  }

  const now = () => assertTimestamp(clock(), 'clock result');

  async function injectFault(event) {
    if (!faultInjector) return;
    await faultInjector(Object.freeze(event));
  }

  function readSnapshot(runId, continuitySessionId, settings = {}) {
    assertIdentifier(runId, 'run_id');
    assertIdentifier(continuitySessionId, 'continuity_session_id');
    const row = connection.read(database => snapshotQuery(database, runId, continuitySessionId));
    if (!row) fail('CONTINUITY_SESSION_NOT_FOUND', 'Continuity session does not exist');
    const identity = {
      run_id: row.run_id,
      continuity_session_id: row.continuity_session_id,
      draft_id: row.draft_id,
      turn_id: row.turn_id
    };
    const state = open(codec, sessionEnvelopeFromRow(row), sessionContext(identity), 'session state');
    if (!state || state.schema !== SESSION_STATE_SCHEMA || !state.draft) {
      fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'Continuity session state has an invalid shape');
    }
    if (hashJson(state) !== row.session_state_hash) {
      fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'Continuity session state hash does not match');
    }
    assertDraftShape(state.draft);
    assertProjectionMatches(row, state.draft, settings);
    if (!row.candidate_state_ciphertext || !row.wrapped_data_key
      || !row.nonce || !row.auth_tag || !row.master_key_version) {
      fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'TurnDraft candidate envelope is incomplete');
    }
    const candidate = open(
      codec,
      envelopeFromRow(row, 'candidate_state_ciphertext'),
      candidateContext(identity),
      'candidate state'
    );
    if (turnDraftCandidateStateHash(candidate) !== state.draft.candidate_state_hash
      || canonicalStringify(candidate) !== canonicalStringify(state.draft.candidate_state)) {
      fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'candidate state differs from its TurnDraft session');
    }
    return { row, state: immutable(state) };
  }

  function publicSnapshot(snapshot) {
    return immutable({
      stage_session_id: snapshot.row.stage_session_id,
      run_id: snapshot.row.run_id,
      continuity_session_id: snapshot.row.continuity_session_id,
      transport: snapshot.row.session_transport,
      session_status: snapshot.row.session_status,
      resume_cursor: snapshot.row.resume_cursor,
      draft: snapshot.state.draft,
      pending_command: snapshot.state.pending_command,
      pause: snapshot.state.pause
    });
  }

  function loadSession({ run_id, continuity_session_id }) {
    return publicSnapshot(readSnapshot(run_id, continuity_session_id));
  }

  async function createSession({
    stage_session_id,
    draft: draftValue,
    transport,
    provider_session_ref = null,
    created_at = now()
  }) {
    assertIdentifier(stage_session_id, 'stage_session_id');
    const draft = assertDraftShape(draftValue);
    if (!['native_tools', 'json_protocol'].includes(transport)) {
      fail('CONTINUITY_REPOSITORY_INPUT_INVALID', 'transport is invalid');
    }
    assertTimestamp(created_at, 'created_at');
    const state = sessionState(draft);
    const identity = draftIdentity(draft);
    const stateEnvelope = seal(codec, state, sessionContext(identity), 'session state');
    const candidateEnvelope = seal(
      codec,
      draft.candidate_state,
      candidateContext(identity),
      'candidate state'
    );
    const stateHash = hashJson(state);

    await connection.write(database => {
      const run = database.prepare(`
        SELECT r.run_id, r.turn_id, r.room_id, r.epoch_id, r.lease_fence,
               r.run_status, r.transport, t.base_state_revision, t.base_state_hash
          FROM resolution_runs AS r
          JOIN multiplayer_turns AS t ON t.turn_id = r.turn_id
         WHERE r.run_id = ? AND r.turn_id = ? AND r.room_id = ? AND r.epoch_id = ?
      `).get(draft.run_id, draft.turn_id, draft.room_id, draft.epoch_id);
      if (!run) fail('CONTINUITY_RUN_NOT_FOUND', 'resolution run does not match TurnDraft identity');
      if (!ACTIVE_RUN_STATUSES.has(run.run_status)
        || run.lease_fence !== draft.lease_fence
        || run.transport !== transport) {
        fail('STALE_LEASE_FENCE', 'TurnDraft cannot be created under this run lease/transport');
      }
      database.prepare(`
        INSERT INTO turn_drafts (
          draft_id, turn_id, run_id, room_id, epoch_id,
          base_state_revision, base_state_hash, lease_fence, draft_revision,
          execution_plan_hash, billing_provenance_hash, resolution_hash,
          obligation_set_hash, projection_hash, rule_version_hash,
          candidate_state_ciphertext, wrapped_data_key, nonce, auth_tag,
          master_key_version, candidate_state_hash, artifact_set_hash,
          narrative_set_hash, semantic_hash, commit_envelope_hash,
          ready_receipt_hash, draft_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        draft.draft_id,
        draft.turn_id,
        draft.run_id,
        draft.room_id,
        draft.epoch_id,
        draft.base_state_revision,
        draft.base_state_hash,
        draft.lease_fence,
        draft.draft_revision,
        draft.execution_plan_hash,
        draft.billing_provenance_hash,
        draft.resolution_hash,
        draft.obligation_set_hash,
        draft.projection_bundle_hash,
        draft.rule_snapshot_hash,
        candidateEnvelope.ciphertext,
        candidateEnvelope.wrapped_data_key,
        candidateEnvelope.nonce,
        candidateEnvelope.auth_tag,
        candidateEnvelope.master_key_version,
        draft.candidate_state_hash,
        draft.artifact_bundle_hash,
        draft.narrative_bundle_hash,
        draft.semantic_draft_hash,
        draft.commit_envelope_hash,
        null,
        draft.status,
        created_at,
        created_at
      );
      database.prepare(`
        INSERT INTO agent_stage_sessions (
          stage_session_id, run_id, stage, audience, continuity_session_id,
          provider_session_ref, transport, session_state_ciphertext,
          wrapped_data_key, nonce, auth_tag, master_key_version,
          session_state_hash, resume_cursor, session_status,
          latest_invocation_id, created_at, updated_at
        ) VALUES (?, ?, 'continuity', 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', NULL, ?, ?)
      `).run(
        stage_session_id,
        draft.run_id,
        draft.continuity_session_id,
        provider_session_ref,
        transport,
        stateEnvelope.ciphertext,
        stateEnvelope.wrapped_data_key,
        stateEnvelope.nonce,
        stateEnvelope.auth_tag,
        stateEnvelope.master_key_version,
        stateHash,
        created_at,
        created_at
      );
      const insertObligation = database.prepare(`
        INSERT INTO turn_draft_obligations (
          draft_obligation_id, draft_id, turn_id, obligation_id,
          obligation_kind, binding_scope, obligation_status,
          current_artifact_revision, correction_generation, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', NULL, 0, ?, ?)
      `);
      for (const obligation of draft.obligations) {
        insertObligation.run(
          generatedId(idFactory, 'draft_obligation'),
          draft.draft_id,
          draft.turn_id,
          obligation.obligation_id,
          dbObligationKind(obligation.kind),
          canonicalStringify(
            obligation.bound_scope ?? obligation.binding_scope ?? obligation.target_binding ?? null
          ),
          created_at,
          created_at
        );
      }
    });
    return loadSession(identity);
  }

  function terminalReplay(snapshot, row, command) {
    assertSameAttempt(row, command);
    if (row.command_status === 'IN_PROGRESS') return null;
    const result = open(
      codec,
      envelopeFromRow(row, 'immutable_result_ciphertext'),
      commandResultContext(row),
      'command result'
    );
    if (hashJson(result) !== row.immutable_result_hash) {
      fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'immutable command result hash does not match');
    }
    return freezeDeep({
      draft: snapshot.state.draft,
      result: immutable(result),
      replayed: true,
      replay_context: immutable({
        current_turn_state: snapshot.state.draft.turn_state,
        current_draft_revision: snapshot.state.draft.draft_revision
      })
    });
  }

  async function startCommand(snapshot, command) {
    const draft = snapshot.state.draft;
    if (draft.expected_operation !== command.operation) {
      fail('OPERATION_NOT_ALLOWED', 'operation is not allowed in the current draft phase', {
        expected_operation: draft.expected_operation,
        actual_operation: command.operation
      });
    }
    const state = sessionState(draft, command, snapshot.state.pause);
    const envelope = seal(codec, state, sessionContext(draftIdentity(draft)), 'session state');
    const stateHash = hashJson(state);
    const startedAt = now();
    const outcome = await connection.write(database => {
      const existing = commandRow(database, command.binding.command_attempt_id);
      if (existing) {
        assertSameAttempt(existing, command);
        return { existing: true };
      }
      const current = assertWritableContext(
        database,
        draftIdentity(draft),
        draft.draft_revision,
        draft.lease_fence
      );
      if (current.session_state_hash !== snapshot.row.session_state_hash) {
        fail('DRAFT_REVISION_CONFLICT', 'Continuity session changed before command start');
      }
      database.prepare(`
        INSERT INTO turn_continuity_commands (
          command_attempt_id, run_id, continuity_session_id, invocation_id,
          transport, operation, canonical_request_hash, bundle_hash,
          immutable_result_ciphertext, wrapped_data_key, nonce, auth_tag,
          master_key_version, immutable_result_hash, command_status,
          provider_call_id, lease_fence, expected_draft_revision,
          created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL,
                  'IN_PROGRESS', ?, ?, ?, ?, NULL)
      `).run(
        command.binding.command_attempt_id,
        command.binding.run_id,
        command.binding.continuity_session_id,
        command.binding.invocation_id,
        snapshot.row.session_transport,
        command.operation,
        command.canonical_request_hash,
        command.canonical_bundle_hash,
        command.binding.provider_call_id ?? null,
        command.binding.lease_fence,
        draft.draft_revision,
        startedAt
      );
      const changed = database.prepare(`
        UPDATE agent_stage_sessions
           SET session_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, session_state_hash = ?,
               latest_invocation_id = ?, updated_at = ?
         WHERE stage_session_id = ? AND session_state_hash = ?
      `).run(
        envelope.ciphertext,
        envelope.wrapped_data_key,
        envelope.nonce,
        envelope.auth_tag,
        envelope.master_key_version,
        stateHash,
        command.binding.invocation_id,
        startedAt,
        snapshot.row.stage_session_id,
        snapshot.row.session_state_hash
      );
      if (changed.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'session command-start CAS failed');
      return { existing: false };
    });
    if (outcome.existing) return null;
    await injectFault({
      phase: 'after_command_started',
      command_attempt_id: command.binding.command_attempt_id
    });
    return readSnapshot(command.binding.run_id, command.binding.continuity_session_id);
  }

  function prepareCheckpoint(checkpoint, command, pendingState, timestamp) {
    const state = sessionState(checkpoint.draft, command, pendingState.pause);
    return {
      checkpoint,
      state,
      state_hash: hashJson(state),
      state_envelope: seal(
        codec,
        state,
        sessionContext(draftIdentity(checkpoint.draft)),
        'session checkpoint'
      ),
      candidate_envelope: seal(
        codec,
        checkpoint.draft.candidate_state,
        candidateContext(draftIdentity(checkpoint.draft)),
        'candidate checkpoint'
      ),
      effect: effectPersistenceMaterial(codec, checkpoint, command),
      artifact: artifactPersistenceMaterial(codec, checkpoint, command),
      timestamp
    };
  }

  async function persistAcceptedCheckpoint({
    snapshot,
    prepared,
    descriptor,
    command,
    expectedSessionHash
  }) {
    const { checkpoint, timestamp } = prepared;
    const before = checkpoint.before_draft_revision;
    const after = checkpoint.after_draft_revision;
    const identity = draftIdentity(checkpoint.draft);
    return connection.write(database => {
      const current = assertWritableContext(
        database,
        identity,
        before,
        checkpoint.draft.lease_fence,
        command.binding.command_attempt_id
      );
      if (current.session_state_hash !== expectedSessionHash) {
        fail('DRAFT_REVISION_CONFLICT', 'session changed before item checkpoint');
      }
      const inserted = insertCommandItem(database, {
        idFactory,
        descriptor,
        command,
        draft: checkpoint.draft,
        status: 'ACCEPTED',
        receiptHash: hashJson(receiptFor(checkpoint.draft, checkpoint.kind, checkpoint.id)),
        errorCode: null,
        errorPath: null,
        beforeRevision: before,
        afterRevision: after,
        leaseFence: checkpoint.draft.lease_fence,
        now: timestamp
      });
      if (!inserted) {
        fail('DRAFT_REVISION_CONFLICT', 'accepted item already exists at an unapplied revision');
      }
      if (prepared.effect) {
        const { effect, receipt } = prepared.effect;
        database.prepare(`
          INSERT INTO turn_draft_effects (
            draft_effect_id, draft_id, turn_id, effect_id, effect_seq,
            effect_hash, target_kind, target_id, operation, required_reducer,
            reducer_version, before_hash, after_hash,
            canonical_operation_ciphertext, receipt_hash, applied_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          generatedId(idFactory, 'draft_effect'),
          checkpoint.draft.draft_id,
          checkpoint.draft.turn_id,
          effect.effect_id,
          effect.effect_seq,
          effect.effect_hash,
          prepared.effect.target_kind,
          prepared.effect.target_id,
          prepared.effect.operation,
          effect.required_reducer,
          effect.reducer_version,
          receipt.before_hash,
          receipt.after_hash,
          prepared.effect.canonical_operation_ciphertext,
          hashJson(receipt),
          timestamp
        );
      }
      if (checkpoint.kind === 'domain_check') {
        const ledger = checkpoint.draft.obligation_ledger.find(row => (
          row.obligation_id === checkpoint.id
        ));
        const changed = database.prepare(`
          UPDATE turn_draft_obligations
             SET obligation_status = 'SATISFIED', correction_generation = ?,
                 updated_at = ?
           WHERE draft_id = ? AND turn_id = ? AND obligation_id = ?
             AND obligation_status IN ('OPEN', 'REOPENED')
        `).run(
          ledger.correction_generation,
          timestamp,
          checkpoint.draft.draft_id,
          checkpoint.draft.turn_id,
          checkpoint.id
        );
        if (changed.changes !== 1) fail('DRAFT_LEDGER_CONFLICT', 'domain obligation CAS failed');
      }
      if (prepared.artifact) {
        const { ledger } = prepared.artifact;
        database.prepare(`
          UPDATE turn_draft_artifact_versions
             SET artifact_status = 'SUPERSEDED'
           WHERE turn_id = ? AND obligation_id = ? AND artifact_status = 'CURRENT'
        `).run(checkpoint.draft.turn_id, checkpoint.id);
        database.prepare(`
          INSERT INTO turn_draft_artifact_versions (
            artifact_version_id, draft_id, turn_id, obligation_id,
            artifact_revision, artifact_status, content_ciphertext,
            wrapped_data_key, nonce, auth_tag, master_key_version,
            artifact_hash, source_refs_ciphertext,
            generated_by_invocation_id, generation_plan_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, 'CURRENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          generatedId(idFactory, 'artifact_version'),
          checkpoint.draft.draft_id,
          checkpoint.draft.turn_id,
          checkpoint.id,
          ledger.current_artifact_revision,
          prepared.artifact.content_envelope.ciphertext,
          prepared.artifact.content_envelope.wrapped_data_key,
          prepared.artifact.content_envelope.nonce,
          prepared.artifact.content_envelope.auth_tag,
          prepared.artifact.content_envelope.master_key_version,
          ledger.current_artifact_hash,
          prepared.artifact.source_refs_ciphertext,
          prepared.artifact.generated_by_invocation_id,
          prepared.artifact.generation_plan_hash,
          timestamp
        );
        const changed = database.prepare(`
          UPDATE turn_draft_obligations
             SET obligation_status = 'SATISFIED', current_artifact_revision = ?,
                 correction_generation = ?, updated_at = ?
           WHERE draft_id = ? AND turn_id = ? AND obligation_id = ?
             AND obligation_status IN ('OPEN', 'REOPENED', 'SATISFIED')
        `).run(
          ledger.current_artifact_revision,
          ledger.correction_generation,
          timestamp,
          checkpoint.draft.draft_id,
          checkpoint.draft.turn_id,
          checkpoint.id
        );
        if (changed.changes !== 1) fail('DRAFT_LEDGER_CONFLICT', 'artifact obligation CAS failed');
      }
      const changedDraft = database.prepare(`
        UPDATE turn_drafts
           SET lease_fence = ?, draft_revision = ?,
               candidate_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, candidate_state_hash = ?,
               artifact_set_hash = ?, narrative_set_hash = ?, semantic_hash = ?,
               commit_envelope_hash = ?, ready_receipt_hash = ?, draft_status = ?,
               updated_at = ?
         WHERE draft_id = ? AND turn_id = ? AND run_id = ?
           AND lease_fence = ? AND draft_revision = ?
      `).run(
        ...projectionValues(checkpoint.draft, prepared.candidate_envelope, timestamp),
        checkpoint.draft.draft_id,
        checkpoint.draft.turn_id,
        checkpoint.draft.run_id,
        checkpoint.draft.lease_fence,
        before
      );
      if (changedDraft.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'item draft CAS failed');
      const changedSession = database.prepare(`
        UPDATE agent_stage_sessions
           SET session_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, session_state_hash = ?,
               updated_at = ?
         WHERE stage_session_id = ? AND session_state_hash = ?
      `).run(
        prepared.state_envelope.ciphertext,
        prepared.state_envelope.wrapped_data_key,
        prepared.state_envelope.nonce,
        prepared.state_envelope.auth_tag,
        prepared.state_envelope.master_key_version,
        prepared.state_hash,
        timestamp,
        snapshot.row.stage_session_id,
        expectedSessionHash
      );
      if (changedSession.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'item session CAS failed');
      return prepared.state_hash;
    });
  }

  async function persistNoopItem({
    snapshot,
    descriptor,
    outcome,
    command,
    draft,
    expectedSessionHash,
    timestamp
  }) {
    return connection.write(database => {
      const current = assertWritableContext(
        database,
        draftIdentity(draft),
        draft.draft_revision,
        draft.lease_fence,
        command.binding.command_attempt_id
      );
      if (current.session_state_hash !== expectedSessionHash) {
        fail('DRAFT_REVISION_CONFLICT', 'session changed before item audit write');
      }
      const receipt = outcome.status === 'IDEMPOTENT'
        ? receiptFor(draft, descriptor.kind, descriptor.id)
        : null;
      insertCommandItem(database, {
        idFactory,
        descriptor,
        command,
        draft,
        status: outcome.status,
        receiptHash: receipt ? hashJson(receipt) : null,
        errorCode: outcome.status === 'REJECTED' ? outcome.error.code : null,
        errorPath: outcome.status === 'REJECTED' ? outcome.error.path : null,
        beforeRevision: draft.draft_revision,
        afterRevision: draft.draft_revision,
        leaseFence: draft.lease_fence,
        now: timestamp
      });
    });
  }

  async function finalizeCommand({ snapshot, command, execution, expectedSessionHash }) {
    const draft = execution.draft;
    const timestamp = now();
    const state = sessionState(draft, null, snapshot.state.pause);
    const stateEnvelope = seal(codec, state, sessionContext(draftIdentity(draft)), 'final session state');
    const candidateEnvelope = seal(
      codec,
      draft.candidate_state,
      candidateContext(draftIdentity(draft)),
      'final candidate state'
    );
    const resultEnvelope = seal(
      codec,
      execution.result,
      commandResultContext({
        run_id: command.binding.run_id,
        continuity_session_id: command.binding.continuity_session_id,
        invocation_id: command.binding.invocation_id,
        command_attempt_id: command.binding.command_attempt_id,
        canonical_request_hash: command.canonical_request_hash
      }),
      'command result'
    );
    const stateHash = hashJson(state);
    const resultHash = hashJson(execution.result);
    const startRevision = snapshot.state.draft.draft_revision;

    await injectFault({
      phase: 'before_command_finalize',
      command_attempt_id: command.binding.command_attempt_id,
      draft_revision: draft.draft_revision
    });
    await connection.write(database => {
      const current = assertWritableContext(
        database,
        draftIdentity(draft),
        startRevision,
        draft.lease_fence,
        command.binding.command_attempt_id
      );
      if (current.session_state_hash !== expectedSessionHash) {
        fail('DRAFT_REVISION_CONFLICT', 'session changed before command finalize');
      }
      const changedDraft = database.prepare(`
        UPDATE turn_drafts
           SET lease_fence = ?, draft_revision = ?,
               candidate_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, candidate_state_hash = ?,
               artifact_set_hash = ?, narrative_set_hash = ?, semantic_hash = ?,
               commit_envelope_hash = ?, ready_receipt_hash = ?, draft_status = ?,
               updated_at = ?
         WHERE draft_id = ? AND turn_id = ? AND run_id = ?
           AND lease_fence = ? AND draft_revision = ?
      `).run(
        ...projectionValues(draft, candidateEnvelope, timestamp),
        draft.draft_id,
        draft.turn_id,
        draft.run_id,
        draft.lease_fence,
        startRevision
      );
      if (changedDraft.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'final draft CAS failed');
      const updateObligation = database.prepare(`
        UPDATE turn_draft_obligations
           SET obligation_status = ?, current_artifact_revision = ?,
               correction_generation = ?, updated_at = ?
         WHERE draft_id = ? AND turn_id = ? AND obligation_id = ?
      `);
      for (const ledger of draft.obligation_ledger) {
        const changed = updateObligation.run(
          dbObligationStatus(ledger.status),
          ledger.kind === 'domain_check' ? null : (ledger.current_artifact_revision || null),
          ledger.correction_generation,
          timestamp,
          draft.draft_id,
          draft.turn_id,
          ledger.obligation_id
        );
        if (changed.changes !== 1) fail('DRAFT_LEDGER_CONFLICT', 'final obligation projection failed');
      }
      const changedSession = database.prepare(`
        UPDATE agent_stage_sessions
           SET session_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, session_state_hash = ?,
               session_status = ?, resume_cursor = NULL, updated_at = ?
         WHERE stage_session_id = ? AND session_state_hash = ?
      `).run(
        stateEnvelope.ciphertext,
        stateEnvelope.wrapped_data_key,
        stateEnvelope.nonce,
        stateEnvelope.auth_tag,
        stateEnvelope.master_key_version,
        stateHash,
        sessionStatusForResult(execution.result),
        timestamp,
        snapshot.row.stage_session_id,
        expectedSessionHash
      );
      if (changedSession.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'final session CAS failed');
      const changedCommand = database.prepare(`
        UPDATE turn_continuity_commands
           SET immutable_result_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, immutable_result_hash = ?,
               command_status = 'ACCEPTED', completed_at = ?
         WHERE command_attempt_id = ? AND run_id = ?
           AND continuity_session_id = ? AND canonical_request_hash = ?
           AND lease_fence = ? AND command_status = 'IN_PROGRESS'
      `).run(
        resultEnvelope.ciphertext,
        resultEnvelope.wrapped_data_key,
        resultEnvelope.nonce,
        resultEnvelope.auth_tag,
        resultEnvelope.master_key_version,
        resultHash,
        timestamp,
        command.binding.command_attempt_id,
        command.binding.run_id,
        command.binding.continuity_session_id,
        command.canonical_request_hash,
        command.binding.lease_fence
      );
      if (changedCommand.changes !== 1) fail('CONTINUITY_COMMAND_CONFLICT', 'command finalize CAS failed');
      const nextTurnStatus = turnStatusForResult(execution.result);
      if (nextTurnStatus) {
        const changedTurn = database.prepare(`
          UPDATE multiplayer_turns
             SET turn_status = ?, updated_at = ?
           WHERE turn_id = ? AND turn_status IN (
             'STAGING_UPDATES', 'AUDITING', 'REPAIRING_DRAFT',
             'REPAIR_PAUSED', 'AWAITING_BILLING_AUTHORIZATION',
             'RESOLUTION_HANDOFF', 'COMMITTING'
           )
        `).run(nextTurnStatus, timestamp, draft.turn_id);
        if (changedTurn.changes !== 1) fail('TURN_STAGE_CONFLICT', 'turn stage changed before finalize');
      }
    });
    return freezeDeep({ draft, result: execution.result, replayed: false });
  }

  async function continueCommand(snapshot, command, runtime) {
    assertBoundContinuityContext(snapshot, command.binding);
    assertLiveFence(snapshot.row, command.binding);
    const rawExecution = executeTurnBundleCommandWithCheckpoints(
      snapshot.state.draft,
      command,
      runtime
    );
    const descriptors = itemDescriptors(command, snapshot.state.draft);
    const persistedItems = connection.read(database => database.prepare(`
      SELECT item_seq, item_kind, item_id, item_status, canonical_item_hash
        FROM turn_continuity_command_items
       WHERE command_attempt_id = ?
       ORDER BY item_seq
    `).all(command.binding.command_attempt_id));
    const execution = reconstructInterruptedCommandResult(
      rawExecution,
      descriptors,
      persistedItems,
      command
    );
    const descriptorByPath = new Map(descriptors.map(descriptor => [descriptor.path, descriptor]));
    const outcomes = outcomesForDescriptors(descriptors, rawExecution);
    let currentDraft = snapshot.state.draft;
    let currentStateHash = snapshot.row.session_state_hash;

    for (const checkpoint of execution.item_checkpoints) {
      const descriptor = descriptorByPath.get(checkpoint.path);
      if (!descriptor) fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'checkpoint has no command item');
      const timestamp = now();
      const prepared = prepareCheckpoint(checkpoint, command, snapshot.state, timestamp);
      currentStateHash = await persistAcceptedCheckpoint({
        snapshot,
        prepared,
        descriptor,
        command,
        expectedSessionHash: currentStateHash
      });
      currentDraft = checkpoint.draft;
      await injectFault({
        phase: 'after_item_persisted',
        command_attempt_id: command.binding.command_attempt_id,
        item_seq: descriptor.item_seq,
        item_kind: descriptor.kind,
        item_id: descriptor.id,
        draft_revision: currentDraft.draft_revision
      });
    }

    for (let index = 0; index < descriptors.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome.status === 'ACCEPTED') continue;
      await persistNoopItem({
        snapshot,
        descriptor: descriptors[index],
        outcome,
        command,
        draft: currentDraft,
        expectedSessionHash: currentStateHash,
        timestamp: now()
      });
    }

    const finalSnapshot = {
      ...snapshot,
      state: sessionState(currentDraft, command, snapshot.state.pause),
      row: {
        ...snapshot.row,
        session_state_hash: currentStateHash,
        draft_revision: currentDraft.draft_revision
      }
    };
    return finalizeCommand({
      snapshot: finalSnapshot,
      command,
      execution,
      expectedSessionHash: currentStateHash
    });
  }

  async function executeCommand({ command, runtime = {} }) {
    if (!command || command.schema !== 'naruto.bound-continuity-command/v1' || !command.binding) {
      fail('CONTINUITY_REPOSITORY_INPUT_INVALID', 'a bound Continuity command is required');
    }
    const binding = command.binding;
    const snapshot = readSnapshot(binding.run_id, binding.continuity_session_id);
    if (binding.run_id !== snapshot.state.draft.run_id
      || binding.continuity_session_id !== snapshot.state.draft.continuity_session_id) {
      fail('INVALID_CONTINUITY_SESSION', 'command is bound to another Continuity session');
    }
    assertBoundContinuityContext(snapshot, binding);
    assertLiveFence(snapshot.row, binding);
    const existing = connection.read(database => commandRow(database, binding.command_attempt_id));
    if (existing) {
      const replay = terminalReplay(snapshot, existing, command);
      if (replay) return replay;
      assertSameAttempt(existing, command);
      if (!snapshot.state.pending_command
        || snapshot.state.pending_command.binding.command_attempt_id !== binding.command_attempt_id) {
        fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'in-progress command is not the session cursor');
      }
      return continueCommand(snapshot, snapshot.state.pending_command, runtime);
    }
    const started = await startCommand(snapshot, command);
    if (!started) return executeCommand({ command, runtime });
    return continueCommand(started, command, runtime);
  }

  async function executeTransport({ transport_input, bound_context, runtime = {} }) {
    assertIdentifier(bound_context?.run_id, 'bound_context.run_id');
    assertIdentifier(bound_context?.continuity_session_id, 'bound_context.continuity_session_id');
    const snapshot = readSnapshot(
      bound_context.run_id,
      bound_context.continuity_session_id
    );
    assertBoundContinuityContext(snapshot, bound_context);
    if (transport_input?.transport_mode !== snapshot.row.session_transport) {
      fail('CONTINUITY_TRANSPORT_MISMATCH', 'transport differs from the frozen session transport');
    }
    try {
      const decoded = decodeContinuityCommand(transport_input);
      const command = bindContinuityCommand(decoded, bound_context);
      return executeCommand({ command, runtime });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PROTOCOL_VIOLATION') {
        return freezeDeep({
          draft: snapshot.state.draft,
          result: createProtocolRetryResult(snapshot.state.draft, error),
          replayed: false
        });
      }
      throw error;
    }
  }

  async function recoverInProgress({ run_id, continuity_session_id, runtime = {} }) {
    const snapshot = readSnapshot(run_id, continuity_session_id);
    const command = snapshot.state.pending_command;
    if (!command) return null;
    const row = connection.read(database => commandRow(
      database,
      command.binding.command_attempt_id
    ));
    if (!row || row.command_status !== 'IN_PROGRESS') {
      fail('PERSISTED_CONTINUITY_STATE_CORRUPT', 'pending session command has no in-progress ledger row');
    }
    assertSameAttempt(row, command);
    return continueCommand(snapshot, command, runtime);
  }

  async function pauseSession({
    run_id,
    continuity_session_id,
    lease_fence,
    pause_reason,
    resume_stage,
    paused_at = now()
  }) {
    if (!PAUSE_REASONS.has(pause_reason) || !RESUME_STAGES.has(resume_stage)) {
      fail('CONTINUITY_REPOSITORY_INPUT_INVALID', 'pause reason or resume stage is invalid');
    }
    assertRevision(lease_fence, 'lease_fence', 1);
    assertTimestamp(paused_at, 'paused_at');
    const snapshot = readSnapshot(run_id, continuity_session_id);
    assertLiveFence(snapshot.row, { lease_fence });
    if (snapshot.state.draft.status === 'READY' || snapshot.state.draft.status === 'DISCARDED') {
      fail('OPERATION_NOT_ALLOWED', 'terminal TurnDraft cannot be paused');
    }
    const turnState = pause_reason === 'BILLING_AUTHORIZATION_REQUIRED'
      ? 'AWAITING_BILLING_AUTHORIZATION'
      : 'REPAIR_PAUSED';
    const pause = immutable({
      pause_reason,
      turn_state: turnState,
      resume_stage,
      draft_revision: snapshot.state.draft.draft_revision,
      lease_fence,
      paused_at
    });
    const draft = immutable({ ...snapshot.state.draft, turn_state: turnState });
    const state = sessionState(draft, snapshot.state.pending_command, pause);
    const envelope = seal(codec, state, sessionContext(draftIdentity(draft)), 'paused session state');
    const stateHash = hashJson(state);
    const cursor = canonicalStringify(pause);
    await connection.write(database => {
      const current = assertWritableContext(
        database,
        draftIdentity(draft),
        draft.draft_revision,
        lease_fence
      );
      if (current.session_state_hash !== snapshot.row.session_state_hash) {
        fail('DRAFT_REVISION_CONFLICT', 'session changed before pause');
      }
      const changed = database.prepare(`
        UPDATE agent_stage_sessions
           SET session_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, session_state_hash = ?,
               resume_cursor = ?, session_status = 'PAUSED', updated_at = ?
         WHERE stage_session_id = ? AND session_state_hash = ?
      `).run(
        envelope.ciphertext,
        envelope.wrapped_data_key,
        envelope.nonce,
        envelope.auth_tag,
        envelope.master_key_version,
        stateHash,
        cursor,
        paused_at,
        snapshot.row.stage_session_id,
        snapshot.row.session_state_hash
      );
      if (changed.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'pause session CAS failed');
      const changedTurn = database.prepare(`
        UPDATE multiplayer_turns SET turn_status = ?, updated_at = ?
         WHERE turn_id = ? AND turn_status NOT IN (
           'COMMITTED', 'TURN_VOIDED', 'CONSISTENCY_FAULT', 'COMMITTING'
         )
      `).run(turnState, paused_at, draft.turn_id);
      if (changedTurn.changes !== 1) fail('TURN_STAGE_CONFLICT', 'turn cannot be paused now');
    });
    return loadSession({ run_id, continuity_session_id });
  }

  async function resumeSession({
    run_id,
    continuity_session_id,
    lease_fence,
    resumed_at = now()
  }) {
    assertRevision(lease_fence, 'lease_fence', 1);
    assertTimestamp(resumed_at, 'resumed_at');
    const snapshot = readSnapshot(run_id, continuity_session_id);
    assertLiveFence(snapshot.row, { lease_fence });
    const pause = snapshot.state.pause;
    if (!pause || snapshot.row.session_status !== 'PAUSED') {
      fail('OPERATION_NOT_ALLOWED', 'Continuity session is not paused');
    }
    if (pause.lease_fence !== lease_fence
      || pause.draft_revision !== snapshot.state.draft.draft_revision) {
      fail('DRAFT_REVISION_CONFLICT', 'pause cursor no longer matches the TurnDraft');
    }
    const draft = immutable({ ...snapshot.state.draft, turn_state: pause.resume_stage });
    const state = sessionState(draft, snapshot.state.pending_command, null);
    const envelope = seal(codec, state, sessionContext(draftIdentity(draft)), 'resumed session state');
    const stateHash = hashJson(state);
    const nextSessionStatus = draft.expected_operation === 'repair_turn_bundle'
      ? 'WAITING_REPAIR'
      : 'OPEN';
    await connection.write(database => {
      const current = assertWritableContext(
        database,
        draftIdentity(draft),
        draft.draft_revision,
        lease_fence
      );
      if (current.session_state_hash !== snapshot.row.session_state_hash) {
        fail('DRAFT_REVISION_CONFLICT', 'session changed before resume');
      }
      const changed = database.prepare(`
        UPDATE agent_stage_sessions
           SET session_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, session_state_hash = ?,
               resume_cursor = NULL, session_status = ?, updated_at = ?
         WHERE stage_session_id = ? AND session_state_hash = ?
      `).run(
        envelope.ciphertext,
        envelope.wrapped_data_key,
        envelope.nonce,
        envelope.auth_tag,
        envelope.master_key_version,
        stateHash,
        nextSessionStatus,
        resumed_at,
        snapshot.row.stage_session_id,
        snapshot.row.session_state_hash
      );
      if (changed.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'resume session CAS failed');
      const changedTurn = database.prepare(`
        UPDATE multiplayer_turns SET turn_status = ?, updated_at = ?
         WHERE turn_id = ? AND (
           turn_status IN ('AWAITING_BILLING_AUTHORIZATION', 'REPAIR_PAUSED')
           OR turn_status = ?
         )
      `).run(pause.resume_stage, resumed_at, draft.turn_id, pause.resume_stage);
      if (changedTurn.changes !== 1) fail('TURN_STAGE_CONFLICT', 'turn pause cursor cannot resume');
    });
    return loadSession({ run_id, continuity_session_id });
  }

  async function adoptLease({
    run_id,
    continuity_session_id,
    new_lease_fence,
    expected_previous_lease_fence = null,
    adopted_at = now()
  }) {
    assertRevision(new_lease_fence, 'new_lease_fence', 1);
    assertTimestamp(adopted_at, 'adopted_at');
    const snapshot = readSnapshot(run_id, continuity_session_id, { allowProjectionDrift: true });
    const previousDraft = snapshot.state.draft;
    if (new_lease_fence === previousDraft.lease_fence) {
      if (snapshot.row.lease_fence !== new_lease_fence
        || snapshot.row.run_lease_fence !== new_lease_fence) {
        fail('STALE_LEASE_FENCE', 'idempotent lease adoption does not match SQLite authority');
      }
      return loadSession({ run_id, continuity_session_id });
    }
    if (expected_previous_lease_fence !== null
      && previousDraft.lease_fence !== expected_previous_lease_fence) {
      fail('STALE_LEASE_FENCE', 'session is not bound to the expected previous fence');
    }
    if (new_lease_fence <= previousDraft.lease_fence) {
      fail('STALE_LEASE_FENCE', 'lease takeover fence must increase monotonically');
    }
    let draft = rebindTurnDraftLease(previousDraft, new_lease_fence);
    let pendingCommand = snapshot.state.pending_command;
    if (pendingCommand) {
      pendingCommand = immutable({
        ...pendingCommand,
        binding: { ...pendingCommand.binding, lease_fence: new_lease_fence }
      });
    }
    let pause = snapshot.state.pause;
    if (pause) {
      pause = immutable({
        ...pause,
        lease_fence: new_lease_fence,
        draft_revision: draft.draft_revision
      });
    }
    const state = sessionState(draft, pendingCommand, pause);
    const stateEnvelope = seal(codec, state, sessionContext(draftIdentity(draft)), 'rebound session state');
    const candidateEnvelope = seal(
      codec,
      draft.candidate_state,
      candidateContext(draftIdentity(draft)),
      'rebound candidate state'
    );
    const stateHash = hashJson(state);
    await connection.write(database => {
      const run = database.prepare(`
        SELECT run_status, lease_fence FROM resolution_runs WHERE run_id = ?
      `).get(run_id);
      if (!run || !ACTIVE_RUN_STATUSES.has(run.run_status) || run.lease_fence !== new_lease_fence) {
        fail('STALE_LEASE_FENCE', 'resolution run has not granted the takeover fence');
      }
      const projected = database.prepare(`
        SELECT lease_fence, draft_revision FROM turn_drafts
         WHERE draft_id = ? AND run_id = ?
      `).get(draft.draft_id, run_id);
      const alreadyRebound = projected?.lease_fence === new_lease_fence
        && projected?.draft_revision === draft.draft_revision;
      const stillPrevious = projected?.lease_fence === previousDraft.lease_fence
        && projected?.draft_revision === previousDraft.draft_revision;
      if (!alreadyRebound && !stillPrevious) {
        fail('DRAFT_REVISION_CONFLICT', 'draft changed during lease takeover', projected ?? {});
      }
      {
        const expectedFence = stillPrevious
          ? previousDraft.lease_fence
          : new_lease_fence;
        const expectedRevision = stillPrevious
          ? previousDraft.draft_revision
          : draft.draft_revision;
        const changed = database.prepare(`
          UPDATE turn_drafts
             SET lease_fence = ?, draft_revision = ?,
                 candidate_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
                 auth_tag = ?, master_key_version = ?, candidate_state_hash = ?,
                 artifact_set_hash = ?, narrative_set_hash = ?, semantic_hash = ?,
                 commit_envelope_hash = ?, ready_receipt_hash = ?, draft_status = ?,
                 updated_at = ?
           WHERE draft_id = ? AND run_id = ? AND lease_fence = ? AND draft_revision = ?
        `).run(
          ...projectionValues(draft, candidateEnvelope, adopted_at),
          draft.draft_id,
          run_id,
          expectedFence,
          expectedRevision
        );
        if (changed.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'draft takeover CAS failed');
      }
      const changedSession = database.prepare(`
        UPDATE agent_stage_sessions
           SET session_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, session_state_hash = ?,
               resume_cursor = ?, updated_at = ?
         WHERE stage_session_id = ? AND session_state_hash = ?
      `).run(
        stateEnvelope.ciphertext,
        stateEnvelope.wrapped_data_key,
        stateEnvelope.nonce,
        stateEnvelope.auth_tag,
        stateEnvelope.master_key_version,
        stateHash,
        pause ? canonicalStringify(pause) : null,
        adopted_at,
        snapshot.row.stage_session_id,
        snapshot.row.session_state_hash
      );
      if (changedSession.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'session takeover CAS failed');
      if (pendingCommand) {
        const changedCommand = database.prepare(`
          UPDATE turn_continuity_commands
             SET lease_fence = ?
           WHERE command_attempt_id = ? AND run_id = ?
             AND continuity_session_id = ? AND lease_fence = ?
             AND command_status = 'IN_PROGRESS'
        `).run(
          new_lease_fence,
          pendingCommand.binding.command_attempt_id,
          run_id,
          continuity_session_id,
          previousDraft.lease_fence
        );
        if (changedCommand.changes !== 1) {
          fail('CONTINUITY_COMMAND_CONFLICT', 'pending command takeover CAS failed');
        }
      }
    });
    return loadSession({ run_id, continuity_session_id });
  }

  async function materializeReady({
    run_id,
    continuity_session_id,
    lease_fence,
    expected_draft_revision,
    candidate_state,
    billing_provenance_hash,
    materialized_at = now()
  }) {
    assertRevision(lease_fence, 'lease_fence', 1);
    assertRevision(expected_draft_revision, 'expected_draft_revision');
    assertTimestamp(materialized_at, 'materialized_at');
    const snapshot = readSnapshot(run_id, continuity_session_id);
    assertLiveFence(snapshot.row, { lease_fence });
    if (snapshot.state.draft.draft_revision !== expected_draft_revision) {
      fail('DRAFT_REVISION_CONFLICT', 'READY materialization revision changed');
    }
    const draft = materializeReadyTurnDraft(snapshot.state.draft, {
      candidate_state,
      billing_provenance_hash
    });
    const state = sessionState(draft, null, null);
    const stateEnvelope = seal(codec, state, sessionContext(draftIdentity(draft)), 'materialized session state');
    const candidateEnvelope = seal(
      codec,
      draft.candidate_state,
      candidateContext(draftIdentity(draft)),
      'materialized candidate state'
    );
    const stateHash = hashJson(state);
    await connection.write(database => {
      const current = assertWritableContext(
        database,
        draftIdentity(snapshot.state.draft),
        expected_draft_revision,
        lease_fence
      );
      if (current.session_state_hash !== snapshot.row.session_state_hash) {
        fail('DRAFT_REVISION_CONFLICT', 'session changed before READY materialization');
      }
      const projection = projectionValues(draft, candidateEnvelope, materialized_at);
      const changedDraft = database.prepare(`
        UPDATE turn_drafts
           SET lease_fence = ?, draft_revision = ?,
               candidate_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, candidate_state_hash = ?,
               artifact_set_hash = ?, narrative_set_hash = ?, semantic_hash = ?,
               commit_envelope_hash = ?, ready_receipt_hash = ?, draft_status = ?,
               billing_provenance_hash = ?, updated_at = ?
         WHERE draft_id = ? AND run_id = ? AND lease_fence = ? AND draft_revision = ?
      `).run(
        ...projection.slice(0, -1),
        billing_provenance_hash,
        materialized_at,
        draft.draft_id,
        run_id,
        lease_fence,
        expected_draft_revision
      );
      if (changedDraft.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'READY materialization CAS failed');
      const changedSession = database.prepare(`
        UPDATE agent_stage_sessions
           SET session_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
               auth_tag = ?, master_key_version = ?, session_state_hash = ?,
               session_status = 'COMPLETE', resume_cursor = NULL, updated_at = ?
         WHERE stage_session_id = ? AND session_state_hash = ?
      `).run(
        stateEnvelope.ciphertext,
        stateEnvelope.wrapped_data_key,
        stateEnvelope.nonce,
        stateEnvelope.auth_tag,
        stateEnvelope.master_key_version,
        stateHash,
        materialized_at,
        snapshot.row.stage_session_id,
        snapshot.row.session_state_hash
      );
      if (changedSession.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'READY session materialization CAS failed');
    });
    return loadSession({ run_id, continuity_session_id });
  }

  return Object.freeze({
    createSession,
    loadSession,
    executeCommand,
    executeTransport,
    recoverInProgress,
    pauseSession,
    resumeSession,
    adoptLease,
    materializeReady
  });
}

export { SESSION_STATE_SCHEMA };
