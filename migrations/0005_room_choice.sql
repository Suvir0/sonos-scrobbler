-- Per-room scrobbling, and a ceiling on how long a song may be.
--
-- Rooms, not groups. A group is whatever set of speakers happens to be playing
-- together right now: it is created and destroyed as people link and unlink rooms in
-- the Sonos app, and its id changes with it. A preference keyed on a group id would be
-- erased by the next regroup, which is the one failure this feature cannot have. A
-- player id is the speaker itself and is stable, so that is what the choice hangs on.
--
-- Player rows are never pruned, unlike `sonos_groups`. A speaker that drops off the
-- network disappears from the topology and comes back later, and pruning would quietly
-- reset it to scrobbling after its owner had turned it off. A stale row costs nothing:
-- no subscription points at it.
--
-- Still no content data. A player id and a room name are the user's own labels for
-- their hardware, exactly as the household and group names above them already are.

CREATE TABLE IF NOT EXISTS sonos_players (
  player_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id  TEXT NOT NULL,
  name          TEXT,
  -- On by default: a speaker discovered after the account was linked should behave
  -- like the ones already there, not arrive silently switched off.
  scrobble      INTEGER NOT NULL DEFAULT 1,
  seen_at       INTEGER NOT NULL,
  PRIMARY KEY (player_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_players_user ON sonos_players(user_id);

-- Which speakers are in this group, as a JSON array of player ids. Rewritten from the
-- topology on every sync. An event names a group, and this is what turns that into the
-- rooms whose settings decide whether it may scrobble.
ALTER TABLE sonos_groups ADD COLUMN player_ids TEXT;

-- Refuse a track that reports an implausible length for a song. Catches the long
-- things that reach a speaker wearing a title and an artist: videos, DJ sets, mixes,
-- film audio, sleep recordings. On by default, and a setting rather than a hard rule
-- because a genuine hour-long live set is somebody's real listening.
ALTER TABLE users ADD COLUMN skip_long_tracks INTEGER NOT NULL DEFAULT 1;
