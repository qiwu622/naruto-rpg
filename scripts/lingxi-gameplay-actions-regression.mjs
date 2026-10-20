import assert from 'node:assert/strict';

import { ToolApprovalBroker } from '../js/core/lingxi/approval-broker.js';
import {
  EquipmentActionAdapter,
  LINGXI_EQUIPMENT_ACTION_TOOL,
  LINGXI_MISSION_ACTION_TOOL,
  MissionActionAdapter
} from '../js/core/lingxi/adapters/gameplay-action-adapters.js';
import { EquipmentSystem } from '../js/systems/equipment-system.js';
import { MissionSystem } from '../js/systems/mission-system.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MemoryManager {
  constructor(state) {
    this.state = clone(state);
    this.updateCalls = 0;
    this.setSubCalls = 0;
    this.restoreCalls = 0;
  }

  snapshot() { return clone(this.state); }
  get(key) { return key === undefined ? clone(this.state) : clone(this.state[key]); }
  getSub(key) { return clone(this.state[key]); }

  setSub(key, value) {
    this.setSubCalls += 1;
    this.state[key] = clone(value);
  }

  restore(snapshot) {
    this.restoreCalls += 1;
    this.state = clone(snapshot);
  }

  update(updates) {
    this.updateCalls += 1;
    for (const update of updates) {
      if (['delete', 'del', 'remove'].includes(update.op)) {
        delete this.state[update.key];
      } else if (update.op === '+') {
        this.state[update.key] = (Number(this.state[update.key]) || 0) + Number(update.value);
      } else if (update.op === '-') {
        this.state[update.key] = Math.max(0, (Number(this.state[update.key]) || 0) - Number(update.value));
      } else {
        this.state[update.key] = clone(update.value);
      }
    }
    this._enforceBounds();
  }

  _enforceBounds() {
    for (const [currentKey, maxKey] of [
      ['属性·当前查克拉', '属性·查克拉'],
      ['属性·当前精神力', '属性·精神力'],
      ['属性·当前生命力', '属性·生命力'],
      ['属性·当前体力', '属性·体力']
    ]) {
      if (typeof this.state[currentKey] !== 'number') continue;
      this.state[currentKey] = Math.max(0, Math.min(this.state[currentKey], Number(this.state[maxKey]) || 0));
    }
    let guard = 0;
    while (typeof this.state['进度·经验'] === 'number'
      && typeof this.state['进度·下一级经验'] === 'number'
      && this.state['进度·经验'] >= this.state['进度·下一级经验']
      && guard < 50) {
      const needed = this.state['进度·下一级经验'];
      this.state['进度·经验'] -= needed;
      this.state['进度·下一级经验'] = Math.max(1, Math.round(needed * 1.4));
      this.state['进度·突破待处理'] = (this.state['进度·突破待处理'] || 0) + 1;
      guard += 1;
    }
    for (const key of Object.keys(this.state)) {
      if (!key.startsWith('物品·') || !key.endsWith('·数量')) continue;
      this.state[key] = Math.max(0, Number(this.state[key]) || 0);
      if (this.state[key] <= 0) delete this.state[key];
    }
  }
}

class RecordingEventBus {
  constructor() { this.events = []; }
  emit(name, data) { this.events.push({ name, data: clone(data) }); }
}

