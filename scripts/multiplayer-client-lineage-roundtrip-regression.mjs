import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createNewMultiplayerGenesisState } from '../server/multiplayer/application/genesis-state.js';
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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timestamp = '2026-08-23T08:00:00.000Z';
const bindingSecret = 'client-roundtrip-binding-secret';
const users = Object.freeze({ A: 'owner_user', B: 'guest_user' });
const room = Object.freeze({
  room_id: 'room_roundtrip',
  origin_type: 'existing_save_derived',
  lineage_id: 'lineage_roundtrip',
  origin_owner_user_id: users.A,
  origin_snapshot_id: 'source_import_origin',
  genesis_checkpoint_id: 'checkpoint_roundtrip_c0'
});

function hash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function checkpoint({ id, turnNo, revision, parentId = null, turnId = null }) {
  const genesis = turnNo === 0;
  return Object.freeze({
    schema: ROOM_CHECKPOINT_SCHEMA,
    checkpoint_id: id,
    room_id: room.room_id,
    lineage_id: room.lineage_id,
    epoch_id: 'epoch_roundtrip',
    turn_no: turnNo,
    kind: genesis ? 'genesis' : 'turn_commit',
    parent_checkpoint_id: parentId,
    turn_id: turnId,
    commit_id: genesis ? null : `commit_roundtrip_${turnNo}`,
    state_revision: revision,
    state_hash: hash({ revision }),
    snapshot_ref: `snapshot_roundtrip_${revision}`,
    created_at: `2026-08-23T0${8 + turnNo}:00:00.000Z`
  });
}

const checkpoints = Object.freeze([
  checkpoint({ id: room.genesis_checkpoint_id, turnNo: 0, revision: 0 }),
  checkpoint({
    id: 'checkpoint_roundtrip_c1',
    turnNo: 1,
    revision: 1,
    parentId: room.genesis_checkpoint_id,
    turnId: 'turn_roundtrip_1'
  })
]);

function roomState(revision) {
  const state = structuredClone(createNewMultiplayerGenesisState({
    new_world_profile: {
      era: '木叶48年',
      actor_a: { display_name: '来源玩家', goal: '调查卷轴' },
      actor_b: { display_name: '客方玩家', goal: '保护队伍' }
    }
  }));
  state.meta.state_revision = revision;
  return state;
}

const states = new Map(checkpoints.map(item => [
  item.checkpoint_id,
  roomState(item.state_revision)
]));

function sourceTimeline() {
  const sourceState = {
    _version: '5.0',
    _meta: {
      current_node_id: 'node_source_owner',
      active_branch: 'branch_source_owner'
    },
    '系统·回合数': 3,
    '玩家·姓名': '来源玩家',
    '世界·时间': '木叶48年'
  };
  return {
    export_version: '2.0',
    exported_at: timestamp,
    include_archive: false,
    nodes: [{
      id: 'node_source_owner',
      parent_id: null,
      children_ids: [],
      branch_id: 'branch_source_owner',
      turn_number: 3,
      depth: 0,
      player_input: '来源存档起点',
      clean_response: '来源玩家已抵达村口。',
      state_snapshot: sourceState,
      summary: '来源起点',
      tags: [],
      is_checkpoint: true,
      created_at: Date.parse(timestamp),
      archived: false,
      archived_at: null
    }],
    branches: [{
      id: 'branch_source_owner',
      name: '来源主线',
      color: '#eb613f',
      description: '来源存档分支',
      created_at: Date.parse(timestamp),
      diverged_from: null,
      diverged_at_turn: null,
      head_node_id: 'node_source_owner',
      node_count: 1,
      is_active: true
    }],
    meta: {
      key: 'root',
      value: {
        root_id: 'node_source_owner',
        current_id: 'node_source_owner',
        active_branch: 'branch_source_owner',
        total_nodes: 1
      }
    }
  };
}

const materials = ['A', 'B'].map(seat => deterministicRoomActorBindingMaterial(
  bindingSecret,
  room,
  seat,
  `actor:${seat}`
));
const bindings = materials.map(material => Object.freeze({
  schema: ROOM_ACTOR_BINDING_SCHEMA,
  binding_id: material.binding_id,
  room_id: room.room_id,
  lineage_id: room.lineage_id,
  room_actor_id: material.room_actor_id,
  original_member_user_id: users[material.original_seat],
  original_seat: material.original_seat,
  genesis_checkpoint_id: room.genesis_checkpoint_id,
  signature_version: 'binding_signature_v1',
  opaque_binding_token: material.opaque_binding_token,
  created_at: timestamp
}));

