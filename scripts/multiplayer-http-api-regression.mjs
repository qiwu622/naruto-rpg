import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';

import cookieParser from 'cookie-parser';
import express from 'express';

import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  MULTIPLAYER_HTTP_MOUNT_PATH,
  MULTIPLAYER_HTTP_OPERATION_NAMES,
  MULTIPLAYER_HTTP_ROUTE_SPECS,
  createMultiplayerHttpRouter,
  createRepositoryBackedMultiplayerHttpOperations
} from '../server/multiplayer/http/index.js';
import { createChatRateLimiter } from '../server/multiplayer/security/chat-rate-limit.js';

const EXPECTED_ROUTES = Object.freeze([
  'POST /save-imports',
  'POST /rooms',
  'POST /rooms/:roomId/join',
  'GET /rooms/:roomId',
  'PUT /rooms/:roomId/opening',
  'POST /rooms/:roomId/ready',
  'POST /rooms/:roomId/turns/next',
  'PUT /rooms/:roomId/settings/narrative-mode',
  'PUT /rooms/:roomId/settings/narrative-preset',
  'PUT /rooms/:roomId/settings/credential-policy',
  'PUT /rooms/:roomId/model-profile-binding',
  'POST /model-endpoint-profiles',
  'GET /model-endpoint-profiles',
  'PUT /model-endpoint-profiles/:profileId',
  'DELETE /model-endpoint-profiles/:profileId',
  'POST /model-endpoint-profiles/:profileId/capability-probes',
  'POST /model-credentials',
  'GET /model-credentials',
  'POST /model-credentials/:credentialId/rotate',
  'DELETE /model-credentials/:credentialId',
  'POST /rooms/:roomId/execution-grants',
  'DELETE /rooms/:roomId/execution-grants/:grantId',
  'POST /rooms/:roomId/data-processing-consents',
  'DELETE /rooms/:roomId/data-processing-consents/:consentId',
  'GET /rooms/:roomId/events',
  'GET /rooms/:roomId/chat/messages',
  'POST /rooms/:roomId/chat/messages',
  'PUT /rooms/:roomId/epochs/:epochNo/turns/:turnNo/shared-stage-payer',
  'PUT /rooms/:roomId/epochs/:epochNo/turns/:turnNo/pov-writer-selections/:audienceSeat',
  'POST /rooms/:roomId/epochs/:epochNo/turns/:turnNo/actions',
  'GET /rooms/:roomId/epochs/:epochNo/turns/:turnNo',
  'GET /rooms/:roomId/epochs/:epochNo/turns/:turnNo/actions/:submissionId',
  'GET /rooms/:roomId/epochs/:epochNo/turns/:turnNo/billing-plan',
  'POST /rooms/:roomId/epochs/:epochNo/turns/:turnNo/billing-plan/authorizations',
  'POST /rooms/:roomId/epochs/:epochNo/turns/:turnNo/billing-plan/amendments',
  'POST /rooms/:roomId/epochs/:epochNo/turns/:turnNo/billing-plan/amendments/:amendmentId/accept',
  'POST /rooms/:roomId/epochs/:epochNo/turns/:turnNo/retry',
  'POST /rooms/:roomId/epochs/:epochNo/turns/:turnNo/void-proposals',
  'POST /rooms/:roomId/epochs/:epochNo/turns/:turnNo/void-proposals/:proposalId/accept',
  'GET /rooms/:roomId/lineage',
  'POST /rooms/:roomId/archive-proposals',
  'POST /rooms/:roomId/archive-proposals/:proposalId/accept',
  'POST /rooms/:roomId/continuation-proposals',
  'POST /rooms/:roomId/continuation-proposals/:proposalId/accept',
  'POST /rooms/:roomId/checkpoints/:checkpointId/single-player-exports',
  'GET /rooms/:roomId/single-player-exports/:exportId/content'
]);

