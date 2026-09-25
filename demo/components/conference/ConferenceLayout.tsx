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
import { WifiOff } from 'lucide-react';
import { MIRROR_ATTRIBUTE, useMirrorVideo } from '@/lib/client/mirror';
import type { Panel } from './Dock';
import { Dock } from './Dock';
import { ParticipantsPanel } from './ParticipantsPanel';
import { SettingsPanel } from './SettingsPanel';
import { Tile } from './Tile';
import { useAudioFirst } from './useAudioFirst';
import { useBackgroundEffect } from './useBackgroundEffect';
import { useReactions } from './useReactions';
import { useRecording } from './useRecording';

/**
 * LiveKit's VideoConference prefab, expanded so the demo can add its own panels and controls:
 * same grid ⇄ focus layouts (auto-focus on screen share, click a tile to pin) and LiveKit Chat, plus
 * people and settings panels, the dock, reactions and recording. One side panel at a time.
 */
export function ConferenceLayout({ roomName, onEndForAll }: { roomName: string; onEndForAll?: () => Promise<void> }) {
  const [widget, setWidget] = useState<WidgetState>({ showChat: false, unreadMessages: 0, showSettings: false });
  const [sidePanel, setSidePanel] = useState<Exclude<Panel, 'chat'>>(null);
  const [toast, setToast] = useState('');
  const layoutContext = useCreateLayoutContext();
  const connectionState = useConnectionState();
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const background = useBackgroundEffect();
  const [mirror] = useMirrorVideo();
  const { reactions, react } = useReactions();
  const rec = useRecording(roomName, localParticipant.name || localParticipant.identity);

  // Participant attributes are synchronized through LiveKit, so every client renders this
  // participant's camera with the same orientation.
  useEffect(() => {
    void localParticipant.setAttributes({ [MIRROR_ATTRIBUTE]: mirror ? 'on' : 'off' });
  }, [localParticipant, mirror]);

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
  const panel: Panel = widget.showChat ? 'chat' : sidePanel;

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? '' : current)), 3000);
  }, []);
  useAudioFirst(flash);

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
            </div>
            <Dock
              roomName={roomName}
              participantCount={participants.length}
              panel={panel}
              onTogglePanel={togglePanel}
              onReact={react}
              onInvite={invite}
              onEndForAll={onEndForAll}
              recording={{
                current: rec.recording,
                busy: rec.busy,
                onToggle: () => void (rec.recording ? rec.stop() : rec.start()),
              }}
            />
          </div>
          <Chat style={{ display: widget.showChat ? undefined : 'none' }} />
          {sidePanel === 'people' && <ParticipantsPanel onClose={() => setSidePanel(null)} />}
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
          <div className="toast" key={toast}>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
