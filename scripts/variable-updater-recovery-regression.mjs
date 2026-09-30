import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as variableUpdater from '../js/core/variable-updater.js';
import { instructionParser } from '../js/core/instruction-parser.js';
import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';
import { buildCurrentStateEvidence } from '../js/core/turn-evidence.js';
import { normalizeRelationshipInstruction } from '../js/data/var-schema.js';
import { DEFAULT_VARIABLE_UPDATER_PRESET } from '../js/data/variable-updater-preset.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.customElements ||= { get: () => null };

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function manifest(overrides = '') {
  return `<variable_thinking>七、差异复检：输出清单：variable=1, mission=0, relationship=0, memory=1, combat=0, event=0。${overrides}</variable_thinking>`;
}

function obligationManifest({ domainUpdates = [], npcs = {}, missions = {} } = {}) {
  const domains = Object.fromEntries(variableUpdater.VARIABLE_UPDATE_DOMAINS.map(({ id }) => [
    id,
    domainUpdates.includes(id) ? 'updated' : 'unchanged'
  ]));
  return `<update_manifest>${JSON.stringify({ domains, present_npcs: npcs, active_missions: missions })}</update_manifest>`;
}

function completeVariableThinking(userInput = '继续', conclusion = '各领域均已逐项核对。') {
  return `<variable_thinking>请求复述：${userInput}
1. 时间地点与地图：旧值 -> 最终正文事实 -> 新值；已核对。
2. 资源与属性成长：旧值 -> 最终正文事实 -> 新值；已核对。
3. 技能与能力：旧值 -> 最终正文事实 -> 新值；已核对。
4. 物品、金钱与装备：旧值 -> 最终正文事实 -> 新值；已核对。
5. 任务、目标、声望与历练：旧值 -> 最终正文事实 -> 新值；已核对。
6. 人物关系与NPC状态：旧值 -> 最终正文事实 -> 新值；已核对。
7. 战斗、伤势与世界事件：旧值 -> 最终正文事实 -> 新值；已核对。
8. 记忆、线索、约定与待办：旧值 -> 最终正文事实 -> 新值；${conclusion}</variable_thinking>`;
}

async function prepareRecoveryPipeline(playerName) {
  globalThis.generateRaw = async () => '训练结束后，玩家收好忍具，准备离开第三训练场。';
  localStorage.setItem('naruto_api_config', JSON.stringify({
    backend: 'tavern', model: 'recovery-main', disableStreaming: false,
    aiCallPolicy: { strictSingleCall: false },
    variableUpdater: { enabled: true, backend: 'inherit', model: 'recovery-updater' },
    narrativeReview: { enabled: false }
  }));
  localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
  localStorage.setItem('naruto_memory_config', JSON.stringify({
    aiCompressionEnabled: false, deepEnabled: false, npcSummaryEnabled: false, recallEnabled: false
  }));
  localStorage.setItem('naruto_rpg_image_settings_v1', JSON.stringify({ enabled: false }));
  const [{ MessagePipeline }, { aiClient }, { stateManager }, { eventBus }] = await Promise.all([
    import('../js/core/pipeline.js'),
    import('../js/core/ai-client.js'),
    import('../js/core/state-manager.js'),
    import('../js/core/event-bus.js')
  ]);
  const state = stateManager.getDefaultState();
  state['玩家·姓名'] = playerName;
  state['玩家·存活'] = '是';
  state['世界·时间'] = 'K052-01-01';
  state['世界·年代'] = 'K052';
  state['世界·地点'] = '木叶第三训练场';
  state['系统·回合数'] = 7;
  state['进度·经验'] = 10;
  state._missions = { active: {}, completed: {}, failed: {} };
  state._relationships = {};
  stateManager.state = state;
  stateManager._stateVersion++;
  stateManager._apiConfigCache = null;
  aiClient.configure({ backend: 'tavern', model: 'recovery-main' });
  return { MessagePipeline, state, stateManager, eventBus };
}

await test('validator accepts consecutive JSON objects that the instruction parser can execute', () => {
  const output = variableUpdater.sanitizeVariableUpdaterOutput([
    manifest(),
    '<variable>{"key":"进度·经验","op":"+","value":3}{"key":"进度·金钱","op":"+","value":2}</variable>',
    '<memory>{"summary":"完成训练并获得少量经验与报酬。"}</memory>'
  ].join('\n'));
  const parsed = instructionParser.parse(output);
  assert.equal(parsed.variables.length, 2, 'fixture must exercise parser multi-object recovery');
  const validation = variableUpdater.validateVariableUpdaterOutput(output);
  assert.equal(validation.valid, true, validation.errors.join('\n'));
});

await test('existing non-combat NPC stays classified when a later relationship delta omits combat fields', () => {
  const output = variableUpdater.sanitizeVariableUpdaterOutput([
    manifest().replace('variable=1', 'variable=0').replace('relationship=0', 'relationship=1'),
    '<relationship>{"npc":"茶店老板","affection_change":2,"interaction":"玩家归还了借用的茶具。"}</relationship>',
    '<memory>{"summary":"玩家归还茶具，茶店老板的态度更友善。"}</memory>'
  ].join('\n'));
  const validation = variableUpdater.validateVariableUpdaterOutput(output, {
    state: { _relationships: { 茶店老板: { combatant: false, role: '商人', affection: 4 } } }
  });
  assert.equal(validation.valid, true, validation.errors.join('\n'));
});

await test('relationship aliases and numeric strings validate, while non-finite deltas are rejected', () => {
  const valid = [
    manifest().replace('variable=1', 'variable=0').replace('relationship=0', 'relationship=1'),
    '<relationship>{"name":"春野樱","affection_delta":"5","combatant":false}</relationship>',
    '<memory>{"summary":"春野樱对玩家的态度发生变化。"}</memory>'
  ].join('\n');
  assert.equal(variableUpdater.validateVariableUpdaterOutput(valid).valid, true);

  const invalid = valid.replace('"5"', '"NaN"');
  const validation = variableUpdater.validateVariableUpdaterOutput(invalid);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /affection_delta.*有限数值/);
});

await test('updater evidence preserves the explicit non-combat classification', () => {
  const evidence = buildCurrentStateEvidence({
    _relationships: {
      茶店老板: { entity_id: 'NPC-TEA', role: '商人', combatant: false, affection: 4 }
    }
  });
  assert.equal(evidence.relationships.茶店老板.combatant, false);
});

await test('structured obligations keep NPC completeness advisory while preserving field type checks', () => {
  const updateObligations = {
    present_npcs: [{ npc: '春野樱', source: 'final_narrative', agent_inner_thought: '这次配合比预想中顺利。' }],
    active_missions: [{ id: 'escort_existing', title: '护送委托' }]
  };
  const valid = variableUpdater.sanitizeVariableUpdaterOutput([
    completeVariableThinking('与春野樱继续护送任务'),
    obligationManifest({
      domainUpdates: ['relationships'],
      npcs: { 春野樱: 'updated' },
      missions: { escort_existing: 'unchanged' }
    }),
    '<relationship>{"npc":"春野樱","combatant":false,"history":"共同完成训练。","inner_thoughts":"这次配合比预想中顺利。"}</relationship>',
    '<memory>{"summary":"玩家与春野樱完成训练；护送委托本轮没有进展。"}</memory>'
  ].join('\n'));
  const options = {
    state: {
      _relationships: { 春野樱: { combatant: false } },
      _missions: { active: { escort_existing: { id: 'escort_existing', title: '护送委托' } } }
    },
    updateObligations
  };
  assert.equal(variableUpdater.validateVariableUpdaterOutput(valid, options).valid, true);

  const missingThought = variableUpdater.validateVariableUpdaterOutput(
    valid.replace(',"inner_thoughts":"这次配合比预想中顺利。"', ''),
    options
  );
  assert.equal(missingThought.valid, true, missingThought.errors.join('\n'));

  const missingRelationship = variableUpdater.validateVariableUpdaterOutput(
    valid.replace(/<relationship>[\s\S]*?<\/relationship>\n?/, ''), options
  );
  assert.equal(missingRelationship.valid, true);
  assert.equal(missingRelationship.manifest.domains.relationships, 'unchanged');
  assert.ok(missingRelationship.unmetObligations.some(item => item.includes('春野樱')));

  for (const [label, output, pattern] of [
    ['missing mission tag', valid.replace('"escort_existing":"unchanged"', '"escort_existing":"updated"'), /escort_existing.*mission/i],
    ['non-string history', valid.replace('"history":"共同完成训练。"', '"history":123'), /春野樱.*history/i],
    ['non-string thought', valid.replace('"inner_thoughts":"这次配合比预想中顺利。"', '"inner_thoughts":456'), /春野樱.*inner_thoughts/i],
    ['object history', valid.replace('"history":"共同完成训练。"', '"history":{"summary":"错误结构"}'), /春野樱.*history/i],
    ['array thought', valid.replace('"inner_thoughts":"这次配合比预想中顺利。"', '"inner_thoughts":["错误结构"]'), /春野樱.*inner_thoughts/i],
    ['progress without note', valid
      .replace('"escort_existing":"unchanged"', '"escort_existing":"updated"')
      .replace('<memory>', '<mission>{"id":"escort_existing","status":"progress","progress":{"current_step":2}}</mission>\n<memory>'), /escort_existing.*progress\.note/i]
  ]) {
    const result = variableUpdater.validateVariableUpdaterOutput(output, options);
    assert.equal(result.valid, false, label);
    assert.match(result.errors.join('\n'), pattern, label);
  }
});

