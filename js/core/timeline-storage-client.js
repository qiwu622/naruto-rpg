// Only small commands/metadata cross the worker boundary. The worker reads
// IndexedDB itself, rather than receiving a cloned multi-gigabyte save graph.
export function timelineStorageTask(action, options = {}, {
  onProgress = () => {},
  onStreamStart = null,
  onStreamChunk = null,
  onStreamEnd = null,
  signal
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消，原存档保留', 'AbortError')); return; }
    const worker = new Worker(new URL('./timeline-storage-worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    let streamQueue = Promise.resolve();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => worker.postMessage({ cancel: true });
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.progress) { onProgress(data.progress); return; }
      if (data.streamStart) {
        streamQueue = streamQueue.then(() => onStreamStart?.(data.streamStart)).catch(err => finish(err));
        return;
      }
      if (data.streamChunk) {
        const bytes = new Uint8Array(data.streamChunk);
        streamQueue = streamQueue.then(() => onStreamChunk?.(bytes)).catch(err => finish(err));
        return;
      }
      if (data.streamEnd) {
        streamQueue = streamQueue.then(() => onStreamEnd?.(data.streamEnd)).catch(err => finish(err));
        return;
      }
      streamQueue.then(() => {
        if (data.error) { const error = new Error(data.error.message); error.name = data.error.name; finish(error); }
        else finish(null, data.result);
      }, finish);
    };
    worker.onerror = event => finish(new Error(event.message || '存档后台任务失败，原档保留'));
    const nextOptions = onStreamChunk ? { ...options, streamExportChunks: true } : options;
    worker.postMessage({ action, options: nextOptions });
  });
}
