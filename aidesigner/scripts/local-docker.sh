#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
echo "[AI Designer Local] docker backend only. 请先在宿主机启动 local-image-server:18080"
docker compose up --build
