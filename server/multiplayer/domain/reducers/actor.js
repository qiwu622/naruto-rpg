import {
  assertArray,
  assertBoolean,
  assertCreateVersion,
  assertExactObject,
  assertIdentifier,
  assertInteger,
  assertNullableString,
  assertString,
  assertVersionStep,
  cloneCandidate,
  fail,
  findActor,
  findById,
  insertSorted,
  reducerResult,
  replaceSorted
} from './shared.js';

export const ACTOR_PROFILE_SCHEMA = 'naruto.multiplayer-actor-profile/v1';
export const ACTOR_ATTRIBUTES_SCHEMA = 'naruto.multiplayer-actor-attributes/v1';
export const ACTOR_PROGRESSION_SCHEMA = 'naruto.multiplayer-actor-progression/v1';

export const ACTOR_REDUCER_VERSIONS = Object.freeze({
  apply_actor_profile_effect: 'actor-profile-reducer/v1',
  apply_actor_resource_effect: 'actor-resource-reducer/v1',
  apply_actor_progression_effect: 'actor-progression-reducer/v1'
});

const PROFILE_STATUSES = Object.freeze([
  'ACTIVE',
  'INCAPACITATED',
  'MISSING',
  'DECEASED'
]);
const RESOURCE_IDS = Object.freeze([
  'chakra',
  'mental',
  'stamina',
  'vitality',
  'money'
]);
const RESOURCE_OPERATIONS = Object.freeze(['consume', 'gain', 'damage', 'heal']);
const PROFILE_CHANGE_KEYS = Object.freeze([
  'display_name',
  'rank',
  'goal',
  'alive',
  'status'
]);

function assertActorTarget(target, scope = 'actor') {
  assertExactObject(target, {
    label: 'effect target',
    allowed: ['scope', 'actor_id'],
    code: 'INVALID_EFFECT_TARGET'
  });
  if (target.scope !== scope) {
    fail('INVALID_EFFECT_TARGET', `target.scope must be ${scope}`);
  }
  assertIdentifier(target.actor_id, 'target.actor_id', {
    prefixes: ['actor:'],
    code: 'INVALID_EFFECT_TARGET'
  });
}

function assertActorEntityTarget(target, scope, idField, prefixes) {
  assertExactObject(target, {
    label: 'effect target',
    allowed: ['scope', 'actor_id', idField],
    code: 'INVALID_EFFECT_TARGET'
  });
  if (target.scope !== scope) {
    fail('INVALID_EFFECT_TARGET', `target.scope must be ${scope}`);
  }
  assertIdentifier(target.actor_id, 'target.actor_id', {
    prefixes: ['actor:'],
    code: 'INVALID_EFFECT_TARGET'
  });
  assertIdentifier(target[idField], `target.${idField}`, {
    prefixes,
    code: 'INVALID_EFFECT_TARGET'
  });
}

export function assertActorProfile(profile, label = 'actor.player') {
  assertExactObject(profile, {
    label,
    allowed: [
      'schema',
      'version',
      'display_name',
      'rank',
      'goal',
      'alive',
      'status'
    ],
    code: 'INVALID_CANDIDATE_STATE'
  });
  if (profile.schema !== ACTOR_PROFILE_SCHEMA) {
    fail('INVALID_CANDIDATE_STATE', `${label} has an unsupported schema`);
  }
  assertInteger(profile.version, `${label}.version`, { min: 0, code: 'INVALID_CANDIDATE_STATE' });
  assertString(profile.display_name, `${label}.display_name`, { max: 80, code: 'INVALID_CANDIDATE_STATE' });
  assertString(profile.rank, `${label}.rank`, { max: 80, code: 'INVALID_CANDIDATE_STATE' });
  assertString(profile.goal, `${label}.goal`, { max: 1_000, code: 'INVALID_CANDIDATE_STATE' });
  assertBoolean(profile.alive, `${label}.alive`, 'INVALID_CANDIDATE_STATE');
  assertString(profile.status, `${label}.status`, {
    enumValues: PROFILE_STATUSES,
    code: 'INVALID_CANDIDATE_STATE'
  });
  if ((profile.status === 'DECEASED') === profile.alive) {
    fail('INVALID_CANDIDATE_STATE', `${label}.alive conflicts with status`);
  }
  return profile;
}

