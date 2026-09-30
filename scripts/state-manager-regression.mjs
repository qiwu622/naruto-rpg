import assert from 'node:assert/strict';

import { stateManager } from '../js/core/state-manager.js';
import { normalizeStateCommands } from '../js/core/state-command-normalizer.js';

let passed = 0;

function test(name, fn) {
  stateManager.reset();
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test('command normalizer keeps mixed updates side-effect free', () => {
  const state = stateManager.getDefaultState();
  const before = JSON.stringify(state);
  const normalized = normalizeStateCommands([
    { key: '进度·经验', op: '+', value: 10 },
    { path: 'attributes.chakra_current', op: 'sub', value: 2 },
    { path: 'skills.jutsu', op: 'remove', key: '火遁·豪火球' },
    { path: 'world_state.unknown', op: 'set', value: 'ignored' },
    { path: 'skills.jutsu.__proto__', op: 'remove', key: '火遁·豪火球' },
    { path: '关系·__proto__·好感', op: 'set', value: 10 }
  ], { state });

  assert.deepEqual(normalized.flatUpdates, [
    { key: '进度·经验', op: '+', value: 10 },
    { key: '属性·当前查克拉', op: '-', value: 2 }
  ]);
  assert.deepEqual(normalized.commands, [{
    kind: 'delete-flat-entity',
    baseKey: '技能·忍术·火遁·豪火球'
  }]);
  assert.deepEqual(normalized.invalid, [
    { path: 'world_state.unknown', reason: 'unknown-path' },
    { path: 'skills.jutsu.__proto__', reason: 'forbidden-path' },
    { path: '关系·__proto__·好感', reason: 'forbidden-key' }
  ]);
  assert.equal(JSON.stringify(state), before);
});

test('compatibility projection preserves zero-valued resources and money', () => {
  stateManager.update([
    { key: '属性·查克拉', op: '=', value: 0 },
    { key: '属性·当前查克拉', op: '=', value: 0 },
    { key: '属性·生命力', op: '=', value: 0 },
    { key: '属性·当前生命力', op: '=', value: 0 },
    { key: '进度·金钱', op: '=', value: 0 }
  ]);

  const projected = stateManager.get();
  assert.equal(projected.attributes.chakra, 0);
  assert.equal(projected.attributes.chakra_current, 0);
  assert.equal(projected.attributes.vitality, 0);
  assert.equal(projected.attributes.vitality_current, 0);
  assert.equal(projected.equipment.ryo, 0);
});

test('unknown structured paths are rejected instead of creating a second state model', () => {
  stateManager.batchUpdate([
    { path: 'attributes.not_real', op: 'set', value: 10 },
    { path: 'world_state.not_real', op: 'set', value: 'unexpected' },
    { path: '_meta.current_node_id', op: 'set', value: 'forged' },
    { path: '关系·__proto__·好感', op: 'set', value: 10 }
  ]);

  assert.equal(Object.hasOwn(stateManager.state, 'attributes'), false);
  assert.equal(Object.hasOwn(stateManager.state, 'world_state'), false);
  assert.equal(stateManager.get('attributes.not_real'), undefined);
  assert.equal(stateManager.get('world_state.not_real'), undefined);
  assert.equal(stateManager.get('_meta.current_node_id'), null);
  assert.equal(Object.prototype.affection, undefined);
});

test('supported structured scalar paths still normalize to canonical flat keys', () => {
  stateManager.batchUpdate([
    { path: 'attributes.chakra_current', op: 'set', value: 7 },
    { path: 'world_state.current_location', op: 'set', value: '死亡森林' }
  ]);

  assert.equal(stateManager.get('属性·当前查克拉'), 7);
  assert.equal(stateManager.get('世界·地点'), '死亡森林');
  assert.equal(Object.hasOwn(stateManager.state, 'attributes'), false);
  assert.equal(Object.hasOwn(stateManager.state, 'world_state'), false);
});

test('mixed structured writes and removals retain their input order', () => {
  stateManager.batchUpdate([
    { path: 'equipment.equipped.weapon', op: 'set', value: '测试刀' },
    { path: 'equipment.equipped.weapon', op: 'remove' }
  ]);
  assert.equal(stateManager.get('物品·已装备·武器'), undefined);

  stateManager.batchUpdate([
    { path: 'equipment.equipped.weapon', op: 'remove' },
    { path: 'equipment.equipped.weapon', op: 'set', value: '新刀' }
  ]);
  assert.equal(stateManager.get('物品·已装备·武器'), '新刀');
});

test('explored region pushes accumulate against earlier writes in the same batch', () => {
  stateManager.update([{ key: '世界·已探索区域', op: '=', value: '木叶' }]);
  stateManager.batchUpdate([
    { path: 'world_state.map.explored_regions', op: 'push', value: '森林' },
    { path: 'world_state.map.explored_regions', op: 'push', value: '川之国' }
  ]);
  assert.equal(stateManager.get('世界·已探索区域'), '木叶，森林，川之国');

  stateManager.batchUpdate([
    { path: 'world_state.map.explored_regions', op: 'set', value: ['木叶', '森林'] },
    { path: 'world_state.map.explored_regions', op: 'push', value: '川之国' },
    { path: 'world_state.map.explored_regions', op: 'push', value: '木叶' }
  ]);
  assert.equal(stateManager.get('世界·已探索区域'), '木叶，森林，川之国');

  stateManager.update([{ key: '世界·已探索区域', op: '=', value: '木叶, 森林，川之国' }]);
  stateManager.batchUpdate([{ path: 'world_state.map.explored_regions', op: 'push', value: '森林' }]);
  assert.equal(stateManager.get('世界·已探索区域'), '木叶，森林，川之国');
});

console.log(`\n${passed} state manager regression tests passed.`);
