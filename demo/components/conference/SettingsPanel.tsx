'use client';

import { MediaDeviceSelect, useLocalParticipant, VideoTrack } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { SettingsToggle } from './SettingsToggle';
import { BACKGROUND_EFFECTS, type BackgroundEffectControls } from './useBackgroundEffect';

/**
 * Rendered inside LiveKit's settings modal (.lk-settings-menu-modal, toggled by SettingsToggle).
 * Device lists use LiveKit's MediaDeviceSelect, which switches the active device on the room.
 */
export function SettingsPanel({ background }: { background: BackgroundEffectControls }) {
  const { localParticipant, cameraTrack } = useLocalParticipant();
  const cameraRef = cameraTrack
    ? { participant: localParticipant, source: Track.Source.Camera, publication: cameraTrack }
    : undefined;

  return (
    <div className="settings">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>Camera</h3>
        <div className="settings-preview">
          {cameraRef && !cameraTrack?.isMuted ? <VideoTrack trackRef={cameraRef} /> : <span className="muted">Camera is off</span>}
        </div>
        <MediaDeviceSelect kind="videoinput" />
      </section>

      <section className="settings-section">
        <h3>Background</h3>
        {!background.supported ? (
          <p className="muted">This browser doesn&apos;t support background effects.</p>
        ) : (
          <>
            {!background.cameraOn && <p className="muted">Turn your camera on to preview effects.</p>}
            <div className="effects-grid">
              {BACKGROUND_EFFECTS.map(({ effect, label, preview }) => (
                <button
                  key={effect.id}
                  type="button"
                  className="effect-option"
                  aria-pressed={background.effect.id === effect.id}
                  disabled={background.applying}
                  style={preview ? { backgroundImage: `url(${preview})` } : undefined}
                  onClick={() => background.setEffect(effect)}
                >
                  {label}
                </button>
              ))}
            </div>
            {background.error && <p className="error-text">{background.error}</p>}
          </>
        )}
      </section>

      <section className="settings-section">
        <h3>Microphone</h3>
        <MediaDeviceSelect kind="audioinput" />
      </section>

      <section className="settings-section">
        <h3>Speaker</h3>
        <MediaDeviceSelect kind="audiooutput" />
      </section>

      <div className="settings-footer">
        <SettingsToggle>Done</SettingsToggle>
      </div>
    </div>
  );
}
