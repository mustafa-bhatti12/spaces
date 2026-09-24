# Space — Self-Hosted Video Calling & Audio Recording Service

This repository provides self-hosted LiveKit WebRTC video calling, room token minting, Google Meet-style call controls, and audio recording with automated compression pipelines.

---

## 🖥️ Production-style deployment (droplet + Caddy + Railway)

Media, token-service, recording and compression run on one Linux VPS (Ubuntu / Debian) behind Caddy. One Next.js app, `demo`, runs on Railway: it serves the call page at `/` and the admin control center at `/admin`, and reaches the VPS over HTTPS, which is the same path a real consumer app takes.

### 1. VPS

Prerequisites the script does **not** install: Node.js 20.9+ and Docker (Docker is only needed for recording):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
curl -fsSL https://get.docker.com | sh
```

Start everything inside `tmux` so it survives SSH disconnects:

```bash
tmux new -s space
./start-all.sh
```

On Linux, the first run replaces the public dev credentials with generated ones in `token-service/.env` and `demo/.env`: the LiveKit key pair, `TOKEN_SERVICE_SHARED_SECRET` and `ADMIN_SHARED_SECRET`. LiveKit and Egress run from `.runtime/*.yaml` copies that contain those keys. The committed YAML files only ever hold `devkey`/`secret`.

Tell token-service which public URL to give browsers, then restart the script:

```bash
echo "LIVEKIT_PUBLIC_URL=wss://space.example.com" >> token-service/.env
```

### 2. Caddy (TLS)

Point an A record for your host at the VPS, then:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
space.example.com {
	@livekit path /rtc /rtc/*
	handle @livekit {
		reverse_proxy 127.0.0.1:7880
	}
	@blocked path /twirp /twirp/* /recording/webhook
	handle @blocked {
		respond 404
	}
	handle {
		reverse_proxy 127.0.0.1:8880
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

Firewall (a cloud firewall is preferred over `ufw`, because `ufw` also blocks the Egress container's traffic to the host):
- Inbound open: **22/tcp**, **80/tcp**, **443/tcp**, **7881/tcp**, **7882/udp**.
- Everything else closed, including 6379, 7880, 8880, 8888 and 8890.
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
- **Node.js** (v20.9+)
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
4. **Compressor Service** on `http://localhost:8890`
5. **Space Meet demo** (Next.js dev server) on `http://localhost:8888`. The browser connects to LiveKit at `ws://localhost:7880`, so local calls work from this machine only. Test calls between devices on the Railway deployment.

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

#### 3. Space Meet demo (Next.js)
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
   - Any participant can click **Record** in the control bar, or the operator can start it from `/admin`.
   - The demo's `/api/recording/start` calls token-service's `POST /recording/start`, which starts a LiveKit **RoomCompositeEgress** (audio-only). Everyone in the room sees the `REC` badge, with a timer and who started it.

2. **Storage & Auto-Stop:**
   - The audio stream is captured by the Egress worker container to `./egress/raw/<room>-<timestamp>.ogg`.
   - Recordings automatically stop if all participants leave the room (`room_finished` webhook).

3. **Compression & Archival:**
   - When the Egress finishes, LiveKit sends an `egress_ended` webhook to `token-service`.
   - `token-service` sends the raw audio to `compressor/` (`:8890`), which encodes it into a lightweight, high-clarity opus file in `./egress/compressed/` ready for Whisper / Deepgram speech-to-text processing.

---

## 🎨 UI Features (Space Meet demo)

Built on LiveKit's React components (`@livekit/components-react`) with LiveKit's default theme.

- **Lobby:** start a new room (random name) or join by name, plus a live list of active rooms.
- **Pre-join:** LiveKit `PreJoin` with camera preview, mic and camera on/off, device pickers, and a remembered display name.
- **Layouts:** adaptive grid, and a focus view with a thumbnail strip. Click a tile to pin it; screen shares take the stage automatically.
- **Controls:** mic and camera with device menus, screen share (including tab audio), raise hand, emoji reactions, chat with an unread badge, a people panel, audio recording, settings, and leave.
- **People panel:** everyone in the room with speaking state, mic/camera status, connection quality and raised hands (listed first).
- **Settings:** camera preview; camera, microphone and speaker selection; background blur (light or strong) or virtual backgrounds.
- **Top bar:** room name, participant count, `REC` badge with a timer and who started it, copy invite link, fullscreen.
- **Resilience:** a reconnecting banner, LiveKit connection toasts, and end screens that say why the call ended (left, removed by the host, room closed, or joined from another tab).
- **Admin (`/admin`):** password-protected operator console. Service health; live rooms and participants; remove, mute and close room; start and stop recording; play, download and delete recordings.
