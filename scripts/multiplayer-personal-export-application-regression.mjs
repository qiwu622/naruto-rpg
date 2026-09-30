import assert from 'node:assert/strict';

import { assertTimelineSave } from '../js/core/timeline-save-schema.js';
import {
  IMPORTED_PRIVATE_RELATIONSHIPS_SCHEMA,
  createNewMultiplayerGenesisState
} from '../server/multiplayer/application/genesis-state.js';
import {
  deterministicRoomActorBindingMaterial
} from '../server/multiplayer/application/room-application-service.js';
import {
  createMultiplayerToSingleplayerCodec
} from '../server/multiplayer/application/multiplayer-to-singleplayer-codec.js';
import {
  createPersonalSingleplayerExportService
} from '../server/multiplayer/application/personal-singleplayer-export-service.js';
import {
  ROOM_ACTOR_BINDING_SCHEMA,
  ROOM_CHECKPOINT_SCHEMA
} from '../server/multiplayer/contracts/lineage-contracts.js';
import {
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from '../server/multiplayer/domain/canonical-json.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import { assertReducerDomainState } from '../server/multiplayer/domain/reducers/index.js';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function fail(code, message, status = 400) {
  throw new DomainError(code, message, {}, { status });
}

const at = '2026-08-22T10:00:00.000Z';
const bindingSecret = 'personal-export-binding-secret';
const usersBySeat = Object.freeze({ A: 'source_owner', B: 'guest_user' });
const room = Object.freeze({
  room_id: 'room_export',
  origin_type: 'existing_save_derived',
  lineage_id: 'lineage_export',
  origin_owner_user_id: usersBySeat.A,
  origin_snapshot_id: 'import_origin',
  host_user_id: usersBySeat.A
});

function hash(label) {
  return `sha256:${sha256Hex(label)}`;
}

function checkpoint({ id, turnNo, parentId = null, turnId = null, revision, hour }) {
  const genesis = turnNo === 0;
  return Object.freeze({
    schema: ROOM_CHECKPOINT_SCHEMA,
    checkpoint_id: id,
    room_id: room.room_id,
    lineage_id: room.lineage_id,
    epoch_id: 'epoch_export',
    turn_no: turnNo,
    kind: genesis ? 'genesis' : 'turn_commit',
    parent_checkpoint_id: parentId,
    turn_id: turnId,
    commit_id: genesis ? null : `commit_${turnNo}`,
    state_revision: revision,
    state_hash: hash(`state-${revision}`),
    snapshot_ref: `snapshot_${revision}`,
    created_at: `2026-08-22T${String(hour).padStart(2, '0')}:00:00.000Z`
  });
}

const checkpoints = Object.freeze([
  checkpoint({ id: 'checkpoint_c0', turnNo: 0, revision: 0, hour: 10 }),
  checkpoint({
    id: 'checkpoint_c1',
    turnNo: 1,
    parentId: 'checkpoint_c0',
    turnId: 'turn_shared',
    revision: 1,
    hour: 11
  }),
  checkpoint({
    id: 'checkpoint_c2',
    turnNo: 2,
    parentId: 'checkpoint_c1',
    turnId: 'turn_dual',
    revision: 2,
    hour: 12
  })
]);

