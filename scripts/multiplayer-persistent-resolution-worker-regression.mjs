import assert from 'node:assert/strict';

import {
  MODEL_ENDPOINT_PROFILE_SCHEMA
} from '../server/multiplayer/contracts/billing-contracts.js';
import {
  COMMIT_PRECONDITION_SET_SCHEMA
} from '../server/multiplayer/contracts/commit-contracts.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  createBilledProviderClient
} from '../server/multiplayer/agent/billed-provider-client.js';
import {
  createProviderModelClient
} from '../server/multiplayer/agent/provider-adapters.js';
import {
  BOUND_CONTEXT_FIELDS,
  createPersistentResolutionWorker
} from '../server/multiplayer/agent/persistent-resolution-worker.js';

const SHA = character => `sha256:${character.repeat(64)}`;
const HMAC = character => `hmac-sha256:${character.repeat(64)}`;

let passed = 0;
async function test(name, callback) {
  await callback();
  passed += 1;
  console.log(`PASS ${name}`);
}

function createUsageRepository(log = []) {
  const rows = [];
  const starts = [];
  const failures = [];
  const byId = id => rows.find(row => row.invocation_id === id);
  return {
    rows,
    starts,
    failures,
    async start(input) {
      log.push(`usage.start:${input.stage}:${input.attempt}`);
      starts.push({ ...input });
      const unresolved = rows.find(row => (
        row.stage === input.stage
          && row.audience === (input.audience ?? 'shared')
          && ['IN_FLIGHT', 'UNKNOWN'].includes(row.status)
      ));
      if (unresolved) {
        throw new DomainError('MODEL_INVOCATION_UNRESOLVED', 'unresolved invocation');
      }
      const row = {
        invocation_id: input.invocation_id,
        turn_id: 'turn_worker',
        plan_hash: input.plan_hash,
        payer_user_id: input.authenticated_user_id,
        stage: input.stage,
        audience: input.audience ?? 'shared',
        attempt: input.attempt,
        reserved_input_tokens: input.reserved_input_tokens,
        reserved_output_tokens: input.reserved_output_tokens,
        reserved_retry_count: rows.some(entry => (
          entry.stage === input.stage
            && entry.audience === (input.audience ?? 'shared')
            && entry.budget_charge_state !== 'RELEASED'
        )) ? 1 : 0,
        budget_charge_state: 'RESERVED',
        status: 'IN_FLIGHT'
      };
      rows.push(row);
      return { usage: { ...row }, replayed: false };
    },
    async acknowledge(input) {
      log.push(`usage.acknowledge:${input.invocation_id}`);
      const row = byId(input.invocation_id);
      assert.equal(row.status, 'IN_FLIGHT');
      Object.assign(row, {
        status: 'SUCCEEDED',
        budget_charge_state: 'SETTLED',
        provider_request_id: input.provider_request_id,
        input_tokens: input.input_tokens,
        output_tokens: input.output_tokens
      });
      return { usage: { ...row }, replayed: false };
    },
    async fail(input) {
      log.push(`usage.fail:${input.invocation_id}`);
      failures.push({ ...input });
      const row = byId(input.invocation_id);
      Object.assign(row, {
        status: 'FAILED',
        budget_charge_state: input.release_budget === true ? 'RELEASED' : 'SETTLED',
        provider_request_id: input.provider_request_id ?? null,
        input_tokens: input.input_tokens ?? null,
        output_tokens: input.output_tokens ?? null
      });
      return { usage: { ...row }, replayed: false };
    },
    async markUnknown(input) {
      log.push(`usage.unknown:${input.invocation_id}`);
      const row = byId(input.invocation_id);
      row.status = 'UNKNOWN';
      return { usage: { ...row }, replayed: false };
    },
    async listForTurn() {
      return rows.map(row => ({ ...row }));
    }
  };
}

function profile() {
  return {
    schema: MODEL_ENDPOINT_PROFILE_SCHEMA,
    profile_id: 'profile_worker',
    owner_user_id: 'payer_worker',
    config_revision: 1,
    adapter: 'openai_compatible',
    endpoint: {
      normalized_base_url: 'https://models.example.com/v1',
      normalized_origin: 'https://models.example.com'
    },
    model: 'worker-model',
    auth_scheme: 'none',
    credential_ref: null,
    capabilities: {
      native_tools: false,
      strict_json: true,
      error_correction_continuation: true
    },
    recommended_continuity_transport: 'json_protocol',
    config_fingerprint: SHA('1')
  };
}

