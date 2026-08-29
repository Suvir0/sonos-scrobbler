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
import { problem, redirect } from '../lib/http.js';
import { log } from '../lib/log.js';
import { createSession, sessionCookie } from '../lib/session.js';
import { LastfmClient } from '../scrobble/lastfm-client.js';
import { ListenBrainzClient } from '../scrobble/listenbrainz-client.js';
import { clientForUser, oauthConfig, saveTokens } from '../sonos/account.js';
import { buildAuthorizeUrl, exchangeCode } from '../sonos/oauth.js';
import { syncHousehold } from '../subscriptions.js';

/* ------------------------------------------------------------------- sonos */

export async function startSonosLink(request: Request, env: Env): Promise<Response> {
  const state = randomToken(32);
  // The DO is keyed by the hash so the raw state never becomes a storage key that
  // could leak through a listing or a log.
  const stub = env.OAUTH_STATES.get(env.OAUTH_STATES.idFromName(await sha256Hex(state)));
  await stub.issue({ createdAtMs: Date.now() });
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

  const tokens = await exchangeCode(oauthConfig(env), code, { nowMs: Date.now() });

  const userId = payload.userId ?? randomToken(16);
  const now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)')
    .bind(userId, now)
    .run();
  await saveTokens(env, userId, tokens);

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
  log(env, 'info', 'sonos.link.complete', { households: households.length });
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
  if (!token) return problem(400, 'missing_token', 'Paste the token from your settings page.');

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
}
