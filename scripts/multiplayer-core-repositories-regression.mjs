import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ACTION_REQUEST_SCHEMA } from '../server/multiplayer/domain/action-turn.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  ROOM_CHECKPOINT_SCHEMA,
  ROOM_EPOCH_SCHEMA,
  ROOM_ORIGIN_SCHEMA
} from '../server/multiplayer/contracts/lineage-contracts.js';
import { TURN_EXECUTION_PLAN_SCHEMA } from '../server/multiplayer/contracts/room-contracts.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';
import { createSqliteMultiplayerCoreRepositories } from '../server/multiplayer/persistence/sqlite-core-repositories.js';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function expectDomain(code) {
  return error => error instanceof DomainError && error.code === code;
}

const HASH = character => `sha256:${character.repeat(64)}`;
const ACTIVATED_AT = '2026-08-22T00:00:00.000Z';

function createClock() {
  let tick = 0;
  return () => new Date(Date.parse(ACTIVATED_AT) + (++tick * 1_000)).toISOString();
}

function createIdFactory() {
  const counts = new Map();
  return kind => {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    return `${kind}_${count}`;
  };
}

function xor(bytes) {
  return Buffer.from(bytes).map(byte => byte ^ 0xa5);
}

function createTestActionCodec() {
  const openedSeats = [];
  return {
    openedSeats,
    sealJson(value) {
      const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
      return {
        action_ciphertext: xor(plaintext),
        wrapped_data_key: Buffer.alloc(16, 0x11),
        nonce: Buffer.alloc(12, 0x22),
        auth_tag: Buffer.alloc(16, 0x33),
        master_key_version: 'test-key-v1'
      };
    },
    openJson(envelope, context) {
      openedSeats.push(context.seat_id);
      return JSON.parse(xor(envelope.action_ciphertext).toString('utf8'));
    }
  };
}

function executionPlanFor(turn) {
  if (turn.narrative_mode === 'shared') {
    return {
      schema: TURN_EXECUTION_PLAN_SCHEMA,
      narrative_mode: 'shared',
      turn_payer_selection_hash: HASH('1'),
      pov_writer_selection_hashes: null,
      writer_payer_by_audience: null,
      model_config_fingerprints: {
        shared_stage: HASH('2'),
        pov_writers: null
      }
    };
  }
  return {
    schema: TURN_EXECUTION_PLAN_SCHEMA,
    narrative_mode: 'dual_pov',
    turn_payer_selection_hash: HASH('1'),
    pov_writer_selection_hashes: { A: HASH('3'), B: HASH('4') },
    writer_payer_by_audience: { A: 'A', B: 'B' },
    model_config_fingerprints: {
      shared_stage: HASH('2'),
      pov_writers: { A: HASH('5'), B: HASH('6') }
    }
  };
}

