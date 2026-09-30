import {
  assertResolutionCandidate
} from '../contracts/resolution-contracts.js';
import { canonicalStringify, canonicalizeJson } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

export const RESOLUTION_RULE_PRECHECK_SCHEMA =
  'naruto.multiplayer-resolution-rule-precheck/v1';

const REQUIREMENT_KEYS = new Set([
  'requirement_id',
  'event_id',
  'rule_ref',
  'effect_match'
]);
const MATCH_KEYS = new Set(['domain', 'kind', 'operation', 'target', 'payload']);
const RULE_FINDING_KEYS = new Set([
  'code',
  'message',
  'submission_id',
  'event_id',
  'rule_ref',
  'technique_id',
  'actor_id',
  'resource_id',
  'available',
  'required'
]);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fail(code, message, details = {}, status = 422) {
  throw new DomainError(code, message, details, { status });
}

function exactKeys(value, allowed, path) {
  if (!isRecord(value)) fail('RULE_PRECHECK_CONFIGURATION_INVALID', `${path} must be an object`, {}, 500);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('RULE_PRECHECK_CONFIGURATION_INVALID', `${path} contains unknown field ${key}`, {}, 500);
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail('RULE_PRECHECK_CONFIGURATION_INVALID', `${path} is missing ${key}`, {}, 500);
    }
  }
}

function normalizeRequirement(requirement, index) {
  const path = `/requirements/${index}`;
  exactKeys(requirement, REQUIREMENT_KEYS, path);
  exactKeys(requirement.effect_match, MATCH_KEYS, `${path}/effect_match`);
  for (const [value, name, prefix] of [
    [requirement.requirement_id, 'requirement_id', 'requirement_'],
    [requirement.event_id, 'event_id', 'event_']
  ]) {
    if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > 160) {
      fail('RULE_PRECHECK_CONFIGURATION_INVALID', `${name} is invalid`, { path: `${path}/${name}` }, 500);
    }
  }
  if (typeof requirement.rule_ref !== 'string' || !requirement.rule_ref
    || requirement.rule_ref.length > 160) {
    fail('RULE_PRECHECK_CONFIGURATION_INVALID', 'rule_ref is invalid', {
      path: `${path}/rule_ref`
    }, 500);
  }
  for (const field of ['domain', 'kind', 'operation']) {
    if (typeof requirement.effect_match[field] !== 'string'
      || !requirement.effect_match[field]
      || requirement.effect_match[field].length > 128) {
      fail('RULE_PRECHECK_CONFIGURATION_INVALID', `effect_match.${field} is invalid`, {
        path: `${path}/effect_match/${field}`
      }, 500);
    }
  }
  if (!isRecord(requirement.effect_match.target)
    || !isRecord(requirement.effect_match.payload)) {
    fail('RULE_PRECHECK_CONFIGURATION_INVALID', 'effect target and payload must be objects', {
      path: `${path}/effect_match`
    }, 500);
  }
  return canonicalizeJson(requirement);
}

function normalizeRuleFinding(finding, index) {
  const path = `/mechanical_rule_findings/${index}`;
  if (!isRecord(finding)) {
    fail('RULE_PRECHECK_CONFIGURATION_INVALID', `${path} must be an object`, {}, 500);
  }
  for (const key of Object.keys(finding)) {
    if (!RULE_FINDING_KEYS.has(key)) {
      fail(
        'RULE_PRECHECK_CONFIGURATION_INVALID',
        `${path} contains unknown field ${key}`,
        {},
        500
      );
    }
  }
  for (const field of ['code', 'message']) {
    if (typeof finding[field] !== 'string' || !finding[field]
      || finding[field].length > (field === 'message' ? 2_000 : 160)) {
      fail(
        'RULE_PRECHECK_CONFIGURATION_INVALID',
        `${path}/${field} is invalid`,
        {},
        500
      );
    }
  }
  for (const field of [
    'submission_id',
    'event_id',
    'rule_ref',
    'technique_id',
    'actor_id',
    'resource_id'
  ]) {
    if (Object.prototype.hasOwnProperty.call(finding, field)
      && (typeof finding[field] !== 'string' || !finding[field] || finding[field].length > 256)) {
      fail(
        'RULE_PRECHECK_CONFIGURATION_INVALID',
        `${path}/${field} is invalid`,
        {},
        500
      );
    }
  }
  for (const field of ['available', 'required']) {
    if (Object.prototype.hasOwnProperty.call(finding, field)
      && (!Number.isSafeInteger(finding[field]) || finding[field] < 0)) {
      fail(
        'RULE_PRECHECK_CONFIGURATION_INVALID',
        `${path}/${field} is invalid`,
        {},
        500
      );
    }
  }
  return canonicalizeJson(finding);
}

