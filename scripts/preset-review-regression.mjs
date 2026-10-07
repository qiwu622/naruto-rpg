import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_MAIN_PRESET,
  DEFAULT_MAIN_PRESET_VERSION,
  invalidateMainPresetCache,
  getMainPreset,
  migrateMainPreset,
  resolvePresetMacros
} from '../js/data/default-preset.js';
import {
  DEFAULT_VARIABLE_UPDATER_PRESET,
  DEFAULT_VARIABLE_UPDATER_PRESET_VERSION,
  migrateVariableUpdaterPreset,
  resolveVariableUpdaterPreset,
  saveVariableUpdaterPreset
} from '../js/data/variable-updater-preset.js';
import {
  buildNarrativeReviewMessages,
  getNarrativeReviewConfig,
  parseNarrativeReviewPreview,
  validateNarrativeReviewOutput
} from '../js/core/narrative-review.js';
import { MessagePipeline } from '../js/core/pipeline.js';
import {
  buildVariableUpdaterMessages,
  buildVariableUpdaterRuntimeContract,
  sanitizeVariableUpdaterOutput,
  validateVariableUpdaterOutput,
  VARIABLE_UPDATER_COVERAGE_PROTOCOL
} from '../js/core/variable-updater.js';
import {
  MAIN_SINGLE_CALL_DELIVERY_REMINDER,
  MAIN_SINGLE_CALL_OUTPUT_PROMPT
} from '../js/core/main-output-contract.js';
import { instructionParser } from '../js/core/instruction-parser.js';
import {
  generateMainVarInstructions,
  getStructuredVariableContractPrompt,
  validateStructuredVariableUpdate
} from '../js/data/var-schema.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

function assertVisibleReasoningContract(text, tag, label) {
  assert.match(
    text,
    new RegExp(`(?:必须|务必|请)[^。\\n]{0,120}(?:输出|写入)[^。\\n]{0,40}<${tag}>`, 'i'),
    `${label} must require a visible <${tag}> block`
  );
  assert.match(text, /不得写入NPC未公开秘密、证据编号和审校模型私有记录/);
}

function createStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: key => map.delete(key),
    key: index => [...map.keys()][index] ?? null,
    get length() { return map.size; },
    dump: () => Object.fromEntries(map)
  };
}

test('main preset is evidence-led and contains no unresolved runtime placeholders', () => {
  const text = DEFAULT_MAIN_PRESET.entries.map(entry => entry.content).join('\n');
  assert.match(text, /当前状态、开局契约/);
  assert.match(text, /世界书.*模型预训练/s);
  assert.match(text, /十几年/);
  assert.match(text, /玩家最近相关行动/);
  assert.match(text, /权威证据与不确定项[\s\S]*时间线、地点与场景[\s\S]*玩家意图、行动边界与判定[\s\S]*连续性状态[\s\S]*因果、结果、记账与停止点/);
  assertVisibleReasoningContract(text, 'reasoning', 'main preset');
  assert.doesNotMatch(text, /\$\{[^}]+\}/);
  assert.doesNotMatch(text, /SYSTEM INITIALIZATION|50亿美金|mainDatabase/);
  assert.match(text, /\[行动\][\s\S]*每行|每行[\s\S]*\[行动\]/, 'main preset must require clickable action options');
  assert.doesNotMatch(text, /不输出替玩家决定的固定选项列表/);
  assert.match(text, /≈卦象判定≈[\s\S]*卦象：[\s\S]*≈卦终≈/, 'main preset must provide the divination rendering contract');
});

test('main and updater prompts require complete request restatement and planning checklists', () => {
  const mainPresetText = DEFAULT_MAIN_PRESET.entries.map(entry => entry.content).join('\n');
  const mainRuntimeText = [MAIN_SINGLE_CALL_OUTPUT_PROMPT, MAIN_SINGLE_CALL_DELIVERY_REMINDER].join('\n');
  for (const text of [mainPresetText, mainRuntimeText]) {
    assert.match(text, /逐字复述/);
    assert.match(text, /仅复述[^\n]*(?:玩家操作|玩家输入)[^\n]*不得复述[^\n]*隐藏系统/);
    for (const item of [
      '本轮请求原文', '任务拆解与硬约束', '权威证据与不确定项', '时间线、地点与场景',
      '玩家意图、行动边界与判定', 'NPC动机、知识边界与关系',
      '连续性状态', '因果、结果、记账与停止点'
    ]) assert.ok(text.includes(item), `main checklist missing: ${item}`);
    assert.match(text, /八项[^\n]*逐项[^\n]*(?:各写|单独)/);
    assert.match(text, /不得使用[^\n]*(?:“略”|略)[^\n]*(?:“同上”|同上)[^\n]*(?:“其余不变”|其余不变)/);
    assert.doesNotMatch(text, /最多\s*6\s*行|300\s*个汉字/);
  }

  const updaterText = [
    ...DEFAULT_VARIABLE_UPDATER_PRESET.entries.map(entry => entry.content),
    VARIABLE_UPDATER_COVERAGE_PROTOCOL
  ].join('\n');
  assert.match(updaterText, /逐字复述/);
  assert.match(updaterText, /仅复述[^\n]*原始玩家输入[^\n]*不得复述[^\n]*隐藏系统/);
  for (const item of [
    '时间地点与地图', '资源与属性成长', '技能与能力', '物品、金钱与装备',
    '任务、目标、声望与历练', '人物关系与NPC状态',
    '战斗、伤势与世界事件', '记忆、线索、约定与待办'
  ]) assert.ok(updaterText.includes(item), `updater checklist missing: ${item}`);
  assert.match(updaterText, /八个固定领域[^\n]*(?:各写|单独)[^\n]*一行/);
  assert.match(updaterText, /不得合并[^\n]*无变化/);
  assert.match(updaterText, /不得使用[^\n]*(?:“略”|略)[^\n]*(?:“同上”|同上)[^\n]*(?:“其余不变”|其余不变)/);
  assert.doesNotMatch(updaterText, /无变化领域可以合并|最多八行/);
});

