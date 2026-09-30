import { eventBus } from './event-bus.js';
import { isNativeAndroidApp } from './runtime-platform.js';
import { fetchAI } from './native-ai-fetch.js';

export const isTavernEnv = typeof globalThis !== 'undefined' && typeof globalThis.generate === 'function';
// 浏览器版默认可使用同源代理；酒馆 iframe 没有本项目服务端，必须直连酒馆桥接 API。
const USE_PROXY = typeof location !== 'undefined' && !isTavernEnv && !isNativeAndroidApp();

export function normalizeOpenAIMessageOrder(messages = []) {
  const systemParts = [];
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'system') {
      turns.push(message);
      continue;
    }
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content ?? '');
    if (content) systemParts.push(content);
  }
  return systemParts.length
    ? [{ role: 'system', content: systemParts.join('\n\n') }, ...turns]
    : turns;
}

function withLocalProtocol(value) {
  const raw = String(value || '').trim();
  if (!raw || /^[a-z][a-z\d+.-]*:\/\//i.test(raw)) return raw;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[?::1\]?)(?::|\/|$)/i.test(raw)) {
    return `http://${raw}`;
  }
  return raw;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts.every(part => part === 0);
}

export function isLocalNetworkApiUrl(value) {
  let parsed;
  try { parsed = new URL(withLocalProtocol(value)); } catch { return false; }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
  if (hostname === 'host.docker.internal' || hostname === 'gateway.docker.internal') return true;
  if (hostname === '::1' || hostname.startsWith('fe80:') || /^f[cd][0-9a-f]:/.test(hostname)) return true;
  const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return isPrivateIpv4(mapped?.[1] || hostname);
}

