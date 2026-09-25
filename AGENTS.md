# Spaces: working rules for AI agents

Read this before changing anything in this repo. It holds facts and rules; the step-by-step
droplet procedures (deploy, safe restart, verify) are in the `spaces-droplet-ops` skill. The product
is called **Spaces** in the UI (`demo/components/ui/Logo.tsx`); the repo and paths still say `space`.

**The stack in one line:** a self-hosted LiveKit video-calling stack — `livekit-server` (media),
`token-service` (TS/Fastify, the only holder of LiveKit credentials), `compressor` (JS/Fastify,
internal-only), Redis and a Dockerized LiveKit Egress worker for audio recording, all on one
DigitalOcean droplet behind Caddy — plus one Next.js 16 app on Railway, `demo`, serving the
LiveKit-React-components call UI at `/` (a stand-in consumer) and the operator control center at
`/admin`.

This repo is also infrastructure for a consumer app, `hof-petition-studio` (sibling repo, in the
parent `space-repos/` workspace) — it decides who may join which room and calls this repo's token
API; it never gets its own LiveKit credentials. Don't add anything Petition-Studio-specific here;
keep this repo generic so any future consumer can reuse it the same way. Don't edit anything inside
`hof-petition-studio/` from this repo's context — that repo owns its own `AGENTS.md`.

## Working here

- **The user edits and commits in parallel.** Run `git status --short` first, stage only the paths
  you changed (`git add <path>…`, or `git commit -m … -- <path>…` for tracked files), never
  `git add -A` / `commit -a`. Their uncommitted files are theirs; leave them alone.
- **Where a change goes live:** push to `main` → Railway rebuilds `demo` by itself (a few minutes).
  Droplet changes need `ssh space-do 'cd ~/space && git pull -q --ff-only'`. token-service runs
  under `tsx watch`, so a pull reloads it with no call impact. Anything else (`start-all.sh`,
  `livekit/config.yaml`, `egress/config.yaml`, compressor, `.env`) needs `systemctl restart
  spaces`, which drops live calls: check for live rooms first and ask the user if anyone is in one.
- **Verify on the real surface:** `/root/tools/stack-check.sh` on the droplet (health, every
  service, a join over the public URL, a recording through to its compressed file); `puppeteer-core`
  scripts in `/tmp` for UI and calls (see "Testing"). `npm test` in `token-service`, `npm run build`
  in `demo`.
- **Record what shipped** in `CHANGELOG.md` (newest first, one line per user-visible change), and
  update this file when you learn a fact the next agent would otherwise rediscover. Delete facts
  that stop being true instead of adding a correction next to them.

---

## Architecture

```mermaid
graph LR
  subgraph Railway
    DM["demo / (Next.js)\ncall UI, consumer stand-in"]
    AD["demo /admin\noperator control center"]
  end
  subgraph Droplet
    CA["Caddy :443\nspaces.hofmigration.com"]
    TS["token-service :8880"]
    LK["livekit-server\n:7880 / 7881 tcp / 7882 udp"]
    CO["compressor\n127.0.0.1:8890"]
    RD[(Redis :6379)]
    EG["egress worker\n(Docker)"]
  end
  Browser -->|page + /api/*| DM
  Operator -->|page + login| AD
  DM -->|"Bearer TOKEN_SERVICE_SHARED_SECRET\n/token /rooms /participant /recording/*"| CA
  AD -->|"Bearer ADMIN_SHARED_SECRET\n/admin/*"| CA
  Browser -->|"wss /rtc (signaling)"| CA
  Browser -->|"media 7881/7882"| LK
  Browser -->|"TURN/TLS 443 (blocked networks)"| CA
  CA -->|/rtc| LK
  CA -->|"SNI turn.* → PROXY v2 → :5349"| LK
  CA -->|everything else| TS
  TS -->|holds LIVEKIT_API_KEY/SECRET| LK
  LK -->|redis pub/sub| RD
  EG -->|redis pub/sub| RD
  EG -->|writes| RAW[egress/raw/*.ogg]
  LK -->|"webhook (localhost): egress_ended, room_finished"| TS
  TS -->|"POST /compress"| CO
  CO -->|writes| COMP[egress/compressed/*.ogg]
```

