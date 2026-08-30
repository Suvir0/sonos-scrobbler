/**
 * One Durable Object per Sonos group: the live play session for that group.
 *
 * A DO is the right home for this because the state is small, strongly consistent, and
 * needs a timer. Events for a group arrive concurrently from Sonos's fleet; the DO's
 * single-threaded execution is what stops two events interleaving and corrupting the
 * clock, and its alarm is what lets a track scrobble the moment it crosses its
 * threshold without anybody polling anything.
 *
 * ZERO RETENTION: the track fields below exist only while a play is in flight. Once a
 * play resolves, its metadata is handed to the queue and erased here. Nothing in this
 * object is a record of listening history, and no path writes one to D1.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { clientForUser } from '../sonos/account.js';
import { classify, MAX_SONG_MS, type ScrobbleCandidate } from '../sonos/classify.js';
import type { MetadataStatus, PlaybackStatus } from '../sonos/types.js';
import {
  anchor,
  finalize,
  hasEarnedScrobble,
  isSameSessionTrack,
  identityOf,
  listenedMsAt,
  scrobbleDueAtMs,
  shouldRefreshNowPlaying,
  startSession,
  type PlaySession
} from '../scrobble/session.js';
import { toScrobbleTrack } from '../scrobble/rules.js';
import type { ScrobbleTrack } from '../scrobble/target.js';

/**
 * How long to wait for the `playbackStatus` that accompanies a track change.
 *
 * The two events fire together and may arrive in either order. Finalizing the outgoing
 * track the instant `metadataStatus` lands would throw away `previousPositionMillis` —
 * Sonos's own reading of how far that track got — whenever it happens to arrive second.
 * Three seconds is far below the shortest interesting gap between real tracks and far
 * above the spread between two events sent at the same moment.
 */
const TRACK_CHANGE_DEBOUNCE_MS = 3_000;

/**
 * Extra time past a track's expected end before assuming its end event was dropped.
 *
 * Sonos discards an event after three failed delivery attempts, so a missed track
 * change is silent. This is the backstop.
 */
const BACKSTOP_SLACK_MS = 30_000;

/** How stale a `previousPositionMillis` reading may be before it is ignored. */
const HINT_FRESHNESS_MS = 10_000;

/**
 * How many times one session may reconcile before giving up.
 *
 * Reconciling re-anchors the clock, which pushes the backstop forward, so a group that
 * reports the same state indefinitely would otherwise reconcile once per track length
 * forever. Three attempts is enough to ride out a burst of dropped events and few
 * enough to bound the cost against a shared quota.
 */
const MAX_RECONCILE_ATTEMPTS = 3;

interface PendingTrack {
  track: ScrobbleCandidate;
  atMs: number;
}

interface FinalPositionHint {
  positionMs: number;
  atMs: number;
}

export interface GroupSessionInit {
  userId: string;
  householdId: string;
  groupId: string;
  allowRadio: boolean;
  allowHandoff: boolean;
  /**
   * Whether every room in this group is switched on for scrobbling.
   *
   * Resolved per event by the webhook rather than stored here, because the answer
   * changes when somebody regroups rooms as well as when they change a setting.
   * Optional so that a config written before this existed reads as permitted: the
   * absence of a preference has never meant "off".
   */
  scrobbleEnabled?: boolean;
  /** Whether to refuse a track claiming to be longer than a song. */
  skipLongTracks?: boolean;
}

/** What the DO reports back after handling an event, for logging and diagnostics. */
export interface EventOutcome {
  scrobbled?: ScrobbleTrack;
  nowPlaying?: { artist: string; track: string; album?: string };
  declined?: string;
}

export class GroupSession extends DurableObject<Env> {
  private async config(): Promise<GroupSessionInit | undefined> {
    return this.ctx.storage.get<GroupSessionInit>('config');
  }

  private async session(): Promise<PlaySession | undefined> {
    return this.ctx.storage.get<PlaySession>('session');
  }

  async initialize(init: GroupSessionInit): Promise<void> {
    await this.ctx.storage.put('config', init);
  }

  /** Wipes everything. Used on unlink, and when a group disappears. */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Drops whatever this group had in flight, for a room that is switched off.
   *
   * Not `reset()`: the config is what the next event needs in order to know the room is
   * off, and deleting it would make the following event start a session before the
   * webhook re-initialized. Returns the outcome the caller should report.
   *
   * Nothing here finalizes the session. A track that was mid-play when its room was
   * switched off has not earned anything, because the answer to "may this room
   * scrobble" is no as of now, not as of the next track.
   */
  private async standDown(): Promise<EventOutcome> {
    const [session, pending] = await Promise.all([
      this.session(),
      this.ctx.storage.get<PendingTrack>('pending')
    ]);
    if (session || pending) {
      await this.ctx.storage.delete(['session', 'pending', 'hint', 'reconcileAttempts']);
      await this.ctx.storage.deleteAlarm();
    }
    return { declined: 'room-off' };
  }

