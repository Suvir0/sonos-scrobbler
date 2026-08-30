-- Two accounts stop fighting over the same speakers, and an account can be found again.
--
-- These ship together because they are one bug seen from two sides. Sonos is the only
-- identity this service has, so a person who arrives without a session cookie gets a new
-- account — and that new account then linked the same household, the same groups and the
-- same subscriptions as the old one. Since `subscriptions.id` and `sonos_groups.group_id`
-- were keyed by the Sonos id alone, the two accounts overwrote each other's rows:
-- `subscriptions` kept whoever linked first (its upsert never touched `user_id`) while
-- `sonos_groups` kept whoever synced last (its upsert did). The two tables then disagreed
-- about who owned a room, and the dashboard could show healthy subscriptions above zero
-- rooms while somebody else's account received the scrobbles.
--
-- The same collision is what stopped two people in one household from both using the
-- service, which is a thing couples plainly want.

-- 1. Subscriptions are per user.
--
-- The id becomes `${userId}:${scope}:${targetId}:${namespace}`. A user id is base64url
-- and contains no colon, so the prefix is unambiguous even though a Sonos group id
-- (`RINCON_AAA:1`) is not. Nothing parses this id back apart; it is only ever built.
--
-- An incoming event names a group, not a person, so the webhook now looks a subscription
-- up by (scope, target_id, namespace) and delivers to every user who holds one. That is
-- the honest reading of the event: two people listening to the same speaker both heard
-- the same song, and both should get the scrobble.
-- Guarded so re-applying this file cannot prefix an id twice. Unlike an ALTER, an
-- UPDATE succeeds the second time and would quietly corrupt every row.
UPDATE subscriptions SET id = user_id || ':' || id WHERE id NOT LIKE user_id || ':%';

-- 2. Groups are per user.
--
-- SQLite cannot widen a primary key in place, so the table is rebuilt. `player_ids` is
-- carried across: it is what turns a group into the rooms whose switches decide whether
-- it may scrobble, and losing it would silently switch every off room back on.
CREATE TABLE IF NOT EXISTS sonos_groups_rekeyed (
  group_id      TEXT NOT NULL,
  household_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT,
  player_ids    TEXT,
  seen_at       INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

INSERT INTO sonos_groups_rekeyed (group_id, household_id, user_id, name, player_ids, seen_at)
  SELECT group_id, household_id, user_id, name, player_ids, seen_at FROM sonos_groups;

DROP TABLE sonos_groups;

ALTER TABLE sonos_groups_rekeyed RENAME TO sonos_groups;

CREATE INDEX IF NOT EXISTS idx_groups_household ON sonos_groups(household_id);
CREATE INDEX IF NOT EXISTS idx_groups_user ON sonos_groups(user_id);

-- 3. A way back into an account that does not depend on a cookie.
--
-- Without one, "sign in with Sonos" is the only door, and it cannot tell a returning
-- person from a new one — which is what created the duplicate accounts above. This is a
-- long random token the user keeps: visiting its URL signs them back in.
--
-- Two columns for two different jobs, deliberately:
--
--  - `recovery_hash` is an HMAC and is what a presented token is looked up by. It is
--    indexed and unique, and a database dump of it cannot be turned back into a link.
--  - `recovery_enc` is the same token under AES-GCM, so a signed-in person can read
--    their own link back at any time rather than having one chance to copy it at signup.
--    It is no more exposed than the Sonos refresh token already sitting beside it under
--    the same key, and the alternative — showing it once and never again — locks a
--    non-technical user out of their own account for scrolling past a banner.
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
ALTER TABLE users ADD COLUMN recovery_enc TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_recovery ON users(recovery_hash);
