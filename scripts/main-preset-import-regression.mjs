import assert from 'node:assert/strict';

import {
  compileMainPresetImport,
  summarizeMainPresetImport
} from '../js/data/main-preset-import.js';
import {
  DEFAULT_MAIN_PRESET_VERSION,
  migrateMainPreset,
  resolvePresetMacros
} from '../js/data/default-preset.js';
import {
  attachImportedAssistantPrefill,
  inspectImportedPresetOutputProfile,
  insertProjectMachineTail,
  repairImportedPresetOutputEnvelope,
  validateImportedPresetOutputEnvelope
} from '../js/core/main-preset-compatibility.js';
import { instructionParser } from '../js/core/instruction-parser.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

function syntheticTavernPreset() {
  const duplicateRegex = {
    id: 'same-id',
    scriptName: 'intentional duplicate',
    findRegex: '/<content>([\\s\\S]*?)<\\/content>/gi',
    replaceString: '$1',
    placement: [2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 2,
    minDepth: 0,
    maxDepth: 2,
    trimStrings: ['CUT']
  };
  return {
    prompts: [
      { identifier: 'tail', name: 'tail', role: 'assistant', marker: false, content: '\n  prefill stays spaced  \n' },
      { identifier: 'main', name: 'main', role: 'system', content: 'main is content, not a marker' },
      { identifier: 'chatHistory', name: 'history', marker: true, content: '' },
      { identifier: 'unordered', name: 'not in prompt order', role: 'system', enabled: true, content: 'must stay disabled' }
    ],
    prompt_order: [{
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'tail', enabled: true }
      ]
    }],
    assistant_prefill: 'PREFIX',
    temperature: 0.73,
    extensions: { regex_scripts: [duplicateRegex, { ...duplicateRegex }] }
  };
}

function importedOutputProfileFixture(entries, assistantPrefill = '') {
  return {
    _importMode: 'replace',
    _sourceFormat: 'sillytavern',
    assistantPrefill,
    entries: entries.map((entry, index) => ({
      id: `fixture-${index + 1}`,
      name: entry.name,
      role: entry.role || 'system',
      enabled: entry.enabled !== false,
      isMarker: false,
      content: entry.content
    }))
  };
}

function representativeImportedPresetProfiles() {
  return [
    {
      name: '狐神抚',
      preset: importedOutputProfileFixture([
        {
          name: '思维链（多角色内心OS）',
          content: '在正文之前用<think_fox~>标签包裹思考过程。\n<think_fox~>……</think_fox~>'
        },
        {
          name: '直出输出',
          role: 'assistant',
          content: 'OUTPUT\n<think_fox~>'
        }
      ]),
      expected: ['think_fox~']
    },
    {
      name: 'Izumi',
      preset: importedOutputProfileFixture([
        {
          name: '思维链-注重流畅性',
          content: '正式创作正文前进行思考，思考需用<konatan_planning~> </konatan_planning~>包裹。'
        },
        {
          name: '卡思维链',
          role: 'assistant',
          content: '先开始思考吧。\n<konatan_planning~>'
        }
      ]),
      expected: ['konatan_planning~']
    },
    {
      name: '梦鲸',
      preset: importedOutputProfileFixture([
        {
          name: '梦境平行事件',
          content: '在书写平行事件前，在<simple_thinking>内进行一次简短的思考。\n<simple_thinking>……</simple_thinking>'
        },
        {
          name: '写作模式',
          content: '最终回复的根节点必须是 <dream_plot>，模板为：<dream_plot><dream_body>正文</dream_body><dream_after_format><dream_done/></dream_after_format></dream_plot>。在你的思考过程（<think>标签内）中完成主线推演。'
        }
      ]),
      expected: ['simple_thinking', 'think'],
      expectedRoot: {
        rootWrapper: 'dream_plot',
        requiredDisplayWrappers: ['dream_body', 'dream_after_format'],
        machineTailContainer: 'dream_after_format'
      }
    },
    {
      name: '咩咩',
      preset: importedOutputProfileFixture([
        {
          name: 'acg角色心理模型',
          content: '请输出思考过程：<acg_think>……</acg_think>'
        },
        {
          name: '思维链-故事模式',
          content: '输出推理过程并严格包裹：<story_driver>……</story_driver>'
        },
        {
          name: '卡掉原生思维链',
          role: 'assistant',
          content: '<think>\nthink is over...\n</think>'
        }
      ]),
      expected: ['acg_think', 'story_driver', 'think']
    }
  ];
}

