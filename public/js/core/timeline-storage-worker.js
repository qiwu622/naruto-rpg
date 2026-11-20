import { openTimelineDB, buildTimelineIndex } from './timeline-db.js';

const abort = new AbortController();
self.onmessage = async ({ data }) => {
  if (data.cancel) { abort.abort(); return; }
  let db;
  try {
    db = await openTimelineDB();
    const progress = text => self.postMessage({ progress: text });
    const streamCallbacks = data.options?.streamExportChunks
      ? {
          onStreamStart: info => self.postMessage({ streamStart: info }),
          onStreamChunk: chunk => {
            const copy = new Uint8Array(chunk.byteLength);
            copy.set(chunk);
            self.postMessage({ streamChunk: copy.buffer }, [copy.buffer]);
          },
          onStreamEnd: info => self.postMessage({ streamEnd: info })
        }
      : {};
    let result;
    if (data.action === 'index') result = await buildTimelineIndex(db, progress);
    else {
      const { runArchiveTask } = await import('./timeline-archive.js');
      result = await runArchiveTask(db, data.action, data.options, { onProgress: progress, signal: abort.signal, ...streamCallbacks });
    }
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: { name: error.name, message: error.message } }); }
  finally { db?.close(); }
};
