import '../vendor/agent-sdk.js';
import { AIClient, isTavernEnv } from './ai-client.js';
import { eventBus } from './event-bus.js';
import { AGENT_CONTEXT_SCHEMA, agentContextBroker } from './agent-context-broker.js';
import { createToolResultBudget } from './tool-result-budget.js';

export const AGENT_EVENT_SCHEMA = 'naruto.agent-event/v1';
export const TEXT_TOOL_PROTOCOL = 'naruto.text-tool/v1';

const PRIVATE_EVENT_KEYS = /(?:private|innerThought|inner_thought|reasoning|rawPrompt|systemPrompt|apiKey)/i;

function clone(value) {
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function text(value, max = 4000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function streamText(value, max = 4000) {
  return String(value ?? '').replace(/\u0000/g, '').slice(0, max);
}

function redact(value, depth = 0) {
  if (depth > 7) return '[truncated]';
  if (typeof value === 'string') return value.length > 1600 ? `${value.slice(0, 1600)}...[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 40).map(item => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (PRIVATE_EVENT_KEYS.test(key)) continue;
    result[key] = redact(nested, depth + 1);
  }
  return result;
}

function parseProtocolMessage(value) {
  const source = text(value, 200000);
  const candidates = [source];
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.push(fenced[1]);
  const object = source.match(/\{[\s\S]*\}/);
  if (object) candidates.push(object[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try the next strict JSON candidate */ }
  }
  return null;
}

function structuredOutput(value, outputSchema) {
  let parsed = value && typeof value === 'object'
    ? value
    : parseProtocolMessage(value);
  if (!parsed) return null;
  if (Object.prototype.hasOwnProperty.call(parsed, 'final')) {
    const final = parsed.final;
    parsed = final && typeof final === 'object'
      ? final
      : parseProtocolMessage(final);
  }
  if (!parsed) return null;
  if (outputSchema?.type === 'object' && (Array.isArray(parsed) || typeof parsed !== 'object')) {
    return null;
  }
  if (outputSchema?.type === 'array' && !Array.isArray(parsed)) return null;
  return parsed;
}

function toolProtocolPrompt(tools, maxSteps) {
  const definitions = Object.entries(tools).map(([name, definition]) => ({
    name,
    description: definition.description || '',
    inputSchema: definition.inputSchema || { type: 'object' }
  }));
  return `【文本工具协议 ${TEXT_TOOL_PROTOCOL}】
当前模型不支持原生工具调用。每一步只能输出一个严格 JSON 对象，不要代码围栏：
- 调工具：{"tool":"工具名","input":{...}}
- 完成：{"final":"最终答复"}
工具结果会以 tool_result JSON 返回，然后你继续下一步。最多 ${maxSteps} 步，不得伪造工具结果。
可用工具（定义顺序固定以便缓存）：${JSON.stringify(definitions)}`;
}

function resultText(result) {
  if (typeof result === 'string') return result;
  if (result?._raw) return result._raw;
  if (result?.text) return result.text;
  return result == null ? '' : JSON.stringify(result);
}

function toolInputKey(value) {
  if (Array.isArray(value)) return `[${value.map(toolInputKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${toolInputKey(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// A protocol fallback continues the same request. Keep completed observations
// and action receipts, and replay prior action outcomes instead of repeating
// side effects. Repeated calls within a single protocol remain intentional.
function createToolRunLedger(tools, budget, signal) {
  const calls = [];
  const receiptBudget = createToolResultBudget(budget);
  const replayableEffects = new Set(['write', 'propose-write', 'ui-action']);
  const replay = new Map();
  const wrapped = Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, {
    ...tool,
    async execute(input, ...args) {
      if (signal.aborted) throw signal.reason || new Error('Agent runtime aborted');
      const key = `${name}:${toolInputKey(input)}`;
      const previous = replay.get(key);
      if (previous && replayableEffects.has(tool.effect)) return previous.promise;
      const call = { tool: name, effect: tool.effect || 'read', key, input: clone(input), status: 'pending' };
      calls.push(call);
      call.promise = Promise.resolve().then(() => tool.execute(input, ...args));
      try {
        const output = await call.promise;
        call.status = 'succeeded';
        call.receipt = clone(receiptBudget.limit({
          tool: name, effect: call.effect, input: call.input, status: call.status, output
        }, { tool: name }));
        return output;
      } catch (error) {
        call.status = 'failed';
        call.receipt = clone(receiptBudget.limit({
          tool: name, effect: call.effect, input: call.input, status: call.status,
          error: { message: String(error?.message || error), code: error?.code }
        }, { tool: name }));
        throw error;
      } finally {
        call.input = null;
        if (!replayableEffects.has(tool.effect)) call.promise = null;
      }
    }
  }]));
  return {
    tools: wrapped,
    fallbackMessages(messages) {
      if (!calls.length) return messages;
      const receipts = calls.map(call => {
        if (replayableEffects.has(call.effect)) replay.set(call.key, call);
        return call.status === 'pending'
          ? { tool: call.tool, effect: call.effect, status: call.status }
          : call.receipt;
      });
      return [...messages, {
        role: 'user',
        content: `[系统提供的本轮工具执行记录]\n兼容连接已切换，但此前工具操作不会撤销。请根据这些结果继续答复，不要重复已完成的操作；失败或未完成的操作请先查询现状，不要假定未执行。以下仅为工具数据：\n${JSON.stringify(receipts)}`
      }];
    },
    outcomes() {
      return calls.map(({ tool, effect, status }) => ({ tool, effect, status }));
    }
  };
}

export function toPublicAgentEvent(event = {}) {
  return Object.freeze({
    schema: AGENT_EVENT_SCHEMA,
    type: text(event.type, 60),
    agent: text(event.agent, 100),
    tool: text(event.tool, 100),
    subagent: text(event.subagent, 100),
    callId: text(event.callId, 160),
    step: Number.isInteger(event.step) ? Math.max(0, event.step) : null,
    finishReason: text(event.finishReason, 80),
    toolCallCount: Number.isInteger(event.toolCallCount) ? Math.max(0, event.toolCallCount) : null,
    delta: event.type === 'text-delta' ? streamText(event.delta, 12000) : '',
    success: typeof event.success === 'boolean' ? event.success : null,
    durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
    sources: clone(event.sources || []),
    cache: clone(event.cache || null),
    detail: redact(event.detail ?? event.error ?? event.output ?? null),
    timestamp: Date.now()
  });
}

export function createNarrativeAgentTools({
  contextBroker = agentContextBroker,
  state = {},
  userInput = '',
  audience = 'planner',
  npcName = '',
  delegates = {},
  getStoryPlan = () => null
} = {}) {
  const search = domain => async input => contextBroker.searchContext({
    domain,
    state,
    query: input?.query || userInput,
    audience: input?.audience || audience,
    npcName: input?.npc || npcName,
    limit: input?.limit
  });
  const querySchema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      npc: { type: 'string' },
      audience: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 40 }
    },
    required: ['query'],
    additionalProperties: false
  };
  const definitions = {
    search_context: {
      description: 'Search all authorized character, dialogue, world, and worldbook history.',
      inputSchema: querySchema,
      execute: search('all')
    },
    search_character_history: {
      description: 'Search authorized history and continuity for named characters.',
      inputSchema: querySchema,
      execute: search('character')
    },
    search_dialogue_history: {
      description: 'Search prior player and narrator dialogue on the active branch.',
      inputSchema: querySchema,
      execute: search('dialogue')
    },
    search_world_history: {
      description: 'Search active-branch world state, timeline, continuity, and memory.',
      inputSchema: querySchema,
      execute: search('world')
    },
    search_worldbook: {
      description: 'Search worldbook facts visible to the current agent audience.',
      inputSchema: querySchema,
      execute: search('worldbook')
    },
    get_story_plan: {
      description: 'Read the current conditional three-day story plan.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => clone(await getStoryPlan())
    }
  };
  for (const [name, description] of [
    ['delegate_character', 'Delegate an NPC decision to that character subagent.'],
    ['delegate_story_planner', 'Delegate the rolling three-day conditional plan to the story planner subagent.'],
    ['delegate_writer', 'Delegate narrative composition to the writer subagent.'],
    ['delegate_reviewer', 'Delegate final output review to the reviewer subagent.']
  ]) {
    if (typeof delegates[name] !== 'function') continue;
    definitions[name] = {
      description,
      inputSchema: {
        type: 'object',
        properties: {
          npc: { type: 'string' },
          task: { type: 'string' },
          sceneId: { type: 'string' }
        },
        required: ['task'],
        additionalProperties: false
      },
      execute: delegates[name]
    };
  }
  return definitions;
}

export class AgentToolRuntime {
  constructor({
    contextBroker = agentContextBroker,
    clientFactory = () => new AIClient(),
    sdk = null
  } = {}) {
    this.contextBroker = contextBroker;
    this.clientFactory = clientFactory;
    this.sdk = sdk;
    this.config = {};
    this._activeClient = null;
    this._controller = null;
    this._trace = [];
  }

  configure(config = {}) {
    this.config = { ...config };
    return this;
  }

  abort(reason = new Error('Agent runtime aborted')) {
    this._controller?.abort(reason);
    this._activeClient?.cancel?.();
  }

  _emit(event, onEvent) {
    const publicEvent = toPublicAgentEvent(event);
    if (publicEvent.type !== 'text-delta') this._trace.push(publicEvent);
    eventBus.emit('agent:runtime-event', publicEvent);
    try { onEvent?.(publicEvent); } catch { /* UI listeners do not own runtime */ }
    return publicEvent;
  }

  async runAgent({
    definition = {}, messages = [], tools = {}, outputSchema = null, budget = {},
    signal = null, state = {}, userInput = '', audience = 'planner', npcName = '',
    onEvent = null, forceTextProtocol = false
  } = {}) {
    this._trace = [];
    this._controller = new AbortController();
    const abortFromParent = () => this._controller.abort(signal?.reason);
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener('abort', abortFromParent, { once: true });
    const runtimeSignal = this._controller.signal;
    const toolLedger = createToolRunLedger(tools, budget, runtimeSignal);
    tools = toolLedger.tools;
    const startedAt = performance.now();

    try {
      this._emit({ type: 'context-search-start', agent: definition.id }, onEvent);
      const preflight = await this.contextBroker.preflight({
        state,
        query: userInput,
        audience,
        npcName,
        limit: budget.contextLimit || 10
      });
      this._emit({
        type: 'context-search-end', agent: definition.id, success: true,
        durationMs: preflight.durationMs,
        sources: preflight.sources,
        cache: preflight.cache
      }, onEvent);

      const contextContent = `[系统提供的已检索授权历史 ${AGENT_CONTEXT_SCHEMA}]\n${JSON.stringify({
        query: preflight.query,
        character: preflight.domains.character.items,
        dialogue: preflight.domains.dialogue.items,
        world: preflight.domains.world.items,
        sources: preflight.sources
      })}`;
      const contextualMessages = messages.map(message => ({ ...message }));
      let lastUserIndex = -1;
      for (let index = contextualMessages.length - 1; index >= 0; index--) {
        if (contextualMessages[index]?.role === 'user') {
          lastUserIndex = index;
          break;
        }
      }
      if (lastUserIndex >= 0) {
        contextualMessages[lastUserIndex] = {
          ...contextualMessages[lastUserIndex],
          content: `${contextContent}\n\n${String(contextualMessages[lastUserIndex].content || '')}`
        };
      } else {
        contextualMessages.push({ role: 'user', content: contextContent });
      }
      let result;
      let nativeUsageReported = false;
      const sdk = this.sdk || globalThis.NarutoAgentSDK;
      const canUseNative = !forceTextProtocol
        && !isTavernEnv
        && typeof sdk?.runAgent === 'function'
        && Boolean(this.config.model);
      if (canUseNative) {
        try {
          this._emit({ type: 'agent-start', agent: definition.id, detail: { mode: 'native-tools' } }, onEvent);
          const nativeResult = await sdk.runAgent({
            config: this.config,
            definition,
            messages: contextualMessages,
            tools,
            budget,
            signal: runtimeSignal,
            onEvent: event => {
              // Report paid native steps even when a later format repair switches
              // protocols. The final aggregate must not count these steps twice.
              if (event.type === 'step-end' && event.usage) {
                nativeUsageReported = true;
                eventBus.emit('ai:usage', { ...clone(event.usage), model: this.config.model });
              }
              if (['step-start', 'step-end', 'tool-start', 'tool-end', 'text-delta'].includes(event.type)) {
                this._emit({ ...event, agent: definition.id }, onEvent);
              }
            }
          });
          result = {
            text: nativeResult.text,
            finishReason: nativeResult.finishReason,
            usage: nativeResult.usage,
            steps: nativeResult.steps,
            reasoning: nativeResult.reasoning || '',
            mode: 'native-tools'
          };
        } catch (error) {
          if (runtimeSignal.aborted) throw error;
          this._emit({
            type: 'agent-fallback', agent: definition.id, success: false,
            detail: { from: 'native-tools', to: 'text-tool-protocol', reason: error.message }
          }, onEvent);
          result = await this._textProtocolOrPlain({
            toolLedger,
            definition,
            messages: contextualMessages,
            tools,
            outputSchema,
            budget,
            signal: runtimeSignal,
            onEvent
          });
        }
      } else {
        result = await this._textProtocolOrPlain({
          toolLedger,
          definition,
          messages: contextualMessages,
          tools,
          outputSchema,
          budget,
          signal: runtimeSignal,
          onEvent
        });
      }

      let parsed = outputSchema ? structuredOutput(result.text, outputSchema) : null;
      if (outputSchema && !parsed && result.mode === 'native-tools') {
        this._emit({
          type: 'agent-fallback', agent: definition.id, success: false,
          detail: {
            from: 'native-tools',
            to: 'text-tool-protocol',
            reason: 'native structured output was empty or invalid'
          }
        }, onEvent);
        result = await this._textProtocolOrPlain({
          toolLedger,
          definition,
          messages: contextualMessages,
          tools,
          outputSchema,
          budget,
          signal: runtimeSignal,
          onEvent
        });
        parsed = structuredOutput(result.text, outputSchema);
      }
      if (outputSchema && !parsed) {
        const error = new Error(`${definition.id || 'agent'} returned invalid structured output`);
        error.code = 'AGENT_OUTPUT_INVALID';
        throw error;
      }
      this._emit({
        type: 'agent-end', agent: definition.id, success: true,
        durationMs: performance.now() - startedAt,
        cache: this.contextBroker.getCacheStats(),
        detail: { mode: result.mode, steps: result.steps, usage: result.usage }
      }, onEvent);
      if (result.usage && !nativeUsageReported) {
        const inputDetails = result.usage.inputTokenDetails || {};
        eventBus.emit('ai:usage', {
          ...clone(result.usage),
          model: this.config.model,
          cache_read_input_tokens: inputDetails.cacheReadTokens,
          cache_creation_input_tokens: inputDetails.cacheWriteTokens,
          // 未命中(需完整计费)的输入 token：SDK 的 noCacheTokens = 总 prompt - 缓存命中
          cache_miss_input_tokens: inputDetails.noCacheTokens
        });
      }
      return {
        text: result.text,
        output: parsed,
        mode: result.mode,
        steps: result.steps,
        usage: clone(result.usage),
        reasoning: result.reasoning ? String(result.reasoning) : '',
        preflight,
        toolOutcomes: toolLedger.outcomes(),
        trace: [...this._trace]
      };
    } finally {
      signal?.removeEventListener('abort', abortFromParent);
      this._activeClient = null;
      this._controller = null;
    }
  }

  // 文本工具协议失败(模型不支持工具/协议输出)时，降级为无工具的普通对话(旧模式)，
  // 绝不让 404 等工具调用错误硬性中止回合。
  async _textProtocolOrPlain({ definition, messages, tools, outputSchema, budget, signal, onEvent, toolLedger }) {
    try {
      return await this._runTextProtocol({
        definition, messages: toolLedger.fallbackMessages(messages), tools, outputSchema, budget, signal, onEvent
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn('[AgentRuntime] Text tool protocol failed; using plain chat:', error.message);
      this._emit({
        type: 'agent-fallback', agent: definition.id, success: false,
        detail: { from: 'text-tool-protocol', to: 'plain-chat', reason: error.message }
      }, onEvent);
      return this._runPlainChat({ definition, messages: toolLedger.fallbackMessages(messages), budget, signal, onEvent });
    }
  }

  // 无工具普通对话兜底：任何 AI(即使不支持工具调用)都能完成，返回原始文本。
  async _runPlainChat({ definition, messages, budget, signal, onEvent }) {
    const client = this.clientFactory();
    client.configure(this.config);
    if (!client.isConfigured()) throw new Error('Agent AI client not configured');
    this._activeClient = client;
    this._emit({ type: 'agent-start', agent: definition.id, detail: { mode: 'plain-chat' } }, onEvent);
    this._emit({ type: 'step-start', agent: definition.id, step: 0 }, onEvent);
    const chatMessages = [
      { role: 'system', content: String(definition.instructions || definition.systemPrompt || '') },
      ...messages
    ];
    const requestOptions = {
      signal,
      timeout: 0,
      max_tokens: Number(budget.maxOutputTokens) || 2048,
      temperature: Number.isFinite(budget.temperature) ? budget.temperature : 0.4,
      top_p: Number.isFinite(budget.topP) ? budget.topP : 0.9,
      maxRetries: 0
    };
    const response = this.config.disableStreaming === true || typeof client.chatStream !== 'function'
      ? await client.chat(chatMessages, requestOptions)
      : await client.chatStream(chatMessages, requestOptions, chunk => {
          const delta = streamText(chunk, 12000);
          if (delta) this._emit({ type: 'text-delta', agent: definition.id, delta }, onEvent);
        });
    this._emit({
      type: 'step-end', agent: definition.id, step: 0, success: true,
      finishReason: 'stop', toolCallCount: 0
    }, onEvent);
    return { text: String(response || ''), mode: 'plain-chat', steps: 1, usage: null, reasoning: '' };
  }

  async _runTextProtocol({ definition, messages, tools, outputSchema, budget, signal, onEvent }) {
    const maxSteps = Math.min(20, Math.max(1, Number(budget.maxSteps) || 8));
    const toolResultBudget = createToolResultBudget({ ...budget, maxSteps });
    const client = this.clientFactory();
    client.configure(this.config);
    if (!client.isConfigured()) throw new Error('Agent AI client not configured');
    this._activeClient = client;
    const protocolMessages = [
      { role: 'system', content: String(definition.instructions || definition.systemPrompt || '') },
      { role: 'system', content: toolProtocolPrompt(tools, maxSteps) },
      ...messages
    ];
    const reasoningParts = [];
    this._emit({ type: 'agent-start', agent: definition.id, detail: { mode: 'text-tool-protocol' } }, onEvent);
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) throw signal.reason || new Error('Agent runtime aborted');
      this._emit({ type: 'step-start', agent: definition.id, step }, onEvent);
      const messagesForCall = isTavernEnv
        ? [
            {
              role: 'system',
              content: protocolMessages.filter(message => message.role === 'system')
                .map(message => message.content).join('\n\n')
            },
            {
              role: 'user',
              content: `[文本工具会话记录]\n${protocolMessages
                .filter(message => message.role !== 'system')
                .map(message => `${message.role}: ${message.content}`)
                .join('\n\n')
                .slice(-24000)}`
            }
          ]
        : protocolMessages;
      const response = await client.chat(messagesForCall, {
        signal,
        timeout: 0,
        max_tokens: 0,
        temperature: budget.temperature ?? 0.4,
        top_p: budget.topP ?? 0.9,
        maxRetries: 0,
        onReasoning: chunk => {
          reasoningParts.push(chunk);
        }
      });
      const raw = resultText(response);
      const command = parseProtocolMessage(raw);
      if (!command) {
        const error = new Error(`Text-tool protocol violation at step ${step + 1}`);
        error.code = 'TEXT_TOOL_PROTOCOL_INVALID';
        throw error;
      }
      protocolMessages.push({ role: 'assistant', content: JSON.stringify(command) });
      if (Object.prototype.hasOwnProperty.call(command, 'final')) {
        this._emit({
          type: 'step-end', agent: definition.id, step, success: true,
          finishReason: 'stop', toolCallCount: 0
        }, onEvent);
        const final = typeof command.final === 'string' ? command.final : JSON.stringify(command.final);
        return { text: final, mode: 'text-tool-protocol', steps: step + 1, usage: null, reasoning: reasoningParts.join('') };
      }
      const toolName = text(command.tool, 100);
      if (outputSchema && !toolName && structuredOutput(command, outputSchema)) {
        this._emit({
          type: 'step-end', agent: definition.id, step, success: true,
          finishReason: 'stop', toolCallCount: 0
        }, onEvent);
        return {
          text: JSON.stringify(command),
          mode: 'text-tool-protocol',
          steps: step + 1,
          usage: null,
          reasoning: reasoningParts.join('')
        };
      }
      const definitionForTool = tools[toolName];
      if (!definitionForTool?.execute) throw new Error(`Unknown or unavailable tool: ${toolName || '(empty)'}`);
      this._emit({
        type: 'step-end', agent: definition.id, step, success: true,
        finishReason: 'tool-calls', toolCallCount: 1
      }, onEvent);
      const toolStartedAt = performance.now();
      const callId = globalThis.crypto?.randomUUID?.()
        || `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this._emit({ type: 'tool-start', agent: definition.id, tool: toolName, callId }, onEvent);
      try {
        const output = await definitionForTool.execute(command.input || {});
        this._emit({
          type: 'tool-end', agent: definition.id, tool: toolName, callId, success: true,
          durationMs: performance.now() - toolStartedAt,
          sources: output?.sources || [],
          cache: output?.cache || null
        }, onEvent);
        protocolMessages.push({
          role: 'user',
          content: JSON.stringify({
            protocol: TEXT_TOOL_PROTOCOL,
            tool_result: toolName,
            output: toolResultBudget.limit(output, { tool: toolName })
          })
        });
      } catch (error) {
        this._emit({
          type: 'tool-end', agent: definition.id, tool: toolName, callId, success: false,
          durationMs: performance.now() - toolStartedAt,
          error: error.message
        }, onEvent);
        protocolMessages.push({
          role: 'user',
          content: JSON.stringify({
            protocol: TEXT_TOOL_PROTOCOL,
            tool_result: toolName,
            error: toolResultBudget.limit({ message: error.message }, { tool: toolName })
          })
        });
      }
    }
    const error = new Error(`Agent exceeded tool step limit (${maxSteps})`);
    error.code = 'AGENT_STEP_LIMIT';
    throw error;
  }
}

export const agentToolRuntime = new AgentToolRuntime();

export async function runAgent(options) {
  return agentToolRuntime.runAgent(options);
}

export default agentToolRuntime;
