# Changelog

## Unreleased

**Every route was unreachable from a browser.** With `not_found_handling` set, the
Cloudflare asset router answers a navigation request that matches no file before the
Worker runs, so "Connect Sonos", "Connect Last.fm", both OAuth callbacks and `/healthz`
served the static 404 page to anyone clicking them. curl and the dashboard's own
`fetch()` were unaffected, which is why nothing caught it: neither sends
`Sec-Fetch-Mode: navigate`. Fixed with an explicit `assets.run_worker_first` list, and
`check-assets.mjs` now fails when a route in `src/index.ts` is missing from it.

**Per-room scrobbling.** Every speaker has its own switch. Sonos sends events per
group, and a group is torn down and recreated whenever somebody links rooms together,
so the preference is stored against the player id (the speaker, which is stable) and
resolved to a group at the moment an event arrives. A group scrobbles only while every
room in it is on, which makes switching a room off a promise about that speaker rather
than one that lapses the moment it is grouped with another. A room that is switched off
drops whatever it had in flight rather than finishing it.

**A ceiling on how long a song may be.** TV, line-in, podcasts and audiobooks were
already refused, and playback cast from an app — how a YouTube video usually reaches a
Sonos — is off by default. What still got through was a long file wearing a title and
an artist: a DJ set, a mix, a film soundtrack as one item, a sleep recording. Anything
reporting more than twenty minutes is now refused, as a setting rather than a rule,
because an hour-long live set is somebody's real listening. Radio is never affected: it
reports the stream's length rather than the song's, and that figure was already
discarded.

**Copy.** The page text rewritten throughout to drop the em dashes, the
three-fragment headline and the subjectless sentences.

**Fixed.** `check-assets.mjs` read `public/` through `URL.pathname`, so it crashed on
any checkout whose directory name contains a space. The README's Sonos portal link had
lost its scheme and rendered as literal text.

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
