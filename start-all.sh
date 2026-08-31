#!/usr/bin/env bash
set -e

echo "🚀 Starting Space Meet services..."

REDIS_PID=""
EGRESS_STARTED=0

# 1. Start Redis (LiveKit Egress uses it as its job queue -- required for recording)
if command -v redis-server >/dev/null 2>&1; then
  echo "📦 Starting Redis on :6379..."
  redis-server --daemonize yes --logfile /tmp/redis.log
  REDIS_PID=$(pgrep redis-server | head -n 1 || true)
else
  echo "ℹ️  redis-server not found -- audio recording disabled (plain calling still works)."
fi

# 2. Configure and start LiveKit Server
if [ -n "$REDIS_PID" ]; then
  LK_CMD="livekit-server --config ./livekit/config.yaml"
else
  LK_CMD="livekit-server --dev --bind 0.0.0.0"
fi

if ! command -v livekit-server >/dev/null 2>&1; then
  echo "📡 livekit-server not found. Installing LiveKit binary..."
  if [ "$(uname)" = "Darwin" ]; then
    brew install livekit || true
  else
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64) LK_ARCH="amd64" ;;
      aarch64|arm64) LK_ARCH="arm64" ;;
      *) LK_ARCH="amd64" ;;
    esac
    curl -fsSL "https://github.com/livekit/livekit/releases/download/v1.9.1/livekit_1.9.1_linux_${LK_ARCH}.tar.gz" | (sudo tar -xz -C /usr/local/bin/ 2>/dev/null || tar -xz -C /usr/local/bin/ 2>/dev/null || tar -xz)
  fi
fi

echo "📡 Starting LiveKit Server..."
$LK_CMD > /tmp/livekit.log 2>&1 &
LK_PID=$!

sleep 1

# 3. Start LiveKit Egress worker (Docker) if Docker is available
if command -v docker >/dev/null 2>&1; then
  echo "🎙️  Starting LiveKit Egress worker (Docker)..."
  mkdir -p egress/raw egress/compressed
  docker rm -f space-egress >/dev/null 2>&1 || true
  docker run -d \
    --name space-egress \
    --network host \
    -v "$(pwd)/egress/config.yaml:/config.yaml:ro" \
    -v "$(pwd)/egress/raw:/out/raw" \
    livekit/egress:latest \
    --config /config.yaml >/dev/null 2>&1 && EGRESS_STARTED=1 || {
      echo "⚠️  Could not start LiveKit Egress docker container -- recording disabled."
      EGRESS_STARTED=0
    }
else
  echo "ℹ️  Docker not found -- LiveKit Egress disabled (plain calling still works)."
fi

sleep 1

# 4. Start Token Service
echo "🔑 Starting Token Service on :8880..."
cd token-service
if [ ! -f .env ]; then
  cp .env.example .env
fi
npm run dev > /tmp/token-service.log 2>&1 &
TS_PID=$!
cd ..

sleep 1

# 5. Start Compressor
echo "🗜️  Starting Compressor on :8890..."
cd compressor
if [ ! -f .env ]; then
  cp .env.example .env
fi
npm run dev > /tmp/compressor.log 2>&1 &
CO_PID=$!
cd ..

sleep 1

# 6. Start Web App
echo "💻 Starting Space Meet on :8888..."
cd test-call
if [ ! -f .env ]; then
  cp .env.example .env
fi
node server.js &
TC_PID=$!
cd ..

echo "✅ All services running!"
echo "   - Space Meet:  https://localhost:8888"
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
  kill $LK_PID $TS_PID $CO_PID $TC_PID 2>/dev/null || true
  if [ -n "$REDIS_PID" ]; then kill $REDIS_PID 2>/dev/null || true; fi
  if [ "$EGRESS_STARTED" = "1" ]; then docker rm -f space-egress >/dev/null 2>&1 || true; fi
  exit 0
}

trap cleanup SIGINT SIGTERM
wait
