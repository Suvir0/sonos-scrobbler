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
import { groupSessionName } from '../do/group-session.js';
import { currentRecoveryKey, issueRecoveryKey, recoveryUrl } from '../lib/recovery.js';

export async function accountStatus(env: Env, userId: string): Promise<Response> {
  const [targets, households, groups] = await Promise.all([
    env.DB.prepare(
      'SELECT kind, username, enabled, needs_reauth, last_error, foreign_scrobble_at FROM targets WHERE user_id = ?'
    )
      .bind(userId)
      .all<{
        kind: string;
        username: string | null;
        enabled: number;
        needs_reauth: number;
        last_error: string | null;
        foreign_scrobble_at: number | null;
      }>(),
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

  // Groups whose membership we could not resolve. On its own that is harmless, but a
  // user who has switched a room off and has an unresolved group is one whose choice
  // cannot currently be applied — `groupMayScrobble` refuses those rather than
  // scrobbling a room somebody turned off. Saying so is what stops that reading as the
  // service having quietly stopped working.
  const unresolved = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sonos_groups WHERE user_id = ? AND player_ids IS NULL'
  )
    .bind(userId)
    .first<{ n: number }>();
  const roomsNeedRescan =
    (unresolved?.n ?? 0) > 0 && speakers.some((room) => !room.scrobble);

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
      const stub = env.GROUP_SESSIONS.get(
        env.GROUP_SESSIONS.idFromName(groupSessionName(userId, group.group_id))
      );
      return { group, snapshot: await stub.snapshot().catch(() => undefined) };
    })
  );
  // `service` is the music service Sonos names on the container or the track — Spotify,
  // Apple Music, a radio provider. Not content data: it says where a play came from, not
  // what it was, and it is the one field that distinguishes "your speaker is playing" from
  // "your speaker is playing something an app elsewhere is also tracking". Carried
  // through because the classifier already resolves it and dropping it here made a
  // duplicate-scrobble investigation far harder than it needed to be.
  const nowPlaying: {
    room: string;
    artist: string;
    track: string;
    album?: string;
    service?: string;
  }[] = [];
  for (const { group, snapshot } of snapshots) {
    if (snapshot?.track && snapshot.playing) {
      nowPlaying.push({
        room: group.name ?? group.group_id,
        artist: snapshot.track.artist,
        track: snapshot.track.track,
        ...(snapshot.track.album ? { album: snapshot.track.album } : {}),
        ...(snapshot.track.serviceName ? { service: snapshot.track.serviceName } : {})
      });
    }
  }

  return json({
    targets: (targets.results ?? []).map((row) => ({
      kind: row.kind,
      username: row.username,
      enabled: row.enabled === 1,
      needsReauth: row.needs_reauth === 1,
      // What the service itself said. The page prefers this over its own wording,
      // because a generic "credentials were rejected" is wrong whenever the credential
      // was not the problem — and it is the cases where it is wrong that leave somebody
      // re-pasting a working token forever.
      lastError: row.last_error,
      // When duplicate scrobbles were last seen on this account. Not a fault in the
      // pipeline — it means something else is writing here too, which is otherwise
      // indistinguishable from this service misbehaving.
      duplicatesSeenAt: row.foreign_scrobble_at
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
    roomsNeedRescan,
    // The two timestamps that separate a healthy quiet service from a broken one.
    lastEventAt: subs?.last_event_at ?? null,
    lastScrobbleAt: user?.last_scrobble_at ?? null,
    nowPlaying,
    queued: depth
  });
}

/** Whether some other account still subscribes to this household or group. */
async function sharedWithAnotherUser(
  env: Env,
  userId: string,
  scope: 'household' | 'group',
  targetId: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS present FROM subscriptions WHERE scope = ? AND target_id = ? AND user_id != ? LIMIT 1'
  )
    .bind(scope, targetId, userId)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * This account's sign-in link.
 *
 * Its own endpoint rather than a field on `/api/account`, because that one is polled
 * every fifteen seconds and a bearer credential does not belong in a response repeated
 * four times a minute for as long as a tab is open. This is read once, when the page
 * draws the panel that shows it.
 */
export async function getRecoveryLink(env: Env, userId: string): Promise<Response> {
  return json({ url: recoveryUrl(env, await currentRecoveryKey(env, userId)) });
}

/** Replaces the link. The previous one stops working immediately. */
export async function rotateRecoveryLink(env: Env, userId: string): Promise<Response> {
  const url = recoveryUrl(env, await issueRecoveryKey(env, userId));
  log(env, 'info', 'recovery.rotated');
  return json({ url });
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

    // Only for targets nobody else is still listening to.
    //
    // Sonos has one subscription per application per target, not one per user of this
    // service, so cancelling it cancels it for every account that shares the household.
    // Without this check, one member of a household deleting their account would stop
    // the other's scrobbling dead, with nothing on their page to say why.
    for (const row of households.results ?? []) {
      if (await sharedWithAnotherUser(env, userId, 'household', row.household_id)) continue;
      await client.unsubscribeGroups(row.household_id).catch(() => undefined);
    }
    for (const row of groups.results ?? []) {
      if (await sharedWithAnotherUser(env, userId, 'group', row.group_id)) continue;
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
    const stub = env.GROUP_SESSIONS.get(
      env.GROUP_SESSIONS.idFromName(groupSessionName(userId, row.group_id))
    );
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
