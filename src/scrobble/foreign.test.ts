/**
 * Telling a second scrobbler apart from ordinary listening.
 *
 * The cost of a false positive here is a warning that accuses somebody of a problem they
 * do not have, on a page whose whole purpose is being trustworthy about what is wrong.
 * So the cases that must NOT fire are tested at least as carefully as the one that must.
 */

import { describe, expect, it } from 'vitest';
import { findDuplicatePair, SAME_PLAY_WINDOW_SECONDS } from './foreign.js';

const at = (timestamp: number, track = 'redrum', artist = '21 Savage') => ({
  artist,
  track,
  timestamp
});

describe('findDuplicatePair', () => {
  it('finds two observers of one play, seconds apart', () => {
    // The real shape, from production: our submission and a second scrobbler's, both
    // stamping the same track start, three seconds apart.
    const pair = findDuplicatePair([at(1_788_115_190), at(1_788_115_187)]);
    expect(pair).toEqual({ offsetSeconds: 3, timestamp: 1_788_115_190 });
  });

  it('ignores an identical timestamp', () => {
    // Last.fm collapses these itself, so a surviving pair is a display artefact rather
    // than two accepted scrobbles — and flagging it would accuse this service of a
    // duplicate it did not cause.
    expect(findDuplicatePair([at(1_788_115_187), at(1_788_115_187)])).toBeUndefined();
  });

  it('does not flag the same track played twice in a row', () => {
    // A three-minute track on repeat. Legitimate, and the commonest way a naive
    // same-title check turns into a false accusation.
    expect(findDuplicatePair([at(1_788_115_187), at(1_788_115_007)])).toBeUndefined();
  });

  it('stays silent at the shortest legitimate gap', () => {
    // A scrobble needs half its track and no track under 30s is eligible, so two honest
    // scrobbles of one title are at least 15s apart. The window must sit below that.
    expect(SAME_PLAY_WINDOW_SECONDS).toBeLessThan(15);
    expect(findDuplicatePair([at(1_788_115_187), at(1_788_115_172)])).toBeUndefined();
  });

  it('does not confuse two different tracks that happen to be adjacent', () => {
    expect(
      findDuplicatePair([at(1_788_115_190, 'redrum'), at(1_788_115_187, 'née-nah')])
    ).toBeUndefined();
  });

  it('matches across differing capitalisation and padding', () => {
    // Two writers rarely agree on case, and one of them pads. Requiring an exact string
    // match would miss most real duplicates.
    const pair = findDuplicatePair([
      at(1_788_115_190, 'REDRUM', '21 savage'),
      at(1_788_115_188, ' redrum ', '21 Savage ')
    ]);
    expect(pair?.offsetSeconds).toBe(2);
  });

  it('finds a duplicate further back in the history, not just the newest pair', () => {
    // The check runs on a page of recent scrobbles rather than on the play just sent,
    // because the other writer is minutes late — so the pair worth finding is usually
    // several tracks old.
    const pair = findDuplicatePair([
      at(1_788_115_600, 'Breathe'),
      at(1_788_115_400, 'One Call'),
      at(1_788_115_190, 'redrum'),
      at(1_788_115_187, 'redrum')
    ]);
    expect(pair).toEqual({ offsetSeconds: 3, timestamp: 1_788_115_190 });
  });

  it('reports nothing for a clean history', () => {
    expect(
      findDuplicatePair([at(1_788_115_600, 'Breathe'), at(1_788_115_400, 'One Call')])
    ).toBeUndefined();
  });

  it('reports nothing for an empty history', () => {
    expect(findDuplicatePair([])).toBeUndefined();
  });
});
