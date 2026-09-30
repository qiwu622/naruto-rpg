import { sha256Hex } from '../domain/canonical-json.js';
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertPlainRecord,
  assertPrincipalId,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';
import {
  CONTINUITY_TRANSPORTS,
  CREDENTIAL_STATES,
  EXECUTION_GRANT_STATES,
  MODEL_ADAPTERS,
  NARRATIVE_MODES,
  ROOM_SEATS
} from './enums.js';

export const MODEL_ENDPOINT_PROFILE_SCHEMA = 'naruto.multiplayer-model-endpoint-profile/v1';
export const STORED_MODEL_CREDENTIAL_SCHEMA = 'naruto.multiplayer-stored-model-credential/v1';
export const EXECUTION_GRANT_SCHEMA = 'naruto.multiplayer-execution-grant/v1';
export const TURN_PAYER_SELECTION_SCHEMA = 'naruto.multiplayer-turn-payer-selection/v1';
export const POV_WRITER_SELECTION_SCHEMA = 'naruto.multiplayer-pov-writer-selection/v1';
export const TURN_BILLING_PLAN_SCHEMA = 'naruto.multiplayer-turn-billing-plan/v1';

export const MODEL_AUTH_SCHEMES = Object.freeze([
  'bearer',
  'x-api-key',
  'api-key',
  'none'
]);

export const BILLABLE_MODEL_STAGES = Object.freeze([
  'referee',
  'resolution_completeness_reviewer',
  'resolution_repair',
  'continuity_steward',
  'continuity_repair',
  'narrative_grounding_reviewer',
  'writer'
]);

export const EXECUTION_GRANT_SCOPE_KINDS = Object.freeze(['single_turn', 'standing']);

/**
 * Stage 0 deliberately performs no DNS lookup, socket connection or redirect
 * following. These checks are mandatory before a profile is used, but belong
 * to the outbound adapter/egress implementation rather than a JSON contract.
 */
export const MODEL_ENDPOINT_NETWORK_VALIDATION_GAP = immutableContractValue({
  contract_checks: [
    'normalized_https_url',
    'no_userinfo',
    'no_fragment',
    'no_query',
    'adapter_defined_auth_scheme_only'
  ],
  implementation_phase: 'stage_2_outbound_adapter',
  performs_network_io: false,
  required_before_outbound_use: [
    'validate_all_dns_a_and_aaaa_answers',
    'reject_non_public_destination_addresses',
    'pin_or_equivalently_enforce_validated_destination',
    'reject_redirects_by_default',
    'enforce_port_timeout_response_and_egress_limits'
  ]
});

/** The AEAD/KMS product is intentionally selected during the vault phase. */
export const CREDENTIAL_VAULT_ALGORITHM_GAP = immutableContractValue({
  plaintext_readback: 'never',
  required_properties: [
    'random_per_credential_data_key',
    'authenticated_encryption',
    'wrapped_data_key',
    'master_key_separate_from_business_database',
    'master_key_versioned_for_rewrap'
  ],
  selected_aead_or_kms_product: null
});

/**
 * Legacy plan/grant schemas still carry request/token/retry fields so existing
 * authorizations and append-only usage records remain readable. They are
 * accounting metadata, not application-enforced call limits. Provider request
 * output limits remain part of each individual model request.
 */
export const BILLING_ESTIMATE_POLICY = immutableContractValue({
  hard_limits: [],
  accounting_metadata: ['max_requests', 'max_input_tokens', 'max_output_tokens', 'max_retries'],
  estimated_cost_cap_is_hard_provider_reservation: false
});

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SHA256_PATTERN = '^sha256:[a-f0-9]{64}$';
const SHA256_REGEXP = /^sha256:[a-f0-9]{64}$/u;
const ISO_TIMESTAMP_REGEXP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const CURRENCY_REGEXP = /^[A-Z]{3}$/u;
const BASE64_REGEXP = /^[A-Za-z0-9+/]+={0,2}$/u;

const nullableTimestampSchema = {
  oneOf: [
    { type: 'string', format: 'date-time' },
    { type: 'null' }
  ]
};

const credentialRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['credential_id', 'credential_revision'],
  properties: {
    credential_id: { type: 'string', minLength: 2, maxLength: 160 },
    credential_revision: { type: 'integer', minimum: 1 }
  }
};

const nullableCredentialRefSchema = {
  oneOf: [credentialRefSchema, { type: 'null' }]
};

const endpointSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['normalized_base_url', 'normalized_origin'],
  properties: {
    normalized_base_url: { type: 'string', format: 'uri', pattern: '^https://' },
    normalized_origin: { type: 'string', format: 'uri', pattern: '^https://' }
  }
};

const capabilitiesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['native_tools', 'strict_json', 'error_correction_continuation'],
  properties: {
    native_tools: { type: 'boolean' },
    strict_json: { type: 'boolean' },
    error_correction_continuation: { type: 'boolean' }
  }
};

const profileRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'profile_id',
    'config_revision',
    'owner_user_id',
    'normalized_origin',
    'config_fingerprint',
    'credential_ref'
  ],
  properties: {
    profile_id: { type: 'string', minLength: 2, maxLength: 160 },
    config_revision: { type: 'integer', minimum: 1 },
    owner_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    normalized_origin: { type: 'string', format: 'uri', pattern: '^https://' },
    config_fingerprint: { type: 'string', pattern: SHA256_PATTERN },
    credential_ref: nullableCredentialRefSchema
  }
};

const stageScopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stage', 'audience'],
  properties: {
    stage: { type: 'string', enum: BILLABLE_MODEL_STAGES },
    audience: {
      oneOf: [
        { type: 'string', enum: ROOM_SEATS },
        { type: 'null' }
      ]
    }
  }
};

const estimatedCostCapSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['currency', 'amount_micros'],
  properties: {
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    amount_micros: { type: 'integer', minimum: 0 }
  }
};

const budgetSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'max_requests',
    'max_input_tokens',
    'max_output_tokens',
    'max_retries',
    'estimated_cost_cap'
  ],
  properties: {
    max_requests: { type: 'integer', minimum: 1 },
    max_input_tokens: { type: 'integer', minimum: 1 },
    max_output_tokens: { type: 'integer', minimum: 1 },
    max_retries: { type: 'integer', minimum: 0 },
    estimated_cost_cap: {
      oneOf: [estimatedCostCapSchema, { type: 'null' }]
    }
  }
};

const acceptanceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['accepted_by_user_id', 'accepted_at'],
  properties: {
    accepted_by_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    accepted_at: { type: 'string', format: 'date-time' }
  }
};

