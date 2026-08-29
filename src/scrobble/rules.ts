/**
 * When a play has been listened to enough to count.
 *
 * Ported from the desktop app's `eligibility.ts`. The rules are Last.fm's and are
 * unchanged; only the units are, from seconds to milliseconds, because every figure
 * the Sonos cloud API reports is in milliseconds and converting at the edges was a
 * standing invitation to an off-by-1000.
 */

import type { ScrobbleTrack } from './target.js';

/** Last.fm will not accept anything shorter than this. */
export const MINIMUM_TRACK_MS = 30_000;

/** The upper bound on required listening, regardless of track length. */
export const SCROBBLE_POINT_CAP_MS = 240_000;

/**
 * Required listening for a stream whose length is unknown.
 *
 * Radio reports no usable song duration, so the half-way rule cannot apply. Four
 * minutes of continuous play on the same title is strong evidence a song genuinely
 * played, where a shorter window would scrobble jingles, adverts and station idents.
 */
export const UNKNOWN_DURATION_REQUIREMENT_MS = 240_000;

/** Now-playing expires server-side after ~2x this; refresh well inside it. */
export const NOW_PLAYING_REFRESH_MS = 120_000;

/**
 * The listening time at which a track becomes eligible, or undefined if it never can.
 */
export function scrobblePointMs(durationMs: number | undefined): number | undefined {
  if (durationMs === undefined) return UNKNOWN_DURATION_REQUIREMENT_MS;
  if (durationMs <= MINIMUM_TRACK_MS) return undefined;
  return Math.min(durationMs / 2, SCROBBLE_POINT_CAP_MS);
}

export interface TrackIdentity {
  artist: string;
  track: string;
  album?: string;
  objectId?: string;
}

/**
 * Whether two observations are the same play.
 *
 * The service's own object id is the strongest signal when both sides have one — it
 * survives a metadata refresh that changes casing or adds a "(Remastered)" suffix.
 * Radio has no object id and reuses one container for every song, so artist and title
 * decide there.
 */
export function isSameTrack(left: TrackIdentity, right: TrackIdentity): boolean {
  if (left.objectId && right.objectId) return left.objectId === right.objectId;
  return left.artist === right.artist && left.track === right.track;
}

export function toScrobbleTrack(
  identity: TrackIdentity,
  startedAtUnix: number,
  durationMs: number | undefined
): ScrobbleTrack {
  const track: ScrobbleTrack = {
    artist: identity.artist,
    track: identity.track,
    timestamp: startedAtUnix
  };
  if (identity.album) track.album = identity.album;
  if (durationMs !== undefined) track.durationSeconds = Math.round(durationMs / 1000);
  return track;
}
