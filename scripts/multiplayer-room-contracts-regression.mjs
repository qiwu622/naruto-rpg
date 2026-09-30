import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';

import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';

import {
  ACTION_LIMITS,
  ACTION_RECEIPT_JSON_SCHEMA,
  ACTION_REQUEST_JSON_SCHEMA,
  ACTION_REQUEST_SCHEMA,
  ACTION_SUBMISSION_MEMBER_VIEW_JSON_SCHEMA,
  ACTION_TURN_MEMBER_PROJECTION_JSON_SCHEMA,
  ACTION_TURN_MEMBER_PROJECTION_SCHEMA,
  COMMITTED_TURN_PUBLICATION_JSON_SCHEMA,
  COMMITTED_TURN_PUBLICATION_SCHEMA,
  assertActionReceipt,
  assertActionRequest,
  assertActionSubmissionMemberView,
  assertActionTurnMemberProjection,
  inspectActionRequest,
  inspectActionSubmissionMemberView,
  inspectActionTurnMemberProjection
} from '../server/multiplayer/contracts/action-contracts.js';
import { NARRATIVE_DELIVERY_SCHEMA } from '../server/multiplayer/contracts/narrative-contracts.js';
import {
  MEMBER_STATE_PROJECTION_JSON_SCHEMA,
  MEMBER_STATE_PROJECTION_SCHEMA
} from '../server/multiplayer/contracts/member-state-contracts.js';
import {
  CHAT_IDEMPOTENCY_KEY_MAX_LENGTH,
  CHAT_MESSAGE_REQUEST_JSON_SCHEMA,
  ROOM_CHAT_MESSAGE_JSON_SCHEMA,
  ROOM_CHAT_MESSAGE_SCHEMA,
  assertRoomChatMessage,
  assertRoomChatMessageRequest,
  inspectRoomChatMessage,
  inspectRoomChatMessageRequest
} from '../server/multiplayer/contracts/chat-contracts.js';
import {
  CONFIRMED_MULTIPLAYER_INVARIANTS,
  MULTIPLAYER_UI_DEFAULTS,
  NARRATION_PREFERENCES,
  NARRATIVE_MODES,
  PRE_RESOLUTION_VISIBILITIES,
  ROOM_ORIGIN_TYPES
} from '../server/multiplayer/contracts/enums.js';
import {
  NARRATIVE_MODE_CHANGE_REQUEST_JSON_SCHEMA,
  ROOM_CONTROL_JSON_SCHEMA,
  ROOM_CONTROL_SCHEMA,
  TURN_EXECUTION_PLAN_JSON_SCHEMA,
  TURN_EXECUTION_PLAN_SCHEMA,
  assertNarrativeModeChangeRequest,
  assertRoomControl,
  assertTurnExecutionPlan,
  inspectNarrativeModeChangeRequest,
  inspectRoomControl,
  inspectTurnExecutionPlan
} from '../server/multiplayer/contracts/room-contracts.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const HASH_D = `sha256:${'d'.repeat(64)}`;
const COMMITMENT_A = `hmac-sha256:${'a'.repeat(64)}`;
const COMMITMENT_B = `hmac-sha256:${'b'.repeat(64)}`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dangerous(value = 1) {
  return JSON.parse(`{"__proto__":${JSON.stringify(value)}}`);
}

function deeplyNestedDangerousCanonicalData(name, value = 1, depth = 12) {
  let nested = JSON.parse(`{${JSON.stringify(name)}:${JSON.stringify(value)}}`);
  for (let index = 0; index < depth; index += 1) {
    nested = { [`safe_layer_${index}`]: [nested] };
  }
  return nested;
}

function expectInvalid(inspect, value, expectedPath = undefined) {
  const result = inspect(value);
  assert.equal(result.valid, false);
  assert.equal(result.value, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'SCHEMA_VIOLATION');
  if (expectedPath !== undefined) assert.equal(result.errors[0].path, expectedPath);
  return result;
}

