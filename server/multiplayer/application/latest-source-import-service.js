import {
  AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
  SOURCE_IMPORT_SCHEMA,
  assertAudienceSafeImportDiff,
  assertSourceImport
} from '../contracts/lineage-contracts.js';
import {
  canonicalStringify,
  canonicalizeJson,
  hmacSha256,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import {
  LATEST_SOURCE_PRIVACY_NORMALIZER_VERSION,
  normalizeLatestSourcePrivacy,
  roomCheckpointStateHash
} from '../domain/lineage.js';
import { assertReducerDomainState } from '../domain/reducers/index.js';
import {
  MULTIPLAYER_TO_SINGLEPLAYER_CODEC,
  PERSONAL_SINGLEPLAYER_TIMELINE_SCHEMA,
  SERVER_REIMPORT_CAPSULE_SCHEMA
} from './multiplayer-to-singleplayer-codec.js';

export const LATEST_SOURCE_SAVE_IMPORT_KIND = 'latest_source_continuation';

const ROOM_SEATS = Object.freeze(['A', 'B']);
const ID = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;
const REQUEST_FIELDS = new Set([
  'import_kind',
  'proposal_id',
  'proposal_revision',
  'source_save_id',
  'client_save_instance_id',
  'source_branch_id',
  'source_node_id',
  'cloud_revision',
  'source_document',
  'idempotency_key'
]);

function fail(code, message, details = {}, status = 400, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('LATEST_SOURCE_IMPORT_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL.test(value)) {
    fail('LATEST_SOURCE_IMPORT_REQUEST_INVALID', 'authenticated_user_id is invalid', {}, 401);
  }
  return value;
}

function integer(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    fail('LATEST_SOURCE_IMPORT_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function request(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('LATEST_SOURCE_IMPORT_REQUEST_INVALID', 'latest-source save import must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!REQUEST_FIELDS.has(key)) {
      fail(
        'LATEST_SOURCE_IMPORT_REQUEST_INVALID',
        'latest-source save import contains an unsupported field',
        { field: key }
      );
    }
  }
  for (const field of [
    'import_kind',
    'proposal_id',
    'proposal_revision',
    'source_save_id',
    'client_save_instance_id',
    'source_branch_id',
    'source_node_id',
    'source_document',
    'idempotency_key'
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      fail('LATEST_SOURCE_IMPORT_REQUEST_INVALID', `latest-source import is missing ${field}`, {
        field
      });
    }
  }
  if (value.import_kind !== LATEST_SOURCE_SAVE_IMPORT_KIND) {
    fail('LATEST_SOURCE_IMPORT_REQUEST_INVALID', 'import_kind is invalid');
  }
  const idempotencyKey = String(value.idempotency_key ?? '');
  if (!idempotencyKey || idempotencyKey.length > 200) {
    fail('LATEST_SOURCE_IMPORT_REQUEST_INVALID', 'idempotency_key is invalid');
  }
  const cloudRevision = value.cloud_revision ?? null;
  if (cloudRevision !== null
    && (typeof cloudRevision !== 'string' || !cloudRevision || cloudRevision.length > 160)) {
    fail('LATEST_SOURCE_IMPORT_REQUEST_INVALID', 'cloud_revision is invalid');
  }
  return Object.freeze({
    proposal_id: identifier(value.proposal_id, 'proposal_id'),
    proposal_revision: integer(value.proposal_revision, 'proposal_revision', { min: 1 }),
    source_save_id: identifier(value.source_save_id, 'source_save_id'),
    client_save_instance_id: identifier(
      value.client_save_instance_id,
      'client_save_instance_id'
    ),
    source_branch_id: identifier(value.source_branch_id, 'source_branch_id'),
    source_node_id: identifier(value.source_node_id, 'source_node_id'),
    cloud_revision: cloudRevision,
    source_document: value.source_document,
    idempotency_key: idempotencyKey
  });
}

function hash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function hmac(secret, value) {
  return `hmac-sha256:${hmacSha256(secret, value)}`;
}

function clone(value) {
  return canonicalizeJson(value);
}

function normalizedStateHash(value) {
  const state = clone(assertReducerDomainState(value));
  delete state.meta;
  return hash(state);
}

function parseBoolean(value, fallback) {
  if (value === true || value === '是' || value === 'true') return true;
  if (value === false || value === '否' || value === 'false') return false;
  return fallback;
}

