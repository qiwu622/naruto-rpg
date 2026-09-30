import assert from 'node:assert/strict';

import { sha256Hex } from '../server/multiplayer/domain/canonical-json.js';
import {
  BILLING_ESTIMATE_POLICY,
  CREDENTIAL_VAULT_ALGORITHM_GAP,
  EXECUTION_GRANT_SCHEMA,
  MODEL_ENDPOINT_NETWORK_VALIDATION_GAP,
  MODEL_ENDPOINT_PROFILE_JSON_SCHEMA,
  MODEL_ENDPOINT_PROFILE_SCHEMA,
  POV_WRITER_SELECTION_SCHEMA,
  STORED_MODEL_CREDENTIAL_SCHEMA,
  TURN_BILLING_PLAN_SCHEMA,
  TURN_PAYER_SELECTION_SCHEMA,
  assertExecutionGrant,
  assertExecutionGrantUsable,
  assertModelEndpointProfile,
  assertModelProfileCredentialBinding,
  assertPOVWriterSelectionReady,
  assertStoredModelCredential,
  assertTurnBillingPlanMatchesSelections,
  assertTurnPayerSelection,
  inspectExecutionGrantUsable,
  inspectModelEndpointProfile,
  inspectStoredModelCredential,
  inspectTurnPayerSelection
} from '../server/multiplayer/contracts/billing-contracts.js';
import {
  AUDIENCE_SAFE_IMPORT_DIFF_PROJECTION_GAP,
  AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
  CHARACTER_CREATION_CONTRACT_GAP,
  FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA,
  PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA,
  RESUME_ROOM_CHECKPOINT_SCHEMA,
  ROOM_ACTOR_BINDING_SCHEMA,
  ROOM_CHECKPOINT_SCHEMA,
  ROOM_EPOCH_SCHEMA,
  ROOM_ORIGIN_SCHEMA,
  SOURCE_IMPORT_SCHEMA,
  assertAudienceSafeImportDiff,
  assertForkFromLatestSourceSave,
  assertOriginalActorBindingBijection,
  assertPersonalSingleplayerExport,
  assertResumeRoomCheckpoint,
  assertRoomActorBinding,
  assertRoomCheckpoint,
  assertRoomEpoch,
  assertRoomOrigin,
  assertSourceImport,
  inspectForkFromLatestSourceSave,
  inspectOriginalActorBindingBijection,
  inspectResumeRoomCheckpoint
} from '../server/multiplayer/contracts/lineage-contracts.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function hash(seed) {
  return `sha256:${sha256Hex(seed)}`;
}

function hmac(seed) {
  return `hmac-sha256:${sha256Hex(`server:${seed}`)}`;
}

const NOW = '2026-08-22T08:00:00.000Z';
const LATER = '2026-08-23T08:00:00.000Z';
const MEMBERS = Object.freeze({ A: 'user-A', B: 'user-B' });
const DISCORD_MEMBERS = Object.freeze({ A: '123456789012345678', B: '987654321098765432' });

function withDiscordPrincipals(value) {
  if (value === MEMBERS.A) return DISCORD_MEMBERS.A;
  if (value === MEMBERS.B) return DISCORD_MEMBERS.B;
  if (Array.isArray(value)) return value.map(withDiscordPrincipals);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, withDiscordPrincipals(child)])
    );
  }
  return value;
}

function credentialRef() {
  return { credential_id: 'credential-A', credential_revision: 1 };
}

function profileRef() {
  return {
    profile_id: 'profile-A',
    config_revision: 1,
    owner_user_id: 'user-A',
    normalized_origin: 'https://models.example.test',
    config_fingerprint: hash('profile-A-v1'),
    credential_ref: credentialRef()
  };
}

function endpointProfile() {
  return {
    schema: MODEL_ENDPOINT_PROFILE_SCHEMA,
    profile_id: 'profile-A',
    owner_user_id: 'user-A',
    config_revision: 1,
    adapter: 'openai_compatible',
    endpoint: {
      normalized_base_url: 'https://models.example.test/v1',
      normalized_origin: 'https://models.example.test'
    },
    model: 'compatible-model-v1',
    auth_scheme: 'bearer',
    credential_ref: credentialRef(),
    capabilities: {
      native_tools: false,
      strict_json: true,
      error_correction_continuation: true
    },
    recommended_continuity_transport: 'json_protocol',
    config_fingerprint: hash('profile-A-v1')
  };
}