function assertStrictObjectSchemas(schema, path = '#') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    const isSafeCanonicalMap = Object.keys(schema).length === 3
      && Object.keys(schema.additionalProperties ?? {}).length === 1
      && schema.additionalProperties?.$ref === '#/$defs/member_state_canonical_data'
      && Object.keys(schema.propertyNames ?? {}).length === 1
      && Object.keys(schema.propertyNames?.not ?? {}).length === 1
      && schema.propertyNames?.not?.enum?.length === 3
      && ['__proto__', 'prototype', 'constructor'].every(name => (
        schema.propertyNames.not.enum.includes(name)
      ));
    assert.equal(
      schema.additionalProperties === false || isSafeCanonicalMap,
      true,
      `${path} object schema must close unknown fields or use the guarded canonical map`
    );
  }
  for (const [key, child] of Object.entries(schema)) {
    if (key === 'properties' || key === '$defs') {
      for (const [name, nested] of Object.entries(child)) {
        assertStrictObjectSchemas(nested, `${path}/${key}/${name}`);
      }
    } else if (Array.isArray(child)) {
      child.forEach((nested, index) => assertStrictObjectSchemas(nested, `${path}/${key}/${index}`));
    } else {
      assertStrictObjectSchemas(child, `${path}/${key}`);
    }
  }
}

