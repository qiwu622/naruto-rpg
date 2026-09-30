import assert from 'node:assert/strict';

import { sha256Hex } from '../server/multiplayer/domain/canonical-json.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  LATEST_SOURCE_PRIVACY_NORMALIZER_VERSION,
  archiveRoomLineage,
  commitRoomCheckpoint,
  createRoomLineage,
  exportPersonalSingleplayer,
  forkArchivedFromLatestSource,
  prepareLatestSourceBasis,
  readPersonalSingleplayerExport,
  resumeArchivedCheckpoint,
  roomCheckpointStateHash
} from '../server/multiplayer/domain/lineage.js';
import {
  acceptPOVWriterAudience,
  assertModelInvocationAuthorized,
  authorizeTurnBillingPlan,
  computeTurnBillingPlanHash,
  createTurnBillingAuthorizationState,
  freezeTurnBillingSelections,
  inspectTurnBillingPlanAuthorization,
  inspectTurnSelectionReadiness,
  selectPOVWriterPayer,
  selectTurnPayer,
  startNextTurnBillingAuthorization
} from '../server/multiplayer/domain/billing-authorization.js';
import {
  EXECUTION_GRANT_SCHEMA,
  TURN_BILLING_PLAN_SCHEMA
} from '../server/multiplayer/contracts/billing-contracts.js';
import {
  FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA,
  RESUME_ROOM_CHECKPOINT_SCHEMA,
  ROOM_ACTOR_BINDING_SCHEMA,
  ROOM_ORIGIN_SCHEMA,
  SOURCE_IMPORT_SCHEMA
} from '../server/multiplayer/contracts/lineage-contracts.js';
import { MULTIPLAYER_ROOM_STATE_SCHEMA } from '../server/multiplayer/contracts/state-contracts.js';

let passed = 0;

