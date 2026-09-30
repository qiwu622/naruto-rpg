import {
  PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA,
  assertOriginalActorBindingBijection,
  assertPersonalSingleplayerExport,
  assertRoomCheckpoint
} from '../contracts/lineage-contracts.js';
import {
  assertJsonSafe,
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { projectPersonalRoomState } from '../domain/lineage.js';
import { assertReducerDomainState } from '../domain/reducers/index.js';
import {
  assertTimelineSave,
  sanitizeTimelinePersistenceValue
} from '../../../js/core/timeline-save-schema.js';

export const MULTIPLAYER_TO_SINGLEPLAYER_CODEC =
  'naruto.multiplayer-to-singleplayer/v1';
export const PERSONAL_SINGLEPLAYER_TIMELINE_SCHEMA =
  'naruto.multiplayer-personal-timeline/v1';
export const MULTIPLAYER_RECORD_SIDECAR_SCHEMA =
  'naruto.multiplayer-record-sidecar/v1';
export const SERVER_REIMPORT_CAPSULE_SCHEMA =
  'naruto.multiplayer-server-reimport-capsule/v1';

const ROOM_SEATS = Object.freeze(['A', 'B']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SOURCE_NODE_KEYS = Object.freeze([
  'id',
  'parent_id',
  'children_ids',
  'branch_id',
  'turn_number',
  'depth',
  'real_timestamp',
  'game_time',
  'player_input',
  'ai_response_summary',
  'clean_response',
  'state_snapshot',
  'continuity_delta',
  'continuity_revision',
  'shinobi_daily',
  'summary',
  'tags',
  'is_checkpoint',
  'created_at',
  'accessed_count',
  'archived',
  'archived_at'
]);

function fail(code, message, details = {}, status = 400, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function object(value, label) {
  const prototype = value && typeof value === 'object'
    ? Object.getPrototypeOf(value)
    : undefined;
  if (!value || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', `${label} must be a plain object`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string'
    || !/^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u.test(value)) {
    fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', `${label} must be a valid identifier`, {
      field: label
    });
  }
  return value;
}

function principal(value, label) {
  if (typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u.test(value)) {
    fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', `${label} must be a valid principal`, {
      field: label
    });
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', `${label} must be an ISO timestamp`, {
      field: label
    });
  }
  return value;
}

function seat(value, label = 'exporting_seat') {
  if (!ROOM_SEATS.includes(value)) {
    fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', `${label} must be A or B`);
  }
  return value;
}

function oppositeSeat(value) {
  return value === 'A' ? 'B' : 'A';
}