  /* ------------------------------------------------------------ event entry */

  async onPlaybackStatus(status: PlaybackStatus, nowMs: number): Promise<EventOutcome> {
    const gate = await this.config();
    if (gate?.scrobbleEnabled === false) return await this.standDown();

    const positionMs = status.positionMillis ?? 0;
    const playing = status.playbackState === 'PLAYBACK_STATE_PLAYING';

    // Record the outgoing track's true final position before anything else consumes it.
    if (typeof status.previousPositionMillis === 'number') {
      const hint: FinalPositionHint = { positionMs: status.previousPositionMillis, atMs: nowMs };
      await this.ctx.storage.put('hint', hint);
    }

    // A track change is already in flight and this is the event it was waiting for.
    const pending = await this.ctx.storage.get<PendingTrack>('pending');
    if (pending) {
      const outcome = await this.resolvePending(pending, { positionMs, playing, nowMs });
      await this.rescheduleAlarm(nowMs);
      return outcome;
    }

    const current = await this.session();
    if (!current) return {};

    // IDLE and PAUSED both stop the clock, but IDLE means the source is gone (radio
    // stopped, queue ended) so the play is over rather than suspended.
    const idle = status.playbackState === 'PLAYBACK_STATE_IDLE';
    if (idle) {
      // Deliberately not passing `positionMs` as the final position. An IDLE event is
      // the queue ending, and Sonos reports position 0 on it as often as it reports
      // where the track actually stopped — forcing that in clamps the last stretch of
      // credit to nothing and drops a scrobble that had already been earned. Leaving it
      // out lets `finalizeCurrent` use its documented order instead: the
      // `previousPositionMillis` hint this same event may have just stored, then the
      // derived clock.
      const outcome = await this.finalizeCurrent(current, nowMs);
      await this.ctx.storage.delete('session');
      await this.rescheduleAlarm(nowMs);
      return outcome;
    }

    await this.ctx.storage.put('session', anchor(current, { positionMs, playing, nowMs }));
    await this.rescheduleAlarm(nowMs);
    return {};
  }

  async onMetadataStatus(status: MetadataStatus, nowMs: number): Promise<EventOutcome> {
    const config = await this.config();
    if (config?.scrobbleEnabled === false) return await this.standDown();

    const result = classify(status, {
      allowRadio: config?.allowRadio ?? true,
      allowHandoff: config?.allowHandoff ?? false,
      ...(config?.skipLongTracks === false ? {} : { maxTrackMs: MAX_SONG_MS })
    });

    const current = await this.session();

    if (!result.scrobbleable) {
      // TV audio, a podcast, an unparseable station. Close whatever was playing —
      // it may well have earned its scrobble before the source changed.
      const outcome = current ? await this.finalizeCurrent(current, nowMs) : {};
      await this.ctx.storage.delete('session');
      await this.ctx.storage.delete('pending');
      await this.rescheduleAlarm(nowMs);
      return { ...outcome, declined: result.reason };
    }

    // A metadata refresh for the track already playing — artwork arriving late, an
    // album name filling in. Update the details without disturbing the clock.
    if (current && isSameSessionTrack(current, result.candidate)) {
      await this.ctx.storage.put('session', { ...current, track: result.candidate });
      await this.rescheduleAlarm(nowMs);
      return {};
    }

    // A genuine track change. Hold it briefly in case the accompanying playbackStatus
    // is still in flight with the outgoing track's final position.
    const pending: PendingTrack = { track: result.candidate, atMs: nowMs };
    await this.ctx.storage.put('pending', pending);
    await this.ctx.storage.setAlarm(nowMs + TRACK_CHANGE_DEBOUNCE_MS);
    return {};
  }

  /** A group vanished from the household. Close out whatever it was playing. */
  async onGroupRemoved(nowMs: number): Promise<EventOutcome> {
    const current = await this.session();
    const outcome = current ? await this.finalizeCurrent(current, nowMs) : {};
    await this.reset();
    return outcome;
  }

  /* -------------------------------------------------------------- internals */

