# Scrobbler for Sonos

[![CI](https://github.com/Suvir0/sonos-scrobbler/actions/workflows/ci.yml/badge.svg)](https://github.com/Suvir0/sonos-scrobbler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Your Sonos plays it. Your Last.fm gets it.**

Scrobbling is the habit of keeping a record of the music you listen to. [Last.fm](https://www.last.fm)
and [ListenBrainz](https://listenbrainz.org) are the two places most people keep that
record — you end up with a history of everything you've played, what you listened to most
this year, and recommendations built from it.

Sonos speakers don't do this on their own. This service does it for them.

👉 **[scrobbler.suvir.net](https://scrobbler.suvir.net)**

---

## What it actually does

You connect your Sonos account once. After that, anything your speakers play shows up in
your listening history — automatically, in the background, forever.

It works no matter how the music got started. Someone pressing play in the Sonos app.
Someone pressing the button on the speaker itself. A morning alarm. Asking a voice
assistant. It all counts, because the service is listening to Sonos itself rather than to
any one app.

**There is nothing to install.** No app on your phone, no program on your laptop, nothing
running on a Raspberry Pi in a cupboard. Your computer can be off. You can be on holiday.
It keeps working.

That last part is the unusual bit. Every other Sonos scrobbler runs on a computer in your
house and talks to your speakers over your home network, so it only records music while
that computer is awake and at home. This one runs in the cloud and Sonos pushes the
information to it.

## What you need

Three things, all free:

1. **A Sonos speaker** and the Sonos account you already use with it.
2. **A [Last.fm](https://www.last.fm/join) or [ListenBrainz](https://listenbrainz.org/login/)
   account.** Either one, or both. If you already scrobble from Spotify or your phone,
   you already have one.
3. **Two minutes.**

## Setting it up

**1. Go to [scrobbler.suvir.net](https://scrobbler.suvir.net) and press *Connect*.**
Sonos will ask you to sign in and confirm. This is Sonos's own page, not ours — we never
see your Sonos password.

**2. Connect Last.fm, ListenBrainz, or both.**
Last.fm is another sign-in button. ListenBrainz works differently: it has no sign-in
button of its own, so you copy a token from
[your ListenBrainz settings page](https://listenbrainz.org/settings/) and paste it in.

**3. Save your sign-in link.**
The page shows you a private link near the bottom. Put it in your notes, your bookmarks,
or your password manager.

That third step matters more than it sounds. There is no password and no email address
here — signing in with Sonos *is* the account. But Sonos can't tell us *which person* you
are, only which speakers you can reach, so if you clear your cookies or switch to a new
browser, that link is the only thing that gets you back to your settings. Anyone who has
it can sign in as you, so keep it to yourself. You can replace it at any time from the
same panel, which immediately stops the old one working.

Then play something. Within a couple of minutes the front page will show what's playing
and your history will start filling up.

## When does a song count?

The same rules Last.fm has always used:

- **Half the song, or four minutes** — whichever comes first.
- **Nothing under 30 seconds** ever counts.
- Skipping doesn't count. Neither does pausing something and leaving it. Fast-forwarding
  through a song doesn't turn it into a listen.
- **Radio is different.** Stations don't tell us how long a song is, so a title has to
  play for four minutes straight before it counts. That's deliberately strict — it's what
  stops jingles, adverts and station idents ending up in your history.

## What it refuses to scrobble

Getting a wrong entry into your history is worse than missing a right one, so when it
isn't sure, it stays quiet. Out of the box it will not record:

- **TV and line-in.** Your soundbar playing a film is not a song.
- **Podcasts and audiobooks**, even ones tagged with an artist name.
- **Radio it can't read.** A station announcing "Now playing on Radio 6" tells us nothing,
  so nothing is recorded — rather than inventing an artist.
- **Anything longer than 20 minutes.** A DJ set, a mix, a film soundtrack as one long
  file, a sleep recording. These arrive with a title and an artist just like a song does,
  and almost none of them are one.
- **Music cast from an app** (AirPlay, Spotify Connect and the like). Nothing the speaker
  reports can tell an AirPlayed song apart from an AirPlayed video, and those apps usually
  scrobble their own music anyway, so leaving this off also avoids double entries.

Every one of those last three is a switch on the front page. Turn any of them back on if
you disagree — it's your history.

## Which rooms

Every room is on to begin with. The front page lists your speakers with a switch beside
each one, so you can leave the kitchen scrobbling and stop the office.

When speakers are grouped they're all playing the same thing, so a group only scrobbles
while **every** room in it is switched on. Switching a room off is a promise about that
speaker — not one that quietly lapses the moment somebody groups it with another room.

## What this service keeps about you

**No listening history of its own.** That is the whole design, not a policy sentence. A
track exists here only while it's playing and until Last.fm or ListenBrainz accepts it,
and then it's gone. There is no table in the database to put it in — you can check:
[`migrations/0001_init.sql`](migrations/0001_init.sql) says so in a comment and doesn't
have one.

Your history lives on Last.fm and ListenBrainz, which is where you read it back.

What it does hold: your Sonos permission and your Last.fm/ListenBrainz credentials, all
encrypted; the names of your rooms; your switches; and a handful of timestamps. No
adverts, no analytics, no third-party scripts — not even the fonts come from somewhere
else. The [privacy page](https://scrobbler.suvir.net/privacy) lists every single item.

**Delete everything** on the front page does exactly that, immediately: it tells Sonos to
stop sending events, erases everything in flight, and deletes your account. There's no
hidden copy.

## Questions people ask

**Does it control my speakers?**
No. It only ever reads what's playing. Sonos doesn't offer a read-only permission — the
one they grant covers full control — so the restraint lives in the code: there is not a
single line in it that sends a play, pause, skip or volume command.

**Will I get duplicate entries?**
Not from this. Every play is checked against what's already been sent before it goes. If
you also scrobble from the Spotify app on your phone and cast to a Sonos, leave *Music
cast from an app* switched off and Spotify will handle those.

**Two of us share the house — can we both use it?**
Yes. You each connect your own Sonos account and each get your own history. When you're
both listening to the same speaker, you both get the scrobble.

**What if the service is down when I'm listening?**
Plays that have been earned are queued and delivered when things recover. Last.fm being
down doesn't hold up ListenBrainz, or the other way round.

**Is it free?**
Yes, and the source is right here under the MIT licence. You can run your own copy.

**Do I need to keep the tab open?**
No. Close it. The front page is a status display, not the thing doing the work.

## Something's not working

- **Nothing is scrobbling at all.** Open *Account* at the bottom of the front page and
  press **Rescan rooms**. That re-finds your speakers and re-subscribes them, and it's the
  fix for a speaker you bought after signing up.
- **The page says a connection was rejected.** Last.fm and ListenBrainz credentials can be
  revoked from their end. The row will show a Connect button again — press it.
- **A room is missing.** A speaker that's unplugged or off the network won't appear until
  it's back. Then rescan.
- **You've lost your sign-in link and your cookies.** There is no way back to that
  account, and connecting Sonos again starts a fresh one. Your history on Last.fm is
  untouched — it's only these settings that are gone.
- **Still stuck, or found a security problem?** <hello@suvir.net>.

Not affiliated with, endorsed by, or sponsored by Sonos, Last.fm or MetaBrainz. Sonos is a
trademark of Sonos, Inc.

<br>

---
---

<br>

# For whoever runs it

Everything below is for deploying and maintaining this, not for using it.

It is a single Cloudflare Worker: static pages, an event endpoint, three Durable Object
classes and a D1 database. No build step and no framework.

```
Sonos cloud ──POST──▶ /webhooks/sonos ──▶ GroupSession DO ──▶ UserQueue DO ──▶ Last.fm
                      verify, ack 200     anchored clock      durable queue      ListenBrainz
```

## Setting up credentials

Do these in order. Steps 1 and 2 must be done before anything can be tested end to end.

### 0. Pick the public URL first

Everything below hard-codes it, and changing it later means re-registering URLs in two
portals. The working default is `https://scrobbler.suvir.net`.

`suvir.net` must be on Cloudflare DNS for the custom-domain route, which is what provisions
the CA-signed certificate the Sonos event callback requires. `wrangler.jsonc` ships configured
for it: `workers_dev: false` and a `routes` entry for `scrobbler.suvir.net`. To deploy
somewhere else, change `PUBLIC_BASE_URL` in `vars`, the `routes` entry (or set
`workers_dev: true` and delete it), **and** both URLs in the Sonos portal — they must match
byte for byte.

### 1. Sonos — a new Control Integration

Portal: <https://developer.sonos.com>

1. Sign in with your Sonos account.
2. **New control integration.** Create a new one rather than editing any integration that
   already exists on the account.
3. Enter **Name** `Scrobbler for Sonos`, a **Description** and a **Category**.
   - The name is what users see on the Sonos consent screen, so it must read as this
     product and nothing else.
   - ⚠️ The **Company Name** field appears to be organization-level and is shared with
     every other integration on the account. Confirm whether editing it renames those
     before you touch it. If unsure, leave it.
4. **Continue** → enter a key name (e.g. `scrobbler-prod`) → **Save**.
5. Copy the **Client ID** and **Client Secret**. The secret is shown once.
6. **Add redirect URI** → `https://scrobbler.suvir.net/auth/sonos/callback`
7. **Event Callback URL** (a separate field) → `https://scrobbler.suvir.net/webhooks/sonos`
   - Must be HTTPS with a CA-signed certificate, TLS 1.2, HTTP/1.1 keep-alive. A Workers
     custom domain satisfies all four.

Verified details this implementation relies on:

| | |
|---|---|
| Authorize | `GET https://api.sonos.com/login/v3/oauth` |
| Scope | `playback-control-all` (the only one Sonos offers) |
| Token exchange | `POST https://api.sonos.com/login/v3/oauth/access`, Basic auth |
| Access token life | 24h; the **refresh token is stable**, so users authorize once |
| API gateway | `https://api.ws.sonos.com/control/api/v1` |
| Rate limit | **1,000 req/min per application**, 100/s spike arrest |

### 2. Last.fm — an API account

Portal: <https://www.last.fm/api/account/create> (log in first)

Fields: contact email, application name, description, homepage
(`https://scrobbler.suvir.net`), and **Callback URL**
`https://scrobbler.suvir.net/auth/lastfm/callback`.

The callback *is* required — this service uses Last.fm's **web** auth flow, not the desktop
polling flow. The key and shared secret are issued instantly with no review. Session keys
obtained through it never expire.

### 3. ListenBrainz — nothing to register

There is no app registration and no client ID. Each user pastes their own token from
<https://listenbrainz.org/settings/>; the service validates it against
`GET /1/validate-token` and submits with `Authorization: Token <token>`.

### 4. Cloudflare

```bash
npx wrangler d1 create sonos-scrobbler
```

Put the printed `database_id` into `wrangler.jsonc`, then apply the schema:

```bash
npm run db:remote
```

That is `wrangler d1 migrations apply`, so it applies only what is missing and records
what it applied in a `d1_migrations` table. Running it twice is a no-op, which is what
makes it safe to run on every deploy.

Then the secrets:

```bash
for s in SONOS_CLIENT_ID SONOS_CLIENT_SECRET LASTFM_API_KEY LASTFM_API_SECRET TOKEN_ENCRYPTION_KEY SCROBBLE_KEY_SALT SESSION_SECRET; do npx wrangler secret put "$s"; done
```

The three cryptographic secrets must each be 32 random bytes, base64:

```bash
openssl rand -base64 32
```

| Secret | Purpose |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | AES-GCM key for OAuth credentials and sign-in links at rest. **Rotating it locks every user out.** |
| `SCROBBLE_KEY_SALT` | HMAC key for scrobble dedupe identities |
| `SESSION_SECRET` | HMAC key for session cookie and sign-in link lookup |

For local development copy `.dev.vars.example` to `.dev.vars` and fill it in.

### Upgrading a database that predates tracked migrations

Only for a database that already had `0001`–`0005` applied by hand, before `db:remote`
became `wrangler d1 migrations apply`. It has no `d1_migrations` table, so wrangler would
try to re-run everything and stop on `duplicate column name`.

Run this **once**, then `npm run db:remote` as normal:

```bash
npm run db:adopt
```

It creates the tracking table and marks `0001`–`0005` as already applied. A fresh database
must not be adopted — for that, `npm run db:remote` alone is correct.

## How it works

### The elapsed-time clock

Last.fm accepts a scrobble once a track has played for half its length or four minutes,
whichever comes first, and never under 30 seconds. Measuring that is the hard part, because
Sonos sends **no events while a track plays normally** — a four-minute song can produce two
events total.

So the clock is *anchored*. Every `playbackStatus` carries `positionMillis`, which re-syncs the
session to a real position; the time between events is credited from how far the track actually
advanced, bounded by how much wall time passed. That bound is what stops a forward seek counting
as listening. On a track change, `previousPositionMillis` gives Sonos's own reading of how far
the outgoing track got, which beats anything derived.

See `src/scrobble/session.ts`. The seek, pause and long-gap cases are covered in
`src/scrobble/session.test.ts`.

### Reliability

Sonos retries a failed delivery once a second, three times, then **discards the event
permanently** — no replay, no dead-letter queue. Two consequences shape the code:

- `/webhooks/sonos` verifies and acknowledges before doing any work; everything else runs in
  `waitUntil`. It answers 200 even to events it rejects, because a 4xx buys nothing and turns
  every odd payload into three more of them.
- A Durable Object alarm is set for when each track should have ended. If it fires with no
  track-change event, the event was dropped and the session is closed rather than left to
  invent listening time.

Subscriptions lapse after three days. The cron renews a slice ordered by `next_renewal_at`
every 15 minutes, within a call budget — the 1,000 req/min quota is **per application, shared
across all users**, so a sweep over everybody at once would take the whole service down.

### The webhook signature

SHA-256 over `seqId ‖ namespace ‖ type ‖ targetType ‖ targetValue ‖ clientId ‖ clientSecret`,
base64url, unpadded. **It does not cover the request body** — it proves the sender knows the
secret, nothing more. `subscriptions.last_seq_id` is a per-subscription high-water mark that
rejects a replayed request carrying different content.

### Identity, and who an event belongs to

A Sonos event names a group or a household. It never names a person, and a household can
have more than one member — so the same target legitimately has more than one subscriber.
`subscriptions.id` and `sonos_groups` are keyed by user as well as by Sonos id (migration
`0006`), the `GroupSession` Durable Object is named `${userId}:${groupId}`, and the webhook
delivers one event to every subscriber, each in isolation from the others' failures.

Before that they were keyed by the Sonos id alone. Two accounts on one household then
overwrote each other's rows — asymmetrically, since `subscriptions` kept whoever linked
first and `sonos_groups` kept whoever synced last — so the two tables disagreed about who
owned a room and one person's dashboard showed healthy subscriptions above zero rooms while
somebody else received their scrobbles.

The second account was rarely a second person. Sonos is the only identity here, so anyone
arriving without a session cookie got one. `src/lib/recovery.ts` is what removes that: a
long random token the user keeps, stored as an HMAC for lookup and encrypted so the page
can show it back. `GET /auth/recover?key=…` exchanges it for a session.

### Guarding the shared quota

Sonos allows 1,000 requests/minute **per application**, not per user, so one account's
runaway starves everyone. `src/sonos/budget.ts` refuses locally at 600/min and 20/sec —
*before* the request goes out — so a bug costs a rejected promise rather than a slice of
everybody's allowance. Its test replays the real incident (993 requests in 35 seconds)
and asserts it gets refused.

### Why every request runs the Worker

`assets.run_worker_first` is `true` in `wrangler.jsonc`, so even a request that ends up
being a static file goes through the Worker first. That is not a routing preference: it is
the only way the security headers in `src/lib/http.ts` reach the pages they exist for.

Left to itself the asset router answers before the Worker runs, and `/`, `/privacy` and the
stylesheet were all served with **no** Content-Security-Policy and no `frame-ancestors
'none'` — on the one page carrying a delete-everything button and a token field. The unit
test asserting otherwise passed the whole time, because a test calls the Worker directly
and never goes through the asset router at all. `npm run check:assets` now asserts the flag
itself, since that is the invariant the test depends on.

## Layout

| Path | |
|---|---|
| `src/index.ts` | routing, the origin check, and the scheduled renewal sweep |
| `src/lib/http.ts` | response helpers, the security headers, the same-origin check |
| `src/lib/recovery.ts` | the sign-in link — the way back into an account without a cookie |
| `src/lib/identity.ts` | the product name, version and User-Agent, in one place |
| `src/routes/settings.ts` | the playback-source opt-outs |
| `src/rooms.ts` | which rooms may scrobble, and resolving that to a group |
| `public/` | the front page, privacy and terms pages, 404, icons, manifest |
| `public/fonts/` | Archivo and IBM Plex Mono, self-hosted — see `fonts/README.md` |
| `src/scrobble/session.ts` | the anchored clock — **the core of the service** |
| `src/scrobble/rules.ts` | Last.fm's thresholds |
| `src/scrobble/queue.ts` | durable queue with backoff, batch bisection, hashed dedupe |
| `src/scrobble/{lastfm,listenbrainz}-client.ts` | the two targets |
| `src/sonos/classify.ts` | what is music and what is a podcast, TV or unparseable radio |
| `src/sonos/events.ts` | signature verification and the replay guard |
| `src/sonos/{oauth,account,client}.ts` | authorization, token refresh, Control API |
| `src/subscriptions.ts` | subscribe, renew, follow group changes |
| `src/routes/webhook.ts` | event verification, and fan-out to every subscriber |
| `migrations/0005_room_choice.sql` | per-room scrobbling, and the song-length ceiling |
| `migrations/0006_identity.sql` | per-user subscriptions, and the sign-in link |
| `src/do/` | Durable Objects: group session, user queue, OAuth state |
| `src/sonos/budget.ts` | our own request ceiling, below Sonos's shared quota |
| `src/testing/replay.ts` | the event replay harness — see below |

`target.ts`, `queue.ts`, `lastfm-client.ts` and `listenbrainz-client.ts` are ported from a
desktop scrobbler along with their test suites. `queue.ts` gained an
injectable dedupe key so this deployment can store HMACs instead of track titles.

### Testing against reality, not against fixtures

Three production bugs got through a passing test suite because every test fed the code
inputs invented from the documentation, at a cadence nothing real produces. The replay
harness (`src/testing/replay.ts`) exists to close that gap. It drives the **real**
Durable Object on a **virtual clock**, and after every step it reads the object's own
scheduled alarm and fires it at the scheduled instant — so alarm-driven behaviour is
exercised rather than assumed, and a four-minute threshold is tested in a millisecond.

The property that matters most is **sparseness**. A test that sends two events four
minutes apart, the way Sonos really does, is what catches the class of bug where the
elapsed clock silently discards everything between them:

```ts
const result = await replay(stub, [
  trackStart(0, SONG),                        // metadata + playbackStatus at position 0
  trackStart(180_000, NEXT, 179_000)          // ...and nothing at all in between
]);
expect(timesScrobbled(result, 'Come Down')).toBe(1);
```

`src/do/group-session.test.ts` covers pause-for-an-hour, forward seek, event ordering
races, radio's four-minute rule, TV audio, lost mid-track events recovered from
`previousPositionMillis`, and an explicit assertion that no run produces an alarm storm.

The one thing the suite cannot reach is the asset router, which sits in front of the
Worker in production and not in tests. `npm run check:assets` covers that gap by asserting
on the config instead.

## Development

```bash
npm install && npm test
```

257 tests across 14 files, all against the real Durable Object and D1 implementations via
`@cloudflare/vitest-pool-workers` rather than mocks of them.

```bash
npm run check:assets
```

Checks the static pages: every reference local and present, no remote subresource the
content security policy would block at runtime, the two font licences still shipping, and
`run_worker_first` still on. There is no build step, so nothing else would catch a page
pointing at a file that is not there. CI runs it alongside the tests and the type check.

```bash
npm run dev
```

`npm run type-check` runs `tsc --noEmit`.

## Legal notes worth reading before launch

Sonos's developer terms, **§3(a)**: *"Do not collect or record content data (including data
about specific music services, albums, playlists or songs)..."* The zero-retention design is
the mitigation and is why there is no history table, why dedupe keys are hashed, and why the
logger drops any field named `artist`, `track` or `album`. It reduces the risk; it does not
eliminate it. Worth confirming with Sonos developer support before opening signups.

**§5(c)–(d)** prohibit implying Sonos endorsement or using their marks adversely — hence the
footer disclaimer, and a reason to keep "Sonos" out of the product name itself.

**§8(b)** requires giving users control over their own data, which is what `DELETE
/api/account` is for: it unsubscribes from Sonos, wipes both Durable Object classes, and
deletes the user row that every other table cascades from. The sign-in link is part of the
same obligation: an account nobody can reach is an account nobody can delete.

**§2(b)**'s separate-commercial-license requirement applies to the **LAN** APIs, not the Cloud
ones this service uses. §2(c) may still require an additional license for commercial use.

## Public endpoints

| | |
|---|---|
| `GET /` | the whole product: link accounts, see status, change settings |
| `GET /privacy`, `GET /terms` | what is stored and under what terms |
| `GET /healthz` | round-trips encryption and both HMAC keys, touches D1, checks the schema |
| `GET /colophon` | what it is built from, and under which licences |
| `GET /.well-known/security.txt` | RFC 9116; served from the Worker, not `public/` |
| `POST /webhooks/sonos` | the Sonos event callback |
| `/auth/sonos/*`, `/auth/lastfm/*`, `POST /auth/listenbrainz` | linking |
| `GET /auth/recover?key=…` | signs a browser back in from a saved link |
| `GET\|POST /api/recovery` | read that link, or replace it |
| `GET /api/account`, `DELETE /api/account` | status, and delete everything |
| `GET\|PUT /api/settings` | radio, cast-playback and long-track opt-outs |
| `GET\|PUT /api/rooms` | which rooms are allowed to scrobble |
| `POST /api/resync` | re-discover rooms and re-subscribe |

The front end is the Claude Design comp, built as static assets with no framework and no
build step. Its two typefaces are served from this domain: the content security policy
forbids remote origins, and the privacy page's claim that no page makes a third-party
request would otherwise be false, since a webfont fetch carries the visitor's IP and the
page they are reading to whoever serves it.

Every response carries a content security policy that forbids remote script, style,
images and connections, plus `frame-ancestors 'none'` — the dashboard has a
delete-everything button, and clickjacking it is unrecoverable. Every state-changing
method is refused unless its `Origin` is this site, on top of the `SameSite=Lax` cookie.

## Before opening signups

- [ ] `npm test`, `npm run type-check` and `npm run check:assets` clean.
- [ ] `npm run db:adopt` run **once** if the production database predates tracked
      migrations, then `npm run db:remote` reports no migrations to apply.
- [ ] All seven secrets set (`wrangler secret list`), and `GET /healthz` returns `ok` —
      not just 200, the body's `status`.
- [ ] Sonos portal: redirect URI and Event Callback URL both point at the deployed
      origin, exactly. A trailing slash difference fails the OAuth exchange.
- [ ] Last.fm portal: callback URL matches, homepage set.
- [ ] Link a real account end to end, play a track, and confirm **Last scrobble** moves
      on the status page. A green tick with `never` next to it means the pipeline is
      not connected.
- [ ] Confirm the sign-in link works from a browser with no cookies at all — a private
      window is enough. It is the only route back into an account.
- [ ] Point an uptime check at `/healthz` that alerts on the body's `status`, not just
      on a 200, and add a Cloudflare notification on Worker error rate.
- [ ] Confirm the zero-retention design with Sonos developer support before opening
      signups — the legal notes above are why.
- [ ] `TOKEN_ENCRYPTION_KEY` is backed up somewhere you will still have it in a year.
      Rotating it locks every existing user out permanently.

## Known limits, and why they are limits

### A user who loses both their cookie and their sign-in link cannot be recovered

By design. Matching on household id would be the obvious alternative and is worse than the
problem: a Sonos household can have more than one member, so adopting an existing account
whose household matches would hand one person another person's Last.fm session key.

So the remaining loss is bounded and honest — connect Sonos again and you get a fresh
account, while the old one keeps a live Sonos grant nobody is watching. Adding a second
factor the user controls (an email magic link) would close it entirely; the sign-in link
was chosen first because it needs no mail infrastructure and no address on file.

### The request budget is per isolate, not global

`src/sonos/budget.ts` refuses at 600/min and 20/sec inside one isolate. At one household
that is the whole application. At public traffic it is not: several isolates each holding
their own 600/min ceiling can sum past Sonos's shared 1,000/min before any one of them
notices. A Durable Object holding the counter is the fix, and it costs a hop on every
Sonos request — worth paying once traffic is past one isolate's worth, not before.

### Nothing pages anybody

`GET /healthz` round-trips the encryption and both HMAC keys, touches D1, and names any
column the deployed code needs that the database lacks. It distinguishes "200 but
degraded" from "ok" in the body rather than the status alone. But nothing watches it.
Before signups: point an uptime check at it that alerts on the body's `status`, and add a
Cloudflare notification on Worker error rate. A cron run reporting `failed > 0` and a
`waitUntil` that throws are both `console.warn` lines and nothing more.

## Deploying

No trailing `#` comments in any of the commands below. An interactive `zsh` — the
default shell on macOS — does not treat `#` as a comment unless `interactive_comments`
is set, so a pasted `npm run db:remote  # first deploy only` passes the words after the
`#` to wrangler as arguments and the command fails without running.

**Deploy the schema before the code.** A Worker deploy and a D1 migration are separate
steps, and code that reads a column its database does not have yet answers 500 from
`/api/account` — a blank dashboard for everyone. `/healthz` names the missing column if
this happens, but the ordering is what avoids it.

Once, as the account that owns the domain:

```bash
npx wrangler login
```

Then, every deploy — it is a no-op when there is nothing new:

```bash
npm run db:remote
```

```bash
npm run deploy
```

Confirm it actually works rather than merely responds. Read the body, not the status
code: a 200 carrying `"status": "degraded"` is a Worker that is up and cannot scrobble.

```bash
curl -s https://scrobbler.suvir.net/healthz
```

```bash
curl -s https://scrobbler.suvir.net/.well-known/security.txt
```

`checks.schema` names any column the deployed code needs and the database lacks;
`checks.config` names any secret that is unset; `checks.encryption` fails when
`TOKEN_ENCRYPTION_KEY` does not decode to exactly 32 bytes.

Confirm the security headers reached the *page*, not just the API — this is the one that
was wrong in production while a unit test said otherwise:

```bash
curl -sI https://scrobbler.suvir.net/ | grep -i content-security-policy
```

Check what actually shipped, too — a deploy from a stale checkout is silent:

```bash
npx wrangler deployments list
```

The asset count in the deploy output is the quickest tell. This branch has sixteen files
under `public/`; if wrangler reports reading one, it is deploying an old commit.

## Licence

MIT — see [`LICENSE`](LICENSE). You can read it, run your own copy, and change it.

The MIT licence covers the source only. The two bundled typefaces, **Archivo** and **IBM
Plex Mono**, are under the SIL Open Font License 1.1 and ship with their own licence
files in `public/fonts/`, which that licence requires. [`NOTICE`](NOTICE) has the full
attribution, including the trademark position on Sonos, Last.fm and ListenBrainz.

Being able to read the source is what makes the privacy page checkable rather than
merely stated: that there is no history table is a fact about `migrations/0001_init.sql`,
not a promise.

- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability, and what is already known.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — what this codebase asks of a change.
- [`CHANGELOG.md`](CHANGELOG.md) — what shipped, and when.