function readyBundleResult() {
  return {
    schema: 'naruto.continuity-bundle-result/v1',
    status: 'READY',
    draft_revision: 1,
    retryable_by: 'none',
    pause_reason: null,
    turn_state: null,
    resume_stage: null,
    accepted: [],
    idempotent: [],
    errors: [],
    review: { status: 'APPROVED' },
    next_operation: null,
    allowed_effect_ids: [],
    allowed_obligation_ids: [],
    allowed_paths: [],
    ready_receipt: { status: 'READY' }
  };
}

function commitRequest() {
  return {
    preconditions: {
      schema: COMMIT_PRECONDITION_SET_SCHEMA,
      identity: {
        room_id: 'room_worker',
        epoch_id: 'epoch_worker',
        turn_id: 'turn_worker',
        run_id: 'run_worker',
        draft_id: 'draft_worker',
        commit_id: 'commit_worker'
      },
      lifecycle: {
        room_lifecycle: 'ACTIVE',
        epoch_state: 'ACTIVE',
        turn_status: 'COMMITTING',
        current_turn_id: 'turn_worker',
        void_requested: false
      },
      concurrency: {
        base_state_revision: 4,
        base_state_hash: SHA('2'),
        lease_fence: 1,
        draft_revision: 1,
        draft_status: 'READY'
      },
      frozen_inputs: {
        input_hash: HMAC('3'),
        resolution_hash: SHA('4'),
        obligation_set_hash: SHA('5'),
        execution_plan_hash: SHA('6')
      },
      billing: { billing_provenance_hash: SHA('7') },
      result: {
        candidate_state_hash: SHA('8'),
        artifact_bundle_hash: SHA('9'),
        narrative_bundle_hash: SHA('a'),
        semantic_draft_hash: SHA('b'),
        commit_envelope_hash: SHA('c')
      }
    },
    checkpoint_id: 'checkpoint_worker',
    snapshot_id: 'snapshot_worker',
    snapshot: {
      snapshot_id: 'snapshot_worker',
      state_revision: 5,
      state_hash: SHA('8'),
      snapshot_ciphertext: Buffer.alloc(24, 1),
      wrapped_data_key: Buffer.alloc(24, 2),
      nonce: Buffer.alloc(12, 3),
      auth_tag: Buffer.alloc(16, 4),
      master_key_version: 'snapshot-key-v1'
    },
    committed_at: '2026-08-22T12:00:00.000Z'
  };
}

await test('billed client marks ambiguous transport failure UNKNOWN and never claims failure', async () => {
  const log = [];
  const usage = createUsageRepository(log);
  const checkpoints = [];
  const client = createBilledProviderClient({
    client: {
      async invoke() {
        log.push('provider.send');
        throw new DomainError('MODEL_ENDPOINT_REQUEST_TIMEOUT', 'timeout');
      }
    },
    usage_repository: usage,
    assert_lease: async () => { log.push('lease.assert'); },
    scope: {
      room_id: 'room_worker',
      plan_hash: SHA('d'),
      payer_user_id: 'payer_worker',
      stage: 'referee',
      audience: null
    },
    invocation_id_factory: () => 'invocation_timeout',
    checkpoint_response: event => { checkpoints.push(event); }
  });
  await assert.rejects(
    () => client.invoke({}),
    error => error instanceof DomainError && error.code === 'MODEL_ENDPOINT_REQUEST_TIMEOUT'
  );
  assert.equal(usage.rows[0].status, 'UNKNOWN');
  assert.equal(usage.rows[0].reserved_input_tokens, Buffer.byteLength('{}', 'utf8'));
  assert.equal(usage.rows[0].reserved_output_tokens, 1);
  assert.equal(usage.rows[0].budget_charge_state, 'RESERVED');
  assert.equal(checkpoints[0].status, 'UNKNOWN');
  assert.deepEqual(log.slice(0, 5), [
    'lease.assert',
    'usage.start:referee:1',
    'lease.assert',
    'provider.send',
    'usage.unknown:invocation_timeout'
  ]);
});

