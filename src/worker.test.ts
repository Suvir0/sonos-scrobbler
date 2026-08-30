import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret, sha256Hex, sonosEventSignature } from './lib/crypto.js';
import { createSession, SESSION_COOKIE } from './lib/session.js';
import { OAUTH_STATE_TTL_MS } from './do/oauth-state.js';
import { SECURITY_CONTACT } from './routes/health.js';
import { applySchema, resetTables } from './testing/schema.js';
import { groupSessionName } from './do/group-session.js';

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
      .bind(
        `${USER_ID}:group:${GROUP_ID}:${namespace}`,
        USER_ID,
        HOUSEHOLD_ID,
        GROUP_ID,
        namespace,
        now
      )
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

async function lastSeq(namespace: string, userId = USER_ID): Promise<number | null> {
  const row = await env.DB.prepare('SELECT last_seq_id FROM subscriptions WHERE id = ?')
    .bind(`${userId}:group:${GROUP_ID}:${namespace}`)
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

    const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(groupSessionName(USER_ID, GROUP_ID)));
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

    const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(groupSessionName(USER_ID, GROUP_ID)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await stub.snapshot()).toBeUndefined();
  });

  describe('rooms that are switched off', () => {
    // The group has to be recorded with its members before the preference can reach an
    // event: an event names a group, and this row is what turns that into rooms.
    async function seedRooms(playerIds: string[]): Promise<void> {
      for (const [index, playerId] of playerIds.entries()) {
        await env.DB.prepare(
          `INSERT INTO sonos_players (player_id, user_id, household_id, name, seen_at)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(playerId, USER_ID, HOUSEHOLD_ID, `Room ${index + 1}`, Date.now())
          .run();
      }
      await env.DB.prepare(
        `INSERT INTO sonos_groups (group_id, household_id, user_id, name, player_ids, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(GROUP_ID, HOUSEHOLD_ID, USER_ID, 'Room 1', JSON.stringify(playerIds), Date.now())
        .run();
    }

    async function playSomething(): Promise<void> {
      await postEvent('playbackMetadata', 'metadataStatus', TRACK);
      await postEvent('playback', 'playbackStatus', {
        playbackState: 'PLAYBACK_STATE_PLAYING',
        positionMillis: 0
      });
    }

    it('starts no session for a room the user switched off', async () => {
      await seedRooms(['RINCON_A']);
      await env.DB.prepare(
        'UPDATE sonos_players SET scrobble = 0 WHERE user_id = ? AND player_id = ?'
      )
        .bind(USER_ID, 'RINCON_A')
        .run();

      await playSomething();

      const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(groupSessionName(USER_ID, GROUP_ID)));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await stub.snapshot()).toBeUndefined();
    });

    // The answer chosen deliberately: switching a room off is a promise about that
    // speaker, not one that lapses the moment somebody groups it with another room.
    it('silences a whole group when one of its rooms is off', async () => {
      await seedRooms(['RINCON_A', 'RINCON_B']);
      await env.DB.prepare(
        'UPDATE sonos_players SET scrobble = 0 WHERE user_id = ? AND player_id = ?'
      )
        .bind(USER_ID, 'RINCON_B')
        .run();

      await playSomething();

      const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(groupSessionName(USER_ID, GROUP_ID)));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await stub.snapshot()).toBeUndefined();
    });

    it('plays normally when every room in the group is on', async () => {
      await seedRooms(['RINCON_A', 'RINCON_B']);

      await playSomething();

      const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(groupSessionName(USER_ID, GROUP_ID)));
      await vi.waitFor(async () => {
        expect((await stub.snapshot())?.track?.track).toBe('Come Down');
      });
    });

    // Switching a room off mid-track drops what was in flight rather than finalizing
    // it. The answer to "may this room scrobble" is no as of now.
    it('drops a track already in flight when its room is switched off', async () => {
      await seedRooms(['RINCON_A']);
      await playSomething();

      const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(groupSessionName(USER_ID, GROUP_ID)));
      await vi.waitFor(async () => {
        expect((await stub.snapshot())?.track?.track).toBe('Come Down');
      });

      await env.DB.prepare(
        'UPDATE sonos_players SET scrobble = 0 WHERE user_id = ? AND player_id = ?'
      )
        .bind(USER_ID, 'RINCON_A')
        .run();

      await postEvent('playback', 'playbackStatus', {
        playbackState: 'PLAYBACK_STATE_PLAYING',
        positionMillis: 90_000
      });

      await vi.waitFor(async () => {
        expect(await stub.snapshot()).toBeUndefined();
      });
    });
  });

  /**
   * A Sonos event names a group, never a person, and one household can hold two accounts
   * — a couple who both signed up, or one person who came back without a cookie and was
   * given a second account. Before migration 0006 both of those collapsed into one
   * subscription row, so the second account to link silently took the first one's events
   * and the first one's dashboard went quiet with nothing to explain it.
   */
  describe('a household two accounts both watch', () => {
    const OTHER_ID = 'user-2';

    beforeEach(async () => {
      const now = Date.now();
      await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)')
        .bind(OTHER_ID, now)
        .run();
      for (const namespace of ['playback', 'playbackMetadata']) {
        await env.DB.prepare(
          `INSERT INTO subscriptions (id, user_id, household_id, scope, target_id, namespace, next_renewal_at)
           VALUES (?, ?, ?, 'group', ?, ?, ?)`
        )
          .bind(
            `${OTHER_ID}:group:${GROUP_ID}:${namespace}`,
            OTHER_ID,
            HOUSEHOLD_ID,
            GROUP_ID,
            namespace,
            now
          )
          .run();
      }
    });

    const sessionFor = (userId: string) =>
      env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(groupSessionName(userId, GROUP_ID)));

    it('delivers one event to both of them', async () => {
      await postEvent('playbackMetadata', 'metadataStatus', TRACK);
      await postEvent('playback', 'playbackStatus', {
        playbackState: 'PLAYBACK_STATE_PLAYING',
        positionMillis: 0
      });

      await vi.waitFor(async () => {
        expect((await sessionFor(USER_ID).snapshot())?.track?.track).toBe('Come Down');
        expect((await sessionFor(OTHER_ID).snapshot())?.track?.track).toBe('Come Down');
      });
    });

    // Each account keeps its own play clock. One shared object meant every event
    // re-initialized whose session it was, so the two continually reset each other.
    it('gives each of them their own sequence high-water mark', async () => {
      await postEvent('playbackMetadata', 'metadataStatus', TRACK, { seqId: '7' });
      await vi.waitFor(async () => {
        expect(await lastSeq('playbackMetadata')).toBe(7);
        expect(await lastSeq('playbackMetadata', OTHER_ID)).toBe(7);
      });
    });

    // One person's broken half must not swallow the event for the other. The second
    // account here has no Sonos grant at all, which is what a revoked one looks like.
    it('still reaches one when the other cannot be served', async () => {
      await env.DB.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(OTHER_ID).run();
      for (const namespace of ['playback', 'playbackMetadata']) {
        await env.DB.prepare(
          `INSERT INTO subscriptions (id, user_id, household_id, scope, target_id, namespace, next_renewal_at)
           VALUES (?, ?, ?, 'group', ?, ?, ?)`
        )
          .bind(
            `${OTHER_ID}:group:${GROUP_ID}:${namespace}`,
            OTHER_ID,
            HOUSEHOLD_ID,
            GROUP_ID,
            namespace,
            Date.now()
          )
          .run();
      }
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(OTHER_ID).run();

      await postEvent('playbackMetadata', 'metadataStatus', TRACK);
      await postEvent('playback', 'playbackStatus', {
        playbackState: 'PLAYBACK_STATE_PLAYING',
        positionMillis: 0
      });

      await vi.waitFor(async () => {
        expect((await sessionFor(USER_ID).snapshot())?.track?.track).toBe('Come Down');
      });
    });
  });

  /**
   * The status page's most important reading, over the path that actually produces it.
   *
   * Sonos sends nothing while a track plays normally, so a scrobble is almost always
   * earned by the Durable Object's alarm rather than by an incoming event. The timestamp
   * and the log line used to live in the webhook handler, so that path recorded nothing:
   * "Last scrobble: never" over a pipeline delivering plays correctly, which is exactly
   * the reading an operator would act on.
   */
  it('records a scrobble earned by the alarm, not only one earned by an event', async () => {
    const before = await env.DB.prepare('SELECT last_scrobble_at FROM users WHERE id = ?')
      .bind(USER_ID)
      .first<{ last_scrobble_at: number | null }>();
    expect(before?.last_scrobble_at).toBeNull();

    // A four-minute track, started, and then the silence Sonos really sends.
    await postEvent('playbackMetadata', 'metadataStatus', {
      container: { type: 'album', service: { name: 'Acme Music' } },
      currentItem: {
        track: {
          type: 'track',
          name: 'Come Down',
          artist: { name: 'Anderson .Paak' },
          id: { objectId: 'song:come-down' },
          service: { name: 'Acme Music' },
          durationMillis: 240_000
        }
      }
    });
    await postEvent('playback', 'playbackStatus', {
      playbackState: 'PLAYBACK_STATE_PLAYING',
      positionMillis: 0
    });

    const stub = env.GROUP_SESSIONS.get(
      env.GROUP_SESSIONS.idFromName(groupSessionName(USER_ID, GROUP_ID))
    );
    await vi.waitFor(async () => {
      expect((await stub.snapshot())?.track?.track).toBe('Come Down');
    });

    // Past the halfway point, on the object's own clock — no further event arrives.
    const outcome = await stub.tick(Date.now() + 130_000);
    expect(outcome.scrobbled?.track).toBe('Come Down');

    const after = await env.DB.prepare('SELECT last_scrobble_at FROM users WHERE id = ?')
      .bind(USER_ID)
      .first<{ last_scrobble_at: number | null }>();
    expect(after?.last_scrobble_at).toBeGreaterThan(0);
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
        database: 'ok',
        schema: 'ok'
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

/**
 * The sign-in link.
 *
 * Sonos is the only identity here and nothing it returns names the person, so a cookie
 * that is gone used to mean a second account for the same speakers — with the first left
 * holding live credentials its owner could no longer reach. This is the way back that
 * does not depend on the cookie.
 */
describe('the sign-in link', () => {
  beforeEach(async () => {
    await applySchema();
    await resetTables();
    await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)')
      .bind(USER_ID, Date.now())
      .run();
  });

  const cookieFor = async (userId: string) =>
    `${SESSION_COOKIE}=${await createSession(env, userId)}`;

  const keyFrom = (url: string) => new URL(url).searchParams.get('key') ?? '';

  async function currentLink(cookie: string): Promise<string> {
    const response = await SELF.fetch('https://example.com/api/recovery', {
      headers: { cookie }
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { url: string }).url;
  }

  it('signs a browser with no cookie at all back into the same account', async () => {
    const url = await currentLink(await cookieFor(USER_ID));

    const recovered = await SELF.fetch(
      `https://example.com/auth/recover?key=${keyFrom(url)}`,
      { redirect: 'manual' }
    );
    expect(recovered.status).toBe(302);
    expect(recovered.headers.get('location')).toContain('recovered=1');

    // And the cookie it hands out is a real session for the original account, which is
    // the whole claim: no second account, no stranded credentials.
    const cookie = (recovered.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const account = await SELF.fetch('https://example.com/api/account', {
      headers: { cookie }
    });
    expect(account.status).toBe(200);
  });

  it('hands out the same link every time, so it can be found again later', async () => {
    const cookie = await cookieFor(USER_ID);
    expect(await currentLink(cookie)).toBe(await currentLink(cookie));
  });

  it('stops the old link working as soon as a new one is made', async () => {
    const cookie = await cookieFor(USER_ID);
    const before = keyFrom(await currentLink(cookie));

    const rotated = await SELF.fetch('https://example.com/api/recovery', {
      method: 'POST',
      headers: { cookie, origin: 'https://example.com' }
    });
    const after = keyFrom(((await rotated.json()) as { url: string }).url);
    expect(after).not.toBe(before);

    const stale = await SELF.fetch(`https://example.com/auth/recover?key=${before}`, {
      redirect: 'manual'
    });
    expect(stale.headers.get('location')).toContain('recover_failed');
  });

  it('refuses a key that belongs to nobody, and an absent one', async () => {
    for (const query of ['?key=not-a-real-key', '']) {
      const response = await SELF.fetch(`https://example.com/auth/recover${query}`, {
        redirect: 'manual'
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('recover_failed');
    }
  });

  // The link is a bearer credential. Storing it readable would make a dump of the users
  // table a set of working sign-ins for every account in it.
  it('stores no key that a database dump could be signed in with', async () => {
    const url = await currentLink(await cookieFor(USER_ID));
    const row = await env.DB.prepare(
      'SELECT recovery_hash, recovery_enc FROM users WHERE id = ?'
    )
      .bind(USER_ID)
      .first<{ recovery_hash: string | null; recovery_enc: string | null }>();

    const key = keyFrom(url);
    expect(key.length).toBeGreaterThan(20);
    expect(row?.recovery_hash).not.toContain(key);
    expect(row?.recovery_enc).not.toContain(key);
  });

  // A GET that mints a session is a login-CSRF primitive, and this page collects a
  // ListenBrainz token. Somebody moved silently onto an attacker's account would paste
  // their credential into it.
  it('refuses to swap a signed-in browser onto a different account', async () => {
    const other = 'user-elsewhere';
    await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)')
      .bind(other, Date.now())
      .run();
    const theirKey = keyFrom(await currentLink(await cookieFor(other)));

    const response = await SELF.fetch(`https://example.com/auth/recover?key=${theirKey}`, {
      headers: { cookie: await cookieFor(USER_ID) },
      redirect: 'manual'
    });
    expect(response.headers.get('location')).toContain('recover_signed_in');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  // But reopening your own link while already signed in is ordinary and must still work.
  it('accepts a browser already signed into the same account', async () => {
    const cookie = await cookieFor(USER_ID);
    const response = await SELF.fetch(
      `https://example.com/auth/recover?key=${keyFrom(await currentLink(cookie))}`,
      { headers: { cookie }, redirect: 'manual' }
    );
    expect(response.headers.get('location')).toContain('recovered=1');
  });

  it('needs a session to read or replace', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const response = await SELF.fetch('https://example.com/api/recovery', {
        method,
        headers: { origin: 'https://example.com' }
      });
      expect(response.status).toBe(401);
    }
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
    ).toEqual({ scrobbleRadio: true, allowHandoff: false, skipLongTracks: true });

    await SELF.fetch('https://example.com/api/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scrobbleRadio: false })
    });

    // A partial update leaves the key it did not mention alone.
    expect(
      await (await SELF.fetch('https://example.com/api/settings', { headers: { cookie } })).json()
    ).toEqual({ scrobbleRadio: false, allowHandoff: false, skipLongTracks: true });
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
    ).toEqual({ scrobbleRadio: true, allowHandoff: false, skipLongTracks: true });
  });

  describe('the room endpoint', () => {
    async function withRoom(cookie: string): Promise<void> {
      await env.DB.prepare(
        `INSERT INTO sonos_players (player_id, user_id, household_id, name, seen_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind('RINCON_LIVING', USER_ID, HOUSEHOLD_ID, 'Living Room', Date.now())
        .run();
      expect(cookie).toBeTruthy();
    }

    it('lists the rooms and turns one off', async () => {
      const cookie = await signedIn();
      await withRoom(cookie);

      expect(
        await (await SELF.fetch('https://example.com/api/rooms', { headers: { cookie } })).json()
      ).toEqual({ rooms: [{ id: 'RINCON_LIVING', name: 'Living Room', scrobble: true }] });

      const response = await SELF.fetch('https://example.com/api/rooms', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: 'RINCON_LIVING', scrobble: false })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        rooms: [{ id: 'RINCON_LIVING', name: 'Living Room', scrobble: false }]
      });
    });

    // Coercing `"false"` to true is how a room somebody switched off comes back on.
    it('refuses a scrobble value that is not a boolean', async () => {
      const cookie = await signedIn();
      await withRoom(cookie);
      const response = await SELF.fetch('https://example.com/api/rooms', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: 'RINCON_LIVING', scrobble: 'false' })
      });
      expect(response.status).toBe(400);
    });

    it('refuses a body with no player id', async () => {
      const cookie = await signedIn();
      const response = await SELF.fetch('https://example.com/api/rooms', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ scrobble: false })
      });
      expect(response.status).toBe(400);
    });

    // A 200 here would show a room as off on the page while every event kept
    // scrobbling it.
    it('answers 404 for a player that is not one of yours', async () => {
      const cookie = await signedIn();
      const response = await SELF.fetch('https://example.com/api/rooms', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: 'RINCON_SOMEBODY_ELSE', scrobble: false })
      });
      expect(response.status).toBe(404);
    });

    it('refuses room access without a session', async () => {
      const response = await SELF.fetch('https://example.com/api/rooms', { redirect: 'manual' });
      expect(response.status).toBe(401);
    });
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

  // A Worker deploy and a D1 migration are separate steps, so code reaches production
  // ahead of its schema sooner or later. Without this the symptom is a 500 from
  // /api/account and a blank dashboard for every user, with nothing saying why.
  it('reports degraded when the database is missing a column this build needs', async () => {
    await env.DB.prepare('ALTER TABLE sonos_accounts DROP COLUMN needs_reauth').run();

    const response = await SELF.fetch('https://example.com/healthz');
    expect(response.status).toBe(503);

    const body = (await response.json()) as { status: string; checks: { schema: string } };
    expect(body.status).toBe('degraded');
    expect(body.checks.schema).toContain('sonos_accounts.needs_reauth');
    expect(body.checks.schema).toContain('db:remote');
  });

  // Served from the Worker rather than from public/, because Wrangler's asset upload
  // does not reliably include dot-directories and a security contact that 404s is worse
  // than not publishing one.
  it('publishes an unexpired security.txt with a reachable contact', async () => {
    const response = await SELF.fetch('https://example.com/.well-known/security.txt');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const body = await response.text();
    expect(body).toContain(`Contact: mailto:${SECURITY_CONTACT}`);
    expect(body).toContain(`Canonical: ${env.PUBLIC_BASE_URL}/.well-known/security.txt`);

    const expires = /Expires: (\S+)/.exec(body)?.[1];
    expect(Date.parse(expires!)).toBeGreaterThan(Date.now());
  });

  // A wrong verb on a known path used to fall through to the assets binding and come
  // back as the HTML front page with a 200 on it.
  it('answers a known API path with the wrong method as 405, not as the front page', async () => {
    const response = await SELF.fetch('https://example.com/api/settings', { method: 'DELETE' });
    expect(response.status).toBe(405);
  });
});
