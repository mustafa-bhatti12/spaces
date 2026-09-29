'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import {
  MediaDeviceMenu,
  ParticipantPlaceholder,
  TrackToggle,
  usePersistentUserChoices,
  usePreviewTracks,
} from '@livekit/components-react';
import { facingModeFromLocalTrack, LocalVideoTrack, Track, type LocalAudioTrack } from 'livekit-client';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { getSavedDisplayName, saveDisplayName } from '@/lib/client/identity';
import { MIC_PROCESSING } from '@/lib/client/mic';
import { useMirrorVideo } from '@/lib/client/mirror';

// LiveKit's own placeholder for "no camera chosen yet". Cameras have no device with this id
// (Chrome only has one for audio), so it must never reach getUserMedia or a device switch.
const NO_CAMERA_CHOSEN = 'default';

interface PreJoinProps {
  defaults: Partial<LocalUserChoices>;
  joinLabel: string;
  userLabel: string;
  /** A join is in flight: the Join button is disabled. */
  busy: boolean;
  onSubmit: (values: LocalUserChoices) => void;
  onError: (error: Error) => void;
  /** Rendered between the name field and the Join button (the host's waiting-room switch). */
  beforeJoin?: ReactNode;
  /** The name is fixed (embedded calls): shown as text instead of the input, and used on submit. */
  lockedName?: string;
}

/**
 * LiveKit's `PreJoin` with the same markup (so `.lk-prejoin` styles still apply), without the
 * camera reopening it causes. `PreJoin` asks for a first-visit camera by `exact: 'default'` (fails,
 * retried), and its device menus call `setDeviceId` on mount, which restarts a camera that just
 * opened; each open takes a real camera about a second. Here the preview opens each device once,
 * and the camera's real id is saved for the call and the next visit.
 * `onError` must be referentially stable: `usePreviewTracks` reopens the camera when it changes.
 *
 * The name field is controlled and starts with the name saved on the last join. Join is never
 * disabled for an empty-looking field: browsers can show a value (autofill, restored form state,
 * typing before hydration) that React hasn't heard about, which left a filled field with a dead
 * button. Submitting reads the field itself, and an empty name just flags the field.
 */
