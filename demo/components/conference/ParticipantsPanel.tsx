'use client';

import {
  ConnectionQualityIndicator,
  useIsSpeaking,
  useParticipantAttribute,
  useParticipantInfo,
  useParticipants,
  useTrackMutedIndicator,
} from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { Track } from 'livekit-client';
import { Hand, Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { SidePanel } from './SidePanel';
import { initials } from '../ui/Device';
import { HAND_ATTRIBUTE } from './Tile';

/** Set by token-service on the host's join token (see mintToken's `host`). */
const HOST_ATTRIBUTE = 'space.host';

function ParticipantRow({ participant }: { participant: Participant }) {
  const speaking = useIsSpeaking(participant);
  const hand = useParticipantAttribute(HAND_ATTRIBUTE, { participant });
  const host = useParticipantAttribute(HOST_ATTRIBUTE, { participant }) === 'true';
  const { name: infoName, identity } = useParticipantInfo({ participant });
  const { isMuted: micMuted } = useTrackMutedIndicator({ participant, source: Track.Source.Microphone });
  const { isMuted: camMuted } = useTrackMutedIndicator({ participant, source: Track.Source.Camera });
  const name = infoName || identity || 'Guest';
  const status = hand ? 'Hand raised' : speaking ? 'Speaking' : participant.isScreenShareEnabled ? 'Sharing screen' : '';

  return (
    <li className={`person${speaking ? ' person-speaking' : ''}`}>
      <span className="avatar" aria-hidden="true">
        {initials(name)}
      </span>
      <span className="person-info">
        <span className="person-name">
          {name}
          {participant.isLocal && <span className="person-you"> (you)</span>}
          {host && <span className="person-host">Host</span>}
        </span>
        {status && <span className={`person-status${hand ? ' person-status-hand' : ''}`}>{status}</span>}
      </span>
      <span className="person-icons">
        {hand && <Hand className="icon-hand" aria-label="Hand raised" />}
        {micMuted ? <MicOff className="icon-off" aria-label="Mic off" /> : <Mic aria-label="Mic on" />}
        {camMuted ? <VideoOff className="icon-off" aria-label="Camera off" /> : <Video aria-label="Camera on" />}
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
    <SidePanel title="People" count={participants.length} onClose={onClose}>
      <ul className="people-list">
        {sorted.map((p) => (
          <ParticipantRow key={p.identity} participant={p} />
        ))}
      </ul>
    </SidePanel>
  );
}
