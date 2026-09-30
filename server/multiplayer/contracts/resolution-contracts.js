import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';
import {
  ACTION_OUTCOME_STATUSES,
  CONFLICT_TYPES
} from './enums.js';
import {
  COMPILED_EFFECT_DAG_SCHEMA,
  topologicalSortEffects
} from '../domain/effect-dag.js';
import { canonicalStringify } from '../domain/canonical-json.js';

export const RESOLUTION_CANDIDATE_SCHEMA = 'naruto.multiplayer-resolution-candidate/v1';
export const CANONICAL_RESOLUTION_SCHEMA = 'naruto.multiplayer-resolution/v1';

export const RESOLUTION_LIMITS = Object.freeze({
  maxConflicts: 64,
  maxOutcomes: 16,
  maxEvents: 256,
  maxEffects: 256,
  maxReferences: 256,
  maxRuleBasisItems: 64,
  maxSummaryLength: 2_000,
  maxReasonLength: 4_000,
  maxElapsedTimeLength: 256,
  maxStopPointLength: 2_000
});

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const IDENTIFIER_PATTERN = '^[A-Za-z][A-Za-z0-9:_-]*$';
const EVENT_ID_PATTERN = '^event_[A-Za-z0-9_-]{1,122}$';
const EFFECT_ID_PATTERN = '^effect_[A-Za-z0-9_-]{1,80}$';
const CONFLICT_ID_PATTERN = '^conflict_[A-Za-z0-9_-]{1,119}$';
const HMAC_SHA256_PATTERN = '^hmac-sha256:[a-f0-9]{64}$';
const SHA256_PATTERN = '^sha256:[a-f0-9]{64}$';
const REDUCER_PATTERN = '^[a-z][a-z0-9_]{0,127}$';

const identifierSchema = (pattern = IDENTIFIER_PATTERN, maxLength = 160) => ({
  type: 'string',
  minLength: 2,
  maxLength,
  pattern
});

const uniqueRefListSchema = (items, minItems = 0, maxItems = RESOLUTION_LIMITS.maxReferences) => ({
  type: 'array',
  minItems,
  maxItems,
  uniqueItems: true,
  items
});

const conflictJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'submission_ids', 'rule_basis'],
  properties: {
    id: identifierSchema(CONFLICT_ID_PATTERN, 128),
    type: { type: 'string', enum: CONFLICT_TYPES },
    submission_ids: uniqueRefListSchema(identifierSchema(), 1, 2),
    rule_basis: uniqueRefListSchema({
      type: 'string',
      minLength: 1,
      maxLength: RESOLUTION_LIMITS.maxReasonLength
    }, 1, RESOLUTION_LIMITS.maxRuleBasisItems)
  }
};

const outcomeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['submission_id', 'status', 'reason', 'event_ids'],
  properties: {
    submission_id: identifierSchema(),
    status: { type: 'string', enum: ACTION_OUTCOME_STATUSES },
    reason: { type: 'string', minLength: 1, maxLength: RESOLUTION_LIMITS.maxReasonLength },
    event_ids: uniqueRefListSchema(identifierSchema(EVENT_ID_PATTERN, 128), 1)
  }
};

const eventJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['event_id', 'summary', 'audiences', 'world_public', 'effect_ids'],
  properties: {
    event_id: identifierSchema(EVENT_ID_PATTERN, 128),
    summary: { type: 'string', minLength: 1, maxLength: RESOLUTION_LIMITS.maxSummaryLength },
    audiences: {
      ...uniqueRefListSchema(identifierSchema(), 1),
      description: '玩家受众用 seat:A 或 seat:B；双方可见列出两者。不要填写角色实体 room_actor_id。world_public 不代替席位可见性。'
    },
    world_public: { type: 'boolean' },
    effect_ids: uniqueRefListSchema(identifierSchema(EFFECT_ID_PATTERN, 87))
  }
};

