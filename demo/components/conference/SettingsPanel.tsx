'use client';

import { MediaDeviceSelect, useLocalParticipant, VideoTrack } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { ChevronDown, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useMirrorVideo } from '@/lib/client/mirror';
import { SidePanel } from './SidePanel';
import type { BackgroundEffectControls } from './useBackgroundEffect';
import { BACKGROUND_EFFECTS } from './useBackgroundEffect';

const COLLAPSE_CAMERA_AFTER = 4;

function CameraDeviceSelect() {
  const listRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const collapsible = count > COLLAPSE_CAMERA_AFTER;

  useEffect(() => {
    const updateCount = () => setCount(listRef.current?.querySelectorAll('.lk-media-device-select li').length ?? 0);
    updateCount();
    const observer = new MutationObserver(updateCount);
    if (listRef.current) observer.observe(listRef.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div className={`settings-camera-devices${collapsible && !expanded ? ' is-collapsed' : ''}`} ref={listRef}>
      {collapsible && (
        <button
          type="button"
          className="device-list-toggle"
          aria-expanded={expanded}
          aria-controls="camera-device-list"
          onClick={() => setExpanded((open) => !open)}
        >
          <span>Choose camera · {count} available</span>
          <ChevronDown aria-hidden="true" />
        </button>
      )}
      <div id="camera-device-list" className="device-list-content">
        <MediaDeviceSelect kind="videoinput" />
      </div>
    </div>
  );
}

/**
 * Devices and background effects, as a side panel so the call stays visible while you adjust.
 * Device lists use LiveKit's MediaDeviceSelect, which switches the active device on the room.
 */
export function SettingsPanel({ background, onClose }: { background: BackgroundEffectControls; onClose: () => void }) {
  const { localParticipant, cameraTrack } = useLocalParticipant();
  const [mirror, setMirror] = useMirrorVideo();
  const cameraRef = cameraTrack
    ? { participant: localParticipant, source: Track.Source.Camera, publication: cameraTrack }
    : undefined;

  return (
    <SidePanel title="Settings" onClose={onClose}>
      <div className="settings">
        <section className="settings-section" aria-labelledby="set-camera">
          <h3 id="set-camera">Camera</h3>
          <div className="settings-preview">
            {cameraRef && !cameraTrack?.isMuted ? (
              <VideoTrack trackRef={cameraRef} />
            ) : (
              <span className="settings-preview-off">
                <VideoOff aria-hidden="true" />
                Camera is off
              </span>
            )}
          </div>
          <CameraDeviceSelect />
          <button
            type="button"
            role="switch"
            aria-checked={mirror}
            className="switch-row"
            onClick={() => setMirror(!mirror)}
          >
            <span className="switch-text">
              <span className="switch-label">Mirror my video</span>
            </span>
            <span className="switch" aria-hidden="true" />
          </button>
        </section>

        <section className="settings-section" aria-labelledby="set-bg">
          <h3 id="set-bg">Background</h3>
          {!background.supported ? (
            <p className="note">This browser doesn&apos;t support background effects.</p>
          ) : (
            <>
              {!background.cameraOn && <p className="note">Turn your camera on to see the effect.</p>}
              <div className="effects-grid">
                {BACKGROUND_EFFECTS.map(({ effect, label, preview }) => (
                  <button
                    key={effect.id}
                    type="button"
                    className={`effect effect-${effect.id}`}
                    aria-pressed={background.effect.id === effect.id}
                    disabled={background.applying}
                    style={preview ? { backgroundImage: `url(${preview})` } : undefined}
                    onClick={() => background.setEffect(effect)}
                  >
                    <span className="effect-label">{label}</span>
                  </button>
                ))}
              </div>
              {background.error && (
                <p className="note note-alert" role="alert">
                  {background.error}
                </p>
              )}
            </>
          )}
        </section>

        <section className="settings-section" aria-labelledby="set-mic">
          <h3 id="set-mic">Microphone</h3>
          <MediaDeviceSelect kind="audioinput" />
        </section>

        <section className="settings-section" aria-labelledby="set-speaker">
          <h3 id="set-speaker">Speaker</h3>
          <MediaDeviceSelect kind="audiooutput" />
        </section>
      </div>
    </SidePanel>
  );
}
