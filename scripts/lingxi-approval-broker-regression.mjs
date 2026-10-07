import assert from 'node:assert/strict';

import { ToolApprovalBroker } from '../js/core/lingxi/approval-broker.js';
import { classifyProposalApproval } from '../js/core/lingxi/proposal-approval-policy.js';
import {
  LINGXI_VARIABLE_PATCH_TOOL,
  StateVariableActionAdapter,
  buildExactStateDiff
} from '../js/core/lingxi/adapters/state-adapter.js';
import { LingXiController } from '../js/core/lingxi/lingxi-controller.js';
import { AgentToolRuntime } from '../js/core/agent-tool-runtime.js';
import { LingXiContextBroker } from '../js/core/lingxi/lingxi-context-broker.js';
import { stateManager } from '../js/core/state-manager.js';
import { eventBus } from '../js/core/event-bus.js';
import '../js/systems/attribute-system.js';

function clone(value) {
  return structuredClone(value);
}

function baseState(overrides = {}) {
  return {
    _version: '5.0',
    _meta: { current_node_id: 'node_0007_test', active_branch: 'branch_main' },
    _opening_contract: null,
    _map: { known_locations: {}, active_pins: '' },
    '系统·回合数': 7,
    '玩家·存活': '是',
    '玩家·死因': '',
    '属性·查克拉': 100,
    '属性·当前查克拉': 40,
    '属性·生命力': 100,
    '属性·当前生命力': 100,
    '世界·天气': '晴',
    '世界·时间': 'K052-01-01',
    '世界·月份': 1,
    ...overrides
  };
}

class MemoryStateManager {
  constructor(state = baseState()) {
    this.state = clone(state);
    this._stateVersion = 0;
    this.commitCount = 0;
    this.prepareHook = null;
  }

  snapshot() {
    return clone(this.state);
  }

  get(key) {
    if (key === undefined) return clone(this.state);
    return clone(this.state[key]);
  }

  getSub(key) {
    return clone(this.state[key]);
  }

  prepareRestore(snapshot) {
    this.prepareHook?.();
    const state = clone(snapshot);
    if (typeof state['属性·当前查克拉'] === 'number' && typeof state['属性·查克拉'] === 'number') {
      state['属性·当前查克拉'] = Math.max(0, Math.min(state['属性·当前查克拉'], state['属性·查克拉']));
    }
    return { state, levelUpEvents: [] };
  }

  commitPreparedRestore(prepared) {
    this.state = clone(prepared.state);
    this._stateVersion += 1;
    this.commitCount += 1;
  }

  restore(snapshot) {
    this.commitPreparedRestore(this.prepareRestore(snapshot));
  }

  mutate(mutator) {
    mutator(this.state);
    this._stateVersion += 1;
  }
}

const trustedEvent = Object.freeze({ source: 'trusted-test-ui' });

function harness({ state = baseState(), now = 1_000_000 } = {}) {
  const manager = new MemoryStateManager(state);
  let clock = now;
  const adapter = new StateVariableActionAdapter(manager);
  const broker = new ToolApprovalBroker({
    adapters: [adapter],
    now: () => clock,
    isTrustedUserEvent: event => event === trustedEvent
  });
  return {
    manager,
    adapter,
    broker,
    advance(milliseconds) { clock += milliseconds; }
  };
}

function timelineImpact(overrides = {}) {
  return {
    schema: 'naruto.lingxi-timeline-impact/v1',
    operation: 'create-maintenance-checkpoint',
    parentNodeId: 'node_0007_test',
    activeBranchId: 'branch_main',
    createsIfBranch: false,
    createsTurn: false,
    updatesNode: true,
    branchName: null,
    ...overrides
  };
}

