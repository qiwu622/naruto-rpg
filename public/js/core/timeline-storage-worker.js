import { openTimelineDB, buildTimelineIndex } from './timeline-db.js';

const abort = new AbortController();
self.onmessage = async ({ data }) => {
  if (data.cancel) { abort.abort(); return; }
  let db;
  try {
    db = await openTimelineDB();
    const progress = text => self.postMessage({ progress: text });
    let result;
    if (data.action === 'index') result = await buildTimelineIndex(db, progress);
    else {
      const { runArchiveTask } = await import('./timeline-archive.js');
      result = await runArchiveTask(db, data.action, data.options, { onProgress: progress, signal: abort.signal });
    }
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: { name: error.name, message: error.message } }); }
  finally { db?.close(); }
};
