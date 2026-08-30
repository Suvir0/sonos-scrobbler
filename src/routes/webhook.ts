/**
 * The Sonos event endpoint.
 *
 * The single most important property of this handler is that it answers fast. Sonos
 * retries a failed delivery once a second, three times, and then discards the event
 * permanently — there is no replay and no dead-letter queue on their side, so a slow
 * or erroring endpoint is a silently missed scrobble. Everything past verification
 * therefore happens in `waitUntil`, after the 200 has gone out.
 *
 * It also always answers 200, even for events it rejects. A 4xx would buy nothing —
 * Sonos does not act on the status beyond retrying — and would turn every unexpected
 * payload into three more deliveries of the same unexpected payload.
 */

import type { Env } from '../env.js';
import {
  isFreshSequence,
  isKnownNamespace,
  readEventBody,
  readEventHeaders,
  verifySignature,
  type SonosEventHeaders
} from '../sonos/events.js';
import type { GroupsStatus, MetadataStatus, PlaybackStatus } from '../sonos/types.js';
import { clientForUser } from '../sonos/account.js';
import { syncHousehold } from '../subscriptions.js';
import { groupSessionName } from '../do/group-session.js';
import { groupMayScrobble } from '../rooms.js';
import { log } from '../lib/log.js';

const OK = new Response(null, { status: 200 });

export async function handleSonosWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const headers = readEventHeaders(request);
  if (!headers) {
    log(env, 'warn', 'sonos.event.malformed-headers');
    return OK;
  }

  if (
    !(await verifySignature(headers, {
      clientId: env.SONOS_CLIENT_ID,
      clientSecret: env.SONOS_CLIENT_SECRET
    }))
  ) {
    // Not from Sonos, or our client secret is wrong. Both are worth seeing in logs;
    // neither is worth telling the caller about.
    log(env, 'warn', 'sonos.event.bad-signature', { namespace: headers.namespace });
    return OK;
  }

  if (!isKnownNamespace(headers.namespace)) return OK;

  const body = await readEventBody<unknown>(request);
  if (body === undefined) return OK;

  // Answer now; do the work after. Nothing below this line may delay the response.
  ctx.waitUntil(dispatch(env, headers, body).catch((error: unknown) => {
    log(env, 'error', 'sonos.event.failed', {
      namespace: headers.namespace,
      message: error instanceof Error ? error.message : String(error)
    });
  }));

  return OK;
}

/**
 * Routes one verified event to everybody it belongs to.
 *
 * An event names a Sonos group or household — never a person. A household can have more
 * than one member, and a person who returns without a session cookie becomes a second
 * account for the same speakers, so the same target legitimately has more than one
 * subscriber. Both of them heard the same song out of the same speaker, so both get it.
 *
 * Each subscriber is handled independently and in isolation: one user's dead Sonos grant
 * or failing queue must not stop the event reaching the others.
 */
async function dispatch(env: Env, headers: SonosEventHeaders, body: unknown): Promise<void> {
  const nowMs = Date.now();
  const targetId = headers.targetValue;
  const scope = headers.namespace === 'groups' ? 'household' : 'group';

  const subscribers = await env.DB.prepare(
    `SELECT id, user_id, household_id, last_seq_id
       FROM subscriptions
      WHERE scope = ? AND target_id = ? AND namespace = ?`
  )
    .bind(scope, targetId, headers.namespace)
    .all<{ id: string; user_id: string; household_id: string; last_seq_id: number | null }>();

  const rows = subscribers.results ?? [];
  if (!rows.length) {
    // An event for something we no longer track — a pruned group, an unlinked account.
    log(env, 'info', 'sonos.event.unknown-subscription', {
      namespace: headers.namespace,
      targetId
    });
    return;
  }

  const outcomes = await Promise.allSettled(
    rows.map((row) => deliver(env, headers, body, row, nowMs))
  );
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      log(env, 'error', 'sonos.event.subscriber-failed', {
        namespace: headers.namespace,
        message:
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      });
    }
  }
}

