'use client';

import {
  useIsSpeaking,
  useParticipantAttribute,
  useParticipantInfo,
  useParticipants,
  useTrackMutedIndicator,
} from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { Track } from 'livekit-client';
import { Hand, Mic, MicOff, MoreVertical, Pin, PinOff, ShieldMinus, ShieldPlus, UserX, Video, VideoOff } from 'lucide-react';
import { useState } from 'react';
import { Menu } from '../ui/Menu';
import { SignalBars } from '../ui/SignalBars';
import { SidePanel } from './SidePanel';
import { initials } from '../ui/Device';
import { SwitchRow } from '../ui/SwitchRow';
import { HAND_ATTRIBUTE } from './Tile';
import type { Hosting } from './useHosts';
import type { WaitingRoomControls } from './useWaitingRoom';
import { useEmbed } from '../embed/EmbedContext';

/** What a host can do to someone from their row. Absent when we don't host. */
interface HostActions {
  setPinned: (pinned: boolean) => Promise<void>;
  /** Absent for ourselves. */
  mute?: () => Promise<void>;
  /** Absent for ourselves, and inside an embed (the consumer decides hosts through the token). */
  setHost?: (host: boolean) => Promise<void>;
  /** Absent for ourselves. */
  remove?: () => Promise<void>;
}

function ParticipantRow({
  participant,
  host,
  pinned,
  pinnedForMe,
  onPinForMe,
  actions,
}: {
  participant: Participant;
  host: boolean;
  /** A host pinned this person for everyone. */
  pinned: boolean;
  /** On our own screen only: this person is on the stage. */
  pinnedForMe: boolean;
  onPinForMe: (pin: boolean) => void;
  actions?: HostActions;
}) {
  const speaking = useIsSpeaking(participant);
  const hand = useParticipantAttribute(HAND_ATTRIBUTE, { participant });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { name: infoName, identity } = useParticipantInfo({ participant });
  const { isMuted: micMuted } = useTrackMutedIndicator({ participant, source: Track.Source.Microphone });
  const { isMuted: camMuted } = useTrackMutedIndicator({ participant, source: Track.Source.Camera });
  const name = infoName || identity || 'Guest';
  const status =
    error ||
    (hand ? 'Hand raised' : speaking ? 'Speaking' : participant.isScreenShareEnabled ? 'Sharing screen' : pinned ? 'Pinned for everyone' : '');
  const run = async (action: () => Promise<void>, close: () => void) => {
    close();
    setConfirmRemove(false);
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
    <li className={`person${speaking ? ' person-speaking' : ''}`}>
      <span className="avatar" aria-hidden="true">
        {initials(name)}
      </span>
      <span className="person-info">
        <span className="person-name">
          <span className="person-name-text">
            {name}
            {participant.isLocal && <span className="person-you"> (you)</span>}
          </span>
          {host && <span className="person-host">Host</span>}
        </span>
        {status && <span className={`person-status${error ? ' person-status-error' : hand ? ' person-status-hand' : ''}`}>{status}</span>}
      </span>
      <span className="person-icons">
        {pinned && <Pin aria-label="Pinned for everyone" />}
        {hand && <Hand className="icon-hand" aria-label="Hand raised" />}
        {micMuted ? <MicOff className="icon-off" aria-label="Mic off" /> : <Mic aria-label="Mic on" />}
        {camMuted ? <VideoOff className="icon-off" aria-label="Camera off" /> : <Video aria-label="Camera on" />}
        <SignalBars participant={participant} />
        <Menu
          label={`Options for ${name}`}
          triggerBase="person-action"
          panelClassName="person-menu"
          trigger={<MoreVertical aria-hidden="true" />}
        >
          {(close) => (
            <>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close();
                  onPinForMe(!pinnedForMe);
                }}
              >
                {pinnedForMe ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                <span className="menu-item-text">{pinnedForMe ? 'Unpin for me' : 'Pin for me'}</span>
                <span className="menu-item-hint">Only you</span>
              </button>
              {actions && (
                <>
                <span className="menu-sep" role="separator" />
                <button type="button" className="menu-item" disabled={busy} onClick={() => run(() => actions.setPinned(!pinned), close)}>
                  {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                  <span className="menu-item-text">{pinned ? 'Unpin for everyone' : 'Pin for everyone'}</span>
                </button>
                {actions.mute && !micMuted && (
                  <button type="button" className="menu-item" disabled={busy} onClick={() => run(actions.mute!, close)}>
                    <MicOff aria-hidden="true" />
                    <span className="menu-item-text">Mute mic</span>
                  </button>
                )}
                {actions.setHost && (
                  <button type="button" className="menu-item" disabled={busy} onClick={() => run(() => actions.setHost!(!host), close)}>
                    {host ? <ShieldMinus aria-hidden="true" /> : <ShieldPlus aria-hidden="true" />}
                    <span className="menu-item-text">{host ? 'Stop hosting' : 'Make a host'}</span>
                  </button>
                )}
                {actions.remove && !host && (
                  <>
                    <span className="menu-sep" role="separator" />
                    <button
                      type="button"
                      className="menu-item menu-item-danger"
                      disabled={busy}
                      onClick={() => (confirmRemove ? run(actions.remove!, close) : setConfirmRemove(true))}
                    >
                      <UserX aria-hidden="true" />
                      <span className="menu-item-text">{confirmRemove ? `Remove ${name}?` : 'Remove from call'}</span>
                      {confirmRemove && <span className="menu-item-hint">Can&apos;t rejoin</span>}
                    </button>
                  </>
                )}
                </>
              )}
            </>
          )}
        </Menu>
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
 * Everyone in the room, raised hands first, then speakers, then by name. Each row's menu pins that
 * person on our own screen; hosts also get pin for everyone, mute, make or stop hosting, and remove,
 * plus the waiting room.
 */
export function ParticipantsPanel({
  hosting,
  lobby,
  pinnedForMe,
  onPinForMe,
  onClose,
}: {
  hosting: Hosting;
  lobby: WaitingRoomControls | null;
  /** Whose tile is on our own stage right now (ours only), or null. */
  pinnedForMe: string | null;
  /** Puts that person on our own stage (null clears it). */
  onPinForMe: (identity: string | null) => void;
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
            pinned={hosting.spotlight === p.identity}
            pinnedForMe={pinnedForMe === p.identity}
            onPinForMe={(pin) => onPinForMe(pin ? p.identity : null)}
            actions={
              hosting.isHost
                ? {
                    setPinned: (pinned) => hosting.setSpotlight(pinned ? p.identity : null),
                    mute: p.isLocal ? undefined : () => hosting.mute(p.identity),
                    setHost: !embed && !p.isLocal ? (host) => hosting.setHost(p.identity, host) : undefined,
                    remove: p.isLocal ? undefined : () => hosting.remove(p.identity),
                  }
                : undefined
            }
          />
        ))}
      </ul>
    </SidePanel>
  );
}
