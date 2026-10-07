import { openMultiplayerSqlite } from '../../server/multiplayer/persistence/sqlite-connection.js';

/**
 * Repository regressions and diagnostics use the production SQLite driver,
 * reader/writer connections, lifecycle lock and shutdown path. Keep this
 * helper name so callers no longer need a Node-version-specific adapter.
 */
export async function openMultiplayerRepositoryTestSqlite(options) {
  return openMultiplayerSqlite(options);
}
