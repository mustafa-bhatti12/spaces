'use client';

import { useRoomContext } from '@livekit/components-react';
import { type LocalTrackPublication, type RemoteParticipant, RoomEvent, Track } from 'livekit-client';
import { useEffect, useRef } from 'react';
import { APP_TOPIC_PREFIX, MAX_PAYLOAD_BYTES, type ShareSurface } from '@/lib/embed';
import { useRoomSettings } from '../conference/useHosts';
import { useEmbed } from './EmbedContext';

const surfaceOf = (pub: LocalTrackPublication): ShareSurface => {
  const s = (pub.track?.mediaStreamTrack.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
  return s === 'browser' || s === 'window' || s === 'monitor' ? s : 'unknown';
};

/** Mounted inside the Room on /embed: reports room events to the parent and relays its app messages. */
export function EmbedBridge() {
  const embed = useEmbed();
  const room = useRoomContext();
  const { hosts } = useRoomSettings();
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  useEffect(() => {
    if (!embed) return;
    const joined = () => embed.post({ type: 'joined', room: room.name, identity: room.localParticipant.identity });
    const recording = (active: boolean) => embed.post({ type: 'recording', active });
    const published = (pub: LocalTrackPublication) =>
      pub.source === Track.Source.ScreenShare && embed.post({ type: 'screenshare', active: true, surface: surfaceOf(pub) });
    const unpublished = (pub: LocalTrackPublication) =>
      pub.source === Track.Source.ScreenShare && embed.post({ type: 'screenshare', active: false, surface: 'unknown' });
    const data = (bytes: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (!participant || !topic?.startsWith(APP_TOPIC_PREFIX) || bytes.length > MAX_PAYLOAD_BYTES) return;
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return;
      }
      embed.post({ type: 'data', topic, payload, from: participant.identity, fromHost: hostsRef.current.includes(participant.identity) });
    };
    if (room.state === 'connected') joined();
    recording(room.isRecording);
    room.on(RoomEvent.Connected, joined).on(RoomEvent.RecordingStatusChanged, recording)
      .on(RoomEvent.LocalTrackPublished, published).on(RoomEvent.LocalTrackUnpublished, unpublished)
      .on(RoomEvent.DataReceived, data);
    const stop = embed.onCommand((c) => {
      const self = room.localParticipant.identity;
      const destinationIdentities = c.to === 'hosts' ? hostsRef.current.filter((h) => h !== self) : undefined;
      if (destinationIdentities && destinationIdentities.length === 0) return;
      room.localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(c.payload)), { reliable: true, topic: c.topic, destinationIdentities })
        .catch(() => {});
    });
    return () => {
      stop();
      room.off(RoomEvent.Connected, joined).off(RoomEvent.RecordingStatusChanged, recording)
        .off(RoomEvent.LocalTrackPublished, published).off(RoomEvent.LocalTrackUnpublished, unpublished)
        .off(RoomEvent.DataReceived, data);
    };
  }, [embed, room]);

  return null;
}
