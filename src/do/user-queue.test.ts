/**
 * What the status page is told when a target refuses a play.
 *
 * These exist because of a failure that was undiagnosable from the outside.
 * ListenBrainz answers `validate-token` with `valid: true` for a token belonging to a
 * MetaBrainz account with no verified email address, then answers `submit-listens` with
 * 401 and a paragraph naming the cause and linking the fix. The queue threw that
 * paragraph away and set a boolean, so the page said "the credentials were rejected" —
 * advising the one action, reconnecting, that provably could not help, since the token
 * validates every time. The loop had no exit in it.
 */

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../lib/crypto.js';
import { applySchema, resetTables } from '../testing/schema.js';

const USER_ID = 'queue-user';
const TOKEN = 'b0000000-0000-0000-0000-000000000000';

/** The real refusal, verbatim from api.listenbrainz.org. */
const UNVERIFIED_EMAIL =
  'The listens were rejected because your MetaBrainz account does not have a verified ' +
  'email address. Please check your inbox for a verification email, or go to your ' +
  'MetaBrainz profile page to verify your email: https://metabrainz.org/profile.';

const TRACK = { artist: 'Anderson .Paak', track: 'Come Down', timestamp: 1_700_000_000 };

function queue() {
  return env.USER_QUEUES.get(env.USER_QUEUES.idFromName(USER_ID));
}

async function targetRow(): Promise<{ needs_reauth: number; last_error: string | null }> {
  const row = await env.DB.prepare(
    'SELECT needs_reauth, last_error FROM targets WHERE user_id = ? AND kind = ?'
  )
    .bind(USER_ID, 'listenbrainz')
    .first<{ needs_reauth: number; last_error: string | null }>();
  return row!;
}

/**
 * Answers the submission endpoint however the test needs, and records that it was
 * actually called — so a test cannot pass because no request was made at all.
 */
function interceptSubmit(
  status: number,
  body: unknown,
  delayMs = 0
): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    // A submission is an HTTP round trip, not an instant return. The delay is what makes
    // the concurrency test below deterministic rather than a coin toss: it holds the
    // first caller inside `flush` long enough for a second one to be delivered.
    if (delayMs) await scheduler.wait(delayMs);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a target that refuses a play', () => {
  beforeEach(async () => {
    await applySchema();
    await resetTables();
    // The DO outlives an individual test, and its dedupe set with it — without this the
    // third test's play is silently swallowed as one already accepted by the second,
    // and the assertion passes or fails for reasons that have nothing to do with it.
    await queue().reset();
    const now = Date.now();
    await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)')
      .bind(USER_ID, now)
      .run();
    // ListenBrainz only. A Last.fm row here would have the queue reaching for a second
    // endpoint that these tests have no interceptor for.
    await env.DB.prepare(
      `INSERT INTO targets (user_id, kind, credential_enc, username, enabled, needs_reauth, created_at, updated_at)
       VALUES (?, 'listenbrainz', ?, 'suvir', 1, 0, ?, ?)`
    )
      .bind(USER_ID, await encryptSecret(TOKEN, env.TOKEN_ENCRYPTION_KEY), now, now)
      .run();
  });

  it('stores what the service actually said, not a guess about the credential', async () => {
    interceptSubmit(401, { code: 401, error: UNVERIFIED_EMAIL });

    await queue().enqueue(USER_ID, TRACK);

    const row = await targetRow();
    expect(row.needs_reauth).toBe(1);
    // The specific words that make this actionable: the cause, and where to fix it.
    expect(row.last_error).toContain('verified email address');
    expect(row.last_error).toContain('https://metabrainz.org/profile');
  });

  it('clears the flag and the message once a delivery finally lands', async () => {
    interceptSubmit(401, { code: 401, error: UNVERIFIED_EMAIL });
    await queue().enqueue(USER_ID, TRACK);
    expect((await targetRow()).needs_reauth).toBe(1);

    // The user verifies their email. Nothing about the token changed, so a reconnect
    // was never the remedy — the next delivery simply succeeds.
    interceptSubmit(200, { status: 'ok' });
    await queue().flush();

    const row = await targetRow();
    expect(row.needs_reauth).toBe(0);
    expect(row.last_error).toBeNull();
  });

  it('submits a play once when two events hand it over at the same moment', async () => {
    // A track change is a `playbackMetadata` and a `playback` event milliseconds apart,
    // so the outgoing play can be handed over twice, concurrently. The queue's dedupe is
    // sound but can only refuse what it has loaded: rebuilt from storage around a D1
    // read, the second caller's copy of `accepted` predated the first caller's write, so
    // both submitted. ListenBrainz collapses the pair server-side and Last.fm does not,
    // which is the whole reason this read as a Last.fm-only fault.
    const submit = interceptSubmit(200, { status: 'ok' }, 50);

    await Promise.all([queue().enqueue(USER_ID, TRACK), queue().enqueue(USER_ID, TRACK)]);

    expect(submit.calls.filter((url) => url.includes('submit-listens'))).toHaveLength(1);
  });

  it('records a transient failure without declaring the credential dead', async () => {
    // A 503 is an outage. Flagging it as a rejected credential would send somebody off
    // to re-paste a token that was working perfectly.
    interceptSubmit(503, { code: 503, error: 'ListenBrainz is down for maintenance' });

    await queue().enqueue(USER_ID, TRACK);

    const row = await targetRow();
    expect(row.needs_reauth).toBe(0);
    expect(row.last_error).toContain('down for maintenance');
  });
});