function immutable(value) {
  return freezeDeep(canonicalizeJson(value));
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function outputHash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function compactText(value, max = 200) {
  const text = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function displayName(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return !text || DANGEROUS_KEYS.has(text) ? fallback : text;
}

function canonicalText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return canonicalStringify(value);
}

function resourceById(actor, resourceId) {
  return actor.attributes.resources.find(resource => resource.resource_id === resourceId) ?? null;
}

function assignResource(snapshot, actor, resourceId, currentKey, maximumKey) {
  const resource = resourceById(actor, resourceId);
  if (!resource) return;
  if (maximumKey) snapshot[maximumKey] = resource.maximum;
  if (currentKey) snapshot[currentKey] = resource.current;
}

function addSkills(snapshot, actor) {
  const categories = {
    NINJUTSU: '忍术',
    TAIJUTSU: '体术',
    GENJUTSU: '幻术',
    OTHER: '支援'
  };
  for (const skill of actor.skills.entries) {
    if (skill.category === 'BLOODLINE') {
      const prefix = `技能·血继限界·${skill.display_name}`;
      snapshot[`${prefix}·名称`] = skill.display_name;
      snapshot[`${prefix}·等级`] = skill.rank;
      snapshot[`${prefix}·熟练度`] = skill.mastery;
      if (skill.canonical_ref !== null) snapshot[`${prefix}·数据库ID`] = skill.canonical_ref;
      continue;
    }
    const category = categories[skill.category] ?? '支援';
    const prefix = `技能·${category}·${skill.display_name}`;
    snapshot[`${prefix}·名称`] = skill.display_name;
    snapshot[`${prefix}·等级`] = skill.rank;
    snapshot[`${prefix}·熟练度`] = skill.mastery;
    if (skill.canonical_ref !== null) snapshot[`${prefix}·数据库ID`] = skill.canonical_ref;
  }
}

function addItems(snapshot, actor) {
  const categories = {
    CONSUMABLE: '消耗品',
    EQUIPMENT: '装备',
    MATERIAL: '素材',
    KEY: '关键'
  };
  const slots = {
    weapon: '武器',
    armor: '防具',
    accessory: '饰品1',
    tool: '饰品2'
  };
  for (const item of actor.equipment.entries) {
    const category = categories[item.category] ?? '道具';
    snapshot[`物品·${category}·${item.display_name}·数量`] = item.quantity;
    if (item.canonical_ref !== null) {
      snapshot[`物品·${category}·${item.display_name}·描述`] =
        `规范引用：${item.canonical_ref}`;
    }
    if (item.equipped_slot !== null && slots[item.equipped_slot]) {
      snapshot[`物品·已装备·${slots[item.equipped_slot]}`] = item.display_name;
    }
  }
}

function missionView(entry) {
  return {
    id: entry.mission_id,
    title: entry.title,
    status: entry.status.toLowerCase(),
    progress: entry.progress_current,
    progress_total: entry.progress_total,
    scope: entry.scope,
    assignee_actor_ids: [...entry.assignee_actor_ids]
  };
}

function missionState(projected, exportingSeat) {
  const all = [
    ...projected.shared_world.shared_missions.entries,
    ...projected.actors[exportingSeat].missions.entries
  ];
  const result = {
    active: {},
    available: {},
    completed: {},
    failed: {},
    log: {},
    stats: {
      total_done: 0,
      d_rank: 0,
      c_rank: 0,
      b_rank: 0,
      a_rank: 0,
      s_rank: 0
    }
  };
  for (const entry of all) {
    const view = missionView(entry);
    if (entry.status === 'COMPLETED') {
      result.completed[entry.mission_id] = view;
      result.stats.total_done += 1;
    } else if (['FAILED', 'ABANDONED'].includes(entry.status)) {
      result.failed[entry.mission_id] = view;
    } else if (entry.status === 'OFFERED') {
      result.available[entry.mission_id] = view;
    } else {
      result.active[entry.mission_id] = view;
    }
  }
  return result;
}

function publicNpcProfiles(projected) {
  return projected.shared_world.world_state.npc_profiles.map(profile => ({
    npc_id: profile.npc_id,
    display_name: profile.display_name,
    faction: profile.faction,
    rank: profile.rank,
    public_status: profile.public_status
  }));
}

function publicCombats(projected) {
  return projected.shared_world.shared_combat.entries.map(combat => ({
    combat_id: combat.combat_id,
    phase: combat.phase,
    participants: combat.participants.map(participant => ({ ...participant })),
    winner_ids: [...combat.winner_ids],
    resolution_summary: combat.resolution_summary
  }));
}

function relationshipProjection(projected, exportingSeat) {
  const exporterId = projected.actors[exportingSeat].room_actor_id;
  return projected.relationships
    .filter(edge => edge.source_actor_id === exporterId)
    .map(edge => ({
      edge_id: edge.edge_id,
      target_actor_id: edge.target_actor_id,
      kind: edge.data.kind,
      score: edge.data.score,
      label: edge.data.label,
      target_display_name: edge.data.target_display_name
    }));
}

function companionRelationship(projected, exportingSeat) {
  const counterpartSeat = oppositeSeat(exportingSeat);
  const exporterId = projected.actors[exportingSeat].room_actor_id;
  const counterpart = projected.actors[counterpartSeat];
  const edge = projected.relationships.find(item => (
    item.source_actor_id === exporterId
      && item.target_actor_id === counterpart.room_actor_id
  ));
  const name = displayName(
    counterpart.player.display_name,
    `联机同伴-${counterpart.room_actor_id}`
  );
  const resources = Object.fromEntries(counterpart.attributes.resources.map(resource => [
    resource.resource_id,
    { current: resource.current, maximum: resource.maximum }
  ]));
  return {
    name,
    value: {
      affection: edge?.data.kind === 'AFFECTION' ? edge.data.score : 0,
      trust: edge?.data.kind === 'TRUST' ? edge.data.score : 0,
      respect: edge?.data.kind === 'RESPECT' ? edge.data.score : 0,
      info: edge?.data.label || '原联机玩家角色，现作为 NPC/同伴继续存在。',
      history: [],
      inner_thoughts: [],
      combatant: true,
      combat_stats: {
        rank: counterpart.player.rank || '',
        chakra_nature: [],
        jutsu: []
      },
      multiplayer_companion: {
        room_actor_id: counterpart.room_actor_id,
        alive: counterpart.player.alive,
        status: counterpart.player.status,
        observed_resources: resources,
        observed_injuries: counterpart.attributes.injuries,
        observed_statuses: counterpart.attributes.persistent_statuses,
        observed_progression: counterpart.progression
      }
    }
  };
}

function singleplayerState(projectedValue, exportingSeat, nodeId, branchId, turnNumber) {
  const projected = projectPersonalRoomState(projectedValue, exportingSeat);
  const player = projected.actors[exportingSeat];
  const counterpartSeat = oppositeSeat(exportingSeat);
  const counterpart = projected.actors[counterpartSeat];
  const companion = companionRelationship(projected, exportingSeat);
  const snapshot = {
    _version: '5.0',
    _resource_model_version: 1,
    _meta: {
      current_node_id: nodeId,
      active_branch: branchId
    },
    '玩家·姓名': player.player.display_name,
    '玩家·忍阶': player.player.rank,
    '玩家·正式忍阶': player.player.rank,
    '玩家·当前目标': player.player.goal,
    '玩家·存活': player.player.alive ? '是' : '否',
    '进度·经验': player.progression.experience,
    '进度·称号': player.progression.titles.map(item => item.display_name).join('，'),
    '进度·成就': player.progression.achievements.map(item => item.display_name).join('，'),
    '世界·时间': projected.shared_world.calendar.display_date,
    '世界·天气': projected.shared_world.world_state.weather
      .map(item => item.weather_code)
      .join('，'),
    '系统·回合数': turnNumber,
    _missions: missionState(projected, exportingSeat),
    _relationships: {
      [companion.name]: companion.value
    },
    _memory: {
      pins: '',
      facts: canonicalText(player.private_knowledge),
      clues: '',
      long_term: canonicalText({
        shared: projected.memories.shared,
        personal: projected.memories[`actor:${exportingSeat}`]
      }),
      archived: '',
      recent_summary: '',
      turn_summaries: '',
      compressed_summary: '',
      compression_count: 0,
      important_events: '',
      npc_notes: '',
      meta: {
        updated_at: null,
        sources: { multiplayer_export: true }
      }
    },
    _map: {
      known_locations: Object.fromEntries(
        projected.shared_world.map.markers
          .filter(marker => marker.visible)
          .map(marker => [marker.location_id, marker.label])
      ),
      active_pins: ''
    },
    _agent_memories: {
      multiplayer_shared: projected.memories.shared,
      multiplayer_personal: projected.memories[`actor:${exportingSeat}`]
    },
    _combat: null,
    _opening_contract: null,
    _multiplayer_projection: {
      schema: 'naruto.multiplayer-singleplayer-state-projection/v1',
      player_room_actor_id: player.room_actor_id,
      counterpart: {
        room_actor_id: counterpart.room_actor_id,
        role: 'npc_or_companion',
        public_profile: counterpart.player,
        observed_attributes: counterpart.attributes,
        observed_progression: counterpart.progression
      },
      shared_world: {
        calendar: projected.shared_world.calendar,
        locations: projected.shared_world.world_state.locations,
        weather: projected.shared_world.world_state.weather,
        flags: projected.shared_world.world_state.flags,
        npc_profiles: publicNpcProfiles(projected),
        map: projected.shared_world.map,
        missions: projected.shared_world.shared_missions,
        combats: publicCombats(projected)
      },
      relationships: relationshipProjection(projected, exportingSeat),
      player_progression: player.progression
    }
  };
  assignResource(snapshot, player, 'chakra', '属性·当前查克拉', '属性·查克拉');
  assignResource(snapshot, player, 'mental', '属性·当前精神力', '属性·精神力');
  assignResource(snapshot, player, 'vitality', '属性·当前生命力', '属性·生命力');
  assignResource(snapshot, player, 'stamina', '属性·当前体力', '属性·体力');
  const money = resourceById(player, 'money');
  if (money) snapshot['进度·金钱'] = money.current;
  const location = projected.shared_world.world_state.locations.find(
    entry => entry.entity_id === player.room_actor_id
  );
  if (location) snapshot['世界·地点'] = location.location_id;
  addSkills(snapshot, player);
  addItems(snapshot, player);
  return sanitizeTimelinePersistenceValue(snapshot, 'singleplayer_state');
}

function sourceMeta(timeline) {
  return timeline.meta?.value ?? timeline.timeline?.meta ?? timeline.meta;
}

function cleanSourceTimeline(sourceValue, expected) {
  const source = canonicalizeJson(sourceValue);
  try {
    assertTimelineSave(source);
  } catch (error) {
    fail(
      'SOURCE_OWNER_TIMELINE_INVALID',
      'source owner timeline failed the existing timeline constraints',
      {},
      409,
      error
    );
  }
  const meta = sourceMeta(source);
  const sourceNode = source.nodes.find(node => node.id === expected.source_node_id);
  const sourceBranch = source.branches.find(branch => branch.id === expected.source_branch_id);
  if (!sourceNode || !sourceBranch
    || sourceNode.branch_id !== sourceBranch.id
    || sourceBranch.head_node_id !== sourceNode.id
    || meta.current_id !== sourceNode.id
    || meta.active_branch !== sourceBranch.id) {
    fail(
      'SOURCE_OWNER_TIMELINE_CHANGED',
      'source timeline no longer points at the imported branch head',
      {
        source_branch_id: expected.source_branch_id,
        source_node_id: expected.source_node_id
      },
      409
    );
  }
  const nodes = source.nodes.map(node => {
    const result = {};
    for (const key of SOURCE_NODE_KEYS) {
      if (own(node, key)) result[key] = node[key];
    }
    return result;
  });
  const branches = source.branches.map(branch => ({ ...branch, is_active: false }));
  return {
    export_version: source.export_version ?? '2.0',
    include_archive: source.include_archive === true,
    nodes,
    branches,
    meta: {
      key: 'root',
      value: { ...meta }
    },
    selected_node_id: sourceNode.id
  };
}

function normalizeInput(inputValue) {
  assertJsonSafe(inputValue, { maxDepth: 96, maxNodes: 750_000 });
  const input = object(inputValue, 'codec input');
  const room = object(input.room, 'room');
  const exportingSeat = seat(input.exporting_seat);
  const members = object(input.members_by_seat, 'members_by_seat');
  principal(members.A, 'members_by_seat.A');
  principal(members.B, 'members_by_seat.B');
  if (members.A === members.B) {
    fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', 'room members must be distinct');
  }
  const exportingUserId = principal(
    input.exporting_member_user_id,
    'exporting_member_user_id'
  );
  if (members[exportingSeat] !== exportingUserId) {
    fail('SOURCE_OWNER_REQUIRED', 'exporting seat must be derived from authenticated membership', {}, 403);
  }
  if (room.origin_type !== 'existing_save_derived') {
    fail(
      'PLAYABLE_EXPORT_NOT_ALLOWED',
      'new_multiplayer_save cannot produce a playable singleplayer export'
    );
  }
  const bindings = assertOriginalActorBindingBijection(input.actor_bindings, {
    lineage_id: identifier(room.lineage_id, 'room.lineage_id'),
    expected_members_by_seat: members
  });
  if (!Array.isArray(input.checkpoint_chain) || input.checkpoint_chain.length < 1) {
    fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', 'checkpoint_chain must contain a genesis');
  }
  const chain = input.checkpoint_chain.map((entryValue, index) => {
    const entry = object(entryValue, `checkpoint_chain[${index}]`);
    const checkpoint = assertRoomCheckpoint(entry.checkpoint);
    if (checkpoint.room_id !== room.room_id || checkpoint.lineage_id !== room.lineage_id) {
      fail('CHECKPOINT_NOT_COMMITTED', 'checkpoint chain crosses a Room lineage boundary');
    }
    if (index === 0 && checkpoint.kind !== 'genesis') {
      fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', 'checkpoint chain must start at a genesis');
    }
    if (checkpoint.kind === 'genesis') {
      if (entry.actions !== null || entry.narrative !== null) {
        fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', 'genesis cannot carry turn content');
      }
    } else {
      object(entry.actions, `checkpoint_chain[${index}].actions`);
      for (const roomSeat of ROOM_SEATS) {
        if (typeof entry.actions[roomSeat]?.text !== 'string'
          || (roomSeat === exportingSeat
            ? entry.actions[roomSeat].disclosure !== 'owner'
            : entry.actions[roomSeat].disclosure !== 'full_after_commit')) {
          fail(
            'ACTION_DISCLOSURE_CONSISTENCY_FAULT',
            'export requires the owner action and committed counterpart disclosure'
          );
        }
      }
      const narrative = object(entry.narrative, `checkpoint_chain[${index}].narrative`);
      const expectedAudience = narrative.mode === 'shared' ? 'shared' : exportingSeat;
      if (!['shared', 'dual_pov'].includes(narrative.mode)
        || narrative.audience !== expectedAudience
        || typeof narrative.text !== 'string'
        || !narrative.text.trim()) {
        fail(
          'NARRATIVE_DELIVERY_CORRUPT',
          'export narrative is not the authenticated member delivery'
        );
      }
    }
    return {
      checkpoint,
      state: entry.state,
      actions: entry.actions,
      narrative: entry.narrative
    };
  });
  return {
    input,
    room,
    members,
    exportingSeat,
    exportingUserId,
    bindingsBySeat: bindings.bindings_by_seat,
    chain
  };
}

function buildTimeline(normalized) {
  const {
    input,
    room,
    exportingSeat,
    chain
  } = normalized;
  const exportingIsOwner = normalized.exportingUserId === room.origin_owner_user_id;
  let source;
  if (exportingIsOwner) {
    if (!input.source_owner_timeline) {
      fail(
        'SOURCE_OWNER_TIMELINE_UNAVAILABLE',
        'source owner export requires the authenticated imported source timeline',
        {},
        409
      );
    }
    source = cleanSourceTimeline(input.source_owner_timeline.timeline, {
      source_branch_id: input.source_owner_timeline.source_branch_id,
      source_node_id: input.source_owner_timeline.source_node_id
    });
  } else {
    if (input.source_owner_timeline !== null && input.source_owner_timeline !== undefined) {
      fail(
        'GUEST_PRIVATE_DATA_FORBIDDEN',
        'guest export must not receive the source owner timeline',
        {},
        403
      );
    }
    source = {
      export_version: '2.0',
      include_archive: false,
      nodes: [],
      branches: [],
      meta: null,
      selected_node_id: null
    };
  }

  const exportId = identifier(input.export_id, 'export_id');
  const branchId = `branch_mpx_${sha256Hex(`${exportId}:${exportingSeat}`).slice(0, 32)}`;
  const existingIds = new Set(source.nodes.map(node => node.id));
  const newNodeIds = chain.map(entry => (
    `node_mpx_${sha256Hex(`${exportId}:${entry.checkpoint.checkpoint_id}:${exportingSeat}`)
      .slice(0, 32)}`
  ));
  if (existingIds.has(branchId)
    || newNodeIds.some(nodeId => existingIds.has(nodeId))
    || new Set(newNodeIds).size !== newNodeIds.length
    || source.branches.some(branch => branch.id === branchId)) {
    fail('SINGLEPLAYER_EXPORT_ID_COLLISION', 'deterministic export timeline ID collided');
  }

  const sourceParent = source.selected_node_id === null
    ? null
    : source.nodes.find(node => node.id === source.selected_node_id);
  if (source.selected_node_id !== null && !sourceParent) {
    fail('SOURCE_OWNER_TIMELINE_CHANGED', 'selected source node disappeared');
  }
  const baseTurn = Number.isInteger(sourceParent?.turn_number)
    ? sourceParent.turn_number
    : 0;
  const baseDepth = Number.isInteger(sourceParent?.depth)
    ? sourceParent.depth
    : -1;
  const nodes = chain.map((entry, index) => {
    const nodeId = newNodeIds[index];
    const parentId = index === 0 ? source.selected_node_id : newNodeIds[index - 1];
    const turnNumber = baseTurn + index + (sourceParent === null ? 0 : 1);
    const state = singleplayerState(
      entry.state,
      exportingSeat,
      nodeId,
      branchId,
      turnNumber
    );
    const genesis = entry.checkpoint.kind === 'genesis';
    const response = genesis ? '' : entry.narrative.text;
    return {
      id: nodeId,
      parent_id: parentId,
      children_ids: index + 1 < newNodeIds.length ? [newNodeIds[index + 1]] : [],
      branch_id: branchId,
      turn_number: turnNumber,
      depth: baseDepth + index + 1,
      real_timestamp: Date.parse(entry.checkpoint.created_at),
      game_time: state['世界·时间'] || '',
      player_input: genesis ? '(联机存档起点)' : entry.actions[exportingSeat].text,
      ai_response_summary: genesis ? '联机存档起点' : compactText(response),
      clean_response: response,
      state_snapshot: state,
      summary: genesis ? '联机存档起点' : compactText(response),
      tags: genesis ? ['联机起点'] : ['联机回合'],
      is_checkpoint: true,
      created_at: Date.parse(entry.checkpoint.created_at),
      accessed_count: 0,
      archived: false,
      archived_at: null
    };
  });
  if (sourceParent) {
    const childIds = Array.isArray(sourceParent.children_ids)
      ? sourceParent.children_ids
      : [];
    sourceParent.children_ids = [...new Set([...childIds, newNodeIds[0]])];
  }
  const allNodes = [...source.nodes, ...nodes];
  const root = allNodes.find(node => node.parent_id === null);
  if (!root) fail('SINGLEPLAYER_EXPORT_CODEC_INVALID', 'export timeline has no root');
  const branch = {
    id: branchId,
    name: '联机个人分支',
    color: '#5c8ee6',
    description: `从联机检查点 ${chain.at(-1).checkpoint.checkpoint_id} 导出`,
    created_at: Date.parse(timestamp(input.created_at, 'created_at')),
    diverged_from: source.selected_node_id,
    diverged_at_turn: sourceParent?.turn_number ?? null,
    head_node_id: newNodeIds.at(-1),
    node_count: nodes.length,
    is_active: true
  };
  const timeline = {
    export_version: '2.0',
    exported_at: input.created_at,
    include_archive: source.include_archive,
    nodes: allNodes,
    branches: [...source.branches, branch],
    meta: {
      key: 'root',
      value: {
        root_id: root.id,
        current_id: newNodeIds.at(-1),
        active_branch: branchId,
        total_nodes: allNodes.length
      }
    }
  };
  return { timeline, newNodeIds, branchId };
}

function buildSidecar(normalized) {
  const counterpartSeat = oppositeSeat(normalized.exportingSeat);
  const actorBindings = ROOM_SEATS.map(roomSeat => ({
    source_entity_id: normalized.bindingsBySeat[roomSeat].room_actor_id,
    export_role: roomSeat === normalized.exportingSeat ? 'player' : 'npc_or_companion',
    opaque_binding_token: normalized.bindingsBySeat[roomSeat].opaque_binding_token,
    inject_to_agent: false
  }));
  const multiplayerRecords = normalized.chain
    .filter(entry => entry.checkpoint.kind === 'turn_commit')
    .map(entry => ({
      turn_id: entry.checkpoint.turn_id,
      counterpart_seat: counterpartSeat,
      counterpart_action_text: entry.actions[counterpartSeat].text,
      disclosure: 'full_after_commit',
      inject_to_agent: false
    }));
  const head = normalized.chain.at(-1);
  const reimportProjection = canonicalizeJson(
    projectPersonalRoomState(head.state, normalized.exportingSeat)
  );
  // The audience projector removes the counterpart's private goal. Reducer
  // state requires the fixed profile key, so the server-only reimport basis
  // carries a non-secret sentinel instead of restoring the hidden value.
  reimportProjection.actors[counterpartSeat].player.goal = '（未公开）';
  assertReducerDomainState(reimportProjection);
  return {
    schema: MULTIPLAYER_RECORD_SIDECAR_SCHEMA,
    inject_to_agent: false,
    actor_bindings: actorBindings,
    multiplayer_records: multiplayerRecords,
    counterpart_private_pov_included: false,
    server_reimport_capsule: {
      schema: SERVER_REIMPORT_CAPSULE_SCHEMA,
      inject_to_agent: false,
      source_checkpoint_id: head.checkpoint.checkpoint_id,
      source_exporting_seat: normalized.exportingSeat,
      projection_basis: reimportProjection
    }
  };
}

function assertNoSecretResidue(content, normalized) {
  const agentPayload = canonicalStringify({
    nodes: content.nodes,
    branches: content.branches,
    meta: content.meta
  });
  for (const binding of content.multiplayer_record_sidecar.actor_bindings) {
    if (agentPayload.includes(binding.opaque_binding_token)) {
      fail(
        'RETURN_ACTOR_BINDING_INVALID',
        'opaque actor binding token leaked into Agent-visible timeline content'
      );
    }
  }
  const exportedNodes = content.multiplayer_export.multiplayer_node_ids
    .map(nodeId => content.nodes.find(node => node.id === nodeId));
  for (let index = 0; index < normalized.chain.length; index += 1) {
    const entry = normalized.chain[index];
    const node = exportedNodes[index];
    if (!node) {
      fail('SINGLEPLAYER_EXPORT_CONTENT_CORRUPT', 'exported multiplayer node is missing');
    }
    const expectedInput = entry.checkpoint.kind === 'genesis'
      ? '(联机存档起点)'
      : entry.actions[normalized.exportingSeat].text;
    if (node.player_input !== expectedInput) {
      fail(
        'GUEST_PRIVATE_DATA_FORBIDDEN',
        'Agent-visible player_input is not the exporting member action'
      );
    }
  }
}

function assertSidecar(content) {
  const sidecar = object(content.multiplayer_record_sidecar, 'multiplayer_record_sidecar');
  if (sidecar.schema !== MULTIPLAYER_RECORD_SIDECAR_SCHEMA
    || sidecar.inject_to_agent !== false
    || sidecar.counterpart_private_pov_included !== false
    || !Array.isArray(sidecar.actor_bindings)
    || sidecar.actor_bindings.length !== 2
    || !Array.isArray(sidecar.multiplayer_records)) {
    fail('SINGLEPLAYER_EXPORT_CONTENT_CORRUPT', 'multiplayer sidecar is invalid', {}, 500);
  }
  const capsule = object(sidecar.server_reimport_capsule, 'server_reimport_capsule');
  if (capsule.schema !== SERVER_REIMPORT_CAPSULE_SCHEMA
    || capsule.inject_to_agent !== false
    || !ROOM_SEATS.includes(capsule.source_exporting_seat)
    || capsule.source_checkpoint_id !== content.multiplayer_export?.checkpoint_id) {
    fail('SINGLEPLAYER_EXPORT_CONTENT_CORRUPT', 'server reimport capsule is invalid', {}, 500);
  }
  const basis = assertReducerDomainState(capsule.projection_basis);
  const tokens = new Set();
  const entities = new Set();
  for (const entryValue of sidecar.actor_bindings) {
    const entry = object(entryValue, 'actor binding sidecar entry');
    identifier(entry.source_entity_id, 'source_entity_id');
    if (!['player', 'npc_or_companion'].includes(entry.export_role)
      || typeof entry.opaque_binding_token !== 'string'
      || entry.opaque_binding_token.length < 16
      || entry.inject_to_agent !== false) {
      fail('RETURN_ACTOR_BINDING_INVALID', 'actor binding sidecar entry is invalid', {}, 500);
    }
    tokens.add(entry.opaque_binding_token);
    entities.add(entry.source_entity_id);
  }
  if (tokens.size !== 2 || entities.size !== 2
    || sidecar.actor_bindings.filter(entry => entry.export_role === 'player').length !== 1
    || sidecar.actor_bindings.filter(entry => entry.export_role === 'npc_or_companion').length !== 1) {
    fail('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', 'export sidecar does not contain one binding pair', {}, 500);
  }
  const basisEntities = new Set(ROOM_SEATS.map(roomSeat => basis.actors[roomSeat].room_actor_id));
  if (basisEntities.size !== 2
    || [...entities].some(entityId => !basisEntities.has(entityId))) {
    fail(
      'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
      'server reimport capsule does not contain the two bound actors',
      {},
      500
    );
  }
  for (const recordValue of sidecar.multiplayer_records) {
    const record = object(recordValue, 'multiplayer record sidecar entry');
    if (record.inject_to_agent !== false
      || record.disclosure !== 'full_after_commit'
      || !ROOM_SEATS.includes(record.counterpart_seat)
      || typeof record.counterpart_action_text !== 'string') {
      fail('SINGLEPLAYER_EXPORT_CONTENT_CORRUPT', 'multiplayer record sidecar entry is invalid', {}, 500);
    }
  }
  return sidecar;
}

function assertOutputInternal(contentValue, expected = {}) {
  assertJsonSafe(contentValue, { maxDepth: 96, maxNodes: 750_000 });
  const content = object(contentValue, 'singleplayer export content');
  if (content.schema !== PERSONAL_SINGLEPLAYER_TIMELINE_SCHEMA
    || content.codec !== MULTIPLAYER_TO_SINGLEPLAYER_CODEC) {
    fail('SINGLEPLAYER_EXPORT_CONTENT_CORRUPT', 'singleplayer export codec metadata is invalid', {}, 500);
  }
  try {
    assertTimelineSave(content);
  } catch (error) {
    fail(
      'SINGLEPLAYER_EXPORT_TIMELINE_INVALID',
      'singleplayer export failed the existing timeline validator',
      {},
      500,
      error
    );
  }
  const sidecar = assertSidecar(content);
  const metadata = object(content.multiplayer_export, 'multiplayer_export');
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && metadata[field] !== value) {
      fail('SINGLEPLAYER_EXPORT_CONTENT_CORRUPT', `export metadata ${field} changed`, {}, 500);
    }
  }
  const agentPayload = canonicalStringify({
    nodes: content.nodes,
    branches: content.branches,
    meta: content.meta
  });
  for (const binding of sidecar.actor_bindings) {
    if (agentPayload.includes(binding.opaque_binding_token)) {
      fail('RETURN_ACTOR_BINDING_INVALID', 'binding token entered Agent-visible export history', {}, 500);
    }
  }
  return immutable(content);
}

