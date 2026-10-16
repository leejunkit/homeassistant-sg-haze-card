#!/usr/bin/env bash
#
# Boot a throwaway Home Assistant + headless Chromium and verify dist/haze-card.js
# against the live haze.gov.sg API.
#
#   tests/sandbox/run.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFG="$ROOT/tests/sandbox/config"

docker network create hazetest >/dev/null 2>&1 || true
docker rm -f haze-ha >/dev/null 2>&1 || true
rm -rf "$CFG/.storage"
mkdir -p "$CFG/www"
cp "$ROOT/dist/haze-card.js" "$CFG/www/haze-card.js"

echo "starting Home Assistant..."
docker run -d --name haze-ha --network hazetest -p 8123:8123 \
  -v "$CFG":/config ghcr.io/home-assistant/home-assistant:stable >/dev/null

printf 'waiting for Home Assistant to come up'
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8123/api/onboarding 2>/dev/null || true)" = "200" ]; then
    printf ' up\n'
    break
  fi
  printf '.'
  sleep 3
done

echo "running browser verification..."
mkdir -p "$ROOT/tests/sandbox/screenshots"
docker run --rm --network hazetest -e SCREENSHOT_DIR=/out \
  -v "$ROOT":/src:ro -v "$ROOT/tests/sandbox/screenshots":/out \
  -w /app mcr.microsoft.com/playwright:v1.47.0-jammy \
  sh -c "cp -r /src/. /app/ && npm i --silent playwright@1.47.0 && node tests/sandbox/verify.mjs"

echo
echo "Home Assistant warnings/errors:"
docker logs haze-ha 2>&1 | grep -iE "error|warning" | tail -20 || true

echo
echo "sandbox container 'haze-ha' is still running; stop it with: docker rm -f haze-ha"
