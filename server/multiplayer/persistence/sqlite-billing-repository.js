import { randomUUID } from 'node:crypto';

import {
  BILLABLE_MODEL_STAGES,
  EXECUTION_GRANT_SCHEMA,
  MODEL_ENDPOINT_PROFILE_SCHEMA,
  POV_WRITER_SELECTION_SCHEMA,
  STORED_MODEL_CREDENTIAL_SCHEMA,
  TURN_BILLING_PLAN_SCHEMA,
  TURN_PAYER_SELECTION_SCHEMA,
  assertExecutionGrant,
  assertExecutionGrantUsable,
  assertModelEndpointProfile,
  assertModelProfileCredentialBinding,
  assertPOVWriterSelection,
  assertStoredModelCredential,
  assertTurnBillingPlan,
  assertTurnPayerSelection
} from '../contracts/billing-contracts.js';
import {
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from '../domain/canonical-json.js';
import {
  computeTurnBillingPlanHash
} from '../domain/billing-authorization.js';
import {
  assertCredentialUsagePolicy,
  resolveCredentialPayerSeat
} from '../domain/credential-usage-policy.js';
import { DomainError } from '../domain/errors.js';
import { normalizeModelEndpointBaseUrl } from '../security/endpoint-policy.js';

const ROOM_SEATS = Object.freeze(['A', 'B']);
const EVENT_PROJECTION_VERSION = 'naruto.multiplayer-room-event-projection/v1';
const RESOLUTION_EVENT_PROJECTION_VERSION =
  'naruto.multiplayer-turn-control-event-projection/v1';
const SHARED_STAGES = Object.freeze([
  'referee',
  'resolution_completeness_reviewer',
  'resolution_repair',
  'continuity_steward',
  'continuity_repair',
  'narrative_grounding_reviewer'
]);
const BILLING_RESUME_TURN_STATUSES = new Set([
  'RESOLVING',
  'RENDERING',
  'STAGING_UPDATES',
  'REPAIRING_DRAFT',
  'RECOVERING_COMMIT'
]);
const RUN_STAGE_RESUME_STATUS = Object.freeze({
  resolution: 'RESOLVING',
  narrative: 'RENDERING',
  continuity: 'STAGING_UPDATES',
  commit_recovery: 'RECOVERING_COMMIT'
});
const ID_REGEXP = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL_REGEXP = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;
const HASH_REGEXP = /^sha256:[a-f0-9]{64}$/u;
const AUTH_SCHEMES_BY_ADAPTER = Object.freeze({
  openai_compatible: Object.freeze(['bearer', 'x-api-key', 'api-key', 'none']),
  anthropic: Object.freeze(['x-api-key', 'none'])
});

export const MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION =
  'naruto.multiplayer-byok-data-processing/v1';
export const SHARED_STAGE_DATA_CATEGORIES = Object.freeze([
  'audience_private_projections',
  'both_action_originals',
  'canonical_room_state',
  'dual_pov_drafts',
  'relevant_private_memories',
  'reviewer_outputs'
]);
export const POV_WRITER_DATA_CATEGORIES = Object.freeze([
  'audience_action_original',
  'audience_private_memory',
  'audience_projection',
  'narration_preferences'
]);
const BILLING_READINESS_ERROR_CODES = new Set([
  'BILLING_AUTHORIZATION_REQUIRED',
  'BILLING_BUDGET_EXHAUSTED',
  'DATA_PROCESSING_CONSENT_REQUIRED',
  'EXECUTION_GRANT_REQUIRED',
  'STALE_BILLING_PLAN'
]);

/**
 * The initial schema intentionally predates a few exact idempotency/audit
 * fields required by the final design. The repository never fabricates those
 * guarantees from process memory; callers can inspect this frozen list when
 * deciding whether a workflow may be exposed through REST.
 */
export const SQLITE_BILLING_SCHEMA_GAPS = Object.freeze([
  Object.freeze({
    table: 'turn_model_selections',
    missing: Object.freeze([
      'request_hash',
      'stage_config_fingerprints_json',
      'writer_config_fingerprint'
    ]),
    consequence: 'selection rows expose their authoritative hash, but cannot reconstruct every domain-contract input; POV acceptance request-key conflicts use their own durable receipt table'
  }),
  Object.freeze({
    table: 'data_processing_consents',
    missing: Object.freeze([
      'turn_id',
      'plan_item_id',
      'plan_hash',
      'normalized_origin',
      'expires_at'
    ]),
    consequence: 'the repository can enforce append-only epoch/selection/config/terms/category consent, not a complete invocation-specific consent receipt'
  }),
  Object.freeze({
    table: 'turn_billing_authorizations',
    missing: Object.freeze(['one_to_many_grant_allocations']),
    consequence: 'one payer can authorize a plan only when one grant covers all of that payer\'s plan items'
  }),
  Object.freeze({
    table: 'ai_usage_ledger',
    missing: Object.freeze([
      'plan_item_id',
      'grant_id',
      'grant_revision',
      'profile_id',
      'profile_revision',
      'credential_id',
      'credential_revision',
      'transport'
    ]),
    consequence: 'status and payer/plan/scope accounting are durable, but exact invocation authorization provenance needs a later migration'
  })
]);

function fail(code, message, details = {}, status = undefined) {
  throw new DomainError(code, message, details, status === undefined ? {} : { status });
}

function assertConnection(connection) {
  if (!connection
    || typeof connection.read !== 'function'
    || typeof connection.write !== 'function') {
    fail('BILLING_REPOSITORY_CONFIGURATION_INVALID', 'a multiplayer SQLite connection is required');
  }
  return connection;
}

function assertVault(vault) {
  if (!vault
    || typeof vault.sealCredential !== 'function'
    || typeof vault.rotateCredential !== 'function'
    || typeof vault.revokeCredential !== 'function') {
    fail('BILLING_REPOSITORY_CONFIGURATION_INVALID', 'a credential vault is required');
  }
  return vault;
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !ID_REGEXP.test(value)) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must be a valid identifier`, { field: label });
  }
  return value;
}

function assertPrincipal(value, label = 'authenticated_user_id') {
  if (typeof value !== 'string' || !PRINCIPAL_REGEXP.test(value)) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must be a valid authenticated principal`, {
      field: label
    });
  }
  return value;
}

function assertRevision(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must be a safe integer of at least ${min}`, {
      field: label
    });
  }
  return value;
}

function assertPositiveInteger(value, label, { min = 1 } = {}) {
  return assertRevision(value, label, { min });
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('REPOSITORY_CLOCK_INVALID', `${label} must be an ISO timestamp`, { field: label });
  }
  return value;
}

function assertString(value, label, { min = 1, max = 2_048 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must contain ${min}-${max} characters`, {
      field: label
    });
  }
  return value;
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH_REGEXP.test(value)) {
    fail('REPOSITORY_INPUT_INVALID', `${label} must be a sha256 hash`, { field: label });
  }
  return value;
}