const semanticEffectProperties = {
  effect_id: identifierSchema(EFFECT_ID_PATTERN, 87),
  depends_on_effect_ids: uniqueRefListSchema(identifierSchema(EFFECT_ID_PATTERN, 87)),
  event_id: identifierSchema(EVENT_ID_PATTERN, 128),
  // Target and payload are typed-reducer-owned JSON objects. Their fixed
  // schemas are deliberately not invented at this generic DAG boundary.
  target: { type: 'object', minProperties: 1 },
  domain: { type: 'string', minLength: 1, maxLength: 128 },
  kind: { type: 'string', minLength: 1, maxLength: 128 },
  operation: { type: 'string', minLength: 1, maxLength: 128 },
  payload: { type: 'object' },
  provenance: { type: 'string', minLength: 1, maxLength: 128 },
  visibility: { const: 'server_only' },
  evidence_event_ids: uniqueRefListSchema(identifierSchema(EVENT_ID_PATTERN, 128), 1),
  summary: { type: 'string', minLength: 1, maxLength: RESOLUTION_LIMITS.maxSummaryLength },
  unit: { type: 'string', minLength: 1, maxLength: 128 },
  rule_refs: uniqueRefListSchema(
    { type: 'string', minLength: 1, maxLength: 128 },
    0,
    RESOLUTION_LIMITS.maxReferences
  )
};

const semanticEffectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
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
  ],
  properties: semanticEffectProperties
};

const compiledEffectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...semanticEffectJsonSchema.required,
    'effect_seq',
    'required_reducer',
    'reducer_version',
    'effect_hash'
  ],
  properties: {
    ...semanticEffectProperties,
    effect_seq: { type: 'integer', minimum: 1, maximum: RESOLUTION_LIMITS.maxEffects },
    required_reducer: { type: 'string', pattern: REDUCER_PATTERN, maxLength: 128 },
    reducer_version: { type: 'string', minLength: 1, maxLength: 160 },
    effect_hash: { type: 'string', pattern: SHA256_PATTERN }
  }
};

const resolutionSemanticProperties = {
  conflicts: {
    type: 'array',
    minItems: 1,
    maxItems: RESOLUTION_LIMITS.maxConflicts,
    items: conflictJsonSchema
  },
  outcomes: {
    type: 'array',
    minItems: 1,
    maxItems: RESOLUTION_LIMITS.maxOutcomes,
    items: outcomeJsonSchema
  },
  events: {
    type: 'array',
    minItems: 1,
    maxItems: RESOLUTION_LIMITS.maxEvents,
    items: eventJsonSchema
  },
  elapsed_time: {
    type: 'string',
    minLength: 1,
    maxLength: RESOLUTION_LIMITS.maxElapsedTimeLength
  },
  stop_point: {
    type: 'string',
    minLength: 1,
    maxLength: RESOLUTION_LIMITS.maxStopPointLength
  }
};

export const RESOLUTION_CANDIDATE_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: RESOLUTION_CANDIDATE_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'conflicts',
    'outcomes',
    'events',
    'effects',
    'elapsed_time',
    'stop_point'
  ],
  properties: {
    schema: { const: RESOLUTION_CANDIDATE_SCHEMA },
    ...resolutionSemanticProperties,
    effects: {
      type: 'array',
      maxItems: RESOLUTION_LIMITS.maxEffects,
      items: semanticEffectJsonSchema
    }
  }
});

export const CANONICAL_RESOLUTION_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: CANONICAL_RESOLUTION_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'turn_id',
    'base_state_revision',
    'input_hash',
    'conflicts',
    'outcomes',
    'events',
    'effects',
    'elapsed_time',
    'stop_point'
  ],
  properties: {
    schema: { const: CANONICAL_RESOLUTION_SCHEMA },
    turn_id: identifierSchema('^turn_[A-Za-z0-9_-]{1,155}$', 160),
    base_state_revision: { type: 'integer', minimum: 0 },
    input_hash: { type: 'string', pattern: HMAC_SHA256_PATTERN },
    ...resolutionSemanticProperties,
    effects: {
      type: 'array',
      maxItems: RESOLUTION_LIMITS.maxEffects,
      items: compiledEffectJsonSchema
    }
  }
});

