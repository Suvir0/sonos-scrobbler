export interface MusicBrainzCandidate {
  id: string;
  title: string;
  /**
   * Individual credited performer names, unjoined. A collaboration release-group credits
   * every performer separately (e.g. ["Dave", "Central Cee"]); matching against each name
   * lets a query for just the primary credit ("Dave") still find it, without falling back
   * to a fuzzy substring search against a joined display string.
   */
  artists: string[];
  score: number;
}

export interface MusicBrainzReleaseGroupMatch {
  releaseGroupId: string;
}

export function normalizeMetadata(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const EDITION_LABEL =
  'explicit(?:\\s+version)?|clean(?:\\s+version)?|(?:super\\s+)?deluxe(?:\\s+edition)?|expanded(?:\\s+edition)?|special\\s+edition|digital\\s+edition|bonus\\s+tracks?(?:\\s+(?:version|edition))?|(?:(?:\\d{4}|\\d+(?:st|nd|rd|th))\\s+)?anniversary(?:\\s+edition)?|(?:\\d{4}\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?';
const BRACKETED_ARTWORK_EDITION = new RegExp(
  `\\s*[([]\\s*(?:${EDITION_LABEL})\\s*[)\\]]\\s*$`,
  'i'
);
const SEPARATED_ARTWORK_EDITION = new RegExp(`\\s*[-–—:]\\s*(?:${EDITION_LABEL})\\s*$`, 'i');
const UNSEPARATED_ARTWORK_EDITION = new RegExp(
  `\\s+(?:explicit(?:\\s+version)?|clean(?:\\s+version)?|(?:super\\s+)?deluxe\\s+edition|expanded\\s+edition|special\\s+edition|digital\\s+edition|bonus\\s+tracks?(?:\\s+(?:version|edition))|(?:(?:\\d{4}|\\d+(?:st|nd|rd|th))\\s+)?anniversary\\s+edition|(?:\\d{4}\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?)\\s*$`,
  'i'
);
const EDITION_LABEL_ONLY = new RegExp(`^(?:${EDITION_LABEL})$`, 'i');
const TRAILING_BRACKET_GROUP = /[([]([^()[\]]*)[)\]]\s*$/;
const WHITESPACE = /\s/;

/**
 * Player metadata sometimes appends an edition marker *and* a separate release subtitle, e.g.
 * "Eternal Atake (Deluxe) [LUV vs. The World 2]". Neither trailing regex above fires
 * because the outermost bracket ("[LUV vs. The World 2]") isn't edition vocabulary, which
 * blocks stripping the "(Deluxe)" marker beneath it. Peel trailing bracket groups one at a
 * time; if any of them is a recognized edition label, drop the whole run. A run with no
 * recognized label (e.g. a genuine subtitle like "[Live]") is left untouched.
 */
function stripTrailingEditionBracketRun(value: string): string {
  const peeled: string[] = [];
  let working = value;
  for (
    let match = TRAILING_BRACKET_GROUP.exec(working);
    match;
    match = TRAILING_BRACKET_GROUP.exec(working)
  ) {
    peeled.push(match[1]?.trim() ?? '');
    working = working.slice(0, match.index).trim();
  }
  if (!peeled.length) return value;
  return peeled.some((label) => EDITION_LABEL_ONLY.test(label)) ? working : value;
}

/**
 * Removes trailing playback-service edition labels that are not part of the canonical
 * MusicBrainz release-group title. The original album value remains untouched for display.
 */
export function albumForArtwork(value: string): string {
  const original = value.trim();
  let album = original;
  for (let pass = 0; pass < 4; pass += 1) {
    const stripped = stripTrailingEditionBracketRun(
      album
        .replace(BRACKETED_ARTWORK_EDITION, '')
        .replace(SEPARATED_ARTWORK_EDITION, '')
        .replace(UNSEPARATED_ARTWORK_EDITION, '')
        .trim()
    );
    if (!stripped || stripped === album) break;
    album = stripped;
  }
  return album || original;
}

export function artworkCacheKey(artist: string, album: string): string {
  return `${normalizeMetadata(artist)}\u0000${normalizeMetadata(albumForArtwork(album))}`;
}

/**
 * Player display lines can append composers/credits with spaced slashes. MusicBrainz's
 * release-group artist is normally the primary performer, so query that first credit.
 * Names containing an ordinary slash (for example AC/DC) remain untouched.
 */
export function primaryArtistForArtwork(value: string): string {
  const trimmed = value.trim();
  for (let index = trimmed.indexOf('/'); index > 0; index = trimmed.indexOf('/', index + 1)) {
    const before = trimmed[index - 1];
    const after = trimmed[index + 1];
    if (!before || !after || !WHITESPACE.test(before) || !WHITESPACE.test(after)) continue;
    return trimmed.slice(0, index).trim() || trimmed;
  }
  return trimmed;
}

/** Selects exact metadata before Cover Art Archive availability is queried separately. */
export function selectMusicBrainzReleaseGroup(
  artist: string,
  album: string,
  candidates: readonly MusicBrainzCandidate[]
): MusicBrainzReleaseGroupMatch | undefined {
  const normalizedArtist = normalizeMetadata(artist);
  const normalizedAlbum = normalizeMetadata(albumForArtwork(album));
  if (!normalizedArtist || !normalizedAlbum) return undefined;

  const eligible = candidates
    .slice(0, 5)
    .filter(
      (candidate) =>
        candidate.score >= 95 &&
        candidate.artists.some((name) => normalizeMetadata(name) === normalizedArtist) &&
        normalizeMetadata(albumForArtwork(candidate.title)) === normalizedAlbum
    )
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const best = eligible[0];
  if (!best || (eligible[1] && eligible[1].score === best.score)) return undefined;
  return { releaseGroupId: best.id };
}
