import assert from 'node:assert/strict';

import {
  COMPILED_EFFECT_DAG_SCHEMA,
  compileEffectDag,
  topologicalSortEffectIds,
  topologicalSortEffects
} from '../server/multiplayer/domain/effect-dag.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function expectCode(code) {
  return error => error?.code === code;
}

function effect(effectId, dependencies = [], overrides = {}) {
  const suffix = effectId.slice('effect_'.length);
  const eventId = overrides.event_id ?? `event_${suffix}`;
  return {
    effect_id: effectId,
    depends_on_effect_ids: dependencies,
    event_id: eventId,
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
      amount: 1,
      unit: 'points'
    },
    provenance: 'rules_engine',
    visibility: 'server_only',
    evidence_event_ids: [eventId],
    ...overrides
  };
}

function layeredDag() {
  return [
    effect('effect_d', ['effect_c', 'effect_b'], {
      domain: 'missions',
      kind: 'mission_transition',
      operation: 'advance',
      payload: { mission_id: 'mission:escort', from: 1, to: 2 }
    }),
    effect('effect_c', ['effect_a'], {
      domain: 'combat',
      kind: 'combat_state',
      operation: 'record_action',
      payload: { combat_id: 'combat:1', action: 'technique_resolved' }
    }),
    effect('effect_z', [], {
      domain: 'world',
      kind: 'calendar_delta',
      operation: 'advance',
      payload: { amount: 10, unit: 'seconds' }
    }),
    effect('effect_b', ['effect_a'], {
      domain: 'attributes',
      kind: 'resource_delta',
      operation: 'damage',
      payload: { resource: 'vitality', amount: 8, unit: 'points' },
      evidence_event_ids: ['event_shared_evidence', 'event_b'],
      rule_refs: ['rule:damage/v2', 'rule:resource-floor/v1']
    }),
    effect('effect_a', [], {
      summary: 'actor:A chakra -12',
      unit: 'points',
      payload: {
        resource: 'chakra',
        amount: 12,
        unit: 'points',
        // Payload schemas belong to each typed reducer. Top-level DAG
        // binding names must not cause valid future payload fields to vanish.
        effect_seq: 'domain-owned-field',
        future_domain_field: {
          required_reducer: 'semantic payload, not a routing instruction'
        }
      }
    })
  ];
}

const ruleSnapshot = {
  schema: 'naruto.multiplayer-rule-snapshot/v1',
  canon_revision: 'canon-2026-08-21',
  cost_table_revision: 7,
  domain_versions: {
    attributes: '3',
    combat: '2',
    missions: '4',
    world: '2'
  }
};

function reducerResolver(candidate) {
  const reducers = {
    attributes: 'apply_actor_resource_effect',
    combat: 'apply_combat_effect',
    missions: 'apply_mission_effect',
    world: 'advance_world_calendar'
  };
  return {
    required_reducer: reducers[candidate.domain],
    reducer_version: `reducer-${candidate.domain}/v1`
  };
}

test('layered Kahn sort is stable and orders each ready layer by effect_id', () => {
  const candidates = layeredDag();
  assert.deepEqual(topologicalSortEffectIds(candidates), [
    'effect_a',
    'effect_z',
    'effect_b',
    'effect_c',
    'effect_d'
  ]);

  const sorted = topologicalSortEffects(candidates);
  assert.deepEqual(sorted.map(item => item.effect_id), [
    'effect_a',
    'effect_z',
    'effect_b',
    'effect_c',
    'effect_d'
  ]);
  assert.deepEqual(sorted.at(-1).depends_on_effect_ids, ['effect_b', 'effect_c']);
  assert.ok(Object.isFrozen(sorted));
  assert.ok(Object.isFrozen(sorted[0].payload));
});

