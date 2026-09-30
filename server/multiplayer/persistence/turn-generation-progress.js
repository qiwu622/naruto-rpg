import { assertTurnGenerationProgress } from '../contracts/turn-progress-contracts.js';

export function readTurnGenerationProgress(database, turn, seat) {
  const run = database.prepare(`
    SELECT run_id, run_status, created_at, updated_at, heartbeat_at
      FROM resolution_runs WHERE turn_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(turn.turn_id);
  if (!run) return null;
  const event = database.prepare(`
    SELECT projected_payload_json, created_at FROM room_events
     WHERE turn_id = ? AND audience = ? AND event_type = 'resolution.progress'
     ORDER BY event_seq DESC LIMIT 1
  `).get(turn.turn_id, seat);
  const payload = event ? JSON.parse(event.projected_payload_json) : {};
  const invocation = database.prepare(`
    SELECT stage, attempt FROM ai_usage_ledger WHERE turn_id = ?
     ORDER BY started_at DESC, rowid DESC LIMIT 1
  `).get(turn.turn_id);
  const paused = ['REPAIR_PAUSED', 'RETRYABLE_FAILED', 'AWAITING_BILLING_AUTHORIZATION'].includes(turn.turn_status);
  // Older paused runs did not publish their item errors. Recover only safe
  // categories/codes from the ledger, without decrypting or exposing artifacts.
  const items = paused ? database.prepare(`
    SELECT item_kind, error_code FROM turn_continuity_command_items
     WHERE command_attempt_id = (
       SELECT command_attempt_id FROM turn_continuity_commands WHERE run_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
     ) AND error_code IS NOT NULL
  `).all(run.run_id) : [];
  const detail = paused ? (payload.detail ?? {}) : {};
  return assertTurnGenerationProgress({
    model_stage: invocation?.stage ?? payload.model_stage ?? null,
    attempt: invocation?.attempt ?? payload.attempt ?? null,
    run_status: run.run_status,
    started_at: run.created_at,
    updated_at: event?.created_at ?? run.updated_at,
    heartbeat_at: run.heartbeat_at,
    resume_stage: paused ? (payload.resume_stage ?? null) : null,
    reason: paused ? (payload.reason ?? null) : null,
    error_code: paused ? (payload.error_code ?? items[0]?.error_code ?? null) : null,
    failure_kind: detail.failure_kind ?? items[0]?.item_kind ?? null,
    repair_attempts: detail.repair_attempts ?? null,
    remaining_items: detail.remaining_items ?? (items.length || null)
  });
}
