import {
  assertResolutionCheckRequest
} from '../contracts/resolution-check-contracts.js';
import { canonicalizeJson, sha256Hex } from './canonical-json.js';
import { DomainError } from './errors.js';
import { assertReducerDomainState } from './reducers/index.js';

export const AUTHORITATIVE_RESOLUTION_CHECK_RULES_SCHEMA =
  'naruto.multiplayer-authoritative-resolution-check-rules/v1';

const OPPOSED_RULE = 'rule:opposed-check/v1';
const SINGLE_RULE = 'rule:single-check/v1';
const SUPPORTED_ATTRIBUTES = Object.freeze([
  'attack',
  'chakra_control',
  'deception',
  'defense',
  'escape',
  'level',
  'mental',
  'perception',
  'pursuit',
  'sealing',
  'stamina',
  'stealth',
  'vitality'
]);

const CONFLICT_RULES = Object.freeze({
  opposed_attack_defense: Object.freeze({
    rule_ref: OPPOSED_RULE,
    attributes: Object.freeze([['attack'], ['defense']])
  }),
  opposed_deception_insight: Object.freeze({
    rule_ref: OPPOSED_RULE,
    attributes: Object.freeze([['deception'], ['perception']])
  }),
  opposed_pursuit_escape: Object.freeze({
    rule_ref: OPPOSED_RULE,
    attributes: Object.freeze([['pursuit'], ['escape']])
  }),
  opposed_sealing_detection: Object.freeze({
    rule_ref: OPPOSED_RULE,
    attributes: Object.freeze([['sealing'], ['perception']])
  }),
  opposed_stealth_detection: Object.freeze({
    rule_ref: OPPOSED_RULE,
    attributes: Object.freeze([['stealth'], ['perception']])
  }),
  chakra_control: Object.freeze({
    rule_ref: SINGLE_RULE,
    attributes: Object.freeze([['chakra_control']]),
    difficulty: 10
  }),
  endurance_check: Object.freeze({
    rule_ref: SINGLE_RULE,
    attributes: Object.freeze([['stamina'], ['vitality']]),
    difficulty: 10
  }),
  perception_check: Object.freeze({
    rule_ref: SINGLE_RULE,
    attributes: Object.freeze([['perception']]),
    difficulty: 10
  }),
  sealing_control: Object.freeze({
    rule_ref: SINGLE_RULE,
    attributes: Object.freeze([['sealing'], ['chakra_control']]),
    difficulty: 12
  }),
  skill_execution: Object.freeze({
    rule_ref: SINGLE_RULE,
    attributes: Object.freeze([['skill:*']]),
    difficulty: 10
  })
});

export const AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT = Object.freeze({
  schema: AUTHORITATIVE_RESOLUTION_CHECK_RULES_SCHEMA,
  revision: 1,
  die: Object.freeze({ minimum: 1, maximum: 20 }),
  supported_rule_refs: Object.freeze([OPPOSED_RULE, SINGLE_RULE]),
  supported_attributes: SUPPORTED_ATTRIBUTES,
  conflicts: Object.freeze(Object.fromEntries(
    Object.entries(CONFLICT_RULES).map(([conflictType, rule]) => [
      conflictType,
      Object.freeze({
        rule_ref: rule.rule_ref,
        participant_attribute_choices: rule.attributes,
        ...(rule.difficulty === undefined ? {} : { difficulty: rule.difficulty })
      })
    ])
  ))
});

export const AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH =
  `sha256:${sha256Hex(AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT)}`;

