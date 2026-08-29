/**
 * Keeping Sonos subscriptions alive.
 *
 * Two failure modes this exists to prevent, both of which look to a user like
 * "scrobbling just stopped one day and nothing said why":
 *
 *  1. **Lapse.** A subscription dies after three days. Resubscribing extends it another
 *     three, so renewal has to run comfortably inside that window.
 *  2. **Drift.** Groups are created and destroyed constantly as people move rooms
 *     around, and `playback`/`playbackMetadata` are group-scoped. A subscription to a
 *     group that no longer exists is useless, and a new group with no subscription is
 *     invisible.
 *
 * The `groups` namespace is the anchor for both: it is household-scoped, so one
 * subscription tells us whenever the group topology changes.
 *
 * RATE LIMIT: the quota is 1,000 requests/minute for the whole application, across
 * every user. Renewal is therefore a bounded slice ordered by `next_renewal_at` rather
 * than a sweep over everybody, and `RENEWAL_CALL_BUDGET` is the ceiling per run.
 */

import type { Env } from './env.js';
import { SonosApiError } from './sonos/client.js';
import type { SonosClient } from './sonos/client.js';
import { clientForUser, SonosGrantMissing } from './sonos/account.js';

/** Sonos expires a subscription after three days of no renewal. */
export const SUBSCRIPTION_TTL_MS = 3 * 24 * 60 * 60_000;

/**
 * Renew a day after subscribing, giving two full days of slack.
 *
 * Deliberately generous: a renewal that fails still has two more scheduled attempts
 * before the subscription actually lapses, so a transient Sonos outage costs nothing.
 */
export const RENEWAL_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Requests one cron run may spend.
 *
 * The cron fires every 15 minutes against a 1,000/min quota shared with live traffic,
 * so this is set well below what is available rather than at it.
 */
export const RENEWAL_CALL_BUDGET = 300;

/** First retry delay for a subscription that would not renew. */
export const RETRY_BASE_MS = 5 * 60_000;

/** Ceiling on the backoff, so a failing subscription keeps trying rather than giving up. */
export const RETRY_CAP_MS = 6 * 60 * 60_000;

/** Backoff for a subscription that will not renew, capped so it keeps trying. */
export function retryDelayMs(failureCount: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(failureCount, 6));
}

export type Namespace = 'groups' | 'playback' | 'playbackMetadata';

export function subscriptionId(scope: 'household' | 'group', targetId: string, ns: Namespace) {
  return `${scope}:${targetId}:${ns}`;
}

