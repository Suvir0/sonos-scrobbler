/**
 * Turns a stored Sonos grant into a usable API client.
 *
 * Token refresh is lazy and cached in D1 rather than eager: with many users, refreshing
 * everybody on a schedule would spend a large share of the 1,000 req/min app-wide
 * quota on households that are not playing anything.
 */

import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import type { Env } from '../env.js';
import { SonosClient } from './client.js';
import {
  isExpired,
  refreshTokens,
  SonosGrantRevoked,
  type SonosOAuthConfig,
  type SonosTokens
} from './oauth.js';

export interface SonosAccountRow {
  user_id: string;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: number | null;
}

export function oauthConfig(env: Env): SonosOAuthConfig {
  return {
    clientId: env.SONOS_CLIENT_ID,
    clientSecret: env.SONOS_CLIENT_SECRET,
    authorizeUrl: env.SONOS_AUTHORIZE_URL,
    tokenUrl: env.SONOS_TOKEN_URL,
    // Must match the redirect URI registered in the Sonos integration manager exactly.
    redirectUri: `${env.PUBLIC_BASE_URL}/auth/sonos/callback`
  };
}

export async function saveTokens(env: Env, userId: string, tokens: SonosTokens): Promise<void> {
  const now = Date.now();
  const [refreshEnc, accessEnc] = await Promise.all([
    encryptSecret(tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY),
    encryptSecret(tokens.accessToken, env.TOKEN_ENCRYPTION_KEY)
  ]);
  await env.DB.prepare(
    `INSERT INTO sonos_accounts
       (user_id, refresh_token_enc, access_token_enc, access_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       refresh_token_enc = excluded.refresh_token_enc,
       access_token_enc  = excluded.access_token_enc,
       access_expires_at = excluded.access_expires_at,
       updated_at        = excluded.updated_at`
  )
    .bind(userId, refreshEnc, accessEnc, tokens.expiresAtMs, now, now)
    .run();
  // A successful exchange or refresh is the only thing that clears the flag, so a
  // reconnect resolves the warning on the status page without a separate write.
  await env.DB.prepare('UPDATE sonos_accounts SET needs_reauth = 0 WHERE user_id = ?')
    .bind(userId)
    .run();
}

/** Marks a grant as dead, so the status page can say so rather than showing silence. */
export async function markSonosNeedsReauth(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE sonos_accounts SET needs_reauth = 1 WHERE user_id = ?')
    .bind(userId)
    .run();
}

/** Raised when a user's grant is gone and only re-authorizing will fix it. */
export class SonosGrantMissing extends Error {
  constructor(readonly userId: string) {
    super(`No usable Sonos grant for user ${userId}`);
    this.name = 'SonosGrantMissing';
  }
}

/**
 * A client for one user, refreshing the access token on demand.
 *
 * The refreshed token is written back so the next request — possibly in a different
 * Worker isolate moments later — does not refresh it again.
 */
export async function clientForUser(env: Env, userId: string): Promise<SonosClient> {
  const row = await env.DB.prepare(
    'SELECT user_id, refresh_token_enc, access_token_enc, access_expires_at FROM sonos_accounts WHERE user_id = ?'
  )
    .bind(userId)
    .first<SonosAccountRow>();
  if (!row) throw new SonosGrantMissing(userId);

  const config = oauthConfig(env);
  let cached: SonosTokens | undefined;
  if (row.access_token_enc && row.access_expires_at) {
    try {
      cached = {
        accessToken: await decryptSecret(row.access_token_enc, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: '',
        expiresAtMs: row.access_expires_at
      };
    } catch {
      cached = undefined;
    }
  }

  return new SonosClient({
    baseUrl: env.SONOS_API_URL,
    accessToken: async (options) => {
      const nowMs = Date.now();
      if (!options?.force && cached && !isExpired(cached, nowMs)) return cached.accessToken;

      const refreshToken = await decryptSecret(row.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY);
      let fresh: SonosTokens;
      try {
        fresh = await refreshTokens(config, refreshToken, { nowMs });
      } catch (error) {
        // A revoked grant is reported as the same condition as a missing one, because
        // the remedy is identical — reconnect — and every caller already handles it.
        if (error instanceof SonosGrantRevoked) {
          await markSonosNeedsReauth(env, userId);
          throw new SonosGrantMissing(userId);
        }
        throw error;
      }
      cached = fresh;
      await saveTokens(env, userId, fresh);
      return fresh.accessToken;
    }
  });
}
