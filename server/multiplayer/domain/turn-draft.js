import { DomainError } from './errors.js';
import {
  assertJsonSafe,
  canonicalizeJson,
  canonicalStringify,
  sha256Hex
} from './canonical-json.js';
import { roomCheckpointStateHash } from './lineage.js';
import {
  BOUND_CONTINUITY_COMMAND_SCHEMA,
  CONTINUITY_OPERATIONS,
  bindContinuityCommand,
  decodeContinuityCommand
} from './continuity-bundle.js';

export const TURN_DRAFT_SCHEMA = 'naruto.turn-draft/v1';
export const CONTINUITY_BUNDLE_RESULT_SCHEMA = 'naruto.continuity-bundle-result/v1';
export const REPAIR_PLAN_SCHEMA = 'naruto.continuity-repair-plan/v1';

const EFFECT_ID = /^effect_[A-Za-z0-9_-]{1,80}$/;
const OBLIGATION_ID = /^obligation_[A-Za-z0-9_-]{1,120}$/;
const OBLIGATION_KINDS = new Set(['domain_check', 'memory', 'shinobi_daily']);
const DRAFT_STATUSES = new Set(['OPEN', 'REVIEW_REQUIRED', 'READY', 'DISCARDED']);
const REDUCER_RESULT_KEYS = new Set([
  'nextCandidate',
  'next_candidate',
  'normalizedOperations',
  'normalized_operations',
  'invariantResults',
  'invariant_results'
]);

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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

function cloneJson(value) {
  return canonicalizeJson(value);
}

function hashJson(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

/**
 * Multiplayer state revisions are concurrency tokens, not story content.
 * Keep the generic TurnDraft primitive usable with small test/domain values,
 * while giving authoritative MultiplayerRoomState the exact checkpoint hash
 * semantics used by snapshots and final commits.
 */
export function turnDraftCandidateStateHash(value) {
  if (value?.schema === 'naruto.multiplayer-room-state/v1'
    && value?.actors?.A?.room_actor_id
    && value?.actors?.B?.room_actor_id) {
    return roomCheckpointStateHash(value, {
      A: value.actors.A.room_actor_id,
      B: value.actors.B.room_actor_id
    });
  }
  return hashJson(value);
}

function stableReceiptId(kind, material) {
  return `receipt_${kind}_${sha256Hex(canonicalStringify(material)).slice(0, 32)}`;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertIdentifier(value, field, pattern = undefined) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || (pattern && !pattern.test(value))) {
    throw new DomainError('INVALID_TURN_DRAFT', `${field} is not a valid identifier`, {
      field
    });
  }
  return value;
}

function normalizeObligationKind(kind) {
  if (kind === 'domain' || kind === 'domain_check') return 'domain_check';
  if (kind === 'daily' || kind === 'shinobi_daily') return 'shinobi_daily';
  if (kind === 'memory') return 'memory';
  throw new DomainError('INVALID_TURN_DRAFT', 'obligation kind is unsupported', { kind });
}

function normalizeEffectContract(effect, index) {
  if (!isPlainObject(effect)) {
    throw new DomainError('INVALID_TURN_DRAFT', 'each frozen effect must be an object', {
      index
    });
  }
  assertIdentifier(effect.effect_id, `effects[${index}].effect_id`, EFFECT_ID);
  if (!Number.isSafeInteger(effect.effect_seq) || effect.effect_seq < 1) {
    throw new DomainError('INVALID_TURN_DRAFT', 'effect_seq must be a positive safe integer', {
      effect_id: effect.effect_id
    });
  }
  assertIdentifier(effect.required_reducer, `effects[${index}].required_reducer`);
  assertIdentifier(effect.effect_hash, `effects[${index}].effect_hash`);
  const dependencies = effect.depends_on_effect_ids ?? [];
  if (!Array.isArray(dependencies)) {
    throw new DomainError('INVALID_TURN_DRAFT', 'depends_on_effect_ids must be an array', {
      effect_id: effect.effect_id
    });
  }
  const normalizedDependencies = dependencies.map((dependency, dependencyIndex) => {
    assertIdentifier(
      dependency,
      `effects[${index}].depends_on_effect_ids[${dependencyIndex}]`,
      EFFECT_ID
    );
    return dependency;
  });
  if (new Set(normalizedDependencies).size !== normalizedDependencies.length
    || normalizedDependencies.includes(effect.effect_id)) {
    throw new DomainError('INVALID_TURN_DRAFT', 'effect dependencies must be unique and non-circular', {
      effect_id: effect.effect_id
    });
  }
  return immutableJson({
    ...effect,
    depends_on_effect_ids: normalizedDependencies,
    reducer_version: effect.reducer_version ?? 'unversioned'
  });
}

function normalizeObligationContract(obligation, index) {
  if (!isPlainObject(obligation)) {
    throw new DomainError('INVALID_TURN_DRAFT', 'each obligation must be an object', { index });
  }
  assertIdentifier(
    obligation.obligation_id,
    `obligations[${index}].obligation_id`,
    OBLIGATION_ID
  );
  return immutableJson({
    ...obligation,
    kind: normalizeObligationKind(obligation.kind)
  });
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new DomainError('INVALID_TURN_DRAFT', `${label} must contain unique identifiers`);
  }
}

function normalizeRequiredIds(configured, available, label) {
  const ids = configured ?? available;
  if (!Array.isArray(ids)) {
    throw new DomainError('INVALID_TURN_DRAFT', `${label} must be an array`);
  }
  assertUnique(ids, label);
  const availableSet = new Set(available);
  for (const id of ids) {
    if (!availableSet.has(id)) {
      throw new DomainError('INVALID_TURN_DRAFT', `${label} contains an unknown identifier`, {
        id
      });
    }
  }
  return [...ids];
}

function sortedEffects(effects) {
  return [...effects].sort((left, right) => (
    left.effect_seq - right.effect_seq || compareText(left.effect_id, right.effect_id)
  ));
}

function artifactBundle(draft) {
  return draft.obligation_ledger
    .filter(row => row.current_artifact_hash !== null)
    .sort((left, right) => compareText(left.obligation_id, right.obligation_id))
    .map(row => ({
      obligation_id: row.obligation_id,
      kind: row.kind,
      status: row.status,
      correction_generation: row.correction_generation,
      current_artifact_revision: row.current_artifact_revision,
      current_artifact_hash: row.current_artifact_hash,
      current_artifact: row.current_artifact
    }));
}

