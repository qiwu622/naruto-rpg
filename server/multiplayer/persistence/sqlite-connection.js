import fsp from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DomainError } from '../domain/errors.js';
import {
  acquireSqliteLifecycleLock,
  assertLocalFilesystem,
  resolveLocalSqlitePath
} from './sqlite-lifecycle.js';
import {
  CURRENT_MULTIPLAYER_SCHEMA_VERSION,
  applyMultiplayerSqliteMigrations
} from './sqlite-migrations.js';

export const SQLITE_CONNECTION_POLICY = Object.freeze({
  journalMode: 'wal',
  foreignKeys: true,
  synchronous: 2,
  busyTimeoutMs: 5_000,
  trustedSchema: false
});

function connectionError(code, message, details = {}, cause = undefined) {
  return new DomainError(code, message, details, { cause });
}

function assertPragmaValue(actual, expected, name) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw connectionError(
      'SQLITE_STARTUP_SELF_CHECK_FAILED',
      `SQLite pragma ${name} did not retain its required value`,
      { pragma: name, expected, actual }
    );
  }
}

function configureConnection(database, policy) {
  database.pragma(`busy_timeout = ${policy.busyTimeoutMs}`);
  database.pragma('foreign_keys = ON');
  database.pragma('trusted_schema = OFF');
}

function assertIntegrity(database) {
  const rows = database.pragma('integrity_check');
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
    throw connectionError(
      'SQLITE_INTEGRITY_CHECK_FAILED',
      'SQLite integrity_check did not return ok'
    );
  }
  const foreignKeyViolations = database.pragma('foreign_key_check');
  if (!Array.isArray(foreignKeyViolations) || foreignKeyViolations.length > 0) {
    throw connectionError(
      'SQLITE_FOREIGN_KEY_CHECK_FAILED',
      'SQLite foreign_key_check found multiplayer referential-integrity violations',
      { violations: foreignKeyViolations }
    );
  }
}

export class SqliteWriterQueue {
  #tail = Promise.resolve();
  #closed = false;
  #pending = 0;

