import {
  CONTINUITY_JSON_ENVELOPE_JSON_SCHEMA,
  CONTINUITY_JSON_ENVELOPE_SCHEMA,
  createContinuityToolContract
} from '../contracts/continuity-contracts.js';
import {
  NARRATIVE_CANDIDATE_JSON_SCHEMA,
  assertNarrativeCandidate
} from '../contracts/narrative-contracts.js';
import {
  REFEREE_CHECK_JSON_PROTOCOL,
  REFEREE_CHECK_JSON_COMMAND_JSON_SCHEMA,
  REQUEST_RESOLUTION_CHECK_OPERATION,
  createResolutionCheckToolContract,
  assertRefereeCheckJsonCommand,
  assertResolutionCheckRequest,
  assertResolutionCheckResult
} from '../contracts/resolution-check-contracts.js';
import {
  RESOLUTION_CANDIDATE_JSON_SCHEMA,
  assertResolutionCandidate
} from '../contracts/resolution-contracts.js';
import {
  CONTINUITY_OPERATIONS,
  decodeJsonContinuityCommand,
  decodeNativeContinuityCommand
} from '../domain/continuity-bundle.js';
import { canonicalStringify } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import {
  appendTrustedProtocolResult,
  appendTrustedProtocolResults,
  normalizeProviderJsonSchema
} from './provider-adapters.js';
import {
  NARRATIVE_GROUNDING_CANDIDATE_JSON_SCHEMA,
  RESOLUTION_COMPLETENESS_REVIEW_JSON_SCHEMA,
  assertNarrativeGroundingCandidate,
  assertResolutionCompletenessReview
} from './review-contracts.js';
import { parseStrictJsonObject } from './strict-json.js';
import { buildShinobiDailyRulesPrompt } from '../../../js/core/shinobi-daily.js';

const CONTINUITY_OPERATION_SET = new Set(Object.values(CONTINUITY_OPERATIONS));

function fail(code, message, details = {}, status = 422) {
  throw new DomainError(code, message, details, { status });
}

function stageRequest(request, extra) {
  if (typeof request?.client?.invoke !== 'function') {
    fail('MODEL_STAGE_CONFIGURATION_INVALID', 'provider model client is required', {}, 500);
  }
  return {
    profile: request.profile,
    profile_ref: request.profile_ref,
    credential: request.credential,
    credential_vault: request.credential_vault,
    owner_user_id: request.owner_user_id,
    signal: request.signal,
    max_output_tokens: request.max_output_tokens ?? 8_192,
    temperature: request.temperature ?? 0,
    reasoning_effort: request.reasoning_effort ?? null,
    ...extra
  };
}

function systemWithContracts(systemPrompt, contracts) {
  return `${systemPrompt}\n\n以下为服务器固定的高优先级输出合同，不是玩家数据：\n${canonicalStringify({
    schema: 'naruto.multiplayer-agent-output-contract-set/v1',
    contracts
  })}`;
}

function oneNativeTool(response, expectedName, label) {
  if (response.tool_calls.length !== 1) {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} must contain exactly one native tool call`, {
      reason: 'NATIVE_TOOL_COUNT_INVALID',
      expected_tool_name: expectedName,
      actual_tool_count: response.tool_calls.length
    });
  }
  if (typeof response.raw_text === 'string' && response.raw_text.trim()) {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} cannot mix a tool call with prose`, {
      reason: 'MIXED_TOOL_AND_TEXT'
    });
  }
  const call = response.tool_calls[0];
  if (call.name !== expectedName) {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} called an unavailable tool`, {
      reason: 'UNKNOWN_TOOL',
      expected_tool_name: expectedName,
      actual_tool_name: call.name
    });
  }
  return call;
}

function assertResponseNotTruncated(response, label) {
  if (['length', 'max_tokens'].includes(response.finish_reason)) {
    fail('MODEL_OUTPUT_TRUNCATED', `${label} reached its output-token limit`, {
      finish_reason: response.finish_reason
    });
  }
}

function parseRawArguments(call, label) {
  if (typeof call.raw_arguments === 'string') {
    return parseStrictJsonObject(call.raw_arguments, { label });
  }
  if (!call.raw_arguments || typeof call.raw_arguments !== 'object'
    || Array.isArray(call.raw_arguments)) {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} must be a JSON object`, {
      reason: 'NON_OBJECT_TOOL_ARGUMENTS'
    });
  }
  return call.raw_arguments;
}