await test('lease loss after budget reservation releases a confirmed-unsent invocation', async () => {
  const usage = createUsageRepository();
  let assertions = 0;
  let sends = 0;
  const client = createBilledProviderClient({
    client: { async invoke() { sends += 1; } },
    usage_repository: usage,
    assert_lease: async () => {
      assertions += 1;
      if (assertions === 2) throw new DomainError('STALE_LEASE_FENCE', 'lost');
    },
    scope: {
      room_id: 'room_worker',
      plan_hash: SHA('e'),
      payer_user_id: 'payer_worker',
      stage: 'writer',
      audience: 'A'
    },
    invocation_id_factory: () => 'invocation_unsent'
  });
  await assert.rejects(
    () => client.invoke({}),
    error => error instanceof DomainError && error.code === 'STALE_LEASE_FENCE'
  );
  assert.equal(sends, 0);
  assert.equal(usage.rows[0].status, 'FAILED');
  assert.equal(usage.rows[0].budget_charge_state, 'RELEASED');
  assert.equal(usage.failures[0].release_budget, true);
});

await test('invalid usage-start receipt releases the reservation before any provider send', async () => {
  const usage = createUsageRepository();
  const start = usage.start.bind(usage);
  usage.start = async input => {
    const started = await start(input);
    started.usage.status = 'BROKEN';
    return started;
  };
  let sends = 0;
  const client = createBilledProviderClient({
    client: { async invoke() { sends += 1; } },
    usage_repository: usage,
    assert_lease: async () => {},
    scope: {
      room_id: 'room_worker',
      plan_hash: SHA('e'),
      payer_user_id: 'payer_worker',
      stage: 'writer',
      audience: 'A'
    },
    invocation_id_factory: () => 'invocation_invalid_start_receipt'
  });
  await assert.rejects(
    () => client.invoke({ max_output_tokens: 5 }),
    error => error instanceof DomainError && error.code === 'MODEL_USAGE_START_INVALID'
  );
  assert.equal(sends, 0);
  assert.equal(usage.rows[0].status, 'FAILED');
  assert.equal(usage.rows[0].budget_charge_state, 'RELEASED');
});

await test('provider return without normalized usage becomes UNKNOWN and is checkpointed', async () => {
  const log = [];
  const usage = createUsageRepository(log);
  const checkpoints = [];
  const client = createBilledProviderClient({
    client: {
      async invoke() {
        log.push('provider.return_without_usage');
        return {
          response: {
            provider_request_id: 'provider_missing_usage',
            raw_text: '{"candidate":true}'
          }
        };
      }
    },
    usage_repository: usage,
    assert_lease: async () => {},
    scope: {
      room_id: 'room_worker',
      plan_hash: SHA('e'),
      payer_user_id: 'payer_worker',
      stage: 'referee',
      audience: null
    },
    invocation_id_factory: () => 'invocation_missing_usage',
    checkpoint_response: event => { checkpoints.push(event); }
  });
  await assert.rejects(
    () => client.invoke({}),
    error => error instanceof DomainError && error.code === 'MODEL_ENDPOINT_RESPONSE_INVALID'
  );
  assert.equal(usage.rows[0].status, 'UNKNOWN');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].status, 'UNKNOWN');
  assert.equal(checkpoints[0].error_code, 'MODEL_ENDPOINT_RESPONSE_INVALID');
  assert.equal(checkpoints[0].result.response.raw_text, '{"candidate":true}');
  assert.equal(log.some(item => item.startsWith('usage.acknowledge:')), false);
});

await test('whitelisted deterministic preflight failure releases its unsent reservation', async () => {
  const usage = createUsageRepository();
  const checkpoints = [];
  const client = createBilledProviderClient({
    client: {
      async invoke() {
        throw new DomainError('MODEL_ENDPOINT_FORBIDDEN', 'blocked before HTTP send');
      }
    },
    usage_repository: usage,
    assert_lease: async () => {},
    scope: {
      room_id: 'room_worker',
      plan_hash: SHA('e'),
      payer_user_id: 'payer_worker',
      stage: 'referee',
      audience: null
    },
    invocation_id_factory: () => 'invocation_preflight_unsent',
    checkpoint_response: event => { checkpoints.push(event); }
  });
  await assert.rejects(
    () => client.invoke({ max_output_tokens: 5 }),
    error => error instanceof DomainError && error.code === 'MODEL_ENDPOINT_FORBIDDEN'
  );
  assert.equal(usage.rows[0].status, 'FAILED');
  assert.equal(usage.rows[0].budget_charge_state, 'RELEASED');
  assert.equal(usage.failures[0].release_budget, true);
  assert.equal(checkpoints[0].status, 'FAILED');
});

