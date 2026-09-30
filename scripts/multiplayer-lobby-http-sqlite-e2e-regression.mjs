import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { createMultiplayerRuntime } from '../server/multiplayer/application/runtime.js';
import {
  MULTIPLAYER_HTTP_MOUNT_PATH,
  createRepositoryBackedMultiplayerHttpRouter
} from '../server/multiplayer/http/index.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';
import { createOpeningDraft } from '../js/systems/opening-draft.js';
import { buildWriterPrompt } from '../server/multiplayer/agent/prompts.js';

const key = label => createHash('sha256').update(label).digest('base64');
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-lobby-http-e2e-'));
const counters = new Map();
const idFactory = kind => {
  const next = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, next);
  return `${kind}_lobby_http_${next}`;
};
let providerCalls = 0;
const providerModelClient = {
  async invoke() {
    providerCalls += 1;
    throw new Error('lobby confirmation must not invoke the model provider');
  }
};

const runtime = await createMultiplayerRuntime({
  databasePath: path.join(tempRoot, 'multiplayer.sqlite'),
  keyVersion: 'v1',
  contentMasterKey: key('lobby-http-content'),
  credentialMasterKey: key('lobby-http-credential'),
  credentialFingerprintKey: key('lobby-http-fingerprint'),
  actionCommitmentSecret: key('lobby-http-action'),
  lineageSigningSecret: key('lobby-http-lineage'),
  proposalCommitmentSecret: key('lobby-http-proposal')
}, {
  startDispatcher: false,
  startResolutionWorker: false,
  openConnection: openMultiplayerRepositoryTestSqlite,
  providerModelClient,
  roomApplicationOptions: { idFactory },
  coreRepositoryOptions: { idFactory }
});

const app = express();
app.set('trust proxy', false);
app.use((request, _response, next) => {
  const userId = String(request.get('x-test-user') || '').trim();
  if (userId) {
    request.user = { id: userId, username: userId };
    request.authSource = 'bearer';
    request.authExpiresAt = Infinity;
  }
  next();
});
app.use(MULTIPLAYER_HTTP_MOUNT_PATH, createRepositoryBackedMultiplayerHttpRouter({
  core_repositories: runtime.repositories.core,
  billing_repository: runtime.repositories.billing,
  lineage_repository: runtime.repositories.lineage,
  application_services: runtime.services,
  event_hub: runtime.eventHub,
  room_event_stream_handler: runtime.sseHandler,
  chat_rate_limiter: runtime.chatRateLimiter,
  error_logger: error => {
    throw error;
  }
}));

const server = http.createServer(app);
const socketPath = path.join(tempRoot, 'multiplayer-http.sock');
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socketPath, resolve);
});

let passed = 0;
let roomId;
let roomCode;
let inviteToken;
let firstTurnId;
let openingProfile;