function baseState() {
  return {
    _meta: { current_node_id: 'node_7', active_branch: 'branch_main' },
    _missions: {
      active: {
        mission_1: {
          id: 'mission_1',
          title: '护送药材',
          status: 'active',
          rank: 'C',
          reward_exp: 80,
          reward_ryo: 120
        }
      },
      completed: {},
      failed: {},
      stats: {
        total_done: 2,
        total_failed: 0,
        total_abandoned: 0,
        d_rank: 1,
        c_rank: 1,
        b_rank: 0,
        a_rank: 0,
        s_rank: 0
      }
    },
    '物品·武器·苦无·数量': 2,
    '物品·武器·苦无·品质': '优秀',
    '物品·武器·手里剑·数量': 4,
    '物品·武器·手里剑·品质': '史诗',
    '物品·消耗品·兵粮丸·数量': 3,
    '物品·消耗品·兵粮丸·品质': '普通',
    '物品·已装备·武器': '手里剑',
    '物品·已装备·防具': '',
    '物品·已装备·饰品1': '',
    '物品·已装备·饰品2': '',
    '属性·查克拉': 100,
    '属性·当前查克拉': 40,
    '属性·生命力': 100,
    '属性·当前生命力': 60,
    '属性·体力': 100,
    '属性·当前体力': 20,
    '属性·精神力': 100,
    '属性·当前精神力': 50,
    '属性·速度': 15,
    '属性·幸运': 5,
    '进度·经验': 10,
    '进度·下一级经验': 1000,
    '进度·突破待处理': 0,
    '进度·金钱': 30,
    '进度·已完成任务': 0
  };
}

const trustedEvent = Object.freeze({ source: 'trusted-test-ui' });
const fixedNow = 1_780_000_000_000;

function brokerFor(adapter) {
  return new ToolApprovalBroker({
    adapters: [adapter],
    now: () => fixedNow,
    isTrustedUserEvent: event => event === trustedEvent
  });
}

function errorCode(code) {
  return error => {
    assert.equal(error?.code, code);
    return true;
  };
}

function diffAt(proposal, path) {
  return proposal.diff.find(entry => entry.path === path);
}

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

await test('gameplay adapters use dedicated approval tool names', () => {
  const manager = new MemoryManager(baseState());
  const eventBus = new RecordingEventBus();
  assert.equal(new EquipmentActionAdapter({
    stateManager: manager,
    equipmentSystem: new EquipmentSystem({ stateManager: manager, eventBus })
  }).toolName, LINGXI_EQUIPMENT_ACTION_TOOL);
  assert.equal(new MissionActionAdapter({
    stateManager: manager,
    missionSystem: new MissionSystem({ stateManager: manager, eventBus })
  }).toolName, LINGXI_MISSION_ACTION_TOOL);
});

await test('equipment preview and approved use preserve inventory counts above 99', async () => {
  const state = baseState();
  state['物品·消耗品·兵粮丸·数量'] = 10000;
  const manager = new MemoryManager(state);
  const eventBus = new RecordingEventBus();
  const adapter = new EquipmentActionAdapter({ stateManager: manager,
    equipmentSystem: new EquipmentSystem({ stateManager: manager, eventBus }) });
  const broker = brokerFor(adapter);
  const proposal = await broker.stageAction(LINGXI_EQUIPMENT_ACTION_TOOL, { action: 'use', name: '兵粮丸', reason: '恢复查克拉' });
  assert.equal(manager.get('物品·消耗品·兵粮丸·数量'), 10000, 'preview leaves live inventory intact');
  assert.deepEqual(diffAt(proposal, '/物品·消耗品·兵粮丸·数量'), {
    path: '/物品·消耗品·兵粮丸·数量', operation: 'replace', before: 10000, after: 9999
  });
  await broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' });
  assert.equal(manager.get('物品·消耗品·兵粮丸·数量'), 9999);
});

