import { randomUUID } from 'node:crypto';

import { assertTurnBillingPlan, TURN_BILLING_PLAN_SCHEMA } from '../contracts/billing-contracts.js';
import {
  COMMIT_PRECONDITION_SET_SCHEMA,
  assertCommitPreconditionSet
} from '../contracts/commit-contracts.js';
import {
  UPDATE_OBLIGATIONS_SCHEMA,
  assertUpdateObligations
} from '../contracts/obligation-contracts.js';
import { freezeCanonicalResolution } from '../contracts/resolution-contracts.js';
import { canonicalStringify, canonicalizeJson, sha256Hex } from '../domain/canonical-json.js';
import { hmacSha256 } from '../domain/canonical-json.js';
import { projectAudienceViewsWithPublicBaseline } from '../domain/world-public-baseline.js';
import { projectAudienceViews } from '../domain/audience-projector.js';
import { compileEffectDag } from '../domain/effect-dag.js';
import { DomainError } from '../domain/errors.js';
import {
  INTEGRITY_POLICY_HASH,
  assertReducerDomainState,
  reduceDomainEffect,
  resolveDomainReducer
} from '../domain/reducers/index.js';
import {
  createTurnDraft,
  turnDraftCandidateStateHash
} from '../domain/turn-draft.js';
import { createContinuityItemValidators } from '../contracts/continuity-contracts.js';
import { buildContinuityPrompt, AGENT_PROMPT_VERSIONS } from '../agent/prompts.js';
import { MODEL_PROGRESS_STATUSES } from '../contracts/turn-progress-contracts.js';
import { createProductionKnowledgeEvidence } from '../application/production-knowledge-evidence.js';
import {
  createProductionMechanicalEffectRequirementDeriver
} from '../application/production-mechanical-effect-requirements.js';
import {
  openNarrativeDeliveryContent,
  sealNarrativeDeliveryContent
} from '../security/narrative-delivery-content-codec.js';
import {
  createSqliteResolutionCheckRepository
} from './sqlite-resolution-check-repository.js';

const RETRYABLE_TURN_STATUSES = new Set([
  'AWAITING_BILLING_AUTHORIZATION',
  'REPAIR_PAUSED',
  'RETRYABLE_FAILED'
]);
const RETRYABLE_RUN_STATUSES = new Set(['PAUSED', 'FAILED', 'ABANDONED']);
const ID_REGEXP = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL_REGEXP = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;
const EVENT_PROJECTION_VERSION = 'naruto.multiplayer-turn-control-event-projection/v1';
const WORKFLOW_BLOB_PURPOSE = 'naruto.multiplayer-agent-workflow-blob/v1';
const OUTPUT_ADOPTION_PROVENANCE_SCHEMA =
  'naruto.multiplayer-output-adoption-provenance/v1';
const NARRATIVE_REVIEW_CACHE_STAGE = 'narrative_grounding_receipts';
const TERMINAL_MISSION_STATUSES = new Set(['COMPLETED', 'FAILED', 'ABANDONED']);
const ACTIVE_COMBAT_PHASES = new Set(['SETUP', 'ACTIVE']);
const ACTIVE_EVENT_STATUSES = new Set(['SCHEDULED', 'TRIGGERED', 'DEFERRED']);
const ENTITY_REFERENCE_FIELDS = new Set([
  'actor_id',
  'assignee_actor_ids',
  'entity_id',
  'from_actor_ids',
  'npc_id',
  'participant_id',
  'source_actor_id',
  'target_actor_id',
  'to_actor_ids',
  'winner_ids'
]);
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

function fail(code, message, details = {}, status = undefined) {
  throw new DomainError(code, message, details, status === undefined ? {} : { status });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID_REGEXP.test(value)) {
    fail('TURN_WORKFLOW_INPUT_INVALID', `${label} must be a valid identifier`, { field: label });
  }
  return value;
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL_REGEXP.test(value)) {
    fail('TURN_WORKFLOW_INPUT_INVALID', 'authenticated_user_id is invalid', {}, 401);
  }
  return value;
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('TURN_WORKFLOW_INPUT_INVALID', `${label} must be a non-negative safe integer`, {
      field: label
    });
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('TURN_WORKFLOW_CLOCK_INVALID', 'clock must return an ISO timestamp');
  }
  return value;
}

function immutable(value) {
  const freeze = item => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(canonicalizeJson(value));
}

