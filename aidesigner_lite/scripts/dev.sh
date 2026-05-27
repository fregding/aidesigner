#!/usr/bin/env bash
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_ENV="$BASE/backend/.env.local"

if [[ ! -f "$LOCAL_ENV" ]]; then
  cp "$BASE/backend/.env.local.example" "$LOCAL_ENV"
fi

if [[ ! -x "$BASE/local-image-server/.venv/bin/python" ]]; then
  python3 -m venv "$BASE/local-image-server/.venv"
fi

"$BASE/local-image-server/.venv/bin/python" - <<'PYINNER' >/dev/null 2>&1 || "$BASE/local-image-server/.venv/bin/pip" install -r "$BASE/local-image-server/requirements.txt" python-multipart
import fastapi, uvicorn, multipart
PYINNER

if [[ ! -d "$BASE/backend/node_modules" ]]; then
  (cd "$BASE/backend" && npm install)
fi

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

(
  cd "$BASE/local-image-server"
  export LOCAL_IMAGE_HOST=127.0.0.1 LOCAL_IMAGE_PORT=18080 LOCAL_IMAGE_API_KEY=local-dev-key LOCAL_IMAGE_MODEL_ID=local-mock-image LOCAL_IMAGE_BACKEND=mock-stdlib
  "$BASE/local-image-server/.venv/bin/python" app.py
) &

(
  cd "$BASE/backend"
  export ENV_FILE="$LOCAL_ENV" NODE_ENV=development PORT=3000 FRONTEND_ROOT="$BASE"
  export ENABLE_LOCAL_IMAGE=true IMAGE_PROVIDER=local LOCAL_IMAGE_API_BASE_URL=http://127.0.0.1:18080/v1 LOCAL_IMAGE_API_KEY=local-dev-key LOCAL_IMAGE_MODEL=local-mock-image
  npm run dev
) &

echo "Dashboard: http://localhost:3000/dashboard.html"
echo "Image Gen : http://localhost:3000/image.html"
wait
