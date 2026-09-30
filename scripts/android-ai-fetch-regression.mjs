import assert from 'node:assert/strict';
import { fetchAI } from '../js/core/native-ai-fetch.js';
import { AIClient } from '../js/core/ai-client.js';

const previous = { capacitor: globalThis.Capacitor, fetch: globalThis.fetch };
const calls = [], cancelled = [];
const plugin = {
  request(options, callback) { calls.push({ ...options, callback }); return Promise.resolve(options.id); },
  cancel({ id }) { cancelled.push(id); return Promise.resolve(); }
};
globalThis.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true,
  registerPlugin(name) { assert.equal(name, 'NarutoHttp'); return plugin; } };
const tick = () => new Promise(resolve => setImmediate(resolve));
const start = async init => {
  const promise = fetchAI('https://model.example.test/v1/chat/completions', init);
  await tick();
  return { promise, call: calls.at(-1) };
};
const headers = (call, status = 200) => call.callback({ type: 'headers', status,
  headers: { 'Content-Type': 'text/event-stream' }, url: call.url });
const bytes = (call, value) => call.callback({ type: 'data', data: Buffer.from(value).toString('base64') });
const end = call => call.callback({ type: 'end' });
try {
  {
    const { promise, call } = await start({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"正文":"火影"}' });
    headers(call);
    const response = await promise;
    assert.equal(response.url, call.url);
    assert.equal(call.body, '{"正文":"火影"}');
    const reader = response.body.getReader();
    const first = reader.read();
    bytes(call, '第一段');
    assert.equal(new TextDecoder().decode((await first).value), '第一段');
    let finished = false;
    const next = reader.read().then(value => { finished = true; return value; });
    await tick(); assert.equal(finished, false, 'response must remain live before the native stream ends');
    end(call); assert.equal((await next).done, true);
    console.log('PASS headers and first Unicode bytes arrive before EOF');
  }
  {
    const controller = new AbortController();
    const { promise, call } = await start({ method: 'POST', body: '{}', signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, error => error.name === 'AbortError');
    assert.equal(cancelled.at(-1), call.id);
    headers(call); bytes(call, 'late'); end(call);
    const count = calls.length;
    await assert.rejects(fetchAI('https://model.example.test', { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(calls.length, count, 'pre-aborted calls never start native network work');
    console.log('PASS cancellation before headers and pre-aborted requests');
  }
  {
    const controller = new AbortController();
    const { promise, call } = await start({ signal: controller.signal });
    headers(call); const response = await promise;
    const reading = response.body.getReader().read(); controller.abort();
    await assert.rejects(reading, error => error.name === 'AbortError');
    assert.equal(cancelled.at(-1), call.id);
    end(call);
    console.log('PASS stopping generation aborts a pending body read');
  }
  {
    const { promise, call } = await start();
    headers(call, 401); bytes(call, '{"error":{"message":"invalid key"}}'); end(call);
    const response = await promise;
    assert.equal(response.ok, false); assert.equal((await response.json()).error.message, 'invalid key');
    const empty = await start(); headers(empty.call, 204); end(empty.call);
    assert.equal(await (await empty.promise).text(), '');
    const failed = await start(); failed.call.callback(null, { message: 'TLS failed', code: 'HTTP_FAILED' });
    await assert.rejects(failed.promise, /TLS failed/);
    console.log('PASS HTTP errors, empty responses and transport failures retain fetch semantics');
  }
  {
    const { promise, call } = await start(); headers(call);
    const response = await promise; await response.body.cancel();
    assert.equal(cancelled.at(-1), call.id);
    bytes(call, 'late'); end(call);
    console.log('PASS cancelling a response body closes the native request');
  }
  {
    const client = new AIClient(); client.configure({ backend: 'openai', apiUrl: 'https://model.example.test/v1', apiKey: 'fixture-key', model: 'fixture' });
    const chunks = [];
    let completed = false;
    const result = client.chatStream([{ role: 'user', content: '开局' }], { maxRetries: 0, timeout: 0 }, chunk => chunks.push(chunk));
    result.then(() => { completed = true; });
    await tick(); const call = calls.at(-1); headers(call);
    assert.equal(call.headers.authorization, 'Bearer fixture-key');
    const content = Buffer.from('data: {"choices":[{"delta":{"content":"清晨，木叶。"}}]}\n\n');
    for (let i = 0; i < content.length; i += 7) bytes(call, content.subarray(i, i + 7));
    await tick(); assert.equal(chunks.join(''), '清晨，木叶。'); assert.equal(completed, false);
    bytes(call, 'data: [DONE]\n\n'); end(call);
    assert.equal(await result, '清晨，木叶。');
    console.log('PASS the existing AI client and SSE parser stream split UTF-8 bytes without changes');
  }
  delete globalThis.Capacitor;
  let delegated;
  globalThis.fetch = (input, init) => { delegated = { input, init }; return Promise.resolve('web-response'); };
  const options = { method: 'POST', body: '{}' };
  assert.equal(await fetchAI('/api/ai-proxy', options), 'web-response');
  assert.deepEqual(delegated, { input: '/api/ai-proxy', init: options });
  console.log('PASS web calls continue through the existing fetch/proxy');
} finally {
  if (previous.capacitor === undefined) delete globalThis.Capacitor; else globalThis.Capacitor = previous.capacitor;
  globalThis.fetch = previous.fetch;
}
console.log('Android AI fetch regression: 7 groups passed');
