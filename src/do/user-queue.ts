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
import { ScrobbleQueue, scrobbleKey, type QueueStorage } from '../scrobble/queue.js';
import type { NowPlayingTrack, ScrobbleTarget, ScrobbleTrack } from '../scrobble/target.js';

type TargetKind = 'lastfm' | 'listenbrainz';

interface TargetRow {
  kind: TargetKind;
  credential_enc: string;
  enabled: number;
  needs_reauth: number;
}

/** Retry cadence when a flush asks to be retried. The queue owns the backoff maths. */
const FLUSH_RETRY_FLOOR_MS = 15_000;

export class UserQueue extends DurableObject<Env> {
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
      'SELECT kind, credential_enc, enabled, needs_reauth FROM targets WHERE user_id = ?'
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
            sessionKey: credential
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
    await this.ctx.storage.put('userId', userId);
    const targets = await this.loadTargets(userId);
    for (const [kind, target] of targets) {
      const queue = await this.queueFor(kind, target);
      await queue.add(track);
    }
    await this.flush();
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
        // More waiting behind this batch; come straight back for it.
        if (queue.size > 0) retryAtMs = Date.now();
      }
    }

    if (retryAtMs !== undefined) {
      await this.ctx.storage.setAlarm(Math.max(retryAtMs, Date.now() + FLUSH_RETRY_FLOOR_MS));
    }
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
    await this.flush();
  }

  /** Queue depth per target, for the status page. Carries no track data. */
  async depth(): Promise<Record<string, number>> {
    const userId = await this.ctx.storage.get<string>('userId');
    if (!userId) return {};
    const targets = await this.loadTargets(userId);
    const out: Record<string, number> = {};
    for (const [kind, target] of targets) {
      out[kind] = (await this.queueFor(kind, target)).size;
    }
    return out;
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
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