function assertResource(resource, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(resource, {
    label,
    allowed: ['resource_id', 'version', 'current', 'maximum'],
    code
  });
  assertString(resource.resource_id, `${label}.resource_id`, {
    enumValues: RESOURCE_IDS,
    code
  });
  assertInteger(resource.version, `${label}.version`, { min: 0, code });
  assertInteger(resource.current, `${label}.current`, { min: 0, code });
  assertInteger(resource.maximum, `${label}.maximum`, { min: 0, code });
  if (resource.current > resource.maximum) {
    fail(code, `${label}.current cannot exceed maximum`);
  }
}

function assertInjury(injury, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(injury, {
    label,
    allowed: ['injury_id', 'version', 'label', 'severity', 'active'],
    code
  });
  assertIdentifier(injury.injury_id, `${label}.injury_id`, { prefixes: ['injury:'], code });
  assertInteger(injury.version, `${label}.version`, { min: 1, code });
  assertString(injury.label, `${label}.label`, { max: 160, code });
  assertInteger(injury.severity, `${label}.severity`, { min: 1, max: 5, code });
  assertBoolean(injury.active, `${label}.active`, code);
}

function assertPersistentStatus(status, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(status, {
    label,
    allowed: ['status_id', 'version', 'label', 'stacks', 'expires_calendar_ordinal'],
    code
  });
  assertIdentifier(status.status_id, `${label}.status_id`, { prefixes: ['status:'], code });
  assertInteger(status.version, `${label}.version`, { min: 1, code });
  assertString(status.label, `${label}.label`, { max: 160, code });
  assertInteger(status.stacks, `${label}.stacks`, { min: 1, max: 999, code });
  if (status.expires_calendar_ordinal !== null) {
    assertInteger(status.expires_calendar_ordinal, `${label}.expires_calendar_ordinal`, {
      min: 0,
      code
    });
  }
}

