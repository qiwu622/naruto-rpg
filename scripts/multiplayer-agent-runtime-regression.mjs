import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { SHINOBI_DAILY_EXAMPLE, validateShinobiDaily } from '../js/core/shinobi-daily.js';

import {
  MODEL_ENDPOINT_PROFILE_SCHEMA
} from '../server/multiplayer/contracts/billing-contracts.js';
import {
  NARRATIVE_GROUNDING_CANDIDATE_SCHEMA,
  RESOLUTION_COMPLETENESS_REVIEW_SCHEMA
} from '../server/multiplayer/agent/review-contracts.js';
import {
  RESOLUTION_CHECK_RESULT_SCHEMA,
  computeResolutionCheckResultHash
} from '../server/multiplayer/contracts/resolution-check-contracts.js';
import {
  appendProviderUserMessage,
  buildProviderRequest,
  createProviderModelClient,
  createProviderSession,
  normalizeProviderJsonSchema,
  normalizeProviderResponse,
  providerContinuationMessages
} from '../server/multiplayer/agent/provider-adapters.js';
import {
  buildRefereePrompt
} from '../server/multiplayer/agent/prompts.js';
import {
  invokeContinuityModel,
  invokeRefereeModel,
  invokeWriterModel,
  invokeResolutionCompletenessReviewer,
  invokeNarrativeGroundingReviewer
} from '../server/multiplayer/agent/model-stages.js';
import {
  parseStrictJsonObject
} from '../server/multiplayer/agent/strict-json.js';
import {
  runContinuityAgentLoop,
  runNarrativeAgentPipeline,
  runResolutionAgentPipeline
} from '../server/multiplayer/agent/stage-orchestrator.js';
import {
  RESOLUTION_CANDIDATE_SCHEMA,
  freezeCanonicalResolution
} from '../server/multiplayer/contracts/resolution-contracts.js';
import {
  ACTION_REQUEST_SCHEMA,
  buildRefereeInput,
  buildWriterActionProjection,
  createActionTurn,
  lockActionSubmission
} from '../server/multiplayer/domain/action-turn.js';
import { projectAudienceViews } from '../server/multiplayer/domain/audience-projector.js';
import { compileEffectDag } from '../server/multiplayer/domain/effect-dag.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import { createNewMultiplayerGenesisState } from '../server/multiplayer/application/genesis-state.js';
import { inspectDomainEffect } from '../server/multiplayer/domain/reducers/registry.js';
import {
  deriveProductionMechanicalEffectRequirements
} from '../server/multiplayer/application/production-mechanical-effect-requirements.js';

const SERVER_SECRET = 'multiplayer-agent-runtime-regression-secret';
const SHA = character => `sha256:${character.repeat(64)}`;
const HMAC = character => `hmac-sha256:${character.repeat(64)}`;

let passed = 0;
async function test(name, callback) {
  await callback();
  passed += 1;
  console.log(`PASS ${name}`);
}

function profile(adapter = 'openai_compatible', suffix = 'main') {
  return {
    schema: MODEL_ENDPOINT_PROFILE_SCHEMA,
    profile_id: `profile_${adapter}_${suffix}`,
    owner_user_id: 'payer_user',
    config_revision: 1,
    adapter,
    endpoint: {
      normalized_base_url: 'https://models.example.com/v1',
      normalized_origin: 'https://models.example.com'
    },
    model: 'regression-model',
    auth_scheme: 'none',
    credential_ref: null,
    capabilities: {
      native_tools: true,
      strict_json: true,
      error_correction_continuation: true
    },
    recommended_continuity_transport: 'native_tools',
    config_fingerprint: SHA('a')
  };
}

function openAiResponse({
  text = null,
  toolCalls = [],
  input = 10,
  output = 5,
  finishReason = toolCalls.length ? 'tool_calls' : 'stop'
}) {
  return {
    id: 'response-regression',
    choices: [{
      finish_reason: finishReason,
      message: {
        role: 'assistant',
        content: text,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      }
    }],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      prompt_tokens_details: { cached_tokens: 2 }
    }
  };
}

function anthropicResponse({ text = null, tool = null, input = 7, output = 4 }) {
  const content = [];
  if (text !== null) content.push({ type: 'text', text });
  if (tool) content.push({
    type: 'tool_use',
    id: tool.id,
    name: tool.name,
    input: tool.input
  });
  return {
    id: 'msg_regression',
    stop_reason: tool ? 'tool_use' : 'end_turn',
    content,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 3
    }
  };
}

function queuedClient(responses, captures = []) {
  const queue = [...responses];
  const gateway = {
    async invoke(request) {
      captures.push(request);
      if (!queue.length) throw new Error('mock model response queue exhausted');
      const body = typeof queue[0] === 'function'
        ? queue.shift()(request)
        : queue.shift();
      return { status_code: 200, provider_request_id: 'provider-request-regression', body };
    }
  };
  return createProviderModelClient({ modelHttpGateway: gateway });
}

function actionRequest(text, key, preference = 'full', note = undefined) {
  const value = {
    schema: ACTION_REQUEST_SCHEMA,
    base_state_revision: 42,
    text,
    pre_resolution_visibility: 'sealed',
    narration_preference: preference,
    idempotency_key: key
  };
  if (note !== undefined) value.narration_note = note;
  return value;
}

const executionPlan = {
  narrative_mode: 'dual_pov',
  turn_payer_selection_hash: SHA('b'),
  pov_writer_selection_hashes: { A: SHA('c'), B: SHA('d') },
  writer_payer_by_audience: { A: 'A', B: 'B' },
  model_config_fingerprints: {
    shared_stage: SHA('e'),
    pov_writers: { A: SHA('f'), B: SHA('1') }
  }
};

function sealedActionTurn() {
  let turn = createActionTurn({
    room_id: 'room_agent_runtime',
    epoch_id: 'epoch_agent_runtime',
    turn_id: 'turn_agent_runtime',
    turn_no: 5,
    base_state_revision: 42,
    active_narrative_mode: 'dual_pov'
  });
  turn = lockActionSubmission(turn, {
    seat: 'A',
    request: actionRequest(
      '我绕到石门侧后结印封闭入口，不逐句复述这句话。',
      'idem-agent-A',
      'summarize_intent',
      '只概述结印，但要写明封闭结果。'
    ),
    submission_id: 'submission_A',
    received_at: '2026-08-22T01:00:00.000Z',
    server_secret: SERVER_SECRET,
    execution_plan: executionPlan
  }).turn;
  turn = lockActionSubmission(turn, {
    seat: 'B',
    request: actionRequest('我观察石门另一侧是否有暗道。', 'idem-agent-B'),
    submission_id: 'submission_B',
    received_at: '2026-08-22T01:00:01.000Z',
    server_secret: SERVER_SECRET
  }).turn;
  return turn;
}

function semanticEffect() {
  return {
    effect_id: 'effect_chakra_cost',
    depends_on_effect_ids: [],
    event_id: 'event_shared',
    target: { scope: 'actor', actor: 'A', entity_id: 'actor:A' },
    domain: 'attributes',
    kind: 'resource_delta',
    operation: 'consume',
    payload: { resource: 'chakra', amount: 12, unit: 'points' },
    provenance: 'rules_engine',
    visibility: 'server_only',
    evidence_event_ids: ['event_shared']
  };
}

function resolutionCandidate({ includeCost = true, injurySummary = false } = {}) {
  const effect = semanticEffect();
  return {
    schema: RESOLUTION_CANDIDATE_SCHEMA,
    conflicts: [{
      id: 'conflict_main',
      type: 'causal_conflict',
      submission_ids: ['submission_A', 'submission_B'],
      rule_basis: ['当前位置与权威忍术成本']
    }],
    outcomes: [{
      submission_id: 'submission_A',
      status: 'partial_success',
      reason: '入口被封闭并支付查克拉成本。',
      event_ids: ['event_shared', 'event_a_private']
    }, {
      submission_id: 'submission_B',
      status: 'success',
      reason: '找到了只有 B 注意到的暗道标记。',
      event_ids: ['event_shared', 'event_b_private']
    }],
    events: [{
      event_id: 'event_shared',
      summary: injurySummary
        ? 'A 封闭入口，B 被飞石割伤并流血。'
        : 'A 封闭入口并消耗十二点查克拉。',
      audiences: ['seat:A', 'seat:B'],
      world_public: false,
      effect_ids: includeCost ? [effect.effect_id] : []
    }, {
      event_id: 'event_a_private',
      summary: 'A 知道封印只能维持片刻。',
      audiences: ['seat:A'],
      world_public: false,
      effect_ids: []
    }, {
      event_id: 'event_b_private',
      summary: 'B 独自看懂了暗道标记。',
      audiences: ['seat:B'],
      world_public: false,
      effect_ids: []
    }],
    effects: includeCost ? [effect] : [],
    elapsed_time: '约十秒',
    stop_point: '石门已闭合，把下一项选择交还双方。'
  };
}

