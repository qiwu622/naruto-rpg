import { DomainError } from './errors.js';
import {
  assertJsonSafe,
  canonicalizeJson,
  canonicalStringify,
  hmacSha256,
  sha256Hex
} from './canonical-json.js';
import {
  ACTION_REQUEST_SCHEMA,
  buildRefereeInput,
  buildWriterActionProjection,
  commitActionTurn,
  createActionTurn,
  lockActionSubmission,
  projectActionTurn
} from './action-turn.js';
import { projectAudienceViewsWithPublicBaseline } from './world-public-baseline.js';
import { compileEffectDag } from './effect-dag.js';
import { CONTINUITY_JSON_PROTOCOL, CONTINUITY_OPERATIONS } from './continuity-bundle.js';
import {
  createTurnDraft,
  executeContinuityTransport,
  turnDraftCandidateStateHash
} from './turn-draft.js';
import {
  assertReducerDomainState,
  reduceDomainEffect,
  resolveDomainReducer
} from './reducers/index.js';
import {
  freezeCanonicalResolution
} from '../contracts/resolution-contracts.js';
import {
  assertGroundedNarrativeDeliverySet,
  createNarrativeGroundingReviewReceipt,
  freezeNarrativeDelivery
} from '../contracts/narrative-contracts.js';
import {
  UPDATE_OBLIGATIONS_SCHEMA,
  UPDATE_OBLIGATION_DOMAINS,
  assertUpdateObligations
} from '../contracts/obligation-contracts.js';
import {
  assertContinuityBundleResult,
  createContinuityItemValidators
} from '../contracts/continuity-contracts.js';
import {
  COMMIT_PRECONDITION_SET_SCHEMA,
  assertCommitPreconditionSet
} from '../contracts/commit-contracts.js';

export const IN_MEMORY_TURN_COMMIT_SCHEMA =
  'naruto.multiplayer-in-memory-turn-commit/v1';

const DOMAIN_SCOPE_REFS = Object.freeze({
  world: Object.freeze(['world:canonical']),
  attributes: Object.freeze(['actor:A', 'actor:B']),
  skills: Object.freeze(['actor:A', 'actor:B']),
  equipment: Object.freeze(['actor:A', 'actor:B']),
  missions: Object.freeze(['mission:all']),
  relationships: Object.freeze(['relationship:all']),
  combat: Object.freeze(['combat:shared']),
  events: Object.freeze(['event:canonical'])
});

const EFFECT_UPDATE_DOMAIN = Object.freeze({
  actor_profile: 'attributes',
  actor_resource: 'attributes',
  actor_progression: 'attributes',
  skill: 'skills',
  item: 'equipment',
  world: 'world',
  calendar: 'world',
  mission: 'missions',
  relationship: 'relationships',
  combat: 'combat',
  event: 'events'
});

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

function hashJson(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) {
    throw new DomainError('INVALID_TURN_ORCHESTRATION', `${label} must be a plain object`);
  }
  return value;
}

function callFixedAgent(fixedAgents, name, input) {
  const callback = fixedAgents?.[name];
  if (typeof callback !== 'function') {
    throw new DomainError(
      'FIXED_AGENT_STAGE_MISSING',
      `fixed agent stage ${name} is required`,
      { stage: name }
    );
  }
  const output = callback(immutableJson(input));
  if (output && typeof output.then === 'function') {
    throw new DomainError(
      'ASYNC_FIXED_AGENT_NOT_SUPPORTED',
      `fixed agent stage ${name} must be synchronous`,
      { stage: name }
    );
  }
  assertJsonSafe(output, { maxDepth: 96, maxNodes: 500_000 });
  return immutableJson(output);
}

function assertEqual(actual, expected, path) {
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new DomainError(
      'COMMIT_PRECONDITION_FAILED',
      `commit precondition does not match at ${path}`,
      { path, expected, actual }
    );
  }
}

function projectionHash(projection) {
  return hashJson(projection);
}

function resolutionCommitment(serverSecret, canonicalResolution, resolutionHash) {
  return `hmac-sha256:${hmacSha256(serverSecret, {
    schema: 'naruto.multiplayer-resolution-commitment/v1',
    turn_id: canonicalResolution.turn_id,
    input_hash: canonicalResolution.input_hash,
    resolution_hash: resolutionHash
  })}`;
}

