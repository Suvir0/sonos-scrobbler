/**
 * Account status and deletion.
 *
 * The deletion path is not a nicety: Sonos developer terms 8(b) require giving users
 * control over their own data, and this service holds OAuth credentials for other
 * people. It unsubscribes from Sonos first — leaving live subscriptions pointed at a
 * deleted account would keep Sonos delivering events nobody can act on — then removes
 * every trace, including the Durable Objects that D1's cascade cannot reach.
 */

import type { Env } from '../env.js';
import { json } from '../lib/http.js';
import { log } from '../lib/log.js';
import { clientForUser } from '../sonos/account.js';
import { listRooms } from '../rooms.js';
import { syncHousehold } from '../subscriptions.js';

export async function accountStatus(env: Env, userId: string): Promise<Response> {
  const [targets, households, groups] = await Promise.all([
    env.DB.prepare('SELECT kind, username, enabled, needs_reauth FROM targets WHERE user_id = ?')
      .bind(userId)
      .all<{ kind: string; username: string | null; enabled: number; needs_reauth: number }>(),
    env.DB.prepare('SELECT household_id, name FROM households WHERE user_id = ?')
      .bind(userId)
      .all<{ household_id: string; name: string | null }>(),
    env.DB.prepare('SELECT group_id, name FROM sonos_groups WHERE user_id = ?')
      .bind(userId)
      .all<{ group_id: string; name: string | null }>()
  ]);

  const queue = env.USER_QUEUES.get(env.USER_QUEUES.idFromName(userId));
  const depth = await queue.depth().catch(() => ({}));

  // Subscription health, because "linked" and "actually receiving events" are very
  // different things. A household can authorize cleanly, report all its rooms, and
  // still have zero subscriptions — which means Sonos sends nothing and not one track
  // ever scrobbles. Without this the UI shows a confident green tick over silence.
  const subs = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN failure_count > 0 THEN 1 ELSE 0 END) AS failing,
            MAX(last_error) AS last_error,
            MAX(last_event_at) AS last_event_at
       FROM subscriptions WHERE user_id = ?`
  )
    .bind(userId)
    .first<{
      total: number;
      failing: number | null;
      last_error: string | null;
      last_event_at: number | null;
    }>();

  const user = await env.DB.prepare('SELECT last_scrobble_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ last_scrobble_at: number | null }>();

  // The speakers themselves, each with whether it is allowed to scrobble. Distinct
  // from `rooms` below, which is the list of current *groups* and is what the
  // now-playing panel is keyed on.
  const speakers = await listRooms(env, userId);

  // Whether the Sonos grant itself is still good. Last.fm and ListenBrainz each report
  // this; the connection without which nothing works at all did not, so a revoked grant
  // looked identical to a quiet house.
  const sonos = await env.DB.prepare(
    'SELECT needs_reauth FROM sonos_accounts WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ needs_reauth: number }>();

  // What is playing right now, read live from the session objects. Not stored, not
  // historical — it disappears when playback does.
  //
  // Read in parallel. The page polls this every fifteen seconds, and one sequential
  // round trip per group means a house with thirty rooms pays thirty serialized DO
  // hops on every poll, for as long as a tab is open.
  const snapshots = await Promise.all(
    (groups.results ?? []).map(async (group) => {
      const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(group.group_id));
      return { group, snapshot: await stub.snapshot().catch(() => undefined) };
    })
  );
  const nowPlaying: { room: string; artist: string; track: string; album?: string }[] = [];
  for (const { group, snapshot } of snapshots) {
    if (snapshot?.track && snapshot.playing) {
      nowPlaying.push({
        room: group.name ?? group.group_id,
        artist: snapshot.track.artist,
        track: snapshot.track.track,
        ...(snapshot.track.album ? { album: snapshot.track.album } : {})
      });
    }
  }

  return json({
    targets: (targets.results ?? []).map((row) => ({
      kind: row.kind,
      username: row.username,
      enabled: row.enabled === 1,
      needsReauth: row.needs_reauth === 1
    })),
    households: (households.results ?? []).map((row) => ({
      id: row.household_id,
      name: row.name
    })),
    rooms: (groups.results ?? []).map((row) => row.name ?? row.group_id),
    speakers,
    sonos: { connected: sonos !== null, needsReauth: (sonos?.needs_reauth ?? 0) === 1 },
    subscriptions: {
      total: subs?.total ?? 0,
      failing: subs?.failing ?? 0,
      lastError: subs?.last_error ?? null
    },
    // The two timestamps that separate a healthy quiet service from a broken one.
    lastEventAt: subs?.last_event_at ?? null,
    lastScrobbleAt: user?.last_scrobble_at ?? null,
    nowPlaying,
    queued: depth
  });
}

export async function deleteAccount(env: Env, userId: string): Promise<Response> {
  // 1. Stop Sonos sending us anything more. Best effort: a revoked grant cannot be
  //    unsubscribed from, and that must not block the rest of the deletion.
  try {
    const client = await clientForUser(env, userId);
    const households = await env.DB.prepare(
      'SELECT household_id FROM households WHERE user_id = ?'
    )
      .bind(userId)
      .all<{ household_id: string }>();
    const groups = await env.DB.prepare('SELECT group_id FROM sonos_groups WHERE user_id = ?')
      .bind(userId)
      .all<{ group_id: string }>();

    for (const row of households.results ?? []) {
      await client.unsubscribeGroups(row.household_id).catch(() => undefined);
    }
    for (const row of groups.results ?? []) {
      await client.unsubscribePlayback(row.group_id).catch(() => undefined);
      await client.unsubscribePlaybackMetadata(row.group_id).catch(() => undefined);
    }
  } catch (error) {
    log(env, 'warn', 'account.delete.unsubscribe-failed', {
      message: error instanceof Error ? error.message : String(error)
    });
  }

  // 2. Durable Objects. D1's ON DELETE CASCADE does not reach these, so anything left
  //    here would be an orphaned queue holding somebody's plays after they asked us to
  //    forget them.
  const groups = await env.DB.prepare('SELECT group_id FROM sonos_groups WHERE user_id = ?')
    .bind(userId)
    .all<{ group_id: string }>();
  for (const row of groups.results ?? []) {
    const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(row.group_id));
    await stub.reset().catch(() => undefined);
  }
  await env.USER_QUEUES.get(env.USER_QUEUES.idFromName(userId))
    .reset()
    .catch(() => undefined);

  // 3. The row itself. Every other table cascades from it.
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

  log(env, 'info', 'account.deleted');
  return json({ deleted: true });
}

/**
 * Re-discovers households and re-subscribes everything for one user.
 *
 * Runs during linking too, but exposed on its own because it is the honest answer to
 * "my new speaker isn't scrobbling" and because a failure during linking is otherwise
 * invisible — it happens in `waitUntil`, after the response has already gone out.
 *
 * Returns the errors it hit rather than a bare 500: which household failed and why is
 * exactly what makes this diagnosable.
 */
export async function resync(env: Env, userId: string): Promise<Response> {
  const now = Date.now();
  const report: {
    households: {
      id: string;
      name: string | null;
      groups: number;
      subscribed: number;
      errors: string[];
      vanished: string[];
    }[];
    error?: string;
  } = { households: [] };

  try {
    const client = await clientForUser(env, userId);
    const households = await client.getHouseholds();

    for (const household of households) {
      await env.DB.prepare(
        `INSERT INTO households (household_id, user_id, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(household_id, user_id) DO UPDATE SET name = excluded.name`
      )
        .bind(household.id, userId, household.name ?? null, now)
        .run();

      // force: a person pressed a button and is watching; the interval floor exists to
      // damp machine-driven storms, not to ignore them.
      const result = await syncHousehold(env, userId, household.id, client, now, { force: true });
      // Joined into a string deliberately: the logger collapses object values to
      // '[object]' to keep structured content out of logs, so an array would vanish.
      if (result.errors.length || result.vanished.length) {
        log(env, 'warn', 'account.resync.subscribe-problems', {
          groups: result.groupsSeen,
          subscribed: result.subscribed,
          errors: result.errors.join(' | '),
          vanished: result.vanished.join(' | ')
        });
      }
      report.households.push({
        id: household.id,
        name: household.name ?? null,
        groups: result.groupsSeen,
        subscribed: result.subscribed,
        errors: result.errors,
        vanished: result.vanished
      });
    }
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(env, 'error', 'account.resync.failed', { message: report.error });
    return json(report, { status: 500 });
  }

  log(env, 'info', 'account.resync.complete', { households: report.households.length });
  return json(report);
}
