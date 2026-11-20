import { stateManager as defaultStateManager } from '../../state-manager.js';
import { eventBus as defaultEventBus } from '../../event-bus.js';
import { timelineSystem as defaultTimelineSystem } from '../../../systems/timeline-system.js';
import { listingTimelineNode } from '../../timeline-node-codec.js';
import {
  LingXiActionError,
  canonicalStringify,
  createActionProposal,
  fingerprintValue,
  hashCanonical,
  verifyActionProposal
} from '../action-proposal.js';
import { consumeBrokerApprovedProposal } from '../approval-broker.js';

export const LINGXI_TIMELINE_ACTION_TOOL = 'perform_timeline_action';
export const LINGXI_TIMELINE_ACTION_IMPACT_KIND = 'timeline';

const ACTION_IMPACT_SCHEMA = 'naruto.lingxi-action-impact/v1';
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const NODE_ACTIONS = new Set(['jump', 'rewind', 'reroll_branch', 'reroll_replace']);
const BRANCH_ACTIONS = new Set(['switch_branch', 'promote_branch', 'delete_branch']);

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

function cleanText(value, label, max, { required = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    fail('LINGXI_TIMELINE_ACTION_INVALID', `${label}必须是文本`);
  }
  const result = String(value || '').replace(/\u0000/g, '').trim();
  if ((required && !result) || result.length > max) {
    fail('LINGXI_TIMELINE_ACTION_INVALID', `${label}必须是${required ? '非空' : ''}且不超过 ${max} 个字符的文本`);
  }
  return result;
}

function normalizeParams(params) {
  if (!isRecord(params)) fail('LINGXI_TIMELINE_ACTION_INVALID', '时间线操作参数必须是对象');
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_KEYS.has(key) || !['action', 'nodeId', 'branchId', 'reason'].includes(key)) {
      fail('LINGXI_TIMELINE_ACTION_INVALID', `时间线操作包含不支持的字段: ${key}`);
    }
  }
  const action = cleanText(params.action, '时间线操作', 40);
  if (!NODE_ACTIONS.has(action) && !BRANCH_ACTIONS.has(action)) {
    fail('LINGXI_TIMELINE_ACTION_INVALID', `不支持的时间线操作: ${action}`);
  }
  const reason = cleanText(params.reason, '操作原因', 500);
  if (NODE_ACTIONS.has(action)) {
    if (params.branchId !== undefined) fail('LINGXI_TIMELINE_ACTION_INVALID', `${action} 操作不接受 branchId`);
    return { action, nodeId: cleanText(params.nodeId, '时间线节点 ID', 240), reason };
  }
  if (params.nodeId !== undefined) fail('LINGXI_TIMELINE_ACTION_INVALID', `${action} 操作不接受 nodeId`);
  return { action, branchId: cleanText(params.branchId, '时间线分支 ID', 240), reason };
}