const RESOLUTION_CANDIDATE_KEYS = Object.freeze([
  'schema',
  'conflicts',
  'outcomes',
  'events',
  'effects',
  'elapsed_time',
  'stop_point'
]);

const CANONICAL_RESOLUTION_KEYS = Object.freeze([
  'schema',
  'turn_id',
  'base_state_revision',
  'input_hash',
  'conflicts',
  'outcomes',
  'events',
  'effects',
  'elapsed_time',
  'stop_point'
]);

const RESOLUTION_BINDING_KEYS = Object.freeze([
  'turn_id',
  'base_state_revision',
  'input_hash',
  'submission_ids'
]);

const CONFLICT_KEYS = Object.freeze([
  'id',
  'type',
  'submission_ids',
  'rule_basis'
]);

const OUTCOME_KEYS = Object.freeze([
  'submission_id',
  'status',
  'reason',
  'event_ids'
]);

const EVENT_KEYS = Object.freeze([
  'event_id',
  'summary',
  'audiences',
  'world_public',
  'effect_ids'
]);

const SEMANTIC_EFFECT_REQUIRED_KEYS = Object.freeze([
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

const SEMANTIC_EFFECT_OPTIONAL_KEYS = Object.freeze([
  'summary',
  'unit',
  'rule_refs'
]);

const SEMANTIC_EFFECT_KEYS = Object.freeze([
  ...SEMANTIC_EFFECT_REQUIRED_KEYS,
  ...SEMANTIC_EFFECT_OPTIONAL_KEYS
]);

const COMPILED_EFFECT_REQUIRED_KEYS = Object.freeze([
  ...SEMANTIC_EFFECT_REQUIRED_KEYS,
  'effect_seq',
  'required_reducer',
  'reducer_version',
  'effect_hash'
]);

const COMPILED_EFFECT_KEYS = Object.freeze([
  ...COMPILED_EFFECT_REQUIRED_KEYS,
  ...SEMANTIC_EFFECT_OPTIONAL_KEYS
]);

const HMAC_SHA256 = /^hmac-sha256:[a-f0-9]{64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REDUCER_KEY = /^[a-z][a-z0-9_]{0,127}$/;

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function pathFor(path, key) {
  return path === '/' ? `/${key}` : `${path}/${key}`;
}

function assertUniqueStrings(value, {
  path,
  label,
  min = 0,
  max = RESOLUTION_LIMITS.maxReferences,
  validate
}) {
  const seen = new Set();
  assertArray(value, {
    path,
    label,
    min,
    max,
    item(item, itemPath) {
      validate(item, itemPath);
      if (seen.has(item)) {
        throw contractError(itemPath, `${label} contains a duplicate reference`, {
          duplicate_reference: item
        });
      }
      seen.add(item);
    }
  });
  return value;
}

function assertSubmissionId(value, path) {
  return assertIdentifier(value, {
    path,
    label: 'submission_id',
    max: 160
  });
}

function assertEventId(value, path) {
  return assertIdentifier(value, {
    path,
    label: 'event_id',
    prefix: 'event_',
    max: 128
  });
}

function assertEffectId(value, path) {
  return assertIdentifier(value, {
    path,
    label: 'effect_id',
    prefix: 'effect_',
    max: 128
  });
}

function normalizeConflict(value, path) {
  assertExactKeys(value, {
    allowed: CONFLICT_KEYS,
    path,
    label: 'resolution conflict'
  });
  assertIdentifier(value.id, {
    path: pathFor(path, 'id'),
    label: 'conflict id',
    prefix: 'conflict_',
    max: 128
  });
  assertString(value.type, {
    path: pathFor(path, 'type'),
    label: 'conflict type',
    enumValues: CONFLICT_TYPES,
    max: 64
  });
  assertUniqueStrings(value.submission_ids, {
    path: pathFor(path, 'submission_ids'),
    label: 'conflict submission_ids',
    min: 1,
    max: 2,
    validate: assertSubmissionId
  });
  assertUniqueStrings(value.rule_basis, {
    path: pathFor(path, 'rule_basis'),
    label: 'conflict rule_basis',
    min: 1,
    max: RESOLUTION_LIMITS.maxRuleBasisItems,
    validate(item, itemPath) {
      assertString(item, {
        path: itemPath,
        label: 'rule basis',
        max: RESOLUTION_LIMITS.maxReasonLength
      });
    }
  });
  return immutableContractValue({
    id: value.id,
    type: value.type,
    submission_ids: [...value.submission_ids].sort(compareText),
    rule_basis: [...value.rule_basis].sort(compareText)
  });
}

function normalizeOutcome(value, path) {
  assertExactKeys(value, {
    allowed: OUTCOME_KEYS,
    path,
    label: 'resolution outcome'
  });
  assertSubmissionId(value.submission_id, pathFor(path, 'submission_id'));
  assertString(value.status, {
    path: pathFor(path, 'status'),
    label: 'outcome status',
    enumValues: ACTION_OUTCOME_STATUSES,
    max: 64
  });
  assertString(value.reason, {
    path: pathFor(path, 'reason'),
    label: 'outcome reason',
    max: RESOLUTION_LIMITS.maxReasonLength
  });
  assertUniqueStrings(value.event_ids, {
    path: pathFor(path, 'event_ids'),
    label: 'outcome event_ids',
    min: 1,
    validate: assertEventId
  });
  return immutableContractValue({
    submission_id: value.submission_id,
    status: value.status,
    reason: value.reason,
    event_ids: [...value.event_ids].sort(compareText)
  });
}

function normalizeEvent(value, path) {
  assertExactKeys(value, {
    allowed: EVENT_KEYS,
    path,
    label: 'canonical event'
  });
  assertEventId(value.event_id, pathFor(path, 'event_id'));
  assertString(value.summary, {
    path: pathFor(path, 'summary'),
    label: 'event summary',
    max: RESOLUTION_LIMITS.maxSummaryLength
  });
  assertUniqueStrings(value.audiences, {
    path: pathFor(path, 'audiences'),
    label: 'event audiences',
    min: 1,
    validate(item, itemPath) {
      assertIdentifier(item, {
        path: itemPath,
        label: 'event audience',
        max: 160
      });
    }
  });
  assertBoolean(value.world_public, {
    path: pathFor(path, 'world_public'),
    label: 'world_public'
  });
  assertUniqueStrings(value.effect_ids, {
    path: pathFor(path, 'effect_ids'),
    label: 'event effect_ids',
    validate: assertEffectId
  });
  return immutableContractValue({
    event_id: value.event_id,
    summary: value.summary,
    audiences: [...value.audiences].sort(compareText),
    world_public: value.world_public,
    effect_ids: [...value.effect_ids].sort(compareText)
  });
}

function assertUniqueIdentity(records, identityKey, path, label) {
  const seen = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const identity = records[index][identityKey];
    if (seen.has(identity)) {
      throw contractError(`${path}/${index}/${identityKey}`, `${label} must be unique`, {
        duplicate_id: identity
      });
    }
    seen.add(identity);
  }
  return seen;
}

function assertClosedReference(reference, known, path, label) {
  if (!known.has(reference)) {
    throw contractError(path, `${label} is not defined in this resolution`, {
      dangling_reference: reference
    });
  }
}

function normalizeSemanticEffects(value, path = '/effects') {
  assertArray(value, {
    path,
    label: 'resolution effects',
    max: RESOLUTION_LIMITS.maxEffects
  });

  // This is the single source of truth for the model-visible effect shape,
  // dependency closure and stable topological ordering. It also rejects every
  // server-bound effect_seq/hash/reducer field before a resolver is involved.
  return topologicalSortEffects(value);
}

function normalizeCandidateParts(candidate, path = '/') {
  assertExactKeys(candidate, {
    allowed: RESOLUTION_CANDIDATE_KEYS,
    path,
    label: 'resolution candidate'
  });
  assertString(candidate.schema, {
    path: pathFor(path, 'schema'),
    label: 'resolution candidate schema',
    enumValues: [RESOLUTION_CANDIDATE_SCHEMA],
    max: 128
  });

  const conflicts = [];
  assertArray(candidate.conflicts, {
    path: pathFor(path, 'conflicts'),
    label: 'resolution conflicts',
    min: 1,
    max: RESOLUTION_LIMITS.maxConflicts,
    item(item, itemPath) {
      conflicts.push(normalizeConflict(item, itemPath));
    }
  });

  const outcomes = [];
  assertArray(candidate.outcomes, {
    path: pathFor(path, 'outcomes'),
    label: 'resolution outcomes',
    min: 1,
    max: RESOLUTION_LIMITS.maxOutcomes,
    item(item, itemPath) {
      outcomes.push(normalizeOutcome(item, itemPath));
    }
  });

  const events = [];
  assertArray(candidate.events, {
    path: pathFor(path, 'events'),
    label: 'resolution events',
    min: 1,
    max: RESOLUTION_LIMITS.maxEvents,
    item(item, itemPath) {
      events.push(normalizeEvent(item, itemPath));
    }
  });

  conflicts.sort((left, right) => compareText(left.id, right.id));
  outcomes.sort((left, right) => compareText(left.submission_id, right.submission_id));
  events.sort((left, right) => compareText(left.event_id, right.event_id));

  const effects = normalizeSemanticEffects(candidate.effects, pathFor(path, 'effects'));
  assertString(candidate.elapsed_time, {
    path: pathFor(path, 'elapsed_time'),
    label: 'elapsed_time',
    max: RESOLUTION_LIMITS.maxElapsedTimeLength
  });
  assertString(candidate.stop_point, {
    path: pathFor(path, 'stop_point'),
    label: 'stop_point',
    max: RESOLUTION_LIMITS.maxStopPointLength
  });

  const conflictIds = assertUniqueIdentity(conflicts, 'id', pathFor(path, 'conflicts'), 'conflict id');
  const submissionIds = assertUniqueIdentity(
    outcomes,
    'submission_id',
    pathFor(path, 'outcomes'),
    'outcome submission_id'
  );
  const eventIds = assertUniqueIdentity(events, 'event_id', pathFor(path, 'events'), 'event_id');
  const effectIds = assertUniqueIdentity(effects, 'effect_id', pathFor(path, 'effects'), 'effect_id');

  // Keep the variables deliberately used: this documents all four identity
  // registries and avoids accidentally weakening one registry during edits.
  void conflictIds;

  for (let conflictIndex = 0; conflictIndex < conflicts.length; conflictIndex += 1) {
    for (let refIndex = 0; refIndex < conflicts[conflictIndex].submission_ids.length; refIndex += 1) {
      const reference = conflicts[conflictIndex].submission_ids[refIndex];
      assertClosedReference(
        reference,
        submissionIds,
        `${pathFor(path, 'conflicts')}/${conflictIndex}/submission_ids/${refIndex}`,
        'conflict submission reference'
      );
    }
  }

  const outcomeEventCoverage = new Set();
  for (let outcomeIndex = 0; outcomeIndex < outcomes.length; outcomeIndex += 1) {
    for (let refIndex = 0; refIndex < outcomes[outcomeIndex].event_ids.length; refIndex += 1) {
      const reference = outcomes[outcomeIndex].event_ids[refIndex];
      assertClosedReference(
        reference,
        eventIds,
        `${pathFor(path, 'outcomes')}/${outcomeIndex}/event_ids/${refIndex}`,
        'outcome event reference'
      );
      outcomeEventCoverage.add(reference);
    }
  }
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    if (!outcomeEventCoverage.has(events[eventIndex].event_id)) {
      throw contractError(
        `${pathFor(path, 'events')}/${eventIndex}/event_id`,
        'canonical event is not reachable from any outcome',
        { event_id: events[eventIndex].event_id }
      );
    }
  }

  const eventEffectOwner = new Map();
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    for (let refIndex = 0; refIndex < events[eventIndex].effect_ids.length; refIndex += 1) {
      const reference = events[eventIndex].effect_ids[refIndex];
      const referencePath = `${pathFor(path, 'events')}/${eventIndex}/effect_ids/${refIndex}`;
      assertClosedReference(reference, effectIds, referencePath, 'event effect reference');
      if (eventEffectOwner.has(reference)) {
        throw contractError(referencePath, 'an effect_id can be owned by only one canonical event', {
          effect_id: reference,
          first_event_id: eventEffectOwner.get(reference),
          second_event_id: events[eventIndex].event_id
        });
      }
      eventEffectOwner.set(reference, events[eventIndex].event_id);
    }
  }

  for (let effectIndex = 0; effectIndex < effects.length; effectIndex += 1) {
    const effect = effects[effectIndex];
    assertClosedReference(
      effect.event_id,
      eventIds,
      `${pathFor(path, 'effects')}/${effectIndex}/event_id`,
      'effect primary event reference'
    );
    if (eventEffectOwner.get(effect.effect_id) !== effect.event_id) {
      throw contractError(
        `${pathFor(path, 'effects')}/${effectIndex}/event_id`,
        'effect must appear exactly once in its primary event effect_ids',
        {
          effect_id: effect.effect_id,
          primary_event_id: effect.event_id,
          declared_event_id: eventEffectOwner.get(effect.effect_id) ?? null
        }
      );
    }
    for (let evidenceIndex = 0; evidenceIndex < effect.evidence_event_ids.length; evidenceIndex += 1) {
      assertClosedReference(
        effect.evidence_event_ids[evidenceIndex],
        eventIds,
        `${pathFor(path, 'effects')}/${effectIndex}/evidence_event_ids/${evidenceIndex}`,
        'effect evidence event reference'
      );
    }
  }

  return immutableContractValue({
    schema: RESOLUTION_CANDIDATE_SCHEMA,
    conflicts,
    outcomes,
    events,
    effects,
    elapsed_time: candidate.elapsed_time,
    stop_point: candidate.stop_point
  });
}

