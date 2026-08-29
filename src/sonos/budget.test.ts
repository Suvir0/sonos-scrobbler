import { describe, expect, it } from 'vitest';
import {
  BUDGET_PER_MINUTE,
  BUDGET_PER_SECOND,
  BudgetExceededError,
  RequestBudget,
  SONOS_QUOTA_PER_MINUTE,
  SONOS_SPIKE_ARREST_PER_SECOND
} from './budget.js';

const T0 = 1_800_000_000_000;

describe('RequestBudget', () => {
  it('stays below the limits Sonos actually publishes', () => {
    // The whole point is to refuse before the vendor does. If these ever cross, the
    // brake stops being ours and the failure lands on every user of the application.
    expect(BUDGET_PER_MINUTE).toBeLessThan(SONOS_QUOTA_PER_MINUTE);
    expect(BUDGET_PER_SECOND).toBeLessThan(SONOS_SPIKE_ARREST_PER_SECOND);
  });

  it('allows traffic under the ceiling', () => {
    const budget = new RequestBudget(5, 100);
    for (let i = 0; i < 4; i += 1) budget.take(T0 + i);
    expect(budget.usage(T0).lastSecond).toBe(4);
  });

  it('refuses a burst past the per-second ceiling', () => {
    const budget = new RequestBudget(5, 100);
    for (let i = 0; i < 5; i += 1) budget.take(T0);
    expect(() => budget.take(T0)).toThrow(BudgetExceededError);
  });

  it('recovers once the second rolls over', () => {
    const budget = new RequestBudget(5, 100);
    for (let i = 0; i < 5; i += 1) budget.take(T0);
    expect(() => budget.take(T0)).toThrow();
    expect(() => budget.take(T0 + 1_001)).not.toThrow();
  });

  it('refuses sustained traffic past the per-minute ceiling', () => {
    // The shape of the real runaway: modest per second, ruinous per minute.
    const budget = new RequestBudget(1_000, 60);
    for (let i = 0; i < 60; i += 1) budget.take(T0 + i * 500);
    expect(() => budget.take(T0 + 30_000)).toThrow(/last minute/);
  });

  it('recovers once the minute rolls over', () => {
    const budget = new RequestBudget(1_000, 10);
    for (let i = 0; i < 10; i += 1) budget.take(T0 + i);
    expect(() => budget.take(T0 + 100)).toThrow();
    expect(() => budget.take(T0 + 60_001)).not.toThrow();
  });

  it('would have stopped the production runaway well before the vendor did', () => {
    // 993 requests in 35 seconds is what actually happened. Replayed against our own
    // ceilings it is refused after a fraction of that.
    const budget = new RequestBudget();
    let allowed = 0;
    try {
      for (let i = 0; i < 993; i += 1) budget.take(T0 + Math.floor(i * 35_000 / 993));
      allowed = 993;
    } catch {
      // Expected.
    }
    expect(allowed).toBe(0);
    expect(budget.usage(T0 + 35_000).lastMinute).toBeLessThanOrEqual(BUDGET_PER_MINUTE);
  });

  it('names the subsystem that overspent', () => {
    const budget = new RequestBudget(1, 10);
    budget.take(T0, 'renewal-cron');
    expect(() => budget.take(T0, 'renewal-cron')).toThrow(/renewal-cron/);
  });
});