let passed = 0;
function test(name, callback) {
  callback();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const validModeChange = {
  expected_control_revision: 17,
  mode: 'dual_pov',
  idempotency_key: 'mode-change-0001'
};

const validRoomControl = {
  schema: ROOM_CONTROL_SCHEMA,
  control_revision: 18,
  event_seq: 41,
  room_lifecycle: 'ACTIVE',
  turn_status: 'ONE_ACTION_LOCKED',
  active_narrative_mode: 'shared',
  queued_narrative_mode: 'dual_pov'
};

const sharedPlan = {
  schema: TURN_EXECUTION_PLAN_SCHEMA,
  narrative_mode: 'shared',
  turn_payer_selection_hash: HASH_A,
  pov_writer_selection_hashes: null,
  writer_payer_by_audience: null,
  model_config_fingerprints: {
    shared_stage: HASH_B,
    pov_writers: null
  }
};

const dualPlan = {
  schema: TURN_EXECUTION_PLAN_SCHEMA,
  narrative_mode: 'dual_pov',
  turn_payer_selection_hash: HASH_A,
  pov_writer_selection_hashes: { A: HASH_B, B: HASH_C },
  writer_payer_by_audience: { A: 'B', B: 'A' },
  model_config_fingerprints: {
    shared_stage: HASH_D,
    pov_writers: { A: HASH_B, B: HASH_C }
  }
};

const request = {
  schema: ACTION_REQUEST_SCHEMA,
  base_state_revision: 42,
  text: '我先在门后布置起爆符。',
  pre_resolution_visibility: 'sealed',
  narration_preference: 'summarize_intent',
  narration_note: '正文概述准备过程即可。',
  idempotency_key: 'action-request-0001'
};

function receipt(seat, submissionId, sequence, commitment) {
  return {
    submission_id: submissionId,
    seat,
    receipt_seq: sequence,
    received_at: sequence === 1
      ? '2026-08-21T12:00:00.123Z'
      : '2026-08-21T12:00:01.456Z',
    content_commitment: commitment,
    base_state_revision: 42
  };
}

const ownerA = {
  seat: 'A',
  locked: true,
  submission_id: 'action_a_01',
  text: '我先在门后布置起爆符。',
  disclosure: 'owner',
  receipt: receipt('A', 'action_a_01', 1, COMMITMENT_A)
};

const openB = {
  seat: 'B',
  locked: true,
  submission_id: 'action_b_01',
  text: '我检查门边的异常痕迹。',
  disclosure: 'open_pre_resolution'
};

function projection({
  status = 'ONE_ACTION_LOCKED',
  owner = ownerA,
  opponent = { seat: 'B', locked: true }
} = {}) {
  return {
    schema: ACTION_TURN_MEMBER_PROJECTION_SCHEMA,
    turn_id: 'turn_01',
    turn_no: 1,
    viewer_seat: 'A',
    status,
    active_narrative_mode: 'shared',
    post_commit_disclosure: 'full_after_commit',
    actions: { A: clone(owner), B: clone(opponent) }
  };
}

function committedPublication({
  audience = 'shared',
  daily = clone(SHINOBI_DAILY_EXAMPLE)
} = {}) {
  return {
    schema: COMMITTED_TURN_PUBLICATION_SCHEMA,
    checkpoint: {
      checkpoint_id: 'checkpoint_turn_01',
      commit_id: 'commit_turn_01',
      state_revision: 43,
      created_at: '2026-08-21T12:01:00.000Z'
    },
    state: {
      schema: MEMBER_STATE_PROJECTION_SCHEMA,
      viewer_seat: 'A',
      state_revision: 43,
      shared_world: {
        world_state: { locations: [] },
        calendar: { display_date: '木叶纪元第一日' },
        map: { markers: [] },
        shared_missions: { entries: [] },
        shared_combat: { encounters: [] }
      },
      actors: {
        A: {
          room_actor_id: 'actor:A',
          player: { display_name: '甲', goal: '守护同伴' },
          attributes: { resources: { chakra: 40 } },
          progression: { level: 1 },
          skills: { entries: [{ skill_id: 'skill:a' }] },
          equipment: { entries: [{ item_id: 'item:a' }] },
          missions: { entries: [{ mission_id: 'mission:a' }] },
          private_knowledge: { facts: ['甲的秘密'] }
        },
        B: {
          room_actor_id: 'actor:B',
          player: {
            schema: 'naruto.multiplayer-actor-profile/v1',
            version: 1,
            display_name: '乙',
            rank: '下忍',
            alive: true,
            status: 'ACTIVE'
          },
          attributes: { resources: { chakra: 30 } },
          progression: { level: 1 },
          skills: { schema: 'actor-skills-v1', entries: [] },
          equipment: { schema: 'actor-items-v1', entries: [] },
          missions: { schema: 'actor-missions-v1', entries: [] },
          private_knowledge: {}
        }
      },
      relationships: [{
        edge_id: 'relationship:a:npc',
        source_actor_id: 'actor:A',
        target_actor_id: 'npc:npc_1',
        data: { trust: 2 }
      }],
      memories: {
        shared: { entries: ['共同事件'] },
        personal: { entries: ['甲亲历的秘密'] }
      }
    },
    narratives: [{
      schema: NARRATIVE_DELIVERY_SCHEMA,
      turn_id: 'turn_01',
      audience,
      resolution_commitment: COMMITMENT_A,
      segments: [{
        segment_id: 'segment_turn_01',
        event_refs: ['event_turn_01'],
        claims: [{
          event_id: 'event_turn_01',
          subject_id: 'actor:A',
          predicate: 'observed',
          value: true
        }],
        text: '甲与乙各自完成了这一回合的行动。'
      }],
      stop_point_ref: 'event_turn_01'
    }],
    shinobi_daily: [{
      daily_id: 'daily_turn_01',
      source_turn_id: 'turn_01',
      daily
    }]
  };
}

test('all exported JSON Schemas are frozen and strict at every declared object boundary', () => {
  const schemas = [
    NARRATIVE_MODE_CHANGE_REQUEST_JSON_SCHEMA,
    ROOM_CONTROL_JSON_SCHEMA,
    TURN_EXECUTION_PLAN_JSON_SCHEMA,
    ACTION_REQUEST_JSON_SCHEMA,
    ACTION_RECEIPT_JSON_SCHEMA,
    ACTION_SUBMISSION_MEMBER_VIEW_JSON_SCHEMA,
    ACTION_TURN_MEMBER_PROJECTION_JSON_SCHEMA,
    COMMITTED_TURN_PUBLICATION_JSON_SCHEMA,
    MEMBER_STATE_PROJECTION_JSON_SCHEMA,
    CHAT_MESSAGE_REQUEST_JSON_SCHEMA,
    ROOM_CHAT_MESSAGE_JSON_SCHEMA
  ];
  for (const schema of schemas) {
    assert.equal(Object.isFrozen(schema), true);
    assertStrictObjectSchemas(schema);
  }
  assert.deepEqual(ACTION_REQUEST_JSON_SCHEMA.properties.pre_resolution_visibility.enum,
    PRE_RESOLUTION_VISIBILITIES);
  assert.deepEqual(ACTION_REQUEST_JSON_SCHEMA.properties.narration_preference.enum,
    NARRATION_PREFERENCES);
  assert.equal(ACTION_REQUEST_JSON_SCHEMA.properties.text.maxLength, ACTION_LIMITS.textMaxLength);
  assert.equal(CHAT_MESSAGE_REQUEST_JSON_SCHEMA.properties.text.maxLength, 1_000);

  const validateMemberState = new Ajv2020({ strict: true }).compile(
    MEMBER_STATE_PROJECTION_JSON_SCHEMA
  );
  const memberState = committedPublication().state;
  assert.equal(validateMemberState(memberState), true);
  const schemaLeak = clone(memberState);
  schemaLeak.actors.B.private_knowledge = { facts: ['schema-only leak'] };
  assert.equal(validateMemberState(schemaLeak), false);

  const pollutedWorldState = clone(memberState);
  pollutedWorldState.shared_world.world_state = dangerous({ polluted: true });
  assert.equal(validateMemberState(pollutedWorldState), false);

  const embeddedAjv = new Ajv2020({
    strict: true,
    // `commit` is declared on the parent schema and conditionally required in
    // an allOf branch, which Ajv's same-subschema strictRequired check cannot
    // infer even though the resulting JSON Schema is closed.
    strictRequired: false,
    formats: { 'date-time': true }
  });
  const validateTurn = embeddedAjv.compile(ACTION_TURN_MEMBER_PROJECTION_JSON_SCHEMA);
  const validateCommit = embeddedAjv.compile(COMMITTED_TURN_PUBLICATION_JSON_SCHEMA);
  const committedTurn = {
    ...projection({
      status: 'COMMITTED',
      opponent: { ...openB, disclosure: 'full_after_commit' }
    }),
    commit: committedPublication()
  };
  assert.equal(validateTurn(committedTurn), true);
  assert.equal(validateCommit(committedTurn.commit), true);

  const ordinaryDynamicState = clone(memberState);
  ordinaryDynamicState.shared_world.world_state = {
    extension_namespace: {
      entries: [{
        constructor_id: 'safe-dynamic-id',
        prototype_version: 2,
        __proto___label: 'near-match keys remain ordinary canonical data',
        nested_values: [null, true, 3.5, 'text', { custom_leaf: 'ok' }]
      }]
    }
  };
  const ordinaryDynamicTurn = clone(committedTurn);
  ordinaryDynamicTurn.commit.state = ordinaryDynamicState;
  assert.equal(validateMemberState(ordinaryDynamicState), true);
  assert.equal(validateTurn(ordinaryDynamicTurn), true);
  assert.equal(validateCommit(ordinaryDynamicTurn.commit), true);

  const embeddedCases = [
    {
      label: 'independent member-state schema',
      validate: validateMemberState,
      candidate: state => state
    },
    {
      label: 'embedded ACTION turn schema',
      validate: validateTurn,
      candidate: state => {
        const turn = clone(committedTurn);
        turn.commit.state = state;
        return turn;
      }
    },
    {
      label: 'embedded COMMITTED publication schema',
      validate: validateCommit,
      candidate: state => {
        const commit = clone(committedTurn.commit);
        commit.state = state;
        return commit;
      }
    }
  ];
  for (const dangerousName of ['__proto__', 'prototype', 'constructor']) {
    for (const schemaCase of embeddedCases) {
      const pollutedState = clone(memberState);
      pollutedState.shared_world.world_state = deeplyNestedDangerousCanonicalData(
        dangerousName,
        { polluted: true }
      );
      assert.equal(
        schemaCase.validate(schemaCase.candidate(pollutedState)),
        false,
        `${schemaCase.label} accepted a deeply nested ${dangerousName} property`
      );
    }
  }
});

test('section 28.1 confirmed invariants remain exact and UI defaults stay separate', () => {
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.max_players, 2);
  assert.deepEqual(CONFIRMED_MULTIPLAYER_INVARIANTS.origin_type_allowed, ROOM_ORIGIN_TYPES);
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.origin_type_selection_required, true);
  assert.deepEqual(CONFIRMED_MULTIPLAYER_INVARIANTS.narrative_mode_allowed, NARRATIVE_MODES);
  assert.deepEqual(
    CONFIRMED_MULTIPLAYER_INVARIANTS.pre_resolution_visibility_allowed,
    PRE_RESOLUTION_VISIBILITIES
  );
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.post_commit_disclosure, 'full_after_commit');
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.receipt_order_story_effect, 'none');
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.wait_policy, 'unlimited_player_coordinated');
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.action_timeout, null);
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.chat_enabled, true);
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.chat_agent_ingestion, 'explicit_action_copy_only');
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.ai_billing, 'player_byok_no_platform_fallback');
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.frontend_instruction_parsing, 'forbidden');
  assert.equal(
    CONFIRMED_MULTIPLAYER_INVARIANTS.turn_failure_policy,
    'no_partial_commit_or_action_disclosure'
  );
  assert.equal(MULTIPLAYER_UI_DEFAULTS.narrative_mode_default, 'shared');
  assert.equal(MULTIPLAYER_UI_DEFAULTS.pre_resolution_visibility_default, 'sealed');
  assert.equal(MULTIPLAYER_UI_DEFAULTS.narration_preference_default, 'full');
  assert.equal('narrative_mode_default' in CONFIRMED_MULTIPLAYER_INVARIANTS, false);
});

