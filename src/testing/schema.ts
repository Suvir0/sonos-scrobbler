/**
 * Applies the real migration files to the test database.
 *
 * Deliberately the actual migrations rather than a hand-maintained copy: a schema that
 * only exists in test fixtures drifts from the one that ships, and the first sign of it
 * is a query that passes every test and fails in production.
 */

import { env } from 'cloudflare:test';

const MIGRATIONS: (() => Promise<{ default: string }>)[] = [
  () => import('../../migrations/0001_init.sql?raw'),
  () => import('../../migrations/0002_topology_throttle.sql?raw'),
  () => import('../../migrations/0003_pipeline_health.sql?raw'),
  () => import('../../migrations/0004_sonos_reauth.sql?raw'),
  () => import('../../migrations/0005_room_choice.sql?raw'),
  () => import('../../migrations/0006_identity.sql?raw'),
  () => import('../../migrations/0007_target_error.sql?raw')
];

const TABLES = [
  'sessions',
  'subscriptions',
  'sonos_players',
  'sonos_groups',
  'households',
  'targets',
  'sonos_accounts',
  'users'
];

export async function applySchema(): Promise<void> {
  for (const load of MIGRATIONS) {
    const sql = (await load()).default;
    // Comments are stripped before splitting on `;` — the schema's own prose contains
    // semicolons, and splitting first cuts statements in half mid-sentence.
    const stripped = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    for (const statement of stripped.split(';')) {
      const trimmed = statement.trim();
      // D1 manages foreign key enforcement itself and rejects the pragma.
      if (!trimmed || trimmed.toUpperCase().startsWith('PRAGMA')) continue;
      try {
        await env.DB.prepare(trimmed).run();
      } catch (error) {
        // Tables persist across tests in a file, so a re-applied ALTER is expected.
        if (!String(error).includes('duplicate column')) throw error;
      }
    }
  }
}

/** Empties every table. D1 storage persists between tests in the same file. */
export async function resetTables(): Promise<void> {
  for (const table of TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

export async function freshDatabase(): Promise<void> {
  await applySchema();
  await resetTables();
}
