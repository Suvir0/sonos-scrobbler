/**
 * Worker entry point: routing, and the scheduled renewal sweep.
 *
 * Static assets are served by the ASSETS binding for any path that matches a file, so
 * everything routed here is an API or callback path.
 */

import type { Env } from './env.js';
import { problem, redirect } from './lib/http.js';
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
import { health } from './routes/health.js';
import { handleSonosWebhook } from './routes/webhook.js';
import { renewDue } from './subscriptions.js';

export { GroupSession } from './do/group-session.js';
export { OAuthState } from './do/oauth-state.js';
export { UserQueue } from './do/user-queue.js';

/** Routes that require a signed-in user. */
async function requireUser(request: Request, env: Env): Promise<string | Response> {
  const userId = await currentUserId(request, env);
  if (!userId) return redirect('/?error=signin_required');
  return userId;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // The webhook first and unconditionally: it is the latency-critical path and
      // must never queue behind session lookups or anything else.
      if (path === '/webhooks/sonos' && method === 'POST') {
        return await handleSonosWebhook(request, env, ctx);
      }

      if (path === '/healthz') return await health(env);

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

      // Anything else is a static asset or a 404 from the assets binding.
      return await env.ASSETS.fetch(request);
    } catch (error) {
      log(env, 'error', 'request.failed', {
        path,
        method,
        message: error instanceof Error ? error.message : String(error)
      });
      return problem(500, 'internal_error', 'Something went wrong.');
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