function storedCredential() {
  return {
    schema: STORED_MODEL_CREDENTIAL_SCHEMA,
    credential_id: 'credential-A',
    owner_user_id: 'user-A',
    credential_revision: 1,
    endpoint_origin_hash: hash('https://models.example.test'),
    ciphertext: Buffer.from('encrypted api credential').toString('base64'),
    wrapped_data_key: Buffer.from('wrapped random data key').toString('base64'),
    nonce: Buffer.from('unique nonce').toString('base64'),
    auth_tag: Buffer.from('authenticated tag').toString('base64'),
    master_key_version: 'master-key-v1',
    fingerprint_suffix: 'a1b2c3d4',
    rotated_from_revision: null,
    state: 'ACTIVE',
    created_at: NOW,
    revoked_at: null
  };
}

function budget(overrides = {}) {
  return {
    max_requests: 8,
    max_input_tokens: 20_000,
    max_output_tokens: 12_000,
    max_retries: 2,
    estimated_cost_cap: { currency: 'USD', amount_micros: 2_000_000 },
    ...overrides
  };
}

function grant(overrides = {}) {
  return {
    schema: EXECUTION_GRANT_SCHEMA,
    grant_id: 'grant-A-turn-1',
    grant_revision: 1,
    payer_user_id: 'user-A',
    room_id: 'room-1',
    epoch_id: 'epoch-1',
    profile_ref: profileRef(),
    stage_scopes: [
      { stage: 'continuity_steward', audience: null },
      { stage: 'writer', audience: null }
    ],
    authorization_scope: { kind: 'single_turn', turn_id: 'turn-1' },
    budget: budget(),
    granted_at: NOW,
    expires_at: LATER,
    state: 'ACTIVE',
    revoked_at: null,
    ...overrides
  };
}

function turnPayerSelection(overrides = {}) {
  return {
    schema: TURN_PAYER_SELECTION_SCHEMA,
    turn_id: 'turn-1',
    selection_revision: 1,
    expected_control_revision: 4,
    payer_user_id: 'user-A',
    payer_seat: 'A',
    profile_ref: profileRef(),
    stage_config_fingerprints: [
      { stage: 'continuity_steward', config_fingerprint: hash('continuity-config') },
      { stage: 'writer', config_fingerprint: hash('shared-writer-config') }
    ],
    payer_acceptance: { accepted_by_user_id: 'user-A', accepted_at: NOW },
    idempotency_key: 'select-payer-A-turn-1',
    selection_hash: hash('turn-payer-selection'),
    active: true,
    ...overrides
  };
}

function povSelection(audience, overrides = {}) {
  const owner = MEMBERS[audience];
  return {
    schema: POV_WRITER_SELECTION_SCHEMA,
    turn_id: 'turn-1',
    selection_revision: 1,
    expected_control_revision: 4,
    audience,
    audience_owner_user_id: owner,
    payer_user_id: 'user-A',
    payer_seat: 'A',
    profile_ref: profileRef(),
    writer_config_fingerprint: hash(`writer-${audience}`),
    payer_acceptance: { accepted_by_user_id: 'user-A', accepted_at: NOW },
    audience_acceptance: { accepted_by_user_id: owner, accepted_at: NOW },
    idempotency_key: `select-pov-${audience}`,
    selection_hash: hash(`pov-${audience}`),
    active: true,
    ...overrides
  };
}

function stagePlan(planItemId, stage, audience = null) {
  return {
    plan_item_id: planItemId,
    stage,
    audience,
    payer_user_id: 'user-A',
    payer_seat: 'A',
    profile_ref: profileRef(),
    capability_probe_ref: { probe_revision: 1, probe_hash: hash('probe-A-v1') },
    transport: stage.startsWith('continuity_') ? 'json_protocol' : null,
    budget: budget({ max_requests: stage === 'writer' ? 2 : 3 }),
    required_consent_subject_user_ids: audience === null
      ? ['user-A', 'user-B']
      : [MEMBERS[audience]]
  };
}

