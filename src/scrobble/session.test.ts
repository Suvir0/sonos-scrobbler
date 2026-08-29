import { describe, expect, it } from 'vitest';
import type { ScrobbleCandidate } from '../sonos/classify.js';
import {
  anchor,
  finalize,
  hasEarnedScrobble,
  listenedMsAt,
  scrobbleDueAtMs,
  shouldRefreshNowPlaying,
  startSession
} from './session.js';

const T0 = 1_700_000_000_000;

/**
 * A 3-minute track: scrobble point is 90s (half its length).
 *
 * `null` means the source reported no duration, which is radio. Note it is not
 * `undefined`: that would collide with the default parameter and silently give every
 * "no duration" test a 3-minute track instead.
 */
function song(durationMs: number | null = 180_000): ScrobbleCandidate {
  const track: ScrobbleCandidate = {
    artist: 'Anderson .Paak',
    track: 'Come Down',
    album: 'Malibu',
    objectId: 'song:1',
    isRadio: durationMs === null
  };
  if (durationMs !== null) track.durationMs = durationMs;
  return track;
}

describe('startSession', () => {
  it('timestamps a track by when it started, not when we noticed it', () => {
    // Subscribed 40s into the song: it started 40s ago in real time.
    const session = startSession(song(), { positionMs: 40_000, playing: true, nowMs: T0 });
    expect(session.startedAtUnix).toBe(Math.floor((T0 - 40_000) / 1000));
  });

  it('starts a track at position zero at the current instant', () => {
    const session = startSession(song(), { positionMs: 0, playing: true, nowMs: T0 });
    expect(session.startedAtUnix).toBe(Math.floor(T0 / 1000));
  });
});

describe('the anchored clock', () => {
  it('credits ordinary playback across a long gap between events', () => {
    // The regression that motivates the whole rewrite. Sonos sends no events while a
    // track plays normally, so this 100s gap is the common case, not an outlier. The
    // desktop app's 30s suspension clamp would have credited 30s here.
    const session = startSession(song(), { positionMs: 0, playing: true, nowMs: T0 });
    const later = anchor(session, { positionMs: 100_000, playing: true, nowMs: T0 + 100_000 });
    expect(later.listenedMs).toBe(100_000);
  });

  it('does not credit a forward seek as listening', () => {
    // 10s of real time passed but the track jumped 120s. Only the 10s was heard.
    const session = startSession(song(), { positionMs: 0, playing: true, nowMs: T0 });
    const seeked = anchor(session, { positionMs: 120_000, playing: true, nowMs: T0 + 10_000 });
    expect(seeked.listenedMs).toBe(10_000 + 5_000); // wall delta plus skew tolerance
    expect(seeked.listenedMs).toBeLessThan(120_000);
  });

  it('does not decrement on a backward seek', () => {
    const session = startSession(song(), { positionMs: 90_000, playing: true, nowMs: T0 });
    const seeked = anchor(session, { positionMs: 10_000, playing: true, nowMs: T0 + 2_000 });
    expect(seeked.listenedMs).toBe(0);
    expect(seeked.listenedMs).toBeGreaterThanOrEqual(0);
  });

  it('accrues nothing while paused', () => {
    const started = startSession(song(), { positionMs: 0, playing: true, nowMs: T0 });
    // Play 30s, then pause.
    const paused = anchor(started, { positionMs: 30_000, playing: false, nowMs: T0 + 30_000 });
    expect(paused.listenedMs).toBe(30_000);

    // An hour goes by paused. A track paused for an hour has not been listened to.
    const resumed = anchor(paused, {
      positionMs: 30_000,
      playing: true,
      nowMs: T0 + 30_000 + 3_600_000
    });
    expect(resumed.listenedMs).toBe(30_000);
    expect(listenedMsAt(resumed, T0 + 30_000 + 3_600_000)).toBe(30_000);
  });

  it('tolerates modest clock skew without shaving credit', () => {
    // Sonos reports the track 2s further along than our clock says it should be.
    const session = startSession(song(), { positionMs: 0, playing: true, nowMs: T0 });
    const later = anchor(session, { positionMs: 62_000, playing: true, nowMs: T0 + 60_000 });
    expect(later.listenedMs).toBe(62_000);
  });

  it('projects the open interval since the last anchor while playing', () => {
    const session = startSession(song(), { positionMs: 0, playing: true, nowMs: T0 });
    expect(listenedMsAt(session, T0 + 45_000)).toBe(45_000);
  });

  it('does not project while paused', () => {
    const session = startSession(song(), { positionMs: 0, playing: false, nowMs: T0 });
    expect(listenedMsAt(session, T0 + 45_000)).toBe(0);
  });
});