const PARAMETER_VALUES = Object.freeze({
  roomId: 'room_1',
  profileId: 'profile_1',
  credentialId: 'credential_1',
  grantId: 'grant_1',
  consentId: 'consent_1',
  epochNo: '2',
  turnNo: '3',
  audienceSeat: 'B',
  submissionId: 'action_1',
  amendmentId: 'amendment_1',
  proposalId: 'proposal_1',
  checkpointId: 'checkpoint_1',
  exportId: 'export_1'
});

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function mockOperations(overrides = {}) {
  return Object.freeze(Object.fromEntries(MULTIPLAYER_HTTP_OPERATION_NAMES.map(name => [
    name,
    overrides[name] ?? (async context => ({ operation: name, context }))
  ])));
}

function materializePath(pattern) {
  return pattern.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, name) => {
    assert.ok(PARAMETER_VALUES[name], `missing sample value for ${name}`);
    return PARAMETER_VALUES[name];
  });
}

class InMemoryHttpSocket extends Duplex {
  constructor(chunks) {
    super({ allowHalfOpen: true, autoDestroy: false });
    this.chunks = chunks;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  // IncomingMessage destroys its transport after synthetic EOF. A real HTTP
  // socket remains writable for the asynchronous response, so preserve that
  // half here as well.
  destroy() {
    return this;
  }

  destroySoon() {}
}

async function withApiServer({
  operations,
  roomEventStreamHandler = (_req, res) => res.status(200).json({ stream: true }),
  chatRateLimiter,
  auth = () => ({
    user: { id: 'server_user' },
    authSource: 'bearer',
    authExpiresAt: Infinity
  }),
  errorLogger = () => {}
}, run) {
  const app = express();
  app.set('trust proxy', false);
  app.use(cookieParser());
  app.use((req, _res, next) => {
    Object.assign(req, auth(req));
    next();
  });
  app.use(MULTIPLAYER_HTTP_MOUNT_PATH, createMultiplayerHttpRouter({
    operations,
    room_event_stream_handler: roomEventStreamHandler,
    chat_rate_limiter: chatRateLimiter,
    error_logger: errorLogger
  }));
  await run(app);
}

async function request(app, path, {
  method = 'GET',
  body,
  rawBody,
  headers = {}
} = {}) {
  const requestHeaders = Object.fromEntries(Object.entries({
    host: 'game.example',
    ...headers
  }).map(([name, value]) => [name.toLowerCase(), String(value)]));
  let payload = null;
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    payload = Buffer.from(JSON.stringify(body));
  } else if (rawBody !== undefined) {
    payload = Buffer.from(rawBody);
  }
  if (payload !== null) requestHeaders['content-length'] = String(payload.byteLength);

  const chunks = [];
  const socket = new InMemoryHttpSocket(chunks);
  const req = new http.IncomingMessage(socket);
  req.method = method;
  req.url = `${MULTIPLAYER_HTTP_MOUNT_PATH}${path}`;
  req.headers = requestHeaders;
  const res = new http.ServerResponse(req);
  res.assignSocket(socket);
  const finished = new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  if (payload !== null) req.push(payload);
  req.push(null);
  app(req, res);
  let timeout;
  await Promise.race([
    finished,
    new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(
        `in-memory request did not finish: ${method} ${path}`
      )), 2_000);
    })
  ]);
  clearTimeout(timeout);

  const raw = Buffer.concat(chunks);
  const delimiter = raw.indexOf('\r\n\r\n');
  assert.notEqual(delimiter, -1, 'in-memory HTTP response must contain headers');
  const head = raw.subarray(0, delimiter).toString('latin1');
  const responseBody = raw.subarray(delimiter + 4);
  const lines = head.split('\r\n');
  const status = Number(lines.shift().split(' ')[1]);
  const responseHeaders = new Map(lines.map(line => {
    const separator = line.indexOf(':');
    return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
  }));
  return Object.freeze({
    status,
    headers: Object.freeze({ get: name => responseHeaders.get(name.toLowerCase()) ?? null }),
    async json() { return JSON.parse(responseBody.toString('utf8')); },
    async arrayBuffer() {
      return responseBody.buffer.slice(
        responseBody.byteOffset,
        responseBody.byteOffset + responseBody.byteLength
      );
    }
  });
}

