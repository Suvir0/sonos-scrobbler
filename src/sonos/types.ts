/**
 * The shapes the Sonos cloud Control API actually sends us.
 *
 * Hand-written rather than generated: the published OpenAPI marks `currentItem` and
 * `nextItem` as required on `metadataStatus`, but the docs also warn that "some of
 * these objects are still in development" and that apps must ignore what they cannot
 * handle. Everything below is therefore optional and every consumer must cope with
 * its absence — line-in sends a `container` and nothing else at all.
 */

export type SonosNamespace = 'groups' | 'playback' | 'playbackMetadata';

/** Values seen in `container.type` and `track.type`. Open-ended by design. */
export type SonosContainerType =
  | 'album'
  | 'artist'
  | 'audiobook'
  | 'container'
  | 'episode'
  | 'item'
  | 'linein'
  | 'linein.homeTheater'
  | 'playlist'
  | 'show'
  | 'station'
  | 'station.broadcast'
  | 'track'
  | 'trackList'
  | 'trackList.program'
  | (string & {});

export interface MusicObjectId {
  serviceId?: string;
  objectId?: string;
  accountId?: string;
}

export interface SonosService {
  id?: string;
  name?: string;
}

export interface SonosArtist {
  name: string;
  imageUrl?: string;
  id?: MusicObjectId;
}

export interface SonosAlbum {
  name: string;
  artist?: SonosArtist;
  imageUrl?: string;
  id?: MusicObjectId;
}

export interface SonosTrack {
  type?: SonosContainerType;
  name?: string;
  album?: SonosAlbum;
  artist?: SonosArtist;
  imageUrl?: string;
  id?: MusicObjectId;
  /** Absent for live radio, which is why the unknown-duration rule exists. */
  durationMillis?: number;
  service?: SonosService;
  tags?: string[];
}

export interface SonosItem {
  id?: string;
  track?: SonosTrack;
}

export interface SonosContainer {
  name?: string;
  type?: SonosContainerType;
  id?: MusicObjectId;
  service?: SonosService;
  imageUrl?: string;
  tags?: string[];
}

/** Body of a `metadataStatus` event in the `playbackMetadata` namespace. */
export interface MetadataStatus {
  container?: SonosContainer;
  currentItem?: SonosItem;
  nextItem?: SonosItem;
  /** Free text, typically "Artist - Title", for stations with no `currentItem`. */
  streamInfo?: string;
}

export type PlaybackState =
  | 'PLAYBACK_STATE_BUFFERING'
  | 'PLAYBACK_STATE_IDLE'
  | 'PLAYBACK_STATE_PAUSED'
  | 'PLAYBACK_STATE_PLAYING';

/** Body of a `playbackStatus` event in the `playback` namespace. */
export interface PlaybackStatus {
  playbackState?: PlaybackState;
  /** Offset within the current track. Present on every event we care about. */
  positionMillis?: number;
  /**
   * How far the *outgoing* track got. This is the single most valuable field in the
   * whole API for scrobbling: on a track change it is a ground-truth final position,
   * so the elapsed clock never has to be trusted alone.
   */
  previousPositionMillis?: number;
  /** Cloud-queue only, per the docs. Must never be required. */
  itemId?: string;
  previousItemId?: string;
  queueVersion?: string;
  isDucking?: boolean;
  playModes?: Record<string, boolean>;
  availablePlaybackActions?: Record<string, boolean>;
}

export interface SonosPlayer {
  id: string;
  name?: string;
  capabilities?: string[];
}

export interface SonosGroup {
  id: string;
  name?: string;
  coordinatorId?: string;
  playbackState?: PlaybackState;
  playerIds?: string[];
}

/** Body of a `groupStatus` event, and the response to `getGroups`. */
export interface GroupsStatus {
  groups?: SonosGroup[];
  players?: SonosPlayer[];
}

export interface SonosHousehold {
  id: string;
  name?: string;
}
