import { randomInt, randomUUID } from 'node:crypto';

import {
  RESOLUTION_CHECK_RESULT_SCHEMA,
  assertResolutionCheckRequest,
  assertResolutionCheckResolvedResult,
  computeResolutionCheckResultHash
} from '../contracts/resolution-check-contracts.js';
import {
  AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH,
  planAuthoritativeResolutionCheck,
  resolveAuthoritativeResolutionCheckOutcome
} from '../domain/authoritative-resolution-check.js';
import { canonicalStringify, canonicalizeJson, sha256Hex } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { computeResolutionCheckRequestHash } from '../domain/resolution-check-ledger.js';

const LEDGER_STAGE = 'resolution_check_ledger';
const LEDGER_SCHEMA = 'naruto.multiplayer-persistent-resolution-check-ledger/v1';
const LEDGER_CONTEXT_SCHEMA =
  'naruto.multiplayer-persistent-resolution-check-ledger-context/v1';
const ID = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;

function fail(code, message, details = {}, status = 500, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('RESOLUTION_CHECK_PERSISTENCE_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('RESOLUTION_CHECK_PERSISTENCE_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail('RESOLUTION_CHECK_PERSISTENCE_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function immutable(value) {
  const normalized = canonicalizeJson(value);
  const freeze = current => {
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(normalized);
}

function ledgerHash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function generatedId(idFactory, kind) {
  const value = idFactory(kind);
  return identifier(value, `${kind}_id`);
}

function defaultIdFactory(kind) {
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

function timestamp(clock) {
  const value = clock();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('RESOLUTION_CHECK_PERSISTENCE_INVALID', 'clock returned an invalid timestamp');
  }
  return value;
}

function conflictKeyHash(request) {
  return `sha256:${sha256Hex({
    schema: 'naruto.multiplayer-resolution-conflict-key/v1',
    participant_refs: [...request.participant_refs].sort(),
    conflict_type: request.conflict_type
  })}`;
}

function context(row) {
  return Object.freeze({
    schema: LEDGER_CONTEXT_SCHEMA,
    stage_session_id: row.stage_session_id,
    run_id: row.run_id,
    room_id: row.room_id,
    epoch_id: row.epoch_id,
    turn_id: row.turn_id,
    base_state_revision: row.base_state_revision,
    base_state_hash: row.base_state_hash,
    rule_snapshot_hash: AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH
  });
}

function envelope(row) {
  return {
    action_ciphertext: Buffer.from(row.session_state_ciphertext),
    wrapped_data_key: Buffer.from(row.wrapped_data_key),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    master_key_version: row.master_key_version
  };
}

function assertLedger(value, row) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== LEDGER_SCHEMA
    || value.referee_session_id !== row.run_id
    || value.room_id !== row.room_id
    || value.epoch_id !== row.epoch_id
    || value.turn_id !== row.turn_id
    || value.base_state_revision !== row.base_state_revision
    || value.base_state_hash !== row.base_state_hash
    || value.rule_snapshot_hash !== AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH
    || !Array.isArray(value.attempts)) {
    fail('PERSISTED_RESOLUTION_CHECK_CORRUPT', 'resolution check ledger binding is invalid');
  }
  return value;
}

function openLedger(contentCodec, row) {
  let opened;
  try {
    opened = contentCodec.openJson(envelope(row), context(row));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail(
      'PERSISTED_RESOLUTION_CHECK_CORRUPT',
      'resolution check ledger envelope authentication failed',
      {},
      500,
      error
    );
  }
  const ledger = assertLedger(opened, row);
  if (ledgerHash(ledger) !== row.session_state_hash) {
    fail('PERSISTED_RESOLUTION_CHECK_CORRUPT', 'resolution check ledger hash changed');
  }
  return ledger;
}

function emptyLedger(row) {
  return {
    schema: LEDGER_SCHEMA,
    referee_session_id: row.run_id,
    room_id: row.room_id,
    epoch_id: row.epoch_id,
    turn_id: row.turn_id,
    base_state_revision: row.base_state_revision,
    base_state_hash: row.base_state_hash,
    rule_snapshot_hash: AUTHORITATIVE_RESOLUTION_CHECK_RULE_SNAPSHOT_HASH,
    attempts: []
  };
}

function persistedRow(database, runId) {
  const row = database.prepare(`
    SELECT s.*, r.run_id AS authority_run_id,
           r.room_id, r.epoch_id, r.turn_id, r.run_status, r.lease_fence,
           t.base_state_revision, t.base_state_hash
      FROM resolution_runs AS r
      JOIN multiplayer_turns AS t ON t.turn_id = r.turn_id
      LEFT JOIN agent_stage_sessions AS s
        ON s.run_id = r.run_id AND s.stage = ? AND s.audience = 'none'
     WHERE r.run_id = ?
  `).get(LEDGER_STAGE, runId);
  return row ? { ...row, run_id: row.authority_run_id } : null;
}

function assertAuthority(row, requestContext) {
  if (!row) fail('RUN_NOT_FOUND', 'resolution run does not exist', {}, 404);
  if (!['CLAIMED', 'RUNNING'].includes(row.run_status)
    || row.lease_fence !== requestContext.lease_fence) {
    fail('STALE_LEASE_FENCE', 'resolution check is not bound to the live run lease', {}, 409);
  }
  for (const field of ['room_id', 'epoch_id', 'turn_id', 'base_state_revision', 'base_state_hash']) {
    if (row[field] !== requestContext[field]) {
      fail('BASE_HASH_MISMATCH', 'resolution check context changed from the frozen turn base', {
        field
      }, 409);
    }
  }
}

function buildRejectedResult(request, decision) {
  const material = {
    schema: RESOLUTION_CHECK_RESULT_SCHEMA,
    status: 'REJECTED',
    check_id: request.check_id,
    error_code: decision.error_code,
    allowed_correction_fields: decision.allowed_correction_fields
  };
  return immutable({ ...material, result_hash: computeResolutionCheckResultHash(material) });
}

function randomRolls(specs, randomInteger) {
  return specs.map((spec, rollIndex) => {
    const raw = randomInteger(spec.minimum, spec.maximum, Object.freeze({
      roll_index: rollIndex,
      participant_ref: spec.participant_ref
    }));
    if (!Number.isSafeInteger(raw) || raw < spec.minimum || raw > spec.maximum) {
      fail('INVALID_RESOLUTION_CHECK_RANDOM_VALUE', 'authoritative random source returned an invalid value');
    }
    const total = raw + spec.modifier;
    if (!Number.isSafeInteger(total)) {
      fail('INVALID_RESOLUTION_CHECK_TOTAL', 'resolution check total exceeds safe integer range');
    }
    return immutable({
      participant_ref: spec.participant_ref,
      raw,
      modifier: spec.modifier,
      total
    });
  });
}

/**
 * Encrypted, restart-safe authority for Referee checks. The random draw and
 * encrypted ledger write occur inside one SQLite transaction, so a committed
 * request hash can never be rolled twice after a process restart.
 */
export function createSqliteResolutionCheckRepository(connection, {
  contentCodec,
  idFactory = defaultIdFactory,
  clock = () => new Date().toISOString(),
  randomInteger = (minimum, maximum) => randomInt(minimum, maximum + 1)
} = {}) {
  if (!connection || typeof connection.write !== 'function'
    || typeof connection.read !== 'function'
    || typeof contentCodec?.sealJson !== 'function'
    || typeof contentCodec?.openJson !== 'function'
    || typeof idFactory !== 'function'
    || typeof clock !== 'function'
    || typeof randomInteger !== 'function') {
    fail('RESOLUTION_CHECK_PERSISTENCE_CONFIGURATION_INVALID', 'resolution check repository dependencies are incomplete');
  }

  async function execute(value) {
    const request = assertResolutionCheckRequest(value?.request);
    const authority = {
      run_id: identifier(value?.run_id, 'run_id'),
      room_id: identifier(value?.room_id, 'room_id'),
      epoch_id: identifier(value?.epoch_id, 'epoch_id'),
      turn_id: identifier(value?.turn_id, 'turn_id'),
      lease_fence: revision(value?.lease_fence, 'lease_fence'),
      base_state_revision: revision(value?.base_state_revision, 'base_state_revision'),
      base_state_hash: hash(value?.base_state_hash, 'base_state_hash')
    };
    const requestHash = computeResolutionCheckRequestHash({
      session_id: authority.run_id,
      request
    });
    const conflictHash = conflictKeyHash(request);
    const planned = planAuthoritativeResolutionCheck({ request, state: value?.state });
    const now = timestamp(clock);

    return connection.write(database => {
      const stored = persistedRow(database, authority.run_id);
      assertAuthority(stored, authority);
      const hasStoredLedger = stored.stage_session_id !== null
        && stored.stage_session_id !== undefined;
      const row = hasStoredLedger
        ? stored
        : {
            ...stored,
            stage_session_id: generatedId(idFactory, 'resolution_check_session')
          };
      const ledger = hasStoredLedger
        ? canonicalizeJson(openLedger(contentCodec, row))
        : emptyLedger(row);

      const exact = ledger.attempts.find(attempt => (
        attempt.check_id === request.check_id
        && attempt.check_request_hash === requestHash
      ));
      if (exact) return immutable(exact.result);

      const consumedId = ledger.attempts.find(attempt => (
        attempt.status === 'RESOLVED' && attempt.check_id === request.check_id
      ));
      if (consumedId) {
        fail('CHECK_ID_CONFLICT', 'check_id is already sealed by another request hash', {
          check_id: request.check_id,
          resolved_request_hash: consumedId.check_request_hash,
          attempted_request_hash: requestHash
        }, 409);
      }
      const consumedConflict = ledger.attempts.find(attempt => (
        attempt.status === 'RESOLVED' && attempt.conflict_key_hash === conflictHash
      ));
      if (consumedConflict) {
        fail(
          'RESOLUTION_CONFLICT_ALREADY_CHECKED',
          'the same participant conflict is already sealed under another check_id',
          {
            check_id: request.check_id,
            sealed_check_id: consumedConflict.check_id,
            conflict_type: request.conflict_type
          },
          409
        );
      }

      let result;
      let rollSpecs = [];
      if (planned.decision.status === 'REJECTED') {
        result = buildRejectedResult(request, planned.decision);
      } else {
        rollSpecs = planned.decision.roll_specs;
        const rolls = randomRolls(rollSpecs, (minimum, maximum, randomContext) => (
          randomInteger(minimum, maximum, Object.freeze({
            ...randomContext,
            run_id: authority.run_id,
            turn_id: authority.turn_id,
            check_id: request.check_id,
            check_request_hash: requestHash
          }))
        ));
        const material = {
          schema: RESOLUTION_CHECK_RESULT_SCHEMA,
          status: 'RESOLVED',
          check_id: request.check_id,
          rule_ref: request.rule_ref,
          rolls,
          outcome: resolveAuthoritativeResolutionCheckOutcome({
            request,
            roll_specs: rollSpecs,
            rolls
          })
        };
        result = assertResolutionCheckResolvedResult({
          ...material,
          result_hash: computeResolutionCheckResultHash(material)
        });
      }

      ledger.attempts.push({
        attempt_no: ledger.attempts.length + 1,
        status: result.status,
        check_id: request.check_id,
        check_request_hash: requestHash,
        conflict_key_hash: conflictHash,
        request,
        roll_specs: rollSpecs,
        rule_audit: planned.audit,
        result,
        created_at: now
      });
      const normalizedLedger = immutable(ledger);
      const nextHash = ledgerHash(normalizedLedger);
      const sealed = contentCodec.sealJson(normalizedLedger, context(row));
      if (!hasStoredLedger) {
        database.prepare(`
          INSERT INTO agent_stage_sessions (
            stage_session_id, run_id, stage, audience, continuity_session_id,
            provider_session_ref, transport, session_state_ciphertext,
            wrapped_data_key, nonce, auth_tag, master_key_version,
            session_state_hash, resume_cursor, session_status,
            latest_invocation_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'none', NULL, NULL, 'json_protocol', ?, ?, ?, ?, ?, ?,
            NULL, 'OPEN', NULL, ?, ?)
        `).run(
          row.stage_session_id,
          authority.run_id,
          LEDGER_STAGE,
          sealed.action_ciphertext,
          sealed.wrapped_data_key,
          sealed.nonce,
          sealed.auth_tag,
          sealed.master_key_version,
          nextHash,
          now,
          now
        );
      } else {
        const changed = database.prepare(`
          UPDATE agent_stage_sessions
             SET session_state_ciphertext = ?, wrapped_data_key = ?, nonce = ?,
                 auth_tag = ?, master_key_version = ?, session_state_hash = ?,
                 updated_at = ?
           WHERE stage_session_id = ? AND session_state_hash = ?
        `).run(
          sealed.action_ciphertext,
          sealed.wrapped_data_key,
          sealed.nonce,
          sealed.auth_tag,
          sealed.master_key_version,
          nextHash,
          now,
          row.stage_session_id,
          row.session_state_hash
        );
        if (changed.changes !== 1) {
          fail('DRAFT_REVISION_CONFLICT', 'resolution check ledger CAS failed', {}, 409);
        }
      }
      return immutable(result);
    });
  }

  function getRecord({ run_id, check_id }) {
    const runId = identifier(run_id, 'run_id');
    const checkId = identifier(check_id, 'check_id');
    return connection.read(database => {
      const row = persistedRow(database, runId);
      if (!row || !row.stage_session_id) return null;
      const ledger = openLedger(contentCodec, row);
      const attempts = ledger.attempts.filter(attempt => attempt.check_id === checkId);
      if (attempts.length === 0) return null;
      return immutable({
        schema: 'naruto.multiplayer-persistent-resolution-check-record/v1',
        run_id: runId,
        check_id: checkId,
        consumed: attempts.some(attempt => attempt.status === 'RESOLVED'),
        attempts
      });
    });
  }

  return Object.freeze({ execute, getRecord });
}
