/**
 * That the timeout timer is cleared, not left pending.
 *
 * This is the whole point of the file under test, and it is invisible in ordinary
 * assertions: `AbortSignal.timeout` produces exactly the same return values and exactly
 * the same abort behaviour, and differs only in leaving a timer outstanding. In a Durable
 * Object that difference is fifteen seconds of wall time on every successful call, which
 * is what production actually showed.
 */

import { describe, expect, it, vi } from 'vitest';
import { withTimeout } from './timeout.js';

describe('withTimeout', () => {
  it('clears the timer as soon as the work resolves', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const before = clear.mock.calls.length;

    await withTimeout(15_000, async () => 'done');

    expect(clear.mock.calls.length).toBeGreaterThan(before);
    clear.mockRestore();
  });

  it('clears the timer when the work throws', async () => {
    // A failure path that leaked the timer would hold the object open for the full
    // timeout on every network error, which is when it can least afford to.
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const before = clear.mock.calls.length;

    await expect(
      withTimeout(15_000, async () => {
        throw new Error('offline');
      })
    ).rejects.toThrow('offline');

    expect(clear.mock.calls.length).toBeGreaterThan(before);
    clear.mockRestore();
  });

  it('aborts the signal it hands out once the deadline passes', async () => {
    // The timeout still has to do its job: a hung request must not wait forever.
    const aborted = await withTimeout(1, async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return signal.aborted;
    });
    expect(aborted).toBe(true);
  });

  it('leaves the signal untouched when the work finishes first', async () => {
    const signal = await withTimeout(10_000, async (s) => s);
    expect(signal.aborted).toBe(false);
  });
});