function roomState(revision) {
  const value = structuredClone(createNewMultiplayerGenesisState({
    new_world_profile: {
      era: '木叶48年',
      actor_a: { display_name: '源玩家', goal: 'A_PRIVATE_GOAL' },
      actor_b: { display_name: '客方玩家', goal: 'B_PRIVATE_GOAL' }
    }
  }));
  value.meta.state_revision = revision;
  value.actors.A.private_knowledge = {
    facts: ['A_PRIVATE_KNOWLEDGE'],
    imported_relationships: {
      schema: IMPORTED_PRIVATE_RELATIONSHIPS_SCHEMA,
      entries: [{
        subject_id: 'npc:source_private_contact',
        display_name: 'SOURCE_PRIVATE_NPC_NAME',
        known_profile: {
          faction: 'SOURCE_PRIVATE_NPC_FACTION',
          rank: 'SOURCE_PRIVATE_NPC_RANK',
          observed_status: 'ACTIVE'
        },
        directed_relationship: {
          source_actor_id: 'actor:A',
          kind: 'ALLY',
          score: 73,
          label: 'SOURCE_PRIVATE_RELATIONSHIP_TARGET'
        }
      }]
    }
  };
  value.actors.B.private_knowledge = { facts: ['B_PRIVATE_KNOWLEDGE'] };
  value.actors.A.skills.entries = [{
    skill_id: 'skill:a_secret',
    version: 1,
    display_name: 'A_PRIVATE_SKILL',
    category: 'NINJUTSU',
    rank: 'C',
    mastery: 10,
    canonical_ref: null
  }];
  value.actors.B.skills.entries = [{
    skill_id: 'skill:b_secret',
    version: 1,
    display_name: 'B_PRIVATE_SKILL',
    category: 'NINJUTSU',
    rank: 'C',
    mastery: 20,
    canonical_ref: null
  }];
  value.actors.A.equipment.entries = [{
    item_id: 'item:a_secret',
    version: 1,
    display_name: 'A_PRIVATE_ITEM',
    category: 'KEY',
    quantity: 1,
    canonical_ref: null,
    equipped_slot: null
  }];
  value.actors.B.equipment.entries = [{
    item_id: 'item:b_secret',
    version: 1,
    display_name: 'B_PRIVATE_ITEM',
    category: 'KEY',
    quantity: 1,
    canonical_ref: null,
    equipped_slot: null
  }];
  value.actors.A.missions.entries = [{
    mission_id: 'mission:a_secret',
    version: 1,
    scope: 'actor:A',
    title: 'A_PRIVATE_MISSION',
    status: 'ACTIVE',
    progress_current: 0,
    progress_total: 1,
    assignee_actor_ids: ['actor:A']
  }];
  value.actors.B.missions.entries = [{
    mission_id: 'mission:b_secret',
    version: 1,
    scope: 'actor:B',
    title: 'B_PRIVATE_MISSION',
    status: 'ACTIVE',
    progress_current: 0,
    progress_total: 1,
    assignee_actor_ids: ['actor:B']
  }];
  value.memories['actor:A'] = { entries: ['A_PRIVATE_MEMORY'] };
  value.memories['actor:B'] = { entries: ['B_PRIVATE_MEMORY'] };
  value.memories.canonical = { entries: ['SERVER_ONLY_CANONICAL'] };
  value.memories.npc_private = { entries: ['NPC_PRIVATE_MEMORY'] };
  value.agent_internal = {
    story_plan: { secret: 'SERVER_AGENT_INTERNAL' },
    audit_state: { genesis_kind: 'existing_save_derived' }
  };
  return assertReducerDomainState(value);
}

const statesByCheckpoint = new Map(checkpoints.map((item, index) => [
  item.checkpoint_id,
  roomState(index)
]));

const actionsByTurn = Object.freeze({
  turn_shared: Object.freeze({ A: 'A_SHARED_RAW_ACTION', B: 'B_SHARED_RAW_ACTION' }),
  turn_dual: Object.freeze({ A: 'A_DUAL_RAW_ACTION', B: 'B_DUAL_RAW_ACTION' })
});
const narrativesByTurn = Object.freeze({
  turn_shared: Object.freeze({ shared: 'SHARED_NARRATIVE_BODY' }),
  turn_dual: Object.freeze({ A: 'A_PRIVATE_POV_BODY', B: 'B_PRIVATE_POV_BODY' })
});