function controllerHarness({
  checkpointError = null,
  checkpointHook = null,
  initialTimelineImpact = null,
  autoApplyLowRisk = false
} = {}) {
  const manager = new MemoryStateManager();
  const checkpointCalls = [];
  let currentTimelineImpact = timelineImpact(initialTimelineImpact || {});
  const timelineSystem = {
    async previewMaintenanceCheckpoint() {
      return clone(currentTimelineImpact);
    },
    async createMaintenanceCheckpoint(payload) {
      checkpointCalls.push(clone(payload));
      checkpointHook?.({ manager, payload: clone(payload) });
      if (checkpointError) throw checkpointError;
      return {
        id: 'node_lingxi_checkpoint',
        summary: `灵希维护 · ${payload.label}`
      };
    }
  };
  const stored = new Map();
  const storage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value))
  };
  const controller = new LingXiController({
    stateManager: manager,
    timelineSystem,
    runtime: {},
    isTrustedUserEvent: event => event === trustedSubmitEvent,
    autoApplyLowRisk,
    storage
  });
  return {
    manager,
    controller,
    checkpointCalls,
    setTimelineImpact(value) { currentTimelineImpact = timelineImpact(value); }
  };
}

const trustedSubmitEvent = Object.freeze({ isTrusted: true, type: 'submit' });

function errorCode(expected) {
  return error => {
    assert.equal(error?.code, expected);
    return true;
  };
}

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

await test('staging is read-only and reports the prepared before/after value', async () => {
  const { broker, manager } = harness();
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    reason: '检查查克拉上限后修复当前值',
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 500 }]
  });

  assert.equal(manager.state['属性·当前查克拉'], 40);
  assert.equal(manager.commitCount, 0);
  assert.deepEqual(proposal.params.updates, [
    { path: 'attributes.chakra_current', op: 'set', value: 500 }
  ]);
  assert.deepEqual(proposal.diff, [{
    path: '/属性·当前查克拉',
    operation: 'replace',
    before: 40,
    after: 100
  }]);
  assert.equal(proposal.context.nodeId, 'node_0007_test');
  assert.equal(proposal.context.stateRevision, 0);
});

await test('only a trusted UI confirmation event can approve, without typed text', async () => {
  const { broker, manager, adapter } = harness();
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 75 }]
  });

  assert.equal(typeof broker.approve, 'undefined', 'chat-text approval API must not exist');
  await assert.rejects(
    () => adapter.apply(proposal),
    errorCode('LINGXI_APPROVAL_REQUIRED')
  );
  await assert.rejects(
    () => broker.approveFromUserEvent({ isTrusted: false }, { proposalId: proposal.id }),
    errorCode('LINGXI_TRUSTED_UI_REQUIRED')
  );
  assert.equal(manager.state['属性·当前查克拉'], 40);
  assert.equal(manager.commitCount, 0);

  const receipt = await broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id });
  assert.equal(receipt.proposalId, proposal.id);
  assert.equal(manager.state['属性·当前查克拉'], 75);
  assert.equal(manager.commitCount, 1);
  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_REPLAYED')
  );
  assert.equal(manager.commitCount, 1);
});

await test('approval policy auto-applies only one or two reversible allowlisted changes', () => {
  const lowRisk = classifyProposalApproval({
    tool: 'apply_ui_settings',
    params: { patch: { fontSize: 18, lineHeight: 1.7 } },
    diff: [
      { path: '/_ui/settings/fontSize', operation: 'replace', before: 16, after: 18 },
      { path: '/_ui/settings/lineHeight', operation: 'replace', before: 1.6, after: 1.7 }
    ]
  });
  assert.equal(lowRisk.mode, 'automatic');

  for (const proposal of [
    {
      tool: 'apply_ui_settings',
      params: { patch: { fontSize: 18, lineHeight: 1.7, musicVolume: 70 } },
      diff: [
        { path: '/a', operation: 'replace' },
        { path: '/b', operation: 'replace' },
        { path: '/c', operation: 'replace' }
      ]
    },
    {
      tool: 'upsert_worldbook_entry',
      params: { action: 'delete' },
      diff: [{ path: '/worldbook/0', operation: 'remove' }]
    },
    {
      tool: 'generate_image',
      params: { prompt: 'test' },
      diff: [{ path: '/jobs/test', operation: 'add' }]
    },
    {
      tool: 'save_or_start_opening',
      params: { mode: 'start' },
      diff: [{ path: '/opening', operation: 'replace' }]
    }
  ]) {
    assert.equal(classifyProposalApproval(proposal).mode, 'confirm');
  }
});

