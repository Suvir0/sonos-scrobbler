/**
 * Structured logging with redaction.
 *
 * Two rules, both load-bearing:
 *
 *  - **Never log a credential.** Anything that looks like a token, session key or
 *    signature is replaced before it reaches the log. Workers logs are retained and
 *    searchable, so a leaked refresh token there is a leaked refresh token.
 *  - **Never log content.** Artist and track names are exactly the "content data" this
 *    service undertakes not to record, and a log is a record. Call sites log group ids
 *    and reasons; a field named `artist` or `track` is dropped here as a backstop.
 */

import type { Env } from '../env.js';

const SECRET_KEYS = /token|secret|key|signature|credential|password|authorization/i;
const CONTENT_KEYS = /^(artist|track|album|title|streamInfo|nowPlaying|scrobbled)$/i;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (CONTENT_KEYS.test(key)) continue;
    if (SECRET_KEYS.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = typeof value === 'object' && value !== null ? '[object]' : value;
  }
  return out;
}

export function log(
  env: Pick<Env, 'ENVIRONMENT'>,
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const line = JSON.stringify({ level, event, env: env.ENVIRONMENT, ...redact(fields) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
