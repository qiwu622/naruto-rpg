import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID
} from 'node:crypto';

import {
  STORED_MODEL_CREDENTIAL_SCHEMA,
  assertStoredModelCredential
} from '../contracts/billing-contracts.js';
import { assertPrincipalId } from '../contracts/common.js';
import { sha256Hex } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const WRAPPED_KEY_FORMAT_VERSION = 1;
const MAX_CREDENTIAL_BYTES = 16_384;

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details);
}

function normalizeKey(value, label) {
  let key;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    key = Buffer.from(value);
  } else if (typeof value === 'string' && value.trim()) {
    try {
      key = Buffer.from(value.trim(), 'base64');
    } catch {
      fail('CREDENTIAL_VAULT_CONFIGURATION_INVALID', `${label} must be a 32-byte key`);
    }
  }
  if (!key || key.length !== DATA_KEY_BYTES) {
    key?.fill(0);
    fail('CREDENTIAL_VAULT_CONFIGURATION_INVALID', `${label} must be a 32-byte key`);
  }
  return key;
}

function normalizeMasterKeys(masterKeys) {
  const entries = masterKeys instanceof Map
    ? [...masterKeys.entries()]
    : Object.entries(masterKeys ?? {});
  if (!entries.length) {
    fail('CREDENTIAL_VAULT_CONFIGURATION_INVALID', 'at least one versioned master key is required');
  }
  const normalized = new Map();
  for (const [version, keyValue] of entries) {
    if (typeof version !== 'string' || !/^[A-Za-z][A-Za-z0-9:_-]{1,159}$/u.test(version)) {
      fail('CREDENTIAL_VAULT_CONFIGURATION_INVALID', 'master key version is invalid');
    }
    normalized.set(version, normalizeKey(keyValue, `master key ${version}`));
  }
  return normalized;
}

function normalizeOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('CREDENTIAL_ORIGIN_INVALID', 'credential endpoint origin must be a valid URL');
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
    || parsed.pathname !== '/') {
    fail('CREDENTIAL_ORIGIN_INVALID', 'credential endpoint origin must be a normalized HTTPS origin');
  }
  if (value !== parsed.origin) {
    fail('CREDENTIAL_ORIGIN_INVALID', 'credential endpoint origin must already be normalized', {
      normalized_origin: parsed.origin
    });
  }
  return parsed.origin;
}

function normalizePlaintext(value) {
  const bytes = typeof value === 'string'
    ? Buffer.from(value, 'utf8')
    : (Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value) : null);
  if (!bytes || bytes.length < 1 || bytes.length > MAX_CREDENTIAL_BYTES) {
    bytes?.fill(0);
    fail(
      'CREDENTIAL_PLAINTEXT_INVALID',
      `credential must contain between 1 and ${MAX_CREDENTIAL_BYTES} bytes`
    );
  }
  if (bytes.includes(0)) {
    bytes.fill(0);
    fail('CREDENTIAL_PLAINTEXT_INVALID', 'credential must not contain NUL bytes');
  }
  return bytes;
}

function aadFor({
  credentialId,
  ownerUserId,
  credentialRevision,
  endpointOriginHash,
  masterKeyVersion,
  layer
}) {
  return Buffer.from([
    'naruto.multiplayer-credential/v1',
    layer,
    credentialId,
    ownerUserId,
    String(credentialRevision),
    endpointOriginHash,
    layer === 'data-key' ? masterKeyVersion : 'data-key-version-independent'
  ].join('\u0000'), 'utf8');
}

function encryptAead(plaintext, key, aad) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { nonce, ciphertext, authTag };
}

function decryptAead(ciphertext, key, nonce, authTag, aad) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
      authTagLength: AUTH_TAG_BYTES
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail('CREDENTIAL_AUTHENTICATION_FAILED', 'credential ciphertext authentication failed');
  }
}