await test('controller applies a one-field variable repair in the background by default policy', async () => {
  const { controller, manager, checkpointCalls } = controllerHarness({ autoApplyLowRisk: true });
  const result = await controller.stageVariableChange({
    key: '属性·当前查克拉',
    value: 75,
    reason: '修复当前查克拉'
  });

  assert.equal(result.autoApplied, true);
  assert.equal(result.receipt.proposalId, result.id);
  assert.equal(manager.state['属性·当前查克拉'], 75);
  assert.equal(manager.commitCount, 1);
  assert.equal(checkpointCalls.length, 1);
  assert.equal(controller.approvalBroker.listPendingProposals().length, 0);
  assert.equal(controller._lastStagedProposal, null);
});

await test('default browser trust policy rejects forged isTrusted-shaped objects', async () => {
  const manager = new MemoryStateManager();
  const broker = new ToolApprovalBroker({
    adapters: [new StateVariableActionAdapter(manager)]
  });
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 74 }]
  });
  await assert.rejects(
    () => broker.approveFromUserEvent(
      { isTrusted: true, type: 'submit' },
      { proposalId: proposal.id, confirmation: 'yes' }
    ),
    errorCode('LINGXI_TRUSTED_UI_REQUIRED')
  );
  assert.equal(manager.commitCount, 0);
});

await test('schema rejects unknown, internal, unsafe, and extra-field writes before proposal creation', async () => {
  const { broker, manager } = harness();
  for (const updates of [
    [{ path: 'attributes.not_real', op: 'set', value: 10 }],
    [{ path: '_meta.current_node_id', op: 'set', value: 'node_evil' }],
    [{ key: '系统·当前节点', op: '=', value: 'node_evil' }],
    [{ path: 'world_state.map.known_locations', op: 'assign', key: '__proto__', value: { x: 1, y: 2, desc: 'x', tier: 'D' } }],
    [{
      path: 'skills.jutsu.测试忍术',
      op: 'set',
      value: {
        name: '测试忍术', rank: 'D', element: '风', resource_type: '查克拉',
        cost: 1, power: 1, mastery: 1, description: '测试', hidden_payload: '拒绝'
      }
    }]
  ]) {
    await assert.rejects(
      () => broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, { updates }),
      error => String(error?.code || '').startsWith('LINGXI_')
    );
  }
  assert.equal(manager.commitCount, 0);
  assert.equal(manager.state['属性·当前查克拉'], 40);
  assert.equal({}.hidden_payload, undefined);
});

await test('a state change after staging makes the proposal stale and writes zero state', async () => {
  const { broker, manager } = harness();
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 80 }]
  });
  manager.mutate(state => { state['世界·天气'] = '雨'; });
  const commitsBeforeApproval = manager.commitCount;

  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_STALE')
  );
  assert.equal(manager.commitCount, commitsBeforeApproval);
  assert.equal(manager.state['属性·当前查克拉'], 40);
  assert.equal(manager.state['世界·天气'], '雨');

  manager.mutate(state => { state['世界·天气'] = '晴'; });
  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_REPLAYED')
  );
  assert.equal(manager.commitCount, commitsBeforeApproval);
});

await test('a change during approval preparation is caught before the synchronous commit', async () => {
  const { broker, manager } = harness();
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 85 }]
  });
  let mutated = false;
  manager.prepareHook = () => {
    if (mutated) return;
    mutated = true;
    manager.mutate(state => { state['世界·天气'] = '雷雨'; });
  };

  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_STALE')
  );
  assert.equal(manager.commitCount, 0);
  assert.equal(manager.state['属性·当前查克拉'], 40);
  assert.equal(manager.state['世界·天气'], '雷雨');
});

await test('staging signs caller context without allowing state binding fields to be overridden', async () => {
  const { adapter, manager } = harness();
  const context = {
    timelineImpact: {
      type: 'maintenance-checkpoint',
      createsNode: true
    }
  };
  const proposal = await adapter.stage({
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 71 }]
  }, { now: 1_000_000, context });

  assert.deepEqual(proposal.context.timelineImpact, context.timelineImpact);
  assert.equal(proposal.context.nodeId, 'node_0007_test');
  assert.equal(proposal.context.branchId, 'branch_main');
  assert.equal(proposal.context.stateRevision, 0);
  assert.equal(manager.commitCount, 0);

  for (const key of ['nodeId', 'branchId', 'stateRevision']) {
    await assert.rejects(
      () => adapter.stage({
        updates: [{ path: 'attributes.chakra_current', op: 'set', value: 71 }]
      }, { context: { [key]: 'forged' } }),
      errorCode('LINGXI_PROPOSAL_INVALID')
    );
  }
});

