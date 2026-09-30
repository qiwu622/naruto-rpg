CREATE TABLE latest_source_snapshots (
  snapshot_ref TEXT PRIMARY KEY NOT NULL,
  source_import_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  source_save_id TEXT NOT NULL,
  client_save_instance_id TEXT NOT NULL,
  source_branch_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  cloud_revision TEXT,
  derived_from_export_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'
  ),
  raw_source_hash TEXT NOT NULL CHECK (
    length(raw_source_hash) = 71 AND substr(raw_source_hash, 1, 7) = 'sha256:'
  ),
  normalized_source_hash TEXT NOT NULL CHECK (
    length(normalized_source_hash) = 71 AND substr(normalized_source_hash, 1, 7) = 'sha256:'
  ),
  normalization_and_rebind_diff_hash TEXT NOT NULL CHECK (
    length(normalization_and_rebind_diff_hash) = 71
      AND substr(normalization_and_rebind_diff_hash, 1, 7) = 'sha256:'
  ),
  genesis_state_hash TEXT NOT NULL CHECK (
    length(genesis_state_hash) = 71 AND substr(genesis_state_hash, 1, 7) = 'sha256:'
  ),
  payload_ciphertext BLOB NOT NULL CHECK (length(payload_ciphertext) > 0),
  wrapped_data_key BLOB NOT NULL CHECK (length(wrapped_data_key) >= 16),
  nonce BLOB NOT NULL CHECK (length(nonce) >= 8),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) >= 8),
  master_key_version TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (
    room_id, source_save_id, client_save_instance_id,
    source_branch_id, source_node_id, raw_source_hash
  ),
  FOREIGN KEY (room_id, lineage_id)
    REFERENCES multiplayer_rooms(room_id, lineage_id) ON DELETE RESTRICT,
  FOREIGN KEY (derived_from_export_id)
    REFERENCES singleplayer_exports(export_id) ON DELETE RESTRICT
) STRICT;