const nullableAcceptanceSchema = {
  oneOf: [acceptanceSchema, { type: 'null' }]
};

const hashPairSchema = {
  type: 'object',
  additionalProperties: false,
  required: ROOM_SEATS,
  properties: {
    A: { type: 'string', pattern: SHA256_PATTERN },
    B: { type: 'string', pattern: SHA256_PATTERN }
  }
};

export const MODEL_ENDPOINT_PROFILE_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: MODEL_ENDPOINT_PROFILE_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'profile_id',
    'owner_user_id',
    'config_revision',
    'adapter',
    'endpoint',
    'model',
    'auth_scheme',
    'credential_ref',
    'capabilities',
    'recommended_continuity_transport',
    'config_fingerprint'
  ],
  properties: {
    schema: { const: MODEL_ENDPOINT_PROFILE_SCHEMA },
    profile_id: { type: 'string', minLength: 2, maxLength: 160 },
    owner_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    config_revision: { type: 'integer', minimum: 1 },
    adapter: { type: 'string', enum: MODEL_ADAPTERS },
    endpoint: endpointSchema,
    model: { type: 'string', minLength: 1, maxLength: 256 },
    auth_scheme: { type: 'string', enum: MODEL_AUTH_SCHEMES },
    credential_ref: nullableCredentialRefSchema,
    capabilities: capabilitiesSchema,
    recommended_continuity_transport: {
      oneOf: [
        { type: 'string', enum: CONTINUITY_TRANSPORTS },
        { type: 'null' }
      ]
    },
    config_fingerprint: { type: 'string', pattern: SHA256_PATTERN }
  },
  allOf: [
    {
      if: { properties: { auth_scheme: { const: 'none' } }, required: ['auth_scheme'] },
      then: { properties: { credential_ref: { type: 'null' } } },
      else: { properties: { credential_ref: credentialRefSchema } }
    }
  ]
});

export const STORED_MODEL_CREDENTIAL_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: STORED_MODEL_CREDENTIAL_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'credential_id',
    'owner_user_id',
    'credential_revision',
    'endpoint_origin_hash',
    'ciphertext',
    'wrapped_data_key',
    'nonce',
    'auth_tag',
    'master_key_version',
    'fingerprint_suffix',
    'rotated_from_revision',
    'state',
    'created_at',
    'revoked_at'
  ],
  properties: {
    schema: { const: STORED_MODEL_CREDENTIAL_SCHEMA },
    credential_id: { type: 'string', minLength: 2, maxLength: 160 },
    owner_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    credential_revision: { type: 'integer', minimum: 1 },
    endpoint_origin_hash: { type: 'string', pattern: SHA256_PATTERN },
    ciphertext: { type: 'string', minLength: 16, maxLength: 32_768 },
    wrapped_data_key: { type: 'string', minLength: 16, maxLength: 16_384 },
    nonce: { type: 'string', minLength: 8, maxLength: 512 },
    auth_tag: { type: 'string', minLength: 8, maxLength: 512 },
    master_key_version: { type: 'string', minLength: 2, maxLength: 160 },
    fingerprint_suffix: { type: 'string', pattern: '^[a-f0-9]{8,32}$' },
    rotated_from_revision: {
      oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }]
    },
    state: { type: 'string', enum: CREDENTIAL_STATES },
    created_at: { type: 'string', format: 'date-time' },
    revoked_at: nullableTimestampSchema
  }
});

export const EXECUTION_GRANT_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: EXECUTION_GRANT_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'grant_id',
    'grant_revision',
    'payer_user_id',
    'room_id',
    'epoch_id',
    'profile_ref',
    'stage_scopes',
    'authorization_scope',
    'budget',
    'granted_at',
    'expires_at',
    'state',
    'revoked_at'
  ],
  properties: {
    schema: { const: EXECUTION_GRANT_SCHEMA },
    grant_id: { type: 'string', minLength: 2, maxLength: 160 },
    grant_revision: { type: 'integer', minimum: 1 },
    payer_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    epoch_id: { type: 'string', minLength: 2, maxLength: 160 },
    profile_ref: profileRefSchema,
    stage_scopes: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: stageScopeSchema
    },
    authorization_scope: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'turn_id'],
      properties: {
        kind: { type: 'string', enum: EXECUTION_GRANT_SCOPE_KINDS },
        turn_id: {
          oneOf: [
            { type: 'string', minLength: 2, maxLength: 160 },
            { type: 'null' }
          ]
        }
      }
    },
    budget: budgetSchema,
    granted_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    state: { type: 'string', enum: EXECUTION_GRANT_STATES },
    revoked_at: nullableTimestampSchema
  }
});

export const TURN_PAYER_SELECTION_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: TURN_PAYER_SELECTION_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'turn_id',
    'selection_revision',
    'expected_control_revision',
    'payer_user_id',
    'payer_seat',
    'profile_ref',
    'stage_config_fingerprints',
    'payer_acceptance',
    'idempotency_key',
    'selection_hash',
    'active'
  ],
  properties: {
    schema: { const: TURN_PAYER_SELECTION_SCHEMA },
    turn_id: { type: 'string', minLength: 2, maxLength: 160 },
    selection_revision: { type: 'integer', minimum: 1 },
    expected_control_revision: { type: 'integer', minimum: 0 },
    payer_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    payer_seat: { type: 'string', enum: ROOM_SEATS },
    profile_ref: profileRefSchema,
    stage_config_fingerprints: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stage', 'config_fingerprint'],
        properties: {
          stage: { type: 'string', enum: BILLABLE_MODEL_STAGES },
          config_fingerprint: { type: 'string', pattern: SHA256_PATTERN }
        }
      }
    },
    payer_acceptance: acceptanceSchema,
    idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
    selection_hash: { type: 'string', pattern: SHA256_PATTERN },
    active: { type: 'boolean' }
  }
});

