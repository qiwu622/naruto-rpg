/**
 * Pure, fail-closed audience projection for multiplayer canonical facts.
 *
 * Input is a canonical JSON-like object with top-level `events` and optional
 * `facts` arrays. Every top-level record must grant access explicitly through
 * `audiences`, `world_public`, or `visibility`. Nested objects inherit their
 * parent's access only when they do not declare their own policy.
 *
 * `shared` means the structural intersection of seat A and seat B knowledge.
 * It is deliberately independent from `world_public`, which only trusts an
 * explicit world-public grant.
 */

export const PROJECTION_AUDIENCE = Object.freeze({
  SEAT_A: 'seat:A',
  SEAT_B: 'seat:B',
  SHARED: 'shared',
  WORLD_PUBLIC: 'world_public'
});

export const AUDIENCE_PROJECTION_SCHEMA = 'naruto.multiplayer-audience-projection/v1';
export const SHARED_PROJECTION_SCHEMA = 'naruto.multiplayer-shared-narrative-projection/v1';
export const WORLD_PUBLIC_PROJECTION_SCHEMA = 'naruto.multiplayer-world-public-projection/v1';

const SUPPORTED_TARGETS = new Set(Object.values(PROJECTION_AUDIENCE));
const POLICY_KEYS = new Set(['audiences', 'visibility', 'world_public']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INTERNAL_COLLECTION_KEYS = new Set([
  'conflict',
  'conflicts',
  'effect',
  'effects',
  'outcome',
  'outcomes'
]);
const INTERNAL_REFERENCE_KEYS = new Set([
  'action_id',
  'action_ids',
  'action_ref',
  'action_refs',
  'conflict_id',
  'conflict_ids',
  'conflict_ref',
  'conflict_refs',
  'effect_id',
  'effect_ids',
  'effect_ref',
  'effect_refs',
  'outcome_id',
  'outcome_ids',
  'outcome_ref',
  'outcome_refs',
  'submission_id',
  'submission_ids',
  'submission_ref',
  'submission_refs'
]);
const SERVER_EXPLANATION_KEYS = new Set([
  'debug',
  'debug_info',
  'error',
  'errors',
  'error_code',
  'error_message',
  'failure_reason',
  'internal_reason',
  'reason',
  'reasoning',
  'reasons',
  'rule_basis',
  'rule_evidence',
  'server_only_reason'
]);
const TRANSPORT_KEYS = new Set([
  'commitment',
  'hmac_commitment',
  'input_hash',
  'receipt_seq',
  'received_at',
  'resolution_commitment',
  'submitted_at'
]);

const DENY_VISIBILITY = new Set([
  'canonical',
  'internal',
  'npc_private',
  'private',
  'server_only'
]);
const NEUTRAL_VISIBILITY = new Set(['audience_scoped']);
const SEAT_A_VISIBILITY = new Set(['actor:A', 'seat:A']);
const SEAT_B_VISIBILITY = new Set(['actor:B', 'seat:B']);
const SHARED_VISIBILITY = new Set(['room_members', 'shared']);
const PUBLIC_VISIBILITY = new Set(['public', 'world_public']);
const SUPPORTED_VISIBILITY = new Set([
  ...DENY_VISIBILITY,
  ...NEUTRAL_VISIBILITY,
  ...SEAT_A_VISIBILITY,
  ...SEAT_B_VISIBILITY,
  ...SHARED_VISIBILITY,
  ...PUBLIC_VISIBILITY
]);

const DROP = Symbol('drop-from-audience-projection');

export class AudienceProjectionError extends Error {
  constructor(code, message, path = '$') {
    super(message);
    this.name = 'AudienceProjectionError';
    this.code = code;
    this.path = path;
  }
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readDataProperty(object, key, path) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || own(descriptor, 'get') || own(descriptor, 'set')) {
    throw new AudienceProjectionError(
      'NON_JSON_PROPERTY',
      'Audience projection accepts data properties only.',
      `${path}.${key}`
    );
  }
  return descriptor.value;
}

function assertPlainRecord(value, path) {
  if (!isPlainObject(value)) {
    throw new AudienceProjectionError(
      'INVALID_RECORD',
      'Audience projection records must be plain JSON objects.',
      path
    );
  }
}

function normalizeVisibility(record, path) {
  if (!own(record, 'visibility')) return null;
  const visibility = readDataProperty(record, 'visibility', path);
  if (typeof visibility !== 'string' || !SUPPORTED_VISIBILITY.has(visibility)) {
    throw new AudienceProjectionError(
      'INVALID_VISIBILITY',
      'Unsupported audience visibility value.',
      `${path}.visibility`
    );
  }
  return visibility;
}

