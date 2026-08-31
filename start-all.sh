#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
export PATH="/usr/local/bin:/usr/bin:${HOME}/.local/bin:$PATH"

echo "🚀 Starting Space Meet services..."

REDIS_PID=""
STARTED_REDIS=0
EGRESS_STARTED=0
HAS_CERT=0
LK_PID=""
TS_PID=""
CO_PID=""
TC_PID=""
PUBLIC_IP="${SPACE_PUBLIC_IP:-}"
PUBLIC_HOST="${SPACE_PUBLIC_HOST:-}"
LK_CONFIG="${ROOT}/livekit/config.yaml"

in_codespaces() {
  [ -n "${CODESPACES:-}" ] ||
    [ -n "${CODESPACE_NAME:-}" ] ||
    [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ] ||
    [ -n "${GITHUB_CODESPACE_TOKEN:-}" ]
}

have() { command -v "$1" >/dev/null 2>&1; }

can_sudo() {
  [ "$(id -u)" -eq 0 ] || sudo -n true >/dev/null 2>&1
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

apt_install() {
  can_sudo || return 1
  as_root apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

ensure_npm_env() {
  local dir="$1"
  if [ ! -d "$dir/node_modules" ]; then
    echo "📦 npm install in $dir..."
    (cd "$dir" && npm install)
  fi
  if [ ! -f "$dir/.env" ] && [ -f "$dir/.env.example" ]; then
    cp "$dir/.env.example" "$dir/.env"
  fi
}

# Keep token-service and test-call on the same shared secret. Fresh copies of the two
# .env.example files used to disagree, which made every /connect return 401.
align_shared_secret() {
  local tc_env="$ROOT/test-call/.env"
  local ts_env="$ROOT/token-service/.env"
  [ -f "$tc_env" ] && [ -f "$ts_env" ] || return 0
  local tc_sec ts_sec
  tc_sec="$(grep -E '^TOKEN_SERVICE_SHARED_SECRET=' "$tc_env" | head -1 | cut -d= -f2- || true)"
  ts_sec="$(grep -E '^TOKEN_SERVICE_SHARED_SECRET=' "$ts_env" | head -1 | cut -d= -f2- || true)"
  if [ -z "$tc_sec" ] || [ "$tc_sec" = "$ts_sec" ]; then
    return 0
  fi
  echo "🔑 Aligning token-service TOKEN_SERVICE_SHARED_SECRET with test-call/.env"
  local tmp
  tmp="$(mktemp)"
  awk -v s="$tc_sec" '
    BEGIN { done = 0 }
    /^TOKEN_SERVICE_SHARED_SECRET=/ { print "TOKEN_SERVICE_SHARED_SECRET=" s; done = 1; next }
    { print }
    END { if (!done) print "TOKEN_SERVICE_SHARED_SECRET=" s }
  ' "$ts_env" > "$tmp"
  mv "$tmp" "$ts_env"
}

discover_public_ip() {
  if [ -n "$PUBLIC_IP" ]; then
    echo "$PUBLIC_IP"
    return 0
  fi
  curl -4 -fsS --max-time 2 https://api.ipify.org 2>/dev/null ||
    curl -4 -fsS --max-time 2 https://ifconfig.me 2>/dev/null ||
    true
}

install_redis_if_needed() {
  have redis-server && return 0
  echo "📦 redis-server not found, installing..."
  if [ "$(uname)" = "Darwin" ]; then
    have brew && brew install redis || return 1
  elif have apt-get; then
    apt_install redis-server || return 1
    # Packaged redis binds 127.0.0.1 only; the egress container cannot reach that.
    as_root service redis-server stop >/dev/null 2>&1 || true
  else
    return 1
  fi
}

install_ffmpeg_if_needed() {
  have ffmpeg && return 0
  echo "📦 ffmpeg not found, installing (needed to compress recordings)..."
  if [ "$(uname)" = "Darwin" ]; then
    have brew && brew install ffmpeg || return 1
  elif have apt-get; then
    apt_install ffmpeg || return 1
  else
    return 1
  fi
}

install_livekit_if_needed() {
  have livekit-server && return 0
  echo "📡 livekit-server not found. Installing LiveKit binary..."
  if [ "$(uname)" = "Darwin" ]; then
    have brew && brew install livekit || true
  else
    if curl -sSL https://get.livekit.io | bash; then
      hash -r 2>/dev/null || true
    fi
  fi
  have livekit-server && return 0

  if [ "$(uname)" != "Darwin" ]; then
    local arch lk_arch
    arch="$(uname -m)"
    case "$arch" in
      x86_64) lk_arch="amd64" ;;
      aarch64|arm64) lk_arch="arm64" ;;
      *) lk_arch="amd64" ;;
    esac
    echo "📡 Falling back to GitHub release (linux_${lk_arch})..."
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL "https://github.com/livekit/livekit/releases/download/v1.9.1/livekit_1.9.1_linux_${lk_arch}.tar.gz" | tar -xz -C "$tmp"
    if [ -f "$tmp/livekit-server" ]; then
      if mkdir -p "$HOME/.local/bin" && mv "$tmp/livekit-server" "$HOME/.local/bin/livekit-server"; then
        chmod +x "$HOME/.local/bin/livekit-server"
      elif can_sudo && as_root mv "$tmp/livekit-server" /usr/local/bin/livekit-server; then
        as_root chmod +x /usr/local/bin/livekit-server
      fi
    fi
    rm -rf "$tmp"
    hash -r 2>/dev/null || true
  fi
  have livekit-server
}

