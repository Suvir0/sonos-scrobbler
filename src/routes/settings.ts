/**
 * The two playback-source choices, and nothing else.
 *
 * Both columns have existed in the schema since the first migration and both are read
 * on every event, but neither was reachable by a user — so the defaults were the only
 * values that ever existed. That is a problem for a public service rather than a
 * personal one: radio scrobbling in particular is a matter of taste (a station ident
 * that plays for four minutes becomes a play), and a service that decides it for you
 * with no way to change it will be judged on the wrong plays it submits.
 *
 * Applied on the next event, not retroactively: the GroupSession's config is rewritten
 * by `initialize` each time an event arrives, so a change takes effect at the start of
 * the next track rather than reclassifying one already in flight.
 */

import type { Env } from '../env.js';
import { json, problem } from '../lib/http.js';

export interface Settings {
  scrobbleRadio: boolean;
  allowHandoff: boolean;
}

export async function readSettings(env: Env, userId: string): Promise<Settings> {
  const row = await env.DB.prepare('SELECT scrobble_radio, allow_handoff FROM users WHERE id = ?')
    .bind(userId)
    .first<{ scrobble_radio: number; allow_handoff: number }>();
  return {
    scrobbleRadio: (row?.scrobble_radio ?? 1) === 1,
    allowHandoff: (row?.allow_handoff ?? 0) === 1
  };
}

export async function getSettings(env: Env, userId: string): Promise<Response> {
  return json(await readSettings(env, userId));
}

export async function updateSettings(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const body = (await request.json().catch(() => undefined)) as Partial<Settings> | undefined;
  if (!body || typeof body !== 'object') {
    return problem(400, 'bad_request', 'Expected a JSON object.');
  }

  // A partial update, so the page can send one toggle without having to know the other.
  // An absent key keeps its stored value; a present key must actually be a boolean,
  // because coercing `"false"` to true is the kind of bug that silently re-enables
  // something a user turned off.
  const current = await readSettings(env, userId);
  const next: Settings = {
    scrobbleRadio:
      typeof body.scrobbleRadio === 'boolean' ? body.scrobbleRadio : current.scrobbleRadio,
    allowHandoff: typeof body.allowHandoff === 'boolean' ? body.allowHandoff : current.allowHandoff
  };

  await env.DB.prepare('UPDATE users SET scrobble_radio = ?, allow_handoff = ? WHERE id = ?')
    .bind(next.scrobbleRadio ? 1 : 0, next.allowHandoff ? 1 : 0, userId)
    .run();

  return json(next);
}
