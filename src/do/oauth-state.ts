/**
 * Single-use OAuth state.
 *
 * A DO keyed by the hash of the state value, rather than a D1 row, for one reason:
 * `consume` has to be atomic. Two simultaneous callbacks carrying the same state must
 * not both succeed, and a read-then-delete against an eventually-consistent store
 * cannot promise that. The DO's serialized execution can.
 *
 * State expires in ten minutes, which is far longer than a login takes and far shorter
 * than a captured URL stays useful.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface OAuthStatePayload {
  /** Where to send the user once linking succeeds. */
  returnTo?: string;
  /** The signed-in user this link belongs to, when there already is one. */
  userId?: string;
  createdAtMs: number;
}

export class OAuthState extends DurableObject<Env> {
  async issue(payload: OAuthStatePayload): Promise<void> {
    await this.ctx.storage.put('payload', payload);
    // A self-cleaning record: without this an abandoned login would sit in storage
    // forever, and there is no cron that would ever look for it.
    await this.ctx.storage.setAlarm(payload.createdAtMs + OAUTH_STATE_TTL_MS);
  }

  /** Returns the payload exactly once. A replay gets undefined. */
  async consume(nowMs: number): Promise<OAuthStatePayload | undefined> {
    const payload = await this.ctx.storage.get<OAuthStatePayload>('payload');
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    if (!payload) return undefined;
    if (nowMs - payload.createdAtMs > OAUTH_STATE_TTL_MS) return undefined;
    return payload;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