await test('well-formed relationships are accepted even when the NPC evidence list is incomplete', () => {
  const narrativeResponse = '宇智波佐助、春野樱与旗木卡卡西都在训练场等待。';
  const output = [
    completeVariableThinking('观察训练场内的三名忍者'),
    obligationManifest({
      domainUpdates: ['relationships'],
      npcs: { 宇智波佐助: 'updated', 春野樱: 'updated', 旗木卡卡西: 'updated' }
    }),
    ...['宇智波佐助', '春野樱', '旗木卡卡西'].map(npc => (
      `<relationship>${JSON.stringify({
        npc,
        combatant: false,
        history: '本回合在训练场实际会面。',
        inner_thoughts: '继续观察当前局势。'
      })}</relationship>`
    )),
    '<memory>{"summary":"宇智波佐助、春野樱与旗木卡卡西均在训练场登场。"}</memory>'
  ].join('\n');
  const options = {
    state: {
      _relationships: {
        宇智波佐助: { combatant: false },
        春野樱: { combatant: false },
        旗木卡卡西: { combatant: false }
      }
    },
    narrativeResponse,
    updateObligations: {
      present_npcs: ['宇智波佐助', '春野樱', '旗木卡卡西'].map(npc => ({ npc })),
      active_missions: []
    }
  };

  const accepted = variableUpdater.validateVariableUpdaterOutput(output, options);
  assert.equal(accepted.valid, true, accepted.errors.join('\n'));

  const acceptedWithoutEvidence = variableUpdater.validateVariableUpdaterOutput(output, {
    ...options,
    updateObligations: { present_npcs: [], active_missions: [] }
  });
  assert.equal(acceptedWithoutEvidence.valid, true, acceptedWithoutEvidence.errors.join('\n'));
  assert.doesNotMatch(acceptedWithoutEvidence.errors.join('\n'), /未声明义务项|可信人物义务/);
});

await test('well-formed undeclared relationships survive validation and safe recovery', () => {
  const output = [
    completeVariableThinking('抵达训练场'),
    obligationManifest({ domainUpdates: ['relationships'] }),
    '<relationship>{"npc":"训练场","combatant":false,"history":"地点被误判为人物。","inner_thoughts":"错误身份。"}</relationship>',
    '<memory>{"summary":"玩家抵达训练场。"}</memory>'
  ].join('\n');
  const options = {
    state: { '玩家·姓名': '测试忍者', _relationships: {} },
    narrativeResponse: '测试忍者抵达训练场。',
    updateObligations: { present_npcs: [], active_missions: [] }
  };

  const validation = variableUpdater.validateVariableUpdaterOutput(output, options);
  assert.equal(validation.valid, true, validation.errors.join('\n'));

  const recovery = variableUpdater.filterSafeVariableUpdaterOutput(output, options);
  assert.equal(instructionParser.parse(recovery.output).relationships.length, 1);
});

await test('relationship obligation aliases do not block a well-formed write', () => {
  const updateObligations = {
    present_npcs: [{ npc: '旗木卡卡西', aliases: ['卡卡西'] }],
    active_missions: []
  };
  const base = npc => [
    completeVariableThinking('接受卡卡西的训练指导'),
    obligationManifest({ domainUpdates: ['relationships'], npcs: { 旗木卡卡西: 'updated' } }),
    `<relationship>${JSON.stringify({
      npc,
      combatant: false,
      history: '完成本回合训练。',
      inner_thoughts: '继续观察队伍。'
    })}</relationship>`,
    '<memory>{"summary":"卡卡西完成了训练指导。"}</memory>'
  ].join('\n');
  const options = {
    state: { _relationships: { 旗木卡卡西: { combatant: false } } },
    updateObligations
  };

  const canonical = variableUpdater.validateVariableUpdaterOutput(base('旗木卡卡西'), options);
  assert.equal(canonical.valid, true, canonical.errors.join('\n'));
  const alias = variableUpdater.validateVariableUpdaterOutput(base('卡卡西'), options);
  assert.equal(alias.valid, true, alias.errors.join('\n'));
});

await test('a new NPC delta does not require speculative combat classification', () => {
  const output = [
    completeVariableThinking('与路边旅人交换情报'),
    obligationManifest({ domainUpdates: ['relationships'] }),
    '<relationship>{"npc":"新认识的旅人","trust_change":1,"history":"在路边交换了情报。"}</relationship>',
    '<memory>{"summary":"玩家与一名旅人交换情报。"}</memory>'
  ].join('\n');
  const options = {
    state: { '系统·回合数': 8, _relationships: {} },
    updateObligations: { present_npcs: [], active_missions: [] }
  };

  const validation = variableUpdater.validateVariableUpdaterOutput(output, options);
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  const recovery = variableUpdater.filterSafeVariableUpdaterOutput(output, options);
  assert.equal(instructionParser.parse(recovery.output).relationships.length, 1);
});

await test('dangerous relationship identity keys are rejected before state mutation', async () => {
  const dangerous = ['__proto__', 'prototype', 'constructor'];
  for (const npc of dangerous) assert.equal(normalizeRelationshipInstruction({ npc }), null);

  const [{ relationshipSystem }, { stateManager }] = await Promise.all([
    import('../js/systems/relationship-system.js'),
    import('../js/core/state-manager.js')
  ]);
  const previous = stateManager.getSub('_relationships');
  try {
    stateManager.setSub('_relationships', {});
    const originalPrototype = Object.getPrototypeOf(stateManager.getSub('_relationships'));
    for (const npc of dangerous) relationshipSystem.processInstruction({ npc, combatant: false });
    const relationships = stateManager.getSub('_relationships');
    assert.equal(Object.getPrototypeOf(relationships), originalPrototype);
    for (const npc of dangerous) {
      assert.equal(Object.prototype.hasOwnProperty.call(relationships, npc), false);
    }
  } finally {
    stateManager.setSub('_relationships', previous || {});
  }
});

await test('relationship rename aliases normalize into one executable contract', () => {
  const normalized = normalizeRelationshipInstruction({
    operation: '改名',
    姓名: '  无名暗部  ',
    新姓名: '  天藏  ',
    affection_delta: '2',
    reason: '本人公开确认真名。'
  });
  assert.deepEqual(normalized, {
    op: 'rename',
    npc: '无名暗部',
    new_npc: '天藏',
    affection_change: 2,
    reason: '本人公开确认真名。'
  });

  const parsed = instructionParser.parse(
    '<relationship>{"operation":"重命名","name":"无名暗部","new_name":"天藏","trust_delta":3}</relationship>'
  );
  assert.deepEqual(parsed.relationships, [{
    op: 'rename', npc: '无名暗部', new_npc: '天藏', trust_change: 3
  }]);
});