function immutable(value) {
  return freezeDeep(canonicalizeJson(value));
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function parseJson(value, label) {
  try {
    return canonicalizeJson(JSON.parse(value));
  } catch {
    fail('PERSISTED_BILLING_CORRUPT', `${label} is not valid JSON`);
  }
}

function hashCanonical(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function defaultIdFactory(kind) {
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

function generatedId(idFactory, kind) {
  return assertIdentifier(idFactory(kind), `${kind}_id`);
}

function requireMember(database, roomId, authenticatedUserId) {
  const row = database.prepare(`
    SELECT m.member_id, m.user_id, m.seat_id, m.member_status,
           r.room_id, r.lifecycle, r.active_epoch_id, r.current_turn_id,
           r.control_revision, r.event_seq
      FROM multiplayer_members AS m
      JOIN multiplayer_rooms AS r ON r.room_id = m.room_id
     WHERE m.room_id = ? AND m.user_id = ? AND m.member_status = 'ACTIVE'
  `).get(roomId, authenticatedUserId);
  if (!row) {
    fail('ROOM_MEMBERSHIP_REQUIRED', 'the authenticated user is not an active room member', {
      room_id: roomId
    }, 403);
  }
  return row;
}

function requireWritable(member) {
  if (member.lifecycle === 'ARCHIVED') {
    fail('ROOM_ARCHIVED_READ_ONLY', 'an archived room is read-only', {
      room_id: member.room_id
    }, 409);
  }
}

function roomMembers(database, roomId) {
  const rows = database.prepare(`
    SELECT member_id, user_id, seat_id
      FROM multiplayer_members
     WHERE room_id = ? AND member_status = 'ACTIVE'
     ORDER BY seat_id
  `).all(roomId);
  if (rows.length !== 2 || rows[0].seat_id !== 'A' || rows[1].seat_id !== 'B') {
    fail('ROOM_NOT_READY', 'both active room members are required', { room_id: roomId }, 409);
  }
  return rows;
}

function requiredConsentSubjectUserIds(members, {
  audience,
  payerUserId,
  endpointOwnerUserId
}) {
  const membersBySeat = Object.fromEntries(members.map(row => [row.seat_id, row.user_id]));
  const roomMemberUserIds = ROOM_SEATS.map(seat => membersBySeat[seat]);
  if (roomMemberUserIds.some(userId => typeof userId !== 'string')) {
    fail('ROOM_NOT_READY', 'both active room members are required for consent routing', {}, 409);
  }
  if (audience === null) return roomMemberUserIds;

  const required = new Set([
    membersBySeat[audience],
    payerUserId,
    endpointOwnerUserId
  ]);
  for (const subjectUserId of required) {
    if (!roomMemberUserIds.includes(subjectUserId)) {
      fail(
        'BILLING_PLAN_CONSENT_SUBJECT_INVALID',
        'POV Writer consent subjects must be active room members',
        { audience, subject_user_id: subjectUserId },
        409
      );
    }
  }
  return roomMemberUserIds.filter(subjectUserId => required.has(subjectUserId));
}

function sameConsentSubjectSet(actual, expected) {
  return actual.length === expected.length
    && expected.every(subjectUserId => actual.includes(subjectUserId));
}

function requireTurn(database, {
  roomId,
  epochId = null,
  turnId = null,
  turnNo = null
}) {
  let row;
  if (turnId !== null) {
    row = database.prepare(`
      SELECT * FROM multiplayer_turns WHERE room_id = ? AND turn_id = ?
    `).get(roomId, turnId);
  } else {
    row = database.prepare(`
      SELECT * FROM multiplayer_turns
       WHERE room_id = ? AND epoch_id = ? AND turn_no = ?
    `).get(roomId, epochId, turnNo);
  }
  if (!row) fail('TURN_NOT_FOUND', 'the requested multiplayer turn does not exist', {}, 404);
  if (epochId !== null && row.epoch_id !== epochId) {
    fail('TURN_NOT_FOUND', 'the turn does not belong to the requested epoch', {}, 404);
  }
  return row;
}

function activeActionCount(database, turnId) {
  return database.prepare(`
    SELECT COUNT(*) AS count FROM action_submissions WHERE turn_id = ?
  `).get(turnId).count;
}

function requireSelectionsMutable(database, turn) {
  if (activeActionCount(database, turn.turn_id) !== 0) {
    fail('EXECUTION_PLAN_FROZEN', 'model selections cannot change after the first action lock', {
      turn_id: turn.turn_id
    }, 409);
  }
  if (!['AWAITING_PAYER_SELECTION', 'COLLECTING_ACTIONS'].includes(turn.turn_status)) {
    fail('INVALID_TURN_STATE', 'the turn is not accepting model selections', {
      turn_status: turn.turn_status
    }, 409);
  }
}

function credentialRecord(row) {
  return assertStoredModelCredential({
    schema: STORED_MODEL_CREDENTIAL_SCHEMA,
    credential_id: row.credential_id,
    owner_user_id: row.owner_user_id,
    credential_revision: row.credential_revision,
    endpoint_origin_hash: row.endpoint_origin_hash,
    ciphertext: Buffer.from(row.ciphertext).toString('base64'),
    wrapped_data_key: Buffer.from(row.wrapped_data_key).toString('base64'),
    nonce: Buffer.from(row.nonce).toString('base64'),
    auth_tag: Buffer.from(row.auth_tag).toString('base64'),
    master_key_version: row.master_key_version,
    fingerprint_suffix: row.fingerprint_suffix,
    rotated_from_revision: row.rotated_from_revision,
    state: row.credential_state,
    created_at: row.created_at,
    revoked_at: row.revoked_at
  });
}

function credentialProjection(row) {
  return immutable({
    credential_id: row.credential_id,
    owner_user_id: row.owner_user_id,
    credential_revision: row.credential_revision,
    endpoint_origin_hash: row.endpoint_origin_hash,
    fingerprint_suffix: row.fingerprint_suffix,
    rotated_from_revision: row.rotated_from_revision,
    state: row.credential_state,
    created_at: row.created_at,
    revoked_at: row.revoked_at
  });
}

function insertCredential(database, record) {
  database.prepare(`
    INSERT INTO stored_model_credentials (
      credential_id, credential_revision, owner_user_id,
      endpoint_origin_hash, ciphertext, wrapped_data_key, nonce, auth_tag,
      master_key_version, fingerprint_suffix, rotated_from_revision,
      credential_state, created_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.credential_id,
    record.credential_revision,
    record.owner_user_id,
    record.endpoint_origin_hash,
    Buffer.from(record.ciphertext, 'base64'),
    Buffer.from(record.wrapped_data_key, 'base64'),
    Buffer.from(record.nonce, 'base64'),
    Buffer.from(record.auth_tag, 'base64'),
    record.master_key_version,
    record.fingerprint_suffix,
    record.rotated_from_revision,
    record.state,
    record.created_at,
    record.revoked_at
  );
}

function requireCredentialRow(database, ownerUserId, credentialId, revision, {
  active = false
} = {}) {
  const row = database.prepare(`
    SELECT * FROM stored_model_credentials
     WHERE credential_id = ? AND credential_revision = ? AND owner_user_id = ?
  `).get(credentialId, revision, ownerUserId);
  if (!row) fail('MODEL_CREDENTIAL_NOT_FOUND', 'model credential does not exist', {}, 404);
  if (active && row.credential_state !== 'ACTIVE') {
    fail('MODEL_CREDENTIAL_REVOKED', 'model credential revision is not active', {}, 409);
  }
  return row;
}

function profileContract(row) {
  return assertModelEndpointProfile({
    schema: MODEL_ENDPOINT_PROFILE_SCHEMA,
    profile_id: row.profile_id,
    owner_user_id: row.owner_user_id,
    config_revision: row.config_revision,
    adapter: row.adapter,
    endpoint: {
      normalized_base_url: row.normalized_base_url,
      normalized_origin: row.normalized_origin
    },
    model: row.model,
    auth_scheme: row.auth_scheme,
    credential_ref: row.credential_id === null
      ? null
      : {
          credential_id: row.credential_id,
          credential_revision: row.credential_revision
        },
    capabilities: {
      native_tools: row.native_tools === 1,
      strict_json: row.strict_json === 1,
      error_correction_continuation: row.error_correction_continuation === 1
    },
    recommended_continuity_transport: row.recommended_transport,
    config_fingerprint: row.config_fingerprint
  });
}

function profileProjection(row) {
  return immutable({
    profile: profileContract(row),
    status: row.profile_status,
    created_at: row.created_at,
    revoked_at: row.revoked_at
  });
}

function profileRef(row) {
  const profile = profileContract(row);
  return immutable({
    profile_id: profile.profile_id,
    config_revision: profile.config_revision,
    owner_user_id: profile.owner_user_id,
    normalized_origin: profile.endpoint.normalized_origin,
    config_fingerprint: profile.config_fingerprint,
    credential_ref: profile.credential_ref
  });
}

function requireProfileRow(database, ownerUserId, profileId, revision = null, {
  active = false
} = {}) {
  const row = revision === null
    ? database.prepare(`
        SELECT * FROM model_endpoint_profiles
         WHERE profile_id = ? AND owner_user_id = ? AND profile_status = 'ACTIVE'
      `).get(profileId, ownerUserId)
    : database.prepare(`
        SELECT * FROM model_endpoint_profiles
         WHERE profile_id = ? AND config_revision = ? AND owner_user_id = ?
      `).get(profileId, revision, ownerUserId);
  if (!row) fail('MODEL_PROFILE_NOT_FOUND', 'model endpoint profile does not exist', {}, 404);
  if (active && row.profile_status !== 'ACTIVE') {
    fail('MODEL_PROFILE_REVOKED', 'model endpoint profile revision is not active', {}, 409);
  }
  return row;
}

function assertProfileCredentialUsable(database, row) {
  if (row.auth_scheme === 'none') return profileContract(row);
  const credentialRow = requireCredentialRow(
    database,
    row.owner_user_id,
    row.credential_id,
    row.credential_revision,
    { active: true }
  );
  return assertModelProfileCredentialBinding(profileContract(row), credentialRecord(credentialRow));
}

function normalizeCapabilities(value = {}) {
  const capabilities = {
    native_tools: value.native_tools ?? false,
    strict_json: value.strict_json ?? false,
    error_correction_continuation: value.error_correction_continuation ?? false
  };
  if (Object.values(capabilities).some(item => typeof item !== 'boolean')) {
    fail('REPOSITORY_INPUT_INVALID', 'model capabilities must be booleans');
  }
  return capabilities;
}

function profileFingerprint(profileWithoutFingerprint) {
  return hashCanonical({
    schema: 'naruto.multiplayer-model-endpoint-config-fingerprint/v1',
    ...profileWithoutFingerprint
  });
}

function selectionHash(selection) {
  const value = canonicalizeJson(selection);
  delete value.selection_hash;
  return hashCanonical(value);
}

function selectionProfileRow(database, row) {
  const profile = database.prepare(`
    SELECT * FROM model_endpoint_profiles
     WHERE profile_id = ? AND config_revision = ? AND owner_user_id = ?
  `).get(row.profile_id, row.profile_revision, row.payer_user_id);
  if (!profile) fail('PERSISTED_BILLING_CORRUPT', 'selection profile revision is missing');
  return profile;
}

function selectionProjection(database, row) {
  return immutable({
    selection_id: row.selection_id,
    turn_id: row.turn_id,
    scope: row.scope,
    audience: row.audience,
    selection_revision: row.selection_revision,
    expected_control_revision: row.expected_control_revision,
    payer_user_id: row.payer_user_id,
    payer_seat: row.payer_seat_id,
    audience_owner_user_id: row.audience_owner_user_id,
    profile_ref: profileRef(selectionProfileRow(database, row)),
    payer_accepted_at: row.payer_accepted_at,
    audience_accepted_at: row.audience_accepted_at,
    idempotency_key: row.idempotency_key,
    selection_hash: row.selection_hash,
    active: row.active === 1,
    created_at: row.created_at
  });
}

function writerAudienceAcceptanceRequestHash({
  roomId,
  epochId,
  turnNo,
  audience,
  selectionRevision,
  expectedControlRevision,
  idempotencyKey
}) {
  return hashCanonical({
    schema: 'naruto.multiplayer-writer-audience-acceptance-request/v1',
    room_id: roomId,
    epoch_id: epochId,
    turn_no: turnNo,
    audience,
    selection_revision: selectionRevision,
    expected_control_revision: expectedControlRevision,
    idempotency_key: idempotencyKey
  });
}

function writerAudienceAcceptanceResult(database, receipt, replayed) {
  const selection = database.prepare(`
    SELECT * FROM turn_model_selections WHERE selection_id = ?
  `).get(receipt.selection_id);
  if (!selection
    || selection.turn_id !== receipt.turn_id
    || selection.audience !== receipt.audience
    || selection.audience_owner_user_id !== receipt.audience_owner_user_id
    || selection.selection_hash !== receipt.result_selection_hash
    || selection.audience_accepted_at !== receipt.accepted_at) {
    fail(
      'PERSISTED_BILLING_CORRUPT',
      'Writer audience-acceptance receipt no longer matches its selection'
    );
  }
  return immutable({
    selection: selectionProjection(database, selection),
    control_revision: receipt.result_control_revision,
    turn_status: receipt.result_turn_status,
    replayed
  });
}

function insertWriterAudienceAcceptanceReceipt(database, receipt) {
  database.prepare(`
    INSERT INTO writer_audience_acceptance_requests (
      acceptance_request_id, turn_id, selection_id, audience,
      audience_owner_user_id, idempotency_key, request_hash,
      expected_control_revision, result_control_revision,
      result_turn_status, result_selection_hash, accepted_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receipt.acceptance_request_id,
    receipt.turn_id,
    receipt.selection_id,
    receipt.audience,
    receipt.audience_owner_user_id,
    receipt.idempotency_key,
    receipt.request_hash,
    receipt.expected_control_revision,
    receipt.result_control_revision,
    receipt.result_turn_status,
    receipt.result_selection_hash,
    receipt.accepted_at,
    receipt.created_at
  );
}

function selectionCapabilityProjection(database, row, profile) {
  const probe = database.prepare(`
    SELECT probe_result_json, recommended_transport
      FROM model_capability_probes
     WHERE profile_owner_user_id = ?
       AND profile_id = ? AND profile_revision = ?
       AND probe_status = 'SUCCEEDED'
       AND ((credential_id IS NULL AND ? IS NULL)
         OR (credential_id = ? AND credential_revision = ?))
     ORDER BY probe_revision DESC LIMIT 1
  `).get(
    row.payer_user_id,
    row.profile_id,
    row.profile_revision,
    row.credential_id,
    row.credential_id,
    row.credential_revision
  );
  const probedCapabilities = probe === undefined
    ? null
    : parseJson(probe.probe_result_json, 'capability probe result')?.capabilities;
  return immutable({
    native_tools: probedCapabilities === null
      ? profile.native_tools === 1
      : probedCapabilities?.native_tools === true,
    strict_json: probedCapabilities === null
      ? profile.strict_json === 1
      : probedCapabilities?.strict_json === true,
    error_correction_continuation: probedCapabilities === null
      ? profile.error_correction_continuation === 1
      : probedCapabilities?.error_correction_continuation === true,
    recommended_continuity_transport:
      probe?.recommended_transport ?? profile.recommended_transport
  });
}

function memberSafeSelectionProjection(database, row, viewerUserId) {
  const profile = selectionProfileRow(database, row);
  const turn = database.prepare(`
    SELECT room_id, epoch_id FROM multiplayer_turns WHERE turn_id = ?
  `).get(row.turn_id);
  if (!turn) fail('PERSISTED_BILLING_CORRUPT', 'selection turn is missing');
  const dataCategories = row.scope === 'shared'
    ? SHARED_STAGE_DATA_CATEGORIES
    : POV_WRITER_DATA_CATEGORIES;
  const requiredConsentSubjects = requiredConsentSubjectUserIds(
    roomMembers(database, turn.room_id),
    {
      audience: row.scope === 'shared' ? null : row.audience,
      payerUserId: row.payer_user_id,
      endpointOwnerUserId: profile.owner_user_id
    }
  );
  const viewerConsentRequired = requiredConsentSubjects.includes(viewerUserId);
  const viewerConsentGranted = exactConsentIsActive(database, {
    roomId: turn.room_id,
    epochId: turn.epoch_id,
    subjectUserId: viewerUserId,
    selectionHashValue: row.selection_hash,
    configFingerprint: profile.config_fingerprint,
    termsRevision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
    categoriesHash: dataCategoriesHash(dataCategories)
  });
  return immutable({
    scope: row.scope,
    audience: row.audience,
    selection_revision: row.selection_revision,
    selection_hash: row.selection_hash,
    payer_seat: row.payer_seat_id,
    profile_ref: {
      adapter: profile.adapter,
      endpoint: {
        normalized_base_url: profile.normalized_base_url
      },
      model: profile.model,
      auth_scheme: profile.auth_scheme,
      config_fingerprint: profile.config_fingerprint,
      transport_capabilities: selectionCapabilityProjection(database, row, profile)
    },
    terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
    data_categories: dataCategories,
    viewer_consent: {
      required: viewerConsentRequired,
      granted: viewerConsentGranted
    }
  });
}

function selectionRows(database, turnId) {
  return database.prepare(`
    SELECT s.*
      FROM turn_model_selections AS s
     WHERE s.turn_id = ? AND s.active = 1
     ORDER BY s.scope, s.audience
  `).all(turnId);
}

function selectionStructureReadiness(turn, rows) {
  const shared = rows.find(row => row.scope === 'shared' && row.audience === 'shared');
  if (!shared) return false;
  if (turn.narrative_mode === 'shared'
    && shared.selected_narrative_mode !== 'shared') return false;
  if (turn.narrative_mode === 'dual_pov'
    && !['shared', 'dual_pov'].includes(shared.selected_narrative_mode)) return false;
  if (turn.narrative_mode === 'shared') return true;
  return ROOM_SEATS.every(audience => {
    const row = rows.find(candidate => (
      candidate.scope === 'writer' && candidate.audience === audience
    ));
    return row?.selected_narrative_mode === 'dual_pov'
      && Boolean(row.payer_accepted_at);
  });
}

function selectionReadiness(turn, rows) {
  return selectionStructureReadiness(turn, rows);
}

function updateTurnReadiness(database, turn, changedAt) {
  const ready = selectionReadiness(turn, selectionRows(database, turn.turn_id));
  const nextStatus = ready ? 'COLLECTING_ACTIONS' : 'AWAITING_PAYER_SELECTION';
  const changed = database.prepare(`
    UPDATE multiplayer_turns
       SET turn_status = ?, updated_at = ?
     WHERE turn_id = ?
       AND turn_status IN ('AWAITING_PAYER_SELECTION', 'COLLECTING_ACTIONS')
       AND NOT EXISTS (
         SELECT 1 FROM action_submissions WHERE turn_id = ?
       )
  `).run(nextStatus, changedAt, turn.turn_id, turn.turn_id);
  if (changed.changes !== 1) {
    fail('EXECUTION_PLAN_FROZEN', 'an action locked while model selections were changing', {}, 409);
  }
  return nextStatus;
}

function advanceSelectionControl(
  database,
  member,
  expectedControlRevision,
  changedAt,
  eventCount
) {
  const row = database.prepare(`
    UPDATE multiplayer_rooms
       SET control_revision = control_revision + 1,
           event_seq = event_seq + ?, updated_at = ?
     WHERE room_id = ? AND active_epoch_id = ? AND current_turn_id IS NOT NULL
       AND control_revision = ? AND lifecycle != 'ARCHIVED'
    RETURNING control_revision, event_seq
  `).get(
    eventCount,
    changedAt,
    member.room_id,
    member.active_epoch_id,
    expectedControlRevision
  );
  if (!row) fail('STALE_CONTROL_REVISION', 'room control revision changed', {}, 409);
  const epoch = database.prepare(`
    UPDATE room_epochs SET control_revision = ?
     WHERE epoch_id = ? AND room_id = ? AND epoch_state = 'ACTIVE'
  `).run(row.control_revision, member.active_epoch_id, member.room_id);
  if (epoch.changes !== 1) {
    fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'active room and epoch control revisions diverged');
  }
  return row;
}

function insertSelectionChangedEvents(database, {
  roomId,
  epochId,
  turn,
  selectionRow,
  members,
  endEventSeq,
  createdAt,
  idFactory
}) {
  const firstEventSeq = endEventSeq - members.length + 1;
  const insertEvent = database.prepare(`
    INSERT INTO room_events (
      event_id, room_id, event_seq, epoch_id, turn_id, event_type,
      audience, projection_version, projected_payload_json, payload_hash,
      created_at
    ) VALUES (?, ?, ?, ?, ?, 'billing.payer_selection_changed', ?, ?, ?, ?, ?)
  `);
  const insertOutbox = database.prepare(`
    INSERT INTO room_outbox (
      outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
      lease_fence, lease_expires_at, claimed_at, dispatched_at,
      attempt_count, created_at
    ) VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, 0, ?)
  `);
  for (const [offset, viewer] of members.entries()) {
    const eventId = generatedId(idFactory, 'event');
    const outboxId = generatedId(idFactory, 'outbox');
    const projection = memberSafeSelectionProjection(database, selectionRow, viewer.user_id);
    const payloadJson = canonicalStringify({
      turn_id: turn.turn_id,
      turn_no: turn.turn_no,
      viewer_seat: viewer.seat_id,
      payer_selection: projection
    });
    insertEvent.run(
      eventId,
      roomId,
      firstEventSeq + offset,
      epochId,
      turn.turn_id,
      viewer.seat_id,
      EVENT_PROJECTION_VERSION,
      payloadJson,
      `sha256:${sha256Hex(payloadJson)}`,
      createdAt
    );
    insertOutbox.run(outboxId, roomId, eventId, createdAt);
  }
}

function insertResolutionStartedEvents(database, {
  roomId,
  epochId,
  turn,
  members,
  endEventSeq,
  controlRevision,
  turnStatus,
  createdAt,
  idFactory
}) {
  const firstEventSeq = endEventSeq - members.length + 1;
  const insertEvent = database.prepare(`
    INSERT INTO room_events (
      event_id, room_id, event_seq, epoch_id, turn_id, event_type,
      audience, projection_version, projected_payload_json, payload_hash,
      created_at
    ) VALUES (?, ?, ?, ?, ?, 'resolution.progress', ?, ?, ?, ?, ?)
  `);
  const insertOutbox = database.prepare(`
    INSERT INTO room_outbox (
      outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
      lease_fence, lease_expires_at, claimed_at, dispatched_at,
      attempt_count, created_at
    ) VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, 0, ?)
  `);
  for (const [offset, viewer] of members.entries()) {
    const eventId = generatedId(idFactory, 'event');
    const payloadJson = canonicalStringify({
      turn_id: turn.turn_id,
      turn_no: turn.turn_no,
      viewer_seat: viewer.seat_id,
      status: turnStatus,
      control_revision: controlRevision
    });
    insertEvent.run(
      eventId,
      roomId,
      firstEventSeq + offset,
      epochId,
      turn.turn_id,
      viewer.seat_id,
      RESOLUTION_EVENT_PROJECTION_VERSION,
      payloadJson,
      `sha256:${sha256Hex(payloadJson)}`,
      createdAt
    );
    insertOutbox.run(generatedId(idFactory, 'outbox'), roomId, eventId, createdAt);
  }
}

function invocationConsentExpectation(item) {
  const categories = item.stage === 'writer' && item.audience !== null
    ? POV_WRITER_DATA_CATEGORIES
    : SHARED_STAGE_DATA_CATEGORIES;
  return Object.freeze({
    terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
    categories_hash: dataCategoriesHash(categories)
  });
}

function requireExactInvocationConsents(database, roomId, epochId, plan, item) {
  const selectionHashValue = item.stage === 'writer' && item.audience !== null
    ? plan.pov_writer_selection_hashes[item.audience]
    : plan.turn_payer_selection_hash;
  const expectation = invocationConsentExpectation(item);
  const receipts = [];
  for (const subjectUserId of item.required_consent_subject_user_ids) {
    const consent = database.prepare(`
      SELECT c.*
        FROM data_processing_consents AS c
       WHERE c.room_id = ? AND c.scope_epoch_id = ?
         AND c.subject_user_id = ? AND c.selection_hash = ?
         AND c.config_fingerprint = ? AND c.terms_revision = ?
         AND c.categories_hash = ? AND c.consent_action = 'GRANTED'
         AND NOT EXISTS (
           SELECT 1 FROM data_processing_consents AS newer
            WHERE newer.consent_series_id = c.consent_series_id
              AND newer.consent_revision > c.consent_revision
         )
       ORDER BY c.recorded_at DESC, c.consent_id DESC LIMIT 1
    `).get(
      roomId,
      epochId,
      subjectUserId,
      selectionHashValue,
      item.profile_ref.config_fingerprint,
      expectation.terms_revision,
      expectation.categories_hash
    );
    if (!consent) {
      fail('DATA_PROCESSING_CONSENT_REQUIRED', 'an exact active data-processing consent is missing', {
        plan_item_id: item.plan_item_id,
        subject_user_id: subjectUserId,
        terms_revision: expectation.terms_revision,
        categories_hash: expectation.categories_hash
      }, 409);
    }
    receipts.push(Object.freeze({
      subject_user_id: subjectUserId,
      consent_id: consent.consent_id,
      consent_revision: consent.consent_revision
    }));
  }
  return Object.freeze({ ...expectation, receipts: Object.freeze(receipts) });
}

function chargedUsageForScope(database, turnId, stage, audience) {
  const audienceLabel = audience ?? 'shared';
  const row = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN budget_charge_state = 'RELEASED'
        THEN 0 ELSE request_count END), 0) AS requests,
      COALESCE(SUM(CASE
        WHEN budget_charge_state = 'RELEASED' THEN 0
        WHEN budget_charge_state = 'RESERVED' THEN reserved_input_tokens
        ELSE COALESCE(input_tokens, reserved_input_tokens)
      END), 0) AS input_tokens,
      COALESCE(SUM(CASE
        WHEN budget_charge_state = 'RELEASED' THEN 0
        WHEN budget_charge_state = 'RESERVED' THEN reserved_output_tokens
        ELSE COALESCE(output_tokens, reserved_output_tokens)
      END), 0) AS output_tokens,
      COALESCE(SUM(CASE WHEN budget_charge_state = 'RELEASED'
        THEN 0 ELSE reserved_retry_count END), 0) AS retries
      FROM ai_usage_ledger
     WHERE turn_id = ? AND stage = ? AND audience = ?
  `).get(turnId, stage, audienceLabel);
  return Object.freeze({
    requests: row.requests,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    retries: row.retries
  });
}

/**
 * Last authority check shared by billing-pause recovery and invocation start.
 * It performs no writes: callers that reserve an invocation run it inside the
 * same BEGIN IMMEDIATE transaction as the usage-ledger insert.
 */
function assertCompletePlanReadiness(database, {
  roomId,
  turn,
  plan,
  checkedAt
}) {
  const latestPlan = database.prepare(`
    SELECT plan_hash FROM turn_billing_plans
     WHERE turn_id = ? ORDER BY plan_revision DESC LIMIT 1
  `).get(turn.turn_id);
  if (!latestPlan || latestPlan.plan_hash !== plan.plan_hash) {
    fail('STALE_BILLING_PLAN', 'model invocation must use the latest applied plan revision', {}, 409);
  }

  const payerItems = new Map();
  for (const item of plan.stage_plans) {
    const values = payerItems.get(item.payer_user_id) ?? [];
    values.push(item);
    payerItems.set(item.payer_user_id, values);
  }
  const authorizationByPayer = new Map();
  for (const [payerUserId, items] of payerItems) {
    const authorization = database.prepare(`
      SELECT * FROM turn_billing_authorizations
       WHERE plan_hash = ? AND payer_user_id = ?
    `).get(plan.plan_hash, payerUserId);
    if (!authorization) {
      fail('BILLING_AUTHORIZATION_REQUIRED', 'a plan payer has not authorized the latest plan', {
        payer_user_id: payerUserId
      }, 409);
    }
    const accepted = parseJson(authorization.accepted_budget_json, 'accepted billing budget');
    const expectedIds = items.map(item => item.plan_item_id).sort();
    if (accepted.plan_revision !== plan.plan_revision
      || canonicalStringify(accepted.plan_item_ids) !== canonicalStringify(expectedIds)) {
      fail('PERSISTED_BILLING_CORRUPT', 'payer authorization does not cover its exact plan items');
    }
    for (const item of items) {
      if (canonicalStringify(accepted.item_budgets?.[item.plan_item_id])
        !== canonicalStringify(item.budget)) {
        fail('PERSISTED_BILLING_CORRUPT', 'payer authorization budget differs from the plan item', {
          plan_item_id: item.plan_item_id
        });
      }
    }
    authorizationByPayer.set(payerUserId, authorization);
  }

  const snapshots = [];
  const usageByScope = new Map();
  const members = roomMembers(database, roomId);
  for (const item of plan.stage_plans) {
    const authorization = authorizationByPayer.get(item.payer_user_id);
    let grant;
    let profile;
    try {
      grant = grantContract(grantRow(
        database,
        authorization.grant_id,
        authorization.grant_revision,
        item.payer_user_id
      ));
      assertExecutionGrantUsable(grant, {
        now: checkedAt,
        payer_user_id: item.payer_user_id,
        room_id: roomId,
        epoch_id: turn.epoch_id,
        turn_id: turn.turn_id,
        stage: item.stage,
        audience: item.audience,
        profile_ref: item.profile_ref
      });
      profile = requireProfileRow(
        database,
        item.payer_user_id,
        item.profile_ref.profile_id,
        item.profile_ref.config_revision,
        { active: true }
      );
      assertProfileCredentialUsable(database, profile);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PERSISTED_BILLING_CORRUPT') throw error;
      fail('EXECUTION_GRANT_REQUIRED', 'a latest-plan execution grant or model binding is no longer usable', {
        plan_item_id: item.plan_item_id,
        payer_user_id: item.payer_user_id
      }, 409);
    }
    const expectedConsentSubjects = requiredConsentSubjectUserIds(members, {
      audience: item.audience,
      payerUserId: item.payer_user_id,
      endpointOwnerUserId: profile.owner_user_id
    });
    if (!sameConsentSubjectSet(
      item.required_consent_subject_user_ids,
      expectedConsentSubjects
    )) {
      fail(
        'PERSISTED_BILLING_CORRUPT',
        'persisted plan consent subjects do not match its authoritative routing'
      );
    }
    const consent = requireExactInvocationConsents(database, roomId, turn.epoch_id, plan, item);
    const consumed = chargedUsageForScope(
      database,
      turn.turn_id,
      item.stage,
      item.audience
    );
    usageByScope.set(`${item.stage}:${item.audience ?? 'shared'}`, consumed);
    snapshots.push(Object.freeze({
      plan_item_id: item.plan_item_id,
      payer_user_id: item.payer_user_id,
      billing_authorization_id: authorization.billing_authorization_id,
      grant_id: authorization.grant_id,
      grant_revision: authorization.grant_revision,
      profile_id: profile.profile_id,
      profile_revision: profile.config_revision,
      credential_id: profile.credential_id,
      credential_revision: profile.credential_revision,
      transport: item.transport,
      consent
    }));
  }
  return Object.freeze({
    snapshots: Object.freeze(snapshots),
    usage_by_scope: usageByScope
  });
}

function planReadinessOrNull(database, input) {
  try {
    return assertCompletePlanReadiness(database, input);
  } catch (error) {
    if (error instanceof DomainError && BILLING_READINESS_ERROR_CODES.has(error.code)) return null;
    throw error;
  }
}

function billingResumeContext(database, turn, plan) {
  const run = database.prepare(`
    SELECT run_id, run_status, stage
      FROM resolution_runs
     WHERE turn_id = ?
     ORDER BY created_at DESC, run_id DESC
     LIMIT 1
  `).get(turn.turn_id);
  // The low-level billing repository can be exercised before the application
  // service installs its durable run. Production sealing creates both in one
  // transaction, while this fallback preserves the repository transition
  // contract without pretending that paused work can resume without a run.
  if (!run) {
    return Object.freeze({
      run_id: null,
      run_status: 'QUEUED',
      stage: 'resolution',
      turn_status: 'RESOLVING'
    });
  }
  if (!['QUEUED', 'PAUSED'].includes(run.run_status)) return null;

  const continuitySession = database.prepare(`
    SELECT session_status, resume_cursor
      FROM agent_stage_sessions
     WHERE run_id = ? AND stage = 'continuity' AND audience = 'none'
  `).get(run.run_id);
  let turnStatus = RUN_STAGE_RESUME_STATUS[run.stage];
  if (continuitySession?.session_status === 'PAUSED') {
    if (typeof continuitySession.resume_cursor !== 'string' || !continuitySession.resume_cursor) {
      fail(
        'BILLING_RESOLUTION_RESUME_CURSOR_MISSING',
        'paused Continuity work has no durable resume cursor'
      );
    }
    const cursor = parseJson(continuitySession.resume_cursor, 'Continuity resume cursor');
    if (cursor.turn_state !== 'AWAITING_BILLING_AUTHORIZATION'
      || !BILLING_RESUME_TURN_STATUSES.has(cursor.resume_stage)
      || !['STAGING_UPDATES', 'REPAIRING_DRAFT'].includes(cursor.resume_stage)) {
      fail(
        'BILLING_RESOLUTION_RESUME_CURSOR_INVALID',
        'paused Continuity work has an invalid billing resume cursor'
      );
    }
    turnStatus = cursor.resume_stage;
  }
  if (!BILLING_RESUME_TURN_STATUSES.has(turnStatus)) {
    fail('BILLING_RESOLUTION_RESUME_CURSOR_INVALID', 'resolution run stage cannot be resumed');
  }

  return Object.freeze({ ...run, turn_status: turnStatus });
}

/**
 * Completing payer authorization is the final gate between a sealed turn and
 * its already-queued resolution run. The transition is deliberately derived
 * from persisted plan items and authorization receipts, never from a caller
 * assertion. A stale plan or a turn that is no longer current is a harmless
 * no-op so replaying an older authorization cannot resurrect work.
 */
function advanceAuthorizedPlanToResolution(database, {
  roomId,
  turn,
  plan,
  advancedAt,
  idFactory,
  authorizationAcceptedAfter = null
}) {
  const latestPlan = database.prepare(`
    SELECT plan_hash FROM turn_billing_plans
     WHERE turn_id = ? ORDER BY plan_revision DESC LIMIT 1
  `).get(turn.turn_id);
  if (!latestPlan || latestPlan.plan_hash !== plan.plan_hash) return null;

  const requiredPayers = [...new Set(
    plan.stage_plans.map(item => item.payer_user_id)
  )].sort();
  const authorizedPayers = new Set(database.prepare(`
    SELECT payer_user_id FROM turn_billing_authorizations
     WHERE plan_hash = ?
  `).all(plan.plan_hash).map(row => row.payer_user_id));
  if (!requiredPayers.every(payerUserId => authorizedPayers.has(payerUserId))) {
    return null;
  }
  if (!planReadinessOrNull(database, {
    roomId,
    turn,
    plan,
    checkedAt: advancedAt
  })) return null;

  if (authorizationAcceptedAfter !== null) {
    const latestAuthorization = database.prepare(`
      SELECT MAX(accepted_at) AS accepted_at
        FROM turn_billing_authorizations
       WHERE plan_hash = ?
    `).get(plan.plan_hash).accepted_at;
    const latestUsage = database.prepare(`
      SELECT plan_hash FROM ai_usage_ledger
       WHERE turn_id = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(turn.turn_id);
    if ((!latestAuthorization
        || Date.parse(latestAuthorization) <= Date.parse(authorizationAcceptedAfter))
      && latestUsage?.plan_hash === plan.plan_hash) {
      return null;
    }
  }

  const room = database.prepare(`
    SELECT control_revision, event_seq
      FROM multiplayer_rooms
     WHERE room_id = ? AND active_epoch_id = ? AND current_turn_id = ?
       AND lifecycle != 'ARCHIVED'
  `).get(roomId, turn.epoch_id, turn.turn_id);
  if (!room) return null;

  const currentTurn = database.prepare(`
    SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
  `).get(turn.turn_id);
  if (currentTurn?.turn_status !== 'AWAITING_BILLING_AUTHORIZATION') return null;
  const resume = billingResumeContext(database, turn, plan);
  if (!resume) return null;

  if (resume.run_status === 'PAUSED') {
    const runChanged = database.prepare(`
      UPDATE resolution_runs
         SET run_status = 'QUEUED', owner_boot_id = NULL, owner_task_id = NULL,
             claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
             updated_at = ?
       WHERE run_id = ? AND run_status = 'PAUSED'
    `).run(advancedAt, resume.run_id);
    if (runChanged.changes !== 1) {
      fail('BILLING_RESOLUTION_ADVANCE_CONFLICT', 'paused resolution run changed while resuming');
    }
  }

  const members = roomMembers(database, roomId);
  const turnChanged = database.prepare(`
    UPDATE multiplayer_turns
       SET turn_status = ?, updated_at = ?
     WHERE turn_id = ? AND room_id = ? AND epoch_id = ?
       AND turn_status = 'AWAITING_BILLING_AUTHORIZATION'
  `).run(resume.turn_status, advancedAt, turn.turn_id, roomId, turn.epoch_id);
  if (turnChanged.changes !== 1) {
    fail('BILLING_RESOLUTION_ADVANCE_CONFLICT', 'turn changed while resuming resolution');
  }

  const control = database.prepare(`
    UPDATE multiplayer_rooms
       SET control_revision = control_revision + 1,
           event_seq = event_seq + ?, updated_at = ?
     WHERE room_id = ? AND active_epoch_id = ? AND current_turn_id = ?
       AND control_revision = ? AND lifecycle != 'ARCHIVED'
    RETURNING control_revision, event_seq
  `).get(
    members.length,
    advancedAt,
    roomId,
    turn.epoch_id,
    turn.turn_id,
    room.control_revision
  );
  if (!control) {
    fail('BILLING_RESOLUTION_ADVANCE_CONFLICT', 'room changed while starting turn resolution');
  }
  const epochChanged = database.prepare(`
    UPDATE room_epochs
       SET control_revision = ?
     WHERE epoch_id = ? AND room_id = ? AND epoch_state = 'ACTIVE'
       AND control_revision = ?
  `).run(
    control.control_revision,
    turn.epoch_id,
    roomId,
    room.control_revision
  );
  if (epochChanged.changes !== 1) {
    fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'active room and epoch control revisions diverged');
  }
  insertResolutionStartedEvents(database, {
    roomId,
    epochId: turn.epoch_id,
    turn,
    members,
    endEventSeq: control.event_seq,
    controlRevision: control.control_revision,
    turnStatus: resume.turn_status,
    createdAt: advancedAt,
    idFactory
  });
  return Object.freeze({
    turn_status: resume.turn_status,
    run_status: 'QUEUED',
    control_revision: control.control_revision,
    run_id: resume.run_id
  });
}

function budgetColumns(budget) {
  const estimate = budget.estimated_cost_cap;
  return [
    budget.max_requests,
    budget.max_input_tokens,
    budget.max_output_tokens,
    budget.max_retries,
    estimate?.currency ?? null,
    estimate?.amount_micros ?? null
  ];
}

function grantContract(row) {
  const profile = {
    profile_id: row.profile_id,
    config_revision: row.profile_revision,
    owner_user_id: row.payer_user_id,
    normalized_origin: row.normalized_origin,
    config_fingerprint: row.config_fingerprint,
    credential_ref: row.credential_id === null
      ? null
      : {
          credential_id: row.credential_id,
          credential_revision: row.credential_revision
        }
  };
  return assertExecutionGrant({
    schema: EXECUTION_GRANT_SCHEMA,
    grant_id: row.grant_id,
    grant_revision: row.grant_revision,
    payer_user_id: row.payer_user_id,
    room_id: row.room_id,
    epoch_id: row.epoch_id,
    profile_ref: profile,
    stage_scopes: parseJson(row.stage_scopes_json, 'execution grant stage scopes'),
    authorization_scope: {
      kind: row.authorization_scope_kind,
      turn_id: row.authorization_turn_id
    },
    budget: {
      max_requests: row.max_requests,
      max_input_tokens: row.max_input_tokens,
      max_output_tokens: row.max_output_tokens,
      max_retries: row.max_retries,
      estimated_cost_cap: row.estimated_cost_currency === null
        ? null
        : {
            currency: row.estimated_cost_currency,
            amount_micros: row.estimated_cost_amount_micros
          }
    },
    granted_at: row.granted_at,
    expires_at: row.expires_at,
    state: row.grant_state,
    revoked_at: row.revoked_at
  });
}

function grantRow(database, grantId, revision, payerUserId) {
  const row = database.prepare(`
    SELECT g.*, p.normalized_origin, p.config_fingerprint
      FROM model_execution_grants AS g
      JOIN model_endpoint_profiles AS p
        ON p.profile_id = g.profile_id
       AND p.config_revision = g.profile_revision
       AND p.owner_user_id = g.payer_user_id
     WHERE g.grant_id = ? AND g.grant_revision = ? AND g.payer_user_id = ?
  `).get(grantId, revision, payerUserId);
  if (!row) fail('EXECUTION_GRANT_NOT_FOUND', 'execution grant does not exist', {}, 404);
  return row;
}

function planContract(row) {
  return assertTurnBillingPlan({
    schema: TURN_BILLING_PLAN_SCHEMA,
    turn_id: row.turn_id,
    plan_revision: row.plan_revision,
    narrative_mode: row.narrative_mode,
    turn_payer_selection_hash: row.turn_payer_selection_hash,
    pov_writer_selection_hashes: row.narrative_mode === 'shared'
      ? null
      : {
          A: row.pov_writer_selection_a_hash,
          B: row.pov_writer_selection_b_hash
        },
    stage_plans: parseJson(row.stage_plans_json, 'turn billing stage plans'),
    plan_hash: row.plan_hash,
    created_at: row.created_at
  });
}

function planRowByHash(database, planHash) {
  const row = database.prepare(`
    SELECT * FROM turn_billing_plans WHERE plan_hash = ?
  `).get(planHash);
  if (!row) fail('BILLING_PLAN_NOT_FOUND', 'turn billing plan does not exist', {}, 404);
  return row;
}