function visibleSubmissionIds(canonicalResolution, projection) {
  const visibleEvents = new Set(projection.events.map(event => event.event_id));
  return canonicalResolution.outcomes
    .filter(outcome => outcome.event_ids.some(eventId => visibleEvents.has(eventId)))
    .map(outcome => outcome.submission_id)
    .sort();
}

function projectionForAudience(projections, audience) {
  if (audience === 'shared') return projections.shared;
  if (audience === 'seat:A') return projections.seat_A;
  if (audience === 'seat:B') return projections.seat_B;
  throw new DomainError('INVALID_NARRATIVE_AUDIENCE', 'unsupported narrative audience', {
    audience
  });
}

function expectedNarrativeAudiences(mode) {
  return mode === 'shared' ? ['shared'] : ['seat:A', 'seat:B'];
}

function publicSourceRefs(worldPublicProjection) {
  const refs = [];
  for (const event of worldPublicProjection.events) {
    refs.push(`public:${event.event_id}`);
  }
  for (const fact of worldPublicProjection.facts) {
    refs.push(fact.fact_id.startsWith('public:') ? fact.fact_id : `public:${fact.fact_id}`);
  }
  return [...new Set(refs)].sort();
}

function stableSubjectIds(baseState) {
  const ids = new Set([
    baseState.actors.A.room_actor_id,
    baseState.actors.B.room_actor_id
  ]);
  for (const profile of baseState.shared_world.world_state.npc_profiles) {
    ids.add(profile.npc_id);
  }
  for (const collection of [
    baseState.shared_world.shared_missions,
    baseState.actors.A.missions,
    baseState.actors.B.missions
  ]) {
    for (const mission of collection.entries) ids.add(mission.mission_id);
  }
  for (const combat of baseState.shared_world.shared_combat.entries) ids.add(combat.combat_id);
  return [...ids].sort();
}

function createUpdateObligations({
  canonicalResolution,
  resolutionHash,
  narrativeMode,
  projections
}) {
  const effectIdsByDomain = new Map(
    UPDATE_OBLIGATION_DOMAINS.map(domain => [domain, []])
  );
  for (const effect of canonicalResolution.effects) {
    const updateDomain = EFFECT_UPDATE_DOMAIN[effect.domain];
    if (!updateDomain) {
      throw new DomainError(
        'UNMAPPED_UPDATE_DOMAIN',
        'compiled effect domain has no UpdateObligations mapping',
        { effect_id: effect.effect_id, effect_domain: effect.domain }
      );
    }
    effectIdsByDomain.get(updateDomain).push(effect.effect_id);
  }

  const sourceHashes = {
    canonical: hashJson({
      schema: 'naruto.multiplayer-canonical-memory-source/v1',
      turn_id: canonicalResolution.turn_id,
      events: canonicalResolution.events
    }),
    shared: projectionHash(projections.shared),
    seat_A: projectionHash(projections.seat_A),
    seat_B: projectionHash(projections.seat_B),
    world_public: projectionHash(projections.world_public)
  };

  const narratives = expectedNarrativeAudiences(narrativeMode).map(audience => ({
    obligation_id: `obligation_narrative_${audience.replace(':', '_')}`,
    audience,
    source_projection_hash: audience === 'shared'
      ? sourceHashes.shared
      : sourceHashes[audience === 'seat:A' ? 'seat_A' : 'seat_B']
  }));

  return assertUpdateObligations({
    schema: UPDATE_OBLIGATIONS_SCHEMA,
    turn_id: canonicalResolution.turn_id,
    resolution_hash: resolutionHash,
    narrative_mode: narrativeMode,
    effect_obligations: canonicalResolution.effects.map(effect => ({
      effect_id: effect.effect_id,
      effect_seq: effect.effect_seq,
      effect_hash: effect.effect_hash,
      depends_on_effect_ids: effect.depends_on_effect_ids
    })),
    domain_obligations: UPDATE_OBLIGATION_DOMAINS.map(domain => ({
      obligation_id: `obligation_domain_${domain}`,
      domain,
      scope_refs: DOMAIN_SCOPE_REFS[domain],
      satisfied_by_effect_ids: effectIdsByDomain.get(domain)
    })),
    artifact_obligations: [{
      obligation_id: 'obligation_memory_canonical',
      kind: 'memory',
      target_binding: 'server_bound',
      source_projection_hash: sourceHashes.canonical
    }, {
      obligation_id: 'obligation_memory_actor_A',
      kind: 'memory',
      target_binding: 'actor:A',
      source_projection_hash: sourceHashes.seat_A
    }, {
      obligation_id: 'obligation_memory_actor_B',
      kind: 'memory',
      target_binding: 'actor:B',
      source_projection_hash: sourceHashes.seat_B
    }, {
      obligation_id: 'obligation_daily_world_public',
      kind: 'shinobi_daily',
      target_binding: 'world_public',
      source_projection_hash: sourceHashes.world_public
    }],
    narrative_obligations: narratives
  });
}

