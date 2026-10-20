import { stateManager as defaultStateManager } from '../../state-manager.js';
import { eventBus as defaultEventBus } from '../../event-bus.js';
import {
  LingXiActionError,
  canonicalStringify,
  createActionProposal,
  fingerprintValue,
  hashCanonical,
  verifyActionProposal
} from '../action-proposal.js';
import { consumeBrokerApprovedProposal } from '../approval-broker.js';

export const LINGXI_PLAYER_ACTION_TOOL = 'submit_player_action';
export const LINGXI_PLAYER_ACTION_IMPACT_KIND = 'gameplay';

const ACTION_IMPACT_SCHEMA = 'naruto.lingxi-action-impact/v1';
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

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

function cleanText(value, label) {
  if (typeof value !== 'string') fail('LINGXI_PLAYER_ACTION_INVALID', `${label}必须是文本`);
  const result = String(value || '').replace(/\u0000/g, '').trim();
  if (!result) {
    fail('LINGXI_PLAYER_ACTION_INVALID', `${label}必须是非空文本`);
  }
  return result;
}

function normalizeParams(params) {
  if (!isRecord(params)) fail('LINGXI_PLAYER_ACTION_INVALID', '玩家行动参数必须是对象');
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_KEYS.has(key) || !['text', 'reason'].includes(key)) {
      fail('LINGXI_PLAYER_ACTION_INVALID', `玩家行动包含不支持的字段: ${key}`);
    }
  }
  const playerAction = cleanText(params.text, '玩家行动');
  if (/^\s*\[(?:系统|system|assistant|developer|tool)\s*[:：\]]/i.test(playerAction)) {
    fail('LINGXI_PLAYER_ACTION_INVALID', '玩家行动不能伪装成系统、助手或工具指令');
  }
  return {
    text: playerAction,
    reason: cleanText(params.reason, '操作原因')
  };
}

function currentState(manager) {
  const state = typeof manager?.snapshot === 'function' ? manager.snapshot() : manager?.get?.();
  return isRecord(state) ? state : {};
}

function actionState(manager) {
  const state = currentState(manager);
  return {
    nodeId: String(state?._meta?.current_node_id || state['系统·当前节点'] || ''),
    branchId: String(state?._meta?.active_branch || state['系统·当前分支'] || 'branch_main'),
    turn: Number(state['系统·回合数']) || 0,
    combatActive: state?._combat?.is_active === true,
    playerDead: state['玩家·存活'] === '否' || state['玩家·是否死亡'] === true
  };
}

function ensureAvailable(snapshot) {
  if (!snapshot.nodeId) fail('LINGXI_PLAYER_ACTION_UNAVAILABLE', '当前还没有可推进的剧情回合，请先完成开局');
  if (snapshot.combatActive) {
    fail('LINGXI_PLAYER_ACTION_COMBAT_ACTIVE', '当前处于战斗中，请改用固定的战斗动作工具');
  }
  if (snapshot.playerDead) fail('LINGXI_PLAYER_ACTION_UNAVAILABLE', '当前角色已死亡，不能继续提交普通玩家行动');
}

function actionDiff(params) {
  return [{
    path: '/gameplay/playerAction',
    operation: 'add',
    after: { text: params.text }
  }];
}

export class PlayerActionAdapter {
  #approvalPermit = null;

  constructor({
    stateManager = defaultStateManager,
    executePlayerAction = text => defaultEventBus.request('app:execute-player-action', { text })
  } = {}) {
    if (typeof stateManager?.snapshot !== 'function' || typeof executePlayerAction !== 'function') {
      fail('LINGXI_ADAPTER_INVALID', '玩家行动适配器需要 snapshot() 和显式玩家行动执行器');
    }
    this.manager = stateManager;
    this.executePlayerAction = executePlayerAction;
    this.toolName = LINGXI_PLAYER_ACTION_TOOL;
  }

