#!/usr/bin/env bash
# Runs once when a Codespace (or any devcontainer) is created.
set -euo pipefail
cd "$(dirname "$0")/.."

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redis-server ffmpeg openssl
# Packaged redis binds 127.0.0.1; start-all.sh launches one reachable from Docker.
sudo service redis-server stop >/dev/null 2>&1 || true

if ! command -v livekit-server >/dev/null 2>&1; then
  curl -sSL https://get.livekit.io | bash
fi

for d in token-service test-call compressor; do
  (cd "$d" && npm install && ([ -f .env ] || cp .env.example .env))
done
