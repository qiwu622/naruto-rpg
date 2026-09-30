import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { openMultiplayerSqlite } from '../server/multiplayer/persistence/sqlite-connection.js';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-multiplayer-metrics-'));
const databasePath = path.join(tempRoot, 'multiplayer.sqlite');
const backupPath = path.join(tempRoot, 'backup.sqlite');

try {
  const connection = await openMultiplayerSqlite({
    databasePath,
    busyTimeoutMs: 100,
    lockOptions: { staleMs: 5_000, updateMs: 1_000 }
  });
  try {
    await test('operational metrics expose WAL, checkpoint, queue and commit latency fields', async () => {
      const initial = await connection.operationalMetrics();
      assert.deepEqual(Object.keys(initial).sort(), [
        'checkpoint_busy',
        'checkpoint_log_frames',
        'checkpointed_frames',
        'commit_p95_ms',
        'last_backup_at',
        'sqlite_busy_count',
        'wal_bytes',
        'write_count',
        'writer_queue_pending'
      ]);
      assert.equal(initial.write_count, 0);
      assert.equal(initial.last_backup_at, null);
      assert.ok(initial.wal_bytes >= 0);
      assert.ok(initial.checkpoint_log_frames >= 0);
      assert.ok(initial.checkpointed_frames >= 0);
    });

    await test('writer transactions feed a bounded non-negative p95 sample', async () => {
      await connection.write(database => {
        database.exec('CREATE TABLE metrics_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
      });
      await connection.write(database => {
        database.prepare('INSERT INTO metrics_probe (id, value) VALUES (?, ?)').run(1, 'first');
      });
      const metrics = await connection.operationalMetrics();
      assert.equal(metrics.write_count, 2);
      assert.ok(Number.isFinite(metrics.commit_p95_ms));
      assert.ok(metrics.commit_p95_ms >= 0);
      assert.equal(metrics.writer_queue_pending, 0);
    });

    await test('SQLITE_BUSY failures increment the operational counter without committing', async () => {
      const blocker = new Database(databasePath, { timeout: 100 });
      try {
        blocker.exec('BEGIN IMMEDIATE');
        await assert.rejects(() => connection.write(database => {
          database.prepare('INSERT INTO metrics_probe (id, value) VALUES (?, ?)').run(2, 'blocked');
        }), error => error?.code === 'SQLITE_BUSY');
        blocker.exec('ROLLBACK');
      } finally {
        if (blocker.inTransaction) blocker.exec('ROLLBACK');
        blocker.close();
      }
      const metrics = await connection.operationalMetrics();
      assert.equal(metrics.sqlite_busy_count, 1);
      assert.equal(connection.read(database => (
        database.prepare('SELECT COUNT(*) AS count FROM metrics_probe WHERE id = 2').get().count
      )), 0);
    });

    await test('a verified online backup updates its observable timestamp', async () => {
      const before = Date.now();
      await connection.backup(backupPath);
      const metrics = await connection.operationalMetrics();
      assert.ok(Date.parse(metrics.last_backup_at) >= before);
      assert.ok((await fsp.stat(backupPath)).size > 0);
    });
  } finally {
    await connection.close();
  }
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer SQLite operational metrics regression: ${passed} passed`);
