import assert from 'node:assert/strict';
import { stateManager } from '../js/core/state-manager.js';
import { instructionParser } from '../js/core/instruction-parser.js';
import { MessagePipeline } from '../js/core/pipeline.js';
import { buildVariableUpdaterMessages, buildVariableUpdaterRuntimeContract, sanitizeVariableUpdaterOutput, validateVariableUpdaterOutput } from '../js/core/variable-updater.js';
import { worldStateSystem } from '../js/systems/world-state-system.js';
import { DEFAULT_VARIABLE_UPDATER_PRESET, DEFAULT_VARIABLE_UPDATER_PRESET_VERSION,
  getVariableUpdaterPreset, VARIABLE_UPDATER_PRESET_STORAGE_KEY, VARIABLE_UPDATER_PRESET_BACKUP_PREFIX } from '../js/data/variable-updater-preset.js';
import { parseGameCalendar } from '../js/utils/game-calendar.js';
import { atmosphereManager } from '../js/ui/atmosphere-manager.js';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
globalThis.customElements ||= { get: () => null };
globalThis.fetch = async () => { throw new Error('No network in variable time regression'); };
const pipeline = new MessagePipeline({});
let passed = 0;
const failures = [];
function reset(time = '木叶52年12月30日·深夜') {
  stateManager.state = { ...stateManager.getDefaultState(), '玩家·姓名': '时间测试',
    '系统·回合数': 8, '世界·时间': time, '世界·年代': '木叶52年', '世界·月份': 12,
    '属性·查克拉': 100, '属性·当前查克拉': 20 };
  stateManager._stateVersion++;
}
function applyTime(time) {
  const output = sanitizeVariableUpdaterOutput('<variable_thinking>时间地点与地图：已经过夜。</variable_thinking>'
    + `<variable>${JSON.stringify({ path: 'world_state.calendar', op: 'set', value: time })}</variable>`
    + '<memory>{"summary":"已休息并到达次日。"}</memory>');
  const validation = validateVariableUpdaterOutput(output, { state: stateManager.get() });
  assert.equal(validation.valid, true, validation.errors.join('; '));
  pipeline._applyInstructions(instructionParser.parse(output), true);
}
function test(name, fn) {
  reset();
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

test('an accepted K date reaches the world calendar without reverting to the default year', () => {
  applyTime('K053-02-03·傍晚');
  assert.deepEqual(worldStateSystem.getCalendar(), { year: '木叶53年', month: 2, day: 3, time_of_day: '傍晚' });
});
test('a year transition synchronizes the date, timeline and month in the committed state', () => {
  applyTime('木叶53年1月1日·清晨');
  assert.equal(stateManager.get('世界·年代'), '木叶53年');
  assert.equal(stateManager.get('世界·月份'), 1);
  assert.equal(worldStateSystem.getTimeline(), '木叶53年');
});
test('a bare tag mentioned in the audit cannot consume the first actual time write', () => {
  const output = '<variable_thinking>请求核对：已经休息三天。时间应到八月二日；资源恢复写 <variable>。</variable_thinking>'
    + '<update_manifest>{"domains":{"world":"updated","attributes":"updated"},"present_npcs":{},"active_missions":{}}</update_manifest>'
    + '<variable>{"path":"world_state.calendar","op":"set","value":"木叶57年8月2日·清晨"}</variable>'
    + '<variable>{"path":"attributes.chakra_current","op":"set","value":35}</variable>'
    + '<memory>{"summary":"休整三天，时间已到木叶57年8月2日清晨。"}</memory>';
  const cleaned = sanitizeVariableUpdaterOutput(output);
  const validation = validateVariableUpdaterOutput(cleaned, { state: stateManager.get(), updateObligations: {} });
  assert.equal(validation.valid, true, validation.errors.join('; '));
  const parsed = instructionParser.parse(cleaned);
  assert.equal(parsed.variables.length, 2);
  pipeline._applyInstructions(parsed, true);
  assert.equal(stateManager.get('世界·时间'), '木叶57年8月2日·清晨');
  assert.equal(stateManager.get('属性·当前查克拉'), 35);
});
test('an explicit clock survives reading the accepted time', () => {
  applyTime('K053-02-03T13:45');
  assert.equal(worldStateSystem.getCalendar().time_of_day, '13:45');
  applyTime('木叶53年2月3日·13:45');
  assert.equal(worldStateSystem.getCalendar().time_of_day, '13:45');
});
test('the last time slot advances into the next day instead of remaining at midnight', () => {
  reset('木叶52年7月15日·深夜');
  const next = worldStateSystem.advanceTime('moment');
  assert.deepEqual(next, { year: '木叶52年', month: 7, day: 16, time_of_day: '清晨' });
});
test('a turn without a time instruction does not invent elapsed time', () => {
  const before = stateManager.get('世界·时间');
  pipeline._applyInstructions(instructionParser.parse('<memory>{"summary":"讨论明天的安排，尚未出发。"}</memory>'), true);
  assert.equal(stateManager.get('世界·时间'), before);
});
test('month and year rollovers keep the project 30-day story calendar', () => {
  reset('木叶52年6月30日·深夜');
  assert.deepEqual(worldStateSystem.advanceTime('day'), { year: '木叶52年', month: 7, day: 1, time_of_day: '清晨' });
  reset('K052-12-30·深夜');
  assert.deepEqual(worldStateSystem.advanceTime('scene'), { year: '木叶53年', month: 1, day: 1, time_of_day: '清晨' });
  assert.equal(stateManager.get('世界·年代'), '木叶53年');
  assert.equal(stateManager.get('世界·月份'), 1);
});
test('exact clocks and localized periods advance without rolling back or skipping a day', () => {
  for (const [time, day, period] of [
    ['23:45', 16, '清晨'], ['00:15', 15, '清晨'], ['凌晨', 15, '清晨'],
    ['13:45', 15, '傍晚'], ['下午', 15, '傍晚']
  ]) {
    reset(`木叶52年7月15日·${time}`);
    const next = worldStateSystem.advanceTime('moment');
    assert.equal(next.day, day, time);
    assert.equal(next.time_of_day, period, time);
  }
});
test('date-only and legacy saves remain readable without rewriting the stored string', () => {
  for (const time of ['K052-07-15', '木叶52年7月15日', '木叶52年7月31日·午后']) {
    reset(time);
    const calendar = worldStateSystem.getCalendar();
    assert.equal(calendar.year, '木叶52年');
    assert.equal(calendar.month, 7);
    assert.equal(stateManager.get('世界·时间'), time);
  }
  assert.equal(parseGameCalendar('K052-07-15').time_of_day, '', 'date-only values do not claim a clock');
  reset('木叶51年·秋·第3天·夜晚');
  assert.deepEqual(worldStateSystem.getCalendar(), { year: '木叶51年', month: 7, day: 3, time_of_day: '夜晚' });
});
test('an exact nighttime clock also reaches the visible atmosphere consumer', () => {
  const savedDocument = globalThis.document;
  const styles = new Map();
  globalThis.document = { documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } },
    body: { classList: { add() {}, remove() {} } } };
  try {
    reset('K052-07-15T23:45');
    atmosphereManager.updateAtmosphere();
    assert.equal(atmosphereManager.chakraColor, '#8b6c9c');
    reset('木叶52年7月15日·13:45');
    atmosphereManager.updateAtmosphere();
    assert.equal(atmosphereManager.chakraColor, '#7fb7d8');
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  }
});
test('legacy flat time instructions derive the same month and year as structured writes', () => {
  const output = '<var>世界·时间 = 木叶53年2月4日·下午</var><memory>{"summary":"已到二月四日。"}</memory>';
  assert.equal(validateVariableUpdaterOutput(output, { state: stateManager.get() }).valid, true);
  pipeline._applyInstructions(instructionParser.parse(output), true);
  assert.equal(stateManager.get('世界·年代'), '木叶53年');
  assert.equal(stateManager.get('世界·月份'), 2);
  assert.equal(worldStateSystem.getCalendar().time_of_day, '下午');
});
test('each updater request gets its actual time baseline even when a custom preset omits state_json', () => {
  const custom = { version: DEFAULT_VARIABLE_UPDATER_PRESET_VERSION, entries: [
    { id: 'custom', role: 'user', content: '{{user_input}}\n{{narrative_response}}' }
  ] };
  for (const preset of [DEFAULT_VARIABLE_UPDATER_PRESET, custom]) {
    for (const time of ['K061-02-03T23:40', '木叶72年9月17日·凌晨']) {
      reset(time);
      const messages = buildVariableUpdaterMessages(preset, { state: stateManager.get(), userInput: '休息',
        narrativeResponse: '第二天清晨醒来。', compactState: {}, includeDaily: false });
      const match = messages.map(value => value.content).join('\n').match(/\[本回合时间基点\]\n([^\n]+)/);
      assert.ok(match);
      const anchor = JSON.parse(match[1]);
      assert.equal(anchor.current_calendar, time);
      assert.deepEqual(anchor.parsed_calendar, parseGameCalendar(time));
    }
  }
});
test('the shared Agent contract can read compact evidence and preserves an unknown baseline', () => {
  for (const time of ['K061-02-03·清晨', null]) {
    const contract = buildVariableUpdaterRuntimeContract({ compactState: { world: { '世界·时间': time } }, includeDaily: false });
    const anchor = JSON.parse(contract.match(/\[本回合时间基点\]\n([^\n]+)/)[1]);
    assert.equal(anchor.current_calendar, time);
    if (time == null) assert.equal(anchor.parsed_calendar, null);
  }
});
test('short factual audits remain advisory and do not demand prose or a redundant time write', () => {
  const output = '<variable_thinking>请求核对：商定明天集合，尚未出发。时间：未变。</variable_thinking>'
    + '<memory>{"summary":"双方约定明天集合，当前尚未出发。"}</memory>';
  const result = validateVariableUpdaterOutput(output, { state: stateManager.get(), updateObligations: {} });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.deepEqual(instructionParser.parse(output).variables, []);
});
test('preset upgrade backs up v18 exactly and retains independent custom entries', () => {
  const old = JSON.stringify({ version: 18, name: '原变量预设', entries: [
    { id: 'variable_updater_system', role: 'system', content: '旧内置规则' },
    { id: 'custom_note', role: 'system', content: '我的附加规则', enabled: false }
  ] });
  localStorage.setItem(VARIABLE_UPDATER_PRESET_STORAGE_KEY, old);
  const upgraded = getVariableUpdaterPreset();
  assert.equal(upgraded.version, DEFAULT_VARIABLE_UPDATER_PRESET_VERSION);
  assert.equal(upgraded.entries.find(entry => entry.id === 'custom_note').content, '我的附加规则');
  assert.equal(upgraded.entries.find(entry => entry.id === 'custom_note').enabled, false);
  const backupKey = localStorage.getItem(`${VARIABLE_UPDATER_PRESET_BACKUP_PREFIX}latest`);
  assert.equal(localStorage.getItem(backupKey), old);
});

console.log(`${passed} variable time tests passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
