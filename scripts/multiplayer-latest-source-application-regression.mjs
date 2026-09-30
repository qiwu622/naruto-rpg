import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMultiplayerRuntime } from '../server/multiplayer/application/runtime.js';
import { createControlWorkflowServices } from '../server/multiplayer/application/control-workflow-service.js';
import {
  GUEST_CHARACTER_IMPORT_SCHEMA
} from '../server/multiplayer/application/genesis-state.js';
import {
  createCompositeSaveImportService,
  createLatestSourceImportService,
  materializeLatestSourceBasis
} from '../server/multiplayer/application/latest-source-import-service.js';
import {
  createMultiplayerToSingleplayerCodec
} from '../server/multiplayer/application/multiplayer-to-singleplayer-codec.js';
import {
  createPersonalExportSourceTimelineReader
} from '../server/multiplayer/application/personal-export-source-timeline-reader.js';
import {
  createPersonalSingleplayerExportService
} from '../server/multiplayer/application/personal-singleplayer-export-service.js';
import {
  createContinuationSnapshotPreparer
} from '../server/multiplayer/application/snapshot-service.js';
import {
  canonicalStringify,
  sha256Hex
} from '../server/multiplayer/domain/canonical-json.js';
import { roomCheckpointStateHash } from '../server/multiplayer/domain/lineage.js';
import {
  MULTIPLAYER_HTTP_ROUTE_SPECS,
  requestContext
} from '../server/multiplayer/http/router.js';
import {
  createInMemoryPersonalExportOutputStore
} from '../server/multiplayer/persistence/personal-export-output-store.js';
import {
  createSqliteLatestSourceSnapshotStore
} from '../server/multiplayer/persistence/sqlite-latest-source-snapshot-store.js';
import {
  createSqlitePersonalExportSourceRepository
} from '../server/multiplayer/persistence/sqlite-personal-export-source-repository.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const key = label => createHash('sha256').update(label).digest('base64');
const hash = value => `sha256:${sha256Hex(canonicalStringify(value))}`;
const OWNER = 'source_owner';
const GUEST = 'guest_user';
const CONTENT_SECRET = key('latest-content');
const BINDING_SECRET = key('latest-binding');
const PROPOSAL_SECRET = key('latest-proposal');
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-latest-source-'));

function originState() {
  return {
    _version: '5.0',
    _meta: { current_node_id: 'node_origin', active_branch: 'branch_origin' },
    '玩家·姓名': '来源角色',
    '玩家·正式忍阶': '中忍',
    '玩家·当前目标': '守护同伴',
    '玩家·出身': '木叶隐村',
    '属性·查克拉': 80,
    '属性·当前查克拉': 75,
    '属性·精神力': 70,
    '属性·当前精神力': 65,
    '属性·体力': 90,
    '属性·当前体力': 88,
    '属性·生命力': 100,
    '属性·当前生命力': 100,
    '进度·等级': 10,
    '进度·经验': 200,
    '世界·年代': '木叶48年',
    '世界·时间': '木叶48年冬',
    '世界·地点': '木叶村'
  };
}

function originGuestCharacter() {
  return {
    schema: GUEST_CHARACTER_IMPORT_SCHEMA,
    state_snapshot: {
      _version: '5.0',
      '玩家·姓名': '客方角色',
      '玩家·正式忍阶': '下忍',
      '玩家·当前目标': '与来源角色并肩作战',
      '玩家·出身': 'C10-only-guest-secret',
      '属性·查克拉': 60,
      '属性·当前查克拉': 60,
      '属性·精神力': 50,
      '属性·当前精神力': 50,
      '属性·体力': 75,
      '属性·当前体力': 75,
      '属性·生命力': 100,
      '属性·当前生命力': 100,
      '进度·等级': 6,
      '进度·经验': 120,
      _memory: { facts: 'C10-hidden-memory' }
    }
  };
}