function sharedBillingPlan() {
  return {
    schema: TURN_BILLING_PLAN_SCHEMA,
    turn_id: 'turn-1',
    plan_revision: 1,
    narrative_mode: 'shared',
    turn_payer_selection_hash: hash('turn-payer-selection'),
    pov_writer_selection_hashes: null,
    stage_plans: [
      stagePlan('plan-continuity', 'continuity_steward'),
      stagePlan('plan-shared-writer', 'writer')
    ],
    plan_hash: hash('billing-plan-v1'),
    created_at: NOW
  };
}

function roomOrigin(type = 'existing_save_derived') {
  return {
    schema: ROOM_ORIGIN_SCHEMA,
    room_id: 'room-1',
    origin_type: type,
    lineage_id: 'lineage-1',
    origin_owner_user_id: type === 'existing_save_derived' ? 'user-A' : null,
    origin_snapshot_id: type === 'existing_save_derived' ? 'source-import-1' : 'world-seed-1'
  };
}

function sourceImport() {
  return {
    schema: SOURCE_IMPORT_SCHEMA,
    source_import_id: 'source-import-latest',
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    origin_owner_user_id: 'user-A',
    source_save_id: 'save-A',
    client_save_instance_id: 'save-instance-A',
    source_branch_id: 'branch-latest',
    source_node_id: 'node-L2',
    cloud_revision: null,
    canonical_content_hash: hash('canonical-L2'),
    selected_state_hash: hash('selected-L2'),
    raw_source_hash: hash('raw-L2'),
    normalized_source_hash: hash('normalized-L2'),
    normalization_and_rebind_diff_hash: hash('normalization-rebind'),
    genesis_state_hash: hash('genesis-E3'),
    privacy_normalizer_version: 'privacy-v1',
    derived_from_export_id: 'export-A-C10',
    audience_diff_commitments: { A: hmac('diff-A'), B: hmac('diff-B') },
    server_hmac_commitment: hmac('source-import'),
    imported_at: NOW
  };
}

function checkpoint(kind = 'turn_commit') {
  const genesis = kind === 'genesis';
  return {
    schema: ROOM_CHECKPOINT_SCHEMA,
    checkpoint_id: genesis ? 'checkpoint-C0' : 'checkpoint-C10',
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    epoch_id: 'epoch-1',
    turn_no: genesis ? 0 : 10,
    kind,
    parent_checkpoint_id: genesis ? null : 'checkpoint-C9',
    turn_id: genesis ? null : 'turn-10',
    commit_id: genesis ? null : 'commit-10',
    state_revision: genesis ? 1 : 11,
    state_hash: hash(genesis ? 'C0' : 'C10'),
    snapshot_ref: genesis ? 'snapshot-C0' : 'snapshot-C10',
    created_at: NOW
  };
}

function binding(seat, overrides = {}) {
  return {
    schema: ROOM_ACTOR_BINDING_SCHEMA,
    binding_id: `binding-${seat}`,
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    room_actor_id: `room-actor-${seat}`,
    original_member_user_id: MEMBERS[seat],
    original_seat: seat,
    genesis_checkpoint_id: 'checkpoint-C0',
    signature_version: 'binding-signature-v1',
    opaque_binding_token: `signed.binding.token.${seat}.1234567890`,
    created_at: NOW,
    ...overrides
  };
}

function acceptances(diffRequired) {
  return {
    A: {
      accepted_by_user_id: 'user-A',
      accepted_at: NOW,
      audience_diff_commitment: diffRequired ? hmac('diff-A') : null
    },
    B: {
      accepted_by_user_id: 'user-B',
      accepted_at: NOW,
      audience_diff_commitment: diffRequired ? hmac('diff-B') : null
    }
  };
}

function resumeCheckpoint() {
  return {
    schema: RESUME_ROOM_CHECKPOINT_SCHEMA,
    continuation_mode: 'resume_room_checkpoint',
    proposal_id: 'proposal-resume-C10',
    proposal_revision: 1,
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    checkpoint_id: 'checkpoint-C10',
    base_checkpoint_state_hash: hash('C10'),
    expected_control_revision: 20,
    member_acceptances: acceptances(false),
    server_hmac_commitment: hmac('resume-C10')
  };
}

