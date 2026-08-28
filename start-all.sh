#!/usr/bin/env bash
set -e

echo "🚀 Starting Space Meet services..."

# 1. Start LiveKit Server
if command -v livekit-server >/dev/null 2>&1; then
  echo "📡 Starting LiveKit Server on :7880..."
  livekit-server --dev --bind 0.0.0.0 > /tmp/livekit.log 2>&1 &
  LK_PID=$!
else
  echo "⚠️ livekit-server not found. Installing LiveKit..."
  curl -sSL https://get.livekit.io | bash
  livekit-server --dev --bind 0.0.0.0 > /tmp/livekit.log 2>&1 &
  LK_PID=$!
fi

sleep 1

# 2. Start Token Service
echo "🔑 Starting Token Service on :8880..."
cd token-service
if [ ! -f .env ]; then
  cp .env.example .env
fi
npm run dev > /tmp/token-service.log 2>&1 &
TS_PID=$!
cd ..

sleep 1

# 3. Start Web App
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
echo "   - LiveKit:     http://localhost:7880"
echo ""
echo "Press Ctrl+C to stop all services."

trap "kill $LK_PID $TS_PID $TC_PID 2>/dev/null; exit" SIGINT SIGTERM
wait
