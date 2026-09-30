import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';

import * as aiProxyModule from '../server/api/ai-proxy.js';
import * as serverConfigModule from '../server/config.js';
import { createResponseCompression } from '../server/middleware/response-compression.js';

const { forwardStreamingResponse, validateTargetUrl } = aiProxyModule;

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function runStreamingProbe() {
  const app = express();
  app.use(createResponseCompression());

  let streamCompleted = false;
  let legacyStreamCompleted = false;
  const proxyRouter = express.Router();
  proxyRouter.get('/', async (_req, res) => {
    const upstream = Readable.from((async function* delayedSseChunks() {
      for (let index = 1; index <= 4; index++) {
        yield Buffer.from(`data: {"index":${index}}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    })());
    await forwardStreamingResponse(upstream, res);
    streamCompleted = true;
  });
  proxyRouter.get('/legacy-stream', async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    for (let index = 1; index <= 4; index++) {
      res.write(`data: {"index":${index},"padding":"${'x'.repeat(512)}"}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    legacyStreamCompleted = true;
    res.end();
  });
  app.use('/api/ai-proxy', proxyRouter);
  app.get('/compressed-probe', (_req, res) => {
    res.type('text/plain').send('x'.repeat(4096));
  });

  const port = await getFreePort();
  const server = app.listen(port, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai-proxy`, {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.match(response.headers.get('cache-control') || '', /no-transform/);

    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(streamCompleted, false, 'first SSE chunk arrived only after the stream completed');

    let readCount = 1;
    while (true) {
      const { done } = await reader.read();
      if (done) break;
      readCount++;
    }
    assert.ok(readCount >= 2, `expected incremental body reads, received ${readCount}`);
    assert.equal(streamCompleted, true);

    const legacyResponse = await fetch(`http://127.0.0.1:${port}/api/ai-proxy/legacy-stream`, {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.equal(legacyResponse.headers.get('content-encoding'), null);
    const legacyReader = legacyResponse.body.getReader();
    const legacyFirst = await legacyReader.read();
    assert.equal(legacyFirst.done, false);
    assert.equal(legacyStreamCompleted, false, 'mounted legacy SSE was buffered until completion');
    while (!(await legacyReader.read()).done) {}
    assert.equal(legacyStreamCompleted, true);

    const compressed = await fetch(`http://127.0.0.1:${port}/compressed-probe`, {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.equal(compressed.headers.get('content-encoding'), 'gzip');
    await compressed.text();
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const port = await getFreePort();
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'naruto-server-regression-'));
const syntheticJwt = 'SYNTHETIC_JWT_SHOULD_NOT_BE_LOGGED';
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'development',
    AUTH_BYPASS: 'true',
    ADMIN_KEY: 'server-regression-admin-key',
    TRUST_PROXY: '',
    AI_PROXY_ALLOW_HTTP_TARGETS: '',
    MAX_SAVE_SLOTS: '1',
    MAX_SAVE_PREVIEW_SIZE_KB: '64',
    DATA_DIR: dataDir
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdout.resume();

const failures = [];
let passed = 0;
let createdSaveId = null;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(new Error(`${name}: ${error.message}`));
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

try {
  await waitForServer(`http://127.0.0.1:${port}/login.html`);

  await check('AI proxy SSE bypasses compression and arrives incrementally', runStreamingProbe);

  await check('AI proxy fake-IP allowance is DNS-only and preserves validated addresses', async () => {
    const fakeAddresses = [{ address: '198.18.1.104', family: 4 }];
    let lookupCalls = 0;
    const fakeLookup = async (hostname, options) => {
      lookupCalls++;
      assert.equal(hostname, 'images.example.test');
      assert.deepEqual(options, { all: true, verbatim: true });
      return fakeAddresses;
    };

    const blocked = await validateTargetUrl('https://images.example.test/v1/models', {
      lookupImpl: fakeLookup,
      allowFakeIpDns: false
    });
    assert.equal(blocked.errorStatus, 403);

    const allowed = await validateTargetUrl('https://images.example.test/v1/models', {
      lookupImpl: fakeLookup,
      allowFakeIpDns: true
    });
    assert.equal(allowed.url.href, 'https://images.example.test/v1/models');
    assert.deepEqual(allowed.addresses, fakeAddresses);
    assert.equal(lookupCalls, 2);

    let directLookupCalled = false;
    const direct = await validateTargetUrl('https://198.18.1.104/v1/models', {
      lookupImpl: async () => {
        directLookupCalled = true;
        return fakeAddresses;
      },
      allowFakeIpDns: true
    });
    assert.equal(direct.errorStatus, 403);
    assert.equal(directLookupCalled, false);

    const privateDns = await validateTargetUrl('https://images.example.test/v1/models', {
      lookupImpl: async () => [{ address: '192.168.1.20', family: 4 }],
      allowFakeIpDns: true
    });
    assert.equal(privateDns.errorStatus, 403);
  });

  await check('AI proxy plain-HTTP upstream requires explicit domain allowlist', async () => {
    const publicAddresses = [{ address: '203.0.113.10', family: 4 }];
    const publicLookup = async () => publicAddresses;

    // 白名单命中（域名 + 端口）→ 放行 http，且仍走 DNS 校验
    const allowed = await validateTargetUrl('http://new.fangxiaobai.store:8050/v1/models', {
      lookupImpl: publicLookup,
      allowHttpTargets: ['new.fangxiaobai.store:8050']
    });
    assert.equal(allowed.errorStatus, undefined);
    assert.equal(allowed.url.protocol, 'http:');
    assert.equal(allowed.url.href, 'http://new.fangxiaobai.store:8050/v1/models');
    assert.deepEqual(allowed.addresses, publicAddresses);

    // 域名命中但端口不匹配 → 拒绝
    const wrongPort = await validateTargetUrl('http://new.fangxiaobai.store:9000/v1/models', {
      lookupImpl: publicLookup,
      allowHttpTargets: ['new.fangxiaobai.store:8050']
    });
    assert.equal(wrongPort.errorStatus, 403);

    // 仅域名白名单（不带端口）→ 任意端口放行
    const anyPort = await validateTargetUrl('http://new.fangxiaobai.store:9000/v1/models', {
      lookupImpl: publicLookup,
      allowHttpTargets: ['new.fangxiaobai.store']
    });
    assert.equal(anyPort.errorStatus, undefined);

    // 未白名单 → 拒绝，且不得发起 DNS 查询
    let lookupCalls = 0;
    const blocked = await validateTargetUrl('http://blocked.example.test/v1/models', {
      lookupImpl: async () => { lookupCalls++; return publicAddresses; },
      allowHttpTargets: ['new.fangxiaobai.store:8050']
    });
    assert.equal(blocked.errorStatus, 403);
    assert.equal(lookupCalls, 0);

    // *. 通配子域（含 apex）
    const wildcard = await validateTargetUrl('http://api.new.fangxiaobai.store:8050/v1/models', {
      lookupImpl: publicLookup,
      allowHttpTargets: ['*.new.fangxiaobai.store:8050']
    });
    assert.equal(wildcard.errorStatus, undefined);

    // 未配置白名单（null）→ http 一律拒绝
    const noAllowlist = await validateTargetUrl('http://new.fangxiaobai.store:8050/v1/models', {
      lookupImpl: publicLookup,
      allowHttpTargets: null
    });
    assert.equal(noAllowlist.errorStatus, 403);

    // https 目标不受白名单影响
    const httpsTarget = await validateTargetUrl('https://new.fangxiaobai.store:8050/v1/models', {
      lookupImpl: publicLookup,
      allowHttpTargets: null
    });
    assert.equal(httpsTarget.errorStatus, undefined);
    assert.equal(httpsTarget.url.protocol, 'https:');
  });

  await check('AI proxy plain-HTTP allowlist parses domain[:port] entries', () => {
    const resolve = serverConfigModule.resolveAiProxyAllowHttpTargets;
    assert.equal(typeof resolve, 'function');
    assert.equal(resolve({}), null);
    assert.equal(resolve({ AI_PROXY_ALLOW_HTTP_TARGETS: '' }), null);
    assert.equal(resolve({ AI_PROXY_ALLOW_HTTP_TARGETS: '  , ' }), null);
    assert.deepEqual(resolve({ AI_PROXY_ALLOW_HTTP_TARGETS: ' new.fangxiaobai.store:8050 , *.Example.COM ' }), ['new.fangxiaobai.store:8050', '*.example.com']);
    assert.deepEqual(resolve({ AI_PROXY_ALLOW_HTTP_TARGETS: 'a.com,a.com' }), ['a.com']);
  });

  await check('AI proxy forward proxy agent is only created when configured and cached per URL', () => {
    const getProxyAgent = aiProxyModule.getProxyAgent;
    assert.equal(typeof getProxyAgent, 'function');
    // 未配置 AI_PROXY_FORWARD_URL → null（直连），与 Discord 的 PROXY_URL 无关
    assert.equal(getProxyAgent('https:', { aiForwardUrl: '' }), null);
    assert.equal(getProxyAgent('https:', { enabled: true, url: 'http://127.0.0.1:7890', aiForwardUrl: '' }), null);
    assert.equal(getProxyAgent('https:', {}), null);
    // 启用后按协议返回对应 Agent，且同一 URL 复用缓存
    const proxyConfig = { enabled: false, url: '', aiForwardUrl: 'http://127.0.0.1:7890' };
    const httpsAgent = getProxyAgent('https:', proxyConfig);
    const httpAgent = getProxyAgent('http:', proxyConfig);
    assert.ok(httpsAgent);
    assert.ok(httpAgent);
    assert.notEqual(httpsAgent, httpAgent);
    assert.equal(getProxyAgent('https:', proxyConfig), httpsAgent, 'https agent must be cached');
    assert.equal(getProxyAgent('http:', proxyConfig), httpAgent, 'http agent must be cached');
    // 换 URL 时重新创建
    const otherConfig = { enabled: true, url: 'http://127.0.0.1:8080', aiForwardUrl: 'http://127.0.0.1:8080' };
    assert.notEqual(getProxyAgent('https:', otherConfig), httpsAgent);
  });

  await check('AI proxy rejects plain-HTTP targets by default', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-target-url': 'http://public.example.test/v1/models'
      },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /HTTPS|https/i);
  });

  await check('AI proxy fake-IP defaults are environment-aware and explicitly overrideable', () => {
    assert.equal(typeof serverConfigModule.resolveAiProxyAllowFakeIpDns, 'function');
    const resolve = serverConfigModule.resolveAiProxyAllowFakeIpDns;
    assert.equal(resolve({ NODE_ENV: 'development' }), true);
    assert.equal(resolve({ NODE_ENV: 'production' }), false);
    assert.equal(resolve({ NODE_ENV: 'production', AI_PROXY_ALLOW_FAKE_IP_DNS: 'true' }), true);
    assert.equal(resolve({ NODE_ENV: 'development', AI_PROXY_ALLOW_FAKE_IP_DNS: 'false' }), false);
  });

  await check('AI proxy purpose policies isolate image timeout and response limits', () => {
    assert.equal(typeof aiProxyModule.resolveProxyPurposePolicy, 'function');
    const proxyConfig = {
      timeoutMs: 120000,
      maxResponseMb: 20,
      imageTimeoutMs: 300000,
      imageMaxResponseMb: 32
    };
    assert.deepEqual(aiProxyModule.resolveProxyPurposePolicy(undefined, proxyConfig), {
      purpose: 'generic', timeoutMs: 0, maxResponseMb: 20
    });
    assert.deepEqual(aiProxyModule.resolveProxyPurposePolicy('models', proxyConfig), {
      purpose: 'models', timeoutMs: 0, maxResponseMb: 20
    });
    assert.deepEqual(aiProxyModule.resolveProxyPurposePolicy('agent', proxyConfig), {
      purpose: 'agent', timeoutMs: 0, maxResponseMb: 20
    });
    assert.deepEqual(aiProxyModule.resolveProxyPurposePolicy('image-generation', proxyConfig), {
      purpose: 'image-generation', timeoutMs: 300000, maxResponseMb: 32
    });
    assert.deepEqual(aiProxyModule.resolveProxyPurposePolicy('image-download', proxyConfig), {
      purpose: 'image-download', timeoutMs: 300000, maxResponseMb: 32
    });
    assert.equal(aiProxyModule.resolveProxyPurposePolicy('arbitrary-egress', proxyConfig), null);
  });

  await check('AI proxy zero retry configuration sends a rate-limited request only once', async () => {
    const resolve = serverConfigModule.resolveAiProxyRetryMaxAttempts;
    assert.equal(typeof resolve, 'function');
    assert.equal(resolve({}), 2);
    assert.equal(resolve({ AI_PROXY_RETRY_MAX_ATTEMPTS: '' }), 2);
    assert.equal(resolve({ AI_PROXY_RETRY_MAX_ATTEMPTS: '-1' }), 2);
    assert.equal(resolve({ AI_PROXY_RETRY_MAX_ATTEMPTS: '1.5' }), 2);
    assert.equal(resolve({ AI_PROXY_RETRY_MAX_ATTEMPTS: ' 0 ' }), 0);
    assert.equal(resolve({ AI_PROXY_RETRY_MAX_ATTEMPTS: '3' }), 3);
    let calls = 0;
    const response = { statusCode: 429, headers: { 'retry-after': '0' }, destroy() {} };
    const result = await aiProxyModule.requestUpstreamWithRetry(async () => {
      calls += 1;
      return response;
    }, { maxAttempts: resolve({ AI_PROXY_RETRY_MAX_ATTEMPTS: '0' }) });
    assert.equal(result, response);
    assert.equal(calls, 1);
  });

  await check('AI proxy rejects invalid purpose without breaking legacy generic requests', async () => {
    const invalid = await fetch(`http://127.0.0.1:${port}/api/ai-proxy`, {
      headers: {
        'x-target-url': 'https://127.0.0.1/v1/models',
        'x-proxy-purpose': 'arbitrary-egress'
      }
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /purpose|用途/i);

    const legacy = await fetch(`http://127.0.0.1:${port}/api/ai-proxy`, {
      headers: { 'x-target-url': 'https://127.0.0.1/v1/models' }
    });
    assert.equal(legacy.status, 403);
  });

  await check('legacy music favorites route remains compatible', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/music/favorites`);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).favorites));
  });

  await check('music stream route rejects invalid track ids before outbound work', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/music/stream?mid=${encodeURIComponent('../metadata')}`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /曲目标识/);

    const removedProvider = await fetch(`http://127.0.0.1:${port}/api/music/stream?provider=kuwo&id=5757486`);
    assert.equal(removedProvider.status, 400);
    assert.match((await removedProvider.json()).error, /音乐来源/);

    const invalidProvider = await fetch(`http://127.0.0.1:${port}/api/music/stream?provider=custom&id=123`);
    assert.equal(invalidProvider.status, 400);
    assert.match((await invalidProvider.json()).error, /音乐来源/);
  });

  await check('malformed JSON returns 400', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{'
    });
    assert.equal(response.status, 400);
  });

  await check('invalid save slot name returns 400', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/saves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot_name: 123, save_data: {} })
    });
    assert.equal(response.status, 400);
  });

  await check('non-timeline cloud save payload returns 400', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/saves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot_name: '畸形存档', save_data: { foo: 'bar' } })
    });
    assert.equal(response.status, 400);
  });

  await check('cloud-save previews must be JSON objects', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/saves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slot_name: 'invalid-preview',
        preview_data: [],
        save_data: {
          nodes: [{ id: 'root', parent_id: null, children_ids: [], branch_id: 'main' }],
          branches: [{ id: 'main', head_node_id: 'root', diverged_from: null }],
          meta: { root_id: 'root', current_id: 'root', active_branch: 'main' }
        }
      })
    });
    const body = await response.json();
    if (response.status === 201) {
      await fetch(`http://127.0.0.1:${port}/api/saves/${body.id}`, { method: 'DELETE' });
    }

    assert.equal(response.status, 400);
    assert.match(body.error, /预览/);
  });

  await check('cloud-save previews have a bounded serialized size', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/saves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slot_name: 'oversized-preview',
        preview_data: { summary: 'x'.repeat(65 * 1024) },
        save_data: {
          nodes: [{ id: 'root', parent_id: null, children_ids: [], branch_id: 'main' }],
          branches: [{ id: 'main', head_node_id: 'root', diverged_from: null }],
          meta: { root_id: 'root', current_id: 'root', active_branch: 'main' }
        }
      })
    });
    const body = await response.json();
    if (response.status === 201) {
      await fetch(`http://127.0.0.1:${port}/api/saves/${body.id}`, { method: 'DELETE' });
    }

    assert.equal(response.status, 400);
    assert.match(body.error, /预览/);
  });

  await check('concurrent cloud-save creates cannot exceed the per-user slot limit', async () => {
    const saveData = {
      nodes: [{
        id: 'root',
        parent_id: null,
        children_ids: [],
        branch_id: 'main',
        state_snapshot: { _version: '5.0', regression_padding: 'x'.repeat(128 * 1024) }
      }],
      branches: [{ id: 'main', head_node_id: 'root', diverged_from: null }],
      meta: { root_id: 'root', current_id: 'root', active_branch: 'main' }
    };

    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(
      `http://127.0.0.1:${port}/api/saves`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot_name: `concurrent-${index}`, save_data: saveData })
      }
    )));

    const acceptedResponses = responses.filter((response) => response.status === 201);
    assert.equal(acceptedResponses.length, 1);
    createdSaveId = (await acceptedResponses[0].json()).id;
    const rejectedResponses = responses.filter((response) => response.status !== 201);
    assert.equal(rejectedResponses.length, 7);
    assert.equal(
      rejectedResponses.every((response) => response.status === 400 || response.status === 429),
      true
    );

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/saves`);
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json()).length, 1);

    const saveFiles = await fs.readdir(path.join(dataDir, 'saves'));
    assert.equal(saveFiles.filter((name) => name.endsWith('.bin')).length, 1);
  });

  await check('full cloud-save slots are rejected before expensive compression', async () => {
    const savesApiSource = await fs.readFile(new URL('../server/api/saves.js', import.meta.url), 'utf8');
    const preflightAt = savesApiSource.indexOf('await db.getUserSaveCount(userId)');
    const compressionAt = savesApiSource.indexOf('await gzip(jsonString)', preflightAt);
    const atomicInsertAt = savesApiSource.indexOf('await db.insertSaveWithinUserLimit', compressionAt);
    assert.ok(preflightAt >= 0, 'missing cheap slot-count preflight');
    assert.ok(compressionAt > preflightAt, 'slot preflight must run before gzip');
    assert.ok(atomicInsertAt > compressionAt, 'atomic slot check must remain the final write guard');
  });

  await check('cloud-save updates enforce the same preview bounds as creates', async () => {
    assert.ok(createdSaveId);
    const wrongType = await fetch(`http://127.0.0.1:${port}/api/saves/${createdSaveId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview_data: [] })
    });
    await wrongType.json();
    const oversized = await fetch(`http://127.0.0.1:${port}/api/saves/${createdSaveId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview_data: { summary: 'x'.repeat(65 * 1024) } })
    });

    assert.equal(wrongType.status, 400);
    assert.equal(oversized.status, 400);
  });

  await check('admin stats work without a login log file', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/stats`, {
      headers: { 'x-admin-key': 'server-regression-admin-key' }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.last7Days));
    assert.ok(Array.isArray(body.recentLogins));
  });

  await check('OAuth state mismatch redirects safely', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/auth/discord/callback?state=bad&code=fake`,
      {
        redirect: 'manual',
        headers: {
          Cookie: `naruto_token=${syntheticJwt}; discord_oauth_state=expected`
        }
      }
    );
    assert.equal(response.status, 302);
  });

  await check('direct deployments ignore spoofed X-Forwarded-For addresses for rate limits', async () => {
    const responses = [];
    for (let index = 1; index <= 20; index++) {
      responses.push(await fetch(`http://127.0.0.1:${port}/api/admin/stats`, {
        headers: {
          'x-admin-key': 'server-regression-admin-key',
          'x-forwarded-for': `198.51.100.${index}`
        }
      }));
    }

    assert.equal(responses[0].status, 200);
    assert.equal(responses.some((response) => response.status === 429), true);
  });
} finally {
  child.kill();
  if (child.exitCode == null) await once(child, 'exit');
  await fs.rm(dataDir, { recursive: true, force: true });
}

await check('OAuth diagnostics never log JWT cookies', () => {
  assert.equal(stderr.includes(syntheticJwt), false);
});

if (failures.length) {
  throw new AggregateError(failures, `${failures.length} server regression test(s) failed`);
}

console.log(`\n${passed} server regression tests passed.`);