function normalizeAudiences(record, path) {
  if (!own(record, 'audiences')) return null;
  const audiences = readDataProperty(record, 'audiences', path);
  if (!Array.isArray(audiences)) {
    throw new AudienceProjectionError(
      'INVALID_AUDIENCES',
      'audiences must be an array of audience identifiers.',
      `${path}.audiences`
    );
  }

  const normalized = new Set();
  for (let index = 0; index < audiences.length; index += 1) {
    const audience = audiences[index];
    if (typeof audience !== 'string' || audience.length === 0) {
      throw new AudienceProjectionError(
        'INVALID_AUDIENCE',
        'Audience identifiers must be non-empty strings.',
        `${path}.audiences[${index}]`
      );
    }
    normalized.add(audience);
  }
  return normalized;
}

function normalizeWorldPublic(record, path) {
  if (!own(record, 'world_public')) return null;
  const worldPublic = readDataProperty(record, 'world_public', path);
  if (typeof worldPublic !== 'boolean') {
    throw new AudienceProjectionError(
      'INVALID_WORLD_PUBLIC',
      'world_public must be a boolean.',
      `${path}.world_public`
    );
  }
  return worldPublic;
}

function hasPolicy(record) {
  return own(record, 'audiences') || own(record, 'visibility') || own(record, 'world_public');
}

function audiencesGrantSeat(audiences, seat) {
  if (!audiences) return false;
  if (audiences.has('shared') || audiences.has('room_members')) return true;
  if (seat === PROJECTION_AUDIENCE.SEAT_A) {
    return audiences.has('seat:A') || audiences.has('actor:A');
  }
  return audiences.has('seat:B') || audiences.has('actor:B');
}

function visibilityGrantsSeat(visibility, seat) {
  if (!visibility) return false;
  if (SHARED_VISIBILITY.has(visibility)) return true;
  if (seat === PROJECTION_AUDIENCE.SEAT_A) return SEAT_A_VISIBILITY.has(visibility);
  return SEAT_B_VISIBILITY.has(visibility);
}

function policyGrantsSeat(policy, seat) {
  if (policy.audiences !== null) return audiencesGrantSeat(policy.audiences, seat);
  return visibilityGrantsSeat(policy.visibility, seat);
}

function objectIsVisible(record, target, inheritedVisible, path) {
  if (!hasPolicy(record)) return inheritedVisible;

  const visibility = normalizeVisibility(record, path);
  if (DENY_VISIBILITY.has(visibility)) return false;

  const audiences = normalizeAudiences(record, path);
  const worldPublic = normalizeWorldPublic(record, path);
  const policy = { visibility, audiences, worldPublic };
  if (target === PROJECTION_AUDIENCE.SEAT_A) {
    return policyGrantsSeat(policy, PROJECTION_AUDIENCE.SEAT_A);
  }
  if (target === PROJECTION_AUDIENCE.SEAT_B) {
    return policyGrantsSeat(policy, PROJECTION_AUDIENCE.SEAT_B);
  }
  if (target === PROJECTION_AUDIENCE.SHARED) {
    return policyGrantsSeat(policy, PROJECTION_AUDIENCE.SEAT_A)
      && policyGrantsSeat(policy, PROJECTION_AUDIENCE.SEAT_B);
  }

  if (worldPublic !== null) return worldPublic;
  return PUBLIC_VISIBILITY.has(visibility);
}

function shouldStripKey(key) {
  if (DANGEROUS_KEYS.has(key)) return true;
  if (POLICY_KEYS.has(key)) return true;
  if (INTERNAL_COLLECTION_KEYS.has(key)) return true;
  if (INTERNAL_REFERENCE_KEYS.has(key)) return true;
  if (SERVER_EXPLANATION_KEYS.has(key)) return true;
  if (TRANSPORT_KEYS.has(key)) return true;
  if (key.startsWith('_') || key.startsWith('debug_') || key.startsWith('internal_') || key.startsWith('server_')) {
    return true;
  }
  if (/(^|_)(count|index|length|ordinal|position|seq|total)$/.test(key)) return true;
  return false;
}

