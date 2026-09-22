/**
 * Recovering a title that Sonos cut short.
 *
 * Sonos does not deliver long titles intact. Observed against real players: Apple Music
 * playing a 149-byte Thai title arrived through the Control API as its first 99 bytes,
 * and the same song over Spotify Connect reached a user's Last.fm as its first 62 bytes
 * — a different limit for a different path, but a hard cut either way, at a byte count
 * rather than a word. Nothing in the event says it happened, and there is no second
 * field to read the rest from, so the service was scrobbling the stub as a title of its
 * own and Last.fm was filing every such play under a song nobody has ever heard of.
 *
 * The rest of the title is therefore fetched from a catalogue. Last.fm's own is used:
 * it already holds the full title for anything ever scrobbled from the app that plays
 * it, its search is keyed by artist and title, and the service already has an API key
 * for it. The catalogue is only ever *asked* about a title that could plausibly have
 * been cut, and it is only ever *believed* when its answer begins with exactly what the
 * speaker reported, for the same artist. It is never allowed to substitute a different
 * song, and it never overrides a title it already knows in full.
 *
 * Pure apart from the injected catalogue, so every decision here is unit-tested without
 * a socket.
 */

/**
 * The shortest title, in UTF-8 bytes, that is worth checking.
 *
 * Every cut seen so far left at least 62 bytes behind. A cut that lands inside a
 * multi-byte character loses that character, and a trailing space goes with it, so the
 * floor sits a little under the shortest observed limit rather than on it. Below this a
 * title is taken at face value, which keeps the lookup — one request to Last.fm per
 * track start — away from the overwhelming majority of plays.
 */
export const MIN_TRUNCATED_BYTES = 56;

export interface CatalogueTrack {
  artist: string;
  name: string;
  /** Last.fm's popularity figure, used to rank competing completions. */
  listeners?: number;
}

/** Whatever can answer "which titles by this artist begin like this?". */
export interface TitleCatalogue {
  /** Tracks matching an artist and a (possibly partial) title, best first. */
  searchTracks(artist: string, track: string): Promise<CatalogueTrack[]>;
  /** The artist's tracks by popularity. The fallback when search finds nothing. */
  topTracks(artist: string): Promise<CatalogueTrack[]>;
}

export type CatalogueMatch =
  /** The catalogue knows this exact title: it is complete as reported. */
  | { kind: 'exact' }
  /** A longer title by the same artist begins with the reported one. */
  | { kind: 'longer'; title: string }
  /** The catalogue has nothing that begins like this. */
  | { kind: 'none' };

const encoder = new TextEncoder();

export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/** Whether a reported title is long enough to have hit one of Sonos's limits. */
export function mayBeTruncated(title: string): boolean {
  return utf8Length(title) >= MIN_TRUNCATED_BYTES;
}

/** Case, whitespace and Unicode form are not differences a scrobbler should care about. */
function normalize(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The catalogue's verdict on a reported title.
 *
 * Only entries by the same artist count. An exact match wins outright and means the
 * title is whole: a real title that happens to be long must not be "completed" into a
 * remix of itself. Otherwise the most-listened entry that begins with the reported
 * title is taken, with the shorter preferred on a tie because it assumes the least.
 */
export function matchCatalogue(
  observed: { artist: string; track: string },
  catalogue: readonly CatalogueTrack[]
): CatalogueMatch {
  const artist = normalize(observed.artist);
  const title = normalize(observed.track);
  if (!artist || !title) return { kind: 'none' };

  let best: CatalogueTrack | undefined;
  for (const entry of catalogue) {
    if (normalize(entry.artist) !== artist) continue;
    const name = normalize(entry.name);
    if (name === title) return { kind: 'exact' };
    if (!name.startsWith(title)) continue;
    if (!best || preferred(entry, best)) best = entry;
  }
  return best ? { kind: 'longer', title: best.name.trim() } : { kind: 'none' };
}

function preferred(candidate: CatalogueTrack, incumbent: CatalogueTrack): boolean {
  const byListeners = (candidate.listeners ?? 0) - (incumbent.listeners ?? 0);
  if (byListeners !== 0) return byListeners > 0;
  return candidate.name.length < incumbent.name.length;
}

/**
 * The whole title for a reported one, or undefined to keep what the speaker said.
 *
 * Search first, because it is aimed at this one title; the artist's top tracks second,
 * because search ranks loosely and a partial final word can push the right entry off
 * the page. An exact hit from search ends the lookup: the title is whole.
 *
 * Never throws. A catalogue that is down or rate-limited means a play scrobbled under
 * the reported title, which is what happened before this existed — not a lost play.
 */
export async function completeTitle(
  catalogue: TitleCatalogue,
  observed: { artist: string; track: string }
): Promise<string | undefined> {
  if (!mayBeTruncated(observed.track)) return undefined;
  try {
    const fromSearch = matchCatalogue(
      observed,
      await catalogue.searchTracks(observed.artist, observed.track)
    );
    if (fromSearch.kind === 'exact') return undefined;
    if (fromSearch.kind === 'longer') return fromSearch.title;

    const fromTop = matchCatalogue(observed, await catalogue.topTracks(observed.artist));
    return fromTop.kind === 'longer' ? fromTop.title : undefined;
  } catch {
    return undefined;
  }
}