await test('route manifest exactly covers every REST and SSE endpoint from section 19', () => {
  assert.deepEqual(
    MULTIPLAYER_HTTP_ROUTE_SPECS.map(spec => `${spec.method.toUpperCase()} ${spec.path}`),
    EXPECTED_ROUTES
  );
  assert.equal(
    MULTIPLAYER_HTTP_ROUTE_SPECS.filter(spec => spec.operation).length,
    MULTIPLAYER_HTTP_OPERATION_NAMES.length
  );
});

await test('all REST operations and the SSE handler receive canonical path context', async () => {
  const calls = [];
  let streamCall = null;
  const operations = mockOperations(Object.fromEntries(
    MULTIPLAYER_HTTP_OPERATION_NAMES.map(name => [name, async context => {
      calls.push({ name, context });
      if (name === 'downloadSinglePlayerExport') {
        return { content: { operation: name } };
      }
      return { operation: name, replayed: false };
    }])
  ));
  await withApiServer({
    operations,
    roomEventStreamHandler(req, res) {
      streamCall = { user_id: req.user.id, room_id: req.params.roomId };
      res.status(200).json({ stream: true });
    }
  }, async app => {
    for (const spec of MULTIPLAYER_HTTP_ROUTE_SPECS) {
      const response = await request(app, materializePath(spec.path), {
        method: spec.method.toUpperCase(),
        body: ['POST', 'PUT', 'DELETE'].includes(spec.method.toUpperCase()) ? {} : undefined
      });
      assert.equal(response.status, spec.status ?? 200, `${spec.method} ${spec.path}`);
      await response.arrayBuffer();
    }
  });
  assert.deepEqual(calls.map(call => call.name), MULTIPLAYER_HTTP_OPERATION_NAMES);
  assert.ok(calls.every(call => call.context.authenticated_user_id === 'server_user'));
  assert.ok(calls.filter(call => call.context.room_id).every(call => (
    call.context.room_id === 'room_1'
  )));
  assert.ok(calls.filter(call => call.context.epoch_no).every(call => (
    call.context.epoch_no === 2 && call.context.turn_no === 3
  )));
  assert.equal(
    calls.find(call => call.name === 'selectPovWriter').context.audience_seat,
    'B'
  );
  assert.deepEqual(streamCall, { user_id: 'server_user', room_id: 'room_1' });
});

await test('cookie writes require same-origin CSRF while reads reject a foreign Origin', async () => {
  let createCalls = 0;
  const operations = mockOperations({
    async createRoom() {
      createCalls += 1;
      return { room_id: 'room_1' };
    }
  });
  await withApiServer({
    operations,
    auth: () => ({
      user: { id: 'cookie_user' },
      authSource: 'cookie',
      authExpiresAt: Infinity
    })
  }, async app => {
    const missingOrigin = await request(app, '/rooms', {
      method: 'POST',
      body: {},
      headers: {
        cookie: 'naruto_csrf=same-token',
        'x-csrf-token': 'same-token'
      }
    });
    assert.equal(missingOrigin.status, 403);
    assert.equal((await missingOrigin.json()).error.code, 'CSRF_ORIGIN_REQUIRED');

    const foreignRead = await request(app, '/rooms/room_1', {
      headers: { origin: 'https://evil.example' }
    });
    assert.equal(foreignRead.status, 403);
    assert.equal((await foreignRead.json()).error.code, 'CROSS_ORIGIN_REQUEST_FORBIDDEN');

    const origin = 'http://game.example';
    const accepted = await request(app, '/rooms', {
      method: 'POST',
      body: {},
      headers: {
        origin,
        cookie: 'naruto_csrf=same-token',
        'x-csrf-token': 'same-token'
      }
    });
    assert.equal(accepted.status, 201);
  });
  assert.equal(createCalls, 1);
});

