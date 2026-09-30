import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openMultiplayerSqlite } from '../server/multiplayer/persistence/sqlite-connection.js';
import { createResolutionRunLeaseRepository } from '../server/multiplayer/persistence/resolution-run-leases.js';

const PAST = '2026-08-22T09:59:00.000Z';
const NOW = '2026-08-22T10:00:00.000Z';
const SOON = '2026-08-22T10:01:00.000Z';
const LATER = '2026-08-22T10:02:00.000Z';
const HASH = seed => `sha256:${String(seed).padStart(64, '0')}`;

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function seedRun(database) {
  database.prepare(`
    INSERT INTO multiplayer_rooms (
      room_id, origin_type, lineage_id, origin_owner_user_id, origin_snapshot_id,
      lifecycle, host_user_id, state_revision, control_revision, event_seq,
      active_narrative_mode, created_at, updated_at
    ) VALUES ('room_lease', 'new_multiplayer_save', 'lineage_lease', NULL,
      'snapshot_lease', 'LOBBY', 'user_A', 0, 0, 0, 'shared', ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO room_epochs (
      epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
      base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
      state_revision, control_revision, epoch_state, activated_at, archived_at
    ) VALUES ('epoch_lease', 'room_lease', 'lineage_lease', 1, 'origin_snapshot',
      'snapshot_lease', ?, 'checkpoint_lease_0', 'checkpoint_lease_0',
      0, 0, 'ACTIVE', ?, NULL)
  `).run(HASH(1), NOW);
  database.prepare(`
    INSERT INTO room_checkpoints (
      checkpoint_id, room_id, lineage_id, epoch_id, turn_no, checkpoint_kind,
      parent_checkpoint_id, turn_id, commit_id, state_revision, state_hash,
      snapshot_ref, created_at
    ) VALUES ('checkpoint_lease_0', 'room_lease', 'lineage_lease', 'epoch_lease',
      0, 'genesis', NULL, NULL, NULL, 0, ?, 'snapshot-ref-lease', ?)
  `).run(HASH(1), NOW);
  database.prepare(`
    INSERT INTO multiplayer_turns (
      turn_id, room_id, epoch_id, turn_no, turn_status, narrative_mode,
      base_checkpoint_id, base_state_revision, base_state_hash, created_at, updated_at
    ) VALUES ('turn_lease', 'room_lease', 'epoch_lease', 1,
      'AWAITING_BILLING_AUTHORIZATION', 'shared',
      'checkpoint_lease_0', 0, ?, ?, ?)
  `).run(HASH(1), NOW, NOW);
  database.prepare(`
    UPDATE multiplayer_rooms
       SET lifecycle = 'ACTIVE', active_epoch_id = 'epoch_lease', current_turn_id = 'turn_lease'
     WHERE room_id = 'room_lease'
  `).run();
  database.prepare(`
    INSERT INTO resolution_runs (
      run_id, room_id, epoch_id, turn_id, turn_no, input_hash, stage,
      run_status, owner_boot_id, owner_task_id, claimed_at, heartbeat_at,
      lease_expires_at, lease_fence, attempt_count, prompt_version,
      model_fingerprint, transport, bundle_schema_version, reducer_version,
      created_at, updated_at
    ) VALUES ('run_lease', 'room_lease', 'epoch_lease', 'turn_lease', 1, ?,
      'continuity', 'QUEUED', NULL, NULL, NULL, NULL, NULL, 0, 0,
      'continuity/v2', ?, 'json_protocol', 'bundle/v1', 'reducers/v1', ?, ?)
  `).run(HASH(2), HASH(3), NOW, NOW);
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-run-lease-'));
const databasePath = path.join(tempRoot, 'leases.sqlite');
const connection = await openMultiplayerSqlite({ databasePath });

try {
  await connection.write(seedRun);
  const leases = createResolutionRunLeaseRepository(connection);
  let firstOwner;

  await test('billing-waiting run cannot be listed or claimed before the complete-plan gate', async () => {
    assert.deepEqual(leases.listClaimable({ now: NOW }), []);
    await assert.rejects(
      leases.claim({
        run_id: 'run_lease',
        owner_boot_id: 'boot_before_authorization',
        owner_task_id: 'task_before_authorization',
        now: NOW,
        expires_at: SOON
      }),
      error => error.code === 'RUN_LEASE_NOT_CLAIMABLE'
    );
    assert.deepEqual(connection.read(database => database.prepare(`
      SELECT run_status, lease_fence, attempt_count
        FROM resolution_runs WHERE run_id = 'run_lease'
    `).get()), {
      run_status: 'QUEUED',
      lease_fence: 0,
      attempt_count: 0
    });
    await connection.write(database => {
      const changed = database.prepare(`
        UPDATE multiplayer_turns SET turn_status = 'RESOLVING'
         WHERE turn_id = 'turn_lease'
           AND turn_status = 'AWAITING_BILLING_AUTHORIZATION'
      `).run();
      assert.equal(changed.changes, 1);
    });
    assert.deepEqual(
      leases.listClaimable({ now: NOW }).map(item => item.run_id),
      ['run_lease']
    );
  });

  await test('concurrent claims serialize and exactly one owner receives fence 1', async () => {
    const attempts = await Promise.allSettled([
      leases.claim({
        run_id: 'run_lease',
        owner_boot_id: 'boot_one',
        owner_task_id: 'task_one',
        now: NOW,
        expires_at: SOON
      }),
      leases.claim({
        run_id: 'run_lease',
        owner_boot_id: 'boot_two',
        owner_task_id: 'task_two',
        now: NOW,
        expires_at: SOON
      })
    ]);
    const successes = attempts.filter(item => item.status === 'fulfilled');
    const failures = attempts.filter(item => item.status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason.code, 'RUN_LEASE_NOT_CLAIMABLE');
    assert.equal(successes[0].value.lease_fence, 1);
    assert.equal(successes[0].value.attempt_count, 1);
    firstOwner = {
      owner_boot_id: successes[0].value.owner_boot_id,
      owner_task_id: successes[0].value.owner_task_id
    };
  });

  await test('only the matching unexpired owner/fence can start and renew', async () => {
    const started = await leases.start({
      run_id: 'run_lease',
      ...firstOwner,
      lease_fence: 1,
      now: NOW
    });
    assert.equal(started.run_status, 'RUNNING');
    const renewed = await leases.renew({
      run_id: 'run_lease',
      ...firstOwner,
      lease_fence: 1,
      now: NOW,
      expires_at: LATER
    });
    assert.equal(renewed.lease_expires_at, LATER);
    await assert.rejects(
      leases.renew({
        run_id: 'run_lease',
        owner_boot_id: 'boot_forged',
        owner_task_id: 'task_forged',
        lease_fence: 1,
        now: NOW,
        expires_at: LATER
      }),
      error => error.code === 'STALE_LEASE_FENCE'
    );
  });

  await test('takeover increments the fence and invalidates a READY draft review receipt', async () => {
    await connection.write(database => {
      database.prepare(`
        INSERT INTO turn_drafts (
          draft_id, turn_id, run_id, room_id, epoch_id, base_state_revision,
          base_state_hash, lease_fence, draft_revision, execution_plan_hash,
          billing_provenance_hash, resolution_hash, obligation_set_hash, projection_hash,
          rule_version_hash, semantic_hash, commit_envelope_hash,
          ready_receipt_hash, draft_status, created_at, updated_at
        ) VALUES ('draft_lease', 'turn_lease', 'run_lease', 'room_lease', 'epoch_lease',
          0, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?)
      `).run(
        HASH(1), HASH(4), HASH(5), HASH(6), HASH(7), HASH(8), HASH(9),
        HASH(10), HASH(11), HASH(12), NOW, NOW
      );
      database.prepare(`
        UPDATE resolution_runs
           SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE run_id = 'run_lease'
      `).run(PAST, PAST, PAST);
    });

    const taken = await leases.claim({
      run_id: 'run_lease',
      owner_boot_id: 'boot_takeover',
      owner_task_id: 'task_takeover',
      now: NOW,
      expires_at: SOON
    });
    assert.equal(taken.lease_fence, 2);
    assert.equal(taken.attempt_count, 2);
    const draft = connection.read(database => database.prepare(`
      SELECT lease_fence, draft_revision, draft_status, ready_receipt_hash
        FROM turn_drafts WHERE draft_id = 'draft_lease'
    `).get());
    assert.deepEqual(draft, {
      lease_fence: 2,
      draft_revision: 1,
      draft_status: 'OPEN',
      ready_receipt_hash: null
    });
    assert.throws(
      () => leases.assertFence({
        run_id: 'run_lease',
        ...firstOwner,
        lease_fence: 1,
        now: NOW
      }),
      error => error.code === 'STALE_LEASE_FENCE'
    );
  });

  await test('new owner fence is valid and old workers cannot release it', async () => {
    const owner = { owner_boot_id: 'boot_takeover', owner_task_id: 'task_takeover' };
    await leases.start({ run_id: 'run_lease', ...owner, lease_fence: 2, now: NOW });
    assert.equal(leases.assertFence({
      run_id: 'run_lease',
      ...owner,
      lease_fence: 2,
      now: NOW
    }).lease_fence, 2);
    await assert.rejects(
      leases.release({
        run_id: 'run_lease',
        ...firstOwner,
        lease_fence: 1,
        next_status: 'SUCCEEDED',
        now: NOW
      }),
      error => error.code === 'STALE_LEASE_FENCE'
    );
    const released = await leases.release({
      run_id: 'run_lease',
      ...owner,
      lease_fence: 2,
      next_status: 'SUCCEEDED',
      now: NOW
    });
    assert.equal(released.run_status, 'SUCCEEDED');
    assert.equal(released.owner_boot_id, null);
    assert.equal(released.lease_fence, 2);
  });

  await test('terminal runs are absent from the claimable recovery queue', async () => {
    assert.deepEqual(leases.listClaimable({ now: NOW }), []);
    await assert.rejects(
      leases.claim({
        run_id: 'run_lease',
        owner_boot_id: 'boot_three',
        owner_task_id: 'task_three',
        now: NOW,
        expires_at: SOON
      }),
      error => error.code === 'RUN_LEASE_NOT_CLAIMABLE'
    );
  });
} finally {
  await connection.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed} multiplayer run-lease regression tests passed.`);
