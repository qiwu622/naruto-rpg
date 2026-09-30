import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { withCustomElementGlobals } from './helpers/browser-element-globals.mjs';
import {
  acceptsEventStream,
  forwardStreamingResponse,
  hasEventStreamMediaType,
  shouldStreamResponse
} from '../server/api/ai-proxy.js';

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(new Error(`${name}: ${error.message}`));
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function createControlledResponse(contentType = 'text/event-stream') {
  const encoder = new TextEncoder();
  let controller;
  let closed = false;
  let cancelCount = 0;
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel() {
      cancelCount++;
      closed = true;
    }
  });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': contentType } }),
    get cancelCount() { return cancelCount; },
    send(text) { controller.enqueue(encoder.encode(text)); },
    sendBytes(bytes) { controller.enqueue(bytes); },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
    fail(error) {
      if (closed) return;
      closed = true;
      controller.error(error);
    }
  };
}

function abortError(message = 'aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function expectBeforeClose(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not arrive before stream close`)), 120);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectRejectedBefore(promise, label) {
  const outcome = await expectBeforeClose(
    promise.then(value => ({ value }), error => ({ error })),
    label
  );
  assert.ok(outcome.error, `${label} unexpectedly resolved with ${String(outcome.value)}`);
  return outcome.error;
}

function streamEvent(backend, text) {
  return backend === 'claude'
    ? { type: 'content_block_delta', delta: { text } }
    : { choices: [{ delta: { content: text } }] };
}

async function probeDirectStream({ backend, separator, dataPrefix, contentType }) {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };
  const controlled = createControlledResponse(contentType);
  let requestHeaders;
  globalThis.fetch = async (_url, init) => {
    requestHeaders = init?.headers || {};
    return controlled.response;
  };

  let streamPromise;
  try {
    const runtime = await import(`../js/core/ai-client.js?direct-${backend}-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend,
      apiUrl: backend === 'claude' ? 'https://api.anthropic.test/v1' : 'https://api.openai.test/v1',
      apiKey: 'redacted',
      model: 'stream-probe',
      useProxy: false
    });

    const chunks = [];
    let resolveFirst;
    const firstChunk = new Promise(resolve => { resolveFirst = resolve; });
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { maxRetries: 0, timeout: 2000 },
      chunk => {
        chunks.push(chunk);
        if (chunks.length === 1) resolveFirst();
      }
    );

    controlled.send(`${dataPrefix}${JSON.stringify(streamEvent(backend, '甲'))}${separator}`);
    await expectBeforeClose(firstChunk, `${backend} first chunk`);
    assert.deepEqual(chunks, ['甲']);
    assert.equal(requestHeaders.Accept || requestHeaders.accept, 'text/event-stream');

    controlled.send(`${dataPrefix}${JSON.stringify(streamEvent(backend, '乙'))}${separator}`);
    controlled.close();
    assert.equal(await streamPromise, '甲乙');
    assert.deepEqual(chunks, ['甲', '乙']);
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
}

async function probeDirectSseError(backend) {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };
  const controlled = createControlledResponse();
  globalThis.fetch = async () => controlled.response;

  let streamPromise;
  try {
    const runtime = await import(`../js/core/ai-client.js?sse-error-${backend}-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend,
      apiUrl: backend === 'claude' ? 'https://api.anthropic.test/v1' : 'https://api.openai.test/v1',
      apiKey: 'redacted',
      model: 'stream-probe',
      useProxy: false
    });

    const chunks = [];
    let resolveFirst;
    const firstChunk = new Promise(resolve => { resolveFirst = resolve; });
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { maxRetries: 0, timeout: 2000 },
      chunk => {
        chunks.push(chunk);
        resolveFirst();
      }
    );
    controlled.send(`data:${JSON.stringify(streamEvent(backend, '甲'))}\n\n`);
    await expectBeforeClose(firstChunk, `${backend} pre-error token`);
    const providerError = backend === 'claude'
      ? { type: 'error', error: { type: 'overloaded_error', message: 'stream exploded' } }
      : { error: { code: 'server_error', message: 'stream exploded' } };
    controlled.send(`data:${JSON.stringify(providerError)}\n\n`);

    const error = await expectRejectedBefore(streamPromise, `${backend} SSE error`);
    assert.match(error.message, /stream exploded/);
    assert.equal(error.partialResponse, '甲');
    assert.deepEqual(chunks, ['甲']);
    assert.equal(controlled.cancelCount, 1);
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
}

