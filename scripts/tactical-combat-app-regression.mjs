import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reports = path.join(root, 'reports', 'tactical-combat');
await mkdir(reports, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/components.css"><main id="app" class="standalone-mode is-mobile-view"></main></html>');
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('outside');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'text/css' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) console.error(message.text()); });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    localStorage.setItem('naruto_api_config', JSON.stringify({ backend: 'tavern', model: 'fixture', disableStreaming: true, aiCallPolicy: { strictSingleCall: true } }));
    localStorage.setItem('naruto_agent_config', JSON.stringify({ enabled: false, mode: 'off' }));
    localStorage.setItem('naruto_memory_config', JSON.stringify({ recallEnabled: false }));
    const { stateManager } = await import('/js/core/state-manager.js');
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { combatSystem } = await import('/js/systems/combat-system.js');
    const { memorySystem } = await import('/js/systems/memory-system.js');
    const { aiClient } = await import('/js/core/ai-client.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    const { MessagePipeline } = await import('/js/core/pipeline.js');
    const { SHINOBI_DAILY_EXAMPLE } = await import('/js/core/shinobi-daily.js');
    const { NarutoRPGApp } = await import('/js/app.js');
    const { appShell } = await import('/js/ui/app-shell.js');
    Object.assign(window, { stateManager, timelineSystem, combatSystem, eventBus, appShell, calls: 0, submitted: [] });
    window.generateRaw = async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 30));
      return '训练场里，两人完成这一轮交锋，彼此重新拉开距离。'
        + '<state_update>{"changed":false}</state_update>'
        + '<memory>{"summary":"本回合训练结束，双方等待下一步。","facts":[],"clues":[],"pins":[],"npc_notes":{}}</memory>'
        + `<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`;
    };
    aiClient.configure({ backend: 'tavern', model: 'fixture' });
    appShell.init(document.querySelector('#app'));
    window.app = new NarutoRPGApp();
    app.pipeline = new MessagePipeline({ combatSystem, memorySystem, timelineSystem });
    app._bindEvents();
    await timelineSystem.init();
    const state = stateManager.getDefaultState();
    Object.assign(state, {
      '玩家·姓名': '望月', '玩家·存活': '是', '玩家·忍阶': '下忍', '世界·地点': '训练场', '系统·回合数': 1,
      '属性·生命力': 1200, '属性·当前生命力': 1200, '属性·查克拉': 120, '属性·当前查克拉': 120,
      '属性·体力': 200, '属性·当前体力': 200, '属性·精神力': 100, '属性·当前精神力': 100, '属性·速度': 50,
      '技能·忍术·测试火球·等级': 'C', '技能·忍术·测试火球·威力': 34, '技能·忍术·测试火球·消耗': 15,
      '技能·忍术·测试火球·熟练度': 60, '技能·忍术·测试火球·属性': '火'
    });
    state._ui.settings.tacticalCombat = true;
    state._relationships = { 训练对手: { combatant: true, combat_stats: { 忍阶: '下忍', 生命力: 1500, 生命力上限: 1500, 查克拉: 100, 查克拉上限: 100, 体力: 200, 体力上限: 200, 精神力: 100, 精神力上限: 100, 速度: 30, 忍术: [] } } };
    state._combat = combatSystem.createCombatState({ enemy_name: '训练对手', objective: '切磋' }, state);
    stateManager.restore(state);
    window.rootNode = await timelineSystem.createRootNode({ summary: '训练对手立在面前。', stateSnapshot: stateManager.snapshot(), chatHistory: [] });
    appShell.renderSinglePage('训练对手立在面前。');
    const handleInput = app._handleUserInput.bind(app);
    app._handleUserInput = (text, accept) => { submitted.push(text); return handleInput(text, accept); };
  });
  const arena = page.locator('combat-arena');
  const input = page.locator('#chat-input');
  const fire = '[data-move="skill:忍术:测试火球"]';
  if (await page.locator('#app-panel.panel-open').count()) await page.locator('#btn-panel').click();
  await arena.locator(fire).click();
  assert.match(await input.inputValue(), /测试火球/);
  await input.fill('我使用测试火球，借树干掩护从侧面出手。');
  await arena.locator('[data-submit]').click();
  await page.waitForFunction(() => !app.pipeline.isProcessing && calls === 1 && stateManager.getSub('_combat').last_round).catch(async error => {
    console.error(await page.evaluate(() => ({ calls, submitted, text: document.body.innerText.slice(-2000), processing: app.pipeline.isProcessing, combat: stateManager.getSub('_combat') })));
    throw error;
  });
  assert.equal(await page.evaluate(() => submitted.at(-1)), '我使用测试火球，借树干掩护从侧面出手。');
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.evaluate(() => stateManager.get('属性·当前查克拉')), 105);
  assert.equal(await arena.count(), 1);
  console.log('PASS real app card confirmation uses edited main draft, spends once and re-mounts the arena after prose');

  await arena.locator(fire).click();
  await input.fill('我不使用测试火球，而是使用戒备防御。');
  await arena.locator('[data-submit]').click();
  await page.waitForFunction(() => !app.pipeline.isProcessing && calls === 2);
  assert.equal(await page.evaluate(() => stateManager.get('属性·当前查克拉')), 105);
  assert.equal(await page.evaluate(() => stateManager.getSub('_combat').last_round.player_move.id), 'basic:guard');
  console.log('PASS negating an already selected card respects the newly written defense action');

  await input.fill('我使用测试火球。');
  await page.locator('#btn-send').click();
  await page.waitForFunction(() => !app.pipeline.isProcessing && calls === 3);
  const saved = await page.evaluate(async () => {
    const state = stateManager.snapshot();
    const id = state._meta.current_node_id;
    const node = await timelineSystem.getCurrentNode();
    const persisted = node.state_snapshot;
    const history = await timelineSystem._reconstructChatHistory(node);
    await timelineSystem.jumpToNode(rootNode.id);
    await timelineSystem.jumpToNode(id);
    app.pipeline.setHistory(history);
    appShell.renderSinglePage(node.clean_response, { timelineNodeId: id });
    return { id, cp: persisted['属性·当前查克拉'], restoredCp: stateManager.get('属性·当前查克拉'),
      action: persisted._combat.last_round.action_id, restoredAction: stateManager.getSub('_combat').last_round.action_id,
      historyLength: history.length, count: (await timelineSystem.getAllNodes()).length };
  });
  assert.equal(saved.cp, 90); assert.equal(saved.restoredCp, 90);
  assert.equal(saved.action, saved.restoredAction); assert.equal(saved.historyLength, 6); assert.equal(saved.count, 4);
  assert.equal(await arena.count(), 1);
  console.log('PASS three real application turns persisted in IndexedDB and restored from history with the same combat result');
  await arena.screenshot({ path: path.join(reports, 'battle-in-app-mobile.png') });
  let expectedCalls = 3;
  for (const id of ['basic:guard', 'basic:observe', 'basic:retreat']) {
    await arena.locator(`.tactics [data-move="${id}"]`).click();
    await arena.locator('[data-submit]').click();
    expectedCalls++;
    await page.waitForFunction(expected => !app.pipeline.isProcessing && calls === expected, expectedCalls);
    assert.equal(await page.evaluate(() => stateManager.getSub('_combat').last_round.player_move.id), id);
    assert.equal(await page.evaluate(() => stateManager.get('属性·当前查克拉')), 90);
  }
  assert.deepEqual(errors, []);
  console.log('PASS defense, observe and retreat cards each execute their actual tactic instead of falling back to improvise');
  console.log('Tactical app regression: 4 passed (mock model, no paid requests).');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
