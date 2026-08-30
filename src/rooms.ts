/**
 * Which rooms are allowed to scrobble.
 *
 * The unit a user thinks in is a room. The unit Sonos sends events for is a group, and
 * a group is transient — link the kitchen to the living room and a new group id exists
 * that neither room had a moment ago. So the preference is stored per player (the
 * speaker, whose id is stable) and resolved to a group at the moment an event arrives.
 *
 * A group scrobbles only when every room in it is switched on. That direction is
 * chosen deliberately: turning a room off is then a guarantee about that speaker
 * rather than a guarantee that holds until somebody groups it with another one. The
 * cost is that grouping an off room onto an on room silences both, which is the
 * behaviour a person who switched a room off would want if asked.
 */

import type { Env } from './env.js';

export interface Room {
  id: string;
  name: string | null;
  scrobble: boolean;
}

export async function listRooms(env: Env, userId: string): Promise<Room[]> {
  const rows = await env.DB.prepare(
    'SELECT player_id, name, scrobble FROM sonos_players WHERE user_id = ? ORDER BY name, player_id'
  )
    .bind(userId)
    .all<{ player_id: string; name: string | null; scrobble: number }>();
  return (rows.results ?? []).map((row) => ({
    id: row.player_id,
    name: row.name,
    scrobble: row.scrobble === 1
  }));
}

/**
 * Turns one room on or off.
 *
 * Returns false when the player is not one of this user's, so a request naming
 * somebody else's speaker is a 404 rather than a silent no-op that answers 200.
 */
export async function setRoomScrobble(
  env: Env,
  userId: string,
  playerId: string,
  scrobble: boolean
): Promise<boolean> {
  const result = await env.DB.prepare(
    'UPDATE sonos_players SET scrobble = ? WHERE user_id = ? AND player_id = ?'
  )
    .bind(scrobble ? 1 : 0, userId, playerId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * The player ids recorded for a group, or undefined when the topology is unknown.
 *
 * Scoped by user: since migration 0006 a group belongs to each account that can see it,
 * and reading another member's row would answer this user's question with somebody
 * else's speakers.
 */
export async function groupPlayerIds(
  env: Env,
  userId: string,
  groupId: string
): Promise<string[] | undefined> {
  const row = await env.DB.prepare(
    'SELECT player_ids FROM sonos_groups WHERE group_id = ? AND user_id = ?'
  )
    .bind(groupId, userId)
    .first<{ player_ids: string | null }>();
  if (!row?.player_ids) return undefined;
  try {
    const parsed: unknown = JSON.parse(row.player_ids);
    if (!Array.isArray(parsed)) return undefined;
    const ids = parsed.filter((id): id is string => typeof id === 'string');
    return ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a group may scrobble, given the rooms in it.
 *
 * Unknown topology means yes. A group whose players we have not recorded yet is a
 * group that was just created, or one carried over from before this table existed, and
 * refusing those would stop scrobbling for a reason no user could see or fix. The
 * failure this feature must avoid is scrobbling a room somebody switched off, and an
 * unrecorded group has no switched-off room in it by definition.
 */
export async function groupMayScrobble(
  env: Env,
  userId: string,
  groupId: string
): Promise<boolean> {
  const playerIds = await groupPlayerIds(env, userId, groupId);
  if (!playerIds) return true;

  const placeholders = playerIds.map(() => '?').join(', ');
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS off_count FROM sonos_players
      WHERE user_id = ? AND scrobble = 0 AND player_id IN (${placeholders})`
  )
    .bind(userId, ...playerIds)
    .first<{ off_count: number }>();

  return (row?.off_count ?? 0) === 0;
}
