import {
  assertArray,
  assertExactKeys,
  assertIdentifier,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';
import { NARRATIVE_MODES } from './enums.js';
import {
  CANONICAL_RESOLUTION_SCHEMA,
  assertCanonicalResolution
} from './resolution-contracts.js';
import {
  canonicalStringify,
  sha256Hex
} from '../domain/canonical-json.js';

export const NARRATIVE_CANDIDATE_SCHEMA = 'naruto.multiplayer-narrative-candidate/v1';
export const NARRATIVE_DELIVERY_SCHEMA = 'naruto.multiplayer-narrative/v1';
export const NARRATIVE_GROUNDING_REVIEW_SCHEMA =
  'naruto.multiplayer-narrative-grounding-review-receipt/v1';

export const NARRATIVE_AUDIENCES = Object.freeze([
  'shared',
  'seat:A',
  'seat:B'
]);

export const NARRATIVE_GROUNDING_REVIEW_STATUSES = Object.freeze([
  'APPROVED',
  'REJECTED'
]);

export const NARRATIVE_LIMITS = Object.freeze({
  maxSegments: 128,
  maxEventRefsPerSegment: 256,
  maxClaimsPerSegment: 512,
  maxTextLength: 40_000,
  maxPredicateLength: 128,
  maxFindings: 128,
  maxFindingLength: 2_000
});

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const IDENTIFIER_PATTERN = '^[A-Za-z][A-Za-z0-9:_-]*$';
const EVENT_ID_PATTERN = '^event_[A-Za-z0-9_-]{1,122}$';
const SEGMENT_ID_PATTERN = '^segment_[A-Za-z0-9_-]{1,120}$';
const HMAC_SHA256_PATTERN = '^hmac-sha256:[a-f0-9]{64}$';
const SHA256_PATTERN = '^sha256:[a-f0-9]{64}$';
const SAFE_NONBLANK_TEXT_PATTERN =
  '^(?=[\\s\\S]*\\S)(?![\\s\\S]*[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069])[\\s\\S]*$';

const narrativeClaimJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['event_id', 'subject_id', 'predicate', 'value'],
  properties: {
    event_id: {
      type: 'string',
      minLength: 7,
      maxLength: 128,
      pattern: EVENT_ID_PATTERN
    },
    subject_id: {
      type: 'string',
      minLength: 2,
      maxLength: 160,
      pattern: IDENTIFIER_PATTERN
    },
    predicate: {
      type: 'string',
      minLength: 1,
      maxLength: NARRATIVE_LIMITS.maxPredicateLength,
      pattern: '^[a-z][a-z0-9_]{0,127}$'
    },
    value: {}
  }
};

const narrativeSegmentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['segment_id', 'event_refs', 'claims', 'text'],
  properties: {
    segment_id: {
      type: 'string',
      minLength: 9,
      maxLength: 128,
      pattern: SEGMENT_ID_PATTERN
    },
    event_refs: {
      type: 'array',
      minItems: 1,
      maxItems: NARRATIVE_LIMITS.maxEventRefsPerSegment,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 7,
        maxLength: 128,
        pattern: EVENT_ID_PATTERN
      }
    },
    claims: {
      type: 'array',
      minItems: 1,
      maxItems: NARRATIVE_LIMITS.maxClaimsPerSegment,
      items: narrativeClaimJsonSchema
    },
    text: {
      type: 'string',
      minLength: 1,
      maxLength: NARRATIVE_LIMITS.maxTextLength,
      pattern: SAFE_NONBLANK_TEXT_PATTERN
    }
  }
};

const narrativeCandidateProperties = {
  segments: {
    type: 'array',
    minItems: 1,
    maxItems: NARRATIVE_LIMITS.maxSegments,
    items: narrativeSegmentJsonSchema
  },
  stop_point_ref: {
    type: 'string',
    minLength: 7,
    maxLength: 128,
    pattern: EVENT_ID_PATTERN
  }
};

export const NARRATIVE_CANDIDATE_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: NARRATIVE_CANDIDATE_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: ['segments', 'stop_point_ref'],
  properties: narrativeCandidateProperties
});