function canonicalTechniqueRefereeInput() {
  const state = structuredClone(createNewMultiplayerGenesisState());
  state.actors.A.skills.entries.push({
    skill_id: 'skill:shadow_clone',
    version: 1,
    display_name: '影分身之术',
    category: 'NINJUTSU',
    rank: 'B',
    mastery: 60,
    canonical_ref: 'JT-OTHER-0167'
  });
  return {
    schema: 'naruto.multiplayer-referee-input/v1',
    room_id: 'room_production_cost',
    epoch_id: 'epoch_production_cost',
    turn_id: 'turn_production_cost',
    turn_no: 1,
    base_state_revision: 0,
    rules_version: 'naruto.multiplayer-rules/v1',
    base_state: state,
    actions: [{
      seat: 'A',
      submission_id: 'submission_cost_A',
      text: '我施展影分身之术扰乱对方视线。'
    }, {
      seat: 'B',
      submission_id: 'submission_cost_B',
      text: '我保持警戒并观察周围。'
    }],
    input_hash: HMAC('8')
  };
}

function canonicalTechniqueCostEffect() {
  return {
    effect_id: 'effect_shadow_clone_cost',
    depends_on_effect_ids: [],
    event_id: 'event_shadow_clone',
    target: {
      scope: 'actor_resource',
      actor_id: 'actor:A',
      resource_id: 'chakra'
    },
    domain: 'actor_resource',
    kind: 'resource',
    operation: 'consume',
    payload: {
      expected_version: 0,
      next_version: 1,
      from: 50,
      to: 10,
      amount: 40,
      maximum: 50
    },
    provenance: 'rules_engine',
    visibility: 'server_only',
    evidence_event_ids: ['event_shadow_clone']
  };
}

function canonicalTechniqueResolutionCandidate({ includeCost = true } = {}) {
  const effect = canonicalTechniqueCostEffect();
  return {
    schema: RESOLUTION_CANDIDATE_SCHEMA,
    conflicts: [{
      id: 'conflict_shadow_clone',
      type: 'direct_opposition',
      submission_ids: ['submission_cost_A', 'submission_cost_B'],
      rule_basis: ['冻结角色技能与规范忍术费用']
    }],
    outcomes: [{
      submission_id: 'submission_cost_A',
      status: 'success',
      reason: 'A 成功施展了冻结技能表中的影分身之术。',
      event_ids: ['event_shadow_clone']
    }, {
      submission_id: 'submission_cost_B',
      status: 'partial_success',
      reason: 'B 保持警戒，但视线受到分身干扰。',
      event_ids: ['event_shadow_clone']
    }],
    events: [{
      event_id: 'event_shadow_clone',
      summary: 'A 施展影分身之术，分身成功扰乱 B 的视线。',
      audiences: ['seat:A', 'seat:B'],
      world_public: false,
      effect_ids: includeCost ? [effect.effect_id] : []
    }],
    effects: includeCost ? [effect] : [],
    elapsed_time: '约三秒',
    stop_point: '分身已经展开，把下一项选择交还双方。'
  };
}

function canonicalResolution() {
  const candidate = resolutionCandidate();
  const compiled = compileEffectDag(candidate.effects, {
    ruleSnapshot: { schema: 'rules/regression-v1' },
    resolveReducer() {
      return {
        required_reducer: 'apply_actor_resource_effect',
        reducer_version: 'attributes/v1'
      };
    }
  });
  return freezeCanonicalResolution(candidate, {
    turn_id: 'turn_agent_runtime',
    base_state_revision: 42,
    input_hash: HMAC('2'),
    submission_ids: ['submission_A', 'submission_B']
  }, compiled);
}

function claim(eventId, subjectId, predicate, value) {
  return { event_id: eventId, subject_id: subjectId, predicate, value };
}

function narrativeCandidate(audience, revision = 1) {
  const sharedText = revision === 1
    ? '甲只做了一个简短结印，石门便轰然闭合；气息的下沉说明这一举已支付代价。'
    : '甲概略完成结印，石门在沉响中闭合，施术的负担也已落实。';
  const shared = {
    segment_id: `segment_${audience.replace(':', '_')}_shared_${revision}`,
    event_refs: ['event_shared'],
    claims: [claim('event_shared', 'actor:A', 'entrance_sealed', true)],
    text: sharedText
  };
  if (audience === 'shared') return { segments: [shared], stop_point_ref: 'event_shared' };
  if (audience === 'seat:A') {
    return {
      segments: [shared, {
        segment_id: `segment_a_private_${revision}`,
        event_refs: ['event_a_private'],
        claims: [claim('event_a_private', 'actor:A', 'seal_duration_known', 'brief')],
        text: '只有甲能感到封印正快速衰减，下一步不能再犹豫。'
      }],
      stop_point_ref: 'event_a_private'
    };
  }
  return {
    segments: [shared, {
      segment_id: `segment_b_private_${revision}`,
      event_refs: ['event_b_private'],
      claims: [claim('event_b_private', 'actor:B', 'hidden_route_read', true)],
      text: '乙在石缝间辨认出一道只有自己看懂的暗道标记。'
    }],
    stop_point_ref: 'event_b_private'
  };
}

function approveCompleteness() {
  return {
    schema: RESOLUTION_COMPLETENESS_REVIEW_SCHEMA,
    status: 'APPROVED',
    findings: []
  };
}

function grounding(reviews) {
  return {
    schema: NARRATIVE_GROUNDING_CANDIDATE_SCHEMA,
    reviews
  };
}

