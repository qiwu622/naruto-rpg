import { DomainError } from '../domain/errors.js';
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
import { ROOM_ORIGIN_TYPES, ROOM_SEATS } from './enums.js';

export const ROOM_ORIGIN_SCHEMA = 'naruto.multiplayer-room-origin/v1';
export const SOURCE_IMPORT_SCHEMA = 'naruto.multiplayer-source-import/v1';
export const ROOM_EPOCH_SCHEMA = 'naruto.multiplayer-room-epoch/v1';
export const ROOM_CHECKPOINT_SCHEMA = 'naruto.multiplayer-room-checkpoint/v1';
export const CHECKPOINT_SCHEMA = ROOM_CHECKPOINT_SCHEMA;
export const ROOM_ACTOR_BINDING_SCHEMA = 'naruto.multiplayer-room-actor-binding/v1';
export const RESUME_ROOM_CHECKPOINT_SCHEMA = 'naruto.multiplayer-resume-room-checkpoint/v1';
export const FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA = 'naruto.multiplayer-fork-latest-source/v1';
export const PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA = 'naruto.multiplayer-personal-singleplayer-export/v1';
export const AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA = 'naruto.multiplayer-audience-safe-import-diff/v1';

export const ROOM_EPOCH_BASE_TYPES = Object.freeze([
  'origin_snapshot',
  'room_checkpoint',
  'latest_source_import'
]);
export const ROOM_EPOCH_STATES = Object.freeze(['ACTIVE', 'ARCHIVED']);
export const ROOM_CHECKPOINT_KINDS = Object.freeze(['genesis', 'turn_commit']);
export const CONTINUATION_MODES = Object.freeze([
  'resume_room_checkpoint',
  'fork_from_latest_source_save'
]);
export const AUDIENCE_SAFE_IMPORT_DIFF_CATEGORIES = Object.freeze([
  'world_time',
  'tasks',
  'characters',
  'relationships',
  'items',
  'memories',
  'privacy_normalization',
  'actor_control_rebind',
  'continuity_losses',
  'experience_summary'
]);
export const AUDIENCE_SAFE_DIFF_ENTRY_KINDS = Object.freeze([
  'summary',
  'conflict',
  'result',
  'warning'
]);

/**
 * The design does not define a multiplayer character-creation endpoint or
 * payload. Stage 0 therefore freezes no such API and does not infer one from
 * RoomActorBinding or import contracts.
 */
export const CHARACTER_CREATION_CONTRACT_GAP = immutableContractValue({
  design_status: 'not_defined',
  stage_0_action: 'no_character_creation_api_or_schema_added'
});

/** Signature key management/token rotation is implemented after contracts. */
export const ROOM_ACTOR_BINDING_SIGNATURE_GAP = immutableContractValue({
  contract_requires: [
    'opaque_non_agent_token',
    'signature_version',
    'stable_lineage_actor_member_and_seat_binding',
    'two_original_actors_form_a_bijection'
  ],
  cryptographic_token_codec_selected: false
});

/**
 * Schema shape prevents raw hashes/private buckets from entering a client
 * diff. Semantic projection and redaction still require the server projector
 * and privacy normalizer described in section 23.
 */
export const AUDIENCE_SAFE_IMPORT_DIFF_PROJECTION_GAP = immutableContractValue({
  contract_excludes: [
    'raw_source_hash',
    'normalized_source_hash',
    'genesis_state_hash',
    'server_only_canonical',
    'private_memory_bucket',
    'hidden_object_count'
  ],
  semantic_redaction_implemented_in_contract: false
});

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SHA256_PATTERN = '^sha256:[a-f0-9]{64}$';
const SHA256_REGEXP = /^sha256:[a-f0-9]{64}$/u;
const HMAC_PATTERN = '^hmac-sha256:[a-f0-9]{64}$';
const HMAC_REGEXP = /^hmac-sha256:[a-f0-9]{64}$/u;
const ISO_TIMESTAMP_REGEXP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const OPAQUE_TOKEN_PATTERN = '^[A-Za-z0-9._~-]{16,2048}$';
const OPAQUE_TOKEN_REGEXP = /^[A-Za-z0-9._~-]{16,2048}$/u;

const nullableIdentifierSchema = {
  oneOf: [
    { type: 'string', minLength: 2, maxLength: 160 },
    { type: 'null' }
  ]
};

const hashPairSchema = {
  type: 'object',
  additionalProperties: false,
  required: ROOM_SEATS,
  properties: {
    A: { type: 'string', pattern: HMAC_PATTERN },
    B: { type: 'string', pattern: HMAC_PATTERN }
  }
};

const memberAcceptanceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['accepted_by_user_id', 'accepted_at', 'audience_diff_commitment'],
  properties: {
    accepted_by_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    accepted_at: { type: 'string', format: 'date-time' },
    audience_diff_commitment: {
      oneOf: [
        { type: 'string', pattern: HMAC_PATTERN },
        { type: 'null' }
      ]
    }
  }
};

const memberAcceptancePairSchema = {
  type: 'object',
  additionalProperties: false,
  required: ROOM_SEATS,
  properties: {
    A: memberAcceptanceSchema,
    B: memberAcceptanceSchema
  }
};

export const ROOM_ORIGIN_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: ROOM_ORIGIN_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'room_id',
    'origin_type',
    'lineage_id',
    'origin_owner_user_id',
    'origin_snapshot_id'
  ],
  properties: {
    schema: { const: ROOM_ORIGIN_SCHEMA },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    origin_type: { type: 'string', enum: ROOM_ORIGIN_TYPES },
    lineage_id: { type: 'string', minLength: 2, maxLength: 160 },
    origin_owner_user_id: nullableIdentifierSchema,
    origin_snapshot_id: { type: 'string', minLength: 2, maxLength: 160 }
  },
  allOf: [
    {
      if: { properties: { origin_type: { const: 'new_multiplayer_save' } }, required: ['origin_type'] },
      then: { properties: { origin_owner_user_id: { type: 'null' } } },
      else: { properties: { origin_owner_user_id: { type: 'string', minLength: 2 } } }
    }
  ]
});

export const SOURCE_IMPORT_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: SOURCE_IMPORT_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'source_import_id',
    'room_id',
    'lineage_id',
    'origin_owner_user_id',
    'source_save_id',
    'client_save_instance_id',
    'source_branch_id',
    'source_node_id',
    'cloud_revision',
    'canonical_content_hash',
    'selected_state_hash',
    'raw_source_hash',
    'normalized_source_hash',
    'normalization_and_rebind_diff_hash',
    'genesis_state_hash',
    'privacy_normalizer_version',
    'derived_from_export_id',
    'audience_diff_commitments',
    'server_hmac_commitment',
    'imported_at'
  ],
  properties: {
    schema: { const: SOURCE_IMPORT_SCHEMA },
    source_import_id: { type: 'string', minLength: 2, maxLength: 160 },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    lineage_id: { type: 'string', minLength: 2, maxLength: 160 },
    origin_owner_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    source_save_id: { type: 'string', minLength: 2, maxLength: 160 },
    client_save_instance_id: { type: 'string', minLength: 2, maxLength: 160 },
    source_branch_id: { type: 'string', minLength: 2, maxLength: 160 },
    source_node_id: { type: 'string', minLength: 2, maxLength: 160 },
    cloud_revision: {
      oneOf: [
        { type: 'string', minLength: 1, maxLength: 160 },
        { type: 'null' }
      ]
    },
    canonical_content_hash: { type: 'string', pattern: SHA256_PATTERN },
    selected_state_hash: { type: 'string', pattern: SHA256_PATTERN },
    raw_source_hash: { type: 'string', pattern: SHA256_PATTERN },
    normalized_source_hash: { type: 'string', pattern: SHA256_PATTERN },
    normalization_and_rebind_diff_hash: {
      oneOf: [{ type: 'string', pattern: SHA256_PATTERN }, { type: 'null' }]
    },
    genesis_state_hash: { type: 'string', pattern: SHA256_PATTERN },
    privacy_normalizer_version: { type: 'string', minLength: 2, maxLength: 160 },
    derived_from_export_id: nullableIdentifierSchema,
    audience_diff_commitments: hashPairSchema,
    server_hmac_commitment: { type: 'string', pattern: HMAC_PATTERN },
    imported_at: { type: 'string', format: 'date-time' }
  }
});

