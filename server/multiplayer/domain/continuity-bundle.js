import { DomainError } from './errors.js';
import {
  assertJsonSafe,
  canonicalizeJson,
  canonicalStringify,
  sha256Hex
} from './canonical-json.js';

export const CONTINUITY_JSON_PROTOCOL = 'naruto.continuity-json/v1';
export const TURN_BUNDLE_PATCH_SCHEMA = 'naruto.turn-bundle-patch/v1';
export const BOUND_CONTINUITY_COMMAND_SCHEMA = 'naruto.bound-continuity-command/v1';

export const CONTINUITY_OPERATIONS = Object.freeze({
  STAGE: 'stage_turn_bundle',
  REPAIR: 'repair_turn_bundle'
});

export const TURN_BUNDLE_LIMITS = Object.freeze({
  responseBytes: 2_000_000,
  effectIds: 256,
  domainChecks: 128,
  memories: 128,
  shinobiDaily: 1,
  maxDepth: 64,
  maxNodes: 100_000
});

const OPERATIONS = new Set(Object.values(CONTINUITY_OPERATIONS));
const ENVELOPE_KEYS = new Set(['protocol', 'operation', 'bundle']);
const BUNDLE_KEYS = new Set(['effect_ids', 'domain_checks', 'memories', 'shinobi_daily']);

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function immutableJson(value) {
  return freezeDeep(canonicalizeJson(value));
}

function protocolViolation(message, path = '/', details = {}) {
  return new DomainError('PROTOCOL_VIOLATION', message, { path, ...details });
}

function assertPlainObject(value, path, label) {
  const prototype = value && typeof value === 'object'
    ? Object.getPrototypeOf(value)
    : undefined;
  if (!value || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw protocolViolation(`${label} must be a JSON object`, path);
  }
}

function assertExactKeys(value, allowed, required, path, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw protocolViolation(`${label} contains an unknown property`, `${path}/${key}`, {
        property: key
      });
    }
  }
  for (const key of required) {
    if (!own(value, key)) {
      throw protocolViolation(`${label} is missing a required property`, `${path}/${key}`, {
        property: key
      });
    }
  }
}

