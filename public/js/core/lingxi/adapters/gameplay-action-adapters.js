import { stateManager as defaultStateManager } from '../../state-manager.js';
import {
  EquipmentSystem,
  equipmentSystem as defaultEquipmentSystem
} from '../../../systems/equipment-system.js';
import {
  MissionSystem,
  missionSystem as defaultMissionSystem
} from '../../../systems/mission-system.js';
import { VAR_SCHEMA } from '../../../data/var-schema.js';
import {
  LingXiActionError,
  canonicalStringify,
  createActionProposal,
  fingerprintValue,
  hashCanonical,
  verifyActionProposal
} from '../action-proposal.js';
import { consumeBrokerApprovedProposal } from '../approval-broker.js';
import { LINGXI_ACTION_IMPACT_SCHEMA } from './project-write-adapters.js';
import { buildExactStateDiff } from './state-adapter.js';

export const LINGXI_EQUIPMENT_ACTION_TOOL = 'perform_equipment_action';
export const LINGXI_MISSION_ACTION_TOOL = 'perform_mission_action';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EQUIPMENT_CATEGORIES = Object.freeze(['weapons', 'armor', 'tools', 'consumables']);
const EQUIPMENT_SLOTS = Object.freeze(['weapon', 'armor', 'accessory1', 'accessory2']);
const SLOT_CATEGORY = Object.freeze({
  weapon: 'weapons',
  armor: 'armor',
  accessory1: 'tools',
  accessory2: 'tools'
});
const CATEGORY_LABEL = Object.freeze({
  weapons: '武器',
  armor: '防具',
  tools: '道具',
  consumables: '消耗品'
});
const SLOT_STATE_KEY = Object.freeze({
  weapon: '物品·已装备·武器',
  armor: '物品·已装备·防具',
  accessory1: '物品·已装备·饰品1',
  accessory2: '物品·已装备·饰品2'
});
const RESOURCE_KEYS = Object.freeze([
  '属性·查克拉',
  '属性·当前查克拉',
  '属性·精神力',
  '属性·当前生命力',
  '属性·当前体力',
  '属性·当前精神力',
  '属性·生命力',
  '属性·体力',
  '属性·速度',
  '属性·幸运'
]);
const MISSION_STATUS = Object.freeze({
  complete: 'completed',
  fail: 'failed',
  abandon: 'abandoned'
});

function fail(code, message, details = null) {
  throw new LingXiActionError(code, message, details);
}

function clone(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, allowed, label) {
  if (!isRecord(value)) fail('LINGXI_INPUT_INVALID', `${label}必须是对象`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) {
      fail('LINGXI_INPUT_INVALID', `${label}包含不支持的字段: ${key}`);
    }
  }
}

function cleanText(value, label, max = 200, { required = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    fail('LINGXI_INPUT_INVALID', `${label}必须是文本`);
  }
  const result = String(value || '').replace(/\u0000/g, '').trim();
  if ((required && !result) || result.length > max) {
    fail('LINGXI_INPUT_INVALID', `${label}必须是${required ? '非空' : ''}且不超过 ${max} 个字符的文本`);
  }
  return result;
}

function publicContext(context, actionImpact) {
  const result = { actionImpact };
  if (context?.timelineImpact && isRecord(context.timelineImpact)) {
    result.timelineImpact = clone(context.timelineImpact);
  }
  return result;
}

function actionImpact(kind, summary, details) {
  return {
    schema: LINGXI_ACTION_IMPACT_SCHEMA,
    kind,
    summary: cleanText(summary, '影响摘要', 240),
    details: details.map(item => cleanText(item, '影响明细', 500)).slice(0, 20)
  };
}

function receipt(proposal, afterFingerprint, diff, summary) {
  return {
    schema: 'naruto.lingxi-action-receipt/v1',
    proposalId: proposal.id,
    tool: proposal.tool,
    appliedAt: Date.now(),
    beforeFingerprint: proposal.stateFingerprint,
    afterFingerprint,
    diff: clone(diff),
    summary
  };
}

async function assertDiffBinding(proposal, diff, label) {
  if (await hashCanonical(diff) !== proposal.diffHash) {
    fail('LINGXI_PROPOSAL_TAMPERED', `${label}的重新计算差异与已批准提案不一致`);
  }
}