function draftObligations(updateObligations) {
  const domainChecks = updateObligations.domain_obligations
    .filter(obligation => obligation.satisfied_by_effect_ids.length === 0)
    .map(obligation => ({ ...obligation, kind: 'domain_check' }));
  return [...domainChecks, ...updateObligations.artifact_obligations];
}

function createDraftRuntime({ baseState, canonicalResolution, projections, updateObligations, ruleSnapshot }) {
  const eventIds = canonicalResolution.events.map(event => event.event_id);
  const eventsA = projections.seat_A.events.map(event => event.event_id);
  const eventsB = projections.seat_B.events.map(event => event.event_id);
  const subjects = stableSubjectIds(baseState);
  const publicRefs = publicSourceRefs(projections.world_public);
  const bindings = {};
  for (const obligation of updateObligations.domain_obligations) {
    bindings[obligation.obligation_id] = { allowedEvidenceEventIds: eventIds };
  }
  bindings.obligation_memory_canonical = {
    audienceEventIds: eventIds,
    stableSubjectIds: subjects,
    modifiableEntryIds: []
  };
  bindings.obligation_memory_actor_A = {
    audienceEventIds: eventsA,
    stableSubjectIds: subjects,
    modifiableEntryIds: []
  };
  bindings.obligation_memory_actor_B = {
    audienceEventIds: eventsB,
    stableSubjectIds: subjects,
    modifiableEntryIds: []
  };
  bindings.obligation_daily_world_public = { worldPublicRefs: publicRefs };

  return Object.freeze({
    validators: createContinuityItemValidators({ byObligation: bindings }),
    resolveReducer(reducerKey) {
      if (!canonicalResolution.effects.some(effect => effect.required_reducer === reducerKey)) {
        return undefined;
      }
      return (candidate, effect, rules) => reduceDomainEffect(candidate, effect, rules);
    },
    rule_snapshot: ruleSnapshot,
    finalize(receipt) {
      return {
        finalized_by: 'server_orchestrator',
        reviewed_semantic_draft_hash: receipt.semantic_draft_hash
      };
    }
  });
}

function normalizeGroundingResults(rawResults, audiences) {
  if (Array.isArray(rawResults)) {
    if (rawResults.length !== audiences.length) {
      throw new DomainError(
        'INVALID_GROUNDING_REVIEW_SET',
        'grounding reviewer returned the wrong number of results'
      );
    }
    return rawResults;
  }
  assertObject(rawResults, 'grounding reviewer result');
  return audiences.map(audience => {
    const result = rawResults[audience];
    if (!result) {
      throw new DomainError(
        'INVALID_GROUNDING_REVIEW_SET',
        'grounding reviewer omitted an audience result',
        { audience }
      );
    }
    return result;
  });
}

