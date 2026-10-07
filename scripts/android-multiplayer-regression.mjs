import assert from 'node:assert/strict';
import { MultiplayerApiClient, defaultMultiplayerRequestHeaders } from '../js/multiplayer/api-client.js';
import { NativeRoomEventSource } from '../js/multiplayer/native-room-event-source.js';
import { MultiplayerRoomEventStream } from '../js/multiplayer/room-event-stream.js';
const prior = { capacitor: globalThis.Capacitor, storage: globalThis.localStorage, fetch: globalThis.fetch, document: globalThis.document };
const requests = [], cancellations = [];
const values = new Map();
globalThis.localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, String(value)) };
globalThis.document = { cookie: '' };
globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
  NarutoHttp: { async cancel({ id }) { cancellations.push(id); }, async request(options, callback) {
    requests.push(options);
    callback({ type: 'headers', status: 200, url: options.url, headers: { 'content-type': 'application/json' } });
    callback({ type: 'data', data: Buffer.from('{"room_id":"room-native","ready":true}').toString('base64') });
    callback({ type: 'end' });
  } }
} };
try {
  const api = new MultiplayerApiClient();
  assert.equal((await api.getRoom('room-native')).room_id, 'room-native');
  await api.request('/rooms/room-native/fixture', { method: 'POST', body: { idempotency_key: 'native-fixture' } });
  assert.ok(requests.every(value => value.url.startsWith('https://www.qiwu.asia/api/multiplayer/')));
  assert.ok(requests.every(value => value.cloud === true && !value.headers.authorization && !value.headers['x-csrf-token']));
  assert.deepEqual(defaultMultiplayerRequestHeaders({ method: 'POST' }), {});
  console.log('PASS Android multiplayer reads and mutations use the native cloud bridge without browser cookies or JS-held credentials');

  const encoder = new TextEncoder();
  const frames = [
    ': heartbeat\r\n\r\n',
    'event: room.snapshot\r\ndata: {"room_id":"room-native",\r\ndata: "event_seq":1,"event_id":"native-1","event_type":"room.snapshot","payload":{"text":"木叶"}}\r\n\r\n',
    'event: room.snapshot\ndata: {"room_id":"room-native","event_seq":1,"event_id":"native-1","event_type":"room.snapshot","payload":{}}\n\n',
    'event: room.snapshot\ndata: {"room_id":"room-native","event_seq":2,"event_id":"native-2","event_type":"room.snapshot","payload":{}}\n\n'
  ].join('');
  let cancelCount = 0, source, eventUrl;
  const received = [];
  const stream = new MultiplayerRoomEventStream({ apiClient: api, eventSourceFactory: url => {
    source = new NativeRoomEventSource(url, { fetchImpl: async (url, options) => {
      eventUrl = url;
      assert.equal(options.headers.Accept, 'text/event-stream');
      return new Response(new ReadableStream({ start(controller) {
        const bytes = encoder.encode(frames);
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
      }, cancel() { cancelCount++; } }), { headers: { 'content-type': 'text/event-stream' } });
    } }); return source;
  } });
  const complete = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native SSE timed out')), 2000);
    stream.on('event', event => { received.push(event); if (event.event_seq === 2) { clearTimeout(timeout); resolve(); } });
  });
  stream.start('room-native'); await complete;
  assert.equal(eventUrl, 'https://www.qiwu.asia/api/multiplayer/rooms/room-native/events?after=0');
  assert.deepEqual(received.map(value => value.event_seq), [1, 2]);
  assert.equal(received[0].payload.text, '木叶');
  stream.stop(); await source.task; assert.equal(cancelCount, 1);
  console.log('PASS native SSE handles split Unicode, CRLF, comments, multiline data, cursor de-duplication and cancellation');

  values.set('naruto_app_cloud_enabled', 'false');
  const beforePause = requests.length;
  await assert.rejects(api.getRoom('room-native'), error => error.code === 'MULTIPLAYER_NETWORK_ERROR');
  assert.equal(requests.length, beforePause);
  const paused = new NativeRoomEventSource('/api/multiplayer/rooms/room-native/events?after=2');
  let failed = false; paused.addEventListener('error', () => { failed = true; }); await paused.task; assert.equal(failed, true); paused.close();
  assert.throws(() => new NativeRoomEventSource('https://evil.invalid/events'), /地址无效/);
  console.log('PASS paused cloud sends no native request and event endpoints cannot target another origin');
  globalThis.Capacitor = undefined;
  globalThis.fetch = async (url, init) => { requests.push({ web: true, url, init }); return Response.json({ room_id: 'web-room' }); };
  assert.equal((await api.getRoom('web-room')).room_id, 'web-room');
  assert.equal(requests.at(-1).url, '/api/multiplayer/rooms/web-room');
  assert.throws(() => defaultMultiplayerRequestHeaders({ method: 'POST' }), /naruto_csrf/);
  console.log('PASS the website retains same-origin requests and its existing CSRF boundary');
} finally {
  for (const [key, value] of Object.entries({ Capacitor: prior.capacitor, localStorage: prior.storage, fetch: prior.fetch, document: prior.document })) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
}
console.log('Android multiplayer regression: 4 groups passed; no model calls.');
