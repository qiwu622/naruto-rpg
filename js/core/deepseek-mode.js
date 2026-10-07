// Shared by browser, Android and the bundled native-tool Agent transport.
// Symbols stay in memory only: no provider-specific annotations enter saves or wire JSON.
const TURN_CONTEXT = Symbol.for('naruto.ai.turn-context');

export const DEEPSEEK_MODEL = 'deepseek-flash';
export const DEEPSEEK_URL = 'https://api.deepseek.com/v1';

export function isDeepSeekMode(config = {}) {
  return config.adaptationMode === 'deepseek'
    && !['claude', 'anthropic', 'tavern'].includes(config.backend);
}

export function markTurnContext(message) {
  return { ...message, [TURN_CONTEXT]: true };
}

// Only project-owned factual context is moved. Imported presets, depth entries,
// history, tool pairs and assistant prefills keep their relative order.
export function prepareDeepSeekMessages(messages = []) {
  const context = [];
  const rest = [];
  for (const message of messages) {
    if (message?.[TURN_CONTEXT] && message.role === 'system') context.push(message.content);
    else rest.push(message);
  }
  if (!context.length) return rest;
  let index = rest.findLastIndex(message => message?.role === 'user');
  if (index < 0) index = rest.at(-1)?.role === 'assistant' ? rest.length - 1 : rest.length;
  rest.splice(index, 0, { role: 'user', content: context.join('\n\n') });
  return rest;
}

export function applyDeepSeekRequest(body, config = {}) {
  if (!isDeepSeekMode(config)) return body;
  const effort = ['low', 'high', 'max'].includes(config.deepseekThinking)
    ? config.deepseekThinking : 'disabled';
  const result = { ...body, thinking: { type: effort === 'disabled' ? 'disabled' : 'enabled' } };
  delete result.reasoning_effort;
  if (effort !== 'disabled') {
    result.reasoning_effort = effort;
    delete result.temperature;
    delete result.frequency_penalty;
    delete result.presence_penalty;
    result.top_p = Math.min(1, Math.max(0.95, Number(result.top_p) || 0.95));
  } else {
    // DeepSeek fixes top_p at 1 in non-thinking mode.
    delete result.top_p;
  }
  if (result.stream) result.stream_options = { ...result.stream_options, include_usage: true };
  // Do not inject cache_control / cache keys: DeepSeek caches matching prefixes automatically.
  return result;
}

// Auxiliary/Agent model overrides must not inherit DeepSeek wire options when
// they intentionally select a different provider/model (e.g. a cheap GPT critic).
export function inheritAPIAdaptation(main = {}, resolved = {}) {
  if (resolved.adaptationMode !== main.adaptationMode || !isDeepSeekMode(main)) return resolved;
  const sameConnection = resolved.apiUrl === main.apiUrl && resolved.backend === main.backend;
  const sameModel = resolved.model === main.model;
  if (sameConnection && (sameModel || /deepseek/i.test(String(resolved.model)))) return resolved;
  return { ...resolved, adaptationMode: 'standard' };
}

const count = value => value !== null && value !== undefined && Number.isFinite(Number(value))
  && Number(value) >= 0 ? Number(value) : null;

// Missing cache metrics mean unknown, not a 0% hit or a cache write.
export function readTokenUsage(usage = {}) {
  const sdk = usage.inputTokenDetails || {};
  const hit = count(usage.prompt_cache_hit_tokens) ?? count(usage.prompt_tokens_details?.cached_tokens)
    ?? count(usage.cache_read_input_tokens) ?? count(sdk.cacheReadTokens);
  const written = count(usage.cache_creation_input_tokens) ?? count(sdk.cacheWriteTokens);
  const reportedInput = count(usage.prompt_tokens) ?? count(usage.inputTokens);
  const uncachedInput = count(usage.input_tokens); // Anthropic excludes cache reads/writes.
  const input = reportedInput ?? (uncachedInput === null ? null : uncachedInput + (hit || 0) + (written || 0));
  const miss = count(usage.prompt_cache_miss_tokens) ?? count(usage.cache_miss_input_tokens)
    ?? (input !== null && hit !== null ? Math.max(0, input - hit) : null);
  return {
    input: input ?? (hit !== null && miss !== null ? hit + miss : null),
    output: count(usage.completion_tokens) ?? count(usage.outputTokens) ?? count(usage.output_tokens),
    reasoning: count(usage.completion_tokens_details?.reasoning_tokens) ?? count(usage.outputTokenDetails?.reasoningTokens),
    hit, miss,
    cacheKnown: hit !== null && miss !== null
  };
}

export function deepSeekSdkUsage(usage) {
  const value = readTokenUsage(usage || {});
  return {
    inputTokens: { total: value.input ?? undefined, noCache: value.miss ?? undefined,
      cacheRead: value.hit ?? undefined, cacheWrite: undefined },
    outputTokens: { total: value.output ?? undefined,
      text: value.output === null || value.reasoning === null ? undefined : Math.max(0, value.output - value.reasoning),
      reasoning: value.reasoning ?? undefined },
    raw: usage ?? undefined
  };
}

export function formatTokenUsage(usage = {}) {
  const value = readTokenUsage(usage);
  const parts = [];
  if (value.input !== null) parts.push(`输入 ${value.input} tokens`);
  if (value.output !== null) parts.push(`输出 ${value.output} tokens`);
  if (value.reasoning !== null) parts.push(`其中思考 ${value.reasoning} tokens`);
  if (value.cacheKnown) {
    const total = value.hit + value.miss;
    parts.push(`缓存命中 ${value.hit} / 未命中 ${value.miss}（${total ? Math.round(value.hit / total * 100) : 0}%）`);
  } else parts.push('服务未返回缓存命中量');
  return parts.join(' · ');
}
