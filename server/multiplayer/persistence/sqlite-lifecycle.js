import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import lockfile from 'proper-lockfile';

import { DomainError } from '../domain/errors.js';

const NETWORK_FILESYSTEM_TYPES = new Map([
  [0x6969, 'nfs'],
  [0x517b, 'smb'],
  [0xff534d42, 'cifs']
]);

export const SQLITE_LIFECYCLE_LOCK_DEFAULTS = Object.freeze({
  staleMs: 30_000,
  updateMs: 10_000
});

function lifecycleError(code, message, details = {}, cause = undefined) {
  return new DomainError(code, message, details, { cause });
}

export function resolveLocalSqlitePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim() === ':memory:') {
    throw lifecycleError(
      'INVALID_MULTIPLAYER_DATABASE_PATH',
      'Multiplayer SQLite requires an explicit local database file path'
    );
  }
  const resolved = path.resolve(value.trim());
  if (path.parse(resolved).root === resolved) {
    throw lifecycleError(
      'INVALID_MULTIPLAYER_DATABASE_PATH',
      'The filesystem root cannot be used as the multiplayer database file'
    );
  }
  return resolved;
}

export function assertLocalFilesystem(databasePath, { statfs = fs.statfsSync } = {}) {
  const resolved = resolveLocalSqlitePath(databasePath);
  const parent = path.dirname(resolved);
  let stats;
  try {
    stats = statfs(parent);
  } catch (error) {
    throw lifecycleError(
      'MULTIPLAYER_DATABASE_FILESYSTEM_CHECK_FAILED',
      'Unable to verify the multiplayer database filesystem',
      { database_path: resolved },
      error
    );
  }
  const type = Number(stats?.type);
  const networkKind = NETWORK_FILESYSTEM_TYPES.get(type);
  if (networkKind) {
    throw lifecycleError(
      'NETWORK_FILESYSTEM_FORBIDDEN',
      'Multiplayer SQLite cannot run on a shared network filesystem',
      { database_path: resolved, filesystem: networkKind }
    );
  }
  return Object.freeze({ databasePath: resolved, filesystemType: type });
}

/**
 * Acquire a process-lifetime lock bound to the canonical database path.
 * `proper-lockfile` uses an atomic lock directory plus heartbeat/staleness
 * checks, so this is not a residual PID-file test.
 */
export async function acquireSqliteLifecycleLock(databasePath, options = {}) {
  const resolved = resolveLocalSqlitePath(databasePath);
  const lockTarget = `${resolved}.instance`;
  const staleMs = Number.isSafeInteger(options.staleMs)
    ? options.staleMs
    : SQLITE_LIFECYCLE_LOCK_DEFAULTS.staleMs;
  const updateMs = Number.isSafeInteger(options.updateMs)
    ? options.updateMs
    : SQLITE_LIFECYCLE_LOCK_DEFAULTS.updateMs;
  if (staleMs < 5_000 || updateMs < 1_000 || updateMs * 2 > staleMs) {
    throw lifecycleError(
      'INVALID_LIFECYCLE_LOCK_CONFIG',
      'Lifecycle lock heartbeat must be bounded and strictly fresher than stale time'
    );
  }

  await fsp.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const handle = await fsp.open(lockTarget, 'a', 0o600);
  await handle.close();

  let compromisedError = null;
  let release;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      retries: 0,
      stale: staleMs,
      update: updateMs,
      onCompromised(error) {
        compromisedError = lifecycleError(
          'MULTIPLAYER_INSTANCE_LOCK_COMPROMISED',
          'The multiplayer SQLite lifecycle lock was compromised',
          { database_path: resolved },
          error
        );
        options.onCompromised?.(compromisedError);
      }
    });
  } catch (error) {
    throw lifecycleError(
      'MULTIPLAYER_INSTANCE_ALREADY_RUNNING',
      'Another multiplayer SQLite writer already owns this database path',
      { database_path: resolved },
      error
    );
  }

  let released = false;
  return Object.freeze({
    databasePath: resolved,
    lockTarget,
    assertOwned() {
      if (released) {
        throw lifecycleError(
          'MULTIPLAYER_INSTANCE_LOCK_RELEASED',
          'The multiplayer SQLite lifecycle lock has already been released',
          { database_path: resolved }
        );
      }
      if (compromisedError) throw compromisedError;
      return true;
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await release();
      } catch (error) {
        if (error?.code !== 'ERELEASED') throw error;
      }
    }
  });
}