function sourceTimeline() {
  return {
    export_version: '2.0',
    exported_at: at,
    include_archive: false,
    nodes: [{
      id: 'node_source_head',
      parent_id: null,
      children_ids: [],
      branch_id: 'branch_source',
      turn_number: 7,
      depth: 0,
      player_input: 'SOURCE_OWNER_PREVIOUS_INPUT',
      clean_response: 'SOURCE_OWNER_PREMULTIPLAYER_PRIVATE',
      state_snapshot: {
        _version: '5.0',
        _meta: { current_node_id: 'node_source_head', active_branch: 'branch_source' },
        '玩家·姓名': '源玩家'
      }
    }],
    branches: [{
      id: 'branch_source',
      name: '来源主线',
      color: '#eb613f',
      head_node_id: 'node_source_head',
      node_count: 1,
      is_active: true,
      diverged_from: null
    }],
    meta: {
      key: 'root',
      value: {
        root_id: 'node_source_head',
        current_id: 'node_source_head',
        active_branch: 'branch_source',
        total_nodes: 1
      }
    }
  };
}

const bootstrapBindings = ['A', 'B'].map(seat => deterministicRoomActorBindingMaterial(
  bindingSecret,
  {
    room_id: room.room_id,
    lineage_id: room.lineage_id,
    genesis_checkpoint_id: checkpoints[0].checkpoint_id
  },
  seat,
  `actor:${seat}`
));

function createFakeLineageRepository() {
  const records = new Map();
  const byMemberKey = new Map();
  let sequence = 0;
  const member = (roomId, userId) => {
    if (roomId === 'room_new') {
      if (!Object.values(usersBySeat).includes(userId)) fail('ROOM_MEMBERSHIP_REQUIRED', 'member', 403);
      return { seat: userId === usersBySeat.A ? 'A' : 'B', origin_type: 'new_multiplayer_save' };
    }
    if (roomId !== room.room_id || !Object.values(usersBySeat).includes(userId)) {
      fail('ROOM_MEMBERSHIP_REQUIRED', 'member', 403);
    }
    return { seat: userId === usersBySeat.A ? 'A' : 'B', origin_type: room.origin_type };
  };
  return {
    records,
    bindings: {
      verifyPairForPersonalExport({ authenticated_user_id, room_id, actor_bindings }) {
        const membership = member(room_id, authenticated_user_id);
        assert.deepEqual(actor_bindings, bootstrapBindings);
        return {
          exporting_seat: membership.seat,
          bindings: actor_bindings.map(candidate => ({
            schema: ROOM_ACTOR_BINDING_SCHEMA,
            binding_id: candidate.binding_id,
            room_id,
            lineage_id: room.lineage_id,
            room_actor_id: candidate.room_actor_id,
            original_member_user_id: usersBySeat[candidate.original_seat],
            original_seat: candidate.original_seat,
            genesis_checkpoint_id: checkpoints[0].checkpoint_id,
            signature_version: 'binding_signature_v1',
            opaque_binding_token: candidate.opaque_binding_token,
            created_at: at
          }))
        };
      }
    },
    personalExports: {
      async begin(request) {
        const membership = member(request.room_id, request.authenticated_user_id);
        if (membership.origin_type !== 'existing_save_derived') {
          fail('PLAYABLE_EXPORT_NOT_ALLOWED', 'new multiplayer save is not playable');
        }
        if (!checkpoints.some(item => item.checkpoint_id === request.checkpoint_id)) {
          fail('CHECKPOINT_NOT_COMMITTED', 'checkpoint missing');
        }
        const requestHash = hash(canonicalStringify({
          checkpoint_id: request.checkpoint_id,
          codec: request.codec,
          output_format: request.output_format,
          projection_version: request.projection_version
        }));
        const key = `${request.room_id}:${request.authenticated_user_id}:${request.idempotency_key}`;
        const existingId = byMemberKey.get(key);
        if (existingId) {
          const existing = records.get(existingId);
          if (existing.request_hash !== requestHash) {
            fail('IDEMPOTENCY_KEY_REUSED', 'idempotency key changed', 409);
          }
          return { ...existing, replayed: true };
        }
        sequence += 1;
        const record = {
          export_id: `export_${sequence}`,
          room_id: request.room_id,
          checkpoint_id: request.checkpoint_id,
          exporting_user_id: request.authenticated_user_id,
          exporting_seat: membership.seat,
          codec: request.codec,
          projection_version: request.projection_version,
          output_format: request.output_format,
          idempotency_key: request.idempotency_key,
          request_hash: requestHash,
          output_hash: null,
          output_ref: null,
          status: 'PENDING',
          failure_code: null,
          created_at: at,
          completed_at: null
        };
        records.set(record.export_id, record);
        byMemberKey.set(key, record.export_id);
        return { ...record, replayed: false };
      },
      async complete(request) {
        const record = records.get(request.export_id);
        if (!record || record.exporting_user_id !== request.authenticated_user_id) {
          fail('EXPORT_NOT_FOUND', 'export not found', 404);
        }
        if (record.status !== 'PENDING') fail('EXPORT_NOT_PENDING', 'not pending', 409);
        Object.assign(record, {
          status: 'READY',
          output_hash: request.output_hash,
          output_ref: request.output_ref,
          completed_at: at
        });
        return { ...record, replayed: false };
      },
      async markFailed(request) {
        const record = records.get(request.export_id);
        if (!record || record.exporting_user_id !== request.authenticated_user_id) {
          fail('EXPORT_NOT_FOUND', 'export not found', 404);
        }
        if (record.status === 'PENDING') {
          Object.assign(record, {
            status: 'FAILED',
            failure_code: request.failure_code,
            completed_at: at
          });
        }
        return { ...record };
      },
      getForDownload(request) {
        const record = records.get(request.export_id);
        if (!record
          || record.room_id !== request.room_id
          || record.exporting_user_id !== request.authenticated_user_id) {
          fail('EXPORT_NOT_FOUND', 'export not found', 404);
        }
        if (record.status !== 'READY') fail('EXPORT_NOT_READY', 'export not ready', 409);
        return { ...record };
      }
    }
  };
}

