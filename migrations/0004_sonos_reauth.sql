-- A first-class "your Sonos connection is dead" signal.
--
-- Last.fm and ListenBrainz each have `targets.needs_reauth`, so a rejected credential
-- shows on the status page as something the user can act on. The Sonos grant — the one
-- without which nothing works at all — had no equivalent. A revoked grant therefore
-- looked exactly like a transient Sonos outage: the renewal sweep backed off and
-- retried it every six hours forever, and the page kept showing a connected household.
ALTER TABLE sonos_accounts ADD COLUMN needs_reauth INTEGER NOT NULL DEFAULT 0;