export const ROOM_EPOCH_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: ROOM_EPOCH_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'epoch_id',
    'room_id',
    'lineage_id',
    'epoch_no',
    'base',
    'genesis_checkpoint_id',
    'head_checkpoint_id',
    'state_revision',
    'control_revision',
    'state',
    'created_from_proposal_id',
    'activated_at'
  ],
  properties: {
    schema: { const: ROOM_EPOCH_SCHEMA },
    epoch_id: { type: 'string', minLength: 2, maxLength: 160 },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    lineage_id: { type: 'string', minLength: 2, maxLength: 160 },
    epoch_no: { type: 'integer', minimum: 1 },
    base: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'ref_id', 'state_hash'],
      properties: {
        type: { type: 'string', enum: ROOM_EPOCH_BASE_TYPES },
        ref_id: { type: 'string', minLength: 2, maxLength: 160 },
        state_hash: { type: 'string', pattern: SHA256_PATTERN }
      }
    },
    genesis_checkpoint_id: { type: 'string', minLength: 2, maxLength: 160 },
    head_checkpoint_id: { type: 'string', minLength: 2, maxLength: 160 },
    state_revision: { type: 'integer', minimum: 0 },
    control_revision: { type: 'integer', minimum: 0 },
    state: { type: 'string', enum: ROOM_EPOCH_STATES },
    created_from_proposal_id: nullableIdentifierSchema,
    activated_at: { type: 'string', format: 'date-time' }
  }
});

export const ROOM_CHECKPOINT_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: ROOM_CHECKPOINT_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'checkpoint_id',
    'room_id',
    'lineage_id',
    'epoch_id',
    'turn_no',
    'kind',
    'parent_checkpoint_id',
    'turn_id',
    'commit_id',
    'state_revision',
    'state_hash',
    'snapshot_ref',
    'created_at'
  ],
  properties: {
    schema: { const: ROOM_CHECKPOINT_SCHEMA },
    checkpoint_id: { type: 'string', minLength: 2, maxLength: 160 },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    lineage_id: { type: 'string', minLength: 2, maxLength: 160 },
    epoch_id: { type: 'string', minLength: 2, maxLength: 160 },
    turn_no: { type: 'integer', minimum: 0 },
    kind: { type: 'string', enum: ROOM_CHECKPOINT_KINDS },
    parent_checkpoint_id: nullableIdentifierSchema,
    turn_id: nullableIdentifierSchema,
    commit_id: nullableIdentifierSchema,
    state_revision: { type: 'integer', minimum: 0 },
    state_hash: { type: 'string', pattern: SHA256_PATTERN },
    snapshot_ref: { type: 'string', minLength: 2, maxLength: 160 },
    created_at: { type: 'string', format: 'date-time' }
  }
});

export const ROOM_ACTOR_BINDING_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: ROOM_ACTOR_BINDING_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'binding_id',
    'room_id',
    'lineage_id',
    'room_actor_id',
    'original_member_user_id',
    'original_seat',
    'genesis_checkpoint_id',
    'signature_version',
    'opaque_binding_token',
    'created_at'
  ],
  properties: {
    schema: { const: ROOM_ACTOR_BINDING_SCHEMA },
    binding_id: { type: 'string', minLength: 2, maxLength: 160 },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    lineage_id: { type: 'string', minLength: 2, maxLength: 160 },
    room_actor_id: { type: 'string', minLength: 2, maxLength: 160 },
    original_member_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    original_seat: { type: 'string', enum: ROOM_SEATS },
    genesis_checkpoint_id: { type: 'string', minLength: 2, maxLength: 160 },
    signature_version: { type: 'string', minLength: 2, maxLength: 160 },
    opaque_binding_token: { type: 'string', pattern: OPAQUE_TOKEN_PATTERN },
    created_at: { type: 'string', format: 'date-time' }
  }
});

export const RESUME_ROOM_CHECKPOINT_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: RESUME_ROOM_CHECKPOINT_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'continuation_mode',
    'proposal_id',
    'proposal_revision',
    'room_id',
    'lineage_id',
    'checkpoint_id',
    'base_checkpoint_state_hash',
    'expected_control_revision',
    'member_acceptances',
    'server_hmac_commitment'
  ],
  properties: {
    schema: { const: RESUME_ROOM_CHECKPOINT_SCHEMA },
    continuation_mode: { const: 'resume_room_checkpoint' },
    proposal_id: { type: 'string', minLength: 2, maxLength: 160 },
    proposal_revision: { type: 'integer', minimum: 1 },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    lineage_id: { type: 'string', minLength: 2, maxLength: 160 },
    checkpoint_id: { type: 'string', minLength: 2, maxLength: 160 },
    base_checkpoint_state_hash: { type: 'string', pattern: SHA256_PATTERN },
    expected_control_revision: { type: 'integer', minimum: 0 },
    member_acceptances: memberAcceptancePairSchema,
    server_hmac_commitment: { type: 'string', pattern: HMAC_PATTERN }
  }
});

export const FORK_FROM_LATEST_SOURCE_SAVE_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'continuation_mode',
    'proposal_id',
    'proposal_revision',
    'room_id',
    'lineage_id',
    'source_import_id',
    'origin_owner_user_id',
    'expected_control_revision',
    'audience_diff_commitments',
    'member_acceptances',
    'server_hmac_commitment'
  ],
  properties: {
    schema: { const: FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA },
    continuation_mode: { const: 'fork_from_latest_source_save' },
    proposal_id: { type: 'string', minLength: 2, maxLength: 160 },
    proposal_revision: { type: 'integer', minimum: 1 },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    lineage_id: { type: 'string', minLength: 2, maxLength: 160 },
    source_import_id: { type: 'string', minLength: 2, maxLength: 160 },
    origin_owner_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    expected_control_revision: { type: 'integer', minimum: 0 },
    audience_diff_commitments: hashPairSchema,
    member_acceptances: memberAcceptancePairSchema,
    server_hmac_commitment: { type: 'string', pattern: HMAC_PATTERN }
  }
});

const exportActorMappingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['room_actor_id', 'export_role', 'opaque_binding_token', 'inject_binding_to_agent'],
  properties: {
    room_actor_id: { type: 'string', minLength: 2, maxLength: 160 },
    export_role: { type: 'string', enum: ['player', 'npc_or_companion'] },
    opaque_binding_token: { type: 'string', pattern: OPAQUE_TOKEN_PATTERN },
    inject_binding_to_agent: { const: false }
  }
};

export const PERSONAL_SINGLEPLAYER_EXPORT_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'export_id',
    'room_id',
    'lineage_id',
    'checkpoint_id',
    'exporting_member_user_id',
    'exporting_seat',
    'codec',
    'projection_version',
    'output_format',
    'idempotency_key',
    'request_hash',
    'output_hash',
    'timeline_origin',
    'actor_mappings',
    'multiplayer_record_sidecar',
    'created_at'
  ],
  properties: {
    schema: { const: PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA },
    export_id: { type: 'string', minLength: 2, maxLength: 160 },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    lineage_id: { type: 'string', minLength: 2, maxLength: 160 },
    checkpoint_id: { type: 'string', minLength: 2, maxLength: 160 },
    exporting_member_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    exporting_seat: { type: 'string', enum: ROOM_SEATS },
    codec: { const: 'naruto.multiplayer-to-singleplayer/v1' },
    projection_version: { type: 'string', minLength: 2, maxLength: 160 },
    output_format: { type: 'string', minLength: 2, maxLength: 160 },
    idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
    request_hash: { type: 'string', pattern: SHA256_PATTERN },
    output_hash: { type: 'string', pattern: SHA256_PATTERN },
    timeline_origin: {
      type: 'string',
      enum: ['source_owner_branch', 'guest_audience_safe_genesis']
    },
    actor_mappings: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: exportActorMappingSchema
    },
    multiplayer_record_sidecar: {
      type: 'object',
      additionalProperties: false,
      required: [
        'counterpart_actions_included',
        'inject_to_agent',
        'counterpart_private_pov_included'
      ],
      properties: {
        counterpart_actions_included: { type: 'boolean' },
        inject_to_agent: { const: false },
        counterpart_private_pov_included: { const: false }
      }
    },
    created_at: { type: 'string', format: 'date-time' }
  }
});

const safeDiffEntrySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['entry_id', 'kind', 'summary'],
  properties: {
    entry_id: { type: 'string', minLength: 2, maxLength: 160 },
    kind: { type: 'string', enum: AUDIENCE_SAFE_DIFF_ENTRY_KINDS },
    summary: { type: 'string', minLength: 1, maxLength: 2_000 }
  }
};

export const AUDIENCE_SAFE_IMPORT_DIFF_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'proposal_id',
    'proposal_revision',
    'room_id',
    'lineage_id',
    'source_import_id',
    'audience',
    'audience_user_id',
    'audience_role',
    'sections',
    'projection_commitment',
    'server_hmac_commitment'
  ],
  properties: {
    schema: { const: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA },
    proposal_id: { type: 'string', minLength: 2, maxLength: 160 },
    proposal_revision: { type: 'integer', minimum: 1 },
    room_id: { type: 'string', minLength: 2, maxLength: 160 },
    lineage_id: { type: 'string', minLength: 2, maxLength: 160 },
    source_import_id: { type: 'string', minLength: 2, maxLength: 160 },
    audience: { type: 'string', enum: ROOM_SEATS },
    audience_user_id: { type: 'string', minLength: 2, maxLength: 160 },
    audience_role: { type: 'string', enum: ['source_owner', 'guest'] },
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'entries'],
        properties: {
          category: { type: 'string', enum: AUDIENCE_SAFE_IMPORT_DIFF_CATEGORIES },
          entries: {
            type: 'array',
            minItems: 0,
            maxItems: 128,
            items: safeDiffEntrySchema
          }
        }
      }
    },
    projection_commitment: { type: 'string', pattern: HMAC_PATTERN },
    server_hmac_commitment: { type: 'string', pattern: HMAC_PATTERN }
  }
});

function assertObject(value, { allowed, required = allowed, path = '', label }) {
  assertPlainRecord(value, path || '/', label);
  return assertExactKeys(value, { allowed, required, path, label });
}

function assertSchema(value, expected, path = '/schema') {
  if (value !== expected) throw contractError(path, `schema must be ${expected}`);
}

function assertEnum(value, enumValues, path, label) {
  return assertString(value, { path, label, enumValues });
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

function assertHmac(value, path, label) {
  return assertString(value, {
    path,
    label,
    min: 76,
    max: 76,
    pattern: HMAC_REGEXP
  });
}

function assertIsoTimestamp(value, path, label) {
  assertString(value, { path, label, min: 20, max: 24, pattern: ISO_TIMESTAMP_REGEXP });
  if (!Number.isFinite(Date.parse(value))) throw contractError(path, `${label} is not a valid timestamp`);
  return value;
}

function assertNullableIdentifier(value, path, label) {
  if (value !== null) assertIdentifier(value, { path, label });
  return value;
}

function assertOpaqueBindingToken(value, path, label) {
  return assertString(value, {
    path,
    label,
    min: 16,
    max: 2_048,
    pattern: OPAQUE_TOKEN_REGEXP
  });
}

function authorityError(code, path, message, details = {}) {
  return new DomainError(code, message, { path, ...details });
}

function assertCommitmentPair(value, path, label) {
  assertObject(value, { allowed: ROOM_SEATS, path, label });
  for (const seat of ROOM_SEATS) assertHmac(value[seat], `${path}/${seat}`, `${label}.${seat}`);
  return value;
}

function assertMemberAcceptance(value, path, label, { diffRequired }) {
  assertObject(value, {
    allowed: ['accepted_by_user_id', 'accepted_at', 'audience_diff_commitment'],
    path,
    label
  });
  assertPrincipalId(value.accepted_by_user_id, {
    path: `${path}/accepted_by_user_id`,
    label: `${label}.accepted_by_user_id`
  });
  assertIsoTimestamp(value.accepted_at, `${path}/accepted_at`, `${label}.accepted_at`);
  if (diffRequired) {
    assertHmac(
      value.audience_diff_commitment,
      `${path}/audience_diff_commitment`,
      `${label}.audience_diff_commitment`
    );
  } else if (value.audience_diff_commitment !== null) {
    throw contractError(
      `${path}/audience_diff_commitment`,
      'checkpoint resume acceptance does not use an import diff commitment'
    );
  }
  return value;
}

function assertMemberAcceptancePair(value, { path, diffRequired, expectedMembersBySeat = null }) {
  assertObject(value, { allowed: ROOM_SEATS, path, label: 'member_acceptances' });
  const acceptedUsers = new Set();
  for (const seat of ROOM_SEATS) {
    const acceptance = assertMemberAcceptance(
      value[seat],
      `${path}/${seat}`,
      `member_acceptances.${seat}`,
      { diffRequired }
    );
    if (expectedMembersBySeat && acceptance.accepted_by_user_id !== expectedMembersBySeat[seat]) {
      throw authorityError(
        'SOURCE_IMPORT_CHANGED',
        `${path}/${seat}/accepted_by_user_id`,
        'acceptance does not belong to the authoritative original member'
      );
    }
    if (acceptedUsers.has(acceptance.accepted_by_user_id)) {
      throw contractError(`${path}/${seat}/accepted_by_user_id`, 'two distinct original members must accept');
    }
    acceptedUsers.add(acceptance.accepted_by_user_id);
  }
  return value;
}

export function assertRoomOrigin(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'room_id',
      'origin_type',
      'lineage_id',
      'origin_owner_user_id',
      'origin_snapshot_id'
    ],
    path: '',
    label: 'room origin'
  });
  assertSchema(value.schema, ROOM_ORIGIN_SCHEMA);
  assertIdentifier(value.room_id, { path: '/room_id', label: 'room_id' });
  assertEnum(value.origin_type, ROOM_ORIGIN_TYPES, '/origin_type', 'origin_type');
  assertIdentifier(value.lineage_id, { path: '/lineage_id', label: 'lineage_id' });
  if (value.origin_type === 'existing_save_derived') {
    assertPrincipalId(value.origin_owner_user_id, {
      path: '/origin_owner_user_id',
      label: 'origin_owner_user_id'
    });
  } else if (value.origin_owner_user_id !== null) {
    throw contractError('/origin_owner_user_id', 'new_multiplayer_save origin owner must be null');
  }
  assertIdentifier(value.origin_snapshot_id, {
    path: '/origin_snapshot_id',
    label: 'origin_snapshot_id'
  });
  return immutableContractValue(value);
}

