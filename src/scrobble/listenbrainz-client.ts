/**
 * ListenBrainz client — only the submission surface.
 *
 * A far plainer API than Last.fm's: a JSON body, a bearer token, and ordinary HTTP
 * status codes rather than error codes smuggled inside 200 responses. Two things still
 * need care:
 *
 *  - **`listened_at` is required for `single`/`import` and forbidden for `playing_now`.**
 *    Sending it with a now-playing update is rejected outright.
 *  - **The token is a bearer credential.** Anyone holding it can write to the user's
 *    listen history, so the endpoint must be HTTPS; a self-hosted instance needs TLS
 *    rather than an exception here.
 *
 * No Electron, no filesystem — `fetch` is injected so the daemon reuses this untouched
 * and tests never open a socket.
 */

import { APP_NAME, USER_AGENT } from '../lib/identity.js';
import { withTimeout } from '../lib/timeout.js';
import {
  SubmissionError,
  type NowPlayingTrack,
  type ScrobbleResult,
  type ScrobbleTarget,
  type ScrobbleTrack
} from './target.js';

export const LISTENBRAINZ_ENDPOINT = 'https://api.listenbrainz.org';

/**
 * ListenBrainz permits a thousand listens per request, but the queue halves its batch to
 * isolate a rejected entry, and starting from a thousand would take ten rounds to find
 * one bad play. Fifty matches Last.fm, so queue behaviour is identical for both.
 */
export const MAX_LISTENS_PER_BATCH = 50;

export interface ListenBrainzCredentials {
  /** Absent until the user supplies a token from listenbrainz.org/settings. */
  userToken?: string;
  /** Override for a self-hosted instance. Must be HTTPS. */
  endpoint?: string;
}

export interface ListenBrainzDependencies {
  fetch: typeof fetch;
  timeoutMs: number;
}

/** Shapes a track the way ListenBrainz's `track_metadata` expects. */
export function buildListenPayload(track: ScrobbleTrack | NowPlayingTrack): Record<string, unknown> {
  const durationSeconds = track.durationSeconds;
  const additional: Record<string, unknown> = { media_player: APP_NAME };
  if (durationSeconds !== undefined && Number.isFinite(durationSeconds)) {
    additional['duration_ms'] = Math.round(durationSeconds * 1_000);
  }
  return {
    track_metadata: {
      artist_name: track.artist,
      track_name: track.track,
      ...(track.album ? { release_name: track.album } : {}),
      additional_info: additional
    }
  };
}

/**
 * Classifies an HTTP status.
 *
 * 401 is a dead token. 400 and 413 mean this exact request will never be accepted, so it
 * must not be retried or the queue jams behind it forever. Everything else — 429, the
 * 5xx family, a dropped connection — is worth trying again later.
 */
export function classifyStatus(status: number): SubmissionError['kind'] {
  if (status === 401) return 'reauthorize';
  if (status === 400 || status === 413) return 'drop';
  return 'retry';
}

function requireHttps(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') {
    throw new SubmissionError(
      'The ListenBrainz endpoint must use HTTPS, because the user token authorizes writes to a listen history',
      'drop'
    );
  }
  return url.origin;
}

export class ListenBrainzClient implements ScrobbleTarget {
  readonly id = 'listenbrainz';
  readonly label = 'ListenBrainz';
  readonly maxBatchSize = MAX_LISTENS_PER_BATCH;

  private readonly dependencies: ListenBrainzDependencies;

  constructor(
    private credentials: ListenBrainzCredentials = {},
    dependencies: Partial<ListenBrainzDependencies> = {}
  ) {
    this.dependencies = {
      fetch: (input, init) => fetch(input, init),
      timeoutMs: 15_000,
      ...dependencies
    };
  }

  setUserToken(userToken: string | undefined): void {
    this.credentials = { ...this.credentials, ...(userToken ? { userToken } : {}) };
    if (!userToken) delete this.credentials.userToken;
  }

  get hasSession(): boolean {
    return Boolean(this.credentials.userToken);
  }

