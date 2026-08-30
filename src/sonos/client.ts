/**
 * The Sonos cloud Control API client.
 *
 * Only the read and subscribe surface is used. This service never sends a playback
 * command — it observes. That is deliberate: the OAuth scope grants full control
 * because Sonos offers no narrower one, so the restraint has to live here.
 *
 * Two operational facts shape this file:
 *  - The app-wide quota is 1,000 requests/minute with a 100/second spike arrest,
 *    shared across every user. `SonosApiError.isRateLimited` exists so callers can
 *    back off rather than burn the budget for everyone.
 *  - Access tokens last 24h, so a 401 mid-flight is expected rather than exceptional
 *    and is retried once against a freshly refreshed token.
 */

import { USER_AGENT } from '../lib/identity.js';
import { sonosBudget, type RequestBudget } from './budget.js';
import type { GroupsStatus, MetadataStatus, PlaybackStatus, SonosHousehold } from './types.js';

export class SonosApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string
  ) {
    super(message);
    this.name = 'SonosApiError';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** Whether the grant is gone for good, meaning the user must reauthorize. */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** A group that no longer exists. Routine — groups are torn down constantly. */
  get isGone(): boolean {
    return this.status === 404 || this.status === 410;
  }
}

export interface SonosClientOptions {
  baseUrl: string;
  /** Returns a valid access token, refreshing it if required. */
  accessToken(options?: { force?: boolean }): Promise<string>;
  fetch?: typeof fetch;
  /** Defaults to the isolate-wide budget. Injectable so tests get a clean one. */
  budget?: RequestBudget;
  /** Names the caller in budget errors, so logs say which subsystem overspent. */
  tag?: string;
}

export class SonosClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SonosClientOptions) {
    // Wrapped rather than assigned directly. `this.fetchImpl = fetch` followed by
    // `this.fetchImpl(...)` invokes the global fetch with `this` bound to this
    // instance, which the Workers runtime rejects outright:
    //   "TypeError: Illegal invocation: function called with incorrect `this` reference"
    // The arrow keeps the call unbound. This is the same shape the Last.fm and
    // ListenBrainz clients already use, for the same reason.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(path: string, init: RequestInit = {}, retrying = false): Promise<T> {
    // Before the token, before the network: a refused request must cost nothing. The
    // quota is application-wide, so an unbounded caller starves every other user.
    (this.options.budget ?? sonosBudget).take(Date.now(), this.options.tag ?? 'sonos');

    const token = await this.options.accessToken(retrying ? { force: true } : undefined);
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT
      }
    });

    if (response.status === 401 && !retrying) {
      // The token expired mid-flight. One forced refresh, one retry, then give up —
      // a loop here would multiply into the shared rate limit.
      return this.request<T>(path, init, true);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Status and body go in the message, not just on the error object: these surface
      // through report strings and logs where only `message` survives, and "failed"
      // with no status is unactionable.
      throw new SonosApiError(
        `Sonos ${init.method ?? 'GET'} ${path} -> ${response.status} ${body.slice(0, 300)}`,
        response.status,
        body
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async getHouseholds(): Promise<SonosHousehold[]> {
    const result = await this.request<{ households?: SonosHousehold[] }>('/households');
    return result.households ?? [];
  }

  async getGroups(householdId: string): Promise<GroupsStatus> {
    return this.request<GroupsStatus>(`/households/${encodeURIComponent(householdId)}/groups`);
  }

  async getMetadataStatus(groupId: string): Promise<MetadataStatus> {
    return this.request<MetadataStatus>(
      `/groups/${encodeURIComponent(groupId)}/playbackMetadata`
    );
  }

  async getPlaybackStatus(groupId: string): Promise<PlaybackStatus> {
    return this.request<PlaybackStatus>(`/groups/${encodeURIComponent(groupId)}/playback`);
  }

  /* --------------------------------------------------------- subscriptions */

  /**
   * The household-level anchor. Subscribing here is what tells us when groups appear
   * and disappear, which is the only reliable way to keep per-group subscriptions
   * pointed at groups that actually exist.
   */
  async subscribeGroups(householdId: string): Promise<void> {
    await this.request<void>(
      `/households/${encodeURIComponent(householdId)}/groups/subscription`,
      { method: 'POST' }
    );
  }

  /** Playback state and position. Group-scoped — there is no household-level form. */
  async subscribePlayback(groupId: string): Promise<void> {
    await this.request<void>(`/groups/${encodeURIComponent(groupId)}/playback/subscription`, {
      method: 'POST'
    });
  }

  /** Track metadata. Also group-scoped. */
  async subscribePlaybackMetadata(groupId: string): Promise<void> {
    await this.request<void>(
      `/groups/${encodeURIComponent(groupId)}/playbackMetadata/subscription`,
      { method: 'POST' }
    );
  }

  async unsubscribeGroups(householdId: string): Promise<void> {
    await this.request<void>(
      `/households/${encodeURIComponent(householdId)}/groups/subscription`,
      { method: 'DELETE' }
    );
  }

  async unsubscribePlayback(groupId: string): Promise<void> {
    await this.request<void>(`/groups/${encodeURIComponent(groupId)}/playback/subscription`, {
      method: 'DELETE'
    });
  }

  async unsubscribePlaybackMetadata(groupId: string): Promise<void> {
    await this.request<void>(
      `/groups/${encodeURIComponent(groupId)}/playbackMetadata/subscription`,
      { method: 'DELETE' }
    );
  }
}