function createMutableOutputStore({ failPut = false } = {}) {
  const values = new Map();
  return {
    values,
    async put({ output_hash, content }) {
      if (failPut) fail('PERSONAL_EXPORT_OUTPUT_STORE_FAILED', 'injected output failure', 500);
      values.set(output_hash, canonicalizeJson(content));
      return { output_ref: output_hash };
    },
    async get({ output_ref }) {
      if (!values.has(output_ref)) fail('PERSONAL_EXPORT_OUTPUT_NOT_FOUND', 'missing', 404);
      return { output_hash: output_ref, content: canonicalizeJson(values.get(output_ref)) };
    }
  };
}

function createHarness({ timelineRead = null, codec = null, outputStore = null } = {}) {
  const lineageRepository = createFakeLineageRepository();
  const narrativeReads = [];
  const timelineReads = [];
  const store = outputStore ?? createMutableOutputStore();
  const actualCodec = codec ?? createMultiplayerToSingleplayerCodec();
  const exportSourceRepository = {
    loadCheckpointChain({ authenticated_user_id, room_id, checkpoint_id }) {
      const exportingSeat = authenticated_user_id === usersBySeat.A ? 'A' : 'B';
      const end = checkpoints.findIndex(item => item.checkpoint_id === checkpoint_id);
      if (room_id !== room.room_id || end < 0) fail('CHECKPOINT_NOT_COMMITTED', 'missing');
      return {
        room,
        exporting_member: {
          member_id: `member_${exportingSeat}`,
          user_id: authenticated_user_id,
          seat: exportingSeat
        },
        members_by_seat: usersBySeat,
        binding_bootstrap: bootstrapBindings.map(item => ({
          binding_id: item.binding_id,
          room_actor_id: item.room_actor_id,
          original_seat: item.original_seat,
          genesis_checkpoint_id: checkpoints[0].checkpoint_id
        })),
        source_basis: {
          type: 'origin_snapshot',
          ref_id: room.origin_snapshot_id,
          source_branch_id: 'branch_source',
          source_node_id: 'node_source_head'
        },
        checkpoint_chain: checkpoints.slice(0, end + 1).map((item, index) => ({
          checkpoint: item,
          turn: index === 0 ? null : {
            turn_id: item.turn_id,
            turn_no: item.turn_no,
            narrative_mode: item.turn_id === 'turn_shared' ? 'shared' : 'dual_pov'
          }
        }))
      };
    },
    getNarrativeForMember({ authenticated_user_id, turn_id }) {
      const seat = authenticated_user_id === usersBySeat.A ? 'A' : 'B';
      const mode = turn_id === 'turn_shared' ? 'shared' : 'dual_pov';
      const audience = mode === 'shared' ? 'shared' : seat;
      narrativeReads.push({ authenticated_user_id, turn_id, audience });
      return { turn_id, mode, audience, text: narrativesByTurn[turn_id][audience] };
    }
  };
  const service = createPersonalSingleplayerExportService({
    lineageRepository,
    coreRepositories: {
      actions: {
        getForMember({ authenticated_user_id, turn_no }) {
          const seat = authenticated_user_id === usersBySeat.A ? 'A' : 'B';
          const turnId = turn_no === 1 ? 'turn_shared' : 'turn_dual';
          return {
            turn_id: turnId,
            turn_no,
            viewer_seat: seat,
            status: 'COMMITTED',
            active_narrative_mode: turnId === 'turn_shared' ? 'shared' : 'dual_pov',
            actions: {
              A: {
                locked: true,
                text: actionsByTurn[turnId].A,
                disclosure: seat === 'A' ? 'owner' : 'full_after_commit'
              },
              B: {
                locked: true,
                text: actionsByTurn[turnId].B,
                disclosure: seat === 'B' ? 'owner' : 'full_after_commit'
              }
            }
          };
        }
      }
    },
    snapshotService: {
      readInternal({ checkpoint_id }) {
        const item = checkpoints.find(candidate => candidate.checkpoint_id === checkpoint_id);
        return {
          room_id: room.room_id,
          epoch_id: item.epoch_id,
          checkpoint_id,
          state_revision: item.state_revision,
          state_hash: item.state_hash,
          state: statesByCheckpoint.get(checkpoint_id)
        };
      }
    },
    exportSourceRepository,
    sourceTimelineReader: {
      async getForOwner(context) {
        timelineReads.push(context);
        if (timelineRead) return timelineRead(context);
        return {
          timeline: sourceTimeline(),
          source_branch_id: 'branch_source',
          source_node_id: 'node_source_head'
        };
      }
    },
    outputStore: store,
    codec: actualCodec,
    bindingTokenSecret: bindingSecret
  });
  return { service, lineageRepository, store, narrativeReads, timelineReads };
}