| Service | Lang | Runs on | Port | Holds | Purpose |
|---|---|---|---|---|---|
| `livekit-server` | Go binary | droplet | 7880 ws/http, 7881 tcp, 7882 udp | LiveKit key pair (runtime config) | Media server (SFU). Native, not Docker — see below. |
| `token-service` | TypeScript, Fastify | droplet | 8880 | LiveKit key pair, both bearer secrets | **Only** thing that mints tokens or talks to LiveKit's admin/egress API. Consumer routes + operator `/admin/*` routes. |
| `compressor` | JS, Fastify | droplet | 8890, bound `127.0.0.1` | nothing | Shrinks a finished recording via `ffmpeg`. Never LAN-reachable, so no auth. |
| Redis | — | droplet | 6379 | — | Job queue LiveKit server ↔ Egress worker use to coordinate. Recording-only; calling works without it. |
| Egress worker | Docker (`livekit/egress`) | droplet | — | LiveKit key pair (runtime config) | Joins a room as a hidden participant, records mixed audio to `egress/raw/`. |
| Caddy | — | droplet | 80/443 | Let's Encrypt certs | TLS for `spaces.hofmigration.com`: `/rtc` → LiveKit, `/twirp` + `/recording/webhook` blocked, everything else → token-service. Also, via the `layer4` plugin (custom build, see README), TURN/TLS for `turn.hofmigration.com` → LiveKit's TURN on `127.0.0.1:5349`. Config: `deploy/Caddyfile`. |
| `demo` | TypeScript, Next.js 16, React 19, Node ≥ 22.22 (`livekit-client`'s `machina` requires it), `@livekit/components-react` | Railway `https://spaces-demo.up.railway.app` (also local via `start-all.sh`) | `$PORT` (8888 locally) | `TOKEN_SERVICE_SHARED_SECRET`; plus `ADMIN_SHARED_SECRET` + `ADMIN_PASSWORD` for `/admin` | `/` + `/rooms/[room]`: full call UI (pre-join, grid/focus, chat, people, devices, background blur/virtual backgrounds, reactions, raise hand, record, invite, reconnect banner) — throwaway, simulates Petition Studio's path. `/admin`: the permanent operator control center. Server routes under `app/api/*` and `app/admin/*` hold the secrets; the browser never sees them. |

## Security model

- `token-service` is the **only** thing in this repo (or any consumer) that ever holds real LiveKit
  credentials. Everything else gets a short-lived, room-scoped join token.
- **Two bearer secrets, checked in `token-service/src/auth.ts`:** `TOKEN_SERVICE_SHARED_SECRET` for
  consumer routes (`/token`, `/rooms`, `/participant`, `/recording/*`, `/room/end`) — held by `demo` and later
  Petition Studio's API; `ADMIN_SHARED_SECRET` for the operator-only `/admin/*` routes (remove people,
  close rooms, delete recordings) — held only by `demo`'s `/admin` server routes
  (`demo/lib/server/tokenService.ts`, `kind: 'admin'`). Never give a consumer the admin secret; a
  leaked consumer secret must not be able to moderate or delete. Neither is a user-auth system —
  `token-service` has no concept of a logged-in person.
- **Hosting is the consumer's decision; token-service only records and enforces it.** `/token` with
  `host: true` stores the identity in the room's LiveKit metadata (`recordRoomHost`, creating the room
  if needed; `GET /rooms` reports it as `host`) and mints a token with `roomAdmin` + attribute
  `space.host`. `/room/end` takes the participant's own join token and deletes the room only if the
  token verifies and carries `roomAdmin` for that room (expired tokens accepted for 24 h, since calls
  outlive the 2 h TTL). The demo's rule (`demo/app/api/connect/route.ts`): no recorded host, or you
  are the recorded host → you host. Since demo identities are unauthenticated device ids, that's only
  as strong as the demo's join itself; a real consumer passes `host` from its own auth. The
  `space.host` attribute is display-only (participants can edit their own attributes).
- **`/admin` is the only login in the repo** (`demo/lib/server/adminSession.ts`): `ADMIN_PASSWORD`,
  an HMAC-signed `HttpOnly; SameSite=Strict; Path=/admin` session cookie (12 h, `Secure` over HTTPS),
  and 5-failures-per-15-min rate limiting. The limit keys on `X-Forwarded-For` only when
  `TRUST_PROXY=1` (Railway); otherwise all clients share one bucket so nobody can spoof past it.
