import assert from 'node:assert/strict';

import { compileEffectDag } from '../server/multiplayer/domain/effect-dag.js';
import {
  ACTOR_ATTRIBUTES_SCHEMA,
  ACTOR_ITEMS_SCHEMA,
  ACTOR_PROFILE_SCHEMA,
  ACTOR_PROGRESSION_SCHEMA,
  ACTOR_SKILLS_SCHEMA,
  COMBAT_COLLECTION_SCHEMA,
  DOMAIN_REDUCER_REGISTRY,
  EVENT_COLLECTION_SCHEMA,
  INTEGRITY_POLICY_HASH,
  MISSION_COLLECTION_SCHEMA,
  WORLD_CALENDAR_SCHEMA,
  WORLD_MAP_SCHEMA,
  WORLD_STATE_SCHEMA,
  assertReducerDomainState,
  reduceDomainEffect,
  resolveDomainReducer
} from '../server/multiplayer/domain/reducers/index.js';
import { MULTIPLAYER_ROOM_STATE_SCHEMA } from '../server/multiplayer/contracts/state-contracts.js';

const RULE_SNAPSHOT = Object.freeze({
  schema: 'naruto.multiplayer-rule-snapshot/v1',
  revision: 1,
  reducer_registry_hash: INTEGRITY_POLICY_HASH
});

let passed = 0;
let effectCounter = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function expectCode(code) {
  return error => error?.code === code;
}

function profile(displayName) {
  return {
    schema: ACTOR_PROFILE_SCHEMA,
    version: 0,
    display_name: displayName,
    rank: '下忍',
    goal: '完成当前任务',
    alive: true,
    status: 'ACTIVE'
  };
}

function attributes() {
  return {
    schema: ACTOR_ATTRIBUTES_SCHEMA,
    resources: [
      { resource_id: 'chakra', version: 0, current: 40, maximum: 100 },
      { resource_id: 'money', version: 0, current: 1_000, maximum: 1_000_000 },
      { resource_id: 'vitality', version: 0, current: 80, maximum: 100 }
    ],
    injuries: [],
    persistent_statuses: []
  };
}

function progression() {
  return {
    schema: ACTOR_PROGRESSION_SCHEMA,
    version: 0,
    experience: 0,
    level: 1,
    reputation: 0,
    titles: [],
    achievements: []
  };
}

function actor(actorId, displayName, seat) {
  return {
    room_actor_id: actorId,
    player: profile(displayName),
    attributes: attributes(),
    progression: progression(),
    skills: { schema: ACTOR_SKILLS_SCHEMA, entries: [] },
    equipment: { schema: ACTOR_ITEMS_SCHEMA, entries: [] },
    missions: { schema: MISSION_COLLECTION_SCHEMA, entries: [] },
    private_knowledge: { seat, facts: [] }
  };
}

