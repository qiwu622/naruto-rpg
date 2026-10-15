import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { stateManager } from '../js/core/state-manager.js';
import { memorySystem } from '../js/systems/memory-system.js';
import { getMemoryRecallTrace } from '../js/core/memory-recall-trace.js';

const state = stateManager.getDefaultState();
state['系统·回合数'] = 20;
state._memory = { ...state._memory, pins: '与卡卡西的约定', facts: '卡卡西在木叶教过雷遁。',
  chapters: JSON.stringify([{ id: 1, from: 3, to: 8, summary: '卡卡西交付了卷轴' }]) };
stateManager.restore(state);
const before = memorySystem.buildPromptContext(state._memory, { userInput: '卡卡西的卷轴' });
const after = memorySystem.buildPromptContext(state._memory, { userInput: '卡卡西的卷轴', captureTrace: true });
assert.equal(after, before, 'UI trace must not change model context');
const trace = getMemoryRecallTrace();
assert.equal(trace.turn, 20);
assert.ok(trace.sections.length);
assert.ok(trace.sections.every(section => after.includes(section.text)));
assert.ok(trace.sections.some(section => section.sources.some(source => source.fromTurn === 3 && source.toTurn === 8)));
assert.ok(trace.sections.some(section => section.sources.some(source => source.field === 'facts' && source.fromTurn == null)));
const overBudget = { ...state._memory, pins: '不能纳入预算'.repeat(4000) };
memorySystem.buildPromptContext(overBudget, { captureTrace: true });
assert.ok(!getMemoryRecallTrace().sections.some(section => section.title === '置顶提醒'));
stateManager.restore(state); assert.equal(getMemoryRecallTrace(), null);
console.log('PASS unchanged prompt, exact accepted sections, chapter provenance, unknown origin not fabricated, budget omission, restore clears trace');

const app = express();
app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#111720;color:#ddd"><main></main>'));
app.use(express.static(process.cwd()));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let browser;
try {
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async state => {
    await import('/js/ui/memory-panel.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { memorySystem } = await import('/js/systems/memory-system.js');
    stateManager.restore(state);
    document.querySelector('main').append(document.createElement('memory-panel'));
    memorySystem.buildPromptContext(state._memory, { userInput: '卡卡西的卷轴', captureTrace: true });
    Object.assign(window, { stateManager });
  }, state);
  const panel = page.locator('memory-recall-panel');
  assert.equal(await panel.locator('details').getAttribute('open'), null);
  await panel.locator('summary').click();
  assert.match(await panel.textContent(), /第 3–8 回合/);
  await panel.getByRole('button', { name: /查找并修订：卡卡西/ }).click();
  assert.equal(await page.locator('[data-memory-search]').inputValue(), state._memory.facts);
  assert.equal(await page.locator('[data-memory-field]').inputValue(), 'facts');
  assert.match(await page.locator('[data-memory-results]').textContent(), /卡卡西在木叶教过雷遁/);
  await page.evaluate(() => stateManager.restore(stateManager.getDefaultState()));
  assert.doesNotMatch(await panel.textContent(), /交付了卷轴/);
  assert.deepEqual(errors, []);
  console.log('PASS real settings panel, collapsed trace, provenance display, locate existing correction editor, save switch clears old evidence');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
