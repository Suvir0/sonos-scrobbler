# Changelog

## Unreleased

**One person's plays are no longer scrobbled twice.** Sonos names speakers, not
people, so somebody returning without a session cookie — cleared it, new browser,
or simply past the 30-day session — is handed a new account that then links the
same household, groups and subscriptions as the old one. `dispatch` delivers each
event to every subscriber, so both accounts ran their own play clock and both
submitted to the same Last.fm account; the per-user dedupe cannot see across
accounts and Last.fm only collapses an exact timestamp match, so two clocks a
second apart both landed. Found in production as four user rows for one person,
two of them live and mirroring each other exactly.

The fix does not try to tell the two cases apart from Sonos, because Sonos cannot:
it tests whether two accounts on a *shared household* submit to the *same service
account*. A couple have two Last.fm accounts and a duplicate has one, so the test
fires exactly when plays would double and stays silent when they would not —
including for somebody with two separate Sonos homes pointed at one Last.fm. The
newest link wins and the older target is disabled rather than deleted: reversible,
symmetric (reconnecting on the older account moves it back), and it grants nothing
— the losing account keeps its Sonos grant, its sign-in link and its delete button.

**A rejected credential now says why it was rejected.** ListenBrainz answers
`validate-token` with `valid: true` for a token belonging to a MetaBrainz account
with no verified email address, then answers `submit-listens` with 401 and a
paragraph naming the cause and linking the fix. `UserQueue.flush` discarded that
paragraph and set a boolean, so the page offered its one hardcoded sentence — "the
credentials were rejected" — which advises reconnecting, the single action that
provably cannot help when the token validates every time. Pasting it again
succeeded, the next play 401'd again, and the loop had no exit and no clue in it.
The service's own words are now stored on `targets.last_error` and shown in place
of the guess.

**Nothing ever cleared `needs_reauth`.** Only a fresh credential did, so fixing the
actual cause — verifying the email, waiting out an outage — left the page reporting
a rejected credential until the user happened to re-paste a token that was never
the problem. A delivery that lands now clears both the flag and the message, which
is the only honest proof the credential works.

**A transient failure is no longer reported as a dead credential.** A retryable
outcome records the service's explanation without setting `needs_reauth`, so a 503
reads as an outage rather than sending somebody off to re-paste a working token.

Note for operators: this adds `targets.last_error`, and `/api/account` selects it.
Apply `0007_target_error.sql` before deploying, or `/healthz` will report
`degraded` with the column named — which is what that check is for.

## 1.1.0 — 30 August 2026

Everything in this release was found by testing the deployed service rather
than the test suite. Three of these were wrong in production while a passing
test reported them fine.

**A working scrobble reported itself as no scrobble at all.** `last_scrobble_at`
and the `scrobble.enqueued` log lived in the webhook handler, so they only fired
for a play earned by an incoming event. Sonos sends nothing while a track plays
normally — the premise the anchored clock exists for — so the threshold is
almost always crossed by the Durable Object's own alarm, which never reaches
that handler. The status page therefore read "Last scrobble: never" over a
pipeline delivering plays correctly, which is the one reading the README tells
an operator to trust. Both now live in `GroupSession.enqueue`, the single place
every earned play passes through.

**A room switched off was scrobbling anyway.** `groupMayScrobble` permitted
unknown group membership unconditionally. That is right for a group just
created and wrong when the membership was simply never recorded — which is what
production looked like: every group carrying a null `player_ids`, two rooms
switched off, both scrobbling. Unknown membership is now permitted only for a
user who has switched nothing off, and `/api/account` reports the condition so
the page says a rescan is needed rather than going quiet.

**The security headers never reached a single page.** `assets.run_worker_first` listed
only the API and callback paths, so every static page — including the dashboard, which
carries a delete-everything button and a token field — was answered by the asset router
before the Worker ran, with no Content-Security-Policy, no `frame-ancestors 'none'`, no
HSTS and no `nosniff`. The test asserting the opposite passed the entire time: a test
calls the Worker directly and never goes through the asset router at all. Now `true`, so
every request runs the Worker, and `check-assets.mjs` asserts the flag rather than
enumerating routes — which also deletes the route-coverage check it replaces.

**Two accounts on one household stopped destroying each other.** `subscriptions.id` and
`sonos_groups` were keyed by the Sonos id alone, so a household with two members — or,
far more often, one person who returned without a session cookie and was handed a second
account — had two accounts writing to the same rows. Asymmetrically: `subscriptions`
kept whoever linked first because its upsert never touched `user_id`, while
`sonos_groups` kept whoever synced last because its upsert did. The two tables then
disagreed about who owned a room, and a dashboard could show healthy subscriptions above
zero rooms while somebody else's account received the scrobbles. Both are keyed by user
as of migration `0006`, the `GroupSession` object is named per user and group, and one
event is now delivered to every subscriber, each isolated from the others' failures.
Deleting an account no longer cancels a Sonos subscription another account still needs.

**A sign-in link, so an account can be found again.** There is no password and no email
here, and nothing Sonos returns identifies a person — only which speakers they can reach,
which their household's other members can reach too. A cleared cookie therefore meant a
new account, with the old one left holding a live Sonos grant and an encrypted Last.fm
key its owner could no longer see, delete, or stop from scrobbling. Every account now has
a private link it can be reached by: an HMAC for lookup, encrypted alongside so the page
can show it back rather than offering one chance to copy it at signup.

**Migrations apply themselves now.** `db:remote` was a shell loop over every `.sql` file
that stopped on the first `duplicate column name`, which meant it could not be used to
apply a *new* migration to a database that already had the earlier ones — the exact thing
it existed for. It is `wrangler d1 migrations apply`, which tracks what it has applied and
is a no-op when there is nothing new. `npm run db:adopt` marks `0001`–`0005` as applied on
a database that predates the change; it is needed exactly once.

**Fixed, in the front page.** Pressing Save on the ListenBrainz box with nothing in it
replaced the whole app with a raw JSON error at a dead-end URL — the one endpoint reached
by an ordinary form submission rather than by `fetch`, and the only one that answered with
a JSON body instead of a redirect. A Last.fm or ListenBrainz credential rejected while the
page was open said "reconnect needed" above no button, because the row's button had been
hidden when it first connected and only the Sonos row knew how to bring one back. The
rooms panel was drawn once and never again, so an account whose speakers were still being
discovered when the first poll landed hid it permanently. The success banner read "lastfm
connected." The Sonos row showed a Connect button under a banner saying Sonos had just
connected. Rescan answered a button non-technical users are told to press with a JSON
dump. `apple-touch-icon` pointed at an SVG, which iOS ignores.

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