function dedicatedImportedPresetProfiles() {
  return {
    fox: importedOutputProfileFixture([
      { name: '输出结构', content: '必须按 <content>正文</content><fox_selc>选项</fox_selc><fox_tip>留言</fox_tip> 输出。' },
      { name: '思考', content: '思考使用 <think_fox~>推演</think_fox~>。' }
    ], 'OUTPUT\n<think_fox~>'),
    izumi: importedOutputProfileFixture([
      { name: '输出结构', content: '规划后输出正文，再输出 <current_event>事件</current_event><progress>进度</progress><tucao>吐槽</tucao>。' },
      { name: '规划', content: '使用 <konatan_planning~>规划</konatan_planning~>。' }
    ], '日本語で考える：\n<konatan_planning~>'),
    dream: importedOutputProfileFixture([
      {
        name: '梦鲸输出结构',
        content: '最终回复的根节点必须是 <dream_plot>，模板：<dream_plot><dream_body><dream_scene><date>日期</date></dream_scene>正文</dream_body><dream_after_format><dream_parallel_event><simple_thinking>局部推演</simple_thinking>平行事件</dream_parallel_event></dream_after_format></dream_plot>。主推演使用 <think>推演</think>。'
      }
    ]),
    miemie: importedOutputProfileFixture([
      {
        name: '咩咩输出结构',
        content: '<acg_think>判断</acg_think><combat_driver>无</combat_driver><story_driver>推演</story_driver><story_scene>正文</story_scene><memory_log>记忆</memory_log><wlog>世界</wlog><status>状态</status><affinity>关系</affinity>'
      }
    ], '<think>think is over...</think>')
  };
}

test('SillyTavern prompt_order is authoritative and source content is untouched', () => {
  const source = syntheticTavernPreset();
  const snapshot = JSON.stringify(source);
  const preset = compileMainPresetImport(source, { fileName: 'synthetic.json' });

  assert.equal(JSON.stringify(source), snapshot, 'import must be read-only');
  assert.deepEqual(preset.entries.map(entry => entry.id), ['main', 'chatHistory', 'tail', 'unordered']);
  assert.equal(preset.entries[0].isMarker, false, 'identifier names do not imply markers');
  assert.equal(preset.entries[1].isMarker, true);
  assert.equal(preset.entries[2].tavernPosition, 'bottom');
  assert.equal(preset.entries[2].content, '\n  prefill stays spaced  \n');
  assert.equal(preset.entries[3].enabled, false, 'prompts absent from prompt_order stay disabled');
  assert.equal(preset.assistantPrefill, 'PREFIX');
  assert.equal(preset.generationSettings.temperature, 0.73);
  assert.equal(preset._version, DEFAULT_MAIN_PRESET_VERSION);
  assert.equal(preset._importMode, 'replace');
});

test('regex rows preserve order, intentional duplicates, and all runtime fields', () => {
  const preset = compileMainPresetImport(syntheticTavernPreset());
  assert.equal(preset.regexScripts.length, 2);
  assert.deepEqual(preset.regexScripts[0], preset.regexScripts[1]);
  assert.deepEqual(preset.regexScripts[0].placement, [2]);
  assert.deepEqual(preset.regexScripts[0].trimStrings, ['CUT']);
  assert.equal(preset.regexScripts[0].substituteRegex, 2);
  assert.equal(preset.regexScripts[0].runOnEdit, false);
  assert.equal(preset.regexScripts[0].minDepth, 0);
  assert.equal(preset.regexScripts[0].maxDepth, 2);
});

test('import summary excludes markers and reports enabled regex rows', () => {
  const summary = summarizeMainPresetImport(compileMainPresetImport(syntheticTavernPreset()));
  assert.deepEqual(summary, {
    promptCount: 4,
    enabledPromptCount: 2,
    markerCount: 1,
    regexCount: 2,
    enabledRegexCount: 2
  });
});