export function normalizeApiBaseUrl(value, backend = 'openai') {
  const raw = withLocalProtocol(value);
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { return raw.replace(/\/+$/, ''); }

  parsed.search = '';
  parsed.hash = '';
  let pathname = parsed.pathname.replace(/\/+$/, '');
  const endpointSuffixes = backend === 'claude'
    ? ['/messages', '/models']
    : ['/chat/completions', '/models'];
  for (const suffix of endpointSuffixes) {
    if (pathname.toLowerCase().endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  if (backend !== 'claude' && isLocalNetworkApiUrl(parsed.href) && (!pathname || pathname === '/')) {
    pathname = '/v1';
  }
  parsed.pathname = pathname || '/';
  return parsed.toString().replace(/\/$/, '');
}

function wrapLocalNetworkError(targetUrl, error) {
  const parsed = new URL(withLocalProtocol(targetUrl));
  const wrapped = new Error(
    `无法连接本地模型服务 ${parsed.origin}。请确认服务和端口已启动，并允许当前网页跨域访问（CORS/OLLAMA_ORIGINS）；HTTPS 页面还需允许访问本地网络。`
  );
  wrapped.cause = error;
  return wrapped;
}

function createRequestAbortScope(parentSignal) {
  const controller = new AbortController();
  const abortFromParent = () => {
    if (controller.signal.aborted) return;
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  return {
    signal: controller.signal,
    dispose() {
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };
}

function resolveProxyPurpose(options = {}) {
  return options.timeout === 0 ? 'agent' : 'generic';
}

function applyOptionalMaxTokens(body, options = {}, fallback = 4096) {
  // Agent calls pass 0 so OpenAI-compatible providers apply their model limit.
  if (options.max_tokens !== 0) body.max_tokens = options.max_tokens ?? fallback;
  return body;
}

function resolveRequiredMaxTokens(options = {}, fallback = 4096) {
  const requested = Number(options.max_tokens);
  return Number.isFinite(requested) && requested > 0 ? requested : fallback;
}

function createCancelledError(reason) {
  const error = new Error(reason instanceof Error ? reason.message : 'AI request cancelled');
  error.name = 'AbortError';
  error.isCancelled = true;
  if (reason instanceof Error) error.cause = reason;
  return error;
}

function normalizeAbortError(error, signal) {
  const normalized = createCancelledError(signal?.reason || error);
  if (normalized !== error && error instanceof Error) normalized.cause = error;
  return normalized;
}

function waitWithAbort(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(createCancelledError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(createCancelledError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function extractSseData(frame) {
  const dataLines = [];
  for (let line of String(frame || '').split(/\r\n|\r|\n/)) {
    line = line.replace(/^\uFEFF/, '');
    if (line === 'data') {
      dataLines.push('');
      continue;
    }
    if (!line.startsWith('data:')) continue;
    let value = line.slice(5);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }
  return dataLines.length ? dataLines.join('\n') : null;
}

const STREAM_COMPLETE = Symbol('stream-complete');

/**
 * 增量读取一个可能是 SSE、也可能是普通 JSON 的响应体。
 * 返回原始文本用于非流式兼容回退，同时在完整 SSE 事件到达时立即回调。
 */
async function consumeStreamingBody(body, onData, signal) {
  const reader = body?.getReader?.();
  if (!reader) return { eventCount: 0, rawText: '' };
  if (signal?.aborted) throw createCancelledError(signal.reason);

  const decoder = new TextDecoder();
  let rawText = '';
  let eventCount = 0;
  let lineBuffer = '';
  let frameLines = [];
  let previousEndedWithCr = false;
  let cancelRequested = false;
  let streamComplete = false;

  const dispatchFrame = () => {
    const payload = extractSseData(frameLines.join('\n'));
    frameLines = [];
    if (payload === null) return;
    eventCount++;
    if (!payload.trim()) return;
    if (onData?.(payload) === STREAM_COMPLETE) streamComplete = true;
  };

  const finishLine = () => {
    if (lineBuffer) frameLines.push(lineBuffer);
    else dispatchFrame();
    lineBuffer = '';
  };

  // Parse line endings as a state machine so CRLF can never backtrack into CR + LF.
  // A trailing CR is processed immediately; a leading LF in the next network chunk is
  // then swallowed as the second half of that same line ending.
  const consumeText = (text, flush = false) => {
    let index = 0;
    if (previousEndedWithCr && text.length > 0) {
      if (text[0] === '\n') index = 1;
      previousEndedWithCr = false;
    }

    for (; index < text.length && !streamComplete; index++) {
      const character = text[index];
      if (character === '\r') {
        finishLine();
        if (text[index + 1] === '\n') index++;
        else if (index === text.length - 1) previousEndedWithCr = true;
      } else if (character === '\n') {
        finishLine();
      } else {
        lineBuffer += character;
      }
    }

    if (flush) {
      previousEndedWithCr = false;
      if (lineBuffer) {
        frameLines.push(lineBuffer);
        lineBuffer = '';
      }
      if (frameLines.length > 0) dispatchFrame();
    }
  };

  const cancelReader = reason => {
    if (cancelRequested || typeof reader.cancel !== 'function') return Promise.resolve();
    cancelRequested = true;
    try {
      return Promise.resolve(reader.cancel(reason)).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };
  const abortReader = () => { void cancelReader(signal?.reason); };
  signal?.addEventListener('abort', abortReader, { once: true });
  if (signal?.aborted) abortReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        rawText += tail;
        consumeText(tail, true);
        break;
      }
      const text = decoder.decode(value, { stream: true });
      rawText += text;
      consumeText(text, false);
      if (streamComplete) {
        await cancelReader('SSE stream completed');
        break;
      }
    }
    if (signal?.aborted) throw createCancelledError(signal.reason);
  } catch (error) {
    await cancelReader(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    reader.releaseLock?.();
  }

  return { eventCount, rawText };
}

function parseJsonResponse(rawText, label) {
  try {
    return JSON.parse(String(rawText || '').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label} 返回了无法解析的响应: ${error.message}`);
  }
}

function parseSseJsonPayload(payload, label) {
  try {
    return JSON.parse(payload);
  } catch (error) {
    const malformed = new Error(`${label} 返回了损坏的 SSE 事件: ${error.message}`);
    malformed.cause = error;
    throw malformed;
  }
}

function createStreamPayloadError(data, label) {
  const details = data?.error ?? (data?.type === 'error' ? data : null);
  if (!details) return null;

  const message = typeof details === 'string'
    ? details
    : (details.message || details.error?.message || data?.message || JSON.stringify(details));
  const error = new Error(`${label} 流错误: ${message}`);
  const status = Number(details?.status_code ?? details?.status ?? data?.status_code ?? data?.status);
  const kind = String(details?.code || details?.type || data?.code || '').toLowerCase();
  if (Number.isFinite(status)) error.statusCode = status;
  error.isRateLimited = status === 429 || /rate.?limit|quota/.test(kind);
  error.isAuthError = status === 401 || status === 403 || /auth|permission|invalid.?api.?key/.test(kind);
  error.isOverloaded = status >= 500 || /overload|server.?error/.test(kind);
  return error;
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => {
    if (typeof item === 'string') return item;
    if (item?.type === 'text' || item?.type === 'output_text') return item.text || item.content || '';
    return '';
  }).join('');
}

function visibleResponseText(data) {
  const choice = data?.choices?.[0];
  const responseOutput = Array.isArray(data?.output)
    ? data.output.flatMap(item => item?.content || []).filter(item => (
      item?.type === 'output_text' || item?.type === 'text'
    )).map(item => item.text || '').join('')
    : '';
  return contentText(choice?.delta?.content)
    || contentText(choice?.message?.content)
    || contentText(choice?.text)
    || contentText(data?.delta?.text)
    || (data?.type === 'response.output_text.delta' ? contentText(data.delta) : '')
    || contentText(data?.content)
    || responseOutput;
}

// 思维链/推理内容：DeepSeek 走 reasoning_content，Claude 走 thinking 块。
// 只在模型实际返回时输出，与正文分离，供 Agent 推演展示使用。
function visibleReasoningText(data) {
  const choice = data?.choices?.[0];
  if (choice?.delta && typeof choice.delta.reasoning_content === 'string' && choice.delta.reasoning_content) {
    return choice.delta.reasoning_content;
  }
  if (choice?.message && typeof choice.message.reasoning_content === 'string' && choice.message.reasoning_content) {
    return choice.message.reasoning_content;
  }
  if (data?.delta?.type === 'thinking_delta' && typeof data.delta.thinking === 'string' && data.delta.thinking) {
    return data.delta.thinking;
  }
  if (Array.isArray(data?.content)) {
    return data.content
      .filter(block => block?.type === 'thinking' && block.thinking)
      .map(block => block.thinking)
      .join('');
  }
  return '';
}

function emitReasoning(options, data) {
  if (typeof options?.onReasoning !== 'function') return;
  const reasoning = visibleReasoningText(data);
  if (reasoning) options.onReasoning(reasoning);
}

export class AIAdapter {
  _fetch(url, init) {
    if (init && init.headers) {
      const h = init.headers;
      const realUrl = h['x-target-url'];
      const localTarget = realUrl && isLocalNetworkApiUrl(realUrl);
      if (realUrl && (!USE_PROXY || localTarget)) {
        const nh = { 'Content-Type': 'application/json' };
        const accept = h.Accept || h.accept;
        if (accept) nh.Accept = accept;
        const keyHeader = h['x-api-key-header'] || 'Authorization';
        if (h['x-user-api-key']) {
          if (keyHeader.toLowerCase() === 'authorization') {
            nh['Authorization'] = 'Bearer ' + h['x-user-api-key'];
          } else {
            nh[keyHeader] = h['x-user-api-key'];
          }
        }
        for (const fwd of ['anthropic-version', 'anthropic-beta']) {
          if (h[fwd]) nh[fwd] = h[fwd];
        }
        const request = fetchAI(realUrl, { ...init, headers: nh });
        return localTarget ? request.catch(error => {
          if (error?.name === 'AbortError' || init.signal?.aborted) {
            throw normalizeAbortError(error, init.signal);
          }
          throw wrapLocalNetworkError(realUrl, error);
        }) : request;
      }
    }
    return fetch(url, init);
  }
  async chat(messages, options) { throw new Error('Not implemented'); }
  async chatDetailed(messages, options) {
    return { text: await this.chat(messages, options), finishReason: null, usage: null };
  }
  async chatStream(messages, options, onChunk) { throw new Error('Not implemented'); }
  getModelInfo() { return { name: 'unknown', contextWindow: 4096 }; }
  validateConfig(config) { return true; }
}

// ── 酒馆适配器：用 generateRaw 直调 API，完全绕过酒馆预设和世界书 ──
class TavernAdapter extends AIAdapter {
  constructor(config) {
    super();
    this.model = config.model || 'tavern-default';
    this.proxyPreset = config.proxyPreset || null;
  }

  getModelInfo() { return { name: this.model, contextWindow: 128000 }; }
  validateConfig() { return true; }

  _compilePrompt(messages = []) {
    const normalized = (Array.isArray(messages) ? messages : [])
      .filter(message => ['system', 'user', 'assistant'].includes(message?.role))
      .map(message => ({
        role: message.role,
        content: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? '')
      }))
      .filter(message => message.content.length > 0);
    const lastUserIndex = normalized.map(message => message.role).lastIndexOf('user');
    const simpleUserRequest = lastUserIndex === normalized.length - 1
      && normalized.every((message, index) => index === lastUserIndex || message.role === 'system');

    if (simpleUserRequest) {
      return {
        userInput: normalized[lastUserIndex]?.content || '',
        orderedPrompts: [
          {
            role: 'system',
            content: normalized
              .filter(message => message.role === 'system')
              .map(message => message.content)
              .join('\n\n')
          },
          'world_info_before'
        ]
      };
    }

    // generateRaw accepts custom role objects in ordered_prompts. Supplying the
    // whole transcript is the only way to retain imported preset depth/bottom
    // prompts and a final assistant continuation. user_input stays empty so the
    // bridge does not append a second user turn after that assistant prefill.
    return {
      userInput: '',
      orderedPrompts: normalized
    };
  }

  _buildOptions(messages, stream, options = {}) {
    const prompt = this._compilePrompt(messages);
    const opts = {
      user_input: prompt.userInput,
      should_stream: stream,
      ordered_prompts: prompt.orderedPrompts,
    };
    if (Number.isFinite(options.max_tokens) && options.max_tokens > 0) {
      opts.max_tokens = options.max_tokens;
    }
    if (this.proxyPreset) {
      opts.custom_api = { proxy_preset: this.proxyPreset, model: this.model };
    } else if (this.model && this.model !== 'tavern-default') {
      opts.custom_api = { model: this.model };
    }
    return opts;
  }

  async chat(messages, options = {}) {
    const opts = this._buildOptions(messages, false, options);
    const generationId = globalThis.crypto?.randomUUID?.()
      || `naruto-request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    opts.generation_id = generationId;
    let rejectOnAbort;
    const aborted = new Promise((_, reject) => { rejectOnAbort = reject; });
    const abortGeneration = () => {
      try {
        const result = globalThis.stopGenerationById?.(generationId);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* best-effort stop for older Tavern bridges */ }
      rejectOnAbort(createCancelledError(options.signal?.reason));
    };
    try {
      if (options.signal?.aborted) abortGeneration();
      else options.signal?.addEventListener('abort', abortGeneration, { once: true });
      const result = await Promise.race([Promise.resolve(globalThis.generateRaw(opts)), aborted]);
      return typeof result === 'string' ? result : (result?.content || result?.text || JSON.stringify(result));
    } catch (e) {
      if (options.signal?.aborted || e?.isCancelled) throw createCancelledError(options.signal?.reason || e);
      throw new Error(`酒馆生成失败: ${e.message}`);
    } finally {
      options.signal?.removeEventListener('abort', abortGeneration);
    }
  }

  async chatStream(messages, options = {}, onChunk) {
    const abortScope = createRequestAbortScope(options.signal);
    const generationId = globalThis.crypto?.randomUUID?.()
      || `naruto-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const EV = globalThis.iframe_events?.STREAM_TOKEN_RECEIVED_INCREMENTALLY
      ?? 'js_stream_token_received_incrementally';
    let fullContent = '';
    const h = (chunk, id) => {
      if (abortScope.signal.aborted || id !== generationId || !chunk) return;
      fullContent += chunk;
      onChunk?.(chunk);
    };
    const eo = globalThis.eventOn;
    const removeListener = globalThis.eventRemoveListener;
    const opts = this._buildOptions(messages, true, options);
    opts.generation_id = generationId;
    let unsubscribe = null;
    let rejectOnAbort;
    let abortHandled = false;
    const aborted = new Promise((_, reject) => { rejectOnAbort = reject; });
    const stopGeneration = () => {
      try {
        const result = globalThis.stopGenerationById?.(generationId);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* best-effort stop for older Tavern bridges */ }
    };
    const abortGeneration = () => {
      if (abortHandled) return;
      abortHandled = true;
      stopGeneration();
      const error = createCancelledError(abortScope.signal.reason);
      error.partialResponse = fullContent || null;
      rejectOnAbort(error);
    };

    try {
      if (abortScope.signal.aborted) throw createCancelledError(abortScope.signal.reason);
      if (typeof eo === 'function') {
        const disposer = eo(EV, h);
        if (typeof disposer === 'function') unsubscribe = disposer;
        else if (typeof removeListener === 'function') unsubscribe = () => removeListener(EV, h);
      }
      abortScope.signal.addEventListener('abort', abortGeneration, { once: true });
      const generation = Promise.resolve(globalThis.generateRaw(opts));
      if (abortScope.signal.aborted) abortGeneration();
      const result = await Promise.race([generation, aborted]);
      if (abortScope.signal.aborted) throw createCancelledError(abortScope.signal.reason);
      const resolvedContent = typeof result === 'string'
        ? result
        : (result?.content || result?.text || (result == null ? '' : JSON.stringify(result)));
      return resolvedContent || fullContent;
    } catch (e) {
      if (abortScope.signal.aborted) {
        const cancelled = createCancelledError(abortScope.signal.reason || e);
        cancelled.partialResponse = fullContent || null;
        throw cancelled;
      }
      const wrapped = new Error(`酒馆流式生成失败: ${e.message}`);
      wrapped.cause = e;
      if (fullContent) wrapped.partialResponse = fullContent;
      throw wrapped;
    } finally {
      abortScope.signal.removeEventListener('abort', abortGeneration);
      try { unsubscribe?.(); } catch { /* cleanup is best-effort across Tavern versions */ }
      abortScope.dispose();
    }
  }
}

class OpenAICompatibleAdapter extends AIAdapter {
  constructor(config) {
    super();
    this.apiKey = config.apiKey || '';
    this.apiUrl = normalizeApiBaseUrl(config.apiUrl || 'https://api.openai.com/v1', config.backend || 'openai');
    this.model = config.model || 'gpt-4o';
  }

  getModelInfo() {
    return { name: this.model, contextWindow: 128000 };
  }

  async chat(messages, options = {}) {
    return (await this.chatDetailed(messages, options)).text;
  }

  async chatDetailed(messages, options = {}) {
    const abortScope = createRequestAbortScope(options.signal);
    try {
      const response = await this._fetch(`/api/ai-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-target-url': `${this.apiUrl}/chat/completions`,
          'x-user-api-key': this.apiKey,
          'x-api-key-header': 'Authorization',
          'x-proxy-purpose': resolveProxyPurpose(options)
        },
        body: JSON.stringify(applyOptionalMaxTokens({
          model: this.model,
          messages: normalizeOpenAIMessageOrder(messages),
          temperature: options.temperature ?? 0.9,
          top_p: options.top_p ?? 0.9,
          frequency_penalty: options.frequency_penalty ?? 0.2,
          stream: false
        }, options)),
        signal: abortScope.signal
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`API Error ${response.status}: ${err}`);
      }
      const data = await response.json();
      emitReasoning(options, data);
      return {
        text: data.choices?.[0]?.message?.content || '',
        finishReason: data.choices?.[0]?.finish_reason ?? null,
        usage: data.usage ?? null
      };
    } catch (error) {
      if (error.name === 'AbortError' || abortScope.signal.aborted) {
        throw normalizeAbortError(error, abortScope.signal);
      }
      throw error;
    } finally {
      abortScope.dispose();
    }
  }

  async chatStream(messages, options = {}, onChunk) {
    let lastError = null;
    const maxRetries = options.maxRetries ?? 2;
    const retryDelay = options.retryDelay ?? 800;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await waitWithAbort(retryDelay * Math.pow(2, attempt - 1), options.signal);
        eventBus.emit('pipeline:retrying', { attempt, maxRetries });
      }
      try {
        const abortScope = createRequestAbortScope(options.signal);

        let fullContent = '';
        try {
          const response = await this._fetch(`/api/ai-proxy`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'x-target-url': `${this.apiUrl}/chat/completions`,
              'x-user-api-key': this.apiKey,
              'x-api-key-header': 'Authorization',
              'x-proxy-purpose': resolveProxyPurpose(options)
            },
            body: JSON.stringify(applyOptionalMaxTokens({
              model: this.model,
              messages: normalizeOpenAIMessageOrder(messages),
              temperature: options.temperature ?? 0.9,
              top_p: options.top_p ?? 0.9,
              frequency_penalty: options.frequency_penalty ?? 0.2,
              stream: true,
              stream_options: { include_usage: true }
            }, options)),
            signal: abortScope.signal
          });

          if (!response.ok) {
            const err = await response.text();
            const statusErr = new Error(`API ${response.status}: ${err.slice(0, 200)}`);
            statusErr.statusCode = response.status;
            statusErr.isRateLimited = response.status === 429;
            statusErr.isAuthError = response.status === 401 || response.status === 403;
            statusErr.isOverloaded = response.status >= 500;
            throw statusErr;
          }

          if (!response.body) {
            if (options.strictSingleRequest) {
              throw new Error('当前为严格单调用模式，但服务未返回可读取的流；本回合不会自动改用第二次非流式请求，请手动重试或关闭流式输出');
            }
            fullContent = await this.chat(messages, { ...options, signal: abortScope.signal });
            return fullContent;
          }

          let lastUsage = null;
          const { eventCount, rawText } = await consumeStreamingBody(response.body, payload => {
            if (payload.trim() === '[DONE]') return STREAM_COMPLETE;
            const data = parseSseJsonPayload(payload, 'AI');
            const streamError = createStreamPayloadError(data, 'AI');
            if (streamError) {
              streamError.partialResponse = fullContent || null;
              throw streamError;
            }
            if (data.usage && data.usage.total_tokens) lastUsage = data.usage;
            emitReasoning(options, data);
            const content = data.choices?.[0]?.delta?.content || '';
            if (content) { fullContent += content; onChunk?.(content); }
          }, abortScope.signal);
          if (lastUsage) eventBus.emit('ai:usage', lastUsage);
          if (eventCount > 0) {
            if (fullContent) return fullContent;
            throw new Error('AI 流已结束，但没有返回有效正文');
          }

          const data = parseJsonResponse(rawText, 'AI');
          if (data.error) throw createStreamPayloadError(data, 'AI');
          emitReasoning(options, data);
          const content = data.choices?.[0]?.message?.content || '';
          if (content) {
            onChunk?.(content);
            return content;
          }
          throw new Error(`AI 未返回有效回复: ${JSON.stringify(data)}`);
        } catch (fetchError) {
          let failure = fetchError;
          const partial = failure.partialResponse || fullContent || null;
          if (failure.name === 'AbortError' || abortScope.signal.aborted) {
            failure = normalizeAbortError(failure, abortScope.signal);
          }
          if (partial) failure.partialResponse = partial;
          if (failure.isCancelled) {
            lastError = failure;
            throw failure;
          }
          // 流式回调只能追加，已经向 UI 发出内容后透明重试会造成重复或分叉正文。
          if (partial) {
            lastError = failure;
            throw failure;
          }
          if (failure.statusCode === 429 && attempt < maxRetries) {
            await waitWithAbort((retryDelay * 3) * Math.pow(2, attempt), options.signal);
          }
          lastError = failure;
          if (failure.isAuthError || failure.isCancelled || attempt >= maxRetries) throw lastError;
        } finally {
          abortScope.dispose();
        }
      } catch (outerError) {
        lastError = outerError;
        if (outerError.isAuthError || outerError.isCancelled || outerError.partialResponse) throw outerError;
        if (attempt >= maxRetries) throw outerError;
      }
    }
    throw lastError || new Error('AI 生成失败');
  }

  validateConfig(config) {
    return !!(config.apiUrl && config.model);
  }

  static async listModels(config) {
    const apiUrl = normalizeApiBaseUrl(config.apiUrl || 'https://api.openai.com/v1', config.backend || 'openai');
    const response = await new AIAdapter()._fetch(`/api/ai-proxy`, {
      method: 'GET',
      headers: {
        'x-target-url': `${apiUrl}/models`,
        'x-user-api-key': config.apiKey || '',
        'x-api-key-header': 'Authorization'
      }
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`模型列表读取失败 ${response.status}: ${err}`);
    }
    const data = await response.json();
    let models = [];
    if (data && Array.isArray(data.data)) models = data.data;
    else if (data && Array.isArray(data.models)) models = data.models;
    else if (Array.isArray(data)) models = data;
    
    return models
      .map(item => typeof item === 'string' ? item : item?.id || item?.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }
}

