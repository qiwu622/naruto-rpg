import { DomainError, domainInvariant } from './errors.js';
import {
  assertJsonSafe,
  canonicalizeJson,
  canonicalStringify,
  hmacSha256,
  sha256Hex
} from './canonical-json.js';
import {
  TURN_EXECUTION_PLAN_SCHEMA,
  assertTurnExecutionPlan
} from '../contracts/room-contracts.js';

export const ACTION_REQUEST_SCHEMA = 'naruto.multiplayer-action/v1';
export const ACTION_TURN_SCHEMA = 'naruto.multiplayer-action-turn/v1';
export const ACTION_SUBMISSION_SCHEMA = 'naruto.multiplayer-action-submission/v1';
export const EXECUTION_PLAN_SCHEMA = TURN_EXECUTION_PLAN_SCHEMA;
export const REFEREE_INPUT_SCHEMA = 'naruto.multiplayer-referee-input/v1';
export const WRITER_ACTION_PROJECTION_SCHEMA = 'naruto.multiplayer-writer-actions/v1';

export const ACTION_LIMITS = Object.freeze({
  textMaxLength: 20_000,
  narrationNoteMaxLength: 1_000,
  idempotencyKeyMaxLength: 200,
  identifierMaxLength: 256
});

const SEATS = Object.freeze(['A', 'B']);
const NARRATIVE_MODES = new Set(['shared', 'dual_pov']);
const PRE_RESOLUTION_VISIBILITIES = new Set(['open', 'sealed']);
const NARRATION_PREFERENCES = new Set(['full', 'summarize_intent']);
const TURN_STATES = new Set(['COLLECTING_ACTIONS', 'ONE_ACTION_LOCKED', 'SEALED', 'COMMITTED']);
const REQUEST_KEYS = new Set([
  'schema',
  'base_state_revision',
  'text',
  'pre_resolution_visibility',
  'narration_preference',
  'narration_note',
  'idempotency_key'
]);
const FORBIDDEN_TEXT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function immutableJson(value) {
  return freezeDeep(canonicalizeJson(value));
}

function assertPlainObject(value, code, label) {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (!value || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw new DomainError(code, `${label} must be a plain object`);
  }
}

function assertAllowedKeys(value, allowed, code, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new DomainError(code, `${label} contains an unknown property`, { property: key });
    }
  }
}

function assertString(value, field, { min = 1, max = ACTION_LIMITS.identifierMaxLength } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new DomainError('INVALID_ACTION_FIELD', `${field} must be a string between ${min} and ${max} characters`, {
      field,
      min,
      max
    });
  }
  if (FORBIDDEN_TEXT_CONTROL.test(value)) {
    throw new DomainError('INVALID_ACTION_FIELD', `${field} contains a forbidden Unicode control character`, {
      field
    });
  }
  return value;
}

function assertSeat(seat) {
  if (!SEATS.includes(seat)) {
    throw new DomainError('INVALID_SEAT', 'seat must be A or B', { seat });
  }
  return seat;
}

function oppositeSeat(seat) {
  return seat === 'A' ? 'B' : 'A';
}

function actionCount(turn) {
  return Number(Boolean(turn.actions.A)) + Number(Boolean(turn.actions.B));
}

function assertIsoTimestamp(value) {
  assertString(value, 'receivedAt', { max: 64 });
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new DomainError('INVALID_RECEIVED_AT', 'receivedAt must be a valid server timestamp');
  }
  return value;
}

function assertTurnShape(turn) {
  assertPlainObject(turn, 'INVALID_ACTION_TURN', 'turn');
  if (turn.schema !== ACTION_TURN_SCHEMA || !TURN_STATES.has(turn.status)) {
    throw new DomainError('INVALID_ACTION_TURN', 'turn has an unsupported schema or state', {
      schema: turn.schema,
      status: turn.status
    });
  }
  assertPlainObject(turn.actions, 'INVALID_ACTION_TURN', 'turn.actions');
  if (!(Object.prototype.hasOwnProperty.call(turn.actions, 'A'))
    || !(Object.prototype.hasOwnProperty.call(turn.actions, 'B'))) {
    throw new DomainError('INVALID_ACTION_TURN', 'turn.actions must contain A and B slots');
  }
  if (turn.queued_narrative_mode !== null
    && !NARRATIVE_MODES.has(turn.queued_narrative_mode)) {
    throw new DomainError('INVALID_ACTION_TURN', 'queued_narrative_mode must be null, shared or dual_pov');
  }
  return turn;
}