await test('relationship rename validation rejects unsafe, occupied, and conflicting endpoints', () => {
  const state = {
    _relationships: {
      无名暗部: { combatant: true, aliases: ['暗部甲'] },
      临时队长: { combatant: true, aliases: ['大和'] }
    }
  };
  const output = relationshipTags => [
    manifest().replace('variable=1', 'variable=0').replace('relationship=0', `relationship=${relationshipTags.length}`),
    ...relationshipTags.map(value => `<relationship>${JSON.stringify(value)}</relationship>`),
    '<memory>{"summary":"核对人物身份变更。"}</memory>'
  ].join('\n');

  const valid = variableUpdater.validateVariableUpdaterOutput(output([{
    op: 'rename', npc: '无名暗部', new_npc: '天藏', trust_change: 2,
    reason: '本人公开确认真名。'
  }]), { state });
  assert.equal(valid.valid, true, valid.errors.join('\n'));

  for (const [label, relationships, pattern] of [
    ['missing source', [{ op: 'rename', npc: '不存在的人', new_npc: '天藏' }], /源人物不存在/],
    ['same name', [{ op: 'rename', npc: '无名暗部', new_npc: '无名暗部' }], /新旧姓名不能相同/],
    ['occupied key', [{ op: 'rename', npc: '无名暗部', new_npc: '临时队长' }], /目标姓名已存在/],
    ['occupied alias', [{ op: 'rename', npc: '无名暗部', new_npc: '大和' }], /用作别名/],
    ['unsafe target', [{ op: 'rename', npc: '无名暗部', new_npc: '__proto__' }], /有效且安全/],
    ['duplicate target', [
      { op: 'rename', npc: '无名暗部', new_npc: '天藏' },
      { op: 'rename', npc: '临时队长', new_npc: '天藏' }
    ], /端点冲突/],
    ['mixed old delta', [
      { op: 'rename', npc: '无名暗部', new_npc: '天藏' },
      { npc: '无名暗部', trust_change: 1 }
    ], /其他关系增量必须合并/],
    ['mixed new delta', [
      { op: 'rename', npc: '无名暗部', new_npc: '天藏' },
      { npc: '天藏', trust_change: 1 }
    ], /其他关系增量必须合并/]
  ]) {
    const result = variableUpdater.validateVariableUpdaterOutput(output(relationships), { state });
    assert.equal(result.valid, false, label);
    assert.match(result.errors.join('\n'), pattern, label);
  }
});

await test('safe recovery drops a conflicting rename batch but keeps unrelated writes', () => {
  const state = {
    _relationships: {
      无名暗部: { combatant: true },
      临时队长: { combatant: true },
      茶店老板: { combatant: false }
    }
  };
  const output = [
    manifest().replace('relationship=0', 'relationship=3'),
    '<variable>{"key":"进度·经验","op":"+","value":3}</variable>',
    '<relationship>{"op":"rename","npc":"无名暗部","new_npc":"天藏"}</relationship>',
    '<relationship>{"op":"rename","npc":"临时队长","new_npc":"天藏"}</relationship>',
    '<relationship>{"npc":"茶店老板","trust_change":1}</relationship>',
    '<memory>{"summary":"只保留可独立执行的训练与交谈记录。"}</memory>'
  ].join('\n');
  const recovered = variableUpdater.filterSafeVariableUpdaterOutput(output, { state });
  const parsed = instructionParser.parse(recovered.output);
  assert.equal(parsed.variables.length, 1);
  assert.deepEqual(parsed.relationships, [{ npc: '茶店老板', trust_change: 1 }]);
  assert.match(recovered.errors.join('\n'), /端点冲突/);
  assert.equal(recovered.droppedOperationCount >= 2, true);
});

