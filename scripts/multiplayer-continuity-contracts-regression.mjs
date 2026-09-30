import assert from 'node:assert/strict';

import { SHINOBI_DAILY_EXAMPLE } from '../js/core/shinobi-daily.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';
import {
  CONTINUITY_BUNDLE_RESULT_SCHEMA,
  TURN_BUNDLE_PATCH_JSON_SCHEMA,
  assertContinuityBundleResult,
  assertDomainCheckItem,
  assertMemoryArtifactItem,
  assertRepairPlan,
  assertShinobiDailyArtifactItem,
  assertTurnBundlePatch,
  createContinuityItemValidators,
  createContinuityToolContract
} from '../server/multiplayer/contracts/continuity-contracts.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const PUBLIC_REFS = new Set([
  'public:headline',
  ...Array.from({ length: 4 }, (_, index) => `public:world_${index}`),
  ...Array.from({ length: 3 }, (_, index) => `public:flavor_${index}`),
  ...Array.from({ length: 4 }, (_, index) => `public:mission_${index}`),
  'public:quote'
]);

function dailyItem() {
  return {
    obligation_id: 'obligation_daily_42',
    daily: structuredClone(SHINOBI_DAILY_EXAMPLE),
    source_refs: {
      headline: ['public:headline'],
      world: Array.from({ length: 4 }, (_, index) => [`public:world_${index}`]),
      flavor: Array.from({ length: 3 }, (_, index) => [`public:flavor_${index}`]),
      missions: Array.from({ length: 4 }, (_, index) => [`public:mission_${index}`]),
      quote: ['public:quote']
    }
  };
}

function memoryItem() {
  return {
    obligation_id: 'obligation_memory_actor_A',
    summary: 'A 记住本回合已经成立的事实。',
    entries: [{
      kind: 'fact',
      text: 'A 看见石门已经打开。',
      event_refs: ['event_visible_A'],
      subject_refs: ['actor:A', 'location:stone_door']
    }],
    supersede_entry_ids: [],
    retract_entry_ids: []
  };
}