function baseState() {
  return {
    schema: MULTIPLAYER_ROOM_STATE_SCHEMA,
    meta: { state_revision: 7 },
    shared_world: {
      world_state: {
        schema: WORLD_STATE_SCHEMA,
        locations: [],
        weather: [],
        flags: [],
        npc_profiles: [{
          npc_id: 'npc:guide',
          version: 1,
          display_name: '旧名',
          faction: '木叶',
          rank: '中忍',
          public_status: 'ACTIVE',
          evidence_event_ids: ['event_npc_known']
        }]
      },
      calendar: {
        schema: WORLD_CALENDAR_SCHEMA,
        calendar_id: 'calendar:main',
        version: 0,
        ordinal_minutes: 100,
        display_date: '木叶48年3月12日 上午',
        phase: 'DAY'
      },
      map: { schema: WORLD_MAP_SCHEMA, markers: [] },
      canonical_events: { schema: EVENT_COLLECTION_SCHEMA, entries: [] },
      shared_missions: { schema: MISSION_COLLECTION_SCHEMA, entries: [] },
      shared_combat: {
        schema: COMBAT_COLLECTION_SCHEMA,
        entries: [{
          combat_id: 'combat:rename-cache',
          version: 2,
          phase: 'ACTIVE',
          participants: [
            { participant_id: 'actor:A', display_name: '甲', status: 'ACTIVE' },
            { participant_id: 'npc:guide', display_name: '旧名', status: 'ACTIVE' }
          ],
          action_log: [],
          winner_ids: [],
          resolution_summary: null
        }]
      },
      continuity_ledger: { revision: 0 }
    },
    actors: {
      A: actor('actor:A', '甲', 'A'),
      B: actor('actor:B', '乙', 'B')
    },
    relationships: [{
      edge_id: 'relationship:guide-A',
      source_actor_id: 'npc:guide',
      target_actor_id: 'actor:A',
      data: {
        version: 1,
        kind: 'ALLY',
        score: 25,
        label: '向导',
        evidence_event_ids: ['event_relationship_known'],
        source_display_name: '旧名',
        target_display_name: '甲'
      }
    }],
    memories: {
      canonical: {
        entries: [{
          memory_id: 'memory:guide',
          fact: '向导曾在东门接应。',
          audience: 'canonical',
          subject_display_names: [{ subject_id: 'npc:guide', display_name: '旧名' }]
        }]
      },
      shared: { entries: [] },
      'actor:A': { entries: [] },
      'actor:B': { entries: [] },
      npc_private: { entries: [] }
    },
    agent_internal: {
      story_plan: {},
      audit_state: {}
    }
  };
}

function effect(spec, overrides = {}) {
  effectCounter += 1;
  const effectId = `effect_reducer_${effectCounter}`;
  const eventId = `event_reducer_${effectCounter}`;
  return {
    effect_id: effectId,
    depends_on_effect_ids: [],
    event_id: eventId,
    target: spec.target,
    domain: spec.domain,
    kind: spec.kind,
    operation: spec.operation,
    payload: spec.payload,
    provenance: 'rules_engine',
    visibility: 'server_only',
    evidence_event_ids: [eventId],
    ...overrides
  };
}

function compiledEffect(spec, overrides = {}) {
  return compileEffectDag([effect(spec, overrides)], {
    resolveReducer: resolveDomainReducer,
    ruleSnapshot: RULE_SNAPSHOT
  }).effects[0];
}

function apply(state, spec, overrides = {}) {
  const compiled = compiledEffect(spec, overrides);
  return {
    compiled,
    result: reduceDomainEffect(state, compiled, RULE_SNAPSHOT)
  };
}

function resource(state, actorId, resourceId) {
  const seat = actorId === 'actor:A' ? 'A' : 'B';
  return state.actors[seat].attributes.resources.find(entry => entry.resource_id === resourceId);
}

test('registry is fixed, versioned, and the complete base state passes reducer validation', () => {
  const state = baseState();
  assertReducerDomainState(state);
  assert.equal(DOMAIN_REDUCER_REGISTRY.schema, 'naruto.multiplayer-domain-reducer-registry/v1');
  assert.equal(DOMAIN_REDUCER_REGISTRY.integrity_policy_hash, INTEGRITY_POLICY_HASH);
  assert.ok(DOMAIN_REDUCER_REGISTRY.effects.length >= 40);
  assert.ok(Object.isFrozen(DOMAIN_REDUCER_REGISTRY));
  assert.ok(DOMAIN_REDUCER_REGISTRY.effects.some(entry =>
    entry.required_reducer === 'apply_actor_resource_effect'
  ));
});

