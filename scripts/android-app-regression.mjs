#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  getRuntimePlatform,
  isNativeAndroidApp,
  isMultiplayerEntryVisible,
  usesProjectServerFeatures
} from '../js/core/runtime-platform.js';
import {
  ANDROID_APP_DOWNLOAD_URL,
  ANDROID_APP_VERSION,
  ANDROID_APP_VERSION_CODE,
  ANDROID_UPDATE_MANIFEST_URL,
  AndroidAppUpdateService,
  normalizeAndroidUpdateManifest
} from '../js/core/app-update.js';
import { MusicService, parseAllowedMusicStreamUrl } from '../js/core/music-service.js';
import { resolveImageTransport } from '../js/core/image-studio/transport.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

const previousCapacitor = globalThis.Capacitor;
globalThis.Capacitor = {
  getPlatform: () => 'android',
  isNativePlatform: () => true
};
assert.equal(getRuntimePlatform(), 'android');
assert.equal(isNativeAndroidApp(), true);
assert.equal(isMultiplayerEntryVisible(), true, 'the shared multiplayer entry is enabled');
assert.equal(usesProjectServerFeatures(), true, 'Android can optionally connect to the existing cloud service');
assert.equal(
  resolveImageTransport('https://images.example.test/v1').route,
  'native-direct',
  'Android image providers must bypass the project server proxy'
);

const manifest = normalizeAndroidUpdateManifest({
  platform: 'android',
  version: '3.6.0',
  versionCode: 30600,
  apkUrl: ANDROID_APP_DOWNLOAD_URL
});
assert.equal(manifest.versionCode, 30600);
assert.throws(() => normalizeAndroidUpdateManifest({
  version: '3.6.0', versionCode: 30600, apkUrl: 'https://evil.example/app.apk'
}), /下载链接无效/);

const storage = memoryStorage();
const updateRequests = [];
const updates = new AndroidAppUpdateService({
  storage,
  nativeCheck: () => true,
  async fetchImpl(url, options) {
    updateRequests.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          platform: 'android', version: '99.0.0-test', versionCode: ANDROID_APP_VERSION_CODE + 1,
          apkUrl: ANDROID_APP_DOWNLOAD_URL
        };
      }
    };
  }
});
const update = await updates.check();
assert.equal(update.updateAvailable, true);
assert.equal(update.downloadUrl, ANDROID_APP_DOWNLOAD_URL);
assert.equal(updateRequests[0].url, ANDROID_UPDATE_MANIFEST_URL);
assert.equal(updateRequests[0].options.cache, 'no-store');
assert.equal(updates.hasKnownUpdate(), true);
assert.equal(updates.shouldPromptAutomatically(), true);
updates.snoozeAutomaticPrompt();
assert.equal(updates.shouldPromptAutomatically(), false, 'later postpones this version, not every future update');
assert.equal(
  new AndroidAppUpdateService({ storage, nativeCheck: () => true }).hasKnownUpdate(),
  true,
  'the personal-center update dot survives an app restart'
);

const musicRequests = [];
const music = new MusicService({
  nativeCheck: () => true,
  async fetchImpl(url) {
    musicRequests.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 200, data: { url: 'http://ws.stream.qqmusic.qq.com/song.mp3?vkey=signed' } };
      }
    };
  }
});
music.rememberTrack({ mid: 'track-001', name: '青鸟', provider: 'tencent' });
assert.equal(
  await music.resolveStreamUrl('track-001'),
  'http://ws.stream.qqmusic.qq.com/song.mp3?vkey=signed'
);
assert.match(musicRequests[0], /^https:\/\/api\.vkeys\.cn\/v2\/music\/tencent\?mid=track-001$/);
assert.equal(
  parseAllowedMusicStreamUrl('https://dl.stream.qqmusic.qq.com/song.flac'),
  'https://dl.stream.qqmusic.qq.com/song.flac'
);
assert.throws(
  () => parseAllowedMusicStreamUrl('https://stream.qqmusic.qq.com.evil.example/song.mp3'),
  /允许的音乐域名/
);

if (previousCapacitor === undefined) delete globalThis.Capacitor;
else globalThis.Capacitor = previousCapacitor;
assert.equal(isMultiplayerEntryVisible(), true, 'multiplayer remains available on the website');

const releaseManifest = JSON.parse(fs.readFileSync(new URL('../app/android/update.json', import.meta.url), 'utf8'));
assert.equal(releaseManifest.version, ANDROID_APP_VERSION);
assert.equal(releaseManifest.versionCode, ANDROID_APP_VERSION_CODE);
assert.equal(releaseManifest.apkUrl, ANDROID_APP_DOWNLOAD_URL);

const gradle = fs.readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
assert.match(gradle, new RegExp(`versionCode\\s+${ANDROID_APP_VERSION_CODE}\\b`));
assert.match(gradle, new RegExp(`versionName\\s+"${ANDROID_APP_VERSION.replaceAll('.', '\\.') }"`));

const appSource = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const shellSource = fs.readFileSync(new URL('../js/ui/app-shell.js', import.meta.url), 'utf8');
const settingsSource = fs.readFileSync(new URL('../js/ui/settings-panel.js', import.meta.url), 'utf8');
const agentSource = fs.readFileSync(new URL('./vendor/agent-sdk-entry.js', import.meta.url), 'utf8');
assert.match(appSource, /usesProjectServerFeatures\(\).*localStorage\.getItem\('naruto_auto_cloud_sync'/s);
assert.match(shellSource, /multiplayerEntryVisible \? '<button class="topbar-btn topbar-btn--multiplayer"/);
assert.match(settingsSource, /usesProjectServerFeatures\(\).*_syncFavoritesFromServer/s);
assert.match(agentSource, /isNativeAndroidApp\(\)[\s\S]*directFetch/);

console.log('PASS Android App runtime, optional cloud, direct AI/music, download and update contracts');
