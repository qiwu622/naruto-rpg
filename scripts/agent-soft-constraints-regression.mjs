import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.customElements ||= { get: () => null };
const { AgentPipeline, normalizeWritingOutlineResult } = await import('../js/core/agent-pipeline.js');
const { MessagePipeline } = await import('../js/core/pipeline.js');

const names = ['角都', '纲手', '不知火玄间', '静音', '勘九郎', '守鹤'];
const decisionIds = names.map(name => `decision:${name}:0`);
const sceneBrief = {
  id: 'scene:soft-guidance', location: '木叶隐村', time: 'K048-01-01',
  participants: ['测试忍者'], playerIntent: '去医院询问伤员的情况',
  facts: ['医院有人值班'], constraints: [], tensions: [], evidenceRefs: ['state:test']
};
const outline = {
  beats: [{ id: 1, scene: '木叶医院的走廊', narrativeGoal: '回应玩家的询问',
    participants: ['静音'], decisionRefs: [] }], estimatedLength: 3200
};
const host = { getTurnEvidenceView: () => ({ current_state: {}, evidence: [] }) };
const makePipeline = () => new AgentPipeline({ pipeline: host, memorySystem: null });

test('screenshot: six unreferenced character decisions are optional writing material', () => {
  const result = normalizeWritingOutlineResult(outline, { decisionIds });
  assert.equal(result.beats[0].narrativeGoal, outline.beats[0].narrativeGoal);
  assert.deepEqual(result.beats[0].decisionRefs, [], 'do not force six NPCs into the scene');
  assert.deepEqual(result.beats[0].participants, ['静音']);
  assert.ok(result.beats[0].playerBoundary);
  assert.ok(result.beats[0].stopPoint);
  assert.ok(result.advisories.length);
  assert.equal(result.estimatedLength, 3200, 'the planning helper must not cap preset length at 2000');
});

test('outline metadata and proposed actions do not block a usable scene', () => {
  const result = normalizeWritingOutlineResult({ ...outline, beats: [{
    ...outline.beats[0], decisionRefs: ['decision:unknown'], action: '静音抬头看向来人。'
  }] }, { decisionIds });
  assert.equal(result.beats[0].scene, outline.beats[0].scene);
  assert.deepEqual(result.beats[0].decisionRefs, []);
  assert.equal(result.beats[0].action, undefined, 'planning fields stay separate from final prose');
  assert.ok(result.advisories.length);
});

test('unparseable planning output reuses the existing scene instead of requiring a retry', () => {
  for (const raw of [null, 'not JSON', { _raw: 'unparseable' }, { beats: [] }]) {
    const result = normalizeWritingOutlineResult(raw, { fallbackOutline: outline, sceneBrief });
    assert.equal(result.beats[0].scene, outline.beats[0].scene);
    assert.equal(result.beats[0].narrativeGoal, outline.beats[0].narrativeGoal);
    assert.ok(result.advisories.length);
  }
});

test('outliner action suggestions and unavailable writing-outline service do not stall planning', async () => {
  const pipeline = makePipeline();
  pipeline.runner.run = async () => ({ beats: [{ ...outline.beats[0], action: '静音递来病历。' }] });
  const result = await pipeline._generateOutline({}, sceneBrief.playerIntent, null, { sceneBrief });
  assert.equal(result.beats[0].scene, outline.beats[0].scene);
  pipeline.runner.run = async () => { throw new Error('outline service offline'); };
  const fallback = await pipeline._writeWritingOutline({}, sceneBrief.playerIntent, sceneBrief, null, outline, new Map(), []);
  assert.equal(fallback.beats[0].scene, outline.beats[0].scene);
  pipeline.abort(new Error('user cancelled'));
  await assert.rejects(pipeline._writeWritingOutline({}, '', sceneBrief, null, outline, new Map(), []), /user cancelled/);
});

test('review objections, unavailable reviewers and NPC provenance remain diagnostic only', () => {
  for (const review of [
    { success: false, error: 'timeout' },
    { success: true, data: { approved: false, issues: [{ severity: 'error', description: '人物反应有待调整' }] } },
    { success: true, data: { issues: 'invalid array', suggestions: {} } },
    null
  ]) {
    const pipeline = makePipeline();
    const report = pipeline._auditFinalOutput({
      state: { '玩家·姓名': '测试忍者' }, finalText: '静音翻开记录，向来人说明病房的情况。',
      sceneBrief, storyPlan: null, involvedNPCs: ['静音'],
      reviews: new Map([['final-preset-and-character', review]])
    });
    assert.equal(report.valid, true, JSON.stringify(report.errors));
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.length);
    assert.equal(report.checks.npcProvenance, false, 'soft checks still report missing provenance honestly');
  }
});