await test('runtime rename atomically migrates the full NPC identity graph without visual deletion', async () => {
  const [{ relationshipSystem }, { stateManager }, { eventBus }] = await Promise.all([
    import('../js/systems/relationship-system.js'),
    import('../js/core/state-manager.js'),
    import('../js/core/event-bus.js')
  ]);
  const previousState = stateManager.snapshot();
  const state = stateManager.getDefaultState();
  state['系统·回合数'] = 12;
  state['世界·时间'] = 'K052-04-03';
  state['玩家·忍阶'] = '中忍';
  state['玩家·难度'] = '标准';
  const portraitBinding = {
    selected_asset_id: 'portrait-asset-7',
    version_group_id: 'portrait:subject-anbu-7',
    binding_revision: 4,
    last_job_id: 'portrait-job-4',
    updated_at: 1700000000000
  };
  state._relationships = {
    无名暗部: {
      name: '无名暗部', npc: '无名暗部', 姓名: '无名暗部', display_name: '无名暗部',
      aliases: ['暗部甲', '天藏'],
      affection: 26, trust: 41, respect: 55,
      role: '暗部忍者', faction: '木叶', status: 'ally', location: '木叶任务大厅',
      info: '以代号行动。', pinned: true, summary_turn_counter: 6,
      history: [{ turn: 11, time: 'K052-04-02', summary: '无名暗部完成了上轮交接。' }],
      inner_thoughts: [{ turn: 11, time: 'K052-04-02', summary: '仍需保持警惕。' }],
      tags: ['木叶', '暗部'], known_secrets: ['封印室暗号'],
      promises: ['护送玩家返回村内'], debts: ['欠玩家一次情报'],
      summaries: [{ from_turn: 1, to_turn: 10, text: '以代号与玩家共同行动。' }],
      grand_summary: '无名暗部曾长期隐藏真实姓名。',
      combatant: true,
      combat_stats: {
        忍阶: '中忍', 查克拉上限: 180, 查克拉: 73,
        生命力上限: 260, 生命力: 211,
        体力上限: 220, 体力: 144, 速度: 76,
        精神力上限: 170, 精神力: 99, 幸运: 21,
        忍术造诣: 61, 体术造诣: 58, 幻术造诣: 49,
        查克拉属性: ['水', '土'],
        忍术: [{ 名称: '水遁·水乱波', 等级: 'C', 属性: '水', 消耗资源: '查克拉', 消耗: 22, 威力: 34, 熟练度: 62, 描述: '喷出水流冲击目标。', 类型: '忍术' }],
        custom_combat_marker: { preserve: true }
      },
      visual_subject_id: 'subject-anbu-7',
      visual_profile: {
        subject_id: 'subject-anbu-7', display_name: '无名暗部',
        canonical_description: '无名暗部的既有外观描述保持不变。',
        locked_traits: ['棕色短发', '木叶护额'], current_appearance: '身着暗部制服',
        identity_seed: 7788, seed_by_renderer: { local: 17 }, revision: 9,
        reference_assets: ['reference-1']
      },
      portrait_binding: portraitBinding,
      profile_revision: 13,
      portrait_assets: [{ id: 'portrait-asset-7', url: 'asset://portrait-7' }],
      custom_profile_payload: { nested: ['必须保留'] }
    },
    临时队长: { combatant: false, affection: 3, aliases: [] }
  };
  state._memory = {
    ...state._memory,
    facts: '正文曾把无名暗部称为可靠的同伴。',
    npc_notes: [
      '无名暗部: [T11] 约定任务结束后说明身份',
      '无名暗部甲: 这个相似前缀不能被误改',
      '其他人: 正文中提到无名暗部，但这不是键前缀'
    ].join('\n'),
    relationship_history: JSON.stringify({
      无名暗部: { summary: '无名暗部以旧身份参与过三次任务。', count: 3 },
      其他人: { summary: '无关记录。', count: 1 }
    })
  };
  state._agent_memories = {
    无名暗部: {
      npcName: '无名暗部', privateGoals: ['继续调查'], knownFacts: ['玩家守约'],
      recentActions: ['完成交接'], privateIntentHistory: [{ turn: 11, thought: '暂不公开其他秘密。' }],
      relationToPlayer: { trust: 41 }, opaque: { keep: 'yes' }
    },
    其他人: { npcName: '其他人', knownFacts: ['无关'] }
  };
  state._combat = {
    is_active: true, enemy_name: '无名暗部', enemyName: '无名暗部',
    enemies: [
      '无名暗部',
      { name: '无名暗部', npcName: '无名暗部', enemy_name: '无名暗部', enemyName: '无名暗部', hp: 88 },
      { name: '其他人', hp: 70 }
    ],
    log: ['无名暗部在此前回合使用了水遁。']
  };
  stateManager.state = state;
  stateManager._stateVersion++;

  const events = { renamed: [], changed: [], visualChanged: [], visualDeleted: [], atomic: [] };
  const offs = [
    eventBus.on('relationship:renamed', payload => events.renamed.push(structuredClone(payload))),
    eventBus.on('relationship:changed', payload => events.changed.push(structuredClone(payload))),
    eventBus.on('relationship:visual-changed', payload => events.visualChanged.push(structuredClone(payload))),
    eventBus.on('relationship:visual-deleted', payload => events.visualDeleted.push(structuredClone(payload))),
    eventBus.on('state:changed', ({ batched }) => {
      if (!batched || events.atomic.length) return;
      const snapshot = stateManager.snapshot();
      events.atomic.push({
        relationship: Boolean(snapshot._relationships.天藏) && !snapshot._relationships.无名暗部,
        memory: snapshot._memory.npc_notes.startsWith('天藏:'),
        agent: Boolean(snapshot._agent_memories.天藏) && !snapshot._agent_memories.无名暗部,
        combat: snapshot._combat.enemy_name === '天藏'
      });
    })
  ];

  try {
    const [renamed] = relationshipSystem.processInstructions([{
      op: 'rename', npc: '无名暗部', new_npc: '天藏',
      trust_change: 4, history: '天藏公开确认了自己的规范姓名。',
      reason: '本人摘下面具并明确确认真名。'
    }]);
    assert.ok(renamed);
    const committed = stateManager.snapshot();
    assert.equal(committed._relationships.无名暗部, undefined);
    const card = committed._relationships.天藏;
    assert.ok(card);
    assert.equal(card.name, '天藏');
    assert.equal(card.npc, '天藏');
    assert.equal(card.姓名, '天藏');
    assert.equal(card.display_name, '天藏');
    assert.deepEqual(card.aliases, ['暗部甲', '无名暗部']);
    assert.equal(card.affection, 26);
    assert.equal(card.trust, 45);
    assert.equal(card.respect, 55);
    assert.equal(card.pinned, true);
    assert.equal(card.summary_turn_counter, 7);
    assert.equal(card.history[0].summary, '天藏公开确认了自己的规范姓名。');
    assert.equal(card.history[1].summary, '无名暗部完成了上轮交接。');
    assert.equal(card.grand_summary, '无名暗部曾长期隐藏真实姓名。');
    assert.deepEqual(card.summaries, [{ from_turn: 1, to_turn: 10, text: '以代号与玩家共同行动。' }]);
    assert.deepEqual(card.custom_profile_payload, { nested: ['必须保留'] });
    assert.equal(card.combat_stats.查克拉, 73);
    assert.equal(card.combat_stats.生命力, 211);
    assert.deepEqual(card.combat_stats.custom_combat_marker, { preserve: true });
    assert.equal(card.visual_subject_id, 'subject-anbu-7');
    assert.equal(card.visual_profile.display_name, '天藏');
    assert.equal(card.visual_profile.canonical_description, '无名暗部的既有外观描述保持不变。');
    assert.deepEqual(card.visual_profile.reference_assets, ['reference-1']);
    assert.equal(card.visual_profile.revision, 9);
    assert.deepEqual(card.portrait_binding, portraitBinding);
    assert.equal(card.profile_revision, 13);
    assert.deepEqual(card.portrait_assets, [{ id: 'portrait-asset-7', url: 'asset://portrait-7' }]);

    assert.match(committed._memory.npc_notes, /^天藏: \[T11\]/);
    assert.match(committed._memory.npc_notes, /^无名暗部甲:/m);
    assert.match(committed._memory.npc_notes, /^其他人: 正文中提到无名暗部/m);
    assert.equal(committed._memory.facts, '正文曾把无名暗部称为可靠的同伴。');
    const relationshipHistory = JSON.parse(committed._memory.relationship_history);
    assert.equal(relationshipHistory.无名暗部, undefined);
    assert.equal(relationshipHistory.天藏.summary, '无名暗部以旧身份参与过三次任务。');
    assert.equal(committed._agent_memories.无名暗部, undefined);
    assert.equal(committed._agent_memories.天藏.npcName, '天藏');
    assert.deepEqual(committed._agent_memories.天藏.opaque, { keep: 'yes' });
    assert.equal(committed._combat.enemy_name, '天藏');
    assert.equal(committed._combat.enemyName, '天藏');
    assert.equal(committed._combat.enemies[0], '天藏');
    assert.equal(committed._combat.enemies[1].name, '天藏');
    assert.equal(committed._combat.enemies[1].npcName, '天藏');
    assert.equal(committed._combat.enemies[1].enemy_name, '天藏');
    assert.equal(committed._combat.enemies[1].enemyName, '天藏');
    assert.deepEqual(committed._combat.log, ['无名暗部在此前回合使用了水遁。']);

    assert.deepEqual(events.atomic, [{ relationship: true, memory: true, agent: true, combat: true }]);
    assert.equal(events.renamed.length, 1);
    assert.equal(events.renamed[0].oldNpc, '无名暗部');
    assert.equal(events.renamed[0].newNpc, '天藏');
    assert.equal(events.changed.length, 1);
    assert.equal(events.changed[0].npc, '天藏');
    assert.equal(events.visualChanged.length, 0);
    assert.equal(events.visualDeleted.length, 0);

    const beforeConflict = stateManager.snapshot();
    const eventCountBeforeConflict = events.renamed.length + events.changed.length;
    const rejected = relationshipSystem.processInstructions([
      { op: 'rename', npc: '天藏', new_npc: '木遁忍者' },
      { op: 'rename', npc: '临时队长', new_npc: '木遁忍者' }
    ]);
    assert.deepEqual(rejected, []);
    assert.deepEqual(stateManager.snapshot(), beforeConflict, 'conflicting rename batch must not partially mutate state');
    assert.equal(events.renamed.length + events.changed.length, eventCountBeforeConflict);
  } finally {
    for (const off of offs) off();
    stateManager.state = previousState;
    stateManager._stateVersion++;
  }
});

await test('runtime prompt serializes update obligations and the machine-checkable manifest contract', () => {
  const privateThought = '只有角色代理知道的暗部伏笔，变量模型绝不能看见。';
  const rawState = {
    '系统·回合数': 8,
    _relationships: {},
    _missions: { active: {} },
    _agent_memories: {
      春野樱: { privateIntentHistory: [{ turn: 8, thought: privateThought }] }
    }
  };
  const messages = variableUpdater.buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, {
    state: rawState,
    compactState: {
      ...buildCurrentStateEvidence(rawState),
      _agent_memories: rawState._agent_memories,
      privateIntentHistory: [{ thought: privateThought }]
    },
    userInput: '与樱交谈', enrichedInput: '与樱交谈',
    narrativeResponse: '春野樱回应了玩家。',
    updateObligations: {
      present_npcs: [{
        npc: '春野樱',
        source: 'final_narrative',
        agent_inner_thought: privateThought,
        privateIntentHistory: [{ thought: privateThought }]
      }],
      active_missions: [{ id: 'training', title: '基础训练' }]
    }
  });
  const prompt = messages.map(message => message.content).join('\n');
  assert.match(prompt, /系统强制更新义务协议/);
  assert.match(prompt, /<update_manifest>/);
  assert.match(prompt, /"fixed_domains"/);
  assert.match(prompt, /"npc":"春野樱"/);
  assert.match(prompt, /"id":"training"/);
  assert.doesNotMatch(prompt, /agent_inner_thought|privateIntentHistory/);
  assert.doesNotMatch(prompt, new RegExp(privateThought));
  assert.doesNotMatch(prompt, /Agent 心声存在时必须据此落账/);
  assert.match(prompt, /world/);
  assert.match(prompt, /attributes_and_progression/);
  assert.match(prompt, /只读(?:证据)?分组名/);
  assert.match(prompt, /不得.{0,30}(?:作为|写入).{0,20}path/);
  assert.match(prompt, /canonical|规范姓名|npc.*逐字/iu);
});