test('narrative mode change request accepts only the documented CAS request fields', () => {
  const normalized = assertNarrativeModeChangeRequest(validModeChange);
  assert.deepEqual(normalized, validModeChange);
  assert.equal(Object.isFrozen(normalized), true);

  for (const field of ['seat', 'user_id', 'control_revision', 'receipt_seq', 'room_owner']) {
    expectInvalid(inspectNarrativeModeChangeRequest, { ...validModeChange, [field]: 'forged' }, `/${field}`);
  }
  expectInvalid(inspectNarrativeModeChangeRequest, { ...validModeChange, mode: 'triple_pov' }, '/mode');
  expectInvalid(inspectNarrativeModeChangeRequest, {
    ...validModeChange,
    expected_control_revision: -1
  }, '/expected_control_revision');
  expectInvalid(inspectNarrativeModeChangeRequest, {
    ...validModeChange,
    ...dangerous({ polluted: true })
  }, '/__proto__');
});

test('room control validates enums, revisions and canonical queued-mode state', () => {
  assert.deepEqual(assertRoomControl(validRoomControl), validRoomControl);
  assert.deepEqual(assertRoomControl({
    ...validRoomControl,
    room_lifecycle: 'LOBBY',
    turn_status: null,
    queued_narrative_mode: null
  }).turn_status, null);
  expectInvalid(inspectRoomControl, { ...validRoomControl, room_lifecycle: 'DELETED' }, '/room_lifecycle');
  expectInvalid(inspectRoomControl, { ...validRoomControl, turn_status: 'WAITING_FOREVER' }, '/turn_status');
  expectInvalid(inspectRoomControl, {
    ...validRoomControl,
    queued_narrative_mode: validRoomControl.active_narrative_mode
  }, '/queued_narrative_mode');
  expectInvalid(inspectRoomControl, { ...validRoomControl, revision: 18 }, '/revision');
});

