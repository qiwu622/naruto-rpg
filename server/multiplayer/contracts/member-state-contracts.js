import { assertJsonSafe } from '../domain/canonical-json.js';
import { ROOM_SEATS } from './enums.js';
import {
  assertArray,
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertPlainRecord,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';

export const MEMBER_STATE_PROJECTION_SCHEMA =
  'naruto.multiplayer-member-state-projection/v1';

const ACTOR_FIELDS = Object.freeze([
  'room_actor_id',
  'player',
  'attributes',
  'progression',
  'skills',
  'equipment',
  'missions',
  'private_knowledge'
]);
const SHARED_WORLD_FIELDS = Object.freeze([
  'world_state',
  'calendar',
  'map',
  'shared_missions',
  'shared_combat'
]);
const RELATIONSHIP_FIELDS = Object.freeze([
  'edge_id',
  'source_actor_id',
  'target_actor_id',
  'data'
]);
const COUNTERPART_PRIVATE_PLAYER_KEYS =
  /(?:^|_)(?:background|backstory|biography|goal|hidden|objective|private|secret)(?:_|$)/iu;
const COUNTERPART_PUBLIC_PLAYER_FIELDS = Object.freeze([
  'schema',
  'version',
  'display_name',
  'rank',
  'alive',
  'status'
]);
const DANGEROUS_PROPERTY_NAMES = Object.freeze([
  '__proto__',
  'prototype',
  'constructor'
]);
const canonicalDataRef = { $ref: '#/$defs/member_state_canonical_data' };

export const MEMBER_STATE_CANONICAL_DATA_DEFINITION = immutableContractValue({
  oneOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: canonicalDataRef },
    {
      type: 'object',
      propertyNames: { not: { enum: DANGEROUS_PROPERTY_NAMES } },
      additionalProperties: canonicalDataRef
    }
  ]
});
const identifierDefinition = {
  type: 'string',
  minLength: 2,
  maxLength: 160,
  pattern: '^[A-Za-z][A-Za-z0-9:_-]*$'
};

const actorDefinition = {
  type: 'object',
  additionalProperties: false,
  required: ACTOR_FIELDS,
  properties: Object.fromEntries(ACTOR_FIELDS.map(field => [
    field,
    field === 'room_actor_id'
      ? identifierDefinition
      : canonicalDataRef
  ]))
};

const emptyPartitionDefinition = {
  oneOf: [
    { type: 'null' },
    { type: 'array', maxItems: 0 },
    { type: 'object', additionalProperties: false, maxProperties: 0 },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'entries'],
      properties: {
        schema: { type: 'string', minLength: 1, maxLength: 160 },
        entries: { type: 'array', maxItems: 0 }
      }
    }
  ]
};

const counterpartPlayerDefinition = {
  type: 'object',
  additionalProperties: false,
  required: COUNTERPART_PUBLIC_PLAYER_FIELDS,
  properties: {
    schema: { const: 'naruto.multiplayer-actor-profile/v1' },
    version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    display_name: { type: 'string', minLength: 1, maxLength: 80 },
    rank: { type: 'string', minLength: 1, maxLength: 80 },
    alive: { type: 'boolean' },
    status: {
      type: 'string',
      enum: ['ACTIVE', 'INCAPACITATED', 'MISSING', 'DECEASED']
    }
  }
};

const counterpartActorDefinition = {
  type: 'object',
  additionalProperties: false,
  required: ACTOR_FIELDS,
  properties: {
    room_actor_id: identifierDefinition,
    player: counterpartPlayerDefinition,
    attributes: canonicalDataRef,
    progression: canonicalDataRef,
    skills: emptyPartitionDefinition,
    equipment: emptyPartitionDefinition,
    missions: emptyPartitionDefinition,
    private_knowledge: emptyPartitionDefinition
  }
};

function memberStateProjectionBranch(viewerSeat) {
  const counterpartSeat = viewerSeat === 'A' ? 'B' : 'A';
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'schema',
      'viewer_seat',
      'state_revision',
      'shared_world',
      'actors',
      'relationships',
      'memories'
    ],
    properties: {
      schema: { const: MEMBER_STATE_PROJECTION_SCHEMA },
      viewer_seat: { const: viewerSeat },
      state_revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      shared_world: {
        type: 'object',
        additionalProperties: false,
        required: SHARED_WORLD_FIELDS,
        properties: Object.fromEntries(SHARED_WORLD_FIELDS.map(field => [field, canonicalDataRef]))
      },
      actors: {
        type: 'object',
        additionalProperties: false,
        required: ROOM_SEATS,
        properties: {
          A: counterpartSeat === 'A' ? counterpartActorDefinition : actorDefinition,
          B: counterpartSeat === 'B' ? counterpartActorDefinition : actorDefinition
        }
      },
      relationships: {
        type: 'array',
        maxItems: 10_000,
        items: {
          type: 'object',
          additionalProperties: false,
          required: RELATIONSHIP_FIELDS,
          properties: {
            edge_id: identifierDefinition,
            source_actor_id: identifierDefinition,
            target_actor_id: identifierDefinition,
            data: canonicalDataRef
          }
        }
      },
      memories: {
        type: 'object',
        additionalProperties: false,
        required: ['shared', 'personal'],
        properties: { shared: canonicalDataRef, personal: canonicalDataRef }
      }
    }
  };
}

