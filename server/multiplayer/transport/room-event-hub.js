import { DomainError } from '../domain/errors.js';

const ROOM_ID_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const EVENT_AUDIENCES = new Set(['A', 'B', 'BOTH', 'SERVER']);
const MEMBER_SEATS = new Set(['A', 'B']);

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details);
}

function assertRoomId(value) {
  if (typeof value !== 'string' || !ROOM_ID_PATTERN.test(value)) {
    fail('ROOM_EVENT_INVALID', 'room event room_id is invalid');
  }
  return value;
}

function assertSeat(value) {
  if (!MEMBER_SEATS.has(value)) {
    fail('ROOM_EVENT_SUBSCRIBER_INVALID', 'room event subscriber seat must be A or B');
  }
  return value;
}

function assertEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('ROOM_EVENT_INVALID', 'room event must be an object');
  }
  assertRoomId(value.room_id);
  if (typeof value.event_id !== 'string' || !ROOM_ID_PATTERN.test(value.event_id)) {
    fail('ROOM_EVENT_INVALID', 'room event event_id is invalid');
  }
  if (!Number.isSafeInteger(value.event_seq) || value.event_seq < 1) {
    fail('ROOM_EVENT_INVALID', 'room event event_seq must be a positive safe integer');
  }
  if (typeof value.event_type !== 'string' || value.event_type.length < 1) {
    fail('ROOM_EVENT_INVALID', 'room event event_type is required');
  }
  if (!EVENT_AUDIENCES.has(value.audience)) {
    fail('ROOM_EVENT_INVALID', 'room event audience is invalid');
  }
  return value;
}

function isVisibleToSeat(audience, seat) {
  return audience === 'BOTH' || audience === seat;
}

/**
 * Process-local notification fan-out for the documented single-instance
 * topology. The database room_events stream remains the source of truth;
 * subscribers always recover missed or duplicate notifications by event_seq.
 */
export function createRoomEventHub() {
  const subscribersByRoom = new Map();
  let nextSubscriberId = 1;
  let closed = false;

  function subscribe({ room_id, seat, on_event, on_close = undefined }) {
    if (closed) fail('ROOM_EVENT_HUB_CLOSED', 'room event hub is closed');
    const roomId = assertRoomId(room_id);
    const memberSeat = assertSeat(seat);
    if (typeof on_event !== 'function') {
      fail('ROOM_EVENT_SUBSCRIBER_INVALID', 'room event subscriber requires on_event');
    }
    if (on_close !== undefined && typeof on_close !== 'function') {
      fail('ROOM_EVENT_SUBSCRIBER_INVALID', 'room event subscriber on_close must be a function');
    }

    const subscriber = Object.freeze({
      subscriber_id: nextSubscriberId++,
      room_id: roomId,
      seat: memberSeat,
      on_event,
      on_close
    });
    let roomSubscribers = subscribersByRoom.get(roomId);
    if (!roomSubscribers) {
      roomSubscribers = new Map();
      subscribersByRoom.set(roomId, roomSubscribers);
    }
    roomSubscribers.set(subscriber.subscriber_id, subscriber);

    let active = true;
    return Object.freeze({
      subscriber_id: subscriber.subscriber_id,
      unsubscribe(reason = 'subscriber_closed') {
        if (!active) return false;
        active = false;
        const current = subscribersByRoom.get(roomId);
        current?.delete(subscriber.subscriber_id);
        if (current?.size === 0) subscribersByRoom.delete(roomId);
        subscriber.on_close?.(reason);
        return true;
      }
    });
  }

  async function publish(eventValue) {
    const event = assertEvent(eventValue);
    if (closed || event.audience === 'SERVER') {
      return Object.freeze({ delivered: 0, disconnected: 0 });
    }
    const roomSubscribers = subscribersByRoom.get(event.room_id);
    if (!roomSubscribers?.size) {
      return Object.freeze({ delivered: 0, disconnected: 0 });
    }

    let delivered = 0;
    let disconnected = 0;
    const targets = [...roomSubscribers.values()].filter(subscriber => (
      isVisibleToSeat(event.audience, subscriber.seat)
    ));
    const outcomes = await Promise.allSettled(targets.map(subscriber => (
      Promise.resolve().then(() => subscriber.on_event(event))
    )));
    outcomes.forEach((outcome, index) => {
      const subscriber = targets[index];
      if (outcome.status === 'fulfilled' && outcome.value !== false) {
        delivered += 1;
        return;
      }
      disconnected += 1;
      roomSubscribers.delete(subscriber.subscriber_id);
      try {
        subscriber.on_close?.('delivery_failed');
      } catch {
        // A broken connection cleanup hook cannot block durable outbox progress.
      }
    });
    if (roomSubscribers.size === 0) subscribersByRoom.delete(event.room_id);
    return Object.freeze({ delivered, disconnected });
  }

  function close(reason = 'hub_closed') {
    if (closed) return false;
    closed = true;
    for (const roomSubscribers of subscribersByRoom.values()) {
      for (const subscriber of roomSubscribers.values()) {
        try {
          subscriber.on_close?.(reason);
        } catch {
          // Continue closing every subscriber.
        }
      }
    }
    subscribersByRoom.clear();
    return true;
  }

  function stats() {
    let subscriberCount = 0;
    for (const subscribers of subscribersByRoom.values()) {
      subscriberCount += subscribers.size;
    }
    return Object.freeze({
      closed,
      rooms: subscribersByRoom.size,
      subscribers: subscriberCount
    });
  }

  return Object.freeze({ subscribe, publish, close, stats });
}

export { isVisibleToSeat };