class BrokerOnlyAdapter {
  #approvalPermit = null;

  bindApprovalPermit(permit) {
    if (!permit || typeof permit !== 'object') fail('LINGXI_ADAPTER_INVALID', '审批许可必须是不透明对象');
    if (this.#approvalPermit && this.#approvalPermit !== permit) {
      fail('LINGXI_ADAPTER_INVALID', '领域操作适配器已绑定到另一个审批 Broker');
    }
    this.#approvalPermit = permit;
  }

  async authorize(proposal, approvalPermit) {
    const brokerApproved = consumeBrokerApprovedProposal(proposal);
    const directlyBound = this.#approvalPermit && approvalPermit === this.#approvalPermit;
    if (!brokerApproved || (this.#approvalPermit && !directlyBound)) {
      fail('LINGXI_APPROVAL_REQUIRED', '该操作只能由绑定的审批 Broker 执行');
    }
    await verifyActionProposal(proposal);
    if (proposal.tool !== this.toolName) {
      fail('LINGXI_PROPOSAL_INVALID', `${this.toolName} 适配器不能执行 ${proposal.tool}`);
    }
  }
}

function stateSnapshot(manager) {
  const state = typeof manager?.snapshot === 'function' ? manager.snapshot() : manager?.get?.();
  return isRecord(state) ? state : {};
}

const SILENT_EVENT_BUS = Object.freeze({ emit() {} });

class ShadowStateManager {
  constructor(state) {
    this.state = clone(state);
  }

  snapshot() {
    return clone(this.state);
  }

  restore(snapshot) {
    this.state = clone(snapshot);
  }

  get(key) {
    return key === undefined ? clone(this.state) : clone(this.state[key]);
  }

  getSub(key) {
    return clone(this.state[key]);
  }

  setSub(key, value) {
    this.state[key] = clone(value);
  }

  update(updates) {
    if (!Array.isArray(updates) || updates.length === 0) return;
    for (const update of updates) {
      if (!update?.key) continue;
      const key = update.key;
      if (['delete', 'del', 'remove'].includes(update.op)) {
        delete this.state[key];
      } else if (update.op === '=') {
        this.state[key] = clone(update.value);
      } else if (update.op === '+' || update.op === '-') {
        const current = Number(this.state[key]);
        const delta = Number(update.value);
        if (!Number.isFinite(current) || !Number.isFinite(delta)) continue;
        this.state[key] = update.op === '-'
          ? Math.max(0, current - delta)
          : current + delta;
      }
    }
    this._enforceDomainBounds();
  }

