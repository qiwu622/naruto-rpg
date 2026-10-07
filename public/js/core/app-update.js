import { isNativeAndroidApp } from './runtime-platform.js';
import { openAndroidDownload } from './file-export.js';

export const ANDROID_APP_VERSION = '3.6.0';
export const ANDROID_APP_VERSION_CODE = 30600;
export const ANDROID_UPDATE_MANIFEST_URL = 'https://www.qiwu.asia/app/android/update.json';
export const ANDROID_APP_DOWNLOAD_URL = 'https://www.qiwu.asia/app/android/naruto-rpg.apk';

const SNOOZED_UPDATE_KEY = 'naruto_android_update_snoozed';
const KNOWN_UPDATE_KEY = 'naruto_android_known_update';
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

function readStorage(storage, key) {
  try { return storage?.getItem?.(key) ?? null; }
  catch { return null; }
}

function writeStorage(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(storage, key) {
  try { storage?.removeItem?.(key); }
  catch { /* unavailable or full storage */ }
}

export function normalizeAndroidUpdateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('更新信息格式无效');
  }
  const versionCode = Number(value.versionCode);
  const version = String(value.version || '').trim();
  const apkUrl = String(value.apkUrl || '').trim();
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || !version) {
    throw new Error('更新信息缺少有效版本号');
  }
  if (apkUrl !== ANDROID_APP_DOWNLOAD_URL) {
    throw new Error('更新信息中的 Android 下载链接无效');
  }
  return Object.freeze({ platform: 'android', version, versionCode, apkUrl,
    releaseNotes: Array.isArray(value.releaseNotes) ? value.releaseNotes.filter(item => typeof item === 'string' && item.trim()) : [],
    announcement: typeof value.announcement === 'string' ? value.announcement.trim() : '',
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt.trim() : ''
  });
}

export function formatAndroidUpdateMessage(result) {
  const parts = [`当前版本 ${result.currentVersion} → 最新版本 ${result.latestVersion}`];
  if (result.publishedAt) parts.push(`发布时间：${result.publishedAt}`);
  if (result.releaseNotes?.length) parts.push('更新内容\n' + result.releaseNotes.map(item => `• ${item}`).join('\n'));
  if (result.announcement) parts.push('公告\n' + result.announcement);
  parts.push('下载后安装即可更新，现有本地存档会保留。');
  return parts.join('\n\n');
}