function test(name, callback) {
  callback();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function clone(value) {
  return structuredClone(value);
}

function digest(seed) {
  return `sha256:${sha256Hex(seed)}`;
}

function hmac(seed) {
  return `hmac-sha256:${sha256Hex(`test-server:${seed}`)}`;
}

const NOW = '2026-08-22T08:00:00.000Z';
const LATER = '2026-08-23T08:00:00.000Z';
const MEMBERS = Object.freeze({ A: 'user-A', B: 'user-B' });

function roomState(revision = 1, overrides = {}) {
  const state = {
    schema: MULTIPLAYER_ROOM_STATE_SCHEMA,
    meta: { state_revision: revision },
    shared_world: {
      world_state: { weather: 'clear', location: '木叶村' },
      calendar: { day: 1 },
      map: { visited: ['木叶村'] },
      canonical_events: [{ event_id: 'event-public-1', summary: '两人会合。' }],
      shared_missions: [],
      shared_combat: null,
      continuity_ledger: [{ audit_id: 'continuity-server-secret' }]
    },
    actors: {
      A: {
        room_actor_id: 'room-actor-A',
        player: { display_name: '甲', goal: 'A-private-goal' },
        attributes: { chakra: 80 },
        progression: { level: 2 },
        skills: [{ skill_id: 'skill-A-secret', display_name: 'A秘术' }],
        equipment: [{ item_id: 'item-A-secret', display_name: 'A秘宝' }],
        missions: [{ mission_id: 'mission-A-secret' }],
        private_knowledge: [{ fact_id: 'fact-A-private', text: 'A-private-memory-secret' }]
      },
      B: {
        room_actor_id: 'room-actor-B',
        player: { display_name: '乙', goal: 'B-private-goal' },
        attributes: { chakra: 70 },
        progression: { level: 3 },
        skills: [{ skill_id: 'skill-B-secret', display_name: 'B秘术' }],
        equipment: [{ item_id: 'item-B-secret', display_name: 'B秘宝' }],
        missions: [{ mission_id: 'mission-B-secret' }],
        private_knowledge: [{ fact_id: 'fact-B-private', text: 'B-private-memory-secret' }]
      }
    },
    relationships: [{
      edge_id: 'edge-A-B',
      source_actor_id: 'room-actor-A',
      target_actor_id: 'room-actor-B',
      data: { trust: 1 }
    }],
    memories: {
      canonical: [{ memory_id: 'memory-canonical-secret', text: 'canonical-server-secret' }],
      shared: [{ memory_id: 'memory-shared', text: 'shared-memory' }],
      'actor:A': [{ memory_id: 'memory-A', text: 'A-memory-only' }],
      'actor:B': [{ memory_id: 'memory-B', text: 'B-memory-only' }],
      npc_private: { npc_1: [{ memory_id: 'memory-npc', text: 'npc-private-secret' }] }
    },
    agent_internal: {
      story_plan: { next: 'server-story-plan-secret' },
      audit_state: { marker: 'server-audit-secret' }
    }
  };
  return Object.assign(state, overrides);
}

function origin(type = 'existing_save_derived') {
  return {
    schema: ROOM_ORIGIN_SCHEMA,
    room_id: 'room-1',
    origin_type: type,
    lineage_id: 'lineage-1',
    origin_owner_user_id: type === 'existing_save_derived' ? 'user-A' : null,
    origin_snapshot_id: type === 'existing_save_derived' ? 'source-S0' : 'world-N0'
  };
}

function binding(seat) {
  return {
    schema: ROOM_ACTOR_BINDING_SCHEMA,
    binding_id: `binding-${seat}`,
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    room_actor_id: `room-actor-${seat}`,
    original_member_user_id: MEMBERS[seat],
    original_seat: seat,
    genesis_checkpoint_id: 'checkpoint-E1-C0',
    signature_version: 'binding-v1',
    opaque_binding_token: `opaque.binding.token.${seat}.1234567890`,
    created_at: NOW
  };
}

function lineageFixture(type = 'existing_save_derived') {
  return createRoomLineage({
    origin: origin(type),
    members_by_seat: MEMBERS,
    actor_bindings: [binding('A'), binding('B')],
    room_state: roomState(),
    state_revision: 1,
    control_revision: 5,
    epoch_id: 'epoch-1',
    genesis_checkpoint_id: 'checkpoint-E1-C0',
    snapshot_ref: 'snapshot-E1-C0',
    activated_at: NOW,
    source_owner_timeline: type === 'existing_save_derived'
      ? [{ node_id: 'source-private-node', text: 'owner-pre-multiplayer-history' }]
      : []
  });
}

function resumeProposal(lineage, checkpointId, stateHash, suffix = 'resume') {
  return {
    schema: RESUME_ROOM_CHECKPOINT_SCHEMA,
    continuation_mode: 'resume_room_checkpoint',
    proposal_id: `proposal-${suffix}`,
    proposal_revision: 1,
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    checkpoint_id: checkpointId,
    base_checkpoint_state_hash: stateHash,
    expected_control_revision: lineage.control_revision,
    member_acceptances: {
      A: { accepted_by_user_id: 'user-A', accepted_at: NOW, audience_diff_commitment: null },
      B: { accepted_by_user_id: 'user-B', accepted_at: NOW, audience_diff_commitment: null }
    },
    server_hmac_commitment: hmac(suffix)
  };
}

function archive(lineage, checkpointId = undefined) {
  const active = lineage.epochs.find(epoch => epoch.epoch_id === lineage.active_epoch_id);
  return archiveRoomLineage(lineage, {
    checkpoint_id: checkpointId ?? active.head_checkpoint_id,
    expected_control_revision: lineage.control_revision,
    safe_boundary: 'checkpoint',
    archived_at: NOW
  });
}

function committedLineage() {
  const initial = lineageFixture();
  const nextState = clone(roomState());
  nextState.shared_world.world_state.weather = 'sunny-at-C1';
  nextState.actors.A.attributes.chakra = 64;
  return commitRoomCheckpoint(initial, {
    expected_state_revision: initial.state_revision,
    expected_control_revision: initial.control_revision,
    checkpoint_id: 'checkpoint-E1-C1',
    turn_id: 'turn-1',
    commit_id: 'commit-1',
    snapshot_ref: 'snapshot-E1-C1',
    room_state: nextState,
    turn_record: {
      turn_id: 'turn-1',
      action_text_by_seat: {
        A: 'A 原文行动：潜入档案室。',
        B: 'B 原文行动：封锁档案室出口。'
      },
      narrative_mode: 'dual_pov',
      shared_narrative: null,
      pov_narrative_by_seat: {
        A: 'A-POV-only-narrative',
        B: 'B-POV-only-narrative'
      }
    },
    created_at: NOW
  });
}

test('origin snapshot and all accepted lineage nodes are detached immutable values', () => {
  const mutableS0 = roomState();
  const lineage = createRoomLineage({
    origin: origin(),
    members_by_seat: MEMBERS,
    actor_bindings: [binding('A'), binding('B')],
    room_state: mutableS0,
    epoch_id: 'epoch-1',
    genesis_checkpoint_id: 'checkpoint-E1-C0',
    snapshot_ref: 'snapshot-E1-C0',
    activated_at: NOW,
    state_revision: 1,
    control_revision: 5,
    source_owner_timeline: []
  });
  const hashBefore = lineage.checkpoints[0].state_hash;
  mutableS0.shared_world.calendar.day = 99;
  assert.equal(lineage.snapshots[0].room_state.shared_world.calendar.day, 1);
  assert.equal(lineage.checkpoints[0].state_hash, hashBefore);
  assert.equal(Object.isFrozen(lineage.checkpoints[0]), true);
});

test('both origin types archive and resume genesis with monotonic revisions but identical content hash', () => {
  for (const type of ['existing_save_derived', 'new_multiplayer_save']) {
    const initial = lineageFixture(type);
    const archived = archive(initial, 'checkpoint-E1-C0');
    const oldEpoch = clone(archived.epochs[0]);
    const proposal = resumeProposal(
      archived,
      'checkpoint-E1-C0',
      archived.checkpoints[0].state_hash,
      `resume-${type}`
    );
    const resumed = resumeArchivedCheckpoint(archived, {
      proposal,
      new_epoch_id: 'epoch-2',
      new_genesis_checkpoint_id: 'checkpoint-E2-C0',
      snapshot_ref: 'snapshot-E2-C0',
      activated_at: LATER
    });
    assert.equal(resumed.checkpoints.at(-1).state_hash, archived.checkpoints[0].state_hash);
    assert.ok(resumed.state_revision > archived.state_revision);
    assert.ok(resumed.control_revision > archived.control_revision);
    assert.deepEqual(resumed.epochs[0], oldEpoch);
    assert.equal(initial.epochs[0].state, 'ACTIVE');
  }
});

test('A and B exports are separate audience projections with non-Agent binding/action sidecars', () => {
  let lineage = committedLineage();
  const exportA = exportPersonalSingleplayer(lineage, {
    authenticated_user_id: 'user-A',
    checkpoint_id: 'checkpoint-E1-C1',
    idempotency_key: 'same-member-key',
    export_id: 'export-A-C1',
    created_at: NOW
  });
  lineage = exportA.lineage;
  const exportB = exportPersonalSingleplayer(lineage, {
    authenticated_user_id: 'user-B',
    checkpoint_id: 'checkpoint-E1-C1',
    idempotency_key: 'same-member-key',
    export_id: 'export-B-C1',
    created_at: NOW
  });
  const textA = JSON.stringify(exportA.content);
  const textB = JSON.stringify(exportB.content);
  assert.match(textA, /A-memory-only/);
  assert.doesNotMatch(textA, /B-memory-only|B-private-memory-secret|skill-B-secret|item-B-secret|B-POV-only/);
  assert.match(textB, /B-memory-only/);
  assert.doesNotMatch(textB, /A-memory-only|A-private-memory-secret|skill-A-secret|item-A-secret|A-POV-only/);
  assert.match(textA, /A-POV-only-narrative/);
  assert.match(textB, /B-POV-only-narrative/);
  assert.equal(exportA.content.non_agent_sidecar.inject_to_agent, false);
  assert.equal(exportA.content.non_agent_sidecar.actor_bindings.length, 2);
  assert.equal(new Set(
    exportA.content.non_agent_sidecar.actor_bindings.map(item => item.opaque_binding_token)
  ).size, 2);
  assert.equal(exportA.content.non_agent_sidecar.multiplayer_records[0].inject_to_agent, false);
  assert.match(
    exportA.content.non_agent_sidecar.multiplayer_records[0].counterpart_action_text,
    /B 原文行动/
  );
  assert.notEqual(exportA.manifest.output_hash, exportB.manifest.output_hash);
  assert.equal(exportA.manifest.actor_mappings.find(item => item.export_role === 'player').room_actor_id, 'room-actor-A');
  assert.equal(exportB.manifest.actor_mappings.find(item => item.export_role === 'player').room_actor_id, 'room-actor-B');
  assert.equal(exportA.content.timeline.source_owner_prefix.length, 1);
  assert.equal(exportB.content.timeline.source_owner_prefix.length, 0);
});

test('personal export idempotency is member-scoped and download authority never crosses members', () => {
  let lineage = committedLineage();
  const first = exportPersonalSingleplayer(lineage, {
    authenticated_user_id: 'user-A',
    checkpoint_id: 'checkpoint-E1-C1',
    idempotency_key: 'export-once',
    export_id: 'export-A-once',
    created_at: NOW
  });
  lineage = first.lineage;
  const replay = exportPersonalSingleplayer(lineage, {
    authenticated_user_id: 'user-A',
    checkpoint_id: 'checkpoint-E1-C1',
    idempotency_key: 'export-once',
    export_id: 'ignored-new-export-id',
    created_at: LATER
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.manifest.export_id, first.manifest.export_id);
  assert.throws(
    () => exportPersonalSingleplayer(lineage, {
      authenticated_user_id: 'user-A',
      checkpoint_id: 'checkpoint-E1-C0',
      idempotency_key: 'export-once',
      export_id: 'export-A-conflict',
      created_at: NOW
    }),
    error => error.code === 'IDEMPOTENCY_KEY_REUSED'
  );
  assert.throws(
    () => readPersonalSingleplayerExport(lineage, {
      authenticated_user_id: 'user-B',
      export_id: first.manifest.export_id
    }),
    error => error.code === 'EXPORT_NOT_FOUND'
  );
});

test('new_multiplayer_save rejects playable export and latest-source continuation', () => {
  const lineage = lineageFixture('new_multiplayer_save');
  assert.throws(
    () => exportPersonalSingleplayer(lineage, {
      authenticated_user_id: 'user-A',
      checkpoint_id: 'checkpoint-E1-C0',
      idempotency_key: 'forbidden-export',
      export_id: 'forbidden-export',
      created_at: NOW
    }),
    error => error.code === 'PLAYABLE_EXPORT_NOT_ALLOWED'
  );
  assert.throws(
    () => prepareLatestSourceBasis(lineage, {}, { authenticated_user_id: 'user-A' }),
    error => error.code === 'CONTINUATION_MODE_NOT_ALLOWED'
  );
});

function latestSourceScenario() {
  let lineage = committedLineage();
  const exported = exportPersonalSingleplayer(lineage, {
    authenticated_user_id: 'user-A',
    checkpoint_id: 'checkpoint-E1-C1',
    idempotency_key: 'latest-source-export',
    export_id: 'export-A-latest-source',
    created_at: NOW
  });
  lineage = archive(exported.lineage, 'checkpoint-E1-C1');
  const sourceDocument = clone(exported.content);
  sourceDocument.playable_state.shared_world.world_state.weather = 'rain-from-L2-only';
  sourceDocument.playable_state.actors.B.attributes = {
    chakra: 12,
    injury: 'L2-persistent-injury'
  };
  sourceDocument.playable_state.actors.B.private_knowledge = [{
    fact_id: 'fact-B-L2-private',
    text: 'B-L2-private-memory-must-strip'
  }];
  sourceDocument.playable_state.memories['actor:B'] = [{
    memory_id: 'memory-B-L2-private',
    text: 'B-L2-private-memory-bucket'
  }];
  sourceDocument.playable_state.memories.npc_private = {
    'room-actor-B': [{ memory_id: 'npc-B-L2-private', text: 'NPC-private-L2' }]
  };
  return { lineage, sourceDocument };
}

function sourceImportFromBasis(basis) {
  return {
    schema: SOURCE_IMPORT_SCHEMA,
    source_import_id: 'source-import-L2',
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    origin_owner_user_id: 'user-A',
    source_save_id: 'save-A',
    client_save_instance_id: 'instance-A',
    source_branch_id: 'branch-L2',
    source_node_id: 'node-L2',
    cloud_revision: null,
    canonical_content_hash: digest('canonical-L2'),
    selected_state_hash: digest('selected-L2'),
    raw_source_hash: basis.raw_source_hash,
    normalized_source_hash: basis.normalized_source_hash,
    normalization_and_rebind_diff_hash: basis.normalization_and_rebind_diff_hash,
    genesis_state_hash: basis.genesis_state_hash,
    privacy_normalizer_version: LATEST_SOURCE_PRIVACY_NORMALIZER_VERSION,
    derived_from_export_id: 'export-A-latest-source',
    audience_diff_commitments: { A: hmac('latest-diff-A'), B: hmac('latest-diff-B') },
    server_hmac_commitment: hmac('latest-source-import'),
    imported_at: NOW
  };
}

function latestForkProposal(lineage) {
  return {
    schema: FORK_FROM_LATEST_SOURCE_SAVE_SCHEMA,
    continuation_mode: 'fork_from_latest_source_save',
    proposal_id: 'proposal-fork-L2',
    proposal_revision: 1,
    room_id: 'room-1',
    lineage_id: 'lineage-1',
    source_import_id: 'source-import-L2',
    origin_owner_user_id: 'user-A',
    expected_control_revision: lineage.control_revision,
    audience_diff_commitments: { A: hmac('latest-diff-A'), B: hmac('latest-diff-B') },
    member_acceptances: {
      A: {
        accepted_by_user_id: 'user-A',
        accepted_at: NOW,
        audience_diff_commitment: hmac('latest-diff-A')
      },
      B: {
        accepted_by_user_id: 'user-B',
        accepted_at: NOW,
        audience_diff_commitment: hmac('latest-diff-B')
      }
    },
    server_hmac_commitment: hmac('latest-proposal')
  };
}

test('only origin owner can prepare latest source and signed actor bindings must form a bijection', () => {
  const { lineage, sourceDocument } = latestSourceScenario();
  assert.throws(
    () => prepareLatestSourceBasis(lineage, sourceDocument, {
      authenticated_user_id: 'user-B'
    }),
    error => error.code === 'SOURCE_OWNER_REQUIRED'
  );
  const forged = clone(sourceDocument);
  forged.non_agent_sidecar.actor_bindings[1].opaque_binding_token =
    forged.non_agent_sidecar.actor_bindings[0].opaque_binding_token;
  assert.throws(
    () => prepareLatestSourceBasis(lineage, forged, {
      authenticated_user_id: 'user-A',
      verify_binding_token: (token, expected) => token === expected.opaque_binding_token
    }),
    error => ['RETURN_ACTOR_AMBIGUOUS', 'ROOM_ACTOR_BINDING_NOT_BIJECTIVE'].includes(error.code)
  );
});

test('latest-source privacy normalizer rejects cross-namespace references instead of guessing', () => {
  const { lineage, sourceDocument } = latestSourceScenario();
  sourceDocument.playable_state.shared_world.canonical_events.push({
    event_id: 'event-unsafe-ref',
    source_fact_ref: 'fact-B-L2-private'
  });
  assert.throws(
    () => prepareLatestSourceBasis(lineage, sourceDocument, {
      authenticated_user_id: 'user-A',
      verify_binding_token: (token, expected) => token === expected.opaque_binding_token
    }),
    error => error.code === 'GUEST_PRIVATE_DATA_FORBIDDEN'
  );
});

test('origin owner cannot relabel the guest personal branch as an origin-owner latest source', () => {
  let lineage = committedLineage();
  const guestExport = exportPersonalSingleplayer(lineage, {
    authenticated_user_id: 'user-B',
    checkpoint_id: 'checkpoint-E1-C1',
    idempotency_key: 'guest-branch-forbidden-source',
    export_id: 'export-B-forbidden-source',
    created_at: NOW
  });
  lineage = archive(guestExport.lineage, 'checkpoint-E1-C1');
  const basis = prepareLatestSourceBasis(lineage, guestExport.content, {
    authenticated_user_id: 'user-A',
    verify_binding_token: (token, expected) => token === expected.opaque_binding_token
  });
  const forgedImport = {
    ...sourceImportFromBasis(basis),
    derived_from_export_id: 'export-B-forbidden-source'
  };
  assert.throws(
    () => forkArchivedFromLatestSource(lineage, {
      authenticated_user_id: 'user-A',
      proposal: latestForkProposal(lineage),
      source_import: forgedImport,
      source_document: guestExport.content,
      verify_binding_token: (token, expected) => token === expected.opaque_binding_token,
      new_epoch_id: 'epoch-forbidden-guest-source',
      new_genesis_checkpoint_id: 'checkpoint-forbidden-guest-source',
      snapshot_ref: 'snapshot-forbidden-guest-source',
      activated_at: LATER
    }),
    error => error.code === 'SOURCE_OWNER_REQUIRED'
  );
});

test('latest-source fork uses normalized L2 plus exact control rebind and leaves archived nodes unchanged', () => {
  const { lineage, sourceDocument } = latestSourceScenario();
  const oldEpochs = clone(lineage.epochs);
  const oldCheckpoints = clone(lineage.checkpoints);
  const basis = prepareLatestSourceBasis(lineage, sourceDocument, {
    authenticated_user_id: 'user-A',
    verify_binding_token: (token, expected) => token === expected.opaque_binding_token
  });
  assert.equal(basis.genesis_room_state.shared_world.world_state.weather, 'rain-from-L2-only');
  assert.equal(basis.genesis_room_state.actors.B.attributes.chakra, 12);
  assert.deepEqual(basis.genesis_room_state.actors.B.private_knowledge, []);
  assert.deepEqual(basis.genesis_room_state.memories['actor:B'], []);
  assert.equal(JSON.stringify(basis.genesis_room_state).includes('B-L2-private'), false);
  const forked = forkArchivedFromLatestSource(lineage, {
    authenticated_user_id: 'user-A',
    proposal: latestForkProposal(lineage),
    source_import: sourceImportFromBasis(basis),
    source_document: sourceDocument,
    verify_binding_token: (token, expected) => token === expected.opaque_binding_token,
    new_epoch_id: 'epoch-2-L2',
    new_genesis_checkpoint_id: 'checkpoint-E2-L2-C0',
    snapshot_ref: 'snapshot-E2-L2-C0',
    activated_at: LATER
  });
  assert.deepEqual(forked.epochs.slice(0, oldEpochs.length), oldEpochs);
  assert.deepEqual(forked.checkpoints.slice(0, oldCheckpoints.length), oldCheckpoints);
  assert.equal(forked.checkpoints.at(-1).state_hash, basis.genesis_state_hash);
  assert.ok(forked.state_revision > lineage.state_revision);
  assert.ok(forked.control_revision > lineage.control_revision);
  assert.equal(forked.snapshots.at(-1).room_state.actors.B.attributes.injury, 'L2-persistent-injury');
  assert.equal(
    roomCheckpointStateHash(
      forked.snapshots.at(-1).room_state,
      forked.snapshots.at(-1).actor_control_by_seat
    ),
    forked.checkpoints.at(-1).state_hash
  );
});

function profileRef(owner = 'user-A', suffix = 'A') {
  return {
    profile_id: `profile-${suffix}`,
    config_revision: 1,
    owner_user_id: owner,
    normalized_origin: `https://models-${suffix.toLowerCase()}.example.test`,
    config_fingerprint: digest(`profile-${suffix}-v1`),
    credential_ref: { credential_id: `credential-${suffix}`, credential_revision: 1 }
  };
}

const SHARED_STAGE_NAMES = [
  'referee',
  'resolution_completeness_reviewer',
  'resolution_repair',
  'continuity_steward',
  'continuity_repair',
  'narrative_grounding_reviewer'
];

function billingState(mode = 'dual_pov') {
  return createTurnBillingAuthorizationState({
    room_id: 'room-1',
    epoch_id: 'epoch-1',
    turn_id: 'turn-billing-1',
    narrative_mode: mode,
    members_by_seat: MEMBERS,
    control_revision: 10
  });
}

function sharedPayerCommand() {
  return {
    payer_seat: 'A',
    profile_ref: profileRef(),
    stage_config_fingerprints: [...SHARED_STAGE_NAMES, 'writer'].map(stage => ({
      stage,
      config_fingerprint: digest(`config-${stage}`)
    })),
    idempotency_key: 'shared-payer-A'
  };
}

function readyDualBillingState() {
  let state = billingState();
  state = selectTurnPayer(state, sharedPayerCommand(), {
    authenticated_user_id: 'user-A',
    expected_control_revision: state.control_revision,
    accepted_at: NOW
  });
  state = selectPOVWriterPayer(state, {
    audience: 'A',
    payer_seat: 'A',
    profile_ref: profileRef(),
    writer_config_fingerprint: digest('writer-A'),
    idempotency_key: 'writer-A-by-A'
  }, {
    authenticated_user_id: 'user-A',
    expected_control_revision: state.control_revision,
    accepted_at: NOW
  });
  state = selectPOVWriterPayer(state, {
    audience: 'B',
    payer_seat: 'A',
    profile_ref: profileRef(),
    writer_config_fingerprint: digest('writer-B'),
    idempotency_key: 'writer-B-sponsored-by-A'
  }, {
    authenticated_user_id: 'user-A',
    expected_control_revision: state.control_revision,
    accepted_at: NOW
  });
  state = acceptPOVWriterAudience(state, {
    audience: 'B',
    selection_revision: 1,
    idempotency_key: 'B-accepts-sponsored-writer'
  }, {
    authenticated_user_id: 'user-B',
    expected_control_revision: state.control_revision,
    accepted_at: NOW
  });
  return freezeTurnBillingSelections(state);
}

test('each new turn starts empty and only the payer can select their own shared profile', () => {
  let state = billingState('shared');
  assert.equal(inspectTurnSelectionReadiness(state).ready, false);
  assert.throws(
    () => selectTurnPayer(state, sharedPayerCommand(), {
      authenticated_user_id: 'user-B',
      expected_control_revision: state.control_revision,
      accepted_at: NOW
    }),
    error => error.code === 'PAYER_SELF_REQUIRED'
  );
  const incompleteCommand = sharedPayerCommand();
  incompleteCommand.stage_config_fingerprints = incompleteCommand.stage_config_fingerprints.filter(
    item => item.stage !== 'writer'
  );
  const incomplete = selectTurnPayer(state, incompleteCommand, {
    authenticated_user_id: 'user-A',
    expected_control_revision: state.control_revision,
    accepted_at: NOW
  });
  assert.equal(inspectTurnSelectionReadiness(incomplete).ready, false);
  assert.equal(
    inspectTurnSelectionReadiness(incomplete).reasons.some(
      reason => reason.code === 'SHARED_STAGE_CONFIG_REQUIRED'
    ),
    true
  );
  state = selectTurnPayer(state, sharedPayerCommand(), {
    authenticated_user_id: 'user-A',
    expected_control_revision: state.control_revision,
    accepted_at: NOW
  });
  const selectedState = state;
  state = selectTurnPayer(state, sharedPayerCommand(), {
    authenticated_user_id: 'user-A',
    expected_control_revision: 10,
    accepted_at: NOW
  });
  assert.deepEqual(state, selectedState);
  assert.equal(inspectTurnSelectionReadiness(state).ready, true);
  const next = startNextTurnBillingAuthorization(state, {
    turn_id: 'turn-billing-2',
    narrative_mode: 'shared',
    control_revision: state.control_revision
  });
  assert.equal(next.turn_payer_selection, null);
  assert.deepEqual(next.pov_writer_selections, { A: null, B: null });
  assert.equal(inspectTurnSelectionReadiness(next).ready, false);
});

test('dual POV waits for both Writer choices, payer acceptance and POV-owner consent', () => {
  let state = billingState();
  state = selectTurnPayer(state, sharedPayerCommand(), {
    authenticated_user_id: 'user-A',
    expected_control_revision: state.control_revision,
    accepted_at: NOW
  });
  state = selectPOVWriterPayer(state, {
    audience: 'A', payer_seat: 'A', profile_ref: profileRef(),
    writer_config_fingerprint: digest('writer-A'), idempotency_key: 'writer-A'
  }, {
    authenticated_user_id: 'user-A', expected_control_revision: state.control_revision, accepted_at: NOW
  });
  state = selectPOVWriterPayer(state, {
    audience: 'B', payer_seat: 'A', profile_ref: profileRef(),
    writer_config_fingerprint: digest('writer-B'), idempotency_key: 'writer-B'
  }, {
    authenticated_user_id: 'user-A', expected_control_revision: state.control_revision, accepted_at: NOW
  });
  const awaiting = inspectTurnSelectionReadiness(state);
  assert.equal(awaiting.ready, false);
  assert.equal(awaiting.reasons.some(reason => reason.code === 'POV_OWNER_CONSENT_REQUIRED'), true);
  assert.throws(
    () => acceptPOVWriterAudience(state, {
      audience: 'B', selection_revision: 1, idempotency_key: 'forged-B-acceptance'
    }, {
      authenticated_user_id: 'user-A', expected_control_revision: state.control_revision, accepted_at: NOW
    }),
    error => error.code === 'POV_OWNER_SELF_REQUIRED'
  );
  const acceptanceControlRevision = state.control_revision;
  const acceptedState = acceptPOVWriterAudience(state, {
    audience: 'B', selection_revision: 1, idempotency_key: 'real-B-acceptance'
  }, {
    authenticated_user_id: 'user-B', expected_control_revision: state.control_revision, accepted_at: NOW
  });
  state = acceptPOVWriterAudience(acceptedState, {
    audience: 'B', selection_revision: 1, idempotency_key: 'real-B-acceptance'
  }, {
    authenticated_user_id: 'user-B', expected_control_revision: acceptanceControlRevision, accepted_at: NOW
  });
  assert.deepEqual(state, acceptedState);
  state = freezeTurnBillingSelections(state);
  assert.equal(inspectTurnSelectionReadiness(state).ready, true);
  assert.throws(
    () => selectTurnPayer(state, sharedPayerCommand(), {
      authenticated_user_id: 'user-A', expected_control_revision: state.control_revision, accepted_at: NOW
    }),
    error => error.code === 'EXECUTION_PLAN_FROZEN'
  );
});

function stageBudget() {
  return {
    max_requests: 1,
    max_input_tokens: 100,
    max_output_tokens: 100,
    max_retries: 0,
    estimated_cost_cap: null
  };
}

function stagePlan(id, stage, audience = null) {
  return {
    plan_item_id: id,
    stage,
    audience,
    payer_user_id: 'user-A',
    payer_seat: 'A',
    profile_ref: profileRef(),
    capability_probe_ref: { probe_revision: 1, probe_hash: digest('probe-A') },
    transport: stage.startsWith('continuity_') ? 'json_protocol' : null,
    budget: stageBudget(),
    required_consent_subject_user_ids: audience === null
      ? ['user-A', 'user-B']
      : [MEMBERS[audience]]
  };
}

function billingPlan(state) {
  const plan = {
    schema: TURN_BILLING_PLAN_SCHEMA,
    turn_id: state.turn_id,
    plan_revision: 1,
    narrative_mode: 'dual_pov',
    turn_payer_selection_hash: state.turn_payer_selection.selection_hash,
    pov_writer_selection_hashes: {
      A: state.pov_writer_selections.A.selection_hash,
      B: state.pov_writer_selections.B.selection_hash
    },
    stage_plans: [
      ...SHARED_STAGE_NAMES.map(stage => stagePlan(`plan-${stage}`, stage)),
      stagePlan('plan-writer-A', 'writer', 'A'),
      stagePlan('plan-writer-B', 'writer', 'B')
    ],
    plan_hash: digest('placeholder'),
    created_at: NOW
  };
  plan.plan_hash = computeTurnBillingPlanHash(plan);
  return plan;
}

function executionGrant(plan, budgetOverrides = {}) {
  return {
    schema: EXECUTION_GRANT_SCHEMA,
    grant_id: 'grant-A-all-stages',
    grant_revision: 1,
    payer_user_id: 'user-A',
    room_id: 'room-1',
    epoch_id: 'epoch-1',
    profile_ref: profileRef(),
    stage_scopes: plan.stage_plans.map(item => ({ stage: item.stage, audience: item.audience })),
    authorization_scope: { kind: 'single_turn', turn_id: plan.turn_id },
    budget: {
      max_requests: 8,
      max_input_tokens: 800,
      max_output_tokens: 800,
      max_retries: 0,
      estimated_cost_cap: null,
      ...budgetOverrides
    },
    granted_at: NOW,
    expires_at: LATER,
    state: 'ACTIVE',
    revoked_at: null
  };
}

function preflightInput(state) {
  const plan = billingPlan(state);
  const terms = digest('terms-v1');
  const categories = digest('data-categories-v1');
  const consentRequirements = plan.stage_plans.map(item => ({
    plan_item_id: item.plan_item_id,
    terms_fingerprint: terms,
    data_categories_hash: categories
  }));
  const consents = [];
  for (const item of plan.stage_plans) {
    for (const subject of item.required_consent_subject_user_ids) {
      consents.push({
        consent_id: `consent-${item.plan_item_id}-${subject}`,
        subject_user_id: subject,
        consented_by_user_id: subject,
        room_id: 'room-1',
        epoch_id: 'epoch-1',
        turn_id: plan.turn_id,
        plan_item_id: item.plan_item_id,
        plan_revision: plan.plan_revision,
        plan_hash: plan.plan_hash,
        profile_id: item.profile_ref.profile_id,
        profile_config_fingerprint: item.profile_ref.config_fingerprint,
        normalized_origin: item.profile_ref.normalized_origin,
        terms_fingerprint: terms,
        data_categories_hash: categories,
        consented_at: NOW,
        expires_at: LATER,
        revoked_at: null
      });
    }
  }
  return {
    plan,
    payer_authorizations: [{
      authorization_id: 'authorization-A-plan-1',
      payer_user_id: 'user-A',
      authorized_by_user_id: 'user-A',
      turn_id: plan.turn_id,
      plan_revision: plan.plan_revision,
      plan_hash: plan.plan_hash,
      plan_item_ids: plan.stage_plans.map(item => item.plan_item_id),
      accepted_at: NOW
    }],
    consent_requirements: consentRequirements,
    consents,
    grants: [executionGrant(plan)],
    grant_allocations: plan.stage_plans.map(item => ({
      plan_item_id: item.plan_item_id,
      grant_id: 'grant-A-all-stages'
    })),
    consumed_budget_by_grant_id: {
      'grant-A-all-stages': { requests: 0, input_tokens: 0, output_tokens: 0, retries: 0 }
    },
    now: '2026-08-22T09:00:00.000Z'
  };
}

test('full-turn preflight blocks missing authority but not legacy budget metadata', () => {
  const state = readyDualBillingState();
  const missingConsent = preflightInput(state);
  missingConsent.consents.pop();
  assert.equal(inspectTurnBillingPlanAuthorization(state, missingConsent).ready, false);

  const missingGrant = preflightInput(state);
  missingGrant.grant_allocations.pop();
  assert.equal(inspectTurnBillingPlanAuthorization(state, missingGrant).ready, false);

  const insufficient = preflightInput(state);
  insufficient.grants = [executionGrant(insufficient.plan, { max_requests: 7 })];
  assert.equal(inspectTurnBillingPlanAuthorization(state, insufficient).ready, true);

  const forgedAuthorization = preflightInput(state);
  forgedAuthorization.payer_authorizations[0].authorized_by_user_id = 'user-B';
  assert.equal(inspectTurnBillingPlanAuthorization(state, forgedAuthorization).ready, false);

  assert.throws(
    () => assertModelInvocationAuthorized(state, {
      plan_revision: 1,
      plan_hash: missingConsent.plan.plan_hash,
      plan_item_id: 'plan-writer-B',
      payer_user_id: 'user-A',
      grant_id: 'grant-A-all-stages'
    }),
    error => error.code === 'BILLING_AUTHORIZATION_REQUIRED'
  );
});

test('provider/config, terms, categories and epoch changes invalidate old consent', () => {
  const state = readyDualBillingState();
  for (const mutate of [
    input => { input.consents[0].profile_config_fingerprint = digest('changed-profile'); },
    input => { input.consents[0].terms_fingerprint = digest('changed-terms'); },
    input => { input.consents[0].data_categories_hash = digest('changed-categories'); },
    input => { input.consents[0].epoch_id = 'epoch-old'; },
    input => { input.consents[0].consented_by_user_id = 'user-B'; }
  ]) {
    const input = preflightInput(state);
    mutate(input);
    assert.equal(inspectTurnBillingPlanAuthorization(state, input).ready, false);
  }
});

test('accepted plan reserves all stage budgets before allowing only its exact payer/grant invocation', () => {
  const state = readyDualBillingState();
  const input = preflightInput(state);
  const authorized = authorizeTurnBillingPlan(state, input);
  assert.equal(authorized.billing_preflight_receipt.authorized_plan_item_ids.length, 8);
  assert.equal(authorized.billing_preflight_receipt.budget_reservations[0].reserved_budget.requests, 8);
  const allowed = assertModelInvocationAuthorized(authorized, {
    plan_revision: input.plan.plan_revision,
    plan_hash: input.plan.plan_hash,
    plan_item_id: 'plan-writer-B',
    payer_user_id: 'user-A',
    grant_id: 'grant-A-all-stages'
  });
  assert.equal(allowed.authorized, true);
  assert.throws(
    () => assertModelInvocationAuthorized(authorized, {
      plan_revision: input.plan.plan_revision,
      plan_hash: input.plan.plan_hash,
      plan_item_id: 'plan-writer-B',
      payer_user_id: 'user-B',
      grant_id: 'grant-A-all-stages'
    }),
    error => error.code === 'BILLING_AUTHORIZATION_REQUIRED'
  );
});

console.log(`\n${passed} multiplayer lineage/billing domain regression tests passed.`);
