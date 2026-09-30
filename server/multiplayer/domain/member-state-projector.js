import {
  MEMBER_STATE_PROJECTION_SCHEMA,
  assertMemberStateProjection
} from '../contracts/member-state-contracts.js';
import { projectPersonalRoomState } from './lineage.js';

function withoutServerEvidence(value) {
  if (Array.isArray(value)) return value.map(withoutServerEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'evidence_event_ids')
    .map(([key, child]) => [key, withoutServerEvidence(child)]));
}

/**
 * Builds the state carried by a member-facing committed-turn response.
 *
 * The personal-export projector already strips the counterpart's private actor
 * partitions. This narrower projection then allowlists shared-world fields,
 * keeps only relationships authored by the viewer actor, and renames the two
 * readable memory partitions so no hidden namespace can be serialized by
 * accident.
 */
export function projectMemberRoomState(roomState, viewerSeat) {
  const personal = projectPersonalRoomState(roomState, viewerSeat);
  const viewerActorId = personal.actors[viewerSeat].room_actor_id;
  return assertMemberStateProjection({
    schema: MEMBER_STATE_PROJECTION_SCHEMA,
    viewer_seat: viewerSeat,
    state_revision: personal.meta.state_revision,
    shared_world: {
      world_state: withoutServerEvidence(personal.shared_world.world_state),
      calendar: withoutServerEvidence(personal.shared_world.calendar),
      map: withoutServerEvidence(personal.shared_world.map),
      shared_missions: withoutServerEvidence(personal.shared_world.shared_missions),
      shared_combat: withoutServerEvidence(personal.shared_world.shared_combat)
    },
    actors: withoutServerEvidence(personal.actors),
    relationships: personal.relationships.filter(edge => (
      edge.source_actor_id === viewerActorId
    )).map(withoutServerEvidence),
    memories: {
      shared: withoutServerEvidence(personal.memories.shared),
      personal: withoutServerEvidence(personal.memories[`actor:${viewerSeat}`])
    }
  }, {
    viewer_seat: viewerSeat,
    state_revision: personal.meta.state_revision
  });
}
