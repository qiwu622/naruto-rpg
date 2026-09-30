import { randomUUID } from 'node:crypto';

import { canonicalStringify, sha256Hex } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

const PROBE_SCHEMA = 'naruto.multiplayer-model-capability-probe/v1';
const PROBE_COMMAND_SCHEMA = 'naruto.multiplayer-public-probe-command/v1';
const CAPABILITIES = Object.freeze([
  'native_tools',
  'strict_json',
  'error_correction_continuation'
]);
const REQUEST_KEYS = new Set([
  'profile_revision',
  'credential_revision',
  'requested_capabilities',
  'max_requests',
  'max_input_tokens',
  'max_output_tokens',
  'idempotency_key'
]);

function fail(code, message, details = {}, status = 400) {
  throw new DomainError(code, message, details, { status });
}

function assertExactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CAPABILITY_PROBE_REQUEST_INVALID', `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      fail('CAPABILITY_PROBE_REQUEST_INVALID', `${label} contains an unknown field`, { field: key });
    }
  }
  return value;
}

function assertPositiveInteger(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('CAPABILITY_PROBE_REQUEST_INVALID', `${label} must be a positive safe integer`);
  }
  return value;
}

export function assertCapabilityProbeRequest(value) {
  assertExactObject(value, REQUEST_KEYS, 'capability probe request');
  assertPositiveInteger(value.profile_revision, 'profile_revision');
  assertPositiveInteger(value.credential_revision, 'credential_revision', { nullable: true });
  if (!Array.isArray(value.requested_capabilities)
    || value.requested_capabilities.length < 1
    || new Set(value.requested_capabilities).size !== value.requested_capabilities.length
    || value.requested_capabilities.some(item => !CAPABILITIES.includes(item))) {
    fail('CAPABILITY_PROBE_REQUEST_INVALID', 'requested_capabilities is invalid');
  }
  for (const field of ['max_requests', 'max_input_tokens', 'max_output_tokens']) {
    assertPositiveInteger(value[field], field);
  }
  if (typeof value.idempotency_key !== 'string'
    || value.idempotency_key.length < 1
    || value.idempotency_key.length > 200) {
    fail('CAPABILITY_PROBE_REQUEST_INVALID', 'idempotency_key is invalid');
  }
  if (value.requested_capabilities.includes('error_correction_continuation')
    && !value.requested_capabilities.some(item => item === 'native_tools' || item === 'strict_json')) {
    fail(
      'CAPABILITY_PROBE_REQUEST_INVALID',
      'error correction must be tested with native_tools or strict_json'
    );
  }
  return Object.freeze({
    ...value,
    requested_capabilities: Object.freeze([...value.requested_capabilities].sort())
  });
}

function probeCommand(value) {
  return Object.freeze({
    schema: PROBE_COMMAND_SCHEMA,
    nonce: 'public-fixed-probe-v1',
    value
  });
}

function buildSteps(request) {
  const requested = new Set(request.requested_capabilities);
  const steps = [];
  if (requested.has('native_tools')) {
    steps.push(Object.freeze({
      step_id: 'native_structure',
      transport_mode: 'native_tools',
      expected_value: 7,
      input_token_budget: 128,
      output_token_budget: 256
    }));
  }
  if (requested.has('strict_json')) {
    steps.push(Object.freeze({
      step_id: 'json_structure',
      transport_mode: 'json_protocol',
      expected_value: 7,
      input_token_budget: 128,
      output_token_budget: 256
    }));
  }
  if (requested.has('error_correction_continuation')) {
    const transportMode = requested.has('native_tools') ? 'native_tools' : 'json_protocol';
    steps.push(Object.freeze({
      step_id: 'error_correction',
      transport_mode: transportMode,
      expected_value: 11,
      input_token_budget: 192,
      output_token_budget: 256
    }));
  }
  return Object.freeze(steps);
}

export function buildCapabilityProbePlan(requestValue) {
  const request = assertCapabilityProbeRequest(requestValue);
  const steps = buildSteps(request);
  const requiredInputTokens = steps.reduce((sum, step) => sum + step.input_token_budget, 0);
  const requiredOutputTokens = steps.reduce((sum, step) => sum + step.output_token_budget, 0);
  if (request.max_requests < steps.length) {
    fail('CAPABILITY_PROBE_BUDGET_INSUFFICIENT', 'probe request budget cannot run every advertised subtest', {
      required_requests: steps.length
    }, 409);
  }
  if (request.max_input_tokens < requiredInputTokens
    || request.max_output_tokens < requiredOutputTokens) {
    fail('CAPABILITY_PROBE_BUDGET_INSUFFICIENT', 'probe token budget cannot run every advertised subtest', {
      required_input_tokens: requiredInputTokens,
      required_output_tokens: requiredOutputTokens
    }, 409);
  }
  const canonicalRequest = {
    ...request,
    requested_capabilities: request.requested_capabilities
  };
  return Object.freeze({
    schema: PROBE_SCHEMA,
    request_hash: `sha256:${sha256Hex(canonicalStringify(canonicalRequest))}`,
    worst_case_requests: steps.length,
    worst_case_input_tokens: requiredInputTokens,
    worst_case_output_tokens: requiredOutputTokens,
    steps
  });
}