function boundedText(value, fallback, max) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text && text.length <= max ? text : fallback;
}

function nonNegativeInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fallback;
}

function overlayResource(actor, snapshot, resourceId, currentKey, maximumKey) {
  const resource = actor.attributes.resources.find(item => item.resource_id === resourceId);
  if (!resource) return;
  const maximum = maximumKey === null
    ? resource.maximum
    : nonNegativeInteger(snapshot[maximumKey], resource.maximum);
  const current = nonNegativeInteger(snapshot[currentKey], resource.current, maximum);
  if (maximum !== resource.maximum || current !== resource.current) {
    resource.maximum = maximum;
    resource.current = current;
    resource.version += 1;
  }
}

function stableImportedId(prefix, material) {
  return `${prefix}import_${sha256Hex(material).slice(0, 32)}`;
}

function overlayOwnerSkills(actor, snapshot) {
  const categoryByLabel = {
    '忍术': 'NINJUTSU',
    '体术': 'TAIJUTSU',
    '幻术': 'GENJUTSU',
    '血继限界': 'BLOODLINE',
    '支援': 'OTHER'
  };
  const parsed = new Map();
  for (const [key, value] of Object.entries(snapshot)) {
    const match = key.match(/^技能·(忍术|体术|幻术|血继限界|支援)·(.+)·(名称|等级|熟练度|数据库ID)$/u);
    if (!match) continue;
    const [, label, embeddedName, field] = match;
    const mapKey = `${label}\u0000${embeddedName}`;
    const record = parsed.get(mapKey) ?? { label, embeddedName };
    record[field] = value;
    parsed.set(mapKey, record);
  }
  if (parsed.size === 0) return;
  const existingByKey = new Map(actor.skills.entries.map(entry => [
    `${entry.category}\u0000${entry.display_name}`,
    entry
  ]));
  const entries = [];
  for (const record of parsed.values()) {
    const category = categoryByLabel[record.label];
    const displayName = boundedText(record['名称'], record.embeddedName, 160);
    const existing = existingByKey.get(`${category}\u0000${displayName}`);
    const mastery = nonNegativeInteger(record['熟练度'], existing?.mastery ?? 0, 100);
    const rank = boundedText(record['等级'], existing?.rank ?? 'E', 40);
    const canonicalRef = typeof record['数据库ID'] === 'string'
      && record['数据库ID'].trim()
      && record['数据库ID'].length <= 160
      ? record['数据库ID']
      : (existing?.canonical_ref ?? null);
    const candidate = {
      skill_id: existing?.skill_id
        ?? stableImportedId('skill:', { category, display_name: displayName }),
      version: existing?.version ?? 1,
      display_name: displayName,
      category,
      rank,
      mastery,
      canonical_ref: canonicalRef
    };
    if (existing && canonicalStringify(candidate) !== canonicalStringify(existing)) {
      candidate.version = existing.version + 1;
    }
    entries.push(candidate);
  }
  entries.sort((left, right) => left.skill_id.localeCompare(right.skill_id));
  actor.skills.entries = entries;
}