export function inspectRoomOrigin(value) {
  return inspectContract(value, assertRoomOrigin);
}

export function assertRoomOriginUnchanged(previousValue, nextValue) {
  const previous = assertRoomOrigin(previousValue);
  const next = assertRoomOrigin(nextValue);
  for (const field of [
    'room_id',
    'origin_type',
    'lineage_id',
    'origin_snapshot_id'
  ]) {
    if (previous[field] !== next[field]) {
      throw authorityError('ORIGIN_TYPE_IMMUTABLE', `/${field}`, `room origin field ${field} is immutable`);
    }
  }
  return next;
}

export function assertSourceImport(value, authority = {}) {
  assertObject(value, {
    allowed: [
      'schema',
      'source_import_id',
      'room_id',
      'lineage_id',
      'origin_owner_user_id',
      'source_save_id',
      'client_save_instance_id',
      'source_branch_id',
      'source_node_id',
      'cloud_revision',
      'canonical_content_hash',
      'selected_state_hash',
      'raw_source_hash',
      'normalized_source_hash',
      'normalization_and_rebind_diff_hash',
      'genesis_state_hash',
      'privacy_normalizer_version',
      'derived_from_export_id',
      'audience_diff_commitments',
      'server_hmac_commitment',
      'imported_at'
    ],
    path: '',
    label: 'source import'
  });
  assertSchema(value.schema, SOURCE_IMPORT_SCHEMA);
  for (const field of [
    'source_import_id',
    'room_id',
    'lineage_id',
    'source_save_id',
    'client_save_instance_id',
    'source_branch_id',
    'source_node_id',
    'privacy_normalizer_version'
  ]) {
    assertIdentifier(value[field], { path: `/${field}`, label: field });
  }
  assertPrincipalId(value.origin_owner_user_id, {
    path: '/origin_owner_user_id',
    label: 'origin_owner_user_id'
  });
  if (value.cloud_revision !== null) {
    assertString(value.cloud_revision, {
      path: '/cloud_revision',
      label: 'cloud_revision',
      max: 160
    });
  }
  for (const field of [
    'canonical_content_hash',
    'selected_state_hash',
    'raw_source_hash',
    'normalized_source_hash',
    'genesis_state_hash'
  ]) {
    assertSha256(value[field], `/${field}`, field);
  }
  if (value.normalization_and_rebind_diff_hash !== null) {
    assertSha256(
      value.normalization_and_rebind_diff_hash,
      '/normalization_and_rebind_diff_hash',
      'normalization_and_rebind_diff_hash'
    );
  }
  assertNullableIdentifier(value.derived_from_export_id, '/derived_from_export_id', 'derived_from_export_id');
  assertCommitmentPair(
    value.audience_diff_commitments,
    '/audience_diff_commitments',
    'audience_diff_commitments'
  );
  assertHmac(value.server_hmac_commitment, '/server_hmac_commitment', 'server_hmac_commitment');
  assertIsoTimestamp(value.imported_at, '/imported_at', 'imported_at');
  if (authority.origin_owner_user_id !== undefined
    && authority.origin_owner_user_id !== value.origin_owner_user_id) {
    throw authorityError('SOURCE_OWNER_REQUIRED', '/origin_owner_user_id', 'only origin owner source is accepted');
  }
  if (authority.authenticated_user_id !== undefined
    && authority.authenticated_user_id !== value.origin_owner_user_id) {
    throw authorityError('SOURCE_OWNER_REQUIRED', '/origin_owner_user_id', 'guest source upload is forbidden');
  }
  return immutableContractValue(value);
}

export function inspectSourceImport(value, authority = {}) {
  return inspectContract(value, candidate => assertSourceImport(candidate, authority));
}

export function assertRoomEpoch(value, authority = {}) {
  assertObject(value, {
    allowed: [
      'schema',
      'epoch_id',
      'room_id',
      'lineage_id',
      'epoch_no',
      'base',
      'genesis_checkpoint_id',
      'head_checkpoint_id',
      'state_revision',
      'control_revision',
      'state',
      'created_from_proposal_id',
      'activated_at'
    ],
    path: '',
    label: 'room epoch'
  });
  assertSchema(value.schema, ROOM_EPOCH_SCHEMA);
  for (const field of [
    'epoch_id',
    'room_id',
    'lineage_id',
    'genesis_checkpoint_id',
    'head_checkpoint_id'
  ]) {
    assertIdentifier(value[field], { path: `/${field}`, label: field });
  }
  assertInteger(value.epoch_no, { path: '/epoch_no', label: 'epoch_no', min: 1 });
  assertObject(value.base, {
    allowed: ['type', 'ref_id', 'state_hash'],
    path: '/base',
    label: 'base'
  });
  assertEnum(value.base.type, ROOM_EPOCH_BASE_TYPES, '/base/type', 'base.type');
  assertIdentifier(value.base.ref_id, { path: '/base/ref_id', label: 'base.ref_id' });
  assertSha256(value.base.state_hash, '/base/state_hash', 'base.state_hash');
  assertInteger(value.state_revision, { path: '/state_revision', label: 'state_revision', min: 0 });
  assertInteger(value.control_revision, {
    path: '/control_revision',
    label: 'control_revision',
    min: 0
  });
  assertEnum(value.state, ROOM_EPOCH_STATES, '/state', 'state');
  assertNullableIdentifier(
    value.created_from_proposal_id,
    '/created_from_proposal_id',
    'created_from_proposal_id'
  );
  if (value.base.type === 'origin_snapshot') {
    if (value.created_from_proposal_id !== null && value.epoch_no === 1) {
      throw contractError('/created_from_proposal_id', 'initial origin epoch must not cite a continuation proposal');
    }
  } else if (value.created_from_proposal_id === null) {
    throw contractError('/created_from_proposal_id', 'continued epochs must cite their accepted proposal');
  }
  if (authority.origin_type === 'new_multiplayer_save'
    && value.base.type === 'latest_source_import') {
    throw authorityError(
      'CONTINUATION_MODE_NOT_ALLOWED',
      '/base/type',
      'new_multiplayer_save cannot fork from a latest source save'
    );
  }
  assertIsoTimestamp(value.activated_at, '/activated_at', 'activated_at');
  return immutableContractValue(value);
}