test('nested Tavern variables resolve without damaging lower-case output wrappers', () => {
  const entries = [
    { enabled: true, content: '{{setvar::数值::1}}' },
    { enabled: true, content: '{{addvar::数值::{{roll 1d1}}}}' },
    { enabled: true, content: '{{setvar::称呼::{{random::甲}}}}' },
    { enabled: true, content: '{{getvar::数值}}|{{getvar::称呼}}|{{user}}|<user>结构内容</user>' }
  ];
  const resolved = resolvePresetMacros(entries, { playerName: '春野樱' });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].content, '2|甲|春野樱|<user>结构内容</user>');
  assert.doesNotMatch(resolved[0].content, /\{\{|\}\}/);
});

test('replace-mode migration preserves imported prompts, regex, and metadata', () => {
  const imported = compileMainPresetImport(syntheticTavernPreset());
  imported._version = 'old-version';
  const migrated = migrateMainPreset(imported);
  assert.equal(migrated._version, DEFAULT_MAIN_PRESET_VERSION);
  assert.equal(migrated._sourceFormat, 'sillytavern');
  assert.equal(migrated._importMode, 'replace');
  assert.equal(migrated.entries.length, imported.entries.length);
  assert.equal(migrated.regexScripts.length, imported.regexScripts.length);
  assert.equal(migrated.assistantPrefill, 'PREFIX');
});

test('representative 狐神抚, Izumi, 梦鲸, and 咩咩 wrapper profiles are detected', () => {
  for (const fixture of representativeImportedPresetProfiles()) {
    const profile = inspectImportedPresetOutputProfile(fixture.preset);
    assert.equal(profile.active, true, `${fixture.name} should use imported-preset compatibility`);
    assert.equal(profile.sourceFormat, 'sillytavern');
    assert.deepEqual(profile.privateWrappers, fixture.expected, `${fixture.name} wrapper profile changed`);
    assert.equal(profile.rootWrapper, fixture.expectedRoot?.rootWrapper || '');
    assert.deepEqual(profile.requiredDisplayWrappers, fixture.expectedRoot?.requiredDisplayWrappers || []);
    assert.equal(profile.machineTailContainer, fixture.expectedRoot?.machineTailContainer || '');
  }
});

test('output-profile inspection does not mutate imported JSON', () => {
  for (const fixture of representativeImportedPresetProfiles()) {
    const snapshot = JSON.stringify(fixture.preset);
    inspectImportedPresetOutputProfile(fixture.preset);
    assert.equal(JSON.stringify(fixture.preset), snapshot, `${fixture.name} inspection must be read-only`);
  }
});

test('four complete structural signatures select exactly one dedicated adapter', () => {
  const fixtures = dedicatedImportedPresetProfiles();
  const expected = {
    fox: 'fox-v18',
    izumi: 'izumi-0707',
    dream: 'dream-whale-v4',
    miemie: 'miemie-v5'
  };
  for (const [key, preset] of Object.entries(fixtures)) {
    const snapshot = JSON.stringify(preset);
    const profile = inspectImportedPresetOutputProfile(preset);
    assert.equal(profile.adapterId, expected[key], `${key} dedicated adapter mismatch`);
    assert.deepEqual(profile.adapterMatches, [expected[key]]);
    assert.equal(JSON.stringify(preset), snapshot, `${key} detection must stay read-only`);
  }
});

test('imported envelope rejects a private wrapper that was never opened', () => {
  const profile = inspectImportedPresetOutputProfile(importedOutputProfileFixture([
    { name: '思维链', content: '思考过程必须使用<think>……</think>包裹。' }
  ]));
  const validation = validateImportedPresetOutputEnvelope('正文\n</think>', profile);
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missingContracts, ['imported_preset_envelope']);
  assert.match(validation.errors.join('\n'), /没有对应开始标签/);
});