- **The admin lives inside the throwaway app by choice** (one Railway URL for both). When the call UI
  is retired, keep `app/admin/*`, `components/admin/*` and `lib/server/*` as the admin app — don't
  delete them with it.
- **The demo call UI has no login** — anyone with its URL can join rooms and press Record. That's
  accepted for a stand-in; Petition Studio will gate who joins which room.
- **Tokens grant `canUpdateOwnMetadata`** so a participant can set its own `hand` attribute (raise
  hand). It only covers the participant's own metadata/attributes.
- `compressor` has **no auth at all** — deliberately. It's bound to `127.0.0.1`, so nothing outside
  this host can reach it regardless. Don't add a shared secret to it; that would be solving a problem
  the bind address already solves.
- LiveKit webhooks are verified via `WebhookReceiver` (JWT in the `Authorization` header, signed with
  the LiveKit API secret) — see gotchas below for the header-name trap. LiveKit posts them to
  `localhost:8880`; Caddy answers `404` for `/recording/webhook` from outside.
- **Real credentials live only on the droplet and in Railway variables.** The repo is public and its
  committed `devkey`/`secret` + `local-dev-secret-not-for-production` are LiveKit's/our published dev
  values. On Linux (not macOS) `start-all.sh`'s `ensure_real_credentials` replaces
  them once with generated ones in the gitignored `token-service/.env` / `demo/.env` (plus
  `ADMIN_SHARED_SECRET`), and `write_runtime_configs` renders `.runtime/livekit.yaml` and
  `.runtime/egress.yaml` with that key pair. The committed YAMLs keep only the dev pair — never put a
  real key in them.
- **Only `compressor` is loopback-bound.** `token-service` (8880), `livekit-server` (7880) and the
  Redis that `start-all.sh` launches (6379, `--bind 0.0.0.0 --protected-mode no`, no password) all
  listen on `0.0.0.0`. On the droplet the Cloud Firewall keeps them private and Caddy is the only
  public way in — see "Deployment". Redis must stay `0.0.0.0` (the Egress container reaches it over
  the Docker bridge, not loopback), so don't "fix" this by rebinding it to `127.0.0.1`.
- **Never expose `/twirp`** (LiveKit's admin API) publicly. Caddy blocks it; `token-service` reaches
  it on localhost. Browsers only ever need `/rtc`.

## Why Egress is the only thing in Docker

Docker Desktop on macOS can't expose LiveKit's WebRTC UDP ports cleanly (no real host networking),
so `livekit-server` runs as the native binary. Egress doesn't need inbound WebRTC ports — it connects
*out* to the already-running server as a client — so running it in Docker while the server stays
native works fine, and Docker is genuinely required there since LiveKit only ships Egress as a Docker
image (no native binary like `livekit-server --dev`).

## Deployment

**Droplet:** DigitalOcean, Singapore (SGP1), 2 vCPU / 4 GB RAM, Ubuntu 24.04 x64, IPv4 only, SSH
alias `space-do`. Singapore was picked for the client base (Pakistan + UAE); Pakistan→India routing
is unreliable, so Bangalore was rejected. 4 GB is the floor with recording on — Egress runs headless
Chrome with `--shm-size=1g`; don't downsize to 2 GB. Public host: `spaces.hofmigration.com` (A record
at Bluehost, which hosts `hofmigration.com` DNS) → Caddy on the droplet.

**Railway:** one service, `demo` (Root Directory `demo`; Railway runs `npm run build` then
`npm start`, and sets `PORT`), at `https://spaces-demo.up.railway.app`. Variables:
`TOKEN_SERVICE_URL=https://spaces.hofmigration.com`, `TOKEN_SERVICE_SHARED_SECRET`,
`ADMIN_SHARED_SECRET`, `ADMIN_PASSWORD`, `TRUST_PROXY=1`. It reaches token-service over the same
HTTPS path Petition Studio's API (also on Railway) will use.

Firewall (DigitalOcean Cloud Firewall — it filters outside the droplet, so it can't block the
Egress container → host traffic the way host `ufw` can):

