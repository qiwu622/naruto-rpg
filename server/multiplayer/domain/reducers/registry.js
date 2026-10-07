import { canonicalStringify, canonicalizeJson, sha256Hex } from '../canonical-json.js';
import { EFFECT_HASH_MATERIAL_SCHEMA } from '../effect-dag.js';
import { assertMultiplayerRoomState } from '../../contracts/state-contracts.js';
import {
  ACTOR_EFFECT_CONTRACTS,
  assertActorAttributes,
  assertActorProfile,
  assertActorProgression
} from './actor.js';
import {
  assertActorItems,
  assertActorSkills,
  itemEffectInputContract,
  SKILL_ITEM_EFFECT_CONTRACTS
} from './skill-item.js';
import {
  assertWorldCalendar,
  assertWorldMap,
  assertWorldState,
  WORLD_EFFECT_CONTRACTS
} from './world.js';
import { assertMissionCollection, MISSION_EFFECT_CONTRACTS } from './mission.js';
import {
  assertCombatCollection,
  assertEventCollection,
  COMBAT_EVENT_EFFECT_CONTRACTS
} from './combat-event.js';
import {
  assertRelationshipEdges,
  RELATIONSHIP_EFFECT_CONTRACTS
} from './relationship.js';
import {
  assertArray,
  assertExactObject,
  assertIdentifier,
  assertInteger,
  assertRecord,
  assertString,
  compareText,
  fail,
  immutableCanonical,
  INTEGRITY_POLICY_HASH
} from './shared.js';

export const DOMAIN_REDUCER_REGISTRY_SCHEMA = 'naruto.multiplayer-domain-reducer-registry/v1';
export const DOMAIN_REDUCER_EXECUTION_SCHEMA = 'naruto.multiplayer-domain-reducer-execution/v1';

const SEMANTIC_EFFECT_FIELDS = Object.freeze([
  'effect_id',
  'depends_on_effect_ids',
  'event_id',
  'target',
  'domain',
  'kind',
  'operation',
  'payload',
  'provenance',
  'visibility',
  'evidence_event_ids'
]);
const OPTIONAL_SEMANTIC_EFFECT_FIELDS = Object.freeze(['summary', 'unit', 'rule_refs']);
const COMPILED_EFFECT_FIELDS = Object.freeze([
  'effect_seq',
  'required_reducer',
  'reducer_version',
  'effect_hash'
]);

const CONTRACTS = Object.freeze([
  ...ACTOR_EFFECT_CONTRACTS,
  ...SKILL_ITEM_EFFECT_CONTRACTS,
  ...WORLD_EFFECT_CONTRACTS,
  ...MISSION_EFFECT_CONTRACTS,
  ...RELATIONSHIP_EFFECT_CONTRACTS,
  ...COMBAT_EVENT_EFFECT_CONTRACTS
]);

const contractBySelector = new Map();
for (const contract of CONTRACTS) {
  for (const operation of contract.operations) {
    const selector = `${contract.domain}\u0000${contract.kind}\u0000${operation}`;
    if (contractBySelector.has(selector)) {
      throw new Error(`Duplicate multiplayer effect contract: ${selector}`);
    }
    contractBySelector.set(selector, contract);
  }
}

export const DOMAIN_REDUCER_REGISTRY = immutableCanonical({
  schema: DOMAIN_REDUCER_REGISTRY_SCHEMA,
  integrity_policy_hash: INTEGRITY_POLICY_HASH,
  effects: CONTRACTS.flatMap(contract => contract.operations.map(operation => ({
    domain: contract.domain,
    kind: contract.kind,
    operation,
    required_reducer: contract.reducerKey,
    reducer_version: contract.reducerVersion
  }))).sort((left, right) => compareText(
    `${left.domain}/${left.kind}/${left.operation}`,
    `${right.domain}/${right.kind}/${right.operation}`
  ))
});