function pointerSegment(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function publicNode(node) {
  if (!node) return null;
  return {
    id: String(node.id || '').slice(0, 240),
    branchId: String(node.branch_id || 'branch_main').slice(0, 240),
    turn: Number(node.turn_number) || 0,
    summary: String(node.summary || node.ai_response_summary || node.player_input || '尚无摘要').slice(0, 300),
    parentId: String(node.parent_id || '').slice(0, 240)
  };
}

function publicBranch(branch, nodes) {
  if (!branch) return null;
  return {
    id: String(branch.id || '').slice(0, 240),
    name: String(branch.name || branch.id || '').slice(0, 160),
    headNodeId: String(branch.head_node_id || '').slice(0, 240),
    nodeCount: nodes.filter(node => node?.branch_id === branch.id).length,
    isActive: branch.is_active === true
  };
}

function descendantIds(nodeId, nodes) {
  const byId = new Map(nodes.filter(Boolean).map(node => [node.id, node]));
  const found = new Set();
  const visit = id => {
    const node = byId.get(id);
    if (!node || !Array.isArray(node.children_ids)) return;
    for (const childId of node.children_ids) {
      if (!childId || found.has(childId)) continue;
      found.add(childId);
      visit(childId);
    }
  };
  visit(nodeId);
  return [...found].sort();
}

export class TimelineActionAdapter {
  #approvalPermit = null;

  constructor({
    stateManager = defaultStateManager,
    timelineSystem = defaultTimelineSystem,
    executeTimelineAction = options => defaultEventBus.request('app:execute-timeline-action', options)
  } = {}) {
    if (typeof stateManager?.snapshot !== 'function'
      || (typeof timelineSystem?.getNodeSummaries !== 'function' && typeof timelineSystem?.getAllNodes !== 'function')
      || typeof timelineSystem?.getAllBranches !== 'function'
      || typeof executeTimelineAction !== 'function') {
      fail('LINGXI_ADAPTER_INVALID', '时间线适配器需要状态快照、时间线读取和显式执行器');
    }
    this.manager = stateManager;
    this.timelineSystem = timelineSystem;
    this.executeTimelineAction = executeTimelineAction;
    this.toolName = LINGXI_TIMELINE_ACTION_TOOL;
  }

  bindApprovalPermit(permit) {
    if (!permit || typeof permit !== 'object') fail('LINGXI_ADAPTER_INVALID', '审批许可必须是不透明对象');
    if (this.#approvalPermit && this.#approvalPermit !== permit) {
      fail('LINGXI_ADAPTER_INVALID', '时间线适配器已绑定到另一个审批 Broker');
    }
    this.#approvalPermit = permit;
  }

  async _authorize(proposal, approvalPermit) {
    const brokerApproved = consumeBrokerApprovedProposal(proposal);
    const directlyBound = this.#approvalPermit && approvalPermit === this.#approvalPermit;
    if (!brokerApproved || (this.#approvalPermit && !directlyBound)) {
      fail('LINGXI_APPROVAL_REQUIRED', '时间线操作只能由绑定的审批 Broker 执行');
    }
    await verifyActionProposal(proposal);
    if (proposal.tool !== this.toolName) {
      fail('LINGXI_PROPOSAL_INVALID', `时间线适配器不能执行 ${proposal.tool}`);
    }
  }

  async _snapshot() {
    const readNodes = typeof this.timelineSystem.getNodeSummaries === 'function'
      ? () => this.timelineSystem.getNodeSummaries()
      : () => this.timelineSystem.getAllNodes();
    const [nodes, branches] = await Promise.all([
      readNodes(),
      this.timelineSystem.getAllBranches()
    ]);
    const state = this.manager.snapshot();
    const raw = {
      nodes: clone((Array.isArray(nodes) ? nodes : []).map(listingTimelineNode)),
      branches: clone(Array.isArray(branches) ? branches : []),
      current: {
        nodeId: String(state?._meta?.current_node_id || state?.['系统·当前节点'] || ''),
        branchId: String(state?._meta?.active_branch || state?.['系统·当前分支'] || 'branch_main')
      }
    };
    return { ...raw, fingerprint: await fingerprintValue(raw) };
  }

  _prepare(params, snapshot) {
    const nodes = snapshot.nodes;
    const branches = snapshot.branches;
    if (NODE_ACTIONS.has(params.action)) {
      const node = nodes.find(item => item?.id === params.nodeId);
      if (!node) fail('LINGXI_TIMELINE_TARGET_UNAVAILABLE', '时间线节点不存在');
      const descendants = descendantIds(node.id, nodes);
      if (params.action === 'jump' && snapshot.current.nodeId === node.id) {
        fail('LINGXI_NO_CHANGES', '该节点已经是当前回合');
      }
      if (params.action === 'rewind' && snapshot.current.nodeId === node.id && descendants.length === 0) {
        fail('LINGXI_NO_CHANGES', '当前节点没有可剪除的后续回合');
      }
      if ((params.action === 'reroll_branch' || params.action === 'reroll_replace')
        && (!node.parent_id || !String(node.player_input || '').trim())) {
        fail('LINGXI_TIMELINE_REROLL_UNAVAILABLE', '该节点缺少父节点或玩家输入，无法重推衍');
      }
      const deletedIds = params.action === 'rewind'
        ? descendants
        : (params.action === 'reroll_replace' ? descendantIds(node.parent_id, nodes) : []);
      return { params, node, descendants, deletedIds };
    }

    const branch = branches.find(item => item?.id === params.branchId);
    if (!branch) fail('LINGXI_TIMELINE_TARGET_UNAVAILABLE', '时间线分支不存在');
    if (params.action === 'switch_branch' && snapshot.current.branchId === branch.id) {
      fail('LINGXI_NO_CHANGES', '该分支已经是当前活动分支');
    }
    if ((params.action === 'promote_branch' || params.action === 'delete_branch') && branch.id === 'branch_main') {
      fail('LINGXI_TIMELINE_ACTION_INVALID', '主线不能升格或删除');
    }
    const branchNodeIds = nodes.filter(node => node?.branch_id === branch.id).map(node => node.id).sort();
    return { params, branch, branchNodeIds };
  }

  _diff(prepared, snapshot) {
    const { params } = prepared;
    if (params.action === 'jump') {
      return [{
        path: '/timeline/currentNodeId', operation: 'replace',
        before: snapshot.current.nodeId, after: params.nodeId
      }];
    }
    if (params.action === 'rewind' || params.action === 'reroll_replace') {
      return [{
        path: '/timeline/descendants', operation: 'remove',
        before: {
          targetNodeId: params.nodeId,
          deleteCount: prepared.deletedIds.length
        },
        after: { targetNodeId: params.nodeId, deleteCount: 0 }
      }];
    }
    if (params.action === 'reroll_branch') {
      return [{
        path: `/timeline/rerolls/${pointerSegment(params.nodeId)}`,
        operation: 'add',
        after: { mode: 'branch', sourceNodeId: params.nodeId, invokesMainPipeline: true }
      }];
    }
    if (params.action === 'switch_branch') {
      return [{
        path: '/timeline/activeBranchId', operation: 'replace',
        before: snapshot.current.branchId, after: params.branchId
      }];
    }
    if (params.action === 'promote_branch') {
      return [{
        path: '/timeline/mainBranchId', operation: 'replace',
        before: 'branch_main', after: params.branchId
      }];
    }
    return [{
      path: `/timeline/branches/${pointerSegment(params.branchId)}`,
      operation: 'remove',
      before: { branchId: params.branchId, nodeCount: prepared.branchNodeIds.length },
      after: null
    }];
  }

  async _impact(prepared, snapshot) {
    const { params } = prepared;
    if (params.action === 'jump') {
      const node = publicNode(prepared.node);
      return {
        schema: ACTION_IMPACT_SCHEMA,
        kind: LINGXI_TIMELINE_ACTION_IMPACT_KIND,
        summary: `非破坏跳转到第 ${node.turn} 回`,
        details: [
          `目标节点: ${node.id}`,
          `目标分支: ${node.branchId}`,
          '会恢复该节点的完整状态与对话历史；不会立即删除后续节点，下一次输入可能创建 IF 分支。'
        ]
      };
    }
    if (params.action === 'rewind') {
      return {
        schema: ACTION_IMPACT_SCHEMA,
        kind: LINGXI_TIMELINE_ACTION_IMPACT_KIND,
        summary: `永久逆转到节点 ${params.nodeId}`,
        details: [
          `将永久删除后续 ${prepared.deletedIds.length} 个节点。`,
          `当前节点: ${snapshot.current.nodeId}`,
          '会恢复目标节点的完整存档；被剪除的剧情、状态与图片引用无法从时间线恢复。'
        ]
      };
    }
    if (params.action === 'reroll_branch' || params.action === 'reroll_replace') {
      const replace = params.action === 'reroll_replace';
      return {
        schema: ACTION_IMPACT_SCHEMA,
        kind: LINGXI_TIMELINE_ACTION_IMPACT_KIND,
        summary: replace ? '删除旧后续并重新推衍该回合' : '保留旧线并创建平行重推衍',
        details: [
          `重推衍节点: ${params.nodeId}`,
          replace ? `将先永久删除 ${prepared.deletedIds.length} 个后续节点。` : '原时间线会保留，新结果进入 IF 分支。',
          '批准后会重新提交该回合的原玩家输入，调用主模型并可能产生 API 费用。',
          '成功后会结算新剧情与状态，并创建新的时间线回合。'
        ]
      };
    }
    const branch = publicBranch(prepared.branch, snapshot.nodes);
    const summaries = {
      switch_branch: `切换到分支「${branch.name}」`,
      promote_branch: `将分支「${branch.name}」升格为主线`,
      delete_branch: `永久删除分支「${branch.name}」`
    };
    const details = [`分支 ID: ${branch.id}`, `分支节点数: ${branch.nodeCount}`];
    if (params.action === 'switch_branch') details.push('会恢复该分支头节点的完整状态与对话历史。');
    if (params.action === 'promote_branch') details.push('原主线在分歧点后的节点会降格为新的 IF 分支。');
    if (params.action === 'delete_branch') details.push(`将永久删除该分支的 ${prepared.branchNodeIds.length} 个节点；此操作不可撤销。`);
    return {
      schema: ACTION_IMPACT_SCHEMA,
      kind: LINGXI_TIMELINE_ACTION_IMPACT_KIND,
      summary: summaries[params.action],
      details
    };
  }

  async stage(params, { now = Date.now(), ttlMs } = {}) {
    const normalized = normalizeParams(params);
    const snapshot = await this._snapshot();
    const prepared = this._prepare(normalized, snapshot);
    const diff = this._diff(prepared, snapshot);
    const proposal = await createActionProposal({
      tool: this.toolName,
      params: normalized,
      stateFingerprint: snapshot.fingerprint,
      context: { actionImpact: await this._impact(prepared, snapshot) },
      diff,
      ttlMs,
      now
    });
    const current = await this._snapshot();
    if (current.fingerprint !== snapshot.fingerprint) {
      fail('LINGXI_PROPOSAL_STALE', '时间线在提案生成期间发生了变化');
    }
    return proposal;
  }

  async apply(proposal, approvalPermit) {
    await this._authorize(proposal, approvalPermit);
    const normalized = normalizeParams(proposal.params);
    const before = await this._snapshot();
    if (before.fingerprint !== proposal.stateFingerprint) {
      fail('LINGXI_PROPOSAL_STALE', '时间线节点、分支或当前位置已经变化，请重新生成提案');
    }
    const prepared = this._prepare(normalized, before);
    const diff = this._diff(prepared, before);
    if (await hashCanonical(diff) !== proposal.diffHash) {
      fail('LINGXI_PROPOSAL_TAMPERED', '时间线操作的重新计算差异与已批准提案不一致');
    }
    const result = await this.executeTimelineAction({
      action: normalized.action,
      ...(normalized.nodeId ? { nodeId: normalized.nodeId } : {}),
      ...(normalized.branchId ? { branchId: normalized.branchId } : {})
    });
    if (!result || result.applied !== true) {
      fail('LINGXI_TIMELINE_ACTION_REJECTED', '时间线协调器没有接受已批准的操作', {
        reason: String(result?.code || 'UNKNOWN').slice(0, 100)
      });
    }
    const after = await this._snapshot();
    if (canonicalStringify(after.nodes) === canonicalStringify(before.nodes)
      && canonicalStringify(after.branches) === canonicalStringify(before.branches)
      && canonicalStringify(after.current) === canonicalStringify(before.current)) {
      fail('LINGXI_TIMELINE_ACTION_FAILED', '时间线协调器执行后没有产生预期变化');
    }
    return {
      schema: 'naruto.lingxi-action-receipt/v1',
      proposalId: proposal.id,
      tool: proposal.tool,
      appliedAt: Date.now(),
      beforeFingerprint: proposal.stateFingerprint,
      afterFingerprint: after.fingerprint,
      diff: clone(diff),
      summary: `时间线操作已完成: ${normalized.action}`,
      result: {
        action: normalized.action,
        nodeId: String(result.nodeId || '').slice(0, 240),
        branchId: String(result.branchId || '').slice(0, 240),
        pruned: Math.max(0, Number(result.pruned) || 0)
      }
    };
  }
}

export function createTimelineActionAdapter(options = {}) {
  return new TimelineActionAdapter(options);
}

export default TimelineActionAdapter;