await test('equipment preview signs old bonus removal plus new bonus with zero live writes or events', async () => {
  const manager = new MemoryManager(baseState());
  const eventBus = new RecordingEventBus();
  const equipment = new EquipmentSystem({ stateManager: manager, eventBus });
  let equipCalls = 0;
  const equip = equipment.equip.bind(equipment);
  equipment.equip = (...args) => {
    equipCalls += 1;
    return equip(...args);
  };
  const broker = brokerFor(new EquipmentActionAdapter({ stateManager: manager, equipmentSystem: equipment }));
  const proposal = await broker.stageAction(LINGXI_EQUIPMENT_ACTION_TOOL, {
    action: 'equip', slot: 'weapon', category: 'weapons', name: '苦无', reason: '切换近战武器'
  });

  assert.equal(manager.updateCalls, 0);
  assert.equal(manager.setSubCalls, 0);
  assert.equal(eventBus.events.length, 0);
  assert.equal(equipCalls, 0);
  assert.deepEqual(proposal.diff, [
    { path: '/属性·速度', operation: 'replace', before: 15, after: 12 },
    { path: '/物品·已装备·武器', operation: 'replace', before: '手里剑', after: '苦无' }
  ]);

  const receipt = await broker.approveFromUserEvent(trustedEvent, {
    proposalId: proposal.id, confirmation: 'yes'
  });
  assert.equal(equipCalls, 1);
  assert.equal(manager.get('物品·已装备·武器'), '苦无');
  assert.equal(manager.get('属性·速度'), 12);
  assert.deepEqual(receipt.diff, proposal.diff);
  assert.deepEqual(eventBus.events.map(event => event.name), [
    'equipment:unequipped', 'equipment:equipped'
  ]);
});

await test('consumable preview signs quantity and every recovered resource, and discard signs entity deletion', async () => {
  const manager = new MemoryManager(baseState());
  const eventBus = new RecordingEventBus();
  const equipment = new EquipmentSystem({ stateManager: manager, eventBus });
  const useBroker = brokerFor(new EquipmentActionAdapter({ stateManager: manager, equipmentSystem: equipment }));
  const use = await useBroker.stageAction(LINGXI_EQUIPMENT_ACTION_TOOL, {
    action: 'use', name: '兵粮丸', reason: '恢复资源'
  });

  assert.deepEqual(diffAt(use, '/物品·消耗品·兵粮丸·数量'), {
    path: '/物品·消耗品·兵粮丸·数量', operation: 'replace', before: 3, after: 2
  });
  assert.deepEqual(diffAt(use, '/属性·当前体力'), {
    path: '/属性·当前体力', operation: 'replace', before: 20, after: 50
  });
  assert.deepEqual(diffAt(use, '/属性·当前查克拉'), {
    path: '/属性·当前查克拉', operation: 'replace', before: 40, after: 52
  });
  assert.equal(manager.updateCalls, 0);
  assert.equal(eventBus.events.length, 0);

  await useBroker.approveFromUserEvent(trustedEvent, { proposalId: use.id, confirmation: 'yes' });
  assert.equal(manager.get('物品·消耗品·兵粮丸·数量'), 2);
  assert.equal(manager.get('属性·当前体力'), 50);
  assert.equal(manager.get('属性·当前查克拉'), 52);

  const discardBroker = brokerFor(new EquipmentActionAdapter({ stateManager: manager, equipmentSystem: equipment }));
  const discard = await discardBroker.stageAction(LINGXI_EQUIPMENT_ACTION_TOOL, {
    action: 'discard', category: 'weapons', name: '苦无', quantity: 2, reason: '清理背包'
  });
  assert.equal(diffAt(discard, '/物品·武器·苦无·数量')?.operation, 'remove');
  assert.equal(diffAt(discard, '/物品·武器·苦无·品质')?.operation, 'remove');
  await discardBroker.approveFromUserEvent(trustedEvent, {
    proposalId: discard.id, confirmation: 'yes'
  });
  assert.equal(manager.get('物品·武器·苦无·数量'), undefined);
  assert.equal(manager.get('物品·武器·苦无·品质'), undefined);
});