export function assertActorAttributes(attributes, label = 'actor.attributes') {
  assertExactObject(attributes, {
    label,
    allowed: ['schema', 'resources', 'injuries', 'persistent_statuses'],
    code: 'INVALID_CANDIDATE_STATE'
  });
  if (attributes.schema !== ACTOR_ATTRIBUTES_SCHEMA) {
    fail('INVALID_CANDIDATE_STATE', `${label} has an unsupported schema`);
  }
  assertArray(attributes.resources, `${label}.resources`, {
    max: RESOURCE_IDS.length,
    item: (value, itemLabel) => assertResource(value, itemLabel),
    uniqueBy: value => value.resource_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  assertArray(attributes.injuries, `${label}.injuries`, {
    max: 256,
    item: (value, itemLabel) => assertInjury(value, itemLabel),
    uniqueBy: value => value.injury_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  assertArray(attributes.persistent_statuses, `${label}.persistent_statuses`, {
    max: 256,
    item: (value, itemLabel) => assertPersistentStatus(value, itemLabel),
    uniqueBy: value => value.status_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  return attributes;
}

function assertProgressionIdentity(value, label, prefix, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(value, {
    label,
    allowed: ['id', 'display_name'],
    code
  });
  assertIdentifier(value.id, `${label}.id`, { prefixes: [prefix], code });
  assertString(value.display_name, `${label}.display_name`, { max: 160, code });
}

export function assertActorProgression(progression, label = 'actor.progression') {
  assertExactObject(progression, {
    label,
    allowed: [
      'schema',
      'version',
      'experience',
      'level',
      'reputation',
      'titles',
      'achievements'
    ],
    code: 'INVALID_CANDIDATE_STATE'
  });
  if (progression.schema !== ACTOR_PROGRESSION_SCHEMA) {
    fail('INVALID_CANDIDATE_STATE', `${label} has an unsupported schema`);
  }
  assertInteger(progression.version, `${label}.version`, { min: 0, code: 'INVALID_CANDIDATE_STATE' });
  assertInteger(progression.experience, `${label}.experience`, { min: 0, code: 'INVALID_CANDIDATE_STATE' });
  assertInteger(progression.level, `${label}.level`, { min: 1, code: 'INVALID_CANDIDATE_STATE' });
  assertInteger(progression.reputation, `${label}.reputation`, { code: 'INVALID_CANDIDATE_STATE' });
  assertArray(progression.titles, `${label}.titles`, {
    item: (value, itemLabel) => assertProgressionIdentity(value, itemLabel, 'title:'),
    uniqueBy: value => value.id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  assertArray(progression.achievements, `${label}.achievements`, {
    item: (value, itemLabel) => assertProgressionIdentity(value, itemLabel, 'achievement:'),
    uniqueBy: value => value.id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  return progression;
}

function validateProfileEffect(effect) {
  assertActorTarget(effect.target);
  assertExactObject(effect.payload, {
    label: 'actor profile payload',
    allowed: ['expected_version', 'next_version', 'changes']
  });
  assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 0 });
  assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
  assertExactObject(effect.payload.changes, {
    label: 'payload.changes',
    allowed: PROFILE_CHANGE_KEYS,
    required: []
  });
  if (Object.keys(effect.payload.changes).length === 0) {
    fail('INVALID_EFFECT_PAYLOAD', 'payload.changes must change at least one fixed profile field');
  }
  const changes = effect.payload.changes;
  if ('display_name' in changes) assertString(changes.display_name, 'payload.changes.display_name', { max: 80 });
  if ('rank' in changes) assertString(changes.rank, 'payload.changes.rank', { max: 80 });
  if ('goal' in changes) assertString(changes.goal, 'payload.changes.goal', { max: 1_000 });
  if ('alive' in changes) assertBoolean(changes.alive, 'payload.changes.alive');
  if ('status' in changes) {
    assertString(changes.status, 'payload.changes.status', { enumValues: PROFILE_STATUSES });
  }
}

function reduceProfile(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  const { actor } = findActor(next, effect.target.actor_id);
  assertActorProfile(actor.player);
  const before = actor.player;
  assertVersionStep(
    effect.payload.expected_version,
    effect.payload.next_version,
    before.version,
    'actor profile'
  );
  actor.player = {
    ...before,
    ...effect.payload.changes,
    version: effect.payload.next_version
  };
  assertActorProfile(actor.player);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_actor_profile_effect',
    reducerVersion: ACTOR_REDUCER_VERSIONS.apply_actor_profile_effect,
    primary: {
      operation: 'set_fixed_profile_fields',
      target: effect.target,
      before,
      after: actor.player
    },
    invariantResults: [
      { invariant_id: 'actor-profile-stable-id' },
      { invariant_id: 'actor-profile-status-consistency' }
    ]
  });
}

function validateResourceEffect(effect) {
  assertActorEntityTarget(effect.target, 'actor_resource', 'resource_id', null);
  assertString(effect.target.resource_id, 'target.resource_id', {
    enumValues: RESOURCE_IDS,
    code: 'INVALID_EFFECT_TARGET'
  });
  assertExactObject(effect.payload, {
    label: 'actor resource payload',
    allowed: [
      'expected_version',
      'next_version',
      'from',
      'to',
      'amount',
      'maximum'
    ]
  });
  for (const field of ['expected_version', 'next_version', 'from', 'to', 'amount', 'maximum']) {
    assertInteger(effect.payload[field], `payload.${field}`, { min: 0 });
  }
  if (effect.payload.amount < 1) {
    fail('INVALID_EFFECT_PAYLOAD', 'payload.amount must be positive');
  }
  if (['damage', 'heal'].includes(effect.operation) && effect.target.resource_id !== 'vitality') {
    fail('INVALID_EFFECT_CONTRACT', 'damage and heal are restricted to vitality');
  }
}

function reduceResource(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  const { actor } = findActor(next, effect.target.actor_id);
  assertActorAttributes(actor.attributes);
  const found = findById(
    actor.attributes.resources,
    'resource_id',
    effect.target.resource_id,
    'actor resource'
  );
  const before = found.value;
  const payload = effect.payload;
  assertVersionStep(payload.expected_version, payload.next_version, before.version, 'actor resource');
  if (payload.from !== before.current || payload.maximum !== before.maximum) {
    fail('EFFECT_PRECONDITION_FAILED', 'actor resource balance precondition failed', {
      expected_current: payload.from,
      actual_current: before.current,
      expected_maximum: payload.maximum,
      actual_maximum: before.maximum
    });
  }

  let expectedTo;
  if (effect.operation === 'consume') {
    expectedTo = payload.from - payload.amount;
    if (expectedTo < 0) {
      fail('RESOURCE_FLOOR_VIOLATION', 'resource consumption would cross the zero floor', {
        resource_id: before.resource_id,
        current: payload.from,
        amount: payload.amount
      });
    }
  } else if (effect.operation === 'damage') {
    expectedTo = Math.max(0, payload.from - payload.amount);
  } else {
    expectedTo = Math.min(payload.maximum, payload.from + payload.amount);
  }
  if (payload.to !== expectedTo) {
    fail('INVALID_EFFECT_PAYLOAD', 'resource payload has an inconsistent resulting balance', {
      calculated_to: expectedTo,
      supplied_to: payload.to
    });
  }

  const after = {
    ...before,
    version: payload.next_version,
    current: payload.to
  };
  replaceSorted(actor.attributes.resources, found.index, after, 'resource_id');
  assertActorAttributes(actor.attributes);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_actor_resource_effect',
    reducerVersion: ACTOR_REDUCER_VERSIONS.apply_actor_resource_effect,
    primary: {
      operation: effect.operation,
      target: effect.target,
      before,
      after
    },
    invariantResults: [
      { invariant_id: 'actor-resource-zero-floor' },
      { invariant_id: 'actor-resource-maximum' },
      { invariant_id: 'actor-resource-single-version-step' }
    ]
  });
}

function validateActorEntityEffect(effect, kind) {
  const isInjury = kind === 'actor_injury';
  const idField = isInjury ? 'injury_id' : 'status_id';
  const prefix = isInjury ? 'injury:' : 'status:';
  assertActorEntityTarget(effect.target, kind, idField, [prefix]);
  const common = ['expected_version', 'next_version'];
  if (effect.operation === 'upsert') {
    assertExactObject(effect.payload, {
      label: `${kind} upsert payload`,
      allowed: isInjury
        ? [...common, 'label', 'severity', 'active']
        : [...common, 'label', 'stacks', 'expires_calendar_ordinal']
    });
    if (effect.payload.expected_version !== null) {
      assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    }
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
    assertString(effect.payload.label, 'payload.label', { max: 160 });
    if (isInjury) {
      assertInteger(effect.payload.severity, 'payload.severity', { min: 1, max: 5 });
      assertBoolean(effect.payload.active, 'payload.active');
    } else {
      assertInteger(effect.payload.stacks, 'payload.stacks', { min: 1, max: 999 });
      if (effect.payload.expires_calendar_ordinal !== null) {
        assertInteger(effect.payload.expires_calendar_ordinal, 'payload.expires_calendar_ordinal', { min: 0 });
      }
    }
  } else {
    assertExactObject(effect.payload, {
      label: `${kind} remove payload`,
      allowed: ['expected_version']
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  }
}

function reduceActorEntity(baseCandidate, effect, kind) {
  const next = cloneCandidate(baseCandidate);
  const { actor } = findActor(next, effect.target.actor_id);
  assertActorAttributes(actor.attributes);
  const isInjury = kind === 'actor_injury';
  const collection = isInjury ? actor.attributes.injuries : actor.attributes.persistent_statuses;
  const idField = isInjury ? 'injury_id' : 'status_id';
  const entityId = effect.target[idField];
  const index = collection.findIndex(value => value[idField] === entityId);
  const before = index < 0 ? null : collection[index];
  let after = null;

  if (effect.operation === 'upsert') {
    if (before === null) {
      assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, false, kind);
    } else {
      assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, kind);
    }
    after = isInjury
      ? {
          injury_id: entityId,
          version: effect.payload.next_version,
          label: effect.payload.label,
          severity: effect.payload.severity,
          active: effect.payload.active
        }
      : {
          status_id: entityId,
          version: effect.payload.next_version,
          label: effect.payload.label,
          stacks: effect.payload.stacks,
          expires_calendar_ordinal: effect.payload.expires_calendar_ordinal
        };
    if (before === null) insertSorted(collection, after, idField);
    else replaceSorted(collection, index, after, idField);
  } else {
    if (before === null) fail('EFFECT_TARGET_NOT_FOUND', `${kind} does not exist`, { [idField]: entityId });
    if (effect.payload.expected_version !== before.version) {
      fail('EFFECT_PRECONDITION_FAILED', `${kind} version precondition failed`);
    }
    collection.splice(index, 1);
  }
  assertActorAttributes(actor.attributes);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_actor_resource_effect',
    reducerVersion: ACTOR_REDUCER_VERSIONS.apply_actor_resource_effect,
    primary: {
      operation: effect.operation,
      target: effect.target,
      before,
      after
    },
    invariantResults: [{ invariant_id: `${kind}-stable-id` }]
  });
}

function validateProgressionEffect(effect) {
  assertActorTarget(effect.target);
  const scalarOperations = {
    grant_experience: 'experience',
    adjust_reputation: 'reputation',
    set_level: 'level'
  };
  if (effect.operation in scalarOperations) {
    assertExactObject(effect.payload, {
      label: 'actor progression scalar payload',
      allowed: ['expected_version', 'next_version', 'from', 'to']
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 0 });
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
    const minimum = effect.operation === 'adjust_reputation' ? Number.MIN_SAFE_INTEGER : 0;
    assertInteger(effect.payload.from, 'payload.from', { min: minimum });
    assertInteger(effect.payload.to, 'payload.to', {
      min: effect.operation === 'set_level' ? 1 : minimum
    });
    if (effect.operation === 'grant_experience' && effect.payload.to <= effect.payload.from) {
      fail('INVALID_EFFECT_PAYLOAD', 'grant_experience must strictly increase experience');
    }
    return;
  }
  const isTitle = effect.operation.endsWith('_title');
  const isAdd = effect.operation.startsWith('add_');
  const idField = isTitle ? 'title_id' : 'achievement_id';
  const prefix = isTitle ? 'title:' : 'achievement:';
  assertExactObject(effect.payload, {
    label: 'actor progression identity payload',
    allowed: isAdd
      ? ['expected_version', 'next_version', idField, 'display_name']
      : ['expected_version', 'next_version', idField]
  });
  assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 0 });
  assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
  assertIdentifier(effect.payload[idField], `payload.${idField}`, { prefixes: [prefix] });
  if (isAdd) assertString(effect.payload.display_name, 'payload.display_name', { max: 160 });
}