await test('repository output reservation caps the actual provider request', async () => {
  const usage = createUsageRepository();
  const start = usage.start.bind(usage);
  usage.start = async input => {
    const started = await start(input);
    usage.rows[0].reserved_output_tokens = 2;
    started.usage.reserved_output_tokens = 2;
    return started;
  };
  let observedMaxOutput = null;
  const client = createBilledProviderClient({
    client: {
      async invoke(request) {
        observedMaxOutput = request.max_output_tokens;
        return {
          response: {
            provider_request_id: 'provider_output_cap',
            usage: { input_tokens: 1, output_tokens: 2 }
          }
        };
      }
    },
    usage_repository: usage,
    assert_lease: async () => {},
    scope: {
      room_id: 'room_worker',
      plan_hash: SHA('e'),
      payer_user_id: 'payer_worker',
      stage: 'writer',
      audience: 'A'
    },
    invocation_id_factory: () => 'invocation_output_cap'
  });
  await client.invoke({ prompt: 'repair', max_output_tokens: 10 });
  assert.equal(observedMaxOutput, 2);
  assert.equal(usage.rows[0].status, 'SUCCEEDED');
});

await test('actual usage above reservation is recorded without an application budget failure', async () => {
  const usage = createUsageRepository();
  const checkpoints = [];
  const client = createBilledProviderClient({
    client: {
      async invoke() {
        return {
          response: {
            provider_request_id: 'provider_over_reservation',
            usage: { input_tokens: 1, output_tokens: 4 }
          }
        };
      }
    },
    usage_repository: usage,
    assert_lease: async () => {},
    scope: {
      room_id: 'room_worker',
      plan_hash: SHA('e'),
      payer_user_id: 'payer_worker',
      stage: 'writer',
      audience: 'A'
    },
    invocation_id_factory: () => 'invocation_over_reservation',
    checkpoint_response: event => { checkpoints.push(event); }
  });
  const invoked = await client.invoke({ prompt: 'repair', max_output_tokens: 3 });
  assert.equal(invoked.response.provider_request_id, 'provider_over_reservation');
  assert.equal(usage.rows[0].status, 'SUCCEEDED');
  assert.equal(usage.rows[0].budget_charge_state, 'SETTLED');
  assert.equal(usage.rows[0].output_tokens, 4);
  assert.equal(usage.failures.length, 0);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].status, 'SUCCEEDED');
});

