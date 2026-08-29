import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LastfmError, type LastfmClient, type ScrobbleTrack } from './lastfm-client.js';
import { ScrobbleQueue, scrobbleKey, type QueueStorage } from './queue.js';

const track = (overrides: Partial<ScrobbleTrack> = {}): ScrobbleTrack => ({
  artist: 'Radiohead',
  track: 'Weird Fishes / Arpeggi',
  album: 'In Rainbows',
  timestamp: 1_700_000_000,
  durationSeconds: 300,
  ...overrides
});

function memoryStorage(): QueueStorage & { contents: string | undefined } {
  return {
    contents: undefined as string | undefined,
    async read() {
      return this.contents;
    },
    async write(value: string) {
      this.contents = value;
    }
  };
}

function fakeClient(overrides: Partial<LastfmClient> = {}): LastfmClient {
  return {
    hasSession: true,
    scrobble: vi.fn().mockResolvedValue({ accepted: 1, ignored: 0, ignoredReasons: [] }),
    ...overrides
  } as unknown as LastfmClient;
}

let now = 1_700_000_000_000;
beforeEach(() => {
  now = 1_700_000_000_000;
});
const clock = () => now;

describe('scrobbleKey', () => {
  it('distinguishes two listens of the same song', () => {
    expect(scrobbleKey(track())).not.toBe(scrobbleKey(track({ timestamp: 1_700_000_500 })));
  });

  it('matches the same play regardless of capitalisation', () => {
    expect(scrobbleKey(track({ artist: 'RADIOHEAD' }))).toBe(scrobbleKey(track()));
  });
});

