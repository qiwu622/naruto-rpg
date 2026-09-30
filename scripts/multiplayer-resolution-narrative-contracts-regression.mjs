import assert from 'node:assert/strict';

import { compileEffectDag } from '../server/multiplayer/domain/effect-dag.js';
import {
  CANONICAL_RESOLUTION_SCHEMA,
  CANONICAL_RESOLUTION_JSON_SCHEMA,
  RESOLUTION_CANDIDATE_SCHEMA,
  RESOLUTION_CANDIDATE_JSON_SCHEMA,
  assertCanonicalResolution,
  assertResolutionCandidate,
  freezeCanonicalResolution
} from '../server/multiplayer/contracts/resolution-contracts.js';
import {
  NARRATIVE_CANDIDATE_JSON_SCHEMA,
  NARRATIVE_DELIVERY_SCHEMA,
  NARRATIVE_DELIVERY_JSON_SCHEMA,
  NARRATIVE_GROUNDING_REVIEW_RECEIPT_JSON_SCHEMA,
  assertGroundedNarrativeDeliverySet,
  assertNarrativeCandidate,
  assertNarrativeDeliverySet,
  createNarrativeGroundingReviewReceipt,
  freezeNarrativeDelivery
} from '../server/multiplayer/contracts/narrative-contracts.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function expectCode(code) {
  return error => error?.code === code;
}

function resolutionCandidate() {
  return {
    schema: RESOLUTION_CANDIDATE_SCHEMA,
    conflicts: [{
      id: 'conflict_main',
      type: 'direct_opposition',
      submission_ids: ['action_A', 'action_B'],
      rule_basis: ['rule:opposed-check/v1', '当前位置与已有准备']
    }],
    outcomes: [{
      submission_id: 'action_B',
      status: 'blocked',
      reason: 'A 先行封闭了入口。',
      event_ids: ['event_shared', 'event_b_private']
    }, {
      submission_id: 'action_A',
      status: 'partial_success',
      reason: '入口被封闭，但消耗了查克拉。',
      event_ids: ['event_a_private', 'event_shared']
    }],
    events: [{
      event_id: 'event_b_private',
      summary: 'B 察觉到另一条隐秘的离开路径。',
      audiences: ['seat:B'],
      world_public: false,
      effect_ids: []
    }, {
      event_id: 'event_shared',
      summary: 'A 施术封闭入口并消耗十二点查克拉。',
      audiences: ['seat:B', 'seat:A'],
      world_public: false,
      effect_ids: ['effect_chakra_cost']
    }, {
      event_id: 'event_a_private',
      summary: 'A 发现封印只能维持片刻。',
      audiences: ['seat:A'],
      world_public: false,
      effect_ids: []
    }],
    effects: [{
      effect_id: 'effect_chakra_cost',
      depends_on_effect_ids: [],
      event_id: 'event_shared',
      target: {
        scope: 'actor',
        actor: 'A',
        entity_id: 'actor:A'
      },
      domain: 'attributes',
      kind: 'resource_delta',
      operation: 'consume',
      payload: {
        resource: 'chakra',
        amount: 12,
        unit: 'points'
      },
      provenance: 'rules_engine',
      visibility: 'server_only',
      evidence_event_ids: ['event_shared']
    }],
    elapsed_time: '约十秒',
    stop_point: '入口已封闭，把下一项实质选择交还给双方。'
  };
}

const ruleSnapshot = {
  schema: 'naruto.multiplayer-rule-snapshot/v1',
  rules_version: 'rules-2026-08-22',
  attributes_reducer_version: 'v1'
};

function compileCandidate(candidate = resolutionCandidate()) {
  return compileEffectDag(candidate.effects, {
    ruleSnapshot,
    resolveReducer(effect) {
      assert.equal(effect.domain, 'attributes');
      return {
        required_reducer: 'apply_actor_resource_effect',
        reducer_version: 'attributes/v1'
      };
    }
  });
}

