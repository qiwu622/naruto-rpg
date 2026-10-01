import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AndroidAppUpdateService, ANDROID_APP_DOWNLOAD_URL, formatAndroidUpdateMessage } from '../js/core/app-update.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 15));
const makeStorage = () => { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
const release = { version: '9.0.0', versionCode: 90000, apkUrl: ANDROID_APP_DOWNLOAD_URL, releaseNotes: ['设置滑动修复', '角色按需调用'], announcement: '覆盖安装，无需开新档', publishedAt: '2026-10-01' };
const response = () => ({ ok: true, json: async () => release });

test('concurrent checks share a request and preserve announcement data across restart', async () => {
  const storage = makeStorage();
  let calls = 0;
  const service = new AndroidAppUpdateService({ storage, nativeCheck: () => true, fetchImpl: async () => { calls++; await pause(); return response(); } });
  const results = await Promise.all([service.check(), service.check(), service.check()]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0].releaseNotes, release.releaseNotes);
  assert.match(formatAndroidUpdateMessage(results[0]), /更新内容[\s\S]*设置滑动修复[\s\S]*公告[\s\S]*覆盖安装/);
  assert.equal(new AndroidAppUpdateService({ storage }).getLastResult().announcement, release.announcement);
});

test('later reminders last one day for this version and do not disable future updates', async () => {
  const storage = makeStorage();
  storage.setItem('naruto_android_update_auto_prompt_disabled', 'true');
  let time = 1000;
  const service = new AndroidAppUpdateService({ storage, nativeCheck: () => true, now: () => time, fetchImpl: async () => response() });
  const result = await service.check();
  assert.equal(service.shouldPromptAutomatically(), true, 'legacy later button must not permanently hide updates');
  service.snoozeAutomaticPrompt();
  assert.equal(service.shouldPromptAutomatically(), false);
  assert.equal(service.shouldPromptAutomatically({ ...result, latestVersionCode: 90001 }), true);
  assert.equal((await service.check()).updateAvailable, true, 'manual check still works while snoozed');
  time += 24 * 60 * 60 * 1000;
  assert.equal(service.shouldPromptAutomatically(), true);
});

test('startup, foreground and network recovery check automatically with throttling and cleanup', async () => {
  const documentRef = new EventTarget(); documentRef.visibilityState = 'visible';
  const windowRef = new EventTarget();
  let time = 0, calls = 0;
  const delivered = [], errors = [];
  const service = new AndroidAppUpdateService({ nativeCheck: () => true, storage: makeStorage(), now: () => time,
    fetchImpl: async () => { if (++calls === 1) throw new Error('offline'); return response(); } });
  const stop = service.startAutomaticChecks({ documentRef, windowRef, onResult: value => delivered.push(value), onError: error => errors.push(error.message) });
  await pause(); assert.deepEqual(errors, ['offline']);
  windowRef.dispatchEvent(new Event('online'));
  await pause(); assert.equal(delivered.length, 1);
  documentRef.dispatchEvent(new Event('visibilitychange'));
  await pause(); assert.equal(calls, 2, 'quick switches do not repeat the request');
  time += 5 * 60 * 1000;
  documentRef.visibilityState = 'hidden';
  documentRef.dispatchEvent(new Event('visibilitychange'));
  await pause(); assert.equal(calls, 2);
  documentRef.visibilityState = 'visible';
  documentRef.dispatchEvent(new Event('visibilitychange'));
  await pause(); assert.equal(calls, 3);
  stop(); windowRef.dispatchEvent(new Event('online'));
  await pause(); assert.equal(calls, 3);
});

test('a hanging network check times out and permits the next retry', async () => {
  const service = new AndroidAppUpdateService({ nativeCheck: () => true, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(service.check(), /超时/);
  service.fetchImpl = async () => response();
  assert.equal((await service.check()).updateAvailable, true);
});

test('web and already current clients do not get upgrade notifications', async () => {
  const web = new AndroidAppUpdateService({ nativeCheck: () => false, fetchImpl: () => { throw new Error('web must not fetch'); } });
  assert.equal((await web.check()).supported, false);
  const current = new AndroidAppUpdateService({ nativeCheck: () => true, currentVersionCode: 90000, fetchImpl: async () => response() });
  assert.equal((await current.check()).updateAvailable, false);
  assert.equal(current.shouldPromptAutomatically(), false);
});
