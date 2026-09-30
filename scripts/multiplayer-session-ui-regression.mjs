import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captureDirectory = process.env.MULTIPLAYER_UI_SCREENSHOT_DIR || '';

const openingA = {
  start_time: { year: 48, month: 3, day: 8, phase: 'DAWN' },
  display_name: '日向凛', rank: '下忍', affiliation: '木叶隐村',
  background: '日向分家出身。', location: '木叶训练场',
  goal: '完成第一次护送任务。', opening_hook: '在集合点等待队友。'
};
const openingBConflict = {
  start_time: { year: 48, month: 3, day: 9, phase: 'DAY' },
  display_name: '奈良陆', rank: '下忍', affiliation: '木叶隐村',
  background: '奈良一族的年轻忍者。', location: '木叶村口',
  goal: '确保委托人安全抵达。', opening_hook: '带着任务卷轴赶到村口。'
};

const browserEntry = `
  import { NarutoMultiplayerPanel } from '/js/multiplayer/multiplayer-panel.js';
  import { MultiplayerRoomStore } from '/js/multiplayer/room-store.js';

  const openingA = ${JSON.stringify(openingA)};
  const openingBConflict = ${JSON.stringify(openingBConflict)};
  const openingProjection = ({ blocking = true, aConfirmed = false, bConfirmed = false, aRevision = 1 } = {}) => ({
    schema: 'naruto.multiplayer-room-opening/v1',
    blocking,
    ready: !blocking && aConfirmed && bConfirmed,
    conflicts: blocking
      ? [{ code: 'START_TIME_MISMATCH', severity: 'blocking', message: '双方开局时间必须完全一致。' }]
      : [{ code: 'SPLIT_LOCATION', severity: 'info', message: '双方地点不同，将按分线开场处理。' }],
    drafts: {
      A: { seat: 'A', revision: aRevision, commitment: 'sha256:' + 'a'.repeat(64), confirmed: aConfirmed, draft: openingA },
      B: {
        seat: 'B', revision: 1, commitment: 'sha256:' + 'b'.repeat(64), confirmed: bConfirmed,
        draft: { ...openingBConflict, start_time: blocking ? openingBConflict.start_time : openingA.start_time }
      }
    }
  });
  const credentialPolicy = ({ ready = true, currentTurnId = null, currentTurnNo = null } = {}) => ({
    policy: 'A_ONLY',
    policy_revision: 1,
    accepted_by: { A: true, B: true },
    viewer_accepted: true,
    fully_accepted: true,
    bindings_ready: true,
    ready,
    bindings: {
      A: {
        binding_revision: 1,
        profile_revision: 1,
        adapter: 'openai_compatible',
        model: 'opening-ui-model',
        configured: ready
      },
      B: null
    },
    current_turn_payer_seat: currentTurnNo ? 'A' : null,
    current_turn_id: currentTurnId,
    current_turn_no: currentTurnNo
  });

  const store = new MultiplayerRoomStore();
  const calls = [];
  const copies = [];
  const exitRequests = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async value => { copies.push(value); } }
  });
  const roomBase = {
    room_id: 'room_session_demo', room_code: 'KONOHA-DEMO', viewer_seat: 'A', lifecycle: 'LOBBY',
    origin_type: 'new_multiplayer_save', active_epoch_id: null, current_turn_id: null,
    state_revision: 0, control_revision: 1, active_narrative_mode: 'shared', queued_narrative_mode: null,
    members: [{ seat: 'A', status: 'ACTIVE', joined_at: '2026-08-24T01:00:00.000Z', ready_at: null }],
    opening: openingProjection(),
    credential_policy: credentialPolicy()
  };
  store.patch({
    roomId: roomBase.room_id,
    room: roomBase,
    invite: {
      room_id: roomBase.room_id,
      room_code: roomBase.room_code,
      token: 'team secret'
    },
    connection: { status: 'open', lastEventSeq: 1 },
    lineage: { origin_type: 'new_multiplayer_save', checkpoints: [], epochs: [], source_imports: [] },
    turn: null,
    notices: [],
    chat: { messages: [], nextBefore: null }
  });

  const patchRoom = changes => store.patch({ room: { ...store.state.room, ...changes } });
  const controller = {
    store,
    get state() { return store.state; },
    subscribe(listener) { return store.subscribe(listener); },
    disconnect() {},
    async refreshRoom() {}, async refreshLineage() {}, async refreshTurn() {},
    async saveOpening(draft) {
      calls.push({ type: 'save-opening', draft });
      openingA.start_time = { ...draft.start_time };
      openingA.display_name = draft.display_name;
      patchRoom({
        control_revision: store.state.room.control_revision + 1,
        opening: openingProjection({ blocking: false, aRevision: 2 })
      });
      return { opening: store.state.room.opening };
    },
    async markReady() {
      calls.push({ type: 'ready' });
      patchRoom({
        control_revision: store.state.room.control_revision + 1,
        members: store.state.room.members.map(member => member.seat === 'A'
          ? { ...member, ready_at: '2026-08-24T01:04:00.000Z' }
          : member),
        opening: openingProjection({ blocking: false, aConfirmed: true, aRevision: 2 })
      });
      return { all_ready: false };
    },
    async changeNarrativeMode(mode) {
      calls.push({ type: 'mode', mode });
      patchRoom({
        control_revision: store.state.room.control_revision + 1,
        active_narrative_mode: mode,
        queued_narrative_mode: null
      });
      return { disposition: 'changed', mode };
    },
    async retryTurn() {
      calls.push({ type: 'retry' });
      window.__generation('REPAIRING_DRAFT');
    },
    async sendChat(text) {
      calls.push({ type: 'chat', text });
      store.appendChatMessage({
        message_id: 'message_own_' + calls.length,
        sender_seat: 'A', text, created_at: '2026-08-24T01:10:00.000Z', event_seq: 20 + calls.length
      });
    }
  };

  const panel = new NarutoMultiplayerPanel();
  panel.controller = controller;
  panel.addEventListener('multiplayer-exit-request', event => exitRequests.push(event.detail));
  document.querySelector('main').append(panel);

  window.__panel = panel;
  window.__calls = calls;
  window.__copies = copies;
  window.__exitRequests = exitRequests;
  window.__guestJoined = () => {
    patchRoom({ members: [
      ...store.state.room.members,
      { seat: 'B', status: 'ACTIVE', joined_at: '2026-08-24T01:02:00.000Z', ready_at: null }
    ] });
    store.patch({ notices: [{
      event_seq: 2, event_type: 'member.presence_changed',
      payload: { member_seat: 'B', member_status: 'ACTIVE', lifecycle: 'LOBBY' }
    }] });
  };
  window.__guestReady = () => {
    patchRoom({
      members: store.state.room.members.map(member => member.seat === 'B'
        ? { ...member, ready_at: '2026-08-24T01:05:00.000Z' }
        : member),
      opening: openingProjection({ blocking: false, aConfirmed: true, bConfirmed: true, aRevision: 2 })
    });
    store.patch({ notices: [...store.state.notices, {
      event_seq: 3, event_type: 'member.presence_changed',
      payload: { member_seat: 'B', ready: true, lifecycle: 'READY' }
    }] });
  };
  window.__awaitingPayerSelection = () => {
    store.patch({
      room: {
        ...store.state.room,
        lifecycle: 'ACTIVE', active_epoch_id: 'epoch_demo', current_turn_id: 'turn_demo',
        opening: openingProjection({ blocking: false, aConfirmed: true, bConfirmed: true, aRevision: 2 }),
        credential_policy: credentialPolicy({
          ready: false,
          currentTurnId: 'turn_demo',
          currentTurnNo: 1
        })
      },
      turnContext: { epochId: 'epoch_demo', epochNo: 1, turnId: 'turn_demo', turnNo: 1 },
      turn: {
        turn_id: 'turn_demo', turn_no: 1, viewer_seat: 'A', status: 'AWAITING_PAYER_SELECTION',
        turn_kind: 'OPENING',
        active_narrative_mode: 'shared',
        actions: { A: { seat: 'A', locked: false }, B: { seat: 'B', locked: false } }
      },
      progress: {
        status: 'AWAITING_PAYER_SELECTION',
        label: '等待本回合 API 付款与配置选择',
        detail: null,
        resumeStage: null
      }
    });
  };
  window.__activate = () => {
    store.patch({
      room: {
        ...store.state.room,
        lifecycle: 'ACTIVE', active_epoch_id: 'epoch_demo', current_turn_id: 'turn_demo_2',
        state_revision: 1,
        opening: openingProjection({ blocking: false, aConfirmed: true, bConfirmed: true, aRevision: 2 }),
        credential_policy: credentialPolicy({ currentTurnId: 'turn_demo_2', currentTurnNo: 2 })
      },
      turnContext: { epochId: 'epoch_demo', epochNo: 1, turnId: 'turn_demo_2', turnNo: 2 },
      turn: {
        turn_id: 'turn_demo_2', turn_no: 2, viewer_seat: 'A', status: 'ONE_ACTION_LOCKED',
        turn_kind: 'ACTION',
        active_narrative_mode: 'shared',
        actions: { A: { seat: 'A', locked: false }, B: { seat: 'B', locked: true } }
      },
      progress: { status: 'ONE_ACTION_LOCKED', label: '一方已发送行动', detail: null, resumeStage: null }
    });
    panel.showCompactSession();
  };
  window.__revealAction = () => store.setTurn({
    ...store.state.turn,
    actions: {
      ...store.state.turn.actions,
      B: { seat: 'B', locked: true, text: '绕到驿站后方观察可疑脚印。', disclosure: 'open_pre_resolution' }
    }
  });
  window.__failTurn = () => {
    store.setTurn({ ...store.state.turn, status: 'RETRYABLE_FAILED' });
    store.patch({
      progress: {
        status: 'RETRYABLE_FAILED',
        label: '回合执行失败，可从有效阶段重试',
        detail: '模型连接暂时不可用',
        resumeStage: 'resolution'
      }
    });
  };
  window.__generation = status => {
    const paused = status === 'REPAIR_PAUSED';
    const now = Date.now();
    store.setConnection({ status: 'open' });
    store.setTurn({ ...store.state.turn, turn_kind: 'OPENING', status,
      generation: { model_stage: 'continuity_repair', run_status: paused ? 'PAUSED' : 'RUNNING',
        attempt: 7, started_at: new Date(now - 80000).toISOString(),
        updated_at: new Date(now).toISOString(), heartbeat_at: new Date(now).toISOString(),
        reason: paused ? 'LOOP_BREAKER' : null, error_code: paused ? 'AUDIENCE_VIOLATION' : null,
        failure_kind: paused ? 'memory' : null, repair_attempts: paused ? 8 : null,
        remaining_items: paused ? 2 : null, resume_stage: paused ? 'repair_turn_bundle' : null }
    });
  };
  window.__disconnectProgress = () => store.setConnection({ status: 'reconnecting' });
  window.__message = (id, seat = 'B', text = '我已检查北侧入口。') => store.appendChatMessage({
    message_id: id, sender_seat: seat, text,
    created_at: '2026-08-24T01:12:00.000Z', event_seq: 30 + Number(id.replace(/\\D/g, '') || 0)
  });
  window.__ready = true;
`;

