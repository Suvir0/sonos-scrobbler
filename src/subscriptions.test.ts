import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { RequestBudget } from './sonos/budget.js';
import { SonosClient } from './sonos/client.js';
import { applySchema, resetTables } from './testing/schema.js';
import { MIN_TOPOLOGY_SYNC_INTERVAL_MS, syncHousehold } from './subscriptions.js';

const USER = 'u1';
const HH = 'HH_1';
const T0 = 1_800_000_000_000;

/** Records every path the client asks Sonos for. */
function recordingClient() {
  const paths: string[] = [];
  const client = new SonosClient({
    baseUrl: 'https://api.ws.sonos.com/control/api/v1',
    accessToken: async () => 'token',
    // A fresh budget per client: the shipping one is module-scoped and shared across
    // the whole isolate, so without this the suite throttles itself.
    budget: new RequestBudget(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      paths.push(`${init?.method ?? 'GET'} ${String(input).split('/v1')[1]}`);
      return new Response(JSON.stringify({ groups: [{ id: 'G1', name: 'Den' }] }), {
        status: 200
      });
    }) as typeof fetch
  });
  return { client, paths };
}

describe('syncHousehold', () => {
  beforeEach(async () => {
    await applySchema();
    await resetTables();
    await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(USER, T0).run();
    await env.DB.prepare(
      'INSERT INTO households (household_id, user_id, name, created_at) VALUES (?, ?, ?, ?)'
    )
      .bind(HH, USER, 'Home', T0)
      .run();
  });

  it('subscribes the household namespace and every group on a full sync', async () => {
    const { client, paths } = recordingClient();
    const result = await syncHousehold(env, USER, HH, client, T0);

    expect(result.subscribed).toBe(3);
    expect(paths).toEqual([
      'POST /households/HH_1/groups/subscription',
      'GET /households/HH_1/groups',
      'POST /groups/G1/playback/subscription',
      'POST /groups/G1/playbackMetadata/subscription'
    ]);
  });

  // The regression that matters most in this file. Subscribing a household's `groups`
  // namespace makes Sonos deliver a groups event; doing that inside the handler for a
  // groups event is a loop that ran to 993 requests in 35 seconds against a quota of
  // 1,000/min shared by every user of the application.
  it('never re-subscribes the household namespace while handling a groups event', async () => {
    await syncHousehold(env, USER, HH, recordingClient().client, T0);

    const { client, paths } = recordingClient();
    await syncHousehold(env, USER, HH, client, T0 + MIN_TOPOLOGY_SYNC_INTERVAL_MS, {
      subscribeHousehold: false,
      onlyMissing: true,
      knownGroups: [{ id: 'G1', name: 'Den' }]
    });

    expect(paths.some((p) => p.includes('/groups/subscription'))).toBe(false);
  });

  it('spends no Sonos requests when a groups event changes nothing', async () => {
    await syncHousehold(env, USER, HH, recordingClient().client, T0);

    const { client, paths } = recordingClient();
    const result = await syncHousehold(env, USER, HH, client, T0 + MIN_TOPOLOGY_SYNC_INTERVAL_MS, {
      subscribeHousehold: false,
      onlyMissing: true,
      knownGroups: [{ id: 'G1', name: 'Den' }]
    });

    // The event body carried the topology and G1 already holds both subscriptions, so
    // there is nothing to ask Sonos for.
    expect(paths).toEqual([]);
    expect(result.callsUsed).toBe(0);
  });

  it('subscribes only the group that is genuinely new', async () => {
    await syncHousehold(env, USER, HH, recordingClient().client, T0);

    const { client, paths } = recordingClient();
    await syncHousehold(env, USER, HH, client, T0 + MIN_TOPOLOGY_SYNC_INTERVAL_MS, {
      subscribeHousehold: false,
      onlyMissing: true,
      knownGroups: [
        { id: 'G1', name: 'Den' },
        { id: 'G2', name: 'Kitchen' }
      ]
    });

    expect(paths).toEqual([
      'POST /groups/G2/playback/subscription',
      'POST /groups/G2/playbackMetadata/subscription'
    ]);
  });

  it('throttles a second sync inside the interval floor', async () => {
    await syncHousehold(env, USER, HH, recordingClient().client, T0);

    const { client, paths } = recordingClient();
    const result = await syncHousehold(env, USER, HH, client, T0 + 1_000);

    expect(result.throttled).toBe(true);
    expect(paths).toEqual([]);
  });

  it('lets a user-initiated resync through the floor', async () => {
    await syncHousehold(env, USER, HH, recordingClient().client, T0);

    const { client, paths } = recordingClient();
    const result = await syncHousehold(env, USER, HH, client, T0 + 1_000, { force: true });

    expect(result.throttled).toBe(false);
    expect(paths.length).toBeGreaterThan(0);
  });
});
