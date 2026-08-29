import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../testing/schema.js';
import { sessionOf } from '../testing/replay.js';
import {
  idle,
  metadataFor,
  paused,
  playing,
  replay,
  trackStart,
  type Step
} from '../testing/replay.js';

const GROUP = 'RINCON_TEST:1';
let counter = 0;

/** A fresh, isolated session object per test. */
function session() {
  counter += 1;
  return env.GROUP_SESSIONS.get(env.GROUP_SESSIONS.idFromName(`${GROUP}:${counter}`));
}

async function configured() {
  const stub = session();
  await stub.initialize({
    userId: 'u1',
    householdId: 'HH_1',
    groupId: GROUP,
    allowRadio: true,
    allowHandoff: false
  });
  return stub;
}

/**
 * How many times a given title was scrobbled.
 *
 * Assertions name the track rather than counting the whole run: most sequences leave a
 * final track still playing, which then legitimately earns its own scrobble during the
 * tail. Counting totals conflates "the track under test behaved correctly" with "how
 * long the run happened to continue".
 */
function timesScrobbled(result: { scrobbles: { track: string }[] }, title: string): number {
  return result.scrobbles.filter((s) => s.track === title).length;
}

const SONG = { artist: 'Anderson .Paak', title: 'Come Down', album: 'Malibu', durationMs: 180_000 };
const NEXT = { artist: 'Anderson .Paak', title: 'Silicon Valley', album: 'Malibu', durationMs: 244_000 };