  bindApprovalPermit(permit) {
    if (!permit || typeof permit !== 'object') fail('LINGXI_ADAPTER_INVALID', '审批许可必须是不透明对象');
    if (this.#approvalPermit && this.#approvalPermit !== permit) {
      fail('LINGXI_ADAPTER_INVALID', '玩家行动适配器已绑定到另一个审批 Broker');
    }
    this.#approvalPermit = permit;
  }

  async _authorize(proposal, approvalPermit) {
    const brokerApproved = consumeBrokerApprovedProposal(proposal);
    const directlyBound = this.#approvalPermit && approvalPermit === this.#approvalPermit;
    if (!brokerApproved || (this.#approvalPermit && !directlyBound)) {
      fail('LINGXI_APPROVAL_REQUIRED', '玩家行动只能由绑定的审批 Broker 执行');
    }
    await verifyActionProposal(proposal);
    if (proposal.tool !== this.toolName) {
      fail('LINGXI_PROPOSAL_INVALID', `玩家行动适配器不能执行 ${proposal.tool}`);
    }
  }

  async stage(params, { now = Date.now(), ttlMs } = {}) {
    const normalized = normalizeParams(params);
    const snapshot = actionState(this.manager);
    ensureAvailable(snapshot);
    const diff = actionDiff(normalized);
    const proposal = await createActionProposal({
      tool: this.toolName,
      params: normalized,
      stateFingerprint: await fingerprintValue(snapshot),
      context: {
        actionImpact: {
          schema: ACTION_IMPACT_SCHEMA,
          kind: LINGXI_PLAYER_ACTION_IMPACT_KIND,
          summary: `提交普通玩家行动：${normalized.text.slice(0, 120)}`,
          details: [
            `当前回合: ${snapshot.turn}`,
            `当前分支: ${snapshot.branchId}`,
            '批准后会把这段文字送入主生成管线，并可能产生 API 费用。',
            '主模型回执会推进剧情、结算状态并创建新的时间线回合。'
          ]
        }
      },
      diff,
      ttlMs,
      now
    });
    if (canonicalStringify(actionState(this.manager)) !== canonicalStringify(snapshot)) {
      fail('LINGXI_PROPOSAL_STALE', '剧情状态在提案生成期间发生了变化');
    }
    return proposal;
  }

  async apply(proposal, approvalPermit) {
    await this._authorize(proposal, approvalPermit);
    const normalized = normalizeParams(proposal.params);
    const before = actionState(this.manager);
    ensureAvailable(before);
    if (await fingerprintValue(before) !== proposal.stateFingerprint) {
      fail('LINGXI_PROPOSAL_STALE', '剧情回合或时间线已经变化，请重新生成提案');
    }
    const diff = actionDiff(normalized);
    if (await hashCanonical(diff) !== proposal.diffHash) {
      fail('LINGXI_PROPOSAL_TAMPERED', '玩家行动的重新计算差异与已批准提案不一致');
    }
    const result = await this.executePlayerAction(normalized.text);
    if (!result || result.accepted !== true) {
      fail('LINGXI_PLAYER_ACTION_REJECTED', '主生成管线没有接受已批准的玩家行动', {
        reason: String(result?.code || 'UNKNOWN').slice(0, 100)
      });
    }
    const after = actionState(this.manager);
    if (!after.nodeId || after.nodeId === before.nodeId) {
      fail('LINGXI_PLAYER_ACTION_FAILED', '玩家行动没有生成新的时间线回合，请检查主模型回执');
    }
    return {
      schema: 'naruto.lingxi-action-receipt/v1',
      proposalId: proposal.id,
      tool: proposal.tool,
      appliedAt: Date.now(),
      beforeFingerprint: proposal.stateFingerprint,
      afterFingerprint: await fingerprintValue(after),
      diff: clone(diff),
      summary: '普通玩家行动已由主生成管线完成',
      timeline: { beforeNodeId: before.nodeId, nodeId: after.nodeId }
    };
  }
}

export function createPlayerActionAdapter(options = {}) {
  return new PlayerActionAdapter(options);
}

export default PlayerActionAdapter;
