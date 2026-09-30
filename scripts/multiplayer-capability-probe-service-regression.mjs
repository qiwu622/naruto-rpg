import assert from 'node:assert/strict';

import {
  createProviderSession
} from '../server/multiplayer/agent/provider-adapters.js';
import {
  createCapabilityProbeApplicationService
} from '../server/multiplayer/application/capability-probe-service.js';

function fakeBillingRepository() {
  let probe = null;
  let nextId = 1;
  return {
    probes: {
      async create(input) {
        if (probe !== null) {
          return { probe, replayed: true };
        }
        probe = {
          probe_id: `probe_${nextId++}`,
          profile_id: input.profile_id,
          profile_revision: input.profile_revision,
          status: 'PENDING',
          result: null
        };
        return { probe, replayed: false };
      },
      async start() {
        if (probe.status === 'RUNNING') return { probe, replayed: true };
        probe = { ...probe, status: 'RUNNING' };
        return { probe, replayed: false };
      },
      async complete(input) {
        probe = {
          ...probe,
          status: 'SUCCEEDED',
          result: input.result,
          recommended_transport: input.recommended_transport
        };
        return { probe, replayed: false };
      },
      async fail() {
        probe = { ...probe, status: 'FAILED' };
        return { probe, replayed: false };
      }
    },
    setProbe(next) {
      probe = next;
    },
    getProbe() {
      return probe;
    }
  };
}

function nativeModelClient(values) {
  const calls = [];
  return {
    calls,
    async invoke(request) {
      calls.push(request);
      const value = values[calls.length - 1];
      return {
        session: request.session ?? createProviderSession('openai_compatible'),
        response: {
          raw_text: null,
          tool_calls: [{
            id: `tool_${calls.length}`,
            name: 'public_probe_command',
            raw_arguments: JSON.stringify({
              schema: 'naruto.multiplayer-public-probe-command/v1',
              nonce: 'public-fixed-probe-v1',
              value
            })
          }]
        }
      };
    }
  };
}

function jsonModelClient(values) {
  const calls = [];
  return {
    calls,
    async invoke(request) {
      calls.push(request);
      const value = values[calls.length - 1];
      return {
        session: request.session ?? createProviderSession('openai_compatible'),
        response: {
          raw_text: JSON.stringify({
            schema: 'naruto.multiplayer-public-probe-command/v1',
            nonce: 'public-fixed-probe-v1',
            value
          }),
          tool_calls: []
        }
      };
    }
  };
}

const baseContext = {
  authenticated_user_id: 'user_A',
  profile_id: 'profile_A',
  request: {
    profile_revision: 1,
    credential_revision: null,
    requested_capabilities: ['native_tools', 'error_correction_continuation'],
    max_requests: 2,
    max_input_tokens: 320,
    max_output_tokens: 512,
    idempotency_key: 'probe-request-1'
  }
};

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

await test('native probe preserves one provider session and proves machine-error correction', async () => {
  const billing = fakeBillingRepository();
  const model = nativeModelClient([7, 11]);
  const service = createCapabilityProbeApplicationService({
    billingRepository: billing,
    providerModelClient: model,
    clock: () => '2026-08-22T00:00:00.000Z'
  });
  const result = await service.run(baseContext);
  assert.equal(result.probe.status, 'SUCCEEDED');
  assert.equal(result.probe.recommended_transport, 'native_tools');
  assert.equal(result.probe.result.requests_used, 2);
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls[1].prompt, null);
  assert.equal(model.calls[1].session.entries.at(-1).kind, 'trusted_protocol_results');
  assert.deepEqual(model.calls[1].session.entries.at(-1).tool_call_ids, ['tool_1']);
  assert.equal(JSON.stringify(model.calls).includes('room_'), false);
});

await test('strict JSON plus same-session correction is accepted without native tools', async () => {
  const billing = fakeBillingRepository();
  const model = jsonModelClient([7, 11]);
  const service = createCapabilityProbeApplicationService({
    billingRepository: billing,
    providerModelClient: model,
    clock: () => '2026-08-22T00:00:00.000Z'
  });
  const result = await service.run({
    ...baseContext,
    request: {
      ...baseContext.request,
      requested_capabilities: ['strict_json', 'error_correction_continuation']
    }
  });
  assert.equal(result.probe.recommended_transport, 'json_protocol');
  assert.equal(result.probe.result.capabilities.native_tools, false);
  assert.equal(result.probe.result.capabilities.strict_json, true);
  assert.equal(model.calls[1].session.entries.at(-1).kind, 'trusted_protocol_results');
  assert.deepEqual(model.calls[1].session.entries.at(-1).tool_call_ids, []);
});

await test('native invocation failure falls back to JSON correction in one provider session', async () => {
  const billing = fakeBillingRepository();
  const calls = [];
  const model = {
    calls,
    async invoke(request) {
      calls.push(request);
      if (calls.length === 1) throw new Error('native tools unsupported');
      const value = calls.length === 2 ? 7 : 11;
      return {
        session: request.session ?? createProviderSession('openai_compatible'),
        response: {
          raw_text: JSON.stringify({
            schema: 'naruto.multiplayer-public-probe-command/v1',
            nonce: 'public-fixed-probe-v1',
            value
          }),
          tool_calls: []
        }
      };
    }
  };
  const service = createCapabilityProbeApplicationService({
    billingRepository: billing,
    providerModelClient: model,
    clock: () => '2026-08-22T00:00:00.000Z'
  });
  const result = await service.run({
    ...baseContext,
    request: {
      ...baseContext.request,
      requested_capabilities: [
        'native_tools',
        'strict_json',
        'error_correction_continuation'
      ],
      max_requests: 3,
      max_input_tokens: 768,
      max_output_tokens: 768
    }
  });
  assert.equal(result.probe.recommended_transport, 'json_protocol');
  assert.deepEqual(calls.map(call => call.output.mode), [
    'native_tools',
    'json_object',
    'json_object'
  ]);
  assert.deepEqual(calls.map(call => call.max_output_tokens), [256, 256, 256]);
  assert.equal(calls[2].prompt, null);
  assert.equal(calls[2].session.entries.at(-1).kind, 'trusted_protocol_results');
});

await test('an exact completed replay never issues another provider request', async () => {
  const billing = fakeBillingRepository();
  const model = nativeModelClient([7, 11]);
  const service = createCapabilityProbeApplicationService({
    billingRepository: billing,
    providerModelClient: model
  });
  await service.run(baseContext);
  const replay = await service.run(baseContext);
  assert.equal(replay.replayed, true);
  assert.equal(model.calls.length, 2);
});

await test('a durable RUNNING replay is observed instead of risking duplicate billing', async () => {
  const billing = fakeBillingRepository();
  billing.setProbe({
    probe_id: 'probe_running',
    profile_id: 'profile_A',
    profile_revision: 1,
    status: 'RUNNING',
    result: null
  });
  const model = nativeModelClient([7, 11]);
  const service = createCapabilityProbeApplicationService({
    billingRepository: billing,
    providerModelClient: model
  });
  const result = await service.run(baseContext);
  assert.equal(result.probe.status, 'RUNNING');
  assert.equal(model.calls.length, 0);
});

console.log(`multiplayer capability-probe service regression: ${passed} passed`);
