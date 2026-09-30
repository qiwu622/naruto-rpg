import { DomainError, isDomainError } from '../domain/errors.js';

const REDACTED_DETAIL_FIELDS = /(?:^|_)(?:api_key|auth_tag|authorization_header|ciphertext|narration_note|nonce|plaintext|secret|text|token|wrapped_data_key)(?:$|_)/iu;

function publicDetails(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object' || depth >= 8) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => publicDetails(item, depth + 1, seen));
  }
  const projected = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    projected[key] = REDACTED_DETAIL_FIELDS.test(key)
      ? '[redacted]'
      : publicDetails(child, depth + 1, seen);
  }
  return projected;
}

export function multiplayerHttpErrorPayload(error) {
  if (isDomainError(error)) {
    return Object.freeze({
      status: Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 400,
      body: Object.freeze({
        error: Object.freeze({
          code: error.code,
          message: String(error.message).slice(0, 2_000),
          details: publicDetails(error.details ?? {})
        })
      })
    });
  }
  if (error?.type === 'entity.too.large') {
    return Object.freeze({
      status: 413,
      body: Object.freeze({
        error: Object.freeze({
          code: 'REQUEST_BODY_TOO_LARGE',
          message: 'request body exceeds the multiplayer API limit',
          details: Object.freeze({})
        })
      })
    });
  }
  if (error?.type === 'entity.parse.failed'
    || (error instanceof SyntaxError && error?.status === 400)) {
    return Object.freeze({
      status: 400,
      body: Object.freeze({
        error: Object.freeze({
          code: 'REQUEST_JSON_INVALID',
          message: 'request body is not valid JSON',
          details: Object.freeze({})
        })
      })
    });
  }
  return Object.freeze({
    status: 500,
    body: Object.freeze({
      error: Object.freeze({
        code: 'MULTIPLAYER_INTERNAL_ERROR',
        message: 'multiplayer request failed',
        details: Object.freeze({})
      })
    })
  });
}

export function createMultiplayerHttpErrorHandler({ logger = () => {} } = {}) {
  if (typeof logger !== 'function') {
    throw new DomainError(
      'MULTIPLAYER_HTTP_CONFIGURATION_INVALID',
      'multiplayer HTTP error logger must be a function',
      {},
      { status: 500 }
    );
  }
  return function multiplayerHttpErrorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    const mapped = multiplayerHttpErrorPayload(error);
    if (!isDomainError(error)) {
      logger(error, {
        method: req.method,
        path: req.originalUrl ?? req.url
      });
    }
    if (mapped.status === 429 && Number.isFinite(error?.details?.retry_after_ms)) {
      res.setHeader('Retry-After', String(Math.max(
        1,
        Math.ceil(error.details.retry_after_ms / 1_000)
      )));
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(mapped.status).json(mapped.body);
  };
}

export function multiplayerRouteNotFound(req, _res, next) {
  next(new DomainError(
    'MULTIPLAYER_ROUTE_NOT_FOUND',
    'multiplayer API route was not found',
    { method: req.method },
    { status: 404 }
  ));
}

export { publicDetails };