test('TurnExecutionPlan freezes one shared plan or both complete dual-POV writer bindings', () => {
  const frozenShared = assertTurnExecutionPlan(sharedPlan);
  const frozenDual = assertTurnExecutionPlan(dualPlan);
  assert.deepEqual(frozenShared, sharedPlan);
  assert.deepEqual(frozenDual, dualPlan);
  assert.equal(Object.isFrozen(frozenDual.model_config_fingerprints.pov_writers), true);

  expectInvalid(inspectTurnExecutionPlan, {
    ...sharedPlan,
    pov_writer_selection_hashes: { A: HASH_A, B: HASH_B }
  }, '/pov_writer_selection_hashes');
  expectInvalid(inspectTurnExecutionPlan, {
    ...dualPlan,
    writer_payer_by_audience: null
  }, '/writer_payer_by_audience');
  expectInvalid(inspectTurnExecutionPlan, {
    ...dualPlan,
    writer_payer_by_audience: { A: 'A', B: 'C' }
  }, '/writer_payer_by_audience/B');
  expectInvalid(inspectTurnExecutionPlan, { ...sharedPlan, receipt_seq: 1 }, '/receipt_seq');

  const polluted = clone(dualPlan);
  polluted.model_config_fingerprints = {
    ...polluted.model_config_fingerprints,
    ...dangerous(true)
  };
  expectInvalid(inspectTurnExecutionPlan, polluted, '/model_config_fingerprints/__proto__');
});