  private async resolvePending(
    pending: PendingTrack,
    input: { positionMs: number; playing: boolean; nowMs: number }
  ): Promise<EventOutcome> {
    const current = await this.session();
    const outcome = current ? await this.finalizeCurrent(current, input.nowMs) : {};

    const started = startSession(pending.track, input);
    await this.ctx.storage.put('session', started);
    await this.ctx.storage.delete('pending');
    await this.ctx.storage.delete('hint');
    // A new track gets a fresh reconcile allowance; the cap bounds one stuck session,
    // not the group for the rest of the day.
    await this.ctx.storage.delete('reconcileAttempts');

    const announced = shouldRefreshNowPlaying(started, input.nowMs);
    if (announced) {
      await this.ctx.storage.put('session', {
        ...started,
        nowPlayingSentAtMs: input.nowMs
      });
    }

    return {
      ...outcome,
      ...(announced ? { nowPlaying: nowPlayingOf(started.track) } : {})
    };
  }

  /**
   * Closes a session and hands any earned scrobble to the user's queue.
   *
   * `finalPositionMs` wins over the stored hint, which wins over the derived clock.
   */
  private async finalizeCurrent(
    session: PlaySession,
    nowMs: number,
    finalPositionMs?: number
  ): Promise<EventOutcome> {
    const resolved = finalPositionMs ?? (await this.freshHint(nowMs));
    const { scrobble } = finalize(session, {
      nowMs,
      ...(resolved === undefined ? {} : { finalPositionMs: resolved })
    });
    await this.ctx.storage.delete('hint');
    if (!scrobble) return {};
    await this.enqueue(scrobble);
    return { scrobbled: scrobble };
  }

  private async freshHint(nowMs: number): Promise<number | undefined> {
    const hint = await this.ctx.storage.get<FinalPositionHint>('hint');
    if (!hint) return undefined;
    // A stale reading belongs to an older track change and would credit this play with
    // somebody else's position.
    if (nowMs - hint.atMs > HINT_FRESHNESS_MS) return undefined;
    return hint.positionMs;
  }

  private async enqueue(scrobble: ScrobbleTrack): Promise<void> {
    const config = await this.config();
    if (!config) return;
    const queue = this.env.USER_QUEUES.get(this.env.USER_QUEUES.idFromName(config.userId));
    // The queue is durable and dedupes, so a retry that double-delivers is harmless.
    await queue.enqueue(config.userId, scrobble);
  }

  /* ----------------------------------------------------------------- alarms */

  /**
   * Sets the alarm to the earliest thing that needs to happen.
   *
   * Three candidates compete: resolving a debounced track change, crossing the
   * scrobble threshold, and the backstop for an end-of-track event that never arrived.
   * A DO has one alarm, so it is always set to whichever comes first.
   */
  private async rescheduleAlarm(nowMs: number): Promise<void> {
    const candidates: number[] = [];

    const pending = await this.ctx.storage.get<PendingTrack>('pending');
    if (pending) candidates.push(pending.atMs + TRACK_CHANGE_DEBOUNCE_MS);

    const session = await this.session();
    if (session) {
      const due = scrobbleDueAtMs(session, nowMs);
      if (due !== undefined) candidates.push(due);

      // Backstop: when this track should have finished. Only meaningful for a source
      // that reports a duration — radio has no end to predict.
      if (session.playing && session.track.durationMs !== undefined) {
        const remaining = session.track.durationMs - session.anchorPositionMs;
        // From the anchor, not from `nowMs`, so this is the same instant `expectedEndMs`
        // compares against when the alarm fires. They diverge on a metadata-only refresh,
        // which reschedules without moving the anchor: measured from `nowMs` the alarm
        // would land after the deadline it is meant to detect, delaying recovery of a
        // lost end-of-track event by however long the refresh came after the anchor.
        candidates.push(session.anchorWallMs + Math.max(0, remaining) + BACKSTOP_SLACK_MS);
      }
    }

    if (!candidates.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(nowMs + 1_000, Math.min(...candidates)));
  }

  /** When this track should have finished, or undefined if it has no known length. */
  private expectedEndMs(session: PlaySession, nowMs: number): number | undefined {
    if (session.track.durationMs === undefined) return undefined;
    if (!session.playing) return undefined;
    const remaining = session.track.durationMs - session.anchorPositionMs;
    return session.anchorWallMs + Math.max(0, remaining) + BACKSTOP_SLACK_MS;
  }

  override async alarm(): Promise<void> {
    await this.tick(Date.now());
  }

