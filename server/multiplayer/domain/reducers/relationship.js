import {
  assertArray,
  assertCreateVersion,
  assertExactObject,
  assertIdentifier,
  assertInteger,
  assertRecord,
  assertString,
  assertVersionStep,
  cloneCandidate,
  compareText,
  fail,
  insertSorted,
  reducerResult,
  replaceSorted
} from './shared.js';
import { assertActorProfile } from './actor.js';
import { assertCombatCollection } from './combat-event.js';
import { assertNpcProfile, assertWorldState } from './world.js';

export const RELATIONSHIP_REDUCER_VERSION = 'relationship-reducer/v1';

const RELATIONSHIP_KINDS = Object.freeze(['ALLY', 'RIVAL', 'HOSTILE', 'NEUTRAL', 'MENTOR']);
const MEMORY_PARTITIONS = Object.freeze([
  'canonical',
  'shared',
  'actor:A',
  'actor:B',
  'npc_private'
]);

function assertEntityId(value, label, code = 'INVALID_EFFECT_PAYLOAD') {
  return assertIdentifier(value, label, { prefixes: ['actor:', 'npc:'], code });
}

function assertEvidence(value, label = 'evidence_event_ids', code = 'INVALID_EFFECT_PAYLOAD') {
  assertArray(value, label, {
    min: 1,
    max: 64,
    item: (id, itemLabel) => assertIdentifier(id, itemLabel, { prefixes: ['event_'], code }),
    uniqueBy: id => id,
    code
  });
}

export function assertRelationshipEdgeData(value, label = 'relationship.data') {
  assertExactObject(value, {
    label,
    allowed: [
      'version',
      'kind',
      'score',
      'label',
      'evidence_event_ids',
      'source_display_name',
      'target_display_name'
    ],
    code: 'INVALID_CANDIDATE_STATE'
  });
  assertInteger(value.version, `${label}.version`, { min: 1, code: 'INVALID_CANDIDATE_STATE' });
  assertString(value.kind, `${label}.kind`, { enumValues: RELATIONSHIP_KINDS, code: 'INVALID_CANDIDATE_STATE' });
  assertInteger(value.score, `${label}.score`, { min: -100, max: 100, code: 'INVALID_CANDIDATE_STATE' });
  assertString(value.label, `${label}.label`, { max: 160, code: 'INVALID_CANDIDATE_STATE' });
  assertEvidence(value.evidence_event_ids, `${label}.evidence_event_ids`, 'INVALID_CANDIDATE_STATE');
  assertString(value.source_display_name, `${label}.source_display_name`, { max: 160, code: 'INVALID_CANDIDATE_STATE' });
  assertString(value.target_display_name, `${label}.target_display_name`, { max: 160, code: 'INVALID_CANDIDATE_STATE' });
}

export function assertRelationshipEdges(candidate) {
  for (let index = 0; index < candidate.relationships.length; index += 1) {
    const edge = candidate.relationships[index];
    assertRelationshipEdgeData(edge.data, `relationships[${index}].data`);
    if (edge.source_actor_id === edge.target_actor_id) {
      fail('INVALID_CANDIDATE_STATE', 'a directed relationship cannot target itself', {
        edge_id: edge.edge_id
      });
    }
  }
  return candidate.relationships;
}

function assertEdgeTarget(target) {
  assertExactObject(target, {
    label: 'effect target',
    allowed: ['scope', 'edge_id', 'source_actor_id', 'target_actor_id'],
    code: 'INVALID_EFFECT_TARGET'
  });
  if (target.scope !== 'relationship_edge') {
    fail('INVALID_EFFECT_TARGET', 'target.scope must be relationship_edge');
  }
  assertIdentifier(target.edge_id, 'target.edge_id', {
    prefixes: ['relationship:'],
    code: 'INVALID_EFFECT_TARGET'
  });
  assertEntityId(target.source_actor_id, 'target.source_actor_id', 'INVALID_EFFECT_TARGET');
  assertEntityId(target.target_actor_id, 'target.target_actor_id', 'INVALID_EFFECT_TARGET');
  if (target.source_actor_id === target.target_actor_id) {
    fail('INVALID_EFFECT_TARGET', 'a directed relationship cannot target itself');
  }
}

function assertNpcTarget(target) {
  assertExactObject(target, {
    label: 'effect target',
    allowed: ['scope', 'npc_id'],
    code: 'INVALID_EFFECT_TARGET'
  });
  if (target.scope !== 'npc_profile') fail('INVALID_EFFECT_TARGET', 'target.scope must be npc_profile');
  assertIdentifier(target.npc_id, 'target.npc_id', {
    prefixes: ['npc:'],
    code: 'INVALID_EFFECT_TARGET'
  });
}