test('resource reducer is deterministic, immutable, hashed, and does not read clock or randomness', () => {
  const state = baseState();
  const original = structuredClone(state);
  const compiled = compiledEffect({
    domain: 'actor_resource',
    kind: 'resource',
    operation: 'consume',
    target: { scope: 'actor_resource', actor_id: 'actor:A', resource_id: 'chakra' },
    payload: {
      expected_version: 0,
      next_version: 1,
      from: 40,
      to: 28,
      amount: 12,
      maximum: 100
    }
  });
  const savedNow = Date.now;
  const savedRandom = Math.random;
  Date.now = () => { throw new Error('Date.now must not be read'); };
  Math.random = () => { throw new Error('Math.random must not be read'); };
  let first;
  let second;
  try {
    first = reduceDomainEffect(state, compiled, RULE_SNAPSHOT);
    second = reduceDomainEffect(structuredClone(state), structuredClone(compiled), structuredClone(RULE_SNAPSHOT));
  } finally {
    Date.now = savedNow;
    Math.random = savedRandom;
  }
  assert.deepEqual(state, original);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(resource(first.nextCandidate, 'actor:A', 'chakra').current, 28);
  assert.match(first.normalizedOperations[0].operation_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.normalizedOperations[0].integrity_policy_hash, INTEGRITY_POLICY_HASH);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.nextCandidate));
});

test('resource floor and one-version preconditions prevent underflow and double settlement', () => {
  const state = baseState();
  const tooLarge = compiledEffect({
    domain: 'actor_resource',
    kind: 'resource',
    operation: 'consume',
    target: { scope: 'actor_resource', actor_id: 'actor:A', resource_id: 'chakra' },
    payload: {
      expected_version: 0,
      next_version: 1,
      from: 40,
      to: 0,
      amount: 41,
      maximum: 100
    }
  });
  assert.throws(
    () => reduceDomainEffect(state, tooLarge, RULE_SNAPSHOT),
    expectCode('RESOURCE_FLOOR_VIOLATION')
  );

  const { compiled, result } = apply(state, {
    domain: 'actor_resource',
    kind: 'resource',
    operation: 'damage',
    target: { scope: 'actor_resource', actor_id: 'actor:A', resource_id: 'vitality' },
    payload: {
      expected_version: 0,
      next_version: 1,
      from: 80,
      to: 0,
      amount: 200,
      maximum: 100
    }
  });
  assert.equal(resource(result.nextCandidate, 'actor:A', 'vitality').current, 0);
  assert.throws(
    () => reduceDomainEffect(result.nextCandidate, compiled, RULE_SNAPSHOT),
    expectCode('EFFECT_PRECONDITION_FAILED')
  );
});

test('actor profile and progression accept only fixed fields and preserve stable actor identity', () => {
  const state = baseState();
  const profileResult = apply(state, {
    domain: 'actor_profile',
    kind: 'profile',
    operation: 'set_fields',
    target: { scope: 'actor', actor_id: 'actor:A' },
    payload: {
      expected_version: 0,
      next_version: 1,
      changes: { rank: '中忍', goal: '护送车队' }
    }
  }).result;
  assert.equal(profileResult.nextCandidate.actors.A.room_actor_id, 'actor:A');
  assert.equal(profileResult.nextCandidate.actors.A.player.rank, '中忍');

  const progressionResult = apply(profileResult.nextCandidate, {
    domain: 'actor_progression',
    kind: 'progression',
    operation: 'grant_experience',
    target: { scope: 'actor', actor_id: 'actor:A' },
    payload: { expected_version: 0, next_version: 1, from: 0, to: 20 }
  }).result;
  assert.equal(progressionResult.nextCandidate.actors.A.progression.experience, 20);

  assert.throws(() => compiledEffect({
    domain: 'actor_profile',
    kind: 'profile',
    operation: 'set_fields',
    target: { scope: 'actor', actor_id: 'actor:A' },
    payload: {
      expected_version: 0,
      next_version: 1,
      changes: { room_actor_id: 'actor:B' }
    }
  }), expectCode('INVALID_EFFECT_PAYLOAD'));
});