function hashJson(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stableWorkflowId(kind, material) {
  return `${kind}_${sha256Hex(canonicalStringify(material)).slice(0, 32)}`;
}

function parseJson(value, label) {
  try {
    return canonicalizeJson(JSON.parse(value));
  } catch {
    fail('PERSISTED_WORKFLOW_CORRUPT', `${label} is not valid JSON`);
  }
}

function workflowContext({ kind, run_id, turn_id, audience = 'none', output_hash = null }) {
  return Object.freeze({
    purpose: WORKFLOW_BLOB_PURPOSE,
    kind,
    run_id,
    turn_id,
    audience,
    output_hash
  });
}

function sealWorkflow(codec, value, context) {
  const sealed = codec.sealJson(immutable(value), context);
  if (!sealed || !(sealed.action_ciphertext instanceof Uint8Array)
    || !(sealed.wrapped_data_key instanceof Uint8Array)
    || !(sealed.nonce instanceof Uint8Array)
    || !(sealed.auth_tag instanceof Uint8Array)
    || typeof sealed.master_key_version !== 'string') {
    fail('TURN_WORKFLOW_CONFIGURATION_INVALID', 'workflow content codec returned an invalid envelope');
  }
  return Object.freeze({
    ciphertext: Buffer.from(sealed.action_ciphertext),
    wrapped_data_key: Buffer.from(sealed.wrapped_data_key),
    nonce: Buffer.from(sealed.nonce),
    auth_tag: Buffer.from(sealed.auth_tag),
    master_key_version: sealed.master_key_version
  });
}

function openWorkflow(codec, row, context, column) {
  return immutable(codec.openJson({
    action_ciphertext: Buffer.from(row[column]),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  }, context));
}

function continuityCommandResultContext(row) {
  return Object.freeze({
    purpose: 'naruto.continuity-command-result/v1',
    run_id: row.run_id,
    continuity_session_id: row.continuity_session_id,
    invocation_id: row.invocation_id,
    command_attempt_id: row.command_attempt_id,
    canonical_request_hash: row.canonical_request_hash
  });
}

function openContinuityCommandResult(codec, row) {
  return immutable(codec.openJson({
    action_ciphertext: Buffer.from(row.immutable_result_ciphertext),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  }, continuityCommandResultContext(row)));
}

function actionContext(row) {
  return Object.freeze({
    purpose: 'naruto.multiplayer-action-content/v1',
    room_id: row.room_id,
    epoch_id: row.epoch_id,
    turn_id: row.turn_id,
    submission_id: row.submission_id,
    member_id: row.member_id,
    seat_id: row.seat_id
  });
}

function openAction(codec, row) {
  const content = codec.openJson({
    action_ciphertext: Buffer.from(row.action_ciphertext),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  }, actionContext(row));
  if (!content || content.schema !== 'naruto.multiplayer-action-content/v1'
    || typeof content.text !== 'string') {
    fail('PERSISTED_WORKFLOW_CORRUPT', 'locked action content is invalid');
  }
  return content;
}

function projectionHash(value) {
  return hashJson(value);
}

function sourceRefs(projection) {
  return [...new Set([
    ...projection.events.map(event => `public:${event.event_id}`),
    ...projection.facts.map(fact => (
      fact.fact_id.startsWith('public:') ? fact.fact_id : `public:${fact.fact_id}`
    ))
  ])].sort();
}

function collectEntityReferences(value, refs, field = null) {
  if (typeof value === 'string') {
    if (ENTITY_REFERENCE_FIELDS.has(field) && /^(?:actor|npc):[A-Za-z0-9:_-]+$/u.test(value)) {
      refs.add(value);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectEntityReferences(item, refs, field);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectEntityReferences(child, refs, key);
  }
}

function effectEntityReferences(effect) {
  const refs = new Set();
  collectEntityReferences(effect.target, refs);
  collectEntityReferences(effect.payload, refs);
  return refs;
}

function activeMissions(state) {
  const byId = new Map();
  for (const collection of [
    state.shared_world.shared_missions,
    state.actors.A.missions,
    state.actors.B.missions
  ]) {
    for (const mission of collection.entries) {
      if (!TERMINAL_MISSION_STATUSES.has(mission.status)) {
        byId.set(mission.mission_id, mission);
      }
    }
  }
  return [...byId.values()].sort((left, right) => compareText(
    left.mission_id,
    right.mission_id
  ));
}

function relatedEntityIds(state, resolution) {
  const refs = new Set([
    state.actors.A.room_actor_id,
    state.actors.B.room_actor_id
  ]);
  for (const mission of activeMissions(state)) {
    for (const actorId of mission.assignee_actor_ids) refs.add(actorId);
  }
  for (const combat of state.shared_world.shared_combat.entries) {
    if (!ACTIVE_COMBAT_PHASES.has(combat.phase)) continue;
    for (const participant of combat.participants) refs.add(participant.participant_id);
  }
  for (const effect of resolution.effects) {
    for (const ref of effectEntityReferences(effect)) refs.add(ref);
  }
  for (const event of resolution.events) {
    for (const audience of event.audiences) {
      if (audience === 'seat:A' || audience === 'actor:A') {
        refs.add(state.actors.A.room_actor_id);
      } else if (audience === 'seat:B' || audience === 'actor:B') {
        refs.add(state.actors.B.room_actor_id);
      } else if (/^(?:actor|npc):[A-Za-z0-9:_-]+$/u.test(audience)) {
        refs.add(audience.endsWith(':private')
          ? audience.slice(0, -':private'.length)
          : audience);
      }
    }
  }
  return [...refs].sort(compareText);
}

function stableSubjectIds(state, resolution) {
  const ids = new Set(relatedEntityIds(state, resolution));
  for (const profile of state.shared_world.world_state.npc_profiles) ids.add(profile.npc_id);
  for (const collection of [
    state.shared_world.shared_missions,
    state.actors.A.missions,
    state.actors.B.missions
  ]) for (const mission of collection.entries) ids.add(mission.mission_id);
  for (const combat of state.shared_world.shared_combat.entries) ids.add(combat.combat_id);
  for (const event of state.shared_world.canonical_events.entries) ids.add(event.event_id);
  for (const effect of resolution.effects) {
    for (const [key, value] of Object.entries(effect.target)) {
      if (key.endsWith('_id') && typeof value === 'string' && ID_REGEXP.test(value)) {
        ids.add(value);
      }
    }
  }
  return [...ids].sort(compareText);
}

function domainScopes(state, resolution) {
  const actorIds = [
    state.actors.A.room_actor_id,
    state.actors.B.room_actor_id
  ].sort(compareText);
  const missionIds = new Set(activeMissions(state).map(item => item.mission_id));
  const combatIds = new Set(state.shared_world.shared_combat.entries
    .filter(item => ACTIVE_COMBAT_PHASES.has(item.phase))
    .map(item => item.combat_id));
  const eventIds = new Set(state.shared_world.canonical_events.entries
    .filter(item => ACTIVE_EVENT_STATUSES.has(item.status))
    .map(item => item.event_id));
  for (const event of resolution.events) eventIds.add(event.event_id);
  for (const effect of resolution.effects) {
    if (effect.domain === 'mission') missionIds.add(effect.target.mission_id);
    if (effect.domain === 'combat') combatIds.add(effect.target.combat_id);
    if (effect.domain === 'event') eventIds.add(effect.target.event_id);
  }

  const descriptors = [{ domain: 'world', scope_ref: 'world:canonical' }];
  for (const domain of ['attributes', 'skills', 'equipment']) {
    for (const actorId of actorIds) descriptors.push({ domain, scope_ref: actorId });
  }
  for (const missionId of [...missionIds].sort(compareText)) {
    descriptors.push({ domain: 'missions', scope_ref: missionId });
  }
  if (missionIds.size === 0) {
    descriptors.push({ domain: 'missions', scope_ref: 'mission:active' });
  }
  for (const entityId of relatedEntityIds(state, resolution)) {
    descriptors.push({ domain: 'relationships', scope_ref: entityId });
  }
  for (const combatId of [...combatIds].sort(compareText)) {
    descriptors.push({ domain: 'combat', scope_ref: combatId });
  }
  if (combatIds.size === 0) {
    descriptors.push({ domain: 'combat', scope_ref: 'combat:active' });
  }
  for (const eventId of [...eventIds].sort(compareText)) {
    descriptors.push({ domain: 'events', scope_ref: eventId });
  }
  return descriptors;
}

function effectSatisfiesScope(effect, descriptor) {
  if (EFFECT_UPDATE_DOMAIN[effect.domain] !== descriptor.domain) return false;
  const ref = descriptor.scope_ref;
  if (descriptor.domain === 'world') return true;
  if (['attributes', 'skills', 'equipment'].includes(descriptor.domain)) {
    return effect.target.actor_id === ref;
  }
  if (descriptor.domain === 'missions') return effect.target.mission_id === ref;
  if (descriptor.domain === 'relationships') {
    return effectEntityReferences(effect).has(ref);
  }
  if (descriptor.domain === 'combat') return effect.target.combat_id === ref;
  if (descriptor.domain === 'events') return effect.target.event_id === ref;
  return false;
}

function memoryProjection({ schema, audience, turnId, events }) {
  return immutable({
    schema,
    audience,
    turn_id: turnId,
    events: events.map(event => canonicalizeJson(event)),
    facts: []
  });
}

function privateSeatEvents(seatProjection, sharedProjection) {
  const shared = new Map(sharedProjection.events.map(event => [event.event_id, event]));
  return seatProjection.events.filter(event => {
    const sharedEvent = shared.get(event.event_id);
    return !sharedEvent || canonicalStringify(sharedEvent) !== canonicalStringify(event);
  });
}

function createMemoryProjections({ state, resolution, projections }) {
  const result = {
    server_bound: memoryProjection({
      schema: 'naruto.multiplayer-canonical-memory-source/v1',
      audience: 'server_bound',
      turnId: resolution.turn_id,
      events: resolution.events
    }),
    shared: memoryProjection({
      schema: 'naruto.multiplayer-shared-memory-projection/v1',
      audience: 'shared',
      turnId: resolution.turn_id,
      events: projections.shared.events
    }),
    'actor:A': memoryProjection({
      schema: 'naruto.multiplayer-actor-private-memory-projection/v1',
      audience: 'actor:A',
      turnId: resolution.turn_id,
      events: privateSeatEvents(projections.seat_A, projections.shared)
    }),
    'actor:B': memoryProjection({
      schema: 'naruto.multiplayer-actor-private-memory-projection/v1',
      audience: 'actor:B',
      turnId: resolution.turn_id,
      events: privateSeatEvents(projections.seat_B, projections.shared)
    })
  };
  const npcIds = new Set(state.shared_world.world_state.npc_profiles.map(item => item.npc_id));
  for (const effect of resolution.effects) {
    for (const ref of effectEntityReferences(effect)) {
      if (ref.startsWith('npc:')) npcIds.add(ref);
    }
  }
  for (const npcId of [...npcIds].sort(compareText)) {
    const binding = `${npcId}:private`;
    const events = resolution.events.filter(event => (
      event.audiences.includes(npcId) || event.audiences.includes(binding)
    ));
    result[binding] = memoryProjection({
      schema: 'naruto.multiplayer-npc-private-memory-projection/v1',
      audience: binding,
      turnId: resolution.turn_id,
      events
    });
  }
  return immutable(result);
}

function createUpdateObligations({
  state,
  resolution,
  resolutionHash,
  narrativeMode,
  projections,
  memoryProjections
}) {
  for (const effect of resolution.effects) {
    if (!EFFECT_UPDATE_DOMAIN[effect.domain]) {
      fail('UNMAPPED_UPDATE_DOMAIN', 'resolution effect has no obligation domain', {
        effect_id: effect.effect_id,
        effect_domain: effect.domain
      });
    }
  }
  const domains = domainScopes(state, resolution).map(descriptor => ({
    obligation_id: stableWorkflowId(`obligation_domain_${descriptor.domain}`, {
      turn_id: resolution.turn_id,
      scope_ref: descriptor.scope_ref
    }),
    domain: descriptor.domain,
    scope_refs: [descriptor.scope_ref],
    satisfied_by_effect_ids: resolution.effects
      .filter(effect => effectSatisfiesScope(effect, descriptor))
      .map(effect => effect.effect_id)
  }));
  const artifacts = [{
    obligation_id: 'obligation_memory_canonical',
    kind: 'memory',
    target_binding: 'server_bound',
    source_projection_hash: projectionHash(memoryProjections.server_bound)
  }];
  for (const binding of ['shared', 'actor:A', 'actor:B']) {
    const projection = memoryProjections[binding];
    if (projection.events.length === 0) continue;
    artifacts.push({
      obligation_id: `obligation_memory_${binding.replace(':', '_')}`,
      kind: 'memory',
      target_binding: binding,
      source_projection_hash: projectionHash(projection)
    });
  }
  for (const [binding, projection] of Object.entries(memoryProjections)
    .filter(([binding]) => binding.startsWith('npc:'))
    .sort(([left], [right]) => compareText(left, right))) {
    if (projection.events.length === 0) continue;
    artifacts.push({
      obligation_id: stableWorkflowId('obligation_memory_npc', {
        turn_id: resolution.turn_id,
        target_binding: binding
      }),
      kind: 'memory',
      target_binding: binding,
      source_projection_hash: projectionHash(projection)
    });
  }
  artifacts.push({
    obligation_id: 'obligation_daily_world_public',
    kind: 'shinobi_daily',
    target_binding: 'world_public',
    source_projection_hash: projectionHash(projections.world_public)
  });

  const hashes = {
    shared: projectionHash(projections.shared),
    A: projectionHash(projections.seat_A),
    B: projectionHash(projections.seat_B)
  };
  return assertUpdateObligations({
    schema: UPDATE_OBLIGATIONS_SCHEMA,
    turn_id: resolution.turn_id,
    resolution_hash: resolutionHash,
    narrative_mode: narrativeMode,
    effect_obligations: resolution.effects.map(effect => ({
      effect_id: effect.effect_id,
      effect_seq: effect.effect_seq,
      effect_hash: effect.effect_hash,
      depends_on_effect_ids: effect.depends_on_effect_ids
    })),
    domain_obligations: domains,
    artifact_obligations: artifacts,
    narrative_obligations: (narrativeMode === 'shared' ? ['shared'] : ['seat:A', 'seat:B'])
      .map(audience => ({
        obligation_id: `obligation_narrative_${audience.replace(':', '_')}`,
        audience,
        source_projection_hash: audience === 'shared'
          ? hashes.shared
          : hashes[audience.slice(-1)]
      }))
  });
}

function draftObligations(value) {
  return [
    ...value.domain_obligations
      .filter(item => item.satisfied_by_effect_ids.length === 0)
      .map(item => ({ ...item, kind: 'domain_check' })),
    ...value.artifact_obligations
  ];
}

function continuityReferenceBindings({ state, resolution, projections, memoryProjections, obligations }) {
  const allEvents = resolution.events.map(event => event.event_id);
  const bindings = {};
  for (const item of obligations.domain_obligations) {
    bindings[item.obligation_id] = { allowedEvidenceEventIds: allEvents };
  }
  const subjects = stableSubjectIds(state, resolution);
  for (const item of obligations.artifact_obligations) {
    if (item.kind !== 'memory') continue;
    const projection = memoryProjections[item.target_binding];
    if (!projection) {
      fail('UPDATE_OBLIGATION_BINDING_INVALID', 'memory obligation has no bound projection', {
        obligation_id: item.obligation_id,
        target_binding: item.target_binding
      });
    }
    bindings[item.obligation_id] = {
      audienceEventIds: projection.events.map(event => event.event_id),
      stableSubjectIds: subjects,
      modifiableEntryIds: []
    };
  }
  bindings.obligation_daily_world_public = { worldPublicRefs: sourceRefs(projections.world_public) };
  return immutable(bindings);
}

function reducerRuntime({ resolution, referenceBindings, ruleSnapshot }) {
  return Object.freeze({
    validators: createContinuityItemValidators({ byObligation: referenceBindings }),
    resolveReducer(key) {
      if (!resolution.effects.some(effect => effect.required_reducer === key)) return undefined;
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

function deepClone(value) {
  return canonicalizeJson(value);
}

function audienceSafeHistory(state) {
  const memoryEntries = key => deepClone(state.memories?.[key]?.entries ?? []);
  const shared = memoryEntries('shared');
  const daily = deepClone(state.shared_world?.continuity_ledger?.shinobi_daily ?? []);
  return immutable({
    shared: { memories: shared, shinobi_daily: daily },
    'seat:A': {
      memories: [...shared, ...memoryEntries('actor:A')],
      shinobi_daily: daily
    },
    'seat:B': {
      memories: [...shared, ...memoryEntries('actor:B')],
      shinobi_daily: daily
    }
  });
}

function explicitWorldPublicFacts(state) {
  const candidates = state.shared_world?.continuity_ledger?.world_public_facts;
  if (!Array.isArray(candidates)) return Object.freeze([]);
  return immutable(candidates.filter(item => (
    item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.fact_id === 'string'
      && typeof item.summary === 'string'
      && item.world_public === true
      && Array.isArray(item.audiences)
      && item.audiences.includes('seat:A')
      && item.audiences.includes('seat:B')
  )).map(item => ({
    fact_id: item.fact_id,
    summary: item.summary,
    audiences: ['seat:A', 'seat:B'],
    world_public: true
  })));
}

function materializeArtifacts(draft, nextRevision) {
  const state = deepClone(draft.candidate_state);
  for (const ledger of draft.obligation_ledger) {
    if (ledger.status !== 'CONSUMED' || !ledger.current_artifact) continue;
    const obligation = draft.obligations.find(item => item.obligation_id === ledger.obligation_id);
    if (ledger.kind === 'memory') {
      const partition = obligation.target_binding === 'server_bound'
        ? 'canonical'
        : (obligation.target_binding.startsWith('npc:')
            ? 'npc_private'
            : obligation.target_binding);
      const container = state.memories[partition];
      if (!container || !Array.isArray(container.entries)) {
        fail('INVALID_MEMORY_PARTITION', 'authoritative memory partition is invalid', { partition });
      }
      const record = {
        memory_id: `memory:${sha256Hex(canonicalStringify({
          obligation_id: ledger.obligation_id,
          artifact_hash: ledger.current_artifact_hash
        })).slice(0, 32)}`,
        source_turn_id: draft.turn_id,
        target_binding: obligation.target_binding,
        artifact_hash: ledger.current_artifact_hash,
        summary: ledger.current_artifact.summary,
        entries: ledger.current_artifact.entries,
        supersede_entry_ids: ledger.current_artifact.supersede_entry_ids,
        retract_entry_ids: ledger.current_artifact.retract_entry_ids
      };
      if (!container.entries.some(item => item.memory_id === record.memory_id)) {
        container.entries.push(record);
        container.entries.sort((a, b) => compareText(String(a.memory_id), String(b.memory_id)));
      }
    } else if (ledger.kind === 'shinobi_daily') {
      const continuity = state.shared_world.continuity_ledger;
      if (!continuity || typeof continuity !== 'object' || Array.isArray(continuity)) {
        fail('INVALID_CONTINUITY_LEDGER', 'continuity ledger must be an object');
      }
      const entries = Array.isArray(continuity.shinobi_daily)
        ? continuity.shinobi_daily
        : [];
      const dailyId = `daily:${sha256Hex(canonicalStringify({
        turn_id: draft.turn_id,
        artifact_hash: ledger.current_artifact_hash
      })).slice(0, 32)}`;
      const inserted = !entries.some(item => item.daily_id === dailyId);
      if (inserted) {
        entries.push({
          daily_id: dailyId,
          source_turn_id: draft.turn_id,
          artifact_hash: ledger.current_artifact_hash,
          daily: ledger.current_artifact.daily,
          source_refs: ledger.current_artifact.source_refs
        });
      }
      state.shared_world.continuity_ledger = {
        ...continuity,
        revision: inserted
          ? (Number.isSafeInteger(continuity.revision) ? continuity.revision + 1 : 1)
          : continuity.revision,
        shinobi_daily: entries
      };
    }
  }
  state.meta.state_revision = nextRevision;
  return assertReducerDomainState(state);
}

function successfulUsage(database, turnId, invocationId) {
  const usage = database.prepare(`
    SELECT invocation_id, turn_id, plan_hash, stage, audience, usage_status
      FROM ai_usage_ledger
     WHERE invocation_id = ? AND turn_id = ?
  `).get(invocationId, turnId);
  if (!usage || usage.usage_status !== 'SUCCEEDED') {
    fail('MODEL_USAGE_PROVENANCE_MISSING', 'adopted output has no successful model invocation', {
      turn_id: turnId,
      invocation_id: invocationId
    });
  }
  return usage;
}

function latestSuccessfulUsage(database, turnId, stages, audience = null) {
  const placeholders = stages.map(() => '?').join(', ');
  const params = [turnId, ...stages];
  let audienceSql = '';
  if (audience !== null) {
    audienceSql = ' AND audience = ?';
    params.push(audience);
  }
  const usage = database.prepare(`
    SELECT invocation_id, turn_id, plan_hash, stage, audience, usage_status
      FROM ai_usage_ledger
     WHERE turn_id = ? AND stage IN (${placeholders})
       AND usage_status = 'SUCCEEDED'${audienceSql}
     ORDER BY completed_at DESC, started_at DESC, attempt DESC
     LIMIT 1
  `).get(...params);
  if (!usage) {
    fail('MODEL_USAGE_PROVENANCE_MISSING', 'adopted output has no successful stage usage', {
      turn_id: turnId,
      stages,
      audience
    });
  }
  return usage;
}

function adoptionTail(database, turnId) {
  return database.prepare(`
    SELECT provenance_hash
      FROM turn_output_adoption_events
     WHERE turn_id = ?
     ORDER BY rowid DESC
     LIMIT 1
  `).get(turnId)?.provenance_hash ?? null;
}

function appendAdoptionEvent(database, {
  turnId,
  outputKind,
  outputId,
  outputVersion = 1,
  outputHash,
  invocationId,
  transport,
  adoptionStatus = 'ADOPTED',
  createdAt,
  idFactory
}) {
  const usage = successfulUsage(database, turnId, invocationId);
  if (!['native_tools', 'json_protocol'].includes(transport)) {
    fail('OUTPUT_ADOPTION_PROVENANCE_INVALID', 'adoption transport is invalid', { transport });
  }
  const existing = database.prepare(`
    SELECT * FROM turn_output_adoption_events
     WHERE turn_id = ? AND output_kind = ? AND output_id = ?
       AND output_version = ? AND adoption_status = ?
  `).get(turnId, outputKind, outputId, outputVersion, adoptionStatus);
  if (existing) {
    if (existing.output_hash !== outputHash
      || existing.generation_invocation_id !== invocationId
      || existing.plan_hash !== usage.plan_hash
      || existing.transport !== transport) {
      fail('IDEMPOTENCY_CONFLICT', 'output adoption changed after persistence', {
        output_kind: outputKind,
        output_id: outputId,
        output_version: outputVersion
      });
    }
    return existing.provenance_hash;
  }
  const previous = adoptionTail(database, turnId);
  const provenanceHash = hashJson({
    schema: OUTPUT_ADOPTION_PROVENANCE_SCHEMA,
    previous_provenance_hash: previous,
    event_type: adoptionStatus,
    invocation_id: invocationId,
    stage: usage.stage,
    plan_hash: usage.plan_hash,
    transport_mode: transport,
    output_kind: outputKind,
    output_id: outputId,
    output_version: outputVersion,
    canonical_output_hash: outputHash
  });
  database.prepare(`
    INSERT INTO turn_output_adoption_events (
      adoption_event_id, turn_id, output_kind, output_id, output_version,
      output_hash, adoption_status, generation_invocation_id, plan_hash,
      transport, previous_provenance_hash, provenance_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generatedId(idFactory, 'adoption'),
    turnId,
    outputKind,
    outputId,
    outputVersion,
    outputHash,
    adoptionStatus,
    invocationId,
    usage.plan_hash,
    transport,
    previous,
    provenanceHash,
    createdAt
  );
  return provenanceHash;
}

function defaultIdFactory(kind) {
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

function generatedId(idFactory, kind) {
  return identifier(idFactory(kind), `${kind}_id`);
}

function requireMember(database, roomId, userId) {
  const row = database.prepare(`
    SELECT m.member_id, m.seat_id,
           r.lifecycle, r.active_epoch_id, r.current_turn_id,
           r.control_revision, r.event_seq
      FROM multiplayer_members AS m
      JOIN multiplayer_rooms AS r ON r.room_id = m.room_id
     WHERE m.room_id = ? AND m.user_id = ? AND m.member_status = 'ACTIVE'
  `).get(roomId, userId);
  if (!row) fail('ROOM_MEMBERSHIP_REQUIRED', 'active room membership is required', {}, 403);
  if (row.lifecycle === 'ARCHIVED') {
    fail('ROOM_ARCHIVED_READ_ONLY', 'an archived room is read-only', {}, 409);
  }
  return row;
}

function insertRetryEvents(database, {
  roomId,
  epochId,
  turn,
  endEventSeq,
  controlRevision,
  createdAt,
  idFactory
}) {
  const insertEvent = database.prepare(`
    INSERT INTO room_events (
      event_id, room_id, event_seq, epoch_id, turn_id, event_type,
      audience, projection_version, projected_payload_json, payload_hash,
      created_at
    ) VALUES (?, ?, ?, ?, ?, 'resolution.progress', ?, ?, ?, ?, ?)
  `);
  const insertOutbox = database.prepare(`
    INSERT INTO room_outbox (
      outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
      lease_fence, lease_expires_at, claimed_at, dispatched_at,
      attempt_count, created_at
    ) VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, 0, ?)
  `);
  for (const [offset, seat] of ['A', 'B'].entries()) {
    const eventId = generatedId(idFactory, 'event');
    const payloadJson = canonicalStringify({
      turn_id: turn.turn_id,
      turn_no: turn.turn_no,
      viewer_seat: seat,
      status: 'QUEUED',
      resumed_from: turn.turn_status,
      control_revision: controlRevision
    });
    insertEvent.run(
      eventId,
      roomId,
      endEventSeq - 1 + offset,
      epochId,
      turn.turn_id,
      seat,
      EVENT_PROJECTION_VERSION,
      payloadJson,
      `sha256:${sha256Hex(payloadJson)}`,
      createdAt
    );
    insertOutbox.run(generatedId(idFactory, 'outbox'), roomId, eventId, createdAt);
  }
}

function insertPauseEvents(database, {
  run,
  endEventSeq,
  status,
  reason,
  resumeStage,
  errorCode,
  detail,
  progress = {},
  createdAt,
  idFactory
}) {
  const insertEvent = database.prepare(`
    INSERT INTO room_events (
      event_id, room_id, event_seq, epoch_id, turn_id, event_type,
      audience, projection_version, projected_payload_json, payload_hash,
      created_at
    ) VALUES (?, ?, ?, ?, ?, 'resolution.progress', ?, ?, ?, ?, ?)
  `);
  const insertOutbox = database.prepare(`
    INSERT INTO room_outbox (
      outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
      lease_fence, lease_expires_at, claimed_at, dispatched_at,
      attempt_count, created_at
    ) VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, 0, ?)
  `);
  for (const [offset, seat] of ['A', 'B'].entries()) {
    const eventId = generatedId(idFactory, 'event');
    const payloadJson = canonicalStringify({
      turn_id: run.turn_id,
      turn_no: run.turn_no,
      viewer_seat: seat,
      status,
      resume_stage: resumeStage,
      reason,
      error_code: errorCode,
      detail,
      ...progress,
      updated_at: createdAt
    });
    insertEvent.run(
      eventId,
      run.room_id,
      endEventSeq - 1 + offset,
      run.epoch_id,
      run.turn_id,
      seat,
      EVENT_PROJECTION_VERSION,
      payloadJson,
      `sha256:${sha256Hex(payloadJson)}`,
      createdAt
    );
    insertOutbox.run(
      generatedId(idFactory, 'outbox'),
      run.room_id,
      eventId,
      createdAt
    );
  }
}

function safePauseDetail(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safe = {};
  for (const field of [
    'provider_request_id',
    'upstream_error_code',
    'upstream_error_type',
    'upstream_error_summary'
  ]) {
    if (typeof value[field] === 'string' && value[field]) {
      safe[field] = value[field].slice(0, field === 'upstream_error_summary' ? 500 : 200);
    }
  }
  if (Number.isSafeInteger(value.upstream_status)
    && value.upstream_status >= 100 && value.upstream_status <= 599) {
    safe.upstream_status = value.upstream_status;
  }
  if (['memory', 'shinobi_daily', 'domain', 'protocol'].includes(value.failure_kind)) {
    safe.failure_kind = value.failure_kind;
  }
  for (const field of ['repair_attempts', 'remaining_items']) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) safe[field] = value[field];
  }
  return Object.keys(safe).length > 0 ? immutable(safe) : null;
}

/**
 * Durable player-triggered retry scheduling. This repository never performs a
 * model request; it only re-queues the latest failed/paused run after proving
 * that no invocation remains IN_FLIGHT or UNKNOWN.
 */
export function createSqliteTurnWorkflowRepository(connection, options = {}) {
  if (!connection || typeof connection.read !== 'function' || typeof connection.write !== 'function') {
    fail('TURN_WORKFLOW_CONFIGURATION_INVALID', 'a multiplayer SQLite connection is required');
  }
  const idFactory = typeof options.idFactory === 'function'
    ? options.idFactory
    : defaultIdFactory;
  const clock = typeof options.clock === 'function'
    ? options.clock
    : () => new Date().toISOString();
  const contentCodec = options.contentCodec ?? null;
  const narrativeContentCodec = options.narrativeContentCodec ?? contentCodec;
  const snapshotService = options.snapshotService ?? null;
  const continuityRepository = options.continuityRepository ?? null;
  const providerModelClient = options.providerModelClient ?? null;
  const resolveModelProfile = options.resolveModelProfile ?? null;
  const commitmentSecret = options.resolutionCommitmentSecret ?? null;
  const ruleSnapshot = immutable(options.ruleSnapshot ?? {
    schema: 'naruto.multiplayer-rule-snapshot/v1',
    revision: 1,
    reducer_registry_hash: INTEGRITY_POLICY_HASH
  });
  const rulesVersion = options.rulesVersion ?? 'naruto.multiplayer-rules/v1';
  const productionKnowledge = options.productionKnowledgeEvidence
    ?? createProductionKnowledgeEvidence();
  const publicFactsProvider = options.publicFactsProvider ?? (({ job, resolution, state }) => (
    productionKnowledge.worldPublicFacts({
      job,
      resolution,
      state
    })
  ));
  const historyProvider = options.historyProvider ?? (({ job }) => (
    audienceSafeHistory(authoritativeState(job))
  ));
  const authoritativeEvidenceProvider = options.authoritativeEvidenceProvider
    ?? (context => productionKnowledge.authoritative(context));
  const mechanicalEffectRequirementDeriver = options.deriveMechanicalEffectRequirements
    ?? createProductionMechanicalEffectRequirementDeriver();
  const resolutionCheckRepository = options.resolutionCheckRepository
    ?? (contentCodec && !options.resolutionCheckExecutor
      ? createSqliteResolutionCheckRepository(connection, {
          contentCodec,
          idFactory,
          clock,
          randomInteger: options.resolutionCheckRandomInteger
        })
      : null);
  const resolutionCheckExecutor = options.resolutionCheckExecutor
    ?? (input => {
      if (typeof resolutionCheckRepository?.execute !== 'function') {
        fail(
          'TURN_WORKFLOW_CONFIGURATION_INVALID',
          'persistent authoritative resolution check repository is required'
        );
      }
      return resolutionCheckRepository.execute(input);
    });

  function requireProductionPorts() {
    if (!contentCodec || typeof contentCodec.sealJson !== 'function'
      || typeof contentCodec.openJson !== 'function'
      || !narrativeContentCodec || typeof narrativeContentCodec.sealJson !== 'function'
      || typeof narrativeContentCodec.openJson !== 'function'
      || !snapshotService || typeof snapshotService.readInternal !== 'function'
      || typeof snapshotService.seal !== 'function'
      || !continuityRepository || typeof continuityRepository.createSession !== 'function'
      || typeof continuityRepository.loadSession !== 'function'
      || typeof continuityRepository.materializeReady !== 'function'
      || typeof continuityRepository.pauseSession !== 'function'
      || typeof continuityRepository.resumeSession !== 'function'
      || typeof continuityRepository.adoptLease !== 'function'
      || !providerModelClient || typeof providerModelClient.invoke !== 'function'
      || typeof commitmentSecret !== 'string' || !commitmentSecret) {
      fail(
        'TURN_WORKFLOW_CONFIGURATION_INVALID',
        'production workflow ports are incomplete'
      );
    }
  }

  function readResolution(row) {
    return openWorkflow(contentCodec, row, workflowContext({
      kind: 'canonical_resolution',
      run_id: row.run_id,
      turn_id: row.turn_id,
      output_hash: row.resolution_hash
    }), 'resolution_ciphertext');
  }

  function readNarrative(row) {
    return openNarrativeDeliveryContent(narrativeContentCodec, row);
  }

  function readNarrativeReviewCache(runId, turnId) {
    const row = connection.read(database => database.prepare(`
      SELECT * FROM agent_stage_sessions
       WHERE run_id = ? AND stage = ? AND audience = 'none'
    `).get(runId, NARRATIVE_REVIEW_CACHE_STAGE));
    if (!row) return null;
    const value = openWorkflow(contentCodec, row, workflowContext({
      kind: NARRATIVE_REVIEW_CACHE_STAGE,
      run_id: runId,
      turn_id: turnId
    }), 'session_state_ciphertext');
    if (value?.schema !== 'naruto.multiplayer-narrative-grounding-cache/v1'
      || !Array.isArray(value.grounding_review_receipts)) {
      fail('PERSISTED_WORKFLOW_CORRUPT', 'narrative grounding cache is invalid');
    }
    return value.grounding_review_receipts;
  }

  function stageKey(stage, audience) {
    return `${stage}:${audience ?? 'shared'}`;
  }

  async function modelStages(plan, job) {
    const result = {};
    for (const item of plan.stage_plans) {
      let profile = null;
      if (typeof resolveModelProfile === 'function') {
        profile = await resolveModelProfile({
          owner_user_id: item.payer_user_id,
          profile_ref: item.profile_ref,
          capability_probe_ref: item.capability_probe_ref
        });
      }
      const transport = item.transport ?? 'json_protocol';
      result[stageKey(item.stage, item.audience)] = Object.freeze({
        client: providerModelClient,
        profile,
        profile_ref: item.profile_ref,
        owner_user_id: item.payer_user_id,
        transport_mode: transport,
        use_provider_json_schema: profile?.adapter === 'openai_compatible',
        max_output_tokens: item.budget.max_output_tokens,
        execute_check: request => resolutionCheckExecutor(Object.freeze({
          request,
          run_id: job.run_id,
          room_id: job.room_id,
          epoch_id: job.epoch_id,
          turn_id: job.turn_id,
          lease_fence: job.lease_fence,
          base_state_revision: job.base_state_revision,
          base_state_hash: job.base_state_hash,
          state: authoritativeState(job)
        }))
      });
    }
    return Object.freeze(result);
  }

  async function load({ run_id, lease_fence }) {
    requireProductionPorts();
    const runId = identifier(run_id, 'run_id');
    const fence = revision(lease_fence, 'lease_fence');
    const raw = connection.read(database => {
      const row = database.prepare(`
        SELECT r.*, t.turn_status, t.narrative_mode, t.turn_kind, t.base_checkpoint_id,
               t.base_state_revision, t.base_state_hash,
               t.execution_plan_json, t.execution_plan_hash,
               t.input_hash AS turn_input_hash,
               room.lifecycle AS room_lifecycle,
               room.active_epoch_id, room.current_turn_id,
               room.state_revision AS room_state_revision,
               e.epoch_state, e.head_checkpoint_id
          FROM resolution_runs AS r
          JOIN multiplayer_turns AS t ON t.turn_id = r.turn_id
          JOIN multiplayer_rooms AS room ON room.room_id = r.room_id
          JOIN room_epochs AS e ON e.epoch_id = r.epoch_id
         WHERE r.run_id = ?
      `).get(runId);
      if (!row) fail('RUN_NOT_FOUND', 'resolution run does not exist', {}, 404);
      if (!['CLAIMED', 'RUNNING'].includes(row.run_status) || row.lease_fence !== fence) {
        fail('STALE_LEASE_FENCE', 'resolution workflow load is not bound to the live lease');
      }
      if (row.room_lifecycle !== 'ACTIVE'
        || row.epoch_state !== 'ACTIVE'
        || row.active_epoch_id !== row.epoch_id
        || row.current_turn_id !== row.turn_id) {
        fail('RESOLUTION_WORKFLOW_INVALID', 'run no longer targets the active room turn');
      }
      const actions = database.prepare(`
        SELECT a.*, t.room_id, t.epoch_id
          FROM action_submissions AS a
          JOIN multiplayer_turns AS t ON t.turn_id = a.turn_id
         WHERE a.turn_id = ? ORDER BY a.seat_id
      `).all(row.turn_id);
      if (actions.length !== 2 || actions[0].seat_id !== 'A' || actions[1].seat_id !== 'B') {
        fail('RESOLUTION_WORKFLOW_INVALID', 'sealed run must have exactly two locked actions');
      }
      const planRow = database.prepare(`
        SELECT * FROM turn_billing_plans
         WHERE turn_id = ? ORDER BY plan_revision DESC LIMIT 1
      `).get(row.turn_id);
      if (!planRow) fail('BILLING_PLAN_NOT_FOUND', 'sealed run has no frozen billing plan');
      const continuity = database.prepare(`
        SELECT d.lease_fence AS draft_lease_fence, s.continuity_session_id
          FROM turn_drafts AS d
          JOIN agent_stage_sessions AS s ON s.run_id = d.run_id
         WHERE d.run_id = ? AND s.stage = 'continuity' AND s.audience = 'none'
      `).get(runId) ?? null;
      return { row, actions, planRow, continuity };
    });
    if (raw.continuity) {
      await continuityRepository.adoptLease({
        run_id: runId,
        continuity_session_id: raw.continuity.continuity_session_id,
        new_lease_fence: fence,
        adopted_at: timestamp(clock())
      });
    }
    const plan = assertTurnBillingPlan({
      schema: TURN_BILLING_PLAN_SCHEMA,
      turn_id: raw.planRow.turn_id,
      plan_revision: raw.planRow.plan_revision,
      narrative_mode: raw.planRow.narrative_mode,
      turn_payer_selection_hash: raw.planRow.turn_payer_selection_hash,
      pov_writer_selection_hashes: raw.planRow.narrative_mode === 'shared'
        ? null
        : {
            A: raw.planRow.pov_writer_selection_a_hash,
            B: raw.planRow.pov_writer_selection_b_hash
          },
      stage_plans: parseJson(raw.planRow.stage_plans_json, 'billing stage plans'),
      plan_hash: raw.planRow.plan_hash,
      created_at: raw.planRow.created_at
    });
    const actions = raw.actions.map(row => {
      const content = openAction(contentCodec, row);
      return immutable({
        seat: row.seat_id,
        submission_id: row.submission_id,
        text: content.text,
        narration_note: content.narration_note ?? null,
        narration_preference: row.narration_preference
      });
    });
    return Object.freeze({
      ...raw.row,
      input_hash: raw.row.turn_input_hash,
      lease_fence: fence,
      actions: Object.freeze(actions),
      continuity_session_id: raw.continuity?.continuity_session_id ?? null,
      execution_plan: parseJson(raw.row.execution_plan_json, 'turn execution plan'),
      billing_plan: plan,
      model_stages: await modelStages(plan, raw.row)
    });
  }

  async function checkpointInvocation({ run_id, turn_id, lease_fence, event }) {
    requireProductionPorts();
    const runId = identifier(run_id, 'run_id');
    const turnId = identifier(turn_id, 'turn_id');
    const fence = revision(lease_fence, 'lease_fence');
    const stage = `invocation:${identifier(event?.scope?.stage, 'event.scope.stage')}`;
    const audience = event?.scope?.audience ?? 'none';
    if (!['none', 'A', 'B'].includes(audience)) {
      fail('TURN_WORKFLOW_INPUT_INVALID', 'invocation checkpoint audience is invalid');
    }
    const context = workflowContext({
      kind: stage,
      run_id: runId,
      turn_id: turnId,
      audience
    });
    const current = connection.read(database => database.prepare(`
      SELECT * FROM agent_stage_sessions
       WHERE run_id = ? AND stage = ? AND audience = ?
    `).get(runId, stage, audience));
    let value = {
      schema: 'naruto.multiplayer-stage-invocation-checkpoints/v1',
      events: []
    };
    if (current) {
      value = canonicalizeJson(
        openWorkflow(contentCodec, current, context, 'session_state_ciphertext')
      );
    }
    const existing = value.events.find(item => item.invocation_id === event.invocation_id);
    if (existing) {
      if (canonicalStringify(existing) !== canonicalStringify(event)) {
        fail('IDEMPOTENCY_CONFLICT', 'invocation checkpoint changed after persistence');
      }
      return immutable(existing);
    }
    value.events.push(canonicalizeJson(event));
    value.events.sort((a, b) => a.attempt - b.attempt);
    const envelope = sealWorkflow(contentCodec, value, context);
    const valueHash = hashJson(value);
    const nowValue = timestamp(clock());
    await connection.write(database => {
      const live = database.prepare(`
        SELECT run_status, lease_fence FROM resolution_runs WHERE run_id = ? AND turn_id = ?
      `).get(runId, turnId);
      if (!live || !['CLAIMED', 'RUNNING'].includes(live.run_status)
        || live.lease_fence !== fence) {
        fail('STALE_LEASE_FENCE', 'invocation checkpoint lease is stale');
      }
      if (!current) {
        database.prepare(`
          INSERT INTO agent_stage_sessions (
            stage_session_id, run_id, stage, audience, continuity_session_id,
            provider_session_ref, transport, session_state_ciphertext,
            wrapped_data_key, nonce, auth_tag, master_key_version,
            session_state_hash, resume_cursor, session_status,
            latest_invocation_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL,
            'OPEN', ?, ?, ?)
        `).run(
          generatedId(idFactory, 'stage_session'),
          runId,
          stage,
          audience,
          event.scope.stage.startsWith('continuity')
            ? (event.scope.transport_mode ?? 'json_protocol')
            : 'json_protocol',
          envelope.ciphertext,
          envelope.wrapped_data_key,
          envelope.nonce,
          envelope.auth_tag,
          envelope.master_key_version,
          valueHash,
          event.invocation_id,
          nowValue,
          nowValue
        );
      } else {
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
          valueHash,
          event.invocation_id,
          nowValue,
          current.stage_session_id,
          current.session_state_hash
        );
        if (changed.changes !== 1) fail('DRAFT_REVISION_CONFLICT', 'invocation checkpoint CAS failed');
      }
    });
    return immutable(event);
  }

  function authoritativeState(job) {
    const snapshot = snapshotService.readInternal({
      room_id: job.room_id,
      checkpoint_id: job.base_checkpoint_id
    });
    if (snapshot.state_revision !== job.base_state_revision
      || snapshot.state_hash !== job.base_state_hash) {
      fail('BASE_HASH_MISMATCH', 'turn base checkpoint differs from its authoritative snapshot');
    }
    return snapshot.state;
  }

  function openingPromptContext(job, state) {
    if (job.turn_kind !== 'OPENING') return null;
    const openings = state?.agent_internal?.story_plan?.openings;
    if (!openings?.A || !openings?.B
      || state?.agent_internal?.audit_state?.genesis_kind !== 'new_multiplayer_save') {
      fail(
        'OPENING_CONTEXT_INVALID',
        'an opening turn has no authoritative new-save opening context'
      );
    }
    return immutable({
      schema: 'naruto.multiplayer-opening-context/v1',
      openings,
      requirements: [
        '呈现开场情境中的具体事件、来客、环境与尚未解决的变化，为长篇场景提供素材',
        '采用开局资料已经明确的站位与既定处境；玩家的新选择交给本人，NPC 与世界可以主动行动',
        '不得预先完成开场钩子或角色目标',
        '自然结束在待回应的场景，不把这些写作规则写进可见正文'
      ]
    });
  }

  async function prepareResolution({ job, lease_fence }) {
    requireProductionPorts();
    if (job.lease_fence !== lease_fence) fail('STALE_LEASE_FENCE', 'resolution preparation fence is stale');
    const cached = connection.read(database => database.prepare(`
      SELECT * FROM canonical_resolutions WHERE run_id = ? AND turn_id = ?
    `).get(job.run_id, job.turn_id));
    if (cached) return Object.freeze({ cached: readResolution(cached) });
    const state = authoritativeState(job);
    const openingContext = openingPromptContext(job, state);
    return Object.freeze({
      cached: null,
      referee_input: immutable({
        schema: 'naruto.multiplayer-referee-input/v1',
        room_id: job.room_id,
        epoch_id: job.epoch_id,
        turn_id: job.turn_id,
        turn_no: job.turn_no,
        base_state_revision: job.base_state_revision,
        rules_version: rulesVersion,
        base_state: state,
        turn_purpose: openingContext ? 'opening_scene' : 'player_actions',
        opening_context: openingContext,
        actions: job.actions.map(action => ({
          seat: action.seat,
          submission_id: action.submission_id,
          text: action.text
        })),
        input_hash: job.input_hash
      }),
      evidence: immutable(await authoritativeEvidenceProvider(Object.freeze({ job, state }))),
      mechanical_effect_requirements: immutable(options.mechanicalEffectRequirements ?? []),
      derive_mechanical_effect_requirements: input => mechanicalEffectRequirementDeriver({
        ...input,
        job
      }),
      validate_resolution_candidate: candidate => {
        try {
          compileResolutionCandidate(candidate, job);
          return [];
        } catch (error) {
          if (!(error instanceof DomainError) && !(error instanceof TypeError)) throw error;
          return [{ code: error.code ?? 'RESOLUTION_CONTRACT_INVALID',
            message: error.message, details: error.details ?? {} }];
        }
      },
      max_referee_repairs: options.maxRefereeRepairs ?? 3
    });
  }

  function compileResolutionCandidate(candidate, job) {
    const compiled = compileEffectDag(candidate.effects, { ruleSnapshot, resolveReducer: resolveDomainReducer });
    const resolution = freezeCanonicalResolution(candidate, {
      turn_id: job.turn_id, base_state_revision: job.base_state_revision,
      input_hash: job.input_hash, submission_ids: job.actions.map(action => action.submission_id)
    }, compiled);
    // Writer cannot repair an empty authoritative projection or change visibility.
    // Catch it while the Referee still owns an unfrozen candidate.
    const projections = projectAudienceViews({ turn_id: job.turn_id, events: resolution.events });
    const required = job.narrative_mode === 'shared' ? ['shared'] : ['seat_A', 'seat_B'];
    const missing = required.filter(audience => projections[audience].events.length === 0);
    if (missing.length) {
      fail('RESOLUTION_AUDIENCE_COVERAGE_MISSING',
        '正文受众没有可见事件。audiences 使用 seat:A、seat:B（共同可见时列出双方），不能填写 room_actor_id；world_public 不代替席位可见性。只能依据真实可观察范围修正，禁止为通过校验公开秘密。',
        { missing_audiences: missing, event_audiences: resolution.events.map(event => ({
          event_id: event.event_id, audiences: event.audiences
        })) });
    }
    return resolution;
  }

  async function adoptResolution({ job, lease_fence, result }) {
    requireProductionPorts();
    if (job.lease_fence !== lease_fence) fail('STALE_LEASE_FENCE', 'resolution adoption fence is stale');
    const resolution = compileResolutionCandidate(result.resolution_candidate, job);
    const resolutionHash = hashJson(resolution);
    const context = workflowContext({
      kind: 'canonical_resolution',
      run_id: job.run_id,
      turn_id: job.turn_id,
      output_hash: resolutionHash
    });
    const envelope = sealWorkflow(contentCodec, resolution, context);
    const createdAt = timestamp(clock());
    const generatorUsage = connection.read(database => latestSuccessfulUsage(
      database,
      job.turn_id,
      ['referee', 'resolution_repair']
    ));
    const generatorTransport = job.model_stages[
      stageKey(generatorUsage.stage, null)
    ]?.transport_mode;
    await connection.write(database => {
      const existing = database.prepare(`
        SELECT * FROM canonical_resolutions WHERE turn_id = ?
      `).get(job.turn_id);
      if (existing) {
        if (existing.run_id !== job.run_id || existing.resolution_hash !== resolutionHash) {
          fail('IDEMPOTENCY_CONFLICT', 'turn already adopted another canonical resolution');
        }
        appendAdoptionEvent(database, {
          turnId: job.turn_id,
          outputKind: 'resolution',
          outputId: resolution.resolution_id ?? `resolution:${job.turn_id}`,
          outputHash: resolutionHash,
          invocationId: generatorUsage.invocation_id,
          transport: generatorTransport,
          createdAt,
          idFactory
        });
        return;
      }
      const live = database.prepare(`
        SELECT run_status, lease_fence FROM resolution_runs WHERE run_id = ?
      `).get(job.run_id);
      if (!live || !['CLAIMED', 'RUNNING'].includes(live.run_status)
        || live.lease_fence !== lease_fence) fail('STALE_LEASE_FENCE', 'resolution adoption lease is stale');
      database.prepare(`
        INSERT INTO canonical_resolutions (
          resolution_id, turn_id, run_id, schema_version, resolution_ciphertext,
          wrapped_data_key, nonce, auth_tag, master_key_version,
          resolution_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generatedId(idFactory, 'resolution'),
        job.turn_id,
        job.run_id,
        resolution.schema,
        envelope.ciphertext,
        envelope.wrapped_data_key,
        envelope.nonce,
        envelope.auth_tag,
        envelope.master_key_version,
        resolutionHash,
        createdAt
      );
      appendAdoptionEvent(database, {
        turnId: job.turn_id,
        outputKind: 'resolution',
        outputId: resolution.resolution_id ?? `resolution:${job.turn_id}`,
        outputHash: resolutionHash,
        invocationId: generatorUsage.invocation_id,
        transport: generatorTransport,
        createdAt,
        idFactory
      });
      database.prepare(`UPDATE resolution_runs SET stage = 'narrative', updated_at = ? WHERE run_id = ?`)
        .run(createdAt, job.run_id);
      database.prepare(`
        UPDATE multiplayer_turns SET turn_status = 'RENDERING', updated_at = ?
         WHERE turn_id = ? AND turn_status IN ('SEALED', 'RESOLVING', 'RETRYABLE_FAILED')
      `).run(createdAt, job.turn_id);
    });
    return resolution;
  }

  async function projectionsFor(job, resolution) {
    const state = authoritativeState(job);
    const facts = await publicFactsProvider(Object.freeze({ job, resolution, state }));
    return immutable(projectAudienceViewsWithPublicBaseline({
      turn_id: job.turn_id,
      events: resolution.events,
      facts: facts ?? [],
      state
    }));
  }

  function resolutionCommitment(job, resolution, resolutionHash) {
    return `hmac-sha256:${hmacSha256(commitmentSecret, {
      schema: 'naruto.multiplayer-resolution-commitment/v1',
      turn_id: job.turn_id,
      input_hash: resolution.input_hash,
      resolution_hash: resolutionHash
    })}`;
  }

  function actionProjection(job, resolution, projection) {
    const visibleEvents = new Set(projection.events.map(event => event.event_id));
    const visibleSubmissions = new Set(resolution.outcomes
      .filter(outcome => outcome.event_ids.some(id => visibleEvents.has(id)))
      .map(outcome => outcome.submission_id));
    return immutable({
      presentation_requests: job.actions
        .filter(action => visibleSubmissions.has(action.submission_id))
        .map(action => ({
          submission_id: action.submission_id,
          narration_preference: action.narration_preference,
          narration_note: action.narration_note
        }))
    });
  }

  async function prepareNarrative({ job, resolution, lease_fence }) {
    requireProductionPorts();
    if (job.lease_fence !== lease_fence) fail('STALE_LEASE_FENCE', 'narrative preparation fence is stale');
    const expected = job.narrative_mode === 'shared' ? ['shared'] : ['A', 'B'];
    const rows = connection.read(database => database.prepare(`
      SELECT n.*, c.run_id, t.room_id, t.epoch_id
      FROM narrative_deliveries AS n
      JOIN canonical_resolutions AS c ON c.turn_id = n.turn_id
      JOIN multiplayer_turns AS t ON t.turn_id = n.turn_id
      WHERE n.turn_id = ? AND c.run_id = ? ORDER BY n.audience
    `).all(job.turn_id, job.run_id));
    if (rows.length === expected.length
      && rows.every((row, index) => row.audience === expected[index])) {
      const deliveries = rows.map(readNarrative);
      const groundingReceipts = readNarrativeReviewCache(job.run_id, job.turn_id);
      if (!groundingReceipts) {
        fail('PERSISTED_WORKFLOW_CORRUPT', 'grounded narrative cache has no reviewer receipts');
      }
      return Object.freeze({
        cached: immutable({
          deliveries,
          grounding_review_receipts: groundingReceipts
        })
      });
    }
    if (rows.length) fail('PERSISTED_WORKFLOW_CORRUPT', 'narrative cache is incomplete');
    const resolutionHash = hashJson(resolution);
    const projections = await projectionsFor(job, resolution);
    const commitment = resolutionCommitment(job, resolution, resolutionHash);
    const audiencePairs = job.narrative_mode === 'shared'
      ? [['shared', projections.shared]]
      : [['seat:A', projections.seat_A], ['seat:B', projections.seat_B]];
    const writerActionProjections = Object.fromEntries(audiencePairs.map(([audience, projection]) => [
      audience,
      actionProjection(job, resolution, projection)
    ]));
    const histories = await historyProvider(Object.freeze({ job, projections }));
    const state = authoritativeState(job);
    const openingContext = openingPromptContext(job, state);
    const presetRow = connection.read(database => database.prepare('SELECT writer_preset_json FROM multiplayer_turns WHERE turn_id = ?').get(job.turn_id));
    const writerPreset = presetRow?.writer_preset_json ? JSON.parse(presetRow.writer_preset_json) : null;
    return Object.freeze({
      cached: null,
      narrative_mode: job.narrative_mode,
      canonical_resolution: resolution,
      resolution_commitment: commitment,
      audience_projections: projections,
      writer_action_projections: immutable(writerActionProjections),
      history_by_audience: immutable(histories ?? {}),
      style_requirements: immutable({
        language: 'zh-CN',
        target_characters: writerPreset?.preset ? '遵循所选玩家预设的篇幅要求' : openingContext ? '1200—1800' : '900—1500',
        minimum_characters: writerPreset?.preset ? 0 : openingContext ? 800 : 500,
        writer_preset: writerPreset,
        player_names: Object.fromEntries(['A', 'B'].map(seat => [seat, state.actors?.[seat]?.player?.display_name ?? `玩家 ${seat}`])),
        visible_content: '仅故事正文；不含规则说明、主持通知或防御性旁白',
        ...options.styleRequirements
      }),
      turn_purpose: openingContext ? 'opening_scene' : 'player_actions',
      opening_context: openingContext,
      max_writer_repairs: options.maxWriterRepairs ?? 3,
      max_reviewer_protocol_retries: options.maxReviewerProtocolRetries ?? 2
    });
  }

  async function adoptNarrative({ job, resolution, lease_fence, result }) {
    requireProductionPorts();
    if (job.lease_fence !== lease_fence) fail('STALE_LEASE_FENCE', 'narrative adoption fence is stale');
    const resolutionHash = hashJson(resolution);
    const projections = await projectionsFor(job, resolution);
    const receipts = new Map(result.grounding_review_receipts.map(receipt => [receipt.audience, receipt]));
    const materials = result.deliveries.map(delivery => {
      const audience = delivery.audience === 'shared' ? 'shared' : delivery.audience.slice(-1);
      const receipt = receipts.get(delivery.audience);
      if (!receipt) fail('NARRATIVE_GROUNDING_REQUIRED', 'grounded narrative receipt is missing');
      const projection = audience === 'shared'
        ? projections.shared
        : projections[`seat_${audience}`];
      const usageAudience = audience === 'shared' ? 'shared' : audience;
      const usage = connection.read(database => latestSuccessfulUsage(
        database,
        job.turn_id,
        ['writer'],
        usageAudience
      ));
      const deliveryId = stableWorkflowId('delivery', {
        turn_id: job.turn_id,
        audience,
        resolution_hash: resolutionHash
      });
      const projectionHash = hashJson(projection);
      const sealed = sealNarrativeDeliveryContent(narrativeContentCodec, {
        room_id: job.room_id,
        epoch_id: job.epoch_id,
        turn_id: job.turn_id,
        delivery_id: deliveryId,
        audience,
        narrative_mode: job.narrative_mode,
        resolution_hash: resolutionHash,
        projection_hash: projectionHash,
        writer_invocation_id: usage.invocation_id,
        stop_point_ref: delivery.stop_point_ref
      }, delivery);
      return {
        audience,
        delivery,
        deliveryId,
        narrativeHash: sealed.narrative_hash,
        envelope: sealed,
        projectionHash,
        usage,
        transport: job.model_stages[stageKey('writer', audience === 'shared' ? null : audience)]
          ?.transport_mode
      };
    });
    const createdAt = timestamp(clock());
    const reviewUsage = connection.read(database => latestSuccessfulUsage(
      database,
      job.turn_id,
      ['narrative_grounding_reviewer']
    ));
    const reviewValue = immutable({
      schema: 'naruto.multiplayer-narrative-grounding-cache/v1',
      grounding_review_receipts: result.grounding_review_receipts
    });
    const reviewContext = workflowContext({
      kind: NARRATIVE_REVIEW_CACHE_STAGE,
      run_id: job.run_id,
      turn_id: job.turn_id
    });
    const reviewEnvelope = sealWorkflow(contentCodec, reviewValue, reviewContext);
    const reviewHash = hashJson(reviewValue);
    await connection.write(database => {
      const live = database.prepare(`SELECT run_status, lease_fence FROM resolution_runs WHERE run_id = ?`)
        .get(job.run_id);
      if (!live || !['CLAIMED', 'RUNNING'].includes(live.run_status)
        || live.lease_fence !== lease_fence) fail('STALE_LEASE_FENCE', 'narrative adoption lease is stale');
      const insert = database.prepare(`
        INSERT INTO narrative_deliveries (
          delivery_id, turn_id, audience, narrative_mode, delivery_ciphertext,
          wrapped_data_key, nonce, auth_tag, master_key_version,
          resolution_hash, projection_hash, narrative_hash,
          writer_invocation_id, stop_point_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of materials) {
        const existing = database.prepare(`
          SELECT narrative_hash, writer_invocation_id
            FROM narrative_deliveries WHERE turn_id = ? AND audience = ?
        `).get(job.turn_id, item.audience);
        if (existing) {
          if (existing.narrative_hash !== item.narrativeHash
            || existing.writer_invocation_id !== item.usage.invocation_id) {
            fail('IDEMPOTENCY_CONFLICT', 'narrative audience already adopted another delivery');
          }
        } else {
          insert.run(
            item.deliveryId,
            job.turn_id,
            item.audience,
            job.narrative_mode,
            item.envelope.delivery_ciphertext,
            item.envelope.wrapped_data_key,
            item.envelope.nonce,
            item.envelope.auth_tag,
            item.envelope.master_key_version,
            resolutionHash,
            item.projectionHash,
            item.narrativeHash,
            item.usage.invocation_id,
            item.delivery.stop_point_ref,
            createdAt
          );
        }
        appendAdoptionEvent(database, {
          turnId: job.turn_id,
          outputKind: 'narrative',
          outputId: item.deliveryId,
          outputHash: item.narrativeHash,
          invocationId: item.usage.invocation_id,
          transport: item.transport,
          createdAt,
          idFactory
        });
      }
      const existingReview = database.prepare(`
        SELECT * FROM agent_stage_sessions
         WHERE run_id = ? AND stage = ? AND audience = 'none'
      `).get(job.run_id, NARRATIVE_REVIEW_CACHE_STAGE);
      if (existingReview) {
        if (existingReview.session_state_hash !== reviewHash) {
          fail('IDEMPOTENCY_CONFLICT', 'narrative grounding receipts changed after adoption');
        }
      } else {
        database.prepare(`
          INSERT INTO agent_stage_sessions (
            stage_session_id, run_id, stage, audience, continuity_session_id,
            provider_session_ref, transport, session_state_ciphertext,
            wrapped_data_key, nonce, auth_tag, master_key_version,
            session_state_hash, resume_cursor, session_status,
            latest_invocation_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'none', NULL, NULL, 'json_protocol', ?, ?, ?, ?, ?, ?,
            NULL, 'COMPLETE', ?, ?, ?)
        `).run(
          generatedId(idFactory, 'stage_session'),
          job.run_id,
          NARRATIVE_REVIEW_CACHE_STAGE,
          reviewEnvelope.ciphertext,
          reviewEnvelope.wrapped_data_key,
          reviewEnvelope.nonce,
          reviewEnvelope.auth_tag,
          reviewEnvelope.master_key_version,
          reviewHash,
          reviewUsage.invocation_id,
          createdAt,
          createdAt
        );
      }
      database.prepare(`UPDATE resolution_runs SET stage = 'continuity', updated_at = ? WHERE run_id = ?`)
        .run(createdAt, job.run_id);
      database.prepare(`
        UPDATE multiplayer_turns SET turn_status = 'STAGING_UPDATES', updated_at = ?
         WHERE turn_id = ? AND turn_status IN ('RENDERING', 'RENDERING_REPAIR', 'RETRYABLE_FAILED')
      `).run(createdAt, job.turn_id);
    });
    return immutable({
      deliveries: result.deliveries,
      grounding_review_receipts: result.grounding_review_receipts
    });
  }

  function continuityIds(job) {
    return Object.freeze({
      continuity_session_id: stableWorkflowId('continuity_session', {
        run_id: job.run_id,
        turn_id: job.turn_id
      }),
      draft_id: stableWorkflowId('draft', {
        run_id: job.run_id,
        turn_id: job.turn_id,
        base_state_hash: job.base_state_hash
      }),
      stage_session_id: stableWorkflowId('stage_session', {
        run_id: job.run_id,
        stage: 'continuity'
      })
    });
  }

  function latestContinuityCommand(job, continuitySessionId) {
    const row = connection.read(database => database.prepare(`
      SELECT * FROM turn_continuity_commands
       WHERE run_id = ? AND continuity_session_id = ?
         AND command_status IN ('ACCEPTED', 'REJECTED')
       ORDER BY completed_at DESC, rowid DESC
       LIMIT 1
    `).get(job.run_id, continuitySessionId));
    if (!row) return null;
    return Object.freeze({ row, result: openContinuityCommandResult(contentCodec, row) });
  }

  function invocationCheckpoint(job, invocationId) {
    const rows = connection.read(database => database.prepare(`
      SELECT * FROM agent_stage_sessions
       WHERE run_id = ? AND stage LIKE 'invocation:continuity_%'
    `).all(job.run_id));
    for (const row of rows) {
      const value = openWorkflow(contentCodec, row, workflowContext({
        kind: row.stage,
        run_id: job.run_id,
        turn_id: job.turn_id,
        audience: row.audience
      }), 'session_state_ciphertext');
      const event = value?.events?.find(item => item.invocation_id === invocationId);
      if (event) return event;
    }
    return null;
  }

  function continuityResumeState(job, session) {
    const latestCommand = latestContinuityCommand(job, session.continuity_session_id);
    const latestInvocationId = latestCommand?.row.invocation_id ?? connection.read(database => (
      database.prepare(`
        SELECT invocation_id FROM ai_usage_ledger
         WHERE turn_id = ? AND stage IN ('continuity_steward', 'continuity_repair')
           AND usage_status = 'SUCCEEDED'
         ORDER BY completed_at DESC, started_at DESC, attempt DESC
         LIMIT 1
      `).get(job.turn_id)?.invocation_id ?? null
    ));
    if (!latestInvocationId) return null;
    const checkpoint = invocationCheckpoint(job, latestInvocationId);
    const providerSession = checkpoint?.result?.session ?? null;
    if (!providerSession) {
      fail('PERSISTED_WORKFLOW_CORRUPT', 'Continuity invocation has no provider session checkpoint', {
        invocation_id: latestInvocationId
      });
    }
    const toolCallIds = (checkpoint.result?.response?.tool_calls ?? [])
      .map(item => item.id)
      .filter(id => typeof id === 'string' && id);
    const requestCount = connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM ai_usage_ledger
       WHERE turn_id = ? AND stage IN ('continuity_steward', 'continuity_repair')
         AND usage_status = 'SUCCEEDED'
    `).get(job.turn_id).count);
    const operation = session.draft.expected_operation ?? 'repair_turn_bundle';
    const trustedResult = latestCommand?.result ?? {
      schema: 'naruto.multiplayer-continuity-protocol-retry/v1',
      status: 'PROTOCOL_RETRY',
      retryable_by: 'continuity',
      next_operation: operation,
      errors: [{
        code: 'PROTOCOL_VIOLATION',
        message: 'the prior provider response did not yield an accepted Bundle command',
        consumed: false
      }]
    };
    return immutable({
      operation,
      session: providerSession,
      trusted_result: trustedResult,
      reply_to_tool_call_id: toolCallIds[0] ?? null,
      reply_to_tool_call_ids: toolCallIds,
      next_request_no: requestCount + 1
    });
  }

  async function prepareContinuity({ job, resolution, narrative, lease_fence }) {
    requireProductionPorts();
    if (job.lease_fence !== lease_fence) {
      fail('STALE_LEASE_FENCE', 'Continuity preparation fence is stale');
    }
    const state = authoritativeState(job);
    const projections = await projectionsFor(job, resolution);
    const memoryProjections = createMemoryProjections({ state, resolution, projections });
    const continuityProjections = immutable({
      ...projections,
      memory_partitions: memoryProjections
    });
    const resolutionHash = hashJson(resolution);
    const obligations = createUpdateObligations({
      state,
      resolution,
      resolutionHash,
      narrativeMode: job.narrative_mode,
      projections,
      memoryProjections
    });
    const ids = continuityIds(job);
    const narrativeDeliveries = [...narrative.deliveries]
      .sort((left, right) => compareText(left.audience, right.audience));
    let session = null;
    const existing = connection.read(database => database.prepare(`
      SELECT continuity_session_id FROM agent_stage_sessions
       WHERE run_id = ? AND stage = 'continuity' AND audience = 'none'
    `).get(job.run_id));
    if (existing) {
      if (existing.continuity_session_id !== ids.continuity_session_id) {
        fail('PERSISTED_WORKFLOW_CORRUPT', 'run is bound to another Continuity session');
      }
      session = continuityRepository.loadSession({
        run_id: job.run_id,
        continuity_session_id: ids.continuity_session_id
      });
      if (session.session_status === 'PAUSED') {
        session = await continuityRepository.resumeSession({
          run_id: job.run_id,
          continuity_session_id: ids.continuity_session_id,
          lease_fence,
          resumed_at: timestamp(clock())
        });
      }
    } else {
      const billingProvenanceHash = connection.read(database => adoptionTail(
        database,
        job.turn_id
      ));
      if (!billingProvenanceHash) {
        fail('MODEL_USAGE_PROVENANCE_MISSING', 'Continuity draft has no adopted resolution/narrative provenance');
      }
      const draft = createTurnDraft({
        room_id: job.room_id,
        epoch_id: job.epoch_id,
        draft_id: ids.draft_id,
        turn_id: job.turn_id,
        run_id: job.run_id,
        continuity_session_id: ids.continuity_session_id,
        lease_fence,
        base_state_revision: job.base_state_revision,
        base_state_hash: job.base_state_hash,
        resolution_hash: resolutionHash,
        obligation_set_hash: hashJson(obligations),
        execution_plan_hash: job.execution_plan_hash,
        billing_provenance_hash: billingProvenanceHash,
        narrative_bundle_hash: hashJson(narrativeDeliveries),
        projection_bundle_hash: hashJson(continuityProjections),
        rule_snapshot_hash: hashJson(ruleSnapshot),
        prompt_version: AGENT_PROMPT_VERSIONS.continuity_steward,
        base_candidate: state,
        effects: resolution.effects,
        obligations: draftObligations(obligations)
      });
      session = await continuityRepository.createSession({
        stage_session_id: ids.stage_session_id,
        draft,
        transport: job.transport,
        created_at: timestamp(clock())
      });
    }
    const referenceBindings = continuityReferenceBindings({
      state,
      resolution,
      projections,
      memoryProjections,
      obligations
    });
    const runtime = reducerRuntime({ resolution, referenceBindings, ruleSnapshot });
    const initialPrompt = buildContinuityPrompt({
      operation: 'stage_turn_bundle',
      transport_mode: session.transport,
      canonical_resolution: resolution,
      update_obligations: obligations,
      reference_bindings: referenceBindings,
      base_state: state,
      narratives: narrativeDeliveries,
      audience_projections: continuityProjections,
      world_public_projection: projections.world_public,
      repair_plan: session.draft.repair_plan,
      receipt_summary: [
        ...session.draft.effect_ledger,
        ...session.draft.obligation_ledger
      ].filter(item => item.receipt).map(item => item.receipt),
      request_limits: {
        max_model_requests: options.maxContinuityModelRequests ?? 8
      }
    });
    return Object.freeze({
      continuity_session_id: ids.continuity_session_id,
      draft_id: ids.draft_id,
      cached_ready: session.draft.status === 'READY' ? session : null,
      initial_prompt: initialPrompt,
      reference_bindings: referenceBindings,
      resume_state: session.draft.status === 'READY'
        ? null
        : continuityResumeState(job, session),
      max_model_requests: options.maxContinuityModelRequests ?? 8,
      reducer_runtime: runtime,
      obligations,
      projections: continuityProjections
    });
  }

  async function createBoundContinuityContext({
    job,
    continuity,
    invocation_id,
    command_attempt_id,
    lease_fence
  }) {
    requireProductionPorts();
    if (job.lease_fence !== lease_fence) {
      fail('STALE_LEASE_FENCE', 'Continuity context fence is stale');
    }
    const session = continuityRepository.loadSession({
      run_id: job.run_id,
      continuity_session_id: continuity.continuity_session_id
    });
    const draft = session.draft;
    return immutable({
      room_id: job.room_id,
      epoch_id: job.epoch_id,
      turn_id: job.turn_id,
      run_id: job.run_id,
      continuity_session_id: draft.continuity_session_id,
      invocation_id,
      command_attempt_id,
      draft_id: draft.draft_id,
      base_state_revision: draft.base_state_revision,
      resolution_hash: draft.resolution_hash,
      obligation_set_hash: draft.obligation_set_hash,
      execution_plan_hash: draft.execution_plan_hash,
      stage_billing_plan_hash: job.billing_plan.plan_hash,
      billing_provenance_hash: draft.billing_provenance_hash,
      agent_role: 'continuity_steward',
      transport_mode: session.transport,
      prompt_version: draft.prompt_version,
      lease_fence
    });
  }

  function appendReadyOutputAdoptions({ job, draft, candidateState, createdAt }) {
    return connection.write(database => {
      const live = database.prepare(`
        SELECT run_status, lease_fence FROM resolution_runs WHERE run_id = ?
      `).get(job.run_id);
      if (!live || !['CLAIMED', 'RUNNING'].includes(live.run_status)
        || live.lease_fence !== job.lease_fence) {
        fail('STALE_LEASE_FENCE', 'READY adoption fence is stale');
      }
      const acceptedItem = database.prepare(`
        SELECT c.invocation_id, c.transport
          FROM turn_continuity_command_items AS i
          JOIN turn_continuity_commands AS c
            ON c.command_attempt_id = i.command_attempt_id
         WHERE i.turn_id = ? AND i.item_kind = ? AND i.item_id = ?
           AND i.item_status = 'ACCEPTED' AND i.consumed = 1
           AND c.command_status = 'ACCEPTED'
         ORDER BY i.created_at, i.rowid
         LIMIT 1
      `);
      for (const effect of [...draft.frozen_effects]
        .sort((left, right) => left.effect_seq - right.effect_seq)) {
        const source = acceptedItem.get(job.turn_id, 'effect', effect.effect_id);
        if (!source) {
          fail('MODEL_USAGE_PROVENANCE_MISSING', 'consumed effect has no accepted Bundle invocation', {
            effect_id: effect.effect_id
          });
        }
        appendAdoptionEvent(database, {
          turnId: job.turn_id,
          outputKind: 'effect',
          outputId: effect.effect_id,
          outputHash: effect.effect_hash,
          invocationId: source.invocation_id,
          transport: source.transport,
          createdAt,
          idFactory
        });
      }
      const artifacts = database.prepare(`
        SELECT a.obligation_id, a.artifact_revision, a.artifact_hash,
               a.generated_by_invocation_id, c.transport
          FROM turn_draft_artifact_versions AS a
          JOIN turn_continuity_commands AS c
            ON c.invocation_id = a.generated_by_invocation_id
           AND c.run_id = ? AND c.command_status = 'ACCEPTED'
         WHERE a.turn_id = ? AND a.artifact_status = 'CURRENT'
         ORDER BY a.obligation_id
      `).all(job.run_id, job.turn_id);
      for (const artifact of artifacts) {
        const ledger = draft.obligation_ledger.find(item => (
          item.obligation_id === artifact.obligation_id
        ));
        if (!ledger || ledger.current_artifact_hash !== artifact.artifact_hash) {
          fail('PERSISTED_WORKFLOW_CORRUPT', 'current artifact differs from READY draft');
        }
        appendAdoptionEvent(database, {
          turnId: job.turn_id,
          outputKind: ledger.kind === 'shinobi_daily' ? 'daily' : 'memory',
          outputId: artifact.obligation_id,
          outputVersion: artifact.artifact_revision,
          outputHash: artifact.artifact_hash,
          invocationId: artifact.generated_by_invocation_id,
          transport: artifact.transport,
          createdAt,
          idFactory
        });
      }
      const latest = database.prepare(`
        SELECT c.invocation_id, c.transport
          FROM turn_continuity_commands AS c
         WHERE c.run_id = ? AND c.continuity_session_id = ?
           AND c.command_status = 'ACCEPTED'
         ORDER BY c.completed_at DESC, c.rowid DESC
         LIMIT 1
      `).get(job.run_id, draft.continuity_session_id);
      if (!latest) {
        fail('MODEL_USAGE_PROVENANCE_MISSING', 'READY draft has no accepted Continuity command');
      }
      appendAdoptionEvent(database, {
        turnId: job.turn_id,
        outputKind: 'candidate_state',
        outputId: draft.draft_id,
        outputHash: turnDraftCandidateStateHash(candidateState),
        invocationId: latest.invocation_id,
        transport: latest.transport,
        createdAt,
        idFactory
      });
      return adoptionTail(database, job.turn_id);
    });
  }

  async function prepareCommit({ job, committed_at }) {
    requireProductionPorts();
    const ids = continuityIds(job);
    let session = continuityRepository.loadSession({
      run_id: job.run_id,
      continuity_session_id: ids.continuity_session_id
    });
    if (session.draft.lease_fence !== job.lease_fence) {
      fail('STALE_LEASE_FENCE', 'READY draft fence is stale');
    }
    if (session.draft.status !== 'READY') {
      fail('DRAFT_NOT_READY', 'Continuity draft is not READY for final commit');
    }
    const materialized = session.draft.ready_receipt?.finalize_metadata
      ?.materialized_authoritative_snapshot === true;
    if (!materialized) {
      const candidateState = materializeArtifacts(
        session.draft,
        job.base_state_revision + 1
      );
      const billingProvenanceHash = await appendReadyOutputAdoptions({
        job,
        draft: session.draft,
        candidateState,
        createdAt: committed_at
      });
      session = await continuityRepository.materializeReady({
        run_id: job.run_id,
        continuity_session_id: ids.continuity_session_id,
        lease_fence: job.lease_fence,
        expected_draft_revision: session.draft.draft_revision,
        candidate_state: candidateState,
        billing_provenance_hash: billingProvenanceHash,
        materialized_at: committed_at
      });
    }
    const draft = session.draft;
    await connection.write(database => {
      const changed = database.prepare(`
        UPDATE multiplayer_turns SET turn_status = 'COMMITTING', updated_at = ?
         WHERE turn_id = ? AND turn_status IN ('AUDITING', 'RETRYABLE_FAILED',
           'STAGING_UPDATES', 'COMMITTING')
      `).run(committed_at, job.turn_id);
      if (changed.changes !== 1) {
        fail('TURN_STAGE_CONFLICT', 'turn cannot enter COMMITTING');
      }
    });
    const lifecycle = connection.read(database => database.prepare(`
      SELECT r.lifecycle AS room_lifecycle, r.current_turn_id,
             e.epoch_state, t.turn_status
        FROM multiplayer_rooms AS r
        JOIN room_epochs AS e ON e.epoch_id = r.active_epoch_id
        JOIN multiplayer_turns AS t ON t.turn_id = r.current_turn_id
       WHERE r.room_id = ? AND e.epoch_id = ? AND t.turn_id = ?
    `).get(job.room_id, job.epoch_id, job.turn_id));
    if (!lifecycle) fail('COMMIT_PRECONDITION_FAILED', 'active commit lifecycle is missing');
    const commitId = stableWorkflowId('commit', {
      run_id: job.run_id,
      turn_id: job.turn_id,
      semantic_draft_hash: draft.semantic_draft_hash
    });
    const checkpointId = stableWorkflowId('checkpoint', {
      epoch_id: job.epoch_id,
      turn_id: job.turn_id,
      commit_id: commitId
    });
    const snapshotId = stableWorkflowId('snapshot', {
      checkpoint_id: checkpointId,
      state_hash: draft.candidate_state_hash
    });
    const preconditions = assertCommitPreconditionSet({
      schema: COMMIT_PRECONDITION_SET_SCHEMA,
      identity: {
        room_id: job.room_id,
        epoch_id: job.epoch_id,
        turn_id: job.turn_id,
        run_id: job.run_id,
        draft_id: draft.draft_id,
        commit_id: commitId
      },
      lifecycle: {
        room_lifecycle: lifecycle.room_lifecycle,
        epoch_state: lifecycle.epoch_state,
        turn_status: lifecycle.turn_status,
        current_turn_id: lifecycle.current_turn_id,
        void_requested: false
      },
      concurrency: {
        base_state_revision: draft.base_state_revision,
        base_state_hash: draft.base_state_hash,
        lease_fence: draft.lease_fence,
        draft_revision: draft.draft_revision,
        draft_status: draft.status
      },
      frozen_inputs: {
        input_hash: job.input_hash,
        resolution_hash: draft.resolution_hash,
        obligation_set_hash: draft.obligation_set_hash,
        execution_plan_hash: draft.execution_plan_hash
      },
      billing: { billing_provenance_hash: draft.billing_provenance_hash },
      result: {
        candidate_state_hash: draft.candidate_state_hash,
        artifact_bundle_hash: draft.artifact_bundle_hash,
        narrative_bundle_hash: draft.narrative_bundle_hash,
        semantic_draft_hash: draft.semantic_draft_hash,
        commit_envelope_hash: draft.commit_envelope_hash
      }
    });
    const snapshot = snapshotService.seal({
      room_id: job.room_id,
      epoch_id: job.epoch_id,
      checkpoint_id: checkpointId,
      snapshot_id: snapshotId,
      state_revision: job.base_state_revision + 1,
      state: draft.candidate_state
    });
    return Object.freeze({
      preconditions,
      checkpoint_id: checkpointId,
      snapshot_id: snapshotId,
      snapshot,
      committed_at
    });
  }

  async function recoverCommit({ job, request }) {
    const row = connection.read(database => database.prepare(`
      SELECT tc.*, c.snapshot_ref, c.state_revision AS checkpoint_state_revision,
             c.state_hash AS checkpoint_state_hash,
             s.state_revision AS snapshot_state_revision,
             s.state_hash AS snapshot_state_hash
        FROM turn_commits AS tc
        JOIN room_checkpoints AS c ON c.checkpoint_id = tc.checkpoint_id
        JOIN room_snapshots AS s ON s.snapshot_id = c.snapshot_ref
       WHERE tc.turn_id = ? OR tc.commit_id = ?
    `).get(job.turn_id, request.preconditions.identity.commit_id));
    if (!row) return Object.freeze({ status: 'NOT_COMMITTED' });
    const expected = request.preconditions;
    const matches = row.commit_id === expected.identity.commit_id
      && row.turn_id === expected.identity.turn_id
      && row.room_id === expected.identity.room_id
      && row.epoch_id === expected.identity.epoch_id
      && row.checkpoint_id === request.checkpoint_id
      && row.snapshot_ref === request.snapshot_id
      && row.before_state_revision === expected.concurrency.base_state_revision
      && row.after_state_revision === expected.concurrency.base_state_revision + 1
      && row.after_state_hash === expected.result.candidate_state_hash
      && row.artifact_set_hash === expected.result.artifact_bundle_hash
      && row.narrative_set_hash === expected.result.narrative_bundle_hash
      && row.commit_envelope_hash === expected.result.commit_envelope_hash
      && row.lease_fence === expected.concurrency.lease_fence
      && row.checkpoint_state_revision === row.after_state_revision
      && row.checkpoint_state_hash === row.after_state_hash
      && row.snapshot_state_revision === row.after_state_revision
      && row.snapshot_state_hash === row.after_state_hash;
    if (!matches) {
      fail('COMMIT_RECOVERY_CONSISTENCY_FAULT', 'persisted commit does not match its recovery envelope');
    }
    const outboxCount = connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM room_outbox AS o
      JOIN room_events AS e ON e.event_id = o.event_id
       WHERE e.turn_id = ? AND e.event_type IN (
         'action.revealed_after_commit', 'turn.committed'
       )
    `).get(job.turn_id).count);
    if (outboxCount !== 2) {
      fail('COMMIT_RECOVERY_CONSISTENCY_FAULT', 'committed turn has an incomplete transactional outbox');
    }
    return Object.freeze({
      status: 'COMMITTED',
      receipt: Object.freeze({
        replayed: true,
        commit_id: row.commit_id,
        turn_id: row.turn_id,
        checkpoint_id: row.checkpoint_id,
        state_revision: row.after_state_revision,
        state_hash: row.after_state_hash,
        snapshot_id: row.snapshot_ref,
        committed_at: row.committed_at
      })
    });
  }

  async function recordProgress({ run_id, turn_id, lease_fence, model_stage, attempt }) {
    const status = MODEL_PROGRESS_STATUSES[model_stage];
    if (!status) fail('TURN_PROGRESS_STAGE_INVALID', 'unknown model stage');
    revision(attempt, 'attempt');
    const updatedAt = timestamp(clock());
    await connection.write(database => {
      const run = database.prepare(`
        SELECT r.*, t.turn_status FROM resolution_runs r
        JOIN multiplayer_turns t ON t.turn_id = r.turn_id
        WHERE r.run_id = ? AND r.turn_id = ? AND r.lease_fence = ? AND r.run_status = 'RUNNING'
      `).get(run_id, turn_id, lease_fence);
      if (!run) fail('STALE_LEASE_FENCE', 'progress belongs to an inactive worker');
      if (['COMMITTED', 'TURN_VOIDED', 'VOID_REQUESTED', 'CONSISTENCY_FAULT'].includes(run.turn_status)) {
        fail('TURN_STAGE_CONFLICT', 'cannot publish generation progress for a closed turn');
      }
      database.prepare('UPDATE multiplayer_turns SET turn_status = ?, updated_at = ? WHERE turn_id = ?')
        .run(status, updatedAt, turn_id);
      const room = database.prepare(`
        UPDATE multiplayer_rooms SET event_seq = event_seq + 2, updated_at = ?
         WHERE room_id = ? AND current_turn_id = ? AND active_epoch_id = ? AND lifecycle = 'ACTIVE'
         RETURNING event_seq
      `).get(updatedAt, run.room_id, turn_id, run.epoch_id);
      if (!room) fail('TURN_STAGE_CONFLICT', 'generation progress is outside the active room');
      insertPauseEvents(database, {
        run, endEventSeq: room.event_seq, status, reason: null, resumeStage: null,
        errorCode: null, detail: null, createdAt: updatedAt, idFactory,
        progress: { model_stage, attempt, started_at: run.created_at, run_status: 'RUNNING' }
      });
    });
  }

  async function recordPause({
    run_id,
    turn_id,
    lease_fence,
    reason,
    resume_stage,
    error_code,
    detail = null,
    paused_at
  }) {
    requireProductionPorts();
    const projectedDetail = safePauseDetail(detail);
    const run = connection.read(database => database.prepare(`
      SELECT r.run_id, r.room_id, r.epoch_id, r.turn_id, r.turn_no,
             r.lease_fence, t.turn_status
        FROM resolution_runs AS r
        JOIN multiplayer_turns AS t ON t.turn_id = r.turn_id
       WHERE r.run_id = ?
    `).get(run_id));
    if (!run) fail('RUN_NOT_FOUND', 'workflow pause run does not exist', {}, 404);
    if (turn_id !== null && turn_id !== run.turn_id) {
      fail('TURN_STAGE_CONFLICT', 'workflow pause turn does not match its run');
    }
    if (run.lease_fence !== lease_fence) {
      fail('STALE_LEASE_FENCE', 'workflow pause uses a stale lease fence');
    }
    const sessionRow = connection.read(database => database.prepare(`
      SELECT continuity_session_id FROM agent_stage_sessions
       WHERE run_id = ? AND stage = 'continuity' AND audience = 'none'
    `).get(run_id));
    const billingPause = reason === 'BILLING_AUTHORIZATION_REQUIRED'
      || reason === 'BILLING_BUDGET_EXHAUSTED'
      || reason === 'DATA_PROCESSING_CONSENT_REQUIRED'
      || reason === 'EXECUTION_GRANT_REQUIRED';
    let repairPaused = false;
    if (sessionRow) {
      const session = continuityRepository.loadSession({
        run_id,
        continuity_session_id: sessionRow.continuity_session_id
      });
      if (session.draft.status !== 'READY' && session.session_status !== 'PAUSED') {
        repairPaused = true;
        await continuityRepository.pauseSession({
          run_id,
          continuity_session_id: sessionRow.continuity_session_id,
          lease_fence,
          pause_reason: billingPause
            ? 'BILLING_AUTHORIZATION_REQUIRED'
            : (reason === 'LOOP_BREAKER' ? 'LOOP_BREAKER' : 'RECOVERABLE_RUNTIME_FAULT'),
          resume_stage: session.draft.expected_operation === 'repair_turn_bundle'
            ? 'REPAIRING_DRAFT'
            : 'STAGING_UPDATES',
          paused_at
        });
      } else if (session.session_status === 'PAUSED') repairPaused = true;
    }
    const nextStatus = billingPause
      ? 'AWAITING_BILLING_AUTHORIZATION'
      : (repairPaused ? 'REPAIR_PAUSED' : 'RETRYABLE_FAILED');
    await connection.write(database => {
      const changed = database.prepare(`
        UPDATE multiplayer_turns SET turn_status = ?, updated_at = ?
         WHERE turn_id = ? AND turn_status NOT IN (
           'COMMITTED', 'TURN_VOIDED', 'CONSISTENCY_FAULT'
         )
      `).run(nextStatus, paused_at, run.turn_id);
      if (changed.changes !== 1) {
        fail('TURN_STAGE_CONFLICT', 'turn could not persist its workflow pause', { error_code });
      }
      const room = database.prepare(`
        UPDATE multiplayer_rooms
           SET event_seq = event_seq + 2, updated_at = ?
         WHERE room_id = ? AND active_epoch_id = ? AND current_turn_id = ?
           AND lifecycle != 'ARCHIVED'
        RETURNING event_seq
      `).get(paused_at, run.room_id, run.epoch_id, run.turn_id);
      if (!room) fail('TURN_STAGE_CONFLICT', 'room could not publish its workflow pause');
      insertPauseEvents(database, {
        run,
        endEventSeq: room.event_seq,
        status: nextStatus,
        reason,
        resumeStage: resume_stage,
        errorCode: error_code,
        detail: projectedDetail,
        createdAt: paused_at,
        idFactory
      });
    });
  }

  async function retry({
    authenticated_user_id,
    room_id,
    epoch_id,
    turn_id,
    expected_control_revision
  }) {
    const userId = principal(authenticated_user_id);
    const roomId = identifier(room_id, 'room_id');
    const epochId = identifier(epoch_id, 'epoch_id');
    const turnId = identifier(turn_id, 'turn_id');
    const expectedControlRevision = revision(
      expected_control_revision,
      'expected_control_revision'
    );
    const queuedAt = timestamp(clock());
    return connection.write(database => {
      const member = requireMember(database, roomId, userId);
      if (member.active_epoch_id !== epochId || member.current_turn_id !== turnId) {
        fail('TURN_NOT_FOUND', 'retry must target the active room turn', {}, 404);
      }
      if (member.control_revision !== expectedControlRevision) {
        fail('STALE_CONTROL_REVISION', 'room control revision changed before retry', {
          expected: expectedControlRevision,
          actual: member.control_revision
        }, 409);
      }
      const turn = database.prepare(`
        SELECT turn_id, room_id, epoch_id, turn_no, turn_status
          FROM multiplayer_turns
         WHERE turn_id = ? AND room_id = ? AND epoch_id = ?
      `).get(turnId, roomId, epochId);
      if (!turn) fail('TURN_NOT_FOUND', 'retry target does not exist', {}, 404);
      if (!RETRYABLE_TURN_STATUSES.has(turn.turn_status)) {
        fail('TURN_RETRY_NOT_ALLOWED', 'turn is not in a retryable or paused state', {
          turn_status: turn.turn_status
        }, 409);
      }
      const unresolved = database.prepare(`
        SELECT invocation_id, usage_status
          FROM ai_usage_ledger
         WHERE turn_id = ? AND usage_status IN ('IN_FLIGHT', 'UNKNOWN')
         ORDER BY started_at LIMIT 1
      `).get(turnId);
      if (unresolved) {
        fail(
          'MODEL_INVOCATION_UNRESOLVED',
          'an in-flight or unknown invocation must be resolved before retry',
          {
            invocation_id: unresolved.invocation_id,
            usage_status: unresolved.usage_status
          },
          409
        );
      }
      const run = database.prepare(`
        SELECT * FROM resolution_runs
         WHERE turn_id = ?
         ORDER BY created_at DESC, run_id DESC LIMIT 1
      `).get(turnId);
      if (!run) fail('RUN_NOT_FOUND', 'turn has no durable resolution run', {}, 404);
      if (run.run_status === 'QUEUED') {
        return immutable({
          room_id: roomId,
          epoch_id: epochId,
          turn_id: turnId,
          run_id: run.run_id,
          run_status: 'QUEUED',
          turn_status: turn.turn_status,
          control_revision: member.control_revision,
          replayed: true
        });
      }
      if (['CLAIMED', 'RUNNING'].includes(run.run_status)) {
        fail('RUN_ALREADY_ACTIVE', 'the resolution run is already active', {}, 409);
      }
      if (!RETRYABLE_RUN_STATUSES.has(run.run_status)) {
        fail('TURN_RETRY_NOT_ALLOWED', 'resolution run cannot be re-queued', {
          run_status: run.run_status
        }, 409);
      }
      const changedRun = database.prepare(`
        UPDATE resolution_runs
           SET run_status = 'QUEUED', owner_boot_id = NULL,
               owner_task_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
               lease_expires_at = NULL, updated_at = ?
         WHERE run_id = ? AND run_status = ?
      `).run(queuedAt, run.run_id, run.run_status);
      if (changedRun.changes !== 1) fail('TURN_RETRY_CAS_FAILED', 'resolution run changed');
      const nextControlRevision = member.control_revision + 1;
      const room = database.prepare(`
        UPDATE multiplayer_rooms
           SET control_revision = ?, event_seq = event_seq + 2, updated_at = ?
         WHERE room_id = ? AND active_epoch_id = ? AND current_turn_id = ?
           AND control_revision = ? AND lifecycle != 'ARCHIVED'
        RETURNING event_seq
      `).get(
        nextControlRevision,
        queuedAt,
        roomId,
        epochId,
        turnId,
        expectedControlRevision
      );
      if (!room) fail('TURN_RETRY_CAS_FAILED', 'room changed while scheduling retry', {}, 409);
      const epoch = database.prepare(`
        UPDATE room_epochs SET control_revision = ?
         WHERE epoch_id = ? AND room_id = ? AND epoch_state = 'ACTIVE'
      `).run(nextControlRevision, epochId, roomId);
      if (epoch.changes !== 1) {
        fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'active epoch control revision did not advance');
      }
      insertRetryEvents(database, {
        roomId,
        epochId,
        turn,
        endEventSeq: room.event_seq,
        controlRevision: nextControlRevision,
        createdAt: queuedAt,
        idFactory
      });
      return immutable({
        room_id: roomId,
        epoch_id: epochId,
        turn_id: turnId,
        run_id: run.run_id,
        run_status: 'QUEUED',
        turn_status: turn.turn_status,
        control_revision: nextControlRevision,
        replayed: false
      });
    });
  }

  return Object.freeze({
    load,
    checkpointInvocation,
    prepareResolution,
    adoptResolution,
    prepareNarrative,
    adoptNarrative,
    prepareContinuity,
    createBoundContinuityContext,
    prepareCommit,
    recoverCommit,
    recordPause,
    recordProgress,
    retry
  });
}

export { RETRYABLE_RUN_STATUSES, RETRYABLE_TURN_STATUSES };
