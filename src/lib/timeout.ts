/**
 * Bounding an outbound request without holding the invocation open.
 *
 * `AbortSignal.timeout(ms)` is the obvious way to write this and is the wrong way inside
 * a Durable Object. The timer it creates is pending work: the runtime keeps the
 * invocation alive until it fires, so a request that actually completed in 200ms still
 * held the object open for the full timeout. Production showed this plainly — every
 * Last.fm-facing call measured 14.8–15.4s of wall time against under 7ms of CPU, sitting
 * exactly on the client's 15s ceiling, while the calls themselves were succeeding.
 *
 * That is not merely untidy. `UserQueue` serializes its work, so fifteen seconds of
 * phantom occupancy per scrobble is inherited by whatever queues behind it, and two
 * tracks changing inside that window now wait on a timer for a request that finished
 * long ago.
 *
 * An explicit controller fixes it: the timer is cleared the moment the work settles,
 * whichever way it settles.
 */

/**
 * Runs `work` with a signal that aborts after `timeoutMs`, always clearing the timer.
 *
 * The timeout covers everything `work` awaits, so a caller that needs the response body
 * guarded should read it inside `work` rather than after this returns.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