class ClaudeAdapter extends AIAdapter {
  constructor(config) {
    super();
    this.apiKey = config.apiKey || '';
    this.apiUrl = normalizeApiBaseUrl(config.apiUrl || 'https://api.anthropic.com/v1', 'claude');
    this.model = config.model || 'claude-sonnet-4-20250514';
  }

  getModelInfo() {
    return { name: this.model, contextWindow: 200000 };
  }

  _convertMessages(messages) {
    const systemMessages = [];
    const chatMessages = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      } else {
        chatMessages.push(msg);
      }
    }

    const systemStr = systemMessages.join('\n\n');
    const system = systemStr
      ? [{ type: 'text', text: systemStr, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const cacheIdx = chatMessages.length >= 2 ? chatMessages.length - 2 : -1;
    const wrapped = chatMessages.map((msg, idx) => {
      if (idx === cacheIdx) {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return { role: msg.role, content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] };
      }
      return msg;
    });

    return { system, messages: wrapped };
  }

  async chat(messages, options = {}) {
    return (await this.chatDetailed(messages, options)).text;
  }

  async chatDetailed(messages, options = {}) {
    const abortScope = createRequestAbortScope(options.signal);

    try {
      const { system, messages: chatMsgs } = this._convertMessages(messages);
      const body = {
        model: this.model,
        max_tokens: resolveRequiredMaxTokens(options),
        temperature: options.temperature ?? 0.9,
        messages: chatMsgs
      };
      if (system) body.system = system;
      const response = await this._fetch(`/api/ai-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-target-url': `${this.apiUrl}/messages`,
          'x-user-api-key': this.apiKey,
          'x-api-key-header': 'x-api-key',
          'x-proxy-purpose': resolveProxyPurpose(options),
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify(body),
        signal: abortScope.signal
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Claude API Error ${response.status}: ${err}`);
      }
      const data = await response.json();
      emitReasoning(options, data);
      const text = Array.isArray(data.content)
        ? data.content.filter(block => block?.type === 'text').map(block => block.text || '').join('')
        : '';
      return {
        text,
        finishReason: data.stop_reason ?? null,
        usage: data.usage ?? null
      };
    } catch (e) {
      if (e.name === 'AbortError' || abortScope.signal.aborted) {
        throw normalizeAbortError(e, abortScope.signal);
      }
      throw e;
    } finally {
      abortScope.dispose();
    }
  }

  async chatStream(messages, options = {}, onChunk) {
    let lastError = null;
    const maxRetries = options.maxRetries ?? 2;
    const retryDelay = options.retryDelay ?? 800;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await waitWithAbort(retryDelay * Math.pow(2, attempt - 1), options.signal);
        eventBus.emit('pipeline:retrying', { attempt, maxRetries });
      }
      try {
        const abortScope = createRequestAbortScope(options.signal);

        let fullContent = '';
        try {
          const { system, messages: chatMsgs } = this._convertMessages(messages);
          const body = {
            model: this.model,
            max_tokens: resolveRequiredMaxTokens(options),
            temperature: options.temperature ?? 0.9,
            messages: chatMsgs,
            stream: true
          };
          if (system) body.system = system;
          const response = await this._fetch(`/api/ai-proxy`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'x-target-url': `${this.apiUrl}/messages`,
              'x-user-api-key': this.apiKey,
              'x-api-key-header': 'x-api-key',
              'x-proxy-purpose': resolveProxyPurpose(options),
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'prompt-caching-2024-07-31'
            },
            body: JSON.stringify(body),
            signal: abortScope.signal
          });

          if (!response.ok) {
            const err = await response.text();
            const statusErr = new Error(`Claude API ${response.status}: ${err.slice(0, 200)}`);
            statusErr.statusCode = response.status;
            statusErr.isRateLimited = response.status === 429;
            statusErr.isAuthError = response.status === 401 || response.status === 403;
            statusErr.isOverloaded = response.status >= 500;
            throw statusErr;
          }
          if (!response.body) {
            if (options.strictSingleRequest) {
              throw new Error('当前为严格单调用模式，但服务未返回可读取的流；本回合不会自动改用第二次非流式请求，请手动重试或关闭流式输出');
            }
            fullContent = await this.chat(messages, { ...options, signal: abortScope.signal });
            return fullContent;
          }

          let lastUsage = null;
          const { eventCount, rawText } = await consumeStreamingBody(response.body, payload => {
            if (payload.trim() === '[DONE]') return STREAM_COMPLETE;
            const data = parseSseJsonPayload(payload, 'Claude AI');
            const streamError = createStreamPayloadError(data, 'Claude AI');
            if (streamError) {
              streamError.partialResponse = fullContent || null;
              throw streamError;
            }
            if (data.type === 'message_start' && data.message?.usage) {
              lastUsage = data.message.usage;
            }
            if (data.type === 'content_block_delta') {
              emitReasoning(options, data);
              const text = data.delta?.text || '';
              if (text) {
                fullContent += text;
                onChunk?.(text);
              }
            }
            if (data.type === 'message_stop') return STREAM_COMPLETE;
          }, abortScope.signal);
          if (lastUsage) eventBus.emit('ai:usage', lastUsage);
          if (eventCount > 0) {
            if (fullContent) return fullContent;
            throw new Error('Claude AI 流已结束，但没有返回有效正文');
          }

          const data = parseJsonResponse(rawText, 'Claude AI');
          if (data.error) throw createStreamPayloadError(data, 'Claude AI');
          emitReasoning(options, data);
          const content = Array.isArray(data.content)
            ? data.content.filter(block => block?.type === 'text').map(block => block.text || '').join('')
            : '';
          if (content) {
            onChunk?.(content);
            return content;
          }
          throw new Error(`Claude AI 未返回有效回复: ${JSON.stringify(data)}`);
        } catch (fetchError) {
          let failure = fetchError;
          const partial = failure.partialResponse || fullContent || null;
          if (failure.name === 'AbortError' || abortScope.signal.aborted) {
            failure = normalizeAbortError(failure, abortScope.signal);
          }
          if (partial) failure.partialResponse = partial;
          if (failure.isCancelled) {
            lastError = failure;
            throw failure;
          }
          // 流式回调只能追加，已经向 UI 发出内容后透明重试会造成重复或分叉正文。
          if (partial) {
            lastError = failure;
            throw failure;
          }
          if (failure.statusCode === 429 && attempt < maxRetries) {
            await waitWithAbort((retryDelay * 3) * Math.pow(2, attempt), options.signal);
          }
          lastError = failure;
          if (failure.isAuthError || failure.isCancelled || attempt >= maxRetries) throw lastError;
        } finally {
          abortScope.dispose();
        }
      } catch (outerError) {
        lastError = outerError;
        if (outerError.isAuthError || outerError.isCancelled || outerError.partialResponse) throw outerError;
        if (attempt >= maxRetries) throw outerError;
      }
    }
    throw lastError || new Error('Claude API 生成失败');
  }

  validateConfig(config) {
    return !!(config.model);
  }

  static async listModels(config) {
    const apiUrl = normalizeApiBaseUrl(config.apiUrl || 'https://api.anthropic.com/v1', 'claude');
    const response = await new AIAdapter()._fetch(`/api/ai-proxy`, {
      method: 'GET',
      headers: {
        'x-target-url': `${apiUrl}/models`,
        'x-user-api-key': config.apiKey || '',
        'x-api-key-header': 'x-api-key',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      }
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`模型列表读取失败 ${response.status}: ${err}`);
    }
    const data = await response.json();
    const models = Array.isArray(data.data) ? data.data : [];
    return models
      .map(item => typeof item === 'string' ? item : item?.id || item?.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }
}

