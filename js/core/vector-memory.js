import { getMemoryConfig } from '../data/memory-config.js';
import { projectCorrectedMemory } from './memory-corrections.js';
import { projectNarrativeForMemory } from './narrative-memory.js';
import { queryContinuityEvents } from './continuity-ledger.js';
import { fetchAI } from './native-ai-fetch.js';
import { isNativeAndroidApp, usesProjectServerFeatures } from './runtime-platform.js';

const SECRET_KEY = 'naruto_vector_memory_credentials';
const CACHE_NAME = 'naruto_memory_vectors';
const MAX_DOCUMENTS = 1600, BATCH_SIZE = 12, MAX_TEXT = 1200;
export function getVectorCredentials() {
  try { return JSON.parse(globalThis.localStorage?.getItem(SECRET_KEY) || '{}'); } catch { return {}; }
}
export function saveVectorCredentials(apiKey) {
  globalThis.localStorage?.setItem(SECRET_KEY, JSON.stringify({ apiKey: String(apiKey || '').trim() }));
}
const normalize = value => projectNarrativeForMemory(String(value || '')).trim().slice(0, MAX_TEXT);
function lines(value) { return String(value || '').split(/\r?\n/).map(normalize).filter(Boolean); }
function chapters(value) { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }

export function vectorDocuments(state, ancestors = new Set(), inheritedBeforeTurn = 0) {
  const memory = projectCorrectedMemory(state?._memory || {});
  const turn = Number(state?.['系统·回合数']) || 0;
  const documents = [], seen = new Set();
  function add(id, text, sourceTurn = turn, source = {}) {
    text = normalize(text);
    if (!text || seen.has(text) || sourceTurn > turn) return;
    seen.add(text); documents.push({ id, text, turn: sourceTurn, source });
  }
  // The current snapshot supplies the scope. Never search arbitrary other saves
  // or IF heads, and never treat proposed actions as completed events.
  if (ancestors.size) for (const event of queryContinuityEvents(state?._continuity, { truths: ['confirmed'], gameTime: state?.['世界·时间'], limit: MAX_DOCUMENTS })) {
    // A continuation root deliberately drops old nodes, but its own snapshot
    // retains the ancestor ledger. Those older facts still belong to this save.
    const inherited = inheritedBeforeTurn > 0 && event.turn < inheritedBeforeTurn && event.turn <= turn;
    if ((!ancestors.has(event.node_id) && !inherited) || event.turn > turn || /option|choice|plan|intent|prediction|retraction/.test(event.type)) continue;
    const text = typeof event.value === 'string' ? event.value : JSON.stringify(event.value);
    const corrected = projectCorrectedMemory({ ...state._memory, facts: text }).facts;
    add(`event:${event.event_id}`, corrected, event.turn, { eventId: event.event_id, nodeId: event.node_id, fromTurn: event.turn, toTurn: event.turn });
  }
  for (const field of ['pins', 'facts', 'long_term', 'important_events', 'npc_notes', 'archived']) {
    lines(memory[field]).forEach((text, i) => add(`${field}:${i}`, text, turn, { field }));
  }
  for (const chapter of chapters(memory.chapters)) {
    if (Number(chapter.to) > turn) continue;
    const text = projectNarrativeForMemory(String(chapter.raw || chapter.summary || ''));
    for (let offset = 0; offset < text.length; offset += MAX_TEXT) add(`chapter:${chapter.id}:${offset}`, text.slice(offset, offset + MAX_TEXT), Number(chapter.to) || 0, { fromTurn: chapter.from ?? null, toTurn: chapter.to ?? null });
  }
  return documents.slice(-MAX_DOCUMENTS);
}

export function lexicalScore(text, query) {
  const lower = String(query).toLowerCase();
  const words = lower.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2}/gu) || [];
  if (!words.length) return 0;
  const haystack = text.toLowerCase();
  return words.filter(word => haystack.includes(word)).length / words.length;
}
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
async function hash(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

export class VectorCache {
  async open() {
    this.opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('vectors', { keyPath: 'id' }).createIndex('updated', 'updated');
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); this.opening = null; }; resolve(db); };
      request.onerror = () => reject(request.error);
    }).catch(error => { this.opening = null; throw error; });
    return this.opening;
  }
  async getMany(ids) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('vectors'), found = new Map();
      for (const id of ids) { const request = tx.objectStore('vectors').get(id); request.onsuccess = () => { if (request.result) found.set(id, request.result.vector); }; }
      tx.oncomplete = () => resolve(found); tx.onabort = () => reject(tx.error);
    });
  }
  async putMany(records) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('vectors', 'readwrite'), store = tx.objectStore('vectors');
      for (const record of records) store.put({ ...record, updated: Date.now() });
      const count = store.count();
      count.onsuccess = () => {
        let remove = count.result - 4000;
        if (remove <= 0) return;
        const request = store.index('updated').openCursor();
        request.onsuccess = () => { const cursor = request.result; if (cursor && remove-- > 0) { cursor.delete(); cursor.continue(); } };
      };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
  }
  async clear() { const db = await this.open(); return new Promise((resolve, reject) => { const tx = db.transaction('vectors', 'readwrite'); tx.objectStore('vectors').clear(); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); }
}