describe('thresholds', () => {
  it('earns a scrobble at half a track s length', () => {
    const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
    expect(hasEarnedScrobble(session, T0 + 89_000)).toBe(false);
    expect(hasEarnedScrobble(session, T0 + 90_000)).toBe(true);
  });

  it('caps the requirement at four minutes for a long track', () => {
    // A 20-minute track must not require 10 minutes.
    const session = startSession(song(1_200_000), { positionMs: 0, playing: true, nowMs: T0 });
    expect(hasEarnedScrobble(session, T0 + 239_000)).toBe(false);
    expect(hasEarnedScrobble(session, T0 + 240_000)).toBe(true);
  });

  it('never scrobbles a track under thirty seconds', () => {
    const session = startSession(song(20_000), { positionMs: 0, playing: true, nowMs: T0 });
    expect(hasEarnedScrobble(session, T0 + 600_000)).toBe(false);
    expect(scrobbleDueAtMs(session, T0)).toBeUndefined();
  });

  it('requires four continuous minutes when the duration is unknown', () => {
    // Radio: no usable song duration, so the half-way rule cannot apply.
    const session = startSession(song(null), { positionMs: 0, playing: true, nowMs: T0 });
    expect(hasEarnedScrobble(session, T0 + 239_000)).toBe(false);
    expect(hasEarnedScrobble(session, T0 + 240_000)).toBe(true);
  });

  it('predicts when the threshold will be crossed so an alarm can be set', () => {
    const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
    expect(scrobbleDueAtMs(session, T0)).toBe(T0 + 90_000);
  });

  it('predicts a due time in the past as now', () => {
    const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
    expect(scrobbleDueAtMs(session, T0 + 120_000)).toBe(T0 + 120_000);
  });

  it('has no due time while paused', () => {
    const session = startSession(song(), { positionMs: 0, playing: false, nowMs: T0 });
    expect(scrobbleDueAtMs(session, T0)).toBeUndefined();
  });
});