test('imported envelope rejects an unclosed private wrapper', () => {
  const profile = inspectImportedPresetOutputProfile(importedOutputProfileFixture([
    { name: '思维链', content: '思考过程必须使用<think>……</think>包裹。' }
  ]));
  const validation = validateImportedPresetOutputEnvelope('<think>思考后直接进入正文', profile);
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missingContracts, ['imported_preset_envelope']);
  assert.match(validation.errors.join('\n'), /开始标签未闭合/);
});

test('imported envelope rejects cross-closed private wrappers', () => {
  const profile = inspectImportedPresetOutputProfile(importedOutputProfileFixture([
    { name: '思维链', content: '思考过程使用<think>……</think>包裹。' },
    { name: '故事推演', content: '推演过程使用<story_driver>……</story_driver>包裹。' }
  ]));
  const validation = validateImportedPresetOutputEnvelope(
    '<think><story_driver>推演</think></story_driver>\n正文',
    profile
  );
  assert.equal(validation.valid, false, 'balanced tag counts must not hide cross-closing');
  assert.deepEqual(validation.missingContracts, ['imported_preset_envelope']);
});

test('imported envelope rejects project machine tags inside private wrappers', () => {
  const profile = inspectImportedPresetOutputProfile(importedOutputProfileFixture([
    { name: '思维链', content: '思考过程必须使用<think>……</think>包裹。' }
  ]));
  const machineBlocks = [
    '<var>player.hp: 9</var>',
    '<variable>player.chakra: 8</variable>',
    '<combat>{"result":"win"}</combat>',
    '<mission>{"id":"m1"}</mission>',
    '<relationship>{"id":"npc"}</relationship>',
    '<event>{"id":"e1"}</event>',
    '<state_update>{"changed":true}</state_update>',
    '<memory><summary>记忆</summary></memory>',
    '<shinobi_daily>{"date":"1月1日"}</shinobi_daily>'
  ];

  for (const machineBlock of machineBlocks) {
    const validation = validateImportedPresetOutputEnvelope(
      `<think>私密推演\n${machineBlock}\n</think>\n正文`,
      profile
    );
    assert.equal(validation.valid, false, `${machineBlock} must stay outside private wrappers`);
    assert.deepEqual(validation.missingContracts, ['imported_preset_envelope']);
  }
});

test('assistant prefill is restored without duplicating an echoed opening wrapper', () => {
  const foxPrefill = 'hashlib follow the request：\nOUTPUT\n<think_fox~>';
  const foxContinuation = '【思考】\n</think_fox~>\n<content>正文</content>';
  assert.equal(
    attachImportedAssistantPrefill(foxContinuation, foxPrefill),
    `${foxPrefill}\n${foxContinuation}`
  );

  const echoedOpening = '<think_fox~>【思考】\n</think_fox~>\n<content>正文</content>';
  assert.equal(
    attachImportedAssistantPrefill(echoedOpening, foxPrefill),
    `${foxPrefill}\n【思考】\n</think_fox~>\n<content>正文</content>`
  );
  assert.equal(attachImportedAssistantPrefill(foxPrefill, foxPrefill), foxPrefill);
  assert.equal(attachImportedAssistantPrefill('正文', ''), '正文');

  const izumiPrefill = '小此准备好啦。\n<konatan_planning~>日本語で考える：\n';
  const izumiEcho = '\uFEFF  \n<konatan_planning~>日本語で考える：\n推演内容\n</konatan_planning~>\n正文';
  const restored = attachImportedAssistantPrefill(izumiEcho, izumiPrefill);
  assert.equal(
    restored,
    `\uFEFF  \n${izumiPrefill}推演内容\n</konatan_planning~>\n正文`
  );
  assert.equal((restored.match(/<konatan_planning~>/g) || []).length, 1);
  assert.equal(
    attachImportedAssistantPrefill(`\n${izumiPrefill}推演内容`, izumiPrefill),
    `\n${izumiPrefill}推演内容`,
    'BOM/leading whitespace before an already-restored prefill must stay idempotent'
  );
});

