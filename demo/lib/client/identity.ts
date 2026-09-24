const DEVICE_ID_KEY = 'space-meet-device-id';

/**
 * The LiveKit identity is a per-browser id kept in localStorage, not the typed display name:
 * joining again from the same browser replaces the earlier connection instead of adding a second
 * participant (see the /api/whoami heartbeat). A different browser or private window has its own id.
 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
