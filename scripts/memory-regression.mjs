import assert from 'node:assert/strict';

import { stateManager } from '../js/core/state-manager.js';
import { memorySystem } from '../js/systems/memory-system.js';
import { resetMemoryConfig, saveMemoryConfig } from '../js/data/memory-config.js';

let passed = 0;

async function test(name, fn) {
  stateManager.reset();
  resetMemoryConfig();
  memorySystem._pendingRecall = [];
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

function setTurn(turn) {
  stateManager.update([{ key: '系统·回合数', op: '=', value: turn }]);
}

await test('AI compression consumes one chunk and keeps the unprocessed tail', async () => {
  const tail = 'TAIL-MUST-SURVIVE';
  stateManager.setSub('_memory', {
    _pendingCompressionText: 'A'.repeat(6000) + tail,
    meta: { updated_at: null, sources: {} }
  });
  const client = { chat: async () => '有效压缩摘要'.repeat(12) };

  assert.equal(await memorySystem.aiCompress(client), true);
  assert.equal(stateManager.getSub('_memory')._pendingCompressionText, tail);
});

await test('AI compression persists plot details regardless of their target date', async () => {
  const plotDetail = 'EV-P2-RETURN-TEAM-01-01 归村人员在木叶正门完成登记。';
  stateManager.setSub('_memory', {
    _pendingCompressionText: '本轮剧情记录'.repeat(600),
    meta: { updated_at: null, sources: {} }
  });
  const client = { chat: async () => `${plotDetail}这是当前分支已经确认的连续性事实。`.repeat(3) };

  assert.equal(await memorySystem.aiCompress(client), true);
  assert.match(stateManager.getSub('_memory').compressed_summary, /EV-P2-RETURN-TEAM-01-01/);
});

await test('failed AI compression keeps pending source text for retry', async () => {
  const pending = '待重试内容'.repeat(100);
  stateManager.setSub('_memory', {
    _pendingCompressionText: pending,
    meta: { updated_at: null, sources: {} }
  });
  const client = { chat: async () => { throw new Error('offline'); } };

  assert.equal(await memorySystem.aiCompress(client), false);
  assert.equal(stateManager.getSub('_memory')._pendingCompressionText, pending);
});

await test('async compression cannot write into a different timeline branch', async () => {
  const pending = '分支专属记忆'.repeat(300);
  stateManager.setSub('_meta', { current_node_id: 'node-main-7', active_branch: 'branch_main' });
  stateManager.setSub('_memory', {
    _pendingCompressionText: pending,
    meta: { updated_at: null, sources: {} }
  });
  let resolveChat;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const client = {
    chat: async () => {
      markStarted();
      return new Promise(resolve => { resolveChat = resolve; });
    }
  };

  const task = memorySystem.aiCompress(client);
  await started;
  stateManager.setSub('_meta', { current_node_id: 'node-if-3', active_branch: 'branch_if' });
  resolveChat('这份摘要属于旧分支，不能落到新分支。'.repeat(6));

  assert.equal(await task, false);
  assert.equal(stateManager.getSub('_memory')._pendingCompressionText, pending);
  assert.equal(stateManager.getSub('_memory').compressed_summary, undefined);
});

await test('deep consolidation sends bounded valid JSON', async () => {
  setTurn(50);
  stateManager.setSub('_memory', {
    facts: Array.from({ length: 100 }, (_, i) => `#${i} ${'事实'.repeat(80)}`).join('\n'),
    npc_notes: Array.from({ length: 80 }, (_, i) => `角色${i}: ${'记录'.repeat(50)}`).join('\n'),
    clues: Array.from({ length: 50 }, (_, i) => JSON.stringify({ title: `线索${i}`, detail: '细节'.repeat(40) })).join('\n'),
    important_events: Array.from({ length: 50 }, (_, i) => `事件${i}${'经过'.repeat(40)}`).join('\n'),
    chapters: JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, from: i, to: i + 1, summary: '章节'.repeat(100) }))),
    _relationship_buffer: '历史'.repeat(3000),
    meta: { updated_at: null, sources: {}, last_deep_turn: 0 }
  });
  let payloadText = '';
  const client = {
    chat: async (messages) => {
      payloadText = messages.at(-1).content;
      return JSON.stringify({ facts: ['#1 保留事实'], npc_digest: {}, resolved_clues: [], pins: [], era_note: '时期小结' });
    }
  };

  assert.equal(await memorySystem.deepConsolidate(client, { force: true }), true);
  assert.doesNotThrow(() => JSON.parse(payloadText));
  assert.ok(payloadText.length <= 12000);
});

