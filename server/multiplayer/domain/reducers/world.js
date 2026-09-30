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
  insertSorted,
  reducerResult,
  replaceSorted
} from './shared.js';

export const WORLD_STATE_SCHEMA = 'naruto.multiplayer-world-state/v1';
export const WORLD_MAP_SCHEMA = 'naruto.multiplayer-world-map/v1';
export const WORLD_CALENDAR_SCHEMA = 'naruto.multiplayer-world-calendar/v1';

export const WORLD_REDUCER_VERSIONS = Object.freeze({
  apply_world_state_effect: 'world-state-reducer/v1',
  advance_world_calendar: 'world-calendar-reducer/v1'
});

const CALENDAR_PHASES = Object.freeze(['DAWN', 'DAY', 'DUSK', 'NIGHT']);
const NPC_PUBLIC_STATUSES = Object.freeze(['ACTIVE', 'MISSING', 'DECEASED', 'UNKNOWN']);

function assertVersionedPair(value, label, idField, idPrefixes, valueField, valueValidator, code) {
  assertExactObject(value, {
    label,
    allowed: [idField, 'version', valueField],
    code
  });
  assertIdentifier(value[idField], `${label}.${idField}`, { prefixes: idPrefixes, code });
  assertInteger(value.version, `${label}.version`, { min: 1, code });
  valueValidator(value[valueField], `${label}.${valueField}`, code);
}

function assertNpcProfile(value, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(value, {
    label,
    allowed: [
      'npc_id',
      'version',
      'display_name',
      'faction',
      'rank',
      'public_status',
      'evidence_event_ids'
    ],
    code
  });
  assertIdentifier(value.npc_id, `${label}.npc_id`, { prefixes: ['npc:'], code });
  assertInteger(value.version, `${label}.version`, { min: 1, code });
  assertString(value.display_name, `${label}.display_name`, { max: 160, code });
  assertString(value.faction, `${label}.faction`, { max: 160, code });
  assertString(value.rank, `${label}.rank`, { max: 80, code });
  assertString(value.public_status, `${label}.public_status`, {
    enumValues: NPC_PUBLIC_STATUSES,
    code
  });
  assertArray(value.evidence_event_ids, `${label}.evidence_event_ids`, {
    min: 1,
    max: 64,
    item: (id, itemLabel) => assertIdentifier(id, itemLabel, { prefixes: ['event_'], code }),
    uniqueBy: id => id,
    code
  });
}