describe('finalize', () => {
  it('scrobbles a track played past its threshold, timestamped at its start', () => {
    const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
    const played = anchor(session, { positionMs: 180_000, playing: true, nowMs: T0 + 180_000 });
    const { scrobble } = finalize(played, { nowMs: T0 + 180_000 });
    expect(scrobble).toEqual({
      artist: 'Anderson .Paak',
      track: 'Come Down',
      album: 'Malibu',
      timestamp: Math.floor(T0 / 1000),
      durationSeconds: 180
    });
  });

  it('credits the open interval when closing with no final position', () => {
    // The ordinary case, and the one that broke in production. Sonos sends no events
    // while a track plays normally, so a full song is often exactly two events: one at
    // the start and one at the end. If closing the session discards the stretch since
    // the last anchor, the entire track counts as zero and nothing ever scrobbles.
    const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
    const { scrobble, session: closed } = finalize(session, { nowMs: T0 + 175_000 });
    expect(closed.listenedMs).toBe(175_000);
    expect(scrobble).toBeDefined();
    expect(scrobble?.timestamp).toBe(Math.floor(T0 / 1000));
  });

  it('agrees with hasEarnedScrobble about whether a play qualified', () => {
    // These two disagreed: `hasEarnedScrobble` counted the open interval while
    // `finalize` closed the session first and did not. The alarm asked one, acted on
    // the other, and rescheduled itself once a second indefinitely.
    for (const elapsed of [10_000, 89_000, 90_000, 175_000]) {
      const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
      const earned = hasEarnedScrobble(session, T0 + elapsed);
      const { scrobble } = finalize(session, { nowMs: T0 + elapsed });
      expect(Boolean(scrobble)).toBe(earned);
    }
  });

  it('does not scrobble a track skipped early', () => {
    const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
    const { scrobble } = finalize(session, { nowMs: T0 + 36_000, finalPositionMs: 36_000 });
    expect(scrobble).toBeUndefined();
  });

  it('trusts previousPositionMillis over the derived clock', () => {
    // The scenario the whole design turns on: the Worker was unreachable for the
    // middle of the track, so no anchor arrived and the derived clock is far behind.
    // Sonos's own reading of the final position rescues the scrobble.
    const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
    const stale = { ...session, anchorWallMs: T0, playing: true };
    const { scrobble } = finalize(stale, { nowMs: T0 + 180_000, finalPositionMs: 178_000 });
    expect(scrobble).toBeDefined();
    expect(scrobble?.timestamp).toBe(Math.floor(T0 / 1000));
  });

  it('does not let previousPositionMillis manufacture a scrobble from a skip', () => {
    // A forward seek to the end then an immediate skip: position says 178s, but only
    // 3s of wall time passed, so it was not listened to.
    const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
    const { scrobble } = finalize(session, { nowMs: T0 + 3_000, finalPositionMs: 178_000 });
    expect(scrobble).toBeUndefined();
  });

  it('does not scrobble the same session twice', () => {
    const session = startSession(song(180_000), { positionMs: 0, playing: true, nowMs: T0 });
    const played = anchor(session, { positionMs: 180_000, playing: true, nowMs: T0 + 180_000 });
    const first = finalize(played, { nowMs: T0 + 180_000 });
    expect(first.scrobble).toBeDefined();
    const second = finalize(first.session, { nowMs: T0 + 181_000 });
    expect(second.scrobble).toBeUndefined();
  });

  it('omits duration for a track that has none', () => {
    const session = startSession(song(null), { positionMs: 0, playing: true, nowMs: T0 });
    const played = anchor(session, { positionMs: 240_000, playing: true, nowMs: T0 + 240_000 });
    const { scrobble } = finalize(played, { nowMs: T0 + 240_000 });
    expect(scrobble).toBeDefined();
    expect(scrobble).not.toHaveProperty('durationSeconds');
  });

  it('closes the session so nothing accrues after it ends', () => {
    const session = startSession(song(), { positionMs: 0, playing: true, nowMs: T0 });
    const { session: closed } = finalize(session, { nowMs: T0 + 10_000 });
    expect(closed.playing).toBe(false);
    expect(listenedMsAt(closed, T0 + 3_600_000)).toBe(closed.listenedMs);
  });
});

describe('now playing', () => {
  it('announces immediately on a new playing session', () => {
    const session = startSession(song(), { positionMs: 0, playing: true, nowMs: T0 });
    expect(shouldRefreshNowPlaying(session, T0)).toBe(true);
  });

  it('does not announce a paused session', () => {
    const session = startSession(song(), { positionMs: 0, playing: false, nowMs: T0 });
    expect(shouldRefreshNowPlaying(session, T0)).toBe(false);
  });

  it('refreshes only after the expiry window', () => {
    const session = {
      ...startSession(song(), { positionMs: 0, playing: true, nowMs: T0 }),
      nowPlayingSentAtMs: T0
    };
    expect(shouldRefreshNowPlaying(session, T0 + 119_000)).toBe(false);
    expect(shouldRefreshNowPlaying(session, T0 + 120_000)).toBe(true);
  });
});