await test('one turn has one single-line summary', () => {
  setTurn(7);
  memorySystem.apply({ summary: '主模型第一行\n主模型第二行' }, { source: 'main' });
  memorySystem.apply({ summary: '二次模型第一行\n二次模型第二行' }, { source: 'secondary' });

  const summaries = stateManager.getSub('_memory').turn_summaries.split('\n');
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /^#7 二次模型第一行 二次模型第二行$/);
});

await test('all NPC notes remain complete in storage', () => {
  for (let i = 0; i < 12; i++) {
    memorySystem.apply({ npc_notes: { 卡卡西: `互动${i}` } });
  }

  const memory = stateManager.getSub('_memory');
  assert.equal(memory.npc_notes.split('\n').length, 12);
  assert.match(memory.npc_notes, /互动0/);
  assert.match(memory.npc_notes, /互动1/);
});

await test('retrieval injects active and recalled entities only', () => {
  stateManager.setSub('_relationships', {
    npcA: {},
    npcB: {},
    npcC: {}
  });
  const memory = {
    facts: 'specialPlace藏着关键卷轴',
    npc_notes: 'npcA: 现场相关记录\nnpcB: 不相关记录\nnpcC: 另一条不相关记录',
    chapters: '[]',
    volumes: '[]'
  };
  memorySystem.parseRecallTags('<recall entities="specialPlace"/>');

  const context = memorySystem.buildPromptContext(memory, { userInput: 'npcA询问刚才的情况' });
  assert.match(context, /specialPlace藏着关键卷轴/);
  assert.match(context, /npcA: 现场相关记录/);
  assert.doesNotMatch(context, /npcB: 不相关记录/);
  assert.doesNotMatch(context, /npcC: 另一条不相关记录/);
});

await test('clue updates replace stale status and completed missions remove pins', () => {
  memorySystem.apply({ clues: [{ title: '暗号', detail: '尚未破解', status: '未解' }] });
  memorySystem.apply({ clues: [{ title: '暗号', detail: '已经破解', status: '已解' }] });
  const clue = JSON.parse(stateManager.getSub('_memory').clues);
  assert.equal(clue.status, '已解');
  assert.equal(clue.detail, '已经破解');

  memorySystem.recordMissionAdded({ title: '护送任务', rank: 'D' });
  assert.match(stateManager.getSub('_memory').pins, /护送任务/);
  memorySystem.recordMissionCompleted({ title: '护送任务', rating: '良好' });
  assert.doesNotMatch(stateManager.getSub('_memory').pins, /护送任务/);
});

await test('facts metadata survives an empty long-term update', () => {
  memorySystem.apply({ facts: ['鸣人学会了新术'], add: [] });
  const memory = stateManager.getSub('_memory');
  assert.equal(JSON.parse(memory._facts_meta).length, 1);
  assert.equal(JSON.parse(memory._long_term_meta).length, 0);
});

await test('a full archive retains the newest overflow fact', () => {
  saveMemoryConfig({ factsLimit: 30, archivedLimit: 100 });
  stateManager.setSub('_memory', {
    facts: Array.from({ length: 30 }, (_, i) => `事实${i}`).join('\n'),
    archived: Array.from({ length: 100 }, (_, i) => `旧归档${i}`).join('\n'),
    _facts_meta: '[]',
    _long_term_meta: '[]',
    meta: { updated_at: null, sources: {} }
  });
  memorySystem.apply({ facts: ['最新事实'] });
  const memory = stateManager.getSub('_memory');
  assert.match(memory.facts, /最新事实/);
  assert.match(memory.archived, /事实0/);
  assert.match(memory.archived, /^旧归档0(?:\n|$)/);
});

await test('chapters only tag entities present in their source turns', () => {
  saveMemoryConfig({ maxTurnSummaries: 4, chapterWindow: 5 });
  stateManager.setSub('_relationships', { npcA: {}, npcB: {}, npcC: {} });
  for (let turn = 1; turn <= 12; turn++) {
    setTurn(turn);
    memorySystem.apply({ summary: `npcA在第${turn}回合行动` }, { source: 'test' });
  }
  const chapters = JSON.parse(stateManager.getSub('_memory').chapters);
  assert.ok(chapters.length > 0);
  assert.ok(chapters[0].entities.includes('npcA'));
  assert.ok(!chapters[0].entities.includes('npcB'));
  assert.ok(!chapters[0].entities.includes('npcC'));
});

resetMemoryConfig();
console.log(`\n${passed} memory regression tests passed.`);
