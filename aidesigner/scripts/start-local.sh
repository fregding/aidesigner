#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
echo "[AI Designer Local] starting local image server on 127.0.0.1:18080 ..."
(
  cd "$ROOT_DIR/local-image-server"
  bash ./start_local_image_server.sh
) &
IMAGE_PID=$!
trap 'kill $IMAGE_PID 2>/dev/null || true' EXIT
echo "[AI Designer Local] starting backend on http://localhost:3000 ..."
cd "$ROOT_DIR/backend"
if [ ! -d node_modules ]; then
  npm install
fi
npm run init-db
npm start
