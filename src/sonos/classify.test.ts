import { describe, expect, it } from 'vitest';
import { classify, looksLikeHandoff, MAX_SONG_MS, parseStreamInfo } from './classify.js';
import type { MetadataStatus } from './types.js';

/** A normal music track from a named service, the overwhelmingly common case. */
function musicTrack(overrides: Partial<MetadataStatus> = {}): MetadataStatus {
  return {
    container: {
      name: 'Malibu',
      type: 'album',
      service: { name: 'Acme Music' }
    },
    currentItem: {
      track: {
        type: 'track',
        name: 'Come Down',
        album: { name: 'Malibu' },
        artist: { name: 'Anderson .Paak' },
        id: { serviceId: '204', objectId: 'song:1065681770' },
        service: { name: 'Acme Music' },
        durationMillis: 176_000
      }
    },
    ...overrides
  };
}

describe('classify', () => {
  it('accepts a music track and carries its identity through', () => {
    const result = classify(musicTrack());
    expect(result).toEqual({
      scrobbleable: true,
      candidate: {
        artist: 'Anderson .Paak',
        track: 'Come Down',
        album: 'Malibu',
        durationMs: 176_000,
        objectId: 'song:1065681770',
        serviceName: 'Acme Music',
        isRadio: false
      }
    });
  });

  it('declines TV audio', () => {
    // The exact shape the docs give for a Beam on TV: a container and nothing else.
    const status: MetadataStatus = { container: { name: 'TV Audio', type: 'linein.homeTheater' } };
    expect(classify(status)).toEqual({ scrobbleable: false, reason: 'not-music' });
  });

  it('declines line-in', () => {
    expect(classify({ container: { name: 'Turntable', type: 'linein' } })).toEqual({
      scrobbleable: false,
      reason: 'not-music'
    });
  });

  it.each(['episode', 'show', 'audiobook'])('declines a %s container', (type) => {
    const status = musicTrack({ container: { name: 'A Podcast', type, service: { name: 'Acme' } } });
    expect(classify(status)).toEqual({ scrobbleable: false, reason: 'not-music' });
  });

  it('declines a podcast even when it carries a plausible artist', () => {
    // A spoken-word item tagged with a host name would otherwise sail through the
    // artist+title check and pollute the user's history.
    const status: MetadataStatus = {
      container: { name: 'Show', type: 'container', service: { name: 'Acme' } },
      currentItem: {
        track: { type: 'episode', name: 'Episode 12', artist: { name: 'Some Host' } }
      }
    };
    expect(classify(status)).toEqual({ scrobbleable: false, reason: 'not-music' });
  });

  describe('the song-length ceiling', () => {
    // A DJ set, a mix, a film soundtrack as one item: things that reach a speaker
    // wearing a title and an artist but are not a song.
    it('declines a track longer than the ceiling', () => {
      const status = musicTrack({
        currentItem: {
          track: {
            type: 'track',
            name: 'Essential Mix 2019-06-15',
            artist: { name: 'Some DJ' },
            service: { name: 'Acme Music' },
            durationMillis: 2 * 60 * 60_000
          }
        }
      });
      expect(classify(status, { maxTrackMs: MAX_SONG_MS })).toEqual({
        scrobbleable: false,
        reason: 'too-long'
      });
    });

    it('accepts a track exactly at the ceiling', () => {
      const status = musicTrack({
        currentItem: {
          track: {
            type: 'track',
            name: 'Echoes',
            artist: { name: 'Pink Floyd' },
            service: { name: 'Acme Music' },
            durationMillis: MAX_SONG_MS
          }
        }
      });
      expect(classify(status, { maxTrackMs: MAX_SONG_MS })).toMatchObject({ scrobbleable: true });
    });

    // The setting exists so somebody who genuinely listens to hour-long sets can have
    // them. No ceiling passed means no ceiling applied.
    it('applies no ceiling when none is given', () => {
      const status = musicTrack({
        currentItem: {
          track: {
            type: 'track',
            name: 'Essential Mix 2019-06-15',
            artist: { name: 'Some DJ' },
            service: { name: 'Acme Music' },
            durationMillis: 2 * 60 * 60_000
          }
        }
      });
      expect(classify(status)).toMatchObject({ scrobbleable: true });
    });

    // Radio reports the stream's length, not the song's, and `trackCandidate` drops it
    // for exactly that reason. A station that has been up for six hours must not be
    // refused as a long song.
    it('never applies the ceiling to radio', () => {
      const status: MetadataStatus = {
        container: { name: 'BBC Radio 6', type: 'station.broadcast' },
        currentItem: {
          track: {
            name: 'Come Down',
            artist: { name: 'Anderson .Paak' },
            durationMillis: 6 * 60 * 60_000
          }
        }
      };
      expect(classify(status, { maxTrackMs: MAX_SONG_MS })).toMatchObject({ scrobbleable: true });
    });
  });

  it('declines when nothing is loaded', () => {
    expect(classify({})).toEqual({ scrobbleable: false, reason: 'no-content' });
  });

  it('reports an idle room as no-content, not incomplete metadata', () => {
    // Sonos keeps sending a stale container after a queue empties. This is the most
    // common event the service receives; calling it "incomplete metadata" made 141 of
    // them look like a parsing failure during the first live test.
    expect(classify({ container: { name: 'Family Room', type: 'item' } })).toEqual({
      scrobbleable: false,
      reason: 'no-content'
    });
  });

  it('declines a track missing an artist', () => {
    const status = musicTrack({ currentItem: { track: { type: 'track', name: 'Untitled' } } });
    expect(classify(status)).toEqual({ scrobbleable: false, reason: 'incomplete-metadata' });
  });

  it('declines a track missing a title', () => {
    const status = musicTrack({
      currentItem: { track: { type: 'track', artist: { name: 'Someone' } } }
    });
    expect(classify(status)).toEqual({ scrobbleable: false, reason: 'incomplete-metadata' });
  });

  describe('radio', () => {
    it('accepts a station with structured metadata but ignores its duration', () => {
      // The duration a station reports is the stream's, not the song's. Keeping it
      // would let a 6-hour stream compute a 3-hour scrobble point, or a short one
      // scrobble after seconds.
      const status: MetadataStatus = {
        container: { name: 'Bruce Springsteen Radio', type: 'trackList.program' },
        currentItem: {
          track: {
            type: 'track',
            name: 'Dancing in the Dark',
            artist: { name: 'Bruce Springsteen' },
            durationMillis: 21_600_000
          }
        }
      };
      const result = classify(status);
      expect(result.scrobbleable).toBe(true);
      if (!result.scrobbleable) return;
      expect(result.candidate.durationMs).toBeUndefined();
      expect(result.candidate.isRadio).toBe(true);
    });

    it('parses streamInfo when there is no currentItem, using the station as album', () => {
      const status: MetadataStatus = {
        container: { name: 'BBC Radio 6 Music', type: 'station.broadcast' },
        streamInfo: 'Yo La Tengo - Autumn Sweater'
      };
      expect(classify(status)).toEqual({
        scrobbleable: true,
        candidate: {
          artist: 'Yo La Tengo',
          track: 'Autumn Sweater',
          album: 'BBC Radio 6 Music',
          isRadio: true
        }
      });
    });

    it('declines streamInfo it cannot split confidently', () => {
      const status: MetadataStatus = {
        container: { name: 'Some Station', type: 'station' },
        streamInfo: 'Now playing on Radio 6'
      };
      expect(classify(status)).toEqual({ scrobbleable: false, reason: 'unparseable-stream' });
    });

    it('can be turned off entirely', () => {
      const status: MetadataStatus = {
        container: { name: 'Station', type: 'station' },
        streamInfo: 'A - B'
      };
      expect(classify(status, { allowRadio: false })).toEqual({
        scrobbleable: false,
        reason: 'not-music'
      });
    });
  });

  describe('handoff sources', () => {
    // AirPlay / Spotify Connect: a named track with no service anywhere.
    const handoff: MetadataStatus = {
      currentItem: {
        track: { type: 'track', name: 'Some Song', artist: { name: 'Some Uploader' } }
      }
    };

    it('declines by default', () => {
      expect(classify(handoff)).toEqual({ scrobbleable: false, reason: 'handoff-source' });
    });

    it('accepts when opted in', () => {
      const result = classify(handoff, { allowHandoff: true });
      expect(result.scrobbleable).toBe(true);
    });

    it('does not mistake a named service for handoff', () => {
      expect(looksLikeHandoff(musicTrack())).toBe(false);
    });
  });
});

describe('parseStreamInfo', () => {
  it.each([
    ['Yo La Tengo - Autumn Sweater', { artist: 'Yo La Tengo', track: 'Autumn Sweater' }],
    ['Air – La Femme d’Argent', { artist: 'Air', track: 'La Femme d’Argent' }],
    ['Boards of Canada — Roygbiv', { artist: 'Boards of Canada', track: 'Roygbiv' }]
  ])('splits %j', (input, expected) => {
    expect(parseStreamInfo(input)).toEqual(expected);
  });

  it.each([
    ['no separator at all'],
    ['Artist - Title - Remix'],
    [' - Title'],
    ['Artist - '],
    ['AC/DC'],
    ['']
  ])('refuses to guess at %j', (input) => {
    expect(parseStreamInfo(input)).toBeUndefined();
  });

  it('does not split a hyphenated name lacking surrounding spaces', () => {
    // "Jean-Michel Jarre" must not become artist "Jean", track "Michel Jarre".
    expect(parseStreamInfo('Jean-Michel Jarre')).toBeUndefined();
  });
});
