import { createContinuityLedger, normalizeMemoryEvent } from '../../js/core/continuity-ledger.js';
import { SHINOBI_DAILY_EXAMPLE } from '../../js/core/shinobi-daily.js';

export function makeContinuationFixture(turns = 120) {
  const nodes = [];
  function add(id, parent, branch, turn, marker) {
    const event = normalizeMemoryEvent({
      event_id: `event_${id}`, type: 'fact', subject_id: 'player', predicate: 'journey', value: marker
    }, { nodeId: id, branchId: branch, turn, sequence: turn - 1, recordedAt: turn, gameTime: `木叶48年 / ${turn}` });
    const before = parent?.state_snapshot._continuity || createContinuityLedger();
    const ledger = { ...before, revision: turn, legacy_migration_version: 1, events: [...before.events, event] };
    const story = `${marker}：同伴在村口交付了任务情报。` + '记录这一天的风景和已经发生的对话。'.repeat(50);
    const node = {
      id, parent_id: parent?.id || null, children_ids: [], branch_id: branch,
      turn_number: turn, depth: parent ? parent.depth + 1 : 0,
      clean_response: `${story}\n[行动]\n1. 尚未选择的未来行动`,
      summary: marker, chat_history: null,
      shinobi_daily: SHINOBI_DAILY_EXAMPLE,
      media: [{ type: 'image', url: '/assets/test-illustration.webp' }],
      chat_history_delta: [{ role: 'user', content: `调查 ${turn}` }, { role: 'assistant', content: story }],
      state_snapshot: {
        _version: '5.0', '玩家·姓名': '续玩测试忍者', '世界·地点': '木叶隐村', '系统·回合数': turn,
        _meta: { current_node_id: id, active_branch: branch, turn_count: turn },
        _memory: { pins: '保留最初的约定', facts: `${marker} 已经发生`, clues: '失踪的任务卷轴', npc_notes: '卡卡西: 已知的同伴关系' },
        _relationships: { 卡卡西: { relationship: '同伴', history: [{ text: marker }] } },
        _continuity: ledger, marker,
        _story_direction: { branchId: branch, text: '去村口调查' },
        _agent_story_plan: { branchId: branch, plan: '追查线索' }
      },
      continuity_revision: ledger.revision, continuity_delta: [event],
      created_at: turn, real_timestamp: turn, game_time: `木叶48年 / ${turn}`,
      is_checkpoint: false, archived: false, archived_at: null
    };
    if (parent) parent.children_ids.push(id);
    nodes.push(node);
    return node;
  }
  let parent = null;
  for (let turn = 1; turn <= turns; turn++) parent = add(`main_${turn}`, parent, 'branch_main', turn, `主线${turn}`);
  const mainHead = parent;
  const split = Math.max(1, Math.floor(turns / 2));
  parent = nodes.find(node => node.id === `main_${split}`);
  for (let turn = split + 1; turn <= turns; turn++) parent = add(`if_${turn}`, parent, 'branch_if', turn, `IF${turn}`);
  return {
    export_version: '2.0', include_archive: true,
    meta: { key: 'root', value: { root_id: 'main_1', current_id: parent.id, active_branch: 'branch_if', total_nodes: nodes.length } },
    branches: [
      { id: 'branch_main', name: '主线', color: '#eb613f', head_node_id: mainHead.id, node_count: turns, diverged_from: null, is_active: false },
      { id: 'branch_if', name: '留在木叶', color: '#839cce', head_node_id: parent.id, node_count: turns - split, diverged_from: `main_${split}`, diverged_at_turn: split, is_active: true }
    ], nodes
  };
}