function refreshSemanticHashes(draft) {
  draft.candidate_state_hash = turnDraftCandidateStateHash(draft.candidate_state);
  draft.artifact_bundle_hash = hashJson(artifactBundle(draft));
  draft.semantic_draft_hash = hashJson({
    schema: 'naruto.turn-draft-semantic/v1',
    base_state_hash: draft.base_state_hash,
    resolution_hash: draft.resolution_hash,
    obligation_set_hash: draft.obligation_set_hash,
    narrative_bundle_hash: draft.narrative_bundle_hash,
    projection_bundle_hash: draft.projection_bundle_hash,
    rule_snapshot_hash: draft.rule_snapshot_hash,
    reducer_contracts: sortedEffects(draft.frozen_effects).map(effect => ({
      effect_id: effect.effect_id,
      effect_hash: effect.effect_hash,
      effect_seq: effect.effect_seq,
      reducer_version: effect.reducer_version
    })),
    candidate_state_hash: draft.candidate_state_hash,
    artifacts: artifactBundle(draft)
  });
  draft.commit_envelope_hash = hashJson({
    schema: 'naruto.turn-draft-commit-envelope/v1',
    room_id: draft.room_id,
    epoch_id: draft.epoch_id,
    turn_id: draft.turn_id,
    run_id: draft.run_id,
    draft_id: draft.draft_id,
    draft_revision: draft.draft_revision,
    lease_fence: draft.lease_fence,
    semantic_draft_hash: draft.semantic_draft_hash,
    execution_plan_hash: draft.execution_plan_hash,
    billing_provenance_hash: draft.billing_provenance_hash,
    prompt_version: draft.prompt_version
  });
}

/** Creates a detached, deeply immutable in-memory representation of TurnDraft. */
export function createTurnDraft(config) {
  assertJsonSafe(config, { maxDepth: 64, maxNodes: 100_000 });
  if (!isPlainObject(config)) {
    throw new DomainError('INVALID_TURN_DRAFT', 'TurnDraft config must be an object');
  }
  for (const key of [
    'room_id',
    'epoch_id',
    'draft_id',
    'turn_id',
    'run_id',
    'continuity_session_id',
    'resolution_hash',
    'obligation_set_hash',
    'execution_plan_hash',
    'billing_provenance_hash',
    'narrative_bundle_hash',
    'projection_bundle_hash',
    'rule_snapshot_hash',
    'prompt_version'
  ]) {
    assertIdentifier(config[key], key);
  }
  if (!Number.isSafeInteger(config.lease_fence) || config.lease_fence < 1) {
    throw new DomainError('INVALID_TURN_DRAFT', 'lease_fence must be a positive safe integer');
  }
  if (!Number.isSafeInteger(config.base_state_revision) || config.base_state_revision < 0) {
    throw new DomainError('INVALID_TURN_DRAFT', 'base_state_revision must be a non-negative safe integer');
  }

  const rawEffects = config.frozen_effects ?? config.effects ?? [];
  const rawObligations = config.required_obligations ?? config.obligations ?? [];
  if (!Array.isArray(rawEffects) || !Array.isArray(rawObligations)) {
    throw new DomainError('INVALID_TURN_DRAFT', 'effects and obligations must be arrays');
  }
  const effects = rawEffects.map(normalizeEffectContract);
  const obligations = rawObligations.map(normalizeObligationContract);
  assertUnique(effects.map(effect => effect.effect_id), 'effect contracts');
  assertUnique(effects.map(effect => effect.effect_seq), 'effect_seq values');
  const effectSequences = effects.map(effect => effect.effect_seq).sort((left, right) => left - right);
  for (let index = 0; index < effectSequences.length; index += 1) {
    if (effectSequences[index] !== index + 1) {
      throw new DomainError('INVALID_TURN_DRAFT', 'effect_seq values must be contiguous and 1-based', {
        expected: index + 1,
        actual: effectSequences[index]
      });
    }
  }
  assertUnique(obligations.map(obligation => obligation.obligation_id), 'obligation contracts');
  if (obligations.filter(obligation => obligation.kind === 'shinobi_daily').length > 1) {
    throw new DomainError('INVALID_TURN_DRAFT', 'only one shinobi_daily obligation is allowed');
  }

  const effectIds = effects.map(effect => effect.effect_id);
  const obligationIds = obligations.map(obligation => obligation.obligation_id);
  const requiredEffectIds = normalizeRequiredIds(
    config.required_effect_ids,
    effectIds,
    'required_effect_ids'
  );
  const requiredObligationIds = normalizeRequiredIds(
    config.required_obligation_ids,
    obligationIds,
    'required_obligation_ids'
  );
  const effectIdSet = new Set(effectIds);
  for (const effect of effects) {
    for (const dependency of effect.depends_on_effect_ids) {
      if (!effectIdSet.has(dependency)) {
        throw new DomainError('INVALID_TURN_DRAFT', 'effect depends on an unknown frozen effect', {
          effect_id: effect.effect_id,
          dependency
        });
      }
      const dependencyEffect = effects.find(candidate => candidate.effect_id === dependency);
      if (dependencyEffect.effect_seq >= effect.effect_seq) {
        throw new DomainError('INVALID_TURN_DRAFT', 'effect dependencies must precede dependents', {
          effect_id: effect.effect_id,
          dependency
        });
      }
    }
  }

  const baseCandidate = cloneJson(config.base_candidate ?? config.base_state ?? {});
  const draft = {
    schema: TURN_DRAFT_SCHEMA,
    room_id: config.room_id,
    epoch_id: config.epoch_id,
    draft_id: config.draft_id,
    turn_id: config.turn_id,
    run_id: config.run_id,
    continuity_session_id: config.continuity_session_id,
    lease_fence: config.lease_fence,
    status: 'OPEN',
    turn_state: 'STAGING_UPDATES',
    expected_operation: CONTINUITY_OPERATIONS.STAGE,
    draft_revision: 0,
    base_state_revision: config.base_state_revision,
    base_state_hash: config.base_state_hash ?? hashJson(baseCandidate),
    resolution_hash: config.resolution_hash,
    obligation_set_hash: config.obligation_set_hash,
    execution_plan_hash: config.execution_plan_hash,
    billing_provenance_hash: config.billing_provenance_hash,
    narrative_bundle_hash: config.narrative_bundle_hash,
    projection_bundle_hash: config.projection_bundle_hash,
    rule_snapshot_hash: config.rule_snapshot_hash,
    prompt_version: config.prompt_version,
    base_candidate: baseCandidate,
    candidate_state: baseCandidate,
    candidate_state_hash: null,
    artifact_bundle_hash: null,
    semantic_draft_hash: null,
    commit_envelope_hash: null,
    frozen_effects: sortedEffects(effects),
    obligations,
    required_effect_ids: requiredEffectIds,
    required_obligation_ids: requiredObligationIds,
    effect_ledger: sortedEffects(effects).map(effect => ({
      effect_id: effect.effect_id,
      effect_seq: effect.effect_seq,
      effect_hash: effect.effect_hash,
      status: 'PENDING',
      receipt: null
    })),
    obligation_ledger: obligations.map(obligation => ({
      obligation_id: obligation.obligation_id,
      kind: obligation.kind,
      status: 'PENDING',
      correction_generation: 0,
      current_artifact_revision: 0,
      current_artifact_hash: null,
      current_artifact: null,
      receipt: null,
      versions: []
    })),
    commands: [],
    repair_plan: null,
    review_receipt: null,
    ready_receipt: null
  };
  refreshSemanticHashes(draft);
  return immutableJson(draft);
}