function packWrappedKey({ nonce, ciphertext, authTag }) {
  if (nonce.length !== NONCE_BYTES
    || authTag.length !== AUTH_TAG_BYTES
    || ciphertext.length !== DATA_KEY_BYTES) {
    fail('CREDENTIAL_VAULT_CONFIGURATION_INVALID', 'wrapped key material has an invalid size');
  }
  return Buffer.concat([
    Buffer.from([WRAPPED_KEY_FORMAT_VERSION]),
    nonce,
    authTag,
    ciphertext
  ]).toString('base64');
}

function unpackWrappedKey(value) {
  let packed;
  try {
    packed = Buffer.from(value, 'base64');
  } catch {
    fail('CREDENTIAL_AUTHENTICATION_FAILED', 'wrapped data key is malformed');
  }
  const expectedLength = 1 + NONCE_BYTES + AUTH_TAG_BYTES + DATA_KEY_BYTES;
  if (packed.length !== expectedLength || packed[0] !== WRAPPED_KEY_FORMAT_VERSION) {
    packed.fill(0);
    fail('CREDENTIAL_AUTHENTICATION_FAILED', 'wrapped data key format is unsupported');
  }
  const nonce = Buffer.from(packed.subarray(1, 1 + NONCE_BYTES));
  const authTag = Buffer.from(packed.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + AUTH_TAG_BYTES));
  const ciphertext = Buffer.from(packed.subarray(1 + NONCE_BYTES + AUTH_TAG_BYTES));
  packed.fill(0);
  return { nonce, authTag, ciphertext };
}

function validateTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('CREDENTIAL_VAULT_INPUT_INVALID', `${label} must be an ISO timestamp`);
  }
  return value;
}

function fingerprintSuffix(plaintext, fingerprintKey) {
  return createHmac('sha256', fingerprintKey)
    .update('naruto.multiplayer-credential-fingerprint/v1\u0000')
    .update(plaintext)
    .digest('hex')
    .slice(-12);
}

/**
 * Creates the process-local cryptographic boundary for player BYOK secrets.
 * Callers persist only the returned strict StoredModelCredential record. The
 * master keys and fingerprint key must come from storage outside the business
 * database and its backups.
 */
