'use client';

import {
  AudioTrack,
  ConnectionQualityIndicator,
  isTrackReference,
  LockLockedIcon,
  ParticipantName,
  ParticipantPlaceholder,
  ParticipantTile,
  ScreenShareIcon,
  TrackMutedIndicator,
  useEnsureTrackRef,
  useIsEncrypted,
  useParticipantAttribute,
  VideoTrack,
} from '@livekit/components-react';
import { Track } from 'livekit-client';

export const HAND_ATTRIBUTE = 'hand';

/**
 * LiveKit's ParticipantTile with its default content (video/audio, placeholder, mute + name,
 * connection quality), plus a raised-hand badge from the participant's `hand` attribute. Uses
 * LiveKit's children-override API rather than re-implementing the tile.
 */
export function Tile() {
  const trackRef = useEnsureTrackRef();
  const isEncrypted = useIsEncrypted(trackRef.participant);
  const hand = useParticipantAttribute(HAND_ATTRIBUTE, { participant: trackRef.participant });
  const isCamera = trackRef.source === Track.Source.Camera;

  return (
    <ParticipantTile trackRef={trackRef}>
      {isTrackReference(trackRef) &&
      (trackRef.publication?.kind === 'video' || trackRef.source === Track.Source.Camera || trackRef.source === Track.Source.ScreenShare) ? (
        <VideoTrack trackRef={trackRef} />
      ) : (
        isTrackReference(trackRef) && <AudioTrack trackRef={trackRef} />
      )}
      <div className="lk-participant-placeholder">
        <ParticipantPlaceholder />
      </div>
      {isCamera && hand && (
        <span className="tile-hand" title="Hand raised" aria-label="Hand raised">
          ✋
        </span>
      )}
      <div className="lk-participant-metadata">
        <div className="lk-participant-metadata-item">
          {isCamera ? (
            <>
              {isEncrypted && <LockLockedIcon style={{ marginRight: '0.25rem' }} />}
              <TrackMutedIndicator trackRef={{ participant: trackRef.participant, source: Track.Source.Microphone }} show="muted" />
              <ParticipantName />
            </>
          ) : (
            <>
              <ScreenShareIcon style={{ marginRight: '0.25rem' }} />
              <ParticipantName>&apos;s screen</ParticipantName>
            </>
          )}
        </div>
        <ConnectionQualityIndicator className="lk-participant-metadata-item" />
      </div>
    </ParticipantTile>
  );
}
