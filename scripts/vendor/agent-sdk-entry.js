import { ToolLoopAgent, jsonSchema, stepCountIs, tool } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createToolResultBudget } from '../../js/core/tool-result-budget.js';
import { isNativeAndroidApp } from '../../js/core/runtime-platform.js';
import { fetchAI } from '../../js/core/native-ai-fetch.js';

export const version = 'naruto-agent-sdk/v1';

function headerValue(headers, name) {
  if (!headers) return '';
  const normalized = new Headers(headers);
  return normalized.get(name) || '';
}

function normalizeBaseUrl(value, backend) {
  const fallback = backend === 'claude'
    ? 'https://api.anthropic.com/v1'
    : 'https://api.openai.com/v1';
  const raw = String(value || fallback).trim().replace(/\/+$/, '');
  return raw
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/messages$/i, '');
}

function proxyFetch(config) {
  return async (input, init = {}) => {
    const targetUrl = typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url;
    const sourceHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || {}).forEach((value, key) => sourceHeaders.set(key, value));
    const headers = {
      'Content-Type': sourceHeaders.get('content-type') || 'application/json',
      'x-target-url': targetUrl,
      'x-user-api-key': String(config.apiKey || ''),
      'x-api-key-header': config.backend === 'claude' ? 'x-api-key' : 'Authorization',
      'x-proxy-purpose': 'agent'
    };
    const accept = sourceHeaders.get('accept');
    if (accept) headers.Accept = accept;
    for (const name of ['anthropic-version', 'anthropic-beta']) {
      const value = headerValue(sourceHeaders, name);
      if (value) headers[name] = value;
    }
    return fetch('/api/ai-proxy', {
      ...init,
      method: init.method || (input instanceof Request ? input.method : 'POST'),
      headers,
      body: init.body ?? (input instanceof Request ? input.body : undefined)
    });
  };
}

function directFetch() {
  return (input, init = {}) => fetchAI(input, init);
}

function createModel(config = {}) {
  const backend = String(config.backend || 'openai').toLowerCase();
  const baseURL = normalizeBaseUrl(config.apiUrl, backend);
  const fetch = isNativeAndroidApp()
    ? directFetch()
    : proxyFetch({ ...config, backend });
  if (backend === 'claude' || backend === 'anthropic') {
    return createAnthropic({
      baseURL,
      apiKey: config.apiKey || 'proxy-managed',
      fetch,
      headers: { 'anthropic-version': '2023-06-01' }
    })(config.model);
  }
  const provider = createOpenAICompatible({
    name: `naruto-${backend || 'openai'}`,
    baseURL,
    apiKey: config.apiKey || 'proxy-managed',
    fetch,
    includeUsage: true,
    supportsStructuredOutputs: config.supportsStructuredOutputs === true
  });
  return provider.chatModel(config.model);
}

function safeEvent(callback, event) {
  try { callback?.(event); } catch { /* progress listeners cannot fail the agent */ }
}

