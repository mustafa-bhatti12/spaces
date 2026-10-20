export interface CallSettings {
  micPreset: 'telephone' | 'speech' | 'music';
  red: boolean;
  adaptive: boolean;
  adaptAvailOutKbps: number;
  adaptHoldSec: number;
  lowCameraHeight: 180 | 270 | 360;
  lowScreenFps: number;
  relayFallback: boolean;
  relayRttMs: number;
  relayDrops: number;
  statsIntervalSec: number;
}

export const DEFAULT_CALL_SETTINGS: CallSettings = {
  micPreset: 'speech',
  red: true,
  adaptive: true,
  adaptAvailOutKbps: 600,
  adaptHoldSec: 30,
  lowCameraHeight: 360,
  lowScreenFps: 5,
  relayFallback: true,
  relayRttMs: 2000,
  relayDrops: 2,
  statsIntervalSec: 15,
};