await test('expired proposals cannot write state', async () => {
  const { broker, manager, advance } = harness();
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 70 }]
  });
  advance(90_000);
  await assert.rejects(
    () => broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_EXPIRED')
  );
  assert.equal(manager.commitCount, 0);
  assert.equal(manager.state['属性·当前查克拉'], 40);
});

await test('simultaneous approval submissions consume a proposal only once', async () => {
  const { broker, manager } = harness();
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 65 }]
  });
  const attempts = await Promise.allSettled([
    broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' })
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  assert.equal(manager.commitCount, 1);
  assert.equal(manager.state['属性·当前查克拉'], 65);
});

await test('checkpoint wrappers can forward the broker-owned proposal without exposing approval', async () => {
  const manager = new MemoryStateManager();
  const stateAdapter = new StateVariableActionAdapter(manager);
  const wrapper = {
    toolName: LINGXI_VARIABLE_PATCH_TOOL,
    stage: (params, options) => stateAdapter.stage(params, options),
    apply: proposal => stateAdapter.apply(proposal)
  };
  const broker = new ToolApprovalBroker({
    adapters: [wrapper],
    isTrustedUserEvent: event => event === trustedEvent
  });
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 68 }]
  });

  await assert.rejects(
    () => stateAdapter.apply(proposal),
    errorCode('LINGXI_APPROVAL_REQUIRED')
  );
  await broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' });
  assert.equal(manager.state['属性·当前查克拉'], 68);
  assert.equal(manager.commitCount, 1);
});

await test('controller chat yes never approves; one trusted confirmation writes and checkpoints', async () => {
  const { manager, controller, checkpointCalls } = controllerHarness();
  const proposal = await controller.stageVariableChange({
    key: '属性·当前查克拉',
    value: 78,
    reason: '修复当前查克拉'
  });
  assert.deepEqual(proposal.context.timelineImpact, timelineImpact());

  const chatResult = await controller.send('yes');
  assert.equal(chatResult.mode, 'local-safety');
  assert.match(chatResult.message.content, /聊天/);
  assert.equal(manager.state['属性·当前查克拉'], 40);
  assert.equal(manager.commitCount, 0);
  assert.equal(checkpointCalls.length, 0);

  const receipt = await controller.approveProposal(trustedSubmitEvent, { proposalId: proposal.id });
  assert.equal(manager.state['属性·当前查克拉'], 78);
  assert.equal(manager.commitCount, 1);
  assert.equal(checkpointCalls.length, 1);
  assert.equal(checkpointCalls[0].proposalId, proposal.id);
  assert.equal(checkpointCalls[0].stateSnapshot['属性·当前查克拉'], 78);
  assert.deepEqual(checkpointCalls[0].expectedImpact, timelineImpact());
  assert.equal(receipt.checkpoint.nodeId, 'node_lingxi_checkpoint');
  assert.equal(receipt.checkpoint.undo.nodeId, 'node_0007_test');
});