export function inspectRoomEpoch(value, authority = {}) {
  return inspectContract(value, candidate => assertRoomEpoch(candidate, authority));
}

export function assertRoomEpochCollection(values, authority = {}) {
  const epochs = assertArray(values, {
    path: '/',
    label: 'room epochs',
    min: 1,
    max: 10_000,
    item: (item, path) => assertRoomEpoch(item, authority),
    uniqueBy: item => item.epoch_id
  }).map(item => assertRoomEpoch(item, authority));
  const [first] = epochs;
  const epochNos = new Set();
  let activeCount = 0;
  let prior = null;
  for (const epoch of [...epochs].sort((left, right) => left.epoch_no - right.epoch_no)) {
    if (epoch.room_id !== first.room_id || epoch.lineage_id !== first.lineage_id) {
      throw contractError('/', 'all epochs must belong to one room lineage');
    }
    if (epochNos.has(epoch.epoch_no)) throw contractError('/epoch_no', 'epoch_no must be unique per room');
    epochNos.add(epoch.epoch_no);
    if (epoch.state === 'ACTIVE') activeCount += 1;
    if (prior && (epoch.state_revision <= prior.state_revision
      || epoch.control_revision <= prior.control_revision)) {
      throw contractError('/', 'state_revision and control_revision must increase across epochs');
    }
    prior = epoch;
  }
  if (activeCount > 1) throw contractError('/', 'a room may have at most one active epoch');
  return immutableContractValue(epochs);
}

export function assertRoomCheckpoint(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'checkpoint_id',
      'room_id',
      'lineage_id',
      'epoch_id',
      'turn_no',
      'kind',
      'parent_checkpoint_id',
      'turn_id',
      'commit_id',
      'state_revision',
      'state_hash',
      'snapshot_ref',
      'created_at'
    ],
    path: '',
    label: 'room checkpoint'
  });
  assertSchema(value.schema, ROOM_CHECKPOINT_SCHEMA);
  for (const field of ['checkpoint_id', 'room_id', 'lineage_id', 'epoch_id', 'snapshot_ref']) {
    assertIdentifier(value[field], { path: `/${field}`, label: field });
  }
  assertInteger(value.turn_no, { path: '/turn_no', label: 'turn_no', min: 0 });
  assertEnum(value.kind, ROOM_CHECKPOINT_KINDS, '/kind', 'kind');
  for (const field of ['parent_checkpoint_id', 'turn_id', 'commit_id']) {
    assertNullableIdentifier(value[field], `/${field}`, field);
  }
  if (value.kind === 'genesis') {
    if (value.turn_no !== 0) throw contractError('/turn_no', 'genesis checkpoint must be turn 0');
    for (const field of ['parent_checkpoint_id', 'turn_id', 'commit_id']) {
      if (value[field] !== null) throw contractError(`/${field}`, `genesis checkpoint ${field} must be null`);
    }
  } else {
    if (value.turn_no < 1) throw contractError('/turn_no', 'committed checkpoint turn_no must be positive');
    for (const field of ['parent_checkpoint_id', 'turn_id', 'commit_id']) {
      if (value[field] === null) {
        throw contractError(`/${field}`, `turn_commit checkpoint requires ${field}`);
      }
    }
  }
  assertInteger(value.state_revision, { path: '/state_revision', label: 'state_revision', min: 0 });
  assertSha256(value.state_hash, '/state_hash', 'state_hash');
  assertIsoTimestamp(value.created_at, '/created_at', 'created_at');
  return immutableContractValue(value);
}

export const assertCheckpoint = assertRoomCheckpoint;

export function inspectRoomCheckpoint(value) {
  return inspectContract(value, assertRoomCheckpoint);
}

export const inspectCheckpoint = inspectRoomCheckpoint;

export function assertRoomActorBinding(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'binding_id',
      'room_id',
      'lineage_id',
      'room_actor_id',
      'original_member_user_id',
      'original_seat',
      'genesis_checkpoint_id',
      'signature_version',
      'opaque_binding_token',
      'created_at'
    ],
    path: '',
    label: 'room actor binding'
  });
  assertSchema(value.schema, ROOM_ACTOR_BINDING_SCHEMA);
  for (const field of [
    'binding_id',
    'room_id',
    'lineage_id',
    'room_actor_id',
    'genesis_checkpoint_id',
    'signature_version'
  ]) {
    assertIdentifier(value[field], { path: `/${field}`, label: field });
  }
  assertPrincipalId(value.original_member_user_id, {
    path: '/original_member_user_id',
    label: 'original_member_user_id'
  });
  assertEnum(value.original_seat, ROOM_SEATS, '/original_seat', 'original_seat');
  assertOpaqueBindingToken(
    value.opaque_binding_token,
    '/opaque_binding_token',
    'opaque_binding_token'
  );
  assertIsoTimestamp(value.created_at, '/created_at', 'created_at');
  return immutableContractValue(value);
}

export function inspectRoomActorBinding(value) {
  return inspectContract(value, assertRoomActorBinding);
}

/**
 * Validates the two immutable original bindings and, when supplied, the two
 * token-bearing entities resolved from a latest source save. Names, avatars
 * and fuzzy matching are intentionally absent.
 */
