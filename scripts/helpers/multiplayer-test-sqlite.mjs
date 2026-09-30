import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  beginImmediate,
  openMultiplayerSqlite
} from '../../server/multiplayer/persistence/sqlite-connection.js';
import { applyMultiplayerSqliteMigrations } from '../../server/multiplayer/persistence/sqlite-migrations.js';

const NODE_MAJOR = Number.parseInt(process.versions.node, 10);
const NodeDatabaseSync = NODE_MAJOR >= 22
  ? (await import('node:sqlite')).DatabaseSync
  : null;

function plainRow(value) {
  if (value === undefined) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [
    key,
    field instanceof Uint8Array && !Buffer.isBuffer(field) ? Buffer.from(field) : field
  ]));
}

const SQLITE_CONSTRAINT_CODES = Object.freeze(new Map([
  [19, 'SQLITE_CONSTRAINT'],
  [275, 'SQLITE_CONSTRAINT_CHECK'],
  [531, 'SQLITE_CONSTRAINT_COMMITHOOK'],
  [787, 'SQLITE_CONSTRAINT_FOREIGNKEY'],
  [1043, 'SQLITE_CONSTRAINT_FUNCTION'],
  [1299, 'SQLITE_CONSTRAINT_NOTNULL'],
  [1555, 'SQLITE_CONSTRAINT_PRIMARYKEY'],
  [1811, 'SQLITE_CONSTRAINT_TRIGGER'],
  [2067, 'SQLITE_CONSTRAINT_UNIQUE'],
  [2323, 'SQLITE_CONSTRAINT_VTAB'],
  [2579, 'SQLITE_CONSTRAINT_ROWID'],
  [2835, 'SQLITE_CONSTRAINT_PINNED'],
  [3091, 'SQLITE_CONSTRAINT_DATATYPE']
]));

function normalizeNodeSqliteError(error) {
  if (error?.code !== 'ERR_SQLITE_ERROR') throw error;
  const numericCode = Number(error.errcode);
  const normalizedCode = SQLITE_CONSTRAINT_CODES.get(numericCode)
    ?? (Number.isInteger(numericCode) && (numericCode & 0xff) === 19
      ? 'SQLITE_CONSTRAINT'
      : null);
  if (!normalizedCode) throw error;
  Object.defineProperty(error, 'code', {
    configurable: true,
    enumerable: true,
    value: normalizedCode,
    writable: true
  });
  throw error;
}

function invokeNodeSqlite(operation) {
  try {
    return operation();
  } catch (error) {
    return normalizeNodeSqliteError(error);
  }
}

class NodeSqliteStatementCompat {
  constructor(statement) {
    this.statement = statement;
  }

  run(...parameters) {
    return invokeNodeSqlite(() => plainRow(this.statement.run(...parameters)));
  }

  get(...parameters) {
    return invokeNodeSqlite(() => plainRow(this.statement.get(...parameters)));
  }

  all(...parameters) {
    return invokeNodeSqlite(() => this.statement.all(...parameters).map(plainRow));
  }

  *iterate(...parameters) {
    let iterator;
    try {
      iterator = this.statement.iterate(...parameters);
      for (const row of iterator) yield plainRow(row);
    } catch (error) {
      normalizeNodeSqliteError(error);
    }
  }
}

export class NodeSqliteDatabaseCompat {
  constructor(databasePath) {
    if (!NodeDatabaseSync) throw new Error('node:sqlite is unavailable on this Node version');
    this.database = new NodeDatabaseSync(databasePath);
    this.inTransaction = false;
  }

  prepare(sql) {
    return new NodeSqliteStatementCompat(this.database.prepare(sql));
  }

  exec(sql) {
    const normalized = String(sql).trim().toUpperCase();
    const result = invokeNodeSqlite(() => this.database.exec(sql));
    if (/^BEGIN(?:\s|$)/u.test(normalized)) this.inTransaction = true;
    if (/^(?:COMMIT|ROLLBACK)(?:\s|$)/u.test(normalized)) this.inTransaction = false;
    return result;
  }

  pragma(source, options = {}) {
    const rows = this.prepare(`PRAGMA ${source}`).all();
    if (options.simple) {
      const first = rows[0];
      return first ? Object.values(first)[0] : undefined;
    }
    return rows;
  }

  close() {
    this.database.close();
  }
}

/**
 * Business-repository regression connection. Node 18 exercises the production
 * better-sqlite3 adapter. Node 22+ uses the built-in synchronous SQLite API to
 * avoid a better-sqlite3@11/Node24 Statement-finalizer incompatibility while
 * executing the exact same migration and SQL transaction paths. Dedicated
 * startup/WAL/backup regressions continue to test the production driver.
 */
export async function openMultiplayerRepositoryTestSqlite({
  databasePath,
  migrationOptions = {}
}) {
  if (!NodeDatabaseSync) return openMultiplayerSqlite({ databasePath, migrationOptions });
  await fsp.mkdir(path.dirname(databasePath), { recursive: true });
  const writer = new NodeSqliteDatabaseCompat(databasePath);
  writer.pragma('foreign_keys = ON');
  writer.pragma('journal_mode = WAL');
  writer.pragma('synchronous = FULL');
  writer.pragma('trusted_schema = OFF');
  applyMultiplayerSqliteMigrations(writer, migrationOptions);
  let closed = false;
  let writeTail = Promise.resolve();
  return {
    databasePath,
    writer,
    reader: writer,
    queue: Object.freeze({
      stats: () => Object.freeze({ closed, pending: 0 })
    }),
    assertReady() {
      if (closed) throw new Error('repository test SQLite connection is closed');
      return true;
    },
    write(operation) {
      const execute = () => {
        this.assertReady();
        return beginImmediate(writer, operation);
      };
      const result = writeTail.then(execute, execute);
      writeTail = result.then(() => undefined, () => undefined);
      return result;
    },
    read(operation) {
      this.assertReady();
      return operation(writer);
    },
    async close() {
      if (closed) return;
      closed = true;
      await writeTail;
      writer.close();
    }
  };
}

export const USING_NODE_SQLITE_COMPAT = NodeDatabaseSync !== null;