describe('a group session, driven by realistic event sequences', () => {
  beforeEach(freshDatabase);

  it('scrobbles a track played straight through, from only two events', async () => {
    // THE case this harness exists for. Sonos sends nothing between the start of a
    // track and the start of the next one, so everything in the middle — crossing the
    // threshold, submitting the scrobble — has to happen on an alarm.
    const result = await replay(await configured(), [
      trackStart(0, SONG),
      trackStart(180_000, NEXT, 179_000)
    ]);

    expect(timesScrobbled(result, 'Come Down')).toBe(1);
    expect(result.scrobbles[0]).toMatchObject({
      artist: 'Anderson .Paak',
      track: 'Come Down',
      album: 'Malibu',
      durationSeconds: 180
    });
  });

  it('timestamps the scrobble at the moment the track started', async () => {
    const start = 1_800_000_000_000;
    const result = await replay(
      await configured(),
      [trackStart(0, SONG), trackStart(180_000, NEXT, 179_000)],
      { startMs: start }
    );
    // Last.fm orders history by this value; drifting it to submission time misorders
    // somebody's listening permanently.
    expect(result.scrobbles[0]?.timestamp).toBe(Math.floor(start / 1000));
  });

  it('timestamps a debounced track change from when the metadata arrived', async () => {
    // When no playbackStatus turns up to resolve a track change, the 3s debounce alarm
    // resolves it instead. The scrobble must still be stamped with when the track
    // actually started, not when the alarm happened to fire — otherwise every track in
    // the history sits a few seconds after the truth, which is visible when another
    // scrobbler is running alongside.
    const start = 1_800_000_000_000;
    const at = 5_000;
    const result = await replay(
      await configured(),
      [
        { at, metadata: metadataFor(SONG) },
        { at: at + 200_000, metadata: metadataFor(NEXT), playback: playing(0, 199_000) }
      ],
      { startMs: start }
    );

    expect(timesScrobbled(result, 'Come Down')).toBe(1);
    const scrobble = result.scrobbles.find((s) => s.track === 'Come Down');
    expect(scrobble?.timestamp).toBe(Math.floor((start + at) / 1000));
  });

  it('does not scrobble a track skipped a third of the way in', async () => {
    const result = await replay(await configured(), [
      trackStart(0, SONG),
      trackStart(60_000, NEXT, 60_000)
    ]);
    expect(timesScrobbled(result, 'Come Down')).toBe(0);
  });

  it('scrobbles the moment the threshold is crossed, not when the track ends', async () => {
    // A 3-minute track qualifies at 90s. Waiting for the next event would delay the
    // scrobble by minutes and lose it entirely if the track never formally ends.
    const result = await replay(await configured(), [trackStart(0, SONG)], { tailMs: 200_000 });
    expect(result.scrobbles).toHaveLength(1);
    expect(result.alarmsAt.some((at) => Math.abs(at - 90_000) < 2_000)).toBe(true);
  });

  it('counts only playing time across a long pause', async () => {
    // Play 40s, pause an hour, resume, finish. A track paused for an hour has not been
    // listened to for an hour.
    const steps: Step[] = [
      trackStart(0, SONG),
      { at: 40_000, playback: paused(40_000) },
      { at: 3_640_000, playback: playing(40_000) },
      { at: 3_790_000, metadata: metadataFor(NEXT), playback: playing(0, 190_000) }
    ];
    const result = await replay(await configured(), steps);
    expect(timesScrobbled(result, 'Come Down')).toBe(1);
  });

  it('does not scrobble a track that was paused before reaching the threshold', async () => {
    const result = await replay(
      await configured(),
      [trackStart(0, SONG), { at: 30_000, playback: paused(30_000) }],
      { tailMs: 600_000 }
    );
    expect(result.scrobbles).toHaveLength(0);
  });

  it('scrobbles each track of a three-track run exactly once', async () => {
    const third = { artist: 'Anderson .Paak', title: 'Heart Don’t Stand a Chance', durationMs: 200_000 };
    const result = await replay(await configured(), [
      trackStart(0, SONG),
      trackStart(180_000, NEXT, 179_000),
      trackStart(424_000, third, 243_000)
    ]);

    expect(result.scrobbles.map((s) => s.track)).toEqual([
      'Come Down',
      'Silicon Valley',
      'Heart Don’t Stand a Chance'
    ]);
  });

  it('never fires an alarm storm across a normal listening session', async () => {
    // The 1-second alarm loop that reached production would blow straight past this.
    const result = await replay(await configured(), [
      trackStart(0, SONG),
      trackStart(180_000, NEXT, 179_000),
      { at: 424_000, playback: idle() }
    ]);
    expect(result.alarmsAt.length).toBeLessThan(10);
  });

  it('stops the clock when playback goes idle', async () => {
    const result = await replay(
      await configured(),
      [trackStart(0, SONG), { at: 20_000, playback: idle(20_000) }],
      { tailMs: 600_000 }
    );
    expect(result.scrobbles).toHaveLength(0);
    expect(result.alarmsAt.length).toBeLessThan(5);
  });

  it('announces now-playing once per track', async () => {
    const result = await replay(await configured(), [
      trackStart(0, SONG),
      trackStart(180_000, NEXT, 179_000)
    ]);
    expect(result.nowPlaying.map((n) => n.track)).toEqual(['Come Down', 'Silicon Valley']);
  });

  it('tolerates playbackStatus arriving before metadataStatus', async () => {
    // The two events fire together on a track change and either can win the race.
    const result = await replay(await configured(), [
      { at: 0, playback: playing(0) },
      { at: 120, metadata: metadataFor(SONG) },
      { at: 180_000, playback: playing(0, 179_000) },
      { at: 180_120, metadata: metadataFor(NEXT) }
    ]);
    expect(timesScrobbled(result, 'Come Down')).toBe(1);
  });

  it('ignores a metadata refresh for the track already playing', async () => {
    // Artwork or an album name arriving late must not restart the clock.
    const result = await replay(await configured(), [
      trackStart(0, SONG),
      { at: 45_000, metadata: metadataFor(SONG) },
      trackStart(180_000, NEXT, 179_000)
    ]);
    // Exactly once despite two metadata events naming it — the refresh must not
    // restart the clock or re-earn the scrobble.
    expect(timesScrobbled(result, 'Come Down')).toBe(1);
    expect(result.nowPlaying).toHaveLength(2);
  });

  it('closes an overdue session once the end-of-track event never arrives', async () => {
    // Events stop after the track begins. The backstop fires at duration + slack,
    // tries to ask Sonos what happened, and — with no usable grant in the test
    // environment — closes the session rather than leaving a clock running that would
    // keep inventing listening time for a track that finished long ago.
    const stub = await configured();
    const result = await replay(stub, [trackStart(0, SONG)], { tailMs: 400_000 });

    // The scrobble was still earned on the way past the threshold.
    expect(timesScrobbled(result, 'Come Down')).toBe(1);
    // And the session is gone rather than lingering.
    expect(await sessionOf(stub)).toBeUndefined();
    // The backstop fired after the track's own length, not on some tight retry.
    expect(result.alarmsAt.some((at) => at >= 180_000)).toBe(true);
    expect(result.alarmsAt.length).toBeLessThan(10);
  });

  it('does not scrobble TV audio', async () => {
    const result = await replay(
      await configured(),
      [
        { at: 0, metadata: { container: { name: 'TV Audio', type: 'linein.homeTheater' } }, playback: playing(0) }
      ],
      { tailMs: 600_000 }
    );
    expect(result.scrobbles).toHaveLength(0);
    expect(result.declined).toContain('not-music');
  });

  it('closes out a track that was playing when its source was replaced by TV', async () => {
    // Switching to TV mid-song must still bank a scrobble the song had already earned.
    const result = await replay(await configured(), [
      trackStart(0, SONG),
      { at: 120_000, metadata: { container: { name: 'TV Audio', type: 'linein.homeTheater' } } }
    ]);
    expect(result.scrobbles.map((s) => s.track)).toEqual(['Come Down']);
  });

  it('requires four continuous minutes of radio before scrobbling', async () => {
    const station = {
      container: { name: 'BBC Radio 6 Music', type: 'station.broadcast' },
      streamInfo: 'Yo La Tengo - Autumn Sweater'
    };
    const early = await replay(
      await configured(),
      [{ at: 0, metadata: station, playback: playing(0) }, { at: 200_000, playback: idle(200_000) }],
      { tailMs: 60_000 }
    );
    expect(early.scrobbles).toHaveLength(0);

    const full = await replay(
      await configured(),
      [{ at: 0, metadata: station, playback: playing(0) }],
      { tailMs: 400_000 }
    );
    expect(full.scrobbles.map((s) => s.track)).toEqual(['Autumn Sweater']);
  });

  it('does not credit a forward seek as listening', async () => {
    // Jump to 170s of a 180s track after 5 seconds, then let it end. Ten seconds of
    // real listening must not become a scrobble.
    const result = await replay(await configured(), [
      trackStart(0, SONG),
      { at: 5_000, playback: playing(170_000) },
      { at: 15_000, metadata: metadataFor(NEXT), playback: playing(0, 180_000) }
    ]);
    expect(timesScrobbled(result, 'Come Down')).toBe(0);
  });

  it('recovers a scrobble from previousPositionMillis when mid-track events were lost', async () => {
    // The Worker was unreachable for the middle of the track, so no anchor arrived.
    // Sonos's own reading of the final position is what rescues it.
    const result = await replay(await configured(), [
      { at: 0, metadata: metadataFor(SONG), playback: playing(0) },
      { at: 180_000, metadata: metadataFor(NEXT), playback: playing(0, 179_000) }
    ]);
    expect(timesScrobbled(result, 'Come Down')).toBe(1);
  });
});