function noNativeToolCalls(response, label) {
  if (response.tool_calls.length !== 0) {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} is not allowed to call tools`, {
      reason: 'TOOL_NOT_ALLOWED',
      tool_names: response.tool_calls.map(call => call.name)
    });
  }
  if (typeof response.raw_text !== 'string') {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} did not return strict JSON text`, {
      reason: 'MISSING_JSON_TEXT'
    });
  }
  return response.raw_text;
}

function addUsage(total, usage) {
  for (const key of [
    'requests',
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens'
  ]) total[key] += usage[key];
  return total;
}

export function emptyStageUsage() {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  };
}

function finalizedUsage(value) {
  return Object.freeze({ ...value });
}

function parseRefereeResponse(response, transportMode) {
  assertResponseNotTruncated(response, 'Referee response');
  if (transportMode === 'native_tools' && response.tool_calls.length > 0) {
    const call = oneNativeTool(response, REQUEST_RESOLUTION_CHECK_OPERATION, 'Referee response');
    return Object.freeze({
      kind: 'check_request',
      request: assertResolutionCheckRequest(
        parseRawArguments(call, 'request_resolution_check arguments')
      ),
      tool_call_id: call.id,
      raw_arguments: call.raw_arguments
    });
  }
  const rawText = noNativeToolCalls(response, 'Referee response');
  const parsed = parseStrictJsonObject(rawText, { label: 'Referee response' });
  if (parsed.protocol === REFEREE_CHECK_JSON_PROTOCOL) {
    if (transportMode !== 'json_protocol') {
      fail('MODEL_PROTOCOL_VIOLATION', 'native Referee returned a JSON check command', {
        reason: 'TRANSPORT_MISMATCH'
      });
    }
    const command = assertRefereeCheckJsonCommand(parsed);
    return Object.freeze({
      kind: 'check_request',
      request: command.request,
      tool_call_id: null,
      raw_arguments: rawText
    });
  }
  return Object.freeze({
    kind: 'resolution_candidate',
    candidate: assertResolutionCandidate(parsed),
    tool_call_id: null,
    raw_arguments: rawText
  });
}

