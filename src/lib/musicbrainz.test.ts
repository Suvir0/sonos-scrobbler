import { describe, expect, it } from 'vitest';
import {
  albumForArtwork,
  artworkCacheKey,
  normalizeMetadata,
  primaryArtistForArtwork,
  selectMusicBrainzReleaseGroup
} from './musicbrainz.js';

describe('MusicBrainz matching', () => {
  it('normalizes case, accents, punctuation, and whitespace', () => {
    expect(normalizeMetadata('  Björk: Début! ')).toBe('bjork debut');
    expect(artworkCacheKey('Artist', 'Album')).toBe('artist\u0000album');
  });

  it('removes trailing edition labels from artwork lookup titles', () => {
    expect(albumForArtwork('After Hours (Explicit)')).toBe('After Hours');
    expect(albumForArtwork('Album — Deluxe Edition [Explicit]')).toBe('Album');
    expect(albumForArtwork('Rumours (2013 Remaster)')).toBe('Rumours');
    expect(albumForArtwork('The Deluxe')).toBe('The Deluxe');
    expect(albumForArtwork('Explicit')).toBe('Explicit');
    expect(artworkCacheKey('The Weeknd', 'After Hours (Explicit)')).toBe(
      'the weeknd\u0000after hours'
    );
  });

  it('matches a canonical release title to a player title with an edition label', () => {
    expect(
      selectMusicBrainzReleaseGroup('The Weeknd', 'After Hours (Explicit)', [
        { id: 'release-group-id', artists: ['The Weeknd'], title: 'After Hours', score: 100 }
      ])
    ).toEqual({ releaseGroupId: 'release-group-id' });
  });

  it('strips a trailing edition marker followed by a separate release subtitle', () => {
    expect(albumForArtwork('Eternal Atake (Deluxe) [LUV vs. The World 2]')).toBe('Eternal Atake');
    expect(albumForArtwork('Album (Explicit) [Bonus Track Version]')).toBe('Album');
  });

  it('leaves a trailing bracket run alone when none of it is a recognized edition label', () => {
    expect(albumForArtwork('Look at Me [Live]')).toBe('Look at Me [Live]');
    expect(albumForArtwork('Album (Remix) [Radio Edit]')).toBe('Album (Remix) [Radio Edit]');
  });

  it('matches a player-reported release with a deluxe marker and an unrelated subtitle', () => {
    expect(
      selectMusicBrainzReleaseGroup(
        'Lil Uzi Vert',
        'Eternal Atake (Deluxe) [LUV vs. The World 2]',
        [{ id: 'release-group-id', artists: ['Lil Uzi Vert'], title: 'Eternal Atake', score: 100 }]
      )
    ).toEqual({ releaseGroupId: 'release-group-id' });
  });

  it('matches a collaboration credited under multiple performer names', () => {
    expect(
      selectMusicBrainzReleaseGroup('Dave', 'Split Decision', [
        {
          id: 'release-group-id',
          artists: ['Dave', 'Central Cee'],
          title: 'Split Decision',
          score: 100
        }
      ])
    ).toEqual({ releaseGroupId: 'release-group-id' });
  });

  it('does not match an unrelated artist whose name partially overlaps', () => {
    expect(
      selectMusicBrainzReleaseGroup('Dave', 'Split Decision', [
        { id: 'other', artists: ['Dave Matthews Band'], title: 'Split Decision', score: 100 }
      ])
    ).toBeUndefined();
  });

  it('requires an exact normalized high-confidence result', () => {
    expect(
      selectMusicBrainzReleaseGroup('Björk', 'Début', [
        { id: 'bad-score', artists: ['Björk'], title: 'Début', score: 94 },
        { id: 'winner', artists: ['bjork'], title: 'debut', score: 99 }
      ])
    ).toEqual({ releaseGroupId: 'winner' });
  });

  it('uses the primary artist credit for artwork searches without breaking slash names', () => {
    expect(primaryArtistForArtwork('Childish Gambino / Jason Martin')).toBe('Childish Gambino');
    expect(primaryArtistForArtwork('AC/DC')).toBe('AC/DC');
    expect(primaryArtistForArtwork('Artist   /   Composer')).toBe('Artist');
    expect(primaryArtistForArtwork('AC/DC / Brian Johnson')).toBe('AC/DC');
    expect(primaryArtistForArtwork('  Spaced Artist  ')).toBe('Spaced Artist');
    expect(primaryArtistForArtwork('/ Leading Slash')).toBe('/ Leading Slash');
  });

  it('normalizes metadata in linear time on adversarial whitespace', () => {
    const padded = `Album ${' '.repeat(40_000)}`;
    const started = performance.now();
    expect(albumForArtwork(`${padded}(Deluxe)`)).toBe('Album');
    expect(primaryArtistForArtwork(padded)).toBe('Album');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('rejects ambiguous equally scored editions and ignores results beyond five', () => {
    expect(
      selectMusicBrainzReleaseGroup('A', 'B', [
        { id: 'one', artists: ['A'], title: 'B', score: 100 },
        { id: 'two', artists: ['A'], title: 'B', score: 100 }
      ])
    ).toBeUndefined();
    expect(
      selectMusicBrainzReleaseGroup('A', 'B', [
        ...Array.from({ length: 5 }, (_, index) => ({
          id: String(index),
          artists: ['X'],
          title: 'Y',
          score: 100
        })),
        { id: 'six', artists: ['A'], title: 'B', score: 100 }
      ])
    ).toBeUndefined();
  });

  it('selects exact metadata before artwork availability is queried separately', () => {
    expect(
      selectMusicBrainzReleaseGroup('Childish Gambino', 'Awaken, My Love!', [
        {
          id: 'release-group-id',
          artists: ['Childish Gambino'],
          title: 'Awaken, My Love!',
          score: 100
        }
      ])
    ).toEqual({ releaseGroupId: 'release-group-id' });
  });
});