export function createMultiplayerToSingleplayerCodec() {
  function encode(inputValue) {
    const normalized = normalizeInput(inputValue);
    const { timeline, newNodeIds, branchId } = buildTimeline(normalized);
    const sidecar = buildSidecar(normalized);
    const head = normalized.chain.at(-1).checkpoint;
    const content = {
      schema: PERSONAL_SINGLEPLAYER_TIMELINE_SCHEMA,
      codec: MULTIPLAYER_TO_SINGLEPLAYER_CODEC,
      ...timeline,
      multiplayer_export: {
        export_id: normalized.input.export_id,
        room_id: normalized.room.room_id,
        lineage_id: normalized.room.lineage_id,
        checkpoint_id: head.checkpoint_id,
        exporting_seat: normalized.exportingSeat,
        projection_version: normalized.input.projection_version,
        timeline_origin: normalized.exportingUserId === normalized.room.origin_owner_user_id
          ? 'source_owner_branch'
          : 'guest_audience_safe_genesis',
        multiplayer_branch_id: branchId,
        multiplayer_node_ids: newNodeIds
      },
      multiplayer_record_sidecar: sidecar
    };
    assertNoSecretResidue(content, normalized);
    const validatedContent = assertOutputInternal(content, {
      export_id: normalized.input.export_id,
      room_id: normalized.room.room_id,
      lineage_id: normalized.room.lineage_id,
      checkpoint_id: head.checkpoint_id,
      exporting_seat: normalized.exportingSeat
    });
    const hash = outputHash(validatedContent);
    const mappings = ROOM_SEATS.map(roomSeat => ({
      room_actor_id: normalized.bindingsBySeat[roomSeat].room_actor_id,
      export_role: roomSeat === normalized.exportingSeat ? 'player' : 'npc_or_companion',
      opaque_binding_token: normalized.bindingsBySeat[roomSeat].opaque_binding_token,
      inject_binding_to_agent: false
    }));
    const manifest = assertPersonalSingleplayerExport({
      schema: PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA,
      export_id: normalized.input.export_id,
      room_id: normalized.room.room_id,
      lineage_id: normalized.room.lineage_id,
      checkpoint_id: head.checkpoint_id,
      exporting_member_user_id: normalized.exportingUserId,
      exporting_seat: normalized.exportingSeat,
      codec: MULTIPLAYER_TO_SINGLEPLAYER_CODEC,
      projection_version: normalized.input.projection_version,
      output_format: normalized.input.output_format,
      idempotency_key: normalized.input.idempotency_key,
      request_hash: normalized.input.request_hash,
      output_hash: hash,
      timeline_origin: validatedContent.multiplayer_export.timeline_origin,
      actor_mappings: mappings,
      multiplayer_record_sidecar: {
        counterpart_actions_included: sidecar.multiplayer_records.length > 0,
        inject_to_agent: false,
        counterpart_private_pov_included: false
      },
      created_at: normalized.input.created_at
    }, {
      origin_type: normalized.room.origin_type,
      origin_owner_user_id: normalized.room.origin_owner_user_id,
      authenticated_user_id: normalized.exportingUserId,
      expected_members_by_seat: normalized.members,
      checkpoint: assertRoomCheckpoint(head),
      actor_bindings: ROOM_SEATS.map(roomSeat => normalized.bindingsBySeat[roomSeat])
    });
    return immutable({ content: validatedContent, output_hash: hash, manifest });
  }

  function assertOutput(content, expected = {}) {
    return assertOutputInternal(content, expected);
  }

  return Object.freeze({
    codec: MULTIPLAYER_TO_SINGLEPLAYER_CODEC,
    outputFormat: 'timeline-json-v1',
    encode,
    assertOutput,
    outputHash
  });
}
