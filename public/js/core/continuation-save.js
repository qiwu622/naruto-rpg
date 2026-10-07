import { assertTimelineSave } from './timeline-save-schema.js';
import { projectNarrativeForMemory } from './narrative-memory.js';

export const CONTINUATION_SAVE_SCHEMA = 'naruto.continuation-copy/v1';
export const DEFAULT_CONTINUATION_TURNS = 50;
const clone = value => structuredClone(value);

// Only follow ancestors of the saved position. A branch's later head and its
// siblings must never supply memories to a copy made from an earlier position.
export function planContinuationCopy(data, { keepTurns = DEFAULT_CONTINUATION_TURNS } = {}) {
  if (!Number.isSafeInteger(keepTurns) || keepTurns < 1) throw new Error('保留回合数必须是大于 0 的整数');
  const meta = data.meta?.value;
  const byId = new Map((data.nodes || []).map(node => [node.id, node]));
  let cursor = byId.get(meta?.current_id);
  if (!cursor) throw new Error('没有可续玩的保存位置');
  const seen = new Set();
  const turns = new Set();
  const retained = [];
  while (cursor) {
    if (seen.has(cursor.id)) throw new Error('时间线父节点关系包含环');
    if (!turns.has(cursor.turn_number) && turns.size >= keepTurns) break;
    seen.add(cursor.id);
    turns.add(cursor.turn_number);
    retained.push(cursor);
    if (cursor.parent_id == null) break;
    cursor = byId.get(cursor.parent_id);
    if (!cursor) throw new Error('时间线父节点缺失，无法生成续玩副本');
  }
  retained.reverse();
  const branch = data.branches?.find(item => item.id === meta.active_branch);
  return {
    retained, keepTurns, retainedTurns: turns.size,
    fromTurn: retained[0].turn_number, toTurn: retained.at(-1).turn_number,
    omittedNodes: data.nodes.length - retained.length,
    sourceBranchName: branch?.name || '主线'
  };
}

function localChatDelta(node) {
  if (node.branch_anchor) return [];
  const messages = Array.isArray(node.chat_history_delta) && node.chat_history_delta.length
    ? node.chat_history_delta
    : Array.isArray(node.chat_history) && node.chat_history.length
      ? node.chat_history.slice(-2)
      : [
          ...(node.player_input ? [{ role: 'user', content: node.player_input }] : []),
          ...(node.clean_response ? [{ role: 'assistant', content: node.clean_response }] : [])
        ];
  return messages.map(message => message.role === 'assistant' && typeof message.content === 'string'
    ? { ...clone(message), content: projectNarrativeForMemory(message.content) }
    : clone(message));
}

export function buildContinuationCopy(data, { keepTurns = DEFAULT_CONTINUATION_TURNS, sourceId = '', sourceLabel = '' } = {}) {
  assertTimelineSave(data);
  const plan = planContinuationCopy(data, { keepTurns });
  const nodes = plan.retained.map((source, index) => {
    if (!source.state_snapshot || typeof source.state_snapshot !== 'object') {
      throw new Error(`第 ${source.turn_number} 回合缺少完整状态，无法保留此回退点`);
    }
    const node = clone(source);
    node.parent_id = index ? plan.retained[index - 1].id : null;
    node.children_ids = index + 1 < plan.retained.length ? [plan.retained[index + 1].id] : [];
    node.depth = index;
    node.branch_id = 'branch_main';
    node.archived = false;
    node.archived_at = null;
    // Each retained turn keeps its own historical state. Never copy the latest
    // memory backwards: doing so makes future facts appear after a rollback.
    node.state_snapshot._meta = {
      ...node.state_snapshot._meta, current_node_id: node.id, active_branch: 'branch_main'
    };
    for (const key of ['_story_direction', '_agent_story_plan']) {
      if (node.state_snapshot[key]?.branchId === source.branch_id) node.state_snapshot[key].branchId = 'branch_main';
    }
    node.chat_history = null;
    node.chat_history_delta = localChatDelta(source);
    if (index === 0) {
      node.is_checkpoint = true;
      // Preserve already committed memories at the new root, including their
      // original event IDs/provenance. Delta-only reconstruction stays usable.
      if (node.state_snapshot._continuity) {
        node.continuity_delta = clone(node.state_snapshot._continuity.events);
        node.continuity_revision = node.state_snapshot._continuity.revision;
      }
    }
    return node;
  });
  const root = nodes[0];
  const current = nodes.at(-1);
  const scope = {
    schema: CONTINUATION_SAVE_SCHEMA,
    source_save_id: sourceId,
    source_label: String(sourceLabel).slice(0, 100),
    source_root_id: data.meta.value.root_id,
    source_current_id: data.meta.value.current_id,
    source_branch_id: data.meta.value.active_branch,
    source_branch_name: plan.sourceBranchName,
    source_was_continuation: data.meta.value.continuation?.schema === CONTINUATION_SAVE_SCHEMA,
    created_at: new Date().toISOString(),
    requested_turns: keepTurns,
    retained_turns: plan.retainedTurns,
    from_turn: plan.fromTurn,
    through_turn: plan.toTurn,
    omitted_nodes: plan.omittedNodes,
    omitted_branches: Math.max(0, data.branches.length - 1)
  };
  // Keep portable multiplayer provenance at the top level, exactly where its
  // codec expects it. It must not be copied into the Agent-visible snapshots.
  const result = {
    ...data,
    meta: { ...clone(data.meta), value: {
      ...clone(data.meta.value), root_id: root.id, current_id: current.id,
      active_branch: 'branch_main', total_nodes: nodes.length, continuation: scope
    } },
    nodes,
    branches: [{
      id: 'branch_main', name: `${plan.sourceBranchName} · 续玩`,
      description: `轻量副本，正文与回退从第 ${plan.fromTurn} 回合开始。`,
      color: data.branches.find(branch => branch.id === data.meta.value.active_branch)?.color || '#eb613f',
      created_at: Date.now(), diverged_from: null, diverged_at_turn: null,
      head_node_id: current.id, node_count: nodes.length, is_active: true
    }]
  };
  assertTimelineSave(result);
  return result;
}

// Small listing metadata survives local export/import and cloud round trips.
export function continuationSaveScope(data) {
  const scope = data?.meta?.value?.continuation;
  if (scope?.schema !== CONTINUATION_SAVE_SCHEMA) return null;
  const first = data.nodes?.find(node => node.id === data.meta.value.root_id);
  const current = data.nodes?.find(node => node.id === data.meta.value.current_id);
  return { ...scope, from_turn: first?.turn_number ?? scope.from_turn, through_turn: current?.turn_number ?? scope.through_turn };
}
