import assert from 'node:assert/strict';
import { DEFAULT_MAIN_PRESET, resolvePresetMacros } from '../js/data/default-preset.js';
import { DEFAULT_VARIABLE_UPDATER_PRESET, resolveVariableUpdaterPreset } from '../js/data/variable-updater-preset.js';
import { generateMainVarInstructions, getBriefPromptRef } from '../js/data/var-schema.js';
import { buildVariableUpdaterMessages, buildVariableUpdaterRuntimeContract } from '../js/core/variable-updater.js';
import { getAgentPrompt } from '../js/core/agent-prompts.js';
import { resolveAgentSystemPrompt } from '../js/core/agent-runner.js';
import { buildImportedPresetModePrompt } from '../js/core/main-preset-compatibility.js';
import { buildTacticalEncounterGuidance } from '../js/systems/tactical-engagement.js';
import { projectSystemCombatPrompt } from '../js/data/combat-prompt-mode.js';
import { MAIN_SINGLE_CALL_OUTPUT_PROMPT } from '../js/core/main-output-contract.js';

const state = enabled => ({ _ui: { settings: { tacticalCombat: enabled } }, _relationships: {} });
const joined = entries => entries.map(entry => entry.content).join('\n\n');
const noCombatRules = text => { assert.doesNotMatch(text, /<combat(?:\s+state=|>)/u); assert.doesNotMatch(text, /(?:资源和伤害|资源与伤害)只通过/u); };
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test('manual closed main built-ins retain normal bookkeeping without combat schemas', () => {
  const before = structuredClone(DEFAULT_MAIN_PRESET);
  const off = joined(resolvePresetMacros(DEFAULT_MAIN_PRESET.entries, { tacticalCombat: false, variableUpdaterEnabled: false }));
  noCombatRules(off);
  for (const fragment of ['属性·当前查克拉', '<var>', '<variable>', '<memory>', '<state_update>', '<shinobi_daily>']) assert.ok(off.includes(fragment), fragment);
  const on = joined(resolvePresetMacros(DEFAULT_MAIN_PRESET.entries, { tacticalCombat: true, variableUpdaterEnabled: false }));
  assert.match(on, /<combat state="start">/u); assert.match(on, /<combat state="player_turn">/u);
  assert.deepEqual(DEFAULT_MAIN_PRESET, before);
});
test('edited/imported main entries stay byte-for-byte unchanged including reused built-in IDs', () => {
  const canonical = DEFAULT_MAIN_PRESET.entries.find(entry => entry.id === 'main_builtin_var_off_tags');
  const custom = { ...canonical, content: `${canonical.content}\n用户自己的战斗格式。` };
  const imported = { id: 'imported-rules', role: 'system', content: '<combat state="start">用户自定义展示文本</combat>' };
  const result = resolvePresetMacros([custom, imported], { tacticalCombat: false });
  assert.equal(result[0].content, custom.content); assert.equal(result[1].content, imported.content);
});
test('main variable helper and imported runtime bridge use manual toggle consistently', () => {
  noCombatRules(generateMainVarInstructions(false, { tacticalCombat: false }));
  assert.match(generateMainVarInstructions(false, { tacticalCombat: false }), /attributes\.chakra_current/u);
  assert.match(generateMainVarInstructions(false, { tacticalCombat: true }), /<combat state="start">/u);
  assert.ok(!getBriefPromptRef().includes('<combat>'));
  assert.ok(getBriefPromptRef({ tacticalCombat: true }).includes('<combat>'));
  noCombatRules(buildImportedPresetModePrompt({ updaterEnabled: false, tacticalCombat: false }));
  assert.ok(buildImportedPresetModePrompt({ updaterEnabled: false, tacticalCombat: true }).includes('/<combat>'));
  noCombatRules(projectSystemCombatPrompt(MAIN_SINGLE_CALL_OUTPUT_PROMPT, { tacticalCombat: false }));
  assert.ok(projectSystemCombatPrompt(MAIN_SINGLE_CALL_OUTPUT_PROMPT, { tacticalCombat: true }).includes('<combat>'));
});
test('secondary updater off keeps real resource deltas, memory and daily; on restores schemas', () => {
  const options = { compactState: {}, userInput: '施术后受了轻伤', narrativeResponse: '你施术后受到轻伤，随后包扎。' };
  const off = joined(buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, { ...options, state: state(false) }));
  noCombatRules(off);
  for (const fragment of ['attributes.chakra_current', 'attributes.spirit_current', 'attributes.stamina_current', 'attributes.vitality_current', '<update_manifest>', '<memory>', '<shinobi_daily>']) assert.ok(off.includes(fragment), fragment);
  assert.ok(off.includes('NPC已有战斗卡时只输出真实增量'));
  const on = joined(buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, { ...options, state: state(true) }));
  assert.match(on, /<combat state="start">/u); assert.match(on, /战斗招式的资源和伤害只通过 <combat>/u);
});
test('runtime example is internally consistent with disabled combat domain', () => {
  const off = buildVariableUpdaterRuntimeContract({ state: state(false) });
  noCombatRules(off);
  const manifest = JSON.parse(off.match(/<update_manifest>([^<]+)<\/update_manifest>/u)[1]);
  assert.equal(manifest.domains.combat, 'unchanged');
  assert.equal(manifest.domains.attributes, 'updated');
  const on = buildVariableUpdaterRuntimeContract({ state: state(true) });
  assert.match(on, /<combat state="victory">/u);
});
test('custom updater entries and raw macro payload remain untouched', () => {
  const original = structuredClone(DEFAULT_VARIABLE_UPDATER_PRESET);
  const modified = structuredClone(DEFAULT_VARIABLE_UPDATER_PRESET);
  modified.entries[0].content += '\n玩家自定义结构 <combat state="start">留存</combat>';
  const result = resolveVariableUpdaterPreset(modified, { tacticalCombat: false, userInput: '玩家原文含 <combat state="start">占位</combat>' });
  assert.equal(result[0].content, modified.entries[0].content);
  assert.ok(result.some(entry => entry.content.includes('玩家原文含 <combat state="start">占位</combat>')));
  assert.deepEqual(DEFAULT_VARIABLE_UPDATER_PRESET, original);
});
test('Agent canonical prompt follows state while custom supplement remains unchanged', () => {
  noCombatRules(getAgentPrompt('CONTINUITY_UPDATER', { tacticalCombat: false }));
  assert.ok(getAgentPrompt('CONTINUITY_UPDATER', { tacticalCombat: true }).includes('<combat>'));
  const prior = globalThis.localStorage;
  const custom = '<combat state="start">用户自定义 Agent 内容</combat>';
  globalThis.localStorage = { getItem: key => key === 'naruto_preset_CONTINUITY_UPDATER' ? custom : null };
  try {
    const resolved = resolveAgentSystemPrompt('CONTINUITY_UPDATER', state(false));
    assert.ok(resolved.includes(custom));
    assert.ok(!resolved.includes('任务、人物关系、战斗、事件分别使用'));
  } finally { globalThis.localStorage = prior; }
});
test('tactical instruction explicitly states manual enablement boundary', () => {
  for (const updaterOwned of [false, true]) {
    const prompt = buildTacticalEncounterGuidance({ updaterOwned });
    assert.match(prompt, /仅玩家手动打开战斗面板后适用/u);
    assert.match(prompt, /面板关闭时不应用本段/u);
  }
});
test('enabled canonical HP zero means incapacitation without forcing death', () => {
  const main = joined(resolvePresetMacros(DEFAULT_MAIN_PRESET.entries, { tacticalCombat: true, variableUpdaterEnabled: false }));
  const fallback = generateMainVarInstructions(false, { tacticalCombat: true });
  for (const prompt of [main, fallback]) {
    assert.doesNotMatch(prompt, /归零必须有死亡结果|当前值归零即死亡/u);
    assert.match(prompt, /归零表示失去继续作战能力/u);
    assert.match(prompt, /不自动宣布死亡/u);
  }
  const canonical = DEFAULT_MAIN_PRESET.entries.find(entry => entry.id === 'main_builtin_combat');
  const custom = { ...canonical, content: `${canonical.content}\n用户自己的生命规则。` };
  assert.equal(resolvePresetMacros([custom], { tacticalCombat: true })[0].content, custom.content);
});
test('closed Agent outline omits combat schema and enabled mode restores it', () => {
  const off = getAgentPrompt('OUTLINER', { tacticalCombat: false });
  assert.doesNotMatch(off, /variable\/combat|有战斗才标 combat/u);
  assert.match(off, /variable\/relationship\/memory\/mission\/event/u);
  assert.match(off, /实际资源变化标 variable/u);
  const on = getAgentPrompt('OUTLINER', { tacticalCombat: true });
  assert.match(on, /variable\/combat\/relationship/u);
  assert.match(on, /有战斗才标 combat/u);
  const prior = globalThis.localStorage;
  const custom = '用户补充：有战斗才标 combat；归零必须有死亡结果。';
  globalThis.localStorage = { getItem: key => key === 'naruto_preset_OUTLINER' ? custom : null };
  try {
    for (const enabled of [false, true]) assert.ok(resolveAgentSystemPrompt('OUTLINER', state(enabled)).includes(custom));
  } finally { globalThis.localStorage = prior; }
});
console.log(`Tactical prompt mode regressions: ${passed} passed`);
