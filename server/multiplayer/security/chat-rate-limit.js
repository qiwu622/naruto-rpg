import { DomainError } from '../domain/errors.js';

function fail(message, retryAfterMs) {
  throw new DomainError(
    'CHAT_RATE_LIMITED',
    message,
    { retry_after_ms: retryAfterMs },
    { status: 429 }
  );
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError(
      'CHAT_RATE_LIMIT_CONFIGURATION_INVALID',
      `${label} must be a positive safe integer`,
      {},
      { status: 500 }
    );
  }
  return value;
}

/** Single-instance member+room sliding-window limiter from section 18.2. */
export function createChatRateLimiter({
  clock = () => Date.now(),
  burst_limit = 10,
  burst_window_ms = 10_000,
  minute_limit = 60,
  minute_window_ms = 60_000
} = {}) {
  assertPositiveInteger(burst_limit, 'burst_limit');
  assertPositiveInteger(burst_window_ms, 'burst_window_ms');
  assertPositiveInteger(minute_limit, 'minute_limit');
  assertPositiveInteger(minute_window_ms, 'minute_window_ms');
  if (burst_window_ms > minute_window_ms || burst_limit > minute_limit) {
    throw new DomainError(
      'CHAT_RATE_LIMIT_CONFIGURATION_INVALID',
      'burst window and limit cannot exceed the minute window and limit',
      {},
      { status: 500 }
    );
  }

  const attemptsByScope = new Map();

  function consume({ authenticated_user_id, room_id }) {
    if (typeof authenticated_user_id !== 'string' || !authenticated_user_id
      || typeof room_id !== 'string' || !room_id) {
      throw new DomainError('CHAT_RATE_LIMIT_SCOPE_INVALID', 'chat rate-limit scope is invalid');
    }
    const now = Number(clock());
    if (!Number.isFinite(now)) {
      throw new DomainError(
        'CHAT_RATE_LIMIT_CONFIGURATION_INVALID',
        'chat rate-limit clock is invalid',
        {},
        { status: 500 }
      );
    }
    const key = `${authenticated_user_id}\u0000${room_id}`;
    const previous = attemptsByScope.get(key) ?? [];
    const retained = previous.filter(timestamp => now - timestamp < minute_window_ms);
    if (retained.length >= minute_limit) {
      const retryAfter = Math.max(1, minute_window_ms - (now - retained[0]));
      fail('chat minute rate limit exceeded', retryAfter);
    }
    const burst = retained.filter(timestamp => now - timestamp < burst_window_ms);
    if (burst.length >= burst_limit) {
      const retryAfter = Math.max(1, burst_window_ms - (now - burst[0]));
      fail('chat burst rate limit exceeded', retryAfter);
    }
    retained.push(now);
    attemptsByScope.set(key, retained);
    return Object.freeze({ remaining_minute: minute_limit - retained.length });
  }

  function middleware(req, res, next) {
    try {
      consume({
        authenticated_user_id: String(req.user?.id ?? ''),
        room_id: String(req.params?.roomId ?? '')
      });
      next();
    } catch (error) {
      if (error?.status === 429 && Number.isFinite(error.details?.retry_after_ms)) {
        res.setHeader?.('Retry-After', String(Math.ceil(error.details.retry_after_ms / 1000)));
      }
      next(error);
    }
  }

  return Object.freeze({ consume, middleware });
}
