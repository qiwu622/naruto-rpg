import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { DomainError } from '../domain/errors.js';

const MIGRATION_LEDGER_TABLE = 'multiplayer_schema_migrations';
const MIGRATION_LEDGER_SQL = `
CREATE TABLE multiplayer_schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
  checksum TEXT NOT NULL CHECK (length(checksum) = 71 AND substr(checksum, 1, 7) = 'sha256:'),
  applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20)
) STRICT;
`;

function migrationError(code, message, details = {}, cause = undefined) {
  return new DomainError(code, message, details, { cause });
}

function normalizeMigrationSql(sql) {
  return String(sql).replace(/\r\n?/gu, '\n').trimEnd() + '\n';
}

function checksumSql(sql) {
  return `sha256:${createHash('sha256').update(normalizeMigrationSql(sql), 'utf8').digest('hex')}`;
}

const INITIAL_SCHEMA_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0001-initial-schema.sql', import.meta.url),
  'utf8'
));
const LATEST_SOURCE_SNAPSHOTS_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0002-latest-source-snapshots.sql', import.meta.url),
  'utf8'
));
const GENESIS_IMPORT_REVIEWS_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0003-genesis-import-reviews.sql', import.meta.url),
  'utf8'
));
const AI_USAGE_BUDGET_RESERVATIONS_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0004-ai-usage-budget-reservations.sql', import.meta.url),
  'utf8'
));
const NARRATIVE_MODE_SELECTION_SAFETY_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0005-narrative-mode-selection-safety.sql', import.meta.url),
  'utf8'
));
const WRITER_AUDIENCE_ACCEPTANCE_IDEMPOTENCY_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0006-writer-audience-acceptance-idempotency.sql', import.meta.url),
  'utf8'
));
const ROOM_CREDENTIAL_USAGE_POLICY_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0007-room-credential-usage-policy.sql', import.meta.url),
  'utf8'
));
const ROOM_OPENING_DRAFTS_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0008-room-opening-drafts.sql', import.meta.url),
  'utf8'
));
const OPENING_TURN_KIND_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0009-opening-turn-kind.sql', import.meta.url),
  'utf8'
));
const ACTIVE_ROOM_CODES_AND_REUSABLE_PASSWORDS_SQL = normalizeMigrationSql(readFileSync(
  new URL('./migrations/0010-active-room-codes-and-reusable-passwords.sql', import.meta.url),
  'utf8'
));

export const MULTIPLAYER_SQLITE_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'initial_multiplayer_schema',
    checksum: checksumSql(INITIAL_SCHEMA_SQL),
    sql: INITIAL_SCHEMA_SQL
  }),
  Object.freeze({
    version: 2,
    name: 'latest_source_snapshots',
    checksum: checksumSql(LATEST_SOURCE_SNAPSHOTS_SQL),
    sql: LATEST_SOURCE_SNAPSHOTS_SQL
  }),
  Object.freeze({
    version: 3,
    name: 'genesis_import_reviews',
    checksum: checksumSql(GENESIS_IMPORT_REVIEWS_SQL),
    sql: GENESIS_IMPORT_REVIEWS_SQL
  }),
  Object.freeze({
    version: 4,
    name: 'ai_usage_budget_reservations',
    checksum: checksumSql(AI_USAGE_BUDGET_RESERVATIONS_SQL),
    sql: AI_USAGE_BUDGET_RESERVATIONS_SQL
  }),
  Object.freeze({
    version: 5,
    name: 'narrative_mode_selection_safety',
    checksum: checksumSql(NARRATIVE_MODE_SELECTION_SAFETY_SQL),
    sql: NARRATIVE_MODE_SELECTION_SAFETY_SQL
  }),
  Object.freeze({
    version: 6,
    name: 'writer_audience_acceptance_idempotency',
    checksum: checksumSql(WRITER_AUDIENCE_ACCEPTANCE_IDEMPOTENCY_SQL),
    sql: WRITER_AUDIENCE_ACCEPTANCE_IDEMPOTENCY_SQL
  }),
  Object.freeze({
    version: 7,
    name: 'room_credential_usage_policy',
    checksum: checksumSql(ROOM_CREDENTIAL_USAGE_POLICY_SQL),
    sql: ROOM_CREDENTIAL_USAGE_POLICY_SQL
  }),
  Object.freeze({
    version: 8,
    name: 'room_opening_drafts',
    checksum: checksumSql(ROOM_OPENING_DRAFTS_SQL),
    sql: ROOM_OPENING_DRAFTS_SQL
  }),
  Object.freeze({
    version: 9,
    name: 'opening_turn_kind',
    checksum: checksumSql(OPENING_TURN_KIND_SQL),
    sql: OPENING_TURN_KIND_SQL
  }),
  Object.freeze({
    version: 10,
    name: 'active_room_codes_and_reusable_passwords',
    checksum: checksumSql(ACTIVE_ROOM_CODES_AND_REUSABLE_PASSWORDS_SQL),
    sql: ACTIVE_ROOM_CODES_AND_REUSABLE_PASSWORDS_SQL
  }),
  Object.freeze({
    version: 11,
    name: 'room_narrative_presets',
    checksum: checksumSql(readFileSync(new URL('./migrations/0011-room-narrative-presets.sql', import.meta.url), 'utf8')),
    sql: normalizeMigrationSql(readFileSync(new URL('./migrations/0011-room-narrative-presets.sql', import.meta.url), 'utf8'))
  })
]);

