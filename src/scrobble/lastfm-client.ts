/**
 * Last.fm Web Services 2.0 client — only the scrobbling surface.
 *
 * Two things about this API are easy to get wrong and are handled deliberately here:
 *
 *  - **Errors arrive inside HTTP 200 responses.** A failed scrobble is a JSON body with
 *    an `error` code, not a failing status. Anything that only checks `response.ok`
 *    silently drops scrobbles.
 *  - **`format` is excluded from the signature.** Every other parameter, including the
 *    indexed batch ones (`artist[0]`, `timestamp[0]`), is included, sorted by name.
 *
 * No Electron, no filesystem — `fetch` and the hasher are injected so the daemon can
 * reuse this untouched and tests never open a socket.
 */

import { USER_AGENT } from '../lib/identity.js';
import { md5 } from '../lib/md5.js';
import {
  SubmissionError,
  type NowPlayingTrack,
  type ScrobbleResult,
  type ScrobbleTarget,
  type ScrobbleTrack
} from './target.js';

// Re-exported so existing importers keep resolving these from here; they are shared
// with every other scrobbling service and now live in `target.ts`.
export type { NowPlayingTrack, ScrobbleResult, ScrobbleTrack } from './target.js';

export const LASTFM_ENDPOINT = 'https://ws.audioscrobbler.com/2.0/';
export const MAX_SCROBBLES_PER_BATCH = 50;

export interface LastfmCredentials {
  apiKey: string;
  apiSecret: string;
  /** Absent until the user has completed the desktop auth flow. */
  sessionKey?: string;
}

/** @see SubmissionFailureKind — kept as an alias so existing call sites still read well. */
export type LastfmFailureKind = SubmissionError['kind'];

/**
 * Extends `SubmissionError` so the queue can classify a Last.fm failure without knowing
 * that Last.fm is what it is talking to. The argument order predates that and is kept.
 */
export class LastfmError extends SubmissionError {
  constructor(message: string, code: number | undefined, kind: LastfmFailureKind) {
    super(message, kind, code);
    this.name = 'LastfmError';
  }
}

/**
 * Classifies a Last.fm error code.
 *
 * Codes 11 (service offline) and 16 (temporarily unavailable) are explicitly
 * documented as retryable, and 29 is rate limiting. 9 means the session key is dead.
 * Everything else indicates a malformed request that must not be retried, or the queue
 * would jam forever behind one bad entry.
 */
export function classifyErrorCode(code: number | undefined): LastfmFailureKind {
  switch (code) {
    case 11:
    case 16:
    case 29:
      return 'retry';
    case 4:
    case 9:
    case 14:
      return 'reauthorize';
    default:
      return 'drop';
  }
}

/**
 * Builds the `api_sig`: parameters sorted by name, concatenated as `<name><value>`,
 * the shared secret appended, then MD5.
 */
export function signParameters(
  parameters: Readonly<Record<string, string>>,
  apiSecret: string,
  hash: (value: string) => string = md5
): string {
  const signable = Object.keys(parameters)
    // `format` is a transport concern and is excluded from the signature; including it
    // produces an "Invalid method signature" on every call.
    .filter((name) => name !== 'format' && name !== 'api_sig')
    .sort()
    .map((name) => `${name}${parameters[name]}`)
    .join('');
  return hash(`${signable}${apiSecret}`);
}

/** Flattens a batch into Last.fm's indexed parameter form. */
export function buildScrobbleParameters(tracks: readonly ScrobbleTrack[]): Record<string, string> {
  const parameters: Record<string, string> = {};
  tracks.forEach((entry, index) => {
    parameters[`artist[${index}]`] = entry.artist;
    parameters[`track[${index}]`] = entry.track;
    parameters[`timestamp[${index}]`] = String(entry.timestamp);
    if (entry.album) parameters[`album[${index}]`] = entry.album;
    if (entry.albumArtist) parameters[`albumArtist[${index}]`] = entry.albumArtist;
    if (entry.durationSeconds !== undefined) {
      parameters[`duration[${index}]`] = String(Math.round(entry.durationSeconds));
    }
  });
  return parameters;
}

export interface LastfmDependencies {
  fetch: typeof fetch;
  hash(value: string): string;
  timeoutMs: number;
}

export class LastfmClient implements ScrobbleTarget {
  readonly id = 'lastfm';
  readonly label = 'Last.fm';
  readonly maxBatchSize = MAX_SCROBBLES_PER_BATCH;

  private readonly dependencies: LastfmDependencies;

  constructor(
    private credentials: LastfmCredentials,
    dependencies: Partial<LastfmDependencies> = {}
  ) {
    this.dependencies = {
      fetch: (input, init) => fetch(input, init),
      hash: md5,
      timeoutMs: 15_000,
      ...dependencies
    };
  }

  setSessionKey(sessionKey: string | undefined): void {
    this.credentials = { ...this.credentials, ...(sessionKey ? { sessionKey } : {}) };
    if (!sessionKey) delete this.credentials.sessionKey;
  }

  get hasSession(): boolean {
    return Boolean(this.credentials.sessionKey);
  }

  /** Step one of the desktop auth flow: a request token, valid for 60 minutes. */
  async getToken(): Promise<string> {
    const body = await this.call('auth.getToken', {}, { authenticated: false });
    const token = (body as { token?: unknown }).token;
    if (typeof token !== 'string' || !token) {
      throw new LastfmError('Last.fm did not return a request token', undefined, 'retry');
    }
    return token;
  }