test('ActionRequest follows action-turn length constants and rejects controls and blank intent', () => {
  const normalized = assertActionRequest(request);
  assert.deepEqual(normalized, request);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(assertActionRequest({ ...request, text: '忍'.repeat(ACTION_LIMITS.textMaxLength) }).text.length,
    ACTION_LIMITS.textMaxLength);
  assert.equal(assertActionRequest({
    ...request,
    narration_note: '注'.repeat(ACTION_LIMITS.narrationNoteMaxLength)
  }).narration_note.length, ACTION_LIMITS.narrationNoteMaxLength);

  expectInvalid(inspectActionRequest, {
    ...request,
    text: '忍'.repeat(ACTION_LIMITS.textMaxLength + 1)
  }, '/text');
  expectInvalid(inspectActionRequest, { ...request, text: ' \n\t ' }, '/text');
  expectInvalid(inspectActionRequest, { ...request, text: '行动\u0000注入' }, '/text');
  expectInvalid(inspectActionRequest, { ...request, narration_note: '注释\u202E伪装' }, '/narration_note');
});

test('ActionRequest rejects unknown, dangerous and server-owned binding fields', () => {
  for (const field of [
    'seat',
    'user_id',
    'room_id',
    'receipt_seq',
    'received_at',
    'content_commitment',
    'post_commit_disclosure',
    'submission_id'
  ]) {
    expectInvalid(inspectActionRequest, { ...request, [field]: 'forged' }, `/${field}`);
  }
  expectInvalid(inspectActionRequest, {
    ...request,
    pre_resolution_visibility: 'private'
  }, '/pre_resolution_visibility');
  expectInvalid(inspectActionRequest, {
    ...request,
    narration_preference: 'hide_outcome'
  }, '/narration_preference');
  expectInvalid(inspectActionRequest, { ...request, ...dangerous(true) }, '/__proto__');
  assert.throws(() => assertActionRequest({ ...request, seat: 'A' }), DomainError);
});

test('action receipts are owner-only server metadata with matching fixed fields', () => {
  const receiptA = receipt('A', 'action_a_01', 1, COMMITMENT_A);
  assert.deepEqual(assertActionReceipt(receiptA), receiptA);
  assert.throws(() => assertActionReceipt({ ...receiptA, receipt_seq: 3 }), DomainError);
  assert.throws(() => assertActionReceipt({ ...receiptA, received_at: 'client time' }), DomainError);
  assert.throws(() => assertActionReceipt({ ...receiptA, content_commitment: HASH_A }), DomainError);
  assert.throws(() => assertActionReceipt({ ...receiptA, request_hash: HASH_A }), DomainError);
});

test('member action views make hidden, owner and disclosed-opponent branches disjoint', () => {
  assert.deepEqual(assertActionSubmissionMemberView({ seat: 'B', locked: false }), {
    seat: 'B',
    locked: false
  });
  const hidden = assertActionSubmissionMemberView({ seat: 'B', locked: true });
  assert.deepEqual(Object.keys(hidden).sort(), ['locked', 'seat']);
  assert.deepEqual(assertActionSubmissionMemberView(ownerA), ownerA);
  assert.deepEqual(assertActionSubmissionMemberView(openB), openB);

  expectInvalid(inspectActionSubmissionMemberView, {
    seat: 'B',
    locked: true,
    submission_id: 'leaked_id'
  }, '/submission_id');
  expectInvalid(inspectActionSubmissionMemberView, {
    ...openB,
    receipt: receipt('B', 'action_b_01', 2, COMMITMENT_B)
  }, '/receipt');
  expectInvalid(inspectActionSubmissionMemberView, {
    ...ownerA,
    receipt: { ...ownerA.receipt, seat: 'B' }
  }, '/receipt/seat');
  expectInvalid(inspectActionSubmissionMemberView, {
    ...ownerA,
    receipt: { ...ownerA.receipt, submission_id: 'action_other' }
  }, '/receipt/submission_id');
});