function agentPayload(content) {
  return canonicalStringify({ nodes: content.nodes, branches: content.branches, meta: content.meta });
}

const harness = createHarness();
let ownerExport;
let guestExport;
let ownerDownload;
let guestDownload;

await test('A and B receive distinct valid playable projections from one checkpoint', async () => {
  ownerExport = await harness.service.beginSinglePlayerExport({
    authenticated_user_id: usersBySeat.A,
    room_id: room.room_id,
    checkpoint_id: 'checkpoint_c2',
    request: { idempotency_key: 'owner-export' }
  });
  guestExport = await harness.service.beginSinglePlayerExport({
    authenticated_user_id: usersBySeat.B,
    room_id: room.room_id,
    checkpoint_id: 'checkpoint_c2',
    request: { idempotency_key: 'guest-export' }
  });
  assert.equal(ownerExport.export.status, 'READY');
  assert.equal(guestExport.export.status, 'READY');
  assert.notEqual(ownerExport.export.output_hash, guestExport.export.output_hash);
  ownerDownload = await harness.service.downloadSinglePlayerExport({
    authenticated_user_id: usersBySeat.A,
    room_id: room.room_id,
    export_id: ownerExport.export.export_id
  });
  guestDownload = await harness.service.downloadSinglePlayerExport({
    authenticated_user_id: usersBySeat.B,
    room_id: room.room_id,
    export_id: guestExport.export.export_id
  });
  assertTimelineSave(ownerDownload.content);
  assertTimelineSave(guestDownload.content);
  assert.equal(ownerDownload.content.multiplayer_export.timeline_origin, 'source_owner_branch');
  assert.equal(guestDownload.content.multiplayer_export.timeline_origin, 'guest_audience_safe_genesis');
  assert.equal(ownerDownload.content.nodes[0].id, 'node_source_head');
  assert.notEqual(guestDownload.content.nodes[0].id, 'node_source_head');
  assert.equal(sourceTimeline().branches[0].head_node_id, 'node_source_head');
});