function effectMatches(effect, requirement) {
  if (effect.event_id !== requirement.event_id) return false;
  const expected = requirement.effect_match;
  return effect.domain === expected.domain
    && effect.kind === expected.kind
    && effect.operation === expected.operation
    && canonicalStringify(effect.target) === canonicalStringify(expected.target)
    && canonicalStringify(effect.payload) === canonicalStringify(expected.payload);
}

/**
 * Deterministic rules-engine reconciliation. Requirements are generated from
 * authoritative technique/task/calendar rules, never inferred from prose.
 */
export function precheckResolutionCompleteness({
  resolution_candidate,
  mechanical_effect_requirements = [],
  mechanical_rule_findings = []
}) {
  const candidate = assertResolutionCandidate(resolution_candidate);
  if (!Array.isArray(mechanical_effect_requirements)
    || mechanical_effect_requirements.length > 256) {
    fail('RULE_PRECHECK_CONFIGURATION_INVALID', 'mechanical effect requirements are invalid', {}, 500);
  }
  if (!Array.isArray(mechanical_rule_findings) || mechanical_rule_findings.length > 256) {
    fail('RULE_PRECHECK_CONFIGURATION_INVALID', 'mechanical rule findings are invalid', {}, 500);
  }
  const requirements = mechanical_effect_requirements.map(normalizeRequirement);
  const seen = new Set();
  for (const requirement of requirements) {
    if (seen.has(requirement.requirement_id)) {
      fail('RULE_PRECHECK_CONFIGURATION_INVALID', 'mechanical requirement ID is duplicated', {
        requirement_id: requirement.requirement_id
      }, 500);
    }
    seen.add(requirement.requirement_id);
  }
  const findings = mechanical_rule_findings.map(normalizeRuleFinding);
  for (const requirement of requirements) {
    if (!candidate.events.some(event => event.event_id === requirement.event_id)) {
      findings.push({
        code: 'RULE_EVENT_MISSING',
        requirement_id: requirement.requirement_id,
        event_id: requirement.event_id,
        rule_ref: requirement.rule_ref,
        message: '权威规则要求引用的事件不存在。'
      });
      continue;
    }
    if (!candidate.effects.some(effect => effectMatches(effect, requirement))) {
      findings.push({
        code: 'REQUIRED_MECHANICAL_EFFECT_MISSING_OR_MISMATCHED',
        requirement_id: requirement.requirement_id,
        event_id: requirement.event_id,
        rule_ref: requirement.rule_ref,
        message: '权威规则产生的必需原子 effect 缺失或数值/目标不符。',
        expected_effect: requirement.effect_match
      });
    }
  }
  return Object.freeze(canonicalizeJson({
    schema: RESOLUTION_RULE_PRECHECK_SCHEMA,
    status: findings.length ? 'REJECTED' : 'APPROVED',
    checked_requirement_ids: requirements.map(item => item.requirement_id),
    findings,
    retry_route: findings.length ? 'referee' : null,
    writer_allowed: findings.length === 0
  }));
}

export function routeResolutionCompletenessReview(review) {
  if (!review || !['APPROVED', 'REJECTED'].includes(review.status)
    || !Array.isArray(review.findings)) {
    fail('RESOLUTION_COMPLETENESS_REVIEW_INVALID', 'semantic completeness review is invalid');
  }
  return Object.freeze({
    status: review.status,
    retry_route: review.status === 'REJECTED' ? 'referee' : null,
    writer_allowed: review.status === 'APPROVED',
    findings: review.findings
  });
}

export const ResolutionCompleteness = Object.freeze({
  precheck: precheckResolutionCompleteness,
  routeReviewerResult: routeResolutionCompletenessReview
});
