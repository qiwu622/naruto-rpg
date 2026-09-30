ALTER TABLE multiplayer_rooms
  ADD COLUMN room_code TEXT;

-- Existing deployments exposed room_id directly. Preserve those locators as
-- their public room codes while new rooms receive a separate immutable ID.
UPDATE multiplayer_rooms
   SET room_code = room_id
 WHERE room_code IS NULL;

-- A room code belongs only to the current, non-archived room. Archiving frees
-- it immediately without changing the immutable IDs referenced by lineage.
CREATE UNIQUE INDEX multiplayer_rooms_one_current_room_code
  ON multiplayer_rooms(room_code COLLATE NOCASE) WHERE lifecycle != 'ARCHIVED';

-- Repository writes always provide room_code. The fallback keeps older
-- maintenance/test insertions safe and ensures they cannot create NULL codes.
CREATE TRIGGER multiplayer_rooms_fill_room_code_after_insert
AFTER INSERT ON multiplayer_rooms
WHEN NEW.room_code IS NULL
BEGIN
  UPDATE multiplayer_rooms
     SET room_code = NEW.room_id
   WHERE room_id = NEW.room_id;
END;

CREATE TRIGGER multiplayer_rooms_reject_empty_room_code_before_insert
BEFORE INSERT ON multiplayer_rooms
WHEN NEW.room_code IS NOT NULL AND length(trim(NEW.room_code)) = 0
BEGIN
  SELECT RAISE(ABORT, 'room_code must not be empty');
END;

CREATE TRIGGER multiplayer_rooms_reject_invalid_room_code_update
BEFORE UPDATE OF room_code ON multiplayer_rooms
WHEN OLD.room_code IS NOT NULL
 AND (NEW.room_code IS NULL OR length(trim(NEW.room_code)) = 0)
BEGIN
  SELECT RAISE(ABORT, 'room_code must not be empty');
END;

-- The old UNIQUE(token_hash) constraint made a password globally exclusive.
-- Rebuild the compatibility-named table so the same password hash can exist
-- in different rooms. max_uses/use_count/expires_at remain only so old rows
-- and readers migrate losslessly; joining no longer consumes or expires them.
ALTER TABLE room_invites RENAME TO room_invites_before_reusable_passwords;

CREATE TABLE room_invites (
  invite_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES multiplayer_rooms(room_id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL
    CHECK (length(token_hash) = 71 AND substr(token_hash, 1, 7) = 'sha256:'),
  created_by_member_id TEXT NOT NULL,
  intended_seat_id TEXT NOT NULL CHECK (intended_seat_id IN ('A', 'B')),
  expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 2),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count BETWEEN 0 AND max_uses),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  UNIQUE (room_id, token_hash),
  FOREIGN KEY (created_by_member_id, room_id)
    REFERENCES multiplayer_members(member_id, room_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO room_invites (
  invite_id, room_id, token_hash, created_by_member_id, intended_seat_id,
  expires_at, max_uses, use_count, revoked, created_at
)
SELECT invite_id, room_id, token_hash, created_by_member_id, intended_seat_id,
       expires_at, max_uses, use_count, revoked, created_at
  FROM room_invites_before_reusable_passwords;

DROP TABLE room_invites_before_reusable_passwords;

CREATE INDEX room_invites_room_password_lookup
  ON room_invites(room_id, token_hash, revoked);
