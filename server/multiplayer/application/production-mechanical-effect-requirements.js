import { CANON_DATABASE } from '../../../js/data/canon-database.js';
import { assertResolutionCandidate } from '../contracts/resolution-contracts.js';
import { canonicalStringify, canonicalizeJson, sha256Hex } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { assertReducerDomainState } from '../domain/reducers/index.js';

export const PRODUCTION_MECHANICAL_REQUIREMENTS_SCHEMA =
  'naruto.multiplayer-production-mechanical-requirements/v1';

const ADOPTED_OUTCOMES = new Set(['success', 'partial_success']);
const RESOURCE_IDS = Object.freeze({
  chakra: 'chakra',
  spirit: 'mental',
  stamina: 'stamina'
});

function fail(code, message, details = {}, status = 500) {
  throw new DomainError(code, message, details, { status });
}

function immutable(value) {
  const normalized = canonicalizeJson(value, { maxDepth: 96, maxNodes: 500_000 });
  const freeze = current => {
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(normalized);
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function termIndex(text, values) {
  let best = -1;
  for (const value of values) {
    const term = normalizedText(value).trim();
    if (term.length < 2) continue;
    const index = text.indexOf(term);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function containsReference(value, references, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 2_048) return false;
  if (typeof value === 'string') return references.has(normalizedText(value));
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some(item => containsReference(item, references, budget));
  }
  return Object.values(value).some(item => containsReference(item, references, budget));
}

function authoritativeTechnique(canonDatabase, canonicalRef) {
  const technique = canonDatabase.getRecord('techniques', canonicalRef, {
    includeDisabled: false
  });
  if (!technique) {
    fail(
      'CANONICAL_TECHNIQUE_RULE_NOT_FOUND',
      'a frozen actor skill references no active canonical technique rule',
      { canonical_ref: canonicalRef }
    );
  }
  const resourceId = RESOURCE_IDS[technique.resource];
  if (!resourceId) {
    fail(
      'CANONICAL_TECHNIQUE_RESOURCE_UNSUPPORTED',
      'canonical technique uses an unsupported multiplayer resource',
      { canonical_ref: canonicalRef, canonical_resource: technique.resource }
    );
  }
  const cost = Number(technique.cost);
  if (!Number.isSafeInteger(cost) || cost < 0) {
    fail(
      'CANONICAL_TECHNIQUE_COST_INVALID',
      'canonical technique cost must be a non-negative safe integer',
      { canonical_ref: canonicalRef }
    );
  }
  return { technique, resource_id: resourceId, cost };
}

function techniqueTerms(canonDatabase, skill, technique) {
  const stateSkill = canonDatabase.toStateSkill(technique);
  return [...new Set([
    skill.canonical_ref,
    skill.display_name,
    skill.skill_id,
    technique.id,
    technique.name,
    technique.display_name,
    stateSkill?.name,
    ...(Array.isArray(technique.aliases) ? technique.aliases : [])
  ].filter(value => typeof value === 'string' && value.trim()))];
}

function referencedEvent(candidate, outcome, usage) {
  const eventById = new Map(candidate.events.map(event => [event.event_id, event]));
  const effectsByEvent = new Map();
  for (const effect of candidate.effects) {
    const list = effectsByEvent.get(effect.event_id) ?? [];
    list.push(effect);
    effectsByEvent.set(effect.event_id, list);
  }
  const exactReferences = new Set([
    normalizedText(usage.skill.skill_id),
    normalizedText(usage.technique.id),
    normalizedText(usage.skill.canonical_ref)
  ]);
  const scored = outcome.event_ids.map((eventId, index) => {
    const event = eventById.get(eventId);
    const effects = effectsByEvent.get(eventId) ?? [];
    let score = 0;
    if (effects.some(effect => containsReference(effect, exactReferences))) score = 4;
    if (effects.some(effect => (
      effect.domain === 'actor_resource'
      && effect.kind === 'resource'
      && effect.operation === 'consume'
      && effect.target?.actor_id === usage.actor_id
      && effect.target?.resource_id === usage.resource_id
      && effect.payload?.amount === usage.cost
    ))) score = Math.max(score, 3);
    if (event && termIndex(normalizedText(event.summary), usage.terms) >= 0) {
      score = Math.max(score, 2);
    }
    return { event_id: eventId, index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = scored[0] ?? null;
  // A transformed action may explicitly replace the submitted technique with
  // another consequence. Charge it only when the resulting event/effect still
  // proves that the canonical technique was actually used.
  if (outcome.status === 'transformed' && (!selected || selected.score < 2)) return null;
  return selected?.event_id ?? null;
}

function actionTechniqueUsages({ canonDatabase, state, action, candidate }) {
  const actor = state.actors[action.seat];
  if (!actor) {
    fail('REFEREE_INPUT_INVALID', 'locked action seat has no frozen actor state', {
      seat: action.seat
    });
  }
  const outcome = candidate.outcomes.find(item => item.submission_id === action.submission_id);
  if (!outcome || (!ADOPTED_OUTCOMES.has(outcome.status) && outcome.status !== 'transformed')) {
    return [];
  }
  const actionText = normalizedText(action.text);
  const byCanonicalRef = new Map();
  for (const skill of actor.skills.entries) {
    if (!skill.canonical_ref || byCanonicalRef.has(skill.canonical_ref)) continue;
    const rule = authoritativeTechnique(canonDatabase, skill.canonical_ref);
    const terms = techniqueTerms(canonDatabase, skill, rule.technique);
    const mentionIndex = termIndex(actionText, terms);
    if (mentionIndex < 0) continue;
    byCanonicalRef.set(skill.canonical_ref, {
      seat: action.seat,
      submission_id: action.submission_id,
      actor_id: actor.room_actor_id,
      skill,
      technique: rule.technique,
      resource_id: rule.resource_id,
      cost: rule.cost,
      terms,
      mention_index: mentionIndex,
      outcome
    });
  }
  return [...byCanonicalRef.values()]
    .sort((left, right) => (
      left.mention_index - right.mention_index
      || left.technique.id.localeCompare(right.technique.id)
    ))
    .map(usage => ({
      ...usage,
      event_id: referencedEvent(candidate, outcome, usage)
    }))
    .filter(usage => usage.event_id !== null && usage.cost > 0);
}

function requirementId(usage, ordinal) {
  const digest = sha256Hex(canonicalStringify({
    submission_id: usage.submission_id,
    technique_id: usage.technique.id,
    event_id: usage.event_id,
    ordinal
  })).slice(0, 32);
  return `requirement_technique_cost_${usage.seat}_${digest}`;
}

/**
 * Derives deterministic canonical-technique resource obligations after each
 * Referee candidate. Nothing is inferred from literary prose: the technique
 * must be a frozen actor skill, named by that seat's locked action, and adopted
 * by the candidate outcome/event.
 */
export function deriveProductionMechanicalEffectRequirements({
  referee_input,
  resolution_candidate,
  canon_database = CANON_DATABASE
}) {
  if (!referee_input || typeof referee_input !== 'object'
    || !Array.isArray(referee_input.actions)) {
    fail('REFEREE_INPUT_INVALID', 'mechanical requirement derivation needs frozen actions');
  }
  if (!canon_database || typeof canon_database.getRecord !== 'function'
    || typeof canon_database.toStateSkill !== 'function') {
    fail('MECHANICAL_RULE_CONFIGURATION_INVALID', 'canonical database port is incomplete');
  }
  const state = assertReducerDomainState(referee_input.base_state);
  const candidate = assertResolutionCandidate(resolution_candidate);
  const usages = referee_input.actions
    .flatMap(action => actionTechniqueUsages({ canonDatabase: canon_database, state, action, candidate }));
  const balances = new Map();
  const requirements = [];
  const findings = [];

  for (const [ordinal, usage] of usages.entries()) {
    const actor = state.actors[usage.seat];
    const resource = actor.attributes.resources.find(item => (
      item.resource_id === usage.resource_id
    ));
    if (!resource) {
      fail('AUTHORITATIVE_RESOURCE_NOT_FOUND', 'actor lacks a canonical technique resource', {
        actor_id: usage.actor_id,
        resource_id: usage.resource_id
      });
    }
    const balanceKey = `${usage.actor_id}\u0000${usage.resource_id}`;
    const before = balances.get(balanceKey) ?? {
      version: resource.version,
      current: resource.current,
      maximum: resource.maximum
    };
    const ruleRef = `canon-technique:${usage.technique.id}/resource-cost@${canon_database.revision}`;
    if (before.current < usage.cost) {
      findings.push({
        code: 'KNOWN_TECHNIQUE_RESOURCE_INSUFFICIENT',
        message: '裁决采用了规范忍术，但冻结角色资源不足以支付其权威费用。',
        submission_id: usage.submission_id,
        event_id: usage.event_id,
        rule_ref: ruleRef,
        technique_id: usage.technique.id,
        actor_id: usage.actor_id,
        resource_id: usage.resource_id,
        available: before.current,
        required: usage.cost
      });
      continue;
    }
    const after = {
      version: before.version + 1,
      current: before.current - usage.cost,
      maximum: before.maximum
    };
    balances.set(balanceKey, after);
    requirements.push({
      requirement_id: requirementId(usage, ordinal),
      event_id: usage.event_id,
      rule_ref: ruleRef,
      effect_match: {
        domain: 'actor_resource',
        kind: 'resource',
        operation: 'consume',
        target: {
          scope: 'actor_resource',
          actor_id: usage.actor_id,
          resource_id: usage.resource_id
        },
        payload: {
          expected_version: before.version,
          next_version: after.version,
          from: before.current,
          to: after.current,
          amount: usage.cost,
          maximum: before.maximum
        }
      }
    });
  }

  return immutable({
    schema: PRODUCTION_MECHANICAL_REQUIREMENTS_SCHEMA,
    requirements,
    findings
  });
}

export function createProductionMechanicalEffectRequirementDeriver(options = {}) {
  const canonDatabase = options.canonDatabase ?? CANON_DATABASE;
  return input => deriveProductionMechanicalEffectRequirements({
    ...input,
    canon_database: canonDatabase
  });
}

export const ProductionMechanicalEffectRequirements = Object.freeze({
  derive: deriveProductionMechanicalEffectRequirements,
  createDeriver: createProductionMechanicalEffectRequirementDeriver
});