export const POV_WRITER_SELECTION_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: POV_WRITER_SELECTION_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'turn_id',
    'selection_revision',
    'expected_control_revision',
    'audience',
    'audience_owner_user_id',
    'payer_user_id',
    'payer_seat',
    'profile_ref',
    'writer_config_fingerprint',
    'payer_acceptance',
    'audience_acceptance',
    'idempotency_key',
    'selection_hash',
    'active'
  ],
  properties: {
    schema: { const: POV_WRITER_SELECTION_SCHEMA },
    turn_id: { type: 'string', minLength: 2, maxLength: 160 },
    selection_revision: { type: 'integer', minimum: 1 },
    expected_control_revision: { type: 'integer', minimum: 0 },
    audience: { type: 'string', enum: ROOM_SEATS },
    audience_owner_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    payer_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    payer_seat: { type: 'string', enum: ROOM_SEATS },
    profile_ref: profileRefSchema,
    writer_config_fingerprint: { type: 'string', pattern: SHA256_PATTERN },
    payer_acceptance: nullableAcceptanceSchema,
    audience_acceptance: nullableAcceptanceSchema,
    idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
    selection_hash: { type: 'string', pattern: SHA256_PATTERN },
    active: { type: 'boolean' }
  }
});

const capabilityProbeRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['probe_revision', 'probe_hash'],
  properties: {
    probe_revision: { type: 'integer', minimum: 1 },
    probe_hash: { type: 'string', pattern: SHA256_PATTERN }
  }
};

const stagePlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'plan_item_id',
    'stage',
    'audience',
    'payer_user_id',
    'payer_seat',
    'profile_ref',
    'capability_probe_ref',
    'transport',
    'budget',
    'required_consent_subject_user_ids'
  ],
  properties: {
    plan_item_id: { type: 'string', minLength: 2, maxLength: 160 },
    stage: { type: 'string', enum: BILLABLE_MODEL_STAGES },
    audience: {
      oneOf: [
        { type: 'string', enum: ROOM_SEATS },
        { type: 'null' }
      ]
    },
    payer_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    payer_seat: { type: 'string', enum: ROOM_SEATS },
    profile_ref: profileRefSchema,
    capability_probe_ref: {
      oneOf: [capabilityProbeRefSchema, { type: 'null' }]
    },
    transport: {
      oneOf: [
        { type: 'string', enum: CONTINUITY_TRANSPORTS },
        { type: 'null' }
      ]
    },
    budget: budgetSchema,
    required_consent_subject_user_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { type: 'string', minLength: 2, maxLength: 160 }
    }
  }
};

export const TURN_BILLING_PLAN_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: TURN_BILLING_PLAN_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'turn_id',
    'plan_revision',
    'narrative_mode',
    'turn_payer_selection_hash',
    'pov_writer_selection_hashes',
    'stage_plans',
    'plan_hash',
    'created_at'
  ],
  properties: {
    schema: { const: TURN_BILLING_PLAN_SCHEMA },
    turn_id: { type: 'string', minLength: 2, maxLength: 160 },
    plan_revision: { type: 'integer', minimum: 1 },
    narrative_mode: { type: 'string', enum: NARRATIVE_MODES },
    turn_payer_selection_hash: { type: 'string', pattern: SHA256_PATTERN },
    pov_writer_selection_hashes: {
      oneOf: [hashPairSchema, { type: 'null' }]
    },
    stage_plans: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: stagePlanSchema
    },
    plan_hash: { type: 'string', pattern: SHA256_PATTERN },
    created_at: { type: 'string', format: 'date-time' }
  },
  allOf: [
    {
      if: { properties: { narrative_mode: { const: 'shared' } }, required: ['narrative_mode'] },
      then: { properties: { pov_writer_selection_hashes: { type: 'null' } } },
      else: { properties: { pov_writer_selection_hashes: hashPairSchema } }
    }
  ]
});

function assertObject(value, { allowed, required = allowed, path = '', label }) {
  assertPlainRecord(value, path || '/', label);
  return assertExactKeys(value, { allowed, required, path, label });
}

function assertEnum(value, enumValues, path, label) {
  return assertString(value, { path, label, enumValues });
}

