import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  SQLITE_CONNECTION_POLICY,
  beginImmediate,
  openMultiplayerSqlite
} from '../server/multiplayer/persistence/sqlite-connection.js';
import {
  assertLocalFilesystem,
  resolveLocalSqlitePath
} from '../server/multiplayer/persistence/sqlite-lifecycle.js';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-multiplayer-sqlite-'));
const databasePath = path.join(tempRoot, 'multiplayer.sqlite');
const backupPath = path.join(tempRoot, 'backup', 'multiplayer.sqlite');

try {
  await test('database path and filesystem checks reject memory, roots and network filesystems', async () => {
    assert.throws(() => resolveLocalSqlitePath(':memory:'), DomainError);
    assert.throws(() => resolveLocalSqlitePath(path.parse(databasePath).root), DomainError);
    assert.throws(
      () => assertLocalFilesystem(databasePath, { statfs: () => ({ type: 0x6969 }) }),
      error => error instanceof DomainError && error.code === 'NETWORK_FILESYSTEM_FORBIDDEN'
    );
    assert.equal(assertLocalFilesystem(databasePath).databasePath, databasePath);
  });

  const connection = await openMultiplayerSqlite({
    databasePath,
    lockOptions: { staleMs: 5_000, updateMs: 1_000 }
  });
  try {
    await test('startup enforces WAL, FK, FULL sync, trusted-schema off and read query-only', async () => {
      assert.equal(connection.assertReady(), true);
      assert.equal(connection.writer.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(connection.writer.pragma('foreign_keys', { simple: true }), 1);
      assert.equal(connection.writer.pragma('synchronous', { simple: true }), SQLITE_CONNECTION_POLICY.synchronous);
      assert.equal(connection.writer.pragma('trusted_schema', { simple: true }), 0);
      assert.equal(connection.reader.pragma('query_only', { simple: true }), 1);
    });

    await test('a second process-lifetime owner is rejected for the same database path', async () => {
      await assert.rejects(
        () => openMultiplayerSqlite({ databasePath }),
        error => error instanceof DomainError && error.code === 'MULTIPLAYER_INSTANCE_ALREADY_RUNNING'
      );
    });

    await test('writer queue uses short BEGIN IMMEDIATE transactions and rolls back failures', async () => {
      await connection.write(database => {
        database.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
        database.prepare('INSERT INTO probe (id, value) VALUES (?, ?)').run(1, 'first');
      });
      await assert.rejects(() => connection.write(database => {
        database.prepare('INSERT INTO probe (id, value) VALUES (?, ?)').run(2, 'rollback');
        throw new Error('fault injection');
      }));
      assert.deepEqual(connection.read(database => database.prepare('SELECT * FROM probe ORDER BY id').all()), [
        { id: 1, value: 'first' }
      ]);
      assert.throws(
        () => beginImmediate(connection.writer, async () => undefined),
        error => error instanceof DomainError && error.code === 'ASYNC_SQLITE_TRANSACTION_FORBIDDEN'
      );
      assert.equal(connection.writer.inTransaction, false);
    });

    await test('online backup creates an integrity-checked independent snapshot', async () => {
      const output = await connection.backup(backupPath);
      assert.equal(output, backupPath);
      const stat = await fsp.stat(output);
      assert.ok(stat.size > 0);
    });
  } finally {
    await connection.close();
  }

  await test('released lifecycle lock permits a later writer to reopen the same path', async () => {
    const reopened = await openMultiplayerSqlite({ databasePath });
    try {
      assert.equal(reopened.read(db => db.prepare('SELECT value FROM probe WHERE id = 1').get().value), 'first');
    } finally {
      await reopened.close();
    }
  });

  await test('close rejects new writes but drains writes already accepted by the queue', async () => {
    const drainPath = path.join(tempRoot, 'drain.sqlite');
    const draining = await openMultiplayerSqlite({ databasePath: drainPath });
    const create = draining.write(database => {
      database.exec('CREATE TABLE drain_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
    });
    const insert = draining.write(database => {
      database.prepare('INSERT INTO drain_probe (id, value) VALUES (?, ?)').run(1, 'preserved');
    });
    const closing = draining.close();
    await assert.rejects(
      () => draining.write(() => undefined),
      error => error instanceof DomainError && error.code === 'SQLITE_WRITER_CLOSED'
    );
    await Promise.all([create, insert, closing]);

    const verified = await openMultiplayerSqlite({ databasePath: drainPath });
    try {
      assert.equal(
        verified.read(database => database.prepare(
          'SELECT value FROM drain_probe WHERE id = 1'
        ).get().value),
        'preserved'
      );
    } finally {
      await verified.close();
    }
  });
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer SQLite startup regression: ${passed} passed`);