function compileTools(definitions = {}, onEvent, trace, resultBudget, useAnthropicCache = false) {
  const names = Object.keys(definitions).sort();
  return Object.fromEntries(names.map((name, index) => {
    const definition = definitions[name] || {};
    return [name, tool({
      description: String(definition.description || ''),
      inputSchema: jsonSchema(definition.inputSchema || {
        type: 'object',
        additionalProperties: true
      }),
      ...(useAnthropicCache && index === names.length - 1 ? {
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' } }
        }
      } : {}),
      execute: async input => {
        const startedAt = performance.now();
        const callId = globalThis.crypto?.randomUUID?.()
          || `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        safeEvent(onEvent, { type: 'tool-start', callId, tool: name, input });
        try {
          const output = await definition.execute(input);
          const event = {
            type: 'tool-end', callId, tool: name, success: true,
            durationMs: Math.round(performance.now() - startedAt), output
          };
          trace.push(event);
          safeEvent(onEvent, event);
          return resultBudget.limit(output, { tool: name });
        } catch (error) {
          const message = String(error?.message || error);
          const event = {
            type: 'tool-end', callId, tool: name, success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error: message
          };
          trace.push(event);
          safeEvent(onEvent, event);
          return {
            ok: false,
            error: resultBudget.limit({ message }, { tool: name })
          };
        }
      }
    })];
  }));
}

export async function runAgent({
  config = {}, definition = {}, messages = [], tools = {}, budget = {}, signal, onEvent
} = {}) {
  if (!config.model) throw new Error('Agent model is not configured');
  const trace = [];
  const useAnthropicCache = ['claude', 'anthropic'].includes(String(config.backend || '').toLowerCase());
  const maxSteps = Math.min(20, Math.max(1, Number(budget.maxSteps) || 8));
  const resultBudget = createToolResultBudget({ ...budget, maxSteps });
  const compiledTools = compileTools(tools, onEvent, trace, resultBudget, useAnthropicCache);
  const orderedTools = Object.keys(compiledTools).sort();
  const startedAt = performance.now();
  const agent = new ToolLoopAgent({
    id: definition.id || 'naruto-agent',
    model: createModel(config),
    instructions: useAnthropicCache
      ? {
          role: 'system',
          content: String(definition.instructions || definition.systemPrompt || ''),
          providerOptions: {
            anthropic: { cacheControl: { type: 'ephemeral' } }
          }
        }
      : String(definition.instructions || definition.systemPrompt || ''),
    allowSystemInMessages: true,
    tools: compiledTools,
    toolOrder: orderedTools,
    stopWhen: stepCountIs(maxSteps),
    temperature: Number.isFinite(budget.temperature) ? budget.temperature : 0.5,
    ...(!useAnthropicCache ? {
      topP: Number.isFinite(budget.topP) ? budget.topP : 0.9
    } : {})
  });
  safeEvent(onEvent, { type: 'agent-start', agent: definition.id || 'naruto-agent' });
  try {
    const callOptions = {
      messages,
      abortSignal: signal,
      onStepStart: event => safeEvent(onEvent, {
        type: 'step-start', step: event?.stepNumber ?? trace.length
      }),
      onStepEnd: event => safeEvent(onEvent, {
        type: 'step-end',
        finishReason: event?.finishReason || null,
        toolCallCount: event?.toolCalls?.length || 0
      })
    };
    let text = '';
    let finishReason = null;
    let usage = null;
    let stepList = [];

    // Persisted API configs always normalize this flag. Bare SDK callers keep
    // the legacy generate() path unless streaming was explicitly enabled.
    if (config.disableStreaming !== false) {
      const result = await agent.generate(callOptions);
      text = result.text || '';
      finishReason = result.finishReason || null;
      usage = result.totalUsage || result.usage || null;
      stepList = Array.isArray(result.steps) ? result.steps : [];
    } else {
      const result = await agent.stream(callOptions);
      for await (const delta of result.textStream) {
        const chunk = String(delta || '');
        if (!chunk) continue;
        text += chunk;
        safeEvent(onEvent, { type: 'text-delta', delta: chunk });
      }
      const resolved = await Promise.all([
        result.text,
        result.finishReason,
        result.totalUsage || result.usage,
        result.steps
      ]);
      // Do not overwrite the accumulated stream text. Some SDK results only
      // expose the final step's text, which would truncate the full reply.
      if (!text) text = resolved[0] || '';
      finishReason = resolved[1] || null;
      usage = resolved[2] || null;
      stepList = Array.isArray(resolved[3]) ? resolved[3] : [];
    }
    const finalEvent = {
      type: 'agent-end', agent: definition.id || 'naruto-agent', success: true,
      durationMs: Math.round(performance.now() - startedAt)
    };
    trace.push(finalEvent);
    safeEvent(onEvent, finalEvent);
    const reasoning = stepList
      .map(step => (step && step.reasoningText ? String(step.reasoningText) : ''))
      .filter(Boolean)
      .join('\n');
    return {
      text,
      finishReason,
      usage,
      steps: stepList.length,
      reasoning,
      trace
    };
  } catch (error) {
    const finalEvent = {
      type: 'agent-end', agent: definition.id || 'naruto-agent', success: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: String(error?.message || error)
    };
    trace.push(finalEvent);
    safeEvent(onEvent, finalEvent);
    error.agentTrace = trace;
    throw error;
  }
}