function insertPlan(database, plan, billingPlanId) {
  database.prepare(`
    INSERT INTO turn_billing_plans (
      billing_plan_id, turn_id, plan_revision, narrative_mode,
      turn_payer_selection_hash, pov_writer_selection_a_hash,
      pov_writer_selection_b_hash, stage_plans_json,
      capability_probe_set_hash, plan_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    billingPlanId,
    plan.turn_id,
    plan.plan_revision,
    plan.narrative_mode,
    plan.turn_payer_selection_hash,
    plan.pov_writer_selection_hashes?.A ?? null,
    plan.pov_writer_selection_hashes?.B ?? null,
    canonicalStringify(plan.stage_plans),
    hashCanonical(plan.stage_plans.map(item => item.capability_probe_ref)),
    plan.plan_hash,
    plan.created_at
  );
}

/**
 * SQLite persistence for player-owned model configuration and billing state.
 * Every mutation is routed through connection.write()/BEGIN IMMEDIATE. Model
 * network calls must happen after these methods return.
 */
export function createSqliteBillingRepository(connectionValue, options = {}) {
  const connection = assertConnection(connectionValue);
  const credentialVault = assertVault(options.credentialVault);
  const idFactory = typeof options.idFactory === 'function'
    ? options.idFactory
    : defaultIdFactory;
  const clock = typeof options.clock === 'function'
    ? options.clock
    : () => new Date().toISOString();
  const now = () => assertTimestamp(clock(), 'clock result');

  const credentials = Object.freeze({
    async create({
      authenticated_user_id,
      endpoint_origin,
      plaintext,
      credential_id = null
    }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const endpoint = normalizeModelEndpointBaseUrl(endpoint_origin);
      if (endpoint.normalized_base_url !== endpoint.normalized_origin) {
        fail('CREDENTIAL_ORIGIN_INVALID', 'credential binding must use a normalized origin without a path');
      }
      const credentialId = credential_id === null
        ? generatedId(idFactory, 'credential')
        : assertIdentifier(credential_id, 'credential_id');
      const createdAt = now();
      const sealed = credentialVault.sealCredential({
        credential_id: credentialId,
        owner_user_id: ownerUserId,
        credential_revision: 1,
        endpoint_origin: endpoint.normalized_origin,
        plaintext,
        created_at: createdAt
      });
      return connection.write(database => {
        const existing = database.prepare(`
          SELECT 1 AS present FROM stored_model_credentials WHERE credential_id = ?
        `).get(credentialId);
        if (existing) fail('MODEL_CREDENTIAL_ID_CONFLICT', 'credential ID is already in use', {}, 409);
        insertCredential(database, sealed);
        const row = requireCredentialRow(database, ownerUserId, credentialId, 1);
        return immutable({ credential: credentialProjection(row), replayed: false });
      });
    },

    list({ authenticated_user_id, include_revoked = true }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      return connection.read(database => {
        const rows = database.prepare(`
          SELECT * FROM stored_model_credentials
           WHERE owner_user_id = ?
             AND (? = 1 OR credential_state = 'ACTIVE')
           ORDER BY credential_id, credential_revision DESC
        `).all(ownerUserId, include_revoked ? 1 : 0);
        return Object.freeze(rows.map(credentialProjection));
      });
    },

    get({ authenticated_user_id, credential_id, credential_revision }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const credentialId = assertIdentifier(credential_id, 'credential_id');
      const revision = assertPositiveInteger(credential_revision, 'credential_revision');
      return connection.read(database => credentialProjection(
        requireCredentialRow(database, ownerUserId, credentialId, revision)
      ));
    },

    async rotate({
      authenticated_user_id,
      credential_id,
      expected_credential_revision,
      endpoint_origin,
      plaintext
    }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const credentialId = assertIdentifier(credential_id, 'credential_id');
      const expectedRevision = assertPositiveInteger(
        expected_credential_revision,
        'expected_credential_revision'
      );
      const endpoint = normalizeModelEndpointBaseUrl(endpoint_origin);
      if (endpoint.normalized_base_url !== endpoint.normalized_origin) {
        fail('CREDENTIAL_ORIGIN_INVALID', 'credential rotation must bind a normalized origin');
      }
      const createdAt = now();
      return connection.write(database => {
        const row = requireCredentialRow(
          database,
          ownerUserId,
          credentialId,
          expectedRevision,
          { active: true }
        );
        const current = credentialRecord(row);
        const rotated = credentialVault.rotateCredential(current, {
          owner_user_id: ownerUserId,
          endpoint_origin: endpoint.normalized_origin,
          plaintext,
          created_at: createdAt
        });
        const revoked = database.prepare(`
          UPDATE stored_model_credentials
             SET credential_state = 'REVOKED', revoked_at = ?
           WHERE credential_id = ? AND credential_revision = ?
             AND owner_user_id = ? AND credential_state = 'ACTIVE'
        `).run(createdAt, credentialId, expectedRevision, ownerUserId);
        if (revoked.changes !== 1) {
          fail('STALE_CREDENTIAL_REVISION', 'credential revision changed while rotating', {}, 409);
        }
        insertCredential(database, rotated);
        const next = requireCredentialRow(
          database,
          ownerUserId,
          credentialId,
          rotated.credential_revision
        );
        return immutable({ credential: credentialProjection(next), replayed: false });
      });
    },

    async revoke({
      authenticated_user_id,
      credential_id,
      credential_revision
    }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const credentialId = assertIdentifier(credential_id, 'credential_id');
      const revision = assertPositiveInteger(credential_revision, 'credential_revision');
      const revokedAt = now();
      return connection.write(database => {
        const row = requireCredentialRow(database, ownerUserId, credentialId, revision);
        if (row.credential_state === 'REVOKED') {
          return immutable({ credential: credentialProjection(row), replayed: true });
        }
        credentialVault.revokeCredential(credentialRecord(row), {
          owner_user_id: ownerUserId,
          revoked_at: revokedAt
        });
        const changed = database.prepare(`
          UPDATE stored_model_credentials
             SET credential_state = 'REVOKED', revoked_at = ?
           WHERE credential_id = ? AND credential_revision = ?
             AND owner_user_id = ? AND credential_state = 'ACTIVE'
        `).run(revokedAt, credentialId, revision, ownerUserId);
        if (changed.changes !== 1) fail('STALE_CREDENTIAL_REVISION', 'credential revoke CAS failed', {}, 409);
        return immutable({
          credential: credentialProjection(
            requireCredentialRow(database, ownerUserId, credentialId, revision)
          ),
          replayed: false
        });
      });
    }
  });

  const profiles = Object.freeze({
    async createVersion({
      authenticated_user_id,
      profile_id = null,
      expected_config_revision = 0,
      adapter,
      base_url,
      model,
      auth_scheme,
      credential_ref = null,
      capabilities = {},
      recommended_continuity_transport = null
    }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const profileId = profile_id === null
        ? generatedId(idFactory, 'profile')
        : assertIdentifier(profile_id, 'profile_id');
      const expectedRevision = assertRevision(expected_config_revision, 'expected_config_revision');
      const endpoint = normalizeModelEndpointBaseUrl(base_url);
      assertString(model, 'model', { max: 256 });
      const allowedSchemes = AUTH_SCHEMES_BY_ADAPTER[adapter];
      if (!allowedSchemes || !allowedSchemes.includes(auth_scheme)) {
        fail('MODEL_AUTH_SCHEME_FORBIDDEN', 'auth scheme is not implemented for this adapter');
      }
      if (auth_scheme === 'none' && credential_ref !== null) {
        fail('MODEL_PROFILE_CREDENTIAL_INVALID', 'auth_scheme none cannot reference a credential');
      }
      if (auth_scheme !== 'none' && credential_ref === null) {
        fail('MODEL_PROFILE_CREDENTIAL_REQUIRED', 'authenticated profiles require a credential');
      }
      if (credential_ref !== null) {
        assertIdentifier(credential_ref.credential_id, 'credential_ref.credential_id');
        assertPositiveInteger(
          credential_ref.credential_revision,
          'credential_ref.credential_revision'
        );
      }
      const normalizedCapabilities = normalizeCapabilities(capabilities);
      const createdAt = now();
      return connection.write(database => {
        const active = database.prepare(`
          SELECT * FROM model_endpoint_profiles
           WHERE profile_id = ? AND profile_status = 'ACTIVE'
        `).get(profileId);
        if (expectedRevision === 0) {
          if (active || database.prepare(`
            SELECT 1 AS present FROM model_endpoint_profiles WHERE profile_id = ?
          `).get(profileId)) {
            fail('MODEL_PROFILE_ID_CONFLICT', 'profile ID is already in use', {}, 409);
          }
        } else {
          if (!active || active.owner_user_id !== ownerUserId) {
            fail('MODEL_PROFILE_NOT_FOUND', 'active model endpoint profile does not exist', {}, 404);
          }
          if (active.config_revision !== expectedRevision) {
            fail('STALE_PROFILE_REVISION', 'model endpoint profile revision changed', {}, 409);
          }
        }
        let credential = null;
        if (credential_ref !== null) {
          credential = credentialRecord(requireCredentialRow(
            database,
            ownerUserId,
            credential_ref.credential_id,
            credential_ref.credential_revision,
            { active: true }
          ));
          const expectedOriginHash = `sha256:${sha256Hex(endpoint.normalized_origin)}`;
          if (credential.endpoint_origin_hash !== expectedOriginHash) {
            fail('CREDENTIAL_ORIGIN_MISMATCH', 'credential is bound to another endpoint origin', {}, 409);
          }
        }
        const configRevision = expectedRevision + 1;
        const baseProfile = {
          schema: MODEL_ENDPOINT_PROFILE_SCHEMA,
          profile_id: profileId,
          owner_user_id: ownerUserId,
          config_revision: configRevision,
          adapter,
          endpoint: {
            normalized_base_url: endpoint.normalized_base_url,
            normalized_origin: endpoint.normalized_origin
          },
          model,
          auth_scheme,
          credential_ref,
          capabilities: normalizedCapabilities,
          recommended_continuity_transport,
          config_fingerprint: `sha256:${'0'.repeat(64)}`
        };
        baseProfile.config_fingerprint = profileFingerprint({
          profile_id: profileId,
          owner_user_id: ownerUserId,
          config_revision: configRevision,
          adapter,
          endpoint: baseProfile.endpoint,
          model,
          auth_scheme,
          credential_ref,
          capabilities: normalizedCapabilities,
          recommended_continuity_transport
        });
        const profile = assertModelEndpointProfile(baseProfile);
        if (credential !== null) assertModelProfileCredentialBinding(profile, credential);
        if (active) {
          const changed = database.prepare(`
            UPDATE model_endpoint_profiles
               SET profile_status = 'REVOKED', revoked_at = ?
             WHERE profile_id = ? AND config_revision = ?
               AND owner_user_id = ? AND profile_status = 'ACTIVE'
          `).run(createdAt, profileId, expectedRevision, ownerUserId);
          if (changed.changes !== 1) fail('STALE_PROFILE_REVISION', 'profile version CAS failed', {}, 409);
        }
        database.prepare(`
          INSERT INTO model_endpoint_profiles (
            profile_id, config_revision, owner_user_id, adapter,
            normalized_base_url, normalized_origin, endpoint_origin_hash,
            model, auth_scheme, credential_id, credential_revision,
            native_tools, strict_json, error_correction_continuation,
            recommended_transport, config_fingerprint, profile_status,
            created_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL)
        `).run(
          profile.profile_id,
          profile.config_revision,
          ownerUserId,
          profile.adapter,
          profile.endpoint.normalized_base_url,
          profile.endpoint.normalized_origin,
          `sha256:${sha256Hex(profile.endpoint.normalized_origin)}`,
          profile.model,
          profile.auth_scheme,
          profile.credential_ref?.credential_id ?? null,
          profile.credential_ref?.credential_revision ?? null,
          profile.capabilities.native_tools ? 1 : 0,
          profile.capabilities.strict_json ? 1 : 0,
          profile.capabilities.error_correction_continuation ? 1 : 0,
          profile.recommended_continuity_transport,
          profile.config_fingerprint,
          createdAt
        );
        const inserted = requireProfileRow(
          database,
          ownerUserId,
          profileId,
          configRevision,
          { active: true }
        );
        return immutable({ profile: profileProjection(inserted), replayed: false });
      });
    },

    list({ authenticated_user_id, include_revoked = true }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      return connection.read(database => Object.freeze(database.prepare(`
        SELECT * FROM model_endpoint_profiles
         WHERE owner_user_id = ? AND (? = 1 OR profile_status = 'ACTIVE')
         ORDER BY profile_id, config_revision DESC
      `).all(ownerUserId, include_revoked ? 1 : 0).map(profileProjection)));
    },

    get({ authenticated_user_id, profile_id, config_revision = null }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const profileId = assertIdentifier(profile_id, 'profile_id');
      if (config_revision !== null) {
        assertPositiveInteger(config_revision, 'config_revision');
      }
      return connection.read(database => profileProjection(
        requireProfileRow(database, ownerUserId, profileId, config_revision)
      ));
    },

    async revoke({ authenticated_user_id, profile_id, config_revision }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const profileId = assertIdentifier(profile_id, 'profile_id');
      const revision = assertPositiveInteger(config_revision, 'config_revision');
      const revokedAt = now();
      return connection.write(database => {
        const row = requireProfileRow(database, ownerUserId, profileId, revision);
        if (row.profile_status === 'REVOKED') {
          return immutable({ profile: profileProjection(row), replayed: true });
        }
        const changed = database.prepare(`
          UPDATE model_endpoint_profiles
             SET profile_status = 'REVOKED', revoked_at = ?
           WHERE profile_id = ? AND config_revision = ?
             AND owner_user_id = ? AND profile_status = 'ACTIVE'
        `).run(revokedAt, profileId, revision, ownerUserId);
        if (changed.changes !== 1) fail('STALE_PROFILE_REVISION', 'profile revoke CAS failed', {}, 409);
        return immutable({
          profile: profileProjection(
            requireProfileRow(database, ownerUserId, profileId, revision)
          ),
          replayed: false
        });
      });
    }
  });

  function probeProjection(row) {
    return immutable({
      probe_id: row.probe_id,
      profile_owner_user_id: row.profile_owner_user_id,
      profile_id: row.profile_id,
      profile_revision: row.profile_revision,
      credential_ref: row.credential_id === null
        ? null
        : {
            credential_id: row.credential_id,
            credential_revision: row.credential_revision
          },
      probe_revision: row.probe_revision,
      request_hash: row.request_hash,
      budget: {
        max_requests: row.max_requests,
        max_input_tokens: row.max_input_tokens,
        max_output_tokens: row.max_output_tokens
      },
      result: row.probe_result_json === null
        ? null
        : parseJson(row.probe_result_json, 'capability probe result'),
      probe_hash: row.probe_hash,
      recommended_transport: row.recommended_transport,
      usage_invocation_id: row.usage_invocation_id,
      status: row.probe_status,
      created_at: row.created_at,
      completed_at: row.completed_at
    });
  }

  function requireProbe(database, ownerUserId, probeId) {
    const row = database.prepare(`
      SELECT * FROM model_capability_probes
       WHERE probe_id = ? AND profile_owner_user_id = ?
    `).get(probeId, ownerUserId);
    if (!row) fail('CAPABILITY_PROBE_NOT_FOUND', 'capability probe does not exist', {}, 404);
    return row;
  }

  const probes = Object.freeze({
    async create({
      authenticated_user_id,
      profile_id,
      profile_revision,
      credential_revision = null,
      requested_capabilities,
      max_requests,
      max_input_tokens,
      max_output_tokens,
      idempotency_key
    }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const profileId = assertIdentifier(profile_id, 'profile_id');
      const revision = assertPositiveInteger(profile_revision, 'profile_revision');
      const key = assertString(idempotency_key, 'idempotency_key', { max: 200 });
      if (!Array.isArray(requested_capabilities)
        || requested_capabilities.length < 1
        || new Set(requested_capabilities).size !== requested_capabilities.length
        || requested_capabilities.some(capability => ![
          'native_tools',
          'strict_json',
          'error_correction_continuation'
        ].includes(capability))) {
        fail('CAPABILITY_PROBE_REQUEST_INVALID', 'requested capabilities are invalid');
      }
      const requestBudget = {
        max_requests: assertPositiveInteger(max_requests, 'max_requests'),
        max_input_tokens: assertPositiveInteger(max_input_tokens, 'max_input_tokens'),
        max_output_tokens: assertPositiveInteger(max_output_tokens, 'max_output_tokens')
      };
      if (requested_capabilities.includes('error_correction_continuation')
        && requestBudget.max_requests < 2) {
        fail(
          'CAPABILITY_PROBE_BUDGET_TOO_SMALL',
          'error-correction continuation requires at least two model requests'
        );
      }
      const requestHash = hashCanonical({
        schema: 'naruto.multiplayer-capability-probe-request/v1',
        profile_id: profileId,
        profile_revision: revision,
        credential_revision,
        requested_capabilities: [...requested_capabilities].sort(),
        ...requestBudget
      });
      const createdAt = now();
      return connection.write(database => {
        const existing = database.prepare(`
          SELECT * FROM model_capability_probes
           WHERE profile_owner_user_id = ? AND idempotency_key = ?
        `).get(ownerUserId, key);
        if (existing) {
          if (existing.request_hash !== requestHash) {
            fail(
              'IDEMPOTENCY_CONFLICT',
              'capability-probe idempotency key was reused with different parameters',
              {},
              409
            );
          }
          return immutable({ probe: probeProjection(existing), replayed: true });
        }
        const profile = requireProfileRow(
          database,
          ownerUserId,
          profileId,
          revision,
          { active: true }
        );
        assertProfileCredentialUsable(database, profile);
        const expectedCredentialRevision = profile.credential_revision;
        if (credential_revision !== expectedCredentialRevision) {
          fail(
            'CAPABILITY_PROBE_CREDENTIAL_MISMATCH',
            'probe credential revision must match the exact profile revision'
          );
        }
        const probeRevision = database.prepare(`
          SELECT COALESCE(MAX(probe_revision), 0) + 1 AS next_revision
            FROM model_capability_probes
           WHERE profile_id = ? AND profile_revision = ?
        `).get(profileId, revision).next_revision;
        const probeId = generatedId(idFactory, 'probe');
        database.prepare(`
          INSERT INTO model_capability_probes (
            probe_id, profile_owner_user_id, profile_id, profile_revision,
            credential_id, credential_revision, probe_revision,
            idempotency_key, request_hash, max_requests, max_input_tokens,
            max_output_tokens, probe_result_json, probe_hash,
            recommended_transport, usage_invocation_id, probe_status,
            created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
            NULL, NULL, 'PENDING', ?, NULL)
        `).run(
          probeId,
          ownerUserId,
          profileId,
          revision,
          profile.credential_id,
          profile.credential_revision,
          probeRevision,
          key,
          requestHash,
          requestBudget.max_requests,
          requestBudget.max_input_tokens,
          requestBudget.max_output_tokens,
          createdAt
        );
        return immutable({
          probe: probeProjection(requireProbe(database, ownerUserId, probeId)),
          replayed: false
        });
      });
    },

    get({ authenticated_user_id, probe_id }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const probeId = assertIdentifier(probe_id, 'probe_id');
      return connection.read(database => probeProjection(
        requireProbe(database, ownerUserId, probeId)
      ));
    },

    async start({ authenticated_user_id, probe_id }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const probeId = assertIdentifier(probe_id, 'probe_id');
      return connection.write(database => {
        const existing = requireProbe(database, ownerUserId, probeId);
        if (existing.probe_status === 'RUNNING') {
          return immutable({ probe: probeProjection(existing), replayed: true });
        }
        if (existing.probe_status !== 'PENDING') {
          fail('CAPABILITY_PROBE_STATE_CONFLICT', 'only a pending probe can start', {}, 409);
        }
        database.prepare(`
          UPDATE model_capability_probes SET probe_status = 'RUNNING'
           WHERE probe_id = ? AND profile_owner_user_id = ? AND probe_status = 'PENDING'
        `).run(probeId, ownerUserId);
        return immutable({
          probe: probeProjection(requireProbe(database, ownerUserId, probeId)),
          replayed: false
        });
      });
    },

    async complete({
      authenticated_user_id,
      probe_id,
      result,
      recommended_transport,
      usage_invocation_id = null
    }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const probeId = assertIdentifier(probe_id, 'probe_id');
      const completedAt = now();
      const normalizedResult = canonicalizeJson(result);
      const capabilities = normalizeCapabilities(normalizedResult.capabilities);
      if (recommended_transport === 'native_tools' && !capabilities.native_tools) {
        fail('CAPABILITY_PROBE_RESULT_INVALID', 'native transport was not demonstrated');
      }
      if (recommended_transport === 'json_protocol'
        && !(capabilities.strict_json && capabilities.error_correction_continuation)) {
        fail(
          'CAPABILITY_PROBE_RESULT_INVALID',
          'JSON transport requires strict JSON and error-correction continuation'
        );
      }
      if (![null, 'native_tools', 'json_protocol'].includes(recommended_transport)) {
        fail('CAPABILITY_PROBE_RESULT_INVALID', 'recommended transport is invalid');
      }
      if (usage_invocation_id !== null) assertIdentifier(usage_invocation_id, 'usage_invocation_id');
      const resultJson = canonicalStringify(normalizedResult);
      const probeHash = hashCanonical(normalizedResult);
      return connection.write(database => {
        const existing = requireProbe(database, ownerUserId, probeId);
        if (existing.probe_status === 'SUCCEEDED') {
          if (existing.probe_hash !== probeHash
            || existing.recommended_transport !== recommended_transport
            || existing.usage_invocation_id !== usage_invocation_id) {
            fail('CAPABILITY_PROBE_STATE_CONFLICT', 'completed probe result cannot be replaced', {}, 409);
          }
          return immutable({ probe: probeProjection(existing), replayed: true });
        }
        if (!['PENDING', 'RUNNING'].includes(existing.probe_status)) {
          fail('CAPABILITY_PROBE_STATE_CONFLICT', 'probe is already terminal', {}, 409);
        }
        const changed = database.prepare(`
          UPDATE model_capability_probes
             SET probe_result_json = ?, probe_hash = ?,
                 recommended_transport = ?, usage_invocation_id = ?,
                 probe_status = 'SUCCEEDED', completed_at = ?
           WHERE probe_id = ? AND profile_owner_user_id = ?
             AND probe_status IN ('PENDING', 'RUNNING')
        `).run(
          resultJson,
          probeHash,
          recommended_transport,
          usage_invocation_id,
          completedAt,
          probeId,
          ownerUserId
        );
        if (changed.changes !== 1) fail('CAPABILITY_PROBE_STATE_CONFLICT', 'probe completion CAS failed', {}, 409);
        const affectedTurns = database.prepare(`
          SELECT DISTINCT t.*
            FROM multiplayer_turns AS t
            JOIN turn_model_selections AS s ON s.turn_id = t.turn_id AND s.active = 1
           WHERE s.payer_user_id = ?
             AND s.profile_id = ? AND s.profile_revision = ?
             AND ((s.credential_id IS NULL AND ? IS NULL)
               OR (s.credential_id = ? AND s.credential_revision = ?))
             AND t.turn_status IN ('AWAITING_PAYER_SELECTION', 'COLLECTING_ACTIONS')
             AND NOT EXISTS (
               SELECT 1 FROM action_submissions AS a WHERE a.turn_id = t.turn_id
             )
        `).all(
          ownerUserId,
          existing.profile_id,
          existing.profile_revision,
          existing.credential_id,
          existing.credential_id,
          existing.credential_revision
        );
        for (const turn of affectedTurns) updateTurnReadiness(database, turn, completedAt);
        return immutable({
          probe: probeProjection(requireProbe(database, ownerUserId, probeId)),
          replayed: false
        });
      });
    },

    async fail({ authenticated_user_id, probe_id }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const probeId = assertIdentifier(probe_id, 'probe_id');
      const completedAt = now();
      return connection.write(database => {
        const existing = requireProbe(database, ownerUserId, probeId);
        if (existing.probe_status === 'FAILED') {
          return immutable({ probe: probeProjection(existing), replayed: true });
        }
        if (!['PENDING', 'RUNNING'].includes(existing.probe_status)) {
          fail('CAPABILITY_PROBE_STATE_CONFLICT', 'probe is already terminal', {}, 409);
        }
        database.prepare(`
          UPDATE model_capability_probes
             SET probe_status = 'FAILED', completed_at = ?
           WHERE probe_id = ? AND profile_owner_user_id = ?
             AND probe_status IN ('PENDING', 'RUNNING')
        `).run(completedAt, probeId, ownerUserId);
        return immutable({
          probe: probeProjection(requireProbe(database, ownerUserId, probeId)),
          replayed: false
        });
      });
    },

    async markUnknown({ authenticated_user_id, probe_id }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const probeId = assertIdentifier(probe_id, 'probe_id');
      const completedAt = now();
      return connection.write(database => {
        const existing = requireProbe(database, ownerUserId, probeId);
        if (existing.probe_status === 'UNKNOWN') {
          return immutable({ probe: probeProjection(existing), replayed: true });
        }
        if (existing.probe_status !== 'RUNNING') {
          fail('CAPABILITY_PROBE_STATE_CONFLICT', 'only a running probe may become unknown', {}, 409);
        }
        database.prepare(`
          UPDATE model_capability_probes
             SET probe_status = 'UNKNOWN', completed_at = ?
           WHERE probe_id = ? AND profile_owner_user_id = ? AND probe_status = 'RUNNING'
        `).run(completedAt, probeId, ownerUserId);
        return immutable({
          probe: probeProjection(requireProbe(database, ownerUserId, probeId)),
          replayed: false
        });
      });
    }
  });

  function requireSelectionContext(database, {
    authenticatedUserId,
    roomId,
    epochId,
    turnNo
  }) {
    const member = requireMember(database, roomId, authenticatedUserId);
    requireWritable(member);
    if (member.active_epoch_id !== epochId) {
      fail('STALE_ACTIVE_EPOCH', 'model selection targets a non-active room epoch', {}, 409);
    }
    const turn = requireTurn(database, { roomId, epochId, turnNo });
    if (member.current_turn_id !== turn.turn_id) {
      fail('TURN_NOT_FOUND', 'model selection does not target the active turn', {}, 404);
    }
    return { member, turn, members: roomMembers(database, roomId) };
  }

  function insertSelection(database, {
    selectionId,
    turn,
    scope,
    audience,
    selectionRevision,
    expectedControlRevision,
    payerUserId,
    payerSeat,
    audienceOwnerUserId,
    profile,
    payerAcceptedAt,
    audienceAcceptedAt,
    idempotencyKey,
    selectionHashValue,
    createdAt
  }) {
    database.prepare(`
      INSERT INTO turn_model_selections (
        selection_id, turn_id, scope, audience, selection_revision,
        expected_control_revision, payer_user_id, payer_seat_id,
        audience_owner_user_id, profile_id, profile_revision,
        credential_id, credential_revision, payer_accepted_at,
        audience_accepted_at, idempotency_key, selection_hash,
        active, created_at, selected_narrative_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      selectionId,
      turn.turn_id,
      scope,
      audience,
      selectionRevision,
      expectedControlRevision,
      payerUserId,
      payerSeat,
      audienceOwnerUserId,
      profile.profile_id,
      profile.config_revision,
      profile.credential_id,
      profile.credential_revision,
      payerAcceptedAt,
      audienceAcceptedAt,
      idempotencyKey,
      selectionHashValue,
      createdAt,
      turn.narrative_mode
    );
  }

  const selections = Object.freeze({
    async selectShared({
      authenticated_user_id,
      room_id,
      epoch_id,
      turn_no,
      endpoint_profile_id,
      expected_selection_revision,
      expected_control_revision,
      idempotency_key
    }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const turnNo = assertPositiveInteger(turn_no, 'turn_no');
      const profileId = assertIdentifier(endpoint_profile_id, 'endpoint_profile_id');
      const expectedSelectionRevision = assertRevision(
        expected_selection_revision,
        'expected_selection_revision'
      );
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const key = assertString(idempotency_key, 'idempotency_key', { max: 200 });
      const acceptedAt = now();
      return connection.write(database => {
        const { member, turn, members } = requireSelectionContext(database, {
          authenticatedUserId: payerUserId,
          roomId,
          epochId,
          turnNo
        });
        const replay = database.prepare(`
          SELECT * FROM turn_model_selections
           WHERE turn_id = ? AND scope = 'shared' AND audience = 'shared'
             AND idempotency_key = ?
        `).get(turn.turn_id, key);
        if (replay) {
          if (replay.payer_user_id !== payerUserId
            || replay.profile_id !== profileId
            || replay.expected_control_revision !== expectedControlRevision
            || replay.selection_revision - 1 !== expectedSelectionRevision) {
            fail('IDEMPOTENCY_CONFLICT', 'shared-selection key was reused with different parameters', {}, 409);
          }
          return immutable({
            selection: selectionProjection(database, replay),
            control_revision: member.control_revision,
            turn_status: turn.turn_status,
            replayed: true
          });
        }
        requireSelectionsMutable(database, turn);
        const profile = requireProfileRow(database, payerUserId, profileId, null, { active: true });
        assertProfileCredentialUsable(database, profile);
        if (member.control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed', {}, 409);
        }
        const current = database.prepare(`
          SELECT * FROM turn_model_selections
           WHERE turn_id = ? AND scope = 'shared' AND audience = 'shared' AND active = 1
        `).get(turn.turn_id);
        const latestRevision = database.prepare(`
          SELECT COALESCE(MAX(selection_revision), 0) AS revision
            FROM turn_model_selections
           WHERE turn_id = ? AND scope = 'shared' AND audience = 'shared'
        `).get(turn.turn_id).revision;
        if (latestRevision !== expectedSelectionRevision) {
          fail('STALE_SELECTION_REVISION', 'shared selection revision changed', {
            expected: expectedSelectionRevision,
            actual: latestRevision
          }, 409);
        }
        const selectionRevision = latestRevision + 1;
        const stages = [
          ...SHARED_STAGES,
          ...(turn.narrative_mode === 'shared' ? ['writer'] : [])
        ];
        const domainSelection = {
          schema: TURN_PAYER_SELECTION_SCHEMA,
          turn_id: turn.turn_id,
          selection_revision: selectionRevision,
          expected_control_revision: expectedControlRevision,
          payer_user_id: payerUserId,
          payer_seat: member.seat_id,
          profile_ref: profileRef(profile),
          stage_config_fingerprints: stages.map(stage => ({
            stage,
            config_fingerprint: profile.config_fingerprint
          })),
          payer_acceptance: {
            accepted_by_user_id: payerUserId,
            accepted_at: acceptedAt
          },
          idempotency_key: key,
          selection_hash: `sha256:${'0'.repeat(64)}`,
          active: true
        };
        domainSelection.selection_hash = selectionHash(domainSelection);
        const accepted = assertTurnPayerSelection(domainSelection, {
          authenticated_user_id: payerUserId,
          expected_payer_seat: member.seat_id
        });
        if (current) {
          database.prepare(`
            UPDATE turn_model_selections SET active = 0 WHERE selection_id = ? AND active = 1
          `).run(current.selection_id);
        }
        const selectionId = generatedId(idFactory, 'selection');
        insertSelection(database, {
          selectionId,
          turn,
          scope: 'shared',
          audience: 'shared',
          selectionRevision,
          expectedControlRevision,
          payerUserId,
          payerSeat: member.seat_id,
          audienceOwnerUserId: null,
          profile,
          payerAcceptedAt: acceptedAt,
          audienceAcceptedAt: null,
          idempotencyKey: key,
          selectionHashValue: accepted.selection_hash,
          createdAt: acceptedAt
        });
        const turnStatus = updateTurnReadiness(database, turn, acceptedAt);
        const inserted = database.prepare(`
          SELECT * FROM turn_model_selections WHERE selection_id = ?
        `).get(selectionId);
        const control = advanceSelectionControl(
          database,
          member,
          expectedControlRevision,
          acceptedAt,
          members.length
        );
        insertSelectionChangedEvents(database, {
          roomId,
          epochId,
          turn,
          selectionRow: inserted,
          members,
          endEventSeq: control.event_seq,
          createdAt: acceptedAt,
          idFactory
        });
        return immutable({
          selection: selectionProjection(database, inserted),
          control_revision: control.control_revision,
          turn_status: turnStatus,
          replayed: false
        });
      });
    },

    async selectWriter({
      authenticated_user_id,
      room_id,
      epoch_id,
      turn_no,
      audience,
      endpoint_profile_id,
      expected_selection_revision,
      expected_control_revision,
      idempotency_key
    }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const turnNo = assertPositiveInteger(turn_no, 'turn_no');
      if (!ROOM_SEATS.includes(audience)) fail('REPOSITORY_INPUT_INVALID', 'audience must be A or B');
      const profileId = assertIdentifier(endpoint_profile_id, 'endpoint_profile_id');
      const expectedSelectionRevision = assertRevision(
        expected_selection_revision,
        'expected_selection_revision'
      );
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const key = assertString(idempotency_key, 'idempotency_key', { max: 200 });
      const acceptedAt = now();
      return connection.write(database => {
        const { member, turn, members } = requireSelectionContext(database, {
          authenticatedUserId: payerUserId,
          roomId,
          epochId,
          turnNo
        });
        const replay = database.prepare(`
          SELECT * FROM turn_model_selections
           WHERE turn_id = ? AND scope = 'writer' AND audience = ?
             AND idempotency_key = ?
        `).get(turn.turn_id, audience, key);
        if (replay) {
          if (replay.payer_user_id !== payerUserId
            || replay.profile_id !== profileId
            || replay.expected_control_revision !== expectedControlRevision
            || replay.selection_revision - 1 !== expectedSelectionRevision) {
            fail('IDEMPOTENCY_CONFLICT', 'Writer-selection key was reused with different parameters', {}, 409);
          }
          return immutable({
            selection: selectionProjection(database, replay),
            control_revision: member.control_revision,
            turn_status: turn.turn_status,
            replayed: true
          });
        }
        if (turn.narrative_mode !== 'dual_pov') {
          fail('INVALID_POV_SELECTION', 'POV Writer selections only exist in dual-POV mode', {}, 409);
        }
        const audienceOwner = members.find(candidate => candidate.seat_id === audience);
        requireSelectionsMutable(database, turn);
        const profile = requireProfileRow(database, payerUserId, profileId, null, { active: true });
        assertProfileCredentialUsable(database, profile);
        if (member.control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed', {}, 409);
        }
        const current = database.prepare(`
          SELECT * FROM turn_model_selections
           WHERE turn_id = ? AND scope = 'writer' AND audience = ? AND active = 1
        `).get(turn.turn_id, audience);
        const latestRevision = database.prepare(`
          SELECT COALESCE(MAX(selection_revision), 0) AS revision
            FROM turn_model_selections
           WHERE turn_id = ? AND scope = 'writer' AND audience = ?
        `).get(turn.turn_id, audience).revision;
        if (latestRevision !== expectedSelectionRevision) {
          fail('STALE_SELECTION_REVISION', 'Writer selection revision changed', {
            expected: expectedSelectionRevision,
            actual: latestRevision
          }, 409);
        }
        const selectionRevision = latestRevision + 1;
        const audienceAcceptedAt = audienceOwner.user_id === payerUserId ? acceptedAt : null;
        const domainSelection = {
          schema: POV_WRITER_SELECTION_SCHEMA,
          turn_id: turn.turn_id,
          selection_revision: selectionRevision,
          expected_control_revision: expectedControlRevision,
          audience,
          audience_owner_user_id: audienceOwner.user_id,
          payer_user_id: payerUserId,
          payer_seat: member.seat_id,
          profile_ref: profileRef(profile),
          writer_config_fingerprint: profile.config_fingerprint,
          payer_acceptance: {
            accepted_by_user_id: payerUserId,
            accepted_at: acceptedAt
          },
          audience_acceptance: audienceAcceptedAt === null
            ? null
            : {
                accepted_by_user_id: audienceOwner.user_id,
                accepted_at: audienceAcceptedAt
              },
          idempotency_key: key,
          selection_hash: `sha256:${'0'.repeat(64)}`,
          active: true
        };
        domainSelection.selection_hash = selectionHash(domainSelection);
        const accepted = assertPOVWriterSelection(domainSelection, {
          authenticated_user_id: payerUserId,
          accepting_as: 'payer',
          expected_audience_owner_user_id: audienceOwner.user_id
        });
        if (current) {
          database.prepare(`
            UPDATE turn_model_selections SET active = 0 WHERE selection_id = ? AND active = 1
          `).run(current.selection_id);
        }
        const selectionId = generatedId(idFactory, 'selection');
        insertSelection(database, {
          selectionId,
          turn,
          scope: 'writer',
          audience,
          selectionRevision,
          expectedControlRevision,
          payerUserId,
          payerSeat: member.seat_id,
          audienceOwnerUserId: audienceOwner.user_id,
          profile,
          payerAcceptedAt: acceptedAt,
          audienceAcceptedAt,
          idempotencyKey: key,
          selectionHashValue: accepted.selection_hash,
          createdAt: acceptedAt
        });
        const turnStatus = updateTurnReadiness(database, turn, acceptedAt);
        const inserted = database.prepare(`
          SELECT * FROM turn_model_selections WHERE selection_id = ?
        `).get(selectionId);
        const control = advanceSelectionControl(
          database,
          member,
          expectedControlRevision,
          acceptedAt,
          members.length
        );
        insertSelectionChangedEvents(database, {
          roomId,
          epochId,
          turn,
          selectionRow: inserted,
          members,
          endEventSeq: control.event_seq,
          createdAt: acceptedAt,
          idFactory
        });
        return immutable({
          selection: selectionProjection(database, inserted),
          control_revision: control.control_revision,
          turn_status: turnStatus,
          replayed: false
        });
      });
    },

    async acceptWriterAudience({
      authenticated_user_id,
      room_id,
      epoch_id,
      turn_no,
      audience,
      selection_revision,
      expected_control_revision,
      idempotency_key
    }) {
      const ownerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const turnNo = assertPositiveInteger(turn_no, 'turn_no');
      if (!ROOM_SEATS.includes(audience)) fail('REPOSITORY_INPUT_INVALID', 'audience must be A or B');
      const selectionRevision = assertPositiveInteger(selection_revision, 'selection_revision');
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const key = assertString(idempotency_key, 'idempotency_key', { max: 200 });
      const requestHash = writerAudienceAcceptanceRequestHash({
        roomId,
        epochId,
        turnNo,
        audience,
        selectionRevision,
        expectedControlRevision,
        idempotencyKey: key
      });
      const acceptedAt = now();
      return connection.write(database => {
        const { member, turn, members } = requireSelectionContext(database, {
          authenticatedUserId: ownerUserId,
          roomId,
          epochId,
          turnNo
        });
        if (member.seat_id !== audience) {
          fail('POV_OWNER_SELF_REQUIRED', 'only the POV owner may accept private-projection processing', {}, 403);
        }
        const replay = database.prepare(`
          SELECT * FROM writer_audience_acceptance_requests
           WHERE turn_id = ? AND audience = ? AND idempotency_key = ?
        `).get(turn.turn_id, audience, key);
        if (replay) {
          if (replay.request_hash !== requestHash
            || replay.audience_owner_user_id !== ownerUserId) {
            fail(
              'IDEMPOTENCY_CONFLICT',
              'Writer audience-acceptance key was reused with different parameters',
              {},
              409
            );
          }
          return writerAudienceAcceptanceResult(database, replay, true);
        }
        const row = database.prepare(`
          SELECT * FROM turn_model_selections
           WHERE turn_id = ? AND scope = 'writer' AND audience = ? AND active = 1
        `).get(turn.turn_id, audience);
        if (!row) fail('POV_SELECTION_NOT_FOUND', 'active POV Writer selection does not exist', {}, 404);
        if (row.selection_revision !== selectionRevision) {
          fail('STALE_SELECTION_REVISION', 'POV acceptance targets a replaced selection', {}, 409);
        }
        if (row.audience_owner_user_id !== ownerUserId) {
          fail('POV_OWNER_SELF_REQUIRED', 'authenticated member is not the authoritative POV owner', {}, 403);
        }
        const selectionReceipt = database.prepare(`
          SELECT * FROM writer_audience_acceptance_requests WHERE selection_id = ?
        `).get(row.selection_id);
        if (selectionReceipt) {
          fail(
            'IDEMPOTENCY_CONFLICT',
            'Writer audience acceptance already has another idempotency receipt',
            {},
            409
          );
        }
        if (row.audience_accepted_at !== null) {
          const legacyReceipt = {
            acceptance_request_id: generatedId(idFactory, 'writer_acceptance_request'),
            turn_id: turn.turn_id,
            selection_id: row.selection_id,
            audience,
            audience_owner_user_id: ownerUserId,
            idempotency_key: key,
            request_hash: requestHash,
            expected_control_revision: expectedControlRevision,
            result_control_revision: member.control_revision,
            result_turn_status: turn.turn_status,
            result_selection_hash: row.selection_hash,
            accepted_at: row.audience_accepted_at,
            created_at: acceptedAt
          };
          insertWriterAudienceAcceptanceReceipt(database, legacyReceipt);
          return writerAudienceAcceptanceResult(database, legacyReceipt, true);
        }
        requireSelectionsMutable(database, turn);
        if (member.control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed', {}, 409);
        }
        const profile = selectionProfileRow(database, row);
        const next = {
          schema: POV_WRITER_SELECTION_SCHEMA,
          turn_id: row.turn_id,
          selection_revision: row.selection_revision,
          expected_control_revision: row.expected_control_revision,
          audience: row.audience,
          audience_owner_user_id: row.audience_owner_user_id,
          payer_user_id: row.payer_user_id,
          payer_seat: row.payer_seat_id,
          profile_ref: profileRef(profile),
          writer_config_fingerprint: profile.config_fingerprint,
          payer_acceptance: {
            accepted_by_user_id: row.payer_user_id,
            accepted_at: row.payer_accepted_at
          },
          audience_acceptance: {
            accepted_by_user_id: ownerUserId,
            accepted_at: acceptedAt
          },
          idempotency_key: row.idempotency_key,
          selection_hash: `sha256:${'0'.repeat(64)}`,
          active: true
        };
        next.selection_hash = selectionHash(next);
        const accepted = assertPOVWriterSelection(next, {
          authenticated_user_id: ownerUserId,
          accepting_as: 'audience',
          expected_audience_owner_user_id: ownerUserId
        });
        const changed = database.prepare(`
          UPDATE turn_model_selections
             SET audience_accepted_at = ?, selection_hash = ?
           WHERE selection_id = ? AND active = 1 AND audience_accepted_at IS NULL
        `).run(acceptedAt, accepted.selection_hash, row.selection_id);
        if (changed.changes !== 1) fail('STALE_SELECTION_REVISION', 'POV acceptance CAS failed', {}, 409);
        const turnStatus = updateTurnReadiness(database, turn, acceptedAt);
        const inserted = database.prepare(`
          SELECT * FROM turn_model_selections WHERE selection_id = ?
        `).get(row.selection_id);
        const control = advanceSelectionControl(
          database,
          member,
          expectedControlRevision,
          acceptedAt,
          members.length
        );
        insertSelectionChangedEvents(database, {
          roomId,
          epochId,
          turn,
          selectionRow: inserted,
          members,
          endEventSeq: control.event_seq,
          createdAt: acceptedAt,
          idFactory
        });
        const receipt = {
          acceptance_request_id: generatedId(idFactory, 'writer_acceptance_request'),
          turn_id: turn.turn_id,
          selection_id: inserted.selection_id,
          audience,
          audience_owner_user_id: ownerUserId,
          idempotency_key: key,
          request_hash: requestHash,
          expected_control_revision: expectedControlRevision,
          result_control_revision: control.control_revision,
          result_turn_status: turnStatus,
          result_selection_hash: inserted.selection_hash,
          accepted_at: inserted.audience_accepted_at,
          created_at: acceptedAt
        };
        insertWriterAudienceAcceptanceReceipt(database, receipt);
        return writerAudienceAcceptanceResult(database, receipt, false);
      });
    },

    getActive({ authenticated_user_id, room_id, epoch_id, turn_no }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const turnNo = assertPositiveInteger(turn_no, 'turn_no');
      return connection.read(database => {
        const member = requireMember(database, roomId, userId);
        const turn = requireTurn(database, { roomId, epochId, turnNo });
        const rows = selectionRows(database, turn.turn_id);
        const shared = rows.find(row => row.scope === 'shared') ?? null;
        const writer = Object.fromEntries(ROOM_SEATS.map(audience => [
          audience,
          rows.find(row => row.scope === 'writer' && row.audience === audience) ?? null
        ]));
        return immutable({
          turn_id: turn.turn_id,
          narrative_mode: turn.narrative_mode,
          control_revision: member.control_revision,
          frozen: activeActionCount(database, turn.turn_id) > 0,
          ready: selectionReadiness(turn, rows),
          turn_payer_selection: shared === null ? null : selectionProjection(database, shared),
          pov_writer_selections: turn.narrative_mode === 'shared'
            ? null
            : {
                A: writer.A === null ? null : selectionProjection(database, writer.A),
                B: writer.B === null ? null : selectionProjection(database, writer.B)
              },
          selection_hashes: {
            shared: shared?.selection_hash ?? null,
            writer: turn.narrative_mode === 'shared'
              ? null
              : {
                  A: writer.A?.selection_hash ?? null,
                  B: writer.B?.selection_hash ?? null
                }
          }
        });
      });
    },

    getMemberProjection({ authenticated_user_id, room_id, epoch_id, turn_no }) {
      const viewerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const turnNo = assertPositiveInteger(turn_no, 'turn_no');
      return connection.read(database => {
        requireMember(database, roomId, viewerUserId);
        const turn = requireTurn(database, { roomId, epochId, turnNo });
        const rows = selectionRows(database, turn.turn_id);
        const shared = rows.find(row => (
          row.scope === 'shared' && row.audience === 'shared'
        )) ?? null;
        const writer = Object.fromEntries(ROOM_SEATS.map(audience => [
          audience,
          rows.find(row => row.scope === 'writer' && row.audience === audience) ?? null
        ]));
        return immutable({
          shared: shared === null
            ? null
            : memberSafeSelectionProjection(database, shared, viewerUserId),
          A: turn.narrative_mode === 'dual_pov' && writer.A !== null
            ? memberSafeSelectionProjection(database, writer.A, viewerUserId)
            : null,
          B: turn.narrative_mode === 'dual_pov' && writer.B !== null
            ? memberSafeSelectionProjection(database, writer.B, viewerUserId)
            : null
        });
      });
    }
  });

  function activeRoomMembers(database, roomId) {
    return database.prepare(`
      SELECT member_id, user_id, seat_id
        FROM multiplayer_members
       WHERE room_id = ? AND member_status = 'ACTIVE'
       ORDER BY seat_id
    `).all(roomId);
  }

  function credentialPolicyRoom(database, roomId) {
    const row = database.prepare(`
      SELECT room_id, lifecycle, active_epoch_id, current_turn_id,
             control_revision, event_seq, credential_usage_policy,
             credential_policy_revision
        FROM multiplayer_rooms WHERE room_id = ?
    `).get(roomId);
    if (!row) fail('ROOM_NOT_FOUND', 'room does not exist', { room_id: roomId }, 404);
    return row;
  }

  function activePolicyBinding(database, roomId, seat) {
    return database.prepare(`
      SELECT * FROM room_model_profile_bindings
       WHERE room_id = ? AND seat_id = ? AND active = 1
    `).get(roomId, seat) ?? null;
  }

  function bindingSummary(database, binding) {
    if (!binding) return null;
    const profile = database.prepare(`
      SELECT p.profile_id, p.owner_user_id, p.adapter, p.model,
             p.config_revision, p.profile_status,
             p.credential_id, p.credential_revision,
             c.credential_state
        FROM model_endpoint_profiles AS p
        LEFT JOIN stored_model_credentials AS c
          ON c.credential_id = p.credential_id
         AND c.credential_revision = p.credential_revision
         AND c.owner_user_id = p.owner_user_id
       WHERE p.profile_id = ? AND p.config_revision = ?
         AND p.owner_user_id = ?
    `).get(binding.profile_id, binding.profile_revision, binding.owner_user_id);
    if (!profile) return null;
    const usable = profile.profile_status === 'ACTIVE'
      && (profile.credential_id === null || profile.credential_state === 'ACTIVE');
    return {
      binding_revision: binding.binding_revision,
      profile_revision: profile.config_revision,
      adapter: profile.adapter,
      model: profile.model,
      configured: usable
    };
  }

  function requiredBindingSeats(policy) {
    if (policy === 'A_ONLY') return ['A'];
    if (policy === 'B_ONLY') return ['B'];
    return ROOM_SEATS;
  }

  function credentialPolicyProjection(database, roomId, viewerSeat) {
    const room = credentialPolicyRoom(database, roomId);
    const acceptances = room.credential_policy_revision < 1
      ? []
      : database.prepare(`
          SELECT seat_id FROM room_credential_policy_acceptances
           WHERE room_id = ? AND policy_revision = ?
             AND credential_usage_policy = ?
           ORDER BY seat_id
        `).all(
          roomId,
          room.credential_policy_revision,
          room.credential_usage_policy
        );
    const acceptedSeats = new Set(acceptances.map(row => row.seat_id));
    const bindings = Object.fromEntries(ROOM_SEATS.map(seat => [
      seat,
      bindingSummary(database, activePolicyBinding(database, roomId, seat))
    ]));
    const currentTurn = room.current_turn_id === null
      ? null
      : database.prepare(`
          SELECT turn_id, turn_no, turn_status FROM multiplayer_turns
           WHERE turn_id = ?
        `).get(room.current_turn_id);
    const payerSeat = currentTurn
      ? resolveCredentialPayerSeat(room.credential_usage_policy, currentTurn.turn_no)
      : null;
    const fullyAccepted = ROOM_SEATS.every(seat => acceptedSeats.has(seat));
    const bindingsReady = requiredBindingSeats(room.credential_usage_policy)
      .every(seat => bindings[seat]?.configured === true);
    return immutable({
      schema: 'naruto.multiplayer-credential-usage-policy/v1',
      policy: room.credential_usage_policy,
      policy_revision: room.credential_policy_revision,
      accepted_by: {
        A: acceptedSeats.has('A'),
        B: acceptedSeats.has('B')
      },
      viewer_accepted: acceptedSeats.has(viewerSeat),
      fully_accepted: fullyAccepted,
      bindings_ready: bindingsReady,
      ready: fullyAccepted && bindingsReady,
      bindings,
      current_turn_payer_seat: payerSeat,
      current_turn_id: currentTurn?.turn_id ?? null,
      current_turn_no: currentTurn?.turn_no ?? null
    });
  }

  function advanceCredentialPolicyControl(
    database,
    member,
    expectedControlRevision,
    changedAt,
    eventCount,
    policy,
    policyRevision
  ) {
    const control = database.prepare(`
      UPDATE multiplayer_rooms
         SET credential_usage_policy = ?, credential_policy_revision = ?,
             control_revision = control_revision + 1,
             event_seq = event_seq + ?, updated_at = ?
       WHERE room_id = ? AND control_revision = ? AND lifecycle != 'ARCHIVED'
      RETURNING control_revision, event_seq, active_epoch_id
    `).get(
      policy,
      policyRevision,
      eventCount,
      changedAt,
      member.room_id,
      expectedControlRevision
    );
    if (!control) {
      fail('STALE_CONTROL_REVISION', 'room control revision changed', {}, 409);
    }
    if (control.active_epoch_id !== null) {
      const epoch = database.prepare(`
        UPDATE room_epochs SET control_revision = ?
         WHERE epoch_id = ? AND room_id = ? AND epoch_state = 'ACTIVE'
      `).run(control.control_revision, control.active_epoch_id, member.room_id);
      if (epoch.changes !== 1) {
        fail('ROOM_EPOCH_CONSISTENCY_FAULT', 'active room and epoch control revisions diverged');
      }
    }
    return control;
  }

  function insertCredentialPolicyEvents(database, {
    roomId,
    members,
    endEventSeq,
    createdAt
  }) {
    if (!members.length) return;
    const firstEventSeq = endEventSeq - members.length + 1;
    const insertEvent = database.prepare(`
      INSERT INTO room_events (
        event_id, room_id, event_seq, epoch_id, turn_id, event_type,
        audience, projection_version, projected_payload_json, payload_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, 'billing.credential_policy_changed', ?, ?, ?, ?, ?)
    `);
    const insertOutbox = database.prepare(`
      INSERT INTO room_outbox (
        outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
        lease_fence, lease_expires_at, claimed_at, dispatched_at,
        attempt_count, created_at
      ) VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, 0, ?)
    `);
    const room = credentialPolicyRoom(database, roomId);
    for (const [offset, viewer] of members.entries()) {
      const eventId = generatedId(idFactory, 'event');
      const payloadJson = canonicalStringify({
        viewer_seat: viewer.seat_id,
        credential_policy: credentialPolicyProjection(database, roomId, viewer.seat_id)
      });
      insertEvent.run(
        eventId,
        roomId,
        firstEventSeq + offset,
        room.active_epoch_id,
        room.current_turn_id,
        viewer.seat_id,
        EVENT_PROJECTION_VERSION,
        payloadJson,
        `sha256:${sha256Hex(payloadJson)}`,
        createdAt
      );
      insertOutbox.run(generatedId(idFactory, 'outbox'), roomId, eventId, createdAt);
    }
  }

  function ensureCredentialPolicyAcceptance(database, {
    room,
    member,
    acceptedAt
  }) {
    const existing = database.prepare(`
      SELECT acceptance_id FROM room_credential_policy_acceptances
       WHERE room_id = ? AND policy_revision = ? AND seat_id = ?
    `).get(room.room_id, room.credential_policy_revision, member.seat_id);
    if (existing) return false;
    database.prepare(`
      INSERT INTO room_credential_policy_acceptances (
        acceptance_id, room_id, policy_revision, member_id, seat_id,
        user_id, credential_usage_policy, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generatedId(idFactory, 'policy_acceptance'),
      room.room_id,
      room.credential_policy_revision,
      member.member_id,
      member.seat_id,
      member.user_id,
      room.credential_usage_policy,
      acceptedAt
    );
    return true;
  }

  function invalidateCredentialPolicySelections(database, room, changedAt) {
    if (room.current_turn_id === null) return;
    const turn = requireTurn(database, {
      roomId: room.room_id,
      turnId: room.current_turn_id
    });
    requireSelectionsMutable(database, turn);
    database.prepare(`
      UPDATE turn_model_selections SET active = 0
       WHERE turn_id = ? AND active = 1
    `).run(turn.turn_id);
    updateTurnReadiness(database, turn, changedAt);
  }

  function ensureCredentialPolicyConsent(database, {
    roomId,
    epochId,
    subjectUserId,
    selectionHashValue,
    configFingerprint,
    categories,
    recordedAt
  }) {
    const categoriesHash = dataCategoriesHash(categories);
    const prior = database.prepare(`
      SELECT * FROM data_processing_consents
       WHERE room_id = ? AND scope_epoch_id = ? AND subject_user_id = ?
         AND selection_hash = ? AND config_fingerprint = ?
         AND terms_revision = ? AND categories_hash = ?
       ORDER BY consent_revision DESC LIMIT 1
    `).get(
      roomId,
      epochId,
      subjectUserId,
      selectionHashValue,
      configFingerprint,
      MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
      categoriesHash
    );
    if (prior?.consent_action === 'GRANTED') return;
    database.prepare(`
      INSERT INTO data_processing_consents (
        consent_id, consent_series_id, consent_revision, room_id,
        scope_epoch_id, subject_user_id, selection_hash,
        config_fingerprint, terms_revision, categories_hash,
        consent_action, supersedes_consent_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'GRANTED', ?, ?)
    `).run(
      generatedId(idFactory, 'consent'),
      prior?.consent_series_id ?? generatedId(idFactory, 'consent_series'),
      (prior?.consent_revision ?? 0) + 1,
      roomId,
      epochId,
      subjectUserId,
      selectionHashValue,
      configFingerprint,
      MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
      categoriesHash,
      prior?.consent_id ?? null,
      recordedAt
    );
  }

  function replacePolicySelection(database, {
    turn,
    scope,
    audience,
    payer,
    profile,
    audienceOwner,
    controlRevision,
    policyRevision,
    createdAt
  }) {
    const idempotencyKey = [
      'credential-policy',
      policyRevision,
      turn.turn_id,
      turn.narrative_mode,
      controlRevision,
      scope,
      audience
    ].join('-');
    const current = database.prepare(`
      SELECT * FROM turn_model_selections
       WHERE turn_id = ? AND scope = ? AND audience = ? AND active = 1
    `).get(turn.turn_id, scope, audience);
    if (current?.idempotency_key === idempotencyKey
      && current.profile_id === profile.profile_id
      && current.profile_revision === profile.config_revision) {
      return current;
    }
    const latestRevision = database.prepare(`
      SELECT COALESCE(MAX(selection_revision), 0) AS revision
        FROM turn_model_selections
       WHERE turn_id = ? AND scope = ? AND audience = ?
    `).get(turn.turn_id, scope, audience).revision;
    const selectionRevision = latestRevision + 1;
    let accepted;
    if (scope === 'shared') {
      const stages = [
        ...SHARED_STAGES,
        ...(turn.narrative_mode === 'shared' ? ['writer'] : [])
      ];
      const value = {
        schema: TURN_PAYER_SELECTION_SCHEMA,
        turn_id: turn.turn_id,
        selection_revision: selectionRevision,
        expected_control_revision: controlRevision,
        payer_user_id: payer.user_id,
        payer_seat: payer.seat_id,
        profile_ref: profileRef(profile),
        stage_config_fingerprints: stages.map(stage => ({
          stage,
          config_fingerprint: profile.config_fingerprint
        })),
        payer_acceptance: {
          accepted_by_user_id: payer.user_id,
          accepted_at: createdAt
        },
        idempotency_key: idempotencyKey,
        selection_hash: `sha256:${'0'.repeat(64)}`,
        active: true
      };
      value.selection_hash = selectionHash(value);
      accepted = assertTurnPayerSelection(value, {
        authenticated_user_id: payer.user_id,
        expected_payer_seat: payer.seat_id
      });
    } else {
      const value = {
        schema: POV_WRITER_SELECTION_SCHEMA,
        turn_id: turn.turn_id,
        selection_revision: selectionRevision,
        expected_control_revision: controlRevision,
        audience,
        audience_owner_user_id: audienceOwner.user_id,
        payer_user_id: payer.user_id,
        payer_seat: payer.seat_id,
        profile_ref: profileRef(profile),
        writer_config_fingerprint: profile.config_fingerprint,
        payer_acceptance: {
          accepted_by_user_id: payer.user_id,
          accepted_at: createdAt
        },
        audience_acceptance: {
          accepted_by_user_id: audienceOwner.user_id,
          accepted_at: createdAt
        },
        idempotency_key: idempotencyKey,
        selection_hash: `sha256:${'0'.repeat(64)}`,
        active: true
      };
      value.selection_hash = selectionHash(value);
      accepted = assertPOVWriterSelection(value, {
        authenticated_user_id: audienceOwner.user_id,
        accepting_as: 'audience',
        expected_audience_owner_user_id: audienceOwner.user_id
      });
    }
    if (current) {
      database.prepare(`
        UPDATE turn_model_selections SET active = 0
         WHERE selection_id = ? AND active = 1
      `).run(current.selection_id);
    }
    const selectionId = generatedId(idFactory, 'selection');
    insertSelection(database, {
      selectionId,
      turn,
      scope,
      audience,
      selectionRevision,
      expectedControlRevision: controlRevision,
      payerUserId: payer.user_id,
      payerSeat: payer.seat_id,
      audienceOwnerUserId: scope === 'shared' ? null : audienceOwner.user_id,
      profile,
      payerAcceptedAt: createdAt,
      audienceAcceptedAt: scope === 'shared' ? null : createdAt,
      idempotencyKey,
      selectionHashValue: accepted.selection_hash,
      createdAt
    });
    return database.prepare(`
      SELECT * FROM turn_model_selections WHERE selection_id = ?
    `).get(selectionId);
  }

  function materializeCredentialPolicy(database, {
    roomId,
    controlRevision,
    createdAt
  }) {
    const room = credentialPolicyRoom(database, roomId);
    if (room.credential_policy_revision < 1 || room.current_turn_id === null) return null;
    const members = activeRoomMembers(database, roomId);
    if (members.length !== 2 || !ROOM_SEATS.every((seat, index) => (
      members[index]?.seat_id === seat
    ))) return null;
    const accepted = new Set(database.prepare(`
      SELECT seat_id FROM room_credential_policy_acceptances
       WHERE room_id = ? AND policy_revision = ?
         AND credential_usage_policy = ?
    `).all(
      roomId,
      room.credential_policy_revision,
      room.credential_usage_policy
    ).map(row => row.seat_id));
    if (!ROOM_SEATS.every(seat => accepted.has(seat))) return null;
    for (const seat of requiredBindingSeats(room.credential_usage_policy)) {
      const summary = bindingSummary(database, activePolicyBinding(database, roomId, seat));
      if (summary?.configured !== true) return null;
    }
    const turn = database.prepare(`
      SELECT * FROM multiplayer_turns WHERE turn_id = ?
    `).get(room.current_turn_id);
    if (!turn
      || activeActionCount(database, turn.turn_id) > 0
      || !['AWAITING_PAYER_SELECTION', 'COLLECTING_ACTIONS'].includes(turn.turn_status)) {
      return null;
    }
    const payerSeat = resolveCredentialPayerSeat(
      room.credential_usage_policy,
      turn.turn_no
    );
    const payer = members.find(row => row.seat_id === payerSeat);
    const binding = activePolicyBinding(database, roomId, payerSeat);
    if (!payer || !binding) return null;
    const profile = requireProfileRow(
      database,
      payer.user_id,
      binding.profile_id,
      binding.profile_revision,
      { active: true }
    );
    assertProfileCredentialUsable(database, profile);
    const materialized = [replacePolicySelection(database, {
      turn,
      scope: 'shared',
      audience: 'shared',
      payer,
      profile,
      audienceOwner: null,
      controlRevision,
      policyRevision: room.credential_policy_revision,
      createdAt
    })];
    if (turn.narrative_mode === 'dual_pov') {
      for (const audience of ROOM_SEATS) {
        materialized.push(replacePolicySelection(database, {
          turn,
          scope: 'writer',
          audience,
          payer,
          profile,
          audienceOwner: members.find(row => row.seat_id === audience),
          controlRevision,
          policyRevision: room.credential_policy_revision,
          createdAt
        }));
      }
    }
    for (const row of materialized) {
      const categories = row.scope === 'shared'
        ? SHARED_STAGE_DATA_CATEGORIES
        : POV_WRITER_DATA_CATEGORIES;
      const profileRow = selectionProfileRow(database, row);
      const subjects = requiredConsentSubjectUserIds(members, {
        audience: row.scope === 'shared' ? null : row.audience,
        payerUserId: row.payer_user_id,
        endpointOwnerUserId: profileRow.owner_user_id
      });
      for (const subjectUserId of subjects) {
        ensureCredentialPolicyConsent(database, {
          roomId,
          epochId: turn.epoch_id,
          subjectUserId,
          selectionHashValue: row.selection_hash,
          configFingerprint: profileRow.config_fingerprint,
          categories,
          recordedAt: createdAt
        });
      }
    }
    return immutable({
      turn_id: turn.turn_id,
      payer_seat: payerSeat,
      turn_status: updateTurnReadiness(database, turn, createdAt),
      selection_hashes: materialized.map(row => row.selection_hash)
    });
  }

  function credentialPolicySelectionsReady(database, room) {
    if (room.current_turn_id === null || room.credential_policy_revision < 1) return false;
    const turn = database.prepare(`
      SELECT * FROM multiplayer_turns WHERE turn_id = ?
    `).get(room.current_turn_id);
    if (!turn) return false;
    const rows = selectionRows(database, turn.turn_id);
    const relevantRows = rows.filter(row => (
      row.scope === 'shared' || turn.narrative_mode === 'dual_pov'
    ));
    const prefix = [
      'credential-policy',
      room.credential_policy_revision,
      turn.turn_id,
      turn.narrative_mode,
      ''
    ].join('-');
    const expectedCount = turn.narrative_mode === 'shared' ? 1 : 3;
    return relevantRows.length === expectedCount
      && relevantRows.every(row => row.idempotency_key === [
        `${prefix}${row.expected_control_revision}`,
        row.scope,
        row.audience
      ].join('-'))
      && selectionReadiness(turn, rows);
  }

  function autoAuthorizeCredentialPolicyPlan(database, {
    roomId,
    planHash,
    authorizedAt
  }) {
    const planRow = database.prepare(`
      SELECT * FROM turn_billing_plans WHERE plan_hash = ?
    `).get(planHash);
    if (!planRow) return null;
    const plan = planContract(planRow);
    const turn = requireTurn(database, { roomId, turnId: plan.turn_id });
    if (turn.turn_status !== 'AWAITING_BILLING_AUTHORIZATION') return null;
    const room = credentialPolicyRoom(database, roomId);
    if (room.credential_policy_revision < 1) return null;
    const acceptedSeats = new Set(database.prepare(`
      SELECT seat_id FROM room_credential_policy_acceptances
       WHERE room_id = ? AND policy_revision = ?
         AND credential_usage_policy = ?
    `).all(
      roomId,
      room.credential_policy_revision,
      room.credential_usage_policy
    ).map(row => row.seat_id));
    if (!ROOM_SEATS.every(seat => acceptedSeats.has(seat))) return null;
    const payerSeat = resolveCredentialPayerSeat(room.credential_usage_policy, turn.turn_no);
    if (plan.stage_plans.some(item => item.payer_seat !== payerSeat)) return null;
    const selectionsForPlan = selectionRows(database, turn.turn_id);
    const policyKeyPrefix = `credential-policy-${room.credential_policy_revision}-${turn.turn_id}-`;
    if (!selectionsForPlan.length
      || selectionsForPlan.some(row => !row.idempotency_key.startsWith(policyKeyPrefix))) {
      return null;
    }
    const payer = activeRoomMembers(database, roomId).find(row => row.seat_id === payerSeat);
    const binding = activePolicyBinding(database, roomId, payerSeat);
    if (!payer || !binding) return null;
    const profile = requireProfileRow(
      database,
      payer.user_id,
      binding.profile_id,
      binding.profile_revision,
      { active: true }
    );
    assertProfileCredentialUsable(database, profile);
    const authoritativeProfileRef = profileRef(profile);
    if (plan.stage_plans.some(item => (
      item.payer_user_id !== payer.user_id
      || canonicalStringify(item.profile_ref) !== canonicalStringify(authoritativeProfileRef)
    ))) return null;

    const payerItems = plan.stage_plans;
    const stageScopes = payerItems.map(item => ({
      stage: item.stage,
      audience: item.audience
    }));
    const aggregateBudget = payerItems.reduce((total, item) => ({
      max_requests: total.max_requests + item.budget.max_requests,
      max_input_tokens: total.max_input_tokens + item.budget.max_input_tokens,
      max_output_tokens: total.max_output_tokens + item.budget.max_output_tokens,
      max_retries: total.max_retries + item.budget.max_retries,
      estimated_cost_cap: null
    }), {
      max_requests: 0,
      max_input_tokens: 0,
      max_output_tokens: 0,
      max_retries: 0,
      estimated_cost_cap: null
    });
    const grantId = `grant_policy_${sha256Hex({
      schema: 'naruto.multiplayer-policy-grant-id/v1',
      room_id: roomId,
      turn_id: turn.turn_id,
      plan_hash: plan.plan_hash,
      payer_user_id: payer.user_id
    }).slice(0, 40)}`;
    const existingGrant = database.prepare(`
      SELECT grant_id FROM model_execution_grants
       WHERE grant_id = ? AND grant_revision = 1
    `).get(grantId);
    if (!existingGrant) {
      const grant = assertExecutionGrant({
        schema: EXECUTION_GRANT_SCHEMA,
        grant_id: grantId,
        grant_revision: 1,
        payer_user_id: payer.user_id,
        room_id: roomId,
        epoch_id: turn.epoch_id,
        profile_ref: authoritativeProfileRef,
        stage_scopes: stageScopes,
        authorization_scope: { kind: 'single_turn', turn_id: turn.turn_id },
        budget: aggregateBudget,
        granted_at: authorizedAt,
        expires_at: '9999-12-31T23:59:59.999Z',
        state: 'ACTIVE',
        revoked_at: null
      });
      database.prepare(`
        INSERT INTO model_execution_grants (
          grant_id, grant_revision, payer_user_id, room_id, epoch_id,
          profile_id, profile_revision, credential_id, credential_revision,
          stage_scopes_json, authorization_scope_kind,
          authorization_turn_id, max_requests, max_input_tokens,
          max_output_tokens, max_retries, estimated_cost_currency,
          estimated_cost_amount_micros, granted_at, expires_at,
          grant_state, revoked_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'single_turn', ?,
          ?, ?, ?, ?, NULL, NULL, ?, ?, 'ACTIVE', NULL)
      `).run(
        grant.grant_id,
        grant.payer_user_id,
        grant.room_id,
        grant.epoch_id,
        grant.profile_ref.profile_id,
        grant.profile_ref.config_revision,
        grant.profile_ref.credential_ref?.credential_id ?? null,
        grant.profile_ref.credential_ref?.credential_revision ?? null,
        canonicalStringify(grant.stage_scopes),
        grant.authorization_scope.turn_id,
        grant.budget.max_requests,
        grant.budget.max_input_tokens,
        grant.budget.max_output_tokens,
        grant.budget.max_retries,
        grant.granted_at,
        grant.expires_at
      );
    }
    const acceptedBudget = immutable({
      schema: 'naruto.multiplayer-accepted-plan-budget/v1',
      plan_revision: plan.plan_revision,
      plan_item_ids: payerItems.map(item => item.plan_item_id).sort(),
      item_budgets: Object.fromEntries(payerItems.map(item => [item.plan_item_id, item.budget]))
    });
    let authorization = database.prepare(`
      SELECT * FROM turn_billing_authorizations
       WHERE plan_hash = ? AND payer_user_id = ?
    `).get(plan.plan_hash, payer.user_id);
    if (!authorization) {
      const authorizationId = generatedId(idFactory, 'billing_authorization');
      database.prepare(`
        INSERT INTO turn_billing_authorizations (
          billing_authorization_id, plan_hash, payer_user_id,
          grant_id, grant_revision, accepted_budget_json, accepted_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(
        authorizationId,
        plan.plan_hash,
        payer.user_id,
        grantId,
        canonicalStringify(acceptedBudget),
        authorizedAt
      );
      authorization = database.prepare(`
        SELECT * FROM turn_billing_authorizations
         WHERE billing_authorization_id = ?
      `).get(authorizationId);
    } else if (authorization.grant_id !== grantId || authorization.grant_revision !== 1) {
      fail(
        'BILLING_AUTHORIZATION_CONFLICT',
        'credential policy plan already has a different payer authorization',
        {},
        409
      );
    }
    const advanced = advanceAuthorizedPlanToResolution(database, {
      roomId,
      turn,
      plan,
      advancedAt: authorizedAt,
      idFactory
    });
    return immutable({
      plan_hash: plan.plan_hash,
      payer_seat: payerSeat,
      grant_id: grantId,
      authorization_id: authorization.billing_authorization_id,
      turn_status: advanced?.turn_status ?? turn.turn_status,
      advanced: advanced !== null
    });
  }

  const credentialPolicies = Object.freeze({
    getMemberProjection({ authenticated_user_id, room_id }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      return connection.read(database => {
        const member = requireMember(database, roomId, userId);
        return credentialPolicyProjection(database, roomId, member.seat_id);
      });
    },

    async bindOwnProfile({
      authenticated_user_id,
      room_id,
      endpoint_profile_id,
      expected_binding_revision,
      expected_control_revision
    }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const profileId = assertIdentifier(endpoint_profile_id, 'endpoint_profile_id');
      const expectedBindingRevision = assertRevision(
        expected_binding_revision,
        'expected_binding_revision'
      );
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const changedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, userId);
        requireWritable(member);
        const profile = requireProfileRow(database, userId, profileId, null, { active: true });
        assertProfileCredentialUsable(database, profile);
        const room = credentialPolicyRoom(database, roomId);
        if (room.control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed', {}, 409);
        }
        const current = activePolicyBinding(database, roomId, member.seat_id);
        const latestRevision = database.prepare(`
          SELECT COALESCE(MAX(binding_revision), 0) AS revision
            FROM room_model_profile_bindings
           WHERE room_id = ? AND seat_id = ?
        `).get(roomId, member.seat_id).revision;
        if (latestRevision !== expectedBindingRevision) {
          fail('STALE_PROFILE_BINDING_REVISION', 'room profile binding changed', {
            expected: expectedBindingRevision,
            actual: latestRevision
          }, 409);
        }
        const bindingChanged = !current
          || current.profile_id !== profile.profile_id
          || current.profile_revision !== profile.config_revision;
        if (bindingChanged) {
          if (current) {
            database.prepare(`
              UPDATE room_model_profile_bindings
                 SET active = 0, replaced_at = ?
               WHERE binding_id = ? AND active = 1
            `).run(changedAt, current.binding_id);
          }
          database.prepare(`
            INSERT INTO room_model_profile_bindings (
              binding_id, room_id, member_id, seat_id, owner_user_id,
              binding_revision, profile_id, profile_revision,
              active, created_at, replaced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)
          `).run(
            generatedId(idFactory, 'profile_binding'),
            roomId,
            member.member_id,
            member.seat_id,
            userId,
            latestRevision + 1,
            profile.profile_id,
            profile.config_revision,
            changedAt
          );
        }
        const policyRevision = bindingChanged
          ? Math.max(1, room.credential_policy_revision + 1)
          : Math.max(1, room.credential_policy_revision);
        const members = activeRoomMembers(database, roomId);
        if (bindingChanged) {
          invalidateCredentialPolicySelections(database, room, changedAt);
        }
        const control = advanceCredentialPolicyControl(
          database,
          member,
          expectedControlRevision,
          changedAt,
          members.length,
          room.credential_usage_policy,
          policyRevision
        );
        const materialized = materializeCredentialPolicy(database, {
          roomId,
          controlRevision: control.control_revision,
          createdAt: changedAt
        });
        insertCredentialPolicyEvents(database, {
          roomId,
          members,
          endEventSeq: control.event_seq,
          createdAt: changedAt
        });
        return immutable({
          credential_policy: credentialPolicyProjection(database, roomId, member.seat_id),
          materialized,
          replayed: !bindingChanged
        });
      });
    },

    async choose({
      authenticated_user_id,
      room_id,
      policy: policyValue,
      expected_policy_revision,
      expected_control_revision
    }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const policy = assertCredentialUsagePolicy(policyValue);
      const expectedPolicyRevision = assertRevision(
        expected_policy_revision,
        'expected_policy_revision'
      );
      const expectedControlRevision = assertRevision(
        expected_control_revision,
        'expected_control_revision'
      );
      const changedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, userId);
        requireWritable(member);
        const room = credentialPolicyRoom(database, roomId);
        if (room.control_revision !== expectedControlRevision) {
          fail('STALE_CONTROL_REVISION', 'room control revision changed', {}, 409);
        }
        if (room.credential_policy_revision !== expectedPolicyRevision) {
          fail('STALE_CREDENTIAL_POLICY_REVISION', 'credential usage policy changed', {
            expected: expectedPolicyRevision,
            actual: room.credential_policy_revision
          }, 409);
        }
        const policyChanged = room.credential_usage_policy !== policy
          || room.credential_policy_revision === 0;
        const policyRevision = policyChanged
          ? room.credential_policy_revision + 1
          : room.credential_policy_revision;
        const priorAcceptance = policyChanged ? null : database.prepare(`
          SELECT acceptance_id FROM room_credential_policy_acceptances
           WHERE room_id = ? AND policy_revision = ? AND seat_id = ?
        `).get(roomId, policyRevision, member.seat_id);
        if (priorAcceptance && credentialPolicySelectionsReady(database, room)) {
          return immutable({
            credential_policy: credentialPolicyProjection(database, roomId, member.seat_id),
            materialized: null,
            replayed: true
          });
        }
        const members = activeRoomMembers(database, roomId);
        if (policyChanged) {
          invalidateCredentialPolicySelections(database, room, changedAt);
        }
        const control = advanceCredentialPolicyControl(
          database,
          member,
          expectedControlRevision,
          changedAt,
          members.length,
          policy,
          policyRevision
        );
        const updatedRoom = credentialPolicyRoom(database, roomId);
        ensureCredentialPolicyAcceptance(database, {
          room: updatedRoom,
          member,
          acceptedAt: changedAt
        });
        const materialized = materializeCredentialPolicy(database, {
          roomId,
          controlRevision: control.control_revision,
          createdAt: changedAt
        });
        insertCredentialPolicyEvents(database, {
          roomId,
          members,
          endEventSeq: control.event_seq,
          createdAt: changedAt
        });
        return immutable({
          credential_policy: credentialPolicyProjection(database, roomId, member.seat_id),
          materialized,
          replayed: false
        });
      });
    },

    async materializeActiveTurn({ authenticated_user_id, room_id }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const changedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, userId);
        requireWritable(member);
        const room = credentialPolicyRoom(database, roomId);
        const projection = credentialPolicyProjection(database, roomId, member.seat_id);
        if (!projection.ready || room.current_turn_id === null) return null;
        if (credentialPolicySelectionsReady(database, room)) {
          return immutable({
            credential_policy: projection,
            materialized: null,
            replayed: true
          });
        }
        const members = activeRoomMembers(database, roomId);
        const control = advanceCredentialPolicyControl(
          database,
          member,
          room.control_revision,
          changedAt,
          members.length,
          room.credential_usage_policy,
          room.credential_policy_revision
        );
        const materialized = materializeCredentialPolicy(database, {
          roomId,
          controlRevision: control.control_revision,
          createdAt: changedAt
        });
        insertCredentialPolicyEvents(database, {
          roomId,
          members,
          endEventSeq: control.event_seq,
          createdAt: changedAt
        });
        return immutable({
          credential_policy: credentialPolicyProjection(database, roomId, member.seat_id),
          materialized,
          replayed: false
        });
      });
    },

    async autoAuthorizePlan({
      authenticated_user_id,
      room_id,
      plan_hash
    }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const planHash = assertHash(plan_hash, 'plan_hash');
      const authorizedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, userId);
        requireWritable(member);
        return autoAuthorizeCredentialPolicyPlan(database, {
          roomId,
          planHash,
          authorizedAt
        });
      });
    }
  });

  const grants = Object.freeze({
    async createVersion({
      authenticated_user_id,
      room_id,
      epoch_id,
      grant_id = null,
      expected_grant_revision = 0,
      endpoint_profile_id,
      profile_revision,
      stage_scopes,
      authorization_scope,
      budget,
      expires_at
    }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const grantId = grant_id === null
        ? generatedId(idFactory, 'grant')
        : assertIdentifier(grant_id, 'grant_id');
      const expectedRevision = assertRevision(expected_grant_revision, 'expected_grant_revision');
      const profileId = assertIdentifier(endpoint_profile_id, 'endpoint_profile_id');
      const configRevision = assertPositiveInteger(profile_revision, 'profile_revision');
      const grantedAt = now();
      assertTimestamp(expires_at, 'expires_at');
      return connection.write(database => {
        const member = requireMember(database, roomId, payerUserId);
        requireWritable(member);
        if (member.active_epoch_id !== epochId) {
          fail('STALE_ACTIVE_EPOCH', 'execution grant targets a non-active epoch', {}, 409);
        }
        const active = database.prepare(`
          SELECT * FROM model_execution_grants
           WHERE grant_id = ? AND grant_state = 'ACTIVE'
        `).get(grantId);
        if (expectedRevision === 0) {
          if (active || database.prepare(`
            SELECT 1 AS present FROM model_execution_grants WHERE grant_id = ?
          `).get(grantId)) {
            fail('EXECUTION_GRANT_ID_CONFLICT', 'execution grant ID is already in use', {}, 409);
          }
        } else {
          if (!active || active.payer_user_id !== payerUserId) {
            fail('EXECUTION_GRANT_NOT_FOUND', 'active execution grant does not exist', {}, 404);
          }
          if (active.grant_revision !== expectedRevision) {
            fail('STALE_GRANT_REVISION', 'execution grant revision changed', {}, 409);
          }
        }
        const profile = requireProfileRow(
          database,
          payerUserId,
          profileId,
          configRevision,
          { active: true }
        );
        assertProfileCredentialUsable(database, profile);
        if (authorization_scope?.kind === 'single_turn') {
          const turnId = assertIdentifier(authorization_scope.turn_id, 'authorization_scope.turn_id');
          requireTurn(database, { roomId, epochId, turnId });
        }
        const grant = assertExecutionGrant({
          schema: EXECUTION_GRANT_SCHEMA,
          grant_id: grantId,
          grant_revision: expectedRevision + 1,
          payer_user_id: payerUserId,
          room_id: roomId,
          epoch_id: epochId,
          profile_ref: profileRef(profile),
          stage_scopes,
          authorization_scope,
          budget,
          granted_at: grantedAt,
          expires_at,
          state: 'ACTIVE',
          revoked_at: null
        });
        if (active) {
          const changed = database.prepare(`
            UPDATE model_execution_grants
               SET grant_state = 'REVOKED', revoked_at = ?
             WHERE grant_id = ? AND grant_revision = ?
               AND payer_user_id = ? AND grant_state = 'ACTIVE'
          `).run(grantedAt, grantId, expectedRevision, payerUserId);
          if (changed.changes !== 1) fail('STALE_GRANT_REVISION', 'grant version CAS failed', {}, 409);
        }
        database.prepare(`
          INSERT INTO model_execution_grants (
            grant_id, grant_revision, payer_user_id, room_id, epoch_id,
            profile_id, profile_revision, credential_id, credential_revision,
            stage_scopes_json, authorization_scope_kind,
            authorization_turn_id, max_requests, max_input_tokens,
            max_output_tokens, max_retries, estimated_cost_currency,
            estimated_cost_amount_micros, granted_at, expires_at,
            grant_state, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL)
        `).run(
          grant.grant_id,
          grant.grant_revision,
          payerUserId,
          roomId,
          epochId,
          grant.profile_ref.profile_id,
          grant.profile_ref.config_revision,
          grant.profile_ref.credential_ref?.credential_id ?? null,
          grant.profile_ref.credential_ref?.credential_revision ?? null,
          canonicalStringify(grant.stage_scopes),
          grant.authorization_scope.kind,
          grant.authorization_scope.turn_id,
          ...budgetColumns(grant.budget),
          grant.granted_at,
          grant.expires_at
        );
        return immutable({
          grant: grantContract(grantRow(database, grantId, grant.grant_revision, payerUserId)),
          replayed: false
        });
      });
    },

    list({ authenticated_user_id, room_id, include_inactive = true }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      return connection.read(database => {
        requireMember(database, roomId, payerUserId);
        const rows = database.prepare(`
          SELECT g.*, p.normalized_origin, p.config_fingerprint
            FROM model_execution_grants AS g
            JOIN model_endpoint_profiles AS p
              ON p.profile_id = g.profile_id
             AND p.config_revision = g.profile_revision
             AND p.owner_user_id = g.payer_user_id
           WHERE g.room_id = ? AND g.payer_user_id = ?
             AND (? = 1 OR g.grant_state = 'ACTIVE')
           ORDER BY g.grant_id, g.grant_revision DESC
        `).all(roomId, payerUserId, include_inactive ? 1 : 0);
        return Object.freeze(rows.map(grantContract));
      });
    },

    async revoke({
      authenticated_user_id,
      room_id,
      grant_id,
      grant_revision
    }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const grantId = assertIdentifier(grant_id, 'grant_id');
      const revision = assertPositiveInteger(grant_revision, 'grant_revision');
      const revokedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, payerUserId);
        requireWritable(member);
        const existing = grantRow(database, grantId, revision, payerUserId);
        if (existing.room_id !== roomId) {
          fail('EXECUTION_GRANT_NOT_FOUND', 'execution grant does not belong to this room', {}, 404);
        }
        if (existing.grant_state === 'REVOKED') {
          return immutable({ grant: grantContract(existing), replayed: true });
        }
        if (existing.grant_state !== 'ACTIVE') {
          fail('EXECUTION_GRANT_STATE_CONFLICT', 'only an active grant can be revoked', {}, 409);
        }
        const changed = database.prepare(`
          UPDATE model_execution_grants
             SET grant_state = 'REVOKED', revoked_at = ?
           WHERE grant_id = ? AND grant_revision = ?
             AND payer_user_id = ? AND grant_state = 'ACTIVE'
        `).run(revokedAt, grantId, revision, payerUserId);
        if (changed.changes !== 1) fail('STALE_GRANT_REVISION', 'grant revoke CAS failed', {}, 409);
        return immutable({
          grant: grantContract(grantRow(database, grantId, revision, payerUserId)),
          replayed: false
        });
      });
    }
  });

  function normalizeDataCategories(value) {
    if (!Array.isArray(value)
      || value.length < 1
      || value.length > 32
      || new Set(value).size !== value.length) {
      fail('DATA_CONSENT_INPUT_INVALID', 'data categories must be a non-empty unique array');
    }
    const categories = value.map((category, index) => (
      assertString(category, `data_categories[${index}]`, { max: 160 })
    )).sort();
    return Object.freeze(categories);
  }

  function consentProjection(row) {
    return immutable({
      consent_id: row.consent_id,
      consent_series_id: row.consent_series_id,
      consent_revision: row.consent_revision,
      room_id: row.room_id,
      scope_epoch_id: row.scope_epoch_id,
      subject_user_id: row.subject_user_id,
      selection_hash: row.selection_hash,
      config_fingerprint: row.config_fingerprint,
      terms_revision: row.terms_revision,
      categories_hash: row.categories_hash,
      action: row.consent_action,
      supersedes_consent_id: row.supersedes_consent_id,
      recorded_at: row.recorded_at
    });
  }

  function requireConsent(database, consentId, subjectUserId) {
    const row = database.prepare(`
      SELECT * FROM data_processing_consents
       WHERE consent_id = ? AND subject_user_id = ?
    `).get(consentId, subjectUserId);
    if (!row) fail('DATA_CONSENT_NOT_FOUND', 'data-processing consent does not exist', {}, 404);
    return row;
  }

  function latestConsentSeriesRow(database, seriesId) {
    return database.prepare(`
      SELECT * FROM data_processing_consents
       WHERE consent_series_id = ?
       ORDER BY consent_revision DESC LIMIT 1
    `).get(seriesId);
  }

  const consents = Object.freeze({
    async grant({
      authenticated_user_id,
      room_id,
      epoch_id,
      selection_hash,
      config_fingerprint,
      terms_revision,
      data_categories
    }) {
      const subjectUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const selectionHashValue = assertHash(selection_hash, 'selection_hash');
      const configFingerprint = assertHash(config_fingerprint, 'config_fingerprint');
      const termsRevision = assertString(terms_revision, 'terms_revision', { max: 160 });
      const categories = normalizeDataCategories(data_categories);
      const categoriesHash = hashCanonical({
        schema: 'naruto.multiplayer-data-categories/v1',
        categories
      });
      const recordedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, subjectUserId);
        requireWritable(member);
        const selection = database.prepare(`
          SELECT s.selection_id
            FROM turn_model_selections AS s
            JOIN multiplayer_turns AS t ON t.turn_id = s.turn_id
           WHERE s.selection_hash = ? AND t.room_id = ? AND t.epoch_id = ?
        `).get(selectionHashValue, roomId, epochId);
        if (!selection) {
          fail('DATA_CONSENT_SELECTION_INVALID', 'selection hash does not belong to this room epoch', {}, 409);
        }
        const profile = database.prepare(`
          SELECT p.profile_id
            FROM model_endpoint_profiles AS p
            JOIN multiplayer_members AS m
              ON m.user_id = p.owner_user_id AND m.room_id = ?
             AND m.member_status = 'ACTIVE'
           WHERE p.config_fingerprint = ?
        `).get(roomId, configFingerprint);
        if (!profile) {
          fail('DATA_CONSENT_CONFIG_INVALID', 'model config is not owned by an active room member', {}, 409);
        }
        const prior = database.prepare(`
          SELECT * FROM data_processing_consents
           WHERE room_id = ? AND scope_epoch_id = ? AND subject_user_id = ?
             AND selection_hash = ? AND config_fingerprint = ?
             AND terms_revision = ? AND categories_hash = ?
           ORDER BY consent_revision DESC LIMIT 1
        `).get(
          roomId,
          epochId,
          subjectUserId,
          selectionHashValue,
          configFingerprint,
          termsRevision,
          categoriesHash
        );
        if (prior?.consent_action === 'GRANTED') {
          return immutable({ consent: consentProjection(prior), replayed: true });
        }
        const seriesId = prior?.consent_series_id ?? generatedId(idFactory, 'consent_series');
        const consentRevision = (prior?.consent_revision ?? 0) + 1;
        const consentId = generatedId(idFactory, 'consent');
        database.prepare(`
          INSERT INTO data_processing_consents (
            consent_id, consent_series_id, consent_revision, room_id,
            scope_epoch_id, subject_user_id, selection_hash,
            config_fingerprint, terms_revision, categories_hash,
            consent_action, supersedes_consent_id, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'GRANTED', ?, ?)
        `).run(
          consentId,
          seriesId,
          consentRevision,
          roomId,
          epochId,
          subjectUserId,
          selectionHashValue,
          configFingerprint,
          termsRevision,
          categoriesHash,
          prior?.consent_id ?? null,
          recordedAt
        );
        return immutable({
          consent: consentProjection(requireConsent(database, consentId, subjectUserId)),
          replayed: false
        });
      });
    },

    async revoke({ authenticated_user_id, room_id, consent_id }) {
      const subjectUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const consentId = assertIdentifier(consent_id, 'consent_id');
      const recordedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, subjectUserId);
        requireWritable(member);
        const target = requireConsent(database, consentId, subjectUserId);
        if (target.room_id !== roomId) {
          fail('DATA_CONSENT_NOT_FOUND', 'consent does not belong to this room', {}, 404);
        }
        const latest = latestConsentSeriesRow(database, target.consent_series_id);
        if (latest.consent_action === 'REVOKED') {
          return immutable({ consent: consentProjection(latest), replayed: true });
        }
        if (latest.consent_id !== target.consent_id) {
          fail('STALE_CONSENT_REVISION', 'consent target has already been superseded', {}, 409);
        }
        const revokeId = generatedId(idFactory, 'consent');
        database.prepare(`
          INSERT INTO data_processing_consents (
            consent_id, consent_series_id, consent_revision, room_id,
            scope_epoch_id, subject_user_id, selection_hash,
            config_fingerprint, terms_revision, categories_hash,
            consent_action, supersedes_consent_id, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REVOKED', ?, ?)
        `).run(
          revokeId,
          latest.consent_series_id,
          latest.consent_revision + 1,
          latest.room_id,
          latest.scope_epoch_id,
          latest.subject_user_id,
          latest.selection_hash,
          latest.config_fingerprint,
          latest.terms_revision,
          latest.categories_hash,
          latest.consent_id,
          recordedAt
        );
        return immutable({
          consent: consentProjection(requireConsent(database, revokeId, subjectUserId)),
          replayed: false
        });
      });
    },

    listActive({ authenticated_user_id, room_id, epoch_id }) {
      const subjectUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      return connection.read(database => {
        requireMember(database, roomId, subjectUserId);
        const rows = database.prepare(`
          SELECT c.*
            FROM data_processing_consents AS c
            JOIN (
              SELECT consent_series_id, MAX(consent_revision) AS latest_revision
                FROM data_processing_consents
               GROUP BY consent_series_id
            ) AS latest
              ON latest.consent_series_id = c.consent_series_id
             AND latest.latest_revision = c.consent_revision
           WHERE c.room_id = ? AND c.scope_epoch_id = ?
             AND c.subject_user_id = ? AND c.consent_action = 'GRANTED'
           ORDER BY c.recorded_at, c.consent_id
        `).all(roomId, epochId, subjectUserId);
        return Object.freeze(rows.map(consentProjection));
      });
    }
  });

  function scopeKey(stage, audience) {
    return `${stage}:${audience ?? 'shared'}`;
  }

  function requiredPlanScopes(narrativeMode) {
    return [
      ...SHARED_STAGES.map(stage => scopeKey(stage, null)),
      ...(narrativeMode === 'shared'
        ? [scopeKey('writer', null)]
        : [scopeKey('writer', 'A'), scopeKey('writer', 'B')])
    ].sort();
  }

  function assertCompleteStageSet(plan) {
    const actual = plan.stage_plans.map(item => scopeKey(item.stage, item.audience)).sort();
    const expected = requiredPlanScopes(plan.narrative_mode);
    if (new Set(actual).size !== actual.length
      || canonicalStringify(actual) !== canonicalStringify(expected)) {
      fail('BILLING_PLAN_STAGE_SET_INVALID', 'billing plan must contain every required stage exactly once', {
        expected,
        actual
      });
    }
  }

  function assertPlanItemAuthority(database, roomId, epochId, turn, item) {
    const membership = database.prepare(`
      SELECT seat_id FROM multiplayer_members
       WHERE room_id = ? AND user_id = ? AND member_status = 'ACTIVE'
    `).get(roomId, item.payer_user_id);
    if (!membership || membership.seat_id !== item.payer_seat) {
      fail('BILLING_PLAN_PAYER_INVALID', 'plan item payer is not the authoritative room member');
    }
    const profile = requireProfileRow(
      database,
      item.payer_user_id,
      item.profile_ref.profile_id,
      item.profile_ref.config_revision,
      { active: true }
    );
    assertProfileCredentialUsable(database, profile);
    const authoritativeRef = profileRef(profile);
    if (canonicalStringify(authoritativeRef) !== canonicalStringify(item.profile_ref)) {
      fail('BILLING_PLAN_PROFILE_MISMATCH', 'plan item profile reference is not authoritative');
    }
    if (item.capability_probe_ref !== null) {
      const probe = database.prepare(`
        SELECT * FROM model_capability_probes
         WHERE profile_id = ? AND profile_revision = ? AND probe_revision = ?
           AND profile_owner_user_id = ? AND probe_status = 'SUCCEEDED'
           AND ((credential_id IS NULL AND ? IS NULL)
             OR (credential_id = ? AND credential_revision = ?))
      `).get(
        item.profile_ref.profile_id,
        item.profile_ref.config_revision,
        item.capability_probe_ref.probe_revision,
        item.payer_user_id,
        profile.credential_id,
        profile.credential_id,
        profile.credential_revision
      );
      if (!probe || probe.probe_hash !== item.capability_probe_ref.probe_hash) {
        fail('BILLING_PLAN_PROBE_MISMATCH', 'plan item does not reference a successful exact-profile probe');
      }
      if (item.transport === 'native_tools' && probe.recommended_transport !== 'native_tools') {
        const result = parseJson(probe.probe_result_json, 'capability probe result');
        if (result.capabilities?.native_tools !== true) {
          fail('BILLING_PLAN_TRANSPORT_INVALID', 'native-tools transport was not capability-probed');
        }
      }
      if (item.transport === 'json_protocol') {
        const result = parseJson(probe.probe_result_json, 'capability probe result');
        if (!(result.capabilities?.strict_json === true
          && result.capabilities?.error_correction_continuation === true)) {
          fail('BILLING_PLAN_TRANSPORT_INVALID', 'JSON continuation capabilities were not demonstrated');
        }
      }
    } else if (item.transport === 'native_tools') {
      fail(
        'BILLING_PLAN_TRANSPORT_INVALID',
        'native-tools transport requires an explicit legacy capability reference'
      );
    }
    const expectedConsentSubjects = requiredConsentSubjectUserIds(roomMembers(database, roomId), {
      audience: item.audience,
      payerUserId: item.payer_user_id,
      endpointOwnerUserId: profile.owner_user_id
    });
    if (!sameConsentSubjectSet(
      item.required_consent_subject_user_ids,
      expectedConsentSubjects
    )) {
      fail(
        'BILLING_PLAN_CONSENT_SUBJECT_MISMATCH',
        'plan item consent subjects do not match its audience, payer, and endpoint owner',
        {
          plan_item_id: item.plan_item_id,
          expected_subject_user_ids: expectedConsentSubjects
        }
      );
    }
    if (turn.epoch_id !== epochId) fail('BILLING_PLAN_EPOCH_MISMATCH', 'plan turn epoch changed');
    return profile;
  }

  function assertInitialPlanMatchesSelections(database, turn, plan) {
    const rows = selectionRows(database, turn.turn_id);
    if (!selectionReadiness(turn, rows)) {
      fail('AWAITING_PAYER_SELECTION', 'all model selections must be ready before billing-plan creation');
    }
    const shared = rows.find(row => row.scope === 'shared' && row.audience === 'shared');
    if (plan.turn_payer_selection_hash !== shared.selection_hash) {
      fail('BILLING_PLAN_SELECTION_MISMATCH', 'shared selection hash changed');
    }
    if (turn.narrative_mode === 'dual_pov') {
      for (const audience of ROOM_SEATS) {
        const writer = rows.find(row => row.scope === 'writer' && row.audience === audience);
        if (plan.pov_writer_selection_hashes[audience] !== writer.selection_hash) {
          fail('BILLING_PLAN_SELECTION_MISMATCH', `Writer ${audience} selection hash changed`);
        }
      }
    }
    for (const item of plan.stage_plans) {
      const selection = item.stage === 'writer' && item.audience !== null
        ? rows.find(row => row.scope === 'writer' && row.audience === item.audience)
        : shared;
      const profile = selectionProfileRow(database, selection);
      if (item.payer_user_id !== selection.payer_user_id
        || item.payer_seat !== selection.payer_seat_id
        || item.profile_ref.profile_id !== selection.profile_id
        || item.profile_ref.config_revision !== selection.profile_revision
        || item.profile_ref.config_fingerprint !== profile.config_fingerprint
        || canonicalStringify(item.profile_ref.credential_ref)
          !== canonicalStringify(profileRef(profile).credential_ref)) {
        fail('BILLING_PLAN_SELECTION_MISMATCH', 'plan item does not match its frozen selection', {
          plan_item_id: item.plan_item_id
        });
      }
    }
  }

  function nextPlanRevision(database, turnId) {
    return database.prepare(`
      SELECT COALESCE(MAX(plan_revision), 0) + 1 AS next_revision
        FROM turn_billing_plans WHERE turn_id = ?
    `).get(turnId).next_revision;
  }

  function planForMember(database, roomId, authenticatedUserId, planHash) {
    requireMember(database, roomId, authenticatedUserId);
    const row = planRowByHash(database, planHash);
    const turn = requireTurn(database, { roomId, turnId: row.turn_id });
    return { row, turn, plan: planContract(row) };
  }

  function reservedBudgetForGrant(database, payerUserId, grantId, grantRevision) {
    const totals = { requests: 0, input_tokens: 0, output_tokens: 0, retries: 0 };
    const rows = database.prepare(`
      SELECT accepted_budget_json FROM turn_billing_authorizations
       WHERE payer_user_id = ? AND grant_id = ? AND grant_revision = ?
    `).all(payerUserId, grantId, grantRevision);
    for (const row of rows) {
      const accepted = parseJson(row.accepted_budget_json, 'accepted billing budget');
      for (const budget of Object.values(accepted.item_budgets)) {
        totals.requests += budget.max_requests;
        totals.input_tokens += budget.max_input_tokens;
        totals.output_tokens += budget.max_output_tokens;
        totals.retries += budget.max_retries;
      }
    }
    return totals;
  }

  function appendInitialPlanInDatabase(database, {
    authenticatedUserId,
    roomId,
    epochId,
    turnId,
    stagePlans,
    createdAt
  }) {
    const member = requireMember(database, roomId, authenticatedUserId);
    requireWritable(member);
    const turn = requireTurn(database, { roomId, epochId, turnId });
    const actionCount = activeActionCount(database, turnId);
    if (actionCount !== 2 || ![
      'SEALED',
      'AWAITING_BILLING_AUTHORIZATION',
      'RESOLVING',
      'RENDERING',
      'STAGING_UPDATES',
      'AUDITING',
      'REPAIRING_DRAFT',
      'RENDERING_REPAIR',
      'REPAIR_PAUSED'
    ].includes(turn.turn_status)) {
      fail('INVALID_TURN_STATE', 'initial billing plan requires two locked actions', {
        turn_status: turn.turn_status,
        action_count: actionCount
      }, 409);
    }
    const revision = nextPlanRevision(database, turnId);
    if (revision !== 1) {
      const existingRow = database.prepare(`
        SELECT * FROM turn_billing_plans
         WHERE turn_id = ? AND plan_revision = 1
      `).get(turnId);
      const existingPlan = existingRow ? planContract(existingRow) : null;
      if (existingPlan
        && canonicalStringify(existingPlan.stage_plans) === canonicalStringify(stagePlans)) {
        return immutable({ plan: existingPlan, replayed: true });
      }
      fail('BILLING_PLAN_APPEND_ONLY', 'later plan revisions must be applied through an amendment', {}, 409);
    }
    const rows = selectionRows(database, turnId);
    const shared = rows.find(row => row.scope === 'shared');
    const writer = Object.fromEntries(ROOM_SEATS.map(audience => [
      audience,
      rows.find(row => row.scope === 'writer' && row.audience === audience)
    ]));
    const draft = {
      schema: TURN_BILLING_PLAN_SCHEMA,
      turn_id: turnId,
      plan_revision: 1,
      narrative_mode: turn.narrative_mode,
      turn_payer_selection_hash: shared?.selection_hash,
      pov_writer_selection_hashes: turn.narrative_mode === 'shared'
        ? null
        : {
            A: writer.A?.selection_hash,
            B: writer.B?.selection_hash
          },
      stage_plans: stagePlans,
      plan_hash: `sha256:${'0'.repeat(64)}`,
      created_at: createdAt
    };
    draft.plan_hash = computeTurnBillingPlanHash(draft);
    const plan = assertTurnBillingPlan(draft);
    assertCompleteStageSet(plan);
    assertInitialPlanMatchesSelections(database, turn, plan);
    for (const item of plan.stage_plans) {
      assertPlanItemAuthority(database, roomId, epochId, turn, item);
    }
    const existing = database.prepare(`
      SELECT * FROM turn_billing_plans WHERE plan_hash = ?
    `).get(plan.plan_hash);
    if (existing) {
      return immutable({ plan: planContract(existing), replayed: true });
    }
    insertPlan(database, plan, generatedId(idFactory, 'billing_plan'));
    database.prepare(`
      UPDATE multiplayer_turns
         SET turn_status = 'AWAITING_BILLING_AUTHORIZATION', updated_at = ?
       WHERE turn_id = ? AND turn_status = 'SEALED'
    `).run(createdAt, turnId);
    return immutable({ plan, replayed: false });
  }

  const plans = Object.freeze({
    appendInTransaction({
      database,
      authenticated_user_id,
      room_id,
      epoch_id,
      turn_id,
      stage_plans,
      created_at = now()
    }) {
      if (!database || typeof database.prepare !== 'function') {
        fail('BILLING_REPOSITORY_CONFIGURATION_INVALID', 'a synchronous SQLite database is required');
      }
      return appendInitialPlanInDatabase(database, {
        authenticatedUserId: assertPrincipal(authenticated_user_id),
        roomId: assertIdentifier(room_id, 'room_id'),
        epochId: assertIdentifier(epoch_id, 'epoch_id'),
        turnId: assertIdentifier(turn_id, 'turn_id'),
        stagePlans: stage_plans,
        createdAt: assertTimestamp(created_at, 'created_at')
      });
    },

    async append({
      authenticated_user_id,
      room_id,
      epoch_id,
      turn_id,
      stage_plans
    }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const epochId = assertIdentifier(epoch_id, 'epoch_id');
      const turnId = assertIdentifier(turn_id, 'turn_id');
      const createdAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, userId);
        requireWritable(member);
        const turn = requireTurn(database, { roomId, epochId, turnId });
        const actionCount = activeActionCount(database, turnId);
        if (actionCount !== 2 || ![
          'SEALED',
          'AWAITING_BILLING_AUTHORIZATION',
          'RESOLVING',
          'RENDERING',
          'STAGING_UPDATES',
          'AUDITING',
          'REPAIRING_DRAFT',
          'RENDERING_REPAIR',
          'REPAIR_PAUSED'
        ].includes(turn.turn_status)) {
          fail('INVALID_TURN_STATE', 'initial billing plan requires two locked actions', {
            turn_status: turn.turn_status,
            action_count: actionCount
          }, 409);
        }
        const revision = nextPlanRevision(database, turnId);
        if (revision !== 1) {
          const existingRow = database.prepare(`
            SELECT * FROM turn_billing_plans
             WHERE turn_id = ? AND plan_revision = 1
          `).get(turnId);
          const existingPlan = existingRow ? planContract(existingRow) : null;
          if (existingPlan
            && canonicalStringify(existingPlan.stage_plans) === canonicalStringify(stage_plans)) {
            return immutable({ plan: existingPlan, replayed: true });
          }
          fail('BILLING_PLAN_APPEND_ONLY', 'later plan revisions must be applied through an amendment', {}, 409);
        }
        const rows = selectionRows(database, turnId);
        const shared = rows.find(row => row.scope === 'shared');
        const writer = Object.fromEntries(ROOM_SEATS.map(audience => [
          audience,
          rows.find(row => row.scope === 'writer' && row.audience === audience)
        ]));
        const draft = {
          schema: TURN_BILLING_PLAN_SCHEMA,
          turn_id: turnId,
          plan_revision: 1,
          narrative_mode: turn.narrative_mode,
          turn_payer_selection_hash: shared?.selection_hash,
          pov_writer_selection_hashes: turn.narrative_mode === 'shared'
            ? null
            : {
                A: writer.A?.selection_hash,
                B: writer.B?.selection_hash
              },
          stage_plans,
          plan_hash: `sha256:${'0'.repeat(64)}`,
          created_at: createdAt
        };
        draft.plan_hash = computeTurnBillingPlanHash(draft);
        const plan = assertTurnBillingPlan(draft);
        assertCompleteStageSet(plan);
        assertInitialPlanMatchesSelections(database, turn, plan);
        for (const item of plan.stage_plans) {
          assertPlanItemAuthority(database, roomId, epochId, turn, item);
        }
        const existing = database.prepare(`
          SELECT * FROM turn_billing_plans WHERE plan_hash = ?
        `).get(plan.plan_hash);
        if (existing) {
          return immutable({ plan: planContract(existing), replayed: true });
        }
        insertPlan(database, plan, generatedId(idFactory, 'billing_plan'));
        database.prepare(`
          UPDATE multiplayer_turns
             SET turn_status = 'AWAITING_BILLING_AUTHORIZATION', updated_at = ?
           WHERE turn_id = ? AND turn_status = 'SEALED'
        `).run(createdAt, turnId);
        return immutable({ plan, replayed: false });
      });
    },

    get({ authenticated_user_id, room_id, plan_hash }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const planHash = assertHash(plan_hash, 'plan_hash');
      return connection.read(database => planForMember(database, roomId, userId, planHash).plan);
    },

    getLatest({ authenticated_user_id, room_id, turn_id }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const turnId = assertIdentifier(turn_id, 'turn_id');
      return connection.read(database => {
        requireMember(database, roomId, userId);
        requireTurn(database, { roomId, turnId });
        const row = database.prepare(`
          SELECT * FROM turn_billing_plans
           WHERE turn_id = ? ORDER BY plan_revision DESC LIMIT 1
        `).get(turnId);
        return row ? planContract(row) : null;
      });
    },

    async authorize({
      authenticated_user_id,
      room_id,
      plan_hash,
      grant_id,
      grant_revision
    }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const planHash = assertHash(plan_hash, 'plan_hash');
      const grantId = assertIdentifier(grant_id, 'grant_id');
      const grantRevision = assertPositiveInteger(grant_revision, 'grant_revision');
      const acceptedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, payerUserId);
        requireWritable(member);
        const { turn, plan } = planForMember(database, roomId, payerUserId, planHash);
        const payerItems = plan.stage_plans.filter(item => item.payer_user_id === payerUserId);
        if (!payerItems.length) {
          fail('PAYER_SELF_REQUIRED', 'authenticated member has no payable item in this plan', {}, 403);
        }
        const existing = database.prepare(`
          SELECT * FROM turn_billing_authorizations
           WHERE plan_hash = ? AND payer_user_id = ?
        `).get(planHash, payerUserId);
        if (existing) {
          if (existing.grant_id !== grantId || existing.grant_revision !== grantRevision) {
            fail('BILLING_AUTHORIZATION_CONFLICT', 'payer already authorized this plan with another grant', {}, 409);
          }
          advanceAuthorizedPlanToResolution(database, {
            roomId,
            turn,
            plan,
            advancedAt: acceptedAt,
            idFactory
          });
          return immutable({
            authorization_id: existing.billing_authorization_id,
            plan_hash: planHash,
            payer_user_id: payerUserId,
            grant_id: grantId,
            grant_revision: grantRevision,
            accepted_budget: parseJson(existing.accepted_budget_json, 'accepted billing budget'),
            accepted_at: existing.accepted_at,
            replayed: true
          });
        }
        const row = grantRow(database, grantId, grantRevision, payerUserId);
        const grant = grantContract(row);
        for (const item of payerItems) {
          assertExecutionGrantUsable(grant, {
            now: acceptedAt,
            payer_user_id: payerUserId,
            room_id: roomId,
            epoch_id: turn.epoch_id,
            turn_id: turn.turn_id,
            stage: item.stage,
            audience: item.audience,
            profile_ref: item.profile_ref
          });
        }
        const requestedBudget = payerItems.reduce((total, item) => ({
          requests: total.requests + item.budget.max_requests,
          input_tokens: total.input_tokens + item.budget.max_input_tokens,
          output_tokens: total.output_tokens + item.budget.max_output_tokens,
          retries: total.retries + item.budget.max_retries
        }), { requests: 0, input_tokens: 0, output_tokens: 0, retries: 0 });
        const reservedBudget = reservedBudgetForGrant(
          database,
          payerUserId,
          grantId,
          grantRevision
        );
        assertExecutionGrantUsable(grant, {
          now: acceptedAt,
          room_id: roomId,
          epoch_id: turn.epoch_id,
          turn_id: turn.turn_id,
          profile_ref: grant.profile_ref,
          consumed_budget: reservedBudget,
          requested_budget: requestedBudget
        });
        const acceptedBudget = immutable({
          schema: 'naruto.multiplayer-accepted-plan-budget/v1',
          plan_revision: plan.plan_revision,
          plan_item_ids: payerItems.map(item => item.plan_item_id).sort(),
          item_budgets: Object.fromEntries(payerItems.map(item => [item.plan_item_id, item.budget]))
        });
        const authorizationId = generatedId(idFactory, 'billing_authorization');
        database.prepare(`
          INSERT INTO turn_billing_authorizations (
            billing_authorization_id, plan_hash, payer_user_id,
            grant_id, grant_revision, accepted_budget_json, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          authorizationId,
          planHash,
          payerUserId,
          grantId,
          grantRevision,
          canonicalStringify(acceptedBudget),
          acceptedAt
        );
        advanceAuthorizedPlanToResolution(database, {
          roomId,
          turn,
          plan,
          advancedAt: acceptedAt,
          idFactory
        });
        return immutable({
          authorization_id: authorizationId,
          plan_hash: planHash,
          payer_user_id: payerUserId,
          grant_id: grantId,
          grant_revision: grantRevision,
          accepted_budget: acceptedBudget,
          accepted_at: acceptedAt,
          replayed: false
        });
      });
    },

    async recoverAuthorizedPause({ run_id, paused_at }) {
      const runId = assertIdentifier(run_id, 'run_id');
      const pausedAt = assertTimestamp(paused_at, 'paused_at');
      const recoveredAt = now();
      return connection.write(database => {
        const joined = database.prepare(`
          SELECT r.run_id, r.run_status, r.room_id, r.turn_id,
                 t.*
            FROM resolution_runs AS r
            JOIN multiplayer_turns AS t ON t.turn_id = r.turn_id
           WHERE r.run_id = ?
        `).get(runId);
        if (!joined) fail('RUN_NOT_FOUND', 'resolution run does not exist', {}, 404);
        if (joined.run_status !== 'PAUSED'
          || joined.turn_status !== 'AWAITING_BILLING_AUTHORIZATION') {
          return null;
        }
        const planRow = database.prepare(`
          SELECT * FROM turn_billing_plans
           WHERE turn_id = ? ORDER BY plan_revision DESC LIMIT 1
        `).get(joined.turn_id);
        if (!planRow) fail('BILLING_PLAN_NOT_FOUND', 'paused run has no billing plan', {}, 404);
        return advanceAuthorizedPlanToResolution(database, {
          roomId: joined.room_id,
          turn: joined,
          plan: planContract(planRow),
          advancedAt: recoveredAt,
          authorizationAcceptedAfter: pausedAt,
          idFactory
        });
      });
    }
  });

  function amendmentProjection(row) {
    const payload = parseJson(row.future_stage_changes_json, 'billing amendment changes');
    return immutable({
      amendment_id: row.amendment_id,
      turn_id: row.turn_id,
      prior_plan_hash: row.prior_plan_hash,
      new_plan_hash: row.new_plan_hash,
      amendment_revision: row.amendment_revision,
      future_stage_changes: payload.changes,
      proposed_plan: payload.proposed_plan,
      required_acceptances: parseJson(
        row.required_acceptances_json,
        'billing amendment required acceptances'
      ),
      accepted_subjects: parseJson(
        row.accepted_subjects_json,
        'billing amendment accepted subjects'
      ),
      status: row.amendment_status,
      created_at: row.created_at,
      applied_at: row.applied_at
    });
  }

  function requireAmendment(database, amendmentId) {
    const row = database.prepare(`
      SELECT * FROM turn_billing_amendments WHERE amendment_id = ?
    `).get(amendmentId);
    if (!row) fail('BILLING_AMENDMENT_NOT_FOUND', 'billing amendment does not exist', {}, 404);
    return row;
  }

  function assertStagesAmendable(database, turnId, changes) {
    for (const change of changes) {
      const item = change.replacement;
      const audience = item.audience ?? 'shared';
      const blocked = database.prepare(`
        SELECT usage_status FROM ai_usage_ledger
         WHERE turn_id = ? AND stage = ? AND audience = ?
           AND usage_status IN ('IN_FLIGHT', 'UNKNOWN')
         LIMIT 1
      `).get(turnId, item.stage, audience);
      if (blocked) {
        fail('BILLING_AMENDMENT_STAGE_FROZEN', 'an unresolved invocation blocks this stage amendment', {
          stage: item.stage,
          audience: item.audience,
          usage_status: blocked.usage_status
        }, 409);
      }
      let adopted = false;
      if (['referee', 'resolution_repair', 'resolution_completeness_reviewer'].includes(item.stage)) {
        adopted = Boolean(database.prepare(`
          SELECT 1 AS present FROM canonical_resolutions WHERE turn_id = ?
        `).get(turnId));
      } else if (['writer', 'narrative_grounding_reviewer'].includes(item.stage)) {
        adopted = Boolean(database.prepare(`
          SELECT 1 AS present FROM narrative_deliveries
           WHERE turn_id = ? AND (? = 'shared' OR audience = ?)
           LIMIT 1
        `).get(turnId, audience, audience));
      } else if (['continuity_steward', 'continuity_repair'].includes(item.stage)) {
        adopted = Boolean(database.prepare(`
          SELECT 1 AS present FROM turn_drafts
           WHERE turn_id = ? AND draft_status = 'READY'
        `).get(turnId));
      }
      if (adopted) {
        fail('BILLING_AMENDMENT_STAGE_FROZEN', 'an adopted stage output blocks this amendment', {
          stage: item.stage,
          audience: item.audience,
          usage_status: 'ADOPTED'
        }, 409);
      }
    }
  }

  const amendments = Object.freeze({
    get({ authenticated_user_id, room_id, amendment_id }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const amendmentId = assertIdentifier(amendment_id, 'amendment_id');
      return connection.read(database => {
        requireMember(database, roomId, userId);
        const row = requireAmendment(database, amendmentId);
        requireTurn(database, { roomId, turnId: row.turn_id });
        return amendmentProjection(row);
      });
    },

    async propose({
      authenticated_user_id,
      room_id,
      prior_plan_hash,
      future_stage_changes
    }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const priorPlanHash = assertHash(prior_plan_hash, 'prior_plan_hash');
      if (!Array.isArray(future_stage_changes)
        || future_stage_changes.length < 1
        || future_stage_changes.some(change => (
          !change || typeof change !== 'object' || Array.isArray(change)
          || typeof change.plan_item_id !== 'string'
          || !change.replacement
        ))) {
        fail('BILLING_AMENDMENT_INVALID', 'future stage changes are invalid');
      }
      const createdAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, userId);
        requireWritable(member);
        const { turn, plan: priorPlan } = planForMember(database, roomId, userId, priorPlanHash);
        const latest = database.prepare(`
          SELECT plan_hash FROM turn_billing_plans
           WHERE turn_id = ? ORDER BY plan_revision DESC LIMIT 1
        `).get(turn.turn_id);
        if (latest.plan_hash !== priorPlanHash) {
          fail('STALE_BILLING_PLAN', 'amendment must target the latest applied plan', {}, 409);
        }
        const seen = new Set();
        const stagePlans = priorPlan.stage_plans.map(item => {
          const change = future_stage_changes.find(candidate => candidate.plan_item_id === item.plan_item_id);
          if (!change) return item;
          if (seen.has(change.plan_item_id)) {
            fail('BILLING_AMENDMENT_INVALID', 'plan item is changed more than once');
          }
          seen.add(change.plan_item_id);
          const replacement = canonicalizeJson(change.replacement);
          if (replacement.plan_item_id !== item.plan_item_id
            || replacement.stage !== item.stage
            || replacement.audience !== item.audience) {
            fail('BILLING_AMENDMENT_SCOPE_INVALID', 'amendment cannot change a plan item scope');
          }
          return replacement;
        });
        if (seen.size !== future_stage_changes.length) {
          fail('BILLING_AMENDMENT_INVALID', 'amendment references an unknown plan item');
        }
        const proposed = {
          ...priorPlan,
          plan_revision: nextPlanRevision(database, turn.turn_id),
          stage_plans: stagePlans,
          plan_hash: `sha256:${'0'.repeat(64)}`,
          created_at: createdAt
        };
        proposed.plan_hash = computeTurnBillingPlanHash(proposed);
        const proposedPlan = assertTurnBillingPlan(proposed);
        assertCompleteStageSet(proposedPlan);
        for (const item of proposedPlan.stage_plans) {
          assertPlanItemAuthority(database, roomId, turn.epoch_id, turn, item);
        }
        const normalizedChanges = future_stage_changes.map(change => ({
          plan_item_id: change.plan_item_id,
          replacement: proposedPlan.stage_plans.find(item => item.plan_item_id === change.plan_item_id)
        }));
        assertStagesAmendable(database, turn.turn_id, normalizedChanges);
        const required = [...new Set(normalizedChanges.flatMap(change => [
          change.replacement.payer_user_id,
          ...change.replacement.required_consent_subject_user_ids
        ]))].sort();
        const accepted = required.includes(userId) ? [userId] : [];
        const status = accepted.length === required.length ? 'ACCEPTED' : 'PROPOSED';
        const amendmentId = generatedId(idFactory, 'amendment');
        const revision = database.prepare(`
          SELECT COALESCE(MAX(amendment_revision), 0) + 1 AS next_revision
            FROM turn_billing_amendments WHERE turn_id = ?
        `).get(turn.turn_id).next_revision;
        database.prepare(`
          INSERT INTO turn_billing_amendments (
            amendment_id, turn_id, prior_plan_hash, new_plan_hash,
            amendment_revision, future_stage_changes_json,
            required_acceptances_json, accepted_subjects_json,
            amendment_status, created_at, applied_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          amendmentId,
          turn.turn_id,
          priorPlanHash,
          proposedPlan.plan_hash,
          revision,
          canonicalStringify({ changes: normalizedChanges, proposed_plan: proposedPlan }),
          canonicalStringify(required),
          canonicalStringify(accepted),
          status,
          createdAt
        );
        return immutable({
          amendment: amendmentProjection(requireAmendment(database, amendmentId)),
          replayed: false
        });
      });
    },

    async accept({ authenticated_user_id, room_id, amendment_id }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const amendmentId = assertIdentifier(amendment_id, 'amendment_id');
      return connection.write(database => {
        const member = requireMember(database, roomId, userId);
        requireWritable(member);
        const row = requireAmendment(database, amendmentId);
        requireTurn(database, { roomId, turnId: row.turn_id });
        if (!['PROPOSED', 'ACCEPTED'].includes(row.amendment_status)) {
          fail('BILLING_AMENDMENT_STATE_CONFLICT', 'amendment can no longer be accepted', {}, 409);
        }
        const required = parseJson(row.required_acceptances_json, 'required amendment acceptances');
        const accepted = parseJson(row.accepted_subjects_json, 'accepted amendment subjects');
        if (!required.includes(userId)) {
          fail('BILLING_AMENDMENT_ACCEPTANCE_FORBIDDEN', 'authenticated member is not a required accepter', {}, 403);
        }
        if (accepted.includes(userId)) {
          return immutable({ amendment: amendmentProjection(row), replayed: true });
        }
        const nextAccepted = [...accepted, userId].sort();
        const status = nextAccepted.length === required.length ? 'ACCEPTED' : 'PROPOSED';
        database.prepare(`
          UPDATE turn_billing_amendments
             SET accepted_subjects_json = ?, amendment_status = ?
           WHERE amendment_id = ? AND amendment_status IN ('PROPOSED', 'ACCEPTED')
        `).run(canonicalStringify(nextAccepted), status, amendmentId);
        return immutable({
          amendment: amendmentProjection(requireAmendment(database, amendmentId)),
          replayed: false
        });
      });
    },

    async apply({ authenticated_user_id, room_id, amendment_id }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const amendmentId = assertIdentifier(amendment_id, 'amendment_id');
      const appliedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, userId);
        requireWritable(member);
        const row = requireAmendment(database, amendmentId);
        const turn = requireTurn(database, { roomId, turnId: row.turn_id });
        if (row.amendment_status === 'APPLIED') {
          return immutable({
            amendment: amendmentProjection(row),
            plan: planContract(planRowByHash(database, row.new_plan_hash)),
            replayed: true
          });
        }
        if (row.amendment_status !== 'ACCEPTED') {
          fail('BILLING_AMENDMENT_ACCEPTANCE_REQUIRED', 'all required subjects must accept first', {}, 409);
        }
        const latest = database.prepare(`
          SELECT plan_hash FROM turn_billing_plans
           WHERE turn_id = ? ORDER BY plan_revision DESC LIMIT 1
        `).get(turn.turn_id);
        if (latest.plan_hash !== row.prior_plan_hash) {
          fail('STALE_BILLING_PLAN', 'another plan revision was applied first', {}, 409);
        }
        const payload = parseJson(row.future_stage_changes_json, 'billing amendment changes');
        const plan = assertTurnBillingPlan(payload.proposed_plan);
        if (plan.plan_hash !== row.new_plan_hash
          || computeTurnBillingPlanHash(plan) !== plan.plan_hash
          || plan.plan_revision !== nextPlanRevision(database, turn.turn_id)) {
          fail('BILLING_AMENDMENT_CORRUPT', 'proposed amendment plan no longer matches its hash/revision');
        }
        assertStagesAmendable(database, turn.turn_id, payload.changes);
        insertPlan(database, plan, generatedId(idFactory, 'billing_plan'));
        const changed = database.prepare(`
          UPDATE turn_billing_amendments
             SET amendment_status = 'APPLIED', applied_at = ?
           WHERE amendment_id = ? AND amendment_status = 'ACCEPTED'
        `).run(appliedAt, amendmentId);
        if (changed.changes !== 1) fail('BILLING_AMENDMENT_STATE_CONFLICT', 'amendment apply CAS failed', {}, 409);
        return immutable({
          amendment: amendmentProjection(requireAmendment(database, amendmentId)),
          plan,
          replayed: false
        });
      });
    }
  });

  function usageProjection(row) {
    return immutable({
      invocation_id: row.invocation_id,
      turn_id: row.turn_id,
      plan_hash: row.plan_hash,
      payer_user_id: row.payer_user_id,
      stage: row.stage,
      audience: row.audience,
      attempt: row.attempt,
      provider_request_id: row.provider_request_id,
      request_count: row.request_count,
      reserved_input_tokens: row.reserved_input_tokens,
      reserved_output_tokens: row.reserved_output_tokens,
      reserved_retry_count: row.reserved_retry_count,
      budget_charge_state: row.budget_charge_state,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      estimated_cost: row.estimated_cost_currency === null
        ? null
        : {
            currency: row.estimated_cost_currency,
            amount_micros: row.estimated_cost_amount_micros
          },
      status: row.usage_status,
      started_at: row.started_at,
      completed_at: row.completed_at
    });
  }

  function requireUsage(database, invocationId) {
    const row = database.prepare(`
      SELECT u.*, t.room_id, t.epoch_id
        FROM ai_usage_ledger AS u
        JOIN multiplayer_turns AS t ON t.turn_id = u.turn_id
       WHERE u.invocation_id = ?
    `).get(invocationId);
    if (!row) fail('MODEL_INVOCATION_NOT_FOUND', 'model invocation does not exist', {}, 404);
    return row;
  }

  function requireUsagePayer(database, invocationId, payerUserId, roomId) {
    requireMember(database, roomId, payerUserId);
    const row = requireUsage(database, invocationId);
    if (row.room_id !== roomId || row.payer_user_id !== payerUserId) {
      fail('MODEL_INVOCATION_NOT_FOUND', 'model invocation is not owned by this payer', {}, 404);
    }
    return row;
  }

  function normalizeUsageCompletion({
    provider_request_id = null,
    input_tokens = null,
    output_tokens = null,
    estimated_cost = null
  }) {
    if (provider_request_id !== null) {
      assertString(provider_request_id, 'provider_request_id', { max: 512 });
    }
    if (input_tokens !== null) assertRevision(input_tokens, 'input_tokens');
    if (output_tokens !== null) assertRevision(output_tokens, 'output_tokens');
    if (estimated_cost !== null) {
      if (!estimated_cost || typeof estimated_cost !== 'object' || Array.isArray(estimated_cost)) {
        fail('REPOSITORY_INPUT_INVALID', 'estimated_cost must be an object or null');
      }
      if (!/^[A-Z]{3}$/u.test(estimated_cost.currency)) {
        fail('REPOSITORY_INPUT_INVALID', 'estimated cost currency must be an ISO-style code');
      }
      assertRevision(estimated_cost.amount_micros, 'estimated_cost.amount_micros');
    }
    return {
      providerRequestId: provider_request_id,
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      estimatedCostCurrency: estimated_cost?.currency ?? null,
      estimatedCostAmountMicros: estimated_cost?.amount_micros ?? null
    };
  }

  function completionMatches(row, completion) {
    return row.provider_request_id === completion.providerRequestId
      && row.input_tokens === completion.inputTokens
      && row.output_tokens === completion.outputTokens
      && row.estimated_cost_currency === completion.estimatedCostCurrency
      && row.estimated_cost_amount_micros === completion.estimatedCostAmountMicros;
  }

  const usage = Object.freeze({
    async start({
      authenticated_user_id,
      room_id,
      plan_hash,
      stage,
      audience = null,
      attempt,
      invocation_id = null,
      reserved_input_tokens = null,
      reserved_output_tokens = null
    }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const planHash = assertHash(plan_hash, 'plan_hash');
      if (!BILLABLE_MODEL_STAGES.includes(stage)) {
        fail('REPOSITORY_INPUT_INVALID', 'model stage is not billable');
      }
      if (audience !== null && !ROOM_SEATS.includes(audience)) {
        fail('REPOSITORY_INPUT_INVALID', 'invocation audience must be null, A or B');
      }
      const attemptNo = assertPositiveInteger(attempt, 'attempt');
      const requestedInputTokens = reserved_input_tokens === null
        ? null
        : assertPositiveInteger(reserved_input_tokens, 'reserved_input_tokens');
      const requestedOutputTokens = reserved_output_tokens === null
        ? null
        : assertPositiveInteger(reserved_output_tokens, 'reserved_output_tokens');
      const invocationId = invocation_id === null
        ? generatedId(idFactory, 'invocation')
        : assertIdentifier(invocation_id, 'invocation_id');
      const startedAt = now();
      return connection.write(database => {
        const member = requireMember(database, roomId, payerUserId);
        requireWritable(member);
        const { turn, plan } = planForMember(database, roomId, payerUserId, planHash);
        const item = plan.stage_plans.find(candidate => (
          candidate.stage === stage && candidate.audience === audience
        ));
        if (!item) fail('BILLING_PLAN_ITEM_NOT_FOUND', 'plan has no matching model stage scope', {}, 404);
        if (item.payer_user_id !== payerUserId) {
          fail('PAYER_SELF_REQUIRED', 'only the plan item payer may start this invocation', {}, 403);
        }
        const audienceLabel = audience ?? 'shared';
        const readiness = assertCompletePlanReadiness(database, {
          roomId,
          turn,
          plan,
          checkedAt: startedAt
        });
        const sameInvocation = database.prepare(`
          SELECT * FROM ai_usage_ledger WHERE invocation_id = ?
        `).get(invocationId);
        if (sameInvocation) {
          const priorSnapshot = sameInvocation.authorization_snapshot_json === null
            ? null
            : parseJson(
                sameInvocation.authorization_snapshot_json,
                'invocation authorization snapshot'
              );
          const priorRequest = priorSnapshot?.current_invocation?.requested_reservation ?? null;
          if (sameInvocation.turn_id !== turn.turn_id
            || sameInvocation.plan_hash !== planHash
            || sameInvocation.payer_user_id !== payerUserId
            || sameInvocation.stage !== stage
            || sameInvocation.audience !== audienceLabel
            || sameInvocation.attempt !== attemptNo
            || (priorRequest !== null
              && (priorRequest.input_tokens !== requestedInputTokens
                || priorRequest.output_tokens !== requestedOutputTokens))
            || (priorRequest === null && requestedInputTokens !== null
              && sameInvocation.reserved_input_tokens !== requestedInputTokens)
            || (priorRequest === null && requestedOutputTokens !== null
              && sameInvocation.reserved_output_tokens !== requestedOutputTokens)) {
            fail('IDEMPOTENCY_CONFLICT', 'invocation ID was reused for another request', {}, 409);
          }
          return immutable({ usage: usageProjection(sameInvocation), replayed: true });
        }
        const unresolved = database.prepare(`
          SELECT invocation_id, usage_status FROM ai_usage_ledger
           WHERE turn_id = ? AND stage = ? AND audience = ?
             AND usage_status IN ('IN_FLIGHT', 'UNKNOWN')
           LIMIT 1
        `).get(turn.turn_id, stage, audienceLabel);
        if (unresolved) {
          fail('MODEL_INVOCATION_UNRESOLVED', 'an in-flight or unknown invocation blocks a new attempt', {
            invocation_id: unresolved.invocation_id,
            usage_status: unresolved.usage_status
          }, 409);
        }
        const existingAttempt = database.prepare(`
          SELECT invocation_id FROM ai_usage_ledger
           WHERE turn_id = ? AND stage = ? AND audience = ? AND attempt = ?
        `).get(turn.turn_id, stage, audienceLabel, attemptNo);
        if (existingAttempt) {
          fail('MODEL_INVOCATION_ATTEMPT_CONFLICT', 'stage attempt already has another invocation', {}, 409);
        }
        const nextAttempt = database.prepare(`
          SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
            FROM ai_usage_ledger
           WHERE turn_id = ? AND stage = ? AND audience = ?
        `).get(turn.turn_id, stage, audienceLabel).next_attempt;
        if (attemptNo !== nextAttempt) {
          fail('STALE_INVOCATION_ATTEMPT', 'model invocation attempts must be contiguous', {
            expected: nextAttempt,
            actual: attemptNo
          }, 409);
        }
        const scopeKey = `${stage}:${audienceLabel}`;
        const consumed = readiness.usage_by_scope.get(scopeKey)
          ?? chargedUsageForScope(database, turn.turn_id, stage, audience);
        // Plan/grant budget fields are retained as immutable authorization and
        // accounting metadata. They do not cap automatic multiplayer calls.
        // Each invocation reserves only its own requested shape, while actual
        // provider usage is written to the append-only ledger after return.
        const inputReservation = requestedInputTokens
          ?? Math.max(1, item.budget.max_input_tokens);
        const outputReservation = requestedOutputTokens
          ?? Math.max(1, item.budget.max_output_tokens);
        const retryReservation = consumed.requests > 0 ? 1 : 0;
        const reservation = {
          requests: 1,
          input_tokens: inputReservation,
          output_tokens: outputReservation,
          retries: retryReservation
        };
        const authorizationSnapshot = canonicalStringify({
          schema: 'naruto.multiplayer-invocation-authorization-snapshot/v1',
          checked_at: startedAt,
          plan_hash: planHash,
          plan_revision: plan.plan_revision,
          validated_plan_items: readiness.snapshots,
          current_invocation: {
            plan_item_id: item.plan_item_id,
            stage,
            audience,
            requested_reservation: {
              input_tokens: requestedInputTokens,
              output_tokens: requestedOutputTokens
            },
            consumed_before: consumed,
            reservation
          }
        });
        database.prepare(`
          INSERT INTO ai_usage_ledger (
            invocation_id, turn_id, plan_hash, payer_user_id, stage,
            audience, attempt, provider_request_id, request_count,
            input_tokens, output_tokens, estimated_cost_currency,
            estimated_cost_amount_micros, usage_status, started_at,
            completed_at, reserved_input_tokens, reserved_output_tokens,
            reserved_retry_count, budget_charge_state,
            authorization_snapshot_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, NULL, NULL, NULL, NULL,
            'IN_FLIGHT', ?, NULL, ?, ?, ?, 'RESERVED', ?)
        `).run(
          invocationId,
          turn.turn_id,
          planHash,
          payerUserId,
          stage,
          audienceLabel,
          attemptNo,
          startedAt,
          inputReservation,
          outputReservation,
          retryReservation,
          authorizationSnapshot
        );
        return immutable({
          usage: usageProjection(requireUsage(database, invocationId)),
          replayed: false
        });
      });
    },

    async acknowledge({
      authenticated_user_id,
      room_id,
      invocation_id,
      provider_request_id = null,
      input_tokens = null,
      output_tokens = null,
      estimated_cost = null
    }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const invocationId = assertIdentifier(invocation_id, 'invocation_id');
      const completion = normalizeUsageCompletion({
        provider_request_id,
        input_tokens,
        output_tokens,
        estimated_cost
      });
      const completedAt = now();
      return connection.write(database => {
        const row = requireUsagePayer(database, invocationId, payerUserId, roomId);
        if (row.usage_status === 'SUCCEEDED') {
          if (!completionMatches(row, completion)
            || row.budget_charge_state !== 'SETTLED') {
            fail('MODEL_USAGE_TERMINAL_CONFLICT', 'acknowledged usage cannot be replaced', {}, 409);
          }
          return immutable({ usage: usageProjection(row), replayed: true });
        }
        if (row.usage_status !== 'IN_FLIGHT') {
          fail('MODEL_USAGE_STATE_CONFLICT', 'only an in-flight invocation may be acknowledged', {
            usage_status: row.usage_status
          }, 409);
        }
        const changed = database.prepare(`
          UPDATE ai_usage_ledger
             SET provider_request_id = ?, input_tokens = ?, output_tokens = ?,
                 estimated_cost_currency = ?, estimated_cost_amount_micros = ?,
                 usage_status = 'SUCCEEDED', budget_charge_state = 'SETTLED',
                 completed_at = ?
           WHERE invocation_id = ? AND payer_user_id = ?
             AND usage_status = 'IN_FLIGHT'
        `).run(
          completion.providerRequestId,
          completion.inputTokens,
          completion.outputTokens,
          completion.estimatedCostCurrency,
          completion.estimatedCostAmountMicros,
          completedAt,
          invocationId,
          payerUserId
        );
        if (changed.changes !== 1) fail('MODEL_USAGE_STATE_CONFLICT', 'usage acknowledgement CAS failed', {}, 409);
        return immutable({
          usage: usageProjection(requireUsage(database, invocationId)),
          replayed: false
        });
      });
    },

    async fail({
      authenticated_user_id,
      room_id,
      invocation_id,
      provider_request_id = null,
      input_tokens = null,
      output_tokens = null,
      estimated_cost = null,
      release_budget = false
    }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const invocationId = assertIdentifier(invocation_id, 'invocation_id');
      if (typeof release_budget !== 'boolean') {
        fail('REPOSITORY_INPUT_INVALID', 'release_budget must be a boolean');
      }
      const completion = normalizeUsageCompletion({
        provider_request_id,
        input_tokens,
        output_tokens,
        estimated_cost
      });
      if (release_budget && Object.values(completion).some(value => value !== null)) {
        fail(
          'MODEL_USAGE_RELEASE_INVALID',
          'only a confirmed unsent invocation with no provider usage may release budget',
          {},
          409
        );
      }
      const chargeState = release_budget ? 'RELEASED' : 'SETTLED';
      const completedAt = now();
      return connection.write(database => {
        const row = requireUsagePayer(database, invocationId, payerUserId, roomId);
        if (row.usage_status === 'FAILED') {
          if (!completionMatches(row, completion)
            || row.budget_charge_state !== chargeState) {
            fail('MODEL_USAGE_TERMINAL_CONFLICT', 'failed usage cannot be replaced', {}, 409);
          }
          return immutable({ usage: usageProjection(row), replayed: true });
        }
        if (row.usage_status !== 'IN_FLIGHT') {
          fail('MODEL_USAGE_STATE_CONFLICT', 'only an in-flight invocation may fail', {
            usage_status: row.usage_status
          }, 409);
        }
        const changed = database.prepare(`
          UPDATE ai_usage_ledger
             SET provider_request_id = ?, input_tokens = ?, output_tokens = ?,
                 estimated_cost_currency = ?, estimated_cost_amount_micros = ?,
                 usage_status = 'FAILED', budget_charge_state = ?, completed_at = ?
           WHERE invocation_id = ? AND payer_user_id = ?
             AND usage_status = 'IN_FLIGHT'
        `).run(
          completion.providerRequestId,
          completion.inputTokens,
          completion.outputTokens,
          completion.estimatedCostCurrency,
          completion.estimatedCostAmountMicros,
          chargeState,
          completedAt,
          invocationId,
          payerUserId
        );
        if (changed.changes !== 1) {
          fail('MODEL_USAGE_STATE_CONFLICT', 'usage failure CAS failed', {}, 409);
        }
        return immutable({
          usage: usageProjection(requireUsage(database, invocationId)),
          replayed: false
        });
      });
    },

    async markUnknown({ authenticated_user_id, room_id, invocation_id }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const invocationId = assertIdentifier(invocation_id, 'invocation_id');
      return connection.write(database => {
        const row = requireUsagePayer(database, invocationId, payerUserId, roomId);
        if (row.usage_status === 'UNKNOWN') {
          return immutable({ usage: usageProjection(row), replayed: true });
        }
        if (row.usage_status !== 'IN_FLIGHT') {
          fail('MODEL_USAGE_STATE_CONFLICT', 'only an in-flight invocation may become unknown', {}, 409);
        }
        const changed = database.prepare(`
          UPDATE ai_usage_ledger SET usage_status = 'UNKNOWN'
           WHERE invocation_id = ? AND payer_user_id = ?
             AND usage_status = 'IN_FLIGHT'
        `).run(invocationId, payerUserId);
        if (changed.changes !== 1) fail('MODEL_USAGE_STATE_CONFLICT', 'unknown-state CAS failed', {}, 409);
        return immutable({
          usage: usageProjection(requireUsage(database, invocationId)),
          replayed: false
        });
      });
    },

    async abandonUnknown({
      authenticated_user_id,
      room_id,
      invocation_id,
      accept_duplicate_billing_risk
    }) {
      const payerUserId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const invocationId = assertIdentifier(invocation_id, 'invocation_id');
      if (accept_duplicate_billing_risk !== true) {
        fail(
          'UNKNOWN_USAGE_RISK_ACCEPTANCE_REQUIRED',
          'payer must explicitly accept potential duplicate billing before abandoning UNKNOWN usage',
          {},
          409
        );
      }
      const abandonedAt = now();
      return connection.write(database => {
        const row = requireUsagePayer(database, invocationId, payerUserId, roomId);
        if (row.usage_status === 'CANCELLED') {
          return immutable({ usage: usageProjection(row), replayed: true });
        }
        if (row.usage_status !== 'UNKNOWN') {
          fail('MODEL_USAGE_STATE_CONFLICT', 'only UNKNOWN usage may be explicitly abandoned', {
            usage_status: row.usage_status
          }, 409);
        }
        const changed = database.prepare(`
          UPDATE ai_usage_ledger
             SET usage_status = 'CANCELLED', completed_at = ?
           WHERE invocation_id = ? AND payer_user_id = ?
             AND usage_status = 'UNKNOWN'
        `).run(abandonedAt, invocationId, payerUserId);
        if (changed.changes !== 1) fail('MODEL_USAGE_STATE_CONFLICT', 'UNKNOWN abandonment CAS failed', {}, 409);
        return immutable({
          usage: usageProjection(requireUsage(database, invocationId)),
          replayed: false
        });
      });
    },

    /** Startup recovery is an internal lifecycle operation, not a user API. */
    async recoverInflightAsUnknown({ started_before }) {
      const cutoff = assertTimestamp(started_before, 'started_before');
      return connection.write(database => {
        const rows = database.prepare(`
          SELECT invocation_id FROM ai_usage_ledger
           WHERE usage_status = 'IN_FLIGHT' AND started_at <= ?
           ORDER BY started_at, invocation_id
        `).all(cutoff);
        database.prepare(`
          UPDATE ai_usage_ledger SET usage_status = 'UNKNOWN'
           WHERE usage_status = 'IN_FLIGHT' AND started_at <= ?
        `).run(cutoff);
        return Object.freeze(rows.map(row => row.invocation_id));
      });
    },

    get({ authenticated_user_id, room_id, invocation_id }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const invocationId = assertIdentifier(invocation_id, 'invocation_id');
      return connection.read(database => {
        requireMember(database, roomId, userId);
        const row = requireUsage(database, invocationId);
        if (row.room_id !== roomId) {
          fail('MODEL_INVOCATION_NOT_FOUND', 'model invocation does not belong to this room', {}, 404);
        }
        return usageProjection(row);
      });
    },

    listForTurn({ authenticated_user_id, room_id, turn_id }) {
      const userId = assertPrincipal(authenticated_user_id);
      const roomId = assertIdentifier(room_id, 'room_id');
      const turnId = assertIdentifier(turn_id, 'turn_id');
      return connection.read(database => {
        requireMember(database, roomId, userId);
        requireTurn(database, { roomId, turnId });
        return Object.freeze(database.prepare(`
          SELECT * FROM ai_usage_ledger
           WHERE turn_id = ? ORDER BY stage, audience, attempt
        `).all(turnId).map(usageProjection));
      });
    }
  });

  /**
   * Process-internal outbound binding resolver. Unlike owner-facing profile
   * and credential projections, this port may return the encrypted credential
   * envelope so ModelHttpGateway can decrypt it inside the vault callback.
   * It is intentionally never mapped to an HTTP operation.
   */
  const modelBindings = Object.freeze({
    resolveProfile({ owner_user_id, profile_ref, capability_probe_ref = null }) {
      const ownerUserId = assertPrincipal(owner_user_id, 'owner_user_id');
      if (!profile_ref || typeof profile_ref !== 'object' || Array.isArray(profile_ref)) {
        fail('MODEL_PROFILE_REFERENCE_INVALID', 'model profile reference is required');
      }
      const profileId = assertIdentifier(profile_ref.profile_id, 'profile_ref.profile_id');
      const configRevision = assertPositiveInteger(
        profile_ref.config_revision,
        'profile_ref.config_revision'
      );
      return connection.read(database => {
        const row = requireProfileRow(
          database,
          ownerUserId,
          profileId,
          configRevision,
          { active: true }
        );
        assertProfileCredentialUsable(database, row);
        const profile = profileContract(row);
        if (capability_probe_ref === null) return profile;
        if (!capability_probe_ref || typeof capability_probe_ref !== 'object'
          || Array.isArray(capability_probe_ref)) {
          fail('CAPABILITY_PROBE_REFERENCE_INVALID', 'capability probe reference is invalid');
        }
        const probeRevision = assertPositiveInteger(
          capability_probe_ref.probe_revision,
          'capability_probe_ref.probe_revision'
        );
        if (typeof capability_probe_ref.probe_hash !== 'string'
          || !HASH_REGEXP.test(capability_probe_ref.probe_hash)) {
          fail('CAPABILITY_PROBE_REFERENCE_INVALID', 'capability probe hash is invalid');
        }
        const probe = database.prepare(`
          SELECT * FROM model_capability_probes
           WHERE profile_owner_user_id = ?
             AND profile_id = ? AND profile_revision = ?
             AND probe_revision = ? AND probe_status = 'SUCCEEDED'
             AND ((credential_id IS NULL AND ? IS NULL)
               OR (credential_id = ? AND credential_revision = ?))
        `).get(
          ownerUserId,
          profileId,
          configRevision,
          probeRevision,
          row.credential_id,
          row.credential_id,
          row.credential_revision
        );
        if (!probe || probe.probe_hash !== capability_probe_ref.probe_hash) {
          fail(
            'BILLING_PLAN_PROBE_MISMATCH',
            'runtime profile does not match the frozen capability probe',
            {},
            409
          );
        }
        const result = parseJson(probe.probe_result_json, 'capability probe result');
        const capabilities = normalizeCapabilities(result?.capabilities);
        if (!(capabilities.strict_json && capabilities.error_correction_continuation)
          || !['native_tools', 'json_protocol'].includes(probe.recommended_transport)) {
          fail(
            'CAPABILITY_PROBE_INSUFFICIENT',
            'frozen probe does not support Continuity requirements',
            {},
            409
          );
        }
        return assertModelEndpointProfile({
          ...profile,
          capabilities,
          recommended_continuity_transport: probe.recommended_transport
        });
      });
    },

    resolveCredential({ owner_user_id, credential_ref, profile }) {
      const ownerUserId = assertPrincipal(owner_user_id, 'owner_user_id');
      if (!credential_ref || typeof credential_ref !== 'object' || Array.isArray(credential_ref)) {
        fail('MODEL_CREDENTIAL_REFERENCE_INVALID', 'model credential reference is required');
      }
      const credentialId = assertIdentifier(
        credential_ref.credential_id,
        'credential_ref.credential_id'
      );
      const credentialRevision = assertPositiveInteger(
        credential_ref.credential_revision,
        'credential_ref.credential_revision'
      );
      if (!profile || profile.owner_user_id !== ownerUserId
        || profile.credential_ref?.credential_id !== credentialId
        || profile.credential_ref?.credential_revision !== credentialRevision) {
        fail(
          'MODEL_PROFILE_CREDENTIAL_MISMATCH',
          'outbound credential reference does not match the resolved profile',
          {},
          409
        );
      }
      return connection.read(database => {
        const profileRow = requireProfileRow(
          database,
          ownerUserId,
          profile.profile_id,
          profile.config_revision,
          { active: true }
        );
        const currentProfile = assertProfileCredentialUsable(database, profileRow);
        if (currentProfile.config_fingerprint !== profile.config_fingerprint
          || currentProfile.credential_ref?.credential_id !== credentialId
          || currentProfile.credential_ref?.credential_revision !== credentialRevision) {
          fail(
            'MODEL_PROFILE_CREDENTIAL_MISMATCH',
            'outbound model binding changed before invocation',
            {},
            409
          );
        }
        return credentialRecord(requireCredentialRow(
          database,
          ownerUserId,
          credentialId,
          credentialRevision,
          { active: true }
        ));
      });
    }
  });

  return Object.freeze({
    credentials,
    profiles,
    probes,
    selections,
    credentialPolicies,
    grants,
    consents,
    plans,
    amendments,
    usage,
    modelBindings,
    schemaGaps: SQLITE_BILLING_SCHEMA_GAPS
  });
}

