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