await test('exporter is player, counterpart is companion, and both opaque bindings stay UI-only', async () => {
  for (const [download, seat, playerName] of [
    [ownerDownload, 'A', '源玩家'],
    [guestDownload, 'B', '客方玩家']
  ]) {
    const sidecar = download.content.multiplayer_record_sidecar;
    const tokens = sidecar.actor_bindings.map(item => item.opaque_binding_token);
    assert.equal(new Set(tokens).size, 2);
    assert.equal(sidecar.actor_bindings.filter(item => item.export_role === 'player').length, 1);
    assert.equal(sidecar.actor_bindings.filter(item => item.export_role === 'npc_or_companion').length, 1);
    assert.ok(sidecar.actor_bindings.every(item => item.inject_to_agent === false));
    assert.ok(sidecar.multiplayer_records.every(item => item.inject_to_agent === false));
    const payload = agentPayload(download.content);
    assert.ok(tokens.every(token => !payload.includes(token)));
    const head = download.content.nodes.find(node => (
      node.id === download.content.meta.value.current_id
    ));
    assert.equal(head.state_snapshot['玩家·姓名'], playerName);
    assert.equal(download.content.multiplayer_export.exporting_seat, seat);
  }
});

await test('Agent history contains only own inputs and the authenticated shared/POV narrative', async () => {
  const ownerPayload = agentPayload(ownerDownload.content);
  const guestPayload = agentPayload(guestDownload.content);
  for (const marker of [
    'B_SHARED_RAW_ACTION',
    'B_DUAL_RAW_ACTION',
    'B_PRIVATE_KNOWLEDGE',
    'B_PRIVATE_SKILL',
    'B_PRIVATE_ITEM',
    'B_PRIVATE_MISSION',
    'B_PRIVATE_MEMORY',
    'B_PRIVATE_GOAL',
    'B_PRIVATE_POV_BODY',
    'SERVER_ONLY_CANONICAL',
    'NPC_PRIVATE_MEMORY',
    'SERVER_AGENT_INTERNAL'
  ]) assert.ok(!ownerPayload.includes(marker), `owner Agent payload leaked ${marker}`);
  for (const marker of [
    'A_SHARED_RAW_ACTION',
    'A_DUAL_RAW_ACTION',
    'A_PRIVATE_KNOWLEDGE',
    'A_PRIVATE_SKILL',
    'A_PRIVATE_ITEM',
    'A_PRIVATE_MISSION',
    'A_PRIVATE_MEMORY',
    'A_PRIVATE_GOAL',
    'A_PRIVATE_POV_BODY',
    'SOURCE_OWNER_PREMULTIPLAYER_PRIVATE'
  ]) assert.ok(!guestPayload.includes(marker), `guest Agent payload leaked ${marker}`);
  assert.match(ownerPayload, /A_SHARED_RAW_ACTION/u);
  assert.match(ownerPayload, /A_DUAL_RAW_ACTION/u);
  assert.match(ownerPayload, /SHARED_NARRATIVE_BODY/u);
  assert.match(ownerPayload, /A_PRIVATE_POV_BODY/u);
  assert.match(guestPayload, /B_SHARED_RAW_ACTION/u);
  assert.match(guestPayload, /B_DUAL_RAW_ACTION/u);
  assert.match(guestPayload, /SHARED_NARRATIVE_BODY/u);
  assert.match(guestPayload, /B_PRIVATE_POV_BODY/u);
  assert.equal(harness.timelineReads.length, 1);
  assert.equal(harness.timelineReads[0].authenticated_user_id, usersBySeat.A);
  assert.deepEqual(harness.narrativeReads, [
    { authenticated_user_id: usersBySeat.A, turn_id: 'turn_shared', audience: 'shared' },
    { authenticated_user_id: usersBySeat.A, turn_id: 'turn_dual', audience: 'A' },
    { authenticated_user_id: usersBySeat.B, turn_id: 'turn_shared', audience: 'shared' },
    { authenticated_user_id: usersBySeat.B, turn_id: 'turn_dual', audience: 'B' }
  ]);
});