function action(text, idempotencyKey, visibility = 'sealed') {
  return {
    schema: ACTION_REQUEST_SCHEMA,
    base_state_revision: 0,
    text,
    pre_resolution_visibility: visibility,
    narration_preference: 'full',
    narration_note: '只约束自己的行动呈现',
    idempotency_key: idempotencyKey
  };
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-core-repositories-'));
const databasePath = path.join(tempRoot, 'multiplayer.sqlite');
const codec = createTestActionCodec();
const connection = await openMultiplayerRepositoryTestSqlite({ databasePath });
const repositories = createSqliteMultiplayerCoreRepositories(connection, {
  actionContentCodec: codec,
  actionCommitmentSecret: Buffer.alloc(32, 0x44),
  clock: createClock(),
  idFactory: createIdFactory(),
  randomTokenBytes: size => Buffer.alloc(size, 0x5a),
  executionPlanResolver: ({ turn }) => executionPlanFor(turn)
});

let invite;
let openedTurn;
let firstReceipt;
let firstChat;
let noOpModeChangeRequest;
let noOpModeChangeResult;

try {
  await test('room, host membership, initial epoch, genesis and projected event commit atomically', async () => {
    const room = await repositories.rooms.createWithGenesis({
      authenticated_user_id: '123456789012345678',
      origin: {
        schema: ROOM_ORIGIN_SCHEMA,
        room_id: 'room_1',
        origin_type: 'new_multiplayer_save',
        lineage_id: 'lineage_1',
        origin_owner_user_id: null,
        origin_snapshot_id: 'snapshot_origin_1'
      },
      epoch: {
        schema: ROOM_EPOCH_SCHEMA,
        epoch_id: 'epoch_1',
        room_id: 'room_1',
        lineage_id: 'lineage_1',
        epoch_no: 1,
        base: {
          type: 'origin_snapshot',
          ref_id: 'snapshot_origin_1',
          state_hash: HASH('a')
        },
        genesis_checkpoint_id: 'checkpoint_0',
        head_checkpoint_id: 'checkpoint_0',
        state_revision: 0,
        control_revision: 0,
        state: 'ACTIVE',
        created_from_proposal_id: null,
        activated_at: ACTIVATED_AT
      },
      genesis_checkpoint: {
        schema: ROOM_CHECKPOINT_SCHEMA,
        checkpoint_id: 'checkpoint_0',
        room_id: 'room_1',
        lineage_id: 'lineage_1',
        epoch_id: 'epoch_1',
        turn_no: 0,
        kind: 'genesis',
        parent_checkpoint_id: null,
        turn_id: null,
        commit_id: null,
        state_revision: 0,
        state_hash: HASH('a'),
        snapshot_ref: 'snapshot_ref_0',
        created_at: ACTIVATED_AT
      }
    });
    assert.equal(room.viewer_seat, 'A');
    assert.equal(room.active_epoch_id, 'epoch_1');
    assert.equal(room.event_seq, 1);
    assert.equal(repositories.members.resolve({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1'
    }).seat, 'A');
    assert.equal(repositories.epochs.getActive({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1'
    }).epoch_id, 'epoch_1');
    assert.equal(repositories.epochs.getGenesis({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      epoch_id: 'epoch_1'
    }).checkpoint_id, 'checkpoint_0');
    const counts = connection.read(database => ({
      events: database.prepare('SELECT COUNT(*) AS count FROM room_events').get().count,
      outbox: database.prepare('SELECT COUNT(*) AS count FROM room_outbox').get().count
    }));
    assert.deepEqual(counts, { events: 1, outbox: 1 });
  });

  await test('membership authority comes from numeric JWT principal mapping, not a reported seat', async () => {
    assert.throws(() => repositories.rooms.getForMember({
      authenticated_user_id: '999999999999999999',
      room_id: 'room_1'
    }), expectDomain('ROOM_MEMBERSHIP_REQUIRED'));
    assert.equal(repositories.members.resolve({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1'
    }).seat, 'A');
  });

  await test('readable invite returns raw short code once and persists only SHA-256', async () => {
    invite = await repositories.invites.create({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1'
    });
    assert.match(invite.token, /^N-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u);
    const stored = connection.read(database => database.prepare(`
      SELECT token_hash FROM room_invites WHERE invite_id = ?
    `).get(invite.invite_id));
    assert.match(stored.token_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(stored.token_hash.includes(invite.token), false);
    const databaseBytes = await fsp.readFile(databasePath);
    assert.equal(databaseBytes.includes(Buffer.from(invite.token, 'utf8')), false);
  });

  await test('room password is room-scoped, reusable and join remains idempotent', async () => {
    await assert.rejects(() => repositories.invites.join({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_other',
      token: invite.token
    }), expectDomain('INVITE_TOKEN_INVALID'));
    const joined = await repositories.invites.join({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      token: invite.token
    });
    assert.deepEqual(joined, {
      room_id: 'room_1',
      room_code: 'ROOM_1',
      viewer_seat: 'B',
      replayed: false
    });
    const replay = await repositories.invites.join({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      token: invite.token
    });
    assert.equal(replay.replayed, true);
    assert.equal(repositories.members.resolve({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1'
    }).seat, 'B');
    assert.equal(repositories.rooms.getForMember({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1'
    }).lifecycle, 'READY');
    assert.equal(connection.read(database => database.prepare(`
      SELECT use_count FROM room_invites WHERE invite_id = ?
    `).get(invite.invite_id)).use_count, 0, 'joining must not consume the room password');
  });

  await test('turn opening allocates control/event sequences and begins with empty payer selection', async () => {
    const before = repositories.rooms.getForMember({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1'
    });
    openedTurn = await repositories.turns.open({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      expected_control_revision: before.control_revision
    });
    assert.equal(openedTurn.status, 'AWAITING_PAYER_SELECTION');
    assert.equal(openedTurn.turn_no, 1);
    assert.equal(openedTurn.narrative_mode, 'shared');
    assert.equal(openedTurn.control_revision, before.control_revision + 1);
  });

  await test('mode changes are durable-idempotent and invalidate incompatible zero-action selections', async () => {
    const dualChangeRequest = {
      expected_control_revision: openedTurn.control_revision,
      mode: 'dual_pov',
      idempotency_key: 'mode-dual-1'
    };
    const changed = await repositories.turns.changeNarrativeMode({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      request: dualChangeRequest
    });
    assert.equal(changed.disposition, 'applied_current_turn');
    assert.equal(changed.control_revision, openedTurn.control_revision + 1);

    await connection.write(database => {
      database.prepare(`
        INSERT INTO model_endpoint_profiles (
          profile_id, config_revision, owner_user_id, adapter,
          normalized_base_url, normalized_origin, endpoint_origin_hash, model,
          auth_scheme, credential_id, credential_revision, native_tools,
          strict_json, error_correction_continuation, recommended_transport,
          config_fingerprint, profile_status, created_at, revoked_at
        ) VALUES (
          'profile_mode_b', 1, '987654321098765432', 'openai_compatible',
          'https://mode.example.com/v1', 'https://mode.example.com', ?, 'mode-model',
          'none', NULL, NULL, 0, 1, 1, 'json_protocol', ?, 'ACTIVE', ?, NULL
        )
      `).run(HASH('7'), HASH('8'), ACTIVATED_AT);
      const insertSelection = database.prepare(`
        INSERT INTO turn_model_selections (
          selection_id, turn_id, scope, audience, selection_revision,
          expected_control_revision, payer_user_id, payer_seat_id,
          audience_owner_user_id, profile_id, profile_revision,
          credential_id, credential_revision, payer_accepted_at,
          audience_accepted_at, idempotency_key, selection_hash, active,
          created_at, selected_narrative_mode
        ) VALUES (?, ?, ?, ?, 1, ?, '987654321098765432', 'B', ?,
          'profile_mode_b', 1, NULL, NULL, ?, ?, ?, ?, 1, ?, 'dual_pov')
      `);
      insertSelection.run(
        'selection_mode_shared', openedTurn.turn_id, 'shared', 'shared',
        changed.control_revision, null, ACTIVATED_AT, null,
        'selection-mode-shared', HASH('b'), ACTIVATED_AT
      );
      insertSelection.run(
        'selection_mode_writer_a', openedTurn.turn_id, 'writer', 'A',
        changed.control_revision, '123456789012345678', ACTIVATED_AT, ACTIVATED_AT,
        'selection-mode-writer-a', HASH('c'), ACTIVATED_AT
      );
      insertSelection.run(
        'selection_mode_writer_b', openedTurn.turn_id, 'writer', 'B',
        changed.control_revision, '987654321098765432', ACTIVATED_AT, ACTIVATED_AT,
        'selection-mode-writer-b', HASH('d'), ACTIVATED_AT
      );
      database.prepare(`
        UPDATE multiplayer_turns SET turn_status = 'COLLECTING_ACTIONS'
         WHERE turn_id = ?
      `).run(openedTurn.turn_id);
    });

    const shared = await repositories.turns.changeNarrativeMode({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: {
        expected_control_revision: changed.control_revision,
        mode: 'shared',
        idempotency_key: 'mode-shared-zero-action'
      }
    });
    assert.equal(shared.control_revision, changed.control_revision + 1);
    assert.deepEqual(connection.read(database => ({
      turn: database.prepare(`
        SELECT narrative_mode, turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(openedTurn.turn_id),
      selections: database.prepare(`
        SELECT scope, audience, active, selected_narrative_mode
          FROM turn_model_selections WHERE turn_id = ? ORDER BY scope, audience
      `).all(openedTurn.turn_id)
    })), {
      turn: { narrative_mode: 'shared', turn_status: 'AWAITING_PAYER_SELECTION' },
      selections: [
        { scope: 'shared', audience: 'shared', active: 0, selected_narrative_mode: 'dual_pov' },
        { scope: 'writer', audience: 'A', active: 0, selected_narrative_mode: 'dual_pov' },
        { scope: 'writer', audience: 'B', active: 0, selected_narrative_mode: 'dual_pov' }
      ]
    });

    const replay = await repositories.turns.changeNarrativeMode({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      request: dualChangeRequest
    });
    assert.deepEqual(replay, { ...changed, replayed: true });
    await assert.rejects(() => repositories.turns.changeNarrativeMode({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      request: {
        expected_control_revision: shared.control_revision,
        mode: 'shared',
        idempotency_key: 'mode-dual-1'
      }
    }), expectDomain('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(() => repositories.turns.changeNarrativeMode({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: {
        expected_control_revision: openedTurn.control_revision,
        mode: 'shared',
        idempotency_key: 'stale-mode'
      }
    }), expectDomain('STALE_CONTROL_REVISION'));

    const dualAgain = await repositories.turns.changeNarrativeMode({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: {
        expected_control_revision: shared.control_revision,
        mode: 'dual_pov',
        idempotency_key: 'mode-dual-again'
      }
    });
    assert.equal(dualAgain.control_revision, shared.control_revision + 1);
    assert.deepEqual(connection.read(database => ({
      turn: database.prepare(`
        SELECT narrative_mode, turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(openedTurn.turn_id),
      activeSelections: database.prepare(`
        SELECT COUNT(*) AS count FROM turn_model_selections
         WHERE turn_id = ? AND active = 1
      `).get(openedTurn.turn_id).count
    })), {
      turn: { narrative_mode: 'dual_pov', turn_status: 'AWAITING_PAYER_SELECTION' },
      activeSelections: 0
    });

    noOpModeChangeRequest = {
      expected_control_revision: dualAgain.control_revision,
      mode: 'dual_pov',
      idempotency_key: 'mode-dual-noop'
    };
    noOpModeChangeResult = await repositories.turns.changeNarrativeMode({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: noOpModeChangeRequest
    });
    assert.equal(noOpModeChangeResult.changed, false);
    assert.equal(noOpModeChangeResult.control_revision, dualAgain.control_revision);

    // Billing selection persistence owns this documented transition. The
    // core action repository only accepts the resulting COLLECTING state.
    await connection.write(database => {
      database.prepare(`
        UPDATE multiplayer_turns
           SET turn_status = 'COLLECTING_ACTIONS'
         WHERE turn_id = ? AND turn_status = 'AWAITING_PAYER_SELECTION'
      `).run(openedTurn.turn_id);
    });
  });

  await test('first open action gets receipt 1, encrypted content and recipient-safe reveal event', async () => {
    const result = await repositories.turns.lockAction({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      epoch_id: 'epoch_1',
      turn_no: 1,
      request: action('我在门后布置起爆符', 'action-a-1', 'open')
    });
    firstReceipt = result.receipt;
    assert.equal(firstReceipt.seat, 'A');
    assert.equal(firstReceipt.receipt_seq, 1);
    assert.match(firstReceipt.content_commitment, /^hmac-sha256:[a-f0-9]{64}$/u);
    const stored = connection.read(database => database.prepare(`
      SELECT action_ciphertext FROM action_submissions WHERE submission_id = ?
    `).get(firstReceipt.submission_id));
    assert.equal(Buffer.from(stored.action_ciphertext).includes(Buffer.from('起爆符')), false);

    codec.openedSeats.length = 0;
    const guestView = repositories.turns.getForMember({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      epoch_id: 'epoch_1',
      turn_no: 1
    });
    assert.equal(guestView.actions.A.text, '我在门后布置起爆符');
    assert.equal(guestView.actions.A.disclosure, 'open_pre_resolution');
    assert.deepEqual(codec.openedSeats, ['A']);
    const guestEvents = repositories.events.listAfter({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1'
    });
    const reveal = guestEvents.find(event => event.event_type === 'action.revealed_pre_resolution');
    assert.deepEqual(Object.keys(reveal.payload), ['submission_id']);
    assert.equal(JSON.stringify(reveal.payload).includes('起爆符'), false);
  });

  await test('action network replay is stable and same key with changed content conflicts', async () => {
    const before = connection.read(database => database.prepare(`
      SELECT control_revision, event_seq FROM multiplayer_rooms WHERE room_id = 'room_1'
    `).get());
    const replay = await repositories.turns.lockAction({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      epoch_id: 'epoch_1',
      turn_no: 1,
      request: action('我在门后布置起爆符', 'action-a-1', 'open')
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, firstReceipt);
    assert.deepEqual(connection.read(database => database.prepare(`
      SELECT control_revision, event_seq FROM multiplayer_rooms WHERE room_id = 'room_1'
    `).get()), before);
    assert.deepEqual(await repositories.turns.changeNarrativeMode({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: noOpModeChangeRequest
    }), { ...noOpModeChangeResult, replayed: true });
    await assert.rejects(() => repositories.turns.lockAction({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      epoch_id: 'epoch_1',
      turn_no: 1,
      request: action('改成偷走卷轴', 'action-a-1', 'open')
    }), expectDomain('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(() => repositories.turns.lockAction({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      epoch_id: 'epoch_1',
      turn_no: 1,
      request: action('改成偷走卷轴', 'action-a-2', 'open')
    }), expectDomain('ACTION_ALREADY_LOCKED'));
  });

  await test('mode changes after first receipt queue only the next turn', async () => {
    const room = repositories.rooms.getForMember({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1'
    });
    const queued = await repositories.turns.changeNarrativeMode({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      request: {
        expected_control_revision: room.control_revision,
        mode: 'shared',
        idempotency_key: 'mode-shared-next'
      }
    });
    assert.equal(queued.disposition, 'queued_next_turn');
    const after = repositories.rooms.getForMember({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1'
    });
    assert.equal(after.active_narrative_mode, 'dual_pov');
    assert.equal(after.queued_narrative_mode, 'shared');
    assert.equal(connection.read(database => database.prepare(`
      SELECT narrative_mode FROM multiplayer_turns WHERE turn_id = ?
    `).get(openedTurn.turn_id)).narrative_mode, 'dual_pov');
  });

  await test('second open action gets receipt 2 but grants no pre-commit reveal', async () => {
    const result = await repositories.turns.lockAction({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      epoch_id: 'epoch_1',
      turn_no: 1,
      request: action('我在庭院观察对方', 'action-b-1', 'open')
    });
    assert.equal(result.receipt.receipt_seq, 2);
    assert.equal(result.turn_status, 'SEALED');
    codec.openedSeats.length = 0;
    const ownerAView = repositories.turns.getForMember({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      epoch_id: 'epoch_1',
      turn_no: 1
    });
    assert.deepEqual(ownerAView.actions.B, { seat: 'B', locked: true });
    assert.deepEqual(codec.openedSeats, ['A']);
  });

  await test('committed status seals both originals and refuses a read without publication projection', async () => {
    const committedAt = '2026-08-22T01:00:00.000Z';
    await connection.write(database => {
      database.prepare(`
        UPDATE multiplayer_turns
           SET turn_status = 'COMMITTED', committed_at = ?, updated_at = ?
         WHERE turn_id = ? AND turn_status = 'SEALED'
      `).run(committedAt, committedAt, openedTurn.turn_id);
      database.prepare(`
        UPDATE action_submissions SET full_disclosed_at = ? WHERE turn_id = ?
      `).run(committedAt, openedTurn.turn_id);
    });
    const rows = connection.read(database => database.prepare(`
      SELECT * FROM action_submissions WHERE turn_id = ? ORDER BY seat_id
    `).all(openedTurn.turn_id));
    assert.equal(rows.length, 2);
    assert.equal(rows.every(row => row.full_disclosed_at === committedAt), true);
    assert.deepEqual(rows.map(row => codec.openJson(row, { seat_id: row.seat_id }).text), [
      '我在门后布置起爆符',
      '我在庭院观察对方'
    ]);
    assert.throws(() => repositories.turns.getForMember({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      epoch_id: 'epoch_1',
      turn_no: 1
    }), expectDomain('COMMITTED_PUBLICATION_DISABLED'));
  });

  await test('chat is normalized, member-idempotent and never changes room control revision', async () => {
    const beforeControl = repositories.rooms.getForMember({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1'
    }).control_revision;
    firstChat = await repositories.chat.append({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: { text: '先商量\r\n再行动', idempotency_key: 'chat-shared-key' }
    });
    assert.equal(firstChat.message.text, '先商量\n再行动');
    const replay = await repositories.chat.append({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: { text: '先商量\n再行动', idempotency_key: 'chat-shared-key' }
    });
    assert.equal(replay.replayed, true);
    await assert.rejects(() => repositories.chat.append({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: { text: '不同内容', idempotency_key: 'chat-shared-key' }
    }), expectDomain('IDEMPOTENCY_CONFLICT'));
    const guestSameKey = await repositories.chat.append({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      request: { text: '客方的独立消息', idempotency_key: 'chat-shared-key' }
    });
    assert.equal(guestSameKey.replayed, false);
    assert.equal(repositories.rooms.getForMember({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1'
    }).control_revision, beforeControl);
  });

  await test('chat history supports immutable backwards pagination', async () => {
    await repositories.chat.append({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: { text: '第三条', idempotency_key: 'chat-3' }
    });
    await repositories.chat.append({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      request: { text: '第四条', idempotency_key: 'chat-4' }
    });
    const pageOne = repositories.chat.listHistory({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      limit: 2
    });
    assert.equal(pageOne.messages.length, 2);
    assert.ok(pageOne.messages[0].event_seq > pageOne.messages[1].event_seq);
    const pageTwo = repositories.chat.listHistory({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      before: pageOne.next_before,
      limit: 2
    });
    assert.equal(pageTwo.messages.length, 2);
    assert.ok(pageTwo.messages.every(message => (
      message.event_seq < pageOne.messages[1].event_seq
    )));
  });

  await test('event insertion failure rolls back chat business data and reserved sequence', async () => {
    const before = connection.read(database => ({
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_1'
      `).get().event_seq,
      messages: database.prepare(`
        SELECT COUNT(*) AS count FROM room_chat_messages WHERE room_id = 'room_1'
      `).get().count
    }));
    const failingRepositories = createSqliteMultiplayerCoreRepositories(connection, {
      actionContentCodec: codec,
      actionCommitmentSecret: Buffer.alloc(32, 0x44),
      clock: createClock(),
      idFactory: kind => kind === 'event' ? 'event_1' : `${kind}_fault`,
      executionPlanResolver: ({ turn }) => executionPlanFor(turn)
    });
    await assert.rejects(() => failingRepositories.chat.append({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: { text: '这条必须回滚', idempotency_key: 'chat-fault-rollback' }
    }), error => String(error?.code || '').startsWith('SQLITE_CONSTRAINT'));
    const after = connection.read(database => ({
      event_seq: database.prepare(`
        SELECT event_seq FROM multiplayer_rooms WHERE room_id = 'room_1'
      `).get().event_seq,
      messages: database.prepare(`
        SELECT COUNT(*) AS count FROM room_chat_messages WHERE room_id = 'room_1'
      `).get().count
    }));
    assert.deepEqual(after, before);
  });

  await test('event replay is audience-filtered and every business event has one outbox row', async () => {
    const hostEvents = repositories.events.listAfter({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      after_event_seq: 0,
      limit: 500
    });
    const guestEvents = repositories.events.listAfter({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      after_event_seq: 0,
      limit: 500
    });
    assert.ok(hostEvents.some(event => event.event_type === 'room.invite_created'));
    assert.equal(guestEvents.some(event => event.event_type === 'room.invite_created'), false);
    assert.ok(hostEvents.some(event => event.event_type === 'chat.message_created'));
    assert.ok(guestEvents.some(event => event.event_type === 'chat.message_created'));
    assert.equal(hostEvents.some(event => event.audience === 'B'), false);
    assert.equal(guestEvents.some(event => event.audience === 'A'), false);
    const counts = connection.read(database => ({
      events: database.prepare('SELECT COUNT(*) AS count FROM room_events').get().count,
      outbox: database.prepare('SELECT COUNT(*) AS count FROM room_outbox').get().count,
      maximum: database.prepare('SELECT MAX(event_seq) AS value FROM room_events').get().value,
      room_sequence: database.prepare(`
        SELECT event_seq AS value FROM multiplayer_rooms WHERE room_id = 'room_1'
      `).get().value,
      distinct_sequences: database.prepare(`
        SELECT COUNT(DISTINCT event_seq) AS count FROM room_events WHERE room_id = 'room_1'
      `).get().count
    }));
    assert.equal(counts.events, counts.outbox);
    assert.equal(counts.maximum, counts.room_sequence);
    assert.equal(counts.distinct_sequences, counts.events);
  });

  await test('outbox claim, dispatch CAS, release and reclaim preserve event projection', async () => {
    const claimed = await repositories.outbox.claim({
      dispatcher_owner_id: 'dispatcher_1',
      now: '2026-08-22T02:00:00.000Z',
      expires_at: '2026-08-22T02:01:00.000Z',
      limit: 500
    });
    assert.ok(claimed.length > 2);
    assert.equal(typeof claimed[0].payload, 'object');
    const dispatched = await repositories.outbox.markDispatched({
      outbox_id: claimed[0].outbox_id,
      dispatcher_owner_id: 'dispatcher_1',
      lease_fence: claimed[0].lease_fence,
      dispatched_at: '2026-08-22T02:00:10.000Z'
    });
    assert.equal(dispatched.replayed, false);
    const replay = await repositories.outbox.markDispatched({
      outbox_id: claimed[0].outbox_id,
      dispatcher_owner_id: 'dispatcher_1',
      lease_fence: claimed[0].lease_fence,
      dispatched_at: '2026-08-22T02:00:10.000Z'
    });
    assert.equal(replay.replayed, true);
    const released = await repositories.outbox.release({
      outbox_id: claimed[1].outbox_id,
      dispatcher_owner_id: 'dispatcher_1',
      lease_fence: claimed[1].lease_fence
    });
    const reclaimed = await repositories.outbox.claim({
      dispatcher_owner_id: 'dispatcher_2',
      now: '2026-08-22T02:00:20.000Z',
      expires_at: '2026-08-22T02:01:20.000Z',
      limit: 1
    });
    assert.equal(reclaimed[0].outbox_id, released.outbox_id);
    assert.equal(reclaimed[0].lease_fence, released.lease_fence + 1);
  });

  await test('archived room keeps chat history readable but rejects every new message', async () => {
    const archivedAt = '2026-08-22T03:00:00.000Z';
    await connection.write(database => {
      database.prepare(`
        UPDATE multiplayer_rooms
           SET lifecycle = 'ARCHIVED', archived_at = ?, updated_at = ?
         WHERE room_id = 'room_1'
      `).run(archivedAt, archivedAt);
    });
    await assert.rejects(() => repositories.chat.append({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: { text: '归档后不可写', idempotency_key: 'chat-after-archive' }
    }), expectDomain('ROOM_ARCHIVED_READ_ONLY'));
    const replay = await repositories.chat.append({
      authenticated_user_id: '123456789012345678',
      room_id: 'room_1',
      request: { text: '先商量\n再行动', idempotency_key: 'chat-shared-key' }
    });
    assert.equal(replay.replayed, true);
    assert.ok(repositories.chat.listHistory({
      authenticated_user_id: '987654321098765432',
      room_id: 'room_1',
      limit: 10
    }).messages.length >= 4);
  });
} catch (error) {
  console.error('multiplayer core repository regression failure:', error);
  throw error;
} finally {
  await connection.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer core repositories regression: ${passed} passed`);