function requestHash(request) {
  return `sha256:${sha256Hex(canonicalStringify(request))}`;
}

function receiptFor(submission) {
  return immutableJson({
    submission_id: submission.submission_id,
    seat: submission.seat,
    receipt_seq: submission.receipt_seq,
    received_at: submission.received_at,
    content_commitment: submission.content_commitment,
    base_state_revision: submission.base_state_revision
  });
}

/** Strictly validates and detaches the client action request. */
export function normalizeActionRequest(request) {
  assertJsonSafe(request, { maxDepth: 4, maxNodes: 32 });
  assertPlainObject(request, 'INVALID_ACTION_REQUEST', 'action request');
  assertAllowedKeys(request, REQUEST_KEYS, 'INVALID_ACTION_REQUEST', 'action request');

  if (request.schema !== ACTION_REQUEST_SCHEMA) {
    throw new DomainError('INVALID_ACTION_SCHEMA', `schema must be ${ACTION_REQUEST_SCHEMA}`, {
      schema: request.schema
    });
  }
  if (!Number.isSafeInteger(request.base_state_revision) || request.base_state_revision < 0) {
    throw new DomainError('INVALID_ACTION_FIELD', 'base_state_revision must be a non-negative safe integer', {
      field: 'base_state_revision'
    });
  }

  assertString(request.text, 'text', { max: ACTION_LIMITS.textMaxLength });
  if (!request.text.trim()) {
    throw new DomainError('INVALID_ACTION_FIELD', 'text must contain a non-whitespace action', { field: 'text' });
  }
  if (!PRE_RESOLUTION_VISIBILITIES.has(request.pre_resolution_visibility)) {
    throw new DomainError('INVALID_ACTION_FIELD', 'pre_resolution_visibility must be open or sealed', {
      field: 'pre_resolution_visibility'
    });
  }
  if (!NARRATION_PREFERENCES.has(request.narration_preference)) {
    throw new DomainError('INVALID_ACTION_FIELD', 'narration_preference must be full or summarize_intent', {
      field: 'narration_preference'
    });
  }
  assertString(request.idempotency_key, 'idempotency_key', {
    max: ACTION_LIMITS.idempotencyKeyMaxLength
  });

  const normalized = {
    schema: ACTION_REQUEST_SCHEMA,
    base_state_revision: request.base_state_revision,
    text: request.text,
    pre_resolution_visibility: request.pre_resolution_visibility,
    narration_preference: request.narration_preference,
    idempotency_key: request.idempotency_key
  };

  if (Object.prototype.hasOwnProperty.call(request, 'narration_note')) {
    assertString(request.narration_note, 'narration_note', {
      min: 0,
      max: ACTION_LIMITS.narrationNoteMaxLength
    });
    normalized.narration_note = request.narration_note;
  }

  return immutableJson(normalized);
}

/**
 * Detaches and recursively freezes the execution plan selected before the
 * first action. The hash is kept on the turn, outside the plan itself.
 */
