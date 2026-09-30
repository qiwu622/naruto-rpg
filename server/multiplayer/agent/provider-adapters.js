import {
  assertModelEndpointProfile,
  assertModelProfileCredentialBinding
} from '../contracts/billing-contracts.js';
import {
  canonicalStringify,
  canonicalizeJson
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { buildShinobiDailyJsonSchema } from '../../../js/core/shinobi-daily.js';

export const PROVIDER_SESSION_SCHEMA = 'naruto.multiplayer-provider-session/v1';
export const NORMALIZED_MODEL_RESPONSE_SCHEMA =
  'naruto.multiplayer-normalized-model-response/v1';
export const NORMALIZED_MODEL_USAGE_SCHEMA =
  'naruto.multiplayer-normalized-model-usage/v1';

const ADAPTERS = new Set(['openai_compatible', 'anthropic']);

const SHINOBI_DAILY_PROVIDER_JSON_SCHEMA = Object.freeze(buildShinobiDailyJsonSchema());

function fail(code, message, details = {}, status = 502, cause) {
  throw new DomainError(code, message, details, { status, cause });
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function immutable(value) {
  const cloned = canonicalizeJson(value, { maxDepth: 96, maxNodes: 500_000 });
  const freeze = item => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(cloned);
}

function pointerValue(root, pointer) {
  const parts = pointer.slice(2).split('/').map(part => (
    part.replaceAll('~1', '/').replaceAll('~0', '~')
  ));
  let value = root;
  for (const part of parts) value = value?.[part];
  return value;
}

/** Produces a standalone provider schema with no unresolved external/local refs. */
export function normalizeProviderJsonSchema(schemaValue, referencedSchemas = []) {
  if (!isRecord(schemaValue)) {
    fail('MODEL_STAGE_REQUEST_INVALID', 'provider JSON schema must be an object', {}, 500);
  }
  const registry = new Map();
  for (const schema of [schemaValue, ...referencedSchemas, SHINOBI_DAILY_PROVIDER_JSON_SCHEMA]) {
    if (isRecord(schema) && typeof schema.$id === 'string') registry.set(schema.$id, schema);
  }
  const resolve = (node, root, stack) => {
    if (Array.isArray(node)) return node.map(item => resolve(item, root, stack));
    if (!isRecord(node)) return node;
    if (typeof node.$ref === 'string') {
      const reference = node.$ref;
      const target = reference.startsWith('#/')
        ? pointerValue(root, reference)
        : registry.get(reference);
      if (!target) {
        fail('MODEL_STAGE_REQUEST_INVALID', 'provider JSON schema has an unresolved reference', {
          reference
        }, 500);
      }
      const identity = `${root.$id ?? 'root'}\u0000${reference}`;
      if (stack.has(identity)) {
        fail('MODEL_STAGE_REQUEST_INVALID', 'provider JSON schema contains a recursive reference', {
          reference
        }, 500);
      }
      return resolve(target, reference.startsWith('#/') ? root : target, new Set([...stack, identity]));
    }
    const result = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$id' || key === '$schema' || key === '$defs') continue;
      result[key] = resolve(value, root, stack);
    }
    return result;
  };
  return immutable(resolve(schemaValue, schemaValue, new Set()));
}

function assertAdapter(adapter) {
  if (!ADAPTERS.has(adapter)) {
    fail('MODEL_ADAPTER_UNSUPPORTED', 'model adapter is unsupported', { adapter }, 400);
  }
  return adapter;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function usageRecord({ input, output, cacheRead = 0, cacheCreation = 0, total = null }) {
  const inputTokens = safeInteger(input);
  const outputTokens = safeInteger(output);
  const cacheReadTokens = safeInteger(cacheRead);
  const cacheCreationTokens = safeInteger(cacheCreation);
  return immutable({
    schema: NORMALIZED_MODEL_USAGE_SCHEMA,
    requests: 1,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Number.isSafeInteger(total) && total >= 0
      ? total
      : inputTokens + outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens
  });
}

export function normalizeProviderUsage(adapterValue, rawUsage) {
  const adapter = assertAdapter(adapterValue);
  const usage = isRecord(rawUsage) ? rawUsage : {};
  if (adapter === 'openai_compatible') {
    return usageRecord({
      input: usage.prompt_tokens ?? usage.input_tokens,
      output: usage.completion_tokens ?? usage.output_tokens,
      total: usage.total_tokens,
      cacheRead: usage.prompt_tokens_details?.cached_tokens
        ?? usage.input_tokens_details?.cached_tokens,
      cacheCreation: usage.prompt_tokens_details?.cache_creation_tokens
        ?? usage.input_tokens_details?.cache_creation_tokens
    });
  }
  return usageRecord({
    input: usage.input_tokens,
    output: usage.output_tokens,
    total: usage.input_tokens + usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheCreation: usage.cache_creation_input_tokens
  });
}

function textFromOpenAiContent(content) {
  if (content === null || content === undefined) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'OpenAI-compatible message content is invalid');
  }
  let text = '';
  for (const block of content) {
    if (!isRecord(block) || !['text', 'output_text'].includes(block.type)
      || typeof block.text !== 'string') {
      fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'OpenAI-compatible response contains a non-text content block');
    }
    text += block.text;
  }
  return text;
}

