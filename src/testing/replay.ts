/**
 * A replay harness for the group-session pipeline.
 *
 * Every serious bug found in production so far came from the same gap: the tests fed
 * the code events I invented, at a cadence I invented, and the real system behaves
 * nothing like that. Sonos's own documentation is explicit —
 *
 *   "If a track is playing normally on a group, your app will not receive
 *    playbackStatus events while the track position progresses."
 *
 * — so a four-minute song is frequently *two* events, one at each end, and everything
 * in between depends on alarms firing on a clock nobody was simulating.
 *
 * This harness models that faithfully:
 *
 *  - Virtual time. A four-minute threshold is exercised in a millisecond, so the paths
 *    that only run after minutes of playback are actually reachable in a test suite.
 *  - Real alarm scheduling. After every step it reads the Durable Object's own alarm
 *    and fires it at the scheduled instant, exactly as the runtime would. Alarm-driven
 *    behaviour is therefore tested rather than assumed.
 *  - The real Durable Object. No reimplementation of the state machine to drift from
 *    the one that ships.
 */

import { runInDurableObject } from 'cloudflare:test';
import type { GroupSession, EventOutcome } from '../do/group-session.js';
import type { MetadataStatus, PlaybackStatus } from '../sonos/types.js';
import type { ScrobbleTrack } from '../scrobble/target.js';

export interface Step {
  /** Milliseconds from the start of the run. */
  at: number;
  metadata?: MetadataStatus;
  playback?: PlaybackStatus;
}

export interface ReplayResult {
  scrobbles: ScrobbleTrack[];
  nowPlaying: { artist: string; track: string }[];
  declined: string[];
  /** Every alarm the run fired, as offsets from the start. Guards against alarm storms. */
  alarmsAt: number[];
}

export interface ReplayOptions {
  /** Wall-clock instant the run starts at. */
  startMs?: number;
  /** How long to keep firing alarms after the last step. */
  tailMs?: number;
  /** Safety valve: a runaway alarm loop fails the test instead of hanging it. */
  maxAlarms?: number;
}

const DEFAULT_START = 1_800_000_000_000;

/**
 * Runs a scripted event sequence against a real GroupSession and reports what it did.
 */
export async function replay(
  stub: DurableObjectStub<GroupSession>,
  steps: readonly Step[],
  options: ReplayOptions = {}
): Promise<ReplayResult> {
  const start = options.startMs ?? DEFAULT_START;
  const tail = options.tailMs ?? 600_000;
  const maxAlarms = options.maxAlarms ?? 200;

  const result: ReplayResult = { scrobbles: [], nowPlaying: [], declined: [], alarmsAt: [] };

  const collect = (outcome: EventOutcome): void => {
    if (outcome.scrobbled) result.scrobbles.push(outcome.scrobbled);
    if (outcome.nowPlaying) {
      result.nowPlaying.push({
        artist: outcome.nowPlaying.artist,
        track: outcome.nowPlaying.track
      });
    }
    if (outcome.declined) result.declined.push(outcome.declined);
  };

  const ordered = [...steps].sort((left, right) => left.at - right.at);
  const endMs = start + (ordered.at(-1)?.at ?? 0) + tail;

  let clock = start;

  /** Fires every alarm the object has scheduled at or before `until`. */
  const runAlarmsUntil = async (until: number): Promise<void> => {
    for (;;) {
      const scheduled = await stub.alarmAt();
      if (scheduled === null || scheduled > until) return;

      // The runtime never fires an alarm in the past; neither does this.
      clock = Math.max(clock, scheduled);
      result.alarmsAt.push(clock - start);
      if (result.alarmsAt.length > maxAlarms) {
        throw new Error(
          `alarm storm: ${result.alarmsAt.length} alarms fired. ` +
            `Last few at +${result.alarmsAt.slice(-5).join('ms, +')}ms`
        );
      }
      collect(await stub.tick(clock));
    }
  };

  for (const step of ordered) {
    const stepAt = start + step.at;
    await runAlarmsUntil(stepAt);
    clock = Math.max(clock, stepAt);

    // Metadata first when a step carries both: that is the order the classifier needs
    // to stage a pending track before the position reading resolves it.
    if (step.metadata) collect(await stub.onMetadataStatus(step.metadata, clock));
    if (step.playback) collect(await stub.onPlaybackStatus(step.playback, clock));
  }

  await runAlarmsUntil(endMs);
  return result;
}

/** Reads a Durable Object's stored session, for asserting on state rather than output. */
export async function sessionOf(stub: DurableObjectStub<GroupSession>): Promise<unknown> {
  return runInDurableObject(stub, async (_instance, state) => state.storage.get('session'));
}

/* ------------------------------------------------------------------ fixtures */

export interface TrackSpec {
  artist: string;
  title: string;
  album?: string;
  durationMs?: number;
  objectId?: string;
}

/** A metadataStatus body shaped like the ones real players send. */
export function metadataFor(spec: TrackSpec): MetadataStatus {
  return {
    container: {
      name: spec.album ?? spec.title,
      type: 'album',
      service: { name: 'Acme Music' }
    },
    currentItem: {
      track: {
        type: 'track',
        name: spec.title,
        ...(spec.album ? { album: { name: spec.album } } : {}),
        artist: { name: spec.artist },
        id: { serviceId: '204', objectId: spec.objectId ?? `song:${spec.title}` },
        service: { name: 'Acme Music' },
        ...(spec.durationMs === undefined ? {} : { durationMillis: spec.durationMs })
      }
    }
  };
}

export function playing(positionMs: number, previousPositionMs?: number): PlaybackStatus {
  return {
    playbackState: 'PLAYBACK_STATE_PLAYING',
    positionMillis: positionMs,
    ...(previousPositionMs === undefined ? {} : { previousPositionMillis: previousPositionMs })
  };
}

export function paused(positionMs: number): PlaybackStatus {
  return { playbackState: 'PLAYBACK_STATE_PAUSED', positionMillis: positionMs };
}

export function idle(positionMs = 0): PlaybackStatus {
  return { playbackState: 'PLAYBACK_STATE_IDLE', positionMillis: positionMs };
}

/**
 * The event pair a real player emits when a track begins.
 *
 * Deliberately just two events, with nothing in between until the next track: that
 * silence is the defining property of this API and the thing invented fixtures always
 * get wrong.
 */
export function trackStart(at: number, spec: TrackSpec, previousPositionMs?: number): Step {
  return {
    at,
    metadata: metadataFor(spec),
    playback: playing(0, previousPositionMs)
  };
}