await test('controller binds exact IF-branch impact and rejects a changed timeline before state write', async () => {
  const { manager, controller, checkpointCalls, setTimelineImpact } = controllerHarness();
  const proposal = await controller.stageVariableChange({
    key: '属性·当前查克拉', value: 77, reason: '时间线影响绑定测试'
  });
  setTimelineImpact({ createsIfBranch: true, branchName: 'IF线·另一种未来' });

  await assert.rejects(
    () => controller.approveProposal(trustedSubmitEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_STALE')
  );
  assert.equal(manager.state['属性·当前查克拉'], 40);
  assert.equal(manager.commitCount, 0);
  assert.equal(checkpointCalls.length, 0);
});

await test('controller stale, expired, and replayed proposals perform no extra writes or checkpoints', async () => {
  {
    const { manager, controller, checkpointCalls } = controllerHarness();
    const proposal = await controller.stageVariableChange({
      key: '属性·当前查克拉', value: 79, reason: '过期测试'
    });
    controller.approvalBroker.now = () => proposal.expiresAt;
    await assert.rejects(
      () => controller.approveProposal(trustedSubmitEvent, { proposalId: proposal.id, confirmation: 'yes' }),
      errorCode('LINGXI_PROPOSAL_EXPIRED')
    );
    assert.equal(manager.state['属性·当前查克拉'], 40);
    assert.equal(manager.commitCount, 0);
    assert.equal(checkpointCalls.length, 0);
  }

  {
    const { manager, controller, checkpointCalls } = controllerHarness();
    const proposal = await controller.stageVariableChange({
      key: '属性·当前查克拉', value: 81, reason: '状态漂移测试'
    });
    manager.mutate(state => { state['世界·天气'] = '雨'; });
    await assert.rejects(
      () => controller.approveProposal(trustedSubmitEvent, { proposalId: proposal.id, confirmation: 'yes' }),
      errorCode('LINGXI_PROPOSAL_STALE')
    );
    assert.equal(manager.state['属性·当前查克拉'], 40);
    assert.equal(manager.commitCount, 0);
    assert.equal(checkpointCalls.length, 0);
  }

  {
    const { manager, controller, checkpointCalls } = controllerHarness();
    const proposal = await controller.stageVariableChange({
      key: '属性·当前查克拉', value: 82, reason: '重放测试'
    });
    await controller.approveProposal(trustedSubmitEvent, { proposalId: proposal.id, confirmation: 'yes' });
    const commitsAfterApply = manager.commitCount;
    await assert.rejects(
      () => controller.approveProposal(trustedSubmitEvent, { proposalId: proposal.id, confirmation: 'yes' }),
      errorCode('LINGXI_PROPOSAL_REPLAYED')
    );
    assert.equal(manager.state['属性·当前查克拉'], 82);
    assert.equal(manager.commitCount, commitsAfterApply);
    assert.equal(checkpointCalls.length, 1);
  }
});

await test('controller restores the exact pre-write snapshot when checkpoint creation fails', async () => {
  const checkpointError = Object.assign(new Error('时间线写入失败'), { code: 'TIMELINE_WRITE_FAILED' });
  const { manager, controller, checkpointCalls } = controllerHarness({ checkpointError });
  const before = manager.snapshot();
  const proposal = await controller.stageVariableChange({
    key: '属性·当前查克拉', value: 83, reason: '回滚测试'
  });

  await assert.rejects(
    () => controller.approveProposal(trustedSubmitEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('TIMELINE_WRITE_FAILED')
  );
  assert.deepEqual(manager.snapshot(), before);
  assert.equal(checkpointCalls.length, 1);
  await assert.rejects(
    () => controller.approveProposal(trustedSubmitEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_PROPOSAL_REPLAYED')
  );
  assert.deepEqual(manager.snapshot(), before);
});

await test('controller preserves concurrent state and reports a rollback conflict when checkpoint creation loses CAS', async () => {
  const checkpointError = Object.assign(new Error('时间线 CAS 失败'), { code: 'TIMELINE_CAS_LOST' });
  const { manager, controller, checkpointCalls } = controllerHarness({
    checkpointError,
    checkpointHook: ({ manager: checkpointManager }) => {
      checkpointManager.mutate(state => { state._concurrent_commit = 'must-survive'; });
    }
  });
  const proposal = await controller.stageVariableChange({
    key: '属性·当前查克拉', value: 84, reason: '并发回滚保护测试'
  });

  await assert.rejects(
    () => controller.approveProposal(trustedSubmitEvent, { proposalId: proposal.id, confirmation: 'yes' }),
    errorCode('LINGXI_ROLLBACK_CONFLICT')
  );
  assert.equal(checkpointCalls.length, 1);
  assert.equal(manager.state['属性·当前查克拉'], 84);
  assert.equal(manager.state._concurrent_commit, 'must-survive');
});

await test('mutating the public proposal copy cannot change the broker-owned action', async () => {
  const { broker, manager } = harness();
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    updates: [{ path: 'attributes.chakra_current', op: 'set', value: 60 }]
  });
  proposal.params.updates[0].value = 999;
  proposal.diff[0].after = 999;
  await broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' });
  assert.equal(manager.state['属性·当前查克拉'], 60);
  assert.equal(manager.commitCount, 1);
});

await test('structured skill, reputation, and map updates use only mapped state fields', async () => {
  const { broker, manager } = harness();
  const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
    updates: [
      { path: 'progression.reputation.木叶隐村', op: 'set', value: 12 },
      { path: 'world_state.map.explored_regions', op: 'push', value: '终末之谷' },
      {
        path: 'world_state.map.known_locations', op: 'assign', key: '终末之谷',
        value: { x: 12, y: 24, desc: '火之国边境地标', tier: 'B' }
      },
      {
        path: 'skills.jutsu.风遁试作', op: 'set',
        value: {
          name: '风遁试作', rank: 'D', element: '风', resource_type: '查克拉',
          cost: 3, power: 5, mastery: 8, description: '测试用风遁。'
        }
      }
    ]
  });
  await broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' });

  assert.equal(manager.state['进度·声望·木叶隐村'], 12);
  assert.equal(manager.state['世界·已探索区域'], '终末之谷');
  assert.deepEqual(manager.state._map.known_locations.终末之谷, {
    x: 12, y: 24, desc: '火之国边境地标', tier: 'B'
  });
  assert.equal(manager.state['技能·忍术·风遁试作·消耗'], 3);
  assert.equal(manager.state['技能·忍术·风遁试作·描述'], '测试用风遁。');
  assert.equal(Object.keys(manager.state).some(key => key.startsWith('skills.')), false);
});