/** Strict model-facing contract. No turn, revision, digest or compiled routing fields are accepted. */
export function assertResolutionCandidate(candidate) {
  return normalizeCandidateParts(immutableContractValue(candidate));
}

export const normalizeResolutionCandidate = assertResolutionCandidate;

export function inspectResolutionCandidate(candidate) {
  return inspectContract(candidate, assertResolutionCandidate);
}

function normalizeResolutionBinding(binding) {
  binding = immutableContractValue(binding);
  assertExactKeys(binding, {
    allowed: RESOLUTION_BINDING_KEYS,
    path: '/binding',
    label: 'canonical resolution binding'
  });
  assertIdentifier(binding.turn_id, {
    path: '/binding/turn_id',
    label: 'turn_id',
    prefix: 'turn_',
    max: 160
  });
  assertInteger(binding.base_state_revision, {
    path: '/binding/base_state_revision',
    label: 'base_state_revision',
    min: 0
  });
  assertString(binding.input_hash, {
    path: '/binding/input_hash',
    label: 'input_hash',
    pattern: HMAC_SHA256,
    max: 80
  });
  assertUniqueStrings(binding.submission_ids, {
    path: '/binding/submission_ids',
    label: 'bound submission_ids',
    min: 2,
    max: 2,
    validate: assertSubmissionId
  });
  return immutableContractValue(binding);
}

