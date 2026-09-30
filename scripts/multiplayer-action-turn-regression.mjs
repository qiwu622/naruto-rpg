import assert from 'node:assert/strict';
import {
  assertJsonSafe,
  canonicalizeJson,
  canonicalStringify,
  hmacSha256,
  sha256Hex
} from '../server/multiplayer/domain/canonical-json.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  ACTION_REQUEST_SCHEMA,
  buildRefereeInput,
  buildWriterActionProjection,
  commitActionTurn,
  createActionTurn,
  lockActionSubmission,
  projectActionTurn,
  requestNarrativeModeChange
} from '../server/multiplayer/domain/action-turn.js';

const SERVER_SECRET = 'regression-only-server-secret-with-enough-entropy';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function action({
  key,
  text,
  visibility = 'sealed',
  preference = 'full',
  note
}) {
  const request = {
    schema: ACTION_REQUEST_SCHEMA,
    base_state_revision: 42,
    text,
    pre_resolution_visibility: visibility,
    narration_preference: preference,
    idempotency_key: key
  };
  if (note !== undefined) request.narration_note = note;
  return request;
}

function freshTurn(overrides = {}) {
  return createActionTurn({
    room_id: 'room-regression',
    epoch_id: 'epoch-regression',
    turn_id: 'turn-regression-7',
    turn_no: 7,
    base_state_revision: 42,
    active_narrative_mode: 'shared',
    ...overrides
  });
}

function lock(turn, seat, request, overrides = {}) {
  return lockActionSubmission(turn, {
    seat,
    request,
    submissionId: `submission-${seat}-7`,
    receivedAt: seat === 'A'
      ? '2026-08-21T12:00:00.123Z'
      : '2026-08-21T12:00:01.456Z',
    serverSecret: SERVER_SECRET,
    ...overrides
  });
}

function allKeys(value, result = new Set()) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    result.add(key);
    allKeys(child, result);
  }
  return result;
}

let passed = 0;
function test(name, callback) {
  callback();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const hash = character => `sha256:${character.repeat(64)}`;

test('canonical JSON is detached, recursively sorted and stable', () => {
  const left = { z: [{ b: -0, a: true }], a: 'x' };
  const right = { a: 'x', z: [{ a: true, b: 0 }] };
  assert.equal(canonicalStringify(left), '{"a":"x","z":[{"a":true,"b":0}]}');
  assert.equal(canonicalStringify(left), canonicalStringify(right));
  assert.equal(sha256Hex(left), sha256Hex(right));

  const detached = canonicalizeJson(left);
  left.z[0].a = false;
  assert.equal(detached.z[0].a, true);
});

test('canonical JSON rejects lossy values, cycles and dangerous keys', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, 1n, () => {}]) {
    assert.throws(() => assertJsonSafe(value), DomainError);
  }
  assert.throws(
    () => assertJsonSafe({ nested: { value: NaN } }),
    error => error instanceof DomainError && error.code === 'JSON_NON_FINITE_NUMBER'
  );

  const cycle = {};
  cycle.self = cycle;
  assert.throws(
    () => canonicalStringify(cycle),
    error => error instanceof DomainError && error.code === 'JSON_CYCLE'
  );
  assert.throws(
    () => canonicalStringify(JSON.parse('{"safe":1,"__proto__":{"polluted":true}}')),
    error => error instanceof DomainError && error.code === 'JSON_DANGEROUS_KEY'
  );

  const sparse = [];
  sparse[1] = 'value';
  assert.throws(() => canonicalStringify(sparse), /Sparse arrays/);
});

test('SHA and HMAC helpers have explicit semantics and require a secret', () => {
  assert.match(sha256Hex('same'), /^[a-f0-9]{64}$/);
  assert.match(hmacSha256(SERVER_SECRET, { value: 'same' }), /^[a-f0-9]{64}$/);
  assert.notEqual(hmacSha256('secret-one', 'same'), hmacSha256('secret-two', 'same'));
  assert.throws(
    () => hmacSha256('', 'content'),
    error => error instanceof DomainError && error.code === 'INVALID_HMAC_SECRET'
  );
});