export function assertOriginalActorBindingBijection(bindingValues, authority = {}) {
  const bindings = assertArray(bindingValues, {
    path: '/bindings',
    label: 'original actor bindings',
    min: 2,
    max: 2,
    item: item => assertRoomActorBinding(item),
    uniqueBy: item => item.binding_id
  }).map(assertRoomActorBinding);
  const first = bindings[0];
  const sets = {
    seats: new Set(),
    users: new Set(),
    actors: new Set(),
    tokens: new Set()
  };
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    if (binding.room_id !== first.room_id
      || binding.lineage_id !== first.lineage_id
      || binding.genesis_checkpoint_id !== first.genesis_checkpoint_id) {
      throw authorityError(
        'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
        `/bindings/${index}`,
        'both actor bindings must belong to the same room lineage genesis'
      );
    }
    if (authority.lineage_id !== undefined && authority.lineage_id !== binding.lineage_id) {
      throw authorityError(
        'RETURN_ACTOR_BINDING_INVALID',
        `/bindings/${index}/lineage_id`,
        'actor binding belongs to another lineage'
      );
    }
    const identities = [
      ['seats', binding.original_seat],
      ['users', binding.original_member_user_id],
      ['actors', binding.room_actor_id],
      ['tokens', binding.opaque_binding_token]
    ];
    for (const [setName, identity] of identities) {
      if (sets[setName].has(identity)) {
        throw authorityError(
          'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
          `/bindings/${index}`,
          `duplicate ${setName} prevents an original-actor bijection`
        );
      }
      sets[setName].add(identity);
    }
    const expectedUser = authority.expected_members_by_seat?.[binding.original_seat];
    if (expectedUser !== undefined && expectedUser !== binding.original_member_user_id) {
      throw authorityError(
        'RETURN_ACTOR_BINDING_INVALID',
        `/bindings/${index}/original_member_user_id`,
        'actor binding member/seat does not match the original room membership'
      );
    }
  }
  if (!ROOM_SEATS.every(seat => sets.seats.has(seat))) {
    throw authorityError(
      'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
      '/bindings',
      'bindings must contain exactly original seats A and B'
    );
  }

  let sourceEntityBySeat = null;
  if (authority.source_actor_matches !== undefined) {
    const matches = authority.source_actor_matches;
    assertArray(matches, {
      path: '/source_actor_matches',
      label: 'source actor matches',
      min: 2,
      max: 2,
      item: (match, path, index) => {
        assertObject(match, {
          allowed: ['source_entity_id', 'opaque_binding_token'],
          path,
          label: `source_actor_matches[${index}]`
        });
        assertIdentifier(match.source_entity_id, {
          path: `${path}/source_entity_id`,
          label: 'source_entity_id'
        });
        assertOpaqueBindingToken(
          match.opaque_binding_token,
          `${path}/opaque_binding_token`,
          'opaque_binding_token'
        );
      },
      uniqueBy: match => match.source_entity_id
    });
    const bindingByToken = new Map(bindings.map(binding => [binding.opaque_binding_token, binding]));
    const matchedBindingIds = new Set();
    sourceEntityBySeat = {};
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const binding = bindingByToken.get(match.opaque_binding_token);
      if (!binding) {
        throw authorityError(
          'RETURN_ACTOR_BINDING_INVALID',
          `/source_actor_matches/${index}/opaque_binding_token`,
          'source actor token does not match an original binding'
        );
      }
      if (matchedBindingIds.has(binding.binding_id)) {
        throw authorityError(
          'RETURN_ACTOR_AMBIGUOUS',
          `/source_actor_matches/${index}/opaque_binding_token`,
          'an original binding appears more than once in the source save'
        );
      }
      if (typeof authority.verify_binding_token === 'function'
        && authority.verify_binding_token(match.opaque_binding_token, binding) !== true) {
        throw authorityError(
          'RETURN_ACTOR_BINDING_INVALID',
          `/source_actor_matches/${index}/opaque_binding_token`,
          'source actor binding signature is invalid'
        );
      }
      matchedBindingIds.add(binding.binding_id);
      sourceEntityBySeat[binding.original_seat] = match.source_entity_id;
    }
    if (matchedBindingIds.size !== 2 || sourceEntityBySeat.A === sourceEntityBySeat.B) {
      throw authorityError(
        'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
        '/source_actor_matches',
        'latest source actors must form a complete two-actor bijection'
      );
    }
  }

  return immutableContractValue({
    bindings_by_seat: Object.fromEntries(
      bindings.map(binding => [binding.original_seat, binding])
    ),
    source_entity_by_seat: sourceEntityBySeat
  });
}

export const assertRoomActorBindingBijection = assertOriginalActorBindingBijection;

export function inspectOriginalActorBindingBijection(bindingValues, authority = {}) {
  return inspectContract(
    bindingValues,
    candidate => assertOriginalActorBindingBijection(candidate, authority)
  );
}

export function assertResumeRoomCheckpoint(value, authority = {}) {
  assertObject(value, {
    allowed: [
      'schema',
      'continuation_mode',
      'proposal_id',
      'proposal_revision',
      'room_id',
      'lineage_id',
      'checkpoint_id',
      'base_checkpoint_state_hash',
      'expected_control_revision',
      'member_acceptances',
      'server_hmac_commitment'
    ],
    path: '',
    label: 'resume room checkpoint proposal'
  });
  assertSchema(value.schema, RESUME_ROOM_CHECKPOINT_SCHEMA);
  if (value.continuation_mode !== 'resume_room_checkpoint') {
    throw authorityError(
      'CONTINUATION_MODE_NOT_ALLOWED',
      '/continuation_mode',
      'checkpoint resume must use resume_room_checkpoint'
    );
  }
  for (const field of ['proposal_id', 'room_id', 'lineage_id', 'checkpoint_id']) {
    assertIdentifier(value[field], { path: `/${field}`, label: field });
  }
  assertInteger(value.proposal_revision, {
    path: '/proposal_revision',
    label: 'proposal_revision',
    min: 1
  });
  assertSha256(
    value.base_checkpoint_state_hash,
    '/base_checkpoint_state_hash',
    'base_checkpoint_state_hash'
  );
  assertInteger(value.expected_control_revision, {
    path: '/expected_control_revision',
    label: 'expected_control_revision',
    min: 0
  });
  assertMemberAcceptancePair(value.member_acceptances, {
    path: '/member_acceptances',
    diffRequired: false,
    expectedMembersBySeat: authority.expected_members_by_seat
  });
  assertHmac(value.server_hmac_commitment, '/server_hmac_commitment', 'server_hmac_commitment');
  if (authority.room_archived === false) {
    throw authorityError('ROOM_NOT_AT_CHECKPOINT', '/', 'room must be archived before creating a new epoch');
  }
  if (authority.checkpoint !== undefined) {
    const checkpoint = assertRoomCheckpoint(authority.checkpoint);
    if (checkpoint.checkpoint_id !== value.checkpoint_id
      || checkpoint.room_id !== value.room_id
      || checkpoint.lineage_id !== value.lineage_id) {
      throw authorityError('CHECKPOINT_NOT_COMMITTED', '/checkpoint_id', 'resume source is not this room checkpoint');
    }
    if (checkpoint.state_hash !== value.base_checkpoint_state_hash) {
      throw authorityError('BASE_HASH_MISMATCH', '/base_checkpoint_state_hash', 'checkpoint base hash changed');
    }
  }
  return immutableContractValue(value);
}

export function inspectResumeRoomCheckpoint(value, authority = {}) {
  return inspectContract(value, candidate => assertResumeRoomCheckpoint(candidate, authority));
}

