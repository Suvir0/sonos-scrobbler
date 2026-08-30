# Scrobbler for Sonos

[![CI](https://github.com/Suvir0/sonos-scrobbler/actions/workflows/ci.yml/badge.svg)](https://github.com/Suvir0/sonos-scrobbler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Scrobbles what your Sonos speakers play to **Last.fm** and **ListenBrainz**, with nothing
running at home. Sonos's cloud pushes playback events to this service; it derives how long
each track was actually listened to and submits the ones that qualify.

Every other Sonos scrobbler runs on your own hardware over the LAN. This one does not, which
means it also captures playback started from a phone, a speaker button, an alarm or a voice
assistant.

**It keeps no listening history.** A track exists here only while it is playing and until the
services accept it. Read `migrations/0001_init.sql` — there is deliberately no history table.

---

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

Portal: <developer.sonos.com>

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

Put the printed `database_id` into `wrangler.jsonc`, then apply the schema and set secrets:

```bash
npm run db:remote
```

That applies **every** file in `migrations/` in order, not just the first — the two later
migrations add columns the status page reads, and a database missing them fails at runtime
rather than at deploy. The `ALTER TABLE` statements in them are not idempotent, so the
script is a first-apply tool: running it twice stops on "duplicate column name", which is
the correct outcome for an already-migrated database.

```bash
for s in SONOS_CLIENT_ID SONOS_CLIENT_SECRET LASTFM_API_KEY LASTFM_API_SECRET TOKEN_ENCRYPTION_KEY SCROBBLE_KEY_SALT SESSION_SECRET; do npx wrangler secret put "$s"; done
```

The three cryptographic secrets must each be 32 random bytes, base64:

```bash
openssl rand -base64 32
```

| Secret | Purpose |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | AES-GCM key for OAuth credentials at rest. **Rotating it locks every user out.** |
| `SCROBBLE_KEY_SALT` | HMAC key for scrobble dedupe identities |
| `SESSION_SECRET` | HMAC key for session cookie lookup |

For local development copy `.dev.vars.example` to `.dev.vars` and fill it in.

---

## How it works

```
Sonos cloud ──POST──▶ /webhooks/sonos ──▶ GroupSession DO ──▶ UserQueue DO ──▶ Last.fm
                      verify, ack 200     anchored clock      durable queue      ListenBrainz
```

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

---

## Layout

| Path | |
|---|---|
| `src/index.ts` | routing, the origin check, and the scheduled renewal sweep |
| `src/lib/http.ts` | response helpers, the security headers, the same-origin check |
| `src/lib/identity.ts` | the product name, version and User-Agent, in one place |
| `src/routes/settings.ts` | the two playback-source opt-outs |
| `public/` | the front page, privacy and terms pages, 404, icon, manifest |
| `public/fonts/` | Archivo and IBM Plex Mono, self-hosted — see `fonts/README.md` |
| `src/scrobble/session.ts` | the anchored clock — **the core of the service** |
| `src/scrobble/rules.ts` | Last.fm's thresholds |
| `src/scrobble/queue.ts` | durable queue with backoff, batch bisection, hashed dedupe |
| `src/scrobble/{lastfm,listenbrainz}-client.ts` | the two targets |
| `src/sonos/classify.ts` | what is music and what is a podcast, TV or unparseable radio |
| `src/sonos/events.ts` | signature verification and the replay guard |
| `src/sonos/{oauth,account,client}.ts` | authorization, token refresh, Control API |
| `src/subscriptions.ts` | subscribe, renew, follow group changes |
| `migrations/0004_sonos_reauth.sql` | the flag that says a Sonos grant was revoked |
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

### Guarding the shared quota

Sonos allows 1,000 requests/minute **per application**, not per user, so one account's
runaway starves everyone. `src/sonos/budget.ts` refuses locally at 600/min and 20/sec —
*before* the request goes out — so a bug costs a rejected promise rather than a slice of
everybody's allowance. Its test replays the real incident (993 requests in 35 seconds)
and asserts it gets refused.

## Development

```bash
npm install && npm test
```

`npm run check:assets` checks the static pages: every reference local and present, no
remote subresource the content security policy would block at runtime, and the two font
licences still shipping. There is no build step, so nothing else would catch a page
pointing at a file that is not there. CI runs it alongside the tests and the type check.

```bash
npm run dev
```

`npm run type-check` runs `tsc --noEmit`. Tests use `@cloudflare/vitest-pool-workers`, so the
Durable Objects and D1 are the real implementations rather than mocks.

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
deletes the user row that every other table cascades from.

**§2(b)**'s separate-commercial-license requirement applies to the **LAN** APIs, not the Cloud
ones this service uses. §2(c) may still require an additional license for commercial use.

---

## Public endpoints

| | |
|---|---|
| `GET /` | the whole product: link accounts, see status, change settings |
| `GET /privacy`, `GET /terms` | what is stored and under what terms |
| `GET /healthz` | round-trips encryption and both HMAC keys, touches D1 |
| `GET /colophon` | what it is built from, and under which licences |
| `GET /.well-known/security.txt` | RFC 9116; served from the Worker, not `public/` |
| `POST /webhooks/sonos` | the Sonos event callback |
| `/auth/sonos/*`, `/auth/lastfm/*`, `POST /auth/listenbrainz` | linking |
| `GET /api/account`, `DELETE /api/account` | status, and delete everything |
| `GET|PUT /api/settings` | radio and cast-playback opt-outs |
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

- [ ] `npm test` and `npm run type-check` clean.
- [ ] `npm run db:remote` has applied **all** of `migrations/`, not just `0001`.
- [ ] All seven secrets set (`wrangler secret list`), and `GET /healthz` returns `ok` —
      not just 200, the body's `status`.
- [ ] Sonos portal: redirect URI and Event Callback URL both point at the deployed
      origin, exactly. A trailing slash difference fails the OAuth exchange.
- [ ] Last.fm portal: callback URL matches, homepage set.
- [ ] Link a real account end to end, play a track, and confirm **Last scrobble** moves
      on the status page. A green tick with `never` next to it means the pipeline is
      not connected.
- [ ] Decide the identity question in **Known limits** below. Every signed-out
      reconnect currently strands an account holding live credentials its owner
      cannot see or delete, which is in tension with the §8(b) claim on the privacy
      page. This is the one open blocker in the code.
- [ ] Point an uptime check at `/healthz` that alerts on the body's `status`, not just
      on a 200, and add a Cloudflare notification on Worker error rate.
- [ ] Confirm the zero-retention design with Sonos developer support before opening
      signups — the legal notes below are why.
- [ ] `TOKEN_ENCRYPTION_KEY` is backed up somewhere you will still have it in a year.
      Rotating it locks every existing user out permanently.

## Known limits, and why they are limits

Three things a reviewer will notice. None is a bug; each is a deliberate boundary, and
the first is the one to resolve before signups open.

### Sonos is the only identity, and there is no way to re-find an account without a cookie

Starting a link while signed in now carries the user through the OAuth round trip, so a
reconnect updates the account that already exists. A user who arrives with **no session**
— cookie cleared, thirty days elapsed, a different browser — still gets a new account,
because nothing Sonos returns identifies the person.

The obvious fix, matching on household id, is worse than the problem: a Sonos household
can have more than one member, so adopting an existing account whose household matches
would hand one person another person's Last.fm session key. That is not a trade worth
making, so the code does not make it.

What is left is real and unresolved: the previous account keeps a live refresh token and
an encrypted Last.fm credential, is invisible to its owner, and cannot be reached by
`DELETE /api/account`, which only ever deletes whoever is signed in. Two ways out, and
one has to be chosen before public signups:

- a second identity the user controls — an email magic link, say — so an account can be
  found again without a Sonos round trip; or
- a stable Sonos-side identifier, if developer support can name one. Nothing in the
  Control API's households response is documented as per-user.

The same gap is why two members of one household do not work today: `subscriptions.id`
is not scoped by user and `GroupSession` is keyed by group alone, so the second person to
link takes over the first person's subscriptions. Scoping both by user is the fix, and it
touches the event dispatch path — worth doing deliberately rather than alongside a rename.

### The request budget is per isolate, not global

`src/sonos/budget.ts` refuses at 600/min and 20/sec inside one isolate. At one household
that is the whole application. At public traffic it is not: several isolates each holding
their own 600/min ceiling can sum past Sonos's shared 1,000/min before any one of them
notices. A Durable Object holding the counter is the fix, and it costs a hop on every
Sonos request — worth paying once traffic is past one isolate's worth, not before.

### Nothing pages anybody

`GET /healthz` round-trips the encryption and both HMAC keys and touches D1, and
distinguishes "200 but degraded" from "ok" in the body rather than the status alone. But
nothing watches it. Before signups: point an uptime check at it that alerts on the body's
`status`, and add a Cloudflare notification on Worker error rate. A cron run reporting
`failed > 0` and a `waitUntil` that throws are both `console.warn` lines and nothing more.

---

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
- [`CHANGELOG.md`](CHANGELOG.md) — what shipped in 1.0.0.

## Deploying

No trailing `#` comments in any of the commands below. An interactive `zsh` — the
default shell on macOS — does not treat `#` as a comment unless `interactive_comments`
is set, so a pasted `npm run db:remote  # first deploy only` passes the words after the
`#` to wrangler as arguments and the command fails without running.

**Deploy the schema before the code.** A Worker deploy and a D1 migration are separate
steps, and code that reads a column its database does not have yet answers 500 from
`/api/account` — a blank dashboard for everyone. `/healthz` now names the missing column
if this happens, but the ordering is what avoids it.

Once, as the account that owns the domain:

```bash
npx wrangler login
```

Every time the `migrations/` directory has gained a file since the last deploy:

```bash
npm run db:remote
```

That applies every file in order. The `ALTER TABLE`s in the later migrations are not
idempotent, so re-applying one that is already live stops on `duplicate column name` —
which is the correct outcome, not a failure to work around.

Then:

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

Check what actually shipped, too — a deploy from a stale checkout is silent:

```bash
npx wrangler deployments list
```

The asset count in the deploy output is the quickest tell. This branch has fifteen files
under `public/`; if wrangler reports reading one, it is deploying an old commit.
