import { randomUUID } from 'node:crypto';

import { DomainError } from '../domain/errors.js';

const DEFAULT_UNKNOWN_ERROR_CODES = new Set([
  'MODEL_ENDPOINT_REQUEST_TIMEOUT',
  'MODEL_ENDPOINT_REQUEST_ABORTED',
  'MODEL_ENDPOINT_REQUEST_FAILED'
]);
const DEFAULT_UNSENT_ERROR_CODES = new Set([
  'CONTRACT_VALIDATION_FAILED',
  'MODEL_STAGE_REQUEST_INVALID',
  'MODEL_ADAPTER_UNSUPPORTED',
  'MODEL_ADAPTER_OPERATION_UNSUPPORTED',
  'PROVIDER_SESSION_INVALID',
  'PROVIDER_SESSION_ADAPTER_MISMATCH',
  'PROVIDER_SESSION_MESSAGE_INVALID',
  'MODEL_PROFILE_REQUIRED',
  'MODEL_PROFILE_NOT_FOUND',
  'MODEL_PROFILE_REVOKED',
  'MODEL_PROFILE_OWNER_MISMATCH',
  'MODEL_PROFILE_REFERENCE_INVALID',
  'MODEL_PROFILE_CREDENTIAL_INVALID',
  'MODEL_PROFILE_CREDENTIAL_MISMATCH',
  'MODEL_PROFILE_CREDENTIAL_REQUIRED',
  'MODEL_CREDENTIAL_REQUIRED',
  'MODEL_CREDENTIAL_NOT_FOUND',
  'MODEL_CREDENTIAL_REVOKED',
  'MODEL_CREDENTIAL_REFERENCE_INVALID',
  'CREDENTIAL_REVOKED',
  'CREDENTIAL_OWNER_MISMATCH',
  'CREDENTIAL_ORIGIN_MISMATCH',
  'CREDENTIAL_ORIGIN_INVALID',
  'CREDENTIAL_AUTHENTICATION_FAILED',
  'CREDENTIAL_MASTER_KEY_UNAVAILABLE',
  'CREDENTIAL_PLAINTEXT_INVALID',
  'CREDENTIAL_VAULT_CONFIGURATION_INVALID',
  'CREDENTIAL_VAULT_INPUT_INVALID',
  'MODEL_ENDPOINT_INVALID',
  'MODEL_ENDPOINT_FORBIDDEN',
  'MODEL_ENDPOINT_PORT_FORBIDDEN',
  'MODEL_ENDPOINT_DNS_INVALID',
  'MODEL_ENDPOINT_DNS_FAILED',
  'MODEL_ENDPOINT_VALIDATION_ABORTED',
  'MODEL_ENDPOINT_PROFILE_MISMATCH',
  'MODEL_ENDPOINT_PIN_INVALID',
  'MODEL_REQUEST_INVALID',
  'MODEL_REQUEST_TOO_LARGE',
  'MODEL_AUTH_SCHEME_FORBIDDEN',
  'MODEL_AUTH_SECRET_FORBIDDEN',
  'MODEL_AUTH_SECRET_REQUIRED',
  'MODEL_AUTH_SECRET_INVALID'
]);

function fail(code, message, details = {}, status = 500, cause) {
  throw new DomainError(code, message, details, { status, cause });
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 256) {
    fail('BILLED_MODEL_CLIENT_CONFIGURATION_INVALID', `${label} is invalid`);
  }
  return value;
}

function assertScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('BILLED_MODEL_CLIENT_CONFIGURATION_INVALID', 'billing scope is required');
  }
  for (const field of ['room_id', 'plan_hash', 'payer_user_id', 'stage']) {
    assertIdentifier(value[field], `scope.${field}`);
  }
  if (value.audience !== null && !['A', 'B'].includes(value.audience)) {
    fail('BILLED_MODEL_CLIENT_CONFIGURATION_INVALID', 'scope.audience must be null, A or B');
  }
  return Object.freeze({
    room_id: value.room_id,
    plan_hash: value.plan_hash,
    payer_user_id: value.payer_user_id,
    stage: value.stage,
    audience: value.audience
  });
}

function defaultInvocationIdFactory() {
  return `invocation_${randomUUID().replaceAll('-', '')}`;
}

function defaultUnknownClassifier(error) {
  return error instanceof DomainError && DEFAULT_UNKNOWN_ERROR_CODES.has(error.code);
}

function defaultUnsentClassifier(error) {
  return error instanceof DomainError && DEFAULT_UNSENT_ERROR_CODES.has(error.code);
}

function reservationForRequest(request) {
  let serialized;
  try {
    serialized = JSON.stringify(request);
  } catch (error) {
    fail(
      'MODEL_USAGE_RESERVATION_INVALID',
      'model request cannot be measured for durable token reservation',
      {},
      500,
      error
    );
  }
  if (typeof serialized !== 'string') {
    fail('MODEL_USAGE_RESERVATION_INVALID', 'model request must be JSON-serializable');
  }
  const maxOutputTokens = request?.max_output_tokens ?? 1;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    fail('MODEL_USAGE_RESERVATION_INVALID', 'request.max_output_tokens must be positive');
  }
  return Object.freeze({
    input_tokens: Math.max(1, Buffer.byteLength(serialized, 'utf8')),
    output_tokens: maxOutputTokens
  });
}