test('project machine tail is inserted inside dream_after_format before the XML root closes', () => {
  const dreamFixture = representativeImportedPresetProfiles().find(fixture => fixture.name === '梦鲸');
  const profile = inspectImportedPresetOutputProfile(dreamFixture.preset);
  const response = '<think>主线推演</think>\n<simple_thinking>并行事件思考</simple_thinking>\n<dream_plot>\n<dream_body>正文</dream_body>\n<dream_after_format>\n<dream_done/>\n</dream_after_format>\n</dream_plot>';
  const tail = '<state_update>{"changed":false}</state_update>\n<memory><summary>本轮记忆</summary></memory>';
  const inserted = insertProjectMachineTail(response, tail, profile);

  assert.equal(
    inserted,
    `<think>主线推演</think>\n<simple_thinking>并行事件思考</simple_thinking>\n<dream_plot>\n<dream_body>正文</dream_body>\n<dream_after_format>\n<dream_done/>\n${tail}\n</dream_after_format>\n</dream_plot>`
  );
  assert.ok(inserted.indexOf(tail) < inserted.indexOf('</dream_after_format>'));
  assert.ok(inserted.indexOf('</dream_after_format>') < inserted.indexOf('</dream_plot>'));
  assert.equal(insertProjectMachineTail(response, ''), response);
  const incomplete = insertProjectMachineTail(
    '<simple_thinking>思考</simple_thinking><dream_plot><dream_body>正文</dream_body></dream_plot>', tail, profile);
  assert.ok(incomplete.includes(tail), 'missing presentation tail never blocks machine updates');

});

test('declared single-root output rejects missing, duplicate, out-of-order, or root-external machine blocks', () => {
  const dreamFixture = representativeImportedPresetProfiles().find(fixture => fixture.name === '梦鲸');
  const profile = inspectImportedPresetOutputProfile(dreamFixture.preset);
  const valid = [
    '<think>完整主线思考</think>',
    '<simple_thinking>完整思考</simple_thinking>',
    '<dream_plot>',
    '<dream_body>正文</dream_body>',
    '<dream_after_format><dream_done/><state_update>{"changed":false}</state_update></dream_after_format>',
    '</dream_plot>'
  ].join('\n');
  assert.equal(validateImportedPresetOutputEnvelope(valid, profile).valid, true);

  const invalidCases = [
    valid.replace('<dream_plot>\n', ''),
    valid.replace('<dream_body>正文</dream_body>', '<dream_body>甲</dream_body><dream_body>乙</dream_body>'),
    valid.replace(
      '<dream_body>正文</dream_body>\n<dream_after_format><dream_done/><state_update>{"changed":false}</state_update></dream_after_format>',
      '<dream_after_format><dream_done/></dream_after_format>\n<dream_body>正文</dream_body>'
    ),
    valid.replace(
      '<state_update>{"changed":false}</state_update></dream_after_format>',
      '</dream_after_format><state_update>{"changed":false}</state_update>'
    ),
    `${valid}\n<state_update>{"changed":false}</state_update>`,
    `根外解释\n${valid}`
  ];
  for (const candidate of invalidCases) {
    const validation = validateImportedPresetOutputEnvelope(candidate, profile);
    assert.equal(validation.valid, false, candidate);
    assert.deepEqual(validation.missingContracts, ['imported_preset_envelope']);
  }
});

