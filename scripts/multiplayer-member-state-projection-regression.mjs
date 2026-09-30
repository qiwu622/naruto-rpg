import assert from 'node:assert/strict';

import { createNewMultiplayerGenesisState } from '../server/multiplayer/application/genesis-state.js';
import { projectMemberRoomState } from '../server/multiplayer/domain/member-state-projector.js';

const state = structuredClone(createNewMultiplayerGenesisState({
  actor_ids: { A: 'actor:alpha', B: 'actor:bravo' }
}));
state.meta.state_revision = 7;
state.actors.A.player.goal = 'A_PRIVATE_GOAL';
state.actors.B.player.goal = 'B_PRIVATE_GOAL';
state.actors.A.skills.entries.push({ skill_id: 'skill:a_secret' });
state.actors.B.skills.entries.push({ skill_id: 'skill:b_secret' });
state.actors.A.equipment.entries.push({ item_id: 'item:a_secret' });
state.actors.B.equipment.entries.push({ item_id: 'item:b_secret' });
state.actors.A.private_knowledge.facts.push({ summary: 'A_PRIVATE_FACT' });
state.actors.B.private_knowledge.facts.push({ summary: 'B_PRIVATE_FACT' });
state.memories.canonical.entries.push({ memory_id: 'memory:canonical', text: 'CANONICAL_SECRET' });
state.memories.shared.entries.push({ memory_id: 'memory:shared', text: 'SHARED_FACT' });
state.memories['actor:A'].entries.push({ memory_id: 'memory:a', text: 'A_MEMORY' });
state.memories['actor:B'].entries.push({ memory_id: 'memory:b', text: 'B_MEMORY' });
state.memories.npc_private.entries.push({ memory_id: 'memory:npc', text: 'NPC_SECRET' });
state.shared_world.canonical_events.entries.push({
  event_id: 'event:secret',
  title: 'CANONICAL_EVENT_SECRET'
});
state.shared_world.world_state.npc_profiles.push({
  npc_id: 'npc:kakashi',
  display_name: '卡卡西',
  evidence_event_ids: ['event:hidden_npc_evidence']
});
state.agent_internal.story_plan = { next: 'AGENT_PLAN_SECRET' };
state.relationships.push(
  {
    edge_id: 'relationship:a:npc',
    source_actor_id: 'actor:alpha',
    target_actor_id: 'npc:kakashi',
    data: {
      trust: 3,
      note: 'A_RELATIONSHIP',
      evidence_event_ids: ['event:hidden_relationship_evidence']
    }
  },
  {
    edge_id: 'relationship:b:npc',
    source_actor_id: 'actor:bravo',
    target_actor_id: 'npc:kakashi',
    data: { trust: -2, note: 'B_RELATIONSHIP' }
  },
  {
    edge_id: 'relationship:npc:a',
    source_actor_id: 'npc:kakashi',
    target_actor_id: 'actor:alpha',
    data: { trust: 9, note: 'NPC_PRIVATE_RELATIONSHIP' }
  }
);

const projectionA = projectMemberRoomState(state, 'A');
assert.equal(projectionA.viewer_seat, 'A');
assert.equal(projectionA.state_revision, 7);
assert.deepEqual(projectionA.relationships.map(edge => edge.edge_id), ['relationship:a:npc']);
assert.deepEqual(projectionA.memories.shared.entries.map(item => item.text), ['SHARED_FACT']);
assert.deepEqual(projectionA.memories.personal.entries.map(item => item.text), ['A_MEMORY']);
assert.equal(projectionA.actors.A.skills.entries[0].skill_id, 'skill:a_secret');
assert.deepEqual(projectionA.actors.B.skills.entries, []);
assert.deepEqual(projectionA.actors.B.equipment.entries, []);
assert.equal('goal' in projectionA.actors.B.player, false);
assert.equal('canonical_events' in projectionA.shared_world, false);
assert.equal('continuity_ledger' in projectionA.shared_world, false);
assert.equal('agent_internal' in projectionA, false);
assert.equal(
  'evidence_event_ids' in projectionA.shared_world.world_state.npc_profiles[0],
  false
);
assert.equal('evidence_event_ids' in projectionA.relationships[0].data, false);

const serializedA = JSON.stringify(projectionA);
for (const forbidden of [
  'B_PRIVATE_GOAL',
  'skill:b_secret',
  'item:b_secret',
  'B_PRIVATE_FACT',
  'B_MEMORY',
  'CANONICAL_SECRET',
  'NPC_SECRET',
  'CANONICAL_EVENT_SECRET',
  'AGENT_PLAN_SECRET',
  'B_RELATIONSHIP',
  'NPC_PRIVATE_RELATIONSHIP',
  'event:hidden_npc_evidence',
  'event:hidden_relationship_evidence'
]) {
  assert.equal(serializedA.includes(forbidden), false, `seat A leaked ${forbidden}`);
}

const projectionB = projectMemberRoomState(state, 'B');
assert.deepEqual(projectionB.relationships.map(edge => edge.edge_id), ['relationship:b:npc']);
assert.deepEqual(projectionB.memories.personal.entries.map(item => item.text), ['B_MEMORY']);
assert.equal(projectionB.actors.B.skills.entries[0].skill_id, 'skill:b_secret');
assert.deepEqual(projectionB.actors.A.skills.entries, []);
assert.equal(JSON.stringify(projectionB).includes('A_PRIVATE_FACT'), false);
assert.equal(Object.isFrozen(projectionA), true);

console.log('multiplayer member-state projection regression: audience-safe state and memories passed');