describe('ScrobbleQueue', () => {
  it('sends a queued scrobble and empties the queue', async () => {
    const client = fakeClient();
    const queue = new ScrobbleQueue(client, { now: clock, storage: memoryStorage() });
    await queue.add(track());
    expect(queue.size).toBe(1);

    const outcome = await queue.flush();
    expect(outcome).toEqual({ status: 'sent', accepted: 1, ignored: 0 });
    expect(queue.size).toBe(0);
  });

  it('reports idle with nothing queued', async () => {
    const queue = new ScrobbleQueue(fakeClient(), { now: clock, storage: memoryStorage() });
    expect(await queue.flush()).toEqual({ status: 'idle' });
  });

  it('refuses a duplicate of a play already queued', async () => {
    const queue = new ScrobbleQueue(fakeClient(), { now: clock, storage: memoryStorage() });
    expect(await queue.add(track())).toBe(true);
    expect(await queue.add(track())).toBe(false);
    expect(queue.size).toBe(1);
  });

  it('refuses a duplicate of a play already accepted', async () => {
    // Guards against a retry, or a Sonos-side scrobble, doubling the play.
    const queue = new ScrobbleQueue(fakeClient(), { now: clock, storage: memoryStorage() });
    await queue.add(track());
    await queue.flush();
    expect(await queue.add(track())).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('batches at most fifty per request', async () => {
    const scrobble = vi.fn().mockResolvedValue({ accepted: 50, ignored: 0, ignoredReasons: [] });
    const queue = new ScrobbleQueue(fakeClient({ scrobble } as never), {
      now: clock,
      storage: memoryStorage()
    });
    for (let index = 0; index < 60; index += 1) {
      await queue.add(track({ timestamp: 1_700_000_000 + index }));
    }
    await queue.flush();
    expect(scrobble).toHaveBeenCalledOnce();
    expect(scrobble.mock.calls[0]![0]).toHaveLength(50);
    expect(queue.size).toBe(10);
  });

  it('keeps a scrobble queued when Last.fm is unreachable, and backs off', async () => {
    const scrobble = vi
      .fn()
      .mockRejectedValue(new LastfmError('Could not reach Last.fm', undefined, 'retry'));
    const queue = new ScrobbleQueue(fakeClient({ scrobble } as never), {
      now: clock,
      storage: memoryStorage()
    });
    await queue.add(track());

    const first = await queue.flush();
    expect(first.status).toBe('retry');
    expect(queue.size).toBe(1);

    // A second attempt before the backoff expires must not hit the network again.
    expect((await queue.flush()).status).toBe('retry');
    expect(scrobble).toHaveBeenCalledOnce();

    // Once the delay has passed it retries, and succeeds.
    now = queue.retryAtMs;
    scrobble.mockResolvedValue({ accepted: 1, ignored: 0, ignoredReasons: [] });
    expect((await queue.flush()).status).toBe('sent');
    expect(queue.size).toBe(0);
  });

  it('lengthens the delay on repeated failures', async () => {
    const scrobble = vi.fn().mockRejectedValue(new LastfmError('down', 11, 'retry'));
    const queue = new ScrobbleQueue(fakeClient({ scrobble } as never), {
      now: clock,
      storage: memoryStorage()
    });
    await queue.add(track());

    await queue.flush();
    const firstDelay = queue.retryAtMs - now;
    now = queue.retryAtMs;
    await queue.flush();
    const secondDelay = queue.retryAtMs - now;
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it('keeps plays queued when the session is rejected, so nothing is lost', async () => {
    const scrobble = vi
      .fn()
      .mockRejectedValue(new LastfmError('Invalid session key', 9, 'reauthorize'));
    const queue = new ScrobbleQueue(fakeClient({ scrobble } as never), {
      now: clock,
      storage: memoryStorage()
    });
    await queue.add(track());
    const outcome = await queue.flush();
    expect(outcome.status).toBe('reauthorize');
    // The user reconnects and the play is still waiting.
    expect(queue.size).toBe(1);
  });

  it('asks for authorization rather than calling with no session', async () => {
    const scrobble = vi.fn();
    const queue = new ScrobbleQueue(fakeClient({ hasSession: false, scrobble } as never), {
      now: clock,
      storage: memoryStorage()
    });
    await queue.add(track());
    expect((await queue.flush()).status).toBe('reauthorize');
    expect(scrobble).not.toHaveBeenCalled();
  });

  it('isolates a malformed play rather than discarding the batch around it', async () => {
    // Last.fm rejects the whole request without naming the bad entry, so the queue
    // must narrow down to it instead of throwing away the good plays alongside it.
    const bad = track({ artist: 'bad', timestamp: 1_700_000_000 });
    const good = track({ timestamp: 1_700_000_400 });
    const scrobble = vi.fn(async (batch: readonly ScrobbleTrack[]) => {
      if (batch.some((entry) => entry.artist === 'bad')) {
        throw new LastfmError('Invalid parameters', 6, 'drop');
      }
      return { accepted: batch.length, ignored: 0, ignoredReasons: [] };
    });
    const queue = new ScrobbleQueue(fakeClient({ scrobble } as never), {
      now: clock,
      storage: memoryStorage()
    });
    await queue.add(bad);
    await queue.add(good);

    // First attempt covers both and is rejected; the queue narrows rather than drops.
    expect((await queue.flush()).status).toBe('retry');
    expect(queue.size).toBe(2);

    // Now the bad play is alone in its batch and can safely be discarded.
    expect(await queue.flush()).toEqual({ status: 'sent', accepted: 0, ignored: 1 });
    expect(queue.size).toBe(1);

    // The good play still goes through.
    expect((await queue.flush()).status).toBe('sent');
    expect(queue.size).toBe(0);
    expect(scrobble.mock.calls.at(-1)![0]).toEqual([good]);
  });

  it('survives a restart with plays still queued', async () => {
    const storage = memoryStorage();
    const failing = vi.fn().mockRejectedValue(new LastfmError('offline', undefined, 'retry'));
    const first = new ScrobbleQueue(fakeClient({ scrobble: failing } as never), {
      now: clock,
      storage
    });
    await first.add(track());
    await first.flush();

    // The app quits and restarts against the same file.
    const scrobble = vi.fn().mockResolvedValue({ accepted: 1, ignored: 0, ignoredReasons: [] });
    const second = new ScrobbleQueue(fakeClient({ scrobble } as never), { now: clock, storage });
    await second.initialize();
    expect(second.size).toBe(1);
    expect((await second.flush()).status).toBe('sent');
    expect(scrobble.mock.calls[0]![0][0]).toMatchObject({ track: 'Weird Fishes / Arpeggi' });
  });

  it('remembers accepted plays across a restart so none is sent twice', async () => {
    const storage = memoryStorage();
    const first = new ScrobbleQueue(fakeClient(), { now: clock, storage });
    await first.add(track());
    await first.flush();

    const second = new ScrobbleQueue(fakeClient(), { now: clock, storage });
    await second.initialize();
    expect(await second.add(track())).toBe(false);
  });

  it('starts clean when the queue file is corrupt', async () => {
    const storage = memoryStorage();
    storage.contents = '{ this is not json';
    const queue = new ScrobbleQueue(fakeClient(), { now: clock, storage });
    await queue.initialize();
    expect(queue.size).toBe(0);
    expect(await queue.add(track())).toBe(true);
  });

  it('ignores malformed entries in an otherwise readable file', async () => {
    const storage = memoryStorage();
    storage.contents = JSON.stringify({
      pending: [track(), { artist: 'x' }, null, { artist: 'y', track: 'z', timestamp: 'soon' }],
      accepted: []
    });
    const queue = new ScrobbleQueue(fakeClient(), { now: clock, storage });
    await queue.initialize();
    expect(queue.size).toBe(1);
  });

  it('keeps flushing when the disk write fails', async () => {
    // Losing the on-disk copy must not stop the play reaching Last.fm.
    const storage: QueueStorage = {
      read: async () => undefined,
      write: async () => {
        throw new Error('read-only volume');
      }
    };
    const queue = new ScrobbleQueue(fakeClient(), { now: clock, storage });
    await queue.add(track());
    expect((await queue.flush()).status).toBe('sent');
  });
});
