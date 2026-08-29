-- Timestamps that make a silent pipeline visible.
--
-- Every failure found in the first live run presented as nothing happening, over a UI
-- that showed a healthy green tick. These two columns are what let the service tell
-- the difference between "quiet because nobody is listening" and "quiet because it is
-- broken" — the distinction the status page could not previously draw.
--
-- Timestamps only. Not content data: no title, artist, or album is recorded here, and
-- adding one would breach the retention promise the schema is built around.
ALTER TABLE subscriptions ADD COLUMN last_event_at INTEGER;
ALTER TABLE users ADD COLUMN last_scrobble_at INTEGER;
