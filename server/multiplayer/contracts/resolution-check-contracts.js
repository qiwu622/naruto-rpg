import { sha256Hex } from '../domain/canonical-json.js';
import {
  assertArray,
  assertExactKeys,
  assertInteger,
  assertPlainRecord,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';

export const REFEREE_CHECK_JSON_PROTOCOL = 'naruto.referee-check-json/v1';
export const REQUEST_RESOLUTION_CHECK_OPERATION = 'request_resolution_check';
export const RESOLUTION_CHECK_REQUEST_SCHEMA = 'naruto.referee-check-request/v1';
export const RESOLUTION_CHECK_RESULT_SCHEMA = 'naruto.referee-check-result/v1';

export const RESOLUTION_CHECK_LIMITS = Object.freeze({
  maxParticipants: 16,
  maxAttributeRuleRefs: 32,
  maxRolls: 16,
  maxReasonLength: 2_000,
  maxReferenceLength: 160,
  maxCheckIdLength: 160,
  maxConflictTypeLength: 128,
  maxOutcomeLength: 128,
  maxErrorCodeLength: 128
});

export const RESOLUTION_CHECK_CORRECTABLE_FIELDS = Object.freeze([
  'participant_refs',
  'conflict_type',
  'attribute_rule_refs',
  'rule_ref',
  'reason'
]);

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const CHECK_ID_PATTERN = '^check_[A-Za-z0-9_-]{1,154}$';
const REFERENCE_PATTERN = '^[A-Za-z][A-Za-z0-9._:/-]*$';
const CONFLICT_TYPE_PATTERN = '^[a-z][a-z0-9_:-]*$';
const OUTCOME_PATTERN = '^[A-Z][A-Z0-9_:-]*$';
const ERROR_CODE_PATTERN = '^[A-Z][A-Z0-9_]*$';
const SHA256_PATTERN = '^sha256:[a-f0-9]{64}$';
const SAFE_NONBLANK_TEXT_PATTERN =
  '^(?=[\\s\\S]*\\S)(?![\\s\\S]*[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069])[\\s\\S]*$';

const CHECK_ID_REGEXP = /^check_[A-Za-z0-9_-]{1,154}$/u;
const REFERENCE_REGEXP = /^[A-Za-z][A-Za-z0-9._:/-]*$/u;
const CONFLICT_TYPE_REGEXP = /^[a-z][a-z0-9_:-]*$/u;
const OUTCOME_REGEXP = /^[A-Z][A-Z0-9_:-]*$/u;
const ERROR_CODE_REGEXP = /^[A-Z][A-Z0-9_]*$/u;
const SHA256_REGEXP = /^sha256:[a-f0-9]{64}$/u;

const requestDefinition = {
  type: 'object',
  additionalProperties: false,
  required: [
    'check_id',
    'participant_refs',
    'conflict_type',
    'attribute_rule_refs',
    'rule_ref',
    'reason'
  ],
  properties: {
    check_id: {
      type: 'string',
      minLength: 7,
      maxLength: RESOLUTION_CHECK_LIMITS.maxCheckIdLength,
      pattern: CHECK_ID_PATTERN
    },
    participant_refs: {
      type: 'array',
      minItems: 1,
      maxItems: RESOLUTION_CHECK_LIMITS.maxParticipants,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 2,
        maxLength: RESOLUTION_CHECK_LIMITS.maxReferenceLength,
        pattern: REFERENCE_PATTERN
      }
    },
    conflict_type: {
      type: 'string',
      minLength: 2,
      maxLength: RESOLUTION_CHECK_LIMITS.maxConflictTypeLength,
      pattern: CONFLICT_TYPE_PATTERN
    },
    attribute_rule_refs: {
      type: 'array',
      minItems: 1,
      maxItems: RESOLUTION_CHECK_LIMITS.maxAttributeRuleRefs,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 2,
        maxLength: RESOLUTION_CHECK_LIMITS.maxReferenceLength,
        pattern: REFERENCE_PATTERN
      }
    },
    rule_ref: {
      type: 'string',
      minLength: 2,
      maxLength: RESOLUTION_CHECK_LIMITS.maxReferenceLength,
      pattern: REFERENCE_PATTERN
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: RESOLUTION_CHECK_LIMITS.maxReasonLength,
      pattern: SAFE_NONBLANK_TEXT_PATTERN
    }
  }
};

