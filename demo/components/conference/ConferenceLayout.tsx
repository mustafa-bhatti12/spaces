'use client';

import type { TrackReferenceOrPlaceholder, WidgetState } from '@livekit/components-core';
import { isEqualTrackRef } from '@livekit/components-core';
import {
  CarouselLayout,
  Chat,
  FocusLayout,
  FocusLayoutContainer,
  GridLayout,
  isTrackReference,
  LayoutContextProvider,
  RoomAudioRenderer,
  useConnectionState,
  useCreateLayoutContext,
  useLocalParticipant,
  useParticipants,
  usePinnedTracks,
  useTracks,
} from '@livekit/components-react';
import { ConnectionState, RoomEvent, Track } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, WifiOff, X } from 'lucide-react';
import { MIRROR_ATTRIBUTE, useMirrorVideo } from '@/lib/client/mirror';
import type { Panel } from './Dock';
import { ChatToasts } from './ChatToasts';
import { Dock } from './Dock';
import { ParticipantsPanel } from './ParticipantsPanel';
import { SettingsPanel } from './SettingsPanel';
import { Tile } from './Tile';
import { useWeakConnection } from './useWeakConnection';
import { useBackgroundEffect } from './useBackgroundEffect';
import { useReactions } from './useReactions';
import { useRecording } from './useRecording';
import { useHosts } from './useHosts';
import { useWaitingRoom } from './useWaitingRoom';
import { WaitingNotice } from './WaitingNotice';
import { useEmbed } from '../embed/EmbedContext';

/**
 * LiveKit's VideoConference prefab, expanded so the demo can add its own panels and controls:
 * same grid ⇄ focus layouts (auto-focus on screen share, click a tile to pin) and LiveKit Chat, plus
 * people and settings panels, the dock, reactions and recording. One side panel at a time.
 */
