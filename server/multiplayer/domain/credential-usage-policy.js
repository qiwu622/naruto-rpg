import { DomainError } from './errors.js';

export const CREDENTIAL_USAGE_POLICIES = Object.freeze([
  'A_ONLY',
  'B_ONLY',
  'ALTERNATE'
]);

export function assertCredentialUsagePolicy(value) {
  if (!CREDENTIAL_USAGE_POLICIES.includes(value)) {
    throw new DomainError(
      'CREDENTIAL_USAGE_POLICY_INVALID',
      'credential usage policy must be A_ONLY, B_ONLY, or ALTERNATE'
    );
  }
  return value;
}

/** Odd turns start with A; even turns use B. */
export function resolveCredentialPayerSeat(policyValue, turnNo) {
  const policy = assertCredentialUsagePolicy(policyValue);
  if (!Number.isSafeInteger(turnNo) || turnNo < 1) {
    throw new DomainError(
      'TURN_NUMBER_INVALID',
      'turn_no must be a positive safe integer'
    );
  }
  if (policy === 'A_ONLY') return 'A';
  if (policy === 'B_ONLY') return 'B';
  return turnNo % 2 === 1 ? 'A' : 'B';
}

