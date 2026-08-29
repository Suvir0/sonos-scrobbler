-- Sonos scrobbler schema.
--
-- ZERO-RETENTION INVARIANT: no table here stores what anyone listened to.
-- There is deliberately no `scrobbles`, `history`, or `plays` table. Track data
-- lives only in the GroupSession Durable Object while a play is in flight, and in
-- the UserQueue Durable Object until it is delivered. Sonos developer ToS 3(a)
-- prohibits recording content data; adding a history table here breaks that.
--
-- Room and group *names* are stored: they are the user's own labels for hardware,
-- not content data, and the UI is unusable without them.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  -- Opt-outs and source policy. Mirrors the desktop app's settings.
  scrobble_radio      INTEGER NOT NULL DEFAULT 1,
  allow_handoff       INTEGER NOT NULL DEFAULT 0
);

-- One Sonos OAuth grant per user. Refresh token is stable across refreshes, so a
-- user authorizes once. Both token columns are AES-GCM ciphertext.
CREATE TABLE IF NOT EXISTS sonos_accounts (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_enc   TEXT NOT NULL,
  access_token_enc    TEXT,
  access_expires_at   INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- A user may own more than one household.
CREATE TABLE IF NOT EXISTS households (
  household_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (household_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_households_user ON households(user_id);

-- Groups are created and torn down constantly as people move rooms around. This
-- table is the current picture, refreshed from `groups` namespace events.
CREATE TABLE IF NOT EXISTS sonos_groups (
  group_id      TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT,
  seen_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_household ON sonos_groups(household_id);
CREATE INDEX IF NOT EXISTS idx_groups_user ON sonos_groups(user_id);

-- Subscription bookkeeping. `groups` is household-scoped; `playback` and
-- `playbackMetadata` are group-scoped. Expiry is 3 days, extended by resubscribing.
-- next_renewal_at is what the cron orders by, so renewal work is a bounded slice.
CREATE TABLE IF NOT EXISTS subscriptions (
  id              TEXT PRIMARY KEY,          -- `${scope}:${targetId}:${namespace}`
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id    TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('household', 'group')),
  target_id       TEXT NOT NULL,             -- householdId or groupId
  namespace       TEXT NOT NULL CHECK (namespace IN ('groups', 'playback', 'playbackMetadata')),
  subscribed_at   INTEGER,
  expires_at      INTEGER,
  next_renewal_at INTEGER NOT NULL,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  -- Replay guard: the event signature does not cover the body, so a non-increasing
  -- sequence id is rejected.
  last_seq_id     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_subs_renewal ON subscriptions(next_renewal_at);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_target ON subscriptions(target_id, namespace);

-- Scrobble destinations. `credential_enc` is an AES-GCM encrypted Last.fm session
-- key (never expires) or ListenBrainz user token.
CREATE TABLE IF NOT EXISTS targets (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('lastfm', 'listenbrainz')),
  credential_enc  TEXT NOT NULL,
  username        TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  needs_reauth    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- Website login sessions. Stores a hash of the cookie value, never the value.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
