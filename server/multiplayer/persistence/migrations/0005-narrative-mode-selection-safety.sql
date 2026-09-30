ALTER TABLE turn_model_selections
  ADD COLUMN selected_narrative_mode TEXT
  CHECK (
    selected_narrative_mode IS NULL
    OR selected_narrative_mode IN ('shared', 'dual_pov')
  );

UPDATE turn_model_selections
   SET selected_narrative_mode = (
     SELECT narrative_mode
       FROM multiplayer_turns
      WHERE multiplayer_turns.turn_id = turn_model_selections.turn_id
   )
 WHERE selected_narrative_mode IS NULL;

-- A v4 row does not prove which stage set its payer accepted. Preserve
-- selections frozen by an action, but require a fresh selection for every
-- still-mutable zero-action turn before the new provenance field is trusted.
UPDATE turn_model_selections
   SET active = 0
 WHERE active = 1
   AND EXISTS (
     SELECT 1
       FROM multiplayer_turns
      WHERE multiplayer_turns.turn_id = turn_model_selections.turn_id
        AND multiplayer_turns.turn_status IN (
          'AWAITING_PAYER_SELECTION', 'COLLECTING_ACTIONS'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM action_submissions
           WHERE action_submissions.turn_id = multiplayer_turns.turn_id
        )
   );

UPDATE multiplayer_turns
   SET turn_status = 'AWAITING_PAYER_SELECTION'
 WHERE turn_status = 'COLLECTING_ACTIONS'
   AND NOT EXISTS (
     SELECT 1
       FROM action_submissions
      WHERE action_submissions.turn_id = multiplayer_turns.turn_id
   );

CREATE TABLE narrative_mode_change_requests (
  mode_change_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'),
  expected_control_revision INTEGER NOT NULL CHECK (expected_control_revision >= 0),
  requested_mode TEXT NOT NULL CHECK (requested_mode IN ('shared', 'dual_pov')),
  result_disposition TEXT NOT NULL
    CHECK (result_disposition IN ('applied_current_turn', 'queued_next_turn')),
  result_control_revision INTEGER NOT NULL CHECK (result_control_revision >= 0),
  result_changed INTEGER NOT NULL CHECK (result_changed IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (room_id, member_id, idempotency_key),
  FOREIGN KEY (room_id) REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  FOREIGN KEY (member_id, room_id)
    REFERENCES multiplayer_members(member_id, room_id) ON DELETE RESTRICT
) STRICT;