  private get origin(): string {
    return requireHttps(this.credentials.endpoint ?? LISTENBRAINZ_ENDPOINT);
  }

  /**
   * Confirms a token works and returns the account it belongs to.
   *
   * This is the whole of the ListenBrainz "auth flow": the user pastes a token from
   * their settings page, so the only thing to verify is that it is live.
   */
  async validateToken(userToken: string): Promise<{ username: string }> {
    const response = await this.request('/1/validate-token', {
      method: 'GET',
      token: userToken
    });
    const body = (await this.readJson(response)) as { valid?: unknown; user_name?: unknown };
    if (body.valid !== true || typeof body.user_name !== 'string') {
      throw new SubmissionError('ListenBrainz rejected that token', 'reauthorize', 401);
    }
    return { username: body.user_name };
  }

  /** Submits completed plays. */
  async scrobble(tracks: readonly ScrobbleTrack[]): Promise<ScrobbleResult> {
    if (!tracks.length) return { accepted: 0, ignored: 0, ignoredReasons: [] };
    if (tracks.length > MAX_LISTENS_PER_BATCH) {
      throw new SubmissionError(
        `A ListenBrainz submission may contain at most ${MAX_LISTENS_PER_BATCH} listens`,
        'drop'
      );
    }

    await this.submit({
      // `single` is for exactly one listen; anything more must be declared an import.
      listen_type: tracks.length === 1 ? 'single' : 'import',
      payload: tracks.map((track) => ({
        listened_at: Math.round(track.timestamp),
        ...buildListenPayload(track)
      }))
    });

    // ListenBrainz accepts or rejects a submission as a whole and reports no per-listen
    // outcome, so a success means every play in the batch landed.
    return { accepted: tracks.length, ignored: 0, ignoredReasons: [] };
  }

  async updateNowPlaying(track: NowPlayingTrack): Promise<void> {
    // `listened_at` is deliberately absent: ListenBrainz rejects a playing_now that
    // carries one.
    await this.submit({ listen_type: 'playing_now', payload: [buildListenPayload(track)] });
  }

  private async submit(body: unknown): Promise<void> {
    const token = this.credentials.userToken;
    if (!token) {
      throw new SubmissionError('Not connected to ListenBrainz', 'reauthorize');
    }
    await this.request('/1/submit-listens', { method: 'POST', token, body });
  }

  private async request(
    path: string,
    options: { method: 'GET' | 'POST'; token: string; body?: unknown }
  ): Promise<Response> {
    // Bounded by an explicit controller rather than `AbortSignal.timeout`, whose pending
    // timer keeps the calling Durable Object alive for the full timeout even when the
    // request finished immediately. See `withTimeout`.
    //
    // The timer is cleared once the response head arrives; callers read the body after
    // this returns, which is a small immediate read against a connection already open.
    let response: Response;
    try {
      response = await withTimeout(this.dependencies.timeoutMs, (signal) =>
        this.dependencies.fetch(`${this.origin}${path}`, {
          method: options.method,
          headers: {
            Authorization: `Token ${options.token}`,
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal
        })
      );
    } catch (error) {
      // A SubmissionError from requireHttps is a configuration fault, not a network
      // one, and must keep its own classification.
      if (error instanceof SubmissionError) throw error;
      const detail = error instanceof Error ? error.message : 'request failed';
      throw new SubmissionError(`Could not reach ListenBrainz (${detail})`, 'retry');
    }

    if (!response.ok) {
      throw new SubmissionError(
        await describeFailure(response),
        classifyStatus(response.status),
        response.status
      );
    }
    return response;
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new SubmissionError('ListenBrainz returned a malformed response', 'retry');
    }
  }
}

/** Prefers the service's own explanation over a bare status line. */
async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') detail = body.error;
  } catch {
    // A non-JSON error body (a proxy's HTML page, say) leaves the status to speak.
  }
  return detail
    ? `ListenBrainz rejected the submission: ${detail}`
    : `ListenBrainz returned HTTP ${response.status}`;
}
