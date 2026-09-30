import { timingSafeEqual } from 'node:crypto';

import { DomainError } from '../domain/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = 'naruto_csrf';

function reject(code, message, status = 403) {
  throw new DomainError(code, message, {}, { status });
}

function expectedRequestOrigin(req) {
  const host = req.get?.('host') ?? req.headers?.host;
  if (typeof host !== 'string' || !host) {
    reject('REQUEST_ORIGIN_INVALID', 'request Host header is missing', 400);
  }
  try {
    return new URL(`${req.protocol || 'http'}://${host}`).origin;
  } catch {
    reject('REQUEST_ORIGIN_INVALID', 'request Host header is invalid', 400);
  }
}

function parseOrigin(req) {
  const value = req.get?.('origin') ?? req.headers?.origin;
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 512) {
    reject('REQUEST_ORIGIN_INVALID', 'request Origin header is invalid');
  }
  try {
    return new URL(value).origin;
  } catch {
    reject('REQUEST_ORIGIN_INVALID', 'request Origin header is invalid');
  }
}

function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length === 0 || leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Browser boundary for multiplayer APIs. Cross-origin browser requests are
 * rejected for every method. Cookie-authenticated mutations additionally use
 * a double-submit CSRF token; bearer clients are non-ambient and therefore do
 * not need the cookie token.
 */
export function enforceMultiplayerRequestBoundary(req) {
  const origin = parseOrigin(req);
  if (origin !== null && origin !== expectedRequestOrigin(req)) {
    reject('CROSS_ORIGIN_REQUEST_FORBIDDEN', 'cross-origin multiplayer request is forbidden');
  }

  const fetchSite = String(req.get?.('sec-fetch-site') ?? req.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite === 'cross-site') {
    reject('CROSS_ORIGIN_REQUEST_FORBIDDEN', 'cross-site multiplayer request is forbidden');
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method) || req.authSource !== 'cookie') return true;
  if (origin === null) {
    reject('CSRF_ORIGIN_REQUIRED', 'cookie-authenticated writes require an Origin header');
  }
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get?.(CSRF_HEADER) ?? req.headers?.[CSRF_HEADER];
  if (!safeTokenEqual(cookieToken, headerToken)) {
    reject('CSRF_TOKEN_INVALID', 'CSRF token is missing or invalid');
  }
  return true;
}

export function multiplayerRequestBoundary(req, res, next) {
  try {
    enforceMultiplayerRequestBoundary(req);
    next();
  } catch (error) {
    next(error);
  }
}

export { CSRF_COOKIE, CSRF_HEADER, expectedRequestOrigin, safeTokenEqual };