await test('persistent worker claims/fences, bills one Continuity request, binds it, then commits READY', async () => {
  const log = [];
  const usage = createUsageRepository(log);
  const providerClient = createProviderModelClient({
    modelHttpGateway: {
      async invoke() {
        log.push('provider.send');
        return {
          provider_request_id: 'provider_worker_request',
          body: {
            id: 'response_worker',
            choices: [{
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  protocol: 'naruto.continuity-json/v1',
                  operation: 'stage_turn_bundle',
                  bundle: { effect_ids: [] }
                })
              }
            }],
            usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
          }
        };
      }
    }
  });
  const leaseState = {
    run_id: 'run_worker',
    run_status: 'QUEUED',
    owner_boot_id: null,
    owner_task_id: null,
    lease_fence: 0,
    claimed_at: null,
    heartbeat_at: null,
    lease_expires_at: null,
    attempt_count: 0
  };
  const leases = {
    async claim(input) {
      log.push('lease.claim');
      Object.assign(leaseState, {
        run_status: 'CLAIMED',
        owner_boot_id: input.owner_boot_id,
        owner_task_id: input.owner_task_id,
        lease_fence: 1,
        attempt_count: 1,
        claimed_at: input.now,
        heartbeat_at: input.now,
        lease_expires_at: input.expires_at
      });
      return { ...leaseState };
    },
    async start() {
      log.push('lease.start');
      leaseState.run_status = 'RUNNING';
      return { ...leaseState };
    },
    async renew() { return { ...leaseState }; },
    async release(input) {
      log.push(`lease.release:${input.next_status}`);
      leaseState.run_status = input.next_status;
      return { ...leaseState };
    },
    async assertFence(input) {
      log.push('lease.assert');
      assert.equal(input.lease_fence, 1);
      assert.equal(leaseState.run_status, 'RUNNING');
      return { ...leaseState };
    },
    async listClaimable() { return [{ run_id: 'run_worker' }]; }
  };
  const stage = {
    client: providerClient,
    profile: profile(),
    owner_user_id: 'payer_worker',
    transport_mode: 'json_protocol'
  };
  const billingPlan = {
    plan_hash: SHA('f'),
    stage_plans: ['continuity_steward', 'continuity_repair'].map(name => ({
      stage: name,
      audience: null,
      payer_user_id: 'payer_worker'
    }))
  };
  const checkpointed = [];
  const workflow = {
    async load() {
      log.push('workflow.load');
      return {
        run_id: 'run_worker',
        room_id: 'room_worker',
        epoch_id: 'epoch_worker',
        turn_id: 'turn_worker',
        lease_fence: 1,
        billing_plan: billingPlan,
        model_stages: {
          'continuity_steward:shared': stage,
          'continuity_repair:shared': stage
        }
      };
    },
    async checkpointInvocation(input) {
      log.push(`workflow.checkpoint:${input.event.status}`);
      checkpointed.push(input.event);
    },
    async prepareResolution() {
      log.push('workflow.prepareResolution');
      return { cached: { canonical_resolution: true } };
    },
    async adoptResolution() { throw new Error('resolution is cached'); },
    async prepareNarrative() {
      log.push('workflow.prepareNarrative');
      return { cached: { grounded_narrative: true } };
    },
    async adoptNarrative() { throw new Error('narrative is cached'); },
    async prepareContinuity() {
      log.push('workflow.prepareContinuity');
      return {
        cached_ready: null,
        initial_prompt: '{"stage":"continuity","operation":"stage_turn_bundle"}',
        max_model_requests: 2,
        reducer_runtime: {}
      };
    },
    async createBoundContinuityContext(input) {
      log.push('workflow.bindContinuity');
      return {
        room_id: 'room_worker',
        epoch_id: 'epoch_worker',
        turn_id: 'turn_worker',
        run_id: 'run_worker',
        continuity_session_id: 'continuity_session_worker',
        invocation_id: input.invocation_id,
        command_attempt_id: input.command_attempt_id,
        draft_id: 'draft_worker',
        base_state_revision: 4,
        resolution_hash: SHA('4'),
        obligation_set_hash: SHA('5'),
        execution_plan_hash: SHA('6'),
        stage_billing_plan_hash: SHA('f'),
        billing_provenance_hash: SHA('7'),
        agent_role: 'continuity_steward',
        transport_mode: 'json_protocol',
        prompt_version: 'multiplayer-continuity-steward/v1',
        lease_fence: 1
      };
    },
    async prepareCommit() {
      log.push('workflow.prepareCommit');
      return commitRequest();
    },
    async recoverCommit() {
      return { status: 'NOT_COMMITTED' };
    },
    async recordPause() { log.push('workflow.pause'); }
  };
  let boundContext = null;
  const continuityRepository = {
    async executeTransport(input) {
      log.push('continuity.execute');
      boundContext = input.bound_context;
      return { result: readyBundleResult() };
    }
  };
  const commitRepository = {
    async commitTurn(request) {
      log.push('commit.turn');
      assert.deepEqual(request, commitRequest());
      leaseState.run_status = 'SUCCEEDED';
      return { commit_id: 'commit_worker', replayed: false };
    }
  };
  const worker = createPersistentResolutionWorker({
    leases,
    billing_usage: usage,
    billing_plans: {
      async recoverAuthorizedPause() {
        throw new Error('successful workflow must not recover a billing pause');
      }
    },
    continuity_repository: continuityRepository,
    commit_repository: commitRepository,
    workflow_repository: workflow,
    owner_boot_id: 'boot_worker',
    task_id_factory: () => 'task_worker',
    invocation_id_factory: () => 'invocation_worker',
    command_attempt_id_factory: () => 'command_attempt_worker',
    clock: () => '2026-08-22T12:00:00.000Z',
    heartbeat_enabled: false
  });
  const result = await worker.process('run_worker');
  assert.equal(result.status, 'COMMITTED');
  assert.equal(usage.rows.length, 1, 'one Bundle is one billed provider request');
  assert.equal(usage.rows[0].status, 'SUCCEEDED');
  assert.equal(checkpointed.length, 1, 'provider output is cached before adoption');
  assert.deepEqual(Object.keys(boundContext).sort(), [...BOUND_CONTEXT_FIELDS].sort());
  assert.equal(boundContext.invocation_id, 'invocation_worker');
  assert.equal(boundContext.lease_fence, 1);
  assert.equal(log.indexOf('usage.start:continuity_steward:1') < log.indexOf('provider.send'), true);
  assert.equal(log.indexOf('workflow.checkpoint:SUCCEEDED') < log.indexOf('continuity.execute'), true);
  assert.equal(log.indexOf('continuity.execute') < log.indexOf('commit.turn'), true);
  assert.equal(log.some(item => item.startsWith('lease.release:')), false);
});

