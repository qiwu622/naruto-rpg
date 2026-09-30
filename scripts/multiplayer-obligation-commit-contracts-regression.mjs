import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';

import * as commitContracts from '../server/multiplayer/contracts/commit-contracts.js';
import {
  COMMIT_PRECONDITION_SET_JSON_SCHEMA,
  COMMIT_PRECONDITION_SET_SCHEMA,
  assertCommitPreconditionSet,
  inspectCommitPreconditionSet
} from '../server/multiplayer/contracts/commit-contracts.js';
import {
  UPDATE_OBLIGATIONS_JSON_SCHEMA,
  UPDATE_OBLIGATIONS_SCHEMA,
  UPDATE_OBLIGATION_DOMAINS,
  assertUpdateObligations,
  inspectUpdateObligations
} from '../server/multiplayer/contracts/obligation-contracts.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function expectSchemaViolation(path = null) {
  return error => error?.code === 'SCHEMA_VIOLATION'
    && (path === null || error?.details?.path === path);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha(character) {
  return `sha256:${character.repeat(64)}`;
}

function hmac(character) {
  return `hmac-sha256:${character.repeat(64)}`;
}

function effect(effectId, sequence, character, dependencies = []) {
  return {
    effect_id: effectId,
    effect_seq: sequence,
    effect_hash: sha(character),
    depends_on_effect_ids: dependencies
  };
}

function sharedObligations() {
  return {
    schema: UPDATE_OBLIGATIONS_SCHEMA,
    turn_id: 'turn_contract_42',
    resolution_hash: sha('a'),
    narrative_mode: 'shared',
    effect_obligations: [
      effect('effect_cost_A', 1, 'b'),
      effect('effect_damage_B', 2, 'c', ['effect_cost_A'])
    ],
    domain_obligations: UPDATE_OBLIGATION_DOMAINS.map((domain, index) => ({
      obligation_id: `obligation_domain_${domain}_42`,
      domain,
      scope_refs: domain === 'relationships'
        ? ['npc:npc_123', 'actor:B', 'actor:A']
        : [`scope:${domain}`],
      satisfied_by_effect_ids: index === 1
        ? ['effect_damage_B', 'effect_cost_A']
        : []
    })),
    artifact_obligations: [{
      obligation_id: 'obligation_memory_canonical_42',
      kind: 'memory',
      target_binding: 'server_bound',
      source_projection_hash: sha('d')
    }, {
      obligation_id: 'obligation_memory_shared_42',
      kind: 'memory',
      target_binding: 'shared',
      source_projection_hash: sha('e')
    }, {
      obligation_id: 'obligation_memory_actor_A_42',
      kind: 'memory',
      target_binding: 'actor:A',
      source_projection_hash: sha('f')
    }, {
      obligation_id: 'obligation_memory_npc_123_42',
      kind: 'memory',
      target_binding: 'npc:npc_123:private',
      source_projection_hash: sha('0')
    }, {
      obligation_id: 'obligation_daily_42',
      kind: 'shinobi_daily',
      target_binding: 'world_public',
      source_projection_hash: sha('1')
    }],
    narrative_obligations: [{
      obligation_id: 'obligation_narrative_shared_42',
      audience: 'shared',
      source_projection_hash: sha('2')
    }]
  };
}

function dualObligations() {
  const value = sharedObligations();
  value.narrative_mode = 'dual_pov';
  value.narrative_obligations = [{
    obligation_id: 'obligation_narrative_B_42',
    audience: 'seat:B',
    source_projection_hash: sha('3')
  }, {
    obligation_id: 'obligation_narrative_A_42',
    audience: 'seat:A',
    source_projection_hash: sha('4')
  }];
  return value;
}

function commitPreconditions() {
  return {
    schema: COMMIT_PRECONDITION_SET_SCHEMA,
    identity: {
      room_id: 'room_contract_1',
      epoch_id: 'epoch_contract_1',
      turn_id: 'turn_contract_42',
      run_id: 'run_contract_42',
      draft_id: 'draft_contract_42',
      commit_id: 'commit_contract_42'
    },
    lifecycle: {
      room_lifecycle: 'ACTIVE',
      epoch_state: 'ACTIVE',
      turn_status: 'COMMITTING',
      current_turn_id: 'turn_contract_42',
      void_requested: false
    },
    concurrency: {
      base_state_revision: 42,
      base_state_hash: sha('5'),
      lease_fence: 7,
      draft_revision: 19,
      draft_status: 'READY'
    },
    frozen_inputs: {
      input_hash: hmac('6'),
      resolution_hash: sha('7'),
      obligation_set_hash: sha('8'),
      execution_plan_hash: sha('9')
    },
    billing: {
      billing_provenance_hash: sha('a')
    },
    result: {
      candidate_state_hash: sha('b'),
      artifact_bundle_hash: sha('c'),
      narrative_bundle_hash: sha('d'),
      semantic_draft_hash: sha('e'),
      commit_envelope_hash: sha('f')
    }
  };
}

