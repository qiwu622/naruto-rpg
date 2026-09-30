import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DomainError } from '../server/multiplayer/domain/errors.js';
import { openMultiplayerSqlite } from '../server/multiplayer/persistence/sqlite-connection.js';
import {
  CURRENT_MULTIPLAYER_SCHEMA_VERSION,
  MULTIPLAYER_REQUIRED_PARTIAL_UNIQUE_INDEXES,
  MULTIPLAYER_SCHEMA_TABLES,
  MULTIPLAYER_SQLITE_MIGRATIONS,
  applyMultiplayerSqliteMigrations
} from '../server/multiplayer/persistence/sqlite-migrations.js';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function isConstraint(error) {
  return String(error?.code || '').startsWith('SQLITE_CONSTRAINT');
}

async function expectConstraint(connection, operation) {
  await assert.rejects(() => connection.write(operation), isConstraint);
}

const NOW = '2026-08-22T00:00:00.000Z';
const HASH = suffix => `sha256:${String(suffix).padStart(64, '0')}`;
const BLOB_16 = Buffer.alloc(16, 1);
const BLOB_8 = Buffer.alloc(8, 2);

function seedAuthorityGraph(database, { includeSelectedNarrativeMode = true } = {}) {
  database.prepare(`
    INSERT INTO multiplayer_rooms (
      room_id, origin_type, lineage_id, origin_owner_user_id, origin_snapshot_id,
      lifecycle, host_user_id, state_revision, control_revision, event_seq,
      active_narrative_mode, created_at, updated_at
    ) VALUES (?, 'new_multiplayer_save', ?, NULL, ?, 'LOBBY', ?, 0, 0, 0, 'shared', ?, ?)
  `).run('room_1', 'lineage_1', 'snapshot_origin_1', 'user_A', NOW, NOW);

  database.prepare(`
    INSERT INTO multiplayer_members
      (member_id, room_id, user_id, seat_id, member_status, joined_at, left_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?, NULL)
  `).run('member_A', 'room_1', 'user_A', 'A', NOW);
  database.prepare(`
    INSERT INTO multiplayer_members
      (member_id, room_id, user_id, seat_id, member_status, joined_at, left_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?, NULL)
  `).run('member_B', 'room_1', 'user_B', 'B', NOW);

  database.prepare(`
    INSERT INTO room_epochs (
      epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
      base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
      state_revision, control_revision, epoch_state, created_from_proposal_id,
      activated_at, archived_at
    ) VALUES (?, ?, ?, 1, 'origin_snapshot', ?, ?, ?, ?, 0, 0, 'ACTIVE', NULL, ?, NULL)
  `).run('epoch_1', 'room_1', 'lineage_1', 'snapshot_origin_1', HASH(1), 'checkpoint_0', 'checkpoint_0', NOW);
  database.prepare(`
    INSERT INTO room_checkpoints (
      checkpoint_id, room_id, lineage_id, epoch_id, turn_no, checkpoint_kind,
      parent_checkpoint_id, turn_id, commit_id, state_revision, state_hash,
      snapshot_ref, created_at
    ) VALUES (?, ?, ?, ?, 0, 'genesis', NULL, NULL, NULL, 0, ?, ?, ?)
  `).run('checkpoint_0', 'room_1', 'lineage_1', 'epoch_1', HASH(1), 'encrypted-snapshot-ref-0', NOW);
  database.prepare(`
    UPDATE multiplayer_rooms
       SET lifecycle = 'ACTIVE', active_epoch_id = ?, updated_at = ?
     WHERE room_id = ?
  `).run('epoch_1', NOW, 'room_1');

  database.prepare(`
    INSERT INTO multiplayer_turns (
      turn_id, room_id, epoch_id, turn_no, turn_status, narrative_mode,
      base_checkpoint_id, base_state_revision, base_state_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'COLLECTING_ACTIONS', 'shared', ?, 0, ?, ?, ?)
  `).run('turn_1', 'room_1', 'epoch_1', 'checkpoint_0', HASH(1), NOW, NOW);
  database.prepare(`UPDATE multiplayer_rooms SET current_turn_id = ? WHERE room_id = ?`)
    .run('turn_1', 'room_1');

  database.prepare(`
    INSERT INTO model_endpoint_profiles (
      profile_id, config_revision, owner_user_id, adapter, normalized_base_url,
      normalized_origin, endpoint_origin_hash, model, auth_scheme,
      credential_id, credential_revision, native_tools, strict_json,
      error_correction_continuation, recommended_transport, config_fingerprint,
      profile_status, created_at, revoked_at
    ) VALUES (?, 1, ?, 'openai_compatible', 'https://example.com/v1',
      'https://example.com', ?, 'test-model', 'none', NULL, NULL, 0, 1, 1,
      'json_protocol', ?, 'ACTIVE', ?, NULL)
  `).run('profile_1', 'user_A', HASH(10), HASH(11), NOW);

  const selectedNarrativeModeColumn = includeSelectedNarrativeMode
    ? ', selected_narrative_mode'
    : '';
  const selectedNarrativeModeValue = includeSelectedNarrativeMode ? ", 'shared'" : '';
  database.prepare(`
    INSERT INTO turn_model_selections (
      selection_id, turn_id, scope, audience, selection_revision,
      expected_control_revision, payer_user_id, payer_seat_id,
      audience_owner_user_id, profile_id, profile_revision,
      credential_id, credential_revision, payer_accepted_at,
      audience_accepted_at, idempotency_key, selection_hash, active, created_at
      ${selectedNarrativeModeColumn}
    ) VALUES (?, ?, 'shared', 'shared', 1, 0, ?, 'A', NULL, ?, 1,
      NULL, NULL, ?, NULL, ?, ?, 1, ?${selectedNarrativeModeValue})
  `).run('selection_1', 'turn_1', 'user_A', 'profile_1', NOW, 'selection-key-1', HASH(12), NOW);

  database.prepare(`
    INSERT INTO action_submissions (
      submission_id, turn_id, member_id, seat_id, idempotency_key,
      action_ciphertext, wrapped_data_key, nonce, auth_tag, master_key_version,
      content_commitment, pre_resolution_visibility, narration_preference,
      base_state_revision, receipt_seq, received_at
    ) VALUES (?, ?, ?, 'A', ?, ?, ?, ?, ?, 'mk-1', ?, 'sealed', 'full', 0, 1, ?)
  `).run(
    'submission_A1', 'turn_1', 'member_A', 'action-key-a', BLOB_16,
    BLOB_16, BLOB_8, BLOB_8, `hmac-sha256:${'a'.repeat(64)}`, NOW
  );

  database.prepare(`
    INSERT INTO resolution_runs (
      run_id, room_id, epoch_id, turn_id, turn_no, input_hash, stage,
      run_status, owner_boot_id, owner_task_id, claimed_at, heartbeat_at,
      lease_expires_at, lease_fence, attempt_count, prompt_version,
      model_fingerprint, transport, bundle_schema_version, reducer_version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, 'resolution', 'QUEUED', NULL, NULL, NULL, NULL,
      NULL, 0, 0, 'prompt-v1', ?, 'json_protocol', 'bundle-v1', 'reducers-v1', ?, ?)
  `).run('run_1', 'room_1', 'epoch_1', 'turn_1', HASH(20), HASH(21), NOW, NOW);

  database.prepare(`
    INSERT INTO turn_drafts (
      draft_id, turn_id, run_id, room_id, epoch_id, base_state_revision,
      base_state_hash, lease_fence, draft_revision, execution_plan_hash,
      billing_provenance_hash, resolution_hash, obligation_set_hash, projection_hash,
      rule_version_hash, draft_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, 1, 0, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
  `).run(
    'draft_1', 'turn_1', 'run_1', 'room_1', 'epoch_1', HASH(1), HASH(22),
    HASH(23), HASH(24), HASH(25), HASH(26), HASH(27), NOW, NOW
  );

  database.prepare(`
    INSERT INTO turn_draft_effects (
      draft_effect_id, draft_id, turn_id, effect_id, effect_seq, effect_hash,
      target_kind, target_id, operation, required_reducer, reducer_version,
      before_hash, after_hash, canonical_operation_ciphertext, receipt_hash, applied_at
    ) VALUES (?, ?, ?, ?, 1, ?, 'actor', 'actor_1', 'resource_delta',
      'actor', 'reducers-v1', ?, ?, ?, ?, ?)
  `).run('draft-effect-1', 'draft_1', 'turn_1', 'effect_1', HASH(30), HASH(31), HASH(32), BLOB_16, HASH(33), NOW);

  database.prepare(`
    INSERT INTO turn_draft_obligations (
      draft_obligation_id, draft_id, turn_id, obligation_id, obligation_kind,
      binding_scope, obligation_status, current_artifact_revision,
      correction_generation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'memory', 'actor:A', 'SATISFIED', 1, 0, ?, ?)
  `).run('draft-obligation-1', 'draft_1', 'turn_1', 'obligation_1', NOW, NOW);
  database.prepare(`
    INSERT INTO turn_draft_artifact_versions (
      artifact_version_id, draft_id, turn_id, obligation_id, artifact_revision,
      artifact_status, content_ciphertext, wrapped_data_key, nonce, auth_tag,
      master_key_version, artifact_hash, source_refs_ciphertext,
      generated_by_invocation_id, generation_plan_hash, created_at
    ) VALUES (?, ?, ?, ?, 1, 'CURRENT', ?, ?, ?, ?, 'mk-1', ?, ?, ?, ?, ?)
  `).run(
    'artifact-version-1', 'draft_1', 'turn_1', 'obligation_1', BLOB_16,
    BLOB_16, BLOB_8, BLOB_8, HASH(34), BLOB_16, 'invocation_1', HASH(35), NOW
  );

  database.prepare(`
    INSERT INTO room_events (
      event_id, room_id, event_seq, epoch_id, turn_id, event_type, audience,
      projection_version, projected_payload_json, payload_hash, created_at
    ) VALUES (?, ?, 1, ?, ?, 'chat.message_created', 'BOTH', 'projection-v1', '{}', ?, ?)
  `).run('event_1', 'room_1', 'epoch_1', 'turn_1', HASH(40), NOW);
  database.prepare(`
    INSERT INTO room_outbox (
      outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
      lease_fence, lease_expires_at, claimed_at, dispatched_at, attempt_count, created_at
    ) VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, 0, ?)
  `).run('outbox_1', 'room_1', 'event_1', NOW);
  database.prepare(`
    INSERT INTO room_chat_messages (
      message_id, room_id, epoch_id, sender_member_id, sender_seat_id,
      idempotency_key, message_text, event_seq, created_at
    ) VALUES (?, ?, ?, ?, 'A', ?, 'hello', 1, ?)
  `).run('message_1', 'room_1', 'epoch_1', 'member_A', 'chat-key-1', NOW);
}