export const NARRATIVE_DELIVERY_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: NARRATIVE_DELIVERY_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'turn_id',
    'audience',
    'resolution_commitment',
    'segments',
    'stop_point_ref'
  ],
  properties: {
    schema: { const: NARRATIVE_DELIVERY_SCHEMA },
    turn_id: {
      type: 'string',
      minLength: 6,
      maxLength: 160,
      pattern: '^turn_[A-Za-z0-9_-]{1,155}$'
    },
    audience: { type: 'string', enum: NARRATIVE_AUDIENCES },
    resolution_commitment: { type: 'string', pattern: HMAC_SHA256_PATTERN },
    ...narrativeCandidateProperties
  }
});

export const NARRATIVE_GROUNDING_REVIEW_RECEIPT_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: NARRATIVE_GROUNDING_REVIEW_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'review_id',
    'reviewer_run_id',
    'turn_id',
    'audience',
    'resolution_commitment',
    'delivery_hash',
    'status',
    'findings'
  ],
  properties: {
    schema: { const: NARRATIVE_GROUNDING_REVIEW_SCHEMA },
    review_id: {
      type: 'string',
      minLength: 8,
      maxLength: 160,
      pattern: '^review_[A-Za-z0-9_-]{1,153}$'
    },
    reviewer_run_id: {
      type: 'string',
      minLength: 2,
      maxLength: 160,
      pattern: IDENTIFIER_PATTERN
    },
    turn_id: {
      type: 'string',
      minLength: 6,
      maxLength: 160,
      pattern: '^turn_[A-Za-z0-9_-]{1,155}$'
    },
    audience: { type: 'string', enum: NARRATIVE_AUDIENCES },
    resolution_commitment: { type: 'string', pattern: HMAC_SHA256_PATTERN },
    delivery_hash: { type: 'string', pattern: SHA256_PATTERN },
    status: { type: 'string', enum: NARRATIVE_GROUNDING_REVIEW_STATUSES },
    findings: {
      type: 'array',
      maxItems: NARRATIVE_LIMITS.maxFindings,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: NARRATIVE_LIMITS.maxFindingLength
      }
    }
  },
  allOf: [{
    if: { properties: { status: { const: 'APPROVED' } }, required: ['status'] },
    then: { properties: { findings: { maxItems: 0 } } }
  }, {
    if: { properties: { status: { const: 'REJECTED' } }, required: ['status'] },
    then: { properties: { findings: { minItems: 1 } } }
  }]
});

const CANDIDATE_KEYS = Object.freeze(['segments', 'stop_point_ref']);
const DELIVERY_KEYS = Object.freeze([
  'schema',
  'turn_id',
  'audience',
  'resolution_commitment',
  'segments',
  'stop_point_ref'
]);
const SEGMENT_KEYS = Object.freeze([
  'segment_id',
  'event_refs',
  'claims',
  'text'
]);
const CLAIM_KEYS = Object.freeze([
  'event_id',
  'subject_id',
  'predicate',
  'value'
]);
const DELIVERY_BINDING_KEYS = Object.freeze([
  'turn_id',
  'audience',
  'resolution_commitment',
  'canonical_resolution'
]);
const DELIVERY_SET_CONTEXT_KEYS = Object.freeze([
  'narrative_mode',
  'canonical_resolution',
  'resolution_commitment'
]);
const REVIEW_RESULT_KEYS = Object.freeze([
  'review_id',
  'reviewer_run_id',
  'status',
  'findings'
]);
const REVIEW_RECEIPT_KEYS = Object.freeze([
  'schema',
  'review_id',
  'reviewer_run_id',
  'turn_id',
  'audience',
  'resolution_commitment',
  'delivery_hash',
  'status',
  'findings'
]);

