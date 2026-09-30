import { randomUUID } from 'node:crypto';
import { narrativeLengthRequirements, narrativeQualityFindings } from './narrative-quality.js';

import { assertContinuityBundleResult } from '../contracts/continuity-contracts.js';
import { canonicalizeJson } from '../domain/canonical-json.js';
import { CONTINUITY_OPERATIONS } from '../domain/continuity-bundle.js';
import { DomainError } from '../domain/errors.js';
import {
  appendTrustedProtocolResult
} from './provider-adapters.js';
import {
  CONTINUITY_SYSTEM_PROMPT,
  NARRATIVE_GROUNDING_REVIEWER_SYSTEM_PROMPT,
  REFEREE_SYSTEM_PROMPT,
  RESOLUTION_COMPLETENESS_REVIEWER_SYSTEM_PROMPT,
  WRITER_SYSTEM_PROMPT,
  buildGroundingReviewerPrompt,
  buildRefereePrompt,
  buildResolutionCompletenessPrompt,
  buildWriterPrompt
} from './prompts.js';
import {
  emptyStageUsage,
  invokeContinuityModel,
  invokeNarrativeGroundingReviewer,
  invokeRefereeModel,
  invokeResolutionCompletenessReviewer,
  invokeWriterModel
} from './model-stages.js';
import {
  validateNarrativeContracts,
  narrativeAudiencesForMode,
  routeNarrativeGroundingReview
} from './narrative-contract-validator.js';
import {
  precheckResolutionCompleteness,
  routeResolutionCompletenessReview
} from './resolution-completeness.js';

function immutable(value) {
  const result = canonicalizeJson(value, { maxDepth: 96, maxNodes: 500_000 });
  const freeze = item => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(result);
}

function addUsage(target, usage) {
  for (const key of [
    'requests',
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens'
  ]) target[key] += usage?.[key] ?? 0;
}

function validateRepairLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 32) {
    throw new DomainError(
      'MODEL_STAGE_CONFIGURATION_INVALID',
      `${name} must be an integer from 0 through 32`,
      {},
      { status: 500 }
    );
  }
  return value;
}

/**
 * Referee -> deterministic rule reconciliation -> semantic completeness.
 * Neither Writer nor Continuity is called until both completeness gates pass.
 */
