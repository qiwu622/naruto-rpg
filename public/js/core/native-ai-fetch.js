import { isNativeAndroidApp } from './runtime-platform.js';

function abortError(reason) {
  return reason instanceof Error ? reason : new DOMException('已取消生成', 'AbortError');
}

/** Keep the shared AI parsers/SDK; adapt only Android's HTTP byte transport. */
export async function fetchAI(input, init = {}) {
  if (!isNativeAndroidApp()) return globalThis.fetch(input, init);
  const bridge = globalThis.Capacitor;
  const plugin = typeof bridge?.registerPlugin === 'function'
    ? bridge.registerPlugin('NarutoHttp') : bridge?.Plugins?.NarutoHttp;
  if (!plugin) throw new Error('当前安装包缺少流式网络功能，请更新 App');
  const request = new Request(input, init);
  const signal = init.signal ?? request.signal;
  if (signal.aborted) throw abortError(signal.reason);
  const body = request.body ? await request.text() : null;
  if (signal.aborted) throw abortError(signal.reason);
  const id = globalThis.crypto?.randomUUID?.() ?? `ai-${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    let controller, ended = false, receivedHeaders = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
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
        headers: Object.fromEntries(request.headers.entries()), body }, onFrame)).catch(finish);
    } catch (error) { finish(error); }
  });
}