function normalizeOpenAiToolCalls(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'OpenAI-compatible tool_calls must be an array');
  }
  return value.map((call, index) => {
    if (!isRecord(call) || call.type !== 'function' || !isRecord(call.function)
      || typeof call.id !== 'string' || !call.id
      || typeof call.function.name !== 'string' || !call.function.name
      || !Object.prototype.hasOwnProperty.call(call.function, 'arguments')
      || !['string', 'object'].includes(typeof call.function.arguments)
      || call.function.arguments === null) {
      fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'OpenAI-compatible tool call is malformed', {
        tool_call_index: index
      });
    }
    // Do not parse here. Item-aware Continuity/check decoders must see the
    // provider's original arguments instead of an SDK-validated replacement.
    return {
      id: call.id,
      name: call.function.name,
      raw_arguments: call.function.arguments
    };
  });
}

function normalizeOpenAiResponse(body) {
  if (!Array.isArray(body?.choices) || body.choices.length < 1) {
    fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'OpenAI-compatible response has no choices');
  }
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'OpenAI-compatible response choice has no assistant message');
  }
  return {
    response_id: typeof body.id === 'string' ? body.id : null,
    raw_text: textFromOpenAiContent(choice.message.content),
    tool_calls: normalizeOpenAiToolCalls(choice.message.tool_calls),
    finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: normalizeProviderUsage('openai_compatible', body.usage)
  };
}

function normalizeAnthropicResponse(body) {
  if (!Array.isArray(body?.content)) {
    fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'Anthropic response content must be an array');
  }
  let rawText = '';
  let sawText = false;
  const toolCalls = [];
  for (let index = 0; index < body.content.length; index += 1) {
    const block = body.content[index];
    if (!isRecord(block)) {
      fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'Anthropic content block is malformed', {
        content_index: index
      });
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'Anthropic text block is malformed');
      }
      rawText += block.text;
      sawText = true;
      continue;
    }
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id
        || typeof block.name !== 'string' || !block.name
        || !isRecord(block.input)) {
        fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'Anthropic tool_use block is malformed', {
          content_index: index
        });
      }
      toolCalls.push({
        id: block.id,
        name: block.name,
        raw_arguments: block.input
      });
      continue;
    }
    // Thinking/citation/server-tool blocks are not accepted in an authority
    // response because they cannot participate in the strict stage contract.
    fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'Anthropic response contains an unsupported content block', {
      content_index: index,
      content_type: typeof block.type === 'string' ? block.type : null
    });
  }
  return {
    response_id: typeof body.id === 'string' ? body.id : null,
    raw_text: sawText ? rawText : null,
    tool_calls: toolCalls,
    finish_reason: typeof body.stop_reason === 'string' ? body.stop_reason : null,
    usage: normalizeProviderUsage('anthropic', body.usage)
  };
}