/** Executes a full Referee provider continuation, including authoritative checks. */
export async function invokeRefereeModel(request) {
  if (!['native_tools', 'json_protocol'].includes(request.transport_mode)) {
    fail('MODEL_STAGE_CONFIGURATION_INVALID', 'Referee transport is invalid', {}, 500);
  }
  if (typeof request.execute_check !== 'function') {
    fail('MODEL_STAGE_CONFIGURATION_INVALID', 'authoritative check executor is required', {}, 500);
  }
  const maxChecks = request.max_check_requests ?? 8;
  if (!Number.isSafeInteger(maxChecks) || maxChecks < 0) {
    fail('MODEL_STAGE_CONFIGURATION_INVALID', 'max_check_requests is invalid', {}, 500);
  }
  const priorCheckResults = request.prior_check_results ?? [];
  const maxProtocolRepairs = request.max_protocol_repairs ?? 2;
  if (!Number.isSafeInteger(maxProtocolRepairs) || maxProtocolRepairs < 0 || maxProtocolRepairs > 8) {
    fail('MODEL_STAGE_CONFIGURATION_INVALID', 'max_protocol_repairs must be between 0 and 8', {}, 500);
  }
  if (!Array.isArray(priorCheckResults)) {
    fail('MODEL_STAGE_CONFIGURATION_INVALID', 'prior_check_results must be an array', {}, 500);
  }
  if (priorCheckResults.length > maxChecks) {
    fail('MODEL_STAGE_CONFIGURATION_INVALID', 'prior check results exceed the Referee limit', {
      max_check_requests: maxChecks,
      prior_check_result_count: priorCheckResults.length
    }, 500);
  }
  let session = request.session ?? null;
  let initialPrompt = request.prompt;
  let calls = 0;
  let protocolRepairs = 0;
  const usage = emptyStageUsage();
  const checkResults = priorCheckResults.map(result => assertResolutionCheckResult(result));
  while (true) {
    const output = request.transport_mode === 'native_tools'
      ? {
          mode: 'native_tools',
          tools: [createResolutionCheckToolContract()],
          tool_choice: 'auto',
          ...(request.use_provider_json_schema === true
            ? {
                response_schema: RESOLUTION_CANDIDATE_JSON_SCHEMA,
                response_name: 'naruto_multiplayer_resolution_candidate'
              }
            : {})
        }
      : { mode: 'json_object' };
    const invoked = await request.client.invoke(stageRequest(request, {
      // Official Flash shares its token ceiling with internal thinking. Keep
      // the bounded structured response available even for impossible intents.
      reasoning_effort: request.reasoning_effort ?? 'none',
      system_prompt: systemWithContracts(request.system_prompt, [
        RESOLUTION_CANDIDATE_JSON_SCHEMA,
        request.transport_mode === 'json_protocol'
          ? REFEREE_CHECK_JSON_COMMAND_JSON_SCHEMA
          : createResolutionCheckToolContract()
      ]),
      prompt: initialPrompt,
      session,
      output
    }));
    calls += 1;
    addUsage(usage, invoked.response.usage);
    session = invoked.session;
    initialPrompt = null;
    let parsed;
    try {
      parsed = parseRefereeResponse(invoked.response, request.transport_mode);
    } catch (error) {
      if (!(error instanceof DomainError)
        || !['SCHEMA_VIOLATION', 'MODEL_PROTOCOL_VIOLATION', 'MODEL_OUTPUT_TRUNCATED'].includes(error.code)
        || protocolRepairs >= maxProtocolRepairs) throw error;
      protocolRepairs += 1;
      // No candidate or check has been executed. Feed the precise contract
      // error back to the same session; never fill in model facts ourselves.
      session = appendTrustedProtocolResults(session, {
        tool_call_ids: invoked.response.tool_calls.map(call => call.id),
        result: {
          schema: 'naruto.multiplayer-referee-protocol-retry/v1', status: 'PROTOCOL_RETRY',
          attempt: protocolRepairs, remaining_repairs: maxProtocolRepairs - protocolRepairs,
          error: { code: error.code, message: error.message, details: error.details ?? {} },
          instruction: '保持已确定的合理世界结果，只修正响应合同并重新输出完整 JSON；每个事件必须关联至少一个 outcome。不要向玩家拒绝或要求重输。未执行任何工具或状态效果，已有受信检定结果仍然有效。'
        }
      });
      continue;
    }
    if (parsed.kind === 'resolution_candidate') {
      return Object.freeze({
        candidate: parsed.candidate,
        session,
        calls,
        usage: finalizedUsage(usage),
        check_results: Object.freeze(checkResults),
        last_response: invoked.response,
        last_invocation_id: invoked.invocation_id ?? null
      });
    }
    if (checkResults.length >= maxChecks) {
      fail('REFEREE_CHECK_LIMIT_EXCEEDED', 'Referee exceeded its authoritative check limit', {
        max_check_requests: maxChecks
      }, 409);
    }
    const checkResult = assertResolutionCheckResult(await request.execute_check(parsed.request));
    checkResults.push(checkResult);
    session = appendTrustedProtocolResults(session, {
      result: checkResult,
      tool_call_ids: parsed.tool_call_id === null ? [] : [parsed.tool_call_id]
    });
  }
}

