import { isNativeAndroidApp } from './runtime-platform.js';

function abortError(reason) {
  return reason instanceof Error ? reason : new DOMException('已取消生成', 'AbortError');
}

/** Keep the shared AI parsers/SDK; adapt only Android's HTTP byte transport. */
export async function fetchAI(input, init = {}) {
  if (!isNativeAndroidApp()) return globalThis.fetch(input, init);
  return nativeFetch(input, init);
}

export async function fetchNativeCloud(input, init = {}, { anonymous = false } = {}) {
  return nativeFetch(input, init, { cloud: true, anonymous });
}

async function nativeFetch(input, init, cloudOptions = null) {
  const bridge = globalThis.Capacitor;
  const plugin = typeof bridge?.registerPlugin === 'function'
    ? bridge.registerPlugin('NarutoHttp') : bridge?.Plugins?.NarutoHttp;
  if (!plugin) throw new Error('当前安装包缺少流式网络功能，请更新 App');
  const request = new Request(input, init);
  const signal = init.signal ?? request.signal;
  if (signal.aborted) throw abortError(signal.reason);
  let body = null, bodyId = null;
  if (request.body && cloudOptions && (init.body instanceof FormData || init.body instanceof Blob)) {
    try {
      const blob = await request.blob();
      if (blob.size > 68 * 1024 * 1024) throw new Error('云端上传文件超过 68 MiB');
      bodyId = (await plugin.beginCloudBody()).id;
      for (let offset = 0; offset < blob.size; offset += 256 * 1024) {
        if (signal.aborted) throw abortError(signal.reason);
        const bytes = new Uint8Array(await blob.slice(offset, offset + 256 * 1024).arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await plugin.appendCloudBody({ id: bodyId, data: btoa(binary) });
      }
    } catch (error) {
      if (bodyId) await plugin.discardCloudBody({ id: bodyId }).catch(() => {});
      throw error;
    }
  } else body = request.body ? await request.text() : null;
  if (signal.aborted && bodyId) await plugin.discardCloudBody({ id: bodyId }).catch(() => {});
  if (signal.aborted) throw abortError(signal.reason);
  const id = globalThis.crypto?.randomUUID?.() ?? `ai-${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    let controller, ended = false, receivedHeaders = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (bodyId) void plugin.discardCloudBody({ id: bodyId }).catch(() => {});
    };
    const cancelNative = () => { void plugin.cancel({ id }).catch(() => {}); };
    const finish = error => {
      if (ended) return;
      ended = true;
      cleanup();
      if (error) { reject(error); controller?.error(error); }
      else controller?.close();
    };
    const onAbort = () => { finish(abortError(signal.reason)); cancelNative(); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    const onFrame = (frame, failure) => {
      if (ended) return;
      try {
        if (failure) {
          const error = failure.code === 'ABORT_ERR' ? abortError() : new Error(failure.message || '安卓网络请求失败');
          finish(error); return;
        }
        if (frame?.type === 'headers') {
          if (receivedHeaders) throw new Error('网络响应重复');
          receivedHeaders = true;
          const noBody = request.method === 'HEAD' || [204, 205, 304].includes(frame.status);
          const stream = noBody ? null : new ReadableStream({
            start(value) { controller = value; },
            cancel() { ended = true; cleanup(); cancelNative(); }
          });
          const response = new Response(stream, { status: frame.status, headers: frame.headers });
          Object.defineProperty(response, 'url', { value: frame.url });
          resolve(response);
        } else if (frame?.type === 'data') {
          if (!receivedHeaders) throw new Error('网络响应缺少状态');
          const binary = atob(frame.data);
          const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
          controller?.enqueue(bytes);
        } else if (frame?.type === 'end') {
          if (!receivedHeaders) throw new Error('网络响应缺少状态');
          finish();
        } else throw new Error('安卓网络响应格式无效');
      } catch (error) { finish(error); cancelNative(); }
    };
    try {
      Promise.resolve(plugin.request({ id, url: request.url, method: request.method,
        headers: Object.fromEntries(request.headers.entries()), body,
        ...(cloudOptions || {}), ...(bodyId ? { bodyId } : {}) }, onFrame)).catch(finish);
    } catch (error) { finish(error); }
  });
}
