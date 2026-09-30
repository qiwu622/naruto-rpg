import { DomainError } from '../domain/errors.js';

export const STRICT_JSON_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details, { status: 422 });
}

/**
 * Parses the complete model text once. There is deliberately no fence
 * stripping, substring search, regular-expression extraction or XML path.
 */
export function parseStrictJsonText(source, {
  label = 'model response',
  max_bytes = STRICT_JSON_DEFAULT_MAX_BYTES,
  validate = value => value
} = {}) {
  if (typeof source !== 'string') {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} must be raw JSON text`, {
      path: '/',
      reason: 'NON_TEXT_RESPONSE'
    });
  }
  const byteLength = Buffer.byteLength(source, 'utf8');
  if (byteLength === 0) {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} is empty`, {
      path: '/',
      reason: 'EMPTY_RESPONSE'
    });
  }
  if (!Number.isSafeInteger(max_bytes) || max_bytes < 1 || byteLength > max_bytes) {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} exceeds its byte limit`, {
      path: '/',
      reason: 'RESPONSE_TOO_LARGE',
      max_bytes,
      actual_bytes: byteLength
    });
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail('MODEL_PROTOCOL_VIOLATION', `${label} must be exactly one complete JSON value`, {
      path: '/',
      reason: 'INVALID_STRICT_JSON',
      parse_error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    return validate(value);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'MODEL_OUTPUT_SCHEMA_INVALID',
      `${label} failed its strict output contract`,
      { path: '/' },
      { status: 422, cause: error }
    );
  }
}

export function parseStrictJsonObject(source, options = {}) {
  return parseStrictJsonText(source, {
    ...options,
    validate(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('MODEL_PROTOCOL_VIOLATION', `${options.label ?? 'model response'} must be a JSON object`, {
          path: '/',
          reason: 'NON_OBJECT_RESPONSE'
        });
      }
      return options.validate ? options.validate(value) : value;
    }
  });
}
