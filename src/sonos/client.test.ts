import { describe, expect, it } from 'vitest';
import { RequestBudget } from './budget.js';
import { SonosApiError, SonosClient } from './client.js';

const BASE = 'https://api.ws.sonos.com/control/api/v1';

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

/** A stub fetch that replays queued responses and records what it was asked for. */
function stubFetch(responses: { status: number; body?: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization')
    });
    const next = responses.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status
    });
  }) as typeof fetch;
  return { impl, calls };
}

function client(responses: { status: number; body?: unknown }[], accessToken?: SonosClient['options']['accessToken']) {
  const { impl, calls } = stubFetch(responses);
  return {
    calls,
    client: new SonosClient({
      baseUrl: BASE,
      accessToken: accessToken ?? (async () => 'test-token'),
      fetch: impl,
      budget: new RequestBudget()
    })
  };
}

describe('SonosClient', () => {
  /**
   * The regression this file exists for.
   *
   * `this.fetchImpl = fetch` followed by `this.fetchImpl(...)` invokes the global fetch
   * with `this` bound to the client, and the Workers runtime refuses that outright with
   * "Illegal invocation: function called with incorrect `this` reference". It reached
   * production because every other test here injects a stub, and a plain function does
   * not care what `this` is — so no amount of mocked-fetch testing can catch it.
   *
   * This asserts the runtime behaviour first, then that the client's default does not
   * have the shape that triggers it.
   */
  describe('the default fetch', () => {
    // Worth knowing: this test environment does NOT reproduce the production failure.
    // Calling the global fetch as a method throws "Illegal invocation" on real workerd
    // but is tolerated here, which is exactly how the bug shipped. So the guard is
    // structural — assert the client never holds the bare global — rather than
    // behavioural, because the behaviour is untestable from inside the pool.
    it('never stores the bare global fetch', () => {
      const bare = new SonosClient({
        baseUrl: BASE,
        accessToken: async () => 't',
        budget: new RequestBudget()
      });
      const impl = (bare as unknown as { fetchImpl: typeof fetch }).fetchImpl;
      expect(impl).not.toBe(fetch);
    });

    it('still honours an explicitly injected fetch', () => {
      const injected = (async () => new Response('')) as typeof fetch;
      const withStub = new SonosClient({
        baseUrl: BASE,
        accessToken: async () => 't',
        fetch: injected,
        budget: new RequestBudget()
      });
      expect((withStub as unknown as { fetchImpl: typeof fetch }).fetchImpl).toBe(injected);
    });
  });

  it('reads households and sends the bearer token', async () => {
    const { client: c, calls } = client([
      { status: 200, body: { households: [{ id: 'HH_1', name: 'Home' }] } }
    ]);
    await expect(c.getHouseholds()).resolves.toEqual([{ id: 'HH_1', name: 'Home' }]);
    expect(calls[0]?.url).toBe(`${BASE}/households`);
    expect(calls[0]?.authorization).toBe('Bearer test-token');
  });

  it('returns an empty list when the response carries no households', async () => {
    const { client: c } = client([{ status: 200, body: {} }]);
    await expect(c.getHouseholds()).resolves.toEqual([]);
  });

  it('refreshes once and retries on a 401', async () => {
    const tokens: string[] = [];
    const { client: c, calls } = client(
      [
        { status: 401 },
        { status: 200, body: { households: [{ id: 'HH_2' }] } }
      ],
      async (options) => {
        const token = options?.force ? 'fresh' : 'stale';
        tokens.push(token);
        return token;
      }
    );

    await expect(c.getHouseholds()).resolves.toEqual([{ id: 'HH_2' }]);
    // Exactly one forced refresh. A loop here would multiply into the shared quota.
    expect(tokens).toEqual(['stale', 'fresh']);
    expect(calls.map((call) => call.authorization)).toEqual([
      'Bearer stale',
      'Bearer fresh'
    ]);
  });

  it('gives up after a single retry rather than looping', async () => {
    const { client: c, calls } = client([{ status: 401 }, { status: 401 }]);
    await expect(c.getHouseholds()).rejects.toBeInstanceOf(SonosApiError);
    expect(calls).toHaveLength(2);
  });

  it('classifies a 429 as rate limited', async () => {
    const { client: c } = client([{ status: 429 }]);
    const error = await c.getHouseholds().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SonosApiError);
    expect((error as SonosApiError).isRateLimited).toBe(true);
  });

  it('classifies a 404 on a group subscribe as gone, not a failure to report', async () => {
    // Groups are torn down constantly; subscribing to one that just vanished is routine.
    const { client: c } = client([{ status: 404 }]);
    const error = await c.subscribePlayback('G1').catch((e: unknown) => e);
    expect((error as SonosApiError).isGone).toBe(true);
  });

  it('subscribes each namespace at the documented scope', async () => {
    const { client: c, calls } = client([
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} }
    ]);
    await c.subscribeGroups('HH_1');
    await c.subscribePlayback('G1');
    await c.subscribePlaybackMetadata('G1');

    expect(calls.map((call) => `${call.method} ${call.url.slice(BASE.length)}`)).toEqual([
      // groups is household-scoped; the other two are group-scoped. Getting this wrong
      // means no events ever arrive.
      'POST /households/HH_1/groups/subscription',
      'POST /groups/G1/playback/subscription',
      'POST /groups/G1/playbackMetadata/subscription'
    ]);
  });

  it('percent-encodes ids so a group id with a colon cannot break the path', async () => {
    const { client: c, calls } = client([{ status: 200, body: {} }]);
    await c.subscribePlayback('RINCON_ABC:1');
    expect(calls[0]?.url).toBe(`${BASE}/groups/RINCON_ABC%3A1/playback/subscription`);
  });
});