function reduceProgression(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  const { actor } = findActor(next, effect.target.actor_id);
  assertActorProgression(actor.progression);
  const before = actor.progression;
  const payload = effect.payload;
  assertVersionStep(payload.expected_version, payload.next_version, before.version, 'actor progression');
  const after = { ...before, version: payload.next_version };
  const scalarFields = {
    grant_experience: 'experience',
    adjust_reputation: 'reputation',
    set_level: 'level'
  };
  if (effect.operation in scalarFields) {
    const field = scalarFields[effect.operation];
    if (before[field] !== payload.from) {
      fail('EFFECT_PRECONDITION_FAILED', `${field} precondition failed`, {
        expected: payload.from,
        actual: before[field]
      });
    }
    after[field] = payload.to;
  } else {
    const isTitle = effect.operation.endsWith('_title');
    const isAdd = effect.operation.startsWith('add_');
    const collectionField = isTitle ? 'titles' : 'achievements';
    const idField = isTitle ? 'title_id' : 'achievement_id';
    const entityId = payload[idField];
    const collection = [...before[collectionField]];
    const index = collection.findIndex(value => value.id === entityId);
    if (isAdd) {
      if (index >= 0) fail('EFFECT_PRECONDITION_FAILED', `${collectionField} identity already exists`);
      insertSorted(collection, { id: entityId, display_name: payload.display_name }, 'id');
    } else {
      if (index < 0) fail('EFFECT_TARGET_NOT_FOUND', `${collectionField} identity does not exist`);
      collection.splice(index, 1);
    }
    after[collectionField] = collection;
  }
  actor.progression = after;
  assertActorProgression(after);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_actor_progression_effect',
    reducerVersion: ACTOR_REDUCER_VERSIONS.apply_actor_progression_effect,
    primary: {
      operation: effect.operation,
      target: effect.target,
      before,
      after
    },
    invariantResults: [
      { invariant_id: 'actor-progression-stable-identities' },
      { invariant_id: 'actor-progression-single-version-step' }
    ]
  });
}

