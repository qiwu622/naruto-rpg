import {
  assertArray,
  assertCreateVersion,
  assertDomainContainer,
  assertExactObject,
  assertIdentifier,
  assertInteger,
  assertString,
  assertVersionStep,
  cloneCandidate,
  fail,
  findActor,
  insertSorted,
  reducerResult,
  replaceSorted
} from './shared.js';

export const MISSION_COLLECTION_SCHEMA = 'naruto.multiplayer-mission-collection/v1';
export const MISSION_REDUCER_VERSION = 'mission-reducer/v1';

const MISSION_SCOPES = Object.freeze(['shared', 'actor:A', 'actor:B']);
const MISSION_STATUSES = Object.freeze([
  'OFFERED',
  'ACCEPTED',
  'ACTIVE',
  'COMPLETED',
  'FAILED',
  'ABANDONED'
]);
const TERMINAL_MISSION_STATUSES = new Set(['COMPLETED', 'FAILED', 'ABANDONED']);
const MISSION_TRANSITIONS = Object.freeze({
  OFFERED: Object.freeze(['ACCEPTED']),
  ACCEPTED: Object.freeze(['ACTIVE', 'ABANDONED']),
  ACTIVE: Object.freeze(['COMPLETED', 'FAILED', 'ABANDONED']),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
  ABANDONED: Object.freeze([])
});

function assertActorIdList(value, label, code = 'INVALID_EFFECT_PAYLOAD') {
  assertArray(value, label, {
    min: 1,
    max: 2,
    item: (id, itemLabel) => assertIdentifier(id, itemLabel, { prefixes: ['actor:'], code }),
    uniqueBy: id => id,
    code
  });
}

function assertMission(value, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(value, {
    label,
    allowed: [
      'mission_id',
      'version',
      'scope',
      'title',
      'status',
      'progress_current',
      'progress_total',
      'assignee_actor_ids'
    ],
    code
  });
  assertIdentifier(value.mission_id, `${label}.mission_id`, { prefixes: ['mission:'], code });
  assertInteger(value.version, `${label}.version`, { min: 1, code });
  assertString(value.scope, `${label}.scope`, { enumValues: MISSION_SCOPES, code });
  assertString(value.title, `${label}.title`, { max: 240, code });
  assertString(value.status, `${label}.status`, { enumValues: MISSION_STATUSES, code });
  assertInteger(value.progress_current, `${label}.progress_current`, { min: 0, code });
  assertInteger(value.progress_total, `${label}.progress_total`, { min: 1, code });
  if (value.progress_current > value.progress_total) {
    fail(code, `${label}.progress_current cannot exceed progress_total`);
  }
  assertActorIdList(value.assignee_actor_ids, `${label}.assignee_actor_ids`, code);
}

