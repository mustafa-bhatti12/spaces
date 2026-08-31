# Space — Self-Hosted Video Calling & Audio Recording Service

This repository provides self-hosted LiveKit WebRTC video calling, room token minting, Google Meet-style call controls, and audio recording with automated compression pipelines.

---

## 🚀 Quick Start with GitHub Codespaces (Free Remote VPS)

You can run and test this entire stack on a free cloud Linux VPS via **GitHub Codespaces** with zero local dependencies and no credit card required.

### Method A: Web Browser (Zero Installation)

1. Open this repository on GitHub: [`mustafa-bhatti12/spaces`](https://github.com/mustafa-bhatti12/spaces).
2. Click the green **`<> Code`** button $\rightarrow$ select the **Codespaces** tab.
3. Click **Create codespace on main**.
4. Once the terminal loads, start all services:
   ```bash
   ./start-all.sh
   ```
   The script installs Redis / LiveKit / ffmpeg when it can. In Codespaces the app itself speaks **HTTP** on `:8888` — that is expected. GitHub's port proxy already provides HTTPS, so you will **not** see `certs/` or a `wss proxy` log line.
5. In the **PORTS** tab (bottom panel next to Terminal):
   - Locate port **`8888`** (`Space Meet Web App`).
   - Right-click $\rightarrow$ **Port Visibility** $\rightarrow$ set to **`Public`**.
   - Click the **Open in Browser** (globe) icon or copy the public `https://*.app.github.dev` link.
   - Open that URL on your phone or share it with other participants to test the call!

---

### Method B: Terminal / SSH (Using GitHub CLI)

1. Authenticate with GitHub CLI on your local machine (if not already logged in):
   ```bash
   gh auth login
   ```

2. Create the Codespace cloud VPS:
   ```bash
   gh codespace create -R mustafa-bhatti12/spaces -b main
   ```

3. SSH into the remote Ubuntu terminal:
   ```bash
   gh codespace ssh
   ```

4. Launch all services inside the SSH session:
   ```bash
   ./start-all.sh
   ```

5. In a new local terminal tab on your machine, expose port 8888:
   ```bash
   # Make port 8888 publicly accessible
   gh codespace ports visibility 8888:public

   # View your live public URL
   gh codespace ports
   ```

---

## 🖥️ Bare VPS (Ubuntu / Debian)

Same command as Codespaces. On a machine with a public IP the script generates a self-signed cert covering that IP, and LiveKit advertises it for WebRTC:

```bash
./start-all.sh
```

Open these ports on the firewall (ufw/security group): **8888/tcp** (the app), **7881/tcp** and **7882/udp** (LiveKit media). Then share `https://<vps-ip>:8888` — browsers will warn once about the self-signed cert; proceed past it.

Optional overrides:

```bash
export SPACE_PUBLIC_IP=203.0.113.10
export SPACE_PUBLIC_HOST=meet.example.com
# If nginx/Caddy already terminates TLS in front of :8888:
export SPACE_HTTP=1
./start-all.sh
```

If Docker is missing, recording is skipped (calling still works). Install it with `curl -fsSL https://get.docker.com | sh`.

---

## 💻 Local Development Setup

### Prerequisites
- **Node.js** (v20+ or v22+)
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
5. **Space Meet Web App** on `https://localhost:8888` locally (self-signed cert, generated if missing) or `http://localhost:8888` in Codespaces (the `*.app.github.dev` proxy already terminates TLS)

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

#### 3. Space Meet Frontend & Unified Proxy
```bash
cd test-call
npm install
cp -n .env.example .env
node server.js
```
*Binds `:8888` (HTTPS & WSS). Serves the Google Meet UI and proxies WebSocket signaling to LiveKit.*

---

## 🎙️ Audio Recording & Transcription Pipeline

1. **Recording Initiation:**
   - Any participant can click the **REC** button in the top bar.
   - Client sends `POST /recording/start?room=<name>&startedBy=<name>`.
   - `token-service` starts a LiveKit **RoomCompositeEgress** (audio-only) and broadcasts the `REC` badge to all active participants.

2. **Storage & Auto-Stop:**
   - The audio stream is captured by the Egress worker container to `./egress/raw/<egress-id>.ogg`.
   - Recordings automatically stop if all participants leave the room (`room_finished` webhook).

3. **Compression & Archival:**
   - When the Egress finishes, LiveKit sends an `egress_ended` webhook to `token-service`.
   - `token-service` sends the raw audio to `compressor/` (`:8890`), which encodes it into a lightweight, high-clarity opus file in `./egress/compressed/` ready for Whisper / Deepgram speech-to-text processing.

---

## 🎨 UI Features (Space Meet)

- **Lobby Join Card:** Centered Google Meet-style join card with pre-call camera/mic check, audio level visualizer, initialed avatar fallback, room name randomizer ("Shuffle"), and active room chips.
- **In-Call Controls:** Floating bottom dock with circular action buttons for Microphone, Camera, Screen Share, Raise Hand (`✋`), Layout Switcher, Fullscreen, and Red Pill End Call.
- **Layout Modes:**
  - **Tiled (Grid):** Adaptive responsive grid (1, 2, 3–4, 5+ participants).
  - **Sidebar (Focus):** Large center stage for active speaker / presenter + right-hand thumbnail strip.
  - **Spotlight (Single):** Maximized view of the pinned participant or presentation.
- **Fullscreen Support:** Per-tile hover buttons (Pin / Fullscreen) and global fullscreen mode (<kbd>F</kbd> shortcut).
- **Aspect-Safe Screen Sharing:** Dedicated presentation stream rendered with `object-fit: contain`, presenter status banner, and automatic spotlight focus.
- **Browser Compatibility:** Single-port WSS/HTTPS architecture eliminating TLS certificate isolation errors in Firefox and Chromium.