  _enforceDomainBounds() {
    for (const [currentKey, maxKey] of [
      ['属性·当前查克拉', '属性·查克拉'],
      ['属性·当前精神力', '属性·精神力'],
      ['属性·当前生命力', '属性·生命力'],
      ['属性·当前体力', '属性·体力']
    ]) {
      if (typeof this.state[currentKey] !== 'number' || Number.isNaN(this.state[currentKey])) continue;
      const maximum = Math.max(0, Number(this.state[maxKey]) || 0);
      this.state[currentKey] = Math.max(0, Math.min(this.state[currentKey], maximum));
    }

    for (const [key, definition] of Object.entries(VAR_SCHEMA)) {
      if (definition.type !== 'number' || typeof this.state[key] !== 'number' || Number.isNaN(this.state[key])) {
        continue;
      }
      const minimum = definition.min == null ? -Infinity : definition.min;
      const maximum = definition.max == null ? Infinity : definition.max;
      this.state[key] = Math.max(minimum, Math.min(maximum, this.state[key]));
    }

    let levelGuard = 0;
    while (
      typeof this.state['进度·经验'] === 'number'
      && typeof this.state['进度·下一级经验'] === 'number'
      && this.state['进度·经验'] >= this.state['进度·下一级经验']
      && levelGuard < 50
    ) {
      const needed = this.state['进度·下一级经验'];
      this.state['进度·经验'] = Math.max(0, this.state['进度·经验'] - needed);
      this.state['进度·下一级经验'] = Math.max(1, Math.round(needed * 1.4));
      this.state['进度·突破待处理'] = (this.state['进度·突破待处理'] || 0) + 1;
      levelGuard += 1;
    }

    for (const key of Object.keys(this.state)) {
      if (!key.startsWith('物品·') || !key.endsWith('·数量')) continue;
      if (typeof this.state[key] !== 'number' || Number.isNaN(this.state[key])) continue;
      this.state[key] = Math.max(0, this.state[key]);
      if (this.state[key] <= 0) delete this.state[key];
    }

    if (this.state['玩家·存活'] !== '否'
      && typeof this.state['属性·当前生命力'] === 'number'
      && this.state['属性·当前生命力'] <= 0) {
      this.state['玩家·存活'] = '否';
      this.state['玩家·死因'] ||= '生命力归零';
    }
  }
}

function equipmentRelevantState(state) {
  const values = {};
  for (const key of Object.keys(state).sort()) {
    if (key.startsWith('物品·') || RESOURCE_KEYS.includes(key)) values[key] = clone(state[key]);
  }
  return values;
}

function itemBaseKey(category, name) {
  return `物品·${CATEGORY_LABEL[category]}·${name}`;
}

function itemQuantity(state, category, name) {
  const base = itemBaseKey(category, name);
  const direct = state[`${base}·数量`];
  if (direct !== undefined && direct !== null) return Math.max(0, Number(direct) || 0);
  const legacy = state[base];
  if (isRecord(legacy)) return Math.max(0, Number(legacy.quantity ?? 1) || 0);
  return Object.keys(state).some(key => key.startsWith(`${base}·`)) ? 1 : 0;
}

function normalizeEquipmentParams(params, state) {
  assertOnlyKeys(params, new Set(['action', 'slot', 'name', 'category', 'quantity', 'reason']), '装备操作参数');
  const action = cleanText(params.action, '装备操作', 30);
  if (!['equip', 'unequip', 'use', 'discard'].includes(action)) {
    fail('LINGXI_EQUIPMENT_ACTION_INVALID', `不支持的装备操作: ${action}`);
  }
  const reason = cleanText(params.reason, '操作原因', 500);

  if (action === 'unequip') {
    const slot = cleanText(params.slot, '装备槽', 40);
    if (!EQUIPMENT_SLOTS.includes(slot)) fail('LINGXI_EQUIPMENT_ACTION_INVALID', '装备槽不在白名单中');
    if (params.name !== undefined || params.category !== undefined || params.quantity !== undefined) {
      fail('LINGXI_EQUIPMENT_ACTION_INVALID', '卸下操作只接受 action、slot 和 reason');
    }
    const current = String(state[SLOT_STATE_KEY[slot]] || '').trim();
    if (!current) fail('LINGXI_NO_CHANGES', '该装备槽当前为空');
    return { action, slot, reason };
  }

  const name = cleanText(params.name, '物品名称', 160);
  if (action === 'use') {
    if (params.slot !== undefined || params.category !== undefined || params.quantity !== undefined) {
      fail('LINGXI_EQUIPMENT_ACTION_INVALID', '使用消耗品只接受 action、name 和 reason');
    }
    if (itemQuantity(state, 'consumables', name) < 1) {
      fail('LINGXI_ITEM_UNAVAILABLE', `当前没有可用的消耗品: ${name}`);
    }
    return { action, name, reason };
  }

  const category = cleanText(params.category, '物品分类', 40);
  if (!EQUIPMENT_CATEGORIES.includes(category)) {
    fail('LINGXI_EQUIPMENT_ACTION_INVALID', '物品分类不在白名单中');
  }
  const currentQuantity = itemQuantity(state, category, name);
  if (currentQuantity < 1) fail('LINGXI_ITEM_UNAVAILABLE', `当前背包中不存在该物品: ${name}`);

  if (action === 'equip') {
    const slot = cleanText(params.slot, '装备槽', 40);
    if (!EQUIPMENT_SLOTS.includes(slot) || SLOT_CATEGORY[slot] !== category) {
      fail('LINGXI_EQUIPMENT_ACTION_INVALID', '装备槽与物品分类不匹配');
    }
    if (params.quantity !== undefined) fail('LINGXI_EQUIPMENT_ACTION_INVALID', '装备操作不接受 quantity');
    if (String(state[SLOT_STATE_KEY[slot]] || '').trim() === name) {
      fail('LINGXI_NO_CHANGES', `${name} 已经装备在该槽位`);
    }
    return { action, slot, name, category, reason };
  }

  if (params.slot !== undefined) fail('LINGXI_EQUIPMENT_ACTION_INVALID', '丢弃操作不接受 slot');
  const quantity = params.quantity === undefined ? currentQuantity : Number(params.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > currentQuantity) {
    fail('LINGXI_EQUIPMENT_ACTION_INVALID', `丢弃数量必须是 1 到 ${currentQuantity} 之间的整数`);
  }
  return { action, name, category, quantity, reason };
}

function performEquipmentAction(system, params) {
  if (params.action === 'equip') return system.equip(params.slot, params.name, params.category);
  if (params.action === 'unequip') return system.unequip(params.slot);
  if (params.action === 'use') return system.useItem(params.name);
  return system.removeItem(params.category, params.name, params.quantity);
}

function equipmentImpact(params, state, predicted) {
  if (params.action === 'equip') {
    const previous = String(state[SLOT_STATE_KEY[params.slot]] || '').trim();
    return actionImpact('equipment', `将「${params.name}」装备到 ${params.slot}`, [
      `物品分类: ${params.category}`,
      `原槽位内容: ${previous || '空'}`,
      '批准后由装备系统同步卸下旧装备、装备槽与属性加成。'
    ]);
  }
  if (params.action === 'unequip') {
    const current = String(state[SLOT_STATE_KEY[params.slot]] || '').trim();
    return actionImpact('equipment', `从 ${params.slot} 卸下「${current}」`, [
      '批准后由装备系统同步移除该装备带来的属性加成。'
    ]);
  }
  if (params.action === 'use') {
    const resourceChanges = RESOURCE_KEYS
      .filter(key => !Object.is(state[key], predicted[key]))
      .map(key => `${key}: ${state[key] ?? 0} -> ${predicted[key] ?? 0}`);
    return actionImpact('equipment', `使用 1 个「${params.name}」`, [
      `当前数量: ${itemQuantity(state, 'consumables', params.name)}`,
      `效果: ${resourceChanges.join('，') || '没有可结算的资源变化'}`,
      '批准后会扣除 1 个物品并立即结算资源恢复。'
    ]);
  }
  const equippedSlots = EQUIPMENT_SLOTS.filter(slot => (
    SLOT_CATEGORY[slot] === params.category && state[SLOT_STATE_KEY[slot]] === params.name
  ));
  return actionImpact('equipment', `丢弃 ${params.quantity} 个「${params.name}」`, [
    `物品分类: ${params.category}`,
    `当前数量: ${itemQuantity(state, params.category, params.name)}`,
    equippedSlots.length
      ? `数量归零时会同时从槽位卸下: ${equippedSlots.join('、')}`
      : '该物品当前未装备。',
    '丢弃操作不可撤销，但会随本次审批写入时间线维护记录。'
  ]);
}

export class EquipmentActionAdapter extends BrokerOnlyAdapter {
  constructor({
    stateManager = defaultStateManager,
    equipmentSystem = defaultEquipmentSystem,
    equipmentSystemFactory = null
  } = {}) {
    super();
    if (typeof stateManager?.snapshot !== 'function' || typeof stateManager?.restore !== 'function') {
      fail('LINGXI_ADAPTER_INVALID', '装备适配器需要 snapshot() 和 restore()');
    }
    if (!equipmentSystem || ['equip', 'unequip', 'useItem', 'removeItem'].some(method => (
      typeof equipmentSystem[method] !== 'function'
    ))) {
      fail('LINGXI_ADAPTER_INVALID', '装备适配器需要完整的 EquipmentSystem 领域入口');
    }
    this.manager = stateManager;
    this.equipmentSystem = equipmentSystem;
    this.equipmentSystemFactory = typeof equipmentSystemFactory === 'function'
      ? equipmentSystemFactory
      : dependencies => (
          typeof this.equipmentSystem.createSimulation === 'function'
            ? this.equipmentSystem.createSimulation(dependencies)
            : new EquipmentSystem(dependencies)
        );
    this.toolName = LINGXI_EQUIPMENT_ACTION_TOOL;
  }