function semanticEffectFromCompiled(effect, path) {
  assertExactKeys(effect, {
    allowed: COMPILED_EFFECT_KEYS,
    required: COMPILED_EFFECT_REQUIRED_KEYS,
    path,
    label: 'compiled effect'
  });
  assertInteger(effect.effect_seq, {
    path: pathFor(path, 'effect_seq'),
    label: 'effect_seq',
    min: 1,
    max: RESOLUTION_LIMITS.maxEffects
  });
  assertString(effect.required_reducer, {
    path: pathFor(path, 'required_reducer'),
    label: 'required_reducer',
    pattern: REDUCER_KEY,
    max: 128
  });
  assertString(effect.reducer_version, {
    path: pathFor(path, 'reducer_version'),
    label: 'reducer_version',
    max: 160
  });
  assertString(effect.effect_hash, {
    path: pathFor(path, 'effect_hash'),
    label: 'effect_hash',
    pattern: SHA256,
    max: 80
  });

  return Object.fromEntries(
    Object.entries(effect).filter(([key]) => SEMANTIC_EFFECT_KEYS.includes(key))
  );
}

function assertCompiledDagMatches(candidateEffects, compiledEffectDag) {
  compiledEffectDag = immutableContractValue(compiledEffectDag);
  assertExactKeys(compiledEffectDag, {
    allowed: ['schema', 'rule_snapshot_hash', 'effects'],
    path: '/compiled_effect_dag',
    label: 'compiled effect DAG'
  });
  assertString(compiledEffectDag.schema, {
    path: '/compiled_effect_dag/schema',
    label: 'compiled effect DAG schema',
    enumValues: [COMPILED_EFFECT_DAG_SCHEMA],
    max: 160
  });
  assertString(compiledEffectDag.rule_snapshot_hash, {
    path: '/compiled_effect_dag/rule_snapshot_hash',
    label: 'rule_snapshot_hash',
    pattern: SHA256,
    max: 80
  });
  assertArray(compiledEffectDag.effects, {
    path: '/compiled_effect_dag/effects',
    label: 'compiled effects',
    max: RESOLUTION_LIMITS.maxEffects
  });
  if (compiledEffectDag.effects.length !== candidateEffects.length) {
    throw contractError('/compiled_effect_dag/effects', 'compiled DAG does not cover every candidate effect', {
      candidate_count: candidateEffects.length,
      compiled_count: compiledEffectDag.effects.length
    });
  }

  for (let index = 0; index < compiledEffectDag.effects.length; index += 1) {
    const effectPath = `/compiled_effect_dag/effects/${index}`;
    const semanticEffect = semanticEffectFromCompiled(compiledEffectDag.effects[index], effectPath);
    if (compiledEffectDag.effects[index].effect_seq !== index + 1) {
      throw contractError(`${effectPath}/effect_seq`, 'compiled effect_seq must be contiguous and 1-based', {
        expected: index + 1,
        actual: compiledEffectDag.effects[index].effect_seq
      });
    }
    if (canonicalStringify(semanticEffect) !== canonicalStringify(candidateEffects[index])) {
      throw contractError(effectPath, 'compiled effect semantics do not match the Referee candidate', {
        expected_effect_id: candidateEffects[index]?.effect_id ?? null,
        actual_effect_id: semanticEffect.effect_id ?? null
      });
    }
  }

  return immutableContractValue(compiledEffectDag.effects);
}