/**
 * Server-only READY materialization step. Continuity artifacts are staged as
 * immutable ledger values first; immediately before the authoritative commit
 * the orchestrator folds them into the canonical snapshot, allocates the next
 * state revision, and binds the actual output-adoption provenance. This is
 * deliberately not exposed as a model command.
 */
export function materializeReadyTurnDraft(draftValue, {
  candidate_state,
  billing_provenance_hash
}) {
  assertDraft(draftValue);
  if (draftValue.status !== 'READY' || !draftValue.ready_receipt) {
    throw new DomainError('DRAFT_NOT_READY', 'only a READY TurnDraft may be materialized');
  }
  assertIdentifier(billing_provenance_hash, 'billing_provenance_hash');
  assertJsonSafe(candidate_state, { maxDepth: 96, maxNodes: 500_000 });
  const working = cloneJson(draftValue);
  working.candidate_state = cloneJson(candidate_state);
  working.billing_provenance_hash = billing_provenance_hash;
  working.draft_revision += 1;
  working.review_receipt = null;
  working.ready_receipt = null;
  refreshSemanticHashes(working);
  const reviewReceipt = {
    receipt_id: stableReceiptId('review', {
      draft_id: working.draft_id,
      draft_revision: working.draft_revision,
      semantic_draft_hash: working.semantic_draft_hash,
      commit_envelope_hash: working.commit_envelope_hash,
      lease_fence: working.lease_fence
    }),
    draft_revision: working.draft_revision,
    semantic_draft_hash: working.semantic_draft_hash,
    commit_envelope_hash: working.commit_envelope_hash,
    lease_fence: working.lease_fence
  };
  working.review_receipt = reviewReceipt;
  working.ready_receipt = {
    receipt_id: stableReceiptId('ready', {
      draft_id: working.draft_id,
      draft_revision: working.draft_revision,
      semantic_draft_hash: working.semantic_draft_hash,
      commit_envelope_hash: working.commit_envelope_hash,
      review_receipt_id: reviewReceipt.receipt_id
    }),
    draft_id: working.draft_id,
    draft_revision: working.draft_revision,
    semantic_draft_hash: working.semantic_draft_hash,
    commit_envelope_hash: working.commit_envelope_hash,
    lease_fence: working.lease_fence,
    review_receipt_id: reviewReceipt.receipt_id,
    finalize_metadata: {
      finalized_by: 'server_orchestrator',
      materialized_authoritative_snapshot: true
    }
  };
  working.status = 'READY';
  working.turn_state = 'COMMITTING';
  working.expected_operation = null;
  return immutableJson(working);
}

function assertDraft(draft) {
  assertJsonSafe(draft, { maxDepth: 96, maxNodes: 500_000 });
  if (!isPlainObject(draft) || draft.schema !== TURN_DRAFT_SCHEMA
    || !DRAFT_STATUSES.has(draft.status)
    || !Array.isArray(draft.commands)
    || !Array.isArray(draft.effect_ledger)
    || !Array.isArray(draft.obligation_ledger)) {
    throw new DomainError('INVALID_TURN_DRAFT', 'draft has an invalid shape');
  }
}

function assertBoundCommand(command) {
  assertJsonSafe(command, { maxDepth: 64, maxNodes: 100_000 });
  if (!isPlainObject(command) || command.schema !== BOUND_CONTINUITY_COMMAND_SCHEMA
    || !isPlainObject(command.binding)) {
    throw new DomainError('INVALID_CONTINUITY_COMMAND', 'a bound Continuity command is required');
  }
}

function assertCommandBinding(draft, command) {
  const binding = command.binding;
  if (binding.run_id !== draft.run_id
    || binding.continuity_session_id !== draft.continuity_session_id) {
    throw new DomainError('INVALID_CONTINUITY_SESSION', 'command is bound to another run or session');
  }
  if (own(binding, 'lease_fence') && binding.lease_fence !== draft.lease_fence) {
    throw new DomainError('STALE_LEASE_FENCE', 'command lease fence is stale', {
      expected: draft.lease_fence,
      actual: binding.lease_fence
    });
  }
}

function attemptMatches(record, binding) {
  return record.run_id === binding.run_id
    && record.continuity_session_id === binding.continuity_session_id
    && record.invocation_id === binding.invocation_id
    && record.command_attempt_id === binding.command_attempt_id;
}

function findEffect(draft, effectId) {
  return draft.frozen_effects.find(effect => effect.effect_id === effectId);
}

function findEffectLedger(draft, effectId) {
  return draft.effect_ledger.find(row => row.effect_id === effectId);
}

function findObligation(draft, obligationId) {
  return draft.obligations.find(obligation => obligation.obligation_id === obligationId);
}

function findObligationLedger(draft, obligationId) {
  return draft.obligation_ledger.find(row => row.obligation_id === obligationId);
}

function validatorFor(runtime, kind) {
  const validators = runtime?.validators ?? {};
  return validators[kind]
    ?? (kind === 'domain_check' ? validators.domain : undefined)
    ?? (kind === 'shinobi_daily' ? validators.daily : undefined);
}

function reducerFor(runtime, key) {
  if (typeof runtime?.resolveReducer === 'function') return runtime.resolveReducer(key);
  return runtime?.reducers?.[key];
}

