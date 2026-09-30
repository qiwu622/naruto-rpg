import assert from 'node:assert/strict';

import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';
import {
  canonicalStringify,
  sha256Hex
} from '../server/multiplayer/domain/canonical-json.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  commitPrototypeTurnInMemory,
  runFixedAgentTurnPrototype
} from '../server/multiplayer/domain/turn-orchestrator.js';
import {
  ACTOR_ATTRIBUTES_SCHEMA,
  ACTOR_ITEMS_SCHEMA,
  ACTOR_PROFILE_SCHEMA,
  ACTOR_PROGRESSION_SCHEMA,
  ACTOR_SKILLS_SCHEMA,
  COMBAT_COLLECTION_SCHEMA,
  EVENT_COLLECTION_SCHEMA,
  INTEGRITY_POLICY_HASH,
  MISSION_COLLECTION_SCHEMA,
  WORLD_CALENDAR_SCHEMA,
  WORLD_MAP_SCHEMA,
  WORLD_STATE_SCHEMA
} from '../server/multiplayer/domain/reducers/index.js';
import { MULTIPLAYER_ROOM_STATE_SCHEMA } from '../server/multiplayer/contracts/state-contracts.js';
import { RESOLUTION_CANDIDATE_SCHEMA } from '../server/multiplayer/contracts/resolution-contracts.js';

const SERVER_SECRET = 'phase-1-fixed-agent-regression-server-secret';
const EVENT_SHARED = 'event_public_escort_clash';
const EVENT_PRIVATE_A = 'event_private_A_opening';
const EVENT_PRIVATE_B = 'event_private_B_signal';

const EFFECT_COST = 'effect_cost_A_chakra';
const EFFECT_COMBAT = 'effect_record_A_technique';
const EFFECT_DAMAGE = 'effect_damage_B_vitality';
const EFFECT_MISSION = 'effect_progress_escort_mission';
const EFFECT_RELATIONSHIP = 'effect_update_B_trust_A';

const SUBMISSION_A = 'submission_stage1_A';
const SUBMISSION_B = 'submission_stage1_B';

const PUBLIC_SOURCE_IDS = Object.freeze({
  headline: 'public:event_public_escort_clash',
  world: Object.freeze(Array.from({ length: 4 }, (_, index) => `public:world_${index}`)),
  flavor: Object.freeze(Array.from({ length: 3 }, (_, index) => `public:flavor_${index}`)),
  missions: Object.freeze(Array.from({ length: 4 }, (_, index) => `public:mission_${index}`)),
  quote: 'public:quote'
});

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function profile(displayName) {
  return {
    schema: ACTOR_PROFILE_SCHEMA,
    version: 0,
    display_name: displayName,
    rank: '下忍',
    goal: '护送药材车队',
    alive: true,
    status: 'ACTIVE'
  };
}

function attributes() {
  return {
    schema: ACTOR_ATTRIBUTES_SCHEMA,
    resources: [
      { resource_id: 'chakra', version: 0, current: 40, maximum: 100 },
      { resource_id: 'money', version: 0, current: 1_000, maximum: 1_000_000 },
      { resource_id: 'vitality', version: 0, current: 80, maximum: 100 }
    ],
    injuries: [],
    persistent_statuses: []
  };
}

function progression() {
  return {
    schema: ACTOR_PROGRESSION_SCHEMA,
    version: 0,
    experience: 0,
    level: 1,
    reputation: 0,
    titles: [],
    achievements: []
  };
}

function actor(actorId, displayName, seat) {
  return {
    room_actor_id: actorId,
    player: profile(displayName),
    attributes: attributes(),
    progression: progression(),
    skills: { schema: ACTOR_SKILLS_SCHEMA, entries: [] },
    equipment: { schema: ACTOR_ITEMS_SCHEMA, entries: [] },
    missions: { schema: MISSION_COLLECTION_SCHEMA, entries: [] },
    private_knowledge: { seat, facts: [] }
  };
}