export function normalizeProviderResponse(adapterValue, gatewayResponse) {
  const adapter = assertAdapter(adapterValue);
  const body = isRecord(gatewayResponse?.body) ? gatewayResponse.body : gatewayResponse;
  if (!isRecord(body)) {
    fail('MODEL_ENDPOINT_RESPONSE_INVALID', 'model gateway response body is invalid');
  }
  const normalized = adapter === 'openai_compatible'
    ? normalizeOpenAiResponse(body)
    : normalizeAnthropicResponse(body);
  return immutable({
    schema: NORMALIZED_MODEL_RESPONSE_SCHEMA,
    adapter,
    provider_request_id: typeof gatewayResponse?.provider_request_id === 'string'
      ? gatewayResponse.provider_request_id
      : null,
    ...normalized
  });
}

function assertSession(session, adapter = null) {
  if (!isRecord(session) || session.schema !== PROVIDER_SESSION_SCHEMA
    || !ADAPTERS.has(session.adapter) || !Array.isArray(session.entries)) {
    fail('PROVIDER_SESSION_INVALID', 'provider continuation session is invalid', {}, 500);
  }
  if (adapter && session.adapter !== adapter) {
    fail('PROVIDER_SESSION_ADAPTER_MISMATCH', 'provider session cannot cross adapters', {
      expected_adapter: adapter,
      actual_adapter: session.adapter
    }, 409);
  }
  return session;
}

export function createProviderSession(adapterValue) {
  return immutable({
    schema: PROVIDER_SESSION_SCHEMA,
    adapter: assertAdapter(adapterValue),
    entries: []
  });
}

function withEntry(sessionValue, entry) {
  const session = assertSession(sessionValue);
  return immutable({
    ...session,
    entries: [...session.entries, entry]
  });
}

export function appendProviderUserMessage(session, text) {
  if (typeof text !== 'string' || !text.trim()) {
    fail('PROVIDER_SESSION_MESSAGE_INVALID', 'provider user message must be non-empty', {}, 500);
  }
  return withEntry(session, { kind: 'user_text', text });
}

export function appendProviderAssistantResponse(sessionValue, responseValue) {
  const session = assertSession(sessionValue);
  const response = responseValue;
  if (!isRecord(response) || response.schema !== NORMALIZED_MODEL_RESPONSE_SCHEMA
    || response.adapter !== session.adapter) {
    fail('PROVIDER_SESSION_MESSAGE_INVALID', 'normalized assistant response is invalid', {}, 500);
  }
  return withEntry(session, {
    kind: 'assistant',
    raw_text: response.raw_text,
    tool_calls: response.tool_calls
  });
}

export function appendTrustedProtocolResult(sessionValue, {
  result,
  tool_call_id = null
}) {
  return appendTrustedProtocolResults(sessionValue, {
    result,
    tool_call_ids: tool_call_id === null ? [] : [tool_call_id]
  });
}

/**
 * Appends one authoritative continuation result for every unresolved native
 * tool call in the preceding assistant message. Providers require each tool
 * call to receive a result before another assistant turn can begin. JSON
 * protocol continuations use an empty ID list and are mapped to a standard
 * user message that is explicitly marked server-authoritative.
 */
export function appendTrustedProtocolResults(sessionValue, {
  result,
  tool_call_ids = []
}) {
  const session = assertSession(sessionValue);
  if (!Array.isArray(tool_call_ids)) {
    fail('PROVIDER_SESSION_MESSAGE_INVALID', 'tool_call_ids must be an array', {}, 500);
  }
  const seen = new Set();
  for (const toolCallId of tool_call_ids) {
    if (typeof toolCallId !== 'string' || !toolCallId || seen.has(toolCallId)) {
      fail('PROVIDER_SESSION_MESSAGE_INVALID', 'tool_call_ids are invalid', {}, 500);
    }
    seen.add(toolCallId);
  }
  return withEntry(session, {
    kind: 'trusted_protocol_results',
    tool_call_ids: [...tool_call_ids],
    result
  });
}

