'use client';

import type { TrackReferenceOrPlaceholder } from '@livekit/components-core';
import { TrackRefContext, usePersistentUserChoices, useRoomContext } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Led } from '../ui/Device';
import { DeviceKey } from './Dock';
import { Tile } from './Tile';

// Document Picture-in-Picture (Chrome/Edge 116+ desktop); not in TypeScript's DOM types yet.
interface DocumentPictureInPicture {
  readonly window: Window | null;
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}
const pipApi = () => (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
// Chrome 134+ calls this media-session action when you leave a tab that is using the camera or mic,
// and lets the handler open the window without a click. Not in the MediaSessionAction union yet.
const AUTO_PIP = 'enterpictureinpicture' as MediaSessionAction;

/** The new window starts blank: give it our stylesheets, fonts and LiveKit theme. */
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
      target.head.appendChild(style);
    } catch {
      // Cross-origin sheet: its rules can't be read, so link it instead.
      if (!sheet.href) continue;
      const link = target.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      target.head.appendChild(link);
    }
  }
  target.documentElement.className = document.documentElement.className;
  target.documentElement.lang = document.documentElement.lang;
  target.body.dataset.lkTheme = 'default';
}

/**
 * The call's floating window (Document Picture-in-Picture), like Meet's: it opens by itself when you
 * switch tabs during a call, and from the dock's More menu. Chrome closes one opened by a tab switch
 * when you come back; one you opened stays until you close it. `supported` is false outside
 * Chrome/Edge desktop and inside an iframe (/embed), where browsers refuse the window.
 */
export function useFloatingWindow(connected: boolean, title: string) {
  const [supported] = useState(() => window.top === window && Boolean(pipApi()));
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  const open = useCallback(async () => {
    const api = pipApi();
    if (!api || api.window) return;
    // Called straight from the click (or Chrome's tab-switch action): the browser requires that.
    const win = await api.requestWindow({ width: 360, height: 280 });
    copyStyles(win.document);
    win.document.title = title;
    win.addEventListener('pagehide', () => setPipWindow((current) => (current === win ? null : current)), { once: true });
    setPipWindow(win);
  }, [title]);

  useEffect(() => {
    if (!supported || !connected) return;
    try {
      navigator.mediaSession.setActionHandler(AUTO_PIP, () => void open().catch(() => {}));
    } catch {
      return; // this browser has no automatic picture-in-picture
    }
    return () => navigator.mediaSession.setActionHandler(AUTO_PIP, null);
  }, [supported, connected, open]);

  // Leaving the call closes it.
  useEffect(() => () => pipApi()?.window?.close(), []);

  const toggle = useCallback(() => {
    if (pipWindow) pipWindow.close();
    else void open().catch(() => {});
  }, [pipWindow, open]);

  return { supported, window: pipWindow, toggle };
}

/**
 * Who the floating window shows when nothing is on the stage: the remote person who spoke last, else
 * the first remote person to join, else you.
 */
export function floatingStage(tracks: TrackReferenceOrPlaceholder[]) {
  const cameras = tracks.filter((t) => t.source === Track.Source.Camera);
  const remote = cameras
    .filter((t) => !t.participant.isLocal)
    .sort(
      (a, b) =>
        (b.participant.lastSpokeAt?.getTime() ?? 0) - (a.participant.lastSpokeAt?.getTime() ?? 0) ||
        (a.participant.joinedAt?.getTime() ?? 0) - (b.participant.joinedAt?.getTime() ?? 0),
    );
  return remote[0] ?? cameras[0];
}

/** The floating window's content: one tile, REC while recording, and mic, camera and Leave keys. */
export function FloatingCall({ stage, recording }: { stage: TrackReferenceOrPlaceholder | undefined; recording: boolean }) {
  const room = useRoomContext();
  const { saveAudioInputEnabled, saveVideoInputEnabled } = usePersistentUserChoices();
  // Leave takes two clicks here: the window is small and there is no room for the Leave dialog.
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => {
    if (!confirmLeave) return;
    const timer = setTimeout(() => setConfirmLeave(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmLeave]);

  return (
    <div className="conference pip">
      <div className="pip-stage">
        {stage && (
          <TrackRefContext.Provider value={stage}>
            <Tile />
          </TrackRefContext.Provider>
        )}
        {recording && (
          <span className="pip-rec">
            <Led signal="alert" pulse label="Recording" />
            REC
          </span>
        )}
      </div>
      <div className="pip-keys" role="toolbar" aria-label="Call controls">
        <DeviceKey
          source={Track.Source.Microphone}
          on={{ icon: Mic, legend: 'Mic', label: 'Mute microphone' }}
          off={{ icon: MicOff, legend: 'Muted', label: 'Unmute microphone' }}
          onChange={(enabled, userInitiated) => userInitiated && saveAudioInputEnabled(enabled)}
        />
        <DeviceKey
          source={Track.Source.Camera}
          on={{ icon: Video, legend: 'Camera', label: 'Turn camera off' }}
          off={{ icon: VideoOff, legend: 'Camera', label: 'Turn camera on' }}
          onChange={(enabled, userInitiated) => userInitiated && saveVideoInputEnabled(enabled)}
        />
        <button
          type="button"
          className={`key pip-leave ${confirmLeave ? 'key-destroy' : 'key-danger'}`}
          aria-label={confirmLeave ? 'Confirm leaving the call' : 'Leave call'}
          title="Leave call"
          onClick={() => (confirmLeave ? void room.disconnect() : setConfirmLeave(true))}
        >
          <PhoneOff aria-hidden="true" />
          {confirmLeave && <span>Leave?</span>}
        </button>
      </div>
    </div>
  );
}
