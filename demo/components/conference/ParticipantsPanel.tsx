'use client';

import {
  ConnectionQualityIndicator,
  TrackMutedIndicator,
  useIsSpeaking,
  useParticipantAttribute,
  useParticipants,
} from '@livekit/components-react';
import { type Participant, Track } from 'livekit-client';
import { HAND_ATTRIBUTE } from './Tile';

function ParticipantRow({ participant }: { participant: Participant }) {
  const speaking = useIsSpeaking(participant);
  const hand = useParticipantAttribute(HAND_ATTRIBUTE, { participant });
  const name = participant.name || participant.identity;
  return (
    <li className={`participant-row${speaking ? ' speaking' : ''}`}>
      <span className="participant-avatar">{name.trim().charAt(0).toUpperCase() || '?'}</span>
      <span className="participant-info">
        <span className="name">
          {name}
          {participant.isLocal && ' (you)'}
        </span>
        <span className="sub">{speaking ? 'Speaking' : participant.isScreenShareEnabled ? 'Sharing screen' : ' '}</span>
      </span>
      <span className="participant-icons">
        {hand && (
          <span className="hand" title="Hand raised">
            ✋
          </span>
        )}
        <TrackMutedIndicator trackRef={{ participant, source: Track.Source.Microphone }} />
        <TrackMutedIndicator trackRef={{ participant, source: Track.Source.Camera }} />
        <ConnectionQualityIndicator participant={participant} />
      </span>
    </li>
  );
}

/** Everyone in the room, raised hands first, then speakers, then by name. */
export function ParticipantsPanel({ onClose }: { onClose: () => void }) {
  const participants = useParticipants();
  const sorted = [...participants].sort((a, b) => {
    const handA = a.attributes[HAND_ATTRIBUTE] ? 1 : 0;
    const handB = b.attributes[HAND_ATTRIBUTE] ? 1 : 0;
    if (handA !== handB) return handB - handA;
    if (a.isSpeaking !== b.isSpeaking) return a.isSpeaking ? -1 : 1;
    return (a.name || a.identity).localeCompare(b.name || b.identity);
  });
  return (
    <aside className="side-panel" aria-label="Participants">
      <div className="side-panel-header">
        <span>People ({participants.length})</span>
        <button type="button" className="lk-button lk-close-button" onClick={onClose} aria-label="Close participants">
          ✕
        </button>
      </div>
      <ul className="side-panel-body lk-list">
        {sorted.map((p) => (
          <ParticipantRow key={p.identity} participant={p} />
        ))}
      </ul>
    </aside>
  );
}
