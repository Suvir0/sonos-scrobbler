/**
 * One Durable Object per user: their durable scrobble queue.
 *
 * Per user rather than per group, because the queue's job is to hold an earned play
 * until a service accepts it, and that outlives any particular group. It is also where
 * cross-group duplication is caught: if two groups somehow report the same play — a
 * regroup mid-track, a reconciliation racing a live event — the dedupe key collapses
 * them into one scrobble.
 *
 * One queue per target, each with its own storage and its own backoff, so a
 * ListenBrainz outage never holds up Last.fm.
 *
 * ZERO RETENTION: `pending` holds plays only until they are delivered, and the dedupe
 * set holds HMACs rather than titles. After a successful flush this object contains no
 * readable record of what was played.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { hmacHex } from '../lib/crypto.js';
import { decryptSecret } from '../lib/crypto.js';
import { log } from '../lib/log.js';
import { LastfmClient } from '../scrobble/lastfm-client.js';
import { ListenBrainzClient } from '../scrobble/listenbrainz-client.js';
import { findDuplicatePair } from '../scrobble/foreign.js';
import { ScrobbleQueue, scrobbleKey, type QueueStorage } from '../scrobble/queue.js';
import type { NowPlayingTrack, ScrobbleTarget, ScrobbleTrack } from '../scrobble/target.js';

type TargetKind = 'lastfm' | 'listenbrainz';

interface TargetRow {
  kind: TargetKind;
  credential_enc: string;
  username: string | null;
  enabled: number;
  needs_reauth: number;
}

/**
 * At most one duplicate-detection read per hour.
 *
 * A second scrobbler is a standing condition, not news — once it is true it stays true
 * until somebody disconnects something — so this is a diagnosis worth one extra API call
 * an hour and no more.
 *
 * The check reads history rather than watching for a copy of the play just sent, which
 * also means it needs no delay: the duplicate of a track from ten minutes ago is already
 * sitting in the same response. That matters, because the other writer is slow. Measured
 * in production, its copy arrived about five minutes after the track started — long
 * after our own submission, which is why checking *before* submitting can never see it.
 */
const FOREIGN_CHECK_INTERVAL_MS = 60 * 60_000;

/** Enough history to cover several tracks without asking Last.fm for a large page. */
const FOREIGN_CHECK_DEPTH = 50;

/** Retry cadence when a flush asks to be retried. The queue owns the backoff maths. */
const FLUSH_RETRY_FLOOR_MS = 15_000;

export class UserQueue extends DurableObject<Env> {
  /** The tail of the queue-work chain. See `serialize`. */
  private inFlight: Promise<unknown> = Promise.resolve();

  /**
   * Runs one piece of queue work at a time.
   *
   * Everything below rebuilds a `ScrobbleQueue` from storage, mutates it, and writes it
   * back — and does so around awaits that are not storage operations, so the Durable
   * Object's input gate does not hold the next call off. `loadTargets` is a D1 query and
   * `flush` waits on an HTTP request to Last.fm; either is long enough for a second
   * `enqueue` to be delivered and read the same pre-mutation snapshot.
   *
   * That is what turned a play handed over twice into a play *scrobbled* twice. The
   * queue's own dedupe is sound — `add` refuses a key it already holds — but it can only
   * refuse what it can see, and the second caller had loaded its copy of `accepted`
   * before the first caller's write landed. It then submitted a play the first caller
   * was already submitting.
   *
   * Invisible on ListenBrainz, which collapses two identical listens server-side, and
   * plainly visible on Last.fm, which does not. Hence a bug that looked service-specific
   * and was not.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.inFlight.then(work, work);
    // Swallowed on the chain only, so one failed flush does not reject the plays queued
    // behind it. The caller still sees its own rejection through `next`.
    this.inFlight = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Storage for one target's queue, scoped by key so the two targets cannot collide.
   *
   * Deliberately a small JSON blob rather than one row per play: the queue is normally
   * empty or holds a handful of entries, and a single read/write keeps the DO's
   * serialized write path short.
   */
  private storageFor(kind: TargetKind): QueueStorage {
    return {
      read: async () => this.ctx.storage.get<string>(`queue:${kind}`),
      write: async (contents) => {
        await this.ctx.storage.put(`queue:${kind}`, contents);
      }
    };
  }

  /**
   * The dedupe identity of a play, as an HMAC rather than the play itself.
   *
   * `scrobbleKey` returns `artist\0track\0timestamp`, which is a perfectly readable
   * record of somebody's listening. Keying it through HMAC-SHA256 preserves exactly
   * the property the queue needs — same play, same key — while leaving nothing at rest
   * that can be read back or brute-forced from a catalogue.
   */
  private keyFor = async (track: ScrobbleTrack): Promise<string> =>
    hmacHex(this.env.SCROBBLE_KEY_SALT, scrobbleKey(track));

