# Scrobbler for Sonos

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

`suvir.net` must be on Cloudflare DNS for the custom-domain route. Until it is, `wrangler.jsonc`
ships with `workers_dev: true` and a `*.workers.dev` URL; flip `workers_dev` to `false` and
uncomment `routes` once DNS is ready, then update `PUBLIC_BASE_URL` in `vars` **and** both URLs
in the Sonos portal.

### 1. Sonos — a new Control Integration

Portal: <https://integration.sonos.com/integrations>

1. Sign in with your Sonos account.
2. **New control integration.** Do *not* edit the existing *PhoneThing* integration.
3. Enter a **Name**, **Description** and **Category**.
   - The name is what users see on the Sonos consent screen.
   - ⚠️ The **Company Name** field appears to be organization-level and pre-fills with
     "PhoneThing". Confirm whether editing it renames the existing integration before you
     touch it. If unsure, leave it.
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
| `src/index.ts` | routing and the scheduled renewal sweep |
| `src/scrobble/session.ts` | the anchored clock — **the core of the service** |
| `src/scrobble/rules.ts` | Last.fm's thresholds |
| `src/scrobble/queue.ts` | durable queue with backoff, batch bisection, hashed dedupe |
| `src/scrobble/{lastfm,listenbrainz}-client.ts` | the two targets |
| `src/sonos/classify.ts` | what is music and what is a podcast, TV or unparseable radio |
| `src/sonos/events.ts` | signature verification and the replay guard |
| `src/sonos/{oauth,account,client}.ts` | authorization, token refresh, Control API |
| `src/subscriptions.ts` | subscribe, renew, follow group changes |
| `src/do/` | Durable Objects: group session, user queue, OAuth state |
| `src/sonos/budget.ts` | our own request ceiling, below Sonos's shared quota |
| `src/testing/replay.ts` | the event replay harness — see below |

`target.ts`, `queue.ts`, `lastfm-client.ts`, `listenbrainz-client.ts` and `lib/musicbrainz.ts`
are ported from the Spinledger desktop app along with their test suites. `queue.ts` gained an
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
