import { listingTimelineNode } from './timeline-node-codec.js';

export const TIMELINE_DB_NAME = 'naruto_rpg';
export const TIMELINE_DB_VERSION = 2;
export const SUMMARY_STORE = 'timeline_summaries';
export const ARCHIVE_STORES = ['timeline_archives', 'timeline_archive_nodes'];
export const timelineRevision = () => ({ key: 'archive-revision', value: crypto.randomUUID() });

export function openTimelineDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TIMELINE_DB_NAME, TIMELINE_DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('timeline_nodes')) {
        const store = db.createObjectStore('timeline_nodes', { keyPath: 'id' });
        for (const key of ['parent_id', 'branch_id', 'turn_number', 'real_timestamp']) store.createIndex(key, key);
      }
      if (!db.objectStoreNames.contains('timeline_branches')) {
        db.createObjectStore('timeline_branches', { keyPath: 'id' }).createIndex('is_active', 'is_active');
      }
      if (!db.objectStoreNames.contains('timeline_meta')) db.createObjectStore('timeline_meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains(SUMMARY_STORE)) db.createObjectStore(SUMMARY_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('timeline_archives')) db.createObjectStore('timeline_archives', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('timeline_archive_nodes')) {
        db.createObjectStore('timeline_archive_nodes', { keyPath: ['archiveId', 'id'] }).createIndex('archiveId', 'archiveId');
      }
    };
    request.onblocked = () => { blocked = true; reject(new Error('请关闭其他旧版游戏标签页，再打开存档救援。原存档未修改。')); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export function readDB(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store);
    const request = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => {};
  });
}

// A sidecar index is rebuildable. Never rewrite an old save during the schema
// upgrade; a cancelled index build leaves every original node untouched.
export function buildTimelineIndex(db, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['timeline_nodes', SUMMARY_STORE, 'timeline_meta'], 'readwrite');
    const meta = tx.objectStore('timeline_meta');
    const check = meta.get('summary-index-v1');
    let count = 0, failure, revision;
    const revisionRequest = meta.get('archive-revision');
    revisionRequest.onsuccess = () => { revision = revisionRequest.result; };
    check.onsuccess = () => {
      if (check.result?.value === true) return;
      const summaries = tx.objectStore(SUMMARY_STORE);
      summaries.clear();
      const request = tx.objectStore('timeline_nodes').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          meta.put({ key: 'summary-index-v1', value: true });
          if (!revision) meta.put(timelineRevision());
          return;
        }
        try {
          summaries.put(listingTimelineNode(cursor.value));
          count++;
          if (count % 50 === 0) onProgress(`正在建立旧档目录：${count} 回合，原档保持不变…`);
          cursor.continue();
        } catch (error) { failure = error; tx.abort(); }
      };
    };
    tx.oncomplete = () => resolve(count);
    tx.onabort = () => reject(failure || tx.error);
    tx.onerror = () => {};
  });
}