await test('manifest statistics are derived locally while promised mission writes remain mandatory', () => {
  const updateObligations = {
    present_npcs: [{ npc: '春野樱' }],
    active_missions: [{ id: 'training', title: '基础训练' }]
  };
  const base = [
    completeVariableThinking('与春野樱继续训练'),
    obligationManifest({
      domainUpdates: ['attributes', 'relationships'],
      npcs: { 春野樱: 'updated' },
      missions: { training: 'unchanged' }
    }),
    '<variable>{"path":"progression.exp","op":"add","value":2}</variable>',
    '<relationship>{"npc":"春野樱","history":"共同完成训练。"}</relationship>',
    '<memory>{"summary":"玩家与春野樱完成训练。"}</memory>'
  ];
  const options = {
    state: {
      _relationships: { 春野樱: { combatant: false } },
      _missions: { active: { training: { id: 'training', title: '基础训练' } } }
    },
    updateObligations
  };
  assert.equal(variableUpdater.validateVariableUpdaterOutput(base.join('\n'), options).valid, true);

  const cases = [
    base.join('\n').replace('"skills":"unchanged",', ''),
    base.join('\n').replace('"attributes":"updated"', '"attributes":"unchanged"'),
    base.join('\n').replace('"春野樱":"updated"', ''),
    base.join('\n').replace('"training":"unchanged"', ''),
    base.join('\n').replace(
      '<memory>{"summary":"玩家与春野樱完成训练。"}</memory>',
      '<mission>{"id":"training","status":"progress","progress":{"note":"继续训练"}}</mission>\n<memory>{"summary":"玩家与春野樱完成训练。"}</memory>'
    )
  ];
  for (const output of cases) {
    const validation = variableUpdater.validateVariableUpdaterOutput(output, options);
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.equal(validation.manifest.domains.attributes, 'updated');
    assert.equal(validation.manifest.domains.relationships, 'updated');
  }
  const missingMission = variableUpdater.validateVariableUpdaterOutput(
    base.join('\n').replace('"training":"unchanged"', '"training":"updated"'), options
  );
  assert.equal(missingMission.valid, false);
  assert.match(missingMission.errors.join('\n'), /training.*mission/);
});

await test('request restatement and audit heading variations are advisory', () => {
  const valid = [
    completeVariableThinking('继续训练'),
    obligationManifest(),
    '<memory>{"summary":"本回合没有状态变化。"}</memory>'
  ].join('\n');
  const options = { updateObligations: { present_npcs: [], active_missions: [] } };
  assert.equal(variableUpdater.validateVariableUpdaterOutput(valid, options).valid, true);

  for (const invalid of [
    valid.replace('请求复述：继续训练\n', ''),
    valid.replace('3. 技能与能力：旧值 -> 最终正文事实 -> 新值；已核对。\n', ''),
    valid.replace(
      '2. 资源与属性成长：旧值 -> 最终正文事实 -> 新值；已核对。\n3. 技能与能力：旧值 -> 最终正文事实 -> 新值；已核对。',
      '3. 技能与能力：旧值 -> 最终正文事实 -> 新值；已核对。\n2. 资源与属性成长：旧值 -> 最终正文事实 -> 新值；已核对。'
    )
  ]) {
    const validation = variableUpdater.validateVariableUpdaterOutput(invalid, options);
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.ok(validation.warnings.length > 0);
  }
});

await test('NPC techniques require only name while supplied optional fields keep strict types', () => {
  const wrap = technique => [
    '<variable_thinking>只记录有依据的忍术字段。</variable_thinking>',
    `<relationship>${JSON.stringify({
      npc: '雾隐追忍', combatant: true, combat_stats: { jutsu: [technique] }
    })}</relationship>`,
    '<memory>{"summary":"雾隐追忍展示了一项忍术。"}</memory>'
  ].join('\n');
  const partial = variableUpdater.validateVariableUpdaterOutput(wrap({ name: '水遁·水乱波' }), {
    state: { _relationships: {} }
  });
  assert.equal(partial.valid, true, partial.errors.join('\n'));
  assert.match(partial.warnings.join('\n'), /rank|element|cost|尚未补全/);
  assert.equal(variableUpdater.validateVariableUpdaterOutput(wrap({}), { state: { _relationships: {} } }).valid, false);
  assert.equal(variableUpdater.validateVariableUpdaterOutput(wrap({ name: '水遁·水乱波', cost: '十八' }), {
    state: { _relationships: {} }
  }).valid, false);
});