const rollDefinition = {
  type: 'object',
  additionalProperties: false,
  required: ['participant_ref', 'raw', 'modifier', 'total'],
  properties: {
    participant_ref: {
      type: 'string',
      minLength: 2,
      maxLength: RESOLUTION_CHECK_LIMITS.maxReferenceLength,
      pattern: REFERENCE_PATTERN
    },
    raw: {
      type: 'integer',
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER
    },
    modifier: {
      type: 'integer',
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER
    },
    total: {
      type: 'integer',
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER
    }
  }
};

const resolvedResultDefinition = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'status',
    'check_id',
    'rule_ref',
    'rolls',
    'outcome',
    'result_hash'
  ],
  properties: {
    schema: { const: RESOLUTION_CHECK_RESULT_SCHEMA },
    status: { const: 'RESOLVED' },
    check_id: requestDefinition.properties.check_id,
    rule_ref: requestDefinition.properties.rule_ref,
    rolls: {
      type: 'array',
      minItems: 1,
      maxItems: RESOLUTION_CHECK_LIMITS.maxRolls,
      items: rollDefinition
    },
    outcome: {
      type: 'string',
      minLength: 2,
      maxLength: RESOLUTION_CHECK_LIMITS.maxOutcomeLength,
      pattern: OUTCOME_PATTERN
    },
    result_hash: { type: 'string', pattern: SHA256_PATTERN }
  }
};

const rejectedResultDefinition = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'status',
    'check_id',
    'error_code',
    'allowed_correction_fields',
    'result_hash'
  ],
  properties: {
    schema: { const: RESOLUTION_CHECK_RESULT_SCHEMA },
    status: { const: 'REJECTED' },
    check_id: requestDefinition.properties.check_id,
    error_code: {
      type: 'string',
      minLength: 2,
      maxLength: RESOLUTION_CHECK_LIMITS.maxErrorCodeLength,
      pattern: ERROR_CODE_PATTERN
    },
    allowed_correction_fields: {
      type: 'array',
      minItems: 1,
      maxItems: RESOLUTION_CHECK_CORRECTABLE_FIELDS.length,
      uniqueItems: true,
      items: { type: 'string', enum: RESOLUTION_CHECK_CORRECTABLE_FIELDS }
    },
    result_hash: { type: 'string', pattern: SHA256_PATTERN }
  }
};

export const RESOLUTION_CHECK_REQUEST_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: RESOLUTION_CHECK_REQUEST_SCHEMA,
  ...requestDefinition
});

export const REFEREE_CHECK_JSON_COMMAND_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: REFEREE_CHECK_JSON_PROTOCOL,
  type: 'object',
  additionalProperties: false,
  required: ['protocol', 'operation', 'request'],
  properties: {
    protocol: { const: REFEREE_CHECK_JSON_PROTOCOL },
    operation: { const: REQUEST_RESOLUTION_CHECK_OPERATION },
    request: requestDefinition
  }
});

export const RESOLUTION_CHECK_RESOLVED_RESULT_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  ...resolvedResultDefinition
});

export const RESOLUTION_CHECK_REJECTED_RESULT_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  ...rejectedResultDefinition
});

export const RESOLUTION_CHECK_RESULT_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: RESOLUTION_CHECK_RESULT_SCHEMA,
  oneOf: [resolvedResultDefinition, rejectedResultDefinition]
});