function sourceTimeline(snapshot = originState()) {
  return {
    export_version: '2.0',
    exported_at: '2026-08-23T01:00:00.000Z',
    include_archive: false,
    nodes: [{
      id: 'node_origin',
      parent_id: null,
      children_ids: [],
      branch_id: 'branch_origin',
      turn_number: 0,
      depth: 0,
      player_input: '来源起点',
      clean_response: '来源起点正文',
      state_snapshot: snapshot
    }],
    branches: [{
      id: 'branch_origin',
      name: '来源主线',
      color: '#eb613f',
      head_node_id: 'node_origin',
      node_count: 1,
      is_active: true,
      diverged_from: null
    }],
    meta: {
      key: 'root',
      value: {
        root_id: 'node_origin',
        current_id: 'node_origin',
        active_branch: 'branch_origin',
        total_nodes: 1
      }
    }
  };
}

function appendSoloL2(exported) {
  const value = structuredClone(exported);
  value.multiplayer_record_sidecar.server_reimport_capsule
    .projection_basis.actors.B.private_knowledge = {
      seat: 'B',
      facts: ['L2-uploaded-guest-private']
    };
  value.multiplayer_record_sidecar.server_reimport_capsule
    .projection_basis.memories['actor:B'] = {
      entries: [{ memory_id: 'memory_l2_guest_private', text: 'L2-hidden-memory' }]
    };
  const meta = value.meta.value;
  const branch = value.branches.find(item => item.id === meta.active_branch);
  const previous = value.nodes.find(item => item.id === meta.current_id);
  const node = structuredClone(previous);
  node.id = 'node_solo_l2';
  node.parent_id = previous.id;
  node.children_ids = [];
  node.turn_number = previous.turn_number + 1;
  node.depth = previous.depth + 1;
  node.real_timestamp = Date.parse('2026-08-23T03:00:00.000Z');
  node.created_at = node.real_timestamp;
  node.player_input = '来源所有者独自修行，客方同伴在战斗中牺牲。';
  node.clean_response = '单机分支推进到 L2。';
  node.ai_response_summary = '单机分支推进到 L2。';
  node.summary = '单机分支推进到 L2。';
  node.game_time = '木叶49年春';
  node.state_snapshot._meta.current_node_id = node.id;
  node.state_snapshot._meta.active_branch = branch.id;
  node.state_snapshot['玩家·姓名'] = '来源者-L2';
  node.state_snapshot['玩家·当前目标'] = '守护新的同伴';
  node.state_snapshot['进度·经验'] = 321;
  node.state_snapshot['世界·时间'] = '木叶49年春';
  node.state_snapshot['技能·忍术·影分身之术·名称'] = '影分身之术';
  node.state_snapshot['技能·忍术·影分身之术·等级'] = 'B';
  node.state_snapshot['技能·忍术·影分身之术·熟练度'] = 64;
  node.state_snapshot['技能·忍术·影分身之术·数据库ID'] = 'jutsu:kage_bunshin';
  node.state_snapshot['物品·消耗品·兵粮丸·数量'] = 3;
  node.state_snapshot['物品·消耗品·兵粮丸·描述'] = '规范引用：item:soldier_pill';
  node.state_snapshot['物品·装备·雷光短刀·数量'] = 1;
  node.state_snapshot['物品·装备·雷光短刀·描述'] = '规范引用：item:lightning_blade';
  node.state_snapshot['物品·已装备·武器'] = '雷光短刀';
  const relationships = node.state_snapshot._relationships;
  const oldName = Object.keys(relationships)[0];
  const companion = relationships[oldName];
  delete relationships[oldName];
  companion.multiplayer_companion.alive = false;
  companion.multiplayer_companion.status = 'DECEASED';
  companion.multiplayer_companion.observed_injuries = [{
    injury_id: 'injury:l2_final',
    version: 1,
    label: '致命伤',
    severity: 5,
    active: true
  }];
  relationships['客方角色-L2'] = companion;
  previous.children_ids = [...new Set([...(previous.children_ids ?? []), node.id])];
  value.nodes.push(node);
  branch.head_node_id = node.id;
  branch.node_count += 1;
  value.branches.forEach(item => { item.is_active = item.id === branch.id; });
  meta.current_id = node.id;
  meta.active_branch = branch.id;
  meta.total_nodes = value.nodes.length;
  value.exported_at = '2026-08-23T03:00:00.000Z';
  return value;
}