export function PreJoin({ defaults, joinLabel, userLabel, busy, onSubmit, onError, beforeJoin, lockedName }: PreJoinProps) {
  const {
    userChoices: initial,
    saveAudioInputDeviceId,
    saveAudioInputEnabled,
    saveVideoInputDeviceId,
    saveVideoInputEnabled,
  } = usePersistentUserChoices({ defaults });

  const [audioEnabled, setAudioEnabled] = useState(initial.audioEnabled);
  const [videoEnabled, setVideoEnabled] = useState(initial.videoEnabled);
  const [audioDeviceId, setAudioDeviceId] = useState(initial.audioDeviceId);
  const [videoDeviceId, setVideoDeviceId] = useState(initial.videoDeviceId);
  const [mirror] = useMirrorVideo();
  const [username, setUsername] = useState(lockedName ?? '');
  const [nameMissing, setNameMissing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  // After hydration (the page is server-rendered, localStorage isn't): keep anything already in the
  // field, otherwise fill in the saved name.
  useEffect(() => {
    const shown = nameInput.current?.value ?? '';
    setUsername((current) => current || shown || getSavedDisplayName());
  }, []);

  useEffect(() => {
    saveAudioInputEnabled(audioEnabled);
  }, [audioEnabled, saveAudioInputEnabled]);
  useEffect(() => {
    saveVideoInputEnabled(videoEnabled);
  }, [videoEnabled, saveVideoInputEnabled]);
  useEffect(() => {
    saveAudioInputDeviceId(audioDeviceId);
  }, [audioDeviceId, saveAudioInputDeviceId]);
  useEffect(() => {
    saveVideoInputDeviceId(videoDeviceId);
  }, [videoDeviceId, saveVideoInputDeviceId]);
  // Like PreJoin, the preview follows the devices chosen at load (captured once: the hook's
  // userChoices update on every save, and a changed option recreates the tracks); later picks
  // switch the running track through the device menu instead.
  const [loaded] = useState(() => ({
    mic: initial.audioDeviceId,
    camera: initial.videoDeviceId === NO_CAMERA_CHOSEN ? undefined : initial.videoDeviceId,
  }));
  const tracks = usePreviewTracks(
    {
      audio: audioEnabled ? { deviceId: loaded.mic, ...MIC_PROCESSING } : false,
      video: videoEnabled ? (loaded.camera ? { deviceId: loaded.camera } : true) : false,
    },
    onError,
  );
  const videoTrack = useMemo(
    () => tracks?.find((t): t is LocalVideoTrack => t.kind === Track.Kind.Video),
    [tracks],
  );
  const audioTrack = useMemo(
    () => tracks?.find((t): t is LocalAudioTrack => t.kind === Track.Kind.Audio),
    [tracks],
  );
  // LiveKit's styles mirror the preview of a front ("user") camera via this attribute.
  const facingMode = useMemo(
    () => (videoTrack ? facingModeFromLocalTrack(videoTrack).facingMode : 'undefined'),
    [videoTrack],
  );

  // Remember the camera the browser actually opened, so the call (and the next visit) asks for it
  // by its real id instead of the placeholder.
  useEffect(() => {
    if (!videoTrack) return;
    let cancelled = false;
    videoTrack.getDeviceId(false).then((id) => {
      if (!cancelled && id) setVideoDeviceId((current) => (current === NO_CAMERA_CHOSEN ? id : current));
    });
    return () => {
      cancelled = true;
    };
  }, [videoTrack]);

  const videoEl = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoEl.current;
    if (!el || !videoTrack) return;
    videoTrack.attach(el);
    return () => {
      videoTrack.detach(el);
    };
  }, [videoTrack]);

  const choices: LocalUserChoices = { username, videoEnabled, videoDeviceId, audioEnabled, audioDeviceId };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (lockedName) {
      onSubmit({ ...choices, username: lockedName });
      return;
    }
    const name = (nameInput.current?.value ?? username).trim();
    if (!name) {
      setNameMissing(true);
      nameInput.current?.focus();
      return;
    }
    saveDisplayName(name);
    onSubmit({ ...choices, username: name });
  };

  return (
    <div className="lk-prejoin" data-mirror={mirror ? 'on' : 'off'}>
      <div className="lk-video-container">
        {videoTrack && <video ref={videoEl} width="1280" height="720" data-lk-facing-mode={facingMode} />}
        {(!videoTrack || !videoEnabled) && (
          <div className="lk-camera-off-note">
            <ParticipantPlaceholder />
          </div>
        )}
      </div>
      <div className="lk-button-group-container">
        <div className="lk-button-group audio">
          <TrackToggle initialState={audioEnabled} source={Track.Source.Microphone} onChange={setAudioEnabled}>
            Microphone
          </TrackToggle>
          <div className="lk-button-group-menu">
            <MediaDeviceMenu
              // No initialSelection on either menu: with one, the menu calls setDeviceId on mount,
              // which always restarts the device (the track holds {exact: id}, never equal to the
              // plain id). The preview already opened the chosen device; picks still switch it.
              kind="audioinput"
              disabled={!audioTrack}
              tracks={{ audioinput: audioTrack }}
              onActiveDeviceChange={(_, id) => setAudioDeviceId(id)}
            />
          </div>
        </div>
        <div className="lk-button-group video">
          <TrackToggle initialState={videoEnabled} source={Track.Source.Camera} onChange={setVideoEnabled}>
            Camera
          </TrackToggle>
          <div className="lk-button-group-menu">
            <MediaDeviceMenu
              kind="videoinput"
              disabled={!videoTrack}
              tracks={{ videoinput: videoTrack }}
              onActiveDeviceChange={(_, id) => setVideoDeviceId(id)}
            />
          </div>
        </div>
      </div>

      <form className="lk-username-container" onSubmit={submit}>
        {lockedName ? (
          <p className="prejoin-locked-name">{lockedName}</p>
        ) : (
        <input
          ref={nameInput}
          className="lk-form-control"
          id="username"
          name="display-name"
          type="text"
          value={username}
          placeholder={userLabel}
          onChange={(e) => {
            setUsername(e.target.value);
            if (e.target.value.trim()) setNameMissing(false);
          }}
          autoComplete="off"
          aria-invalid={nameMissing || undefined}
          aria-describedby={nameMissing ? 'username-missing' : undefined}
        />
        )}
        {nameMissing && (
          <p id="username-missing" className="prejoin-name-missing" role="alert">
            Enter your name to join
          </p>
        )}
        {beforeJoin}
        <button className="lk-button lk-join-button" type="submit" disabled={busy}>
          {joinLabel}
        </button>
      </form>
    </div>
  );
}
