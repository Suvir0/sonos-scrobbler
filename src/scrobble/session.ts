/**
 * The play-session clock: how long a track has actually been listened to.
 *
 * This is the part that had to be rewritten rather than ported. The desktop app polls
 * its speakers every few seconds, so it can accrue listening time from wall-clock
 * deltas and clamp any gap over 30s as "the laptop was asleep". The cloud API is the
 * opposite shape — the docs are explicit that "if a track is playing normally on a
 * group, your app will not receive playbackStatus events while the track position
 * progresses". A four-minute track can produce exactly two events. Wall-clock accrual
 * with a 30s clamp would credit 30 seconds of a four-minute song and never scrobble
 * anything.
 *
 * So the clock is *anchored* instead. Every event carries `positionMillis`, so each
 * one re-syncs the session to a real position, and the time between events is credited
 * from how far the track actually advanced. Drift cannot accumulate, and a seek is
 * handled correctly rather than being mistaken for listening.
 *
 * Pure and clock-injected throughout: nothing here calls `Date.now()`, which is what
 * lets a four-minute threshold be tested in a millisecond.
 */

import type { ScrobbleCandidate } from '../sonos/classify.js';
import type { ScrobbleTrack } from './target.js';
import {
  NOW_PLAYING_REFRESH_MS,
  isSameTrack,
  scrobblePointMs,
  toScrobbleTrack,
  type TrackIdentity
} from './rules.js';

/**
 * Slack allowed between how far the track advanced and how much wall time passed.
 *
 * Sonos's clock and ours are not the same clock, and events are queued and delivered
 * over the public internet. Without slack, ordinary jitter would be misread as a
 * forward seek and quietly shave credit off every track.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5_000;

export interface PlaySession {
  track: ScrobbleCandidate;
  /** UTC seconds at which this track started playing — the scrobble's timestamp. */
  startedAtUnix: number;
  /** Listening credited up to the last anchor. */
  listenedMs: number;
  /** Track position at the last anchor. */
  anchorPositionMs: number;
  /** Wall clock at the last anchor. */
  anchorWallMs: number;
  playing: boolean;
  /** Whether this play has already been handed to the queue. */
  submitted: boolean;
  nowPlayingSentAtMs?: number;
}

export function startSession(
  track: ScrobbleCandidate,
  input: { positionMs: number; playing: boolean; nowMs: number }
): PlaySession {
  return {
    track,
    // A track that begins part-way through — we subscribed mid-song, or a seek landed
    // here — started that many milliseconds ago in real time. Getting this wrong
    // misorders somebody's listening history, which is the thing the history is for.
    startedAtUnix: Math.floor((input.nowMs - input.positionMs) / 1000),
    listenedMs: 0,
    anchorPositionMs: input.positionMs,
    anchorWallMs: input.nowMs,
    playing: input.playing,
    submitted: false
  };
}

/**
 * Listening credited so far, including the stretch since the last anchor.
 *
 * The open interval is bounded by wall time because there is no position reading for
 * it yet; `anchor` corrects it the moment one arrives.
 */
export function listenedMsAt(session: PlaySession, nowMs: number): number {
  if (!session.playing) return session.listenedMs;
  return session.listenedMs + Math.max(0, nowMs - session.anchorWallMs);
}

/**
 * Credit the interval since the last anchor, given a fresh position reading.
 *
 * `positionDelta` is how far the track advanced; `wallDelta` is how much time passed.
 * Normal playback makes them equal. The two clamps are where the interesting cases live:
 *
 *  - **Upper bound (`wallDelta`)** — a forward seek advances position without any time
 *    passing. Bounding by wall time means skipping the second half of a song does not
 *    count as having listened to it.
 *  - **Lower bound (zero)** — a backward seek moves position negative. Crediting zero
 *    slightly under-counts a genuine re-listen, which is the direction to err: a
 *    missing scrobble is a nuisance, a fabricated one corrupts a permanent record.
 *
 * Nothing accrues while paused, so a track paused for an hour has not been listened to
 * for an hour.
 */
