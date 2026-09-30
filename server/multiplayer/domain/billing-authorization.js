import {
  assertJsonSafe,
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from './canonical-json.js';
import { DomainError, domainInvariant } from './errors.js';
import {
  POV_WRITER_SELECTION_SCHEMA,
  TURN_PAYER_SELECTION_SCHEMA,
  assertExecutionGrant,
  assertExecutionGrantUsable,
  assertPOVWriterSelection,
  assertPOVWriterSelectionReady,
  assertTurnBillingPlan,
  assertTurnBillingPlanMatchesSelections,
  assertTurnPayerSelection
} from '../contracts/billing-contracts.js';

export const TURN_BILLING_AUTHORIZATION_STATE_SCHEMA =
  'naruto.multiplayer-turn-billing-authorization-state/v1';
export const TURN_BILLING_PREFLIGHT_RECEIPT_SCHEMA =
  'naruto.multiplayer-turn-billing-preflight-receipt/v1';

const SEATS = Object.freeze(['A', 'B']);
const NARRATIVE_MODES = new Set(['shared', 'dual_pov']);
const SHARED_STAGES = Object.freeze([
  'referee',
  'resolution_completeness_reviewer',
  'resolution_repair',
  'continuity_steward',
  'continuity_repair',
  'narrative_grounding_reviewer'
]);

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

function hash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPlainObject(value, code, label) {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (!value || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw new DomainError(code, `${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, allowed, code, label, { required = allowed } = {}) {
  assertPlainObject(value, code, label);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new DomainError(code, `${label} contains an unknown property`, { property: key });
    }
  }
  for (const key of required) {
    if (!own(value, key)) {
      throw new DomainError(code, `${label} is missing a required property`, { property: key });
    }
  }
  return value;
}

function assertIdentifier(value, field) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 256) {
    throw new DomainError('INVALID_BILLING_FIELD', `${field} must be a non-empty identifier`, { field });
  }
  return value;
}

function assertText(value, field, max = 256) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new DomainError('INVALID_BILLING_FIELD', `${field} must be a non-empty string`, { field });
  }
  return value;
}

function assertTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new DomainError('INVALID_BILLING_FIELD', `${field} must be an ISO timestamp`, { field });
  }
  return value;
}

function assertRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError('INVALID_BILLING_FIELD', `${field} must be a non-negative safe integer`, { field });
  }
  return value;
}

function assertMembersBySeat(value) {
  assertExactKeys(value, SEATS, 'INVALID_BILLING_MEMBERS', 'members_by_seat');
  for (const seat of SEATS) assertIdentifier(value[seat], `members_by_seat.${seat}`);
  domainInvariant(value.A !== value.B, 'INVALID_BILLING_MEMBERS', 'A and B must be distinct members');
  return value;
}

function seatForUser(membersBySeat, userId) {
  return SEATS.find(seat => membersBySeat[seat] === userId) ?? null;
}

function selectionHash(selection, hashField = 'selection_hash') {
  const hashInput = canonicalizeJson(selection);
  delete hashInput[hashField];
  return hash(hashInput);
}

function requestHash(command) {
  const normalized = canonicalizeJson(command);
  delete normalized.idempotency_key;
  return hash(normalized);
}

function findIdempotency(state, scope, key) {
  return state.idempotency_records.find(record => record.scope === scope && record.key === key) ?? null;
}

function assertIdempotency(state, scope, key, currentRequestHash) {
  const existing = findIdempotency(state, scope, key);
  if (!existing) return null;
  if (existing.request_hash !== currentRequestHash) {
    throw new DomainError(
      'IDEMPOTENCY_KEY_REUSED',
      'billing selection idempotency key was reused with different parameters',
      { scope, key }
    );
  }
  return existing;
}

function assertStateMutable(state) {
  if (state.selections_frozen) {
    throw new DomainError(
      'EXECUTION_PLAN_FROZEN',
      'payer selections cannot change after the first action lock'
    );
  }
}

export function assertTurnBillingAuthorizationState(value) {
  assertJsonSafe(value, { maxDepth: 64, maxNodes: 100_000 });
  assertExactKeys(value, [
    'schema',
    'room_id',
    'epoch_id',
    'turn_id',
    'narrative_mode',
    'members_by_seat',
    'control_revision',
    'turn_payer_selection',
    'pov_writer_selections',
    'selection_history',
    'idempotency_records',
    'selections_frozen',
    'frozen_selection_hashes',
    'billing_preflight_receipt'
  ], 'INVALID_BILLING_STATE', 'turn billing authorization state');
  domainInvariant(
    value.schema === TURN_BILLING_AUTHORIZATION_STATE_SCHEMA,
    'INVALID_BILLING_STATE',
    `schema must be ${TURN_BILLING_AUTHORIZATION_STATE_SCHEMA}`
  );
  for (const field of ['room_id', 'epoch_id', 'turn_id']) assertIdentifier(value[field], field);
  domainInvariant(
    NARRATIVE_MODES.has(value.narrative_mode),
    'INVALID_BILLING_STATE',
    'narrative_mode must be shared or dual_pov'
  );
  const members = assertMembersBySeat(value.members_by_seat);
  assertRevision(value.control_revision, 'control_revision');
  if (value.turn_payer_selection !== null) {
    const shared = assertTurnPayerSelection(value.turn_payer_selection);
    domainInvariant(shared.turn_id === value.turn_id, 'INVALID_BILLING_STATE', 'shared selection turn mismatch');
    domainInvariant(
      members[shared.payer_seat] === shared.payer_user_id,
      'INVALID_BILLING_STATE',
      'shared payer seat/user binding is not authoritative'
    );
    domainInvariant(
      selectionHash(shared) === shared.selection_hash,
      'INVALID_BILLING_STATE',
      'shared selection hash is invalid'
    );
  }
  assertExactKeys(
    value.pov_writer_selections,
    SEATS,
    'INVALID_BILLING_STATE',
    'pov_writer_selections'
  );
  for (const audience of SEATS) {
    const candidate = value.pov_writer_selections[audience];
    if (candidate === null) continue;
    const selection = assertPOVWriterSelection(candidate, {
      expected_audience_owner_user_id: members[audience]
    });
    domainInvariant(
      selection.turn_id === value.turn_id
        && selection.audience === audience
        && members[selection.payer_seat] === selection.payer_user_id,
      'INVALID_BILLING_STATE',
      'POV selection authority binding is invalid'
    );
    domainInvariant(
      selectionHash(selection) === selection.selection_hash,
      'INVALID_BILLING_STATE',
      'POV selection hash is invalid'
    );
  }
  domainInvariant(Array.isArray(value.selection_history), 'INVALID_BILLING_STATE', 'selection_history must be an array');
  domainInvariant(Array.isArray(value.idempotency_records), 'INVALID_BILLING_STATE', 'idempotency_records must be an array');
  domainInvariant(typeof value.selections_frozen === 'boolean', 'INVALID_BILLING_STATE', 'selections_frozen must be boolean');
  if (value.selections_frozen) {
    domainInvariant(
      value.frozen_selection_hashes !== null,
      'INVALID_BILLING_STATE',
      'frozen selections require their immutable hashes'
    );
    assertExactKeys(value.frozen_selection_hashes, [
      'turn_payer_selection_hash',
      'pov_writer_selection_hashes'
    ], 'INVALID_BILLING_STATE', 'frozen_selection_hashes');
    domainInvariant(
      value.turn_payer_selection !== null
        && value.frozen_selection_hashes.turn_payer_selection_hash
          === value.turn_payer_selection.selection_hash,
      'INVALID_BILLING_STATE',
      'frozen shared selection hash does not match the active selection'
    );
    if (value.narrative_mode === 'dual_pov') {
      assertExactKeys(
        value.frozen_selection_hashes.pov_writer_selection_hashes,
        SEATS,
        'INVALID_BILLING_STATE',
        'frozen POV selection hashes'
      );
      for (const audience of SEATS) {
        domainInvariant(
          value.pov_writer_selections[audience] !== null
            && value.frozen_selection_hashes.pov_writer_selection_hashes[audience]
              === value.pov_writer_selections[audience].selection_hash,
          'INVALID_BILLING_STATE',
          'frozen POV selection hash does not match the active selection',
          { audience }
        );
      }
    } else {
      domainInvariant(
        value.frozen_selection_hashes.pov_writer_selection_hashes === null,
        'INVALID_BILLING_STATE',
        'shared mode must not freeze POV selection hashes'
      );
    }
  } else {
    domainInvariant(
      value.frozen_selection_hashes === null && value.billing_preflight_receipt === null,
      'INVALID_BILLING_STATE',
      'unfrozen turn cannot have frozen hashes or a billing preflight receipt'
    );
  }
  if (value.billing_preflight_receipt !== null) {
    const receipt = value.billing_preflight_receipt;
    assertExactKeys(receipt, [
      'schema',
      'room_id',
      'epoch_id',
      'turn_id',
      'plan_revision',
      'plan_hash',
      'authorized_plan_item_ids',
      'payer_authorization_ids',
      'consent_ids',
      'budget_reservations',
      'ready_at'
    ], 'INVALID_BILLING_STATE', 'billing preflight receipt');
    domainInvariant(
      receipt.schema === TURN_BILLING_PREFLIGHT_RECEIPT_SCHEMA
        && receipt.room_id === value.room_id
        && receipt.epoch_id === value.epoch_id
        && receipt.turn_id === value.turn_id,
      'INVALID_BILLING_STATE',
      'billing preflight receipt authority binding is invalid'
    );
    assertRevision(receipt.plan_revision, 'billing_preflight_receipt.plan_revision');
    assertText(receipt.plan_hash, 'billing_preflight_receipt.plan_hash');
    assertTimestamp(receipt.ready_at, 'billing_preflight_receipt.ready_at');
    for (const field of [
      'authorized_plan_item_ids',
      'payer_authorization_ids',
      'consent_ids',
      'budget_reservations'
    ]) {
      domainInvariant(Array.isArray(receipt[field]), 'INVALID_BILLING_STATE', `${field} must be an array`);
    }
  }
  return immutable(value);
}

export function createTurnBillingAuthorizationState(config) {
  assertJsonSafe(config, { maxDepth: 16, maxNodes: 10_000 });
  assertExactKeys(config, [
    'room_id',
    'epoch_id',
    'turn_id',
    'narrative_mode',
    'members_by_seat',
    'control_revision'
  ], 'INVALID_BILLING_CONFIG', 'turn billing config');
  for (const field of ['room_id', 'epoch_id', 'turn_id']) assertIdentifier(config[field], field);
  domainInvariant(
    NARRATIVE_MODES.has(config.narrative_mode),
    'INVALID_BILLING_CONFIG',
    'narrative_mode must be shared or dual_pov'
  );
  assertMembersBySeat(config.members_by_seat);
  assertRevision(config.control_revision, 'control_revision');
  return assertTurnBillingAuthorizationState({
    schema: TURN_BILLING_AUTHORIZATION_STATE_SCHEMA,
    room_id: config.room_id,
    epoch_id: config.epoch_id,
    turn_id: config.turn_id,
    narrative_mode: config.narrative_mode,
    members_by_seat: config.members_by_seat,
    control_revision: config.control_revision,
    turn_payer_selection: null,
    pov_writer_selections: { A: null, B: null },
    selection_history: [],
    idempotency_records: [],
    selections_frozen: false,
    frozen_selection_hashes: null,
    billing_preflight_receipt: null
  });
}

/** A new turn deliberately carries no payer/profile/acceptance from its predecessor. */
export function startNextTurnBillingAuthorization(previousValue, config) {
  const previous = assertTurnBillingAuthorizationState(previousValue);
  domainInvariant(config.turn_id !== previous.turn_id, 'INVALID_BILLING_CONFIG', 'next turn_id must be new');
  return createTurnBillingAuthorizationState({
    room_id: previous.room_id,
    epoch_id: config.epoch_id ?? previous.epoch_id,
    turn_id: config.turn_id,
    narrative_mode: config.narrative_mode,
    members_by_seat: previous.members_by_seat,
    control_revision: config.control_revision
  });
}

function assertPayerSelf(state, context, payerSeat) {
  const payerUserId = state.members_by_seat[payerSeat];
  if (!payerUserId || context.authenticated_user_id !== payerUserId) {
    throw new DomainError(
      'PAYER_SELF_REQUIRED',
      'only the selected payer may choose and accept use of their profile'
    );
  }
  return payerUserId;
}

function assertExpectedControlRevision(state, context, label = 'payer selection') {
  if (context.expected_control_revision !== state.control_revision) {
    throw new DomainError('STALE_CONTROL_REVISION', `${label} control revision is stale`);
  }
}

export function selectTurnPayer(stateValue, command, context) {
  const state = assertTurnBillingAuthorizationState(stateValue);
  assertStateMutable(state);
  assertExactKeys(command, [
    'payer_seat',
    'profile_ref',
    'stage_config_fingerprints',
    'idempotency_key'
  ], 'INVALID_PAYER_SELECTION', 'shared payer command');
  domainInvariant(SEATS.includes(command.payer_seat), 'INVALID_PAYER_SELECTION', 'payer_seat must be A or B');
  const payerUserId = assertPayerSelf(state, context, command.payer_seat);
  const key = assertText(command.idempotency_key, 'idempotency_key', 200);
  const currentRequestHash = requestHash(command);
  const replay = assertIdempotency(state, 'shared', key, currentRequestHash);
  if (replay) return state;
  assertExpectedControlRevision(state, context);
  const selectionRevision = (state.turn_payer_selection?.selection_revision ?? 0) + 1;
  const selection = {
    schema: TURN_PAYER_SELECTION_SCHEMA,
    turn_id: state.turn_id,
    selection_revision: selectionRevision,
    expected_control_revision: state.control_revision,
    payer_user_id: payerUserId,
    payer_seat: command.payer_seat,
    profile_ref: command.profile_ref,
    stage_config_fingerprints: command.stage_config_fingerprints,
    payer_acceptance: {
      accepted_by_user_id: payerUserId,
      accepted_at: assertTimestamp(context.accepted_at, 'accepted_at')
    },
    idempotency_key: key,
    selection_hash: `sha256:${'0'.repeat(64)}`,
    active: true
  };
  selection.selection_hash = selectionHash(selection);
  const accepted = assertTurnPayerSelection(selection, {
    authenticated_user_id: context.authenticated_user_id,
    expected_payer_seat: command.payer_seat
  });
  return assertTurnBillingAuthorizationState({
    ...state,
    control_revision: state.control_revision + 1,
    turn_payer_selection: accepted,
    selection_history: [...state.selection_history, {
      scope: 'shared',
      replaced_selection_hash: state.turn_payer_selection?.selection_hash ?? null,
      selection: accepted
    }],
    idempotency_records: [...state.idempotency_records, {
      scope: 'shared',
      key,
      request_hash: currentRequestHash,
      selection_hash: accepted.selection_hash
    }]
  });
}

export function selectPOVWriterPayer(stateValue, command, context) {
  const state = assertTurnBillingAuthorizationState(stateValue);
  assertStateMutable(state);
  domainInvariant(
    state.narrative_mode === 'dual_pov',
    'INVALID_POV_SELECTION',
    'POV Writer selections only exist for dual_pov turns'
  );
  assertExactKeys(command, [
    'audience',
    'payer_seat',
    'profile_ref',
    'writer_config_fingerprint',
    'idempotency_key'
  ], 'INVALID_POV_SELECTION', 'POV payer command');
  domainInvariant(SEATS.includes(command.audience), 'INVALID_POV_SELECTION', 'audience must be A or B');
  domainInvariant(SEATS.includes(command.payer_seat), 'INVALID_POV_SELECTION', 'payer_seat must be A or B');
  const payerUserId = assertPayerSelf(state, context, command.payer_seat);
  const audienceOwnerUserId = state.members_by_seat[command.audience];
  const scope = `pov:${command.audience}`;
  const key = assertText(command.idempotency_key, 'idempotency_key', 200);
  const currentRequestHash = requestHash(command);
  const replay = assertIdempotency(state, scope, key, currentRequestHash);
  if (replay) return state;
  assertExpectedControlRevision(state, context, 'POV payer selection');
  const previous = state.pov_writer_selections[command.audience];
  const selection = {
    schema: POV_WRITER_SELECTION_SCHEMA,
    turn_id: state.turn_id,
    selection_revision: (previous?.selection_revision ?? 0) + 1,
    expected_control_revision: state.control_revision,
    audience: command.audience,
    audience_owner_user_id: audienceOwnerUserId,
    payer_user_id: payerUserId,
    payer_seat: command.payer_seat,
    profile_ref: command.profile_ref,
    writer_config_fingerprint: command.writer_config_fingerprint,
    payer_acceptance: {
      accepted_by_user_id: payerUserId,
      accepted_at: assertTimestamp(context.accepted_at, 'accepted_at')
    },
    audience_acceptance: payerUserId === audienceOwnerUserId
      ? { accepted_by_user_id: audienceOwnerUserId, accepted_at: context.accepted_at }
      : null,
    idempotency_key: key,
    selection_hash: `sha256:${'0'.repeat(64)}`,
    active: true
  };
  selection.selection_hash = selectionHash(selection);
  const accepted = assertPOVWriterSelection(selection, {
    authenticated_user_id: payerUserId,
    accepting_as: 'payer',
    expected_audience_owner_user_id: audienceOwnerUserId
  });
  return assertTurnBillingAuthorizationState({
    ...state,
    control_revision: state.control_revision + 1,
    pov_writer_selections: {
      ...state.pov_writer_selections,
      [command.audience]: accepted
    },
    selection_history: [...state.selection_history, {
      scope,
      replaced_selection_hash: previous?.selection_hash ?? null,
      selection: accepted
    }],
    idempotency_records: [...state.idempotency_records, {
      scope,
      key,
      request_hash: currentRequestHash,
      selection_hash: accepted.selection_hash
    }]
  });
}

export function acceptPOVWriterAudience(stateValue, command, context) {
  const state = assertTurnBillingAuthorizationState(stateValue);
  assertStateMutable(state);
  assertExactKeys(command, [
    'audience',
    'selection_revision',
    'idempotency_key'
  ], 'INVALID_POV_ACCEPTANCE', 'POV audience acceptance');
  domainInvariant(SEATS.includes(command.audience), 'INVALID_POV_ACCEPTANCE', 'audience must be A or B');
  const ownerUserId = state.members_by_seat[command.audience];
  if (context.authenticated_user_id !== ownerUserId) {
    throw new DomainError(
      'POV_OWNER_SELF_REQUIRED',
      'only the POV owner may accept processing of their private projection'
    );
  }
  const scope = `pov-acceptance:${command.audience}:${command.selection_revision}`;
  const key = assertText(command.idempotency_key, 'idempotency_key', 200);
  const currentRequestHash = requestHash(command);
  const replay = assertIdempotency(state, scope, key, currentRequestHash);
  if (replay) return state;
  assertExpectedControlRevision(state, context, 'POV acceptance');
  const selection = state.pov_writer_selections[command.audience];
  domainInvariant(Boolean(selection), 'INVALID_POV_ACCEPTANCE', 'POV payer selection does not exist');
  domainInvariant(
    selection.selection_revision === command.selection_revision,
    'STALE_SELECTION_REVISION',
    'POV acceptance targets a replaced selection'
  );
  const next = canonicalizeJson(selection);
  next.audience_acceptance = {
    accepted_by_user_id: ownerUserId,
    accepted_at: assertTimestamp(context.accepted_at, 'accepted_at')
  };
  next.selection_hash = selectionHash(next);
  const accepted = assertPOVWriterSelection(next, {
    authenticated_user_id: ownerUserId,
    accepting_as: 'audience',
    expected_audience_owner_user_id: ownerUserId
  });
  return assertTurnBillingAuthorizationState({
    ...state,
    control_revision: state.control_revision + 1,
    pov_writer_selections: {
      ...state.pov_writer_selections,
      [command.audience]: accepted
    },
    selection_history: [...state.selection_history, {
      scope,
      replaced_selection_hash: selection.selection_hash,
      selection: accepted
    }],
    idempotency_records: [...state.idempotency_records, {
      scope,
      key,
      request_hash: currentRequestHash,
      selection_hash: accepted.selection_hash
    }]
  });
}

export function inspectTurnSelectionReadiness(stateValue) {
  const state = assertTurnBillingAuthorizationState(stateValue);
  const reasons = [];
  if (state.turn_payer_selection === null) {
    reasons.push({ code: 'SHARED_PAYER_SELECTION_REQUIRED', scope: 'shared' });
  } else if (!state.turn_payer_selection.active
    || state.turn_payer_selection.payer_acceptance.accepted_by_user_id
      !== state.turn_payer_selection.payer_user_id) {
    reasons.push({ code: 'SHARED_PAYER_SELF_ACCEPTANCE_REQUIRED', scope: 'shared' });
  } else {
    const requiredSharedConfigs = [
      ...SHARED_STAGES,
      ...(state.narrative_mode === 'shared' ? ['writer'] : [])
    ];
    const selectedStages = new Set(
      state.turn_payer_selection.stage_config_fingerprints.map(item => item.stage)
    );
    for (const stage of requiredSharedConfigs) {
      if (!selectedStages.has(stage)) {
        reasons.push({ code: 'SHARED_STAGE_CONFIG_REQUIRED', scope: stage });
      }
    }
  }
  if (state.narrative_mode === 'dual_pov') {
    for (const audience of SEATS) {
      const selection = state.pov_writer_selections[audience];
      if (selection === null) {
        reasons.push({ code: 'POV_WRITER_SELECTION_REQUIRED', scope: `writer:${audience}` });
        continue;
      }
      try {
        assertPOVWriterSelectionReady(selection);
      } catch (error) {
        reasons.push({
          code: selection.payer_acceptance === null
            ? 'POV_PAYER_SELF_ACCEPTANCE_REQUIRED'
            : 'POV_OWNER_CONSENT_REQUIRED',
          scope: `writer:${audience}`
        });
      }
    }
  }
  return immutable({
    ready: reasons.length === 0,
    turn_id: state.turn_id,
    narrative_mode: state.narrative_mode,
    reasons
  });
}

export function assertTurnSelectionsReady(stateValue) {
  const state = assertTurnBillingAuthorizationState(stateValue);
  const readiness = inspectTurnSelectionReadiness(state);
  if (!readiness.ready) {
    throw new DomainError(
      'AWAITING_PAYER_SELECTION',
      'all required payer and POV selections must be accepted before first action lock',
      { reasons: readiness.reasons }
    );
  }
  return state;
}

export function freezeTurnBillingSelections(stateValue) {
  const state = assertTurnSelectionsReady(stateValue);
  if (state.selections_frozen) return state;
  return assertTurnBillingAuthorizationState({
    ...state,
    selections_frozen: true,
    frozen_selection_hashes: {
      turn_payer_selection_hash: state.turn_payer_selection.selection_hash,
      pov_writer_selection_hashes: state.narrative_mode === 'dual_pov'
        ? {
            A: state.pov_writer_selections.A.selection_hash,
            B: state.pov_writer_selections.B.selection_hash
          }
        : null
    }
  });
}

export function computeTurnBillingPlanHash(planValue) {
  const plan = canonicalizeJson(planValue);
  delete plan.plan_hash;
  return hash(plan);
}

function requiredPlanScopes(narrativeMode) {
  const scopes = SHARED_STAGES.map(stage => `${stage}:shared`);
  if (narrativeMode === 'shared') scopes.push('writer:shared');
  else scopes.push('writer:A', 'writer:B');
  return scopes.sort();
}

function scopeForPlanItem(item) {
  return `${item.stage}:${item.audience ?? 'shared'}`;
}

function assertCompletePlanStageSet(plan) {
  const actual = plan.stage_plans.map(scopeForPlanItem).sort();
  const required = requiredPlanScopes(plan.narrative_mode);
  domainInvariant(
    new Set(actual).size === actual.length,
    'INVALID_BILLING_PLAN',
    'billing plan cannot contain duplicate stage scopes'
  );
  domainInvariant(
    canonicalStringify(actual) === canonicalStringify(required),
    'BILLING_AUTHORIZATION_REQUIRED',
    'billing plan must budget every required initial and repair stage',
    { required_scopes: required, actual_scopes: actual }
  );
}

function assertPayerAuthorization(value, plan, itemsById) {
  assertExactKeys(value, [
    'authorization_id',
    'payer_user_id',
    'authorized_by_user_id',
    'turn_id',
    'plan_revision',
    'plan_hash',
    'plan_item_ids',
    'accepted_at'
  ], 'INVALID_PLAN_AUTHORIZATION', 'payer plan authorization');
  for (const field of ['authorization_id', 'payer_user_id', 'authorized_by_user_id', 'turn_id']) {
    assertIdentifier(value[field], field);
  }
  assertRevision(value.plan_revision, 'plan_revision');
  assertTimestamp(value.accepted_at, 'accepted_at');
  domainInvariant(
    value.authorized_by_user_id === value.payer_user_id,
    'PAYER_SELF_REQUIRED',
    'a player cannot authorize another payer budget'
  );
  domainInvariant(
    value.turn_id === plan.turn_id
      && value.plan_revision === plan.plan_revision
      && value.plan_hash === plan.plan_hash,
    'BILLING_AUTHORIZATION_REQUIRED',
    'payer authorization does not bind the active plan revision'
  );
  domainInvariant(
    Array.isArray(value.plan_item_ids) && value.plan_item_ids.length > 0,
    'INVALID_PLAN_AUTHORIZATION',
    'payer authorization must list its plan items'
  );
  for (const itemId of value.plan_item_ids) {
    const item = itemsById.get(itemId);
    domainInvariant(Boolean(item), 'INVALID_PLAN_AUTHORIZATION', 'authorized plan item does not exist');
    domainInvariant(
      item.payer_user_id === value.payer_user_id,
      'PAYER_SELF_REQUIRED',
      'payer authorization may cover only that payer\'s plan items'
    );
  }
  return value;
}

function assertConsentRequirement(value, itemsById) {
  assertExactKeys(value, [
    'plan_item_id',
    'terms_fingerprint',
    'data_categories_hash'
  ], 'INVALID_CONSENT_REQUIREMENT', 'consent requirement');
  domainInvariant(itemsById.has(value.plan_item_id), 'INVALID_CONSENT_REQUIREMENT', 'plan item does not exist');
  assertText(value.terms_fingerprint, 'terms_fingerprint');
  assertText(value.data_categories_hash, 'data_categories_hash');
  return value;
}

function assertConsent(value, state, plan, item, requirement, now) {
  assertExactKeys(value, [
    'consent_id',
    'subject_user_id',
    'consented_by_user_id',
    'room_id',
    'epoch_id',
    'turn_id',
    'plan_item_id',
    'plan_revision',
    'plan_hash',
    'profile_id',
    'profile_config_fingerprint',
    'normalized_origin',
    'terms_fingerprint',
    'data_categories_hash',
    'consented_at',
    'expires_at',
    'revoked_at'
  ], 'INVALID_DATA_PROCESSING_CONSENT', 'data processing consent');
  for (const field of [
    'consent_id',
    'subject_user_id',
    'consented_by_user_id',
    'room_id',
    'epoch_id',
    'turn_id',
    'plan_item_id',
    'profile_id'
  ]) assertIdentifier(value[field], field);
  assertTimestamp(value.consented_at, 'consented_at');
  assertTimestamp(value.expires_at, 'expires_at');
  assertRevision(value.plan_revision, 'plan_revision');
  if (value.revoked_at !== null) assertTimestamp(value.revoked_at, 'revoked_at');
  domainInvariant(value.revoked_at === null, 'BILLING_AUTHORIZATION_REQUIRED', 'consent is revoked');
  domainInvariant(
    value.consented_by_user_id === value.subject_user_id,
    'POV_OWNER_SELF_REQUIRED',
    'a player cannot accept data processing for another consent subject'
  );
  domainInvariant(Date.parse(now) < Date.parse(value.expires_at), 'BILLING_AUTHORIZATION_REQUIRED', 'consent is expired');
  domainInvariant(
    value.room_id === state.room_id
      && value.epoch_id === state.epoch_id
      && value.turn_id === plan.turn_id
      && value.plan_item_id === item.plan_item_id
      && value.plan_revision === plan.plan_revision
      && value.plan_hash === plan.plan_hash,
    'BILLING_AUTHORIZATION_REQUIRED',
    'consent does not bind the active plan item'
  );
  domainInvariant(
    value.profile_id === item.profile_ref.profile_id
      && value.profile_config_fingerprint === item.profile_ref.config_fingerprint
      && value.normalized_origin === item.profile_ref.normalized_origin,
    'BILLING_AUTHORIZATION_REQUIRED',
    'provider/model/base URL configuration changed after consent'
  );
  domainInvariant(
    value.terms_fingerprint === requirement.terms_fingerprint
      && value.data_categories_hash === requirement.data_categories_hash,
    'BILLING_AUTHORIZATION_REQUIRED',
    'terms or data categories changed after consent'
  );
  return value;
}

function zeroUsage() {
  return { requests: 0, input_tokens: 0, output_tokens: 0, retries: 0 };
}

function addBudget(total, budget) {
  total.requests += budget.max_requests;
  total.input_tokens += budget.max_input_tokens;
  total.output_tokens += budget.max_output_tokens;
  total.retries += budget.max_retries;
}

function normalizeUsage(value, label) {
  const usage = value ?? zeroUsage();
  assertExactKeys(usage, [
    'requests',
    'input_tokens',
    'output_tokens',
    'retries'
  ], 'INVALID_BUDGET_USAGE', label);
  for (const field of Object.keys(usage)) assertRevision(usage[field], `${label}.${field}`);
  return usage;
}

function assertGrantAllocation(value, itemsById, grantsById) {
  assertExactKeys(value, ['plan_item_id', 'grant_id'], 'INVALID_GRANT_ALLOCATION', 'grant allocation');
  domainInvariant(itemsById.has(value.plan_item_id), 'INVALID_GRANT_ALLOCATION', 'plan item does not exist');
  domainInvariant(grantsById.has(value.grant_id), 'INVALID_GRANT_ALLOCATION', 'execution grant does not exist');
  return value;
}

function buildBillingPreflight(state, input) {
  domainInvariant(state.selections_frozen, 'EXECUTION_PLAN_NOT_FROZEN', 'selections must freeze at first action lock');
  const plan = assertTurnBillingPlanMatchesSelections(input.plan, {
    turn_payer_selection: state.turn_payer_selection,
    pov_writer_selections: state.pov_writer_selections
  });
  domainInvariant(plan.turn_id === state.turn_id, 'INVALID_BILLING_PLAN', 'billing plan belongs to another turn');
  domainInvariant(
    plan.plan_hash === computeTurnBillingPlanHash(plan),
    'INVALID_BILLING_PLAN_HASH',
    'billing plan hash does not match canonical plan content'
  );
  assertCompletePlanStageSet(plan);
  const itemsById = new Map(plan.stage_plans.map(item => [item.plan_item_id, item]));

  domainInvariant(Array.isArray(input.payer_authorizations), 'BILLING_AUTHORIZATION_REQUIRED', 'payer authorizations are required');
  const authorizationCoverage = new Map();
  for (const authorization of input.payer_authorizations) {
    assertPayerAuthorization(authorization, plan, itemsById);
    for (const itemId of authorization.plan_item_ids) {
      const prior = authorizationCoverage.get(itemId);
      domainInvariant(!prior, 'INVALID_PLAN_AUTHORIZATION', 'plan item was authorized more than once');
      authorizationCoverage.set(itemId, authorization);
    }
  }
  for (const item of plan.stage_plans) {
    const authorization = authorizationCoverage.get(item.plan_item_id);
    domainInvariant(Boolean(authorization), 'BILLING_AUTHORIZATION_REQUIRED', 'payer plan authorization is missing', {
      plan_item_id: item.plan_item_id
    });
    domainInvariant(
      authorization.payer_user_id === item.payer_user_id,
      'PAYER_SELF_REQUIRED',
      'plan item authorization is not from its actual payer'
    );
  }

  domainInvariant(Array.isArray(input.consent_requirements), 'BILLING_AUTHORIZATION_REQUIRED', 'consent requirements are required');
  const requirementByItem = new Map();
  for (const requirement of input.consent_requirements) {
    assertConsentRequirement(requirement, itemsById);
    domainInvariant(
      !requirementByItem.has(requirement.plan_item_id),
      'INVALID_CONSENT_REQUIREMENT',
      'plan item has duplicate consent requirements'
    );
    requirementByItem.set(requirement.plan_item_id, requirement);
  }
  const now = assertTimestamp(input.now, 'now');
  domainInvariant(Array.isArray(input.consents), 'BILLING_AUTHORIZATION_REQUIRED', 'data processing consents are required');
  const consentCoverage = new Map();
  for (const item of plan.stage_plans) {
    const requirement = requirementByItem.get(item.plan_item_id);
    domainInvariant(Boolean(requirement), 'BILLING_AUTHORIZATION_REQUIRED', 'consent requirement is missing', {
      plan_item_id: item.plan_item_id
    });
    for (const subjectUserId of item.required_consent_subject_user_ids) {
      const matching = input.consents.filter(consent => (
        consent.plan_item_id === item.plan_item_id
          && consent.subject_user_id === subjectUserId
      ));
      domainInvariant(
        matching.length === 1,
        'BILLING_AUTHORIZATION_REQUIRED',
        'required data-processing consent is missing or ambiguous',
        { plan_item_id: item.plan_item_id, subject_user_id: subjectUserId }
      );
      assertConsent(matching[0], state, plan, item, requirement, now);
      consentCoverage.set(`${item.plan_item_id}:${subjectUserId}`, matching[0]);
    }
  }

  domainInvariant(Array.isArray(input.grants), 'BILLING_AUTHORIZATION_REQUIRED', 'execution grants are required');
  const grantsById = new Map();
  for (const value of input.grants) {
    const grant = assertExecutionGrant(value);
    domainInvariant(!grantsById.has(grant.grant_id), 'INVALID_GRANT_ALLOCATION', 'duplicate grant ID');
    grantsById.set(grant.grant_id, grant);
  }
  domainInvariant(Array.isArray(input.grant_allocations), 'BILLING_AUTHORIZATION_REQUIRED', 'grant allocations are required');
  const allocationByItem = new Map();
  for (const allocation of input.grant_allocations) {
    assertGrantAllocation(allocation, itemsById, grantsById);
    domainInvariant(
      !allocationByItem.has(allocation.plan_item_id),
      'INVALID_GRANT_ALLOCATION',
      'plan item can consume only one explicit grant'
    );
    allocationByItem.set(allocation.plan_item_id, allocation.grant_id);
  }
  const requestedByGrant = new Map();
  const itemIdsByGrant = new Map();
  for (const item of plan.stage_plans) {
    const grantId = allocationByItem.get(item.plan_item_id);
    domainInvariant(Boolean(grantId), 'BILLING_AUTHORIZATION_REQUIRED', 'plan item has no execution grant allocation', {
      plan_item_id: item.plan_item_id
    });
    const grant = grantsById.get(grantId);
    assertExecutionGrantUsable(grant, {
      now,
      payer_user_id: item.payer_user_id,
      room_id: state.room_id,
      epoch_id: state.epoch_id,
      turn_id: state.turn_id,
      stage: item.stage,
      audience: item.audience,
      profile_ref: item.profile_ref
    });
    const total = requestedByGrant.get(grantId) ?? zeroUsage();
    addBudget(total, item.budget);
    requestedByGrant.set(grantId, total);
    itemIdsByGrant.set(grantId, [...(itemIdsByGrant.get(grantId) ?? []), item.plan_item_id]);
  }
  const reservations = [];
  for (const [grantId, requestedBudget] of requestedByGrant) {
    const consumedBudget = normalizeUsage(
      input.consumed_budget_by_grant_id?.[grantId],
      `consumed_budget_by_grant_id.${grantId}`
    );
    const grant = grantsById.get(grantId);
    assertExecutionGrantUsable(grant, {
      now,
      room_id: state.room_id,
      epoch_id: state.epoch_id,
      turn_id: state.turn_id,
      profile_ref: grant.profile_ref,
      consumed_budget: consumedBudget,
      requested_budget: requestedBudget
    });
    reservations.push({
      grant_id: grantId,
      payer_user_id: grant.payer_user_id,
      plan_item_ids: itemIdsByGrant.get(grantId).sort(),
      consumed_budget: consumedBudget,
      reserved_budget: requestedBudget
    });
  }
  return immutable({
    schema: TURN_BILLING_PREFLIGHT_RECEIPT_SCHEMA,
    room_id: state.room_id,
    epoch_id: state.epoch_id,
    turn_id: state.turn_id,
    plan_revision: plan.plan_revision,
    plan_hash: plan.plan_hash,
    authorized_plan_item_ids: [...itemsById.keys()].sort(),
    payer_authorization_ids: [...new Set(
      [...authorizationCoverage.values()].map(value => value.authorization_id)
    )].sort(),
    consent_ids: [...new Set(
      [...consentCoverage.values()].map(value => value.consent_id)
    )].sort(),
    budget_reservations: reservations.sort((left, right) => left.grant_id.localeCompare(right.grant_id)),
    ready_at: now
  });
}

export function inspectTurnBillingPlanAuthorization(stateValue, input) {
  try {
    const state = assertTurnBillingAuthorizationState(stateValue);
    const receipt = buildBillingPreflight(state, input);
    return immutable({ ready: true, reasons: [], receipt });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return immutable({
      ready: false,
      reasons: [{ code: error.code, message: error.message, details: error.details ?? {} }],
      receipt: null
    });
  }
}

export function authorizeTurnBillingPlan(stateValue, input) {
  const state = assertTurnBillingAuthorizationState(stateValue);
  const receipt = buildBillingPreflight(state, input);
  if (state.billing_preflight_receipt !== null) {
    if (state.billing_preflight_receipt.plan_hash !== receipt.plan_hash) {
      throw new DomainError(
        'EXECUTION_PLAN_FROZEN',
        'an accepted billing plan cannot be replaced without an append-only amendment'
      );
    }
    return state;
  }
  return assertTurnBillingAuthorizationState({
    ...state,
    billing_preflight_receipt: receipt
  });
}

/** Last pure gate immediately before any network invocation may be created. */
export function assertModelInvocationAuthorized(stateValue, invocation) {
  const state = assertTurnBillingAuthorizationState(stateValue);
  const receipt = state.billing_preflight_receipt;
  if (receipt === null) {
    throw new DomainError(
      'BILLING_AUTHORIZATION_REQUIRED',
      'no model invocation is allowed before full-turn billing preflight'
    );
  }
  assertExactKeys(invocation, [
    'plan_revision',
    'plan_hash',
    'plan_item_id',
    'payer_user_id',
    'grant_id'
  ], 'INVALID_INVOCATION_AUTHORITY', 'model invocation authority');
  domainInvariant(
    invocation.plan_revision === receipt.plan_revision && invocation.plan_hash === receipt.plan_hash,
    'BILLING_AUTHORIZATION_REQUIRED',
    'invocation does not use the active accepted plan revision'
  );
  domainInvariant(
    receipt.authorized_plan_item_ids.includes(invocation.plan_item_id),
    'BILLING_AUTHORIZATION_REQUIRED',
    'invocation plan item was not authorized'
  );
  const reservation = receipt.budget_reservations.find(item => (
    item.grant_id === invocation.grant_id
      && item.payer_user_id === invocation.payer_user_id
      && item.plan_item_ids.includes(invocation.plan_item_id)
  ));
  domainInvariant(
    Boolean(reservation),
    'BILLING_AUTHORIZATION_REQUIRED',
    'invocation payer/grant does not match its reserved plan item'
  );
  return immutable({ authorized: true, receipt, reservation });
}