export function assertForkFromLatestSourceSave(value, authority = {}) {
  assertObject(value, {
    allowed: [
      'schema',
      'continuation_mode',
      'proposal_id',
      'proposal_revision',
      'room_id',
      'lineage_id',
      'source_import_id',
      'origin_owner_user_id',
      'expected_control_revision',
      'audience_diff_commitments',
      'member_acceptances',
      'server_hmac_commitment'
    ],
    path: '',
    label: 'fork from latest source proposal'
  });
  assertSchema(value.schema, FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA);
  if (value.continuation_mode !== 'fork_from_latest_source_save') {
    throw authorityError(
      'CONTINUATION_MODE_NOT_ALLOWED',
      '/continuation_mode',
      'latest source fork must use fork_from_latest_source_save'
    );
  }
  for (const field of [
    'proposal_id',
    'room_id',
    'lineage_id',
    'source_import_id',
  ]) {
    assertIdentifier(value[field], { path: `/${field}`, label: field });
  }
  assertPrincipalId(value.origin_owner_user_id, {
    path: '/origin_owner_user_id',
    label: 'origin_owner_user_id'
  });
  assertInteger(value.proposal_revision, {
    path: '/proposal_revision',
    label: 'proposal_revision',
    min: 1
  });
  assertInteger(value.expected_control_revision, {
    path: '/expected_control_revision',
    label: 'expected_control_revision',
    min: 0
  });
  assertCommitmentPair(
    value.audience_diff_commitments,
    '/audience_diff_commitments',
    'audience_diff_commitments'
  );
  assertMemberAcceptancePair(value.member_acceptances, {
    path: '/member_acceptances',
    diffRequired: true,
    expectedMembersBySeat: authority.expected_members_by_seat
  });
  for (const seat of ROOM_SEATS) {
    if (value.member_acceptances[seat].audience_diff_commitment
      !== value.audience_diff_commitments[seat]) {
      throw authorityError(
        'SOURCE_IMPORT_CHANGED',
        `/member_acceptances/${seat}/audience_diff_commitment`,
        'member accepted a different audience-safe diff'
      );
    }
  }
  assertHmac(value.server_hmac_commitment, '/server_hmac_commitment', 'server_hmac_commitment');

  if (authority.origin_type !== undefined && authority.origin_type !== 'existing_save_derived') {
    throw authorityError(
      'CONTINUATION_MODE_NOT_ALLOWED',
      '/continuation_mode',
      'new_multiplayer_save cannot fork from a local source save'
    );
  }
  const immutableOwner = authority.origin_owner_user_id;
  if (immutableOwner !== undefined && value.origin_owner_user_id !== immutableOwner) {
    throw authorityError('SOURCE_OWNER_REQUIRED', '/origin_owner_user_id', 'origin owner is immutable');
  }
  if (authority.authenticated_user_id !== undefined
    && authority.authenticated_user_id !== value.origin_owner_user_id) {
    throw authorityError(
      'SOURCE_OWNER_REQUIRED',
      '/origin_owner_user_id',
      'a guest personal export cannot be reimported into the original room'
    );
  }
  if (authority.room_archived === false) {
    throw authorityError('ROOM_NOT_AT_CHECKPOINT', '/', 'room must be archived before creating a new epoch');
  }
  if (authority.source_import !== undefined) {
    const sourceImport = assertSourceImport(authority.source_import, {
      origin_owner_user_id: value.origin_owner_user_id
    });
    if (sourceImport.source_import_id !== value.source_import_id
      || sourceImport.room_id !== value.room_id
      || sourceImport.lineage_id !== value.lineage_id) {
      throw authorityError('SOURCE_IMPORT_CHANGED', '/source_import_id', 'proposal references another source import');
    }
    if (sourceImport.normalization_and_rebind_diff_hash === null) {
      throw authorityError(
        'SOURCE_IMPORT_CHANGED',
        '/source_import_id',
        'latest source import must include normalization and control-rebind result'
      );
    }
    for (const seat of ROOM_SEATS) {
      if (sourceImport.audience_diff_commitments[seat] !== value.audience_diff_commitments[seat]) {
        throw authorityError('SOURCE_IMPORT_CHANGED', `/audience_diff_commitments/${seat}`, 'source diff changed');
      }
    }
  }
  if (authority.actor_bindings !== undefined) {
    assertOriginalActorBindingBijection(authority.actor_bindings, {
      lineage_id: value.lineage_id,
      expected_members_by_seat: authority.expected_members_by_seat,
      source_actor_matches: authority.source_actor_matches,
      verify_binding_token: authority.verify_binding_token
    });
  }
  return immutableContractValue(value);
}

export function inspectForkFromLatestSourceSave(value, authority = {}) {
  return inspectContract(value, candidate => assertForkFromLatestSourceSave(candidate, authority));
}

export function assertPersonalSingleplayerExport(value, authority = {}) {
  assertObject(value, {
    allowed: [
      'schema',
      'export_id',
      'room_id',
      'lineage_id',
      'checkpoint_id',
      'exporting_member_user_id',
      'exporting_seat',
      'codec',
      'projection_version',
      'output_format',
      'idempotency_key',
      'request_hash',
      'output_hash',
      'timeline_origin',
      'actor_mappings',
      'multiplayer_record_sidecar',
      'created_at'
    ],
    path: '',
    label: 'personal singleplayer export'
  });
  assertSchema(value.schema, PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA);
  for (const field of [
    'export_id',
    'room_id',
    'lineage_id',
    'checkpoint_id',
    'projection_version',
    'output_format'
  ]) {
    assertIdentifier(value[field], { path: `/${field}`, label: field });
  }
  assertPrincipalId(value.exporting_member_user_id, {
    path: '/exporting_member_user_id',
    label: 'exporting_member_user_id'
  });
  assertEnum(value.exporting_seat, ROOM_SEATS, '/exporting_seat', 'exporting_seat');
  if (value.codec !== 'naruto.multiplayer-to-singleplayer/v1') {
    throw contractError('/codec', 'unsupported multiplayer-to-singleplayer codec');
  }
  assertString(value.idempotency_key, {
    path: '/idempotency_key',
    label: 'idempotency_key',
    max: 200
  });
  assertSha256(value.request_hash, '/request_hash', 'request_hash');
  assertSha256(value.output_hash, '/output_hash', 'output_hash');
  assertEnum(
    value.timeline_origin,
    ['source_owner_branch', 'guest_audience_safe_genesis'],
    '/timeline_origin',
    'timeline_origin'
  );
  assertArray(value.actor_mappings, {
    path: '/actor_mappings',
    label: 'actor_mappings',
    min: 2,
    max: 2,
    item: (mapping, path, index) => {
      assertObject(mapping, {
        allowed: [
          'room_actor_id',
          'export_role',
          'opaque_binding_token',
          'inject_binding_to_agent'
        ],
        path,
        label: `actor_mappings[${index}]`
      });
      assertIdentifier(mapping.room_actor_id, {
        path: `${path}/room_actor_id`,
        label: 'room_actor_id'
      });
      assertEnum(
        mapping.export_role,
        ['player', 'npc_or_companion'],
        `${path}/export_role`,
        'export_role'
      );
      assertOpaqueBindingToken(
        mapping.opaque_binding_token,
        `${path}/opaque_binding_token`,
        'opaque_binding_token'
      );
      if (mapping.inject_binding_to_agent !== false) {
        throw contractError(`${path}/inject_binding_to_agent`, 'binding token must never enter Agent context');
      }
    },
    uniqueBy: mapping => mapping.room_actor_id
  });
  if (new Set(value.actor_mappings.map(mapping => mapping.opaque_binding_token)).size !== 2) {
    throw authorityError(
      'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
      '/actor_mappings',
      'export must preserve two distinct opaque actor binding tokens'
    );
  }
  const playerMappings = value.actor_mappings.filter(mapping => mapping.export_role === 'player');
  const counterpartMappings = value.actor_mappings.filter(
    mapping => mapping.export_role === 'npc_or_companion'
  );
  if (playerMappings.length !== 1 || counterpartMappings.length !== 1) {
    throw contractError('/actor_mappings', 'export must map exporter to player and counterpart to NPC/companion');
  }
  assertObject(value.multiplayer_record_sidecar, {
    allowed: [
      'counterpart_actions_included',
      'inject_to_agent',
      'counterpart_private_pov_included'
    ],
    path: '/multiplayer_record_sidecar',
    label: 'multiplayer_record_sidecar'
  });
  assertBoolean(value.multiplayer_record_sidecar.counterpart_actions_included, {
    path: '/multiplayer_record_sidecar/counterpart_actions_included',
    label: 'counterpart_actions_included'
  });
  if (value.multiplayer_record_sidecar.inject_to_agent !== false) {
    throw contractError('/multiplayer_record_sidecar/inject_to_agent', 'multiplayer sidecar cannot enter Agent context');
  }
  if (value.multiplayer_record_sidecar.counterpart_private_pov_included !== false) {
    throw contractError(
      '/multiplayer_record_sidecar/counterpart_private_pov_included',
      'counterpart private POV must be omitted entirely'
    );
  }
  assertIsoTimestamp(value.created_at, '/created_at', 'created_at');

  if (authority.origin_type !== undefined && authority.origin_type !== 'existing_save_derived') {
    throw authorityError(
      'PLAYABLE_EXPORT_NOT_ALLOWED',
      '/schema',
      'new_multiplayer_save has no playable singleplayer export'
    );
  }
  if (authority.authenticated_user_id !== undefined
    && authority.authenticated_user_id !== value.exporting_member_user_id) {
    throw authorityError(
      'SOURCE_OWNER_REQUIRED',
      '/exporting_member_user_id',
      'exporting member is derived from authentication, not request data'
    );
  }
  const expectedExporter = authority.expected_members_by_seat?.[value.exporting_seat];
  if (expectedExporter !== undefined && expectedExporter !== value.exporting_member_user_id) {
    throw contractError('/exporting_seat', 'exporter does not control the claimed original seat');
  }
  if (authority.origin_owner_user_id !== undefined) {
    const expectedTimelineOrigin = value.exporting_member_user_id === authority.origin_owner_user_id
      ? 'source_owner_branch'
      : 'guest_audience_safe_genesis';
    if (value.timeline_origin !== expectedTimelineOrigin) {
      throw contractError('/timeline_origin', 'timeline origin would disclose another member source history');
    }
  }
  if (authority.checkpoint !== undefined) {
    const checkpoint = assertRoomCheckpoint(authority.checkpoint);
    if (checkpoint.checkpoint_id !== value.checkpoint_id
      || checkpoint.room_id !== value.room_id
      || checkpoint.lineage_id !== value.lineage_id) {
      throw authorityError('CHECKPOINT_NOT_COMMITTED', '/checkpoint_id', 'export requires this room checkpoint');
    }
  }
  if (authority.actor_bindings !== undefined) {
    const bijection = assertOriginalActorBindingBijection(authority.actor_bindings, {
      lineage_id: value.lineage_id,
      expected_members_by_seat: authority.expected_members_by_seat
    });
    const bindingBySeat = bijection.bindings_by_seat;
    for (let index = 0; index < value.actor_mappings.length; index += 1) {
      const mapping = value.actor_mappings[index];
      const binding = Object.values(bindingBySeat).find(candidate => (
        candidate.room_actor_id === mapping.room_actor_id
        && candidate.opaque_binding_token === mapping.opaque_binding_token
      ));
      if (!binding) {
        throw authorityError(
          'RETURN_ACTOR_BINDING_INVALID',
          `/actor_mappings/${index}`,
          'export actor does not match an authoritative room binding'
        );
      }
      const expectedRole = binding.original_seat === value.exporting_seat
        ? 'player'
        : 'npc_or_companion';
      if (mapping.export_role !== expectedRole) {
        throw contractError(`/actor_mappings/${index}/export_role`, 'export role does not match exporter seat');
      }
    }
  }
  return immutableContractValue(value);
}

