import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CONTINUITY_JSON_PROTOCOL,
  CONTINUITY_OPERATIONS,
  bindContinuityCommand,
  decodeJsonContinuityCommand,
  decodeNativeContinuityCommand
} from '../server/multiplayer/domain/continuity-bundle.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import { createTurnDraft } from '../server/multiplayer/domain/turn-draft.js';
import { createResolutionRunLeaseRepository } from '../server/multiplayer/persistence/resolution-run-leases.js';
import {
  createSqliteContinuityDraftRepository
} from '../server/multiplayer/persistence/sqlite-continuity-draft-repository.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

const NOW = '2026-08-22T08:00:00.000Z';
const EXPIRES = '2026-08-22T08:00:30.000Z';
const TAKEOVER = '2026-08-22T08:01:00.000Z';
const TAKEOVER_EXPIRES = '2026-08-22T08:02:00.000Z';
const HASH = suffix => `sha256:${String(suffix).padStart(64, '0')}`;
const HMAC = suffix => `hmac-sha256:${String(suffix).padStart(64, '0')}`;

let passed = 0;
async function test(name, operation) {
  try {
    await operation();
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
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
    if (item.reason_code !== 'NO_CANONICAL_CHANGE'
      || !Array.isArray(item.evidence_event_ids)) {
      throw new DomainError('SCHEMA_VIOLATION', 'invalid domain check', {
        path: '/reason_code', allowed_paths: ['/reason_code', '/evidence_event_ids']
      });
    }
    return item;
  },
  memory(item) {
    strictKeys(item, ['obligation_id', 'summary', 'entries'], 'memory');
    if (typeof item.summary !== 'string' || !item.summary
      || !Array.isArray(item.entries)) {
      throw new DomainError('SCHEMA_VIOLATION', 'memory summary is required', {
        path: '/summary', allowed_paths: ['/summary']
      });
    }
    for (let index = 0; index < item.entries.length; index += 1) {
      const entry = item.entries[index];
      if (entry.event_refs?.includes('event_private_B')) {
        throw new DomainError('AUDIENCE_VIOLATION', 'memory crossed its audience', {
          path: `/entries/${index}/event_refs`,
          allowed_paths: [`/entries/${index}/event_refs`]
        });
      }
    }
    return item;
  },
  shinobi_daily(item) {
    strictKeys(item, ['obligation_id', 'daily', 'source_refs'], 'daily');
    if (item.daily?.schema !== 'naruto.shinobi-daily/v1'
      || !Array.isArray(item.source_refs?.headline)) {
      throw new DomainError('SCHEMA_VIOLATION', 'daily sources are invalid', {
        path: '/source_refs/headline', allowed_paths: ['/source_refs']
      });
    }
    return item;
  }
};

const reducers = {
  apply_resource(candidate, effect) {
    const next = { ...candidate, [effect.payload.stat]: (
      candidate[effect.payload.stat] + effect.payload.delta
    ) };
    if (next[effect.payload.stat] < 0) {
      throw new DomainError('PRECONDITION_FAILED', 'resource would become negative', {
        retryable_by: 'referee'
      });
    }
    return {
      nextCandidate: next,
      normalizedOperations: [{
        target_id: effect.target_id,
        stat: effect.payload.stat,
        delta: effect.payload.delta
      }],
      invariantResults: [{ code: 'NON_NEGATIVE', passed: true }]
    };
  }
};

const runtime = Object.freeze({
  validators,
  reducers,
  rule_snapshot: { version: 'rules/persistence-v1' }
});

const EFFECTS = Object.freeze([
  Object.freeze({
    effect_id: 'effect_cost_A',
    effect_seq: 1,
    effect_hash: HASH(101),
    required_reducer: 'apply_resource',
    reducer_version: 'resource/v1',
    depends_on_effect_ids: [],
    target_kind: 'room_actor',
    target_id: 'actor_A',
    operation: 'adjust_resource',
    payload: { stat: 'chakra', delta: -4 }
  }),
  Object.freeze({
    effect_id: 'effect_damage_B',
    effect_seq: 2,
    effect_hash: HASH(102),
    required_reducer: 'apply_resource',
    reducer_version: 'resource/v1',
    depends_on_effect_ids: ['effect_cost_A'],
    target_kind: 'room_actor',
    target_id: 'actor_B',
    operation: 'adjust_resource',
    payload: { stat: 'vitality', delta: -7 }
  })
]);