function overlayOwnerItems(actor, snapshot) {
  const categoryByLabel = {
    '消耗品': 'CONSUMABLE',
    '装备': 'EQUIPMENT',
    '素材': 'MATERIAL',
    '关键': 'KEY',
    '道具': 'MATERIAL'
  };
  const slotByLabel = {
    '武器': 'weapon',
    '防具': 'armor',
    '饰品1': 'accessory',
    '饰品2': 'tool'
  };
  const equippedByName = new Map();
  for (const [label, slot] of Object.entries(slotByLabel)) {
    const displayName = snapshot[`物品·已装备·${label}`];
    if (typeof displayName === 'string' && displayName.trim()) {
      equippedByName.set(displayName.trim(), slot);
    }
  }
  const parsed = new Map();
  for (const [key, value] of Object.entries(snapshot)) {
    const match = key.match(/^物品·(消耗品|装备|素材|关键|道具)·(.+)·(数量|描述)$/u);
    if (!match) continue;
    const [, label, displayName, field] = match;
    const mapKey = `${label}\u0000${displayName}`;
    const record = parsed.get(mapKey) ?? { label, displayName };
    record[field] = value;
    parsed.set(mapKey, record);
  }
  if (parsed.size === 0) return;
  const existingByKey = new Map(actor.equipment.entries.map(entry => [
    `${entry.category}\u0000${entry.display_name}`,
    entry
  ]));
  const entries = [];
  for (const record of parsed.values()) {
    const category = categoryByLabel[record.label];
    const displayName = boundedText(record.displayName, record.displayName, 160);
    const quantity = nonNegativeInteger(record['数量'], 0, 1_000_000);
    if (quantity < 1) continue;
    const existing = existingByKey.get(`${category}\u0000${displayName}`);
    const description = record['描述'];
    const canonicalRef = typeof description === 'string'
      && description.startsWith('规范引用：')
      && description.slice('规范引用：'.length).length <= 160
      ? description.slice('规范引用：'.length)
      : (existing?.canonical_ref ?? null);
    const equippedSlot = category === 'EQUIPMENT'
      ? (equippedByName.get(displayName) ?? null)
      : null;
    const candidate = {
      item_id: existing?.item_id
        ?? stableImportedId('item:', { category, display_name: displayName }),
      version: existing?.version ?? 1,
      display_name: displayName,
      category,
      quantity,
      canonical_ref: canonicalRef,
      equipped_slot: equippedSlot
    };
    if (existing && canonicalStringify(candidate) !== canonicalStringify(existing)) {
      candidate.version = existing.version + 1;
    }
    entries.push(candidate);
  }
  entries.sort((left, right) => left.item_id.localeCompare(right.item_id));
  actor.equipment.entries = entries;
}

function overlayOwnerActor(state, ownerSeat, snapshot) {
  const actor = state.actors[ownerSeat];
  const nextProfile = {
    display_name: boundedText(snapshot['玩家·姓名'], actor.player.display_name, 80),
    rank: boundedText(
      snapshot['玩家·正式忍阶'] ?? snapshot['玩家·忍阶'],
      actor.player.rank,
      80
    ),
    goal: boundedText(snapshot['玩家·当前目标'], actor.player.goal, 1_000),
    alive: parseBoolean(snapshot['玩家·存活'], actor.player.alive)
  };
  nextProfile.status = nextProfile.alive
    ? (actor.player.status === 'DECEASED' ? 'ACTIVE' : actor.player.status)
    : 'DECEASED';
  if (Object.entries(nextProfile).some(([key, value]) => actor.player[key] !== value)) {
    actor.player = { ...actor.player, ...nextProfile, version: actor.player.version + 1 };
  }
  overlayResource(actor, snapshot, 'chakra', '属性·当前查克拉', '属性·查克拉');
  overlayResource(actor, snapshot, 'mental', '属性·当前精神力', '属性·精神力');
  overlayResource(actor, snapshot, 'vitality', '属性·当前生命力', '属性·生命力');
  overlayResource(actor, snapshot, 'stamina', '属性·当前体力', '属性·体力');
  overlayResource(actor, snapshot, 'money', '进度·金钱', null);
  const experience = nonNegativeInteger(snapshot['进度·经验'], actor.progression.experience);
  if (experience !== actor.progression.experience) {
    actor.progression.experience = experience;
    actor.progression.version += 1;
  }
  overlayOwnerSkills(actor, snapshot);
  overlayOwnerItems(actor, snapshot);
  const personal = snapshot._agent_memories?.multiplayer_personal;
  const shared = snapshot._agent_memories?.multiplayer_shared;
  if (personal?.schema === state.memories[`actor:${ownerSeat}`]?.schema
    && Array.isArray(personal.entries)) {
    state.memories[`actor:${ownerSeat}`] = clone(personal);
  }
  if (shared?.schema === state.memories.shared?.schema && Array.isArray(shared.entries)) {
    state.memories.shared = clone(shared);
  }
}

function matchingCompanion(snapshot, sourceEntityId) {
  const relationships = snapshot?._relationships;
  if (!relationships || typeof relationships !== 'object' || Array.isArray(relationships)) {
    return null;
  }
  for (const [displayName, value] of Object.entries(relationships)) {
    if (value?.multiplayer_companion?.room_actor_id === sourceEntityId) {
      return { display_name: displayName, value };
    }
  }
  return null;
}