export function createCredentialVault({
  masterKeys,
  activeMasterKeyVersion,
  fingerprintKey
}) {
  const keys = normalizeMasterKeys(masterKeys);
  if (!keys.has(activeMasterKeyVersion)) {
    fail('CREDENTIAL_VAULT_CONFIGURATION_INVALID', 'active master key version is unavailable');
  }
  const fingerprintSecret = normalizeKey(fingerprintKey, 'credential fingerprint key');

  function masterKey(version) {
    const key = keys.get(version);
    if (!key) fail('CREDENTIAL_MASTER_KEY_UNAVAILABLE', 'credential master key version is unavailable');
    return key;
  }

  function sealCredential({
    credential_id = `credential_${randomUUID().replaceAll('-', '')}`,
    owner_user_id,
    credential_revision = 1,
    endpoint_origin,
    plaintext,
    rotated_from_revision = null,
    created_at = new Date().toISOString(),
    master_key_version = activeMasterKeyVersion
  }) {
    assertPrincipalId(owner_user_id, { path: '/owner_user_id', label: 'owner_user_id' });
    if (typeof credential_id !== 'string'
      || credential_id.length > 160
      || !/^[A-Za-z][A-Za-z0-9:_-]+$/u.test(credential_id)) {
      fail('CREDENTIAL_VAULT_INPUT_INVALID', 'credential_id is invalid');
    }
    if (!Number.isSafeInteger(credential_revision) || credential_revision < 1) {
      fail('CREDENTIAL_VAULT_INPUT_INVALID', 'credential_revision must be a positive integer');
    }
    if (rotated_from_revision !== null
      && (!Number.isSafeInteger(rotated_from_revision)
        || rotated_from_revision < 1
        || rotated_from_revision >= credential_revision)) {
      fail('CREDENTIAL_VAULT_INPUT_INVALID', 'rotated_from_revision is invalid');
    }
    validateTimestamp(created_at, 'created_at');
    const origin = normalizeOrigin(endpoint_origin);
    const endpointOriginHash = `sha256:${sha256Hex(origin)}`;
    const secret = normalizePlaintext(plaintext);
    const dataKey = randomBytes(DATA_KEY_BYTES);
    try {
      const dataAad = aadFor({
        credentialId: credential_id,
        ownerUserId: owner_user_id,
        credentialRevision: credential_revision,
        endpointOriginHash,
        masterKeyVersion: master_key_version,
        layer: 'data'
      });
      const encrypted = encryptAead(secret, dataKey, dataAad);
      const wrapAad = aadFor({
        credentialId: credential_id,
        ownerUserId: owner_user_id,
        credentialRevision: credential_revision,
        endpointOriginHash,
        masterKeyVersion: master_key_version,
        layer: 'data-key'
      });
      const wrapped = encryptAead(dataKey, masterKey(master_key_version), wrapAad);
      return assertStoredModelCredential({
        schema: STORED_MODEL_CREDENTIAL_SCHEMA,
        credential_id,
        owner_user_id,
        credential_revision,
        endpoint_origin_hash: endpointOriginHash,
        ciphertext: encrypted.ciphertext.toString('base64'),
        wrapped_data_key: packWrappedKey(wrapped),
        nonce: encrypted.nonce.toString('base64'),
        auth_tag: encrypted.authTag.toString('base64'),
        master_key_version,
        fingerprint_suffix: fingerprintSuffix(secret, fingerprintSecret),
        rotated_from_revision,
        state: 'ACTIVE',
        created_at,
        revoked_at: null
      });
    } finally {
      secret.fill(0);
      dataKey.fill(0);
    }
  }

  async function withDecryptedCredential(recordValue, {
    owner_user_id,
    endpoint_origin
  }, callback) {
    if (typeof callback !== 'function') {
      fail('CREDENTIAL_VAULT_INPUT_INVALID', 'credential use requires a callback');
    }
    const record = assertStoredModelCredential(recordValue);
    if (record.state !== 'ACTIVE') fail('CREDENTIAL_REVOKED', 'credential is revoked');
    assertPrincipalId(owner_user_id, { path: '/owner_user_id', label: 'owner_user_id' });
    if (record.owner_user_id !== owner_user_id) {
      fail('CREDENTIAL_OWNER_MISMATCH', 'credential does not belong to the authenticated owner');
    }
    const origin = normalizeOrigin(endpoint_origin);
    const endpointOriginHash = `sha256:${sha256Hex(origin)}`;
    if (record.endpoint_origin_hash !== endpointOriginHash) {
      fail('CREDENTIAL_ORIGIN_MISMATCH', 'credential is not bound to this endpoint origin');
    }

    const wrapAad = aadFor({
      credentialId: record.credential_id,
      ownerUserId: record.owner_user_id,
      credentialRevision: record.credential_revision,
      endpointOriginHash: record.endpoint_origin_hash,
      masterKeyVersion: record.master_key_version,
      layer: 'data-key'
    });
    const wrapped = unpackWrappedKey(record.wrapped_data_key);
    const dataKey = decryptAead(
      wrapped.ciphertext,
      masterKey(record.master_key_version),
      wrapped.nonce,
      wrapped.authTag,
      wrapAad
    );
    let plaintext;
    try {
      if (dataKey.length !== DATA_KEY_BYTES) {
        fail('CREDENTIAL_AUTHENTICATION_FAILED', 'unwrapped data key has an invalid size');
      }
      const dataAad = aadFor({
        credentialId: record.credential_id,
        ownerUserId: record.owner_user_id,
        credentialRevision: record.credential_revision,
        endpointOriginHash: record.endpoint_origin_hash,
        masterKeyVersion: record.master_key_version,
        layer: 'data'
      });
      plaintext = decryptAead(
        Buffer.from(record.ciphertext, 'base64'),
        dataKey,
        Buffer.from(record.nonce, 'base64'),
        Buffer.from(record.auth_tag, 'base64'),
        dataAad
      );
      return await callback(plaintext);
    } finally {
      plaintext?.fill(0);
      dataKey.fill(0);
      wrapped.nonce.fill(0);
      wrapped.authTag.fill(0);
      wrapped.ciphertext.fill(0);
    }
  }

  function rotateCredential(recordValue, {
    owner_user_id,
    endpoint_origin,
    plaintext,
    created_at = new Date().toISOString()
  }) {
    const current = assertStoredModelCredential(recordValue);
    if (current.state !== 'ACTIVE') fail('CREDENTIAL_REVOKED', 'credential is revoked');
    if (current.owner_user_id !== owner_user_id) {
      fail('CREDENTIAL_OWNER_MISMATCH', 'credential does not belong to the authenticated owner');
    }
    const origin = normalizeOrigin(endpoint_origin);
    if (current.endpoint_origin_hash !== `sha256:${sha256Hex(origin)}`) {
      fail('CREDENTIAL_ORIGIN_MISMATCH', 'credential rotation cannot change endpoint origin');
    }
    return sealCredential({
      credential_id: current.credential_id,
      owner_user_id,
      credential_revision: current.credential_revision + 1,
      endpoint_origin: origin,
      plaintext,
      rotated_from_revision: current.credential_revision,
      created_at
    });
  }

  function revokeCredential(recordValue, {
    owner_user_id,
    revoked_at = new Date().toISOString()
  }) {
    const current = assertStoredModelCredential(recordValue);
    if (current.owner_user_id !== owner_user_id) {
      fail('CREDENTIAL_OWNER_MISMATCH', 'credential does not belong to the authenticated owner');
    }
    validateTimestamp(revoked_at, 'revoked_at');
    if (current.state === 'REVOKED') return current;
    return assertStoredModelCredential({
      ...current,
      state: 'REVOKED',
      revoked_at
    });
  }

  async function rewrapCredential(recordValue, targetMasterKeyVersion) {
    const current = assertStoredModelCredential(recordValue);
    if (current.master_key_version === targetMasterKeyVersion) return current;
    masterKey(targetMasterKeyVersion);
    const oldWrapAad = aadFor({
      credentialId: current.credential_id,
      ownerUserId: current.owner_user_id,
      credentialRevision: current.credential_revision,
      endpointOriginHash: current.endpoint_origin_hash,
      masterKeyVersion: current.master_key_version,
      layer: 'data-key'
    });
    const wrapped = unpackWrappedKey(current.wrapped_data_key);
    const dataKey = decryptAead(
      wrapped.ciphertext,
      masterKey(current.master_key_version),
      wrapped.nonce,
      wrapped.authTag,
      oldWrapAad
    );
    try {
      const newWrapAad = aadFor({
        credentialId: current.credential_id,
        ownerUserId: current.owner_user_id,
        credentialRevision: current.credential_revision,
        endpointOriginHash: current.endpoint_origin_hash,
        masterKeyVersion: targetMasterKeyVersion,
        layer: 'data-key'
      });
      const nextWrapped = encryptAead(dataKey, masterKey(targetMasterKeyVersion), newWrapAad);
      return assertStoredModelCredential({
        ...current,
        wrapped_data_key: packWrappedKey(nextWrapped),
        master_key_version: targetMasterKeyVersion
      });
    } finally {
      dataKey.fill(0);
      wrapped.nonce.fill(0);
      wrapped.authTag.fill(0);
      wrapped.ciphertext.fill(0);
    }
  }

  return Object.freeze({
    sealCredential,
    withDecryptedCredential,
    rotateCredential,
    revokeCredential,
    rewrapCredential
  });
}