function approvedReview(audience) {
  return { audience, status: 'APPROVED', findings: [] };
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
    accepted: [{ kind: 'effect', id: 'effect_chakra_cost' }],
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

await test('Referee prompt strips receipt order/time and narration metadata from authority input', () => {
  const turn = sealedActionTurn();
  const first = buildRefereeInput(turn, {
    base_state: { actors: { A: {}, B: {} } },
    rules_version: 'rules/regression-v1',
    server_secret: SERVER_SECRET
  });
  const swapped = structuredClone(turn);
  [swapped.actions.A.receipt_seq, swapped.actions.B.receipt_seq] = [
    swapped.actions.B.receipt_seq,
    swapped.actions.A.receipt_seq
  ];
  [swapped.actions.A.received_at, swapped.actions.B.received_at] = [
    swapped.actions.B.received_at,
    swapped.actions.A.received_at
  ];
  const second = buildRefereeInput(swapped, {
    base_state: { actors: { A: {}, B: {} } },
    rules_version: 'rules/regression-v1',
    server_secret: SERVER_SECRET
  });
  assert.deepEqual(first, second);
  const prompt = buildRefereePrompt({
    referee_input: first,
    evidence: {},
    transport_mode: 'json_protocol'
  });
  for (const forbidden of [
    'receipt_seq',
    'received_at',
    'narration_preference',
    'narration_note',
    'pre_resolution_visibility'
  ]) assert.equal(prompt.includes(forbidden), false, forbidden);
  assert.throws(
    () => buildRefereePrompt({
      referee_input: first,
      evidence: { billing: { payer_user_id: 'payer_user' } },
      transport_mode: 'json_protocol'
    }),
    error => error instanceof DomainError
      && error.code === 'REFEREE_RECEIPT_METADATA_FORBIDDEN'
  );
});

await test('opening prompts keep confirmed drafts trusted and expose no player actions', () => {
  const openingContext = {
    schema: 'naruto.multiplayer-opening-context/v1',
    shared_start_time: { year: 48, month: 3, day: 8, phase: 'DAWN' },
    openings: {
      A: {
        display_name: '日向凛',
        background: '仅可信开场背景 A',
        opening_hook: '在北门等待任务开始。'
      },
      B: {
        display_name: '奈良陆',
        background: '仅可信开场背景 B',
        opening_hook: '带着任务卷轴抵达南门。'
      }
    }
  };
  const prompt = buildRefereePrompt({
    referee_input: {
      schema: 'naruto.multiplayer-referee-input/v1',
      room_id: 'room_opening_prompt',
      epoch_id: 'epoch_opening_prompt',
      turn_id: 'turn_opening_prompt',
      turn_no: 1,
      base_state_revision: 0,
      rules_version: 'rules/regression-v1',
      base_state: { actors: { A: {}, B: {} } },
      input_hash: SHA('9'),
      turn_purpose: 'opening_scene',
      opening_context: openingContext,
      actions: [
        { seat: 'A', submission_id: 'opening_anchor_a', text: 'server anchor A' },
        { seat: 'B', submission_id: 'opening_anchor_b', text: 'server anchor B' }
      ]
    },
    evidence: {},
    transport_mode: 'json_protocol'
  });
  const payload = JSON.parse(prompt);
  assert.deepEqual(payload.untrusted_player_actions, []);
  assert.deepEqual(payload.trusted_opening_anchors, [
    { seat: 'A', submission_id: 'opening_anchor_a', trust: 'server_opening_anchor' },
    { seat: 'B', submission_id: 'opening_anchor_b', trust: 'server_opening_anchor' }
  ]);
  assert.deepEqual(payload.trusted_context.opening_context, openingContext);
  assert.equal(payload.trusted_context.turn_purpose, 'opening_scene');
  assert.equal('opening_context' in payload, false);
  assert.equal(JSON.stringify(payload.trusted_opening_anchors).includes('server anchor'), false);
  assert.equal((prompt.match(/仅可信开场背景/gu) ?? []).length, 2);
});

await test('strict JSON parser rejects fences, prose, concatenated objects and accepts only the whole object', () => {
  assert.deepEqual(parseStrictJsonObject('{"ok":true}'), { ok: true });
  for (const invalid of [
    '```json\n{"ok":true}\n```',
    '这是结果：{"ok":true}',
    '{"ok":true}\n已完成',
    '{"ok":true}{"again":true}',
    '{"ok":'
  ]) {
    assert.throws(
      () => parseStrictJsonObject(invalid),
      error => error instanceof DomainError && error.code === 'MODEL_PROTOCOL_VIOLATION'
    );
  }
});

await test('OpenAI/Anthropic normalization preserves native arguments, provider continuation roles and usage', () => {
  const rawArguments = '{"effect_ids":["effect_chakra_cost"],"memories":[{"bad":true}]}';
  const openAi = normalizeProviderResponse('openai_compatible', {
    provider_request_id: 'provider-openai',
    body: openAiResponse({
      toolCalls: [{
        id: 'call_bundle_1',
        type: 'function',
        function: { name: 'stage_turn_bundle', arguments: rawArguments }
      }],
      input: 13,
      output: 8
    })
  });
  assert.equal(openAi.tool_calls[0].raw_arguments, rawArguments);
  assert.deepEqual(
    [openAi.usage.requests, openAi.usage.input_tokens, openAi.usage.output_tokens],
    [1, 13, 8]
  );

  const anthropic = normalizeProviderResponse('anthropic', {
    body: anthropicResponse({
      tool: {
        id: 'toolu_bundle_1',
        name: 'stage_turn_bundle',
        input: { effect_ids: ['effect_chakra_cost'] }
      }
    })
  });
  assert.deepEqual(anthropic.tool_calls[0].raw_arguments, {
    effect_ids: ['effect_chakra_cost']
  });
  assert.equal(anthropic.usage.cache_creation_input_tokens, 3);

  let openAiSession = appendProviderUserMessage(
    createProviderSession('openai_compatible'),
    '{"stage":"continuity"}'
  );
  const request = buildProviderRequest({
    profile: profile('openai_compatible', 'continuation'),
    system_prompt: '系统规则',
    session: openAiSession,
    output: { mode: 'json_object' }
  });
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[1].role, 'user');
  assert.equal(request.response_format.type, 'json_object');
  assert.equal(request.max_tokens, 4_096);
  assert.equal(request.temperature, 0);

  const gpt5Request = buildProviderRequest({
    profile: { ...profile('openai_compatible', 'gpt5'), model: 'openai/gpt-5.2' },
    system_prompt: '系统规则',
    session: openAiSession,
    output: {
      mode: 'json_schema',
      name: 'fixed_response',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'integer' } }
      }
    },
    max_output_tokens: 512,
    temperature: 0.7
  });
  assert.equal(gpt5Request.max_completion_tokens, 512);
  assert.equal(Object.hasOwn(gpt5Request, 'max_tokens'), false);
  assert.equal(Object.hasOwn(gpt5Request, 'temperature'), false);
  assert.deepEqual(gpt5Request.response_format, { type: 'json_object' });

  const reasoningRelayRequest = buildProviderRequest({
    profile: { ...profile('openai_compatible', 'reasoner'), model: 'deepseek-reasoner' },
    system_prompt: '系统规则',
    session: openAiSession,
    max_output_tokens: 256,
    temperature: 1
  });
  assert.equal(reasoningRelayRequest.max_tokens, 256);
  assert.equal(Object.hasOwn(reasoningRelayRequest, 'temperature'), false);

  const nativeOpenAiRequest = buildProviderRequest({
    profile: profile('openai_compatible', 'native-request'),
    system_prompt: '系统规则',
    session: openAiSession,
    output: {
      mode: 'native_tools',
      tool_choice: 'required',
      allowed_tool_name: 'public_test_tool',
      response_name: 'unprobed_whole_response',
      response_schema: {
        type: 'object',
        properties: { value: { type: 'integer' } }
      },
      tools: [{
        name: 'public_test_tool',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'integer' } }
        }
      }]
    }
  });
  assert.equal(Object.hasOwn(nativeOpenAiRequest, 'parallel_tool_calls'), false);
  assert.equal(Object.hasOwn(nativeOpenAiRequest, 'response_format'), false);

  const anthropicSession = appendProviderUserMessage(
    createProviderSession('anthropic'),
    '{"stage":"writer"}'
  );
  const messages = providerContinuationMessages(anthropicSession, '系统规则');
  assert.deepEqual(messages[0], {
    role: 'user',
    content: [{ type: 'text', text: '{"stage":"writer"}' }]
  });
  const anthropicRequest = buildProviderRequest({
    profile: profile('anthropic', 'request'),
    system_prompt: '系统规则',
    session: anthropicSession,
    output: {
      mode: 'native_tools',
      tool_choice: 'required',
      allowed_tool_name: 'public_test_tool',
      tools: [{
        name: 'public_test_tool',
        description: '固定测试工具',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'integer' } }
        }
      }]
    }
  });
  assert.equal(anthropicRequest.system, '系统规则');
  assert.equal(anthropicRequest.max_tokens, 4_096);
  assert.equal(anthropicRequest.temperature, 0);
  assert.equal(Object.hasOwn(anthropicRequest, 'max_completion_tokens'), false);
  assert.equal(anthropicRequest.tools[0].name, 'public_test_tool');
  assert.equal(
    Object.prototype.hasOwnProperty.call(anthropicRequest.tools[0], 'strict'),
    false,
    'provider-side whole-bundle strict validation must not replace local item validation'
  );
  assert.deepEqual(anthropicRequest.tool_choice, {
    type: 'tool',
    name: 'public_test_tool',
    disable_parallel_tool_use: true
  });
});

