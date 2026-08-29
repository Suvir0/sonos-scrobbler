/**
 * A health check that actually exercises the configuration.
 *
 * "Does the Worker respond" is worth almost nothing here: this service can be up,
 * serving pages, and completely unable to scrobble because a secret was pasted with a
 * stray character or an encryption key does not decode to 32 bytes. Those failures
 * otherwise surface at the worst possible moment — when a real user tries to link an
 * account — and look like an ordinary error.
 *
 * So this round-trips the encryption, exercises both HMAC keys, and touches the
 * database. It reports which checks failed but never a secret's value, and reports
 * missing keys by name only.
 */

import type { Env } from '../env.js';
import { decryptSecret, encryptSecret, hmacHex } from '../lib/crypto.js';
import { json } from '../lib/http.js';

const REQUIRED = [
  'SONOS_CLIENT_ID',
  'SONOS_CLIENT_SECRET',
  'LASTFM_API_KEY',
  'LASTFM_API_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'SCROBBLE_KEY_SALT',
  'SESSION_SECRET'
] as const satisfies readonly (keyof Env)[];

export async function health(env: Env): Promise<Response> {
  const checks: Record<string, string> = {};

  const missing = REQUIRED.filter((name) => !env[name]);
  checks.config = missing.length ? `missing: ${missing.join(', ')}` : 'ok';

  // The one that matters most: a key that does not decode to exactly 32 bytes throws
  // here rather than the first time somebody links an account.
  try {
    const probe = 'health-probe';
    const sealed = await encryptSecret(probe, env.TOKEN_ENCRYPTION_KEY);
    checks.encryption = (await decryptSecret(sealed, env.TOKEN_ENCRYPTION_KEY)) === probe
      ? 'ok'
      : 'round-trip mismatch';
  } catch (error) {
    checks.encryption = error instanceof Error ? error.message : 'failed';
  }

  for (const [label, secret] of [
    ['scrobbleKeySalt', env.SCROBBLE_KEY_SALT],
    ['sessionSecret', env.SESSION_SECRET]
  ] as const) {
    try {
      await hmacHex(secret, 'probe');
      checks[label] = 'ok';
    } catch (error) {
      checks[label] = error instanceof Error ? error.message : 'failed';
    }
  }

  try {
    await env.DB.prepare('SELECT 1').first();
    checks.database = 'ok';
  } catch {
    checks.database = 'unreachable';
  }

  const healthy = Object.values(checks).every((value) => value === 'ok');
  return json({ status: healthy ? 'ok' : 'degraded', checks }, { status: healthy ? 200 : 503 });
}
