import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';
import { createProviderModelClient } from '../server/multiplayer/agent/provider-adapters.js';
import { createMultiplayerRuntime } from '../server/multiplayer/application/runtime.js';
import { ACTION_REQUEST_SCHEMA } from '../server/multiplayer/domain/action-turn.js';
import {
  MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
  SHARED_STAGE_DATA_CATEGORIES
} from '../server/multiplayer/persistence/sqlite-billing-repository.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

const NPC_ID = 'npc:e2e_scout';
const MISSION_ID = 'mission:e2e_active_patrol';
const PROVIDER_USAGE = Object.freeze({
  prompt_tokens: 32,
  completion_tokens: 24,
  total_tokens: 56
});

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const masterKey = label => createHash('sha256').update(label).digest('base64');

function sequentialIdFactory(namespace) {
  const counters = new Map();
  return kind => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_${namespace}_${next}`;
  };
}

function jsonPrompt(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry?.role !== 'user' || typeof entry.content !== 'string') continue;
    try {
      const value = JSON.parse(entry.content);
      if (typeof value?.stage === 'string') return value;
    } catch {}
  }
  throw new Error('fake provider received no stage prompt');
}

function resolutionCandidate(prompt) {
  const submissionIds = (
    prompt.trusted_opening_anchors ?? prompt.untrusted_player_actions
  ).map(action => action.submission_id);
  const turnNo = prompt.trusted_context.turn_no;
  const sharedEventId = `event_e2e_joint_observation_${turnNo}`;
  const privateEventId = `event_e2e_private_observation_${turnNo}`;
  const actorA = prompt.trusted_context.base_state.actors.A.room_actor_id;
  const actorB = prompt.trusted_context.base_state.actors.B.room_actor_id;
  assert.equal(submissionIds.length, 2);
  const effects = turnNo === 1 ? [{
    effect_id: 'effect_e2e_npc_profile',
    depends_on_effect_ids: [],
    event_id: sharedEventId,
    target: { scope: 'npc_profile', npc_id: NPC_ID },
    domain: 'relationship',
    kind: 'npc_profile',
    operation: 'upsert',
    payload: {
      expected_version: null,
      next_version: 1,
      display_name: '村口斥候',
      faction: '木叶',
      rank: '下忍',
      public_status: 'ACTIVE',
      evidence_event_ids: [sharedEventId]
    },
    provenance: 'referee',
    visibility: 'server_only',
    evidence_event_ids: [sharedEventId]
  }, {
    effect_id: 'effect_e2e_mission_create',
    depends_on_effect_ids: [],
    event_id: sharedEventId,
    target: { scope: 'mission', mission_id: MISSION_ID, mission_scope: 'shared' },
    domain: 'mission',
    kind: 'mission',
    operation: 'create',
    payload: {
      expected_version: null,
      next_version: 1,
      title: '村口联合巡查',
      initial_status: 'OFFERED',
      progress_current: 0,
      progress_total: 3,
      assignee_actor_ids: [actorA, actorB]
    },
    provenance: 'referee',
    visibility: 'server_only',
    evidence_event_ids: [sharedEventId]
  }, {
    effect_id: 'effect_e2e_mission_accept',
    depends_on_effect_ids: ['effect_e2e_mission_create'],
    event_id: sharedEventId,
    target: { scope: 'mission', mission_id: MISSION_ID, mission_scope: 'shared' },
    domain: 'mission',
    kind: 'mission',
    operation: 'transition',
    payload: {
      expected_version: 1,
      next_version: 2,
      from_status: 'OFFERED',
      to_status: 'ACCEPTED'
    },
    provenance: 'referee',
    visibility: 'server_only',
    evidence_event_ids: [sharedEventId]
  }, {
    effect_id: 'effect_e2e_mission_activate',
    depends_on_effect_ids: ['effect_e2e_mission_accept'],
    event_id: sharedEventId,
    target: { scope: 'mission', mission_id: MISSION_ID, mission_scope: 'shared' },
    domain: 'mission',
    kind: 'mission',
    operation: 'transition',
    payload: {
      expected_version: 2,
      next_version: 3,
      from_status: 'ACCEPTED',
      to_status: 'ACTIVE'
    },
    provenance: 'referee',
    visibility: 'server_only',
    evidence_event_ids: [sharedEventId]
  }] : [];
  return {
    schema: 'naruto.multiplayer-resolution-candidate/v1',
    conflicts: [{
      id: 'conflict_e2e_shared_observation',
      type: 'independent',
      submission_ids: submissionIds,
      rule_basis: ['双方只交换观察结果，不争夺资源，也不主张额外机械收益。']
    }],
    outcomes: submissionIds.map((submissionId, index) => ({
      submission_id: submissionId,
      status: 'success',
      reason: turnNo === 1
        ? '观察与交流可以同时成立，并建立了联合巡查任务。'
        : '观察与交流可以同时成立，活动任务及其他机械状态保持不变。',
      event_ids: index === 0
        ? [sharedEventId, privateEventId]
        : [sharedEventId]
    })),
    events: [{
      event_id: sharedEventId,
      summary: '两名忍者在村口交换了各自观察到的天气与道路情况。',
      audiences: ['seat:A', 'seat:B', NPC_ID],
      world_public: turnNo !== 1,
      effect_ids: effects.map(effect => effect.effect_id)
    }, {
      event_id: privateEventId,
      summary: '甲私下记住了云层变化中尚未确认的细节。',
      audiences: ['seat:A'],
      world_public: false,
      effect_ids: []
    }],
    effects,
    elapsed_time: '片刻',
    stop_point: '两人已经交换完情报，下一步行动仍交由玩家决定。'
  };
}

function narrativeCandidate(prompt) {
  assert.equal(prompt.audience, 'shared');
  const eventId = prompt.trusted_audience_projection.events[0].event_id;
  return {
    segments: [{
      segment_id: 'segment_e2e_shared_observation',
      event_refs: [eventId],
      claims: [{
        event_id: eventId,
        subject_id: 'world:village_gate',
        predicate: 'observations_exchanged',
        value: true
      }],
      text: '村口的风掠过树梢，两人把沿途所见简短对照了一遍。天气与道路情形都已说清，他们停下来，把接下来的选择留在此刻。'
    }],
    stop_point_ref: eventId
  };
}

function memoryItem(obligationId, summary, eventId, subjectRefs) {
  return {
    obligation_id: obligationId,
    summary,
    entries: [{
      kind: 'fact',
      text: summary,
      event_refs: [eventId],
      subject_refs: subjectRefs
    }],
    supersede_entry_ids: [],
    retract_entry_ids: []
  };
}

function baselineOnlyDaily(displayDate, issueNo) {
  const noPublicMission = rank => ({
    rank,
    task: `${rank}级公开委托本期暂无可核验条目`,
    pay: '未公布',
    status: '待公开资料'
  });
  return {
    schema: 'naruto.shinobi-daily/v1',
    date: displayDate,
    issue: `第 ${issueNo} 号`,
    headline: {
      title: '公开纪年资料完成本期核验',
      body: `权威公开记录确认当前纪年为${displayDate}。本期没有可核验的世界公开事件或其他公共事实，因此各栏只回顾这一纪年基线，不采写未经裁决的离屏动态。`,
      sig: '本报资料校验组'
    },
    world: [{
      tag: '纪年',
      title: '当前公开纪年完成核验',
      text: `权威公开记录当前标注为${displayDate}，本栏不据此推断任何未公开的地区事件。`
    }, {
      tag: '资料',
      title: '公开资料范围保持克制',
      text: `除当前纪年${displayDate}外，本期没有收到可核验的公开地区动态，因此不作事件性报道。`
    }, {
      tag: '记录',
      title: '未裁决动态不作报道',
      text: `本期只登记权威公开纪年${displayDate}，没有公开来源的离屏动态不会被补写为新闻。`
    }, {
      tag: '存档',
      title: '后续动态等待公开来源',
      text: `当前可核验背景仍为${displayDate}，新的地区消息须先进入权威公开记录后再行刊载。`
    }],
    flavor: [{
      mark: '纪',
      title: '纪年栏完成资料复核',
      text: `资料员已核对${displayDate}这一公开纪年，未从中延伸任何事件性结论。`
    }, {
      mark: '核',
      title: '无来源消息暂不收录',
      text: '没有进入权威公开记录的消息继续留空，不以传闻或想象补足版面。'
    }, {
      mark: '录',
      title: '公开记录后续再更新',
      text: '新的可核验事实出现后再按来源更新，本期不预写尚未发生或未公开的动态。'
    }],
    missions: ['D', 'C', 'B', 'A'].map(noPublicMission),
    quote: {
      text: '没有公开来源的消息，不应写成已经发生的事实。',
      who: '忍界日报资料守则'
    }
  };
}

function continuityEnvelope(prompt, {
  operation = 'stage_turn_bundle',
  bundleMode = 'full'
} = {}) {
  const obligations = prompt.trusted_update_obligations;
  const state = prompt.trusted_base_state_summary;
  const actorA = state.actors.A.room_actor_id;
  const actorB = state.actors.B.room_actor_id;
  const canonicalResolution = prompt.trusted_canonical_resolution;
  const evidenceEventId = canonicalResolution.events[0].event_id;
  const memoryProjections = prompt.trusted_audience_projections.memory_partitions;
  const publicProjection = prompt.trusted_world_public_projection;
  const publicRef = publicProjection.events.length > 0
    ? `public:${publicProjection.events[0].event_id}`
    : publicProjection.facts[0].fact_id;
  assert.match(publicRef, /^public:/u);
  const baselineOnly = publicProjection.events.length === 0
    && publicProjection.facts.length === 1
    && publicRef.startsWith('public:authority:calendar:');
  const refs = () => [publicRef];
  const memories = obligations.artifact_obligations
    .filter(item => item.kind === 'memory')
    .map(obligation => {
      const projection = memoryProjections[obligation.target_binding];
      assert.ok(projection?.events.length > 0, obligation.target_binding);
      const subjectRefs = obligation.target_binding.startsWith('npc:')
        ? [obligation.target_binding.slice(0, -':private'.length)]
        : obligation.target_binding === 'actor:A'
          ? [actorA]
          : obligation.target_binding === 'actor:B'
            ? [actorB]
            : [actorA, actorB];
      return memoryItem(
        obligation.obligation_id,
        `连续性记忆：${obligation.target_binding}`,
        projection.events[0].event_id,
        subjectRefs
      );
    });
  const shinobiDaily = [{
    obligation_id: 'obligation_daily_world_public',
    daily: baselineOnly
      ? baselineOnlyDaily(
          state.shared_world.calendar.display_date,
          state.meta.state_revision + 1
        )
      : structuredClone(SHINOBI_DAILY_EXAMPLE),
    source_refs: {
      headline: refs(),
      world: Array.from({ length: 4 }, refs),
      flavor: Array.from({ length: 3 }, refs),
      missions: Array.from({ length: 4 }, refs),
      quote: refs()
    }
  }];
  const fullBundle = {
    effect_ids: obligations.effect_obligations.map(item => item.effect_id),
    domain_checks: obligations.domain_obligations
      .filter(item => item.satisfied_by_effect_ids.length === 0)
      .map(item => ({
        obligation_id: item.obligation_id,
        reason_code: 'NO_CANONICAL_CHANGE',
        evidence_event_ids: [evidenceEventId]
      })),
    memories,
    shinobi_daily: shinobiDaily
  };
  const bundle = bundleMode === 'empty'
    ? {}
    : bundleMode === 'without_daily'
      ? { ...fullBundle, shinobi_daily: [] }
      : bundleMode === 'daily_only'
        ? { shinobi_daily: shinobiDaily }
        : fullBundle;
  return {
    protocol: 'naruto.continuity-json/v1',
    operation,
    bundle
  };
}

function responseFor(prompt, continuityScenario) {
  switch (prompt.stage) {
    case 'referee':
      return resolutionCandidate(prompt);
    case 'resolution_completeness_reviewer':
      return {
        schema: 'naruto.multiplayer-resolution-completeness-review/v1',
        status: 'APPROVED',
        findings: []
      };
    case 'writer':
      return narrativeCandidate(prompt);
    case 'narrative_grounding_reviewer':
      return {
        schema: 'naruto.multiplayer-narrative-grounding-candidate/v1',
        reviews: prompt.candidate_deliveries.map(delivery => ({
          audience: delivery.audience,
          status: 'APPROVED',
          findings: []
        }))
      };
    case 'continuity_steward':
      if (continuityScenario.enabled) {
        continuityScenario.calls += 1;
        if (continuityScenario.calls === 1) {
          return continuityEnvelope(prompt, { bundleMode: 'without_daily' });
        }
        if (continuityScenario.calls <= 3) {
          return continuityEnvelope(prompt, {
            operation: 'repair_turn_bundle',
            bundleMode: 'empty'
          });
        }
        return continuityEnvelope(prompt, {
          operation: 'repair_turn_bundle',
          bundleMode: 'daily_only'
        });
      }
      return continuityEnvelope(prompt);
    default:
      throw new Error(`fake provider received unexpected stage ${prompt.stage}`);
  }
}

function createFakeProvider() {
  const calls = [];
  const prompts = [];
  const continuityScenario = { enabled: false, calls: 0 };
  const resolutionScenario = { enabled: false, calls: 0, feedback: [] };
  const memoryReferenceScenario = { enabled: false, calls: 0, feedback: [] };
  let sequence = 0;
  let observer = null;
  const client = createProviderModelClient({
    modelHttpGateway: {
      async invoke({ body }) {
        observer?.();
        const prompt = jsonPrompt(body.messages);
        sequence += 1;
        calls.push(prompt.stage);
        prompts.push(prompt);
        const response = responseFor(prompt, continuityScenario);
        if (memoryReferenceScenario.enabled && prompt.stage === 'continuity_steward') {
          memoryReferenceScenario.calls += 1;
          const repair = memoryReferenceScenario.calls > 1;
          const memories = response.bundle.memories.filter(item => (
            ['obligation_memory_canonical', 'obligation_memory_shared'].includes(item.obligation_id)
          ));
          for (const memory of memories) {
            const binding = prompt.trusted_reference_bindings?.[memory.obligation_id];
            memory.entries[0].subject_refs = repair && binding
              ? [binding.stableSubjectIds[0]]
              : (repair ? memory.entries[0].event_refs : ['World', 'Konoha']);
          }
          if (repair) {
            response.operation = 'repair_turn_bundle';
            response.bundle = { memories };
            const feedback = body.messages.filter(message => message.role === 'user')
              .map(message => JSON.parse(message.content)).filter(message => message.protocol_result);
            memoryReferenceScenario.feedback.push(...feedback.map(message => message.protocol_result));
            if (prompt.trusted_reference_bindings) memoryReferenceScenario.enabled = false;
          }
        }
        if (resolutionScenario.enabled && prompt.stage === 'referee') {
          resolutionScenario.calls += 1;
          const feedback = body.messages.filter(message => message.role === 'user')
            .map(message => JSON.parse(message.content)).filter(message => message.protocol_result);
          resolutionScenario.feedback.push(...feedback.map(message => message.protocol_result));
          if (resolutionScenario.calls === 1) {
            const actors = prompt.trusted_context.base_state.actors;
            response.events.forEach(event => { event.audiences = [actors.A.room_actor_id, actors.B.room_actor_id]; });
          } else if (resolutionScenario.calls === 2) {
            response.effects[0].domain = 'world_state';
            response.effects[0].kind = 'scene_placement';
            response.effects[0].operation = 'set_presence_context';
          } else {
            resolutionScenario.enabled = false;
          }
        }
        return {
          provider_request_id: `provider_e2e_${sequence}`,
          body: {
            id: `response_e2e_${sequence}`,
            choices: [{
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify(response)
              }
            }],
            usage: PROVIDER_USAGE
          }
        };
      }
    }
  });
  return {
    client,
    observeInvocations(callback) { observer = callback; },
    calls,
    prompts,
    continuityScenario,
    resolutionScenario,
    memoryReferenceScenario,
    beginMemoryReferenceScenario() { memoryReferenceScenario.enabled = true; },
    beginResolutionRepairScenario() { resolutionScenario.enabled = true; },
    beginContinuityRepairScenario() {
      continuityScenario.enabled = true;
      continuityScenario.calls = 0;
    }
  };
}

function grantBudget(plan) {
  return plan.stage_plans.reduce((total, item) => ({
    max_requests: total.max_requests + item.budget.max_requests,
    max_input_tokens: total.max_input_tokens + item.budget.max_input_tokens,
    max_output_tokens: total.max_output_tokens + item.budget.max_output_tokens,
    max_retries: total.max_retries + item.budget.max_retries,
    estimated_cost_cap: null
  }), {
    max_requests: 0,
    max_input_tokens: 0,
    max_output_tokens: 0,
    max_retries: 0,
    estimated_cost_cap: null
  });
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-runtime-sqlite-e2e-'));
const databasePath = path.join(tempRoot, 'multiplayer.sqlite');
const fakeProvider = createFakeProvider();
const invocationIdFactory = sequentialIdFactory('invocation');
const commandAttemptIdFactory = sequentialIdFactory('command_attempt');
const runtime = await createMultiplayerRuntime({
  databasePath,
  keyVersion: 'v1',
  contentMasterKey: masterKey('runtime-e2e-content'),
  credentialMasterKey: masterKey('runtime-e2e-credential'),
  credentialFingerprintKey: masterKey('runtime-e2e-fingerprint'),
  actionCommitmentSecret: masterKey('runtime-e2e-action-commitment'),
  lineageSigningSecret: masterKey('runtime-e2e-lineage'),
  proposalCommitmentSecret: masterKey('runtime-e2e-proposal')
}, {
  startDispatcher: false,
  startResolutionWorker: false,
  openConnection: openMultiplayerRepositoryTestSqlite,
  providerModelClient: fakeProvider.client,
  roomApplicationOptions: { idFactory: sequentialIdFactory('room') },
  coreRepositoryOptions: { idFactory: sequentialIdFactory('core') },
  billingRepositoryOptions: { idFactory: sequentialIdFactory('billing') },
  // Deliberately retain the former tiny authorization metadata. The regression
  // proves it no longer caps actual automatic model calls.
  stageBudget: {
    max_requests: 2,
    max_input_tokens: 128_000,
    max_output_tokens: 8_000,
    max_retries: 1,
    estimated_cost_cap: null
  },
  billingPlanServiceOptions: { idFactory: sequentialIdFactory('plan') },
  turnWorkflowRepositoryOptions: {
    idFactory: sequentialIdFactory('workflow'),
    // These compact provider fixtures test transaction/state semantics. Prose
    // length and meta commentary repair are covered by the Agent runtime test.
    styleRequirements: { minimum_characters: 0 },
    publicFactsProvider: () => []
  },
  commitRepositoryOptions: { idFactory: sequentialIdFactory('commit') },
  resolutionWorkerOptions: {
    owner_boot_id: 'boot_runtime_e2e',
    task_id_factory: () => 'task_runtime_e2e',
    invocation_id_factory: () => invocationIdFactory('invocation'),
    command_attempt_id_factory: () => commandAttemptIdFactory('command_attempt'),
    heartbeat_enabled: false
  }
});

try {
  let room;
  let profile;
  let selection;
  let turnId;
  let runId;
  let plan;

  await test('production runtime creates and activates a two-member SQLite room', async () => {
    const created = await runtime.services.rooms.create({
      authenticated_user_id: 'host_runtime_e2e',
      request: {
        origin_type: 'new_multiplayer_save',
        new_world_profile: {
          era: '木叶48年',
          preset_id: 'preset:konoha',
          actor_a: { display_name: '甲' },
          actor_b: { display_name: '乙' }
        },
        default_narrative_mode: 'shared'
      }
    });
    room = created.room;
    await runtime.repositories.core.invites.join({
      authenticated_user_id: 'guest_runtime_e2e',
      room_id: room.room_id,
      token: created.invite.token
    });
    const hostRoom = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id
    });
    await runtime.services.rooms.ready({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      request: {
        expected_control_revision: hostRoom.control_revision,
        opening_revision: hostRoom.opening.drafts.A.revision,
        opening_commitment: hostRoom.opening.drafts.A.commitment
      }
    });
    const guestRoom = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'guest_runtime_e2e',
      room_id: room.room_id
    });
    const activated = await runtime.services.rooms.ready({
      authenticated_user_id: 'guest_runtime_e2e',
      room_id: room.room_id,
      request: {
        expected_control_revision: guestRoom.control_revision,
        opening_revision: guestRoom.opening.drafts.B.revision,
        opening_commitment: guestRoom.opening.drafts.B.commitment
      }
    });
    assert.equal(activated.room.lifecycle, 'ACTIVE');
    assert.equal(activated.turn.status, 'AWAITING_PAYER_SELECTION');
    room = activated.room;
    turnId = activated.turn.turn_id;
  });

  await test('both members lock actions and the sealed turn owns one durable QUEUED run', async () => {
    profile = (await runtime.repositories.billing.profiles.createVersion({
      authenticated_user_id: 'host_runtime_e2e',
      profile_id: 'profile_runtime_e2e',
      expected_config_revision: 0,
      adapter: 'openai_compatible',
      base_url: 'https://models.example.com/v1',
      model: 'fake-runtime-model',
      auth_scheme: 'none',
      credential_ref: null,
      capabilities: {},
      recommended_continuity_transport: null
    })).profile.profile;
    const beforeSelection = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id
    });
    selection = (await runtime.repositories.billing.selections.selectShared({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 1,
      endpoint_profile_id: profile.profile_id,
      expected_selection_revision: 0,
      expected_control_revision: beforeSelection.control_revision,
      idempotency_key: 'selection-runtime-e2e'
    })).selection;
    const probeCount = runtime.connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM model_capability_probes
    `).get().count);
    assert.equal(probeCount, 0, 'formal execution must not require a capability probe');
    for (const userId of ['host_runtime_e2e', 'guest_runtime_e2e']) {
      await runtime.repositories.billing.consents.grant({
        authenticated_user_id: userId,
        room_id: room.room_id,
        epoch_id: room.active_epoch_id,
        selection_hash: selection.selection_hash,
        config_fingerprint: profile.config_fingerprint,
        terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
        data_categories: SHARED_STAGE_DATA_CATEGORIES
      });
    }
    await runtime.repositories.core.turns.lockAction({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 1,
      submission_kind: 'SERVER_OPENING_ANCHOR',
      request: {
        schema: ACTION_REQUEST_SCHEMA,
        base_state_revision: 0,
        text: '我观察天气，并把看到的云层变化告诉同伴。',
        pre_resolution_visibility: 'sealed',
        narration_preference: 'full',
        idempotency_key: 'action-host-runtime-e2e'
      }
    });
    const sealed = await runtime.repositories.core.turns.lockAction({
      authenticated_user_id: 'guest_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 1,
      submission_kind: 'SERVER_OPENING_ANCHOR',
      request: {
        schema: ACTION_REQUEST_SCHEMA,
        base_state_revision: 0,
        text: '我观察村口道路，然后把通行情况告诉同伴。',
        pre_resolution_visibility: 'sealed',
        narration_preference: 'full',
        idempotency_key: 'action-guest-runtime-e2e'
      }
    });
    assert.equal(sealed.turn_status, 'AWAITING_BILLING_AUTHORIZATION');
    assert.equal(sealed.sealed_finalization.run_id.startsWith('run_'), true);
    runId = sealed.sealed_finalization.run_id;
    plan = runtime.repositories.billing.plans.getLatest({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      turn_id: turnId
    });
    assert.ok(plan.stage_plans.every(item => item.capability_probe_ref === null));
    assert.ok(plan.stage_plans.every(item => item.transport === 'json_protocol'));
    const durable = runtime.connection.read(database => ({
      run: database.prepare(`
        SELECT run_status, turn_id FROM resolution_runs WHERE run_id = ?
      `).get(runId),
      actions: database.prepare(`
        SELECT COUNT(*) AS count FROM action_submissions WHERE turn_id = ?
      `).get(turnId).count
    }));
    assert.deepEqual(durable.run, { run_status: 'QUEUED', turn_id: turnId });
    assert.equal(durable.actions, 2);
    assert.deepEqual(runtime.repositories.leases.listClaimable({
      now: new Date().toISOString()
    }), []);
    await assert.rejects(
      runtime.resolutionWorker.process(runId),
      error => error?.code === 'RUN_LEASE_NOT_CLAIMABLE'
    );
    assert.equal(fakeProvider.calls.length, 0);
  });

  await test('payer grant authorizes every frozen stage before the first provider call', async () => {
    const grant = (await runtime.repositories.billing.grants.createVersion({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      grant_id: 'grant_runtime_e2e',
      expected_grant_revision: 0,
      endpoint_profile_id: profile.profile_id,
      profile_revision: profile.config_revision,
      stage_scopes: plan.stage_plans.map(item => ({
        stage: item.stage,
        audience: item.audience
      })),
      authorization_scope: { kind: 'single_turn', turn_id: turnId },
      budget: grantBudget(plan),
      expires_at: '2099-12-31T23:59:59.000Z'
    })).grant;
    await runtime.repositories.billing.plans.authorize({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      plan_hash: plan.plan_hash,
      grant_id: grant.grant_id,
      grant_revision: grant.grant_revision
    });
    const authorized = runtime.connection.read(database => database.prepare(`
      SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
    `).get(turnId));
    assert.equal(authorized.turn_status, 'RESOLVING');
    const claimable = runtime.repositories.leases.listClaimable({
      now: new Date().toISOString()
    });
    assert.equal(claimable.length, 1);
    assert.equal(claimable[0].run_id, runId);
    assert.equal(fakeProvider.calls.length, 0);
  });

  await test('logical worker repairs invisible audiences and unknown effects before adopting and committing', async () => {
    const liveProgress = [];
    fakeProvider.observeInvocations(() => {
      const memberA = runtime.repositories.core.turns.getForMember({
        authenticated_user_id: 'host_runtime_e2e', room_id: room.room_id,
        epoch_id: room.active_epoch_id, turn_no: 1
      });
      const memberB = runtime.repositories.core.turns.getForMember({
        authenticated_user_id: 'guest_runtime_e2e', room_id: room.room_id,
        epoch_id: room.active_epoch_id, turn_no: 1
      });
      assert.deepEqual(memberA.generation, memberB.generation);
      assert.equal(memberA.generation.run_status, 'RUNNING');
      assert.ok(memberA.generation.started_at);
      assert.equal('request_body' in memberA.generation, false);
      assert.equal('narratives' in memberA.generation, false);
      liveProgress.push({ status: memberA.status, stage: memberA.generation.model_stage });
    });
    fakeProvider.beginResolutionRepairScenario();
    fakeProvider.beginMemoryReferenceScenario();
    const result = await runtime.resolutionWorker.process(runId);
    assert.equal(result.status, 'COMMITTED', JSON.stringify({ result, calls: fakeProvider.calls }));
    fakeProvider.observeInvocations(null);
    assert.ok(liveProgress.some(item => item.status === 'RENDERING' && item.stage === 'writer'));
    assert.ok(liveProgress.some(item => item.status === 'STAGING_UPDATES' && item.stage === 'continuity_steward'));
    assert.ok(liveProgress.some(item => item.status === 'REPAIRING_DRAFT' && item.stage === 'continuity_repair'));
    const events = runtime.connection.read(database => database.prepare(`
      SELECT projected_payload_json FROM room_events
       WHERE turn_id = ? AND audience = 'A' AND event_type = 'resolution.progress' ORDER BY event_seq
    `).all(turnId).map(row => JSON.parse(row.projected_payload_json)).filter(item => item.model_stage));
    assert.deepEqual(events.map(item => item.model_stage), liveProgress.map(item => item.stage));
    assert.deepEqual(fakeProvider.calls, [
      'referee',
      'referee',
      'referee',
      'resolution_completeness_reviewer',
      'writer',
      'narrative_grounding_reviewer',
      'continuity_steward',
      'continuity_steward'
    ]);
    assert.equal(fakeProvider.resolutionScenario.calls, 3);
    const feedback = JSON.stringify(fakeProvider.resolutionScenario.feedback);
    assert.match(feedback, /RESOLUTION_AUDIENCE_COVERAGE_MISSING/);
    assert.match(feedback, /INVALID_EFFECT_CONTRACT/);
    assert.match(feedback, /seat:A/);
    const continuityPrompt = fakeProvider.prompts.find(prompt => (
      prompt.stage === 'continuity_steward'
        && prompt.trusted_update_obligations.turn_id === turnId
    ));
    assert.ok(continuityPrompt);
    assert.equal(fakeProvider.memoryReferenceScenario.calls, 2);
    const memoryFeedback = JSON.stringify(fakeProvider.memoryReferenceScenario.feedback);
    assert.match(memoryFeedback, /AUDIENCE_VIOLATION/);
    const referenceBindings = continuityPrompt.trusted_reference_bindings;
    for (const obligation of continuityPrompt.trusted_update_obligations.artifact_obligations) {
      if (obligation.kind !== 'memory') continue;
      const binding = referenceBindings[obligation.obligation_id];
      assert.deepEqual(binding.audienceEventIds, continuityPrompt.trusted_audience_projections
        .memory_partitions[obligation.target_binding].events.map(event => event.event_id));
      assert.ok(binding.stableSubjectIds.length > 0);
      assert.ok(!binding.stableSubjectIds.includes('World'));
    }
    const updateObligations = continuityPrompt.trusted_update_obligations;
    const actorIds = [
      continuityPrompt.trusted_base_state_summary.actors.A.room_actor_id,
      continuityPrompt.trusted_base_state_summary.actors.B.room_actor_id
    ].sort();
    const scopesFor = domain => updateObligations.domain_obligations
      .filter(item => item.domain === domain)
      .map(item => item.scope_refs[0])
      .sort();
    for (const domain of ['attributes', 'skills', 'equipment']) {
      assert.deepEqual(scopesFor(domain), actorIds);
    }
    assert.deepEqual(scopesFor('missions'), [MISSION_ID]);
    assert.deepEqual(scopesFor('relationships'), [...actorIds, NPC_ID].sort());
    const missionObligation = updateObligations.domain_obligations.find(item => (
      item.domain === 'missions' && item.scope_refs[0] === MISSION_ID
    ));
    assert.deepEqual(missionObligation.satisfied_by_effect_ids, [
      'effect_e2e_mission_accept',
      'effect_e2e_mission_activate',
      'effect_e2e_mission_create'
    ]);
    const npcRelationshipObligation = updateObligations.domain_obligations.find(item => (
      item.domain === 'relationships' && item.scope_refs[0] === NPC_ID
    ));
    assert.deepEqual(
      npcRelationshipObligation.satisfied_by_effect_ids,
      ['effect_e2e_npc_profile']
    );
    assert.deepEqual(
      updateObligations.artifact_obligations.map(item => item.target_binding).sort(),
      ['actor:A', `${NPC_ID}:private`, 'server_bound', 'shared', 'world_public'].sort()
    );
    const durable = runtime.connection.read(database => ({
      turn: database.prepare(`
        SELECT turn_status, committed_at FROM multiplayer_turns WHERE turn_id = ?
      `).get(turnId),
      run: database.prepare(`
        SELECT run_status, stage FROM resolution_runs WHERE run_id = ?
      `).get(runId),
      resolutions: database.prepare(`
        SELECT COUNT(*) AS count FROM canonical_resolutions WHERE turn_id = ?
      `).get(turnId).count,
      narratives: database.prepare(`
        SELECT COUNT(*) AS count FROM narrative_deliveries WHERE turn_id = ?
      `).get(turnId).count,
      checkpoints: database.prepare(`
        SELECT COUNT(*) AS count FROM room_checkpoints
         WHERE turn_id = ? AND checkpoint_kind = 'turn_commit'
      `).get(turnId).count,
      usage: database.prepare(`
        SELECT stage, usage_status FROM ai_usage_ledger
         WHERE turn_id = ? ORDER BY started_at, rowid
      `).all(turnId)
    }));
    assert.equal(durable.turn.turn_status, 'COMMITTED');
    assert.ok(durable.turn.committed_at);
    assert.deepEqual(durable.run, { run_status: 'SUCCEEDED', stage: 'continuity' });
    assert.equal(durable.resolutions, 1);
    assert.equal(durable.narratives, 1);
    assert.equal(durable.checkpoints, 1);
    assert.equal(durable.usage.length, 8);
    assert.equal(durable.usage.filter(item => item.stage === 'resolution_repair').length, 2);
    assert.equal(durable.usage.every(item => item.usage_status === 'SUCCEEDED'), true);
  });

  await test('double-empty public input uses the authoritative calendar baseline and commits a legal daily', () => {
    const continuityPrompt = fakeProvider.prompts.find(prompt => (
      prompt.stage === 'continuity_steward'
        && prompt.trusted_update_obligations.turn_id === turnId
    ));
    const publicProjection = continuityPrompt.trusted_world_public_projection;
    assert.deepEqual(publicProjection.events, []);
    assert.equal(publicProjection.facts.length, 1);
    assert.match(
      publicProjection.facts[0].fact_id,
      /^public:authority:calendar:[a-f0-9]{32}$/u
    );
    assert.match(publicProjection.facts[0].summary, /木叶48年/u);
    assert.match(publicProjection.facts[0].summary, /不证明任何离屏事件/u);

    const projection = runtime.repositories.core.turns.getForMember({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 1
    });
    assert.equal(projection.status, 'COMMITTED');
    assert.equal(projection.commit.shinobi_daily.length, 1);
    assert.equal(
      projection.commit.shinobi_daily[0].daily.headline.title,
      '公开纪年资料完成本期核验'
    );

    const checkpoint = runtime.services.snapshots.readInternal({
      room_id: room.room_id,
      checkpoint_id: projection.commit.checkpoint.checkpoint_id
    });
    const sourceRefs = checkpoint.state.shared_world.continuity_ledger
      .shinobi_daily[0].source_refs;
    const everyRef = [
      ...sourceRefs.headline,
      ...sourceRefs.world.flat(),
      ...sourceRefs.flavor.flat(),
      ...sourceRefs.missions.flat(),
      ...sourceRefs.quote
    ];
    assert.equal(everyRef.length, 13);
    assert.deepEqual([...new Set(everyRef)], [publicProjection.facts[0].fact_id]);
  });

  await test('member GET turn exposes committed narrative, state, memory, daily and checkpoint', () => {
    const host = runtime.repositories.core.turns.getForMember({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 1
    });
    const guest = runtime.repositories.core.turns.getForMember({
      authenticated_user_id: 'guest_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 1
    });
    for (const projection of [host, guest]) {
      assert.equal(projection.status, 'COMMITTED');
      assert.equal(projection.actions.A.text.includes('观察天气'), true);
      assert.equal(projection.actions.B.text.includes('观察村口道路'), true);
      assert.equal(projection.commit.narratives.length, 1);
      assert.equal(projection.commit.narratives[0].audience, 'shared');
      assert.equal(projection.commit.narratives[0].segments[0].text.includes('村口的风'), true);
      assert.equal(projection.commit.shinobi_daily.length, 1);
      assert.equal(
        projection.commit.shinobi_daily[0].daily.schema,
        'naruto.shinobi-daily/v1'
      );
      assert.match(projection.commit.checkpoint.checkpoint_id, /^checkpoint_/u);
      assert.match(projection.commit.checkpoint.commit_id, /^commit_/u);
      assert.equal(projection.commit.checkpoint.state_revision, 1);
      assert.ok(projection.commit.checkpoint.created_at);
      assert.equal(projection.commit.state.state_revision, 1);
      assert.equal(projection.commit.state.viewer_seat, projection.viewer_seat);
      assert.deepEqual(Object.keys(projection.commit.state.memories).sort(), [
        'personal',
        'shared'
      ]);
      assert.equal('canonical_events' in projection.commit.state.shared_world, false);
      assert.equal('continuity_ledger' in projection.commit.state.shared_world, false);
      const counterpartSeat = projection.viewer_seat === 'A' ? 'B' : 'A';
      assert.deepEqual(projection.commit.state.actors[counterpartSeat].skills.entries, []);
      assert.deepEqual(projection.commit.state.actors[counterpartSeat].equipment.entries, []);
      assert.deepEqual(projection.commit.state.actors[counterpartSeat].missions.entries, []);
      assert.deepEqual(projection.commit.state.actors[counterpartSeat].private_knowledge, {});
      assert.equal(
        'evidence_event_ids' in projection.commit.state.shared_world.world_state.npc_profiles[0],
        false
      );
    }
    assert.equal(host.commit.state.viewer_seat, 'A');
    assert.equal(guest.commit.state.viewer_seat, 'B');
    assert.equal(host.commit.state.memories.shared.entries.length, 1);
    assert.equal(guest.commit.state.memories.shared.entries.length, 1);
    assert.equal(host.commit.state.memories.personal.entries.length, 1);
    assert.equal(guest.commit.state.memories.personal.entries.length, 0);
    assert.deepEqual(host.commit.narratives, guest.commit.narratives);

    const checkpoint = runtime.services.snapshots.readInternal({
      room_id: room.room_id,
      checkpoint_id: host.commit.checkpoint.checkpoint_id
    });
    assert.equal(checkpoint.state_revision, 1);
    assert.equal(checkpoint.state.shared_world.continuity_ledger.shinobi_daily.length, 1);
    assert.equal(
      checkpoint.state.shared_world.shared_missions.entries.find(
        mission => mission.mission_id === MISSION_ID
      )?.status,
      'ACTIVE'
    );
    assert.equal(
      checkpoint.state.shared_world.world_state.npc_profiles.some(
        profile => profile.npc_id === NPC_ID
      ),
      true
    );
    assert.equal(checkpoint.state.memories.canonical.entries.length, 1);
    assert.equal(checkpoint.state.memories.shared.entries.length, 1);
    assert.equal(checkpoint.state.memories['actor:A'].entries.length, 1);
    assert.equal(checkpoint.state.memories['actor:B'].entries.length, 0);
    assert.equal(checkpoint.state.memories.npc_private.entries.length, 1);
  });

  await test('Continuity keeps calling beyond former request metadata and commits retained items', async () => {
    const beforeOpen = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id
    });
    const resumeTurn = await runtime.repositories.core.turns.open({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      expected_control_revision: beforeOpen.control_revision
    });
    assert.equal(resumeTurn.turn_no, 2);
    assert.equal(resumeTurn.status, 'AWAITING_PAYER_SELECTION');

    const selected = (await runtime.repositories.billing.selections.selectShared({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 2,
      endpoint_profile_id: profile.profile_id,
      expected_selection_revision: 0,
      expected_control_revision: resumeTurn.control_revision,
      idempotency_key: 'selection-runtime-resume-e2e'
    })).selection;
    for (const userId of ['host_runtime_e2e', 'guest_runtime_e2e']) {
      await runtime.repositories.billing.consents.grant({
        authenticated_user_id: userId,
        room_id: room.room_id,
        epoch_id: room.active_epoch_id,
        selection_hash: selected.selection_hash,
        config_fingerprint: profile.config_fingerprint,
        terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
        data_categories: SHARED_STAGE_DATA_CATEGORIES
      });
    }
    await runtime.repositories.core.turns.lockAction({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 2,
      request: {
        schema: ACTION_REQUEST_SCHEMA,
        base_state_revision: 1,
        text: '我再次观察天气，并与同伴核对情报。',
        pre_resolution_visibility: 'sealed',
        narration_preference: 'full',
        idempotency_key: 'action-host-runtime-resume-e2e'
      }
    });
    const sealed = await runtime.repositories.core.turns.lockAction({
      authenticated_user_id: 'guest_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 2,
      request: {
        schema: ACTION_REQUEST_SCHEMA,
        base_state_revision: 1,
        text: '我再次检查道路，并与同伴核对情报。',
        pre_resolution_visibility: 'sealed',
        narration_preference: 'full',
        idempotency_key: 'action-guest-runtime-resume-e2e'
      }
    });
    const resumeRunId = sealed.sealed_finalization.run_id;
    const resumePlan = runtime.repositories.billing.plans.getLatest({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      turn_id: resumeTurn.turn_id
    });
    const initialGrant = (await runtime.repositories.billing.grants.createVersion({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      grant_id: 'grant_runtime_resume_initial',
      expected_grant_revision: 0,
      endpoint_profile_id: profile.profile_id,
      profile_revision: profile.config_revision,
      stage_scopes: resumePlan.stage_plans.map(item => ({
        stage: item.stage,
        audience: item.audience
      })),
      authorization_scope: { kind: 'single_turn', turn_id: resumeTurn.turn_id },
      budget: grantBudget(resumePlan),
      expires_at: '2099-12-31T23:59:59.000Z'
    })).grant;
    await runtime.repositories.billing.plans.authorize({
      authenticated_user_id: 'host_runtime_e2e',
      room_id: room.room_id,
      plan_hash: resumePlan.plan_hash,
      grant_id: initialGrant.grant_id,
      grant_revision: initialGrant.grant_revision
    });

    const callsBeforeResumeTurn = fakeProvider.calls.length;
    fakeProvider.beginContinuityRepairScenario();
    const result = await runtime.resolutionWorker.process(resumeRunId);
    assert.equal(result.status, 'COMMITTED', JSON.stringify(result));
    assert.deepEqual(fakeProvider.calls.slice(callsBeforeResumeTurn), [
      'referee',
      'resolution_completeness_reviewer',
      'writer',
      'narrative_grounding_reviewer',
      'continuity_steward',
      'continuity_steward',
      'continuity_steward',
      'continuity_steward'
    ]);
    assert.equal(fakeProvider.continuityScenario.calls, 4);
    const secondContinuityPrompt = fakeProvider.prompts.find(prompt => (
      prompt.stage === 'continuity_steward'
        && prompt.trusted_update_obligations.turn_id === resumeTurn.turn_id
    ));
    const secondMissionObligation = secondContinuityPrompt.trusted_update_obligations
      .domain_obligations.find(item => (
        item.domain === 'missions' && item.scope_refs[0] === MISSION_ID
      ));
    assert.ok(secondMissionObligation);
    assert.deepEqual(secondMissionObligation.satisfied_by_effect_ids, []);
    const secondNpcRelationship = secondContinuityPrompt.trusted_update_obligations
      .domain_obligations.find(item => (
        item.domain === 'relationships' && item.scope_refs[0] === NPC_ID
      ));
    assert.ok(secondNpcRelationship);
    assert.deepEqual(secondNpcRelationship.satisfied_by_effect_ids, []);
    const durable = runtime.connection.read(database => ({
      turn: database.prepare(`
        SELECT turn_status FROM multiplayer_turns WHERE turn_id = ?
      `).get(resumeTurn.turn_id),
      run: database.prepare(`
        SELECT run_status, attempt_count FROM resolution_runs WHERE run_id = ?
      `).get(resumeRunId),
      artifacts: database.prepare(`
        SELECT obligation_id, artifact_revision FROM turn_draft_artifact_versions
         WHERE turn_id = ? ORDER BY obligation_id, artifact_revision
      `).all(resumeTurn.turn_id),
      usage: database.prepare(`
        SELECT stage, usage_status FROM ai_usage_ledger
         WHERE turn_id = ? ORDER BY started_at, rowid
      `).all(resumeTurn.turn_id),
      checkpoint: database.prepare(`
        SELECT checkpoint_id, state_revision FROM room_checkpoints
         WHERE turn_id = ? AND checkpoint_kind = 'turn_commit'
      `).get(resumeTurn.turn_id)
    }));
    assert.equal(durable.turn.turn_status, 'COMMITTED');
    assert.equal(durable.run.run_status, 'SUCCEEDED');
    assert.equal(durable.run.attempt_count, 1);
    assert.equal(durable.artifacts.length, 5);
    assert.equal(durable.usage.length, 8);
    assert.equal(durable.usage.every(item => item.usage_status === 'SUCCEEDED'), true);
    assert.equal(durable.checkpoint.state_revision, 2);
    const projection = runtime.repositories.core.turns.getForMember({
      authenticated_user_id: 'guest_runtime_e2e',
      room_id: room.room_id,
      epoch_id: room.active_epoch_id,
      turn_no: 2
    });
    assert.equal(projection.status, 'COMMITTED');
    assert.equal(projection.commit.narratives.length, 1);
    assert.equal(projection.commit.shinobi_daily.length, 1);
    const budgetFailures = runtime.connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM room_events
       WHERE turn_id = ? AND event_type = 'resolution.progress'
         AND projected_payload_json LIKE '%BILLING_BUDGET_EXHAUSTED%'
    `).get(resumeTurn.turn_id).count);
    assert.equal(budgetFailures, 0);
  });
} finally {
  await runtime.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer runtime SQLite E2E regression: ${passed} passed`);