async function invokeStrictJsonStage(request, {
  systemPrompt,
  prompt,
  outputName,
  outputSchema,
  validate,
  label,
  session = null,
  trustedResult = null,
  trustedToolCallId = null
}) {
  if (trustedResult !== null) {
    if (!session) fail('PROVIDER_SESSION_INVALID', `${label} continuation is missing its session`, {}, 500);
    session = appendTrustedProtocolResult(session, {
      result: trustedResult,
      tool_call_id: trustedToolCallId
    });
  }
  const invoked = await request.client.invoke(stageRequest(request, {
    system_prompt: systemWithContracts(systemPrompt, [outputSchema]),
    prompt,
    session,
    output: request.use_provider_json_schema === true
      ? {
          mode: 'json_schema',
          name: outputName,
          schema: outputSchema
        }
      : { mode: 'json_object' }
  }));
  assertResponseNotTruncated(invoked.response, `${label} response`);
  const text = noNativeToolCalls(invoked.response, `${label} response`);
  const value = parseStrictJsonObject(text, { label: `${label} response`, validate });
  return Object.freeze({
    value,
    session: invoked.session,
    response: invoked.response,
    usage: invoked.response.usage,
    calls: 1,
    invocation_id: invoked.invocation_id ?? null
  });
}

export function invokeWriterModel(request) {
  // The Writer expands already-adjudicated facts. Official Flash can spend its
  // output budget on prose; the adapter ignores this option for other models.
  return invokeStrictJsonStage({ ...request, reasoning_effort: request.reasoning_effort ?? 'none' }, {
    systemPrompt: request.system_prompt,
    prompt: request.prompt,
    outputName: 'naruto_multiplayer_narrative_candidate',
    outputSchema: NARRATIVE_CANDIDATE_JSON_SCHEMA,
    validate: assertNarrativeCandidate,
    label: 'Writer',
    session: request.session,
    trustedResult: request.trusted_result ?? null
  });
}

export function invokeResolutionCompletenessReviewer(request) {
  return invokeStrictJsonStage({ ...request, reasoning_effort: request.reasoning_effort ?? 'none' }, {
    systemPrompt: request.system_prompt,
    prompt: request.prompt,
    outputName: 'naruto_resolution_completeness_review',
    outputSchema: RESOLUTION_COMPLETENESS_REVIEW_JSON_SCHEMA,
    validate: assertResolutionCompletenessReview,
    label: 'ResolutionCompletenessReviewer',
    session: request.session
  });
}

export function invokeNarrativeGroundingReviewer(request) {
  const expectedAudiences = request.expected_audiences;
  return invokeStrictJsonStage({ ...request, reasoning_effort: request.reasoning_effort ?? 'none' }, {
    systemPrompt: request.system_prompt,
    prompt: request.prompt,
    outputName: 'naruto_narrative_grounding_review',
    outputSchema: NARRATIVE_GROUNDING_CANDIDATE_JSON_SCHEMA,
    validate: value => assertNarrativeGroundingCandidate(value, expectedAudiences),
    label: 'NarrativeGroundingReviewer',
    session: request.session
  });
}

function continuityOutput(operation, transportMode) {
  if (!CONTINUITY_OPERATION_SET.has(operation)) {
    fail('MODEL_STAGE_CONFIGURATION_INVALID', 'Continuity operation is invalid', { operation }, 500);
  }
  if (transportMode === 'native_tools') {
    return {
      mode: 'native_tools',
      tools: [createContinuityToolContract(operation)],
      allowed_tool_name: operation,
      tool_choice: 'required'
    };
  }
  if (transportMode === 'json_protocol') return { mode: 'json_object' };
  fail('MODEL_STAGE_CONFIGURATION_INVALID', 'Continuity transport is invalid', {}, 500);
}

function continuityPromptContracts(operation, transportMode) {
  const tool = createContinuityToolContract(operation);
  const standaloneBundleSchema = normalizeProviderJsonSchema(
    tool.input_schema,
    tool.referenced_schemas
  );
  if (transportMode === 'native_tools') {
    return [{
      name: tool.name,
      description: tool.description,
      input_schema: standaloneBundleSchema
    }];
  }
  return [normalizeProviderJsonSchema(
    CONTINUITY_JSON_ENVELOPE_JSON_SCHEMA,
    [tool.input_schema, ...tool.referenced_schemas]
  )];
}

