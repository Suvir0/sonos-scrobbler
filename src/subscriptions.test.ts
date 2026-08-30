import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { RequestBudget } from './sonos/budget.js';
import { SonosClient } from './sonos/client.js';
import { applySchema, resetTables } from './testing/schema.js';
import {
  MIN_TOPOLOGY_SYNC_INTERVAL_MS,
  RETRY_BASE_MS,
  retryDelayMs,
  subscriptionId,
  syncHousehold
} from './subscriptions.js';

const USER = 'u1';
const HH = 'HH_1';
const T0 = 1_800_000_000_000;

/** A client whose every subscribe attempt fails, to exercise the failure path. */
function failingClient(groups: readonly { id: string; name?: string }[]) {
  return new SonosClient({
    baseUrl: 'https://api.ws.sonos.com/control/api/v1',
    accessToken: async () => 'token',
    budget: new RequestBudget(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ groups }), { status: 200 });
      }
      return new Response('nope', { status: 500 });
    }) as typeof fetch
  });
}

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

/** A client that reports a topology of two rooms in one group. */
function topologyClient() {
  return new SonosClient({
    baseUrl: 'https://api.ws.sonos.com/control/api/v1',
    accessToken: async () => 'token',
    budget: new RequestBudget(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            groups: [{ id: 'G1', name: 'Den + 1', playerIds: ['P_DEN', 'P_KITCHEN'] }],
            players: [
              { id: 'P_DEN', name: 'Den' },
              { id: 'P_KITCHEN', name: 'Kitchen' }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch
  });
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

  // The starvation bug. `renewDue` takes the hundred rows with the earliest
  // `next_renewal_at`, so a row whose failed subscribe leaves that column untouched is
  // reselected every fifteen minutes forever — spending a request each time and, once
  // there are enough of them, filling the slice ahead of rows that would have renewed.
  it('backs a failed subscribe off instead of leaving it due', async () => {
    // Establish the rows first, so there is something to update.
    await syncHousehold(env, USER, HH, recordingClient().client, T0);

    const id = subscriptionId('group', 'G1', 'playback');
    await syncHousehold(env, USER, HH, failingClient([{ id: 'G1', name: 'Den' }]), T0 + 60_000, {
      force: true
    });

    const row = await env.DB.prepare(
      'SELECT failure_count, next_renewal_at, last_error FROM subscriptions WHERE id = ?'
    )
      .bind(id)
      .first<{ failure_count: number; next_renewal_at: number; last_error: string | null }>();

    expect(row?.failure_count).toBe(1);
    expect(row?.last_error).toContain('500');
    expect(row?.next_renewal_at).toBe(T0 + 60_000 + RETRY_BASE_MS);
  });

  // And the backoff has to grow, or "keeps retrying" becomes "retries twelve times an
  // hour forever" for a subscription that will never succeed.
  it('doubles the backoff on each successive failure', async () => {
    await syncHousehold(env, USER, HH, recordingClient().client, T0);
    const id = subscriptionId('group', 'G1', 'playback');

    await syncHousehold(env, USER, HH, failingClient([{ id: 'G1' }]), T0 + 60_000, {
      force: true
    });
    await syncHousehold(env, USER, HH, failingClient([{ id: 'G1' }]), T0 + 120_000, {
      force: true
    });

    const row = await env.DB.prepare(
      'SELECT failure_count, next_renewal_at FROM subscriptions WHERE id = ?'
    )
      .bind(id)
      .first<{ failure_count: number; next_renewal_at: number }>();

    expect(row?.failure_count).toBe(2);
    // Second failure, so the delay is computed from a stored count of 1.
    expect(row?.next_renewal_at).toBe(T0 + 120_000 + retryDelayMs(1));
  });

  // Two subscribes per group and no internal ceiling meant one large household could
  // spend the entire run's budget and then keep going, against a quota shared with the
  // live webhook path.
  it('stops inside a household once its call budget is spent', async () => {
    const groups = Array.from({ length: 20 }, (_, index) => ({ id: `G${index}` }));
    const { client, paths } = recordingClient();

    const result = await syncHousehold(env, USER, HH, client, T0, {
      subscribeHousehold: false,
      knownGroups: groups,
      callBudget: 6
    });

    expect(result.budgetExhausted).toBe(true);
    // Three groups at two subscribes each, then the check refuses the fourth.
    expect(paths.length).toBe(6);
    expect(result.groupsSeen).toBe(20);
  });
});

describe('recording the topology', () => {
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

  it('records every room, so there is something to switch off', async () => {
    await syncHousehold(env, USER, HH, topologyClient(), T0);

    const rows = await env.DB.prepare(
      'SELECT player_id, name, scrobble FROM sonos_players WHERE user_id = ? ORDER BY player_id'
    )
      .bind(USER)
      .all<{ player_id: string; name: string; scrobble: number }>();

    expect(rows.results).toEqual([
      { player_id: 'P_DEN', name: 'Den', scrobble: 1 },
      { player_id: 'P_KITCHEN', name: 'Kitchen', scrobble: 1 }
    ]);
  });

  it('records which rooms are in each group', async () => {
    await syncHousehold(env, USER, HH, topologyClient(), T0);

    const row = await env.DB.prepare('SELECT player_ids FROM sonos_groups WHERE group_id = ?')
      .bind('G1')
      .first<{ player_ids: string }>();

    expect(JSON.parse(row!.player_ids)).toEqual(['P_DEN', 'P_KITCHEN']);
  });

  // The column a person set by hand. A re-sync renames rooms and refreshes timestamps;
  // it must never quietly switch a room back on.
  it('leaves a switched-off room switched off across a re-sync', async () => {
    await syncHousehold(env, USER, HH, topologyClient(), T0);
    await env.DB.prepare('UPDATE sonos_players SET scrobble = 0 WHERE player_id = ?')
      .bind('P_DEN')
      .run();

    await syncHousehold(
      env,
      USER,
      HH,
      topologyClient(),
      T0 + MIN_TOPOLOGY_SYNC_INTERVAL_MS + 1
    );

    const row = await env.DB.prepare('SELECT scrobble FROM sonos_players WHERE player_id = ?')
      .bind('P_DEN')
      .first<{ scrobble: number }>();
    expect(row?.scrobble).toBe(0);
  });

  // A groups event carries the topology, so the sync must take it from there rather
  // than spend a request re-fetching what it was just handed.
  it('takes the rooms from an event payload without calling Sonos', async () => {
    const { client, paths } = recordingClient();
    await syncHousehold(env, USER, HH, client, T0, {
      subscribeHousehold: false,
      knownGroups: [{ id: 'G9', name: 'Loft', playerIds: ['P_LOFT'] }],
      knownPlayers: [{ id: 'P_LOFT', name: 'Loft' }]
    });

    expect(paths.some((path) => path.startsWith('GET'))).toBe(false);
    const row = await env.DB.prepare('SELECT name FROM sonos_players WHERE player_id = ?')
      .bind('P_LOFT')
      .first<{ name: string }>();
    expect(row?.name).toBe('Loft');
  });

  // A payload that omits membership must not erase what we already knew, because an
  // unknown membership is treated as permitted and would silently start scrobbling a
  // room somebody had switched off.
  it('keeps a known group membership when a later payload omits it', async () => {
    await syncHousehold(env, USER, HH, topologyClient(), T0);

    await syncHousehold(env, USER, HH, recordingClient().client, T0 + 1, {
      force: true,
      subscribeHousehold: false,
      knownGroups: [{ id: 'G1', name: 'Den + 1' }]
    });

    const row = await env.DB.prepare('SELECT player_ids FROM sonos_groups WHERE group_id = ?')
      .bind('G1')
      .first<{ player_ids: string }>();
    expect(JSON.parse(row!.player_ids)).toEqual(['P_DEN', 'P_KITCHEN']);
  });
});
