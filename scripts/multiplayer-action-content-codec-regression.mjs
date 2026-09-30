import assert from 'node:assert/strict';

import { createActionContentCodec } from '../server/multiplayer/security/action-content-codec.js';

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}

const codec = createActionContentCodec({
  masterKeys: { actionKeyV1: Buffer.alloc(32, 0x31) },
  activeMasterKeyVersion: 'actionKeyV1'
});
const context = Object.freeze({
  purpose: 'naruto.multiplayer-action-content/v1',
  room_id: 'room_1',
  epoch_id: 'epoch_1',
  turn_id: 'turn_1',
  submission_id: 'action_1',
  member_id: 'member_1',
  seat_id: 'A'
});
const content = Object.freeze({
  schema: 'naruto.multiplayer-action-content/v1',
  text: '我秘密潜入档案室',
  narration_note: null,
  request_hash: `sha256:${'a'.repeat(64)}`
});

let sealed;
test('action JSON is envelope-encrypted and round-trips only under its full authority context', () => {
  sealed = codec.sealJson(content, context);
  assert.equal(Buffer.from(sealed.action_ciphertext).includes(Buffer.from(content.text)), false);
  assert.equal(sealed.wrapped_data_key.byteLength, 60);
  assert.equal(sealed.nonce.byteLength, 12);
  assert.equal(sealed.auth_tag.byteLength, 16);
  assert.deepEqual(codec.openJson(sealed, context), content);
});

test('room, turn, member, submission and seat binding changes all fail authenticated decryption', () => {
  for (const [field, value] of [
    ['room_id', 'room_2'],
    ['epoch_id', 'epoch_2'],
    ['turn_id', 'turn_2'],
    ['submission_id', 'action_2'],
    ['member_id', 'member_2'],
    ['seat_id', 'B']
  ]) {
    assert.throws(
      () => codec.openJson(sealed, { ...context, [field]: value }),
      error => error.code === 'ACTION_CONTENT_AUTHENTICATION_FAILED'
    );
  }
});

test('ciphertext, nonce, tag and wrapped-key tampering fail closed', () => {
  for (const field of ['action_ciphertext', 'nonce', 'auth_tag', 'wrapped_data_key']) {
    const tampered = { ...sealed, [field]: Buffer.from(sealed[field]) };
    tampered[field][0] ^= 0xff;
    assert.throws(
      () => codec.openJson(tampered, context),
      error => ['ACTION_CONTENT_AUTHENTICATION_FAILED', 'ACTION_CONTENT_ENVELOPE_INVALID']
        .includes(error.code)
    );
  }
});

test('business database envelope alone is unreadable with a different external master key', () => {
  const otherCodec = createActionContentCodec({
    masterKeys: { actionKeyV1: Buffer.alloc(32, 0x32) },
    activeMasterKeyVersion: 'actionKeyV1'
  });
  assert.throws(
    () => otherCodec.openJson(sealed, context),
    error => error.code === 'ACTION_CONTENT_AUTHENTICATION_FAILED'
  );
});

console.log(`\n${passed} multiplayer action-content codec regression tests passed.`);
