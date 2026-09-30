import assert from 'node:assert/strict';

import {
  CONFIRMED_MULTIPLAYER_INVARIANTS,
  CONTINUITY_TRANSPORTS,
  MULTIPLAYER_UI_DEFAULTS,
  NARRATIVE_MODES,
  PRE_RESOLUTION_VISIBILITIES,
  ROOM_LIFECYCLES,
  ROOM_ORIGIN_TYPES,
  ROOM_SEATS,
  TURN_DRAFT_STATUSES,
  TURN_STATUSES
} from '../server/multiplayer/contracts/enums.js';
import {
  assertArray,
  assertExactKeys,
  assertIdentifier,
  immutableContractValue,
  inspectContract
} from '../server/multiplayer/contracts/common.js';
import { DomainError } from '../server/multiplayer/domain/errors.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test('section 28.1 confirmed product values are executable constants', () => {
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.max_players, 2);
  assert.deepEqual(ROOM_SEATS, ['A', 'B']);
  assert.deepEqual(ROOM_ORIGIN_TYPES, ['existing_save_derived', 'new_multiplayer_save']);
  assert.deepEqual(NARRATIVE_MODES, ['shared', 'dual_pov']);
  assert.deepEqual(PRE_RESOLUTION_VISIBILITIES, ['open', 'sealed']);
  assert.deepEqual(CONTINUITY_TRANSPORTS, ['native_tools', 'json_protocol']);
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.post_commit_disclosure, 'full_after_commit');
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.receipt_order_story_effect, 'none');
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.action_timeout, null);
  assert.equal(
    CONFIRMED_MULTIPLAYER_INVARIANTS.credential_usage_policy,
    'mutually_confirmed_a_only_b_only_or_alternate'
  );
  assert.equal(
    CONFIRMED_MULTIPLAYER_INVARIANTS.alternate_credential_first_payer,
    'A_on_odd_turns_B_on_even_turns'
  );
  assert.equal(
    CONFIRMED_MULTIPLAYER_INVARIANTS.shared_stage_payer_inheritance,
    'policy_derived_never_previous_turn_fallback'
  );
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.frontend_instruction_parsing, 'forbidden');
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.deployment_topology, 'single_instance');
  assert.equal(CONFIRMED_MULTIPLAYER_INVARIANTS.database_backend, 'sqlite_wal');
  assert.equal(Object.isFrozen(CONFIRMED_MULTIPLAYER_INVARIANTS), true);
});

test('UI defaults remain separate from permission-bearing invariants', () => {
  assert.deepEqual(MULTIPLAYER_UI_DEFAULTS, {
    narrative_mode_default: 'shared',
    pre_resolution_visibility_default: 'sealed',
    narration_preference_default: 'full'
  });
  assert.equal('narrative_mode_default' in CONFIRMED_MULTIPLAYER_INVARIANTS, false);
});

test('room lifecycle, turn status and draft status are distinct contracts', () => {
  assert.deepEqual(ROOM_LIFECYCLES, ['LOBBY', 'READY', 'ACTIVE', 'ARCHIVED']);
  assert.ok(TURN_STATUSES.includes('REPAIRING_DRAFT'));
  assert.ok(TURN_STATUSES.includes('COMMITTED'));
  assert.deepEqual(TURN_DRAFT_STATUSES, ['OPEN', 'REVIEW_REQUIRED', 'READY', 'DISCARDED']);
  assert.equal(TURN_STATUSES.includes('OPEN'), false);
  assert.equal(ROOM_LIFECYCLES.includes('COMMITTED'), false);
});

test('common strict-object helpers reject unknown, inherited and malformed values', () => {
  const contract = value => {
    assertExactKeys(value, {
      allowed: ['actor_id', 'tags'],
      required: ['actor_id', 'tags'],
      path: '/',
      label: 'probe'
    });
    assertIdentifier(value.actor_id, { path: '/actor_id', prefix: 'actor:' });
    assertArray(value.tags, {
      path: '/tags', max: 4,
      item: (item, path) => assertIdentifier(item, { path }),
      uniqueBy: item => item
    });
    return immutableContractValue(value);
  };

  const valid = inspectContract({ actor_id: 'actor:A', tags: ['tag_one'] }, contract);
  assert.equal(valid.valid, true);
  assert.equal(Object.isFrozen(valid.value.tags), true);
  const unknown = inspectContract({ actor_id: 'actor:A', tags: [], seat: 'A' }, contract);
  assert.equal(unknown.valid, false);
  assert.equal(unknown.errors[0].path, '/seat');
  assert.throws(
    () => contract(JSON.parse('{"actor_id":"actor:A","tags":[],"__proto__":{}}')),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
  assert.throws(
    () => contract({ actor_id: 'not-prefixed', tags: [] }),
    error => error instanceof DomainError && error.code === 'SCHEMA_VIOLATION'
  );
});

console.log(`${passed} multiplayer invariant regression tests passed.`);
