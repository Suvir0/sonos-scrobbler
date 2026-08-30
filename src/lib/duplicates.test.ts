/**
 * The line between "one person with two accounts" and "two people in one household".
 *
 * Both look identical from Sonos, which names speakers rather than people. The test that
 * separates them is whether the two accounts submit to the same scrobbling account: a
 * couple have two Last.fm accounts, a duplicate has one. These tests pin both sides of
 * that line, because getting it wrong in either direction is bad — firing on a couple
 * silently stops somebody scrobbling, and not firing on a duplicate is the doubled
 * history this exists to prevent.
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { standDownDuplicateTargets } from './duplicates.js';
import { applySchema, resetTables } from '../testing/schema.js';

const HOUSEHOLD = 'Sonos_house1';
const OTHER_HOUSEHOLD = 'Sonos_house2';

async function makeUser(
  id: string,
  household: string,
  target?: { kind: 'lastfm' | 'listenbrainz'; username: string }
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(id, now).run();
  await env.DB.prepare(
    'INSERT INTO households (household_id, user_id, name, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(household, id, 'Home', now)
    .run();
  if (target) {
    await env.DB.prepare(
      `INSERT INTO targets (user_id, kind, credential_enc, username, enabled, needs_reauth, created_at, updated_at)
       VALUES (?, ?, 'ciphertext', ?, 1, 0, ?, ?)`
    )
      .bind(id, target.kind, target.username, now, now)
      .run();
  }
}

async function enabledOf(userId: string): Promise<number | undefined> {
  const row = await env.DB.prepare('SELECT enabled FROM targets WHERE user_id = ?')
    .bind(userId)
    .first<{ enabled: number }>();
  return row?.enabled;
}

describe('standing down a duplicate target', () => {
  beforeEach(async () => {
    await applySchema();
    await resetTables();
  });

  it('disables the older account when both submit to the same Last.fm on the same speakers', async () => {
    await makeUser('old', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });
    await makeUser('new', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });

    expect(await standDownDuplicateTargets(env, 'new')).toEqual(['lastfm']);

    expect(await enabledOf('old')).toBe(0);
    // The account that just linked keeps working — the newest link wins.
    expect(await enabledOf('new')).toBe(1);
  });

  it('says why, on the account that went quiet', async () => {
    await makeUser('old', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });
    await makeUser('new', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });

    await standDownDuplicateTargets(env, 'new');

    const row = await env.DB.prepare('SELECT last_error FROM targets WHERE user_id = ?')
      .bind('old')
      .first<{ last_error: string }>();
    expect(row!.last_error).toContain('recorded twice');
    expect(row!.last_error).toContain('Reconnect here to move it back');
  });

  it('leaves two people in one household alone', async () => {
    // The case migration 0006 exists to support. Same speakers, different Last.fm
    // accounts — nothing is doubled and neither must be touched.
    await makeUser('alex', HOUSEHOLD, { kind: 'lastfm', username: 'alex' });
    await makeUser('sam', HOUSEHOLD, { kind: 'lastfm', username: 'sam' });

    expect(await standDownDuplicateTargets(env, 'sam')).toEqual([]);
    expect(await enabledOf('alex')).toBe(1);
    expect(await enabledOf('sam')).toBe(1);
  });

  it('leaves two homes pointed at one Last.fm alone', async () => {
    // Separate Sonos households scrobbling to one account is sensible: the speakers
    // never overlap, so no play is ever submitted twice.
    await makeUser('house', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });
    await makeUser('cabin', OTHER_HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });

    expect(await standDownDuplicateTargets(env, 'cabin')).toEqual([]);
    expect(await enabledOf('house')).toBe(1);
  });

  it('treats the two services independently', async () => {
    // Sharing a Last.fm account says nothing about ListenBrainz, which may legitimately
    // be a different person's or absent entirely.
    await makeUser('old', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });
    await makeUser('new', HOUSEHOLD, { kind: 'listenbrainz', username: 'suvir' });

    expect(await standDownDuplicateTargets(env, 'new')).toEqual([]);
    expect(await enabledOf('old')).toBe(1);
  });

  it('does nothing when the households have not been recorded yet', async () => {
    // The race this guard is called twice for: a target can exist before the household
    // sync that would reveal the shared speakers. It must stay silent, not guess.
    const now = Date.now();
    for (const id of ['old', 'new']) {
      await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(id, now).run();
      await env.DB.prepare(
        `INSERT INTO targets (user_id, kind, credential_enc, username, enabled, needs_reauth, created_at, updated_at)
         VALUES (?, 'lastfm', 'ciphertext', 'candiedlmao', 1, 0, ?, ?)`
      )
        .bind(id, now, now)
        .run();
    }

    expect(await standDownDuplicateTargets(env, 'new')).toEqual([]);
    expect(await enabledOf('old')).toBe(1);
  });

  it('is symmetric: reconnecting on the older account moves scrobbling back', async () => {
    await makeUser('old', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });
    await makeUser('new', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });
    await standDownDuplicateTargets(env, 'new');
    expect(await enabledOf('old')).toBe(0);

    // Signing into the older account and reconnecting re-enables its target, exactly as
    // `saveTarget` does, and then runs this same check from the other side.
    await env.DB.prepare('UPDATE targets SET enabled = 1, last_error = NULL WHERE user_id = ?')
      .bind('old')
      .run();
    expect(await standDownDuplicateTargets(env, 'old')).toEqual(['lastfm']);

    expect(await enabledOf('old')).toBe(1);
    expect(await enabledOf('new')).toBe(0);
  });

  it('ignores an account whose target is already switched off', async () => {
    // Otherwise every subsequent link rewrites the same row and bumps `updated_at`
    // forever, and the log fills with duplicates that were already resolved.
    await makeUser('old', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });
    await makeUser('new', HOUSEHOLD, { kind: 'lastfm', username: 'candiedlmao' });
    await standDownDuplicateTargets(env, 'new');

    expect(await standDownDuplicateTargets(env, 'new')).toEqual([]);
  });
});
