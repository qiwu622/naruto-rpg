import { assertJsonSafe } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import {
  assertArray,
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertPlainRecord,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';
import { ROOM_SEATS } from './enums.js';

export const MULTIPLAYER_ROOM_STATE_SCHEMA = 'naruto.multiplayer-room-state/v1';

/**
 * These are the canonical JSON safety limits already used by the server's
 * canonicalizer. Domain-specific leaf schemas are intentionally deferred to
 * the versioned reducers in stage 1 instead of being guessed here.
 */
export const MULTIPLAYER_ROOM_STATE_LIMITS = Object.freeze({
  maxCanonicalDepth: 64,
  maxCanonicalNodes: 100_000,
  maxRelationships: 10_000
});

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const IDENTIFIER_PATTERN = '^[A-Za-z][A-Za-z0-9:_-]*$';
const DANGEROUS_PROPERTY_NAMES = Object.freeze([
  '__proto__',
  'prototype',
  'constructor'
]);

const ROOT_KEYS = Object.freeze([
  'schema',
  'meta',
  'shared_world',
  'actors',
  'relationships',
  'memories',
  'agent_internal'
]);
const META_KEYS = Object.freeze(['state_revision']);
const SHARED_WORLD_KEYS = Object.freeze([
  'world_state',
  'calendar',
  'map',
  'canonical_events',
  'shared_missions',
  'shared_combat',
  'continuity_ledger'
]);
const ACTOR_KEYS = Object.freeze([
  'room_actor_id',
  'player',
  'attributes',
  'progression',
  'skills',
  'equipment',
  'missions',
  'private_knowledge'
]);
const RELATIONSHIP_EDGE_KEYS = Object.freeze([
  'edge_id',
  'source_actor_id',
  'target_actor_id',
  'data'
]);
const MEMORY_KEYS = Object.freeze([
  'canonical',
  'shared',
  'actor:A',
  'actor:B',
  'npc_private'
]);
const AGENT_INTERNAL_KEYS = Object.freeze(['story_plan', 'audit_state']);

const identifierJsonSchema = {
  type: 'string',
  minLength: 2,
  maxLength: 160,
  pattern: IDENTIFIER_PATTERN
};

const canonicalDataRef = { $ref: '#/$defs/canonicalData' };

const actorJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ACTOR_KEYS,
  properties: {
    room_actor_id: identifierJsonSchema,
    player: canonicalDataRef,
    attributes: canonicalDataRef,
    progression: canonicalDataRef,
    skills: canonicalDataRef,
    equipment: canonicalDataRef,
    missions: canonicalDataRef,
    private_knowledge: canonicalDataRef
  }
};

const relationshipEdgeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: RELATIONSHIP_EDGE_KEYS,
  properties: {
    edge_id: identifierJsonSchema,
    source_actor_id: identifierJsonSchema,
    target_actor_id: identifierJsonSchema,
    data: canonicalDataRef
  }
};

/**
 * `control` is deliberately absent. A TurnDraft may clone this value without
 * cloning room control, presence, chat, billing selections or queued mode
 * changes. Root-level `additionalProperties: false` makes that boundary
 * machine enforceable.
 */
export const MULTIPLAYER_ROOM_STATE_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: MULTIPLAYER_ROOM_STATE_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: ROOT_KEYS,
  properties: {
    schema: { const: MULTIPLAYER_ROOM_STATE_SCHEMA },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: META_KEYS,
      properties: {
        state_revision: {
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER
        }
      }
    },
    shared_world: {
      type: 'object',
      additionalProperties: false,
      required: SHARED_WORLD_KEYS,
      properties: {
        world_state: canonicalDataRef,
        calendar: canonicalDataRef,
        map: canonicalDataRef,
        canonical_events: canonicalDataRef,
        shared_missions: canonicalDataRef,
        shared_combat: canonicalDataRef,
        continuity_ledger: canonicalDataRef
      }
    },
    actors: {
      type: 'object',
      additionalProperties: false,
      required: ROOM_SEATS,
      properties: {
        A: actorJsonSchema,
        B: actorJsonSchema
      }
    },
    relationships: {
      type: 'array',
      maxItems: MULTIPLAYER_ROOM_STATE_LIMITS.maxRelationships,
      uniqueItems: true,
      items: relationshipEdgeJsonSchema
    },
    memories: {
      type: 'object',
      additionalProperties: false,
      required: MEMORY_KEYS,
      properties: {
        canonical: canonicalDataRef,
        shared: canonicalDataRef,
        'actor:A': canonicalDataRef,
        'actor:B': canonicalDataRef,
        npc_private: canonicalDataRef
      }
    },
    agent_internal: {
      type: 'object',
      additionalProperties: false,
      required: AGENT_INTERNAL_KEYS,
      properties: {
        story_plan: canonicalDataRef,
        audit_state: canonicalDataRef
      }
    }
  },
  $defs: {
    canonicalData: {
      oneOf: [
        { type: 'null' },
        { type: 'boolean' },
        { type: 'number' },
        { type: 'string' },
        {
          type: 'array',
          items: canonicalDataRef
        },
        {
          type: 'object',
          propertyNames: {
            not: { enum: DANGEROUS_PROPERTY_NAMES }
          },
          additionalProperties: canonicalDataRef
        }
      ]
    }
  }
});

