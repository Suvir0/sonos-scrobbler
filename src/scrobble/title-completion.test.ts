import { describe, expect, it, vi } from 'vitest';
import {
  completeTitle,
  matchCatalogue,
  mayBeTruncated,
  MIN_TRUNCATED_BYTES,
  utf8Length,
  type CatalogueTrack,
  type TitleCatalogue
} from './title-completion.js';

// The real case this exists for. The full Spotify title is 149 bytes of UTF-8; over
// Spotify Connect the speaker reported the first 62, and from Apple Music (where the
// title is bracketed rather than dashed) the first 99.
const ARTIST = 'TimeLied';
const FULL = 'ขอมากไปไหม (Too Much) - From Rearrange The Series ขอฟังอีกครั้ง เพลงรักของเธอ';
const CUT = 'ขอมากไปไหม (Too Much) - From Rearrange The';
const APPLE_FULL = 'ขอมากไปไหม (Too Much) [From Rearrange The Series ขอฟังอีกครั้ง เพลงรักของเธอ]';
const APPLE_CUT = 'ขอมากไปไหม (Too Much) [From Rearrange The Series ขอฟังอีกคร';

describe('mayBeTruncated', () => {
  it('flags the lengths Sonos actually produced', () => {
    expect(utf8Length(CUT)).toBe(62);
    expect(utf8Length(APPLE_CUT)).toBe(99);
    expect(mayBeTruncated(CUT)).toBe(true);
    expect(mayBeTruncated(APPLE_CUT)).toBe(true);
  });

  it('leaves an ordinary title alone', () => {
    expect(mayBeTruncated('Come Down')).toBe(false);
    expect(mayBeTruncated('')).toBe(false);
  });

  it('measures bytes, not characters', () => {
    expect(mayBeTruncated('x'.repeat(MIN_TRUNCATED_BYTES - 1))).toBe(false);
    expect(mayBeTruncated('x'.repeat(MIN_TRUNCATED_BYTES))).toBe(true);
    // Nineteen Thai characters are 57 bytes: long enough, though few in characters.
    expect(mayBeTruncated('ข'.repeat(19))).toBe(true);
  });
});

describe('matchCatalogue', () => {
  const catalogue: CatalogueTrack[] = [
    { artist: ARTIST, name: FULL, listeners: 105 },
    { artist: ARTIST, name: `${FULL} (Sped Up)`, listeners: 3 },
    { artist: ARTIST, name: 'เจ็บ - From Rearrange The Series ขอฟังอีกครั้ง เพลงรักของเธอ', listeners: 97 },
    { artist: 'Somebody Else', name: `${CUT} Series (Cover)`, listeners: 9_000 }
  ];

  it('completes a cut title from the same artist', () => {
    expect(matchCatalogue({ artist: ARTIST, track: CUT }, catalogue)).toEqual({
      kind: 'longer',
      title: FULL
    });
  });

  it('prefers the most-listened completion, then the shortest', () => {
    const popular = matchCatalogue({ artist: ARTIST, track: CUT }, [
      { artist: ARTIST, name: `${FULL} (Sped Up)`, listeners: 500 },
      { artist: ARTIST, name: FULL, listeners: 105 }
    ]);
    expect(popular).toEqual({ kind: 'longer', title: `${FULL} (Sped Up)` });

    const tied = matchCatalogue({ artist: ARTIST, track: CUT }, [
      { artist: ARTIST, name: `${FULL} (Sped Up)` },
      { artist: ARTIST, name: FULL }
    ]);
    expect(tied).toEqual({ kind: 'longer', title: FULL });
  });

  it('ignores other artists however popular they are', () => {
    const others = catalogue.filter((entry) => entry.artist !== ARTIST);
    expect(matchCatalogue({ artist: ARTIST, track: CUT }, others)).toEqual({ kind: 'none' });
  });

  it('reports a title the catalogue knows in full as whole', () => {
    // A long title that is genuinely complete must not be "completed" into a remix of
    // itself. The exact entry wins even though a longer one also begins with it.
    expect(matchCatalogue({ artist: ARTIST, track: FULL }, catalogue)).toEqual({ kind: 'exact' });
  });

  it('compares regardless of case, spacing and Unicode form', () => {
    const shouted = { artist: ARTIST.toUpperCase(), track: `  ${CUT.replace(' - ', '  -  ')}  ` };
    expect(matchCatalogue(shouted, catalogue)).toEqual({ kind: 'longer', title: FULL });

    const decomposed = { artist: ARTIST, track: FULL.normalize('NFD') };
    expect(matchCatalogue(decomposed, catalogue)).toEqual({ kind: 'exact' });
  });

  it('never completes to a title that merely contains the reported one', () => {
    const result = matchCatalogue({ artist: ARTIST, track: 'Too Much' }, [
      { artist: ARTIST, name: 'Not Too Much' }
    ]);
    expect(result).toEqual({ kind: 'none' });
  });

  it('gives nothing for an empty title or artist', () => {
    expect(matchCatalogue({ artist: '', track: CUT }, catalogue)).toEqual({ kind: 'none' });
    expect(matchCatalogue({ artist: ARTIST, track: '  ' }, catalogue)).toEqual({ kind: 'none' });
  });

  it('handles the bracketed Apple Music form the same way', () => {
    const result = matchCatalogue({ artist: ARTIST, track: APPLE_CUT }, [
      { artist: ARTIST, name: APPLE_FULL, listeners: 2 }
    ]);
    expect(result).toEqual({ kind: 'longer', title: APPLE_FULL });
  });
});

