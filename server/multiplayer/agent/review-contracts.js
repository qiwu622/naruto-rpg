import {
  assertArray,
  assertExactKeys,
  assertIdentifier,
  assertString,
  immutableContractValue
} from '../contracts/common.js';
import { NARRATIVE_AUDIENCES } from '../contracts/narrative-contracts.js';

export const RESOLUTION_COMPLETENESS_REVIEW_SCHEMA =
  'naruto.multiplayer-resolution-completeness-review/v1';
export const NARRATIVE_GROUNDING_CANDIDATE_SCHEMA =
  'naruto.multiplayer-narrative-grounding-candidate/v1';

const REVIEW_STATUSES = Object.freeze(['APPROVED', 'REJECTED']);
const FINDING_CODES = Object.freeze([
  'MISSING_RESOURCE_EFFECT',
  'MISSING_DAMAGE_EFFECT',
  'MISSING_ITEM_EFFECT',
  'MISSING_MISSION_EFFECT',
  'MISSING_RELATIONSHIP_EFFECT',
  'MISSING_COMBAT_EFFECT',
  'MISSING_WORLD_EFFECT',
  'MISSING_CALENDAR_EFFECT',
  'MISSING_EVENT_EFFECT',
  'OTHER_MISSING_TYPED_EFFECT'
]);

const RESOLUTION_KEYS = Object.freeze(['schema', 'status', 'findings']);
const RESOLUTION_FINDING_KEYS = Object.freeze(['event_id', 'code', 'reason']);
const GROUNDING_KEYS = Object.freeze(['schema', 'reviews']);
const AUDIENCE_REVIEW_KEYS = Object.freeze(['audience', 'status', 'findings']);

function assertStatus(value, path) {
  return assertString(value, {
    path,
    label: 'review status',
    min: 8,
    max: 8,
    enumValues: REVIEW_STATUSES
  });
}

function assertFindingsForStatus(findings, status, path, item) {
  const normalized = [];
  assertArray(findings, {
    path,
    label: 'review findings',
    min: status === 'REJECTED' ? 1 : 0,
    max: 128,
    item(value, itemPath) {
      normalized.push(item(value, itemPath));
    }
  });
  if (status === 'APPROVED' && normalized.length !== 0) {
    throw new TypeError(`${path} must be empty for an APPROVED review`);
  }
  return normalized;
}

export function assertResolutionCompletenessReview(value) {
  const detached = immutableContractValue(value);
  assertExactKeys(detached, {
    allowed: RESOLUTION_KEYS,
    required: RESOLUTION_KEYS,
    path: '/',
    label: 'ResolutionCompleteness review'
  });
  if (detached.schema !== RESOLUTION_COMPLETENESS_REVIEW_SCHEMA) {
    throw new TypeError(`schema must be ${RESOLUTION_COMPLETENESS_REVIEW_SCHEMA}`);
  }
  const status = assertStatus(detached.status, '/status');
  const findings = assertFindingsForStatus(
    detached.findings,
    status,
    '/findings',
    (finding, path) => {
      assertExactKeys(finding, {
        allowed: RESOLUTION_FINDING_KEYS,
        required: RESOLUTION_FINDING_KEYS,
        path,
        label: 'resolution completeness finding'
      });
      assertIdentifier(finding.event_id, {
        path: `${path}/event_id`,
        label: 'event_id',
        prefix: 'event_',
        max: 128
      });
      assertString(finding.code, {
        path: `${path}/code`,
        label: 'finding code',
        enumValues: FINDING_CODES,
        max: 64
      });
      assertString(finding.reason, {
        path: `${path}/reason`,
        label: 'finding reason',
        min: 1,
        max: 2_000
      });
      return immutableContractValue(finding);
    }
  );
  return immutableContractValue({
    schema: RESOLUTION_COMPLETENESS_REVIEW_SCHEMA,
    status,
    findings
  });
}

export function assertNarrativeGroundingCandidate(value, expectedAudiences = null) {
  const detached = immutableContractValue(value);
  assertExactKeys(detached, {
    allowed: GROUNDING_KEYS,
    required: GROUNDING_KEYS,
    path: '/',
    label: 'NarrativeGrounding candidate'
  });
  if (detached.schema !== NARRATIVE_GROUNDING_CANDIDATE_SCHEMA) {
    throw new TypeError(`schema must be ${NARRATIVE_GROUNDING_CANDIDATE_SCHEMA}`);
  }
  const byAudience = new Map();
  const reviews = [];
  assertArray(detached.reviews, {
    path: '/reviews',
    label: 'audience reviews',
    min: 1,
    max: 2,
    item(review, path) {
      assertExactKeys(review, {
        allowed: AUDIENCE_REVIEW_KEYS,
        required: AUDIENCE_REVIEW_KEYS,
        path,
        label: 'audience grounding review'
      });
      const audience = assertString(review.audience, {
        path: `${path}/audience`,
        label: 'narrative audience',
        enumValues: NARRATIVE_AUDIENCES,
        max: 32
      });
      if (byAudience.has(audience)) throw new TypeError(`duplicate review for ${audience}`);
      const status = assertStatus(review.status, `${path}/status`);
      const findings = assertFindingsForStatus(
        review.findings,
        status,
        `${path}/findings`,
        (finding, findingPath) => assertString(finding, {
          path: findingPath,
          label: 'grounding finding',
          min: 1,
          max: 2_000
        })
      );
      const normalized = immutableContractValue({ audience, status, findings });
      byAudience.set(audience, normalized);
      reviews.push(normalized);
    }
  });
  if (expectedAudiences) {
    const expected = [...expectedAudiences];
    if (reviews.length !== expected.length
      || expected.some(audience => !byAudience.has(audience))) {
      throw new TypeError('grounding candidate does not cover the exact requested audiences');
    }
    return immutableContractValue({
      schema: NARRATIVE_GROUNDING_CANDIDATE_SCHEMA,
      reviews: expected.map(audience => byAudience.get(audience))
    });
  }
  return immutableContractValue({
    schema: NARRATIVE_GROUNDING_CANDIDATE_SCHEMA,
    reviews
  });
}

export const RESOLUTION_COMPLETENESS_REVIEW_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: RESOLUTION_KEYS,
  properties: {
    schema: { const: RESOLUTION_COMPLETENESS_REVIEW_SCHEMA },
    status: { type: 'string', enum: REVIEW_STATUSES },
    findings: {
      type: 'array',
      maxItems: 128,
      items: {
        type: 'object',
        additionalProperties: false,
        required: RESOLUTION_FINDING_KEYS,
        properties: {
          event_id: { type: 'string', pattern: '^event_[A-Za-z0-9_-]{1,122}$' },
          code: { type: 'string', enum: FINDING_CODES },
          reason: { type: 'string', minLength: 1, maxLength: 2_000 }
        }
      }
    }
  }
});

export const NARRATIVE_GROUNDING_CANDIDATE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: GROUNDING_KEYS,
  properties: {
    schema: { const: NARRATIVE_GROUNDING_CANDIDATE_SCHEMA },
    reviews: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: AUDIENCE_REVIEW_KEYS,
        properties: {
          audience: { type: 'string', enum: NARRATIVE_AUDIENCES },
          status: { type: 'string', enum: REVIEW_STATUSES },
          findings: {
            type: 'array',
            maxItems: 128,
            items: { type: 'string', minLength: 1, maxLength: 2_000 }
          }
        }
      }
    }
  }
});