async function settleFailure(
  usageRepository,
  scope,
  invocationId,
  error,
  classifyUnknown,
  classifyUnsent
) {
  const input = {
    authenticated_user_id: scope.payer_user_id,
    room_id: scope.room_id,
    invocation_id: invocationId
  };
  if (classifyUnknown(error)) {
    return usageRepository.markUnknown(input);
  }
  return usageRepository.fail({
    ...input,
    release_budget: classifyUnsent(error)
  });
}

/**
 * Wraps one provider-stage client with the section 21.5 accounting protocol.
 * The local budget is consumed and IN_FLIGHT is durable before any network
 * call. A normal HTTP response is acknowledged before model-output parsing;
 * ambiguous transport failures become UNKNOWN and are never auto-retried.
 */
export function createBilledProviderClient({
  client,
  usage_repository,
  assert_lease,
  scope: scopeValue,
  initial_attempt = 1,
  invocation_id_factory = defaultInvocationIdFactory,
  classify_unknown_error = defaultUnknownClassifier,
  classify_unsent_error = defaultUnsentClassifier,
  checkpoint_response = async () => {}
} = {}) {
  if (typeof client?.invoke !== 'function'
    || !usage_repository
    || typeof usage_repository.start !== 'function'
    || typeof usage_repository.acknowledge !== 'function'
    || typeof usage_repository.fail !== 'function'
    || typeof usage_repository.markUnknown !== 'function'
    || typeof assert_lease !== 'function'
    || typeof invocation_id_factory !== 'function'
    || typeof classify_unknown_error !== 'function'
    || typeof classify_unsent_error !== 'function'
    || typeof checkpoint_response !== 'function') {
    fail('BILLED_MODEL_CLIENT_CONFIGURATION_INVALID', 'billed model client ports are incomplete');
  }
  if (!Number.isSafeInteger(initial_attempt) || initial_attempt < 1) {
    fail('BILLED_MODEL_CLIENT_CONFIGURATION_INVALID', 'initial_attempt must be positive');
  }
  const scope = assertScope(scopeValue);
  let nextAttempt = initial_attempt;

  async function releaseConfirmedUnsent(invocationId, originalError) {
    let released;
    try {
      released = await usage_repository.fail({
        authenticated_user_id: scope.payer_user_id,
        room_id: scope.room_id,
        invocation_id: invocationId,
        release_budget: true
      });
    } catch (settlementError) {
      fail('MODEL_USAGE_SETTLEMENT_FAILED', 'unsent invocation could not be closed', {
        invocation_id: invocationId,
        original_error_code: originalError instanceof DomainError ? originalError.code : null
      }, 500, settlementError);
    }
    if (released?.usage?.status !== 'FAILED'
      || released.usage.budget_charge_state !== 'RELEASED') {
      fail('MODEL_USAGE_SETTLEMENT_FAILED', 'unsent invocation did not release its reservation', {
        invocation_id: invocationId,
        usage_status: released?.usage?.status ?? null,
        budget_charge_state: released?.usage?.budget_charge_state ?? null
      });
    }
    return released;
  }

  async function invoke(request) {
    await assert_lease();
    const invocationId = assertIdentifier(invocation_id_factory(scope, nextAttempt), 'invocation_id');
    const attempt = nextAttempt;
    const reservation = reservationForRequest(request);
    const started = await usage_repository.start({
      authenticated_user_id: scope.payer_user_id,
      room_id: scope.room_id,
      plan_hash: scope.plan_hash,
      stage: scope.stage,
      audience: scope.audience,
      attempt,
      invocation_id: invocationId,
      reserved_input_tokens: reservation.input_tokens,
      reserved_output_tokens: reservation.output_tokens
    });
    if (started?.usage?.status !== 'IN_FLIGHT'
      || started.usage.reserved_input_tokens !== reservation.input_tokens
      || !Number.isSafeInteger(started.usage.reserved_output_tokens)
      || started.usage.reserved_output_tokens < 1
      || started.usage.reserved_output_tokens > reservation.output_tokens) {
      const startError = new DomainError(
        'MODEL_USAGE_START_INVALID',
        'model usage did not return a valid outbound reservation',
        {
          invocation_id: invocationId,
          usage_status: started?.usage?.status ?? null
        },
        { status: 500 }
      );
      await releaseConfirmedUnsent(invocationId, startError);
      throw startError;
    }
    const outboundRequest = started.usage.reserved_output_tokens === reservation.output_tokens
      ? request
      : Object.freeze({
          ...request,
          max_output_tokens: started.usage.reserved_output_tokens
        });
    nextAttempt += 1;

    // A lease can be lost while the budget transaction is committing. This
    // second fence check happens immediately before the outbound call.
    try {
      await assert_lease();
    } catch (error) {
      await releaseConfirmedUnsent(invocationId, error);
      throw error;
    }

    let result;
    try {
      result = await client.invoke(outboundRequest);
    } catch (error) {
      let settled;
      try {
        settled = await settleFailure(
          usage_repository,
          scope,
          invocationId,
          error,
          classify_unknown_error,
          classify_unsent_error
        );
      } catch (settlementError) {
        fail('MODEL_USAGE_SETTLEMENT_FAILED', 'failed invocation could not be settled', {
          invocation_id: invocationId,
          original_error_code: error instanceof DomainError ? error.code : null
        }, 500, settlementError);
      }
      try {
        await checkpoint_response(Object.freeze({
          invocation_id: invocationId,
          attempt,
          scope,
          status: settled.usage.status,
          error_code: error instanceof DomainError ? error.code : 'MODEL_INVOCATION_FAILED',
          result: null
        }));
      } catch (checkpointError) {
        fail('MODEL_STAGE_OUTPUT_CHECKPOINT_FAILED', 'failed invocation audit could not be checkpointed', {
          invocation_id: invocationId,
          usage_status: settled.usage.status,
          retry_forbidden: settled.usage.status === 'UNKNOWN'
        }, 500, checkpointError);
      }
      throw error;
    }

    const response = result?.response;
    if (!response?.usage) {
      const responseError = new DomainError(
        'MODEL_ENDPOINT_RESPONSE_INVALID',
        'provider client omitted normalized usage',
        { invocation_id: invocationId }
      );
      let settled;
      try {
        // A normal provider return proves that the send boundary was crossed,
        // but without normalized usage we cannot durably acknowledge the
        // charge. UNKNOWN closes the automatic retry path instead of leaving
        // a permanently misleading IN_FLIGHT row.
        settled = await usage_repository.markUnknown({
          authenticated_user_id: scope.payer_user_id,
          room_id: scope.room_id,
          invocation_id: invocationId
        });
      } catch (settlementError) {
        fail('MODEL_USAGE_SETTLEMENT_FAILED', 'invalid provider response could not be settled', {
          invocation_id: invocationId,
          original_error_code: responseError.code
        }, 500, settlementError);
      }
      try {
        await checkpoint_response(Object.freeze({
          invocation_id: invocationId,
          attempt,
          scope,
          status: settled.usage.status,
          error_code: responseError.code,
          result
        }));
      } catch (checkpointError) {
        fail('MODEL_STAGE_OUTPUT_CHECKPOINT_FAILED', 'invalid provider response was not durably cached', {
          invocation_id: invocationId,
          usage_status: settled.usage.status,
          retry_forbidden: true
        }, 500, checkpointError);
      }
      throw responseError;
    }
    const completion = {
      authenticated_user_id: scope.payer_user_id,
      room_id: scope.room_id,
      invocation_id: invocationId,
      provider_request_id: response.provider_request_id ?? response.response_id ?? null,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      estimated_cost: null
    };
    let acknowledged;
    try {
      acknowledged = await usage_repository.acknowledge(completion);
    } catch (error) {
      // The provider response is known locally but the durable ledger is not.
      // Best-effort UNKNOWN closes the automatic retry path without claiming
      // that the provider did not charge the request.
      try {
        await usage_repository.markUnknown({
          authenticated_user_id: scope.payer_user_id,
          room_id: scope.room_id,
          invocation_id: invocationId
        });
      } catch {}
      fail('MODEL_USAGE_ACKNOWLEDGEMENT_FAILED', 'provider response could not be acknowledged', {
        invocation_id: invocationId,
        retry_forbidden: true
      }, 500, error);
    }
    if (acknowledged?.usage?.status !== 'SUCCEEDED') {
      fail('MODEL_USAGE_ACKNOWLEDGEMENT_FAILED', 'usage acknowledgement is not terminal success', {
        invocation_id: invocationId,
        usage_status: acknowledged?.usage?.status ?? null
      });
    }

    // A late response is billed but must never be adopted under a stale fence.
    await assert_lease();
    try {
      await checkpoint_response(Object.freeze({
        invocation_id: invocationId,
        attempt,
        scope,
        status: 'SUCCEEDED',
        error_code: null,
        result
      }));
    } catch (error) {
      fail('MODEL_STAGE_OUTPUT_CHECKPOINT_FAILED', 'successful model response was not durably cached', {
        invocation_id: invocationId,
        usage_status: 'SUCCEEDED',
        retry_forbidden: true
      }, 500, error);
    }
    return Object.freeze({
      ...result,
      invocation_id: invocationId,
      billing_scope: scope,
      usage_receipt: acknowledged.usage
    });
  }

  return Object.freeze({
    invoke,
    scope,
    nextAttempt: () => nextAttempt
  });
}

export { DEFAULT_UNKNOWN_ERROR_CODES, DEFAULT_UNSENT_ERROR_CODES };
