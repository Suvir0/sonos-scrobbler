import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          SONOS_CLIENT_ID: 'test-client-id',
          SONOS_CLIENT_SECRET: 'test-client-secret',
          LASTFM_API_KEY: 'test-lastfm-key',
          LASTFM_API_SECRET: 'test-lastfm-secret',
          TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          SCROBBLE_KEY_SALT: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
          SESSION_SECRET: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC='
        }
      }
    })
  ]
});
