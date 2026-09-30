import assert from 'node:assert/strict';

import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  CONTINUITY_JSON_PROTOCOL,
  CONTINUITY_OPERATIONS,
  bindContinuityCommand,
  decodeJsonContinuityCommand,
  decodeNativeContinuityCommand
} from '../server/multiplayer/domain/continuity-bundle.js';
import {
  createTurnDraft,
  executeContinuityTransport,
  executeTurnBundleCommand
} from '../server/multiplayer/domain/turn-draft.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function strictKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('SCHEMA_VIOLATION', `${label} must be an object`, {
      path: '/', allowed_paths: ['/']
    });
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new DomainError('SCHEMA_VIOLATION', `${label} contains an extra property`, {
        path: `/${key}`, allowed_paths: [`/${key}`]
      });
    }
  }
}

const validators = {
  domain_check(item) {
    strictKeys(item, ['obligation_id', 'reason_code', 'evidence_event_ids'], 'domain check');
    if (!['NO_CANONICAL_CHANGE', 'NOT_APPLICABLE_TO_SCOPE', 'ALREADY_REFLECTED_IN_BASE']
      .includes(item.reason_code)) {
      throw new DomainError('SCHEMA_VIOLATION', 'invalid reason code', {
        path: '/reason_code', allowed_paths: ['/reason_code']
      });
    }
    if (!Array.isArray(item.evidence_event_ids)) {
      throw new DomainError('SCHEMA_VIOLATION', 'evidence_event_ids must be an array', {
        path: '/evidence_event_ids', allowed_paths: ['/evidence_event_ids']
      });
    }
    return item;
  },
  memory(item) {
    strictKeys(item, ['obligation_id', 'summary', 'entries'], 'memory');
    if (typeof item.summary !== 'string' || !item.summary.trim() || !Array.isArray(item.entries)) {
      throw new DomainError('SCHEMA_VIOLATION', 'memory summary and entries are required', {
        path: '/summary', allowed_paths: ['/summary', '/entries']
      });
    }
    for (let index = 0; index < item.entries.length; index += 1) {
      const entry = item.entries[index];
      strictKeys(entry, ['kind', 'text', 'event_refs'], 'memory entry');
      if (!Array.isArray(entry.event_refs)) {
        throw new DomainError('SCHEMA_VIOLATION', 'event_refs must be an array', {
          path: `/entries/${index}/event_refs`,
          allowed_paths: [`/entries/${index}/event_refs`]
        });
      }
      if (entry.event_refs.includes('event_private_B')) {
        throw new DomainError('AUDIENCE_VIOLATION', 'memory references another audience', {
          path: `/entries/${index}/event_refs`,
          allowed_paths: [`/entries/${index}/event_refs`]
        });
      }
    }
    return item;
  },
  shinobi_daily(item) {
    strictKeys(item, ['obligation_id', 'daily', 'source_refs'], 'shinobi daily');
    if (!item.daily || item.daily.schema !== 'naruto.shinobi-daily/v1') {
      throw new DomainError('SCHEMA_VIOLATION', 'daily schema is missing', {
        path: '/daily/schema', allowed_paths: ['/daily']
      });
    }
    if (!item.source_refs || !Array.isArray(item.source_refs.headline)) {
      throw new DomainError('SCHEMA_VIOLATION', 'daily public source refs are missing', {
        path: '/source_refs/headline', allowed_paths: ['/source_refs']
      });
    }
    return item;
  }
};

const reducers = {
  apply_resource(candidate, effect) {
    const next = { ...candidate };
    next[effect.payload.stat] += effect.payload.delta;
    if (next[effect.payload.stat] < 0) {
      throw new DomainError('PRECONDITION_FAILED', 'resource would become negative', {
        retryable_by: 'referee'
      });
    }
    return {
      nextCandidate: next,
      normalizedOperations: [{
        stat: effect.payload.stat,
        delta: effect.payload.delta
      }],
      invariantResults: [{ code: 'NON_NEGATIVE', passed: true }]
    };
  },
  advance_mission(candidate, effect) {
    return {
      nextCandidate: { ...candidate, mission_step: effect.payload.to },
      normalizedOperations: [{ mission_step: effect.payload.to }],
      invariantResults: []
    };
  }
};