export const MEMBER_STATE_PROJECTION_DEFINITION = immutableContractValue({
  oneOf: ROOM_SEATS.map(memberStateProjectionBranch)
});

export const MEMBER_STATE_PROJECTION_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: MEMBER_STATE_PROJECTION_SCHEMA,
  ...MEMBER_STATE_PROJECTION_DEFINITION,
  $defs: {
    member_state_canonical_data: MEMBER_STATE_CANONICAL_DATA_DEFINITION
  }
});

function assertObject(value, { allowed, path, label }) {
  assertPlainRecord(value, path, label);
  return assertExactKeys(value, { allowed, path, label });
}

function assertActor(value, path) {
  assertObject(value, {
    allowed: ACTOR_FIELDS,
    path,
    label: 'member-visible actor projection'
  });
  assertIdentifier(value.room_actor_id, {
    path: `${path}/room_actor_id`,
    label: 'room_actor_id'
  });
}

function isStructurallyEmpty(value) {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return true;
  if (!keys.every(key => key === 'schema' || key === 'entries')) return false;
  return typeof value.schema === 'string'
    && Array.isArray(value.entries)
    && value.entries.length === 0;
}

function assertNoCounterpartPrivatePlayerKeys(value, path = '') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoCounterpartPrivatePlayerKeys(
      child,
      `${path}/${index}`
    ));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (COUNTERPART_PRIVATE_PLAYER_KEYS.test(key)) {
      throw contractError(
        `${path}/${key}`,
        'counterpart player projection contains a private profile field'
      );
    }
    assertNoCounterpartPrivatePlayerKeys(child, `${path}/${key}`);
  }
}

export function assertMemberStateProjection(value, expected = {}) {
  try {
    assertJsonSafe(value, { maxDepth: 64, maxNodes: 100_000 });
  } catch (error) {
    throw contractError('/', 'member state projection must be safe canonical JSON', {
      cause_code: error?.code ?? 'INVALID_JSON'
    });
  }
  assertObject(value, {
    allowed: [
      'schema',
      'viewer_seat',
      'state_revision',
      'shared_world',
      'actors',
      'relationships',
      'memories'
    ],
    path: '/',
    label: 'member state projection'
  });
  if (value.schema !== MEMBER_STATE_PROJECTION_SCHEMA) {
    throw contractError('/schema', `schema must be ${MEMBER_STATE_PROJECTION_SCHEMA}`);
  }
  assertString(value.viewer_seat, {
    path: '/viewer_seat',
    label: 'viewer_seat',
    enumValues: ROOM_SEATS
  });
  assertInteger(value.state_revision, {
    path: '/state_revision',
    label: 'state_revision',
    min: 1
  });
  if (expected.viewer_seat !== undefined && value.viewer_seat !== expected.viewer_seat) {
    throw contractError('/viewer_seat', 'state projection belongs to another member');
  }
  if (expected.state_revision !== undefined
    && value.state_revision !== expected.state_revision) {
    throw contractError('/state_revision', 'state projection revision differs from checkpoint');
  }
  assertObject(value.shared_world, {
    allowed: SHARED_WORLD_FIELDS,
    path: '/shared_world',
    label: 'member-visible shared world'
  });
  assertObject(value.actors, {
    allowed: ROOM_SEATS,
    path: '/actors',
    label: 'member-visible actors'
  });
  for (const seat of ROOM_SEATS) assertActor(value.actors[seat], `/actors/${seat}`);
  if (value.actors.A.room_actor_id === value.actors.B.room_actor_id) {
    throw contractError('/actors', 'member state projection requires two distinct actors');
  }
  const counterpartSeat = value.viewer_seat === 'A' ? 'B' : 'A';
  const counterpart = value.actors[counterpartSeat];
  assertObject(counterpart.player, {
    allowed: COUNTERPART_PUBLIC_PLAYER_FIELDS,
    path: `/actors/${counterpartSeat}/player`,
    label: 'counterpart public player profile'
  });
  assertNoCounterpartPrivatePlayerKeys(counterpart.player, `/actors/${counterpartSeat}/player`);
  for (const field of ['skills', 'equipment', 'missions', 'private_knowledge']) {
    if (!isStructurallyEmpty(counterpart[field])) {
      throw contractError(
        `/actors/${counterpartSeat}/${field}`,
        'counterpart private actor partition must be empty'
      );
    }
  }
  const viewerActorId = value.actors[value.viewer_seat].room_actor_id;
  assertArray(value.relationships, {
    path: '/relationships',
    label: 'member-visible relationships',
    max: 10_000,
    uniqueBy: edge => edge?.edge_id,
    item: (edge, path) => {
      assertObject(edge, {
        allowed: RELATIONSHIP_FIELDS,
        path,
        label: 'member-visible relationship'
      });
      for (const field of ['edge_id', 'source_actor_id', 'target_actor_id']) {
        assertIdentifier(edge[field], { path: `${path}/${field}`, label: field });
      }
      if (edge.source_actor_id !== viewerActorId) {
        throw contractError(
          `${path}/source_actor_id`,
          'relationship projection may expose only the viewer actor as source'
        );
      }
    }
  });
  assertObject(value.memories, {
    allowed: ['shared', 'personal'],
    path: '/memories',
    label: 'member-visible memories'
  });
  return immutableContractValue(value);
}

export function inspectMemberStateProjection(value, expected) {
  return inspectContract(value, candidate => assertMemberStateProjection(candidate, expected));
}