await test('guest playable file and reimport capsule exclude source private relationship continuity', async () => {
  const ownerFile = canonicalStringify(ownerDownload.content);
  const guestFile = canonicalStringify(guestDownload.content);
  for (const marker of [
    'SOURCE_PRIVATE_NPC_NAME',
    'SOURCE_PRIVATE_NPC_FACTION',
    'SOURCE_PRIVATE_NPC_RANK',
    'SOURCE_PRIVATE_RELATIONSHIP_TARGET',
    'npc:source_private_contact'
  ]) {
    assert.match(ownerFile, new RegExp(marker, 'u'));
    assert.doesNotMatch(guestFile, new RegExp(marker, 'u'));
  }
  assert.doesNotMatch(guestFile, /A_PRIVATE_KNOWLEDGE|NPC_PRIVATE_MEMORY/u);
  assert.doesNotMatch(ownerFile, /NPC_PRIVATE_MEMORY/u);
  const guestBasis = guestDownload.content.multiplayer_record_sidecar
    .server_reimport_capsule.projection_basis;
  assert.deepEqual(guestBasis.actors.A.private_knowledge, {});
});

await test('counterpart raw actions exist only in the non-Agent sidecar', async () => {
  assert.deepEqual(
    ownerDownload.content.multiplayer_record_sidecar.multiplayer_records
      .map(item => item.counterpart_action_text),
    ['B_SHARED_RAW_ACTION', 'B_DUAL_RAW_ACTION']
  );
  assert.deepEqual(
    guestDownload.content.multiplayer_record_sidecar.multiplayer_records
      .map(item => item.counterpart_action_text),
    ['A_SHARED_RAW_ACTION', 'A_DUAL_RAW_ACTION']
  );
});

await test('same member/key replays exactly and changed checkpoint or parameters conflict', async () => {
  const beforeSize = harness.store.values.size;
  const replay = await harness.service.beginSinglePlayerExport({
    authenticated_user_id: usersBySeat.A,
    room_id: room.room_id,
    checkpoint_id: 'checkpoint_c2',
    request: { idempotency_key: 'owner-export' }
  });
  assert.equal(replay.export.export_id, ownerExport.export.export_id);
  assert.equal(replay.replayed, true);
  assert.equal(harness.store.values.size, beforeSize);
  await assert.rejects(
    harness.service.beginSinglePlayerExport({
      authenticated_user_id: usersBySeat.A,
      room_id: room.room_id,
      checkpoint_id: 'checkpoint_c1',
      request: { idempotency_key: 'owner-export' }
    }),
    error => error?.code === 'IDEMPOTENCY_KEY_REUSED'
  );
  await assert.rejects(
    harness.service.beginSinglePlayerExport({
      authenticated_user_id: usersBySeat.A,
      room_id: room.room_id,
      checkpoint_id: 'checkpoint_c2',
      request: { idempotency_key: 'owner-export', projection_version: 'projection-v2' }
    }),
    error => error?.code === 'IDEMPOTENCY_KEY_REUSED'
  );
});