export function freezeExecutionPlan(plan, expectedNarrativeMode = undefined) {
  if (expectedNarrativeMode && typeof expectedNarrativeMode === 'object') {
    expectedNarrativeMode = expectedNarrativeMode.expectedNarrativeMode
      ?? expectedNarrativeMode.expected_narrative_mode;
  }
  assertJsonSafe(plan, { maxDepth: 24, maxNodes: 10_000 });
  assertPlainObject(plan, 'INVALID_EXECUTION_PLAN', 'execution plan');

  const declaredMode = plan.narrative_mode;
  if (!NARRATIVE_MODES.has(declaredMode)) {
    throw new DomainError('INVALID_EXECUTION_PLAN', 'execution plan must declare shared or dual_pov narrative_mode');
  }
  if (expectedNarrativeMode !== undefined && declaredMode !== expectedNarrativeMode) {
    throw new DomainError('EXECUTION_PLAN_MODE_MISMATCH', 'execution plan mode does not match the turn mode', {
      expected: expectedNarrativeMode,
      actual: declaredMode
    });
  }

  return assertTurnExecutionPlan({
    ...plan,
    schema: EXECUTION_PLAN_SCHEMA,
    narrative_mode: declaredMode
  });
}

export function createActionTurn(config) {
  assertJsonSafe(config, { maxDepth: 3, maxNodes: 32 });
  assertPlainObject(config, 'INVALID_ACTION_TURN', 'turn config');
  assertAllowedKeys(config, new Set([
    'room_id',
    'epoch_id',
    'turn_id',
    'turn_no',
    'base_state_revision',
    'active_narrative_mode'
  ]), 'INVALID_ACTION_TURN', 'turn config');

  assertString(config.room_id, 'room_id');
  assertString(config.epoch_id, 'epoch_id');
  assertString(config.turn_id, 'turn_id');
  if (!Number.isSafeInteger(config.turn_no) || config.turn_no < 1) {
    throw new DomainError('INVALID_ACTION_TURN', 'turn_no must be a positive safe integer');
  }
  if (!Number.isSafeInteger(config.base_state_revision) || config.base_state_revision < 0) {
    throw new DomainError('INVALID_ACTION_TURN', 'base_state_revision must be a non-negative safe integer');
  }
  if (!NARRATIVE_MODES.has(config.active_narrative_mode)) {
    throw new DomainError('INVALID_ACTION_TURN', 'active_narrative_mode must be shared or dual_pov');
  }

  return immutableJson({
    schema: ACTION_TURN_SCHEMA,
    room_id: config.room_id,
    epoch_id: config.epoch_id,
    turn_id: config.turn_id,
    turn_no: config.turn_no,
    base_state_revision: config.base_state_revision,
    active_narrative_mode: config.active_narrative_mode,
    queued_narrative_mode: null,
    post_commit_disclosure: 'full_after_commit',
    status: 'COLLECTING_ACTIONS',
    execution_plan: null,
    execution_plan_hash: null,
    actions: { A: null, B: null }
  });
}

/**
 * Applies the room's documented narrative-mode rule to the current turn.
 * With no locked action the mode changes immediately. Once the execution plan
 * is frozen, only the next-turn queue changes; the current plan is untouched.
 */
export function requestNarrativeModeChange(turn, requestedMode) {
  assertTurnShape(turn);
  if (requestedMode && typeof requestedMode === 'object') {
    requestedMode = requestedMode.narrative_mode ?? requestedMode.mode;
  }
  if (!NARRATIVE_MODES.has(requestedMode)) {
    throw new DomainError('INVALID_NARRATIVE_MODE', 'narrative mode must be shared or dual_pov', {
      requested_mode: requestedMode
    });
  }

  const lockedCount = actionCount(turn);
  if (turn.status === 'COLLECTING_ACTIONS' && lockedCount === 0) {
    const nextTurn = requestedMode === turn.active_narrative_mode
      && turn.queued_narrative_mode === null
      ? turn
      : immutableJson({
          ...turn,
          active_narrative_mode: requestedMode,
          queued_narrative_mode: null
        });
    return freezeDeep({
      turn: nextTurn,
      disposition: 'applied_current_turn',
      requested_mode: requestedMode
    });
  }

  if (lockedCount > 0 && turn.status !== 'COMMITTED') {
    const queuedMode = requestedMode === turn.active_narrative_mode ? null : requestedMode;
    const nextTurn = queuedMode === turn.queued_narrative_mode
      ? turn
      : immutableJson({ ...turn, queued_narrative_mode: queuedMode });
    return freezeDeep({
      turn: nextTurn,
      disposition: 'queued_next_turn',
      requested_mode: requestedMode
    });
  }

  throw new DomainError('INVALID_TURN_STATE', 'narrative mode cannot be changed through this completed turn', {
    status: turn.status
  });
}