  run(operation) {
    if (this.#closed) {
      return Promise.reject(connectionError(
        'SQLITE_WRITER_CLOSED',
        'The multiplayer SQLite writer queue is closed'
      ));
    }
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('writer operation must be a function'));
    }
    this.#pending += 1;
    const execute = () => operation();
    const result = this.#tail.then(execute, execute);
    this.#tail = result.then(
      () => { this.#pending -= 1; },
      () => { this.#pending -= 1; }
    );
    return result;
  }

  stats() {
    return Object.freeze({ closed: this.#closed, pending: this.#pending });
  }

  async drainAndClose() {
    this.#closed = true;
    await this.#tail;
  }
}

export function beginImmediate(database, operation) {
  if (typeof operation !== 'function') throw new TypeError('transaction operation must be a function');
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = operation(database);
    if (value && typeof value.then === 'function') {
      throw connectionError(
        'ASYNC_SQLITE_TRANSACTION_FORBIDDEN',
        'SQLite transactions must not await network or asynchronous work'
      );
    }
    database.exec('COMMIT');
    return value;
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export async function openMultiplayerSqlite(options = {}) {
  const databasePath = resolveLocalSqlitePath(options.databasePath);
  const policy = Object.freeze({
    ...SQLITE_CONNECTION_POLICY,
    busyTimeoutMs: Number.isSafeInteger(options.busyTimeoutMs)
      ? options.busyTimeoutMs
      : SQLITE_CONNECTION_POLICY.busyTimeoutMs
  });
  if (policy.busyTimeoutMs < 100 || policy.busyTimeoutMs > 60_000) {
    throw connectionError('INVALID_SQLITE_BUSY_TIMEOUT', 'SQLite busy timeout is outside its safe range');
  }

  await fsp.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  assertLocalFilesystem(databasePath, options.filesystemOptions);
  const lifecycleLock = await acquireSqliteLifecycleLock(databasePath, options.lockOptions);
  let writer;
  let reader;
  let migrationState;
  try {
    lifecycleLock.assertOwned();
    writer = new Database(databasePath, {
      fileMustExist: false,
      timeout: policy.busyTimeoutMs
    });
    configureConnection(writer, policy);
    const journalMode = writer.pragma('journal_mode = WAL', { simple: true });
    writer.pragma('synchronous = FULL');
    assertPragmaValue(journalMode, policy.journalMode, 'journal_mode');
    assertPragmaValue(writer.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys');
    assertPragmaValue(writer.pragma('synchronous', { simple: true }), policy.synchronous, 'synchronous');
    assertPragmaValue(writer.pragma('trusted_schema', { simple: true }), 0, 'trusted_schema');
    migrationState = applyMultiplayerSqliteMigrations(writer, options.migrationOptions);
    assertIntegrity(writer);

    reader = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: policy.busyTimeoutMs
    });
    configureConnection(reader, policy);
    reader.pragma('query_only = ON');
    assertPragmaValue(reader.pragma('query_only', { simple: true }), 1, 'query_only');
  } catch (error) {
    try { reader?.close(); } catch {}
    try { writer?.close(); } catch {}
    await lifecycleLock.release();
    throw connectionError(
      error?.code || 'SQLITE_STARTUP_FAILED',
      error?.message || 'Failed to initialize multiplayer SQLite',
      { database_path: databasePath },
      error
    );
  }

  const queue = new SqliteWriterQueue();
  let closed = false;
  let closing = false;
  let closePromise = null;
  let sqliteBusyCount = 0;
  let lastBackupAt = null;
  const writeDurationsMs = [];
  return {
    databasePath,
    policy,
    schemaVersion: CURRENT_MULTIPLAYER_SCHEMA_VERSION,
    migrationState,
    writer,
    reader,
    queue,
    lifecycleLock,
    assertReady() {
      if (closed) throw connectionError('SQLITE_CONNECTION_CLOSED', 'Multiplayer SQLite is closed');
      lifecycleLock.assertOwned();
      assertPragmaValue(writer.pragma('journal_mode', { simple: true }), policy.journalMode, 'journal_mode');
      assertPragmaValue(writer.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys');
      assertPragmaValue(
        writer.pragma('user_version', { simple: true }),
        CURRENT_MULTIPLAYER_SCHEMA_VERSION,
        'user_version'
      );
      return true;
    },
    write(operation) {
      return queue.run(() => {
        this.assertReady();
        const startedAt = performance.now();
        try {
          return beginImmediate(writer, operation);
        } catch (error) {
          if (error?.code === 'SQLITE_BUSY' || error?.cause?.code === 'SQLITE_BUSY') {
            sqliteBusyCount += 1;
          }
          throw error;
        } finally {
          writeDurationsMs.push(performance.now() - startedAt);
          if (writeDurationsMs.length > 512) writeDurationsMs.shift();
        }
      });
    },
    read(operation) {
      if (closed) throw connectionError('SQLITE_CONNECTION_CLOSED', 'Multiplayer SQLite is closed');
      if (typeof operation !== 'function') throw new TypeError('read operation must be a function');
      return operation(reader);
    },
    async backup(destinationPath) {
      if (closed) throw connectionError('SQLITE_CONNECTION_CLOSED', 'Multiplayer SQLite is closed');
      const resolvedDestination = path.resolve(destinationPath);
      await fsp.mkdir(path.dirname(resolvedDestination), { recursive: true, mode: 0o700 });
      await writer.backup(resolvedDestination);
      const verify = new Database(resolvedDestination, { readonly: true, fileMustExist: true });
      try {
        assertIntegrity(verify);
      } finally {
        verify.close();
      }
      lastBackupAt = new Date().toISOString();
      return resolvedDestination;
    },
    async operationalMetrics() {
      if (closed) throw connectionError('SQLITE_CONNECTION_CLOSED', 'Multiplayer SQLite is closed');
      const checkpoint = await queue.run(() => {
        this.assertReady();
        return writer.pragma('wal_checkpoint(PASSIVE)')[0] ?? {};
      });
      const walPath = `${databasePath}-wal`;
      const walBytes = await fsp.stat(walPath).then(stats => stats.size, error => {
        if (error?.code === 'ENOENT') return 0;
        throw error;
      });
      const sortedDurations = [...writeDurationsMs].sort((left, right) => left - right);
      const p95Index = sortedDurations.length === 0
        ? -1
        : Math.min(sortedDurations.length - 1, Math.ceil(sortedDurations.length * 0.95) - 1);
      return Object.freeze({
        writer_queue_pending: queue.stats().pending,
        sqlite_busy_count: sqliteBusyCount,
        write_count: writeDurationsMs.length,
        commit_p95_ms: p95Index < 0 ? 0 : sortedDurations[p95Index],
        wal_bytes: walBytes,
        checkpoint_busy: Number(checkpoint.busy ?? 0),
        checkpoint_log_frames: Number(checkpoint.log ?? 0),
        checkpointed_frames: Number(checkpoint.checkpointed ?? 0),
        last_backup_at: lastBackupAt
      });
    },
    async close() {
      if (closePromise) return closePromise;
      if (closed) return;
      closing = true;
      closePromise = (async () => {
        // Closing the queue rejects new writes immediately, while already
        // accepted operations must still be allowed through assertReady().
        // Marking the connection closed before this drain made every queued
        // operation fail with SQLITE_CONNECTION_CLOSED during shutdown.
        await queue.drainAndClose();
        closed = true;
        try { reader.close(); } finally {
          try { writer.close(); } finally {
            await lifecycleLock.release();
          }
        }
      })();
      try {
        await closePromise;
      } finally {
        closing = false;
      }
    }
  };
}
