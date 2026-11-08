/**
 * localStorage that never throws. Safari with "Block All Cookies" (and some embedded/private
 * contexts) throws `SecurityError` on any access, which would otherwise unmount the call UI when it
 * happens during render. A preference that can't be stored just isn't remembered.
 */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; the in-memory choice still applies for this page.
  }
}
