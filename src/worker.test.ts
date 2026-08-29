import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret, sha256Hex, sonosEventSignature } from './lib/crypto.js';
import { createSession, SESSION_COOKIE } from './lib/session.js';
import { OAUTH_STATE_TTL_MS } from './do/oauth-state.js';
import { applySchema, resetTables } from './testing/schema.js';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const USER_ID = 'user-1';
const HOUSEHOLD_ID = 'Sonos_household1';
const GROUP_ID = 'RINCON_AAA:1';



async function seed(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(USER_ID, now).run();
  await env.DB.prepare(
    `INSERT INTO targets (user_id, kind, credential_enc, username, enabled, needs_reauth, created_at, updated_at)
     VALUES (?, 'lastfm', ?, 'someone', 1, 0, ?, ?)`
  )
    .bind(USER_ID, await encryptSecret('session-key', env.TOKEN_ENCRYPTION_KEY), now, now)
    .run();

  for (const namespace of ['playback', 'playbackMetadata']) {
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, household_id, scope, target_id, namespace, next_renewal_at)
       VALUES (?, ?, ?, 'group', ?, ?, ?)`
    )
      .bind(`group:${GROUP_ID}:${namespace}`, USER_ID, HOUSEHOLD_ID, GROUP_ID, namespace, now)
      .run();
  }
}

let seq = 0;

async function postEvent(
  namespace: 'playback' | 'playbackMetadata' | 'groups',
  type: string,
  body: unknown,
  options: { targetValue?: string; signature?: string; seqId?: string } = {}
): Promise<Response> {
  const targetValue = options.targetValue ?? GROUP_ID;
  const targetType = namespace === 'groups' ? 'household' : 'group';
  const seqId = options.seqId ?? String((seq += 1));
  const signature =
    options.signature ??
    (await sonosEventSignature({
      seqId,
      namespace,
      type,
      targetType,
      targetValue,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET
    }));

  return SELF.fetch('https://example.com/webhooks/sonos', {
    method: 'POST',
    headers: {
      'x-sonos-event-seq-id': seqId,
      'x-sonos-namespace': namespace,
      'x-sonos-type': type,
      'x-sonos-target-type': targetType,
      'x-sonos-target-value': targetValue,
      'x-sonos-event-signature': signature,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

const TRACK = {
  container: { name: 'Malibu', type: 'album', service: { name: 'Acme Music' } },
  currentItem: {
    track: {
      type: 'track',
      name: 'Come Down',
      album: { name: 'Malibu' },
      artist: { name: 'Anderson .Paak' },
      id: { serviceId: '204', objectId: 'song:1' },
      service: { name: 'Acme Music' },
      durationMillis: 176_000
    }
  }
};

async function lastSeq(namespace: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT last_seq_id FROM subscriptions WHERE id = ?')
    .bind(`group:${GROUP_ID}:${namespace}`)
    .first<{ last_seq_id: number | null }>();
  return row?.last_seq_id ?? null;
}

describe('the Sonos webhook', () => {
  beforeEach(async () => {
    seq = 0;
    await applySchema();
    await resetTables();
    await seed();
  });

  it('answers 200 to a valid event', async () => {
    const response = await postEvent('playbackMetadata', 'metadataStatus', TRACK);
    expect(response.status).toBe(200);
  });

  it('answers 200 to a forged event too, but does not act on it', async () => {
    // A non-200 buys nothing — Sonos only retries — and would turn every probe into
    // three more deliveries. The rejection has to show up as "nothing happened".
    const response = await postEvent('playbackMetadata', 'metadataStatus', TRACK, {
      signature: 'not-a-real-signature'
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await lastSeq('playbackMetadata')).toBeNull();
  });

  // The handler acknowledges before doing any work, so the side effects land after the
  // response. That is the whole point of the design — Sonos discards an event it cannot
  // deliver quickly — so the tests wait for the effect rather than the response.
  it('records the sequence id of an event it accepts', async () => {
    await postEvent('playbackMetadata', 'metadataStatus', TRACK, { seqId: '5' });
    await vi.waitFor(async () => expect(await lastSeq('playbackMetadata')).toBe(5));
  });

  it('ignores a replayed sequence id', async () => {
    await postEvent('playbackMetadata', 'metadataStatus', TRACK, { seqId: '9' });
    await vi.waitFor(async () => expect(await lastSeq('playbackMetadata')).toBe(9));

    // Same sequence id, different body: the signature still verifies because it does
    // not cover the body. The high-water mark is the only thing standing in the way.
    await postEvent('playbackMetadata', 'metadataStatus', { container: { type: 'linein' } }, {
      seqId: '9'
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await lastSeq('playbackMetadata')).toBe(9);
  });

  it('ignores an event for a group it does not know about', async () => {
    const response = await postEvent('playbackMetadata', 'metadataStatus', TRACK, {
      targetValue: 'RINCON_UNKNOWN:9'
    });
    expect(response.status).toBe(200);
  });

  it('ignores a malformed body without erroring', async () => {
    const response = await SELF.fetch('https://example.com/webhooks/sonos', {
      method: 'POST',
      headers: {
        'x-sonos-event-seq-id': '1',
        'x-sonos-namespace': 'playbackMetadata',
        'x-sonos-type': 'metadataStatus',
        'x-sonos-target-type': 'group',
        'x-sonos-target-value': GROUP_ID,
        'x-sonos-event-signature': await sonosEventSignature({
          seqId: '1',
          namespace: 'playbackMetadata',
          type: 'metadataStatus',
          targetType: 'group',
          targetValue: GROUP_ID,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET
        })
      },
      body: 'not json at all'
    });
    expect(response.status).toBe(200);
  });

  it('starts a play session from a metadata event plus its playback event', async () => {
    // Exercises the ordering logic: metadataStatus alone only stages a pending track,
    // because the playbackStatus carrying the outgoing track's final position may
    // still be in flight. The session appears once both have landed.
    await postEvent('playbackMetadata', 'metadataStatus', TRACK);
    await postEvent('playback', 'playbackStatus', {
      playbackState: 'PLAYBACK_STATE_PLAYING',
      positionMillis: 0
    });

    const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(GROUP_ID));
    await vi.waitFor(async () => {
      const snapshot = await stub.snapshot();
      expect(snapshot?.track?.artist).toBe('Anderson .Paak');
      expect(snapshot?.track?.track).toBe('Come Down');
      expect(snapshot?.track?.durationMs).toBe(176_000);
      expect(snapshot?.playing).toBe(true);
    });
  });

  it('starts no session for TV audio', async () => {
    await postEvent('playbackMetadata', 'metadataStatus', {
      container: { name: 'TV Audio', type: 'linein.homeTheater' }
    });
    await postEvent('playback', 'playbackStatus', {
      playbackState: 'PLAYBACK_STATE_PLAYING',
      positionMillis: 0
    });

    const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(GROUP_ID));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await stub.snapshot()).toBeUndefined();
  });

  it('ignores an event with no signature header', async () => {
    const response = await SELF.fetch('https://example.com/webhooks/sonos', {
      method: 'POST',
      headers: { 'x-sonos-namespace': 'playbackMetadata' },
      body: '{}'
    });
    expect(response.status).toBe(200);
  });
});

describe('routing', () => {
  beforeEach(async () => {
    await applySchema();
    await resetTables();
  });

  it('reports healthy when every secret and binding works', async () => {
    // Exercises the real encryption and HMAC keys, not just that the Worker responds.
    const response = await SELF.fetch('https://example.com/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: {
        config: 'ok',
        encryption: 'ok',
        scrobbleKeySalt: 'ok',
        sessionSecret: 'ok',
        database: 'ok'
      }
    });
  });

  // A JSON 401 rather than a redirect: the dashboard polls this endpoint, and a 302 to
  // an HTML page reads as a successful response until the JSON parse fails.
  it('refuses account access without a session', async () => {
    const response = await SELF.fetch('https://example.com/api/account', { redirect: 'manual' });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'signin_required'
    );
  });

  it('sends a user to Sonos to authorize, with a single-use state', async () => {
    const response = await SELF.fetch('https://example.com/auth/sonos/start', {
      redirect: 'manual'
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://api.sonos.com/login/v3/oauth');
    expect(location.searchParams.get('scope')).toBe('playback-control-all');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('state')).toBeTruthy();
    // Must match what is registered in the integration manager byte for byte.
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${env.PUBLIC_BASE_URL}/auth/sonos/callback`
    );
  });

  // Sonos is the only identity this service has, so a sign-in that always minted a new
  // account meant an expired cookie stranded the old one: still holding a live refresh
  // token and the user's Last.fm session key, and past the reach of the delete button,
  // which only deletes whoever is signed in.
  it('carries a signed-in user through the Sonos round trip instead of minting a second account', async () => {
    await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)')
      .bind(USER_ID, Date.now())
      .run();
    const cookie = `${SESSION_COOKIE}=${await createSession(env, USER_ID)}`;

    const start = await SELF.fetch('https://example.com/auth/sonos/start', {
      headers: { cookie },
      redirect: 'manual'
    });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;

    const stub = env.OAUTH_STATES.get(env.OAUTH_STATES.idFromName(await sha256Hex(state)));
    const payload = await stub.consume(Date.now());
    expect(payload?.userId).toBe(USER_ID);
  });

  it('issues state with no user attached when nobody is signed in', async () => {
    const start = await SELF.fetch('https://example.com/auth/sonos/start', {
      redirect: 'manual'
    });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const stub = env.OAUTH_STATES.get(env.OAUTH_STATES.idFromName(await sha256Hex(state)));
    const payload = await stub.consume(Date.now());
    expect(payload).toBeDefined();
    expect(payload?.userId).toBeUndefined();
    expect(Date.now() - payload!.createdAtMs).toBeLessThan(OAUTH_STATE_TTL_MS);
  });

  it('refuses a callback carrying an unknown state', async () => {
    const response = await SELF.fetch(
      'https://example.com/auth/sonos/callback?code=abc&state=never-issued',
      { redirect: 'manual' }
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('sonos_state');
  });
});