await test('Resolution rule precheck and semantic reviewer route only to the same Referee before Writer', async () => {
  const turn = sealedActionTurn();
  const refereeInput = buildRefereeInput(turn, {
    base_state: { actors: { A: {}, B: {} } },
    rules_version: 'rules/regression-v1',
    server_secret: SERVER_SECRET
  });
  const refereeCaptures = [];
  const reviewerCaptures = [];
  const refereeClient = queuedClient([
    openAiResponse({ text: JSON.stringify(resolutionCandidate({ includeCost: false })) }),
    openAiResponse({ text: JSON.stringify(resolutionCandidate()) })
  ], refereeCaptures);
  const reviewerClient = queuedClient([
    openAiResponse({ text: JSON.stringify(approveCompleteness()) })
  ], reviewerCaptures);
  const result = await runResolutionAgentPipeline({
    referee_stage: {
      client: refereeClient,
      profile: profile('openai_compatible', 'referee'),
      owner_user_id: 'payer_user',
      transport_mode: 'json_protocol',
      execute_check: async () => {
        throw new Error('no check expected');
      }
    },
    completeness_reviewer_stage: {
      client: reviewerClient,
      profile: profile('openai_compatible', 'completeness'),
      owner_user_id: 'payer_user'
    },
    referee_input: refereeInput,
    mechanical_effect_requirements: [{
      requirement_id: 'requirement_known_chakra_cost',
      event_id: 'event_shared',
      rule_ref: 'technique:seal/cost-v1',
      effect_match: {
        domain: 'attributes',
        kind: 'resource_delta',
        operation: 'consume',
        target: semanticEffect().target,
        payload: semanticEffect().payload
      }
    }]
  });
  assert.equal(result.status, 'APPROVED');
  assert.deepEqual(result.calls, {
    referee: 1,
    resolution_repair: 1,
    resolution_completeness_reviewer: 1
  });
  assert.equal(reviewerCaptures.length, 1, 'rule failure must be repaired before semantic review');
  assert.equal(result.repair_history[0].retry_route, 'referee');
  assert.equal(refereeCaptures[1].body.messages.some(message => (
    message.role === 'user' && message.content.includes('REQUIRED_MECHANICAL_EFFECT')
  )), true, 'rule errors must return to the same provider session');
});

await test('Referee sees complete executable item contracts before generating or repairing effects', () => {
  const prompt = JSON.parse(buildRefereePrompt({
    referee_input: buildRefereeInput(sealedActionTurn(), {
      base_state: { actors: { A: {}, B: {} } }, rules_version: 'rules/regression-v1', server_secret: SERVER_SECRET
    }), transport_mode: 'json_protocol'
  }));
  const envelope = {effect_id:'effect_gain',depends_on_effect_ids:[],event_id:'event_handoff',domain:'item',kind:'actor_item',provenance:'referee',visibility:'server_only',evidence_event_ids:['event_handoff']};
  const cases = {
    upsert: {expected_version:null,next_version:1,display_name:'登记册副本',category:'KEY',quantity:1,canonical_ref:null,equipped_slot:null},
    consume: {expected_version:1,next_version:2,from_quantity:3,amount:1,to_quantity:2},
    equip: {expected_version:1,next_version:2,expected_slot:null,next_slot:'tool'},
    unequip: {expected_version:2,next_version:3,expected_slot:'tool',next_slot:null},
    remove: {expected_version:1,expected_quantity:1}
  };
  for (const [operation,payload] of Object.entries(cases)) {
    const contract = prompt.trusted_effect_operations.find(item=>item.domain==='item' && item.operation===operation)?.input_contract;
    assert.ok(contract, `missing ${operation} target/payload contract`);
    const validate = new Ajv2020({allErrors:true}).compile(contract);
    const input = {target:{scope:'actor_item',actor_id:'actor:A',item_id:'item:ledger'},payload};
    assert.equal(validate(input),true,JSON.stringify(validate.errors));
    assert.deepEqual(inspectDomainEffect({...envelope,operation,...input}).errors,[]);
    if (operation==='upsert') {
      const liveFailure = {target:{actor_id:'actor:A'},payload:{item_id:'item:ledger',display_name:'登记册副本',category:'DOCUMENT',quantity:1,canonical_ref:null,equipped_slot:null}};
      assert.equal(validate(liveFailure),false);
      assert.ok(validate.errors.length>=5,'all missing target/version fields and invalid category must be visible together');
      assert.deepEqual(inspectDomainEffect({...envelope,operation,...liveFailure}).errors[0].details.expected_input_contract,contract);
    }
  }
});

await test('unregistered model effects are repaired in the same Referee session before adoption', async () => {
  const invalid = resolutionCandidate();
  invalid.effects[0].domain = 'world_state';
  invalid.effects[0].kind = 'scene_placement';
  invalid.effects[0].operation = 'set_presence_context';
  const fixed = resolutionCandidate({ includeCost: false });
  const captures = [];
  const refereeClient = queuedClient([
    openAiResponse({ text: JSON.stringify(invalid) }),
    openAiResponse({ text: JSON.stringify(fixed) })
  ], captures);
  const reviewerCaptures = [];
  const result = await runResolutionAgentPipeline({
    referee_stage: {
      client: refereeClient, profile: profile('openai_compatible', 'effect-repair'),
      owner_user_id: 'payer_user', transport_mode: 'json_protocol',
      execute_check: async () => { throw new Error('no check expected'); }
    },
    completeness_reviewer_stage: {
      client: queuedClient([openAiResponse({ text: JSON.stringify(approveCompleteness()) })], reviewerCaptures),
      profile: profile('openai_compatible', 'effect-review'), owner_user_id: 'payer_user'
    },
    referee_input: buildRefereeInput(sealedActionTurn(), {
      base_state: { actors: { A: {}, B: {} } }, rules_version: 'rules/regression-v1', server_secret: SERVER_SECRET
    }),
    validate_resolution_candidate: candidate => candidate.effects.flatMap(effect => inspectDomainEffect(effect).errors)
  });
  assert.equal(result.status, 'APPROVED');
  assert.equal(result.calls.resolution_repair, 1);
  assert.equal(reviewerCaptures.length, 1);
  assert.deepEqual(result.resolution_candidate.effects, []);
  assert.ok(captures[1].body.messages.some(message => message.role === 'user'
    && message.content.includes('INVALID_EFFECT_CONTRACT') && message.content.includes('set_presence_context')));
});

await test('production canonical technique cost is derived per candidate and repaired before reviewer/Writer', async () => {
  const refereeInput = canonicalTechniqueRefereeInput();
  const direct = deriveProductionMechanicalEffectRequirements({
    referee_input: refereeInput,
    resolution_candidate: canonicalTechniqueResolutionCandidate({ includeCost: false })
  });
  assert.equal(direct.findings.length, 0);
  assert.deepEqual(direct.requirements[0].effect_match, {
    domain: 'actor_resource',
    kind: 'resource',
    operation: 'consume',
    target: {
      scope: 'actor_resource',
      actor_id: 'actor:A',
      resource_id: 'chakra'
    },
    payload: {
      expected_version: 0,
      next_version: 1,
      from: 50,
      to: 10,
      amount: 40,
      maximum: 50
    }
  });

  const refereeCaptures = [];
  const reviewerCaptures = [];
  const refereeClient = queuedClient([
    openAiResponse({
      text: JSON.stringify(canonicalTechniqueResolutionCandidate({ includeCost: false }))
    }),
    openAiResponse({ text: JSON.stringify(canonicalTechniqueResolutionCandidate()) })
  ], refereeCaptures);
  const reviewerClient = queuedClient([
    openAiResponse({ text: JSON.stringify(approveCompleteness()) })
  ], reviewerCaptures);
  const result = await runResolutionAgentPipeline({
    referee_stage: {
      client: refereeClient,
      profile: profile('openai_compatible', 'production-cost-referee'),
      owner_user_id: 'payer_user',
      transport_mode: 'json_protocol',
      execute_check: async () => { throw new Error('no check expected'); }
    },
    completeness_reviewer_stage: {
      client: reviewerClient,
      profile: profile('openai_compatible', 'production-cost-reviewer'),
      owner_user_id: 'payer_user'
    },
    referee_input: refereeInput,
    derive_mechanical_effect_requirements:
      deriveProductionMechanicalEffectRequirements
  });
  assert.equal(result.status, 'APPROVED');
  assert.deepEqual(result.calls, {
    referee: 1,
    resolution_repair: 1,
    resolution_completeness_reviewer: 1
  });
  assert.equal(
    reviewerCaptures.length,
    1,
    'semantic reviewer—and therefore every later Writer—must wait for the rule repair'
  );
  assert.equal(result.repair_history[0].source, 'resolution_rule_precheck');
  assert.equal(refereeCaptures[1].body.messages.some(message => (
    message.role === 'user'
      && message.content.includes('REQUIRED_MECHANICAL_EFFECT_MISSING_OR_MISMATCHED')
      && message.content.includes('JT-OTHER-0167')
  )), true, 'the exact production cost error must continue the same Referee session');
});

