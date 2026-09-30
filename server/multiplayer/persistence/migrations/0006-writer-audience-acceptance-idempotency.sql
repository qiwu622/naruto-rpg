CREATE UNIQUE INDEX turn_model_selections_acceptance_parent
  ON turn_model_selections (
    selection_id, turn_id, audience, audience_owner_user_id
  );

CREATE TABLE writer_audience_acceptance_requests (
  acceptance_request_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  selection_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('A', 'B')),
  audience_owner_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'),
  expected_control_revision INTEGER NOT NULL CHECK (expected_control_revision >= 0),
  result_control_revision INTEGER NOT NULL CHECK (result_control_revision >= 0),
  result_turn_status TEXT NOT NULL CHECK (length(result_turn_status) BETWEEN 1 AND 64),
  result_selection_hash TEXT NOT NULL
    CHECK (
      length(result_selection_hash) = 71
      AND substr(result_selection_hash, 1, 7) = 'sha256:'
    ),
  accepted_at TEXT NOT NULL CHECK (length(accepted_at) >= 20),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (turn_id, audience, idempotency_key),
  UNIQUE (selection_id),
  FOREIGN KEY (turn_id) REFERENCES multiplayer_turns(turn_id) ON DELETE RESTRICT,
  FOREIGN KEY (selection_id, turn_id, audience, audience_owner_user_id)
    REFERENCES turn_model_selections(
      selection_id, turn_id, audience, audience_owner_user_id
    ) ON DELETE RESTRICT
) STRICT;