export function assertMissionCollection(value, label = 'mission collection') {
  assertDomainContainer(value, MISSION_COLLECTION_SCHEMA, label);
  assertArray(value.entries, `${label}.entries`, {
    max: 5_000,
    item: (entry, itemLabel) => assertMission(entry, itemLabel),
    uniqueBy: entry => entry.mission_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  return value;
}

function assertMissionTarget(target) {
  assertExactObject(target, {
    label: 'effect target',
    allowed: ['scope', 'mission_id', 'mission_scope'],
    code: 'INVALID_EFFECT_TARGET'
  });
  if (target.scope !== 'mission') fail('INVALID_EFFECT_TARGET', 'target.scope must be mission');
  assertIdentifier(target.mission_id, 'target.mission_id', {
    prefixes: ['mission:'],
    code: 'INVALID_EFFECT_TARGET'
  });
  assertString(target.mission_scope, 'target.mission_scope', {
    enumValues: MISSION_SCOPES,
    code: 'INVALID_EFFECT_TARGET'
  });
}

function validateMissionEffect(effect) {
  assertMissionTarget(effect.target);
  if (effect.operation === 'create') {
    assertExactObject(effect.payload, {
      label: 'mission create payload',
      allowed: [
        'expected_version',
        'next_version',
        'title',
        'initial_status',
        'progress_current',
        'progress_total',
        'assignee_actor_ids'
      ]
    });
    if (effect.payload.expected_version !== null || effect.payload.next_version !== 1) {
      fail('INVALID_EFFECT_PAYLOAD', 'mission creation requires null -> version 1');
    }
    assertString(effect.payload.title, 'payload.title', { max: 240 });
    if (effect.payload.initial_status !== 'OFFERED') {
      fail('INVALID_EFFECT_PAYLOAD', 'a mission must be created in OFFERED state');
    }
    assertInteger(effect.payload.progress_current, 'payload.progress_current', { min: 0 });
    assertInteger(effect.payload.progress_total, 'payload.progress_total', { min: 1 });
    if (effect.payload.progress_current > effect.payload.progress_total) {
      fail('INVALID_EFFECT_PAYLOAD', 'mission progress exceeds total');
    }
    assertActorIdList(effect.payload.assignee_actor_ids, 'payload.assignee_actor_ids');
    return;
  }
  if (effect.operation === 'transition') {
    assertExactObject(effect.payload, {
      label: 'mission transition payload',
      allowed: ['expected_version', 'next_version', 'from_status', 'to_status']
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
    assertString(effect.payload.from_status, 'payload.from_status', { enumValues: MISSION_STATUSES });
    assertString(effect.payload.to_status, 'payload.to_status', { enumValues: MISSION_STATUSES });
    return;
  }
  if (effect.operation === 'progress') {
    assertExactObject(effect.payload, {
      label: 'mission progress payload',
      allowed: [
        'expected_version',
        'next_version',
        'from_progress',
        'to_progress',
        'progress_total'
      ]
    });
    for (const field of ['expected_version', 'next_version', 'from_progress', 'to_progress', 'progress_total']) {
      assertInteger(effect.payload[field], `payload.${field}`, { min: field === 'progress_total' ? 1 : 0 });
    }
    if (effect.payload.to_progress <= effect.payload.from_progress) {
      fail('INVALID_EFFECT_PAYLOAD', 'mission progress must strictly increase');
    }
    if (effect.payload.to_progress > effect.payload.progress_total) {
      fail('INVALID_EFFECT_PAYLOAD', 'mission progress exceeds total');
    }
    return;
  }
  assertExactObject(effect.payload, {
    label: 'mission reassignment payload',
    allowed: ['expected_version', 'next_version', 'from_actor_ids', 'to_actor_ids']
  });
  assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
  assertActorIdList(effect.payload.from_actor_ids, 'payload.from_actor_ids');
  assertActorIdList(effect.payload.to_actor_ids, 'payload.to_actor_ids');
}

function collectionForMission(candidate, missionScope) {
  if (missionScope === 'shared') {
    assertMissionCollection(candidate.shared_world.shared_missions, 'shared_world.shared_missions');
    return candidate.shared_world.shared_missions;
  }
  const seat = missionScope.slice('actor:'.length);
  const actorId = candidate.actors[seat].room_actor_id;
  const { actor } = findActor(candidate, actorId);
  assertMissionCollection(actor.missions, `actors.${seat}.missions`);
  return actor.missions;
}

function reduceMission(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  const collection = collectionForMission(next, effect.target.mission_scope);
  const entries = collection.entries;
  const index = entries.findIndex(entry => entry.mission_id === effect.target.mission_id);
  const before = index < 0 ? null : entries[index];
  let after;

  if (effect.operation === 'create') {
    assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, before !== null, 'mission');
    after = {
      mission_id: effect.target.mission_id,
      version: 1,
      scope: effect.target.mission_scope,
      title: effect.payload.title,
      status: effect.payload.initial_status,
      progress_current: effect.payload.progress_current,
      progress_total: effect.payload.progress_total,
      assignee_actor_ids: [...effect.payload.assignee_actor_ids].sort()
    };
    insertSorted(entries, after, 'mission_id');
  } else {
    if (before === null) fail('EFFECT_TARGET_NOT_FOUND', 'mission does not exist');
    assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'mission');
    after = { ...before, version: effect.payload.next_version };
    if (effect.operation === 'transition') {
      if (before.status !== effect.payload.from_status) {
        fail('EFFECT_PRECONDITION_FAILED', 'mission status precondition failed');
      }
      if (!MISSION_TRANSITIONS[before.status].includes(effect.payload.to_status)) {
        fail('INVALID_STATE_TRANSITION', 'mission state transition is not allowed', {
          from_status: before.status,
          to_status: effect.payload.to_status
        });
      }
      after.status = effect.payload.to_status;
    } else if (effect.operation === 'progress') {
      if (before.status !== 'ACTIVE') {
        fail('INVALID_STATE_TRANSITION', 'only ACTIVE missions may progress');
      }
      if (
        before.progress_current !== effect.payload.from_progress ||
        before.progress_total !== effect.payload.progress_total
      ) {
        fail('EFFECT_PRECONDITION_FAILED', 'mission progress precondition failed');
      }
      after.progress_current = effect.payload.to_progress;
    } else {
      if (TERMINAL_MISSION_STATUSES.has(before.status)) {
        fail('INVALID_STATE_TRANSITION', 'terminal missions cannot be reassigned');
      }
      const current = [...before.assignee_actor_ids].sort();
      const expected = [...effect.payload.from_actor_ids].sort();
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        fail('EFFECT_PRECONDITION_FAILED', 'mission assignee precondition failed');
      }
      after.assignee_actor_ids = [...effect.payload.to_actor_ids].sort();
    }
    replaceSorted(entries, index, after, 'mission_id');
  }
  assertMissionCollection(collection);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_mission_effect',
    reducerVersion: MISSION_REDUCER_VERSION,
    primary: { operation: effect.operation, target: effect.target, before, after },
    invariantResults: [
      { invariant_id: 'mission-state-machine' },
      { invariant_id: 'mission-stable-id' },
      { invariant_id: 'mission-no-implicit-reward' }
    ]
  });
}

export const MISSION_EFFECT_CONTRACTS = Object.freeze([
  Object.freeze({
    domain: 'mission',
    kind: 'mission',
    operations: Object.freeze(['create', 'transition', 'progress', 'reassign']),
    reducerKey: 'apply_mission_effect',
    reducerVersion: MISSION_REDUCER_VERSION,
    validate: validateMissionEffect,
    reduce: reduceMission
  })
]);