function trustedResultText(result) {
  return canonicalStringify({
    schema: 'naruto.multiplayer-trusted-protocol-result-message/v1',
    trust: 'server_authoritative',
    protocol_result: result
  });
}

function openAiMessages(sessionValue, systemPrompt) {
  const session = assertSession(sessionValue, 'openai_compatible');
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const entry of session.entries) {
    if (entry.kind === 'user_text') {
      messages.push({ role: 'user', content: entry.text });
    } else if (entry.kind === 'assistant') {
      const message = { role: 'assistant', content: entry.raw_text };
      if (entry.tool_calls.length) {
        message.tool_calls = entry.tool_calls.map(call => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.raw_arguments === 'string'
              ? call.raw_arguments
              : canonicalStringify(call.raw_arguments)
          }
        }));
      }
      messages.push(message);
    } else if (entry.kind === 'trusted_protocol_result') {
      // Backward-compatible decoding for sessions persisted by the first
      // implementation before batched native tool-result support existed.
      if (entry.tool_call_id === null) {
        messages.push({ role: 'user', content: trustedResultText(entry.result) });
      } else {
        messages.push({
          role: 'tool',
          tool_call_id: entry.tool_call_id,
          content: canonicalStringify(entry.result)
        });
      }
    } else if (entry.kind === 'trusted_protocol_results') {
      if (entry.tool_call_ids.length === 0) {
        messages.push({ role: 'user', content: trustedResultText(entry.result) });
      } else {
        for (const toolCallId of entry.tool_call_ids) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: canonicalStringify(entry.result)
          });
        }
      }
    }
  }
  return messages;
}

function anthropicToolInput(rawArguments) {
  if (isRecord(rawArguments)) return rawArguments;
  if (typeof rawArguments !== 'string') return {};
  try {
    const parsed = JSON.parse(rawArguments);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function anthropicMessages(sessionValue) {
  const session = assertSession(sessionValue, 'anthropic');
  const messages = [];
  for (const entry of session.entries) {
    if (entry.kind === 'user_text') {
      messages.push({ role: 'user', content: [{ type: 'text', text: entry.text }] });
    } else if (entry.kind === 'assistant') {
      const content = [];
      if (entry.raw_text !== null) content.push({ type: 'text', text: entry.raw_text });
      for (const call of entry.tool_calls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: anthropicToolInput(call.raw_arguments)
        });
      }
      messages.push({ role: 'assistant', content });
    } else if (entry.kind === 'trusted_protocol_result') {
      // Backward-compatible decoding for already-persisted sessions.
      if (entry.tool_call_id === null) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: trustedResultText(entry.result) }]
        });
      } else {
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: entry.tool_call_id,
            content: canonicalStringify(entry.result)
          }]
        });
      }
    } else if (entry.kind === 'trusted_protocol_results') {
      if (entry.tool_call_ids.length === 0) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: trustedResultText(entry.result) }]
        });
      } else {
        messages.push({
          role: 'user',
          content: entry.tool_call_ids.map(toolCallId => ({
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: canonicalStringify(entry.result)
          }))
        });
      }
    }
  }
  return messages;
}

export function providerContinuationMessages(sessionValue, systemPrompt) {
  const session = assertSession(sessionValue);
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    fail('MODEL_STAGE_REQUEST_INVALID', 'system prompt must be non-empty', {}, 500);
  }
  return session.adapter === 'openai_compatible'
    ? immutable(openAiMessages(session, systemPrompt))
    : immutable(anthropicMessages(session));
}