test('the complete turn reaches writer and updater despite missing IDs and repeated reviewer rejection', async () => {
  const pipeline = makePipeline();
  const plan = pipeline._fallbackStoryPlan({
    '世界·时间': 'K048-01-01', _meta: { active_branch: 'branch_main' }
  }, sceneBrief);
  const state = { '玩家·姓名': '测试忍者', '世界·地点': '木叶隐村', '世界·时间': 'K048-01-01',
    '系统·回合数': 23, _meta: { active_branch: 'soft-constraints-regression' },
    _agent_story_plan: plan, _relationships: {} };
  pipeline.contextBroker.preflight = async () => ({ domains: {}, sources: [], cache: {}, durationMs: 0 });
  pipeline._shouldRefreshStoryPlan = () => false;
  pipeline._extractInvolvedNPCs = () => names;
  pipeline._generateOutline = async () => outline;
  pipeline._reviewOutline = async () => new Map([['critic-character', { success: true, data: {
    issues: [{ severity: 'error', description: '人物反应有待调整', suggestion: '结合性格安排回应' }]
  } }]]);
  pipeline._runCharacterAgents = async () => {
    pipeline._characterDecisions = names.map((npc, i) => ({
      id: decisionIds[i], npc, sceneId: sceneBrief.id, provenance: 'character-agent',
      observable: { action: `${npc}留意当前局势。` }, private: { thought: '' },
      evidenceRefs: ['state:test']
    }));
    return pipeline._characterDecisions.map(d => ({ npc: d.npc, npcName: d.npc, decisionId: d.id, ...d.observable }));
  };
  let outlineCalls = 0;
  let writerCalls = 0;
  let updateCalls = 0;
  pipeline.runner.run = async type => {
    assert.equal(type, 'writer-outline');
    outlineCalls++;
    return outline;
  };
  pipeline._reviewWritingOutline = async (_state, _outline, { final }) => new Map([[
    final ? 'final-preset-and-character' : 'writing-outline-quality',
    { success: true, data: { approved: false, issues: [
      { severity: 'error', description: '没有覆盖每个角色', suggestion: '所有角色都要出现' }
    ] } }
  ]]);
  pipeline._reviewWithSearch = async () => ({ success: false, error: 'search timeout' });
  const prose = '静音合上病历，指了指走廊尽头：“伤员已经醒了。你想问哪一位？”';
  pipeline._createToolRuntime = () => ({ runAgent: async ({ messages }) => {
    writerCalls++;
    const prompt = messages.map(m => m.content).join('\n');
    assert.match(prompt, /写作参考/);
    assert.doesNotMatch(prompt, /唯一可演出|未授权|必须在正文中体现|已通过终审|不得再改变剧情结构/);
    assert.match(prompt, /没有覆盖每个角色/, 'review advice reaches writer as context');
    return { text: prose };
  } });
  pipeline._releaseToolRuntime = () => {};
  pipeline._appendContinuityUpdates = async (_state, _input, text) => {
    updateCalls++;
    assert.equal(text, prose);
    return text;
  };
  const output = await pipeline._run(state, sceneBrief.playerIntent, () => {}, false, false, []);
  assert.equal(output, prose);
  assert.equal(outlineCalls, 1, 'review opinions must not trigger mandatory outline regeneration');
  assert.equal(writerCalls, 1);
  assert.equal(updateCalls, 1);
  assert.equal(pipeline.getLastAgentAudit().valid, true);
  assert.doesNotMatch(output, /decision:|审核|原地等待/);
});

test('soft narrative diagnostics also pass the final commit boundary', () => {
  const pipeline = new MessagePipeline({});
  const privateThought = '她想先确认伤员已经醒来。';
  const params = {
    agentAudit: { valid: true, errors: [], warnings: ['reviewer suggested changes'],
      checks: { preset: false, npcProvenance: false },
      envelope: { characterDecisions: [{ npc: '静音', private: { thought: privateThought } }] } },
    displayResponse: `走廊传来脚步声。${privateThought}`,
    updaterEnabled: true, secondaryInstructions: { applied: 0 }, secondarySuccess: true,
    memoryRecorded: true, shinobiDaily: { summary: '医院近况' }, storyPlan: null
  };
  const report = pipeline._buildAgentCommitAudit(params);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.checks.storyPlan, false);
  assert.equal(report.checks.npcProvenance, false);
  assert.equal(report.checks.preset, false);
  assert.match(report.warnings.join('\n'), /私有想法/);
  assert.equal(pipeline._buildAgentCommitAudit({ ...params, displayResponse: '' }).valid, false);
  assert.equal(pipeline._buildAgentCommitAudit({ ...params, secondarySuccess: false }).valid, false);
});
