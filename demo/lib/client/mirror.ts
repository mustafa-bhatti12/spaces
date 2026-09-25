import { useCallback, useSyncExternalStore } from 'react';

const MIRROR_KEY = 'spaces-mirror-self-view';
const CHANGE_EVENT = 'spaces-mirror-change';

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

const read = () => localStorage.getItem(MIRROR_KEY) !== 'off';

/**
 * Whether your own camera is shown mirrored (on by default). Only your view changes: others
 * always receive the unmirrored video.
 */
export function useMirrorSelfView(): [boolean, (mirror: boolean) => void] {
  const mirror = useSyncExternalStore(subscribe, read, () => true);
  const setMirror = useCallback((next: boolean) => {
    localStorage.setItem(MIRROR_KEY, next ? 'on' : 'off');
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [mirror, setMirror];
}
