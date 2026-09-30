ALTER TABLE multiplayer_turns
  ADD COLUMN turn_kind TEXT NOT NULL DEFAULT 'ACTION'
    CHECK (turn_kind IN ('ACTION', 'OPENING'));

-- Recover new-save rooms created before automatic opening existed. Only a
-- pristine first turn based directly on genesis is eligible; a turn that has
-- received either player's action remains an ordinary action turn.
UPDATE multiplayer_turns
   SET turn_kind = 'OPENING'
 WHERE turn_no = 1
   AND EXISTS (
     SELECT 1
       FROM multiplayer_rooms AS room
       JOIN room_checkpoints AS checkpoint
         ON checkpoint.checkpoint_id = multiplayer_turns.base_checkpoint_id
        AND checkpoint.epoch_id = multiplayer_turns.epoch_id
      WHERE room.room_id = multiplayer_turns.room_id
        AND room.origin_type = 'new_multiplayer_save'
        AND checkpoint.checkpoint_kind = 'genesis'
   )
   AND NOT EXISTS (
     SELECT 1
       FROM action_submissions AS action
      WHERE action.turn_id = multiplayer_turns.turn_id
   );

CREATE INDEX multiplayer_turns_kind
  ON multiplayer_turns(room_id, epoch_id, turn_kind, turn_no);