function normalizeThrownItemError(error, fallbackCode, fallbackPath, retryableBy = 'continuity') {
  if (error instanceof DomainError) {
    const relativePath = typeof error.details?.path === 'string'
      ? error.details.path
      : '/';
    const allowedPaths = Array.isArray(error.details?.allowed_paths)
      ? error.details.allowed_paths
      : [relativePath];
    return {
      code: error.code,
      message: error.message,
      relative_path: relativePath,
      allowed_paths: allowedPaths,
      retryable_by: error.details?.retryable_by ?? retryableBy
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    relative_path: '/',
    allowed_paths: ['/'],
    retryable_by: retryableBy
  };
}

function invokeValidator(validator, value, contract, context, kind) {
  if (typeof validator !== 'function') {
    throw new DomainError('INVALID_ITEM_CONTRACT', `no strict ${kind} validator is installed`, {
      path: '/',
      retryable_by: 'orchestrator',
      allowed_paths: []
    });
  }
  const detached = immutableJson(value);
  const frozenContract = immutableJson(contract);
  const outcome = validator(detached, frozenContract, immutableJson(context));
  if (outcome && typeof outcome.then === 'function') {
    throw new DomainError('INVALID_ITEM_CONTRACT', 'item validators must be synchronous and pure', {
      path: '/',
      retryable_by: 'orchestrator',
      allowed_paths: []
    });
  }
  if (outcome === false || (isPlainObject(outcome) && outcome.ok === false)) {
    throw new DomainError(
      outcome?.code ?? 'SCHEMA_VIOLATION',
      outcome?.message ?? `${kind} item failed validation`,
      {
        path: outcome?.path ?? '/',
        allowed_paths: outcome?.allowed_paths ?? [outcome?.path ?? '/'],
        retryable_by: outcome?.retryable_by ?? 'continuity'
      }
    );
  }
  const normalized = isPlainObject(outcome) && own(outcome, 'value')
    ? outcome.value
    : (outcome === undefined || outcome === true ? detached : outcome);
  assertJsonSafe(normalized, { maxDepth: 64, maxNodes: 100_000 });
  return immutableJson(normalized);
}

function normalizeReducerResult(result, effectId) {
  if (!isPlainObject(result)) {
    throw new DomainError('INVALID_EFFECT_CONTRACT', 'reducer must return an object', {
      effect_id: effectId,
      retryable_by: 'referee'
    });
  }
  for (const key of Object.keys(result)) {
    if (!REDUCER_RESULT_KEYS.has(key)) {
      throw new DomainError('INVALID_EFFECT_CONTRACT', 'reducer returned an unknown property', {
        effect_id: effectId,
        property: key,
        retryable_by: 'referee'
      });
    }
  }
  const nextCandidate = result.nextCandidate ?? result.next_candidate;
  if (nextCandidate === undefined) {
    throw new DomainError('INVALID_EFFECT_CONTRACT', 'reducer omitted nextCandidate', {
      effect_id: effectId,
      retryable_by: 'referee'
    });
  }
  const normalizedOperations = result.normalizedOperations
    ?? result.normalized_operations
    ?? [];
  const invariantResults = result.invariantResults
    ?? result.invariant_results
    ?? [];
  if (!Array.isArray(normalizedOperations) || !Array.isArray(invariantResults)) {
    throw new DomainError('INVALID_EFFECT_CONTRACT', 'reducer audit fields must be arrays', {
      effect_id: effectId,
      retryable_by: 'referee'
    });
  }
  assertJsonSafe(nextCandidate, { maxDepth: 96, maxNodes: 500_000 });
  assertJsonSafe(normalizedOperations, { maxDepth: 64, maxNodes: 100_000 });
  assertJsonSafe(invariantResults, { maxDepth: 64, maxNodes: 100_000 });
  return {
    next_candidate: cloneJson(nextCandidate),
    normalized_operations: cloneJson(normalizedOperations),
    invariant_results: cloneJson(invariantResults)
  };
}

function replayCandidate(draft, consumedIds, runtime) {
  let candidate = cloneJson(draft.base_candidate);
  const traces = new Map();
  for (const effect of sortedEffects(draft.frozen_effects)) {
    if (!consumedIds.has(effect.effect_id)) continue;
    const missingDependency = effect.depends_on_effect_ids.find(id => !consumedIds.has(id));
    if (missingDependency) {
      throw new DomainError('EFFECT_DEPENDENCY_UNMET', 'effect dependency is not consumed', {
        effect_id: effect.effect_id,
        dependency: missingDependency,
        retryable_by: 'continuity'
      });
    }
    const reducer = reducerFor(runtime, effect.required_reducer);
    if (typeof reducer !== 'function') {
      throw new DomainError('INVALID_EFFECT_CONTRACT', 'required reducer is not installed', {
        effect_id: effect.effect_id,
        required_reducer: effect.required_reducer,
        retryable_by: 'referee'
      });
    }
    const effectValidator = validatorFor(runtime, 'effect');
    if (effectValidator) {
      invokeValidator(effectValidator, effect, effect, {
        draft_id: draft.draft_id,
        turn_id: draft.turn_id
      }, 'effect');
    }
    const beforeHash = hashJson(candidate);
    const result = reducer(
      immutableJson(candidate),
      immutableJson(effect),
      immutableJson(runtime?.rule_snapshot ?? {})
    );
    if (result && typeof result.then === 'function') {
      throw new DomainError('INVALID_EFFECT_CONTRACT', 'reducers must be synchronous and pure', {
        effect_id: effect.effect_id,
        retryable_by: 'referee'
      });
    }
    const normalized = normalizeReducerResult(result, effect.effect_id);
    candidate = normalized.next_candidate;
    traces.set(effect.effect_id, {
      before_hash: beforeHash,
      after_hash: hashJson(candidate),
      normalized_operations: normalized.normalized_operations,
      invariant_results: normalized.invariant_results
    });
  }
  return { candidate, traces };
}

function itemId(value, fallback) {
  return isPlainObject(value) && typeof value.obligation_id === 'string'
    ? value.obligation_id
    : fallback;
}

function appendItemError(target, config) {
  target.push({
    kind: config.kind,
    id: config.id,
    code: config.code,
    message: config.message,
    path: config.path,
    consumed: false,
    retryable_by: config.retryable_by ?? 'continuity',
    allowed_paths: config.allowed_paths ?? []
  });
}

function recordItemCheckpoint(trace, working, config) {
  if (!trace) return;
  trace.push(immutableJson({
    kind: config.kind,
    id: config.id,
    path: config.path,
    receipt_id: config.receipt_id,
    before_draft_revision: config.before_draft_revision,
    after_draft_revision: working.draft_revision,
    draft: working
  }));
}

function relativeToAbsolute(basePath, relativePath) {
  if (!relativePath || relativePath === '/') return basePath;
  return `${basePath}${relativePath.startsWith('/') ? relativePath : `/${relativePath}`}`;
}

function allowedEffectSet(draft) {
  return new Set(draft.repair_plan?.allowed_effect_ids ?? []);
}

function allowedObligationSet(draft) {
  return new Set(draft.repair_plan?.allowed_obligation_ids ?? []);
}

function processEffects(working, effectItems, operation, runtime, outcome, checkpoints = null) {
  const indexed = effectItems.map((value, index) => ({ value, index }));
  indexed.sort((left, right) => {
    const leftEffect = typeof left.value === 'string' ? findEffect(working, left.value) : null;
    const rightEffect = typeof right.value === 'string' ? findEffect(working, right.value) : null;
    const leftSeq = leftEffect?.effect_seq ?? Number.MAX_SAFE_INTEGER;
    const rightSeq = rightEffect?.effect_seq ?? Number.MAX_SAFE_INTEGER;
    return leftSeq - rightSeq || left.index - right.index;
  });

  for (const { value, index } of indexed) {
    const basePath = `/effect_ids/${index}`;
    const id = typeof value === 'string' ? value : `effect_ids[${index}]`;
    if (typeof value !== 'string' || !EFFECT_ID.test(value)) {
      appendItemError(outcome.errors, {
        kind: 'effect', id, code: 'SCHEMA_VIOLATION',
        message: 'effect ID has an invalid shape', path: basePath,
        allowed_paths: ['/']
      });
      continue;
    }
    const effect = findEffect(working, value);
    const ledger = findEffectLedger(working, value);
    if (!effect || !ledger) {
      appendItemError(outcome.errors, {
        kind: 'effect', id: value, code: 'UNKNOWN_EFFECT',
        message: 'effect ID is not present in the frozen resolution', path: basePath,
        allowed_paths: ['/']
      });
      continue;
    }
    if (ledger.status === 'CONSUMED') {
      if (ledger.effect_hash !== effect.effect_hash) {
        appendItemError(outcome.errors, {
          kind: 'effect', id: value, code: 'IDEMPOTENCY_CONFLICT',
          message: 'consumed effect ID is now bound to another hash', path: basePath,
          retryable_by: 'orchestrator', allowed_paths: []
        });
      } else {
        outcome.idempotent.push({
          kind: 'effect', id: value, receipt_id: ledger.receipt.receipt_id
        });
      }
      continue;
    }
    if (operation === CONTINUITY_OPERATIONS.REPAIR
      && !allowedEffectSet(working).has(value)) {
      appendItemError(outcome.errors, {
        kind: 'effect', id: value, code: 'REPAIR_ITEM_NOT_ALLOWED',
        message: 'pending effect is not allowed by the current RepairPlan', path: basePath,
        allowed_paths: []
      });
      continue;
    }
    const missingDependency = effect.depends_on_effect_ids.find(dependency => (
      findEffectLedger(working, dependency)?.status !== 'CONSUMED'
    ));
    if (missingDependency) {
      appendItemError(outcome.errors, {
        kind: 'effect', id: value, code: 'EFFECT_DEPENDENCY_UNMET',
        message: 'a required earlier effect has not been consumed', path: basePath,
        allowed_paths: [],
        retryable_by: 'continuity'
      });
      continue;
    }

    const proposed = new Set(
      working.effect_ledger
        .filter(row => row.status === 'CONSUMED')
        .map(row => row.effect_id)
    );
    proposed.add(value);
    try {
      const beforeDraftRevision = working.draft_revision;
      const replay = replayCandidate(working, proposed, runtime);
      const effectTrace = replay.traces.get(value);
      const receipt = {
        receipt_id: stableReceiptId('effect', {
          draft_id: working.draft_id,
          effect_id: value,
          effect_hash: effect.effect_hash
        }),
        effect_id: value,
        effect_hash: effect.effect_hash,
        effect_seq: effect.effect_seq,
        required_reducer: effect.required_reducer,
        reducer_version: effect.reducer_version,
        before_hash: effectTrace.before_hash,
        after_hash: effectTrace.after_hash,
        normalized_operations: effectTrace.normalized_operations,
        invariant_results: effectTrace.invariant_results
      };
      ledger.status = 'CONSUMED';
      ledger.receipt = receipt;
      working.candidate_state = replay.candidate;
      working.draft_revision += 1;
      refreshSemanticHashes(working);
      outcome.accepted.push({ kind: 'effect', id: value, receipt_id: receipt.receipt_id });
      recordItemCheckpoint(checkpoints, working, {
        kind: 'effect',
        id: value,
        path: basePath,
        receipt_id: receipt.receipt_id,
        before_draft_revision: beforeDraftRevision
      });
    } catch (error) {
      const normalized = normalizeThrownItemError(
        error,
        'INVALID_EFFECT_CONTRACT',
        '/',
        'referee'
      );
      appendItemError(outcome.errors, {
        kind: 'effect', id: value, code: normalized.code,
        message: normalized.message,
        path: relativeToAbsolute(basePath, normalized.relative_path),
        allowed_paths: normalized.allowed_paths,
        retryable_by: normalized.retryable_by
      });
    }
  }
}

function artifactHandlerFor(runtime, kind) {
  const handlers = runtime?.handlers ?? {};
  return handlers[kind]
    ?? (kind === 'domain_check' ? handlers.domain : undefined)
    ?? (kind === 'shinobi_daily' ? handlers.daily : undefined);
}

function processObligationPartition(
  working,
  items,
  kind,
  collection,
  operation,
  runtime,
  outcome,
  trace = null
) {
  for (let index = 0; index < items.length; index += 1) {
    const rawItem = items[index];
    const basePath = `/${collection}/${index}`;
    const id = itemId(rawItem, `${collection}[${index}]`);
    if (!isPlainObject(rawItem) || typeof rawItem.obligation_id !== 'string'
      || !OBLIGATION_ID.test(rawItem.obligation_id)) {
      appendItemError(outcome.errors, {
        kind, id, code: 'SCHEMA_VIOLATION',
        message: 'item must be an object with a valid obligation_id', path: basePath,
        allowed_paths: ['/']
      });
      continue;
    }
    const obligation = findObligation(working, rawItem.obligation_id);
    const ledger = findObligationLedger(working, rawItem.obligation_id);
    if (!obligation || !ledger) {
      appendItemError(outcome.errors, {
        kind, id, code: 'UNKNOWN_OBLIGATION',
        message: 'obligation ID is not in the frozen obligation set', path: basePath,
        allowed_paths: ['/']
      });
      continue;
    }
    if (obligation.kind !== kind || ledger.kind !== kind) {
      appendItemError(outcome.errors, {
        kind, id, code: 'OBLIGATION_KIND_MISMATCH',
        message: 'obligation belongs to another Bundle partition', path: basePath,
        allowed_paths: ['/']
      });
      continue;
    }

    let normalizedArtifact;
    try {
      normalizedArtifact = invokeValidator(
        validatorFor(runtime, kind),
        rawItem,
        obligation,
        {
          draft_id: working.draft_id,
          turn_id: working.turn_id,
          candidate_state: working.candidate_state,
          effect_ledger: working.effect_ledger
        },
        kind
      );
      if (!isPlainObject(normalizedArtifact)
        || normalizedArtifact.obligation_id !== obligation.obligation_id) {
        throw new DomainError('INVALID_ITEM_CONTRACT', 'validator changed the bound obligation ID', {
          path: '/obligation_id',
          retryable_by: 'orchestrator',
          allowed_paths: []
        });
      }
      const handler = artifactHandlerFor(runtime, kind);
      if (handler) {
        const handled = handler(
          normalizedArtifact,
          immutableJson(obligation),
          immutableJson({ candidate_state: working.candidate_state })
        );
        if (handled && typeof handled.then === 'function') {
          throw new DomainError('INVALID_ITEM_CONTRACT', 'artifact handlers must be synchronous and pure', {
            path: '/', retryable_by: 'orchestrator', allowed_paths: []
          });
        }
        if (handled !== undefined) normalizedArtifact = immutableJson(handled);
      }
      assertJsonSafe(normalizedArtifact, { maxDepth: 64, maxNodes: 100_000 });
      if (!isPlainObject(normalizedArtifact)
        || normalizedArtifact.obligation_id !== obligation.obligation_id) {
        throw new DomainError('INVALID_ITEM_CONTRACT', 'handler changed the bound obligation ID', {
          path: '/obligation_id',
          retryable_by: 'orchestrator',
          allowed_paths: []
        });
      }
    } catch (error) {
      const normalized = normalizeThrownItemError(error, 'SCHEMA_VIOLATION', '/');
      appendItemError(outcome.errors, {
        kind, id, code: normalized.code, message: normalized.message,
        path: relativeToAbsolute(basePath, normalized.relative_path),
        allowed_paths: normalized.allowed_paths,
        retryable_by: normalized.retryable_by
      });
      continue;
    }

    const artifactHash = hashJson(normalizedArtifact);
    if (ledger.status === 'CONSUMED') {
      if (ledger.current_artifact_hash === artifactHash) {
        outcome.idempotent.push({ kind, id, receipt_id: ledger.receipt.receipt_id });
      } else {
        appendItemError(outcome.errors, {
          kind, id, code: 'IDEMPOTENCY_CONFLICT',
          message: 'obligation was already consumed with different content', path: basePath,
          allowed_paths: [], retryable_by: 'continuity'
        });
      }
      continue;
    }
    if (operation === CONTINUITY_OPERATIONS.REPAIR
      && !allowedObligationSet(working).has(id)) {
      appendItemError(outcome.errors, {
        kind, id, code: 'REPAIR_ITEM_NOT_ALLOWED',
        message: 'pending obligation is not allowed by the current RepairPlan', path: basePath,
        allowed_paths: []
      });
      continue;
    }

    const beforeDraftRevision = working.draft_revision;
    const nextRevision = ledger.current_artifact_revision + 1;
    for (const version of ledger.versions) {
      if (version.status === 'CURRENT') version.status = 'SUPERSEDED';
    }
    const receipt = {
      receipt_id: stableReceiptId(kind, {
        draft_id: working.draft_id,
        obligation_id: id,
        artifact_hash: artifactHash,
        artifact_revision: nextRevision,
        correction_generation: ledger.correction_generation
      }),
      obligation_id: id,
      kind,
      artifact_hash: artifactHash,
      artifact_revision: nextRevision,
      correction_generation: ledger.correction_generation
    };
    ledger.versions.push({
      artifact_revision: nextRevision,
      artifact_hash: artifactHash,
      artifact: normalizedArtifact,
      status: 'CURRENT',
      correction_generation: ledger.correction_generation,
      receipt
    });
    ledger.status = 'CONSUMED';
    ledger.current_artifact_revision = nextRevision;
    ledger.current_artifact_hash = artifactHash;
    ledger.current_artifact = normalizedArtifact;
    ledger.receipt = receipt;
    working.draft_revision += 1;
    refreshSemanticHashes(working);
    outcome.accepted.push({ kind, id, receipt_id: receipt.receipt_id });
    recordItemCheckpoint(trace, working, {
      kind,
      id,
      path: basePath,
      receipt_id: receipt.receipt_id,
      before_draft_revision: beforeDraftRevision
    });
  }
}

function normalizeReviewReport(report) {
  if (report === undefined || report === null) {
    return { artifact_errors: [], domain_contradictions: [], invalid_operations: [] };
  }
  assertJsonSafe(report, { maxDepth: 32, maxNodes: 10_000 });
  if (!isPlainObject(report)) {
    throw new DomainError('INVALID_REVIEW_CONTRACT', 'review must return an object');
  }
  for (const key of ['artifact_errors', 'domain_contradictions', 'invalid_operations']) {
    if (report[key] !== undefined && !Array.isArray(report[key])) {
      throw new DomainError('INVALID_REVIEW_CONTRACT', `${key} must be an array`);
    }
  }
  return {
    artifact_errors: cloneJson(report.artifact_errors ?? []),
    domain_contradictions: cloneJson(report.domain_contradictions ?? []),
    invalid_operations: cloneJson(report.invalid_operations ?? [])
  };
}

function reopenReviewedObligations(working, report) {
  const ids = new Set();
  for (const error of report.artifact_errors) {
    if (isPlainObject(error) && typeof error.obligation_id === 'string') {
      ids.add(error.obligation_id);
    }
  }
  for (const contradiction of report.domain_contradictions) {
    if (isPlainObject(contradiction) && typeof contradiction.obligation_id === 'string') {
      ids.add(contradiction.obligation_id);
    }
  }
  for (const id of ids) {
    const ledger = findObligationLedger(working, id);
    if (ledger?.status === 'CONSUMED') {
      ledger.status = 'REOPENED';
      ledger.correction_generation += 1;
      working.draft_revision += 1;
    }
  }
  if (ids.size > 0) refreshSemanticHashes(working);
}

function missingCoverage(working) {
  const missingEffectIds = sortedEffects(working.frozen_effects)
    .filter(effect => working.required_effect_ids.includes(effect.effect_id))
    .filter(effect => findEffectLedger(working, effect.effect_id)?.status !== 'CONSUMED')
    .map(effect => effect.effect_id);
  const missingObligations = working.obligations
    .filter(obligation => working.required_obligation_ids.includes(obligation.obligation_id))
    .filter(obligation => findObligationLedger(working, obligation.obligation_id)?.status !== 'CONSUMED');
  return { missingEffectIds, missingObligations };
}

function buildReview(working, outcome, runtime) {
  let external = { artifact_errors: [], domain_contradictions: [], invalid_operations: [] };
  if (typeof runtime?.review === 'function') {
    const result = runtime.review(immutableJson({
      draft_id: working.draft_id,
      turn_id: working.turn_id,
      draft_revision: working.draft_revision,
      candidate_state: working.candidate_state,
      effect_ledger: working.effect_ledger,
      obligation_ledger: working.obligation_ledger,
      semantic_draft_hash: working.semantic_draft_hash
    }));
    if (result && typeof result.then === 'function') {
      throw new DomainError('INVALID_REVIEW_CONTRACT', 'review must be synchronous and pure');
    }
    external = normalizeReviewReport(result);
  }
  reopenReviewedObligations(working, external);
  const { missingEffectIds, missingObligations } = missingCoverage(working);

  const currentEffectErrors = outcome.errors
    .filter(error => error.kind === 'effect'
      && findEffectLedger(working, error.id)?.status !== 'CONSUMED')
    .map(error => ({ effect_id: error.id, code: error.code, consumed: false }));
  const currentArtifactErrors = outcome.errors
    .filter(error => ['domain_check', 'memory', 'shinobi_daily'].includes(error.kind)
      && findObligationLedger(working, error.id)?.status !== 'CONSUMED')
    .map(error => ({
      obligation_id: error.id,
      code: error.code,
      consumed: false,
      allowed_paths: error.allowed_paths
    }));

  const review = {
    reviewed_semantic_draft_hash: working.semantic_draft_hash,
    missing_effect_ids: missingEffectIds,
    missing_obligation_ids: missingObligations.map(item => item.obligation_id),
    missing_by_kind: {
      domain_check: missingObligations
        .filter(item => item.kind === 'domain_check')
        .map(item => item.obligation_id),
      memory: missingObligations
        .filter(item => item.kind === 'memory')
        .map(item => item.obligation_id),
      shinobi_daily: missingObligations
        .filter(item => item.kind === 'shinobi_daily')
        .map(item => item.obligation_id)
    },
    invalid_operations: [...currentEffectErrors, ...external.invalid_operations],
    artifact_errors: [...currentArtifactErrors, ...external.artifact_errors],
    domain_contradictions: external.domain_contradictions
  };
  return immutableJson(review);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function repairPlanFromReview(working, review, outcome) {
  const allowedEffects = uniqueSorted([
    ...review.missing_effect_ids,
    ...review.invalid_operations
      .map(item => item?.effect_id)
      .filter(id => typeof id === 'string' && findEffect(working, id))
  ]).sort((left, right) => (
    findEffect(working, left).effect_seq - findEffect(working, right).effect_seq
  ));
  const allowedObligations = uniqueSorted([
    ...review.missing_obligation_ids,
    ...review.artifact_errors.map(item => item?.obligation_id),
    ...review.domain_contradictions.map(item => item?.obligation_id)
  ].filter(id => typeof id === 'string' && findObligation(working, id)));

  const paths = new Map();
  function addPath(kind, id, pointers) {
    if (!findObligation(working, id)) return;
    const key = `${kind}\u0000${id}`;
    const existing = paths.get(key) ?? { kind, id, json_pointers: [] };
    existing.json_pointers.push(...(pointers.length ? pointers : ['/']));
    existing.json_pointers = uniqueSorted(existing.json_pointers);
    paths.set(key, existing);
  }
  for (const error of outcome.errors) {
    if (allowedObligations.includes(error.id)) {
      addPath(error.kind, error.id, error.allowed_paths);
    }
  }
  for (const error of review.artifact_errors) {
    if (allowedObligations.includes(error.obligation_id)) {
      const obligation = findObligation(working, error.obligation_id);
      addPath(
        obligation.kind,
        error.obligation_id,
        error.allowed_paths ?? error.json_pointers ?? ['/']
      );
    }
  }
  for (const id of allowedObligations) {
    const obligation = findObligation(working, id);
    const key = `${obligation.kind}\u0000${id}`;
    if (!paths.has(key)) addPath(obligation.kind, id, ['/']);
  }
  return immutableJson({
    schema: REPAIR_PLAN_SCHEMA,
    draft_revision: working.draft_revision,
    reviewed_semantic_draft_hash: working.semantic_draft_hash,
    allowed_effect_ids: allowedEffects,
    allowed_obligation_ids: allowedObligations,
    allowed_paths: [...paths.values()].sort((left, right) => (
      compareText(left.kind, right.kind) || compareText(left.id, right.id)
    ))
  });
}

function baseResult(working, status) {
  return {
    schema: CONTINUITY_BUNDLE_RESULT_SCHEMA,
    status,
    draft_revision: working.draft_revision,
    retryable_by: 'none',
    pause_reason: null,
    turn_state: working.turn_state,
    resume_stage: null,
    accepted: [],
    idempotent: [],
    errors: [],
    review: null,
    next_operation: null,
    allowed_effect_ids: [],
    allowed_obligation_ids: [],
    allowed_paths: [],
    ready_receipt: null
  };
}

function finalizeResultAndDraft(working, outcome, review, runtime) {
  const hasHandoff = outcome.errors.some(error => error.retryable_by !== 'continuity');
  const incomplete = review.missing_effect_ids.length > 0
    || review.missing_obligation_ids.length > 0
    || review.invalid_operations.length > 0
    || review.artifact_errors.length > 0
    || review.domain_contradictions.length > 0;

  if (hasHandoff) {
    working.status = 'OPEN';
    working.turn_state = 'RESOLUTION_HANDOFF';
    working.expected_operation = null;
    working.repair_plan = null;
    working.review_receipt = null;
    return {
      ...baseResult(working, 'HANDOFF_REQUIRED'),
      retryable_by: outcome.errors.find(error => error.retryable_by !== 'continuity').retryable_by,
      accepted: outcome.accepted,
      idempotent: outcome.idempotent,
      errors: outcome.errors,
      review
    };
  }

  if (incomplete) {
    const repairPlan = repairPlanFromReview(working, review, outcome);
    working.status = 'REVIEW_REQUIRED';
    working.turn_state = 'REPAIRING_DRAFT';
    working.expected_operation = CONTINUITY_OPERATIONS.REPAIR;
    working.repair_plan = repairPlan;
    working.review_receipt = null;
    return {
      ...baseResult(working, 'REPAIR_REQUIRED'),
      retryable_by: 'continuity',
      accepted: outcome.accepted,
      idempotent: outcome.idempotent,
      errors: outcome.errors,
      review,
      next_operation: CONTINUITY_OPERATIONS.REPAIR,
      allowed_effect_ids: repairPlan.allowed_effect_ids,
      allowed_obligation_ids: repairPlan.allowed_obligation_ids,
      allowed_paths: repairPlan.allowed_paths
    };
  }

  const reviewReceipt = {
    receipt_id: stableReceiptId('review', {
      draft_id: working.draft_id,
      draft_revision: working.draft_revision,
      semantic_draft_hash: working.semantic_draft_hash,
      commit_envelope_hash: working.commit_envelope_hash,
      lease_fence: working.lease_fence
    }),
    draft_revision: working.draft_revision,
    semantic_draft_hash: working.semantic_draft_hash,
    commit_envelope_hash: working.commit_envelope_hash,
    lease_fence: working.lease_fence
  };
  working.review_receipt = reviewReceipt;
  let finalizeMetadata = null;
  if (typeof runtime?.finalize === 'function') {
    const finalized = runtime.finalize(immutableJson({
      draft_id: working.draft_id,
      turn_id: working.turn_id,
      draft_revision: working.draft_revision,
      semantic_draft_hash: working.semantic_draft_hash,
      commit_envelope_hash: working.commit_envelope_hash,
      lease_fence: working.lease_fence,
      review_receipt: reviewReceipt
    }));
    if (finalized && typeof finalized.then === 'function') {
      throw new DomainError('INVALID_FINALIZE_CONTRACT', 'finalize must be synchronous and pure');
    }
    if (finalized !== undefined) {
      assertJsonSafe(finalized, { maxDepth: 16, maxNodes: 1_000 });
      finalizeMetadata = cloneJson(finalized);
    }
  }
  const readyReceipt = {
    receipt_id: stableReceiptId('ready', {
      draft_id: working.draft_id,
      draft_revision: working.draft_revision,
      semantic_draft_hash: working.semantic_draft_hash,
      commit_envelope_hash: working.commit_envelope_hash,
      review_receipt_id: reviewReceipt.receipt_id
    }),
    draft_id: working.draft_id,
    draft_revision: working.draft_revision,
    semantic_draft_hash: working.semantic_draft_hash,
    commit_envelope_hash: working.commit_envelope_hash,
    lease_fence: working.lease_fence,
    review_receipt_id: reviewReceipt.receipt_id,
    finalize_metadata: finalizeMetadata
  };
  working.ready_receipt = readyReceipt;
  working.status = 'READY';
  working.turn_state = 'COMMITTING';
  working.expected_operation = null;
  working.repair_plan = null;
  return {
    ...baseResult(working, 'READY'),
    accepted: outcome.accepted,
    idempotent: outcome.idempotent,
    errors: outcome.errors,
    review,
    ready_receipt: readyReceipt
  };
}

function recordCommand(working, command, result) {
  const immutableResult = immutableJson(result);
  const binding = command.binding;
  working.commands.push({
    run_id: binding.run_id,
    continuity_session_id: binding.continuity_session_id,
    invocation_id: binding.invocation_id,
    command_attempt_id: binding.command_attempt_id,
    operation: command.operation,
    canonical_bundle_hash: command.canonical_bundle_hash,
    canonical_request_hash: command.canonical_request_hash,
    result_hash: hashJson(immutableResult),
    result: immutableResult
  });
}

function executeTurnBundleCommandInternal(draft, command, runtime, itemCheckpoints) {
  assertDraft(draft);
  assertBoundCommand(command);
  assertCommandBinding(draft, command);

  // Attempt identity is looked up before comparing request content and before
  // stage/repair gates. This preserves exact lost-response replay semantics.
  const prior = draft.commands.find(record => attemptMatches(record, command.binding));
  if (prior) {
    if (prior.canonical_request_hash !== command.canonical_request_hash) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'command attempt was reused with different content', {
        invocation_id: command.binding.invocation_id,
        command_attempt_id: command.binding.command_attempt_id,
        expected_hash: prior.canonical_request_hash,
        actual_hash: command.canonical_request_hash
      });
    }
    return freezeDeep({
      draft,
      result: prior.result,
      replayed: true
    });
  }

  if (draft.expected_operation !== command.operation) {
    throw new DomainError('OPERATION_NOT_ALLOWED', 'operation is not allowed in the current draft phase', {
      expected_operation: draft.expected_operation,
      actual_operation: command.operation,
      draft_status: draft.status,
      turn_state: draft.turn_state
    });
  }

  const working = cloneJson(draft);
  working.review_receipt = null;
  working.ready_receipt = null;
  const outcome = { accepted: [], idempotent: [], errors: [] };

  processEffects(
    working,
    command.bundle.effect_ids,
    command.operation,
    runtime,
    outcome,
    itemCheckpoints
  );
  processObligationPartition(
    working,
    command.bundle.domain_checks,
    'domain_check',
    'domain_checks',
    command.operation,
    runtime,
    outcome,
    itemCheckpoints
  );
  processObligationPartition(
    working,
    command.bundle.memories,
    'memory',
    'memories',
    command.operation,
    runtime,
    outcome,
    itemCheckpoints
  );
  processObligationPartition(
    working,
    command.bundle.shinobi_daily,
    'shinobi_daily',
    'shinobi_daily',
    command.operation,
    runtime,
    outcome,
    itemCheckpoints
  );

  refreshSemanticHashes(working);
  const review = buildReview(working, outcome, runtime);
  const result = finalizeResultAndDraft(working, outcome, review, runtime);
  recordCommand(working, command, result);
  const nextDraft = immutableJson(working);
  const storedResult = nextDraft.commands[nextDraft.commands.length - 1].result;
  return freezeDeep({ draft: nextDraft, result: storedResult, replayed: false });
}