function parseOneJsonObject(source, path, label) {
  if (typeof source !== 'string') {
    throw protocolViolation(`${label} must be raw JSON text`, path);
  }
  if (Buffer.byteLength(source, 'utf8') > TURN_BUNDLE_LIMITS.responseBytes) {
    throw protocolViolation(`${label} exceeds the response size limit`, path, {
      max_bytes: TURN_BUNDLE_LIMITS.responseBytes
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw protocolViolation(
      `${label} must contain exactly one complete JSON object`,
      path,
      { parse_error: error instanceof Error ? error.message : String(error) }
    );
  }
  assertPlainObject(parsed, path, label);
  return parsed;
}

function normalizePartition(value, key, maxItems) {
  if (!Array.isArray(value)) {
    throw protocolViolation(`${key} must be an array`, `/bundle/${key}`);
  }
  if (value.length > maxItems) {
    throw protocolViolation(`${key} exceeds its item limit`, `/bundle/${key}`, {
      max_items: maxItems,
      actual_items: value.length
    });
  }

  // Item schemas deliberately run later. Keeping the raw, detached item here
  // is what permits one malformed memory to coexist with an accepted effect.
  return value.map(item => canonicalizeJson(item, {
    maxDepth: TURN_BUNDLE_LIMITS.maxDepth,
    maxNodes: TURN_BUNDLE_LIMITS.maxNodes
  }));
}

/**
 * Envelope-level validation only. Missing partitions become empty arrays;
 * malformed items remain visible to the item-level validators.
 */
export function normalizeTurnBundlePatch(bundle) {
  try {
    assertJsonSafe(bundle, {
      maxDepth: TURN_BUNDLE_LIMITS.maxDepth,
      maxNodes: TURN_BUNDLE_LIMITS.maxNodes
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PROTOCOL_VIOLATION') throw error;
    throw protocolViolation('bundle is not safe canonical JSON', '/bundle', {
      cause_code: error instanceof DomainError ? error.code : 'INVALID_JSON_VALUE'
    });
  }
  assertPlainObject(bundle, '/bundle', 'bundle');
  assertExactKeys(bundle, BUNDLE_KEYS, [], '/bundle', 'bundle');

  const normalized = {
    effect_ids: own(bundle, 'effect_ids')
      ? normalizePartition(bundle.effect_ids, 'effect_ids', TURN_BUNDLE_LIMITS.effectIds)
      : [],
    domain_checks: own(bundle, 'domain_checks')
      ? normalizePartition(bundle.domain_checks, 'domain_checks', TURN_BUNDLE_LIMITS.domainChecks)
      : [],
    memories: own(bundle, 'memories')
      ? normalizePartition(bundle.memories, 'memories', TURN_BUNDLE_LIMITS.memories)
      : [],
    shinobi_daily: own(bundle, 'shinobi_daily')
      ? normalizePartition(bundle.shinobi_daily, 'shinobi_daily', TURN_BUNDLE_LIMITS.shinobiDaily)
      : []
  };
  return immutableJson(normalized);
}

function normalizeOperation(operation, path = '/operation') {
  if (typeof operation !== 'string' || !OPERATIONS.has(operation)) {
    throw protocolViolation('operation is not a supported Continuity command', path, {
      operation: typeof operation === 'string' ? operation : null,
      allowed_operations: [...OPERATIONS]
    });
  }
  return operation;
}

function normalizedCommand(operation, bundle) {
  const canonicalBundle = normalizeTurnBundlePatch(bundle);
  const requestMaterial = {
    protocol_version: TURN_BUNDLE_PATCH_SCHEMA,
    operation: normalizeOperation(operation),
    bundle: canonicalBundle
  };
  return immutableJson({
    schema: TURN_BUNDLE_PATCH_SCHEMA,
    protocol_version: TURN_BUNDLE_PATCH_SCHEMA,
    operation: requestMaterial.operation,
    bundle: canonicalBundle,
    canonical_bundle_hash: `sha256:${sha256Hex(canonicalStringify(canonicalBundle))}`,
    canonical_request_hash: `sha256:${sha256Hex(canonicalStringify(requestMaterial))}`
  });
}

/** Strict JSON-protocol adapter. JSON.parse is applied once to the whole text. */
export function decodeJsonContinuityCommand(responseText) {
  const envelope = parseOneJsonObject(responseText, '/', 'Continuity JSON response');
  try {
    assertJsonSafe(envelope, {
      maxDepth: TURN_BUNDLE_LIMITS.maxDepth,
      maxNodes: TURN_BUNDLE_LIMITS.maxNodes
    });
  } catch (error) {
    throw protocolViolation('Continuity JSON response is not safe canonical JSON', '/', {
      cause_code: error instanceof DomainError ? error.code : 'INVALID_JSON_VALUE'
    });
  }
  assertExactKeys(envelope, ENVELOPE_KEYS, ENVELOPE_KEYS, '/', 'Continuity JSON envelope');
  if (envelope.protocol !== CONTINUITY_JSON_PROTOCOL) {
    throw protocolViolation(`protocol must be ${CONTINUITY_JSON_PROTOCOL}`, '/protocol', {
      protocol: typeof envelope.protocol === 'string' ? envelope.protocol : null
    });
  }
  normalizeOperation(envelope.operation);
  return normalizedCommand(envelope.operation, envelope.bundle);
}

/**
 * Native-tool adapter. The caller supplies the SDK's raw tool name and raw
 * arguments, bypassing SDK-level whole-object validation. A string argument is
 * parsed as one complete JSON object; an object is detached directly.
 */
export function decodeNativeContinuityCommand(toolName, rawArguments) {
  normalizeOperation(toolName, '/tool/name');
  const args = typeof rawArguments === 'string'
    ? parseOneJsonObject(rawArguments, '/tool/arguments', 'native tool arguments')
    : rawArguments;
  try {
    assertJsonSafe(args, {
      maxDepth: TURN_BUNDLE_LIMITS.maxDepth,
      maxNodes: TURN_BUNDLE_LIMITS.maxNodes
    });
  } catch (error) {
    throw protocolViolation('native tool arguments are not safe canonical JSON', '/tool/arguments', {
      cause_code: error instanceof DomainError ? error.code : 'INVALID_JSON_VALUE'
    });
  }
  assertPlainObject(args, '/tool/arguments', 'native tool arguments');
  return normalizedCommand(toolName, args);
}

/** Convenience adapter for a transport selected and frozen by the server. */
export function decodeContinuityCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw protocolViolation('transport input must be an object', '/transport');
  }
  const mode = input.transport_mode ?? input.transportMode;
  if (mode === 'json_protocol') {
    return decodeJsonContinuityCommand(input.response_text ?? input.responseText ?? input.response);
  }
  if (mode === 'native_tools') {
    return decodeNativeContinuityCommand(
      input.tool_name ?? input.toolName ?? input.name,
      input.raw_arguments ?? input.rawArguments ?? input.arguments
    );
  }
  throw protocolViolation('transport_mode must be native_tools or json_protocol', '/transport_mode', {
    transport_mode: typeof mode === 'string' ? mode : null
  });
}

function assertBindingIdentifier(value, key) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new DomainError('INVALID_BOUND_CONTEXT', `${key} must be a non-empty server identifier`, {
      field: key
    });
  }
}

/** Adds server-only attempt identity without accepting it from model payloads. */
export function bindContinuityCommand(command, context) {
  assertJsonSafe(command, { maxDepth: 12, maxNodes: 10_000 });
  if (!command || command.schema !== TURN_BUNDLE_PATCH_SCHEMA
    || typeof command.canonical_request_hash !== 'string') {
    throw new DomainError('INVALID_CONTINUITY_COMMAND', 'command must be produced by a Continuity adapter');
  }
  assertJsonSafe(context, { maxDepth: 4, maxNodes: 32 });
  const prototype = context && typeof context === 'object'
    ? Object.getPrototypeOf(context)
    : undefined;
  if (!context || Array.isArray(context)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new DomainError('INVALID_BOUND_CONTEXT', 'bound context must be a plain server object');
  }

  for (const key of ['run_id', 'continuity_session_id', 'invocation_id', 'command_attempt_id']) {
    if (!own(context, key)) {
      throw new DomainError('INVALID_BOUND_CONTEXT', 'bound context is missing attempt identity', {
        field: key
      });
    }
    assertBindingIdentifier(context[key], key);
  }
  if (!own(context, 'lease_fence')
    || !Number.isSafeInteger(context.lease_fence)
    || context.lease_fence < 1) {
    throw new DomainError('INVALID_BOUND_CONTEXT', 'lease_fence must be a positive server fence');
  }

  return immutableJson({
    schema: BOUND_CONTINUITY_COMMAND_SCHEMA,
    binding: context,
    protocol_version: command.protocol_version,
    operation: command.operation,
    bundle: command.bundle,
    canonical_bundle_hash: command.canonical_bundle_hash,
    canonical_request_hash: command.canonical_request_hash
  });
}
