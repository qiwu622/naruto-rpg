const DEFAULT_STATUS_BY_CODE = Object.freeze({
  IDEMPOTENCY_CONFLICT: 409,
  ACTION_ALREADY_LOCKED: 409,
  EXECUTION_PLAN_FROZEN: 409,
  STALE_STATE_REVISION: 409,
  INVALID_TURN_STATE: 409
});

/**
 * Stable error shape for multiplayer domain failures.
 *
 * `details` must never contain hidden action text when the error is projected
 * to another member. Audience projection belongs to the application layer;
 * this class merely keeps the machine-readable contract consistent.
 */
export class DomainError extends Error {
  constructor(code, message, details = {}, options = {}) {
    if (code && typeof code === 'object') {
      const config = code;
      code = config.code;
      message = config.message;
      details = config.details ?? {};
      options = config;
    }

    super(String(message || code || 'Domain error'));
    this.name = 'DomainError';
    this.code = typeof code === 'string' && code ? code : 'DOMAIN_ERROR';
    this.details = details ?? {};
    this.status = Number.isInteger(options.status)
      ? options.status
      : (DEFAULT_STATUS_BY_CODE[this.code] ?? 400);

    if (options.cause !== undefined) {
      this.cause = options.cause;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DomainError);
    }
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details
    };
  }
}

export function domainInvariant(condition, code, message, details = {}, options = {}) {
  if (!condition) {
    throw new DomainError(code, message, details, options);
  }
}

export function isDomainError(error, code = undefined) {
  return error instanceof DomainError && (code === undefined || error.code === code);
}
