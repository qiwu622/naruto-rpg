import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.MULTIPLAYER_UI_SCREENSHOT_DIR || path.join(root, 'reports/multiplayer-redesign-20261004'));

// The fixture uses the real overlay, components and projection store. Only the
// server controller is substituted, so no production accounts or models run.
async function installFixture() {
  const { openMultiplayerOverlay } = await import('/js/ui/multiplayer-overlay.js');
  const { MultiplayerRoomStore } = await import('/js/multiplayer/room-store.js');
  await import('/js/ui/multiplayer-character-panel.js');
  const store = new MultiplayerRoomStore();
  const calls = [];
  const copies = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => copies.push(value) } });
  const opening = {
    start_time: { year: 52, month: 4, day: 12, phase: 'DUSK' },
    display_name: '日向凛', rank: '中忍', affiliation: '木叶隐村', location: '木叶村东门',
    background: '日向分家出身的年轻忍者，擅长白眼侦察与近身柔拳。刚结束边境轮值，正在适应新的搭档。',
    goal: '找到失踪的信使，护送边境情报回村。',
    opening_hook: '黄昏时，东门守卫递来一枚折断的木叶护额；同行的奈良陆认出了上面留下的暗号。'
  };
  const profile = {
    profile_id: 'visual-profile', config_revision: 1, adapter: 'openai_compatible', model: 'deepseek-flash',
    endpoint: { normalized_origin: 'https://api.deepseek.com', normalized_base_url: 'https://api.deepseek.com' },
    credential_ref: { credential_id: 'visual-credential', credential_revision: 1 }, capabilities: {}
  };
  const binding = { binding_revision: 1, profile_revision: 1, adapter: profile.adapter, model: profile.model, configured: true };
  const policy = () => ({
    policy: 'A_ONLY', policy_revision: 1, accepted_by: { A: true, B: true }, viewer_accepted: true,
    fully_accepted: true, bindings_ready: true, ready: true, bindings: { A: binding, B: null },
    current_turn_payer_seat: 'A', current_turn_id: null, current_turn_no: null
  });
  const room = () => ({
    room_id: 'visual-room', room_code: 'R-KONO-HA52-TEAM', viewer_seat: 'A', lifecycle: 'LOBBY',
    origin_type: 'new_multiplayer_save', active_epoch_id: null, current_turn_id: null,
    control_revision: 1, state_revision: 0, active_narrative_mode: 'shared', queued_narrative_mode: null,
    members: [{ seat: 'A', status: 'ACTIVE', ready_at: null }, { seat: 'B', status: 'ACTIVE', ready_at: null }],
    credential_policy: policy(), narrative_preset: { source_seat: 'A', bindings: { A: { name: '沉浸式忍界叙事' }, B: { name: '电影感双人冒险' } } },
    opening: { schema: 'naruto.multiplayer-room-opening/v1', blocking: false, ready: false, conflicts: [], drafts: {
      A: { seat: 'A', revision: 1, commitment: 'sha256:' + 'a'.repeat(64), confirmed: false, draft: { ...opening } },
      B: { seat: 'B', revision: 1, commitment: 'sha256:' + 'b'.repeat(64), confirmed: false, draft: { ...opening, display_name: '奈良陆', background: '冷静细致的奈良一族忍者，习惯先观察局势，再给出简洁的行动建议。' } }
    } }
  });
  const patchRoom = updates => store.patch({ room: { ...store.state.room, ...updates } });
  const lobby = () => store.patch({
    roomId: 'visual-room', room: room(), turn: null,
    connection: { status: 'open', lastEventSeq: 12 }, modelProfiles: [{ profile, status: 'ACTIVE' }],
    lineage: { origin_type: 'new_multiplayer_save', checkpoints: [], epochs: [], source_imports: [] },
    chat: { messages: [], nextBefore: null }
  });
  const generation = paused => {
    const now = Date.now();
    store.setConnection({ status: 'open', lastEventSeq: 38 });
    store.setTurn({ ...store.state.turn, status: paused ? 'REPAIR_PAUSED' : 'REPAIRING_DRAFT', generation: {
      model_stage: 'continuity_repair', run_status: paused ? 'PAUSED' : 'RUNNING', attempt: 2,
      started_at: new Date(now - 74000).toISOString(), updated_at: new Date(now).toISOString(), heartbeat_at: new Date(now).toISOString(),
      reason: paused ? 'LOOP_BREAKER' : null, error_code: paused ? 'AUDIENCE_VIOLATION' : null,
      failure_kind: paused ? 'memory' : null, repair_attempts: paused ? 8 : null, remaining_items: paused ? 2 : null,
      resume_stage: paused ? 'repair_turn_bundle' : null
    } });
  };
  const active = () => {
    lobby();
    store.patch({
      room: { ...store.state.room, lifecycle: 'ACTIVE', active_epoch_id: 'visual-epoch', current_turn_id: 'visual-turn', state_revision: 3,
        credential_policy: { ...policy(), current_turn_id: 'visual-turn', current_turn_no: 3 } },
      turnContext: { epochId: 'visual-epoch', epochNo: 1, turnId: 'visual-turn', turnNo: 3 },
      turn: { turn_id: 'visual-turn', turn_no: 3, turn_kind: 'ACTION', viewer_seat: 'A', status: 'ONE_ACTION_LOCKED',
        active_narrative_mode: 'shared', actions: { A: { seat: 'A', locked: false }, B: { seat: 'B', locked: true } } }
    });
  };
  const controller = {
    store, get state() { return store.state; }, subscribe: callback => store.subscribe(callback), disconnect() {},
    async createNewMultiplayerRoom() { calls.push('create'); lobby(); return { room: store.state.room }; },
    async joinRoom() { calls.push('join'); lobby(); return { room: store.state.room }; },
    async connectRoom() { calls.push('connect'); lobby(); return { room: store.state.room }; },
    async refreshRoom() {}, async refreshLineage() {}, async refreshTurn() { calls.push('refresh'); },
    async saveOpening(draft) {
      calls.push('save-opening');
      const prior = store.state.room.opening;
      patchRoom({ opening: { ...prior, drafts: { ...prior.drafts, A: { ...prior.drafts.A, draft, revision: prior.drafts.A.revision + 1 } } } });
      return { opening: store.state.room.opening };
    },
    async markReady() { calls.push('ready'); },
    async changeNarrativeMode(mode) { patchRoom({ active_narrative_mode: mode }); },
    async changeNarrativePreset(seat) { patchRoom({ narrative_preset: { ...store.state.room.narrative_preset, source_seat: seat } }); },
    async syncNarrativePreset() { calls.push('preset'); },
    async chooseCredentialUsagePolicy(next) { calls.push('policy'); patchRoom({ credential_policy: { ...policy(), policy: next } }); },
    async bindRoomModelProfile() { calls.push('bind'); },
    async retryTurn() { calls.push('retry'); generation(false); },
    async sendChat(text) {
      calls.push('chat'); store.appendChatMessage({ message_id: 'visual-chat-' + calls.length, sender_seat: 'A', text,
        created_at: '2026-10-04T12:00:00.000Z', event_seq: 50 + calls.length });
    }
  };
  const handle = openMultiplayerOverlay({ host: document.getElementById('overlay-host') });
  handle.panel.controller = controller;
  const character = document.querySelector('multiplayer-character-panel');
  const showCharacter = () => {
    active();
    const projection = { schema: 'naruto.multiplayer-member-state-projection/v1', viewer_seat: 'A', state_revision: 3,
      shared_world: { calendar: { display_date: '木叶52年4月12日', phase: 'DUSK' },
        world_state: { locations: [{ entity_id: 'actor:A', location_id: 'east-gate' }] }, map: { markers: [{ location_id: 'east-gate', label: '木叶村东门' }] },
        shared_missions: { entries: [{ mission_id: 'missing-courier', title: '失踪的边境信使', status: 'ACTIVE', progress_current: 1, progress_total: 4 }] } },
      actors: { A: { room_actor_id: 'actor:A', player: { display_name: '日向凛', rank: '中忍', status: 'ACTIVE', goal: opening.goal },
        progression: { level: 12 }, attributes: { resources: [
          { resource_id: 'chakra', current: 284, maximum: 360 }, { resource_id: 'mental', current: 86, maximum: 100 },
          { resource_id: 'stamina', current: 73, maximum: 100 }, { resource_id: 'vitality', current: 92, maximum: 100 },
          { resource_id: 'money', current: 2400, maximum: 1000000 }
        ] }, skills: { entries: [{ display_name: '八卦六十四掌', category: 'TAIJUTSU', rank: 'B', mastery: 72 }] },
        equipment: { entries: [{ display_name: '精制查克拉短刀', category: 'EQUIPMENT', quantity: 1, equipped_slot: '右手' }] },
        missions: { entries: [] }, private_knowledge: { facts: [{ kind: '任务线索', summary: '护额上留有沿河前往北部哨所的暗号。' }] } } },
      relationships: [{ data: { target_display_name: '奈良陆', label: '可靠队友', score: 42 } }] };
    character.setSessionState({ ...store.state, latestCommittedTurn: { status: 'COMMITTED', commit: { state: projection } } });
    handle.minimize();
    document.querySelector('#character-stage').hidden = false;
  };
  window.visualFixture = { store, handle, calls, copies, lobby, active, generation, showCharacter };
  window.fixtureReady = true;
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>联机面板视觉回归</title><link rel="stylesheet" href="/css/tokens.css">
<style>html{background:#0d1015;color:#eee;font-family:system-ui,sans-serif}body{margin:0}*{box-sizing:border-box}
#game-backdrop{min-height:100dvh;padding:48px 6vw;background:radial-gradient(ellipse at 75% 18%,#38302555,transparent 60%)}
#game-backdrop h1{font-size:22px;color:#d2b188}#game-backdrop p{color:#848891;font-size:14px;line-height:1.8}
#chat-input-area{position:fixed;bottom:20px;left:15%;width:70%}.input-wrapper{display:flex;gap:10px;background:#141920;padding:12px;border:1px solid #514735;border-radius:14px}
#chat-input{min-width:0;flex:1;padding:12px;background:#0f1318;border:1px solid #393b42;color:white;border-radius:8px}#btn-send{border:0;background:#b59062;padding:0 20px;border-radius:8px;color:#151311}
#character-stage{position:fixed;inset:20px 20px 20px auto;width:min(370px,calc(100vw - 40px));height:calc(100dvh - 40px)}[hidden]{display:none!important}
</style></head><body><main id="game-backdrop"><h1>忍界手记</h1><p>暮色落在木叶的街巷，新的旅程即将开始。</p></main>
<div id="chat-input-area"><div class="input-wrapper"><input id="chat-input" aria-label="本回合行动" placeholder="写下你的行动…"><button id="btn-send">结印</button></div></div>
<aside id="character-stage" hidden><multiplayer-character-panel></multiplayer-character-panel></aside><div id="overlay-host"></div>
<script type="module" src="/visual-fixture.js"></script></body></html>`;

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    if (url.pathname === '/visual-fixture.js') return response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(`(${installFixture.toString()})().catch(error => { window.fixtureError = error.stack; throw error; });`);
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) || !/\.(?:js|css|json|png|webp|jpg|svg|woff2?)$/u.test(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream' }).end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});

const report = { generatedAt: new Date().toISOString(), scope: 'Local real-component UI; deterministic controller; no live model or deployment', checks: [], screenshots: [], pageErrors: [] };
await mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let currentPage;
const check = async (name, operation) => {
  try { const detail = await operation(); report.checks.push({ name, passed: true, ...(detail ? { detail } : {}) }); console.log(`PASS ${name}`); }
  catch (error) {
    report.checks.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`);
    if (currentPage && !currentPage.isClosed()) await capture(currentPage, `failure-${report.checks.length}.png`).catch(() => {});
  }
};
const capture = async (target, filename) => {
  await target.screenshot({ path: path.join(output, filename), animations: 'disabled' });
  report.screenshots.push(filename);
};
const noOverflow = async page => {
  const metrics = await page.evaluate(() => {
    const overlay = document.querySelector('[data-multiplayer-overlay]');
    const panel = document.querySelector('naruto-multiplayer-panel');
    const measured = [document.documentElement, overlay, panel, ...panel.shadowRoot.querySelectorAll('.panel,.setup-grid,.opening-grid,.turn-settings-grid,.ai-settings-grid,.active-session,.active-body,.compact-toolbar,.active-chat-form')];
    return measured.filter(node => node.getClientRects().length && node.clientWidth > 0).map(node => ({
      name: node.id || node.className || node.tagName, width: node.clientWidth, scroll: node.scrollWidth,
      x: node.getBoundingClientRect().x, right: node.getBoundingClientRect().right, viewport: innerWidth
    }));
  });
  const offenders = metrics.filter(item => item.scroll > item.width + 1 || item.x < -1 || item.right > item.viewport + 1);
  assert.deepEqual(offenders, [], 'visible panel containers must fit their real width: ' + JSON.stringify(offenders));
  return metrics;
};