function forkLatest() {
  return {
    schema: FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA,
    continuation_mode: 'fork_from_latest_source_save',
    proposal_id: 'proposal-fork-L2',
    proposal_revision: 1,
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    source_import_id: 'source-import-latest',
    origin_owner_user_id: 'user-A',
    expected_control_revision: 20,
    audience_diff_commitments: { A: hmac('diff-A'), B: hmac('diff-B') },
    member_acceptances: acceptances(true),
    server_hmac_commitment: hmac('fork-L2')
  };
}

function personalExport() {
  return {
    schema: PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA,
    export_id: 'export-A-C10',
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    checkpoint_id: 'checkpoint-C10',
    exporting_member_user_id: 'user-A',
    exporting_seat: 'A',
    codec: 'naruto.multiplayer-to-singleplayer/v1',
    projection_version: 'projection-v1',
    output_format: 'timeline-json-v1',
    idempotency_key: 'export-A-C10-once',
    request_hash: hash('export-request'),
    output_hash: hash('export-output-A'),
    timeline_origin: 'source_owner_branch',
    actor_mappings: [
      {
        room_actor_id: 'room-actor-A',
        export_role: 'player',
        opaque_binding_token: 'signed.binding.token.A.1234567890',
        inject_binding_to_agent: false
      },
      {
        room_actor_id: 'room-actor-B',
        export_role: 'npc_or_companion',
        opaque_binding_token: 'signed.binding.token.B.1234567890',
        inject_binding_to_agent: false
      }
    ],
    multiplayer_record_sidecar: {
      counterpart_actions_included: true,
      inject_to_agent: false,
      counterpart_private_pov_included: false
    },
    created_at: NOW
  };
}

function safeDiff(seat = 'B') {
  return {
    schema: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
    proposal_id: 'proposal-fork-L2',
    proposal_revision: 1,
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    source_import_id: 'source-import-latest',
    audience: seat,
    audience_user_id: MEMBERS[seat],
    audience_role: seat === 'A' ? 'source_owner' : 'guest',
    sections: [
      {
        category: 'characters',
        entries: [{ entry_id: 'character-result-1', kind: 'result', summary: '原角色控制权将恢复。' }]
      },
      {
        category: 'continuity_losses',
        entries: [{ entry_id: 'loss-warning-1', kind: 'warning', summary: '旧检查点私有连续性不会合并。' }]
      }
    ],
    projection_commitment: hmac(`projection-${seat}`),
    server_hmac_commitment: hmac(`diff-envelope-${seat}`)
  };
}

test('strict endpoint profile separates public config from credential reference', () => {
  const profile = assertModelEndpointProfile(endpointProfile());
  assert.equal(profile.endpoint.normalized_base_url, 'https://models.example.test/v1');
  assert.equal(profile.credential_ref.credential_id, 'credential-A');
  assert.equal(MODEL_ENDPOINT_PROFILE_JSON_SCHEMA.additionalProperties, false);
  assert.equal(MODEL_ENDPOINT_PROFILE_JSON_SCHEMA.properties.endpoint.additionalProperties, false);
  assert.equal(MODEL_ENDPOINT_NETWORK_VALIDATION_GAP.performs_network_io, false);
  assert.deepEqual(BILLING_ESTIMATE_POLICY.hard_limits, []);
  assert.deepEqual(BILLING_ESTIMATE_POLICY.accounting_metadata, [
    'max_requests',
    'max_input_tokens',
    'max_output_tokens',
    'max_retries'
  ]);
  assert.equal(BILLING_ESTIMATE_POLICY.estimated_cost_cap_is_hard_provider_reservation, false);
});

test('plaintext Key material is rejected from profile and stored credential contracts', () => {
  assert.equal(inspectModelEndpointProfile({ ...endpointProfile(), api_key: 'sk-plaintext' }).valid, false);
  assert.equal(inspectStoredModelCredential({
    ...storedCredential(),
    plaintext_key: 'sk-plaintext'
  }).valid, false);
  assert.equal(CREDENTIAL_VAULT_ALGORITHM_GAP.plaintext_readback, 'never');
});