await test('semantic missing-effect review reruns Referee/reviewer but never enters Writer', async () => {
  const turn = sealedActionTurn();
  const refereeInput = buildRefereeInput(turn, {
    base_state: { actors: { A: {}, B: {} } },
    rules_version: 'rules/regression-v1',
    server_secret: SERVER_SECRET
  });
  const refereeClient = queuedClient([
    openAiResponse({ text: JSON.stringify(resolutionCandidate({ injurySummary: true })) }),
    openAiResponse({ text: JSON.stringify(resolutionCandidate()) })
  ]);
  const reviewerClient = queuedClient([
    openAiResponse({ text: JSON.stringify({
      schema: RESOLUTION_COMPLETENESS_REVIEW_SCHEMA,
      status: 'REJECTED',
      findings: [{
        event_id: 'event_shared',
        code: 'MISSING_DAMAGE_EFFECT',
        reason: '事件声明 B 流血，但没有伤害或伤势 effect。'
      }]
    }) }),
    openAiResponse({ text: JSON.stringify(approveCompleteness()) })
  ]);
  const result = await runResolutionAgentPipeline({
    referee_stage: {
      client: refereeClient,
      profile: profile('openai_compatible', 'semantic-referee'),
      owner_user_id: 'payer_user',
      transport_mode: 'json_protocol',
      execute_check: async () => { throw new Error('no check expected'); }
    },
    completeness_reviewer_stage: {
      client: reviewerClient,
      profile: profile('openai_compatible', 'semantic-reviewer'),
      owner_user_id: 'payer_user'
    },
    referee_input: refereeInput,
    mechanical_effect_requirements: []
  });
  assert.equal(result.status, 'APPROVED');
  assert.deepEqual(result.calls, {
    referee: 1,
    resolution_repair: 1,
    resolution_completeness_reviewer: 2
  });
  assert.equal(result.repair_history[0].source, 'resolution_completeness_reviewer');
});

await test('Referee repairs unreachable events in the same session before any adoption and stops at its retry limit', async () => {
  const invalid = resolutionCandidate();
  invalid.events.push({ event_id: 'event_npc', summary: '信使催促众人说明来意。', audiences: ['seat:A', 'seat:B'], world_public: true, effect_ids: [] });
  const corrected = structuredClone(invalid);
  corrected.outcomes[0].event_ids.push('event_npc');
  const captures = [];
  const request = {
    profile: profile(), owner_user_id: 'payer_user', transport_mode: 'json_protocol', system_prompt: 'Referee', prompt: '{"stage":"referee"}',
    execute_check: async () => { throw new Error('Malformed output must not execute checks'); }
  };
  const result = await invokeRefereeModel({ ...request, client: queuedClient([
    openAiResponse({ text: JSON.stringify(invalid) }), openAiResponse({ text: JSON.stringify(corrected) })
  ], captures) });
  assert.equal(result.calls, 2);
  assert.equal(result.usage.requests, 2);
  assert.ok(result.candidate.outcomes[0].event_ids.includes('event_npc'));
  assert.match(captures[1].body.messages.at(-1).content, /canonical event is not reachable/u);
  assert.match(captures[1].body.messages.at(-1).content, /event_npc/u);
  const limited = [];
  await assert.rejects(() => invokeRefereeModel({ ...request, max_protocol_repairs: 1,
    client: queuedClient([openAiResponse({ text: JSON.stringify(invalid) }), openAiResponse({ text: JSON.stringify(invalid) })], limited)
  }), error => error.code === 'SCHEMA_VIOLATION');
  assert.equal(limited.length, 2, 'protocol repair must be bounded');
});

await test('native Referee check continues with an authoritative tool_result and no client dice', async () => {
  const turn = sealedActionTurn();
  const refereeInput = buildRefereeInput(turn, {
    base_state: { actors: { A: {}, B: {} } },
    rules_version: 'rules/regression-v1',
    server_secret: SERVER_SECRET
  });
  const captures = [];
  const checkRequest = {
    check_id: 'check_stone_gate',
    participant_refs: ['actor:A', 'actor:B'],
    conflict_type: 'opposed_sealing_detection',
    attribute_rule_refs: ['actor:A/sealing', 'actor:B/perception'],
    rule_ref: 'rule:opposed-check/v1',
    reason: 'A 试图在 B 观察石门时完成封印。'
  };
  const refereeClient = queuedClient([
    openAiResponse({
      toolCalls: [{
        id: 'call_resolution_check',
        type: 'function',
        function: {
          name: 'request_resolution_check',
          arguments: JSON.stringify(checkRequest)
        }
      }]
    }),
    openAiResponse({ text: JSON.stringify(resolutionCandidate()) })
  ], captures);
  const reviewerClient = queuedClient([
    openAiResponse({ text: JSON.stringify(approveCompleteness()) })
  ]);
  const resultWithoutHash = {
    schema: RESOLUTION_CHECK_RESULT_SCHEMA,
    status: 'RESOLVED',
    check_id: checkRequest.check_id,
    rule_ref: checkRequest.rule_ref,
    rolls: [{ participant_ref: 'actor:A', raw: 12, modifier: 4, total: 16 }, {
      participant_ref: 'actor:B', raw: 9, modifier: 3, total: 12
    }],
    outcome: 'ACTOR_A_SUCCESS'
  };
  const checkResult = {
    ...resultWithoutHash,
    result_hash: computeResolutionCheckResultHash(resultWithoutHash)
  };
  let checks = 0;
  const result = await runResolutionAgentPipeline({
    referee_stage: {
      client: refereeClient,
      profile: profile('openai_compatible', 'native-referee'),
      owner_user_id: 'payer_user',
      transport_mode: 'native_tools',
      execute_check: async request => {
        checks += 1;
        assert.deepEqual(request, checkRequest);
        return checkResult;
      }
    },
    completeness_reviewer_stage: {
      client: reviewerClient,
      profile: profile('openai_compatible', 'native-check-reviewer'),
      owner_user_id: 'payer_user'
    },
    referee_input: refereeInput
  });
  assert.equal(result.status, 'APPROVED');
  assert.equal(checks, 1);
  assert.equal(result.calls.referee, 2);
  assert.equal(captures[1].body.messages.some(message => (
    message.role === 'tool'
      && message.tool_call_id === 'call_resolution_check'
      && message.content.includes('ACTOR_A_SUCCESS')
  )), true);
});

await test('Referee dynamic-check limit spans semantic repair continuations', async () => {
  const turn = sealedActionTurn();
  const refereeInput = buildRefereeInput(turn, {
    base_state: { actors: { A: {}, B: {} } },
    rules_version: 'rules/regression-v1',
    server_secret: SERVER_SECRET
  });
  const firstCheck = {
    check_id: 'check_first_limit',
    participant_refs: ['actor:A'],
    conflict_type: 'sealing_control',
    attribute_rule_refs: ['actor:A/sealing'],
    rule_ref: 'rule:single-check/v1',
    reason: '先执行一次权威检定。'
  };
  const secondCheck = { ...firstCheck, check_id: 'check_second_limit' };
  const refereeClient = queuedClient([
    openAiResponse({ text: JSON.stringify({
      protocol: 'naruto.referee-check-json/v1',
      operation: 'request_resolution_check',
      request: firstCheck
    }) }),
    openAiResponse({ text: JSON.stringify(resolutionCandidate({ includeCost: false })) }),
    openAiResponse({ text: JSON.stringify({
      protocol: 'naruto.referee-check-json/v1',
      operation: 'request_resolution_check',
      request: secondCheck
    }) })
  ]);
  let checkExecutions = 0;
  const resolved = request => {
    const withoutHash = {
      schema: RESOLUTION_CHECK_RESULT_SCHEMA,
      status: 'RESOLVED',
      check_id: request.check_id,
      rule_ref: request.rule_ref,
      rolls: [{ participant_ref: 'actor:A', raw: 10, modifier: 2, total: 12 }],
      outcome: 'SUCCESS'
    };
    return { ...withoutHash, result_hash: computeResolutionCheckResultHash(withoutHash) };
  };
  await assert.rejects(
    () => runResolutionAgentPipeline({
      referee_stage: {
        client: refereeClient,
        profile: profile('openai_compatible', 'check-limit'),
        owner_user_id: 'payer_user',
        transport_mode: 'json_protocol',
        max_check_requests: 1,
        execute_check: async request => {
          checkExecutions += 1;
          return resolved(request);
        }
      },
      completeness_reviewer_stage: {
        client: queuedClient([]),
        profile: profile('openai_compatible', 'unused-limit-reviewer'),
        owner_user_id: 'payer_user'
      },
      referee_input: refereeInput,
      mechanical_effect_requirements: [{
        requirement_id: 'requirement_limit_cost',
        event_id: 'event_shared',
        rule_ref: 'technique:seal/cost-v1',
        effect_match: {
          domain: 'attributes',
          kind: 'resource_delta',
          operation: 'consume',
          target: semanticEffect().target,
          payload: semanticEffect().payload
        }
      }]
    }),
    error => error instanceof DomainError && error.code === 'REFEREE_CHECK_LIMIT_EXCEEDED'
  );
  assert.equal(checkExecutions, 1, 'semantic repair must not reset the check budget');
});