  /**
   * The alarm body, with the clock passed in.
   *
   * Split out from `alarm()` so a test can drive it on a virtual clock. Without this,
   * anything involving a four-minute threshold or a track-length backstop can only be
   * tested by waiting four minutes, which means in practice it is never tested — and
   * the two worst bugs in this file so far both lived on exactly these paths.
   */
  async tick(nowMs: number): Promise<EventOutcome> {
    // 1. A debounced track change whose playbackStatus never arrived.
    const pending = await this.ctx.storage.get<PendingTrack>('pending');
    if (pending) {
      let outcome: EventOutcome = {};
      if (nowMs >= pending.atMs + TRACK_CHANGE_DEBOUNCE_MS) {
        // The track started when its metadata arrived, not when this alarm fired.
        // Passing the debounce delay as the assumed position makes `startedAtUnix`
        // land on the real start instead of three seconds late — which is visible in
        // a listening history as every track being stamped slightly after the truth.
        outcome = await this.resolvePending(pending, {
          positionMs: nowMs - pending.atMs,
          playing: true,
          nowMs
        });
      }
      await this.rescheduleAlarm(nowMs);
      return outcome;
    }

    const session = await this.session();
    if (!session) {
      await this.ctx.storage.deleteAlarm();
      return {};
    }

    // 2. The threshold has been crossed while the track is still playing. Scrobble now
    //    rather than waiting for whatever event happens to come next.
    //
    //    Deliberately NOT via finalize(): that closes the session, and a closed session
    //    stops counting the open interval, so it would report nothing earned, leave
    //    `submitted` false, and be asked again one second later — forever.
    if (!session.submitted && hasEarnedScrobble(session, nowMs)) {
      await this.ctx.storage.put('session', {
        ...session,
        listenedMs: listenedMsAt(session, nowMs),
        anchorWallMs: nowMs,
        submitted: true
      });
      const scrobble = toScrobbleTrack(
        identityOf(session.track),
        session.startedAtUnix,
        session.track.durationMs
      );
      await this.enqueue(scrobble);
      await this.rescheduleAlarm(nowMs);
      return { scrobbled: scrobble };
    }

    // 3. The backstop. The track should have ended and no event said so, which means
    //    Sonos gave up delivering it — it retries three times over three seconds and
    //    then discards the event permanently, with no replay and no dead-letter queue.
    //    Only acts once the track really is overdue: an alarm that fires for any other
    //    reason must not discard a live session.
    const expectedEnd = this.expectedEndMs(session, nowMs);
    if (expectedEnd !== undefined && nowMs >= expectedEnd) {
      const reconciled = await this.reconcile(nowMs);
      if (reconciled) return reconciled;

      // Could not ask Sonos — budget exhausted, grant revoked, group gone. Close the
      // session rather than leave a clock running that would invent listening time.
      const outcome = await this.finalizeCurrent(session, nowMs);
      await this.ctx.storage.delete('session');
      await this.ctx.storage.deleteAlarm();
      return outcome;
    }

    await this.rescheduleAlarm(nowMs);
    return {};
  }

  /**
   * Asks Sonos what this group is actually doing, and feeds the answer back through
   * the ordinary event path.
   *
   * Deliberately not a second decision-making code path: the observed state is
   * replayed through `onMetadataStatus` and `onPlaybackStatus` exactly as a live event
   * would be, so reconciliation cannot drift from the behaviour it is meant to
   * recover. Metadata first, then playback, which is the order that lets a lost track
   * change resolve using `previousPositionMillis`.
   *
   * Returns undefined when the state could not be fetched, leaving the caller to close
   * the session. Costs two requests, and only when an event looks genuinely lost.
   */
  private async reconcile(nowMs: number): Promise<EventOutcome | undefined> {
    const config = await this.config();
    if (!config) return undefined;

    const attempts = (await this.ctx.storage.get<number>('reconcileAttempts')) ?? 0;
    if (attempts >= MAX_RECONCILE_ATTEMPTS) return undefined;

    try {
      const client = await clientForUser(this.env, config.userId);
      const [metadata, playback] = await Promise.all([
        client.getMetadataStatus(config.groupId),
        client.getPlaybackStatus(config.groupId)
      ]);
      await this.ctx.storage.put('reconcileAttempts', attempts + 1);

      const fromMetadata = await this.onMetadataStatus(metadata, nowMs);
      const fromPlayback = await this.onPlaybackStatus(playback, nowMs);
      return {
        ...fromMetadata,
        ...fromPlayback,
        ...(fromMetadata.scrobbled ? { scrobbled: fromMetadata.scrobbled } : {})
      };
    } catch {
      return undefined;
    }
  }

  /** The scheduled alarm time, for tests that advance a virtual clock to it. */
  async alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Read-only view for the "what is playing now" panel. Never persisted anywhere. */
  async snapshot(): Promise<{ track?: ScrobbleCandidate; playing: boolean } | undefined> {
    const session = await this.session();
    if (!session) return undefined;
    return { track: session.track, playing: session.playing };
  }
}

function nowPlayingOf(track: ScrobbleCandidate): { artist: string; track: string; album?: string } {
  const out: { artist: string; track: string; album?: string } = {
    artist: track.artist,
    track: track.track
  };
  if (track.album) out.album = track.album;
  return out;
}
