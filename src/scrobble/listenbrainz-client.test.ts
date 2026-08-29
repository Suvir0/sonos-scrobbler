import { describe, expect, it, vi } from 'vitest';
import {
  buildListenPayload,
  classifyStatus,
  ListenBrainzClient,
  MAX_LISTENS_PER_BATCH
} from './listenbrainz-client.js';
import { SubmissionError } from './target.js';

/** Captures each request and replies with the supplied JSON. */
function stubFetch(responses: { body?: unknown; status?: number }[] = []) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = vi.fn(async (url: unknown, init: RequestInit | undefined) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { body: { status: 'ok' } };
    const status = next.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => next.body ?? { status: 'ok' }
    } as Response;
  });
  return { fetchStub: fetchStub as unknown as typeof fetch, calls };
}

function client(responses: { body?: unknown; status?: number }[] = [], token = 'TOKEN') {
  const { fetchStub, calls } = stubFetch(responses);
  return {
    instance: new ListenBrainzClient({ userToken: token }, { fetch: fetchStub }),
    calls
  };
}

const track = { artist: 'Sharon Van Etten', track: 'Seventeen', timestamp: 1_700_000_000 };

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('buildListenPayload', () => {
  it('maps a track onto ListenBrainz metadata names', () => {
    const payload = buildListenPayload({ ...track, album: 'Remind Me Tomorrow' });
    expect(payload).toEqual({
      track_metadata: {
        artist_name: 'Sharon Van Etten',
        track_name: 'Seventeen',
        release_name: 'Remind Me Tomorrow',
        additional_info: { media_player: 'Spinledger' }
      }
    });
  });

  it('converts duration to milliseconds and omits it when unknown', () => {
    const withDuration = buildListenPayload({ ...track, durationSeconds: 217.6 });
    const metadata = withDuration['track_metadata'] as { additional_info: Record<string, unknown> };
    expect(metadata.additional_info['duration_ms']).toBe(217_600);

    const withoutDuration = buildListenPayload(track);
    const bare = withoutDuration['track_metadata'] as { additional_info: Record<string, unknown> };
    expect(bare.additional_info).not.toHaveProperty('duration_ms');
  });
});

describe('classifyStatus', () => {
  it('treats a dead token as reauthorize and a malformed request as drop', () => {
    expect(classifyStatus(401)).toBe('reauthorize');
    expect(classifyStatus(400)).toBe('drop');
    expect(classifyStatus(413)).toBe('drop');
  });

  it('treats rate limiting and outages as retryable', () => {
    // Anything not known to be permanent must stay queued rather than be discarded.
    for (const status of [429, 500, 502, 503]) {
      expect(classifyStatus(status)).toBe('retry');
    }
  });
});

describe('ListenBrainzClient.scrobble', () => {
  it('submits one play as a single listen carrying listened_at', async () => {
    const { instance, calls } = client();
    await instance.scrobble([track]);

    const body = bodyOf(calls[0]!);
    expect(calls[0]!.url).toBe('https://api.listenbrainz.org/1/submit-listens');
    expect(body['listen_type']).toBe('single');
    expect((body['payload'] as { listened_at: number }[])[0]!.listened_at).toBe(1_700_000_000);
  });

  it('declares more than one play an import', async () => {
    // ListenBrainz reserves "single" for exactly one listen.
    const { instance, calls } = client();
    await instance.scrobble([track, { ...track, timestamp: track.timestamp + 300 }]);
    expect(bodyOf(calls[0]!)['listen_type']).toBe('import');
  });

  it('sends the token as a Token authorization header', async () => {
    const { instance, calls } = client();
    await instance.scrobble([track]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Token TOKEN');
  });

  it('reports every play in an accepted batch as accepted', async () => {
    // ListenBrainz accepts or rejects a submission whole and reports no per-listen result.
    const { instance } = client();
    expect(await instance.scrobble([track, { ...track, timestamp: 1 }])).toEqual({
      accepted: 2,
      ignored: 0,
      ignoredReasons: []
    });
  });

  it('does not call the service for an empty batch', async () => {
    const { instance, calls } = client();
    expect(await instance.scrobble([])).toEqual({ accepted: 0, ignored: 0, ignoredReasons: [] });
    expect(calls).toHaveLength(0);
  });

  it('refuses a batch larger than the documented maximum', async () => {
    const { instance } = client();
    const batch = Array.from({ length: MAX_LISTENS_PER_BATCH + 1 }, (_unused, index) => ({
      ...track,
      timestamp: track.timestamp + index
    }));
    await expect(instance.scrobble(batch)).rejects.toMatchObject({ kind: 'drop' });
  });

  it('refuses to submit with no token rather than sending an unauthenticated request', async () => {
    const { fetchStub } = stubFetch();
    const anonymous = new ListenBrainzClient({}, { fetch: fetchStub });
    expect(anonymous.hasSession).toBe(false);
    await expect(anonymous.scrobble([track])).rejects.toMatchObject({ kind: 'reauthorize' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('classifies a rejected submission and prefers the service’s own explanation', async () => {
    const { instance } = client([{ status: 400, body: { error: 'Invalid listen format' } }]);
    await expect(instance.scrobble([track])).rejects.toMatchObject({
      kind: 'drop',
      code: 400,
      message: 'ListenBrainz rejected the submission: Invalid listen format'
    });
  });

  it('keeps a play queued when the service is unreachable', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const offline = new ListenBrainzClient(
      { userToken: 'TOKEN' },
      { fetch: failing as unknown as typeof fetch }
    );
    await expect(offline.scrobble([track])).rejects.toMatchObject({ kind: 'retry' });
  });
});

describe('ListenBrainzClient.updateNowPlaying', () => {
  it('omits listened_at, which the service rejects on a playing_now', async () => {
    const { instance, calls } = client();
    await instance.updateNowPlaying({ artist: 'Sharon Van Etten', track: 'Seventeen' });

    const body = bodyOf(calls[0]!);
    expect(body['listen_type']).toBe('playing_now');
    expect((body['payload'] as Record<string, unknown>[])[0]).not.toHaveProperty('listened_at');
  });
});

describe('ListenBrainzClient.validateToken', () => {
  it('returns the account the token belongs to', async () => {
    const { instance } = client([{ body: { valid: true, user_name: 'suvir' } }]);
    expect(await instance.validateToken('TOKEN')).toEqual({ username: 'suvir' });
  });

  it('treats an invalid token as needing reauthorization', async () => {
    // The service answers 200 with valid:false rather than failing the request.
    const { instance } = client([{ body: { valid: false } }]);
    await expect(instance.validateToken('NOPE')).rejects.toMatchObject({ kind: 'reauthorize' });
  });
});

describe('ListenBrainzClient endpoint', () => {
  it('accepts a self-hosted HTTPS instance', async () => {
    const { fetchStub, calls } = stubFetch();
    const selfHosted = new ListenBrainzClient(
      { userToken: 'TOKEN', endpoint: 'https://listens.example.com/' },
      { fetch: fetchStub }
    );
    await selfHosted.scrobble([track]);
    expect(calls[0]!.url).toBe('https://listens.example.com/1/submit-listens');
  });

  it('refuses a plaintext endpoint, which would expose the token', async () => {
    const { fetchStub } = stubFetch();
    const insecure = new ListenBrainzClient(
      { userToken: 'TOKEN', endpoint: 'http://listens.example.com' },
      { fetch: fetchStub }
    );
    await expect(insecure.scrobble([track])).rejects.toBeInstanceOf(SubmissionError);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