function classifyReferenceKey(key, identityKey) {
  if (key === identityKey) return null;
  if (key === 'event_id' || key === 'event_ref' || /_event_(id|ref)$/.test(key)) return 'event-one';
  if (key === 'event_ids' || key === 'event_refs' || /_event_(ids|refs)$/.test(key)) return 'event-many';
  if (key === 'fact_id' || key === 'fact_ref' || /_fact_(id|ref)$/.test(key)) return 'fact-one';
  if (key === 'fact_ids' || key === 'fact_refs' || /_fact_(ids|refs)$/.test(key)) return 'fact-many';
  if (key.endsWith('_ref')) return 'generic-one';
  if (key.endsWith('_refs')) return 'generic-many';
  return null;
}

function filterKnownReference(reference, kind, registry) {
  if (kind.startsWith('event-')) return registry.visibleEventIds.has(reference);
  if (kind.startsWith('fact-')) return registry.visibleFactIds.has(reference);
  if (registry.allEventIds.has(reference)) return registry.visibleEventIds.has(reference);
  if (registry.allFactIds.has(reference)) return registry.visibleFactIds.has(reference);
  return true;
}

function sanitizeReference(value, kind, registry, path) {
  if (kind.endsWith('-one')) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new AudienceProjectionError(
        'INVALID_REFERENCE',
        'A singular reference must be a non-empty string.',
        path
      );
    }
    return filterKnownReference(value, kind, registry) ? value : DROP;
  }

  if (!Array.isArray(value)) {
    throw new AudienceProjectionError(
      'INVALID_REFERENCES',
      'A reference collection must be an array.',
      path
    );
  }

  const references = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const reference = value[index];
    if (typeof reference !== 'string' || reference.length === 0) {
      throw new AudienceProjectionError(
        'INVALID_REFERENCE',
        'References must be non-empty strings.',
        `${path}[${index}]`
      );
    }
    if (filterKnownReference(reference, kind, registry)) references.add(reference);
  }

  const projected = [...references].sort(compareText);
  return projected.length > 0 ? projected : DROP;
}

function stableArrayIdentity(value) {
  if (!isPlainObject(value)) return null;
  for (const key of ['event_id', 'fact_id', 'id']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && own(descriptor, 'value') && typeof descriptor.value === 'string') {
      return descriptor.value;
    }
  }
  return null;
}

function sortIdentifiedArray(values) {
  if (values.length < 2) return values;
  const identities = values.map(stableArrayIdentity);
  if (identities.some(identity => identity === null)) return values;
  return values
    .map((value, index) => ({ value, identity: identities[index] }))
    .sort((left, right) => compareText(left.identity, right.identity))
    .map(entry => entry.value);
}

function sanitizeValue(value, context) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AudienceProjectionError(
        'NON_JSON_NUMBER',
        'Audience projection only accepts finite numbers.',
        context.path
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    if (context.seen.has(value)) {
      throw new AudienceProjectionError('CYCLIC_INPUT', 'Audience projection input must be acyclic.', context.path);
    }
    context.seen.add(value);
    try {
      const projected = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!own(value, index)) continue;
        const item = sanitizeValue(value[index], {
          ...context,
          identityKey: null,
          path: `${context.path}[${index}]`
        });
        if (item !== DROP) projected.push(item);
      }
      if (projected.length === 0) return DROP;
      return sortIdentifiedArray(projected);
    } finally {
      context.seen.delete(value);
    }
  }

  if (!isPlainObject(value)) {
    throw new AudienceProjectionError(
      'NON_JSON_VALUE',
      'Audience projection accepts JSON-compatible values only.',
      context.path
    );
  }
  if (!objectIsVisible(value, context.target, context.inheritedVisible, context.path)) return DROP;
  if (context.seen.has(value)) {
    throw new AudienceProjectionError('CYCLIC_INPUT', 'Audience projection input must be acyclic.', context.path);
  }

  context.seen.add(value);
  try {
    const projected = {};
    const keys = Object.keys(value).sort(compareText);
    for (const key of keys) {
      if (shouldStripKey(key)) continue;
      const childPath = `${context.path}.${key}`;
      const childValue = readDataProperty(value, key, context.path);
      const referenceKind = classifyReferenceKey(key, context.identityKey);
      const sanitized = referenceKind
        ? sanitizeReference(childValue, referenceKind, context.registry, childPath)
        : sanitizeValue(childValue, {
            ...context,
            identityKey: null,
            inheritedVisible: true,
            path: childPath
          });
      if (sanitized !== DROP) projected[key] = sanitized;
    }

    return Object.keys(projected).length > 0 ? projected : DROP;
  } finally {
    context.seen.delete(value);
  }
}

