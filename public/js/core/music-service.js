import { isNativeAndroidApp } from './runtime-platform.js';

const TENCENT_SEARCH_ENDPOINT = 'https://api.vkeys.cn/v2/music/tencent/search/song';
const TENCENT_RESOLVE_ENDPOINT = 'https://api.vkeys.cn/v2/music/tencent';
const TENCENT_STREAM_HOST_SUFFIX = '.stream.qqmusic.qq.com';
const MAX_CACHE_SIZE = 120;

function cleanText(value, max = 240) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function artistName(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => typeof item === 'object' ? item?.name || item?.title : item)
      .map(item => cleanText(item, 120))
      .filter(Boolean)
      .slice(0, 8)
      .join(' / ');
  }
  if (value && typeof value === 'object') return cleanText(value.name || value.title, 240);
  return cleanText(value, 240);
}

function musicAccess(track = {}) {
  const explicit = cleanText(track.access, 40).toLowerCase();
  const label = cleanText(track.pay ?? track.payment ?? track.fee, 80);
  const normalized = label.toLowerCase();
  const free = explicit === 'free' || /免费|free|无需付费/.test(normalized);
  const paid = track.requiresSubscription === true
    || explicit === 'paid'
    || (!free && /付费|会员|vip|subscription|paid/.test(normalized));
  return {
    access: paid ? 'paid' : (free ? 'free' : 'unknown'),
    requiresSubscription: paid
  };
}

function accessPriority(track) {
  if (track.access === 'free') return 0;
  if (track.access === 'paid') return 2;
  return 1;
}

export function getMusicTrackId(track) {
  const value = typeof track === 'string'
    ? cleanText(track, 300)
    : cleanText(
    track?.mid || track?.url_id || track?.id || track?.songmid || track?.songId,
    300
  );
  return /^[A-Za-z0-9_-]{1,300}$/.test(value) ? value : '';
}

export function normalizeMusicTrack(track = {}) {
  if (!track || typeof track !== 'object' || Array.isArray(track)) return null;
  const provider = cleanText(track.provider || track.source, 40).toLowerCase();
  if (provider && provider !== 'tencent') return null;
  const id = getMusicTrackId(track);
  if (!id) return null;
  const name = cleanText(track.name || track.title || track.song || track.songname, 240) || '未知曲目';
  const artist = artistName(track.artist || track.singer || track.author);
  const album = typeof track.album === 'object'
    ? cleanText(track.album.name || track.album.title, 240)
    : cleanText(track.album || track.albumName || track.albumname, 240);
  const durationValue = Number(track.duration ?? track.interval);
  const duration = Number.isFinite(durationValue) && durationValue >= 0
    ? Math.round(durationValue)
    : null;
  const access = musicAccess(track);
  return Object.freeze({
    id,
    mid: id,
    name,
    title: name,
    artist,
    album,
    duration,
    ...access,
    quality: cleanText(track.quality, 120),
    provider: 'tencent'
  });
}

export function parseAllowedMusicStreamUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('音乐流地址无效'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowedHost = hostname === TENCENT_STREAM_HOST_SUFFIX.slice(1)
    || hostname.endsWith(TENCENT_STREAM_HOST_SUFFIX);
  if (!allowedHost
      || !['http:', 'https:'].includes(url.protocol)
      || url.port
      || url.username
      || url.password
      || url.hash
      || url.href.length > 8192) {
    throw new Error('音乐流地址不在允许的音乐域名内');
  }
  return url.href;
}

function copyTrack(track) {
  return track ? { ...track } : null;
}

export class MusicService {
  constructor({ fetchImpl = globalThis.fetch, nativeCheck = isNativeAndroidApp } = {}) {
    this.fetchImpl = fetchImpl;
    this.nativeCheck = nativeCheck;
    this._tracks = new Map();
    this._searches = new Map();
    this._lastQuery = '';
    this._playerState = Object.freeze({ status: 'idle', track: null, paused: true });
  }