export function assertWorldState(value, label = 'shared_world.world_state') {
  assertExactObject(value, {
    label,
    allowed: ['schema', 'locations', 'weather', 'flags', 'npc_profiles'],
    code: 'INVALID_CANDIDATE_STATE'
  });
  if (value.schema !== WORLD_STATE_SCHEMA) {
    fail('INVALID_CANDIDATE_STATE', `${label} has an unsupported schema`);
  }
  assertArray(value.locations, `${label}.locations`, {
    max: 10_000,
    item: (entry, itemLabel) => assertVersionedPair(
      entry,
      itemLabel,
      'entity_id',
      ['actor:', 'npc:'],
      'location_id',
      (locationId, locationLabel, code) => assertIdentifier(locationId, locationLabel, {
        prefixes: ['location:'],
        code
      }),
      'INVALID_CANDIDATE_STATE'
    ),
    uniqueBy: entry => entry.entity_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  assertArray(value.weather, `${label}.weather`, {
    max: 10_000,
    item: (entry, itemLabel) => assertVersionedPair(
      entry,
      itemLabel,
      'region_id',
      ['region:'],
      'weather_code',
      (weather, weatherLabel, code) => assertString(weather, weatherLabel, { max: 80, code }),
      'INVALID_CANDIDATE_STATE'
    ),
    uniqueBy: entry => entry.region_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  assertArray(value.flags, `${label}.flags`, {
    max: 10_000,
    item: (entry, itemLabel) => assertVersionedPair(
      entry,
      itemLabel,
      'flag_id',
      ['flag:'],
      'enabled',
      (enabled, enabledLabel, code) => assertBoolean(enabled, enabledLabel, code),
      'INVALID_CANDIDATE_STATE'
    ),
    uniqueBy: entry => entry.flag_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  assertArray(value.npc_profiles, `${label}.npc_profiles`, {
    max: 10_000,
    item: (entry, itemLabel) => assertNpcProfile(entry, itemLabel),
    uniqueBy: entry => entry.npc_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  return value;
}

function assertMapMarker(value, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(value, {
    label,
    allowed: ['marker_id', 'version', 'location_id', 'label', 'visible'],
    code
  });
  assertIdentifier(value.marker_id, `${label}.marker_id`, { prefixes: ['marker:'], code });
  assertInteger(value.version, `${label}.version`, { min: 1, code });
  assertIdentifier(value.location_id, `${label}.location_id`, { prefixes: ['location:'], code });
  assertString(value.label, `${label}.label`, { max: 160, code });
  assertBoolean(value.visible, `${label}.visible`, code);
}

export function assertWorldMap(value, label = 'shared_world.map') {
  assertExactObject(value, {
    label,
    allowed: ['schema', 'markers'],
    code: 'INVALID_CANDIDATE_STATE'
  });
  if (value.schema !== WORLD_MAP_SCHEMA) {
    fail('INVALID_CANDIDATE_STATE', `${label} has an unsupported schema`);
  }
  assertArray(value.markers, `${label}.markers`, {
    max: 10_000,
    item: (entry, itemLabel) => assertMapMarker(entry, itemLabel),
    uniqueBy: entry => entry.marker_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  return value;
}

export function assertWorldCalendar(value, label = 'shared_world.calendar') {
  assertExactObject(value, {
    label,
    allowed: [
      'schema',
      'calendar_id',
      'version',
      'ordinal_minutes',
      'display_date',
      'phase'
    ],
    code: 'INVALID_CANDIDATE_STATE'
  });
  if (value.schema !== WORLD_CALENDAR_SCHEMA) {
    fail('INVALID_CANDIDATE_STATE', `${label} has an unsupported schema`);
  }
  assertIdentifier(value.calendar_id, `${label}.calendar_id`, {
    prefixes: ['calendar:'],
    code: 'INVALID_CANDIDATE_STATE'
  });
  assertInteger(value.version, `${label}.version`, { min: 0, code: 'INVALID_CANDIDATE_STATE' });
  assertInteger(value.ordinal_minutes, `${label}.ordinal_minutes`, { min: 0, code: 'INVALID_CANDIDATE_STATE' });
  assertString(value.display_date, `${label}.display_date`, { max: 160, code: 'INVALID_CANDIDATE_STATE' });
  assertString(value.phase, `${label}.phase`, { enumValues: CALENDAR_PHASES, code: 'INVALID_CANDIDATE_STATE' });
  return value;
}

function assertWorldTarget(target, scope, idField, prefixes) {
  assertExactObject(target, {
    label: 'effect target',
    allowed: ['scope', idField],
    code: 'INVALID_EFFECT_TARGET'
  });
  if (target.scope !== scope) fail('INVALID_EFFECT_TARGET', `target.scope must be ${scope}`);
  assertIdentifier(target[idField], `target.${idField}`, {
    prefixes,
    code: 'INVALID_EFFECT_TARGET'
  });
}

function validateWorldPairEffect(effect, config) {
  assertWorldTarget(effect.target, config.scope, config.idField, config.idPrefixes);
  assertExactObject(effect.payload, {
    label: `${config.scope} payload`,
    allowed: [
      'expected_version',
      'next_version',
      config.fromField,
      config.toField
    ]
  });
  if (effect.payload.expected_version !== null) {
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  }
  assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
  config.validateValue(effect.payload[config.toField], `payload.${config.toField}`);
  if (effect.payload[config.fromField] !== null) {
    config.validateValue(effect.payload[config.fromField], `payload.${config.fromField}`);
  }
}

function reduceWorldPair(baseCandidate, effect, config) {
  const next = cloneCandidate(baseCandidate);
  assertWorldState(next.shared_world.world_state);
  const entries = next.shared_world.world_state[config.collection];
  const entityId = effect.target[config.idField];
  const index = entries.findIndex(entry => entry[config.idField] === entityId);
  const before = index < 0 ? null : entries[index];
  if (before === null) {
    assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, false, config.scope);
    if (effect.payload[config.fromField] !== null) {
      fail('EFFECT_PRECONDITION_FAILED', `${config.fromField} must be null for creation`);
    }
  } else {
    assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, config.scope);
    if (effect.payload[config.fromField] !== before[config.valueField]) {
      fail('EFFECT_PRECONDITION_FAILED', `${config.valueField} precondition failed`);
    }
  }
  const after = {
    [config.idField]: entityId,
    version: effect.payload.next_version,
    [config.valueField]: effect.payload[config.toField]
  };
  if (before === null) insertSorted(entries, after, config.idField);
  else replaceSorted(entries, index, after, config.idField);
  assertWorldState(next.shared_world.world_state);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_world_state_effect',
    reducerVersion: WORLD_REDUCER_VERSIONS.apply_world_state_effect,
    primary: {
      operation: 'set_versioned_world_value',
      target: effect.target,
      before,
      after
    },
    invariantResults: [{ invariant_id: `${config.scope}-stable-id` }]
  });
}

const WORLD_PAIR_CONFIGS = Object.freeze({
  location: Object.freeze({
    scope: 'world_location',
    collection: 'locations',
    idField: 'entity_id',
    idPrefixes: ['actor:', 'npc:'],
    valueField: 'location_id',
    fromField: 'from_location_id',
    toField: 'to_location_id',
    validateValue: (value, label) => assertIdentifier(value, label, { prefixes: ['location:'] })
  }),
  weather: Object.freeze({
    scope: 'world_weather',
    collection: 'weather',
    idField: 'region_id',
    idPrefixes: ['region:'],
    valueField: 'weather_code',
    fromField: 'from_weather_code',
    toField: 'to_weather_code',
    validateValue: (value, label) => assertString(value, label, { max: 80 })
  }),
  flag: Object.freeze({
    scope: 'world_flag',
    collection: 'flags',
    idField: 'flag_id',
    idPrefixes: ['flag:'],
    valueField: 'enabled',
    fromField: 'from_enabled',
    toField: 'to_enabled',
    validateValue: (value, label) => assertBoolean(value, label)
  })
});

function validateMapMarkerEffect(effect) {
  assertWorldTarget(effect.target, 'map_marker', 'marker_id', ['marker:']);
  if (effect.operation === 'upsert') {
    assertExactObject(effect.payload, {
      label: 'map marker upsert payload',
      allowed: ['expected_version', 'next_version', 'location_id', 'label', 'visible']
    });
    if (effect.payload.expected_version !== null) {
      assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    }
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
    assertIdentifier(effect.payload.location_id, 'payload.location_id', { prefixes: ['location:'] });
    assertString(effect.payload.label, 'payload.label', { max: 160 });
    assertBoolean(effect.payload.visible, 'payload.visible');
  } else {
    assertExactObject(effect.payload, {
      label: 'map marker remove payload',
      allowed: ['expected_version']
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  }
}

function reduceMapMarker(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  assertWorldMap(next.shared_world.map);
  const entries = next.shared_world.map.markers;
  const index = entries.findIndex(entry => entry.marker_id === effect.target.marker_id);
  const before = index < 0 ? null : entries[index];
  let after = null;
  if (effect.operation === 'upsert') {
    if (before === null) {
      assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, false, 'map marker');
    } else {
      assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'map marker');
    }
    after = {
      marker_id: effect.target.marker_id,
      version: effect.payload.next_version,
      location_id: effect.payload.location_id,
      label: effect.payload.label,
      visible: effect.payload.visible
    };
    if (before === null) insertSorted(entries, after, 'marker_id');
    else replaceSorted(entries, index, after, 'marker_id');
  } else {
    if (before === null) fail('EFFECT_TARGET_NOT_FOUND', 'map marker does not exist');
    if (before.version !== effect.payload.expected_version) {
      fail('EFFECT_PRECONDITION_FAILED', 'map marker version precondition failed');
    }
    entries.splice(index, 1);
  }
  assertWorldMap(next.shared_world.map);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_world_state_effect',
    reducerVersion: WORLD_REDUCER_VERSIONS.apply_world_state_effect,
    primary: { operation: effect.operation, target: effect.target, before, after },
    invariantResults: [{ invariant_id: 'world-map-marker-stable-id' }]
  });
}

function validateCalendarEffect(effect) {
  assertWorldTarget(effect.target, 'world_calendar', 'calendar_id', ['calendar:']);
  assertExactObject(effect.payload, {
    label: 'world calendar payload',
    allowed: [
      'expected_version',
      'next_version',
      'from_ordinal_minutes',
      'duration_minutes',
      'to_ordinal_minutes',
      'display_date',
      'phase'
    ]
  });
  assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 0 });
  assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
  assertInteger(effect.payload.from_ordinal_minutes, 'payload.from_ordinal_minutes', { min: 0 });
  assertInteger(effect.payload.duration_minutes, 'payload.duration_minutes', { min: 1 });
  assertInteger(effect.payload.to_ordinal_minutes, 'payload.to_ordinal_minutes', { min: 1 });
  assertString(effect.payload.display_date, 'payload.display_date', { max: 160 });
  assertString(effect.payload.phase, 'payload.phase', { enumValues: CALENDAR_PHASES });
}

function reduceCalendar(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  const before = next.shared_world.calendar;
  assertWorldCalendar(before);
  if (before.calendar_id !== effect.target.calendar_id) {
    fail('EFFECT_TARGET_NOT_FOUND', 'calendar target does not exist');
  }
  assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'calendar');
  if (before.ordinal_minutes !== effect.payload.from_ordinal_minutes) {
    fail('EFFECT_PRECONDITION_FAILED', 'calendar ordinal precondition failed');
  }
  const calculated = effect.payload.from_ordinal_minutes + effect.payload.duration_minutes;
  if (calculated !== effect.payload.to_ordinal_minutes) {
    fail('INVALID_EFFECT_PAYLOAD', 'calendar duration does not match the supplied ordinal result');
  }
  const after = {
    ...before,
    version: effect.payload.next_version,
    ordinal_minutes: effect.payload.to_ordinal_minutes,
    display_date: effect.payload.display_date,
    phase: effect.payload.phase
  };
  next.shared_world.calendar = after;
  assertWorldCalendar(after);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'advance_world_calendar',
    reducerVersion: WORLD_REDUCER_VERSIONS.advance_world_calendar,
    primary: {
      operation: 'advance_by_frozen_duration',
      target: effect.target,
      before,
      after
    },
    invariantResults: [
      { invariant_id: 'world-calendar-monotonic' },
      { invariant_id: 'world-calendar-no-system-time' }
    ]
  });
}

