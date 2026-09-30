import {
  assertArray,
  assertCreateVersion,
  assertDomainContainer,
  assertExactObject,
  assertIdentifier,
  assertInteger,
  assertNullableString,
  assertString,
  assertVersionStep,
  cloneCandidate,
  compareText,
  fail,
  insertSorted,
  reducerResult,
  replaceSorted
} from './shared.js';

export const COMBAT_COLLECTION_SCHEMA = 'naruto.multiplayer-combat-collection/v1';
export const EVENT_COLLECTION_SCHEMA = 'naruto.multiplayer-event-collection/v1';
export const COMBAT_REDUCER_VERSION = 'combat-reducer/v1';
export const EVENT_REDUCER_VERSION = 'event-reducer/v1';

const COMBAT_PHASES = Object.freeze(['SETUP', 'ACTIVE', 'RESOLVED', 'CANCELLED']);
const COMBAT_PARTICIPANT_STATUSES = Object.freeze(['READY', 'ACTIVE', 'DEFEATED', 'WITHDRAWN']);
const COMBAT_TRANSITIONS = Object.freeze({
  SETUP: Object.freeze(['ACTIVE', 'CANCELLED']),
  ACTIVE: Object.freeze(['CANCELLED']),
  RESOLVED: Object.freeze([]),
  CANCELLED: Object.freeze([])
});
const EVENT_STATUSES = Object.freeze(['SCHEDULED', 'TRIGGERED', 'DEFERRED', 'RESOLVED', 'CANCELLED']);
const EVENT_TRANSITIONS = Object.freeze({
  SCHEDULED: Object.freeze(['TRIGGERED', 'DEFERRED', 'CANCELLED']),
  TRIGGERED: Object.freeze(['RESOLVED', 'DEFERRED', 'CANCELLED']),
  DEFERRED: Object.freeze(['SCHEDULED', 'TRIGGERED', 'CANCELLED']),
  RESOLVED: Object.freeze([]),
  CANCELLED: Object.freeze([])
});

function assertParticipant(value, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(value, {
    label,
    allowed: ['participant_id', 'display_name', 'status'],
    code
  });
  assertIdentifier(value.participant_id, `${label}.participant_id`, {
    prefixes: ['actor:', 'npc:'],
    code
  });
  assertString(value.display_name, `${label}.display_name`, { max: 160, code });
  assertString(value.status, `${label}.status`, {
    enumValues: COMBAT_PARTICIPANT_STATUSES,
    code
  });
}

function assertCombatAction(value, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(value, {
    label,
    allowed: ['action_id', 'actor_id', 'technique_id', 'event_id', 'outcome'],
    code
  });
  assertIdentifier(value.action_id, `${label}.action_id`, { prefixes: ['action:'], code });
  assertIdentifier(value.actor_id, `${label}.actor_id`, {
    prefixes: ['actor:', 'npc:'],
    code
  });
  if (value.technique_id !== null) {
    assertIdentifier(value.technique_id, `${label}.technique_id`, {
      prefixes: ['skill:', 'technique:'],
      code
    });
  }
  assertIdentifier(value.event_id, `${label}.event_id`, { prefixes: ['event_'], code });
  assertString(value.outcome, `${label}.outcome`, { max: 500, code });
}

function assertCombat(value, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(value, {
    label,
    allowed: [
      'combat_id',
      'version',
      'phase',
      'participants',
      'action_log',
      'winner_ids',
      'resolution_summary'
    ],
    code
  });
  assertIdentifier(value.combat_id, `${label}.combat_id`, { prefixes: ['combat:'], code });
  assertInteger(value.version, `${label}.version`, { min: 1, code });
  assertString(value.phase, `${label}.phase`, { enumValues: COMBAT_PHASES, code });
  assertArray(value.participants, `${label}.participants`, {
    min: 2,
    max: 64,
    item: (entry, itemLabel) => assertParticipant(entry, itemLabel, code),
    uniqueBy: entry => entry.participant_id,
    code
  });
  assertArray(value.action_log, `${label}.action_log`, {
    max: 10_000,
    item: (entry, itemLabel) => assertCombatAction(entry, itemLabel, code),
    uniqueBy: entry => entry.action_id,
    code
  });
  assertArray(value.winner_ids, `${label}.winner_ids`, {
    max: 64,
    item: (id, itemLabel) => assertIdentifier(id, itemLabel, {
      prefixes: ['actor:', 'npc:'],
      code
    }),
    uniqueBy: id => id,
    code
  });
  for (const winnerId of value.winner_ids) {
    if (!value.participants.some(participant => participant.participant_id === winnerId)) {
      fail(code, `${label}.winner_ids references a non-participant`, { winner_id: winnerId });
    }
  }
  for (const action of value.action_log) {
    if (!value.participants.some(participant => participant.participant_id === action.actor_id)) {
      fail(code, `${label}.action_log references a non-participant`, {
        action_id: action.action_id,
        actor_id: action.actor_id
      });
    }
  }
  assertNullableString(value.resolution_summary, `${label}.resolution_summary`, { max: 1_000, code });
  if (value.phase === 'RESOLVED') {
    if (value.winner_ids.length === 0 || value.resolution_summary === null) {
      fail(code, `${label} RESOLVED combat requires winners and summary`);
    }
  } else if (value.winner_ids.length > 0 || value.resolution_summary !== null) {
    fail(code, `${label} unresolved combat cannot contain a result`);
  }
}

