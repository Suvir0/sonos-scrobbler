/**
 * Account linking: Sonos, Last.fm, ListenBrainz.
 *
 * Three different shapes, deliberately not forced into one abstraction:
 *  - **Sonos** is ordinary authorization-code OAuth.
 *  - **Last.fm** is its own web flow — send the user to `last.fm/api/auth`, receive a
 *    `token`, exchange it via a signed `auth.getSession` for a session key that never
 *    expires. Note this differs from the desktop flow, which polls.
 *  - **ListenBrainz** has no OAuth for this at all: the user pastes a token from their
 *    settings page and it is validated once.
 *
 * Sonos is the identity. There is no password anywhere in this service, which is the
 * point: signing in with Sonos is the account.
 */

import type { Env } from '../env.js';
import { encryptSecret, randomToken, sha256Hex } from '../lib/crypto.js';
import { redirect } from '../lib/http.js';
import { log } from '../lib/log.js';
import { standDownDuplicateTargets } from '../lib/duplicates.js';
import { currentRecoveryKey, userForRecoveryKey } from '../lib/recovery.js';
import { createSession, currentUserId, sessionCookie } from '../lib/session.js';
import { LastfmClient } from '../scrobble/lastfm-client.js';
import { ListenBrainzClient } from '../scrobble/listenbrainz-client.js';
import { clientForUser, oauthConfig, saveTokens } from '../sonos/account.js';
import { buildAuthorizeUrl, exchangeCode, SonosGrantRevoked } from '../sonos/oauth.js';
import { syncHousehold } from '../subscriptions.js';

/* ------------------------------------------------------------------- sonos */

export async function startSonosLink(request: Request, env: Env): Promise<Response> {
  const state = randomToken(32);
  // Carry the signed-in user through the round trip, so re-authorizing updates the
  // account that is already here. Without it every trip through Sonos mints a fresh
  // one — and because Sonos is the only identity this service has, the old account
  // becomes unreachable: still holding a live refresh token and the user's Last.fm
  // session key, still counted in the database, and past the reach of the delete
  // button, which only ever deletes whoever is signed in.
  const userId = await currentUserId(request, env);

  // The DO is keyed by the hash so the raw state never becomes a storage key that
  // could leak through a listing or a log.
  const stub = env.OAUTH_STATES.get(env.OAUTH_STATES.idFromName(await sha256Hex(state)));
  await stub.issue({ createdAtMs: Date.now(), ...(userId ? { userId } : {}) });
  return redirect(buildAuthorizeUrl(oauthConfig(env), state));
}

export async function completeSonosLink(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return redirect('/?error=sonos_denied');

  const stub = env.OAUTH_STATES.get(env.OAUTH_STATES.idFromName(await sha256Hex(state)));
  const payload = await stub.consume(Date.now());
  // Single use: a replayed callback finds nothing and is refused.
  if (!payload) return redirect('/?error=sonos_state');

  let tokens;
  try {
    tokens = await exchangeCode(oauthConfig(env), code, { nowMs: Date.now() });
  } catch (error) {
    // A code that Sonos will not exchange is spent, expired or forged. There is nothing
    // to retry and nothing useful to say beyond asking for the link again.
    log(env, 'warn', 'sonos.link.exchange-failed', {
      revoked: error instanceof SonosGrantRevoked,
      message: error instanceof Error ? error.message : String(error)
    });
    return redirect('/?error=sonos_denied');
  }

  // An existing account when the user was signed in when they started; a new one only
  // when there is genuinely nobody to attach this grant to.
  const userId = payload.userId ?? randomToken(16);
  const now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)')
    .bind(userId, now)
    .run();
  await saveTokens(env, userId, tokens);
  // Every account gets a sign-in link straight away, so the page always has one to show.
  // Minting it lazily would mean the one moment somebody needs it — after their cookie
  // is already gone — is the one moment they cannot ask for it.
  await currentRecoveryKey(env, userId);

  // Discovering households and subscribing takes several API calls; none of it needs
  // to happen before the user sees the page.
  ctx.waitUntil(
    linkHouseholds(env, userId).catch((error: unknown) => {
      log(env, 'error', 'sonos.link.households-failed', {
        message: error instanceof Error ? error.message : String(error)
      });
    })
  );

  const token = await createSession(env, userId);
  return redirect('/?linked=sonos', { 'set-cookie': sessionCookie(token, env) });
}

async function linkHouseholds(env: Env, userId: string): Promise<void> {
  const client = await clientForUser(env, userId);
  const households = await client.getHouseholds();
  const now = Date.now();
  for (const household of households) {
    await env.DB.prepare(
      `INSERT INTO households (household_id, user_id, name, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(household_id, user_id) DO UPDATE SET name = excluded.name`
    )
      .bind(household.id, userId, household.name ?? null, now)
      .run();
    await syncHousehold(env, userId, household.id, client, now);
  }

  // The other order. Re-authorizing Sonos onto a fresh account leaves the target linked
  // before the household rows exist, so the check at link time had nothing to match
  // against; this is the first moment it can see the shared speakers. Both callers are
  // needed because either step can be the later one.
  const stoodDown = await standDownDuplicateTargets(env, userId);
  if (stoodDown.length) {
    log(env, 'info', 'targets.duplicate.resolved-on-household-sync', { count: stoodDown.length });
  }

  log(env, 'info', 'sonos.link.complete', { households: households.length });
}

