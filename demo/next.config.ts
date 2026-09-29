import { cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { NextConfig } from 'next';

// demo/ is its own npm project inside the space repo (no root package.json). Pin the root so Next
// doesn't go looking for lockfiles in parent directories (e.g. a stray one above the repo).
const root = path.resolve(__dirname);

// Background effects load MediaPipe's wasm from our own origin (`useBackgroundEffect.ts`). Copy it
// from the exact @mediapipe/tasks-vision that @livekit/track-processors bundles, so the JS and wasm
// versions can't drift. Runs on every `next dev`/`next build`; public/mediapipe/wasm is gitignored.
const tasksVision = path.dirname(
  createRequire(require.resolve('@livekit/track-processors')).resolve('@mediapipe/tasks-vision'),
);
cpSync(path.join(tasksVision, 'wasm'), path.join(root, 'public/mediapipe/wasm'), { recursive: true });

// Noise cancellation (`useNoiseFilter.ts`) loads the RNNoise worklet and wasm from our origin. Copied
// from the installed @sapphi-red/web-noise-suppressor so they match its JS; public/rnnoise is gitignored.
const noiseSuppressor = path.dirname(require.resolve('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js'));
const rnnoiseDir = path.join(root, 'public/rnnoise');
cpSync(path.join(noiseSuppressor, 'workletProcessor.js'), path.join(rnnoiseDir, 'workletProcessor.js'));
for (const f of ['rnnoise.wasm', 'rnnoise_simd.wasm']) {
  cpSync(path.join(noiseSuppressor, '..', f), path.join(rnnoiseDir, f));
}

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
