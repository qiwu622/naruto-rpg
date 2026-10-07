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
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>战斗面板交互检查</title><style>body{margin:0;padding:24px;background:#090c11;color:#eee;font-family:system-ui}main{max-width:860px;margin:auto}textarea{box-sizing:border-box;display:block;width:100%;min-height:90px;padding:12px;background:#161b23;color:#ddd;border:1px solid #706246;border-radius:8px}@media(max-width:600px){body{padding:12px}}</style><main><combat-arena></combat-arena><label for="action">正文行动</label><textarea id="action"></textarea></main></html>');
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('outside');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'text/css' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const errors = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    const { listTacticalMoves } = await import('/js/systems/tactical-combat.js');
    Object.assign(window, { stateManager, eventBus, listTacticalMoves, selectedEvents: [], submittedEvents: [] });
    const data = stateManager.getDefaultState();
    Object.assign(data, {
      '玩家·姓名': '望月', '玩家·忍阶': '下忍',
      '属性·生命力': 180, '属性·当前生命力': 126, '属性·查克拉': 120, '属性·当前查克拉': 87,
      '属性·体力': 140, '属性·当前体力': 102, '属性·精神力': 100, '属性·当前精神力': 81,
      '技能·忍术·火遁·炎弹·名称': '火遁·炎弹', '技能·忍术·火遁·炎弹·等级': 'C', '技能·忍术·火遁·炎弹·消耗': 20, '技能·忍术·火遁·炎弹·威力': 34, '技能·忍术·火遁·炎弹·属性': '火', '技能·忍术·火遁·炎弹·熟练度': 68,
      '技能·体术·木叶旋风·名称': '木叶旋风', '技能·体术·木叶旋风·消耗': 15, '技能·体术·木叶旋风·威力': 28,
      '技能·支援·替身术·名称': '替身术', '技能·支援·替身术·消耗': 8,
      '技能·忍术·分身术·名称': '分身术', '技能·忍术·分身术·消耗': 12,
      '技能·幻术·奈落见·名称': '奈落见', '技能·幻术·奈落见·消耗': 16, '技能·幻术·奈落见·威力': 20,
      '物品·消耗品·兵粮丸·数量': 2, '物品·道具·烟雾弹·数量': 1
    });
    data._combat = { id: 'ui-battle', is_active: true, state: 'player_turn', turn: 3, enemy_name: '雾中追兵', enemy_rank: '中忍', enemy_intel: 'unknown', enemy_vitality: 167, enemy_vitality_max: 220, enemy_chakra: 69, enemy_chakra_max: 100, enemy_stamina: 76, enemy_stamina_max: 140, enemy_spirit: 62, enemy_spirit_max: 80, distance: '中', objective: '保护队友撤离', environment: { terrain: '林间小径', weather: '薄雾' }, player_statuses: [{ id: 'observe', name: '洞察', turns: 2 }], enemy_statuses: [{ id: 'burn', name: '灼伤', turns: 2 }], last_round: { turn: 2, events: [{ actor: 'player', message: '火遁命中，追兵退向树后。' }, { actor: 'enemy', message: '对手掷出苦无，望月借树干格挡。' }] } };
    data._meta.current_node_id = 'ui-current-1';
    await stateManager.dbPut('timeline_meta', { key: 'root', value: { root_id: 'ui-profile-1', current_id: 'ui-current-1' } });
    stateManager.restore(data);
    eventBus.on('combat:select-action', event => { selectedEvents.push(event); document.querySelector('#action').value = event.message; });
    eventBus.on('combat:submit-action', event => submittedEvents.push(event));
    await import('/js/ui/combat-arena.js');
  });
  const arena = page.locator('combat-arena');
  await arena.locator('.move').first().waitFor();
  await page.waitForFunction(() => document.querySelector('combat-arena')._shortcutKey === 'naruto_tactical_shortcuts:v1:ui-profile-1');
  assert.equal(await arena.locator('.move').count(), 4);
  assert.equal(await arena.locator('.enemy .resource-text strong').allTextContents().then(values => values.every(value => value === '未探明')), true);
  const before = await page.evaluate(() => JSON.stringify(stateManager.snapshot()));
  await arena.locator('[data-move="skill:忍术:火遁·炎弹"]').click();
  assert.equal(await page.evaluate(() => JSON.stringify(stateManager.snapshot())), before);
  assert.match(await page.locator('#action').inputValue(), /火遁·炎弹/);
  assert.match(await arena.locator('.selection').innerText(), /灼伤 20%/);
  assert.match(await arena.locator('.selection').innerText(), /尚未探明/);
  await arena.locator('[data-submit]').click();
  assert.equal(await page.evaluate(() => submittedEvents.length), 1);
  assert.equal(await page.evaluate(() => JSON.stringify(stateManager.snapshot())), before);
  const sceneImage = await arena.evaluate(async el => {
    const background = [...el.shadowRoot.querySelectorAll('*')].map(node => getComputedStyle(node).backgroundImage)
      .find(value => value.includes('moonlit-training-ground.png'));
    const url = background?.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
    if (!url) return null;
    const illustration = new Image(); illustration.src = url;
    await illustration.decode();
    return { url, width: illustration.naturalWidth, height: illustration.naturalHeight };
  });
  assert.ok(sceneImage?.width > 1000 && sceneImage.height > 300, 'the actual original scene asset must load, not just a gradient fallback');
  console.log('PASS four shortcuts, hidden enemy information, selection and submit emit intent without spending resources');
  await arena.screenshot({ path: path.join(reports, 'battle-desktop.png') });

  await arena.locator('[data-pin]').click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('naruto_tactical_shortcuts:v1:ui-profile-1')).length), 3);
  await arena.locator('[data-pin]').click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('naruto_tactical_shortcuts:v1:ui-profile-1')).length), 4);
  await arena.locator('[data-expand]').click();
  await arena.locator('[data-move="skill:支援:替身术"]').click();
  await arena.locator('[data-pin]').click();
  assert.equal(await arena.locator('[data-replace]').count(), 4);
  await arena.locator('[data-replace="1"]').click();
  const custom = await page.evaluate(() => JSON.parse(localStorage.getItem('naruto_tactical_shortcuts:v1:ui-profile-1')));
  assert.equal(custom[1], 'skill:支援:替身术');
  assert.equal(custom.length, 4);
  assert.equal(await page.evaluate(() => JSON.stringify(stateManager.snapshot())), before);
  await page.evaluate(() => { document.querySelector('combat-arena').remove(); document.querySelector('main').prepend(document.createElement('combat-arena')); });
  await page.waitForFunction(() => document.querySelector('combat-arena')._shortcutKey === 'naruto_tactical_shortcuts:v1:ui-profile-1');
  await page.waitForFunction(expected => JSON.stringify([...document.querySelector('combat-arena').shadowRoot.querySelectorAll('.move')].map(button => button.dataset.move)) === JSON.stringify(expected), custom);
  assert.deepEqual(await arena.locator('.move').evaluateAll(buttons => buttons.map(button => button.dataset.move)), custom);
  await page.evaluate(async () => {
    window.profileOne = stateManager.snapshot();
    const other = structuredClone(profileOne); other._meta.current_node_id = 'ui-current-2';
    await stateManager.dbPut('timeline_meta', { key: 'root', value: { root_id: 'ui-profile-2', current_id: 'ui-current-2' } });
    stateManager.restore(other);
  });
  await page.waitForFunction(() => document.querySelector('combat-arena')._shortcutKey === 'naruto_tactical_shortcuts:v1:ui-profile-2');
  await page.waitForFunction(previous => JSON.stringify([...document.querySelector('combat-arena').shadowRoot.querySelectorAll('.move')].map(button => button.dataset.move)) !== JSON.stringify(previous), custom);
  assert.notDeepEqual(await arena.locator('.move').evaluateAll(buttons => buttons.map(button => button.dataset.move)), custom);
  await page.evaluate(async () => {
    await stateManager.dbPut('timeline_meta', { key: 'root', value: { root_id: 'ui-profile-1', current_id: 'ui-current-1' } });
    stateManager.restore(profileOne);
  });
  await page.waitForFunction(() => document.querySelector('combat-arena')._shortcutKey === 'naruto_tactical_shortcuts:v1:ui-profile-1');
  await page.waitForFunction(expected => JSON.stringify([...document.querySelector('combat-arena').shadowRoot.querySelectorAll('.move')].map(button => button.dataset.move)) === JSON.stringify(expected), custom);
  assert.deepEqual(await arena.locator('.move').evaluateAll(buttons => buttons.map(button => button.dataset.move)), custom);
  await page.evaluate(() => {
    localStorage.setItem('naruto_tactical_shortcuts:v1:ui-profile-1', JSON.stringify(['skill:不存在', 'unknown:stale']));
    document.querySelector('combat-arena').remove(); document.querySelector('main').prepend(document.createElement('combat-arena'));
  });
  await page.waitForFunction(() => document.querySelector('combat-arena')._shortcutKey === 'naruto_tactical_shortcuts:v1:ui-profile-1');
  await page.waitForFunction(() => !localStorage.getItem('naruto_tactical_shortcuts:v1:ui-profile-1').includes('不存在'));
  assert.equal(await arena.locator('.move').count(), 4);
  assert.equal(await page.evaluate(() => localStorage.getItem('naruto_tactical_shortcuts:v1:ui-profile-1').includes('不存在')), false);
  console.log('PASS custom four-slot replacement, unpin, persisted remount, same-name archive isolation and stale-ID fallback without state mutation');

  await arena.locator('[data-expand]').click();
  await arena.locator('[data-filter="忍具"]').click();
  assert.equal(await arena.locator('.move').count(), 2);
  await arena.locator('[data-filter="全部"]').click();
  const move = arena.locator('[data-move="skill:忍术:火遁·炎弹"]');
  await move.focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => stateManager.update([{ key: '属性·当前查克拉', op: '=', value: 3 }]));
  await page.waitForFunction(() => document.querySelector('combat-arena').shadowRoot.querySelector('.selection').textContent.includes('查克拉不足'));
  assert.equal(await arena.locator('[data-submit]').isEnabled(), true);
  assert.equal(await page.evaluate(() => document.querySelector('combat-arena').shadowRoot.activeElement?.dataset.move), 'skill:忍术:火遁·炎弹');
  console.log('PASS skill categories, keyboard selection, reactive resource warning and focus preservation; shortage stays a soft outcome');

  await page.evaluate(() => eventBus.emit('pipeline:processing', {}));
  await page.waitForFunction(() => document.querySelector('combat-arena').shadowRoot.querySelector('[data-submit]').disabled);
  assert.match(await arena.locator('.phase').innerText(), /正在演绎/);
  for (const [phase, label] of [['resolving', '正在判定招式'], ['narrating', '正在描写本回合'], ['settled', '已结算并保存']]) {
    await page.evaluate(phase => eventBus.emit('combat:phase', { phase }), phase);
    await page.waitForFunction(label => document.querySelector('combat-arena').shadowRoot.querySelector('.phase').textContent.includes(label), label);
    assert.equal(await arena.locator('[data-submit]').isDisabled(), true);
    assert.equal(await arena.locator('[data-pin]').isDisabled(), true);
  }
  await page.evaluate(() => eventBus.emit('pipeline:error', { error: 'fixture' }));
  await page.waitForFunction(() => !document.querySelector('combat-arena').shadowRoot.querySelector('[data-submit]').disabled);
  assert.match(await arena.locator('.phase').innerText(), /需要重试/);
  await page.evaluate(() => { eventBus.emit('pipeline:complete', {}); const combat = stateManager.getSub('_combat'); stateManager.setSub('_combat', { ...combat, enemy_intel: 'known' }); });
  await page.waitForFunction(() => document.querySelector('combat-arena').shadowRoot.querySelector('.enemy .resource-text strong').textContent !== '未探明');
  await arena.locator('[data-clear]').click();
  assert.equal(await page.evaluate(() => selectedEvents.at(-1).moveId), null);
  console.log('PASS resolving/narrating/settled phases stay locked until pipeline finishes, error recovery, known enemy display and clearing');

  await page.setViewportSize({ width: 360, height: 800 });
  await arena.locator('[data-expand]').click();
  await move.click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const layout = await arena.evaluate(el => {
    const root = el.shadowRoot;
    const player = root.querySelector('.fighter:not(.enemy)').getBoundingClientRect();
    const enemy = root.querySelector('.fighter.enemy').getBoundingClientRect();
    return { overflow: root.querySelector('.scene').scrollWidth > el.clientWidth + 1, buttons: [...root.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width < 43.9 || button.getBoundingClientRect().height < 43.9).map(button => button.textContent.trim()), paired: Math.abs(player.top - enemy.top) < 2 && enemy.left >= player.right, transition: getComputedStyle(root.querySelector('.bar i')).transitionDuration };
  });
  assert.equal(layout.overflow, false); assert.deepEqual(layout.buttons, []); assert.equal(layout.paired, true); assert.equal(layout.transition, '0s');
  await arena.screenshot({ path: path.join(reports, 'battle-mobile.png') });
  console.log('PASS 360px layout, all 44px controls, compact paired fighters, reduced motion and screenshot');

  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await arena.evaluate(el => el.shadowRoot.querySelector('.scene').scrollWidth > el.clientWidth + 1), false, `${width}px overflow`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('main').evaluate(el => { el.style.width = '340px'; });
  const narrowContainer = await arena.evaluate(el => {
    const root = el.shadowRoot;
    const tooSmall = [...root.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width < 43.9 || button.getBoundingClientRect().height < 43.9);
    return { overflow: root.querySelector('.scene').scrollWidth > el.clientWidth + 1, smallButtons: tooSmall.map(button => button.textContent.trim()) };
  });
  assert.equal(narrowContainer.overflow, false); assert.deepEqual(narrowContainer.smallButtons, []);
  await arena.screenshot({ path: path.join(reports, 'battle-narrow-column.png') });
  await page.locator('main').evaluate(el => { el.style.width = ''; });
  await page.setViewportSize({ width: 360, height: 800 });
  console.log('PASS 320/390/768/1024px and a 340px desktop chat column keep controls usable without horizontal overflow');

  await page.evaluate(() => {
    const combat = stateManager.getSub('_combat');
    stateManager.setSub('_combat', { ...combat, is_active: false, result: 'victory', enemy_name: '<img src=x onerror="window.pwned=1">', last_round: { turn: 3, events: [{ actor: 'player', message: '<script>window.pwned=1</script>队友已成功撤离。' }] } });
  });
  await arena.locator('.finished-note').waitFor();
  assert.equal(await arena.locator('[data-submit]').count(), 0);
  assert.match(await arena.locator('.report').innerText(), /队友已成功撤离/);
  assert.equal(await arena.locator('script,img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await arena.screenshot({ path: path.join(reports, 'battle-finished-mobile.png') });
  console.log('PASS final report remains visible, ended combat has no spending controls, all model text escaped');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