const resolutionBinding = Object.freeze({
  turn_id: 'turn_contract_1',
  base_state_revision: 42,
  input_hash: `hmac-sha256:${'1'.repeat(64)}`,
  submission_ids: ['action_A', 'action_B']
});

function canonicalResolution() {
  const candidate = resolutionCandidate();
  return freezeCanonicalResolution(candidate, resolutionBinding, compileCandidate(candidate));
}

const resolutionCommitment = `hmac-sha256:${'2'.repeat(64)}`;

function claim(eventId, predicate, value, subjectId = 'actor:A') {
  return {
    event_id: eventId,
    subject_id: subjectId,
    predicate,
    value
  };
}

function sharedCandidate(text = '少年结印后，入口在轰鸣中合拢。') {
  return {
    segments: [{
      segment_id: 'segment_shared',
      event_refs: ['event_shared'],
      claims: [claim('event_shared', 'resource_spent', {
        resource: 'chakra',
        amount: 12
      })],
      text
    }],
    stop_point_ref: 'event_shared'
  };
}

function seatACandidate(text = '少年结印，入口随着震动合拢。') {
  return {
    segments: [{
      segment_id: 'segment_a_shared',
      event_refs: ['event_shared'],
      claims: [claim('event_shared', 'resource_spent', {
        resource: 'chakra',
        amount: 12
      })],
      text
    }, {
      segment_id: 'segment_a_private',
      event_refs: ['event_a_private'],
      claims: [claim('event_a_private', 'seal_duration_learned', 'brief')],
      text: 'A 能感到封印正在迅速衰减，新的选择已经逼近。'
    }],
    stop_point_ref: 'event_a_private'
  };
}

function seatBCandidate(text = '入口在轰鸣中合拢，去路暂时断绝。') {
  return {
    segments: [{
      segment_id: 'segment_b_shared',
      event_refs: ['event_shared'],
      claims: [claim('event_shared', 'entrance_sealed', true)],
      text
    }, {
      segment_id: 'segment_b_private',
      event_refs: ['event_b_private'],
      claims: [claim('event_b_private', 'route_discovered', 'hidden_exit', 'actor:B')],
      text: 'B 从岩壁的风声中察觉到另一条隐秘去路。'
    }],
    stop_point_ref: 'event_b_private'
  };
}

function bind(candidate, audience, resolution = canonicalResolution()) {
  return freezeNarrativeDelivery(candidate, {
    turn_id: resolution.turn_id,
    audience,
    resolution_commitment: resolutionCommitment,
    canonical_resolution: resolution
  });
}

function review(
  delivery,
  suffix = delivery.audience.replace(/[^A-Za-z]/g, '_'),
  reviewerRunId = 'reviewer_run_joint_grounding'
) {
  return createNarrativeGroundingReviewReceipt(delivery, {
    review_id: `review_${suffix}`,
    reviewer_run_id: reviewerRunId,
    status: 'APPROVED',
    findings: []
  });
}

test('stage-0 JSON Schemas close every fixed model/server record', () => {
  assert.equal(RESOLUTION_CANDIDATE_JSON_SCHEMA.additionalProperties, false);
  assert.equal(
    RESOLUTION_CANDIDATE_JSON_SCHEMA.properties.conflicts.items.additionalProperties,
    false
  );
  assert.equal(
    RESOLUTION_CANDIDATE_JSON_SCHEMA.properties.effects.items.additionalProperties,
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      RESOLUTION_CANDIDATE_JSON_SCHEMA.properties,
      'turn_id'
    ),
    false
  );
  assert.equal(CANONICAL_RESOLUTION_JSON_SCHEMA.additionalProperties, false);
  assert.equal(
    CANONICAL_RESOLUTION_JSON_SCHEMA.properties.effects.items.additionalProperties,
    false
  );

  assert.equal(NARRATIVE_CANDIDATE_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    Object.keys(NARRATIVE_CANDIDATE_JSON_SCHEMA.properties).sort(),
    ['segments', 'stop_point_ref']
  );
  assert.equal(
    NARRATIVE_CANDIDATE_JSON_SCHEMA.properties.segments.items.additionalProperties,
    false
  );
  assert.equal(NARRATIVE_DELIVERY_JSON_SCHEMA.additionalProperties, false);
  assert.equal(NARRATIVE_GROUNDING_REVIEW_RECEIPT_JSON_SCHEMA.additionalProperties, false);
});

