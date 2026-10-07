import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class FakeControl {
  constructor() { this.disabled = false; this.textContent = ''; this.innerHTML = ''; this.attributes = {}; }
  setAttribute(key, value) { this.attributes[key] = value; }
  focus() { this.focused = true; }
}
class FakeHTMLElement {
  constructor() { this.listeners = new Map(); this.innerHTML = ''; }
  set innerHTML(value) {
    this._html = value;
    this.nodes = new Map(['[data-memory-results]', '[data-memory-error]', '[data-memory-status]', '[data-memory-draft]', 'section']
      .map(selector => [selector, new FakeControl()]));
    this.controls = [new FakeControl(), new FakeControl(), new FakeControl()];
  }
  get innerHTML() { return this._html; }
  querySelector(selector) { return this.nodes.get(selector); }
  querySelectorAll() { return this.controls; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  contains() { return true; }
}
globalThis.HTMLElement = FakeHTMLElement;
const registered = new Map();
globalThis.customElements = { get: name => registered.get(name), define: (name, value) => registered.set(name, value) };

const { MemoryFactsEditor } = await import('../js/ui/memory-facts-editor.js');
const { stateManager } = await import('../js/core/state-manager.js');
const { eventBus } = await import('../js/core/event-bus.js');
const { prepareMemoryCorrection, listMemoryFacts } = await import('../js/core/memory-corrections.js');
const { appendMemoryEvents, createContinuityLedger } = await import('../js/core/continuity-ledger.js');

const originalSnapshot = stateManager.snapshot;
const originalRequest = eventBus.request;
let state;
let ui;
let passed = 0;
const events = [];

function fixture() {
  return {
    _memory: { facts: Array.from({ length: 25 }, (_, index) => `事实 ${index}`).join('\n'), clues: '医院线索\n村口线索', corrections: [] },
    _meta: { current_node_id: 'node_25', active_branch: 'branch_main' }, '系统·回合数': 25
  };
}
function button(action, data = {}) {
  const target = { dataset: { action, ...data }, disabled: false };
  target.closest = () => target;
  return { target };
}
function input(selector, value) { return { target: { value, matches: candidate => candidate === selector } }; }
const results = () => ui.querySelector('[data-memory-results]').innerHTML;
const expected = () => ({ nodeId: state._meta.current_node_id, branchId: state._meta.active_branch, memory: JSON.stringify(state._memory) });

async function test(name, fn) {
  state = fixture();
  events.length = 0;
  stateManager.snapshot = () => structuredClone(state);
  eventBus.request = async (event, payload) => { events.push({ event, payload }); return { id: 'saved_node' }; };
  ui = new MemoryFactsEditor();
  ui.connectedCallback();
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  finally { ui.dispose(); }
}

try {
  await test('facts paginate in groups of twenty and preserve search input focus', async () => {
    assert.equal((results().match(/<article /g) || []).length, 20);
    assert.match(results(), /27 条记忆/);
    await ui._onClick(button('next'));
    assert.equal((results().match(/<article /g) || []).length, 7);
    const unchangedOuter = ui.innerHTML;
    ui._onInput(input('[data-memory-search]', '医院'));
    assert.equal((results().match(/<article /g) || []).length, 1);
    assert.match(results(), /医院线索/);
    assert.equal(ui._page, 0);
    assert.equal(ui.innerHTML, unchangedOuter, 'search only replaces results, preserving the input element');
    ui._onInput(input('[data-memory-search]', ''));
    ui._onChange(input('[data-memory-field]', 'clues'));
    assert.equal((results().match(/<article /g) || []).length, 2);
  });

  await test('unknown legacy sources have no navigation button', () => {
    assert.match(results(), /来源未知/);
    assert.ok(!results().includes('data-action="source"'));
  });

  await test('verified source requests contain only the real originating node', async () => {
    state._continuity = appendMemoryEvents(createContinuityLedger(), { event_id: 'verified', value: '事实 0', type: 'fact' },
      { nodeId: 'node_original', branchId: 'branch_main', turn: 1, recordedAt: 1 }).ledger;
    ui.render();
    assert.match(results(), /data-node-id="node_original"/);
    await ui._onClick(button('source', { nodeId: 'node_original' }));
    assert.deepEqual(events, [{ event: 'memory:source-requested', payload: { nodeId: 'node_original' } }]);
  });

  await test('inline correction sends the captured state guard and waits for persistence', async () => {
    const factId = listMemoryFacts(state)[0].id;
    const guard = expected();
    await ui._onClick(button('edit', { factId }));
    assert.match(results(), /<textarea /);
    ui._onInput(input('[data-memory-draft]', '修订后的事实'));
    let resolve;
    eventBus.request = (event, payload) => {
      events.push({ event, payload });
      return new Promise(done => { resolve = done; });
    };
    const before = results();
    const pending = ui._onClick(button('save', { factId }));
    assert.equal(ui._busy, true);
    assert.ok(ui.controls.every(control => control.disabled));
    assert.deepEqual(events[0], { event: 'memory:correction-requested', payload: {
      action: 'correct', factId, text: '修订后的事实', expected: guard
    } });
    state = prepareMemoryCorrection(state, events[0].payload);
    eventBus.emit('memory:corrected', {});
    assert.equal(results(), before, 'events cannot render unsaved changes while request is pending');
    resolve({ id: 'saved_node' });
    await pending;
    assert.equal(ui._busy, false);
    assert.equal(ui._editing, null);
    assert.match(results(), /修订后的事实/);
  });

  await test('reject and pin use guarded requests with no local memory mutation', async () => {
    const before = structuredClone(state);
    const factId = listMemoryFacts(state)[0].id;
    const guard = expected();
    await ui._onClick(button('reject', { factId }));
    await ui._onClick(button('pin', { factId }));
    assert.deepEqual(events.map(item => item.payload), [
      { action: 'reject', factId, expected: guard }, { action: 'pin', factId, expected: guard }
    ]);
    assert.deepEqual(state, before);
  });

  await test('undo history explains cascading and submits its correction id', async () => {
    state = prepareMemoryCorrection(state, { action: 'correct', factId: listMemoryFacts(state)[0].id, text: '已纠正' });
    ui.render();
    assert.match(ui.innerHTML, /同时撤销该事实之后的纠正、否定和置顶/);
    const correctionId = state._memory.corrections[0].id;
    const guard = expected();
    await ui._onClick(button('undo', { correctionId }));
    assert.deepEqual(events[0].payload, { action: 'undo', correctionId, expected: guard });
  });

  await test('request failures retain drafts, report role alert and re-enable controls', async () => {
    const factId = listMemoryFacts(state)[0].id;
    await ui._onClick(button('edit', { factId }));
    ui._onInput(input('[data-memory-draft]', '还未保存的修订'));
    eventBus.request = async () => { throw new Error('磁盘保存失败'); };
    await ui._onClick(button('save', { factId }));
    assert.match(ui.innerHTML, /role="alert"[^>]*>磁盘保存失败/);
    assert.equal(ui._editing.text, '还未保存的修订');
    assert.equal(ui._busy, false);
    assert.ok(ui.controls.every(control => !control.disabled));
    assert.equal(state._memory.corrections.length, 0);
  });

  await test('restoration refreshes state and disposes listeners on disconnect', async () => {
    await ui._onClick(button('edit', { factId: listMemoryFacts(state)[0].id }));
    state._memory.facts = '另一个分支的事实';
    eventBus.emit('state:restored', {});
    assert.equal(ui._editing, null);
    assert.match(results(), /另一个分支的事实/);
    const html = results();
    ui.disconnectedCallback();
    state._memory.facts = '不应再更新';
    eventBus.emit('memory:corrected', {});
    assert.equal(results(), html);
    assert.equal(ui.listeners.size, 0);
    assert.ok(!eventBus._listeners.get('memory:corrected')?.size);
    assert.ok(!eventBus._listeners.get('state:restored')?.size);
  });

  await test('fact and textarea content is escaped and mobile layout can wrap', async () => {
    state._memory.facts = '</textarea><img src=x onerror=alert(1)>';
    ui.render();
    assert.ok(!results().includes('<img'));
    await ui._onClick(button('edit', { factId: listMemoryFacts(state)[0].id }));
    assert.ok(!results().includes('<img'));
    assert.match(results(), /&lt;\/textarea&gt;/);
    assert.match(ui.innerHTML, /overflow-wrap:anywhere/);
    assert.match(ui.innerHTML, /max-height:560px;overflow:auto/);
    assert.match(ui.innerHTML, /flex-wrap:wrap/);
  });

  await test('duplicate clicks are ignored while a request is pending', async () => {
    const factId = listMemoryFacts(state)[0].id;
    let resolve;
    eventBus.request = (event, payload) => { events.push({ event, payload }); return new Promise(done => { resolve = done; }); };
    const pending = ui._onClick(button('pin', { factId }));
    await ui._onClick(button('pin', { factId }));
    assert.equal(events.length, 1);
    ui.disconnectedCallback();
    resolve({ id: 'saved_node' });
    await pending;
    assert.equal(ui._connected, false);
    assert.equal(ui._busy, false);
  });

  await test('memory settings mount the editor and public copies match source', () => {
    const panel = readFileSync(new URL('../js/ui/memory-panel.js', import.meta.url), 'utf8');
    assert.match(panel, /import '\.\/memory-facts-editor\.js'/);
    assert.match(panel, /<memory-facts-editor><\/memory-facts-editor>/);
    for (const file of ['memory-facts-editor.js', 'memory-panel.js']) {
      assert.equal(readFileSync(new URL(`../js/ui/${file}`, import.meta.url), 'utf8'),
        readFileSync(new URL(`../public/js/ui/${file}`, import.meta.url), 'utf8'));
    }
  });
} finally {
  stateManager.snapshot = originalSnapshot;
  eventBus.request = originalRequest;
  ui?.dispose();
}
console.log(`\nMemory facts editor regression: ${passed} passed.`);