async function recordSuccess(
  env: Env,
  row: { id: string; userId: string; householdId: string; scope: 'household' | 'group'; targetId: string; namespace: Namespace },
  nowMs: number
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscriptions
       (id, user_id, household_id, scope, target_id, namespace,
        subscribed_at, expires_at, next_renewal_at, failure_count, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(id) DO UPDATE SET
       subscribed_at   = excluded.subscribed_at,
       expires_at      = excluded.expires_at,
       next_renewal_at = excluded.next_renewal_at,
       failure_count   = 0,
       last_error      = NULL`
  )
    .bind(
      row.id,
      row.userId,
      row.householdId,
      row.scope,
      row.targetId,
      row.namespace,
      nowMs,
      nowMs + SUBSCRIPTION_TTL_MS,
      nowMs + RENEWAL_INTERVAL_MS
    )
    .run();
}

/**
 * Records a failed subscribe and pushes the row's next attempt out.
 *
 * The delay is computed in SQL from the row's own `failure_count` rather than passed
 * in, because the caller does not know it — and a fixed five minutes (which is what
 * `retryDelayMs(0)` gave every failure regardless of history) means a subscription that
 * can never succeed is retried twelve times an hour forever. That is the shape of
 * starvation this whole file exists to avoid: `renewDue` orders by `next_renewal_at`
 * and takes the first hundred, so rows that never move to the back of the queue
 * eventually fill the slice and delay renewals that would have worked.
 *
 * `1 << MIN(failure_count, 6)` is `retryDelayMs`'s doubling, expressed in SQLite. The
 * column still holds its pre-increment value inside this statement, which is the same
 * argument `retryDelayMs` takes.
 */
async function recordFailure(env: Env, id: string, error: unknown, nowMs: number): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await env.DB.prepare(
    `UPDATE subscriptions
        SET failure_count = failure_count + 1,
            last_error = ?,
            next_renewal_at = ? + MIN(?, ? * (1 << MIN(failure_count, 6)))
      WHERE id = ?`
  )
    .bind(message.slice(0, 500), nowMs, RETRY_CAP_MS, RETRY_BASE_MS, id)
    .run();
}

/**
 * The shortest interval between topology re-syncs for one household.
 *
 * A backstop against the feedback loop described in migration 0002: subscribing to a
 * household's `groups` namespace makes Sonos deliver a groups event, and a handler that
 * re-subscribes on that event loops until the shared API quota collapses. The
 * structural fix is `subscribeHousehold: false` on the event path; this is the floor
 * that holds even if some future path forgets.
 */
export const MIN_TOPOLOGY_SYNC_INTERVAL_MS = 30_000;

export interface SyncOptions {
  /**
   * Whether to (re-)subscribe the household-level `groups` namespace.
   *
   * MUST be false when handling a groups event. Subscribing here causes Sonos to send
   * a groups event to the subscriber, so doing it in that event's own handler is the
   * loop itself.
   */
  subscribeHousehold?: boolean;
  /** Skip groups that already hold both per-group subscriptions. */
  onlyMissing?: boolean;
  /**
   * Groups from an event payload, used instead of spending a `getGroups` call. A
   * groups event already carries the full topology.
   */
  knownGroups?: readonly { id: string; name?: string }[];
  /** Bypass the interval floor. Only for a user-initiated resync. */
  force?: boolean;
  /**
   * Most Sonos requests this one call may spend.
   *
   * Without it a household's group loop is unbounded: two subscribes per group, so a
   * household with two hundred groups spends four hundred requests inside a single
   * call, past the whole run's budget, against a quota shared with live webhook
   * traffic. Stopping early is safe because every group not reached keeps its existing
   * `next_renewal_at` and is simply picked up by the next sweep.
   */
  callBudget?: number;
}

export interface SyncResult {
  groupsSeen: number;
  subscribed: number;
  callsUsed: number;
  errors: string[];
  /** Subscribes that 404'd because the group disappeared. Expected, but not silent. */
  vanished: string[];
  /** True when the interval floor suppressed this sync entirely. */
  throttled: boolean;
  /** True when `callBudget` ran out before every group was reached. */
  budgetExhausted: boolean;
}

/**
 * Brings one household's subscriptions in line with the groups that currently exist.
 *
 * Idempotent by design — Sonos treats a repeat subscribe as a renewal — so this is safe
 * to call from a link flow, a `groups` event, and the renewal cron alike.
 */
export async function syncHousehold(
  env: Env,
  userId: string,
  householdId: string,
  client: SonosClient,
  nowMs = Date.now(),
  options: SyncOptions = {}
): Promise<SyncResult> {
  const {
    subscribeHousehold = true,
    onlyMissing = false,
    knownGroups,
    force = false,
    callBudget = Number.POSITIVE_INFINITY
  } = options;
  const result: SyncResult = {
    groupsSeen: 0,
    subscribed: 0,
    callsUsed: 0,
    errors: [],
    vanished: [],
    throttled: false,
    budgetExhausted: false
  };

  // The interval floor. Checked before any API call, so a storm of events costs one
  // cheap D1 read each rather than seven Sonos requests each.
  if (!force) {
    const row = await env.DB.prepare(
      'SELECT last_sync_at FROM households WHERE household_id = ? AND user_id = ?'
    )
      .bind(householdId, userId)
      .first<{ last_sync_at: number | null }>();
    const last = row?.last_sync_at ?? 0;
    if (nowMs - last < MIN_TOPOLOGY_SYNC_INTERVAL_MS) {
      result.throttled = true;
      return result;
    }
  }
  await env.DB.prepare(
    'UPDATE households SET last_sync_at = ? WHERE household_id = ? AND user_id = ?'
  )
    .bind(nowMs, householdId, userId)
    .run();

  // The household-level anchor. Skipped when this sync was itself provoked by a groups
  // event, because subscribing here is what produces the next one.
  if (subscribeHousehold) try {
    await client.subscribeGroups(householdId);
    result.callsUsed += 1;
    result.subscribed += 1;
    await recordSuccess(
      env,
      {
        id: subscriptionId('household', householdId, 'groups'),
        userId,
        householdId,
        scope: 'household',
        targetId: householdId,
        namespace: 'groups'
      },
      nowMs
    );
  } catch (error) {
    result.callsUsed += 1;
    result.errors.push(`groups: ${error instanceof Error ? error.message : String(error)}`);
    // Back this row off. Without it the row stays exactly as due as it was, so the next
    // sweep selects it again fifteen minutes later, and the one after that, spending a
    // request each time on something that is not going to start working on its own.
    await recordFailure(
      env,
      subscriptionId('household', householdId, 'groups'),
      error,
      nowMs
    );
  }

  // A groups event already carries the whole topology, so re-fetching it is a wasted
  // call against a shared quota.
  let groups: readonly { id: string; name?: string }[];
  if (knownGroups) {
    groups = knownGroups;
  } else {
    const status = await client.getGroups(householdId);
    result.callsUsed += 1;
    groups = status.groups ?? [];
  }
  result.groupsSeen = groups.length;

  // Which groups already hold both subscriptions, so an unchanged topology costs zero
  // Sonos requests.
  const existing = new Set<string>();
  if (onlyMissing) {
    const rows = await env.DB.prepare(
      "SELECT target_id, namespace FROM subscriptions WHERE user_id = ? AND scope = 'group'"
    )
      .bind(userId)
      .all<{ target_id: string; namespace: string }>();
    const seen = new Map<string, number>();
    for (const row of rows.results ?? []) {
      seen.set(row.target_id, (seen.get(row.target_id) ?? 0) + 1);
    }
    for (const [id, count] of seen) if (count >= 2) existing.add(id);
  }

  // Forget groups that no longer exist, so the renewal cron stops paying for them.
  const liveIds = groups.map((group) => group.id);
  await pruneVanishedGroups(env, userId, householdId, liveIds);

  for (const group of groups) {
    await env.DB.prepare(
      `INSERT INTO sonos_groups (group_id, household_id, user_id, name, seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         household_id = excluded.household_id,
         user_id      = excluded.user_id,
         name         = excluded.name,
         seen_at      = excluded.seen_at`
    )
      .bind(group.id, householdId, userId, group.name ?? null, nowMs)
      .run();

    if (onlyMissing && existing.has(group.id)) continue;

    if (result.callsUsed >= callBudget) {
      result.budgetExhausted = true;
      break;
    }

    for (const namespace of ['playback', 'playbackMetadata'] as const) {
      try {
        if (namespace === 'playback') await client.subscribePlayback(group.id);
        else await client.subscribePlaybackMetadata(group.id);
        result.callsUsed += 1;
        result.subscribed += 1;
        await recordSuccess(
          env,
          {
            id: subscriptionId('group', group.id, namespace),
            userId,
            householdId,
            scope: 'group',
            targetId: group.id,
            namespace
          },
          nowMs
        );
      } catch (error) {
        result.callsUsed += 1;
        const detail = error instanceof Error ? error.message : String(error);
        // A group that vanished between listing and subscribing is routine, not a
        // failure worth alerting on — but it is still recorded, because silently
        // dropping it leaves a group with no subscription and no trace of why.
        if (error instanceof SonosApiError && error.isGone) {
          result.vanished.push(`${group.id}/${namespace}: ${detail}`);
          continue;
        }
        result.errors.push(`${group.id}/${namespace}: ${detail}`);
        // Same reason as the household anchor above: a row that keeps its old
        // `next_renewal_at` is retried every sweep forever and crowds out rows that
        // would have succeeded.
        await recordFailure(env, subscriptionId('group', group.id, namespace), error, nowMs);
      }
    }
  }

  return result;
}

async function pruneVanishedGroups(
  env: Env,
  userId: string,
  householdId: string,
  liveIds: readonly string[]
): Promise<void> {
  const existing = await env.DB.prepare(
    'SELECT group_id FROM sonos_groups WHERE user_id = ? AND household_id = ?'
  )
    .bind(userId, householdId)
    .all<{ group_id: string }>();

  const live = new Set(liveIds);
  const gone = (existing.results ?? []).map((row) => row.group_id).filter((id) => !live.has(id));
  if (!gone.length) return;

  for (const groupId of gone) {
    // Let the session close out anything it was mid-way through before discarding it —
    // a room that was regrouped may well have earned its scrobble.
    const stub = env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(groupId));
    try {
      await stub.onGroupRemoved(Date.now());
    } catch {
      // A session that cannot be closed must not block pruning.
    }
    await env.DB.prepare('DELETE FROM sonos_groups WHERE group_id = ?').bind(groupId).run();
    await env.DB.prepare('DELETE FROM subscriptions WHERE scope = ? AND target_id = ?')
      .bind('group', groupId)
      .run();
  }
}

export interface RenewalReport {
  considered: number;
  renewed: number;
  failed: number;
  callsUsed: number;
  /** True when the budget ran out before the queue did, so work was left behind. */
  truncated: boolean;
}

/**
 * Renews the subscriptions that are closest to lapsing, within a call budget.
 *
 * Ordering by `next_renewal_at` is what makes this fair: whoever is nearest to lapsing
 * is served first, so a budget that cannot cover everyone still never lets anybody
 * actually expire.
 */
export async function renewDue(
  env: Env,
  nowMs = Date.now(),
  budget = RENEWAL_CALL_BUDGET
): Promise<RenewalReport> {
  const report: RenewalReport = {
    considered: 0,
    renewed: 0,
    failed: 0,
    callsUsed: 0,
    truncated: false
  };

  // Group by user: one client, one token refresh, many renewals.
  const due = await env.DB.prepare(
    `SELECT DISTINCT user_id, household_id
       FROM subscriptions
      WHERE next_renewal_at <= ?
      ORDER BY next_renewal_at ASC
      LIMIT 100`
  )
    .bind(nowMs)
    .all<{ user_id: string; household_id: string }>();

  for (const row of due.results ?? []) {
    if (report.callsUsed >= budget) {
      report.truncated = true;
      break;
    }
    report.considered += 1;
    try {
      const client = await clientForUser(env, row.user_id);
      const result = await syncHousehold(env, row.user_id, row.household_id, client, nowMs, {
        callBudget: budget - report.callsUsed
      });
      report.callsUsed += result.callsUsed;
      report.renewed += result.subscribed;
      if (result.errors.length) report.failed += result.errors.length;
      // One household big enough to spend the whole budget ends the run here rather
      // than after it has already overspent. Its remaining groups keep their renewal
      // times and are first in line next sweep.
      if (result.budgetExhausted) {
        report.truncated = true;
        break;
      }
    } catch (error) {
      report.failed += 1;
      if (error instanceof SonosGrantMissing) {
        // No grant means the user unlinked or revoked. Drop the rows rather than
        // retrying against an account that will never answer again.
        await env.DB.prepare('DELETE FROM subscriptions WHERE user_id = ?')
          .bind(row.user_id)
          .run();
        continue;
      }
      await recordFailure(
        env,
        subscriptionId('household', row.household_id, 'groups'),
        error,
        nowMs
      );
    }
  }

  return report;
}
