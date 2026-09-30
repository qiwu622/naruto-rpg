import { randomUUID } from 'node:crypto';

import { assertCommitPreconditionSet } from '../contracts/commit-contracts.js';
import { DomainError } from '../domain/errors.js';
import { createBilledProviderClient } from './billed-provider-client.js';
import {
  runContinuityAgentLoop,
  runNarrativeAgentPipeline,
  runResolutionAgentPipeline
} from './stage-orchestrator.js';

const BOUND_CONTEXT_FIELDS = Object.freeze([
  'room_id',
  'epoch_id',
  'turn_id',
  'run_id',
  'continuity_session_id',
  'invocation_id',
  'command_attempt_id',
  'draft_id',
  'base_state_revision',
  'resolution_hash',
  'obligation_set_hash',
  'execution_plan_hash',
  'stage_billing_plan_hash',
  'billing_provenance_hash',
  'agent_role',
  'transport_mode',
  'prompt_version',
  'lease_fence'
]);

const PAUSABLE_ERROR_CODES = new Set([
  'BILLING_AUTHORIZATION_REQUIRED',
  'BILLING_BUDGET_EXHAUSTED',
  'DATA_PROCESSING_CONSENT_REQUIRED',
  'EXECUTION_GRANT_REQUIRED',
  'MODEL_INVOCATION_UNRESOLVED',
  'MODEL_USAGE_ACKNOWLEDGEMENT_FAILED',
  'MODEL_USAGE_SETTLEMENT_FAILED',
  'MODEL_STAGE_OUTPUT_CHECKPOINT_FAILED',
  'MODEL_ENDPOINT_REQUEST_TIMEOUT',
  'MODEL_ENDPOINT_REQUEST_ABORTED',
  'MODEL_ENDPOINT_REQUEST_FAILED'
]);
const AUTHORIZED_BILLING_PAUSE_REASONS = new Set([
  'BILLING_AUTHORIZATION_REQUIRED',
  'BILLING_BUDGET_EXHAUSTED',
  'DATA_PROCESSING_CONSENT_REQUIRED',
  'EXECUTION_GRANT_REQUIRED'
]);
const SAFE_PROVIDER_ERROR_DETAIL_FIELDS = Object.freeze([
  'upstream_status',
  'provider_request_id',
  'upstream_error_code',
  'upstream_error_type',
  'upstream_error_summary'
]);

