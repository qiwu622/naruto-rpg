CREATE TABLE room_genesis_import_reviews (
  room_id TEXT PRIMARY KEY NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  source_import_id TEXT NOT NULL UNIQUE REFERENCES save_import_staging(import_id) ON DELETE RESTRICT,
  proposal_id TEXT NOT NULL UNIQUE,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision = 1),
  genesis_codec TEXT NOT NULL,
  source_basis_hash TEXT NOT NULL CHECK (
    length(source_basis_hash) = 71 AND substr(source_basis_hash, 1, 7) = 'sha256:'
  ),
  genesis_state_hash TEXT NOT NULL CHECK (
    length(genesis_state_hash) = 71 AND substr(genesis_state_hash, 1, 7) = 'sha256:'
  ),
  audience_diff_codec TEXT NOT NULL,
  audience_diff_a_ciphertext BLOB NOT NULL CHECK (length(audience_diff_a_ciphertext) > 0),
  audience_diff_b_ciphertext BLOB NOT NULL CHECK (length(audience_diff_b_ciphertext) > 0),
  audience_diff_a_commitment TEXT NOT NULL,
  audience_diff_b_commitment TEXT NOT NULL,
  server_hmac_commitment TEXT NOT NULL,
  accepted_by_a_at TEXT,
  accepted_by_b_at TEXT,
  review_status TEXT NOT NULL CHECK (review_status IN ('AWAITING_CONFIRMATION', 'ACCEPTED')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK (accepted_by_a_at IS NULL OR length(accepted_by_a_at) >= 20),
  CHECK (accepted_by_b_at IS NULL OR length(accepted_by_b_at) >= 20),
  CHECK ((review_status = 'ACCEPTED') = (
    accepted_by_a_at IS NOT NULL AND accepted_by_b_at IS NOT NULL
  ))
) STRICT;
