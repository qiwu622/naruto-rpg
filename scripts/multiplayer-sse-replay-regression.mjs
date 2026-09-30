import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { responseCompressionFilter } from '../server/middleware/response-compression.js';
import { createRoomEventHub } from '../server/multiplayer/transport/room-event-hub.js';
import {
  createRoomEventStreamHandler,
  serializeRoomEventSse
} from '../server/multiplayer/transport/room-events-sse.js';

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function event(sequence, overrides = {}) {
  return Object.freeze({
    event_id: `event_${sequence}`,
    room_id: 'room_1',
    event_seq: sequence,
    epoch_id: 'epoch_1',
    turn_id: 'turn_1',
    event_type: 'turn.opened',
    audience: 'BOTH',
    projection_version: 'naruto.multiplayer-room-event-projection/v1',
    payload: Object.freeze({ sequence }),
    payload_hash: `sha256:${String(sequence).padStart(64, '0')}`,
    created_at: '2026-08-22T00:00:00.000Z',
    ...overrides
  });
}

class FakeRequest extends EventEmitter {
  constructor({ after = undefined, lastEventId = undefined } = {}) {
    super();
    this.params = { roomId: 'room_1' };
    this.query = after === undefined ? {} : { after };
    this.headers = lastEventId === undefined ? {} : { 'last-event-id': lastEventId };
    this.user = { id: '100000000000000001' };
    this.authExpiresAt = Infinity;
  }

  get(name) {
    return this.headers[name.toLowerCase()];
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.chunks = [];
    this.writableEnded = false;
    this.statusCode = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders() {}

  write(chunk) {
    if (this.writableEnded) throw new Error('write after end');
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    if (this.writableEnded) return;
    this.writableEnded = true;
  }
}

function parseSequences(response) {
  return response.chunks
    .flatMap(chunk => [...chunk.matchAll(/^id: (\d+)$/gmu)].map(match => Number(match[1])));
}

function createRepositories({ events, hub, publishDuringFirstReplay = null, authority = () => true }) {
  let firstReplay = true;
  return {
    members: {
      resolve() {
        if (!authority()) throw new Error('membership revoked');
        return { seat: 'A' };
      }
    },
    events: {
      async listAfter({ after_event_seq, limit }) {
        if (firstReplay && publishDuringFirstReplay) {
          firstReplay = false;
          await hub.publish(publishDuringFirstReplay);
        }
        return events.filter(item => item.event_seq > after_event_seq).slice(0, limit);
      }
    }
  };
}

await test('multiplayer event streams bypass response compression buffering', () => {
  assert.equal(responseCompressionFilter({
    originalUrl: '/api/multiplayer/rooms/room_1/events?after=7'
  }, {}), false);
});

await test('SSE serializer uses event_seq as the durable client deduplication ID', () => {
  const serialized = serializeRoomEventSse(event(7));
  assert.match(serialized, /^id: 7\nevent: turn\.opened\ndata: /u);
  assert.match(serialized, /"event_seq":7/u);
  assert.equal(serialized.endsWith('\n\n'), true);
});

await test('stream subscribes before replay and orders a racing live event after catch-up', async () => {
  const hub = createRoomEventHub();
  const repositories = createRepositories({
    events: [event(1), event(2)],
    hub,
    publishDuringFirstReplay: event(3)
  });
  const handler = createRoomEventStreamHandler({
    repositories,
    event_hub: hub,
    heartbeat_ms: 60_000,
    replay_page_size: 10
  });
  const req = new FakeRequest();
  const res = new FakeResponse();
  await handler(req, res, error => { throw error; });
  assert.deepEqual(parseSequences(res), [1, 2, 3]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  await hub.publish(event(4));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(parseSequences(res), [1, 2, 3, 4]);
  req.emit('close');
  assert.equal(res.writableEnded, true);
});

await test('Last-Event-ID and query cursor replay only unseen audience projections', async () => {
  const hub = createRoomEventHub();
  const repositories = createRepositories({ events: [event(1), event(2), event(3)], hub });
  const handler = createRoomEventStreamHandler({
    repositories,
    event_hub: hub,
    heartbeat_ms: 60_000
  });
  const req = new FakeRequest({ after: '1', lastEventId: '2' });
  const res = new FakeResponse();
  await handler(req, res, error => { throw error; });
  assert.deepEqual(parseSequences(res), [3]);
  await hub.publish(event(3));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(parseSequences(res), [3]);
  req.emit('close');
});

await test('membership revocation closes an existing stream before the next event is written', async () => {
  const hub = createRoomEventHub();
  let allowed = true;
  const repositories = createRepositories({ events: [], hub, authority: () => allowed });
  const handler = createRoomEventStreamHandler({
    repositories,
    event_hub: hub,
    heartbeat_ms: 60_000
  });
  const req = new FakeRequest();
  const res = new FakeResponse();
  await handler(req, res, error => { throw error; });
  allowed = false;
  await hub.publish(event(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(parseSequences(res), []);
  assert.equal(res.writableEnded, true);
  assert.equal(hub.stats().subscribers, 0);
});

await test('expired live session closes before receiving a newly dispatched event', async () => {
  const hub = createRoomEventHub();
  const repositories = createRepositories({ events: [], hub });
  const handler = createRoomEventStreamHandler({
    repositories,
    event_hub: hub,
    heartbeat_ms: 60_000
  });
  const req = new FakeRequest();
  const res = new FakeResponse();
  await handler(req, res, error => { throw error; });
  req.authExpiresAt = Date.now() - 1;
  await hub.publish(event(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(parseSequences(res), []);
  assert.equal(res.writableEnded, true);
});

console.log(`\n${passed} multiplayer SSE replay regression tests passed.`);
