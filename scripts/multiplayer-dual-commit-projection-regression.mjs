import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';
import { TURN_EXECUTION_PLAN_SCHEMA } from '../server/multiplayer/contracts/room-contracts.js';
import {
  ROOM_CHECKPOINT_SCHEMA,
  ROOM_EPOCH_SCHEMA,
  ROOM_ORIGIN_SCHEMA
} from '../server/multiplayer/contracts/lineage-contracts.js';
import { NARRATIVE_DELIVERY_SCHEMA } from '../server/multiplayer/contracts/narrative-contracts.js';
import {
  canonicalStringify,
  hmacSha256,
  sha256Hex
} from '../server/multiplayer/domain/canonical-json.js';
import { ACTION_REQUEST_SCHEMA } from '../server/multiplayer/domain/action-turn.js';
import { createNewMultiplayerGenesisState } from '../server/multiplayer/application/genesis-state.js';
import { createSqliteMultiplayerCoreRepositories } from '../server/multiplayer/persistence/sqlite-core-repositories.js';
import { createActionContentCodec } from '../server/multiplayer/security/action-content-codec.js';
import {
  sealNarrativeDeliveryContent
} from '../server/multiplayer/security/narrative-delivery-content-codec.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

const CREATED_AT = '2026-08-23T10:00:00.000Z';
const COMMITTED_AT = '2026-08-23T10:10:00.000Z';
const ROOM_ID = 'room_dual_projection';
const LINEAGE_ID = 'lineage_dual_projection';
const EPOCH_ID = 'epoch_dual_projection';
const GENESIS_CHECKPOINT_ID = 'checkpoint_dual_genesis';
const COMMIT_CHECKPOINT_ID = 'checkpoint_dual_turn_1';
const COMMIT_ID = 'commit_dual_turn_1';
const SNAPSHOT_ID = 'snapshot_dual_turn_1';
const USER_A = 'user_dual_projection_A';
const USER_B = 'user_dual_projection_B';
const MASTER_KEY_VERSION = 'projection-test-v1';
const BASE_STATE_HASH = `sha256:${'a'.repeat(64)}`;
const POV_A_TEXT = '甲的视角里，屋檐下只留下了一枚银色风铃。';
const POV_B_TEXT = '乙的视角里，回廊尽头只掠过了一道赤红纸鸢。';

const hash = value => `sha256:${sha256Hex(canonicalStringify(value))}`;
const resolutionCommitment = value => (
  `hmac-sha256:${hmacSha256(Buffer.alloc(32, 0x71), value)}`
);

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function createClock() {
  let tick = 0;
  return () => new Date(Date.parse(CREATED_AT) + (++tick * 1_000)).toISOString();
}

function createIdFactory() {
  const counts = new Map();
  return kind => {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    return `${kind}_dual_projection_${count}`;
  };
}

function executionPlan() {
  return {
    schema: TURN_EXECUTION_PLAN_SCHEMA,
    narrative_mode: 'dual_pov',
    turn_payer_selection_hash: hash('dual-turn-payer'),
    pov_writer_selection_hashes: {
      A: hash('dual-writer-selection-A'),
      B: hash('dual-writer-selection-B')
    },
    writer_payer_by_audience: { A: 'A', B: 'B' },
    model_config_fingerprints: {
      shared_stage: hash('dual-shared-stage-model'),
      pov_writers: {
        A: hash('dual-writer-model-A'),
        B: hash('dual-writer-model-B')
      }
    }
  };
}

function action(text, idempotencyKey) {
  return {
    schema: ACTION_REQUEST_SCHEMA,
    base_state_revision: 0,
    text,
    pre_resolution_visibility: 'sealed',
    narration_preference: 'full',
    idempotency_key: idempotencyKey
  };
}

function narrativeFixture({ turnId, seat, text }) {
  const suffix = seat.toLowerCase();
  const eventId = `event_dual_private_${suffix}`;
  return {
    schema: NARRATIVE_DELIVERY_SCHEMA,
    turn_id: turnId,
    audience: `seat:${seat}`,
    resolution_commitment: resolutionCommitment({ turn_id: turnId, seat }),
    segments: [{
      segment_id: `segment_dual_private_${suffix}`,
      event_refs: [eventId],
      claims: [{
        event_id: eventId,
        subject_id: `actor:${seat}`,
        predicate: 'noticed_private_detail',
        value: seat === 'A' ? 'silver-bell' : 'red-kite'
      }],
      text
    }],
    stop_point_ref: eventId
  };
}