function assertEffectEnvelope(effect, compiled) {
  assertExactObject(effect, {
    label: 'typed effect',
    allowed: [
      ...SEMANTIC_EFFECT_FIELDS,
      ...OPTIONAL_SEMANTIC_EFFECT_FIELDS,
      ...(compiled ? COMPILED_EFFECT_FIELDS : [])
    ],
    required: [
      ...SEMANTIC_EFFECT_FIELDS,
      ...(compiled ? COMPILED_EFFECT_FIELDS : [])
    ],
    code: 'INVALID_EFFECT_CONTRACT'
  });
  assertIdentifier(effect.effect_id, 'effect.effect_id', {
    prefixes: ['effect_'],
    code: 'INVALID_EFFECT_CONTRACT'
  });
  assertArray(effect.depends_on_effect_ids, 'effect.depends_on_effect_ids', {
    max: 256,
    item: (id, label) => assertIdentifier(id, label, {
      prefixes: ['effect_'],
      code: 'INVALID_EFFECT_CONTRACT'
    }),
    uniqueBy: id => id,
    code: 'INVALID_EFFECT_CONTRACT'
  });
  assertIdentifier(effect.event_id, 'effect.event_id', {
    prefixes: ['event_'],
    code: 'INVALID_EFFECT_CONTRACT'
  });
  assertRecord(effect.target, 'effect.target');
  assertRecord(effect.payload, 'effect.payload');
  for (const field of ['domain', 'kind', 'operation', 'provenance']) {
    assertString(effect[field], `effect.${field}`, { max: 160, code: 'INVALID_EFFECT_CONTRACT' });
  }
  if (effect.visibility !== 'server_only') {
    fail('INVALID_EFFECT_CONTRACT', 'typed effects must remain server_only');
  }
  assertArray(effect.evidence_event_ids, 'effect.evidence_event_ids', {
    min: 1,
    max: 256,
    item: (id, label) => assertIdentifier(id, label, {
      prefixes: ['event_'],
      code: 'INVALID_EFFECT_CONTRACT'
    }),
    uniqueBy: id => id,
    code: 'INVALID_EFFECT_CONTRACT'
  });
  if (!effect.evidence_event_ids.includes(effect.event_id)) {
    fail('INVALID_EFFECT_CONTRACT', 'effect evidence must include event_id');
  }
  if (compiled) {
    assertInteger(effect.effect_seq, 'effect.effect_seq', {
      min: 1,
      code: 'INVALID_EFFECT_CONTRACT'
    });
    assertString(effect.required_reducer, 'effect.required_reducer', {
      pattern: /^[a-z][a-z0-9_]*$/,
      code: 'INVALID_EFFECT_CONTRACT'
    });
    assertString(effect.reducer_version, 'effect.reducer_version', {
      max: 160,
      code: 'INVALID_EFFECT_CONTRACT'
    });
    assertString(effect.effect_hash, 'effect.effect_hash', {
      pattern: /^sha256:[a-f0-9]{64}$/,
      code: 'INVALID_EFFECT_CONTRACT'
    });
  }
}

function findContract(effect) {
  const contract = contractBySelector.get(`${effect.domain}\u0000${effect.kind}\u0000${effect.operation}`);
  if (!contract) {
    fail('INVALID_EFFECT_CONTRACT', 'typed effect has no registered domain contract', {
      domain: effect.domain,
      kind: effect.kind,
      operation: effect.operation
    });
  }
  contract.validate(effect);
  return contract;
}

/**
 * Intended for `compileEffectDag({ resolveReducer })`. It validates the fixed
 * target/payload contract before binding the only legal internal reducer.
 */
export function resolveDomainReducer(effect) {
  const detached = canonicalizeJson(effect);
  assertEffectEnvelope(detached, false);
  const contract = findContract(detached);
  return Object.freeze({
    required_reducer: contract.reducerKey,
    reducer_version: contract.reducerVersion
  });
}

function semanticEffectOf(compiledEffect) {
  const semantic = {};
  for (const field of [...SEMANTIC_EFFECT_FIELDS, ...OPTIONAL_SEMANTIC_EFFECT_FIELDS]) {
    if (Object.prototype.hasOwnProperty.call(compiledEffect, field)) semantic[field] = compiledEffect[field];
  }
  return canonicalizeJson(semantic);
}

function verifyCompiledHash(effect, ruleSnapshot, contract) {
  if (
    effect.required_reducer !== contract.reducerKey ||
    effect.reducer_version !== contract.reducerVersion
  ) {
    fail('INVALID_EFFECT_CONTRACT', 'effect reducer binding does not match the fixed registry', {
      expected_reducer: contract.reducerKey,
      actual_reducer: effect.required_reducer,
      expected_version: contract.reducerVersion,
      actual_version: effect.reducer_version
    });
  }
  const expectedHash = `sha256:${sha256Hex({
    schema: EFFECT_HASH_MATERIAL_SCHEMA,
    effect: semanticEffectOf(effect),
    binding: {
      required_reducer: contract.reducerKey,
      reducer_version: contract.reducerVersion
    },
    rule_snapshot: ruleSnapshot
  })}`;
  if (effect.effect_hash !== expectedHash) {
    fail('EFFECT_HASH_MISMATCH', 'compiled effect hash does not match its frozen semantics', {
      effect_id: effect.effect_id,
      expected_effect_hash: expectedHash,
      actual_effect_hash: effect.effect_hash
    });
  }
}

