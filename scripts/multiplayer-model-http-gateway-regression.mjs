import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

import {
  MODEL_ENDPOINT_PROFILE_SCHEMA
} from '../server/multiplayer/contracts/billing-contracts.js';
import { createCredentialVault } from '../server/multiplayer/security/credential-vault.js';
import { createModelHttpGateway } from '../server/multiplayer/security/model-http-gateway.js';

const HASH = value => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function profile({
  authScheme = 'none',
  adapter = 'openai_compatible',
  baseUrl = 'https://models.example.test/v1'
} = {}) {
  const origin = new URL(baseUrl).origin;
  return {
    schema: MODEL_ENDPOINT_PROFILE_SCHEMA,
    profile_id: 'profile_A',
    owner_user_id: '100000000000000001',
    config_revision: 1,
    adapter,
    endpoint: {
      normalized_base_url: baseUrl,
      normalized_origin: origin
    },
    model: 'model-v1',
    auth_scheme: adapter === 'anthropic' && authScheme === 'bearer' ? 'x-api-key' : authScheme,
    credential_ref: authScheme === 'none' ? null : {
      credential_id: 'credential_A',
      credential_revision: 1
    },
    capabilities: {
      native_tools: false,
      strict_json: true,
      error_correction_continuation: true
    },
    recommended_continuity_transport: 'json_protocol',
    config_fingerprint: HASH('profile')
  };
}

function fakeHttps({
  statusCode = 200,
  responseBody = { id: 'response_1', ok: true },
  responseHeaders = { 'content-type': 'application/json', 'x-request-id': 'provider_1' },
  remoteAddress = '8.8.8.8'
} = {}) {
  const calls = [];
  const requestImpl = (options, onResponse) => {
    const request = new EventEmitter();
    request.setTimeout = (_milliseconds, callback) => { request.timeoutCallback = callback; };
    request.destroy = error => queueMicrotask(() => request.emit('error', error));
    request.end = body => {
      calls.push({ options, body: Buffer.from(body) });
      const socket = new EventEmitter();
      socket.remoteAddress = remoteAddress;
      request.emit('socket', socket);
      queueMicrotask(() => {
        socket.emit('secureConnect');
        const response = new EventEmitter();
        response.statusCode = statusCode;
        response.headers = responseHeaders;
        response.resume = () => {};
        response.destroy = () => {};
        onResponse(response);
        queueMicrotask(() => {
          response.emit('data', Buffer.from(JSON.stringify(responseBody)));
          response.emit('end');
        });
      });
    };
    return request;
  };
  return { calls, requestImpl };
}

function lookupCounter() {
  let count = 0;
  return {
    get count() { return count; },
    async lookup() {
      count += 1;
      return [{ address: '8.8.8.8', family: 4 }];
    }
  };
}

await test('gateway revalidates DNS, pins the public socket and sends one fixed adapter path', async () => {
  const fake = fakeHttps();
  const dns = lookupCounter();
  const gateway = createModelHttpGateway({ lookup: dns.lookup, requestImpl: fake.requestImpl });
  const result = await gateway.invoke({
    profile: profile(),
    owner_user_id: '100000000000000001',
    body: { z: 1, a: 'fixed prompt' }
  });
  assert.equal(dns.count, 1);
  assert.equal(fake.calls.length, 1);
  const [{ options, body }] = fake.calls;
  assert.equal(options.hostname, 'models.example.test');
  assert.equal(options.path, '/v1/chat/completions');
  assert.equal(options.agent, false);
  assert.deepEqual(JSON.parse(body.toString('utf8')), { a: 'fixed prompt', z: 1 });
  await new Promise((resolve, reject) => options.lookup(
    'models.example.test',
    { all: true },
    (error, addresses) => error ? reject(error) : (assert.deepEqual(addresses, [
      { address: '8.8.8.8', family: 4 }
    ]), resolve())
  ));
  assert.deepEqual(result, {
    status_code: 200,
    provider_request_id: 'provider_1',
    body: { id: 'response_1', ok: true }
  });
});

await test('provider operation paths append their API version exactly once', async () => {
  for (const [baseUrl, expectedPath] of [
    ['https://models.example.test', '/v1/messages'],
    ['https://models.example.test/v1', '/v1/messages'],
    ['https://models.example.test/relay/v1', '/relay/v1/messages'],
    ['https://models.example.test/v1/messages', '/v1/messages']
  ]) {
    const fake = fakeHttps();
    const gateway = createModelHttpGateway({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      requestImpl: fake.requestImpl
    });
    await gateway.invoke({
      profile: profile({ adapter: 'anthropic', baseUrl }),
      owner_user_id: '100000000000000001',
      body: { messages: [] }
    });
    assert.equal(fake.calls[0].options.path, expectedPath);
  }
});

