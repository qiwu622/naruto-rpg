// Explicit paid test only: isolated room/database, two actual browser contexts.
// Pipe an authorized Flash key on stdin. Never include this in npm test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import express from 'express';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';
import { createMultiplayerRuntime } from '../server/multiplayer/application/runtime.js';
import { createProviderModelClient } from '../server/multiplayer/agent/provider-adapters.js';
import { MULTIPLAYER_HTTP_MOUNT_PATH, createRepositoryBackedMultiplayerHttpRouter } from '../server/multiplayer/http/index.js';
import { createOpeningDraft } from '../js/systems/opening-draft.js';
import { multiplayerOpeningDraft } from '../js/multiplayer/opening-draft-bridge.js';
import { DEFAULT_MAIN_PRESET, DEFAULT_MAIN_PRESET_VERSION } from '../js/data/default-preset.js';
import { readTokenUsage } from '../js/core/deepseek-mode.js';
import { config } from '../server/config.js';
import { getProxyAgent } from '../server/api/ai-proxy.js';

if (!process.argv.includes('--live')) { console.log('Paid opt-in: --live, key from stdin.'); process.exit(0); }
const key = readFileSync(0, 'utf8').trim();
assert.match(key, /^sk-[A-Za-z0-9_-]+$/);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'reports/multiplayer-live');
await fs.mkdir(output, { recursive: true });
const reportPath = path.join(output, 'playthrough.json');
const budgetPath = path.join(output, 'budget.json');
const redact = value => JSON.stringify(value, null, 2).replaceAll(key, '[redacted]');
const round = n => Number(n.toFixed(8));
const prior = JSON.parse(await fs.readFile(path.join(root, 'reports/deepseek-mode/live-budget.json'), 'utf8'));
const priorCost = prior.requests.reduce((sum, row) => sum + (row.estimatedPeakCny ?? row.worstCny), 0);
let budget;
try { budget = JSON.parse(await fs.readFile(budgetPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
budget ||= { priorPeakCny: round(priorCost), capCny: 2.8, requests: [] };
const costSoFar = () => round(budget.priorPeakCny + budget.requests.reduce((sum, row) => sum + (row.actualPeakCny ?? row.worstCny), 0));
const report = { model: 'deepseek-flash', startedAt: new Date().toISOString(), calls: [], rounds: [], browserErrors: [], ok: false };
const save = async () => {
  report.cumulativePeakCny = costSoFar();
  await fs.writeFile(reportPath, redact(report));
  await fs.writeFile(budgetPath, redact(budget));
};
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'naruto-multiplayer-play-'));
let runtime, modelClient, server, browser;
const pages = {};
const presets = {};
let roomId;
let stage = 'setup';
const deadline = AbortSignal.timeout(18 * 60_000);
const entry = `
import { appShell } from '/js/ui/app-shell.js';
import { stateManager } from '/js/core/state-manager.js';
import { eventBus } from '/js/core/event-bus.js';
import { authClient } from '/js/core/auth-client.js';
import { MultiplayerApiClient } from '/js/multiplayer/api-client.js';
import { MultiplayerSessionController } from '/js/multiplayer/session-controller.js';
import { openMultiplayerOverlay } from '/js/ui/multiplayer-overlay.js';
import { localRoomHistory } from '/js/multiplayer/local-room-history.js';
import { projectedNarrativeDeliveries } from '/js/multiplayer/ui-projection.js';
const preset = await fetch('/test-preset').then(response => response.json());
localStorage.setItem('naruto_main_preset', JSON.stringify(preset));
await stateManager.initDB();
stateManager.state = stateManager.getDefaultState();
await authClient.checkAuth(true);
appShell.init(document.querySelector('#app'));
appShell.showGame();
const controller = new MultiplayerSessionController({ apiClient: new MultiplayerApiClient({ requestHeaders: () => ({}) }) });
let publicationId;
const overlay = openMultiplayerOverlay({ onStateChange: state => {
  appShell.setMultiplayerSessionState(state);
  const turn = state?.latestCommittedTurn ?? state?.turn;
  const commitId = turn?.commit?.checkpoint?.commit_id ?? turn?.commit?.checkpoint?.checkpoint_id;
  if (commitId && projectedNarrativeDeliveries(turn).length && commitId !== publicationId) {
    publicationId = commitId;
    appShell.renderMultiplayerPublication(turn);
    appShell.setMultiplayerSessionState(state);
  }
}});
overlay.panel.controller = controller;
eventBus.on('user:submit', async ({ text, accept }) => {
  await controller.lockAction({ text, ...overlay.panel.actionOptions });
  accept?.(); appShell.setMultiplayerSessionState(controller.state); return true;
});
Object.assign(window, { controller, overlay, localRoomHistory, appShell });
await controller.connectRoom(new URL(location.href).searchParams.get('room'));
window.playReady = true;
`;

try {
  runtime = await createMultiplayerRuntime({ databasePath: path.join(temp, 'room.sqlite'), keyVersion: 'v1',
    ...Object.fromEntries(['contentMasterKey', 'credentialMasterKey', 'credentialFingerprintKey', 'actionCommitmentSecret', 'lineageSigningSecret', 'proposalCommitmentSecret'].map(name => [name, randomBytes(32).toString('base64')]))
  }, { openConnection: openMultiplayerRepositoryTestSqlite, startResolutionWorker: false,
    modelHttpGatewayOptions: { forward_proxy_agent: getProxyAgent('https:', config.proxy), allow_fake_ip_dns: config.proxy.allowFakeIpDns },
    providerModelClient: { async invoke(request) {
      const prompt = request.prompt ? JSON.parse(request.prompt) : null;
      stage = prompt?.stage ?? (
        request.system_prompt?.includes('唯一事实裁判') ? 'referee_repair'
          : request.system_prompt?.includes('小说作者') ? 'writer_repair'
            : request.system_prompt?.includes('连续性结算员') ? 'continuity_steward'
              : stage
      );
      const call = { stage, start: new Date().toISOString(), prompt };
      report.calls.push(call);
      try {
        const result = await modelClient.invoke({ ...request, signal: AbortSignal.any([deadline, ...(request.signal ? [request.signal] : [])]) });
        call.response = result.response;
        if (!prompt) call.repairFeedback = result.request_body.messages?.filter(message => message.role === 'user').at(-1)?.content;
        call.options = { thinking: result.request_body.thinking, max_tokens: result.request_body.max_tokens };
        console.log(JSON.stringify({ stage, finish: result.response.finish_reason, chars: result.response.raw_text?.length, usage: result.response.usage }));
        await save(); return result;
      } catch (error) { call.error = { code: error.code, message: error.message, details: error.details, cause: error.cause?.message }; await save(); throw error; }
    } }
  });
  modelClient = createProviderModelClient({
    resolveProfile: binding => runtime.repositories.billing.modelBindings.resolveProfile(binding),
    resolveCredential: binding => runtime.repositories.billing.modelBindings.resolveCredential(binding),
    credentialVault: runtime.credentialVault,
    modelHttpGateway: { async invoke(request) {
      assert.equal(request.profile.model, 'deepseek-flash');
      assert.equal(request.profile.endpoint.normalized_origin, 'https://api.deepseek.com');
      const body = request.body;
      assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens <= 16384);
      assert.ok(budget.requests.length < 80, 'Paid request cap reached');
      const inputUpper = Buffer.byteLength(JSON.stringify(body)) + 4096 + body.messages.length * 128;
      const worstCny = round((inputUpper * 2 + body.max_tokens * 8) / 1e6);
      assert.ok(costSoFar() + worstCny < budget.capCny, 'Cumulative paid budget cap reached');
      const row = { stage, start: new Date().toISOString(), inputUpper, maxOutput: body.max_tokens, worstCny };
      budget.requests.push(row); await save();
      console.log(`CALL ${budget.requests.length}/80 ${stage}; total reserved/settled CNY ${costSoFar()}`);
      const response = await runtime.modelHttpGateway.invoke(request);
      const usage = readTokenUsage(response.body.usage);
      if (usage.input !== null && usage.output !== null && usage.cacheKnown) {
        const actual = round((usage.hit * .04 + usage.miss * 2 + usage.output * 8) / 1e6);
        assert.ok(actual <= worstCny, 'Usage exceeded conservative reservation');
        row.usage = usage; row.actualPeakCny = actual;
      }
      await save(); return response;
    } }
  });
  const app = express();
  app.use((req, _res, next) => {
    const id = req.get('x-test-user');
    if (['play_A', 'play_B'].includes(id)) { req.user = { id, username: id }; req.authSource = 'bearer'; req.authExpiresAt = Infinity; }
    next();
  });
  app.get('/auth/me', (req, res) => req.user ? res.json(req.user) : res.sendStatus(401));
  app.get('/test-preset', (req, res) => res.json(presets[req.user?.id?.slice(-1)]));
  app.use(MULTIPLAYER_HTTP_MOUNT_PATH, createRepositoryBackedMultiplayerHttpRouter({
    core_repositories: runtime.repositories.core, billing_repository: runtime.repositories.billing,
    lineage_repository: runtime.repositories.lineage, application_services: runtime.services,
    event_hub: runtime.eventHub, room_event_stream_handler: runtime.sseHandler,
    chat_rate_limiter: runtime.chatRateLimiter,
    error_logger: error => { report.httpErrors ||= []; report.httpErrors.push({ code: error.code, message: error.message }); }
  }));
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/components.css"><style>body{margin:0;background:#121016;color:#eee}#app{min-height:100vh}</style><div id="app" class="standalone-mode"></div><script type="module" src="/live-entry.js"></script>'));
  app.get('/live-entry.js', (_req, res) => res.type('application/javascript').send(entry));
  for (const name of ['js', 'css', 'img', 'assets']) app.use(`/${name}`, express.static(path.join(root, name)));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(seat, method, route, body) {
    const res = await fetch(base + MULTIPLAYER_HTTP_MOUNT_PATH + route, { method, headers: { 'x-test-user': `play_${seat}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${route} HTTP ${res.status}: ${redact(data)}`);
    return data;
  }
  const created = await request('A', 'POST', '/rooms', { origin_type: 'new_multiplayer_save', default_narrative_mode: 'shared',
    new_world_profile: { era: '木叶48年', preset_id: 'preset:konoha', actor_a: { display_name: '清风', location: '木叶北门' }, actor_b: { display_name: '青叶', location: '木叶北门' } } });
  roomId = created.room.room_id;
  const route = `/rooms/${roomId}`;
  await request('B', 'POST', `${route}/join`, { token: created.invite.token });
  report.roomId = roomId;
  for (const [seat, name] of [['A', '清风'], ['B', '青叶']]) {
    let room = await request(seat, 'GET', route);
    const detailed = createOpeningDraft('chunin', {
      identity: { name, physicalAge: 21, soulAge: 21, background: '木叶情报班的成年忍者，奉命核对商道失踪的信件。', secrets: `${seat}的私密身份线索，仅本人知晓` },
      power: { attributes: { chakra: 321 } }, resources: { ryo: 1234 },
      equipment: [{ category: 'consumables', name: '饭团', quantity: 3, quality: '普通', description: '普通便携食物，不增加修为。', equippedSlot: '' }],
      campaign: { location: '木叶北门', openingHook: '一名名叫松田的驿站信使抱着带抓痕的空信筒，在雨后的门岗等候查问；值班中忍正在核对昨夜入村车队。', goal: '调查失踪信件', aiCompletionMode: 'strict' }
    });
    await request(seat, 'PUT', `${route}/opening`, { expected_revision: room.opening.drafts[seat].revision,
      draft: multiplayerOpeningDraft(detailed, { sharedTime: { year: 48, month: 1, day: 1, phase: 'DAWN' } }) });
    room = await request(seat, 'GET', route);
    presets[seat] = { ...DEFAULT_MAIN_PRESET, _version: DEFAULT_MAIN_PRESET_VERSION, name: `${seat} 的单人预设`, entries: [...DEFAULT_MAIN_PRESET.entries,
      { role: 'system', enabled: true, content: '使用第三人称，悬疑调查文风。每回合正文写 900 至 1200 字，正常推进可观察场景与 NPC 的反应，玩家进一步行动交由玩家决定。只写正文，不写审计、规则解释或防御性提示。' }] };
    await request(seat, 'PUT', `${route}/settings/narrative-preset`, { expected_control_revision: room.control_revision, preset: presets[seat] });
  }
  let room = await request('A', 'GET', route);
  await request('A', 'PUT', `${route}/settings/narrative-preset`, { expected_control_revision: room.control_revision, source_seat: 'B' });
  const { credential } = await request('A', 'POST', '/model-credentials', { endpoint_origin: 'https://api.deepseek.com', plaintext: key });
  const profile = await request('A', 'POST', '/model-endpoint-profiles', { adapter: 'openai_compatible', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-flash', auth_scheme: 'bearer',
    credential_ref: { credential_id: credential.credential_id, credential_revision: credential.credential_revision } });
  room = await request('A', 'GET', route);
  await request('A', 'PUT', `${route}/model-profile-binding`, { endpoint_profile_id: profile.profile.profile.profile_id, expected_binding_revision: 0, expected_control_revision: room.control_revision });
  for (const seat of ['A', 'B']) {
    room = await request(seat, 'GET', route);
    await request(seat, 'PUT', `${route}/settings/credential-policy`, { policy: 'A_ONLY', expected_policy_revision: room.credential_policy.policy_revision, expected_control_revision: room.control_revision });
  }
  browser = await chromium.launch({ headless: true });
  for (const seat of ['A', 'B']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { 'x-test-user': `play_${seat}` } });
    const page = await context.newPage(); pages[seat] = page;
    page.on('pageerror', error => report.browserErrors.push({ seat, message: error.message }));
    await page.goto(`${base}/?room=${roomId}`);
    await page.waitForFunction(() => window.playReady, { timeout: 20000 });
  }
  // Ready and actions use the real visible controls, not direct DB writes.
  for (const seat of ['A', 'B']) {
    await pages[seat].locator('naruto-multiplayer-panel #ready-room').click({ timeout: 8000 });
    await pages[seat].waitForFunction(s => controller.state.room?.opening?.drafts?.[s]?.confirmed || controller.state.lastError, seat);
    const error = await pages[seat].evaluate(() => controller.state.lastError);
    assert.equal(error, null, JSON.stringify(error));
  }
  await pages.B.waitForFunction(() => controller.state.room?.lifecycle === 'ACTIVE');

  async function playRound(turnNo, label) {
    const start = report.calls.length;
    console.log(`ROUND ${turnNo}: ${label}`);
    const worker = await runtime.resolutionWorker.runNext();
    const a = await request('A', 'GET', `${route}/epochs/1/turns/${turnNo}`);
    const b = await request('B', 'GET', `${route}/epochs/1/turns/${turnNo}`);
    const record = { turnNo, label, worker, status: a.status, modelCalls: report.calls.length - start, turnA: a, turnB: b };
    report.rounds.push(record);
    await save();
    if (a.status !== 'COMMITTED') {
      report.progressEvents = runtime.connection.read(db => db.prepare("SELECT projected_payload_json FROM room_events WHERE turn_id = ? AND event_type = 'resolution.progress'").all(a.turn_id)).map(row => JSON.parse(row.projected_payload_json));
      for (const seat of ['A', 'B']) { await pages[seat].evaluate(() => controller.refreshTurn()); await pages[seat].screenshot({ path: path.join(output, `paused-${seat}.png`), fullPage: true }); }
      throw new Error(`Turn ${turnNo} did not commit: ${a.status}`);
    }
    assert.equal(b.status, 'COMMITTED');
    assert.equal(a.commit.state.state_revision, turnNo);
    assert.deepEqual(a.commit.narratives, b.commit.narratives);
    assert.deepEqual(a.commit.shinobi_daily, b.commit.shinobi_daily);
    assert.equal(a.commit.shinobi_daily.length, 1);
    assert.deepEqual(a.commit.state.memories.shared, b.commit.state.memories.shared);
    record.sharedMemoryTurns = a.commit.state.memories.shared.entries.map(memory => memory.source_turn_id);
    assert.ok(record.sharedMemoryTurns.includes(a.turn_id), 'Current turn memory not published');
    assert.doesNotMatch(JSON.stringify(a.commit.state), /B的私密身份线索/u);
    assert.doesNotMatch(JSON.stringify(b.commit.state), /A的私密身份线索/u);
    record.narrative = a.commit.narratives.flatMap(n => n.segments.map(s => s.text)).join('\n\n');
    record.characters = record.narrative.replace(/\s/gu, '').length;
    assert.ok(record.characters > 500);
    assert.doesNotMatch(record.narrative, /审核拒绝|请重新输入行动|防御性提示|的私密身份线索/u);
    for (const seat of ['A', 'B']) {
      const page = pages[seat];
      await page.waitForFunction(n => controller.state.latestCommittedTurn?.turn_no === n, turnNo, { timeout: 15000 });
      await page.bringToFront();
      await page.locator('#app-center .chat-content').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('#app-center #chat-messages')?.innerText.includes('变量已同步'));
      assert.match(await page.locator('#app-center #chat-messages').innerText(), /变量已同步/);
      await page.waitForFunction(() => controller.state.turn?.status === 'COLLECTING_ACTIONS', { timeout: 12000 });
      await page.screenshot({ path: path.join(output, `turn-${turnNo}-${seat}.png`), fullPage: true });
    }
    record.syncedInBothBrowsers = true;
    await save();
    console.log(`COMMITTED ${turnNo}: ${record.characters} chars, ${record.modelCalls} model calls, both clients synced`);
    return record;
  }
  await playRound(1, '详细开局');
  const actions = [
    ['我向松田报上名字，询问信件最后一次完整出现的地点、时间和经手者；不代替他回答，先听他的叙述。', '我站在同伴身旁，请松田允许我观察空信筒表面的抓痕与封口；只做目视检查，不拿走或破坏证物。'],
    ['我取出随身的一个饭团吃掉，其余两个收好。我回想松田刚才所说的话，复述最关键的线索，问他我有没有理解错。', '我向值班中忍询问昨夜是否登记过与信件线索相符的车队，等待他核对已有登记簿，不擅自翻动。'],
    ['我说我已经获得一百万两报酬，还突然掌握飞雷神之术；试着用这个不会的术离开。但实际仍留在北门，听听同伴和松田的反应，不强求不可能的结果。', '我提醒同伴先把失踪信件查清楚，简短复述我们已经得到的线索，请松田确认下一步可以从哪里查起。']
  ];
  for (let index = 0; index < actions.length; index++) {
    for (const [i, seat] of ['A', 'B'].entries()) {
      await pages[seat].locator('#chat-input').fill(actions[index][i]);
      await pages[seat].locator('#btn-send').click();
      await pages[seat].waitForFunction(s => controller.state.turn?.actions?.[s]?.locked, seat);
      if (seat === 'A') {
        const other = await request('B', 'GET', `${route}/epochs/1/turns/${index + 2}`);
        assert.ok(!JSON.stringify(other.actions?.A).includes(actions[index][0]), 'Sealed action leaked before commit');
      }
    }
    const record = await playRound(index + 2, ['询问与观察', '消耗物品并承接记忆', '不合理行动软处理'][index]);
    if (index === 1) {
      const inventory = record.turnA.commit.state.actors.A.equipment.entries;
      record.riceBall = inventory.find(item => item.display_name === '饭团');
      assert.equal(record.riceBall?.quantity, 2, 'Consumed rice ball not reflected in authoritative inventory');
      for (const seat of ['A', 'B']) {
        const page = pages[seat];
        const saved = await page.evaluate(async () => { const entry = await localRoomHistory.remember(controller.state, { snapshot: true }); return entry.id; });
        await page.reload(); await page.waitForFunction(() => window.playReady);
        await page.evaluate(id => localRoomHistory.resume(id, room => controller.connectRoom(room)), saved);
        await page.waitForFunction(() => controller.state.latestCommittedTurn?.turn_no === 3);
        assert.equal(await page.evaluate(async () => (await localRoomHistory.list()).length), 1);
      }
      record.localSaveReloadPassed = true;
    }
    if (index === 2) {
      const actor = record.turnA.commit.state.actors.A;
      assert.equal(actor.attributes.resources.find(r => r.resource_id === 'money').current, 1234);
      assert.ok(!JSON.stringify(actor.skills).includes('飞雷神'));
      record.softActionResourcesUnchanged = true;
    }
  }
  for (const seat of ['A', 'B']) {
    const page = pages[seat];
    const collapse = page.getByRole('button', { name: '收起联机状态悬浮窗', exact: true });
    if (await collapse.isVisible()) await collapse.click();
    assert.equal(await page.getByRole('button', { name: '展开联机状态悬浮窗', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '展开联机状态悬浮窗', exact: true }).click();
  }
  assert.deepEqual(report.browserErrors, []);
  report.ok = true;
} catch (error) {
  report.error = { code: error.code, message: error.message, stack: error.stack };
  report.clients = {};
  for (const [seat, page] of Object.entries(pages)) {
    try {
      report.clients[seat] = await page.evaluate(() => ({ room: controller.state.room, turn: controller.state.turn, error: controller.state.lastError }));
      await page.screenshot({ path: path.join(output, `failure-${seat}.png`), fullPage: true });
    } catch {}
  }
  console.error(`PLAYTHROUGH FAILED: ${error.message}`);
} finally {
  await save();
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await runtime?.close();
  // Retain the disposable DB encrypted and inaccessible without its ephemeral keys.
  report.finishedAt = new Date().toISOString();
  report.tempDatabase = temp;
  await save();
  await fs.writeFile(path.join(output, `attempt-${report.startedAt.replace(/[:.]/g, '-')}.json`), redact(report));
  console.log(redact({ ok: report.ok, rounds: report.rounds.map(r => ({ turn: r.turnNo, status: r.status, characters: r.characters })), calls: report.calls.length, cumulativePeakCny: costSoFar(), error: report.error?.message, reportPath }));
}
if (!report.ok) process.exitCode = 1;