export function assertReducerDomainState(candidate) {
  const state = assertMultiplayerRoomState(candidate);
  for (const seat of ['A', 'B']) {
    const actor = state.actors[seat];
    assertActorProfile(actor.player, `actors.${seat}.player`);
    assertActorAttributes(actor.attributes, `actors.${seat}.attributes`);
    assertActorProgression(actor.progression, `actors.${seat}.progression`);
    assertActorSkills(actor.skills, `actors.${seat}.skills`);
    assertActorItems(actor.equipment, `actors.${seat}.equipment`);
    assertMissionCollection(actor.missions, `actors.${seat}.missions`);
    for (const mission of actor.missions.entries) {
      if (mission.scope !== `actor:${seat}`) {
        fail('INVALID_CANDIDATE_STATE', 'actor mission is stored outside its declared scope', {
          mission_id: mission.mission_id,
          expected_scope: `actor:${seat}`,
          actual_scope: mission.scope
        });
      }
    }
  }
  assertWorldState(state.shared_world.world_state);
  assertWorldCalendar(state.shared_world.calendar);
  assertWorldMap(state.shared_world.map);
  assertEventCollection(state.shared_world.canonical_events);
  assertMissionCollection(state.shared_world.shared_missions);
  for (const mission of state.shared_world.shared_missions.entries) {
    if (mission.scope !== 'shared') {
      fail('INVALID_CANDIDATE_STATE', 'shared mission has a non-shared scope', {
        mission_id: mission.mission_id,
        actual_scope: mission.scope
      });
    }
  }
  assertCombatCollection(state.shared_world.shared_combat);
  assertRelationshipEdges(state);

  const knownEntityIds = new Set([
    state.actors.A.room_actor_id,
    state.actors.B.room_actor_id,
    ...state.shared_world.world_state.npc_profiles.map(profile => profile.npc_id)
  ]);
  const knownActorIds = new Set([
    state.actors.A.room_actor_id,
    state.actors.B.room_actor_id
  ]);
  const allMissionCollections = [
    state.shared_world.shared_missions,
    state.actors.A.missions,
    state.actors.B.missions
  ];
  for (const collection of allMissionCollections) {
    for (const mission of collection.entries) {
      for (const assigneeId of mission.assignee_actor_ids) {
        if (!knownActorIds.has(assigneeId)) {
          fail('INVALID_CANDIDATE_STATE', 'mission contains a dangling actor assignee', {
            mission_id: mission.mission_id,
            assignee_actor_id: assigneeId
          });
        }
      }
    }
  }
  for (const location of state.shared_world.world_state.locations) {
    if (!knownEntityIds.has(location.entity_id)) {
      fail('INVALID_CANDIDATE_STATE', 'world location contains a dangling entity', {
        entity_id: location.entity_id
      });
    }
  }
  for (const edge of state.relationships) {
    if (!knownEntityIds.has(edge.source_actor_id) || !knownEntityIds.has(edge.target_actor_id)) {
      fail('INVALID_CANDIDATE_STATE', 'relationship edge contains a dangling endpoint', {
        edge_id: edge.edge_id
      });
    }
  }
  for (const combat of state.shared_world.shared_combat.entries) {
    for (const participant of combat.participants) {
      if (!knownEntityIds.has(participant.participant_id)) {
        fail('INVALID_CANDIDATE_STATE', 'combat contains a dangling participant', {
          combat_id: combat.combat_id,
          participant_id: participant.participant_id
        });
      }
    }
  }
  return state;
}

function stateSlices(state) {
  return {
    meta: state.meta,
    world_state: state.shared_world.world_state,
    calendar: state.shared_world.calendar,
    map: state.shared_world.map,
    events: state.shared_world.canonical_events,
    shared_missions: state.shared_world.shared_missions,
    combat: state.shared_world.shared_combat,
    continuity_ledger: state.shared_world.continuity_ledger,
    'actor:A:id': state.actors.A.room_actor_id,
    'actor:A:profile': state.actors.A.player,
    'actor:A:resources': state.actors.A.attributes,
    'actor:A:progression': state.actors.A.progression,
    'actor:A:skills': state.actors.A.skills,
    'actor:A:items': state.actors.A.equipment,
    'actor:A:missions': state.actors.A.missions,
    'actor:A:private': state.actors.A.private_knowledge,
    'actor:B:id': state.actors.B.room_actor_id,
    'actor:B:profile': state.actors.B.player,
    'actor:B:resources': state.actors.B.attributes,
    'actor:B:progression': state.actors.B.progression,
    'actor:B:skills': state.actors.B.skills,
    'actor:B:items': state.actors.B.equipment,
    'actor:B:missions': state.actors.B.missions,
    'actor:B:private': state.actors.B.private_knowledge,
    relationships: state.relationships,
    memories: state.memories,
    agent_internal: state.agent_internal
  };
}

