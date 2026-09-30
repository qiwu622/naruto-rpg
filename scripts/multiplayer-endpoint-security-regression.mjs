import assert from 'node:assert/strict';

import { sha256Hex } from '../server/multiplayer/domain/canonical-json.js';
import {
  assertModelEndpointResponseNotRedirected,
  assertPinnedRemoteAddress,
  buildModelAuthenticationHeaders,
  createPinnedEndpointLookup,
  isPublicModelEndpointAddress,
  normalizeModelEndpointBaseUrl,
  validateModelEndpointNetwork
} from '../server/multiplayer/security/endpoint-policy.js';

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function hash(seed) {
  return `sha256:${sha256Hex(seed)}`;
}

function profile(overrides = {}) {
  const base = overrides.normalized_base_url ?? 'https://models.example.com/v1';
  const origin = new URL(base).origin;
  return {
    schema: 'naruto.multiplayer-model-endpoint-profile/v1',
    profile_id: 'profile-security-test',
    owner_user_id: '123456789012345678',
    config_revision: 1,
    adapter: 'openai_compatible',
    endpoint: {
      normalized_base_url: base,
      normalized_origin: origin
    },
    model: 'model-v1',
    auth_scheme: 'bearer',
    credential_ref: { credential_id: 'credential-security-test', credential_revision: 1 },
    capabilities: {
      native_tools: false,
      strict_json: true,
      error_correction_continuation: true
    },
    recommended_continuity_transport: 'json_protocol',
    config_fingerprint: hash('profile-security-v1'),
    ...overrides,
    endpoint: overrides.endpoint ?? {
      normalized_base_url: base,
      normalized_origin: origin
    }
  };
}

await test('endpoint normalization accepts public HTTPS and removes only trailing slashes', () => {
  assert.deepEqual(normalizeModelEndpointBaseUrl('https://Models.Example.COM:443/v1///'), {
    normalized_base_url: 'https://models.example.com/v1',
    normalized_origin: 'https://models.example.com',
    hostname: 'models.example.com',
    port: 443
  });
  assert.equal(
    normalizeModelEndpointBaseUrl('https://models.example.com:8443/v1').port,
    8443
  );
});

await test('userinfo, query secrets, fragments, HTTP and risky privileged ports are rejected', () => {
  const invalid = [
    'http://models.example.com/v1',
    'https://user:secret@models.example.com/v1',
    'https://models.example.com/v1?api_key=secret',
    'https://models.example.com/v1#token',
    'https://models.example.com:22/v1',
    'https://localhost/v1',
    'https://metadata.google.internal/v1'
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeModelEndpointBaseUrl(value), error => (
      error.code === 'MODEL_ENDPOINT_FORBIDDEN'
      || error.code === 'MODEL_ENDPOINT_PORT_FORBIDDEN'
    ));
  }
});

await test('private, loopback, link-local, metadata, reserved and mapped addresses are blocked', () => {
  const blocked = [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1'
  ];
  for (const address of blocked) assert.equal(isPublicModelEndpointAddress(address), false, address);
  assert.equal(isPublicModelEndpointAddress('93.184.216.34'), true);
  assert.equal(isPublicModelEndpointAddress('2606:4700:4700::1111'), true);
});

await test('every A/AAAA response is validated and one private answer rejects the endpoint', async () => {
  const valid = await validateModelEndpointNetwork('https://models.example.com/v1', {
    lookup: async (_hostname, options) => {
      assert.equal(options.all, true);
      assert.equal(options.verbatim, true);
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 }
      ];
    }
  });
  assert.equal(valid.addresses.length, 2);
  await assert.rejects(
    validateModelEndpointNetwork('https://models.example.com/v1', {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ]
    }),
    error => error.code === 'MODEL_ENDPOINT_FORBIDDEN'
  );
});

await test('DNS is revalidated for every outbound attempt and rebinding fails closed', async () => {
  let lookupCalls = 0;
  const lookup = async () => {
    lookupCalls += 1;
    return lookupCalls === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '169.254.169.254', family: 4 }];
  };
  await validateModelEndpointNetwork('https://models.example.com/v1', { lookup });
  await assert.rejects(
    validateModelEndpointNetwork('https://models.example.com/v1', { lookup }),
    error => error.code === 'MODEL_ENDPOINT_FORBIDDEN'
  );
  assert.equal(lookupCalls, 2);
});

await test('pinned lookup and connected socket checks cannot switch host or address', async () => {
  const validation = await validateModelEndpointNetwork('https://models.example.com/v1', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  const lookup = createPinnedEndpointLookup(validation);
  const resolved = await new Promise((resolve, reject) => {
    lookup('models.example.com', { family: 4 }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(resolved, { address: '93.184.216.34', family: 4 });
  await assert.rejects(new Promise((resolve, reject) => {
    lookup('other.example.com', {}, error => (error ? reject(error) : resolve()));
  }), error => error.code === 'MODEL_ENDPOINT_PIN_MISMATCH');
  assert.equal(assertPinnedRemoteAddress(validation, '93.184.216.34'), true);
  assert.equal(assertPinnedRemoteAddress(validation, '::ffff:93.184.216.34'), true);
  assert.throws(
    () => assertPinnedRemoteAddress(validation, '1.1.1.1'),
    error => error.code === 'MODEL_ENDPOINT_PIN_MISMATCH'
  );
});

await test('authentication headers are adapter-owned and never accept arbitrary names', () => {
  assert.deepEqual(buildModelAuthenticationHeaders(profile(), Buffer.from('sk-secret')), {
    authorization: 'Bearer sk-secret'
  });
  const noAuth = profile({
    auth_scheme: 'none',
    credential_ref: null
  });
  assert.deepEqual(buildModelAuthenticationHeaders(noAuth), {});
  assert.throws(
    () => buildModelAuthenticationHeaders(noAuth, 'unexpected-secret'),
    error => error.code === 'MODEL_AUTH_SECRET_FORBIDDEN'
  );
  const anthropicBearer = profile({ adapter: 'anthropic' });
  assert.throws(
    () => buildModelAuthenticationHeaders(anthropicBearer, 'secret'),
    error => error.code === 'MODEL_AUTH_SCHEME_FORBIDDEN'
  );
  assert.throws(
    () => buildModelAuthenticationHeaders(profile(), 'bad\r\nX-Internal: stolen'),
    error => error.code === 'MODEL_AUTH_SECRET_INVALID'
  );
});

await test('all redirects are refused before any credential can cross destinations', () => {
  assert.equal(assertModelEndpointResponseNotRedirected(200), true);
  for (const status of [301, 302, 303, 307, 308]) {
    assert.throws(
      () => assertModelEndpointResponseNotRedirected(status, 'https://other.example.com/v1'),
      error => error.code === 'MODEL_ENDPOINT_REDIRECT_FORBIDDEN'
    );
  }
});

console.log(`\n${passed} multiplayer endpoint-security regression tests passed.`);