class DeepSeekAdapter extends OpenAICompatibleAdapter {
  constructor(config) {
    super({
      ...config,
      apiUrl: config.apiUrl || 'https://api.deepseek.com/v1',
      model: config.model || 'deepseek-chat'
    });
  }
}

export class AIClient {
  constructor() {
    this.adapter = null;
    this._config = null;
    this._abortController = null;
    this._useProxy = false;
  }

  configure(config) {
    const backend = config.backend || 'openai';
    const normalizedApiUrl = backend === 'tavern'
      ? (config.apiUrl || '')
      : normalizeApiBaseUrl(config.apiUrl || '', backend);
    this._config = { ...config, apiUrl: normalizedApiUrl };
    this._useProxy = backend !== 'tavern'
      && config.useProxy === true
      && !isNativeAndroidApp()
      && !isLocalNetworkApiUrl(normalizedApiUrl);

    switch (backend) {
      case 'tavern':
        this.adapter = new TavernAdapter(this._config);
        break;
      case 'claude':
        this.adapter = new ClaudeAdapter(this._config);
        break;
      case 'deepseek':
        this.adapter = new DeepSeekAdapter(this._config);
        break;
      case 'custom':
      case 'openai':
      default:
        this.adapter = new OpenAICompatibleAdapter(this._config);
        break;
    }
  }