  _fetch() {
    if (typeof this.fetchImpl !== 'function') throw new Error('当前环境不支持音乐网络请求');
    return this.fetchImpl;
  }

  rememberTrack(track) {
    const normalized = normalizeMusicTrack(track);
    if (!normalized) throw new TypeError('曲目缺少可用标识');
    this._tracks.delete(normalized.id);
    this._tracks.set(normalized.id, normalized);
    while (this._tracks.size > MAX_CACHE_SIZE) {
      this._tracks.delete(this._tracks.keys().next().value);
    }
    return copyTrack(normalized);
  }

  getTrack(trackId) {
    return copyTrack(this._tracks.get(getMusicTrackId(trackId)));
  }

  getSearchResults(query = this._lastQuery) {
    const normalizedQuery = cleanText(query, 160).toLocaleLowerCase('zh-CN');
    const ids = this._searches.get(normalizedQuery) || [];
    return ids.map(id => this.getTrack(id)).filter(Boolean);
  }

  get lastQuery() {
    return this._lastQuery;
  }

  setPlayerState(state = {}) {
    const track = state.track ? normalizeMusicTrack(state.track) : null;
    this._playerState = Object.freeze({
      status: cleanText(state.status, 40) || 'unknown',
      track: copyTrack(track),
      enabled: typeof state.enabled === 'boolean' ? state.enabled : null,
      paused: typeof state.paused === 'boolean' ? state.paused : null,
      volume: Number.isFinite(Number(state.volume)) ? Math.max(0, Math.min(100, Number(state.volume))) : null
    });
    return this.getPlayerState();
  }

  getPlayerState() {
    return { ...this._playerState, track: copyTrack(this._playerState.track) };
  }

  async search(query, { limit = 20 } = {}) {
    const normalizedQuery = cleanText(query, 160);
    if (!normalizedQuery) throw new TypeError('音乐搜索关键词不能为空');
    const boundedLimit = Math.min(20, Math.max(1, Number(limit) || 10));
    const response = await this._fetch()(
      `${TENCENT_SEARCH_ENDPOINT}?word=${encodeURIComponent(normalizedQuery)}`
    );
    if (!response?.ok) throw new Error(`音乐搜索失败：HTTP ${Number(response?.status) || 0}`);
    const payload = await response.json().catch(() => null);
    const rows = payload?.code === 200 && Array.isArray(payload.data) ? payload.data : null;
    if (!rows) throw new Error('音乐搜索服务返回了无效数据');
    const seen = new Set();
    const tracks = rows
      .map(track => ({ ...track, provider: 'tencent' }))
      .map(normalizeMusicTrack)
      .filter(Boolean)
      .filter(track => {
        if (seen.has(track.id)) return false;
        seen.add(track.id);
        return true;
      })
      .sort((left, right) => accessPriority(left) - accessPriority(right))
      .slice(0, boundedLimit)
      .map(track => this.rememberTrack(track));
    const queryKey = normalizedQuery.toLocaleLowerCase('zh-CN');
    this._searches.set(queryKey, tracks.map(track => track.id));
    this._lastQuery = normalizedQuery;
    return tracks;
  }

  async resolveStreamUrl(trackOrId) {
    const track = typeof trackOrId === 'object'
      ? this.rememberTrack(trackOrId)
      : this.getTrack(trackOrId);
    if (!track) throw new Error('曲目不在最近的搜索结果中，请先搜索后再播放');
    if (this.nativeCheck()) {
      const response = await this._fetch()(
        `${TENCENT_RESOLVE_ENDPOINT}?mid=${encodeURIComponent(track.id)}`,
        { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error' }
      );
      if (!response?.ok) throw new Error(`音乐地址解析失败：HTTP ${Number(response?.status) || 0}`);
      const payload = await response.json().catch(() => null);
      if (!payload || payload.code !== 200) throw new Error('音乐地址解析服务返回无效数据');
      return parseAllowedMusicStreamUrl(payload?.data?.url);
    }
    return `/api/music/stream?mid=${encodeURIComponent(track.id)}`;
  }
}

export const musicService = new MusicService();

export default musicService;
