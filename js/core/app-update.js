import { isNativeAndroidApp } from './runtime-platform.js';
import { openAndroidDownload } from './file-export.js';

export const ANDROID_APP_VERSION = '3.5.1';
export const ANDROID_APP_VERSION_CODE = 30501;
export const ANDROID_UPDATE_MANIFEST_URL = 'https://www.qiwu.asia/app/android/update.json';
export const ANDROID_APP_DOWNLOAD_URL = 'https://www.qiwu.asia/app/android/naruto-rpg.apk';

const AUTO_PROMPT_DISABLED_KEY = 'naruto_android_update_auto_prompt_disabled';
const KNOWN_UPDATE_KEY = 'naruto_android_known_update';

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
  return Object.freeze({ platform: 'android', version, versionCode, apkUrl });
}

export class AndroidAppUpdateService {
  constructor({
    fetchImpl = globalThis.fetch,
    storage = globalThis.localStorage,
    manifestUrl = ANDROID_UPDATE_MANIFEST_URL,
    currentVersion = ANDROID_APP_VERSION,
    currentVersionCode = ANDROID_APP_VERSION_CODE,
    nativeCheck = isNativeAndroidApp
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.storage = storage;
    this.manifestUrl = manifestUrl;
    this.currentVersion = currentVersion;
    this.currentVersionCode = currentVersionCode;
    this.nativeCheck = nativeCheck;
    this._lastResult = this._readKnownUpdate();
  }

  isSupported() {
    return this.nativeCheck() === true;
  }

  isAutomaticPromptDisabled() {
    return readStorage(this.storage, AUTO_PROMPT_DISABLED_KEY) === 'true';
  }

  disableAutomaticPrompt() {
    return writeStorage(this.storage, AUTO_PROMPT_DISABLED_KEY, 'true');
  }

  getLastResult() {
    return this._lastResult ? { ...this._lastResult } : null;
  }

  hasKnownUpdate() {
    return this._lastResult?.updateAvailable === true;
  }

  async check() {
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
    const response = await this.fetchImpl(this.manifestUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!response?.ok) throw new Error(`检测更新失败：HTTP ${Number(response?.status) || 0}`);
    const manifest = normalizeAndroidUpdateManifest(await response.json().catch(() => null));
    const result = Object.freeze({
      supported: true,
      updateAvailable: manifest.versionCode > this.currentVersionCode,
      currentVersion: this.currentVersion,
      currentVersionCode: this.currentVersionCode,
      latestVersion: manifest.version,
      latestVersionCode: manifest.versionCode,
      downloadUrl: ANDROID_APP_DOWNLOAD_URL
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
        downloadUrl: ANDROID_APP_DOWNLOAD_URL
      });
    } catch {
      removeStorage(this.storage, KNOWN_UPDATE_KEY);
      return null;
    }
  }
}

export const appUpdateService = new AndroidAppUpdateService();

export default appUpdateService;