function baseState() {
  return {
    schema: MULTIPLAYER_ROOM_STATE_SCHEMA,
    meta: { state_revision: 7 },
    shared_world: {
      world_state: {
        schema: WORLD_STATE_SCHEMA,
        locations: [],
        weather: [],
        flags: [],
        npc_profiles: []
      },
      calendar: {
        schema: WORLD_CALENDAR_SCHEMA,
        calendar_id: 'calendar:main',
        version: 0,
        ordinal_minutes: 100,
        display_date: '木叶48年3月12日 上午',
        phase: 'DAY'
      },
      map: { schema: WORLD_MAP_SCHEMA, markers: [] },
      canonical_events: { schema: EVENT_COLLECTION_SCHEMA, entries: [] },
      shared_missions: {
        schema: MISSION_COLLECTION_SCHEMA,
        entries: [{
          mission_id: 'mission:escort_east',
          version: 1,
          scope: 'shared',
          title: '护送药材车队抵达东部驿站',
          status: 'ACTIVE',
          progress_current: 0,
          progress_total: 3,
          assignee_actor_ids: ['actor:A', 'actor:B']
        }]
      },
      shared_combat: {
        schema: COMBAT_COLLECTION_SCHEMA,
        entries: [{
          combat_id: 'combat:escort_ambush',
          version: 2,
          phase: 'ACTIVE',
          participants: [
            { participant_id: 'actor:A', display_name: '甲', status: 'ACTIVE' },
            { participant_id: 'actor:B', display_name: '乙', status: 'ACTIVE' }
          ],
          action_log: [],
          winner_ids: [],
          resolution_summary: null
        }]
      },
      continuity_ledger: { revision: 0 }
    },
    actors: {
      A: actor('actor:A', '甲', 'A'),
      B: actor('actor:B', '乙', 'B')
    },
    relationships: [{
      edge_id: 'relationship:B-trust-A',
      source_actor_id: 'actor:B',
      target_actor_id: 'actor:A',
      data: {
        version: 1,
        kind: 'ALLY',
        score: 25,
        label: '任务同伴',
        evidence_event_ids: ['event_prior_cooperation'],
        source_display_name: '乙',
        target_display_name: '甲'
      }
    }],
    memories: {
      canonical: { entries: [] },
      shared: { entries: [] },
      'actor:A': { entries: [] },
      'actor:B': { entries: [] },
      npc_private: { entries: [] }
    },
    agent_internal: {
      story_plan: {},
      audit_state: {}
    }
  };
}

function semanticEffect({ id, dependencies, domain, kind, operation, target, payload }) {
  return {
    effect_id: id,
    depends_on_effect_ids: dependencies,
    event_id: EVENT_SHARED,
    target,
    domain,
    kind,
    operation,
    payload,
    provenance: 'rules_engine',
    visibility: 'server_only',
    evidence_event_ids: [EVENT_SHARED]
  };
}