export const ACTOR_EFFECT_CONTRACTS = Object.freeze([
  Object.freeze({
    domain: 'actor_profile',
    kind: 'profile',
    operations: Object.freeze(['set_fields']),
    reducerKey: 'apply_actor_profile_effect',
    reducerVersion: ACTOR_REDUCER_VERSIONS.apply_actor_profile_effect,
    validate: validateProfileEffect,
    reduce: reduceProfile
  }),
  Object.freeze({
    domain: 'actor_resource',
    kind: 'resource',
    operations: RESOURCE_OPERATIONS,
    reducerKey: 'apply_actor_resource_effect',
    reducerVersion: ACTOR_REDUCER_VERSIONS.apply_actor_resource_effect,
    validate: validateResourceEffect,
    reduce: reduceResource
  }),
  Object.freeze({
    domain: 'actor_resource',
    kind: 'actor_injury',
    operations: Object.freeze(['upsert', 'remove']),
    reducerKey: 'apply_actor_resource_effect',
    reducerVersion: ACTOR_REDUCER_VERSIONS.apply_actor_resource_effect,
    validate: effect => validateActorEntityEffect(effect, 'actor_injury'),
    reduce: (candidate, effect) => reduceActorEntity(candidate, effect, 'actor_injury')
  }),
  Object.freeze({
    domain: 'actor_resource',
    kind: 'actor_status',
    operations: Object.freeze(['upsert', 'remove']),
    reducerKey: 'apply_actor_resource_effect',
    reducerVersion: ACTOR_REDUCER_VERSIONS.apply_actor_resource_effect,
    validate: effect => validateActorEntityEffect(effect, 'actor_status'),
    reduce: (candidate, effect) => reduceActorEntity(candidate, effect, 'actor_status')
  }),
  Object.freeze({
    domain: 'actor_progression',
    kind: 'progression',
    operations: Object.freeze([
      'grant_experience',
      'adjust_reputation',
      'set_level',
      'add_title',
      'remove_title',
      'add_achievement',
      'remove_achievement'
    ]),
    reducerKey: 'apply_actor_progression_effect',
    reducerVersion: ACTOR_REDUCER_VERSIONS.apply_actor_progression_effect,
    validate: validateProgressionEffect,
    reduce: reduceProgression
  })
]);
