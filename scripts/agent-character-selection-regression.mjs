import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.customElements ||= { get: () => null };
const { AgentPipeline } = await import('../js/core/agent-pipeline.js');

const state = {
  '玩家·姓名': '测试忍者', '世界·地点': '木叶医院',
  _relationships: Object.fromEntries(['静音', '纲手', '角都', ...Array.from({ length: 30 }, (_, i) => `旧识${i}`)].map(n => [n, {}])),
  _combat: { enemy_name: '水木', is_active: false }
};
const sceneBrief = { id: 'scene:selection', location: '木叶医院', participants: ['测试忍者', '静音', '纲手'] };
const makePipeline = () => new AgentPipeline({ pipeline: { getHistory: () => [] }, memorySystem: null });

for (const requested of [[], ['静音'], ['静音', '新来的护士'], ['静音', '纲手', '新来的护士', '值班医生']]) {
  test(`outliner chooses ${requested.length} delegates despite 33 known relationships`, async () => {
    const pipeline = makePipeline();
    pipeline.runner.run = async (type, input) => {
      assert.equal(type, 'outliner');
      assert.match(input.taskPrompt, /characterRequests/);
      return { beats: [{ scene: '木叶医院', participants: ['静音', '纲手'] }],
        characterRequests: requested.map(npc => ({ npc, reason: '需要本轮人物回应的参考' })) };
    };
    const outline = await pipeline._generateOutline(state, '想起远方的角都，询问静音伤员情况', null, { sceneBrief });
    const selected = pipeline._extractInvolvedNPCs(sceneBrief, outline, state, '想起远方的角都');
    const called = [];
    pipeline._runOneCharacterAgent = async ({ npcName }) => {
      called.push(npcName);
      return { id: `decision:${npcName}`, npc: npcName, observable: { action: '回应来人' } };
    };
    await pipeline._runCharacterAgents(state, '询问伤员', selected, sceneBrief, outline, null);
    assert.deepEqual(called, requested);
  });
}

test('missing or malformed optional selection does not fan out to relationships, combat or mentioned names', async () => {
  const pipeline = makePipeline();
  for (const selection of [undefined, null, '静音', {}, 3]) {
    pipeline.runner.run = async () => ({ beats: [{ scene: '医院', participants: ['静音'] }], characterRequests: selection });
    const outline = await pipeline._generateOutline(state, '静音，听说角都离村了', null, { sceneBrief });
    assert.deepEqual(pipeline._extractInvolvedNPCs(sceneBrief, outline, state, '静音'), []);
  }
});

test('explicit requests accept new characters, deduplicate aliases and never delegate the player', async () => {
  const pipeline = makePipeline();
  const withAliases = { ...state, _relationships: { ...state._relationships, 静音: { aliases: ['静音姐'] } } };
  pipeline.runner.run = async () => ({ beats: [{ scene: '医院' }],
    characterRequests: ['静音姐', { npc: '静音' }, { npc: '新来的护士' }, '测试忍者', '玩家', {}, null] });
  const outline = await pipeline._generateOutline(withAliases, '询问伤员', null, { sceneBrief });
  assert.deepEqual(pipeline._extractInvolvedNPCs(sceneBrief, outline, withAliases), ['静音', '新来的护士']);
});

test('a missing outline does not discard an otherwise usable delegation choice', async () => {
  const pipeline = makePipeline();
  pipeline.runner.run = async () => ({ characterRequests: [{ npc: '静音' }] });
  const outline = await pipeline._generateOutline(state, '询问静音', null, { sceneBrief });
  assert.ok(outline.beats.length);
  assert.deepEqual(pipeline._extractInvolvedNPCs(sceneBrief, outline, state), ['静音']);
});