test('reported 梦鲸 malformed envelope is deterministically repaired without changing its profile', () => {
  const dreamFixture = representativeImportedPresetProfiles().find(fixture => fixture.name === '梦鲸');
  const presetSnapshot = JSON.stringify(dreamFixture.preset);
  const profile = inspectImportedPresetOutputProfile(dreamFixture.preset);
  const profileSnapshot = JSON.stringify(profile);
  const malformed = [
    '<think>吾有一梦，今方始筑：主线私密推演',
    '<state_update>{"changed":false}</state_update>',
    '<memory>{"summary":"本轮记忆"}</memory>',
    '<shinobi_daily>{"date":"木叶历"}</shinobi_daily>',
    '<simple_thinking>平行事件私密推演</simple_thinking>',
    '<dream_plot>',
    '<dream_body>可见正文保持原样</dream_body>',
    '<dream_after_format><dream_done/></dream_after_format>',
    '</dream_plot>'
  ].join('\n');
  const before = validateImportedPresetOutputEnvelope(malformed, profile);
  assert.equal(before.valid, false);
  assert.match(before.errors.join('\n'), /state_update.*think/);
  assert.match(before.errors.join('\n'), /simple_thinking.*机器尾部/);
  assert.match(before.errors.join('\n'), /dream_plot.*实际 0 次/);

  const repaired = repairImportedPresetOutputEnvelope(malformed, profile);
  assert.notEqual(repaired, malformed);
  assert.equal(validateImportedPresetOutputEnvelope(repaired, profile).valid, true);
  assert.equal(repairImportedPresetOutputEnvelope(repaired, profile), repaired, 'repair must be idempotent');
  assert.ok(repaired.indexOf('</think>') < repaired.indexOf('<simple_thinking>'));
  assert.ok(repaired.indexOf('</simple_thinking>') < repaired.indexOf('<state_update>'));
  assert.ok(repaired.indexOf('<state_update>') > repaired.indexOf('<dream_after_format>'));
  assert.ok(repaired.indexOf('</shinobi_daily>') < repaired.indexOf('</dream_after_format>'));
  assert.equal((repaired.match(/<dream_plot>/g) || []).length, 1);
  assert.equal((repaired.match(/<\/dream_plot>/g) || []).length, 1);
  assert.match(repaired, /<dream_body>可见正文保持原样<\/dream_body>/);
  assert.match(repaired, /吾有一梦，今方始筑：主线私密推演/);
  assert.equal(JSON.stringify(profile), profileSnapshot, 'runtime repair must not mutate the derived profile');
  assert.equal(JSON.stringify(dreamFixture.preset), presetSnapshot, 'runtime repair must not mutate imported JSON');
});

test('a missing declared root is restored only around an otherwise complete declared child sequence', () => {
  const dreamFixture = representativeImportedPresetProfiles().find(fixture => fixture.name === '梦鲸');
  const profile = inspectImportedPresetOutputProfile(dreamFixture.preset);
  const missingRoot = [
    '<think>主线私密推演</think>',
    '<simple_thinking>平行事件私密推演</simple_thinking>',
    '<dream_body>正文</dream_body>',
    '<dream_after_format><dream_done/></dream_after_format>'
  ].join('\n');
  const repaired = repairImportedPresetOutputEnvelope(missingRoot, profile);
  assert.equal(validateImportedPresetOutputEnvelope(repaired, profile).valid, true);
  assert.ok(repaired.indexOf('<dream_plot>') < repaired.indexOf('<dream_body>'));
  assert.ok(repaired.indexOf('</dream_after_format>') < repaired.indexOf('</dream_plot>'));

  const ambiguous = '<think><simple_thinking>交叉闭合</think></simple_thinking>';
  assert.equal(repairImportedPresetOutputEnvelope(ambiguous, profile), ambiguous,
    'cross-closed private wrappers must remain rejected instead of being guessed');
});

test('dream-whale-v4 repairs the reported delayed think close without touching either reasoning payload', () => {
  const preset = dedicatedImportedPresetProfiles().dream;
  const snapshot = JSON.stringify(preset);
  const profile = inspectImportedPresetOutputProfile(preset);
  const malformed = [
    '<think>主推演原文-不可改',
    '<dream_plot>',
    '<dream_body><dream_scene><date>木叶历60年</date></dream_scene>可见正文-不可改</dream_body>',
    '<dream_after_format>',
    '<dream_parallel_event>',
    '<simple_thinking>局部推演原文-不可改',
    '</think>',
    '平行推演后半段-不可改</simple_thinking>',
    '平行事件正文-不可改',
    '<state_update>{"changed":false}</state_update>',
    '<memory>{"summary":"记忆原文"}</memory>',
    '<shinobi_daily>{"date":"木叶历60年"}</shinobi_daily>',
    '</dream_parallel_event>',
    '</dream_after_format>',
    '</dream_plot>'
  ].join('\n');

  assert.equal(validateImportedPresetOutputEnvelope(malformed, profile).valid, false);
  const repaired = repairImportedPresetOutputEnvelope(malformed, profile);
  const validation = validateImportedPresetOutputEnvelope(repaired, profile);
  assert.equal(validation.valid, true, validation.errors.join('；'));
  assert.equal(repairImportedPresetOutputEnvelope(repaired, profile), repaired, 'dedicated repair must be idempotent');
  assert.ok(repaired.indexOf('</think>') < repaired.indexOf('<dream_plot>'));
  assert.ok(repaired.indexOf('<simple_thinking>') > repaired.indexOf('<dream_parallel_event>'));
  assert.ok(repaired.indexOf('</simple_thinking>') < repaired.indexOf('</dream_parallel_event>'));
  assert.ok(repaired.indexOf('<state_update>') > repaired.indexOf('</dream_parallel_event>'));
  assert.ok(repaired.indexOf('</shinobi_daily>') < repaired.indexOf('</dream_after_format>'));
  for (const payload of [
    '主推演原文-不可改',
    '局部推演原文-不可改',
    '平行推演后半段-不可改',
    '可见正文-不可改',
    '{"summary":"记忆原文"}'
  ]) assert.ok(repaired.includes(payload), `payload changed: ${payload}`);
  assert.equal(JSON.stringify(preset), snapshot, 'repair must not mutate imported preset');
});