export const changeNarrativeMode = requestNarrativeModeChange;

function contentCommitment(turn, seat, text, serverSecret) {
  return `hmac-sha256:${hmacSha256(serverSecret, {
    schema: 'naruto.multiplayer-action-commitment/v1',
    room_id: turn.room_id,
    epoch_id: turn.epoch_id,
    turn_id: turn.turn_id,
    seat,
    text
  })}`;
}

/**
 * Locks exactly one action and returns a new immutable turn. Persistence code
 * must commit the returned turn, access grant and outbox records atomically.
 */
export function lockActionSubmission(turn, command) {
  assertTurnShape(turn);
  assertPlainObject(command, 'INVALID_ACTION_COMMAND', 'lock action command');

  const seat = assertSeat(command.seat);
  const request = normalizeActionRequest(command.request);
  const incomingRequestHash = requestHash(request);
  const existing = turn.actions[seat];

  // Transport replay is checked before the state gate so a lost response can
  // be recovered even after the turn has advanced to SEALED or COMMITTED.
  if (existing) {
    if (existing.idempotency_key === request.idempotency_key) {
      if (existing.request_hash !== incomingRequestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'idempotency_key was reused with different action content', {
          seat,
          idempotency_key: request.idempotency_key
        });
      }
      return freezeDeep({
        turn,
        receipt: receiptFor(existing),
        replayed: true,
        pre_resolution_reveal: null
      });
    }
    throw new DomainError('ACTION_ALREADY_LOCKED', 'this seat already locked an action for the turn', {
      seat,
      turn_id: turn.turn_id
    });
  }

  if (turn.status !== 'COLLECTING_ACTIONS' && turn.status !== 'ONE_ACTION_LOCKED') {
    throw new DomainError('INVALID_TURN_STATE', 'the turn is not accepting player actions', {
      status: turn.status
    });
  }
  if (request.base_state_revision !== turn.base_state_revision) {
    throw new DomainError('STALE_STATE_REVISION', 'action is based on a stale world state revision', {
      expected: turn.base_state_revision,
      actual: request.base_state_revision
    });
  }

  const lockedCount = actionCount(turn);
  if ((lockedCount === 0) !== (turn.status === 'COLLECTING_ACTIONS')) {
    throw new DomainError('INVALID_ACTION_TURN', 'turn state and locked action count disagree');
  }

  let executionPlan = turn.execution_plan;
  let executionPlanHash = turn.execution_plan_hash;
  const suppliedExecutionPlan = command.executionPlan ?? command.execution_plan;
  if (lockedCount === 0) {
    if (suppliedExecutionPlan === undefined) {
      throw new DomainError('EXECUTION_PLAN_REQUIRED', 'the first action must freeze a TurnExecutionPlan');
    }
    executionPlan = freezeExecutionPlan(suppliedExecutionPlan, turn.active_narrative_mode);
    executionPlanHash = `sha256:${sha256Hex(canonicalStringify(executionPlan))}`;
  } else if (suppliedExecutionPlan !== undefined) {
    const proposedPlan = freezeExecutionPlan(suppliedExecutionPlan, turn.active_narrative_mode);
    const proposedHash = `sha256:${sha256Hex(canonicalStringify(proposedPlan))}`;
    if (proposedHash !== executionPlanHash) {
      throw new DomainError('EXECUTION_PLAN_FROZEN', 'the execution plan cannot change after the first action lock', {
        expected_hash: executionPlanHash,
        actual_hash: proposedHash
      });
    }
  }

  const submissionId = command.submissionId ?? command.submission_id;
  const receivedAt = command.receivedAt ?? command.received_at;
  const serverSecret = command.serverSecret ?? command.server_secret;
  assertString(submissionId, 'submissionId');
  assertIsoTimestamp(receivedAt);
  const other = turn.actions[oppositeSeat(seat)];
  if (other?.submission_id === submissionId) {
    throw new DomainError('DUPLICATE_SUBMISSION_ID', 'submissionId must be unique within the turn', {
      submission_id: submissionId
    });
  }

  const revealAudience = lockedCount === 0 && request.pre_resolution_visibility === 'open'
    ? oppositeSeat(seat)
    : null;
  const submission = {
    schema: ACTION_SUBMISSION_SCHEMA,
    submission_id: submissionId,
    seat,
    base_state_revision: request.base_state_revision,
    text: request.text,
    pre_resolution_visibility: request.pre_resolution_visibility,
    post_commit_disclosure: 'full_after_commit',
    narration_preference: request.narration_preference,
    idempotency_key: request.idempotency_key,
    request_hash: incomingRequestHash,
    content_commitment: contentCommitment(turn, seat, request.text, serverSecret),
    receipt_seq: lockedCount + 1,
    received_at: receivedAt,
    pre_resolution_revealed_to: revealAudience ? [revealAudience] : []
  };
  if (Object.prototype.hasOwnProperty.call(request, 'narration_note')) {
    submission.narration_note = request.narration_note;
  }

  const nextTurn = immutableJson({
    ...turn,
    status: lockedCount === 0 ? 'ONE_ACTION_LOCKED' : 'SEALED',
    execution_plan: executionPlan,
    execution_plan_hash: executionPlanHash,
    actions: {
      ...turn.actions,
      [seat]: submission
    }
  });
  const storedSubmission = nextTurn.actions[seat];

  return freezeDeep({
    turn: nextTurn,
    receipt: receiptFor(storedSubmission),
    replayed: false,
    // Deliberately contains no action text. The outbox stores only this grant.
    pre_resolution_reveal: revealAudience
      ? immutableJson({ submission_id: storedSubmission.submission_id, audience_seat: revealAudience })
      : null
  });
}