/** One subscriber's share of one event. */
async function deliver(
  env: Env,
  headers: SonosEventHeaders,
  body: unknown,
  row: { id: string; user_id: string; household_id: string; last_seq_id: number | null },
  nowMs: number
): Promise<void> {
  // The signature covers only headers, not the body, so a captured request could be
  // replayed carrying different content. The sequence high-water mark is what stops it.
  // Per subscription row, so one subscriber's high-water mark cannot suppress another's.
  if (!isFreshSequence(headers.seqId, row.last_seq_id ?? undefined)) {
    log(env, 'warn', 'sonos.event.stale-sequence', { id: row.id, seqId: headers.seqId });
    return;
  }
  // last_event_at rides along on an UPDATE that was happening anyway, and is what
  // lets the status page distinguish "nobody is listening" from "nothing is arriving".
  await env.DB.prepare('UPDATE subscriptions SET last_seq_id = ?, last_event_at = ? WHERE id = ?')
    .bind(Number(headers.seqId), nowMs, row.id)
    .run();

  const targetId = headers.targetValue;

  if (headers.namespace === 'groups') {
    // The topology changed: subscribe any brand new group immediately rather than
    // waiting for the next renewal, and stop paying for ones that vanished.
    //
    // Three things here exist solely to avoid a feedback loop that took the service to
    // 993 requests in 35 seconds and tripped the application-wide quota:
    //
    //  - `subscribeHousehold: false` — subscribing the `groups` namespace makes Sonos
    //    deliver a groups event, so doing it here is the loop, directly.
    //  - `knownGroups` — the event body already carries the topology, so re-fetching it
    //    spends a request per event for information we were just handed.
    //  - `onlyMissing` — an unchanged topology then costs no Sonos requests at all.
    const payload = body as GroupsStatus;
    const client = await clientForUser(env, row.user_id);
    const result = await syncHousehold(env, row.user_id, row.household_id, client, nowMs, {
      subscribeHousehold: false,
      onlyMissing: true,
      ...(payload.groups ? { knownGroups: payload.groups } : {}),
      // The room names, from the same payload. Without them a brand new group is
      // recorded with member ids nothing can put a name to, and its rooms are missing
      // from the page that is supposed to let somebody switch them off.
      ...(payload.players ? { knownPlayers: payload.players } : {})
    });
    log(env, 'info', 'sonos.groups.event', {
      householdId: row.household_id,
      groups: result.groupsSeen,
      subscribed: result.subscribed,
      throttled: result.throttled,
      callsUsed: result.callsUsed
    });
    return;
  }

  const session = env.GROUP_SESSIONS.get(
    env.GROUP_SESSIONS.idFromName(groupSessionName(row.user_id, targetId))
  );

  // Cheap and idempotent, and it means a session created by an event rather than by
  // the link flow still knows whose it is and what their source policy is.
  const [settings, mayScrobble] = await Promise.all([
    env.DB.prepare(
      'SELECT scrobble_radio, allow_handoff, skip_long_tracks FROM users WHERE id = ?'
    )
      .bind(row.user_id)
      .first<{ scrobble_radio: number; allow_handoff: number; skip_long_tracks: number }>(),
    // Resolved per event rather than stored on the session: the answer changes when
    // somebody regroups rooms, not only when they change a setting, and a regroup
    // produces a new group id whose session has never been initialized at all.
    groupMayScrobble(env, row.user_id, targetId)
  ]);

  await session.initialize({
    userId: row.user_id,
    householdId: row.household_id,
    groupId: targetId,
    allowRadio: (settings?.scrobble_radio ?? 1) === 1,
    allowHandoff: (settings?.allow_handoff ?? 0) === 1,
    skipLongTracks: (settings?.skip_long_tracks ?? 1) === 1,
    scrobbleEnabled: mayScrobble
  });

  const outcome =
    headers.namespace === 'playback'
      ? await session.onPlaybackStatus(body as PlaybackStatus, nowMs)
      : await session.onMetadataStatus(body as MetadataStatus, nowMs);

  if (outcome.nowPlaying) {
    const queue = env.USER_QUEUES.get(env.USER_QUEUES.idFromName(row.user_id));
    // Fire and forget: a now-playing update expires on its own and must never be queued.
    await queue.announce(row.user_id, outcome.nowPlaying).catch(() => undefined);
  }

  // Deliberately logs that a scrobble happened, not what it was. A log line naming the
  // track would be exactly the durable record of listening this service promises not
  // to keep.
  if (outcome.scrobbled) {
    await env.DB.prepare('UPDATE users SET last_scrobble_at = ? WHERE id = ?')
      .bind(nowMs, row.user_id)
      .run();
    log(env, 'info', 'scrobble.enqueued', { groupId: targetId });
  }
  if (outcome.declined) log(env, 'info', 'scrobble.declined', {
    groupId: targetId,
    reason: outcome.declined
  });
}

/** Exported for the reconciliation sweep, which needs the same group-status handling. */
export type { GroupsStatus };
