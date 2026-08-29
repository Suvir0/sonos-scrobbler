/**
 * The Sonos side of account linking.
 *
 * Standard authorization-code OAuth with one detail worth knowing: the refresh token
 * is stable across refreshes. Sonos returns the same one every time, so a user
 * authorizes once and never again — which is the whole promise of the service, and
 * also why losing that token is the one unrecoverable failure here.
 */

import { toBase64 } from '../lib/crypto.js';

/** The only scope Sonos currently offers. */
export const SONOS_SCOPE = 'playback-control-all';

export interface SonosTokens {
  accessToken: string;
  refreshToken: string;
  /** Wall-clock ms at which the access token expires. */
  expiresAtMs: number;
}

export interface SonosOAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
}

export function buildAuthorizeUrl(config: SonosOAuthConfig, state: string): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', SONOS_SCOPE);
  // Must match a registered redirect URI byte for byte, so it is set through
  // URLSearchParams rather than concatenated, and never normalised elsewhere.
  url.searchParams.set('redirect_uri', config.redirectUri);
  return url.toString();
}

/**
 * Raised when Sonos says the grant itself is gone.
 *
 * Separated from every other token failure because the two need opposite handling: a
 * 500 or a timeout is worth retrying for hours, and `invalid_grant` never is — the user
 * revoked the integration or deleted their Sonos account, and no number of retries will
 * bring it back. Retrying it anyway is how a dead account keeps spending requests
 * against a quota shared with every working one.
 */
export class SonosGrantRevoked extends Error {
  constructor(detail: string) {
    super(`Sonos rejected the grant: ${detail}`);
    this.name = 'SonosGrantRevoked';
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Access tokens last 24 hours. Refreshing is treated as due a minute early so a
 * request never races the expiry boundary and comes back 401.
 */
const EXPIRY_SKEW_MS = 60_000;

export function isExpired(tokens: Pick<SonosTokens, 'expiresAtMs'>, nowMs: number): boolean {
  return nowMs >= tokens.expiresAtMs - EXPIRY_SKEW_MS;
}

async function postToken(
  config: SonosOAuthConfig,
  body: URLSearchParams,
  fetchImpl: typeof fetch
): Promise<TokenResponse> {
  const basic = toBase64(new TextEncoder().encode(`${config.clientId}:${config.clientSecret}`));
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  const parsed = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || parsed.error) {
    const detail = parsed.error_description ?? parsed.error ?? 'unknown';
    // `invalid_grant` is the one answer that means stop, not try again later.
    if (parsed.error === 'invalid_grant' || response.status === 400) {
      throw new SonosGrantRevoked(detail);
    }
    throw new Error(`Sonos token request failed (${response.status}): ${detail}`);
  }
  return parsed;
}

function toTokens(parsed: TokenResponse, nowMs: number, fallbackRefresh?: string): SonosTokens {
  const accessToken = parsed.access_token;
  const refreshToken = parsed.refresh_token ?? fallbackRefresh;
  if (!accessToken || !refreshToken) throw new Error('Sonos token response was missing a token');
  // The docs say 86400; trust the response but do not assume the field is present.
  const expiresInMs = (parsed.expires_in ?? 86_400) * 1000;
  return { accessToken, refreshToken, expiresAtMs: nowMs + expiresInMs };
}

export async function exchangeCode(
  config: SonosOAuthConfig,
  code: string,
  deps: { nowMs: number; fetch?: typeof fetch }
): Promise<SonosTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri
  });
  const parsed = await postToken(config, body, deps.fetch ?? fetch);
  return toTokens(parsed, deps.nowMs);
}

export async function refreshTokens(
  config: SonosOAuthConfig,
  refreshToken: string,
  deps: { nowMs: number; fetch?: typeof fetch }
): Promise<SonosTokens> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const parsed = await postToken(config, body, deps.fetch ?? fetch);
  // Sonos reuses the same refresh token, so a response that omits it is not an error.
  return toTokens(parsed, deps.nowMs, refreshToken);
}
