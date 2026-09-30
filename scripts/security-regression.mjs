import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { AIClient } from '../js/core/ai-client.js';
import { withCustomElementGlobals } from './helpers/browser-element-globals.mjs';

let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

await test('dynamic music metadata cannot inject HTML attributes', () => {
  const source = fs.readFileSync(new URL('../js/ui/settings-panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /data-song='\$\{esc\(JSON\.stringify\(song\)\)\}'/);
  assert.doesNotMatch(source, /value="\$\{esc\(/);
});

await test('character creator uses attribute escaping for dynamic input values', () => {
  const source = fs.readFileSync(new URL('../js/ui/character-creator.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /value="\$\{this\._esc\(/);
});

await test('service worker bypasses API, auth, and non-GET requests', async () => {
  const listeners = {};
  const cached = [];
  const workerFetchCalls = [];
  const context = {
    URL,
    Response,
    Promise,
    console,
    self: {
      addEventListener: (type, listener) => { listeners[type] = listener; },
      skipWaiting() {},
      location: new URL('https://game.test/sw.js'),
      clients: { claim() {}, async matchAll() { return []; } }
    },
    caches: {
      async keys() { return []; },
      async delete() { return true; },
      async match() { return null; },
      async open() {
        return { async put(request) { cached.push(new URL(request.url).pathname); } };
      }
    },
    async fetch(request, options) {
      workerFetchCalls.push({ request, options });
      return { status: 200, type: 'basic', clone() { return this; } };
    }
  };
  const source = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, context);

  function dispatchFetch(path, method = 'GET', overrides = {}) {
    let responsePromise;
    listeners.fetch({
      request: {
        url: `https://game.test${path}`,
        method,
        mode: 'cors',
        destination: '',
        ...overrides
      },
      waitUntil() {},
      respondWith(value) { responsePromise = value; }
    });
    return responsePromise;
  }

  assert.equal(Boolean(dispatchFetch('/api/music/favorites')), false);
  assert.equal(Boolean(dispatchFetch('/auth/me')), false);
  assert.equal(Boolean(dispatchFetch('/auth/logout', 'POST')), false);
  assert.equal(Boolean(dispatchFetch('/js/app.js', 'GET', { destination: 'script' })), true);
  await Promise.resolve();
  assert.equal(workerFetchCalls.length, 1);
  assert.equal(workerFetchCalls[0].options?.cache, 'no-store');
});

await test('server CSP uses browser-valid local connection sources', () => {
  const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(source, /http:\/\/127\.0\.0\.1:\*/);
  assert.match(source, /ws:\/\/127\.0\.0\.1:\*/);
  assert.match(source, /http:\/\/localhost:\*/);
  assert.match(source, /ws:\/\/localhost:\*/);
  assert.doesNotMatch(source, /(?:http|ws):\/\/\[::1\]:\*/);
});

await test('proxy mode leaves text generation running until manual cancellation', async () => {
  const originalFetch = globalThis.fetch;
  let observedSignal = null;
  globalThis.fetch = (_url, init) => {
    observedSignal = init?.signal ?? null;
    return new Promise((_resolve, reject) => {
      observedSignal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  };

  try {
    const client = new AIClient();
    client.configure({
      backend: 'openai',
      apiUrl: 'https://example.com/v1',
      apiKey: 'probe',
      model: 'probe',
      useProxy: true
    });
    const outcome = await Promise.race([
      client.chat([{ role: 'user', content: 'probe' }], { timeout: 20 })
        .then(() => 'resolved', (error) => `${error.name}:${error.message}`),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 250))
    ]);

    assert.ok(observedSignal, 'proxy fetch should receive an AbortSignal');
    assert.equal(outcome, 'still-pending', 'text proxy should not impose a client timeout');
    assert.equal(observedSignal.aborted, false, 'text proxy should remain cancellable but not auto-aborted');
    client.cancel();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('direct OpenAI and Claude streams wait for body chunks until manual cancellation', async () => {
  const originalFetch = globalThis.fetch;

  try {
    for (const backend of ['openai', 'claude']) {
      let observedSignal = null;
      globalThis.fetch = async (_url, init) => {
        observedSignal = init?.signal ?? null;
        return {
          ok: true,
          headers: { get: () => 'text/event-stream' },
          body: {
            getReader() {
              return {
                read() {
                  return new Promise((_resolve, reject) => {
                    const rejectAsAborted = () => {
                      reject(Object.assign(new Error('aborted while reading stream'), { name: 'AbortError' }));
                    };
                    if (observedSignal?.aborted) rejectAsAborted();
                    else observedSignal?.addEventListener('abort', rejectAsAborted, { once: true });
                  });
                }
              };
            }
          }
        };
      };

      const client = new AIClient();
      client.configure({
        backend,
        apiUrl: backend === 'claude'
          ? 'https://api.anthropic.test/v1'
          : 'https://api.openai.test/v1',
        apiKey: 'probe',
        model: 'probe',
        useProxy: false
      });
      const streamResult = client.chatStream(
        [{ role: 'user', content: 'probe' }],
        { timeout: 20, maxRetries: 0 },
        () => {}
      ).then(() => 'resolved', (error) => `${error.name}:${error.message}`);
      const outcome = await Promise.race([
        streamResult,
        new Promise((resolve) => setTimeout(() => resolve('still-pending'), 250))
      ]);

      client.cancel();
      await streamResult;
      assert.ok(observedSignal, `${backend} fetch should receive an AbortSignal`);
      assert.equal(outcome, 'still-pending', `${backend} stream should not auto-time out`);
      assert.equal(observedSignal.aborted, true, `${backend} manual cancellation should abort the active stream read`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('cancelling a direct stream aborts immediately without retrying', async () => {
  const originalFetch = globalThis.fetch;

  try {
    for (const backend of ['openai', 'claude']) {
      let fetchCalls = 0;
      let startReading;
      let readCount = 0;
      const reading = new Promise((resolve) => { startReading = resolve; });
      globalThis.fetch = async (_url, init) => {
        fetchCalls++;
        const signal = init?.signal;
        return {
          ok: true,
          headers: { get: () => 'text/event-stream' },
          body: {
            getReader() {
              return {
                read() {
                  if (readCount++ === 0) {
                    const event = backend === 'claude'
                      ? { type: 'content_block_delta', delta: { text: 'partial' } }
                      : { choices: [{ delta: { content: 'partial' } }] };
                    return Promise.resolve({
                      done: false,
                      value: new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
                    });
                  }
                  startReading();
                  return new Promise((_resolve, reject) => {
                    const rejectAsAborted = () => {
                      reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
                    };
                    if (signal?.aborted) rejectAsAborted();
                    else signal?.addEventListener('abort', rejectAsAborted, { once: true });
                  });
                }
              };
            }
          }
        };
      };

      const client = new AIClient();
      client.configure({
        backend,
        apiUrl: 'https://api.example.test/v1',
        apiKey: 'probe',
        model: 'probe',
        useProxy: false
      });
      const streamResult = client.chatStream(
        [{ role: 'user', content: 'probe' }],
        { timeout: 5000, maxRetries: 2, retryDelay: 10 },
        () => {}
      ).then(() => 'resolved', (error) => `${error.name}:${error.message}`);

      await reading;
      client.cancel();
      const outcome = await streamResult;
      assert.equal(fetchCalls, 1, `${backend} cancellation should not start another request`);
      assert.match(String(outcome), /abort|cancel/i);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('cancelling a bodyless stream also aborts its non-stream fallback', async () => {
  const originalFetch = globalThis.fetch;

  try {
    for (const backend of ['openai', 'claude']) {
      let fetchCalls = 0;
      let fallbackStarted;
      const fallbackReading = new Promise((resolve) => { fallbackStarted = resolve; });
      globalThis.fetch = async (_url, init) => {
        fetchCalls++;
        if (fetchCalls === 1) {
          return {
            ok: true,
            headers: { get: () => 'text/event-stream' },
            body: null
          };
        }

        fallbackStarted();
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          const rejectAsAborted = () => {
            reject(Object.assign(new Error('fallback cancelled'), { name: 'AbortError' }));
          };
          if (signal?.aborted) rejectAsAborted();
          else signal?.addEventListener('abort', rejectAsAborted, { once: true });
        });
      };

      const client = new AIClient();
      client.configure({
        backend,
        apiUrl: 'https://api.example.test/v1',
        apiKey: 'probe',
        model: 'probe',
        useProxy: false
      });
      const streamResult = client.chatStream(
        [{ role: 'user', content: 'probe' }],
        { timeout: 100, maxRetries: 0 },
        () => {}
      ).then(() => 'resolved', (error) => `${error.name}:${error.message}`);

      await fallbackReading;
      client.cancel();
      const outcome = await Promise.race([
        streamResult,
        new Promise((resolve) => setTimeout(() => resolve('still-pending'), 40))
      ]);
      assert.equal(fetchCalls, 2, `${backend} should make exactly one fallback request`);
      assert.notEqual(outcome, 'still-pending', `${backend} fallback ignored cancellation`);
      assert.match(String(outcome), /abort|cancel|取消/i);
      await streamResult;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('cancelling during retry backoff stops before another request', async () => {
  const originalFetch = globalThis.fetch;

  try {
    for (const backend of ['openai', 'claude']) {
      let fetchCalls = 0;
      let firstAttemptStarted;
      const firstAttempt = new Promise((resolve) => { firstAttemptStarted = resolve; });
      globalThis.fetch = async () => {
        fetchCalls++;
        firstAttemptStarted();
        return {
          ok: false,
          status: 500,
          text: async () => 'temporary upstream failure',
          headers: { get: () => 'application/json' }
        };
      };

      const client = new AIClient();
      client.configure({
        backend,
        apiUrl: 'https://api.example.test/v1',
        apiKey: 'probe',
        model: 'probe',
        useProxy: false
      });
      const streamResult = client.chatStream(
        [{ role: 'user', content: 'probe' }],
        { timeout: 5000, maxRetries: 2, retryDelay: 200 },
        () => {}
      ).then(() => 'resolved', (error) => `${error.name}:${error.message}`);

      await firstAttempt;
      await new Promise((resolve) => setTimeout(resolve, 20));
      client.cancel();
      const outcome = await Promise.race([
        streamResult,
        new Promise((resolve) => setTimeout(() => resolve('still-pending'), 80))
      ]);
      assert.notEqual(outcome, 'still-pending', `${backend} cancellation waited through retry backoff`);
      assert.equal(fetchCalls, 1, `${backend} started a retry after cancellation`);
      assert.match(String(outcome), /abort|cancel|取消/i);
      await streamResult;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('AI narrative style blocks are discarded without touching document.head', () => withCustomElementGlobals(async () => {
  const { appShell } = await import('../js/ui/app-shell.js');
  const originalDocument = globalThis.document;
  const originalElement = appShell.element;
  const appendedStyles = [];
  const renderedStyle = {
    textContent: 'body{display:none}',
    cloneNode() { return { textContent: this.textContent }; }
  };

  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'style');
      return {
        dataset: {},
        textContent: '',
        get outerHTML() {
          return `<style data-dynamic-style="">${this.textContent}</style>`;
        }
      };
    },
    head: {
      appendChild(style) { appendedStyles.push(style.textContent); }
    }
  };
  appShell.element = {
    querySelector(selector) {
      return selector === '.preset-styles style' ? renderedStyle : null;
    }
  };

  try {
    const first = appShell._renderMarkdown('正文前<style>body{display:none}</style>正文后');
    const second = appShell._renderMarkdown('另一段<STYLE>.app-shell{visibility:hidden}</STYLE>正文');
    const inline = appShell._renderMarkdown('<div style="position:fixed;inset:0;z-index:99999">遮罩</div>');
    const classBypass = appShell._renderMarkdown('<div class="modal-overlay">遮罩</div>');
    await new Promise((resolve) => queueMicrotask(resolve));

    assert.match(first, /正文前.*正文后/);
    assert.match(second, /另一段.*正文/);
    assert.doesNotMatch(first + second, /preset-styles|data-dynamic-style|display:none|visibility:hidden/i);
    assert.doesNotMatch(inline, /position:fixed|z-index:99999|<div\s+style=/i);
    assert.doesNotMatch(classBypass, /class=["']modal-overlay["']/i);
    assert.deepEqual(appendedStyles, []);
  } finally {
    appShell.element = originalElement;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}));

await test('welcome privacy copy accurately describes stateless proxying', () => {
  const source = fs.readFileSync(new URL('../js/utils/help-guide.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /不会上传到任何服务器/);
  assert.match(source, /无状态代理/);
});

console.log(`\n${passed} security regression tests passed.`);