/** Internal synchronous helper for the first-action execution-plan resolver. */
export function readTurnModelSelectionHashes(database, turnIdValue) {
  const turnId = assertIdentifier(turnIdValue, 'turn_id');
  if (!database || typeof database.prepare !== 'function') {
    fail('BILLING_REPOSITORY_CONFIGURATION_INVALID', 'a synchronous SQLite database is required');
  }
  const turn = database.prepare(`
    SELECT turn_id, narrative_mode FROM multiplayer_turns WHERE turn_id = ?
  `).get(turnId);
  if (!turn) fail('TURN_NOT_FOUND', 'turn does not exist', {}, 404);
  const rows = selectionRows(database, turnId);
  const shared = rows.find(row => row.scope === 'shared' && row.audience === 'shared');
  const writer = Object.fromEntries(ROOM_SEATS.map(audience => [
    audience,
    rows.find(row => row.scope === 'writer' && row.audience === audience)
  ]));
  return immutable({
    turn_id: turnId,
    narrative_mode: turn.narrative_mode,
    ready: selectionReadiness(turn, rows),
    selection_ready: selectionStructureReadiness(turn, rows),
    turn_payer_selection_hash: shared?.selection_hash ?? null,
    pov_writer_selection_hashes: turn.narrative_mode === 'shared'
      ? null
      : {
          A: writer.A?.selection_hash ?? null,
          B: writer.B?.selection_hash ?? null
        },
    writer_payer_by_audience: turn.narrative_mode === 'shared'
      ? null
      : {
          A: writer.A?.payer_seat_id ?? null,
          B: writer.B?.payer_seat_id ?? null
        },
    model_config_fingerprints: {
      shared_stage: shared
        ? selectionProfileRow(database, shared).config_fingerprint
        : null,
      pov_writers: turn.narrative_mode === 'shared'
        ? null
        : {
            A: writer.A ? selectionProfileRow(database, writer.A).config_fingerprint : null,
            B: writer.B ? selectionProfileRow(database, writer.B).config_fingerprint : null
          }
    }
  });
}

