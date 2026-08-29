/**
 * The Worker's environment.
 *
 * The shape itself lives on the global `Cloudflare.Env` in `types.d.ts`, because that
 * is the type `cloudflare:test` gives to `env` in tests. This alias exists so source
 * files can keep importing a plain `Env` without every one of them reaching into a
 * global namespace.
 */
export type Env = Cloudflare.Env;