const HMAC_SHA256 = /^hmac-sha256:[a-f0-9]{64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PREDICATE = /^[a-z][a-z0-9_]{0,127}$/;

// This is intentionally only a syntactic deny-list for legacy machine
// channels. It is not presented as proof of the prose's semantic grounding.
const MACHINE_TAG = /<\/?(?:reasoning|final|var|variable|var_thinking|variable_thinking|status_query|combat|mission|relationship|event|state_update|memory|shinobi_daily|update_manifest|effect)(?:\s|\/?>)/iu;
const MACHINE_IDENTIFIER = /(?:^|[^A-Za-z0-9])(?:effect|event|conflict|submission|action)_[A-Za-z0-9_-]+(?:$|[^A-Za-z0-9])/u;

function pathFor(path, key) {
  return path === '/' ? `/${key}` : `${path}/${key}`;
}

function assertEventId(value, path) {
  return assertIdentifier(value, {
    path,
    label: 'event_id',
    prefix: 'event_',
    max: 128
  });
}

function assertUniqueStrings(value, {
  path,
  label,
  min = 0,
  max,
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

function normalizeClaim(claim, path) {
  assertExactKeys(claim, {
    allowed: CLAIM_KEYS,
    path,
    label: 'narrative claim'
  });
  assertEventId(claim.event_id, pathFor(path, 'event_id'));
  assertIdentifier(claim.subject_id, {
    path: pathFor(path, 'subject_id'),
    label: 'claim subject_id',
    max: 160
  });
  assertString(claim.predicate, {
    path: pathFor(path, 'predicate'),
    label: 'claim predicate',
    pattern: PREDICATE,
    max: NARRATIVE_LIMITS.maxPredicateLength
  });

  // Detaches and strictly checks the arbitrary typed claim value. Domain
  // compatibility belongs to the canonical-event/rule audit, never a prose
  // regex.
  const value = immutableContractValue(claim.value);
  return immutableContractValue({
    event_id: claim.event_id,
    subject_id: claim.subject_id,
    predicate: claim.predicate,
    value
  });
}

function assertNarrativeText(text, path) {
  assertString(text, {
    path,
    label: 'narrative segment text',
    max: NARRATIVE_LIMITS.maxTextLength
  });
  if (!text.trim()) {
    throw contractError(path, 'narrative segment text must contain non-whitespace prose');
  }
  if (MACHINE_TAG.test(text) || MACHINE_IDENTIFIER.test(text)) {
    throw contractError(path, 'narrative prose contains a forbidden machine tag or hidden identifier');
  }
  return text;
}

function normalizeSegment(segment, path) {
  assertExactKeys(segment, {
    allowed: SEGMENT_KEYS,
    path,
    label: 'narrative segment'
  });
  assertIdentifier(segment.segment_id, {
    path: pathFor(path, 'segment_id'),
    label: 'segment_id',
    prefix: 'segment_',
    max: 128
  });
  assertUniqueStrings(segment.event_refs, {
    path: pathFor(path, 'event_refs'),
    label: 'segment event_refs',
    min: 1,
    max: NARRATIVE_LIMITS.maxEventRefsPerSegment,
    validate: assertEventId
  });

  const claims = [];
  const claimIdentities = new Set();
  assertArray(segment.claims, {
    path: pathFor(path, 'claims'),
    label: 'segment claims',
    min: 1,
    max: NARRATIVE_LIMITS.maxClaimsPerSegment,
    item(item, itemPath) {
      const claim = normalizeClaim(item, itemPath);
      const identity = canonicalStringify(claim);
      if (claimIdentities.has(identity)) {
        throw contractError(itemPath, 'segment contains a duplicate structured claim');
      }
      claimIdentities.add(identity);
      claims.push(claim);
    }
  });
  assertNarrativeText(segment.text, pathFor(path, 'text'));

  const eventRefs = new Set(segment.event_refs);
  const claimedEventIds = new Set();
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    if (!eventRefs.has(claim.event_id)) {
      throw contractError(
        `${pathFor(path, 'claims')}/${index}/event_id`,
        'claim event_id must also appear in its segment event_refs',
        { event_id: claim.event_id }
      );
    }
    claimedEventIds.add(claim.event_id);
  }
  for (let index = 0; index < segment.event_refs.length; index += 1) {
    if (!claimedEventIds.has(segment.event_refs[index])) {
      throw contractError(
        `${pathFor(path, 'event_refs')}/${index}`,
        'every event_ref must be covered by at least one structured claim',
        { event_id: segment.event_refs[index] }
      );
    }
  }

  return immutableContractValue({
    segment_id: segment.segment_id,
    event_refs: segment.event_refs,
    claims,
    text: segment.text
  });
}

function normalizeNarrativeCandidate(candidate) {
  const detached = immutableContractValue(candidate);
  assertExactKeys(detached, {
    allowed: CANDIDATE_KEYS,
    path: '/',
    label: 'narrative candidate'
  });

  const segments = [];
  const segmentIds = new Set();
  assertArray(detached.segments, {
    path: '/segments',
    label: 'narrative segments',
    min: 1,
    max: NARRATIVE_LIMITS.maxSegments,
    item(item, itemPath) {
      const segment = normalizeSegment(item, itemPath);
      if (segmentIds.has(segment.segment_id)) {
        throw contractError(`${itemPath}/segment_id`, 'segment_id must be unique', {
          duplicate_id: segment.segment_id
        });
      }
      segmentIds.add(segment.segment_id);
      segments.push(segment);
    }
  });
  assertEventId(detached.stop_point_ref, '/stop_point_ref');

  return immutableContractValue({
    segments,
    stop_point_ref: detached.stop_point_ref
  });
}

/** The Writer can return exactly `segments` and `stop_point_ref`. */
export function assertNarrativeCandidate(candidate) {
  return normalizeNarrativeCandidate(candidate);
}

export function inspectNarrativeCandidate(candidate) {
  return inspectContract(candidate, assertNarrativeCandidate);
}

function normalizeDeliveryBinding(binding) {
  assertExactKeys(binding, {
    allowed: DELIVERY_BINDING_KEYS,
    path: '/binding',
    label: 'NarrativeDelivery binding'
  });
  assertIdentifier(binding.turn_id, {
    path: '/binding/turn_id',
    label: 'turn_id',
    prefix: 'turn_',
    max: 160
  });
  assertString(binding.audience, {
    path: '/binding/audience',
    label: 'narrative audience',
    enumValues: NARRATIVE_AUDIENCES,
    max: 32
  });
  assertString(binding.resolution_commitment, {
    path: '/binding/resolution_commitment',
    label: 'resolution_commitment',
    pattern: HMAC_SHA256,
    max: 80
  });
  const canonicalResolution = assertCanonicalResolution(binding.canonical_resolution);
  if (canonicalResolution.schema !== CANONICAL_RESOLUTION_SCHEMA
    || canonicalResolution.turn_id !== binding.turn_id) {
    throw contractError('/binding/turn_id', 'narrative turn binding does not match CanonicalResolution', {
      expected: canonicalResolution.turn_id,
      actual: binding.turn_id
    });
  }
  return {
    turn_id: binding.turn_id,
    audience: binding.audience,
    resolution_commitment: binding.resolution_commitment,
    canonical_resolution: canonicalResolution
  };
}

function grantsSeat(audiences, seat) {
  const audienceSet = new Set(audiences);
  if (audienceSet.has('shared') || audienceSet.has('room_members')) return true;
  if (seat === 'A') {
    return audienceSet.has('seat:A') || audienceSet.has('actor:A');
  }
  return audienceSet.has('seat:B') || audienceSet.has('actor:B');
}

function eventVisibleTo(event, audience) {
  if (audience === 'seat:A') return grantsSeat(event.audiences, 'A');
  if (audience === 'seat:B') return grantsSeat(event.audiences, 'B');
  return grantsSeat(event.audiences, 'A') && grantsSeat(event.audiences, 'B');
}

export function visibleNarrativeEventIds(canonicalResolution, audience) {
  const resolution = assertCanonicalResolution(canonicalResolution);
  assertString(audience, {
    path: '/audience',
    label: 'narrative audience',
    enumValues: NARRATIVE_AUDIENCES,
    max: 32
  });
  return Object.freeze(
    resolution.events
      .filter(event => eventVisibleTo(event, audience))
      .map(event => event.event_id)
      .sort()
  );
}

function assertNoCanonicalIdsInText(candidate, resolution) {
  const hiddenIdentifiers = new Set([
    ...resolution.conflicts.map(conflict => conflict.id),
    ...resolution.outcomes.map(outcome => outcome.submission_id),
    ...resolution.events.map(event => event.event_id),
    ...resolution.effects.map(effect => effect.effect_id)
  ]);
  for (let segmentIndex = 0; segmentIndex < candidate.segments.length; segmentIndex += 1) {
    const text = candidate.segments[segmentIndex].text;
    for (const identifier of hiddenIdentifiers) {
      if (text.includes(identifier)) {
        throw contractError(
          `/segments/${segmentIndex}/text`,
          'narrative prose exposes a canonical machine identifier',
          { identifier }
        );
      }
    }
  }
}

function assertAudienceReferencesAndCoverage(candidate, binding) {
  const visibleEventIds = new Set(
    visibleNarrativeEventIds(binding.canonical_resolution, binding.audience)
  );
  if (visibleEventIds.size === 0) {
    throw contractError(
      '/binding/audience',
      'NarrativeDelivery cannot be created for an audience with no visible canonical events',
      { audience: binding.audience }
    );
  }

  const covered = new Set();
  for (let segmentIndex = 0; segmentIndex < candidate.segments.length; segmentIndex += 1) {
    const segment = candidate.segments[segmentIndex];
    for (let refIndex = 0; refIndex < segment.event_refs.length; refIndex += 1) {
      const eventId = segment.event_refs[refIndex];
      const referencePath = `/segments/${segmentIndex}/event_refs/${refIndex}`;
      if (!visibleEventIds.has(eventId)) {
        throw contractError(referencePath, 'event_ref is not visible to this NarrativeDelivery audience', {
          audience: binding.audience,
          event_id: eventId
        });
      }
      if (covered.has(eventId)) {
        throw contractError(referencePath, 'a canonical event cannot be narrated more than once in one delivery', {
          event_id: eventId
        });
      }
      covered.add(eventId);
    }
  }

  const missing = [...visibleEventIds].filter(eventId => !covered.has(eventId));
  if (missing.length > 0) {
    throw contractError('/segments', 'NarrativeDelivery does not cover every visible canonical event', {
      missing_event_ids: missing.sort()
    });
  }
  if (!visibleEventIds.has(candidate.stop_point_ref)) {
    throw contractError('/stop_point_ref', 'stop_point_ref is not visible to this audience', {
      audience: binding.audience,
      event_id: candidate.stop_point_ref
    });
  }

  assertNoCanonicalIdsInText(candidate, binding.canonical_resolution);
}

/**
 * Adds only server-owned delivery metadata after hard audience/reference
 * validation. This function makes no claim that regexes prove prose meaning.
 */
export function freezeNarrativeDelivery(candidate, binding) {
  const normalizedCandidate = assertNarrativeCandidate(candidate);
  const normalizedBinding = normalizeDeliveryBinding(binding);
  assertAudienceReferencesAndCoverage(normalizedCandidate, normalizedBinding);

  return immutableContractValue({
    schema: NARRATIVE_DELIVERY_SCHEMA,
    turn_id: normalizedBinding.turn_id,
    audience: normalizedBinding.audience,
    resolution_commitment: normalizedBinding.resolution_commitment,
    segments: normalizedCandidate.segments,
    stop_point_ref: normalizedCandidate.stop_point_ref
  });
}

export const bindNarrativeDelivery = freezeNarrativeDelivery;

function assertNarrativeDeliveryShape(delivery) {
  const detached = immutableContractValue(delivery);
  assertExactKeys(detached, {
    allowed: DELIVERY_KEYS,
    path: '/',
    label: 'NarrativeDelivery'
  });
  assertString(detached.schema, {
    path: '/schema',
    label: 'NarrativeDelivery schema',
    enumValues: [NARRATIVE_DELIVERY_SCHEMA],
    max: 128
  });
  assertIdentifier(detached.turn_id, {
    path: '/turn_id',
    label: 'turn_id',
    prefix: 'turn_',
    max: 160
  });
  assertString(detached.audience, {
    path: '/audience',
    label: 'narrative audience',
    enumValues: NARRATIVE_AUDIENCES,
    max: 32
  });
  assertString(detached.resolution_commitment, {
    path: '/resolution_commitment',
    label: 'resolution_commitment',
    pattern: HMAC_SHA256,
    max: 80
  });
  const candidate = assertNarrativeCandidate({
    segments: detached.segments,
    stop_point_ref: detached.stop_point_ref
  });
  return immutableContractValue({
    schema: NARRATIVE_DELIVERY_SCHEMA,
    turn_id: detached.turn_id,
    audience: detached.audience,
    resolution_commitment: detached.resolution_commitment,
    segments: candidate.segments,
    stop_point_ref: candidate.stop_point_ref
  });
}

/** Revalidates both stored shape and its current canonical audience binding. */
export function assertNarrativeDelivery(delivery, canonicalResolution) {
  const normalized = assertNarrativeDeliveryShape(delivery);
  const resolution = assertCanonicalResolution(canonicalResolution);
  if (normalized.turn_id !== resolution.turn_id) {
    throw contractError('/turn_id', 'NarrativeDelivery turn_id does not match CanonicalResolution', {
      expected: resolution.turn_id,
      actual: normalized.turn_id
    });
  }
  assertAudienceReferencesAndCoverage(
    { segments: normalized.segments, stop_point_ref: normalized.stop_point_ref },
    {
      turn_id: normalized.turn_id,
      audience: normalized.audience,
      resolution_commitment: normalized.resolution_commitment,
      canonical_resolution: resolution
    }
  );
  return normalized;
}

export function inspectNarrativeDelivery(delivery, canonicalResolution) {
  return inspectContract(delivery, value => assertNarrativeDelivery(value, canonicalResolution));
}

function normalizeDeliverySetContext(context) {
  assertExactKeys(context, {
    allowed: DELIVERY_SET_CONTEXT_KEYS,
    path: '/context',
    label: 'narrative delivery set context'
  });
  assertString(context.narrative_mode, {
    path: '/context/narrative_mode',
    label: 'narrative_mode',
    enumValues: NARRATIVE_MODES,
    max: 32
  });
  assertString(context.resolution_commitment, {
    path: '/context/resolution_commitment',
    label: 'resolution_commitment',
    pattern: HMAC_SHA256,
    max: 80
  });
  return {
    narrative_mode: context.narrative_mode,
    canonical_resolution: assertCanonicalResolution(context.canonical_resolution),
    resolution_commitment: context.resolution_commitment
  };
}

/** Enforces one shared delivery or exactly the A/B dual-POV pair. */
export function assertNarrativeDeliverySet(deliveries, context) {
  const normalizedContext = normalizeDeliverySetContext(context);
  const expectedAudiences = normalizedContext.narrative_mode === 'shared'
    ? ['shared']
    : ['seat:A', 'seat:B'];
  assertArray(deliveries, {
    path: '/deliveries',
    label: 'NarrativeDelivery set',
    min: expectedAudiences.length,
    max: expectedAudiences.length
  });

  const byAudience = new Map();
  for (let index = 0; index < deliveries.length; index += 1) {
    const delivery = assertNarrativeDelivery(deliveries[index], normalizedContext.canonical_resolution);
    if (!expectedAudiences.includes(delivery.audience)) {
      throw contractError(`/deliveries/${index}/audience`, 'delivery audience does not belong to narrative mode', {
        narrative_mode: normalizedContext.narrative_mode,
        audience: delivery.audience
      });
    }
    if (byAudience.has(delivery.audience)) {
      throw contractError(`/deliveries/${index}/audience`, 'delivery audience must be unique', {
        audience: delivery.audience
      });
    }
    if (delivery.resolution_commitment !== normalizedContext.resolution_commitment) {
      throw contractError(
        `/deliveries/${index}/resolution_commitment`,
        'delivery resolution_commitment does not match the server-bound resolution',
        {
          expected: normalizedContext.resolution_commitment,
          actual: delivery.resolution_commitment
        }
      );
    }
    byAudience.set(delivery.audience, delivery);
  }

  for (const audience of expectedAudiences) {
    if (!byAudience.has(audience)) {
      throw contractError('/deliveries', 'NarrativeDelivery set is missing a required audience', {
        narrative_mode: normalizedContext.narrative_mode,
        missing_audience: audience
      });
    }
  }
  return Object.freeze(expectedAudiences.map(audience => byAudience.get(audience)));
}

export const validateNarrativeDeliverySet = assertNarrativeDeliverySet;

function normalizeReviewFindings(findings, status, path = '/findings') {
  const normalized = [];
  assertArray(findings, {
    path,
    label: 'grounding review findings',
    min: status === 'REJECTED' ? 1 : 0,
    max: NARRATIVE_LIMITS.maxFindings,
    item(item, itemPath) {
      normalized.push(assertString(item, {
        path: itemPath,
        label: 'grounding review finding',
        max: NARRATIVE_LIMITS.maxFindingLength
      }));
    }
  });
  if (status === 'APPROVED' && normalized.length !== 0) {
    throw contractError(path, 'an APPROVED grounding review cannot contain findings');
  }
  return normalized;
}

function narrativeDeliveryHash(delivery) {
  return `sha256:${sha256Hex(canonicalStringify(delivery))}`;
}

/**
 * Records a trusted NarrativeGroundingReviewer verdict. The contract records
 * the semantic review; it does not try to derive that verdict from text.
 */
export function createNarrativeGroundingReviewReceipt(delivery, reviewResult) {
  const normalizedDelivery = assertNarrativeDeliveryShape(delivery);
  const detachedResult = immutableContractValue(reviewResult);
  assertExactKeys(detachedResult, {
    allowed: REVIEW_RESULT_KEYS,
    path: '/review_result',
    label: 'grounding review result'
  });
  assertIdentifier(detachedResult.review_id, {
    path: '/review_result/review_id',
    label: 'review_id',
    prefix: 'review_',
    max: 160
  });
  assertIdentifier(detachedResult.reviewer_run_id, {
    path: '/review_result/reviewer_run_id',
    label: 'reviewer_run_id',
    max: 160
  });
  assertString(detachedResult.status, {
    path: '/review_result/status',
    label: 'grounding review status',
    enumValues: NARRATIVE_GROUNDING_REVIEW_STATUSES,
    max: 32
  });
  const findings = normalizeReviewFindings(
    detachedResult.findings,
    detachedResult.status,
    '/review_result/findings'
  );

  return immutableContractValue({
    schema: NARRATIVE_GROUNDING_REVIEW_SCHEMA,
    review_id: detachedResult.review_id,
    reviewer_run_id: detachedResult.reviewer_run_id,
    turn_id: normalizedDelivery.turn_id,
    audience: normalizedDelivery.audience,
    resolution_commitment: normalizedDelivery.resolution_commitment,
    delivery_hash: narrativeDeliveryHash(normalizedDelivery),
    status: detachedResult.status,
    findings
  });
}

export const recordNarrativeGroundingReview = createNarrativeGroundingReviewReceipt;

export function assertNarrativeGroundingReviewReceipt(receipt) {
  const detached = immutableContractValue(receipt);
  assertExactKeys(detached, {
    allowed: REVIEW_RECEIPT_KEYS,
    path: '/',
    label: 'NarrativeGroundingReview receipt'
  });
  assertString(detached.schema, {
    path: '/schema',
    label: 'grounding review receipt schema',
    enumValues: [NARRATIVE_GROUNDING_REVIEW_SCHEMA],
    max: 160
  });
  assertIdentifier(detached.review_id, {
    path: '/review_id',
    label: 'review_id',
    prefix: 'review_',
    max: 160
  });
  assertIdentifier(detached.reviewer_run_id, {
    path: '/reviewer_run_id',
    label: 'reviewer_run_id',
    max: 160
  });
  assertIdentifier(detached.turn_id, {
    path: '/turn_id',
    label: 'turn_id',
    prefix: 'turn_',
    max: 160
  });
  assertString(detached.audience, {
    path: '/audience',
    label: 'narrative audience',
    enumValues: NARRATIVE_AUDIENCES,
    max: 32
  });
  assertString(detached.resolution_commitment, {
    path: '/resolution_commitment',
    label: 'resolution_commitment',
    pattern: HMAC_SHA256,
    max: 80
  });
  assertString(detached.delivery_hash, {
    path: '/delivery_hash',
    label: 'delivery_hash',
    pattern: SHA256,
    max: 80
  });
  assertString(detached.status, {
    path: '/status',
    label: 'grounding review status',
    enumValues: NARRATIVE_GROUNDING_REVIEW_STATUSES,
    max: 32
  });
  normalizeReviewFindings(detached.findings, detached.status);
  return detached;
}

export function assertApprovedNarrativeGroundingReview(delivery, receipt) {
  const normalizedDelivery = assertNarrativeDeliveryShape(delivery);
  const normalizedReceipt = assertNarrativeGroundingReviewReceipt(receipt);
  const expectedHash = narrativeDeliveryHash(normalizedDelivery);
  for (const field of ['turn_id', 'audience', 'resolution_commitment']) {
    if (normalizedReceipt[field] !== normalizedDelivery[field]) {
      throw contractError(`/${field}`, 'grounding review receipt is bound to a different NarrativeDelivery', {
        field,
        expected: normalizedDelivery[field],
        actual: normalizedReceipt[field]
      });
    }
  }
  if (normalizedReceipt.delivery_hash !== expectedHash) {
    throw contractError('/delivery_hash', 'grounding review receipt does not commit to this NarrativeDelivery', {
      expected: expectedHash,
      actual: normalizedReceipt.delivery_hash
    });
  }
  if (normalizedReceipt.status !== 'APPROVED') {
    throw contractError('/status', 'NarrativeDelivery has not passed the required grounding review', {
      status: normalizedReceipt.status
    });
  }
  return normalizedReceipt;
}

/** Final gate: hard delivery set checks plus one bound APPROVED receipt each. */
export function assertGroundedNarrativeDeliverySet(deliveries, receipts, context) {
  const normalizedDeliveries = assertNarrativeDeliverySet(deliveries, context);
  assertArray(receipts, {
    path: '/grounding_review_receipts',
    label: 'grounding review receipts',
    min: normalizedDeliveries.length,
    max: normalizedDeliveries.length
  });
  const receiptByAudience = new Map();
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = assertNarrativeGroundingReviewReceipt(receipts[index]);
    if (receiptByAudience.has(receipt.audience)) {
      throw contractError(
        `/grounding_review_receipts/${index}/audience`,
        'only one grounding review receipt is allowed per delivery audience',
        { audience: receipt.audience }
      );
    }
    receiptByAudience.set(receipt.audience, receipt);
  }

  if (normalizedDeliveries.length === 2) {
    const reviewerRunIds = new Set(
      [...receiptByAudience.values()].map(receipt => receipt.reviewer_run_id)
    );
    if (reviewerRunIds.size !== 1) {
      throw contractError(
        '/grounding_review_receipts',
        'dual_pov deliveries must be reviewed together in one grounding reviewer run',
        { reviewer_run_ids: [...reviewerRunIds].sort() }
      );
    }
  }

  const normalizedReceipts = normalizedDeliveries.map(delivery => {
    const receipt = receiptByAudience.get(delivery.audience);
    if (!receipt) {
      throw contractError('/grounding_review_receipts', 'missing grounding review receipt for delivery', {
        audience: delivery.audience
      });
    }
    return assertApprovedNarrativeGroundingReview(delivery, receipt);
  });

  return Object.freeze({
    deliveries: normalizedDeliveries,
    grounding_review_receipts: Object.freeze(normalizedReceipts)
  });
}