export function creditFor(
  session: PlaySession,
  input: { positionMs: number; nowMs: number }
): number {
  if (!session.playing) return 0;
  const wallDelta = Math.max(0, input.nowMs - session.anchorWallMs);
  const positionDelta = input.positionMs - session.anchorPositionMs;
  return Math.min(Math.max(positionDelta, 0), wallDelta + CLOCK_SKEW_TOLERANCE_MS);
}

export function anchor(
  session: PlaySession,
  input: { positionMs: number; playing: boolean; nowMs: number }
): PlaySession {
  return {
    ...session,
    listenedMs: session.listenedMs + creditFor(session, input),
    anchorPositionMs: input.positionMs,
    anchorWallMs: input.nowMs,
    playing: input.playing
  };
}

export function hasEarnedScrobble(session: PlaySession, nowMs: number): boolean {
  const point = scrobblePointMs(session.track.durationMs);
  if (point === undefined) return false;
  return listenedMsAt(session, nowMs) >= point;
}

/**
 * When this session will cross its threshold, as a wall-clock instant, or undefined if
 * it cannot (too short, or not currently playing).
 *
 * This is what makes prompt scrobbling possible without polling: the Durable Object
 * sets an alarm for exactly this moment, so a track scrobbles as it crosses the line
 * rather than whenever the next event happens to arrive.
 */
export function scrobbleDueAtMs(session: PlaySession, nowMs: number): number | undefined {
  if (session.submitted || !session.playing) return undefined;
  const point = scrobblePointMs(session.track.durationMs);
  if (point === undefined) return undefined;
  const remaining = point - listenedMsAt(session, nowMs);
  return remaining <= 0 ? nowMs : nowMs + remaining;
}

export function shouldRefreshNowPlaying(session: PlaySession, nowMs: number): boolean {
  if (!session.playing) return false;
  if (session.nowPlayingSentAtMs === undefined) return true;
  return nowMs - session.nowPlayingSentAtMs >= NOW_PLAYING_REFRESH_MS;
}

export function identityOf(track: ScrobbleCandidate): TrackIdentity {
  const identity: TrackIdentity = { artist: track.artist, track: track.track };
  if (track.album) identity.album = track.album;
  if (track.objectId) identity.objectId = track.objectId;
  return identity;
}

export function isSameSessionTrack(session: PlaySession, track: ScrobbleCandidate): boolean {
  return isSameTrack(identityOf(session.track), identityOf(track));
}

export interface FinalizeInput {
  nowMs: number;
  /**
   * The outgoing track's true final position, from `previousPositionMillis` on the
   * `playbackStatus` event that accompanies a track change.
   *
   * When present this wins outright over the derived clock: it is Sonos's own reading
   * of how far the track got, and it is the reason this design does not have to trust
   * an unanchored timer across a gap where no events arrived.
   */
  finalPositionMs?: number;
}

/**
 * Close a session, returning the scrobble it earned, if any.
 *
 * Returns undefined when the play was too short, already submitted, or is a track type
 * that can never be scrobbled.
 */
export function finalize(
  session: PlaySession,
  input: FinalizeInput
): { scrobble?: ScrobbleTrack; session: PlaySession } {
  // Credit the stretch since the last anchor BEFORE closing the session. Closing sets
  // `playing` to false, and `listenedMsAt` deliberately ignores the open interval once
  // that happens — so settling afterwards would silently discard every second played
  // since the last event. With Sonos sending no events during normal playback, that
  // "open interval" is usually the entire track.
  const settled =
    input.finalPositionMs === undefined
      ? { ...session, listenedMs: listenedMsAt(session, input.nowMs), anchorWallMs: input.nowMs }
      : anchor(session, {
          positionMs: input.finalPositionMs,
          playing: session.playing,
          nowMs: input.nowMs
        });

  const closed: PlaySession = { ...settled, playing: false };
  if (session.submitted) return { session: closed };
  if (!hasEarnedScrobble(closed, input.nowMs)) return { session: closed };

  return {
    scrobble: toScrobbleTrack(
      identityOf(closed.track),
      closed.startedAtUnix,
      closed.track.durationMs
    ),
    session: { ...closed, submitted: true }
  };
}