const mimeTypes = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
});

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': mimeTypes['.html'], 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/css/tokens.css">
        <style>html{background:#08090b;color:#f5f5f7}body{margin:0;padding:20px;font-family:system-ui,sans-serif}main{max-width:1460px;margin:auto}</style>
        </head><body><main></main><script type="module" src="/harness.js"></script></body></html>`);
      return;
    }
    if (url.pathname === '/harness.js') {
      response.writeHead(200, { 'Content-Type': mimeTypes['.js'], 'Cache-Control': 'no-store' });
      response.end(browserEntry);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(projectRoot, relative);
    if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error));
  await page.goto(origin);
  await page.waitForFunction(() => window.__ready === true);
  const panel = page.locator('naruto-multiplayer-panel');

  assert.equal(await panel.locator('#opening-workspace').isVisible(), true);
  assert.match(await panel.locator('#opening-ready-summary').textContent(), /有冲突待处理/u);
  assert.match(await panel.locator('#opening-conflicts').textContent(), /时间必须完全一致/u);
  assert.equal(await panel.locator('[data-opening-seat="A"] [data-opening-field="display_name"]').isEnabled(), true);
  assert.equal(await panel.locator('[data-opening-seat="B"] [data-opening-field="display_name"]').isDisabled(), true);
  assert.equal(await panel.locator('[data-opening-seat="B"] .opening-save').isHidden(), true);
  assert.match(await panel.locator('#member-list').textContent(), /玩家 B · 等待加入/u);
  assert.equal(await panel.locator('#ready-room').isDisabled(), true);
  assert.equal(await panel.locator('#invite-box').isVisible(), true);
  assert.equal(await panel.locator('#invite-room-code').textContent(), 'KONOHA-DEMO');
  assert.equal(await panel.locator('#invite-code').textContent(), 'team secret');
  assert.match(await panel.locator('#invite-expiry').textContent(), /可重复使用/u);

  await panel.locator('#copy-room-code').click();
  await page.waitForFunction(() => window.__copies.length === 1);
  assert.equal(await page.evaluate(() => window.__copies.at(-1)), 'KONOHA-DEMO');

  await panel.locator('#copy-invite-code').click();
  await page.waitForFunction(() => window.__copies.length === 2);
  assert.equal(await page.evaluate(() => window.__copies.at(-1)), 'team secret');

  await panel.locator('#copy-room-invite').click();
  await page.waitForFunction(() => window.__copies.length === 3);
  assert.equal(
    await page.evaluate(() => window.__copies.at(-1)),
    '房间号：KONOHA-DEMO\n房间密码：team secret'
  );
  await panel.locator('#exit-room').click();
  assert.deepEqual(await page.evaluate(() => window.__exitRequests), [{ roomId: 'room_session_demo' }]);

  await page.evaluate(() => window.__guestJoined());
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#member-alert').textContent.includes('玩家 B 已加入房间'));
  assert.equal(await panel.locator('#member-alert').isVisible(), true);
  assert.match(await panel.locator('#member-list').textContent(), /玩家 B · 已加入，待确认/u);
  assert.equal(await panel.locator('#invite-box').isHidden(), true);

  await panel.locator('#mode-dual').click();
  await page.waitForFunction(() => window.__calls.some(call => call.type === 'mode' && call.mode === 'dual_pov'));
  assert.match(await panel.locator('#mode-note').textContent(), /当前 dual_pov/u);
  await panel.locator('#mode-shared').click();
  await page.waitForFunction(() => window.__calls.some(call => call.type === 'mode' && call.mode === 'shared'));
  assert.match(await panel.locator('#mode-note').textContent(), /当前 shared/u);

  const ownForm = panel.locator('[data-opening-seat="A"]');
  await panel.locator('#opening-day').fill('9');
  await panel.locator('#opening-phase').selectOption('DAY');
  await ownForm.locator('.opening-save').click();
  await page.waitForFunction(() => window.__calls.some(call => call.type === 'save-opening'));
  assert.match(await panel.locator('#opening-ready-summary').textContent(), /已确认 0\/2/u);
  assert.match(await panel.locator('#opening-conflicts').textContent(), /分线开场/u);
  assert.equal(await panel.locator('#ready-room').isEnabled(), true);
  assert.match(await panel.locator('#ready-room').textContent(), /确认开局并生成第一回合/u);

  await panel.locator('#ready-room').click();
  await page.waitForFunction(() => window.__calls.some(call => call.type === 'ready'));
  assert.match(await panel.locator('[data-opening-seat="A"] [data-opening-status]').textContent(), /已确认/u);
  assert.match(await panel.locator('#ready-room').textContent(), /已确认，等待对方/u);
  assert.equal(await panel.locator('#ready-room').isDisabled(), true);

  await page.evaluate(() => window.__guestReady());
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#member-alert').textContent.includes('双方均已确认'));
  assert.match(await panel.locator('#opening-ready-summary').textContent(), /已确认 2\/2/u);

  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    await panel.locator('#opening-workspace').screenshot({ path: path.join(captureDirectory, 'multiplayer-opening-desktop.png') });
  }

  await page.evaluate(() => window.__awaitingPayerSelection());
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel').dataset.sessionPhase === 'active');
  assert.equal(await panel.locator('#action-form').count(), 0);
  assert.equal(await panel.getAttribute('data-active-layout'), 'full');
  assert.equal(await panel.locator('#room-workspace').isVisible(), true);
  assert.equal(await panel.locator('#active-session').isHidden(), true);
  assert.equal(await panel.locator('#ai-settings-editor').isVisible(), true);
  assert.match(await panel.locator('#active-progress').textContent(), /联机 AI 设置尚未完成/u);

  await page.evaluate(() => window.__activate());
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel').dataset.sessionPhase === 'active');
  assert.equal(await panel.locator('#active-session').isVisible(), true);
  assert.equal(await panel.locator('#room-workspace').isHidden(), true);
  assert.match(await panel.locator('#active-other-action').textContent(), /已发送（具体行动已隐藏）/u);
  assert.match(await panel.locator('#active-progress').textContent(), /对方已发送/u);
  assert.equal(await panel.locator('#active-action-visibility').isEnabled(), true);
  await panel.locator('#active-exit-room').click();
  assert.equal(await page.evaluate(() => window.__exitRequests.length), 2);

  await page.evaluate(() => window.__revealAction());
  assert.match(await panel.locator('#active-other-action').textContent(), /绕到驿站后方观察可疑脚印/u);

  await panel.locator('#active-chat-toggle').click();
  await panel.locator('#active-chat-text').fill('我从北侧入口开始检查。');
  await panel.locator('#active-chat-text').press('Enter');
  await page.waitForFunction(() => window.__calls.some(call => (
    call.type === 'chat' && call.text === '我从北侧入口开始检查。'
  )));
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#active-chat-text').value === '');
  assert.match(await panel.locator('#active-chat-messages').textContent(), /我从北侧入口开始检查/u);
  assert.equal(await panel.locator('#active-chat-unread').isHidden(), true);
  await panel.locator('#active-chat-toggle').click();

  await page.evaluate(() => window.__message('message_1'));
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#active-chat-unread').textContent === '1');
  assert.equal(await panel.locator('#active-chat-unread').isVisible(), true);
  if (captureDirectory) {
    await panel.locator('#active-session').screenshot({
      path: path.join(captureDirectory, 'multiplayer-active-unread.png')
    });
  }
  await panel.locator('#active-chat-toggle').click();
  assert.equal(await panel.locator('#active-chat').isVisible(), true);
  assert.equal(await panel.locator('#active-chat-unread').isHidden(), true);
  assert.match(await panel.locator('#active-chat-messages').textContent(), /我已检查北侧入口/u);
  if (captureDirectory) {
    await panel.locator('#active-session').screenshot({
      path: path.join(captureDirectory, 'multiplayer-active-chat.png')
    });
  }
  const compactChatFit = await panel.evaluate(element => {
    element.style.width = '410px';
    const host = element.getBoundingClientRect();
    const active = element.shadowRoot.querySelector('#active-session').getBoundingClientRect();
    const form = element.shadowRoot.querySelector('#active-chat-form').getBoundingClientRect();
    return {
      hostOverflow: element.scrollWidth > element.clientWidth,
      activeWithinHost: active.left >= host.left - 1 && active.right <= host.right + 1,
      formWithinActive: form.left >= active.left - 1 && form.right <= active.right + 1
    };
  });
  assert.deepEqual(compactChatFit, {
    hostOverflow: false,
    activeWithinHost: true,
    formWithinActive: true
  });
  if (captureDirectory) {
    await panel.locator('#active-session').screenshot({
      path: path.join(captureDirectory, 'multiplayer-active-chat-compact.png')
    });
  }
  await panel.evaluate(element => { element.style.width = ''; });

  await page.evaluate(() => window.__message('message_2', 'B', '南侧暂时安全。'));
  assert.equal(await panel.locator('#active-chat-unread').isHidden(), true);
  await panel.locator('#active-chat-toggle').click();
  await page.evaluate(() => window.__message('message_3', 'B', '发现新的脚印。'));
  await page.evaluate(() => window.__message('message_4', 'A', '我马上过去。'));
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#active-chat-unread').textContent === '1');
  assert.equal(await panel.locator('#active-chat-unread').textContent(), '1');

  await panel.locator('#show-full-session').click();
  assert.equal(await panel.locator('#room-workspace').isVisible(), true);
  assert.equal(await panel.locator('#active-session').isHidden(), true);
  assert.equal(await panel.locator('#chat-unread-badge').textContent(), '1');
  await panel.locator('.tabs [data-tab="chat"]').click();
  assert.equal(await panel.locator('#chat-unread-badge').isHidden(), true);
  assert.match(await panel.locator('#chat-messages').textContent(), /发现新的脚印/u);
  await panel.locator('.tabs [data-tab="turn"]').click();
  assert.equal(await panel.locator('#turn-recovery').isHidden(), true);
  assert.equal(await panel.locator('#room-tools').getAttribute('open'), null);
  await panel.locator('#room-tools > summary').click();
  assert.equal(await panel.locator('#room-tools').getAttribute('open'), '');
  assert.equal(await panel.locator('#propose-archive').isVisible(), true);
  await panel.locator('#room-tools > summary').click();
  assert.equal(await panel.locator('#room-tools').getAttribute('open'), null);

  await page.evaluate(() => window.__failTurn());
  await page.waitForFunction(() => !document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#turn-recovery').hidden);
  assert.equal(await panel.locator('#turn-recovery').isVisible(), true);
  assert.equal(await panel.locator('#retry-turn').isEnabled(), true);

  await page.evaluate(() => window.__generation('REPAIR_PAUSED'));
  assert.equal(await panel.locator('#turn-generation').getAttribute('data-tone'), 'error');
  assert.match(await panel.locator('#turn-progress').textContent(), /开场生成已暂停/u);
  assert.match(await panel.locator('#turn-progress-detail').textContent(), /正文已生成.*记忆/u);
  assert.equal(await panel.locator('#member-alert').isHidden(), true);
  assert.equal(await panel.locator('#ready-room').isHidden(), true);
  await panel.locator('#turn-copy-diagnostics').click();
  assert.match(await page.evaluate(() => window.__copies.at(-1)), /AUDIENCE_VIOLATION/u);
  if (captureDirectory) await panel.locator('#room-workspace').screenshot({
    path: path.join(captureDirectory, 'multiplayer-paused-full.png')
  });
  const callCount = await page.evaluate(() => window.__calls.length);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.__calls.length), callCount, 'elapsed display must not initiate gameplay or retries');
  await panel.locator('#retry-turn').click();
  await page.waitForFunction(() => window.__calls.some(call => call.type === 'retry'));
  assert.equal(await panel.locator('#turn-generation').getAttribute('data-tone'), 'running');
  assert.equal(await panel.locator('#retry-turn').isHidden(), true);
  assert.doesNotMatch(await panel.locator('#turn-generation-diagnostics').textContent(), /AUDIENCE_VIOLATION/u);
  if (captureDirectory) await panel.locator('#turn-generation').screenshot({
    path: path.join(captureDirectory, 'multiplayer-generating.png')
  });
  await page.evaluate(() => window.__disconnectProgress());
  assert.equal(await panel.locator('#turn-generation').getAttribute('data-tone'), 'warning');
  assert.match(await panel.locator('#turn-progress').textContent(), /状态待确认/u);
  await page.evaluate(() => window.__generation('REPAIR_PAUSED'));

  const compactFit = await panel.evaluate(element => {
    element.style.width = '410px';
    element.showCompactSession();
    const host = element.getBoundingClientRect();
    const compact = element.shadowRoot.querySelector('#active-session').getBoundingClientRect();
    return {
      hostOverflow: element.scrollWidth > element.clientWidth,
      compactWithinHost: compact.left >= host.left - 1 && compact.right <= host.right + 1,
      compactWidth: Math.round(compact.width)
    };
  });
  assert.equal(compactFit.hostOverflow, false);
  assert.equal(compactFit.compactWithinHost, true);
  assert.ok(compactFit.compactWidth >= 320 && compactFit.compactWidth <= 430);
  assert.equal(await panel.locator('#active-retry-turn').isVisible(), true);
  assert.match(await panel.locator('#active-generation-title').textContent(), /已暂停/u);

  if (captureDirectory) {
    await panel.locator('#active-session').screenshot({ path: path.join(captureDirectory, 'multiplayer-active-float.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.evaluate(element => { element.style.width = '100%'; });
    assert.equal(await panel.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await panel.locator('#active-session').screenshot({ path: path.join(captureDirectory, 'multiplayer-paused-mobile.png') });
  }

  await context.close();
  assert.deepEqual(pageErrors, []);
  console.log('multiplayer opening, compact action and chat unread browser regression passed');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