export const CURRENT_MULTIPLAYER_SCHEMA_VERSION =
  MULTIPLAYER_SQLITE_MIGRATIONS[MULTIPLAYER_SQLITE_MIGRATIONS.length - 1].version;

export const MULTIPLAYER_SCHEMA_TABLES = Object.freeze([
  'action_submissions',
  'agent_stage_sessions',
  'ai_usage_ledger',
  'canonical_resolutions',
  'data_processing_consents',
  'latest_source_snapshots',
  'model_capability_probes',
  'model_endpoint_profiles',
  'model_execution_grants',
  'multiplayer_members',
  'multiplayer_rooms',
  'multiplayer_turns',
  'narrative_mode_change_requests',
  'narrative_deliveries',
  'resolution_runs',
  'room_actor_bindings',
  'room_chat_messages',
  'room_checkpoints',
  'room_credential_policy_acceptances',
  'room_control_proposals',
  'room_epochs',
  'room_events',
  'room_genesis_import_reviews',
  'room_invites',
  'room_model_profile_bindings',
  'room_opening_drafts',
  'room_outbox',
  'room_snapshots',
  'room_source_imports',
  'save_import_staging',
  'singleplayer_exports',
  'stored_model_credentials',
  'turn_billing_amendments',
  'turn_billing_authorizations',
  'turn_billing_plans',
  'turn_commits',
  'turn_continuity_command_items',
  'turn_continuity_commands',
  'turn_draft_artifact_versions',
  'turn_draft_effects',
  'turn_draft_obligations',
  'turn_drafts',
  'turn_model_selections',
  'turn_output_adoption_events',
  'writer_audience_acceptance_requests'
]);

export const MULTIPLAYER_REQUIRED_PARTIAL_UNIQUE_INDEXES = Object.freeze([
  'model_endpoint_profiles_one_active_revision',
  'model_execution_grants_one_active_revision',
  'multiplayer_rooms_one_current_room_code',
  'multiplayer_turns_one_active_per_epoch',
  'resolution_runs_one_active_per_turn',
  'room_checkpoints_one_commit',
  'room_checkpoints_one_turn',
  'room_epochs_one_active_per_room',
  'room_epochs_one_per_applied_proposal',
  'room_model_profile_bindings_one_active',
  'stored_model_credentials_one_active_revision',
  'turn_draft_artifacts_one_current',
  'turn_model_selections_one_active'
]);