function resolutionCandidate() {
  const effects = [
    semanticEffect({
      id: EFFECT_COST,
      dependencies: [],
      domain: 'actor_resource',
      kind: 'resource',
      operation: 'consume',
      target: { scope: 'actor_resource', actor_id: 'actor:A', resource_id: 'chakra' },
      payload: {
        expected_version: 0,
        next_version: 1,
        from: 40,
        to: 28,
        amount: 12,
        maximum: 100
      }
    }),
    semanticEffect({
      id: EFFECT_COMBAT,
      dependencies: [EFFECT_COST],
      domain: 'combat',
      kind: 'combat',
      operation: 'record_action',
      target: { scope: 'combat', combat_id: 'combat:escort_ambush' },
      payload: {
        expected_version: 2,
        next_version: 3,
        action_id: 'action:fire_release',
        actor_id: 'actor:A',
        technique_id: 'skill:fire_release',
        event_id: EVENT_SHARED,
        outcome: '火遁逼退拦路者，为车队打开通路。'
      }
    }),
    semanticEffect({
      id: EFFECT_DAMAGE,
      dependencies: [EFFECT_COMBAT],
      domain: 'actor_resource',
      kind: 'resource',
      operation: 'damage',
      target: { scope: 'actor_resource', actor_id: 'actor:B', resource_id: 'vitality' },
      payload: {
        expected_version: 0,
        next_version: 1,
        from: 80,
        to: 72,
        amount: 8,
        maximum: 100
      }
    }),
    semanticEffect({
      id: EFFECT_MISSION,
      dependencies: [EFFECT_DAMAGE],
      domain: 'mission',
      kind: 'mission',
      operation: 'progress',
      target: {
        scope: 'mission',
        mission_id: 'mission:escort_east',
        mission_scope: 'shared'
      },
      payload: {
        expected_version: 1,
        next_version: 2,
        from_progress: 0,
        to_progress: 1,
        progress_total: 3
      }
    }),
    semanticEffect({
      id: EFFECT_RELATIONSHIP,
      dependencies: [EFFECT_MISSION],
      domain: 'relationship',
      kind: 'edge',
      operation: 'upsert',
      target: {
        scope: 'relationship_edge',
        edge_id: 'relationship:B-trust-A',
        source_actor_id: 'actor:B',
        target_actor_id: 'actor:A'
      },
      payload: {
        expected_version: 1,
        next_version: 2,
        kind: 'ALLY',
        score: 32,
        label: '可靠的任务同伴',
        evidence_event_ids: [EVENT_SHARED]
      }
    })
  ];
  return {
    schema: RESOLUTION_CANDIDATE_SCHEMA,
    conflicts: [{
      id: 'conflict_escort_crossfire',
      type: 'causal_conflict',
      submission_ids: [SUBMISSION_A, SUBMISSION_B],
      rule_basis: ['双方位置、既有战斗状态与技能资源成本']
    }],
    outcomes: [{
      submission_id: SUBMISSION_A,
      status: 'success',
      reason: '火遁压制成立，但必须支付查克拉成本。',
      event_ids: [EVENT_SHARED, EVENT_PRIVATE_A]
    }, {
      submission_id: SUBMISSION_B,
      status: 'partial_success',
      reason: 'B 完成掩护并推动护送任务，但被余波擦伤。',
      event_ids: [EVENT_SHARED, EVENT_PRIVATE_B]
    }],
    events: [{
      event_id: EVENT_SHARED,
      summary: 'A 的火遁与 B 的掩护共同打开道路，车队继续前进。',
      audiences: ['seat:A', 'seat:B'],
      world_public: true,
      effect_ids: effects.map(effect => effect.effect_id)
    }, {
      event_id: EVENT_PRIVATE_A,
      summary: 'A 察觉自己的查克拉流动出现短暂迟滞。',
      audiences: ['seat:A'],
      world_public: false,
      effect_ids: []
    }, {
      event_id: EVENT_PRIVATE_B,
      summary: 'B 看见远处林线闪过只有自己认得的联络信号。',
      audiences: ['seat:B'],
      world_public: false,
      effect_ids: []
    }],
    effects,
    elapsed_time: '约二十秒',
    stop_point: '道路已经打开，车队即将进入下一段林道。'
  };
}

function claim(eventId, subjectId, predicate, value) {
  return { event_id: eventId, subject_id: subjectId, predicate, value };
}

function narrativeCandidate(audience) {
  const shared = {
    segment_id: `segment_${audience.replace(':', '_')}_shared`,
    event_refs: [EVENT_SHARED],
    claims: [claim(EVENT_SHARED, 'mission:escort_east', 'route_opened', true)],
    text: '火浪贴着林道卷过，掩护的身影同时护住车侧。拦路者退开后，药材车队重新向东推进。'
  };
  if (audience === 'shared') {
    return { segments: [shared], stop_point_ref: EVENT_SHARED };
  }
  if (audience === 'seat:A') {
    return {
      segments: [shared, {
        segment_id: 'segment_seat_A_private',
        event_refs: [EVENT_PRIVATE_A],
        claims: [claim(EVENT_PRIVATE_A, 'actor:A', 'chakra_flow_warning', 'brief_delay')],
        text: '结印放下时，甲独自察觉经络里的查克拉迟滞了一瞬，必须重新衡量下一次施术。'
      }],
      stop_point_ref: EVENT_PRIVATE_A
    };
  }
  return {
    segments: [shared, {
      segment_id: 'segment_seat_B_private',
      event_refs: [EVENT_PRIVATE_B],
      claims: [claim(EVENT_PRIVATE_B, 'actor:B', 'signal_observed', 'forest_contact')],
      text: '乙压住擦伤抬眼望去，林线间那道转瞬即逝的信号只有自己明白。'
    }],
    stop_point_ref: EVENT_PRIVATE_B
  };
}

function publicFacts() {
  const ids = [
    ...PUBLIC_SOURCE_IDS.world,
    ...PUBLIC_SOURCE_IDS.flavor,
    ...PUBLIC_SOURCE_IDS.missions,
    PUBLIC_SOURCE_IDS.quote
  ];
  return ids.map((factId, index) => ({
    fact_id: factId,
    summary: `公开基线资料 ${index + 1}`,
    audiences: ['seat:A', 'seat:B'],
    world_public: true
  }));
}

