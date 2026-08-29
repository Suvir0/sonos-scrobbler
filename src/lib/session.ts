/**
 * Website login sessions.
 *
 * The cookie holds a random token; the database holds only its HMAC. A dump of the
 * sessions table therefore cannot be used to impersonate anybody, which matters more
 * here than usual because the same database holds the OAuth credentials those sessions
 * unlock.
 */

import type { Env } from '../env.js';
import { hmacHex, randomToken } from './crypto.js';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(await hmacHex(env.SESSION_SECRET, token), userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

export function sessionCookie(token: string, env: Env): string {
  const secure = env.PUBLIC_BASE_URL.startsWith('https://') ? '; Secure' : '';
  // Lax rather than Strict: the OAuth callbacks are top-level cross-site navigations,
  // and under Strict the cookie would not be sent on the hop back from Sonos.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearedCookie(env: Env): string {
  const secure = env.PUBLIC_BASE_URL.startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

export async function currentUserId(request: Request, env: Env): Promise<string | undefined> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return undefined;
  const row = await env.DB.prepare(
    'SELECT user_id, expires_at FROM sessions WHERE token_hash = ?'
  )
    .bind(await hmacHex(env.SESSION_SECRET, token))
    .first<{ user_id: string; expires_at: number }>();
  if (!row) return undefined;
  if (row.expires_at <= Date.now()) return undefined;
  return row.user_id;
}

export async function destroySession(request: Request, env: Env): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(await hmacHex(env.SESSION_SECRET, token))
    .run();
}