export const MULTIPLAYER_REQUIRED_TABLE_COLUMNS = Object.freeze({
  multiplayer_rooms: Object.freeze([
    'room_code'
  ]),
  multiplayer_turns: Object.freeze([
    'turn_kind'
  ]),
  room_opening_drafts: Object.freeze([
    'room_id',
    'seat_id',
    'revision',
    'draft_json',
    'draft_commitment',
    'confirmed_revision',
    'confirmed_commitment',
    'confirmed_at'
  ]),
  ai_usage_ledger: Object.freeze([
    'reserved_input_tokens',
    'reserved_output_tokens',
    'reserved_retry_count',
    'budget_charge_state',
    'authorization_snapshot_json'
  ]),
  room_genesis_import_reviews: Object.freeze([
    'source_import_id',
    'proposal_id',
    'genesis_codec',
    'source_basis_hash',
    'genesis_state_hash',
    'audience_diff_codec',
    'accepted_by_a_at',
    'accepted_by_b_at',
    'review_status'
  ]),
  latest_source_snapshots: Object.freeze([
    'source_import_id',
    'request_hash',
    'raw_source_hash',
    'normalized_source_hash',
    'normalization_and_rebind_diff_hash',
    'genesis_state_hash',
    'payload_ciphertext'
  ]),
  save_import_staging: Object.freeze([
    'request_hash',
    'state_hash',
    'snapshot_ciphertext',
    'import_status',
    'consumed_room_id'
  ]),
  turn_continuity_commands: Object.freeze([
    'completed_at'
  ]),
  turn_continuity_command_items: Object.freeze([
    'command_attempt_id',
    'item_seq',
    'item_kind',
    'item_status',
    'consumed',
    'before_draft_revision',
    'after_draft_revision',
    'lease_fence'
  ]),
  narrative_mode_change_requests: Object.freeze([
    'room_id',
    'member_id',
    'idempotency_key',
    'request_hash',
    'expected_control_revision',
    'requested_mode',
    'result_disposition',
    'result_control_revision',
    'result_changed'
  ]),
  multiplayer_rooms: Object.freeze([
    'credential_usage_policy',
    'credential_policy_revision'
  ]),
  room_model_profile_bindings: Object.freeze([
    'room_id',
    'member_id',
    'seat_id',
    'owner_user_id',
    'binding_revision',
    'profile_id',
    'profile_revision',
    'active'
  ]),
  room_credential_policy_acceptances: Object.freeze([
    'room_id',
    'policy_revision',
    'member_id',
    'seat_id',
    'user_id',
    'credential_usage_policy',
    'accepted_at'
  ]),
  room_control_proposals: Object.freeze([
    'proposal_revision',
    'source_import_id',
    'proposal_payload_json',
    'accepted_by_a_revision',
    'accepted_by_a_diff_commitment',
    'accepted_by_b_revision',
    'accepted_by_b_diff_commitment'
  ]),
  room_source_imports: Object.freeze([
    'proposal_id',
    'proposal_revision',
    'normalization_and_rebind_diff_hash',
    'import_request_hash',
    'actor_rebind_json',
    'actor_binding_set_hash',
    'audience_diff_codec'
  ]),
  singleplayer_exports: Object.freeze([
    'codec',
    'projection_version',
    'output_format',
    'request_hash'
  ]),
  turn_model_selections: Object.freeze([
    'selected_narrative_mode'
  ]),
  writer_audience_acceptance_requests: Object.freeze([
    'turn_id',
    'selection_id',
    'audience',
    'audience_owner_user_id',
    'idempotency_key',
    'request_hash',
    'expected_control_revision',
    'result_control_revision',
    'result_turn_status',
    'result_selection_hash',
    'accepted_at'
  ])
});

function migrationLedgerExists(database) {
  return database.prepare(`
    SELECT 1 AS present
      FROM sqlite_schema
     WHERE type = 'table' AND name = ?
  `).get(MIGRATION_LEDGER_TABLE)?.present === 1;
}

function applicationObjects(database) {
  return database.prepare(`
    SELECT type, name
      FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
       AND name != ?
     ORDER BY type, name
  `).all(MIGRATION_LEDGER_TABLE);
}

function migrationRows(database) {
  try {
    return database.prepare(`
      SELECT version, name, checksum, applied_at
        FROM multiplayer_schema_migrations
       ORDER BY version
    `).all();
  } catch (error) {
    throw migrationError(
      'SQLITE_MIGRATION_LEDGER_INVALID',
      'The multiplayer migration ledger cannot be read',
      {},
      error
    );
  }
}

