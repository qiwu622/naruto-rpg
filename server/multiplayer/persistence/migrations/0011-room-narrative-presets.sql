ALTER TABLE multiplayer_rooms ADD COLUMN narrative_preset_seat TEXT NOT NULL DEFAULT 'A' CHECK (narrative_preset_seat IN ('A','B'));
ALTER TABLE multiplayer_rooms ADD COLUMN narrative_presets_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE multiplayer_turns ADD COLUMN writer_preset_json TEXT;