/**
 * Applies a normalized command to an immutable draft. Repository adapters may
 * persist each returned ledger delta under their own revision/fence CAS.
 */
export function executeTurnBundleCommand(draft, command, runtime = {}) {
  return executeTurnBundleCommandInternal(draft, command, runtime, null);
}

/**
 * Persistence-only variant that exposes immutable checkpoints immediately
 * after each successfully consumed item, before automatic review/finalize.
 */
export function executeTurnBundleCommandWithCheckpoints(draft, command, runtime = {}) {
  const itemCheckpoints = [];
  const execution = executeTurnBundleCommandInternal(
    draft,
    command,
    runtime,
    itemCheckpoints
  );
  return freezeDeep({
    ...execution,
    item_checkpoints: immutableJson(itemCheckpoints)
  });
}

/** Rebinds an unfinished draft after a resolution-run lease takeover. */
export function rebindTurnDraftLease(draft, leaseFence) {
  assertDraft(draft);
  if (!Number.isSafeInteger(leaseFence) || leaseFence < 1) {
    throw new DomainError('INVALID_TURN_DRAFT', 'lease fence must be a positive safe integer');
  }
  if (draft.status === 'READY' || draft.status === 'DISCARDED') {
    throw new DomainError('OPERATION_NOT_ALLOWED', 'a terminal draft lease cannot be rebound', {
      draft_status: draft.status
    });
  }
  const working = cloneJson(draft);
  working.lease_fence = leaseFence;
  working.draft_revision += 1;
  working.review_receipt = null;
  working.ready_receipt = null;
  refreshSemanticHashes(working);
  return immutableJson(working);
}