test('all main-model rules are visible as editable preset entries', () => {
  const names = DEFAULT_MAIN_PRESET.entries.map(entry => entry.name);
  assert.ok(DEFAULT_MAIN_PRESET.entries.length >= 20, `expected at least 20 editable rules, got ${DEFAULT_MAIN_PRESET.entries.length}`);
  for (const required of [
    '记忆与连续性', '角色知识边界', '物品与忍术存在性', '关系成长与历练',
    '战斗资源与生命', '正文人称与玩家主权', '内部校验：证据与玩家边界',
    '内部校验：因果、角色与连续性', '内部校验：最终提交边界',
    '变量模型开启：正文职责', '变量模型关闭：物品与忍术变更', '变量模型关闭：结构标签'
  ]) {
    assert.ok(names.some(name => name.includes(required)), `missing editable rule entry: ${required}`);
  }
  const allText = DEFAULT_MAIN_PRESET.entries.map(entry => entry.content).join('\n');
  assert.match(allText, /equipment\.consumables[\s\S]*op["=:\s]+remove/);
  assert.match(allText, /skills\.jutsu[\s\S]*op["=:\s]+remove/);
  assert.match(allText, /日常闲聊[\s\S]*不得增加/);
});

test('preset mode entries are visible but only the matching variable mode is sent', () => {
  const on = resolvePresetMacros(DEFAULT_MAIN_PRESET.entries, { variableUpdaterEnabled: true, tacticalCombat: true });
  const off = resolvePresetMacros(DEFAULT_MAIN_PRESET.entries, { variableUpdaterEnabled: false, tacticalCombat: true });
  assert.ok(on.some(entry => entry.activation === 'variable_updater_enabled'));
  assert.ok(!on.some(entry => entry.activation === 'variable_updater_disabled'));
  assert.ok(off.some(entry => entry.activation === 'variable_updater_disabled'));
  assert.ok(!off.some(entry => entry.activation === 'variable_updater_enabled'));

  const onText = on.map(entry => entry.content).join('\n');
  const offText = off.map(entry => entry.content).join('\n');
  assert.match(onText, /绝对禁止输出任何结构标签/);
  assert.match(offText, /严格只调用一次主模型/);
  assert.match(offText, /始终输出 <memory>|必须输出一条 <memory>/);
  for (const tag of ['variable', 'combat', 'mission', 'relationship', 'memory', 'event']) {
    assert.match(offText, new RegExp(`<${tag}(?:[\\s>])`), `single-model preset missing <${tag}> contract`);
  }
  assertVisibleReasoningContract(onText, 'reasoning', 'main preset with variable updater');
  assertVisibleReasoningContract(offText, 'reasoning', 'single-model main preset');
});

test('main preset editor exposes activation conditions and pipeline no longer injects hidden main rules', () => {
  const editor = readFileSync(new URL('../js/ui/main-preset-editor.js', import.meta.url), 'utf8');
  const pipeline = readFileSync(new URL('../js/core/pipeline.js', import.meta.url), 'utf8');
  assert.match(editor, /PRESET_ACTIVATIONS/);
  assert.match(editor, /data-field="activation"/);
  assert.doesNotMatch(pipeline, /generateMainVarInstructions\(updaterEnabled\)/);
  assert.match(pipeline, /variableUpdaterEnabled: updaterEnabled/);
  assert.match(pipeline, /lastUserMessage:\s*userInput/);
  assert.doesNotMatch(pipeline, /lastUserMessage:\s*['"]刚才的行动['"]/);
});

test('main preset migration replaces built-ins and preserves custom entries', () => {
  const migrated = migrateMainPreset({
    name: '用户预设',
    entries: [
      { id: 'nm_003', name: '旧内置', enabled: true, role: 'system', content: 'old' },
      { id: 'custom_7', name: '用户规则', enabled: true, role: 'system', content: 'keep me' }
    ]
  });
  assert.equal(migrated._version, DEFAULT_MAIN_PRESET_VERSION);
  assert.ok(migrated.entries.some(entry => entry.id === 'main_builtin_authority'));
  assert.ok(migrated.entries.some(entry => entry.id === 'custom_7' && entry.content === 'keep me'));
  assert.ok(!migrated.entries.some(entry => entry.id === 'nm_003'));
});

test('main preset migration creates a recoverable backup', () => {
  const old = JSON.stringify({ _version: 'old', entries: [{ id: 'nm_003', enabled: true, content: 'old' }] });
  const storage = createStorage({ naruto_main_preset: old });
  globalThis.localStorage = storage;
  invalidateMainPresetCache();
  const migrated = getMainPreset();
  assert.equal(migrated._version, DEFAULT_MAIN_PRESET_VERSION);
  const dump = storage.dump();
  const backupKey = dump.naruto_main_preset_backup_latest;
  assert.ok(backupKey?.startsWith('naruto_main_preset_backup_'));
  assert.equal(dump[backupKey], old);
});

test('variable updater migration replaces built-ins and preserves user entries', () => {
  const migrated = migrateVariableUpdaterPreset({
    name: '旧变量预设',
    version: 1,
    entries: [
      { id: 'variable_updater_system', name: '旧系统', role: 'system', content: 'old' },
      { id: 'custom_variable_rule', name: '用户补充', role: 'system', content: 'keep' }
    ]
  });
  assert.equal(migrated.version, DEFAULT_VARIABLE_UPDATER_PRESET_VERSION);
  assert.equal(migrated.entries.find(entry => entry.id === 'variable_updater_system').content, DEFAULT_VARIABLE_UPDATER_PRESET.entries[0].content);
  assert.ok(migrated.entries.some(entry => entry.id === 'custom_variable_rule' && entry.content === 'keep'));
});

test('variable updater uses evidence priority without asking the updater to classify future prose', () => {
  const text = DEFAULT_VARIABLE_UPDATER_PRESET.entries.map(entry => entry.content).join('\n');
  assert.match(text, /世界书.*模型预训练知识/s);
  assert.match(text, /上一轮相关行动/);
  assert.match(text, /最后一件.*remove/s);
  assert.match(text, /已有战斗卡.*禁止重复生成整张战斗卡/s);
  assert.match(text, /原创忍者.*不得伪造 JT ID/s);
  assert.match(text, /完整差异审计/);
  assert.match(text, /必须[^\n]*输出[^\n]*<variable_thinking>/);
  assert.doesNotMatch(text, /未来倒灌|受保护未来|未来事件/);
  assert.doesNotMatch(text, /NEXT_ANCHOR|protected_future/);
  assert.match(text, /target_date 即使晚于 current_date[\s\S]*允许[\s\S]*<event>/);
});

test('main-model fallback tags match the executable updater contracts', () => {
  const editable = DEFAULT_MAIN_PRESET.entries
    .filter(entry => entry.activation === 'variable_updater_disabled')
    .map(entry => entry.content).join('\n');
  const generated = generateMainVarInstructions(false, { tacticalCombat: true });
  for (const prompt of [editable, generated]) {
    assert.match(prompt, /完整[^\n]*世界·时间[^\n]*自动同步[^\n]*世界·月份/);
    assert.doesNotMatch(prompt, /完整 世界·时间 和数字 世界·月份/);
    assert.match(prompt, /active\|progress\|completed\|failed\|abandoned/);
    assert.match(prompt, /remove_pins/);
    assert.match(prompt, /<combat state="start">\{"enemy_name"/);
    assert.doesNotMatch(prompt, /<combat state="start\|[^\n]+>\{\}<\/combat>/);
    assert.match(prompt, /completed\|resolved\|ended\|failed\|cancelled/);
    assert.match(prompt, /combatant:false/);
    assert.match(prompt, /"chakra_nature":\[\],"jutsu":\[\]/);
    assert.match(prompt, /resource_type|消耗资源/);
  }
});

test('NPC rename contract reaches every built-in and legacy updater path', () => {
  const renamePattern = /<relationship>\s*\{[^\n]*"op":"rename"[^\n]*"npc":"旧姓名"[^\n]*"new_npc":"新姓名"/;
  const mainPresetText = DEFAULT_MAIN_PRESET.entries.map(entry => entry.content).join('\n');
  const mainSingleModelText = generateMainVarInstructions(false);
  const updaterPresetText = DEFAULT_VARIABLE_UPDATER_PRESET.entries.map(entry => entry.content).join('\n');
  for (const [label, text] of [
    ['default main preset', mainPresetText],
    ['generated single-model instructions', mainSingleModelText],
    ['default updater preset', updaterPresetText]
  ]) {
    assert.match(text, renamePattern, label);
    assert.match(text, /禁止[^\n]*(?:delete|删除)[^\n]*(?:新建|创建)|不得删除旧档再新建/, label);
  }

  const legacyRuntime = buildVariableUpdaterMessages({
    name: '旧自定义变量预设',
    version: 1,
    entries: [{
      id: 'legacy_custom', name: '用户旧规则', enabled: true, role: 'user',
      content: '[已确认的最终正文]\n{{narrative_response}}'
    }]
  }, {
    state: {
      '系统·回合数': 3,
      _relationships: { 无名暗部: { aliases: ['暗部甲'], trust: 10 } },
      _missions: { active: {} }
    },
    compactState: { turn: 3 },
    userInput: '听他说出真名',
    narrativeResponse: '无名暗部摘下面具，确认自己的真名是天藏。'
  }).map(message => message.content).join('\n');
  assert.match(legacyRuntime, /系统强制人物关系身份协议/);
  assert.match(legacyRuntime, renamePattern);
  assert.match(legacyRuntime, /原子迁移完整关系档案/);

  const customRule = { id: 'rename_custom_rule', name: '用户补充', role: 'system', content: '必须保留我' };
  const migrated = migrateVariableUpdaterPreset({
    name: '旧变量预设', version: 1,
    entries: [{ id: 'variable_updater_system', role: 'system', content: '旧内置' }, customRule]
  });
  assert.match(migrated.entries.find(entry => entry.id === 'variable_updater_system').content, renamePattern);
  assert.deepEqual(migrated.entries.find(entry => entry.id === customRule.id), {
    ...customRule,
    enabled: true
  });
});

test('variable updater sanitizer preserves both supported self-check tags', () => {
  const cleaned = sanitizeVariableUpdaterOutput([
    '不应保留的普通前言',
    '<var_thinking>旧别名变量自检</var_thinking>',
    '<variable_thinking>七段变量自检</variable_thinking>',
    '<memory>{"summary":"本回合无额外变量变化，但保留连续性。"}</memory>'
  ].join('\n'));
  assert.match(cleaned, /<var_thinking>旧别名变量自检<\/var_thinking>/);
  assert.match(cleaned, /<variable_thinking>七段变量自检<\/variable_thinking>/);
  assert.match(cleaned, /<memory>/);
  assert.doesNotMatch(cleaned, /普通前言/);
});

test('variable updater combat contract matches the parser and settlement fields', () => {
  const presetText = DEFAULT_VARIABLE_UPDATER_PRESET.entries.map(entry => entry.content).join('\n');
  const mainText = DEFAULT_MAIN_PRESET.entries.map(entry => entry.content).join('\n');
  for (const text of [presetText, mainText]) {
    assert.match(text, /<combat state="player_turn">[\s\S]*action_name[\s\S]*damage_to_enemy/);
    assert.match(text, /<combat state="enemy_turn">[\s\S]*action_name[\s\S]*damage_to_player/);
  }
  assert.match(presetText, /结束状态只能逐字使用 victory、defeat、retreat/);
  assert.doesNotMatch(presetText, /<combat state="player_retreat">/);

  const output = sanitizeVariableUpdaterOutput([
    '<variable_thinking>七、差异复检：输出清单：variable=0, mission=0, relationship=0, memory=1, combat=1, event=0。</variable_thinking>',
    '<memory>{"summary":"玩家使用分身术牵制敌人。"}</memory>',
    '<combat state="player_turn">{"actor":"player","action_name":"分身术","action_rank":"E","action_type":"忍术","resource_type":"查克拉","damage_to_enemy":0,"log":"牵制成功"}</combat>'
  ].join('\n'));
  const validation = validateVariableUpdaterOutput(output);
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  const parsed = instructionParser.parse(output);
  assert.equal(parsed.combats.length, 1);
  assert.equal(parsed.combats[0].state, 'player_turn');
  assert.equal(parsed.combats[0].action_name, '分身术');
});

test('variable updater rejects tags that the instruction parser cannot consume', () => {
  const manifest = '<variable_thinking>七、差异复检：输出清单：variable=0, mission=0, relationship=0, memory=1, combat=0, event=0。</variable_thinking>';
  const invalid = [
    `${manifest}<memory>{"summary":"未闭合"}`,
    `${manifest}<memory kind="turn">{"summary":"含属性"}</memory>`,
    `${manifest}<memory>{bad json}</memory>`,
    `${manifest.replace('combat=0', 'combat=1')}<memory>{"summary":"战斗"}</memory><combat>{"state":"player_turn"}</combat>`,
    `${manifest.replace('combat=0', 'combat=1')}<memory>{"summary":"战斗"}</memory><combat state="player_turn">{bad json}</combat>`
  ];
  for (const output of invalid) {
    const cleaned = sanitizeVariableUpdaterOutput(output);
    assert.equal(validateVariableUpdaterOutput(cleaned).valid, false, output);
  }
});

test('variable updater rejects unknown paths and structurally empty operations', () => {
  const make = variable => sanitizeVariableUpdaterOutput([
    '<variable_thinking>七、差异复检：输出清单：variable=1, mission=0, relationship=0, memory=1, combat=0, event=0。</variable_thinking>',
    '<memory>{"summary":"变量检查。"}</memory>',
    `<variable>${JSON.stringify(variable)}</variable>`
  ].join('\n'));
  for (const variable of [
    { path: 'totally.fake.path', op: 'set', value: 123 },
    { path: 'attributes.chakra_current', op: 'subtract', value: 10 },
    {},
    { path: '_meta.current_node_id', op: 'set', value: 'forged' }
  ]) {
    const result = validateVariableUpdaterOutput(make(variable));
    assert.equal(result.valid, false, JSON.stringify(variable));
  }
});

test('structured scalar validation rejects operations and values that the state writer cannot apply', () => {
  const invalid = [
    { path: 'player.name', op: 'add', value: 1 },
    { path: 'world_state.calendar', op: 'add', value: 1 },
    { path: 'world_state.month', op: 'set', value: 'spring' },
    { path: 'attributes.chakra_current', op: 'sub', value: -10 },
    { path: 'player.alive', op: 'set', value: 'unknown' }
  ];
  for (const update of invalid) {
    assert.equal(validateStructuredVariableUpdate(update).valid, false, JSON.stringify(update));
  }
  for (const update of [
    { path: 'player.name', op: 'set', value: '鸣人' },
    { path: 'world_state.calendar', op: 'set', value: '木叶52年7月15日·正午' },
    { path: 'world_state.month', op: 'set', value: 7 },
    { path: 'attributes.chakra_current', op: 'sub', value: 10 }
  ]) {
    assert.equal(validateStructuredVariableUpdate(update).valid, true, JSON.stringify(update));
  }
});

test('legacy flat variables use the same type-aware operations as the state writer', () => {
  assert.equal(validateStructuredVariableUpdate({
    key: '世界·地点', op: '+', value: '火影岩'
  }).valid, false);
  assert.equal(validateStructuredVariableUpdate({
    key: '属性·当前查克拉', op: '-', value: Number.POSITIVE_INFINITY
  }).valid, false);
  assert.equal(validateStructuredVariableUpdate({
    key: '属性·当前查克拉', op: '+', value: -1
  }).valid, false);
  assert.equal(validateStructuredVariableUpdate({
    key: '属性·当前查克拉', op: '+', value: 10
  }).valid, true);
  assert.equal(validateStructuredVariableUpdate({
    key: '世界·地点', op: '=', value: '火影岩'
  }).valid, true);
});

test('structured parser normalizes operation casing after validation', () => {
  const output = sanitizeVariableUpdaterOutput([
    '<variable_thinking>地点已发生变化；其余领域无变化。</variable_thinking>',
    '<variable>{"path":"world_state.current_location","op":"SET","value":"第三训练场"}</variable>',
    '<memory>{"summary":"玩家抵达第三训练场。"}</memory>'
  ].join('\n'));
  const validation = validateVariableUpdaterOutput(output, { state: { '系统·回合数': 2 } });
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  assert.deepEqual(instructionParser.parse(output).variables[0], {
    path: 'world_state.current_location', op: 'set', value: '第三训练场'
  });
});

test('new skills and items require complete executable entity payloads', () => {
  for (const update of [
    { path: 'skills.jutsu.test', op: 'set', value: { name: 'test' } },
    { path: 'equipment.tools.kunai', op: 'set', value: { name: 'kunai' } }
  ]) {
    assert.equal(validateStructuredVariableUpdate(update).valid, false, JSON.stringify(update));
  }
  assert.equal(validateStructuredVariableUpdate({
    path: 'skills.jutsu.水遁·水乱波', op: 'set', value: {
      name: '水遁·水乱波', rank: 'C', element: '水', resource_type: '查克拉',
      cost: 18, power: 32, mastery: 60, description: '向前方释放水流。'
    }
  }).valid, true);
  assert.equal(validateStructuredVariableUpdate({
    path: 'equipment.tools.苦无', op: 'set',
    value: { quantity: 2, quality: '普通', description: '标准忍具。' }
  }).valid, true);
});

test('generated variable DSL documents canonical paths without legacy aliases', () => {
  const contract = getStructuredVariableContractPrompt();
  for (const path of [
    'player.current_goal', 'attributes.spirit_current', 'attributes.stamina_current',
    'progression.exp', 'equipment.ryo',
    'progression.reputation.*', 'equipment.equipped.weapon',
    'world_state.calendar', 'world_state.month', 'world_state.weather',
    'world_state.map.known_locations', 'world_state.map.explored_regions'
  ]) assert.match(contract, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const legacyPath of [
    'attributes.willpower', 'attributes.willpower_current',
    'progression.ryo', 'world_state.explored_regions'
  ]) assert.doesNotMatch(contract, new RegExp(legacyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(contract, /set, add, sub, assign, push, remove/);
  assert.doesNotMatch(contract, /\breplace\b|\bupdate\b|\bappend\b/);
});

test('variable updater rejects structurally non-executable mission event and npc records', () => {
  const wrap = (manifest, tag) => sanitizeVariableUpdaterOutput([
    `<variable_thinking>七、差异复检：输出清单：${manifest}。</variable_thinking>`,
    '<memory>{"summary":"结构记录检查。"}</memory>',
    tag
  ].join('\n'));
  const state = { _missions: { active: {} }, _relationships: {} };
  const invalid = [
    wrap('variable=0, mission=1, relationship=0, memory=1, combat=0, event=0', '<mission>{"status":"active","title":"护送"}</mission>'),
    wrap('variable=0, mission=1, relationship=0, memory=1, combat=0, event=0', '<mission>{"id":"M1","status":"active","title":"护送"}</mission>'),
    wrap('variable=0, mission=0, relationship=0, memory=1, combat=0, event=1', '<event>{"status":"occurred","description":"事件发生"}</event>'),
    wrap('variable=0, mission=0, relationship=1, memory=1, combat=0, event=0', '<relationship>{"npc":"甲","combatant":true,"combat_stats":{"jutsu":{}}}</relationship>'),
    wrap('variable=0, mission=0, relationship=0, memory=1, combat=1, event=0', '<combat state="teleport">{}</combat>')
  ];
  for (const output of invalid) {
    const result = validateVariableUpdaterOutput(output, { state });
    assert.equal(result.valid, false, output);
  }
});

test('variable updater preset cannot discard the confirmed narrative macro', () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = createStorage();
  try {
    assert.throws(() => saveVariableUpdaterPreset({
      name: '坏预设',
      version: DEFAULT_VARIABLE_UPDATER_PRESET_VERSION,
      entries: [{ id: 'custom', name: '缺少正文', enabled: true, role: 'system', content: '只看状态' }]
    }), /narrative_response|最终正文/);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('free-form audit prose cannot invent a missing mission requirement', () => {
  const cleaned = sanitizeVariableUpdaterOutput([
    '<variable_thinking>任务成长与世界：地点和时间需要更新；任务本身无变化。</variable_thinking>',
    '<memory>{"summary":"玩家移动后时间经过了一小时；本轮没有任务变化。"}</memory>'
  ].join('\n'));
  const result = validateVariableUpdaterOutput(cleaned);
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('variable updater accepts a declared mission when a real top-level mission tag exists', () => {
  const cleaned = sanitizeVariableUpdaterOutput([
    '<variable_thinking>五、任务成长与地图：本轮已确认接取护送委托，需要新增任务。\n七、差异复检：输出清单：variable=0, mission=1, relationship=0, memory=1, combat=0, event=0。</variable_thinking>',
    '<mission>{"id":"escort_tazuna","status":"active","rank":"C","title":"护送委托","objective":"护送委托人抵达目的地"}</mission>',
    '<memory>{"summary":"玩家接下护送委托，下一回合应承接任务目标。"}</memory>'
  ].join('\n'));
  const result = validateVariableUpdaterOutput(cleaned);
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('variable updater rejects a new active mission that omits every usable title field', () => {
  const cleaned = sanitizeVariableUpdaterOutput([
    '<variable_thinking>五、任务成长与地图：已接取名为护送委托的新任务。\n七、差异复检：输出清单：variable=0, mission=1, relationship=0, memory=1, combat=0, event=0。</variable_thinking>',
    '<mission>{"id":"escort_missing_title","status":"active","rank":"C","objective":"护送委托人抵达边境"}</mission>',
    '<memory>{"summary":"玩家接下护送委托。"}</memory>'
  ].join('\n'));
  const result = validateVariableUpdaterOutput(cleaned, { state: { _missions: { active: {} } } });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /标题|title/i);
});

test('variable updater permits a partial update for an already active mission', () => {
  const cleaned = sanitizeVariableUpdaterOutput([
    '<variable_thinking>五、任务成长与地图：护送任务目标有进展。\n七、差异复检：输出清单：variable=0, mission=1, relationship=0, memory=1, combat=0, event=0。</variable_thinking>',
    '<mission>{"id":"escort_existing","status":"active","objective":"抵达边境检查站"}</mission>',
    '<memory>{"summary":"护送队抵达边境检查站。"}</memory>'
  ].join('\n'));
  const result = validateVariableUpdaterOutput(cleaned, {
    state: { _missions: { active: { escort_existing: { id: 'escort_existing', title: '护送委托' } } } }
  });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('free-form audit prose cannot invent a missing relationship requirement', () => {
  const cleaned = sanitizeVariableUpdaterOutput([
    '<variable_thinking>人物关系：检查是否需要新增人物关系档案；结论为无变化。</variable_thinking>',
    '<memory>{"summary":"玩家独自完成整理，没有人物关系变化。"}</memory>'
  ].join('\n'));
  const result = validateVariableUpdaterOutput(cleaned);
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('variable updater permits incomplete NPC combat data and reports it as advisory', () => {
  const cleaned = sanitizeVariableUpdaterOutput([
    '<variable_thinking>新人物需要建立战斗型人物档案。</variable_thinking>',
    '<relationship>{"npc":"雾隐追忍","combatant":true,"role":"追忍"}</relationship>',
    '<memory>{"summary":"雾隐追忍拦住了玩家。"}</memory>'
  ].join('\n'));
  const result = validateVariableUpdaterOutput(cleaned, { state: { _relationships: {} } });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.match(result.warnings.join('\n'), /忍阶|jutsu|chakra_nature|战斗/);

  const explicitUnknown = sanitizeVariableUpdaterOutput([
    '<variable_thinking>该忍者已确认忍阶，但没有可靠的属性或招式证据。</variable_thinking>',
    '<relationship>{"npc":"雾隐追忍","combatant":true,"combat_stats":{"rank":"中忍","chakra_nature":[],"jutsu":[]}}</relationship>',
    '<memory>{"summary":"雾隐追忍拦住了玩家，能力细节仍未知。"}</memory>'
  ].join('\n'));
  assert.equal(validateVariableUpdaterOutput(explicitUnknown, { state: { _relationships: {} } }).valid, true);
});

test('prompt examples use concrete strict values instead of schema placeholders', () => {
  const text = [
    DEFAULT_MAIN_PRESET.entries.map(entry => entry.content).join('\n'),
    getStructuredVariableContractPrompt()
  ].join('\n');
  assert.doesNotMatch(text, /damage_to_(?:enemy|player)":数值/);
  assert.doesNotMatch(text, /state="victory\|defeat\|retreat"/);
  assert.doesNotMatch(text, /"(?:x|y)":坐标数字/);
  assert.doesNotMatch(text, /"\.\.\."|,\s*\.\.\./);
  assert.doesNotMatch(text, /"action_type":"忍术\|幻术\|体术\|支援"/);
  assert.doesNotMatch(text, /"resource_type":"查克拉\|精神力\|体力"/);
});

test('variable updater preset cannot discard the raw player input macro', () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = createStorage();
  try {
    assert.throws(() => saveVariableUpdaterPreset({
      name: '缺少玩家原文的预设',
      version: DEFAULT_VARIABLE_UPDATER_PRESET_VERSION,
      entries: [{
        id: 'custom', name: '只有正文', enabled: true, role: 'user',
        content: '[已确认的最终正文]\n{{narrative_response}}'
      }]
    }), /user_input|原始玩家输入/);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('legacy updater presets receive raw player input at runtime', () => {
  const messages = resolveVariableUpdaterPreset({
    name: '旧预设', version: 1,
    entries: [{
      id: 'legacy', name: '旧条目', enabled: true, role: 'user',
      content: '[已确认的最终正文]\n{{narrative_response}}'
    }]
  }, {
    userInput: '保留这句原始输入',
    narrativeResponse: '正文内容'
  });
  const prompt = messages.map(message => message.content).join('\n');
  assert.match(prompt, /\[原始玩家输入\][\s\S]*保留这句原始输入/);
  assert.match(prompt, /正文内容/);
});

test('variable updater still rejects malformed fields on an otherwise partial relationship', () => {
  const wrap = relationship => sanitizeVariableUpdaterOutput([
    '<variable_thinking>只写有依据的人物字段。</variable_thinking>',
    relationship,
    '<memory>{"summary":"人物资料发生变化。"}</memory>'
  ].join('\n'));
  for (const relationship of [
    '<relationship>{"npc":"旅人","combatant":"unknown"}</relationship>',
    '<relationship>{"npc":"旅人","combat_stats":[]}</relationship>',
    '<relationship>{"npc":"旅人","combatant":true,"combat_stats":{"chakra_nature":"水"}}</relationship>',
    '<relationship>{"npc":"旅人","combatant":true,"combat_stats":{"jutsu":{}}}</relationship>',
    '<relationship>{"npc":"旅人","trust_change":"NaN"}</relationship>'
  ]) {
    const result = validateVariableUpdaterOutput(wrap(relationship), { state: { _relationships: {} } });
    assert.equal(result.valid, false, relationship);
  }
});

test('variable updater accepts a complete nested combat card or an explicit civilian classification', () => {
  const ninja = sanitizeVariableUpdaterOutput([
    '<variable_thinking>新人物已展示有完整数据库依据的水遁。</variable_thinking>',
    '<relationship>{"npc":"雾隐追忍","combatant":true,"combat_stats":{"rank":"中忍","chakra_nature":["水"],"jutsu":[{"name":"水遁·水乱波","rank":"C","element":"水","resource_type":"查克拉","cost":18,"power":32,"mastery":60,"description":"向前方释放水流。","type":"忍术"}]}}</relationship>',
    '<memory>{"summary":"雾隐追忍施展水遁拦截玩家。"}</memory>'
  ].join('\n'));
  const civilian = sanitizeVariableUpdaterOutput([
    '<variable_thinking>三、人物关系：新人物茶店老板已登场，是非战斗人员。\n七、差异复检：输出清单：variable=0, mission=0, relationship=1, memory=1, combat=0, event=0。</variable_thinking>',
    '<relationship>{"npc":"茶店老板","combatant":false,"role":"商人"}</relationship>',
    '<memory>{"summary":"玩家与茶店老板交谈。"}</memory>'
  ].join('\n'));
  assert.equal(validateVariableUpdaterOutput(ninja, { state: { _relationships: {} } }).valid, true);
  assert.equal(validateVariableUpdaterOutput(civilian, { state: { _relationships: {} } }).valid, true);
});

test('mission and event status validation matches their business systems', () => {
  const wrap = body => sanitizeVariableUpdaterOutput([
    '<variable_thinking>对应业务状态已在正文中明确改变。</variable_thinking>',
    body,
    '<memory>{"summary":"对应状态已更新。"}</memory>'
  ].join('\n'));
  const state = { '系统·回合数': 2, _missions: { active: { M1: { id: 'M1', title: '巡逻' } } } };
  assert.equal(validateVariableUpdaterOutput(wrap('<mission>{"id":"M1","status":"abandoned"}</mission>'), { state }).valid, true);
  for (const status of ['completed', 'resolved', 'ended', 'failed', 'cancelled']) {
    const output = wrap(`<event>{"id":"ordinary-1","status":"${status}","description":"事件结束"}</event>`);
    assert.equal(validateVariableUpdaterOutput(output, { state }).valid, true, status);
  }
  const project = wrap('<event>{"id":"DAY-P1-START-001","status":"completed","description":"错误状态"}</event>');
  assert.equal(validateVariableUpdaterOutput(project, { state }).valid, false);
});

test('combat validation requires state-specific executable fields', () => {
  const wrap = combat => sanitizeVariableUpdaterOutput([
    '<variable_thinking>战斗状态发生变化。</variable_thinking>', combat,
    '<memory>{"summary":"战斗状态已记录。"}</memory>'
  ].join('\n'));
  for (const empty of [
    '<combat state="start">{}</combat>',
    '<combat state="player_turn">{}</combat>',
    '<combat state="victory">{}</combat>'
  ]) assert.equal(validateVariableUpdaterOutput(wrap(empty)).valid, false, empty);
  assert.equal(validateVariableUpdaterOutput(wrap(
    '<combat state="start">{"enemy_name":"雾隐追忍","enemy_rank":"中忍"}</combat>'
  )).valid, true);
  assert.equal(validateVariableUpdaterOutput(wrap(
    '<combat state="victory">{"log":"敌人失去战斗能力。"}</combat>'
  )).valid, true);
});

test('runtime updater prompt is deduplicated and ordered system before user data', () => {
  const marker = 'UNIQUE_STATE_MARKER_7F2A';
  const opening = 'UNIQUE_OPENING_MARKER_7F2A';
  const messages = buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, {
    state: { '系统·回合数': 2 }, compactState: { marker },
    userInput: '等待', narrativeResponse: '时间经过。',
    openingContract: opening,
    knowledgeContext: `[当前状态]\n{"marker":"${marker}"}`
  });
  assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
  const prompt = messages.map(message => message.content).join('\n');
  assert.equal(prompt.split(marker).length - 1, 1, 'current state must appear once');
  assert.equal(prompt.split(opening).length - 1, 1, 'opening contract must appear once');
});

test('shared variable updater runtime contract covers every project invariant exactly once', () => {
  const state = {
    _ui: { settings: { tacticalCombat: true } },
    '系统·回合数': 1,
    '进度·突破待处理': 3,
    skills: {
      talents: {
        自定义天赋组合: {
          name: '自定义天赋组合', rank: '待生成', mastery: 0, description: '由 AI 补全。'
        }
      },
      kekkei_genkai: {}, jutsu: {}, taijutsu: {}, genjutsu: {}, support: {}
    },
    _opening_contract: {
      version: 3,
      completion_policy: { mode: 'fill' },
      raw: { talents: ['自定义天赋组合'], abilities: [] }
    },
    _relationships: { 千鹤: { role: '旧搭档', affection: 10 } }
  };
  const updateObligations = {
    present_npcs: [{ npc: '千鹤' }],
    active_missions: [{ id: 'M-RUNTIME', title: '护送卷轴', status: 'active' }]
  };
  const contract = buildVariableUpdaterRuntimeContract({
    state,
    compactState: state,
    openingContract: 'OPENING_RUNTIME_CONTRACT_MARKER',
    updateObligations
  });
  for (const marker of [
    'OPENING_RUNTIME_CONTRACT_MARKER',
    '系统强制开局待补全协议',
    '系统强制首回合补全协议',
    '系统强制待初始化人物协议',
    '突破指令——本回合必须执行',
    '系统强制反漏更协议',
    '系统强制输出一致性协议',
    '系统强制只读证据与写入路径边界',
    '变量更新完整混合示例',
    '系统强制更新义务协议',
    '忍界日报结构契约',
    '系统强制战斗结算协议',
    '系统强制删除协议'
  ]) {
    assert.equal(contract.split(marker).length - 1, 1, `${marker} must appear exactly once`);
  }
  assert.match(contract, /待初始化人物：千鹤/);
  assert.match(contract, /当前突破待处理 = 3/);
  assert.match(contract, /"active_missions":\[\{"id":"M-RUNTIME","title":"护送卷轴","status":"active"\}\]/u);
  assert.match(contract, /"present_npcs":\[\{"npc":"千鹤"\}\]/u);
  assert.ok(contract.endsWith('同回合删除多个物品或技能时，每个对象分别输出一个 <variable>，不得合并或遗漏。'));

  const customPreset = {
    name: '保留旧突破宏的自定义预设',
    version: 1,
    entries: [{
      id: 'custom-turn', name: '本回合', enabled: true, role: 'user',
      content: '[原始玩家输入]\n{{user_input}}\n[最终正文]\n{{narrative_response}}\n{{breakthrough_instruction}}'
    }]
  };
  const messages = buildVariableUpdaterMessages(customPreset, {
    state,
    compactState: state,
    userInput: '继续修行',
    narrativeResponse: '修行告一段落。',
    updateObligations
  });
  const prompt = messages.map(message => message.content).join('\n');
  assert.equal(prompt.split('突破指令——本回合必须执行').length - 1, 1);
  assert.equal(prompt.split('变量更新完整混合示例').length - 1, 1);
  assert.equal(prompt.split('忍界日报结构契约').length - 1, 1);
});

test('first-turn fill omissions are advisory and complete entries still validate', () => {
  const state = {
    '系统·回合数': 1,
    skills: { talents: {}, kekkei_genkai: {}, jutsu: {}, taijutsu: {}, genjutsu: {}, support: {} },
    _opening_contract: { version: 3, completion_policy: { mode: 'fill' }, raw: { talents: [], abilities: [] } },
    _relationships: {}
  };
  const missing = sanitizeVariableUpdaterOutput([
    '<variable_thinking>四、技能物品：开局类别仍为空，但本轮不写入。\n七、差异复检：输出清单：variable=0, mission=0, relationship=0, memory=1, combat=0, event=0。</variable_thinking>',
    '<memory>{"summary":"开场完成。"}</memory>'
  ].join('\n'));
  const missingResult = validateVariableUpdaterOutput(missing, { state });
  assert.equal(missingResult.valid, true, missingResult.errors.join('\n'));
  assert.match(missingResult.warnings.join('\n'), /天赋|血继|初始能力/);

  const complete = sanitizeVariableUpdaterOutput([
    '<variable_thinking>四、技能物品：补全开局天赋与初始忍术。\n七、差异复检：输出清单：variable=2, mission=0, relationship=0, memory=1, combat=0, event=0。</variable_thinking>',
    '<variable>{"path":"skills.kekkei_genkai.冰遁","op":"set","value":{"name":"冰遁","rank":"初醒","mastery":35,"description":"融合水与风制造冰。"}}</variable>',
    '<variable>{"path":"skills.jutsu.冰遁·冰针","op":"set","value":{"name":"冰遁·冰针","rank":"D","element":"冰","resource_type":"查克拉","cost":12,"power":22,"mastery":30,"description":"凝结冰针。"}}</variable>',
    '<memory>{"summary":"开局档案补全冰遁与基础冰遁忍术。"}</memory>'
  ].join('\n'));
  assert.equal(validateVariableUpdaterOutput(complete, { state }).valid, true);
});

test('agent continuity gate strictly rejects unresolved opening and breakthrough requirements', () => {
  const state = {
    '系统·回合数': 1,
    '进度·突破待处理': 2,
    skills: { talents: {}, kekkei_genkai: {}, jutsu: {}, taijutsu: {}, genjutsu: {}, support: {} },
    _opening_contract: { version: 3, completion_policy: { mode: 'fill' }, raw: { talents: [], abilities: [] } },
    _relationships: {}
  };
  const base = [
    '<variable_thinking>开局与突破待办尚未完成。</variable_thinking>',
    '<memory>{"summary":"本回合待办已核对。"}</memory>'
  ].join('\n');
  const advisory = validateVariableUpdaterOutput(base, { state });
  assert.equal(advisory.valid, true, advisory.errors.join('\n'));

  const strict = validateVariableUpdaterOutput(base, { state, strictRuntimeRequirements: true });
  assert.equal(strict.valid, false);
  assert.match(strict.errors.join('\n'), /天赋|血继/);
  assert.match(strict.errors.join('\n'), /初始能力/);
  assert.match(strict.errors.join('\n'), /突破待处理.*清零/);
});

test('first-turn unresolved relationship classification is advisory', () => {
  const state = {
    '系统·回合数': 1,
    _opening_contract: { version: 3, completion_policy: { mode: 'strict' }, raw: {} },
    _relationships: { 千鹤: { role: '旧搭档', affection: 10 } },
    skills: { talents: {}, kekkei_genkai: {}, jutsu: {}, taijutsu: {}, genjutsu: {}, support: {} }
  };
  const missing = sanitizeVariableUpdaterOutput([
    '<variable_thinking>三、人物关系：千鹤是开局旧搭档。\n七、差异复检：输出清单：variable=0, mission=0, relationship=0, memory=1, combat=0, event=0。</variable_thinking>',
    '<memory>{"summary":"千鹤在开场出现。"}</memory>'
  ].join('\n'));
  const missingResult = validateVariableUpdaterOutput(missing, { state });
  assert.equal(missingResult.valid, true, missingResult.errors.join('\n'));
  assert.match(missingResult.warnings.join('\n'), /千鹤.*分类/);

  const classified = sanitizeVariableUpdaterOutput([
    '<variable_thinking>三、人物关系：千鹤是非战斗联络人。\n七、差异复检：输出清单：variable=0, mission=0, relationship=1, memory=1, combat=0, event=0。</variable_thinking>',
    '<relationship>{"npc":"千鹤","combatant":false,"role":"旧搭档"}</relationship>',
    '<memory>{"summary":"千鹤作为联络人在开场出现。"}</memory>'
  ].join('\n'));
  assert.equal(validateVariableUpdaterOutput(classified, { state }).valid, true);
});

test('agent writer prompts preserve the visible main reasoning contract', () => {
  const prompts = readFileSync(new URL('../js/core/agent-prompts.js', import.meta.url), 'utf8');
  assert.match(prompts, /WRITER:[\s\S]*<reasoning>/);
  assert.match(prompts, /WRITER:[\s\S]*内置主预设使用 <reasoning> 固定八项/);
  assert.match(prompts, /WRITER:[\s\S]*用户导入替换预设[^\n]*原生思考 wrapper/);
  assert.match(prompts, /WRITER:[\s\S]*开始与结束标签都不得缺失/);
  assert.match(prompts, /WRITER_POLISH:[\s\S]*保留[^\n]*<reasoning>/);
  assert.match(prompts, /WRITER_POLISH:[\s\S]*用户导入替换预设[^\n]*原生思考 wrapper/);
});

test('secondary updater mode gives all structured tags to the updater', () => {
  const instruction = generateMainVarInstructions(true);
  for (const tag of ['var', 'combat', 'mission', 'relationship', 'memory', 'event']) {
    assert.match(instruction, new RegExp(`禁止[^\\n]*结构标签|<${tag}>`));
  }
  assert.match(instruction, /<reasoning>[^\n]*结构化推演|结构化推演[^\n]*<reasoning>/);
  assert.doesNotMatch(instruction, /绝对禁止输出思考过程/);
  assert.match(instruction, /世界书与存档高于模型常识/);
});

test('two-stage review defaults off and inherits the main model', () => {
  const config = getNarrativeReviewConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.backend, 'inherit');
  assert.equal(config.temperature, 0.25);
  assert.equal(config.timeoutMs, 0);
});

test('review prompt contains the actual evidence chain and candidate', () => {
  const messages = buildNarrativeReviewMessages({
    sourceMessages: [{ role: 'system', content: '世界书：甲仍然存活' }, { role: 'user', content: '玩家刚才丢弃苦无' }],
    candidateResponse: '<thinking>草稿</thinking>十几年后，甲使用了苦无。'
  });
  const text = messages.map(message => message.content).join('\n');
  assert.match(text, /E1 · system/);
  assert.match(text, /玩家刚才丢弃苦无/);
  assert.match(text, /十几年后/);
  assert.doesNotMatch(text, /<thinking>草稿<\/thinking>/);
  assert.match(text, /问题位置.*违反证据.*替换文本.*复检结果/s);
  assert.match(text, /<audit_internal>/);
  assert.match(text, /<final>/);
  assert.match(text, /尚未提交|非提交预览/);
});

test('review output becomes a hidden-audit, non-committed narrative preview', () => {
  assert.throws(() => validateNarrativeReviewOutput('只有正文，没有复检。'), /过短|审校记录/);
  const valid = '<audit_internal>引用 E1 检查当前年份；问题位置为首句，已按世界书替换并完成时间、连续性与玩家边界复检。</audit_internal><final>雨声压在木叶屋檐上，值守忍者合上名册。走廊尽头的脚步停在门外，来人没有擅自闯入，只隔着门板等待回应。</final>';
  assert.equal(validateNarrativeReviewOutput(valid), valid);
  const artifact = parseNarrativeReviewPreview(valid);
  assert.match(artifact.auditInternal, /引用 E1/);
  assert.match(artifact.displayText, /雨声压在木叶屋檐上/);
  assert.doesNotMatch(artifact.displayText, /引用 E1|问题位置|audit_internal/);
});

test('review accepts the nearest future day as ordinary plot evidence', () => {
  const sourceMessages = [{
    role: 'system',
    content: `<<< CURRENT_PLOT_START current=K066-12-30 target=K067-01-01 days_until=1 date_relation=future >>>
场景标题: 修行归来
  - [EV-P2-RETURN-TEAM-01-01] order=10 role=setup | 归村人员在木叶正门完成登记。
<<< CURRENT_PLOT_END >>>`
  }];
  const preview = '<audit_internal>已核对 E1 中的目标日期与剧情日关系，并确认此分支允许提前推进该会面。</audit_internal><final>清晨的木叶仍在处理文书。修行归来的忍者在正门完成登记，值班人员把名单递给来访者核对。</final>';
  const messages = buildNarrativeReviewMessages({ sourceMessages, candidateResponse: preview });
  assert.match(messages.map(message => message.content).join('\n'), /修行归来/);
  assert.equal(validateNarrativeReviewOutput(preview, { sourceMessages }), preview);
});

test('updater-owned tags are removed before the final response is applied', () => {
  const pipeline = new MessagePipeline({});
  const cleaned = pipeline._stripUpdaterOwnedTags('正文<memory>{"summary":"草稿"}</memory><variable>{}</variable>');
  assert.match(cleaned, /正文/);
  assert.doesNotMatch(cleaned, /<memory>|<variable>/);
});

test('pipeline uses an explicit manual review-preview transaction before commit', () => {
  const source = readFileSync(new URL('../js/core/pipeline.js', import.meta.url), 'utf8');
  assert.match(source, /await runNarrativeReviewPreview\s*\(/);
  assert.match(source, /toNarrativeReviewPreviewView\s*\(/);
  assert.match(source, /applyNarrativeReview\s*\(/);
  assert.match(source, /discardNarrativeReview\s*\(/);
  assert.match(source, /resolveNarrativeReviewArtifact\s*\(/);
  assert.doesNotMatch(source, /fullResponse\s*=\s*await runNarrativeReview\s*\(/);
  const resolveCallAt = source.indexOf('acceptedArtifact = await this._resolveNarrativeReview');
  const instructionAt = source.indexOf('const instructions = instructionParser.parse(instructionText)');
  const timelineAt = source.indexOf('await this.timelineSystem.createNode');
  assert.ok(resolveCallAt >= 0 && resolveCallAt < instructionAt && instructionAt < timelineAt);
  const helperAt = source.indexOf('async _resolveNarrativeReview');
  const previewAt = source.indexOf('await runNarrativeReviewPreview', helperAt);
  const applyAt = source.indexOf('applyNarrativeReview(', previewAt);
  const discardAt = source.indexOf('discardNarrativeReview(', previewAt);
  const acceptedAt = source.indexOf('resolveNarrativeReviewArtifact(', previewAt);
  assert.ok(helperAt >= 0 && helperAt < previewAt && previewAt < applyAt && previewAt < discardAt && applyAt < acceptedAt && discardAt < acceptedAt);
  assert.match(source, /if \(!reviewEnabled\) eventBus\.emit\('pipeline:chunk'/);
});

test('agent draft streaming is hidden while two-stage review is enabled', () => {
  const source = readFileSync(new URL('../js/ui/app-shell.js', import.meta.url), 'utf8');
  assert.match(source, /agent:stream[\s\S]*isNarrativeReviewEnabled[\s\S]*return;/);
  assert.match(source, /agent !== 'final-writer'/);
  assert.doesNotMatch(source, /agent !== 'writer' && agent !== 'writer-polish'/);
});

console.log(`PASS ${passed} preset and narrative-review regression checks.`);
