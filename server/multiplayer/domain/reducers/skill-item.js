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
  fail,
  findActor,
  insertSorted,
  reducerResult,
  replaceSorted
} from './shared.js';

export const ACTOR_SKILLS_SCHEMA = 'naruto.multiplayer-actor-skills/v1';
export const ACTOR_ITEMS_SCHEMA = 'naruto.multiplayer-actor-items/v1';

export const SKILL_ITEM_REDUCER_VERSIONS = Object.freeze({
  upsert_actor_skill: 'actor-skill-upsert-reducer/v1',
  remove_actor_skill: 'actor-skill-remove-reducer/v1',
  upsert_actor_item: 'actor-item-upsert-reducer/v1',
  remove_actor_item: 'actor-item-remove-reducer/v1'
});

const SKILL_CATEGORIES = Object.freeze(['NINJUTSU', 'TAIJUTSU', 'GENJUTSU', 'BLOODLINE', 'OTHER']);
const ITEM_CATEGORIES = Object.freeze(['CONSUMABLE', 'EQUIPMENT', 'MATERIAL', 'KEY']);
const EQUIPMENT_SLOTS = Object.freeze(['weapon', 'armor', 'accessory', 'tool']);

// Model-facing contract beside the reducer it describes. This is format guidance;
// the existing reducer remains responsible for quantities, versions and authority.
export function itemEffectInputContract(operation) {
  const integer = minimum => ({ type: 'integer', minimum });
  const slot = { enum: [null, ...EQUIPMENT_SLOTS] };
  const version = { expected_version: integer(1), next_version: integer(2) };
  const payloads = {
    upsert: {
      expected_version: { type: ['integer', 'null'], minimum: 1, description: '新物品填 null；已有物品填当前 version。' },
      next_version: { ...integer(1), description: '新物品为 1；已有物品为 expected_version + 1。' },
      display_name: { type: 'string', minLength: 1, maxLength: 160 },
      category: { enum: ITEM_CATEGORIES, description: '文书、凭证、信件等关键物品使用 KEY。' },
      quantity: { type: 'integer', minimum: 1, maximum: 1_000_000 },
      canonical_ref: { type: ['string', 'null'], maxLength: 160 },
      equipped_slot: { ...slot, description: '只有 EQUIPMENT 可使用非 null 槽位。' }
    },
    consume: { ...version, from_quantity: integer(1), amount: integer(1), to_quantity: integer(0) },
    equip: { ...version, expected_slot: slot, next_slot: { enum: EQUIPMENT_SLOTS } },
    unequip: { ...version, expected_slot: slot, next_slot: { const: null } },
    remove: { expected_version: integer(1), expected_quantity: integer(1) }
  };
  const properties = payloads[operation];
  if (!properties) return null;
  const exact = fields => ({ type: 'object', additionalProperties: false, required: Object.keys(fields), properties: fields });
  return {
    ...exact({
      target: exact({
        scope: { const: 'actor_item' },
        actor_id: { type: 'string', pattern: '^actor:', description: '使用 base_state 中的 room_actor_id。' },
        item_id: { type: 'string', pattern: '^item:', description: '已有物品复用 item_id；新物品创建稳定 ID。ID 只放在 target。' }
      }),
      payload: exact(properties)
    }),
    description: '版本和数量来自当前状态；consume 的 to_quantity = from_quantity - amount。这些字段说明不代表发生了物品变化。'
  };
}

function assertStableEntityTarget(target, scope, idField, prefix) {
  assertExactObject(target, {
    label: 'effect target',
    allowed: ['scope', 'actor_id', idField],
    code: 'INVALID_EFFECT_TARGET'
  });
  if (target.scope !== scope) fail('INVALID_EFFECT_TARGET', `target.scope must be ${scope}`);
  assertIdentifier(target.actor_id, 'target.actor_id', {
    prefixes: ['actor:'],
    code: 'INVALID_EFFECT_TARGET'
  });
  assertIdentifier(target[idField], `target.${idField}`, {
    prefixes: [prefix],
    code: 'INVALID_EFFECT_TARGET'
  });
}

function assertSkill(skill, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(skill, {
    label,
    allowed: [
      'skill_id',
      'version',
      'display_name',
      'category',
      'rank',
      'mastery',
      'canonical_ref'
    ],
    code
  });
  assertIdentifier(skill.skill_id, `${label}.skill_id`, { prefixes: ['skill:'], code });
  assertInteger(skill.version, `${label}.version`, { min: 1, code });
  assertString(skill.display_name, `${label}.display_name`, { max: 160, code });
  assertString(skill.category, `${label}.category`, { enumValues: SKILL_CATEGORIES, code });
  assertString(skill.rank, `${label}.rank`, { max: 40, code });
  assertInteger(skill.mastery, `${label}.mastery`, { min: 0, max: 100, code });
  assertNullableString(skill.canonical_ref, `${label}.canonical_ref`, { max: 160, code });
}