function overlayGuestObservable(state, guestSlot, snapshot) {
  const guest = state.actors[guestSlot];
  const projection = snapshot?._multiplayer_projection?.counterpart;
  if (projection?.room_actor_id === guest.room_actor_id) {
    if (projection.public_profile && typeof projection.public_profile === 'object') {
      guest.player = { ...guest.player, ...clone(projection.public_profile) };
    }
    if (projection.observed_attributes?.schema === guest.attributes.schema) {
      guest.attributes = clone(projection.observed_attributes);
    }
    if (projection.observed_progression?.schema === guest.progression.schema) {
      guest.progression = clone(projection.observed_progression);
    }
  }
  const companion = matchingCompanion(snapshot, guest.room_actor_id);
  if (!companion) return;
  const observable = companion.value.multiplayer_companion;
  const displayName = boundedText(companion.display_name, guest.player.display_name, 80);
  const alive = typeof observable.alive === 'boolean' ? observable.alive : guest.player.alive;
  const status = alive
    ? boundedText(observable.status, guest.player.status, 80)
    : 'DECEASED';
  if (displayName !== guest.player.display_name
    || alive !== guest.player.alive
    || status !== guest.player.status) {
    guest.player = {
      ...guest.player,
      display_name: displayName,
      alive,
      status,
      version: guest.player.version + 1
    };
  }
  if (observable.observed_resources
    && typeof observable.observed_resources === 'object'
    && !Array.isArray(observable.observed_resources)) {
    for (const resource of guest.attributes.resources) {
      const observed = observable.observed_resources[resource.resource_id];
      if (!observed) continue;
      const maximum = nonNegativeInteger(observed.maximum, resource.maximum);
      const current = nonNegativeInteger(observed.current, resource.current, maximum);
      if (current !== resource.current || maximum !== resource.maximum) {
        resource.current = current;
        resource.maximum = maximum;
        resource.version += 1;
      }
    }
  }
  if (Array.isArray(observable.observed_injuries)) {
    guest.attributes.injuries = clone(observable.observed_injuries);
  }
  if (Array.isArray(observable.observed_statuses)) {
    guest.attributes.persistent_statuses = clone(observable.observed_statuses);
  }
  if (observable.observed_progression?.schema === guest.progression.schema) {
    guest.progression = clone(observable.observed_progression);
  }
}

function overlayWorld(state, ownerSeat, snapshot) {
  const displayDate = boundedText(
    snapshot['世界·时间'],
    state.shared_world.calendar.display_date,
    160
  );
  if (displayDate !== state.shared_world.calendar.display_date) {
    state.shared_world.calendar.display_date = displayDate;
    state.shared_world.calendar.version += 1;
  }
  const locationId = snapshot['世界·地点'];
  if (typeof locationId === 'string' && /^location:[A-Za-z0-9:_-]+$/u.test(locationId)) {
    const actorId = state.actors[ownerSeat].room_actor_id;
    const existing = state.shared_world.world_state.locations.find(item => (
      item.entity_id === actorId
    ));
    if (existing && existing.location_id !== locationId) {
      existing.location_id = locationId;
      existing.version += 1;
    } else if (!existing) {
      state.shared_world.world_state.locations.push({
        entity_id: actorId,
        version: 1,
        location_id: locationId
      });
    }
  }
}

function replaceActorReferences(value, replacements, key = '') {
  if (Array.isArray(value)) {
    if (/(?:^|_)actor_ids$/u.test(key)) {
      return value.map(item => replacements.get(item) ?? item);
    }
    return value.map(item => replaceActorReferences(item, replacements, key));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string'
      && /(?:^|_)actor_id$/u.test(key)
      && replacements.has(value)) {
      return replacements.get(value);
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    replaceActorReferences(child, replacements, childKey)
  ]));
}

