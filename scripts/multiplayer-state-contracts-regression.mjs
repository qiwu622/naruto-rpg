import assert from 'node:assert/strict';

import {
  MULTIPLAYER_ROOM_STATE_JSON_SCHEMA,
  MULTIPLAYER_ROOM_STATE_LIMITS,
  MULTIPLAYER_ROOM_STATE_SCHEMA,
  assertMultiplayerRoomState,
  assertStableRoomActorIds,
  inspectMultiplayerRoomState
} from '../server/multiplayer/contracts/state-contracts.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectInvalid(value, expectedPath = undefined) {
  const result = inspectMultiplayerRoomState(value);
  assert.equal(result.valid, false);
  assert.equal(result.value, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'SCHEMA_VIOLATION');
  if (expectedPath !== undefined) assert.equal(result.errors[0].path, expectedPath);
  return result;
}

let passed = 0;
function test(name, callback) {
  callback();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const validState = {
  schema: MULTIPLAYER_ROOM_STATE_SCHEMA,
  meta: {
    state_revision: 42
  },
  shared_world: {
    world_state: {
      current_location_id: 'location_konoha',
      weather: 'clear'
    },
    calendar: {
      era: '木叶纪元',
      day: 12
    },
    map: {
      visited_location_ids: ['location_konoha']
    },
    canonical_events: [
      { event_id: 'event_genesis', summary: '两名角色抵达木叶。' }
    ],
    shared_missions: [],
    shared_combat: null,
    continuity_ledger: []
  },
  actors: {
    A: {
      room_actor_id: 'room_actor_alpha',
      player: { display_name: '日向澪' },
      attributes: { chakra: 80 },
      progression: { experience: 12 },
      skills: [{ skill_id: 'skill_byakugan' }],
      equipment: [],
      missions: [],
      private_knowledge: [{ fact_id: 'fact_alpha' }]
    },
    B: {
      room_actor_id: 'room_actor_beta',
      player: { display_name: '宇智波律' },
      attributes: { chakra: 76 },
      progression: { experience: 10 },
      skills: [{ skill_id: 'skill_fireball' }],
      equipment: [],
      missions: [],
      private_knowledge: [{ fact_id: 'fact_beta' }]
    }
  },
  relationships: [
    {
      edge_id: 'relationship_alpha_beta',
      source_actor_id: 'room_actor_alpha',
      target_actor_id: 'room_actor_beta',
      data: { trust: 2 }
    },
    {
      edge_id: 'relationship_beta_alpha',
      source_actor_id: 'room_actor_beta',
      target_actor_id: 'room_actor_alpha',
      data: { trust: -1 }
    },
    {
      edge_id: 'relationship_npc_alpha',
      source_actor_id: 'npc_merchant_01',
      target_actor_id: 'room_actor_alpha',
      data: { recognition: true }
    }
  ],
  memories: {
    canonical: [{ memory_id: 'memory_canonical_01' }],
    shared: [{ memory_id: 'memory_shared_01' }],
    'actor:A': [{ memory_id: 'memory_actor_a_01' }],
    'actor:B': [{ memory_id: 'memory_actor_b_01' }],
    npc_private: {
      npc_merchant_01: [{ memory_id: 'memory_npc_01' }]
    }
  },
  agent_internal: {
    story_plan: null,
    audit_state: { last_reviewed_turn: 0 }
  }
};

test('MultiplayerRoomState/v1 schema freezes every documented state partition', () => {
  assert.equal(MULTIPLAYER_ROOM_STATE_JSON_SCHEMA.$id, MULTIPLAYER_ROOM_STATE_SCHEMA);
  assert.equal(Object.isFrozen(MULTIPLAYER_ROOM_STATE_JSON_SCHEMA), true);
  assert.equal(Object.isFrozen(MULTIPLAYER_ROOM_STATE_JSON_SCHEMA.properties.actors), true);
  assert.equal(MULTIPLAYER_ROOM_STATE_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(MULTIPLAYER_ROOM_STATE_JSON_SCHEMA.required, [
    'schema',
    'meta',
    'shared_world',
    'actors',
    'relationships',
    'memories',
    'agent_internal'
  ]);
  assert.deepEqual(
    Object.keys(MULTIPLAYER_ROOM_STATE_JSON_SCHEMA.properties.shared_world.properties),
    [
      'calendar',
      'canonical_events',
      'continuity_ledger',
      'map',
      'shared_combat',
      'shared_missions',
      'world_state'
    ]
  );
  assert.deepEqual(
    Object.keys(MULTIPLAYER_ROOM_STATE_JSON_SCHEMA.properties.memories.properties),
    ['actor:A', 'actor:B', 'canonical', 'npc_private', 'shared']
  );
  assert.deepEqual(
    Object.keys(MULTIPLAYER_ROOM_STATE_JSON_SCHEMA.properties.agent_internal.properties),
    ['audit_state', 'story_plan']
  );
});

test('all declared structural objects are closed and canonical data stays recursively validated', () => {
  const schema = MULTIPLAYER_ROOM_STATE_JSON_SCHEMA;
  const closedObjects = [
    schema,
    schema.properties.meta,
    schema.properties.shared_world,
    schema.properties.actors,
    schema.properties.actors.properties.A,
    schema.properties.actors.properties.B,
    schema.properties.relationships.items,
    schema.properties.memories,
    schema.properties.agent_internal
  ];
  for (const objectSchema of closedObjects) {
    assert.equal(objectSchema.type, 'object');
    assert.equal(objectSchema.additionalProperties, false);
  }

  const canonicalObject = schema.$defs.canonicalData.oneOf.find(
    candidate => candidate.type === 'object'
  );
  assert.deepEqual(canonicalObject.additionalProperties, {
    $ref: '#/$defs/canonicalData'
  });
  assert.deepEqual(canonicalObject.propertyNames.not.enum, [
    '__proto__',
    'prototype',
    'constructor'
  ]);
  assert.equal(MULTIPLAYER_ROOM_STATE_LIMITS.maxCanonicalDepth, 64);
  assert.equal(MULTIPLAYER_ROOM_STATE_LIMITS.maxCanonicalNodes, 100_000);
});

test('valid state includes two full player slots and returns detached frozen canonical data', () => {
  const normalized = assertMultiplayerRoomState(validState);
  assert.notEqual(normalized, validState);
  assert.equal(normalized.actors.A.room_actor_id, 'room_actor_alpha');
  assert.equal(normalized.actors.B.room_actor_id, 'room_actor_beta');
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.shared_world.world_state), true);
  assert.equal(Object.isFrozen(normalized.memories['actor:A']), true);
  assert.deepEqual(Object.keys(normalized), [
    'actors',
    'agent_internal',
    'memories',
    'meta',
    'relationships',
    'schema',
    'shared_world'
  ].sort());
});