function providerTool(adapter, tool) {
  if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name
    || !isRecord(tool.input_schema)) {
    fail('MODEL_STAGE_REQUEST_INVALID', 'provider tool contract is invalid', {}, 500);
  }
  if (adapter === 'openai_compatible') {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: normalizeProviderJsonSchema(
          tool.input_schema,
          tool.referenced_schemas ?? []
        )
      }
    };
  }
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: normalizeProviderJsonSchema(
      tool.input_schema,
      tool.referenced_schemas ?? []
    )
  };
}

function outputConfiguration(adapter, output) {
  if (!output || output.mode === 'text') return {};
  if (output.mode === 'json_object') {
    return adapter === 'openai_compatible'
      ? { response_format: { type: 'json_object' } }
      : {};
  }
  if (output.mode === 'json_schema') {
    if (!isRecord(output.schema) || typeof output.name !== 'string' || !output.name) {
      fail('MODEL_STAGE_REQUEST_INVALID', 'JSON output contract is invalid', {}, 500);
    }
    // Capability probes deliberately verify JSON-object output rather than
    // provider-specific Structured Outputs. Keep the authoritative schema in
    // the system prompt and enforce it locally, but do not send an unprobed
    // response_format dialect to OpenAI-compatible relays.
    normalizeProviderJsonSchema(output.schema);
    return adapter === 'openai_compatible'
      ? { response_format: { type: 'json_object' } }
      : {};
  }
  if (output.mode !== 'native_tools' || !Array.isArray(output.tools)
    || output.tools.length < 1) {
    fail('MODEL_STAGE_REQUEST_INVALID', 'native tool output contract is invalid', {}, 500);
  }
  const tools = output.tools.map(tool => providerTool(adapter, tool));
  const selectedName = output.allowed_tool_name ?? output.tools[0].name;
  if (adapter === 'openai_compatible') {
    return {
      tools,
      tool_choice: output.tool_choice === 'required'
        ? { type: 'function', function: { name: selectedName } }
        : 'auto'
    };
  }
  return {
    tools,
    tool_choice: output.tool_choice === 'required'
      ? { type: 'tool', name: selectedName, disable_parallel_tool_use: true }
      : { type: 'auto', disable_parallel_tool_use: true }
  };
}

function openAiRequestParameterPolicy(modelValue) {
  const model = modelValue.trim().toLowerCase().split('/').at(-1);
  const usesCompletionTokens = ['gpt-5', 'o1', 'o3', 'o4']
    .some(prefix => model.startsWith(prefix));
  const omitsTemperature = usesCompletionTokens
    || model.includes('reasoner')
    || model.includes('r1');
  return { usesCompletionTokens, omitsTemperature };
}

export function buildProviderRequest({
  profile: profileValue,
  system_prompt,
  session,
  output = { mode: 'text' },
  max_output_tokens = 4_096,
  temperature = 0,
  reasoning_effort = null
}) {
  const profile = assertModelEndpointProfile(profileValue);
  assertSession(session, profile.adapter);
  if (typeof system_prompt !== 'string' || !system_prompt.trim()) {
    fail('MODEL_STAGE_REQUEST_INVALID', 'system_prompt must be non-empty', {}, 500);
  }
  if (!Number.isSafeInteger(max_output_tokens) || max_output_tokens < 1) {
    fail('MODEL_STAGE_REQUEST_INVALID', 'max_output_tokens must be positive', {}, 500);
  }
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)
    || temperature < 0 || temperature > 2) {
    fail('MODEL_STAGE_REQUEST_INVALID', 'temperature is invalid', {}, 500);
  }
  if (reasoning_effort !== null && !['none', 'low', 'high', 'max'].includes(reasoning_effort)) {
    fail('MODEL_STAGE_REQUEST_INVALID', 'reasoning_effort is invalid', {}, 500);
  }
  if (profile.adapter === 'openai_compatible') {
    const parameterPolicy = openAiRequestParameterPolicy(profile.model);
    // Only the verified official Flash endpoint receives this vendor option.
    // Relays and other models may implement different parameter dialects.
    const flashEffort = reasoning_effort !== null && profile.model === 'deepseek-flash'
      && profile.endpoint.normalized_origin === 'https://api.deepseek.com'
      ? (reasoning_effort === 'none' ? { thinking: { type: 'disabled' } } : { reasoning_effort }) : {};
    return immutable({
      model: profile.model,
      ...(parameterPolicy.usesCompletionTokens
        ? { max_completion_tokens: max_output_tokens }
        : { max_tokens: max_output_tokens }),
      ...(!parameterPolicy.omitsTemperature ? { temperature } : {}),
      ...flashEffort,
      ...outputConfiguration(profile.adapter, output),
      messages: openAiMessages(session, system_prompt),
      stream: false
    });
  }
  return immutable({
    model: profile.model,
    max_tokens: max_output_tokens,
    temperature,
    ...outputConfiguration(profile.adapter, output),
    system: system_prompt,
    messages: anthropicMessages(session),
    stream: false
  });
}