test('compile binds one reducer/version, 1-based sequence, and canonical hashes', () => {
  let resolverCalls = 0;
  const compiled = compileEffectDag(layeredDag(), {
    resolveReducer(candidate, snapshot) {
      resolverCalls += 1;
      assert.ok(Object.isFrozen(candidate));
      assert.ok(Object.isFrozen(candidate.payload));
      assert.ok(Object.isFrozen(snapshot));
      return reducerResolver(candidate);
    },
    ruleSnapshot
  });

  assert.equal(resolverCalls, 5);
  assert.equal(compiled.schema, COMPILED_EFFECT_DAG_SCHEMA);
  assert.match(compiled.rule_snapshot_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(compiled.effects.map(item => item.effect_seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(compiled.effects.map(item => item.effect_id), [
    'effect_a',
    'effect_z',
    'effect_b',
    'effect_c',
    'effect_d'
  ]);

  for (const compiledEffect of compiled.effects) {
    assert.match(compiledEffect.required_reducer, /^[a-z][a-z0-9_]+$/);
    assert.equal(compiledEffect.reducer_version, `reducer-${compiledEffect.domain}/v1`);
    assert.match(compiledEffect.effect_hash, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(compiled.effects[0].payload.effect_seq, 'domain-owned-field');
  assert.equal(
    compiled.effects[0].payload.future_domain_field.required_reducer,
    'semantic payload, not a routing instruction'
  );
});

test('effect, dependency, evidence, rule-ref, and object-key reorder is canonical', () => {
  const first = layeredDag();
  const reordered = structuredClone(first).reverse();
  for (const candidate of reordered) {
    candidate.depends_on_effect_ids.reverse();
    candidate.evidence_event_ids.reverse();
    if (candidate.rule_refs) candidate.rule_refs.reverse();
    candidate.target = {
      entity_id: candidate.target.entity_id,
      actor: candidate.target.actor,
      scope: candidate.target.scope
    };
    candidate.payload = Object.fromEntries(Object.entries(candidate.payload).reverse());
  }
  const reorderedRuleSnapshot = {
    domain_versions: {
      world: '2',
      missions: '4',
      combat: '2',
      attributes: '3'
    },
    cost_table_revision: 7,
    canon_revision: 'canon-2026-08-21',
    schema: 'naruto.multiplayer-rule-snapshot/v1'
  };

  const compiledFirst = compileEffectDag(first, {
    resolveReducer: reducerResolver,
    ruleSnapshot
  });
  const compiledReordered = compileEffectDag(reordered, {
    resolveReducer: reducerResolver,
    ruleSnapshot: reorderedRuleSnapshot
  });

  assert.deepEqual(compiledReordered, compiledFirst);
  assert.equal(JSON.stringify(compiledReordered), JSON.stringify(compiledFirst));
});

test('compile never mutates input and recursively freezes detached output', () => {
  const candidates = layeredDag();
  const rules = structuredClone(ruleSnapshot);
  const beforeCandidates = JSON.stringify(candidates);
  const beforeRules = JSON.stringify(rules);

  const compiled = compileEffectDag(candidates, {
    resolveReducer: reducerResolver,
    ruleSnapshot: rules
  });

  assert.equal(JSON.stringify(candidates), beforeCandidates);
  assert.equal(JSON.stringify(rules), beforeRules);
  assert.ok(Object.isFrozen(compiled));
  assert.ok(Object.isFrozen(compiled.effects));
  assert.ok(Object.isFrozen(compiled.effects[0]));
  assert.ok(Object.isFrozen(compiled.effects[0].payload));
  assert.throws(() => {
    compiled.effects[0].payload.amount = 999;
  }, TypeError);
  assert.equal(candidates.find(item => item.effect_id === 'effect_a').payload.amount, 12);
});

test('full rule snapshot and resolver version participate in every effect hash', () => {
  const baseline = compileEffectDag(layeredDag(), {
    resolveReducer: reducerResolver,
    ruleSnapshot
  });
  const changedRules = compileEffectDag(layeredDag(), {
    resolveReducer: reducerResolver,
    ruleSnapshot: { ...ruleSnapshot, cost_table_revision: 8 }
  });
  const changedReducer = compileEffectDag(layeredDag(), {
    resolveReducer(candidate) {
      const binding = reducerResolver(candidate);
      return { ...binding, reducer_version: `${binding.reducer_version}-hotfix` };
    },
    ruleSnapshot
  });

  assert.notEqual(changedRules.rule_snapshot_hash, baseline.rule_snapshot_hash);
  assert.deepEqual(
    changedRules.effects.map(item => item.effect_id),
    baseline.effects.map(item => item.effect_id)
  );
  for (let index = 0; index < baseline.effects.length; index += 1) {
    assert.notEqual(changedRules.effects[index].effect_hash, baseline.effects[index].effect_hash);
    assert.notEqual(changedReducer.effects[index].effect_hash, baseline.effects[index].effect_hash);
  }
});

test('model-supplied server bindings and unknown top-level fields are rejected before resolver use', () => {
  const forbidden = [
    'effect_seq',
    'effect_hash',
    'required_reducer',
    'reducer_version',
    'preconditions',
    'rule_snapshot_hash'
  ];

  for (const field of forbidden) {
    let resolverCalls = 0;
    const candidate = { ...effect('effect_one'), [field]: 'forged' };
    assert.throws(
      () => compileEffectDag([candidate], {
        resolveReducer(value) {
          resolverCalls += 1;
          return reducerResolver(value);
        },
        ruleSnapshot
      }),
      expectCode('SERVER_BOUND_EFFECT_FIELD'),
      field
    );
    assert.equal(resolverCalls, 0);
  }

  assert.throws(
    () => topologicalSortEffects([{ ...effect('effect_one'), arbitrary_path: '/actors/A/chakra' }]),
    expectCode('UNKNOWN_EFFECT_FIELD')
  );
});

test('duplicate IDs, duplicate/self/dangling dependencies, and cycles are rejected', () => {
  assert.throws(
    () => topologicalSortEffectIds([effect('effect_same'), effect('effect_same')]),
    expectCode('DUPLICATE_EFFECT_ID')
  );
  assert.throws(
    () => topologicalSortEffectIds([
      effect('effect_a'),
      effect('effect_b', ['effect_a', 'effect_a'])
    ]),
    expectCode('DUPLICATE_EFFECT_DEPENDENCY')
  );
  assert.throws(
    () => topologicalSortEffectIds([effect('effect_self', ['effect_self'])]),
    expectCode('SELF_EFFECT_DEPENDENCY')
  );
  assert.throws(
    () => topologicalSortEffectIds([effect('effect_a', ['effect_missing'])]),
    expectCode('DANGLING_EFFECT_DEPENDENCY')
  );
  assert.throws(
    () => topologicalSortEffectIds([
      effect('effect_a', ['effect_c']),
      effect('effect_b', ['effect_a']),
      effect('effect_c', ['effect_b'])
    ]),
    error => error?.code === 'EFFECT_DEPENDENCY_CYCLE'
      && assert.deepEqual(error.details.effect_ids, ['effect_a', 'effect_b', 'effect_c']) === undefined
  );
});

test('resolver must synchronously return exactly one valid reducer/version pair', () => {
  const candidates = [effect('effect_one')];
  assert.throws(
    () => compileEffectDag(candidates, {
      resolveReducer: () => undefined,
      ruleSnapshot
    }),
    expectCode('INVALID_REDUCER_BINDING')
  );
  assert.throws(
    () => compileEffectDag(candidates, {
      resolveReducer: () => ({
        required_reducer: 'apply_actor_resource_effect',
        reducer_version: 'v1',
        alternate_reducer: 'apply_anything'
      }),
      ruleSnapshot
    }),
    expectCode('INVALID_REDUCER_BINDING')
  );
  assert.throws(
    () => compileEffectDag(candidates, {
      resolveReducer: async () => reducerResolver(candidates[0]),
      ruleSnapshot
    }),
    expectCode('INVALID_REDUCER_RESOLVER')
  );
});

console.log(`\n${passed} multiplayer effect DAG regression tests passed.`);