export function inspectPersonalSingleplayerExport(value, authority = {}) {
  return inspectContract(value, candidate => assertPersonalSingleplayerExport(candidate, authority));
}

export function assertAudienceSafeImportDiff(value, authority = {}) {
  assertObject(value, {
    allowed: [
      'schema',
      'proposal_id',
      'proposal_revision',
      'room_id',
      'lineage_id',
      'source_import_id',
      'audience',
      'audience_user_id',
      'audience_role',
      'sections',
      'projection_commitment',
      'server_hmac_commitment'
    ],
    path: '',
    label: 'audience-safe import diff'
  });
  assertSchema(value.schema, AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA);
  for (const field of [
    'proposal_id',
    'room_id',
    'lineage_id',
    'source_import_id',
  ]) {
    assertIdentifier(value[field], { path: `/${field}`, label: field });
  }
  assertPrincipalId(value.audience_user_id, {
    path: '/audience_user_id',
    label: 'audience_user_id'
  });
  assertInteger(value.proposal_revision, {
    path: '/proposal_revision',
    label: 'proposal_revision',
    min: 1
  });
  assertEnum(value.audience, ROOM_SEATS, '/audience', 'audience');
  assertEnum(value.audience_role, ['source_owner', 'guest'], '/audience_role', 'audience_role');
  assertArray(value.sections, {
    path: '/sections',
    label: 'sections',
    min: 1,
    max: AUDIENCE_SAFE_IMPORT_DIFF_CATEGORIES.length,
    item: (section, path, sectionIndex) => {
      assertObject(section, {
        allowed: ['category', 'entries'],
        path,
        label: `sections[${sectionIndex}]`
      });
      assertEnum(
        section.category,
        AUDIENCE_SAFE_IMPORT_DIFF_CATEGORIES,
        `${path}/category`,
        'category'
      );
      assertArray(section.entries, {
        path: `${path}/entries`,
        label: `sections[${sectionIndex}].entries`,
        min: 0,
        max: 128,
        item: (entry, entryPath, entryIndex) => {
          assertObject(entry, {
            allowed: ['entry_id', 'kind', 'summary'],
            path: entryPath,
            label: `sections[${sectionIndex}].entries[${entryIndex}]`
          });
          assertIdentifier(entry.entry_id, { path: `${entryPath}/entry_id`, label: 'entry_id' });
          assertEnum(entry.kind, AUDIENCE_SAFE_DIFF_ENTRY_KINDS, `${entryPath}/kind`, 'kind');
          assertString(entry.summary, {
            path: `${entryPath}/summary`,
            label: 'summary',
            max: 2_000
          });
        },
        uniqueBy: entry => entry.entry_id
      });
    },
    uniqueBy: section => section.category
  });
  assertHmac(value.projection_commitment, '/projection_commitment', 'projection_commitment');
  assertHmac(value.server_hmac_commitment, '/server_hmac_commitment', 'server_hmac_commitment');
  const expectedAudienceUser = authority.expected_members_by_seat?.[value.audience];
  if (expectedAudienceUser !== undefined && expectedAudienceUser !== value.audience_user_id) {
    throw contractError('/audience_user_id', 'diff audience does not match authoritative seat membership');
  }
  if (authority.origin_owner_user_id !== undefined) {
    const expectedRole = value.audience_user_id === authority.origin_owner_user_id
      ? 'source_owner'
      : 'guest';
    if (value.audience_role !== expectedRole) {
      throw contractError('/audience_role', 'audience role does not match immutable origin ownership');
    }
  }
  return immutableContractValue(value);
}

export function inspectAudienceSafeImportDiff(value, authority = {}) {
  return inspectContract(value, candidate => assertAudienceSafeImportDiff(candidate, authority));
}
