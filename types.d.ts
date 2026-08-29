/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// No top-level import/export in this file, deliberately: that would make it a module,
// and the wildcard `*.sql?raw` declaration below only works from a script-scoped file.
// Types from source files are therefore pulled in with inline imports.

/**
 * The Worker's bindings and secrets. Mirrors wrangler.jsonc.
 *
 * Declared here on the global `Cloudflare.Env` — the shape `wrangler types` would
 * normally generate — rather than as a plain exported interface, because that is what
 * `cloudflare:test` types its `env` export as. Declaring it anywhere else means `env`
 * in tests is `{}` and every binding access is a type error.
 *
 * The Durable Object namespaces are parameterised by their class so RPC calls are
 * typechecked end to end.
 */
declare namespace Cloudflare {
  interface Env {
    // Bindings
    DB: D1Database;
    ASSETS: Fetcher;
    OAUTH_STATES: DurableObjectNamespace<import('./src/do/oauth-state.js').OAuthState>;
    GROUP_SESSIONS: DurableObjectNamespace<import('./src/do/group-session.js').GroupSession>;
    USER_QUEUES: DurableObjectNamespace<import('./src/do/user-queue.js').UserQueue>;

    // vars
    ENVIRONMENT: string;
    PUBLIC_BASE_URL: string;
    SONOS_AUTHORIZE_URL: string;
    SONOS_TOKEN_URL: string;
    SONOS_API_URL: string;
    LASTFM_AUTH_URL: string;
    LISTENBRAINZ_API_URL: string;

    // secrets — set with `wrangler secret put`, never committed
    SONOS_CLIENT_ID: string;
    SONOS_CLIENT_SECRET: string;
    LASTFM_API_KEY: string;
    LASTFM_API_SECRET: string;
    /** base64 of 32 bytes — AES-GCM key for OAuth credentials at rest. */
    TOKEN_ENCRYPTION_KEY: string;
    /** base64 — HMAC key for scrobble dedupe identities. */
    SCROBBLE_KEY_SALT: string;
    /** base64 — HMAC key for session cookie lookup. */
    SESSION_SECRET: string;
  }
}

/** Vite's `?raw` suffix, used to apply the real migration file in tests. */
declare module '*.sql?raw' {
  const contents: string;
  export default contents;
}
