import { fetchNativeCloud } from '../core/native-ai-fetch.js';
import { cloudConnectionEnabled, projectServerUrl } from '../core/project-server.js';

// Reconnection and member cursors remain owned by MultiplayerRoomEventStream.
// Native EventSource cannot attach the Keystore-held account credential.
export class NativeRoomEventSource extends EventTarget {
  constructor(url, { fetchImpl = fetchNativeCloud } = {}) {
    super();
    if (!/^\/api\/multiplayer\/rooms\/[^/?#]+\/events(?:\?[^#]*)?$/.test(url)) {
      throw new TypeError('联机事件地址无效');
    }
    this.controller = new AbortController();
    this.reader = null;
    this.closed = false;
    this.task = this._read(url, fetchImpl).catch(error => {
      if (!this.closed) {
        const event = new Event('error');
        Object.defineProperty(event, 'error', { value: error });
        this.dispatchEvent(event);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    void this.reader?.cancel().catch(() => {});
  }

  async _read(url, fetchImpl) {
    if (!cloudConnectionEnabled()) throw new Error('云端连接已暂停');
    const response = await fetchImpl(projectServerUrl(url), {
      method: 'GET', headers: { Accept: 'text/event-stream' },
      cache: 'no-store', signal: this.controller.signal
    });
    if (this.closed) { await response.body?.cancel(); return; }
    if (!response.ok || !response.body || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new Error(`联机事件连接失败（HTTP ${response.status}）`);
    }
    this.reader = response.body.getReader();
    this.dispatchEvent(new Event('open'));
    const decoder = new TextDecoder();
    let buffer = '', eventType = '', data = [];
    const line = text => {
      if (text === '') {
        if (data.length) this.dispatchEvent(new MessageEvent(eventType || 'message', { data: data.join('\n') }));
        eventType = ''; data = [];
      } else if (!text.startsWith(':')) {
        const colon = text.indexOf(':');
        const field = colon < 0 ? text : text.slice(0, colon);
        const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        if (field === 'event') eventType = value;
      }
    };
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Room events are bounded by the server; reject a broken endless line.
        if (buffer.length > 4 * 1024 * 1024) throw new Error('联机事件响应过大');
        let match;
        while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
          const text = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          line(text);
          if (this.closed) break;
        }
      }
      if (!this.closed) throw new Error('联机事件连接已结束');
    } finally {
      await this.reader.cancel().catch(() => {});
      this.reader.releaseLock();
    }
  }
}
