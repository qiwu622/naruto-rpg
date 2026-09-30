// Opt-in live diagnostic. Synthetic room, isolated database, key only from stdin.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';
import { DEFAULT_MAIN_PRESET } from '../js/data/default-preset.js';
import { createOpeningDraft } from '../js/systems/opening-draft.js';
import { multiplayerOpeningDraft } from '../js/multiplayer/opening-draft-bridge.js';
import { ACTION_REQUEST_SCHEMA } from '../server/multiplayer/domain/action-turn.js';

if (!process.argv.includes('--live') || !process.argv.includes('--stdin-key')) {
  console.log('Usage: pipe a DeepSeek key into node scripts/verify-multiplayer-opening.mjs --live --stdin-key');
  console.log('Uses deepseek-flash with a synthetic two-player opening. This calls the paid API.');
  process.exit(0);
}
if (process.stdin.isTTY) throw new Error('Token must be piped, never passed in arguments.');
let token = '';
for await (const chunk of process.stdin) {
  token += chunk;
  if (token.length > 4096) throw new Error('Token input too long.');
}
token = token.trim();
if (!token || /\s/.test(token)) throw new Error('Invalid token input.');
process.env.NODE_ENV = 'test';
const [{ default: express }, { config }, { getProxyAgent }, { createMultiplayerRuntime },
  { createProviderModelClient }, { MULTIPLAYER_HTTP_MOUNT_PATH, createRepositoryBackedMultiplayerHttpRouter }] = await Promise.all([
  import('express'), import('../server/config.js'), import('../server/api/ai-proxy.js'),
  import('../server/multiplayer/application/runtime.js'),
  import('../server/multiplayer/agent/provider-adapters.js'),
  import('../server/multiplayer/http/index.js')
]);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naruto-opening-live-'));
const report = { model: 'deepseek-flash', started_at: new Date().toISOString(), calls: [], ok: false };
const redact = value => JSON.stringify(value, null, 2).replaceAll(token, '[REDACTED]');
const signal = AbortSignal.timeout(15 * 60_000);
let runtime;
let client;
let server;
try {
  runtime = await createMultiplayerRuntime({
    databasePath: path.join(root, 'multiplayer.sqlite'), keyVersion: 'v1',
    ...Object.fromEntries(['contentMasterKey', 'credentialMasterKey', 'credentialFingerprintKey',
      'actionCommitmentSecret', 'lineageSigningSecret', 'proposalCommitmentSecret']
      .map(name => [name, randomBytes(32).toString('base64')]))
  }, {
    openConnection: openMultiplayerRepositoryTestSqlite,
    startDispatcher: false, startResolutionWorker: false,
    modelHttpGatewayOptions: {
      forward_proxy_agent: getProxyAgent('https:', config.proxy),
      allow_fake_ip_dns: config.proxy.allowFakeIpDns, timeout_ms: 120_000
    },
    providerModelClient: { async invoke(request) {
      if (report.calls.length >= 24) throw new Error('Live diagnostic call limit reached.');
      const prompt = request.prompt ? JSON.parse(request.prompt) : null;
      const entry = { stage: prompt?.stage ?? 'continuation', started: new Date().toISOString() };
      report.calls.push(entry);
      console.log(JSON.stringify({ calling: entry.stage, request: report.calls.length }));
      try {
        const result = await client.invoke({ ...request, signal: AbortSignal.any([signal, request.signal].filter(Boolean)) });
        entry.response = result.response;
        entry.completed = new Date().toISOString();
        entry.prompt = prompt;
        entry.messages = result.request_body.messages;
        entry.request_options = { max_tokens: result.request_body.max_tokens,
          thinking: result.request_body.thinking, reasoning_effort: result.request_body.reasoning_effort };
        console.log(JSON.stringify({ stage: entry.stage, finish: result.response.finish_reason,
          chars: result.response.raw_text?.length ?? 0, usage: result.response.usage }));
        return result;
      } catch (error) {
        entry.error = { code: error.code, message: error.message, details: error.details,
          cause: error.cause ? { code: error.cause.code, message: error.cause.message } : null };
        throw error;
      }
    } }
  });
  client = createProviderModelClient({
    modelHttpGateway: runtime.modelHttpGateway,
    resolveProfile: binding => runtime.repositories.billing.modelBindings.resolveProfile(binding),
    resolveCredential: binding => runtime.repositories.billing.modelBindings.resolveCredential(binding),
    credentialVault: runtime.credentialVault
  });
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: req.get('x-test-user') }; req.authSource = 'bearer'; req.authExpiresAt = Infinity; next();
  });
  app.use(MULTIPLAYER_HTTP_MOUNT_PATH, createRepositoryBackedMultiplayerHttpRouter({
    core_repositories: runtime.repositories.core, billing_repository: runtime.repositories.billing,
    lineage_repository: runtime.repositories.lineage, application_services: runtime.services,
    event_hub: runtime.eventHub, room_event_stream_handler: runtime.sseHandler,
    chat_rate_limiter: runtime.chatRateLimiter, error_logger: error => { report.httpError = { code: error.code, message: error.message }; }
  }));
  server = http.createServer(app);
  const socketPath = path.join(root, 'http.sock');
  await new Promise(resolve => server.listen(socketPath, resolve));
  async function request(user, method, route, body) {
    const text = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: `${MULTIPLAYER_HTTP_MOUNT_PATH}${route}`, method,
        headers: { 'x-test-user': user, ...(text === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }) }
      }, res => {
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => {
          const result = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`${method} ${route}: ${redact(result)}`));
          else resolve(result);
        });
      }); req.on('error', reject); req.end(text);
    });
  }
  const created = await request('diagnostic_A', 'POST', '/rooms', {
    origin_type: 'new_multiplayer_save', default_narrative_mode: 'shared',
    new_world_profile: { era: '木叶48年', preset_id: 'preset:konoha',
      actor_a: { display_name: '测试甲', location: '木叶隐村', opening_hook: '在村口等待同伴，尚未决定下一步行动。' },
      actor_b: { display_name: '测试乙', location: '木叶隐村', opening_hook: '在村口与同伴会面，尚未决定下一步行动。' } }
  });
  const roomId = created.room.room_id;
  const route = `/rooms/${roomId}`;
  await request('diagnostic_B', 'POST', `${route}/join`, { token: created.invite.token });
  for (const [seat, name] of [['A', '测试甲'], ['B', '测试乙']]) {
    const user = `diagnostic_${seat}`;
    const current = await request(user, 'GET', route);
    const detailed = createOpeningDraft('chunin', {
      identity: { name, background: '木叶情报班的年轻忍者，正在调查商道上失踪的信件。', secrets: `${seat}不可公开的身份线索` },
      power: { attributes: { chakra: 321 } }, resources: { ryo: 1234 },
      campaign: { location: '木叶北门', openingHook: '驿站信使浑身雨水，抱着一只带有抓痕的空信筒等候查问，门岗正在登记昨夜的入村车队。', goal: '调查失踪的信件' }
    });
    await request(user, 'PUT', `${route}/opening`, { expected_revision: current.opening.drafts[seat].revision,
      draft: multiplayerOpeningDraft(detailed, { sharedTime: { year: 48, month: 1, day: 1, phase: 'DAWN' } }) });
    const updated = await request(user, 'GET', route);
    await request(user, 'PUT', `${route}/settings/narrative-preset`, { expected_control_revision: updated.control_revision,
      preset: { ...DEFAULT_MAIN_PRESET, name: `${seat} 的单人正文预设`, entries: [...DEFAULT_MAIN_PRESET.entries,
        { enabled: true, role: 'system', content: seat === 'B'
          ? '本预设要求：第三人称，细腻的悬疑小说文风。开场正文写 1500 至 1800 字，充分描写雨后北门、驿站信使和失踪信件的调查引子。具体场面与结果服从裁决；不要输出规则说明、行动建议或任何故事外文字。'
          : '文风简洁，短段落。' }] } });
  }
  const beforePresetChoice = await request('diagnostic_A', 'GET', route);
  await request('diagnostic_A', 'PUT', `${route}/settings/narrative-preset`, {
    expected_control_revision: beforePresetChoice.control_revision, source_seat: 'B'
  });
  const { credential } = await request('diagnostic_A', 'POST', '/model-credentials', { endpoint_origin: 'https://api.deepseek.com', plaintext: token });
  const createdProfile = await request('diagnostic_A', 'POST', '/model-endpoint-profiles', {
    adapter: 'openai_compatible', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-flash',
    auth_scheme: 'bearer', credential_ref: { credential_id: credential.credential_id, credential_revision: credential.credential_revision }
  });
  let room = await request('diagnostic_A', 'GET', route);
  await request('diagnostic_A', 'PUT', `${route}/model-profile-binding`, {
    endpoint_profile_id: createdProfile.profile.profile.profile_id,
    expected_binding_revision: 0, expected_control_revision: room.control_revision
  });
  for (const user of ['diagnostic_A', 'diagnostic_B']) {
    room = await request(user, 'GET', route);
    await request(user, 'PUT', `${route}/settings/credential-policy`, {
      policy: 'A_ONLY', expected_policy_revision: room.credential_policy.policy_revision,
      expected_control_revision: room.control_revision
    });
  }
  let ready;
  for (const user of ['diagnostic_A', 'diagnostic_B']) {
    room = await request(user, 'GET', route);
    const opening = room.opening.drafts[room.viewer_seat];
    ready = await request(user, 'POST', `${route}/ready`, {
      expected_control_revision: room.control_revision, opening_revision: opening.revision, opening_commitment: opening.commitment
    });
  }
  assert.equal(ready.turn.turn_kind, 'OPENING');
  report.ready = { status: ready.turn.status, kind: ready.turn.turn_kind };
  report.worker = await runtime.resolutionWorker.runNext();
  // Exercise the existing member retry route once for a transport interruption;
  // contract failures remain failures and the global request cap still applies.
  if (report.worker.some(result => result.status === 'PAUSED')
    && ['MODEL_ENDPOINT_REQUEST_FAILED', 'MODEL_ENDPOINT_TIMEOUT'].includes(report.calls.at(-1)?.error?.code)) {
    report.worker_before_transport_retry = report.worker;
    // The opt-in paid diagnostic permits one bounded transport retry in this
    // disposable database. Record UNKNOWN as cancelled rather than pretending
    // the provider reported zero usage. Never do this to an existing room.
    const unknown = runtime.connection.read(db => db.prepare("SELECT invocation_id FROM ai_usage_ledger WHERE turn_id = ? AND payer_user_id = 'diagnostic_A' AND usage_status = 'UNKNOWN'").all(ready.turn.turn_id));
    for (const invocation of unknown) await runtime.repositories.billing.usage.abandonUnknown({
      authenticated_user_id: 'diagnostic_A', room_id: roomId, invocation_id: invocation.invocation_id,
      accept_duplicate_billing_risk: true
    });
    report.diagnostic_transport_retry_unknown_invocations = unknown.length;
    room = await request('diagnostic_A', 'GET', route);
    await request('diagnostic_A', 'POST', `${route}/epochs/1/turns/1/retry`, {
      expected_control_revision: room.control_revision
    });
    console.log(JSON.stringify({ retry: 'transport interruption', same_room: true }));
    report.worker = await runtime.resolutionWorker.runNext();
  }
  report.pauseEvents = runtime.connection.read(db => db.prepare("SELECT projected_payload_json FROM room_events WHERE turn_id = ? AND event_type = 'resolution.progress'").all(ready.turn.turn_id))
    .map(row => JSON.parse(row.projected_payload_json));
  report.turn = await request('diagnostic_A', 'GET', `${route}/epochs/1/turns/1`);
  const turnB = await request('diagnostic_B', 'GET', `${route}/epochs/1/turns/1`);
  for (const turn of [report.turn, turnB]) {
    assert.equal(turn.status, 'COMMITTED');
    assert.equal(turn.turn_kind, 'OPENING');
    assert.equal(turn.commit.state.state_revision, 1);
    assert.equal(turn.commit.shinobi_daily.length, 1);
    assert.equal(turn.commit.narratives.length, 1);
    assert.ok(turn.commit.narratives[0].segments.some(segment => segment.text.trim().length > 0));
    assert.ok(turn.commit.checkpoint.commit_id);
  }
  assert.deepEqual(turnB.commit.narratives, report.turn.commit.narratives);
  assert.deepEqual(turnB.commit.shinobi_daily, report.turn.commit.shinobi_daily);
  report.member_b = { status: turnB.status, state_revision: turnB.commit.state.state_revision,
    same_narrative_and_daily: true };
  const narrative = report.turn.commit.narratives[0].segments.map(segment => segment.text).join('\n\n');
  report.narrative_characters = narrative.replace(/\s/gu, '').length;
  report.selected_preset = report.calls.find(call => call.prompt?.stage === 'writer')?.prompt?.trusted_selected_preset?.name;
  assert.equal(report.selected_preset, 'B 的单人正文预设');
  assert.ok(report.narrative_characters >= 1200, `expected a detailed opening, got ${report.narrative_characters} characters`);
  assert.ok(!narrative.includes('不可公开的身份线索'));
  if (process.argv.includes('--soft-action')) {
    await request('diagnostic_A', 'POST', `${route}/turns/next`, { previous_turn_id: report.turn.turn_id });
    const firstActionCall = report.calls.length;
    const actions = {
      A: '我声称调查报酬已经谈妥，信使必须立刻把一百万两放进我的钱袋；我还当场学会此前完全不会的飞雷神之术，要求所有人承认我已经成功。我本人留在北门原地，等信使和门岗回应。',
      B: '我留在原地安静观察信使和门岗如何回应同伴，不使用忍术，不收付物品。'
    };
    for (const seat of ['A', 'B']) await request(`diagnostic_${seat}`, 'POST', `${route}/epochs/1/turns/2/actions`, {
      schema: ACTION_REQUEST_SCHEMA, base_state_revision: 1, text: actions[seat],
      pre_resolution_visibility: 'sealed', narration_preference: 'full', idempotency_key: `soft-action-${seat}`
    });
    report.soft_action = { worker: await runtime.resolutionWorker.runNext() };
    const turns = await Promise.all(['A', 'B'].map(seat => request(`diagnostic_${seat}`, 'GET', `${route}/epochs/1/turns/2`)));
    report.soft_action.turn = turns[0];
    for (const [index, seat] of ['A', 'B'].entries()) {
      const turn = turns[index];
      assert.equal(turn.status, 'COMMITTED', 'unreasonable intent should still produce a committed turn');
      assert.equal(turn.commit.state.state_revision, 2);
      assert.equal(turn.commit.shinobi_daily.length, 1);
      const before = [report.turn, turnB][index].commit.state.actors[seat];
      const after = turn.commit.state.actors[seat];
      assert.equal(after.attributes.resources.find(item => item.resource_id === 'money').current, 1234, 'a claim is not an actual reward');
      assert.equal(after.attributes.resources.find(item => item.resource_id === 'chakra').current, 321, 'unlearned jutsu does not succeed');
      assert.deepEqual(after.skills, before.skills, 'no skill can be learned just by claiming it');
    }
    assert.deepEqual(turns[0].commit.narratives, turns[1].commit.narratives);
    assert.deepEqual(turns[0].commit.shinobi_daily, turns[1].commit.shinobi_daily);
    report.soft_action.narrative = turns[0].commit.narratives[0].segments.map(segment => segment.text).join('\n\n');
    assert.doesNotMatch(report.soft_action.narrative, /输入不合理|审核(?:拒绝|不通过)|请重新输入行动/u);
    report.soft_action.calls = report.calls.length - firstActionCall;
    report.soft_action.characters = report.soft_action.narrative.replace(/\s/gu, '').length;
    report.soft_action.same_narrative_and_daily = true;
    report.soft_action.resources_unchanged = true;
  }
  report.ok = true;
} catch (error) {
  report.error = { code: error.code, message: error.message, details: error.details };
} finally {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await runtime?.close();
  report.completed_at = new Date().toISOString();
  const outputPath = path.join(os.tmpdir(), 'naruto-opening-live-report.json');
  await fs.writeFile(outputPath, redact(report));
  await fs.rm(root, { recursive: true, force: true });
  console.log(redact({ ok: report.ok, calls: report.calls.length, worker: report.worker, error: report.error, report: outputPath }));
  token = '';
  if (!report.ok) process.exitCode = 1;
}