export class AndroidAppUpdateService {
  constructor({
    fetchImpl = globalThis.fetch,
    storage = globalThis.localStorage,
    manifestUrl = ANDROID_UPDATE_MANIFEST_URL,
    currentVersion = ANDROID_APP_VERSION,
    currentVersionCode = ANDROID_APP_VERSION_CODE,
    nativeCheck = isNativeAndroidApp,
    now = Date.now,
    timeoutMs = 10000
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.storage = storage;
    this.manifestUrl = manifestUrl;
    this.currentVersion = currentVersion;
    this.currentVersionCode = currentVersionCode;
    this.nativeCheck = nativeCheck;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this._lastResult = this._readKnownUpdate();
  }

  isSupported() {
    return this.nativeCheck() === true;
  }

  shouldPromptAutomatically(result = this._lastResult) {
    if (!result?.updateAvailable) return false;
    try {
      const snoozed = JSON.parse(readStorage(this.storage, SNOOZED_UPDATE_KEY) || 'null');
      const until = Number(snoozed?.until);
      return snoozed?.versionCode !== result.latestVersionCode || !Number.isFinite(until) || this.now() >= until;
    } catch { return true; }
  }

  snoozeAutomaticPrompt(result = this._lastResult) {
    return writeStorage(this.storage, SNOOZED_UPDATE_KEY, JSON.stringify({
      versionCode: result?.latestVersionCode, until: this.now() + REMIND_AFTER_MS
    }));
  }

  startAutomaticChecks({ onResult = () => {}, onError = () => {},
    windowRef = globalThis.window, documentRef = globalThis.document, minIntervalMs = 5 * 60 * 1000
  } = {}) {
    this._stopAutomaticChecks?.();
    if (!this.isSupported()) return () => {};
    let stopped = false, running = false, lastCheck = -Infinity;
    const check = async (force = false) => {
      if (stopped || running || documentRef?.visibilityState === 'hidden') return;
      if (!force && this.now() - lastCheck < minIntervalMs) return;
      lastCheck = this.now();
      running = true;
      try {
        const result = await this.check();
        if (!stopped) await onResult(result);
      } catch (error) { if (!stopped) onError(error); }
      finally { running = false; }
    };
    const onVisible = () => { void check(); };
    const onOnline = () => { void check(true); };
    documentRef?.addEventListener('visibilitychange', onVisible);
    windowRef?.addEventListener('online', onOnline);
    const timer = setTimeout(onVisible, 0);
    this._stopAutomaticChecks = () => {
      stopped = true;
      clearTimeout(timer);
      documentRef?.removeEventListener('visibilitychange', onVisible);
      windowRef?.removeEventListener('online', onOnline);
    };
    return this._stopAutomaticChecks;
  }

  getLastResult() {
    return this._lastResult ? { ...this._lastResult } : null;
  }

  hasKnownUpdate() {
    return this._lastResult?.updateAvailable === true;
  }

  check() {
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._check().finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  async _check() {
    if (!this.isSupported()) {
      const result = Object.freeze({
        supported: false,
        updateAvailable: false,
        currentVersion: this.currentVersion,
        currentVersionCode: this.currentVersionCode
      });
      this._lastResult = result;
      return { ...result };
    }
    if (typeof this.fetchImpl !== 'function') throw new Error('当前环境不支持联网检测更新');
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('检测更新超时，请检查网络后重试'));
      }, this.timeoutMs);
    });
    let manifest;
    try {
      manifest = await Promise.race([(async () => {
        const response = await this.fetchImpl(this.manifestUrl, {
          method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal
        });
        if (!response?.ok) throw new Error(`检测更新失败：HTTP ${Number(response?.status) || 0}`);
        return normalizeAndroidUpdateManifest(await response.json().catch(() => null));
      })(), timeout]);
    } finally { clearTimeout(timer); }
    const result = Object.freeze({
      supported: true,
      updateAvailable: manifest.versionCode > this.currentVersionCode,
      currentVersion: this.currentVersion,
      currentVersionCode: this.currentVersionCode,
      latestVersion: manifest.version,
      latestVersionCode: manifest.versionCode,
      downloadUrl: ANDROID_APP_DOWNLOAD_URL,
      releaseNotes: manifest.releaseNotes,
      announcement: manifest.announcement,
      publishedAt: manifest.publishedAt
    });
    this._lastResult = result;
    if (result.updateAvailable) writeStorage(this.storage, KNOWN_UPDATE_KEY, JSON.stringify(result));
    else removeStorage(this.storage, KNOWN_UPDATE_KEY);
    return { ...result };
  }

  async openDownload() {
    if (!this.isSupported()) return false;
    return openAndroidDownload(ANDROID_APP_DOWNLOAD_URL);
  }

  _readKnownUpdate() {
    try {
      const value = JSON.parse(readStorage(this.storage, KNOWN_UPDATE_KEY) || 'null');
      if (!value || value.updateAvailable !== true) return null;
      if (!Number.isSafeInteger(Number(value.latestVersionCode))) return null;
      if (Number(value.latestVersionCode) <= this.currentVersionCode) {
        removeStorage(this.storage, KNOWN_UPDATE_KEY);
        return null;
      }
      return Object.freeze({
        supported: true,
        updateAvailable: true,
        currentVersion: this.currentVersion,
        currentVersionCode: this.currentVersionCode,
        latestVersion: String(value.latestVersion || ''),
        latestVersionCode: Number(value.latestVersionCode),
        downloadUrl: ANDROID_APP_DOWNLOAD_URL,
        releaseNotes: Array.isArray(value.releaseNotes) ? value.releaseNotes.filter(item => typeof item === 'string') : [],
        announcement: typeof value.announcement === 'string' ? value.announcement : '',
        publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : ''
      });
    } catch {
      removeStorage(this.storage, KNOWN_UPDATE_KEY);
      return null;
    }
  }
}

export const appUpdateService = new AndroidAppUpdateService();

export default appUpdateService;