const runtime = await createMultiplayerRuntime({
  databasePath: path.join(tempRoot, 'multiplayer.sqlite'),
  keyVersion: 'v1',
  contentMasterKey: CONTENT_SECRET,
  credentialMasterKey: key('latest-credential'),
  credentialFingerprintKey: key('latest-fingerprint'),
  actionCommitmentSecret: key('latest-action'),
  lineageSigningSecret: BINDING_SECRET,
  proposalCommitmentSecret: PROPOSAL_SECRET
}, {
  startDispatcher: false,
  openConnection: openMultiplayerRepositoryTestSqlite
});

try {
  const importedState = originState();
  const staged = await runtime.services.saveImports.create({
    authenticated_user_id: OWNER,
    request: {
      source_save_id: 'save_owner',
      client_save_instance_id: 'client_owner',
      source_branch_id: 'branch_origin',
      source_node_id: 'node_origin',
      state: importedState,
      source_timeline: sourceTimeline(),
      idempotency_key: 'origin-stage'
    }
  });
  const created = await runtime.services.rooms.create({
    authenticated_user_id: OWNER,
    request: {
      origin_type: 'existing_save_derived',
      source_import_id: staged.import.import_id,
      default_narrative_mode: 'shared'
    }
  });
  const roomId = created.room.room_id;
  await runtime.services.rooms.join({
    authenticated_user_id: GUEST,
    room_id: roomId,
    request: {
      token: created.invite.token,
      guest_character: originGuestCharacter()
    }
  });
  for (const user of [OWNER, GUEST]) {
    const room = await runtime.services.rooms.get({
      authenticated_user_id: user,
      room_id: roomId
    });
    await runtime.services.rooms.ready({
      authenticated_user_id: user,
      room_id: roomId,
      request: {
        expected_control_revision: room.control_revision,
        proposal_revision: room.genesis_review.proposal_revision,
        audience_diff_commitment: room.genesis_review.audience_diff_commitment
      }
    });
  }

  const beforeArchive = runtime.repositories.core.rooms.getForMember({
    authenticated_user_id: OWNER,
    room_id: roomId
  });
  const firstEpoch = runtime.repositories.lineage.lineage.getForMember({
    authenticated_user_id: OWNER,
    room_id: roomId
  }).epochs[0];
  const oldRowsBefore = runtime.connection.read(database => ({
    epoch: database.prepare(`SELECT * FROM room_epochs WHERE epoch_id = ?`).get(firstEpoch.epoch_id),
    checkpoint: database.prepare(`SELECT * FROM room_checkpoints WHERE checkpoint_id = ?`)
      .get(firstEpoch.head_checkpoint_id)
  }));
  await runtime.repositories.lineage.proposals.createArchive({
    authenticated_user_id: OWNER,
    room_id: roomId,
    proposal_id: 'proposal_archive_latest',
    proposal_revision: 1,
    checkpoint_id: firstEpoch.head_checkpoint_id,
    expected_control_revision: beforeArchive.control_revision
  });
  for (const user of [OWNER, GUEST]) {
    await runtime.services.lineage.acceptArchiveProposal({
      authenticated_user_id: user,
      room_id: roomId,
      proposal_id: 'proposal_archive_latest',
      request: {
        proposal_revision: 1,
        expected_control_revision: beforeArchive.control_revision
      }
    });
  }

  const codec = createMultiplayerToSingleplayerCodec();
  const outputStore = createInMemoryPersonalExportOutputStore();
  const exportSourceRepository = createSqlitePersonalExportSourceRepository(
    runtime.connection,
    { narrativeContentCodec: { openJson() { throw new Error('genesis export has no narrative'); } } }
  );
  const sourceTimelineReader = createPersonalExportSourceTimelineReader({
    saveImportRepository: runtime.repositories.saveImports
  });
  const personalExport = createPersonalSingleplayerExportService({
    lineageRepository: runtime.repositories.lineage,
    coreRepositories: runtime.repositories.core,
    snapshotService: runtime.services.snapshots,
    exportSourceRepository,
    sourceTimelineReader,
    outputStore,
    codec,
    bindingTokenSecret: BINDING_SECRET
  });
  const begun = await personalExport.beginSinglePlayerExport({
    authenticated_user_id: OWNER,
    room_id: roomId,
    checkpoint_id: firstEpoch.head_checkpoint_id,
    request: { idempotency_key: 'owner-c10-export' }
  });
  const downloaded = await personalExport.downloadSinglePlayerExport({
    authenticated_user_id: OWNER,
    room_id: roomId,
    export_id: begun.export.export_id
  });
  await test('production export remains a valid singleplayer timeline with a non-Agent privacy-safe reimport capsule', async () => {
    assert.equal(
      downloaded.content.multiplayer_record_sidecar.server_reimport_capsule.inject_to_agent,
      false
    );
    assert.doesNotMatch(
      canonicalStringify(downloaded.content.multiplayer_record_sidecar.server_reimport_capsule),
      /C10-only|C10-hidden/u
    );
    assert.equal(
      canonicalStringify({
        nodes: downloaded.content.nodes,
        branches: downloaded.content.branches,
        meta: downloaded.content.meta
      }).includes('server_reimport_capsule'),
      false
    );
  });
  const l2 = appendSoloL2(downloaded.content);
  await codec.assertOutput(l2, {
    export_id: begun.export.export_id,
    room_id: roomId,
    exporting_seat: 'A'
  });

  const latestSnapshotStore = createSqliteLatestSourceSnapshotStore(runtime.connection, {
    contentCodec: runtime.codecs.actionContentCodec
  });
  const latestImports = createLatestSourceImportService({
    lineageRepository: runtime.repositories.lineage,
    snapshotStore: latestSnapshotStore,
    codec,
    commitmentSecret: PROPOSAL_SECRET
  });
  const saveImports = createCompositeSaveImportService({
    genesisSaveImports: runtime.services.saveImports,
    latestSourceImports: latestImports
  });
  const latestRequest = {
    import_kind: 'latest_source_continuation',
    proposal_id: 'proposal_latest_l2',
    proposal_revision: 1,
    source_save_id: 'save_owner',
    client_save_instance_id: 'client_owner',
    source_branch_id: l2.meta.value.active_branch,
    source_node_id: l2.meta.value.current_id,
    cloud_revision: 'cloud-l2',
    source_document: l2,
    idempotency_key: 'latest-l2-import'
  };
  await test('HTTP save-import boundary treats timeline payload as data while still rejecting top-level authority', async () => {
    const spec = MULTIPLAYER_HTTP_ROUTE_SPECS.find(item => item.operation === 'createSaveImport');
    const context = requestContext({
      user: { id: OWNER },
      body: latestRequest,
      query: {},
      params: {}
    }, spec);
    assert.equal(context.authenticated_user_id, OWNER);
    assert.equal(context.request.source_document.multiplayer_export.room_id, roomId);
    assert.throws(
      () => requestContext({
        user: { id: OWNER },
        body: { ...latestRequest, room_id: roomId },
        query: {},
        params: {}
      }, spec),
      error => error?.code === 'CLIENT_AUTHORITY_FIELD_FORBIDDEN'
    );
  });
  let imported;
  await test('generic save-import authenticates the source-owner export and persists one immutable L2 basis', async () => {
    const [first, duplicate] = await Promise.all([
      saveImports.create({ authenticated_user_id: OWNER, request: latestRequest }),
      saveImports.create({ authenticated_user_id: OWNER, request: latestRequest })
    ]);
    imported = first;
    assert.equal(first.import.source_import_id, duplicate.import.source_import_id);
    const replay = await saveImports.create({ authenticated_user_id: OWNER, request: latestRequest });
    assert.equal(replay.replayed, true);
    await assert.rejects(
      saveImports.create({
        authenticated_user_id: OWNER,
        request: { ...latestRequest, source_node_id: 'node_different' }
      }),
      error => ['SOURCE_IMPORT_CHANGED', 'IDEMPOTENCY_KEY_REUSED'].includes(error?.code)
    );
    await assert.rejects(
      saveImports.create({ authenticated_user_id: GUEST, request: latestRequest }),
      error => error?.code === 'SOURCE_OWNER_REQUIRED'
    );
    const counts = runtime.connection.read(database => ({
      imports: database.prepare(`SELECT COUNT(*) AS count FROM room_source_imports`).get().count,
      snapshots: database.prepare(`SELECT COUNT(*) AS count FROM latest_source_snapshots`).get().count
    }));
    assert.deepEqual(counts, { imports: 1, snapshots: 1 });
  });

  await test('raw, normalized, rebind and genesis hashes close without restoring C10 guest secrets', async () => {
    const sourceRow = runtime.connection.read(database => database.prepare(`
      SELECT * FROM room_source_imports WHERE source_import_id = ?
    `).get(imported.import.source_import_id));
    const authority = runtime.repositories.lineage.bindings.resolveLatestSourcePair({
      authenticated_user_id: OWNER,
      room_id: roomId,
      lineage_id: created.room.lineage_id,
      checkpoint_id: firstEpoch.head_checkpoint_id,
      derived_from_export_id: begun.export.export_id,
      exporting_seat: 'A',
      actor_binding_matches: l2.multiplayer_record_sidecar.actor_bindings.map(entry => ({
        source_entity_id: entry.source_entity_id,
        opaque_binding_token: entry.opaque_binding_token
      }))
    });
    const selected = l2.nodes.find(node => node.id === latestRequest.source_node_id);
    const basis = materializeLatestSourceBasis(l2, selected, authority);
    assert.equal(sourceRow.raw_source_hash, hash(l2));
    assert.equal(sourceRow.normalized_source_hash, basis.normalized_source_hash);
    assert.equal(
      sourceRow.normalization_and_rebind_diff_hash,
      basis.normalization_and_rebind_diff_hash
    );
    assert.equal(sourceRow.genesis_state_hash, basis.genesis_state_hash);
    assert.doesNotMatch(
      canonicalStringify(basis.genesis_room_state),
      /C10-only|C10-hidden|L2-uploaded-guest-private|L2-hidden-memory/u
    );
    assert.equal(basis.genesis_room_state.actors.A.player.display_name, '来源者-L2');
    assert.equal(basis.genesis_room_state.actors.B.player.display_name, '客方角色-L2');
    assert.equal(basis.genesis_room_state.actors.B.player.status, 'DECEASED');
    assert.equal(basis.genesis_room_state.actors.B.attributes.injuries[0].label, '致命伤');
  });

  await test('member lineage projection exposes only each encrypted audience diff', async () => {
    const ownerView = runtime.repositories.lineage.lineage.getForMember({
      authenticated_user_id: OWNER,
      room_id: roomId
    });
    const guestView = runtime.repositories.lineage.lineage.getForMember({
      authenticated_user_id: GUEST,
      room_id: roomId
    });
    assert.equal(ownerView.source_imports[0].audience_diff.audience, 'A');
    assert.equal(guestView.source_imports[0].audience_diff.audience, 'B');
    assert.ok(ownerView.source_imports[0].source.source_save_id);
    assert.equal(guestView.source_imports[0].source, undefined);
    assert.doesNotMatch(JSON.stringify(guestView), /raw_source_hash|normalized_source_hash|C10-hidden/u);
  });

  await runtime.repositories.lineage.proposals.createLatestSource({
    authenticated_user_id: OWNER,
    room_id: roomId,
    proposal_id: latestRequest.proposal_id,
    proposal_revision: latestRequest.proposal_revision,
    source_import_id: imported.import.source_import_id,
    expected_control_revision: imported.import.expected_control_revision
  });
  const continuationSnapshot = createContinuationSnapshotPreparer({
    connection: runtime.connection,
    snapshotService: runtime.services.snapshots,
    saveImportRepository: runtime.repositories.saveImports,
    readLatestSourceState: context => latestSnapshotStore.readLatestSourceState(context)
  });
  const workflows = createControlWorkflowServices({
    coreRepositories: runtime.repositories.core,
    billingRepository: runtime.repositories.billing,
    lineageRepository: runtime.repositories.lineage,
    turnWorkflowRepository: runtime.repositories.turnWorkflows,
    prepareContinuationSnapshot: continuationSnapshot
  });
  const ownerDiff = runtime.repositories.lineage.sourceImports.getForMember({
    authenticated_user_id: OWNER,
    room_id: roomId,
    source_import_id: imported.import.source_import_id
  });
  const guestDiff = runtime.repositories.lineage.sourceImports.getForMember({
    authenticated_user_id: GUEST,
    room_id: roomId,
    source_import_id: imported.import.source_import_id
  });
  await workflows.lineage.acceptContinuationProposal({
    authenticated_user_id: OWNER,
    room_id: roomId,
    proposal_id: latestRequest.proposal_id,
    request: {
      proposal_revision: 1,
      expected_control_revision: imported.import.expected_control_revision,
      audience_diff_commitment: ownerDiff.audience_diff_commitment
    }
  });
  let activated;
  await test('proposal acceptance concurrency creates one new epoch from normalized L2 plus control rebind', async () => {
    const context = {
      authenticated_user_id: GUEST,
      room_id: roomId,
      proposal_id: latestRequest.proposal_id,
      request: {
        proposal_revision: 1,
        expected_control_revision: imported.import.expected_control_revision,
        audience_diff_commitment: guestDiff.audience_diff_commitment
      }
    };
    const results = await Promise.all([
      workflows.lineage.acceptContinuationProposal(context),
      workflows.lineage.acceptContinuationProposal(context)
    ]);
    activated = results[0];
    assert.equal(results[0].activation.epoch.epoch_id, results[1].activation.epoch.epoch_id);
    const epochs = runtime.connection.read(database => database.prepare(`
      SELECT * FROM room_epochs WHERE room_id = ? ORDER BY epoch_no
    `).all(roomId));
    assert.equal(epochs.length, 2);
    assert.equal(epochs.filter(epoch => epoch.epoch_state === 'ACTIVE').length, 1);
    assert.equal(epochs[1].base_type, 'latest_source_import');
    const snapshot = runtime.services.snapshots.readInternal({
      room_id: roomId,
      checkpoint_id: activated.activation.genesis_checkpoint.checkpoint_id
    });
    assert.equal(snapshot.state_hash, activated.activation.genesis_checkpoint.state_hash);
    assert.equal(
      roomCheckpointStateHash(snapshot.state, {
        A: snapshot.state.actors.A.room_actor_id,
        B: snapshot.state.actors.B.room_actor_id
      }),
      activated.activation.genesis_checkpoint.state_hash
    );
    assert.equal(snapshot.state.actors.A.player.display_name, '来源者-L2');
    const importedSkill = snapshot.state.actors.A.skills.entries.find(skill => (
      skill.display_name === '影分身之术'
    ));
    assert.ok(importedSkill);
    assert.match(importedSkill.skill_id, /^skill:import_[a-f0-9]{32}$/u);
    assert.deepEqual({ ...importedSkill, skill_id: undefined }, {
      skill_id: undefined,
      version: 1,
      display_name: '影分身之术',
      category: 'NINJUTSU',
      rank: 'B',
      mastery: 64,
      canonical_ref: 'jutsu:kage_bunshin'
    });
    const importedConsumable = snapshot.state.actors.A.equipment.entries.find(item => (
      item.display_name === '兵粮丸'
    ));
    assert.ok(importedConsumable);
    assert.match(importedConsumable.item_id, /^item:import_[a-f0-9]{32}$/u);
    assert.deepEqual({ ...importedConsumable, item_id: undefined }, {
      item_id: undefined,
      version: 1,
      display_name: '兵粮丸',
      category: 'CONSUMABLE',
      quantity: 3,
      canonical_ref: 'item:soldier_pill',
      equipped_slot: null
    });
    const importedWeapon = snapshot.state.actors.A.equipment.entries.find(item => (
      item.display_name === '雷光短刀'
    ));
    assert.ok(importedWeapon);
    assert.equal(importedWeapon.quantity, 1);
    assert.equal(importedWeapon.canonical_ref, 'item:lightning_blade');
    assert.equal(importedWeapon.equipped_slot, 'weapon');
    assert.equal(snapshot.state.actors.B.player.status, 'DECEASED');
    assert.doesNotMatch(
      canonicalStringify(snapshot.state),
      /C10-only|C10-hidden|L2-uploaded-guest-private|L2-hidden-memory/u
    );
  });

  await test('latest-source activation leaves every prior epoch/checkpoint immutable', async () => {
    const oldRowsAfter = runtime.connection.read(database => ({
      epoch: database.prepare(`SELECT * FROM room_epochs WHERE epoch_id = ?`).get(firstEpoch.epoch_id),
      checkpoint: database.prepare(`SELECT * FROM room_checkpoints WHERE checkpoint_id = ?`)
        .get(firstEpoch.head_checkpoint_id)
    }));
    assert.deepEqual(oldRowsAfter.checkpoint, oldRowsBefore.checkpoint);
    assert.equal(oldRowsAfter.epoch.epoch_id, oldRowsBefore.epoch.epoch_id);
    assert.equal(oldRowsAfter.epoch.base_state_hash, oldRowsBefore.epoch.base_state_hash);
    assert.equal(oldRowsAfter.epoch.head_checkpoint_id, oldRowsBefore.epoch.head_checkpoint_id);
    assert.equal(oldRowsAfter.epoch.epoch_state, 'ARCHIVED');
  });

  await test('latest-source storage supplies the authenticated L2 timeline to later owner exports only', async () => {
    const sourceRow = runtime.connection.read(database => database.prepare(`
      SELECT source_snapshot_ref FROM room_source_imports WHERE source_import_id = ?
    `).get(imported.import.source_import_id));
    const ownerTimeline = await latestSnapshotStore.getSourceTimelineForRoom({
      authenticated_user_id: OWNER,
      room_id: roomId,
      source_import_id: imported.import.source_import_id,
      source_snapshot_ref: sourceRow.source_snapshot_ref
    });
    assert.equal(ownerTimeline.source_node_id, 'node_solo_l2');
    assert.equal(ownerTimeline.timeline.meta.value.current_id, 'node_solo_l2');
    await assert.rejects(
      latestSnapshotStore.getSourceTimelineForRoom({
        authenticated_user_id: GUEST,
        room_id: roomId,
        source_import_id: imported.import.source_import_id,
        source_snapshot_ref: sourceRow.source_snapshot_ref
      }),
      error => error?.code === 'SOURCE_OWNER_REQUIRED'
    );
  });
} finally {
  await runtime.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer latest-source application regression: ${passed} passed`);