|Open to the internet|Keep closed|
|---|---|
|22/tcp SSH, 80/tcp + 443/tcp Caddy, 7881/tcp + 7882/udp LiveKit media|6379 Redis, 7880 LiveKit (browsers reach `/rtc` via Caddy), 8880 token-service (via Caddy), 8888, 8890 compressor|

Railway's outbound IPs aren't static, so token-service can't be IP-allowlisted; the bearer secrets
over Caddy's HTTPS are the protection. Those are inbound rules. **Outbound stays DigitalOcean's
default allow-all (all TCP, all UDP, ICMP).** Don't tighten it: LiveKit sends media to each caller's
random high UDP/TCP port, so any outbound port allowlist silently breaks calls (people join and then
get no audio or video). `start-all.sh` also needs outbound 443 for apt, npm, Docker Hub, GitHub,
`get.livekit.io` and `api.ipify.org` (public-IP discovery), plus 53 for DNS.

Droplet-only settings in `token-service/.env` (gitignored): `LIVEKIT_PUBLIC_URL=wss://spaces.hofmigration.com`
(what `/token` returns as `serverUrl`; the demo hands it straight to the browser),
`TURN_DOMAIN=turn.hofmigration.com` (see TURN below), plus the generated key pair and secrets.
Caddy config is `deploy/Caddyfile` with the real hosts, installed as `/etc/caddy/Caddyfile`.

**TURN (relay for networks that only allow HTTPS):** LiveKit's built-in TURN, switched on by
`TURN_DOMAIN` (`start-all.sh` appends the `turn:` block to `.runtime/livekit.yaml`; needs
livekit-server 1.13.7+ for `proxy_protocol`, older versions get a warning and no TURN). LiveKit
always advertises `turns:<domain>:443` (hardcoded) but listens on `tls_port` 5349, so Caddy owns
443: its `layer4` listener wrapper matches the TURN host's SNI, terminates TLS with its own
Let's Encrypt cert (the `turn.hofmigration.com { respond 404 }` site block exists only to get
that cert) and forwards plain TCP with a PROXY v2 header (`external_tls` + `proxy_protocol`).
Without the header TURN reports Caddy's `127.0.0.1` as the caller's address, which Firefox
rejects; with `proxy_protocol` on, connections without a header are refused. No UDP TURN: UDP 443
is Caddy's HTTP/3. Caddy is the `caddy-l4` build at `/usr/bin/caddy.custom`, chosen by
`update-alternatives` over the apt one (diverted to `/usr/bin/caddy.default`), so `apt upgrade`
doesn't overwrite it; update it with `caddy upgrade`, which keeps the plugin.
To prove TURN works, connect a real browser with `rtcConfig: { iceTransportPolicy: 'relay' }` (Chrome
needs a secure origin for the fake mic) and read `getStats()`: the transport's selected candidate
pair should have a `relay` local candidate with `relayProtocol: 'tls'` and url
`turns:turn.hofmigration.com:443`, and audio `bytesSent` should grow. Callers don't need a separate
STUN server: with no UDP TURN port and no `rtc.stun_servers`, LiveKit hands browsers its default
public STUN list, and the SFU is reached on its own public `node_ip` anyway.

What `start-all.sh` does and doesn't do on a bare Linux host:

- **Does:** `apt-get` installs Redis/ffmpeg, installs `livekit-server`, generates real credentials
  once (see "Security model"), writes `.runtime/livekit.yaml` (key pair + `use_external_ip: true` +
  `node_ip: <public IPv4>` so ICE candidates are reachable) and `.runtime/egress.yaml`.
  `SPACE_PUBLIC_IP` overrides IP detection. It does **not** start the demo on a VPS (Railway hosts it).
- **Doesn't:** install Node (need Node 20+ first — `ensure_npm_env` only runs `npm install`),
  install Docker (`curl -fsSL https://get.docker.com | sh`), or install/configure Caddy. It runs in
  the foreground and supervises: if LiveKit, token-service, the compressor or its Redis exits, it
  stops the rest and exits 1.