await test('stale equipment state blocks before the live domain method runs', async () => {
  const manager = new MemoryManager(baseState());
  const equipment = new EquipmentSystem({ stateManager: manager, eventBus: new RecordingEventBus() });
  let equipCalls = 0;
  const equip = equipment.equip.bind(equipment);
  equipment.equip = (...args) => {
    equipCalls += 1;
    return equip(...args);
  };
  const broker = brokerFor(new EquipmentActionAdapter({ stateManager: manager, equipmentSystem: equipment }));
  const proposal = await broker.stageAction(LINGXI_EQUIPMENT_ACTION_TOOL, {
    action: 'equip', slot: 'weapon', category: 'weapons', name: '苦无', reason: '切换武器'
  });
  manager.update([{ key: '物品·武器·苦无·数量', op: '=', value: 1 }]);
  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_STALE')
  );
  assert.equal(equipCalls, 0);
  assert.equal(manager.get('物品·已装备·武器'), '手里剑');
});

await test('unexpected equipment domain changes reject approval and roll back the full state', async () => {
  const manager = new MemoryManager(baseState());
  const equipment = new EquipmentSystem({ stateManager: manager, eventBus: new RecordingEventBus() });
  const equip = equipment.equip.bind(equipment);
  equipment.equip = (...args) => {
    const result = equip(...args);
    manager.update([{ key: '属性·幸运', op: '+', value: 1 }]);
    return result;
  };
  const broker = brokerFor(new EquipmentActionAdapter({ stateManager: manager, equipmentSystem: equipment }));
  const proposal = await broker.stageAction(LINGXI_EQUIPMENT_ACTION_TOOL, {
    action: 'equip', slot: 'weapon', category: 'weapons', name: '苦无', reason: '切换武器'
  });
  const before = manager.snapshot();
  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_APPLY_MISMATCH')
  );
  assert.deepEqual(manager.snapshot(), before);
  assert.equal(manager.restoreCalls, 1);
});

await test('mission preview signs collection migration, timestamp, rewards, and stats with zero live effects', async () => {
  const manager = new MemoryManager(baseState());
  const eventBus = new RecordingEventBus();
  const missions = new MissionSystem({ stateManager: manager, eventBus, clock: () => 999 });
  let processCalls = 0;
  const processInstruction = missions.processInstruction.bind(missions);
  missions.processInstruction = (...args) => {
    processCalls += 1;
    return processInstruction(...args);
  };
  const broker = brokerFor(new MissionActionAdapter({ stateManager: manager, missionSystem: missions }));
  const proposal = await broker.stageAction(LINGXI_MISSION_ACTION_TOOL, {
    action: 'complete', missionId: 'mission_1', reason: '任务目标已经达成'
  });

  assert.equal(manager.updateCalls, 0);
  assert.equal(manager.setSubCalls, 0);
  assert.equal(eventBus.events.length, 0);
  assert.equal(processCalls, 0);
  assert.equal(diffAt(proposal, '/missions/active/mission_1')?.operation, 'remove');
  const completed = diffAt(proposal, '/missions/completed/mission_1');
  assert.equal(completed?.operation, 'add');
  assert.equal(completed?.after.status, 'completed');
  assert.equal(completed?.after.completed_at, proposal.createdAt);
  assert.deepEqual(diffAt(proposal, '/missions/stats/total_done'), {
    path: '/missions/stats/total_done', operation: 'replace', before: 2, after: 3
  });
  assert.deepEqual(diffAt(proposal, '/missions/stats/c_rank'), {
    path: '/missions/stats/c_rank', operation: 'replace', before: 1, after: 2
  });
  assert.equal(diffAt(proposal, '/resources/进度·经验')?.after, 90);
  assert.equal(diffAt(proposal, '/resources/进度·金钱')?.after, 150);
  assert.equal(diffAt(proposal, '/resources/进度·已完成任务')?.after, 1);

  const receipt = await broker.approveFromUserEvent(trustedEvent, {
    proposalId: proposal.id, confirmation: 'yes'
  });
  assert.equal(processCalls, 1);
  assert.equal(manager.getSub('_missions').active.mission_1, undefined);
  assert.equal(manager.getSub('_missions').completed.mission_1.completed_at, proposal.createdAt);
  assert.equal(manager.getSub('_missions').stats.total_done, 3);
  assert.equal(manager.getSub('_missions').stats.c_rank, 2);
  assert.equal(manager.get('进度·经验'), 90);
  assert.equal(manager.get('进度·金钱'), 150);
  assert.deepEqual(receipt.diff, proposal.diff);
  assert.deepEqual(eventBus.events.map(event => event.name), ['mission:completed', 'mission:updated']);
});