function normalizeTransportOutput(output) {
  assertObject(output, 'Continuity transport output');
  if (output.transport_mode === 'json_protocol') {
    if (typeof output.response_text === 'string') return output;
    if (isPlainObject(output.bundle)) {
      return immutableJson({
        transport_mode: 'json_protocol',
        response_text: JSON.stringify({
          protocol: CONTINUITY_JSON_PROTOCOL,
          operation: output.operation ?? CONTINUITY_OPERATIONS.STAGE,
          bundle: output.bundle
        })
      });
    }
  }
  if (output.transport_mode === 'native_tools') {
    if (output.tool_name && Object.prototype.hasOwnProperty.call(output, 'raw_arguments')) {
      return output;
    }
    if (isPlainObject(output.bundle)) {
      return immutableJson({
        transport_mode: 'native_tools',
        tool_name: output.operation ?? CONTINUITY_OPERATIONS.STAGE,
        raw_arguments: output.bundle
      });
    }
  }
  throw new DomainError(
    'INVALID_CONTINUITY_TRANSPORT_OUTPUT',
    'Continuity fixed agent must return a complete native_tools or json_protocol response'
  );
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

/** Build the only complete section 13.9 final-commit parameter object. */
export function buildPrototypeCommitPreconditionSet({
  identity,
  current,
  turn,
  draft,
  canonicalResolution,
  resolutionHash,
  obligationSetHash,
  narrativeBundleHash
}) {
  assertObject(identity, 'commit identity');
  assertObject(current, 'current authoritative boundary');
  return assertCommitPreconditionSet({
    schema: COMMIT_PRECONDITION_SET_SCHEMA,
    identity: {
      room_id: identity.room_id,
      epoch_id: identity.epoch_id,
      turn_id: identity.turn_id,
      run_id: identity.run_id,
      draft_id: identity.draft_id,
      commit_id: identity.commit_id
    },
    lifecycle: {
      room_lifecycle: current.room_lifecycle,
      epoch_state: current.epoch_state,
      turn_status: current.turn_status,
      current_turn_id: current.current_turn_id,
      void_requested: current.void_requested
    },
    concurrency: {
      base_state_revision: current.state_revision,
      base_state_hash: current.state_hash,
      lease_fence: current.lease_fence,
      draft_revision: draft.draft_revision,
      draft_status: draft.status
    },
    frozen_inputs: {
      input_hash: canonicalResolution.input_hash,
      resolution_hash: resolutionHash,
      obligation_set_hash: obligationSetHash,
      execution_plan_hash: turn.execution_plan_hash
    },
    billing: {
      billing_provenance_hash: draft.billing_provenance_hash
    },
    result: {
      candidate_state_hash: draft.candidate_state_hash,
      artifact_bundle_hash: draft.artifact_bundle_hash,
      narrative_bundle_hash: narrativeBundleHash,
      semantic_draft_hash: draft.semantic_draft_hash,
      commit_envelope_hash: draft.commit_envelope_hash
    }
  });
}

function applyCommittedMemories(candidateState, draft) {
  const next = canonicalizeJson(candidateState);
  const committedMemories = [];
  const daily = [];
  for (const row of draft.obligation_ledger) {
    if (row.status !== 'CONSUMED' || !row.current_artifact) continue;
    const obligation = draft.obligations.find(item => item.obligation_id === row.obligation_id);
    if (row.kind === 'shinobi_daily') {
      daily.push(row.current_artifact);
      continue;
    }
    if (row.kind !== 'memory') continue;
    const partition = obligation.target_binding === 'server_bound'
      ? 'canonical'
      : (obligation.target_binding === 'shared'
          ? 'shared'
          : (obligation.target_binding === 'actor:A' || obligation.target_binding === 'actor:B'
              ? obligation.target_binding
              : 'npc_private'));
    const container = next.memories[partition];
    if (!isPlainObject(container) || !Array.isArray(container.entries)) {
      throw new DomainError(
        'INVALID_MEMORY_PARTITION',
        'authoritative memory partition must contain an entries array',
        { partition }
      );
    }
    const memoryRecord = {
      memory_id: `memory:${sha256Hex({
        obligation_id: obligation.obligation_id,
        artifact_hash: row.current_artifact_hash
      }).slice(0, 32)}`,
      source_turn_id: draft.turn_id,
      target_binding: obligation.target_binding,
      artifact_hash: row.current_artifact_hash,
      summary: row.current_artifact.summary,
      entries: row.current_artifact.entries,
      supersede_entry_ids: row.current_artifact.supersede_entry_ids,
      retract_entry_ids: row.current_artifact.retract_entry_ids
    };
    if (!container.entries.some(entry => entry.memory_id === memoryRecord.memory_id)) {
      container.entries.push(memoryRecord);
      container.entries.sort((left, right) => (
        compareText(String(left.memory_id), String(right.memory_id))
      ));
    }
    committedMemories.push(memoryRecord);
  }
  return { state: next, memories: committedMemories, daily };
}

/**
 * Pure in-memory stand-in for the final short database transaction. Every
 * precondition is checked before a detached committed aggregate is created.
 */
export function commitPrototypeTurnInMemory({
  current,
  turn,
  draft,
  canonicalResolution,
  updateObligations,
  groundedNarratives,
  preconditions
}) {
  const normalizedPreconditions = assertCommitPreconditionSet(preconditions);
  const normalizedObligations = assertUpdateObligations(updateObligations);
  assertReducerDomainState(current.state);
  if (draft.status !== 'READY' || !draft.ready_receipt) {
    throw new DomainError('DRAFT_NOT_READY', 'only a READY TurnDraft can be committed');
  }
  if (turn.status !== 'SEALED') {
    throw new DomainError('INVALID_TURN_STATE', 'only a sealed action turn can be committed');
  }

  const firstDelivery = groundedNarratives?.deliveries?.[0];
  if (!firstDelivery) {
    throw new DomainError(
      'NARRATIVE_NOT_GROUNDED',
      'final commit requires a grounded NarrativeDelivery set'
    );
  }
  const normalizedGroundedNarratives = assertGroundedNarrativeDeliverySet(
    groundedNarratives.deliveries,
    groundedNarratives.grounding_review_receipts,
    {
      narrative_mode: turn.execution_plan.narrative_mode,
      canonical_resolution: canonicalResolution,
      resolution_commitment: firstDelivery.resolution_commitment
    }
  );

  const resolutionHash = hashJson(canonicalResolution);
  const obligationSetHash = hashJson(normalizedObligations);
  const narrativeBundleHash = hashJson(normalizedGroundedNarratives);
  const expected = {
    identity: {
      room_id: turn.room_id,
      epoch_id: turn.epoch_id,
      turn_id: turn.turn_id,
      run_id: draft.run_id,
      draft_id: draft.draft_id
    },
    lifecycle: {
      room_lifecycle: current.room_lifecycle,
      epoch_state: current.epoch_state,
      turn_status: current.turn_status,
      current_turn_id: current.current_turn_id,
      void_requested: current.void_requested
    },
    concurrency: {
      base_state_revision: current.state_revision,
      base_state_hash: current.state_hash,
      lease_fence: current.lease_fence,
      draft_revision: draft.draft_revision,
      draft_status: draft.status
    },
    frozen_inputs: {
      input_hash: canonicalResolution.input_hash,
      resolution_hash: resolutionHash,
      obligation_set_hash: obligationSetHash,
      execution_plan_hash: turn.execution_plan_hash
    },
    billing: { billing_provenance_hash: draft.billing_provenance_hash },
    result: {
      candidate_state_hash: turnDraftCandidateStateHash(draft.candidate_state),
      artifact_bundle_hash: hashJson(artifactBundle(draft)),
      narrative_bundle_hash: narrativeBundleHash,
      semantic_draft_hash: draft.semantic_draft_hash,
      commit_envelope_hash: draft.commit_envelope_hash
    }
  };
  for (const section of Object.keys(expected)) {
    for (const [key, value] of Object.entries(expected[section])) {
      assertEqual(normalizedPreconditions[section][key], value, `/${section}/${key}`);
    }
  }
  assertEqual(normalizedPreconditions.identity.commit_id, preconditions.identity.commit_id,
    '/identity/commit_id');
  assertEqual(
    turnDraftCandidateStateHash(current.state),
    current.state_hash,
    '/current/state_hash'
  );
  assertEqual(current.state_revision, draft.base_state_revision, '/current/state_revision');
  assertEqual(current.state_hash, draft.base_state_hash, '/current/base_state_hash');
  assertEqual(current.lease_fence, draft.lease_fence, '/current/lease_fence');
  assertEqual(canonicalResolution.turn_id, turn.turn_id, '/canonical_resolution/turn_id');
  assertEqual(normalizedObligations.turn_id, turn.turn_id, '/update_obligations/turn_id');
  assertEqual(draft.resolution_hash, resolutionHash, '/draft/resolution_hash');
  assertEqual(draft.obligation_set_hash, obligationSetHash, '/draft/obligation_set_hash');
  assertEqual(draft.execution_plan_hash, turn.execution_plan_hash, '/draft/execution_plan_hash');
  assertEqual(draft.narrative_bundle_hash, narrativeBundleHash, '/draft/narrative_bundle_hash');
  assertEqual(draft.ready_receipt.semantic_draft_hash, draft.semantic_draft_hash,
    '/draft/ready_receipt/semantic_draft_hash');
  assertEqual(draft.ready_receipt.commit_envelope_hash, draft.commit_envelope_hash,
    '/draft/ready_receipt/commit_envelope_hash');
  assertEqual(draft.ready_receipt.draft_revision, draft.draft_revision,
    '/draft/ready_receipt/draft_revision');
  assertEqual(draft.ready_receipt.lease_fence, draft.lease_fence,
    '/draft/ready_receipt/lease_fence');

  const committedArtifacts = applyCommittedMemories(draft.candidate_state, draft);
  committedArtifacts.state.meta.state_revision = current.state_revision + 1;
  const committedState = assertReducerDomainState(committedArtifacts.state);
  const committedTurn = commitActionTurn(turn);
  const deliveryByAudience = new Map(
    normalizedGroundedNarratives.deliveries.map(delivery => [delivery.audience, delivery])
  );
  const deliveryFor = seat => deliveryByAudience.get('shared')
    ?? deliveryByAudience.get(`seat:${seat}`);
  const memberViews = {
    A: {
      action_turn: projectActionTurn(committedTurn, 'A'),
      narrative_delivery: deliveryFor('A')
    },
    B: {
      action_turn: projectActionTurn(committedTurn, 'B'),
      narrative_delivery: deliveryFor('B')
    }
  };
  const stateHash = turnDraftCandidateStateHash(committedState);
  const publishedBundle = {
    turn: committedTurn,
    state: committedState,
    narrative_deliveries: normalizedGroundedNarratives.deliveries,
    grounding_review_receipts: normalizedGroundedNarratives.grounding_review_receipts,
    committed_memories: committedArtifacts.memories,
    shinobi_daily: committedArtifacts.daily,
    member_views: memberViews
  };
  const publishedBundleHash = hashJson(publishedBundle);

  return immutableJson({
    schema: IN_MEMORY_TURN_COMMIT_SCHEMA,
    status: 'COMMITTED',
    commit_id: normalizedPreconditions.identity.commit_id,
    turn_id: turn.turn_id,
    state_revision: committedState.meta.state_revision,
    state_hash: stateHash,
    candidate_state_hash: draft.candidate_state_hash,
    published_bundle_hash: publishedBundleHash,
    commit_preconditions: normalizedPreconditions,
    ...publishedBundle,
    commit_receipt: {
      commit_id: normalizedPreconditions.identity.commit_id,
      turn_id: turn.turn_id,
      state_revision: committedState.meta.state_revision,
      state_hash: stateHash,
      published_bundle_hash: publishedBundleHash
    }
  });
}

/**
 * Stage-1 end-to-end prototype. The supplied agents are deterministic fixed
 * callbacks; this function performs no network, database, clock or UI I/O.
 */
export function runFixedAgentTurnPrototype(config, fixedAgents) {
  assertObject(config, 'turn orchestration config');
  assertObject(fixedAgents, 'fixed agents');
  const baseState = assertReducerDomainState(config.base_state);
  const initialTurn = createActionTurn(config.turn);
  if (initialTurn.base_state_revision !== baseState.meta.state_revision) {
    throw new DomainError(
      'STALE_STATE_REVISION',
      'turn base revision does not match the authoritative base state'
    );
  }
  if (!Array.isArray(config.action_locks) || config.action_locks.length !== 2) {
    throw new DomainError(
      'INVALID_ACTION_LOCK_SET',
      'the prototype requires exactly two action lock commands'
    );
  }

  let turn = initialTurn;
  const actionReceipts = [];
  for (let index = 0; index < config.action_locks.length; index += 1) {
    const command = config.action_locks[index];
    const locked = lockActionSubmission(turn, {
      seat: command.seat,
      request: { ...command.request, schema: command.request.schema ?? ACTION_REQUEST_SCHEMA },
      submission_id: command.submission_id,
      received_at: command.received_at,
      server_secret: config.server_secret,
      ...(index === 0 ? { execution_plan: config.execution_plan } : {})
    });
    turn = locked.turn;
    actionReceipts.push({
      receipt: locked.receipt,
      pre_resolution_reveal: locked.pre_resolution_reveal
    });
  }
  if (turn.status !== 'SEALED') {
    throw new DomainError('INVALID_TURN_STATE', 'both action locks must seal the turn');
  }

  const refereeInput = buildRefereeInput(turn, {
    base_state: baseState,
    rules_version: config.rules_version,
    server_secret: config.server_secret
  });
  const resolutionCandidate = callFixedAgent(fixedAgents, 'referee', refereeInput);
  const compiledEffectDag = compileEffectDag(resolutionCandidate.effects, {
    ruleSnapshot: config.rule_snapshot,
    resolveReducer: resolveDomainReducer
  });
  const canonicalResolution = freezeCanonicalResolution(
    resolutionCandidate,
    {
      turn_id: turn.turn_id,
      base_state_revision: turn.base_state_revision,
      input_hash: refereeInput.input_hash,
      submission_ids: [turn.actions.A.submission_id, turn.actions.B.submission_id]
    },
    compiledEffectDag
  );
  const resolutionHash = hashJson(canonicalResolution);

  const projections = immutableJson(projectAudienceViewsWithPublicBaseline({
    turn_id: turn.turn_id,
    events: canonicalResolution.events,
    facts: config.public_facts ?? [],
    state: baseState
  }));
  const commitment = resolutionCommitment(
    config.server_secret,
    canonicalResolution,
    resolutionHash
  );
  const audiences = expectedNarrativeAudiences(turn.execution_plan.narrative_mode);
  const writerInputs = {};
  const deliveries = [];
  for (const audience of audiences) {
    const audienceProjection = projectionForAudience(projections, audience);
    const writerInput = {
      schema: 'naruto.multiplayer-fixed-writer-input/v1',
      turn_id: turn.turn_id,
      audience,
      audience_projection: audienceProjection,
      action_presentation: buildWriterActionProjection(turn, {
        audience_seat: audience === 'shared' ? null : audience.slice('seat:'.length),
        visible_submission_ids: visibleSubmissionIds(canonicalResolution, audienceProjection)
      })
    };
    writerInputs[audience] = writerInput;
    const narrativeCandidate = callFixedAgent(fixedAgents, 'writer', writerInput);
    deliveries.push(freezeNarrativeDelivery(narrativeCandidate, {
      turn_id: turn.turn_id,
      audience,
      resolution_commitment: commitment,
      canonical_resolution: canonicalResolution
    }));
  }

  const groundingInput = {
    schema: 'naruto.multiplayer-fixed-grounding-input/v1',
    turn_id: turn.turn_id,
    canonical_resolution: canonicalResolution,
    deliveries
  };
  const reviewResults = normalizeGroundingResults(
    callFixedAgent(fixedAgents, 'groundingReviewer', groundingInput),
    audiences
  );
  const reviewReceipts = deliveries.map((delivery, index) => (
    createNarrativeGroundingReviewReceipt(delivery, reviewResults[index])
  ));
  const groundedNarratives = assertGroundedNarrativeDeliverySet(
    deliveries,
    reviewReceipts,
    {
      narrative_mode: turn.execution_plan.narrative_mode,
      canonical_resolution: canonicalResolution,
      resolution_commitment: commitment
    }
  );

  const updateObligations = createUpdateObligations({
    canonicalResolution,
    resolutionHash,
    narrativeMode: turn.execution_plan.narrative_mode,
    projections
  });
  const obligationSetHash = hashJson(updateObligations);
  const narrativeBundleHash = hashJson(groundedNarratives);
  const projectionBundleHash = hashJson(projections);
  const obligations = draftObligations(updateObligations);
  const draft = createTurnDraft({
    room_id: turn.room_id,
    epoch_id: turn.epoch_id,
    draft_id: config.ids.draft_id,
    turn_id: turn.turn_id,
    run_id: config.ids.run_id,
    continuity_session_id: config.ids.continuity_session_id,
    lease_fence: config.ids.lease_fence,
    base_state_revision: turn.base_state_revision,
    base_state_hash: turnDraftCandidateStateHash(baseState),
    resolution_hash: resolutionHash,
    obligation_set_hash: obligationSetHash,
    execution_plan_hash: turn.execution_plan_hash,
    billing_provenance_hash: config.billing_provenance_hash,
    narrative_bundle_hash: narrativeBundleHash,
    projection_bundle_hash: projectionBundleHash,
    rule_snapshot_hash: compiledEffectDag.rule_snapshot_hash,
    prompt_version: config.prompt_version,
    base_candidate: baseState,
    effects: canonicalResolution.effects,
    obligations,
    required_effect_ids: canonicalResolution.effects.map(effect => effect.effect_id),
    required_obligation_ids: obligations.map(obligation => obligation.obligation_id)
  });
  const continuityInput = {
    schema: 'naruto.multiplayer-fixed-continuity-input/v1',
    operation: CONTINUITY_OPERATIONS.STAGE,
    canonical_resolution: canonicalResolution,
    audience_projections: projections,
    update_obligations: updateObligations,
    pending_effect_ids: draft.required_effect_ids,
    pending_obligation_ids: draft.required_obligation_ids
  };
  const transportOutput = normalizeTransportOutput(
    callFixedAgent(fixedAgents, 'continuity', continuityInput)
  );
  const continuityExecution = executeContinuityTransport(
    draft,
    transportOutput,
    {
      run_id: config.ids.run_id,
      continuity_session_id: config.ids.continuity_session_id,
      invocation_id: config.ids.invocation_id,
      command_attempt_id: config.ids.command_attempt_id,
      lease_fence: config.ids.lease_fence
    },
    createDraftRuntime({
      baseState,
      canonicalResolution,
      projections,
      updateObligations,
      ruleSnapshot: config.rule_snapshot
    })
  );
  const continuityResult = assertContinuityBundleResult(continuityExecution.result);
  if (continuityResult.status !== 'READY' || continuityExecution.draft.status !== 'READY') {
    throw new DomainError(
      'FIXED_CONTINUITY_NOT_READY',
      'the fixed Continuity output did not satisfy the complete TurnDraft gate',
      { status: continuityResult.status, review: continuityResult.review }
    );
  }
  const readyDraft = continuityExecution.draft;

  const current = immutableJson({
    room_lifecycle: 'ACTIVE',
    epoch_state: 'ACTIVE',
    turn_status: 'COMMITTING',
    current_turn_id: turn.turn_id,
    void_requested: false,
    state_revision: baseState.meta.state_revision,
    state_hash: turnDraftCandidateStateHash(baseState),
    lease_fence: config.ids.lease_fence,
    state: baseState
  });
  const identity = {
    room_id: turn.room_id,
    epoch_id: turn.epoch_id,
    turn_id: turn.turn_id,
    run_id: config.ids.run_id,
    draft_id: config.ids.draft_id,
    commit_id: config.ids.commit_id
  };
  const commitPreconditions = buildPrototypeCommitPreconditionSet({
    identity,
    current,
    turn,
    draft: readyDraft,
    canonicalResolution,
    resolutionHash,
    obligationSetHash,
    narrativeBundleHash
  });
  const commit = commitPrototypeTurnInMemory({
    current,
    turn,
    draft: readyDraft,
    canonicalResolution,
    updateObligations,
    groundedNarratives,
    preconditions: commitPreconditions
  });

  return immutableJson({
    action_receipts: actionReceipts,
    sealed_turn: turn,
    referee_input: refereeInput,
    canonical_resolution: canonicalResolution,
    resolution_hash: resolutionHash,
    audience_projections: projections,
    writer_inputs: writerInputs,
    grounded_narratives: groundedNarratives,
    update_obligations: updateObligations,
    draft: readyDraft,
    continuity_result: continuityResult,
    commit_preconditions: commitPreconditions,
    commit
  });
}
