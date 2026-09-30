CREATE TABLE room_opening_drafts (
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  seat_id TEXT NOT NULL CHECK (seat_id IN ('A', 'B')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  draft_json TEXT NOT NULL CHECK (length(draft_json) BETWEEN 2 AND 20000),
  draft_commitment TEXT NOT NULL
    CHECK (length(draft_commitment) = 71 AND substr(draft_commitment, 1, 7) = 'sha256:'),
  confirmed_revision INTEGER CHECK (confirmed_revision >= 1),
  confirmed_commitment TEXT
    CHECK (confirmed_commitment IS NULL OR
      (length(confirmed_commitment) = 71 AND substr(confirmed_commitment, 1, 7) = 'sha256:')),
  confirmed_at TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  PRIMARY KEY (room_id, seat_id),
  CHECK (
    (confirmed_revision IS NULL AND confirmed_commitment IS NULL AND confirmed_at IS NULL)
    OR
    (confirmed_revision = revision AND confirmed_commitment = draft_commitment
      AND confirmed_at IS NOT NULL AND length(confirmed_at) >= 20)
  )
) STRICT;

CREATE INDEX room_opening_drafts_confirmation
  ON room_opening_drafts(room_id, confirmed_revision, confirmed_at);