await test('DomainError status/code/details are mapped and unknown errors stay opaque', async () => {
  const logged = [];
  const operations = mockOperations({
    getRoom(context) {
      if (context.room_id === 'room_domain') {
        throw new DomainError(
          'STALE_CONTROL_REVISION',
          'room control revision changed',
          { expected: 4, actual: 5, secret_token: 'must-not-leak' },
          { status: 409 }
        );
      }
      throw new Error('database path and key must stay private');
    }
  });
  await withApiServer({ operations, errorLogger: error => logged.push(error.message) }, async app => {
    const domain = await request(app, '/rooms/room_domain');
    assert.equal(domain.status, 409);
    assert.deepEqual(await domain.json(), {
      error: {
        code: 'STALE_CONTROL_REVISION',
        message: 'room control revision changed',
        details: { expected: 4, actual: 5, secret_token: '[redacted]' }
      }
    });
    const unknown = await request(app, '/rooms/room_unknown');
    assert.equal(unknown.status, 500);
    const payload = await unknown.json();
    assert.equal(payload.error.code, 'MULTIPLAYER_INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(payload), /database path|key must stay private/u);
  });
  assert.deepEqual(logged, ['database path and key must stay private']);
});

await test('chat write route applies member+room limiter before repository work', async () => {
  let appendCalls = 0;
  const operations = mockOperations({
    async createChatMessage() {
      appendCalls += 1;
      return { message_id: 'message_1' };
    }
  });
  const limiter = createChatRateLimiter({
    clock: () => 0,
    burst_limit: 1,
    minute_limit: 2
  });
  await withApiServer({ operations, chatRateLimiter: limiter }, async app => {
    const first = await request(app, '/rooms/room_1/chat/messages', {
      method: 'POST',
      body: { text: 'hello', idempotency_key: 'key_1' }
    });
    assert.equal(first.status, 201);
    const second = await request(app, '/rooms/room_1/chat/messages', {
      method: 'POST',
      body: { text: 'again', idempotency_key: 'key_2' }
    });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '10');
    assert.equal((await second.json()).error.code, 'CHAT_RATE_LIMITED');
  });
  assert.equal(appendCalls, 1);
});

await test('client seat/user/payer and forged chat authority fields are rejected recursively', async () => {
  let calls = 0;
  const operations = mockOperations(Object.fromEntries(
    MULTIPLAYER_HTTP_OPERATION_NAMES.map(name => [name, async () => {
      calls += 1;
      return {};
    }])
  ));
  await withApiServer({ operations }, async app => {
    const cases = [
      ['/rooms', { new_world_profile: { seat: 'A' } }],
      ['/save-imports', { source: { user_id: 'victim' } }],
      ['/rooms/room_1/epochs/2/turns/3/shared-stage-payer', { payer_user_id: 'victim' }],
      ['/rooms/room_1/chat/messages', { text: 'x', sender_seat: 'B' }]
    ];
    for (const [path, body] of cases) {
      const response = await request(app, path, {
        method: path.includes('shared-stage-payer') ? 'PUT' : 'POST',
        body
      });
      assert.equal(response.status, 400, path);
      assert.equal((await response.json()).error.code, 'CLIENT_AUTHORITY_FIELD_FORBIDDEN');
    }
  });
  assert.equal(calls, 0);
});

