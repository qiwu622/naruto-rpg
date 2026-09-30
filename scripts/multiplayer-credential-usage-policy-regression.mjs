import assert from 'node:assert/strict';

import {
  CREDENTIAL_USAGE_POLICIES,
  assertCredentialUsagePolicy,
  resolveCredentialPayerSeat
} from '../server/multiplayer/domain/credential-usage-policy.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';

let passed = 0;
function test(name, callback) {
  callback();
  passed += 1;
  console.log(`PASS ${name}`);
}

test('credential usage policies are exactly the three mutually exclusive choices', () => {
  assert.deepEqual(CREDENTIAL_USAGE_POLICIES, ['A_ONLY', 'B_ONLY', 'ALTERNATE']);
  assert.equal(Object.isFrozen(CREDENTIAL_USAGE_POLICIES), true);
});

test('A_ONLY always resolves to seat A', () => {
  for (const turnNo of [1, 2, 99, Number.MAX_SAFE_INTEGER]) {
    assert.equal(resolveCredentialPayerSeat('A_ONLY', turnNo), 'A');
  }
});

test('B_ONLY always resolves to seat B', () => {
  for (const turnNo of [1, 2, 99, Number.MAX_SAFE_INTEGER]) {
    assert.equal(resolveCredentialPayerSeat('B_ONLY', turnNo), 'B');
  }
});

test('ALTERNATE uses A on odd turns and B on even turns', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 101, 102].map(turnNo => (
      resolveCredentialPayerSeat('ALTERNATE', turnNo)
    )),
    ['A', 'B', 'A', 'B', 'A', 'B']
  );
});

test('invalid policies fail with the credential-policy domain code', () => {
  for (const value of [null, '', 'A', 'B', 'ROUND_ROBIN', 'alternate']) {
    assert.throws(
      () => assertCredentialUsagePolicy(value),
      error => error instanceof DomainError
        && error.code === 'CREDENTIAL_USAGE_POLICY_INVALID'
    );
  }
});

test('invalid turn numbers fail before resolving an alternate payer', () => {
  for (const turnNo of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '1']) {
    assert.throws(
      () => resolveCredentialPayerSeat('ALTERNATE', turnNo),
      error => error instanceof DomainError && error.code === 'TURN_NUMBER_INVALID'
    );
  }
});

console.log(`${passed} credential usage policy regression tests passed.`);