function assertSubmissionBinding(candidate, binding) {
  const expected = new Set(binding.submission_ids);
  const actual = new Set(candidate.outcomes.map(outcome => outcome.submission_id));
  if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) {
    throw contractError('/outcomes', 'outcomes must contain exactly one result for each server-bound submission', {
      expected_submission_ids: [...expected],
      actual_submission_ids: [...actual]
    });
  }

  const classified = new Set(candidate.conflicts.flatMap(conflict => conflict.submission_ids));
  if ([...expected].some(id => !classified.has(id))) {
    throw contractError('/conflicts', 'every server-bound submission must participate in conflict classification', {
      unclassified_submission_ids: [...expected].filter(id => !classified.has(id))
    });
  }
}

/**
 * Binds a validated Referee candidate to trusted turn context and to the DAG
 * returned by `compileEffectDag`. The candidate can never choose sequence,
 * effect hashes or reducer routing.
 */
export function freezeCanonicalResolution(candidate, binding, compiledEffectDag) {
  const normalizedCandidate = assertResolutionCandidate(candidate);
  const normalizedBinding = normalizeResolutionBinding(binding);
  assertSubmissionBinding(normalizedCandidate, normalizedBinding);
  const compiledEffects = assertCompiledDagMatches(
    normalizedCandidate.effects,
    compiledEffectDag
  );

  return immutableContractValue({
    schema: CANONICAL_RESOLUTION_SCHEMA,
    turn_id: normalizedBinding.turn_id,
    base_state_revision: normalizedBinding.base_state_revision,
    input_hash: normalizedBinding.input_hash,
    conflicts: normalizedCandidate.conflicts,
    outcomes: normalizedCandidate.outcomes,
    events: normalizedCandidate.events,
    effects: compiledEffects,
    elapsed_time: normalizedCandidate.elapsed_time,
    stop_point: normalizedCandidate.stop_point
  });
}