await test('read-only evidence container paths produce an actionable correction', () => {
  const output = [
    '<variable_thinking>时间地点发生变化。</variable_thinking>',
    obligationManifest({ domainUpdates: [] }),
    '<variable>{"path":"world","op":"set","value":{"世界·地点":"火影楼","世界·天气":"晴"}}</variable>',
    '<memory>{"summary":"玩家抵达火影楼。"}</memory>'
  ].join('\n');
  const validation = variableUpdater.validateVariableUpdaterOutput(output, {
    updateObligations: { present_npcs: [], active_missions: [] }
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /world.*只读(?:证据)?分组名/);
  assert.match(validation.errors.join('\n'), /world_state\.current_location/);
});

await test('a single legal field inside a read-only evidence container is canonicalized locally', () => {
  const output = [
    completeVariableThinking('前往火影楼并使用查克拉'),
    obligationManifest({ domainUpdates: ['world', 'attributes'] }),
    '<variable>{"path":"world","op":"set","value":{"世界·地点":"火影楼"}}</variable>',
    '<variable>{"path":"attributes_and_progression","op":"sub","key":"属性·当前查克拉","value":5}</variable>',
    '<memory>{"summary":"玩家抵达火影楼并消耗少量查克拉。"}</memory>'
  ].join('\n');
  const validation = variableUpdater.validateVariableUpdaterOutput(output, {
    updateObligations: { present_npcs: [], active_missions: [] }
  });
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  assert.deepEqual(instructionParser.parse(output).variables, [
    { path: 'world_state.current_location', op: 'set', value: '火影楼' },
    { path: 'attributes.chakra_current', op: 'sub', value: 5 }
  ]);
});

await test('read-only container recovery unwraps matching objects without stringifying them', () => {
  const output = [
    completeVariableThinking('前往火影楼'),
    obligationManifest({ domainUpdates: ['world'] }),
    '<variable>{"path":"world","op":"set","key":"世界·地点","value":{"世界·地点":"火影楼"}}</variable>',
    '<memory>{"summary":"玩家抵达火影楼。"}</memory>'
  ].join('\n');
  const validation = variableUpdater.validateVariableUpdaterOutput(output, {
    updateObligations: { present_npcs: [], active_missions: [] }
  });
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  assert.deepEqual(instructionParser.parse(output).variables, [
    { path: 'world_state.current_location', op: 'set', value: '火影楼' }
  ]);
});

await test('read-only world recovery preserves calendar completeness and month consistency checks', () => {
  const options = { updateObligations: { present_npcs: [], active_missions: [] } };
  const incomplete = [
    '<variable_thinking>时间发生变化。</variable_thinking>',
    obligationManifest({ domainUpdates: ['world'] }),
    '<variable>{"path":"world","op":"set","value":{"世界·时间":"下午"}}</variable>',
    '<memory>{"summary":"时间来到下午。"}</memory>'
  ].join('\n');
  const incompleteResult = variableUpdater.validateVariableUpdaterOutput(incomplete, options);
  assert.equal(incompleteResult.valid, false);
  assert.match(incompleteResult.errors.join('\n'), /完整日期|world_state\.calendar/);

  const mismatch = [
    '<variable_thinking>日期发生变化。</variable_thinking>',
    obligationManifest({ domainUpdates: ['world'] }),
    '<variable>{"path":"world","op":"set","value":{"世界·时间":"木叶52年7月15日·正午"}}</variable>',
    '<variable>{"path":"world","op":"set","key":"世界·月份","value":8}</variable>',
    '<memory>{"summary":"日期推进到七月十五日。"}</memory>'
  ].join('\n');
  const mismatchResult = variableUpdater.validateVariableUpdaterOutput(mismatch, options);
  assert.equal(mismatchResult.valid, false);
  assert.match(mismatchResult.errors.join('\n'), /表示 7 月.*写入 8/);
});

await test('safe recovery reports unmet structured obligations without discarding unrelated valid updates', () => {
  const updateObligations = {
    present_npcs: [{ npc: '春野樱' }],
    active_missions: [{ id: 'escort_existing', title: '护送委托' }]
  };
  const output = [
    '<variable_thinking>训练带来少量历练，任务未推进。</variable_thinking>',
    obligationManifest({
      domainUpdates: ['attributes'],
      npcs: { 春野樱: 'updated' },
      missions: { escort_existing: 'unchanged' }
    }),
    '<variable>{"path":"progression.exp","op":"add","value":3}</variable>',
    '<memory>{"summary":"玩家完成训练。"}</memory>'
  ].join('\n');
  const recovery = variableUpdater.filterSafeVariableUpdaterOutput(output, {
    state: {
      _relationships: { 春野樱: { combatant: false } },
      _missions: { active: { escort_existing: { id: 'escort_existing' } } }
    },
    updateObligations
  });
  assert.equal(instructionParser.parse(recovery.output).variables.length, 1);
  assert.equal(instructionParser.parse(recovery.output).memories.length, 1);
  assert.ok(recovery.appliedCount >= 2);
  assert.match(recovery.unmetObligations.join('\n'), /春野樱/);
});

await test('safe recovery drops non-executable NPC interaction fields', () => {
  const updateObligations = { present_npcs: [{ npc: '春野樱' }], active_missions: [] };
  const output = [
    '<variable_thinking>训练与互动均已核对。</variable_thinking>',
    obligationManifest({ domainUpdates: ['attributes', 'relationships'], npcs: { 春野樱: 'updated' } }),
    '<variable>{"path":"progression.exp","op":"add","value":2}</variable>',
    '<relationship>{"npc":"春野樱","history":{"summary":"错误结构"},"inner_thoughts":["错误结构"]}</relationship>',
    '<memory>{"summary":"玩家完成训练并与春野樱交谈。"}</memory>'
  ].join('\n');
  const recovery = variableUpdater.filterSafeVariableUpdaterOutput(output, {
    state: { _relationships: { 春野樱: { combatant: false } } },
    updateObligations
  });
  const parsed = instructionParser.parse(recovery.output);
  assert.equal(parsed.variables.length, 1);
  assert.equal(parsed.memories.length, 1);
  assert.equal(parsed.relationships.length, 0);
  assert.match(recovery.errors.join('\n'), /春野樱.*history/i);
  assert.match(recovery.unmetObligations.join('\n'), /春野樱/);
});

await test('safe recovery drops a nameless mission but keeps executable variables and memory', () => {
  assert.equal(typeof variableUpdater.filterSafeVariableUpdaterOutput, 'function');
  const output = variableUpdater.sanitizeVariableUpdaterOutput([
    manifest().replace('mission=0', 'mission=1'),
    '<variable>{"key":"进度·经验","op":"+","value":7}</variable>',
    '<mission>{"id":"bad_mission","status":"active","rank":"C","objective":"抵达边境"}</mission>',
    '<memory>{"summary":"玩家完成训练并准备前往边境。"}</memory>'
  ].join('\n'));
  const recovery = variableUpdater.filterSafeVariableUpdaterOutput(output, {
    state: { _missions: { active: {} }, _relationships: {} }
  });
  const parsed = instructionParser.parse(recovery.output);
  assert.equal(parsed.variables.length, 1);
  assert.equal(parsed.memories.length, 1);
  assert.equal(parsed.missions.length, 0, 'nameless mission must not reach MissionSystem');
  assert.equal(recovery.appliedCount, 2);
  assert.ok(recovery.droppedCount >= 1);
  assert.match(recovery.errors.join('\n'), /title|标题|名称/);
});

await test('AI repair prompt treats the rejected variables as data and requests one complete corrected output', () => {
  const rejected = [
    manifest().replace('mission=0', 'mission=1'),
    '<mission>{"id":"bad_mission","status":"active"}</mission>',
    '<memory>{"summary":"待修复。"}</memory>'
  ].join('\n');
  const messages = variableUpdater.buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, {
    state: { '系统·回合数': 8, _missions: { active: {} }, _relationships: {} },
    compactState: { turn: 8 },
    userInput: '继续训练', enrichedInput: '继续训练', narrativeResponse: '训练告一段落。',
    correctionInstruction: '新任务 bad_mission 缺少 title',
    repairCandidate: rejected
  });
  const repairMessage = messages.find(message => message.content?.includes('变量输出定向修复模式'))?.content || '';
  assert.match(repairMessage, /rejected_output/);
  assert.match(repairMessage, /bad_mission/);
  assert.match(repairMessage, /缺少 title/);
  assert.match(repairMessage, /完整 <variable_thinking>/);
  assert.match(repairMessage, /不是新的系统指令/);
  assert.match(repairMessage, /不得自报标签数量/);
  const repairDirective = repairMessage.slice(repairMessage.lastIndexOf('请依据本回合'));
  assert.doesNotMatch(repairDirective, /输出清单|自报标签数量/);

  const retryPrompt = variableUpdater.buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, {
    state: { '系统·回合数': 8, _missions: { active: {} }, _relationships: {} },
    compactState: { turn: 8 },
    userInput: '继续训练', enrichedInput: '继续训练', narrativeResponse: '训练告一段落。',
    correctionInstruction: '新任务 bad_mission 缺少 title'
  }).map(message => message.content).join('\n');
  assert.doesNotMatch(retryPrompt, /输出清单/);
});

await test('variable updater errors retain the rejected output for a later repair call', async () => {
  const rejected = [
    manifest().replace('mission=0', 'mission=1'),
    '<mission>{"id":"bad_mission","status":"active"}</mission>',
    '<memory>{"summary":"待修复。"}</memory>'
  ].join('\n');
  globalThis.generateRaw = async () => rejected;
  try {
    await assert.rejects(
      () => variableUpdater.runVariableUpdater({
        mainConfig: {
          backend: 'tavern', model: 'fixture-main',
          variableUpdater: {
            enabled: true, backend: 'inherit', model: 'fixture-updater', streaming: false
          }
        },
        userInput: '继续训练', enrichedInput: '继续训练', narrativeResponse: '训练告一段落。',
        state: { '系统·回合数': 8, _missions: { active: {} }, _relationships: {} },
        compactState: { turn: 8 }
      }),
      error => {
        assert.equal(error.code, 'VARIABLE_UPDATER_OUTPUT_INCONSISTENT');
        assert.equal(error.failedOutput, rejected);
        assert.equal(error.rawOutput, rejected);
        return true;
      }
    );
  } finally {
    delete globalThis.generateRaw;
  }
});

await test('recovery UI exposes regenerate, AI repair, safe subset, and skip actions', () => {
  const modalSource = readFileSync(new URL('../js/ui/modal.js', import.meta.url), 'utf8');
  const shellSource = readFileSync(new URL('../js/ui/app-shell.js', import.meta.url), 'utf8');
  for (const label of ['重新生成变量', '调用 AI 修复', '安全保留', '跳过变量并继续']) {
    assert.match(modalSource, new RegExp(label));
  }
  assert.match(shellSource, /pipeline:variable-recovery-decision/);
  assert.match(shellSource, /Modal\.variableRecovery/);
});

await test('secondary structured generation defaults to low temperature everywhere it is presented', () => {
  assert.equal(variableUpdater.VARIABLE_UPDATER_DEFAULT_TEMPERATURE, 0.2);
  const settingsSource = readFileSync(new URL('../js/ui/settings-panel.js', import.meta.url), 'utf8');
  assert.match(settingsSource, /varUpdaterTemperature[\s\S]{0,180}\?\?\s*VARIABLE_UPDATER_DEFAULT_TEMPERATURE/);
  assert.match(settingsSource, /Number\.isFinite\(temperature\)[\s\S]{0,180}:\s*VARIABLE_UPDATER_DEFAULT_TEMPERATURE/);
});

await test('pipeline keeps distinct relationship deltas for the same NPC while deduplicating aliases', async () => {
  const { MessagePipeline } = await import('../js/core/pipeline.js');
  const routed = [];
  const pipeline = new MessagePipeline({
    relationshipSystem: { processInstruction: relationship => routed.push(relationship) }
  });
  const affection = { npc: '茶店老板', affection_change: 2, interaction: '归还茶具' };
  const trust = { npc: '茶店老板', trust_change: 1, interaction: '守住约定' };
  pipeline._applyInstructions({
    variables: [], combats: [], missions: [], events: [], memories: [],
    relationships: [affection, trust],
    relationship: affection
  }, true);
  assert.deepEqual(routed, [affection, trust]);
});