test('stored encrypted credential is endpoint/owner/revision-bound and never read back as plaintext', () => {
  const stored = assertStoredModelCredential(storedCredential());
  const profile = assertModelProfileCredentialBinding(endpointProfile(), stored);
  assert.equal(profile.owner_user_id, stored.owner_user_id);
  assert.equal('api_key' in stored, false);
});

test('client cannot forge another member as accepted shared payer', () => {
  const forged = turnPayerSelection({
    payer_acceptance: { accepted_by_user_id: 'user-B', accepted_at: NOW }
  });
  assert.equal(inspectTurnPayerSelection(forged, { authenticated_user_id: 'user-B' }).valid, false);
  assert.throws(
    () => assertTurnPayerSelection(turnPayerSelection(), { authenticated_user_id: 'user-B' }),
    /cannot select or accept another payer/
  );
});

test('POV Writer requires distinct payer and audience-owner acceptance gates', () => {
  assertPOVWriterSelectionReady(povSelection('B'));
  assert.throws(
    () => assertPOVWriterSelectionReady(povSelection('B', { audience_acceptance: null })),
    /data-processing acceptance is required/
  );
});

test('execution grant enforces authority but treats usage budgets as audit metadata', () => {
  const active = assertExecutionGrant(grant());
  assertExecutionGrantUsable(active, {
    now: '2026-08-22T09:00:00.000Z',
    room_id: 'room-1',
    epoch_id: 'epoch-1',
    turn_id: 'turn-1',
    stage: 'continuity_steward',
    audience: null,
    profile_ref: profileRef(),
    consumed_budget: { requests: 3, input_tokens: 2_000, output_tokens: 1_000, retries: 0 },
    requested_budget: { requests: 1, input_tokens: 2_000, output_tokens: 1_000, retries: 1 }
  });
  assert.equal(inspectExecutionGrantUsable({
    ...grant(),
    state: 'REVOKED',
    revoked_at: '2026-08-22T09:00:00.000Z'
  }, { now: '2026-08-22T10:00:00.000Z' }).valid, false);
  assert.throws(
    () => assertExecutionGrantUsable(active, {
      now: '2026-08-22T09:00:00.000Z',
      stage: 'writer',
      audience: 'B'
    }),
    /does not cover this stage scope/
  );
  assertExecutionGrantUsable(active, {
    now: '2026-08-22T09:00:00.000Z',
    consumed_budget: {
      requests: 80,
      input_tokens: 800_000,
      output_tokens: 80_000,
      retries: 79
    },
    requested_budget: {
      requests: 10,
      input_tokens: 100_000,
      output_tokens: 10_000,
      retries: 9
    }
  });
});

test('TurnBillingPlan freezes shared selection and rejects payer/profile substitution', () => {
  const plan = assertTurnBillingPlanMatchesSelections(sharedBillingPlan(), {
    turn_payer_selection: turnPayerSelection()
  });
  assert.equal(plan.plan_revision, 1);
  const forged = structuredClone(sharedBillingPlan());
  forged.stage_plans[0].payer_user_id = 'user-B';
  forged.stage_plans[0].payer_seat = 'B';
  forged.stage_plans[0].profile_ref.owner_user_id = 'user-B';
  assert.throws(
    () => assertTurnBillingPlanMatchesSelections(forged, {
      turn_payer_selection: turnPayerSelection()
    }),
    /does not match its frozen payer selection/
  );
});

test('RoomOrigin, SourceImport, RoomEpoch and checkpoints freeze one lineage base', () => {
  assertRoomOrigin(roomOrigin());
  assertSourceImport(sourceImport(), {
    authenticated_user_id: 'user-A',
    origin_owner_user_id: 'user-A'
  });
  assertRoomCheckpoint(checkpoint('genesis'));
  assertRoomCheckpoint(checkpoint());
  assertRoomEpoch({
    schema: ROOM_EPOCH_SCHEMA,
    epoch_id: 'epoch-2',
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    epoch_no: 2,
    base: {
      type: 'room_checkpoint',
      ref_id: 'checkpoint-C10',
      state_hash: hash('C10')
    },
    genesis_checkpoint_id: 'checkpoint-E2-C0',
    head_checkpoint_id: 'checkpoint-E2-C0',
    state_revision: 21,
    control_revision: 22,
    state: 'ACTIVE',
    created_from_proposal_id: 'proposal-resume-C10',
    activated_at: NOW
  });
});

