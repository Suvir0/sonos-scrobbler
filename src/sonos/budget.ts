/**
 * A self-imposed ceiling on outbound Sonos requests.
 *
 * Sonos allows 1,000 requests per minute **per application** — not per user. Every
 * household on this service draws from one shared allowance, so a bug affecting one
 * account can starve every other account. That is not hypothetical: a subscribe/event
 * feedback loop reached 993 requests in 35 seconds during the first live test, and the
 * only thing that stopped it was Sonos starting to refuse.
 *
 * Relying on the vendor's limit as the brake means discovering our own runaways by
 * tripping a limit that punishes our users. This is the brake we control:
 *
 *  - A rolling one-second and one-minute count, kept well under the published figures.
 *  - Refusal *before* the request goes out, so a runaway costs a rejected promise
 *    rather than a slice of the shared allowance.
 *  - A per-caller tag, so the logs say which subsystem is spending the budget.
 *
 * Deliberately conservative: the ceilings below are a fraction of what Sonos permits,
 * because the cost of being slightly slow is a delayed scrobble, and the cost of being
 * unbounded is every user's scrobbling stopping at once.
 */

/** Published Sonos limits, for reference. Ours sit deliberately below these. */
export const SONOS_QUOTA_PER_MINUTE = 1_000;
export const SONOS_SPIKE_ARREST_PER_SECOND = 100;

/** Our ceiling: 60% of the published per-minute allowance. */
export const BUDGET_PER_MINUTE = 600;

/** Our ceiling: a fifth of the spike arrest, leaving headroom for live event traffic. */
export const BUDGET_PER_SECOND = 20;

export class BudgetExceededError extends Error {
  constructor(
    readonly window: 'second' | 'minute',
    readonly tag: string,
    readonly count: number
  ) {
    super(
      `Sonos request budget exhausted (${count} in the last ${window}, tag "${tag}"). ` +
        'Refused locally rather than spending the application-wide quota.'
    );
    this.name = 'BudgetExceededError';
  }
}

interface Bucket {
  /** Request timestamps, newest last. Trimmed to the last minute on every check. */
  times: number[];
}

/**
 * An in-isolate rolling counter.
 *
 * Per-isolate rather than globally coordinated, deliberately. A globally accurate
 * counter would need a Durable Object round trip on every single API call, which costs
 * more than it saves; Workers concentrates a given Worker's traffic in few enough
 * isolates that a per-isolate ceiling this far below the real limit still bounds the
 * total. The goal is stopping runaways, not precise accounting.
 */
export class RequestBudget {
  private readonly bucket: Bucket = { times: [] };

  constructor(
    private readonly perSecond = BUDGET_PER_SECOND,
    private readonly perMinute = BUDGET_PER_MINUTE
  ) {}

  /** Records a request, or throws if it would breach a ceiling. */
  take(nowMs: number, tag = 'sonos'): void {
    const times = this.bucket.times;
    // Drop anything older than the widest window before counting.
    const cutoff = nowMs - 60_000;
    let firstLive = 0;
    while (firstLive < times.length && times[firstLive]! < cutoff) firstLive += 1;
    if (firstLive > 0) times.splice(0, firstLive);

    if (times.length >= this.perMinute) {
      throw new BudgetExceededError('minute', tag, times.length);
    }

    let inLastSecond = 0;
    for (let i = times.length - 1; i >= 0; i -= 1) {
      if (times[i]! < nowMs - 1_000) break;
      inLastSecond += 1;
    }
    if (inLastSecond >= this.perSecond) {
      throw new BudgetExceededError('second', tag, inLastSecond);
    }

    times.push(nowMs);
  }

  /** Requests recorded in the last minute. For logging and the status page. */
  usage(nowMs: number): { lastSecond: number; lastMinute: number } {
    const times = this.bucket.times;
    let lastMinute = 0;
    let lastSecond = 0;
    for (let i = times.length - 1; i >= 0; i -= 1) {
      const at = times[i]!;
      if (at < nowMs - 60_000) break;
      lastMinute += 1;
      if (at >= nowMs - 1_000) lastSecond += 1;
    }
    return { lastSecond, lastMinute };
  }
}

/**
 * One budget shared by every Sonos client in this isolate.
 *
 * Module scope on purpose: a per-client budget would be no bound at all, since the
 * runaway that motivated this created a fresh client on each pass of the loop.
 */
export const sonosBudget = new RequestBudget();