function narrativeStorageRow({ turnId, seat, resolutionHash }) {
  return {
    room_id: ROOM_ID,
    epoch_id: EPOCH_ID,
    turn_id: turnId,
    delivery_id: `delivery_dual_${seat}`,
    audience: seat,
    narrative_mode: 'dual_pov',
    resolution_hash: resolutionHash,
    projection_hash: hash({ turn_id: turnId, audience: `seat:${seat}` }),
    writer_invocation_id: `invocation_dual_writer_${seat}`,
    stop_point_ref: `event_dual_private_${seat.toLowerCase()}`
  };
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-dual-projection-'));
const databasePath = path.join(tempRoot, 'multiplayer.sqlite');
const contentCodec = createActionContentCodec({
  masterKeys: { [MASTER_KEY_VERSION]: Buffer.alloc(32, 0x4d) },
  activeMasterKeyVersion: MASTER_KEY_VERSION
});
const openedNarrativeAudiences = [];
const narrativeContentCodec = Object.freeze({
  sealJson(value, context) {
    return contentCodec.sealJson(value, context);
  },
  openJson(envelope, context) {
    openedNarrativeAudiences.push(context.audience);
    return contentCodec.openJson(envelope, context);
  }
});
const connection = await openMultiplayerRepositoryTestSqlite({ databasePath });
const repositories = createSqliteMultiplayerCoreRepositories(connection, {
  actionContentCodec: contentCodec,
  narrativeContentCodec,
  includeCommittedPublications: true,
  actionCommitmentSecret: Buffer.alloc(32, 0x62),
  clock: createClock(),
  idFactory: createIdFactory(),
  randomTokenBytes: size => Buffer.alloc(size, 0x73),
  executionPlanResolver: executionPlan
});

let turnId;
let projectionA;
let projectionB;

try {
  await test('real SQLite fixture forms a valid encrypted dual-POV atomic publication chain', async () => {
    await repositories.rooms.createWithGenesis({
      authenticated_user_id: USER_A,
      origin: {
        schema: ROOM_ORIGIN_SCHEMA,
        room_id: ROOM_ID,
        origin_type: 'new_multiplayer_save',
        lineage_id: LINEAGE_ID,
        origin_owner_user_id: null,
        origin_snapshot_id: 'snapshot_dual_origin'
      },
      epoch: {
        schema: ROOM_EPOCH_SCHEMA,
        epoch_id: EPOCH_ID,
        room_id: ROOM_ID,
        lineage_id: LINEAGE_ID,
        epoch_no: 1,
        base: {
          type: 'origin_snapshot',
          ref_id: 'snapshot_dual_origin',
          state_hash: BASE_STATE_HASH
        },
        genesis_checkpoint_id: GENESIS_CHECKPOINT_ID,
        head_checkpoint_id: GENESIS_CHECKPOINT_ID,
        state_revision: 0,
        control_revision: 0,
        state: 'ACTIVE',
        created_from_proposal_id: null,
        activated_at: CREATED_AT
      },
      genesis_checkpoint: {
        schema: ROOM_CHECKPOINT_SCHEMA,
        checkpoint_id: GENESIS_CHECKPOINT_ID,
        room_id: ROOM_ID,
        lineage_id: LINEAGE_ID,
        epoch_id: EPOCH_ID,
        turn_no: 0,
        kind: 'genesis',
        parent_checkpoint_id: null,
        turn_id: null,
        commit_id: null,
        state_revision: 0,
        state_hash: BASE_STATE_HASH,
        snapshot_ref: 'snapshot_dual_origin',
        created_at: CREATED_AT
      }
    });
    const invite = await repositories.invites.create({
      authenticated_user_id: USER_A,
      room_id: ROOM_ID
    });
    await repositories.invites.join({
      authenticated_user_id: USER_B,
      room_id: ROOM_ID,
      token: invite.token
    });
    const opened = await repositories.turns.open({
      authenticated_user_id: USER_A,
      room_id: ROOM_ID,
      expected_control_revision: repositories.rooms.getForMember({
        authenticated_user_id: USER_A,
        room_id: ROOM_ID
      }).control_revision
    });
    turnId = opened.turn_id;
    await repositories.turns.changeNarrativeMode({
      authenticated_user_id: USER_B,
      room_id: ROOM_ID,
      request: {
        expected_control_revision: opened.control_revision,
        mode: 'dual_pov',
        idempotency_key: 'mode-dual-projection'
      }
    });
    await connection.write(database => {
      const result = database.prepare(`
        UPDATE multiplayer_turns
           SET turn_status = 'COLLECTING_ACTIONS'
         WHERE turn_id = ? AND turn_status = 'AWAITING_PAYER_SELECTION'
      `).run(turnId);
      assert.equal(result.changes, 1);
    });
    await repositories.turns.lockAction({
      authenticated_user_id: USER_A,
      room_id: ROOM_ID,
      epoch_id: EPOCH_ID,
      turn_no: 1,
      request: action('我检查屋檐下的动静。', 'action-dual-A')
    });
    const sealed = await repositories.turns.lockAction({
      authenticated_user_id: USER_B,
      room_id: ROOM_ID,
      epoch_id: EPOCH_ID,
      turn_no: 1,
      request: action('我沿回廊观察远处。', 'action-dual-B')
    });
    assert.equal(sealed.turn_status, 'SEALED');

    const resolutionHash = hash({ turn_id: turnId, resolution: 'dual-projection-fixture' });
    const narrativeRows = ['A', 'B'].map(seat => {
      const row = narrativeStorageRow({ turnId, seat, resolutionHash });
      const delivery = narrativeFixture({
        turnId,
        seat,
        text: seat === 'A' ? POV_A_TEXT : POV_B_TEXT
      });
      return {
        ...row,
        ...sealNarrativeDeliveryContent(narrativeContentCodec, row, delivery)
      };
    });
    const committedState = structuredClone(createNewMultiplayerGenesisState({
      actor_ids: { A: 'actor:A', B: 'actor:B' }
    }));
    committedState.meta.state_revision = 1;
    committedState.actors.A.private_knowledge.facts.push({
      kind: 'noticed_private_detail',
      summary: 'silver-bell'
    });
    committedState.actors.B.private_knowledge.facts.push({
      kind: 'noticed_private_detail',
      summary: 'red-kite'
    });
    committedState.shared_world.continuity_ledger.shinobi_daily = [{
      daily_id: 'daily_dual_turn_1',
      source_turn_id: turnId,
      daily: structuredClone(SHINOBI_DAILY_EXAMPLE)
    }];
    const stateHash = hash(committedState);
    const snapshotContext = {
      schema: 'naruto.multiplayer-room-snapshot-context/v1',
      room_id: ROOM_ID,
      epoch_id: EPOCH_ID,
      checkpoint_id: COMMIT_CHECKPOINT_ID,
      snapshot_id: SNAPSHOT_ID,
      state_revision: 1,
      state_hash: stateHash
    };
    const sealedSnapshot = contentCodec.sealJson(committedState, snapshotContext);
    const checkpointRecord = {
      checkpoint_id: COMMIT_CHECKPOINT_ID,
      room_id: ROOM_ID,
      lineage_id: LINEAGE_ID,
      epoch_id: EPOCH_ID,
      turn_no: 1,
      checkpoint_kind: 'turn_commit',
      parent_checkpoint_id: GENESIS_CHECKPOINT_ID,
      turn_id: turnId,
      commit_id: COMMIT_ID,
      state_revision: 1,
      state_hash: stateHash,
      snapshot_ref: SNAPSHOT_ID,
      created_at: COMMITTED_AT
    };

    await connection.write(database => {
      const insertNarrative = database.prepare(`
        INSERT INTO narrative_deliveries (
          delivery_id, turn_id, audience, narrative_mode,
          delivery_ciphertext, wrapped_data_key, nonce, auth_tag,
          master_key_version, resolution_hash, projection_hash, narrative_hash,
          writer_invocation_id, stop_point_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of narrativeRows) {
        insertNarrative.run(
          row.delivery_id,
          row.turn_id,
          row.audience,
          row.narrative_mode,
          row.delivery_ciphertext,
          row.wrapped_data_key,
          row.nonce,
          row.auth_tag,
          row.master_key_version,
          row.resolution_hash,
          row.projection_hash,
          row.narrative_hash,
          row.writer_invocation_id,
          row.stop_point_ref,
          COMMITTED_AT
        );
      }
      database.prepare(`
        INSERT INTO room_checkpoints (
          checkpoint_id, room_id, lineage_id, epoch_id, turn_no,
          checkpoint_kind, parent_checkpoint_id, turn_id, commit_id,
          state_revision, state_hash, snapshot_ref, created_at
        ) VALUES (?, ?, ?, ?, 1, 'turn_commit', ?, ?, ?, 1, ?, ?, ?)
      `).run(
        COMMIT_CHECKPOINT_ID,
        ROOM_ID,
        LINEAGE_ID,
        EPOCH_ID,
        GENESIS_CHECKPOINT_ID,
        turnId,
        COMMIT_ID,
        stateHash,
        SNAPSHOT_ID,
        COMMITTED_AT
      );
      database.prepare(`
        INSERT INTO turn_commits (
          commit_id, turn_id, room_id, epoch_id, checkpoint_id,
          commit_precondition_hash, before_state_revision, after_state_revision,
          before_state_hash, after_state_hash, artifact_set_hash,
          narrative_set_hash, checkpoint_hash, commit_envelope_hash,
          lease_fence, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        COMMIT_ID,
        turnId,
        ROOM_ID,
        EPOCH_ID,
        COMMIT_CHECKPOINT_ID,
        hash({ turn_id: turnId, preconditions: 'fixture' }),
        BASE_STATE_HASH,
        stateHash,
        hash({ daily_id: 'daily_dual_turn_1' }),
        hash(narrativeRows.map(row => row.narrative_hash)),
        hash(checkpointRecord),
        hash({ turn_id: turnId, checkpoint_id: COMMIT_CHECKPOINT_ID }),
        COMMITTED_AT
      );
      database.prepare(`
        INSERT INTO room_snapshots (
          snapshot_id, room_id, epoch_id, checkpoint_id, state_revision,
          state_hash, snapshot_ciphertext, wrapped_data_key, nonce, auth_tag,
          master_key_version, created_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        SNAPSHOT_ID,
        ROOM_ID,
        EPOCH_ID,
        COMMIT_CHECKPOINT_ID,
        stateHash,
        sealedSnapshot.action_ciphertext,
        sealedSnapshot.wrapped_data_key,
        sealedSnapshot.nonce,
        sealedSnapshot.auth_tag,
        sealedSnapshot.master_key_version,
        COMMITTED_AT
      );
      const room = database.prepare(`
        SELECT control_revision FROM multiplayer_rooms WHERE room_id = ?
      `).get(ROOM_ID);
      const nextControlRevision = room.control_revision + 1;
      assert.equal(database.prepare(`
        UPDATE multiplayer_rooms
           SET state_revision = 1, control_revision = ?, updated_at = ?
         WHERE room_id = ? AND state_revision = 0
      `).run(nextControlRevision, COMMITTED_AT, ROOM_ID).changes, 1);
      assert.equal(database.prepare(`
        UPDATE room_epochs
           SET head_checkpoint_id = ?, state_revision = 1, control_revision = ?
         WHERE epoch_id = ? AND head_checkpoint_id = ? AND state_revision = 0
      `).run(
        COMMIT_CHECKPOINT_ID,
        nextControlRevision,
        EPOCH_ID,
        GENESIS_CHECKPOINT_ID
      ).changes, 1);
      assert.equal(database.prepare(`
        UPDATE multiplayer_turns
           SET turn_status = 'COMMITTED', committed_at = ?, updated_at = ?
         WHERE turn_id = ? AND turn_status = 'SEALED'
      `).run(COMMITTED_AT, COMMITTED_AT, turnId).changes, 1);
      assert.equal(database.prepare(`
        UPDATE action_submissions SET full_disclosed_at = ?
         WHERE turn_id = ? AND full_disclosed_at IS NULL
      `).run(COMMITTED_AT, turnId).changes, 2);
    });

    const persisted = connection.read(database => ({
      foreignKeys: database.prepare('PRAGMA foreign_key_check').all(),
      narratives: database.prepare(`
        SELECT audience, delivery_ciphertext, master_key_version
          FROM narrative_deliveries WHERE turn_id = ? ORDER BY audience
      `).all(turnId),
      checkpoint: database.prepare(`
        SELECT checkpoint_kind, turn_id, commit_id, snapshot_ref, state_revision
          FROM room_checkpoints WHERE checkpoint_id = ?
      `).get(COMMIT_CHECKPOINT_ID)
    }));
    assert.deepEqual(persisted.foreignKeys, []);
    assert.deepEqual(persisted.narratives.map(row => row.audience), ['A', 'B']);
    for (const row of persisted.narratives) {
      assert.equal(row.master_key_version, MASTER_KEY_VERSION);
      assert.equal(Buffer.from(row.delivery_ciphertext).includes(Buffer.from(POV_A_TEXT)), false);
      assert.equal(Buffer.from(row.delivery_ciphertext).includes(Buffer.from(POV_B_TEXT)), false);
    }
    assert.deepEqual(persisted.checkpoint, {
      checkpoint_kind: 'turn_commit',
      turn_id: turnId,
      commit_id: COMMIT_ID,
      snapshot_ref: SNAPSHOT_ID,
      state_revision: 1
    });
  });

  await test('seat A receives exactly audience A narrative and never opens or projects B POV', () => {
    openedNarrativeAudiences.length = 0;
    projectionA = repositories.turns.getForMember({
      authenticated_user_id: USER_A,
      room_id: ROOM_ID,
      epoch_id: EPOCH_ID,
      turn_no: 1
    });
    assert.equal(projectionA.status, 'COMMITTED');
    assert.equal(projectionA.viewer_seat, 'A');
    assert.equal(projectionA.active_narrative_mode, 'dual_pov');
    assert.equal(projectionA.commit.narratives.length, 1);
    assert.equal(projectionA.commit.narratives[0].audience, 'seat:A');
    assert.equal(projectionA.commit.narratives[0].segments[0].text, POV_A_TEXT);
    assert.deepEqual(openedNarrativeAudiences, ['seat:A']);
    const serialized = JSON.stringify(projectionA.commit);
    assert.equal(serialized.includes(POV_B_TEXT), false);
    assert.equal(serialized.includes('event_dual_private_b'), false);
    assert.equal(serialized.includes('red-kite'), false);
    assert.equal(projectionA.commit.state.viewer_seat, 'A');
    assert.equal('canonical' in projectionA.commit.state.memories, false);
    assert.equal('npc_private' in projectionA.commit.state.memories, false);
    assert.deepEqual(projectionA.commit.state.actors.B.skills.entries, []);
    assert.equal(projectionA.commit.shinobi_daily.length, 1);
    assert.equal(projectionA.commit.shinobi_daily[0].daily.schema, 'naruto.shinobi-daily/v1');
    assert.equal(projectionA.commit.checkpoint.checkpoint_id, COMMIT_CHECKPOINT_ID);
    assert.equal(projectionA.commit.checkpoint.commit_id, COMMIT_ID);
  });

  await test('seat B receives exactly audience B narrative and never opens or projects A POV', () => {
    openedNarrativeAudiences.length = 0;
    projectionB = repositories.turns.getForMember({
      authenticated_user_id: USER_B,
      room_id: ROOM_ID,
      epoch_id: EPOCH_ID,
      turn_no: 1
    });
    assert.equal(projectionB.status, 'COMMITTED');
    assert.equal(projectionB.viewer_seat, 'B');
    assert.equal(projectionB.active_narrative_mode, 'dual_pov');
    assert.equal(projectionB.commit.narratives.length, 1);
    assert.equal(projectionB.commit.narratives[0].audience, 'seat:B');
    assert.equal(projectionB.commit.narratives[0].segments[0].text, POV_B_TEXT);
    assert.deepEqual(openedNarrativeAudiences, ['seat:B']);
    const serialized = JSON.stringify(projectionB.commit);
    assert.equal(serialized.includes(POV_A_TEXT), false);
    assert.equal(serialized.includes('event_dual_private_a'), false);
    assert.equal(serialized.includes('silver-bell'), false);
    assert.equal(projectionB.commit.state.viewer_seat, 'B');
    assert.equal('canonical' in projectionB.commit.state.memories, false);
    assert.equal('npc_private' in projectionB.commit.state.memories, false);
    assert.deepEqual(projectionB.commit.state.actors.A.skills.entries, []);
    assert.deepEqual(projectionB.commit.checkpoint, projectionA.commit.checkpoint);
    assert.deepEqual(projectionB.commit.shinobi_daily, projectionA.commit.shinobi_daily);
    assert.notDeepEqual(projectionB.commit.narratives, projectionA.commit.narratives);
    assert.notDeepEqual(projectionB.commit.state, projectionA.commit.state);
  });
} catch (error) {
  console.error('multiplayer dual commit projection regression failure:', error);
  throw error;
} finally {
  await connection.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer dual commit projection regression: ${passed} passed`);