function assertObject(value, { allowed, path, label }) {
  assertPlainRecord(value, path || '/', label);
  return assertExactKeys(value, {
    allowed,
    required: allowed,
    path: path || '/',
    label
  });
}

function assertCanonicalRoomState(value) {
  try {
    assertJsonSafe(value, {
      maxDepth: MULTIPLAYER_ROOM_STATE_LIMITS.maxCanonicalDepth,
      maxNodes: MULTIPLAYER_ROOM_STATE_LIMITS.maxCanonicalNodes
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    throw contractError('/', 'multiplayer room state must be safe canonical JSON', {
      reason_code: error.code,
      source_path: error.details?.path ?? '$'
    });
  }
}

function assertActor(value, seat) {
  const path = `/actors/${seat}`;
  assertObject(value, {
    allowed: ACTOR_KEYS,
    path,
    label: `actor ${seat}`
  });
  assertIdentifier(value.room_actor_id, {
    path: `${path}/room_actor_id`,
    label: `actors.${seat}.room_actor_id`
  });
}

function assertRelationshipEdge(value, path) {
  assertObject(value, {
    allowed: RELATIONSHIP_EDGE_KEYS,
    path,
    label: 'directed relationship edge'
  });
  for (const field of ['edge_id', 'source_actor_id', 'target_actor_id']) {
    assertIdentifier(value[field], {
      path: `${path}/${field}`,
      label: `relationship ${field}`
    });
  }
}

export function assertMultiplayerRoomState(value) {
  // Validate JSON safety before reading nested values so accessors, symbols,
  // exotic prototypes and prototype-manipulation keys cannot cross the
  // contract boundary.
  assertCanonicalRoomState(value);

  assertObject(value, {
    allowed: ROOT_KEYS,
    path: '/',
    label: 'multiplayer room state'
  });
  if (value.schema !== MULTIPLAYER_ROOM_STATE_SCHEMA) {
    throw contractError('/schema', `schema must be ${MULTIPLAYER_ROOM_STATE_SCHEMA}`);
  }

  assertObject(value.meta, {
    allowed: META_KEYS,
    path: '/meta',
    label: 'room state meta'
  });
  assertInteger(value.meta.state_revision, {
    path: '/meta/state_revision',
    label: 'state_revision',
    min: 0
  });

  assertObject(value.shared_world, {
    allowed: SHARED_WORLD_KEYS,
    path: '/shared_world',
    label: 'shared world'
  });

  assertObject(value.actors, {
    allowed: ROOM_SEATS,
    path: '/actors',
    label: 'room actors'
  });
  for (const seat of ROOM_SEATS) assertActor(value.actors[seat], seat);
  if (value.actors.A.room_actor_id === value.actors.B.room_actor_id) {
    throw contractError(
      '/actors/B/room_actor_id',
      'both player actors must have distinct stable room_actor_id values'
    );
  }

  assertArray(value.relationships, {
    path: '/relationships',
    label: 'directed relationships',
    max: MULTIPLAYER_ROOM_STATE_LIMITS.maxRelationships,
    item: assertRelationshipEdge,
    uniqueBy: edge => edge.edge_id
  });

  assertObject(value.memories, {
    allowed: MEMORY_KEYS,
    path: '/memories',
    label: 'partitioned memories'
  });
  assertObject(value.agent_internal, {
    allowed: AGENT_INTERNAL_KEYS,
    path: '/agent_internal',
    label: 'agent internal state'
  });

  return immutableContractValue(value);
}

export function inspectMultiplayerRoomState(value) {
  return inspectContract(value, assertMultiplayerRoomState);
}

/**
 * Snapshot validation alone cannot prove identity stability across commits.
 * Persistence/reducer code must call this invariant when replacing one
 * accepted room state with another. Display names and object ordering are not
 * identity evidence.
 */
export function assertStableRoomActorIds(previousValue, nextValue) {
  const previous = assertMultiplayerRoomState(previousValue);
  const next = assertMultiplayerRoomState(nextValue);
  for (const seat of ROOM_SEATS) {
    if (previous.actors[seat].room_actor_id !== next.actors[seat].room_actor_id) {
      throw contractError(
        `/actors/${seat}/room_actor_id`,
        `actors.${seat}.room_actor_id is immutable within a room lineage`,
        {
          previous_room_actor_id: previous.actors[seat].room_actor_id,
          next_room_actor_id: next.actors[seat].room_actor_id
        }
      );
    }
  }
  return next;
}