describe('completeTitle', () => {
  function scripted(search: CatalogueTrack[], top: CatalogueTrack[] = []): TitleCatalogue & {
    searchTracks: ReturnType<typeof vi.fn>;
    topTracks: ReturnType<typeof vi.fn>;
  } {
    return {
      searchTracks: vi.fn(async () => search),
      topTracks: vi.fn(async () => top)
    };
  }

  it('does not ask about a title too short to have been cut', async () => {
    const catalogue = scripted([{ artist: 'Anderson .Paak', name: 'Come Down (Remix)' }]);
    await expect(completeTitle(catalogue, { artist: 'Anderson .Paak', track: 'Come Down' })).resolves.toBeUndefined();
    expect(catalogue.searchTracks).not.toHaveBeenCalled();
    expect(catalogue.topTracks).not.toHaveBeenCalled();
  });

  it('takes the completion search offers', async () => {
    const catalogue = scripted([{ artist: ARTIST, name: FULL, listeners: 105 }]);
    await expect(completeTitle(catalogue, { artist: ARTIST, track: CUT })).resolves.toBe(FULL);
    expect(catalogue.searchTracks).toHaveBeenCalledWith(ARTIST, CUT);
    expect(catalogue.topTracks).not.toHaveBeenCalled();
  });

  it('keeps a title the catalogue already knows in full', async () => {
    const catalogue = scripted(
      [{ artist: ARTIST, name: FULL }, { artist: ARTIST, name: `${FULL} (Sped Up)` }],
      [{ artist: ARTIST, name: `${FULL} (Sped Up)` }]
    );
    await expect(completeTitle(catalogue, { artist: ARTIST, track: FULL })).resolves.toBeUndefined();
    // Whole is whole; the fallback must not get a second chance to "complete" it.
    expect(catalogue.topTracks).not.toHaveBeenCalled();
  });

  it("falls back to the artist's top tracks when search finds nothing", async () => {
    const catalogue = scripted([], [{ artist: ARTIST, name: FULL, listeners: 105 }]);
    await expect(completeTitle(catalogue, { artist: ARTIST, track: CUT })).resolves.toBe(FULL);
    expect(catalogue.topTracks).toHaveBeenCalledWith(ARTIST);
  });

  it('keeps the reported title when nothing begins with it', async () => {
    const catalogue = scripted(
      [{ artist: ARTIST, name: 'Something Else Entirely' }],
      [{ artist: ARTIST, name: 'And Another' }]
    );
    await expect(completeTitle(catalogue, { artist: ARTIST, track: CUT })).resolves.toBeUndefined();
  });

  it('keeps the reported title when the catalogue fails', async () => {
    const catalogue: TitleCatalogue = {
      searchTracks: async () => {
        throw new Error('rate limited');
      },
      topTracks: async () => {
        throw new Error('rate limited');
      }
    };
    await expect(completeTitle(catalogue, { artist: ARTIST, track: CUT })).resolves.toBeUndefined();
  });
});