function unwrapProfile(result) {
  return isRecord(result?.profile) ? result.profile : result;
}

function unwrapCredential(result) {
  return isRecord(result?.credential) ? result.credential : result;
}

/**
 * Actual stage client over ModelHttpGateway. Direct profile/credential values
 * are convenient for tests; resolver functions wire the same code to the
 * profile and encrypted-credential repositories in production composition.
 */
export function createProviderModelClient({
  modelHttpGateway,
  resolveProfile = null,
  resolveCredential = null,
  credentialVault = null
} = {}) {
  if (typeof modelHttpGateway?.invoke !== 'function') {
    fail('MODEL_STAGE_CLIENT_CONFIGURATION_INVALID', 'modelHttpGateway.invoke is required', {}, 500);
  }

  async function loadProfile(request) {
    if (request.profile) return assertModelEndpointProfile(unwrapProfile(request.profile));
    if (typeof resolveProfile !== 'function') {
      fail('MODEL_PROFILE_REQUIRED', 'model profile or resolver is required', {}, 409);
    }
    return assertModelEndpointProfile(unwrapProfile(await resolveProfile({
      owner_user_id: request.owner_user_id,
      profile_ref: request.profile_ref
    })));
  }

  async function loadCredential(request, profile) {
    if (profile.auth_scheme === 'none') return null;
    let credential = unwrapCredential(request.credential ?? null);
    if (!credential && typeof resolveCredential === 'function') {
      credential = unwrapCredential(await resolveCredential({
        owner_user_id: request.owner_user_id,
        credential_ref: profile.credential_ref,
        profile
      }));
    }
    if (!credential) fail('MODEL_CREDENTIAL_REQUIRED', 'model credential is required', {}, 409);
    assertModelProfileCredentialBinding(profile, credential);
    return credential;
  }

  async function invoke(request) {
    const profile = await loadProfile(request);
    if (request.owner_user_id !== profile.owner_user_id) {
      fail('MODEL_PROFILE_OWNER_MISMATCH', 'stage payer does not own the selected profile', {}, 403);
    }
    const credential = await loadCredential(request, profile);
    let session = request.session ?? createProviderSession(profile.adapter);
    if (request.prompt !== undefined && request.prompt !== null) {
      session = appendProviderUserMessage(session, request.prompt);
    }
    const body = buildProviderRequest({
      profile,
      system_prompt: request.system_prompt,
      session,
      output: request.output,
      max_output_tokens: request.max_output_tokens,
      temperature: request.temperature,
      reasoning_effort: request.reasoning_effort
    });
    const gatewayResponse = await modelHttpGateway.invoke({
      profile,
      operation: 'generate',
      body,
      credential,
      credential_vault: request.credential_vault ?? credentialVault,
      owner_user_id: request.owner_user_id,
      signal: request.signal
    });
    const response = normalizeProviderResponse(profile.adapter, gatewayResponse);
    return Object.freeze({
      profile,
      request_body: body,
      response,
      session: appendProviderAssistantResponse(session, response)
    });
  }

  return Object.freeze({ invoke });
}
