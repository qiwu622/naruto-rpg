import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

import { createNewMultiplayerGenesisState } from '../server/multiplayer/application/genesis-state.js';
import {
  REFEREE_CHECK_JSON_COMMAND_JSON_SCHEMA,
  REFEREE_CHECK_JSON_PROTOCOL,
  RESOLUTION_CHECK_REJECTED_RESULT_JSON_SCHEMA,
  RESOLUTION_CHECK_REQUEST_JSON_SCHEMA,
  RESOLUTION_CHECK_RESOLVED_RESULT_JSON_SCHEMA,
  RESOLUTION_CHECK_RESULT_JSON_SCHEMA,
  RESOLUTION_CHECK_RESULT_SCHEMA,
  REQUEST_RESOLUTION_CHECK_OPERATION,
  assertRefereeCheckJsonCommand,
  assertResolutionCheckRejectedResult,
  assertResolutionCheckRequest,
  assertResolutionCheckResolvedResult,
  computeResolutionCheckResultHash,
  createResolutionCheckToolContract,
  inspectRefereeCheckJsonCommand,
  inspectResolutionCheckRejectedResult,
  inspectResolutionCheckRequest,
  inspectResolutionCheckResolvedResult,
  inspectResolutionCheckResult
} from '../server/multiplayer/contracts/resolution-check-contracts.js';
import {
  computeResolutionCheckRequestHash,
  createResolutionCheckLedger
} from '../server/multiplayer/domain/resolution-check-ledger.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  createSqliteResolutionCheckRepository
} from '../server/multiplayer/persistence/sqlite-resolution-check-repository.js';
import { createActionContentCodec } from '../server/multiplayer/security/action-content-codec.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

let passed = 0;

function test(name, callback) {
  callback();
  passed += 1;
  console.log(`PASS ${name}`);
}

async function asyncTest(name, callback) {
  await callback();
  passed += 1;
  console.log(`PASS ${name}`);
}

function request(overrides = {}) {
  return {
    check_id: 'check_conflict_1',
    participant_refs: ['actor:A', 'actor:B'],
    conflict_type: 'opposed_stealth_detection',
    attribute_rule_refs: ['actor:A/stealth', 'actor:B/perception'],
    rule_ref: 'rule:opposed-check/v1',
    reason: 'A 试图潜行通过 B 正在警戒的入口。',
    ...overrides
  };
}

function command(checkRequest = request()) {
  return {
    protocol: REFEREE_CHECK_JSON_PROTOCOL,
    operation: REQUEST_RESOLUTION_CHECK_OPERATION,
    request: checkRequest
  };
}