  _read() {
    return equipmentRelevantState(stateSnapshot(this.manager));
  }

  _preview(fullState, params) {
    const shadowManager = new ShadowStateManager(fullState);
    const previewSystem = this.equipmentSystemFactory({
      stateManager: shadowManager,
      eventBus: SILENT_EVENT_BUS,
      clock: () => 0
    });
    if (!previewSystem || previewSystem === this.equipmentSystem
      || ['equip', 'unequip', 'useItem', 'removeItem'].some(method => typeof previewSystem[method] !== 'function')) {
      fail('LINGXI_ADAPTER_INVALID', '装备预演必须创建隔离的 EquipmentSystem 实例');
    }
    const result = performEquipmentAction(previewSystem, params);
    if (result && typeof result.then === 'function') {
      fail('LINGXI_ADAPTER_INVALID', '装备领域预演必须同步完成');
    }
    if (result !== true) fail('LINGXI_APPLY_FAILED', '装备系统无法预演该操作');
    return equipmentRelevantState(shadowManager.snapshot());
  }

  async stage(params, { now = Date.now(), ttlMs, context = null } = {}) {
    const fullBefore = this.manager.snapshot();
    const before = equipmentRelevantState(fullBefore);
    const normalized = normalizeEquipmentParams(params, before);
    const predicted = this._preview(fullBefore, normalized);
    const diff = buildExactStateDiff(before, predicted);
    if (!diff.length) fail('LINGXI_NO_CHANGES', '装备领域预演没有产生状态变化');
    const proposal = await createActionProposal({
      tool: this.toolName,
      params: normalized,
      stateFingerprint: await fingerprintValue(before),
      context: publicContext(context, equipmentImpact(normalized, before, predicted)),
      diff,
      ttlMs,
      now
    });
    if (canonicalStringify(this._read()) !== canonicalStringify(before)) {
      fail('LINGXI_PROPOSAL_STALE', '装备状态在提案生成期间发生了变化');
    }
    return proposal;
  }

