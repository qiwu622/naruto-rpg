import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { startCloudSaveTestServer } from './helpers/cloud-save-test-server.mjs';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';
import { AuthClient } from '../js/core/auth-client.js';
import { CloudSaveClient } from '../js/core/cloud-save.js';
import { fetchProjectServer, enableCloudConnection, getCloudConnection } from '../js/core/project-server.js';
import { eventBus } from '../js/core/event-bus.js';
import { decodeTimelineSaveFile } from '../js/core/timeline-file-codec.js';

const server = await startCloudSaveTestServer();
const { createAppLinkRouter } = await import('../server/auth/app-link.js');
const { default: discord } = await import('../server/auth/discord.js');
let clock = Date.now();
server.app.use('/auth/app', express.json({ limit: '4kb' }), express.urlencoded({ extended: false }), createAppLinkRouter({ now: () => clock }));
server.app.use('/auth', discord);
let passed = 0;
const ok = label => { passed++; console.log(`PASS ${label}`); };
const post = (path, data, cookie = '') => fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
const cookie = 'naruto_token=' + server.tokens['cloud-test-a'];
const start = async () => {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { ...(await (await post('/auth/app/start', { challenge })).json()), verifier };
};
const approve = async (link, decision = 'approve') => {
  const response = await fetch(server.url + link.verification_path, { headers: { Cookie: cookie } });
  const html = await response.text();
  assert.match(html, /连接此 App/);
  assert.match(html, new RegExp(link.user_code));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  assert.equal((await post('/auth/app/approve', { code: link.user_code, csrf: '错'.repeat(64), decision }, cookie)).status, 403);
  assert.equal((await post('/auth/app/approve', { code: link.user_code, csrf, decision })).status, 401);
  assert.equal((await post('/auth/app/approve', { code: link.user_code, csrf, decision }, cookie)).status, 200);
};
const savedGlobals = { Capacitor: globalThis.Capacitor, localStorage: globalThis.localStorage };
try {
  const link = await start();
  assert.equal((await post('/auth/app/start', { challenge: 'bad' })).status, 400);
  assert.equal((await post('/auth/app/poll', { device_code: link.device_code, verifier: randomBytes(48).toString('base64url') })).status, 403);
  assert.equal((await post('/auth/app/poll', { device_code: link.device_code, verifier: link.verifier })).status, 202);
  const anonymous = await fetch(server.url + link.verification_path, { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/auth/discord?app_code=' + link.user_code);
  const oauth = await fetch(server.url + anonymous.headers.get('location'), { redirect: 'manual' });
  assert.match(oauth.headers.get('set-cookie'), /discord_oauth_app_code=/);
  assert.ok(!oauth.headers.get('location').includes(link.verifier));
  await approve(link);
  const exchanged = await post('/auth/app/poll', { device_code: link.device_code, verifier: link.verifier });
  assert.equal(exchanged.status, 200);
  const credential = await exchanged.json();
  assert.equal(credential.user.id, 'cloud-test-a');
  assert.equal((await post('/auth/app/poll', { device_code: link.device_code, verifier: link.verifier })).status, 410);
  assert.equal((await fetch(server.url + '/api/saves', { headers: { Authorization: 'Bearer ' + credential.token } })).status, 200);
  ok('browser authorization needs explicit consent and CSRF; verifier-bound one-use exchange reuses the existing account and API');

  const declined = await start(); await approve(declined, 'decline');
  assert.equal((await post('/auth/app/poll', { device_code: declined.device_code, verifier: declined.verifier })).status, 403);
  const expired = await start(); clock += 11 * 60 * 1000;
  assert.equal((await post('/auth/app/poll', { device_code: expired.device_code, verifier: expired.verifier })).status, 410);
  clock = Date.now();
  const banned = await start(); await approve(banned);
  await server.db.banUser('cloud-test-a', 'App link regression');
  assert.equal((await post('/auth/app/poll', { device_code: banned.device_code, verifier: banned.verifier })).status, 403);
  await server.db.unbanUser('cloud-test-a');
  ok('declined, expired, already exchanged and newly banned account requests cannot create an App session');

  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  let session = null, mode = 'normal', cancellations = 0, loginCode;
  const bodies = new Map(), requests = [], nativePending = new Map();
  const plugin = {
    async beginCloudBody() { const id = randomBytes(8).toString('hex'); bodies.set(id, []); return { id }; },
    async appendCloudBody({ id, data }) { bodies.get(id).push(Buffer.from(data, 'base64')); },
    async discardCloudBody({ id }) { bodies.delete(id); },
    async cancel({ id }) { cancellations++; nativePending.get(id)?.abort(); },
    async request(options, callback) {
      requests.push(options);
      if (mode === 'offline') throw new Error('fixture offline');
      if (mode === 'hang') { callback({ type: 'headers', status: 200, headers: {} }); return; }
      assert.equal(options.cloud, true);
      assert.match(options.url, /^https:\/\/www\.qiwu\.asia\/(auth|api)\//);
      const controller = new AbortController(); nativePending.set(options.id, controller);
      try {
        const body = options.bodyId ? Buffer.concat(bodies.get(options.bodyId)) : options.body;
        const headers = { ...options.headers, ...(!options.anonymous && session ? { Authorization: 'Bearer ' + session.token } : {}) };
        const result = await fetch(options.url.replace('https://www.qiwu.asia', server.url), { method: options.method, body, headers, signal: controller.signal });
        callback({ type: 'headers', status: result.status, url: options.url, headers: Object.fromEntries(result.headers.entries()) });
        const bytes = new Uint8Array(await result.arrayBuffer());
        if (bytes.length) callback({ type: 'data', data: Buffer.from(bytes).toString('base64') });
        callback({ type: 'end' });
      } finally { nativePending.delete(options.id); }
    }
  };
  globalThis.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: {
    NarutoHttp: plugin,
    NarutoCloud: { async getSession() { return { user: session?.user || null }; }, async storeSession(data) { session = data; },
      async clearSession() { session = null; }, async openLogin({ code }) { loginCode = code; } }
  } };
  const auth = new AuthClient();
  assert.equal(await auth.checkAuth(), null); assert.equal(requests.length, 0);
  const appLogin = await auth.beginAppLogin();
  assert.equal(loginCode, appLogin.code);
  assert.equal(await auth.pollAppLogin(), null);
  await approve({ verification_path: `/auth/app/authorize?code=${appLogin.code}`, user_code: appLogin.code });
  assert.equal((await auth.pollAppLogin()).id, 'cloud-test-a');
  assert.equal((await new AuthClient().checkAuth()).id, 'cloud-test-a');
  assert.equal(values.size, 0, 'no session tokens in browser localStorage or game saves');
  ok('Android login opens the browser, completes polling, persists through native session storage and restores without redirecting the bundled game');

  const cloud = new CloudSaveClient({ auth });
  cloud.setSyncContext({ userId: 'cloud-test-a', saveKey: 'native-fixture' });
  const fixture = makeContinuationFixture(6);
  const saved = await cloud.uploadSave('App 完整档', fixture);
  assert.ok(requests.some(request => request.bodyId && request.headers['content-type'].includes('multipart/form-data')));
  assert.equal(bodies.size, 0);
  assert.deepEqual(await decodeTimelineSaveFile(await cloud.downloadSave(saved.id)), fixture);
  await cloud.renameSave(saved.id, 'App 改名');
  assert.equal((await cloud.listSaves())[0].slot_name, 'App 改名');
  await cloud.deleteSave(saved.id);
  assert.equal((await cloud.listSaves()).length, 0);
  ok('shared gzip multipart upload, binary download, metadata rename and delete work over the native cloud transport');

  mode = 'offline';
  let readyEvents = 0; const stopReady = eventBus.on('auth:cloud-ready', () => readyEvents++);
  let changed = 0; const stop = eventBus.on('auth:changed', () => changed++);
  assert.equal((await auth.checkAuth(true)).id, 'cloud-test-a');
  assert.ok(auth.getCloudError()); assert.equal(changed, 0);
  cloud.markLocalSaved();
  await assert.rejects(cloud.scheduleQuickSave('App 备份', () => ({ saveData: fixture })), /本地|网络/);
  assert.equal(cloud.getSyncState().status, 'retry');
  assert.equal(cloud.getSyncState().canRetry, true);
  mode = 'normal'; await cloud.retrySync();
  assert.equal(readyEvents, 1, 'recovery announces cloud availability once, without an upload/auth feedback loop');
  assert.equal(cloud.getSyncState().status, 'synced');
  stop();
  stopReady();
  ok('a disconnected account stays bound; failed uploads keep local progress and successfully retry after recovery');

  mode = 'hang';
  await assert.rejects(fetchProjectServer('/auth/me', { timeoutMs: 20 }), error => error.code === 'CLOUD_TIMEOUT');
  assert.ok(cancellations > 0); assert.equal(getCloudConnection().status, 'offline');
  mode = 'normal';
  const beforePause = requests.length;
  enableCloudConnection(false);
  await assert.rejects(fetchProjectServer('/api/saves'), error => error.code === 'CLOUD_PAUSED');
  assert.equal(requests.length, beforePause);
  enableCloudConnection(true);
  await assert.rejects(fetchProjectServer('//evil.example/api/saves'), /地址无效/);
  await auth.logout(); assert.equal(session, null); assert.equal(auth.getUser(), null);
  ok('body stalls time out and cancel native work; pause makes no cloud requests and logout never navigates away or clears game data');
} finally {
  for (const [key, value] of Object.entries(savedGlobals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  await server.close();
}
console.log(`App cloud regression: ${passed} groups passed`);