function repositoryFixture(capture) {
  const noop = async () => ({});
  const core = {
    rooms: { getForMember: noop },
    invites: { join: noop },
    epochs: {
      async getActive() {
        return { epoch_id: 'epoch_active', epoch_no: 2 };
      }
    },
    turns: {
      changeNarrativeMode: noop,
      lockAction: noop,
      async getForMember() {
        return { turn_id: 'turn_3', turn_no: 3, actions: {} };
      }
    },
    chat: { append: noop, listHistory: noop }
  };
  const billing = {
    profiles: { createVersion: noop, list: noop, revoke: noop },
    credentials: { create: noop, list: noop, rotate: noop, revoke: noop },
    selections: {
      selectShared: noop,
      async selectWriter(input) {
        capture.push(input);
        return { selected: true };
      },
      getMemberProjection: noop
    },
    grants: { createVersion: noop, revoke: noop },
    consents: { grant: noop, revoke: noop },
    plans: { get: noop, getLatest: noop, authorize: noop },
    amendments: { propose: noop }
  };
  const lineage = {
    lineage: { getForMember: noop },
    proposals: {
      createArchive: noop,
      createCheckpointResume: noop,
      createLatestSource: noop
    }
  };
  const applicationServices = {
    saveImports: { create: noop },
    rooms: { create: noop, ready: noop },
    capabilityProbes: { run: noop },
    billing: { acceptAmendment: noop },
    turns: { retry: noop, createVoidProposal: noop, acceptVoidProposal: noop },
    lineage: {
      acceptArchiveProposal: noop,
      acceptContinuationProposal: noop,
      beginSinglePlayerExport: noop,
      downloadSinglePlayerExport: noop
    }
  };
  return { core, billing, lineage, applicationServices };
}

await test('repository adapter derives payer from JWT principal and treats path seat only as POV audience', async () => {
  const captured = [];
  const fixture = repositoryFixture(captured);
  const operations = createRepositoryBackedMultiplayerHttpOperations({
    core_repositories: fixture.core,
    billing_repository: fixture.billing,
    lineage_repository: fixture.lineage,
    application_services: fixture.applicationServices
  });
  await operations.selectPovWriter({
    authenticated_user_id: 'jwt_user',
    room_id: 'room_1',
    epoch_no: 2,
    turn_no: 3,
    audience_seat: 'B',
    query: {},
    request: {
      expected_control_revision: 7,
      expected_selection_revision: 0,
      endpoint_profile_id: 'profile_1',
      idempotency_key: 'selection-key'
    }
  });
  assert.deepEqual(captured, [{
    authenticated_user_id: 'jwt_user',
    room_id: 'room_1',
    epoch_id: 'epoch_active',
    turn_no: 3,
    audience: 'B',
    expected_control_revision: 7,
    expected_selection_revision: 0,
    endpoint_profile_id: 'profile_1',
    idempotency_key: 'selection-key'
  }]);
  assert.equal(Object.hasOwn(captured[0], 'payer_user_id'), false);
  assert.equal(Object.hasOwn(captured[0], 'payer_seat'), false);
});

await test('GET turn restores the member-safe payer selection projection', async () => {
  const fixture = repositoryFixture([]);
  const projectionCalls = [];
  const safeProjection = Object.freeze({
    shared: Object.freeze({
      selection_revision: 2,
      selection_hash: `sha256:${'a'.repeat(64)}`,
      payer_seat: 'B',
      profile_ref: Object.freeze({
        adapter: 'openai_compatible',
        endpoint: Object.freeze({ normalized_base_url: 'https://models.example/v1' }),
        model: 'model-safe',
        auth_scheme: 'bearer',
        config_fingerprint: `sha256:${'b'.repeat(64)}`,
        transport_capabilities: Object.freeze({
          native_tools: false,
          strict_json: true,
          error_correction_continuation: true,
          recommended_continuity_transport: 'json_protocol'
        })
      }),
      terms_revision: 'naruto.multiplayer-byok-data-processing/v1',
      data_categories: Object.freeze(['both_action_originals']),
      viewer_consent: Object.freeze({ required: true, granted: false })
    }),
    A: null,
    B: null
  });
  fixture.billing.selections.getMemberProjection = async input => {
    projectionCalls.push(input);
    return safeProjection;
  };
  const operations = createRepositoryBackedMultiplayerHttpOperations({
    core_repositories: fixture.core,
    billing_repository: fixture.billing,
    lineage_repository: fixture.lineage,
    application_services: fixture.applicationServices
  });
  const turn = await operations.getTurn({
    authenticated_user_id: 'jwt_user',
    room_id: 'room_1',
    epoch_no: 2,
    turn_no: 3,
    query: {},
    request: {}
  });
  assert.equal(turn.turn_id, 'turn_3');
  assert.equal(turn.payer_selections, safeProjection);
  assert.deepEqual(projectionCalls, [{
    authenticated_user_id: 'jwt_user',
    room_id: 'room_1',
    epoch_id: 'epoch_active',
    turn_no: 3
  }]);
});

