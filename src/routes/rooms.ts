/**
 * Turning one room's scrobbling on or off.
 *
 * Separate from `/api/settings` because the two are different kinds of thing: a
 * setting is a policy about sources and applies everywhere, whereas this names a
 * specific speaker. Merging them would mean a single endpoint whose body is either a
 * pair of booleans or a player id, which is the shape that gets a room switched off by
 * a typo.
 *
 * Applied on the next event, like the settings are. A track already in flight in a
 * room that is switched off here is dropped rather than finalized: see
 * `GroupSession.standDown`.
 */

import type { Env } from '../env.js';
import { json, problem } from '../lib/http.js';
import { listRooms, setRoomScrobble } from '../rooms.js';

export async function getRooms(env: Env, userId: string): Promise<Response> {
  return json({ rooms: await listRooms(env, userId) });
}

export async function updateRoom(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const body = (await request.json().catch(() => undefined)) as
    | { playerId?: unknown; scrobble?: unknown }
    | undefined;
  if (!body || typeof body !== 'object') {
    return problem(400, 'bad_request', 'Expected a JSON object.');
  }
  if (typeof body.playerId !== 'string' || !body.playerId) {
    return problem(400, 'bad_value', 'playerId must be a string.');
  }
  // Same reasoning as the settings route: a value that is not a boolean is refused
  // rather than coerced, because coercing `"false"` to true silently switches a room
  // back on after somebody turned it off.
  if (typeof body.scrobble !== 'boolean') {
    return problem(400, 'bad_value', 'scrobble must be true or false.');
  }

  const changed = await setRoomScrobble(env, userId, body.playerId, body.scrobble);
  if (!changed) {
    // Not one of this user's speakers. Answering 200 here would report a saved setting
    // that does not exist, and the page would show a room as switched off while every
    // event kept scrobbling it.
    return problem(404, 'unknown_room', 'That is not one of your rooms.');
  }

  return json({ rooms: await listRooms(env, userId) });
}
