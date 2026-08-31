#!/usr/bin/env bash
set -e

echo "🚀 Starting Space Meet services..."

REDIS_PID=""
EGRESS_STARTED=0

# 1. Start Redis (LiveKit Egress uses it as its job queue -- required for recording, not for
#    plain calling, so its absence only degrades recording, not the rest of this script).
if command -v redis-server >/dev/null 2>&1; then
  echo "🧵 Starting Redis on :6379..."
  redis-server --port 6379 --daemonize no --dir /tmp --logfile /tmp/redis.log &
  REDIS_PID=$!
  sleep 1
else
  echo "⚠️  redis-server not found -- recording (LiveKit Egress) needs it. Install it (e.g. \`brew install redis\`) to enable recording; calling itself still works without it."
fi

# 2. Start LiveKit Server. --dev mode can't sign egress webhooks (no webhook.api_key), which
#    silently breaks the compression step: recordings still start, but token-service never hears
#    "recording finished" and files pile up uncompressed in egress/raw/ forever. Use the real
#    config (redis + webhook signing) whenever Redis actually came up in step 1; fall back to
#    --dev only when it didn't, so plain calling still works without Redis/Docker installed.
if [ -n "$REDIS_PID" ]; then
  LK_ARGS="--config livekit/config.yaml"
else
  LK_ARGS="--dev --bind 0.0.0.0"
fi
if command -v livekit-server >/dev/null 2>&1; then
  echo "📡 Starting LiveKit Server on :7880..."
  livekit-server $LK_ARGS > /tmp/livekit.log 2>&1 &
  LK_PID=$!
else
  echo "⚠️ livekit-server not found. Installing LiveKit..."
  curl -sSL https://get.livekit.io | bash
  livekit-server $LK_ARGS > /tmp/livekit.log 2>&1 &
  LK_PID=$!
fi

sleep 1

# 3. Start the LiveKit Egress worker (Docker) -- records room audio to egress/raw/, per
#    egress/config.yaml. Needs Redis (step 1) and Docker; recording just won't work without
#    either, same as calling won't work without livekit-server.
if command -v docker >/dev/null 2>&1; then
  echo "🎙️  Starting LiveKit Egress worker (Docker)..."
  mkdir -p egress/raw egress/compressed
  docker rm -f space-egress > /dev/null 2>&1 || true
  if docker run -d --name space-egress \
    --add-host=host.docker.internal:host-gateway \
    --cap-add=SYS_ADMIN \
    --shm-size=1g \
    -e EGRESS_CONFIG_FILE=/etc/egress.yaml \
    -v "$(pwd)/egress/config.yaml:/etc/egress.yaml" \
    -v "$(pwd)/egress:/out" \
    livekit/egress:latest > /tmp/egress-container-id.txt 2>/tmp/egress.log; then
    EGRESS_STARTED=1
  else
    echo "⚠️  Failed to start the egress worker (see /tmp/egress.log) -- recording will not work, calling still will."
  fi
else
  echo "⚠️  docker not found -- recording (LiveKit Egress) needs it. Install Docker to enable recording; calling itself still works without it."
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

# 5. Start Compressor -- shrinks a finished recording before it's kept long-term (see
#    compressor/). Only ever called by token-service after an egress completes.
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
  kill "$LK_PID" "$TS_PID" "$CO_PID" "$TC_PID" "$REDIS_PID" 2>/dev/null
  docker rm -f space-egress > /dev/null 2>&1 || true
  exit
}
trap cleanup SIGINT SIGTERM
wait
