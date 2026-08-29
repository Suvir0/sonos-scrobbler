/**
 * How this service names itself to the outside world.
 *
 * One place, because the name reaches four audiences that must agree: the Sonos consent
 * screen, the `media_player` field ListenBrainz stores against every listen, the
 * User-Agent every outbound request carries, and the pages a user reads. A mismatch
 * between them is how a service ends up with two identities and one confused support
 * inbox.
 */

export const APP_NAME = 'Scrobbler for Sonos';

/** Kept in step with package.json by hand; it appears only in the User-Agent. */
export const APP_VERSION = '1.0.0';

export const APP_URL = 'https://scrobbler.suvir.net';

/**
 * Sent on every outbound request.
 *
 * ListenBrainz asks for a contactable User-Agent and Last.fm uses one when a key has to
 * be traced back to an application. The URL is that contact point, which is why it is
 * this constant and not `env.PUBLIC_BASE_URL`: a staging deployment or a fork running on
 * some other hostname should still route a question about this software back to the
 * project, not to whichever origin happens to be serving it.
 */
export const USER_AGENT = `ScrobblerForSonos/${APP_VERSION} ( ${APP_URL} )`;