test('skill and item reducers use stable IDs and exhausted items are removed without resource side effects', () => {
  let state = baseState();
  const learned = apply(state, {
    domain: 'skill',
    kind: 'actor_skill',
    operation: 'upsert',
    target: { scope: 'actor_skill', actor_id: 'actor:A', skill_id: 'skill:fireball' },
    payload: {
      expected_version: null,
      next_version: 1,
      display_name: '豪火球之术',
      category: 'NINJUTSU',
      rank: 'C',
      mastery: 10,
      canonical_ref: 'canon:katon-goukakyuu'
    }
  });
  state = learned.result.nextCandidate;
  assert.equal(state.actors.A.skills.entries[0].skill_id, 'skill:fireball');
  assert.throws(
    () => reduceDomainEffect(state, learned.compiled, RULE_SNAPSHOT),
    expectCode('EFFECT_PRECONDITION_FAILED')
  );

  state = apply(state, {
    domain: 'item',
    kind: 'actor_item',
    operation: 'upsert',
    target: { scope: 'actor_item', actor_id: 'actor:A', item_id: 'item:smoke-bomb' },
    payload: {
      expected_version: null,
      next_version: 1,
      display_name: '烟雾弹',
      category: 'CONSUMABLE',
      quantity: 1,
      canonical_ref: null,
      equipped_slot: null
    }
  }).result.nextCandidate;
  const resourcesBefore = structuredClone(state.actors.A.attributes);
  const consumed = apply(state, {
    domain: 'item',
    kind: 'actor_item',
    operation: 'consume',
    target: { scope: 'actor_item', actor_id: 'actor:A', item_id: 'item:smoke-bomb' },
    payload: {
      expected_version: 1,
      next_version: 2,
      from_quantity: 1,
      amount: 1,
      to_quantity: 0
    }
  }).result;
  assert.equal(consumed.nextCandidate.actors.A.equipment.entries.length, 0);
  assert.deepEqual(consumed.nextCandidate.actors.A.attributes, resourcesBefore);
  assert.equal(
    consumed.normalizedOperations[0].primary.operation,
    'consume_and_remove_exhausted_entity'
  );
});

test('world and calendar reducers use frozen values instead of paths or system time', () => {
  let state = baseState();
  state = apply(state, {
    domain: 'world',
    kind: 'location',
    operation: 'set',
    target: { scope: 'world_location', entity_id: 'actor:A' },
    payload: {
      expected_version: null,
      next_version: 1,
      from_location_id: null,
      to_location_id: 'location:east-gate'
    }
  }).result.nextCandidate;
  assert.equal(state.shared_world.world_state.locations[0].location_id, 'location:east-gate');

  state = apply(state, {
    domain: 'calendar',
    kind: 'calendar',
    operation: 'advance',
    target: { scope: 'world_calendar', calendar_id: 'calendar:main' },
    payload: {
      expected_version: 0,
      next_version: 1,
      from_ordinal_minutes: 100,
      duration_minutes: 35,
      to_ordinal_minutes: 135,
      display_date: '木叶48年3月12日 中午',
      phase: 'DAY'
    }
  }).result.nextCandidate;
  assert.equal(state.shared_world.calendar.ordinal_minutes, 135);
  assert.equal(state.meta.state_revision, 7);

  assert.throws(() => compiledEffect({
    domain: 'world',
    kind: 'flag',
    operation: 'set',
    target: { scope: 'world_flag', flag_id: 'flag:gate-open' },
    payload: {
      expected_version: null,
      next_version: 1,
      from_enabled: null,
      to_enabled: true,
      path: '/actors/A/progression/experience'
    }
  }), expectCode('INVALID_EFFECT_PAYLOAD'));
});