function materializeBasis(document, selectedNode, authority) {
  const capsule = document.multiplayer_record_sidecar?.server_reimport_capsule;
  if (capsule?.schema !== SERVER_REIMPORT_CAPSULE_SCHEMA
    || capsule.inject_to_agent !== false
    || capsule.source_exporting_seat !== authority.owner_seat) {
    fail('SOURCE_IMPORT_CHANGED', 'source export has no compatible server reimport capsule');
  }
  let projected = clone(assertReducerDomainState(capsule.projection_basis));
  const sourceSlotByEntity = new Map(ROOM_SEATS.map(slot => [
    projected.actors[slot].room_actor_id,
    slot
  ]));
  const entryBySeat = Object.fromEntries(
    authority.actor_rebind_entries.map(entry => [entry.original_seat, entry])
  );
  for (const seat of ROOM_SEATS) {
    if (!entryBySeat[seat] || !sourceSlotByEntity.has(entryBySeat[seat].source_entity_id)) {
      fail(
        'RETURN_ACTOR_NOT_FOUND',
        'server reimport capsule is missing a bound original actor',
        { seat }
      );
    }
  }
  const ownerSlot = sourceSlotByEntity.get(entryBySeat[authority.owner_seat].source_entity_id);
  const guestSeat = authority.owner_seat === 'A' ? 'B' : 'A';
  const guestSlot = sourceSlotByEntity.get(entryBySeat[guestSeat].source_entity_id);
  overlayOwnerActor(projected, ownerSlot, selectedNode.state_snapshot);
  overlayGuestObservable(projected, guestSlot, selectedNode.state_snapshot);
  overlayWorld(projected, ownerSlot, selectedNode.state_snapshot);
  projected = clone(assertReducerDomainState(projected));
  const normalized = normalizeLatestSourcePrivacy(projected, {
    owner_seat: authority.owner_seat,
    guest_state_slot: guestSlot
  });

  const rebound = clone(normalized);
  const sourceMemory = clone(normalized.memories);
  const replacements = new Map();
  const actors = {};
  const actorMemories = {};
  for (const seat of ROOM_SEATS) {
    const entry = entryBySeat[seat];
    const sourceSlot = sourceSlotByEntity.get(entry.source_entity_id);
    actors[seat] = clone(normalized.actors[sourceSlot]);
    actors[seat].room_actor_id = entry.room_actor_id;
    actorMemories[seat] = clone(sourceMemory[`actor:${sourceSlot}`]);
    replacements.set(entry.source_entity_id, entry.room_actor_id);
  }
  rebound.actors = actors;
  rebound.memories['actor:A'] = actorMemories.A;
  rebound.memories['actor:B'] = actorMemories.B;
  rebound.meta.state_revision = authority.state_revision + 1;
  const replaced = replaceActorReferences(rebound, replacements);
  const genesis = clone(assertReducerDomainState(replaced));
  const actorControl = Object.fromEntries(
    ROOM_SEATS.map(seat => [seat, entryBySeat[seat].room_actor_id])
  );
  const rebindDiff = {
    schema: 'naruto.multiplayer-control-rebind-diff/v1',
    actor_rebinds: ROOM_SEATS.map(seat => ({
      original_seat: seat,
      source_entity_id: entryBySeat[seat].source_entity_id,
      room_actor_id: entryBySeat[seat].room_actor_id
    })),
    from_state_revision: projected.meta.state_revision,
    to_state_revision: authority.state_revision + 1
  };
  return Object.freeze({
    normalized_room_state: normalized,
    genesis_room_state: genesis,
    actor_control_by_seat: actorControl,
    source_actor_matches: document.multiplayer_record_sidecar.actor_bindings.map(entry => ({
      source_entity_id: entry.source_entity_id,
      opaque_binding_token: entry.opaque_binding_token
    })),
    rebind_diff: rebindDiff,
    normalized_source_hash: normalizedStateHash(normalized),
    normalization_and_rebind_diff_hash: hash(rebindDiff),
    genesis_state_hash: roomCheckpointStateHash(genesis, actorControl)
  });
}

function diffSections(seat, authority, basis) {
  const guest = authority.owner_seat === 'A' ? 'B' : 'A';
  const actorSummary = ROOM_SEATS.map(actorSeat => {
    const actor = basis.genesis_room_state.actors[actorSeat];
    const control = actorSeat === authority.owner_seat ? '来源所有者' : '原客方玩家';
    return `${control}继续控制绑定角色“${actor.player.display_name}”（${actor.player.status}）。`;
  }).join('');
  const sections = [
    {
      category: 'characters',
      entries: [{
        entry_id: `entry_characters_${seat}`,
        kind: 'result',
        summary: actorSummary
      }]
    },
    {
      category: 'actor_control_rebind',
      entries: [{
        entry_id: `entry_rebind_${seat}`,
        kind: 'result',
        summary: '两枚原房间角色绑定已形成唯一双射；控制权只重绑，不从旧检查点补状态。'
      }]
    },
    {
      category: 'privacy_normalization',
      entries: [{
        entry_id: `entry_privacy_${seat}`,
        kind: 'result',
        summary: '来源文件中的客方与 NPC 私有命名空间已按固定版本剥离。'
      }]
    },
    {
      category: 'continuity_losses',
      entries: [{
        entry_id: `entry_losses_${seat}`,
        kind: 'warning',
        summary: seat === guest
          ? '旧联机检查点中的客方私有记忆、隐藏物品与目标不会恢复；只继承 L2 可安全验证的经历。'
          : '旧联机检查点不会与所选 L2 自动合并；未进入来源分支的客方私有连续性不会恢复。'
      }]
    },
    {
      category: 'experience_summary',
      entries: [{
        entry_id: `entry_experience_${seat}`,
        kind: 'summary',
        summary: '新纪元将从所选单机节点的受众安全世界、角色状态与可验证经历开始。'
      }]
    }
  ];
  return sections;
}

