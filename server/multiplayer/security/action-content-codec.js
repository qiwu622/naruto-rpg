import {
  createCipheriv,
  createDecipheriv,
  randomBytes as cryptoRandomBytes
} from 'node:crypto';

import { canonicalStringify } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function fail(code, message, cause = undefined) {
  throw new DomainError(code, message, {}, { cause });
}

function normalizeKey(value, label) {
  let key;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    key = Buffer.from(value);
  } else if (typeof value === 'string') {
    try {
      key = Buffer.from(value, 'base64');
    } catch {
      key = null;
    }
  }
  if (!key || key.byteLength !== KEY_BYTES) {
    fail('ACTION_CONTENT_CODEC_CONFIGURATION_INVALID', `${label} must be exactly 32 bytes`);
  }
  return key;
}

function normalizeMasterKeys(value) {
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
  const keys = new Map();
  for (const [version, key] of entries) {
    if (typeof version !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/u.test(version)) {
      fail('ACTION_CONTENT_CODEC_CONFIGURATION_INVALID', 'master key version is invalid');
    }
    keys.set(version, normalizeKey(key, `master key ${version}`));
  }
  if (keys.size === 0) {
    fail('ACTION_CONTENT_CODEC_CONFIGURATION_INVALID', 'at least one master key is required');
  }
  return keys;
}

function aad(context, layer, masterKeyVersion) {
  return Buffer.from(canonicalStringify({
    schema: 'naruto.multiplayer-action-content-aad/v1',
    layer,
    master_key_version: masterKeyVersion,
    context
  }), 'utf8');
}

function encrypt(plaintext, key, additionalData, randomBytes) {
  const nonce = Buffer.from(randomBytes(NONCE_BYTES));
  if (nonce.byteLength !== NONCE_BYTES) {
    fail('ACTION_CONTENT_CODEC_CONFIGURATION_INVALID', 'random source returned an invalid nonce');
  }
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag()
  };
}

function decrypt(ciphertext, key, nonce, authTag, additionalData) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(additionalData);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    fail('ACTION_CONTENT_AUTHENTICATION_FAILED', 'encrypted action content failed authentication', error);
  }
}

function packWrappedKey(value) {
  return Buffer.concat([value.nonce, value.authTag, value.ciphertext]);
}

function unpackWrappedKey(value) {
  const packed = Buffer.from(value);
  if (packed.byteLength !== NONCE_BYTES + TAG_BYTES + KEY_BYTES) {
    fail('ACTION_CONTENT_ENVELOPE_INVALID', 'wrapped action data key has an invalid size');
  }
  return {
    nonce: packed.subarray(0, NONCE_BYTES),
    authTag: packed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES),
    ciphertext: packed.subarray(NONCE_BYTES + TAG_BYTES)
  };
}

export function createActionContentCodec({
  masterKeys,
  activeMasterKeyVersion,
  randomBytes = cryptoRandomBytes
}) {
  const keys = normalizeMasterKeys(masterKeys);
  if (!keys.has(activeMasterKeyVersion)) {
    fail('ACTION_CONTENT_CODEC_CONFIGURATION_INVALID', 'active master key is unavailable');
  }
  if (typeof randomBytes !== 'function') {
    fail('ACTION_CONTENT_CODEC_CONFIGURATION_INVALID', 'random source must be a function');
  }

  function sealJson(value, context) {
    const plaintext = Buffer.from(canonicalStringify(value), 'utf8');
    const dataKey = Buffer.from(randomBytes(KEY_BYTES));
    if (dataKey.byteLength !== KEY_BYTES) {
      fail('ACTION_CONTENT_CODEC_CONFIGURATION_INVALID', 'random source returned an invalid data key');
    }
    try {
      const content = encrypt(
        plaintext,
        dataKey,
        aad(context, 'content', activeMasterKeyVersion),
        randomBytes
      );
      const wrapped = encrypt(
        dataKey,
        keys.get(activeMasterKeyVersion),
        aad(context, 'data-key', activeMasterKeyVersion),
        randomBytes
      );
      return Object.freeze({
        action_ciphertext: content.ciphertext,
        wrapped_data_key: packWrappedKey(wrapped),
        nonce: content.nonce,
        auth_tag: content.authTag,
        master_key_version: activeMasterKeyVersion
      });
    } finally {
      plaintext.fill(0);
      dataKey.fill(0);
    }
  }

  function openJson(envelope, context) {
    const version = envelope?.master_key_version;
    const masterKey = keys.get(version);
    if (!masterKey) fail('ACTION_CONTENT_MASTER_KEY_UNAVAILABLE', 'action master key is unavailable');
    const wrapped = unpackWrappedKey(envelope.wrapped_data_key);
    const dataKey = decrypt(
      wrapped.ciphertext,
      masterKey,
      wrapped.nonce,
      wrapped.authTag,
      aad(context, 'data-key', version)
    );
    let plaintext;
    try {
      if (dataKey.byteLength !== KEY_BYTES) {
        fail('ACTION_CONTENT_ENVELOPE_INVALID', 'unwrapped action data key has an invalid size');
      }
      plaintext = decrypt(
        Buffer.from(envelope.action_ciphertext),
        dataKey,
        Buffer.from(envelope.nonce),
        Buffer.from(envelope.auth_tag),
        aad(context, 'content', version)
      );
      try {
        return JSON.parse(plaintext.toString('utf8'));
      } catch (error) {
        fail('ACTION_CONTENT_ENVELOPE_INVALID', 'decrypted action content is not JSON', error);
      }
    } finally {
      plaintext?.fill(0);
      dataKey.fill(0);
      wrapped.nonce.fill(0);
      wrapped.authTag.fill(0);
      wrapped.ciphertext.fill(0);
    }
  }

  return Object.freeze({ sealJson, openJson });
}