export const lockAction = lockActionSubmission;

/** Marks the access boundary after the application's atomic final commit. */
export function commitActionTurn(turn) {
  assertTurnShape(turn);
  if (turn.status === 'COMMITTED') return turn;
  domainInvariant(
    turn.status === 'SEALED' && turn.actions.A && turn.actions.B,
    'INVALID_TURN_STATE',
    'only a sealed turn with two actions can become COMMITTED',
    { status: turn.status }
  );
  return immutableJson({ ...turn, status: 'COMMITTED' });
}

export const markActionTurnCommitted = commitActionTurn;

/**
 * Produces the member-facing action access view. A hidden opponent record has
 * no ID, text, length, hash, commitment, receipt sequence or timestamp.
 */
export function projectActionTurn(turn, viewerSeat) {
  assertTurnShape(turn);
  assertSeat(viewerSeat);

  const actions = {};
  for (const seat of SEATS) {
    const submission = turn.actions[seat];
    if (!submission) {
      actions[seat] = { seat, locked: false };
      continue;
    }

    const isOwner = seat === viewerSeat;
    const isCommitted = turn.status === 'COMMITTED';
    const wasPreRevealed = submission.pre_resolution_revealed_to.includes(viewerSeat);
    if (!isOwner && !isCommitted && !wasPreRevealed) {
      actions[seat] = { seat, locked: true };
      continue;
    }

    const visible = {
      seat,
      locked: true,
      submission_id: submission.submission_id,
      text: submission.text,
      disclosure: isOwner
        ? 'owner'
        : (isCommitted ? 'full_after_commit' : 'open_pre_resolution')
    };
    if (isOwner) visible.receipt = receiptFor(submission);
    actions[seat] = visible;
  }

  return immutableJson({
    schema: 'naruto.multiplayer-action-turn-projection/v1',
    turn_id: turn.turn_id,
    turn_no: turn.turn_no,
    viewer_seat: viewerSeat,
    status: turn.status,
    active_narrative_mode: turn.active_narrative_mode,
    post_commit_disclosure: 'full_after_commit',
    actions
  });
}

export const projectTurnForMember = projectActionTurn;

