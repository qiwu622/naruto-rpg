import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createControlWorkflowServices } from '../server/multiplayer/application/control-workflow-service.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import { createSqliteLineageRepository } from '../server/multiplayer/persistence/sqlite-lineage-repository.js';
import { createSqliteTurnWorkflowRepository } from '../server/multiplayer/persistence/sqlite-turn-workflow-repository.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

const HASH = value => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
const START = '2026-08-22T08:00:00.000Z';
const USER_A = 'user_control_A';
const USER_B = 'user_control_B';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function expectCode(code) {
  return error => error instanceof DomainError && error.code === code;
}

function clock() {
  let tick = 0;
  return () => new Date(Date.parse(START) + tick++ * 1_000).toISOString();
}

function ids() {
  let value = 0;
  return kind => `${kind}_control_${++value}`;
}

function diffCodec() {
  return {
    codecVersion: 'test-json-v1',
    sealJson(value) { return Buffer.from(JSON.stringify(value)); },
    openJson(value) { return JSON.parse(Buffer.from(value).toString('utf8')); }
  };
}

function seedRoom(database, { roomId, turnStatus, runStatus, controlRevision = 0 }) {
  const epochId = `${roomId}_epoch`;
  const checkpointId = `${roomId}_checkpoint`;
  const turnId = `${roomId}_turn`;
  const runId = `${roomId}_run`;
  database.prepare(`
    INSERT INTO multiplayer_rooms (
      room_id, origin_type, lineage_id, origin_owner_user_id,
      origin_snapshot_id, lifecycle, host_user_id, active_epoch_id,
      current_turn_id, state_revision, control_revision, event_seq,
      active_narrative_mode, queued_narrative_mode, created_at,
      updated_at, archived_at
    ) VALUES (?, 'new_multiplayer_save', ?, NULL, ?, 'ACTIVE', ?, NULL,
      NULL, 0, ?, 0, 'shared', NULL, ?, ?, NULL)
  `).run(roomId, `${roomId}_lineage`, `${roomId}_origin`, USER_A, controlRevision, START, START);
  for (const [seat, user] of [['A', USER_A], ['B', USER_B]]) {
    database.prepare(`
      INSERT INTO multiplayer_members (
        member_id, room_id, user_id, seat_id, member_status,
        joined_at, ready_at, left_at
      ) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, NULL)
    `).run(`${roomId}_member_${seat}`, roomId, user, seat, START, START);
  }
  database.prepare(`
    INSERT INTO room_epochs (
      epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
      base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
      state_revision, control_revision, epoch_state,
      created_from_proposal_id, activated_at, archived_at
    ) VALUES (?, ?, ?, 1, 'origin_snapshot', ?, ?, ?, ?, 0, ?,
      'ACTIVE', NULL, ?, NULL)
  `).run(
    epochId,
    roomId,
    `${roomId}_lineage`,
    `${roomId}_origin`,
    HASH(`${roomId}:state`),
    checkpointId,
    checkpointId,
    controlRevision,
    START
  );
  database.prepare(`
    INSERT INTO room_checkpoints (
      checkpoint_id, room_id, lineage_id, epoch_id, turn_no,
      checkpoint_kind, parent_checkpoint_id, turn_id, commit_id,
      state_revision, state_hash, snapshot_ref, created_at
    ) VALUES (?, ?, ?, ?, 0, 'genesis', NULL, NULL, NULL, 0, ?, ?, ?)
  `).run(
    checkpointId,
    roomId,
    `${roomId}_lineage`,
    epochId,
    HASH(`${roomId}:state`),
    `${roomId}_snapshot`,
    START
  );
  database.prepare(`
    INSERT INTO multiplayer_turns (
      turn_id, room_id, epoch_id, turn_no, turn_status, narrative_mode,
      base_checkpoint_id, base_state_revision, base_state_hash,
      execution_plan_json, execution_plan_hash, input_hash, sealed_at,
      committed_at, voided_at, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 'shared', ?, 0, ?, '{}', ?, ?, ?,
      NULL, NULL, ?, ?)
  `).run(
    turnId,
    roomId,
    epochId,
    turnStatus,
    checkpointId,
    HASH(`${roomId}:state`),
    HASH(`${roomId}:execution`),
    HASH(`${roomId}:input`),
    START,
    START,
    START
  );
  const active = ['CLAIMED', 'RUNNING'].includes(runStatus);
  database.prepare(`
    INSERT INTO resolution_runs (
      run_id, room_id, epoch_id, turn_id, turn_no, input_hash,
      stage, run_status, owner_boot_id, owner_task_id, claimed_at,
      heartbeat_at, lease_expires_at, lease_fence, attempt_count,
      prompt_version, model_fingerprint, transport,
      bundle_schema_version, reducer_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, 'resolution', ?, ?, ?, ?, ?, ?, ?, 1,
      'prompt-v1', ?, 'json_protocol', 'bundle-v1', 'reducers-v1', ?, ?)
  `).run(
    runId,
    roomId,
    epochId,
    turnId,
    HASH(`${roomId}:input`),
    runStatus,
    active ? 'boot_control' : null,
    active ? 'task_control' : null,
    active ? START : null,
    active ? START : null,
    active ? '2026-08-23T08:00:00.000Z' : null,
    active ? 1 : 0,
    HASH(`${roomId}:model`),
    START,
    START
  );
  database.prepare(`
    UPDATE multiplayer_rooms SET active_epoch_id = ?, current_turn_id = ?
     WHERE room_id = ?
  `).run(epochId, turnId, roomId);
  return { roomId, epochId, checkpointId, turnId, runId };
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-control-workflow-'));
const connection = await openMultiplayerRepositoryTestSqlite({
  databasePath: path.join(tempRoot, 'multiplayer.sqlite')
});
const idFactory = ids();
const now = clock();
const lineage = createSqliteLineageRepository(connection, {
  idFactory,
  clock: now,
  audienceDiffCodec: diffCodec(),
  bindingSignatureSecret: Buffer.alloc(32, 0x41),
  proposalCommitmentSecret: Buffer.alloc(32, 0x42)
});
const turnWorkflow = createSqliteTurnWorkflowRepository(connection, { idFactory, clock: now });

try {
  const retryFixture = await connection.write(database => seedRoom(database, {
    roomId: 'room_retry_control',
    turnStatus: 'RETRYABLE_FAILED',
    runStatus: 'FAILED'
  }));
  const voidFixture = await connection.write(database => seedRoom(database, {
    roomId: 'room_void_control',
    turnStatus: 'REPAIR_PAUSED',
    runStatus: 'PAUSED'
  }));
  const inflightFixture = await connection.write(database => seedRoom(database, {
    roomId: 'room_inflight_control',
    turnStatus: 'REPAIRING_DRAFT',
    runStatus: 'RUNNING'
  }));

  await test('retry re-queues only the durable failed run and publishes transactional events', async () => {
    const result = await turnWorkflow.retry({
      authenticated_user_id: USER_A,
      room_id: retryFixture.roomId,
      epoch_id: retryFixture.epochId,
      turn_id: retryFixture.turnId,
      expected_control_revision: 0
    });
    assert.equal(result.run_status, 'QUEUED');
    assert.equal(result.control_revision, 1);
    const persisted = connection.read(database => ({
      run: database.prepare(`SELECT run_status FROM resolution_runs WHERE run_id = ?`)
        .get(retryFixture.runId),
      room: database.prepare(`SELECT control_revision, event_seq FROM multiplayer_rooms WHERE room_id = ?`)
        .get(retryFixture.roomId),
      events: database.prepare(`SELECT COUNT(*) AS count FROM room_events WHERE room_id = ?`)
        .get(retryFixture.roomId).count,
      outbox: database.prepare(`SELECT COUNT(*) AS count FROM room_outbox WHERE room_id = ?`)
        .get(retryFixture.roomId).count
    }));
    assert.equal(persisted.run.run_status, 'QUEUED');
    assert.deepEqual(persisted.room, { control_revision: 1, event_seq: 2 });
    assert.equal(persisted.events, 2);
    assert.equal(persisted.outbox, 2);
  });

  await test('retry refuses an UNKNOWN invocation instead of risking duplicate BYOK charges', async () => {
    await connection.write(database => {
      database.prepare(`UPDATE resolution_runs SET run_status = 'FAILED' WHERE run_id = ?`)
        .run(retryFixture.runId);
      database.prepare(`
        INSERT INTO turn_billing_plans (
          billing_plan_id, turn_id, plan_revision, narrative_mode,
          turn_payer_selection_hash, pov_writer_selection_a_hash,
          pov_writer_selection_b_hash, stage_plans_json,
          capability_probe_set_hash, plan_hash, created_at
        ) VALUES ('billing_plan_control', ?, 1, 'shared', ?, NULL, NULL,
          '[]', ?, ?, ?)
      `).run(
        retryFixture.turnId,
        HASH('selection'),
        HASH('probes'),
        HASH('plan'),
        START
      );
      database.prepare(`
        INSERT INTO ai_usage_ledger (
          invocation_id, turn_id, plan_hash, payer_user_id, stage, audience,
          attempt, provider_request_id, request_count, input_tokens,
          output_tokens, estimated_cost_currency, estimated_cost_amount_micros,
          usage_status, started_at, completed_at
        ) VALUES ('invocation_unknown_control', ?, ?, ?, 'referee', 'shared',
          1, NULL, 1, NULL, NULL, NULL, NULL, 'UNKNOWN', ?, NULL)
      `).run(retryFixture.turnId, HASH('plan'), USER_A, START);
    });
    await assert.rejects(() => turnWorkflow.retry({
      authenticated_user_id: USER_A,
      room_id: retryFixture.roomId,
      epoch_id: retryFixture.epochId,
      turn_id: retryFixture.turnId,
      expected_control_revision: 1
    }), expectCode('MODEL_INVOCATION_UNRESOLVED'));
  });

  await test('accepted void proposal immediately discards a paused run without disclosing actions', async () => {
    await lineage.proposals.createTurnVoid({
      authenticated_user_id: USER_A,
      room_id: voidFixture.roomId,
      epoch_id: voidFixture.epochId,
      turn_id: voidFixture.turnId,
      proposal_id: 'proposal_void_control',
      proposal_revision: 1,
      expected_control_revision: 0
    });
    const proposalEvents = connection.read(database => database.prepare(`
      SELECT projected_payload_json FROM room_events
       WHERE room_id = ? AND event_type = 'lineage.proposal_created'
       ORDER BY event_seq ASC
    `).all(voidFixture.roomId));
    assert.equal(proposalEvents.length, 2);
    assert.ok(proposalEvents.every(row => (
      JSON.parse(row.projected_payload_json).target_turn_id === voidFixture.turnId
    )));
    for (const user of [USER_A, USER_B]) {
      await lineage.proposals.accept({
        authenticated_user_id: user,
        room_id: voidFixture.roomId,
        proposal_id: 'proposal_void_control',
        proposal_revision: 1,
        expected_control_revision: 0
      });
    }
    const result = await lineage.proposals.applyTurnVoid({
      authenticated_user_id: USER_B,
      room_id: voidFixture.roomId,
      proposal_id: 'proposal_void_control',
      proposal_revision: 1,
      expected_control_revision: 0
    });
    assert.equal(result.turn_status, 'TURN_VOIDED');
    const persisted = connection.read(database => ({
      turn: database.prepare(`SELECT turn_status, voided_at FROM multiplayer_turns WHERE turn_id = ?`)
        .get(voidFixture.turnId),
      run: database.prepare(`SELECT run_status FROM resolution_runs WHERE run_id = ?`)
        .get(voidFixture.runId),
      disclosures: database.prepare(`
        SELECT COUNT(*) AS count FROM action_submissions
         WHERE turn_id = ? AND full_disclosed_at IS NOT NULL
      `).get(voidFixture.turnId).count
    }));
    assert.equal(persisted.turn.turn_status, 'TURN_VOIDED');
    assert.ok(persisted.turn.voided_at);
    assert.equal(persisted.run.run_status, 'ABANDONED');
    assert.equal(persisted.disclosures, 0);
  });

  await test('an active worker yields VOID_REQUESTED and finalizes only at a later safe boundary', async () => {
    await lineage.proposals.createTurnVoid({
      authenticated_user_id: USER_A,
      room_id: inflightFixture.roomId,
      epoch_id: inflightFixture.epochId,
      turn_id: inflightFixture.turnId,
      proposal_id: 'proposal_inflight_void',
      proposal_revision: 1,
      expected_control_revision: 0
    });
    for (const user of [USER_A, USER_B]) {
      await lineage.proposals.accept({
        authenticated_user_id: user,
        room_id: inflightFixture.roomId,
        proposal_id: 'proposal_inflight_void',
        proposal_revision: 1,
        expected_control_revision: 0
      });
    }
    const requested = await lineage.proposals.applyTurnVoid({
      authenticated_user_id: USER_A,
      room_id: inflightFixture.roomId,
      proposal_id: 'proposal_inflight_void',
      proposal_revision: 1,
      expected_control_revision: 0
    });
    assert.equal(requested.turn_status, 'VOID_REQUESTED');
    await connection.write(database => {
      database.prepare(`
        UPDATE resolution_runs
           SET run_status = 'FAILED', owner_boot_id = NULL, owner_task_id = NULL,
               claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL
         WHERE run_id = ?
      `).run(inflightFixture.runId);
    });
    const finalized = await lineage.proposals.applyTurnVoid({
      authenticated_user_id: USER_B,
      room_id: inflightFixture.roomId,
      proposal_id: 'proposal_inflight_void',
      proposal_revision: 1,
      expected_control_revision: 0
    });
    assert.equal(finalized.turn_status, 'TURN_VOIDED');
    assert.equal(finalized.control_revision, 2);
  });

  await test('application services apply accepted workflows and never accept a cross-turn amendment', async () => {
    const calls = [];
    let room = {
      lifecycle: 'ACTIVE', active_epoch_id: 'epoch_app',
      current_turn_id: 'turn_app', control_revision: 9
    };
    let continuationStatus = 'ACCEPTED';
    let prepareCount = 0;
    let amendmentTurn = 'turn_app';
    let amendmentStatus = 'PROPOSED';
    const proposal = type => ({
      proposal_id: `proposal_${type}`,
      proposal_revision: 1,
      proposal_type: type,
      status: type === 'resume_room_checkpoint' ? continuationStatus : 'ACCEPTED',
      target_turn_id: type === 'void_turn' ? 'turn_app' : null,
      target_checkpoint_id: type === 'resume_room_checkpoint' ? 'checkpoint_app' : null,
      source_import_id: null
    });
    const services = createControlWorkflowServices({
      coreRepositories: {
        rooms: { async getForMember() { return room; } },
        turns: {
          async open() {
            calls.push('turn.open');
            room = { ...room, current_turn_id: 'turn_next', control_revision: 10 };
            return { turn_id: 'turn_next' };
          }
        }
      },
      billingRepository: {
        amendments: {
          async get() {
            return {
              amendment_id: 'amendment_app',
              turn_id: amendmentTurn,
              status: amendmentStatus
            };
          },
          async accept() {
            calls.push('amendment.accept');
            return { amendment: { turn_id: 'turn_app', status: 'ACCEPTED' } };
          },
          async apply() {
            calls.push('amendment.apply');
            const replayed = amendmentStatus === 'APPLIED';
            amendmentStatus = 'APPLIED';
            return {
              amendment: { turn_id: 'turn_app', status: 'APPLIED' },
              plan: { plan_hash: HASH('applied-plan') },
              replayed
            };
          }
        }
      },
      turnWorkflowRepository: {
        async retry(input) { calls.push(['retry', input]); return { run_status: 'QUEUED' }; }
      },
      lineageRepository: {
        proposals: {
          async createTurnVoid(input) { calls.push(['void.create', input]); return { proposal: proposal('void_turn') }; },
          async getForMember({ proposal_id: proposalId }) {
            if (proposalId === 'proposal_void_turn') return proposal('void_turn');
            if (proposalId === 'proposal_archive_room') return proposal('archive_room');
            return proposal('resume_room_checkpoint');
          },
          async accept(input) {
            calls.push(['proposal.accept', input]);
            return { proposal: input.proposal_id.includes('resume')
              ? proposal('resume_room_checkpoint')
              : (input.proposal_id.includes('archive') ? proposal('archive_room') : proposal('void_turn')) };
          },
          async applyTurnVoid() {
            calls.push('void.apply');
            return { turn_status: 'TURN_VOIDED', replayed: false };
          },
          async applyArchive() { calls.push('archive.apply'); return { replayed: false }; },
          async activateContinuation(input) {
            calls.push(['continuation.activate', input]);
            continuationStatus = 'APPLIED';
            room = { ...room, current_turn_id: null, control_revision: 11 };
            return { epoch: { epoch_id: input.new_epoch_id }, replayed: false };
          }
        },
        lineage: {
          async getForMember() {
            return { epochs: [{ epoch_id: 'epoch_next', created_from_proposal_id: 'proposal_resume' }] };
          }
        }
      },
      async prepareContinuationSnapshot(input) {
        prepareCount += 1;
        await Promise.resolve();
        return {
          snapshot_id: input.new_snapshot_id,
          state_hash: HASH('continuation'),
          snapshot_ciphertext: Buffer.from('ciphertext'),
          wrapped_data_key: Buffer.alloc(32),
          nonce: Buffer.alloc(12),
          auth_tag: Buffer.alloc(16),
          master_key_version: 'key-v1'
        };
      }
    });

    const appliedAmendment = await services.billing.acceptAmendment({
      authenticated_user_id: USER_A,
      room_id: 'room_app',
      epoch_id: 'epoch_app',
      turn_id: 'turn_app',
      amendment_id: 'amendment_app',
      request: {}
    });
    assert.deepEqual(calls.slice(0, 2), ['amendment.accept', 'amendment.apply']);
    assert.equal(appliedAmendment.plan.plan_hash, HASH('applied-plan'));
    const replayedAmendment = await services.billing.acceptAmendment({
      authenticated_user_id: USER_A,
      room_id: 'room_app',
      epoch_id: 'epoch_app',
      turn_id: 'turn_app',
      amendment_id: 'amendment_app',
      request: {}
    });
    assert.equal(replayedAmendment.replayed, true);
    assert.equal(replayedAmendment.plan.plan_hash, HASH('applied-plan'));
    assert.equal(calls.filter(item => item === 'amendment.accept').length, 1);
    assert.equal(calls.filter(item => item === 'amendment.apply').length, 2);
    amendmentTurn = 'turn_other';
    await assert.rejects(() => services.billing.acceptAmendment({
      authenticated_user_id: USER_A,
      room_id: 'room_app',
      epoch_id: 'epoch_app',
      turn_id: 'turn_app',
      amendment_id: 'amendment_app',
      request: {}
    }), expectCode('BILLING_AMENDMENT_NOT_FOUND'));
    amendmentTurn = 'turn_app';
    await services.turns.retry({
      authenticated_user_id: USER_A,
      room_id: 'room_app', epoch_id: 'epoch_app', turn_id: 'turn_app',
      request: { expected_control_revision: 9 }
    });
    assert.equal(calls.find(item => Array.isArray(item) && item[0] === 'retry')[1]
      .expected_control_revision, 9);

    room = {
      lifecycle: 'ACTIVE', active_epoch_id: 'epoch_app',
      current_turn_id: 'turn_app', control_revision: 9
    };
    const voided = await services.turns.acceptVoidProposal({
      authenticated_user_id: USER_B,
      room_id: 'room_app', epoch_id: 'epoch_app', turn_id: 'turn_app',
      proposal_id: 'proposal_void_turn',
      request: { proposal_revision: 1, expected_control_revision: 9 }
    });
    assert.equal(voided.void.turn_status, 'TURN_VOIDED');
    assert.equal(voided.turn.turn_id, 'turn_next');
    assert.ok(calls.includes('void.apply'));

    const archived = await services.lineage.acceptArchiveProposal({
      authenticated_user_id: USER_B,
      room_id: 'room_app',
      proposal_id: 'proposal_archive_room',
      request: { proposal_revision: 1, expected_control_revision: 9 }
    });
    assert.equal(archived.archive.replayed, false);
    assert.ok(calls.includes('archive.apply'));

    room = { ...room, current_turn_id: null };
    await Promise.all([USER_A, USER_B].map(user => services.lineage.acceptContinuationProposal({
      authenticated_user_id: user,
      room_id: 'room_app',
      proposal_id: 'proposal_resume',
      request: { proposal_revision: 1, expected_control_revision: 9 }
    })));
    assert.equal(prepareCount, 1);
    assert.equal(calls.filter(item => Array.isArray(item) && item[0] === 'continuation.activate').length, 1);
  });
} finally {
  await connection.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer control workflow regression: ${passed} passed`);
