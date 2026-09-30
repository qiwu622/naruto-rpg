import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DomainError } from '../domain/errors.js';

function fail(code, message) {
  throw new DomainError(code, message, {}, { status: 500 });
}

function waitFor(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function backupFilename(clock, idFactory) {
  const instant = clock();
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    fail('SQLITE_BACKUP_SCHEDULER_CLOCK_INVALID', 'backup scheduler clock must return a Date');
  }
  const timestamp = instant.toISOString().replace(/[:.]/gu, '-');
  const suffix = String(idFactory()).replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 32);
  if (!suffix) {
    fail('SQLITE_BACKUP_SCHEDULER_ID_INVALID', 'backup scheduler ID must be filename-safe');
  }
  return `multiplayer-${timestamp}-${suffix}.sqlite`;
}

/**
 * Periodic, non-overlapping online backups through better-sqlite3's backup
 * API. connection.backup performs the consistency snapshot and integrity/FK
 * verification before a run is counted as successful.
 */
export function createSqliteBackupScheduler({
  connection,
  backup_directory,
  interval_ms = 6 * 60 * 60 * 1_000,
  on_error = () => {},
  clock = () => new Date(),
  id_factory = () => randomUUID().replaceAll('-', '')
} = {}) {
  if (typeof connection?.backup !== 'function') {
    fail('SQLITE_BACKUP_SCHEDULER_CONFIGURATION_INVALID', 'connection.backup is required');
  }
  if (typeof backup_directory !== 'string' || !backup_directory.trim()) {
    fail('SQLITE_BACKUP_SCHEDULER_CONFIGURATION_INVALID', 'backup_directory is required');
  }
  if (!Number.isSafeInteger(interval_ms) || interval_ms < 1_000) {
    fail('SQLITE_BACKUP_SCHEDULER_CONFIGURATION_INVALID', 'interval_ms must be at least 1000');
  }
  if (typeof on_error !== 'function' || typeof clock !== 'function'
    || typeof id_factory !== 'function') {
    fail('SQLITE_BACKUP_SCHEDULER_CONFIGURATION_INVALID', 'backup scheduler callbacks are invalid');
  }

  const backupDirectory = path.resolve(backup_directory);
  let loop = null;
  let controller = null;
  let inFlight = null;
  let completedCount = 0;
  let failedCount = 0;
  let lastFailureAt = null;

  function runNow() {
    if (inFlight) return inFlight;
    const destination = path.join(backupDirectory, backupFilename(clock, id_factory));
    inFlight = Promise.resolve(connection.backup(destination)).then(result => {
      completedCount += 1;
      return result;
    }, error => {
      failedCount += 1;
      lastFailureAt = new Date().toISOString();
      throw error;
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function start() {
    if (loop) return loop;
    controller = new AbortController();
    loop = (async () => {
      while (!controller.signal.aborted) {
        try {
          await runNow();
        } catch (error) {
          on_error(error, Object.freeze({ phase: 'sqlite_online_backup' }));
        }
        await waitFor(interval_ms, controller.signal);
      }
    })().finally(() => {
      loop = null;
      controller = null;
    });
    return loop;
  }

  async function quiesce() {
    controller?.abort();
    if (loop) await loop;
    else if (inFlight) await inFlight;
  }

  return Object.freeze({
    start,
    runNow,
    quiesce,
    close: quiesce,
    isRunning: () => loop !== null,
    stats: () => Object.freeze({
      backup_scheduler_running: loop !== null,
      backup_in_flight: inFlight !== null,
      backup_completed_count: completedCount,
      backup_failed_count: failedCount,
      backup_last_failure_at: lastFailureAt
    })
  });
}
