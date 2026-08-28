# Space — self-hosted video calling service

This repo is the home of the LiveKit media server itself: how it's run, configured, and (later)
deployed. It is infrastructure, not an application. The thing that actually *uses* it — the
NestJS token endpoint and the Next.js call UI — lives in `hof-petition-studio`
(`apps/api/src/calls/`, `apps/web/src/app/calls/`), which is the first (and so far only) consumer.
If a second consumer ever needs video calls, it talks to the same server this repo defines, not a
copy of it.

## Why LiveKit

Chosen over mediasoup (library, not a server — would mean building signaling/room management from
scratch for no benefit at this scale), Jitsi (heavier JVM stack, harder to embed as a component
rather than an iframe), OpenVidu (adds its own orchestration layer on top of a media engine, which
is redundant once our own NestJS backend is already the control plane), and Galène (simpler, but no
server-side SDK or React component ecosystem, so the token-issuing and UI work would all be
hand-rolled). LiveKit's Node server SDK (`livekit-server-sdk`) and React components
(`@livekit/components-react`) are the reason a small team can ship this without owning a WebRTC
stack.

## Local development

Run the server natively, not in Docker. Docker Desktop on macOS cannot expose LiveKit's WebRTC UDP
ports cleanly (no real host networking), and LiveKit's own docs recommend the native binary for
local dev specifically for this reason. Docker Compose is the right tool for the production/Linux
deployment below, where host networking works normally.

```bash
brew install livekit
livekit-server --dev
```

This binds `127.0.0.1:7880` (signaling/HTTP) with the fixed development credentials `devkey` /
`secret` — no config file needed. `hof-petition-studio`'s API reads these via `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in its own `.env` (see that repo's root `.env.example`).

Sanity-check it's up: `curl http://127.0.0.1:7880/` should return `200 OK`. For a check that
doesn't depend on any consuming app, `brew install livekit-cli` and:

```bash
lk room join --url ws://localhost:7880 --api-key devkey --api-secret secret \
  --identity smoke-test --publish-demo smoke-room
```

## Production (not yet built)

- **Host:** Oracle Cloud Infrastructure, Dubai or Abu Dhabi region — closest to the Gulf/Pakistan
  client base, and OCI's egress pricing is the deciding factor over Hetzner/DigitalOcean/Vultr at
  this traffic profile. `VM.Standard.E4.Flex` (x86, not the Arm Always-Free tier, to avoid Oracle's
  Arm reclaim risk), ~4 OCPU / 8GB, roughly $26-35/month plus block storage.
- **Packaging:** Docker Compose + a `livekit.yaml` config file — this is where that config and
  compose file belong once written; do not put them in `hof-petition-studio`.
- **TURN:** Cloudflare Realtime (free tier covers this call volume), not self-managed coturn.
- **Recording:** LiveKit Egress, audio-only by default (video egress is ~4x the cost), feeding the
  AI petition-drafting pipeline as transcripts. Not built yet — do not add recording config here
  speculatively; add it when the transcript pipeline is actually being wired up.
- **Fallback:** Google Meet stays available as a manual break-glass option if this server is down;
  there's no on-call rotation, so an automatic failover isn't planned.

None of the above is implemented yet. This section exists so that whoever builds it doesn't
re-litigate the hosting/TURN/recording decisions — they were already made; only the Docker Compose
and `livekit.yaml` remain to be written.