// Names matching the design's protocol wording are kept as direct aliases.
export const REQUEST_RESOLUTION_CHECK_JSON_SCHEMA = RESOLUTION_CHECK_REQUEST_JSON_SCHEMA;
export const REFEREE_CHECK_JSON_ENVELOPE_JSON_SCHEMA =
  REFEREE_CHECK_JSON_COMMAND_JSON_SCHEMA;

const REQUEST_KEYS = Object.freeze([
  'check_id',
  'participant_refs',
  'conflict_type',
  'attribute_rule_refs',
  'rule_ref',
  'reason'
]);
const COMMAND_KEYS = Object.freeze(['protocol', 'operation', 'request']);
const ROLL_KEYS = Object.freeze(['participant_ref', 'raw', 'modifier', 'total']);
const RESOLVED_RESULT_KEYS = Object.freeze([
  'schema',
  'status',
  'check_id',
  'rule_ref',
  'rolls',
  'outcome',
  'result_hash'
]);
const REJECTED_RESULT_KEYS = Object.freeze([
  'schema',
  'status',
  'check_id',
  'error_code',
  'allowed_correction_fields',
  'result_hash'
]);

function assertObject(value, { allowed, path = '/', label }) {
  assertPlainRecord(value, path, label);
  return assertExactKeys(value, { allowed, required: allowed, path, label });
}

function childPath(path, key) {
  return path === '/' ? `/${key}` : `${path}/${key}`;
}

function assertNonblank(value, { path, label, max, pattern = null }) {
  assertString(value, { path, label, min: 1, max, pattern });
  if (!value.trim()) throw contractError(path, `${label} must contain non-whitespace text`);
  return value;
}

function assertCheckId(value, path = '/check_id') {
  return assertString(value, {
    path,
    label: 'check_id',
    min: 7,
    max: RESOLUTION_CHECK_LIMITS.maxCheckIdLength,
    pattern: CHECK_ID_REGEXP
  });
}

function assertReference(value, path, label) {
  return assertString(value, {
    path,
    label,
    min: 2,
    max: RESOLUTION_CHECK_LIMITS.maxReferenceLength,
    pattern: REFERENCE_REGEXP
  });
}

function assertUniqueStringArray(value, {
  path,
  label,
  min,
  max,
  validate
}) {
  return assertArray(value, {
    path,
    label,
    min,
    max,
    item: validate,
    uniqueBy: item => item
  });
}

export function assertResolutionCheckRequest(value, path = '/') {
  assertObject(value, {
    allowed: REQUEST_KEYS,
    path,
    label: 'resolution check request'
  });
  assertCheckId(value.check_id, childPath(path, 'check_id'));
  assertUniqueStringArray(value.participant_refs, {
    path: childPath(path, 'participant_refs'),
    label: 'participant_refs',
    min: 1,
    max: RESOLUTION_CHECK_LIMITS.maxParticipants,
    validate: (item, itemPath) => assertReference(item, itemPath, 'participant_ref')
  });
  assertString(value.conflict_type, {
    path: childPath(path, 'conflict_type'),
    label: 'conflict_type',
    min: 2,
    max: RESOLUTION_CHECK_LIMITS.maxConflictTypeLength,
    pattern: CONFLICT_TYPE_REGEXP
  });
  assertUniqueStringArray(value.attribute_rule_refs, {
    path: childPath(path, 'attribute_rule_refs'),
    label: 'attribute_rule_refs',
    min: 1,
    max: RESOLUTION_CHECK_LIMITS.maxAttributeRuleRefs,
    validate: (item, itemPath) => assertReference(item, itemPath, 'attribute_rule_ref')
  });
  assertReference(value.rule_ref, childPath(path, 'rule_ref'), 'rule_ref');
  assertNonblank(value.reason, {
    path: childPath(path, 'reason'),
    label: 'reason',
    max: RESOLUTION_CHECK_LIMITS.maxReasonLength
  });
  return immutableContractValue(value);
}

