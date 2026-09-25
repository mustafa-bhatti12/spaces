const DEVICE_ID_KEY = 'space-meet-device-id';
const DISPLAY_NAME_KEY = 'spaces-display-name';

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

/** Retrieve the persisted display name entered on this device, if any. */
export function getSavedDisplayName(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(DISPLAY_NAME_KEY) || '';
}

/** Save the user's chosen display name so they don't have to retype it next time. */
export function saveDisplayName(name: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = name.trim();
  if (trimmed) {
    localStorage.setItem(DISPLAY_NAME_KEY, trimmed);
  }
}
