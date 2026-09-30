import { DomainError } from '../domain/errors.js';

const ACTIVE_RUN_STATUSES = Object.freeze(['CLAIMED', 'RUNNING']);
const TERMINAL_OR_PAUSED_STATUSES = Object.freeze(['PAUSED', 'SUCCEEDED', 'FAILED', 'ABANDONED']);

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details);
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 256) {
    fail('LEASE_INPUT_INVALID', `${label} must be a non-empty identifier`);
  }
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('LEASE_INPUT_INVALID', `${label} must be an ISO timestamp`);
  }
  return value;
}

function assertLeaseWindow(now, expiresAt) {
  assertTimestamp(now, 'now');
  assertTimestamp(expiresAt, 'expires_at');
  if (Date.parse(expiresAt) <= Date.parse(now)) {
    fail('LEASE_INPUT_INVALID', 'lease expiry must be later than now');
  }
}

function leaseResult(row) {
  return Object.freeze({
    run_id: row.run_id,
    run_status: row.run_status,
    owner_boot_id: row.owner_boot_id,
    owner_task_id: row.owner_task_id,
    lease_fence: row.lease_fence,
    claimed_at: row.claimed_at,
    heartbeat_at: row.heartbeat_at,
    lease_expires_at: row.lease_expires_at,
    attempt_count: row.attempt_count
  });
}

/**
 * Persistent logical-worker leases for the single Node process. Every method
 * delegates to the connection's serialized BEGIN IMMEDIATE writer.
 */
