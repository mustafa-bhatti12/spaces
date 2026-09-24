'use client';

import type { TrackReferenceOrPlaceholder, WidgetState } from '@livekit/components-core';
import { isEqualTrackRef } from '@livekit/components-core';
import {
  CarouselLayout,
  Chat,
  ConnectionStateToast,
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
import { ConferenceControlBar } from './ConferenceControlBar';
import { ParticipantsPanel } from './ParticipantsPanel';
import { SettingsPanel } from './SettingsPanel';
import { Tile } from './Tile';
import { TopBar } from './TopBar';
import { useBackgroundEffect } from './useBackgroundEffect';
import { useReactions } from './useReactions';
import { useRecording } from './useRecording';

/**
 * LiveKit's VideoConference prefab, expanded so the demo can add its own panels and controls:
 * same grid ⇄ focus layouts (auto-focus on screen share, click a tile to pin), LiveKit Chat and
 * settings modal, plus a participants panel, top bar, reactions and recording.
 */
export function ConferenceLayout({ roomName }: { roomName: string }) {
  const [widget, setWidget] = useState<WidgetState>({ showChat: false, unreadMessages: 0, showSettings: false });
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [toast, setToast] = useState('');
  const layoutContext = useCreateLayoutContext();
  const connectionState = useConnectionState();
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const background = useBackgroundEffect();
  const { reactions, react } = useReactions();
  const rec = useRecording(roomName, localParticipant.name || localParticipant.identity);

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

  // One side panel at a time: opening chat closes people, and vice versa.
  useEffect(() => {
    if (widget.showChat) setParticipantsOpen(false);
  }, [widget.showChat]);
  const toggleParticipants = () => {
    if (widget.showChat) layoutContext.widget.dispatch?.({ msg: 'toggle_chat' });
    setParticipantsOpen((open) => !open);
  };

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? '' : current)), 3000);
  }, []);

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
      flash(url);
    }
  };

  return (
    <div className="conference">
      <TopBar roomName={roomName} participantCount={participants.length} recording={rec.recording} onInvite={invite} />
      {connectionState === ConnectionState.Reconnecting && (
        <div className="conference-banner reconnecting" role="status">
          Connection lost — reconnecting…
        </div>
      )}
      {connectionState === ConnectionState.Disconnected && (
        <div className="conference-banner" role="status">
          Disconnected
        </div>
      )}
      <div className="lk-video-conference">
        <LayoutContextProvider value={layoutContext} onWidgetChange={setWidget}>
          <div className="lk-video-conference-inner">
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
            <ConferenceControlBar
              participantCount={participants.length}
              participantsOpen={participantsOpen}
              onToggleParticipants={toggleParticipants}
              onReact={react}
              recording={{
                active: Boolean(rec.recording),
                busy: rec.busy,
                onToggle: () => void (rec.recording ? rec.stop() : rec.start()),
              }}
            />
          </div>
          <Chat style={{ display: widget.showChat ? 'grid' : 'none' }} />
          {participantsOpen && <ParticipantsPanel onClose={() => setParticipantsOpen(false)} />}
          <div className="lk-settings-menu-modal" style={{ display: widget.showSettings ? 'block' : 'none' }}>
            {widget.showSettings && <SettingsPanel background={background} />}
          </div>
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
      <ConnectionStateToast />
      {toast && <div className="lk-toast app-toast">{toast}</div>}
    </div>
  );
}