function dailyItem() {
  return {
    obligation_id: 'obligation_daily_world_public',
    daily: structuredClone(SHINOBI_DAILY_EXAMPLE),
    source_refs: {
      headline: [PUBLIC_SOURCE_IDS.headline],
      world: PUBLIC_SOURCE_IDS.world.map(id => [id]),
      flavor: PUBLIC_SOURCE_IDS.flavor.map(id => [id]),
      missions: PUBLIC_SOURCE_IDS.missions.map(id => [id]),
      quote: [PUBLIC_SOURCE_IDS.quote]
    }
  };
}

function memory(obligationId, summary, eventId, subjectIds) {
  return {
    obligation_id: obligationId,
    summary,
    entries: [{
      kind: 'fact',
      text: summary,
      event_refs: [eventId],
      subject_refs: subjectIds
    }],
    supersede_entry_ids: [],
    retract_entry_ids: []
  };
}

function fixedAgents(transportMode, calls) {
  return {
    referee(input) {
      calls.referee += 1;
      const keys = new Set();
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          visit(child);
        }
      };
      visit(input);
      for (const forbidden of ['receipt_seq', 'received_at', 'pre_resolution_visibility']) {
        assert.equal(keys.has(forbidden), false, `Referee input leaked ${forbidden}`);
      }
      return resolutionCandidate();
    },
    writer(input) {
      calls.writer += 1;
      return narrativeCandidate(input.audience);
    },
    groundingReviewer(input) {
      calls.groundingReviewer += 1;
      return input.deliveries.map(delivery => ({
        review_id: `review_${delivery.audience.replace(':', '_')}`,
        reviewer_run_id: 'reviewer_run_phase1_joint',
        status: 'APPROVED',
        findings: []
      }));
    },
    continuity(input) {
      calls.continuity += 1;
      const unchangedDomains = input.update_obligations.domain_obligations
        .filter(obligation => obligation.satisfied_by_effect_ids.length === 0);
      const bundle = {
        // Reverse order deliberately: TurnDraft must execute the frozen DAG order.
        effect_ids: [...input.pending_effect_ids].reverse(),
        domain_checks: unchangedDomains.map(obligation => ({
          obligation_id: obligation.obligation_id,
          reason_code: 'NO_CANONICAL_CHANGE',
          evidence_event_ids: [EVENT_SHARED]
        })),
        memories: [
          memory(
            'obligation_memory_canonical',
            '车队在两名忍者配合下突破拦截并继续东行。',
            EVENT_SHARED,
            ['actor:A', 'actor:B', 'mission:escort_east']
          ),
          memory(
            'obligation_memory_actor_A',
            '甲记住施术后出现过短暂的查克拉迟滞。',
            EVENT_PRIVATE_A,
            ['actor:A']
          ),
          memory(
            'obligation_memory_actor_B',
            '乙记住林线间出现了熟悉的隐秘联络信号。',
            EVENT_PRIVATE_B,
            ['actor:B']
          )
        ],
        shinobi_daily: [dailyItem()]
      };
      return {
        transport_mode: transportMode,
        operation: 'stage_turn_bundle',
        bundle
      };
    }
  };
}

function executionPlan(mode) {
  if (mode === 'shared') {
    return {
      narrative_mode: 'shared',
      turn_payer_selection_hash: digest('1'),
      pov_writer_selection_hashes: null,
      writer_payer_by_audience: null,
      model_config_fingerprints: {
        shared_stage: digest('2'),
        pov_writers: null
      }
    };
  }
  return {
    narrative_mode: 'dual_pov',
    turn_payer_selection_hash: digest('1'),
    pov_writer_selection_hashes: { A: digest('3'), B: digest('4') },
    writer_payer_by_audience: { A: 'A', B: 'B' },
    model_config_fingerprints: {
      shared_stage: digest('2'),
      pov_writers: { A: digest('5'), B: digest('6') }
    }
  };
}

