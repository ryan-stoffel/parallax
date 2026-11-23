// The hosted browser client's links (0108), which the desktop and the phone both make.

/** Where the hosted client is served. */
export const HOSTED_CLIENT = "https://app.parallax.codes";

/** The hosted client's name for people: its address without the scheme. */
export const HOSTED_CLIENT_NAME = "app.parallax.codes";

/**
 * The link a browser takes its first computer from: the computer's host id in the fragment, which
 * no HTTP request carries, and no secret.
 */
export const connectLink = (hostId: string) => `${HOSTED_CLIENT}/#connect=${hostId}`;

/**
 * A guest link, from `guest/create`'s `fragment`. It holds the link's secret, so it's never kept
 * or logged: it goes to the clipboard or the share sheet and nowhere else.
 */
export const guestLink = (fragment: string) => `${HOSTED_CLIENT}/g#${fragment}`;

/**
 * Whether session `s` of `remote/sessions` is a web browser's at the hosted client. plxd doesn't
 * say yet (PLX-1633), so until its `RemoteSession` carries `hosted`, none is.
 */
export const isHostedSession = (s: object) => (s as { hosted?: boolean }).hosted === true;