const plan = {
  narrative_mode: 'shared',
  turn_payer_selection_hash: hash('a'),
  pov_writer_selection_hashes: null,
  writer_payer_by_audience: null,
  model_config_fingerprints: { shared_stage: hash('b'), pov_writers: null }
};
const requestA = action({
  key: 'idem-action-A-0001',
  text: '我先在门后布置起爆符。',
  visibility: 'open',
  preference: 'summarize_intent',
  note: '正文概述准备过程即可，不要逐句复述。'
});

test('narrative mode changes immediately before locking and queues after the plan freezes', () => {
  const initial = freshTurn({ turn_id: 'turn-mode-switch' });
  const immediate = requestNarrativeModeChange(initial, 'dual_pov');
  assert.equal(immediate.disposition, 'applied_current_turn');
  assert.equal(immediate.turn.active_narrative_mode, 'dual_pov');
  assert.equal(immediate.turn.queued_narrative_mode, null);

  const dualPlan = {
    narrative_mode: 'dual_pov',
    turn_payer_selection_hash: hash('c'),
    pov_writer_selection_hashes: { A: hash('d'), B: hash('e') },
    writer_payer_by_audience: { A: 'A', B: 'B' },
    model_config_fingerprints: {
      shared_stage: hash('f'),
      pov_writers: { A: hash('1'), B: hash('2') }
    }
  };
  const locked = lock(
    immediate.turn,
    'A',
    action({ key: 'idem-mode-A', text: '我留在原地观察。' }),
    { executionPlan: dualPlan, submissionId: 'submission-mode-A' }
  ).turn;
  const frozenPlan = canonicalStringify(locked.execution_plan);
  const frozenHash = locked.execution_plan_hash;
  const queued = requestNarrativeModeChange(locked, 'shared');
  assert.equal(queued.disposition, 'queued_next_turn');
  assert.equal(queued.turn.active_narrative_mode, 'dual_pov');
  assert.equal(queued.turn.queued_narrative_mode, 'shared');
  assert.equal(canonicalStringify(queued.turn.execution_plan), frozenPlan);
  assert.equal(queued.turn.execution_plan_hash, frozenHash);

  const switchedBack = requestNarrativeModeChange(queued.turn, 'dual_pov');
  assert.equal(switchedBack.turn.queued_narrative_mode, null);
  assert.equal(switchedBack.turn.execution_plan_hash, frozenHash);
});