async function step(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function request(userId, method, route, body, expectedStatus = 200) {
  const bodyText = body === undefined ? null : JSON.stringify(body);
  const response = await new Promise((resolve, reject) => {
    const outgoing = http.request({
      socketPath,
      path: `${MULTIPLAYER_HTTP_MOUNT_PATH}${route}`,
      method,
      headers: {
        accept: 'application/json',
        'x-test-user': userId,
        ...(bodyText === null ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyText)
        })
      },
      agent: false
    }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    outgoing.once('error', reject);
    if (bodyText !== null) outgoing.write(bodyText);
    outgoing.end();
  });
  const responseText = response.text;
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}: ${responseText.slice(0, 1000)}`);
  }
  assert.equal(response.status, expectedStatus, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
}

function readyRequest(room) {
  const own = room.opening.drafts[room.viewer_seat];
  return {
    expected_control_revision: room.control_revision,
    opening_revision: own.revision,
    opening_commitment: own.commitment
  };
}

const startTime = Object.freeze({ year: 49, month: 4, day: 12, phase: 'DAY' });
const openingA = Object.freeze({
  start_time: startTime,
  display_name: '日向凛',
  rank: '下忍',
  affiliation: '木叶隐村',
  background: '日向分家出身，擅长侦察。',
  location: '木叶北门',
  goal: '确认商道附近的异常痕迹。',
  opening_hook: '提前抵达北门检查通行记录。',
  detailed_draft: createOpeningDraft('chunin', {
    identity: { name: '日向凛', secrets: 'HTTP A 私密身份' },
    power: { attributes: { chakra: 321 } }
  })
});
const openingB = Object.freeze({
  start_time: startTime,
  display_name: '奈良陆',
  rank: '下忍',
  affiliation: '木叶隐村',
  background: '奈良一族的年轻忍者。',
  location: '木叶南门',
  goal: '与队友汇合并完成巡查。',
  opening_hook: '带着任务卷轴从南门出发。',
  detailed_draft: createOpeningDraft('genin_team', { identity: { name: '奈良陆', secrets: 'HTTP B 私密身份' } })
});

try {
  await step('A creates a new multiplayer room with two editable openings', async () => {
    const created = await request('player_http_a', 'POST', '/rooms', {
      origin_type: 'new_multiplayer_save',
      new_world_profile: {
        era: '木叶48年',
        preset_id: 'preset:konoha',
        actor_a: { display_name: '甲' },
        actor_b: { display_name: '乙' }
      },
      default_narrative_mode: 'shared'
    }, 201);
    roomId = created.room.room_id;
    roomCode = created.room.room_code;
    inviteToken = created.invite.token;
    assert.notEqual(roomCode, roomId);
    assert.equal(created.room.viewer_seat, 'A');
    assert.equal(created.room.lifecycle, 'LOBBY');
    assert.equal(created.room.opening.drafts.A.confirmed, false);
    assert.equal(created.room.opening.drafts.B.confirmed, false);
  });

  await step('B joins and both HTTP projections report the correct viewer seat', async () => {
    const joined = await request('player_http_b', 'POST', `/rooms/${encodeURIComponent(roomCode)}/join`, {
      token: inviteToken
    }, 200);
    assert.equal(joined.room.room_id, roomId);
    assert.equal(joined.room.room_code, roomCode);
    assert.equal(joined.room.viewer_seat, 'B');
    const [viewA, viewB] = await Promise.all([
      request('player_http_a', 'GET', `/rooms/${encodeURIComponent(roomCode)}`),
      request('player_http_b', 'GET', `/rooms/${encodeURIComponent(roomCode)}`)
    ]);
    assert.equal(viewA.viewer_seat, 'A');
    assert.equal(viewB.viewer_seat, 'B');
    assert.deepEqual(viewA.members.map(member => member.seat), ['A', 'B']);
  });

  await step('opening confirmation is gated until the shared AI policy is fully ready', async () => {
    const room = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    const rejected = await request(
      'player_http_a',
      'POST',
      `/rooms/${roomId}/ready`,
      readyRequest(room),
      409
    );
    assert.equal(rejected.error.code, 'ROOM_AI_SETTINGS_NOT_READY');
    const unchanged = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    assert.equal(unchanged.members.find(member => member.seat === 'A').ready_at, null);
  });

  await step('A binds one profile and both members confirm A-only credentials without probing', async () => {
    const createdProfile = await request('player_http_a', 'POST', '/model-endpoint-profiles', {
      adapter: 'openai_compatible',
      base_url: 'https://models.example.com/v1',
      model: 'opening-e2e-model',
      auth_scheme: 'none',
      credential_ref: null
    }, 201);
    openingProfile = createdProfile.profile.profile;
    let room = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    const bound = await request('player_http_a', 'PUT', `/rooms/${roomId}/model-profile-binding`, {
      endpoint_profile_id: openingProfile.profile_id,
      expected_binding_revision: room.credential_policy.bindings.A?.binding_revision ?? 0,
      expected_control_revision: room.control_revision
    });
    assert.equal(bound.credential_policy.bindings.A.configured, true);
    assert.equal(Object.hasOwn(bound.credential_policy.bindings.A, 'capability_ready'), false);

    room = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    const acceptedA = await request('player_http_a', 'PUT', `/rooms/${roomId}/settings/credential-policy`, {
      policy: 'A_ONLY',
      expected_policy_revision: room.credential_policy.policy_revision,
      expected_control_revision: room.control_revision
    });
    assert.deepEqual(acceptedA.credential_policy.accepted_by, { A: true, B: false });

    room = await request('player_http_b', 'GET', `/rooms/${roomId}`);
    const acceptedB = await request('player_http_b', 'PUT', `/rooms/${roomId}/settings/credential-policy`, {
      policy: 'A_ONLY',
      expected_policy_revision: room.credential_policy.policy_revision,
      expected_control_revision: room.control_revision
    });
    assert.equal(acceptedB.credential_policy.fully_accepted, true);
    assert.equal(acceptedB.credential_policy.bindings_ready, true);
    assert.equal(Object.hasOwn(acceptedB.credential_policy, 'capabilities_ready'), false);
    assert.equal(acceptedB.credential_policy.ready, true);

    const projected = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    assert.equal(projected.credential_policy.ready, true);
    assert.equal(projected.credential_policy.bindings.A.model, 'opening-e2e-model');
    assert.equal(providerCalls, 0);
  });

  await step('A sends chat, idempotent replay is not duplicated, and B reads it', async () => {
    const sent = await request('player_http_a', 'POST', `/rooms/${roomId}/chat/messages`, {
      text: '我先检查北门，你从南门靠近。',
      idempotency_key: 'chat-http-a-1'
    }, 201);
    const replayed = await request('player_http_a', 'POST', `/rooms/${roomId}/chat/messages`, {
      text: '我先检查北门，你从南门靠近。',
      idempotency_key: 'chat-http-a-1'
    }, 200);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.message.message_id, sent.message.message_id);
    const history = await request('player_http_b', 'GET', `/rooms/${roomId}/chat/messages?limit=50`);
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].sender_seat, 'A');
    assert.equal(history.messages[0].text, '我先检查北门，你从南门靠近。');
  });

  await step('mismatched opening time blocks confirmation through the HTTP boundary', async () => {
    const before = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    const saved = await request('player_http_a', 'PUT', `/rooms/${roomId}/opening`, {
      expected_revision: before.opening.drafts.A.revision,
      draft: openingA
    });
    assert.equal(saved.opening.blocking, true);
    assert.equal(saved.opening.conflicts[0].code, 'OPENING_TIME_MISMATCH');
    const current = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    const rejected = await request(
      'player_http_a',
      'POST',
      `/rooms/${roomId}/ready`,
      readyRequest(current),
      409
    );
    assert.equal(rejected.error.code, 'ROOM_OPENING_CONFLICT');
  });

  await step('B matches the shared time while retaining a different personal opening', async () => {
    const before = await request('player_http_b', 'GET', `/rooms/${roomId}`);
    const saved = await request('player_http_b', 'PUT', `/rooms/${roomId}/opening`, {
      expected_revision: before.opening.drafts.B.revision,
      draft: openingB
    });
    assert.equal(saved.opening.blocking, false);
    assert.ok(saved.opening.conflicts.some(conflict => conflict.code === 'OPENING_LOCATION_SPLIT'));
    assert.equal(saved.opening.drafts.A.draft.display_name, '日向凛');
    assert.equal(saved.opening.drafts.B.draft.display_name, '奈良陆');
    assert.ok(!JSON.stringify(saved).includes('HTTP A 私密身份'));
    assert.ok(JSON.stringify(saved).includes('HTTP B 私密身份'));
    const viewA = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    assert.ok(JSON.stringify(viewA).includes('HTTP A 私密身份'));
    assert.ok(!JSON.stringify(viewA).includes('HTTP B 私密身份'));
  });

  await step('an opening edit after A confirms invalidates both confirmations', async () => {
    const beforeA = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    const confirmedA = await request(
      'player_http_a',
      'POST',
      `/rooms/${roomId}/ready`,
      readyRequest(beforeA)
    );
    assert.equal(confirmedA.all_ready, false);
    assert.equal(confirmedA.room.opening.drafts.A.confirmed, true);

    const beforeB = await request('player_http_b', 'GET', `/rooms/${roomId}`);
    const edited = await request('player_http_b', 'PUT', `/rooms/${roomId}/opening`, {
      expected_revision: beforeB.opening.drafts.B.revision,
      draft: { ...openingB, goal: '与队友汇合，优先保护沿途平民。' }
    });
    assert.equal(edited.opening.drafts.A.confirmed, false);
    assert.equal(edited.opening.drafts.B.confirmed, false);
    assert.equal(edited.room.members.every(member => member.ready_at === null), true);
  });

  await step('members sync their own presets, choose B and invalidate old lobby confirmations', async () => {
    const route = `/rooms/${roomId}/settings/narrative-preset`;
    let room = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    await request('player_http_a', 'PUT', route, { expected_control_revision: room.control_revision,
      source_seat: 'B' }, 409);
    const presetA = { name: 'A 的正文预设', entries: [{ content: 'A_STYLE 内容' + '长'.repeat(90_000), enabled: true }] };
    const savedA = await request('player_http_a', 'PUT', route, { expected_control_revision: room.control_revision, preset: presetA });
    const replayA = await request('player_http_a', 'PUT', route, { expected_control_revision: savedA.room.control_revision, preset: presetA });
    assert.equal(replayA.room.control_revision, savedA.room.control_revision);
    await request('player_http_a', 'POST', `/rooms/${roomId}/ready`, readyRequest(savedA.room));
    room = await request('player_http_b', 'GET', `/rooms/${roomId}`);
    const savedB = await request('player_http_b', 'PUT', route, { expected_control_revision: room.control_revision,
      preset: { name: 'B 的详细正文', entries: [
        { id: 'marker', isMarker: true },
        { content: 'B_STYLE 写 {{user}} 的场景，全文 1500 字。', role: 'system' },
        { content: 'DISABLED_STYLE', enabled: false },
        { content: 'SOLO_VARIABLE_TAGS', activation: 'variable_updater_disabled' }
      ] } });
    assert.ok(savedB.room.members.find(x => x.seat === 'A').ready_at, 'syncing the unselected B preset preserves A confirmation');
    assert.equal(savedB.room.narrative_preset.bindings.A.name, presetA.name);
    assert.ok(!JSON.stringify(savedB).includes('A_STYLE'));
    assert.ok(!JSON.stringify(savedB).includes('B_STYLE'), 'room projection only exposes preset metadata');
    const selected = await request('player_http_b', 'PUT', route, { expected_control_revision: savedB.room.control_revision, source_seat: 'B' });
    assert.equal(selected.room.narrative_preset.source_seat, 'B');
    assert.ok(selected.room.members.every(x => x.ready_at === null));
    assert.ok(!selected.room.opening.drafts.A.confirmed);
    await request('player_http_a', 'PUT', route, { expected_control_revision: savedB.room.control_revision, source_seat: 'A' }, 409);
  });

  await step('both latest confirmations atomically start exactly one server-generated opening', async () => {
    const beforeA = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    const readyA = await request(
      'player_http_a',
      'POST',
      `/rooms/${roomId}/ready`,
      readyRequest(beforeA)
    );
    assert.equal(readyA.all_ready, false);

    const beforeB = await request('player_http_b', 'GET', `/rooms/${roomId}`);
    const readyB = await request(
      'player_http_b',
      'POST',
      `/rooms/${roomId}/ready`,
      readyRequest(beforeB)
    );
    assert.equal(readyB.all_ready, true);
    assert.equal(readyB.room.lifecycle, 'ACTIVE');
    assert.equal(readyB.turn.turn_no, 1);
    assert.equal(readyB.turn.turn_kind, 'OPENING');
    assert.equal(readyB.turn.status, 'RESOLVING');
    assert.equal(readyB.credential_policy.ready, true);
    firstTurnId = readyB.turn.turn_id;
    const genesisOpenings = runtime.repositories.core.openings.getForGenesis({ authenticated_user_id: 'player_http_b', room_id: roomId });
    assert.ok(JSON.stringify(genesisOpenings).includes('HTTP A 私密身份'));
    assert.ok(JSON.stringify(genesisOpenings).includes('HTTP B 私密身份'));

    const persisted = runtime.connection.read(database => ({
      anchors: database.prepare(`
        SELECT seat_id, idempotency_key, narration_preference
          FROM action_submissions
         WHERE turn_id = ?
         ORDER BY seat_id
      `).all(firstTurnId),
      plans: database.prepare(`
        SELECT plan_hash FROM turn_billing_plans WHERE turn_id = ?
      `).all(firstTurnId),
      runs: database.prepare(`
        SELECT run_status FROM resolution_runs WHERE turn_id = ?
      `).all(firstTurnId),
      authorizations: database.prepare(`
        SELECT authorization.plan_hash
          FROM turn_billing_authorizations AS authorization
          JOIN turn_billing_plans AS plan ON plan.plan_hash = authorization.plan_hash
         WHERE plan.turn_id = ?
      `).all(firstTurnId)
    }));
    assert.deepEqual(persisted.anchors.map(anchor => anchor.seat_id), ['A', 'B']);
    assert.ok(persisted.anchors.every(anchor => (
      anchor.idempotency_key.startsWith('server-opening-')
      && anchor.narration_preference === 'summarize_intent'
    )));
    assert.equal(persisted.plans.length, 1);
    assert.equal(persisted.runs.length, 1);
    assert.ok(['QUEUED', 'CLAIMED', 'RUNNING'].includes(persisted.runs[0].run_status));
    assert.deepEqual(persisted.authorizations, [{ plan_hash: persisted.plans[0].plan_hash }]);

    const activeB = await request('player_http_b', 'GET', `/rooms/${roomId}`);
    const replayed = await request(
      'player_http_b',
      'POST',
      `/rooms/${roomId}/ready`,
      readyRequest(activeB)
    );
    assert.equal(replayed.turn.turn_id, firstTurnId);
    assert.equal(replayed.turn.turn_kind, 'OPENING');
    assert.equal(runtime.connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM action_submissions WHERE turn_id = ?
    `).get(firstTurnId).count), 2);
  });

  await step('changing the room preset keeps the already-started opening frozen to B', async () => {
    const room = await request('player_http_a', 'GET', `/rooms/${roomId}`);
    const changed = await request('player_http_a', 'PUT', `/rooms/${roomId}/settings/narrative-preset`, {
      expected_control_revision: room.control_revision, source_seat: 'A'
    });
    assert.equal(changed.room.narrative_preset.source_seat, 'A');
    assert.equal(changed.room.narrative_preset.current_turn.source_seat, 'B');
    const frozen = runtime.connection.read(db => JSON.parse(db.prepare('SELECT writer_preset_json FROM multiplayer_turns WHERE turn_id = ?').get(firstTurnId).writer_preset_json));
    const prompt = JSON.parse(buildWriterPrompt({ audience: 'shared', canonical_stop_point: 'scene:stop', audience_projection: {},
      style_requirements: { writer_preset: frozen }, turn_purpose: 'opening_scene', opening_context: { openings: { A: openingA, B: openingB } } }));
    assert.equal(prompt.trusted_selected_preset.name, 'B 的详细正文');
    const content = JSON.stringify(prompt.trusted_selected_preset);
    assert.match(content, /B_STYLE 写 日向凛与奈良陆/u);
    assert.ok(!content.includes('DISABLED_STYLE'));
    assert.ok(!content.includes('SOLO_VARIABLE_TAGS'));
    assert.ok(!content.includes('{{user}}'));
  });

  await step('chat remains bidirectional after activation', async () => {
    await request('player_http_b', 'POST', `/rooms/${roomId}/chat/messages`, {
      text: '收到，我已经抵达南门。',
      idempotency_key: 'chat-http-b-1'
    }, 201);
    const history = await request('player_http_a', 'GET', `/rooms/${roomId}/chat/messages?limit=50`);
    assert.equal(history.messages.length, 2);
    assert.deepEqual(new Set(history.messages.map(message => message.sender_seat)), new Set(['A', 'B']));
    assert.match(history.messages.map(message => message.text).join('\n'), /已经抵达南门/u);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  await runtime.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer lobby HTTP + SQLite E2E regression: ${passed} passed`);