await test('billing pause releases its lease before same-timestamp authorized recovery', async () => {
  const log = [];
  let pauseInput = null;
  let releaseInput = null;
  let recoveryInput = null;
  const lease = {
    run_id: 'run_billing_pause',
    run_status: 'RUNNING',
    owner_boot_id: 'boot_billing_pause',
    owner_task_id: 'task_billing_pause',
    lease_fence: 3,
    claimed_at: '2026-08-22T13:00:00.000Z',
    heartbeat_at: '2026-08-22T13:00:00.000Z',
    lease_expires_at: '2026-08-22T13:02:00.000Z',
    attempt_count: 1
  };
  const leases = {
    async claim() { log.push('lease.claim'); return { ...lease, run_status: 'CLAIMED' }; },
    async start() { log.push('lease.start'); return { ...lease }; },
    async renew() { return { ...lease }; },
    async assertFence() { log.push('lease.assert'); return { ...lease }; },
    async release(input) {
      log.push('lease.release');
      releaseInput = input;
      return { ...lease, run_status: 'PAUSED' };
    },
    async listClaimable() { return []; }
  };
  const unavailable = async () => { throw new Error('unreachable'); };
  const workflow = {
    async load() {
      throw new DomainError(
        'BILLING_BUDGET_EXHAUSTED',
        'authorization needs amendment',
        {
          upstream_status: 429,
          provider_request_id: 'provider_pause_429',
          upstream_error_code: 'rate_limit_exceeded',
          upstream_error_summary: 'rate limit reached',
          unsafe_secret: 'must-not-project'
        }
      );
    },
    checkpointInvocation: unavailable,
    prepareResolution: unavailable,
    adoptResolution: unavailable,
    prepareNarrative: unavailable,
    adoptNarrative: unavailable,
    prepareContinuity: unavailable,
    createBoundContinuityContext: unavailable,
    prepareCommit: unavailable,
    recoverCommit: unavailable,
    async recordPause(input) {
      log.push('workflow.pause');
      pauseInput = input;
    }
  };
  const worker = createPersistentResolutionWorker({
    leases,
    billing_usage: createUsageRepository(),
    billing_plans: {
      async recoverAuthorizedPause(input) {
        log.push('billing.recover');
        recoveryInput = input;
        return null;
      }
    },
    continuity_repository: { executeTransport: unavailable },
    commit_repository: { commitTurn: unavailable },
    workflow_repository: workflow,
    owner_boot_id: 'boot_billing_pause',
    task_id_factory: () => 'task_billing_pause',
    clock: () => '2026-08-22T13:00:00.000Z',
    heartbeat_enabled: false
  });
  const result = await worker.process('run_billing_pause');
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.reason, 'BILLING_BUDGET_EXHAUSTED');
  assert.equal(log.indexOf('workflow.pause') < log.indexOf('lease.release'), true);
  assert.equal(log.indexOf('lease.release') < log.indexOf('billing.recover'), true);
  assert.equal(pauseInput.paused_at, releaseInput.now);
  assert.equal(pauseInput.turn_id, null);
  assert.deepEqual(pauseInput.detail, {
    upstream_status: 429,
    provider_request_id: 'provider_pause_429',
    upstream_error_code: 'rate_limit_exceeded',
    upstream_error_summary: 'rate limit reached'
  });
  assert.deepEqual(recoveryInput, {
    run_id: 'run_billing_pause',
    paused_at: pauseInput.paused_at
  });
});

console.log(`${passed} persistent resolution worker regression tests passed.`);
