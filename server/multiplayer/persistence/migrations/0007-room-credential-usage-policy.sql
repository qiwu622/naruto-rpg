ALTER TABLE multiplayer_rooms
  ADD COLUMN credential_usage_policy TEXT NOT NULL DEFAULT 'ALTERNATE'
  CHECK (credential_usage_policy IN ('A_ONLY', 'B_ONLY', 'ALTERNATE'));

ALTER TABLE multiplayer_rooms
  ADD COLUMN credential_policy_revision INTEGER NOT NULL DEFAULT 0
  CHECK (credential_policy_revision >= 0);

CREATE TABLE room_model_profile_bindings (
  binding_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL,
  seat_id TEXT NOT NULL CHECK (seat_id IN ('A', 'B')),
  owner_user_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  replaced_at TEXT,
  CHECK ((active = 1) = (replaced_at IS NULL)),
  UNIQUE (room_id, seat_id, binding_revision),
  UNIQUE (binding_id, room_id),
  FOREIGN KEY (member_id, room_id, seat_id)
    REFERENCES multiplayer_members(member_id, room_id, seat_id),
  FOREIGN KEY (room_id, owner_user_id)
    REFERENCES multiplayer_members(room_id, user_id),
  FOREIGN KEY (profile_id, profile_revision, owner_user_id)
    REFERENCES model_endpoint_profiles(profile_id, config_revision, owner_user_id)
) STRICT;

CREATE UNIQUE INDEX room_model_profile_bindings_one_active
  ON room_model_profile_bindings(room_id, seat_id) WHERE active = 1;

CREATE TABLE room_credential_policy_acceptances (
  acceptance_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  member_id TEXT NOT NULL,
  seat_id TEXT NOT NULL CHECK (seat_id IN ('A', 'B')),
  user_id TEXT NOT NULL,
  credential_usage_policy TEXT NOT NULL
    CHECK (credential_usage_policy IN ('A_ONLY', 'B_ONLY', 'ALTERNATE')),
  accepted_at TEXT NOT NULL CHECK (length(accepted_at) >= 20),
  UNIQUE (room_id, policy_revision, seat_id),
  FOREIGN KEY (member_id, room_id, seat_id)
    REFERENCES multiplayer_members(member_id, room_id, seat_id),
  FOREIGN KEY (room_id, user_id)
    REFERENCES multiplayer_members(room_id, user_id)
) STRICT;
