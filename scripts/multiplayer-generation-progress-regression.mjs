import assert from 'node:assert/strict';
import { MultiplayerRoomStore } from '../js/multiplayer/room-store.js';
import { projectedGenerationProgress } from '../js/multiplayer/ui-projection.js';

const store = new MultiplayerRoomStore();
const start = '2026-09-27T06:20:00.000Z';
store.patch({ roomId: 'room_progress', room: { lifecycle: 'ACTIVE', viewer_seat: 'A' },
  connection: { status: 'open', lastEventSeq: 1 } });
store.setTurn({ turn_id: 'turn_progress', turn_no: 1, turn_kind: 'OPENING', status: 'REPAIR_PAUSED',
  generation: { model_stage: 'continuity_repair', run_status: 'PAUSED', attempt: 7,
    started_at: start, updated_at: '2026-09-27T06:21:20.000Z', heartbeat_at: start,
    reason: 'LOOP_BREAKER', error_code: 'AUDIENCE_VIOLATION', failure_kind: 'memory',
    resume_stage: 'repair_turn_bundle', repair_attempts: 8, remaining_items: 2 } });
let view = projectedGenerationProgress(store.state, Date.parse('2026-09-27T07:00:00Z'));
assert.equal(view.tone, 'error');
assert.equal(view.running, false);
assert.equal(view.retryable, true);
assert.match(view.title, /已暂停/);
assert.match(view.detail, /正文已生成/);
assert.match(view.detail, /记忆/);
assert.equal(view.elapsedSeconds, 80, 'paused clock must stop');
assert.match(view.diagnostics, /AUDIENCE_VIOLATION/);

store.setTurn({ ...store.state.turn, status: 'REPAIRING_DRAFT', generation: {
  ...store.state.turn.generation, run_status: 'RUNNING', updated_at: '2026-09-27T06:22:00.000Z',
  heartbeat_at: '2026-09-27T06:22:00.000Z', reason: null, error_code: null,
  failure_kind: null, resume_stage: null, repair_attempts: null, remaining_items: null
} });
view = projectedGenerationProgress(store.state, Date.parse('2026-09-27T06:22:01Z'));
assert.equal(view.running, true);
assert.equal(view.retryable, false);
assert.doesNotMatch(view.diagnostics, /AUDIENCE_VIOLATION/);
store.setConnection({ status: 'reconnecting' });
view = projectedGenerationProgress(store.state, Date.parse('2026-09-27T06:22:02Z'));
assert.equal(view.running, false, 'lost connection must not pretend a live model is confirmed');
assert.match(view.title, /确认/);

store.setConnection({ status: 'open' });
view = projectedGenerationProgress(store.state, Date.parse('2026-09-27T06:24:02Z'));
assert.equal(view.running, false, 'stale worker heartbeat must be visibly uncertain');
assert.match(view.detail, /心跳/);
store.setTurn({ turn_id: 'turn_next', turn_no: 2, turn_kind: 'ACTION', status: 'COLLECTING_ACTIONS' });
view = projectedGenerationProgress(store.state);
assert.equal(view.retryable, false);
assert.equal(view.running, false);
assert.equal(store.state.progress.resumeStage, null);
assert.doesNotMatch(view.diagnostics, /AUDIENCE_VIOLATION/);
console.log('generation progress regression: paused, resumed, disconnected, stale and next-turn states passed');