  /** Step three: exchange an approved token for a session key of unlimited lifetime. */
  async getSession(token: string): Promise<{ sessionKey: string; username: string }> {
    const body = await this.call('auth.getSession', { token }, { authenticated: false });
    const session = (body as { session?: { key?: unknown; name?: unknown } }).session;
    if (typeof session?.key !== 'string' || typeof session.name !== 'string') {
      throw new LastfmError('Last.fm did not return a session', undefined, 'retry');
    }
    return { sessionKey: session.key, username: session.name };
  }

  /**
   * Tells Last.fm what is playing right now. Fire-and-forget by nature: it expires on
   * its own and nothing is lost if it fails, so callers should not queue retries.
   */
  async updateNowPlaying(track: NowPlayingTrack): Promise<void> {
    await this.call('track.updateNowPlaying', {
      artist: track.artist,
      track: track.track,
      ...(track.album ? { album: track.album } : {}),
      ...(track.albumArtist ? { albumArtist: track.albumArtist } : {}),
      ...(track.durationSeconds !== undefined
        ? { duration: String(Math.round(track.durationSeconds)) }
        : {})
    });
  }

  /** Submits up to 50 completed plays. */
  async scrobble(tracks: readonly ScrobbleTrack[]): Promise<ScrobbleResult> {
    if (!tracks.length) return { accepted: 0, ignored: 0, ignoredReasons: [] };
    if (tracks.length > MAX_SCROBBLES_PER_BATCH) {
      throw new LastfmError(
        `A scrobble batch may contain at most ${MAX_SCROBBLES_PER_BATCH} tracks`,
        undefined,
        'drop'
      );
    }
    const body = await this.call('track.scrobble', buildScrobbleParameters(tracks));
    return readScrobbleResult(body);
  }

  private async call(
    method: string,
    parameters: Readonly<Record<string, string>>,
    options: { authenticated?: boolean } = {}
  ): Promise<unknown> {
    const authenticated = options.authenticated ?? true;
    if (authenticated && !this.credentials.sessionKey) {
      throw new LastfmError('Not connected to Last.fm', undefined, 'reauthorize');
    }

    const signed: Record<string, string> = {
      ...parameters,
      method,
      api_key: this.credentials.apiKey,
      ...(authenticated ? { sk: this.credentials.sessionKey as string } : {})
    };
    const form = new URLSearchParams({
      ...signed,
      api_sig: signParameters(signed, this.credentials.apiSecret, this.dependencies.hash),
      format: 'json'
    });

    let response: Response;
    try {
      response = await this.dependencies.fetch(LASTFM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.dependencies.timeoutMs)
      });
    } catch (error) {
      // Offline, DNS failure or timeout: always worth retrying later.
      const detail = error instanceof Error ? error.message : 'request failed';
      throw new LastfmError(`Could not reach Last.fm (${detail})`, undefined, 'retry');
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new LastfmError('Last.fm returned an unreadable response', undefined, 'retry');
    }

    // The error lives in the body even on a 200, so this must be checked before status.
    const errorCode = (body as { error?: unknown }).error;
    if (typeof errorCode === 'number') {
      const message = (body as { message?: unknown }).message;
      throw new LastfmError(
        typeof message === 'string' ? message : `Last.fm error ${errorCode}`,
        errorCode,
        classifyErrorCode(errorCode)
      );
    }
    if (!response.ok) {
      // A 5xx with no error code is Last.fm being unhealthy rather than us being wrong.
      throw new LastfmError(
        `Last.fm returned HTTP ${response.status}`,
        undefined,
        response.status >= 500 || response.status === 429 ? 'retry' : 'drop'
      );
    }
    return body;
  }
}

/**
 * Reads the accepted/ignored counts out of a scrobble response.
 *
 * A single scrobble comes back as an object where a batch comes back as an array, and
 * the counts are strings. An "ignored" entry was rejected by Last.fm (too old, blocked
 * artist, missing field) — it must be treated as done, not retried.
 */
export function readScrobbleResult(body: unknown): ScrobbleResult {
  const scrobbles = (body as { scrobbles?: unknown }).scrobbles as
    { '@attr'?: { accepted?: unknown; ignored?: unknown }; scrobble?: unknown } | undefined;

  const entries = Array.isArray(scrobbles?.scrobble)
    ? scrobbles.scrobble
    : scrobbles?.scrobble
      ? [scrobbles.scrobble]
      : [];

  const ignoredReasons: string[] = [];
  for (const entry of entries) {
    const message = (entry as { ignoredMessage?: { code?: unknown; '#text'?: unknown } })
      ?.ignoredMessage;
    if (
      message &&
      message.code !== '0' &&
      typeof message['#text'] === 'string' &&
      message['#text']
    ) {
      ignoredReasons.push(message['#text']);
    }
  }

  const accepted = Number(scrobbles?.['@attr']?.accepted ?? entries.length);
  const ignored = Number(scrobbles?.['@attr']?.ignored ?? 0);
  return {
    accepted: Number.isFinite(accepted) ? accepted : 0,
    ignored: Number.isFinite(ignored) ? ignored : 0,
    ignoredReasons
  };
}

/** The URL the user visits to approve the app. */
export function authorizationUrl(apiKey: string, token: string): string {
  return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
}
