import { DomainError } from '../domain/errors.js';

const AUTHORITY_FIELDS = new Set([
  'authenticated_user_id',
  'accepted_by_user_id',
  'audience_owner_user_id',
  'host_user_id',
  'member_id',
  'owner_user_id',
  'payer',
  'payer_id',
  'payer_seat',
  'payer_seat_id',
  'payer_user_id',
  'profile_owner_user_id',
  'room_owner',
  'room_owner_user_id',
  'seat',
  'seat_id',
  'subject_user_id',
  'user_id'
]);

const TOP_LEVEL_BINDING_FIELDS = new Set([
  'epoch_id',
  'room_id',
  'turn_id'
]);

const PROTOTYPE_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

function normalizeFieldName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[-\s]+/gu, '_')
    .toLowerCase();
}

function requestError(code, message, details = {}) {
  throw new DomainError(code, message, details, { status: 400 });
}

export function assertAuthenticatedPrincipal(req) {
  const id = req?.user?.id;
  if (typeof id !== 'string' || id.length < 1 || id.length > 256) {
    throw new DomainError(
      'AUTHENTICATION_REQUIRED',
      'multiplayer authentication is required',
      {},
      { status: 401 }
    );
  }
  return id;
}

/**
 * Refuse client attempts to report server-authoritative identity, membership,
 * seat or payer bindings. The scan is recursive because smuggling the same
 * field inside a nested amendment or import envelope must not change its
 * authority.
 */
export function assertClientAuthorityFieldsAbsent(value, {
  extra_forbidden = [],
  opaque_data_fields = [],
  max_depth = 32,
  max_nodes = 20_000
} = {}) {
  if (value === undefined || value === null) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError('REQUEST_BODY_INVALID', 'request body must be a JSON object');
  }
  const extra = new Set(extra_forbidden.map(normalizeFieldName));
  const opaqueData = new Set(opaque_data_fields.map(normalizeFieldName));
  const stack = [{ value, path: '$', depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > max_nodes || current.depth > max_depth) {
      requestError('REQUEST_BODY_TOO_COMPLEX', 'request body exceeds structural limits');
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => stack.push({
        value: child,
        path: `${current.path}[${index}]`,
        depth: current.depth + 1
      }));
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      const normalized = normalizeFieldName(key);
      const path = `${current.path}.${key}`;
      if (PROTOTYPE_FIELDS.has(key)) {
        requestError('REQUEST_FIELD_FORBIDDEN', 'unsafe request field is forbidden', { path });
      }
      if (AUTHORITY_FIELDS.has(normalized)
        || extra.has(normalized)
        || (current.depth === 0 && TOP_LEVEL_BINDING_FIELDS.has(normalized))) {
        requestError(
          'CLIENT_AUTHORITY_FIELD_FORBIDDEN',
          'client-supplied authority field is forbidden',
          { path }
        );
      }
      // Save/timeline documents are untrusted opaque data, not authority
      // envelopes. Their dedicated codecs validate every semantic field; a
      // nested legacy key named `seat` or `user_id` must not be mistaken for
      // an HTTP identity claim. Only explicitly declared top-level fields get
      // this treatment.
      if (current.depth === 0 && opaqueData.has(normalized)) continue;
      stack.push({ value: child, path, depth: current.depth + 1 });
    }
  }
  return value;
}

export function onlyRequestFields(value, allowedFields, label = 'request') {
  const allowed = new Set(allowedFields);
  const unsupported = Object.keys(value).filter(key => !allowed.has(key));
  if (unsupported.length > 0) {
    requestError('REQUEST_FIELD_UNSUPPORTED', `${label} contains unsupported fields`, {
      fields: unsupported.sort()
    });
  }
  return Object.fromEntries(allowedFields
    .filter(field => Object.prototype.hasOwnProperty.call(value, field))
    .map(field => [field, value[field]]));
}

export function parsePositivePathInteger(value, label) {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/u.test(text)) {
    requestError('PATH_PARAMETER_INVALID', `${label} must be a positive integer`, {
      parameter: label
    });
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    requestError('PATH_PARAMETER_INVALID', `${label} exceeds the safe integer range`, {
      parameter: label
    });
  }
  return parsed;
}

export function parsePathIdentifier(value, label) {
  const text = String(value ?? '');
  if (!/^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u.test(text)) {
    requestError('PATH_PARAMETER_INVALID', `${label} is not a valid identifier`, {
      parameter: label
    });
  }
  return text;
}

/** Public room locators are user-chosen codes, not internal identifiers. */
export function parseRoomLocator(value) {
  const text = String(value ?? '').trim();
  if (text === '') {
    requestError('PATH_PARAMETER_INVALID', 'roomId must not be empty', {
      parameter: 'roomId'
    });
  }
  return text;
}

export function parseBoundedQueryInteger(value, label, {
  default_value,
  min,
  max
}) {
  if (value === undefined || value === null || value === '') return default_value;
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) {
    requestError('QUERY_PARAMETER_INVALID', `${label} must be an integer`, {
      parameter: label
    });
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    requestError(
      'QUERY_PARAMETER_INVALID',
      `${label} must be between ${min} and ${max}`,
      { parameter: label }
    );
  }
  return parsed;
}

export function parseBooleanQuery(value, label, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  requestError('QUERY_PARAMETER_INVALID', `${label} must be true or false`, {
    parameter: label
  });
}

export { AUTHORITY_FIELDS, normalizeFieldName };
