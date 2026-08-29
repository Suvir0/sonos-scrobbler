import { describe, expect, it } from 'vitest';
import { sonosEventSignature } from '../lib/crypto.js';
import { isFreshSequence, readEventHeaders, verifySignature } from './events.js';

const CREDENTIALS = { clientId: 'client-abc', clientSecret: 'secret-xyz' };

const BASE = {
  seqId: '7',
  namespace: 'playbackMetadata',
  type: 'metadataStatus',
  targetType: 'group',
  targetValue: 'RINCON_1:0'
};

async function signedRequest(overrides: Partial<typeof BASE> = {}, body: unknown = {}) {
  const parts = { ...BASE, ...overrides };
  const signature = await sonosEventSignature({ ...parts, ...CREDENTIALS });
  return new Request('https://example.com/webhooks/sonos', {
    method: 'POST',
    headers: {
      'x-sonos-event-seq-id': parts.seqId,
      'x-sonos-namespace': parts.namespace,
      'x-sonos-type': parts.type,
      'x-sonos-target-type': parts.targetType,
      'x-sonos-target-value': parts.targetValue,
      'x-sonos-event-signature': signature,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

describe('readEventHeaders', () => {
  it('reads a complete set', async () => {
    const headers = readEventHeaders(await signedRequest());
    expect(headers?.namespace).toBe('playbackMetadata');
    expect(headers?.targetValue).toBe('RINCON_1:0');
  });

  it('refuses an incomplete set rather than guessing', async () => {
    const request = new Request('https://example.com/webhooks/sonos', {
      method: 'POST',
      headers: { 'x-sonos-namespace': 'playback' }
    });
    expect(readEventHeaders(request)).toBeUndefined();
  });
});

describe('verifySignature', () => {
  it('accepts a correctly signed event', async () => {
    const headers = readEventHeaders(await signedRequest())!;
    expect(await verifySignature(headers, CREDENTIALS)).toBe(true);
  });

  it('rejects a wrong client secret', async () => {
    const headers = readEventHeaders(await signedRequest())!;
    expect(
      await verifySignature(headers, { ...CREDENTIALS, clientSecret: 'not-the-secret' })
    ).toBe(false);
  });

  it.each(['seqId', 'namespace', 'type', 'targetType', 'targetValue'] as const)(
    'rejects an event whose %s was tampered with after signing',
    async (field) => {
      // Sign one set of headers, then deliver a different one. Every field is in the
      // digest, so changing any of them must invalidate it.
      const headers = readEventHeaders(await signedRequest())!;
      const tampered = { ...headers, [field]: 'tampered' };
      expect(await verifySignature(tampered, CREDENTIALS)).toBe(false);
    }
  );

  it('rejects an empty signature', async () => {
    const headers = readEventHeaders(await signedRequest())!;
    expect(await verifySignature({ ...headers, signature: '' }, CREDENTIALS)).toBe(false);
  });

  it('produces base64url with no padding', async () => {
    // The docs specify URL-safe base64 without padding; '+', '/' or '=' would mean a
    // comparison that never matches whatever Sonos actually sends.
    const signature = await sonosEventSignature({ ...BASE, ...CREDENTIALS });
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signature).not.toContain('=');
  });
});

describe('isFreshSequence', () => {
  it('accepts the first event for a subscription', () => {
    expect(isFreshSequence('1', undefined)).toBe(true);
  });

  it('accepts an increasing id', () => {
    expect(isFreshSequence('8', 7)).toBe(true);
  });

  it('rejects a replayed id', () => {
    // The signature does not cover the body, so a captured request could be resent
    // with different content. The sequence high-water mark is what stops it.
    expect(isFreshSequence('7', 7)).toBe(false);
    expect(isFreshSequence('6', 7)).toBe(false);
  });

  it('rejects an unparseable id rather than treating it as zero', () => {
    expect(isFreshSequence('not-a-number', 7)).toBe(false);
    expect(isFreshSequence('', undefined)).toBe(false);
  });
});