test('original actor bindings require two distinct actors, members, seats and tokens', () => {
  const bindings = [binding('A'), binding('B')];
  assertRoomActorBinding(bindings[0]);
  const bijection = assertOriginalActorBindingBijection(bindings, {
    lineage_id: 'lineage-1',
    expected_members_by_seat: MEMBERS,
    source_actor_matches: [
      { source_entity_id: 'entity-owner-L2', opaque_binding_token: bindings[0].opaque_binding_token },
      { source_entity_id: 'entity-guest-L2', opaque_binding_token: bindings[1].opaque_binding_token }
    ]
  });
  assert.deepEqual(bijection.source_entity_by_seat, {
    A: 'entity-owner-L2',
    B: 'entity-guest-L2'
  });

  const duplicateActor = [binding('A'), binding('B', { room_actor_id: 'room-actor-A' })];
  const inspection = inspectOriginalActorBindingBijection(duplicateActor);
  assert.equal(inspection.valid, false);
  assert.equal(inspection.errors[0].code, 'ROOM_ACTOR_BINDING_NOT_BIJECTIVE');
});

test('checkpoint resume rejects a source-import object as the wrong base kind', () => {
  assertResumeRoomCheckpoint(resumeCheckpoint(), {
    room_archived: true,
    expected_members_by_seat: MEMBERS,
    checkpoint: checkpoint()
  });
  assert.equal(inspectResumeRoomCheckpoint(resumeCheckpoint(), {
    room_archived: true,
    expected_members_by_seat: MEMBERS,
    checkpoint: sourceImport()
  }).valid, false);
});

test('guest personal export cannot be uploaded as original Room latest source', () => {
  const inspection = inspectForkFromLatestSourceSave(forkLatest(), {
    origin_type: 'existing_save_derived',
    origin_owner_user_id: 'user-A',
    authenticated_user_id: 'user-B',
    room_archived: true,
    expected_members_by_seat: MEMBERS,
    source_import: sourceImport()
  });
  assert.equal(inspection.valid, false);
  assert.equal(inspection.errors[0].code, 'SOURCE_OWNER_REQUIRED');
});

test('latest-source continuation is forbidden for new_multiplayer_save', () => {
  assert.equal(assertRoomOrigin(roomOrigin('new_multiplayer_save')).origin_owner_user_id, null);
  const inspection = inspectForkFromLatestSourceSave(forkLatest(), {
    origin_type: 'new_multiplayer_save',
    origin_owner_user_id: null,
    authenticated_user_id: 'user-A',
    room_archived: true,
    expected_members_by_seat: MEMBERS
  });
  assert.equal(inspection.valid, false);
  assert.equal(inspection.errors[0].code, 'CONTINUATION_MODE_NOT_ALLOWED');
});

test('latest-source fork requires normalized L2 and complete actor binding bijection', () => {
  assertForkFromLatestSourceSave(forkLatest(), {
    origin_type: 'existing_save_derived',
    origin_owner_user_id: 'user-A',
    authenticated_user_id: 'user-A',
    room_archived: true,
    expected_members_by_seat: MEMBERS,
    source_import: sourceImport(),
    actor_bindings: [binding('A'), binding('B')],
    source_actor_matches: [
      { source_entity_id: 'entity-owner-L2', opaque_binding_token: binding('A').opaque_binding_token },
      { source_entity_id: 'entity-guest-L2', opaque_binding_token: binding('B').opaque_binding_token }
    ]
  });
});

