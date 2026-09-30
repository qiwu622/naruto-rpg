import assert from 'node:assert/strict';

import { createCredentialVault } from '../server/multiplayer/security/credential-vault.js';

const NOW = '2026-08-22T10:00:00.000Z';
const LATER = '2026-08-22T11:00:00.000Z';
const OWNER = '123456789012345678';
const ORIGIN = 'https://models.example.test';

function vault(overrides = {}) {
  return createCredentialVault({
    masterKeys: {
      'master-v1': Buffer.alloc(32, 0x11),
      'master-v2': Buffer.alloc(32, 0x22)
    },
    activeMasterKeyVersion: 'master-v1',
    fingerprintKey: Buffer.alloc(32, 0x33),
    ...overrides
  });
}

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const credentials = vault();
const stored = credentials.sealCredential({
  credential_id: 'credential-discord-owner',
  owner_user_id: OWNER,
  endpoint_origin: ORIGIN,
  plaintext: 'sk-super-secret-value',
  created_at: NOW
});

await test('envelope encryption produces a strict opaque StoredModelCredential', () => {
  assert.equal(stored.schema, 'naruto.multiplayer-stored-model-credential/v1');
  assert.equal(stored.owner_user_id, OWNER);
  assert.equal(stored.endpoint_origin_hash.length, 71);
  assert.equal(stored.master_key_version, 'master-v1');
  assert.equal(stored.fingerprint_suffix.length, 12);
  assert.equal('plaintext' in stored, false);
  assert.equal('api_key' in stored, false);
  assert.equal(JSON.stringify(stored).includes('sk-super-secret-value'), false);
  assert.ok(Object.isFrozen(stored));
  assert.deepEqual(Object.keys(credentials).sort(), [
    'revokeCredential',
    'rewrapCredential',
    'rotateCredential',
    'sealCredential',
    'withDecryptedCredential'
  ]);
});

await test('plaintext is exposed only inside the owner/origin-bound callback and then wiped', async () => {
  let borrowedBuffer;
  const observed = await credentials.withDecryptedCredential(stored, {
    owner_user_id: OWNER,
    endpoint_origin: ORIGIN
  }, secret => {
    borrowedBuffer = secret;
    return secret.toString('utf8');
  });
  assert.equal(observed, 'sk-super-secret-value');
  assert.equal(borrowedBuffer.every(byte => byte === 0), true);

  await assert.rejects(
    credentials.withDecryptedCredential(stored, {
      owner_user_id: '987654321098765432',
      endpoint_origin: ORIGIN
    }, () => null),
    error => error.code === 'CREDENTIAL_OWNER_MISMATCH'
  );
  await assert.rejects(
    credentials.withDecryptedCredential(stored, {
      owner_user_id: OWNER,
      endpoint_origin: 'https://other.example.test'
    }, () => null),
    error => error.code === 'CREDENTIAL_ORIGIN_MISMATCH'
  );
});

await test('ciphertext and binding tampering fail authenticated decryption', async () => {
  const tamperedBytes = Buffer.from(stored.ciphertext, 'base64');
  tamperedBytes[0] ^= 0x01;
  const tampered = { ...stored, ciphertext: tamperedBytes.toString('base64') };
  await assert.rejects(
    credentials.withDecryptedCredential(tampered, {
      owner_user_id: OWNER,
      endpoint_origin: ORIGIN
    }, () => null),
    error => error.code === 'CREDENTIAL_AUTHENTICATION_FAILED'
  );

  const forgedOwner = { ...stored, owner_user_id: '987654321098765432' };
  await assert.rejects(
    credentials.withDecryptedCredential(forgedOwner, {
      owner_user_id: forgedOwner.owner_user_id,
      endpoint_origin: ORIGIN
    }, () => null),
    error => error.code === 'CREDENTIAL_AUTHENTICATION_FAILED'
  );
});

await test('rotation creates a new immutable revision without changing endpoint ownership', async () => {
  const rotated = credentials.rotateCredential(stored, {
    owner_user_id: OWNER,
    endpoint_origin: ORIGIN,
    plaintext: 'sk-rotated-value',
    created_at: LATER
  });
  assert.equal(rotated.credential_id, stored.credential_id);
  assert.equal(rotated.credential_revision, 2);
  assert.equal(rotated.rotated_from_revision, 1);
  assert.notEqual(rotated.ciphertext, stored.ciphertext);
  assert.notEqual(rotated.fingerprint_suffix, stored.fingerprint_suffix);
  const opened = await credentials.withDecryptedCredential(rotated, {
    owner_user_id: OWNER,
    endpoint_origin: ORIGIN
  }, secret => secret.toString('utf8'));
  assert.equal(opened, 'sk-rotated-value');
  assert.throws(
    () => credentials.rotateCredential(stored, {
      owner_user_id: OWNER,
      endpoint_origin: 'https://other.example.test',
      plaintext: 'forbidden'
    }),
    error => error.code === 'CREDENTIAL_ORIGIN_MISMATCH'
  );
});

await test('revocation blocks new outbound use and is idempotent', async () => {
  const revoked = credentials.revokeCredential(stored, {
    owner_user_id: OWNER,
    revoked_at: LATER
  });
  assert.equal(revoked.state, 'REVOKED');
  assert.equal(revoked.revoked_at, LATER);
  assert.deepEqual(credentials.revokeCredential(revoked, {
    owner_user_id: OWNER,
    revoked_at: LATER
  }), revoked);
  await assert.rejects(
    credentials.withDecryptedCredential(revoked, {
      owner_user_id: OWNER,
      endpoint_origin: ORIGIN
    }, () => null),
    error => error.code === 'CREDENTIAL_REVOKED'
  );
});

await test('master-key rewrap preserves data ciphertext and remains decryptable', async () => {
  const rewrapped = await credentials.rewrapCredential(stored, 'master-v2');
  assert.equal(rewrapped.master_key_version, 'master-v2');
  assert.equal(rewrapped.ciphertext, stored.ciphertext);
  assert.equal(rewrapped.nonce, stored.nonce);
  assert.equal(rewrapped.auth_tag, stored.auth_tag);
  assert.notEqual(rewrapped.wrapped_data_key, stored.wrapped_data_key);
  const opened = await credentials.withDecryptedCredential(rewrapped, {
    owner_user_id: OWNER,
    endpoint_origin: ORIGIN
  }, secret => secret.toString('utf8'));
  assert.equal(opened, 'sk-super-secret-value');
});

await test('a business-database record alone cannot be decrypted with another master key', async () => {
  const unrelatedVault = createCredentialVault({
    masterKeys: { 'master-v1': Buffer.alloc(32, 0x77) },
    activeMasterKeyVersion: 'master-v1',
    fingerprintKey: Buffer.alloc(32, 0x66)
  });
  await assert.rejects(
    unrelatedVault.withDecryptedCredential(stored, {
      owner_user_id: OWNER,
      endpoint_origin: ORIGIN
    }, () => null),
    error => error.code === 'CREDENTIAL_AUTHENTICATION_FAILED'
  );
});

console.log(`\n${passed} multiplayer credential-vault regression tests passed.`);