- **On the droplet it runs under systemd as `spaces.service`** (`deploy/spaces.service`, symlinked
  into `/etc/systemd/system/`; install steps are in the unit's header). It starts on boot and
  restarts the whole stack 5 s after a service dies (`Restart=on-failure`; it gives up after 5
  failures in 5 minutes). Use `systemctl status|restart|stop spaces` and `journalctl -u spaces -f`;
  don't also run `start-all.sh` by hand there (two copies fight over the ports). The recording
  container has `--restart on-failure`, and Ubuntu's `redis-server.service` is disabled because
  `start-all.sh` runs its own Redis on 0.0.0.0 for the container. The tools on the droplet are
  `/root/tools/stack-check.sh` (full end-to-end check), `/root/tools/lk` (LiveKit CLI) and
  `/root/tools/turn-enable.sh` (the one-off TURN switch-on, already run).
- **Host `ufw`:** if enabled with default-deny incoming, it also drops the Egress container's traffic
  to host Redis/LiveKit over `docker0`. It's inactive on the droplet; keep it that way, or
  `ufw allow from 172.17.0.0/16`.
- **Logs:** `/tmp/livekit.log`, `/tmp/token-service.log`, `/tmp/compressor.log`, `/tmp/redis.log`,
  `/tmp/demo.log` (local only), `journalctl -u spaces` (start-all's own output: which service died,
  restarts), `docker logs space-egress`, `journalctl -u caddy`.
- **Harmless startup lines:** `could not validate external IP ... from 172.17.0.1:7882 ... context
  canceled` is LiveKit cancelling its parallel per-interface checks once one succeeded; only worry if
  no `using external IPs` line follows.
- **Ubuntu auto-updates run in the quiet hours.** `unattended-upgrades` is on (security updates).
  Drop-ins in `/etc/systemd/system/apt-daily{,-upgrade}.timer.d/override.conf` move the list refresh
  to 21:00 UTC and the install to 22:00 UTC (03:00 PKT, 02:00 UAE), each +30 min random, instead of
  the stock 06:00 UTC (11:00 PKT). An install run takes 10+ minutes, pushes CPU to ~50–60%, and can
  restart `containerd`; a sudden CPU jump in `/admin` around then is that, not Spaces (`top`, look
  for `unattended-upgrade`, `apt-check`, `fwupd`, `packagekit`).
- **Reboots are safe:** `spaces.service` brings the whole stack back (verified: up about 10 s after
  boot, join and recording working). When an update leaves `/var/run/reboot-required` (kernel, libc),
  reboot in a quiet window; it still drops any live call for the ~30 s it takes.

Locally (macOS) the demo runs `next dev` on 8888 and the browser connects straight to
`ws://localhost:7880` (token-service's `LIVEKIT_URL`, since `LIVEKIT_PUBLIC_URL` is unset). That only
works from the same machine; test multi-device calls on the Railway deployment.

## Non-obvious gotchas (already hit, already fixed — don't rediscover these)

- **`livekit-server --dev` cannot sign egress webhooks.** Its placeholder-key mode has no
  `webhook.api_key`, so `StartRoomCompositeEgress`'s `webhooks` field silently fails
  (`"no signing key or secret was provided"` in the server log — the recording itself still starts,
  it just never notifies anyone when it's done). Recording requires the real
  `livekit/config.yaml`, not CLI flags. `start-all.sh` picks the config automatically when Redis is
  up and falls back to `--dev` (calling-only) when it isn't — don't revert that to a bare `--dev`.
- **The `--dev` fallback (no Redis) gets the real key pair via `LIVEKIT_KEYS`,** not `--keys` (that
  would show the secret in `ps`). `--dev` otherwise defaults to `devkey`/`secret`, which wouldn't
  match the generated keys token-service holds on the droplet.
- **LiveKit's webhook `Content-Type` is `application/webhook+json`**, not `application/json`.
  Fastify's default JSON parser won't touch it — you'll get a bare `415` with no other clue.
- **LiveKit's webhook auth header is the standard `Authorization`**, despite
  `livekit-server-sdk`'s own `WebhookReceiver.ts` exporting a constant named `authorizeHeader =
  'Authorize'`. That constant is misleading for this purpose; trust the wire behavior, not the name.
- **On Linux the egress container can't write to a root-owned `egress/raw`.** The `livekit/egress`
  image runs as uid 1001. Docker Desktop (macOS) ignores bind-mount permissions; a Linux VPS doesn't,
  so the recording goes `egress_active` → `egress_failed` with `Local upload failed: open
  /out/raw/<file>.ogg: permission denied` only when it's finalized. `start-all.sh` `chmod 0777`s
  `egress/raw` before starting the container; keep that.
- **The Docker volume mount shifts the path by one segment.** `docker run -v egress:/out` means
  `/out/raw/<file>` on the container side is `egress/raw/<file>` on the host — *not*
  `egress/recordings/raw/<file>`. The container-path→host-path mapping lives in exactly one place:
  `token-service/src/livekit.ts`'s `containerPathToHostPath`. If you ever change the mount, that's
  the only function that needs to know.
- **RoomComposite egress requires the room to already exist.** You can't start recording a room
  before at least one participant has joined it — LiveKit rooms are created on first join, not
  pre-created. `POST /recording/start` on a room nobody's in yet 404s
  (`"requested room does not exist"`).
- **Audio-only billing only applies if `layout` and `customBaseUrl` are left unset** on the egress
  request. Setting either routes the recording through the video pipeline even with `audioOnly: true`.
- **Identity is a per-browser `deviceId` (localStorage), not the typed display name.** Rejoining with
  the same identity evicts the earlier connection instead of adding a second participant — this is
  intentional (stops the same browser tab-duplicating into a room under two names) but means the
  duplicate-identity heartbeat (`/api/whoami`) and its 5s poll exist to force a *prompt* eviction,
  because LiveKit's own push-based disconnect to the losing side wasn't observed firing promptly.
- **`/admin/overview` fails per part, not all-or-nothing.** With the egress worker down, LiveKit's
  `listEgress` errors (`egress not connected (redis required)`); rooms and saved files still return,
  and the failing part is named in `errors`. The same missing worker makes the call page's
  `/api/recording/status` 500 locally — expected without Docker; the UI treats it as "not recording".
- **Don't remount the Room.** The demo creates one `Room` per join in a `useState` initializer and
  connects through `useSequentialRoomConnectDisconnect` (`components/conference/Conference.tsx`);
  props/handlers passed into it (`onLeave`, `details`, `choices`) must be referentially stable or the
  effect reconnects — LiveKit's "don't remount LiveKitRoom" guidance.
- **Every camera open costs a real camera about a second, so the pre-join must open it once.**
  LiveKit's `PreJoin` reopened it up to 4 extra times: `usePreviewTracks` recreates tracks when its
  `onError` prop changes identity (an inline arrow did that on every render); a first-visit camera
  is requested as `exact: 'default'` (no camera has that id, so it fails and retries); and each
  `MediaDeviceMenu` with an `initialSelection` calls `setDeviceId` on mount, which always restarts
  the device (the track holds `{exact: id}`, never equal to the plain id). `components/PreJoin.tsx`
  is `PreJoin`'s markup without those; keep its callbacks stable and its menus selection-free.
  Measure with a `getUserMedia` counter in the page (one call per visit is the target).
- **`supportsBackgroundProcessors()` creates a WebGL context per call.** Calling it on every render
  hit Chrome's context limit ("Too many active WebGL contexts") — check once (`useState`
  initializer in `useBackgroundEffect.ts`).
- **Some LiveKit components replace your `className` instead of merging it** (`Chat`,
  `MediaDeviceMenu`'s button). Style `Chat` via `.conference .lk-chat`, and pass `lk-button-menu`
  yourself on a `MediaDeviceMenu` you give a class to (that class draws its chevron).
- **Next bundles each route separately, so module-level state isn't shared between routes.** The
  admin session key is derived from `ADMIN_SHARED_SECRET` + `ADMIN_PASSWORD` (not random per module),
  and the login rate limit lives on `globalThis`.
- **Browser code that needs `window` (livekit-client, track processors) loads via
  `next/dynamic(..., { ssr: false })`** from a client component (`RoomClient.tsx`).
- **`livekit-server` drains on the first SIGTERM**: it keeps running (and holding 7880/7881/7882)
  until every participant leaves, so a replacement started right away just dies on the busy ports.
  A second SIGTERM forces it down. `systemctl restart spaces` doesn't wait for the drain: start-all's
  `cleanup` sends one SIGTERM, then systemd kills what's left (`KillMode=mixed`).
- **Audio first is split between server and client.** Downlink: the SFU's congestion control never
  throttles audio and steps video down per subscriber; `allow_pause: true` (`livekit/config.yaml`,
  default `false`) lets it pause video when even the lowest layer won't fit. Uplink: the SDK sends
  the mic at priority `high`; `Conference.tsx` marks the camera `very-low` (Chrome takes a sender's
  priority from `encodings[0]`, so the SDK only sets that one) with a 540p top layer, and
  `useAudioFirst` pauses the camera after 10 s of Poor/Lost quality, resuming after 10 s of Good.
  Don't cap layers with `setPublishingQuality()` for this: dynacast's own `setPublishingLayers()`
  overwrites it on the next subscription update.

## Testing / verification notes

- There's no automated WebRTC end-to-end suite. Real two-browser calls **do** work locally with
  `puppeteer-core` driving Chrome for Testing (`~/.cache/puppeteer/chrome/...`) launched with
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, one `browser.createBrowserContext()`
  per participant (separate localStorage → separate identities). Keep such scripts throwaway (e.g.
  `/tmp`), not in the repo. The omp browser tool's screenshots hung here once (Sept 2026); use
  puppeteer for scripted runs and `bsk` when you need the user's logged-in Chrome (Railway,
  Bluehost, GitHub settings).
- LiveKit's Chat panel stays mounted while hidden (`display: none`): wait for
  `.lk-chat-form-input` to be **visible** before typing, or keystrokes are silently lost.
- Verify the server/egress layers with the `lk` CLI (`lk room join --url ws://localhost:7880
  --api-key devkey --api-secret secret --publish-demo <room>`, or `--publish <file>.ogg` for real
  audio content egress can record). On the droplet the CLI needs the generated pair:
  `--api-key "$(grep ^LIVEKIT_API_KEY= token-service/.env | cut -d= -f2)"` (same for the secret).
- A raw WebSocket handshake against `https://spaces.hofmigration.com/rtc?access_token=<token>` returning
  `101 Switching Protocols` proves Caddy → LiveKit signaling end-to-end.
- `token-service` has real unit tests (`npm test`, Node's built-in test runner) for `mintToken` /
  `listActiveRooms` and `resolveRecordingFile` (the only gate between an admin-supplied filename and
  `fs.unlink`/reads — keep its traversal cases). `demo` and `compressor` have no test suite; verify
  with `npm run build` (typecheck) plus a browser run. Don't add a test framework speculatively.

## Conventions

- `token-service` and `demo` are TypeScript; `compressor` is plain JS (small, mechanical, not worth
  a build step).
- Droplet HTTP services use **Fastify**, not Express. The demo is **Next.js 16 App Router**: route
  handlers in `app/**/route.ts`, async `params`, `PageProps`/`RouteContext` generated types (run
  `npx next typegen` or a build before `tsc`). Read `demo/node_modules/next/dist/docs/` before using
  an unfamiliar Next API — `demo/AGENTS.md` is Next's own generated notice to that effect.
- Call UI uses **LiveKit's components and hooks** for anything they cover (useTrackToggle,
  MediaDeviceMenu/Select, ParticipantTile children, Chat, PreJoin, GridLayout/FocusLayout, useTracks,
  useParticipants, useDataChannel, useParticipantAttribute). The **look is Space's own**: a
  "conference speakerphone" system in `demo/app/globals.css`. It uses warm graphite surfaces, and its
  colors come only from signal lights (green = live, red = muted/recording/destructive, amber =
  attention). A recessed mono "status screen" (`Readout`) shows facts. Fonts are Hanken Grotesk +
  JetBrains Mono (`next/font`), and icons come from `lucide-react`. `@livekit/components-styles`
  stays underneath for layout mechanics, with its `--lk-*` theme variables remapped to Space tokens.
  Tokens, components and breakpoints are in `DESIGN.md`; users and principles in `PRODUCT.md`.
- `devkey` / `secret` appearing everywhere (`.env.example`, `livekit/config.yaml`,
  `egress/config.yaml`) is LiveKit's own published fixed dev credential, not a real secret — fine to
  commit, fine to see in logs. Real values exist only in gitignored `.env` files / `.runtime/` on the
  droplet and in Railway service variables; never commit them or paste them into docs.
- `egress/raw/` and `egress/compressed/` are gitignored — never commit recordings, and don't remove
  the gitignore entries to "fix" an empty-looking directory.
- Multiple terminals/processes may already be running these services manually outside any single
  agent's process tree (local dev laptop *and* the shared droplet) — `ps aux` / `lsof -i :<port>`
  before assuming a port is free or a service isn't already up, and expect that restarting a service
  may interrupt someone else's live call. Prefer spare ports (17880/18880/18888) for throwaway local
  test stacks.

## Where things live

- `token-service/src/livekit.ts` — all LiveKit SDK calls (tokens, rooms, participants, egress, path mapping).
- `token-service/src/index.ts` — consumer routes, including the `/recording/webhook` receiver.
- `token-service/src/admin.ts` — the operator `/admin/*` routes (overview, health, system metrics, moderation, recording files with Range support).
- `token-service/src/system.ts` — `GET /admin/system`: host CPU/memory/network, per-service process rows, versions, TLS expiry, deployed commit. Linux-only parts return null on macOS; rates are deltas between calls (first call after a restart has nulls). It runs on every console poll, so keep it cheap; the comments explain why it reads cgroup files instead of `docker stats`.
- `token-service/src/recordings.ts` — recording directories, safe filename resolution, file listing.
- `token-service/src/auth.ts` — the two bearer-secret `preHandler`s.
- `demo/app/api/*` — call-page server routes (`connect`, `rooms`, `whoami`, `recording/{start,stop,status}`) → token-service consumer routes.
- `demo/app/admin/*` — `/admin` page + `login`/`logout`/`session` routes + `api/[...path]` streaming proxy → token-service `/admin/*`.
- `demo/lib/server/tokenService.ts` — the only token-service client (both secrets); `demo/lib/server/adminSession.ts` — admin cookie + rate limit.
- `demo/components/RoomClient.tsx` — pre-join (`PreJoin.tsx`, LiveKit's `PreJoin` markup with one camera open) → join → end screen.
- `demo/components/conference/*` — `Conference` (Room lifecycle, audio-first publish defaults, duplicate-identity heartbeat, host's end-for-everyone), `ConferenceLayout` (VideoConference prefab expanded; one side panel at a time), `Dock` (status readout · media · talk · more · Leave), `LeaveDialog` (leave confirmation for everyone; host also gets end-for-everyone), `Tile`, `SidePanel`, `ParticipantsPanel`, `SettingsPanel` + `useBackgroundEffect`, `useAudioFirst` (pauses the camera on a weak uplink), `useReactions`, `useRecording`.
- `demo/components/ui/*` — `Menu` (dock popover), `Device` (wordmark, LED, readout, initials).
- `demo/components/admin/AdminDashboard.tsx` — the control center UI; `ServerPanel.tsx` (Server section: metric strips + processes table); `format.ts` (bytes, rates, durations).
- `demo/public/backgrounds/*.jpg` — virtual-background images.
- `compressor/server.js` — the one `/compress` endpoint.
- `livekit/config.yaml`, `egress/config.yaml` — real (non-`--dev`) server config templates with the dev key pair; read the comments in each before editing.
- `deploy/spaces.service` (systemd unit running `start-all.sh`), `deploy/Caddyfile` (site + TURN SNI route, example hosts).
- `start-all.sh` — local (macOS) / VPS orchestration for the droplet side, plus `next dev` for
  the demo when not on a VPS. Tries to install Redis / LiveKit / ffmpeg when they're missing.
  Degrades gracefully (calling still works) if Redis/Docker still aren't there.
- `.runtime/` (gitignored, mode 700) — generated `livekit.yaml` / `egress.yaml` with the real key
  pair; never edit, edit the committed templates. Runtime logs: `/tmp/*.log` (see "Deployment").
- `README.md` — user-facing quick start (local setup, droplet + Caddy + Railway deploy, UI feature list). This file is agent-facing; keep the two in sync but don't duplicate wholesale.
- `CHANGELOG.md` — what shipped, newest first. `DESIGN.md` / `PRODUCT.md` — the UI system and product context (the `impeccable` skill reads them).