function assertRecordArray(source, key) {
  if (!own(source, key)) return [];
  const records = readDataProperty(source, key, '$');
  if (!Array.isArray(records)) {
    throw new AudienceProjectionError(
      'INVALID_COLLECTION',
      `${key} must be an array.`,
      `$.${key}`
    );
  }
  return records;
}

function collectRecordIds(records, identityKey, path) {
  const ids = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const recordPath = `${path}[${index}]`;
    const record = records[index];
    assertPlainRecord(record, recordPath);
    const id = readDataProperty(record, identityKey, recordPath);
    if (typeof id !== 'string' || id.length === 0) {
      throw new AudienceProjectionError(
        'INVALID_RECORD_ID',
        `${identityKey} must be a non-empty string.`,
        `${recordPath}.${identityKey}`
      );
    }
    if (ids.has(id)) {
      throw new AudienceProjectionError(
        'DUPLICATE_RECORD_ID',
        `Duplicate ${identityKey}.`,
        `${recordPath}.${identityKey}`
      );
    }
    ids.add(id);
  }
  return ids;
}

function prepareSource(source) {
  assertPlainRecord(source, '$');
  const events = assertRecordArray(source, 'events');
  const facts = assertRecordArray(source, 'facts');
  const allEventIds = collectRecordIds(events, 'event_id', '$.events');
  const allFactIds = collectRecordIds(facts, 'fact_id', '$.facts');

  let turnId = null;
  if (own(source, 'turn_id')) {
    turnId = readDataProperty(source, 'turn_id', '$');
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new AudienceProjectionError(
        'INVALID_TURN_ID',
        'turn_id must be a non-empty string.',
        '$.turn_id'
      );
    }
  }

  return { events, facts, allEventIds, allFactIds, turnId };
}

function visibleIds(records, identityKey, target, path) {
  const ids = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (objectIsVisible(record, target, false, `${path}[${index}]`)) {
      ids.add(readDataProperty(record, identityKey, `${path}[${index}]`));
    }
  }
  return ids;
}

function projectionSchema(target) {
  if (target === PROJECTION_AUDIENCE.SHARED) return SHARED_PROJECTION_SCHEMA;
  if (target === PROJECTION_AUDIENCE.WORLD_PUBLIC) return WORLD_PUBLIC_PROJECTION_SCHEMA;
  return AUDIENCE_PROJECTION_SCHEMA;
}

function projectPrepared(prepared, target) {
  const registry = {
    allEventIds: prepared.allEventIds,
    allFactIds: prepared.allFactIds,
    visibleEventIds: visibleIds(prepared.events, 'event_id', target, '$.events'),
    visibleFactIds: visibleIds(prepared.facts, 'fact_id', target, '$.facts')
  };

  const projectRecords = (records, identityKey, path) => {
    const projected = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = sanitizeValue(records[index], {
        identityKey,
        inheritedVisible: false,
        path: `${path}[${index}]`,
        registry,
        seen: new Set(),
        target
      });
      if (record !== DROP) projected.push(record);
    }
    return projected.sort((left, right) => compareText(left[identityKey], right[identityKey]));
  };

  const projection = {
    schema: projectionSchema(target),
    audience: target
  };
  if (prepared.turnId !== null) projection.turn_id = prepared.turnId;
  projection.events = projectRecords(prepared.events, 'event_id', '$.events');
  projection.facts = projectRecords(prepared.facts, 'fact_id', '$.facts');
  return projection;
}

/**
 * Produce one safe projection. `target` must be one of PROJECTION_AUDIENCE.
 */
export function projectAudience(source, target) {
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new AudienceProjectionError(
      'INVALID_PROJECTION_TARGET',
      'Unsupported audience projection target.',
      '$.target'
    );
  }
  return projectPrepared(prepareSource(source), target);
}

/**
 * Produce four independent deep projections from one canonical input.
 */
export function projectAudienceViews(source) {
  const prepared = prepareSource(source);
  return {
    seat_A: projectPrepared(prepared, PROJECTION_AUDIENCE.SEAT_A),
    seat_B: projectPrepared(prepared, PROJECTION_AUDIENCE.SEAT_B),
    shared: projectPrepared(prepared, PROJECTION_AUDIENCE.SHARED),
    world_public: projectPrepared(prepared, PROJECTION_AUDIENCE.WORLD_PUBLIC)
  };
}

export const AudienceProjector = Object.freeze({
  project: projectAudience,
  projectAll: projectAudienceViews
});