export function inspectResolutionCheckRequest(value) {
  return inspectContract(value, assertResolutionCheckRequest);
}

export function assertRefereeCheckJsonCommand(value) {
  assertObject(value, {
    allowed: COMMAND_KEYS,
    path: '/',
    label: 'Referee check JSON command'
  });
  if (value.protocol !== REFEREE_CHECK_JSON_PROTOCOL) {
    throw contractError('/protocol', `protocol must be ${REFEREE_CHECK_JSON_PROTOCOL}`);
  }
  if (value.operation !== REQUEST_RESOLUTION_CHECK_OPERATION) {
    throw contractError(
      '/operation',
      `operation must be ${REQUEST_RESOLUTION_CHECK_OPERATION}`
    );
  }
  const request = assertResolutionCheckRequest(value.request, '/request');
  return immutableContractValue({
    protocol: REFEREE_CHECK_JSON_PROTOCOL,
    operation: REQUEST_RESOLUTION_CHECK_OPERATION,
    request
  });
}

export const assertRefereeCheckJsonEnvelope = assertRefereeCheckJsonCommand;

export function inspectRefereeCheckJsonCommand(value) {
  return inspectContract(value, assertRefereeCheckJsonCommand);
}

export const inspectRefereeCheckJsonEnvelope = inspectRefereeCheckJsonCommand;

function assertResultHash(value, path = '/result_hash') {
  return assertString(value, {
    path,
    label: 'result_hash',
    min: 71,
    max: 71,
    pattern: SHA256_REGEXP
  });
}

function normalizeRoll(value, path) {
  assertObject(value, { allowed: ROLL_KEYS, path, label: 'resolution check roll' });
  assertReference(value.participant_ref, childPath(path, 'participant_ref'), 'participant_ref');
  const raw = assertInteger(value.raw, {
    path: childPath(path, 'raw'),
    label: 'raw'
  });
  const modifier = assertInteger(value.modifier, {
    path: childPath(path, 'modifier'),
    label: 'modifier'
  });
  const total = assertInteger(value.total, {
    path: childPath(path, 'total'),
    label: 'total'
  });
  if (!Number.isSafeInteger(raw + modifier) || total !== raw + modifier) {
    throw contractError(
      childPath(path, 'total'),
      'total must equal raw + modifier without exceeding the safe integer range'
    );
  }
  return immutableContractValue({
    participant_ref: value.participant_ref,
    raw,
    modifier,
    total
  });
}

export function assertResolutionCheckResolvedResult(value) {
  assertObject(value, {
    allowed: RESOLVED_RESULT_KEYS,
    path: '/',
    label: 'resolved resolution check result'
  });
  if (value.schema !== RESOLUTION_CHECK_RESULT_SCHEMA) {
    throw contractError('/schema', `schema must be ${RESOLUTION_CHECK_RESULT_SCHEMA}`);
  }
  if (value.status !== 'RESOLVED') {
    throw contractError('/status', 'status must be RESOLVED');
  }
  assertCheckId(value.check_id);
  assertReference(value.rule_ref, '/rule_ref', 'rule_ref');
  const rolls = [];
  assertArray(value.rolls, {
    path: '/rolls',
    label: 'rolls',
    min: 1,
    max: RESOLUTION_CHECK_LIMITS.maxRolls,
    item(item, itemPath) {
      rolls.push(normalizeRoll(item, itemPath));
    },
    uniqueBy: item => item.participant_ref
  });
  assertString(value.outcome, {
    path: '/outcome',
    label: 'outcome',
    min: 2,
    max: RESOLUTION_CHECK_LIMITS.maxOutcomeLength,
    pattern: OUTCOME_REGEXP
  });
  assertResultHash(value.result_hash);
  return immutableContractValue({
    schema: RESOLUTION_CHECK_RESULT_SCHEMA,
    status: 'RESOLVED',
    check_id: value.check_id,
    rule_ref: value.rule_ref,
    rolls,
    outcome: value.outcome,
    result_hash: value.result_hash
  });
}