export async function requestEmbeddings(texts, config, { signal } = {}) {
  const base = new URL(config.vectorEndpoint);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('请填写有效的嵌入接口地址');
  const endpoint = `${base.href.replace(/\/$/, '').replace(/\/embeddings$/, '')}/embeddings`;
  const apiKey = getVectorCredentials().apiKey;
  const proxy = !isNativeAndroidApp() && usesProjectServerFeatures();
  const response = await fetchAI(proxy ? '/api/ai-proxy' : endpoint, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(proxy
      ? { 'x-target-url': endpoint, 'x-user-api-key': apiKey || '', 'x-api-key-header': 'Authorization' }
      : apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: config.vectorModel, input: texts, encoding_format: 'float' })
  });
  if (!response.ok) throw new Error(`嵌入接口返回 ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error('嵌入接口返回数量不正确');
  const rows = [...body.data].sort((a, b) => a.index - b.index);
  const dimension = rows[0]?.embedding?.length;
  if (!dimension || dimension > 8192 || rows.some((row, i) => row.index !== i || !Array.isArray(row.embedding) || row.embedding.length !== dimension || row.embedding.some(n => !Number.isFinite(n)))) throw new Error('嵌入接口返回向量无效');
  return rows.map(row => row.embedding);
}

export class VectorMemory {
  constructor({ cache = new VectorCache(), embed = requestEmbeddings, config = getMemoryConfig } = {}) {
    this.cache = cache; this.embed = embed; this.config = config; this.status = '未启用';
  }
  async recall({ state, query, scope, ancestors, inheritedBeforeTurn = 0, signal, timeoutMs = 3000 } = {}) {
    const config = this.config();
    // This return happens before reading IndexedDB, credentials, or requesting
    // an embedding. Disabled mode keeps the existing prompt byte-for-byte.
    if (!config.vectorEnabled) { this.status = '未启用'; return []; }
    if (!config.vectorEndpoint || !config.vectorModel) { this.status = '请填写嵌入接口和模型，当前使用本地记忆'; return []; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(cancelled()), { once: true }));
    aborted.catch(() => {});
    const bounded = promise => Promise.race([promise, aborted]);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      if (signal?.aborted) throw cancelled();
      const documents = vectorDocuments(state, ancestors, inheritedBeforeTurn).map(document => ({ ...document, lexical: lexicalScore(document.text, query) }));
      if (!documents.length) { this.status = '暂无可检索的历史记忆'; return []; }
      const prefix = `${scope}\n${config.vectorEndpoint}\n${config.vectorModel}\n`;
      const keyed = await bounded(Promise.all(documents.map(async document => ({ ...document, key: await hash(prefix + document.text) }))));
      const queryKey = await bounded(hash(prefix + 'query:' + normalize(query)));
      const cached = await bounded(this.cache.getMany([...keyed.map(item => item.key), queryKey]));
      const pending = keyed.filter(item => !cached.has(item.key)).sort((a, b) => b.lexical - a.lexical || b.turn - a.turn).slice(0, BATCH_SIZE);
      const input = [...pending.map(item => item.text), ...(!cached.has(queryKey) ? [normalize(query)] : [])];
      if (input.length) {
        if (controller.signal.aborted || !this.config().vectorEnabled) throw cancelled();
        const vectors = await bounded(this.embed(input, config, { signal: controller.signal }));
        if (controller.signal.aborted) throw cancelled();
        const records = pending.map((item, i) => ({ id: item.key, vector: vectors[i] }));
        if (!cached.has(queryKey)) records.push({ id: queryKey, vector: vectors.at(-1) });
        await bounded(this.cache.putMany(records));
        for (const item of records) cached.set(item.id, item.vector);
      }
      if (controller.signal.aborted || !this.config().vectorEnabled) throw cancelled();
      const queryVector = cached.get(queryKey);
      const hits = keyed.map(item => ({ ...item, score: 0.8 * cosine(queryVector, cached.get(item.key)) + 0.2 * item.lexical }))
        .filter(item => item.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, 4);
      this.status = `本次召回 ${hits.length} 条 · 已索引 ${keyed.filter(item => cached.has(item.key)).length} / ${keyed.length} 条`;
      return hits.map(({ text, turn, source }) => ({ text, turn, source }));
    } catch { this.status = '向量检索不可用，已使用原有本地记忆'; return []; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
function cancelled() { return new DOMException('检索已取消', 'AbortError'); }
export const vectorMemory = new VectorMemory();