function resolveDisplayName(candidate, entityId) {
  for (const seat of ['A', 'B']) {
    const actor = candidate.actors[seat];
    if (actor.room_actor_id === entityId) {
      assertActorProfile(actor.player, `actors.${seat}.player`);
      return actor.player.display_name;
    }
  }
  assertWorldState(candidate.shared_world.world_state);
  const npc = candidate.shared_world.world_state.npc_profiles.find(
    profile => profile.npc_id === entityId
  );
  if (!npc) fail('EFFECT_TARGET_NOT_FOUND', 'relationship endpoint does not exist', { entity_id: entityId });
  return npc.display_name;
}

function validateEdgeEffect(effect) {
  assertEdgeTarget(effect.target);
  if (effect.operation === 'upsert') {
    assertExactObject(effect.payload, {
      label: 'relationship edge upsert payload',
      allowed: [
        'expected_version',
        'next_version',
        'kind',
        'score',
        'label',
        'evidence_event_ids'
      ]
    });
    if (effect.payload.expected_version !== null) {
      assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    }
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
    assertString(effect.payload.kind, 'payload.kind', { enumValues: RELATIONSHIP_KINDS });
    assertInteger(effect.payload.score, 'payload.score', { min: -100, max: 100 });
    assertString(effect.payload.label, 'payload.label', { max: 160 });
    assertEvidence(effect.payload.evidence_event_ids, 'payload.evidence_event_ids');
  } else {
    assertExactObject(effect.payload, {
      label: 'relationship edge remove payload',
      allowed: ['expected_version']
    });
    assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  }
}

function reduceEdge(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  assertRelationshipEdges(next);
  const index = next.relationships.findIndex(edge => edge.edge_id === effect.target.edge_id);
  const before = index < 0 ? null : next.relationships[index];
  let after = null;
  if (effect.operation === 'upsert') {
    if (before === null) {
      assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, false, 'relationship edge');
    } else {
      assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.data.version, 'relationship edge');
      if (
        before.source_actor_id !== effect.target.source_actor_id ||
        before.target_actor_id !== effect.target.target_actor_id
      ) {
        fail('STABLE_ID_VIOLATION', 'relationship edge endpoints cannot change under one edge_id');
      }
    }
    after = {
      edge_id: effect.target.edge_id,
      source_actor_id: effect.target.source_actor_id,
      target_actor_id: effect.target.target_actor_id,
      data: {
        version: effect.payload.next_version,
        kind: effect.payload.kind,
        score: effect.payload.score,
        label: effect.payload.label,
        evidence_event_ids: [...effect.payload.evidence_event_ids].sort(),
        source_display_name: resolveDisplayName(next, effect.target.source_actor_id),
        target_display_name: resolveDisplayName(next, effect.target.target_actor_id)
      }
    };
    if (before === null) insertSorted(next.relationships, after, 'edge_id');
    else replaceSorted(next.relationships, index, after, 'edge_id');
  } else {
    if (before === null) fail('EFFECT_TARGET_NOT_FOUND', 'relationship edge does not exist');
    if (before.data.version !== effect.payload.expected_version) {
      fail('EFFECT_PRECONDITION_FAILED', 'relationship edge version precondition failed');
    }
    if (
      before.source_actor_id !== effect.target.source_actor_id ||
      before.target_actor_id !== effect.target.target_actor_id
    ) {
      fail('EFFECT_PRECONDITION_FAILED', 'relationship endpoint precondition failed');
    }
    next.relationships.splice(index, 1);
  }
  assertRelationshipEdges(next);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_relationship_effect',
    reducerVersion: RELATIONSHIP_REDUCER_VERSION,
    primary: { operation: effect.operation, target: effect.target, before, after },
    invariantResults: [
      { invariant_id: 'relationship-directed-stable-edge' },
      { invariant_id: 'relationship-evidence-required' }
    ]
  });
}