test('member turn projection never gives an opponent receipt or premature sealed text', () => {
  const hiddenProjection = assertActionTurnMemberProjection(projection());
  assert.deepEqual(hiddenProjection.actions.B, { seat: 'B', locked: true });
  for (const forbidden of [
    'submission_id',
    'text',
    'receipt',
    'content_commitment',
    'receipt_seq',
    'received_at',
    'request_hash',
    'narration_note'
  ]) {
    assert.equal(forbidden in hiddenProjection.actions.B, false);
  }

  const unlockedViewerProjection = assertActionTurnMemberProjection(projection({
    owner: { seat: 'A', locked: false },
    opponent: openB
  }));
  assert.equal(unlockedViewerProjection.actions.B.disclosure, 'open_pre_resolution');

  const ownerASecond = {
    ...ownerA,
    receipt: receipt('A', ownerA.submission_id, 2, COMMITMENT_A)
  };
  const openProjection = assertActionTurnMemberProjection(projection({
    status: 'SEALED',
    owner: ownerASecond,
    opponent: openB
  }));
  assert.equal(openProjection.actions.B.disclosure, 'open_pre_resolution');
  assert.equal('receipt' in openProjection.actions.B, false);

  expectInvalid(inspectActionTurnMemberProjection, projection({
    status: 'SEALED',
    opponent: openB
  }), '/actions/A/receipt/receipt_seq');

  expectInvalid(inspectActionTurnMemberProjection, projection({
    opponent: { ...openB, disclosure: 'full_after_commit' }
  }), '/actions/B/disclosure');
  expectInvalid(inspectActionTurnMemberProjection, {
    ...projection(),
    actions: { A: clone(ownerA), B: { seat: 'A', locked: true } }
  }, '/actions/B/seat');
  expectInvalid(inspectActionTurnMemberProjection, {
    ...projection(),
    actions: { ...projection().actions, debug: { text: 'sealed leak' } }
  }, '/actions/debug');
});

test('COMMITTED projection requires exact full_after_commit disclosure of both actions', () => {
  const committedOpponent = {
    ...openB,
    disclosure: 'full_after_commit'
  };
  const committed = assertActionTurnMemberProjection({
    ...projection({
      status: 'COMMITTED',
      opponent: committedOpponent
    }),
    commit: committedPublication()
  });
  assert.equal(committed.actions.A.text, ownerA.text);
  assert.equal(committed.actions.B.text, openB.text);
  assert.equal('receipt' in committed.actions.B, false);

  expectInvalid(inspectActionTurnMemberProjection, projection({ status: 'COMMITTED' }), '/actions');
  expectInvalid(inspectActionTurnMemberProjection, projection({
    status: 'COMMITTED',
    opponent: openB
  }), '/actions/B/disclosure');
  expectInvalid(inspectActionTurnMemberProjection, {
    ...projection({ status: 'COMMITTED', opponent: committedOpponent }),
    actions: {
      A: clone(ownerA),
      B: { ...committedOpponent, submission_id: ownerA.submission_id }
    },
    commit: committedPublication()
  }, '/actions');
});

test('COMMITTED publication is member-bound and rejected on early, cross-POV or invalid daily projection', () => {
  const committedOpponent = {
    ...openB,
    disclosure: 'full_after_commit'
  };
  const shared = assertActionTurnMemberProjection({
    ...projection({ status: 'COMMITTED', opponent: committedOpponent }),
    commit: committedPublication()
  });
  assert.equal(shared.commit.narratives[0].audience, 'shared');
  assert.equal(shared.commit.shinobi_daily[0].daily.schema, 'naruto.shinobi-daily/v1');
  assert.equal(shared.commit.state.viewer_seat, 'A');
  assert.equal('canonical' in shared.commit.state.memories, false);
  assert.equal('npc_private' in shared.commit.state.memories, false);
  assert.equal(Object.isFrozen(shared.commit), true);

  expectInvalid(inspectActionTurnMemberProjection, projection({
    status: 'COMMITTED',
    opponent: committedOpponent
  }), '/commit');

  const dualA = {
    ...projection({ status: 'COMMITTED', opponent: committedOpponent }),
    active_narrative_mode: 'dual_pov',
    commit: committedPublication({ audience: 'seat:A' })
  };
  assert.equal(
    assertActionTurnMemberProjection(dualA).commit.narratives[0].audience,
    'seat:A'
  );
  expectInvalid(inspectActionTurnMemberProjection, {
    ...dualA,
    commit: committedPublication({ audience: 'seat:B' })
  }, '/commit/narratives/0');

  const wrongStateAudience = committedPublication();
  wrongStateAudience.state.viewer_seat = 'B';
  expectInvalid(inspectActionTurnMemberProjection, {
    ...projection({ status: 'COMMITTED', opponent: committedOpponent }),
    commit: wrongStateAudience
  }, '/commit/state/viewer_seat');

  const leakedCounterpart = committedPublication();
  leakedCounterpart.state.actors.B.skills.entries.push({ skill_id: 'skill:secret' });
  expectInvalid(inspectActionTurnMemberProjection, {
    ...projection({ status: 'COMMITTED', opponent: committedOpponent }),
    commit: leakedCounterpart
  }, '/commit/state/actors/B/skills');

  const leakedRelationship = committedPublication();
  leakedRelationship.state.relationships[0].source_actor_id = 'actor:B';
  expectInvalid(inspectActionTurnMemberProjection, {
    ...projection({ status: 'COMMITTED', opponent: committedOpponent }),
    commit: leakedRelationship
  }, '/commit/state/relationships/0/source_actor_id');

  expectInvalid(inspectActionTurnMemberProjection, {
    ...projection({ status: 'SEALED' }),
    commit: committedPublication()
  }, '/commit');

  const invalidDaily = clone(SHINOBI_DAILY_EXAMPLE);
  invalidDaily.issue = '无效刊号';
  expectInvalid(inspectActionTurnMemberProjection, {
    ...projection({ status: 'COMMITTED', opponent: committedOpponent }),
    commit: committedPublication({ daily: invalidDaily })
  }, '/commit/shinobi_daily/0/daily');
});