function createServerExportHarness() {
  const output = new Map();
  let record = null;
  const codec = createMultiplayerToSingleplayerCodec();
  const lineageRepository = {
    bindings: {
      async verifyPairForPersonalExport({ authenticated_user_id, actor_bindings }) {
        assert.equal(authenticated_user_id, users.A);
        assert.deepEqual(actor_bindings, materials);
        return { exporting_seat: 'A', bindings };
      }
    },
    personalExports: {
      async begin(request) {
        record = {
          export_id: 'export_roundtrip_owner',
          room_id: room.room_id,
          checkpoint_id: request.checkpoint_id,
          exporting_user_id: users.A,
          exporting_seat: 'A',
          codec: request.codec,
          projection_version: request.projection_version,
          output_format: request.output_format,
          idempotency_key: request.idempotency_key,
          request_hash: hash(request),
          output_hash: null,
          output_ref: null,
          status: 'PENDING',
          failure_code: null,
          created_at: timestamp,
          completed_at: null,
          replayed: false
        };
        return { ...record };
      },
      async complete(request) {
        record = {
          ...record,
          output_hash: request.output_hash,
          output_ref: request.output_ref,
          status: 'READY',
          completed_at: timestamp
        };
        return { ...record };
      },
      async markFailed() {
        record = { ...record, status: 'FAILED' };
        return { ...record };
      },
      async getForDownload() {
        return { ...record };
      }
    }
  };
  const service = createPersonalSingleplayerExportService({
    lineageRepository,
    coreRepositories: {
      actions: {
        async getForMember() {
          return {
            turn_id: 'turn_roundtrip_1',
            turn_no: 1,
            viewer_seat: 'A',
            status: 'COMMITTED',
            active_narrative_mode: 'shared',
            actions: {
              A: {
                locked: true,
                text: 'OWNER_MULTIPLAYER_ACTION',
                disclosure: 'owner'
              },
              B: {
                locked: true,
                text: 'COUNTERPART_UI_ONLY_ACTION',
                disclosure: 'full_after_commit'
              }
            }
          };
        }
      }
    },
    snapshotService: {
      async readInternal({ checkpoint_id }) {
        const item = checkpoints.find(candidate => candidate.checkpoint_id === checkpoint_id);
        return {
          room_id: room.room_id,
          epoch_id: item.epoch_id,
          checkpoint_id,
          state_revision: item.state_revision,
          state_hash: item.state_hash,
          state: states.get(checkpoint_id)
        };
      }
    },
    exportSourceRepository: {
      async loadCheckpointChain() {
        return {
          room,
          exporting_member: { user_id: users.A, seat: 'A' },
          members_by_seat: users,
          binding_bootstrap: materials.map(material => ({
            binding_id: material.binding_id,
            room_actor_id: material.room_actor_id,
            original_seat: material.original_seat,
            genesis_checkpoint_id: room.genesis_checkpoint_id
          })),
          source_basis: {
            type: 'origin_snapshot',
            ref_id: room.origin_snapshot_id,
            source_branch_id: 'branch_source_owner',
            source_node_id: 'node_source_owner'
          },
          checkpoint_chain: checkpoints.map((item, index) => ({
            checkpoint: item,
            turn: index === 0 ? null : {
              turn_id: 'turn_roundtrip_1',
              turn_no: 1,
              narrative_mode: 'shared'
            }
          }))
        };
      },
      async getNarrativeForMember() {
        return {
          turn_id: 'turn_roundtrip_1',
          mode: 'shared',
          audience: 'shared',
          text: '双方绕过林间陷阱，继续向任务地前进。'
        };
      }
    },
    sourceTimelineReader: {
      async getForOwner() {
        return {
          timeline: sourceTimeline(),
          source_branch_id: 'branch_source_owner',
          source_node_id: 'node_source_owner'
        };
      }
    },
    outputStore: {
      async put({ output_hash, content }) {
        output.set(output_hash, canonicalizeJson(content));
        return { output_ref: output_hash };
      },
      async get({ output_ref }) {
        return { output_hash: output_ref, content: output.get(output_ref) };
      }
    },
    codec,
    bindingTokenSecret: bindingSecret
  });
  return service;
}