function exactConsentIsActive(database, {
  roomId,
  epochId,
  subjectUserId,
  selectionHashValue,
  configFingerprint,
  termsRevision,
  categoriesHash
}) {
  const row = database.prepare(`
    SELECT consent_action
      FROM data_processing_consents
     WHERE room_id = ? AND scope_epoch_id = ? AND subject_user_id = ?
       AND selection_hash = ? AND config_fingerprint = ?
       AND terms_revision = ? AND categories_hash = ?
     ORDER BY consent_revision DESC LIMIT 1
  `).get(
    roomId,
    epochId,
    subjectUserId,
    selectionHashValue,
    configFingerprint,
    termsRevision,
    categoriesHash
  );
  return row?.consent_action === 'GRANTED';
}

function dataCategoriesHash(categories) {
  return hashCanonical({
    schema: 'naruto.multiplayer-data-categories/v1',
    categories: [...categories].sort()
  });
}

function exactCredentialPolicyIsReady(database, turn, rows) {
  const room = database.prepare(`
    SELECT credential_usage_policy, credential_policy_revision
      FROM multiplayer_rooms WHERE room_id = ?
  `).get(turn.room_id);
  if (!room || room.credential_policy_revision < 1) return true;

  const acceptedSeats = new Set(database.prepare(`
    SELECT seat_id FROM room_credential_policy_acceptances
     WHERE room_id = ? AND policy_revision = ?
       AND credential_usage_policy = ?
  `).all(
    turn.room_id,
    room.credential_policy_revision,
    room.credential_usage_policy
  ).map(row => row.seat_id));
  if (!ROOM_SEATS.every(seat => acceptedSeats.has(seat))) return false;

  const requiredSeats = room.credential_usage_policy === 'A_ONLY'
    ? ['A']
    : (room.credential_usage_policy === 'B_ONLY' ? ['B'] : ROOM_SEATS);
  const bindings = new Map();
  for (const seat of requiredSeats) {
    const binding = database.prepare(`
      SELECT b.profile_id, b.profile_revision, b.owner_user_id,
             p.profile_status, p.credential_id, c.credential_state
        FROM room_model_profile_bindings AS b
        JOIN model_endpoint_profiles AS p
          ON p.profile_id = b.profile_id
         AND p.config_revision = b.profile_revision
         AND p.owner_user_id = b.owner_user_id
        LEFT JOIN stored_model_credentials AS c
          ON c.credential_id = p.credential_id
         AND c.credential_revision = p.credential_revision
         AND c.owner_user_id = p.owner_user_id
       WHERE b.room_id = ? AND b.seat_id = ? AND b.active = 1
    `).get(turn.room_id, seat);
    if (!binding
      || binding.profile_status !== 'ACTIVE'
      || (binding.credential_id !== null && binding.credential_state !== 'ACTIVE')) {
      return false;
    }
    bindings.set(seat, binding);
  }

  const payerSeat = resolveCredentialPayerSeat(
    room.credential_usage_policy,
    turn.turn_no
  );
  const payerBinding = bindings.get(payerSeat);
  const expectedCount = turn.narrative_mode === 'shared' ? 1 : 3;
  const keyPrefix = [
    'credential-policy',
    room.credential_policy_revision,
    turn.turn_id,
    turn.narrative_mode,
    ''
  ].join('-');
  return Boolean(payerBinding)
    && rows.length === expectedCount
    && rows.every(row => (
      row.payer_seat_id === payerSeat
      && row.profile_id === payerBinding.profile_id
      && row.profile_revision === payerBinding.profile_revision
      && row.idempotency_key === [
        `${keyPrefix}${row.expected_control_revision}`,
        row.scope,
        row.audience
      ].join('-')
    ));
}

