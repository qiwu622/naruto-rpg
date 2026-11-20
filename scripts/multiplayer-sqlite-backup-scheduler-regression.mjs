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

    await test('max_backups retains newest snapshots, cleans -wal/-shm sidecars and leaves unrelated files untouched', async () => {
      const retentionDir = path.join(tempRoot, 'backups-retention');
      let seq = 0;
      let tick = 0;
      const baseTime = Date.UTC(2026, 10, 20, 12, 0, 0);
      const retainedScheduler = createSqliteBackupScheduler({
        connection,
        backup_directory: retentionDir,
        interval_ms: 60_000,
        max_backups: 3,
        clock: () => new Date(baseTime + (++tick) * 60_000),
        id_factory: () => `ret_${++seq}`
      });

      const created = [];
      for (let i = 0; i < 5; i += 1) {
        const snapshotPath = await retainedScheduler.runNow();
        const ts = (baseTime + (i + 1) * 60_000) / 1000;
        if (i < 2) {
          await fsp.writeFile(`${snapshotPath}-wal`, 'stale wal');
          await fsp.writeFile(`${snapshotPath}-shm`, 'stale shm');
        }
        await fsp.utimes(snapshotPath, ts, ts);
        created.push(snapshotPath);
        if (i === 0) {
          await fsp.writeFile(path.join(retentionDir, 'keep-me.txt'), 'note');
        }
      }

      const entries = (await fsp.readdir(retentionDir)).sort();
      const sqliteFiles = entries.filter(name => name.endsWith('.sqlite'));
      assert.equal(sqliteFiles.length, 3);
      assert.deepEqual(
        sqliteFiles,
        created.slice(-3).map(filePath => path.basename(filePath)).sort()
      );
      for (const obsolete of created.slice(0, 2)) {
        const base = path.basename(obsolete);
        assert.equal(entries.includes(base), false, `${base} should be pruned`);
        assert.equal(entries.includes(`${base}-wal`), false, `${base}-wal should be pruned`);
        assert.equal(entries.includes(`${base}-shm`), false, `${base}-shm should be pruned`);
      }
      assert.equal(entries.includes('keep-me.txt'), true);
      assert.equal(await fsp.readFile(path.join(retentionDir, 'keep-me.txt'), 'utf8'), 'note');
    });
  } finally {
    await connection.close();
  }
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer SQLite backup scheduler regression: ${passed} passed`);