  private async loadTargets(userId: string): Promise<Map<TargetKind, ScrobbleTarget>> {
    const rows = await this.env.DB.prepare(
      'SELECT kind, credential_enc, username, enabled, needs_reauth FROM targets WHERE user_id = ?'
    )
      .bind(userId)
      .all<TargetRow>();

    const targets = new Map<TargetKind, ScrobbleTarget>();
    for (const row of rows.results ?? []) {
      if (!row.enabled) continue;
      let credential: string;
      try {
        credential = await decryptSecret(row.credential_enc, this.env.TOKEN_ENCRYPTION_KEY);
      } catch {
        // An undecryptable credential means the encryption key changed. Skipping keeps
        // the plays queued rather than dropping them against a broken target.
        continue;
      }
      if (row.kind === 'lastfm') {
        targets.set(
          'lastfm',
          new LastfmClient({
            apiKey: this.env.LASTFM_API_KEY,
            apiSecret: this.env.LASTFM_API_SECRET,
            sessionKey: credential,
            // Only used to read the account back when checking for a second scrobbler.
            ...(row.username ? { username: row.username } : {})
          })
        );
      } else if (row.kind === 'listenbrainz') {
        targets.set(
          'listenbrainz',
          new ListenBrainzClient({
            userToken: credential,
            endpoint: this.env.LISTENBRAINZ_API_URL
          })
        );
      }
    }
    return targets;
  }

  private async queueFor(kind: TargetKind, target: ScrobbleTarget): Promise<ScrobbleQueue> {
    const queue = new ScrobbleQueue(target, {
      now: () => Date.now(),
      storage: this.storageFor(kind),
      keyFor: this.keyFor
    });
    await queue.initialize();
    return queue;
  }

  /** Accepts an earned play. Called by GroupSession the moment a threshold is crossed. */
  async enqueue(userId: string, track: ScrobbleTrack): Promise<void> {
    return this.serialize(async () => {
      await this.ctx.storage.put('userId', userId);
      const targets = await this.loadTargets(userId);
      for (const [kind, target] of targets) {
        const queue = await this.queueFor(kind, target);
        await queue.add(track);
      }
      // The unlocked body: this call already holds the lock.
      await this.flushNow();
    });
  }

  /**
   * Reports what is playing right now.
   *
   * Fire and forget by nature: it expires on its own and nothing is lost if it fails,
   * so a failure is swallowed rather than queued. Queuing a now-playing update would
   * mean announcing a track after it finished.
   */
  async announce(userId: string, track: NowPlayingTrack): Promise<void> {
    const targets = await this.loadTargets(userId);
    await Promise.allSettled([...targets.values()].map((target) => target.updateNowPlaying(track)));
  }

  async flush(): Promise<void> {
    return this.serialize(() => this.flushNow());
  }

  private async flushNow(): Promise<void> {
    const userId = await this.ctx.storage.get<string>('userId');
    if (!userId) return;
    const targets = await this.loadTargets(userId);

    let retryAtMs: number | undefined;
    for (const [kind, target] of targets) {
      const queue = await this.queueFor(kind, target);
      const outcome = await queue.flush();
      if (outcome.status === 'retry') {
        // Kept rather than discarded, but without setting `needs_reauth`: a retry is an
        // outage or a rate limit, which resolves itself. The text is what turns "queued:
        // 4" on the status page into something a person can act on.
        log(this.env, 'warn', 'scrobble.flush.retry', { kind, message: outcome.message });
        await this.recordError(userId, kind, outcome.message);
        retryAtMs = retryAtMs === undefined ? outcome.nextAttemptAtMs : Math.min(retryAtMs, outcome.nextAttemptAtMs);
      } else if (outcome.status === 'reauthorize') {
        // The credential is dead. Flag it so the site can prompt, and stop hammering
        // an endpoint that will refuse every request until the user acts.
        //
        // The message is stored alongside the flag because the flag alone is not enough
        // to act on. ListenBrainz returns 401 for an unverified MetaBrainz email while
        // answering `validate-token` with `valid: true` for the same token — so the one
        // remedy the flag implies, reconnecting, provably cannot fix it. Only the
        // service's own words say what will.
        log(this.env, 'warn', 'scrobble.flush.reauthorize', { kind, message: outcome.message });
        await this.env.DB.prepare(
          'UPDATE targets SET needs_reauth = 1, last_error = ?, updated_at = ? WHERE user_id = ? AND kind = ?'
        )
          .bind(truncateError(outcome.message), Date.now(), userId, kind)
          .run();
      } else if (outcome.status === 'sent') {
        // A delivery that lands is the only honest proof the credential works again, and
        // nothing else ever cleared the flag. Without this, fixing the actual problem —
        // verifying the email, waiting out the outage — left the page still reporting a
        // rejected credential until the user happened to re-paste a token that was never
        // the problem.
        await this.clearError(userId, kind);
        // A delivery landed, so the account is live and worth inspecting. Never allowed
        // to affect the flush: this is a diagnostic, and a scrobble must not fail because
        // one failed.
        await this.checkForDuplicates(userId, kind, target).catch(() => undefined);
        // More waiting behind this batch; come straight back for it.
        if (queue.size > 0) retryAtMs = Date.now();
      }
    }

    if (retryAtMs !== undefined) {
      await this.ctx.storage.setAlarm(Math.max(retryAtMs, Date.now() + FLUSH_RETRY_FLOOR_MS));
    }
  }