/**
 * Synchronous first-action gate. Selection acceptance alone is insufficient:
 * every required data owner must have an active consent for the current
 * selection/config/terms/category fingerprint before the execution plan can
 * freeze. Model compatibility is handled by the actual JSON stage request.
 */
export function readTurnActionLockReadiness(database, turnIdValue, {
  termsRevision = MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
  sharedDataCategories = SHARED_STAGE_DATA_CATEGORIES,
  povWriterDataCategories = POV_WRITER_DATA_CATEGORIES
} = {}) {
  const selection = readTurnModelSelectionHashes(database, turnIdValue);
  const turn = database.prepare(`
    SELECT turn_id, room_id, epoch_id, turn_no, narrative_mode
      FROM multiplayer_turns WHERE turn_id = ?
  `).get(selection.turn_id);
  const rows = selectionRows(database, selection.turn_id);
  const members = database.prepare(`
    SELECT user_id, seat_id FROM multiplayer_members
     WHERE room_id = ? AND member_status = 'ACTIVE'
     ORDER BY seat_id
  `).all(turn.room_id);
  const hasBothMembers = members.length === 2
    && members[0].seat_id === 'A'
    && members[1].seat_id === 'B';
  const credentialPolicyReady = exactCredentialPolicyIsReady(database, turn, rows);
  const blockers = [];
  if (!selection.selection_ready || !hasBothMembers) {
    blockers.push(Object.freeze({ kind: 'selection', code: 'PAYER_SELECTION_REQUIRED' }));
  }
  if (!credentialPolicyReady) {
    blockers.push(Object.freeze({
      kind: 'credential_policy',
      code: 'CREDENTIAL_POLICY_NOT_READY'
    }));
  }
  const selectedScopes = [];
  const shared = rows.find(row => row.scope === 'shared' && row.audience === 'shared');
  if (shared) {
    selectedScopes.push({
      selection: shared,
      categories: sharedDataCategories,
      audience: null
    });
  }
  if (turn.narrative_mode === 'dual_pov') {
    for (const audience of ROOM_SEATS) {
      const writer = rows.find(row => row.scope === 'writer' && row.audience === audience);
      if (!writer) continue;
      selectedScopes.push({
        selection: writer,
        categories: povWriterDataCategories,
        audience
      });
    }
  }
  for (const scope of selectedScopes) {
    const profile = selectionProfileRow(database, scope.selection);
    const categoriesHash = dataCategoriesHash(scope.categories);
    const requiredSubjects = hasBothMembers
      ? requiredConsentSubjectUserIds(members, {
          audience: scope.audience,
          payerUserId: scope.selection.payer_user_id,
          endpointOwnerUserId: profile.owner_user_id
        })
      : [];
    for (const subjectUserId of requiredSubjects) {
      if (!exactConsentIsActive(database, {
        roomId: turn.room_id,
        epochId: turn.epoch_id,
        subjectUserId,
        selectionHashValue: scope.selection.selection_hash,
        configFingerprint: profile.config_fingerprint,
        termsRevision,
        categoriesHash
      })) {
        blockers.push(Object.freeze({
          kind: 'data_processing_consent',
          code: 'DATA_PROCESSING_CONSENT_REQUIRED',
          subject_user_id: subjectUserId,
          selection_hash: scope.selection.selection_hash,
          config_fingerprint: profile.config_fingerprint,
          terms_revision: termsRevision,
          categories_hash: categoriesHash
        }));
      }
    }
  }
  return immutable({
    ...selection,
    ready: selection.ready && credentialPolicyReady && blockers.length === 0,
    selection_ready: selection.selection_ready && credentialPolicyReady,
    blockers
  });
}