export function assertActorSkills(value, label = 'actor.skills') {
  assertDomainContainer(value, ACTOR_SKILLS_SCHEMA, label);
  assertArray(value.entries, `${label}.entries`, {
    max: 2_000,
    item: (entry, itemLabel) => assertSkill(entry, itemLabel),
    uniqueBy: entry => entry.skill_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  return value;
}

function assertItem(item, label, code = 'INVALID_CANDIDATE_STATE') {
  assertExactObject(item, {
    label,
    allowed: [
      'item_id',
      'version',
      'display_name',
      'category',
      'quantity',
      'canonical_ref',
      'equipped_slot'
    ],
    code
  });
  assertIdentifier(item.item_id, `${label}.item_id`, { prefixes: ['item:'], code });
  assertInteger(item.version, `${label}.version`, { min: 1, code });
  assertString(item.display_name, `${label}.display_name`, { max: 160, code });
  assertString(item.category, `${label}.category`, { enumValues: ITEM_CATEGORIES, code });
  assertInteger(item.quantity, `${label}.quantity`, { min: 1, max: 1_000_000, code });
  assertNullableString(item.canonical_ref, `${label}.canonical_ref`, { max: 160, code });
  if (item.equipped_slot !== null) {
    assertString(item.equipped_slot, `${label}.equipped_slot`, {
      enumValues: EQUIPMENT_SLOTS,
      code
    });
    if (item.category !== 'EQUIPMENT') {
      fail(code, `${label} can only be equipped when category is EQUIPMENT`);
    }
  }
}

export function assertActorItems(value, label = 'actor.equipment') {
  assertDomainContainer(value, ACTOR_ITEMS_SCHEMA, label);
  assertArray(value.entries, `${label}.entries`, {
    max: 5_000,
    item: (entry, itemLabel) => assertItem(entry, itemLabel),
    uniqueBy: entry => entry.item_id,
    code: 'INVALID_CANDIDATE_STATE'
  });
  const occupied = new Set();
  for (const item of value.entries) {
    if (item.equipped_slot === null) continue;
    if (occupied.has(item.equipped_slot)) {
      fail('INVALID_CANDIDATE_STATE', `${label} contains two items in one equipment slot`, {
        equipped_slot: item.equipped_slot
      });
    }
    occupied.add(item.equipped_slot);
  }
  return value;
}

function validateSkillEffect(effect) {
  assertStableEntityTarget(effect.target, 'actor_skill', 'skill_id', 'skill:');
  if (effect.operation === 'upsert') {
    assertExactObject(effect.payload, {
      label: 'skill upsert payload',
      allowed: [
        'expected_version',
        'next_version',
        'display_name',
        'category',
        'rank',
        'mastery',
        'canonical_ref'
      ]
    });
    if (effect.payload.expected_version !== null) {
      assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    }
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
    assertString(effect.payload.display_name, 'payload.display_name', { max: 160 });
    assertString(effect.payload.category, 'payload.category', { enumValues: SKILL_CATEGORIES });
    assertString(effect.payload.rank, 'payload.rank', { max: 40 });
    assertInteger(effect.payload.mastery, 'payload.mastery', { min: 0, max: 100 });
    assertNullableString(effect.payload.canonical_ref, 'payload.canonical_ref', { max: 160 });
  } else {
    assertExactObject(effect.payload, {
      label: 'skill remove payload',
      allowed: ['expected_version']
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  }
}

function reduceSkill(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  const { actor } = findActor(next, effect.target.actor_id);
  assertActorSkills(actor.skills);
  const entries = actor.skills.entries;
  const index = entries.findIndex(entry => entry.skill_id === effect.target.skill_id);
  const before = index < 0 ? null : entries[index];
  let after = null;

  if (effect.operation === 'upsert') {
    if (before === null) {
      assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, false, 'skill');
    } else {
      assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'skill');
    }
    after = {
      skill_id: effect.target.skill_id,
      version: effect.payload.next_version,
      display_name: effect.payload.display_name,
      category: effect.payload.category,
      rank: effect.payload.rank,
      mastery: effect.payload.mastery,
      canonical_ref: effect.payload.canonical_ref
    };
    if (before === null) insertSorted(entries, after, 'skill_id');
    else replaceSorted(entries, index, after, 'skill_id');
  } else {
    if (before === null) fail('EFFECT_TARGET_NOT_FOUND', 'skill does not exist');
    if (before.version !== effect.payload.expected_version) {
      fail('EFFECT_PRECONDITION_FAILED', 'skill version precondition failed');
    }
    entries.splice(index, 1);
  }
  assertActorSkills(actor.skills);
  const reducerKey = effect.operation === 'remove' ? 'remove_actor_skill' : 'upsert_actor_skill';
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey,
    reducerVersion: SKILL_ITEM_REDUCER_VERSIONS[reducerKey],
    primary: {
      operation: effect.operation,
      target: effect.target,
      before,
      after
    },
    invariantResults: [
      { invariant_id: 'actor-skill-stable-id' },
      { invariant_id: 'actor-skill-single-version-step' }
    ]
  });
}