await test('generic variable patches cannot bypass equipment and inventory domain rules', async () => {
  const attempts = [
    { key: '物品·已装备·武器', op: '=', value: '苦无' },
    { key: '物品·消耗品·兵粮丸·数量', op: '-', value: 1 },
    {
      path: 'equipment.tools.烟玉', op: 'set',
      value: { quantity: 2, quality: '普通', description: '制造烟幕。' }
    },
    { path: 'equipment.equipped.weapon', op: 'set', value: '苦无' }
  ];

  for (const update of attempts) {
    const { broker, manager } = harness();
    const before = clone(manager.state);
    await assert.rejects(
      () => broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, { updates: [update] }),
      errorCode('LINGXI_VARIABLE_NOT_WHITELISTED')
    );
    assert.deepEqual(manager.state, before);
    assert.equal(manager.commitCount, 0);
  }
});

await test('opening-contract protected values cannot be staged', async () => {
  const protectedState = baseState({
    _opening_contract: {
      version: 2,
      protected_fields: { '属性·当前查克拉': 40 },
      completion_policy: { mode: 'fill', explicit_abilities: [], explicit_talents: [], explicit_equipment: [] },
      raw: {}
    }
  });
  const { broker, manager } = harness({ state: protectedState });
  await assert.rejects(
    () => broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
      updates: [{ path: 'attributes.chakra_current', op: 'set', value: 55 }]
    }),
    errorCode('LINGXI_OPENING_CONTRACT_BLOCKED')
  );
  assert.equal(manager.commitCount, 0);
  assert.equal(manager.state['属性·当前查克拉'], 40);
});