function validateNpcEffect(effect) {
  assertNpcTarget(effect.target);
  if (effect.operation === 'upsert') {
    assertExactObject(effect.payload, {
      label: 'NPC profile upsert payload',
      allowed: [
        'expected_version',
        'next_version',
        'display_name',
        'faction',
        'rank',
        'public_status',
        'evidence_event_ids'
      ]
    });
    if (effect.payload.expected_version !== null) {
      assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
    }
    assertInteger(effect.payload.next_version, 'payload.next_version', { min: 1 });
    assertString(effect.payload.display_name, 'payload.display_name', { max: 160 });
    assertString(effect.payload.faction, 'payload.faction', { max: 160 });
    assertString(effect.payload.rank, 'payload.rank', { max: 80 });
    assertString(effect.payload.public_status, 'payload.public_status', {
      enumValues: ['ACTIVE', 'MISSING', 'DECEASED', 'UNKNOWN']
    });
    assertEvidence(effect.payload.evidence_event_ids, 'payload.evidence_event_ids');
    return;
  }
  assertExactObject(effect.payload, {
    label: 'NPC rename payload',
    allowed: [
      'expected_version',
      'next_version',
      'from_display_name',
      'to_display_name',
      'evidence_event_ids'
    ]
  });
  assertInteger(effect.payload.expected_version, 'payload.expected_version', { min: 1 });
  assertInteger(effect.payload.next_version, 'payload.next_version', { min: 2 });
  assertString(effect.payload.from_display_name, 'payload.from_display_name', { max: 160 });
  assertString(effect.payload.to_display_name, 'payload.to_display_name', { max: 160 });
  if (effect.payload.from_display_name === effect.payload.to_display_name) {
    fail('INVALID_EFFECT_PAYLOAD', 'NPC rename must change the display name');
  }
  assertEvidence(effect.payload.evidence_event_ids, 'payload.evidence_event_ids');
}

function cacheOperation(cacheType, ownerId, npcId, beforeDisplayName, afterDisplayName) {
  return {
    policy_id: 'npc-display-name-cache-refresh',
    policy_version: '1',
    operation: 'refresh_display_name_cache',
    target: {
      cache_type: cacheType,
      owner_id: ownerId,
      subject_id: npcId
    },
    before: { display_name: beforeDisplayName },
    after: { display_name: afterDisplayName }
  };
}

function refreshRelationshipCaches(candidate, npcId, fromName, toName, operations) {
  for (const edge of candidate.relationships) {
    if (edge.source_actor_id === npcId && edge.data.source_display_name === fromName) {
      edge.data.source_display_name = toName;
      operations.push(cacheOperation(
        'relationship_display_name_cache',
        edge.edge_id,
        npcId,
        fromName,
        toName
      ));
    }
    if (edge.target_actor_id === npcId && edge.data.target_display_name === fromName) {
      edge.data.target_display_name = toName;
      operations.push(cacheOperation(
        'relationship_display_name_cache',
        edge.edge_id,
        npcId,
        fromName,
        toName
      ));
    }
  }
}

function refreshMemoryCaches(candidate, npcId, fromName, toName, operations) {
  for (const partitionName of MEMORY_PARTITIONS) {
    const partition = candidate.memories[partitionName];
    if (!partition || typeof partition !== 'object' || Array.isArray(partition)) continue;
    if (!Object.prototype.hasOwnProperty.call(partition, 'entries')) continue;
    if (!Array.isArray(partition.entries)) {
      fail('INVALID_CANDIDATE_STATE', 'memory partition entries must be an array for cache migration', {
        partition: partitionName
      });
    }
    for (const entry of partition.entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (!Object.prototype.hasOwnProperty.call(entry, 'subject_display_names')) continue;
      assertArray(entry.subject_display_names, 'memory subject display-name cache', {
        max: 256,
        item(cache, label) {
          assertExactObject(cache, {
            label,
            allowed: ['subject_id', 'display_name'],
            code: 'INVALID_CANDIDATE_STATE'
          });
          assertEntityId(cache.subject_id, `${label}.subject_id`, 'INVALID_CANDIDATE_STATE');
          assertString(cache.display_name, `${label}.display_name`, {
            max: 160,
            code: 'INVALID_CANDIDATE_STATE'
          });
        },
        uniqueBy: cache => cache.subject_id,
        code: 'INVALID_CANDIDATE_STATE'
      });
      const cache = entry.subject_display_names.find(value => value.subject_id === npcId);
      if (!cache || cache.display_name !== fromName) continue;
      cache.display_name = toName;
      const memoryId = typeof entry.memory_id === 'string' ? entry.memory_id : 'memory:unversioned';
      operations.push(cacheOperation(
        'memory_subject_display_name_cache',
        `${partitionName}:${memoryId}`,
        npcId,
        fromName,
        toName
      ));
    }
  }
}