export async function runResolutionAgentPipeline({
  referee_stage,
  resolution_repair_stage = referee_stage,
  completeness_reviewer_stage,
  referee_input,
  evidence = {},
  mechanical_effect_requirements = [],
  derive_mechanical_effect_requirements = null,
  validate_resolution_candidate = null,
  max_referee_repairs = 3
}) {
  const repairLimit = validateRepairLimit(max_referee_repairs, 'max_referee_repairs');
  if (validate_resolution_candidate !== null && typeof validate_resolution_candidate !== 'function') {
    throw new DomainError('MODEL_STAGE_CONFIGURATION_INVALID',
      'validate_resolution_candidate must be a function', {}, { status: 500 });
  }
  if (derive_mechanical_effect_requirements !== null
    && typeof derive_mechanical_effect_requirements !== 'function') {
    throw new DomainError(
      'MODEL_STAGE_CONFIGURATION_INVALID',
      'derive_mechanical_effect_requirements must be a function',
      {},
      { status: 500 }
    );
  }
  let refereeSession = null;
  let refereePrompt = buildRefereePrompt({
    referee_input,
    evidence,
    transport_mode: referee_stage.transport_mode
  });
  const calls = {
    referee: 0,
    resolution_repair: 0,
    resolution_completeness_reviewer: 0
  };
  const usage = {
    referee: emptyStageUsage(),
    resolution_repair: emptyStageUsage(),
    resolution_completeness_reviewer: emptyStageUsage()
  };
  const repairHistory = [];
  let refereeCheckResults = [];

  for (let repairRound = 0; ; repairRound += 1) {
    const currentRefereeStage = repairRound === 0
      ? referee_stage
      : {
          ...referee_stage,
          ...resolution_repair_stage,
          // A semantic repair continues the exact same Referee protocol
          // session; payer accounting may change stage scope, never protocol.
          transport_mode: referee_stage.transport_mode,
          execute_check: referee_stage.execute_check
        };
    const billedStage = repairRound === 0 ? 'referee' : 'resolution_repair';
    const referee = await invokeRefereeModel({
      ...currentRefereeStage,
      system_prompt: currentRefereeStage.system_prompt ?? REFEREE_SYSTEM_PROMPT,
      prompt: refereePrompt,
      session: refereeSession,
      prior_check_results: refereeCheckResults
    });
    refereePrompt = null;
    refereeSession = referee.session;
    refereeCheckResults = [...referee.check_results];
    calls[billedStage] += referee.calls;
    addUsage(usage[billedStage], referee.usage);

    // Run the real adoption contract before asking a semantic reviewer. A
    // plausible description of an unsupported operation is still not executable.
    const contractFindings = validate_resolution_candidate
      ? await validate_resolution_candidate(referee.candidate) : [];
    if (contractFindings.length) {
      const route = { source: 'resolution_adoption_precheck', retry_route: 'referee', findings: contractFindings };
      repairHistory.push(route);
      if (repairRound >= repairLimit) {
        return immutable({ status: 'REPAIR_REQUIRED', resolution_candidate: referee.candidate,
          rule_precheck: null, completeness_review: null,
          retry_route: { stage: 'referee', reason: 'ADOPTION_CONTRACT_REJECTED' },
          calls, usage, repair_history: repairHistory, referee_session: refereeSession,
          check_results: refereeCheckResults });
      }
      refereeSession = appendTrustedProtocolResult(refereeSession, { result: route });
      continue;
    }

    const derived = derive_mechanical_effect_requirements
      ? await derive_mechanical_effect_requirements({
          referee_input,
          resolution_candidate: referee.candidate,
          repair_round: repairRound
        })
      : { requirements: [], findings: [] };
    const derivedRequirements = Array.isArray(derived)
      ? derived
      : (derived?.requirements ?? []);
    const derivedFindings = Array.isArray(derived)
      ? []
      : (derived?.findings ?? []);
    const precheck = precheckResolutionCompleteness({
      resolution_candidate: referee.candidate,
      mechanical_effect_requirements: [
        ...mechanical_effect_requirements,
        ...derivedRequirements
      ],
      mechanical_rule_findings: derivedFindings
    });
    if (precheck.status === 'REJECTED') {
      const route = {
        source: 'resolution_rule_precheck',
        retry_route: 'referee',
        findings: precheck.findings
      };
      repairHistory.push(route);
      if (repairRound >= repairLimit) {
        return immutable({
          status: 'REPAIR_REQUIRED',
          resolution_candidate: referee.candidate,
          rule_precheck: precheck,
          completeness_review: null,
          retry_route: { stage: 'referee', reason: 'RULE_PRECHECK_REJECTED' },
          calls,
          usage,
          repair_history: repairHistory,
          referee_session: refereeSession,
          check_results: refereeCheckResults
        });
      }
      refereeSession = appendTrustedProtocolResult(refereeSession, { result: route });
      continue;
    }

    const completeness = await invokeResolutionCompletenessReviewer({
      ...completeness_reviewer_stage,
      system_prompt: completeness_reviewer_stage.system_prompt
        ?? RESOLUTION_COMPLETENESS_REVIEWER_SYSTEM_PROMPT,
      prompt: buildResolutionCompletenessPrompt({
        referee_input,
        resolution_candidate: referee.candidate,
        rule_precheck_receipt: precheck
      })
    });
    calls.resolution_completeness_reviewer += completeness.calls;
    addUsage(usage.resolution_completeness_reviewer, completeness.usage);
    const semanticRoute = routeResolutionCompletenessReview(completeness.value);
    if (semanticRoute.status === 'APPROVED') {
      return immutable({
        status: 'APPROVED',
        resolution_candidate: referee.candidate,
        rule_precheck: precheck,
        completeness_review: completeness.value,
        retry_route: null,
        calls,
        usage,
        repair_history: repairHistory,
        referee_session: refereeSession,
        check_results: refereeCheckResults
      });
    }

    const route = {
      source: 'resolution_completeness_reviewer',
      retry_route: 'referee',
      findings: semanticRoute.findings
    };
    repairHistory.push(route);
    if (repairRound >= repairLimit) {
      return immutable({
        status: 'REPAIR_REQUIRED',
        resolution_candidate: referee.candidate,
        rule_precheck: precheck,
        completeness_review: completeness.value,
        retry_route: { stage: 'referee', reason: 'SEMANTIC_COMPLETENESS_REJECTED' },
        calls,
        usage,
        repair_history: repairHistory,
        referee_session: refereeSession,
        check_results: refereeCheckResults
      });
    }
    refereeSession = appendTrustedProtocolResult(refereeSession, { result: route });
  }
}

