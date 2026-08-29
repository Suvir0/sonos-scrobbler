/** Small response helpers, so route code reads as routing rather than as plumbing. */

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers }
  });
}

export function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}

export function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

/**
 * Headers applied to every response the Worker sends.
 *
 * The Content-Security-Policy is the one worth explaining. The page is a single static
 * document with its styles and one module inline, so the policy can be strict: no
 * third-party origin may supply script, style or an image, and `connect-src 'self'`
 * means a script injected through some future mistake still has nowhere to send a
 * session cookie or a pasted ListenBrainz token. `'unsafe-inline'` is required because
 * the style block and the module are inline; that is the deliberate trade, and it is a
 * far smaller surface than allowing arbitrary remote origins.
 *
 * `frame-ancestors 'none'` matters more than usual: the dashboard has a delete-everything
 * button, and clickjacking it would be an unrecoverable action taken by a third party.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'"
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // No camera, microphone or location is ever used; saying so removes them from any
  // embedded context and from the permissions a browser will even offer the page.
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  // Two years, subdomains included. The Sonos event callback URL must be HTTPS with a
  // CA-signed certificate anyway, so there is no plaintext deployment to break.
  'strict-transport-security': 'max-age=63072000; includeSubDomains'
};

/**
 * Copies a response and applies the security headers.
 *
 * Applied centrally in the fetch handler rather than at each call site, because the one
 * response that would be forgotten is the one served straight from the assets binding —
 * which is the HTML page itself, the only response where a CSP does anything at all.
 */
export function harden(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  // A 304 must not gain a body, and `Response` refuses one for 101/204/205/304 anyway.
  return new Response(response.status === 304 || response.status === 204 ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Whether a state-changing request came from our own page.
 *
 * The session cookie is `SameSite=Lax`, which already blocks cross-site POSTs from
 * carrying it — but Lax has to stay because the OAuth callbacks are top-level
 * cross-site navigations, and browsers that treat Lax loosely (or a future same-site
 * subdomain) would leave `DELETE /api/account` reachable from elsewhere. Checking the
 * Origin header costs nothing and closes that on its own.
 *
 * A missing Origin is accepted: browsers omit it on same-origin GETs and on some
 * navigations, and only the methods that change state are checked here.
 */
export function isSameOrigin(request: Request, publicBaseUrl: string): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set([new URL(publicBaseUrl).origin, new URL(request.url).origin]);
  return allowed.has(origin);
}