const runtime = { validators, reducers, rule_snapshot: { version: 'rules/test-v1' } };

const EFFECTS = [
  {
    effect_id: 'effect_cost_A',
    effect_seq: 1,
    effect_hash: 'sha256:effect-cost-A',
    required_reducer: 'apply_resource',
    reducer_version: 'resource/v1',
    depends_on_effect_ids: [],
    payload: { stat: 'chakra', delta: -12 }
  },
  {
    effect_id: 'effect_damage_B',
    effect_seq: 2,
    effect_hash: 'sha256:effect-damage-B',
    required_reducer: 'apply_resource',
    reducer_version: 'resource/v1',
    depends_on_effect_ids: ['effect_cost_A'],
    payload: { stat: 'vitality', delta: -8 }
  },
  {
    effect_id: 'effect_mission_progress',
    effect_seq: 3,
    effect_hash: 'sha256:effect-mission',
    required_reducer: 'advance_mission',
    reducer_version: 'mission/v1',
    depends_on_effect_ids: ['effect_damage_B'],
    payload: { to: 2 }
  }
];

const OBLIGATIONS = [
  {
    obligation_id: 'obligation_domain_relationships',
    kind: 'domain_check',
    bound_scope: ['actor:A', 'actor:B']
  },
  {
    obligation_id: 'obligation_memory_actor_A',
    kind: 'memory',
    target_binding: 'actor:A'
  },
  {
    obligation_id: 'obligation_daily_turn_42',
    kind: 'shinobi_daily',
    target_binding: 'world_public'
  }
];

function freshDraft(overrides = {}) {
  const config = {
    room_id: 'room_42',
    epoch_id: 'epoch_3',
    draft_id: overrides.draft_id ?? 'draft_42',
    turn_id: overrides.turn_id ?? 'turn_42',
    run_id: overrides.run_id ?? 'run_42',
    continuity_session_id: overrides.continuity_session_id ?? 'continuity_42',
    lease_fence: overrides.lease_fence ?? 7,
    base_state_revision: 42,
    resolution_hash: 'sha256:resolution-42',
    obligation_set_hash: 'sha256:obligations-42',
    execution_plan_hash: 'sha256:execution-plan-42',
    billing_provenance_hash: overrides.billing_provenance_hash ?? 'sha256:billing-provenance-42',
    narrative_bundle_hash: 'sha256:narrative-bundle-42',
    projection_bundle_hash: 'sha256:projection-bundle-42',
    rule_snapshot_hash: 'sha256:rules-test-v1',
    prompt_version: 'continuity/test-v1',
    base_candidate: { chakra: 20, mission_step: 1, vitality: 30 },
    effects: overrides.effects ?? EFFECTS,
    obligations: overrides.obligations ?? OBLIGATIONS
  };
  if (overrides.required_effect_ids !== undefined) {
    config.required_effect_ids = overrides.required_effect_ids;
  }
  if (overrides.required_obligation_ids !== undefined) {
    config.required_obligation_ids = overrides.required_obligation_ids;
  }
  return createTurnDraft(config);
}

function binding(attempt, invocation = `invocation_${attempt}`) {
  return {
    run_id: 'run_42',
    continuity_session_id: 'continuity_42',
    invocation_id: invocation,
    command_attempt_id: attempt,
    lease_fence: 7
  };
}

function patch(overrides = {}) {
  return {
    effect_ids: overrides.effect_ids ?? [],
    domain_checks: overrides.domain_checks ?? [],
    memories: overrides.memories ?? [],
    shinobi_daily: overrides.shinobi_daily ?? []
  };
}

function jsonCommand(operation, bundle, bound) {
  return bindContinuityCommand(decodeJsonContinuityCommand(JSON.stringify({
    protocol: CONTINUITY_JSON_PROTOCOL,
    operation,
    bundle
  })), bound);
}

function nativeCommand(operation, bundle, bound) {
  return bindContinuityCommand(decodeNativeContinuityCommand(operation, bundle), bound);
}

function validDomain() {
  return {
    obligation_id: 'obligation_domain_relationships',
    reason_code: 'NO_CANONICAL_CHANGE',
    evidence_event_ids: ['event_1']
  };
}

