/**
 * Mic capture for the pre-join preview and the call: the browser's own echo cancellation, noise
 * suppression and auto gain always on. Chrome's Voice isolation stays off (LiveKit's audioDefaults
 * turn it on); the only extra filter is RNNoise, behind Settings → Microphone (`useNoiseFilter.ts`).
 */
export const MIC_PROCESSING = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: false,
} as const;