const service = createServerExportHarness();
const generated = await service.beginSinglePlayerExport({
  authenticated_user_id: users.A,
  room_id: room.room_id,
  checkpoint_id: 'checkpoint_roundtrip_c1',
  request: {
    idempotency_key: 'client-roundtrip-export',
    projection_version: 'projection-v1',
    output_format: 'timeline-json-v1'
  }
});
const downloaded = await service.downloadSinglePlayerExport({
  authenticated_user_id: users.A,
  room_id: room.room_id,
  export_id: generated.export.export_id
});
const serverDocument = downloaded.content;
assert.equal(
  serverDocument.multiplayer_record_sidecar.multiplayer_records[0].counterpart_action_text,
  'COUNTERPART_UI_ONLY_ACTION'
);

const browserEntry = `
  import { stateManager } from '/js/core/state-manager.js';
  import { timelineSystem } from '/js/systems/timeline-system.js';
  import { personalSaveLibrary } from '/js/core/personal-save-library.js';
  import { encodeTimelineSave, decodeTimelineSaveFile } from '/js/core/timeline-file-codec.js';
  import {
    normalizeLatestSourceSaveImportCandidate,
    resolveLatestSourceContinuationBinding
  } from '/js/multiplayer/latest-source-import.js';

  window.runLineageRoundTrip = async (serverDocument, initialLineage) => {
    const importedArchive = await personalSaveLibrary.importData(serverDocument);
    await personalSaveLibrary.load(importedArchive.id);
    const token = serverDocument.multiplayer_record_sidecar.actor_bindings[0].opaque_binding_token;
    const persistedMeta = await stateManager.dbGet('timeline_meta', 'root');
    const importedState = stateManager.snapshot();
    const nextState = stateManager.snapshot();
    nextState['世界·时间'] = '木叶49年1月1日';
    nextState['系统·回合数'] = 6;
    const localNode = await timelineSystem.createNode({
      turnNumber: 6,
      playerInput: 'LOCAL_L2_OWNER_ACTION',
      aiResponse: '单机 L2 剧情继续。',
      cleanResponse: '单机 L2 剧情继续。',
      stateSnapshot: nextState,
      chatHistory: [
        { role: 'user', content: 'LOCAL_L2_OWNER_ACTION' },
        { role: 'assistant', content: '单机 L2 剧情继续。' }
      ]
    });
    const exported = await timelineSystem.getExportData();
    const jsonEncoded = await encodeTimelineSave(exported, { compression: 'json' });
    const jsonDecoded = await decodeTimelineSaveFile(jsonEncoded.blob);
    const gzipEncoded = await encodeTimelineSave(exported, { compression: 'gzip' });
    const gzipDecoded = await decodeTimelineSaveFile(gzipEncoded.blob);
    const first = normalizeLatestSourceSaveImportCandidate(jsonDecoded, {
      lineage: initialLineage
    });
    const repeated = normalizeLatestSourceSaveImportCandidate(first, {
      lineage: initialLineage
    });
    const latestProjection = {
      source_import_id: 'source_import_roundtrip_l2',
      proposal_id: first.proposal_id,
      proposal_revision: first.proposal_revision,
      audience_diff_commitment: 'hmac-sha256:roundtrip',
      source: {
        source_save_id: first.source_save_id,
        client_save_instance_id: first.client_save_instance_id,
        source_branch_id: first.source_branch_id,
        source_node_id: first.source_node_id,
        cloud_revision: first.cloud_revision,
        derived_from_export_id: jsonDecoded.multiplayer_export.export_id
      }
    };
    const recoveredLineage = {
      ...initialLineage,
      source_imports: [...initialLineage.source_imports, latestProjection]
    };
    const staged = {
      import: {
        source_import_id: latestProjection.source_import_id,
        proposal_id: latestProjection.proposal_id,
        proposal_revision: latestProjection.proposal_revision
      },
      client_source_binding: { ...latestProjection.source }
    };
    const stagedRecovered = normalizeLatestSourceSaveImportCandidate(gzipDecoded, {
      lineage: initialLineage,
      staged
    });
    const recovered = normalizeLatestSourceSaveImportCandidate(gzipDecoded, {
      lineage: recoveredLineage,
      staged
    });
    const continuation = resolveLatestSourceContinuationBinding({
      sourceImportId: latestProjection.source_import_id,
      lineage: recoveredLineage,
      staged
    });
    const agentVisible = JSON.stringify({
      nodes: exported.nodes,
      branches: exported.branches,
      meta: exported.meta
    });
    return {
      tokenPersistedOnlyInNonAgentMeta: JSON.stringify(persistedMeta).includes(token),
      tokenAbsentFromImportedState: !JSON.stringify(importedState).includes(token),
      tokenAbsentFromLocalNode: !JSON.stringify(localNode).includes(token),
      tokenAbsentFromAgentTimeline: !agentVisible.includes(token),
      counterpartAbsentFromAgentTimeline: !agentVisible.includes('COUNTERPART_UI_ONLY_ACTION'),
      counterpartPreservedInSidecar:
        exported.multiplayer_record_sidecar.multiplayer_records[0].counterpart_action_text,
      internalMetaStripped:
        !Object.prototype.hasOwnProperty.call(exported.meta.value, '_multiplayer_non_agent_metadata'),
      metadataPreserved:
        JSON.stringify(exported.multiplayer_export) === JSON.stringify(serverDocument.multiplayer_export),
      sidecarPreserved:
        JSON.stringify(exported.multiplayer_record_sidecar)
          === JSON.stringify(serverDocument.multiplayer_record_sidecar),
      jsonAndGzipAgree: JSON.stringify(jsonDecoded) === JSON.stringify(gzipDecoded),
      currentNodeId: jsonDecoded.meta.value.current_id,
      localNodeId: localNode.id,
      sourceDocumentNodeId: first.source_document.meta.value.current_id,
      proposalStable:
        first.proposal_id === repeated.proposal_id
        && first.proposal_revision === repeated.proposal_revision
        && first.idempotency_key === repeated.idempotency_key,
      proposalRecovered:
        recovered.proposal_id === first.proposal_id
        && recovered.proposal_revision === first.proposal_revision
        && continuation.proposal_id === first.proposal_id
        && continuation.proposal_revision === first.proposal_revision,
      stagedProposalRecovered:
        stagedRecovered.proposal_id === first.proposal_id
        && stagedRecovered.proposal_revision === first.proposal_revision,
      sourceIdentityRecovered:
        first.source_save_id === 'save_roundtrip_origin'
        && first.client_save_instance_id === 'instance_roundtrip_origin'
    };
  };
  window.__roundtripReady = true;
`;