async function probePartialTransportFailure(backend) {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };
  const firstResponse = createControlledResponse();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    if (fetchCalls === 1) return firstResponse.response;
    const retryBody = [
      `data:${JSON.stringify(streamEvent(backend, '甲'))}`,
      `data:${JSON.stringify(streamEvent(backend, '乙'))}`,
      'data:[DONE]',
      ''
    ].join('\n\n');
    return new Response(retryBody, { headers: { 'Content-Type': 'text/event-stream' } });
  };

  let streamPromise;
  try {
    const runtime = await import(`../js/core/ai-client.js?partial-network-${backend}-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend,
      apiUrl: backend === 'claude' ? 'https://api.anthropic.test/v1' : 'https://api.openai.test/v1',
      apiKey: 'redacted',
      model: 'stream-probe',
      useProxy: false
    });

    const chunks = [];
    let resolveFirst;
    const firstChunk = new Promise(resolve => { resolveFirst = resolve; });
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { maxRetries: 1, retryDelay: 0, timeout: 2000 },
      chunk => {
        chunks.push(chunk);
        if (chunks.length === 1) resolveFirst();
      }
    );
    firstResponse.send(`data:${JSON.stringify(streamEvent(backend, '甲'))}\n\n`);
    await expectBeforeClose(firstChunk, `${backend} first partial token`);
    firstResponse.fail(new TypeError('socket reset'));

    const error = await expectRejectedBefore(streamPromise, `${backend} partial transport failure`);
    assert.match(error.message, /socket reset/);
    assert.equal(error.partialResponse, '甲');
    assert.equal(fetchCalls, 1, 'a visible partial stream must not be retried transparently');
    assert.deepEqual(chunks, ['甲']);
  } finally {
    firstResponse.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
}

async function probeTimeoutIsIgnored(backend) {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };
  const controlled = createControlledResponse();
  globalThis.fetch = async () => controlled.response;

  let streamPromise;
  try {
    const runtime = await import(`../js/core/ai-client.js?no-timeout-${backend}-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend,
      apiUrl: backend === 'claude' ? 'https://api.anthropic.test/v1' : 'https://api.openai.test/v1',
      apiKey: 'redacted',
      model: 'stream-probe',
      useProxy: false
    });

    const chunks = [];
    let resolveFirst;
    const firstChunk = new Promise(resolve => { resolveFirst = resolve; });
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { maxRetries: 0, timeout: 40 },
      chunk => {
        chunks.push(chunk);
        resolveFirst();
      }
    );
    controlled.send(`data:${JSON.stringify(streamEvent(backend, '甲'))}\n\n`);
    await expectBeforeClose(firstChunk, `${backend} token before close`);

    // 超时选项必须被忽略：等待远超 timeout 后，流仍保持打开、未被自动中止。
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(chunks, ['甲'], 'content must stay intact while the stream is not auto-aborted');
    assert.equal(controlled.cancelCount, 0, 'stream must not be cancelled by a timeout deadline');

    // 只有连接关闭（或手动取消）才会结束流，且返回完整正文、无 isTimeout。
    controlled.close();
    const text = await streamPromise;
    assert.equal(text, '甲');
    assert.deepEqual(chunks, ['甲']);
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
}

for (const backend of ['openai', 'claude']) {
  await test(`${backend} direct stream accepts CRLF frames incrementally`, () => probeDirectStream({
    backend,
    separator: '\r\n\r\n',
    dataPrefix: 'data: ',
    contentType: 'text/event-stream; charset=utf-8'
  }));

  await test(`${backend} direct stream accepts case-insensitive media type and data without a space`, () => probeDirectStream({
    backend,
    separator: '\n\n',
    dataPrefix: 'data:',
    contentType: 'Text/Event-Stream; Charset=UTF-8'
  }));

  await test(`${backend} SSE errors reject and preserve visible partial content`, () => probeDirectSseError(backend));
  await test(`${backend} does not retry after emitting a partial stream`, () => probePartialTransportFailure(backend));
  await test(`${backend} timeout option does not auto-abort the stream (manual stop only)`, () => probeTimeoutIsIgnored(backend));
}