function actorSeatForId(state, actorId) {
  if (state.actors.A.room_actor_id === actorId) return 'A';
  if (state.actors.B.room_actor_id === actorId) return 'B';
  fail('EFFECT_TARGET_NOT_FOUND', 'actor target does not exist', { actor_id: actorId });
}

function allowedMutationSlices(base, effect) {
  const seat = effect.target.actor_id ? actorSeatForId(base, effect.target.actor_id) : null;
  if (effect.domain === 'actor_profile') return new Set([`actor:${seat}:profile`]);
  if (effect.domain === 'actor_resource') return new Set([`actor:${seat}:resources`]);
  if (effect.domain === 'actor_progression') return new Set([`actor:${seat}:progression`]);
  if (effect.domain === 'skill') return new Set([`actor:${seat}:skills`]);
  if (effect.domain === 'item') return new Set([`actor:${seat}:items`]);
  if (effect.domain === 'calendar') return new Set(['calendar']);
  if (effect.domain === 'world') {
    return new Set([effect.kind === 'map_marker' ? 'map' : 'world_state']);
  }
  if (effect.domain === 'mission') {
    return new Set([
      effect.target.mission_scope === 'shared'
        ? 'shared_missions'
        : `${effect.target.mission_scope}:missions`
    ]);
  }
  if (effect.domain === 'combat') return new Set(['combat']);
  if (effect.domain === 'event') return new Set(['events']);
  if (effect.domain === 'relationship' && effect.kind === 'edge') return new Set(['relationships']);
  if (effect.domain === 'relationship' && effect.operation === 'rename') {
    return new Set(['world_state', 'relationships', 'memories', 'combat']);
  }
  return new Set(['world_state']);
}

function stripRenameCaches(state) {
  const detached = canonicalizeJson(state);
  for (const edge of detached.relationships) {
    delete edge.data.source_display_name;
    delete edge.data.target_display_name;
  }
  for (const combat of detached.shared_world.shared_combat.entries) {
    for (const participant of combat.participants) delete participant.display_name;
  }
  for (const partitionName of ['canonical', 'shared', 'actor:A', 'actor:B', 'npc_private']) {
    const entries = detached.memories[partitionName]?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        delete entry.subject_display_names;
      }
    }
  }
  return detached;
}

function assertMutationBoundary(base, next, effect) {
  const beforeSlices = stateSlices(base);
  const afterSlices = stateSlices(next);
  const allowed = allowedMutationSlices(base, effect);
  for (const key of Object.keys(beforeSlices)) {
    if (allowed.has(key)) continue;
    if (canonicalStringify(beforeSlices[key]) !== canonicalStringify(afterSlices[key])) {
      fail('REDUCER_DOMAIN_BOUNDARY_VIOLATION', 'domain reducer modified an unowned state slice', {
        effect_id: effect.effect_id,
        state_slice: key
      });
    }
  }
  if (effect.domain === 'relationship' && effect.operation === 'rename') {
    const beforeStripped = stripRenameCaches(base);
    const afterStripped = stripRenameCaches(next);
    // The primary NPC profile version, display name and evidence are allowed.
    const npcId = effect.target.npc_id;
    const scrubPrimary = value => {
      const npc = value.shared_world.world_state.npc_profiles.find(profile => profile.npc_id === npcId);
      if (npc) {
        delete npc.version;
        delete npc.display_name;
        delete npc.evidence_event_ids;
      }
      return value;
    };
    if (
      canonicalStringify(scrubPrimary(beforeStripped)) !==
      canonicalStringify(scrubPrimary(afterStripped))
    ) {
      fail('SYSTEM_DERIVED_POLICY_VIOLATION', 'NPC rename changed gameplay semantics outside its primary profile');
    }
  }
}