test('mission state machine completes exactly once and never grants hidden rewards', () => {
  let state = baseState();
  const unrelatedBefore = {
    progression: structuredClone(state.actors.A.progression),
    resources: structuredClone(state.actors.A.attributes),
    items: structuredClone(state.actors.A.equipment)
  };
  state = apply(state, {
    domain: 'mission',
    kind: 'mission',
    operation: 'create',
    target: { scope: 'mission', mission_id: 'mission:escort', mission_scope: 'shared' },
    payload: {
      expected_version: null,
      next_version: 1,
      title: '护送车队',
      initial_status: 'OFFERED',
      progress_current: 0,
      progress_total: 1,
      assignee_actor_ids: ['actor:A', 'actor:B']
    }
  }).result.nextCandidate;
  state = apply(state, {
    domain: 'mission',
    kind: 'mission',
    operation: 'transition',
    target: { scope: 'mission', mission_id: 'mission:escort', mission_scope: 'shared' },
    payload: { expected_version: 1, next_version: 2, from_status: 'OFFERED', to_status: 'ACCEPTED' }
  }).result.nextCandidate;
  state = apply(state, {
    domain: 'mission',
    kind: 'mission',
    operation: 'transition',
    target: { scope: 'mission', mission_id: 'mission:escort', mission_scope: 'shared' },
    payload: { expected_version: 2, next_version: 3, from_status: 'ACCEPTED', to_status: 'ACTIVE' }
  }).result.nextCandidate;
  const completed = apply(state, {
    domain: 'mission',
    kind: 'mission',
    operation: 'transition',
    target: { scope: 'mission', mission_id: 'mission:escort', mission_scope: 'shared' },
    payload: { expected_version: 3, next_version: 4, from_status: 'ACTIVE', to_status: 'COMPLETED' }
  });
  state = completed.result.nextCandidate;
  assert.equal(state.shared_world.shared_missions.entries[0].status, 'COMPLETED');
  assert.deepEqual(state.actors.A.progression, unrelatedBefore.progression);
  assert.deepEqual(state.actors.A.attributes, unrelatedBefore.resources);
  assert.deepEqual(state.actors.A.equipment, unrelatedBefore.items);
  assert.throws(
    () => reduceDomainEffect(state, completed.compiled, RULE_SNAPSHOT),
    expectCode('EFFECT_PRECONDITION_FAILED')
  );
  assert.throws(() => compiledEffect({
    domain: 'mission',
    kind: 'mission',
    operation: 'transition',
    target: { scope: 'mission', mission_id: 'mission:escort', mission_scope: 'shared' },
    payload: {
      expected_version: 3,
      next_version: 4,
      from_status: 'ACTIVE',
      to_status: 'COMPLETED',
      rewards: { experience: 100 }
    }
  }), expectCode('INVALID_EFFECT_PAYLOAD'));
});

test('invalid mission, combat, and event transitions are rejected', () => {
  let state = apply(baseState(), {
    domain: 'mission',
    kind: 'mission',
    operation: 'create',
    target: { scope: 'mission', mission_id: 'mission:bad-transition', mission_scope: 'shared' },
    payload: {
      expected_version: null,
      next_version: 1,
      title: '状态测试',
      initial_status: 'OFFERED',
      progress_current: 0,
      progress_total: 1,
      assignee_actor_ids: ['actor:A']
    }
  }).result.nextCandidate;
  const invalidMission = compiledEffect({
    domain: 'mission',
    kind: 'mission',
    operation: 'transition',
    target: { scope: 'mission', mission_id: 'mission:bad-transition', mission_scope: 'shared' },
    payload: { expected_version: 1, next_version: 2, from_status: 'OFFERED', to_status: 'COMPLETED' }
  });
  assert.throws(
    () => reduceDomainEffect(state, invalidMission, RULE_SNAPSHOT),
    expectCode('INVALID_STATE_TRANSITION')
  );

  state = apply(state, {
    domain: 'combat',
    kind: 'combat',
    operation: 'create',
    target: { scope: 'combat', combat_id: 'combat:not-active' },
    payload: {
      expected_version: null,
      next_version: 1,
      participants: [
        { participant_id: 'actor:A', display_name: '甲', status: 'READY' },
        { participant_id: 'actor:B', display_name: '乙', status: 'READY' }
      ]
    }
  }).result.nextCandidate;
  const invalidCombat = compiledEffect({
    domain: 'combat',
    kind: 'combat',
    operation: 'resolve',
    target: { scope: 'combat', combat_id: 'combat:not-active' },
    payload: {
      expected_version: 1,
      next_version: 2,
      winner_ids: ['actor:A'],
      resolution_summary: '尚未开始却试图结算。'
    }
  });
  assert.throws(
    () => reduceDomainEffect(state, invalidCombat, RULE_SNAPSHOT),
    expectCode('INVALID_STATE_TRANSITION')
  );
});