function assertKnownMigrationRows(database, userVersion) {
  if (!migrationLedgerExists(database)) {
    if (userVersion === 0) return [];
    throw migrationError(
      'SQLITE_MIGRATION_LEDGER_MISSING',
      'SQLite user_version is set but the multiplayer migration ledger is missing',
      { user_version: userVersion }
    );
  }

  const rows = migrationRows(database);
  const futureRow = rows.find(row => row.version > CURRENT_MULTIPLAYER_SCHEMA_VERSION);
  if (futureRow) {
    throw migrationError(
      'SQLITE_SCHEMA_VERSION_FROM_FUTURE',
      'The multiplayer database contains a migration newer than this server supports',
      { migration_version: futureRow.version, supported_version: CURRENT_MULTIPLAYER_SCHEMA_VERSION }
    );
  }
  if (rows.length !== userVersion) {
    throw migrationError(
      'SQLITE_MIGRATION_VERSION_MISMATCH',
      'SQLite user_version and the migration ledger disagree',
      { user_version: userVersion, ledger_rows: rows.length }
    );
  }

  for (let offset = 0; offset < rows.length; offset += 1) {
    const row = rows[offset];
    const expected = MULTIPLAYER_SQLITE_MIGRATIONS[offset];
    if (!expected || row.version !== expected.version) {
      throw migrationError(
        'SQLITE_MIGRATION_HISTORY_INVALID',
        'The multiplayer migration history is not contiguous',
        { offset, actual_version: row.version, expected_version: expected?.version ?? null }
      );
    }
    if (row.name !== expected.name || row.checksum !== expected.checksum) {
      throw migrationError(
        'SQLITE_MIGRATION_CHECKSUM_MISMATCH',
        'An applied multiplayer migration differs from the immutable server migration',
        {
          version: row.version,
          expected_name: expected.name,
          actual_name: row.name,
          expected_checksum: expected.checksum,
          actual_checksum: row.checksum
        }
      );
    }
  }
  return rows;
}

function assertSchemaManifest(database) {
  const tableRows = database.pragma('table_list');
  const tableByName = new Map(tableRows.map(row => [row.name, row]));
  for (const tableName of [MIGRATION_LEDGER_TABLE, ...MULTIPLAYER_SCHEMA_TABLES]) {
    const row = tableByName.get(tableName);
    if (!row || row.type !== 'table') {
      throw migrationError(
        'SQLITE_SCHEMA_OBJECT_MISSING',
        'A required multiplayer schema table is missing',
        { object_type: 'table', object_name: tableName }
      );
    }
    if (row.strict !== 1) {
      throw migrationError(
        'SQLITE_SCHEMA_NOT_STRICT',
        'A multiplayer schema table is not STRICT',
        { table: tableName }
      );
    }
  }

  for (const [tableName, requiredColumns] of Object.entries(
    MULTIPLAYER_REQUIRED_TABLE_COLUMNS
  )) {
    const actualColumns = new Set(
      database.pragma(`table_info(${tableName})`).map(row => row.name)
    );
    for (const columnName of requiredColumns) {
      if (!actualColumns.has(columnName)) {
        throw migrationError(
          'SQLITE_SCHEMA_OBJECT_MISSING',
          'A required multiplayer schema column is missing',
          { object_type: 'column', table: tableName, object_name: columnName }
        );
      }
    }
  }

  const indexRows = database.prepare(`
    SELECT name, sql
      FROM sqlite_schema
     WHERE type = 'index' AND name IN (${MULTIPLAYER_REQUIRED_PARTIAL_UNIQUE_INDEXES.map(() => '?').join(', ')})
  `).all(...MULTIPLAYER_REQUIRED_PARTIAL_UNIQUE_INDEXES);
  const indexByName = new Map(indexRows.map(row => [row.name, row]));
  for (const indexName of MULTIPLAYER_REQUIRED_PARTIAL_UNIQUE_INDEXES) {
    const sql = indexByName.get(indexName)?.sql || '';
    if (!/CREATE\s+UNIQUE\s+INDEX[\s\S]+\sWHERE\s/iu.test(sql)) {
      throw migrationError(
        'SQLITE_SCHEMA_OBJECT_MISSING',
        'A required partial unique multiplayer index is missing or invalid',
        { object_type: 'partial_unique_index', object_name: indexName }
      );
    }
  }
}

