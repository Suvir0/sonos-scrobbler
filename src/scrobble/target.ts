/**
 * What a scrobbling service has to provide, and nothing more.
 *
 * Last.fm and ListenBrainz disagree about almost everything on the wire — form-encoded
 * MD5-signed parameters against a JSON body with a bearer token, error codes inside
 * HTTP 200 against ordinary status codes, fifty plays per batch against a thousand.
 * None of that is the queue's business. The queue's job is to hold an earned play until
 * something accepts it, and that job is identical whoever is receiving it.
 *
 * So everything service-specific lives behind this interface. A third service is a new
 * file implementing `ScrobbleTarget`, not an edit to the queue.
 */

/**
 * How the caller should react to a failure.
 *
 * `retry` — transient (offline, the service is down, rate limited); keep the play queued.
 * `reauthorize` — the credential is no longer valid; stop and prompt the user.
 * `drop` — the request was malformed; retrying it will fail identically forever.
 */
export type SubmissionFailureKind = 'retry' | 'reauthorize' | 'drop';

/**
 * A failure a scrobbling service reported, classified into what to do about it.
 *
 * The queue catches this type rather than any service's own error class, which is what
 * lets one queue back every service.
 */
export class SubmissionError extends Error {
  constructor(
    message: string,
    readonly kind: SubmissionFailureKind,
    readonly code?: number
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}

export interface ScrobbleTrack {
  artist: string;
  track: string;
  /** UTC seconds at which playback of this track *started*. */
  timestamp: number;
  album?: string;
  albumArtist?: string;
  durationSeconds?: number;
}

export interface NowPlayingTrack {
  artist: string;
  track: string;
  album?: string;
  albumArtist?: string;
  durationSeconds?: number;
}

export interface ScrobbleResult {
  accepted: number;
  ignored: number;
  /** Human-readable reasons the service gave for ignoring entries, if any. */
  ignoredReasons: string[];
}

export interface ScrobbleTarget {
  /** Stable machine identifier, used for settings keys and queue filenames. */
  readonly id: string;
  /** How the service is named to the user, e.g. in "Connect your Last.fm account". */
  readonly label: string;
  /** Whether a usable credential is currently held. */
  readonly hasSession: boolean;
  /** Most plays this service accepts in one request. */
  readonly maxBatchSize: number;
  scrobble(tracks: readonly ScrobbleTrack[]): Promise<ScrobbleResult>;
  /**
   * Reports what is playing right now. Fire-and-forget by nature: it expires on its own
   * and nothing is lost if it fails, so callers must not queue retries for it.
   */
  updateNowPlaying(track: NowPlayingTrack): Promise<void>;
}
