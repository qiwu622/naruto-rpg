import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ACTION_REQUEST_SCHEMA } from '../server/multiplayer/domain/action-turn.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  ROOM_CHECKPOINT_SCHEMA,
  ROOM_EPOCH_SCHEMA,
  ROOM_ORIGIN_SCHEMA
} from '../server/multiplayer/contracts/lineage-contracts.js';
import { TURN_EXECUTION_PLAN_SCHEMA } from '../server/multiplayer/contracts/room-contracts.js';
import { createBillingPlanService } from '../server/multiplayer/application/billing-plan-service.js';
import { createCredentialVault } from '../server/multiplayer/security/credential-vault.js';
import { createSqliteMultiplayerCoreRepositories } from '../server/multiplayer/persistence/sqlite-core-repositories.js';
import {
  MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
  POV_WRITER_DATA_CATEGORIES,
  SHARED_STAGE_DATA_CATEGORIES,
  SQLITE_BILLING_SCHEMA_GAPS,
  createSqliteBillingRepository,
  readTurnActionLockReadiness,
  readTurnModelSelectionHashes
} from '../server/multiplayer/persistence/sqlite-billing-repository.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function expectDomain(code) {
  return error => error instanceof DomainError && error.code === code;
}

const HASH = character => `sha256:${character.repeat(64)}`;
const STARTED_AT = '2026-08-22T00:00:00.000Z';
const USER_A = '123456789012345678';
const USER_B = '987654321098765432';
const SECRET_A_1 = 'sk-a-first-credential-value-000001';
const SECRET_A_2 = 'sk-a-rotated-credential-value-0002';
const SECRET_B = 'sk-b-private-credential-value-000001';

function createClock() {
  let tick = 0;
  return () => new Date(Date.parse(STARTED_AT) + (++tick * 1_000)).toISOString();
}

function createIdFactory() {
  const counts = new Map();
  const factory = kind => {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    return `${kind}_${count}`;
  };
  return factory;
}

function xor(bytes) {
  return Buffer.from(bytes).map(byte => byte ^ 0xa5);
}

function actionCodec() {
  return {
    sealJson(value) {
      const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
      return {
        action_ciphertext: xor(plaintext),
        wrapped_data_key: Buffer.alloc(16, 0x11),
        nonce: Buffer.alloc(12, 0x22),
        auth_tag: Buffer.alloc(16, 0x33),
        master_key_version: 'test-action-key-v1'
      };
    },
    openJson(envelope) {
      return JSON.parse(xor(envelope.action_ciphertext).toString('utf8'));
    }
  };
}

function action(text, key) {
  return {
    schema: ACTION_REQUEST_SCHEMA,
    base_state_revision: 0,
    text,
    pre_resolution_visibility: 'sealed',
    narration_preference: 'full',
    idempotency_key: key
  };
}

function executionPlan(database, turn) {
  const selection = readTurnActionLockReadiness(database, turn.turn_id);
  if (!selection.ready) {
    const code = !selection.selection_ready
      ? 'PAYER_SELECTION_REQUIRED'
      : (selection.blockers.some(blocker => blocker.kind === 'capability_probe')
          ? 'CAPABILITY_PROBE_REQUIRED'
          : 'DATA_PROCESSING_CONSENT_REQUIRED');
    throw new DomainError(code, 'first-action billing gate is not ready', {
      blockers: selection.blockers
    }, { status: 409 });
  }
  return {
    schema: TURN_EXECUTION_PLAN_SCHEMA,
    narrative_mode: selection.narrative_mode,
    turn_payer_selection_hash: selection.turn_payer_selection_hash,
    pov_writer_selection_hashes: selection.pov_writer_selection_hashes,
    writer_payer_by_audience: selection.writer_payer_by_audience,
    model_config_fingerprints: selection.model_config_fingerprints
  };
}

function profileRef(profileProjection) {
  const profile = profileProjection.profile;
  return {
    profile_id: profile.profile_id,
    config_revision: profile.config_revision,
    owner_user_id: profile.owner_user_id,
    normalized_origin: profile.endpoint.normalized_origin,
    config_fingerprint: profile.config_fingerprint,
    credential_ref: profile.credential_ref
  };
}

