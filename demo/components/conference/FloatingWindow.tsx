'use client';

import type { TrackReferenceOrPlaceholder } from '@livekit/components-core';
import {
  isTrackReference,
  TrackRefContext,
  useIsSpeaking,
  useLocalParticipant,
  usePersistentUserChoices,
  useRoomContext,
  VideoTrack,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { Mic, MicOff, PhoneOff, Users, Video, VideoOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMirrorVideo } from '@/lib/client/mirror';
import { Led, Readout, ReadoutSegment } from '../ui/Device';
import { DeviceKey, elapsed, useSecondTick } from './Dock';
import { Tile } from './Tile';
import type { ActiveRecording } from './useRecording';

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
    // 16:9, so the face fills it edge to edge; people resize it from there.
    const win = await api.requestWindow({ width: 400, height: 225 });
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

/** At most this many faces in the window; more than that and they'd be thumbnails. */
const FLOATING_TILES = 4;

/**
 * Who the floating window shows: what's on the call's stage (a pin or a screen share) alone, else
 * everyone else's camera, loudest-recent first, capped at four. You are the corner self-view, not a
 * tile, so a one-to-one call shows the other person full size.
 */
export function floatingTracks(tracks: TrackReferenceOrPlaceholder[], stage: TrackReferenceOrPlaceholder | undefined) {
  if (stage) return { shown: [stage], hidden: 0 };
  const remote = tracks
    .filter((t) => t.source === Track.Source.Camera && !t.participant.isLocal)
    .sort(
      (a, b) =>
        (b.participant.lastSpokeAt?.getTime() ?? 0) - (a.participant.lastSpokeAt?.getTime() ?? 0) ||
        (a.participant.joinedAt?.getTime() ?? 0) - (b.participant.joinedAt?.getTime() ?? 0),
    );
  // Alone in the call: your own camera is the only thing to show.
  if (!remote.length) return { shown: tracks.filter((t) => t.participant.isLocal && t.source === Track.Source.Camera), hidden: 0 };
  return { shown: remote.slice(0, FLOATING_TILES), hidden: Math.max(0, remote.length - FLOATING_TILES) };
}

// The controls sleep after this long without the pointer moving, so the face fills the window.
const CONTROLS_IDLE_MS = 2500;

/**
 * The floating window's content, a pocket version of the call: every other face edge to edge (up to
 * four, or just the pinned one), a status chip with people, REC and your mute, your self-view in the
 * corner, and the dock's mic, camera and Leave keys in a pill that wakes when the pointer moves.
 */
export function FloatingCall({
  stage,
  tracks,
  recording,
  participantCount,
}: {
  stage: TrackReferenceOrPlaceholder | undefined;
  tracks: TrackReferenceOrPlaceholder[];
  recording: ActiveRecording | null;
  participantCount: number;
}) {
  const room = useRoomContext();
  const { localParticipant, isCameraEnabled, isMicrophoneEnabled } = useLocalParticipant();
  const speaking = useIsSpeaking(localParticipant);
  const [mirror] = useMirrorVideo();
  const { saveAudioInputEnabled, saveVideoInputEnabled } = usePersistentUserChoices();
  useSecondTick(Boolean(recording));

  // Leave takes two clicks here: the window is small and there is no room for the Leave dialog.
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => {
    if (!confirmLeave) return;
    const timer = setTimeout(() => setConfirmLeave(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmLeave]);

  const [awake, setAwake] = useState(true);
  const [held, setHeld] = useState(false); // pointer over the pill, or keyboard focus in it
  const idle = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setAwake(false), CONTROLS_IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(idle.current);
  }, [wake]);
  const controls = awake || held || confirmLeave;

  const { shown, hidden } = floatingTracks(tracks, stage);
  const self = tracks.find((t) => t.participant.isLocal && t.source === Track.Source.Camera);
  const showSelf = isCameraEnabled && isTrackReference(self) && !shown.some((t) => t.participant.isLocal);

  return (
    <div
      className="conference pip"
      data-controls={controls ? 'on' : 'off'}
      onPointerMove={wake}
      onPointerDown={wake}
      onPointerLeave={() => {
        clearTimeout(idle.current);
        setAwake(false);
      }}
    >
      <div className="pip-stage" data-tiles={shown.length}>
        {shown.map((track) => (
          // Keyed on who is shown, so a face fades in instead of swapping in place.
          <TrackRefContext.Provider key={`${track.participant.identity}:${track.source}`} value={track}>
            <Tile />
          </TrackRefContext.Provider>
        ))}
        {hidden > 0 && <span className="pip-more">+{hidden}</span>}
      </div>

      {/* Not a live region: the REC timer would be read out every second. */}
      <Readout className="pip-status">
        <ReadoutSegment>
          <Users aria-hidden="true" />
          <span aria-label={`${participantCount} in the call`}>{participantCount}</span>
        </ReadoutSegment>
        {recording && (
          <ReadoutSegment>
            <span className="readout-rec">
              <Led signal="alert" pulse label="Recording" />
              REC <span className="mono">{elapsed(recording.startedAt)}</span>
            </span>
          </ReadoutSegment>
        )}
        {!isMicrophoneEnabled && (
          <ReadoutSegment>
            <span className="readout-rec">
              <MicOff aria-hidden="true" />
              Muted
            </span>
          </ReadoutSegment>
        )}
      </Readout>

      {showSelf && (
        <div className="pip-self" data-mirror={mirror ? 'on' : 'off'}>
          <VideoTrack trackRef={self} />
        </div>
      )}

      <div
        className="pip-controls"
        role="toolbar"
        aria-label="Call controls"
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setHeld(false)}
        onKeyDown={(event) => event.key === 'Escape' && setConfirmLeave(false)}
      >
        <span className={`pip-mic${speaking && isMicrophoneEnabled ? ' pip-mic-speaking' : ''}`}>
          <DeviceKey
            source={Track.Source.Microphone}
            className="key-mic"
            on={{ icon: Mic, legend: 'Mic', label: 'Mute microphone' }}
            off={{ icon: MicOff, legend: 'Muted', label: 'Unmute microphone' }}
            onChange={(enabled, userInitiated) => userInitiated && saveAudioInputEnabled(enabled)}
          />
        </span>
        <DeviceKey
          source={Track.Source.Camera}
          on={{ icon: Video, legend: 'Camera', label: 'Turn camera off' }}
          off={{ icon: VideoOff, legend: 'Camera', label: 'Turn camera on' }}
          onChange={(enabled, userInitiated) => userInitiated && saveVideoInputEnabled(enabled)}
        />
        <button
          type="button"
          className="key pip-leave"
          data-confirm={confirmLeave || undefined}
          aria-label={confirmLeave ? 'Leave call: click again to confirm' : 'Leave call'}
          title="Leave call"
          onClick={() => (confirmLeave ? void room.disconnect() : setConfirmLeave(true))}
        >
          <PhoneOff aria-hidden="true" />
          <span className="pip-leave-text" aria-hidden={!confirmLeave}>
            Leave call
          </span>
        </button>
      </div>
    </div>
  );
}
