CREATE TABLE multiplayer_rooms (
  room_id TEXT PRIMARY KEY NOT NULL,
  origin_type TEXT NOT NULL CHECK (origin_type IN ('existing_save_derived', 'new_multiplayer_save')),
  lineage_id TEXT NOT NULL,
  origin_owner_user_id TEXT,
  origin_snapshot_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('LOBBY', 'READY', 'ACTIVE', 'ARCHIVED')),
  host_user_id TEXT NOT NULL,
  active_epoch_id TEXT,
  current_turn_id TEXT,
  state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  control_revision INTEGER NOT NULL DEFAULT 0 CHECK (control_revision >= 0),
  event_seq INTEGER NOT NULL DEFAULT 0 CHECK (event_seq >= 0),
  active_narrative_mode TEXT NOT NULL CHECK (active_narrative_mode IN ('shared', 'dual_pov')),
  queued_narrative_mode TEXT CHECK (queued_narrative_mode IN ('shared', 'dual_pov')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  archived_at TEXT,
  CHECK (
    (origin_type = 'new_multiplayer_save' AND origin_owner_user_id IS NULL)
    OR (origin_type = 'existing_save_derived' AND origin_owner_user_id IS NOT NULL)
  ),
  CHECK (archived_at IS NULL OR lifecycle = 'ARCHIVED'),
  UNIQUE (room_id, lineage_id),
  FOREIGN KEY (active_epoch_id, room_id) REFERENCES room_epochs(epoch_id, room_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (current_turn_id, room_id) REFERENCES multiplayer_turns(turn_id, room_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE multiplayer_members (
  member_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  seat_id TEXT NOT NULL CHECK (seat_id IN ('A', 'B')),
  member_status TEXT NOT NULL CHECK (member_status IN ('INVITED', 'ACTIVE', 'LEFT')),
  joined_at TEXT NOT NULL CHECK (length(joined_at) >= 20),
  ready_at TEXT,
  left_at TEXT,
  CHECK ((member_status = 'LEFT') = (left_at IS NOT NULL)),
  CHECK (ready_at IS NULL OR length(ready_at) >= 20),
  UNIQUE (room_id, user_id),
  UNIQUE (room_id, seat_id),
  UNIQUE (member_id, room_id),
  UNIQUE (member_id, room_id, seat_id)
) STRICT;

CREATE TABLE save_import_staging (
  import_id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'),
  source_save_id TEXT NOT NULL,
  client_save_instance_id TEXT NOT NULL,
  source_branch_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  cloud_revision TEXT,
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 71 AND substr(state_hash, 1, 7) = 'sha256:'),
  snapshot_ciphertext BLOB NOT NULL CHECK (length(snapshot_ciphertext) > 0),
  wrapped_data_key BLOB NOT NULL CHECK (length(wrapped_data_key) >= 16),
  nonce BLOB NOT NULL CHECK (length(nonce) >= 8),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) >= 8),
  master_key_version TEXT NOT NULL,
  import_status TEXT NOT NULL CHECK (import_status IN ('READY', 'CONSUMED', 'EXPIRED')),
  consumed_room_id TEXT REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20),
  consumed_at TEXT,
  CHECK ((import_status = 'CONSUMED') = (consumed_room_id IS NOT NULL AND consumed_at IS NOT NULL)),
  UNIQUE (owner_user_id, idempotency_key)
) STRICT;