await test('shared Writer produces exactly one delivery shared by both members', async () => {
  const resolution = canonicalResolution();
  const projections = projectAudienceViews({
    turn_id: resolution.turn_id,
    events: resolution.events,
    facts: []
  });
  const writerClient = queuedClient([
    openAiResponse({ text: JSON.stringify(narrativeCandidate('shared')) })
  ]);
  const reviewerClient = queuedClient([
    openAiResponse({ text: JSON.stringify(grounding([approvedReview('shared')])) })
  ]);
  const result = await runNarrativeAgentPipeline({
    narrative_mode: 'shared',
    canonical_resolution: resolution,
    resolution_commitment: HMAC('3'),
    audience_projections: projections,
    writer_action_projections: {
      shared: { presentation_requests: [] }
    },
    writer_stages: {
      shared: {
        client: writerClient,
        profile: profile('openai_compatible', 'shared-writer'),
        owner_user_id: 'payer_user'
      }
    },
    grounding_reviewer_stage: {
      client: reviewerClient,
      profile: profile('openai_compatible', 'shared-grounding'),
      owner_user_id: 'payer_user'
    }
  });
  assert.equal(result.status, 'APPROVED');
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].audience, 'shared');
  assert.deepEqual(result.calls.writer, { shared: 1 });
});

await test('short defensive narration is repaired before review and publication', async () => {
  const resolution = canonicalResolution();
  const projections = projectAudienceViews({ turn_id: resolution.turn_id, events: resolution.events, facts: [] });
  const bad = narrativeCandidate('shared');
  bad.segments[0].text = '镜头没有确认任何人的具体行踪，也没有替任何人开口、行动或决定。两人可以提交第一次行动声明。';
  const good = narrativeCandidate('shared');
  good.segments[0].text = '晨光穿过林间，落在湿润的泥土上。树叶间残留的夜露滴进积水，泛起细小的涟漪；远处的风穿过林梢，把最后一缕薄雾吹散。安静的空气中，衣料摩擦的声音近得清晰可闻。' + good.segments[0].text;
  const writer = queuedClient([openAiResponse({ text: JSON.stringify(bad) }), openAiResponse({ text: JSON.stringify(good) })]);
  const result = await runNarrativeAgentPipeline({
    narrative_mode: 'shared', canonical_resolution: resolution, resolution_commitment: HMAC('3'),
    audience_projections: projections, style_requirements: { minimum_characters: 70 },
    writer_stages: { shared: { client: writer, profile: profile(), owner_user_id: 'payer_user' } },
    grounding_reviewer_stage: { client: queuedClient([openAiResponse({ text: JSON.stringify(grounding([approvedReview('shared')])) })]), profile: profile(), owner_user_id: 'payer_user' }
  });
  assert.equal(result.status, 'APPROVED');
  assert.equal(result.calls.writer.shared, 2);
  assert.equal(result.calls.narrative_grounding_reviewer, 1);
  assert.ok(!JSON.stringify(result.deliveries).includes('镜头没有确认'));
});

await test('unreasonable success is rewritten into an in-world outcome and continues without a refusal', async () => {
  const candidate = {
    schema: RESOLUTION_CANDIDATE_SCHEMA, conflicts: resolutionCandidate().conflicts, effects: [],
    outcomes: ['submission_A', 'submission_B'].map(submission_id => ({
      submission_id, status: 'transformed', reason: '索酬成为尚待商议的请求，没有获得款项。', event_ids: ['event_terms']
    })),
    events: [{ event_id: 'event_terms', summary: '甲索要百万两，信使表示自己无法支付；门岗提议先说明信件的来历。乙在一旁等候。', audiences: ['seat:A', 'seat:B'], world_public: true, effect_ids: [] }],
    elapsed_time: '短暂交谈', stop_point: '门岗等候甲决定是否继续询问信使。'
  };
  const resolution = freezeCanonicalResolution(candidate, {
    turn_id: 'turn_soft_action', base_state_revision: 42, input_hash: HMAC('2'), submission_ids: ['submission_A', 'submission_B']
  }, compileEffectDag([], { ruleSnapshot: { schema: 'rules/regression-v1' }, resolveReducer() { throw new Error('No effects expected'); } }));
  const delivery = text => ({ segments: [{ segment_id: 'segment_terms', event_refs: ['event_terms'], claims: [claim('event_terms', 'actor:A', 'requested_payment', true)], text }], stop_point_ref: 'event_terms' });
  const captures = [];
  const writer = queuedClient([
    openAiResponse({ text: JSON.stringify(delivery('你的输入不合理，请重新输入行动。')) }),
    openAiResponse({ text: JSON.stringify(delivery('信使把百万两放进甲的钱袋。')) }),
    openAiResponse({ text: JSON.stringify(delivery('“百万两？”信使抹去额角的雨水，声音发涩，“我付不起。”门岗把登记簿挪近灯下：“先说说信件怎么丢的。”乙依旧立在屋檐下，水滴沿着瓦片的缺口落下。')) })
  ], captures);
  const result = await runNarrativeAgentPipeline({
    narrative_mode: 'shared', canonical_resolution: resolution, resolution_commitment: HMAC('3'),
    audience_projections: projectAudienceViews({ turn_id: resolution.turn_id, events: resolution.events, facts: [] }),
    writer_stages: { shared: { client: writer, profile: profile(), owner_user_id: 'payer_user' } },
    grounding_reviewer_stage: { client: queuedClient([
      openAiResponse({ text: JSON.stringify(grounding([{ audience: 'shared', status: 'REJECTED', findings: ['event_terms 只成立索酬和信使无力支付；将支付百万两改为信使对报酬的回应。'] }])) }),
      openAiResponse({ text: JSON.stringify(grounding([approvedReview('shared')])) })
    ]), profile: profile(), owner_user_id: 'payer_user' }
  });
  assert.equal(result.status, 'APPROVED', JSON.stringify(result));
  assert.equal(result.calls.writer.shared, 3, JSON.stringify(result));
  assert.equal(result.calls.narrative_grounding_reviewer, 2);
  assert.deepEqual(resolution.effects, [], 'repair cannot create a fictional reward');
  assert.match(result.deliveries[0].segments[0].text, /我付不起/u);
  assert.doesNotMatch(result.deliveries[0].segments[0].text, /输入不合理|重新输入|审核/u);
  assert.match(captures[2].body.messages.at(-1).content, /这是内部改稿意见，继续完成本回合/u);
});

