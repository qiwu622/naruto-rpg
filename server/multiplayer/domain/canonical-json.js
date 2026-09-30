import { createHash, createHmac } from 'node:crypto';
import { DomainError } from './errors.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

function fail(code, message, path, details = {}) {
  throw new DomainError(code, message, { path, ...details });
}

function normalizeLimits(options) {
  const maxDepth = options?.maxDepth ?? 64;
  const maxNodes = options?.maxNodes ?? 100_000;

  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new DomainError('INVALID_CANONICAL_OPTIONS', 'maxDepth must be a non-negative integer', {
      maxDepth
    });
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new DomainError('INVALID_CANONICAL_OPTIONS', 'maxNodes must be a positive integer', {
      maxNodes
    });
  }

  return { maxDepth, maxNodes };
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Rejects values whose JSON representation would be lossy, executable or
 * ambiguous. Shared (but acyclic) object references are accepted because JSON
 * serializes each occurrence by value; actual cycles are rejected.
 */
export function assertJsonSafe(value, options = {}) {
  const { maxDepth, maxNodes } = normalizeLimits(options);
  const ancestors = new WeakSet();
  let nodes = 0;

  function visit(current, path, depth) {
    nodes += 1;
    if (nodes > maxNodes) {
      fail('JSON_NODE_LIMIT', 'JSON value exceeds the configured node limit', path, { maxNodes });
    }
    if (depth > maxDepth) {
      fail('JSON_DEPTH_LIMIT', 'JSON value exceeds the configured depth limit', path, { maxDepth });
    }

    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return;
    }

    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        fail('JSON_NON_FINITE_NUMBER', 'JSON numbers must be finite', path, { value: String(current) });
      }
      return;
    }

    if (typeof current !== 'object') {
      fail('JSON_UNSAFE_TYPE', 'Value is not losslessly representable as JSON', path, {
        type: describeType(current)
      });
    }

    if (ancestors.has(current)) {
      fail('JSON_CYCLE', 'Circular JSON structures are forbidden', path);
    }

    const prototype = Object.getPrototypeOf(current);
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) {
        fail('JSON_UNSAFE_PROTOTYPE', 'Array subclasses are not accepted as canonical JSON', path);
      }

      for (const key of Reflect.ownKeys(current)) {
        if (typeof key === 'symbol') {
          fail('JSON_SYMBOL_KEY', 'Symbol keys are forbidden in canonical JSON', path);
        }
        if (key === 'length') continue;
        if (!ARRAY_INDEX.test(key) || Number(key) >= current.length) {
          fail('JSON_ARRAY_PROPERTY', 'Arrays may only contain indexed JSON elements', `${path}.${key}`);
        }
      }

      ancestors.add(current);
      try {
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            fail('JSON_SPARSE_ARRAY', 'Sparse arrays are forbidden in canonical JSON', `${path}[${index}]`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
            fail('JSON_UNSAFE_PROPERTY', 'Canonical JSON array elements must be enumerable data properties', `${path}[${index}]`);
          }
          visit(descriptor.value, `${path}[${index}]`, depth + 1);
        }
      } finally {
        ancestors.delete(current);
      }
      return;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      fail('JSON_UNSAFE_PROTOTYPE', 'Only plain objects are accepted as canonical JSON', path, {
        prototype: 'non-plain'
      });
    }

    ancestors.add(current);
    try {
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key === 'symbol') {
          fail('JSON_SYMBOL_KEY', 'Symbol keys are forbidden in canonical JSON', path);
        }
        if (DANGEROUS_KEYS.has(key)) {
          fail('JSON_DANGEROUS_KEY', 'Prototype-manipulation keys are forbidden in canonical JSON', `${path}.${key}`, {
            key
          });
        }

        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
          fail('JSON_UNSAFE_PROPERTY', 'Canonical JSON objects require enumerable data properties', `${path}.${key}`);
        }
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  }

  visit(value, '$', 0);
  return value;
}

/** Returns a detached JSON value with object keys sorted recursively. */
export function canonicalizeJson(value, options = {}) {
  assertJsonSafe(value, options);

  function clone(current) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      return Object.is(current, -0) ? 0 : current;
    }
    if (Array.isArray(current)) {
      return current.map(clone);
    }

    const result = {};
    for (const key of Object.keys(current).sort()) {
      result[key] = clone(current[key]);
    }
    return result;
  }

  return clone(value);
}

export function canonicalStringify(value, options = {}) {
  return JSON.stringify(canonicalizeJson(value, options));
}

function bytesForDigest(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return canonicalStringify(value);
}

function assertSecret(secret) {
  const valid = typeof secret === 'string'
    ? Buffer.byteLength(secret, 'utf8') > 0
    : (secret instanceof Uint8Array && secret.byteLength > 0);
  if (!valid) {
    throw new DomainError('INVALID_HMAC_SECRET', 'A non-empty server secret is required');
  }
}

/** Returns a lowercase, unprefixed SHA-256 hex digest. */
export function sha256Hex(value) {
  return createHash('sha256').update(bytesForDigest(value)).digest('hex');
}

/** Returns a lowercase, unprefixed HMAC-SHA-256 hex digest. */
export function hmacSha256(secret, value) {
  assertSecret(secret);
  return createHmac('sha256', secret).update(bytesForDigest(value)).digest('hex');
}