function validMemory(summary = 'A 记住了东部驿道上的战斗。') {
  return {
    obligation_id: 'obligation_memory_actor_A',
    summary,
    entries: [{ kind: 'fact', text: '袭击者已被击退。', event_refs: ['event_public_1'] }]
  };
}

function validDaily() {
  return {
    obligation_id: 'obligation_daily_turn_42',
    daily: { schema: 'naruto.shinobi-daily/v1', headline: '东部驿道恢复通行' },
    source_refs: { headline: ['public:event_1'] }
  };
}

test('native tools and strict JSON normalize to an identical canonical command', () => {
  const bundle = patch({
    effect_ids: ['effect_cost_A'],
    memories: [validMemory()]
  });
  const native = decodeNativeContinuityCommand(CONTINUITY_OPERATIONS.STAGE, bundle);
  const json = decodeJsonContinuityCommand(JSON.stringify({
    protocol: CONTINUITY_JSON_PROTOCOL,
    operation: CONTINUITY_OPERATIONS.STAGE,
    bundle
  }));
  assert.deepEqual(native, json);
  assert.equal(native.canonical_request_hash, json.canonical_request_hash);
  assert.ok(Object.isFrozen(native.bundle.memories[0]));
});

test('semantic and commit-envelope hashes are separated and bind billing provenance', () => {
  const first = freshDraft();
  const amended = freshDraft({ billing_provenance_hash: 'sha256:billing-provenance-amended' });
  assert.equal(first.semantic_draft_hash, amended.semantic_draft_hash);
  assert.notEqual(first.commit_envelope_hash, amended.commit_envelope_hash);
  assert.match(first.commit_envelope_hash, /^sha256:[a-f0-9]{64}$/);
});

test('draft contracts require a positive fence and contiguous 1-based effect sequence', () => {
  assert.throws(
    () => freshDraft({ lease_fence: 0 }),
    error => error instanceof DomainError && error.code === 'INVALID_TURN_DRAFT'
  );
  assert.throws(
    () => freshDraft({ effects: [EFFECTS[0], { ...EFFECTS[1], effect_seq: 3 }] }),
    error => error instanceof DomainError && error.code === 'INVALID_TURN_DRAFT'
  );
  assert.throws(
    () => bindContinuityCommand(
      decodeNativeContinuityCommand(CONTINUITY_OPERATIONS.STAGE, patch()),
      {
        run_id: 'run_42',
        continuity_session_id: 'continuity_42',
        invocation_id: 'invocation_no_fence',
        command_attempt_id: 'attempt_no_fence'
      }
    ),
    error => error instanceof DomainError && error.code === 'INVALID_BOUND_CONTEXT'
  );
});

test('native and JSON transports produce identical candidate, artifacts, and semantic hash', () => {
  const bundle = patch({
    effect_ids: ['effect_mission_progress', 'effect_damage_B', 'effect_cost_A'],
    domain_checks: [validDomain()],
    memories: [validMemory()],
    shinobi_daily: [validDaily()]
  });
  const bound = binding('attempt_transport_equivalence');
  const native = executeTurnBundleCommand(
    freshDraft(),
    nativeCommand(CONTINUITY_OPERATIONS.STAGE, bundle, bound),
    runtime
  );
  const json = executeTurnBundleCommand(
    freshDraft(),
    jsonCommand(CONTINUITY_OPERATIONS.STAGE, bundle, bound),
    runtime
  );
  assert.equal(native.result.status, 'READY');
  assert.equal(json.result.status, 'READY');
  assert.deepEqual(native.draft.candidate_state, json.draft.candidate_state);
  assert.deepEqual(native.draft.obligation_ledger, json.draft.obligation_ledger);
  assert.equal(native.draft.candidate_state_hash, json.draft.candidate_state_hash);
  assert.equal(native.draft.artifact_bundle_hash, json.draft.artifact_bundle_hash);
  assert.equal(native.draft.semantic_draft_hash, json.draft.semantic_draft_hash);
});