await test('real restore-derived combat changes are included in the approved diff', async () => {
  const originalState = stateManager.snapshot();
  const originalVersion = stateManager._stateVersion;
  try {
    const state = stateManager.getDefaultState();
    Object.assign(state, {
      '玩家·战力等级': 'E级',
      '属性·查克拉': 5,
      '属性·当前查克拉': 5,
      '属性·生命力': 5,
      '属性·当前生命力': 5,
      '属性·体力': 5,
      '属性·当前体力': 5,
      '属性·精神力': 5,
      '属性·当前精神力': 5,
      '属性·速度': 5,
      '属性·幸运': 5,
      '进度·忍术熟练度': 0,
      '进度·体术熟练度': 0,
      '进度·幻术熟练度': 0
    });
    state._meta.current_node_id = 'node_derived_diff';
    stateManager.state = state;
    stateManager._stateVersion = originalVersion + 1;
    const before = stateManager.snapshot();

    const adapter = new StateVariableActionAdapter(stateManager);
    const broker = new ToolApprovalBroker({
      adapters: [adapter],
      isTrustedUserEvent: event => event === trustedEvent
    });
    const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
      updates: [{ key: '属性·速度', op: '=', value: 9999 }],
      reason: '派生战力审批测试'
    });

    assert.deepEqual(
      proposal.diff.find(entry => entry.path === '/属性·速度'),
      { path: '/属性·速度', operation: 'replace', before: 5, after: 9999 }
    );
    assert.deepEqual(
      proposal.diff.find(entry => entry.path === '/玩家·战力等级'),
      { path: '/玩家·战力等级', operation: 'replace', before: 'E级', after: '超S级' }
    );

    const receipt = await broker.approveFromUserEvent(trustedEvent, {
      proposalId: proposal.id,
      confirmation: 'yes'
    });
    const after = stateManager.snapshot();
    assert.equal(after['属性·速度'], 9999);
    assert.equal(after['玩家·战力等级'], '超S级');
    assert.deepEqual(receipt.diff, proposal.diff);
    assert.deepEqual(buildExactStateDiff(before, after), proposal.diff);
  } finally {
    stateManager.state = originalState;
    stateManager._stateVersion = originalVersion + 2;
  }
});

await test('the adapter commits through the real StateManager atomic restore API', async () => {
  const originalState = stateManager.snapshot();
  const originalVersion = stateManager._stateVersion;
  try {
    const state = stateManager.getDefaultState();
    state._meta.current_node_id = 'node_real_manager';
    state['系统·回合数'] = 8;
    state['属性·查克拉'] = 100;
    state['属性·当前查克拉'] = 40;
    stateManager.state = state;
    stateManager._stateVersion = originalVersion + 1;

    const adapter = new StateVariableActionAdapter(stateManager);
    const broker = new ToolApprovalBroker({
      adapters: [adapter],
      isTrustedUserEvent: event => event === trustedEvent
    });
    const proposal = await broker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
      updates: [{ path: 'attributes.chakra_current', op: 'set', value: 77 }]
    });
    await broker.approveFromUserEvent(trustedEvent, { proposalId: proposal.id, confirmation: 'yes' });

    assert.equal(stateManager.snapshot()['属性·当前查克拉'], 77);
    assert.equal(stateManager.snapshot()._meta.current_node_id, 'node_real_manager');
  } finally {
    stateManager.state = originalState;
    stateManager._stateVersion = originalVersion + 2;
  }
});

await test('a late tool call cannot edit a different save loaded during the request', async () => {
  const { manager, controller, checkpointCalls, setTimelineImpact } = controllerHarness({ autoApplyLowRisk: true });
  manager.getAPIConfig = () => ({ backend: 'custom', model: 'test', apiUrl: 'https://test.invalid/v1' });
  controller.runtime = {
    configure() {},
    async runAgent({ tools }) {
      manager.mutate(state => { state._meta.current_node_id = 'node_other_save'; });
      setTimelineImpact({ parentNodeId: 'node_other_save' });
      await tools.stage_variable_change.execute({ key: '属性·当前查克拉', value: 65, reason: '恢复少量查克拉' });
      return { text: '完成', mode: 'native-tools' };
    }
  };
  await assert.rejects(controller.send('把当前查克拉设为 65'), errorCode('LINGXI_CONTEXT_CHANGED'));
  assert.equal(manager.get('属性·当前查克拉'), 40);
  assert.equal(checkpointCalls.length, 0);
  assert.equal(controller.approvalBroker.listPendingProposals().length, 0);
  assert.equal(controller.isActive, false);
});