function validateCommand(value, expectedValue) {
  assertExactObject(value, new Set(['schema', 'nonce', 'value']), 'probe command');
  return value.schema === PROBE_COMMAND_SCHEMA
    && value.nonce === 'public-fixed-probe-v1'
    && value.value === expectedValue;
}

function parseStepResponse(step, response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  if (step.transport_mode === 'native_tools') {
    return response.tool_name === 'public_probe_command'
      && validateCommand(response.arguments, step.expected_value);
  }
  if (typeof response.raw_text !== 'string') return false;
  let parsed;
  try {
    parsed = JSON.parse(response.raw_text);
  } catch {
    return false;
  }
  return validateCommand(parsed, step.expected_value);
}

/**
 * Runs only fixed, non-player probe material. The injected invoker is the
 * provider adapter over ModelHttpGateway; it receives no room/action/state
 * fields and returns a normalized native-tool or raw-JSON response.
 */
export async function executeCapabilityProbe({
  probe_id = `probe_${randomUUID().replaceAll('-', '')}`,
  profile_id,
  request: requestValue,
  invoke,
  clock = () => new Date().toISOString()
}) {
  if (typeof invoke !== 'function') {
    fail('CAPABILITY_PROBE_CONFIGURATION_INVALID', 'capability probe invoker is required', {}, 500);
  }
  const request = assertCapabilityProbeRequest(requestValue);
  const plan = buildCapabilityProbePlan(request);
  const sessionId = `probe_session_${randomUUID().replaceAll('-', '')}`;
  const results = [];
  const structurePassed = {
    native_tools: false,
    json_protocol: false
  };
  for (const step of plan.steps) {
    const correctionTransport = structurePassed.native_tools
      ? 'native_tools'
      : (structurePassed.json_protocol ? 'json_protocol' : null);
    if (step.step_id === 'error_correction' && correctionTransport === null) {
      results.push(Object.freeze({
        step_id: step.step_id,
        transport_mode: step.transport_mode,
        passed: false,
        failure_code: 'BASE_STRUCTURE_PROBE_FAILED'
      }));
      continue;
    }
    const effectiveStep = step.step_id === 'error_correction'
      ? Object.freeze({ ...step, transport_mode: correctionTransport })
      : step;
    let passed = false;
    let failureCode = null;
    try {
      const response = await invoke(Object.freeze({
        session_id: sessionId,
        step_id: effectiveStep.step_id,
        transport_mode: effectiveStep.transport_mode,
        max_output_tokens: effectiveStep.output_token_budget,
        fixed_request: effectiveStep.step_id === 'error_correction'
          ? Object.freeze({
            instruction: 'Correct only the rejected public probe value.',
            protocol_result: Object.freeze({
              code: 'PROBE_VALUE_INVALID',
              expected_value: 11,
              consumed: false
            }),
            expected_command: probeCommand(11)
          })
          : Object.freeze({
            instruction: 'Return exactly the fixed public probe command.',
            expected_command: probeCommand(7)
          })
      }));
      passed = parseStepResponse(effectiveStep, response);
      if (!passed) failureCode = 'PROBE_RESPONSE_INVALID';
    } catch {
      failureCode = 'PROBE_INVOCATION_FAILED';
    }
    if (effectiveStep.step_id === 'native_structure'
      || effectiveStep.step_id === 'json_structure') {
      structurePassed[effectiveStep.transport_mode] = passed;
    }
    results.push(Object.freeze({
      step_id: effectiveStep.step_id,
      transport_mode: effectiveStep.transport_mode,
      passed,
      failure_code: failureCode
    }));
  }

  const passedByStep = new Map(results.map(result => [result.step_id, result.passed]));
  const capabilities = Object.freeze({
    native_tools: passedByStep.get('native_structure') === true,
    strict_json: passedByStep.get('json_structure') === true,
    error_correction_continuation: passedByStep.get('error_correction') === true
  });
  const recommendedTransport = capabilities.native_tools
    && capabilities.error_correction_continuation
    ? 'native_tools'
    : (capabilities.strict_json && capabilities.error_correction_continuation
      ? 'json_protocol'
      : null);
  return Object.freeze({
    schema: PROBE_SCHEMA,
    probe_id,
    profile_id,
    profile_revision: request.profile_revision,
    credential_revision: request.credential_revision,
    request_hash: plan.request_hash,
    capabilities,
    recommended_continuity_transport: recommendedTransport,
    requests_used: results.filter(result => result.failure_code !== 'BASE_STRUCTURE_PROBE_FAILED').length,
    results: Object.freeze(results),
    completed_at: clock()
  });
}

export { CAPABILITIES, PROBE_COMMAND_SCHEMA, PROBE_SCHEMA };