test('JSON protocol rejects fences, prose, concatenated objects, unknown operations and extra fields', () => {
  const valid = JSON.stringify({
    protocol: CONTINUITY_JSON_PROTOCOL,
    operation: CONTINUITY_OPERATIONS.STAGE,
    bundle: {}
  });
  const invalidResponses = [
    `\`\`\`json\n${valid}\n\`\`\``,
    `以下是结果：${valid}`,
    `${valid}\n完成。`,
    `${valid}${valid}`,
    JSON.stringify({
      protocol: CONTINUITY_JSON_PROTOCOL,
      operation: 'review_staged_turn_internal',
      bundle: {}
    }),
    JSON.stringify({
      protocol: CONTINUITY_JSON_PROTOCOL,
      operation: CONTINUITY_OPERATIONS.STAGE,
      bundle: {},
      explanation: 'done'
    }),
    JSON.stringify({
      protocol: CONTINUITY_JSON_PROTOCOL,
      operation: CONTINUITY_OPERATIONS.STAGE,
      bundle: { effect_ids: [], arbitrary_path: '/players/A/chakra' }
    })
  ];
  for (const response of invalidResponses) {
    assert.throws(
      () => decodeJsonContinuityCommand(response),
      error => error instanceof DomainError && error.code === 'PROTOCOL_VIOLATION'
    );
  }
});

test('protocol violations return a repairable result and perform zero draft writes', () => {
  const draft = freshDraft();
  const execution = executeContinuityTransport(
    draft,
    { transport_mode: 'json_protocol', response_text: '```json\n{}\n```' },
    binding('attempt_bad_protocol'),
    runtime
  );
  assert.strictEqual(execution.draft, draft);
  assert.equal(execution.result.status, 'PROTOCOL_RETRY');
  assert.equal(execution.result.next_operation, CONTINUITY_OPERATIONS.STAGE);
  assert.equal(execution.result.errors[0].consumed, false);
  assert.equal(draft.commands.length, 0);
  assert.equal(draft.draft_revision, 0);
});

test('one valid native effect survives an invalid memory item and all omissions share one RepairPlan', () => {
  const draft = freshDraft();
  const invalidMemory = validMemory();
  invalidMemory.entries[0].event_refs = ['event_private_B'];
  const first = executeTurnBundleCommand(
    draft,
    nativeCommand(CONTINUITY_OPERATIONS.STAGE, patch({
      effect_ids: ['effect_cost_A'],
      memories: [invalidMemory]
    }), binding('attempt_partial')),
    runtime
  );

  assert.equal(first.result.status, 'REPAIR_REQUIRED');
  assert.deepEqual(first.result.accepted.map(item => item.id), ['effect_cost_A']);
  assert.equal(first.result.errors[0].code, 'AUDIENCE_VIOLATION');
  assert.equal(first.result.errors[0].consumed, false);
  assert.deepEqual(first.result.review.missing_effect_ids, [
    'effect_damage_B',
    'effect_mission_progress'
  ]);
  assert.deepEqual(first.result.review.missing_by_kind, {
    domain_check: ['obligation_domain_relationships'],
    memory: ['obligation_memory_actor_A'],
    shinobi_daily: ['obligation_daily_turn_42']
  });
  assert.deepEqual(first.result.allowed_effect_ids, [
    'effect_damage_B',
    'effect_mission_progress'
  ]);
  assert.deepEqual(first.result.allowed_obligation_ids, [
    'obligation_daily_turn_42',
    'obligation_domain_relationships',
    'obligation_memory_actor_A'
  ]);
  const memoryPaths = first.result.allowed_paths.find(item => (
    item.id === 'obligation_memory_actor_A'
  ));
  assert.deepEqual(memoryPaths.json_pointers, ['/entries/0/event_refs']);
  assert.equal(first.draft.candidate_state.chakra, 8);
  assert.equal(first.draft.candidate_state.vitality, 30);
  assert.equal(
    first.draft.obligation_ledger.find(row => row.kind === 'memory').status,
    'PENDING'
  );
});