/** One billed Continuity request; Bundle item count never changes calls=1. */
export async function invokeContinuityModel(request) {
  let session = request.session ?? null;
  if (request.trusted_result !== undefined && request.trusted_result !== null) {
    if (!session) fail('PROVIDER_SESSION_INVALID', 'Continuity continuation is missing its session', {}, 500);
    const replyIds = request.reply_to_tool_call_ids
      ?? (request.reply_to_tool_call_id ? [request.reply_to_tool_call_id] : []);
    session = appendTrustedProtocolResults(session, {
      result: request.trusted_result,
      tool_call_ids: replyIds
    });
  }
  const invoked = await request.client.invoke(stageRequest(request, {
    system_prompt: systemWithContracts(
      `${request.system_prompt}\n\n${buildShinobiDailyRulesPrompt()}\n日报条目的 source_refs 与 daily 同级；daily 内部及其各栏目不得添加 source_refs 等额外字段。source_refs.headline 与 source_refs.quote 是一维字符串数组，格式 ["public:实际可用ID"]；world/flavor/missions 分别为 4/3/4 行二维数组，每行对应一条新闻。只能从该 obligation 的 worldPublicRefs 中原样取值，不能给私密 event_id 加 public: 前缀冒充公开事件。日报内容本身也只能写这些公开来源已成立的事；公开素材不足时可写待核查或暂无公开消息，不能补编任务报酬、命令或私人通报。修复时一次处理反馈中的全部问题。\n当前服务器校验器的受信引用表（重试时同样有效）：\n${JSON.stringify({ trusted_reference_bindings: request.reference_bindings ?? {} })}`,
      continuityPromptContracts(request.operation, request.transport_mode)
    ),
    prompt: request.prompt,
    session,
    // This stage packages an already frozen verdict. Flash's separate thinking
    // output can consume the entire 8K limit before the Bundle is delivered.
    reasoning_effort: 'none',
    output: continuityOutput(request.operation, request.transport_mode)
  }));
  let command;
  let transportInput;
  let replyToToolCallId = null;
  let replyToToolCallIds = invoked.response.tool_calls.map(call => call.id);
  try {
    assertResponseNotTruncated(invoked.response, 'Continuity response');
    if (request.transport_mode === 'native_tools') {
      replyToToolCallId = invoked.response.tool_calls[0]?.id ?? null;
      const call = oneNativeTool(
        invoked.response,
        request.operation,
        'Continuity response'
      );
      replyToToolCallId = call.id;
      replyToToolCallIds = [call.id];
      transportInput = Object.freeze({
        transport_mode: 'native_tools',
        tool_name: call.name,
        raw_arguments: call.raw_arguments
      });
      command = decodeNativeContinuityCommand(call.name, call.raw_arguments);
    } else {
      const text = noNativeToolCalls(invoked.response, 'Continuity response');
      transportInput = Object.freeze({
        transport_mode: 'json_protocol',
        response_text: text
      });
      command = decodeJsonContinuityCommand(text);
    }
    if (command.operation !== request.operation) {
      fail('MODEL_PROTOCOL_VIOLATION', 'Continuity returned the wrong operation', {
        expected_operation: request.operation,
        actual_operation: command.operation,
        expected_protocol: CONTINUITY_JSON_ENVELOPE_SCHEMA
      });
    }
  } catch (error) {
    if (!request.capture_protocol_errors || !(error instanceof DomainError)) throw error;
    return Object.freeze({
      command: null,
      transport_input: null,
      reply_to_tool_call_id: replyToToolCallId,
      reply_to_tool_call_ids: Object.freeze([...replyToToolCallIds]),
      session: invoked.session,
      response: invoked.response,
      usage: invoked.response.usage,
      calls: 1,
      invocation_id: invoked.invocation_id ?? null,
      protocol_error: Object.freeze({
        code: error.code,
        message: error.message,
        details: error.details
      })
    });
  }
  return Object.freeze({
    command,
    transport_input: transportInput,
    reply_to_tool_call_id: replyToToolCallId,
    reply_to_tool_call_ids: Object.freeze([...replyToToolCallIds]),
    session: invoked.session,
    response: invoked.response,
    usage: invoked.response.usage,
    calls: 1,
    invocation_id: invoked.invocation_id ?? null,
    command_json: canonicalStringify(command)
  });
}
