import {
  createCipheriv,
  createDecipheriv,
  randomBytes as cryptoRandomBytes
} from 'node:crypto';

import { canonicalStringify } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

const MAGIC = Buffer.from('NMP1', 'ascii');
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_VERSION_BYTES = 80;

function fail(code, message, cause = undefined) {
  throw new DomainError(code, message, {}, { cause });
}

function normalizeKey(value, label) {
  let key = null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) key = Buffer.from(value);
  else if (typeof value === 'string' && value.trim()) key = Buffer.from(value.trim(), 'base64');
  if (!key || key.byteLength !== KEY_BYTES) {
    key?.fill(0);
    fail('ENCRYPTED_JSON_CODEC_CONFIGURATION_INVALID', `${label} must be a 32-byte key`);
  }
  return key;
}

function normalizeKeys(value) {
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
  const keys = new Map();
  for (const [version, keyValue] of entries) {
    if (typeof version !== 'string'
      || !/^[A-Za-z][A-Za-z0-9._:-]{0,79}$/u.test(version)
      || Buffer.byteLength(version) > MAX_VERSION_BYTES) {
      fail('ENCRYPTED_JSON_CODEC_CONFIGURATION_INVALID', 'master key version is invalid');
    }
    keys.set(version, normalizeKey(keyValue, `master key ${version}`));
  }
  if (!keys.size) fail('ENCRYPTED_JSON_CODEC_CONFIGURATION_INVALID', 'master keys are required');
  return keys;
}

function additionalData(context, version) {
  return Buffer.from(canonicalStringify({
    schema: 'naruto.multiplayer-encrypted-json-blob-aad/v1',
    key_version: version,
    context
  }), 'utf8');
}

function unpack(value) {
  const bytes = Buffer.from(value ?? []);
  const minimum = MAGIC.byteLength + 1 + 1 + NONCE_BYTES + TAG_BYTES;
  if (bytes.byteLength < minimum || !bytes.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    fail('ENCRYPTED_JSON_BLOB_INVALID', 'encrypted JSON blob header is invalid');
  }
  const versionLength = bytes[MAGIC.byteLength];
  if (versionLength < 1 || versionLength > MAX_VERSION_BYTES) {
    fail('ENCRYPTED_JSON_BLOB_INVALID', 'encrypted JSON blob key version is invalid');
  }
  const versionStart = MAGIC.byteLength + 1;
  const nonceStart = versionStart + versionLength;
  const tagStart = nonceStart + NONCE_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  if (bytes.byteLength <= ciphertextStart) {
    fail('ENCRYPTED_JSON_BLOB_INVALID', 'encrypted JSON blob is truncated');
  }
  return {
    version: bytes.subarray(versionStart, nonceStart).toString('utf8'),
    nonce: bytes.subarray(nonceStart, tagStart),
    tag: bytes.subarray(tagStart, ciphertextStart),
    ciphertext: bytes.subarray(ciphertextStart)
  };
}

/** Small AEAD codec for audience-safe diffs and encrypted application metadata. */
export function createEncryptedJsonBlobCodec({
  masterKeys,
  activeMasterKeyVersion,
  randomBytes = cryptoRandomBytes
}) {
  const keys = normalizeKeys(masterKeys);
  if (!keys.has(activeMasterKeyVersion)) {
    fail('ENCRYPTED_JSON_CODEC_CONFIGURATION_INVALID', 'active master key is unavailable');
  }
  if (typeof randomBytes !== 'function') {
    fail('ENCRYPTED_JSON_CODEC_CONFIGURATION_INVALID', 'randomBytes must be a function');
  }

  function sealJson(value, context) {
    const version = Buffer.from(activeMasterKeyVersion, 'utf8');
    const nonce = Buffer.from(randomBytes(NONCE_BYTES));
    if (nonce.byteLength !== NONCE_BYTES) {
      fail('ENCRYPTED_JSON_CODEC_CONFIGURATION_INVALID', 'random source returned an invalid nonce');
    }
    const plaintext = Buffer.from(canonicalStringify(value), 'utf8');
    try {
      const cipher = createCipheriv('aes-256-gcm', keys.get(activeMasterKeyVersion), nonce);
      cipher.setAAD(additionalData(context, activeMasterKeyVersion));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([
        MAGIC,
        Buffer.from([version.byteLength]),
        version,
        nonce,
        cipher.getAuthTag(),
        ciphertext
      ]);
    } finally {
      plaintext.fill(0);
    }
  }

  function openJson(value, context) {
    const blob = unpack(value);
    const key = keys.get(blob.version);
    if (!key) fail('ENCRYPTED_JSON_MASTER_KEY_UNAVAILABLE', 'encrypted JSON master key is unavailable');
    let plaintext;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, blob.nonce);
      decipher.setAAD(additionalData(context, blob.version));
      decipher.setAuthTag(blob.tag);
      plaintext = Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch (error) {
      fail('ENCRYPTED_JSON_AUTHENTICATION_FAILED', 'encrypted JSON blob failed authentication', error);
    } finally {
      plaintext?.fill(0);
    }
  }

  return Object.freeze({
    codecVersion: 'naruto.encrypted-json-blob/v1',
    sealJson,
    openJson
  });
}
