'use client';

import {
  AudioTrack,
  ConnectionQualityIndicator,
  isTrackReference,
  ParticipantTile,
  useEnsureTrackRef,
  useIsEncrypted,
  useParticipantAttribute,
  useParticipantInfo,
  useTrackMutedIndicator,
  VideoTrack,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { Hand, Lock, MicOff, MonitorUp } from 'lucide-react';
import { initials } from '../ui/Device';
import { MIRROR_ATTRIBUTE } from '@/lib/client/mirror';

export const HAND_ATTRIBUTE = 'hand';

/**
 * LiveKit's ParticipantTile (which keeps its speaking/muted data attributes and focus toggle), with
 * our own content: video or audio, an initials placeholder, a raised-hand badge from the
 * participant's `hand` attribute, and a name plate.
 */
export function Tile() {
  const trackRef = useEnsureTrackRef();
  const isEncrypted = useIsEncrypted(trackRef.participant);
  const hand = useParticipantAttribute(HAND_ATTRIBUTE, { participant: trackRef.participant });
  const mirror = useParticipantAttribute(MIRROR_ATTRIBUTE, { participant: trackRef.participant });
  const { name, identity } = useParticipantInfo({ participant: trackRef.participant });
  const { isMuted: micMuted } = useTrackMutedIndicator({
    participant: trackRef.participant,
    source: Track.Source.Microphone,
  });
  const isCamera = trackRef.source === Track.Source.Camera;
  const label = name || identity || 'Guest';
  // Attributes arrive just after a participant/tile is created. Mirroring defaults to on, so
  // never render an uninitialized attribute as off and briefly show the wrong orientation.

  return (
    <ParticipantTile trackRef={trackRef} data-camera-mirror={mirror === 'off' ? 'off' : 'on'}>
      {isTrackReference(trackRef) &&
      (trackRef.publication?.kind === 'video' || trackRef.source === Track.Source.Camera || trackRef.source === Track.Source.ScreenShare) ? (
        <VideoTrack trackRef={trackRef} />
      ) : (
        isTrackReference(trackRef) && <AudioTrack trackRef={trackRef} />
      )}
      <div className="lk-participant-placeholder">
        <span className="avatar avatar-xl" aria-hidden="true">
          {initials(label)}
        </span>
      </div>
      {isCamera && hand && (
        <span className="tile-hand" role="img" aria-label="Hand raised">
          <Hand aria-hidden="true" />
        </span>
      )}
      <div className="lk-participant-metadata">
        <div className="lk-participant-metadata-item name-plate">
          {isCamera ? (
            <>
              {isEncrypted && <Lock aria-label="End-to-end encrypted" />}
              {micMuted && <MicOff className="name-plate-muted" aria-label="Muted" />}
              <span className="name-plate-text">
                {label}
                {trackRef.participant.isLocal && <span className="name-plate-you"> (you)</span>}
              </span>
            </>
          ) : (
            <>
              <MonitorUp aria-hidden="true" />
              <span className="name-plate-text">{label}&apos;s screen</span>
            </>
          )}
        </div>
        <ConnectionQualityIndicator className="lk-participant-metadata-item" />
      </div>
    </ParticipantTile>
  );
}
