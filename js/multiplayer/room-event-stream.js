import { MULTIPLAYER_EVENT_TYPES, assertPathIdentifier } from './contracts.js';

class ListenerSet {
  constructor() {
    this.listeners = new Map();
  }

  on(type, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
    return () => bucket.delete(listener);
  }

  emit(type, value) {
    for (const listener of this.listeners.get(type) ?? []) {
      try {
        listener(value);
      } catch {
        // One UI listener must not break cursor advancement or other listeners.
      }
    }
  }

  clear() {
    this.listeners.clear();
  }
}

function parseCursor(value) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseEnvelope(raw, roomId, expectedType = null) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError('SSE event data is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SSE event envelope must be an object');
  }
  if (value.room_id !== roomId
    || !Number.isSafeInteger(value.event_seq)
    || value.event_seq < 1
    || typeof value.event_id !== 'string'
    || typeof value.event_type !== 'string'
    || (expectedType !== null && value.event_type !== expectedType)) {
    throw new TypeError('SSE event envelope does not match the active member stream');
  }
  return Object.freeze({
    event_id: value.event_id,
    room_id: value.room_id,
    event_seq: value.event_seq,
    epoch_id: value.epoch_id ?? null,
    turn_id: value.turn_id ?? null,
    event_type: value.event_type,
    projection_version: value.projection_version ?? null,
    payload: value.payload ?? {},
    payload_hash: value.payload_hash ?? null,
    created_at: value.created_at ?? null
  });
}

/**
 * Member-projected room stream with monotonic event_seq de-duplication.
 * Reconnects always use `?after=<last accepted seq>`; payloads are never
 * persisted by this class, so revealed action text cannot leak into a cursor
 * cache or become input to any single-player Agent.
 */
export class MultiplayerRoomEventStream {
  constructor({
    apiClient,
    eventSourceFactory = (url, init) => new EventSource(url, init),
    eventTypes = MULTIPLAYER_EVENT_TYPES,
    cursorStore = null,
    reconnectInitialMs = 500,
    reconnectMaxMs = 15_000,
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
    random = Math.random
  } = {}) {
    if (!apiClient || typeof apiClient.eventsUrl !== 'function') {
      throw new TypeError('apiClient.eventsUrl is required');
    }
    if (typeof eventSourceFactory !== 'function') {
      throw new TypeError('eventSourceFactory must be a function');
    }
    if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
      throw new TypeError('timer functions are required');
    }
    if (!Number.isSafeInteger(reconnectInitialMs) || reconnectInitialMs < 0
      || !Number.isSafeInteger(reconnectMaxMs) || reconnectMaxMs < reconnectInitialMs) {
      throw new TypeError('SSE reconnect bounds are invalid');
    }
    this.apiClient = apiClient;
    this.eventSourceFactory = eventSourceFactory;
    this.eventTypes = Object.freeze([...new Set(eventTypes)]);
    this.cursorStore = cursorStore;
    this.reconnectInitialMs = reconnectInitialMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.random = random;
    this.events = new ListenerSet();
    this.roomId = null;
    this.lastEventSeq = 0;
    this.source = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.generation = 0;
    this.stopped = true;
    this.status = 'idle';
  }

  on(type, listener) {
    return this.events.on(type, listener);
  }

  start(roomId, { afterEventSeq } = {}) {
    const nextRoomId = assertPathIdentifier(roomId, 'roomId');
    this.stop({ preserveListeners: true });
    this.roomId = nextRoomId;
    let stored = 0;
    if (typeof this.cursorStore?.load === 'function') {
      try {
        stored = this.cursorStore.load(nextRoomId);
      } catch (error) {
        this.events.emit('cursor-error', Object.freeze({
          operation: 'load',
          room_id: nextRoomId,
          message: error?.message ?? 'cursor load failed'
        }));
      }
    }
    this.lastEventSeq = Math.max(
      parseCursor(stored),
      parseCursor(afterEventSeq)
    );
    this.stopped = false;
    this.reconnectAttempt = 0;
    this._connect();
    return this;
  }

  stop({ preserveListeners = true } = {}) {
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close?.();
      this.source = null;
    }
    this._setStatus('closed');
    if (!preserveListeners) this.events.clear();
  }

  _setStatus(status, details = {}) {
    this.status = status;
    this.events.emit('status', Object.freeze({
      status,
      room_id: this.roomId,
      last_event_seq: this.lastEventSeq,
      ...details
    }));
  }

  _connect() {
    if (this.stopped || !this.roomId) return;
    const generation = ++this.generation;
    const url = this.apiClient.eventsUrl(this.roomId, this.lastEventSeq);
    const source = this.eventSourceFactory(url, { withCredentials: true });
    if (!source || typeof source.addEventListener !== 'function') {
      throw new TypeError('eventSourceFactory returned an invalid EventSource');
    }
    this.source = source;
    this._setStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting', { url });

    source.addEventListener('open', () => {
      if (generation !== this.generation || this.stopped) return;
      this.reconnectAttempt = 0;
      this._setStatus('open');
    });
    source.addEventListener('error', () => {
      if (generation !== this.generation || this.stopped) return;
      this.events.emit('transport-error', Object.freeze({
        room_id: this.roomId,
        last_event_seq: this.lastEventSeq
      }));
      source.close?.();
      if (this.source === source) this.source = null;
      this._scheduleReconnect(generation);
    });

    for (const eventType of this.eventTypes) {
      source.addEventListener(eventType, event => {
        if (generation !== this.generation || this.stopped) return;
        this._accept(event?.data, eventType);
      });
    }
    source.addEventListener('message', event => {
      if (generation !== this.generation || this.stopped) return;
      this._accept(event?.data, null);
    });
  }

  _accept(raw, expectedType) {
    let envelope;
    try {
      envelope = parseEnvelope(raw, this.roomId, expectedType);
    } catch (error) {
      this.events.emit('protocol-error', Object.freeze({
        message: error.message,
        room_id: this.roomId,
        last_event_seq: this.lastEventSeq
      }));
      return false;
    }
    if (envelope.event_seq <= this.lastEventSeq) {
      this.events.emit('duplicate', envelope);
      return false;
    }
    this.lastEventSeq = envelope.event_seq;
    if (typeof this.cursorStore?.save === 'function') {
      try {
        this.cursorStore.save(this.roomId, this.lastEventSeq);
      } catch (error) {
        this.events.emit('cursor-error', Object.freeze({
          operation: 'save',
          room_id: this.roomId,
          event_seq: this.lastEventSeq,
          message: error?.message ?? 'cursor save failed'
        }));
      }
    }
    this.events.emit('event', envelope);
    this.events.emit(envelope.event_type, envelope);
    return true;
  }

  _scheduleReconnect(generation) {
    if (generation !== this.generation || this.stopped || this.reconnectTimer !== null) return;
    const exponent = Math.min(this.reconnectAttempt, 16);
    const base = Math.min(
      this.reconnectMaxMs,
      this.reconnectInitialMs * (2 ** exponent)
    );
    const jitter = Math.floor(base * 0.2 * Math.max(0, Math.min(1, this.random())));
    const delay = Math.min(this.reconnectMaxMs, base + jitter);
    this.reconnectAttempt += 1;
    this._setStatus('reconnecting', { retry_in_ms: delay });
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      if (generation !== this.generation || this.stopped) return;
      this._connect();
    }, delay);
  }
}

export { parseEnvelope };
