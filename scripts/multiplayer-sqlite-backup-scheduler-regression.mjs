import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openMultiplayerSqlite } from '../server/multiplayer/persistence/sqlite-connection.js';
import {
  createSqliteBackupScheduler
} from '../server/multiplayer/persistence/sqlite-backup-scheduler.js';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-backup-scheduler-'));
const databasePath = path.join(tempRoot, 'multiplayer.sqlite');
const backupDirectory = path.join(tempRoot, 'backups');

try {
  const connection = await openMultiplayerSqlite({ databasePath });
  try {
    await connection.write(database => {
      database.exec('CREATE TABLE backup_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
      database.prepare('INSERT INTO backup_probe (id, value) VALUES (?, ?)').run(1, 'durable');
    });

    let sequence = 0;
    const scheduler = createSqliteBackupScheduler({
      connection,
      backup_directory: backupDirectory,
      interval_ms: 60_000,
      clock: () => new Date('2026-08-23T12:00:00.000Z'),
      id_factory: () => `run_${++sequence}`
    });

    await test('runNow creates an integrity-checked online snapshot in the configured directory', async () => {
      const output = await scheduler.runNow();
      assert.equal(path.dirname(output), backupDirectory);
      assert.match(path.basename(output), /^multiplayer-2026-08-23T12-00-00-000Z-run_1\.sqlite$/u);
      assert.ok((await fsp.stat(output)).size > 0);
      assert.deepEqual(scheduler.stats(), {
        backup_scheduler_running: false,
        backup_in_flight: false,
        backup_completed_count: 1,
        backup_failed_count: 0,
        backup_last_failure_at: null
      });
    });

    await test('periodic start runs immediately and quiesce waits before SQLite close', async () => {
      const loop = scheduler.start();
      await new Promise(resolve => setImmediate(resolve));
      await scheduler.quiesce();
      await loop;
      assert.equal(scheduler.isRunning(), false);
      assert.equal(scheduler.stats().backup_completed_count, 2);
      assert.equal(
        (await fsp.readdir(backupDirectory)).filter(name => name.endsWith('.sqlite')).length,
        2
      );
    });
  } finally {
    await connection.close();
  }
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer SQLite backup scheduler regression: ${passed} passed`);