test('room control and room state are disjoint strict boundaries', () => {
  const withControl = clone(validState);
  withControl.control = {
    control_revision: 4,
    event_seq: 9,
    queued_narrative_mode: 'dual_pov'
  };
  expectInvalid(withControl, '/control');

  const controlInMeta = clone(validState);
  controlInMeta.meta.control_revision = 4;
  expectInvalid(controlInMeta, '/meta/control_revision');

  const stateHashInMeta = clone(validState);
  stateHashInMeta.meta.state_hash = `sha256:${'a'.repeat(64)}`;
  expectInvalid(stateHashInMeta, '/meta/state_hash');

  const roomRecordWrapper = {
    control: { control_revision: 4 },
    room_state: clone(validState)
  };
  expectInvalid(roomRecordWrapper, '/control');
});

test('both A and B actor slots are mandatory for either documented room origin', () => {
  const missingGuest = clone(validState);
  delete missingGuest.actors.B;
  expectInvalid(missingGuest, '/actors/B');

  const addedThirdPlayer = clone(validState);
  addedThirdPlayer.actors.C = clone(addedThirdPlayer.actors.B);
  addedThirdPlayer.actors.C.room_actor_id = 'room_actor_gamma';
  expectInvalid(addedThirdPlayer, '/actors/C');

  const missingGuestCharacterField = clone(validState);
  delete missingGuestCharacterField.actors.B.player;
  expectInvalid(missingGuestCharacterField, '/actors/B/player');
});

test('room_actor_id values are valid and form a two-actor identity bijection', () => {
  const duplicate = clone(validState);
  duplicate.actors.B.room_actor_id = duplicate.actors.A.room_actor_id;
  expectInvalid(duplicate, '/actors/B/room_actor_id');

  const malformed = clone(validState);
  malformed.actors.A.room_actor_id = 'contains whitespace';
  expectInvalid(malformed, '/actors/A/room_actor_id');
});