  getModelInfo() {
    return this.adapter ? this.adapter.getModelInfo() : { name: '未配置', contextWindow: 0 };
  }

  async _runCancellable(options, operation) {
    const requestController = new AbortController();
    const callerSignal = options?.signal;
    const abortFromCaller = () => requestController.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    this._abortController = requestController;

    try {
      return await operation({ ...options, signal: requestController.signal });
    } finally {
      callerSignal?.removeEventListener('abort', abortFromCaller);
      if (this._abortController === requestController) this._abortController = null;
    }
  }

  async chat(messages, options = {}) {
    if (!this.adapter) throw new Error('AI client not configured');
    return this._runCancellable(options, requestOptions => (
      this._useProxy
        ? this._proxyChat(messages, requestOptions, false)
        : this.adapter.chat(messages, requestOptions)
    ));
  }

  async chatDetailed(messages, options = {}) {
    if (!this.adapter) throw new Error('AI client not configured');
    return this._runCancellable(options, requestOptions => (
      this._useProxy
        ? this._proxyChat(messages, requestOptions, false, undefined, true)
        : this.adapter.chatDetailed(messages, requestOptions)
    ));
  }

  async chatStream(messages, options = {}, onChunk) {
    if (!this.adapter) throw new Error('AI client not configured');
    return this._runCancellable(options, requestOptions => {
      if (this._useProxy) {
        return this._proxyChat(messages, requestOptions, true, onChunk);
      }
      return this.adapter.chatStream(messages, requestOptions, onChunk);
    });
  }