function refreshCombatCaches(candidate, npcId, fromName, toName, operations) {
  assertCombatCollection(candidate.shared_world.shared_combat);
  for (const combat of candidate.shared_world.shared_combat.entries) {
    const participant = combat.participants.find(value => value.participant_id === npcId);
    if (!participant || participant.display_name !== fromName) continue;
    participant.display_name = toName;
    operations.push(cacheOperation(
      'combat_participant_display_name_cache',
      combat.combat_id,
      npcId,
      fromName,
      toName
    ));
  }
}

function reduceNpc(baseCandidate, effect) {
  const next = cloneCandidate(baseCandidate);
  assertWorldState(next.shared_world.world_state);
  assertRelationshipEdges(next);
  const entries = next.shared_world.world_state.npc_profiles;
  const index = entries.findIndex(profile => profile.npc_id === effect.target.npc_id);
  const before = index < 0 ? null : entries[index];
  let after;
  const systemDerived = [];
  if (effect.operation === 'upsert') {
    if (before === null) {
      assertCreateVersion(effect.payload.expected_version, effect.payload.next_version, false, 'NPC profile');
    } else {
      assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'NPC profile');
      if (before.display_name !== effect.payload.display_name) {
        fail('INVALID_EFFECT_CONTRACT', 'existing NPC display_name can only change through rename');
      }
    }
    after = {
      npc_id: effect.target.npc_id,
      version: effect.payload.next_version,
      display_name: effect.payload.display_name,
      faction: effect.payload.faction,
      rank: effect.payload.rank,
      public_status: effect.payload.public_status,
      evidence_event_ids: [...effect.payload.evidence_event_ids].sort()
    };
  } else {
    if (before === null) fail('EFFECT_TARGET_NOT_FOUND', 'NPC profile does not exist');
    assertVersionStep(effect.payload.expected_version, effect.payload.next_version, before.version, 'NPC profile');
    if (before.display_name !== effect.payload.from_display_name) {
      fail('EFFECT_PRECONDITION_FAILED', 'NPC display_name precondition failed');
    }
    after = {
      ...before,
      version: effect.payload.next_version,
      display_name: effect.payload.to_display_name,
      evidence_event_ids: [...effect.payload.evidence_event_ids].sort()
    };
    refreshRelationshipCaches(
      next,
      effect.target.npc_id,
      effect.payload.from_display_name,
      effect.payload.to_display_name,
      systemDerived
    );
    refreshMemoryCaches(
      next,
      effect.target.npc_id,
      effect.payload.from_display_name,
      effect.payload.to_display_name,
      systemDerived
    );
    refreshCombatCaches(
      next,
      effect.target.npc_id,
      effect.payload.from_display_name,
      effect.payload.to_display_name,
      systemDerived
    );
    systemDerived.sort((left, right) =>
      compareText(JSON.stringify(left.target), JSON.stringify(right.target))
    );
  }
  if (before === null) insertSorted(entries, after, 'npc_id');
  else replaceSorted(entries, index, after, 'npc_id');
  assertNpcProfile(after, 'NPC profile');
  assertWorldState(next.shared_world.world_state);
  assertRelationshipEdges(next);
  assertCombatCollection(next.shared_world.shared_combat);
  return reducerResult({
    baseCandidate,
    nextCandidate: next,
    effect,
    reducerKey: 'apply_relationship_effect',
    reducerVersion: RELATIONSHIP_REDUCER_VERSION,
    primary: { operation: effect.operation, target: effect.target, before, after },
    systemDerived,
    invariantResults: [
      { invariant_id: 'npc-profile-stable-id' },
      { invariant_id: 'npc-profile-evidence-required' },
      { invariant_id: 'system-derived-display-cache-only' }
    ]
  });
}

export const RELATIONSHIP_EFFECT_CONTRACTS = Object.freeze([
  Object.freeze({
    domain: 'relationship',
    kind: 'edge',
    operations: Object.freeze(['upsert', 'remove']),
    reducerKey: 'apply_relationship_effect',
    reducerVersion: RELATIONSHIP_REDUCER_VERSION,
    validate: validateEdgeEffect,
    reduce: reduceEdge
  }),
  Object.freeze({
    domain: 'relationship',
    kind: 'npc_profile',
    operations: Object.freeze(['upsert', 'rename']),
    reducerKey: 'apply_relationship_effect',
    reducerVersion: RELATIONSHIP_REDUCER_VERSION,
    validate: validateNpcEffect,
    reduce: reduceNpc
  })
]);