function fail(code, message, details = {}, status = 500, cause) {
  throw new DomainError(code, message, details, { status, cause });
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 256) {
    fail('RESOLUTION_WORKER_CONFIGURATION_INVALID', `${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('RESOLUTION_WORKER_CONFIGURATION_INVALID', `${label} must be an ISO timestamp`);
  }
  return value;
}

function after(timestampValue, milliseconds) {
  return new Date(Date.parse(timestampValue) + milliseconds).toISOString();
}

function safeProviderErrorDetail(error) {
  if (!(error instanceof DomainError) || !error.details
    || typeof error.details !== 'object' || Array.isArray(error.details)) return null;
  const detail = {};
  for (const field of SAFE_PROVIDER_ERROR_DETAIL_FIELDS) {
    const value = error.details[field];
    if (field === 'upstream_status') {
      if (Number.isSafeInteger(value) && value >= 100 && value <= 599) detail[field] = value;
    } else if (typeof value === 'string' && value) {
      detail[field] = value.slice(0, field === 'upstream_error_summary' ? 500 : 200);
    }
  }
  return Object.keys(detail).length > 0 ? Object.freeze(detail) : null;
}

function generatedId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function requireMethods(value, label, methods) {
  for (const method of methods) {
    if (typeof value?.[method] !== 'function') {
      fail('RESOLUTION_WORKER_CONFIGURATION_INVALID', `${label}.${method} is required`);
    }
  }
  return value;
}

function audienceLabel(audience) {
  return audience ?? 'shared';
}

function scopeKey(stage, audience) {
  return `${stage}:${audienceLabel(audience)}`;
}

function planItem(job, stage, audience) {
  const plan = job.billing_plan;
  const item = plan?.stage_plans?.find(candidate => (
    candidate.stage === stage && candidate.audience === audience
  ));
  if (!item) {
    fail('RESOLUTION_WORKFLOW_INVALID', 'billing plan has no required stage item', {
      stage,
      audience
    });
  }
  return item;
}

function rawStage(job, stage, audience) {
  const key = scopeKey(stage, audience);
  const value = job.model_stages?.[key];
  if (!value || typeof value !== 'object' || typeof value.client?.invoke !== 'function') {
    fail('RESOLUTION_WORKFLOW_INVALID', 'model stage configuration is missing', {
      stage,
      audience,
      key
    });
  }
  return value;
}

function assertJob(job, runId, lease) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    fail('RESOLUTION_WORKFLOW_INVALID', 'workflow repository returned no job');
  }
  for (const field of ['run_id', 'room_id', 'epoch_id', 'turn_id']) identifier(job[field], field);
  if (job.run_id !== runId) fail('RESOLUTION_WORKFLOW_INVALID', 'workflow run ID changed');
  if (job.lease_fence !== lease.lease_fence) {
    fail('STALE_LEASE_FENCE', 'workflow snapshot is not bound to the claimed fence');
  }
  if (!job.billing_plan?.plan_hash || !Array.isArray(job.billing_plan.stage_plans)) {
    fail('RESOLUTION_WORKFLOW_INVALID', 'workflow has no frozen billing plan');
  }
  return job;
}

function assertBoundContext(context, job, lease, invocationId, transportMode) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    fail('BOUND_CONTINUITY_CONTEXT_INVALID', 'Continuity binding must be an object');
  }
  for (const field of BOUND_CONTEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(context, field)) {
      fail('BOUND_CONTINUITY_CONTEXT_INVALID', 'Continuity binding is incomplete', { field });
    }
  }
  for (const [field, expected] of [
    ['room_id', job.room_id],
    ['epoch_id', job.epoch_id],
    ['turn_id', job.turn_id],
    ['run_id', job.run_id],
    ['invocation_id', invocationId],
    ['agent_role', 'continuity_steward'],
    ['transport_mode', transportMode],
    ['lease_fence', lease.lease_fence]
  ]) {
    if (context[field] !== expected) {
      fail('BOUND_CONTINUITY_CONTEXT_INVALID', 'Continuity binding differs from worker authority', {
        field,
        expected,
        actual: context[field]
      });
    }
  }
  return Object.freeze({ ...context });
}

function defaultErrorDisposition(error) {
  if (error instanceof DomainError && error.code === 'STALE_LEASE_FENCE') return 'STALE';
  if (error instanceof DomainError && PAUSABLE_ERROR_CODES.has(error.code)) return 'PAUSED';
  // Preserve the run for inspection/targeted recovery. A model or persistence
  // error is not permission to erase cached successful stages.
  return 'PAUSED';
}

function createHeartbeat({
  leases,
  lease,
  ownerBootId,
  ownerTaskId,
  clock,
  leaseMs,
  heartbeatMs,
  enabled
}) {
  const abortController = new AbortController();
  let current = lease;
  let lost = null;
  let renewing = false;
  let timer = null;

  const assert = async () => {
    if (lost) throw lost;
    const now = timestamp(clock(), 'clock result');
    current = await leases.assertFence({
      run_id: current.run_id,
      owner_boot_id: ownerBootId,
      owner_task_id: ownerTaskId,
      lease_fence: current.lease_fence,
      now
    });
    return current;
  };

  const renew = async () => {
    if (renewing || lost) return;
    renewing = true;
    try {
      const now = timestamp(clock(), 'clock result');
      current = await leases.renew({
        run_id: current.run_id,
        owner_boot_id: ownerBootId,
        owner_task_id: ownerTaskId,
        lease_fence: current.lease_fence,
        now,
        expires_at: after(now, leaseMs)
      });
    } catch (error) {
      lost = error instanceof DomainError
        ? error
        : new DomainError('STALE_LEASE_FENCE', 'resolution worker lease heartbeat failed', {}, {
            cause: error
          });
      abortController.abort(lost);
    } finally {
      renewing = false;
    }
  };

  if (enabled) {
    timer = setInterval(() => { void renew(); }, heartbeatMs);
    timer.unref?.();
  }
  return Object.freeze({
    assert,
    signal: abortController.signal,
    current: () => current,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  });
}

/**
 * Persistent section-25 stage-3 worker. The workflow repository owns all
 * encrypted stage caches and authoritative input construction; this worker
 * owns lease fencing, per-HTTP usage accounting, stage routing, Continuity
 * binding, pause semantics, and READY-to-commit ordering.
 */
export function createPersistentResolutionWorker({
  leases,
  billing_usage,
  billing_plans,
  continuity_repository,
  commit_repository,
  workflow_repository,
  owner_boot_id = generatedId('boot'),
  task_id_factory = () => generatedId('task'),
  invocation_id_factory = () => generatedId('invocation'),
  command_attempt_id_factory = () => generatedId('command_attempt'),
  clock = () => new Date().toISOString(),
  lease_ms = 120_000,
  heartbeat_ms = 30_000,
  heartbeat_enabled = true,
  classify_error = defaultErrorDisposition
} = {}) {
  requireMethods(leases, 'leases', ['claim', 'start', 'renew', 'release', 'assertFence', 'listClaimable']);
  requireMethods(billing_usage, 'billing_usage', [
    'start', 'acknowledge', 'fail', 'markUnknown', 'listForTurn'
  ]);
  requireMethods(billing_plans, 'billing_plans', ['recoverAuthorizedPause']);
  requireMethods(continuity_repository, 'continuity_repository', ['executeTransport']);
  requireMethods(commit_repository, 'commit_repository', ['commitTurn']);
  requireMethods(workflow_repository, 'workflow_repository', [
    'load',
    'checkpointInvocation',
    'prepareResolution',
    'adoptResolution',
    'prepareNarrative',
    'adoptNarrative',
    'prepareContinuity',
    'createBoundContinuityContext',
    'prepareCommit',
    'recoverCommit',
    'recordPause'
  ]);
  identifier(owner_boot_id, 'owner_boot_id');
  for (const [value, label] of [
    [lease_ms, 'lease_ms'],
    [heartbeat_ms, 'heartbeat_ms']
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail('RESOLUTION_WORKER_CONFIGURATION_INVALID', `${label} must be positive`);
    }
  }
  if (heartbeat_enabled && heartbeat_ms >= lease_ms) {
    fail('RESOLUTION_WORKER_CONFIGURATION_INVALID', 'heartbeat_ms must be shorter than lease_ms');
  }
  for (const [value, label] of [
    [task_id_factory, 'task_id_factory'],
    [invocation_id_factory, 'invocation_id_factory'],
    [command_attempt_id_factory, 'command_attempt_id_factory'],
    [clock, 'clock'],
    [classify_error, 'classify_error']
  ]) {
    if (typeof value !== 'function') {
      fail('RESOLUTION_WORKER_CONFIGURATION_INVALID', `${label} must be a function`);
    }
  }

  async function process(runIdValue) {
    const runId = identifier(runIdValue, 'run_id');
    const ownerTaskId = identifier(task_id_factory(runId), 'owner_task_id');
    const claimedAt = timestamp(clock(), 'clock result');
    let lease = await leases.claim({
      run_id: runId,
      owner_boot_id,
      owner_task_id: ownerTaskId,
      now: claimedAt,
      expires_at: after(claimedAt, lease_ms)
    });
    lease = await leases.start({
      run_id: runId,
      owner_boot_id,
      owner_task_id: ownerTaskId,
      lease_fence: lease.lease_fence,
      now: timestamp(clock(), 'clock result')
    });
    const heartbeat = createHeartbeat({
      leases,
      lease,
      ownerBootId: owner_boot_id,
      ownerTaskId,
      clock,
      leaseMs: lease_ms,
      heartbeatMs: heartbeat_ms,
      enabled: heartbeat_enabled
    });
    let job = null;

    const pause = async (reason, resumeStage, error = null, failureDetail = null) => {
      const pausedAt = timestamp(clock(), 'clock result');
      const live = heartbeat.current();
      await workflow_repository.recordPause({
        run_id: runId,
        room_id: job?.room_id ?? null,
        turn_id: job?.turn_id ?? null,
        lease_fence: live.lease_fence,
        reason,
        resume_stage: resumeStage,
        error_code: error instanceof DomainError ? error.code : null,
        detail: failureDetail ?? safeProviderErrorDetail(error),
        paused_at: pausedAt
      });
      const released = await leases.release({
        run_id: runId,
        owner_boot_id,
        owner_task_id: ownerTaskId,
        lease_fence: live.lease_fence,
        next_status: 'PAUSED',
        now: pausedAt
      });
      const recovered = AUTHORIZED_BILLING_PAUSE_REASONS.has(reason)
        ? await billing_plans.recoverAuthorizedPause({
            run_id: runId,
            paused_at: pausedAt
          })
        : null;
      return Object.freeze({
        status: 'PAUSED',
        run_id: runId,
        lease_fence: live.lease_fence,
        reason,
        resume_stage: resumeStage,
        run_status: recovered?.run_status ?? released.run_status
      });
    };

    const usageHistory = new Map();
    const historiesFor = async payerUserId => {
      if (!usageHistory.has(payerUserId)) {
        usageHistory.set(payerUserId, await billing_usage.listForTurn({
          authenticated_user_id: payerUserId,
          room_id: job.room_id,
          turn_id: job.turn_id
        }));
      }
      return usageHistory.get(payerUserId);
    };

    const billedStage = async (stage, audience) => {
      const item = planItem(job, stage, audience);
      const raw = rawStage(job, stage, audience);
      if (raw.owner_user_id !== item.payer_user_id) {
        fail('RESOLUTION_WORKFLOW_INVALID', 'model stage owner differs from frozen payer', {
          stage,
          audience
        });
      }
      const history = await historiesFor(item.payer_user_id);
      const label = audienceLabel(audience);
      const sameScope = history.filter(entry => (
        entry.stage === stage && entry.audience === label
      ));
      const unresolved = sameScope.find(entry => ['IN_FLIGHT', 'UNKNOWN'].includes(entry.status));
      if (unresolved) {
        throw new DomainError(
          'MODEL_INVOCATION_UNRESOLVED',
          'stage has an unresolved invocation and cannot send another request',
          { invocation_id: unresolved.invocation_id, usage_status: unresolved.status },
          { status: 409 }
        );
      }
      const initialAttempt = sameScope.reduce(
        (maximum, entry) => Math.max(maximum, entry.attempt),
        0
      ) + 1;
      let progressAttempt = initialAttempt;
      const client = createBilledProviderClient({
        client: {
          async invoke(request) {
            await workflow_repository.recordProgress?.({
              run_id: job.run_id, turn_id: job.turn_id,
              lease_fence: heartbeat.current().lease_fence,
              model_stage: stage, attempt: progressAttempt++
            });
            return raw.client.invoke(request);
          }
        },
        usage_repository: billing_usage,
        assert_lease: heartbeat.assert,
        scope: {
          room_id: job.room_id,
          plan_hash: job.billing_plan.plan_hash,
          payer_user_id: item.payer_user_id,
          stage,
          audience
        },
        initial_attempt: initialAttempt,
        invocation_id_factory,
        checkpoint_response: event => workflow_repository.checkpointInvocation({
          run_id: job.run_id,
          room_id: job.room_id,
          epoch_id: job.epoch_id,
          turn_id: job.turn_id,
          lease_fence: heartbeat.current().lease_fence,
          event
        })
      });
      return Object.freeze({
        ...raw,
        client,
        signal: heartbeat.signal
      });
    };

    try {
      job = assertJob(await workflow_repository.load({
        run_id: runId,
        lease_fence: lease.lease_fence
      }), runId, lease);
      await heartbeat.assert();

      const resolutionPrepared = await workflow_repository.prepareResolution({
        job,
        lease_fence: lease.lease_fence
      });
      let resolution = resolutionPrepared.cached ?? null;
      if (!resolution) {
        const resolutionResult = await runResolutionAgentPipeline({
          referee_stage: await billedStage('referee', null),
          resolution_repair_stage: await billedStage('resolution_repair', null),
          completeness_reviewer_stage:
            await billedStage('resolution_completeness_reviewer', null),
          referee_input: resolutionPrepared.referee_input,
          evidence: resolutionPrepared.evidence,
          mechanical_effect_requirements:
            resolutionPrepared.mechanical_effect_requirements ?? [],
          derive_mechanical_effect_requirements:
            resolutionPrepared.derive_mechanical_effect_requirements ?? null,
          validate_resolution_candidate: resolutionPrepared.validate_resolution_candidate ?? null,
          max_referee_repairs: resolutionPrepared.max_referee_repairs ?? 3
        });
        if (resolutionResult.status !== 'APPROVED') {
          return await pause('RESOLUTION_REPAIR_REQUIRED', 'RESOLVING', null);
        }
        await heartbeat.assert();
        resolution = await workflow_repository.adoptResolution({
          job,
          lease_fence: heartbeat.current().lease_fence,
          result: resolutionResult
        });
      }

      const narrativePrepared = await workflow_repository.prepareNarrative({
        job,
        resolution,
        lease_fence: heartbeat.current().lease_fence
      });
      let narrative = narrativePrepared.cached ?? null;
      if (!narrative) {
        const audiences = narrativePrepared.narrative_mode === 'shared'
          ? [['shared', null]]
          : [['seat:A', 'A'], ['seat:B', 'B']];
        const writerStages = {};
        for (const [projectionAudience, billingAudience] of audiences) {
          writerStages[projectionAudience] = await billedStage('writer', billingAudience);
        }
        const narrativeResult = await runNarrativeAgentPipeline({
          ...narrativePrepared,
          writer_stages: writerStages,
          grounding_reviewer_stage:
            await billedStage('narrative_grounding_reviewer', null)
        });
        if (narrativeResult.status !== 'APPROVED') {
          return await pause('NARRATIVE_REPAIR_REQUIRED', 'RENDERING_REPAIR', null);
        }
        await heartbeat.assert();
        narrative = await workflow_repository.adoptNarrative({
          job,
          resolution,
          lease_fence: heartbeat.current().lease_fence,
          result: narrativeResult
        });
      }

      const continuityPrepared = await workflow_repository.prepareContinuity({
        job,
        resolution,
        narrative,
        lease_fence: heartbeat.current().lease_fence
      });
      let continuity = continuityPrepared.cached_ready ?? null;
      if (!continuity) {
        const initialContinuityStage = await billedStage('continuity_steward', null);
        const repairContinuityStage = await billedStage('continuity_repair', null);
        const continuityResult = await runContinuityAgentLoop({
          continuity_stage: initialContinuityStage,
          continuity_repair_stage: repairContinuityStage,
          initial_prompt: continuityPrepared.initial_prompt,
          reference_bindings: continuityPrepared.reference_bindings ?? {},
          resume_state: continuityPrepared.resume_state ?? null,
          max_model_requests: continuityPrepared.max_model_requests ?? 8,
          execute_bundle: async ({
            transport_input,
            invocation_id,
            request_no,
            provider_session
          }) => {
            if (!invocation_id) {
              fail('BOUND_CONTINUITY_CONTEXT_INVALID', 'billed Continuity invocation ID is missing');
            }
            await heartbeat.assert();
            const commandAttemptId = identifier(
              command_attempt_id_factory({
                run_id: job.run_id,
                invocation_id,
                request_no
              }),
              'command_attempt_id'
            );
            const context = assertBoundContext(
              await workflow_repository.createBoundContinuityContext({
                job,
                resolution,
                narrative,
                continuity: continuityPrepared,
                invocation_id,
                command_attempt_id: commandAttemptId,
                request_no,
                lease_fence: heartbeat.current().lease_fence,
                provider_session
              }),
              job,
              heartbeat.current(),
              invocation_id,
              initialContinuityStage.transport_mode
            );
            return (await continuity_repository.executeTransport({
              transport_input,
              bound_context: context,
              runtime: continuityPrepared.reducer_runtime ?? {}
            })).result;
          }
        });
        if (continuityResult.status !== 'READY') {
          const pendingErrors = continuityResult.continuation_state?.trusted_result?.errors
            ?? continuityResult.bundle_result?.errors ?? [];
          const firstError = pendingErrors[0];
          return await pause(
            continuityResult.status === 'PAUSED'
              ? continuityResult.bundle_result.pause_reason
              : continuityResult.pause_reason ?? continuityResult.status,
            continuityResult.resume_stage
              ?? continuityResult.bundle_result?.resume_stage
              ?? 'REPAIRING_DRAFT',
            firstError ? new DomainError(firstError.code, 'Continuity items require repair') : null,
            {
              failure_kind: firstError?.kind ?? 'protocol',
              repair_attempts: continuityResult.calls,
              remaining_items: new Set(pendingErrors.map(item => item.id).filter(Boolean)).size
            }
          );
        }
        continuity = continuityResult;
      }

      await heartbeat.assert();
      const commitRequest = await workflow_repository.prepareCommit({
        job,
        resolution,
        narrative,
        continuity,
        lease_fence: heartbeat.current().lease_fence,
        committed_at: timestamp(clock(), 'clock result')
      });
      assertCommitPreconditionSet(commitRequest?.preconditions);
      if (commitRequest.preconditions.concurrency.lease_fence
        !== heartbeat.current().lease_fence) {
        fail('STALE_LEASE_FENCE', 'commit preconditions use a stale lease fence');
      }
      let receipt;
      try {
        receipt = await commit_repository.commitTurn(commitRequest);
      } catch (commitError) {
        const recovery = await workflow_repository.recoverCommit({
          job,
          request: commitRequest,
          error: commitError
        });
        if (recovery?.status === 'COMMITTED') {
          receipt = recovery.receipt;
        } else {
          throw commitError;
        }
      }
      return Object.freeze({
        status: 'COMMITTED',
        run_id: runId,
        lease_fence: heartbeat.current().lease_fence,
        receipt
      });
    } catch (error) {
      const disposition = classify_error(error);
      if (disposition === 'STALE') throw error;
      if (disposition === 'PAUSED') {
        try {
          await heartbeat.assert();
          return await pause(
            error instanceof DomainError && PAUSABLE_ERROR_CODES.has(error.code)
              ? error.code
              : 'REPAIR_PAUSED',
            'RESUME_FROM_PERSISTED_STAGE',
            error
          );
        } catch (pauseError) {
          if (pauseError instanceof DomainError && pauseError.code === 'STALE_LEASE_FENCE') {
            throw pauseError;
          }
          throw error;
        }
      }
      throw error;
    } finally {
      heartbeat.stop();
    }
  }

  async function runNext({ limit = 1 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
      fail('RESOLUTION_WORKER_CONFIGURATION_INVALID', 'runNext limit must be between 1 and 32');
    }
    const claimable = await leases.listClaimable({
      now: timestamp(clock(), 'clock result'),
      limit
    });
    const results = [];
    for (const run of claimable) results.push(await process(run.run_id));
    return Object.freeze(results);
  }

  return Object.freeze({ process, runNext, owner_boot_id });
}

export { BOUND_CONTEXT_FIELDS, PAUSABLE_ERROR_CODES };