await test('mission state drift blocks settlement before any reward or live domain call', async () => {
  const manager = new MemoryManager(baseState());
  const missions = new MissionSystem({ stateManager: manager, eventBus: new RecordingEventBus() });
  let processCalls = 0;
  const processInstruction = missions.processInstruction.bind(missions);
  missions.processInstruction = (...args) => {
    processCalls += 1;
    return processInstruction(...args);
  };
  const broker = brokerFor(new MissionActionAdapter({ stateManager: manager, missionSystem: missions }));
  const proposal = await broker.stageAction(LINGXI_MISSION_ACTION_TOOL, {
    action: 'complete', missionId: 'mission_1', reason: '准备结算'
  });
  const changed = manager.getSub('_missions');
  changed.active.mission_1.progress = { current_step: 2 };
  manager.setSub('_missions', changed);
  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_STALE')
  );
  assert.equal(processCalls, 0);
  assert.equal(manager.get('进度·经验'), 10);
  assert.equal(manager.get('进度·金钱'), 30);
});

await test('unexpected mission settlement changes roll back collections and rewards', async () => {
  const manager = new MemoryManager(baseState());
  const missions = new MissionSystem({ stateManager: manager, eventBus: new RecordingEventBus() });
  const processInstruction = missions.processInstruction.bind(missions);
  missions.processInstruction = (...args) => {
    const result = processInstruction(...args);
    manager.update([{ key: '进度·金钱', op: '+', value: 1 }]);
    return result;
  };
  const broker = brokerFor(new MissionActionAdapter({ stateManager: manager, missionSystem: missions }));
  const proposal = await broker.stageAction(LINGXI_MISSION_ACTION_TOOL, {
    action: 'complete', missionId: 'mission_1', reason: '结算任务'
  });
  const before = manager.snapshot();
  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_APPLY_MISMATCH')
  );
  assert.deepEqual(manager.snapshot(), before);
  assert.equal(manager.restoreCalls, 1);
});

await test('an approved mission cannot grant its rewards twice', async () => {
  const manager = new MemoryManager(baseState());
  const missions = new MissionSystem({ stateManager: manager, eventBus: new RecordingEventBus() });
  let processCalls = 0;
  const processInstruction = missions.processInstruction.bind(missions);
  missions.processInstruction = (...args) => {
    processCalls += 1;
    return processInstruction(...args);
  };
  const adapter = new MissionActionAdapter({ stateManager: manager, missionSystem: missions });
  const broker = brokerFor(adapter);
  const proposal = await broker.stageAction(LINGXI_MISSION_ACTION_TOOL, {
    action: 'complete', missionId: 'mission_1', reason: '结算任务'
  });
  await broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' });
  const rewarded = { exp: manager.get('进度·经验'), ryo: manager.get('进度·金钱') };

  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_REPLAYED')
  );
  await assert.rejects(
    () => broker.stageAction(LINGXI_MISSION_ACTION_TOOL, {
      action: 'complete', missionId: 'mission_1', reason: '再次结算'
    }),
    errorCode('LINGXI_MISSION_UNAVAILABLE')
  );
  assert.equal(processCalls, 1);
  assert.deepEqual({ exp: manager.get('进度·经验'), ryo: manager.get('进度·金钱') }, rewarded);
});

if (failures.length) {
  console.error(`\nLing Xi gameplay action regression failed: ${failures.length}/${passed + failures.length}`);
  process.exitCode = 1;
} else {
  console.log(`\nLing Xi gameplay action regression passed (${passed} tests).`);
}