export function inspectResolutionCheckResolvedResult(value) {
  return inspectContract(value, assertResolutionCheckResolvedResult);
}

export function assertResolutionCheckRejectedResult(value) {
  assertObject(value, {
    allowed: REJECTED_RESULT_KEYS,
    path: '/',
    label: 'rejected resolution check result'
  });
  if (value.schema !== RESOLUTION_CHECK_RESULT_SCHEMA) {
    throw contractError('/schema', `schema must be ${RESOLUTION_CHECK_RESULT_SCHEMA}`);
  }
  if (value.status !== 'REJECTED') {
    throw contractError('/status', 'status must be REJECTED');
  }
  assertCheckId(value.check_id);
  assertString(value.error_code, {
    path: '/error_code',
    label: 'error_code',
    min: 2,
    max: RESOLUTION_CHECK_LIMITS.maxErrorCodeLength,
    pattern: ERROR_CODE_REGEXP
  });
  assertUniqueStringArray(value.allowed_correction_fields, {
    path: '/allowed_correction_fields',
    label: 'allowed_correction_fields',
    min: 1,
    max: RESOLUTION_CHECK_CORRECTABLE_FIELDS.length,
    validate(item, itemPath) {
      assertString(item, {
        path: itemPath,
        label: 'allowed correction field',
        min: 2,
        max: 64,
        enumValues: RESOLUTION_CHECK_CORRECTABLE_FIELDS
      });
    }
  });
  assertResultHash(value.result_hash);
  return immutableContractValue({
    schema: RESOLUTION_CHECK_RESULT_SCHEMA,
    status: 'REJECTED',
    check_id: value.check_id,
    error_code: value.error_code,
    allowed_correction_fields: value.allowed_correction_fields,
    result_hash: value.result_hash
  });
}

export function inspectResolutionCheckRejectedResult(value) {
  return inspectContract(value, assertResolutionCheckRejectedResult);
}

export function assertResolutionCheckResult(value) {
  assertPlainRecord(value, '/', 'resolution check result');
  if (value.status === 'RESOLVED') return assertResolutionCheckResolvedResult(value);
  if (value.status === 'REJECTED') return assertResolutionCheckRejectedResult(value);
  throw contractError('/status', 'status must be RESOLVED or REJECTED');
}

export function inspectResolutionCheckResult(value) {
  return inspectContract(value, assertResolutionCheckResult);
}

/** Provider-neutral native tool registration; adapters map it to SDK syntax. */
export function createResolutionCheckToolContract() {
  return immutableContractValue({
    name: REQUEST_RESOLUTION_CHECK_OPERATION,
    description: '请求服务端执行一次只读权威检定；本次调用不能同时宣布裁决结果。',
    input_schema: RESOLUTION_CHECK_REQUEST_JSON_SCHEMA
  });
}

/** Deterministic non-secret digest used by the in-memory ledger for results. */
export function computeResolutionCheckResultHash(resultWithoutHash) {
  assertPlainRecord(resultWithoutHash, '/', 'resolution check result hash material');
  if (Object.prototype.hasOwnProperty.call(resultWithoutHash, 'result_hash')) {
    throw contractError('/result_hash', 'result hash material must not contain result_hash');
  }
  return `sha256:${sha256Hex(resultWithoutHash)}`;
}

export const RESOLUTION_CHECK_SCHEMA_REGISTRY = immutableContractValue([
  RESOLUTION_CHECK_REQUEST_JSON_SCHEMA,
  REFEREE_CHECK_JSON_COMMAND_JSON_SCHEMA,
  RESOLUTION_CHECK_RESOLVED_RESULT_JSON_SCHEMA,
  RESOLUTION_CHECK_REJECTED_RESULT_JSON_SCHEMA,
  RESOLUTION_CHECK_RESULT_JSON_SCHEMA
]);