await test('ready operation gates AI setup then starts and authorizes the automatic opening in order', async () => {
  const blockedFixture = repositoryFixture([]);
  let blockedReadyCalls = 0;
  blockedFixture.core.rooms.getForMember = async () => ({
    room_id: 'room_1', origin_type: 'new_multiplayer_save', lifecycle: 'LOBBY'
  });
  blockedFixture.billing.credentialPolicies = {
    async getMemberProjection() {
      return {
        fully_accepted: true,
        bindings_ready: false,
        ready: false
      };
    }
  };
  blockedFixture.applicationServices.rooms.ready = async () => {
    blockedReadyCalls += 1;
    return {};
  };
  const blockedOperations = createRepositoryBackedMultiplayerHttpOperations({
    core_repositories: blockedFixture.core,
    billing_repository: blockedFixture.billing,
    lineage_repository: blockedFixture.lineage,
    application_services: blockedFixture.applicationServices
  });
  await assert.rejects(
    () => blockedOperations.markRoomReady({
      authenticated_user_id: 'jwt_user',
      room_id: 'room_1',
      query: {},
      request: { expected_control_revision: 7 }
    }),
    error => error instanceof DomainError
      && error.code === 'ROOM_AI_SETTINGS_NOT_READY'
      && error.status === 409
      && error.details.bindings_ready === false
  );
  assert.equal(blockedReadyCalls, 0, 'AI readiness must be checked before mutating member readiness');

  const calls = [];
  const fixture = repositoryFixture([]);
  const openingPlanHash = `sha256:${'8'.repeat(64)}`;
  const readyPolicy = Object.freeze({
    fully_accepted: true,
    bindings_ready: true,
    ready: true
  });
  fixture.core.rooms.getForMember = async input => {
    calls.push(['room:before', input]);
    return {
      room_id: 'room_1',
      origin_type: 'new_multiplayer_save',
      lifecycle: 'LOBBY',
      control_revision: 7
    };
  };
  fixture.billing.credentialPolicies = {
    async getMemberProjection(input) {
      calls.push(['policy:get', input]);
      return readyPolicy;
    },
    async materializeActiveTurn(input) {
      calls.push(['policy:materialize', input]);
      return { credential_policy: readyPolicy };
    },
    async autoAuthorizePlan(input) {
      calls.push(['policy:auto-authorize', input]);
      return { turn_status: 'RESOLVING' };
    }
  };
  fixture.applicationServices.rooms.ready = async context => {
    calls.push(['room:ready', context]);
    return {
      all_ready: true,
      room: { room_id: 'room_1', lifecycle: 'ACTIVE' },
      turn: {
        turn_id: 'turn_opening_1',
        turn_no: 1,
        turn_kind: 'OPENING',
        status: 'AWAITING_PAYER_SELECTION'
      }
    };
  };
  fixture.applicationServices.rooms.startOpening = async context => {
    calls.push(['room:start-opening', context]);
    return {
      started: true,
      plan_hash: openingPlanHash,
      turn: {
        turn_id: 'turn_opening_1',
        turn_no: 1,
        turn_kind: 'OPENING',
        status: 'AWAITING_BILLING_AUTHORIZATION'
      }
    };
  };
  fixture.applicationServices.rooms.get = async context => {
    calls.push(['room:fresh', context]);
    return { room_id: 'room_1', origin_type: 'new_multiplayer_save', lifecycle: 'ACTIVE' };
  };
  const operations = createRepositoryBackedMultiplayerHttpOperations({
    core_repositories: fixture.core,
    billing_repository: fixture.billing,
    lineage_repository: fixture.lineage,
    application_services: fixture.applicationServices
  });
  const context = {
    authenticated_user_id: 'jwt_user',
    room_id: 'room_1',
    query: {},
    request: { expected_control_revision: 7 }
  };
  const result = await operations.markRoomReady(context);
  assert.equal(result.turn.turn_kind, 'OPENING');
  assert.equal(result.turn.status, 'RESOLVING');
  assert.equal(result.room.credential_policy, readyPolicy);
  assert.deepEqual(calls.map(call => call[0]), [
    'room:before',
    'policy:get',
    'room:ready',
    'policy:materialize',
    'room:start-opening',
    'policy:auto-authorize',
    'room:fresh',
    'policy:get'
  ]);
  assert.deepEqual(calls.find(call => call[0] === 'policy:auto-authorize')[1], {
    authenticated_user_id: 'jwt_user',
    room_id: 'room_1',
    plan_hash: openingPlanHash
  });
});

