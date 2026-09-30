import assert from 'node:assert/strict';

import { createOutboxDispatcher } from '../server/multiplayer/transport/outbox-dispatcher.js';
import {
  createRoomEventHub,
  isVisibleToSeat
} from '../server/multiplayer/transport/room-event-hub.js';

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function event(overrides = {}) {
  return Object.freeze({
    outbox_id: 'outbox_1',
    room_id: 'room_1',
    event_id: 'event_1',
    event_seq: 1,
    event_type: 'turn.opened',
    audience: 'BOTH',
    projection_version: 'naruto.multiplayer-room-event-projection/v1',
    payload: Object.freeze({ turn_no: 1 }),
    payload_hash: `sha256:${'a'.repeat(64)}`,
    lease_fence: 1,
    attempt_count: 1,
    lease_expires_at: '2026-08-22T00:00:15.000Z',
    ...overrides
  });
}

function fakeOutbox(items, { failMarkOnce = false } = {}) {
  const rows = items.map(item => ({ ...item, status: 'PENDING', fence: 0 }));
  let shouldFailMark = failMarkOnce;
  return {
    rows,
    async claim({ dispatcher_owner_id, expires_at, limit }) {
      return rows.filter(row => row.status === 'PENDING').slice(0, limit).map(row => {
        row.status = 'CLAIMED';
        row.owner = dispatcher_owner_id;
        row.fence += 1;
        return Object.freeze({
          ...row,
          lease_fence: row.fence,
          attempt_count: row.fence,
          lease_expires_at: expires_at
        });
      });
    },
    async markDispatched({ outbox_id, dispatcher_owner_id, lease_fence }) {
      const row = rows.find(candidate => candidate.outbox_id === outbox_id);
      if (shouldFailMark) {
        shouldFailMark = false;
        throw new Error('injected crash after publish and before dispatched marker');
      }
      assert.equal(row.status, 'CLAIMED');
      assert.equal(row.owner, dispatcher_owner_id);
      assert.equal(row.fence, lease_fence);
      row.status = 'DISPATCHED';
    },
    async release({ outbox_id, dispatcher_owner_id, lease_fence }) {
      const row = rows.find(candidate => candidate.outbox_id === outbox_id);
      assert.equal(row.status, 'CLAIMED');
      assert.equal(row.owner, dispatcher_owner_id);
      assert.equal(row.fence, lease_fence);
      row.status = 'PENDING';
      row.owner = null;
    }
  };
}

await test('audience predicate never sends SERVER or the opposite private projection', () => {
  assert.equal(isVisibleToSeat('A', 'A'), true);
  assert.equal(isVisibleToSeat('A', 'B'), false);
  assert.equal(isVisibleToSeat('BOTH', 'B'), true);
  assert.equal(isVisibleToSeat('SERVER', 'A'), false);
});

await test('room hub fans out only final per-seat projections and removes broken subscribers', async () => {
  const hub = createRoomEventHub();
  const seenA = [];
  const seenB = [];
  hub.subscribe({ room_id: 'room_1', seat: 'A', on_event: value => seenA.push(value.event_seq) });
  hub.subscribe({ room_id: 'room_1', seat: 'B', on_event: value => seenB.push(value.event_seq) });
  hub.subscribe({ room_id: 'room_1', seat: 'B', on_event: () => false });
  assert.deepEqual(await hub.publish(event({ audience: 'A' })), { delivered: 1, disconnected: 0 });
  assert.deepEqual(await hub.publish(event({ event_id: 'event_2', event_seq: 2 })), {
    delivered: 2,
    disconnected: 1
  });
  assert.deepEqual(seenA, [1, 2]);
  assert.deepEqual(seenB, [2]);
  assert.deepEqual(hub.stats(), { closed: false, rooms: 1, subscribers: 2 });
});

await test('a committed pending row is delivered and fenced DISPATCHED by one dispatcher pass', async () => {
  const hub = createRoomEventHub();
  const seen = [];
  hub.subscribe({ room_id: 'room_1', seat: 'A', on_event: value => seen.push(value.event_id) });
  const outbox = fakeOutbox([event()]);
  const dispatcher = createOutboxDispatcher({
    outbox,
    event_hub: hub,
    dispatcher_owner_id: 'dispatcher_test',
    clock: () => '2026-08-22T00:00:00.000Z'
  });
  assert.deepEqual(await dispatcher.dispatchOnce(), { claimed: 1, dispatched: 1, released: 0 });
  assert.deepEqual(seen, ['event_1']);
  assert.equal(outbox.rows[0].status, 'DISPATCHED');
});

await test('publish-before-marker failure is safely repeated and event_seq makes replay idempotent', async () => {
  const hub = createRoomEventHub();
  const rawDeliveries = [];
  const applied = new Set();
  hub.subscribe({
    room_id: 'room_1',
    seat: 'A',
    on_event: value => {
      rawDeliveries.push(value.event_seq);
      applied.add(value.event_seq);
    }
  });
  const outbox = fakeOutbox([event()], { failMarkOnce: true });
  const errors = [];
  const dispatcher = createOutboxDispatcher({
    outbox,
    event_hub: hub,
    dispatcher_owner_id: 'dispatcher_test',
    clock: () => '2026-08-22T00:00:00.000Z',
    on_error: error => errors.push(error.message)
  });
  assert.deepEqual(await dispatcher.dispatchOnce(), { claimed: 1, dispatched: 0, released: 1 });
  assert.equal(outbox.rows[0].status, 'PENDING');
  assert.deepEqual(await dispatcher.dispatchOnce(), { claimed: 1, dispatched: 1, released: 0 });
  assert.deepEqual(rawDeliveries, [1, 1]);
  assert.deepEqual([...applied], [1]);
  assert.equal(outbox.rows[0].status, 'DISPATCHED');
  assert.equal(errors.length, 1);
});

await test('SERVER events drain durably without reaching any member connection', async () => {
  const hub = createRoomEventHub();
  const seen = [];
  hub.subscribe({ room_id: 'room_1', seat: 'A', on_event: value => seen.push(value) });
  const outbox = fakeOutbox([event({ audience: 'SERVER' })]);
  const dispatcher = createOutboxDispatcher({
    outbox,
    event_hub: hub,
    dispatcher_owner_id: 'dispatcher_test',
    clock: () => '2026-08-22T00:00:00.000Z'
  });
  assert.deepEqual(await dispatcher.dispatchOnce(), { claimed: 1, dispatched: 1, released: 0 });
  assert.deepEqual(seen, []);
});

console.log(`\n${passed} multiplayer outbox dispatcher regression tests passed.`);
