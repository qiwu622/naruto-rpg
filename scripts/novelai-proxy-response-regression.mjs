import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import express from 'express';
import { ImageTransport, NovelAIImageAdapter } from '../js/core/image-studio/index.js';
import { createResponseCompression } from '../server/middleware/response-compression.js';

const image = Buffer.alloc(24);
image.set([137, 80, 78, 71, 13, 10, 26, 10]);
image.writeUInt32BE(512, 16); image.writeUInt32BE(768, 20);
let crc = 0xffffffff;
for (const byte of image) {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
}
crc = (crc ^ 0xffffffff) >>> 0;
const name = Buffer.from('image.png');
const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
local.writeUInt32LE(crc, 14); local.writeUInt32LE(image.length, 18);
local.writeUInt32LE(image.length, 22); local.writeUInt16LE(name.length, 26);
central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
central.writeUInt32LE(crc, 16); central.writeUInt32LE(image.length, 20);
central.writeUInt32LE(image.length, 24); central.writeUInt16LE(name.length, 28);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
end.writeUInt32LE(central.length + name.length, 12);
end.writeUInt32LE(local.length + name.length + image.length, 16);
const zip = Buffer.concat([local, name, image, central, name, end]);
let encoding = '', requests = 0;
// A local forward proxy supplies the entire upstream response. No request
// leaves loopback; the public target IP is only an SSRF-policy test fixture.
const upstream = http.createServer(async (request, response) => {
  assert.equal(request.url, 'http://93.184.216.34/ai/generate-image');
  for await (const _chunk of request) { /* consume the JSON request */ }
  requests++;
  response.setHeader('Content-Type', 'application/zip');
  if (encoding) response.setHeader('Content-Encoding', encoding);
  response.end(encoding === 'gzip' ? gzipSync(zip) : encoding === 'br' ? brotliCompressSync(zip) : zip);
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
process.env.NODE_ENV = 'test';
process.env.AUTH_BYPASS = 'false';
process.env.AI_PROXY_FORWARD_URL = `http://127.0.0.1:${upstream.address().port}`;
process.env.AI_PROXY_ALLOW_HTTP_TARGETS = '93.184.216.34';
process.env.AI_PROXY_RETRY_MAX_ATTEMPTS = '0';
const { default: proxyRouter } = await import('../server/api/ai-proxy.js');
const app = express();
app.use(createResponseCompression());
app.use('/api/ai-proxy', (_req, _res, next) => { _req.user = { id: 'image-wire-fixture' }; next(); }, express.json(), proxyRouter);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const adapter = new NovelAIImageAdapter(new ImageTransport({
  allowedPublicHttpOrigins: ['http://93.184.216.34'],
  fetchImpl: (url, options) => fetch(new URL(url, origin), options)
}));
const failures = [];
try {
  for (encoding of ['', 'gzip', 'br']) {
    const before = requests;
    try {
      const result = await adapter.generate({
        provider: { type: 'novelai', apiUrl: 'http://93.184.216.34', apiKey: 'fixture-token' }, prompt: 'landscape'
      });
      assert.deepEqual(Buffer.from(await result.images[0].blob.arrayBuffer()), image);
      assert.equal(requests - before, 1, 'no automatic regeneration');
      console.log(`PASS real project proxy preserves ${encoding || 'identity'} ZIP responses`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL ${encoding || 'identity'} ZIP response: ${error.message}`);
    }
  }
} finally {
  await Promise.all([server, upstream].map(listener => new Promise(resolve => {
    listener.close(resolve); listener.closeAllConnections();
  })));
}
assert.equal(failures.length, 0, `${failures.length} proxy encoding regressions failed`);