function resultWithHash(material) {
  return {
    ...material,
    result_hash: computeResolutionCheckResultHash(material)
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isErrorCode(code) {
  return error => error instanceof DomainError && error.code === code;
}

test('all request, envelope and discriminated result JSON schemas compile strictly', () => {
  for (const schema of [
    RESOLUTION_CHECK_REQUEST_JSON_SCHEMA,
    REFEREE_CHECK_JSON_COMMAND_JSON_SCHEMA,
    RESOLUTION_CHECK_RESOLVED_RESULT_JSON_SCHEMA,
    RESOLUTION_CHECK_REJECTED_RESULT_JSON_SCHEMA,
    RESOLUTION_CHECK_RESULT_JSON_SCHEMA
  ]) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    assert.doesNotThrow(() => ajv.compile(schema));
    assert.equal(Object.isFrozen(schema), true);
  }
});

test('native request and strict JSON command share one exact request shape', () => {
  const normalizedRequest = assertResolutionCheckRequest(request());
  const normalizedCommand = assertRefereeCheckJsonCommand(command());
  assert.deepEqual(normalizedCommand.request, normalizedRequest);
  assert.equal(Object.isFrozen(normalizedCommand.request.participant_refs), true);
  assert.equal(inspectResolutionCheckRequest(request()).valid, true);
  assert.equal(inspectRefereeCheckJsonCommand(command()).valid, true);

  const tool = createResolutionCheckToolContract();
  assert.equal(tool.name, REQUEST_RESOLUTION_CHECK_OPERATION);
  assert.deepEqual(tool.input_schema, RESOLUTION_CHECK_REQUEST_JSON_SCHEMA);
});

test('request and command contracts reject unknown fields, duplicates and non-command prose', () => {
  assert.equal(inspectResolutionCheckRequest({ ...request(), result: 'I win' }).valid, false);
  assert.equal(inspectResolutionCheckRequest(request({
    participant_refs: ['actor:A', 'actor:A']
  })).valid, false);
  assert.equal(inspectRefereeCheckJsonCommand({
    ...command(),
    commentary: 'also resolve the scene'
  }).valid, false);
  assert.throws(
    () => assertRefereeCheckJsonCommand({
      ...command(),
      operation: 'resolve_without_check'
    }),
    isErrorCode('SCHEMA_VIOLATION')
  );
});

test('RESOLVED and REJECTED results are strict disjoint variants', () => {
  const resolved = resultWithHash({
    schema: RESOLUTION_CHECK_RESULT_SCHEMA,
    status: 'RESOLVED',
    check_id: 'check_conflict_1',
    rule_ref: 'rule:opposed-check/v1',
    rolls: [
      { participant_ref: 'actor:A', raw: 11, modifier: 4, total: 15 },
      { participant_ref: 'actor:B', raw: 8, modifier: 3, total: 11 }
    ],
    outcome: 'ACTOR_A_SUCCESS'
  });
  const rejected = resultWithHash({
    schema: RESOLUTION_CHECK_RESULT_SCHEMA,
    status: 'REJECTED',
    check_id: 'check_conflict_1',
    error_code: 'ATTRIBUTE_NOT_APPLICABLE',
    allowed_correction_fields: ['attribute_rule_refs', 'reason']
  });

  assert.equal(inspectResolutionCheckResolvedResult(resolved).valid, true);
  assert.equal(inspectResolutionCheckRejectedResult(rejected).valid, true);
  assert.equal(inspectResolutionCheckResult(resolved).valid, true);
  assert.equal(inspectResolutionCheckResult(rejected).valid, true);
  assert.equal(Object.isFrozen(assertResolutionCheckResolvedResult(resolved).rolls), true);
  assert.equal(Object.isFrozen(assertResolutionCheckRejectedResult(rejected)), true);

  assert.equal(inspectResolutionCheckResolvedResult({
    ...resolved,
    rolls: [{ participant_ref: 'actor:A', raw: 11, modifier: 4, total: 14 }]
  }).valid, false);
  assert.equal(inspectResolutionCheckRejectedResult({
    ...rejected,
    rolls: []
  }).valid, false);
  assert.equal(inspectResolutionCheckRejectedResult({
    ...rejected,
    allowed_correction_fields: ['check_id']
  }).valid, false);
});

test('request hash binds canonical request, check_id and Referee session', () => {
  const left = request();
  const right = {
    reason: left.reason,
    rule_ref: left.rule_ref,
    attribute_rule_refs: left.attribute_rule_refs,
    conflict_type: left.conflict_type,
    participant_refs: left.participant_refs,
    check_id: left.check_id
  };
  const hash = computeResolutionCheckRequestHash({
    session_id: 'referee-session-1',
    request: left
  });
  assert.match(hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(hash, computeResolutionCheckRequestHash({
    session_id: 'referee-session-1',
    request: right
  }));
  assert.notEqual(hash, computeResolutionCheckRequestHash({
    session_id: 'referee-session-2',
    request: right
  }));
  assert.notEqual(hash, computeResolutionCheckRequestHash({
    session_id: 'referee-session-1',
    request: request({ reason: '另一个需要检定的原因。' })
  }));
});

let validationCalls = 0;
let randomCalls = 0;
let outcomeCalls = 0;
const randomValues = [11, 8];
const ledger = createResolutionCheckLedger({
  validateRequest(checkRequest) {
    validationCalls += 1;
    if (checkRequest.attribute_rule_refs.includes('actor:A/luck')) {
      return {
        status: 'REJECTED',
        error_code: 'ATTRIBUTE_NOT_APPLICABLE',
        allowed_correction_fields: ['attribute_rule_refs', 'reason']
      };
    }
    return {
      status: 'ACCEPTED',
      roll_specs: [
        {
          participant_ref: 'actor:A',
          minimum: 1,
          maximum: 20,
          modifier: 4,
          difficulty: null
        },
        {
          participant_ref: 'actor:B',
          minimum: 1,
          maximum: 20,
          modifier: 3,
          difficulty: null
        }
      ]
    };
  },
  randomInteger(minimum, maximum, context) {
    assert.equal(minimum, 1);
    assert.equal(maximum, 20);
    assert.equal(Object.isFrozen(context), true);
    randomCalls += 1;
    return randomValues[randomCalls - 1];
  },
  resolveOutcome(evidence) {
    outcomeCalls += 1;
    assert.equal(Object.isFrozen(evidence.roll_specs), true);
    return evidence.rolls[0].total > evidence.rolls[1].total
      ? 'ACTOR_A_SUCCESS'
      : 'ACTOR_B_SUCCESS';
  }
});

test('semantic rejection is cached by session, check_id and request hash without rolling', () => {
  const rejectedRequest = request({
    attribute_rule_refs: ['actor:A/luck', 'actor:B/perception']
  });
  const first = ledger.executeJson({
    session_id: 'referee-session-ledger',
    command: command(rejectedRequest)
  });
  const replay = ledger.executeNative({
    session_id: 'referee-session-ledger',
    request: clone(rejectedRequest)
  });

  assert.equal(first.status, 'REJECTED');
  assert.equal(replay, first);
  assert.deepEqual(replay, first);
  assert.equal(validationCalls, 1);
  assert.equal(randomCalls, 0);
  assert.equal(outcomeCalls, 0);
  const record = ledger.getRecord({
    session_id: 'referee-session-ledger',
    check_id: rejectedRequest.check_id
  });
  assert.equal(record.consumed, false);
  assert.equal(record.rejected_attempts.length, 1);
});

let resolved;
test('corrected valid request atomically consumes the still-open check_id using injected rolls', () => {
  resolved = ledger.executeNative({
    session_id: 'referee-session-ledger',
    request: request()
  });
  assert.deepEqual(resolved, {
    check_id: 'check_conflict_1',
    outcome: 'ACTOR_A_SUCCESS',
    result_hash: resolved.result_hash,
    rolls: [
      { modifier: 4, participant_ref: 'actor:A', raw: 11, total: 15 },
      { modifier: 3, participant_ref: 'actor:B', raw: 8, total: 11 }
    ],
    rule_ref: 'rule:opposed-check/v1',
    schema: RESOLUTION_CHECK_RESULT_SCHEMA,
    status: 'RESOLVED'
  });
  assert.equal(validationCalls, 2);
  assert.equal(randomCalls, 2);
  assert.equal(outcomeCalls, 1);
  const record = ledger.getRecord({
    session_id: 'referee-session-ledger',
    check_id: 'check_conflict_1'
  });
  assert.equal(record.consumed, true);
  assert.equal(record.resolved.roll_specs[0].difficulty, null);
  assert.equal(record.rejected_attempts.length, 1);
});

test('same resolved request replays across both transports without validation or reroll', () => {
  const nativeReplay = ledger.executeNative({
    session_id: 'referee-session-ledger',
    request: clone(request())
  });
  const jsonReplay = ledger.executeJson({
    session_id: 'referee-session-ledger',
    command: command(clone(request()))
  });
  assert.equal(nativeReplay, resolved);
  assert.equal(jsonReplay, resolved);
  assert.deepEqual(nativeReplay, resolved);
  assert.deepEqual(jsonReplay, resolved);
  assert.equal(validationCalls, 2);
  assert.equal(randomCalls, 2);
  assert.equal(outcomeCalls, 1);
});

test('a different hash after resolution returns CHECK_ID_CONFLICT and never rerolls', () => {
  assert.throws(
    () => ledger.executeNative({
      session_id: 'referee-session-ledger',
      request: request({ reason: '试图用新理由重掷已经完成的检定。' })
    }),
    error => error instanceof DomainError
      && error.code === 'CHECK_ID_CONFLICT'
      && error.status === 409
  );
  assert.throws(
    () => ledger.executeNative({
      session_id: 'referee-session-ledger',
      request: request({ attribute_rule_refs: ['actor:A/luck', 'actor:B/perception'] })
    }),
    isErrorCode('CHECK_ID_CONFLICT')
  );
  assert.equal(validationCalls, 2);
  assert.equal(randomCalls, 2);
});

test('the same check_id is isolated by Referee session binding', () => {
  let rolls = 0;
  const isolated = createResolutionCheckLedger({
    validateRequest(checkRequest) {
      return {
        status: 'ACCEPTED',
        roll_specs: checkRequest.participant_refs.map(participantRef => ({
          participant_ref: participantRef,
          minimum: 1,
          maximum: 20,
          modifier: 0,
          difficulty: 10
        }))
      };
    },
    randomInteger() {
      rolls += 1;
      return 10 + rolls;
    },
    resolveOutcome() {
      return 'CHECK_COMPLETE';
    }
  });
  const first = isolated.executeNative({ session_id: 'session-A', request: request() });
  const second = isolated.executeNative({ session_id: 'session-B', request: request() });
  assert.notDeepEqual(first.rolls, second.rolls);
  assert.equal(rolls, 4);
  assert.equal(isolated.getRecord({
    session_id: 'session-A', check_id: 'check_conflict_1'
  }).consumed, true);
  assert.equal(isolated.getRecord({
    session_id: 'session-B', check_id: 'check_conflict_1'
  }).consumed, true);
});

test('invalid injected randomness cannot partially consume a valid check', () => {
  let attempts = 0;
  const retryable = createResolutionCheckLedger({
    validateRequest(checkRequest) {
      return {
        status: 'ACCEPTED',
        roll_specs: checkRequest.participant_refs.map(participantRef => ({
          participant_ref: participantRef,
          minimum: 1,
          maximum: 20,
          modifier: 0,
          difficulty: null
        }))
      };
    },
    randomInteger() {
      attempts += 1;
      return attempts === 1 ? 21 : 10;
    },
    resolveOutcome() {
      return 'CHECK_COMPLETE';
    }
  });
  assert.throws(
    () => retryable.executeNative({ session_id: 'atomic-session', request: request() }),
    isErrorCode('INVALID_RESOLUTION_CHECK_RANDOM_VALUE')
  );
  assert.equal(retryable.getRecord({
    session_id: 'atomic-session', check_id: 'check_conflict_1'
  }).consumed, false);
  const result = retryable.executeNative({
    session_id: 'atomic-session',
    request: request()
  });
  assert.equal(result.status, 'RESOLVED');
  assert.equal(retryable.getRecord({
    session_id: 'atomic-session', check_id: 'check_conflict_1'
  }).consumed, true);
});

test('async callbacks are rejected before a check can be sealed', () => {
  const asynchronous = createResolutionCheckLedger({
    validateRequest() {
      return Promise.resolve({ status: 'REJECTED' });
    },
    randomInteger() {
      return 1;
    },
    resolveOutcome() {
      return 'CHECK_COMPLETE';
    }
  });
  assert.throws(
    () => asynchronous.executeNative({
      session_id: 'async-session',
      request: request()
    }),
    isErrorCode('ASYNC_RESOLUTION_CHECK_CALLBACK')
  );
  assert.equal(asynchronous.getRecord({
    session_id: 'async-session', check_id: 'check_conflict_1'
  }).consumed, false);
});

const PERSISTENCE_NOW = '2026-08-23T10:00:00.000Z';
const PERSISTENCE_LEASE_EXPIRY = '2026-08-23T11:00:00.000Z';
const PERSISTENCE_BASE_HASH = `sha256:${'1'.repeat(64)}`;
const PERSISTENCE_REJECTED_REASON =
  '明文泄漏哨兵：错误属性不应出现在 SQLite 或 WAL 中。';
const PERSISTENCE_RESOLVED_REASON =
  '明文泄漏哨兵：乙警戒时甲试图潜行穿过密道。';
const PERSISTENCE_BAD_ATTRIBUTE = 'actor:A/luck';

function seedPersistentResolutionRun(database) {
  database.prepare(`
    INSERT INTO multiplayer_rooms (
      room_id, origin_type, lineage_id, origin_owner_user_id, origin_snapshot_id,
      lifecycle, host_user_id, state_revision, control_revision, event_seq,
      active_narrative_mode, created_at, updated_at
    ) VALUES ('room_check', 'new_multiplayer_save', 'lineage_check', NULL,
      'snapshot_check', 'LOBBY', 'user_check_A', 0, 0, 0, 'shared', ?, ?)
  `).run(PERSISTENCE_NOW, PERSISTENCE_NOW);
  database.prepare(`
    INSERT INTO room_epochs (
      epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
      base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
      state_revision, control_revision, epoch_state, activated_at, archived_at
    ) VALUES ('epoch_check', 'room_check', 'lineage_check', 1, 'origin_snapshot',
      'snapshot_check', ?, 'checkpoint_check_0', 'checkpoint_check_0',
      0, 0, 'ACTIVE', ?, NULL)
  `).run(PERSISTENCE_BASE_HASH, PERSISTENCE_NOW);
  database.prepare(`
    INSERT INTO room_checkpoints (
      checkpoint_id, room_id, lineage_id, epoch_id, turn_no, checkpoint_kind,
      parent_checkpoint_id, turn_id, commit_id, state_revision, state_hash,
      snapshot_ref, created_at
    ) VALUES ('checkpoint_check_0', 'room_check', 'lineage_check', 'epoch_check',
      0, 'genesis', NULL, NULL, NULL, 0, ?, 'snapshot_ref_check', ?)
  `).run(PERSISTENCE_BASE_HASH, PERSISTENCE_NOW);
  database.prepare(`
    INSERT INTO multiplayer_turns (
      turn_id, room_id, epoch_id, turn_no, turn_status, narrative_mode,
      base_checkpoint_id, base_state_revision, base_state_hash, created_at, updated_at
    ) VALUES ('turn_check', 'room_check', 'epoch_check', 1, 'RESOLVING', 'shared',
      'checkpoint_check_0', 0, ?, ?, ?)
  `).run(PERSISTENCE_BASE_HASH, PERSISTENCE_NOW, PERSISTENCE_NOW);
  database.prepare(`
    UPDATE multiplayer_rooms
       SET lifecycle = 'ACTIVE', active_epoch_id = 'epoch_check',
           current_turn_id = 'turn_check'
     WHERE room_id = 'room_check'
  `).run();
  database.prepare(`
    INSERT INTO resolution_runs (
      run_id, room_id, epoch_id, turn_id, turn_no, input_hash, stage,
      run_status, owner_boot_id, owner_task_id, claimed_at, heartbeat_at,
      lease_expires_at, lease_fence, attempt_count, prompt_version,
      model_fingerprint, transport, bundle_schema_version, reducer_version,
      created_at, updated_at
    ) VALUES ('run_check', 'room_check', 'epoch_check', 'turn_check', 1, ?,
      'resolution', 'RUNNING', 'boot_check', 'task_check', ?, ?, ?, 1, 1,
      'referee/v1', ?, 'json_protocol', 'bundle/v1', 'reducers/v1', ?, ?)
  `).run(
    `sha256:${'2'.repeat(64)}`,
    PERSISTENCE_NOW,
    PERSISTENCE_NOW,
    PERSISTENCE_LEASE_EXPIRY,
    `sha256:${'3'.repeat(64)}`,
    PERSISTENCE_NOW,
    PERSISTENCE_NOW
  );
}

function persistentAuthority(requestValue, state) {
  return {
    run_id: 'run_check',
    room_id: 'room_check',
    epoch_id: 'epoch_check',
    turn_id: 'turn_check',
    lease_fence: 1,
    base_state_revision: 0,
    base_state_hash: PERSISTENCE_BASE_HASH,
    request: requestValue,
    state
  };
}

async function readExistingFile(filePath) {
  try {
    return await fsp.readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoPersistentRequestPlaintext(databasePath, { requireWal = false } = {}) {
  const databaseBytes = await readExistingFile(databasePath);
  const walBytes = await readExistingFile(`${databasePath}-wal`);
  assert.ok(databaseBytes, 'SQLite database file must exist');
  if (requireWal) assert.ok(walBytes, 'SQLite WAL file must exist while the connection is open');
  const secrets = [
    PERSISTENCE_REJECTED_REASON,
    PERSISTENCE_RESOLVED_REASON,
    PERSISTENCE_BAD_ATTRIBUTE,
    'actor:A/stealth',
    'actor:B/perception'
  ];
  for (const [fileLabel, bytes] of [['database', databaseBytes], ['WAL', walBytes]]) {
    if (!bytes) continue;
    for (const secret of secrets) {
      assert.equal(
        bytes.includes(Buffer.from(secret, 'utf8')),
        false,
        `${fileLabel} leaked persisted resolution request plaintext: ${secret}`
      );
    }
  }
}

const persistenceTempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-resolution-check-'));
const persistenceDatabasePath = path.join(persistenceTempRoot, 'resolution-checks.sqlite');
const persistenceState = createNewMultiplayerGenesisState();
const rejectedPersistentRequest = request({
  check_id: 'check_persistent_1',
  attribute_rule_refs: [PERSISTENCE_BAD_ATTRIBUTE, 'actor:B/perception'],
  reason: PERSISTENCE_REJECTED_REASON
});
const validPersistentRequest = request({
  check_id: 'check_persistent_1',
  reason: PERSISTENCE_RESOLVED_REASON
});
const persistenceCodec = createActionContentCodec({
  masterKeys: { resolutionCheckKeyV1: Buffer.alloc(32, 0x52) },
  activeMasterKeyVersion: 'resolutionCheckKeyV1'
});
let persistenceConnection;
let persistenceRepository;
let persistenceRandomCalls = 0;
let persistentResolved;

try {
  persistenceConnection = await openMultiplayerRepositoryTestSqlite({
    databasePath: persistenceDatabasePath
  });
  await persistenceConnection.write(seedPersistentResolutionRun);
  persistenceRepository = createSqliteResolutionCheckRepository(persistenceConnection, {
    contentCodec: persistenceCodec,
    idFactory: kind => `${kind}_persistent_1`,
    clock: () => PERSISTENCE_NOW,
    randomInteger(minimum, maximum, context) {
      const rolls = [13, 7];
      assert.equal(minimum, 1);
      assert.equal(maximum, 20);
      assert.equal(Object.isFrozen(context), true);
      const result = rolls[persistenceRandomCalls];
      persistenceRandomCalls += 1;
      return result;
    }
  });

  await asyncTest('persistent REJECTED attempt does not roll or consume its correctable check_id', async () => {
    const first = await persistenceRepository.execute(persistentAuthority(
      rejectedPersistentRequest,
      persistenceState
    ));
    const replay = await persistenceRepository.execute(persistentAuthority(
      clone(rejectedPersistentRequest),
      persistenceState
    ));
    assert.equal(first.status, 'REJECTED');
    assert.equal(first.error_code, 'ATTRIBUTE_NOT_APPLICABLE');
    assert.deepEqual(replay, first);
    assert.equal(persistenceRandomCalls, 0);
    const record = persistenceRepository.getRecord({
      run_id: 'run_check',
      check_id: rejectedPersistentRequest.check_id
    });
    assert.equal(record.consumed, false);
    assert.equal(record.attempts.length, 1);
    assert.deepEqual(record.attempts[0].request, rejectedPersistentRequest);
  });

  await asyncTest('corrected persistent request performs the first and only authoritative draw', async () => {
    persistentResolved = await persistenceRepository.execute(persistentAuthority(
      validPersistentRequest,
      persistenceState
    ));
    assert.equal(persistentResolved.status, 'RESOLVED');
    assert.equal(persistentResolved.outcome, 'ACTOR_A_SUCCESS');
    assert.deepEqual(persistentResolved.rolls, [
      { participant_ref: 'actor:A', raw: 13, modifier: 5, total: 18 },
      { participant_ref: 'actor:B', raw: 7, modifier: 5, total: 12 }
    ]);
    assert.equal(persistenceRandomCalls, 2);
    const record = persistenceRepository.getRecord({
      run_id: 'run_check',
      check_id: validPersistentRequest.check_id
    });
    assert.equal(record.consumed, true);
    assert.deepEqual(record.attempts.map(attempt => attempt.status), ['REJECTED', 'RESOLVED']);
  });

  await asyncTest('same persistent request replays without invoking the random source', async () => {
    const replay = await persistenceRepository.execute(persistentAuthority(
      clone(validPersistentRequest),
      persistenceState
    ));
    assert.deepEqual(replay, persistentResolved);
    assert.equal(persistenceRandomCalls, 2);
    const record = persistenceRepository.getRecord({
      run_id: 'run_check',
      check_id: validPersistentRequest.check_id
    });
    assert.equal(record.attempts.length, 2);
  });

  await asyncTest('sealed check_id rejects a changed request hash without rerolling', async () => {
    await assert.rejects(
      persistenceRepository.execute(persistentAuthority(request({
        check_id: validPersistentRequest.check_id,
        reason: '尝试更改理由重掷。'
      }), persistenceState)),
      error => error instanceof DomainError
        && error.code === 'CHECK_ID_CONFLICT'
        && error.status === 409
    );
    assert.equal(persistenceRandomCalls, 2);
  });

  await asyncTest('same sealed conflict rejects a replacement check_id without rerolling', async () => {
    await assert.rejects(
      persistenceRepository.execute(persistentAuthority(request({
        check_id: 'check_persistent_2',
        reason: '尝试换一个 check_id 重掷同一冲突。'
      }), persistenceState)),
      error => error instanceof DomainError
        && error.code === 'RESOLUTION_CONFLICT_ALREADY_CHECKED'
        && error.status === 409
    );
    assert.equal(persistenceRandomCalls, 2);
  });

  await asyncTest('encrypted persistent ledger leaves no reason or attribute plaintext in DB/WAL', async () => {
    await assertNoPersistentRequestPlaintext(persistenceDatabasePath, { requireWal: true });
  });

  await persistenceConnection.close();
  persistenceConnection = null;
  persistenceConnection = await openMultiplayerRepositoryTestSqlite({
    databasePath: persistenceDatabasePath
  });
  let restartRandomCalls = 0;
  persistenceRepository = createSqliteResolutionCheckRepository(persistenceConnection, {
    contentCodec: persistenceCodec,
    idFactory() {
      throw new Error('replay after restart must not allocate a new ledger session');
    },
    clock: () => PERSISTENCE_NOW,
    randomInteger() {
      restartRandomCalls += 1;
      throw new Error('replay after restart must not invoke the random source');
    }
  });

  await asyncTest('closing and reopening SQLite replays the sealed result without rerolling', async () => {
    const replay = await persistenceRepository.execute(persistentAuthority(
      clone(validPersistentRequest),
      persistenceState
    ));
    assert.deepEqual(replay, persistentResolved);
    assert.equal(restartRandomCalls, 0);
    const record = persistenceRepository.getRecord({
      run_id: 'run_check',
      check_id: validPersistentRequest.check_id
    });
    assert.equal(record.consumed, true);
    assert.equal(record.attempts.length, 2);
  });

  await asyncTest('reopened database files still contain no persisted request plaintext', async () => {
    await assertNoPersistentRequestPlaintext(persistenceDatabasePath);
  });
} finally {
  await persistenceConnection?.close();
  await fsp.rm(persistenceTempRoot, { recursive: true, force: true });
}

console.log(`multiplayer resolution-check regression: ${passed} passed`);
