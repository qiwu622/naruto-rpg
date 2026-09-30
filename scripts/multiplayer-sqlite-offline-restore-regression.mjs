import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openMultiplayerSqlite } from '../server/multiplayer/persistence/sqlite-connection.js';
import {
  restoreMultiplayerSqliteOffline,
  verifyMultiplayerSqliteBackup
} from '../server/multiplayer/persistence/sqlite-offline-restore.js';

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-offline-restore-'));
const sourceDatabase = path.join(tempRoot, 'source.sqlite');
const backupPath = path.join(tempRoot, 'backup.sqlite');
const targetDatabase = path.join(tempRoot, 'target.sqlite');

try {
  const source = await openMultiplayerSqlite({ databasePath: sourceDatabase });
  try {
    await source.write(database => {
      database.prepare(`
        INSERT INTO multiplayer_rooms (
          room_id, origin_type, lineage_id, origin_owner_user_id,
          origin_snapshot_id, lifecycle, host_user_id, active_epoch_id,
          current_turn_id, state_revision, control_revision, event_seq,
          active_narrative_mode, queued_narrative_mode, created_at,
          updated_at, archived_at
        ) VALUES (
          'room_restore', 'new_multiplayer_save', 'lineage_restore', NULL,
          'snapshot_restore', 'LOBBY', '100000000000000001', NULL,
          NULL, 0, 0, 0, 'shared', NULL,
          '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', NULL
        )
      `).run();
    });
    await source.backup(backupPath);
  } finally {
    await source.close();
  }

  await test('online backup is independently integrity and schema verified', () => {
    assert.doesNotThrow(() => verifyMultiplayerSqliteBackup(backupPath));
  });

  await test('offline restore refuses a target still owned by a live writer', async () => {
    const liveTarget = await openMultiplayerSqlite({ databasePath: targetDatabase });
    try {
      await assert.rejects(() => restoreMultiplayerSqliteOffline({
        backupPath,
        databasePath: targetDatabase
      }), error => error.code === 'MULTIPLAYER_INSTANCE_ALREADY_RUNNING');
    } finally {
      await liveTarget.close();
    }
  });

  await test('offline restore moves the prior db/WAL/SHM aside and installs the verified snapshot', async () => {
    await fsp.writeFile(targetDatabase, 'recoverable prior database bytes', { mode: 0o600 });
    await fsp.writeFile(`${targetDatabase}-wal`, 'prior wal', { mode: 0o600 });
    await fsp.writeFile(`${targetDatabase}-shm`, 'prior shm', { mode: 0o600 });
    const receipt = await restoreMultiplayerSqliteOffline({ backupPath, databasePath: targetDatabase });
    assert.equal(receipt.prior_files.length, 3);
    for (const prior of receipt.prior_files) {
      assert.equal(await fsp.access(prior.rollback_path).then(() => true, () => false), true);
    }
    const restored = await openMultiplayerSqlite({ databasePath: targetDatabase });
    try {
      const row = restored.read(database => database.prepare(`
        SELECT room_id FROM multiplayer_rooms WHERE room_id = 'room_restore'
      `).get());
      assert.deepEqual(row, { room_id: 'room_restore' });
      assert.equal(restored.assertReady(), true);
    } finally {
      await restored.close();
    }
  });

  await test('invalid backup fails before moving an existing target', async () => {
    const invalidBackup = path.join(tempRoot, 'invalid.sqlite');
    const untouchedTarget = path.join(tempRoot, 'untouched.sqlite');
    await fsp.writeFile(invalidBackup, 'not sqlite', { mode: 0o600 });
    await fsp.writeFile(untouchedTarget, 'must remain untouched', { mode: 0o600 });
    await assert.rejects(() => restoreMultiplayerSqliteOffline({
      backupPath: invalidBackup,
      databasePath: untouchedTarget
    }), error => error.code === 'SQLITE_RESTORE_SOURCE_INVALID');
    assert.equal(await fsp.readFile(untouchedTarget, 'utf8'), 'must remain untouched');
  });
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer SQLite offline restore regression: ${passed} passed`);