function immutable(value) {
  const normalized = canonicalizeJson(value);
  const freeze = current => {
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(normalized);
}

function reject(errorCode, allowedCorrectionFields) {
  return immutable({
    status: 'REJECTED',
    error_code: errorCode,
    allowed_correction_fields: allowedCorrectionFields
  });
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function resource(actor, resourceId) {
  return actor.attributes.resources.find(item => item.resource_id === resourceId) ?? null;
}

function resourceModifier(actor, resourceId) {
  const value = resource(actor, resourceId);
  if (!value || value.maximum < 1) return -2;
  return clamp(Math.floor((value.current * 5) / value.maximum) - 1, -1, 4);
}

function injuryPenalty(actor) {
  return clamp(actor.attributes.injuries
    .filter(injury => injury.active)
    .reduce((sum, injury) => sum + injury.severity, 0), 0, 8);
}

function rankModifier(rankValue) {
  const rank = String(rankValue || '').normalize('NFKC').toLowerCase();
  const named = [
    ['影', 5],
    ['s', 5],
    ['上忍', 4],
    ['a', 4],
    ['特别上忍', 3],
    ['特別上忍', 3],
    ['中忍', 2],
    ['b', 3],
    ['c', 2],
    ['下忍', 1],
    ['d', 1],
    ['e', 0]
  ];
  return named.find(([needle]) => rank.includes(needle))?.[1] ?? 0;
}

function skillRankModifier(rankValue) {
  const rank = String(rankValue || '').normalize('NFKC').toUpperCase();
  if (rank.includes('S') || rank.includes('影')) return 5;
  if (rank.includes('A')) return 4;
  if (rank.includes('B')) return 3;
  if (rank.includes('C')) return 2;
  if (rank.includes('D')) return 1;
  return 0;
}

function skillModifier(skill) {
  return clamp(Math.floor(skill.mastery / 20) + skillRankModifier(skill.rank), 0, 10);
}

const SKILL_KEYWORDS = Object.freeze({
  attack: Object.freeze(['攻击', '突击', '格斗', '斩', '拳', '火遁', '雷遁', '风遁', '水遁', '土遁']),
  chakra_control: Object.freeze(['控制', '医疗', '爬树', '水面', '查克拉']),
  deception: Object.freeze(['幻术', '变身', '伪装', '欺骗']),
  defense: Object.freeze(['防御', '护', '盾', '壁', '铠']),
  escape: Object.freeze(['瞬身', '逃', '替身', '高速', '移动']),
  perception: Object.freeze(['感知', '侦查', '洞察', '白眼', '写轮眼', '听觉', '嗅觉']),
  pursuit: Object.freeze(['追踪', '感知', '瞬身', '高速', '移动']),
  sealing: Object.freeze(['封印', '结界', '封缚', '咒印']),
  stealth: Object.freeze(['潜行', '隐身', '隐匿', '无声', '伪装', '雾隐'])
});

function bestMatchingSkill(actor, attribute) {
  const keywords = SKILL_KEYWORDS[attribute] ?? [];
  const matches = actor.skills.entries.filter(skill => {
    const text = `${skill.display_name}\n${skill.canonical_ref ?? ''}`.toLowerCase();
    return keywords.some(keyword => text.includes(keyword.toLowerCase()));
  });
  matches.sort((left, right) => skillModifier(right) - skillModifier(left)
    || left.skill_id.localeCompare(right.skill_id));
  return matches[0] ?? null;
}

function actorForParticipant(state, participantRef) {
  for (const seat of ['A', 'B']) {
    const actor = state.actors[seat];
    if (participantRef === `actor:${seat}` || participantRef === actor.room_actor_id) {
      return { seat, actor };
    }
  }
  return null;
}

function directSkill(actor, attribute) {
  if (!attribute.startsWith('skill:')) return null;
  const requested = attribute.slice('skill:'.length);
  return actor.skills.entries.find(skill => (
    skill.skill_id === requested
      || skill.skill_id === attribute
      || skill.canonical_ref === requested
      || skill.canonical_ref === attribute
  )) ?? null;
}

function attributeModifier(actor, attribute) {
  const base = clamp(
    rankModifier(actor.player.rank) + Math.floor((actor.progression.level - 1) / 3),
    0,
    8
  );
  const penalty = injuryPenalty(actor);
  const direct = directSkill(actor, attribute);
  if (attribute.startsWith('skill:')) {
    return direct
      ? { modifier: clamp(base + skillModifier(direct) - penalty, -10, 20), skill: direct }
      : null;
  }
  if (!SUPPORTED_ATTRIBUTES.includes(attribute)) return null;
  const matchingSkill = bestMatchingSkill(actor, attribute);
  const skill = matchingSkill ? skillModifier(matchingSkill) : 0;
  const resourceId = ({
    attack: 'stamina',
    chakra_control: 'chakra',
    deception: 'mental',
    defense: 'vitality',
    escape: 'stamina',
    mental: 'mental',
    perception: 'mental',
    pursuit: 'stamina',
    sealing: 'chakra',
    stamina: 'stamina',
    stealth: 'stamina',
    vitality: 'vitality'
  })[attribute] ?? null;
  const condition = resourceId === null ? 0 : resourceModifier(actor, resourceId);
  return {
    modifier: clamp(base + skill + condition - penalty, -10, 20),
    skill: matchingSkill,
    resource_id: resourceId
  };
}

function parseAttributeRef(participantRef, attributeRef) {
  const prefix = `${participantRef}/`;
  return attributeRef.startsWith(prefix) ? attributeRef.slice(prefix.length) : null;
}

function matchesChoice(attribute, choices) {
  return choices.some(choice => (
    choice === attribute || (choice === 'skill:*' && attribute.startsWith('skill:'))
  ));
}

/**
 * Converts a model request into a fully server-derived d20 plan. No number in
 * the returned roll specs comes from the model request.
 */
export function planAuthoritativeResolutionCheck({ request: requestValue, state: stateValue }) {
  const request = assertResolutionCheckRequest(requestValue);
  const state = assertReducerDomainState(stateValue);
  const conflict = CONFLICT_RULES[request.conflict_type];
  if (!conflict) {
    return immutable({
      decision: reject('UNSUPPORTED_CONFLICT_TYPE', ['conflict_type', 'attribute_rule_refs', 'reason']),
      audit: { rule_snapshot_hash: AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH }
    });
  }
  if (request.rule_ref !== conflict.rule_ref) {
    return immutable({
      decision: reject('RULE_NOT_APPLICABLE', ['rule_ref', 'attribute_rule_refs', 'reason']),
      audit: { rule_snapshot_hash: AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH }
    });
  }
  const expectedParticipants = conflict.rule_ref === SINGLE_RULE ? 1 : 2;
  if (request.participant_refs.length !== expectedParticipants
    || request.attribute_rule_refs.length !== expectedParticipants) {
    return immutable({
      decision: reject('PARTICIPANT_SET_INVALID', ['participant_refs', 'attribute_rule_refs', 'reason']),
      audit: { rule_snapshot_hash: AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH }
    });
  }

  const rollSpecs = [];
  const auditParticipants = [];
  for (let index = 0; index < request.participant_refs.length; index += 1) {
    const participantRef = request.participant_refs[index];
    const binding = actorForParticipant(state, participantRef);
    if (!binding) {
      return immutable({
        decision: reject('PARTICIPANT_NOT_FOUND', ['participant_refs', 'attribute_rule_refs', 'reason']),
        audit: { rule_snapshot_hash: AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH }
      });
    }
    const attribute = parseAttributeRef(participantRef, request.attribute_rule_refs[index]);
    if (!attribute || !matchesChoice(attribute, conflict.attributes[index])) {
      return immutable({
        decision: reject('ATTRIBUTE_NOT_APPLICABLE', ['attribute_rule_refs', 'reason']),
        audit: { rule_snapshot_hash: AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH }
      });
    }
    const derived = attributeModifier(binding.actor, attribute);
    if (!derived) {
      return immutable({
        decision: reject('ATTRIBUTE_NOT_FOUND', ['attribute_rule_refs', 'reason']),
        audit: { rule_snapshot_hash: AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH }
      });
    }
    rollSpecs.push({
      participant_ref: participantRef,
      minimum: 1,
      maximum: 20,
      modifier: derived.modifier,
      difficulty: conflict.difficulty ?? null
    });
    auditParticipants.push({
      participant_ref: participantRef,
      bound_seat: binding.seat,
      room_actor_id: binding.actor.room_actor_id,
      attribute_ref: request.attribute_rule_refs[index],
      derived_modifier: derived.modifier,
      source_skill_id: derived.skill?.skill_id ?? null,
      source_resource_id: derived.resource_id ?? null,
      actor_profile_version: binding.actor.player.version,
      actor_progression_version: binding.actor.progression.version
    });
  }
  return immutable({
    decision: { status: 'ACCEPTED', roll_specs: rollSpecs },
    audit: {
      schema: 'naruto.multiplayer-resolution-check-rule-audit/v1',
      rule_snapshot_hash: AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH,
      conflict_type: request.conflict_type,
      participants: auditParticipants
    }
  });
}

function participantOutcome(participantRef, index) {
  if (participantRef === 'actor:A') return 'ACTOR_A_SUCCESS';
  if (participantRef === 'actor:B') return 'ACTOR_B_SUCCESS';
  return `PARTICIPANT_${index + 1}_SUCCESS`;
}

export function resolveAuthoritativeResolutionCheckOutcome({ request, roll_specs, rolls }) {
  if (request.rule_ref === SINGLE_RULE) {
    return rolls[0].total >= roll_specs[0].difficulty ? 'SUCCESS' : 'FAILURE';
  }
  if (request.rule_ref !== OPPOSED_RULE || rolls.length !== 2) {
    throw new DomainError(
      'INVALID_RESOLUTION_CHECK_PLAN',
      'authoritative outcome received an unsupported rule plan'
    );
  }
  if (rolls[0].total === rolls[1].total) return 'TIE';
  const winner = rolls[0].total > rolls[1].total ? 0 : 1;
  return participantOutcome(rolls[winner].participant_ref, winner);
}

export function authoritativeResolutionCheckRuleEvidence() {
  return AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT;
}
