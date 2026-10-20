'use client';

import { ConnectionQuality, ParticipantEvent, RoomEvent, Track, type Room } from 'livekit-client';
import { useEffect } from 'react';
import type { CallSettings } from '@/lib/callSettings';
import type { CallStats } from './callStats';
import type { CallLog } from './useCallLog';

const SCREEN_SHARE_LOW_MAX_BITRATE = 1_000_000;
const CAMERA_LOW_MAX_FRAMERATE = 20;
const CAMERA_LOW_BITRATE: Record<CallSettings['lowCameraHeight'], number> = {
  180: 160_000,
  270: 250_000,
  360: 450_000,
};

type AdaptiveMediaLevel = 'normal' | 'low';
type EncodingBaseline = Pick<RTCRtpEncodingParameters, 'maxBitrate' | 'maxFramerate' | 'scaleResolutionDownBy'>[];
const senderBaselines = new WeakMap<RTCRtpSender, EncodingBaseline>();
export type AdaptiveMediaStatsHandler = (stats: CallStats) => void;
export type AdaptiveMediaStatsRef = { current: AdaptiveMediaStatsHandler | undefined };

/**
 * Keep camera and screen video active, but constrain their sender encodings when this caller's
 * uplink is weak. The configured recovery hold must pass before restoring full quality.
 */
