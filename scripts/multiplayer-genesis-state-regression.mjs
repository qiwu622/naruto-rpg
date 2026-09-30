import assert from 'node:assert/strict';

import {
  GUEST_CHARACTER_IMPORT_SCHEMA,
  IMPORTED_PRIVATE_RELATIONSHIPS_SCHEMA,
  INITIAL_GENESIS_COMPATIBILITY_POLICY,
  SINGLEPLAYER_GENESIS_CODEC,
  createExistingSaveGenesisState,
  createNewMultiplayerGenesisState,
  normalizeImportedMultiplayerGenesisState,
  selectSingleplayerGenesisSnapshot,
  stableRoomGenesisActorIds
} from '../server/multiplayer/application/genesis-state.js';

let passed = 0;
function test(name, operation) {
  operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function sourceSnapshot() {
  return {
    _version: '5.0',
    _meta: { current_node_id: 'node_23', active_branch: 'branch_main' },
    '玩家·姓名': '甲',
    '玩家·忍阶': '中忍',
    '玩家·当前目标': '调查边境异动',
    '玩家·出身': '木叶平民忍者',
    '玩家·个性': '谨慎',
    '玩家·存活': '是',
    '属性·查克拉': 80,
    '属性·当前查克拉': 61,
    '属性·生命力': 100,
    '属性·当前生命力': 92,
    '属性·精神力': 65,
    '属性·当前精神力': 54,
    '属性·体力': 70,
    '属性·当前体力': 66,
    '进度·经验': 370,
    '进度·金钱': 900,
    '技能·忍术·水遁·水乱波·名称': '水遁·水乱波',
    '技能·忍术·水遁·水乱波·等级': 'C',
    '技能·忍术·水遁·水乱波·熟练度': 72,
    '技能·忍术·水遁·水乱波·数据库ID': 'canon:jutsu:water-wave',
    '物品·消耗品·兵粮丸·数量': 3,
    '世界·年代': '木叶64年',
    '世界·时间': '木叶64年3月2日·黄昏',
    '世界·地点': '火之国边境哨所',
    '世界·天气': '小雨',
    _missions: {
      active: {
        mission_border: { title: '调查边境异动', progress: 1, progress_total: 3 }
      },
      available: {},
      completed: {},
      failed: {}
    },
    _relationships: {
      日向澪: { affection: 18, trust: 42, respect: 35, role: '队友', info: '共同巡逻' }
    },
    _memory: {
      recent_summary: '甲与日向澪抵达边境哨所，发现不明足迹。',
      facts: '哨所北侧结界曾短暂失效。',
      npc_notes: '日向澪怀疑足迹来自雨隐方向。'
    },
    agent_internal: {
      story_plan: { injected: true },
      audit_state: { forged: true }
    }
  };
}

function guestCharacter() {
  return {
    schema: GUEST_CHARACTER_IMPORT_SCHEMA,
    state_snapshot: {
      _version: '5.0',
      '玩家·姓名': '乙',
      '玩家·忍阶': '下忍',
      '玩家·当前目标': '证明自己的医疗忍术',
      '玩家·出身': '流浪医师家庭',
      '属性·查克拉': 55,
      '属性·当前查克拉': 51,
      '技能·支援·掌仙术·名称': '掌仙术',
      '技能·支援·掌仙术·等级': 'C',
      '技能·支援·掌仙术·熟练度': 64,
      '物品·消耗品·止血药·数量': 4,
      '世界·时间': '不应合并的客方年代',
      '世界·地点': '不应合并的客方村落',
      _missions: { active: { forbidden: { title: '客方旧任务' } } },
      _relationships: { 私人NPC: { trust: 100 } },
      _memory: { facts: '不应进入联机世界的客方旧记忆' },
      agent_internal: { forged: true }
    }
  };
}

function sourceTimeline(snapshot = sourceSnapshot()) {
  return {
    export_version: '2.0',
    exported_at: '2026-08-23T10:00:00.000Z',
    include_archive: false,
    nodes: [{
      id: 'node_23',
      parent_id: null,
      children_ids: [],
      branch_id: 'branch_main',
      turn_number: 23,
      depth: 0,
      player_input: '来源行动',
      clean_response: '来源正文',
      state_snapshot: snapshot
    }],
    branches: [{
      id: 'branch_main',
      name: '主线',
      color: '#eb613f',
      head_node_id: 'node_23',
      node_count: 1,
      is_active: true,
      diverged_from: null
    }],
    meta: {
      key: 'root',
      value: {
        root_id: 'node_23',
        current_id: 'node_23',
        active_branch: 'branch_main',
        total_nodes: 1
      }
    }
  };
}

function assertCompatibilityConflict(operation, category, forbidden = []) {
  let error = null;
  try {
    operation();
  } catch (candidate) {
    error = candidate;
  }
  assert.ok(error, `expected a ${category} compatibility conflict`);
  assert.equal(error.code, 'GENESIS_IMPORT_COMPATIBILITY_CONFLICT');
  assert.equal(error.status, 409);
  assert.deepEqual(error.details, {
    compatibility_policy: INITIAL_GENESIS_COMPATIBILITY_POLICY,
    category
  });
  const projected = JSON.stringify(error.toJSON());
  for (const value of forbidden) assert.doesNotMatch(projected, new RegExp(value, 'u'));
}

test('new multiplayer genesis contains two stable actors and complete reducer domains', () => {
  const actorIds = stableRoomGenesisActorIds('room_example');
  const state = createNewMultiplayerGenesisState({
    new_world_profile: {
      era: '木叶48年',
      preset_id: 'preset:konoha',
      actor_a: { display_name: '甲' },
      actor_b: { display_name: '乙' }
    },
    opening_drafts: {
      A: {
        start_time: { year: 48, month: 3, day: 8, phase: 'DAY' },
        display_name: '日向凛',
        rank: '下忍',
        affiliation: '木叶隐村·日向一族',
        background: '分家出身的侦察忍者。',
        location: '木叶北门',
        goal: '确认商道附近的异常痕迹。',
        opening_hook: '提前检查北门的通行记录。'
      },
      B: {
        start_time: { year: 48, month: 3, day: 8, phase: 'DAY' },
        display_name: '奈良陆',
        rank: '下忍',
        affiliation: '木叶隐村·奈良一族',
        background: '擅长影子术的年轻忍者。',
        location: '木叶南门',
        goal: '护送队友完成巡查。',
        opening_hook: '携任务卷轴从南门出发。'
      }
    },
    actor_ids: actorIds
  });
  assert.equal(state.meta.state_revision, 0);
  assert.equal(state.actors.A.player.display_name, '日向凛');
  assert.equal(state.actors.B.player.display_name, '奈良陆');
  assert.notEqual(state.actors.A.room_actor_id, state.actors.B.room_actor_id);
  assert.deepEqual(
    Object.fromEntries(state.actors.A.private_knowledge.facts.map(fact => [fact.kind, fact.summary])),
    {
      affiliation: '木叶隐村·日向一族',
      background: '分家出身的侦察忍者。',
      opening_hook: '提前检查北门的通行记录。'
    }
  );
  assert.deepEqual(
    Object.fromEntries(state.actors.B.private_knowledge.facts.map(fact => [fact.kind, fact.summary])),
    {
      affiliation: '木叶隐村·奈良一族',
      background: '擅长影子术的年轻忍者。',
      opening_hook: '携任务卷轴从南门出发。'
    }
  );
  assert.equal(state.shared_world.calendar.phase, 'DAY');
  assert.deepEqual(
    state.shared_world.map.markers.map(marker => marker.label).sort(),
    ['木叶北门', '木叶南门']
  );
  assert.equal(state.actors.A.attributes.resources.length > 0, true);
  assert.deepEqual(Object.keys(state.memories).sort(), [
    'actor:A', 'actor:B', 'canonical', 'npc_private', 'shared'
  ]);
  assert.equal(state.agent_internal.story_plan.openings.A.goal, '确认商道附近的异常痕迹。');
  assert.equal(state.agent_internal.story_plan.openings.B.goal, '护送队友完成巡查。');
  assert.deepEqual(state.shared_world.shared_combat.entries, []);
});

test('single-player source and guest card rebuild one authoritative multiplayer genesis', () => {
  const actorIds = stableRoomGenesisActorIds('room_imported');
  const state = createExistingSaveGenesisState({
    source_state: sourceSnapshot(),
    guest_character: guestCharacter(),
    actor_ids: actorIds
  });
  assert.equal(state.actors.A.player.display_name, '甲');
  assert.equal(state.actors.B.player.display_name, '乙');
  assert.equal(state.actors.A.attributes.resources.find(item => item.resource_id === 'chakra').current, 61);
  assert.equal(state.actors.B.skills.entries[0].display_name, '掌仙术');
  assert.equal(state.shared_world.calendar.display_date, '木叶64年3月2日·黄昏');
  assert.equal(state.actors.A.missions.entries[0].title, '调查边境异动');
  assert.equal(state.actors.B.missions.entries.length, 0, 'guest world missions are never merged');
  assert.deepEqual(
    state.shared_world.world_state.npc_profiles,
    [],
    'legacy NPC profiles have no authenticated shared/public visibility'
  );
  assert.deepEqual(
    state.relationships,
    [],
    'legacy directed relationships stay out of the shared authority domain'
  );
  const importedRelationships = state.actors.A.private_knowledge.imported_relationships;
  assert.equal(importedRelationships.schema, IMPORTED_PRIVATE_RELATIONSHIPS_SCHEMA);
  assert.equal(importedRelationships.entries.length, 1);
  assert.equal(importedRelationships.entries[0].display_name, '日向澪');
  assert.equal(importedRelationships.entries[0].directed_relationship.score, 42);
  assert.equal(importedRelationships.entries[0].directed_relationship.label, '队友');
  assert.doesNotMatch(JSON.stringify({
    shared_world: state.shared_world,
    relationships: state.relationships,
    guest_actor: state.actors.B,
    guest_memory: state.memories['actor:B'],
    shared_memory: state.memories.shared
  }), /日向澪|共同巡逻|42/u);
  assert.deepEqual(state.memories['actor:B'].entries, [], 'guest prior memory is never merged');
  assert.match(JSON.stringify(state.memories.npc_private), /日向澪怀疑足迹/u);
  assert.equal(state.agent_internal.story_plan.injected, undefined);
  assert.equal(state.agent_internal.audit_state.forged, undefined);
  assert.equal(state.agent_internal.audit_state.genesis_codec, SINGLEPLAYER_GENESIS_CODEC);
  assert.equal(state.agent_internal.audit_state.guest_character_attached, true);
});

test('timeline selector binds body state to the exact active branch head', () => {
  const selected = selectSingleplayerGenesisSnapshot({
    source_timeline: sourceTimeline(),
    source_branch_id: 'branch_main',
    source_node_id: 'node_23',
    state: sourceSnapshot()
  });
  assert.equal(selected.state['玩家·姓名'], '甲');
  assert.throws(() => selectSingleplayerGenesisSnapshot({
    source_timeline: sourceTimeline(),
    source_branch_id: 'branch_main',
    source_node_id: 'node_23',
    state: { ...sourceSnapshot(), '世界·天气': '晴' }
  }), error => error?.code === 'SOURCE_OWNER_STATE_CHANGED');
});

test('legacy normalization name no longer trusts a multiplayer reducer snapshot', () => {
  const reducerState = createNewMultiplayerGenesisState();
  assert.throws(
    () => normalizeImportedMultiplayerGenesisState(reducerState),
    error => error?.code === 'SINGLEPLAYER_GENESIS_VERSION_UNSUPPORTED'
  );
});

test('arbitrary legacy browser state without a supported version is rejected', () => {
  assert.throws(
    () => normalizeImportedMultiplayerGenesisState({ '玩家·姓名': '甲' }),
    error => error?.code === 'SINGLEPLAYER_GENESIS_VERSION_UNSUPPORTED'
  );
});

test('resource values are fail-closed instead of silently clamped', () => {
  const guest = guestCharacter();
  guest.state_snapshot['属性·查克拉'] = 40;
  guest.state_snapshot['属性·当前查克拉'] = 987654;
  assertCompatibilityConflict(
    () => createExistingSaveGenesisState({
      source_state: sourceSnapshot(),
      guest_character: guest
    }),
    'resource',
    ['987654']
  );
});

test('ambiguous or unresolved equipment slots are rejected as item conflicts', () => {
  const guest = guestCharacter();
  guest.state_snapshot['物品·武器·秘制短刀·数量'] = 1;
  guest.state_snapshot['物品·已装备·武器'] = '秘制短刀';
  guest.state_snapshot['物品·已装备·饰品1'] = '秘制短刀';
  assertCompatibilityConflict(
    () => createExistingSaveGenesisState({
      source_state: sourceSnapshot(),
      guest_character: guest
    }),
    'item',
    ['秘制短刀']
  );
});

test('explicit unique references collide without revealing the source ability', () => {
  const source = sourceSnapshot();
  const guest = guestCharacter();
  source['技能·血继限界·秘传眼·名称'] = '来源秘传眼';
  source['技能·血继限界·秘传眼·数据库ID'] = 'unique:secret-eye-7f2a';
  guest.state_snapshot['技能·血继限界·另一只眼·名称'] = '客方已知名称';
  guest.state_snapshot['技能·血继限界·另一只眼·数据库ID'] = 'unique:secret-eye-7f2a';
  assertCompatibilityConflict(
    () => createExistingSaveGenesisState({ source_state: source, guest_character: guest }),
    'unique_ability',
    ['来源秘传眼', 'secret-eye-7f2a', '客方已知名称']
  );
});

test('guest era and date are stripped, while inseparable mechanical references fail closed', () => {
  const accepted = createExistingSaveGenesisState({
    source_state: sourceSnapshot(),
    guest_character: guestCharacter()
  });
  assert.equal(accepted.shared_world.calendar.display_date, '木叶64年3月2日·黄昏');
  assert.doesNotMatch(JSON.stringify(accepted), /不应合并的客方年代/u);

  const eraGuest = guestCharacter();
  eraGuest.state_snapshot['技能·支援·时代秘术·名称'] = '时代秘术';
  eraGuest.state_snapshot['技能·支援·时代秘术·数据库ID'] = 'era:warring-states-only';
  assertCompatibilityConflict(
    () => createExistingSaveGenesisState({
      source_state: sourceSnapshot(),
      guest_character: eraGuest
    }),
    'era',
    ['warring-states-only']
  );

  const dateGuest = guestCharacter();
  dateGuest.state_snapshot['物品·关键·限时通行证·数量'] = 1;
  dateGuest.state_snapshot['物品·关键·限时通行证·描述'] = '规范引用：date:64-03-02';
  assertCompatibilityConflict(
    () => createExistingSaveGenesisState({
      source_state: sourceSnapshot(),
      guest_character: dateGuest
    }),
    'date',
    ['64-03-02']
  );
});

test('ninja rank and item quantities must be exactly representable', () => {
  const rankGuest = guestCharacter();
  rankGuest.state_snapshot['玩家·忍阶'] = 99;
  assertCompatibilityConflict(
    () => createExistingSaveGenesisState({
      source_state: sourceSnapshot(),
      guest_character: rankGuest
    }),
    'rank',
    ['99']
  );

  const itemGuest = guestCharacter();
  itemGuest.state_snapshot['物品·消耗品·超量药丸·数量'] = 1_000_001;
  assertCompatibilityConflict(
    () => createExistingSaveGenesisState({
      source_state: sourceSnapshot(),
      guest_character: itemGuest
    }),
    'item',
    ['1000001', '超量药丸']
  );
});

test('room actor IDs are server-bound and must form a distinct pair', () => {
  assertCompatibilityConflict(
    () => createExistingSaveGenesisState({
      source_state: sourceSnapshot(),
      guest_character: guestCharacter(),
      actor_ids: { A: 'actor:duplicate', B: 'actor:duplicate' }
    }),
    'actor_id',
    ['actor:duplicate']
  );
});

console.log(`multiplayer genesis state regression: ${passed} passed`);