function buildAudienceDiff({
  secret,
  seat,
  authority,
  sourceImportId,
  proposalId,
  proposalRevision,
  basis
}) {
  const unsigned = {
    schema: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
    proposal_id: proposalId,
    proposal_revision: proposalRevision,
    room_id: authority.room_id,
    lineage_id: authority.lineage_id,
    source_import_id: sourceImportId,
    audience: seat,
    audience_user_id: authority.members_by_seat[seat],
    audience_role: seat === authority.owner_seat ? 'source_owner' : 'guest',
    sections: diffSections(seat, authority, basis)
  };
  const projectionCommitment = hmac(secret, {
    schema: 'naruto.multiplayer-audience-safe-import-diff-commitment/v1',
    diff: unsigned
  });
  return assertAudienceSafeImportDiff({
    ...unsigned,
    projection_commitment: projectionCommitment,
    server_hmac_commitment: hmac(secret, {
      schema: 'naruto.multiplayer-audience-safe-import-diff-envelope/v1',
      diff: unsigned,
      projection_commitment: projectionCommitment
    })
  }, {
    expected_members_by_seat: authority.members_by_seat,
    origin_owner_user_id: authority.origin_owner_user_id
  });
}

function assertDependencies(dependencies) {
  const missing = [
    ['lineageRepository.bindings.resolveLatestSourcePair',
      dependencies.lineageRepository?.bindings?.resolveLatestSourcePair],
    ['lineageRepository.sourceImports.saveValidated',
      dependencies.lineageRepository?.sourceImports?.saveValidated],
    ['lineageRepository.sourceImports.getForMember',
      dependencies.lineageRepository?.sourceImports?.getForMember],
    ['snapshotStore.put', dependencies.snapshotStore?.put],
    ['codec.assertOutput', dependencies.codec?.assertOutput]
  ].filter(([, method]) => typeof method !== 'function').map(([name]) => name);
  if (missing.length > 0
    || typeof dependencies.commitmentSecret !== 'string'
    || !dependencies.commitmentSecret) {
    fail(
      'LATEST_SOURCE_IMPORT_CONFIGURATION_INVALID',
      'latest-source import dependencies are incomplete',
      { missing },
      500
    );
  }
}

