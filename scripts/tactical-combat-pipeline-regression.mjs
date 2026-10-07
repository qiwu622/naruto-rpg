import assert from 'node:assert/strict';
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
globalThis.customElements ||= { get: () => null };
globalThis.fetch = async () => { throw new Error('Live requests forbidden in tactical tests'); };
localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
localStorage.setItem('naruto_memory_config', JSON.stringify({ recallEnabled: false }));
localStorage.setItem('naruto_api_config', JSON.stringify({ backend: 'tavern', model: 'tactical-fixture', disableStreaming: true,
  aiCallPolicy: { strictSingleCall: false }, variableUpdater: { enabled: true, model: 'tactical-fixture' }, narrativeReview: { enabled: false } }));
const [{ MessagePipeline }, { stateManager }, { combatSystem }, { memorySystem }, { aiClient }, { eventBus }, session] = await Promise.all([
  import('../js/core/pipeline.js'), import('../js/core/state-manager.js'), import('../js/systems/combat-system.js'),
  import('../js/systems/memory-system.js'), import('../js/core/ai-client.js'), import('../js/core/event-bus.js'),
  import('../js/systems/tactical-combat-session.js')
]);
aiClient.configure({ backend: 'tavern', model: 'tactical-fixture' });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
function fixture({ active = true, enabled = true, failSave = false, strictSingleCall = false } = {}) {
  const apiConfig = JSON.parse(localStorage.getItem('naruto_api_config'));
  apiConfig.aiCallPolicy = { strictSingleCall };
  localStorage.setItem('naruto_api_config', JSON.stringify(apiConfig));
  const state = stateManager.getDefaultState();
  Object.assign(state, { '玩家·姓名': '试炼者', '玩家·存活': '是', '玩家·忍阶': '下忍', '世界·地点': '训练场',
    '世界·时间': '木叶48年1月1日', '系统·回合数': 7,
    '属性·生命力': 250, '属性·当前生命力': 250, '属性·查克拉': 120, '属性·当前查克拉': 120,
    '属性·体力': 120, '属性·当前体力': 120, '属性·精神力': 80, '属性·当前精神力': 80, '属性·速度': 60,
    '技能·忍术·测试火球·等级': 'C', '技能·忍术·测试火球·熟练度': 60, '技能·忍术·测试火球·威力': 34,
    '技能·忍术·测试火球·消耗': 15, '技能·忍术·测试火球·属性': '火' });
  state._ui.settings.tacticalCombat = enabled;
  state._meta.current_node_id = 'source-node';
  state._relationships = { 训练对手: { combatant: true, affection: 0, combat_stats: { 忍阶: '下忍', 生命力: 220, 生命力上限: 220,
    查克拉: 100, 查克拉上限: 100, 体力: 120, 体力上限: 120, 精神力: 70, 精神力上限: 70, 速度: 35, 忍术: [] } } };
  if (active) state._combat = combatSystem.createCombatState({ enemy_name: '训练对手', objective: '切磋' }, state);
  stateManager.state = state; stateManager._stateVersion++; stateManager._apiConfigCache = null;
  const captured = { plans: [], prompts: [], commits: [], ended: [], deaths: [] };
  const stops = [eventBus.on('combat:ended', value => captured.ended.push(value)), eventBus.on('player:died', value => captured.deaths.push(value))];
  const pipeline = new MessagePipeline({ combatSystem, memorySystem, timelineSystem: { async createNode(data, { validateCurrent } = {}) {
    validateCurrent?.();
    captured.commits.push(structuredClone(data));
    if (failSave) throw new Error('disk full');
    return { id: `node-${data.turnNumber}`, turn_receipt: data.turnReceipt };
  } } });
  globalThis.generateRaw = async (request) => {
    captured.plans.push(structuredClone(pipeline._activeTacticalPlan)); captured.prompts.push(request);
    return '训练场中，两人完成这一轮交锋，重新拉开距离，等待下一步行动。';
  };
  pipeline._runSecondaryVariableUpdate = async () => ({ output:
    '<variable>{"key":"属性·当前查克拉","op":"-","value":99}</variable>'
    + '<variable>{"path":"attributes.vitality_current","op":"sub","value":99}</variable>'
    + '<combat state="player_turn">{"action_name":"测试火球","damage_to_enemy":999,"chakra_cost":99}</combat>'
    + '<relationship>{"npc":"训练对手","affection_change":1,"combat_stats":{"生命力":0}}</relationship>'
    + '<memory>{"facts":["完成一轮训练交锋"]}</memory>', shinobiDaily: null });
  return { pipeline, captured, close: () => stops.forEach(stop => stop()) };
}
await test('real pipeline uses one deterministic tactical result and ignores duplicate model damage/cost', async () => {
  const { pipeline, captured, close } = fixture();
  const before = stateManager.get();
  assert.equal(before._combat.enemy_known, false, 'a stored NPC stat card is not player intelligence');
  const expected = session.buildTacticalPlan(before, { text: '我使用测试火球。' });
  try {
    const result = await pipeline.process('我使用测试火球。');
    assert.ok(result.timelineNodeId);
    assert.equal(captured.plans.length, 1);
    assert.equal(stateManager.get('属性·当前查克拉'), 105);
    assert.deepEqual(stateManager.getSub('_combat').last_round, expected.nextCombat.last_round);
    for (const update of expected.updates) assert.equal(stateManager.get(update.key), update.value);
    assert.equal(captured.commits[0].stateSnapshot._combat.last_round.action_id, expected.id);
    assert.match(stateManager.getSub('_memory').facts, /战斗第/);
  } finally { close(); }
});
await test('disk failure rolls back resources/combat/memory and retry keeps rolls and selected move', async () => {
  const { pipeline, captured, close } = fixture({ failSave: true });
  const before = stateManager.get();
  try {
    await assert.rejects(pipeline.process('利用掩护出手', { combatMoveId: 'skill:忍术:测试火球' }), { code: 'TURN_COMMIT_FAILED' });
    assert.equal(stateManager.get('属性·当前查克拉'), before['属性·当前查克拉']);
    assert.deepEqual(stateManager.getSub('_combat'), before._combat);
    assert.equal(pipeline.chatHistory.length, 0);
    pipeline.timelineSystem.createNode = async data => ({ id: 'retry-node', turn_receipt: data.turnReceipt });
    await pipeline.process('利用掩护出手');
    assert.deepEqual(captured.plans[0].nextCombat.last_round, captured.plans[1].nextCombat.last_round);
    assert.equal(stateManager.get('属性·当前查克拉'), 105);
  } finally { close(); }
});
await test('source changes while generating cannot commit a stale combat result', async () => {
  const { pipeline, captured, close } = fixture();
  globalThis.generateRaw = async () => {
    stateManager.update([{ key: '属性·当前体力', op: '=', value: 90 }]);
    return '交锋尚未结束。';
  };
  try {
    await assert.rejects(pipeline.process('我使用测试火球。'), { code: 'TACTICAL_STATE_CHANGED' });
    assert.equal(stateManager.get('属性·当前查克拉'), 120);
    assert.equal(stateManager.get('属性·当前体力'), 90);
    assert.equal(captured.commits.length, 0);
  } finally { close(); }
});
await test('player attack text alone never opens a tactical encounter', async () => {
  const { pipeline, captured, close } = fixture({ active: false });
  pipeline.chatHistory = [{ role: 'assistant', content: '训练对手站在训练场中央，等待回应。' }];
  pipeline._runSecondaryVariableUpdate = async () => ({ output: '<memory>{"facts":["对手尚未回应"]}</memory>' });
  try {
    await pipeline.process('我向训练对手发起攻击');
    assert.equal(captured.plans[0], null);
    assert.equal(stateManager.getSub('_combat'), null);
    assert.match(JSON.stringify(captured.prompts), /后续独立变量模型/);
  } finally { close(); }
  const second = fixture({ active: false });
  second.pipeline.chatHistory = [{ role: 'assistant', content: '训练对手站在训练场中央。' }];
  second.pipeline._runSecondaryVariableUpdate = async () => ({ output: '<memory>{"facts":["讨论战术"]}</memory>' });
  try {
    await second.pipeline.process('如果向训练对手发起攻击会怎样？');
    assert.equal(second.captured.plans[0], null);
    assert.equal(stateManager.getSub('_combat'), null);
  } finally { second.close(); }
});
await test('with panel enabled, secondary AI registers opening without spending resources or resolving a move', async () => {
  const { pipeline, captured, close } = fixture({ active: false });
  pipeline._runSecondaryVariableUpdate = async () => ({ output: '<combat state="start">{"enemy_name":"训练对手","objective":"切磋","distance":"中"}</combat><memory>{"facts":["双方开始切磋"]}</memory>' });
  try {
    const result = await pipeline.process('我们开始切磋。');
    const combat = stateManager.getSub('_combat');
    assert.equal(combat.is_active, true);
    assert.equal(combat.enemy_name, '训练对手');
    assert.equal(combat.rules_version, 'tactical-v1');
    assert.equal(combat.turn, 0);
    assert.ok(!combat.last_round);
    assert.equal(stateManager.get('属性·当前查克拉'), 120);
    assert.equal(captured.plans[0], null);
    assert.equal(captured.commits[0].stateSnapshot._combat.is_active, true);
    assert.doesNotMatch(result.cleanResponse, /<combat|enemy_name/);
  } finally { close(); }
});
await test('single-call AI registers hidden opening and a failed save rolls it back', async () => {
  const { SHINOBI_DAILY_EXAMPLE } = await import('../js/core/shinobi-daily.js');
  for (const failSave of [false, true]) {
    const { pipeline, captured, close } = fixture({ active: false, strictSingleCall: true, failSave });
    globalThis.generateRaw = async request => {
      captured.prompts.push(request);
      return '训练对手走到场地中央，与你相对站定，双方正式开始切磋。'
        + '<combat state="start">{"enemy_name":"训练对手","objective":"切磋"}</combat>'
        + '<state_update>{"changed":true}</state_update>'
        + '<memory>{"summary":"双方正式开始切磋。","facts":[],"clues":[],"pins":[],"npc_notes":{}}</memory>'
        + `<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`;
    };
    pipeline._runSecondaryVariableUpdate = async () => { throw new Error('extra model call forbidden'); };
    try {
      if (failSave) {
        await assert.rejects(pipeline.process('开始吧。'), { code: 'TURN_COMMIT_FAILED' });
        assert.equal(stateManager.getSub('_combat'), null);
      } else {
        const result = await pipeline.process('开始吧。');
        assert.equal(stateManager.getSub('_combat').is_active, true);
        assert.equal(stateManager.getSub('_combat').turn, 0);
        assert.doesNotMatch(result.cleanResponse, /<combat|enemy_name/);
      }
      assert.equal(stateManager.get('属性·当前查克拉'), 120);
      assert.match(JSON.stringify(captured.prompts), /战斗状态登记/);
    } finally { close(); }
  }
});
await test('tactical defeat at zero HP is not automatic death and rollback emits no death', async () => {
  const { captured, close } = fixture();
  try {
    const combat = stateManager.getSub('_combat');
    combatSystem.commitTacticalRound({ nextCombat: { ...combat, rules_version: 'tactical-v1', result: 'defeat', is_active: false },
      updates: [{ key: '属性·当前生命力', op: '=', value: 0 }] });
    assert.equal(stateManager.get('属性·当前生命力'), 0);
    assert.equal(stateManager.get('玩家·存活'), '是');
    assert.equal(captured.deaths.length, 0);
    stateManager.update([{ key: '属性·当前生命力', op: '=', value: 50 }]);
    assert.equal(stateManager.getSub('_combat').player_incapacitated, undefined);
    stateManager.update([{ key: '属性·当前生命力', op: '=', value: 0 }]);
    assert.equal(stateManager.get('玩家·存活'), '否');
  } finally { close(); }
});
await test('disabled tactical mode keeps legacy model-driven settlement', async () => {
  const { pipeline, captured, close } = fixture({ enabled: false });
  try {
    await pipeline.process('我使用测试火球。');
    assert.equal(captured.plans[0], null);
    assert.equal(stateManager.getSub('_combat').turn, 1);
    assert.doesNotMatch(JSON.stringify(captured.prompts), /战术回合 · 剧情与状态|战斗状态登记|战术判定与现场/);
  } finally { close(); }
});
await test('default strict single-call mode settles locally without an extra model call', async () => {
  const { pipeline, captured, close } = fixture({ strictSingleCall: true });
  const { SHINOBI_DAILY_EXAMPLE } = await import('../js/core/shinobi-daily.js');
  let calls = 0;
  globalThis.generateRaw = async request => {
    calls++;
    captured.prompts.push(request);
    return '训练场中，对手踏步后撤，避开袭来的火球。'
      + '<variable>{"key":"属性·当前查克拉","op":"-","value":99}</variable>'
      + '<combat state="player_turn">{"damage_to_enemy":999,"chakra_cost":99}</combat>'
      + '<state_update>{"changed":true}</state_update>'
      + '<memory>{"summary":"完成一轮训练。","facts":[],"clues":[],"pins":[],"npc_notes":{}}</memory>'
      + `<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`;
  };
  pipeline._runSecondaryVariableUpdate = async () => { throw new Error('extra call forbidden'); };
  try {
    await pipeline.process('我使用测试火球。');
    assert.equal(calls, 1);
    assert.equal(stateManager.get('属性·当前查克拉'), 105);
    assert.ok(stateManager.getSub('_combat').last_round);
    assert.match(JSON.stringify(captured.prompts[0]), /战斗|战术/);
  } finally { close(); }
});
await test('strict output accepts locally settled combat without duplicate tags but still checks other domains', async () => {
  const { validateMainOutputContract } = await import('../js/core/main-output-contract.js');
  const validate = (displayText, settledCombat) => validateMainOutputContract({
    settledCombat, playerName: '试炼者', dailyResult: { valid: true }, artifact: { displayText, instructions: [
      { tag: 'state_update', content: '{"changed":false}' },
      { tag: 'memory', content: '{"summary":"记录本轮交锋"}' },
      { tag: 'shinobi_daily', content: '{}' }
    ] }
  });
  const story = '试炼者消耗了15点查克拉。你受伤后重新站稳。';
  assert.equal(validate(story, false).valid, false);
  assert.equal(validate(story, true).valid, true);
  for (const text of ['你消耗了100银两。', '试炼者赶到火影楼。', '你接受了护送任务。', '信任增加。']) {
    assert.equal(validate(text, true).valid, false, text);
  }
  const { pipeline, captured, close } = fixture({ strictSingleCall: true });
  const { SHINOBI_DAILY_EXAMPLE } = await import('../js/core/shinobi-daily.js');
  globalThis.generateRaw = async () => story + '<state_update>{"changed":false}</state_update>'
    + '<memory>{"summary":"完成一轮训练。","facts":[],"clues":[],"pins":[],"npc_notes":{}}</memory>'
    + `<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`;
  try {
    await pipeline.process('我使用测试火球。');
    assert.equal(captured.commits.length, 1);
    assert.equal(stateManager.get('属性·当前查克拉'), 105);
  } finally { close(); }
});
console.log(`Tactical pipeline regression: ${passed} passed.`);