function validateItemEffect(effect) {
  assertStableEntityTarget(effect.target, 'actor_item', 'item_id', 'item:');
  if (effect.operation === 'upsert') {
    assertExactObject(effect.payload, {
      label: 'item upsert payload',
      allowed: [
        'expected_version',
        'next_version',
        'display_name',
        'category',
        'quantity',
        'canonical_ref',
        'equipped_slot'
      ]
    });
    if (effect.payload.expected_version !== null) {
      assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    }
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
    assertString(effect.payload.display_name, 'payload.display_name', { max: 160 });
    assertString(effect.payload.category, 'payload.category', { enumValues: ITEM_CATEGORIES });
    assertInteger(effect.payload.quantity, 'payload.quantity', { min: 1, max: 1_000_000 });
    assertNullableString(effect.payload.canonical_ref, 'payload.canonical_ref', { max: 160 });
    if (effect.payload.equipped_slot !== null) {
      assertString(effect.payload.equipped_slot, 'payload.equipped_slot', { enumValues: EQUIPMENT_SLOTS });
      if (effect.payload.category !== 'EQUIPMENT') {
        fail('INVALID_EFFECT_PAYLOAD', 'only EQUIPMENT items may have an equipped_slot');
      }
    }
    return;
  }
  if (effect.operation === 'consume') {
    assertExactObject(effect.payload, {
      label: 'item consume payload',
      allowed: ['expected_version', 'next_version', 'from_quantity', 'amount', 'to_quantity']
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
    assertInteger(effect.payload.from_quantity, 'payload.from_quantity', { min: 1 });
    assertInteger(effect.payload.amount, 'payload.amount', { min: 1 });
    assertInteger(effect.payload.to_quantity, 'payload.to_quantity', { min: 0 });
    return;
  }
  if (effect.operation === 'equip' || effect.operation === 'unequip') {
    assertExactObject(effect.payload, {
      label: `item ${effect.operation} payload`,
      allowed: ['expected_version', 'next_version', 'expected_slot', 'next_slot']
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
    if (effect.payload.expected_slot !== null) {
      assertString(effect.payload.expected_slot, 'payload.expected_slot', { enumValues: EQUIPMENT_SLOTS });
    }
    if (effect.payload.next_slot !== null) {
      assertString(effect.payload.next_slot, 'payload.next_slot', { enumValues: EQUIPMENT_SLOTS });
    }
    if (effect.operation === 'equip' && effect.payload.next_slot === null) {
      fail('INVALID_EFFECT_PAYLOAD', 'equip requires a non-null next_slot');
    }
    if (effect.operation === 'unequip' && effect.payload.next_slot !== null) {
      fail('INVALID_EFFECT_PAYLOAD', 'unequip requires next_slot null');
    }
    return;
  }
  assertExactObject(effect.payload, {
    label: 'item remove payload',
    allowed: ['expected_version', 'expected_quantity']
  });
  assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  assertInteger(effect.payload.expected_quantity, 'payload.expected_quantity', { min: 1 });
}

function reduceItem(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  const { actor } = findActor(next, effect.target.actor_id);
  assertActorItems(actor.equipment);
  const entries = actor.equipment.entries;
  const index = entries.findIndex(entry => entry.item_id === effect.target.item_id);
  const before = index < 0 ? null : entries[index];
  let after = null;

  if (effect.operation === 'upsert') {
    if (before === null) {
      assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, false, 'item');
    } else {
      assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'item');
    }
    after = {
      item_id: effect.target.item_id,
      version: effect.payload.next_version,
      display_name: effect.payload.display_name,
      category: effect.payload.category,
      quantity: effect.payload.quantity,
      canonical_ref: effect.payload.canonical_ref,
      equipped_slot: effect.payload.equipped_slot
    };
    if (before === null) insertSorted(entries, after, 'item_id');
    else replaceSorted(entries, index, after, 'item_id');
  } else {
    if (before === null) fail('EFFECT_TARGET_NOT_FOUND', 'item does not exist');
    if (effect.operation === 'consume') {
      assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'item');
      if (effect.payload.from_quantity !== before.quantity) {
        fail('EFFECT_PRECONDITION_FAILED', 'item quantity precondition failed');
      }
      const calculated = effect.payload.from_quantity - effect.payload.amount;
      if (calculated < 0) {
        fail('ITEM_QUANTITY_FLOOR_VIOLATION', 'item consumption exceeds available quantity');
      }
      if (effect.payload.to_quantity !== calculated) {
        fail('INVALID_EFFECT_PAYLOAD', 'item consume payload has an inconsistent to_quantity');
      }
      if (calculated === 0) {
        entries.splice(index, 1);
      } else {
        after = {
          ...before,
          version: effect.payload.next_version,
          quantity: calculated
        };
        replaceSorted(entries, index, after, 'item_id');
      }
    } else if (effect.operation === 'equip' || effect.operation === 'unequip') {
      assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'item');
      if (before.category !== 'EQUIPMENT') {
        fail('EFFECT_PRECONDITION_FAILED', 'only EQUIPMENT items may be equipped');
      }
      if (before.equipped_slot !== effect.payload.expected_slot) {
        fail('EFFECT_PRECONDITION_FAILED', 'item equipped slot precondition failed');
      }
      if (effect.payload.next_slot !== null) {
        const occupied = entries.find(entry =>
          entry.item_id !== before.item_id && entry.equipped_slot === effect.payload.next_slot
        );
        if (occupied) {
          fail('EQUIPMENT_SLOT_OCCUPIED', 'equipment slot is already occupied', {
            item_id: occupied.item_id,
            equipped_slot: effect.payload.next_slot
          });
        }
      }
      after = {
        ...before,
        version: effect.payload.next_version,
        equipped_slot: effect.payload.next_slot
      };
      replaceSorted(entries, index, after, 'item_id');
    } else {
      if (
        before.version !== effect.payload.expected_version ||
        before.quantity !== effect.payload.expected_quantity
      ) {
        fail('EFFECT_PRECONDITION_FAILED', 'item removal precondition failed');
      }
      entries.splice(index, 1);
    }
  }

  assertActorItems(actor.equipment);
  const reducerKey = effect.operation === 'remove'
    ? 'remove_actor_item'
    : 'upsert_actor_item';
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey,
    reducerVersion: SKILL_ITEM_REDUCER_VERSIONS[reducerKey],
    primary: {
      operation: effect.operation === 'consume' && after === null
        ? 'consume_and_remove_exhausted_entity'
        : effect.operation,
      target: effect.target,
      before,
      after
    },
    invariantResults: [
      { invariant_id: 'actor-item-stable-id' },
      { invariant_id: 'actor-item-positive-quantity-or-absent' },
      { invariant_id: 'actor-item-no-hidden-resource-effect' }
    ]
  });
}