const OBLIGATIONS = Object.freeze([
  Object.freeze({
    obligation_id: 'obligation_domain_relationships',
    kind: 'domain_check',
    bound_scope: ['actor_A', 'actor_B']
  }),
  Object.freeze({
    obligation_id: 'obligation_memory_actor_A',
    kind: 'memory',
    target_binding: 'actor_A'
  }),
  Object.freeze({
    obligation_id: 'obligation_daily_turn_1',
    kind: 'shinobi_daily',
    target_binding: 'world_public'
  })
]);

function validDomain() {
  return {
    obligation_id: 'obligation_domain_relationships',
    reason_code: 'NO_CANONICAL_CHANGE',
    evidence_event_ids: ['event_public_1']
  };
}

function validMemory(summary = 'A 记住了东部驿道的战斗。') {
  return {
    obligation_id: 'obligation_memory_actor_A',
    summary,
    entries: [{
      kind: 'fact',
      text: '袭击者已被击退。',
      event_refs: ['event_public_1']
    }]
  };
}

function validDaily() {
  return {
    obligation_id: 'obligation_daily_turn_1',
    daily: {
      schema: 'naruto.shinobi-daily/v1',
      headline: '东部驿道恢复通行'
    },
    source_refs: { headline: ['public:event_1'] }
  };
}

function fullBundle(memory = validMemory()) {
  return {
    effect_ids: ['effect_damage_B', 'effect_cost_A'],
    domain_checks: [validDomain()],
    memories: [memory],
    shinobi_daily: [validDaily()]
  };
}

function draft() {
  return createTurnDraft({
    room_id: 'room_1',
    epoch_id: 'epoch_1',
    draft_id: 'draft_1',
    turn_id: 'turn_1',
    run_id: 'run_1',
    continuity_session_id: 'continuity_1',
    lease_fence: 7,
    base_state_revision: 0,
    base_state_hash: HASH(1),
    resolution_hash: HASH(2),
    obligation_set_hash: HASH(3),
    execution_plan_hash: HASH(4),
    billing_provenance_hash: HASH(5),
    narrative_bundle_hash: HASH(6),
    projection_bundle_hash: HASH(7),
    rule_snapshot_hash: HASH(8),
    prompt_version: 'continuity/persistence-v1',
    base_candidate: { chakra: 12, vitality: 30 },
    effects: EFFECTS,
    obligations: OBLIGATIONS
  });
}

function envelopeCodec() {
  return Object.freeze({
    sealJson(value) {
      return Object.freeze({
        ciphertext: Buffer.from(JSON.stringify(value), 'utf8'),
        wrapped_data_key: Buffer.alloc(16, 1),
        nonce: Buffer.alloc(12, 2),
        auth_tag: Buffer.alloc(16, 3),
        master_key_version: 'test-key-v1'
      });
    },
    openJson(envelope) {
      return JSON.parse(Buffer.from(envelope.ciphertext).toString('utf8'));
    }
  });
}

let nextGeneratedId = 0;
function idFactory() {
  return kind => `${kind}_test_${++nextGeneratedId}`;
}

