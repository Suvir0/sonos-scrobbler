/**
 * The way back into an account that does not depend on a cookie.
 *
 * Sonos is the only identity this service has, and nothing Sonos returns says who the
 * person is — only which households they can reach, which a household's other members
 * can reach too. So "sign in with Sonos" cannot tell a returning user from a new one,
 * and before this existed a cleared cookie meant a second account for the same speakers,
 * with the first one left holding live credentials its owner could no longer see, delete,
 * or stop from scrobbling alongside the new one.
 *
 * A long random token the user keeps closes that. It is a bearer credential, so:
 *
 *  - `recovery_hash` is what a presented token is looked up by. It is an HMAC, unique
 *    and indexed, so a dump of the users table cannot be turned back into sign-in links.
 *  - `recovery_enc` is the same token under AES-GCM, so a signed-in person can read
 *    their own link back whenever they want. Storing it only as a hash would mean one
 *    chance to copy it at signup, and a non-technical user who scrolled past that banner
 *    would be locked out of their own account for good — which is the failure this whole
 *    file exists to prevent. It is no more exposed than the Sonos refresh token already
 *    sitting beside it under the same key.
 */

import type { Env } from '../env.js';
import { decryptSecret, encryptSecret, hmacHex, randomToken } from './crypto.js';

/** 32 bytes. Guessing one is not a threat model anybody has to think about. */
const RECOVERY_TOKEN_BYTES = 32;

export function recoveryUrl(env: Env, token: string): string {
  const url = new URL('/auth/recover', env.PUBLIC_BASE_URL);
  url.searchParams.set('key', token);
  return url.toString();
}

/** Mints a fresh token, replacing any existing one. The old link stops working at once. */
export async function issueRecoveryKey(env: Env, userId: string): Promise<string> {
  const token = randomToken(RECOVERY_TOKEN_BYTES);
  const [hash, sealed] = await Promise.all([
    hmacHex(env.SESSION_SECRET, token),
    encryptSecret(token, env.TOKEN_ENCRYPTION_KEY)
  ]);
  await env.DB.prepare('UPDATE users SET recovery_hash = ?, recovery_enc = ? WHERE id = ?')
    .bind(hash, sealed, userId)
    .run();
  return token;
}

/**
 * This user's current token, minting one if they have none.
 *
 * Accounts created before migration 0006 have no key, and so does one whose stored
 * ciphertext no longer decrypts. Both get a fresh one rather than an error: an account
 * with no way back in is the exact condition this is here to remove.
 */
export async function currentRecoveryKey(env: Env, userId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT recovery_enc FROM users WHERE id = ?')
    .bind(userId)
    .first<{ recovery_enc: string | null }>();
  if (row?.recovery_enc) {
    try {
      return await decryptSecret(row.recovery_enc, env.TOKEN_ENCRYPTION_KEY);
    } catch {
      // The encryption key changed. A key nobody can read is not a key.
    }
  }
  return issueRecoveryKey(env, userId);
}

/** The account a presented token belongs to, or undefined. */
export async function userForRecoveryKey(
  env: Env,
  token: string
): Promise<string | undefined> {
  if (!token) return undefined;
  const row = await env.DB.prepare('SELECT id FROM users WHERE recovery_hash = ?')
    .bind(await hmacHex(env.SESSION_SECRET, token))
    .first<{ id: string }>();
  return row?.id;
}
