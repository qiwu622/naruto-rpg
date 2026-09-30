import { DomainError } from '../domain/errors.js';

const ROOM_ID_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const MAX_REPLAY_PAGE = 500;

function fail(code, message, status = 400) {
  throw new DomainError(code, message, {}, { status });
}

function parseCursor(value, label) {
  if (value === undefined || value === null || value === '') return 0;
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) {
    fail('ROOM_EVENT_CURSOR_INVALID', `${label} must be a non-negative integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    fail('ROOM_EVENT_CURSOR_INVALID', `${label} exceeds the safe integer range`);
  }
  return parsed;
}

function eventEnvelope(event) {
  return {
    event_id: event.event_id,
    room_id: event.room_id,
    event_seq: event.event_seq,
    epoch_id: event.epoch_id ?? null,
    turn_id: event.turn_id ?? null,
    event_type: event.event_type,
    projection_version: event.projection_version,
    payload: event.payload,
    payload_hash: event.payload_hash,
    created_at: event.created_at ?? null
  };
}

function memberSeat(member) {
  return member?.seat ?? member?.seat_id ?? null;
}

export function serializeRoomEventSse(event) {
  if (!event || !Number.isSafeInteger(event.event_seq) || event.event_seq < 1
    || typeof event.event_type !== 'string'
    || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(event.event_type)) {
    fail('ROOM_EVENT_INVALID', 'room event cannot be serialized to SSE', 500);
  }
  const data = JSON.stringify(eventEnvelope(event));
  return `id: ${event.event_seq}\nevent: ${event.event_type}\ndata: ${data}\n\n`;
}

function assertDependencies({ repositories, event_hub }) {
  if (typeof repositories?.members?.resolve !== 'function'
    || typeof repositories?.events?.listAfter !== 'function') {
    fail('ROOM_EVENT_STREAM_CONFIGURATION_INVALID', 'member and event repositories are required', 500);
  }
  if (typeof event_hub?.subscribe !== 'function') {
    fail('ROOM_EVENT_STREAM_CONFIGURATION_INVALID', 'room event hub is required', 500);
  }
}

/**
 * Express-compatible SSE handler. It subscribes before replay, buffers live
 * notifications during the database catch-up, and sends every projection in
 * event_seq order. Membership/session authority is rechecked before every
 * event and heartbeat so an expired or revoked connection stops receiving
 * data without needing a process restart.
 */
export function createRoomEventStreamHandler({
  repositories,
  event_hub,
  session_authorizer = async () => true,
  heartbeat_ms = 15_000,
  replay_page_size = 200,
  on_error = () => {}
}) {
  assertDependencies({ repositories, event_hub });
  if (typeof session_authorizer !== 'function' || typeof on_error !== 'function') {
    fail('ROOM_EVENT_STREAM_CONFIGURATION_INVALID', 'stream callbacks must be functions', 500);
  }
  if (!Number.isSafeInteger(heartbeat_ms) || heartbeat_ms < 1_000) {
    fail('ROOM_EVENT_STREAM_CONFIGURATION_INVALID', 'heartbeat_ms must be at least 1000', 500);
  }
  if (!Number.isSafeInteger(replay_page_size)
    || replay_page_size < 1
    || replay_page_size > MAX_REPLAY_PAGE) {
    fail('ROOM_EVENT_STREAM_CONFIGURATION_INVALID', 'replay_page_size is invalid', 500);
  }

  return async function roomEventStream(req, res, next = () => {}) {
    const roomId = req.params?.roomId;
    if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
      return next(new DomainError('ROOM_ID_INVALID', 'roomId is invalid'));
    }
    const authenticatedUserId = String(req.user?.id ?? '');
    if (!authenticatedUserId) {
      return next(new DomainError('AUTHENTICATION_REQUIRED', 'authentication is required', {}, {
        status: 401
      }));
    }

    let cursor;
    try {
      const queryCursor = parseCursor(req.query?.after, 'after');
      const headerCursor = parseCursor(req.get?.('Last-Event-ID') ?? req.headers?.['last-event-id'], 'Last-Event-ID');
      cursor = Math.max(queryCursor, headerCursor);
    } catch (error) {
      return next(error);
    }

    let member;
    try {
      const sessionAllowed = await session_authorizer(req);
      if (!sessionAllowed) fail('AUTHENTICATION_EXPIRED', 'authentication is no longer valid', 401);
      member = await repositories.members.resolve({
        authenticated_user_id: authenticatedUserId,
        room_id: roomId
      });
    } catch (error) {
      return next(error);
    }

    res.status?.(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    let replaying = true;
    let lastSent = cursor;
    let writeChain = Promise.resolve();
    const bufferedLiveEvents = new Map();

    const close = reason => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription.unsubscribe(reason);
      if (!res.writableEnded) res.end();
    };

    const authorize = async () => {
      if (closed) return false;
      if (Number.isFinite(req.authExpiresAt) && Date.now() >= req.authExpiresAt) return false;
      if (!await session_authorizer(req)) return false;
      try {
        const current = await repositories.members.resolve({
          authenticated_user_id: authenticatedUserId,
          room_id: roomId
        });
        return memberSeat(current) === memberSeat(member);
      } catch {
        return false;
      }
    };

    const writeEvent = async event => {
      if (closed || event.event_seq <= lastSent) return;
      if (!await authorize()) {
        close('authority_revoked');
        return;
      }
      if (!res.write(serializeRoomEventSse(event))) {
        // Backpressure is handled by Node's response buffer. Ordering remains
        // serialized by writeChain; a closed socket is removed by close events.
      }
      lastSent = event.event_seq;
    };

    const enqueue = event => {
      if (closed || event.event_seq <= lastSent) return false;
      writeChain = writeChain.then(() => writeEvent(event)).catch(error => {
        on_error(error, { room_id: roomId, event_seq: event.event_seq });
        close('stream_error');
      });
      return true;
    };

    const subscription = event_hub.subscribe({
      room_id: roomId,
      seat: memberSeat(member),
      on_event(event) {
        if (closed) return false;
        if (event.event_seq <= lastSent) return true;
        if (replaying) {
          bufferedLiveEvents.set(event.event_seq, event);
          return true;
        }
        return enqueue(event);
      },
      on_close(_reason) {
        if (!closed) {
          closed = true;
          clearInterval(heartbeat);
          if (!res.writableEnded) res.end();
        }
      }
    });

    const heartbeat = setInterval(() => {
      writeChain = writeChain.then(async () => {
        if (!await authorize()) {
          close('authority_revoked');
          return;
        }
        res.write(`: keep-alive ${Date.now()}\n\n`);
      }).catch(error => {
        on_error(error, { room_id: roomId, phase: 'heartbeat' });
        close('stream_error');
      });
    }, heartbeat_ms);
    heartbeat.unref?.();

    req.once?.('close', () => close('request_closed'));
    res.once?.('close', () => close('response_closed'));

    try {
      let replayCursor = cursor;
      while (!closed) {
        const page = await repositories.events.listAfter({
          authenticated_user_id: authenticatedUserId,
          room_id: roomId,
          after_event_seq: replayCursor,
          limit: replay_page_size
        });
        for (const event of page) {
          await writeEvent(event);
          replayCursor = Math.max(replayCursor, event.event_seq);
        }
        if (page.length < replay_page_size) break;
      }
      replaying = false;
      for (const event of [...bufferedLiveEvents.values()].sort((left, right) => (
        left.event_seq - right.event_seq
      ))) {
        enqueue(event);
      }
      bufferedLiveEvents.clear();
      await writeChain;
    } catch (error) {
      on_error(error, { room_id: roomId, phase: 'replay' });
      close('stream_error');
    }
  };
}