test('personal playable export is per member, audience-safe and preserves two opaque bindings', () => {
  const exported = assertPersonalSingleplayerExport(personalExport(), {
    origin_type: 'existing_save_derived',
    origin_owner_user_id: 'user-A',
    authenticated_user_id: 'user-A',
    expected_members_by_seat: MEMBERS,
    checkpoint: checkpoint(),
    actor_bindings: [binding('A'), binding('B')]
  });
  assert.equal(exported.actor_mappings.length, 2);
  assert.equal(exported.multiplayer_record_sidecar.inject_to_agent, false);
  assert.throws(
    () => assertPersonalSingleplayerExport(personalExport(), {
      origin_type: 'new_multiplayer_save',
      authenticated_user_id: 'user-A'
    }),
    error => error.code === 'PLAYABLE_EXPORT_NOT_ALLOWED'
  );
});

test('AudienceSafeImportDiff exposes only strict safe summaries and HMAC commitments', () => {
  const diff = assertAudienceSafeImportDiff(safeDiff('B'), {
    origin_owner_user_id: 'user-A',
    expected_members_by_seat: MEMBERS
  });
  assert.equal(diff.audience_role, 'guest');
  assert.equal(AUDIENCE_SAFE_IMPORT_DIFF_PROJECTION_GAP.semantic_redaction_implemented_in_contract, false);
  assert.throws(
    () => assertAudienceSafeImportDiff({ ...safeDiff('B'), raw_source_hash: hash('private-raw') }),
    /unknown property/
  );
  assert.equal(CHARACTER_CREATION_CONTRACT_GAP.design_status, 'not_defined');
});

test('Discord decimal principal IDs are accepted across billing and lineage contracts', () => {
  const numericProfile = withDiscordPrincipals(endpointProfile());
  const numericCredential = withDiscordPrincipals(storedCredential());
  assertModelProfileCredentialBinding(numericProfile, numericCredential);
  assertTurnPayerSelection(withDiscordPrincipals(turnPayerSelection()), {
    authenticated_user_id: DISCORD_MEMBERS.A
  });
  assertPOVWriterSelectionReady(withDiscordPrincipals(povSelection('B')));
  assertExecutionGrant(withDiscordPrincipals(grant()));
  assertTurnBillingPlanMatchesSelections(withDiscordPrincipals(sharedBillingPlan()), {
    turn_payer_selection: withDiscordPrincipals(turnPayerSelection())
  });

  assertRoomOrigin(withDiscordPrincipals(roomOrigin()));
  const numericSource = withDiscordPrincipals(sourceImport());
  assertSourceImport(numericSource, {
    authenticated_user_id: DISCORD_MEMBERS.A,
    origin_owner_user_id: DISCORD_MEMBERS.A
  });
  const numericBindings = [binding('A'), binding('B')].map(withDiscordPrincipals);
  assertOriginalActorBindingBijection(numericBindings, {
    lineage_id: 'lineage-1',
    expected_members_by_seat: DISCORD_MEMBERS
  });
  assertResumeRoomCheckpoint(withDiscordPrincipals(resumeCheckpoint()), {
    room_archived: true,
    expected_members_by_seat: DISCORD_MEMBERS,
    checkpoint: checkpoint()
  });
  assertForkFromLatestSourceSave(withDiscordPrincipals(forkLatest()), {
    origin_type: 'existing_save_derived',
    origin_owner_user_id: DISCORD_MEMBERS.A,
    authenticated_user_id: DISCORD_MEMBERS.A,
    room_archived: true,
    expected_members_by_seat: DISCORD_MEMBERS,
    source_import: numericSource,
    actor_bindings: numericBindings
  });
  assertPersonalSingleplayerExport(withDiscordPrincipals(personalExport()), {
    origin_type: 'existing_save_derived',
    origin_owner_user_id: DISCORD_MEMBERS.A,
    authenticated_user_id: DISCORD_MEMBERS.A,
    expected_members_by_seat: DISCORD_MEMBERS,
    checkpoint: checkpoint(),
    actor_bindings: numericBindings
  });
  assertAudienceSafeImportDiff(withDiscordPrincipals(safeDiff('B')), {
    origin_owner_user_id: DISCORD_MEMBERS.A,
    expected_members_by_seat: DISCORD_MEMBERS
  });
});

console.log(`\n${passed} multiplayer billing/lineage contract regression tests passed.`);
