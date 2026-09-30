import assert from 'node:assert/strict';

import { buildStagePlansFromSelections } from '../server/multiplayer/application/billing-plan-service.js';

let passed = 0;
function test(name, operation) {
  operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const HASH = `sha256:${'a'.repeat(64)}`;
function selection(
  scope,
  audience,
  payer,
  seat,
  transport = 'json_protocol',
  selectedNarrativeMode = scope === 'writer' ? 'dual_pov' : 'shared'
) {
  return {
    scope,
    audience,
    selected_narrative_mode: selectedNarrativeMode,
    payer_user_id: payer,
    payer_seat_id: seat,
    profile_owner_user_id: payer,
    profile_id: `profile_${seat}`,
    profile_revision: 1,
    credential_id: null,
    credential_revision: null,
    normalized_origin: `https://${seat.toLowerCase()}.example.com`,
    config_fingerprint: HASH,
    probe_id: `probe_${seat}`,
    probe_revision: 1,
    probe_result_json: JSON.stringify({ capabilities: {
      strict_json: true,
      native_tools: false,
      error_correction_continuation: true
    } }),
    probe_hash: HASH,
    recommended_transport: transport,
    probe_status: 'SUCCEEDED'
  };
}

test('shared plan contains one Writer and binds both consent subjects', () => {
  const plans = buildStagePlansFromSelections({
    turn: { turn_id: 'turn_1', narrative_mode: 'shared' },
    selectionRows: [selection('shared', 'shared', 'user_A', 'A')],
    membersBySeat: { A: 'user_A', B: 'user_B' }
  });
  assert.equal(plans.filter(item => item.stage === 'writer').length, 1);
  assert.deepEqual(plans[0].required_consent_subject_user_ids, ['user_A', 'user_B']);
  assert.equal(plans.find(item => item.stage === 'continuity_steward').transport, 'json_protocol');
  assert.ok(plans.every(item => item.capability_probe_ref === null));
  assert.ok(plans.every(item => item.transport === 'json_protocol'));
  assert.equal(plans.find(item => item.stage === 'referee').budget.max_requests, 9);
  assert.equal(plans.find(item => item.stage === 'referee').budget.max_retries, 8);
  assert.equal(plans.find(item => item.stage === 'writer').budget.max_requests, 4);
  assert.equal(
    plans.find(item => item.stage === 'narrative_grounding_reviewer').budget.max_requests,
    12
  );
});

test('dual POV adds the sponsor endpoint owner without expanding a self-paid Writer', () => {
  const plans = buildStagePlansFromSelections({
    turn: { turn_id: 'turn_2', narrative_mode: 'dual_pov' },
    selectionRows: [
      selection('shared', 'shared', 'user_A', 'A'),
      selection('writer', 'A', 'user_A', 'A'),
      selection('writer', 'B', 'user_A', 'A')
    ],
    membersBySeat: { A: 'user_A', B: 'user_B' }
  });
  const writerA = plans.find(item => item.stage === 'writer' && item.audience === 'A');
  const writerB = plans.find(item => item.stage === 'writer' && item.audience === 'B');
  assert.deepEqual(writerA.required_consent_subject_user_ids, ['user_A']);
  assert.deepEqual(writerB.required_consent_subject_user_ids, ['user_A', 'user_B']);
  assert.equal(writerA.payer_seat, 'A');
  assert.equal(writerB.payer_seat, 'A');
  assert.equal(writerA.profile_ref.owner_user_id, 'user_A');
  assert.equal(writerB.profile_ref.owner_user_id, writerB.payer_user_id);
});

test('dual-POV shared selection cannot silently expand to authorize a shared Writer', () => {
  assert.throws(() => buildStagePlansFromSelections({
    turn: { turn_id: 'turn_mode_switch', narrative_mode: 'shared' },
    selectionRows: [
      selection('shared', 'shared', 'user_A', 'A', 'json_protocol', 'dual_pov')
    ],
    membersBySeat: { A: 'user_A', B: 'user_B' }
  }), error => error?.code === 'PAYER_SELECTION_MODE_MISMATCH');
});

test('missing capability probe is accepted and formal stages use JSON protocol', () => {
  const selected = selection('shared', 'shared', 'user_A', 'A', null);
  delete selected.probe_revision;
  delete selected.probe_hash;
  delete selected.probe_result_json;
  delete selected.probe_status;
  const plans = buildStagePlansFromSelections({
    turn: { turn_id: 'turn_3', narrative_mode: 'shared' },
    selectionRows: [selected],
    membersBySeat: { A: 'user_A', B: 'user_B' }
  });
  assert.ok(plans.every(item => item.capability_probe_ref === null));
  assert.ok(plans.every(item => item.transport === 'json_protocol'));
});

console.log(`multiplayer billing plan service regression: ${passed} passed`);