/**
 * Signs somebody back in from their saved link.
 *
 * A GET, deliberately: this is a link a person keeps in a note or a bookmark, and it has
 * to work by being clicked. That makes it a bearer credential in a URL, which is the
 * same trade every magic link makes — mitigated by handing out a session cookie and
 * redirecting immediately, so the key does not sit in the address bar afterwards.
 */
export async function recoverSession(request: Request, env: Env): Promise<Response> {
  const key = new URL(request.url).searchParams.get('key') ?? '';
  const userId = await userForRecoveryKey(env, key);
  if (!userId) {
    log(env, 'warn', 'recovery.rejected');
    return redirect('/?error=recover_failed');
  }

  // Refuse to swap one signed-in account for another without saying so.
  //
  // A GET that mints a session is a login-CSRF primitive: anyone who can get a browser
  // to load a URL can sign that browser into an account they control. On a page whose
  // whole purpose is collecting a ListenBrainz token, somebody silently moved onto an
  // attacker's account would paste their credential into it. Signing out first is a
  // small price, and it is the only moment this can be noticed.
  const signedIn = await currentUserId(request, env);
  if (signedIn && signedIn !== userId) {
    log(env, 'warn', 'recovery.refused-account-switch');
    return redirect('/?error=recover_signed_in');
  }

  const token = await createSession(env, userId);
  log(env, 'info', 'recovery.used');
  return redirect('/?recovered=1', { 'set-cookie': sessionCookie(token, env) });
}

/* ------------------------------------------------------------------ last.fm */

export function startLastfmLink(env: Env): Response {
  const url = new URL(env.LASTFM_AUTH_URL);
  url.searchParams.set('api_key', env.LASTFM_API_KEY);
  url.searchParams.set('cb', `${env.PUBLIC_BASE_URL}/auth/lastfm/callback`);
  return redirect(url.toString());
}

export async function completeLastfmLink(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return redirect('/?error=lastfm_denied');

  const client = new LastfmClient({
    apiKey: env.LASTFM_API_KEY,
    apiSecret: env.LASTFM_API_SECRET
  });

  try {
    // The session key returned here never expires, so this happens exactly once per user.
    const session = await client.getSession(token);
    await saveTarget(env, userId, 'lastfm', session.sessionKey, session.username);
    return redirect('/?linked=lastfm');
  } catch (error) {
    log(env, 'warn', 'lastfm.link.failed', {
      message: error instanceof Error ? error.message : String(error)
    });
    return redirect('/?error=lastfm_failed');
  }
}

/* ------------------------------------------------------------- listenbrainz */

export async function linkListenBrainz(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const form = await request.formData().catch(() => undefined);
  const token = String(form?.get('token') ?? '').trim();
  // A redirect, not a JSON problem. This is the one endpoint a browser reaches by
  // submitting an ordinary HTML form rather than through `fetch`, so a JSON body is not
  // an error the page can display — it is a blank white screen with `{"error":...}` on
  // it, at a URL with no way back. Every other outcome of this flow already redirects.
  if (!token) return redirect('/?error=listenbrainz_missing');

  const client = new ListenBrainzClient({ endpoint: env.LISTENBRAINZ_API_URL });
  try {
    const { username } = await client.validateToken(token);
    await saveTarget(env, userId, 'listenbrainz', token, username);
    return redirect('/?linked=listenbrainz');
  } catch (error) {
    log(env, 'warn', 'listenbrainz.link.failed', {
      message: error instanceof Error ? error.message : String(error)
    });
    return redirect('/?error=listenbrainz_failed');
  }
}

/* ---------------------------------------------------------------- shared */

async function saveTarget(
  env: Env,
  userId: string,
  kind: 'lastfm' | 'listenbrainz',
  credential: string,
  username: string | undefined
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO targets (user_id, kind, credential_enc, username, enabled, needs_reauth, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?)
     ON CONFLICT(user_id, kind) DO UPDATE SET
       credential_enc = excluded.credential_enc,
       username       = excluded.username,
       enabled        = 1,
       needs_reauth   = 0,
       updated_at     = excluded.updated_at`
  )
    .bind(
      userId,
      kind,
      await encryptSecret(credential, env.TOKEN_ENCRYPTION_KEY),
      username ?? null,
      now,
      now
    )
    .run();

  // Now that this account holds the target, stand down any older account on the same
  // speakers submitting to the same place. Runs here rather than at Sonos-link time
  // because this is the moment the collision becomes real: an account with no target
  // scrobbles nothing and doubles nothing.
  const stoodDown = await standDownDuplicateTargets(env, userId);
  if (stoodDown.length) {
    log(env, 'info', 'targets.duplicate.resolved-on-link', { kind, count: stoodDown.length });
  }

  // Send whatever was waiting on this credential.
  //
  // A queue that hit `reauthorize` deliberately stops retrying and sets no alarm, so
  // nothing else would ever come back for those plays — the next flush only happens when
  // some future track is enqueued. Without this, reconnecting reports success and the
  // plays missed while the credential was dead stay missed until the user happens to
  // listen to something else. Best effort: a link must not fail because a flush did.
  await env.USER_QUEUES.get(env.USER_QUEUES.idFromName(userId))
    .flush()
    .catch(() => undefined);
}