describe('hardening', () => {
  beforeEach(async () => {
    await applySchema();
    await resetTables();
  });

  async function signedIn(): Promise<string> {
    await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)')
      .bind(USER_ID, Date.now())
      .run();
    return `${SESSION_COOKIE}=${await createSession(env, USER_ID)}`;
  }

  // The page is a single document whose styles and script are inline, so the policy can
  // forbid every remote origin outright. `frame-ancestors 'none'` is the load-bearing
  // one: the dashboard has a delete-everything button.
  it('applies a content security policy to the page itself, not just to API responses', async () => {
    const response = await SELF.fetch('https://example.com/');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=');
  });

  // SameSite=Lax already blocks this in a browser that implements it strictly, but Lax
  // has to stay for the OAuth callbacks, so the Origin check is what actually closes it.
  it('refuses a state-changing request carrying somebody else\'s Origin', async () => {
    const cookie = await signedIn();
    const response = await SELF.fetch('https://example.com/api/account', {
      method: 'DELETE',
      headers: { cookie, origin: 'https://attacker.example' }
    });
    expect(response.status).toBe(403);
    // And the account is still there.
    expect(
      await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(USER_ID).first()
    ).toBeTruthy();
  });

  it('accepts the same request from its own origin', async () => {
    const cookie = await signedIn();
    const response = await SELF.fetch('https://example.com/api/settings', {
      method: 'PUT',
      headers: { cookie, origin: 'https://example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ scrobbleRadio: false })
    });
    expect(response.status).toBe(200);
  });

  // Both columns shipped in the first migration and neither was reachable, so every
  // account ran on the defaults. The round trip is what proves they now are.
  it('stores and reads back the playback-source settings', async () => {
    const cookie = await signedIn();

    expect(
      await (await SELF.fetch('https://example.com/api/settings', { headers: { cookie } })).json()
    ).toEqual({ scrobbleRadio: true, allowHandoff: false });

    await SELF.fetch('https://example.com/api/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scrobbleRadio: false })
    });

    // A partial update leaves the key it did not mention alone.
    expect(
      await (await SELF.fetch('https://example.com/api/settings', { headers: { cookie } })).json()
    ).toEqual({ scrobbleRadio: false, allowHandoff: false });
  });

  // A 200 carrying the old value is worse than an error: the page reports "Saved" and
  // the setting has not moved.
  it('refuses a settings value that is not a boolean rather than ignoring it', async () => {
    const cookie = await signedIn();
    const response = await SELF.fetch('https://example.com/api/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scrobbleRadio: 'false' })
    });
    expect(response.status).toBe(400);
    expect(
      await (await SELF.fetch('https://example.com/api/settings', { headers: { cookie } })).json()
    ).toEqual({ scrobbleRadio: true, allowHandoff: false });
  });

  it('refuses a body that is not a JSON object', async () => {
    const cookie = await signedIn();
    const response = await SELF.fetch('https://example.com/api/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: 'not json'
    });
    expect(response.status).toBe(400);
  });

  // A wrong verb on a known path used to fall through to the assets binding and come
  // back as the HTML front page with a 200 on it.
  it('answers a known API path with the wrong method as 405, not as the front page', async () => {
    const response = await SELF.fetch('https://example.com/api/settings', { method: 'DELETE' });
    expect(response.status).toBe(405);
  });
});