  /**
   * Looks for duplicate scrobbles on the account, and records it if there are any.
   *
   * Only Last.fm: it is the only target here that keeps two copies of one play. Both
   * ListenBrainz and Last.fm collapse submissions sharing an exact timestamp, but two
   * *observers* of the same music disagree by a second or two, and ListenBrainz dedupes
   * that where Last.fm does not — which is why this reads as a Last.fm fault and is not
   * one.
   *
   * Diagnosis only. Nothing here stops the other writer, and Last.fm offers no way to
   * remove what it has already accepted. What it does is turn "your scrobbler is
   * doubling everything" into a specific, checkable statement on the status page.
   */
  private async checkForDuplicates(
    userId: string,
    kind: TargetKind,
    target: ScrobbleTarget
  ): Promise<void> {
    if (kind !== 'lastfm' || !(target instanceof LastfmClient)) return;

    const now = Date.now();
    const lastChecked = (await this.ctx.storage.get<number>('duplicateCheckedAt')) ?? 0;
    if (now - lastChecked < FOREIGN_CHECK_INTERVAL_MS) return;
    // Stamped before the read, not after, so a slow or failing check cannot turn into a
    // request on every single flush.
    await this.ctx.storage.put('duplicateCheckedAt', now);

    const recent = await target.recentScrobbles(FOREIGN_CHECK_DEPTH);
    const pair = findDuplicatePair(recent);
    if (!pair) {
      // Cleared as deliberately as it is set: whatever was doing this may have been
      // disconnected, and a warning that never goes away is a warning nobody reads.
      await this.env.DB.prepare(
        `UPDATE targets SET foreign_scrobble_at = NULL, updated_at = ?
          WHERE user_id = ? AND kind = ? AND foreign_scrobble_at IS NOT NULL`
      )
        .bind(now, userId, kind)
        .run();
      return;
    }

    // The offset, not the track. How far apart the two copies sat is the diagnostic —
    // it is what distinguishes two observers from one double submission — and it names
    // nothing anybody listened to.
    log(this.env, 'warn', 'scrobble.duplicate-detected', {
      kind,
      offsetSeconds: pair.offsetSeconds
    });
    await this.env.DB.prepare(
      'UPDATE targets SET foreign_scrobble_at = ?, updated_at = ? WHERE user_id = ? AND kind = ?'
    )
      .bind(now, now, userId, kind)
      .run();
  }

  /** Records why a target is not accepting plays, without declaring its credential dead. */
  private async recordError(userId: string, kind: TargetKind, message: string): Promise<void> {
    await this.env.DB.prepare(
      'UPDATE targets SET last_error = ?, updated_at = ? WHERE user_id = ? AND kind = ?'
    )
      .bind(truncateError(message), Date.now(), userId, kind)
      .run();
  }

  /**
   * Clears both the flag and the message once a delivery succeeds.
   *
   * Guarded on there being something to clear, so the overwhelmingly common case — a
   * healthy target flushing a play — costs no write at all.
   */
  private async clearError(userId: string, kind: TargetKind): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE targets SET needs_reauth = 0, last_error = NULL, updated_at = ?
        WHERE user_id = ? AND kind = ? AND (needs_reauth = 1 OR last_error IS NOT NULL)`
    )
      .bind(Date.now(), userId, kind)
      .run();
  }

  override async alarm(): Promise<void> {
    await this.serialize(() => this.flushNow());
  }

  /**
   * Queue depth per target, for the status page. Carries no track data.
   *
   * Serialized like the rest: the dashboard polls this every fifteen seconds, and a read
   * taken mid-flush reports a backlog that includes plays already accepted.
   */
  async depth(): Promise<Record<string, number>> {
    return this.serialize(async () => {
      const userId = await this.ctx.storage.get<string>('userId');
      if (!userId) return {};
      const targets = await this.loadTargets(userId);
      const out: Record<string, number> = {};
      for (const [kind, target] of targets) {
        out[kind] = (await this.queueFor(kind, target)).size;
      }
      return out;
    });
  }

  async reset(): Promise<void> {
    return this.serialize(async () => {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    });
  }
}

/**
 * Bounds a stored error message.
 *
 * These come from another service and are not length-limited by anything we control;
 * ListenBrainz's unverified-email refusal is close to three hundred characters on its
 * own. Long enough to keep a whole explanation and the URL that goes with it, short
 * enough that a service having a bad day cannot grow the row without limit.
 */
function truncateError(message: string): string {
  const trimmed = message.trim();
  return trimmed.length <= 400 ? trimmed : `${trimmed.slice(0, 399)}…`;
}