function stageBudget(output = 100) {
  return {
    max_requests: 2,
    max_input_tokens: 200,
    max_output_tokens: output,
    max_retries: 1,
    estimated_cost_cap: null
  };
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-billing-repository-'));
const databasePath = path.join(tempRoot, 'multiplayer.sqlite');
const clock = createClock();
const idFactory = createIdFactory();
const credentialVault = createCredentialVault({
  masterKeys: { 'master-v1': Buffer.alloc(32, 0x21) },
  activeMasterKeyVersion: 'master-v1',
  fingerprintKey: Buffer.alloc(32, 0x22)
});
const connection = await openMultiplayerRepositoryTestSqlite({ databasePath });
const core = createSqliteMultiplayerCoreRepositories(connection, {
  actionContentCodec: actionCodec(),
  actionCommitmentSecret: Buffer.alloc(32, 0x23),
  clock,
  idFactory,
  randomTokenBytes: size => Buffer.alloc(size, 0x24),
  executionPlanResolver: ({ database, turn }) => executionPlan(database, turn)
});
const billing = createSqliteBillingRepository(connection, {
  credentialVault,
  clock,
  idFactory
});
const billingPlanService = createBillingPlanService({
  connection,
  billingRepository: billing,
  clock,
  idFactory
});

let invite;
let turn;
let credentialA1;
let credentialA2;
let profileA1;
let profileA2;
let profileB;
let probeA;
let probeB;
let sharedSelection;
let writerASelection;
let writerBSelection;
let writerAAcceptanceRequest;
let grantA2;
let plan1;
let consentBShared;
let unknownInvocation;

try {
  await test('fixture creates a two-member dual-POV room from numeric Discord principals', async () => {
    await core.rooms.createWithGenesis({
      authenticated_user_id: USER_A,
      narrative_mode: 'dual_pov',
      origin: {
        schema: ROOM_ORIGIN_SCHEMA,
        room_id: 'room_billing',
        origin_type: 'new_multiplayer_save',
        lineage_id: 'lineage_billing',
        origin_owner_user_id: null,
        origin_snapshot_id: 'snapshot_origin_billing'
      },
      epoch: {
        schema: ROOM_EPOCH_SCHEMA,
        epoch_id: 'epoch_billing',
        room_id: 'room_billing',
        lineage_id: 'lineage_billing',
        epoch_no: 1,
        base: {
          type: 'origin_snapshot',
          ref_id: 'snapshot_origin_billing',
          state_hash: HASH('a')
        },
        genesis_checkpoint_id: 'checkpoint_billing_0',
        head_checkpoint_id: 'checkpoint_billing_0',
        state_revision: 0,
        control_revision: 0,
        state: 'ACTIVE',
        created_from_proposal_id: null,
        activated_at: STARTED_AT
      },
      genesis_checkpoint: {
        schema: ROOM_CHECKPOINT_SCHEMA,
        checkpoint_id: 'checkpoint_billing_0',
        room_id: 'room_billing',
        lineage_id: 'lineage_billing',
        epoch_id: 'epoch_billing',
        turn_no: 0,
        kind: 'genesis',
        parent_checkpoint_id: null,
        turn_id: null,
        commit_id: null,
        state_revision: 0,
        state_hash: HASH('a'),
        snapshot_ref: 'snapshot_billing_0',
        created_at: STARTED_AT
      }
    });
    invite = await core.invites.create({
      authenticated_user_id: USER_A,
      room_id: 'room_billing'
    });
    await core.invites.join({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      token: invite.token
    });
    assert.equal(core.members.resolve({
      authenticated_user_id: USER_B,
      room_id: 'room_billing'
    }).seat, 'B');
  });

  await test('credential vault persists ciphertext only and owner projections contain no secret fields', async () => {
    credentialA1 = (await billing.credentials.create({
      authenticated_user_id: USER_A,
      endpoint_origin: 'https://api.example.com',
      plaintext: SECRET_A_1,
      credential_id: 'credential_a'
    })).credential;
    await billing.credentials.create({
      authenticated_user_id: USER_B,
      endpoint_origin: 'https://models.example.net',
      plaintext: SECRET_B,
      credential_id: 'credential_b'
    });
    assert.equal(credentialA1.credential_revision, 1);
    assert.equal('ciphertext' in credentialA1, false);
    assert.equal('wrapped_data_key' in credentialA1, false);
    assert.equal(JSON.stringify(billing.credentials.list({ authenticated_user_id: USER_A })).includes(SECRET_A_1), false);
    assert.throws(() => billing.credentials.get({
      authenticated_user_id: USER_B,
      credential_id: 'credential_a',
      credential_revision: 1
    }), expectDomain('MODEL_CREDENTIAL_NOT_FOUND'));
  });

  await test('credential and profile changes create revisions and revoke only the old active revision', async () => {
    profileA1 = (await billing.profiles.createVersion({
      authenticated_user_id: USER_A,
      profile_id: 'profile_a',
      expected_config_revision: 0,
      adapter: 'openai_compatible',
      base_url: 'https://api.example.com/v1',
      model: 'model-a-v1',
      auth_scheme: 'bearer',
      credential_ref: { credential_id: 'credential_a', credential_revision: 1 },
      capabilities: {
        native_tools: false,
        strict_json: true,
        error_correction_continuation: true
      },
      recommended_continuity_transport: 'json_protocol'
    })).profile;
    credentialA2 = (await billing.credentials.rotate({
      authenticated_user_id: USER_A,
      credential_id: 'credential_a',
      expected_credential_revision: 1,
      endpoint_origin: 'https://api.example.com',
      plaintext: SECRET_A_2
    })).credential;
    profileA2 = (await billing.profiles.createVersion({
      authenticated_user_id: USER_A,
      profile_id: 'profile_a',
      expected_config_revision: 1,
      adapter: 'openai_compatible',
      base_url: 'https://api.example.com/v1',
      model: 'model-a-v2',
      auth_scheme: 'bearer',
      credential_ref: { credential_id: 'credential_a', credential_revision: 2 },
      capabilities: {
        native_tools: false,
        strict_json: true,
        error_correction_continuation: true
      },
      recommended_continuity_transport: 'json_protocol'
    })).profile;
    profileB = (await billing.profiles.createVersion({
      authenticated_user_id: USER_B,
      profile_id: 'profile_b',
      adapter: 'openai_compatible',
      base_url: 'https://models.example.net/v1',
      model: 'model-b',
      auth_scheme: 'bearer',
      credential_ref: { credential_id: 'credential_b', credential_revision: 1 },
      capabilities: {
        native_tools: false,
        strict_json: true,
        error_correction_continuation: true
      },
      recommended_continuity_transport: 'json_protocol'
    })).profile;
    assert.equal(credentialA2.credential_revision, 2);
    assert.equal(profileA2.profile.config_revision, 2);
    assert.equal(profileA1.profile.config_revision, 1);
    assert.equal(billing.profiles.get({
      authenticated_user_id: USER_A,
      profile_id: 'profile_a',
      config_revision: 1
    }).status, 'REVOKED');
    assert.throws(() => billing.profiles.get({
      authenticated_user_id: USER_B,
      profile_id: 'profile_a',
      config_revision: 2
    }), expectDomain('MODEL_PROFILE_NOT_FOUND'));
  });

  await test('capability probes enforce exact-profile owner authority and request-key idempotency', async () => {
    const created = await billing.probes.create({
      authenticated_user_id: USER_A,
      profile_id: 'profile_a',
      profile_revision: 2,
      credential_revision: 2,
      requested_capabilities: ['native_tools', 'strict_json', 'error_correction_continuation'],
      max_requests: 3,
      max_input_tokens: 768,
      max_output_tokens: 384,
      idempotency_key: 'probe-a-1'
    });
    const replay = await billing.probes.create({
      authenticated_user_id: USER_A,
      profile_id: 'profile_a',
      profile_revision: 2,
      credential_revision: 2,
      requested_capabilities: ['native_tools', 'strict_json', 'error_correction_continuation'],
      max_requests: 3,
      max_input_tokens: 768,
      max_output_tokens: 384,
      idempotency_key: 'probe-a-1'
    });
    assert.equal(replay.replayed, true);
    await assert.rejects(() => billing.probes.create({
      authenticated_user_id: USER_A,
      profile_id: 'profile_a',
      profile_revision: 2,
      credential_revision: 2,
      requested_capabilities: ['strict_json'],
      max_requests: 2,
      max_input_tokens: 768,
      max_output_tokens: 384,
      idempotency_key: 'probe-a-1'
    }), expectDomain('IDEMPOTENCY_CONFLICT'));
    await billing.probes.start({ authenticated_user_id: USER_A, probe_id: created.probe.probe_id });
    probeA = (await billing.probes.complete({
      authenticated_user_id: USER_A,
      probe_id: created.probe.probe_id,
      result: {
        capabilities: {
          native_tools: true,
          strict_json: true,
          error_correction_continuation: true
        },
        fixed_privacy_free_tests_passed: 2
      },
      recommended_transport: 'native_tools'
    })).probe;
    assert.equal(probeA.status, 'SUCCEEDED');
    const unresolvedProfile = billing.modelBindings.resolveProfile({
      owner_user_id: USER_A,
      profile_ref: profileRef(profileA2)
    });
    assert.equal(unresolvedProfile.capabilities.native_tools, false);
    const probedProfile = billing.modelBindings.resolveProfile({
      owner_user_id: USER_A,
      profile_ref: profileRef(profileA2),
      capability_probe_ref: {
        probe_revision: probeA.probe_revision,
        probe_hash: probeA.probe_hash
      }
    });
    assert.deepEqual(probedProfile.capabilities, {
      native_tools: true,
      strict_json: true,
      error_correction_continuation: true
    });
    assert.equal(probedProfile.recommended_continuity_transport, 'native_tools');
    assert.throws(() => billing.modelBindings.resolveProfile({
      owner_user_id: USER_A,
      profile_ref: profileRef(profileA2),
      capability_probe_ref: {
        probe_revision: probeA.probe_revision,
        probe_hash: HASH('f')
      }
    }), expectDomain('BILLING_PLAN_PROBE_MISMATCH'));
    const createdProbeB = (await billing.probes.create({
      authenticated_user_id: USER_B,
      profile_id: 'profile_b',
      profile_revision: 1,
      credential_revision: 1,
      requested_capabilities: ['strict_json', 'error_correction_continuation'],
      max_requests: 2,
      max_input_tokens: 768,
      max_output_tokens: 384,
      idempotency_key: 'probe-b-1'
    })).probe;
    await billing.probes.start({
      authenticated_user_id: USER_B,
      probe_id: createdProbeB.probe_id
    });
    const completedB = await billing.probes.complete({
      authenticated_user_id: USER_B,
      probe_id: createdProbeB.probe_id,
      result: {
        capabilities: {
          native_tools: false,
          strict_json: true,
          error_correction_continuation: true
        },
        fixed_privacy_free_tests_passed: 2
      },
      recommended_transport: 'json_protocol'
    });
    probeB = completedB.probe;
    assert.equal(completedB.probe.status, 'SUCCEEDED');
    await assert.rejects(() => billing.probes.create({
      authenticated_user_id: USER_B,
      profile_id: 'profile_a',
      profile_revision: 2,
      credential_revision: 2,
      requested_capabilities: ['strict_json'],
      max_requests: 1,
      max_input_tokens: 10,
      max_output_tokens: 10,
      idempotency_key: 'probe-cross-owner'
    }), expectDomain('MODEL_PROFILE_NOT_FOUND'));
  });

  await test('three-state room policy materializes one authoritative payer and exact consents', async () => {
    let room = core.rooms.getForMember({
      authenticated_user_id: USER_A,
      room_id: 'room_billing'
    });
    turn = await core.turns.open({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      expected_control_revision: room.control_revision
    });
    const boundA = await billing.credentialPolicies.bindOwnProfile({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      endpoint_profile_id: 'profile_a',
      expected_binding_revision: 0,
      expected_control_revision: turn.control_revision
    });
    assert.equal(boundA.credential_policy.bindings.A.model, 'model-a-v2');
    assert.deepEqual(boundA.credential_policy.accepted_by, { A: false, B: false });
    room = core.rooms.getForMember({ authenticated_user_id: USER_B, room_id: 'room_billing' });
    const boundB = await billing.credentialPolicies.bindOwnProfile({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      endpoint_profile_id: 'profile_b',
      expected_binding_revision: 0,
      expected_control_revision: room.control_revision
    });
    assert.equal(boundB.credential_policy.bindings.B.model, 'model-b');
    assert.deepEqual(boundB.credential_policy.accepted_by, { A: false, B: false });
    room = core.rooms.getForMember({ authenticated_user_id: USER_A, room_id: 'room_billing' });
    const selectedByA = await billing.credentialPolicies.choose({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      policy: 'A_ONLY',
      expected_policy_revision: boundB.credential_policy.policy_revision,
      expected_control_revision: room.control_revision
    });
    assert.deepEqual(selectedByA.credential_policy.accepted_by, { A: true, B: false });
    room = core.rooms.getForMember({ authenticated_user_id: USER_B, room_id: 'room_billing' });
    const selectedByB = await billing.credentialPolicies.choose({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      policy: 'A_ONLY',
      expected_policy_revision: selectedByA.credential_policy.policy_revision,
      expected_control_revision: room.control_revision
    });
    assert.equal(selectedByB.credential_policy.ready, true);
    assert.equal(selectedByB.credential_policy.current_turn_payer_seat, 'A');
    assert.equal(selectedByB.materialized.payer_seat, 'A');
    assert.deepEqual(connection.read(database => database.prepare(`
      SELECT scope, audience, payer_seat_id, profile_id
        FROM turn_model_selections
       WHERE turn_id = ? AND active = 1
       ORDER BY scope, audience
    `).all(turn.turn_id)), [
      { scope: 'shared', audience: 'shared', payer_seat_id: 'A', profile_id: 'profile_a' },
      { scope: 'writer', audience: 'A', payer_seat_id: 'A', profile_id: 'profile_a' },
      { scope: 'writer', audience: 'B', payer_seat_id: 'A', profile_id: 'profile_a' }
    ]);

    room = core.rooms.getForMember({ authenticated_user_id: USER_A, room_id: 'room_billing' });
    await core.turns.changeNarrativeMode({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      request: {
        expected_control_revision: room.control_revision,
        mode: 'shared',
        idempotency_key: 'policy-mode-shared'
      }
    });
    const materializedShared = await billing.credentialPolicies.materializeActiveTurn({
      authenticated_user_id: USER_A,
      room_id: 'room_billing'
    });
    assert.equal(materializedShared.materialized.payer_seat, 'A');
    assert.deepEqual(connection.read(database => database.prepare(`
      SELECT scope, audience, payer_seat_id, selected_narrative_mode
        FROM turn_model_selections
       WHERE turn_id = ? AND active = 1
       ORDER BY scope, audience
    `).all(turn.turn_id)), [
      {
        scope: 'shared',
        audience: 'shared',
        payer_seat_id: 'A',
        selected_narrative_mode: 'shared'
      }
    ]);

    room = core.rooms.getForMember({ authenticated_user_id: USER_B, room_id: 'room_billing' });
    await core.turns.changeNarrativeMode({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      request: {
        expected_control_revision: room.control_revision,
        mode: 'dual_pov',
        idempotency_key: 'policy-mode-dual'
      }
    });
    const materializedDual = await billing.credentialPolicies.materializeActiveTurn({
      authenticated_user_id: USER_B,
      room_id: 'room_billing'
    });
    assert.equal(materializedDual.materialized.payer_seat, 'A');
    assert.deepEqual(connection.read(database => database.prepare(`
      SELECT scope, audience, payer_seat_id, selected_narrative_mode
        FROM turn_model_selections
       WHERE turn_id = ? AND active = 1
       ORDER BY scope, audience
    `).all(turn.turn_id)), [
      {
        scope: 'shared',
        audience: 'shared',
        payer_seat_id: 'A',
        selected_narrative_mode: 'dual_pov'
      },
      { scope: 'writer', audience: 'A', payer_seat_id: 'A', selected_narrative_mode: 'dual_pov' },
      { scope: 'writer', audience: 'B', payer_seat_id: 'A', selected_narrative_mode: 'dual_pov' }
    ]);
    assert.equal(readTurnActionLockReadiness(
      connection.reader,
      turn.turn_id
    ).ready, true);
    room = core.rooms.getForMember({ authenticated_user_id: USER_A, room_id: 'room_billing' });
    await core.turns.lockAction({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      request: action('策略测试 A', 'policy-action-a')
    });
    room = core.rooms.getForMember({ authenticated_user_id: USER_B, room_id: 'room_billing' });
    await assert.rejects(() => billing.credentialPolicies.choose({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      policy: 'B_ONLY',
      expected_policy_revision: selectedByB.credential_policy.policy_revision,
      expected_control_revision: room.control_revision
    }), expectDomain('EXECUTION_PLAN_FROZEN'));
    await core.turns.lockAction({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      request: action('策略测试 B', 'policy-action-b')
    });
    const policyPlan = await billingPlanService.ensureForSealedTurn({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_id: turn.turn_id
    });
    const automatic = await billing.credentialPolicies.autoAuthorizePlan({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      plan_hash: policyPlan.plan.plan_hash
    });
    assert.equal(automatic.payer_seat, 'A');
    assert.equal(automatic.advanced, true);
    assert.equal(automatic.turn_status, 'RESOLVING');
    assert.equal(connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM turn_billing_authorizations
       WHERE plan_hash = ? AND payer_user_id = ?
    `).get(policyPlan.plan.plan_hash, USER_A).count), 1);

    await connection.write(database => {
      database.prepare(`
        DELETE FROM room_outbox
         WHERE event_id IN (
           SELECT event_id FROM room_events
            WHERE turn_id = ? AND event_type IN (
              'action.locked', 'turn.sealed', 'billing.plan_ready',
              'billing.authorization_required', 'resolution.progress'
            )
         )
      `).run(turn.turn_id);
      database.prepare(`
        DELETE FROM room_events
         WHERE turn_id = ? AND event_type IN (
           'action.locked', 'turn.sealed', 'billing.plan_ready',
           'billing.authorization_required', 'resolution.progress'
         )
      `).run(turn.turn_id);
      database.prepare(`DELETE FROM turn_billing_authorizations WHERE plan_hash = ?`)
        .run(policyPlan.plan.plan_hash);
      database.prepare(`DELETE FROM model_execution_grants WHERE grant_id = ?`)
        .run(automatic.grant_id);
      database.prepare(`DELETE FROM turn_billing_plans WHERE turn_id = ?`)
        .run(turn.turn_id);
      database.prepare(`DELETE FROM action_submissions WHERE turn_id = ?`)
        .run(turn.turn_id);
      database.prepare(`DELETE FROM data_processing_consents WHERE room_id = ?`)
        .run('room_billing');
      database.prepare(`DELETE FROM turn_model_selections WHERE turn_id = ?`)
        .run(turn.turn_id);
      database.prepare(`DELETE FROM room_credential_policy_acceptances WHERE room_id = ?`)
        .run('room_billing');
      database.prepare(`DELETE FROM room_model_profile_bindings WHERE room_id = ?`)
        .run('room_billing');
      database.prepare(`
        UPDATE multiplayer_rooms
           SET credential_usage_policy = 'ALTERNATE', credential_policy_revision = 0
         WHERE room_id = ?
      `).run('room_billing');
      database.prepare(`
        UPDATE multiplayer_turns
           SET turn_status = 'AWAITING_PAYER_SELECTION', execution_plan_json = NULL,
               execution_plan_hash = NULL, input_hash = NULL, sealed_at = NULL
         WHERE turn_id = ?
      `).run(turn.turn_id);
    });
  });

  await test('shared/A/B selections use control+selection CAS and payer/POV-owner self authority', async () => {
    const room = core.rooms.getForMember({ authenticated_user_id: USER_A, room_id: 'room_billing' });
    if (!turn) {
      turn = await core.turns.open({
        authenticated_user_id: USER_A,
        room_id: 'room_billing',
        expected_control_revision: room.control_revision
      });
    } else {
      turn = { ...turn, control_revision: room.control_revision };
    }
    sharedSelection = await billing.selections.selectShared({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      endpoint_profile_id: 'profile_a',
      expected_selection_revision: 0,
      expected_control_revision: turn.control_revision,
      idempotency_key: 'shared-a-1'
    });
    const beforeFailure = billing.selections.getActive({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    await connection.write(database => database.exec(`
      CREATE TEMP TRIGGER inject_selection_insert_failure
      BEFORE INSERT ON turn_model_selections
      BEGIN
        SELECT RAISE(ABORT, 'injected selection failure');
      END
    `));
    await assert.rejects(() => billing.selections.selectShared({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      endpoint_profile_id: 'profile_a',
      expected_selection_revision: 1,
      expected_control_revision: sharedSelection.control_revision,
      idempotency_key: 'shared-injected-failure'
    }), /injected selection failure/u);
    await connection.write(database => database.exec(`
      DROP TRIGGER inject_selection_insert_failure
    `));
    const afterFailure = billing.selections.getActive({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    assert.equal(afterFailure.selection_hashes.shared, beforeFailure.selection_hashes.shared);
    assert.equal(afterFailure.control_revision, beforeFailure.control_revision);

    const beforeOutboxFailure = connection.read(database => ({
      selection_hash: database.prepare(`
        SELECT selection_hash FROM turn_model_selections
         WHERE turn_id = ? AND scope = 'shared' AND audience = 'shared' AND active = 1
      `).get(turn.turn_id).selection_hash,
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq,
      events: database.prepare(`
        SELECT COUNT(*) AS count FROM room_events WHERE room_id = 'room_billing'
      `).get().count,
      outbox: database.prepare(`
        SELECT COUNT(*) AS count FROM room_outbox WHERE room_id = 'room_billing'
      `).get().count
    }));
    await connection.write(database => database.exec(`
      CREATE TEMP TRIGGER inject_selection_outbox_failure
      BEFORE INSERT ON room_outbox
      BEGIN
        SELECT RAISE(ABORT, 'injected selection outbox failure');
      END
    `));
    await assert.rejects(() => billing.selections.selectShared({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      endpoint_profile_id: 'profile_a',
      expected_selection_revision: 1,
      expected_control_revision: sharedSelection.control_revision,
      idempotency_key: 'shared-outbox-failure'
    }), /injected selection outbox failure/u);
    await connection.write(database => database.exec(`
      DROP TRIGGER inject_selection_outbox_failure
    `));
    const afterOutboxFailure = connection.read(database => ({
      selection_hash: database.prepare(`
        SELECT selection_hash FROM turn_model_selections
         WHERE turn_id = ? AND scope = 'shared' AND audience = 'shared' AND active = 1
      `).get(turn.turn_id).selection_hash,
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq,
      events: database.prepare(`
        SELECT COUNT(*) AS count FROM room_events WHERE room_id = 'room_billing'
      `).get().count,
      outbox: database.prepare(`
        SELECT COUNT(*) AS count FROM room_outbox WHERE room_id = 'room_billing'
      `).get().count
    }));
    assert.deepEqual(afterOutboxFailure, beforeOutboxFailure);

    writerASelection = await billing.selections.selectWriter({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'A',
      endpoint_profile_id: 'profile_b',
      expected_selection_revision: 0,
      expected_control_revision: sharedSelection.control_revision,
      idempotency_key: 'writer-a-1'
    });
    writerBSelection = await billing.selections.selectWriter({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'B',
      endpoint_profile_id: 'profile_a',
      expected_selection_revision: 0,
      expected_control_revision: writerASelection.control_revision,
      idempotency_key: 'writer-b-sponsored-1'
    });
    await assert.rejects(() => billing.selections.acceptWriterAudience({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'B',
      selection_revision: 1,
      expected_control_revision: writerBSelection.control_revision,
      idempotency_key: 'wrong-owner'
    }), expectDomain('POV_OWNER_SELF_REQUIRED'));
    const active = billing.selections.getActive({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    assert.equal(active.ready, true);
    assert.equal(active.turn_payer_selection.payer_user_id, USER_A);
    assert.equal(active.pov_writer_selections.A.payer_user_id, USER_B);
    assert.equal(active.pov_writer_selections.A.audience_owner_user_id, USER_A);
    assert.equal(active.pov_writer_selections.B.payer_user_id, USER_A);
    assert.equal(active.pov_writer_selections.B.audience_owner_user_id, USER_B);
    assert.equal(active.pov_writer_selections.B.audience_accepted_at, null);
    assert.equal(writerBSelection.turn_status, 'COLLECTING_ACTIONS');
    assert.deepEqual(connection.read(database => database.prepare(`
      SELECT scope, audience, selected_narrative_mode
        FROM turn_model_selections
       WHERE turn_id = ? AND active = 1
       ORDER BY scope, audience
    `).all(turn.turn_id)), [
      { scope: 'shared', audience: 'shared', selected_narrative_mode: 'dual_pov' },
      { scope: 'writer', audience: 'A', selected_narrative_mode: 'dual_pov' },
      { scope: 'writer', audience: 'B', selected_narrative_mode: 'dual_pov' }
    ]);

    await connection.write(database => {
      database.prepare(`
        UPDATE turn_model_selections SET active = 0
         WHERE selection_id = ? AND active = 1
      `).run(writerASelection.selection.selection_id);
      database.prepare(`
        UPDATE multiplayer_turns SET turn_status = 'AWAITING_PAYER_SELECTION'
         WHERE turn_id = ? AND turn_status = 'COLLECTING_ACTIONS'
      `).run(turn.turn_id);
    });
    writerASelection = await billing.selections.selectWriter({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'A',
      endpoint_profile_id: 'profile_b',
      expected_selection_revision: 1,
      expected_control_revision: writerBSelection.control_revision,
      idempotency_key: 'writer-a-after-mode-invalidation-2'
    });
    assert.equal(writerASelection.selection.selection_revision, 2);
    assert.equal(writerASelection.turn_status, 'COLLECTING_ACTIONS');
    assert.deepEqual(connection.read(database => database.prepare(`
      SELECT selection_revision, active, selected_narrative_mode
        FROM turn_model_selections
       WHERE turn_id = ? AND scope = 'writer' AND audience = 'A'
       ORDER BY selection_revision
    `).all(turn.turn_id)), [
      { selection_revision: 1, active: 0, selected_narrative_mode: 'dual_pov' },
      { selection_revision: 2, active: 1, selected_narrative_mode: 'dual_pov' }
    ]);

    writerAAcceptanceRequest = {
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'A',
      selection_revision: 2,
      expected_control_revision: writerASelection.control_revision,
      idempotency_key: 'writer-a-owner-accept-2'
    };
    writerASelection = await billing.selections.acceptWriterAudience(writerAAcceptanceRequest);
    const acceptanceReplay = await billing.selections.acceptWriterAudience(
      writerAAcceptanceRequest
    );
    assert.deepEqual(acceptanceReplay, { ...writerASelection, replayed: true });
    await assert.rejects(() => billing.selections.acceptWriterAudience({
      ...writerAAcceptanceRequest,
      expected_control_revision: writerASelection.control_revision
    }), expectDomain('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(() => billing.selections.acceptWriterAudience({
      ...writerAAcceptanceRequest,
      selection_revision: 1
    }), expectDomain('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(() => billing.selections.acceptWriterAudience({
      ...writerAAcceptanceRequest,
      expected_control_revision: writerASelection.control_revision,
      idempotency_key: 'writer-a-owner-second-key'
    }), expectDomain('IDEMPOTENCY_CONFLICT'));
    const acceptanceReceipt = connection.read(database => database.prepare(`
      SELECT selection_id, audience, idempotency_key, request_hash,
             expected_control_revision, result_control_revision,
             result_turn_status, result_selection_hash
        FROM writer_audience_acceptance_requests
       WHERE turn_id = ?
    `).get(turn.turn_id));
    assert.deepEqual({ ...acceptanceReceipt, request_hash: undefined }, {
      selection_id: writerASelection.selection.selection_id,
      audience: 'A',
      idempotency_key: writerAAcceptanceRequest.idempotency_key,
      request_hash: undefined,
      expected_control_revision: writerAAcceptanceRequest.expected_control_revision,
      result_control_revision: writerASelection.control_revision,
      result_turn_status: writerASelection.turn_status,
      result_selection_hash: writerASelection.selection.selection_hash
    });
    assert.match(acceptanceReceipt.request_hash, /^sha256:[a-f0-9]{64}$/u);
  });

  await test('Writer exact replay precedes mode gates and inactive receipts cannot regain authority', async () => {
    const sharedMode = await core.turns.changeNarrativeMode({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      request: {
        expected_control_revision: writerASelection.control_revision,
        mode: 'shared',
        idempotency_key: 'mode-shared-writer-replay'
      }
    });
    const replay = await billing.selections.selectWriter({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'A',
      endpoint_profile_id: 'profile_b',
      expected_selection_revision: 1,
      expected_control_revision: writerBSelection.control_revision,
      idempotency_key: 'writer-a-after-mode-invalidation-2'
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.selection.selection_revision, 2);
    assert.equal(replay.selection.active, false);
    await assert.rejects(() => billing.selections.selectWriter({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'A',
      endpoint_profile_id: 'profile_b',
      expected_selection_revision: 2,
      expected_control_revision: writerBSelection.control_revision,
      idempotency_key: 'writer-a-after-mode-invalidation-2'
    }), expectDomain('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(() => billing.selections.selectWriter({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'A',
      endpoint_profile_id: 'profile_b',
      expected_selection_revision: 2,
      expected_control_revision: sharedMode.control_revision,
      idempotency_key: 'writer-new-key-in-shared-mode'
    }), expectDomain('INVALID_POV_SELECTION'));

    const acceptanceReplay = await billing.selections.acceptWriterAudience(
      writerAAcceptanceRequest
    );
    assert.equal(acceptanceReplay.replayed, true);
    assert.equal(acceptanceReplay.selection.active, false);
    assert.equal(acceptanceReplay.control_revision, writerASelection.control_revision);
    assert.equal(acceptanceReplay.turn_status, writerASelection.turn_status);

    const dualMode = await core.turns.changeNarrativeMode({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      request: {
        expected_control_revision: sharedMode.control_revision,
        mode: 'dual_pov',
        idempotency_key: 'mode-dual-writer-reselect'
      }
    });
    sharedSelection = await billing.selections.selectShared({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      endpoint_profile_id: 'profile_a',
      expected_selection_revision: 1,
      expected_control_revision: dualMode.control_revision,
      idempotency_key: 'shared-a-mode-reselect-2'
    });
    writerBSelection = await billing.selections.selectWriter({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'B',
      endpoint_profile_id: 'profile_a',
      expected_selection_revision: 1,
      expected_control_revision: sharedSelection.control_revision,
      idempotency_key: 'writer-b-mode-reselect-2'
    });
    writerASelection = await billing.selections.selectWriter({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'A',
      endpoint_profile_id: 'profile_b',
      expected_selection_revision: 2,
      expected_control_revision: writerBSelection.control_revision,
      idempotency_key: 'writer-a-mode-reselect-3'
    });
    assert.equal(writerASelection.selection.selection_revision, 3);
    assert.equal(writerASelection.turn_status, 'COLLECTING_ACTIONS');
    await assert.rejects(() => billing.selections.acceptWriterAudience({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'A',
      selection_revision: 3,
      expected_control_revision: writerASelection.control_revision,
      idempotency_key: writerAAcceptanceRequest.idempotency_key
    }), expectDomain('IDEMPOTENCY_CONFLICT'));
    assert.equal(billing.selections.getActive({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    }).pov_writer_selections.A.audience_accepted_at, null);
  });

  await test('payer-selection SSE projections are per-member safe and outbox-complete', async () => {
    const projectionA = billing.selections.getMemberProjection({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    const projectionB = billing.selections.getMemberProjection({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    assert.equal(projectionA.shared.payer_seat, 'A');
    assert.equal(projectionA.A.payer_seat, 'B');
    assert.equal(projectionA.B.payer_seat, 'A');
    assert.equal(projectionA.A.viewer_consent.required, true);
    assert.equal(projectionA.B.viewer_consent.required, true);
    assert.equal(projectionB.B.viewer_consent.required, true);
    assert.equal(projectionB.A.viewer_consent.required, true);
    assert.equal(
      projectionB.shared.profile_ref.endpoint.normalized_base_url,
      'https://api.example.com/v1'
    );
    assert.deepEqual(projectionB.shared.profile_ref.transport_capabilities, {
      native_tools: true,
      strict_json: true,
      error_correction_continuation: true,
      recommended_continuity_transport: 'native_tools'
    });
    assert.deepEqual(projectionB.shared.data_categories, SHARED_STAGE_DATA_CATEGORIES);
    assert.equal(
      projectionB.shared.terms_revision,
      MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION
    );

    const forbiddenKeys = [
      'credential_ref',
      'owner_user_id',
      'payer_user_id',
      'audience_owner_user_id',
      'idempotency_key'
    ];
    for (const projection of [projectionA, projectionB]) {
      const serialized = JSON.stringify(projection);
      for (const key of forbiddenKeys) assert.equal(serialized.includes(`"${key}"`), false, key);
      for (const secret of [SECRET_A_1, SECRET_A_2, SECRET_B, USER_A, USER_B]) {
        assert.equal(serialized.includes(secret), false, secret);
      }
    }

    const payerEventsA = core.events.listAfter({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      after_event_seq: 0,
      limit: 500
    }).filter(event => event.event_type === 'billing.payer_selection_changed');
    const payerEventsB = core.events.listAfter({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      after_event_seq: 0,
      limit: 500
    }).filter(event => event.event_type === 'billing.payer_selection_changed');
    assert.equal(payerEventsA.length, 8);
    assert.equal(payerEventsB.length, 8);
    assert.equal(payerEventsA.every(event => event.audience === 'A'), true);
    assert.equal(payerEventsB.every(event => event.audience === 'B'), true);
    assert.equal(
      payerEventsB.at(-1).payload.payer_selection.selection_hash,
      projectionB.A.selection_hash
    );
    const persisted = connection.read(database => ({
      events: database.prepare(`
        SELECT COUNT(*) AS count FROM room_events
         WHERE room_id = 'room_billing' AND event_type = 'billing.payer_selection_changed'
      `).get().count,
      paired_outbox: database.prepare(`
        SELECT COUNT(*) AS count
          FROM room_events AS e
          JOIN room_outbox AS o ON o.event_id = e.event_id AND o.room_id = e.room_id
         WHERE e.room_id = 'room_billing'
           AND e.event_type = 'billing.payer_selection_changed'
           AND o.outbox_status = 'PENDING'
      `).get().count
    }));
    assert.deepEqual(persisted, { events: 16, paired_outbox: 16 });
  });

  await test('execution grant revisions are payer-owned and retain one active revision', async () => {
    const scopes = [
      ...[
        'referee',
        'resolution_completeness_reviewer',
        'resolution_repair',
        'continuity_steward',
        'continuity_repair',
        'narrative_grounding_reviewer'
      ].map(stage => ({ stage, audience: null })),
      { stage: 'writer', audience: 'A' },
      { stage: 'writer', audience: 'B' }
    ];
    const base = {
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      grant_id: 'grant_a',
      endpoint_profile_id: 'profile_a',
      profile_revision: 2,
      stage_scopes: scopes,
      authorization_scope: { kind: 'single_turn', turn_id: turn.turn_id },
      budget: {
        max_requests: 32,
        max_input_tokens: 10_000,
        max_output_tokens: 10_000,
        max_retries: 16,
        estimated_cost_cap: null
      },
      expires_at: '2026-08-23T00:00:00.000Z'
    };
    await billing.grants.createVersion({ ...base, expected_grant_revision: 0 });
    grantA2 = (await billing.grants.createVersion({ ...base, expected_grant_revision: 1 })).grant;
    assert.equal(grantA2.grant_revision, 2);
    assert.equal(billing.grants.list({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      include_inactive: false
    }).length, 1);
    assert.throws(() => billing.grants.list({
      authenticated_user_id: '111111111111111111',
      room_id: 'room_billing'
    }), expectDomain('ROOM_MEMBERSHIP_REQUIRED'));
  });

  await test('sponsored POV requires owner and sponsor DPC while self-paid replacement stays owner-only', async () => {
    const beforeConsent = connection.read(database => (
      readTurnActionLockReadiness(database, turn.turn_id)
    ));
    assert.equal(beforeConsent.selection_ready, true);
    assert.equal(beforeConsent.ready, false);
    assert.equal(beforeConsent.blockers.every(blocker => (
      blocker.kind === 'data_processing_consent'
    )), true);
    await assert.rejects(() => core.turns.lockAction({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      request: action('同意前不得锁定', 'action-a-before-consent')
    }), expectDomain('DATA_PROCESSING_CONSENT_REQUIRED'));

    const active = billing.selections.getActive({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    const consentInputs = [
      [
        USER_A,
        active.selection_hashes.shared,
        profileA2.profile.config_fingerprint,
        SHARED_STAGE_DATA_CATEGORIES
      ],
      [
        USER_B,
        active.selection_hashes.shared,
        profileA2.profile.config_fingerprint,
        SHARED_STAGE_DATA_CATEGORIES
      ],
      [
        USER_A,
        active.selection_hashes.writer.A,
        profileB.profile.config_fingerprint,
        POV_WRITER_DATA_CATEGORIES
      ],
      [
        USER_B,
        active.selection_hashes.writer.B,
        profileA2.profile.config_fingerprint,
        POV_WRITER_DATA_CATEGORIES
      ]
    ];
    for (const [
      subjectUserId,
      selectionHash,
      configFingerprint,
      dataCategories
    ] of consentInputs) {
      await billing.consents.grant({
        authenticated_user_id: subjectUserId,
        room_id: 'room_billing',
        epoch_id: 'epoch_billing',
        selection_hash: selectionHash,
        config_fingerprint: configFingerprint,
        terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
        data_categories: dataCategories
      });
    }
    const afterOwnerConsent = connection.read(database => (
      readTurnActionLockReadiness(database, turn.turn_id)
    ));
    assert.equal(afterOwnerConsent.ready, false);
    assert.deepEqual(
      afterOwnerConsent.blockers.map(blocker => ({
        subject_user_id: blocker.subject_user_id,
        selection_hash: blocker.selection_hash
      })),
      [
        { subject_user_id: USER_B, selection_hash: active.selection_hashes.writer.A },
        { subject_user_id: USER_A, selection_hash: active.selection_hashes.writer.B }
      ]
    );
    for (const [subjectUserId, selectionHash, configFingerprint] of [
      [USER_B, active.selection_hashes.writer.A, profileB.profile.config_fingerprint],
      [USER_A, active.selection_hashes.writer.B, profileA2.profile.config_fingerprint]
    ]) {
      await billing.consents.grant({
        authenticated_user_id: subjectUserId,
        room_id: 'room_billing',
        epoch_id: 'epoch_billing',
        selection_hash: selectionHash,
        config_fingerprint: configFingerprint,
        terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
        data_categories: POV_WRITER_DATA_CATEGORIES
      });
    }
    const afterConsent = connection.read(database => (
      readTurnActionLockReadiness(database, turn.turn_id)
    ));
    assert.equal(afterConsent.ready, true);
    const restoredForB = billing.selections.getMemberProjection({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    assert.deepEqual(restoredForB.shared.viewer_consent, { required: true, granted: true });
    assert.deepEqual(restoredForB.B.viewer_consent, { required: true, granted: true });
    assert.deepEqual(restoredForB.A.viewer_consent, { required: true, granted: true });
    const sponsorConsentCount = connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM data_processing_consents
       WHERE room_id = 'room_billing' AND scope_epoch_id = 'epoch_billing'
         AND subject_user_id = ? AND selection_hash = ?
    `).get(USER_B, active.selection_hashes.writer.A).count);
    assert.equal(sponsorConsentCount, 1, 'the POV sponsor must grant a separate Writer DPC');

    await connection.write(database => database.exec(`
      CREATE TEMP TRIGGER rollback_sponsored_action_after_gate
      BEFORE INSERT ON action_submissions
      BEGIN
        SELECT RAISE(ABORT, 'injected sponsored action rollback');
      END
    `));
    await assert.rejects(() => core.turns.lockAction({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      request: action('B 赞助 A 视角时通过门禁', 'action-a-sponsored-gate')
    }), /injected sponsored action rollback/u);
    await connection.write(database => database.exec(`
      DROP TRIGGER rollback_sponsored_action_after_gate
    `));

    writerASelection = await billing.selections.selectWriter({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      audience: 'A',
      endpoint_profile_id: 'profile_a',
      expected_selection_revision: 3,
      expected_control_revision: writerASelection.control_revision,
      idempotency_key: 'writer-a-self-replacement-2'
    });
    await billing.consents.grant({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      selection_hash: writerASelection.selection.selection_hash,
      config_fingerprint: profileA2.profile.config_fingerprint,
      terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
      data_categories: POV_WRITER_DATA_CATEGORIES
    });
    const afterReplacement = connection.read(database => (
      readTurnActionLockReadiness(database, turn.turn_id)
    ));
    assert.equal(afterReplacement.ready, true);
    const selfPaidProjectionForB = billing.selections.getMemberProjection({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    assert.deepEqual(
      selfPaidProjectionForB.A.viewer_consent,
      { required: false, granted: false },
      'a self-paid A Writer must not expand consent to B'
    );

    const locked = await core.turns.lockAction({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      request: action('A 的封存行动', 'action-a-1')
    });
    const replay = await billing.selections.selectShared({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      endpoint_profile_id: 'profile_a',
      expected_selection_revision: 0,
      expected_control_revision: turn.control_revision,
      idempotency_key: 'shared-a-1'
    });
    assert.equal(replay.replayed, true);
    await assert.rejects(() => billing.selections.selectShared({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      endpoint_profile_id: 'profile_a',
      expected_selection_revision: 1,
      expected_control_revision: locked.control_revision,
      idempotency_key: 'shared-after-action'
    }), expectDomain('EXECUTION_PLAN_FROZEN'));
    const second = await core.turns.lockAction({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1,
      request: action('B 的封存行动', 'action-b-1')
    });
    assert.equal(second.turn_status, 'SEALED');
  });

  await test('append-only consents preserve grant/revoke history instead of overwriting', async () => {
    const active = billing.selections.getActive({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    const sharedHash = active.selection_hashes.shared;
    const configHash = profileA2.profile.config_fingerprint;
    await billing.consents.grant({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      selection_hash: sharedHash,
      config_fingerprint: configHash,
      terms_revision: 'terms-v1',
      data_categories: ['action_text', 'canonical_state']
    });
    consentBShared = (await billing.consents.grant({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      selection_hash: sharedHash,
      config_fingerprint: configHash,
      terms_revision: 'terms-v1',
      data_categories: ['action_text', 'canonical_state']
    })).consent;
    const revoked = await billing.consents.revoke({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      consent_id: consentBShared.consent_id
    });
    assert.equal(revoked.consent.action, 'REVOKED');
    const count = connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM data_processing_consents
       WHERE consent_series_id = ?
    `).get(consentBShared.consent_series_id).count);
    assert.equal(count, 2);
    consentBShared = (await billing.consents.grant({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      selection_hash: sharedHash,
      config_fingerprint: configHash,
      terms_revision: 'terms-v1',
      data_categories: ['action_text', 'canonical_state']
    })).consent;
    assert.equal(consentBShared.consent_revision, 3);

    for (const [subject, selectionHash] of [
      [USER_A, active.selection_hashes.writer.A],
      [USER_B, active.selection_hashes.writer.B]
    ]) {
      await billing.consents.grant({
        authenticated_user_id: subject,
        room_id: 'room_billing',
        epoch_id: 'epoch_billing',
        selection_hash: selectionHash,
        config_fingerprint: configHash,
        terms_revision: 'terms-v1',
        data_categories: ['private_projection']
      });
    }
  });

  await test('initial billing plan binds exact selection/profile/probe and payer authorizes only self', async () => {
    const active = billing.selections.getActive({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    const ref = profileRef(profileA2);
    const probeRef = { probe_revision: probeA.probe_revision, probe_hash: probeA.probe_hash };
    const sharedStages = [
      'referee',
      'resolution_completeness_reviewer',
      'resolution_repair',
      'continuity_steward',
      'continuity_repair',
      'narrative_grounding_reviewer'
    ];
    const stagePlans = sharedStages.map(stage => ({
      plan_item_id: `plan_item_${stage}`,
      stage,
      audience: null,
      payer_user_id: USER_A,
      payer_seat: 'A',
      profile_ref: ref,
      capability_probe_ref: probeRef,
      transport: stage.startsWith('continuity_') ? 'json_protocol' : null,
      budget: stageBudget(),
      required_consent_subject_user_ids: [USER_A, USER_B]
    }));
    stagePlans.push({
      plan_item_id: 'plan_item_writer_a',
      stage: 'writer',
      audience: 'A',
      payer_user_id: USER_A,
      payer_seat: 'A',
      profile_ref: ref,
      capability_probe_ref: probeRef,
      transport: null,
      budget: stageBudget(),
      required_consent_subject_user_ids: [USER_A]
    }, {
      plan_item_id: 'plan_item_writer_b',
      stage: 'writer',
      audience: 'B',
      payer_user_id: USER_A,
      payer_seat: 'A',
      profile_ref: ref,
      capability_probe_ref: probeRef,
      transport: null,
      budget: stageBudget(),
      required_consent_subject_user_ids: [USER_A, USER_B]
    });
    const underScopedSponsorPlan = stagePlans.map(item => (
      item.plan_item_id === 'plan_item_writer_b'
        ? { ...item, required_consent_subject_user_ids: [USER_B] }
        : item
    ));
    await assert.rejects(() => billing.plans.append({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_id: turn.turn_id,
      stage_plans: underScopedSponsorPlan
    }), expectDomain('BILLING_PLAN_CONSENT_SUBJECT_MISMATCH'));
    const overScopedSelfPaidPlan = stagePlans.map(item => (
      item.plan_item_id === 'plan_item_writer_a'
        ? { ...item, required_consent_subject_user_ids: [USER_A, USER_B] }
        : item
    ));
    await assert.rejects(() => billing.plans.append({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_id: turn.turn_id,
      stage_plans: overScopedSelfPaidPlan
    }), expectDomain('BILLING_PLAN_CONSENT_SUBJECT_MISMATCH'));
    plan1 = (await billing.plans.append({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_id: turn.turn_id,
      stage_plans: stagePlans
    })).plan;
    const planReplay = await billing.plans.append({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_id: turn.turn_id,
      stage_plans: stagePlans
    });
    assert.equal(planReplay.replayed, true);
    assert.equal(planReplay.plan.plan_hash, plan1.plan_hash);
    assert.equal(plan1.turn_payer_selection_hash, active.selection_hashes.shared);
    const beforeAuthorization = connection.read(database => ({
      turn_status: database.prepare(`
        SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(turn.turn_id).turn_status,
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      epoch_control_revision: database.prepare(`
        SELECT control_revision FROM room_epochs WHERE epoch_id = 'epoch_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq,
      authorizations: database.prepare(`
        SELECT COUNT(*) AS count FROM turn_billing_authorizations WHERE plan_hash = ?
      `).get(plan1.plan_hash).count
    }));
    assert.equal(beforeAuthorization.turn_status, 'AWAITING_BILLING_AUTHORIZATION');
    await assert.rejects(() => billing.plans.authorize({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      grant_id: 'grant_a',
      grant_revision: 2
    }), expectDomain('PAYER_SELF_REQUIRED'));

    await connection.write(database => database.exec(`
      CREATE TEMP TRIGGER inject_resolution_start_outbox_failure
      BEFORE INSERT ON room_outbox
      BEGIN
        SELECT RAISE(ABORT, 'injected resolution-start outbox failure');
      END
    `));
    await assert.rejects(() => billing.plans.authorize({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      grant_id: 'grant_a',
      grant_revision: 2
    }), /injected resolution-start outbox failure/u);
    await connection.write(database => database.exec(`
      DROP TRIGGER inject_resolution_start_outbox_failure
    `));
    const afterRolledBackAuthorization = connection.read(database => ({
      turn_status: database.prepare(`
        SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(turn.turn_id).turn_status,
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      epoch_control_revision: database.prepare(`
        SELECT control_revision FROM room_epochs WHERE epoch_id = 'epoch_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq,
      authorizations: database.prepare(`
        SELECT COUNT(*) AS count FROM turn_billing_authorizations WHERE plan_hash = ?
      `).get(plan1.plan_hash).count
    }));
    assert.deepEqual(afterRolledBackAuthorization, beforeAuthorization);

    const authorization = await billing.plans.authorize({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      grant_id: 'grant_a',
      grant_revision: 2
    });
    assert.equal(authorization.payer_user_id, USER_A);
    assert.equal(authorization.accepted_budget.plan_item_ids.length, 8);
    const afterAuthorization = connection.read(database => ({
      turn_status: database.prepare(`
        SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(turn.turn_id).turn_status,
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      epoch_control_revision: database.prepare(`
        SELECT control_revision FROM room_epochs WHERE epoch_id = 'epoch_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq,
      resolution_events: database.prepare(`
        SELECT COUNT(*) AS count FROM room_events
         WHERE room_id = 'room_billing' AND event_type = 'resolution.progress'
      `).get().count,
      paired_outbox: database.prepare(`
        SELECT COUNT(*) AS count
          FROM room_events AS e
          JOIN room_outbox AS o ON o.event_id = e.event_id AND o.room_id = e.room_id
         WHERE e.room_id = 'room_billing'
           AND e.event_type = 'resolution.progress'
           AND o.outbox_status = 'PENDING'
      `).get().count
    }));
    assert.deepEqual(afterAuthorization, {
      turn_status: 'RESOLVING',
      control_revision: beforeAuthorization.control_revision + 1,
      epoch_control_revision: beforeAuthorization.control_revision + 1,
      event_seq: beforeAuthorization.event_seq + 2,
      resolution_events: 2,
      paired_outbox: 2
    });
    for (const [viewer, expectedSeat] of [[USER_A, 'A'], [USER_B, 'B']]) {
      const events = core.events.listAfter({
        authenticated_user_id: viewer,
        room_id: 'room_billing',
        after_event_seq: beforeAuthorization.event_seq,
        limit: 10
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, 'resolution.progress');
      assert.deepEqual(events[0].payload, {
        turn_id: turn.turn_id,
        turn_no: 1,
        viewer_seat: expectedSeat,
        status: 'RESOLVING',
        control_revision: afterAuthorization.control_revision
      });
      const serialized = JSON.stringify(events[0]);
      for (const forbidden of [USER_A, USER_B, plan1.plan_hash, 'grant_a', 'payer_user_id']) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
    }
    const replayedAuthorization = await billing.plans.authorize({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      grant_id: 'grant_a',
      grant_revision: 2
    });
    assert.equal(replayedAuthorization.replayed, true);
    const afterReplay = connection.read(database => ({
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq,
      resolution_events: database.prepare(`
        SELECT COUNT(*) AS count FROM room_events
         WHERE room_id = 'room_billing' AND event_type = 'resolution.progress'
      `).get().count
    }));
    assert.deepEqual(afterReplay, {
      control_revision: afterAuthorization.control_revision,
      event_seq: afterAuthorization.event_seq,
      resolution_events: 2
    });
  });

  await test('invocation consent requires the exact current terms and full category hash', async () => {
    const active = billing.selections.getActive({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    const exact = billing.consents.listActive({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing'
    }).find(consent => (
      consent.selection_hash === active.selection_hashes.shared
        && consent.config_fingerprint === profileA2.profile.config_fingerprint
        && consent.terms_revision === MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION
    ));
    assert.ok(exact, 'the exact shared consent must be present');
    await billing.consents.grant({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      selection_hash: active.selection_hashes.shared,
      config_fingerprint: profileA2.profile.config_fingerprint,
      terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
      data_categories: ['canonical_room_state']
    });
    await billing.consents.revoke({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      consent_id: exact.consent_id
    });
    await assert.rejects(() => billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'continuity_steward',
      audience: null,
      attempt: 1,
      invocation_id: 'invocation_without_exact_consent',
      reserved_input_tokens: 10,
      reserved_output_tokens: 10
    }), expectDomain('DATA_PROCESSING_CONSENT_REQUIRED'));
    await billing.consents.grant({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      selection_hash: active.selection_hashes.shared,
      config_fingerprint: profileA2.profile.config_fingerprint,
      terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
      data_categories: SHARED_STAGE_DATA_CATEGORIES
    });
  });

  await test('outbound preflight recomputes exact POV consent subjects from authoritative routing', async () => {
    const persisted = connection.read(database => database.prepare(`
      SELECT stage_plans_json FROM turn_billing_plans WHERE plan_hash = ?
    `).get(plan1.plan_hash).stage_plans_json);
    const underScoped = JSON.parse(persisted);
    underScoped.find(item => item.plan_item_id === 'plan_item_writer_b')
      .required_consent_subject_user_ids = [USER_B];
    await connection.write(database => database.prepare(`
      UPDATE turn_billing_plans SET stage_plans_json = ? WHERE plan_hash = ?
    `).run(JSON.stringify(underScoped), plan1.plan_hash));
    try {
      await assert.rejects(() => billing.usage.start({
        authenticated_user_id: USER_A,
        room_id: 'room_billing',
        plan_hash: plan1.plan_hash,
        stage: 'writer',
        audience: 'B',
        attempt: 1,
        invocation_id: 'invocation_under_scoped_persisted_plan'
      }), expectDomain('PERSISTED_BILLING_CORRUPT'));
      assert.equal(connection.read(database => database.prepare(`
        SELECT COUNT(*) AS count FROM ai_usage_ledger WHERE invocation_id = ?
      `).get('invocation_under_scoped_persisted_plan').count), 0);
    } finally {
      await connection.write(database => database.prepare(`
        UPDATE turn_billing_plans SET stage_plans_json = ? WHERE plan_hash = ?
      `).run(persisted, plan1.plan_hash));
    }
  });

  await test('usage ledger is CAS-controlled and UNKNOWN rejects late ACK/new duplicate attempts', async () => {
    const acknowledged = await billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'referee',
      audience: null,
      attempt: 1,
      invocation_id: 'invocation_referee_1'
    });
    assert.equal(acknowledged.usage.status, 'IN_FLIGHT');
    const success = await billing.usage.acknowledge({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: 'invocation_referee_1',
      provider_request_id: 'provider-request-1',
      input_tokens: 120,
      output_tokens: 80,
      estimated_cost: { currency: 'USD', amount_micros: 1234 }
    });
    assert.equal(success.usage.status, 'SUCCEEDED');

    unknownInvocation = (await billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'writer',
      audience: 'A',
      attempt: 1,
      invocation_id: 'invocation_writer_a_1'
    })).usage;
    await billing.usage.markUnknown({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: unknownInvocation.invocation_id
    });
    await assert.rejects(() => billing.usage.acknowledge({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: unknownInvocation.invocation_id,
      provider_request_id: 'late-provider-result'
    }), expectDomain('MODEL_USAGE_STATE_CONFLICT'));
    await assert.rejects(() => billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'writer',
      audience: 'A',
      attempt: 2,
      invocation_id: 'invocation_writer_a_2'
    }), expectDomain('MODEL_INVOCATION_UNRESOLVED'));

    const failed = await billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'resolution_repair',
      audience: null,
      attempt: 1,
      invocation_id: 'invocation_resolution_repair_1'
    });
    assert.equal(failed.usage.status, 'IN_FLIGHT');
    const failure = await billing.usage.fail({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: failed.usage.invocation_id,
      provider_request_id: 'provider-failed-1',
      input_tokens: 50,
      output_tokens: 0
    });
    assert.equal(failure.usage.status, 'FAILED');

    const abandoned = await billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'writer',
      audience: 'B',
      attempt: 1,
      invocation_id: 'invocation_writer_b_crash',
      reserved_input_tokens: 40,
      reserved_output_tokens: 30
    });
    const recovered = await billing.usage.recoverInflightAsUnknown({
      started_before: '2026-08-23T00:00:00.000Z'
    });
    assert.deepEqual(recovered, [abandoned.usage.invocation_id]);
    assert.equal(billing.usage.get({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      invocation_id: abandoned.usage.invocation_id
    }).status, 'UNKNOWN');
    await assert.rejects(() => billing.usage.abandonUnknown({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      invocation_id: abandoned.usage.invocation_id,
      accept_duplicate_billing_risk: true
    }), expectDomain('MODEL_INVOCATION_NOT_FOUND'));
    const cancelled = await billing.usage.abandonUnknown({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: abandoned.usage.invocation_id,
      accept_duplicate_billing_risk: true
    });
    assert.equal(cancelled.usage.status, 'CANCELLED');
    const retried = await billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'writer',
      audience: 'B',
      attempt: 2,
      invocation_id: 'invocation_writer_b_retry',
      reserved_input_tokens: 40,
      reserved_output_tokens: 30
    });
    assert.equal(retried.usage.status, 'IN_FLIGHT');
    assert.equal(retried.usage.reserved_retry_count, 1);
    await billing.usage.fail({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: retried.usage.invocation_id
    });

    const unsent = await billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'resolution_completeness_reviewer',
      audience: null,
      attempt: 1,
      invocation_id: 'invocation_released_unsent',
      reserved_input_tokens: 200,
      reserved_output_tokens: 100
    });
    const released = await billing.usage.fail({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: unsent.usage.invocation_id,
      release_budget: true
    });
    assert.equal(released.usage.budget_charge_state, 'RELEASED');
    const reused = await billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'resolution_completeness_reviewer',
      audience: null,
      attempt: 2,
      invocation_id: 'invocation_after_released_unsent',
      reserved_input_tokens: 200,
      reserved_output_tokens: 100
    });
    assert.equal(reused.usage.reserved_retry_count, 0);
    assert.equal('authorization_snapshot' in reused.usage, false);
    assert.equal(connection.read(database => database.prepare(`
      SELECT authorization_snapshot_json IS NOT NULL AS present
        FROM ai_usage_ledger WHERE invocation_id = ?
    `).get(reused.usage.invocation_id).present), 1);
    await billing.usage.fail({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: reused.usage.invocation_id,
      input_tokens: 10,
      output_tokens: 10
    });

    const concurrentStarts = await Promise.allSettled([
      billing.usage.start({
        authenticated_user_id: USER_A,
        room_id: 'room_billing',
        plan_hash: plan1.plan_hash,
        stage: 'narrative_grounding_reviewer',
        audience: null,
        attempt: 1,
        invocation_id: 'invocation_concurrent_budget_a',
        reserved_input_tokens: 150,
        reserved_output_tokens: 80
      }),
      billing.usage.start({
        authenticated_user_id: USER_A,
        room_id: 'room_billing',
        plan_hash: plan1.plan_hash,
        stage: 'narrative_grounding_reviewer',
        audience: null,
        attempt: 1,
        invocation_id: 'invocation_concurrent_budget_b',
        reserved_input_tokens: 150,
        reserved_output_tokens: 80
      })
    ]);
    const winners = concurrentStarts.filter(result => result.status === 'fulfilled');
    const losers = concurrentStarts.filter(result => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, 'MODEL_INVOCATION_UNRESOLVED');
    await billing.usage.fail({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: winners[0].value.usage.invocation_id,
      release_budget: true
    });

    const capped = await billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'narrative_grounding_reviewer',
      audience: null,
      attempt: 2,
      invocation_id: 'invocation_usage_over_reservation',
      reserved_input_tokens: 10,
      reserved_output_tokens: 10
    });
    const overReservationAcknowledgement = await billing.usage.acknowledge({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      invocation_id: capped.usage.invocation_id,
      provider_request_id: 'provider-over-reservation',
      input_tokens: 1,
      output_tokens: 11
    });
    assert.equal(overReservationAcknowledgement.usage.status, 'SUCCEEDED');
    assert.equal(overReservationAcknowledgement.usage.output_tokens, 11);
    assert.equal(overReservationAcknowledgement.usage.budget_charge_state, 'SETTLED');
  });

  await test('latest amended plan waits for every unique payer; stale/replayed authorizations cannot double-advance', async () => {
    const original = plan1.stage_plans.find(item => item.stage === 'continuity_repair');
    const grantB = (await billing.grants.createVersion({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      grant_id: 'grant_b',
      expected_grant_revision: 0,
      endpoint_profile_id: 'profile_b',
      profile_revision: 1,
      stage_scopes: [{ stage: 'continuity_repair', audience: null }],
      authorization_scope: { kind: 'single_turn', turn_id: turn.turn_id },
      budget: {
        max_requests: 4,
        max_input_tokens: 1_000,
        max_output_tokens: 1_000,
        max_retries: 2,
        estimated_cost_cap: null
      },
      expires_at: '2026-08-23T00:00:00.000Z'
    })).grant;
    const proposal = await billing.amendments.propose({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      prior_plan_hash: plan1.plan_hash,
      future_stage_changes: [{
        plan_item_id: original.plan_item_id,
        replacement: {
          ...original,
          payer_user_id: USER_B,
          payer_seat: 'B',
          profile_ref: profileRef(profileB),
          capability_probe_ref: {
            probe_revision: probeB.probe_revision,
            probe_hash: probeB.probe_hash
          },
          budget: stageBudget(140)
        }
      }]
    });
    assert.equal(proposal.amendment.status, 'PROPOSED');
    const accepted = await billing.amendments.accept({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      amendment_id: proposal.amendment.amendment_id
    });
    assert.equal(accepted.amendment.status, 'ACCEPTED');
    const applied = await billing.amendments.apply({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      amendment_id: proposal.amendment.amendment_id
    });
    assert.equal(applied.plan.plan_revision, 2);
    assert.equal(applied.amendment.status, 'APPLIED');

    const activeSelections = billing.selections.getActive({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      epoch_id: 'epoch_billing',
      turn_no: 1
    });
    for (const subjectUserId of [USER_A, USER_B]) {
      await billing.consents.grant({
        authenticated_user_id: subjectUserId,
        room_id: 'room_billing',
        epoch_id: 'epoch_billing',
        selection_hash: activeSelections.selection_hashes.shared,
        config_fingerprint: profileB.profile.config_fingerprint,
        terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
        data_categories: SHARED_STAGE_DATA_CATEGORIES
      });
    }

    await connection.write(database => {
      const changed = database.prepare(`
        UPDATE multiplayer_turns
           SET turn_status = 'AWAITING_BILLING_AUTHORIZATION'
         WHERE turn_id = ? AND turn_status = 'RESOLVING'
      `).run(turn.turn_id);
      assert.equal(changed.changes, 1);
    });
    const beforeAmendedAuthorization = connection.read(database => ({
      turn_status: database.prepare(`
        SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(turn.turn_id).turn_status,
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq,
      resolution_events: database.prepare(`
        SELECT COUNT(*) AS count FROM room_events
         WHERE room_id = 'room_billing' AND event_type = 'resolution.progress'
      `).get().count
    }));
    assert.equal(beforeAmendedAuthorization.turn_status, 'AWAITING_BILLING_AUTHORIZATION');

    const staleReplay = await billing.plans.authorize({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      grant_id: 'grant_a',
      grant_revision: 2
    });
    assert.equal(staleReplay.replayed, true);
    const afterStaleReplay = connection.read(database => ({
      turn_status: database.prepare(`
        SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(turn.turn_id).turn_status,
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq
    }));
    assert.deepEqual(afterStaleReplay, {
      turn_status: 'AWAITING_BILLING_AUTHORIZATION',
      control_revision: beforeAmendedAuthorization.control_revision,
      event_seq: beforeAmendedAuthorization.event_seq
    });

    await billing.plans.authorize({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: applied.plan.plan_hash,
      grant_id: 'grant_a',
      grant_revision: 2
    });
    const afterFirstPayer = connection.read(database => ({
      turn_status: database.prepare(`
        SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(turn.turn_id).turn_status,
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq,
      authorizations: database.prepare(`
        SELECT COUNT(*) AS count FROM turn_billing_authorizations WHERE plan_hash = ?
      `).get(applied.plan.plan_hash).count
    }));
    assert.deepEqual(afterFirstPayer, {
      turn_status: 'AWAITING_BILLING_AUTHORIZATION',
      control_revision: beforeAmendedAuthorization.control_revision,
      event_seq: beforeAmendedAuthorization.event_seq,
      authorizations: 1
    });

    await billing.plans.authorize({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      plan_hash: applied.plan.plan_hash,
      grant_id: grantB.grant_id,
      grant_revision: grantB.grant_revision
    });
    const afterSecondPayer = connection.read(database => ({
      turn_status: database.prepare(`
        SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(turn.turn_id).turn_status,
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      epoch_control_revision: database.prepare(`
        SELECT control_revision FROM room_epochs WHERE epoch_id = 'epoch_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq,
      authorizations: database.prepare(`
        SELECT COUNT(*) AS count FROM turn_billing_authorizations WHERE plan_hash = ?
      `).get(applied.plan.plan_hash).count,
      resolution_events: database.prepare(`
        SELECT COUNT(*) AS count FROM room_events
         WHERE room_id = 'room_billing' AND event_type = 'resolution.progress'
      `).get().count
    }));
    assert.deepEqual(afterSecondPayer, {
      turn_status: 'RESOLVING',
      control_revision: beforeAmendedAuthorization.control_revision + 1,
      epoch_control_revision: beforeAmendedAuthorization.control_revision + 1,
      event_seq: beforeAmendedAuthorization.event_seq + 2,
      authorizations: 2,
      resolution_events: beforeAmendedAuthorization.resolution_events + 2
    });
    const payerBReplay = await billing.plans.authorize({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      plan_hash: applied.plan.plan_hash,
      grant_id: grantB.grant_id,
      grant_revision: grantB.grant_revision
    });
    assert.equal(payerBReplay.replayed, true);
    assert.deepEqual(connection.read(database => ({
      control_revision: database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().control_revision,
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_billing'
      `).get().event_seq
    })), {
      control_revision: afterSecondPayer.control_revision,
      event_seq: afterSecondPayer.event_seq
    });

    await assert.rejects(() => billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: plan1.plan_hash,
      stage: 'continuity_repair',
      audience: null,
      attempt: 1,
      invocation_id: 'invocation_stale_plan'
    }), expectDomain('STALE_BILLING_PLAN'));
    await assert.rejects(() => billing.amendments.propose({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      prior_plan_hash: applied.plan.plan_hash,
      future_stage_changes: [{
        plan_item_id: 'plan_item_writer_a',
        replacement: {
          ...applied.plan.stage_plans.find(item => item.plan_item_id === 'plan_item_writer_a'),
          budget: stageBudget(150)
        }
      }]
    }), expectDomain('BILLING_AMENDMENT_STAGE_FROZEN'));

    await billing.grants.revoke({
      authenticated_user_id: USER_B,
      room_id: 'room_billing',
      grant_id: grantB.grant_id,
      grant_revision: grantB.grant_revision
    });
    await assert.rejects(() => billing.usage.start({
      authenticated_user_id: USER_A,
      room_id: 'room_billing',
      plan_hash: applied.plan.plan_hash,
      stage: 'continuity_steward',
      audience: null,
      attempt: 1,
      invocation_id: 'invocation_blocked_by_other_payer_grant',
      reserved_input_tokens: 10,
      reserved_output_tokens: 10
    }), expectDomain('EXECUTION_GRANT_REQUIRED'));
    assert.equal(connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM ai_usage_ledger WHERE invocation_id = ?
    `).get('invocation_blocked_by_other_payer_grant').count), 0);
  });

  await test('schema gaps are explicit and database/WAL contain no plaintext API keys', async () => {
    assert.equal(SQLITE_BILLING_SCHEMA_GAPS.length, 4);
    assert.equal(billing.schemaGaps, SQLITE_BILLING_SCHEMA_GAPS);
    const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    for (const file of files) {
      let bytes;
      try {
        bytes = await fsp.readFile(file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const secret of [SECRET_A_1, SECRET_A_2, SECRET_B]) {
        assert.equal(bytes.includes(Buffer.from(secret, 'utf8')), false, `${path.basename(file)} leaked a key`);
      }
    }
  });
} catch (error) {
  console.error('billing repository regression failed before cleanup:', error);
  throw error;
} finally {
  await connection.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer billing repository regression passed: ${passed}`);