function assertSchema(value, expected, path = '/schema') {
  if (value !== expected) throw contractError(path, `schema must be ${expected}`);
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

function assertIsoTimestamp(value, path, label) {
  assertString(value, { path, label, min: 20, max: 24, pattern: ISO_TIMESTAMP_REGEXP });
  if (!Number.isFinite(Date.parse(value))) throw contractError(path, `${label} is not a valid timestamp`);
  return value;
}

function assertNullableTimestamp(value, path, label) {
  if (value !== null) assertIsoTimestamp(value, path, label);
  return value;
}

function assertBase64(value, path, label, { min = 8, max = 32_768 } = {}) {
  assertString(value, { path, label, min, max, pattern: BASE64_REGEXP });
  if (value.length % 4 !== 0) throw contractError(path, `${label} must be padded base64`);
  return value;
}

function normalizeHttpsEndpoint(value, path, label, { originOnly = false } = {}) {
  assertString(value, { path, label, min: 9, max: 2_048 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw contractError(path, `${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw contractError(path, `${label} must use HTTPS; public-address checks run at the outbound gate`);
  }
  if (parsed.username || parsed.password) throw contractError(path, `${label} must not contain URL userinfo`);
  if (parsed.hash) throw contractError(path, `${label} must not contain a fragment`);
  if (parsed.search) throw contractError(path, `${label} must not contain query parameters`);
  if (!parsed.hostname) throw contractError(path, `${label} must contain a hostname`);

  const canonicalPath = parsed.pathname === '/'
    ? ''
    : parsed.pathname.replace(/\/+$/u, '');
  const normalized = originOnly ? parsed.origin : `${parsed.origin}${canonicalPath}`;
  if (value !== normalized) {
    throw contractError(path, `${label} must already be normalized`, { normalized_value: normalized });
  }
  return { normalized, origin: parsed.origin };
}

function assertCredentialRef(value, path, label) {
  assertObject(value, {
    allowed: ['credential_id', 'credential_revision'],
    path,
    label
  });
  assertIdentifier(value.credential_id, { path: `${path}/credential_id`, label: `${label}.credential_id` });
  assertInteger(value.credential_revision, {
    path: `${path}/credential_revision`,
    label: `${label}.credential_revision`,
    min: 1
  });
  return value;
}

function assertProfileRef(value, path = '/profile_ref', label = 'profile_ref') {
  assertObject(value, {
    allowed: [
      'profile_id',
      'config_revision',
      'owner_user_id',
      'normalized_origin',
      'config_fingerprint',
      'credential_ref'
    ],
    path,
    label
  });
  assertIdentifier(value.profile_id, { path: `${path}/profile_id`, label: `${label}.profile_id` });
  assertInteger(value.config_revision, {
    path: `${path}/config_revision`,
    label: `${label}.config_revision`,
    min: 1
  });
  assertPrincipalId(value.owner_user_id, {
    path: `${path}/owner_user_id`,
    label: `${label}.owner_user_id`
  });
  normalizeHttpsEndpoint(
    value.normalized_origin,
    `${path}/normalized_origin`,
    `${label}.normalized_origin`,
    { originOnly: true }
  );
  assertSha256(value.config_fingerprint, `${path}/config_fingerprint`, `${label}.config_fingerprint`);
  if (value.credential_ref !== null) {
    assertCredentialRef(value.credential_ref, `${path}/credential_ref`, `${label}.credential_ref`);
  }
  return value;
}

function assertBudget(value, path = '/budget', label = 'budget') {
  assertObject(value, {
    allowed: [
      'max_requests',
      'max_input_tokens',
      'max_output_tokens',
      'max_retries',
      'estimated_cost_cap'
    ],
    path,
    label
  });
  for (const field of ['max_requests', 'max_input_tokens', 'max_output_tokens']) {
    assertInteger(value[field], { path: `${path}/${field}`, label: `${label}.${field}`, min: 1 });
  }
  assertInteger(value.max_retries, {
    path: `${path}/max_retries`,
    label: `${label}.max_retries`,
    min: 0
  });
  if (value.estimated_cost_cap !== null) {
    assertObject(value.estimated_cost_cap, {
      allowed: ['currency', 'amount_micros'],
      path: `${path}/estimated_cost_cap`,
      label: `${label}.estimated_cost_cap`
    });
    assertString(value.estimated_cost_cap.currency, {
      path: `${path}/estimated_cost_cap/currency`,
      label: `${label}.estimated_cost_cap.currency`,
      min: 3,
      max: 3,
      pattern: CURRENCY_REGEXP
    });
    assertInteger(value.estimated_cost_cap.amount_micros, {
      path: `${path}/estimated_cost_cap/amount_micros`,
      label: `${label}.estimated_cost_cap.amount_micros`,
      min: 0
    });
  }
  return value;
}

function assertAcceptance(value, path, label) {
  assertObject(value, { allowed: ['accepted_by_user_id', 'accepted_at'], path, label });
  assertPrincipalId(value.accepted_by_user_id, {
    path: `${path}/accepted_by_user_id`,
    label: `${label}.accepted_by_user_id`
  });
  assertIsoTimestamp(value.accepted_at, `${path}/accepted_at`, `${label}.accepted_at`);
  return value;
}

function assertPayerProfileBinding(payerUserId, profileRef, path = '/profile_ref/owner_user_id') {
  if (profileRef.owner_user_id !== payerUserId) {
    throw contractError(path, 'endpoint profile owner must be the payer');
  }
}

function authoritativeUserId(authority) {
  return authority?.authenticated_user_id ?? authority?.authenticatedUserId ?? null;
}

function assertStageScope(value, path, label) {
  assertObject(value, { allowed: ['stage', 'audience'], path, label });
  assertEnum(value.stage, BILLABLE_MODEL_STAGES, `${path}/stage`, `${label}.stage`);
  if (value.audience !== null) {
    assertEnum(value.audience, ROOM_SEATS, `${path}/audience`, `${label}.audience`);
  }
  if (value.stage !== 'writer' && value.audience !== null) {
    throw contractError(`${path}/audience`, 'only Writer grants and plan items may be audience-scoped');
  }
  return value;
}

function assertHashPair(value, path, label) {
  assertObject(value, { allowed: ROOM_SEATS, path, label });
  for (const seat of ROOM_SEATS) assertSha256(value[seat], `${path}/${seat}`, `${label}.${seat}`);
  return value;
}

export function assertModelEndpointProfile(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'profile_id',
      'owner_user_id',
      'config_revision',
      'adapter',
      'endpoint',
      'model',
      'auth_scheme',
      'credential_ref',
      'capabilities',
      'recommended_continuity_transport',
      'config_fingerprint'
    ],
    path: '',
    label: 'model endpoint profile'
  });
  assertSchema(value.schema, MODEL_ENDPOINT_PROFILE_SCHEMA);
  assertIdentifier(value.profile_id, { path: '/profile_id', label: 'profile_id' });
  assertPrincipalId(value.owner_user_id, { path: '/owner_user_id', label: 'owner_user_id' });
  assertInteger(value.config_revision, { path: '/config_revision', label: 'config_revision', min: 1 });
  assertEnum(value.adapter, MODEL_ADAPTERS, '/adapter', 'adapter');
  assertObject(value.endpoint, {
    allowed: ['normalized_base_url', 'normalized_origin'],
    path: '/endpoint',
    label: 'endpoint'
  });
  const endpoint = normalizeHttpsEndpoint(
    value.endpoint.normalized_base_url,
    '/endpoint/normalized_base_url',
    'endpoint.normalized_base_url'
  );
  normalizeHttpsEndpoint(
    value.endpoint.normalized_origin,
    '/endpoint/normalized_origin',
    'endpoint.normalized_origin',
    { originOnly: true }
  );
  if (value.endpoint.normalized_origin !== endpoint.origin) {
    throw contractError('/endpoint/normalized_origin', 'normalized_origin must match normalized_base_url');
  }
  assertString(value.model, { path: '/model', label: 'model', max: 256 });
  assertEnum(value.auth_scheme, MODEL_AUTH_SCHEMES, '/auth_scheme', 'auth_scheme');
  if (value.auth_scheme === 'none') {
    if (value.credential_ref !== null) {
      throw contractError('/credential_ref', 'credential_ref must be null when auth_scheme is none');
    }
  } else {
    if (value.credential_ref === null) {
      throw contractError('/credential_ref', 'credential_ref is required for authenticated profiles');
    }
    assertCredentialRef(value.credential_ref, '/credential_ref', 'credential_ref');
  }
  assertObject(value.capabilities, {
    allowed: ['native_tools', 'strict_json', 'error_correction_continuation'],
    path: '/capabilities',
    label: 'capabilities'
  });
  for (const field of ['native_tools', 'strict_json', 'error_correction_continuation']) {
    assertBoolean(value.capabilities[field], {
      path: `/capabilities/${field}`,
      label: `capabilities.${field}`
    });
  }
  if (value.recommended_continuity_transport !== null) {
    assertEnum(
      value.recommended_continuity_transport,
      CONTINUITY_TRANSPORTS,
      '/recommended_continuity_transport',
      'recommended_continuity_transport'
    );
    if (value.recommended_continuity_transport === 'native_tools'
      && !value.capabilities.native_tools) {
      throw contractError('/recommended_continuity_transport', 'native_tools was not capability-probed');
    }
    if (value.recommended_continuity_transport === 'json_protocol'
      && !(value.capabilities.strict_json && value.capabilities.error_correction_continuation)) {
      throw contractError(
        '/recommended_continuity_transport',
        'json_protocol requires strict_json and error_correction_continuation capabilities'
      );
    }
  }
  assertSha256(value.config_fingerprint, '/config_fingerprint', 'config_fingerprint');
  return immutableContractValue(value);
}

export function inspectModelEndpointProfile(value) {
  return inspectContract(value, assertModelEndpointProfile);
}

export function assertStoredModelCredential(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'credential_id',
      'owner_user_id',
      'credential_revision',
      'endpoint_origin_hash',
      'ciphertext',
      'wrapped_data_key',
      'nonce',
      'auth_tag',
      'master_key_version',
      'fingerprint_suffix',
      'rotated_from_revision',
      'state',
      'created_at',
      'revoked_at'
    ],
    path: '',
    label: 'stored model credential'
  });
  assertSchema(value.schema, STORED_MODEL_CREDENTIAL_SCHEMA);
  assertIdentifier(value.credential_id, { path: '/credential_id', label: 'credential_id' });
  assertPrincipalId(value.owner_user_id, { path: '/owner_user_id', label: 'owner_user_id' });
  assertInteger(value.credential_revision, {
    path: '/credential_revision',
    label: 'credential_revision',
    min: 1
  });
  assertSha256(value.endpoint_origin_hash, '/endpoint_origin_hash', 'endpoint_origin_hash');
  assertBase64(value.ciphertext, '/ciphertext', 'ciphertext', { min: 16, max: 32_768 });
  assertBase64(value.wrapped_data_key, '/wrapped_data_key', 'wrapped_data_key', {
    min: 16,
    max: 16_384
  });
  assertBase64(value.nonce, '/nonce', 'nonce', { min: 8, max: 512 });
  assertBase64(value.auth_tag, '/auth_tag', 'auth_tag', { min: 8, max: 512 });
  assertIdentifier(value.master_key_version, {
    path: '/master_key_version',
    label: 'master_key_version'
  });
  assertString(value.fingerprint_suffix, {
    path: '/fingerprint_suffix',
    label: 'fingerprint_suffix',
    min: 8,
    max: 32,
    pattern: /^[a-f0-9]{8,32}$/u
  });
  if (value.rotated_from_revision !== null) {
    assertInteger(value.rotated_from_revision, {
      path: '/rotated_from_revision',
      label: 'rotated_from_revision',
      min: 1,
      max: value.credential_revision - 1
    });
  }
  assertEnum(value.state, CREDENTIAL_STATES, '/state', 'state');
  assertIsoTimestamp(value.created_at, '/created_at', 'created_at');
  assertNullableTimestamp(value.revoked_at, '/revoked_at', 'revoked_at');
  if ((value.state === 'REVOKED') !== (value.revoked_at !== null)) {
    throw contractError('/revoked_at', 'revoked_at must be present exactly when credential state is REVOKED');
  }
  return immutableContractValue(value);
}

export function inspectStoredModelCredential(value) {
  return inspectContract(value, assertStoredModelCredential);
}

/** Verifies the non-secret profile reference against the authoritative vault row. */
export function assertModelProfileCredentialBinding(profileValue, credentialValue) {
  const profile = assertModelEndpointProfile(profileValue);
  if (profile.auth_scheme === 'none') {
    if (credentialValue !== null && credentialValue !== undefined) {
      throw contractError('/credential_ref', 'auth_scheme none must not bind a stored credential');
    }
    return profile;
  }
  const credential = assertStoredModelCredential(credentialValue);
  if (credential.state !== 'ACTIVE') throw contractError('/credential_ref', 'credential must be ACTIVE');
  if (credential.credential_id !== profile.credential_ref.credential_id
    || credential.credential_revision !== profile.credential_ref.credential_revision) {
    throw contractError('/credential_ref', 'credential reference does not match the vault row');
  }
  if (credential.owner_user_id !== profile.owner_user_id) {
    throw contractError('/credential_ref', 'credential owner must match profile owner');
  }
  const expectedOriginHash = `sha256:${sha256Hex(profile.endpoint.normalized_origin)}`;
  if (credential.endpoint_origin_hash !== expectedOriginHash) {
    throw contractError('/credential_ref', 'credential endpoint origin binding does not match profile origin');
  }
  return profile;
}

export function assertExecutionGrant(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'grant_id',
      'grant_revision',
      'payer_user_id',
      'room_id',
      'epoch_id',
      'profile_ref',
      'stage_scopes',
      'authorization_scope',
      'budget',
      'granted_at',
      'expires_at',
      'state',
      'revoked_at'
    ],
    path: '',
    label: 'execution grant'
  });
  assertSchema(value.schema, EXECUTION_GRANT_SCHEMA);
  assertIdentifier(value.grant_id, { path: '/grant_id', label: 'grant_id' });
  assertInteger(value.grant_revision, { path: '/grant_revision', label: 'grant_revision', min: 1 });
  assertPrincipalId(value.payer_user_id, { path: '/payer_user_id', label: 'payer_user_id' });
  assertIdentifier(value.room_id, { path: '/room_id', label: 'room_id' });
  assertIdentifier(value.epoch_id, { path: '/epoch_id', label: 'epoch_id' });
  assertProfileRef(value.profile_ref);
  assertPayerProfileBinding(value.payer_user_id, value.profile_ref);
  assertArray(value.stage_scopes, {
    path: '/stage_scopes',
    label: 'stage_scopes',
    min: 1,
    max: 32,
    item: (item, path, index) => assertStageScope(item, path, `stage_scopes[${index}]`),
    uniqueBy: item => `${item.stage}:${item.audience ?? 'shared'}`
  });
  assertObject(value.authorization_scope, {
    allowed: ['kind', 'turn_id'],
    path: '/authorization_scope',
    label: 'authorization_scope'
  });
  assertEnum(
    value.authorization_scope.kind,
    EXECUTION_GRANT_SCOPE_KINDS,
    '/authorization_scope/kind',
    'authorization_scope.kind'
  );
  if (value.authorization_scope.kind === 'single_turn') {
    assertIdentifier(value.authorization_scope.turn_id, {
      path: '/authorization_scope/turn_id',
      label: 'authorization_scope.turn_id'
    });
  } else if (value.authorization_scope.turn_id !== null) {
    throw contractError('/authorization_scope/turn_id', 'standing grants must have a null turn_id');
  }
  assertBudget(value.budget);
  assertIsoTimestamp(value.granted_at, '/granted_at', 'granted_at');
  assertIsoTimestamp(value.expires_at, '/expires_at', 'expires_at');
  if (Date.parse(value.expires_at) <= Date.parse(value.granted_at)) {
    throw contractError('/expires_at', 'expires_at must be later than granted_at');
  }
  assertEnum(value.state, EXECUTION_GRANT_STATES, '/state', 'state');
  assertNullableTimestamp(value.revoked_at, '/revoked_at', 'revoked_at');
  if ((value.state === 'REVOKED') !== (value.revoked_at !== null)) {
    throw contractError('/revoked_at', 'revoked_at must be present exactly when grant state is REVOKED');
  }
  return immutableContractValue(value);
}

export function inspectExecutionGrant(value) {
  return inspectContract(value, assertExecutionGrant);
}

/**
 * Checks an already validated grant at the last authority boundary before a
 * request. Legacy budget context is shape-validated for audit compatibility,
 * but it never rejects a call based on accumulated usage.
 */
export function assertExecutionGrantUsable(value, context = {}) {
  const grant = assertExecutionGrant(value);
  if (grant.state !== 'ACTIVE') throw contractError('/state', 'execution grant is not ACTIVE');
  const now = context.now ?? new Date().toISOString();
  assertIsoTimestamp(now, '/context/now', 'context.now');
  if (Date.parse(now) >= Date.parse(grant.expires_at)) {
    throw contractError('/expires_at', 'execution grant is expired');
  }
  const checks = [
    ['payer_user_id', grant.payer_user_id],
    ['room_id', grant.room_id],
    ['epoch_id', grant.epoch_id]
  ];
  for (const [field, actual] of checks) {
    if (context[field] !== undefined && context[field] !== actual) {
      throw contractError(`/context/${field}`, `execution grant ${field} does not match`);
    }
  }
  if (grant.authorization_scope.kind === 'single_turn'
    && context.turn_id !== undefined
    && context.turn_id !== grant.authorization_scope.turn_id) {
    throw contractError('/context/turn_id', 'single-turn grant does not cover this turn');
  }
  if (context.stage !== undefined) {
    assertEnum(context.stage, BILLABLE_MODEL_STAGES, '/context/stage', 'context.stage');
    const audience = context.audience ?? null;
    const covered = grant.stage_scopes.some(scope => (
      scope.stage === context.stage && scope.audience === audience
    ));
    if (!covered) throw contractError('/context/stage', 'execution grant does not cover this stage scope');
  }
  if (context.profile_ref !== undefined) {
    const profileRef = assertProfileRef(context.profile_ref, '/context/profile_ref', 'context.profile_ref');
    for (const field of ['profile_id', 'config_revision', 'config_fingerprint', 'normalized_origin']) {
      if (profileRef[field] !== grant.profile_ref[field]) {
        throw contractError(`/context/profile_ref/${field}`, 'execution grant profile binding does not match');
      }
    }
    const expectedCredential = grant.profile_ref.credential_ref;
    const actualCredential = profileRef.credential_ref;
    if (JSON.stringify(actualCredential) !== JSON.stringify(expectedCredential)) {
      throw contractError('/context/profile_ref/credential_ref', 'execution grant credential revision does not match');
    }
  }
  if (context.consumed_budget !== undefined || context.requested_budget !== undefined) {
    const consumed = context.consumed_budget ?? {};
    const requested = context.requested_budget ?? {};
    const usageFields = ['requests', 'input_tokens', 'output_tokens', 'retries'];
    for (const usageField of usageFields) {
      const consumedValue = consumed[usageField] ?? 0;
      const requestedValue = requested[usageField] ?? 0;
      assertInteger(consumedValue, {
        path: `/context/consumed_budget/${usageField}`,
        label: `consumed_budget.${usageField}`,
        min: 0
      });
      assertInteger(requestedValue, {
        path: `/context/requested_budget/${usageField}`,
        label: `requested_budget.${usageField}`,
        min: 0
      });
    }
  }
  return grant;
}

export function inspectExecutionGrantUsable(value, context = {}) {
  return inspectContract(value, candidate => assertExecutionGrantUsable(candidate, context));
}

export function assertTurnPayerSelection(value, authority = {}) {
  assertObject(value, {
    allowed: [
      'schema',
      'turn_id',
      'selection_revision',
      'expected_control_revision',
      'payer_user_id',
      'payer_seat',
      'profile_ref',
      'stage_config_fingerprints',
      'payer_acceptance',
      'idempotency_key',
      'selection_hash',
      'active'
    ],
    path: '',
    label: 'turn payer selection'
  });
  assertSchema(value.schema, TURN_PAYER_SELECTION_SCHEMA);
  assertIdentifier(value.turn_id, { path: '/turn_id', label: 'turn_id' });
  assertInteger(value.selection_revision, {
    path: '/selection_revision',
    label: 'selection_revision',
    min: 1
  });
  assertInteger(value.expected_control_revision, {
    path: '/expected_control_revision',
    label: 'expected_control_revision',
    min: 0
  });
  assertPrincipalId(value.payer_user_id, { path: '/payer_user_id', label: 'payer_user_id' });
  assertEnum(value.payer_seat, ROOM_SEATS, '/payer_seat', 'payer_seat');
  assertProfileRef(value.profile_ref);
  assertPayerProfileBinding(value.payer_user_id, value.profile_ref);
  assertArray(value.stage_config_fingerprints, {
    path: '/stage_config_fingerprints',
    label: 'stage_config_fingerprints',
    min: 1,
    max: 16,
    item: (item, path, index) => {
      assertObject(item, {
        allowed: ['stage', 'config_fingerprint'],
        path,
        label: `stage_config_fingerprints[${index}]`
      });
      assertEnum(item.stage, BILLABLE_MODEL_STAGES, `${path}/stage`, 'stage');
      assertSha256(item.config_fingerprint, `${path}/config_fingerprint`, 'config_fingerprint');
    },
    uniqueBy: item => item.stage
  });
  assertAcceptance(value.payer_acceptance, '/payer_acceptance', 'payer_acceptance');
  if (value.payer_acceptance.accepted_by_user_id !== value.payer_user_id) {
    throw contractError('/payer_acceptance/accepted_by_user_id', 'only the payer may accept this selection');
  }
  const authenticatedUserId = authoritativeUserId(authority);
  if (authenticatedUserId !== null && authenticatedUserId !== value.payer_user_id) {
    throw contractError('/payer_user_id', 'authenticated member cannot select or accept another payer');
  }
  if (authority.expected_payer_seat !== undefined
    && authority.expected_payer_seat !== value.payer_seat) {
    throw contractError('/payer_seat', 'payer seat does not match authoritative membership');
  }
  assertString(value.idempotency_key, {
    path: '/idempotency_key',
    label: 'idempotency_key',
    max: 200
  });
  assertSha256(value.selection_hash, '/selection_hash', 'selection_hash');
  assertBoolean(value.active, { path: '/active', label: 'active' });
  return immutableContractValue(value);
}

export function inspectTurnPayerSelection(value, authority = {}) {
  return inspectContract(value, candidate => assertTurnPayerSelection(candidate, authority));
}

export function assertPOVWriterSelection(value, authority = {}) {
  assertObject(value, {
    allowed: [
      'schema',
      'turn_id',
      'selection_revision',
      'expected_control_revision',
      'audience',
      'audience_owner_user_id',
      'payer_user_id',
      'payer_seat',
      'profile_ref',
      'writer_config_fingerprint',
      'payer_acceptance',
      'audience_acceptance',
      'idempotency_key',
      'selection_hash',
      'active'
    ],
    path: '',
    label: 'POV Writer selection'
  });
  assertSchema(value.schema, POV_WRITER_SELECTION_SCHEMA);
  assertIdentifier(value.turn_id, { path: '/turn_id', label: 'turn_id' });
  assertInteger(value.selection_revision, {
    path: '/selection_revision',
    label: 'selection_revision',
    min: 1
  });
  assertInteger(value.expected_control_revision, {
    path: '/expected_control_revision',
    label: 'expected_control_revision',
    min: 0
  });
  assertEnum(value.audience, ROOM_SEATS, '/audience', 'audience');
  assertPrincipalId(value.audience_owner_user_id, {
    path: '/audience_owner_user_id',
    label: 'audience_owner_user_id'
  });
  assertPrincipalId(value.payer_user_id, { path: '/payer_user_id', label: 'payer_user_id' });
  assertEnum(value.payer_seat, ROOM_SEATS, '/payer_seat', 'payer_seat');
  assertProfileRef(value.profile_ref);
  assertPayerProfileBinding(value.payer_user_id, value.profile_ref);
  assertSha256(
    value.writer_config_fingerprint,
    '/writer_config_fingerprint',
    'writer_config_fingerprint'
  );
  if (value.payer_acceptance !== null) {
    assertAcceptance(value.payer_acceptance, '/payer_acceptance', 'payer_acceptance');
    if (value.payer_acceptance.accepted_by_user_id !== value.payer_user_id) {
      throw contractError('/payer_acceptance/accepted_by_user_id', 'only the payer may accept payer terms');
    }
  }
  if (value.audience_acceptance !== null) {
    assertAcceptance(value.audience_acceptance, '/audience_acceptance', 'audience_acceptance');
    if (value.audience_acceptance.accepted_by_user_id !== value.audience_owner_user_id) {
      throw contractError(
        '/audience_acceptance/accepted_by_user_id',
        'only the POV data owner may accept audience data processing'
      );
    }
  }
  const authenticatedUserId = authoritativeUserId(authority);
  const acceptingAs = authority.accepting_as ?? authority.acceptingAs ?? null;
  if (authenticatedUserId !== null && acceptingAs === 'payer'
    && authenticatedUserId !== value.payer_user_id) {
    throw contractError('/payer_user_id', 'authenticated member cannot accept for another payer');
  }
  if (authenticatedUserId !== null && acceptingAs === 'audience'
    && authenticatedUserId !== value.audience_owner_user_id) {
    throw contractError('/audience_owner_user_id', 'authenticated member cannot accept another POV owner data');
  }
  if (authority.expected_audience_owner_user_id !== undefined
    && authority.expected_audience_owner_user_id !== value.audience_owner_user_id) {
    throw contractError('/audience_owner_user_id', 'audience owner does not match authoritative seat membership');
  }
  assertString(value.idempotency_key, {
    path: '/idempotency_key',
    label: 'idempotency_key',
    max: 200
  });
  assertSha256(value.selection_hash, '/selection_hash', 'selection_hash');
  assertBoolean(value.active, { path: '/active', label: 'active' });
  return immutableContractValue(value);
}

export function inspectPOVWriterSelection(value, authority = {}) {
  return inspectContract(value, candidate => assertPOVWriterSelection(candidate, authority));
}

export function assertPOVWriterSelectionReady(value) {
  const selection = assertPOVWriterSelection(value);
  if (!selection.active) throw contractError('/active', 'POV Writer selection must be active');
  if (selection.payer_acceptance === null) {
    throw contractError('/payer_acceptance', 'payer acceptance is required before first action lock');
  }
  if (selection.audience_acceptance === null) {
    throw contractError('/audience_acceptance', 'POV owner data-processing acceptance is required');
  }
  return selection;
}

export function inspectPOVWriterSelectionReady(value) {
  return inspectContract(value, assertPOVWriterSelectionReady);
}

function assertCapabilityProbeRef(value, path, label) {
  assertObject(value, { allowed: ['probe_revision', 'probe_hash'], path, label });
  assertInteger(value.probe_revision, {
    path: `${path}/probe_revision`,
    label: `${label}.probe_revision`,
    min: 1
  });
  assertSha256(value.probe_hash, `${path}/probe_hash`, `${label}.probe_hash`);
  return value;
}

function assertStagePlan(value, path, index) {
  const label = `stage_plans[${index}]`;
  assertObject(value, {
    allowed: [
      'plan_item_id',
      'stage',
      'audience',
      'payer_user_id',
      'payer_seat',
      'profile_ref',
      'capability_probe_ref',
      'transport',
      'budget',
      'required_consent_subject_user_ids'
    ],
    path,
    label
  });
  assertIdentifier(value.plan_item_id, { path: `${path}/plan_item_id`, label: `${label}.plan_item_id` });
  assertEnum(value.stage, BILLABLE_MODEL_STAGES, `${path}/stage`, `${label}.stage`);
  if (value.audience !== null) {
    assertEnum(value.audience, ROOM_SEATS, `${path}/audience`, `${label}.audience`);
  }
  if (value.stage !== 'writer' && value.audience !== null) {
    throw contractError(`${path}/audience`, 'only Writer plan items may be audience-scoped');
  }
  assertPrincipalId(value.payer_user_id, {
    path: `${path}/payer_user_id`,
    label: `${label}.payer_user_id`
  });
  assertEnum(value.payer_seat, ROOM_SEATS, `${path}/payer_seat`, `${label}.payer_seat`);
  assertProfileRef(value.profile_ref, `${path}/profile_ref`, `${label}.profile_ref`);
  assertPayerProfileBinding(value.payer_user_id, value.profile_ref, `${path}/profile_ref/owner_user_id`);
  if (value.capability_probe_ref !== null) {
    assertCapabilityProbeRef(
      value.capability_probe_ref,
      `${path}/capability_probe_ref`,
      `${label}.capability_probe_ref`
    );
  }
  if (value.transport !== null) {
    assertEnum(value.transport, CONTINUITY_TRANSPORTS, `${path}/transport`, `${label}.transport`);
  }
  if (['continuity_steward', 'continuity_repair'].includes(value.stage)
    && value.transport === null) {
    throw contractError(`${path}/transport`, 'Continuity plan items must freeze a transport');
  }
  assertBudget(value.budget, `${path}/budget`, `${label}.budget`);
  assertArray(value.required_consent_subject_user_ids, {
    path: `${path}/required_consent_subject_user_ids`,
    label: `${label}.required_consent_subject_user_ids`,
    min: 1,
    max: 2,
    item: (item, itemPath) => assertPrincipalId(item, { path: itemPath, label: 'consent subject' }),
    uniqueBy: item => item
  });
  return value;
}

export function assertTurnBillingPlan(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'turn_id',
      'plan_revision',
      'narrative_mode',
      'turn_payer_selection_hash',
      'pov_writer_selection_hashes',
      'stage_plans',
      'plan_hash',
      'created_at'
    ],
    path: '',
    label: 'turn billing plan'
  });
  assertSchema(value.schema, TURN_BILLING_PLAN_SCHEMA);
  assertIdentifier(value.turn_id, { path: '/turn_id', label: 'turn_id' });
  assertInteger(value.plan_revision, { path: '/plan_revision', label: 'plan_revision', min: 1 });
  assertEnum(value.narrative_mode, NARRATIVE_MODES, '/narrative_mode', 'narrative_mode');
  assertSha256(
    value.turn_payer_selection_hash,
    '/turn_payer_selection_hash',
    'turn_payer_selection_hash'
  );
  if (value.narrative_mode === 'shared') {
    if (value.pov_writer_selection_hashes !== null) {
      throw contractError('/pov_writer_selection_hashes', 'shared plans must not contain POV selections');
    }
  } else {
    assertHashPair(
      value.pov_writer_selection_hashes,
      '/pov_writer_selection_hashes',
      'pov_writer_selection_hashes'
    );
  }
  assertArray(value.stage_plans, {
    path: '/stage_plans',
    label: 'stage_plans',
    min: 1,
    max: 64,
    item: assertStagePlan,
    uniqueBy: item => item.plan_item_id
  });
  const writerItems = value.stage_plans.filter(item => item.stage === 'writer');
  if (value.narrative_mode === 'shared') {
    if (writerItems.length !== 1 || writerItems[0].audience !== null) {
      throw contractError('/stage_plans', 'shared plan must contain exactly one shared Writer item');
    }
  } else {
    const writerAudiences = writerItems.map(item => item.audience).sort();
    if (writerAudiences.length !== 2 || writerAudiences[0] !== 'A' || writerAudiences[1] !== 'B') {
      throw contractError('/stage_plans', 'dual_pov plan must contain exactly one Writer item for A and B');
    }
  }
  for (let index = 0; index < value.stage_plans.length; index += 1) {
    const item = value.stage_plans[index];
    if (item.audience === null && item.required_consent_subject_user_ids.length !== 2) {
      throw contractError(
        `/stage_plans/${index}/required_consent_subject_user_ids`,
        'shared stages require both room members as consent subjects'
      );
    }
  }
  assertSha256(value.plan_hash, '/plan_hash', 'plan_hash');
  assertIsoTimestamp(value.created_at, '/created_at', 'created_at');
  return immutableContractValue(value);
}

export function inspectTurnBillingPlan(value) {
  return inspectContract(value, assertTurnBillingPlan);
}

/** Ensures every frozen plan item uses the payer/profile chosen for its scope. */
export function assertTurnBillingPlanMatchesSelections(value, selections) {
  const plan = assertTurnBillingPlan(value);
  const shared = assertTurnPayerSelection(selections?.turn_payer_selection);
  if (!shared.active) throw contractError('/selections/turn_payer_selection/active', 'shared payer selection is inactive');
  if (shared.turn_id !== plan.turn_id || shared.selection_hash !== plan.turn_payer_selection_hash) {
    throw contractError('/turn_payer_selection_hash', 'billing plan does not match shared payer selection');
  }

  let povByAudience = null;
  if (plan.narrative_mode === 'dual_pov') {
    assertObject(selections?.pov_writer_selections, {
      allowed: ROOM_SEATS,
      path: '/selections/pov_writer_selections',
      label: 'pov_writer_selections'
    });
    povByAudience = {};
    for (const audience of ROOM_SEATS) {
      const selection = assertPOVWriterSelectionReady(selections.pov_writer_selections[audience]);
      if (selection.turn_id !== plan.turn_id || selection.audience !== audience) {
        throw contractError(`/selections/pov_writer_selections/${audience}`, 'POV selection scope is wrong');
      }
      if (selection.selection_hash !== plan.pov_writer_selection_hashes[audience]) {
        throw contractError(`/pov_writer_selection_hashes/${audience}`, 'billing plan POV hash is wrong');
      }
      povByAudience[audience] = selection;
    }
  }

  for (let index = 0; index < plan.stage_plans.length; index += 1) {
    const item = plan.stage_plans[index];
    const selection = item.stage === 'writer' && item.audience !== null
      ? povByAudience[item.audience]
      : shared;
    if (item.payer_user_id !== selection.payer_user_id
      || item.payer_seat !== selection.payer_seat
      || item.profile_ref.profile_id !== selection.profile_ref.profile_id
      || item.profile_ref.config_revision !== selection.profile_ref.config_revision
      || item.profile_ref.config_fingerprint !== selection.profile_ref.config_fingerprint
      || JSON.stringify(item.profile_ref.credential_ref) !== JSON.stringify(selection.profile_ref.credential_ref)) {
      throw contractError(`/stage_plans/${index}`, 'billing plan item does not match its frozen payer selection');
    }
  }
  return plan;
}

export function inspectTurnBillingPlanMatchesSelections(value, selections) {
  return inspectContract(value, candidate => assertTurnBillingPlanMatchesSelections(candidate, selections));
}
