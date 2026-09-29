/**
 * Decides what a `metadataStatus` event is, and whether it may be scrobbled.
 *
 * This is the cloud rewrite of the desktop app's `isScrobbleable`. The *policy* is
 * carried over unchanged — decline TV and line-in, decline podcasts and audiobooks,
 * decline radio we cannot parse confidently, treat AirPlay as opt-in — but the
 * predicates are new, and better. On the LAN the app had to infer all of this from
 * UPnP class strings and `x-sonos-*` URI schemes; the cloud API states it outright in
 * `container.type` and `track.type`.
 *
 * The bias throughout is that a missing scrobble is a nuisance and a wrong scrobble is
 * a corruption of someone's listening history. Where the source is ambiguous, decline.
 */

import type { MetadataStatus, SonosContainerType, SonosTrack } from './types.js';

/** Sources that are not music at all. Nothing from these is ever scrobbled. */
const NEVER_SCROBBLE_CONTAINERS: ReadonlySet<string> = new Set([
  'linein',
  'linein.homeTheater',
  'episode',
  'show',
  'audiobook'
]);

/**
 * Whether a container is never music.
 *
 * TV audio is matched by prefix because a real soundbar reports the input as well:
 * `linein.homeTheater.hdmi`, and `linein.homeTheater.spdif` for optical. Only the
 * home-theater family is widened this way. `linein.airplay` is AirPlay, which is a
 * cast rather than line-in and is left for the handoff switch to decide.
 */
function isNeverScrobbleContainer(type: string): boolean {
  return NEVER_SCROBBLE_CONTAINERS.has(type) || type.startsWith('linein.homeTheater.');
}

/** Track types that are spoken-word rather than music, wherever they turn up. */
const NEVER_SCROBBLE_TRACKS: ReadonlySet<string> = new Set(['episode', 'show', 'audiobook']);

/**
 * The longest a track may claim to be and still be treated as a song.
 *
 * Sonos refuses TV, line-in, podcasts and audiobooks by container type, and handoff is
 * off by default, which is where a YouTube video normally enters a speaker. What gets
 * through all of that is a long file wearing a title and an artist: a DJ set, a mix, a
 * film soundtrack as one item, a sleep recording. None of those are a song, and a
 * scrobble of one is a corruption of a listening history in the same way a podcast
 * would be.
 *
 * Twenty minutes is above essentially every song and below essentially every mix. It
 * is not above every real recording, which is why `skipLongTracks` exists as a setting
 * rather than this being a hard rule.
 */
export const MAX_SONG_MS = 20 * 60_000;

/**
 * Containers whose tracks are live or programmed radio.
 *
 * These still scrobble, but they have no reliable duration, so they fall under the
 * unknown-duration rule (four minutes of continuous play) rather than the half-way one.
 */
const RADIO_CONTAINERS: ReadonlySet<string> = new Set([
  'station',
  'station.broadcast',
  'trackList.program'
]);

export type DeclineReason =
  | 'no-content'
  | 'not-music'
  | 'incomplete-metadata'
  | 'unparseable-stream'
  | 'handoff-source'
  | 'too-long';

export interface ScrobbleCandidate {
  artist: string;
  track: string;
  album?: string;
  durationMs?: number;
  /** Stable per-track service identity, when the source provides one. */
  objectId?: string;
  serviceName?: string;
  isRadio: boolean;
  /**
   * The whole title, when the speaker reported only the start of it.
   *
   * Sonos cuts long titles at a byte limit and says nothing about having done so; see
   * `scrobble/title-completion.ts`. `track` stays as reported, because that is what
   * every later event for the same play will say again and what identity is compared
   * on. This is what gets scrobbled and announced.
   */
  fullTitle?: string;
}

export type Classification =
  | { scrobbleable: true; candidate: ScrobbleCandidate }
  | { scrobbleable: false; reason: DeclineReason };

export interface ClassifyOptions {
  /**
   * Whether to accept AirPlay / Spotify Connect handoff.
   *
   * Off by default, carried over from the desktop app for the same reason: handoff
   * sources report a title and an "artist" for anything at all, including a YouTube
   * video whose artist is the uploader, and nothing in the payload distinguishes
   * AirPlayed music from AirPlayed video.
   */
  allowHandoff?: boolean;
  /** Whether to scrobble radio at all. */
  allowRadio?: boolean;
  /**
   * The longest a track may claim to be. Undefined removes the ceiling entirely.
   *
   * Only ever applied to a reported duration. Radio reports the stream's length rather
   * than the song's, and `trackCandidate` already drops it for that reason, so a
   * station is never refused by this.
   */
  maxTrackMs?: number;
}

export function isRadioContainer(type: SonosContainerType | undefined): boolean {
  return type !== undefined && RADIO_CONTAINERS.has(type);
}

/**
 * Container types a speaker reports while an app is casting to it.
 *
 * Seen on real speakers: Spotify Connect is `spotify.connect` for its first event and
 * then `collection.spotify.connect` or `playlist.spotify.connect` — the prefix follows
 * whatever the phone is playing from, so only the `.connect` ending is relied on.
 * AirPlay is `linein.airplay`, with a service named "Airplay".
 */
const HANDOFF_CONTAINER = /(^|\.)(connect|airplay)$/;