function run(mode, transportMode) {
  const calls = { referee: 0, writer: 0, groundingReviewer: 0, continuity: 0 };
  const config = {
    turn: {
      room_id: 'room_stage1_e2e',
      epoch_id: 'epoch_stage1_e2e',
      turn_id: 'turn_stage1_e2e',
      turn_no: 8,
      base_state_revision: 7,
      active_narrative_mode: mode
    },
    action_locks: [{
      seat: 'A',
      submission_id: SUBMISSION_A,
      received_at: '2026-08-22T02:00:00.000Z',
      request: {
        base_state_revision: 7,
        text: '我用火遁逼退拦路者，同时提醒乙护住车队。',
        pre_resolution_visibility: 'open',
        narration_preference: 'summarize_intent',
        narration_note: '概述结印即可，不逐句复述我的行动。',
        idempotency_key: 'idem-stage1-action-A'
      }
    }, {
      seat: 'B',
      submission_id: SUBMISSION_B,
      received_at: '2026-08-22T02:00:01.000Z',
      request: {
        base_state_revision: 7,
        text: '我挡住车队侧面的余波并观察远处林线。',
        pre_resolution_visibility: 'sealed',
        narration_preference: 'full',
        idempotency_key: 'idem-stage1-action-B'
      }
    }],
    execution_plan: executionPlan(mode),
    base_state: baseState(),
    rules_version: 'rules-phase1-e2e/v1',
    rule_snapshot: {
      schema: 'naruto.multiplayer-rule-snapshot/v1',
      revision: 1,
      reducer_registry_hash: INTEGRITY_POLICY_HASH
    },
    server_secret: SERVER_SECRET,
    public_facts: publicFacts(),
    ids: {
      run_id: 'run_stage1_e2e',
      draft_id: 'draft_stage1_e2e',
      continuity_session_id: 'continuity_stage1_e2e',
      invocation_id: `invocation_stage1_${transportMode}`,
      command_attempt_id: `attempt_stage1_${transportMode}`,
      commit_id: 'commit_stage1_e2e',
      lease_fence: 7
    },
    billing_provenance_hash: digest('7'),
    prompt_version: 'continuity/phase1-fixed-v1'
  };
  return {
    result: runFixedAgentTurnPrototype(config, fixedAgents(transportMode, calls)),
    calls
  };
}

const shared = run('shared', 'json_protocol');
const dual = run('dual_pov', 'native_tools');

test('shared fixed-agent turn reaches one grounded narrative and an atomic COMMITTED result', () => {
  assert.deepEqual(shared.calls, {
    referee: 1,
    writer: 1,
    groundingReviewer: 1,
    continuity: 1
  });
  assert.equal(shared.result.sealed_turn.status, 'SEALED');
  assert.equal(shared.result.grounded_narratives.deliveries.length, 1);
  assert.equal(shared.result.grounded_narratives.deliveries[0].audience, 'shared');
  assert.equal(shared.result.grounded_narratives.grounding_review_receipts[0].status, 'APPROVED');
  assert.equal(shared.result.continuity_result.status, 'READY');
  assert.equal(shared.result.draft.status, 'READY');
  assert.equal(shared.result.commit.status, 'COMMITTED');
  assert.equal(shared.result.commit.narrative_deliveries.length, 1);
  assert.equal(
    canonicalStringify(shared.result.commit.member_views.A.narrative_delivery),
    canonicalStringify(shared.result.commit.member_views.B.narrative_delivery)
  );
});

test('dual POV calls two writers against one resolution and joint grounding preserves private facts', () => {
  assert.deepEqual(dual.calls, {
    referee: 1,
    writer: 2,
    groundingReviewer: 1,
    continuity: 1
  });
  assert.equal(dual.result.grounded_narratives.deliveries.length, 2);
  assert.deepEqual(
    dual.result.grounded_narratives.deliveries.map(delivery => delivery.audience),
    ['seat:A', 'seat:B']
  );
  assert.equal(new Set(
    dual.result.grounded_narratives.grounding_review_receipts
      .map(receipt => receipt.reviewer_run_id)
  ).size, 1);
  assert.deepEqual(
    dual.result.audience_projections.seat_A.events.map(event => event.event_id),
    [EVENT_PRIVATE_A, EVENT_SHARED].sort()
  );
  assert.deepEqual(
    dual.result.audience_projections.seat_B.events.map(event => event.event_id),
    [EVENT_PRIVATE_B, EVENT_SHARED].sort()
  );
  assert.deepEqual(
    dual.result.audience_projections.shared.events.map(event => event.event_id),
    [EVENT_SHARED]
  );
  assert.equal(
    dual.result.audience_projections.world_public.events.some(
      event => event.event_id === EVENT_PRIVATE_A || event.event_id === EVENT_PRIVATE_B
    ),
    false
  );
});

