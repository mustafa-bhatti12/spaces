'use client';

import type { CaptureOptionsBySource, ToggleSource } from '@livekit/components-core';
import { supportsScreenSharing } from '@livekit/components-core';
import {
  ChatToggle,
  MediaDeviceMenu,
  StartMediaButton,
  useIsSpeaking,
  useLocalParticipant,
  useParticipantAttribute,
  usePersistentUserChoices,
  useTrackToggle,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import type { LucideIcon } from 'lucide-react';
import {
  CircleDot,
  CircleStop,
  Ellipsis,
  Hand,
  Link,
  LogOut,
  Maximize,
  MessageSquare,
  Mic,
  MicOff,
  Minimize,
  MonitorOff,
  MonitorUp,
  Settings2,
  SmilePlus,
  Users,
  Video,
  VideoOff,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Led, Readout, ReadoutSegment } from '../ui/Device';
import { Menu } from '../ui/Menu';
import { HAND_ATTRIBUTE } from './Tile';
import type { ActiveRecording } from './useRecording';
import { LeaveDialog } from './LeaveDialog';
import { REACTION_EMOJIS } from './useReactions';

export type Panel = 'chat' | 'people' | 'settings' | null;

// token-service passes LiveKit's EgressInfo.startedAt through: nanoseconds since epoch, 0 until the
// egress is actually running.
function elapsed(startedAtNs: string): string {
  const startedAtMs = Number(startedAtNs) / 1e6;
  if (!startedAtMs) return 'starting';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

function useFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  return { fullscreen, toggle };
}

/** Ticks once a second while `active`, so elapsed timers stay current. */
function useSecondTick(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

interface DeviceKeyProps<T extends ToggleSource> {
  source: T;
  on: { icon: LucideIcon; legend: string; label: string };
  off: { icon: LucideIcon; legend: string; label: string };
  onChange?: (enabled: boolean, userInitiated: boolean) => void;
  captureOptions?: CaptureOptionsBySource<T>;
  className?: string;
}

/** A track toggle key built on LiveKit's useTrackToggle, so the icon and legend follow the real state. */
function DeviceKey<T extends ToggleSource>({ source, on, off, onChange, captureOptions, className = '' }: DeviceKeyProps<T>) {
  const { buttonProps, enabled, pending } = useTrackToggle({ source, onChange, captureOptions });
  const face = enabled ? on : off;
  const Icon = face.icon;
  return (
    <button
      {...buttonProps}
      type="button"
      className={`key ${className}`}
      data-state={enabled ? 'on' : 'off'}
      aria-busy={pending || undefined}
      aria-label={face.label}
      title={face.label}
    >
      <Icon aria-hidden="true" />
      <span className="legend">{face.legend}</span>
    </button>
  );
}

function MicKey({ onChange }: { onChange: (enabled: boolean, userInitiated: boolean) => void }) {
  const { localParticipant } = useLocalParticipant();
  const speaking = useIsSpeaking(localParticipant);
  return (
    <span className={`mic-ring${speaking && localParticipant.isMicrophoneEnabled ? ' mic-ring-speaking' : ''}`}>
      <DeviceKey
        source={Track.Source.Microphone}
        className="key-mic"
        on={{ icon: Mic, legend: 'Mic', label: 'Mute microphone' }}
        off={{ icon: MicOff, legend: 'Muted', label: 'Unmute microphone' }}
        onChange={onChange}
      />
    </span>
  );
}

function MenuItem({
  icon: Icon,
  children,
  hint,
  onSelect,
  disabled,
  checked,
}: {
  icon: LucideIcon;
  children: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  checked?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className="menu-item"
      disabled={disabled}
      onClick={onSelect}
    >
      <Icon aria-hidden="true" />
      <span className="menu-item-text">{children}</span>
      {hint && <span className="menu-item-hint">{hint}</span>}
    </button>
  );
}

interface DockProps {
  roomName: string;
  participantCount: number;
  panel: Panel;
  onTogglePanel: (panel: Exclude<Panel, 'chat' | null>) => void;
  onReact: (emoji: string) => void;
  onInvite: () => void;
  /** Present only for the host: the Leave dialog then also offers "End call for everyone". */
  onEndForAll?: () => Promise<void>;
  recording: { current: ActiveRecording | null; busy: boolean; onToggle: () => void };
}

/**
 * The call's one control surface, laid out like a conference speakerphone: a status screen on the
 * left, three key clusters (media · talk · more) in the middle, and Leave on its own at the right
 * (always confirmed in LeaveDialog). Built from LiveKit's hooks and controls (useTrackToggle,
 * MediaDeviceMenu, ChatToggle) so behavior stays LiveKit's.
 */
export function Dock({ roomName, participantCount, panel, onTogglePanel, onReact, onInvite, onEndForAll, recording }: DockProps) {
  const { localParticipant } = useLocalParticipant();
  const hand = useParticipantAttribute(HAND_ATTRIBUTE, { participant: localParticipant });
  const { saveAudioInputEnabled, saveVideoInputEnabled, saveAudioInputDeviceId, saveVideoInputDeviceId } =
    usePersistentUserChoices();
  const { fullscreen, toggle: toggleFullscreen } = useFullscreen();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const rec = recording.current;
  useSecondTick(Boolean(rec));

  const toggleHand = () => localParticipant.setAttributes({ [HAND_ATTRIBUTE]: hand ? '' : 'raised' });

  return (
    <div className="dock" role="toolbar" aria-label="Call controls">
      <Readout className="dock-readout" live>
        <ReadoutSegment strong>
          <span className="mono dock-room" title={roomName}>
            {roomName}
          </span>
        </ReadoutSegment>
        <ReadoutSegment>
          <Users aria-hidden="true" />
          {participantCount}
        </ReadoutSegment>
        {rec && (
          <ReadoutSegment>
            <span className="readout-rec" title={rec.startedBy ? `Recording started by ${rec.startedBy}` : 'Recording'}>
              <Led signal="alert" pulse label="Recording" />
              REC <span className="mono">{elapsed(rec.startedAt)}</span>
              {rec.startedBy && <span className="readout-by"> · {rec.startedBy}</span>}
            </span>
          </ReadoutSegment>
        )}
      </Readout>

      <div className="dock-keys">
        <div className="cluster" role="group" aria-label="Microphone, camera and screen">
          <span className="key-pair">
            <MicKey onChange={(enabled, userInitiated) => userInitiated && saveAudioInputEnabled(enabled)} />
            <MediaDeviceMenu
              kind="audioinput"
              className="key key-chevron lk-button-menu"
              aria-label="Choose microphone"
              title="Choose microphone"
              onActiveDeviceChange={(_k, id) => saveAudioInputDeviceId(id ?? 'default')}
            />
          </span>
          <span className="key-pair">
            <DeviceKey
              source={Track.Source.Camera}
              on={{ icon: Video, legend: 'Camera', label: 'Turn camera off' }}
              off={{ icon: VideoOff, legend: 'Camera', label: 'Turn camera on' }}
              onChange={(enabled, userInitiated) => userInitiated && saveVideoInputEnabled(enabled)}
            />
            <MediaDeviceMenu
              kind="videoinput"
              className="key key-chevron lk-button-menu"
              aria-label="Choose camera"
              title="Choose camera"
              onActiveDeviceChange={(_k, id) => saveVideoInputDeviceId(id ?? 'default')}
            />
          </span>
          {supportsScreenSharing() && (
            <DeviceKey
              source={Track.Source.ScreenShare}
              className="key-share"
              captureOptions={{ audio: true, selfBrowserSurface: 'include' }}
              on={{ icon: MonitorOff, legend: 'Stop', label: 'Stop sharing your screen' }}
              off={{ icon: MonitorUp, legend: 'Share', label: 'Share your screen' }}
            />
          )}
        </div>

        <div className="cluster" role="group" aria-label="Reactions, chat and people">
          <Menu
            label={hand ? 'Reactions (your hand is raised)' : 'Reactions and raise hand'}
            triggerClassName={hand ? 'key-flag' : ''}
            panelClassName="react-panel"
            trigger={
              <>
                {hand ? <Hand aria-hidden="true" /> : <SmilePlus aria-hidden="true" />}
                <span className="legend">{hand ? 'Hand up' : 'React'}</span>
              </>
            }
          >
            {(close) => (
              <>
                <div className="react-row" role="group" aria-label="Send a reaction">
                  {REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="react-emoji"
                      aria-label={`React ${emoji}`}
                      onClick={() => {
                        onReact(emoji);
                        close();
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                <MenuItem
                  icon={Hand}
                  checked={Boolean(hand)}
                  onSelect={() => {
                    toggleHand();
                    close();
                  }}
                >
                  {hand ? 'Lower hand' : 'Raise hand'}
                </MenuItem>
              </>
            )}
          </Menu>
          <ChatToggle className="key" aria-label="Chat" title="Chat">
            <MessageSquare aria-hidden="true" />
            <span className="legend">Chat</span>
          </ChatToggle>
          <button
            type="button"
            className="key"
            aria-pressed={panel === 'people'}
            onClick={() => onTogglePanel('people')}
            aria-label={`People (${participantCount})`}
            title="People"
          >
            <Users aria-hidden="true" />
            <span className="legend">People</span>
            <span className="key-count">{participantCount}</span>
          </button>
        </div>

        <div className="cluster" role="group" aria-label="More">
          <Menu
            label="More options"
            triggerClassName={rec ? 'key-flag-rec' : ''}
            trigger={
              <>
                <Ellipsis aria-hidden="true" />
                <span className="legend">More</span>
              </>
            }
          >
            {(close) => (
              <>
                <MenuItem
                  icon={rec ? CircleStop : CircleDot}
                  disabled={recording.busy}
                  hint={rec ? <span className="mono">{elapsed(rec.startedAt)}</span> : 'Audio'}
                  onSelect={() => {
                    recording.onToggle();
                    close();
                  }}
                >
                  {recording.busy ? 'Working…' : rec ? 'Stop recording' : 'Record'}
                </MenuItem>
                <MenuItem
                  icon={Link}
                  onSelect={() => {
                    onInvite();
                    close();
                  }}
                >
                  Copy invite link
                </MenuItem>
                <span className="menu-sep" role="separator" />
                <MenuItem
                  icon={Settings2}
                  checked={panel === 'settings'}
                  hint="Devices, background"
                  onSelect={() => {
                    onTogglePanel('settings');
                    close();
                  }}
                >
                  Settings
                </MenuItem>
                <MenuItem
                  icon={fullscreen ? Minimize : Maximize}
                  onSelect={() => {
                    void toggleFullscreen();
                    close();
                  }}
                >
                  {fullscreen ? 'Exit full screen' : 'Full screen'}
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>

      <div className="dock-end">
        <StartMediaButton className="key" />
        <button
          type="button"
          className="key key-leave"
          aria-haspopup="dialog"
          aria-label={onEndForAll ? 'Leave or end call' : 'Leave call'}
          title={onEndForAll ? 'Leave or end call' : 'Leave call'}
          onClick={() => setLeaveOpen(true)}
        >
          <LogOut aria-hidden="true" />
          <span className="legend">Leave</span>
        </button>
        {leaveOpen && <LeaveDialog onClose={() => setLeaveOpen(false)} onEndForAll={onEndForAll} />}
      </div>
    </div>
  );
}
