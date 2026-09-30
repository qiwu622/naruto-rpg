import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  MultiplayerApiClient,
  MultiplayerApiError,
  cookieValue,
  defaultMultiplayerRequestHeaders
} from '../js/multiplayer/api-client.js';
import {
  GUEST_CHARACTER_IMPORT_SCHEMA,
  assertNoClientAuthorityFields,
  createIdempotencyKey
} from '../js/multiplayer/contracts.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const originalDocument = globalThis.document;
const csrfToken = 'a'.repeat(64);
globalThis.document = { cookie: `naruto_csrf=${csrfToken}` };

const calls = [];
const fetchImpl = async (url, init) => {
  calls.push({
    url,
    method: init.method,
    body: init.body === undefined ? undefined : JSON.parse(init.body),
    credentials: init.credentials,
    cache: init.cache,
    headers: init.headers
  });
  if (url.endsWith('/content')) {
    return new Response('{"export":true}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="safe-export.json"'
      }
    });
  }
  return new Response('{}', {
    status: init.method === 'POST' ? 201 : 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

const api = new MultiplayerApiClient({ fetchImpl });
const room = 'room_1';
const profile = 'profile_1';
const credential = 'credential_1';
const grant = 'grant_1';
const consent = 'consent_1';
const submission = 'action_1';
const amendment = 'amendment_1';
const proposal = 'proposal_1';
const checkpoint = 'checkpoint_1';
const exportId = 'export_1';

await api.createSaveImport({
  source_save_id: 'save_1',
  state: { actors: [{ seat: 'A', user_id: 'legacy-save-value' }] },
  source_timeline: {
    export_version: '2.0',
    nodes: [{ node_id: 'node_1', room_id: 'opaque-save-value' }]
  },
  source_document: {
    multiplayer_export: { room_id: 'server-export-room' },
    multiplayer_record_sidecar: { actor_bindings: [{ seat: 'B' }] }
  }
});
await api.createRoom({ origin_type: 'new_multiplayer_save' });
await api.joinRoom(room, {
  token: 'secret-invite',
  guest_character: {
    schema: GUEST_CHARACTER_IMPORT_SCHEMA,
    state_snapshot: {
      _version: '5.0',
      '玩家·姓名': '客方角色',
      user_id: 'opaque-single-player-value',
      seat: 'opaque-single-player-value'
    }
  }
});
await api.getRoom(room);
await api.markRoomReady(room, {
  expected_control_revision: 1,
  proposal_revision: 1,
  audience_diff_commitment: 'hmac-sha256:viewer-safe-diff'
});
await api.openNextTurn(room, 'turn_1');
await api.changeNarrativeMode(room, {
  expected_control_revision: 1,
  mode: 'shared',
  idempotency_key: 'idem_1'
});
await api.changeNarrativePreset(room, {
  expected_control_revision: 1,
  source_seat: 'B'
});
await api.chooseCredentialUsagePolicy(room, {
  policy: 'ALTERNATE',
  expected_policy_revision: 0,
  expected_control_revision: 1
});
await api.bindRoomModelProfile(room, {
  endpoint_profile_id: profile,
  expected_binding_revision: 0,
  expected_control_revision: 2
});
await api.createModelEndpointProfile({ adapter: 'openai_compatible' });
await api.listModelEndpointProfiles({ includeRevoked: false });
await api.updateModelEndpointProfile(profile, { expected_config_revision: 1 });
await api.revokeModelEndpointProfile(profile, { config_revision: 1 });
await api.runModelCapabilityProbe(profile, {
  profile_revision: 1,
  credential_revision: 1,
  requested_capabilities: ['native_tools', 'strict_json', 'error_correction_continuation'],
  max_requests: 3,
  max_input_tokens: 448,
  max_output_tokens: 768,
  idempotency_key: 'probe_1'
});
await api.createModelCredential({ endpoint_origin: 'https://example.com', plaintext: 'key-value' });
await api.listModelCredentials({ includeRevoked: false });
await api.rotateModelCredential(credential, {
  expected_credential_revision: 1,
  endpoint_origin: 'https://example.com',
  plaintext: 'new-key'
});
await api.revokeModelCredential(credential, { credential_revision: 2 });
await api.createExecutionGrant(room, {
  grant_id: grant,
  expected_grant_revision: 0,
  authorization_scope: { kind: 'single_turn', turn_id: 'turn_1' }
});
await api.revokeExecutionGrant(room, grant, { grant_revision: 1 });
await api.grantDataProcessingConsent(room, { selection_hash: 'sha256:abc' });
await api.revokeDataProcessingConsent(room, consent);
await api.listChatMessages(room, { before: 'message_1', limit: 50 });
await api.createChatMessage(room, { text: '协调消息', idempotency_key: 'chat_1' });
await api.selectSharedStagePayer(room, 1, 2, { endpoint_profile_id: profile });
await api.selectPovWriter(room, 1, 2, 'A', { endpoint_profile_id: profile });
await api.lockAction(room, 1, 2, { text: '行动' });
await api.getTurn(room, 1, 2);
await api.getAction(room, 1, 2, submission);
await api.getBillingPlan(room, 1, 2);
await api.authorizeBillingPlan(room, 1, 2, { plan_hash: 'sha256:abc' });
await api.proposeBillingPlanAmendment(room, 1, 2, { future_stage_changes: [] });
await api.acceptBillingPlanAmendment(room, 1, 2, amendment);
await api.retryTurn(room, 1, 2, { expected_control_revision: 4 });
await api.createTurnVoidProposal(room, 1, 2, { proposal_id: proposal });
await api.acceptTurnVoidProposal(room, 1, 2, proposal, { proposal_revision: 1 });
await api.getLineage(room);
await api.createArchiveProposal(room, { proposal_id: proposal });
await api.acceptArchiveProposal(room, proposal, { proposal_revision: 1 });
await api.createContinuationProposal(room, { continuation_mode: 'resume_room_checkpoint' });
await api.acceptContinuationProposal(room, proposal, { proposal_revision: 1 });
await api.beginSinglePlayerExport(room, checkpoint, { idempotency_key: 'export_1' });
const downloaded = await api.downloadSinglePlayerExport(room, exportId);

const expected = [
  ['POST', '/api/multiplayer/save-imports'],
  ['POST', '/api/multiplayer/rooms'],
  ['POST', `/api/multiplayer/rooms/${room}/join`],
  ['GET', `/api/multiplayer/rooms/${room}`],
  ['POST', `/api/multiplayer/rooms/${room}/ready`],
  ['POST', `/api/multiplayer/rooms/${room}/turns/next`],
  ['PUT', `/api/multiplayer/rooms/${room}/settings/narrative-mode`],
  ['PUT', `/api/multiplayer/rooms/${room}/settings/narrative-preset`],
  ['PUT', `/api/multiplayer/rooms/${room}/settings/credential-policy`],
  ['PUT', `/api/multiplayer/rooms/${room}/model-profile-binding`],
  ['POST', '/api/multiplayer/model-endpoint-profiles'],
  ['GET', '/api/multiplayer/model-endpoint-profiles?include_revoked=false'],
  ['PUT', `/api/multiplayer/model-endpoint-profiles/${profile}`],
  ['DELETE', `/api/multiplayer/model-endpoint-profiles/${profile}`],
  ['POST', `/api/multiplayer/model-endpoint-profiles/${profile}/capability-probes`],
  ['POST', '/api/multiplayer/model-credentials'],
  ['GET', '/api/multiplayer/model-credentials?include_revoked=false'],
  ['POST', `/api/multiplayer/model-credentials/${credential}/rotate`],
  ['DELETE', `/api/multiplayer/model-credentials/${credential}`],
  ['POST', `/api/multiplayer/rooms/${room}/execution-grants`],
  ['DELETE', `/api/multiplayer/rooms/${room}/execution-grants/${grant}`],
  ['POST', `/api/multiplayer/rooms/${room}/data-processing-consents`],
  ['DELETE', `/api/multiplayer/rooms/${room}/data-processing-consents/${consent}`],
  ['GET', `/api/multiplayer/rooms/${room}/chat/messages?before=message_1&limit=50`],
  ['POST', `/api/multiplayer/rooms/${room}/chat/messages`],
  ['PUT', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/shared-stage-payer`],
  ['PUT', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/pov-writer-selections/A`],
  ['POST', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/actions`],
  ['GET', `/api/multiplayer/rooms/${room}/epochs/1/turns/2`],
  ['GET', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/actions/${submission}`],
  ['GET', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/billing-plan`],
  ['POST', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/billing-plan/authorizations`],
  ['POST', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/billing-plan/amendments`],
  ['POST', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/billing-plan/amendments/${amendment}/accept`],
  ['POST', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/retry`],
  ['POST', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/void-proposals`],
  ['POST', `/api/multiplayer/rooms/${room}/epochs/1/turns/2/void-proposals/${proposal}/accept`],
  ['GET', `/api/multiplayer/rooms/${room}/lineage`],
  ['POST', `/api/multiplayer/rooms/${room}/archive-proposals`],
  ['POST', `/api/multiplayer/rooms/${room}/archive-proposals/${proposal}/accept`],
  ['POST', `/api/multiplayer/rooms/${room}/continuation-proposals`],
  ['POST', `/api/multiplayer/rooms/${room}/continuation-proposals/${proposal}/accept`],
  ['POST', `/api/multiplayer/rooms/${room}/checkpoints/${checkpoint}/single-player-exports`],
  ['GET', `/api/multiplayer/rooms/${room}/single-player-exports/${exportId}/content`]
];

assert.deepEqual(calls.map(call => [call.method, call.url]), expected);
assert.deepEqual(calls[0].body.source_timeline.nodes, [{
  node_id: 'node_1',
  room_id: 'opaque-save-value'
}]);
assert.equal(calls[0].body.state.actors[0].seat, 'A');
assert.equal(calls[0].body.source_document.multiplayer_export.room_id, 'server-export-room');
assert.equal(calls[2].body.guest_character.schema, GUEST_CHARACTER_IMPORT_SCHEMA);
assert.equal(
  calls[2].body.guest_character.state_snapshot.user_id,
  'opaque-single-player-value',
  'guest snapshot is opaque only below the exact join envelope field'
);
assert.deepEqual(calls[4].body, {
  expected_control_revision: 1,
  proposal_revision: 1,
  audience_diff_commitment: 'hmac-sha256:viewer-safe-diff'
});
assert.equal(calls.every(call => call.credentials === 'same-origin'), true);
assert.equal(calls.every(call => call.cache === 'no-store'), true);
assert.equal(calls.every(call => (
  ['GET', 'HEAD', 'OPTIONS'].includes(call.method)
    ? !Object.hasOwn(call.headers, 'X-CSRF-Token')
    : call.headers['X-CSRF-Token'] === csrfToken
)), true, 'every default cookie-authenticated write must mirror naruto_csrf exactly');
assert.equal(downloaded.filename, 'safe-export.json');
assert.equal(await downloaded.blob.text(), '{"export":true}');
assert.equal(api.eventsUrl(room, 42), `/api/multiplayer/rooms/${room}/events?after=42`);

assert.throws(
  () => new MultiplayerApiClient({ baseUrl: 'https://evil.example/api', fetchImpl }),
  /same-origin/u
);
assert.throws(
  () => assertNoClientAuthorityFields({ nested: { payer_user_id: 'attacker' } }),
  /authority field/u
);
assert.throws(
  () => assertNoClientAuthorityFields({ seat: 'A' }),
  /authority field/u
);
assert.match(createIdempotencyKey('action'), /^action-[A-Za-z0-9-]+$/u);
assert.equal(cookieValue('other=1; naruto_csrf=abc%20123', 'naruto_csrf'), 'abc 123');

assert.deepEqual(defaultMultiplayerRequestHeaders({ method: 'GET' }), {});
assert.deepEqual(defaultMultiplayerRequestHeaders({ method: 'POST' }), {
  'X-CSRF-Token': csrfToken
});
globalThis.document.cookie = 'naruto_csrf=not-a-token';
assert.throws(
  () => defaultMultiplayerRequestHeaders({ method: 'POST' }),
  /valid naruto_csrf cookie/u
);
globalThis.document.cookie = `naruto_csrf=${csrfToken}`;
const csrfCalls = [];
const csrfClient = new MultiplayerApiClient({
  fetchImpl: async (_url, init) => {
    csrfCalls.push(init.headers);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
});
await csrfClient.getRoom(room);
await csrfClient.createRoom({ origin_type: 'new_multiplayer_save' });
assert.equal(Object.hasOwn(csrfCalls[0], 'X-CSRF-Token'), false);
assert.equal(csrfCalls[1]['X-CSRF-Token'], csrfToken);
if (originalDocument === undefined) delete globalThis.document;
else globalThis.document = originalDocument;

const forbiddenClient = new MultiplayerApiClient({
  fetchImpl: async () => {
    throw new Error('network should not be reached');
  }
});
await assert.rejects(
  forbiddenClient.createRoom({ nested: { user_id: 'forged' } }),
  error => error instanceof TypeError && /authority field/u.test(error.message)
);
await assert.rejects(
  forbiddenClient.createSaveImport({
    user_id: 'forged-top-level',
    source_document: { nested: { user_id: 'opaque-only-below-the-envelope' } }
  }),
  error => error instanceof TypeError && /authority field/u.test(error.message)
);
await assert.rejects(
  forbiddenClient.createRoom({
    source_document: { nested: { user_id: 'not-opaque-on-another-route' } }
  }),
  error => error instanceof TypeError && /authority field/u.test(error.message)
);
await assert.rejects(
  forbiddenClient.joinRoom(room, {
    token: 'secret-invite',
    user_id: 'forged-top-level',
    guest_character: {
      schema: GUEST_CHARACTER_IMPORT_SCHEMA,
      state_snapshot: { user_id: 'opaque-below-envelope' }
    }
  }),
  error => error instanceof TypeError && /authority field/u.test(error.message)
);

const failingClient = new MultiplayerApiClient({
  fetchImpl: async () => new Response(JSON.stringify({
    error: { code: 'STALE_CONTROL_REVISION', message: 'stale', details: { actual: 9 } }
  }), { status: 409, headers: { 'Content-Type': 'application/json' } })
});
await assert.rejects(
  failingClient.getRoom(room),
  error => error instanceof MultiplayerApiError
    && error.code === 'STALE_CONTROL_REVISION'
    && error.status === 409
    && error.details.actual === 9
);

console.log(`multiplayer UI API regression: ${expected.length} REST + 1 SSE route passed`);