function seedAuthority(database, transport) {
  database.prepare(`
    INSERT INTO multiplayer_rooms (
      room_id, origin_type, lineage_id, origin_owner_user_id, origin_snapshot_id,
      lifecycle, host_user_id, state_revision, control_revision, event_seq,
      active_narrative_mode, queued_narrative_mode, created_at, updated_at
    ) VALUES ('room_1', 'new_multiplayer_save', 'lineage_1', NULL,
      'snapshot_origin_1', 'LOBBY', 'user_A', 0, 0, 0, 'shared', NULL, ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO room_epochs (
      epoch_id, room_id, lineage_id, epoch_no, base_type, base_ref_id,
      base_state_hash, genesis_checkpoint_id, head_checkpoint_id,
      state_revision, control_revision, epoch_state, created_from_proposal_id,
      activated_at, archived_at
    ) VALUES ('epoch_1', 'room_1', 'lineage_1', 1, 'origin_snapshot',
      'snapshot_origin_1', ?, 'checkpoint_0', 'checkpoint_0', 0, 0,
      'ACTIVE', NULL, ?, NULL)
  `).run(HASH(1), NOW);
  database.prepare(`
    INSERT INTO room_checkpoints (
      checkpoint_id, room_id, lineage_id, epoch_id, turn_no, checkpoint_kind,
      parent_checkpoint_id, turn_id, commit_id, state_revision, state_hash,
      snapshot_ref, created_at
    ) VALUES ('checkpoint_0', 'room_1', 'lineage_1', 'epoch_1', 0, 'genesis',
      NULL, NULL, NULL, 0, ?, 'snapshot_genesis_1', ?)
  `).run(HASH(1), NOW);
  database.prepare(`
    UPDATE multiplayer_rooms
       SET lifecycle = 'ACTIVE', active_epoch_id = 'epoch_1'
     WHERE room_id = 'room_1'
  `).run();
  database.prepare(`
    INSERT INTO multiplayer_turns (
      turn_id, room_id, epoch_id, turn_no, turn_status, narrative_mode,
      base_checkpoint_id, base_state_revision, base_state_hash,
      execution_plan_json, execution_plan_hash, input_hash, sealed_at,
      committed_at, voided_at, created_at, updated_at
    ) VALUES ('turn_1', 'room_1', 'epoch_1', 1, 'STAGING_UPDATES', 'shared',
      'checkpoint_0', 0, ?, '{}', ?, ?, ?, NULL, NULL, ?, ?)
  `).run(HASH(1), HASH(4), HMAC(1), NOW, NOW, NOW);
  database.prepare(`
    UPDATE multiplayer_rooms SET current_turn_id = 'turn_1' WHERE room_id = 'room_1'
  `).run();
  database.prepare(`
    INSERT INTO resolution_runs (
      run_id, room_id, epoch_id, turn_id, turn_no, input_hash, stage,
      run_status, owner_boot_id, owner_task_id, claimed_at, heartbeat_at,
      lease_expires_at, lease_fence, attempt_count, prompt_version,
      model_fingerprint, transport, bundle_schema_version, reducer_version,
      created_at, updated_at
    ) VALUES ('run_1', 'room_1', 'epoch_1', 'turn_1', 1, ?, 'continuity',
      'RUNNING', 'boot_1', 'task_1', ?, ?, ?, 7, 1,
      'continuity/persistence-v1', ?, ?, 'bundle/v1', 'reducers/v1', ?, ?)
  `).run(HMAC(1), NOW, NOW, EXPIRES, HASH(9), transport, NOW, NOW);
}

async function createHarness(databasePath, {
  transport = 'json_protocol',
  faultInjector = null,
  create = true
} = {}) {
  const connection = await openMultiplayerRepositoryTestSqlite({
    databasePath,
    migrationOptions: { clock: () => NOW }
  });
  if (create) connection.write(database => seedAuthority(database, transport));
  if (create) await connection.write(() => undefined);
  const repository = createSqliteContinuityDraftRepository(connection, {
    envelopeCodec: envelopeCodec(),
    idFactory: idFactory(),
    clock: () => NOW,
    faultInjector
  });
  if (create) {
    await repository.createSession({
      stage_session_id: 'stage_session_1',
      draft: draft(),
      transport,
      created_at: NOW
    });
  }
  return { connection, repository };
}

function transportInput(transport, operation, bundle) {
  if (transport === 'native_tools') {
    return {
      transport_mode: transport,
      tool_name: operation,
      raw_arguments: bundle
    };
  }
  return {
    transport_mode: transport,
    response_text: JSON.stringify({
      protocol: CONTINUITY_JSON_PROTOCOL,
      operation,
      bundle
    })
  };
}

function context(
  attempt,
  fence = 7,
  invocation = `invocation_${attempt}`,
  transport = 'json_protocol'
) {
  return {
    room_id: 'room_1',
    epoch_id: 'epoch_1',
    turn_id: 'turn_1',
    run_id: 'run_1',
    continuity_session_id: 'continuity_1',
    invocation_id: invocation,
    command_attempt_id: attempt,
    draft_id: 'draft_1',
    base_state_revision: 0,
    resolution_hash: HASH(2),
    obligation_set_hash: HASH(3),
    execution_plan_hash: HASH(4),
    billing_provenance_hash: HASH(5),
    agent_role: 'continuity_steward',
    transport_mode: transport,
    prompt_version: 'continuity/persistence-v1',
    lease_fence: fence,
    stage_billing_plan_hash: HASH(10)
  };
}