function assertFixedObjectsClosed(schema, path = '#') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  if (schema.type === 'object' && schema.properties) {
    assert.equal(
      schema.additionalProperties,
      false,
      `${path} must close fixed object properties`
    );
  }
  for (const [key, child] of Object.entries(schema)) {
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) {
        child.forEach((entry, index) => assertFixedObjectsClosed(entry, `${path}/${key}/${index}`));
      } else {
        assertFixedObjectsClosed(child, `${path}/${key}`);
      }
    }
  }
}

test('all fixed UpdateObligations and CommitPreconditionSet schema objects are closed', () => {
  assert.equal(UPDATE_OBLIGATIONS_JSON_SCHEMA.additionalProperties, false);
  assert.equal(COMMIT_PRECONDITION_SET_JSON_SCHEMA.additionalProperties, false);
  assertFixedObjectsClosed(UPDATE_OBLIGATIONS_JSON_SCHEMA);
  assertFixedObjectsClosed(COMMIT_PRECONDITION_SET_JSON_SCHEMA);
});

test('both draft 2020-12 schemas compile in strict mode', () => {
  const ajv = new Ajv2020({ strict: true });
  assert.equal(typeof ajv.compile(UPDATE_OBLIGATIONS_JSON_SCHEMA), 'function');
  assert.equal(typeof ajv.compile(COMMIT_PRECONDITION_SET_JSON_SCHEMA), 'function');
});

test('shared UpdateObligations normalizes stable sets and is immutable', () => {
  const normalized = assertUpdateObligations(sharedObligations());
  assert.equal(normalized.narrative_obligations.length, 1);
  assert.equal(normalized.narrative_obligations[0].audience, 'shared');
  assert.deepEqual(
    normalized.domain_obligations
      .find(item => item.domain === 'relationships').scope_refs,
    ['actor:A', 'actor:B', 'npc:npc_123']
  );
  assert.deepEqual(
    normalized.domain_obligations
      .find(item => item.domain === 'attributes').satisfied_by_effect_ids,
    ['effect_cost_A', 'effect_damage_B']
  );
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.effect_obligations[0]));
});

test('dual_pov requires exactly one A and one B narrative obligation', () => {
  const normalized = assertUpdateObligations(dualObligations());
  assert.deepEqual(
    normalized.narrative_obligations.map(item => item.audience),
    ['seat:A', 'seat:B']
  );

  const duplicateA = dualObligations();
  duplicateA.narrative_obligations[1].audience = 'seat:B';
  assert.throws(
    () => assertUpdateObligations(duplicateA),
    expectSchemaViolation('/narrative_obligations')
  );

  const extraShared = dualObligations();
  extraShared.narrative_obligations.push({
    obligation_id: 'obligation_narrative_shared_extra',
    audience: 'shared',
    source_projection_hash: sha('5')
  });
  assert.throws(
    () => assertUpdateObligations(extraShared),
    expectSchemaViolation('/narrative_obligations')
  );
});

test('effect dependencies and domain effect references must close over one unique effect set', () => {
  const danglingDependency = sharedObligations();
  danglingDependency.effect_obligations[1].depends_on_effect_ids = ['effect_unknown'];
  assert.throws(
    () => assertUpdateObligations(danglingDependency),
    expectSchemaViolation('/effect_obligations/1/depends_on_effect_ids/0')
  );

  const forwardDependency = sharedObligations();
  forwardDependency.effect_obligations[0].depends_on_effect_ids = ['effect_damage_B'];
  assert.throws(
    () => assertUpdateObligations(forwardDependency),
    expectSchemaViolation('/effect_obligations/0/depends_on_effect_ids/0')
  );

  const danglingDomain = sharedObligations();
  danglingDomain.domain_obligations[0].satisfied_by_effect_ids = ['effect_unknown'];
  assert.throws(
    () => assertUpdateObligations(danglingDomain),
    expectSchemaViolation('/domain_obligations/0/satisfied_by_effect_ids/0')
  );
});

