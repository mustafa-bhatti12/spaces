'use client';

import {
  ChatIcon,
  ChatToggle,
  DisconnectButton,
  GearIcon,
  LeaveIcon,
  MediaDeviceMenu,
  StartMediaButton,
  TrackToggle,
  useLocalParticipant,
  useParticipantAttribute,
  usePersistentUserChoices,
} from '@livekit/components-react';
import { supportsScreenSharing } from '@livekit/components-core';
import { Track } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { SettingsToggle } from './SettingsToggle';
import { HAND_ATTRIBUTE } from './Tile';
import { REACTION_EMOJIS } from './useReactions';

interface ConferenceControlBarProps {
  participantCount: number;
  participantsOpen: boolean;
  onToggleParticipants: () => void;
  onReact: (emoji: string) => void;
  recording: { active: boolean; busy: boolean; onToggle: () => void };
}

/**
 * LiveKit's ControlBar layout rebuilt from its own building blocks (TrackToggle, MediaDeviceMenu,
 * ChatToggle, DisconnectButton — per LiveKit's best practices) so the demo's
 * extra controls (hand, reactions, people, record) sit in the same bar with the same styling.
 */
export function ConferenceControlBar({
  participantCount,
  participantsOpen,
  onToggleParticipants,
  onReact,
  recording,
}: ConferenceControlBarProps) {
  const { localParticipant } = useLocalParticipant();
  const hand = useParticipantAttribute(HAND_ATTRIBUTE, { participant: localParticipant });
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const reactionsRef = useRef<HTMLDivElement>(null);
  const { saveAudioInputEnabled, saveVideoInputEnabled, saveAudioInputDeviceId, saveVideoInputDeviceId } =
    usePersistentUserChoices();

  useEffect(() => {
    if (!reactionsOpen) return;
    const close = (event: PointerEvent) => {
      if (!reactionsRef.current?.contains(event.target as Node)) setReactionsOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [reactionsOpen]);

  const toggleHand = () => localParticipant.setAttributes({ [HAND_ATTRIBUTE]: hand ? '' : 'raised' });

  return (
    <div className="lk-control-bar">
      <div className="lk-button-group">
        <TrackToggle
          source={Track.Source.Microphone}
          onChange={(enabled, userInitiated) => userInitiated && saveAudioInputEnabled(enabled)}
        >
          <span className="control-label">Mic</span>
        </TrackToggle>
        <div className="lk-button-group-menu">
          <MediaDeviceMenu kind="audioinput" onActiveDeviceChange={(_k, id) => saveAudioInputDeviceId(id ?? 'default')} />
        </div>
      </div>
      <div className="lk-button-group">
        <TrackToggle
          source={Track.Source.Camera}
          onChange={(enabled, userInitiated) => userInitiated && saveVideoInputEnabled(enabled)}
        >
          <span className="control-label">Camera</span>
        </TrackToggle>
        <div className="lk-button-group-menu">
          <MediaDeviceMenu kind="videoinput" onActiveDeviceChange={(_k, id) => saveVideoInputDeviceId(id ?? 'default')} />
        </div>
      </div>
      {supportsScreenSharing() && (
        <TrackToggle source={Track.Source.ScreenShare} captureOptions={{ audio: true, selfBrowserSurface: 'include' }}>
          <span className="control-label">Share</span>
        </TrackToggle>
      )}
      <button type="button" className="lk-button" aria-pressed={Boolean(hand)} onClick={toggleHand} title={hand ? 'Lower hand' : 'Raise hand'}>
        ✋<span className="control-label">{hand ? 'Lower' : 'Raise'}</span>
      </button>
      <div ref={reactionsRef} style={{ position: 'relative' }}>
        <button type="button" className="lk-button" aria-pressed={reactionsOpen} onClick={() => setReactionsOpen((o) => !o)} title="Reactions">
          😊<span className="control-label">React</span>
        </button>
        {reactionsOpen && (
          <div className="reaction-menu" role="menu">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                onClick={() => {
                  onReact(emoji);
                  setReactionsOpen(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
      <ChatToggle>
        <ChatIcon />
        <span className="control-label">Chat</span>
      </ChatToggle>
      <button type="button" className="lk-button" aria-pressed={participantsOpen} onClick={onToggleParticipants} title="People">
        👥<span className="control-label">People</span>
        <span className="control-badge">{participantCount}</span>
      </button>
      <button
        type="button"
        className="lk-button"
        aria-pressed={recording.active}
        disabled={recording.busy}
        onClick={recording.onToggle}
        title={recording.active ? 'Stop recording' : 'Record audio'}
      >
        {recording.active ? '⏹' : '⏺'}
        <span className="control-label">{recording.busy ? '…' : recording.active ? 'Stop rec' : 'Record'}</span>
      </button>
      <SettingsToggle>
        <GearIcon />
        <span className="control-label">Settings</span>
      </SettingsToggle>
      <DisconnectButton>
        <LeaveIcon />
        <span className="control-label">Leave</span>
      </DisconnectButton>
      <StartMediaButton />
    </div>
  );
}
