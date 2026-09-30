import assert from 'node:assert/strict';

import { createEncryptedJsonBlobCodec } from '../server/multiplayer/security/encrypted-json-blob-codec.js';

let passed = 0;
function test(name, operation) {
  operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

let nonce = 0;
const codec = createEncryptedJsonBlobCodec({
  masterKeys: {
    v1: Buffer.alloc(32, 0x11),
    v2: Buffer.alloc(32, 0x22)
  },
  activeMasterKeyVersion: 'v2',
  randomBytes(size) {
    const output = Buffer.alloc(size);
    output.writeUInt32BE(++nonce, size - 4);
    return output;
  }
});

test('round-trips canonical JSON without embedding plaintext', () => {
  const context = { room_id: 'room_1', audience: 'A' };
  const blob = codec.sealJson({ private_text: '不能出现在数据库明文中' }, context);
  assert.equal(blob.includes(Buffer.from('不能出现在数据库明文中')), false);
  assert.deepEqual(codec.openJson(blob, context), { private_text: '不能出现在数据库明文中' });
});

test('AAD context changes are rejected', () => {
  const blob = codec.sealJson({ value: 1 }, { room_id: 'room_1', audience: 'A' });
  assert.throws(
    () => codec.openJson(blob, { room_id: 'room_1', audience: 'B' }),
    error => error?.code === 'ENCRYPTED_JSON_AUTHENTICATION_FAILED'
  );
});

test('ciphertext tampering is rejected', () => {
  const blob = Buffer.from(codec.sealJson({ value: 2 }, { id: 'item_1' }));
  blob[blob.length - 1] ^= 0xff;
  assert.throws(
    () => codec.openJson(blob, { id: 'item_1' }),
    error => error?.code === 'ENCRYPTED_JSON_AUTHENTICATION_FAILED'
  );
});

console.log(`multiplayer encrypted JSON blob codec regression: ${passed} passed`);