/**
 * Creates the only action payload consumed by the Referee. Arrival metadata,
 * visibility and all narration preferences are intentionally not selected.
 */
export function buildRefereeInput(turn, options) {
  assertTurnShape(turn);
  assertPlainObject(options, 'INVALID_REFEREE_INPUT', 'referee input options');
  if (!turn.actions.A || !turn.actions.B || (turn.status !== 'SEALED' && turn.status !== 'COMMITTED')) {
    throw new DomainError('INVALID_TURN_STATE', 'both actions must be sealed before Referee input is built', {
      status: turn.status
    });
  }

  const baseState = options.baseState ?? options.base_state;
  const rulesVersion = options.rulesVersion ?? options.rules_version;
  const serverSecret = options.serverSecret ?? options.server_secret;
  assertJsonSafe(baseState, { maxDepth: 64, maxNodes: 100_000 });
  assertString(rulesVersion, 'rulesVersion');

  const payload = {
    schema: REFEREE_INPUT_SCHEMA,
    room_id: turn.room_id,
    epoch_id: turn.epoch_id,
    turn_id: turn.turn_id,
    turn_no: turn.turn_no,
    base_state_revision: turn.base_state_revision,
    rules_version: rulesVersion,
    base_state: canonicalizeJson(baseState),
    actions: SEATS.map(seat => ({
      seat,
      submission_id: turn.actions[seat].submission_id,
      text: turn.actions[seat].text
    }))
  };
  const inputHash = `hmac-sha256:${hmacSha256(serverSecret, payload)}`;
  return immutableJson({ ...payload, input_hash: inputHash });
}

export const createRefereeInput = buildRefereeInput;

/**
 * Carries untrusted, low-priority presentation requests to a Writer without
 * copying raw action text. `visibleSubmissionIds` lets the AudienceProjector
 * route only requests relevant to that Writer's canonical event projection.
 */
export function buildWriterActionProjection(turn, options = {}) {
  assertTurnShape(turn);
  assertPlainObject(options, 'INVALID_WRITER_PROJECTION', 'writer projection options');
  if (!turn.actions.A || !turn.actions.B || (turn.status !== 'SEALED' && turn.status !== 'COMMITTED')) {
    throw new DomainError('INVALID_TURN_STATE', 'both actions must be sealed before Writer input is built', {
      status: turn.status
    });
  }

  const audienceSeat = options.audienceSeat ?? options.audience_seat ?? null;
  if (audienceSeat !== null) assertSeat(audienceSeat);

  const suppliedVisibleIds = options.visibleSubmissionIds ?? options.visible_submission_ids;
  if (!Array.isArray(suppliedVisibleIds)) {
    throw new DomainError(
      'INVALID_WRITER_PROJECTION',
      'visibleSubmissionIds must be an explicit audience-safe array'
    );
  }
  const visibleIds = new Set(suppliedVisibleIds.map(id => assertString(id, 'visibleSubmissionIds[]')));

  const presentationRequests = [];
  for (const seat of SEATS) {
    const submission = turn.actions[seat];
    if (!submission || !visibleIds.has(submission.submission_id)) continue;

    const request = {
      submission_id: submission.submission_id,
      action_owner_seat: seat,
      narration_preference: submission.narration_preference,
      trust: 'untrusted_low_priority',
      scope: 'own_action_presentation_only'
    };
    if (Object.prototype.hasOwnProperty.call(submission, 'narration_note')) {
      request.narration_note = submission.narration_note;
    }
    presentationRequests.push(request);
  }

  return immutableJson({
    schema: WRITER_ACTION_PROJECTION_SCHEMA,
    turn_id: turn.turn_id,
    audience: audienceSeat === null ? 'shared' : `seat:${audienceSeat}`,
    narrative_mode: turn.execution_plan?.narrative_mode ?? turn.active_narrative_mode,
    presentation_requests: presentationRequests
  });
}

export const buildWriterProjection = buildWriterActionProjection;
export const createWriterActionProjection = buildWriterActionProjection;