test('dream-whale-v4 restores the real continuation-style think opening and ignores format examples inside it', () => {
  const profile = inspectImportedPresetOutputProfile(dedicatedImportedPresetProfiles().dream);
  const continuation = [
    '一、检设定：',
    '1. DREAM_PLOT_OUTPUT：根节点 `<dream_plot>`，包含 `<dream_body>` 和 `<dream_after_format>`。',
    '2. DREAM_SCENE_INFO：正文前输出 `<dream_scene>`。',
    '3. DREAM_PARALLEL_EVENT：正文后输出 `<dream_parallel_event>`，内含 `<simple_thinking>`。',
    '终、定乾坤：前尘已定，梦境将演。',
    '</think>',
    '<dream_plot>',
    '<dream_body><dream_scene><date>木叶52年1月1日</date><time>清晨</time><location>南大门岗亭</location></dream_scene>梦鲸可见正文-不可改</dream_body>',
    '<dream_after_format>',
    '<dream_parallel_event><simple_thinking>局部推演-不可改</simple_thinking>雨鸦撤退。</dream_parallel_event>',
    '</dream_after_format>',
    '</dream_plot>'
  ].join('\n');

  const before = validateImportedPresetOutputEnvelope(continuation, profile);
  assert.equal(before.valid, false, 'a lone transport close must be repaired before validation');
  const repaired = repairImportedPresetOutputEnvelope(continuation, profile);
  const validation = validateImportedPresetOutputEnvelope(repaired, profile);
  assert.equal(validation.valid, true, validation.errors.join('；'));
  assert.match(repaired, /^<think>\s*一、检设定：/u);
  assert.ok(repaired.includes('`<dream_plot>`'), 'private format-analysis payload must stay byte-for-byte');
  assert.ok(repaired.includes('<simple_thinking>局部推演-不可改</simple_thinking>'));
  assert.equal(repairImportedPresetOutputEnvelope(repaired, profile), repaired, 'repair must be idempotent');
  const display = instructionParser.cleanupResponse(repaired);
  assert.doesNotMatch(display, /一、检设定|DREAM_PLOT_OUTPUT|局部推演-不可改/u);
  assert.match(display, /梦鲸可见正文-不可改|雨鸦撤退/u);
});

test('fox-v18 moves machine blocks behind fox_tip and closes the open prefill at content', () => {
  const profile = inspectImportedPresetOutputProfile(dedicatedImportedPresetProfiles().fox);
  const malformed = [
    '<think_fox~>狐神推演',
    '<content>正文<state_update>{"changed":false}</state_update></content>',
    '<fox_selc>【默认】继续</fox_selc>',
    '<fox_tip>留言</fox_tip>'
  ].join('\n');
  const repaired = repairImportedPresetOutputEnvelope(malformed, profile);
  const validation = validateImportedPresetOutputEnvelope(repaired, profile);
  assert.equal(validation.valid, true, validation.errors.join('；'));
  assert.ok(repaired.indexOf('</think_fox~>') < repaired.indexOf('<content>'));
  assert.ok(repaired.indexOf('<state_update>') > repaired.indexOf('</fox_tip>'));
});