/**
 * Whether this is AirPlay, Spotify Connect or similar rather than the speaker playing
 * a service itself.
 *
 * Sonos says so in the container type, and over Spotify Connect also in the playback
 * session's client id. Neither can be inferred from the service: Spotify Connect names
 * Spotify and AirPlay names "Airplay", just as a native service names itself, which is
 * how checking for a missing service let every cast play through with this switch off
 * — and Spotify's own Last.fm link then scrobbled the same plays again.
 *
 * The missing-service shape is still accepted as a last resort: it is what a handoff
 * looked like before either signal was confirmed, and a named track with no service and
 * no container type has nothing else it could be.
 */
export function looksLikeHandoff(status: MetadataStatus): boolean {
  const containerType = status.container?.type;
  if (containerType && HANDOFF_CONTAINER.test(containerType)) return true;
  if (status.playbackSession?.clientId?.endsWith('.connect.adapter')) return true;

  const track = status.currentItem?.track;
  const hasService = Boolean(status.container?.service?.name ?? track?.service?.name);
  if (hasService) return false;
  return Boolean(track?.name) && containerType === undefined;
}

/**
 * Splits the "Artist - Title" text radio stations put in `streamInfo`.
 *
 * Carried over verbatim from the desktop app's `parseStreamContent`, including its
 * strictness: it commits only on exactly one separator with non-empty text on both
 * sides. A station that broadcasts "Now playing on Radio 6" yields nothing rather
 * than a fabricated artist.
 */
export function parseStreamInfo(
  value: string | undefined
): { artist: string; track: string } | undefined {
  if (!value) return undefined;
  const parts = value.split(/\s+[-–—]\s+/);
  if (parts.length !== 2) return undefined;
  const artist = parts[0]?.trim();
  const track = parts[1]?.trim();
  if (!artist || !track) return undefined;
  return { artist, track };
}

function trackCandidate(track: SonosTrack, isRadio: boolean): ScrobbleCandidate | undefined {
  const artist = track.artist?.name?.trim();
  const name = track.name?.trim();
  if (!artist || !name) return undefined;

  const candidate: ScrobbleCandidate = { artist, track: name, isRadio };
  const album = track.album?.name?.trim();
  if (album) candidate.album = album;
  // Radio reports a duration for the *stream*, not the song; ignoring it is what keeps
  // the four-minute rule in force instead of a bogus half-way point.
  if (!isRadio && typeof track.durationMillis === 'number' && track.durationMillis > 0) {
    candidate.durationMs = track.durationMillis;
  }
  if (track.id?.objectId) candidate.objectId = track.id.objectId;
  const service = track.service?.name;
  if (service) candidate.serviceName = service;
  return candidate;
}

export function classify(status: MetadataStatus, options: ClassifyOptions = {}): Classification {
  const { allowHandoff = false, allowRadio = true, maxTrackMs } = options;
  const containerType = status.container?.type;
  const track = status.currentItem?.track;

  // Nothing loaded at all.
  if (!status.container && !status.currentItem && !status.streamInfo) {
    return { scrobbleable: false, reason: 'no-content' };
  }

  // TV audio, line-in, podcasts, audiobooks. Checked before anything else so a
  // podcast episode that happens to carry an artist tag still gets declined.
  if (containerType && isNeverScrobbleContainer(containerType)) {
    return { scrobbleable: false, reason: 'not-music' };
  }
  if (track?.type && NEVER_SCROBBLE_TRACKS.has(track.type)) {
    return { scrobbleable: false, reason: 'not-music' };
  }

  if (!allowHandoff && looksLikeHandoff(status)) {
    return { scrobbleable: false, reason: 'handoff-source' };
  }

  const isRadio = isRadioContainer(containerType);
  if (isRadio && !allowRadio) {
    return { scrobbleable: false, reason: 'not-music' };
  }

  // Structured metadata is always preferred over the free-text stream string.
  if (track) {
    const candidate = trackCandidate(track, isRadio);
    if (candidate) {
      if (
        maxTrackMs !== undefined &&
        candidate.durationMs !== undefined &&
        candidate.durationMs > maxTrackMs
      ) {
        return { scrobbleable: false, reason: 'too-long' };
      }
      return { scrobbleable: true, candidate };
    }
  }

  // A track object that exists but lacks an artist or a title. Distinct from nothing
  // playing at all, and worth telling apart: this one means the source is sending us
  // music we cannot identify, which is a metadata problem worth surfacing.
  if (track && !status.streamInfo) {
    return { scrobbleable: false, reason: 'incomplete-metadata' };
  }

  // Radio with no `currentItem`: fall back to parsing `streamInfo`.
  if (status.streamInfo) {
    if (!allowRadio) return { scrobbleable: false, reason: 'not-music' };
    const parsed = parseStreamInfo(status.streamInfo);
    if (!parsed) return { scrobbleable: false, reason: 'unparseable-stream' };
    const candidate: ScrobbleCandidate = { ...parsed, isRadio: true };
    const station = status.container?.name?.trim();
    // The station is the closest thing to an album radio has, and it is what the
    // desktop app has always submitted.
    if (station) candidate.album = station;
    const service = status.container?.service?.name;
    if (service) candidate.serviceName = service;
    return { scrobbleable: true, candidate };
  }

  // An idle room. Sonos keeps sending its stale container after the queue empties, so
  // this is the single most common event the service sees and it is entirely normal.
  return { scrobbleable: false, reason: 'no-content' };
}
