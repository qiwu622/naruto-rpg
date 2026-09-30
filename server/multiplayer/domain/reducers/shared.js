import { canonicalStringify, canonicalizeJson, sha256Hex } from '../canonical-json.js';
import { DomainError } from '../errors.js';
import {
  assertMultiplayerRoomState,
  assertStableRoomActorIds
} from '../../contracts/state-contracts.js';

export const REDUCER_OPERATION_RECEIPT_SCHEMA =
  'naruto.multiplayer-reducer-operation-receipt/v1';
export const REDUCER_INTEGRITY_POLICY_SCHEMA =
  'naruto.multiplayer-reducer-integrity-policy/v1';

export const INTEGRITY_POLICY = deepFreeze(canonicalizeJson({
  schema: REDUCER_INTEGRITY_POLICY_SCHEMA,
  version: '1',
  system_derived_operations: [{
    policy_id: 'npc-display-name-cache-refresh',
    policy_version: '1',
    allowed_effect: {
      domain: 'relationship',
      kind: 'npc_profile',
      operation: 'rename'
    },
    allowed_targets: [
      'relationship_display_name_cache',
      'memory_subject_display_name_cache',
      'combat_participant_display_name_cache'
    ],
    forbidden_semantic_changes: [
      'actor_resource',
      'actor_progression',
      'relationship_value',
      'mission_result',
      'combat_result',
      'memory_fact',
      'memory_audience'
    ]
  }]
}));

export const INTEGRITY_POLICY_HASH = `sha256:${sha256Hex(INTEGRITY_POLICY)}`;

export function fail(code, message, details = {}) {
  throw new DomainError(code, message, details);
}

export function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function assertRecord(value, label, details = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_EFFECT_PAYLOAD', `${label} must be a plain object`, details);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('INVALID_EFFECT_PAYLOAD', `${label} must be a plain object`, details);
  }
  return value;
}

export function assertExactObject(value, {
  label,
  allowed,
  required = allowed,
  code = 'INVALID_EFFECT_PAYLOAD'
}) {
  assertRecord(value, label);
  const allowedSet = new Set(allowed);
  const requiredSet = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail(code, `${label} contains an unknown property`, { field: key });
    }
  }
  for (const key of requiredSet) {
    if (!own(value, key)) {
      fail(code, `${label} is missing a required property`, { field: key });
    }
  }
  return value;
}

export function assertString(value, label, {
  min = 1,
  max = 256,
  pattern = null,
  enumValues = null,
  code = 'INVALID_EFFECT_PAYLOAD'
} = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(code, `${label} must be a bounded string`, { min, max });
  }
  if (pattern && !pattern.test(value)) {
    fail(code, `${label} has an invalid format`);
  }
  if (enumValues && !enumValues.includes(value)) {
    fail(code, `${label} is not an allowed value`, { allowed_values: enumValues });
  }
  return value;
}

export function assertIdentifier(value, label, {
  prefixes = null,
  code = 'INVALID_EFFECT_PAYLOAD'
} = {}) {
  assertString(value, label, {
    min: 2,
    max: 160,
    pattern: /^[A-Za-z][A-Za-z0-9:_-]*$/,
    code
  });
  if (prefixes && !prefixes.some(prefix => value.startsWith(prefix))) {
    fail(code, `${label} has an invalid identifier namespace`, {
      allowed_prefixes: prefixes
    });
  }
  return value;
}

export function assertInteger(value, label, {
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
  code = 'INVALID_EFFECT_PAYLOAD'
} = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(code, `${label} must be a safe integer within its bounds`, { min, max });
  }
  return value;
}

export function assertBoolean(value, label, code = 'INVALID_EFFECT_PAYLOAD') {
  if (typeof value !== 'boolean') fail(code, `${label} must be a boolean`);
  return value;
}

export function assertNullableString(value, label, options = {}) {
  if (value === null) return null;
  return assertString(value, label, options);
}

export function assertArray(value, label, {
  min = 0,
  max = 256,
  item = null,
  uniqueBy = null,
  code = 'INVALID_EFFECT_PAYLOAD'
} = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(code, `${label} must be an array within its item limit`, { min, max });
  }
  const seen = uniqueBy ? new Set() : null;
  for (let index = 0; index < value.length; index += 1) {
    item?.(value[index], `${label}[${index}]`, index);
    if (uniqueBy) {
      const identity = uniqueBy(value[index]);
      if (seen.has(identity)) {
        fail(code, `${label} contains a duplicate item`, { identity });
      }
      seen.add(identity);
    }
  }
  return value;
}

