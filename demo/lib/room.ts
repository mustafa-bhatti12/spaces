/**
 * Room names are shared by URL and end up in recording filenames, so normalize the same way on
 * the client (lobby) and the server (every route that takes a room): lowercase, dashes, and only
 * characters token-service's recording-file check accepts.
 */
export function normalizeRoomName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);
}

/**
 * What the lobby's "Paste a meeting link or code" field accepts: a full meeting link
 * (`https://…/rooms/<name>`, optionally with a host's `#t=<token>` fragment, which is kept) or a bare
 * room name. Returns the path to open, or null when nothing usable was typed.
 */
export function meetingPathFromInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let name: string;
  let hash = '';
  try {
    const url = new URL(text);
    const match = /^\/rooms\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    name = normalizeRoomName(decodeURIComponent(match[1]));
    if (url.hash.startsWith('#t=')) hash = url.hash;
  } catch {
    name = normalizeRoomName(text.replace(/^\/?rooms\//, ''));
  }
  return name ? `/rooms/${name}${hash}` : null;
}