function initializeLegacyV4Database(database) {
  database.exec(`
    CREATE TABLE multiplayer_schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL CHECK (version >= 1),
      name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
      checksum TEXT NOT NULL
        CHECK (length(checksum) = 71 AND substr(checksum, 1, 7) = 'sha256:'),
      applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20)
    ) STRICT;
  `);
  for (const migration of MULTIPLAYER_SQLITE_MIGRATIONS.slice(0, 4)) {
    database.exec(migration.sql);
    database.prepare(`
      INSERT INTO multiplayer_schema_migrations (version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(migration.version, migration.name, migration.checksum, NOW);
    database.pragma(`user_version = ${migration.version}`);
  }
}

function initializeLegacyV5Database(database) {
  initializeLegacyV4Database(database);
  const migration = MULTIPLAYER_SQLITE_MIGRATIONS[4];
  database.exec(migration.sql);
  database.prepare(`
    INSERT INTO multiplayer_schema_migrations (version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `).run(migration.version, migration.name, migration.checksum, NOW);
  database.pragma(`user_version = ${migration.version}`);
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-multiplayer-migrations-'));
const databasePath = path.join(tempRoot, 'schema.sqlite');

try {
  const connection = await openMultiplayerSqlite({
    databasePath,
    migrationOptions: { clock: () => NOW }
  });
  try {
    await test('initial migration creates the complete STRICT schema and immutable ledger', async () => {
      assert.equal(connection.schemaVersion, CURRENT_MULTIPLAYER_SCHEMA_VERSION);
      assert.deepEqual(
        connection.migrationState.applied,
        MULTIPLAYER_SQLITE_MIGRATIONS.map(migration => migration.version)
      );
      assert.equal(
        connection.writer.pragma('user_version', { simple: true }),
        CURRENT_MULTIPLAYER_SCHEMA_VERSION
      );
      const migrationRows = connection.read(database => database.prepare(`
        SELECT version, name, checksum FROM multiplayer_schema_migrations ORDER BY version
      `).all());
      assert.deepEqual(migrationRows, MULTIPLAYER_SQLITE_MIGRATIONS.map(migration => ({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum
      })));

      const tableList = connection.writer.pragma('table_list');
      const tableByName = new Map(tableList.map(row => [row.name, row]));
      for (const tableName of MULTIPLAYER_SCHEMA_TABLES) {
        assert.equal(tableByName.get(tableName)?.strict, 1, `${tableName} must be STRICT`);
      }
      const indexes = new Map(connection.read(database => database.prepare(`
        SELECT name, sql FROM sqlite_schema WHERE type = 'index'
      `).all()).map(row => [row.name, row.sql]));
      for (const indexName of MULTIPLAYER_REQUIRED_PARTIAL_UNIQUE_INDEXES) {
        assert.match(indexes.get(indexName), /CREATE\s+UNIQUE\s+INDEX[\s\S]+\sWHERE\s/iu);
      }
    });

    await connection.write(seedAuthorityGraph);

    await test('room lineage enforces one active epoch per room', async () => {
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO room_epochs (
            epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
            base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
            state_revision, control_revision, epoch_state, activated_at, archived_at
          ) VALUES ('epoch_2', 'room_1', 'lineage_1', 2, 'room_checkpoint',
            'checkpoint_0', ?, 'checkpoint_2', 'checkpoint_2', 0, 0, 'ACTIVE', ?, NULL)
        `).run(HASH(50), NOW);
      });
    });

    await test('turn actions enforce one locked submission per seat', async () => {
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO action_submissions (
            submission_id, turn_id, member_id, seat_id, idempotency_key,
            action_ciphertext, wrapped_data_key, nonce, auth_tag, master_key_version,
            content_commitment, pre_resolution_visibility, narration_preference,
            base_state_revision, receipt_seq, received_at
          ) VALUES (?, 'turn_1', 'member_A', 'A', 'another-key', ?, ?, ?, ?,
            'mk-1', ?, 'open', 'full', 0, 2, ?)
        `).run('submission_A2', BLOB_16, BLOB_16, BLOB_8, BLOB_8, `hmac-sha256:${'b'.repeat(64)}`, NOW);
      });
    });

    await test('payer selection and resolution run each allow only one active revision', async () => {
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO turn_model_selections (
            selection_id, turn_id, scope, audience, selection_revision,
            expected_control_revision, payer_user_id, payer_seat_id,
            audience_owner_user_id, profile_id, profile_revision,
            credential_id, credential_revision, payer_accepted_at,
            audience_accepted_at, idempotency_key, selection_hash, active, created_at,
            selected_narrative_mode
          ) VALUES ('selection_2', 'turn_1', 'shared', 'shared', 2, 0, 'user_A',
            'A', NULL, 'profile_1', 1, NULL, NULL, ?, NULL, 'selection-key-2', ?, 1, ?,
            'shared')
        `).run(NOW, HASH(51), NOW);
      });
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO resolution_runs (
            run_id, room_id, epoch_id, turn_id, turn_no, input_hash, stage,
            run_status, lease_fence, attempt_count, prompt_version, model_fingerprint,
            transport, bundle_schema_version, reducer_version, created_at, updated_at
          ) VALUES ('run_2', 'room_1', 'epoch_1', 'turn_1', 1, ?, 'resolution',
            'QUEUED', 0, 0, 'prompt-v1', ?, 'json_protocol', 'bundle-v1',
            'reducers-v1', ?, ?)
        `).run(HASH(52), HASH(53), NOW, NOW);
      });
    });

    await test('effect, obligation and current artifact ledgers reject double consumption', async () => {
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO turn_draft_effects (
            draft_effect_id, draft_id, turn_id, effect_id, effect_seq, effect_hash,
            target_kind, target_id, operation, required_reducer, reducer_version,
            before_hash, after_hash, canonical_operation_ciphertext, receipt_hash, applied_at
          ) VALUES ('draft-effect-2', 'draft_1', 'turn_1', 'effect_1', 2, ?,
            'actor', 'actor_1', 'resource_delta', 'actor', 'reducers-v1', ?, ?, ?, ?, ?)
        `).run(HASH(54), HASH(55), HASH(56), BLOB_16, HASH(57), NOW);
      });
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO turn_draft_obligations (
            draft_obligation_id, draft_id, turn_id, obligation_id, obligation_kind,
            binding_scope, obligation_status, current_artifact_revision,
            correction_generation, created_at, updated_at
          ) VALUES ('draft-obligation-2', 'draft_1', 'turn_1', 'obligation_1',
            'memory', 'actor:A', 'OPEN', NULL, 0, ?, ?)
        `).run(NOW, NOW);
      });
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO turn_draft_artifact_versions (
            artifact_version_id, draft_id, turn_id, obligation_id, artifact_revision,
            artifact_status, content_ciphertext, wrapped_data_key, nonce, auth_tag,
            master_key_version, artifact_hash, source_refs_ciphertext,
            generated_by_invocation_id, generation_plan_hash, created_at
          ) VALUES ('artifact-version-2', 'draft_1', 'turn_1', 'obligation_1', 2,
            'CURRENT', ?, ?, ?, ?, 'mk-1', ?, ?, 'invocation_2', ?, ?)
        `).run(BLOB_16, BLOB_16, BLOB_8, BLOB_8, HASH(58), BLOB_16, HASH(59), NOW);
      });
    });

    await test('commit, event, outbox and chat idempotency are database-enforced', async () => {
      await connection.write(database => {
        database.prepare(`
          INSERT INTO room_checkpoints (
            checkpoint_id, room_id, lineage_id, epoch_id, turn_no, checkpoint_kind,
            parent_checkpoint_id, turn_id, commit_id, state_revision, state_hash,
            snapshot_ref, created_at
          ) VALUES ('checkpoint_1', 'room_1', 'lineage_1', 'epoch_1', 1,
            'turn_commit', 'checkpoint_0', 'turn_1', 'commit_1', 1, ?,
            'encrypted-snapshot-ref-1', ?)
        `).run(HASH(60), NOW);
        database.prepare(`
          INSERT INTO turn_commits (
            commit_id, turn_id, room_id, epoch_id, checkpoint_id,
            commit_precondition_hash, before_state_revision, after_state_revision,
            before_state_hash, after_state_hash, artifact_set_hash,
            narrative_set_hash, checkpoint_hash, commit_envelope_hash,
            lease_fence, committed_at
          ) VALUES ('commit_1', 'turn_1', 'room_1', 'epoch_1', 'checkpoint_1',
            ?, 0, 1, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(HASH(61), HASH(1), HASH(62), HASH(63), HASH(64), HASH(65), HASH(66), NOW);
      });
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO turn_commits (
            commit_id, turn_id, room_id, epoch_id, checkpoint_id,
            commit_precondition_hash, before_state_revision, after_state_revision,
            before_state_hash, after_state_hash, artifact_set_hash,
            narrative_set_hash, checkpoint_hash, commit_envelope_hash,
            lease_fence, committed_at
          ) VALUES ('commit_2', 'turn_1', 'room_1', 'epoch_1', 'checkpoint_1',
            ?, 0, 1, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(HASH(67), HASH(1), HASH(62), HASH(63), HASH(64), HASH(65), HASH(68), NOW);
      });
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO room_outbox (
            outbox_id, room_id, event_id, outbox_status, dispatcher_owner_id,
            lease_fence, lease_expires_at, claimed_at, dispatched_at, attempt_count, created_at
          ) VALUES ('outbox_2', 'room_1', 'event_1', 'PENDING', NULL, 0,
            NULL, NULL, NULL, 0, ?)
        `).run(NOW);
      });
      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO room_events (
            event_id, room_id, event_seq, epoch_id, turn_id, event_type, audience,
            projection_version, projected_payload_json, payload_hash, created_at
          ) VALUES ('event_2', 'room_1', 2, 'epoch_1', 'turn_1',
            'chat.message_created', 'BOTH', 'projection-v1', '{}', ?, ?)
        `).run(HASH(69), NOW);
        database.prepare(`
          INSERT INTO room_chat_messages (
            message_id, room_id, epoch_id, sender_member_id, sender_seat_id,
            idempotency_key, message_text, event_seq, created_at
          ) VALUES ('message_2', 'room_1', 'epoch_1', 'member_A', 'A',
            'chat-key-1', 'duplicate', 2, ?)
        `).run(NOW);
      });
    });

    await test('foreign keys and database integrity remain clean after constraint failures', async () => {
      assert.deepEqual(connection.writer.pragma('foreign_key_check'), []);
      assert.deepEqual(connection.writer.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    });

    await test('only current room codes are unique and passwords are scoped per room', async () => {
      const insertRoom = (database, roomId, roomCode, hostUserId) => database.prepare(`
        INSERT INTO multiplayer_rooms (
          room_id, room_code, origin_type, lineage_id, origin_owner_user_id,
          origin_snapshot_id, lifecycle, host_user_id, state_revision,
          control_revision, event_seq, active_narrative_mode, created_at, updated_at
        ) VALUES (?, ?, 'new_multiplayer_save', ?, NULL, ?, 'LOBBY', ?, 0, 0, 0,
          'shared', ?, ?)
      `).run(roomId, roomCode, `lineage_${roomId}`, `snapshot_${roomId}`, hostUserId, NOW, NOW);

      await expectConstraint(connection, database => {
        insertRoom(database, 'room_conflict', 'room_1', 'user_conflict');
      });

      await connection.write(database => {
        database.prepare(`
          UPDATE multiplayer_rooms
             SET lifecycle = 'ARCHIVED', archived_at = ?, updated_at = ?
           WHERE room_id = 'room_1'
        `).run(NOW, NOW);
        insertRoom(database, 'room_2', 'room_1', 'user_C');
        database.prepare(`
          INSERT INTO multiplayer_members (
            member_id, room_id, user_id, seat_id, member_status, joined_at, left_at
          ) VALUES ('member_C', 'room_2', 'user_C', 'A', 'ACTIVE', ?, NULL)
        `).run(NOW);
        const insertPassword = database.prepare(`
          INSERT INTO room_invites (
            invite_id, room_id, token_hash, created_by_member_id,
            intended_seat_id, expires_at, max_uses, use_count, revoked, created_at
          ) VALUES (?, ?, ?, ?, 'B', ?, 1, 0, 0, ?)
        `);
        insertPassword.run('password_room_1', 'room_1', HASH(70), 'member_A', NOW, NOW);
        insertPassword.run('password_room_2', 'room_2', HASH(70), 'member_C', NOW, NOW);
      });

      await expectConstraint(connection, database => {
        database.prepare(`
          INSERT INTO room_invites (
            invite_id, room_id, token_hash, created_by_member_id,
            intended_seat_id, expires_at, max_uses, use_count, revoked, created_at
          ) VALUES ('password_room_2_duplicate', 'room_2', ?, 'member_C',
            'B', ?, 1, 0, 0, ?)
        `).run(HASH(70), NOW, NOW);
      });
      assert.deepEqual(connection.writer.pragma('foreign_key_check'), []);
    });
  } finally {
    await connection.close();
  }

  await test('current schema upgrades v4 rows and installs room-code/password semantics', async () => {
    const legacyPath = path.join(tempRoot, 'legacy-v4.sqlite');
    const legacy = new Database(legacyPath);
    try {
      initializeLegacyV4Database(legacy);
      legacy.transaction(() => seedAuthorityGraph(legacy, {
        includeSelectedNarrativeMode: false
      }))();
      assert.equal(legacy.pragma('user_version', { simple: true }), 4);
      assert.equal(
        legacy.pragma('table_info(turn_model_selections)')
          .some(column => column.name === 'selected_narrative_mode'),
        false
      );
      const migrated = applyMultiplayerSqliteMigrations(legacy, { clock: () => NOW });
      assert.deepEqual(
        migrated.applied,
        MULTIPLAYER_SQLITE_MIGRATIONS.slice(4).map(migration => migration.version)
      );
      assert.equal(
        legacy.prepare(`SELECT room_code FROM multiplayer_rooms WHERE room_id = 'room_1'`)
          .get().room_code,
        'room_1'
      );
      assert.equal(
        legacy.pragma('table_info(multiplayer_turns)')
          .some(column => column.name === 'turn_kind'),
        true
      );
      assert.equal(
        legacy.prepare(`SELECT turn_kind FROM multiplayer_turns WHERE turn_id = 'turn_1'`)
          .get().turn_kind,
        'ACTION',
        'a legacy first turn with a player submission must never become a trusted opening'
      );
      assert.equal(
        legacy.prepare(`
          SELECT selected_narrative_mode
            FROM turn_model_selections
           WHERE selection_id = 'selection_1'
        `).get().selected_narrative_mode,
        'shared'
      );
      assert.equal(
        legacy.pragma('table_list')
          .find(table => table.name === 'narrative_mode_change_requests')?.strict,
        1
      );
      assert.equal(
        legacy.pragma('table_list')
          .find(table => table.name === 'writer_audience_acceptance_requests')?.strict,
        1
      );
    } finally {
      legacy.close();
    }
  });

  await test('current schema upgrades an existing v5 database without rewriting selections', async () => {
    const legacyPath = path.join(tempRoot, 'legacy-v5.sqlite');
    const legacy = new Database(legacyPath);
    try {
      initializeLegacyV5Database(legacy);
      legacy.transaction(() => seedAuthorityGraph(legacy))();
      const before = legacy.prepare(`
        SELECT selection_id, selection_hash, active, selected_narrative_mode
          FROM turn_model_selections ORDER BY selection_id
      `).all();
      const migrated = applyMultiplayerSqliteMigrations(legacy, { clock: () => NOW });
      assert.deepEqual(
        migrated.applied,
        MULTIPLAYER_SQLITE_MIGRATIONS.slice(5).map(migration => migration.version)
      );
      assert.deepEqual(legacy.prepare(`
        SELECT selection_id, selection_hash, active, selected_narrative_mode
          FROM turn_model_selections ORDER BY selection_id
      `).all(), before);
      assert.equal(legacy.prepare(`
        SELECT COUNT(*) AS count FROM writer_audience_acceptance_requests
      `).get().count, 0);
      assert.deepEqual(legacy.pragma('foreign_key_check'), []);
    } finally {
      legacy.close();
    }
  });

  await test('a pristine legacy new-save first turn migrates to an automatic opening', async () => {
    const legacyPath = path.join(tempRoot, 'legacy-v4-zero-action.sqlite');
    const legacy = new Database(legacyPath);
    try {
      initializeLegacyV4Database(legacy);
      legacy.transaction(() => seedAuthorityGraph(legacy, {
        includeSelectedNarrativeMode: false
      }))();
      legacy.prepare(`DELETE FROM action_submissions WHERE turn_id = 'turn_1'`).run();
      applyMultiplayerSqliteMigrations(legacy, { clock: () => NOW });
      assert.deepEqual(legacy.prepare(`
        SELECT s.active, s.selected_narrative_mode, t.turn_status, t.turn_kind
          FROM turn_model_selections AS s
          JOIN multiplayer_turns AS t ON t.turn_id = s.turn_id
         WHERE s.selection_id = 'selection_1'
      `).get(), {
        active: 0,
        selected_narrative_mode: 'shared',
        turn_status: 'AWAITING_PAYER_SELECTION',
        turn_kind: 'OPENING'
      });
      assert.deepEqual(legacy.pragma('foreign_key_check'), []);
    } finally {
      legacy.close();
    }
  });

  await test('migration replay is a no-op with the same checksum and user_version', async () => {
    const reopened = await openMultiplayerSqlite({ databasePath });
    try {
      assert.deepEqual(reopened.migrationState.applied, []);
      assert.equal(reopened.migrationState.initialVersion, CURRENT_MULTIPLAYER_SCHEMA_VERSION);
    } finally {
      await reopened.close();
    }
  });

  await test('tampered migration checksum is rejected at startup', async () => {
    const tamperedPath = path.join(tempRoot, 'tampered-checksum.sqlite');
    const initialized = await openMultiplayerSqlite({ databasePath: tamperedPath });
    await initialized.close();
    const raw = new Database(tamperedPath);
    raw.prepare(`UPDATE multiplayer_schema_migrations SET checksum = ? WHERE version = 1`)
      .run(HASH(999));
    raw.close();
    await assert.rejects(
      () => openMultiplayerSqlite({ databasePath: tamperedPath }),
      error => error instanceof DomainError && error.code === 'SQLITE_MIGRATION_CHECKSUM_MISMATCH'
    );
  });

  await test('future user_version and missing required schema objects are rejected', async () => {
    const futurePath = path.join(tempRoot, 'future.sqlite');
    const future = await openMultiplayerSqlite({ databasePath: futurePath });
    await future.close();
    const rawFuture = new Database(futurePath);
    rawFuture.pragma(`user_version = ${CURRENT_MULTIPLAYER_SCHEMA_VERSION + 1}`);
    rawFuture.close();
    await assert.rejects(
      () => openMultiplayerSqlite({ databasePath: futurePath }),
      error => error instanceof DomainError && error.code === 'SQLITE_SCHEMA_VERSION_FROM_FUTURE'
    );

    const schemaPath = path.join(tempRoot, 'tampered-schema.sqlite');
    const schema = await openMultiplayerSqlite({ databasePath: schemaPath });
    await schema.close();
    const rawSchema = new Database(schemaPath);
    rawSchema.exec('DROP INDEX room_epochs_one_active_per_room');
    rawSchema.close();
    await assert.rejects(
      () => openMultiplayerSqlite({ databasePath: schemaPath }),
      error => error instanceof DomainError && error.code === 'SQLITE_SCHEMA_OBJECT_MISSING'
    );
  });
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer SQLite migrations regression: ${passed} passed`);