  cancel() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  // ── 代理模式：所有请求经 /api/ai-proxy 转发 ──
  async _proxyChat(messages, options, stream, onChunk, detailed = false, recoveryAttempt = false) {
    const config = this._config || {};
    const targetUrl = this._buildApiUrl();
    const apiKeyHeader = config.backend === 'claude' ? 'x-api-key' : 'Authorization';
    const requestController = new AbortController();
    const parentSignal = options.signal;
    const abortFromParent = () => {
      if (requestController.signal.aborted) return;
      requestController.abort(parentSignal?.reason);
    };
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    if (!parentSignal) this._abortController = requestController;

    const isClaude = config.backend === 'claude';
    const headers = {
      'Content-Type': 'application/json',
      'x-target-url': targetUrl,
      'x-user-api-key': config.apiKey || '',
      'x-api-key-header': apiKeyHeader,
      'x-proxy-purpose': resolveProxyPurpose(options),
    };
    if (stream) headers.Accept = 'text/event-stream';
    if (isClaude) {
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
    }

    const converted = isClaude && typeof this.adapter?._convertMessages === 'function'
      ? this.adapter._convertMessages(messages)
      : { messages: normalizeOpenAIMessageOrder(messages) };
    const body = {
      model: config.model,
      messages: converted.messages,
      temperature: options.temperature ?? 0.9,
      stream: stream || false,
    };
    if (isClaude) body.max_tokens = resolveRequiredMaxTokens(options);
    else applyOptionalMaxTokens(body, options);
    // Keep proxied OpenAI-compatible streaming aligned with the direct adapter.
    // Some relays do not start their SSE response unless stream_options is present.
    if (stream && !isClaude) body.stream_options = { include_usage: true };
    if (converted.system) body.system = converted.system;
    if (options.top_p !== undefined) body.top_p = options.top_p;
    let streamedContent = '';

    try {
      // useProxy 是显式配置；不能再按部署 hostname 把请求静默改成浏览器直连。
      const response = await fetch('/api/ai-proxy', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestController.signal,
      });

      if (!response.ok) {
        const err = await response.text().catch(() => '');
        const statusError = new Error(`代理错误 ${response.status}: ${err.slice(0, 200)}`);
        statusError.statusCode = response.status;
        statusError.isRateLimited = response.status === 429;
        statusError.isAuthError = response.status === 401 || response.status === 403;
        statusError.isOverloaded = response.status >= 500;
        throw statusError;
      }

      let data;
      if (stream && response.body) {
        const consumed = await consumeStreamingBody(response.body, payload => {
          if (payload.trim() === '[DONE]') return STREAM_COMPLETE;
          const event = parseSseJsonPayload(payload, '代理 AI');
          const streamError = createStreamPayloadError(event, '代理 AI');
          if (streamError) {
            streamError.partialResponse = streamedContent || null;
            throw streamError;
          }
          const text = visibleResponseText(event);
          if (text) { streamedContent += text; onChunk?.(text); }
          emitReasoning(options, event);
          if (event.type === 'message_stop') return STREAM_COMPLETE;
        }, requestController.signal);
        if (consumed.eventCount > 0) {
          if (streamedContent.trim()) return streamedContent;
          if (!recoveryAttempt) {
            const recoveryOptions = { ...options };
            if (Number(body.max_tokens) > 0) {
              const requestedTokens = Number(body.max_tokens);
              recoveryOptions.max_tokens = Math.min(16000, Math.max(4096, requestedTokens * 2));
            }
            const recovered = await this._proxyChat(
              messages, recoveryOptions, false, undefined, detailed, true
            );
            const recoveredText = detailed ? recovered?.text : recovered;
            if (String(recoveredText || '').trim()) {
              onChunk?.(recoveredText);
              return recovered;
            }
          }
          throw new Error('代理 AI 流已结束，但没有返回有效正文');
        }
        data = parseJsonResponse(consumed.rawText, '代理 AI');
      } else {
        data = await response.json();
      }

      // 非流式或未按流返回（例如报错提示）
      if (data.error) {
        throw createStreamPayloadError(data, '代理 AI');
      }
      emitReasoning(options, data);
      const text = visibleResponseText(data);
      if (recoveryAttempt && !String(text || '').trim()) {
        throw new Error('代理 AI 非流式恢复仍未返回有效正文');
      }
      if (stream && text) onChunk?.(text);
      if (detailed) {
        return {
          text,
          finishReason: isClaude
            ? (data.stop_reason ?? null)
            : (data.choices?.[0]?.finish_reason ?? null),
          usage: data.usage ?? null
        };
      }
      return text;
    } catch (e) {
      const partial = e.partialResponse || streamedContent || null;
      if (partial) e.partialResponse = partial;
      if (e.name === 'AbortError' || requestController.signal.aborted) {
        const aborted = normalizeAbortError(e, requestController.signal);
        aborted.partialResponse = partial;
        throw aborted;
      }
      if (e?._proxyChatWrapped === true) throw e;
      const wrapped = new Error(`代理请求失败: ${e.message}`);
      wrapped.cause = e;
      wrapped.partialResponse = partial;
      wrapped.isAuthError = e.isAuthError;
      wrapped.isRateLimited = e.isRateLimited;
      wrapped.isOverloaded = e.isOverloaded;
      wrapped.statusCode = e.statusCode;
      Object.defineProperty(wrapped, '_proxyChatWrapped', { value: true });
      throw wrapped;
    } finally {
      parentSignal?.removeEventListener('abort', abortFromParent);
      if (this._abortController === requestController) this._abortController = null;
    }
  }

  _buildApiUrl() {
    const config = this._config || {};
    const backend = config.backend || 'openai';
    const baseUrl = normalizeApiBaseUrl(config.apiUrl || '', backend);
    switch (backend) {
      case 'claude':
        return `${baseUrl || 'https://api.anthropic.com/v1'}/messages`;
      case 'deepseek':
        return `${baseUrl || 'https://api.deepseek.com/v1'}/chat/completions`;
      case 'openai':
      case 'custom':
      default:
        return `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
    }
  }

  async listModels(config = this._config || {}) {
    const backend = config.backend || 'openai';
    if (!config.apiUrl && backend === 'deepseek') config = { ...config, apiUrl: 'https://api.deepseek.com/v1' };
    if (!config.apiUrl && backend === 'claude') config = { ...config, apiUrl: 'https://api.anthropic.com/v1' };
    if (!config.apiUrl) throw new Error('请先填写 API 地址');
    if (backend === 'claude') return ClaudeAdapter.listModels(config);
    return OpenAICompatibleAdapter.listModels(config);
  }

  getConfig() {
    return this._config;
  }

  isConfigured() {
    if (this.adapter instanceof TavernAdapter) return true;
    return this.adapter?.validateConfig(this._config || {}) ?? false;
  }
}

export const aiClient = new AIClient();
export default aiClient;
