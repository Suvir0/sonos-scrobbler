# Changelog

## 1.0.0 — first public release

**Identity.** Named Scrobbler for Sonos throughout, including the `media_player`
field recorded against every ListenBrainz listen, which previously carried the
name of the desktop app this borrowed its queue and clients from. Outbound
requests now send a contactable User-Agent, which Last.fm and ListenBrainz both
ask for.

**Front end.** Rebuilt to the Claude Design comp: warm paper, no rounded
corners, 2px rules, Archivo and IBM Plex Mono self-hosted. Mobile-first layout
and a dark mode, neither of which the comp covers. Verified by rendering across
four viewports and both colour schemes.

**Settings.** `scrobble_radio` and `allow_handoff` had been in the schema and
read on every event since the first migration with nothing able to set them, so
every account ran on the defaults. `GET|PUT /api/settings` and two toggles.

**Security.** A content security policy that forbids every remote origin, an
Origin check on every state-changing method, `frame-ancestors 'none'`, and HSTS.
`/api/*` answers 401 JSON rather than redirecting to HTML.

**Reliability fixes.**
- A failed subscribe never moved `next_renewal_at`, so the renewal sweep
  reselected it every fifteen minutes forever and could crowd out subscriptions
  that would have succeeded. It now backs off, doubling.
- `syncHousehold` had no internal call ceiling, so one large household could
  spend the whole run's budget against a quota shared with live traffic.
- The IDLE branch forced the event's own `positionMillis` in as ground truth;
  Sonos reports 0 there as often as a real position, dropping earned scrobbles.
- The backstop alarm was measured from now rather than from the anchor.
- A revoked Sonos grant was indistinguishable from an outage and was retried
  every six hours forever. It is now its own state, shown on the page.
- Account status read one Durable Object per group in series on a poll that runs
  every fifteen seconds.

**Removed.** `lib/musicbrainz.ts` and `escapeHtml`, neither of which had a
caller.

**Documentation.** MIT licence, third-party notices, a security policy, a
contributing guide, and a launch checklist and Known limits section in the
README.
