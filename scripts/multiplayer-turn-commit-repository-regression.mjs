import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DomainError } from '../server/multiplayer/domain/errors.js';
import { createTurnCommitRepository } from '../server/multiplayer/persistence/turn-commit-repository.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

let passed = 0;
async function test(name, operation) {
  try {
    await operation();
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const NOW = '2026-08-22T08:00:00.000Z';
const LATER = '2026-08-22T08:00:01.000Z';
const HASH = suffix => `sha256:${String(suffix).padStart(64, '0')}`;
const HMAC = suffix => `hmac-sha256:${String(suffix).padStart(64, '0')}`;
const BLOB_16 = Buffer.alloc(16, 1);
const BLOB_8 = Buffer.alloc(8, 2);
const SNAPSHOT_CIPHERTEXT = Buffer.alloc(24, 7);
const SNAPSHOT_WRAPPED_KEY = Buffer.alloc(24, 8);
const SNAPSHOT_NONCE = Buffer.alloc(12, 9);
const SNAPSHOT_AUTH_TAG = Buffer.alloc(16, 10);

const VALUE = Object.freeze({
  baseState: HASH(1),
  input: HMAC(2),
  resolution: HASH(3),
  obligations: HASH(4),
  executionPlan: HASH(5),
  billing: HASH(6),
  candidate: HASH(7),
  artifacts: HASH(8),
  narratives: HASH(9),
  semantic: HASH(10),
  envelope: HASH(11),
  readyReceipt: HASH(12),
  projection: HASH(13),
  ruleVersion: HASH(14),
  model: HASH(15),
  plan: HASH(16),
  selection: HASH(17),
  capability: HASH(18)
});

function clone(value) {
  return structuredClone(value);
}

function commitRequest() {
  return {
    preconditions: {
      schema: 'naruto.commit-precondition-set/v1',
      identity: {
        room_id: 'room_1',
        epoch_id: 'epoch_1',
        turn_id: 'turn_1',
        run_id: 'run_1',
        draft_id: 'draft_1',
        commit_id: 'commit_1'
      },
      lifecycle: {
        room_lifecycle: 'ACTIVE',
        epoch_state: 'ACTIVE',
        turn_status: 'COMMITTING',
        current_turn_id: 'turn_1',
        void_requested: false
      },
      concurrency: {
        base_state_revision: 0,
        base_state_hash: VALUE.baseState,
        lease_fence: 7,
        draft_revision: 9,
        draft_status: 'READY'
      },
      frozen_inputs: {
        input_hash: VALUE.input,
        resolution_hash: VALUE.resolution,
        obligation_set_hash: VALUE.obligations,
        execution_plan_hash: VALUE.executionPlan
      },
      billing: {
        billing_provenance_hash: VALUE.billing
      },
      result: {
        candidate_state_hash: VALUE.candidate,
        artifact_bundle_hash: VALUE.artifacts,
        narrative_bundle_hash: VALUE.narratives,
        semantic_draft_hash: VALUE.semantic,
        commit_envelope_hash: VALUE.envelope
      }
    },
    checkpoint_id: 'checkpoint_1',
    snapshot_id: 'snapshot_1',
    snapshot: {
      snapshot_id: 'snapshot_1',
      state_revision: 1,
      state_hash: VALUE.candidate,
      snapshot_ciphertext: SNAPSHOT_CIPHERTEXT,
      wrapped_data_key: SNAPSHOT_WRAPPED_KEY,
      nonce: SNAPSHOT_NONCE,
      auth_tag: SNAPSHOT_AUTH_TAG,
      master_key_version: 'snapshot-mk-1'
    },
    committed_at: NOW
  };
}

function seedAction(database, {
  submissionId,
  memberId,
  seatId,
  receiptSeq,
  commitmentCharacter
}) {
  database.prepare(`
    INSERT INTO action_submissions (
      submission_id, turn_id, member_id, seat_id, idempotency_key,
      action_ciphertext, wrapped_data_key, nonce, auth_tag, master_key_version,
      content_commitment, pre_resolution_visibility, narration_preference,
      base_state_revision, receipt_seq, received_at,
      opponent_pre_revealed_at, full_disclosed_at
    ) VALUES (?, 'turn_1', ?, ?, ?, ?, ?, ?, ?, 'mk-1', ?, 'sealed', 'full',
      0, ?, ?, NULL, NULL)
  `).run(
    submissionId,
    memberId,
    seatId,
    `action-key-${seatId.toLowerCase()}`,
    BLOB_16,
    BLOB_16,
    BLOB_8,
    BLOB_8,
    `hmac-sha256:${commitmentCharacter.repeat(64)}`,
    receiptSeq,
    NOW
  );
}

function seedArtifact(database, obligationId, suffix) {
  database.prepare(`
    INSERT INTO turn_draft_artifact_versions (
      artifact_version_id, draft_id, turn_id, obligation_id, artifact_revision,
      artifact_status, content_ciphertext, wrapped_data_key, nonce, auth_tag,
      master_key_version, artifact_hash, source_refs_ciphertext,
      generated_by_invocation_id, generation_plan_hash, created_at
    ) VALUES (?, 'draft_1', 'turn_1', ?, 1, 'CURRENT', ?, ?, ?, ?, 'mk-1', ?, ?,
      'invocation_1', ?, ?)
  `).run(
    `artifact_version_${suffix}`,
    obligationId,
    BLOB_16,
    BLOB_16,
    BLOB_8,
    BLOB_8,
    HASH(30 + suffix),
    BLOB_16,
    HASH(40 + suffix),
    NOW
  );
}

function seedAuthorityGraph(database) {
  database.prepare(`
    INSERT INTO multiplayer_rooms (
      room_id, origin_type, lineage_id, origin_owner_user_id, origin_snapshot_id,
      lifecycle, host_user_id, state_revision, control_revision, event_seq,
      active_narrative_mode, queued_narrative_mode, created_at, updated_at
    ) VALUES ('room_1', 'new_multiplayer_save', 'lineage_1', NULL,
      'snapshot_origin_1', 'LOBBY', 'user_A', 0, 7, 0, 'shared', 'dual_pov', ?, ?)
  `).run(NOW, NOW);

  database.prepare(`
    INSERT INTO multiplayer_members (
      member_id, room_id, user_id, seat_id, member_status, joined_at, left_at
    ) VALUES ('member_A', 'room_1', 'user_A', 'A', 'ACTIVE', ?, NULL)
  `).run(NOW);
  database.prepare(`
    INSERT INTO multiplayer_members (
      member_id, room_id, user_id, seat_id, member_status, joined_at, left_at
    ) VALUES ('member_B', 'room_1', 'user_B', 'B', 'ACTIVE', ?, NULL)
  `).run(NOW);

  database.prepare(`
    INSERT INTO room_epochs (
      epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
      base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
      state_revision, control_revision, epoch_state, created_from_proposal_id,
      activated_at, archived_at
    ) VALUES ('epoch_1', 'room_1', 'lineage_1', 1, 'origin_snapshot',
      'snapshot_origin_1', ?, 'checkpoint_0', 'checkpoint_0', 0, 7,
      'ACTIVE', NULL, ?, NULL)
  `).run(VALUE.baseState, NOW);
  database.prepare(`
    INSERT INTO room_checkpoints (
      checkpoint_id, room_id, lineage_id, epoch_id, turn_no, checkpoint_kind,
      parent_checkpoint_id, turn_id, commit_id, state_revision, state_hash,
      snapshot_ref, created_at
    ) VALUES ('checkpoint_0', 'room_1', 'lineage_1', 'epoch_1', 0, 'genesis',
      NULL, NULL, NULL, 0, ?, 'snapshot_genesis_1', ?)
  `).run(VALUE.baseState, NOW);
  database.prepare(`
    UPDATE multiplayer_rooms
       SET lifecycle = 'ACTIVE', active_epoch_id = 'epoch_1'
     WHERE room_id = 'room_1'
  `).run();

  database.prepare(`
    INSERT INTO multiplayer_turns (
      turn_id, room_id, epoch_id, turn_no, turn_status, narrative_mode,
      base_checkpoint_id, base_state_revision, base_state_hash,
      execution_plan_json, execution_plan_hash, input_hash, sealed_at,
      committed_at, voided_at, created_at, updated_at
    ) VALUES ('turn_1', 'room_1', 'epoch_1', 1, 'COMMITTING', 'shared',
      'checkpoint_0', 0, ?, '{}', ?, ?, ?, NULL, NULL, ?, ?)
  `).run(VALUE.baseState, VALUE.executionPlan, VALUE.input, NOW, NOW, NOW);
  database.prepare(`
    UPDATE multiplayer_rooms SET current_turn_id = 'turn_1' WHERE room_id = 'room_1'
  `).run();

  seedAction(database, {
    submissionId: 'submission_A1',
    memberId: 'member_A',
    seatId: 'A',
    receiptSeq: 1,
    commitmentCharacter: 'a'
  });
  seedAction(database, {
    submissionId: 'submission_B1',
    memberId: 'member_B',
    seatId: 'B',
    receiptSeq: 2,
    commitmentCharacter: 'b'
  });

  database.prepare(`
    INSERT INTO resolution_runs (
      run_id, room_id, epoch_id, turn_id, turn_no, input_hash, stage,
      run_status, owner_boot_id, owner_task_id, claimed_at, heartbeat_at,
      lease_expires_at, lease_fence, attempt_count, prompt_version,
      model_fingerprint, transport, bundle_schema_version, reducer_version,
      created_at, updated_at
    ) VALUES ('run_1', 'room_1', 'epoch_1', 'turn_1', 1, ?, 'continuity',
      'RUNNING', 'boot_1', 'task_1', ?, ?, ?, 7, 1, 'prompt-v1', ?,
      'json_protocol', 'bundle-v1', 'reducers-v1', ?, ?)
  `).run(VALUE.input, NOW, NOW, LATER, VALUE.model, NOW, NOW);

  database.prepare(`
    INSERT INTO canonical_resolutions (
      resolution_id, turn_id, run_id, schema_version, resolution_ciphertext,
      wrapped_data_key, nonce, auth_tag, master_key_version, resolution_hash,
      created_at
    ) VALUES ('resolution_1', 'turn_1', 'run_1', 'resolution-v1', ?, ?, ?, ?,
      'mk-1', ?, ?)
  `).run(BLOB_16, BLOB_16, BLOB_8, BLOB_8, VALUE.resolution, NOW);
  database.prepare(`
    INSERT INTO narrative_deliveries (
      delivery_id, turn_id, audience, narrative_mode, delivery_ciphertext,
      wrapped_data_key, nonce, auth_tag, master_key_version, resolution_hash,
      projection_hash, narrative_hash, writer_invocation_id, stop_point_ref,
      created_at
    ) VALUES ('delivery_shared_1', 'turn_1', 'shared', 'shared', ?, ?, ?, ?,
      'mk-1', ?, ?, ?, 'invocation_writer_1', 'stop_1', ?)
  `).run(
    BLOB_16,
    BLOB_16,
    BLOB_8,
    BLOB_8,
    VALUE.resolution,
    VALUE.projection,
    HASH(19),
    NOW
  );

  database.prepare(`
    INSERT INTO turn_drafts (
      draft_id, turn_id, run_id, room_id, epoch_id, base_state_revision,
      base_state_hash, lease_fence, draft_revision, execution_plan_hash,
      billing_provenance_hash, resolution_hash, obligation_set_hash,
      projection_hash, rule_version_hash, candidate_state_ciphertext,
      wrapped_data_key, nonce, auth_tag, master_key_version,
      candidate_state_hash, artifact_set_hash, narrative_set_hash, semantic_hash,
      commit_envelope_hash, ready_receipt_hash, draft_status, created_at, updated_at
    ) VALUES ('draft_1', 'turn_1', 'run_1', 'room_1', 'epoch_1', 0, ?, 7, 9,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mk-1', ?, ?, ?, ?, ?, ?, 'READY', ?, ?)
  `).run(
    VALUE.baseState,
    VALUE.executionPlan,
    VALUE.billing,
    VALUE.resolution,
    VALUE.obligations,
    VALUE.projection,
    VALUE.ruleVersion,
    BLOB_16,
    BLOB_16,
    BLOB_8,
    BLOB_8,
    VALUE.candidate,
    VALUE.artifacts,
    VALUE.narratives,
    VALUE.semantic,
    VALUE.envelope,
    VALUE.readyReceipt,
    NOW,
    NOW
  );

  const obligations = [
    ['obligation_domain', 'domain_check', 'world', null, 1],
    ['obligation_memory', 'memory', 'actor:A', 1, 2],
    ['obligation_daily', 'daily', 'world_public', 1, 3],
    ['obligation_narrative', 'narrative', 'shared', 1, 4]
  ];
  for (const [obligationId, kind, scope, artifactRevision, suffix] of obligations) {
    database.prepare(`
      INSERT INTO turn_draft_obligations (
        draft_obligation_id, draft_id, turn_id, obligation_id, obligation_kind,
        binding_scope, obligation_status, current_artifact_revision,
        correction_generation, created_at, updated_at
      ) VALUES (?, 'draft_1', 'turn_1', ?, ?, ?, 'SATISFIED', ?, 0, ?, ?)
    `).run(`draft_obligation_${suffix}`, obligationId, kind, scope, artifactRevision, NOW, NOW);
    if (artifactRevision !== null) seedArtifact(database, obligationId, suffix);
  }

  database.prepare(`
    INSERT INTO turn_billing_plans (
      billing_plan_id, turn_id, plan_revision, narrative_mode,
      turn_payer_selection_hash, pov_writer_selection_a_hash,
      pov_writer_selection_b_hash, stage_plans_json, capability_probe_set_hash,
      plan_hash, created_at
    ) VALUES ('billing_plan_1', 'turn_1', 1, 'shared', ?, NULL, NULL, '{}', ?, ?, ?)
  `).run(VALUE.selection, VALUE.capability, VALUE.plan, NOW);
  database.prepare(`
    INSERT INTO ai_usage_ledger (
      invocation_id, turn_id, plan_hash, payer_user_id, stage, audience, attempt,
      provider_request_id, request_count, input_tokens, output_tokens,
      estimated_cost_currency, estimated_cost_amount_micros, usage_status,
      started_at, completed_at
    ) VALUES ('invocation_1', 'turn_1', ?, 'user_A', 'continuity', 'shared', 1,
      'provider-request-1', 1, 100, 50, 'CNY', 10, 'SUCCEEDED', ?, ?)
  `).run(VALUE.plan, NOW, NOW);
  database.prepare(`
    INSERT INTO turn_output_adoption_events (
      adoption_event_id, turn_id, output_kind, output_id, output_version,
      output_hash, adoption_status, generation_invocation_id, plan_hash,
      transport, previous_provenance_hash, provenance_hash, created_at
    ) VALUES ('adoption_1', 'turn_1', 'candidate_state', 'draft_1', 1, ?,
      'ADOPTED', 'invocation_1', ?, 'json_protocol', NULL, ?, ?)
  `).run(VALUE.candidate, VALUE.plan, VALUE.billing, NOW);
}

const SNAPSHOT_TABLES = Object.freeze([
  'multiplayer_rooms',
  'room_epochs',
  'room_checkpoints',
  'multiplayer_turns',
  'action_submissions',
  'resolution_runs',
  'canonical_resolutions',
  'narrative_deliveries',
  'turn_drafts',
  'turn_draft_obligations',
  'turn_draft_artifact_versions',
  'turn_output_adoption_events',
  'ai_usage_ledger',
  'turn_commits',
  'room_snapshots',
  'room_events',
  'room_outbox'
]);
const SNAPSHOT_STATEMENTS = new WeakMap();

function authoritySnapshot(connection) {
  return connection.read(database => {
    let statements = SNAPSHOT_STATEMENTS.get(database);
    if (!statements) {
      statements = new Map(SNAPSHOT_TABLES.map(tableName => [
        tableName,
        database.prepare(`SELECT * FROM ${tableName} ORDER BY rowid`)
      ]));
      SNAPSHOT_STATEMENTS.set(database, statements);
    }
    return Object.fromEntries(SNAPSHOT_TABLES.map(tableName => [
      tableName,
      statements.get(tableName).all()
    ]));
  });
}

async function expectDomainError(operation, code, pathValue = undefined) {
  await assert.rejects(
    operation,
    error => error instanceof DomainError
      && error.code === code
      && (pathValue === undefined || error.details?.path === pathValue)
  );
}

function deleteAtPath(value, pathParts) {
  const copy = clone(value);
  let target = copy;
  for (const pathPart of pathParts.slice(0, -1)) target = target[pathPart];
  delete target[pathParts.at(-1)];
  return copy;
}

function setAtPath(value, pathParts, replacement) {
  const copy = clone(value);
  let target = copy;
  for (const pathPart of pathParts.slice(0, -1)) target = target[pathPart];
  target[pathParts.at(-1)] = replacement;
  return copy;
}

function deterministicIdFactory(kind, index) {
  return `${kind}_commit_${index}`;
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-turn-commit-'));
const databasePath = path.join(tempRoot, 'turn-commit.sqlite');

try {
  const connection = await openMultiplayerRepositoryTestSqlite({
    databasePath,
    migrationOptions: { clock: () => NOW }
  });
  try {
    await connection.write(seedAuthorityGraph);
    const pristine = authoritySnapshot(connection);
    const repository = createTurnCommitRepository(connection, {
      idFactory: deterministicIdFactory
    });

    await test('final commit rejects every missing request and CommitPreconditionSet field with zero writes', async () => {
      const requestKeys = [
        'preconditions',
        'checkpoint_id',
        'snapshot_id',
        'snapshot',
        'committed_at'
      ];
      const groups = {
        preconditions: ['schema', 'identity', 'lifecycle', 'concurrency', 'frozen_inputs', 'billing', 'result'],
        identity: ['room_id', 'epoch_id', 'turn_id', 'run_id', 'draft_id', 'commit_id'],
        lifecycle: ['room_lifecycle', 'epoch_state', 'turn_status', 'current_turn_id', 'void_requested'],
        concurrency: ['base_state_revision', 'base_state_hash', 'lease_fence', 'draft_revision', 'draft_status'],
        frozen_inputs: ['input_hash', 'resolution_hash', 'obligation_set_hash', 'execution_plan_hash'],
        billing: ['billing_provenance_hash'],
        result: [
          'candidate_state_hash',
          'artifact_bundle_hash',
          'narrative_bundle_hash',
          'semantic_draft_hash',
          'commit_envelope_hash'
        ]
      };

      for (const key of requestKeys) {
        await expectDomainError(
          () => repository.commitTurn(deleteAtPath(commitRequest(), [key])),
          'COMMIT_REQUEST_INVALID'
        );
      }
      for (const key of [
        'snapshot_id',
        'state_revision',
        'state_hash',
        'snapshot_ciphertext',
        'wrapped_data_key',
        'nonce',
        'auth_tag',
        'master_key_version'
      ]) {
        await expectDomainError(
          () => repository.commitTurn(deleteAtPath(commitRequest(), ['snapshot', key])),
          'COMMIT_REQUEST_INVALID'
        );
      }
      for (const key of groups.preconditions) {
        await expectDomainError(
          () => repository.commitTurn(deleteAtPath(commitRequest(), ['preconditions', key])),
          'SCHEMA_VIOLATION',
          `/${key}`
        );
      }
      for (const [group, keys] of Object.entries(groups)) {
        if (group === 'preconditions') continue;
        for (const key of keys) {
          await expectDomainError(
            () => repository.commitTurn(
              deleteAtPath(commitRequest(), ['preconditions', group, key])
            ),
            'SCHEMA_VIOLATION',
            `/${group}/${key}`
          );
        }
      }
      assert.deepEqual(authoritySnapshot(connection), pristine);
    });

    await test('all authoritative hash, revision, fence and obligation preconditions reject mismatches', async () => {
      const mismatchCases = [
        [['preconditions', 'concurrency', 'base_state_revision'], 1, 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'concurrency', 'base_state_hash'], HASH(80), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'concurrency', 'lease_fence'], 8, 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'concurrency', 'draft_revision'], 10, 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'frozen_inputs', 'input_hash'], HMAC(81), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'frozen_inputs', 'resolution_hash'], HASH(82), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'frozen_inputs', 'obligation_set_hash'], HASH(83), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'frozen_inputs', 'execution_plan_hash'], HASH(84), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'billing', 'billing_provenance_hash'], HASH(85), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'result', 'candidate_state_hash'], HASH(86), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'result', 'artifact_bundle_hash'], HASH(87), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'result', 'narrative_bundle_hash'], HASH(88), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'result', 'semantic_draft_hash'], HASH(89), 'COMMIT_PRECONDITION_FAILED'],
        [['preconditions', 'result', 'commit_envelope_hash'], HASH(90), 'COMMIT_PRECONDITION_FAILED']
      ];
      for (const [pathParts, replacement, code] of mismatchCases) {
        const request = setAtPath(commitRequest(), pathParts, replacement);
        if (pathParts.join('/') === 'preconditions/concurrency/base_state_revision') {
          request.snapshot.state_revision = replacement + 1;
        }
        if (pathParts.join('/') === 'preconditions/result/candidate_state_hash') {
          request.snapshot.state_hash = replacement;
        }
        await expectDomainError(
          () => repository.commitTurn(request),
          code
        );
        assert.deepEqual(authoritySnapshot(connection), pristine);
      }
    });

    await test('database-side hash and unsatisfied-obligation drift fail without disclosing actions', async () => {
      const driftCases = [
        ['room_checkpoints', 'state_hash', HASH(91), VALUE.baseState, "checkpoint_id = 'checkpoint_0'"],
        ['multiplayer_turns', 'input_hash', HMAC(92), VALUE.input, "turn_id = 'turn_1'"],
        ['resolution_runs', 'input_hash', HMAC(93), VALUE.input, "run_id = 'run_1'"],
        ['turn_drafts', 'resolution_hash', HASH(94), VALUE.resolution, "draft_id = 'draft_1'"],
        ['turn_drafts', 'obligation_set_hash', HASH(95), VALUE.obligations, "draft_id = 'draft_1'"],
        ['turn_drafts', 'execution_plan_hash', HASH(96), VALUE.executionPlan, "draft_id = 'draft_1'"],
        ['turn_drafts', 'billing_provenance_hash', HASH(97), VALUE.billing, "draft_id = 'draft_1'"],
        ['turn_drafts', 'candidate_state_hash', HASH(98), VALUE.candidate, "draft_id = 'draft_1'"],
        ['turn_drafts', 'artifact_set_hash', HASH(99), VALUE.artifacts, "draft_id = 'draft_1'"],
        ['turn_drafts', 'narrative_set_hash', HASH(100), VALUE.narratives, "draft_id = 'draft_1'"],
        ['turn_drafts', 'semantic_hash', HASH(101), VALUE.semantic, "draft_id = 'draft_1'"],
        ['turn_drafts', 'commit_envelope_hash', HASH(102), VALUE.envelope, "draft_id = 'draft_1'"],
        ['canonical_resolutions', 'resolution_hash', HASH(103), VALUE.resolution, "resolution_id = 'resolution_1'"],
        ['narrative_deliveries', 'resolution_hash', HASH(104), VALUE.resolution, "delivery_id = 'delivery_shared_1'"],
        ['turn_output_adoption_events', 'provenance_hash', HASH(105), VALUE.billing, "adoption_event_id = 'adoption_1'"]
      ];

      for (const [tableName, columnName, drifted, original, whereClause] of driftCases) {
        await connection.write(database => database.prepare(`
          UPDATE ${tableName} SET ${columnName} = ? WHERE ${whereClause}
        `).run(drifted));
        const driftedSnapshot = authoritySnapshot(connection);
        await expectDomainError(() => repository.commitTurn(commitRequest()),
          tableName === 'turn_output_adoption_events'
            ? 'COMMIT_BILLING_PROVENANCE_INVALID'
            : (tableName === 'narrative_deliveries'
                ? 'COMMIT_NARRATIVE_SET_INVALID'
                : 'COMMIT_PRECONDITION_FAILED'));
        assert.deepEqual(authoritySnapshot(connection), driftedSnapshot);
        assert.deepEqual(
          driftedSnapshot.action_submissions.map(row => row.full_disclosed_at),
          [null, null]
        );
        await connection.write(database => database.prepare(`
          UPDATE ${tableName} SET ${columnName} = ? WHERE ${whereClause}
        `).run(original));
        assert.deepEqual(authoritySnapshot(connection), pristine);
      }

      await connection.write(database => database.prepare(`
        UPDATE turn_draft_obligations
           SET obligation_status = 'OPEN', current_artifact_revision = NULL
         WHERE obligation_id = 'obligation_memory'
      `).run());
      const unsatisfiedSnapshot = authoritySnapshot(connection);
      await expectDomainError(
        () => repository.commitTurn(commitRequest()),
        'COMMIT_PRECONDITION_FAILED'
      );
      assert.deepEqual(authoritySnapshot(connection), unsatisfiedSnapshot);
      assert.deepEqual(
        unsatisfiedSnapshot.action_submissions.map(row => row.full_disclosed_at),
        [null, null]
      );
      await connection.write(database => database.prepare(`
        UPDATE turn_draft_obligations
           SET obligation_status = 'SATISFIED', current_artifact_revision = 1
         WHERE obligation_id = 'obligation_memory'
      `).run());
      assert.deepEqual(authoritySnapshot(connection), pristine);
    });

    await test('epoch CAS fault after commit records begin rolls back every business and outbox write', async () => {
      await connection.write(database => database.exec(`
        CREATE TRIGGER regression_epoch_cas_fault
        AFTER INSERT ON room_snapshots
        BEGIN
          UPDATE room_epochs
             SET state_revision = state_revision + 1
           WHERE epoch_id = NEW.epoch_id;
        END
      `));
      await expectDomainError(
        () => repository.commitTurn(commitRequest()),
        'COMMIT_CAS_FAILED'
      );
      assert.deepEqual(authoritySnapshot(connection), pristine);
      await connection.write(database => database.exec('DROP TRIGGER regression_epoch_cas_fault'));
    });

    await test('stale run fence injected during final commit rejects and rolls back action disclosure', async () => {
      await connection.write(database => database.exec(`
        CREATE TRIGGER regression_stale_fence_fault
        AFTER INSERT ON room_snapshots
        BEGIN
          UPDATE resolution_runs
             SET lease_fence = lease_fence + 1
           WHERE run_id = 'run_1';
        END
      `));
      await expectDomainError(
        () => repository.commitTurn(commitRequest()),
        'STALE_LEASE_FENCE'
      );
      assert.deepEqual(authoritySnapshot(connection), pristine);
      await connection.write(database => database.exec('DROP TRIGGER regression_stale_fence_fault'));
    });

    await test('fault after the first event/outbox pair rolls back the entire final transaction', async () => {
      let idCalls = 0;
      const faultingRepository = createTurnCommitRepository(connection, {
        idFactory(kind, index) {
          idCalls += 1;
          if (idCalls === 4) throw new Error('INJECTED_EVENT_OUTBOX_FAULT');
          return deterministicIdFactory(kind, index);
        }
      });
      await assert.rejects(
        () => faultingRepository.commitTurn(commitRequest()),
        error => error?.message === 'INJECTED_EVENT_OUTBOX_FAULT'
      );
      assert.equal(idCalls, 4);
      assert.deepEqual(authoritySnapshot(connection), pristine);
    });

    let committedReceipt;
    await test('complete READY preconditions atomically commit snapshot, checkpoint, disclosure, events and outbox', async () => {
      committedReceipt = await repository.commitTurn(commitRequest());
      assert.deepEqual(committedReceipt, {
        replayed: false,
        commit_id: 'commit_1',
        turn_id: 'turn_1',
        checkpoint_id: 'checkpoint_1',
        state_revision: 1,
        state_hash: VALUE.candidate,
        snapshot_id: 'snapshot_1',
        event_seq_from: 1,
        event_seq_to: 2,
        committed_at: NOW
      });

      const committed = authoritySnapshot(connection);
      assert.deepEqual(committed.multiplayer_rooms.map(row => ({
        state_revision: row.state_revision,
        control_revision: row.control_revision,
        event_seq: row.event_seq,
        queued_narrative_mode: row.queued_narrative_mode
      })), [{
        state_revision: 1,
        control_revision: 8,
        event_seq: 2,
        queued_narrative_mode: 'dual_pov'
      }]);
      assert.deepEqual(committed.room_epochs.map(row => ({
        head_checkpoint_id: row.head_checkpoint_id,
        state_revision: row.state_revision,
        control_revision: row.control_revision
      })), [{
        head_checkpoint_id: 'checkpoint_1',
        state_revision: 1,
        control_revision: 8
      }]);
      assert.equal(committed.room_checkpoints.length, 2);
      assert.deepEqual(committed.room_checkpoints[1], {
        checkpoint_id: 'checkpoint_1',
        room_id: 'room_1',
        lineage_id: 'lineage_1',
        epoch_id: 'epoch_1',
        turn_no: 1,
        checkpoint_kind: 'turn_commit',
        parent_checkpoint_id: 'checkpoint_0',
        turn_id: 'turn_1',
        commit_id: 'commit_1',
        state_revision: 1,
        state_hash: VALUE.candidate,
        snapshot_ref: 'snapshot_1',
        created_at: NOW
      });
      assert.equal(committed.turn_commits.length, 1);
      assert.equal(committed.turn_commits[0].commit_id, 'commit_1');
      assert.equal(committed.turn_commits[0].before_state_revision, 0);
      assert.equal(committed.turn_commits[0].after_state_revision, 1);
      assert.equal(committed.turn_commits[0].before_state_hash, VALUE.baseState);
      assert.equal(committed.turn_commits[0].after_state_hash, VALUE.candidate);
      assert.equal(committed.turn_commits[0].lease_fence, 7);
      assert.match(committed.turn_commits[0].commit_precondition_hash, /^sha256:[a-f0-9]{64}$/u);
      assert.match(committed.turn_commits[0].checkpoint_hash, /^sha256:[a-f0-9]{64}$/u);

      assert.equal(committed.room_snapshots.length, 1);
      assert.equal(committed.room_snapshots[0].snapshot_id, 'snapshot_1');
      assert.equal(committed.room_snapshots[0].checkpoint_id, 'checkpoint_1');
      assert.equal(committed.room_snapshots[0].state_hash, VALUE.candidate);
      assert.deepEqual(
        committed.room_snapshots[0].snapshot_ciphertext,
        SNAPSHOT_CIPHERTEXT,
        'the final snapshot must use its own snapshot-context envelope, not the TurnDraft envelope'
      );
      assert.deepEqual(committed.room_snapshots[0].wrapped_data_key, SNAPSHOT_WRAPPED_KEY);
      assert.deepEqual(committed.room_snapshots[0].nonce, SNAPSHOT_NONCE);
      assert.deepEqual(committed.room_snapshots[0].auth_tag, SNAPSHOT_AUTH_TAG);
      assert.equal(committed.room_snapshots[0].master_key_version, 'snapshot-mk-1');
      assert.deepEqual(
        committed.action_submissions.map(row => row.full_disclosed_at),
        [NOW, NOW]
      );
      assert.equal(committed.multiplayer_turns[0].turn_status, 'COMMITTED');
      assert.equal(committed.multiplayer_turns[0].committed_at, NOW);
      assert.equal(committed.resolution_runs[0].run_status, 'SUCCEEDED');
      assert.equal(committed.resolution_runs[0].owner_boot_id, null);
      assert.equal(committed.resolution_runs[0].owner_task_id, null);

      assert.deepEqual(
        committed.room_events.map(row => ({
          event_id: row.event_id,
          event_seq: row.event_seq,
          event_type: row.event_type,
          audience: row.audience,
          payload: JSON.parse(row.projected_payload_json),
          created_at: row.created_at
        })),
        [
          {
            event_id: 'event_commit_0',
            event_seq: 1,
            event_type: 'action.revealed_after_commit',
            audience: 'BOTH',
            payload: {
              schema: 'naruto.multiplayer-event/action-revealed-after-commit/v1',
              turn_id: 'turn_1',
              disclosure: 'full_after_commit'
            },
            created_at: NOW
          },
          {
            event_id: 'event_commit_1',
            event_seq: 2,
            event_type: 'turn.committed',
            audience: 'BOTH',
            payload: {
              schema: 'naruto.multiplayer-event/turn-committed/v1',
              turn_id: 'turn_1',
              checkpoint_id: 'checkpoint_1',
              state_revision: 1,
              state_hash: VALUE.candidate
            },
            created_at: NOW
          }
        ]
      );
      assert.deepEqual(
        committed.room_outbox.map(row => ({
          outbox_id: row.outbox_id,
          event_id: row.event_id,
          status: row.outbox_status,
          created_at: row.created_at
        })),
        [
          {
            outbox_id: 'outbox_commit_0',
            event_id: 'event_commit_0',
            status: 'PENDING',
            created_at: NOW
          },
          {
            outbox_id: 'outbox_commit_1',
            event_id: 'event_commit_1',
            status: 'PENDING',
            created_at: NOW
          }
        ]
      );
      assert.deepEqual(connection.writer.pragma('foreign_key_check'), []);
    });

    await test('exact replay returns the stored receipt before checking advanced room state and writes nothing', async () => {
      const beforeReplay = authoritySnapshot(connection);
      const replayed = await repository.commitTurn(commitRequest());
      assert.deepEqual(replayed, {
        replayed: true,
        commit_id: committedReceipt.commit_id,
        turn_id: committedReceipt.turn_id,
        checkpoint_id: committedReceipt.checkpoint_id,
        state_revision: committedReceipt.state_revision,
        state_hash: committedReceipt.state_hash,
        snapshot_id: committedReceipt.snapshot_id,
        committed_at: committedReceipt.committed_at
      });
      assert.deepEqual(authoritySnapshot(connection), beforeReplay);
    });

    await test('same turn or commit ID with any different payload conflicts and never guesses a replay', async () => {
      const committed = authoritySnapshot(connection);
      const conflicts = [
        setAtPath(
          setAtPath(commitRequest(), ['snapshot_id'], 'snapshot_conflict'),
          ['snapshot', 'snapshot_id'],
          'snapshot_conflict'
        ),
        setAtPath(commitRequest(), ['snapshot', 'snapshot_ciphertext'], Buffer.alloc(24, 11)),
        setAtPath(commitRequest(), ['committed_at'], LATER),
        setAtPath(commitRequest(), ['checkpoint_id'], 'checkpoint_conflict'),
        setAtPath(
          commitRequest(),
          ['preconditions', 'result', 'semantic_draft_hash'],
          HASH(110)
        )
      ];
      for (const conflict of conflicts) {
        await expectDomainError(
          () => repository.commitTurn(conflict),
          'IDEMPOTENCY_CONFLICT'
        );
        assert.deepEqual(authoritySnapshot(connection), committed);
      }
    });
  } catch (error) {
    console.error('turn commit repository regression failure:', error);
    throw error;
  } finally {
    await connection.close();
  }
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer turn commit repository regression: ${passed} passed`);