export const WORLD_EFFECT_CONTRACTS = Object.freeze([
  ...Object.entries(WORLD_PAIR_CONFIGS).map(([kind, config]) => Object.freeze({
    domain: 'world',
    kind,
    operations: Object.freeze(['set']),
    reducerKey: 'apply_world_state_effect',
    reducerVersion: WORLD_REDUCER_VERSIONS.apply_world_state_effect,
    validate: effect => validateWorldPairEffect(effect, config),
    reduce: (candidate, effect) => reduceWorldPair(candidate, effect, config)
  })),
  Object.freeze({
    domain: 'world',
    kind: 'map_marker',
    operations: Object.freeze(['upsert', 'remove']),
    reducerKey: 'apply_world_state_effect',
    reducerVersion: WORLD_REDUCER_VERSIONS.apply_world_state_effect,
    validate: validateMapMarkerEffect,
    reduce: reduceMapMarker
  }),
  Object.freeze({
    domain: 'calendar',
    kind: 'calendar',
    operations: Object.freeze(['advance']),
    reducerKey: 'advance_world_calendar',
    reducerVersion: WORLD_REDUCER_VERSIONS.advance_world_calendar,
    validate: validateCalendarEffect,
    reduce: reduceCalendar
  })
]);

export { assertNpcProfile };