test('effect identity and contiguous sequence are unique', () => {
  const duplicateId = sharedObligations();
  duplicateId.effect_obligations[1].effect_id = 'effect_cost_A';
  assert.throws(() => assertUpdateObligations(duplicateId), expectSchemaViolation());

  const duplicateSequence = sharedObligations();
  duplicateSequence.effect_obligations[1].effect_seq = 1;
  assert.throws(() => assertUpdateObligations(duplicateSequence), expectSchemaViolation());

  const gap = sharedObligations();
  gap.effect_obligations[1].effect_seq = 3;
  assert.throws(() => assertUpdateObligations(gap), expectSchemaViolation());
});

test('all fixed domains are required and one domain scope cannot be duplicated', () => {
  const missing = sharedObligations();
  missing.domain_obligations = missing.domain_obligations
    .filter(item => item.domain !== 'combat');
  missing.domain_obligations.push({
    obligation_id: 'obligation_domain_world_second',
    domain: 'world',
    scope_refs: ['scope:world:second'],
    satisfied_by_effect_ids: []
  });
  assert.throws(
    () => assertUpdateObligations(missing),
    error => expectSchemaViolation('/domain_obligations')(error)
      && error.details.missing_domain === 'combat'
  );

  const duplicateScope = sharedObligations();
  duplicateScope.domain_obligations.push({
    ...clone(duplicateScope.domain_obligations[0]),
    obligation_id: 'obligation_domain_world_duplicate'
  });
  assert.throws(() => assertUpdateObligations(duplicateScope), expectSchemaViolation());
});

test('artifact obligations require unique partitions, canonical memory and one public daily', () => {
  const wrongDailyBinding = sharedObligations();
  wrongDailyBinding.artifact_obligations.at(-1).target_binding = 'shared';
  assert.throws(() => assertUpdateObligations(wrongDailyBinding), expectSchemaViolation());

  const noCanonical = sharedObligations();
  noCanonical.artifact_obligations = noCanonical.artifact_obligations
    .filter(item => item.target_binding !== 'server_bound');
  assert.throws(
    () => assertUpdateObligations(noCanonical),
    expectSchemaViolation('/artifact_obligations')
  );

  const duplicateTarget = sharedObligations();
  duplicateTarget.artifact_obligations.push({
    obligation_id: 'obligation_memory_shared_duplicate',
    kind: 'memory',
    target_binding: 'shared',
    source_projection_hash: sha('6')
  });
  assert.throws(() => assertUpdateObligations(duplicateTarget), expectSchemaViolation());
});

test('non-state obligation IDs are globally unique and fixed objects reject unknown fields', () => {
  const duplicateId = sharedObligations();
  duplicateId.narrative_obligations[0].obligation_id =
    duplicateId.artifact_obligations[0].obligation_id;
  assert.throws(() => assertUpdateObligations(duplicateId), expectSchemaViolation());

  const unknownTop = sharedObligations();
  unknownTop.room_id = 'room_forged';
  assert.throws(
    () => assertUpdateObligations(unknownTop),
    expectSchemaViolation('/room_id')
  );

  const unknownItem = sharedObligations();
  unknownItem.effect_obligations[0].required_reducer = 'forged_reducer';
  assert.throws(
    () => assertUpdateObligations(unknownItem),
    expectSchemaViolation('/effect_obligations/0/required_reducer')
  );
});

test('UpdateObligations inspect reports a stable schema error without throwing', () => {
  const invalid = sharedObligations();
  invalid.resolution_hash = 'sha256:abbreviated';
  const inspected = inspectUpdateObligations(invalid);
  assert.equal(inspected.valid, false);
  assert.equal(inspected.value, null);
  assert.deepEqual(inspected.errors.map(error => error.path), ['/resolution_hash']);
});

test('complete CommitPreconditionSet accepts every section 13.9 field and freezes it', () => {
  const normalized = assertCommitPreconditionSet(commitPreconditions());
  assert.equal(normalized.lifecycle.turn_status, 'COMMITTING');
  assert.equal(normalized.lifecycle.void_requested, false);
  assert.equal(normalized.concurrency.draft_status, 'READY');
  assert.equal(normalized.concurrency.lease_fence, 7);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.result));
});