test('repair consumes only missing work, accepts insurance replays as no-op, and auto-finalizes READY', () => {
  const first = executeTurnBundleCommand(
    freshDraft(),
    jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch({
      effect_ids: ['effect_cost_A']
    }), binding('attempt_stage_for_repair')),
    runtime
  );
  const repaired = executeTurnBundleCommand(
    first.draft,
    jsonCommand(CONTINUITY_OPERATIONS.REPAIR, patch({
      // Reverse order proves server-side effect_seq ordering. The already
      // successful cost is a model's harmless insurance replay.
      effect_ids: [
        'effect_mission_progress',
        'effect_damage_B',
        'effect_cost_A'
      ],
      domain_checks: [validDomain()],
      memories: [validMemory()],
      shinobi_daily: [validDaily()]
    }), binding('attempt_repair_all')),
    runtime
  );

  assert.equal(repaired.result.status, 'READY');
  assert.deepEqual(repaired.result.idempotent, [{
    kind: 'effect',
    id: 'effect_cost_A',
    receipt_id: first.draft.effect_ledger[0].receipt.receipt_id
  }]);
  assert.deepEqual(repaired.draft.candidate_state, {
    chakra: 8,
    mission_step: 2,
    vitality: 22
  });
  assert.equal(repaired.draft.effect_ledger.every(row => row.status === 'CONSUMED'), true);
  assert.equal(repaired.draft.obligation_ledger.every(row => row.status === 'CONSUMED'), true);
  assert.equal(repaired.draft.status, 'READY');
  assert.equal(repaired.draft.expected_operation, null);
  assert.ok(repaired.result.ready_receipt.receipt_id.startsWith('receipt_ready_'));
});

test('exact attempt replay precedes phase gates and returns the immutable historical result', () => {
  const stageCommand = jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch({
    effect_ids: ['effect_cost_A']
  }), binding('attempt_exact', 'invocation_exact'));
  const first = executeTurnBundleCommand(freshDraft(), stageCommand, runtime);
  const ready = executeTurnBundleCommand(
    first.draft,
    jsonCommand(CONTINUITY_OPERATIONS.REPAIR, patch({
      effect_ids: ['effect_damage_B', 'effect_mission_progress'],
      domain_checks: [validDomain()],
      memories: [validMemory()],
      shinobi_daily: [validDaily()]
    }), binding('attempt_finish_exact')),
    runtime
  );
  assert.equal(ready.draft.status, 'READY');

  const replay = executeTurnBundleCommand(ready.draft, stageCommand, runtime);
  assert.equal(replay.replayed, true);
  assert.strictEqual(replay.draft, ready.draft);
  assert.equal(replay.result.status, 'REPAIR_REQUIRED');
  assert.deepEqual(replay.result, first.result);
  assert.ok(Object.isFrozen(replay.result));
});

test('same attempt with another request hash conflicts before the new stage-operation gate', () => {
  const first = executeTurnBundleCommand(
    freshDraft(),
    jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch({
      effect_ids: ['effect_cost_A']
    }), binding('attempt_hash_conflict', 'invocation_hash_conflict')),
    runtime
  );
  const changed = jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch({
    effect_ids: ['effect_cost_A', 'effect_damage_B']
  }), binding('attempt_hash_conflict', 'invocation_hash_conflict'));
  assert.throws(
    () => executeTurnBundleCommand(first.draft, changed, runtime),
    error => error instanceof DomainError && error.code === 'IDEMPOTENCY_CONFLICT'
  );
  assert.equal(first.draft.commands.length, 1);
});

test('new stage attempts in repair and repair attempts in initial/READY phases are rejected', () => {
  const draft = freshDraft();
  const prematureRepair = jsonCommand(CONTINUITY_OPERATIONS.REPAIR, patch(), binding('attempt_early_repair'));
  assert.throws(
    () => executeTurnBundleCommand(draft, prematureRepair, runtime),
    error => error instanceof DomainError && error.code === 'OPERATION_NOT_ALLOWED'
  );

  const staged = executeTurnBundleCommand(
    draft,
    jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch(), binding('attempt_empty_stage')),
    runtime
  );
  assert.throws(
    () => executeTurnBundleCommand(
      staged.draft,
      jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch(), binding('attempt_second_stage')),
      runtime
    ),
    error => error instanceof DomainError && error.code === 'OPERATION_NOT_ALLOWED'
  );
});