const mimeTypes = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
});

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': mimeTypes['.html'], 'Cache-Control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/roundtrip-entry.js"></script>');
      return;
    }
    if (url.pathname === '/roundtrip-entry.js') {
      response.writeHead(200, { 'Content-Type': mimeTypes['.js'], 'Cache-Control': 'no-store' });
      response.end(browserEntry);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(projectRoot, relative);
    if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error));
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.__roundtripReady === true);
  const initialLineage = {
    source_imports: [{
      source_import_id: 'source_import_roundtrip_origin',
      proposal_id: 'proposal_roundtrip_origin',
      proposal_revision: 1,
      source: {
        source_save_id: 'save_roundtrip_origin',
        client_save_instance_id: 'instance_roundtrip_origin',
        source_branch_id: 'branch_source_owner',
        source_node_id: 'node_source_owner',
        cloud_revision: null,
        derived_from_export_id: null
      }
    }]
  };
  const result = await page.evaluate(
    ([document, lineage]) => window.runLineageRoundTrip(document, lineage),
    [serverDocument, initialLineage]
  );
  assert.deepEqual(errors, []);
  assert.equal(result.tokenPersistedOnlyInNonAgentMeta, true);
  assert.equal(result.tokenAbsentFromImportedState, true);
  assert.equal(result.tokenAbsentFromLocalNode, true);
  assert.equal(result.tokenAbsentFromAgentTimeline, true);
  assert.equal(result.counterpartAbsentFromAgentTimeline, true);
  assert.equal(result.counterpartPreservedInSidecar, 'COUNTERPART_UI_ONLY_ACTION');
  assert.equal(result.internalMetaStripped, true);
  assert.equal(result.metadataPreserved, true);
  assert.equal(result.sidecarPreserved, true);
  assert.equal(result.jsonAndGzipAgree, true);
  assert.equal(result.currentNodeId, result.localNodeId);
  assert.equal(result.sourceDocumentNodeId, result.localNodeId);
  assert.equal(result.proposalStable, true);
  assert.equal(result.proposalRecovered, true);
  assert.equal(result.stagedProposalRecovered, true);
  assert.equal(result.sourceIdentityRecovered, true);
  console.log('multiplayer client lineage roundtrip regression: server export -> Chromium IndexedDB timeline -> L2 JSON/gzip -> latest-source request passed');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
