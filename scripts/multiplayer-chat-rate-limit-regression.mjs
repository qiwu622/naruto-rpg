import assert from 'node:assert/strict';

import { createChatRateLimiter } from '../server/multiplayer/security/chat-rate-limit.js';

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}

test('ten messages in ten seconds are accepted and the eleventh is rejected', () => {
  let now = 0;
  const limiter = createChatRateLimiter({ clock: () => now });
  for (let index = 0; index < 10; index += 1) {
    limiter.consume({ authenticated_user_id: '100000000000000001', room_id: 'room_1' });
  }
  assert.throws(
    () => limiter.consume({ authenticated_user_id: '100000000000000001', room_id: 'room_1' }),
    error => error.code === 'CHAT_RATE_LIMITED'
      && error.status === 429
      && error.details.retry_after_ms === 10_000
  );
  now = 10_000;
  assert.doesNotThrow(() => limiter.consume({
    authenticated_user_id: '100000000000000001',
    room_id: 'room_1'
  }));
});

test('member and room scopes are independent', () => {
  const limiter = createChatRateLimiter({
    clock: () => 0,
    burst_limit: 1,
    minute_limit: 2
  });
  limiter.consume({ authenticated_user_id: '100000000000000001', room_id: 'room_1' });
  assert.doesNotThrow(() => limiter.consume({
    authenticated_user_id: '100000000000000002',
    room_id: 'room_1'
  }));
  assert.doesNotThrow(() => limiter.consume({
    authenticated_user_id: '100000000000000001',
    room_id: 'room_2'
  }));
});

test('minute window is enforced independently of the shorter burst window', () => {
  let now = 0;
  const limiter = createChatRateLimiter({
    clock: () => now,
    burst_limit: 2,
    burst_window_ms: 1_000,
    minute_limit: 3,
    minute_window_ms: 60_000
  });
  limiter.consume({ authenticated_user_id: '100000000000000001', room_id: 'room_1' });
  now = 1_000;
  limiter.consume({ authenticated_user_id: '100000000000000001', room_id: 'room_1' });
  now = 2_000;
  limiter.consume({ authenticated_user_id: '100000000000000001', room_id: 'room_1' });
  now = 3_000;
  assert.throws(
    () => limiter.consume({ authenticated_user_id: '100000000000000001', room_id: 'room_1' }),
    error => error.code === 'CHAT_RATE_LIMITED' && error.details.retry_after_ms === 57_000
  );
});

console.log(`\n${passed} multiplayer chat rate-limit regression tests passed.`);
