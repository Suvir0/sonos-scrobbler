import { describe, expect, it } from 'vitest';
import { refreshTokens, SonosGrantRevoked, type SonosOAuthConfig } from './oauth.js';

const CONFIG: SonosOAuthConfig = {
  clientId: 'id',
  clientSecret: 'secret',
  authorizeUrl: 'https://api.sonos.com/login/v3/oauth',
  tokenUrl: 'https://api.sonos.com/login/v3/oauth/access',
  redirectUri: 'https://example.com/auth/sonos/callback'
};

function responding(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('refreshTokens', () => {
  // The distinction the renewal sweep depends on. Treating these the same is how a
  // revoked account keeps being retried every six hours forever, spending requests
  // against a quota shared with every account that still works.
  it('reports a revoked grant as its own type, not as a generic failure', async () => {
    await expect(
      refreshTokens(CONFIG, 'dead', {
        nowMs: 0,
        fetch: responding(400, { error: 'invalid_grant', error_description: 'revoked' })
      })
    ).rejects.toBeInstanceOf(SonosGrantRevoked);
  });

  it('leaves a server-side failure as an ordinary error, so it is retried', async () => {
    const failure = refreshTokens(CONFIG, 'good', {
      nowMs: 0,
      fetch: responding(503, { error: 'server_error' })
    });
    await expect(failure).rejects.toThrow();
    await expect(failure).rejects.not.toBeInstanceOf(SonosGrantRevoked);
  });

  // Sonos returns the same refresh token every time, and sometimes omits it entirely.
  it('keeps the existing refresh token when the response omits one', async () => {
    const tokens = await refreshTokens(CONFIG, 'stable', {
      nowMs: 1_000,
      fetch: responding(200, { access_token: 'fresh', expires_in: 86_400 })
    });
    expect(tokens.refreshToken).toBe('stable');
    expect(tokens.expiresAtMs).toBe(1_000 + 86_400_000);
  });
});
