import {
  assertBoolean,
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';

export const COMMIT_PRECONDITION_SET_SCHEMA =
  'naruto.commit-precondition-set/v1';

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SHA256_PATTERN = '^sha256:[a-f0-9]{64}$';
const HMAC_SHA256_PATTERN = '^hmac-sha256:[a-f0-9]{64}$';
const SHA256_REGEXP = /^sha256:[a-f0-9]{64}$/u;
const HMAC_SHA256_REGEXP = /^hmac-sha256:[a-f0-9]{64}$/u;

const TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'identity',
  'lifecycle',
  'concurrency',
  'frozen_inputs',
  'billing',
  'result'
]);
const IDENTITY_KEYS = Object.freeze([
  'room_id',
  'epoch_id',
  'turn_id',
  'run_id',
  'draft_id',
  'commit_id'
]);
const LIFECYCLE_KEYS = Object.freeze([
  'room_lifecycle',
  'epoch_state',
  'turn_status',
  'current_turn_id',
  'void_requested'
]);
const CONCURRENCY_KEYS = Object.freeze([
  'base_state_revision',
  'base_state_hash',
  'lease_fence',
  'draft_revision',
  'draft_status'
]);
const FROZEN_INPUT_KEYS = Object.freeze([
  'input_hash',
  'resolution_hash',
  'obligation_set_hash',
  'execution_plan_hash'
]);
const BILLING_KEYS = Object.freeze(['billing_provenance_hash']);
const RESULT_KEYS = Object.freeze([
  'candidate_state_hash',
  'artifact_bundle_hash',
  'narrative_bundle_hash',
  'semantic_draft_hash',
  'commit_envelope_hash'
]);

const prefixedIdJsonSchema = prefix => ({
  type: 'string',
  minLength: prefix.length + 1,
  maxLength: 160,
  pattern: `^${prefix}[A-Za-z0-9_-]{1,${160 - prefix.length}}$`
});
const sha256JsonSchema = {
  type: 'string',
  minLength: 71,
  maxLength: 71,
  pattern: SHA256_PATTERN
};
const hmacSha256JsonSchema = {
  type: 'string',
  minLength: 76,
  maxLength: 76,
  pattern: HMAC_SHA256_PATTERN
};

const identityJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: IDENTITY_KEYS,
  properties: {
    room_id: prefixedIdJsonSchema('room_'),
    epoch_id: prefixedIdJsonSchema('epoch_'),
    turn_id: prefixedIdJsonSchema('turn_'),
    run_id: prefixedIdJsonSchema('run_'),
    draft_id: prefixedIdJsonSchema('draft_'),
    commit_id: prefixedIdJsonSchema('commit_')
  }
};

const lifecycleJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: LIFECYCLE_KEYS,
  properties: {
    room_lifecycle: { const: 'ACTIVE' },
    epoch_state: { const: 'ACTIVE' },
    turn_status: { const: 'COMMITTING' },
    current_turn_id: prefixedIdJsonSchema('turn_'),
    void_requested: { const: false }
  }
};

const concurrencyJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: CONCURRENCY_KEYS,
  properties: {
    base_state_revision: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER
    },
    base_state_hash: sha256JsonSchema,
    lease_fence: {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER
    },
    draft_revision: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER
    },
    draft_status: { const: 'READY' }
  }
};

const frozenInputsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: FROZEN_INPUT_KEYS,
  properties: {
    input_hash: hmacSha256JsonSchema,
    resolution_hash: sha256JsonSchema,
    obligation_set_hash: sha256JsonSchema,
    execution_plan_hash: sha256JsonSchema
  }
};

const billingJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: BILLING_KEYS,
  properties: {
    billing_provenance_hash: sha256JsonSchema
  }
};

const resultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: RESULT_KEYS,
  properties: {
    candidate_state_hash: sha256JsonSchema,
    artifact_bundle_hash: sha256JsonSchema,
    narrative_bundle_hash: sha256JsonSchema,
    semantic_draft_hash: sha256JsonSchema,
    commit_envelope_hash: sha256JsonSchema
  }
};

/**
 * This is the only final-commit parameter schema. Repositories must accept
 * this complete value, not identity-only or hash-only alternatives.
 */
export const COMMIT_PRECONDITION_SET_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: COMMIT_PRECONDITION_SET_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: TOP_LEVEL_KEYS,
  properties: {
    schema: { const: COMMIT_PRECONDITION_SET_SCHEMA },
    identity: { $ref: '#/$defs/identity' },
    lifecycle: { $ref: '#/$defs/lifecycle' },
    concurrency: { $ref: '#/$defs/concurrency' },
    frozen_inputs: { $ref: '#/$defs/frozenInputs' },
    billing: { $ref: '#/$defs/billing' },
    result: { $ref: '#/$defs/result' }
  },
  $defs: {
    identity: identityJsonSchema,
    lifecycle: lifecycleJsonSchema,
    concurrency: concurrencyJsonSchema,
    frozenInputs: frozenInputsJsonSchema,
    billing: billingJsonSchema,
    result: resultJsonSchema
  }
});

function assertObject(value, keys, path, label) {
  return assertExactKeys(value, {
    allowed: keys,
    path,
    label
  });
}

function assertPrefixedId(value, prefix, path, label) {
  return assertIdentifier(value, {
    path,
    label,
    prefix,
    max: 160
  });
}

function assertSha256(value, path, label) {
  return assertString(value, {
    path,
    label,
    min: 71,
    max: 71,
    pattern: SHA256_REGEXP
  });
}