# Codespaces / any TLS-terminating reverse proxy already speaks HTTPS to the browser
# (github.dev, Caddy, nginx). Serving a second self-signed cert on :8888 would break that.
# A bare VPS reached as https://<ip>:8888 still needs a cert for getUserMedia.
ensure_certs() {
  local cert="$ROOT/test-call/certs/cert.pem"
  local key="$ROOT/test-call/certs/key.pem"
  if in_codespaces || [ "${SPACE_HTTP:-}" = "1" ]; then
    echo "ℹ️  Codespaces/proxy detected — skipping self-signed TLS (the public URL is already HTTPS)."
    return 0
  fi
  if [ -f "$cert" ] && [ -f "$key" ]; then
    HAS_CERT=1
    return 0
  fi
  if ! have openssl; then
    echo "ℹ️  openssl not found — cannot generate TLS certs; camera/mic on a second machine will only work from http://localhost."
    return 0
  fi
  mkdir -p "$ROOT/test-call/certs"
  local san="DNS:localhost,IP:127.0.0.1"
  local ip
  if have ip; then
    while read -r ip; do
      [ -n "$ip" ] && san="$san,IP:$ip"
    done < <(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
  fi
  if [ "$(uname)" = "Darwin" ]; then
    for iface in en0 en1 en2; do
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      [ -n "$ip" ] && san="$san,IP:$ip"
    done
  fi
  ip="$(discover_public_ip)"
  if [ -n "$ip" ]; then
    PUBLIC_IP="$ip"
    san="$san,IP:$ip"
  fi
  if [ -n "$PUBLIC_HOST" ]; then
    san="$san,DNS:${PUBLIC_HOST}"
  fi
  echo "🔐 Generating self-signed TLS cert ($san)..."
  if openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$key" -out "$cert" -days 30 \
      -subj "/CN=test-call" \
      -addext "subjectAltName=${san}" >/tmp/test-call-cert.log 2>&1; then
    HAS_CERT=1
  else
    echo "⚠️  Failed to generate TLS cert (see /tmp/test-call-cert.log) — falling back to HTTP."
  fi
}

wait_for_docker() {
  have docker || return 1
  local i
  for i in $(seq 1 15); do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# A real VPS needs ICE candidates a phone on the public internet can reach. Codespaces
# github.dev only proxies HTTP — advertising a public ICE IP there makes media worse.
# Local macOS stays on the private LAN IPs in livekit/config.yaml.
write_livekit_runtime_config() {
  LK_CONFIG="${ROOT}/livekit/config.yaml"
  in_codespaces && return 0
  [ "$(uname)" = "Darwin" ] && return 0
  local dest="/tmp/space-livekit.yaml"
  local ip
  ip="$(discover_public_ip)"
  [ -n "$ip" ] && PUBLIC_IP="$ip"
  awk -v node="${PUBLIC_IP}" '
    /^  use_external_ip:/ { print "  use_external_ip: true"; next }
    /^rtc:/ {
      print
      if (node != "") print "  node_ip: \"" node "\""
      next
    }
    /^  node_ip:/ { next }
    { print }
  ' "${ROOT}/livekit/config.yaml" > "$dest"
  LK_CONFIG="$dest"
}

# --- 1. Redis (LiveKit Egress job queue; calling still works without it) ---
install_redis_if_needed || true
if have redis-server; then
  # Don't reuse Debian's 127.0.0.1-only instance; the egress container talks to
  # host.docker.internal:6379, which is not loopback.
  if [ "$(uname)" != "Darwin" ]; then
    as_root service redis-server stop >/dev/null 2>&1 || true
  fi
  if have redis-cli && redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; then
    echo "📦 Redis already running on :6379"
  else
    echo "📦 Starting Redis on :6379..."
    redis-server --port 6379 --bind 0.0.0.0 --protected-mode no \
      --daemonize no --dir /tmp --logfile /tmp/redis.log --save "" &
    REDIS_PID=$!
    STARTED_REDIS=1
    for _ in $(seq 1 10); do
      have redis-cli && redis-cli -h 127.0.0.1 ping >/dev/null 2>&1 && break
      sleep 0.2
    done
  fi
else
  echo "ℹ️  redis-server not found -- audio recording disabled (plain calling still works)."
fi

# --- 2. LiveKit Server ---
# --dev cannot sign egress webhooks (no webhook.api_key), so recordings would start
# but never notify token-service. Use livekit/config.yaml whenever Redis is up.
install_livekit_if_needed || true
write_livekit_runtime_config
REDIS_UP=0
if have redis-cli && redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; then
  REDIS_UP=1
fi
if [ -n "$REDIS_PID" ] || [ "$REDIS_UP" = "1" ]; then
  LK_ARGS=(--config "$LK_CONFIG")
else
  LK_ARGS=(--dev --bind 0.0.0.0)
fi

if have livekit-server; then
  echo "📡 Starting LiveKit Server..."
  livekit-server "${LK_ARGS[@]}" > /tmp/livekit.log 2>&1 &
  LK_PID=$!
else
  echo "❌ livekit-server is not on PATH. Calling will not work. Install it and re-run."
fi

sleep 1

# --- 3. LiveKit Egress worker (Docker) ---
install_ffmpeg_if_needed || true
if ! have docker && [ -S /var/run/docker.sock ] && [ "$(id -u)" -ne 0 ] && can_sudo; then
  docker() { sudo -n docker "$@"; }
fi
if ! have docker; then
  if in_codespaces; then
    echo "ℹ️  Docker not found in this Codespace — rebuild it to pick up docker-in-docker (recording needs it; calling still works)."
  else
    echo "ℹ️  Docker not found -- LiveKit Egress disabled (plain calling still works). On a VPS: curl -fsSL https://get.docker.com | sh"
  fi
elif ! wait_for_docker; then
  echo "ℹ️  Docker daemon not ready -- LiveKit Egress disabled (plain calling still works)."
elif ! have redis-cli || ! redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; then
  echo "ℹ️  Redis is not reachable -- skipping Egress (it needs Redis as a job queue)."
else
  echo "🎙️  Starting LiveKit Egress worker (Docker)..."
  mkdir -p egress/raw egress/compressed
  docker rm -f space-egress >/dev/null 2>&1 || true
  # host.docker.internal + host-gateway works on Docker Desktop, Linux, and
  # Codespaces docker-in-docker. --network host does not (DinD's "host" is not
  # the codespace). Volume is egress:/out so /out/raw/<file> is egress/raw/<file>.
  if docker run -d --name space-egress \
      --add-host=host.docker.internal:host-gateway \
      --cap-add=SYS_ADMIN \
      --shm-size=1g \
      -e EGRESS_CONFIG_FILE=/etc/egress.yaml \
      -v "${ROOT}/egress/config.yaml:/etc/egress.yaml" \
      -v "${ROOT}/egress:/out" \
      livekit/egress:latest > /tmp/egress-container-id.txt 2>/tmp/egress.log; then
    EGRESS_STARTED=1
  else
    echo "⚠️  Could not start LiveKit Egress (see /tmp/egress.log) -- recording disabled."
    tail -n 20 /tmp/egress.log 2>/dev/null || true
  fi
fi

sleep 1

# --- 4. Token Service ---
echo "🔑 Starting Token Service on :8880..."
ensure_npm_env token-service
ensure_npm_env test-call
align_shared_secret
cd token-service
npm run dev > /tmp/token-service.log 2>&1 &
TS_PID=$!
cd "$ROOT"

sleep 1

# --- 5. Compressor ---
echo "🗜️  Starting Compressor on :8890..."
ensure_npm_env compressor
cd compressor
npm run dev > /tmp/compressor.log 2>&1 &
CO_PID=$!
cd "$ROOT"

sleep 1

# --- 6. Web app ---
ensure_certs
echo "💻 Starting Space Meet on :8888..."
cd test-call
# SPACE_HTTP=1 forces the app to ignore leftover certs (Codespaces / TLS terminator).
if in_codespaces; then
  export CODESPACES="${CODESPACES:-true}"
  export SPACE_HTTP=1
fi
node server.js &
TC_PID=$!
cd "$ROOT"

if ! in_codespaces && [ -z "${SPACE_HTTP:-}" ] &&
  [ -f "$ROOT/test-call/certs/cert.pem" ] && [ -f "$ROOT/test-call/certs/key.pem" ]; then
  HAS_CERT=1
fi

echo "✅ All services running!"
if in_codespaces; then
  echo "   - Space Meet:  http://localhost:8888"
  echo "     Open the public https://*.app.github.dev URL from the Ports tab (set 8888 to Public)."
  echo "     HTTP on :8888 is expected — GitHub already terminates HTTPS. There is no certs/ or wss-proxy line."
elif [ "$HAS_CERT" = "1" ]; then
  if [ -n "$PUBLIC_IP" ]; then
    echo "   - Space Meet:  https://${PUBLIC_IP}:8888  (self-signed — browsers will warn once)"
  else
    echo "   - Space Meet:  https://localhost:8888"
  fi
  if [ -n "$PUBLIC_HOST" ]; then
    echo "   - Space Meet:  https://${PUBLIC_HOST}:8888"
  fi
  echo "     Open TCP 8888 + 7881 and UDP 7882 on the VPS firewall so remote cameras can connect."
else
  echo "   - Space Meet:  http://localhost:8888"
fi
echo "   - Token API:   http://localhost:8880"
echo "   - Compressor:  http://127.0.0.1:8890"
echo "   - LiveKit:     http://localhost:7880"
if [ "$EGRESS_STARTED" = "1" ]; then
  echo "   - Egress:      Docker container 'space-egress' (writes to ./egress/raw)"
fi
echo ""
echo "Press Ctrl+C to stop all services."

cleanup() {
  echo ""
  echo "🛑 Stopping all services..."
  [ -n "$LK_PID" ] && kill "$LK_PID" 2>/dev/null || true
  [ -n "$TS_PID" ] && kill "$TS_PID" 2>/dev/null || true
  [ -n "$CO_PID" ] && kill "$CO_PID" 2>/dev/null || true
  [ -n "$TC_PID" ] && kill "$TC_PID" 2>/dev/null || true
  if [ "$STARTED_REDIS" = "1" ] && [ -n "$REDIS_PID" ]; then
    kill "$REDIS_PID" 2>/dev/null || true
  fi
  if [ "$EGRESS_STARTED" = "1" ]; then
    docker rm -f space-egress >/dev/null 2>&1 || true
  fi
  exit 0
}

trap cleanup SIGINT SIGTERM
wait
