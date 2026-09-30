import assert from 'node:assert/strict';

import {
  PROBE_COMMAND_SCHEMA,
  buildCapabilityProbePlan,
  executeCapabilityProbe
} from '../server/multiplayer/security/capability-probe.js';

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function request(overrides = {}) {
  return {
    profile_revision: 1,
    credential_revision: null,
    requested_capabilities: ['strict_json', 'error_correction_continuation'],
    max_requests: 2,
    max_input_tokens: 768,
    max_output_tokens: 768,
    idempotency_key: 'probe-key-1',
    ...overrides
  };
}

function command(value) {
  return {
    schema: PROBE_COMMAND_SCHEMA,
    nonce: 'public-fixed-probe-v1',
    value
  };
}

await test('probe plan advertises exact worst-case requests and rejects a one-request correction claim', () => {
  const plan = buildCapabilityProbePlan(request());
  assert.equal(plan.worst_case_requests, 2);
  assert.equal(plan.worst_case_output_tokens, 512);
  assert.deepEqual(plan.steps.map(step => step.step_id), [
    'json_structure',
    'error_correction'
  ]);
  assert.throws(
    () => buildCapabilityProbePlan(request({ max_requests: 1 })),
    error => error.code === 'CAPABILITY_PROBE_BUDGET_INSUFFICIENT'
      && error.details.required_requests === 2
  );
});

await test('strict JSON plus same-session machine-error correction selects json_protocol', async () => {
  const calls = [];
  const result = await executeCapabilityProbe({
    probe_id: 'probe_json',
    profile_id: 'profile_1',
    request: request(),
    clock: () => '2026-08-22T00:00:00.000Z',
    async invoke(input) {
      calls.push(input);
      return {
        raw_text: JSON.stringify(command(input.step_id === 'error_correction' ? 11 : 7))
      };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].session_id, calls[1].session_id);
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    'fixed_request', 'max_output_tokens', 'session_id', 'step_id', 'transport_mode'
  ]);
  assert.equal(calls[0].max_output_tokens, 256);
  assert.equal(JSON.stringify(calls).includes('room_id'), false);
  assert.equal(JSON.stringify(calls).includes('action'), false);
  assert.deepEqual(result.capabilities, {
    native_tools: false,
    strict_json: true,
    error_correction_continuation: true
  });
  assert.equal(result.recommended_continuity_transport, 'json_protocol');
  assert.equal(result.requests_used, 2);
});

await test('native and JSON subtests are separately charged and native wins only after correction', async () => {
  const result = await executeCapabilityProbe({
    probe_id: 'probe_native',
    profile_id: 'profile_1',
    request: request({
      requested_capabilities: [
        'native_tools',
        'strict_json',
        'error_correction_continuation'
      ],
      max_requests: 3
    }),
    async invoke(input) {
      const value = input.step_id === 'error_correction' ? 11 : 7;
      return input.transport_mode === 'native_tools'
        ? { tool_name: 'public_probe_command', arguments: command(value) }
        : { raw_text: JSON.stringify(command(value), null, 2) };
    }
  });
  assert.deepEqual(result.capabilities, {
    native_tools: true,
    strict_json: true,
    error_correction_continuation: true
  });
  assert.equal(result.requests_used, 3);
  assert.equal(result.recommended_continuity_transport, 'native_tools');
});

await test('failed native structure falls back to JSON for same-session correction', async () => {
  const calls = [];
  const result = await executeCapabilityProbe({
    probe_id: 'probe_json_fallback',
    profile_id: 'profile_1',
    request: request({
      requested_capabilities: [
        'native_tools',
        'strict_json',
        'error_correction_continuation'
      ],
      max_requests: 3
    }),
    async invoke(input) {
      calls.push(input);
      if (input.step_id === 'native_structure') throw new Error('native tools unsupported');
      return {
        raw_text: JSON.stringify(command(input.step_id === 'error_correction' ? 11 : 7))
      };
    }
  });
  assert.deepEqual(calls.map(call => [call.step_id, call.transport_mode]), [
    ['native_structure', 'native_tools'],
    ['json_structure', 'json_protocol'],
    ['error_correction', 'json_protocol']
  ]);
  assert.deepEqual(result.capabilities, {
    native_tools: false,
    strict_json: true,
    error_correction_continuation: true
  });
  assert.equal(result.recommended_continuity_transport, 'json_protocol');
  assert.equal(result.requests_used, 3);
});

await test('code fences fail strict JSON with zero extraction and skip dependent correction', async () => {
  let calls = 0;
  const result = await executeCapabilityProbe({
    profile_id: 'profile_1',
    request: request(),
    async invoke() {
      calls += 1;
      return { raw_text: `\`\`\`json\n${JSON.stringify(command(7))}\n\`\`\`` };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.capabilities.strict_json, false);
  assert.equal(result.capabilities.error_correction_continuation, false);
  assert.equal(result.recommended_continuity_transport, null);
  assert.equal(result.requests_used, 1);
  assert.equal(result.results[1].failure_code, 'BASE_STRUCTURE_PROBE_FAILED');
});

await test('probe request is closed and cannot carry room, action, memory or arbitrary endpoint data', () => {
  for (const [field, value] of [
    ['room_id', 'room_secret'],
    ['action_text', 'hidden action'],
    ['memory', { private: true }],
    ['base_url', 'https://attacker.example']
  ]) {
    assert.throws(
      () => buildCapabilityProbePlan({ ...request(), [field]: value }),
      error => error.code === 'CAPABILITY_PROBE_REQUEST_INVALID'
    );
  }
});

console.log(`\n${passed} multiplayer capability-probe regression tests passed.`);
