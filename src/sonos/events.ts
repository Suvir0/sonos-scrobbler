/**
 * Receiving and trusting Sonos webhooks.
 *
 * Two things make this harder than a typical webhook:
 *
 * 1. **Sonos does not retry meaningfully.** A failed delivery is retried once a second
 *    three times and then discarded permanently — no replay, no dead-letter queue. A
 *    slow handler is a lost scrobble, silently. So parsing here is total: every field
 *    is optional and a malformed event is dropped rather than thrown.
 *
 * 2. **The signature does not cover the body.** It is a digest of five headers plus
 *    the client credentials, so it proves the sender knows the secret but says nothing
 *    about the payload. On its own it does not stop a captured request being replayed
 *    with a different body, which is why `isFreshSequence` exists and why callers must
 *    persist the last sequence id per subscription.
 */

import { sonosEventSignature, timingSafeEqual } from '../lib/crypto.js';
import type { SonosNamespace } from './types.js';

export interface SonosEventHeaders {
  seqId: string;
  namespace: string;
  type: string;
  targetType: string;
  targetValue: string;
  signature: string;
  householdId?: string;
}

export const SONOS_EVENT_HEADERS = {
  seqId: 'x-sonos-event-seq-id',
  namespace: 'x-sonos-namespace',
  type: 'x-sonos-type',
  targetType: 'x-sonos-target-type',
  targetValue: 'x-sonos-target-value',
  signature: 'x-sonos-event-signature',
  householdId: 'x-sonos-household-id'
} as const;

/** Pulls the event headers, or undefined if any required one is missing. */
export function readEventHeaders(request: Request): SonosEventHeaders | undefined {
  const get = (name: string): string | undefined => request.headers.get(name) ?? undefined;
  const seqId = get(SONOS_EVENT_HEADERS.seqId);
  const namespace = get(SONOS_EVENT_HEADERS.namespace);
  const type = get(SONOS_EVENT_HEADERS.type);
  const targetType = get(SONOS_EVENT_HEADERS.targetType);
  const targetValue = get(SONOS_EVENT_HEADERS.targetValue);
  const signature = get(SONOS_EVENT_HEADERS.signature);
  if (!seqId || !namespace || !type || !targetType || !targetValue || !signature) return undefined;

  const headers: SonosEventHeaders = {
    seqId,
    namespace,
    type,
    targetType,
    targetValue,
    signature
  };
  const householdId = get(SONOS_EVENT_HEADERS.householdId);
  if (householdId) headers.householdId = householdId;
  return headers;
}

export async function verifySignature(
  headers: SonosEventHeaders,
  credentials: { clientId: string; clientSecret: string }
): Promise<boolean> {
  const expected = await sonosEventSignature({
    seqId: headers.seqId,
    namespace: headers.namespace,
    type: headers.type,
    targetType: headers.targetType,
    targetValue: headers.targetValue,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret
  });
  return timingSafeEqual(expected, headers.signature);
}

/**
 * Whether this sequence id is newer than the last one seen for the same subscription.
 *
 * Sonos documents the header as a sequential ordering number, so a value at or below
 * the high-water mark is either a replay or a duplicate delivery, and either way must
 * not move the play clock. An unparseable id is refused rather than waved through.
 */
export function isFreshSequence(seqId: string, lastSeen: number | undefined): boolean {
  // Digits only, deliberately: `Number('')` and `Number(' ')` are both 0, which is
  // finite, so a `Number.isFinite` check alone would wave an empty header through as
  // sequence zero.
  if (!/^\d+$/.test(seqId)) return false;
  const value = Number(seqId);
  if (!Number.isSafeInteger(value)) return false;
  if (lastSeen === undefined) return true;
  return value > lastSeen;
}

export function isKnownNamespace(value: string): value is SonosNamespace {
  return value === 'groups' || value === 'playback' || value === 'playbackMetadata';
}

/**
 * Parses a JSON body without ever throwing.
 *
 * A malformed payload must not become a 500: Sonos would retry three times and then
 * drop the event, and a handler that throws on surprising input is how a single new
 * field from a Sonos update silently stops somebody's scrobbling.
 */
export async function readEventBody<T>(request: Request): Promise<T | undefined> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed as T;
  } catch {
    return undefined;
  }
}