test('resolution candidate is strict and cannot forge server-owned context or effect routing', () => {
  const normalized = assertResolutionCandidate(resolutionCandidate());
  assert.deepEqual(normalized.events.map(event => event.event_id), [
    'event_a_private',
    'event_b_private',
    'event_shared'
  ]);

  assert.throws(
    () => assertResolutionCandidate({ ...resolutionCandidate(), turn_id: 'turn_forged' }),
    expectCode('SCHEMA_VIOLATION')
  );
  assert.throws(
    () => assertResolutionCandidate({
      ...resolutionCandidate(),
      events: [{ ...resolutionCandidate().events[0], hidden: true }, ...resolutionCandidate().events.slice(1)]
    }),
    expectCode('SCHEMA_VIOLATION')
  );
  const forgedEffect = resolutionCandidate();
  forgedEffect.effects[0].effect_seq = 99;
  assert.throws(
    () => assertResolutionCandidate(forgedEffect),
    expectCode('SERVER_BOUND_EFFECT_FIELD')
  );
  const forgedReducer = resolutionCandidate();
  forgedReducer.effects[0].required_reducer = 'apply_anything';
  assert.throws(
    () => assertResolutionCandidate(forgedReducer),
    expectCode('SERVER_BOUND_EFFECT_FIELD')
  );
});

test('conflict and outcome values are closed enums', () => {
  const badConflict = resolutionCandidate();
  badConflict.conflicts[0].type = 'who_submitted_first';
  assert.throws(() => assertResolutionCandidate(badConflict), expectCode('SCHEMA_VIOLATION'));

  const badOutcome = resolutionCandidate();
  badOutcome.outcomes[0].status = 'automatic_victory';
  assert.throws(() => assertResolutionCandidate(badOutcome), expectCode('SCHEMA_VIOLATION'));
});

test('resolution IDs are unique and all submission/event/effect references are closed', () => {
  const duplicateConflict = resolutionCandidate();
  duplicateConflict.conflicts.push(structuredClone(duplicateConflict.conflicts[0]));
  assert.throws(() => assertResolutionCandidate(duplicateConflict), expectCode('SCHEMA_VIOLATION'));

  const danglingOutcome = resolutionCandidate();
  danglingOutcome.outcomes[0].event_ids = ['event_missing'];
  assert.throws(() => assertResolutionCandidate(danglingOutcome), expectCode('SCHEMA_VIOLATION'));

  const danglingEvidence = resolutionCandidate();
  danglingEvidence.effects[0].evidence_event_ids.push('event_missing');
  assert.throws(() => assertResolutionCandidate(danglingEvidence), expectCode('SCHEMA_VIOLATION'));

  const wrongEffectOwner = resolutionCandidate();
  wrongEffectOwner.events.find(event => event.event_id === 'event_shared').effect_ids = [];
  wrongEffectOwner.events.find(event => event.event_id === 'event_a_private').effect_ids = [
    'effect_chakra_cost'
  ];
  assert.throws(() => assertResolutionCandidate(wrongEffectOwner), expectCode('SCHEMA_VIOLATION'));
});

