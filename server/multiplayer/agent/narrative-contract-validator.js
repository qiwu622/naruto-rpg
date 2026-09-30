import {
  assertNarrativeDeliverySet,
  createNarrativeGroundingReviewReceipt,
  freezeNarrativeDelivery
} from '../contracts/narrative-contracts.js';
import { canonicalizeJson } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

export const NARRATIVE_CONTRACT_VALIDATION_SCHEMA =
  'naruto.multiplayer-narrative-contract-validation/v1';

export function narrativeAudiencesForMode(mode) {
  if (mode === 'shared') return Object.freeze(['shared']);
  if (mode === 'dual_pov') return Object.freeze(['seat:A', 'seat:B']);
  throw new DomainError('INVALID_NARRATIVE_MODE', 'narrative mode must be shared or dual_pov');
}

function errorItem(error, audience) {
  return {
    audience,
    code: error instanceof DomainError ? error.code : 'NARRATIVE_CONTRACT_INVALID',
    path: error instanceof DomainError ? error.details?.path ?? '/' : '/',
    message: error instanceof Error ? error.message : String(error)
  };
}

/** Deterministic event/claim/audience/coverage/count/commitment validator. */
export function validateNarrativeContracts({
  narrative_mode,
  candidates_by_audience,
  canonical_resolution,
  resolution_commitment
}) {
  const expectedAudiences = narrativeAudiencesForMode(narrative_mode);
  const deliveries = [];
  const errors = [];
  for (const audience of expectedAudiences) {
    const candidate = candidates_by_audience?.[audience];
    if (!candidate) {
      errors.push({
        audience,
        code: 'NARRATIVE_MISSING',
        path: '/',
        message: `Narrative candidate for ${audience} is missing`
      });
      continue;
    }
    try {
      deliveries.push(freezeNarrativeDelivery(candidate, {
        turn_id: canonical_resolution.turn_id,
        audience,
        resolution_commitment,
        canonical_resolution
      }));
    } catch (error) {
      errors.push(errorItem(error, audience));
    }
  }
  if (errors.length === 0) {
    try {
      assertNarrativeDeliverySet(deliveries, {
        narrative_mode,
        canonical_resolution,
        resolution_commitment
      });
    } catch (error) {
      errors.push(errorItem(error, null));
    }
  }
  const affected = [...new Set(errors.flatMap(error => (
    error.audience ? [error.audience] : expectedAudiences
  )))];
  return Object.freeze(canonicalizeJson({
    schema: NARRATIVE_CONTRACT_VALIDATION_SCHEMA,
    status: errors.length ? 'REJECTED' : 'APPROVED',
    deliveries,
    errors,
    retry_route: errors.length
      ? { stage: 'writer', audiences: affected }
      : null
  }));
}

/**
 * Converts a semantic grounding verdict into bound receipts or an exact
 * Writer-only retry route. A rejected narrative can never modify resolution.
 */
export function routeNarrativeGroundingReview({
  deliveries,
  grounding_candidate,
  reviewer_run_id,
  review_id_factory = audience => `review_${audience.replace(':', '_')}`
}) {
  const byAudience = new Map(
    grounding_candidate.reviews.map(review => [review.audience, review])
  );
  const affected = grounding_candidate.reviews
    .filter(review => review.status === 'REJECTED')
    .map(review => review.audience);
  if (affected.length) {
    return Object.freeze(canonicalizeJson({
      status: 'REJECTED',
      receipts: [],
      findings_by_audience: Object.fromEntries(
        grounding_candidate.reviews.map(review => [review.audience, review.findings])
      ),
      retry_route: { stage: 'writer', audiences: affected },
      resolution_retry_allowed: false
    }));
  }
  const receipts = deliveries.map(delivery => {
    const review = byAudience.get(delivery.audience);
    if (!review) {
      throw new DomainError(
        'GROUNDING_REVIEW_AUDIENCE_MISSING',
        'grounding review omitted a NarrativeDelivery audience',
        { audience: delivery.audience }
      );
    }
    return createNarrativeGroundingReviewReceipt(delivery, {
      review_id: review_id_factory(delivery.audience),
      reviewer_run_id,
      status: review.status,
      findings: review.findings
    });
  });
  return Object.freeze(canonicalizeJson({
    status: 'APPROVED',
    receipts,
    findings_by_audience: Object.fromEntries(
      grounding_candidate.reviews.map(review => [review.audience, review.findings])
    ),
    retry_route: null,
    resolution_retry_allowed: false
  }));
}

export const NarrativeContractValidator = Object.freeze({
  validate: validateNarrativeContracts,
  routeGroundingReview: routeNarrativeGroundingReview,
  audiencesForMode: narrativeAudiencesForMode
});