await test('OpenAI-compatible requests place every system contract before chat turns', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'custom.example' };
  const requestBodies = [];
  globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(init?.body || '{}'));
    return new Response(JSON.stringify({
      choices: [{ message: { content: '完成' }, finish_reason: 'stop' }]
    }), { headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const runtime = await import(`../js/core/ai-client.js?system-order-${Date.now()}-${Math.random()}`);
    const input = [
      { role: 'system', content: '基础规则' },
      { role: 'user', content: '上一轮' },
      { role: 'assistant', content: '上一轮回复' },
      { role: 'system', content: '回合证据' },
      { role: 'user', content: '本轮操作' },
      { role: 'assistant', content: '<reasoning>' },
      { role: 'system', content: '最终结构契约' }
    ];

    const expected = [
      { role: 'system', content: '基础规则\n\n回合证据\n\n最终结构契约' },
      { role: 'user', content: '上一轮' },
      { role: 'assistant', content: '上一轮回复' },
      { role: 'user', content: '本轮操作' },
      { role: 'assistant', content: '<reasoning>' }
    ];
    for (const useProxy of [false, true]) {
      const client = new runtime.AIClient();
      client.configure({
        backend: 'openai',
        apiUrl: 'https://provider.example/v1',
        apiKey: 'redacted',
        model: 'order-probe',
        useProxy
      });
      assert.equal(await client.chat(input, { max_tokens: 0 }), '完成');
      assert.deepEqual(requestBodies.at(-1)?.messages, expected);
    }
    assert.equal(requestBodies.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('SSE parser handles split UTF-8 bytes and a split mixed line boundary', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };
  const controlled = createControlledResponse();
  globalThis.fetch = async () => controlled.response;
  let streamPromise;

  try {
    const runtime = await import(`../js/core/ai-client.js?split-sse-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'openai', apiUrl: 'https://api.openai.test/v1', apiKey: 'redacted',
      model: 'stream-probe', useProxy: false
    });
    const chunks = [];
    let resolveFirst;
    const firstChunk = new Promise(resolve => { resolveFirst = resolve; });
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { maxRetries: 0, timeout: 2000 },
      chunk => { chunks.push(chunk); resolveFirst(); }
    );

    const bytes = new TextEncoder().encode(`data:${JSON.stringify(streamEvent('openai', '甲乙'))}\r\n\r`);
    const multibyteAt = bytes.indexOf(0xe7);
    assert.ok(multibyteAt > 0);
    controlled.sendBytes(bytes.slice(0, multibyteAt + 1));
    controlled.sendBytes(bytes.slice(multibyteAt + 1, -1));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(chunks, [], 'a single CRLF line ending must not dispatch an SSE event');
    controlled.sendBytes(bytes.slice(-1));
    await expectBeforeClose(firstChunk, 'split UTF-8 SSE token');
    assert.deepEqual(chunks, ['甲乙']);
    controlled.send('\n'); // Completes the trailing CRLF without creating another blank line.
    controlled.close();
    assert.equal(await streamPromise, '甲乙');
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('empty SSE heartbeats are ignored and terminal events finish an open stream', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };

  try {
    for (const backend of ['openai', 'claude']) {
      const controlled = createControlledResponse();
      globalThis.fetch = async () => controlled.response;
      const runtime = await import(`../js/core/ai-client.js?terminal-event-${backend}-${Date.now()}-${Math.random()}`);
      const client = new runtime.AIClient();
      client.configure({
        backend,
        apiUrl: backend === 'claude' ? 'https://api.anthropic.test/v1' : 'https://api.openai.test/v1',
        apiKey: 'redacted', model: 'stream-probe', useProxy: false
      });
      const chunks = [];
      let settled = false;
      const streamPromise = client.chatStream(
        [{ role: 'user', content: 'probe' }],
        { maxRetries: 0, timeout: 2000 },
        chunk => chunks.push(chunk)
      );
      streamPromise.then(() => { settled = true; }, () => { settled = true; });

      controlled.send('data:\n\n');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(settled, false, `${backend} treated an empty heartbeat as an error or completion`);
      assert.deepEqual(chunks, []);

      controlled.send(`data:${JSON.stringify(streamEvent(backend, '甲'))}\n\n`);
      controlled.send(backend === 'claude'
        ? 'data:{"type":"message_stop"}\n\n'
        : 'data:[DONE]\n\n');
      assert.equal(await expectBeforeClose(streamPromise, `${backend} terminal event`), '甲');
      assert.deepEqual(chunks, ['甲']);
      assert.equal(controlled.cancelCount, 1, `${backend} terminal event should release the open body`);
      controlled.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('local model direct streaming preserves the target URL and event-stream Accept header', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'deployed.example' };
  const controlled = createControlledResponse();
  let fetchUrl;
  let requestHeaders;
  globalThis.fetch = async (url, init) => {
    fetchUrl = String(url);
    requestHeaders = init?.headers || {};
    return controlled.response;
  };
  let streamPromise;

  try {
    const runtime = await import(`../js/core/ai-client.js?local-direct-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'openai', apiUrl: 'http://127.0.0.1:11434/v1', apiKey: '',
      model: 'local-model', useProxy: false
    });
    const chunks = [];
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { maxRetries: 0, timeout: 2000 },
      chunk => chunks.push(chunk)
    );
    controlled.send(`data:${JSON.stringify(streamEvent('openai', '甲'))}\n\n`);
    controlled.close();
    assert.equal(await streamPromise, '甲');
    assert.equal(fetchUrl, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(requestHeaders.Accept || requestHeaders.accept, 'text/event-stream');
    assert.deepEqual(chunks, ['甲']);
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('a connection failure before the first token can still retry safely', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    if (fetchCalls === 1) throw new TypeError('connect failed');
    const body = [
      `data:${JSON.stringify(streamEvent('openai', '甲'))}`,
      `data:${JSON.stringify(streamEvent('openai', '乙'))}`,
      'data:[DONE]',
      ''
    ].join('\n\n');
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  };

  try {
    const runtime = await import(`../js/core/ai-client.js?pre-token-retry-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'openai', apiUrl: 'https://api.openai.test/v1', apiKey: 'redacted',
      model: 'stream-probe', useProxy: false
    });
    const chunks = [];
    const result = await client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { maxRetries: 1, retryDelay: 0, timeout: 2000 },
      chunk => chunks.push(chunk)
    );
    assert.equal(fetchCalls, 2);
    assert.equal(result, '甲乙');
    assert.deepEqual(chunks, ['甲', '乙']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('consumer callback errors propagate without retrying the visible stream', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };
  const controlled = createControlledResponse();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return controlled.response;
  };

  let streamPromise;
  try {
    const runtime = await import(`../js/core/ai-client.js?consumer-error-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'openai', apiUrl: 'https://api.openai.test/v1', apiKey: 'redacted',
      model: 'stream-probe', useProxy: false
    });
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { maxRetries: 1, retryDelay: 0, timeout: 2000 },
      () => { throw new Error('consumer failed'); }
    );
    controlled.send(`data:${JSON.stringify(streamEvent('openai', '甲'))}\n\n`);
    const error = await expectRejectedBefore(streamPromise, 'stream consumer failure');
    assert.match(error.message, /consumer failed/);
    assert.equal(error.partialResponse, '甲');
    assert.equal(fetchCalls, 1);
    assert.equal(controlled.cancelCount, 1, 'callback failure should cancel the still-open response body');
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('proxy stream negotiation is case-insensitive and honors explicit request intent', () => {
  assert.equal(hasEventStreamMediaType('Text/Event-Stream; Charset=UTF-8'), true);
  assert.equal(acceptsEventStream('application/json, TEXT/EVENT-STREAM; q=1'), true);
  assert.equal(acceptsEventStream('text/event-stream; q=0'), false);
  assert.equal(shouldStreamResponse({
    statusCode: 200,
    method: 'POST',
    contentType: '',
    accept: '',
    body: { stream: true }
  }), true);
  assert.equal(shouldStreamResponse({
    statusCode: 429,
    method: 'POST',
    contentType: 'application/json',
    accept: 'text/event-stream',
    body: { stream: true }
  }), false);
  assert.equal(shouldStreamResponse({
    statusCode: 200,
    method: 'POST',
    contentType: 'application/json',
    accept: 'text/event-stream; q=0',
    body: { stream: false }
  }), false);
  for (const statusCode of [401, 403, 429, 500, 502, 503]) {
    assert.equal(shouldStreamResponse({
      statusCode,
      method: 'POST',
      contentType: 'application/json',
      accept: 'text/event-stream',
      body: { stream: true }
    }), false, `HTTP ${statusCode} JSON must not be promoted to SSE`);
  }
});

await test('proxy stream forwarding settles when a backpressured client disconnects', async () => {
  let resolveWrite;
  const wrote = new Promise(resolve => { resolveWrite = resolve; });
  const response = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {
      resolveWrite();
      // Deliberately hold the write callback to simulate a connected client that stopped reading.
    }
  });
  response.setHeader = () => {};
  response.flushHeaders = () => {};
  response.flush = () => {};

  const forwarding = forwardStreamingResponse(Readable.from([Buffer.from('data:{"ok":true}\n\n')]), response);
  await expectBeforeClose(wrote, 'backpressured proxy write');
  response.destroy();

  try {
    const error = await expectRejectedBefore(forwarding, 'proxy disconnect during backpressure');
    assert.ok(error.name === 'AbortError' || error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ERR_STREAM_DESTROYED');
  } finally {
    // Releases the old implementation so a failing regression does not leave a dangling promise.
    response.emit('drain');
    await forwarding.catch(() => {});
  }
  assert.equal(response.listenerCount('drain'), 0);
});

await test('proxy streaming enforces the configured response-size limit', async () => {
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  response.setHeader = () => {};
  response.flushHeaders = () => {};
  const forwarding = forwardStreamingResponse(
    Readable.from([Buffer.from('1234')]),
    response,
    { maxResponseBytes: 3 }
  );
  const error = await expectRejectedBefore(forwarding, 'oversized proxy stream');
  assert.equal(error.code, 'ERR_AI_STREAM_TOO_LARGE');
});

await test('proxy mode remains same-origin on custom deployment hosts and sniffs mislabeled SSE', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'custom.example' };
  const controlled = createControlledResponse('application/json');
  let fetchUrl = '';
  let requestHeaders;
  let requestBody;
  globalThis.fetch = async (url, init) => {
    fetchUrl = String(url);
    requestHeaders = init?.headers || {};
    requestBody = JSON.parse(init?.body || '{}');
    return controlled.response;
  };

  let streamPromise;
  try {
    const runtime = await import(`../js/core/ai-client.js?custom-proxy-${Date.now()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'openai',
      apiUrl: 'https://provider.example/v1',
      apiKey: 'redacted',
      model: 'stream-probe',
      useProxy: true
    });

    const chunks = [];
    let resolveFirst;
    const firstChunk = new Promise(resolve => { resolveFirst = resolve; });
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { timeout: 2000 },
      chunk => {
        chunks.push(chunk);
        if (chunks.length === 1) resolveFirst();
      }
    );
    controlled.send(`data:${JSON.stringify(streamEvent('openai', '甲'))}\r\n\r\n`);
    await expectBeforeClose(firstChunk, 'proxied first chunk');
    assert.equal(fetchUrl, '/api/ai-proxy');
    assert.equal(requestHeaders.Accept || requestHeaders.accept, 'text/event-stream');
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    controlled.send(`data:${JSON.stringify(streamEvent('openai', '乙'))}\r\n\r\n`);
    controlled.close();
    assert.equal(await streamPromise, '甲乙');
    assert.deepEqual(chunks, ['甲', '乙']);
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('timeout zero keeps an agent stream alive until the model finishes', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'custom.example' };
  const controlled = createControlledResponse();
  let requestSignal = null;
  let requestHeaders = null;
  let requestBody = null;
  globalThis.fetch = async (_url, init) => {
    requestSignal = init?.signal || null;
    requestHeaders = new Headers(init?.headers || {});
    requestBody = JSON.parse(init?.body || '{}');
    return controlled.response;
  };

  let streamPromise;
  let streamOutcome;
  try {
    const runtime = await import(`../js/core/ai-client.js?agent-no-timeout-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'openai', apiUrl: 'https://provider.example/v1', apiKey: 'redacted',
      model: 'stream-probe', useProxy: false
    });
    const chunks = [];
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { timeout: 0, max_tokens: 0, maxRetries: 0 },
      chunk => chunks.push(chunk)
    );
    streamOutcome = streamPromise.then(
      value => ({ value, error: null }),
      error => ({ value: null, error })
    );

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(requestSignal?.aborted, false, 'timeout: 0 must not schedule an immediate abort');
    assert.equal(requestHeaders?.get('x-proxy-purpose'), 'agent');
    assert.equal('max_tokens' in requestBody, false, 'Agent requests must omit the provider output cap');
    controlled.send(`data:${JSON.stringify(streamEvent('openai', '完整'))}\n\n`);
    controlled.send('data:[DONE]\n\n');
    controlled.close();
    const outcome = await streamOutcome;
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.value, '完整');
    assert.deepEqual(chunks, ['完整']);
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('proxy stream without visible content recovers once with a non-stream response', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'custom.example' };
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      headers: init?.headers || {},
      body: JSON.parse(init?.body || '{}')
    });
    if (requests.length === 1) {
      const streamBody = [
        `data:${JSON.stringify({ choices: [{ delta: { reasoning_content: '内部推理' } }] })}`,
        `data:${JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } })}`,
        'data:[DONE]',
        ''
      ].join('\n\n');
      return new Response(streamBody, {
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '恢复后的代理正文' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 6 }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const runtime = await import(`../js/core/ai-client.js?proxy-empty-stream-recovery-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'openai',
      apiUrl: 'https://provider.example/v1',
      apiKey: 'redacted',
      model: 'stream-probe',
      useProxy: true
    });

    const chunks = [];
    const result = await client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { timeout: 0, max_tokens: 0 },
      chunk => chunks.push(chunk)
    );

    assert.equal(result, '恢复后的代理正文');
    assert.deepEqual(chunks, ['恢复后的代理正文']);
    assert.equal(requests.length, 2, 'empty visible streams should trigger exactly one recovery request');
    assert.deepEqual(requests.map(request => request.url), ['/api/ai-proxy', '/api/ai-proxy']);
    assert.equal(requests[0].body.stream, true);
    assert.equal('max_tokens' in requests[0].body, false);
    assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
    assert.equal(requests[1].body.stream, false);
    assert.equal('max_tokens' in requests[1].body, false);
    assert.equal('stream_options' in requests[1].body, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('proxy mode rejects SSE errors and preserves streamed partial content', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'custom.example' };
  const controlled = createControlledResponse();
  globalThis.fetch = async () => controlled.response;

  let streamPromise;
  try {
    const runtime = await import(`../js/core/ai-client.js?proxy-sse-error-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'openai',
      apiUrl: 'https://provider.example/v1',
      apiKey: 'redacted',
      model: 'stream-probe',
      useProxy: true
    });

    const chunks = [];
    let resolveFirst;
    const firstChunk = new Promise(resolve => { resolveFirst = resolve; });
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { timeout: 2000 },
      chunk => {
        chunks.push(chunk);
        resolveFirst();
      }
    );
    controlled.send(`data:${JSON.stringify(streamEvent('openai', '甲'))}\n\n`);
    await expectBeforeClose(firstChunk, 'proxied token before SSE error');
    controlled.send('data:{"error":{"message":"proxied stream exploded"}}\n\n');

    const error = await expectRejectedBefore(streamPromise, 'proxied SSE error');
    assert.match(error.message, /proxied stream exploded/);
    assert.equal(error.partialResponse, '甲');
    assert.deepEqual(chunks, ['甲']);
    assert.equal(controlled.cancelCount, 1);
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('proxied Claude message_stop finishes and releases an open response body', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'custom.example' };
  const controlled = createControlledResponse();
  globalThis.fetch = async () => controlled.response;
  let streamPromise;

  try {
    const runtime = await import(`../js/core/ai-client.js?proxy-claude-stop-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'claude', apiUrl: 'https://provider.example/v1', apiKey: 'redacted',
      model: 'stream-probe', useProxy: true
    });
    const chunks = [];
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { timeout: 2000 },
      chunk => chunks.push(chunk)
    );
    controlled.send(`data:${JSON.stringify(streamEvent('claude', '甲'))}\n\n`);
    controlled.send('data:{"type":"message_stop"}\n\n');
    assert.equal(await expectBeforeClose(streamPromise, 'proxied Claude message_stop'), '甲');
    assert.deepEqual(chunks, ['甲']);
    assert.equal(controlled.cancelCount, 1);
  } finally {
    controlled.close();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('caller AbortSignal cancels the active stream instead of being overwritten', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };
  let requestSignal;
  globalThis.fetch = async (_url, init) => {
    requestSignal = init?.signal;
    return await new Promise((_resolve, reject) => {
      const rejectForAbort = () => reject(requestSignal.reason || abortError('caller cancelled'));
      if (requestSignal?.aborted) rejectForAbort();
      else requestSignal?.addEventListener('abort', rejectForAbort, { once: true });
    });
  };

  let client;
  let streamPromise;
  try {
    const runtime = await import(`../js/core/ai-client.js?external-abort-${Date.now()}-${Math.random()}`);
    client = new runtime.AIClient();
    client.configure({
      backend: 'openai',
      apiUrl: 'https://api.openai.test/v1',
      apiKey: 'redacted',
      model: 'stream-probe',
      useProxy: false
    });
    const caller = new AbortController();
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { signal: caller.signal, maxRetries: 0, timeout: 2000 },
      () => {}
    );
    assert.ok(requestSignal);
    // AbortController accepts arbitrary reasons; cancellation must stay classified even for a plain Error.
    caller.abort(new Error('caller cancelled'));

    const error = await expectRejectedBefore(streamPromise, 'external stream cancellation');
    assert.equal(requestSignal.aborted, true);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.isCancelled, true);
  } finally {
    client?.cancel();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('proxy streaming normalizes arbitrary abort reasons', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'custom.example' };
  let requestSignal;
  globalThis.fetch = async (_url, init) => {
    requestSignal = init?.signal;
    return await new Promise((_resolve, reject) => {
      const rejectForAbort = () => reject(requestSignal.reason || new Error('proxy caller cancelled'));
      if (requestSignal?.aborted) rejectForAbort();
      else requestSignal?.addEventListener('abort', rejectForAbort, { once: true });
    });
  };
  let client;
  let streamPromise;

  try {
    const runtime = await import(`../js/core/ai-client.js?proxy-arbitrary-abort-${Date.now()}-${Math.random()}`);
    client = new runtime.AIClient();
    client.configure({
      backend: 'openai', apiUrl: 'https://provider.example/v1', apiKey: 'redacted',
      model: 'stream-probe', useProxy: true
    });
    const caller = new AbortController();
    streamPromise = client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { signal: caller.signal, timeout: 2000 },
      () => {}
    );
    caller.abort(new Error('proxy caller cancelled'));
    const error = await expectRejectedBefore(streamPromise, 'proxied external cancellation');
    assert.equal(requestSignal.aborted, true);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.isCancelled, true);
  } finally {
    client?.cancel();
    await streamPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('proxy HTTP errors preserve status classification', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { hostname: 'custom.example' };
  globalThis.fetch = async () => new Response('rate limited', { status: 429 });
  try {
    const runtime = await import(`../js/core/ai-client.js?proxy-status-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({
      backend: 'openai', apiUrl: 'https://provider.example/v1', apiKey: 'redacted',
      model: 'stream-probe', useProxy: true
    });
    const error = await expectRejectedBefore(client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { timeout: 2000 },
      () => {}
    ), 'proxy HTTP 429');
    assert.equal(error.statusCode, 429);
    assert.equal(error.isRateLimited, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

await test('saved Tavern transport settings migrate away from the HTTP proxy', async () => {
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
  try {
    const { saveApiConfigSecure, loadApiConfigSecure } = await import('../js/utils/api-crypto.js');
    await saveApiConfigSecure({ backend: 'tavern', model: 'tavern-default', useProxy: true });
    assert.equal(JSON.parse(values.get('naruto_api_config')).useProxy, false);

    values.set('naruto_api_config', JSON.stringify({
      backend: 'tavern', model: 'tavern-default', useProxy: true
    }));
    assert.equal((await loadApiConfigSecure()).useProxy, false);
  } finally {
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});

await test('Tavern generateRaw preserves cross-role ordering and final assistant prefill', async () => {
  const originals = {
    location: globalThis.location,
    generate: globalThis.generate,
    generateRaw: globalThis.generateRaw
  };
  globalThis.location = { hostname: 'tavern.example' };
  globalThis.generate = () => {};
  const calls = [];
  globalThis.generateRaw = async options => {
    calls.push(options);
    return 'continuation';
  };

  try {
    const runtime = await import(`../js/core/ai-client.js?tavern-ordered-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({ backend: 'tavern', model: 'tavern-default' });
    const messages = [
      { role: 'system', content: 'TOP' },
      { role: 'user', content: 'HISTORY_USER' },
      { role: 'assistant', content: 'HISTORY_ASSISTANT' },
      { role: 'user', content: 'CURRENT_USER' },
      { role: 'system', content: 'BOTTOM_CONTRACT' },
      { role: 'assistant', content: 'PREFILL\n<konatan_planning~>日本語：' }
    ];
    assert.equal(await client.chat(messages), 'continuation');
    assert.equal(calls[0].user_input, '');
    assert.deepEqual(calls[0].ordered_prompts, messages);
    assert.deepEqual(calls[0].ordered_prompts.at(-1), messages.at(-1));
    assert.equal(calls[0].ordered_prompts.includes('world_info_before'), false);

    await client.chat([
      { role: 'system', content: 'SUMMARY_SYSTEM' },
      { role: 'user', content: 'SUMMARY_USER' }
    ]);
    assert.equal(calls[1].user_input, 'SUMMARY_USER');
    assert.deepEqual(calls[1].ordered_prompts, [
      { role: 'system', content: 'SUMMARY_SYSTEM' },
      'world_info_before'
    ]);
  } finally {
    if (originals.location === undefined) delete globalThis.location; else globalThis.location = originals.location;
    if (originals.generate === undefined) delete globalThis.generate; else globalThis.generate = originals.generate;
    if (originals.generateRaw === undefined) delete globalThis.generateRaw; else globalThis.generateRaw = originals.generateRaw;
  }
});

await test('Tavern routing ignores stale proxy intent, streams incrementally, and removes its listener', async () => {
  const originals = {
    fetch: globalThis.fetch,
    location: globalThis.location,
    generate: globalThis.generate,
    generateRaw: globalThis.generateRaw,
    iframeEvents: globalThis.iframe_events,
    eventOn: globalThis.eventOn,
    eventRemoveListener: globalThis.eventRemoveListener
  };
  globalThis.location = { hostname: 'tavern.example' };
  globalThis.generate = () => {};
  globalThis.iframe_events = { STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally' };
  let listener = null;
  let listenerEvent = '';
  let removeCount = 0;
  let generateRawCalls = 0;
  globalThis.eventOn = (event, handler) => {
    listenerEvent = event;
    listener = handler;
  };
  globalThis.eventRemoveListener = (event, handler) => {
    assert.equal(event, listenerEvent);
    assert.equal(handler, listener);
    removeCount++;
  };
  globalThis.fetch = async () => { throw new Error('Tavern must not call fetch'); };
  globalThis.generateRaw = async options => {
    generateRawCalls++;
    assert.ok(options.generation_id);
    listener?.('甲', options.generation_id);
    listener?.('乙', options.generation_id);
    return '甲乙';
  };

  try {
    const runtime = await import(`../js/core/ai-client.js?tavern-${Date.now()}`);
    const client = new runtime.AIClient();
    client.configure({ backend: 'tavern', apiUrl: '', apiKey: '', model: 'tavern-default', useProxy: true });
    const chunks = [];
    const result = await client.chatStream([{ role: 'user', content: 'probe' }], {}, chunk => chunks.push(chunk));
    assert.equal(client._useProxy, false);
    assert.equal(listenerEvent, 'js_stream_token_received_incrementally');
    assert.equal(generateRawCalls, 1);
    assert.equal(removeCount, 1);
    assert.deepEqual(chunks, ['甲', '乙']);
    assert.equal(result, '甲乙');
  } finally {
    globalThis.fetch = originals.fetch;
    if (originals.location === undefined) delete globalThis.location; else globalThis.location = originals.location;
    if (originals.generate === undefined) delete globalThis.generate; else globalThis.generate = originals.generate;
    if (originals.generateRaw === undefined) delete globalThis.generateRaw; else globalThis.generateRaw = originals.generateRaw;
    if (originals.iframeEvents === undefined) delete globalThis.iframe_events; else globalThis.iframe_events = originals.iframeEvents;
    if (originals.eventOn === undefined) delete globalThis.eventOn; else globalThis.eventOn = originals.eventOn;
    if (originals.eventRemoveListener === undefined) delete globalThis.eventRemoveListener; else globalThis.eventRemoveListener = originals.eventRemoveListener;
  }
});

await test('Tavern token-only streams fall back to the accumulated content when generateRaw resolves void', async () => {
  const originals = {
    location: globalThis.location,
    generate: globalThis.generate,
    generateRaw: globalThis.generateRaw,
    iframeEvents: globalThis.iframe_events,
    eventOn: globalThis.eventOn,
    eventRemoveListener: globalThis.eventRemoveListener
  };
  globalThis.location = { hostname: 'tavern.example' };
  globalThis.generate = () => {};
  globalThis.iframe_events = { STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally' };
  let listener = null;
  let disposeCount = 0;
  globalThis.eventOn = (_event, handler) => {
    listener = handler;
    return () => { disposeCount++; };
  };
  globalThis.generateRaw = async options => {
    listener?.('甲', options.generation_id);
    listener?.('乙', options.generation_id);
    return undefined;
  };

  try {
    const runtime = await import(`../js/core/ai-client.js?tavern-token-only-${Date.now()}-${Math.random()}`);
    const client = new runtime.AIClient();
    client.configure({ backend: 'tavern', apiUrl: '', apiKey: '', model: 'tavern-default' });
    const chunks = [];
    const result = await client.chatStream(
      [{ role: 'user', content: 'probe' }],
      { timeout: 2000 },
      chunk => chunks.push(chunk)
    );

    assert.deepEqual(chunks, ['甲', '乙']);
    assert.equal(result, '甲乙');
    assert.equal(disposeCount, 1);
  } finally {
    if (originals.location === undefined) delete globalThis.location; else globalThis.location = originals.location;
    if (originals.generate === undefined) delete globalThis.generate; else globalThis.generate = originals.generate;
    if (originals.generateRaw === undefined) delete globalThis.generateRaw; else globalThis.generateRaw = originals.generateRaw;
    if (originals.iframeEvents === undefined) delete globalThis.iframe_events; else globalThis.iframe_events = originals.iframeEvents;
    if (originals.eventOn === undefined) delete globalThis.eventOn; else globalThis.eventOn = originals.eventOn;
    if (originals.eventRemoveListener === undefined) delete globalThis.eventRemoveListener; else globalThis.eventRemoveListener = originals.eventRemoveListener;
  }
});

await test('Tavern cancellation stops the matching generation and cleans up listeners', async () => {
  const originals = {
    location: globalThis.location,
    generate: globalThis.generate,
    generateRaw: globalThis.generateRaw,
    stopGenerationById: globalThis.stopGenerationById,
    iframeEvents: globalThis.iframe_events,
    eventOn: globalThis.eventOn,
    eventRemoveListener: globalThis.eventRemoveListener
  };
  globalThis.location = { hostname: 'tavern.example' };
  globalThis.generate = () => {};
  globalThis.iframe_events = { STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally' };
  let listener;
  let generationId;
  let rejectGeneration;
  let stoppedId = null;
  let removeCount = 0;
  globalThis.eventOn = (_event, handler) => { listener = handler; };
  globalThis.eventRemoveListener = (_event, handler) => {
    assert.equal(handler, listener);
    removeCount++;
  };
  globalThis.generateRaw = options => {
    generationId = options.generation_id;
    listener?.('不应串入', 'another-generation');
    listener?.('也不应串入');
    listener?.('甲', generationId);
    return new Promise((_resolve, reject) => { rejectGeneration = reject; });
  };
  globalThis.stopGenerationById = id => {
    stoppedId = id;
    rejectGeneration?.(new Error('generation stopped'));
    return true;
  };

  let client;
  let streamPromise;
  try {
    const runtime = await import(`../js/core/ai-client.js?tavern-cancel-${Date.now()}-${Math.random()}`);
    client = new runtime.AIClient();
    client.configure({ backend: 'tavern', apiUrl: '', apiKey: '', model: 'tavern-default', useProxy: true });
    const chunks = [];
    streamPromise = client.chatStream([{ role: 'user', content: 'probe' }], { timeout: 2000 }, chunk => chunks.push(chunk));
    assert.ok(generationId);
    client.cancel();

    const error = await expectRejectedBefore(streamPromise, 'Tavern generation cancellation');
    assert.equal(stoppedId, generationId);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.isCancelled, true);
    assert.equal(error.partialResponse, '甲');
    assert.deepEqual(chunks, ['甲']);
    assert.equal(removeCount, 1);
  } finally {
    rejectGeneration?.(new Error('test cleanup'));
    await streamPromise?.catch(() => {});
    if (originals.location === undefined) delete globalThis.location; else globalThis.location = originals.location;
    if (originals.generate === undefined) delete globalThis.generate; else globalThis.generate = originals.generate;
    if (originals.generateRaw === undefined) delete globalThis.generateRaw; else globalThis.generateRaw = originals.generateRaw;
    if (originals.stopGenerationById === undefined) delete globalThis.stopGenerationById; else globalThis.stopGenerationById = originals.stopGenerationById;
    if (originals.iframeEvents === undefined) delete globalThis.iframe_events; else globalThis.iframe_events = originals.iframeEvents;
    if (originals.eventOn === undefined) delete globalThis.eventOn; else globalThis.eventOn = originals.eventOn;
    if (originals.eventRemoveListener === undefined) delete globalThis.eventRemoveListener; else globalThis.eventRemoveListener = originals.eventRemoveListener;
  }
});

await test('hidden reasoning keeps a visible safe streaming status', async () => {
  const { instructionParser } = await import('../js/core/instruction-parser.js');
  assert.equal(instructionParser.cleanupPartialResponse('<thinking>不可展示的审校内容'), '');
  const source = fs.readFileSync(new URL('../js/ui/app-shell.js', import.meta.url), 'utf8');
  assert.match(source, /流式连接正常 · 正在回映与校验/);
  assert.match(source, /终稿完成 · 正在复检最终正文/);
  assert.doesNotMatch(source, /content\.textContent\s*=\s*(?:text|response)/);
});

await test('streaming UI can render a token without unrelated timeline state', () => withCustomElementGlobals(async () => {
  const originalDocument = globalThis.document;
  const { appShell } = await import('../js/ui/app-shell.js');
  const originals = {
    element: appShell.element,
    streamingEl: appShell._streamingEl,
    renderMarkdown: appShell._renderMarkdown,
    scroll: appShell._scroll
  };
  const content = {
    innerHTML: '',
    textContent: '',
    classList: { add() {}, remove() {} }
  };
  const streamingEl = {
    className: '',
    innerHTML: '',
    querySelector: selector => selector === '.chat-content' ? content : null
  };
  const messages = {
    innerHTML: '',
    appendChild(node) { assert.equal(node, streamingEl); }
  };
  let scrollCount = 0;

  try {
    globalThis.document = { createElement: () => streamingEl };
    appShell.element = { querySelector: selector => selector === '#chat-messages' ? messages : null };
    appShell._streamingEl = null;
    appShell._renderMarkdown = text => text;
    appShell._scroll = () => { scrollCount++; };

    appShell._updateStreaming('甲');
    assert.equal(content.innerHTML, '甲');
    assert.equal(scrollCount, 1);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    appShell.element = originals.element;
    appShell._streamingEl = originals.streamingEl;
    appShell._renderMarkdown = originals.renderMarkdown;
    appShell._scroll = originals.scroll;
  }
}));

await test('a failed hidden stream removes its placeholder instead of leaving a fake active connection', () => withCustomElementGlobals(async () => {
  const { appShell } = await import('../js/ui/app-shell.js');
  const originalStreamingEl = appShell._streamingEl;
  let removed = 0;
  let cursorRemoved = 0;
  const placeholderContent = {
    classList: { contains: name => name === 'streaming-placeholder' }
  };
  appShell._streamingEl = {
    querySelector(selector) {
      if (selector === '.chat-content') return placeholderContent;
      if (selector === '.typing-cursor') return { remove() { cursorRemoved++; } };
      return null;
    },
    classList: { remove() {} },
    remove() { removed++; }
  };

  try {
    appShell._settleStreamingError();
    assert.equal(cursorRemoved, 1);
    assert.equal(removed, 1);
    assert.equal(appShell._streamingEl, null);
  } finally {
    appShell._streamingEl = originalStreamingEl;
  }
}));

if (failures.length) {
  throw new AggregateError(failures, `${failures.length} AI streaming regression test(s) failed`);
}

console.log(`\n${passed} AI streaming regression tests passed.`);