await test('pipeline routes one complete relationship batch when the runtime supports it', async () => {
  const { MessagePipeline } = await import('../js/core/pipeline.js');
  const batches = [];
  const fallback = [];
  const pipeline = new MessagePipeline({
    relationshipSystem: {
      processInstructions: relationships => batches.push(structuredClone(relationships)),
      processInstruction: relationship => fallback.push(relationship)
    }
  });
  const rename = { op: 'rename', npc: '无名暗部', new_npc: '天藏', trust_change: 2 };
  const unrelated = { npc: '茶店老板', affection_change: 1 };
  pipeline._applyInstructions({
    variables: [], combats: [], missions: [], events: [], memories: [],
    relationships: [rename, unrelated],
    relationship: rename
  }, true);
  assert.deepEqual(batches, [[rename, unrelated]]);
  assert.deepEqual(fallback, []);
});

await test('pipeline commits an undeclared well-formed relationship without retry or recovery UI', async () => {
  const { MessagePipeline, eventBus } = await prepareRecoveryPipeline('宽松人物写入测试者');
  const secondaryOutput = [
    completeVariableThinking('结束训练'),
    obligationManifest({ domainUpdates: ['relationships'] }),
    '<relationship>{"npc":"清单外旅人","trust_change":1,"history":"在路边交换了情报。"}</relationship>',
    '<memory>{"summary":"玩家完成训练；一名旅人的关系增量已记录。"}</memory>',
    `<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`
  ].join('\n');
  const routed = [];
  let mainCalls = 0;
  let updaterCalls = 0;
  let recoveryRequests = 0;
  globalThis.generateRaw = async options => {
    if (options?.custom_api?.model === 'recovery-updater') {
      updaterCalls++;
      return secondaryOutput;
    }
    mainCalls++;
    return '训练结束后，玩家收好忍具，准备离开第三训练场。';
  };
  const offRecovery = eventBus.on('pipeline:variable-recovery-decision', () => {
    recoveryRequests++;
    return { action: 'skip' };
  });
  const pipeline = new MessagePipeline({
    relationshipSystem: { processInstruction: relationship => routed.push(relationship) }
  });

  try {
    await pipeline.process('结束训练');
    assert.equal(mainCalls, 1);
    assert.equal(updaterCalls, 1, 'valid relationship must not trigger a consistency retry');
    assert.equal(recoveryRequests, 0, 'valid relationship must not open recovery UI');
    assert.equal(routed.length, 1);
    assert.equal(routed[0].npc, '清单外旅人');
    assert.equal(routed[0].trust_change, 1);
  } finally {
    offRecovery();
    delete globalThis.generateRaw;
  }
});

await test('secondary updates keep current changes while recording a later plot plan', async () => {
  const { MessagePipeline, stateManager } = await prepareRecoveryPipeline('未来约定测试者');
  const futurePlan = '三日后在火影楼接受边境护送任务';
  const response = [
    manifest(' 当前训练收获已经发生；未来约定只作为待办写入记忆。'),
    '<variable>{"key":"进度·经验","op":"+","value":5}</variable>',
    `<memory>{"summary":"玩家完成本轮训练并获得经验；${futurePlan}，该约定尚未执行。"}</memory>`
  ].join('\n');
  const pipeline = new MessagePipeline({});
  pipeline._runSecondaryVariableUpdate = async () => {
    pipeline._lastTurnEvidencePacket = {
      current_plot: {
        date_relation: 'nearest_future',
        scenes: [{ id: 'SCN-BORDER-ESCORT', outcomes: [futurePlan] }]
      }
    };
    return response;
  };

  try {
    await pipeline.process('结束训练并记下约定');
    assert.equal(stateManager.get('进度·经验'), 15,
      'future-text detection must not reject unrelated current-turn state changes');
  } finally {
    delete globalThis.generateRaw;
  }
});

await test('runtime prompt forces a domain-by-domain diff even for legacy custom presets', () => {
  const messages = variableUpdater.buildVariableUpdaterMessages({
    name: '旧自定义预设',
    version: 1,
    entries: [{
      id: 'legacy_turn',
      name: '旧条目',
      enabled: true,
      role: 'user',
      content: '[已确认的最终正文]\n{{narrative_response}}'
    }]
  }, {
    state: { '系统·回合数': 8, _missions: { active: {} }, _relationships: {} },
    compactState: { turn: 8 },
    userInput: '结束训练',
    enrichedInput: '结束训练',
    narrativeResponse: '训练结束，玩家获得经验，并约定三日后领取任务。'
  });
  const prompt = messages.map(message => message.content).join('\n');
  assert.match(prompt, /\[原始玩家输入\][\s\S]*结束训练/);
  assert.match(prompt, /系统强制反漏更协议/);
  assert.match(prompt, /领域：旧值 -> 最终正文事实 -> 新值/);
  assert.match(prompt, /已被接受、下达或确认的计划、约定、目标和期限[\s\S]*任务或 memory 待办/);
  assert.match(prompt, /<memory> 不能代替其他可执行标签/);
  assert.doesNotMatch(prompt, /输出清单：\s*variable=/);
});

await test('pipeline retries strict validation, then applies the safe subset and reports degradation', async () => {
  globalThis.generateRaw = async () => '训练结束后，玩家收好忍具，准备离开第三训练场。';
  localStorage.setItem('naruto_api_config', JSON.stringify({
    backend: 'tavern', model: 'safe-fallback-main', disableStreaming: false,
    aiCallPolicy: { strictSingleCall: false },
    variableUpdater: { enabled: true, backend: 'inherit', model: 'safe-fallback-updater' },
    narrativeReview: { enabled: false }
  }));
  localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
  localStorage.setItem('naruto_memory_config', JSON.stringify({
    aiCompressionEnabled: false, deepEnabled: false, npcSummaryEnabled: false, recallEnabled: false
  }));
  localStorage.setItem('naruto_rpg_image_settings_v1', JSON.stringify({ enabled: false }));

  const [{ MessagePipeline }, { aiClient }, { stateManager }, { eventBus }] = await Promise.all([
    import('../js/core/pipeline.js'),
    import('../js/core/ai-client.js'),
    import('../js/core/state-manager.js'),
    import('../js/core/event-bus.js')
  ]);
  const state = stateManager.getDefaultState();
  state['玩家·姓名'] = '降级恢复测试者';
  state['玩家·存活'] = '是';
  state['世界·时间'] = 'K052-01-01';
  state['世界·年代'] = 'K052';
  state['世界·地点'] = '木叶第三训练场';
  state['系统·回合数'] = 7;
  state['进度·经验'] = 10;
  state._missions = { active: {}, completed: {}, failed: {} };
  state._relationships = {};
  stateManager.state = state;
  stateManager._stateVersion++;
  stateManager._apiConfigCache = null;
  aiClient.configure({ backend: 'tavern', model: 'safe-fallback-main' });

  const malformed = variableUpdater.sanitizeVariableUpdaterOutput([
    manifest(' 严格校验会因无名任务失败。').replace('mission=0', 'mission=1'),
    '<variable>{"key":"进度·经验","op":"+","value":7}</variable>',
    '<mission>{"id":"bad_mission","status":"active","rank":"C","objective":"抵达边境"}</mission>',
    '<memory>{"summary":"玩家完成训练，经验有所增长。"}</memory>'
  ].join('\n'));
  const recovery = variableUpdater.filterSafeVariableUpdaterOutput(malformed, { state });
  const routedMissions = [];
  const warnings = [];
  let completePayload = null;
  let updaterCalls = 0;
  const unsubscribeWarning = eventBus.on('pipeline:warning', ({ warning }) => warnings.push(warning));
  const unsubscribeComplete = eventBus.on('pipeline:complete', payload => { completePayload = payload; });
  const pipeline = new MessagePipeline({
    missionSystem: { processInstruction: mission => routedMissions.push(mission) }
  });
  pipeline._runSecondaryVariableUpdate = async () => {
    updaterCalls++;
    const error = new Error('变量自检与结构标签不一致：新任务 bad_mission 缺少 title');
    error.code = 'VARIABLE_UPDATER_OUTPUT_INCONSISTENT';
    error.recovery = recovery;
    error.safeOutput = recovery.output;
    throw error;
  };

  try {
    await pipeline.process('结束训练');
    assert.equal(updaterCalls, 2, 'strict consistency retry must be retained');
    assert.equal(stateManager.get('进度·经验'), 17, 'valid subset must apply exactly once');
    assert.equal(routedMissions.length, 0, 'invalid task must never be routed');
    assert.match(warnings.join('\n'), /安全应用|安全保留|降级/);
    assert.match(completePayload?.thinkContent || '', /降级/);
    assert.match(completePayload?.thinkContent || '', /丢弃|舍弃/);
  } finally {
    unsubscribeWarning();
    unsubscribeComplete();
    delete globalThis.generateRaw;
  }
});

