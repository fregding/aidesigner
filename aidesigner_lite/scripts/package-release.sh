#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-aidesigner}"
STAMP="$(date +%Y%m%d_%H%M%S)"
RELEASE_NAME="${APP_NAME}_${STAMP}"
DIST_DIR="${ROOT_DIR}/dist"
WORK_DIR="${DIST_DIR}/${RELEASE_NAME}"
ARCHIVE="${DIST_DIR}/${RELEASE_NAME}.tar.gz"

copy_path() {
  local source="$1"
  local target="${WORK_DIR}/${source}"

  if [ ! -e "${ROOT_DIR}/${source}" ]; then
    return
  fi

  mkdir -p "$(dirname "${target}")"
  cp -R "${ROOT_DIR}/${source}" "${target}"
}

remove_if_exists() {
  local target="${WORK_DIR}/$1"
  if [ -e "${target}" ]; then
    rm -rf "${target}"
  fi
}

mkdir -p "${DIST_DIR}"
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}"

FILES=(
  Dockerfile
  docker-compose.yml
  .dockerignore
  .gitignore
  .env.docker.example
  package.json
  package-lock.json
  start.sh
  admin.html
  dashboard.html
  image.html
  index.html
  login.html
  ppt.html
  usage.html
  user.html
  video.html
  workshop.html
)

DIRS=(
  assets
  backend/src
  backend/prompts
  scripts
  docs
  deploy
  external/ppt-master
  external/awesome-gpt-image-2/docs
)

BACKEND_FILES=(
  backend/package.json
  backend/package-lock.json
  backend/.env.example
)

for item in "${FILES[@]}"; do
  copy_path "${item}"
done

for item in "${BACKEND_FILES[@]}"; do
  copy_path "${item}"
done

for item in "${DIRS[@]}"; do
  copy_path "${item}"
done

# Strip development/runtime payloads from copied external repositories.
remove_if_exists "external/ppt-master/.git"
remove_if_exists "external/ppt-master/venv"
remove_if_exists "external/ppt-master/.venv"
remove_if_exists "external/ppt-master/__pycache__"
remove_if_exists "external/ppt-master/projects"
remove_if_exists "external/ppt-master/examples"
remove_if_exists "external/ppt-master/.github"
remove_if_exists "external/awesome-gpt-image-2/.git"
remove_if_exists "external/awesome-gpt-image-2/data"

# Defense in depth: never ship local secrets, databases, generated files, or dependencies.
remove_if_exists ".env"
remove_if_exists ".env.docker"
remove_if_exists "backend/.env"
remove_if_exists "backend/data"
remove_if_exists "backend/uploads"
remove_if_exists "uploads"
remove_if_exists "runtime"
remove_if_exists "node_modules"
remove_if_exists "backend/node_modules"
remove_if_exists ".claude"

find "${WORK_DIR}" \
  \( -name ".DS_Store" \
  -o \( -type f -name ".env" \) \
  -o \( -type f -name ".env.*" ! -name ".env.example" ! -name ".env.docker.example" \) \
  -o -name "*.log" \
  -o -name "*.db" \
  -o -name "*.db-shm" \
  -o -name "*.db-wal" \
  -o -name "*.bak" \
  -o -name "*.corrupted" \) \
  -exec rm -rf {} +

cat > "${WORK_DIR}/SERVER_README.txt" <<EOF
AI Designer Docker release

1. Upload and extract this archive on the server into a stable directory:
   mkdir -p /srv/${APP_NAME}
   tar -xzf ${RELEASE_NAME}.tar.gz --strip-components=1 -C /srv/${APP_NAME}
   cd /srv/${APP_NAME}

2. First deployment:
   ./scripts/deploy-docker.sh https://your-domain.example admin@your-domain.example

   Without a domain, expose Docker directly:
   ./scripts/deploy-docker.sh --direct http://your-server-ip:3000 admin@local

3. Later updates:
   tar -xzf ${RELEASE_NAME}.tar.gz --strip-components=1 -C /srv/${APP_NAME}
   ./scripts/deploy-docker.sh

4. Confirm that the server AI service is running:
   curl -fsS http://127.0.0.1:3000/api/health
   docker compose --env-file .env.docker ps

   The deploy script only prints success after /api/health is reachable.
   For reverse-proxy deployment, .env.docker must keep:
   APP_BIND=127.0.0.1
   TRUST_PROXY=true

   Nginx/Caddy must forward the real client IP. With Nginx:
   proxy_set_header Host \$host;
   proxy_set_header X-Real-IP \$remote_addr;
   proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto \$scheme;

Runtime data is stored on the server under runtime/data and runtime/uploads.
Do not commit or upload .env.docker back to Git.
EOF

tar -czf "${ARCHIVE}" -C "${DIST_DIR}" "${RELEASE_NAME}"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "${ARCHIVE}" > "${ARCHIVE}.sha256"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${ARCHIVE}" > "${ARCHIVE}.sha256"
fi

rm -rf "${WORK_DIR}"

echo "打包完成:"
echo "  ${ARCHIVE}"
if [ -f "${ARCHIVE}.sha256" ]; then
  echo "  ${ARCHIVE}.sha256"
fi
echo ""
echo "上传到服务器后执行:"
echo "  mkdir -p /srv/${APP_NAME}"
echo "  tar -xzf $(basename "${ARCHIVE}") --strip-components=1 -C /srv/${APP_NAME}"
echo "  cd /srv/${APP_NAME}"
echo "  ./scripts/deploy-docker.sh https://你的域名 admin@你的域名"
echo ""
echo "没有域名时执行:"
echo "  ./scripts/deploy-docker.sh --direct http://你的服务器公网IP:3000 admin@local"
echo ""
echo "后续更新时，继续覆盖到同一个目录:"
echo "  tar -xzf $(basename "${ARCHIVE}") --strip-components=1 -C /srv/${APP_NAME}"
echo "  cd /srv/${APP_NAME}"
echo "  ./scripts/deploy-docker.sh"
echo ""
echo "服务启动确认:"
echo "  curl -fsS http://127.0.0.1:3000/api/health"
echo "  docker compose --env-file .env.docker ps"
echo "  # deploy-docker.sh 只有在 /api/health 可访问后才会显示部署完成"
