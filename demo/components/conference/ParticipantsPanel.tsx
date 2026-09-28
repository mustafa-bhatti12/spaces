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
import { Hand, Mic, MicOff, ShieldMinus, ShieldPlus, Video, VideoOff } from 'lucide-react';
import { useState } from 'react';
import { SidePanel } from './SidePanel';
import { initials } from '../ui/Device';
import { SwitchRow } from '../ui/SwitchRow';
import { HAND_ATTRIBUTE } from './Tile';
import type { Hosting } from './useHosts';
import type { WaitingRoomControls } from './useWaitingRoom';
import { useEmbed } from '../embed/EmbedContext';

function ParticipantRow({
  participant,
  host,
  onSetHost,
}: {
  participant: Participant;
  host: boolean;
  /** Present when we host and this is someone else: make them a host, or stop them hosting. */
  onSetHost?: (host: boolean) => Promise<void>;
}) {
  const speaking = useIsSpeaking(participant);
  const hand = useParticipantAttribute(HAND_ATTRIBUTE, { participant });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { name: infoName, identity } = useParticipantInfo({ participant });
  const { isMuted: micMuted } = useTrackMutedIndicator({ participant, source: Track.Source.Microphone });
  const { isMuted: camMuted } = useTrackMutedIndicator({ participant, source: Track.Source.Camera });
  const name = infoName || identity || 'Guest';
  const status = error || (hand ? 'Hand raised' : speaking ? 'Speaking' : participant.isScreenShareEnabled ? 'Sharing screen' : '');
  const setHost = async () => {
    if (!onSetHost) return;
    setBusy(true);
    setError('');
    try {
      await onSetHost(!host);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const hostAction = host ? `Remove ${name} as host` : `Make ${name} a host`;

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
        {status && <span className={`person-status${error ? ' person-status-error' : hand ? ' person-status-hand' : ''}`}>{status}</span>}
      </span>
      <span className="person-icons">
        {hand && <Hand className="icon-hand" aria-label="Hand raised" />}
        {micMuted ? <MicOff className="icon-off" aria-label="Mic off" /> : <Mic aria-label="Mic on" />}
        {camMuted ? <VideoOff className="icon-off" aria-label="Camera off" /> : <Video aria-label="Camera on" />}
        <ConnectionQualityIndicator participant={participant} />
        {onSetHost && (
          <button type="button" className="person-action" disabled={busy} onClick={setHost} aria-label={hostAction} title={hostAction}>
            {host ? <ShieldMinus aria-hidden="true" /> : <ShieldPlus aria-hidden="true" />}
          </button>
        )}
      </span>
    </li>
  );
}

/** Host only: the waiting-room switch and everyone asking to join. */
function WaitingRoomSection({ lobby }: { lobby: WaitingRoomControls }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="waiting-section" aria-label="Waiting room">
      <SwitchRow
        label="Waiting room"
        hint={lobby.enabled ? 'New people ask to join, and you let them in' : 'Anyone with the link joins straight away'}
        checked={lobby.enabled}
        disabled={busy}
        onChange={(next) => run(() => lobby.setEnabled(next))}
      />
      {error && <p className="note note-alert">{error}</p>}
      {lobby.pending.length > 0 && (
        <>
          <div className="waiting-head">
            <h3>
              Waiting to join <span className="side-panel-count">{lobby.pending.length}</span>
            </h3>
            {lobby.pending.length > 1 && (
              <button type="button" className="key key-go" disabled={busy} onClick={() => run(() => lobby.answer('all', true))}>
                Admit all
              </button>
            )}
          </div>
          <ul className="people-list">
            {lobby.pending.map((p) => (
              <li key={p.id} className="person">
                <span className="avatar" aria-hidden="true">
                  {initials(p.name)}
                </span>
                <span className="person-info">
                  <span className="person-name">{p.name}</span>
                </span>
                <span className="waiting-actions">
                  <button type="button" className="key" disabled={busy} onClick={() => run(() => lobby.answer([p.id], false))}>
                    Deny
                  </button>
                  <button type="button" className="key key-go" disabled={busy} onClick={() => run(() => lobby.answer([p.id], true))}>
                    Admit
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Everyone in the room, raised hands first, then speakers, then by name. Hosts also see the waiting
 * room, and can make anyone else a host (or stop them hosting).
 */
export function ParticipantsPanel({
  hosting,
  lobby,
  onClose,
}: {
  hosting: Hosting;
  lobby: WaitingRoomControls | null;
  onClose: () => void;
}) {
  const participants = useParticipants();
  const embed = useEmbed();
  const sorted = [...participants].sort((a, b) => {
    const handA = a.attributes[HAND_ATTRIBUTE] ? 1 : 0;
    const handB = b.attributes[HAND_ATTRIBUTE] ? 1 : 0;
    if (handA !== handB) return handB - handA;
    if (a.isSpeaking !== b.isSpeaking) return a.isSpeaking ? -1 : 1;
    return (a.name || a.identity).localeCompare(b.name || b.identity);
  });
  return (
    <SidePanel title="People" count={participants.length} onClose={onClose}>
      {lobby && <WaitingRoomSection lobby={lobby} />}
      <ul className="people-list">
        {sorted.map((p) => (
          <ParticipantRow
            key={p.identity}
            participant={p}
            host={hosting.hosts.includes(p.identity)}
            onSetHost={!embed && hosting.isHost && !p.isLocal ? (host) => hosting.setHost(p.identity, host) : undefined}
          />
        ))}
      </ul>
    </SidePanel>
  );
}
