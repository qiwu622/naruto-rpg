import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  createHash
} from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
  SOURCE_IMPORT_SCHEMA
} from '../server/multiplayer/contracts/lineage-contracts.js';
import { canonicalStringify } from '../server/multiplayer/domain/canonical-json.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import { createSqliteLineageRepository } from '../server/multiplayer/persistence/sqlite-lineage-repository.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function expectCode(code, operation) {
  await assert.rejects(
    async () => operation(),
    error => error instanceof DomainError && error.code === code
  );
}

const HASH = value => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
const HMAC = value => `hmac-sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
const INITIAL_TIME = '2026-08-22T01:00:00.000Z';
const ROOM_EXISTING = 'room_existing';
const ROOM_NEW = 'room_new';
const USER_A = 'user_A';
const USER_B = 'user_B';
const TOKEN_A = 'binding_token_owner_A_0001';
const TOKEN_B = 'binding_token_guest_B_0001';
const INITIAL_EXISTING_HASH = HASH('existing-genesis');
const INITIAL_NEW_HASH = HASH('new-genesis');

function createClock() {
  let tick = 0;
  return () => new Date(Date.parse(INITIAL_TIME) + tick++ * 1_000).toISOString();
}

function createIdFactory() {
  let value = 0;
  return kind => `${kind}_lineage_${++value}`;
}

function createEncryptedDiffCodec() {
  const key = Buffer.alloc(32, 0x62);
  let nonceCounter = 0;
  return {
    codecVersion: 'test-aes-256-gcm-v1',
    sealJson(value, context) {
      const nonce = Buffer.alloc(12);
      nonce.writeUInt32BE(++nonceCounter, 8);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(canonicalStringify(context)));
      const ciphertext = Buffer.concat([
        cipher.update(canonicalStringify(value), 'utf8'),
        cipher.final()
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    openJson(value, context) {
      const bytes = Buffer.from(value);
      const nonce = bytes.subarray(0, 12);
      const tag = bytes.subarray(12, 28);
      const ciphertext = bytes.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(canonicalStringify(context)));
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]).toString('utf8'));
    }
  };
}

function seedRoom(database, {
  roomId,
  lineageId,
  originType,
  stateHash
}) {
  const owner = originType === 'existing_save_derived' ? USER_A : null;
  const epochId = `${roomId}_epoch_1`;
  const checkpointId = `${roomId}_checkpoint_0`;
  database.prepare(`
    INSERT INTO multiplayer_rooms (
      room_id, origin_type, lineage_id, origin_owner_user_id,
      origin_snapshot_id, lifecycle, host_user_id, active_epoch_id,
      current_turn_id, state_revision, control_revision, event_seq,
      active_narrative_mode, queued_narrative_mode, created_at,
      updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, NULL, 0, 0, 0,
      'shared', NULL, ?, ?, NULL)
  `).run(
    roomId,
    originType,
    lineageId,
    owner,
    `${roomId}_origin_snapshot`,
    USER_A,
    INITIAL_TIME,
    INITIAL_TIME
  );
  database.prepare(`
    INSERT INTO multiplayer_members (
      member_id, room_id, user_id, seat_id, member_status, joined_at, left_at
    ) VALUES (?, ?, ?, 'A', 'ACTIVE', ?, NULL)
  `).run(`${roomId}_member_A`, roomId, USER_A, INITIAL_TIME);
  database.prepare(`
    INSERT INTO multiplayer_members (
      member_id, room_id, user_id, seat_id, member_status, joined_at, left_at
    ) VALUES (?, ?, ?, 'B', 'ACTIVE', ?, NULL)
  `).run(`${roomId}_member_B`, roomId, USER_B, INITIAL_TIME);
  database.prepare(`
    INSERT INTO room_epochs (
      epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
      base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
      state_revision, control_revision, epoch_state,
      created_from_proposal_id, activated_at, archived_at
    ) VALUES (?, ?, ?, 1, 'origin_snapshot', ?, ?, ?, ?, 0, 0,
      'ACTIVE', NULL, ?, NULL)
  `).run(
    epochId,
    roomId,
    lineageId,
    `${roomId}_origin_snapshot`,
    stateHash,
    checkpointId,
    checkpointId,
    INITIAL_TIME
  );
  database.prepare(`
    INSERT INTO room_checkpoints (
      checkpoint_id, room_id, lineage_id, epoch_id, turn_no,
      checkpoint_kind, parent_checkpoint_id, turn_id, commit_id,
      state_revision, state_hash, snapshot_ref, created_at
    ) VALUES (?, ?, ?, ?, 0, 'genesis', NULL, NULL, NULL, 0, ?, ?, ?)
  `).run(
    checkpointId,
    roomId,
    lineageId,
    epochId,
    stateHash,
    `${roomId}_snapshot_ref_0`,
    INITIAL_TIME
  );
  database.prepare(`
    UPDATE multiplayer_rooms SET active_epoch_id = ? WHERE room_id = ?
  `).run(epochId, roomId);
}

function bindingPair(roomId, suffix = '') {
  return [
    {
      binding_id: `${roomId}_binding_A${suffix}`,
      room_actor_id: `${roomId}_actor_A`,
      original_seat: 'A',
      opaque_binding_token: `${TOKEN_A}${suffix}`
    },
    {
      binding_id: `${roomId}_binding_B${suffix}`,
      room_actor_id: `${roomId}_actor_B`,
      original_seat: 'B',
      opaque_binding_token: `${TOKEN_B}${suffix}`
    }
  ];
}

function snapshot(snapshotId, stateHash) {
  return {
    snapshot_id: snapshotId,
    state_hash: stateHash,
    snapshot_ciphertext: Buffer.from(`encrypted:${snapshotId}`),
    wrapped_data_key: Buffer.alloc(32, 0x31),
    nonce: Buffer.alloc(12, 0x32),
    auth_tag: Buffer.alloc(16, 0x33),
    master_key_version: 'snapshot_key_v1'
  };
}

function sourceImport({
  sourceImportId,
  roomId = ROOM_EXISTING,
  lineageId = 'lineage_existing',
  proposalId,
  derivedFromExportId = null,
  seed = sourceImportId
}) {
  return {
    schema: SOURCE_IMPORT_SCHEMA,
    source_import_id: sourceImportId,
    room_id: roomId,
    lineage_id: lineageId,
    origin_owner_user_id: USER_A,
    source_save_id: `save_${seed}`,
    client_save_instance_id: `instance_${seed}`,
    source_branch_id: `branch_${seed}`,
    source_node_id: `node_${seed}`,
    cloud_revision: `cloud_${seed}`,
    canonical_content_hash: HASH(`${seed}:canonical`),
    selected_state_hash: HASH(`${seed}:selected`),
    raw_source_hash: HASH(`${seed}:raw`),
    normalized_source_hash: HASH(`${seed}:normalized`),
    normalization_and_rebind_diff_hash: HASH(`${seed}:rebind`),
    genesis_state_hash: HASH(`${seed}:genesis`),
    privacy_normalizer_version: 'latest-source-privacy-v1',
    derived_from_export_id: derivedFromExportId,
    audience_diff_commitments: {
      A: HMAC(`${seed}:diff:A`),
      B: HMAC(`${seed}:diff:B`)
    },
    server_hmac_commitment: HMAC(`${seed}:server`),
    imported_at: '2026-08-22T02:00:00.000Z',
    proposal_id: proposalId
  };
}

function audienceDiff(source, proposalId, seat, summary) {
  return {
    schema: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
    proposal_id: proposalId,
    proposal_revision: 1,
    room_id: source.room_id,
    lineage_id: source.lineage_id,
    source_import_id: source.source_import_id,
    audience: seat,
    audience_user_id: seat === 'A' ? USER_A : USER_B,
    audience_role: seat === 'A' ? 'source_owner' : 'guest',
    sections: [{
      category: seat === 'A' ? 'tasks' : 'continuity_losses',
      entries: [{
        entry_id: `entry_${source.source_import_id}_${seat}`,
        kind: seat === 'A' ? 'result' : 'warning',
        summary
      }]
    }],
    projection_commitment: source.audience_diff_commitments[seat],
    server_hmac_commitment: HMAC(`${source.source_import_id}:diff-server:${seat}`)
  };
}

function importRequest(source, proposalId, derivedSummary = 'owner-only-source-change') {
  return {
    authenticated_user_id: USER_A,
    room_id: source.room_id,
    source_import: (({ proposal_id: ignored, ...contract }) => contract)(source),
    audience_diffs: {
      A: audienceDiff(source, proposalId, 'A', derivedSummary),
      B: audienceDiff(source, proposalId, 'B', 'guest-safe-continuity-loss')
    },
    actor_binding_matches: [
      { source_entity_id: 'latest_entity_owner', opaque_binding_token: TOKEN_A },
      { source_entity_id: 'latest_entity_guest', opaque_binding_token: TOKEN_B }
    ],
    validation_result: {
      valid: true,
      normalizer: 'latest-source-privacy-v1',
      private_namespaces_removed: true
    },
    source_snapshot_ref: `source_snapshot_ref_${source.source_import_id}`
  };
}

async function archiveRoom(repository, {
  roomId,
  checkpointId,
  proposalId,
  expectedControlRevision
}) {
  await repository.proposals.createArchive({
    authenticated_user_id: USER_A,
    room_id: roomId,
    proposal_id: proposalId,
    proposal_revision: 1,
    checkpoint_id: checkpointId,
    expected_control_revision: expectedControlRevision
  });
  await repository.proposals.accept({
    authenticated_user_id: USER_A,
    room_id: roomId,
    proposal_id: proposalId,
    proposal_revision: 1,
    expected_control_revision: expectedControlRevision
  });
  await repository.proposals.accept({
    authenticated_user_id: USER_B,
    room_id: roomId,
    proposal_id: proposalId,
    proposal_revision: 1,
    expected_control_revision: expectedControlRevision
  });
  return repository.proposals.applyArchive({
    authenticated_user_id: USER_B,
    room_id: roomId,
    proposal_id: proposalId,
    proposal_revision: 1,
    expected_control_revision: expectedControlRevision
  });
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-sqlite-lineage-'));
const databasePath = path.join(tempRoot, 'multiplayer.sqlite');
const connection = await openMultiplayerRepositoryTestSqlite({ databasePath });
const repository = createSqliteLineageRepository(connection, {
  idFactory: createIdFactory(),
  clock: createClock(),
  audienceDiffCodec: createEncryptedDiffCodec(),
  bindingSignatureSecret: Buffer.alloc(32, 0x44),
  proposalCommitmentSecret: Buffer.alloc(32, 0x55)
});

let exportA;
let exportB;
let resumed;
let latestSource;

try {
  await connection.write(database => {
    seedRoom(database, {
      roomId: ROOM_EXISTING,
      lineageId: 'lineage_existing',
      originType: 'existing_save_derived',
      stateHash: INITIAL_EXISTING_HASH
    });
    seedRoom(database, {
      roomId: ROOM_NEW,
      lineageId: 'lineage_new',
      originType: 'new_multiplayer_save',
      stateHash: INITIAL_NEW_HASH
    });
  });

  await test('binding pair is signed, bijective, idempotent and never stores plaintext tokens', async () => {
    const created = await repository.bindings.createPair({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      actor_bindings: bindingPair(ROOM_EXISTING)
    });
    assert.equal(created.replayed, false);
    assert.deepEqual(created.bindings.map(item => item.original_seat).sort(), ['A', 'B']);
    const replay = await repository.bindings.createPair({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      actor_bindings: bindingPair(ROOM_EXISTING)
    });
    assert.equal(replay.replayed, true);
    const rows = connection.read(database => database.prepare(`
      SELECT opaque_binding_token_hash, server_signature
        FROM room_actor_bindings WHERE room_id = ? ORDER BY original_seat_id
    `).all(ROOM_EXISTING));
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.opaque_binding_token_hash.startsWith('sha256:')));
    assert.ok(rows.every(row => Buffer.from(row.server_signature).byteLength === 32));
    assert.ok(!JSON.stringify(rows).includes(TOKEN_A));
    assert.ok(!JSON.stringify(rows).includes(TOKEN_B));
    await expectCode('ROOM_ACTOR_BINDING_NOT_BIJECTIVE', () => (
      repository.bindings.createPair({
        authenticated_user_id: USER_A,
        room_id: ROOM_NEW,
        actor_bindings: [
          bindingPair(ROOM_NEW, '_new')[0],
          { ...bindingPair(ROOM_NEW, '_new')[1], original_seat: 'A' }
        ]
      })
    ));
    await repository.bindings.createPair({
      authenticated_user_id: USER_A,
      room_id: ROOM_NEW,
      actor_bindings: bindingPair(ROOM_NEW, '_new')
    });
  });

  await test('A and B exports use member-scoped idempotency and isolated download metadata', async () => {
    exportA = await repository.personalExports.begin({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      checkpoint_id: `${ROOM_EXISTING}_checkpoint_0`,
      idempotency_key: 'same-export-key'
    });
    exportB = await repository.personalExports.begin({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      checkpoint_id: `${ROOM_EXISTING}_checkpoint_0`,
      idempotency_key: 'same-export-key'
    });
    assert.notEqual(exportA.export_id, exportB.export_id);
    assert.equal(exportA.exporting_seat, 'A');
    assert.equal(exportB.exporting_seat, 'B');
    await repository.personalExports.complete({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      export_id: exportA.export_id,
      output_hash: HASH('export-A'),
      output_ref: 'private-output-ref-A'
    });
    await repository.personalExports.complete({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      export_id: exportB.export_id,
      output_hash: HASH('export-B'),
      output_ref: 'private-output-ref-B'
    });
    assert.equal(repository.personalExports.getForDownload({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      export_id: exportA.export_id
    }).output_ref, 'private-output-ref-A');
    await expectCode('EXPORT_NOT_FOUND', () => repository.personalExports.getForDownload({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      export_id: exportA.export_id
    }));
    const replay = await repository.personalExports.begin({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      checkpoint_id: `${ROOM_EXISTING}_checkpoint_0`,
      idempotency_key: 'same-export-key'
    });
    assert.equal(replay.export_id, exportA.export_id);
    assert.equal(replay.replayed, true);
    await expectCode('IDEMPOTENCY_KEY_REUSED', () => repository.personalExports.begin({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      checkpoint_id: `${ROOM_EXISTING}_checkpoint_0`,
      output_format: 'different-format-v2',
      idempotency_key: 'same-export-key'
    }));
  });

  await test('new multiplayer save rejects playable export', async () => {
    await expectCode('PLAYABLE_EXPORT_NOT_ALLOWED', () => repository.personalExports.begin({
      authenticated_user_id: USER_A,
      room_id: ROOM_NEW,
      checkpoint_id: `${ROOM_NEW}_checkpoint_0`,
      idempotency_key: 'new-save-export'
    }));
  });

  const oldRowsBefore = connection.read(database => ({
    epoch: database.prepare(`SELECT * FROM room_epochs WHERE epoch_id = ?`)
      .get(`${ROOM_EXISTING}_epoch_1`),
    checkpoint: database.prepare(`SELECT * FROM room_checkpoints WHERE checkpoint_id = ?`)
      .get(`${ROOM_EXISTING}_checkpoint_0`)
  }));

  await test('archive needs the same revision from both members and applies atomically', async () => {
    await repository.proposals.createArchive({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_archive_1',
      proposal_revision: 1,
      checkpoint_id: `${ROOM_EXISTING}_checkpoint_0`,
      expected_control_revision: 0
    });
    await repository.proposals.accept({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_archive_1',
      proposal_revision: 1,
      expected_control_revision: 0
    });
    await expectCode('STALE_CONTROL_REVISION', () => repository.proposals.accept({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_archive_1',
      proposal_revision: 1,
      expected_control_revision: 99
    }));
    await expectCode('STALE_PROPOSAL_REVISION', () => repository.proposals.accept({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_archive_1',
      proposal_revision: 2,
      expected_control_revision: 0
    }));
    await repository.proposals.accept({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_archive_1',
      proposal_revision: 1,
      expected_control_revision: 0
    });
    const archived = await repository.proposals.applyArchive({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_archive_1',
      proposal_revision: 1,
      expected_control_revision: 0
    });
    assert.equal(archived.control_revision, 1);
    assert.equal(archived.archived_checkpoint_id, `${ROOM_EXISTING}_checkpoint_0`);
    const replay = await repository.proposals.applyArchive({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_archive_1',
      proposal_revision: 1,
      expected_control_revision: 0
    });
    assert.equal(replay.replayed, true);
    await expectCode('STALE_CONTROL_REVISION', () => repository.proposals.applyArchive({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_archive_1',
      proposal_revision: 1,
      expected_control_revision: 99
    }));
    const proposalReplay = await repository.proposals.createArchive({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_archive_1',
      proposal_revision: 1,
      checkpoint_id: `${ROOM_EXISTING}_checkpoint_0`,
      expected_control_revision: 0
    });
    assert.equal(proposalReplay.replayed, true);
    const room = connection.read(database => database.prepare(`
      SELECT lifecycle, active_epoch_id, control_revision
        FROM multiplayer_rooms WHERE room_id = ?
    `).get(ROOM_EXISTING));
    assert.deepEqual(room, {
      lifecycle: 'ARCHIVED',
      active_epoch_id: null,
      control_revision: 1
    });
  });

  await test('checkpoint resume creates a monotonic genesis with exactly the selected content hash', async () => {
    await repository.proposals.createCheckpointResume({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_resume_1',
      proposal_revision: 1,
      checkpoint_id: `${ROOM_EXISTING}_checkpoint_0`,
      expected_control_revision: 1
    });
    await repository.proposals.accept({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_resume_1',
      proposal_revision: 1,
      expected_control_revision: 1
    });
    await repository.proposals.accept({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_resume_1',
      proposal_revision: 1,
      expected_control_revision: 1
    });
    const request = {
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_resume_1',
      proposal_revision: 1,
      expected_control_revision: 1,
      new_epoch_id: 'epoch_resumed_2',
      new_genesis_checkpoint_id: 'checkpoint_resumed_2_0',
      snapshot: snapshot('snapshot_resumed_2_0', INITIAL_EXISTING_HASH)
    };
    const [first, replay] = await Promise.all([
      repository.proposals.activateContinuation(request),
      repository.proposals.activateContinuation(request)
    ]);
    resumed = first.replayed ? replay : first;
    assert.equal([first.replayed, replay.replayed].filter(Boolean).length, 1);
    assert.equal(resumed.epoch.epoch_no, 2);
    assert.equal(resumed.epoch.base.type, 'room_checkpoint');
    assert.equal(resumed.genesis_checkpoint.state_hash, INITIAL_EXISTING_HASH);
    assert.equal(resumed.genesis_checkpoint.state_revision, 1);
    assert.equal(resumed.control_revision, 2);
    assert.equal(connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM room_epochs
       WHERE room_id = ? AND epoch_state = 'ACTIVE'
    `).get(ROOM_EXISTING).count), 1);
    await expectCode('IDEMPOTENCY_KEY_REUSED', () => repository.proposals.activateContinuation({
      ...request,
      new_epoch_id: 'epoch_wrong_replay'
    }));
    await expectCode('IDEMPOTENCY_KEY_REUSED', () => repository.proposals.activateContinuation({
      ...request,
      expected_control_revision: 99
    }));
    await expectCode('IDEMPOTENCY_KEY_REUSED', () => repository.proposals.activateContinuation({
      ...request,
      snapshot: {
        ...request.snapshot,
        snapshot_ciphertext: Buffer.from('changed-encrypted-snapshot')
      }
    }));
    const proposalReplay = await repository.proposals.createCheckpointResume({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_resume_1',
      proposal_revision: 1,
      checkpoint_id: `${ROOM_EXISTING}_checkpoint_0`,
      expected_control_revision: 1
    });
    assert.equal(proposalReplay.replayed, true);
  });

  await test('old epoch and checkpoint rows remain unchanged after checkpoint continuation', async () => {
    const oldRowsAfter = connection.read(database => ({
      epoch: database.prepare(`SELECT * FROM room_epochs WHERE epoch_id = ?`)
        .get(`${ROOM_EXISTING}_epoch_1`),
      checkpoint: database.prepare(`SELECT * FROM room_checkpoints WHERE checkpoint_id = ?`)
        .get(`${ROOM_EXISTING}_checkpoint_0`)
    }));
    assert.deepEqual(oldRowsAfter, {
      epoch: {
        ...oldRowsBefore.epoch,
        control_revision: 1,
        epoch_state: 'ARCHIVED',
        archived_at: oldRowsAfter.epoch.archived_at
      },
      checkpoint: oldRowsBefore.checkpoint
    });
  });

  await test('new multiplayer save permits checkpoint resume but forbids latest-source proposal', async () => {
    await archiveRoom(repository, {
      roomId: ROOM_NEW,
      checkpointId: `${ROOM_NEW}_checkpoint_0`,
      proposalId: 'proposal_new_archive_1',
      expectedControlRevision: 0
    });
    await expectCode('CONTINUATION_MODE_NOT_ALLOWED', () => repository.proposals.createLatestSource({
      authenticated_user_id: USER_A,
      room_id: ROOM_NEW,
      proposal_id: 'proposal_new_latest_1',
      proposal_revision: 1,
      source_import_id: 'source_new_forbidden',
      expected_control_revision: 1
    }));
    const proposal = await repository.proposals.createCheckpointResume({
      authenticated_user_id: USER_A,
      room_id: ROOM_NEW,
      proposal_id: 'proposal_new_resume_1',
      proposal_revision: 1,
      checkpoint_id: `${ROOM_NEW}_checkpoint_0`,
      expected_control_revision: 1
    });
    assert.equal(proposal.proposal.proposal_type, 'resume_room_checkpoint');
  });

  await test('guest export cannot be imported as original Room latest source', async () => {
    await archiveRoom(repository, {
      roomId: ROOM_EXISTING,
      checkpointId: 'checkpoint_resumed_2_0',
      proposalId: 'proposal_archive_2',
      expectedControlRevision: 2
    });
    const proposalId = 'proposal_guest_source_1';
    const source = sourceImport({
      sourceImportId: 'source_guest_export_1',
      proposalId,
      derivedFromExportId: exportB.export_id
    });
    await expectCode('SOURCE_OWNER_REQUIRED', () => repository.sourceImports.saveValidated(
      importRequest(source, proposalId)
    ));
    assert.equal(connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM room_source_imports WHERE source_import_id = ?
    `).get(source.source_import_id).count), 0);
  });

  await test('only origin owner saves latest source and each member reads only its encrypted diff', async () => {
    const proposalId = 'proposal_latest_1';
    latestSource = sourceImport({
      sourceImportId: 'source_latest_1',
      proposalId
    });
    const request = importRequest(latestSource, proposalId, 'owner-private-task-summary');
    const guestRequest = { ...request, authenticated_user_id: USER_B };
    await expectCode('SOURCE_OWNER_REQUIRED', () => repository.sourceImports.saveValidated(guestRequest));
    const saved = await repository.sourceImports.saveValidated(request);
    assert.equal(saved.replayed, false);
    const stored = connection.read(database => database.prepare(`
      SELECT audience_diff_a_ciphertext, audience_diff_b_ciphertext,
             actor_rebind_json, actor_binding_set_hash
        FROM room_source_imports WHERE source_import_id = ?
    `).get(latestSource.source_import_id));
    assert.doesNotMatch(Buffer.from(stored.audience_diff_a_ciphertext).toString('utf8'), /owner-private/u);
    assert.doesNotMatch(Buffer.from(stored.audience_diff_b_ciphertext).toString('utf8'), /guest-safe/u);
    assert.ok(stored.actor_binding_set_hash.startsWith('sha256:'));
    const ownerView = repository.sourceImports.getForMember({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      source_import_id: latestSource.source_import_id
    });
    const guestView = repository.sourceImports.getForMember({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      source_import_id: latestSource.source_import_id
    });
    assert.equal(ownerView.audience_diff.audience, 'A');
    assert.match(JSON.stringify(ownerView.audience_diff), /owner-private-task-summary/u);
    assert.equal(guestView.audience_diff.audience, 'B');
    assert.match(JSON.stringify(guestView.audience_diff), /guest-safe-continuity-loss/u);
    assert.doesNotMatch(JSON.stringify(guestView), /owner-private|source_save_id|raw_source_hash/u);
    assert.ok(ownerView.source.source_save_id);
  });

  await test('latest-source acceptance binds each seat to its exact diff commitment', async () => {
    await repository.proposals.createLatestSource({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_latest_1',
      proposal_revision: 1,
      source_import_id: latestSource.source_import_id,
      expected_control_revision: 3
    });
    await expectCode('SOURCE_IMPORT_CHANGED', () => repository.proposals.accept({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_latest_1',
      proposal_revision: 1,
      expected_control_revision: 3,
      audience_diff_commitment: latestSource.audience_diff_commitments.B
    }));
    await repository.proposals.accept({
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_latest_1',
      proposal_revision: 1,
      expected_control_revision: 3,
      audience_diff_commitment: latestSource.audience_diff_commitments.A
    });
    await repository.proposals.accept({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_latest_1',
      proposal_revision: 1,
      expected_control_revision: 3,
      audience_diff_commitment: latestSource.audience_diff_commitments.B
    });
    assert.equal(repository.proposals.getForMember({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_latest_1'
    }).status, 'ACCEPTED');
  });

  await test('failed latest-source activation rolls back epoch, checkpoint, room and proposal', async () => {
    const request = {
      authenticated_user_id: USER_A,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_latest_1',
      proposal_revision: 1,
      expected_control_revision: 3,
      new_epoch_id: 'epoch_latest_3',
      new_genesis_checkpoint_id: 'checkpoint_latest_3_0',
      // This snapshot ID already belongs to the resumed epoch. The unique
      // violation occurs after the new epoch/checkpoint inserts and proves
      // BEGIN IMMEDIATE rolls the entire activation back.
      snapshot: snapshot('snapshot_resumed_2_0', latestSource.genesis_state_hash)
    };
    await assert.rejects(() => repository.proposals.activateContinuation(request), error => (
      String(error?.code || '').startsWith('SQLITE_CONSTRAINT')
      || (error?.code === 'ERR_SQLITE_ERROR'
        && /UNIQUE constraint failed: room_snapshots\.snapshot_id/u.test(error.message))
    ));
    const state = connection.read(database => ({
      room: database.prepare(`
        SELECT lifecycle, active_epoch_id, state_revision, control_revision
          FROM multiplayer_rooms WHERE room_id = ?
      `).get(ROOM_EXISTING),
      proposal: database.prepare(`
        SELECT proposal_status, applied_at FROM room_control_proposals WHERE proposal_id = ?
      `).get('proposal_latest_1'),
      epochCount: database.prepare(`SELECT COUNT(*) AS count FROM room_epochs WHERE epoch_id = ?`)
        .get('epoch_latest_3').count,
      checkpointCount: database.prepare(`
        SELECT COUNT(*) AS count FROM room_checkpoints WHERE checkpoint_id = ?
      `).get('checkpoint_latest_3_0').count
    }));
    assert.deepEqual(state.room, {
      lifecycle: 'ARCHIVED',
      active_epoch_id: null,
      state_revision: 1,
      control_revision: 3
    });
    assert.deepEqual(state.proposal, { proposal_status: 'ACCEPTED', applied_at: null });
    assert.equal(state.epochCount, 0);
    assert.equal(state.checkpointCount, 0);
  });

  await test('latest-source retry atomically activates one epoch with verified actor rebind', async () => {
    const request = {
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING,
      proposal_id: 'proposal_latest_1',
      proposal_revision: 1,
      expected_control_revision: 3,
      new_epoch_id: 'epoch_latest_3',
      new_genesis_checkpoint_id: 'checkpoint_latest_3_0',
      snapshot: snapshot('snapshot_latest_3_0', latestSource.genesis_state_hash)
    };
    const [first, second] = await Promise.all([
      repository.proposals.activateContinuation(request),
      repository.proposals.activateContinuation(request)
    ]);
    const activated = first.replayed ? second : first;
    assert.equal([first.replayed, second.replayed].filter(Boolean).length, 1);
    assert.equal(activated.epoch.base.type, 'latest_source_import');
    assert.equal(activated.epoch.base.ref_id, latestSource.source_import_id);
    assert.equal(activated.genesis_checkpoint.state_hash, latestSource.genesis_state_hash);
    assert.equal(activated.genesis_checkpoint.state_revision, 2);
    assert.equal(activated.control_revision, 4);
    const sourceReplay = await repository.sourceImports.saveValidated(
      importRequest(latestSource, 'proposal_latest_1', 'owner-private-task-summary')
    );
    assert.equal(sourceReplay.replayed, true);
    const counts = connection.read(database => ({
      active: database.prepare(`
        SELECT COUNT(*) AS count FROM room_epochs
         WHERE room_id = ? AND epoch_state = 'ACTIVE'
      `).get(ROOM_EXISTING).count,
      proposalEpoch: database.prepare(`
        SELECT COUNT(*) AS count FROM room_epochs WHERE created_from_proposal_id = ?
      `).get('proposal_latest_1').count,
      bindings: database.prepare(`
        SELECT COUNT(*) AS count FROM room_actor_bindings WHERE room_id = ?
      `).get(ROOM_EXISTING).count
    }));
    assert.deepEqual(counts, { active: 1, proposalEpoch: 1, bindings: 2 });
  });

  await test('lineage member projection omits internal hashes and preserves all immutable nodes', async () => {
    const view = repository.lineage.getForMember({
      authenticated_user_id: USER_B,
      room_id: ROOM_EXISTING
    });
    assert.equal(view.epochs.length, 3);
    assert.equal(view.checkpoints.length, 3);
    assert.equal(view.actor_bindings.length, 2);
    assert.doesNotMatch(
      JSON.stringify(view),
      /base_state_hash|state_hash|snapshot_ref|opaque_binding_token|server_signature/u
    );
    const sourceImportSchema = connection.read(database => {
      const columns = database.prepare(`PRAGMA table_info('room_source_imports')`).all();
      const uniqueIndexes = database.prepare(`PRAGMA index_list('room_source_imports')`).all()
        .filter(index => index.unique === 1)
        .map(index => database.prepare(`PRAGMA index_info('${index.name}')`).all()
          .map(column => column.name));
      return { columns, uniqueIndexes };
    });
    assert.equal(
      sourceImportSchema.columns.find(column => column.name === 'room_id').notnull,
      1
    );
    assert.ok(sourceImportSchema.uniqueIndexes.some(columns => (
      columns.join(',') === [
        'room_id',
        'source_save_id',
        'client_save_instance_id',
        'source_branch_id',
        'source_node_id',
        'canonical_content_hash'
      ].join(',')
    )));
    assert.equal(connection.read(database => database.pragma('foreign_key_check').length), 0);
  });
} finally {
  await connection.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer SQLite lineage repository regression: ${passed} passed`);
