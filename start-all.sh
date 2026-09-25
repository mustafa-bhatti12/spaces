#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
export PATH="/usr/local/bin:/usr/bin:${HOME}/.local/bin:$PATH"

echo "🚀 Starting Space Meet services..."

REDIS_PID=""
STARTED_REDIS=0
EGRESS_STARTED=0
LK_PID=""
TS_PID=""
CO_PID=""
DEMO_PID=""
PUBLIC_IP="${SPACE_PUBLIC_IP:-}"
LK_CONFIG=""
EGRESS_CONFIG=""

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

# Read KEY=value from an env file (first match); empty when the file or key is missing.
env_get() {
  grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# Replace KEY=value in an env file, appending it when absent.
env_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

# Keep token-service and the demo app on the same shared secret. Fresh copies of the two
# .env.example files used to disagree, which made every join return 401.
align_shared_secret() {
  local tc_env="$ROOT/demo/.env"
  local ts_env="$ROOT/token-service/.env"
  [ -f "$tc_env" ] && [ -f "$ts_env" ] || return 0
  local tc_sec ts_sec
  tc_sec="$(env_get "$tc_env" TOKEN_SERVICE_SHARED_SECRET)"
  ts_sec="$(env_get "$ts_env" TOKEN_SERVICE_SHARED_SECRET)"
  if [ -z "$tc_sec" ] || [ "$tc_sec" = "$ts_sec" ]; then
    return 0
  fi
  echo "🔑 Aligning token-service TOKEN_SERVICE_SHARED_SECRET with demo/.env"
  env_set "$ts_env" TOKEN_SERVICE_SHARED_SECRET "$tc_sec"
}

# A public host must never run on the credentials committed to this public repo (devkey/secret,
# local-dev-secret-not-for-production): anyone could sign their own LiveKit tokens. Generate real
# ones once, into the gitignored .env files, and keep them across restarts. Local macOS keeps the
# dev defaults so the `lk` CLI examples in AGENTS.md still work there.
ensure_real_credentials() {
  [ "$(uname)" = "Darwin" ] && return 0
  local ts_env="$ROOT/token-service/.env"
  local tc_env="$ROOT/demo/.env"
  if ! have openssl; then
    echo "❌ openssl is required to generate LiveKit credentials on this host. Install it and re-run."
    exit 1
  fi
  local lk_secret tc_secret
  lk_secret="$(env_get "$ts_env" LIVEKIT_API_SECRET)"
  if [ "${#lk_secret}" -lt 32 ]; then
    echo "🔐 Generating a real LiveKit API key/secret into token-service/.env (replacing the public dev pair)"
    env_set "$ts_env" LIVEKIT_API_KEY "API$(openssl rand -hex 6)"
    env_set "$ts_env" LIVEKIT_API_SECRET "$(openssl rand -hex 32)"
  fi
  tc_secret="$(env_get "$tc_env" TOKEN_SERVICE_SHARED_SECRET)"
  if [ -z "$tc_secret" ] || [ "$tc_secret" = "local-dev-secret-not-for-production" ]; then
    echo "🔐 Generating a real TOKEN_SERVICE_SHARED_SECRET into demo/.env"
    env_set "$tc_env" TOKEN_SERVICE_SHARED_SECRET "$(openssl rand -hex 32)"
  fi
  if [ -z "$(env_get "$ts_env" ADMIN_SHARED_SECRET)" ]; then
    echo "🔐 Generating ADMIN_SHARED_SECRET (for the admin app) into token-service/.env"
    env_set "$ts_env" ADMIN_SHARED_SECRET "$(openssl rand -hex 32)"
  fi
  chmod 600 "$ts_env" "$tc_env"
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
    curl -fsSL "https://github.com/livekit/livekit/releases/download/v1.13.7/livekit_1.13.7_linux_${lk_arch}.tar.gz" | tar -xz -C "$tmp"
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

# Runtime copies of livekit/config.yaml and egress/config.yaml with the real key pair from
# token-service/.env substituted in, so the committed files keep only the public dev pair. They
# live in the gitignored .runtime/ (mode 700: other host users can't read them). The egress file is
# 644 because the container's `egress` user reads it through the bind mount, which bypasses the
# directory's mode.
#
# A real VPS also needs ICE candidates a phone on the public internet can reach, so there the
# LiveKit copy also gets use_external_ip + node_ip; local macOS stays on the private LAN IPs.
#
# TURN_DOMAIN (token-service/.env) turns on LiveKit's built-in TURN relay for networks that only
# let HTTPS out. Browsers are told turns:<domain>:443 (LiveKit hardcodes 443); Caddy's layer4
# listener wrapper terminates TLS for that SNI and forwards plain TCP with a PROXY v2 header to
# 127.0.0.1:5349 (see deploy/Caddyfile). Without the header TURN would report Caddy's loopback
# address to the browser, which Firefox rejects. No UDP port: UDP 443 is Caddy's HTTP/3.
write_runtime_configs() {
  local runtime="$ROOT/.runtime"
  mkdir -p "$runtime"
  chmod 700 "$runtime"
  local lk_key lk_secret
  lk_key="$(env_get "$ROOT/token-service/.env" LIVEKIT_API_KEY)"
  lk_secret="$(env_get "$ROOT/token-service/.env" LIVEKIT_API_SECRET)"
  lk_key="${lk_key:-devkey}"
  lk_secret="${lk_secret:-secret}"

  local public_rtc=0 node=""
  if [ "$(uname)" != "Darwin" ]; then
    public_rtc=1
    node="$(discover_public_ip)"
    [ -n "$node" ] && PUBLIC_IP="$node"
  fi

  LK_CONFIG="$runtime/livekit.yaml"
  (umask 077 && awk -v key="$lk_key" -v secret="$lk_secret" -v public_rtc="$public_rtc" -v node="$node" '
    skip && /^  / { next }
    { skip = 0 }
    /^keys:/ { print; print "  " key ": " secret; skip = 1; next }
    /^  api_key:/ { print "  api_key: " key; next }
    public_rtc && /^  use_external_ip:/ { print "  use_external_ip: true"; next }
    public_rtc && /^  node_ip:/ { next }
    /^rtc:/ {
      print
      if (public_rtc && node != "") print "  node_ip: \"" node "\""
      next
    }
    { print }
  ' "$ROOT/livekit/config.yaml" > "$LK_CONFIG")

  local turn_domain lk_version
  turn_domain="$(env_get "$ROOT/token-service/.env" TURN_DOMAIN)"
  if [ -n "$turn_domain" ]; then
    # turn.proxy_protocol first shipped in 1.13.7; older servers refuse the whole config.
    lk_version="$(livekit-server --version 2>/dev/null | awk '{ print $NF }')"
    if [ "$(printf '%s\n' 1.13.7 "$lk_version" | sort -V | head -1)" != 1.13.7 ]; then
      echo "⚠️  TURN_DOMAIN is set but livekit-server $lk_version is older than 1.13.7 -- TURN stays off."
    else
      printf '%s\n' \
        '' \
        'turn:' \
        '  enabled: true' \
        "  domain: $turn_domain" \
        '  tls_port: 5349' \
        '  external_tls: true' \
        '  proxy_protocol: true' >> "$LK_CONFIG"
    fi
  fi

  EGRESS_CONFIG="$runtime/egress.yaml"
  awk -v key="$lk_key" -v secret="$lk_secret" '
    /^api_key:/ { print "api_key: " key; next }
    /^api_secret:/ { print "api_secret: " secret; next }
    { print }
  ' "$ROOT/egress/config.yaml" > "$EGRESS_CONFIG"
  chmod 644 "$EGRESS_CONFIG"
}

# --- 0. Env files + credentials (LiveKit reads the key pair from token-service/.env) ---
ensure_npm_env token-service
# The demo only runs locally (Railway hosts it for the droplet), but its .env is where the consumer
# secret lives for align_shared_secret, so a VPS gets the .env without the npm install.
if [ "$(uname)" = "Darwin" ]; then
  ensure_npm_env demo
elif [ ! -f demo/.env ]; then
  cp demo/.env.example demo/.env
fi
ensure_real_credentials
align_shared_secret

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
# but never notify token-service. Use the runtime copy of livekit/config.yaml whenever Redis is up.
install_livekit_if_needed || true
write_runtime_configs
REDIS_UP=0
if have redis-cli && redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; then
  REDIS_UP=1
fi
LK_ENV=()
if [ -n "$REDIS_PID" ] || [ "$REDIS_UP" = "1" ]; then
  LK_ARGS=(--config "$LK_CONFIG")
else
  LK_ARGS=(--dev --bind 0.0.0.0)
  # --dev defaults to devkey/secret; on a VPS token-service holds generated keys instead. Passed via
  # env (LIVEKIT_KEYS), not --keys, so the secret doesn't show up in `ps`.
  LK_ENV=("LIVEKIT_KEYS=$(env_get token-service/.env LIVEKIT_API_KEY): $(env_get token-service/.env LIVEKIT_API_SECRET)")
fi

if have livekit-server; then
  echo "📡 Starting LiveKit Server..."
  env "${LK_ENV[@]}" livekit-server "${LK_ARGS[@]}" > /tmp/livekit.log 2>&1 &
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
  echo "ℹ️  Docker not found -- LiveKit Egress disabled (plain calling still works). On a VPS: curl -fsSL https://get.docker.com | sh"
elif ! wait_for_docker; then
  echo "ℹ️  Docker daemon not ready -- LiveKit Egress disabled (plain calling still works)."
elif ! have redis-cli || ! redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; then
  echo "ℹ️  Redis is not reachable -- skipping Egress (it needs Redis as a job queue)."
else
  echo "🎙️  Starting LiveKit Egress worker (Docker)..."
  mkdir -p egress/raw egress/compressed
  # The egress image runs as its own non-root user (uid 1001). Docker Desktop ignores bind-mount
  # permissions, but on Linux it gets "Local upload failed: ... permission denied" writing to a
  # root-owned egress/raw — the recording "starts" and then fails when it's finalized.
  chmod 0777 egress/raw
  docker rm -f space-egress >/dev/null 2>&1 || true
  # host.docker.internal + host-gateway works on Docker Desktop and Linux.
  # Volume is egress:/out so /out/raw/<file> is egress/raw/<file>.
  # --restart on-failure: Docker restarts a crashed worker itself; cleanup() still removes it.
  if docker run -d --name space-egress --restart on-failure \
      --add-host=host.docker.internal:host-gateway \
      --cap-add=SYS_ADMIN \
      --shm-size=1g \
      -e EGRESS_CONFIG_FILE=/etc/egress.yaml \
      -v "${EGRESS_CONFIG}:/etc/egress.yaml" \
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

# --- 6. Demo web app (Next.js) ---
# On a VPS the demo is hosted on Railway instead (it reaches token-service through Caddy), so the
# droplet doesn't spend RAM on it. Locally (macOS) it runs here in dev mode.
if [ "$(uname)" != "Darwin" ]; then
  echo "ℹ️  VPS detected -- not starting the demo app (it runs on Railway)."
else
  echo "💻 Starting Space Meet demo on :8888..."
  cd demo
  npx next dev -p 8888 > /tmp/demo.log 2>&1 &
  DEMO_PID=$!
  cd "$ROOT"
fi

echo "✅ All services running!"
if [ -n "$DEMO_PID" ]; then
  echo "   - Space Meet:  http://localhost:8888  (admin: /admin)"
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
  [ -n "$DEMO_PID" ] && kill "$DEMO_PID" 2>/dev/null || true
  if [ "$STARTED_REDIS" = "1" ] && [ -n "$REDIS_PID" ]; then
    kill "$REDIS_PID" 2>/dev/null || true
  fi
  if [ "$EGRESS_STARTED" = "1" ]; then
    docker rm -f space-egress >/dev/null 2>&1 || true
  fi
  exit "${1:-0}"
}

trap cleanup SIGINT SIGTERM

# Supervise instead of a bare `wait` (which only returns once *every* child has exited, leaving a
# half-dead stack): if a core service exits, stop the rest and exit 1, so systemd (spaces.service,
# Restart=on-failure) brings the whole stack back; run by hand, you see which one died.
# `sleep & wait` keeps the Ctrl+C / SIGTERM trap responsive.
while true; do
  for entry in "LiveKit:$LK_PID" "token-service:$TS_PID" "compressor:$CO_PID" "Redis:$REDIS_PID"; do
    pid="${entry#*:}"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "❌ ${entry%%:*} (pid $pid) exited -- stopping the rest."
      cleanup 1
    fi
  done
  sleep 5 &
  wait $! || true
done