export const bindCanonicalResolution = freezeCanonicalResolution;

/** Strict validation for a stored/frozen CanonicalResolution. */
export function assertCanonicalResolution(resolution) {
  resolution = immutableContractValue(resolution);
  assertExactKeys(resolution, {
    allowed: CANONICAL_RESOLUTION_KEYS,
    path: '/',
    label: 'CanonicalResolution'
  });
  assertString(resolution.schema, {
    path: '/schema',
    label: 'CanonicalResolution schema',
    enumValues: [CANONICAL_RESOLUTION_SCHEMA],
    max: 128
  });
  assertIdentifier(resolution.turn_id, {
    path: '/turn_id',
    label: 'turn_id',
    prefix: 'turn_',
    max: 160
  });
  assertInteger(resolution.base_state_revision, {
    path: '/base_state_revision',
    label: 'base_state_revision',
    min: 0
  });
  assertString(resolution.input_hash, {
    path: '/input_hash',
    label: 'input_hash',
    pattern: HMAC_SHA256,
    max: 80
  });

  assertArray(resolution.effects, {
    path: '/effects',
    label: 'compiled effects',
    max: RESOLUTION_LIMITS.maxEffects
  });
  const semanticEffects = [];
  for (let index = 0; index < resolution.effects.length; index += 1) {
    const semanticEffect = semanticEffectFromCompiled(resolution.effects[index], `/effects/${index}`);
    if (resolution.effects[index].effect_seq !== index + 1) {
      throw contractError(`/effects/${index}/effect_seq`, 'effect_seq must be contiguous and 1-based');
    }
    semanticEffects.push(semanticEffect);
  }

  const candidate = normalizeCandidateParts({
    schema: RESOLUTION_CANDIDATE_SCHEMA,
    conflicts: resolution.conflicts,
    outcomes: resolution.outcomes,
    events: resolution.events,
    effects: semanticEffects,
    elapsed_time: resolution.elapsed_time,
    stop_point: resolution.stop_point
  });
  for (let index = 0; index < semanticEffects.length; index += 1) {
    if (canonicalStringify(semanticEffects[index]) !== canonicalStringify(candidate.effects[index])) {
      throw contractError(`/effects/${index}`, 'stored compiled effects are not in canonical DAG order');
    }
  }

  return immutableContractValue(resolution);
}

export function inspectCanonicalResolution(resolution) {
  return inspectContract(resolution, assertCanonicalResolution);
}