await test('a member cannot download the other member export', async () => {
  await assert.rejects(
    harness.service.downloadSinglePlayerExport({
      authenticated_user_id: usersBySeat.A,
      room_id: room.room_id,
      export_id: guestExport.export.export_id
    }),
    error => error?.code === 'EXPORT_NOT_FOUND'
  );
});

await test('new_multiplayer_save rejects playable export before generating output', async () => {
  await assert.rejects(
    harness.service.beginSinglePlayerExport({
      authenticated_user_id: usersBySeat.A,
      room_id: 'room_new',
      checkpoint_id: 'checkpoint_c2',
      request: { idempotency_key: 'new-save-export' }
    }),
    error => error?.code === 'PLAYABLE_EXPORT_NOT_ALLOWED'
  );
});

await test('missing trusted owner timeline marks the whole export FAILED', async () => {
  const isolated = createHarness({ timelineRead: () => ({ timeline: null }) });
  await assert.rejects(
    isolated.service.beginSinglePlayerExport({
      authenticated_user_id: usersBySeat.A,
      room_id: room.room_id,
      checkpoint_id: 'checkpoint_c2',
      request: { idempotency_key: 'missing-owner-timeline' }
    }),
    error => error?.code === 'SOURCE_OWNER_TIMELINE_UNAVAILABLE'
  );
  const record = [...isolated.lineageRepository.records.values()][0];
  assert.equal(record.status, 'FAILED');
  assert.equal(record.failure_code, 'SOURCE_OWNER_TIMELINE_UNAVAILABLE');
  assert.equal(isolated.store.values.size, 0);
});

await test('codec and output-store failures never publish READY content', async () => {
  const brokenCodec = {
    ...createMultiplayerToSingleplayerCodec(),
    encode() {
      throw Object.freeze(new DomainError(
        'SINGLEPLAYER_EXPORT_CODEC_INVALID',
        'injected codec failure'
      ));
    }
  };
  const codecFailure = createHarness({ codec: brokenCodec });
  await assert.rejects(
    codecFailure.service.beginSinglePlayerExport({
      authenticated_user_id: usersBySeat.B,
      room_id: room.room_id,
      checkpoint_id: 'checkpoint_c2',
      request: { idempotency_key: 'codec-failure' }
    }),
    error => error?.code === 'SINGLEPLAYER_EXPORT_CODEC_INVALID'
  );
  assert.equal([...codecFailure.lineageRepository.records.values()][0].status, 'FAILED');
  assert.equal(codecFailure.store.values.size, 0);

  const failingStore = createMutableOutputStore({ failPut: true });
  const storeFailure = createHarness({ outputStore: failingStore });
  await assert.rejects(
    storeFailure.service.beginSinglePlayerExport({
      authenticated_user_id: usersBySeat.B,
      room_id: room.room_id,
      checkpoint_id: 'checkpoint_c2',
      request: { idempotency_key: 'store-failure' }
    }),
    error => error?.code === 'PERSONAL_EXPORT_OUTPUT_STORE_FAILED'
  );
  assert.equal([...storeFailure.lineageRepository.records.values()][0].status, 'FAILED');
  assert.equal(failingStore.values.size, 0);
});

await test('download rejects immutable output content tampering', async () => {
  const ref = ownerExport.export.output_hash;
  const original = harness.store.values.get(ref);
  const tampered = structuredClone(original);
  tampered.exported_at = '2026-08-22T10:00:01.000Z';
  harness.store.values.set(ref, tampered);
  await assert.rejects(
    harness.service.downloadSinglePlayerExport({
      authenticated_user_id: usersBySeat.A,
      room_id: room.room_id,
      export_id: ownerExport.export.export_id
    }),
    error => error?.code === 'PERSONAL_EXPORT_OUTPUT_CORRUPT'
  );
  harness.store.values.set(ref, original);
});

console.log(`multiplayer personal export application regression: ${passed} passed`);