function audienceSeat(audience) {
  if (audience === 'seat:A') return 'A';
  if (audience === 'seat:B') return 'B';
  return null;
}

function stageForAudience(stages, audience) {
  const stage = stages?.[audience]
    ?? stages?.[audienceSeat(audience)]
    ?? stages?.shared;
  if (!stage) {
    throw new DomainError('WRITER_STAGE_MISSING', `Writer stage is missing for ${audience}`);
  }
  return stage;
}

function projectionForAudience(projections, audience) {
  return projections?.[audience]
    ?? projections?.[audience.replace(':', '_')]
    ?? (audience === 'shared' ? projections?.shared : null);
}

/**
 * Shared/dual Writer runtime with partial cache preservation. Contract or
 * grounding errors only invalidate the named Writer audiences; the unique
 * resolution and successful sibling Writer are never rerun.
 */
export async function runNarrativeAgentPipeline({
  narrative_mode,
  canonical_resolution,
  resolution_commitment,
  audience_projections,
  writer_action_projections,
  writer_stages,
  grounding_reviewer_stage,
  history_by_audience = {},
  style_requirements = {},
  turn_purpose = 'player_actions',
  opening_context = null,
  max_writer_repairs = 3,
  max_reviewer_protocol_retries = 2,
  id_factory = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`
}) {
  const writerRepairLimit = validateRepairLimit(max_writer_repairs, 'max_writer_repairs');
  style_requirements = narrativeLengthRequirements(style_requirements, turn_purpose);
  const reviewerRetryLimit = validateRepairLimit(
    max_reviewer_protocol_retries,
    'max_reviewer_protocol_retries'
  );
  const audiences = narrativeAudiencesForMode(narrative_mode);
  const candidates = {};
  const writerSessions = {};
  const calls = {
    writer: Object.fromEntries(audiences.map(audience => [audience, 0])),
    narrative_grounding_reviewer: 0
  };
  const usage = {
    writer: Object.fromEntries(audiences.map(audience => [audience, emptyStageUsage()])),
    narrative_grounding_reviewer: emptyStageUsage()
  };
  let pendingAudiences = [...audiences];
  let feedbackByAudience = {};
  let writerRepairRound = 0;
  let reviewerProtocolFailures = 0;
  const routingHistory = [];

  while (true) {
    const writerResults = await Promise.all(pendingAudiences.map(async audience => {
      const stage = stageForAudience(writer_stages, audience);
      calls.writer[audience] += 1;
      try {
        const existingSession = writerSessions[audience] ?? null;
        const repairFeedback = feedbackByAudience[audience] ?? null;
        const result = await invokeWriterModel({
          ...stage,
          system_prompt: stage.system_prompt ?? WRITER_SYSTEM_PROMPT,
          prompt: existingSession
            ? null
            : buildWriterPrompt({
                audience,
                audience_projection: projectionForAudience(audience_projections, audience),
                canonical_stop_point: canonical_resolution.stop_point,
                writer_action_projection: writer_action_projections?.[audience]
                  ?? writer_action_projections?.[audience.replace(':', '_')],
                history: history_by_audience?.[audience] ?? {},
                style_requirements,
                turn_purpose,
                opening_context,
                repair_feedback: repairFeedback
              }),
          session: existingSession,
          trusted_result: existingSession && repairFeedback
            ? {
                schema: 'naruto.multiplayer-writer-repair-feedback/v1',
                audience,
                instruction: '这是内部改稿意见，继续完成本回合。保留已成立的剧情，把不合理的成功叙述改回裁决支持的尝试、受阻或合理结果；不要拒绝玩家、要求重输或在正文解释审核，不得新增玩家选择或状态后果。',
                findings: repairFeedback
              }
            : null
        });
        addUsage(usage.writer[audience], result.usage);
        return { audience, result, error: null };
      } catch (error) {
        return { audience, result: null, error };
      }
    }));

    const invocationErrors = [];
    for (const item of writerResults) {
      if (item.error) {
        invocationErrors.push({
          audience: item.audience,
          code: item.error instanceof DomainError ? item.error.code : 'WRITER_INVOCATION_FAILED',
          message: item.error instanceof Error ? item.error.message : String(item.error)
        });
        delete candidates[item.audience];
      } else {
        candidates[item.audience] = item.result.value;
        writerSessions[item.audience] = item.result.session;
      }
    }
    if (invocationErrors.length) {
      const affected = invocationErrors.map(error => error.audience);
      routingHistory.push({ stage: 'writer', audiences: affected, errors: invocationErrors });
      if (writerRepairRound >= writerRepairLimit) {
        return immutable({
          status: 'REPAIR_REQUIRED',
          deliveries: [],
          grounding_review_receipts: [],
          retry_route: { stage: 'writer', audiences: affected },
          calls,
          usage,
          routing_history: routingHistory
        });
      }
      writerRepairRound += 1;
      pendingAudiences = affected;
      feedbackByAudience = Object.fromEntries(
        invocationErrors.map(error => [error.audience, [error.message]])
      );
      continue;
    }

    let contractValidation = validateNarrativeContracts({
      narrative_mode,
      candidates_by_audience: candidates,
      canonical_resolution,
      resolution_commitment
    });
    if (contractValidation.status !== 'REJECTED') {
      const errors = narrativeQualityFindings(contractValidation.deliveries, style_requirements);
      if (errors.length) contractValidation = {
        ...contractValidation, status: 'REJECTED', errors,
        retry_route: { stage: 'writer', audiences: [...new Set(errors.map(error => error.audience))] }
      };
    }
    if (contractValidation.status === 'REJECTED') {
      const affected = contractValidation.retry_route.audiences;
      routingHistory.push(contractValidation.retry_route);
      if (writerRepairRound >= writerRepairLimit) {
        return immutable({
          status: 'REPAIR_REQUIRED',
          deliveries: contractValidation.deliveries,
          grounding_review_receipts: [],
          retry_route: contractValidation.retry_route,
          calls,
          usage,
          routing_history: routingHistory
        });
      }
      writerRepairRound += 1;
      pendingAudiences = affected;
      feedbackByAudience = Object.fromEntries(affected.map(audience => [
        audience,
        contractValidation.errors
          .filter(error => error.audience === null || error.audience === audience)
          .map(error => error.message)
      ]));
      continue;
    }

    let grounding;
    try {
      const stage = grounding_reviewer_stage;
      calls.narrative_grounding_reviewer += 1;
      grounding = await invokeNarrativeGroundingReviewer({
        ...stage,
        system_prompt: stage.system_prompt ?? NARRATIVE_GROUNDING_REVIEWER_SYSTEM_PROMPT,
        prompt: buildGroundingReviewerPrompt({
          canonical_resolution,
          audience_projections: Object.fromEntries(audiences.map(audience => [
            audience,
            projectionForAudience(audience_projections, audience)
          ])),
          deliveries: contractValidation.deliveries,
          style_requirements, turn_purpose, opening_context
        }),
        expected_audiences: audiences
      });
      addUsage(usage.narrative_grounding_reviewer, grounding.usage);
      reviewerProtocolFailures = 0;
    } catch (error) {
      reviewerProtocolFailures += 1;
      routingHistory.push({
        stage: 'narrative_grounding_reviewer',
        audiences: [...audiences],
        error: error instanceof Error ? error.message : String(error)
      });
      if (reviewerProtocolFailures > reviewerRetryLimit) {
        return immutable({
          status: 'REPAIR_REQUIRED',
          deliveries: contractValidation.deliveries,
          grounding_review_receipts: [],
          retry_route: { stage: 'narrative_grounding_reviewer', audiences: [...audiences] },
          calls,
          usage,
          routing_history: routingHistory
        });
      }
      pendingAudiences = [];
      // Retry only the reviewer; the next iteration must not call Writers.
      try {
        const stage = grounding_reviewer_stage;
        calls.narrative_grounding_reviewer += 1;
        grounding = await invokeNarrativeGroundingReviewer({
          ...stage,
          system_prompt: stage.system_prompt ?? NARRATIVE_GROUNDING_REVIEWER_SYSTEM_PROMPT,
          prompt: buildGroundingReviewerPrompt({
            canonical_resolution,
            audience_projections: Object.fromEntries(audiences.map(audience => [
              audience,
              projectionForAudience(audience_projections, audience)
            ])),
            deliveries: contractValidation.deliveries,
            style_requirements, turn_purpose, opening_context
          }),
          expected_audiences: audiences
        });
        addUsage(usage.narrative_grounding_reviewer, grounding.usage);
      } catch (retryError) {
        if (reviewerProtocolFailures >= reviewerRetryLimit) {
          return immutable({
            status: 'REPAIR_REQUIRED',
            deliveries: contractValidation.deliveries,
            grounding_review_receipts: [],
            retry_route: { stage: 'narrative_grounding_reviewer', audiences: [...audiences] },
            calls,
            usage,
            routing_history: routingHistory
          });
        }
        reviewerProtocolFailures += 1;
        continue;
      }
    }

    const routed = routeNarrativeGroundingReview({
      deliveries: contractValidation.deliveries,
      grounding_candidate: grounding.value,
      reviewer_run_id: id_factory('reviewer_run'),
      review_id_factory: audience => id_factory(`review_${audience.replace(':', '_')}`)
    });
    if (routed.status === 'APPROVED') {
      return immutable({
        status: 'APPROVED',
        deliveries: contractValidation.deliveries,
        grounding_review_receipts: routed.receipts,
        retry_route: null,
        calls,
        usage,
        routing_history: routingHistory
      });
    }

    const affected = routed.retry_route.audiences;
    routingHistory.push(routed.retry_route);
    if (writerRepairRound >= writerRepairLimit) {
      return immutable({
        status: 'REPAIR_REQUIRED',
        deliveries: contractValidation.deliveries,
        grounding_review_receipts: [],
        retry_route: routed.retry_route,
        calls,
        usage,
        routing_history: routingHistory
      });
    }
    writerRepairRound += 1;
    pendingAudiences = affected;
    feedbackByAudience = Object.fromEntries(affected.map(audience => [
      audience,
      routed.findings_by_audience[audience]
    ]));
  }
}

function protocolRetryResult(error, operation) {
  return {
    schema: 'naruto.multiplayer-continuity-protocol-retry/v1',
    status: 'PROTOCOL_RETRY',
    retryable_by: 'continuity',
    next_operation: operation,
    errors: [error]
  };
}

/**
 * Continuity continuation loop. Every malformed response and every Bundle
 * result is fed back to the same provider session; accepted Bundle items stay
 * in the injected authoritative draft executor.
 */
export async function runContinuityAgentLoop({
  continuity_stage,
  continuity_repair_stage = continuity_stage,
  initial_prompt,
  reference_bindings = {},
  execute_bundle,
  max_model_requests = 8,
  resume_state = null
}) {
  if (typeof execute_bundle !== 'function') {
    throw new DomainError('MODEL_STAGE_CONFIGURATION_INVALID', 'execute_bundle is required');
  }
  const requestLimit = validateRepairLimit(max_model_requests, 'max_model_requests');
  if (requestLimit < 1) {
    throw new DomainError('MODEL_STAGE_CONFIGURATION_INVALID', 'max_model_requests must be positive');
  }
  if (resume_state !== null && (!resume_state || typeof resume_state !== 'object'
    || !Object.values(CONTINUITY_OPERATIONS).includes(resume_state.operation)
    || !Number.isSafeInteger(resume_state.next_request_no)
    || resume_state.next_request_no < 1)) {
    throw new DomainError('MODEL_STAGE_CONFIGURATION_INVALID', 'Continuity resume_state is invalid');
  }
  let operation = resume_state?.operation ?? CONTINUITY_OPERATIONS.STAGE;
  let session = resume_state?.session ?? null;
  let prompt = resume_state ? null : initial_prompt;
  let trustedResult = resume_state?.trusted_result ?? null;
  let replyToToolCallId = resume_state?.reply_to_tool_call_id ?? null;
  let replyToToolCallIds = [...(resume_state?.reply_to_tool_call_ids ?? [])];
  const firstRequestNo = resume_state?.next_request_no ?? 1;
  const lastRequestNo = firstRequestNo + requestLimit - 1;
  if (!Number.isSafeInteger(lastRequestNo)) {
    throw new DomainError(
      'MODEL_STAGE_CONFIGURATION_INVALID',
      'Continuity request sequence exceeds the safe integer range'
    );
  }
  const usage = emptyStageUsage();
  const history = [];

  // max_model_requests is the bounded breaker window for this worker run.
  // Billing repositories independently enforce the authorized total. A
  // resumed session therefore keeps its monotonic request number while still
  // receiving a fresh, bounded chance to complete pending obligations.
  for (let requestNo = firstRequestNo; requestNo <= lastRequestNo; requestNo += 1) {
    const currentStage = requestNo === 1
      ? continuity_stage
      : {
          ...continuity_stage,
          ...continuity_repair_stage,
          // Transport is invocation-frozen for the whole continuation chain.
          transport_mode: continuity_stage.transport_mode
        };
    const response = await invokeContinuityModel({
      ...currentStage,
      system_prompt: currentStage.system_prompt ?? CONTINUITY_SYSTEM_PROMPT,
      prompt,
      session,
      operation,
      trusted_result: trustedResult,
      reply_to_tool_call_id: replyToToolCallId,
      reply_to_tool_call_ids: replyToToolCallIds,
      capture_protocol_errors: true,
      reference_bindings
    });
    prompt = null;
    session = response.session;
    addUsage(usage, response.usage);
    if (response.protocol_error) {
      trustedResult = protocolRetryResult(response.protocol_error, operation);
      replyToToolCallId = response.reply_to_tool_call_id;
      replyToToolCallIds = [...response.reply_to_tool_call_ids];
      history.push({ request_no: requestNo, kind: 'protocol_error', result: trustedResult });
      continue;
    }

    const bundleResult = assertContinuityBundleResult(await execute_bundle({
      command: response.command,
      transport_input: response.transport_input,
      request_no: requestNo,
      invocation_id: response.invocation_id,
      provider_session: response.session
    }));
    history.push({
      request_no: requestNo,
      kind: 'bundle_result',
      operation,
      status: bundleResult.status,
      accepted_count: bundleResult.accepted.length,
      idempotent_count: bundleResult.idempotent.length,
      error_count: bundleResult.errors.length
    });
    if (bundleResult.status === 'READY') {
      return immutable({
        status: 'READY',
        bundle_result: bundleResult,
        session,
        calls: usage.requests,
        usage,
        history
      });
    }
    if (bundleResult.status === 'HANDOFF_REQUIRED' || bundleResult.status === 'PAUSED') {
      return immutable({
        status: bundleResult.status,
        bundle_result: bundleResult,
        session,
        calls: usage.requests,
        usage,
        history
      });
    }
    operation = bundleResult.next_operation ?? operation;
    trustedResult = bundleResult;
    replyToToolCallId = response.reply_to_tool_call_id;
    replyToToolCallIds = [...response.reply_to_tool_call_ids];
  }

  return immutable({
    status: 'REPAIR_PAUSED',
    bundle_result: null,
    session,
    calls: usage.requests,
    usage,
    history,
    resume_stage: operation,
    pause_reason: 'LOOP_BREAKER',
    continuation_state: {
      operation,
      session,
      trusted_result: trustedResult,
      reply_to_tool_call_id: replyToToolCallId,
      reply_to_tool_call_ids: replyToToolCallIds,
      next_request_no: lastRequestNo + 1
    }
  });
}
