import assert from 'node:assert/strict';

import {
  enforceMultiplayerRequestBoundary,
  safeTokenEqual
} from '../server/multiplayer/security/request-guards.js';

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function request({
  method = 'POST',
  authSource = 'cookie',
  origin = 'https://game.example',
  host = 'game.example',
  csrfCookie = 'a'.repeat(64),
  csrfHeader = 'a'.repeat(64),
  fetchSite = 'same-origin'
} = {}) {
  const headers = { host };
  if (origin !== null) headers.origin = origin;
  if (csrfHeader !== null) headers['x-csrf-token'] = csrfHeader;
  if (fetchSite !== null) headers['sec-fetch-site'] = fetchSite;
  return {
    method,
    protocol: 'https',
    authSource,
    headers,
    cookies: csrfCookie === null ? {} : { naruto_csrf: csrfCookie },
    get(name) { return headers[name.toLowerCase()]; }
  };
}

test('same-origin cookie write requires and accepts a constant-time double-submit token', () => {
  assert.equal(enforceMultiplayerRequestBoundary(request()), true);
  assert.equal(safeTokenEqual('abc', 'abc'), true);
  assert.equal(safeTokenEqual('abc', 'abd'), false);
});

test('same-origin comparison preserves a non-default externally forwarded port', () => {
  assert.equal(enforceMultiplayerRequestBoundary(request({
    origin: 'https://www.qiwu.asia:8080',
    host: 'www.qiwu.asia:8080'
  })), true);
  assert.throws(
    () => enforceMultiplayerRequestBoundary(request({
      origin: 'https://www.qiwu.asia:8080',
      host: 'www.qiwu.asia'
    })),
    error => error.code === 'CROSS_ORIGIN_REQUEST_FORBIDDEN'
  );
});

test('cookie mutation without Origin is rejected even when the CSRF values match', () => {
  assert.throws(
    () => enforceMultiplayerRequestBoundary(request({ origin: null })),
    error => error.code === 'CSRF_ORIGIN_REQUIRED' && error.status === 403
  );
});

test('cookie mutation with a missing or mismatched token is rejected', () => {
  assert.throws(
    () => enforceMultiplayerRequestBoundary(request({ csrfHeader: null })),
    error => error.code === 'CSRF_TOKEN_INVALID'
  );
  assert.throws(
    () => enforceMultiplayerRequestBoundary(request({ csrfHeader: 'b'.repeat(64) })),
    error => error.code === 'CSRF_TOKEN_INVALID'
  );
});

test('cross-origin and Sec-Fetch-Site cross-site requests fail for reads and writes', () => {
  assert.throws(
    () => enforceMultiplayerRequestBoundary(request({ origin: 'https://evil.example' })),
    error => error.code === 'CROSS_ORIGIN_REQUEST_FORBIDDEN'
  );
  assert.throws(
    () => enforceMultiplayerRequestBoundary(request({ method: 'GET', fetchSite: 'cross-site' })),
    error => error.code === 'CROSS_ORIGIN_REQUEST_FORBIDDEN'
  );
});

test('bearer mutations are non-ambient but still reject an explicit foreign Origin', () => {
  assert.equal(enforceMultiplayerRequestBoundary(request({
    authSource: 'bearer',
    origin: null,
    csrfCookie: null,
    csrfHeader: null,
    fetchSite: null
  })), true);
  assert.throws(
    () => enforceMultiplayerRequestBoundary(request({
      authSource: 'bearer',
      origin: 'https://evil.example',
      csrfCookie: null,
      csrfHeader: null
    })),
    error => error.code === 'CROSS_ORIGIN_REQUEST_FORBIDDEN'
  );
});

console.log(`\n${passed} multiplayer request-boundary regression tests passed.`);
