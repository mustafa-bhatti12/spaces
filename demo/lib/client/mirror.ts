import { useCallback, useSyncExternalStore } from 'react';

const MIRROR_KEY = 'spaces-mirror-self-view';
const CHANGE_EVENT = 'spaces-mirror-change';
export const MIRROR_ATTRIBUTE = 'cameraMirror';

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

const read = () => localStorage.getItem(MIRROR_KEY) !== 'off';

/** Whether this participant's camera should be shown mirrored to everyone. */
export function useMirrorVideo(): [boolean, (mirror: boolean) => void] {
  const mirror = useSyncExternalStore(subscribe, read, () => true);
  const setMirror = useCallback((next: boolean) => {
    localStorage.setItem(MIRROR_KEY, next ? 'on' : 'off');
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [mirror, setMirror];
}