export function assertMultiplayerSqliteMigrationState(database, options = {}) {
  const userVersion = database.pragma('user_version', { simple: true });
  if (!Number.isSafeInteger(userVersion) || userVersion < 0) {
    throw migrationError(
      'SQLITE_SCHEMA_VERSION_INVALID',
      'SQLite returned an invalid user_version',
      { user_version: userVersion }
    );
  }
  if (userVersion > CURRENT_MULTIPLAYER_SCHEMA_VERSION) {
    throw migrationError(
      'SQLITE_SCHEMA_VERSION_FROM_FUTURE',
      'The multiplayer database is newer than this server supports',
      { user_version: userVersion, supported_version: CURRENT_MULTIPLAYER_SCHEMA_VERSION }
    );
  }
  const rows = assertKnownMigrationRows(database, userVersion);
  if (options.requireCurrent !== false && userVersion !== CURRENT_MULTIPLAYER_SCHEMA_VERSION) {
    throw migrationError(
      'SQLITE_SCHEMA_VERSION_OUTDATED',
      'The multiplayer database has not reached the current schema version',
      { user_version: userVersion, required_version: CURRENT_MULTIPLAYER_SCHEMA_VERSION }
    );
  }
  if (userVersion === CURRENT_MULTIPLAYER_SCHEMA_VERSION) assertSchemaManifest(database);
  return Object.freeze({ version: userVersion, migrations: rows.length });
}

function validateAppliedAt(value) {
  if (typeof value !== 'string' || value.length < 20 || !Number.isFinite(Date.parse(value))) {
    throw migrationError(
      'SQLITE_MIGRATION_CLOCK_INVALID',
      'The migration clock must return an ISO timestamp',
      { applied_at: value }
    );
  }
  return value;
}

function runImmediate(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    operation();
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function applyMultiplayerSqliteMigrations(database, options = {}) {
  const initialVersion = database.pragma('user_version', { simple: true });
  if (!Number.isSafeInteger(initialVersion) || initialVersion < 0) {
    throw migrationError('SQLITE_SCHEMA_VERSION_INVALID', 'SQLite returned an invalid user_version');
  }
  if (initialVersion > CURRENT_MULTIPLAYER_SCHEMA_VERSION) {
    throw migrationError(
      'SQLITE_SCHEMA_VERSION_FROM_FUTURE',
      'The multiplayer database is newer than this server supports',
      { user_version: initialVersion, supported_version: CURRENT_MULTIPLAYER_SCHEMA_VERSION }
    );
  }

  const hasLedger = migrationLedgerExists(database);
  if (initialVersion === 0) {
    if (hasLedger) assertKnownMigrationRows(database, initialVersion);
    const objects = applicationObjects(database);
    if (objects.length > 0) {
      throw migrationError(
        'SQLITE_MIGRATION_BASELINE_REQUIRED',
        'Refusing to apply multiplayer migrations over an unversioned non-empty database',
        { existing_objects: objects }
      );
    }
  } else {
    assertKnownMigrationRows(database, initialVersion);
  }

  const applied = [];
  for (const migration of MULTIPLAYER_SQLITE_MIGRATIONS) {
    if (migration.version <= initialVersion) continue;
    const appliedAt = validateAppliedAt(
      typeof options.clock === 'function' ? options.clock() : new Date().toISOString()
    );
    try {
      runImmediate(database, () => {
        if (!migrationLedgerExists(database)) database.exec(MIGRATION_LEDGER_SQL);
        const currentVersion = database.pragma('user_version', { simple: true });
        if (currentVersion !== migration.version - 1) {
          throw migrationError(
            'SQLITE_MIGRATION_CAS_FAILED',
            'The schema version changed while applying a migration',
            { expected_version: migration.version - 1, actual_version: currentVersion }
          );
        }
        database.exec(migration.sql);
        database.prepare(`
          INSERT INTO multiplayer_schema_migrations (version, name, checksum, applied_at)
          VALUES (?, ?, ?, ?)
        `).run(migration.version, migration.name, migration.checksum, appliedAt);
        database.pragma(`user_version = ${migration.version}`);
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw migrationError(
        'SQLITE_MIGRATION_FAILED',
        `Failed to apply multiplayer SQLite migration ${migration.version}`,
        { version: migration.version, name: migration.name },
        error
      );
    }
    applied.push(migration.version);
  }

  const state = assertMultiplayerSqliteMigrationState(database);
  return Object.freeze({
    initialVersion,
    version: state.version,
    applied: Object.freeze(applied)
  });
}