function assertSystemDerivedReceipt(receipt, effect) {
  if (!Array.isArray(receipt.system_derived)) {
    fail('INVALID_REDUCER_RECEIPT', 'system_derived receipt material must be an array');
  }
  const isNpcRename =
    effect.domain === 'relationship' &&
    effect.kind === 'npc_profile' &&
    effect.operation === 'rename';
  if (!isNpcRename && receipt.system_derived.length !== 0) {
    fail('SYSTEM_DERIVED_POLICY_VIOLATION', 'system_derived operations are not allowed for this effect');
  }
  const seen = new Set();
  for (const operation of receipt.system_derived) {
    assertExactObject(operation, {
      label: 'system_derived operation',
      allowed: [
        'policy_id',
        'policy_version',
        'operation',
        'target',
        'before',
        'after'
      ],
      code: 'INVALID_REDUCER_RECEIPT'
    });
    if (
      operation.policy_id !== 'npc-display-name-cache-refresh' ||
      operation.policy_version !== '1' ||
      operation.operation !== 'refresh_display_name_cache'
    ) {
      fail('SYSTEM_DERIVED_POLICY_VIOLATION', 'system_derived operation is not enumerated by policy');
    }
    assertExactObject(operation.target, {
      label: 'system_derived target',
      allowed: ['cache_type', 'owner_id', 'subject_id'],
      code: 'INVALID_REDUCER_RECEIPT'
    });
    assertString(operation.target.cache_type, 'system_derived target.cache_type', {
      enumValues: [
        'relationship_display_name_cache',
        'memory_subject_display_name_cache',
        'combat_participant_display_name_cache'
      ],
      code: 'INVALID_REDUCER_RECEIPT'
    });
    if (operation.target.subject_id !== effect.target.npc_id) {
      fail('SYSTEM_DERIVED_POLICY_VIOLATION', 'system_derived target is not the renamed NPC');
    }
    for (const side of ['before', 'after']) {
      assertExactObject(operation[side], {
        label: `system_derived ${side}`,
        allowed: ['display_name'],
        code: 'INVALID_REDUCER_RECEIPT'
      });
    }
    if (
      operation.before.display_name !== effect.payload.from_display_name ||
      operation.after.display_name !== effect.payload.to_display_name
    ) {
      fail('SYSTEM_DERIVED_POLICY_VIOLATION', 'system_derived cache value does not match the rename');
    }
    const identity = canonicalStringify(operation.target);
    if (seen.has(identity)) {
      fail('INVALID_REDUCER_RECEIPT', 'system_derived receipt contains a duplicate target');
    }
    seen.add(identity);
  }
}

/**
 * Pure deterministic execution entry point. No room/run IDs, services,
 * clocks, random sources, database handles or I/O callbacks are accepted.
 */
export function reduceDomainEffect(baseCandidate, frozenEffect, ruleSnapshot) {
  const beforeBytes = canonicalStringify(baseCandidate);
  const effect = immutableCanonical(frozenEffect);
  const rules = immutableCanonical(ruleSnapshot);
  assertRecord(rules, 'ruleSnapshot');
  assertEffectEnvelope(effect, true);
  const contract = findContract(effect);
  verifyCompiledHash(effect, rules, contract);
  const base = assertReducerDomainState(baseCandidate);
  const result = contract.reduce(base, effect, rules);
  const next = assertReducerDomainState(result.nextCandidate);
  assertMutationBoundary(base, next, effect);
  if (canonicalStringify(baseCandidate) !== beforeBytes) {
    fail('IMPURE_REDUCER_MUTATION', 'domain reducer mutated its input candidate');
  }
  const receipt = result.normalizedOperations[0];
  if (
    receipt.required_reducer !== contract.reducerKey ||
    receipt.reducer_version !== contract.reducerVersion ||
    receipt.effect_hash !== effect.effect_hash
  ) {
    fail('INVALID_REDUCER_RECEIPT', 'domain reducer returned a receipt with the wrong binding');
  }
  assertSystemDerivedReceipt(receipt, effect);
  return result;
}

export function inspectDomainEffect(effect, { compiled = false } = {}) {
  try {
    const detached = canonicalizeJson(effect);
    assertEffectEnvelope(detached, compiled);
    const contract = findContract(detached);
    return {
      valid: true,
      errors: [],
      binding: {
        required_reducer: contract.reducerKey,
        reducer_version: contract.reducerVersion
      }
    };
  } catch (error) {
    if (!error || typeof error.code !== 'string') throw error;
    return {
      valid: false,
      errors: [{
        code: error.code,
        message: error.message,
        details: {
          ...error.details,
          ...(effect?.domain === 'item' && effect?.kind === 'actor_item' && itemEffectInputContract(effect.operation)
            ? { effect_id: effect.effect_id, expected_input_contract: itemEffectInputContract(effect.operation) } : {})
        }
      }],
      binding: null
    };
  }
}