CREATE TABLE room_invites (
  invite_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 71 AND substr(token_hash, 1, 7) = 'sha256:'),
  created_by_member_id TEXT NOT NULL,
  intended_seat_id TEXT NOT NULL CHECK (intended_seat_id IN ('A', 'B')),
  expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 2),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count BETWEEN 0 AND max_uses),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  FOREIGN KEY (created_by_member_id, room_id)
    REFERENCES multiplayer_members(member_id, room_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE room_control_proposals (
  proposal_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  epoch_id TEXT,
  proposal_type TEXT NOT NULL CHECK (proposal_type IN (
    'void_turn', 'archive_room', 'resume_room_checkpoint', 'fork_from_latest_source_save'
  )),
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
  target_turn_id TEXT,
  target_checkpoint_id TEXT,
  source_import_id TEXT,
  base_control_revision INTEGER NOT NULL CHECK (base_control_revision >= 0),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'),
  proposal_payload_json TEXT NOT NULL CHECK (length(proposal_payload_json) >= 2),
  proposed_by_member_id TEXT NOT NULL,
  accepted_by_a_at TEXT,
  accepted_by_a_revision INTEGER CHECK (accepted_by_a_revision >= 1),
  accepted_by_a_diff_commitment TEXT,
  accepted_by_b_at TEXT,
  accepted_by_b_revision INTEGER CHECK (accepted_by_b_revision >= 1),
  accepted_by_b_diff_commitment TEXT,
  proposal_status TEXT NOT NULL CHECK (proposal_status IN ('OPEN', 'ACCEPTED', 'APPLIED', 'CANCELLED')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  applied_at TEXT,
  CHECK ((proposal_status = 'APPLIED') = (applied_at IS NOT NULL)),
  CHECK ((accepted_by_a_at IS NULL) = (accepted_by_a_revision IS NULL)),
  CHECK ((accepted_by_b_at IS NULL) = (accepted_by_b_revision IS NULL)),
  CHECK (accepted_by_a_at IS NULL OR length(accepted_by_a_at) >= 20),
  CHECK (accepted_by_b_at IS NULL OR length(accepted_by_b_at) >= 20),
  CHECK (accepted_by_a_revision IS NULL OR accepted_by_a_revision = proposal_revision),
  CHECK (accepted_by_b_revision IS NULL OR accepted_by_b_revision = proposal_revision),
  CHECK (proposal_status NOT IN ('ACCEPTED', 'APPLIED')
    OR (accepted_by_a_at IS NOT NULL AND accepted_by_b_at IS NOT NULL)),
  CHECK (proposal_type != 'void_turn' OR target_turn_id IS NOT NULL),
  CHECK (proposal_type != 'archive_room' OR target_checkpoint_id IS NOT NULL),
  CHECK (proposal_type != 'resume_room_checkpoint' OR target_checkpoint_id IS NOT NULL),
  CHECK (proposal_type != 'fork_from_latest_source_save' OR source_import_id IS NOT NULL),
  CHECK (proposal_type = 'fork_from_latest_source_save'
    OR (accepted_by_a_diff_commitment IS NULL AND accepted_by_b_diff_commitment IS NULL)),
  FOREIGN KEY (epoch_id, room_id) REFERENCES room_epochs(epoch_id, room_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (target_turn_id, room_id) REFERENCES multiplayer_turns(turn_id, room_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (target_checkpoint_id, room_id) REFERENCES room_checkpoints(checkpoint_id, room_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_import_id) REFERENCES room_source_imports(source_import_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (proposed_by_member_id, room_id)
    REFERENCES multiplayer_members(member_id, room_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE room_source_imports (
  source_import_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  lineage_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
  origin_owner_user_id TEXT NOT NULL,
  source_save_id TEXT NOT NULL,
  client_save_instance_id TEXT NOT NULL,
  source_branch_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  cloud_revision TEXT,
  canonical_content_hash TEXT NOT NULL,
  selected_state_hash TEXT NOT NULL,
  raw_source_hash TEXT NOT NULL,
  normalized_source_hash TEXT NOT NULL,
  normalization_and_rebind_diff_hash TEXT,
  genesis_state_hash TEXT NOT NULL,
  privacy_normalizer_version TEXT NOT NULL,
  derived_from_export_id TEXT,
  import_request_hash TEXT NOT NULL CHECK (length(import_request_hash) = 71 AND substr(import_request_hash, 1, 7) = 'sha256:'),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('PENDING', 'VALID', 'REJECTED')),
  validation_result_json TEXT NOT NULL CHECK (length(validation_result_json) >= 2),
  actor_rebind_json TEXT,
  actor_binding_set_hash TEXT,
  audience_diff_codec TEXT NOT NULL,
  audience_diff_a_ciphertext BLOB NOT NULL CHECK (length(audience_diff_a_ciphertext) > 0),
  audience_diff_b_ciphertext BLOB NOT NULL CHECK (length(audience_diff_b_ciphertext) > 0),
  audience_diff_a_commitment TEXT NOT NULL,
  audience_diff_b_commitment TEXT NOT NULL,
  source_snapshot_ref TEXT NOT NULL,
  server_hmac_commitment TEXT NOT NULL,
  imported_at TEXT NOT NULL CHECK (length(imported_at) >= 20),
  CHECK ((actor_rebind_json IS NULL) = (actor_binding_set_hash IS NULL)),
  UNIQUE (room_id, source_save_id, client_save_instance_id, source_branch_id, source_node_id, canonical_content_hash),
  FOREIGN KEY (room_id, lineage_id) REFERENCES multiplayer_rooms(room_id, lineage_id),
  FOREIGN KEY (derived_from_export_id) REFERENCES singleplayer_exports(export_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE room_epochs (
  epoch_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  lineage_id TEXT NOT NULL,
  epoch_no INTEGER NOT NULL CHECK (epoch_no >= 1),
  base_type TEXT NOT NULL CHECK (base_type IN ('origin_snapshot', 'room_checkpoint', 'latest_source_import')),
  base_ref_id TEXT NOT NULL,
  base_state_hash TEXT NOT NULL,
  genesis_checkpoint_id TEXT NOT NULL,
  head_checkpoint_id TEXT NOT NULL,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  control_revision INTEGER NOT NULL CHECK (control_revision >= 0),
  epoch_state TEXT NOT NULL CHECK (epoch_state IN ('ACTIVE', 'ARCHIVED')),
  created_from_proposal_id TEXT,
  activated_at TEXT NOT NULL CHECK (length(activated_at) >= 20),
  archived_at TEXT,
  CHECK ((epoch_state = 'ARCHIVED') = (archived_at IS NOT NULL)),
  UNIQUE (room_id, epoch_no),
  UNIQUE (epoch_id, room_id),
  UNIQUE (epoch_id, lineage_id),
  FOREIGN KEY (room_id, lineage_id) REFERENCES multiplayer_rooms(room_id, lineage_id),
  FOREIGN KEY (genesis_checkpoint_id, epoch_id)
    REFERENCES room_checkpoints(checkpoint_id, epoch_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (head_checkpoint_id, epoch_id)
    REFERENCES room_checkpoints(checkpoint_id, epoch_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_from_proposal_id) REFERENCES room_control_proposals(proposal_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX room_epochs_one_active_per_room
  ON room_epochs(room_id) WHERE epoch_state = 'ACTIVE';
CREATE UNIQUE INDEX room_epochs_one_per_applied_proposal
  ON room_epochs(created_from_proposal_id) WHERE created_from_proposal_id IS NOT NULL;

CREATE TABLE room_checkpoints (
  checkpoint_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  turn_no INTEGER NOT NULL CHECK (turn_no >= 0),
  checkpoint_kind TEXT NOT NULL CHECK (checkpoint_kind IN ('genesis', 'turn_commit')),
  parent_checkpoint_id TEXT,
  turn_id TEXT,
  commit_id TEXT,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  state_hash TEXT NOT NULL,
  snapshot_ref TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK (
    (checkpoint_kind = 'genesis' AND turn_no = 0 AND parent_checkpoint_id IS NULL AND turn_id IS NULL AND commit_id IS NULL)
    OR (checkpoint_kind = 'turn_commit' AND turn_no >= 1 AND parent_checkpoint_id IS NOT NULL AND turn_id IS NOT NULL AND commit_id IS NOT NULL)
  ),
  UNIQUE (epoch_id, turn_no),
  UNIQUE (checkpoint_id, room_id),
  UNIQUE (checkpoint_id, epoch_id),
  UNIQUE (checkpoint_id, lineage_id),
  FOREIGN KEY (epoch_id, room_id) REFERENCES room_epochs(epoch_id, room_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (epoch_id, lineage_id) REFERENCES room_epochs(epoch_id, lineage_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (parent_checkpoint_id, epoch_id)
    REFERENCES room_checkpoints(checkpoint_id, epoch_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (turn_id, epoch_id) REFERENCES multiplayer_turns(turn_id, epoch_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (commit_id, epoch_id) REFERENCES turn_commits(commit_id, epoch_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX room_checkpoints_one_turn
  ON room_checkpoints(turn_id) WHERE turn_id IS NOT NULL;
CREATE UNIQUE INDEX room_checkpoints_one_commit
  ON room_checkpoints(commit_id) WHERE commit_id IS NOT NULL;

CREATE TABLE room_actor_bindings (
  binding_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  room_actor_id TEXT NOT NULL,
  original_member_id TEXT NOT NULL,
  original_seat_id TEXT NOT NULL CHECK (original_seat_id IN ('A', 'B')),
  genesis_checkpoint_id TEXT NOT NULL,
  opaque_binding_token_hash TEXT NOT NULL UNIQUE,
  signature_version TEXT NOT NULL,
  server_signature BLOB NOT NULL CHECK (length(server_signature) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (room_id, room_actor_id),
  UNIQUE (room_id, original_member_id),
  UNIQUE (room_id, original_seat_id),
  FOREIGN KEY (room_id, lineage_id) REFERENCES multiplayer_rooms(room_id, lineage_id),
  FOREIGN KEY (original_member_id, room_id, original_seat_id)
    REFERENCES multiplayer_members(member_id, room_id, seat_id),
  FOREIGN KEY (genesis_checkpoint_id, lineage_id)
    REFERENCES room_checkpoints(checkpoint_id, lineage_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE singleplayer_exports (
  export_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  checkpoint_id TEXT NOT NULL,
  exporting_member_id TEXT NOT NULL,
  exporting_seat_id TEXT NOT NULL CHECK (exporting_seat_id IN ('A', 'B')),
  codec TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  output_format TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL,
  output_hash TEXT,
  output_ref TEXT,
  export_status TEXT NOT NULL CHECK (export_status IN ('PENDING', 'READY', 'FAILED')),
  failure_code TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  completed_at TEXT,
  CHECK ((export_status = 'READY') = (output_hash IS NOT NULL AND output_ref IS NOT NULL)),
  CHECK ((export_status = 'PENDING') = (completed_at IS NULL)),
  UNIQUE (room_id, exporting_member_id, idempotency_key),
  FOREIGN KEY (checkpoint_id, room_id) REFERENCES room_checkpoints(checkpoint_id, room_id),
  FOREIGN KEY (exporting_member_id, room_id, exporting_seat_id)
    REFERENCES multiplayer_members(member_id, room_id, seat_id)
) STRICT;

CREATE TABLE multiplayer_turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  epoch_id TEXT NOT NULL,
  turn_no INTEGER NOT NULL CHECK (turn_no >= 1),
  turn_status TEXT NOT NULL CHECK (turn_status IN (
    'AWAITING_PAYER_SELECTION', 'COLLECTING_ACTIONS', 'ONE_ACTION_LOCKED', 'SEALED',
    'AWAITING_BILLING_AUTHORIZATION', 'RESOLVING', 'RENDERING', 'STAGING_UPDATES',
    'AUDITING', 'REPAIRING_DRAFT', 'RENDERING_REPAIR', 'RESOLUTION_HANDOFF',
    'REPAIR_PAUSED', 'RETRYABLE_FAILED', 'VOID_REQUESTED', 'TURN_VOIDED',
    'COMMITTING', 'RECOVERING_COMMIT', 'COMMITTED', 'CONSISTENCY_FAULT'
  )),
  narrative_mode TEXT NOT NULL CHECK (narrative_mode IN ('shared', 'dual_pov')),
  base_checkpoint_id TEXT NOT NULL,
  base_state_revision INTEGER NOT NULL CHECK (base_state_revision >= 0),
  base_state_hash TEXT NOT NULL,
  execution_plan_json TEXT,
  execution_plan_hash TEXT,
  input_hash TEXT,
  sealed_at TEXT,
  committed_at TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK ((turn_status = 'COMMITTED') = (committed_at IS NOT NULL)),
  CHECK ((turn_status = 'TURN_VOIDED') = (voided_at IS NOT NULL)),
  CHECK (execution_plan_json IS NULL = (execution_plan_hash IS NULL)),
  UNIQUE (epoch_id, turn_no),
  UNIQUE (turn_id, room_id),
  UNIQUE (turn_id, epoch_id),
  FOREIGN KEY (epoch_id, room_id) REFERENCES room_epochs(epoch_id, room_id),
  FOREIGN KEY (base_checkpoint_id, epoch_id)
    REFERENCES room_checkpoints(checkpoint_id, epoch_id)
) STRICT;

CREATE UNIQUE INDEX multiplayer_turns_one_active_per_epoch
  ON multiplayer_turns(epoch_id)
  WHERE turn_status NOT IN ('TURN_VOIDED', 'COMMITTED', 'CONSISTENCY_FAULT');

CREATE TABLE model_endpoint_profiles (
  profile_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK (config_revision >= 1),
  owner_user_id TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('openai_compatible', 'anthropic')),
  normalized_base_url TEXT NOT NULL CHECK (substr(normalized_base_url, 1, 8) = 'https://'),
  normalized_origin TEXT NOT NULL CHECK (substr(normalized_origin, 1, 8) = 'https://'),
  endpoint_origin_hash TEXT NOT NULL,
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  auth_scheme TEXT NOT NULL CHECK (auth_scheme IN ('bearer', 'x-api-key', 'api-key', 'none')),
  credential_id TEXT,
  credential_revision INTEGER,
  native_tools INTEGER NOT NULL CHECK (native_tools IN (0, 1)),
  strict_json INTEGER NOT NULL CHECK (strict_json IN (0, 1)),
  error_correction_continuation INTEGER NOT NULL CHECK (error_correction_continuation IN (0, 1)),
  recommended_transport TEXT CHECK (recommended_transport IN ('native_tools', 'json_protocol')),
  config_fingerprint TEXT NOT NULL UNIQUE,
  profile_status TEXT NOT NULL CHECK (profile_status IN ('ACTIVE', 'REVOKED')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  revoked_at TEXT,
  CHECK ((auth_scheme = 'none') = (credential_id IS NULL AND credential_revision IS NULL)),
  CHECK ((credential_id IS NULL) = (credential_revision IS NULL)),
  CHECK (recommended_transport != 'native_tools' OR native_tools = 1),
  CHECK (recommended_transport IS NULL OR error_correction_continuation = 1),
  PRIMARY KEY (profile_id, config_revision),
  UNIQUE (profile_id, config_revision, owner_user_id),
  FOREIGN KEY (credential_id, credential_revision, owner_user_id)
    REFERENCES stored_model_credentials(credential_id, credential_revision, owner_user_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX model_endpoint_profiles_one_active_revision
  ON model_endpoint_profiles(profile_id) WHERE profile_status = 'ACTIVE';

CREATE TABLE stored_model_credentials (
  credential_id TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision >= 1),
  owner_user_id TEXT NOT NULL,
  endpoint_origin_hash TEXT NOT NULL,
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) >= 16),
  wrapped_data_key BLOB NOT NULL CHECK (length(wrapped_data_key) >= 16),
  nonce BLOB NOT NULL CHECK (length(nonce) >= 8),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) >= 8),
  master_key_version TEXT NOT NULL,
  fingerprint_suffix TEXT NOT NULL CHECK (length(fingerprint_suffix) BETWEEN 8 AND 32),
  rotated_from_revision INTEGER,
  credential_state TEXT NOT NULL CHECK (credential_state IN ('ACTIVE', 'REVOKED')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  revoked_at TEXT,
  CHECK ((credential_state = 'REVOKED') = (revoked_at IS NOT NULL)),
  CHECK (rotated_from_revision IS NULL OR rotated_from_revision < credential_revision),
  PRIMARY KEY (credential_id, credential_revision),
  UNIQUE (credential_id, credential_revision, owner_user_id),
  FOREIGN KEY (credential_id, rotated_from_revision)
    REFERENCES stored_model_credentials(credential_id, credential_revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX stored_model_credentials_one_active_revision
  ON stored_model_credentials(credential_id) WHERE credential_state = 'ACTIVE';

CREATE TABLE turn_model_selections (
  selection_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES multiplayer_turns(turn_id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('shared', 'writer')),
  audience TEXT NOT NULL CHECK (audience IN ('shared', 'A', 'B')),
  selection_revision INTEGER NOT NULL CHECK (selection_revision >= 1),
  expected_control_revision INTEGER NOT NULL CHECK (expected_control_revision >= 0),
  payer_user_id TEXT NOT NULL,
  payer_seat_id TEXT NOT NULL CHECK (payer_seat_id IN ('A', 'B')),
  audience_owner_user_id TEXT,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  credential_id TEXT,
  credential_revision INTEGER,
  payer_accepted_at TEXT NOT NULL,
  audience_accepted_at TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  selection_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK ((scope = 'shared' AND audience = 'shared' AND audience_owner_user_id IS NULL)
    OR (scope = 'writer' AND audience IN ('A', 'B') AND audience_owner_user_id IS NOT NULL)),
  CHECK ((credential_id IS NULL) = (credential_revision IS NULL)),
  UNIQUE (turn_id, scope, audience, selection_revision),
  UNIQUE (turn_id, scope, audience, idempotency_key),
  FOREIGN KEY (profile_id, profile_revision, payer_user_id)
    REFERENCES model_endpoint_profiles(profile_id, config_revision, owner_user_id),
  FOREIGN KEY (credential_id, credential_revision, payer_user_id)
    REFERENCES stored_model_credentials(credential_id, credential_revision, owner_user_id)
) STRICT;

CREATE UNIQUE INDEX turn_model_selections_one_active
  ON turn_model_selections(turn_id, scope, audience) WHERE active = 1;

CREATE TABLE action_submissions (
  submission_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES multiplayer_turns(turn_id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL,
  seat_id TEXT NOT NULL CHECK (seat_id IN ('A', 'B')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  action_ciphertext BLOB NOT NULL CHECK (length(action_ciphertext) > 0),
  wrapped_data_key BLOB NOT NULL CHECK (length(wrapped_data_key) >= 16),
  nonce BLOB NOT NULL CHECK (length(nonce) >= 8),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) >= 8),
  master_key_version TEXT NOT NULL,
  content_commitment TEXT NOT NULL UNIQUE,
  pre_resolution_visibility TEXT NOT NULL CHECK (pre_resolution_visibility IN ('open', 'sealed')),
  narration_preference TEXT NOT NULL CHECK (narration_preference IN ('full', 'summarize_intent')),
  base_state_revision INTEGER NOT NULL CHECK (base_state_revision >= 0),
  receipt_seq INTEGER NOT NULL CHECK (receipt_seq IN (1, 2)),
  received_at TEXT NOT NULL CHECK (length(received_at) >= 20),
  opponent_pre_revealed_at TEXT,
  full_disclosed_at TEXT,
  CHECK (opponent_pre_revealed_at IS NULL OR pre_resolution_visibility = 'open'),
  UNIQUE (turn_id, seat_id),
  UNIQUE (turn_id, receipt_seq),
  UNIQUE (turn_id, seat_id, idempotency_key),
  FOREIGN KEY (member_id) REFERENCES multiplayer_members(member_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE resolution_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn_no INTEGER NOT NULL CHECK (turn_no >= 1),
  input_hash TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('resolution', 'narrative', 'continuity', 'commit_recovery')),
  run_status TEXT NOT NULL CHECK (run_status IN ('QUEUED', 'CLAIMED', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  owner_boot_id TEXT,
  owner_task_id TEXT,
  claimed_at TEXT,
  heartbeat_at TEXT,
  lease_expires_at TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  prompt_version TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('native_tools', 'json_protocol')),
  bundle_schema_version TEXT NOT NULL,
  reducer_version TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK (
    (run_status IN ('CLAIMED', 'RUNNING') AND owner_boot_id IS NOT NULL AND owner_task_id IS NOT NULL
      AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence >= 1)
    OR (run_status NOT IN ('CLAIMED', 'RUNNING'))
  ),
  UNIQUE (epoch_id, turn_no, input_hash),
  UNIQUE (run_id, turn_id),
  FOREIGN KEY (turn_id, room_id) REFERENCES multiplayer_turns(turn_id, room_id),
  FOREIGN KEY (turn_id, epoch_id) REFERENCES multiplayer_turns(turn_id, epoch_id)
) STRICT;

CREATE UNIQUE INDEX resolution_runs_one_active_per_turn
  ON resolution_runs(turn_id)
  WHERE run_status IN ('QUEUED', 'CLAIMED', 'RUNNING', 'PAUSED');

CREATE TABLE agent_stage_sessions (
  stage_session_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES resolution_runs(run_id) ON DELETE RESTRICT,
  stage TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('none', 'shared', 'A', 'B')),
  continuity_session_id TEXT,
  provider_session_ref TEXT,
  transport TEXT NOT NULL CHECK (transport IN ('native_tools', 'json_protocol')),
  session_state_ciphertext BLOB NOT NULL CHECK (length(session_state_ciphertext) > 0),
  wrapped_data_key BLOB NOT NULL CHECK (length(wrapped_data_key) >= 16),
  nonce BLOB NOT NULL CHECK (length(nonce) >= 8),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) >= 8),
  master_key_version TEXT NOT NULL,
  session_state_hash TEXT NOT NULL,
  resume_cursor TEXT,
  session_status TEXT NOT NULL CHECK (session_status IN ('OPEN', 'WAITING_REPAIR', 'PAUSED', 'COMPLETE', 'FAILED')),
  latest_invocation_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  UNIQUE (run_id, stage, audience),
  UNIQUE (run_id, continuity_session_id)
) STRICT;

CREATE TABLE canonical_resolutions (
  resolution_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL UNIQUE REFERENCES multiplayer_turns(turn_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES resolution_runs(run_id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL,
  resolution_ciphertext BLOB NOT NULL CHECK (length(resolution_ciphertext) > 0),
  wrapped_data_key BLOB NOT NULL CHECK (length(wrapped_data_key) >= 16),
  nonce BLOB NOT NULL CHECK (length(nonce) >= 8),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) >= 8),
  master_key_version TEXT NOT NULL,
  resolution_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20)
) STRICT;

CREATE TABLE narrative_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES multiplayer_turns(turn_id) ON DELETE RESTRICT,
  audience TEXT NOT NULL CHECK (audience IN ('shared', 'A', 'B')),
  narrative_mode TEXT NOT NULL CHECK (narrative_mode IN ('shared', 'dual_pov')),
  delivery_ciphertext BLOB NOT NULL CHECK (length(delivery_ciphertext) > 0),
  wrapped_data_key BLOB NOT NULL CHECK (length(wrapped_data_key) >= 16),
  nonce BLOB NOT NULL CHECK (length(nonce) >= 8),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) >= 8),
  master_key_version TEXT NOT NULL,
  resolution_hash TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  narrative_hash TEXT NOT NULL,
  writer_invocation_id TEXT NOT NULL,
  stop_point_ref TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK ((narrative_mode = 'shared' AND audience = 'shared')
    OR (narrative_mode = 'dual_pov' AND audience IN ('A', 'B'))),
  UNIQUE (turn_id, audience)
) STRICT;

CREATE TABLE turn_continuity_commands (
  command_attempt_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES resolution_runs(run_id) ON DELETE RESTRICT,
  continuity_session_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('native_tools', 'json_protocol')),
  operation TEXT NOT NULL CHECK (operation IN ('stage_turn_bundle', 'repair_turn_bundle')),
  canonical_request_hash TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  immutable_result_ciphertext BLOB CHECK (
    immutable_result_ciphertext IS NULL OR length(immutable_result_ciphertext) > 0
  ),
  wrapped_data_key BLOB CHECK (wrapped_data_key IS NULL OR length(wrapped_data_key) >= 16),
  nonce BLOB CHECK (nonce IS NULL OR length(nonce) >= 8),
  auth_tag BLOB CHECK (auth_tag IS NULL OR length(auth_tag) >= 8),
  master_key_version TEXT,
  immutable_result_hash TEXT,
  command_status TEXT NOT NULL CHECK (command_status IN ('IN_PROGRESS', 'ACCEPTED', 'REJECTED')),
  provider_call_id TEXT,
  lease_fence INTEGER NOT NULL CHECK (lease_fence >= 1),
  expected_draft_revision INTEGER NOT NULL CHECK (expected_draft_revision >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  completed_at TEXT,
  CHECK (
    (command_status = 'IN_PROGRESS'
      AND immutable_result_ciphertext IS NULL
      AND wrapped_data_key IS NULL
      AND nonce IS NULL
      AND auth_tag IS NULL
      AND master_key_version IS NULL
      AND immutable_result_hash IS NULL
      AND completed_at IS NULL)
    OR
    (command_status IN ('ACCEPTED', 'REJECTED')
      AND immutable_result_ciphertext IS NOT NULL
      AND wrapped_data_key IS NOT NULL
      AND nonce IS NOT NULL
      AND auth_tag IS NOT NULL
      AND master_key_version IS NOT NULL
      AND immutable_result_hash IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  UNIQUE (run_id, continuity_session_id, invocation_id, command_attempt_id, canonical_request_hash)
) STRICT;

CREATE TABLE turn_drafts (
  draft_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  base_state_revision INTEGER NOT NULL CHECK (base_state_revision >= 0),
  base_state_hash TEXT NOT NULL,
  lease_fence INTEGER NOT NULL CHECK (lease_fence >= 1),
  draft_revision INTEGER NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  execution_plan_hash TEXT NOT NULL,
  billing_provenance_hash TEXT NOT NULL,
  resolution_hash TEXT NOT NULL,
  obligation_set_hash TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  rule_version_hash TEXT NOT NULL,
  candidate_state_ciphertext BLOB,
  wrapped_data_key BLOB,
  nonce BLOB,
  auth_tag BLOB,
  master_key_version TEXT,
  candidate_state_hash TEXT,
  artifact_set_hash TEXT,
  narrative_set_hash TEXT,
  semantic_hash TEXT,
  commit_envelope_hash TEXT,
  ready_receipt_hash TEXT,
  draft_status TEXT NOT NULL CHECK (draft_status IN ('OPEN', 'REVIEW_REQUIRED', 'READY', 'DISCARDED')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK ((candidate_state_ciphertext IS NULL) = (wrapped_data_key IS NULL)),
  CHECK ((candidate_state_ciphertext IS NULL) = (nonce IS NULL)),
  CHECK ((candidate_state_ciphertext IS NULL) = (auth_tag IS NULL)),
  CHECK ((candidate_state_ciphertext IS NULL) = (master_key_version IS NULL)),
  CHECK ((candidate_state_ciphertext IS NULL) = (candidate_state_hash IS NULL)),
  CHECK (draft_status != 'READY' OR (semantic_hash IS NOT NULL AND commit_envelope_hash IS NOT NULL AND ready_receipt_hash IS NOT NULL)),
  UNIQUE (draft_id, turn_id),
  FOREIGN KEY (turn_id, room_id) REFERENCES multiplayer_turns(turn_id, room_id),
  FOREIGN KEY (turn_id, epoch_id) REFERENCES multiplayer_turns(turn_id, epoch_id),
  FOREIGN KEY (run_id, turn_id) REFERENCES resolution_runs(run_id, turn_id)
) STRICT;

CREATE TABLE turn_continuity_command_items (
  command_item_id TEXT PRIMARY KEY NOT NULL,
  command_attempt_id TEXT NOT NULL
    REFERENCES turn_continuity_commands(command_attempt_id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  continuity_session_id TEXT NOT NULL,
  item_seq INTEGER NOT NULL CHECK (item_seq >= 1),
  item_kind TEXT NOT NULL CHECK (item_kind IN (
    'effect', 'domain_check', 'memory', 'shinobi_daily'
  )),
  item_id TEXT NOT NULL,
  item_status TEXT NOT NULL CHECK (item_status IN ('ACCEPTED', 'IDEMPOTENT', 'REJECTED')),
  consumed INTEGER NOT NULL CHECK (consumed IN (0, 1)),
  canonical_item_hash TEXT NOT NULL,
  receipt_hash TEXT,
  error_code TEXT,
  error_path TEXT,
  before_draft_revision INTEGER NOT NULL CHECK (before_draft_revision >= 0),
  after_draft_revision INTEGER NOT NULL CHECK (after_draft_revision >= 0),
  lease_fence INTEGER NOT NULL CHECK (lease_fence >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK (
    (item_status = 'ACCEPTED'
      AND consumed = 1
      AND receipt_hash IS NOT NULL
      AND error_code IS NULL
      AND error_path IS NULL
      AND after_draft_revision = before_draft_revision + 1)
    OR
    (item_status = 'IDEMPOTENT'
      AND consumed = 0
      AND receipt_hash IS NOT NULL
      AND error_code IS NULL
      AND error_path IS NULL
      AND after_draft_revision = before_draft_revision)
    OR
    (item_status = 'REJECTED'
      AND consumed = 0
      AND receipt_hash IS NULL
      AND error_code IS NOT NULL
      AND error_path IS NOT NULL
      AND after_draft_revision = before_draft_revision)
  ),
  UNIQUE (command_attempt_id, item_seq),
  FOREIGN KEY (draft_id, turn_id) REFERENCES turn_drafts(draft_id, turn_id),
  FOREIGN KEY (run_id, turn_id) REFERENCES resolution_runs(run_id, turn_id),
  FOREIGN KEY (run_id, continuity_session_id)
    REFERENCES agent_stage_sessions(run_id, continuity_session_id)
) STRICT;

CREATE TABLE turn_draft_effects (
  draft_effect_id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  effect_seq INTEGER NOT NULL CHECK (effect_seq >= 1),
  effect_hash TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  required_reducer TEXT NOT NULL,
  reducer_version TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  canonical_operation_ciphertext BLOB NOT NULL CHECK (length(canonical_operation_ciphertext) > 0),
  receipt_hash TEXT NOT NULL,
  applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20),
  UNIQUE (turn_id, effect_id),
  UNIQUE (turn_id, effect_seq),
  UNIQUE (draft_id, effect_id),
  FOREIGN KEY (draft_id, turn_id) REFERENCES turn_drafts(draft_id, turn_id)
) STRICT;

CREATE TABLE turn_draft_obligations (
  draft_obligation_id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  obligation_kind TEXT NOT NULL CHECK (obligation_kind IN ('domain_check', 'memory', 'daily', 'narrative')),
  binding_scope TEXT NOT NULL,
  obligation_status TEXT NOT NULL CHECK (obligation_status IN ('OPEN', 'SATISFIED', 'REOPENED')),
  current_artifact_revision INTEGER CHECK (current_artifact_revision >= 1),
  correction_generation INTEGER NOT NULL DEFAULT 0 CHECK (correction_generation >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK (
    (obligation_kind = 'domain_check'
      AND current_artifact_revision IS NULL
      AND obligation_status IN ('OPEN', 'SATISFIED'))
    OR
    (obligation_kind != 'domain_check'
      AND ((obligation_status = 'OPEN') = (current_artifact_revision IS NULL)))
  ),
  UNIQUE (turn_id, obligation_id),
  UNIQUE (draft_id, obligation_id),
  FOREIGN KEY (draft_id, turn_id) REFERENCES turn_drafts(draft_id, turn_id)
) STRICT;

CREATE TABLE turn_draft_artifact_versions (
  artifact_version_id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL CHECK (artifact_revision >= 1),
  artifact_status TEXT NOT NULL CHECK (artifact_status IN ('CURRENT', 'SUPERSEDED')),
  content_ciphertext BLOB NOT NULL CHECK (length(content_ciphertext) > 0),
  wrapped_data_key BLOB NOT NULL CHECK (length(wrapped_data_key) >= 16),
  nonce BLOB NOT NULL CHECK (length(nonce) >= 8),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) >= 8),
  master_key_version TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  source_refs_ciphertext BLOB NOT NULL CHECK (length(source_refs_ciphertext) > 0),
  generated_by_invocation_id TEXT NOT NULL,
  generation_plan_hash TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (turn_id, obligation_id, artifact_revision),
  FOREIGN KEY (draft_id, obligation_id)
    REFERENCES turn_draft_obligations(draft_id, obligation_id)
) STRICT;

CREATE UNIQUE INDEX turn_draft_artifacts_one_current
  ON turn_draft_artifact_versions(turn_id, obligation_id)
  WHERE artifact_status = 'CURRENT';

CREATE TABLE turn_output_adoption_events (
  adoption_event_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES multiplayer_turns(turn_id) ON DELETE RESTRICT,
  output_kind TEXT NOT NULL CHECK (output_kind IN ('resolution', 'narrative', 'effect', 'memory', 'daily', 'candidate_state')),
  output_id TEXT NOT NULL,
  output_version INTEGER NOT NULL CHECK (output_version >= 1),
  output_hash TEXT NOT NULL,
  adoption_status TEXT NOT NULL CHECK (adoption_status IN ('ADOPTED', 'SUPERSEDED', 'DISCARDED')),
  generation_invocation_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('native_tools', 'json_protocol')),
  previous_provenance_hash TEXT,
  provenance_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (turn_id, output_kind, output_id, output_version, adoption_status)
) STRICT;

CREATE TABLE turn_commits (
  commit_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL UNIQUE,
  commit_precondition_hash TEXT NOT NULL,
  before_state_revision INTEGER NOT NULL CHECK (before_state_revision >= 0),
  after_state_revision INTEGER NOT NULL CHECK (after_state_revision = before_state_revision + 1),
  before_state_hash TEXT NOT NULL,
  after_state_hash TEXT NOT NULL,
  artifact_set_hash TEXT NOT NULL,
  narrative_set_hash TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  commit_envelope_hash TEXT NOT NULL,
  lease_fence INTEGER NOT NULL CHECK (lease_fence >= 1),
  committed_at TEXT NOT NULL CHECK (length(committed_at) >= 20),
  UNIQUE (commit_id, epoch_id),
  FOREIGN KEY (turn_id, room_id) REFERENCES multiplayer_turns(turn_id, room_id),
  FOREIGN KEY (turn_id, epoch_id) REFERENCES multiplayer_turns(turn_id, epoch_id),
  FOREIGN KEY (checkpoint_id, epoch_id)
    REFERENCES room_checkpoints(checkpoint_id, epoch_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE room_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  epoch_id TEXT,
  turn_id TEXT,
  event_type TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('A', 'B', 'BOTH', 'SERVER')),
  projection_version TEXT NOT NULL,
  projected_payload_json TEXT NOT NULL CHECK (length(projected_payload_json) >= 2),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (room_id, event_seq),
  UNIQUE (event_id, room_id),
  FOREIGN KEY (epoch_id, room_id) REFERENCES room_epochs(epoch_id, room_id),
  FOREIGN KEY (turn_id, room_id) REFERENCES multiplayer_turns(turn_id, room_id)
) STRICT;

CREATE TABLE room_outbox (
  outbox_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  outbox_status TEXT NOT NULL CHECK (outbox_status IN ('PENDING', 'CLAIMED', 'DISPATCHED')),
  dispatcher_owner_id TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  lease_expires_at TEXT,
  claimed_at TEXT,
  dispatched_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK (
    (outbox_status = 'PENDING' AND dispatcher_owner_id IS NULL AND lease_expires_at IS NULL AND dispatched_at IS NULL)
    OR (outbox_status = 'CLAIMED' AND dispatcher_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL
      AND claimed_at IS NOT NULL AND dispatched_at IS NULL AND lease_fence >= 1)
    OR (outbox_status = 'DISPATCHED' AND dispatched_at IS NOT NULL AND lease_fence >= 1)
  ),
  FOREIGN KEY (event_id, room_id) REFERENCES room_events(event_id, room_id)
) STRICT;

CREATE TABLE room_chat_messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  epoch_id TEXT,
  sender_member_id TEXT NOT NULL,
  sender_seat_id TEXT NOT NULL CHECK (sender_seat_id IN ('A', 'B')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  message_text TEXT NOT NULL CHECK (length(message_text) BETWEEN 1 AND 2000),
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (room_id, message_id),
  UNIQUE (room_id, sender_member_id, idempotency_key),
  UNIQUE (room_id, event_seq),
  FOREIGN KEY (room_id, event_seq) REFERENCES room_events(room_id, event_seq),
  FOREIGN KEY (epoch_id, room_id) REFERENCES room_epochs(epoch_id, room_id),
  FOREIGN KEY (sender_member_id, room_id, sender_seat_id)
    REFERENCES multiplayer_members(member_id, room_id, seat_id)
) STRICT;

CREATE TABLE model_capability_probes (
  probe_id TEXT PRIMARY KEY NOT NULL,
  profile_owner_user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  credential_id TEXT,
  credential_revision INTEGER,
  probe_revision INTEGER NOT NULL CHECK (probe_revision >= 1),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL,
  max_requests INTEGER NOT NULL CHECK (max_requests >= 1),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens >= 1),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens >= 1),
  probe_result_json TEXT,
  probe_hash TEXT,
  recommended_transport TEXT CHECK (recommended_transport IN ('native_tools', 'json_protocol')),
  usage_invocation_id TEXT,
  probe_status TEXT NOT NULL CHECK (probe_status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  completed_at TEXT,
  CHECK ((credential_id IS NULL) = (credential_revision IS NULL)),
  CHECK ((probe_status = 'SUCCEEDED') = (probe_result_json IS NOT NULL AND probe_hash IS NOT NULL)),
  UNIQUE (profile_owner_user_id, idempotency_key),
  UNIQUE (profile_id, profile_revision, probe_revision),
  FOREIGN KEY (profile_id, profile_revision, profile_owner_user_id)
    REFERENCES model_endpoint_profiles(profile_id, config_revision, owner_user_id),
  FOREIGN KEY (credential_id, credential_revision, profile_owner_user_id)
    REFERENCES stored_model_credentials(credential_id, credential_revision, owner_user_id)
) STRICT;

CREATE TABLE model_execution_grants (
  grant_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL CHECK (grant_revision >= 1),
  payer_user_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  epoch_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  credential_id TEXT,
  credential_revision INTEGER,
  stage_scopes_json TEXT NOT NULL CHECK (length(stage_scopes_json) >= 2),
  authorization_scope_kind TEXT NOT NULL CHECK (authorization_scope_kind IN ('single_turn', 'standing')),
  authorization_turn_id TEXT,
  max_requests INTEGER NOT NULL CHECK (max_requests >= 1),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens >= 1),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens >= 1),
  max_retries INTEGER NOT NULL CHECK (max_retries >= 0),
  estimated_cost_currency TEXT,
  estimated_cost_amount_micros INTEGER CHECK (estimated_cost_amount_micros >= 0),
  granted_at TEXT NOT NULL CHECK (length(granted_at) >= 20),
  expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20),
  grant_state TEXT NOT NULL CHECK (grant_state IN ('ACTIVE', 'REVOKED', 'EXHAUSTED', 'EXPIRED')),
  revoked_at TEXT,
  CHECK ((credential_id IS NULL) = (credential_revision IS NULL)),
  CHECK ((authorization_scope_kind = 'single_turn') = (authorization_turn_id IS NOT NULL)),
  CHECK ((estimated_cost_currency IS NULL) = (estimated_cost_amount_micros IS NULL)),
  PRIMARY KEY (grant_id, grant_revision),
  UNIQUE (grant_id, grant_revision, payer_user_id),
  FOREIGN KEY (epoch_id, room_id) REFERENCES room_epochs(epoch_id, room_id),
  FOREIGN KEY (authorization_turn_id, epoch_id) REFERENCES multiplayer_turns(turn_id, epoch_id),
  FOREIGN KEY (profile_id, profile_revision, payer_user_id)
    REFERENCES model_endpoint_profiles(profile_id, config_revision, owner_user_id),
  FOREIGN KEY (credential_id, credential_revision, payer_user_id)
    REFERENCES stored_model_credentials(credential_id, credential_revision, owner_user_id)
) STRICT;

CREATE UNIQUE INDEX model_execution_grants_one_active_revision
  ON model_execution_grants(grant_id) WHERE grant_state = 'ACTIVE';

CREATE TABLE data_processing_consents (
  consent_id TEXT PRIMARY KEY NOT NULL,
  consent_series_id TEXT NOT NULL,
  consent_revision INTEGER NOT NULL CHECK (consent_revision >= 1),
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  scope_epoch_id TEXT NOT NULL,
  subject_user_id TEXT NOT NULL,
  selection_hash TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  terms_revision TEXT NOT NULL,
  categories_hash TEXT NOT NULL,
  consent_action TEXT NOT NULL CHECK (consent_action IN ('GRANTED', 'REVOKED')),
  supersedes_consent_id TEXT,
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) >= 20),
  UNIQUE (consent_series_id, consent_revision),
  UNIQUE (room_id, scope_epoch_id, subject_user_id, selection_hash, config_fingerprint,
    terms_revision, categories_hash, consent_revision),
  FOREIGN KEY (scope_epoch_id, room_id) REFERENCES room_epochs(epoch_id, room_id),
  FOREIGN KEY (supersedes_consent_id) REFERENCES data_processing_consents(consent_id)
) STRICT;

CREATE TABLE turn_billing_plans (
  billing_plan_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES multiplayer_turns(turn_id) ON DELETE RESTRICT,
  plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
  narrative_mode TEXT NOT NULL CHECK (narrative_mode IN ('shared', 'dual_pov')),
  turn_payer_selection_hash TEXT NOT NULL,
  pov_writer_selection_a_hash TEXT,
  pov_writer_selection_b_hash TEXT,
  stage_plans_json TEXT NOT NULL CHECK (length(stage_plans_json) >= 2),
  capability_probe_set_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK ((narrative_mode = 'shared' AND pov_writer_selection_a_hash IS NULL AND pov_writer_selection_b_hash IS NULL)
    OR (narrative_mode = 'dual_pov' AND pov_writer_selection_a_hash IS NOT NULL AND pov_writer_selection_b_hash IS NOT NULL)),
  UNIQUE (turn_id, plan_revision)
) STRICT;

CREATE TABLE turn_billing_authorizations (
  billing_authorization_id TEXT PRIMARY KEY NOT NULL,
  plan_hash TEXT NOT NULL,
  payer_user_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL CHECK (grant_revision >= 1),
  accepted_budget_json TEXT NOT NULL CHECK (length(accepted_budget_json) >= 2),
  accepted_at TEXT NOT NULL CHECK (length(accepted_at) >= 20),
  UNIQUE (plan_hash, payer_user_id),
  FOREIGN KEY (plan_hash) REFERENCES turn_billing_plans(plan_hash),
  FOREIGN KEY (grant_id, grant_revision, payer_user_id)
    REFERENCES model_execution_grants(grant_id, grant_revision, payer_user_id)
) STRICT;

CREATE TABLE turn_billing_amendments (
  amendment_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES multiplayer_turns(turn_id) ON DELETE RESTRICT,
  prior_plan_hash TEXT NOT NULL REFERENCES turn_billing_plans(plan_hash),
  new_plan_hash TEXT NOT NULL UNIQUE,
  amendment_revision INTEGER NOT NULL CHECK (amendment_revision >= 1),
  future_stage_changes_json TEXT NOT NULL CHECK (length(future_stage_changes_json) >= 2),
  required_acceptances_json TEXT NOT NULL CHECK (length(required_acceptances_json) >= 2),
  accepted_subjects_json TEXT NOT NULL CHECK (length(accepted_subjects_json) >= 2),
  amendment_status TEXT NOT NULL CHECK (amendment_status IN ('PROPOSED', 'ACCEPTED', 'APPLIED', 'REJECTED')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  applied_at TEXT,
  CHECK ((amendment_status = 'APPLIED') = (applied_at IS NOT NULL)),
  UNIQUE (turn_id, amendment_revision)
) STRICT;

CREATE TABLE ai_usage_ledger (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES multiplayer_turns(turn_id) ON DELETE RESTRICT,
  plan_hash TEXT NOT NULL REFERENCES turn_billing_plans(plan_hash),
  payer_user_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('none', 'shared', 'A', 'B')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  provider_request_id TEXT,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 0 AND 1),
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  estimated_cost_currency TEXT,
  estimated_cost_amount_micros INTEGER CHECK (estimated_cost_amount_micros >= 0),
  usage_status TEXT NOT NULL CHECK (usage_status IN ('IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED')),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  completed_at TEXT,
  CHECK ((estimated_cost_currency IS NULL) = (estimated_cost_amount_micros IS NULL)),
  CHECK (usage_status IN ('IN_FLIGHT', 'UNKNOWN') OR completed_at IS NOT NULL),
  UNIQUE (turn_id, stage, audience, attempt)
) STRICT;

CREATE TABLE room_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  epoch_id TEXT NOT NULL,
  checkpoint_id TEXT,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  state_hash TEXT NOT NULL,
  snapshot_ciphertext BLOB NOT NULL CHECK (length(snapshot_ciphertext) > 0),
  wrapped_data_key BLOB NOT NULL CHECK (length(wrapped_data_key) >= 16),
  nonce BLOB NOT NULL CHECK (length(nonce) >= 8),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) >= 8),
  master_key_version TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (epoch_id, state_revision),
  UNIQUE (checkpoint_id),
  FOREIGN KEY (epoch_id, room_id) REFERENCES room_epochs(epoch_id, room_id),
  FOREIGN KEY (checkpoint_id, epoch_id) REFERENCES room_checkpoints(checkpoint_id, epoch_id)
) STRICT;