export function assertCombatCollection(value, label = 'shared_world.shared_combat') {
  assertDomainContainer(value, COMBAT_COLLECTION_SCHEMA, label);
  assertArray(value.entries, `${label}.entries`, {
    max: 2_000,
    item: (entry, itemLabel) => assertCombat(entry, itemLabel),
    uniqueBy: entry => entry.combat_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  return value;
}

function assertCombatTarget(target) {
  assertExactObject(target, {
    label: 'effect target',
    allowed: ['scope', 'combat_id'],
    code: 'INVALID_EFFECT_TARGET'
  });
  if (target.scope !== 'combat') fail('INVALID_EFFECT_TARGET', 'target.scope must be combat');
  assertIdentifier(target.combat_id, 'target.combat_id', {
    prefixes: ['combat:'],
    code: 'INVALID_EFFECT_TARGET'
  });
}

function assertParticipantPayload(value, label = 'payload.participants') {
  assertArray(value, label, {
    min: 2,
    max: 64,
    item: (entry, itemLabel) => assertParticipant(entry, itemLabel, 'INVALID_EFFECT_PAYLOAD'),
    uniqueBy: entry => entry.participant_id
  });
}

function validateCombatEffect(effect) {
  assertCombatTarget(effect.target);
  if (effect.operation === 'create') {
    assertExactObject(effect.payload, {
      label: 'combat create payload',
      allowed: ['expected_version', 'next_version', 'participants']
    });
    if (effect.payload.expected_version !== null || effect.payload.next_version !== 1) {
      fail('INVALID_EFFECT_PAYLOAD', 'combat creation requires null -> version 1');
    }
    assertParticipantPayload(effect.payload.participants);
    if (effect.payload.participants.some(participant => participant.status !== 'READY')) {
      fail('INVALID_EFFECT_PAYLOAD', 'combat participants must start READY');
    }
    return;
  }
  if (effect.operation === 'transition') {
    assertExactObject(effect.payload, {
      label: 'combat transition payload',
      allowed: ['expected_version', 'next_version', 'from_phase', 'to_phase']
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
    assertString(effect.payload.from_phase, 'payload.from_phase', { enumValues: COMBAT_PHASES });
    assertString(effect.payload.to_phase, 'payload.to_phase', { enumValues: COMBAT_PHASES });
    return;
  }
  if (effect.operation === 'record_action') {
    assertExactObject(effect.payload, {
      label: 'combat action payload',
      allowed: [
        'expected_version',
        'next_version',
        'action_id',
        'actor_id',
        'technique_id',
        'event_id',
        'outcome'
      ]
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
    assertCombatAction({
      action_id: effect.payload.action_id,
      actor_id: effect.payload.actor_id,
      technique_id: effect.payload.technique_id,
      event_id: effect.payload.event_id,
      outcome: effect.payload.outcome
    }, 'payload', 'INVALID_EFFECT_PAYLOAD');
    return;
  }
  if (effect.operation === 'set_participant_status') {
    assertExactObject(effect.payload, {
      label: 'combat participant status payload',
      allowed: [
        'expected_version',
        'next_version',
        'participant_id',
        'from_status',
        'to_status'
      ]
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
    assertIdentifier(effect.payload.participant_id, 'payload.participant_id', {
      prefixes: ['actor:', 'npc:']
    });
    assertString(effect.payload.from_status, 'payload.from_status', {
      enumValues: COMBAT_PARTICIPANT_STATUSES
    });
    assertString(effect.payload.to_status, 'payload.to_status', {
      enumValues: COMBAT_PARTICIPANT_STATUSES
    });
    return;
  }
  assertExactObject(effect.payload, {
    label: 'combat resolution payload',
    allowed: ['expected_version', 'next_version', 'winner_ids', 'resolution_summary']
  });
  assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
  assertArray(effect.payload.winner_ids, 'payload.winner_ids', {
    min: 1,
    max: 64,
    item: (id, itemLabel) => assertIdentifier(id, itemLabel, { prefixes: ['actor:', 'npc:'] }),
    uniqueBy: id => id
  });
  assertString(effect.payload.resolution_summary, 'payload.resolution_summary', { max: 1_000 });
}

function reduceCombat(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  assertCombatCollection(next.shared_world.shared_combat);
  const entries = next.shared_world.shared_combat.entries;
  const index = entries.findIndex(entry => entry.combat_id === effect.target.combat_id);
  const before = index < 0 ? null : entries[index];
  let after;

  if (effect.operation === 'create') {
    assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, before !== null, 'combat');
    after = {
      combat_id: effect.target.combat_id,
      version: 1,
      phase: 'SETUP',
      participants: [...effect.payload.participants].sort((a, b) =>
        compareText(a.participant_id, b.participant_id)
      ),
      action_log: [],
      winner_ids: [],
      resolution_summary: null
    };
    insertSorted(entries, after, 'combat_id');
  } else {
    if (before === null) fail('EFFECT_TARGET_NOT_FOUND', 'combat does not exist');
    assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'combat');
    after = { ...before, version: effect.payload.next_version };
    if (effect.operation === 'transition') {
      if (before.phase !== effect.payload.from_phase) {
        fail('EFFECT_PRECONDITION_FAILED', 'combat phase precondition failed');
      }
      if (!COMBAT_TRANSITIONS[before.phase].includes(effect.payload.to_phase)) {
        fail('INVALID_STATE_TRANSITION', 'combat phase transition is not allowed');
      }
      after.phase = effect.payload.to_phase;
      if (after.phase === 'ACTIVE') {
        after.participants = before.participants.map(participant => ({
          ...participant,
          status: participant.status === 'READY' ? 'ACTIVE' : participant.status
        }));
      }
    } else if (effect.operation === 'record_action') {
      if (before.phase !== 'ACTIVE') {
        fail('INVALID_STATE_TRANSITION', 'combat actions require ACTIVE phase');
      }
      if (!before.participants.some(participant => participant.participant_id === effect.payload.actor_id)) {
        fail('EFFECT_PRECONDITION_FAILED', 'combat action actor is not a participant');
      }
      if (before.action_log.some(action => action.action_id === effect.payload.action_id)) {
        fail('EFFECT_PRECONDITION_FAILED', 'combat action_id has already been recorded');
      }
      after.action_log = [...before.action_log, {
        action_id: effect.payload.action_id,
        actor_id: effect.payload.actor_id,
        technique_id: effect.payload.technique_id,
        event_id: effect.payload.event_id,
        outcome: effect.payload.outcome
      }];
    } else if (effect.operation === 'set_participant_status') {
      if (before.phase !== 'ACTIVE') {
        fail('INVALID_STATE_TRANSITION', 'participant status changes require ACTIVE phase');
      }
      const participantIndex = before.participants.findIndex(
        participant => participant.participant_id === effect.payload.participant_id
      );
      if (participantIndex < 0) fail('EFFECT_TARGET_NOT_FOUND', 'combat participant does not exist');
      if (before.participants[participantIndex].status !== effect.payload.from_status) {
        fail('EFFECT_PRECONDITION_FAILED', 'combat participant status precondition failed');
      }
      if (effect.payload.to_status === 'READY') {
        fail('INVALID_STATE_TRANSITION', 'ACTIVE combat participants cannot return to READY');
      }
      after.participants = before.participants.map((participant, participantOffset) =>
        participantOffset === participantIndex
          ? { ...participant, status: effect.payload.to_status }
          : participant
      );
    } else {
      if (before.phase !== 'ACTIVE') {
        fail('INVALID_STATE_TRANSITION', 'only ACTIVE combat can resolve');
      }
      for (const winnerId of effect.payload.winner_ids) {
        if (!before.participants.some(participant => participant.participant_id === winnerId)) {
          fail('EFFECT_PRECONDITION_FAILED', 'combat winner is not a participant', {
            winner_id: winnerId
          });
        }
      }
      after.phase = 'RESOLVED';
      after.winner_ids = [...effect.payload.winner_ids].sort();
      after.resolution_summary = effect.payload.resolution_summary;
    }
    replaceSorted(entries, index, after, 'combat_id');
  }
  assertCombatCollection(next.shared_world.shared_combat);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_combat_effect',
    reducerVersion: COMBAT_REDUCER_VERSION,
    primary: { operation: effect.operation, target: effect.target, before, after },
    invariantResults: [
      { invariant_id: 'combat-state-machine' },
      { invariant_id: 'combat-stable-identities' },
      { invariant_id: 'combat-no-implicit-resource-or-vitality-effect' }
    ]
  });
}

function assertEvent(value, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(value, {
    label,
    allowed: [
      'event_id',
      'version',
      'status',
      'title',
      'scheduled_ordinal_minutes',
      'resolution_summary',
      'evidence_event_ids'
    ],
    code
  });
  assertIdentifier(value.event_id, `${label}.event_id`, { prefixes: ['event_'], code });
  assertInteger(value.version, `${label}.version`, { min: 1, code });
  assertString(value.status, `${label}.status`, { enumValues: EVENT_STATUSES, code });
  assertString(value.title, `${label}.title`, { max: 240, code });
  if (value.scheduled_ordinal_minutes !== null) {
    assertInteger(value.scheduled_ordinal_minutes, `${label}.scheduled_ordinal_minutes`, { min: 0, code });
  }
  assertNullableString(value.resolution_summary, `${label}.resolution_summary`, { max: 1_000, code });
  assertArray(value.evidence_event_ids, `${label}.evidence_event_ids`, {
    min: 1,
    max: 64,
    item: (id, itemLabel) => assertIdentifier(id, itemLabel, { prefixes: ['event_'], code }),
    uniqueBy: id => id,
    code
  });
  if (value.status === 'RESOLVED' && value.resolution_summary === null) {
    fail(code, `${label} resolved event requires resolution_summary`);
  }
}

export function assertEventCollection(value, label = 'shared_world.canonical_events') {
  assertDomainContainer(value, EVENT_COLLECTION_SCHEMA, label);
  assertArray(value.entries, `${label}.entries`, {
    max: 10_000,
    item: (entry, itemLabel) => assertEvent(entry, itemLabel),
    uniqueBy: entry => entry.event_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  return value;
}

function assertEventTarget(target) {
  assertExactObject(target, {
    label: 'effect target',
    allowed: ['scope', 'event_id'],
    code: 'INVALID_EFFECT_TARGET'
  });
  if (target.scope !== 'event') fail('INVALID_EFFECT_TARGET', 'target.scope must be event');
  assertIdentifier(target.event_id, 'target.event_id', {
    prefixes: ['event_'],
    code: 'INVALID_EFFECT_TARGET'
  });
}

function assertEventEvidence(value, label = 'payload.evidence_event_ids') {
  assertArray(value, label, {
    min: 1,
    max: 64,
    item: (id, itemLabel) => assertIdentifier(id, itemLabel, { prefixes: ['event_'] }),
    uniqueBy: id => id
  });
}

function validateEventEffect(effect) {
  assertEventTarget(effect.target);
  if (effect.operation === 'create') {
    assertExactObject(effect.payload, {
      label: 'event create payload',
      allowed: [
        'expected_version',
        'next_version',
        'initial_status',
        'title',
        'scheduled_ordinal_minutes',
        'evidence_event_ids'
      ]
    });
    if (effect.payload.expected_version !== null || effect.payload.next_version !== 1) {
      fail('INVALID_EFFECT_PAYLOAD', 'event creation requires null -> version 1');
    }
    if (!['SCHEDULED', 'TRIGGERED'].includes(effect.payload.initial_status)) {
      fail('INVALID_EFFECT_PAYLOAD', 'event initial_status must be SCHEDULED or TRIGGERED');
    }
    assertString(effect.payload.title, 'payload.title', { max: 240 });
    if (effect.payload.scheduled_ordinal_minutes !== null) {
      assertInteger(effect.payload.scheduled_ordinal_minutes, 'payload.scheduled_ordinal_minutes', { min: 0 });
    }
    assertEventEvidence(effect.payload.evidence_event_ids);
    return;
  }
  if (effect.operation === 'transition') {
    assertExactObject(effect.payload, {
      label: 'event transition payload',
      allowed: [
        'expected_version',
        'next_version',
        'from_status',
        'to_status',
        'resolution_summary'
      ]
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
    assertString(effect.payload.from_status, 'payload.from_status', { enumValues: EVENT_STATUSES });
    assertString(effect.payload.to_status, 'payload.to_status', { enumValues: EVENT_STATUSES });
    assertNullableString(effect.payload.resolution_summary, 'payload.resolution_summary', { max: 1_000 });
    if ((effect.payload.to_status === 'RESOLVED') !== (effect.payload.resolution_summary !== null)) {
      fail('INVALID_EFFECT_PAYLOAD', 'only RESOLVED transition carries resolution_summary');
    }
    return;
  }
  if (effect.operation === 'reschedule') {
    assertExactObject(effect.payload, {
      label: 'event reschedule payload',
      allowed: [
        'expected_version',
        'next_version',
        'from_ordinal_minutes',
        'to_ordinal_minutes'
      ]
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
    if (effect.payload.from_ordinal_minutes !== null) {
      assertInteger(effect.payload.from_ordinal_minutes, 'payload.from_ordinal_minutes', { min: 0 });
    }
    assertInteger(effect.payload.to_ordinal_minutes, 'payload.to_ordinal_minutes', { min: 0 });
    return;
  }
  assertExactObject(effect.payload, {
    label: 'event rewrite payload',
    allowed: ['expected_version', 'next_version', 'from_title', 'to_title']
  });
  assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
  assertString(effect.payload.from_title, 'payload.from_title', { max: 240 });
  assertString(effect.payload.to_title, 'payload.to_title', { max: 240 });
}

function reduceEvent(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  assertEventCollection(next.shared_world.canonical_events);
  const entries = next.shared_world.canonical_events.entries;
  const index = entries.findIndex(entry => entry.event_id === effect.target.event_id);
  const before = index < 0 ? null : entries[index];
  let after;
  if (effect.operation === 'create') {
    assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, before !== null, 'event');
    after = {
      event_id: effect.target.event_id,
      version: 1,
      status: effect.payload.initial_status,
      title: effect.payload.title,
      scheduled_ordinal_minutes: effect.payload.scheduled_ordinal_minutes,
      resolution_summary: null,
      evidence_event_ids: [...effect.payload.evidence_event_ids].sort()
    };
    insertSorted(entries, after, 'event_id');
  } else {
    if (before === null) fail('EFFECT_TARGET_NOT_FOUND', 'event does not exist');
    assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'event');
    after = { ...before, version: effect.payload.next_version };
    if (effect.operation === 'transition') {
      if (before.status !== effect.payload.from_status) {
        fail('EFFECT_PRECONDITION_FAILED', 'event status precondition failed');
      }
      if (!EVENT_TRANSITIONS[before.status].includes(effect.payload.to_status)) {
        fail('INVALID_STATE_TRANSITION', 'event state transition is not allowed');
      }
      after.status = effect.payload.to_status;
      after.resolution_summary = effect.payload.resolution_summary;
    } else if (effect.operation === 'reschedule') {
      if (!['SCHEDULED', 'DEFERRED'].includes(before.status)) {
        fail('INVALID_STATE_TRANSITION', 'only scheduled or deferred events may be rescheduled');
      }
      if (before.scheduled_ordinal_minutes !== effect.payload.from_ordinal_minutes) {
        fail('EFFECT_PRECONDITION_FAILED', 'event schedule precondition failed');
      }
      after.scheduled_ordinal_minutes = effect.payload.to_ordinal_minutes;
    } else {
      if (before.title !== effect.payload.from_title) {
        fail('EFFECT_PRECONDITION_FAILED', 'event title precondition failed');
      }
      after.title = effect.payload.to_title;
    }
    replaceSorted(entries, index, after, 'event_id');
  }
  assertEventCollection(next.shared_world.canonical_events);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_event_effect',
    reducerVersion: EVENT_REDUCER_VERSION,
    primary: { operation: effect.operation, target: effect.target, before, after },
    invariantResults: [
      { invariant_id: 'event-state-machine' },
      { invariant_id: 'event-stable-id' },
      { invariant_id: 'event-no-listener-side-effects' }
    ]
  });
}

export const COMBAT_EVENT_EFFECT_CONTRACTS = Object.freeze([
  Object.freeze({
    domain: 'combat',
    kind: 'combat',
    operations: Object.freeze([
      'create',
      'transition',
      'record_action',
      'set_participant_status',
      'resolve'
    ]),
    reducerKey: 'apply_combat_effect',
    reducerVersion: COMBAT_REDUCER_VERSION,
    validate: validateCombatEffect,
    reduce: reduceCombat
  }),
  Object.freeze({
    domain: 'event',
    kind: 'event',
    operations: Object.freeze(['create', 'transition', 'reschedule', 'rewrite']),
    reducerKey: 'apply_event_effect',
    reducerVersion: EVENT_REDUCER_VERSION,
    validate: validateEventEffect,
    reduce: reduceEvent
  })
]);