await test('authenticated profile decrypts an owner/origin-bound credential only for the request', async () => {
  const vault = createCredentialVault({
    masterKeys: { mk1: Buffer.alloc(32, 1) },
    activeMasterKeyVersion: 'mk1',
    fingerprintKey: Buffer.alloc(32, 2)
  });
  const credential = vault.sealCredential({
    credential_id: 'credential_A',
    owner_user_id: '100000000000000001',
    endpoint_origin: 'https://models.example.test',
    plaintext: 'secret-player-key',
    created_at: '2026-08-22T00:00:00.000Z'
  });
  const authenticatedProfile = {
    ...profile({ authScheme: 'bearer' }),
    credential_ref: {
      credential_id: credential.credential_id,
      credential_revision: credential.credential_revision
    }
  };
  const fake = fakeHttps();
  const gateway = createModelHttpGateway({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: fake.requestImpl
  });
  const result = await gateway.invoke({
    profile: authenticatedProfile,
    credential,
    credential_vault: vault,
    owner_user_id: credential.owner_user_id,
    body: { messages: [] }
  });
  assert.equal(fake.calls[0].options.headers.authorization, 'Bearer secret-player-key');
  assert.equal(JSON.stringify(result).includes('secret-player-key'), false);
  await assert.rejects(() => gateway.invoke({
    profile: authenticatedProfile,
    credential,
    credential_vault: vault,
    owner_user_id: '100000000000000002',
    body: { messages: [] }
  }), error => error.code === 'CREDENTIAL_OWNER_MISMATCH');
});

await test('connected address mismatch fails before accepting any response', async () => {
  const fake = fakeHttps({ remoteAddress: '127.0.0.1' });
  const gateway = createModelHttpGateway({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: fake.requestImpl
  });
  await assert.rejects(() => gateway.invoke({
    profile: profile(),
    owner_user_id: '100000000000000001',
    body: { messages: [] }
  }), error => error.code === 'MODEL_ENDPOINT_PIN_MISMATCH');
});

await test('redirect and non-success responses never become model output', async () => {
  const redirect = fakeHttps({ statusCode: 307, responseHeaders: { location: 'https://evil.example' } });
  const redirectGateway = createModelHttpGateway({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: redirect.requestImpl
  });
  await assert.rejects(() => redirectGateway.invoke({
    profile: profile(),
    owner_user_id: '100000000000000001',
    body: { messages: [] }
  }), error => error.code === 'MODEL_ENDPOINT_REDIRECT_FORBIDDEN');

  const upstreamError = fakeHttps({ statusCode: 429 });
  const errorGateway = createModelHttpGateway({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: upstreamError.requestImpl
  });
  await assert.rejects(() => errorGateway.invoke({
    profile: profile(),
    owner_user_id: '100000000000000001',
    body: { messages: [] }
  }), error => error.code === 'MODEL_ENDPOINT_UPSTREAM_ERROR'
    && error.details.upstream_status === 429
    && error.details.upstream_error_summary === null);
});

await test('non-success responses expose only a bounded redacted provider summary', async () => {
  const upstreamError = fakeHttps({
    statusCode: 400,
    responseBody: {
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_parameter',
        message: 'Bearer sk-super-secret-value is invalid for temperature'
      }
    }
  });
  const gateway = createModelHttpGateway({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: upstreamError.requestImpl
  });
  await assert.rejects(() => gateway.invoke({
    profile: profile(),
    owner_user_id: '100000000000000001',
    body: { messages: [] }
  }), error => {
    assert.equal(error.code, 'MODEL_ENDPOINT_UPSTREAM_ERROR');
    assert.equal(error.details.upstream_error_type, 'invalid_request_error');
    assert.equal(error.details.upstream_error_code, 'unsupported_parameter');
    assert.match(error.details.upstream_error_summary, /\[redacted\]/u);
    assert.doesNotMatch(error.details.upstream_error_summary, /super-secret/u);
    return true;
  });
});

await test('configured forward proxy is reused after local DNS policy validation', async () => {
  const fake = fakeHttps({ remoteAddress: '127.0.0.1' });
  const proxyAgent = { kind: 'trusted-forward-proxy-agent' };
  const gateway = createModelHttpGateway({
    lookup: async () => [{ address: '198.18.0.9', family: 4 }],
    requestImpl: fake.requestImpl,
    forward_proxy_agent: proxyAgent,
    allow_fake_ip_dns: true
  });
  await gateway.invoke({
    profile: profile(),
    owner_user_id: '100000000000000001',
    body: { messages: [] }
  });
  assert.equal(fake.calls[0].options.agent, proxyAgent);
  assert.equal(Object.hasOwn(fake.calls[0].options, 'lookup'), false);
});

await test('DNS is revalidated for every invocation rather than cached across turns', async () => {
  const fake = fakeHttps();
  const dns = lookupCounter();
  const gateway = createModelHttpGateway({ lookup: dns.lookup, requestImpl: fake.requestImpl });
  for (let index = 0; index < 2; index += 1) {
    await gateway.invoke({
      profile: profile(),
      owner_user_id: '100000000000000001',
      body: { request: index }
    });
  }
  assert.equal(dns.count, 2);
});

console.log(`\n${passed} multiplayer model HTTP gateway regression tests passed.`);