export function ConferenceLayout({
  roomName,
  joinToken,
  onEndForAll,
}: {
  roomName: string;
  /** Our join token: token-service's proof of who we are for host actions (it checks the hosts list). */
  joinToken: string;
  /** Ends the call for everyone; offered only while we host. */
  onEndForAll: () => Promise<void>;
}) {
  const [widget, setWidget] = useState<WidgetState>({ showChat: false, unreadMessages: 0, showSettings: false });
  const [sidePanel, setSidePanel] = useState<Exclude<Panel, 'chat'>>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const toastId = useRef(0);
  const layoutContext = useCreateLayoutContext();
  const connectionState = useConnectionState();
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const background = useBackgroundEffect();
  const [mirror] = useMirrorVideo();
  const { reactions, react } = useReactions();
  const rec = useRecording(roomName, localParticipant.name || localParticipant.identity);
  const hosting = useHosts(roomName, joinToken);
  const embed = useEmbed();
  const lobby = useWaitingRoom(roomName, hosting.isHost && !embed ? joinToken : undefined);
  const [aloneDismissed, setAloneDismissed] = useState(false);

  // Participant attributes are synchronized through LiveKit, so every client renders this
  // participant's camera with the same orientation. Only send once connected: an update sent while
  // the join is still in flight never gets confirmed and the SDK rejects it after 5 s. A failed
  // update is retried on the next connection-state change (e.g. after a reconnect).
  useEffect(() => {
    const value = mirror ? 'on' : 'off';
    if (connectionState !== ConnectionState.Connected || localParticipant.attributes[MIRROR_ATTRIBUTE] === value) return;
    localParticipant.setAttributes({ [MIRROR_ATTRIBUTE]: value }).catch(() => {});
  }, [connectionState, localParticipant, mirror]);

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );
  const screenShareTracks = tracks
    .filter(isTrackReference)
    .filter((track) => track.publication.source === Track.Source.ScreenShare);
  const focusTrack = usePinnedTracks(layoutContext)?.[0];
  const carouselTracks = tracks.filter((track) => !isEqualTrackRef(track, focusTrack));
  const lastAutoFocused = useRef<TrackReferenceOrPlaceholder | null>(null);

  // Same auto-focus rules as LiveKit's VideoConference: a new screen share takes the stage until it
  // ends, unless the user pinned something else.
  const screenShareKey = screenShareTracks.map((ref) => `${ref.publication.trackSid}_${ref.publication.isSubscribed}`).join();
  useEffect(() => {
    if (screenShareTracks.some((track) => track.publication.isSubscribed) && lastAutoFocused.current === null) {
      layoutContext.pin.dispatch?.({ msg: 'set_pin', trackReference: screenShareTracks[0] });
      lastAutoFocused.current = screenShareTracks[0];
    } else if (
      lastAutoFocused.current &&
      !screenShareTracks.some((track) => track.publication.trackSid === lastAutoFocused.current?.publication?.trackSid)
    ) {
      layoutContext.pin.dispatch?.({ msg: 'clear_pin' });
      lastAutoFocused.current = null;
    }
    if (focusTrack && !isTrackReference(focusTrack)) {
      const updated = tracks.find(
        (tr) => tr.participant.identity === focusTrack.participant.identity && tr.source === focusTrack.source,
      );
      if (updated !== focusTrack && isTrackReference(updated)) {
        layoutContext.pin.dispatch?.({ msg: 'set_pin', trackReference: updated });
      }
    }
    // Dependencies mirror LiveKit's VideoConference prefab (keyed on track sids, not array identity).
  }, [screenShareKey, focusTrack?.publication?.trackSid, tracks]);

  // One side panel at a time. Chat's visibility lives in LiveKit's layout context (ChatToggle drives
  // it); people/settings are ours. Opening chat closes ours, and opening ours closes chat.
  useEffect(() => {
    if (widget.showChat) setSidePanel(null);
  }, [widget.showChat]);
  const togglePanel = (next: Exclude<Panel, 'chat' | null>) => {
    if (widget.showChat) layoutContext.widget.dispatch?.({ msg: 'toggle_chat' });
    setSidePanel((open) => (open === next ? null : next));
  };
  const openPeople = () => {
    if (widget.showChat) layoutContext.widget.dispatch?.({ msg: 'toggle_chat' });
    setSidePanel('people');
  };
  const panel: Panel = widget.showChat ? 'chat' : sidePanel;

  // Escape closes the open side panel, unless a dock menu or the Leave dialog is open above it (those
  // take the key). Capture phase: LiveKit's chat input stops its key events from bubbling.
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('.menu-panel, dialog[open]')) return;
      const focus = document.activeElement;
      const focusInPanel = !focus || focus === document.body || !!focus.closest('.lk-chat, .side-panel');
      if (panel === 'chat') layoutContext.widget.dispatch?.({ msg: 'toggle_chat' });
      else setSidePanel(null);
      if (focusInPanel) document.querySelector<HTMLElement>(`.dock [data-panel="${panel}"]`)?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [panel, layoutContext.widget]);

  const flash = useCallback((message: string) => {
    const id = ++toastId.current;
    setToast({ id, text: message });
    setTimeout(() => setToast((current) => (current?.id === id ? null : current)), 3000);
  }, []);
  const weakConnection = useWeakConnection();

  // Another host can make us a host (or stop us hosting) mid-call; say so when it happens.
  const wasHost = useRef<boolean | null>(null);
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return;
    if (wasHost.current !== null && wasHost.current !== hosting.isHost) {
      flash(hosting.isHost ? "You're a host now" : "You're no longer a host");
    }
    wasHost.current = hosting.isHost;
  }, [connectionState, hosting.isHost, flash]);

  const openChat = useCallback(() => {
    if (!widget.showChat) layoutContext.widget.dispatch?.({ msg: 'toggle_chat' });
  }, [layoutContext.widget, widget.showChat]);

  const { error: recError, clearError: clearRecError } = rec;
  useEffect(() => {
    if (!recError) return;
    flash(`Recording: ${recError}`);
    clearRecError();
  }, [recError, clearRecError, flash]);

  const invite = async () => {
    const url = `${window.location.origin}/rooms/${encodeURIComponent(roomName)}`;
    try {
      await navigator.clipboard.writeText(url);
      flash('Invite link copied');
    } catch {
      flash(`Copy this link: ${url}`);
    }
  };

  return (
    <div className="conference" data-mirror={mirror ? 'on' : 'off'}>
      <div className="lk-video-conference">
        <LayoutContextProvider value={layoutContext} onWidgetChange={setWidget}>
          <div className="lk-video-conference-inner">
            <div className="stage">
              {connectionState === ConnectionState.Reconnecting && (
                <div className="stage-banner" role="status">
                  <WifiOff aria-hidden="true" />
                  Connection lost. Reconnecting…
                </div>
              )}
              {!focusTrack ? (
                <div className="lk-grid-layout-wrapper">
                  <GridLayout tracks={tracks}>
                    <Tile />
                  </GridLayout>
                </div>
              ) : (
                <div className="lk-focus-layout-wrapper">
                  <FocusLayoutContainer>
                    <CarouselLayout tracks={carouselTracks}>
                      <Tile />
                    </CarouselLayout>
                    <FocusLayout trackRef={focusTrack} />
                  </FocusLayoutContainer>
                </div>
              )}
              <ChatToasts
                chatOpen={widget.showChat}
                onOpenChat={openChat}
                onOpenPeople={openPeople}
                lead={
                  <>
                    {/* With People open, its waiting section already shows every request. */}
                    {lobby && sidePanel !== 'people' && <WaitingNotice lobby={lobby} onView={openPeople} />}
                    {participants.length === 1 &&
                      connectionState === ConnectionState.Connected &&
                      !aloneDismissed &&
                      !lobby?.pending.length && (
                      <div className="chat-toast alone-card" role="status">
                        <button type="button" className="chat-toast-close" onClick={() => setAloneDismissed(true)} aria-label="Dismiss">
                          <X aria-hidden="true" />
                        </button>
                        <p className="alone-title">You&apos;re the only one here</p>
                        <p className="alone-text">Share this call&apos;s link with the people you want to talk to.</p>
                        {!embed && (
                          <button type="button" className="key key-go" onClick={invite}>
                            <Link2 aria-hidden="true" />
                            Copy invite link
                          </button>
                        )}
                      </div>
                    )}
                  </>
                }
              />
            </div>
            <Dock
              roomName={roomName}
              participantCount={participants.length}
              panel={panel}
              onTogglePanel={togglePanel}
              onReact={react}
              onInvite={embed ? undefined : invite}
              onEndForAll={hosting.isHost ? onEndForAll : undefined}
              recording={{
                current: rec.recording,
                busy: rec.busy,
                onToggle: () => void (rec.recording ? rec.stop() : rec.start()),
              }}
              weakConnection={weakConnection}
              canRecord={!embed || hosting.isHost}
            />
          </div>
          <Chat style={{ display: widget.showChat ? undefined : 'none' }} />
          {sidePanel === 'people' && <ParticipantsPanel hosting={hosting} lobby={lobby} onClose={() => setSidePanel(null)} />}
          {sidePanel === 'settings' && <SettingsPanel background={background} onClose={() => setSidePanel(null)} />}
        </LayoutContextProvider>
      </div>
      <div className="reactions-layer" aria-hidden="true">
        {reactions.map((r) => (
          <div key={r.id} className="reaction-float" style={{ left: `${r.left}%` }}>
            <span className="emoji">{r.emoji}</span>
            <span className="who">{r.from}</span>
          </div>
        ))}
      </div>
      <RoomAudioRenderer />
      <div className="toast-slot" role="status" aria-live="polite">
        {toast && (
          <div className="toast" key={toast.id}>
            {toast.text}
          </div>
        )}
      </div>
    </div>
  );
}