try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 }, isMobile: width < 500, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await context.newPage();
    currentPage = page;
    page.on('pageerror', error => report.pageErrors.push({ width, message: error.message }));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
    assert.equal(await page.evaluate(() => window.fixtureError), undefined);
    await page.evaluate(() => document.fonts.ready);
    const panel = page.locator('naruto-multiplayer-panel');
    await check(`${width}: setup fits and create/join remain usable`, async () => {
      await noOverflow(page);
      assert.equal(await panel.locator('#create-room-form').isVisible(), true);
      assert.equal(await panel.locator('#join-room-form').isVisible(), true);
      await capture(page, `setup-${width}.png`);
      await panel.locator('#join-room-id').focus();
      await page.keyboard.press('Tab');
      assert.equal(await panel.evaluate(el => el.shadowRoot.activeElement?.id), 'join-token', 'Tab must move from room code to password');
      await panel.locator('#join-room-id').fill('R-KONO-HA52-TEAM');
      await panel.locator('#join-token').fill('fixture-only');
      await panel.locator('#join-room-form button[type="submit"]').click();
      await page.waitForFunction(() => window.visualFixture.calls.includes('join'));
      assert.equal(await panel.locator('#join-token').inputValue(), '', 'join secrets are cleared after success');
    });
    await page.evaluate(() => window.visualFixture.lobby());
    await check(`${width}: room opening aligns and saves own draft`, async () => {
      await page.locator('[data-multiplayer-overlay]').evaluate(el => { el.scrollTop = 0; });
      await capture(page, `room-overview-${width}.png`);
      assert.equal(await panel.locator('#opening-workspace').isVisible(), true);
      await noOverflow(page);
      await capture(panel.locator('#opening-workspace'), `opening-${width}.png`);
      const mine = panel.locator('[data-opening-seat="A"]');
      assert.equal(await panel.locator('[data-opening-seat="B"] .opening-save').isHidden(), true);
      await mine.locator('[data-opening-field="goal"]').fill('沿河寻找失踪的信使，保护同行的队友。');
      await mine.locator('.opening-save').click();
      await page.waitForFunction(() => window.visualFixture.calls.includes('save-opening'));
      assert.match(await mine.locator('[data-opening-field="goal"]').inputValue(), /保护同行/u);
    });
    await check(`${width}: AI controls align and remain keyboard operable`, async () => {
      await panel.locator('#edit-ai-settings').click();
      assert.equal(await panel.locator('#ai-settings-editor').isVisible(), true);
      await noOverflow(page);
      await capture(panel.locator('.ai-settings-card'), `ai-settings-${width}.png`);
      const alternate = panel.locator('[data-credential-policy="ALTERNATE"]');
      await alternate.focus(); await page.keyboard.press('Enter');
      assert.equal(await alternate.getAttribute('aria-checked'), 'true');
    });
    await check(`${width}: chat submits with Enter and preserves text`, async () => {
      await panel.locator('.tabs [data-tab="chat"]').click();
      const message = '我先观察北侧。<b>这里是原样聊天文本</b>';
      await panel.locator('#chat-text').fill(message);
      await panel.locator('#chat-text').press('Enter');
      await page.waitForFunction(() => window.visualFixture.calls.includes('chat'));
      assert.match(await panel.locator('#chat-messages').innerText(), /<b>这里是原样聊天文本<\/b>/u);
      assert.equal(await panel.locator('#chat-messages b').count(), 0, 'chat markup is not interpreted');
      await noOverflow(page);
      await capture(panel.locator('[data-view="chat"]'), `chat-${width}.png`);
    });
    await page.evaluate(() => { window.visualFixture.active(); window.visualFixture.generation(true); window.visualFixture.handle.panel.showFullSession(); });
    await panel.locator('.tabs [data-tab="turn"]').click();
    await check(`${width}: paused generation exposes an actionable retry`, async () => {
      assert.equal(await panel.locator('#turn-generation').getAttribute('data-tone'), 'error');
      assert.equal(await panel.locator('#retry-turn').isVisible(), true);
      assert.equal(await panel.locator('#retry-turn').isEnabled(), true);
      await noOverflow(page);
      await capture(panel.locator('#turn-generation'), `generation-paused-${width}.png`);
      await panel.locator('#retry-turn').focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.visualFixture.calls.includes('retry'));
      assert.equal(await panel.locator('#turn-generation').getAttribute('data-tone'), 'running');
      assert.equal(await panel.locator('#retry-turn').isHidden(), true);
    });
    await page.evaluate(() => { window.visualFixture.active(); window.visualFixture.handle.panel.showCompactSession(); window.visualFixture.handle.show(); });
    await check(`${width}: floating chat fits its container`, async () => {
      await panel.locator('#active-chat-toggle').click();
      assert.equal(await panel.evaluate(el => el.shadowRoot.activeElement?.id), 'active-chat-text');
      await panel.locator('#active-chat-text').fill('已就位，等你信号。');
      await panel.locator('#active-chat-text').press('Enter');
      await noOverflow(page);
      await capture(page.locator('[data-multiplayer-overlay]'), `floating-${width}.png`);
    });
    if (width === 1440) {
      await check('desktop: keyboard-resized 280px float fits and still sends chat', async () => {
        await page.locator('[data-multiplayer-resize]').focus();
        report.resizeSamples = [];
        for (let index = 0; index < 30; index++) {
          await page.keyboard.press('ArrowLeft');
          report.resizeSamples.push(await page.evaluate(() => ({
            width: document.querySelector('[data-multiplayer-overlay]').getBoundingClientRect().width,
            focus: document.activeElement?.getAttribute('aria-label'),
            phase: document.querySelector('naruto-multiplayer-panel').dataset.sessionPhase,
            presentation: document.querySelector('[data-multiplayer-overlay]').dataset.presentation
          })));
        }
        const rect = await page.locator('[data-multiplayer-overlay]').boundingBox();
        assert.ok(rect.width >= 279 && rect.width <= 281, `expected 280px, got ${rect.width}`);
        await noOverflow(page);
        await panel.locator('#active-chat-text').fill('窄窗口仍可发送');
        await panel.locator('#active-chat-text').press('Enter');
        assert.match(await panel.locator('#active-chat-messages').innerText(), /窄窗口仍可发送/u);
        await capture(page.locator('[data-multiplayer-overlay]'), 'floating-desktop-280.png');
      });
      await check('desktop: keyboard drag and minimize preserve usable focus', async () => {
        const drag = page.locator('[data-multiplayer-drag]');
        const before = await page.locator('[data-multiplayer-overlay]').boundingBox();
        await drag.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowUp');
        const after = await page.locator('[data-multiplayer-overlay]').boundingBox();
        assert.ok(after.x <= before.x - 19 && after.y <= before.y - 19);
        await page.keyboard.press('Escape');
        assert.equal(await panel.isVisible(), false);
        await page.getByRole('button', { name: '展开联机状态悬浮窗' }).click();
        assert.equal(await panel.isVisible(), true);
        await page.locator('#chat-input').focus();
        await page.keyboard.type('查看信使留下的痕迹');
        assert.equal(await page.locator('#chat-input').evaluate(input => document.activeElement === input), true);
      });
    }
    await check(`${width}: character tabs fit and expose committed data`, async () => {
      await page.evaluate(() => window.visualFixture.showCharacter());
      const character = page.locator('multiplayer-character-panel');
      await capture(character, `character-${width}.png`);
      const fit = await character.evaluate(el => ({ host: el.clientWidth, scroll: el.scrollWidth, body: el.shadowRoot.querySelector('.content').scrollWidth, inner: el.shadowRoot.querySelector('.content').clientWidth }));
      assert.ok(fit.scroll <= fit.host + 1 && fit.body <= fit.inner + 1, JSON.stringify(fit));
      for (const [tab, text] of [['skills', '八卦六十四掌'], ['equipment', '精制查克拉短刀'], ['missions', '失踪的边境信使'], ['relations', '奈良陆']]) {
        await character.locator(`[data-tab="${tab}"]`).click();
        assert.ok((await character.locator('.content').innerText()).includes(text));
      }
    });
    await context.close();
  }
  await check('all viewports: no uncaught browser exceptions', () => assert.deepEqual(report.pageErrors, []));
} catch (error) {
  report.fatalError = error.stack || error.message;
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  report.passed = !report.fatalError && report.checks.length > 0 && report.checks.every(item => item.passed) && report.pageErrors.length === 0;
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
}
if (!report.passed) process.exitCode = 1;
console.log(`Multiplayer visual regression: ${report.checks.filter(item => item.passed).length}/${report.checks.length} passed. Evidence: ${output}`);
