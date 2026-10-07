import { isNativeAndroidApp } from './runtime-platform.js';
import { fetchNativeCloud } from './native-ai-fetch.js';
import { eventBus } from './event-bus.js';

export const PROJECT_SERVER_ORIGIN = 'https://www.qiwu.asia';
let nativePlugin;
let connection = { status: 'local', message: '本地可用，云端尚未连接' };

export function nativeCloudPlugin() {
  const bridge = globalThis.Capacitor;
  return nativePlugin ||= typeof bridge?.registerPlugin === 'function'
    ? bridge.registerPlugin('NarutoCloud') : bridge?.Plugins?.NarutoCloud;
}

export function cloudConnectionEnabled() {
  try { return !isNativeAndroidApp() || globalThis.localStorage?.getItem('naruto_app_cloud_enabled') !== 'false'; }
  catch { return true; }
}
export function getCloudConnection() { return cloudConnectionEnabled() ? { ...connection } : { status: 'paused', message: '云端连接已暂停，本地游玩可用' }; }
export function setCloudConnection(status, message) {
  connection = { status, message };
  eventBus.emit('cloud:connection', getCloudConnection());
}
export function enableCloudConnection(enabled) {
  try { globalThis.localStorage?.setItem('naruto_app_cloud_enabled', String(Boolean(enabled))); } catch { /* local play remains available */ }
  setCloudConnection(enabled ? 'local' : 'paused', enabled ? '云端已启用，等待连接' : '云端连接已暂停，本地游玩可用');
}

export function projectServerUrl(path) {
  // Never turn this into an arbitrary proxy or send account credentials to an AI provider.
  if (typeof path !== 'string' || !/^\/(?:auth|api|health)\//.test(path) || path.includes('\\')) throw new Error('云端请求地址无效');
  const url = new URL(path, PROJECT_SERVER_ORIGIN);
  if (url.origin !== PROJECT_SERVER_ORIGIN) throw new Error('云端请求地址无效');
  return isNativeAndroidApp() ? url.href : path;
}

/** Optional cloud requests have a deadline covering headers AND the response body. */
export async function fetchProjectServer(path, options = {}) {
  const { timeoutMs = 15_000, anonymous = false, ...init } = options;
  const native = isNativeAndroidApp();
  if (native && !cloudConnectionEnabled()) throw Object.assign(new Error('云端连接已暂停，本地游玩不受影响'), { code: 'CLOUD_PAUSED' });
  const url = projectServerUrl(path);
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await (native ? fetchNativeCloud(url, { ...init, signal: controller.signal }, { anonymous })
      : globalThis.fetch(url, { credentials: 'same-origin', ...init, signal: controller.signal }));
    const blob = await response.blob();
    const result = new Response([204, 205, 304].includes(response.status) ? null : blob, { status: response.status, headers: response.headers });
    Object.defineProperty(result, 'url', { value: response.url || url });
    if (native) setCloudConnection(response.status >= 500 ? 'offline' : 'connected', response.status >= 500 ? '云端服务暂不可用，本地游玩不受影响' : '云端连接正常');
    return result;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    const failure = Object.assign(new Error(timedOut ? '云端连接超时，本地进度已保留' : '暂时无法连接云端，可以继续本地游玩'),
      { code: timedOut ? 'CLOUD_TIMEOUT' : 'NETWORK_ERROR', cause: error });
    if (native) setCloudConnection('offline', failure.message);
    throw failure;
  } finally {
    clearTimeout(timer); init.signal?.removeEventListener('abort', abort);
  }
}
