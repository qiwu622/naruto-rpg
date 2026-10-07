import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><main id="app"></main>');
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('outside');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const memory = await import('/js/core/memory-corrections.js');
    const { memorySystem } = await import('/js/systems/memory-system.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    const { NarutoRPGApp } = await import('/js/app.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    Object.assign(window, { stateManager, timelineSystem, memory, memorySystem, eventBus });
    appShell.init(document.querySelector('#app'));
    window.app = new NarutoRPGApp();
    app.pipeline = { isProcessing: false, setHistory() {} };
    app._bindEvents();
    await timelineSystem.init();
    stateManager.setSub('_memory', { facts: '鹿丸已离开木叶\n井野交给你药草', recent_summary: '你送别了鹿丸', pins: '' });
    window.origin = await timelineSystem.createRootNode({ summary: '晨光下，井野递来药草。', stateSnapshot: stateManager.snapshot(), chatHistory: [{ role: 'assistant', content: '晨光下，井野递来药草。' }] });
    window.before = stateManager.snapshot();
    window.requestFor = (text, action, extra = {}) => ({ action, factId: memory.listMemoryFacts(stateManager.snapshot()).find(item => item.text === text)?.id, ...extra,
      expected: { nodeId: stateManager.getSub('_meta').current_node_id, branchId: stateManager.getSub('_meta').active_branch, memory: JSON.stringify(stateManager.getSub('_memory')) } });
    window.correction = requestFor('鹿丸已离开木叶', 'correct', { text: '鹿丸仍留在木叶' });
    window.corrected = await eventBus.request('memory:correction-requested', correction);
  });
  const checkpoint = await page.evaluate(async () => ({
    old: (await stateManager.dbGet('timeline_nodes', origin.id)).state_snapshot._memory,
    now: stateManager.getSub('_memory'), projected: memory.projectCorrectedMemory(stateManager.getSub('_memory')),
    turn: corrected.turn_number, originalTurn: origin.turn_number,
    history: await timelineSystem._reconstructChatHistory(corrected),
    prompt: memorySystem.buildPromptContext(stateManager.getSub('_memory'))
  }));
  assert.equal(checkpoint.old.corrections, undefined);
  assert.equal(checkpoint.now.facts, checkpoint.old.facts);
  assert.match(checkpoint.projected.facts, /鹿丸仍留在木叶/);
  assert.equal(checkpoint.projected.recent_summary, '');
  assert.equal(checkpoint.turn, checkpoint.originalTurn);
  assert.equal(checkpoint.history.length, 1);
  assert.match(checkpoint.prompt, /玩家记忆纠错/);
  assert.ok(!checkpoint.prompt.includes('你送别了鹿丸'));
  console.log('PASS correction atomically creates a same-turn checkpoint, preserves ancestor and history, and reaches the real prompt');

  assert.match(await page.evaluate(async () => {
    try { await eventBus.request('memory:correction-requested', correction); return 'accepted'; } catch (error) { return error.message; }
  }), /已变化/);
  const preview = await page.evaluate(async () => {
    const id = stateManager.getSub('_meta').current_node_id;
    await eventBus.request('memory:source-requested', { nodeId: origin.id });
    return { same: id === stateManager.getSub('_meta').current_node_id,
      text: [...document.querySelectorAll('game-modal')].at(-1).shadowRoot.querySelector('[data-memory-source]').textContent };
  });
  assert.ok(preview.same); assert.match(preview.text, /井野/);
  console.log('PASS stale editor is rejected without mutation; source preview reads prose without jumping timelines');

  const failure = await page.evaluate(async () => {
    const beforeState = JSON.stringify(stateManager.snapshot());
    const count = (await timelineSystem.getAllNodes()).length;
    const originalMutate = stateManager.dbMutateTimeline;
    stateManager.dbMutateTimeline = async () => { throw new Error('synthetic quota'); };
    let message;
    try { await timelineSystem.commitMemoryCorrection(requestFor('鹿丸仍留在木叶', 'pin')); } catch (error) { message = error.message; }
    finally { stateManager.dbMutateTimeline = originalMutate; }
    return { message, unchanged: beforeState === JSON.stringify(stateManager.snapshot()), count, afterCount: (await timelineSystem.getAllNodes()).length };
  });
  assert.match(failure.message, /synthetic/); assert.ok(failure.unchanged); assert.equal(failure.count, failure.afterCount);
  console.log('PASS failed disk transaction leaves both runtime and timeline untouched');

  const race = await page.evaluate(async () => {
    const id = stateManager.getSub('_meta').current_node_id;
    const count = (await timelineSystem.getAllNodes()).length;
    const mutate = stateManager.dbMutateTimeline.bind(stateManager);
    stateManager.dbMutateTimeline = (fn, options) => mutate(data => {
      const result = fn(data);
      stateManager.setSub('_test_background_result', 'preserved');
      return result;
    }, options);
    let message;
    try { await timelineSystem.commitMemoryCorrection(requestFor('鹿丸仍留在木叶', 'pin')); } catch (error) { message = error.message; }
    finally { stateManager.dbMutateTimeline = mutate; }
    return { message, sameNode: id === stateManager.getSub('_meta').current_node_id,
      background: stateManager.getSub('_test_background_result'), count, after: (await timelineSystem.getAllNodes()).length };
  });
  assert.match(race.message, /已变化/); assert.ok(race.sameNode); assert.equal(race.background, 'preserved'); assert.equal(race.count, race.after);
  console.log('PASS concurrent runtime update aborts the IndexedDB transaction and preserves the newer state');

  const fork = await page.evaluate(async () => {
    await timelineSystem.jumpToNode(origin.id);
    const node = await timelineSystem.commitMemoryCorrection(requestFor('鹿丸已离开木叶', 'reject'));
    const branch = stateManager.getSub('_meta').active_branch;
    const originalHead = await stateManager.dbGet('timeline_branches', 'branch_main');
    const projected = memory.projectCorrectedMemory(stateManager.getSub('_memory'));
    await timelineSystem.switchBranch('branch_main');
    const mainFacts = memory.projectCorrectedMemory(stateManager.getSub('_memory')).facts;
    await timelineSystem.switchBranch(branch);
    const rule = stateManager.getSub('_memory').corrections[0];
    await timelineSystem.commitMemoryCorrection({ action: 'undo', correctionId: rule.id });
    const undone = memory.projectCorrectedMemory(stateManager.getSub('_memory')).facts;
    const { assertTimelineSave } = await import('/js/core/timeline-save-schema.js');
    assertTimelineSave(await timelineSystem.getExportData());
    return { branch, originalHead: originalHead.head_node_id, corrected: corrected.id, facts: projected.facts, mainFacts, undone, nodeTurn: node.turn_number };
  });
  assert.notEqual(fork.branch, 'branch_main'); assert.equal(fork.originalHead, fork.corrected);
  assert.ok(!fork.facts.includes('鹿丸')); assert.match(fork.mainFacts, /鹿丸仍留在木叶/); assert.match(fork.undone, /鹿丸已离开木叶/);
  console.log('PASS historical correction forks safely, switching restores branch-specific rules, undo and full export remain valid');

  const nextTurn = await page.evaluate(() => {
    const draft = memory.prepareMemoryCorrection({ ...stateManager.snapshot(), _memory: {
      facts: '鹿丸已离开木叶', recent_summary: '你送别了鹿丸', turn_summaries: '#1 你送别了鹿丸',
      compressed_summary: '从此村中再无鹿丸的踪影', pins: ''
    } }, { action: 'correct', factId: memory.listMemoryFacts({ _memory: { facts: '鹿丸已离开木叶' } })[0].id, text: '鹿丸仍留在木叶' });
    const saved = stateManager.getSub('_memory');
    stateManager.setSub('_memory', draft._memory);
    memorySystem.rememberRecentTurn('继续训练', '井野教你整理药草。');
    const result = { raw: stateManager.getSub('_memory'), effective: memory.projectCorrectedMemory(stateManager.getSub('_memory')),
      payload: memorySystem._buildDeepConsolidationPayload(memorySystem._loadMemory(), 0) };
    stateManager.setSub('_memory', saved);
    return result;
  });
  assert.ok(!nextTurn.effective.recent_summary.includes('送别')); assert.ok(!nextTurn.effective.compressed_summary.includes('再无鹿丸'));
  assert.match(nextTurn.effective.recent_summary, /整理药草/); assert.ok(!nextTurn.payload.includes('送别'));
  assert.equal(nextTurn.raw.corrections.length, 1); assert.equal(nextTurn.raw.facts, '鹿丸已离开木叶');
  console.log('PASS next-turn local summaries and consolidation cannot revive invalidated paraphrases; correction rules and raw fact survive');
  await page.evaluate(async () => {
    document.querySelectorAll('game-modal').forEach(modal => modal.close());
    await import('/js/ui/memory-panel.js');
    const raw = stateManager.getSub('_memory');
    stateManager.setSub('_memory', { ...raw, facts: [raw.facts, ...Array.from({ length: 35 }, (_, i) => `测试记忆 ${i + 1}：你在木叶训练场学习体术。`), '<img src=x onerror=alert(1)>'].join('\n') });
    const host = document.createElement('div');
    host.id = 'memory-qa';
    host.innerHTML = '<memory-facts-editor></memory-facts-editor>';
    document.body.replaceChildren(host);
  });
  await page.addStyleTag({ content: 'body{margin:0;background:#111820;color:#e7e0d5;font-family:system-ui}#memory-qa{max-width:840px;margin:auto;padding:18px}button{color:inherit;background:#283340;border:1px solid #586373;border-radius:5px;padding:6px 10px;cursor:pointer}input,select,textarea{background:#1b2733!important;color:inherit}h3{font-size:22px}' });
  const editor = page.locator('memory-facts-editor');
  assert.equal(await editor.locator('.mf-card').count(), 20);
  await editor.getByRole('button', { name: '下一页', exact: true }).click();
  assert.ok(await editor.locator('.mf-card').count() > 0);
  await editor.getByRole('searchbox').fill('测试记忆 1：');
  assert.equal(await editor.locator('.mf-card').count(), 1);
  await editor.getByRole('button', { name: '修改', exact: true }).click();
  await editor.getByRole('textbox', { name: '纠正内容' }).fill('测试记忆 1：你在木叶图书馆学习忍术。');
  await editor.getByRole('button', { name: '保存纠正', exact: true }).click();
  await editor.locator('.mf-text').filter({ hasText: '木叶图书馆' }).waitFor();
  assert.match(await page.evaluate(async () => (await timelineSystem.getCurrentNode()).state_snapshot._memory.corrections.at(-1).replacement), /木叶图书馆/);
  await editor.getByRole('button', { name: '否定', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('memory-facts-editor')._busy === false);
  assert.equal(await editor.locator('.mf-card').count(), 0);
  await editor.locator('summary').click();
  await editor.getByRole('button', { name: '撤销此修订', exact: true }).first().click();
  await editor.locator('.mf-text').filter({ hasText: '木叶图书馆' }).waitFor();
  await editor.getByRole('searchbox').fill('');
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await editor.locator('.mf-card img').count(), 0);
  const output = path.join(root, 'reports', 'memory-corrections');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'memory-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(output, 'memory-desktop.png'), fullPage: true });
  console.log('PASS real editor search/pagination/edit/reject/undo writes checkpoints and fits a 360px viewport safely');
  console.log('7 memory correction integration regressions passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
