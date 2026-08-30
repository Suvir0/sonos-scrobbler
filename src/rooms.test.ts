import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from './testing/schema.js';
import { groupMayScrobble, listRooms, setRoomScrobble } from './rooms.js';

const USER = 'user-1';
const OTHER = 'user-2';
const HOUSEHOLD = 'Sonos_household1';

async function addUser(id: string): Promise<void> {
  await env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)')
    .bind(id, Date.now())
    .run();
}

async function addPlayer(userId: string, playerId: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sonos_players (player_id, user_id, household_id, name, seen_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(playerId, userId, HOUSEHOLD, name, Date.now())
    .run();
}

async function addGroup(
  userId: string,
  groupId: string,
  playerIds: string[] | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sonos_groups (group_id, household_id, user_id, name, player_ids, seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      groupId,
      HOUSEHOLD,
      userId,
      'a group',
      playerIds === null ? null : JSON.stringify(playerIds),
      Date.now()
    )
    .run();
}

describe('room preferences', () => {
  beforeEach(async () => {
    await freshDatabase();
    await addUser(USER);
    await addPlayer(USER, 'RINCON_LIVING', 'Living Room');
    await addPlayer(USER, 'RINCON_KITCHEN', 'Kitchen');
  });

  it('reports every room as on to begin with', async () => {
    expect(await listRooms(env, USER)).toEqual([
      { id: 'RINCON_KITCHEN', name: 'Kitchen', scrobble: true },
      { id: 'RINCON_LIVING', name: 'Living Room', scrobble: true }
    ]);
  });

  it('turns a room off and reads it back', async () => {
    expect(await setRoomScrobble(env, USER, 'RINCON_LIVING', false)).toBe(true);
    const rooms = await listRooms(env, USER);
    expect(rooms.find((room) => room.id === 'RINCON_LIVING')?.scrobble).toBe(false);
    expect(rooms.find((room) => room.id === 'RINCON_KITCHEN')?.scrobble).toBe(true);
  });

  // Answering "saved" for a speaker that is not yours would show a room as switched
  // off on the page while every event kept scrobbling it.
  it('refuses to change a player that belongs to somebody else', async () => {
    await addUser(OTHER);
    await addPlayer(OTHER, 'RINCON_THEIRS', 'Their Room');
    expect(await setRoomScrobble(env, USER, 'RINCON_THEIRS', false)).toBe(false);
    expect(await listRooms(env, OTHER)).toEqual([
      { id: 'RINCON_THEIRS', name: 'Their Room', scrobble: true }
    ]);
  });

  describe('resolving a group to its rooms', () => {
    it('permits a group whose rooms are all on', async () => {
      await addGroup(USER, 'GROUP_A', ['RINCON_LIVING', 'RINCON_KITCHEN']);
      expect(await groupMayScrobble(env, USER, 'GROUP_A')).toBe(true);
    });

    it('refuses a group containing one room that is off', async () => {
      await addGroup(USER, 'GROUP_A', ['RINCON_LIVING', 'RINCON_KITCHEN']);
      await setRoomScrobble(env, USER, 'RINCON_LIVING', false);
      expect(await groupMayScrobble(env, USER, 'GROUP_A')).toBe(false);
    });

    it('refuses a solo group for a room that is off', async () => {
      await addGroup(USER, 'GROUP_LIVING', ['RINCON_LIVING']);
      await setRoomScrobble(env, USER, 'RINCON_LIVING', false);
      expect(await groupMayScrobble(env, USER, 'GROUP_LIVING')).toBe(false);
    });

    it('leaves an untouched room playing when the off one is in a different group', async () => {
      await addGroup(USER, 'GROUP_LIVING', ['RINCON_LIVING']);
      await addGroup(USER, 'GROUP_KITCHEN', ['RINCON_KITCHEN']);
      await setRoomScrobble(env, USER, 'RINCON_LIVING', false);
      expect(await groupMayScrobble(env, USER, 'GROUP_KITCHEN')).toBe(true);
    });

    // A group created since the last topology sync, or one carried over from before
    // the membership column existed. Refusing these would stop scrobbling for a reason
    // no user could see or fix, and an unrecorded group has no switched-off room in it
    // by definition.
    it('permits a group whose membership is unknown', async () => {
      await addGroup(USER, 'GROUP_NEW', null);
      await setRoomScrobble(env, USER, 'RINCON_LIVING', false);
      expect(await groupMayScrobble(env, USER, 'GROUP_NEW')).toBe(true);
    });

    it('permits a group it has never heard of at all', async () => {
      expect(await groupMayScrobble(env, USER, 'GROUP_ABSENT')).toBe(true);
    });

    it('permits a group whose membership column is not valid JSON', async () => {
      await env.DB.prepare(
        `INSERT INTO sonos_groups (group_id, household_id, user_id, name, player_ids, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind('GROUP_BAD', HOUSEHOLD, USER, 'a group', 'not json', Date.now())
        .run();
      expect(await groupMayScrobble(env, USER, 'GROUP_BAD')).toBe(true);
    });

    // The one that makes the setting worth having: another person's household cannot
    // switch off a room in yours, and their off room does not silence your group.
    it('only counts the asking user’s own rooms', async () => {
      await addUser(OTHER);
      await addPlayer(OTHER, 'RINCON_LIVING', 'Their Living Room');
      await setRoomScrobble(env, OTHER, 'RINCON_LIVING', false);
      await addGroup(USER, 'GROUP_LIVING', ['RINCON_LIVING']);
      expect(await groupMayScrobble(env, USER, 'GROUP_LIVING')).toBe(true);
      expect(await groupMayScrobble(env, OTHER, 'GROUP_LIVING')).toBe(false);
    });
  });
});