test('CommitPreconditionSet rejects every missing top-level group and named field', () => {
  const complete = commitPreconditions();
  for (const topKey of [
    'identity',
    'lifecycle',
    'concurrency',
    'frozen_inputs',
    'billing',
    'result'
  ]) {
    const missing = clone(complete);
    delete missing[topKey];
    assert.throws(
      () => assertCommitPreconditionSet(missing),
      expectSchemaViolation(`/${topKey}`),
      `missing ${topKey} must fail`
    );
  }

  const groups = {
    identity: ['room_id', 'epoch_id', 'turn_id', 'run_id', 'draft_id', 'commit_id'],
    lifecycle: [
      'room_lifecycle',
      'epoch_state',
      'turn_status',
      'current_turn_id',
      'void_requested'
    ],
    concurrency: [
      'base_state_revision',
      'base_state_hash',
      'lease_fence',
      'draft_revision',
      'draft_status'
    ],
    frozen_inputs: [
      'input_hash',
      'resolution_hash',
      'obligation_set_hash',
      'execution_plan_hash'
    ],
    billing: ['billing_provenance_hash'],
    result: [
      'candidate_state_hash',
      'artifact_bundle_hash',
      'narrative_bundle_hash',
      'semantic_draft_hash',
      'commit_envelope_hash'
    ]
  };
  for (const [group, fields] of Object.entries(groups)) {
    for (const field of fields) {
      const missing = clone(complete);
      delete missing[group][field];
      assert.throws(
        () => assertCommitPreconditionSet(missing),
        expectSchemaViolation(`/${group}/${field}`),
        `missing ${group}.${field} must fail`
      );
    }
  }
});

test('CommitPreconditionSet lifecycle, current turn, fence and READY gates cannot be weakened', () => {
  for (const [group, field, value, path] of [
    ['lifecycle', 'room_lifecycle', 'ARCHIVED', '/lifecycle/room_lifecycle'],
    ['lifecycle', 'epoch_state', 'ARCHIVED', '/lifecycle/epoch_state'],
    ['lifecycle', 'turn_status', 'AUDITING', '/lifecycle/turn_status'],
    ['lifecycle', 'current_turn_id', 'turn_other', '/lifecycle/current_turn_id'],
    ['lifecycle', 'void_requested', true, '/lifecycle/void_requested'],
    ['concurrency', 'lease_fence', 0, '/concurrency/lease_fence'],
    ['concurrency', 'draft_status', 'OPEN', '/concurrency/draft_status']
  ]) {
    const invalid = commitPreconditions();
    invalid[group][field] = value;
    assert.throws(
      () => assertCommitPreconditionSet(invalid),
      expectSchemaViolation(path),
      `${group}.${field} must be fixed`
    );
  }
});

test('CommitPreconditionSet rejects shortened digests, partial flat parameters and unknown fields', () => {
  const shortened = commitPreconditions();
  shortened.billing.billing_provenance_hash = 'sha256:billing';
  assert.throws(
    () => assertCommitPreconditionSet(shortened),
    expectSchemaViolation('/billing/billing_provenance_hash')
  );

  assert.throws(
    () => assertCommitPreconditionSet({
      schema: COMMIT_PRECONDITION_SET_SCHEMA,
      turn_id: 'turn_contract_42',
      commit_id: 'commit_contract_42'
    }),
    expectSchemaViolation('/turn_id')
  );

  const unknown = commitPreconditions();
  unknown.control_revision = 99;
  assert.throws(
    () => assertCommitPreconditionSet(unknown),
    expectSchemaViolation('/control_revision')
  );
});

test('CommitPreconditionSet exposes no partial assertion API and inspect is fail-closed', () => {
  const partialExports = Object.keys(commitContracts)
    .filter(name => /Partial|IdentityOnly|HashOnly|Reduced/u.test(name));
  assert.deepEqual(partialExports, []);

  const invalid = commitPreconditions();
  invalid.frozen_inputs.obligation_set_hash = null;
  const inspected = inspectCommitPreconditionSet(invalid);
  assert.equal(inspected.valid, false);
  assert.equal(inspected.value, null);
  assert.deepEqual(
    inspected.errors.map(error => error.path),
    ['/frozen_inputs/obligation_set_hash']
  );
});

console.log(`\n${passed} multiplayer obligation/commit contract regression tests passed.`);