test('chat request normalizes newlines and counts Unicode code points up to 1000', () => {
  const normalized = assertRoomChatMessageRequest({
    text: '第一行\r\n第二行\r第三行',
    idempotency_key: 'chat-message-0001'
  });
  assert.equal(normalized.text, '第一行\n第二行\n第三行');
  assert.equal(Object.isFrozen(normalized), true);

  const emojiLimit = '🍥'.repeat(1_000);
  assert.equal(assertRoomChatMessageRequest({
    text: emojiLimit,
    idempotency_key: 'chat-message-emoji-limit'
  }).text, emojiLimit);
  expectInvalid(inspectRoomChatMessageRequest, {
    text: `${emojiLimit}🍥`,
    idempotency_key: 'chat-message-too-long'
  }, '/text');
  assert.equal(CHAT_IDEMPOTENCY_KEY_MAX_LENGTH, 200);
});

test('chat request rejects dangerous controls, keys and all server-owned message fields', () => {
  for (const text of ['普通消息\u0000伪造', '普通消息\u202E伪造', '普通消息\u2066伪造']) {
    expectInvalid(inspectRoomChatMessageRequest, {
      text,
      idempotency_key: 'chat-controls'
    }, '/text');
  }
  for (const field of [
    'schema',
    'message_id',
    'room_id',
    'epoch_id',
    'sender_seat',
    'sender_user_id',
    'created_at',
    'event_seq',
    'message_type',
    'canonical_event_ref'
  ]) {
    expectInvalid(inspectRoomChatMessageRequest, {
      text: '普通成员消息',
      idempotency_key: 'chat-server-fields',
      [field]: 'forged'
    }, `/${field}`);
  }
  expectInvalid(inspectRoomChatMessageRequest, {
    text: '普通成员消息',
    idempotency_key: 'chat-dangerous-key',
    ...dangerous({ polluted: true })
  }, '/__proto__');
});

test('RoomChatMessage exposes only immutable member-safe server metadata', () => {
  const message = {
    schema: ROOM_CHAT_MESSAGE_SCHEMA,
    message_id: 'chat_01',
    room_id: 'room_01',
    epoch_id: null,
    sender_seat: 'B',
    text: '我们先商量这一回合怎么分头行动。',
    created_at: '2026-08-21T12:01:02.345Z',
    event_seq: 42
  };
  assert.deepEqual(assertRoomChatMessage(message), message);
  assert.equal(inspectRoomChatMessage(message).valid, true);
  assert.equal(assertRoomChatMessage({ ...message, epoch_id: 'epoch_01' }).epoch_id, 'epoch_01');

  expectInvalid(inspectRoomChatMessage, { ...message, sender_seat: 'system' }, '/sender_seat');
  expectInvalid(inspectRoomChatMessage, { ...message, event_seq: 0 }, '/event_seq');
  expectInvalid(inspectRoomChatMessage, { ...message, created_at: 'yesterday' }, '/created_at');
  expectInvalid(inspectRoomChatMessage, { ...message, user_id: 'user_other' }, '/user_id');
  expectInvalid(inspectRoomChatMessage, { ...message, idempotency_key: 'private-request-key' },
    '/idempotency_key');
  expectInvalid(inspectRoomChatMessage, { ...message, ...dangerous(true) }, '/__proto__');
});

console.log(`multiplayer room contracts regression: ${passed} passed`);