test('izumi-0707 keeps a plain-text body and moves machine blocks after tucao', () => {
  const profile = inspectImportedPresetOutputProfile(dedicatedImportedPresetProfiles().izumi);
  const malformed = [
    '<konatan_planning~>规划</konatan_planning~>',
    '纯文本正文-不可包 content',
    '<current_event>事件</current_event>',
    '<state_update>{"changed":false}</state_update>',
    '<progress>进度</progress>',
    '<tucao>吐槽</tucao>'
  ].join('\n');
  const repaired = repairImportedPresetOutputEnvelope(malformed, profile);
  const validation = validateImportedPresetOutputEnvelope(repaired, profile);
  assert.equal(validation.valid, true, validation.errors.join('；'));
  assert.ok(repaired.includes('纯文本正文-不可包 content'));
  assert.equal(repaired.includes('<content>'), false);
  assert.ok(repaired.indexOf('<state_update>') > repaired.indexOf('</tucao>'));
});

test('izumi-0707 restores a missing planning opening without counting planning snapshots as final display blocks', () => {
  const profile = inspectImportedPresetOutputProfile(dedicatedImportedPresetProfiles().izumi);
  const continuation = [
    '- 当前什么情况？',
    '<current_event>规划内旧事件快照</current_event>',
    '<progress>规划内旧进度快照</progress>',
    '- 综合得出细纲：治疗后进入警务盘问。',
    '</konatan_planning~>',
    '小此可见正文-不可改',
    '<current_event>本回合新事件</current_event>',
    '<progress>本回合新进度</progress>',
    '<tucao>本回合吐槽</tucao>'
  ].join('\n');

  assert.equal(validateImportedPresetOutputEnvelope(continuation, profile).valid, false);
  const repaired = repairImportedPresetOutputEnvelope(continuation, profile);
  const validation = validateImportedPresetOutputEnvelope(repaired, profile);
  assert.equal(validation.valid, true, validation.errors.join('；'));
  assert.match(repaired, /^<konatan_planning~>\s*- 当前什么情况/u);
  assert.ok(repaired.includes('<current_event>规划内旧事件快照</current_event>'));
  assert.ok(repaired.includes('<current_event>本回合新事件</current_event>'));
  assert.equal(repairImportedPresetOutputEnvelope(repaired, profile), repaired, 'repair must be idempotent');
  const display = instructionParser.cleanupResponse(repaired);
  assert.doesNotMatch(display, /规划内旧事件快照|规划内旧进度快照|综合得出细纲/u);
  assert.match(display, /小此可见正文-不可改|本回合新事件|本回合新进度/u);
});

test('miemie-v5 repairs delayed sibling closes and keeps the machine tail after affinity', () => {
  const profile = inspectImportedPresetOutputProfile(dedicatedImportedPresetProfiles().miemie);
  const malformed = [
    '<think>think is over...</think>',
    '<acg_think>属性判断',
    '<combat_driver>无</combat_driver>',
    '</acg_think>',
    '<story_driver>故事推演',
    '<story_scene>玩家侧正文</story_driver></story_scene>',
    '<memory_log>原生记忆</memory_log>',
    '<wlog time="木叶历60年">世界记录</wlog>',
    '<state_update>{"changed":false}</state_update>',
    '<status>状态</status>',
    '<affinity>关系变化</affinity>'
  ].join('\n');
  const repaired = repairImportedPresetOutputEnvelope(malformed, profile);
  const validation = validateImportedPresetOutputEnvelope(repaired, profile);
  assert.equal(validation.valid, true, validation.errors.join('；'));
  assert.ok(repaired.indexOf('</acg_think>') < repaired.indexOf('<combat_driver>'));
  assert.ok(repaired.indexOf('</story_driver>') < repaired.indexOf('<story_scene>'));
  assert.ok(repaired.indexOf('<state_update>') > repaired.indexOf('</affinity>'));
});

console.log(`PASS ${passed} main preset import regression checks.`);