test('server freezes turn context and consumes only its compiled effect DAG', () => {
  const candidate = resolutionCandidate();
  const compiled = compileCandidate(candidate);
  const frozen = freezeCanonicalResolution(candidate, resolutionBinding, compiled);

  assert.equal(frozen.schema, CANONICAL_RESOLUTION_SCHEMA);
  assert.equal(frozen.turn_id, resolutionBinding.turn_id);
  assert.equal(frozen.base_state_revision, 42);
  assert.equal(frozen.input_hash, resolutionBinding.input_hash);
  assert.equal(frozen.effects[0].effect_seq, 1);
  assert.equal(frozen.effects[0].required_reducer, 'apply_actor_resource_effect');
  assert.match(frozen.effects[0].effect_hash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.effects[0].payload));
  assert.deepEqual(assertCanonicalResolution(frozen), frozen);

  const wrongSubmissions = {
    ...resolutionBinding,
    submission_ids: ['action_A', 'action_C']
  };
  assert.throws(
    () => freezeCanonicalResolution(candidate, wrongSubmissions, compiled),
    expectCode('SCHEMA_VIOLATION')
  );

  const changedCompiled = structuredClone(compiled);
  changedCompiled.effects[0].payload.amount = 999;
  assert.throws(
    () => freezeCanonicalResolution(candidate, resolutionBinding, changedCompiled),
    expectCode('SCHEMA_VIOLATION')
  );
});

test('narrative candidate contains only segments/stop point and rejects machine channels', () => {
  assert.deepEqual(assertNarrativeCandidate(sharedCandidate()), sharedCandidate());
  assert.throws(
    () => assertNarrativeCandidate({ ...sharedCandidate(), audience: 'shared' }),
    expectCode('SCHEMA_VIOLATION')
  );
  const extraClaimField = sharedCandidate();
  extraClaimField.segments[0].claims[0].confidence = 1;
  assert.throws(() => assertNarrativeCandidate(extraClaimField), expectCode('SCHEMA_VIOLATION'));

  assert.throws(
    () => assertNarrativeCandidate(sharedCandidate('<memory>{"forged":true}</memory>')),
    expectCode('SCHEMA_VIOLATION')
  );
  assert.throws(
    () => assertNarrativeCandidate(sharedCandidate('请显示 event_shared 的内部记录。')),
    expectCode('SCHEMA_VIOLATION')
  );
});

test('server binds NarrativeDelivery metadata and validates audience reference closure', () => {
  const resolution = canonicalResolution();
  const delivery = bind(seatACandidate(), 'seat:A', resolution);
  assert.equal(delivery.schema, NARRATIVE_DELIVERY_SCHEMA);
  assert.equal(delivery.turn_id, resolution.turn_id);
  assert.equal(delivery.audience, 'seat:A');
  assert.equal(delivery.resolution_commitment, resolutionCommitment);
  assert.ok(Object.isFrozen(delivery));

  const hiddenReference = seatACandidate();
  hiddenReference.segments[1] = seatBCandidate().segments[1];
  hiddenReference.stop_point_ref = 'event_b_private';
  assert.throws(
    () => bind(hiddenReference, 'seat:A', resolution),
    expectCode('SCHEMA_VIOLATION')
  );

  const missingVisibleEvent = seatACandidate();
  missingVisibleEvent.segments.shift();
  assert.throws(
    () => bind(missingVisibleEvent, 'seat:A', resolution),
    expectCode('SCHEMA_VIOLATION')
  );

  const duplicateReference = seatACandidate();
  duplicateReference.segments[1].event_refs = ['event_shared', 'event_a_private'];
  duplicateReference.segments[1].claims.unshift(
    claim('event_shared', 'entrance_sealed', true)
  );
  assert.throws(
    () => bind(duplicateReference, 'seat:A', resolution),
    expectCode('SCHEMA_VIOLATION')
  );
});

