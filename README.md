# Space — self-hosted video calling service

This repo is the home of the LiveKit media server and the only code that mints LiveKit tokens for
it. Both pieces of infrastructure live here; nothing outside this repo holds `LIVEKIT_API_KEY` /
`LIVEKIT_API_SECRET`. Consumers — `hof-petition-studio` is the first (and so far only) one, via
`apps/api/src/calls/` and `apps/web/src/app/calls/` — decide *who* may join *which* room, then ask
this repo's token API to mint the actual token. If a second consumer ever needs video calls, it
talks to the same token API, not a copy of it, and never gets its own LiveKit credentials either.

## Why LiveKit

Chosen over mediasoup (library, not a server — would mean building signaling/room management from
scratch for no benefit at this scale), Jitsi (heavier JVM stack, harder to embed as a component
rather than an iframe), OpenVidu (adds its own orchestration layer on top of a media engine, which
is redundant once our own NestJS backend is already the control plane), and Galène (simpler, but no
server-side SDK or React component ecosystem, so the token-issuing and UI work would all be
hand-rolled). LiveKit's Node server SDK (`livekit-server-sdk`) and React components
(`@livekit/components-react`) are the reason a small team can ship this without owning a WebRTC
stack.

## Components

- **Media server** — the actual LiveKit server. Handles WebRTC signaling and media.
- **`token-service/`** — a small Express app, the *only* thing that holds
  `LIVEKIT_API_KEY`/`SECRET` and talks to `livekit-server-sdk`. Deliberately generic: it knows
  nothing about cases, users, or call types — `POST /token` takes `{ room, identity, name }` and
  returns a signed join token plus the media server's URL. It doesn't decide who's allowed to join;
  the caller (currently `hof-petition-studio`'s `apps/api/src/calls/`) makes that decision and only
  calls this once access is already granted. Auth between them is a shared secret
  (`TOKEN_SERVICE_SHARED_SECRET`), not a user-facing auth system — this service has no concept of a
  logged-in person.

## Local development

Two processes, both native (not Docker):

```bash
# 1. Media server — brew install livekit && livekit-server --dev
livekit-server --dev
```

Docker Desktop on macOS cannot expose LiveKit's WebRTC UDP ports cleanly (no real host
networking), and LiveKit's own docs recommend the native binary for local dev specifically for this
reason. Docker Compose is the right tool for the production/Linux deployment below, where host
networking works normally. This binds `127.0.0.1:7880` with the fixed dev credentials `devkey` /
`secret` — no config file needed.

```bash
# 2. Token service
cd token-service
npm install
cp .env.example .env   # defaults already match the --dev credentials above
npm run dev
```

Binds `:8880` (override with `PORT`). `TOKEN_SERVICE_SHARED_SECRET` in this `.env` must match
`TOKEN_SERVICE_SHARED_SECRET` in `hof-petition-studio`'s root `.env` exactly, or every call from
that repo gets a 401.

Sanity-check both, independent of any consuming app:

```bash
curl http://127.0.0.1:7880/                                    # LiveKit itself → 200 OK
curl http://localhost:8880/health                                # token-service → {"ok":true}
curl -X POST http://localhost:8880/token \
  -H "Authorization: Bearer <TOKEN_SERVICE_SHARED_SECRET from token-service/.env>" \
  -H "Content-Type: application/json" \
  -d '{"room":"smoke-room","identity":"smoke-test","name":"Smoke Test"}'
  # → a real, signed token for LiveKit's own dev credentials
```

For a check of the media server alone with no HTTP layer at all,
`brew install livekit-cli` and `lk room join --url ws://localhost:7880 --api-key devkey
--api-secret secret --identity smoke-test --publish-demo smoke-room`.

## Production (not yet built)

- **Host:** Oracle Cloud Infrastructure, Dubai or Abu Dhabi region — closest to the Gulf/Pakistan
  client base, and OCI's egress pricing is the deciding factor over Hetzner/DigitalOcean/Vultr at
  this traffic profile. `VM.Standard.E4.Flex` (x86, not the Arm Always-Free tier, to avoid Oracle's
  Arm reclaim risk), ~4 OCPU / 8GB, roughly $26-35/month plus block storage.
- **Packaging:** Docker Compose on that VM, running both the media server and `token-service` as
  separate containers (plus a `livekit.yaml` config for the former) — this is where those files
  belong once written; do not put them in `hof-petition-studio`. `token-service` only needs a
  real `TOKEN_SERVICE_SHARED_SECRET` (long random value, not the local dev one) and the same three
  `LIVEKIT_*` vars pointed at the production media server instead of `localhost`.
- **TURN:** Cloudflare Realtime (free tier covers this call volume), not self-managed coturn.
- **Recording:** LiveKit Egress, audio-only by default (video egress is ~4x the cost), feeding the
  AI petition-drafting pipeline as transcripts. Not built yet — do not add recording config here
  speculatively; add it when the transcript pipeline is actually being wired up.
- **Fallback:** Google Meet stays available as a manual break-glass option if this server is down;
  there's no on-call rotation, so an automatic failover isn't planned.

None of the above is implemented yet. This section exists so that whoever builds it doesn't
re-litigate the hosting/TURN/recording decisions — they were already made; only the Docker Compose
and `livekit.yaml` remain to be written.