export function createLatestSourceImportService(dependencies) {
  assertDependencies(dependencies);
  const {
    lineageRepository,
    snapshotStore,
    codec,
    commitmentSecret,
    clock = () => new Date().toISOString()
  } = dependencies;
  const inFlight = new Map();

  async function createPrepared(authenticatedUserId, input) {
    const document = await codec.assertOutput(input.source_document);
    if (document.schema !== PERSONAL_SINGLEPLAYER_TIMELINE_SCHEMA
      || document.codec !== MULTIPLAYER_TO_SINGLEPLAYER_CODEC) {
      fail('SOURCE_IMPORT_CHANGED', 'latest source uses an unsupported multiplayer export codec');
    }
    const metadata = document.multiplayer_export;
    const sidecar = document.multiplayer_record_sidecar;
    const activeMeta = document.meta?.value ?? document.meta;
    const branch = document.branches.find(item => item.id === input.source_branch_id);
    const selectedNode = document.nodes.find(item => item.id === input.source_node_id);
    if (!branch || !selectedNode
      || branch.head_node_id !== selectedNode.id
      || selectedNode.branch_id !== branch.id
      || activeMeta?.active_branch !== branch.id
      || activeMeta?.current_id !== selectedNode.id) {
      fail(
        'SOURCE_IMPORT_CHANGED',
        'latest-source branch and node must be the selected active branch head'
      );
    }
    const actorBindingMatches = sidecar.actor_bindings.map(entry => ({
      source_entity_id: identifier(entry.source_entity_id, 'source_entity_id'),
      opaque_binding_token: entry.opaque_binding_token
    }));
    const authority = await lineageRepository.bindings.resolveLatestSourcePair({
      authenticated_user_id: authenticatedUserId,
      room_id: identifier(metadata.room_id, 'multiplayer_export.room_id'),
      lineage_id: identifier(metadata.lineage_id, 'multiplayer_export.lineage_id'),
      checkpoint_id: identifier(metadata.checkpoint_id, 'multiplayer_export.checkpoint_id'),
      derived_from_export_id: identifier(metadata.export_id, 'multiplayer_export.export_id'),
      exporting_seat: metadata.exporting_seat,
      actor_binding_matches: actorBindingMatches
    });
    const nextRevision = authority.state_revision + 1;
    integer(nextRevision, 'next_state_revision', { min: 1 });
    const basis = materializeBasis(document, selectedNode, authority);
    const identityDigest = sha256Hex({
      schema: 'naruto.multiplayer-latest-source-import-identity/v1',
      authenticated_user_id: authenticatedUserId,
      idempotency_key: input.idempotency_key
    });
    const sourceImportId = `source_import_${identityDigest.slice(0, 40)}`;
    const snapshotRef = `latest_snapshot_${identityDigest.slice(8, 48)}`;
    let existingImport = null;
    try {
      existingImport = await lineageRepository.sourceImports.getForMember({
        authenticated_user_id: authenticatedUserId,
        room_id: authority.room_id,
        source_import_id: sourceImportId
      });
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'SOURCE_IMPORT_NOT_FOUND') throw error;
    }
    if (existingImport
      && (existingImport.proposal_id !== input.proposal_id
        || existingImport.proposal_revision !== input.proposal_revision
        || existingImport.source?.source_save_id !== input.source_save_id
        || existingImport.source?.client_save_instance_id !== input.client_save_instance_id
        || existingImport.source?.source_branch_id !== input.source_branch_id
        || existingImport.source?.source_node_id !== input.source_node_id
        || existingImport.source?.derived_from_export_id !== metadata.export_id)) {
      fail('SOURCE_IMPORT_CHANGED', 'latest-source idempotency identity changed', {}, 409);
    }
    const importedAt = existingImport?.imported_at ?? clock();
    if (typeof importedAt !== 'string' || !Number.isFinite(Date.parse(importedAt))) {
      fail('LATEST_SOURCE_IMPORT_CONFIGURATION_INVALID', 'clock returned an invalid timestamp', {}, 500);
    }
    const rawSourceHash = hash(document);
    const selectedStateHash = hash(selectedNode.state_snapshot);
    const audienceDiffs = Object.fromEntries(ROOM_SEATS.map(seat => [seat, buildAudienceDiff({
      secret: commitmentSecret,
      seat,
      authority,
      sourceImportId,
      proposalId: input.proposal_id,
      proposalRevision: input.proposal_revision,
      basis
    })]));
    const unsignedSourceImport = {
      schema: SOURCE_IMPORT_SCHEMA,
      source_import_id: sourceImportId,
      room_id: authority.room_id,
      lineage_id: authority.lineage_id,
      origin_owner_user_id: authority.origin_owner_user_id,
      source_save_id: input.source_save_id,
      client_save_instance_id: input.client_save_instance_id,
      source_branch_id: input.source_branch_id,
      source_node_id: input.source_node_id,
      cloud_revision: input.cloud_revision,
      canonical_content_hash: rawSourceHash,
      selected_state_hash: selectedStateHash,
      raw_source_hash: rawSourceHash,
      normalized_source_hash: basis.normalized_source_hash,
      normalization_and_rebind_diff_hash: basis.normalization_and_rebind_diff_hash,
      genesis_state_hash: basis.genesis_state_hash,
      privacy_normalizer_version: LATEST_SOURCE_PRIVACY_NORMALIZER_VERSION,
      derived_from_export_id: metadata.export_id,
      audience_diff_commitments: {
        A: audienceDiffs.A.projection_commitment,
        B: audienceDiffs.B.projection_commitment
      },
      imported_at: importedAt
    };
    const sourceImport = assertSourceImport({
      ...unsignedSourceImport,
      server_hmac_commitment: hmac(commitmentSecret, {
        schema: 'naruto.multiplayer-source-import-envelope/v1',
        source_import: unsignedSourceImport
      })
    }, {
      authenticated_user_id: authenticatedUserId,
      origin_owner_user_id: authority.origin_owner_user_id
    });
    const { imported_at: _importedAt, ...stableSourceImport } = unsignedSourceImport;
    const snapshotRequestHash = hash({
      schema: 'naruto.multiplayer-latest-source-snapshot-request/v1',
      authenticated_user_id: authenticatedUserId,
      request: input,
      source_import: stableSourceImport,
      rebind_diff: basis.rebind_diff
    });
    await snapshotStore.put({
      snapshot_ref: snapshotRef,
      source_import_id: sourceImportId,
      room_id: authority.room_id,
      lineage_id: authority.lineage_id,
      owner_user_id: authenticatedUserId,
      source_save_id: input.source_save_id,
      client_save_instance_id: input.client_save_instance_id,
      source_branch_id: input.source_branch_id,
      source_node_id: input.source_node_id,
      cloud_revision: input.cloud_revision,
      derived_from_export_id: metadata.export_id,
      request_hash: snapshotRequestHash,
      raw_source_hash: rawSourceHash,
      normalized_source_hash: basis.normalized_source_hash,
      normalization_and_rebind_diff_hash: basis.normalization_and_rebind_diff_hash,
      genesis_state_hash: basis.genesis_state_hash,
      raw_source_document: document,
      normalized_room_state: basis.normalized_room_state,
      genesis_room_state: basis.genesis_room_state,
      actor_control_by_seat: basis.actor_control_by_seat,
      rebind_diff: basis.rebind_diff
    });
    const saved = await lineageRepository.sourceImports.saveValidated({
      authenticated_user_id: authenticatedUserId,
      room_id: authority.room_id,
      source_import: sourceImport,
      audience_diffs: audienceDiffs,
      actor_binding_matches: basis.source_actor_matches,
      validation_result: {
        valid: true,
        normalizer: LATEST_SOURCE_PRIVACY_NORMALIZER_VERSION,
        private_namespaces_removed: true,
        actor_binding_bijection: true,
        source_export_authenticated: true
      },
      source_snapshot_ref: snapshotRef
    });
    return Object.freeze({
      import: Object.freeze({
        import_kind: LATEST_SOURCE_SAVE_IMPORT_KIND,
        source_import_id: sourceImportId,
        room_id: authority.room_id,
        proposal_id: input.proposal_id,
        proposal_revision: input.proposal_revision,
        audience_diff_commitment: audienceDiffs[authority.owner_seat].projection_commitment,
        expected_control_revision: authority.control_revision,
        status: 'VALID'
      }),
      replayed: saved.replayed === true
    });
  }

  function create(contextValue) {
    const authenticatedUserId = principal(contextValue?.authenticated_user_id);
    const input = request(contextValue?.request);
    const key = `${authenticatedUserId}\u0000${input.idempotency_key}`;
    const existing = inFlight.get(key);
    const inputHash = hash(input);
    if (existing) {
      if (existing.input_hash !== inputHash) {
        return Promise.reject(new DomainError(
          'IDEMPOTENCY_KEY_REUSED',
          'latest-source idempotency key was reused with another request',
          {},
          { status: 409 }
        ));
      }
      return existing.operation;
    }
    const operation = createPrepared(authenticatedUserId, input)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, { input_hash: inputHash, operation });
    return operation;
  }

  return Object.freeze({ create });
}

/** Reuses POST /save-imports without changing the route or legacy genesis contract. */
export function createCompositeSaveImportService({
  genesisSaveImports,
  latestSourceImports
}) {
  if (typeof genesisSaveImports?.create !== 'function'
    || typeof latestSourceImports?.create !== 'function') {
    fail(
      'LATEST_SOURCE_IMPORT_CONFIGURATION_INVALID',
      'both genesis and latest-source save import services are required',
      {},
      500
    );
  }
  return Object.freeze({
    create(context) {
      return context?.request?.import_kind === LATEST_SOURCE_SAVE_IMPORT_KIND
        ? latestSourceImports.create(context)
        : genesisSaveImports.create(context);
    }
  });
}

export { materializeBasis as materializeLatestSourceBasis };