function boundCommand(operation, bundle, bound, transport = 'json_protocol') {
  const decoded = transport === 'native_tools'
    ? decodeNativeContinuityCommand(operation, bundle)
    : decodeJsonContinuityCommand(JSON.stringify({
      protocol: CONTINUITY_JSON_PROTOCOL,
      operation,
      bundle
    }));
  return bindContinuityCommand(decoded, bound);
}

async function execute(repository, transport, attempt, operation, bundle, fence = 7) {
  return repository.executeTransport({
    transport_input: transportInput(transport, operation, bundle),
    bound_context: context(attempt, fence, `invocation_${attempt}`, transport),
    runtime
  });
}

async function expectDomainError(operation, code) {
  await assert.rejects(
    operation,
    error => error instanceof DomainError && error.code === code
  );
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-continuity-persistence-'));

try {
  await test('native and JSON transports persist identical semantic draft results', async () => {
    const nativePath = path.join(tempRoot, 'native.sqlite');
    const jsonPath = path.join(tempRoot, 'json.sqlite');
    const native = await createHarness(nativePath, { transport: 'native_tools' });
    const json = await createHarness(jsonPath, { transport: 'json_protocol' });
    try {
      const nativeResult = await execute(
        native.repository,
        'native_tools',
        'attempt_equivalent',
        CONTINUITY_OPERATIONS.STAGE,
        fullBundle()
      );
      const jsonResult = await execute(
        json.repository,
        'json_protocol',
        'attempt_equivalent',
        CONTINUITY_OPERATIONS.STAGE,
        fullBundle()
      );
      assert.equal(nativeResult.result.status, 'READY');
      assert.equal(jsonResult.result.status, 'READY');
      assert.deepEqual(nativeResult.draft.candidate_state, jsonResult.draft.candidate_state);
      assert.equal(nativeResult.draft.candidate_state_hash, jsonResult.draft.candidate_state_hash);
      assert.equal(nativeResult.draft.artifact_bundle_hash, jsonResult.draft.artifact_bundle_hash);
      assert.equal(nativeResult.draft.semantic_draft_hash, jsonResult.draft.semantic_draft_hash);
    } finally {
      await native.connection.close();
      await json.connection.close();
    }
  });

  await test('every server-only BoundContinuityContext field is matched before decoding or writing', async () => {
    const harness = await createHarness(path.join(tempRoot, 'bound-context.sqlite'));
    const input = transportInput(
      'json_protocol',
      CONTINUITY_OPERATIONS.STAGE,
      { effect_ids: ['effect_cost_A'] }
    );
    try {
      const mismatches = [
        ['room_id', 'room_other', 'INVALID_BOUND_CONTEXT'],
        ['epoch_id', 'epoch_other', 'INVALID_BOUND_CONTEXT'],
        ['turn_id', 'turn_other', 'INVALID_BOUND_CONTEXT'],
        ['draft_id', 'draft_other', 'INVALID_BOUND_CONTEXT'],
        ['base_state_revision', 1, 'INVALID_BOUND_CONTEXT'],
        ['resolution_hash', HASH(202), 'INVALID_BOUND_CONTEXT'],
        ['obligation_set_hash', HASH(203), 'INVALID_BOUND_CONTEXT'],
        ['execution_plan_hash', HASH(204), 'INVALID_BOUND_CONTEXT'],
        ['billing_provenance_hash', HASH(205), 'INVALID_BOUND_CONTEXT'],
        ['agent_role', 'referee', 'INVALID_BOUND_CONTEXT'],
        ['transport_mode', 'native_tools', 'CONTINUITY_TRANSPORT_MISMATCH'],
        ['prompt_version', 'continuity/other-v1', 'INVALID_BOUND_CONTEXT'],
        ['lease_fence', 6, 'STALE_LEASE_FENCE']
      ];
      for (let index = 0; index < mismatches.length; index += 1) {
        const [field, value, code] = mismatches[index];
        const invalid = {
          ...context(`attempt_context_${index}`),
          [field]: value
        };
        await expectDomainError(
          () => harness.repository.executeTransport({
            transport_input: input,
            bound_context: invalid,
            runtime
          }),
          code
        );
      }
      for (const field of ['invocation_id', 'command_attempt_id', 'stage_billing_plan_hash']) {
        const invalid = { ...context(`attempt_missing_${field}`) };
        delete invalid[field];
        await expectDomainError(
          () => harness.repository.executeTransport({
            transport_input: input,
            bound_context: invalid,
            runtime
          }),
          'INVALID_BOUND_CONTEXT'
        );
      }
      const persisted = harness.connection.read(database => ({
        draft_revision: database.prepare(`SELECT draft_revision FROM turn_drafts`).get().draft_revision,
        command_count: database.prepare(`SELECT COUNT(*) AS count FROM turn_continuity_commands`).get().count,
        item_count: database.prepare(`SELECT COUNT(*) AS count FROM turn_continuity_command_items`).get().count
      }));
      assert.deepEqual(persisted, {
        draft_revision: 0,
        command_count: 0,
        item_count: 0
      });
    } finally {
      await harness.connection.close();
    }
  });

  await test('valid effects persist while invalid memory remains unconsumed for repair', async () => {
    const harness = await createHarness(path.join(tempRoot, 'partial.sqlite'));
    try {
      const invalidMemory = validMemory();
      invalidMemory.entries[0].event_refs = ['event_private_B'];
      const staged = await execute(
        harness.repository,
        'json_protocol',
        'attempt_partial',
        CONTINUITY_OPERATIONS.STAGE,
        {
          effect_ids: ['effect_cost_A'],
          memories: [invalidMemory]
        }
      );
      assert.equal(staged.result.status, 'REPAIR_REQUIRED');
      assert.equal(staged.draft.candidate_state.chakra, 8);
      const persisted = harness.connection.read(database => ({
        items: database.prepare(`
          SELECT item_kind, item_id, item_status, consumed, error_code
            FROM turn_continuity_command_items ORDER BY item_seq
        `).all(),
        effects: database.prepare(`SELECT effect_id, receipt_hash FROM turn_draft_effects`).all(),
        memory: database.prepare(`
          SELECT obligation_status, current_artifact_revision
            FROM turn_draft_obligations WHERE obligation_id = 'obligation_memory_actor_A'
        `).get()
      }));
      assert.deepEqual(persisted.items.map(row => [row.item_id, row.item_status, row.consumed]), [
        ['effect_cost_A', 'ACCEPTED', 1],
        ['obligation_memory_actor_A', 'REJECTED', 0]
      ]);
      assert.equal(persisted.items[1].error_code, 'AUDIENCE_VIOLATION');
      assert.equal(persisted.effects.length, 1);
      assert.deepEqual(persisted.memory, {
        obligation_status: 'OPEN',
        current_artifact_revision: null
      });

      const repaired = await execute(
        harness.repository,
        'json_protocol',
        'attempt_partial_repair',
        CONTINUITY_OPERATIONS.REPAIR,
        fullBundle()
      );
      assert.equal(repaired.result.status, 'READY');
      assert.equal(repaired.result.idempotent.some(item => item.id === 'effect_cost_A'), true);
      assert.equal(harness.connection.read(database => database.prepare(`
        SELECT COUNT(*) AS count FROM turn_draft_effects WHERE effect_id = 'effect_cost_A'
      `).get().count), 1);
    } finally {
      await harness.connection.close();
    }
  });

  await test('RepairPlan and continuity session survive restart and resume only pending work', async () => {
    const databasePath = path.join(tempRoot, 'repair-resume.sqlite');
    const first = await createHarness(databasePath);
    let repairPlan;
    try {
      const staged = await execute(
        first.repository,
        'json_protocol',
        'attempt_repair_resume_stage',
        CONTINUITY_OPERATIONS.STAGE,
        { effect_ids: ['effect_cost_A'] }
      );
      assert.equal(staged.result.status, 'REPAIR_REQUIRED');
      repairPlan = staged.draft.repair_plan;
      assert.deepEqual(repairPlan.allowed_effect_ids, ['effect_damage_B']);
      assert.deepEqual(
        repairPlan.allowed_obligation_ids,
        [
          'obligation_daily_turn_1',
          'obligation_domain_relationships',
          'obligation_memory_actor_A'
        ]
      );
    } finally {
      await first.connection.close();
    }

    const restarted = await createHarness(databasePath, { create: false });
    try {
      const restored = restarted.repository.loadSession({
        run_id: 'run_1',
        continuity_session_id: 'continuity_1'
      });
      assert.equal(restored.continuity_session_id, 'continuity_1');
      assert.equal(restored.session_status, 'WAITING_REPAIR');
      assert.equal(restored.pending_command, null);
      assert.deepEqual(restored.draft.repair_plan, repairPlan);
      const repaired = await execute(
        restarted.repository,
        'json_protocol',
        'attempt_repair_resume_finish',
        CONTINUITY_OPERATIONS.REPAIR,
        fullBundle()
      );
      assert.equal(repaired.result.status, 'READY');
      assert.equal(repaired.result.idempotent.some(item => item.id === 'effect_cost_A'), true);
      const persisted = restarted.connection.read(database => ({
        command_count: database.prepare(`
          SELECT COUNT(*) AS count FROM turn_continuity_commands
        `).get().count,
        effect_cost_count: database.prepare(`
          SELECT COUNT(*) AS count FROM turn_draft_effects
           WHERE effect_id = 'effect_cost_A'
        `).get().count
      }));
      assert.deepEqual(persisted, { command_count: 2, effect_cost_count: 1 });
    } finally {
      await restarted.connection.close();
    }
  });

  await test('mid-command process loss resumes from persisted item ledgers after reopen', async () => {
    const baseline = await createHarness(path.join(tempRoot, 'crash-baseline.sqlite'));
    let uninterruptedResult;
    try {
      uninterruptedResult = (await execute(
        baseline.repository,
        'json_protocol',
        'attempt_crash',
        CONTINUITY_OPERATIONS.STAGE,
        fullBundle()
      )).result;
    } finally {
      await baseline.connection.close();
    }
    const databasePath = path.join(tempRoot, 'crash.sqlite');
    let crashOnce = true;
    const first = await createHarness(databasePath, {
      faultInjector(event) {
        if (crashOnce && event.phase === 'after_item_persisted') {
          crashOnce = false;
          throw new Error('simulated process loss');
        }
      }
    });
    let receiptHash;
    try {
      await assert.rejects(
        execute(
          first.repository,
          'json_protocol',
          'attempt_crash',
          CONTINUITY_OPERATIONS.STAGE,
          fullBundle()
        ),
        /simulated process loss/u
      );
      const partial = first.connection.read(database => ({
        command: database.prepare(`
          SELECT command_status FROM turn_continuity_commands
           WHERE command_attempt_id = 'attempt_crash'
        `).get(),
        effect: database.prepare(`
          SELECT receipt_hash FROM turn_draft_effects WHERE effect_id = 'effect_cost_A'
        `).get(),
        draft: database.prepare(`SELECT draft_revision FROM turn_drafts`).get()
      }));
      assert.equal(partial.command.command_status, 'IN_PROGRESS');
      assert.equal(partial.draft.draft_revision, 1);
      receiptHash = partial.effect.receipt_hash;
    } finally {
      await first.connection.close();
    }

    const restarted = await createHarness(databasePath, { create: false });
    try {
      const recovered = await restarted.repository.recoverInProgress({
        run_id: 'run_1',
        continuity_session_id: 'continuity_1',
        runtime
      });
      assert.equal(recovered.result.status, 'READY');
      assert.deepEqual(recovered.result, uninterruptedResult);
      assert.deepEqual(recovered.result.idempotent, []);
      const after = restarted.connection.read(database => ({
        effects: database.prepare(`
          SELECT effect_id, receipt_hash FROM turn_draft_effects ORDER BY effect_seq
        `).all(),
        items: database.prepare(`
          SELECT item_status FROM turn_continuity_command_items ORDER BY item_seq
        `).all(),
        command: database.prepare(`
          SELECT command_status, immutable_result_hash
            FROM turn_continuity_commands WHERE command_attempt_id = 'attempt_crash'
        `).get()
      }));
      assert.equal(after.effects.length, 2);
      assert.equal(after.effects[0].receipt_hash, receiptHash);
      assert.equal(after.items.every(row => row.item_status === 'ACCEPTED'), true);
      assert.equal(after.command.command_status, 'ACCEPTED');
      assert.match(after.command.immutable_result_hash, /^sha256:[a-f0-9]{64}$/u);
    } finally {
      await restarted.connection.close();
    }
  });

  await test('exact command replay is immutable and changed content conflicts', async () => {
    const harness = await createHarness(path.join(tempRoot, 'replay.sqlite'));
    try {
      const command = boundCommand(
        CONTINUITY_OPERATIONS.STAGE,
        { effect_ids: ['effect_cost_A'] },
        context('attempt_exact', 7, 'invocation_exact')
      );
      const first = await harness.repository.executeCommand({ command, runtime });
      assert.equal(first.result.status, 'REPAIR_REQUIRED');
      await execute(
        harness.repository,
        'json_protocol',
        'attempt_exact_repair',
        CONTINUITY_OPERATIONS.REPAIR,
        fullBundle()
      );
      const replay = await harness.repository.executeCommand({ command, runtime });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);
      assert.equal(replay.replay_context.current_draft_revision > first.result.draft_revision, true);

      const changed = boundCommand(
        CONTINUITY_OPERATIONS.STAGE,
        { effect_ids: ['effect_cost_A', 'effect_damage_B'] },
        context('attempt_exact', 7, 'invocation_exact')
      );
      await expectDomainError(
        () => harness.repository.executeCommand({ command: changed, runtime }),
        'IDEMPOTENCY_CONFLICT'
      );
    } finally {
      await harness.connection.close();
    }
  });

  await test('review reopen preserves v1 and replacement creates audited v2', async () => {
    const harness = await createHarness(path.join(tempRoot, 'reopen.sqlite'));
    const reviewingRuntime = {
      ...runtime,
      review(snapshot) {
        const memory = snapshot.obligation_ledger.find(row => row.kind === 'memory');
        return memory.current_artifact?.summary === 'semantic-bad'
          ? {
              artifact_errors: [{
                obligation_id: memory.obligation_id,
                code: 'GROUNDING_VIOLATION',
                allowed_paths: ['/summary']
              }]
            }
          : {};
      }
    };
    try {
      const initial = await harness.repository.executeTransport({
        transport_input: transportInput(
          'json_protocol',
          CONTINUITY_OPERATIONS.STAGE,
          fullBundle(validMemory('semantic-bad'))
        ),
        bound_context: context('attempt_reopen'),
        runtime: reviewingRuntime
      });
      assert.equal(initial.result.status, 'REPAIR_REQUIRED');
      assert.equal(harness.connection.read(database => database.prepare(`
        SELECT obligation_status FROM turn_draft_obligations
         WHERE obligation_id = 'obligation_memory_actor_A'
      `).get().obligation_status), 'REOPENED');

      const corrected = await harness.repository.executeTransport({
        transport_input: transportInput(
          'json_protocol',
          CONTINUITY_OPERATIONS.REPAIR,
          { memories: [validMemory('semantic-good')] }
        ),
        bound_context: context('attempt_reopen_repair'),
        runtime: reviewingRuntime
      });
      assert.equal(corrected.result.status, 'READY');
      const versions = harness.connection.read(database => database.prepare(`
        SELECT artifact_revision, artifact_status, artifact_hash
          FROM turn_draft_artifact_versions
         WHERE obligation_id = 'obligation_memory_actor_A'
         ORDER BY artifact_revision
      `).all());
      assert.deepEqual(versions.map(row => [row.artifact_revision, row.artifact_status]), [
        [1, 'SUPERSEDED'],
        [2, 'CURRENT']
      ]);
      assert.notEqual(versions[0].artifact_hash, versions[1].artifact_hash);
    } finally {
      await harness.connection.close();
    }
  });

  await test('billing and runtime pauses restore their exact resume cursor', async () => {
    const harness = await createHarness(path.join(tempRoot, 'pause.sqlite'));
    try {
      const billing = await harness.repository.pauseSession({
        run_id: 'run_1',
        continuity_session_id: 'continuity_1',
        lease_fence: 7,
        pause_reason: 'BILLING_AUTHORIZATION_REQUIRED',
        resume_stage: 'STAGING_UPDATES',
        paused_at: NOW
      });
      assert.equal(billing.pause.turn_state, 'AWAITING_BILLING_AUTHORIZATION');
      assert.equal(billing.pause.resume_stage, 'STAGING_UPDATES');
      const resumedBilling = await harness.repository.resumeSession({
        run_id: 'run_1', continuity_session_id: 'continuity_1', lease_fence: 7,
        resumed_at: NOW
      });
      assert.equal(resumedBilling.pause, null);
      assert.equal(resumedBilling.draft.turn_state, 'STAGING_UPDATES');

      const runtimePause = await harness.repository.pauseSession({
        run_id: 'run_1',
        continuity_session_id: 'continuity_1',
        lease_fence: 7,
        pause_reason: 'RECOVERABLE_RUNTIME_FAULT',
        resume_stage: 'REPAIRING_DRAFT',
        paused_at: NOW
      });
      assert.equal(runtimePause.pause.turn_state, 'REPAIR_PAUSED');
      assert.equal(runtimePause.pause.resume_stage, 'REPAIRING_DRAFT');
      const resumedRuntime = await harness.repository.resumeSession({
        run_id: 'run_1', continuity_session_id: 'continuity_1', lease_fence: 7,
        resumed_at: NOW
      });
      assert.equal(resumedRuntime.draft.turn_state, 'REPAIRING_DRAFT');
    } finally {
      await harness.connection.close();
    }
  });

  await test('lease takeover rebinds pending work and rejects the old fence', async () => {
    let stopAfterFirstItem = true;
    const harness = await createHarness(path.join(tempRoot, 'fence.sqlite'), {
      faultInjector(event) {
        if (stopAfterFirstItem && event.phase === 'after_item_persisted') {
          stopAfterFirstItem = false;
          throw new Error('worker stopped after first item');
        }
      }
    });
    const oldCommand = boundCommand(
      CONTINUITY_OPERATIONS.STAGE,
      fullBundle(),
      context('attempt_takeover')
    );
    try {
      await assert.rejects(
        harness.repository.executeCommand({ command: oldCommand, runtime }),
        /worker stopped/u
      );
      const leases = createResolutionRunLeaseRepository(harness.connection);
      const claimed = await leases.claim({
        run_id: 'run_1',
        owner_boot_id: 'boot_2',
        owner_task_id: 'task_2',
        now: TAKEOVER,
        expires_at: TAKEOVER_EXPIRES
      });
      assert.equal(claimed.lease_fence, 8);
      await harness.repository.adoptLease({
        run_id: 'run_1',
        continuity_session_id: 'continuity_1',
        new_lease_fence: 8,
        expected_previous_lease_fence: 7,
        adopted_at: TAKEOVER
      });
      await expectDomainError(
        () => harness.repository.executeCommand({ command: oldCommand, runtime }),
        'STALE_LEASE_FENCE'
      );
      const recovered = await harness.repository.recoverInProgress({
        run_id: 'run_1', continuity_session_id: 'continuity_1', runtime
      });
      assert.equal(recovered.result.status, 'READY');
      assert.equal(recovered.draft.lease_fence, 8);
    } finally {
      await harness.connection.close();
    }
  });

  await test('item transaction rollback leaves command recoverable and consumes nothing', async () => {
    let installFailure = true;
    let connectionRef;
    const harness = await createHarness(path.join(tempRoot, 'rollback.sqlite'), {
      async faultInjector(event) {
        if (installFailure && event.phase === 'after_command_started') {
          installFailure = false;
          await connectionRef.write(database => database.exec(`
            CREATE TRIGGER reject_first_effect
            BEFORE INSERT ON turn_draft_effects
            BEGIN
              SELECT RAISE(ABORT, 'injected effect ledger failure');
            END;
          `));
        }
      }
    });
    connectionRef = harness.connection;
    try {
      await assert.rejects(
        execute(
          harness.repository,
          'json_protocol',
          'attempt_rollback',
          CONTINUITY_OPERATIONS.STAGE,
          fullBundle()
        ),
        /injected effect ledger failure/u
      );
      const afterRollback = harness.connection.read(database => ({
        draft: database.prepare(`SELECT draft_revision FROM turn_drafts`).get(),
        items: database.prepare(`SELECT COUNT(*) AS count FROM turn_continuity_command_items`).get(),
        effects: database.prepare(`SELECT COUNT(*) AS count FROM turn_draft_effects`).get(),
        command: database.prepare(`SELECT command_status FROM turn_continuity_commands`).get()
      }));
      assert.equal(afterRollback.draft.draft_revision, 0);
      assert.equal(afterRollback.items.count, 0);
      assert.equal(afterRollback.effects.count, 0);
      assert.equal(afterRollback.command.command_status, 'IN_PROGRESS');
      await harness.connection.write(database => database.exec('DROP TRIGGER reject_first_effect'));
      const recovered = await harness.repository.recoverInProgress({
        run_id: 'run_1', continuity_session_id: 'continuity_1', runtime
      });
      assert.equal(recovered.result.status, 'READY');
    } finally {
      await harness.connection.close();
    }
  });
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer continuity persistence regression: ${passed} passed`);