  async apply(proposal, approvalPermit) {
    await this.authorize(proposal, approvalPermit);
    const fullBefore = this.manager.snapshot();
    const before = equipmentRelevantState(fullBefore);
    if (await fingerprintValue(before) !== proposal.stateFingerprint) {
      fail('LINGXI_PROPOSAL_STALE', '装备或资源状态已经变化，请重新生成提案');
    }
    if (canonicalStringify(this._read()) !== canonicalStringify(before)) {
      fail('LINGXI_PROPOSAL_STALE', '装备或资源状态在批准期间发生了变化');
    }
    const normalized = normalizeEquipmentParams(proposal.params, before);
    const predicted = this._preview(fullBefore, normalized);
    const diff = buildExactStateDiff(before, predicted);
    if (!diff.length) fail('LINGXI_NO_CHANGES', '装备领域预演没有产生状态变化');
    await assertDiffBinding(proposal, diff, '装备操作');
    if (canonicalStringify(this._read()) !== canonicalStringify(before)) {
      fail('LINGXI_PROPOSAL_STALE', '装备或资源状态在批准期间发生了变化');
    }
    if (canonicalStringify(this.manager.snapshot()) !== canonicalStringify(fullBefore)) {
      fail('LINGXI_PROPOSAL_STALE', '项目状态在装备操作批准期间发生了变化');
    }

    try {
      const result = performEquipmentAction(this.equipmentSystem, normalized);
      if (result && typeof result.then === 'function') {
        fail('LINGXI_ADAPTER_INVALID', '装备领域操作必须同步完成');
      }
      if (result !== true) fail('LINGXI_APPLY_FAILED', '装备系统没有接受已批准的操作');
      const after = this._read();
      const actualDiff = buildExactStateDiff(before, after);
      if (canonicalStringify(actualDiff) !== canonicalStringify(diff)) {
        fail('LINGXI_APPLY_MISMATCH', '装备系统的实际状态变化与已批准差异不一致');
      }
      return receipt(
        proposal,
        await fingerprintValue(after),
        actualDiff,
        normalized.action === 'use' ? `已使用「${normalized.name}」` : `装备操作已完成: ${normalized.action}`
      );
    } catch (error) {
      if (canonicalStringify(this.manager.snapshot()) !== canonicalStringify(fullBefore)) {
        this.manager.restore(fullBefore);
      }
      throw error;
    }
  }
}

function missionRelevantState(state) {
  return {
    missions: clone(state._missions || {}),
    resources: Object.fromEntries(Object.keys(state)
      .filter(key => key.startsWith('进度·'))
      .sort()
      .map(key => [key, clone(state[key])]))
  };
}

function normalizeMissionParams(params, state, { stored = false } = {}) {
  assertOnlyKeys(
    params,
    new Set(stored ? ['action', 'missionId', 'reason', 'status'] : ['action', 'missionId', 'reason']),
    '任务操作参数'
  );
  const action = cleanText(params.action, '任务操作', 30);
  const status = MISSION_STATUS[action];
  if (!status) fail('LINGXI_MISSION_ACTION_INVALID', `不支持的任务操作: ${action}`);
  if (stored && params.status !== status) {
    fail('LINGXI_PROPOSAL_TAMPERED', '任务目标状态与已批准操作不匹配');
  }
  const missionId = cleanText(params.missionId, '任务 ID', 200);
  const reason = cleanText(params.reason, '操作原因', 500);
  const mission = state?.missions?.active?.[missionId];
  if (!isRecord(mission)) fail('LINGXI_MISSION_UNAVAILABLE', '该任务不在当前进行中任务列表里');
  return { action, missionId, reason, status };
}

function performMissionAction(system, params, now) {
  return system.processInstruction({
    id: params.missionId,
    status: params.status
  }, { now });
}

function missionImpact(params, state) {
  const mission = state.missions.active[params.missionId];
  const title = cleanText(String(mission.title || mission.name || params.missionId), '任务标题', 200);
  const details = [`任务 ID: ${params.missionId}`, `当前状态: ${mission.status || 'active'}`];
  if (params.action === 'complete') {
    details.push(`结算奖励: 经验 ${Number(mission.reward_exp) || 0}，金钱 ${Number(mission.reward_ryo) || 0}`);
    details.push('批准后任务会移入完成记录，并更新完成统计与奖励资源。');
  } else if (params.action === 'fail') {
    details.push('批准后任务会移入失败记录，并更新失败统计。');
  } else {
    details.push('批准后任务会移入放弃记录，并更新放弃统计。');
  }
  return actionImpact('mission', `${title}: ${params.status}`, details);
}

export class MissionActionAdapter extends BrokerOnlyAdapter {
  constructor({
    stateManager = defaultStateManager,
    missionSystem = defaultMissionSystem,
    missionSystemFactory = null
  } = {}) {
    super();
    if (typeof stateManager?.snapshot !== 'function' || typeof stateManager?.restore !== 'function') {
      fail('LINGXI_ADAPTER_INVALID', '任务适配器需要 snapshot() 和 restore()');
    }
    if (typeof missionSystem?.processInstruction !== 'function') {
      fail('LINGXI_ADAPTER_INVALID', '任务适配器需要 MissionSystem.processInstruction()');
    }
    this.manager = stateManager;
    this.missionSystem = missionSystem;
    this.missionSystemFactory = typeof missionSystemFactory === 'function'
      ? missionSystemFactory
      : dependencies => (
          typeof this.missionSystem.createSimulation === 'function'
            ? this.missionSystem.createSimulation(dependencies)
            : new MissionSystem(dependencies)
        );
    this.toolName = LINGXI_MISSION_ACTION_TOOL;
  }