export function createResolutionRunLeaseRepository(connection) {
  if (!connection || typeof connection.write !== 'function' || typeof connection.read !== 'function') {
    fail('LEASE_CONFIGURATION_INVALID', 'a multiplayer SQLite connection is required');
  }

  async function claim({ run_id, owner_boot_id, owner_task_id, now, expires_at }) {
    assertIdentifier(run_id, 'run_id');
    assertIdentifier(owner_boot_id, 'owner_boot_id');
    assertIdentifier(owner_task_id, 'owner_task_id');
    assertLeaseWindow(now, expires_at);
    return connection.write(database => {
      const row = database.prepare(`
        UPDATE resolution_runs
           SET run_status = 'CLAIMED',
               owner_boot_id = ?,
               owner_task_id = ?,
               claimed_at = ?,
               heartbeat_at = ?,
               lease_expires_at = ?,
               lease_fence = lease_fence + 1,
               attempt_count = attempt_count + 1,
               updated_at = ?
         WHERE run_id = ?
           AND EXISTS (
             SELECT 1 FROM multiplayer_turns AS turn_gate
              WHERE turn_gate.turn_id = resolution_runs.turn_id
                AND turn_gate.turn_status != 'AWAITING_BILLING_AUTHORIZATION'
           )
           AND (
             run_status = 'QUEUED'
             OR (run_status IN ('CLAIMED', 'RUNNING') AND lease_expires_at <= ?)
           )
        RETURNING run_id, run_status, owner_boot_id, owner_task_id, lease_fence,
                  claimed_at, heartbeat_at, lease_expires_at, attempt_count
      `).get(
        owner_boot_id,
        owner_task_id,
        now,
        now,
        expires_at,
        now,
        run_id,
        now
      );
      if (!row) {
        const current = database.prepare(`
          SELECT run_status, owner_boot_id, owner_task_id, lease_fence, lease_expires_at
            FROM resolution_runs WHERE run_id = ?
        `).get(run_id);
        if (!current) fail('RUN_NOT_FOUND', 'resolution run does not exist');
        fail('RUN_LEASE_NOT_CLAIMABLE', 'resolution run is not currently claimable', {
          run_status: current.run_status,
          lease_fence: current.lease_fence,
          lease_expires_at: current.lease_expires_at
        });
      }

      const draft = database.prepare(`
        SELECT draft_id, lease_fence, draft_revision, draft_status
          FROM turn_drafts WHERE run_id = ?
      `).get(run_id);
      if (draft && draft.lease_fence !== row.lease_fence) {
        const updated = database.prepare(`
          UPDATE turn_drafts
             SET lease_fence = ?,
                 draft_revision = draft_revision + 1,
                 draft_status = CASE WHEN draft_status = 'DISCARDED' THEN 'DISCARDED' ELSE 'OPEN' END,
                 ready_receipt_hash = NULL,
                 updated_at = ?
           WHERE draft_id = ? AND run_id = ? AND lease_fence = ? AND draft_revision = ?
        `).run(
          row.lease_fence,
          now,
          draft.draft_id,
          run_id,
          draft.lease_fence,
          draft.draft_revision
        );
        if (updated.changes !== 1) {
          fail('DRAFT_REVISION_CONFLICT', 'turn draft changed while rebinding its lease fence');
        }
      }
      return leaseResult(row);
    });
  }

  async function start({ run_id, owner_boot_id, owner_task_id, lease_fence, now }) {
    assertIdentifier(run_id, 'run_id');
    assertIdentifier(owner_boot_id, 'owner_boot_id');
    assertIdentifier(owner_task_id, 'owner_task_id');
    assertTimestamp(now, 'now');
    if (!Number.isSafeInteger(lease_fence) || lease_fence < 1) {
      fail('LEASE_INPUT_INVALID', 'lease_fence must be a positive integer');
    }
    return connection.write(database => {
      const row = database.prepare(`
        UPDATE resolution_runs
           SET run_status = 'RUNNING', updated_at = ?
         WHERE run_id = ? AND run_status = 'CLAIMED'
           AND owner_boot_id = ? AND owner_task_id = ? AND lease_fence = ?
           AND lease_expires_at > ?
        RETURNING run_id, run_status, owner_boot_id, owner_task_id, lease_fence,
                  claimed_at, heartbeat_at, lease_expires_at, attempt_count
      `).get(now, run_id, owner_boot_id, owner_task_id, lease_fence, now);
      if (!row) fail('STALE_LEASE_FENCE', 'run lease cannot be started by this owner/fence');
      return leaseResult(row);
    });
  }

  async function renew({
    run_id,
    owner_boot_id,
    owner_task_id,
    lease_fence,
    now,
    expires_at
  }) {
    assertIdentifier(run_id, 'run_id');
    assertIdentifier(owner_boot_id, 'owner_boot_id');
    assertIdentifier(owner_task_id, 'owner_task_id');
    assertLeaseWindow(now, expires_at);
    if (!Number.isSafeInteger(lease_fence) || lease_fence < 1) {
      fail('LEASE_INPUT_INVALID', 'lease_fence must be a positive integer');
    }
    return connection.write(database => {
      const row = database.prepare(`
        UPDATE resolution_runs
           SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE run_id = ? AND run_status IN ('CLAIMED', 'RUNNING')
           AND owner_boot_id = ? AND owner_task_id = ? AND lease_fence = ?
           AND lease_expires_at > ?
        RETURNING run_id, run_status, owner_boot_id, owner_task_id, lease_fence,
                  claimed_at, heartbeat_at, lease_expires_at, attempt_count
      `).get(
        now,
        expires_at,
        now,
        run_id,
        owner_boot_id,
        owner_task_id,
        lease_fence,
        now
      );
      if (!row) fail('STALE_LEASE_FENCE', 'run lease renewal was rejected');
      return leaseResult(row);
    });
  }

  async function release({
    run_id,
    owner_boot_id,
    owner_task_id,
    lease_fence,
    next_status,
    now
  }) {
    assertIdentifier(run_id, 'run_id');
    assertIdentifier(owner_boot_id, 'owner_boot_id');
    assertIdentifier(owner_task_id, 'owner_task_id');
    assertTimestamp(now, 'now');
    if (!Number.isSafeInteger(lease_fence) || lease_fence < 1) {
      fail('LEASE_INPUT_INVALID', 'lease_fence must be a positive integer');
    }
    if (!TERMINAL_OR_PAUSED_STATUSES.includes(next_status)) {
      fail('LEASE_INPUT_INVALID', 'lease release status is invalid');
    }
    return connection.write(database => {
      const row = database.prepare(`
        UPDATE resolution_runs
           SET run_status = ?,
               owner_boot_id = NULL,
               owner_task_id = NULL,
               claimed_at = NULL,
               heartbeat_at = NULL,
               lease_expires_at = NULL,
               updated_at = ?
         WHERE run_id = ? AND run_status IN ('CLAIMED', 'RUNNING')
           AND owner_boot_id = ? AND owner_task_id = ? AND lease_fence = ?
        RETURNING run_id, run_status, owner_boot_id, owner_task_id, lease_fence,
                  claimed_at, heartbeat_at, lease_expires_at, attempt_count
      `).get(
        next_status,
        now,
        run_id,
        owner_boot_id,
        owner_task_id,
        lease_fence
      );
      if (!row) fail('STALE_LEASE_FENCE', 'run lease release was rejected');
      return leaseResult(row);
    });
  }

  function assertFence({ run_id, owner_boot_id, owner_task_id, lease_fence, now }) {
    assertIdentifier(run_id, 'run_id');
    assertIdentifier(owner_boot_id, 'owner_boot_id');
    assertIdentifier(owner_task_id, 'owner_task_id');
    assertTimestamp(now, 'now');
    if (!Number.isSafeInteger(lease_fence) || lease_fence < 1) {
      fail('LEASE_INPUT_INVALID', 'lease_fence must be a positive integer');
    }
    const row = connection.read(database => database.prepare(`
      SELECT run_id, run_status, owner_boot_id, owner_task_id, lease_fence,
             claimed_at, heartbeat_at, lease_expires_at, attempt_count
        FROM resolution_runs
       WHERE run_id = ? AND run_status IN ('CLAIMED', 'RUNNING')
         AND owner_boot_id = ? AND owner_task_id = ? AND lease_fence = ?
         AND lease_expires_at > ?
    `).get(run_id, owner_boot_id, owner_task_id, lease_fence, now));
    if (!row) fail('STALE_LEASE_FENCE', 'run lease fence is stale or expired');
    return leaseResult(row);
  }

  function listClaimable({ now, limit = 32 } = {}) {
    assertTimestamp(now, 'now');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      fail('LEASE_INPUT_INVALID', 'claimable run limit must be between 1 and 256');
    }
    return Object.freeze(connection.read(database => database.prepare(`
      SELECT run_id, room_id, epoch_id, turn_id, stage, run_status,
             lease_fence, lease_expires_at, attempt_count
        FROM resolution_runs
       WHERE EXISTS (
             SELECT 1 FROM multiplayer_turns AS turn_gate
              WHERE turn_gate.turn_id = resolution_runs.turn_id
                AND turn_gate.turn_status != 'AWAITING_BILLING_AUTHORIZATION'
           )
         AND (
           run_status = 'QUEUED'
           OR (run_status IN ('CLAIMED', 'RUNNING') AND lease_expires_at <= ?)
         )
       ORDER BY created_at, run_id
       LIMIT ?
    `).all(now, limit)).map(row => Object.freeze({ ...row })));
  }

  return Object.freeze({ claim, start, renew, release, assertFence, listClaimable });
}

export { ACTIVE_RUN_STATUSES };
