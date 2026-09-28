# Space — Self-Hosted Video Calling & Audio Recording Service

This repository provides self-hosted LiveKit WebRTC video calling, room token minting, Google Meet-style call controls, and low-bitrate audio recording.

---

## 🖥️ Production-style deployment (droplet + Caddy + Railway)

Media, token-service and recording run on one Linux VPS (Ubuntu / Debian) behind Caddy. One Next.js app, `demo`, runs on Railway: it serves the call page at `/` and the admin control center at `/admin`, and reaches the VPS over HTTPS, which is the same path a real consumer app takes.

### 1. VPS

Prerequisites the script does **not** install: Node.js 20+ and Docker (Docker is only needed for recording):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
curl -fsSL https://get.docker.com | sh
```

Run it once in the foreground to install what's missing and generate credentials (Ctrl+C when it prints "All services running"):

```bash
./start-all.sh
```

On Linux, the first run replaces the public dev credentials with generated ones in `token-service/.env` and `demo/.env`: the LiveKit key pair, `TOKEN_SERVICE_SHARED_SECRET` and `ADMIN_SHARED_SECRET`. LiveKit and Egress run from `.runtime/*.yaml` copies that contain those keys. The committed YAML files only ever hold `devkey`/`secret`.

Tell token-service which public URL to give browsers:

```bash
echo "LIVEKIT_PUBLIC_URL=wss://space.example.com" >> token-service/.env
```

Then install it as a service so it starts on boot and restarts itself if LiveKit, token-service or Redis dies. `deploy/spaces.service` assumes the repo is at `/root/space`; edit its paths if yours isn't.

```bash
ln -sf /root/space/deploy/spaces.service /etc/systemd/system/spaces.service
systemctl disable --now redis-server   # start-all.sh runs its own Redis, reachable from the recording container
systemctl daemon-reload && systemctl enable --now spaces
systemctl status spaces                # logs: journalctl -u spaces -f, plus /tmp/*.log per service
```

### 2. Caddy (TLS) and TURN

Point an A record for your host at the VPS, and a second one for the TURN relay (e.g. `turn.space.example.com`), then install Caddy from its apt repository:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

TURN relays call media over TLS on 443 for callers whose network blocks 7881/7882 (offices, hotels, some mobile carriers). It shares 443 with the site, which needs Caddy's `layer4` plugin. Install that build next to the packaged one, so `apt upgrade` keeps updating the stock binary without overwriting yours:

```bash
curl -fsSL -o /usr/bin/caddy.custom "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/mholt/caddy-l4"
chmod 755 /usr/bin/caddy.custom
dpkg-divert --divert /usr/bin/caddy.default --rename /usr/bin/caddy
update-alternatives --install /usr/bin/caddy caddy /usr/bin/caddy.default 10
update-alternatives --install /usr/bin/caddy caddy /usr/bin/caddy.custom 50
caddy list-modules | grep -q '^layer4' && echo layer4-ok   # upgrade later with: caddy upgrade
```

Install `deploy/Caddyfile` with your hosts, turn on TURN in LiveKit, and restart both (a restart, not a reload, the first time, so the new binary runs):

```bash
sed -e 's/turn.space.example.com/turn.your-host/g' -e 's/space.example.com/your-host/g' deploy/Caddyfile > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile && systemctl restart caddy
echo "TURN_DOMAIN=turn.your-host" >> token-service/.env   # needs livekit-server 1.13.7+
systemctl restart spaces
```

Without the TURN record and `TURN_DOMAIN`, skip the plugin and the `layer4` block in `deploy/Caddyfile`; calls work, except on networks that only allow HTTPS.

Firewall (a cloud firewall is preferred over `ufw`, because `ufw` also blocks the Egress container's traffic to the host):
- Inbound open: **22/tcp**, **80/tcp**, **443/tcp** (site and TURN), **7881/tcp**, **7882/udp**.
- Everything else closed, including 6379, 7880, 8880 and 8888.
- Outbound: leave the default allow-all, or media breaks.

### 3. Railway

Create one service from this repo with its **Root Directory** set to `demo`. Railway runs `npm run build` and `npm start`, and sets `PORT`.

| Service | Root Directory | Variables |
|---|---|---|
| demo | `demo` | `TOKEN_SERVICE_URL=https://space.example.com`, `TOKEN_SERVICE_SHARED_SECRET=<from VPS token-service/.env>`, `ADMIN_SHARED_SECRET=<from VPS token-service/.env>`, `ADMIN_PASSWORD=<choose one>`, `TRUST_PROXY=1` |

The call page is at the Railway URL; it gets `wss://space.example.com` from token-service and connects to LiveKit directly. The admin control center is at `<Railway URL>/admin`, behind `ADMIN_PASSWORD`. Leave the two `ADMIN_*` variables unset and `/admin` is disabled.

Optional `start-all.sh` override: `SPACE_PUBLIC_IP=203.0.113.10`. On a VPS the script doesn't start the demo (Railway hosts it). If Docker is missing, recording is skipped and calling still works.

---

## 💻 Local Development Setup

### Prerequisites
- **Node.js** v22.22+ for the demo (`livekit-client` requires it); v20+ is enough for the droplet services
- **LiveKit Server binary**:
  - macOS: `brew install livekit`
  - Linux: `curl -sSL https://get.livekit.io | bash`
- *(Optional for audio recording)*: **Docker** & **Redis** (`brew install redis` or `apt-get install redis-server`)

---

### Running All Services Locally

You can launch all services with a single command:

```bash
./start-all.sh
```

This script automatically launches:
1. **LiveKit Media Server** on `http://localhost:7880` (WebRTC on `:7881` TCP & `:7882` UDP)
2. **Redis & LiveKit Egress** (installs Redis when missing; starts Egress if Docker is available)
3. **Token Service** on `http://localhost:8880`
4. **Space demo** (Next.js dev server) on `http://localhost:8888`. The browser connects to LiveKit at `ws://localhost:7880`, so local calls work from this machine only. Test calls between devices on the Railway deployment.

---

### Running Services Individually

If you prefer running services in separate terminal tabs:

#### 1. LiveKit Media Server
```bash
livekit-server --dev --bind 0.0.0.0
```
*Binds `127.0.0.1:7880` with default development credentials (`devkey` / `secret`).*

#### 2. Token Service
```bash
cd token-service
npm install
cp -n .env.example .env
npm run dev
```
*Binds `:8880`. Mints LiveKit access tokens and manages room state.*

#### 3. Space demo (Next.js)
```bash
cd demo
npm install
cp -n .env.example .env
npx next dev -p 8888
```
*Binds `:8888`. The call UI (LiveKit React components) plus its server routes, which call token-service with the shared secret so the browser never sees it.*

#### 4. Admin control center (optional)
Set `ADMIN_PASSWORD` and `ADMIN_SHARED_SECRET` in `demo/.env`; the secret must match `ADMIN_SHARED_SECRET` in `token-service/.env`. Restart the demo and open `/admin`. That page is the operator login for live rooms (remove participants, mute tracks, close rooms), starting and stopping recordings, playing, downloading and deleting recordings, and service health.

---

## 🎙️ Audio Recording & Transcription Pipeline

1. **Recording Initiation:**
   - Every call is recorded by default: when the first person joins, LiveKit's `participant_joined` webhook tells token-service, which starts a LiveKit **RoomCompositeEgress** (audio-only, 24 kbps Opus). Everyone in the room sees the `REC` badge with a timer. `RECORD_ALL_CALLS=0` in `token-service/.env` turns this off.
   - Anyone in the call can press **Stop** (or **Record** again), and the operator can do the same from `/admin`. Once stopped by hand, a call isn't re-recorded when more people join.

2. **Storage & Auto-Stop:**
   - The Egress worker container mixes everyone's audio (no Chrome: egress's audio-only pipeline) and encodes it straight to the final 24 kbps Opus, about 11 MB an hour. `RECORDING_AUDIO_KBPS` in `token-service/.env` changes the rate.
   - Recordings automatically stop if all participants leave the room (`room_finished` webhook).

3. **Archival:**
   - When the Egress finishes, LiveKit sends an `egress_ended` webhook to `token-service`, which moves the finished file from `./egress/raw/` to `./egress/compressed/<room>-<timestamp>.ogg`. There is no second encoding pass.

4. **Transcription (Soniox):**
   - With `SONIOX_API_KEY` set in `token-service/.env`, every finished recording is sent to Soniox's async speech-to-text (`stt-async-v5`, speakers separated, language detected) and the transcript is saved as `./egress/transcripts/<recording>.ogg.json`. Soniox's copies are deleted as soon as it's done. A 1-hour call costs about $0.10.
   - `TRANSCRIPTION_LANGUAGE_HINTS` (e.g. `en,ur`) and `TRANSCRIPTION_TERMS` (e.g. `USCIS,NIW`) improve accuracy for the languages and words your calls use.
   - `/admin` shows each recording's transcript (view, download as `.txt`, retry a failed one). Consumers read them with `GET /recording/transcripts?room=<room>` (consumer secret).
   - Speakers are numbered ("Speaker 1", "Speaker 2"): the recording is one mixed track, so it carries no names.

---

## 🪟 Embedding a call

A consumer app mints a join token with `POST /token` (consumer secret) and iframes `/embed`. The token goes in the fragment, so it never reaches a server log:

```html
<iframe
  src="https://spaces-demo.up.railway.app/embed?origin=https://your-app.example#t=JOIN_TOKEN"
  allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write"
></iframe>
```

Add the parent origin to the demo's `EMBED_ALLOWED_ORIGINS` (comma-separated); it controls both `frame-ancestors` and which `?origin=` the bridge talks to. Embedded calls have no invite link or waiting room; only hosts (set by the token) see Record. Tokens last 2 hours.

The page and parent talk over `postMessage`, protocol `spaces-embed/1`:

| Direction | Message | Meaning |
|---|---|---|
| Spaces → parent | `ready` | Bridge is listening |
| Spaces → parent | `joined {room, identity}` | Joined the call |
| Spaces → parent | `left {reason}` | Left or the call ended |
| Spaces → parent | `recording {active}` | Recording started/stopped |
| Spaces → parent | `screenshare {active, surface}` | Local screen share started/stopped |
| Spaces → parent | `data {topic, payload, from, fromHost}` | App message from another participant |
| Spaces → parent | `expired` | Token rejected (401): mint a new one and remount |
| Parent → Spaces | `send {topic, payload, to: 'all' \| 'hosts'}` | Send an app message; `topic` starts with `app.`, payload ≤ 4096 bytes of JSON |

---

## 🎨 UI Features (Space demo)

Built on LiveKit's React components and hooks (`@livekit/components-react`), with Space's own look: warm graphite, signal-light colours, and one grouped control dock.

- **Lobby:** start a new room (random name) or join by name, plus a live list of active rooms.
- **Pre-join:** LiveKit `PreJoin` with camera preview, mic and camera on/off, device pickers, and the display name from your last call filled in.
- **Layouts:** adaptive grid, and a focus view with a thumbnail strip. Click a tile to pin it; screen shares take the stage automatically.
- **Dock:** a status readout (room, people, `REC` timer and who started it), then three key groups: mic, camera and screen share (device menus included); react (emoji, plus raise hand), chat with an unread badge, and people; and More (record, copy invite link, settings, full screen). Leave sits on its own. The mic key's ring is green when live, red when muted, and brighter while you speak.
- **Host:** whoever starts a room hosts it (and still does after rejoining), marked `HOST` in the people panel. A host can make anyone in the call a host too, or stop them hosting, from the people panel. Leave always asks for confirmation; only hosts also get ending the call for everyone.
- **People panel:** everyone in the room with speaking state, mic/camera status, connection quality and raised hands (listed first). Hosts also get the waiting room here.
- **Settings (side panel):** camera preview; camera, microphone and speaker selection; background blur (light or strong) or virtual backgrounds. Noise cancellation (DeepFilterNet3, in the browser) removes background noise from your mic; off until you turn it on, remembered per browser. Chrome's Voice isolation is off until that same switch is on.
- **Resilience:** a reconnecting banner, and end screens that say why the call ended (left, ended by you, ended for everyone, removed, or joined from another tab).
- **Audio first on weak connections:** the camera is sent at lower priority than the mic (540p max) and drops to lower quality first. Video is never paused on a weak connection.
- **Admin (`/admin`):** password-protected operator console. Service health; server metrics (CPU and load, memory, network throughput, TLS certificate expiry, deployed commit, host uptime, live call and recording-storage totals, and a per-service table of status, uptime, CPU, memory, version and PID); live rooms and participants; remove, mute and close room; start and stop recording; play, download and delete recordings; read, download and retry transcripts.
