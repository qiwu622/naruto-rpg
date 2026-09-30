import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { DomainError } from '../domain/errors.js';
import {
  acquireSqliteLifecycleLock,
  assertLocalFilesystem,
  resolveLocalSqlitePath
} from './sqlite-lifecycle.js';
import { assertMultiplayerSqliteMigrationState } from './sqlite-migrations.js';

function fail(code, message, details = {}, cause = undefined) {
  throw new DomainError(code, message, details, { cause });
}

async function exists(filePath) {
  return fsp.access(filePath).then(() => true, () => false);
}

function verifyDatabase(databasePath) {
  let database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    database.pragma('foreign_keys = ON');
    database.pragma('trusted_schema = OFF');
    const integrity = database.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      fail('SQLITE_RESTORE_SOURCE_INVALID', 'restore source failed integrity_check');
    }
    const foreignKeys = database.pragma('foreign_key_check');
    if (foreignKeys.length !== 0) {
      fail('SQLITE_RESTORE_SOURCE_INVALID', 'restore source failed foreign_key_check');
    }
    assertMultiplayerSqliteMigrationState(database);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail('SQLITE_RESTORE_SOURCE_INVALID', 'restore source is not a valid multiplayer backup', {}, error);
  } finally {
    database?.close();
  }
}

async function syncFile(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Offline, recoverable restore procedure. The lifecycle lock proves no writer
 * owns the target. Existing db/WAL/SHM files are moved into a rollback
 * directory instead of being deleted, and the standalone backup is verified
 * before and after its atomic rename into place.
 */
export async function restoreMultiplayerSqliteOffline({
  backupPath: backupPathValue,
  databasePath: databasePathValue,
  lockOptions = {}
}) {
  const backupPath = resolveLocalSqlitePath(backupPathValue);
  const databasePath = resolveLocalSqlitePath(databasePathValue);
  if (backupPath === databasePath) {
    fail('SQLITE_RESTORE_PATH_INVALID', 'restore source and target must be different files');
  }
  assertLocalFilesystem(backupPath);
  assertLocalFilesystem(databasePath);
  if (!await exists(backupPath)) {
    fail('SQLITE_RESTORE_SOURCE_NOT_FOUND', 'restore source does not exist');
  }

  const lifecycleLock = await acquireSqliteLifecycleLock(databasePath, lockOptions);
  const nonce = randomUUID().replaceAll('-', '');
  const temporaryPath = `${databasePath}.restore-${nonce}.tmp`;
  const rollbackDirectory = `${databasePath}.pre-restore-${nonce}`;
  const priorFiles = [];
  let installed = false;
  try {
    lifecycleLock.assertOwned();
    verifyDatabase(backupPath);
    await fsp.copyFile(backupPath, temporaryPath, fsConstants.COPYFILE_EXCL);
    await fsp.chmod(temporaryPath, 0o600);
    await syncFile(temporaryPath);
    verifyDatabase(temporaryPath);

    const targetFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    const present = [];
    for (const target of targetFiles) {
      if (await exists(target)) present.push(target);
    }
    if (present.length > 0) {
      await fsp.mkdir(rollbackDirectory, { recursive: false, mode: 0o700 });
      for (const target of present) {
        const rollbackPath = path.join(rollbackDirectory, path.basename(target));
        await fsp.rename(target, rollbackPath);
        priorFiles.push(Object.freeze({ original_path: target, rollback_path: rollbackPath }));
      }
    }

    try {
      await fsp.rename(temporaryPath, databasePath);
      installed = true;
      verifyDatabase(databasePath);
    } catch (error) {
      if (installed && await exists(databasePath)) {
        await fsp.rename(databasePath, `${temporaryPath}.failed`).catch(() => {});
      }
      for (const prior of [...priorFiles].reverse()) {
        if (await exists(prior.rollback_path)) {
          await fsp.rename(prior.rollback_path, prior.original_path);
        }
      }
      throw error;
    }

    return Object.freeze({
      database_path: databasePath,
      backup_path: backupPath,
      rollback_directory: priorFiles.length > 0 ? rollbackDirectory : null,
      prior_files: Object.freeze(priorFiles)
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail('SQLITE_OFFLINE_RESTORE_FAILED', 'offline multiplayer restore failed', {}, error);
  } finally {
    if (await exists(temporaryPath)) await fsp.rm(temporaryPath, { force: true });
    await lifecycleLock.release();
  }
}

export { verifyDatabase as verifyMultiplayerSqliteBackup };
