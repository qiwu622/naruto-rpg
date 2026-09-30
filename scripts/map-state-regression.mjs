import assert from 'node:assert/strict';

import { stateManager } from '../js/core/state-manager.js';
import { validateStructuredVariableUpdate } from '../js/data/var-schema.js';

// Exercise the component's actual render path without a browser or image load.
let MapModal;
globalThis.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = {
      innerHTML: '',
      getElementById: id => id === 'map-img'
        ? { complete: false, addEventListener() {} }
        : null
    };
    return this.shadowRoot;
  }
};
globalThis.customElements = {
  define(name, component) {
    if (name === 'map-modal') MapModal = component;
  }
};
await import('../js/ui/map-modal.js');

let passed = 0;
function test(name, fn) {
  stateManager.reset();
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function renderMap() {
  const modal = new MapModal();
  modal.connectedCallback();
  return modal.shadowRoot.innerHTML;
}

test('valid map variables appear in the map intelligence panel', () => {
  const update = {
    path: 'world_state.map.known_locations', op: 'assign', key: '林间据点',
    value: { x: 300, y: 400, desc: '废弃哨所内发现补给', tier: 'landmark' }
  };
  assert.equal(validateStructuredVariableUpdate(update).valid, true);
  stateManager.batchUpdate([update]);

  const html = renderMap();
  assert.match(html, /林间据点/);
  assert.match(html, /废弃哨所内发现补给/);
  assert.doesNotMatch(html, /尚未打探到相关地标情报|\[object Object\]/);
});

test('legacy map intelligence remains visible and current records take precedence', () => {
  const snapshot = stateManager.getDefaultState();
  snapshot['世界·已知地点·旧驿站'] = '旧存档记录的驿站';
  snapshot['世界·已知地点·林间据点'] = '已经过时的情报';
  stateManager.restore(snapshot);
  stateManager.batchUpdate([{
    path: 'world_state.map.known_locations', op: 'assign', key: '林间据点',
    value: { x: 300, y: 400, desc: '更新后的据点情报', tier: 'landmark' }
  }]);

  const html = renderMap();
  assert.match(html, /旧驿站/);
  assert.match(html, /旧存档记录的驿站/);
  assert.match(html, /更新后的据点情报/);
  assert.doesNotMatch(html, /已经过时的情报/);
});

test('removed map locations do not reappear from legacy flat records', () => {
  const snapshot = stateManager.getDefaultState();
  snapshot['世界·已知地点·林间据点'] = '已经过时的情报';
  snapshot._map.known_locations['林间据点'] = {
    x: 300, y: 400, desc: '更新后的据点情报', tier: 'landmark'
  };
  stateManager.restore(snapshot);
  stateManager.batchUpdate([{
    path: 'world_state.map.known_locations', op: 'remove', key: '林间据点'
  }]);

  const html = renderMap();
  assert.equal(html.includes('林间据点'), false);
  assert.match(html, /尚未打探到相关地标情报/);
});

console.log(`\n${passed} map state regression tests passed.`);