test('outer TurnBundlePatch keeps partitions optional and rejects unknown envelope fields', () => {
  assert.deepEqual(assertTurnBundlePatch({ effect_ids: ['effect_cost_A'] }), {
    domain_checks: [],
    effect_ids: ['effect_cost_A'],
    memories: [],
    shinobi_daily: []
  });
  assert.equal(TURN_BUNDLE_PATCH_JSON_SCHEMA.additionalProperties, false);
  assert.throws(
    () => assertTurnBundlePatch({ effect_ids: [], room_id: 'room_forged' }),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
});

test('domain checks accept only a bound reason and audience-safe evidence', () => {
  const item = {
    obligation_id: 'obligation_domain_relationships_42',
    reason_code: 'NO_CANONICAL_CHANGE',
    evidence_event_ids: ['event_visible_A']
  };
  assert.deepEqual(assertDomainCheckItem(item, {
    expectedObligationId: item.obligation_id,
    allowedEvidenceEventIds: ['event_visible_A']
  }), item);
  assert.throws(
    () => assertDomainCheckItem({ ...item, reason_code: '其余不变' }),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
  assert.throws(
    () => assertDomainCheckItem(item, { allowedEvidenceEventIds: ['event_other'] }),
    error => error instanceof DomainError && error.code === 'AUDIENCE_VIOLATION'
  );
});

test('memory items are strict, audience-bound and cannot route themselves', () => {
  const item = memoryItem();
  const normalized = assertMemoryArtifactItem(item, {
    expectedObligationId: item.obligation_id,
    audienceEventIds: ['event_visible_A'],
    stableSubjectIds: ['actor:A', 'location:stone_door'],
    modifiableEntryIds: []
  });
  assert.deepEqual(normalized, item);
  assert.equal(Object.isFrozen(normalized.entries[0]), true);

  const leaked = structuredClone(item);
  leaked.entries[0].event_refs = ['event_private_B'];
  assert.throws(
    () => assertMemoryArtifactItem(leaked, {
      audienceEventIds: ['event_visible_A'],
      stableSubjectIds: ['actor:A', 'location:stone_door']
    }),
    error => error instanceof DomainError && error.code === 'AUDIENCE_VIOLATION'
  );

  assert.throws(
    () => assertMemoryArtifactItem({ ...item, audience: 'actor:B' }),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
});

test('invalid memory references return usable choices without widening the audience', () => {
  const item = memoryItem();
  item.entries[0].subject_refs = ['World', 'Konoha'];
  assert.throws(() => assertMemoryArtifactItem(item, {
    audienceEventIds: ['event_visible_A'], stableSubjectIds: ['actor:A']
  }), error => error.code === 'AUDIENCE_VIOLATION'
    && error.message.includes('Allowed subject_refs: actor:A')
    && !error.message.includes('event_private_B'));
  item.entries[0].subject_refs = ['actor:A'];
  item.entries[0].event_refs = ['event_private_B'];
  assert.throws(() => assertMemoryArtifactItem(item, {
    audienceEventIds: ['event_visible_A'], stableSubjectIds: ['actor:A']
  }), error => error.code === 'AUDIENCE_VIOLATION'
    && error.message.includes('Allowed event_refs: event_visible_A'));
});

test('daily artifact reuses the strict daily validator and grounds every slot publicly', () => {
  const item = dailyItem();
  const normalized = assertShinobiDailyArtifactItem(item, {
    expectedObligationId: item.obligation_id,
    worldPublicRefs: PUBLIC_REFS
  });
  assert.equal(normalized.daily.schema, 'naruto.shinobi-daily/v1');
  assert.equal(normalized.source_refs.world.length, 4);

  const privateSource = dailyItem();
  privateSource.source_refs.headline = ['public:shared_but_not_world_public'];
  assert.throws(
    () => assertShinobiDailyArtifactItem(privateSource, { worldPublicRefs: PUBLIC_REFS }),
    error => error instanceof DomainError && error.code === 'AUDIENCE_VIOLATION'
  );

  const missingSlot = dailyItem();
  missingSlot.source_refs.flavor.pop();
  assert.throws(
    () => assertShinobiDailyArtifactItem(missingSlot, { worldPublicRefs: PUBLIC_REFS }),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
});

test('daily repair reports nested quote, private sources and body format together', () => {
  const item = dailyItem();
  item.daily.world[0].source_refs = ['public:private_event'];
  item.source_refs.quote = [item.source_refs.quote];
  item.source_refs.world[1] = ['public:private_event'];
  item.source_refs.missions[2] = ['public:another_private_event'];
  assert.throws(() => assertShinobiDailyArtifactItem(item, { worldPublicRefs: PUBLIC_REFS }), error => {
    assert.equal(error.code, 'SCHEMA_VIOLATION');
    assert.match(error.message, /未定义字段 source_refs/u);
    assert.match(error.message, /source_refs\/quote.*一维字符串数组/u);
    assert.match(error.message, /source_refs\/world\/1/u);
    assert.match(error.message, /source_refs\/missions\/2/u);
    assert.match(error.message, /不得只换成无关引用/u);
    assert.ok(error.details.allowed_paths.includes('/daily'));
    assert.ok(error.details.allowed_paths.includes('/source_refs'));
    return true;
  });
});

test('runtime validator registry binds targets outside model-controlled items', () => {
  const validators = createContinuityItemValidators({
    byObligation: {
      obligation_memory_actor_A: {
        audienceEventIds: ['event_visible_A'],
        stableSubjectIds: ['actor:A', 'location:stone_door'],
        modifiableEntryIds: []
      },
      obligation_daily_42: { worldPublicRefs: [...PUBLIC_REFS] }
    }
  });
  assert.deepEqual(
    validators.memory(memoryItem(), { obligation_id: 'obligation_memory_actor_A' }),
    memoryItem()
  );
  assert.equal(
    validators.shinobi_daily(dailyItem(), { obligation_id: 'obligation_daily_42' }).daily.schema,
    'naruto.shinobi-daily/v1'
  );
});

test('RepairPlan and provider-neutral tool registration expose only allowed repair scope', () => {
  const plan = {
    schema: 'naruto.continuity-repair-plan/v1',
    draft_revision: 8,
    reviewed_semantic_draft_hash: `sha256:${'a'.repeat(64)}`,
    allowed_effect_ids: ['effect_damage_B'],
    allowed_obligation_ids: ['obligation_memory_actor_A'],
    allowed_paths: [{
      kind: 'memory',
      id: 'obligation_memory_actor_A',
      json_pointers: ['/entries/0/event_refs']
    }]
  };
  assert.deepEqual(assertRepairPlan(plan), plan);
  const tool = createContinuityToolContract('repair_turn_bundle');
  assert.equal(tool.name, 'repair_turn_bundle');
  assert.equal(tool.input_schema.additionalProperties, false);
  assert.equal(tool.referenced_schemas.length, 3);
  assert.throws(
    () => assertRepairPlan({
      ...plan,
      allowed_paths: [{ kind: 'memory', id: 'obligation_daily_42', json_pointers: ['/'] }]
    }),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
  assert.throws(
    () => createContinuityToolContract('review_staged_turn_internal'),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
});

test('ContinuityBundleResult enforces discriminated READY and repair branches', () => {
  const base = {
    schema: CONTINUITY_BUNDLE_RESULT_SCHEMA,
    status: 'READY',
    draft_revision: 4,
    retryable_by: 'none',
    pause_reason: null,
    turn_state: 'COMMITTING',
    resume_stage: null,
    accepted: [],
    idempotent: [],
    errors: [],
    review: {},
    next_operation: null,
    allowed_effect_ids: [],
    allowed_obligation_ids: [],
    allowed_paths: [],
    ready_receipt: { receipt_id: 'receipt_ready_1' }
  };
  assert.equal(assertContinuityBundleResult(base).status, 'READY');
  assert.throws(
    () => assertContinuityBundleResult({
      ...base,
      status: 'REPAIR_REQUIRED',
      retryable_by: 'continuity',
      ready_receipt: null
    }),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
  assert.throws(
    () => assertContinuityBundleResult({ ...base, database_row_id: 17 }),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
});

console.log(`${passed} multiplayer continuity contract regression tests passed.`);
