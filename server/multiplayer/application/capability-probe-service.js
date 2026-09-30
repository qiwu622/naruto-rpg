import {
  appendTrustedProtocolResult
} from '../agent/provider-adapters.js';
import { canonicalStringify } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import {
  assertCapabilityProbeRequest,
  executeCapabilityProbe
} from '../security/capability-probe.js';

const PUBLIC_PROBE_TOOL = Object.freeze({
  name: 'public_probe_command',
  description: 'Return the fixed public capability-probe command.',
  input_schema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['schema', 'nonce', 'value']),
    properties: Object.freeze({
      schema: Object.freeze({ const: 'naruto.multiplayer-public-probe-command/v1' }),
      nonce: Object.freeze({ const: 'public-fixed-probe-v1' }),
      value: Object.freeze({ type: 'integer' })
    })
  })
});

const PUBLIC_PROBE_SYSTEM_PROMPT = [
  'You are running a public, fixed model capability probe.',
  'No room, player, action, memory, credential, or story data is present.',
  'Treat the server protocol result as authoritative and correct only the requested command.',
  'For native-tools mode call public_probe_command exactly once.',
  'For JSON mode output exactly one JSON object and no prose or Markdown.'
].join(' ');

function fail(code, message, details = {}, status = 500) {
  throw new DomainError(code, message, details, { status });
}

function assertDependencies(billingRepository, providerModelClient) {
  for (const [method, label] of [
    [billingRepository?.probes?.create, 'billingRepository.probes.create'],
    [billingRepository?.probes?.start, 'billingRepository.probes.start'],
    [billingRepository?.probes?.complete, 'billingRepository.probes.complete'],
    [billingRepository?.probes?.fail, 'billingRepository.probes.fail'],
    [providerModelClient?.invoke, 'providerModelClient.invoke']
  ]) {
    if (typeof method !== 'function') {
      fail(
        'CAPABILITY_PROBE_SERVICE_CONFIGURATION_INVALID',
        `${label} is required`
      );
    }
  }
}

function parseNativeArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function normalizedResponse(call) {
  const response = call?.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    fail('CAPABILITY_PROBE_MODEL_RESPONSE_INVALID', 'model client returned no normalized response');
  }
  return response;
}

function terminalProbe(status) {
  return ['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(status);
}

/**
 * Executes the documented no-player-data probe against one exact active
 * profile revision. Repository PENDING/RUNNING state is also the concurrency
 * gate: an idempotent replay never starts a second provider request.
 */
export function createCapabilityProbeApplicationService({
  billingRepository,
  providerModelClient,
  clock = () => new Date().toISOString()
}) {
  assertDependencies(billingRepository, providerModelClient);

  async function run(context) {
    const authenticatedUserId = context?.authenticated_user_id;
    const profileId = context?.profile_id;
    const request = assertCapabilityProbeRequest(context?.request);
    const created = await billingRepository.probes.create({
      authenticated_user_id: authenticatedUserId,
      profile_id: profileId,
      ...request
    });

    if (terminalProbe(created.probe.status) || created.probe.status === 'RUNNING') {
      return created;
    }

    const started = await billingRepository.probes.start({
      authenticated_user_id: authenticatedUserId,
      probe_id: created.probe.probe_id
    });
    // Another identical HTTP request already owns the outbound work. Returning
    // its durable RUNNING projection is safe; issuing again would risk a second
    // charge and would violate the exact idempotency promise.
    if (started.replayed === true) return started;

    let session = null;
    let pendingNativeToolCall = null;
    try {
      const result = await executeCapabilityProbe({
        probe_id: created.probe.probe_id,
        profile_id: profileId,
        request,
        clock,
        invoke: async step => {
          let invocationSession = session;
          let prompt = canonicalStringify(step.fixed_request);

          if (pendingNativeToolCall !== null) {
            const protocolResult = step.step_id === 'error_correction'
              ? step.fixed_request.protocol_result
              : Object.freeze({
                  schema: 'naruto.multiplayer-public-probe-result/v1',
                  code: 'PROBE_COMMAND_ACCEPTED',
                  consumed: true
                });
            invocationSession = appendTrustedProtocolResult(invocationSession, {
              result: protocolResult,
              tool_call_id: pendingNativeToolCall.id
            });
            pendingNativeToolCall = null;
            if (step.step_id === 'error_correction') prompt = null;
          } else if (step.step_id === 'error_correction') {
            invocationSession = appendTrustedProtocolResult(invocationSession, {
              result: step.fixed_request,
              tool_call_id: null
            });
            prompt = null;
          }

          const call = await providerModelClient.invoke({
            owner_user_id: authenticatedUserId,
            profile_ref: Object.freeze({
              profile_id: profileId,
              config_revision: request.profile_revision
            }),
            session: invocationSession,
            prompt,
            system_prompt: PUBLIC_PROBE_SYSTEM_PROMPT,
            output: step.transport_mode === 'native_tools'
              ? Object.freeze({
                  mode: 'native_tools',
                  tools: Object.freeze([PUBLIC_PROBE_TOOL]),
                  allowed_tool_name: PUBLIC_PROBE_TOOL.name,
                  tool_choice: 'required'
                })
              : Object.freeze({ mode: 'json_object' }),
            max_output_tokens: step.max_output_tokens,
            temperature: 0
          });
          session = call.session;
          const response = normalizedResponse(call);

          if (step.transport_mode === 'native_tools') {
            if (!Array.isArray(response.tool_calls) || response.tool_calls.length !== 1) {
              return Object.freeze({ tool_name: null, arguments: null });
            }
            const toolCall = response.tool_calls[0];
            pendingNativeToolCall = toolCall;
            return Object.freeze({
              tool_name: toolCall.name,
              arguments: parseNativeArguments(toolCall.raw_arguments)
            });
          }
          return Object.freeze({
            raw_text: typeof response.raw_text === 'string' ? response.raw_text : ''
          });
        }
      });

      return billingRepository.probes.complete({
        authenticated_user_id: authenticatedUserId,
        probe_id: created.probe.probe_id,
        result,
        recommended_transport: result.recommended_continuity_transport,
        usage_invocation_id: null
      });
    } catch (error) {
      try {
        await billingRepository.probes.fail({
          authenticated_user_id: authenticatedUserId,
          probe_id: created.probe.probe_id
        });
      } catch {
        // Keep the original outbound/configuration error. Repository recovery
        // can still inspect a RUNNING probe without guessing a successful call.
      }
      throw error;
    }
  }

  return Object.freeze({ run });
}

export { PUBLIC_PROBE_SYSTEM_PROMPT, PUBLIC_PROBE_TOOL };