await test('switching saves while staging discards the stale proposal before auto apply', async () => {
  const { manager, controller, setTimelineImpact } = controllerHarness({ autoApplyLowRisk: true });
  manager.getAPIConfig = () => ({ backend: 'custom', model: 'test', apiUrl: 'https://test.invalid/v1' });
  const originalStage = controller.approvalBroker.stageAction.bind(controller.approvalBroker);
  controller.approvalBroker.stageAction = async (...args) => {
    manager.mutate(state => { state._meta.current_node_id = 'node_other_save'; });
    setTimelineImpact({ parentNodeId: 'node_other_save' });
    return originalStage(...args);
  };
  controller.runtime = {
    configure() {},
    async runAgent({ tools }) {
      await tools.stage_variable_change.execute({ key: '属性·当前查克拉', value: 65, reason: '恢复少量查克拉' });
      return { text: '完成', mode: 'native-tools' };
    }
  };
  await assert.rejects(controller.send('把当前查克拉设为 65'), errorCode('LINGXI_CONTEXT_CHANGED'));
  assert.equal(manager.get('属性·当前查克拉'), 40);
  assert.equal(controller.approvalBroker.listPendingProposals().length, 0);
});

await test('fallback after a real auto-applied write keeps its receipt and does not deny the write', async () => {
  const { manager, controller, checkpointCalls } = controllerHarness({ autoApplyLowRisk: true });
  manager.getAPIConfig = () => ({ backend: 'custom', model: 'test', apiUrl: 'https://test.invalid/v1' });
  const calls = [];
  const responses = ['invalid protocol', '查克拉已恢复到 65。'];
  controller.runtime = new AgentToolRuntime({
    contextBroker: new LingXiContextBroker(),
    sdk: {
      async runAgent({ tools }) {
        await tools.stage_variable_change.execute({ key: '属性·当前查克拉', value: 65, reason: '恢复少量查克拉' });
        throw new Error('connection lost after the tool finished');
      }
    },
    clientFactory: () => ({
      configure() {}, isConfigured: () => true,
      async chat(messages) { calls.push(clone(messages)); return responses.shift(); }
    })
  });
  const result = await controller.send('把当前查克拉设为 65');
  assert.equal(manager.get('属性·当前查克拉'), 65);
  assert.equal(checkpointCalls.length, 1);
  assert.equal(result.mode, 'plain-chat');
  assert.doesNotMatch(result.message.content, /没有修改设置或存档/);
  assert.match(result.message.content, /执行回执/);
  assert.match(JSON.stringify(calls.at(-1)), /applied-automatically/);
});

await test('valid sequential writes in one request do not invalidate each other', async () => {
  const { manager, controller, checkpointCalls } = controllerHarness({ autoApplyLowRisk: true });
  manager.getAPIConfig = () => ({ backend: 'custom', model: 'test', apiUrl: 'https://test.invalid/v1' });
  controller.runtime = {
    configure() {},
    async runAgent({ tools }) {
      for (const value of [60, 65]) {
        await tools.stage_variable_change.execute({ key: '属性·当前查克拉', value, reason: '按用户要求调整' });
      }
      return { text: '完成两步调整', mode: 'native-tools' };
    }
  };
  await controller.send('先将当前查克拉设为 60，再设为 65');
  assert.equal(manager.get('属性·当前查克拉'), 65);
  assert.equal(checkpointCalls.length, 2);
});

await test('importing a save with the same node ids still cancels the old request', async () => {
  const { manager, controller } = controllerHarness({ autoApplyLowRisk: true });
  manager.getAPIConfig = () => ({ backend: 'custom', model: 'test', apiUrl: 'https://test.invalid/v1' });
  controller.runtime = {
    configure() {},
    async runAgent({ tools }) {
      eventBus.emit('timeline:imported', { importedCount: 1 });
      await tools.stage_variable_change.execute({ key: '属性·当前查克拉', value: 65, reason: '恢复少量查克拉' });
      return { text: '完成', mode: 'native-tools' };
    }
  };
  await assert.rejects(controller.send('把当前查克拉设为 65'), errorCode('LINGXI_CONTEXT_CHANGED'));
  assert.equal(manager.get('属性·当前查克拉'), 40);
  assert.equal(controller.isActive, false);
  // A cancelled turn must leave no subscriptions that poison the next turn.
  controller.runtime.runAgent = async () => ({ text: '新档已就绪', mode: 'native-tools' });
  assert.equal((await controller.send('你好')).message.content, '新档已就绪');
});

if (failures.length) {
  console.error(`\n${failures.length} Ling Xi approval regression test(s) failed; ${passed} passed.`);
  process.exitCode = 1;
} else {
  console.log(`\nLing Xi approval broker regression passed (${passed} tests).`);
}