test('combat reducer records aggregate facts without charging resources or vitality', () => {
  let state = baseState();
  const actorStateBefore = structuredClone(state.actors);
  state = apply(state, {
    domain: 'combat',
    kind: 'combat',
    operation: 'create',
    target: { scope: 'combat', combat_id: 'combat:test' },
    payload: {
      expected_version: null,
      next_version: 1,
      participants: [
        { participant_id: 'actor:A', display_name: '甲', status: 'READY' },
        { participant_id: 'actor:B', display_name: '乙', status: 'READY' }
      ]
    }
  }).result.nextCandidate;
  state = apply(state, {
    domain: 'combat',
    kind: 'combat',
    operation: 'transition',
    target: { scope: 'combat', combat_id: 'combat:test' },
    payload: { expected_version: 1, next_version: 2, from_phase: 'SETUP', to_phase: 'ACTIVE' }
  }).result.nextCandidate;
  state = apply(state, {
    domain: 'combat',
    kind: 'combat',
    operation: 'record_action',
    target: { scope: 'combat', combat_id: 'combat:test' },
    payload: {
      expected_version: 2,
      next_version: 3,
      action_id: 'action:fireball',
      actor_id: 'actor:A',
      technique_id: 'skill:fireball',
      event_id: 'event_combat_action',
      outcome: '命中掩体，迫使对方撤出。'
    }
  }).result.nextCandidate;
  state = apply(state, {
    domain: 'combat',
    kind: 'combat',
    operation: 'resolve',
    target: { scope: 'combat', combat_id: 'combat:test' },
    payload: {
      expected_version: 3,
      next_version: 4,
      winner_ids: ['actor:A'],
      resolution_summary: '甲取得战斗优势。'
    }
  }).result.nextCandidate;
  const combat = state.shared_world.shared_combat.entries.find(entry => entry.combat_id === 'combat:test');
  assert.equal(combat.phase, 'RESOLVED');
  assert.equal(combat.action_log.length, 1);
  assert.deepEqual(state.actors, actorStateBefore);

  assert.throws(() => compiledEffect({
    domain: 'combat',
    kind: 'combat',
    operation: 'record_action',
    target: { scope: 'combat', combat_id: 'combat:test' },
    payload: {
      expected_version: 4,
      next_version: 5,
      action_id: 'action:hidden-cost',
      actor_id: 'actor:A',
      technique_id: null,
      event_id: 'event_hidden_cost',
      outcome: '非法参数',
      chakra_cost: 10
    }
  }), expectCode('INVALID_EFFECT_PAYLOAD'));
});

test('relationship/NPC rename emits only enumerated system-derived cache receipts', () => {
  const state = baseState();
  const originalRelationshipScore = state.relationships[0].data.score;
  const originalMemoryFact = state.memories.canonical.entries[0].fact;
  const originalActors = structuredClone(state.actors);
  const renamed = apply(state, {
    domain: 'relationship',
    kind: 'npc_profile',
    operation: 'rename',
    target: { scope: 'npc_profile', npc_id: 'npc:guide' },
    payload: {
      expected_version: 1,
      next_version: 2,
      from_display_name: '旧名',
      to_display_name: '青叶',
      evidence_event_ids: ['event_npc_rename']
    }
  }).result;
  const next = renamed.nextCandidate;
  assert.equal(next.shared_world.world_state.npc_profiles[0].display_name, '青叶');
  assert.equal(next.relationships[0].data.source_display_name, '青叶');
  assert.equal(next.relationships[0].data.score, originalRelationshipScore);
  assert.equal(next.memories.canonical.entries[0].fact, originalMemoryFact);
  assert.equal(
    next.memories.canonical.entries[0].subject_display_names[0].display_name,
    '青叶'
  );
  assert.equal(
    next.shared_world.shared_combat.entries[0].participants[1].display_name,
    '青叶'
  );
  assert.deepEqual(next.actors, originalActors);
  const receipt = renamed.normalizedOperations[0];
  assert.equal(receipt.system_derived.length, 3);
  assert.ok(receipt.system_derived.every(operation =>
    operation.policy_id === 'npc-display-name-cache-refresh'
  ));
  assert.match(receipt.operation_hash, /^sha256:[a-f0-9]{64}$/);
});