test('strict item validation rejects extra fields without rolling back another valid item', () => {
  const memory = { ...validMemory(), audience: 'actor:B' };
  const staged = executeTurnBundleCommand(
    freshDraft(),
    nativeCommand(CONTINUITY_OPERATIONS.STAGE, patch({
      effect_ids: ['effect_cost_A'],
      memories: [memory]
    }), binding('attempt_extra_item_field')),
    runtime
  );
  assert.equal(staged.result.accepted[0].id, 'effect_cost_A');
  assert.equal(staged.result.errors[0].code, 'SCHEMA_VIOLATION');
  assert.equal(staged.result.errors[0].path, '/memories/0/audience');
  assert.equal(staged.draft.candidate_state.chakra, 8);
});

test('failed obligation attempts do not consume IDs and a later allowed attempt creates revision one', () => {
  const invalid = validMemory();
  invalid.summary = '';
  const staged = executeTurnBundleCommand(
    freshDraft(),
    nativeCommand(CONTINUITY_OPERATIONS.STAGE, patch({ memories: [invalid] }), binding('attempt_bad_memory')),
    runtime
  );
  const before = staged.draft.obligation_ledger.find(row => row.kind === 'memory');
  assert.equal(before.status, 'PENDING');
  assert.equal(before.current_artifact_revision, 0);

  const repaired = executeTurnBundleCommand(
    staged.draft,
    nativeCommand(CONTINUITY_OPERATIONS.REPAIR, patch({
      effect_ids: ['effect_cost_A', 'effect_damage_B', 'effect_mission_progress'],
      domain_checks: [validDomain()],
      memories: [validMemory()],
      shinobi_daily: [validDaily()]
    }), binding('attempt_fixed_memory')),
    runtime
  );
  const after = repaired.draft.obligation_ledger.find(row => row.kind === 'memory');
  assert.equal(after.status, 'CONSUMED');
  assert.equal(after.current_artifact_revision, 1);
  assert.equal(after.versions.length, 1);
});

test('dependency failures leave effect IDs pending and a new attempt can consume them in effect_seq order', () => {
  const staged = executeTurnBundleCommand(
    freshDraft(),
    jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch({
      effect_ids: ['effect_damage_B']
    }), binding('attempt_dependency_failure')),
    runtime
  );
  assert.ok(staged.result.errors.some(error => (
    error.id === 'effect_damage_B' && error.code === 'EFFECT_DEPENDENCY_UNMET'
  )));
  assert.equal(
    staged.draft.effect_ledger.find(row => row.effect_id === 'effect_damage_B').status,
    'PENDING'
  );
  assert.equal(staged.draft.candidate_state.vitality, 30);

  const repaired = executeTurnBundleCommand(
    staged.draft,
    jsonCommand(CONTINUITY_OPERATIONS.REPAIR, patch({
      effect_ids: ['effect_mission_progress', 'effect_damage_B', 'effect_cost_A'],
      domain_checks: [validDomain()],
      memories: [validMemory()],
      shinobi_daily: [validDaily()]
    }), binding('attempt_dependency_fixed')),
    runtime
  );
  assert.equal(repaired.result.status, 'READY');
  assert.deepEqual(repaired.draft.candidate_state, {
    chakra: 8,
    mission_step: 2,
    vitality: 22
  });
});

test('successful artifacts are immutable unless review explicitly reopens them', () => {
  const reviewingRuntime = {
    ...runtime,
    review(snapshot) {
      const memory = snapshot.obligation_ledger.find(row => row.kind === 'memory');
      if (memory.current_artifact?.summary === 'semantic-bad') {
        return {
          artifact_errors: [{
            obligation_id: memory.obligation_id,
            code: 'GROUNDING_VIOLATION',
            allowed_paths: ['/summary']
          }]
        };
      }
      return {};
    }
  };
  const initial = executeTurnBundleCommand(
    freshDraft(),
    jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch({
      effect_ids: ['effect_cost_A', 'effect_damage_B', 'effect_mission_progress'],
      domain_checks: [validDomain()],
      memories: [validMemory('semantic-bad')],
      shinobi_daily: [validDaily()]
    }), binding('attempt_review_reopen')),
    reviewingRuntime
  );
  const reopened = initial.draft.obligation_ledger.find(row => row.kind === 'memory');
  assert.equal(initial.result.status, 'REPAIR_REQUIRED');
  assert.equal(reopened.status, 'REOPENED');
  assert.equal(reopened.correction_generation, 1);
  assert.deepEqual(
    initial.result.allowed_paths.find(item => item.id === reopened.obligation_id).json_pointers,
    ['/summary']
  );

  const corrected = executeTurnBundleCommand(
    initial.draft,
    jsonCommand(CONTINUITY_OPERATIONS.REPAIR, patch({
      memories: [validMemory('semantic-good')]
    }), binding('attempt_review_replacement')),
    reviewingRuntime
  );
  const ledger = corrected.draft.obligation_ledger.find(row => row.kind === 'memory');
  assert.equal(corrected.result.status, 'READY');
  assert.equal(ledger.current_artifact_revision, 2);
  assert.deepEqual(ledger.versions.map(version => version.status), ['SUPERSEDED', 'CURRENT']);
  assert.equal(ledger.versions[0].artifact.summary, 'semantic-bad');
  assert.equal(ledger.versions[1].artifact.summary, 'semantic-good');
});