await test('dual POV grounding rejection reruns only affected Writer plus reviewer and preserves summarize_intent', async () => {
  const resolution = canonicalResolution();
  const projections = projectAudienceViews({
    turn_id: resolution.turn_id,
    events: resolution.events,
    facts: []
  });
  const turn = sealedActionTurn();
  const writerProjectionA = buildWriterActionProjection(turn, {
    audience_seat: 'A',
    visible_submission_ids: ['submission_A', 'submission_B']
  });
  const writerProjectionB = buildWriterActionProjection(turn, {
    audience_seat: 'B',
    visible_submission_ids: ['submission_A', 'submission_B']
  });
  const capturesA = [];
  const capturesB = [];
  const writerA = queuedClient([
    openAiResponse({ text: JSON.stringify(narrativeCandidate('seat:A', 1)) }),
    openAiResponse({ text: JSON.stringify(narrativeCandidate('seat:A', 2)) })
  ], capturesA);
  const writerB = queuedClient([
    openAiResponse({ text: JSON.stringify(narrativeCandidate('seat:B', 1)) })
  ], capturesB);
  const groundingClient = queuedClient([
    openAiResponse({ text: JSON.stringify(grounding([{
      audience: 'seat:A',
      status: 'REJECTED',
      findings: ['A 视角的代价描写需要更紧贴裁决。']
    }, approvedReview('seat:B')])) }),
    openAiResponse({ text: JSON.stringify(grounding([
      approvedReview('seat:A'),
      approvedReview('seat:B')
    ])) })
  ]);
  const result = await runNarrativeAgentPipeline({
    narrative_mode: 'dual_pov',
    canonical_resolution: resolution,
    resolution_commitment: HMAC('4'),
    audience_projections: projections,
    writer_action_projections: {
      'seat:A': writerProjectionA,
      'seat:B': writerProjectionB
    },
    writer_stages: {
      'seat:A': {
        client: writerA,
        profile: profile('openai_compatible', 'writer-A'),
        owner_user_id: 'payer_user'
      },
      'seat:B': {
        client: writerB,
        profile: profile('openai_compatible', 'writer-B'),
        owner_user_id: 'payer_user'
      }
    },
    grounding_reviewer_stage: {
      client: groundingClient,
      profile: profile('openai_compatible', 'dual-grounding'),
      owner_user_id: 'payer_user'
    }
  });
  assert.equal(result.status, 'APPROVED');
  assert.deepEqual(result.calls.writer, { 'seat:A': 2, 'seat:B': 1 });
  assert.equal(result.calls.narrative_grounding_reviewer, 2);
  assert.equal(capturesB.length, 1, 'unaffected B Writer must stay cached');
  assert.equal(capturesA[0].body.messages[1].content.includes('summarize_intent'), true);
  assert.equal(
    capturesA[0].body.messages[1].content.includes(resolution.stop_point),
    true,
    'Writer must receive the canonical stop point explicitly'
  );
  assert.equal(
    capturesA[0].body.messages[1].content.includes(turn.actions.A.text),
    false,
    'Writer presentation sidecar must not receive raw action text'
  );
  assert.equal(
    result.deliveries[0].segments.some(segment => segment.text.includes(turn.actions.A.text)),
    false,
    'summarize_intent must not reproduce the full action verbatim'
  );
  assert.deepEqual(
    result.deliveries.map(delivery => delivery.audience),
    ['seat:A', 'seat:B']
  );
});

await test('official Flash stages reserve output for JSON without changing other providers', async () => {
  const flash = { ...profile(), model: 'deepseek-flash', endpoint: {
    normalized_origin: 'https://api.deepseek.com', normalized_base_url: 'https://api.deepseek.com/v1'
  } };
  for (const [selected, expected] of [
    [flash, { type: 'disabled' }],
    [{ ...flash, endpoint: profile().endpoint }, undefined],
    [{ ...flash, model: 'deepseek-chat' }, undefined],
    [profile('anthropic'), undefined]
  ]) {
    const captures = [];
    const rawText = JSON.stringify({ protocol: 'naruto.continuity-json/v1', operation: 'stage_turn_bundle', bundle: {} });
    const response = selected.adapter === 'anthropic'
      ? anthropicResponse({ text: rawText })
      : openAiResponse({ text: rawText });
    await invokeContinuityModel({
      client: queuedClient([response], captures), profile: selected, owner_user_id: 'payer_user',
      system_prompt: 'Continuity JSON', prompt: '{"stage":"continuity"}',
      operation: 'stage_turn_bundle', transport_mode: 'json_protocol'
    });
    assert.deepEqual(captures[0].body.thinking, expected);
  }
  const defaultStage = buildProviderRequest({ profile: flash, system_prompt: 'JSON',
    session: appendProviderUserMessage(createProviderSession('openai_compatible'), 'JSON') });
  assert.equal(defaultStage.reasoning_effort, undefined, 'stages without an explicit effort retain provider defaults');
  assert.equal(defaultStage.thinking, undefined);
  const writerCaptures = [];
  await invokeWriterModel({ client: queuedClient([openAiResponse({ text: JSON.stringify(narrativeCandidate('shared')) })], writerCaptures),
    profile: flash, owner_user_id: 'payer_user', system_prompt: 'Write prose as JSON', prompt: '{"stage":"writer"}' });
  assert.deepEqual(writerCaptures[0].body.thinking, { type: 'disabled' }, 'Flash Writer reserves the response budget for prose');
  const reviewCaptures = [];
  await invokeNarrativeGroundingReviewer({ client: queuedClient([openAiResponse({ text: JSON.stringify(grounding([approvedReview('shared')])) })], reviewCaptures),
    profile: flash, owner_user_id: 'payer_user', system_prompt: 'Review as JSON', prompt: '{"stage":"narrative_grounding_reviewer"}', expected_audiences: ['shared'] });
  assert.deepEqual(reviewCaptures[0].body.thinking, { type: 'disabled' });
  const refereeCaptures = [];
  await invokeRefereeModel({ client: queuedClient([openAiResponse({ text: JSON.stringify(resolutionCandidate()) })], refereeCaptures),
    profile: flash, owner_user_id: 'payer_user', system_prompt: 'Adjudicate as JSON', prompt: '{"stage":"referee"}',
    transport_mode: 'json_protocol', execute_check: async () => { throw new Error('No check expected'); } });
  assert.deepEqual(refereeCaptures[0].body.thinking, { type: 'disabled' });
  const completenessCaptures = [];
  await invokeResolutionCompletenessReviewer({ client: queuedClient([openAiResponse({ text: JSON.stringify(approveCompleteness()) })], completenessCaptures),
    profile: flash, owner_user_id: 'payer_user', system_prompt: 'Review as JSON', prompt: '{"stage":"resolution_completeness_reviewer"}' });
  assert.deepEqual(completenessCaptures[0].body.thinking, { type: 'disabled' });
});

await test('provider daily schema agrees with delivery validation on marks, ranks and exact fields', () => {
  const schema = normalizeProviderJsonSchema({ $ref: 'naruto.shinobi-daily/v1' });
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(SHINOBI_DAILY_EXAMPLE), true, JSON.stringify(validate.errors));
  for (const mark of ['◇', '1', 'A', '食', '𠀀']) {
    const daily = structuredClone(SHINOBI_DAILY_EXAMPLE);
    daily.flavor[0].mark = mark;
    assert.equal(validate(daily), validateShinobiDaily(daily).valid,
      `provider must disclose the same mark rule for ${mark}`);
  }
  for (const mutate of [
    daily => { daily.missions[0].rank = 'A'; },
    daily => { daily.world[0].source_refs = []; },
    daily => { daily.flavor.pop(); },
    daily => { daily.headline.title = '木叶晨报'; }
  ]) {
    const daily = structuredClone(SHINOBI_DAILY_EXAMPLE);
    mutate(daily);
    assert.equal(validateShinobiDaily(daily).valid, false);
    assert.equal(validate(daily), false, 'provider contract must reject invalid delivery shapes');
  }
});

await test('native Continuity keeps raw arguments and malformed items visible to item validators', async () => {
  const rawArguments = JSON.stringify({
    effect_ids: ['effect_chakra_cost'],
    memories: [{ obligation_id: 'obligation_memory_actor_A', bad_field: true }]
  });
  const captures = [];
  const client = queuedClient([openAiResponse({
    toolCalls: [{
      id: 'call_native_bundle',
      type: 'function',
      function: { name: 'stage_turn_bundle', arguments: rawArguments }
    }]
  })], captures);
  const result = await invokeContinuityModel({
    client,
    profile: profile('openai_compatible', 'native-continuity'),
    owner_user_id: 'payer_user',
    system_prompt: '连续性系统提示',
    prompt: '{"stage":"continuity"}',
    operation: 'stage_turn_bundle',
    transport_mode: 'native_tools'
  });
  assert.equal(result.transport_input.raw_arguments, rawArguments);
  assert.deepEqual(result.command.bundle.effect_ids, ['effect_chakra_cost']);
  assert.deepEqual(result.command.bundle.memories, [{
    obligation_id: 'obligation_memory_actor_A',
    bad_field: true
  }]);
  assert.equal(result.calls, 1);
  assert.equal(captures[0].body.tools.length, 1);
  assert.equal(captures[0].body.tool_choice.function.name, 'stage_turn_bundle');
  assert.equal(
    Object.prototype.hasOwnProperty.call(captures[0].body.tools[0].function, 'strict'),
    false,
    'OpenAI-compatible native tools must leave partial item validation to the server'
  );
  assert.equal(
    JSON.stringify(captures[0].body.tools[0].function.parameters).includes('$ref'),
    false,
    'provider tool schema must not contain unresolved contract references'
  );
});