/** Produces the same result schema for an unparseable response, with zero writes. */
export function createProtocolRetryResult(draft, error) {
  assertDraft(draft);
  const nextOperation = draft.expected_operation
    ?? (draft.status === 'READY' ? null : CONTINUITY_OPERATIONS.REPAIR);
  const details = error instanceof DomainError ? error.details : {};
  return immutableJson({
    ...baseResult(draft, 'PROTOCOL_RETRY'),
    retryable_by: 'continuity',
    errors: [{
      kind: 'protocol',
      id: 'response',
      code: error instanceof DomainError ? error.code : 'PROTOCOL_VIOLATION',
      message: error instanceof Error ? error.message : String(error),
      path: details?.path ?? '/',
      consumed: false,
      retryable_by: 'continuity',
      allowed_paths: [details?.path ?? '/']
    }],
    next_operation: nextOperation
  });
}

/** Decode, bind, and execute while keeping protocol violations at zero writes. */
export function executeContinuityTransport(draft, transportInput, boundContext, runtime = {}) {
  try {
    const decoded = decodeContinuityCommand(transportInput);
    const bound = bindContinuityCommand(decoded, boundContext);
    return executeTurnBundleCommand(draft, bound, runtime);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PROTOCOL_VIOLATION') {
      return freezeDeep({
        draft,
        result: createProtocolRetryResult(draft, error),
        replayed: false
      });
    }
    throw error;
  }
}