function assertHmacSha256(value, path, label) {
  return assertString(value, {
    path,
    label,
    min: 76,
    max: 76,
    pattern: HMAC_SHA256_REGEXP
  });
}

function normalizeIdentity(identity) {
  assertObject(identity, IDENTITY_KEYS, '/identity', 'commit identity');
  for (const [key, prefix] of [
    ['room_id', 'room_'],
    ['epoch_id', 'epoch_'],
    ['turn_id', 'turn_'],
    ['run_id', 'run_'],
    ['draft_id', 'draft_'],
    ['commit_id', 'commit_']
  ]) {
    assertPrefixedId(identity[key], prefix, `/identity/${key}`, key);
  }
  return immutableContractValue(identity);
}

function normalizeLifecycle(lifecycle, identity) {
  assertObject(lifecycle, LIFECYCLE_KEYS, '/lifecycle', 'commit lifecycle');
  assertString(lifecycle.room_lifecycle, {
    path: '/lifecycle/room_lifecycle',
    label: 'room_lifecycle',
    enumValues: ['ACTIVE'],
    max: 16
  });
  assertString(lifecycle.epoch_state, {
    path: '/lifecycle/epoch_state',
    label: 'epoch_state',
    enumValues: ['ACTIVE'],
    max: 16
  });
  assertString(lifecycle.turn_status, {
    path: '/lifecycle/turn_status',
    label: 'turn_status',
    enumValues: ['COMMITTING'],
    max: 16
  });
  assertPrefixedId(
    lifecycle.current_turn_id,
    'turn_',
    '/lifecycle/current_turn_id',
    'current_turn_id'
  );
  if (lifecycle.current_turn_id !== identity.turn_id) {
    throw contractError(
      '/lifecycle/current_turn_id',
      'current_turn_id must equal identity.turn_id',
      {
        expected: identity.turn_id,
        actual: lifecycle.current_turn_id
      }
    );
  }
  assertBoolean(lifecycle.void_requested, {
    path: '/lifecycle/void_requested',
    label: 'void_requested'
  });
  if (lifecycle.void_requested !== false) {
    throw contractError(
      '/lifecycle/void_requested',
      'void_requested must be false for final commit'
    );
  }
  return immutableContractValue(lifecycle);
}

function normalizeConcurrency(concurrency) {
  assertObject(concurrency, CONCURRENCY_KEYS, '/concurrency', 'commit concurrency');
  assertInteger(concurrency.base_state_revision, {
    path: '/concurrency/base_state_revision',
    label: 'base_state_revision',
    min: 0
  });
  assertSha256(
    concurrency.base_state_hash,
    '/concurrency/base_state_hash',
    'base_state_hash'
  );
  assertInteger(concurrency.lease_fence, {
    path: '/concurrency/lease_fence',
    label: 'lease_fence',
    min: 1
  });
  assertInteger(concurrency.draft_revision, {
    path: '/concurrency/draft_revision',
    label: 'draft_revision',
    min: 0
  });
  assertString(concurrency.draft_status, {
    path: '/concurrency/draft_status',
    label: 'draft_status',
    enumValues: ['READY'],
    max: 16
  });
  return immutableContractValue(concurrency);
}

function normalizeFrozenInputs(frozenInputs) {
  assertObject(
    frozenInputs,
    FROZEN_INPUT_KEYS,
    '/frozen_inputs',
    'commit frozen inputs'
  );
  assertHmacSha256(frozenInputs.input_hash, '/frozen_inputs/input_hash', 'input_hash');
  for (const key of ['resolution_hash', 'obligation_set_hash', 'execution_plan_hash']) {
    assertSha256(frozenInputs[key], `/frozen_inputs/${key}`, key);
  }
  return immutableContractValue(frozenInputs);
}

function normalizeBilling(billing) {
  assertObject(billing, BILLING_KEYS, '/billing', 'commit billing');
  assertSha256(
    billing.billing_provenance_hash,
    '/billing/billing_provenance_hash',
    'billing_provenance_hash'
  );
  return immutableContractValue(billing);
}

function normalizeResult(result) {
  assertObject(result, RESULT_KEYS, '/result', 'commit result');
  for (const key of RESULT_KEYS) {
    assertSha256(result[key], `/result/${key}`, key);
  }
  return immutableContractValue(result);
}

/**
 * Accepts only the complete section 13.9 CommitPreconditionSet/v1. No group is
 * optional and lifecycle/draft gates cannot be relaxed by caller parameters.
 */
export function assertCommitPreconditionSet(value) {
  assertObject(
    value,
    TOP_LEVEL_KEYS,
    '/',
    'CommitPreconditionSet'
  );
  assertString(value.schema, {
    path: '/schema',
    label: 'schema',
    enumValues: [COMMIT_PRECONDITION_SET_SCHEMA],
    max: 128
  });
  const identity = normalizeIdentity(value.identity);
  const lifecycle = normalizeLifecycle(value.lifecycle, identity);
  const concurrency = normalizeConcurrency(value.concurrency);
  const frozenInputs = normalizeFrozenInputs(value.frozen_inputs);
  const billing = normalizeBilling(value.billing);
  const result = normalizeResult(value.result);

  return immutableContractValue({
    schema: COMMIT_PRECONDITION_SET_SCHEMA,
    identity,
    lifecycle,
    concurrency,
    frozen_inputs: frozenInputs,
    billing,
    result
  });
}

export function inspectCommitPreconditionSet(value) {
  return inspectContract(value, assertCommitPreconditionSet);
}