export function assertVersionStep(expectedVersion, nextVersion, currentVersion, label = 'entity') {
  if (expectedVersion !== currentVersion) {
    fail('EFFECT_PRECONDITION_FAILED', `${label} version precondition failed`, {
      expected_version: expectedVersion,
      actual_version: currentVersion
    });
  }
  assertInteger(expectedVersion, `${label}.expected_version`, { min: 0 });
  assertInteger(nextVersion, `${label}.next_version`, { min: 1 });
  if (nextVersion !== expectedVersion + 1) {
    fail('INVALID_EFFECT_PAYLOAD', `${label}.next_version must increment exactly once`, {
      expected_version: expectedVersion,
      next_version: nextVersion
    });
  }
}

export function assertCreateVersion(expectedVersion, nextVersion, exists, label = 'entity') {
  if (expectedVersion !== null || nextVersion !== 1) {
    fail('INVALID_EFFECT_PAYLOAD', `${label} creation requires null -> version 1`, {
      expected_version: expectedVersion,
      next_version: nextVersion
    });
  }
  if (exists) {
    fail('EFFECT_PRECONDITION_FAILED', `${label} already exists`);
  }
}

export function assertExpectedValue(expected, actual, label) {
  if (canonicalStringify(expected) !== canonicalStringify(actual)) {
    fail('EFFECT_PRECONDITION_FAILED', `${label} precondition failed`, {
      expected: canonicalizeJson(expected),
      actual: canonicalizeJson(actual)
    });
  }
}

export function immutableCanonical(value) {
  return deepFreeze(canonicalizeJson(value));
}

export function cloneCandidate(baseCandidate) {
  return canonicalizeJson(assertMultiplayerRoomState(baseCandidate));
}

export function findActor(candidate, actorId) {
  assertIdentifier(actorId, 'target.actor_id', { prefixes: ['actor:'] });
  for (const seat of ['A', 'B']) {
    if (candidate.actors[seat].room_actor_id === actorId) {
      return { seat, actor: candidate.actors[seat] };
    }
  }
  fail('EFFECT_TARGET_NOT_FOUND', 'effect target actor does not exist', {
    actor_id: actorId
  });
}

export function findById(entries, idField, id, label) {
  const index = entries.findIndex(entry => entry?.[idField] === id);
  if (index < 0) {
    fail('EFFECT_TARGET_NOT_FOUND', `${label} does not exist`, { [idField]: id });
  }
  return { index, value: entries[index] };
}

export function insertSorted(entries, entity, idField) {
  entries.push(entity);
  entries.sort((left, right) => compareText(left[idField], right[idField]));
}

export function replaceSorted(entries, index, entity, idField) {
  entries[index] = entity;
  entries.sort((left, right) => compareText(left[idField], right[idField]));
}

export function assertDomainContainer(value, schema, label, entriesField = 'entries') {
  assertExactObject(value, {
    label,
    allowed: ['schema', entriesField],
    code: 'INVALID_CANDIDATE_STATE'
  });
  if (value.schema !== schema) {
    fail('INVALID_CANDIDATE_STATE', `${label} has an unsupported schema`, {
      expected_schema: schema,
      actual_schema: value.schema
    });
  }
  assertArray(value[entriesField], `${label}.${entriesField}`, {
    max: 10_000,
    code: 'INVALID_CANDIDATE_STATE'
  });
  return value;
}

export function operationReceipt({
  effect,
  reducerKey,
  reducerVersion,
  primary,
  systemDerived = []
}) {
  const material = canonicalizeJson({
    schema: REDUCER_OPERATION_RECEIPT_SCHEMA,
    effect_id: effect.effect_id,
    effect_hash: effect.effect_hash,
    effect_seq: effect.effect_seq,
    required_reducer: reducerKey,
    reducer_version: reducerVersion,
    integrity_policy_hash: INTEGRITY_POLICY_HASH,
    primary,
    system_derived: systemDerived
  });
  return immutableCanonical({
    ...material,
    operation_hash: `sha256:${sha256Hex(material)}`
  });
}

export function reducerResult({
  baseCandidate,
  nextCandidate,
  effect,
  reducerKey,
  reducerVersion,
  primary,
  systemDerived = [],
  invariantResults = []
}) {
  const acceptedNext = assertMultiplayerRoomState(nextCandidate);
  assertStableRoomActorIds(baseCandidate, acceptedNext);
  const receipt = operationReceipt({
    effect,
    reducerKey,
    reducerVersion,
    primary,
    systemDerived
  });
  return immutableCanonical({
    nextCandidate: acceptedNext,
    normalizedOperations: [receipt],
    invariantResults: invariantResults.map(result => ({
      status: 'PASS',
      ...result
    }))
  });
}

export function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
