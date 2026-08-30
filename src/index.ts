/**
 * Worker entry point: routing, and the scheduled renewal sweep.
 *
 * Static assets are served by the ASSETS binding for any path that matches a file, so
 * everything routed here is an API or callback path.
 */

import type { Env } from './env.js';
import { harden, isSameOrigin, problem, redirect } from './lib/http.js';
import { log } from './lib/log.js';
import { clearedCookie, currentUserId, destroySession } from './lib/session.js';
import { accountStatus, deleteAccount, resync } from './routes/account.js';
import {
  completeLastfmLink,
  completeSonosLink,
  linkListenBrainz,
  startLastfmLink,
  startSonosLink
} from './routes/auth.js';
import { health, securityTxt } from './routes/health.js';
import { getRooms, updateRoom } from './routes/rooms.js';
import { getSettings, updateSettings } from './routes/settings.js';
import { handleSonosWebhook } from './routes/webhook.js';
import { renewDue } from './subscriptions.js';

export { GroupSession } from './do/group-session.js';
export { OAuthState } from './do/oauth-state.js';
export { UserQueue } from './do/user-queue.js';

/**
 * Routes that require a signed-in user.
 *
 * `/api/*` gets a JSON 401 and everything else is sent back to the front page. The
 * distinction is not cosmetic: the dashboard polls `/api/account` every fifteen seconds,
 * and a 302 to an HTML page there is indistinguishable from a successful response until
 * the JSON parse fails — which is how an expired session showed as a page frozen on
 * stale data rather than as a signed-out user.
 */
async function requireUser(request: Request, env: Env): Promise<string | Response> {
  const userId = await currentUserId(request, env);
  if (userId) return userId;
  return new URL(request.url).pathname.startsWith('/api/')
    ? problem(401, 'signin_required', 'Sign in with Sonos first.')
    : redirect('/?error=signin_required');
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // The webhook first and unconditionally: it is the latency-critical path and must
  // never queue behind session lookups or anything else.
  if (path === '/webhooks/sonos' && method === 'POST') {
    return await handleSonosWebhook(request, env, ctx);
  }

  if (path === '/healthz') return await health(env);
  if (path === '/.well-known/security.txt') return securityTxt(env);

  // Everything below this line either changes state or reads a signed-in user's data.
  // The webhook is excluded above because it authenticates by signature and carries no
  // Origin at all; the health check changes nothing.
  if (method !== 'GET' && method !== 'HEAD' && !isSameOrigin(request, env.PUBLIC_BASE_URL)) {
    log(env, 'warn', 'request.cross-origin-refused', { path, method });
    return problem(403, 'cross_origin', 'That request did not come from this site.');
  }

  if (path === '/auth/sonos/start') return await startSonosLink(request, env);
  if (path === '/auth/sonos/callback') return await completeSonosLink(request, env, ctx);

  if (path === '/auth/lastfm/start') {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : startLastfmLink(env);
  }
  if (path === '/auth/lastfm/callback') {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : await completeLastfmLink(request, env, user);
  }
  if (path === '/auth/listenbrainz' && method === 'POST') {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : await linkListenBrainz(request, env, user);
  }

  if (path === '/auth/logout' && method === 'POST') {
    await destroySession(request, env);
    return redirect('/', { 'set-cookie': clearedCookie(env) });
  }

  if (path === '/api/account' && method === 'GET') {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : await accountStatus(env, user);
  }
  if (path === '/api/resync' && method === 'POST') {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : await resync(env, user);
  }
  if (path === '/api/account' && method === 'DELETE') {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : await deleteAccount(env, user);
  }
  if (path === '/api/rooms' && method === 'GET') {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : await getRooms(env, user);
  }
  if (path === '/api/rooms' && (method === 'PUT' || method === 'POST')) {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : await updateRoom(request, env, user);
  }

  if (path === '/api/settings' && method === 'GET') {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : await getSettings(env, user);
  }
  if (path === '/api/settings' && (method === 'PUT' || method === 'POST')) {
    const user = await requireUser(request, env);
    return user instanceof Response ? user : await updateSettings(request, env, user);
  }

  // A request to a known API path with the wrong verb is a client bug, and answering it
  // with the HTML front page (which is what the assets binding would do) hides that.
  if (path.startsWith('/api/') || path.startsWith('/auth/')) {
    return problem(405, 'method_not_allowed', `${method} is not accepted here.`);
  }

  // Anything else is a static asset or a 404 from the assets binding.
  return await env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return harden(await route(request, env, ctx));
    } catch (error) {
      log(env, 'error', 'request.failed', {
        path: new URL(request.url).pathname,
        method: request.method,
        message: error instanceof Error ? error.message : String(error)
      });
      return harden(problem(500, 'internal_error', 'Something went wrong.'));
    }
  },

  /**
   * The renewal sweep.
   *
   * Runs every 15 minutes and renews a bounded slice ordered by how close each
   * subscription is to lapsing. Bounded because the Sonos quota is 1,000 requests per
   * minute for the entire application, shared with live traffic — a sweep over every
   * user at once would exhaust it and take everybody's scrobbling down with it.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const report = await renewDue(env);
        log(env, report.failed > 0 ? 'warn' : 'info', 'subscriptions.renewed', {
          considered: report.considered,
          renewed: report.renewed,
          failed: report.failed,
          callsUsed: report.callsUsed,
          truncated: report.truncated
        });

        // Expired login sessions are the one thing with no other reaper.
        await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()).run();
      })()
    );
  }
} satisfies ExportedHandler<Env>;