test('Continuity uses compiled real reducers in effect_seq order and consumes every obligation once', () => {
  const state = dual.result.draft.candidate_state;
  assert.equal(
    state.actors.A.attributes.resources.find(resource => resource.resource_id === 'chakra').current,
    28
  );
  assert.equal(
    state.actors.B.attributes.resources.find(resource => resource.resource_id === 'vitality').current,
    72
  );
  assert.equal(state.shared_world.shared_combat.entries[0].version, 3);
  assert.equal(state.shared_world.shared_combat.entries[0].action_log.length, 1);
  assert.equal(state.shared_world.shared_missions.entries[0].progress_current, 1);
  assert.equal(state.relationships[0].data.version, 2);
  assert.equal(state.relationships[0].data.score, 32);
  assert.deepEqual(
    dual.result.draft.effect_ledger.map(row => [row.effect_seq, row.status]),
    [[1, 'CONSUMED'], [2, 'CONSUMED'], [3, 'CONSUMED'], [4, 'CONSUMED'], [5, 'CONSUMED']]
  );
  assert.equal(
    dual.result.draft.obligation_ledger.every(row => row.status === 'CONSUMED'),
    true
  );
  assert.equal(dual.result.commit.committed_memories.length, 3);
  assert.equal(dual.result.commit.shinobi_daily.length, 1);
});

test('shared and dual POV preserve the same canonical resolution and authoritative state hash', () => {
  assert.equal(shared.result.resolution_hash, dual.result.resolution_hash);
  assert.equal(
    canonicalStringify(shared.result.canonical_resolution),
    canonicalStringify(dual.result.canonical_resolution)
  );
  assert.equal(shared.result.draft.candidate_state_hash, dual.result.draft.candidate_state_hash);
  assert.equal(shared.result.commit.state_hash, dual.result.commit.state_hash);
  assert.equal(shared.result.commit.state_revision, 8);
  assert.equal(dual.result.commit.state_revision, 8);
  assert.notEqual(
    shared.result.commit_preconditions.result.narrative_bundle_hash,
    dual.result.commit_preconditions.result.narrative_bundle_hash,
    'narrative audit hashes should still record the selected delivery mode'
  );
});

test('complete CommitPreconditionSet is present and sealed actions disclose only after commit', () => {
  assert.deepEqual(
    Object.keys(dual.result.commit_preconditions).sort(),
    ['billing', 'concurrency', 'frozen_inputs', 'identity', 'lifecycle', 'result', 'schema']
  );
  assert.equal(dual.result.commit_preconditions.concurrency.draft_status, 'READY');
  assert.equal(dual.result.commit_preconditions.lifecycle.turn_status, 'COMMITTING');
  assert.equal(
    dual.result.commit_preconditions.result.commit_envelope_hash,
    dual.result.draft.commit_envelope_hash
  );
  assert.equal(
    dual.result.commit.member_views.A.action_turn.actions.B.text,
    '我挡住车队侧面的余波并观察远处林线。'
  );
  assert.equal(
    dual.result.commit.member_views.B.action_turn.actions.A.text,
    '我用火遁逼退拦路者，同时提醒乙护住车队。'
  );
  assert.equal(dual.result.commit.member_views.A.action_turn.status, 'COMMITTED');
});

test('tampered final precondition aborts the pure atomic commit without mutating READY inputs', () => {
  const beforeDraft = canonicalStringify(dual.result.draft);
  const beforeTurn = canonicalStringify(dual.result.sealed_turn);
  const bad = structuredClone(dual.result.commit_preconditions);
  bad.result.candidate_state_hash = `sha256:${sha256Hex('tampered-candidate')}`;
  assert.throws(
    () => commitPrototypeTurnInMemory({
      current: {
        room_lifecycle: 'ACTIVE',
        epoch_state: 'ACTIVE',
        turn_status: 'COMMITTING',
        current_turn_id: dual.result.sealed_turn.turn_id,
        void_requested: false,
        state_revision: 7,
        state_hash: `sha256:${sha256Hex(baseState())}`,
        lease_fence: 7,
        state: baseState()
      },
      turn: dual.result.sealed_turn,
      draft: dual.result.draft,
      canonicalResolution: dual.result.canonical_resolution,
      updateObligations: dual.result.update_obligations,
      groundedNarratives: dual.result.grounded_narratives,
      preconditions: bad
    }),
    error => error instanceof DomainError && error.code === 'COMMIT_PRECONDITION_FAILED'
  );
  assert.equal(canonicalStringify(dual.result.draft), beforeDraft);
  assert.equal(canonicalStringify(dual.result.sealed_turn), beforeTurn);
});

console.log(`${passed} multiplayer phase-1 fixed-agent end-to-end regression tests passed.`);