let firstLock;
test('first action locks, freezes a detached execution plan and creates an HMAC receipt', () => {
  firstLock = lock(freshTurn(), 'A', requestA, { executionPlan: plan });
  assert.equal(firstLock.turn.status, 'ONE_ACTION_LOCKED');
  assert.equal(firstLock.receipt.receipt_seq, 1);
  assert.match(firstLock.receipt.content_commitment, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.deepEqual(firstLock.pre_resolution_reveal, {
    audience_seat: 'B',
    submission_id: 'submission-A-7'
  });
  assert.equal(Object.isFrozen(firstLock.turn.execution_plan), true);
  assert.equal(Object.isFrozen(firstLock.turn.execution_plan.model_config_fingerprints), true);

  plan.model_config_fingerprints.shared_stage = hash('9');
  assert.equal(firstLock.turn.execution_plan.model_config_fingerprints.shared_stage, hash('b'));
  assert.throws(() => {
    firstLock.turn.execution_plan.narrative_mode = 'dual_pov';
  }, TypeError);
});

test('open first action is readable only by its owner and the still-unlocked opponent', () => {
  const viewA = projectActionTurn(firstLock.turn, 'A');
  const viewB = projectActionTurn(firstLock.turn, 'B');
  assert.equal(viewA.actions.A.text, requestA.text);
  assert.equal(viewA.actions.A.receipt.content_commitment, firstLock.receipt.content_commitment);
  assert.equal(viewB.actions.A.text, requestA.text);
  assert.equal(viewB.actions.A.disclosure, 'open_pre_resolution');
  assert.equal('receipt' in viewB.actions.A, false);
  assert.equal('content_commitment' in viewB.actions.A, false);
  assert.equal('narration_note' in viewA.actions.A, false);
});

test('exact idempotent replay returns the original receipt; altered content conflicts', () => {
  const replay = lock(firstLock.turn, 'A', clone(requestA), {
    submissionId: 'a-different-id-must-be-ignored',
    receivedAt: '2030-01-01T00:00:00.000Z',
    serverSecret: 'a-different-secret-must-be-ignored'
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.turn, firstLock.turn);
  assert.deepEqual(replay.receipt, firstLock.receipt);

  const changed = { ...requestA, text: '改写后的占位行动' };
  assert.throws(
    () => lock(firstLock.turn, 'A', changed),
    error => error instanceof DomainError && error.code === 'IDEMPOTENCY_CONFLICT'
      && error.status === 409
  );
  assert.throws(
    () => lock(firstLock.turn, 'A', { ...requestA, idempotency_key: 'another-key-0001' }),
    error => error instanceof DomainError && error.code === 'ACTION_ALREADY_LOCKED'
  );
});

test('execution plan cannot change between the first and second lock', () => {
  const requestB = action({ key: 'idem-action-B-0001', text: '我察看门边的异常痕迹。', visibility: 'open' });
  assert.throws(
    () => lock(firstLock.turn, 'B', requestB, {
      executionPlan: { ...firstLock.turn.execution_plan, turn_payer_selection_hash: hash('8') }
    }),
    error => error instanceof DomainError && error.code === 'EXECUTION_PLAN_FROZEN'
  );
  assert.equal(firstLock.turn.status, 'ONE_ACTION_LOCKED', 'pure failure must not mutate the original turn');
});

const requestB = action({
  key: 'idem-action-B-0001',
  text: '我察看门边的异常痕迹。',
  visibility: 'open',
  note: '仔细写出我看到的线索。'
});
let secondLock;
test('second action seals the turn and never creates a pre-resolution reveal', () => {
  secondLock = lock(firstLock.turn, 'B', requestB, {
    executionPlan: clone(firstLock.turn.execution_plan)
  });
  assert.equal(secondLock.turn.status, 'SEALED');
  assert.equal(secondLock.receipt.receipt_seq, 2);
  assert.equal(secondLock.pre_resolution_reveal, null);
  assert.deepEqual(secondLock.turn.actions.B.pre_resolution_revealed_to, []);

  const viewA = projectActionTurn(secondLock.turn, 'A');
  const viewB = projectActionTurn(secondLock.turn, 'B');
  assert.deepEqual(viewA.actions.B, { locked: true, seat: 'B' });
  assert.equal(viewB.actions.A.text, requestA.text, 'an already-granted open disclosure remains readable');
  assert.equal(viewB.actions.B.text, requestB.text);
});

let refereeInput;
test('Referee input is fixed A/B order and excludes all receipt and narration metadata', () => {
  refereeInput = buildRefereeInput(secondLock.turn, {
    baseState: { actors: { A: { chakra: 80 }, B: { chakra: 75 } }, location: '仓库' },
    rulesVersion: 'rules-2026-08-21',
    serverSecret: SERVER_SECRET
  });
  assert.deepEqual(refereeInput.actions.map(item => item.seat), ['A', 'B']);
  assert.deepEqual(refereeInput.actions.map(item => item.text), [requestA.text, requestB.text]);
  assert.match(refereeInput.input_hash, /^hmac-sha256:[a-f0-9]{64}$/);

  const forbidden = [
    'receipt_seq',
    'received_at',
    'content_commitment',
    'request_hash',
    'idempotency_key',
    'pre_resolution_visibility',
    'pre_resolution_revealed_to',
    'narration_preference',
    'narration_note'
  ];
  const keys = allKeys(refereeInput);
  for (const key of forbidden) assert.equal(keys.has(key), false, `${key} leaked into Referee input`);
  assert.equal(JSON.stringify(refereeInput).includes(requestA.narration_note), false);
});

test('swapping receipt order and timestamps cannot change Referee payload or input_hash', () => {
  const auditSwap = clone(secondLock.turn);
  [auditSwap.actions.A.receipt_seq, auditSwap.actions.B.receipt_seq]
    = [auditSwap.actions.B.receipt_seq, auditSwap.actions.A.receipt_seq];
  [auditSwap.actions.A.received_at, auditSwap.actions.B.received_at]
    = [auditSwap.actions.B.received_at, auditSwap.actions.A.received_at];

  const rebuilt = buildRefereeInput(auditSwap, {
    baseState: { location: '仓库', actors: { B: { chakra: 75 }, A: { chakra: 80 } } },
    rulesVersion: 'rules-2026-08-21',
    serverSecret: SERVER_SECRET
  });
  assert.deepEqual(rebuilt, refereeInput);
});

test('narration notes enter only the Writer presentation projection', () => {
  const writer = buildWriterActionProjection(secondLock.turn, {
    audienceSeat: 'A',
    visibleSubmissionIds: ['submission-A-7']
  });
  assert.equal(writer.presentation_requests.length, 1);
  assert.equal(writer.presentation_requests[0].narration_note, requestA.narration_note);
  assert.equal(writer.presentation_requests[0].trust, 'untrusted_low_priority');
  assert.equal(writer.presentation_requests[0].scope, 'own_action_presentation_only');
  assert.equal(JSON.stringify(writer).includes(requestA.text), false, 'Writer preference projection must not copy raw text');
  assert.equal(JSON.stringify(refereeInput).includes(requestA.narration_note), false);
  assert.equal(JSON.stringify(projectActionTurn(secondLock.turn, 'A')).includes(requestA.narration_note), false);
  assert.throws(
    () => buildWriterActionProjection(secondLock.turn, { audienceSeat: 'A' }),
    error => error instanceof DomainError && error.code === 'INVALID_WRITER_PROJECTION'
  );
});

test('COMMITTED grants both members exact original text without exposing opponent receipts', () => {
  const committed = commitActionTurn(secondLock.turn);
  assert.equal(committed.status, 'COMMITTED');
  for (const viewer of ['A', 'B']) {
    const projection = projectActionTurn(committed, viewer);
    assert.equal(projection.actions.A.text, requestA.text);
    assert.equal(projection.actions.B.text, requestB.text);
    const opponent = viewer === 'A' ? 'B' : 'A';
    assert.equal(projection.actions[opponent].disclosure, 'full_after_commit');
    assert.equal('receipt' in projection.actions[opponent], false);
    assert.equal('content_commitment' in projection.actions[opponent], false);
  }

  const lateReplay = lock(committed, 'B', clone(requestB));
  assert.equal(lateReplay.replayed, true, 'lost lock responses remain replayable after final commit');
  assert.deepEqual(lateReplay.receipt, secondLock.receipt);
  assert.equal(commitActionTurn(committed), committed, 'commit transition is idempotent');
});

test('sealed first actions expose only the fact of locking before COMMITTED', () => {
  const sealedFirst = lock(
    freshTurn({ turn_id: 'turn-sealed-first' }),
    'B',
    action({ key: 'idem-sealed-first', text: '我悄悄移动到屋梁。', visibility: 'sealed' }),
    {
      submissionId: 'submission-sealed-first',
      executionPlan: {
        ...plan,
        turn_payer_selection_hash: hash('7')
      }
    }
  );
  const opponent = projectActionTurn(sealedFirst.turn, 'A');
  assert.deepEqual(opponent.actions.B, { locked: true, seat: 'B' });
  assert.equal(JSON.stringify(opponent).includes('我悄悄移动到屋梁。'), false);
});

console.log(`multiplayer action-turn regression: ${passed} passed`);
