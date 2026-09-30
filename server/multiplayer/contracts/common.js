import { canonicalizeJson } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

const FORBIDDEN_TEXT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

export function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function contractError(path, message, details = {}) {
  return new DomainError('SCHEMA_VIOLATION', message, { path, ...details });
}

export function assertPlainRecord(value, path = '/', label = 'value') {
  if (!isPlainRecord(value)) throw contractError(path, `${label} must be an object`);
  return value;
}

export function assertExactKeys(value, {
  allowed,
  required = allowed,
  path = '/',
  label = 'object'
}) {
  assertPlainRecord(value, path, label);
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  const requiredSet = required instanceof Set ? required : new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw contractError(joinJsonPointer(path, key), `${label} contains an unknown property`, {
        property: key
      });
    }
  }
  for (const key of requiredSet) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw contractError(joinJsonPointer(path, key), `${label} is missing a required property`, {
        property: key
      });
    }
  }
  return value;
}

export function assertString(value, {
  path = '/',
  label = 'value',
  min = 1,
  max = 256,
  pattern = null,
  enumValues = null,
  allowControls = false
} = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw contractError(path, `${label} must be a string between ${min} and ${max} characters`, {
      min,
      max
    });
  }
  if (!allowControls && FORBIDDEN_TEXT_CONTROL.test(value)) {
    throw contractError(path, `${label} contains a forbidden control character`);
  }
  if (pattern && !pattern.test(value)) {
    throw contractError(path, `${label} has an invalid format`);
  }
  if (enumValues && !enumValues.includes(value)) {
    throw contractError(path, `${label} is not an allowed value`, {
      allowed_values: [...enumValues]
    });
  }
  return value;
}

export function assertIdentifier(value, {
  path = '/',
  label = 'identifier',
  prefix = null,
  max = 160
} = {}) {
  const pattern = prefix
    ? new RegExp(`^${escapeRegExp(prefix)}[A-Za-z0-9_-]{1,${Math.max(1, max - prefix.length)}}$`)
    : /^[A-Za-z][A-Za-z0-9:_-]*$/;
  return assertString(value, { path, label, min: 2, max, pattern });
}

/**
 * Authenticated principal IDs are opaque external identifiers. Discord IDs
 * are decimal strings, so they must not use the letter-prefixed entity-ID
 * grammar enforced by assertIdentifier().
 */
export function assertPrincipalId(value, {
  path = '/',
  label = 'principal identifier',
  max = 160
} = {}) {
  return assertString(value, {
    path,
    label,
    min: 2,
    max,
    pattern: /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u
  });
}

export function assertInteger(value, {
  path = '/',
  label = 'value',
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER
} = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw contractError(path, `${label} must be a safe integer between ${min} and ${max}`, {
      min,
      max
    });
  }
  return value;
}

export function assertBoolean(value, { path = '/', label = 'value' } = {}) {
  if (typeof value !== 'boolean') throw contractError(path, `${label} must be a boolean`);
  return value;
}

export function assertArray(value, {
  path = '/',
  label = 'value',
  min = 0,
  max = 256,
  item = null,
  uniqueBy = null
} = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw contractError(path, `${label} must be an array with ${min} to ${max} items`, {
      min_items: min,
      max_items: max
    });
  }
  const seen = uniqueBy ? new Set() : null;
  for (let index = 0; index < value.length; index += 1) {
    item?.(value[index], `${path}/${index}`, index);
    if (uniqueBy) {
      const identity = uniqueBy(value[index]);
      if (seen.has(identity)) {
        throw contractError(`${path}/${index}`, `${label} contains a duplicate item`, {
          identity
        });
      }
      seen.add(identity);
    }
  }
  return value;
}

export function assertNullable(value, validator, path = '/') {
  if (value === null) return null;
  return validator(value, path);
}

export function immutableContractValue(value) {
  return freezeDeep(canonicalizeJson(value));
}

export function inspectContract(value, assertContract) {
  try {
    const normalized = assertContract(value);
    return { valid: true, errors: [], value: normalized };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return {
      valid: false,
      errors: [{
        code: error.code,
        path: error.details?.path ?? '/',
        message: error.message
      }],
      value: null
    };
  }
}

export function escapeJsonPointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

export function joinJsonPointer(base, token) {
  const prefix = !base || base === '/' ? '' : String(base).replace(/\/$/, '');
  return `${prefix}/${escapeJsonPointer(token)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