test('stable room_actor_id survives display changes and cannot change across snapshots', () => {
  const next = clone(validState);
  next.meta.state_revision = 43;
  next.actors.A.player.display_name = '日向澪（成年）';
  next.actors.B.player.display_name = '宇智波律（改名后）';
  const accepted = assertStableRoomActorIds(validState, next);
  assert.equal(accepted.actors.A.room_actor_id, 'room_actor_alpha');

  const replaced = clone(next);
  replaced.actors.A.room_actor_id = 'room_actor_replacement';
  assert.throws(
    () => assertStableRoomActorIds(validState, replaced),
    error => error instanceof DomainError
      && error.code === 'SCHEMA_VIOLATION'
      && error.details?.path === '/actors/A/room_actor_id'
  );
});

test('relationships are distinct directed edges rather than a shared name-keyed score', () => {
  const normalized = assertMultiplayerRoomState(validState);
  const forward = normalized.relationships.find(
    edge => edge.edge_id === 'relationship_alpha_beta'
  );
  const reverse = normalized.relationships.find(
    edge => edge.edge_id === 'relationship_beta_alpha'
  );
  assert.equal(forward.source_actor_id, reverse.target_actor_id);
  assert.equal(forward.target_actor_id, reverse.source_actor_id);
  assert.notDeepEqual(forward.data, reverse.data);

  const duplicateEdge = clone(validState);
  duplicateEdge.relationships[1].edge_id = duplicateEdge.relationships[0].edge_id;
  expectInvalid(duplicateEdge, '/relationships/1');

  const untypedExtra = clone(validState);
  untypedExtra.relationships[0].trust = 99;
  expectInvalid(untypedExtra, '/relationships/0/trust');

  const malformedEndpoint = clone(validState);
  malformedEndpoint.relationships[0].source_actor_id = 'bad endpoint';
  expectInvalid(malformedEndpoint, '/relationships/0/source_actor_id');
});

test('shared world, memories and agent internal partitions reject invented structural fields', () => {
  const worldExtra = clone(validState);
  worldExtra.shared_world.private_world = {};
  expectInvalid(worldExtra, '/shared_world/private_world');

  const memoryExtra = clone(validState);
  memoryExtra.memories['actor:C'] = [];
  expectInvalid(memoryExtra, '/memories/actor:C');

  const missingNpcPrivate = clone(validState);
  delete missingNpcPrivate.memories.npc_private;
  expectInvalid(missingNpcPrivate, '/memories/npc_private');

  const agentExtra = clone(validState);
  agentExtra.agent_internal.prompt = 'secret';
  expectInvalid(agentExtra, '/agent_internal/prompt');
});

test('canonical leaf data rejects prototype manipulation and all non-JSON values', () => {
  const dangerous = clone(validState);
  dangerous.shared_world.world_state = JSON.parse(
    '{"safe":true,"nested":{"constructor":{"polluted":true}}}'
  );
  assert.throws(
    () => assertMultiplayerRoomState(dangerous),
    error => error instanceof DomainError
      && error.code === 'SCHEMA_VIOLATION'
      && error.details?.reason_code === 'JSON_DANGEROUS_KEY'
  );

  const nonFinite = clone(validState);
  nonFinite.actors.A.attributes.chakra = Number.POSITIVE_INFINITY;
  assert.throws(
    () => assertMultiplayerRoomState(nonFinite),
    error => error instanceof DomainError
      && error.details?.reason_code === 'JSON_NON_FINITE_NUMBER'
  );

  const undefinedValue = clone(validState);
  undefinedValue.agent_internal.story_plan = undefined;
  assert.throws(
    () => assertMultiplayerRoomState(undefinedValue),
    error => error instanceof DomainError
      && error.details?.reason_code === 'JSON_UNSAFE_TYPE'
  );

  const cyclic = clone(validState);
  cyclic.agent_internal.audit_state.self = cyclic.agent_internal.audit_state;
  assert.throws(
    () => assertMultiplayerRoomState(cyclic),
    error => error instanceof DomainError
      && error.details?.reason_code === 'JSON_CYCLE'
  );
});

test('canonical safety inspection does not execute accessors', () => {
  const accessorState = clone(validState);
  let getterCalls = 0;
  Object.defineProperty(accessorState.shared_world.world_state, 'trap', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'must-not-run';
    }
  });
  assert.throws(
    () => assertMultiplayerRoomState(accessorState),
    error => error instanceof DomainError
      && error.details?.reason_code === 'JSON_UNSAFE_PROPERTY'
  );
  assert.equal(getterCalls, 0);
});

console.log(`${passed} multiplayer state contract regression tests passed.`);