await test('secondary retries retain the last valid daily when a later attempt regresses', async () => {
  const { MessagePipeline, eventBus } = await prepareRecoveryPipeline('日报重试保留测试者');
  let updaterCalls = 0;
  const pipeline = new MessagePipeline({});
  pipeline._runSecondaryVariableUpdate = async () => {
    updaterCalls++;
    const error = new Error(`第 ${updaterCalls} 次变量输出未通过一致性校验`);
    error.code = 'VARIABLE_UPDATER_OUTPUT_INCONSISTENT';
    if (updaterCalls === 1) error.shinobiDaily = SHINOBI_DAILY_EXAMPLE;
    throw error;
  };
  const off = eventBus.on('pipeline:variable-recovery-decision', () => ({ action: 'skip' }));
  try {
    const result = await pipeline.process('结束训练并查看当日报纸');
    assert.equal(updaterCalls, 2);
    assert.deepEqual(result.shinobiDaily, SHINOBI_DAILY_EXAMPLE);
  } finally {
    off();
    delete globalThis.generateRaw;
  }
});

await test('recovery UI keeps the final attempt error, output, counts, and recovery diagnostics together', async () => {
  const { MessagePipeline, eventBus } = await prepareRecoveryPipeline('恢复尝试一致性测试者');
  const attempts = [
    {
      message: '第一次失败：旧任务错误', failedOutput: '<memory>{"summary":"first"}</memory>',
      recovery: {
        output: '<memory>{"summary":"first-safe"}</memory>',
        keptOperationCount: 7, droppedOperationCount: 1,
        errors: ['first recovery error'], unmetObligations: ['first unmet']
      }
    },
    {
      message: '第二次失败：player_retreat 后续错误', failedOutput: '<memory>{"summary":"second"}</memory>',
      recovery: {
        output: '<memory>{"summary":"second-safe"}</memory>',
        keptOperationCount: 2, droppedOperationCount: 4,
        errors: ['second recovery error'], unmetObligations: ['second unmet']
      }
    }
  ];
  let call = 0;
  const pipeline = new MessagePipeline({});
  pipeline._runSecondaryVariableUpdate = async () => {
    const current = attempts[call++];
    const error = new Error(current.message);
    error.code = 'VARIABLE_UPDATER_OUTPUT_INCONSISTENT';
    error.failedOutput = current.failedOutput;
    error.recovery = current.recovery;
    throw error;
  };
  const requests = [];
  const off = eventBus.on('pipeline:variable-recovery-decision', request => {
    requests.push(structuredClone(request));
    return { action: 'skip' };
  });
  try {
    await pipeline.process('继续');
    assert.equal(call, 2);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].attempt, 2);
    assert.match(requests[0].error, /第二次失败/);
    assert.doesNotMatch(requests[0].error, /第一次失败/);
    assert.equal(requests[0].failedOutput, attempts[1].failedOutput);
    assert.equal(requests[0].safeAppliedCount, 2);
    assert.equal(requests[0].safeDroppedCount, 4);
    assert.deepEqual(requests[0].recoveryErrors, ['second recovery error']);
    assert.deepEqual(requests[0].unmetObligations, ['second unmet']);
  } finally {
    off();
    delete globalThis.generateRaw;
  }
});

await test('final secondary failure can regenerate from the immutable turn context before commit', async () => {
  const { MessagePipeline, state, stateManager, eventBus } = await prepareRecoveryPipeline('变量重新生成测试者');
  const rejected = variableUpdater.sanitizeVariableUpdaterOutput([
    manifest(' 缺少任务标题。').replace('mission=0', 'mission=1'),
    '<variable>{"key":"进度·经验","op":"+","value":99}</variable>',
    '<mission>{"id":"bad_mission","status":"active","objective":"抵达边境"}</mission>',
    '<memory>{"summary":"错误候选不应落账。"}</memory>'
  ].join('\n'));
  const recovery = variableUpdater.filterSafeVariableUpdaterOutput(rejected, { state });
  const regenerated = [
    manifest(),
    '<variable>{"key":"进度·经验","op":"+","value":4}</variable>',
    '<memory>{"summary":"重新演算后只记录实际训练收获。"}</memory>'
  ].join('\n');
  const calls = [];
  const decisions = [];
  const pipeline = new MessagePipeline({});
  pipeline._runSecondaryVariableUpdate = async options => {
    calls.push(structuredClone(options));
    if (calls.length === 3) return regenerated;
    const error = new Error('变量自检与结构标签不一致：新任务 bad_mission 缺少 title');
    error.code = 'VARIABLE_UPDATER_OUTPUT_INCONSISTENT';
    error.recovery = recovery;
    error.safeOutput = recovery.output;
    error.failedOutput = rejected;
    throw error;
  };
  const off = eventBus.on('pipeline:variable-recovery-decision', request => {
    decisions.push(structuredClone(request));
    return { action: 'regenerate' };
  });
  try {
    await pipeline.process('结束训练');
    assert.equal(decisions.length, 1, 'second failed attempt must ask for a recovery action');
    assert.equal(calls.length, 3);
    assert.equal(calls[2].correctionInstruction, '');
    assert.equal(calls[2].repairCandidate, '');
    assert.equal(stateManager.get('进度·经验'), 14, 'rejected safe subset must not apply before regeneration');
  } finally {
    off();
    delete globalThis.generateRaw;
  }
});

await test('final secondary failure can send the rejected output and validation error to AI repair', async () => {
  const { MessagePipeline, state, stateManager, eventBus } = await prepareRecoveryPipeline('变量AI修复测试者');
  const rejected = variableUpdater.sanitizeVariableUpdaterOutput([
    manifest(' 清单与错误任务不一致。').replace('mission=0', 'mission=1'),
    '<variable>{"key":"进度·经验","op":"+","value":88}</variable>',
    '<mission>{"id":"bad_mission","status":"active","objective":"抵达边境"}</mission>',
    '<memory>{"summary":"待修复的错误候选。"}</memory>'
  ].join('\n'));
  const recovery = variableUpdater.filterSafeVariableUpdaterOutput(rejected, { state });
  const repaired = [
    manifest(),
    '<variable>{"key":"进度·经验","op":"+","value":6}</variable>',
    '<memory>{"summary":"AI 修复后保留合法的训练收获。"}</memory>'
  ].join('\n');
  const calls = [];
  const decisions = [];
  const pipeline = new MessagePipeline({});
  pipeline._runSecondaryVariableUpdate = async options => {
    calls.push(structuredClone(options));
    if (calls.length === 3) return repaired;
    const error = new Error('变量自检与结构标签不一致：新任务 bad_mission 缺少 title');
    error.code = 'VARIABLE_UPDATER_OUTPUT_INCONSISTENT';
    error.recovery = recovery;
    error.safeOutput = recovery.output;
    error.failedOutput = rejected;
    throw error;
  };
  const off = eventBus.on('pipeline:variable-recovery-decision', request => {
    decisions.push(structuredClone(request));
    return { action: 'repair' };
  });
  try {
    await pipeline.process('结束训练');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].canRepair, true);
    assert.equal(decisions[0].failedOutput, rejected);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].repairCandidate, rejected);
    assert.match(calls[2].correctionInstruction, /缺少 title/);
    assert.equal(stateManager.get('进度·经验'), 16, 'only repaired output may reach state mutation');
  } finally {
    off();
    delete globalThis.generateRaw;
  }
});

console.log(`\nvariable-updater-recovery-regression: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('Failed checks:');
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error?.message || failure.error}`);
  process.exitCode = 1;
}
