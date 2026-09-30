import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createNewMultiplayerGenesisState } from '../server/multiplayer/application/genesis-state.js';
import {
  createAuthoritativeSnapshotService,
  createContinuationSnapshotPreparer
} from '../server/multiplayer/application/snapshot-service.js';
import { canonicalizeJson } from '../server/multiplayer/domain/canonical-json.js';
import { createActionContentCodec } from '../server/multiplayer/security/action-content-codec.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

const AT = '2026-08-22T08:00:00.000Z';
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const key = createHash('sha256').update('snapshot-continuation-key').digest('base64');
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-snapshot-continuation-'));
const connection = await openMultiplayerRepositoryTestSqlite({
  databasePath: path.join(root, 'multiplayer.sqlite')
});
const codec = createActionContentCodec({
  masterKeys: { v1: key },
  activeMasterKeyVersion: 'v1'
});
const snapshots = createAuthoritativeSnapshotService({ connection, contentCodec: codec });

try {
  const state = canonicalizeJson(createNewMultiplayerGenesisState());
  state.meta.state_revision = 4;
  const sealed = snapshots.seal({
    room_id: 'room_snapshot_resume',
    epoch_id: 'epoch_old',
    checkpoint_id: 'checkpoint_old',
    snapshot_id: 'snapshot_old',
    state_revision: 4,
    state
  });
  await connection.write(database => {
    database.prepare(`
      INSERT INTO multiplayer_rooms (
        room_id, origin_type, lineage_id, origin_owner_user_id,
        origin_snapshot_id, lifecycle, host_user_id, active_epoch_id,
        current_turn_id, state_revision, control_revision, event_seq,
        active_narrative_mode, queued_narrative_mode, created_at,
        updated_at, archived_at
      ) VALUES ('room_snapshot_resume', 'new_multiplayer_save', 'lineage_snapshot',
        NULL, 'origin_snapshot', 'ARCHIVED', 'user_snapshot_A', NULL, NULL,
        10, 7, 0, 'shared', NULL, ?, ?, ?)
    `).run(AT, AT, AT);
    for (const [seat, user] of [['A', 'user_snapshot_A'], ['B', 'user_snapshot_B']]) {
      database.prepare(`
        INSERT INTO multiplayer_members (
          member_id, room_id, user_id, seat_id, member_status,
          joined_at, ready_at, left_at
        ) VALUES (?, 'room_snapshot_resume', ?, ?, 'ACTIVE', ?, ?, NULL)
      `).run(`member_snapshot_${seat}`, user, seat, AT, AT);
    }
    database.prepare(`
      INSERT INTO room_epochs (
        epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
        base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
        state_revision, control_revision, epoch_state,
        created_from_proposal_id, activated_at, archived_at
      ) VALUES ('epoch_old', 'room_snapshot_resume', 'lineage_snapshot', 1,
        'origin_snapshot', 'origin_snapshot', ?, 'checkpoint_old',
        'checkpoint_old', 4, 5, 'ARCHIVED', NULL, ?, ?)
    `).run(sealed.state_hash, AT, AT);
    database.prepare(`
      INSERT INTO room_checkpoints (
        checkpoint_id, room_id, lineage_id, epoch_id, turn_no,
        checkpoint_kind, parent_checkpoint_id, turn_id, commit_id,
        state_revision, state_hash, snapshot_ref, created_at
      ) VALUES ('checkpoint_old', 'room_snapshot_resume', 'lineage_snapshot',
        'epoch_old', 0, 'genesis', NULL, NULL, NULL, 4, ?, 'snapshot_old', ?)
    `).run(sealed.state_hash, AT);
    database.prepare(`
      INSERT INTO room_snapshots (
        snapshot_id, room_id, epoch_id, checkpoint_id, state_revision,
        state_hash, snapshot_ciphertext, wrapped_data_key, nonce,
        auth_tag, master_key_version, created_at
      ) VALUES ('snapshot_old', 'room_snapshot_resume', 'epoch_old',
        'checkpoint_old', 4, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sealed.state_hash,
      sealed.snapshot_ciphertext,
      sealed.wrapped_data_key,
      sealed.nonce,
      sealed.auth_tag,
      sealed.master_key_version,
      AT
    );
    database.prepare(`
      INSERT INTO room_control_proposals (
        proposal_id, room_id, epoch_id, proposal_type, proposal_revision,
        target_turn_id, target_checkpoint_id, source_import_id,
        base_control_revision, request_hash, proposal_payload_json,
        proposed_by_member_id, accepted_by_a_at, accepted_by_a_revision,
        accepted_by_a_diff_commitment, accepted_by_b_at,
        accepted_by_b_revision, accepted_by_b_diff_commitment,
        proposal_status, created_at, applied_at
      ) VALUES ('proposal_snapshot_resume', 'room_snapshot_resume', NULL,
        'resume_room_checkpoint', 1, NULL, 'checkpoint_old', NULL, 7,
        ?, '{}', 'member_snapshot_A', ?, 1, NULL, ?, 1, NULL,
        'ACCEPTED', ?, NULL)
    `).run(digest('resume-request'), AT, AT, AT);
  });

  const prepare = createContinuationSnapshotPreparer({
    connection,
    snapshotService: snapshots,
    saveImportRepository: null
  });
  const result = await prepare({
    authenticated_user_id: 'user_snapshot_A',
    room_id: 'room_snapshot_resume',
    proposal: { proposal_id: 'proposal_snapshot_resume' },
    new_epoch_id: 'epoch_new',
    new_genesis_checkpoint_id: 'checkpoint_new',
    new_snapshot_id: 'snapshot_new'
  });
  assert.equal(result.state_hash, sealed.state_hash);
  const rebased = codec.openJson({
    action_ciphertext: result.snapshot_ciphertext,
    wrapped_data_key: result.wrapped_data_key,
    nonce: result.nonce,
    auth_tag: result.auth_tag,
    master_key_version: result.master_key_version
  }, {
    schema: 'naruto.multiplayer-room-snapshot-context/v1',
    room_id: 'room_snapshot_resume',
    epoch_id: 'epoch_new',
    checkpoint_id: 'checkpoint_new',
    snapshot_id: 'snapshot_new',
    state_revision: 11,
    state_hash: result.state_hash
  });
  assert.equal(rebased.meta.state_revision, 11);
  assert.equal(snapshots.stateHash(rebased), sealed.state_hash);

  const changed = canonicalizeJson(rebased);
  changed.shared_world.calendar.display_date = '木叶49年';
  assert.notEqual(snapshots.stateHash(changed), sealed.state_hash);
  console.log('multiplayer snapshot continuation regression: 1 passed');
} finally {
  await connection.close();
  await fsp.rm(root, { recursive: true, force: true });
}