  _read() {
    return missionRelevantState(stateSnapshot(this.manager));
  }

  _preview(fullState, params, now) {
    const shadowManager = new ShadowStateManager(fullState);
    const previewSystem = this.missionSystemFactory({
      stateManager: shadowManager,
      eventBus: SILENT_EVENT_BUS,
      clock: () => now
    });
    if (!previewSystem || previewSystem === this.missionSystem
      || typeof previewSystem.processInstruction !== 'function') {
      fail('LINGXI_ADAPTER_INVALID', '任务预演必须创建隔离的 MissionSystem 实例');
    }
    const result = performMissionAction(previewSystem, params, now);
    if (result && typeof result.then === 'function') {
      fail('LINGXI_ADAPTER_INVALID', '任务领域预演必须同步完成');
    }
    return missionRelevantState(shadowManager.snapshot());
  }

  async stage(params, { now = Date.now(), ttlMs, context = null } = {}) {
    const fullBefore = this.manager.snapshot();
    const before = missionRelevantState(fullBefore);
    const normalized = normalizeMissionParams(params, before);
    const predicted = this._preview(fullBefore, normalized, now);
    const diff = buildExactStateDiff(before, predicted);
    if (!diff.length) fail('LINGXI_APPLY_FAILED', '任务系统无法预演该操作');
    const proposal = await createActionProposal({
      tool: this.toolName,
      params: normalized,
      stateFingerprint: await fingerprintValue(before),
      context: publicContext(context, missionImpact(normalized, before)),
      diff,
      ttlMs,
      now
    });
    if (canonicalStringify(this._read()) !== canonicalStringify(before)) {
      fail('LINGXI_PROPOSAL_STALE', '任务状态在提案生成期间发生了变化');
    }
    return proposal;
  }

