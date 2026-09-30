import {
  NARRATIVE_DELIVERY_SCHEMA,
  assertNarrativeCandidate
} from '../contracts/narrative-contracts.js';
import {
  assertJsonSafe,
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

export const NARRATIVE_DELIVERY_STORAGE_CONTEXT_SCHEMA =
  'naruto.multiplayer-narrative-delivery-storage-context/v1';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const HMAC = /^hmac-sha256:[a-f0-9]{64}$/u;

function fail(code, message, details = {}, cause = undefined) {
  throw new DomainError(code, message, details, { status: 500, cause });
}

function identifier(value, label) {
  if (typeof value !== 'string'
    || !/^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u.test(value)) {
    fail('NARRATIVE_DELIVERY_STORAGE_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail('NARRATIVE_DELIVERY_STORAGE_INVALID', `${label} must be a sha256 hash`, {
      field: label
    });
  }
  return value;
}

function expectedContractAudience(audience) {
  if (audience === 'shared') return 'shared';
  if (audience === 'A' || audience === 'B') return `seat:${audience}`;
  fail('NARRATIVE_DELIVERY_STORAGE_INVALID', 'stored narrative audience is invalid');
}

function deliveryHash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

export function narrativeDeliveryStorageContext(rowValue) {
  const row = rowValue && typeof rowValue === 'object' && !Array.isArray(rowValue)
    ? rowValue
    : null;
  if (!row) fail('NARRATIVE_DELIVERY_STORAGE_INVALID', 'narrative storage row is required');
  return Object.freeze({
    schema: NARRATIVE_DELIVERY_STORAGE_CONTEXT_SCHEMA,
    room_id: identifier(row.room_id, 'room_id'),
    epoch_id: identifier(row.epoch_id, 'epoch_id'),
    turn_id: identifier(row.turn_id, 'turn_id'),
    delivery_id: identifier(row.delivery_id, 'delivery_id'),
    audience: expectedContractAudience(row.audience),
    narrative_mode: row.narrative_mode,
    resolution_hash: hash(row.resolution_hash, 'resolution_hash'),
    projection_hash: hash(row.projection_hash, 'projection_hash'),
    narrative_hash: hash(row.narrative_hash, 'narrative_hash'),
    writer_invocation_id: identifier(row.writer_invocation_id, 'writer_invocation_id'),
    stop_point_ref: identifier(row.stop_point_ref, 'stop_point_ref')
  });
}

function normalizeDelivery(value, context) {
  assertJsonSafe(value, { maxDepth: 40, maxNodes: 100_000 });
  const delivery = canonicalizeJson(value);
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)
    || delivery.schema !== NARRATIVE_DELIVERY_SCHEMA
    || delivery.turn_id !== context.turn_id
    || delivery.audience !== context.audience
    || delivery.stop_point_ref !== context.stop_point_ref
    || typeof delivery.resolution_commitment !== 'string'
    || !HMAC.test(delivery.resolution_commitment)) {
    fail(
      'NARRATIVE_DELIVERY_CORRUPT',
      'narrative delivery does not match its immutable storage binding'
    );
  }
  assertNarrativeCandidate({
    segments: delivery.segments,
    stop_point_ref: delivery.stop_point_ref
  });
  if (deliveryHash(delivery) !== context.narrative_hash) {
    fail('NARRATIVE_DELIVERY_CORRUPT', 'narrative delivery hash does not match');
  }
  return Object.freeze(delivery);
}

function envelope(row) {
  return {
    action_ciphertext: Buffer.from(row.delivery_ciphertext),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  };
}

/**
 * Fixed AAD and plaintext contract shared by the future delivery writer and
 * audience-scoped readers. The caller persists the returned columns as-is.
 */
export function sealNarrativeDeliveryContent(contentCodec, rowValue, deliveryValue) {
  if (typeof contentCodec?.sealJson !== 'function') {
    fail('NARRATIVE_DELIVERY_CODEC_CONFIGURATION_INVALID', 'sealJson codec is required');
  }
  const canonicalDelivery = canonicalizeJson(deliveryValue);
  const narrativeHash = deliveryHash(canonicalDelivery);
  const row = { ...rowValue, narrative_hash: narrativeHash };
  const context = narrativeDeliveryStorageContext(row);
  normalizeDelivery(canonicalDelivery, context);
  const sealed = contentCodec.sealJson(canonicalDelivery, context);
  return Object.freeze({
    narrative_hash: narrativeHash,
    delivery_ciphertext: Buffer.from(sealed.action_ciphertext),
    wrapped_data_key: Buffer.from(sealed.wrapped_data_key),
    nonce: Buffer.from(sealed.nonce),
    auth_tag: Buffer.from(sealed.auth_tag),
    master_key_version: sealed.master_key_version
  });
}

export function openNarrativeDeliveryContent(contentCodec, row) {
  if (typeof contentCodec?.openJson !== 'function') {
    fail('NARRATIVE_DELIVERY_CODEC_CONFIGURATION_INVALID', 'openJson codec is required');
  }
  const context = narrativeDeliveryStorageContext(row);
  let opened;
  try {
    opened = contentCodec.openJson(envelope(row), context);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail(
      'NARRATIVE_DELIVERY_CORRUPT',
      'narrative delivery envelope could not be authenticated',
      {},
      error
    );
  }
  return normalizeDelivery(opened, context);
}

export function narrativeDeliveryText(delivery) {
  return delivery.segments.map(segment => segment.text).join('\n\n');
}
