import assert from 'node:assert/strict';
import {
  getStructuredVariableContractPrompt,
  getVariableUpdateDomain,
  normalizeStructuredVariableUpdate,
  STRUCTURED_SCALAR_PATH_MAP
} from '../js/data/var-schema.js';
import { validateVariableUpdaterOutput } from '../js/core/variable-updater.js';
import { instructionParser } from '../js/core/instruction-parser.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const moneyUpdates = [
  { path: 'equipment.ryo', op: 'add', value: 100 },
  { path: 'progression.ryo', op: 'add', value: 100 },
  { key: '进度·金钱', op: '+', value: 100 },
  { key: '状态·金钱', op: '+', value: 100 },
  { key: '金钱', op: '+', value: 100 },
  { path: 'attributes_and_progression', op: 'add', key: '进度·金钱', value: 100 },
  { path: 'attributes_and_progression', op: 'add', value: { '金钱': 100 } },
  { path: 'skills_and_equipment', op: 'add', value: { '进度·金钱': 100 } }
];

test('money uses equipment for canonical, legacy, flat and evidence-wrapper aliases', () => {
  for (const update of moneyUpdates) {
    assert.equal(getVariableUpdateDomain(update), 'equipment', JSON.stringify(update));
  }
});

test('every scalar path and its canonical state key have the same domain', () => {
  for (const [path, key] of Object.entries(STRUCTURED_SCALAR_PATH_MAP)) {
    const domain = getVariableUpdateDomain({ path });
    assert.ok(domain, path);
    assert.equal(domain, getVariableUpdateDomain({ key }), path);
  }
});

test('flat aliases are canonical before validation and parser execution without renaming entity keys', () => {
  const raw = { key: '状态·金钱', op: '+', value: 100 };
  assert.deepEqual(normalizeStructuredVariableUpdate(raw), { key: '进度·金钱', op: '+', value: 100 });
  assert.equal(raw.key, '状态·金钱');
  const instructions = instructionParser.parse(`<variable>${JSON.stringify(raw)}</variable>`);
  assert.deepEqual(instructions.variables, [{ key: '进度·金钱', op: '+', value: 100 }]);
  const removeEntity = { path: 'equipment.tools', op: 'remove', key: '金钱' };
  assert.deepEqual(normalizeStructuredVariableUpdate(removeEntity), removeEntity);
});

test('other supported variable domains preserve existing semantics', () => {
  for (const [path, expected] of [
    ['world_state.calendar', 'world'],
    ['world_state.map.known_locations', 'world'],
    ['attributes.chakra_current', 'attributes'],
    ['progression.exp', 'attributes'],
    ['progression.reputation.木叶', 'attributes'],
    ['player.rank', 'attributes'],
    ['player.reputation_tags', 'attributes'],
    ['player.current_goal', 'missions'],
    ['skills.jutsu.分身术.mastery', 'skills'],
    ['equipment.consumables.烟雾弹.quantity', 'equipment'],
    ['equipment.equipped.weapon', 'equipment']
  ]) assert.equal(getVariableUpdateDomain({ path }), expected, path);
  assert.equal(getVariableUpdateDomain({ key: '角色·当前目标' }), 'missions');
  assert.equal(getVariableUpdateDomain({ key: '状态·查克拉' }), 'attributes');
  assert.equal(getVariableUpdateDomain({ key: '状态·地点' }), 'world');
  assert.equal(getVariableUpdateDomain({ key: '物品·忍具·苦无·数量' }), 'equipment');
  assert.equal(getVariableUpdateDomain(null), null);
  assert.equal(getVariableUpdateDomain({ path: 'unknown' }), null);
});

function moneyOutput(update, equipmentStatus = 'updated', attributesStatus = 'unchanged') {
  const thinking = [
    '时间地点与地图', '资源与属性成长', '技能与能力', '物品、金钱与装备',
    '任务、目标、声望与历练', '人物关系与NPC状态', '战斗、伤势与世界事件', '记忆、线索、约定与待办'
  ].map(heading => `${heading}：已核对。`).join('\n');
  const domains = {
    world: 'unchanged', attributes: attributesStatus, skills: 'unchanged', equipment: equipmentStatus,
    missions: 'unchanged', relationships: 'unchanged', combat: 'unchanged', events: 'unchanged'
  };
  return [
    `<variable_thinking>请求复述：收下已经交付的一百两报酬。\n${thinking}</variable_thinking>`,
    `<update_manifest>${JSON.stringify({ domains, present_npcs: {}, active_missions: {} })}</update_manifest>`,
    `<variable>${JSON.stringify(update)}</variable>`,
    '<memory>{"summary":"玩家收到了一百两报酬。"}</memory>'
  ].join('\n');
}

test('the same money manifest accepts both structured paths and flat state keys', () => {
  for (const update of moneyUpdates) {
    const result = validateVariableUpdaterOutput(moneyOutput(update), { state: {}, updateObligations: {} });
    assert.equal(result.valid, true, `${JSON.stringify(update)}: ${result.errors.join('; ')}`);
  }
});

test('a mistaken money domain is derived from the actual write without another model retry', () => {
  const result = validateVariableUpdaterOutput(moneyOutput(moneyUpdates[1], 'unchanged', 'updated'), {
    state: {}, updateObligations: {}
  });
  assert.equal(result.valid, true);
  assert.equal(result.manifest.domains.equipment, 'updated');
  assert.equal(result.manifest.domains.attributes, 'unchanged');
  assert.ok(result.warnings.some(error => error.includes('manifest=unchanged')));
});

test('the shared DSL tells the model where money, goals and ordinary progression belong', () => {
  const prompt = getStructuredVariableContractPrompt();
  assert.match(prompt, /equipment：金钱（统一使用 equipment\.ryo/);
  assert.match(prompt, /missions：当前目标（player\.current_goal）/);
  assert.match(prompt, /attributes：.*除金钱外的 progression\.\*/);
});

console.log(`variable domain regression: ${passed} passed`);