export const SKILL_ITEM_EFFECT_CONTRACTS = Object.freeze([
  Object.freeze({
    domain: 'skill',
    kind: 'actor_skill',
    operations: Object.freeze(['upsert']),
    reducerKey: 'upsert_actor_skill',
    reducerVersion: SKILL_ITEM_REDUCER_VERSIONS.upsert_actor_skill,
    validate: validateSkillEffect,
    reduce: reduceSkill
  }),
  Object.freeze({
    domain: 'skill',
    kind: 'actor_skill',
    operations: Object.freeze(['remove']),
    reducerKey: 'remove_actor_skill',
    reducerVersion: SKILL_ITEM_REDUCER_VERSIONS.remove_actor_skill,
    validate: validateSkillEffect,
    reduce: reduceSkill
  }),
  Object.freeze({
    domain: 'item',
    kind: 'actor_item',
    operations: Object.freeze(['upsert', 'consume', 'equip', 'unequip']),
    reducerKey: 'upsert_actor_item',
    reducerVersion: SKILL_ITEM_REDUCER_VERSIONS.upsert_actor_item,
    validate: validateItemEffect,
    reduce: reduceItem
  }),
  Object.freeze({
    domain: 'item',
    kind: 'actor_item',
    operations: Object.freeze(['remove']),
    reducerKey: 'remove_actor_item',
    reducerVersion: SKILL_ITEM_REDUCER_VERSIONS.remove_actor_item,
    validate: validateItemEffect,
    reduce: reduceItem
  })
]);