await test('strict JSON Continuity fence error returns to same session; one Bundle still costs one request', async () => {
  const captures = [];
  const client = queuedClient([
    openAiResponse({
      text: '```json\n{"protocol":"naruto.continuity-json/v1","operation":"stage_turn_bundle","bundle":{}}\n```',
      input: 4,
      output: 3
    }),
    openAiResponse({
      text: JSON.stringify({
        protocol: 'naruto.continuity-json/v1',
        operation: 'stage_turn_bundle',
        bundle: { effect_ids: ['effect_chakra_cost'] }
      }),
      input: 6,
      output: 5
    })
  ], captures);
  let executions = 0;
  const result = await runContinuityAgentLoop({
    continuity_stage: {
      client,
      profile: profile('openai_compatible', 'json-continuity'),
      owner_user_id: 'payer_user',
      transport_mode: 'json_protocol'
    },
    initial_prompt: '{"stage":"continuity","operation":"stage_turn_bundle"}',
    execute_bundle: async ({ command }) => {
      executions += 1;
      assert.deepEqual(command.bundle.effect_ids, ['effect_chakra_cost']);
      return readyBundleResult();
    }
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.calls, 2, 'one format continuation is one additional request');
  assert.equal(executions, 1, 'invalid fenced response performs zero Bundle writes');
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 8);
  assert.equal(captures.length, 2);
  assert.equal(captures[1].body.messages.some(message => (
    message.role === 'assistant' && message.content.startsWith('```json')
  )), true);
  assert.equal(captures[1].body.messages.some(message => (
    message.role === 'user' && message.content.includes('PROTOCOL_VIOLATION')
  )), true, 'machine protocol error must be continued in the same provider session');
  assert.equal(
    captures[0].body.messages[0].content.includes('$ref'),
    false,
    'JSON protocol system contract must inline every Bundle item schema'
  );
  assert.equal(
    captures[0].body.messages[0].content.includes('supersede_entry_ids'),
    true,
    'JSON protocol system contract must include the complete memory item schema'
  );
  for (const capture of captures) {
    assert.match(capture.body.messages[0].content, /flavor\[\]\.mark[^\n]*只能是一个汉字/,
      'first and repaired requests must disclose the exact daily mark rule');
  }
});

await test('paused Continuity resumes with a fresh bounded request window and monotonic numbering', async () => {
  const captures = [];
  const client = queuedClient([
    openAiResponse({
      text: 'not a strict JSON command',
      input: 4,
      output: 2
    }),
    openAiResponse({
      text: JSON.stringify({
        protocol: 'naruto.continuity-json/v1',
        operation: 'stage_turn_bundle',
        bundle: { effect_ids: ['effect_chakra_cost'] }
      }),
      input: 5,
      output: 3
    })
  ], captures);
  const stage = {
    client,
    profile: profile('openai_compatible', 'json-continuity-resume'),
    owner_user_id: 'payer_user',
    transport_mode: 'json_protocol'
  };
  const paused = await runContinuityAgentLoop({
    continuity_stage: stage,
    initial_prompt: '{"stage":"continuity","operation":"stage_turn_bundle"}',
    max_model_requests: 1,
    execute_bundle: async () => {
      throw new Error('malformed response must perform zero Bundle writes');
    }
  });
  assert.equal(paused.status, 'REPAIR_PAUSED');
  assert.equal(paused.continuation_state.next_request_no, 2);

  let executions = 0;
  const resumed = await runContinuityAgentLoop({
    continuity_stage: stage,
    initial_prompt: null,
    resume_state: paused.continuation_state,
    reference_bindings: { obligation_memory_shared: { stableSubjectIds: ['actor:resume_example'] } },
    max_model_requests: 1,
    execute_bundle: async ({ request_no }) => {
      executions += 1;
      assert.equal(request_no, 2);
      return readyBundleResult();
    }
  });
  assert.equal(resumed.status, 'READY');
  assert.equal(resumed.calls, 1);
  assert.equal(resumed.history[0].request_no, 2);
  assert.equal(executions, 1);
  assert.equal(captures.length, 2);
  assert.match(JSON.stringify(captures[1]), /actor:resume_example/);
});

await test('native protocol correction answers every unresolved OpenAI tool call', async () => {
  const captures = [];
  const client = queuedClient([
    openAiResponse({
      toolCalls: ['one', 'two'].map(id => ({
        id: `call_${id}`,
        type: 'function',
        function: {
          name: 'stage_turn_bundle',
          arguments: JSON.stringify({ effect_ids: ['effect_chakra_cost'] })
        }
      }))
    }),
    openAiResponse({
      toolCalls: [{
        id: 'call_corrected',
        type: 'function',
        function: {
          name: 'stage_turn_bundle',
          arguments: JSON.stringify({ effect_ids: ['effect_chakra_cost'] })
        }
      }]
    })
  ], captures);
  const result = await runContinuityAgentLoop({
    continuity_stage: {
      client,
      profile: profile('openai_compatible', 'multi-tool-correction'),
      owner_user_id: 'payer_user',
      transport_mode: 'native_tools'
    },
    initial_prompt: '{"stage":"continuity"}',
    execute_bundle: async () => readyBundleResult()
  });
  assert.equal(result.status, 'READY');
  const toolResults = captures[1].body.messages.filter(message => message.role === 'tool');
  assert.deepEqual(toolResults.map(message => message.tool_call_id), ['call_one', 'call_two']);
  assert.equal(toolResults.every(message => message.content.includes('NATIVE_TOOL_COUNT_INVALID')), true);
});

await test('native protocol correction groups every Anthropic tool_result in one user turn', async () => {
  const captures = [];
  const first = anthropicResponse({});
  first.stop_reason = 'tool_use';
  first.content = ['one', 'two'].map(id => ({
    type: 'tool_use',
    id: `toolu_${id}`,
    name: 'stage_turn_bundle',
    input: { effect_ids: ['effect_chakra_cost'] }
  }));
  const client = queuedClient([
    first,
    anthropicResponse({
      tool: {
        id: 'toolu_corrected',
        name: 'stage_turn_bundle',
        input: { effect_ids: ['effect_chakra_cost'] }
      }
    })
  ], captures);
  const result = await runContinuityAgentLoop({
    continuity_stage: {
      client,
      profile: profile('anthropic', 'multi-tool-correction'),
      owner_user_id: 'payer_user',
      transport_mode: 'native_tools'
    },
    initial_prompt: '{"stage":"continuity"}',
    execute_bundle: async () => readyBundleResult()
  });
  assert.equal(result.status, 'READY');
  const resultMessage = captures[1].body.messages.find(message => (
    message.role === 'user'
      && message.content.every(block => block.type === 'tool_result')
  ));
  assert.deepEqual(
    resultMessage.content.map(block => block.tool_use_id),
    ['toolu_one', 'toolu_two']
  );
});

await test('truncated authority output is rejected even when its JSON prefix is valid', async () => {
  const client = queuedClient([openAiResponse({
    text: JSON.stringify({
      protocol: 'naruto.continuity-json/v1',
      operation: 'stage_turn_bundle',
      bundle: { effect_ids: ['effect_chakra_cost'] }
    }),
    finishReason: 'length'
  })]);
  const result = await invokeContinuityModel({
    client,
    profile: profile('openai_compatible', 'truncated'),
    owner_user_id: 'payer_user',
    system_prompt: '连续性系统提示',
    prompt: '{"stage":"continuity"}',
    operation: 'stage_turn_bundle',
    transport_mode: 'json_protocol',
    capture_protocol_errors: true
  });
  assert.equal(result.command, null);
  assert.equal(result.protocol_error.code, 'MODEL_OUTPUT_TRUNCATED');
});

console.log(`${passed} multiplayer server Agent runtime regression tests passed.`);