await test('next-turn operation opens once and concurrent replays reuse the new active turn', async () => {
  const fixture = repositoryFixture([]);
  let room = {
    room_id: 'room_1', lifecycle: 'ACTIVE', current_turn_id: 'turn_3', control_revision: 8
  };
  const openCalls = [];
  const policyCalls = [];
  fixture.core.rooms.getForMember = async () => room;
  fixture.core.turns.open = async input => {
    openCalls.push(input);
    room = { ...room, current_turn_id: 'turn_4', control_revision: 9 };
    return { turn_id: 'turn_4', turn_no: 4, control_revision: 9 };
  };
  fixture.billing.credentialPolicies = {
    async materializeActiveTurn(input) {
      policyCalls.push(input);
      return { current_turn_id: room.current_turn_id, ready: true };
    }
  };
  const operations = createRepositoryBackedMultiplayerHttpOperations({
    core_repositories: fixture.core,
    billing_repository: fixture.billing,
    lineage_repository: fixture.lineage,
    application_services: fixture.applicationServices
  });
  const context = {
    authenticated_user_id: 'jwt_user',
    room_id: 'room_1',
    query: {},
    request: { previous_turn_id: 'turn_3' }
  };
  const opened = await operations.openNextTurn(context);
  const replayed = await operations.openNextTurn(context);
  assert.equal(opened.turn.turn_id, 'turn_4');
  assert.equal(replayed.turn.turn_id, 'turn_4');
  assert.equal(replayed.turn.existing, true);
  assert.deepEqual(openCalls, [{
    authenticated_user_id: 'jwt_user',
    room_id: 'room_1',
    expected_control_revision: 8
  }]);
  assert.equal(policyCalls.length, 2);
});

await test('invalid JSON and unauthenticated calls are handled inside the API boundary', async () => {
  const operations = mockOperations();
  await withApiServer({ operations }, async app => {
    const invalid = await request(app, '/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{broken'
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'REQUEST_JSON_INVALID');
  });
  await withApiServer({
    operations,
    auth: () => ({ authSource: 'bearer', authExpiresAt: Infinity })
  }, async app => {
    const response = await request(app, '/rooms/room_1');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'AUTHENTICATION_REQUIRED');
  });
});

console.log(`\n${passed} multiplayer HTTP API regression tests passed.`);