test('different content for an already consumed obligation conflicts but same content is idempotent', () => {
  const staged = executeTurnBundleCommand(
    freshDraft(),
    jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch({
      effect_ids: ['effect_cost_A'],
      memories: [validMemory()]
    }), binding('attempt_artifact_stage')),
    runtime
  );
  const repair = executeTurnBundleCommand(
    staged.draft,
    jsonCommand(CONTINUITY_OPERATIONS.REPAIR, patch({
      effect_ids: ['effect_damage_B', 'effect_mission_progress'],
      domain_checks: [validDomain()],
      memories: [validMemory(), validMemory('changed without reopen')],
      shinobi_daily: [validDaily()]
    }), binding('attempt_artifact_conflict')),
    runtime
  );
  assert.ok(repair.result.idempotent.some(item => item.id === 'obligation_memory_actor_A'));
  assert.ok(repair.result.errors.some(error => (
    error.id === 'obligation_memory_actor_A' && error.code === 'IDEMPOTENCY_CONFLICT'
  )));
  assert.equal(
    repair.draft.obligation_ledger.find(row => row.kind === 'memory').versions.length,
    1
  );
});

test('stale fences and tampered successful effect hashes fail closed without consuming again', () => {
  const staged = executeTurnBundleCommand(
    freshDraft(),
    jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch({ effect_ids: ['effect_cost_A'] }), binding('attempt_fence')),
    runtime
  );
  const stale = jsonCommand(CONTINUITY_OPERATIONS.REPAIR, patch(), {
    ...binding('attempt_stale'),
    lease_fence: 6
  });
  assert.throws(
    () => executeTurnBundleCommand(staged.draft, stale, runtime),
    error => error instanceof DomainError && error.code === 'STALE_LEASE_FENCE'
  );

  const tampered = JSON.parse(JSON.stringify(staged.draft));
  tampered.frozen_effects.find(effect => effect.effect_id === 'effect_cost_A').effect_hash = 'sha256:changed';
  const conflict = executeTurnBundleCommand(
    tampered,
    jsonCommand(CONTINUITY_OPERATIONS.REPAIR, patch({
      effect_ids: ['effect_cost_A']
    }), binding('attempt_effect_hash_conflict')),
    runtime
  );
  assert.ok(conflict.result.errors.some(error => error.code === 'IDEMPOTENCY_CONFLICT'));
  assert.equal(conflict.draft.candidate_state.chakra, 8);
});

test('source draft and command remain byte-identical and outputs contain no time or random dependency', () => {
  const draft = freshDraft();
  const command = jsonCommand(CONTINUITY_OPERATIONS.STAGE, patch({
    effect_ids: ['effect_cost_A']
  }), binding('attempt_immutable'));
  const draftBefore = JSON.stringify(draft);
  const commandBefore = JSON.stringify(command);
  const first = executeTurnBundleCommand(draft, command, runtime);
  const second = executeTurnBundleCommand(freshDraft(), command, runtime);
  assert.equal(JSON.stringify(draft), draftBefore);
  assert.equal(JSON.stringify(command), commandBefore);
  assert.deepEqual(first.draft, second.draft);
  assert.equal(JSON.stringify(first.draft).includes('created_at'), false);
  assert.ok(Object.isFrozen(first.draft));
  assert.ok(Object.isFrozen(first.draft.candidate_state));
});

console.log(`multiplayer continuity/draft regression: ${passed} passed`);