  async apply(proposal, approvalPermit) {
    await this.authorize(proposal, approvalPermit);
    const fullBefore = this.manager.snapshot();
    const before = missionRelevantState(fullBefore);
    if (await fingerprintValue(before) !== proposal.stateFingerprint) {
      fail('LINGXI_PROPOSAL_STALE', '任务或奖励状态已经变化，请重新生成提案');
    }
    if (canonicalStringify(this._read()) !== canonicalStringify(before)) {
      fail('LINGXI_PROPOSAL_STALE', '任务或奖励状态在批准期间发生了变化');
    }
    const normalized = normalizeMissionParams(proposal.params, before, { stored: true });
    const predicted = this._preview(fullBefore, normalized, proposal.createdAt);
    const diff = buildExactStateDiff(before, predicted);
    if (!diff.length) fail('LINGXI_APPLY_FAILED', '任务系统无法预演该操作');
    await assertDiffBinding(proposal, diff, '任务操作');
    if (canonicalStringify(this._read()) !== canonicalStringify(before)) {
      fail('LINGXI_PROPOSAL_STALE', '任务或奖励状态在批准期间发生了变化');
    }
    if (canonicalStringify(this.manager.snapshot()) !== canonicalStringify(fullBefore)) {
      fail('LINGXI_PROPOSAL_STALE', '项目状态在任务操作批准期间发生了变化');
    }

    try {
      const result = performMissionAction(this.missionSystem, normalized, proposal.createdAt);
      if (result && typeof result.then === 'function') {
        fail('LINGXI_ADAPTER_INVALID', '任务领域操作必须同步完成');
      }
      const after = this._read();
      const active = after.missions?.active?.[normalized.missionId];
      const targetCollection = normalized.status === 'completed' ? 'completed' : 'failed';
      const settled = after.missions?.[targetCollection]?.[normalized.missionId];
      if (active || !isRecord(settled) || settled.status !== normalized.status) {
        fail('LINGXI_APPLY_FAILED', '任务系统没有按已批准状态完成结算');
      }
      const actualDiff = buildExactStateDiff(before, after);
      if (canonicalStringify(actualDiff) !== canonicalStringify(diff)) {
        fail('LINGXI_APPLY_MISMATCH', '任务系统的实际状态变化与已批准差异不一致');
      }
      return receipt(
        proposal,
        await fingerprintValue(after),
        actualDiff,
        `任务「${settled.title || normalized.missionId}」已标记为 ${normalized.status}`
      );
    } catch (error) {
      if (canonicalStringify(this.manager.snapshot()) !== canonicalStringify(fullBefore)) {
        this.manager.restore(fullBefore);
      }
      throw error;
    }
  }
}

export function createGameplayActionAdapters(options = {}) {
  return [
    new EquipmentActionAdapter(options),
    new MissionActionAdapter(options)
  ];
}

export default createGameplayActionAdapters;