test('event reducer follows its FSM and has no listener-style side effects', () => {
  let state = baseState();
  const nonEventBefore = {
    actors: structuredClone(state.actors),
    missions: structuredClone(state.shared_world.shared_missions),
    combat: structuredClone(state.shared_world.shared_combat)
  };
  state = apply(state, {
    domain: 'event',
    kind: 'event',
    operation: 'create',
    target: { scope: 'event', event_id: 'event_storm' },
    payload: {
      expected_version: null,
      next_version: 1,
      initial_status: 'SCHEDULED',
      title: '暴雨将至',
      scheduled_ordinal_minutes: 200,
      evidence_event_ids: ['event_storm_forecast']
    }
  }).result.nextCandidate;
  state = apply(state, {
    domain: 'event',
    kind: 'event',
    operation: 'transition',
    target: { scope: 'event', event_id: 'event_storm' },
    payload: {
      expected_version: 1,
      next_version: 2,
      from_status: 'SCHEDULED',
      to_status: 'TRIGGERED',
      resolution_summary: null
    }
  }).result.nextCandidate;
  state = apply(state, {
    domain: 'event',
    kind: 'event',
    operation: 'transition',
    target: { scope: 'event', event_id: 'event_storm' },
    payload: {
      expected_version: 2,
      next_version: 3,
      from_status: 'TRIGGERED',
      to_status: 'RESOLVED',
      resolution_summary: '暴雨减弱，道路恢复通行。'
    }
  }).result.nextCandidate;
  assert.equal(state.shared_world.canonical_events.entries[0].status, 'RESOLVED');
  assert.deepEqual(state.actors, nonEventBefore.actors);
  assert.deepEqual(state.shared_world.shared_missions, nonEventBefore.missions);
  assert.deepEqual(state.shared_world.shared_combat, nonEventBefore.combat);
});

test('wrong reducer binding, altered hash, arbitrary payload, and live-state handles are rejected', () => {
  const state = baseState();
  const compiled = compiledEffect({
    domain: 'actor_resource',
    kind: 'resource',
    operation: 'gain',
    target: { scope: 'actor_resource', actor_id: 'actor:A', resource_id: 'chakra' },
    payload: {
      expected_version: 0,
      next_version: 1,
      from: 40,
      to: 45,
      amount: 5,
      maximum: 100
    }
  });
  assert.throws(() => reduceDomainEffect(state, {
    ...compiled,
    required_reducer: 'apply_world_state_effect'
  }, RULE_SNAPSHOT), expectCode('INVALID_EFFECT_CONTRACT'));
  assert.throws(() => reduceDomainEffect(state, {
    ...compiled,
    payload: { ...compiled.payload, amount: 6 }
  }, RULE_SNAPSHOT), expectCode('EFFECT_HASH_MISMATCH'));
  assert.throws(() => compiledEffect({
    domain: 'actor_resource',
    kind: 'resource',
    operation: 'gain',
    target: { scope: 'actor_resource', actor_id: 'actor:A', resource_id: 'chakra' },
    payload: {
      expected_version: 0,
      next_version: 1,
      from: 40,
      to: 45,
      amount: 5,
      maximum: 100,
      live_state: { room_id: 'room:other' }
    }
  }), expectCode('INVALID_EFFECT_PAYLOAD'));
});

console.log(`All ${passed} multiplayer reducer regression checks passed.`);