export function useAdaptiveMedia(
  room: Room,
  log: CallLog,
  statsHandler: AdaptiveMediaStatsRef,
  settings: CallSettings,
): void {
  useEffect(() => {
    if (!settings.adaptive) {
      statsHandler.current = undefined;
      return;
    }
    let level: AdaptiveMediaLevel = 'normal';
    let lowSamples = 0;
    let outboundLow = false;
    let qualityNeedsRecovery = room.localParticipant.connectionQuality === ConnectionQuality.Poor;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingUpdates: Promise<void> = Promise.resolve();

    const applySenderLevel = async (sender: RTCRtpSender, source: Track.Source, nextLevel: AdaptiveMediaLevel) => {
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) return;
        let baseline = senderBaselines.get(sender);
        if (nextLevel === 'normal' && !baseline) return;
        if (!baseline) {
          baseline = params.encodings.map(({ maxBitrate, maxFramerate, scaleResolutionDownBy }) => ({
            maxBitrate,
            maxFramerate,
            scaleResolutionDownBy,
          }));
          senderBaselines.set(sender, baseline);
        }

        const layerBudget = Math.floor(SCREEN_SHARE_LOW_MAX_BITRATE / params.encodings.length);
        const encodings = params.encodings.map((encoding, index) => {
          const updated = { ...encoding };
          if (nextLevel === 'normal') {
            const original = baseline[index];
            if (original?.maxBitrate === undefined) delete updated.maxBitrate;
            else if (original) updated.maxBitrate = original.maxBitrate;
            if (original?.maxFramerate === undefined) delete updated.maxFramerate;
            else if (original) updated.maxFramerate = original.maxFramerate;
            if (original?.scaleResolutionDownBy === undefined) delete updated.scaleResolutionDownBy;
            else if (original) updated.scaleResolutionDownBy = original.scaleResolutionDownBy;
          } else if (source === Track.Source.Camera && index === params.encodings.length - 1) {
            const maxBitrate = CAMERA_LOW_BITRATE[settings.lowCameraHeight];
            updated.maxBitrate = Math.min(encoding.maxBitrate ?? maxBitrate, maxBitrate);
            updated.maxFramerate = Math.min(encoding.maxFramerate ?? CAMERA_LOW_MAX_FRAMERATE, CAMERA_LOW_MAX_FRAMERATE);
            const sourceHeight = sender.track?.getSettings().height ?? 540;
            updated.scaleResolutionDownBy = Math.max(1, sourceHeight / settings.lowCameraHeight);
          } else if (source === Track.Source.ScreenShare) {
            updated.maxBitrate = Math.min(encoding.maxBitrate ?? layerBudget, layerBudget);
            updated.maxFramerate = Math.min(encoding.maxFramerate ?? settings.lowScreenFps, settings.lowScreenFps);
          }
          return updated;
        });
        await sender.setParameters({ ...params, encodings });
      } catch {
        // A sender can be replaced or renegotiated while a quality change is being applied.
      }
    };

    const applyPublishedTracks = async (nextLevel: AdaptiveMediaLevel) => {
      const updates: Promise<void>[] = [];
      for (const publication of room.localParticipant.videoTrackPublications.values()) {
        if (publication.source !== Track.Source.Camera && publication.source !== Track.Source.ScreenShare) continue;
        const sender = publication.track?.sender;
        if (sender) updates.push(applySenderLevel(sender, publication.source, nextLevel));
      }
      await Promise.all(updates);
    };

    const queueLevel = (nextLevel: AdaptiveMediaLevel) => {
      pendingUpdates = pendingUpdates.then(() => applyPublishedTracks(nextLevel)).catch(() => {});
    };

    const cancelRecovery = () => {
      if (recoveryTimer === undefined) return;
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
    };
    const updateRecovery = (reason: string) => {
      if (level !== 'low') return;
      if (qualityNeedsRecovery || outboundLow) {
        cancelRecovery();
        return;
      }
      if (recoveryTimer !== undefined) return;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (level !== 'low') return;
        level = 'normal';
        log('adapt', { level, reason });
        queueLevel(level);
      }, settings.adaptHoldSec * 1000);
    };

    const lowerQuality = (reason: string) => {
      if (level !== 'low') {
        level = 'low';
        log('adapt', { level, reason });
        queueLevel(level);
      }
      if (qualityNeedsRecovery || outboundLow) cancelRecovery();
    };

    const onStats: AdaptiveMediaStatsHandler = (stats) => {
      const available = stats.availOutKbps;
      if (available === null) {
        lowSamples = 0;
        return;
      }
      if (available < settings.adaptAvailOutKbps) {
        lowSamples += 1;
        if (lowSamples >= 2 && !outboundLow) {
          outboundLow = true;
          lowerQuality('low-outbound-bitrate');
        }
        if (level === 'low') cancelRecovery();
        return;
      }
      lowSamples = 0;
      outboundLow = false;
      updateRecovery('outbound-bitrate-recovered');
    };

    const onQuality = (quality: ConnectionQuality) => {
      if (quality === ConnectionQuality.Poor) {
        qualityNeedsRecovery = true;
        lowerQuality('connection-quality');
      } else if (quality === ConnectionQuality.Good || quality === ConnectionQuality.Excellent) {
        qualityNeedsRecovery = false;
        updateRecovery('connection-quality-recovered');
      }
    };

    const onDisconnected = () => {
      lowSamples = 0;
      outboundLow = false;
      cancelRecovery();
    };
    const onConnected = () => {
      lowSamples = 0;
      outboundLow = false;
      const quality = room.localParticipant.connectionQuality;
      if (quality === ConnectionQuality.Poor) {
        qualityNeedsRecovery = true;
        lowerQuality('connection-quality');
      } else if (quality === ConnectionQuality.Good || quality === ConnectionQuality.Excellent) {
        qualityNeedsRecovery = false;
        updateRecovery('connection-quality-recovered');
      }
      if (level === 'low') queueLevel(level);
    };
    const onTrackPublished = () => {
      if (level === 'low') queueLevel(level);
    };

    statsHandler.current = onStats;
    room.localParticipant.on(ParticipantEvent.ConnectionQualityChanged, onQuality);
    room.localParticipant.on(ParticipantEvent.LocalTrackPublished, onTrackPublished);
    room.on(RoomEvent.Disconnected, onDisconnected).on(RoomEvent.Connected, onConnected).on(RoomEvent.Reconnected, onConnected);
    if (room.localParticipant.connectionQuality === ConnectionQuality.Poor) lowerQuality('connection-quality');

    return () => {
      cancelRecovery();
      if (statsHandler.current === onStats) statsHandler.current = undefined;
      room.localParticipant
        .off(ParticipantEvent.ConnectionQualityChanged, onQuality)
        .off(ParticipantEvent.LocalTrackPublished, onTrackPublished);
      room.off(RoomEvent.Disconnected, onDisconnected).off(RoomEvent.Connected, onConnected).off(RoomEvent.Reconnected, onConnected);
    };
  }, [room, log, statsHandler, settings]);
}
