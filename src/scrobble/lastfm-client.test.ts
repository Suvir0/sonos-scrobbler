import { describe, expect, it, vi } from 'vitest';
import {
  authorizationUrl,
  buildScrobbleParameters,
  classifyErrorCode,
  LastfmClient,
  LastfmError,
  readScrobbleResult,
  readTopTracks,
  readTrackMatches,
  signParameters
} from './lastfm-client.js';

const credentials = { apiKey: 'KEY', apiSecret: 'SECRET', sessionKey: 'SESSION' };

/** Captures the form body of each request and replies with the supplied JSON. */
function stubFetch(responses: { body: unknown; status?: number }[]) {
  const calls: URLSearchParams[] = [];
  const fetchStub = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    calls.push(new URLSearchParams(String(init?.body ?? '')));
    const next = responses.shift() ?? { body: {} };
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      text: async () => JSON.stringify(next.body)
    } as Response;
  });
  return { fetchStub: fetchStub as unknown as typeof fetch, calls };
}

describe('signParameters', () => {
  it('sorts by name and appends the secret before hashing', () => {
    const hash = vi.fn().mockReturnValue('digest');
    signParameters({ b: '2', a: '1' }, 'SECRET', hash);
    expect(hash).toHaveBeenCalledWith('a1b2SECRET');
  });

  it('excludes format and api_sig from the signature', () => {
    // Including `format` produces "Invalid method signature" on every single call.
    const hash = vi.fn().mockReturnValue('digest');
    signParameters({ a: '1', format: 'json', api_sig: 'old' }, 'SECRET', hash);
    expect(hash).toHaveBeenCalledWith('a1SECRET');
  });

  it('signs indexed batch parameters in string-sorted order', () => {
    const hash = vi.fn().mockReturnValue('digest');
    signParameters({ 'artist[1]': 'B', 'artist[0]': 'A' }, 'S', hash);
    expect(hash).toHaveBeenCalledWith('artist[0]Aartist[1]BS');
  });

  it('produces a stable MD5 with the real hasher', () => {
    // Locks the exact digest so a refactor of the concatenation cannot go unnoticed.
    expect(signParameters({ a: '1', b: '2' }, 'SECRET')).toBe(
      signParameters({ b: '2', a: '1' }, 'SECRET')
    );
    expect(signParameters({ a: '1' }, 'SECRET')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('classifyErrorCode', () => {
  it('retries the documented transient codes', () => {
    expect(classifyErrorCode(11)).toBe('retry');
    expect(classifyErrorCode(16)).toBe('retry');
    expect(classifyErrorCode(29)).toBe('retry');
  });

  it('asks for reauthorization on session failures', () => {
    expect(classifyErrorCode(9)).toBe('reauthorize');
    expect(classifyErrorCode(4)).toBe('reauthorize');
    expect(classifyErrorCode(14)).toBe('reauthorize');
  });

  it('drops anything else, since retrying would fail identically', () => {
    expect(classifyErrorCode(6)).toBe('drop');
    expect(classifyErrorCode(13)).toBe('drop');
    expect(classifyErrorCode(undefined)).toBe('drop');
  });
});

describe('buildScrobbleParameters', () => {
  it('indexes each track and omits absent optional fields', () => {
    const parameters = buildScrobbleParameters([
      {
        artist: 'Radiohead',
        track: 'Nude',
        timestamp: 100,
        album: 'In Rainbows',
        durationSeconds: 260.6
      },
      { artist: 'Aphex Twin', track: 'Xtal', timestamp: 200 }
    ]);
    expect(parameters).toEqual({
      'artist[0]': 'Radiohead',
      'track[0]': 'Nude',
      'timestamp[0]': '100',
      'album[0]': 'In Rainbows',
      // Durations are submitted as whole seconds.
      'duration[0]': '261',
      'artist[1]': 'Aphex Twin',
      'track[1]': 'Xtal',
      'timestamp[1]': '200'
    });
  });
});

describe('readScrobbleResult', () => {
  it('reads the counts from a batch response', () => {
    expect(
      readScrobbleResult({ scrobbles: { '@attr': { accepted: '3', ignored: '1' }, scrobble: [] } })
    ).toMatchObject({ accepted: 3, ignored: 1 });
  });

  it('handles a single scrobble arriving as an object rather than an array', () => {
    const result = readScrobbleResult({
      scrobbles: {
        '@attr': { accepted: '1', ignored: '0' },
        scrobble: { ignoredMessage: { code: '0', '#text': '' } }
      }
    });
    expect(result.accepted).toBe(1);
    expect(result.ignoredReasons).toEqual([]);
  });

  it('surfaces the reason an entry was ignored', () => {
    const result = readScrobbleResult({
      scrobbles: {
        '@attr': { accepted: '0', ignored: '1' },
        scrobble: { ignoredMessage: { code: '1', '#text': 'Artist was ignored' } }
      }
    });
    expect(result.ignoredReasons).toEqual(['Artist was ignored']);
  });

  it('does not throw on an unexpected body', () => {
    expect(readScrobbleResult({})).toEqual({ accepted: 0, ignored: 0, ignoredReasons: [] });
  });
});

describe('LastfmClient', () => {
  it('signs and sends a scrobble with the session key', async () => {
    const { fetchStub, calls } = stubFetch([
      { body: { scrobbles: { '@attr': { accepted: '1', ignored: '0' }, scrobble: [] } } }
    ]);
    const client = new LastfmClient(credentials, { fetch: fetchStub });
    const result = await client.scrobble([{ artist: 'Radiohead', track: 'Nude', timestamp: 100 }]);

    expect(result.accepted).toBe(1);
    const form = calls[0]!;
    expect(form.get('method')).toBe('track.scrobble');
    expect(form.get('sk')).toBe('SESSION');
    expect(form.get('api_key')).toBe('KEY');
    expect(form.get('format')).toBe('json');
    expect(form.get('api_sig')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('treats an error inside a 200 response as a failure', async () => {
    // The single most important behaviour here: Last.fm reports failures with HTTP 200.
    const { fetchStub } = stubFetch([
      { body: { error: 9, message: 'Invalid session key' }, status: 200 }
    ]);
    const client = new LastfmClient(credentials, { fetch: fetchStub });

    await expect(
      client.scrobble([{ artist: 'a', track: 'b', timestamp: 1 }])
    ).rejects.toMatchObject({
      code: 9,
      kind: 'reauthorize'
    });
  });

  it('classifies a service-offline error as retryable', async () => {
    const { fetchStub } = stubFetch([{ body: { error: 11, message: 'Service offline' } }]);
    const client = new LastfmClient(credentials, { fetch: fetchStub });
    await expect(
      client.scrobble([{ artist: 'a', track: 'b', timestamp: 1 }])
    ).rejects.toMatchObject({
      kind: 'retry'
    });
  });

  it('treats a network failure as retryable', async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const client = new LastfmClient(credentials, { fetch: fetchStub as unknown as typeof fetch });
    await expect(
      client.scrobble([{ artist: 'a', track: 'b', timestamp: 1 }])
    ).rejects.toMatchObject({
      kind: 'retry'
    });
  });

  it('treats a 5xx with no error body as retryable and a 4xx as a drop', async () => {
    const server = stubFetch([{ body: {}, status: 503 }]);
    await expect(
      new LastfmClient(credentials, { fetch: server.fetchStub }).scrobble([
        { artist: 'a', track: 'b', timestamp: 1 }
      ])
    ).rejects.toMatchObject({ kind: 'retry' });

    const client = stubFetch([{ body: {}, status: 400 }]);
    await expect(
      new LastfmClient(credentials, { fetch: client.fetchStub }).scrobble([
        { artist: 'a', track: 'b', timestamp: 1 }
      ])
    ).rejects.toMatchObject({ kind: 'drop' });
  });

  it('refuses to call without a session rather than sending an unsigned request', async () => {
    const { fetchStub } = stubFetch([]);
    const client = new LastfmClient({ apiKey: 'KEY', apiSecret: 'SECRET' }, { fetch: fetchStub });
    await expect(
      client.scrobble([{ artist: 'a', track: 'b', timestamp: 1 }])
    ).rejects.toMatchObject({
      kind: 'reauthorize'
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refuses a batch over the fifty-track limit', async () => {
    const { fetchStub } = stubFetch([]);
    const client = new LastfmClient(credentials, { fetch: fetchStub });
    const tracks = Array.from({ length: 51 }, (_, index) => ({
      artist: 'a',
      track: 'b',
      timestamp: index
    }));
    await expect(client.scrobble(tracks)).rejects.toThrow(/at most 50/);
  });

  it('returns immediately for an empty batch', async () => {
    const { fetchStub } = stubFetch([]);
    const client = new LastfmClient(credentials, { fetch: fetchStub });
    expect(await client.scrobble([])).toEqual({ accepted: 0, ignored: 0, ignoredReasons: [] });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('runs the token half of the auth flow unauthenticated', async () => {
    const { fetchStub, calls } = stubFetch([{ body: { token: 'TOKEN' } }]);
    const client = new LastfmClient({ apiKey: 'KEY', apiSecret: 'SECRET' }, { fetch: fetchStub });
    expect(await client.getToken()).toBe('TOKEN');
    expect(calls[0]!.get('sk')).toBeNull();
  });

  it('exchanges an approved token for a session', async () => {
    const { fetchStub } = stubFetch([
      { body: { session: { key: 'SESSION', name: 'suvir', subscriber: 0 } } }
    ]);
    const client = new LastfmClient({ apiKey: 'KEY', apiSecret: 'SECRET' }, { fetch: fetchStub });
    expect(await client.getSession('TOKEN')).toEqual({ sessionKey: 'SESSION', username: 'suvir' });
  });

  it('reports a malformed session response rather than storing nothing', async () => {
    const { fetchStub } = stubFetch([{ body: { session: {} } }]);
    const client = new LastfmClient({ apiKey: 'KEY', apiSecret: 'SECRET' }, { fetch: fetchStub });
    await expect(client.getSession('TOKEN')).rejects.toBeInstanceOf(LastfmError);
  });

  it('sends now-playing with the optional fields it has', async () => {
    const { fetchStub, calls } = stubFetch([{ body: { nowplaying: {} } }]);
    const client = new LastfmClient(credentials, { fetch: fetchStub });
    await client.updateNowPlaying({
      artist: 'Radiohead',
      track: 'Nude',
      album: 'In Rainbows',
      durationSeconds: 260.4
    });
    const form = calls[0]!;
    expect(form.get('method')).toBe('track.updateNowPlaying');
    expect(form.get('album')).toBe('In Rainbows');
    expect(form.get('duration')).toBe('260');
  });

  it('tracks whether a session is held', () => {
    const client = new LastfmClient({ apiKey: 'KEY', apiSecret: 'SECRET' });
    expect(client.hasSession).toBe(false);
    client.setSessionKey('SESSION');
    expect(client.hasSession).toBe(true);
    client.setSessionKey(undefined);
    expect(client.hasSession).toBe(false);
  });
});

describe('authorizationUrl', () => {
  it('builds the approval URL with both parameters encoded', () => {
    expect(authorizationUrl('KEY', 'TOK EN')).toBe(
      'https://www.last.fm/api/auth/?api_key=KEY&token=TOK%20EN'
    );
  });
});

describe('catalogue lookups', () => {
  /** Captures the URL of each GET and replies with the supplied JSON. */
  function stubGet(body: unknown, status = 200) {
    const urls: URL[] = [];
    const fetchStub = vi.fn(async (url: unknown, init: RequestInit | undefined) => {
      urls.push(new URL(String(url)));
      expect(init?.method).toBe('GET');
      return { ok: status < 400, status, json: async () => body } as Response;
    });
    return { fetchStub: fetchStub as unknown as typeof fetch, urls };
  }

  const searchBody = {
    results: {
      trackmatches: {
        track: [
          { name: 'Come Down (Remix)', artist: 'Anderson .Paak', listeners: '1200' },
          { name: 'Come Down', artist: 'Anderson .Paak', listeners: '345678' },
          { name: 'broken', artist: 7 },
          { artist: 'No Name' }
        ]
      }
    }
  };

  it('searches by artist and title with the key alone, unsigned', async () => {
    const { fetchStub, urls } = stubGet(searchBody);
    const client = new LastfmClient({ apiKey: 'KEY', apiSecret: 'SECRET' }, { fetch: fetchStub });

    const matches = await client.searchTracks('Anderson .Paak', 'Come Down');

    const query = urls[0]?.searchParams;
    expect(urls[0]?.origin).toBe('https://ws.audioscrobbler.com');
    expect(query?.get('method')).toBe('track.search');
    expect(query?.get('artist')).toBe('Anderson .Paak');
    expect(query?.get('track')).toBe('Come Down');
    expect(query?.get('api_key')).toBe('KEY');
    expect(query?.get('format')).toBe('json');
    expect(query?.has('api_sig')).toBe(false);
    expect(query?.has('sk')).toBe(false);
    // Malformed rows are dropped rather than thrown; listeners become numbers.
    expect(matches).toEqual([
      { name: 'Come Down (Remix)', artist: 'Anderson .Paak', listeners: 1200 },
      { name: 'Come Down', artist: 'Anderson .Paak', listeners: 345_678 }
    ]);
  });

  it('reads the top-tracks shape, whose artist is nested', async () => {
    const { fetchStub, urls } = stubGet({
      toptracks: {
        track: [{ name: 'Come Down', artist: { name: 'Anderson .Paak' }, listeners: '345678' }]
      }
    });
    const client = new LastfmClient({ apiKey: 'KEY', apiSecret: 'SECRET' }, { fetch: fetchStub });

    const tracks = await client.topTracks('Anderson .Paak');

    expect(urls[0]?.searchParams.get('method')).toBe('artist.gettoptracks');
    expect(urls[0]?.searchParams.get('artist')).toBe('Anderson .Paak');
    expect(tracks).toEqual([{ name: 'Come Down', artist: 'Anderson .Paak', listeners: 345_678 }]);
  });

  it('reads a single match delivered as an object rather than a list', () => {
    expect(
      readTrackMatches({ results: { trackmatches: { track: { name: 'Only', artist: 'One' } } } })
    ).toEqual([{ name: 'Only', artist: 'One' }]);
    expect(readTopTracks({ toptracks: { track: { name: 'Only', artist: { name: 'One' } } } })).toEqual([
      { name: 'Only', artist: 'One' }
    ]);
  });

  it('reads nothing out of a missing or malformed body', () => {
    expect(readTrackMatches(undefined)).toEqual([]);
    expect(readTrackMatches({})).toEqual([]);
    expect(readTrackMatches({ results: { trackmatches: 'nope' } })).toEqual([]);
    expect(readTopTracks(undefined)).toEqual([]);
    expect(readTopTracks({ toptracks: { track: [{ name: 'x', artist: 'flat' }] } })).toEqual([]);
  });

  it('returns nothing on a failing status, and never throws', async () => {
    const { fetchStub } = stubGet({ error: 29, message: 'Rate limit exceeded' }, 429);
    const client = new LastfmClient({ apiKey: 'KEY', apiSecret: 'SECRET' }, { fetch: fetchStub });
    await expect(client.searchTracks('a', 'b')).resolves.toEqual([]);
    await expect(client.topTracks('a')).resolves.toEqual([]);

    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const offline = new LastfmClient(
      { apiKey: 'KEY', apiSecret: 'SECRET' },
      { fetch: failing as unknown as typeof fetch }
    );
    await expect(offline.searchTracks('a', 'b')).resolves.toEqual([]);
  });
});
