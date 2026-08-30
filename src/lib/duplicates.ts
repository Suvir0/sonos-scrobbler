/**
 * Stops one person's plays being scrobbled twice.
 *
 * Sonos is the only identity this service has, and it names speakers rather than
 * people. So a person who comes back without a session cookie — cleared it, switched
 * browser, or simply let the 30-day session lapse — is handed a brand new account, which
 * then links the same household, the same groups and the same subscriptions as the old
 * one. Since `dispatch` delivers each event to *every* subscriber of a group, both
 * accounts run their own play clock and both submit to the same Last.fm account. The
 * per-user dedupe in `ScrobbleQueue` cannot see across accounts, and Last.fm only
 * collapses submissions sharing an exact timestamp, so the two clocks drifting a second
 * apart is enough for both to land. Every song, twice, forever.
 *
 * Nothing about the *accounts* is wrong: two people in one household legitimately share
 * speakers, and migration 0006 exists to let them. What is never legitimate is two
 * accounts on the same speakers submitting to the same scrobbling account — a couple
 * have two Last.fm accounts, and one person with a duplicate has one. That is the whole
 * test, and it is exact: it fires when the plays would double and stays silent when they
 * would not.
 *
 * Scoped to a shared household deliberately. Somebody with two separate Sonos homes
 * pointing both at one Last.fm is doing something sensible — different speakers, no
 * overlapping plays — and must not be caught by this.
 *
 * The newest link wins, and the older target is disabled rather than deleted. Disabling
 * is reversible, keeps the queued plays, and is symmetric: signing into the older
 * account and reconnecting there flips the decision back, because that link runs this
 * same check from the other side. It also grants nothing — the losing account keeps its
 * Sonos grant, its sign-in link and its own delete button. All that changes is which
 * account is allowed to write to a scrobbling account whose owner just proved, by
 * completing its sign-in flow, that it is theirs.
 */

import type { Env } from '../env.js';
import { log } from './log.js';

/** Set on the target that stood down, so the older account can say why it went quiet. */
export function supersededMessage(kind: string, username: string | null): string {
  const service = kind === 'lastfm' ? 'Last.fm' : 'ListenBrainz';
  const who = username ? `${service} account ${username}` : `${service} account`;
  return (
    `Scrobbling to this ${who} moved to another account connected to the same speakers. ` +
    'Both were submitting the same plays, so every song was being recorded twice. ' +
    'Reconnect here to move it back.'
  );
}

/**
 * Disables any target on another account that would double this user's scrobbles.
 *
 * Returns the kinds it stood down, which is what the caller logs. Safe to call more than
 * once and from either side of the race between linking Sonos and linking a service:
 * the household rows and the target row have to both exist for it to match anything, and
 * it is a no-op until they do.
 */
export async function standDownDuplicateTargets(env: Env, userId: string): Promise<string[]> {
  // Another account that shares a household with this one AND submits to the same
  // service account. Both halves are required: the household alone is a couple, and the
  // username alone is two homes.
  const clashes = await env.DB.prepare(
    `SELECT DISTINCT other.user_id AS user_id, other.kind AS kind, other.username AS username
       FROM targets AS other
       JOIN targets AS mine
         ON mine.kind = other.kind
        AND mine.username = other.username
        AND mine.user_id = ?
        AND mine.enabled = 1
       JOIN households AS theirs ON theirs.user_id = other.user_id
       JOIN households AS ours
         ON ours.household_id = theirs.household_id
        AND ours.user_id = mine.user_id
      WHERE other.user_id != mine.user_id
        AND other.enabled = 1
        AND other.username IS NOT NULL`
  )
    .bind(userId)
    .all<{ user_id: string; kind: string; username: string | null }>();

  const rows = clashes.results ?? [];
  const stoodDown: string[] = [];
  const now = Date.now();

  for (const row of rows) {
    await env.DB.prepare(
      'UPDATE targets SET enabled = 0, last_error = ?, updated_at = ? WHERE user_id = ? AND kind = ?'
    )
      .bind(supersededMessage(row.kind, row.username), now, row.user_id, row.kind)
      .run();
    stoodDown.push(row.kind);
    // The username is the user's own handle on another service, not content data, but
    // it is still theirs — the log records that a duplicate was resolved and for which
    // service, not who. `redact` would strip a `username` field here in any case.
    log(env, 'info', 'targets.duplicate.stood-down', { kind: row.kind });
  }

  return stoodDown;
}