test('claims must reference and cover their own segment event_refs', () => {
  const resolution = canonicalResolution();
  const danglingClaim = sharedCandidate();
  danglingClaim.segments[0].claims[0].event_id = 'event_a_private';
  assert.throws(() => bind(danglingClaim, 'shared', resolution), expectCode('SCHEMA_VIOLATION'));

  const uncoveredRef = seatACandidate();
  uncoveredRef.segments[1].event_refs.unshift('event_shared');
  assert.throws(() => assertNarrativeCandidate(uncoveredRef), expectCode('SCHEMA_VIOLATION'));
});

test('shared has exactly one delivery and dual_pov has exactly the A/B pair', () => {
  const resolution = canonicalResolution();
  const shared = bind(sharedCandidate(), 'shared', resolution);
  const seatA = bind(seatACandidate(), 'seat:A', resolution);
  const seatB = bind(seatBCandidate(), 'seat:B', resolution);
  const sharedContext = {
    narrative_mode: 'shared',
    canonical_resolution: resolution,
    resolution_commitment: resolutionCommitment
  };
  const dualContext = { ...sharedContext, narrative_mode: 'dual_pov' };

  assert.deepEqual(assertNarrativeDeliverySet([shared], sharedContext), [shared]);
  assert.deepEqual(assertNarrativeDeliverySet([seatB, seatA], dualContext), [seatA, seatB]);
  assert.throws(
    () => assertNarrativeDeliverySet([shared, shared], sharedContext),
    expectCode('SCHEMA_VIOLATION')
  );
  assert.throws(
    () => assertNarrativeDeliverySet([seatA, seatA], dualContext),
    expectCode('SCHEMA_VIOLATION')
  );
  assert.throws(
    () => assertNarrativeDeliverySet([seatA], dualContext),
    expectCode('SCHEMA_VIOLATION')
  );
});

test('natural-language grounding is represented only by bound review receipts', () => {
  const resolution = canonicalResolution();
  // The hard contract deliberately does not pretend it can infer prose truth.
  const semanticallySuspect = bind(
    seatACandidate('他忽然宣称自己获得了尚未裁定的新力量。'),
    'seat:A',
    resolution
  );
  const rejected = createNarrativeGroundingReviewReceipt(semanticallySuspect, {
    review_id: 'review_semantic_rejection',
    reviewer_run_id: 'reviewer_run_joint_grounding',
    status: 'REJECTED',
    findings: ['UNRESOLVED_FACT_ADDED']
  });
  const seatB = bind(seatBCandidate(), 'seat:B', resolution);
  assert.throws(
    () => assertGroundedNarrativeDeliverySet(
      [semanticallySuspect, seatB],
      [rejected, review(seatB)],
      {
        narrative_mode: 'dual_pov',
        canonical_resolution: resolution,
        resolution_commitment: resolutionCommitment
      }
    ),
    expectCode('SCHEMA_VIOLATION')
  );

  const seatA = bind(seatACandidate(), 'seat:A', resolution);
  const grounded = assertGroundedNarrativeDeliverySet(
    [seatB, seatA],
    [review(seatA), review(seatB)],
    {
      narrative_mode: 'dual_pov',
      canonical_resolution: resolution,
      resolution_commitment: resolutionCommitment
    }
  );
  assert.deepEqual(grounded.deliveries, [seatA, seatB]);
  assert.deepEqual(grounded.grounding_review_receipts.map(item => item.status), [
    'APPROVED',
    'APPROVED'
  ]);

  const rewrittenSeatA = bind(
    seatACandidate('少年换了一种表述，但不改变结构化事实。'),
    'seat:A',
    resolution
  );
  assert.throws(
    () => assertGroundedNarrativeDeliverySet(
      [rewrittenSeatA, seatB],
      [review(seatA), review(seatB)],
      {
        narrative_mode: 'dual_pov',
        canonical_resolution: resolution,
        resolution_commitment: resolutionCommitment
      }
    ),
    expectCode('SCHEMA_VIOLATION')
  );
});

console.log(`\n${passed} multiplayer resolution/narrative contract regression tests passed.`);
