#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.docker"
APP_PORT="${APP_PORT:-3000}"
COMPOSE=()

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
  else
    node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
  fi
}

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '=+/' | cut -c1-24
  else
    node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
  fi
}

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
    return
  fi
  if command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
    return
  fi

  {
    echo "Docker Compose 未安装或 Docker 未启动。"
    exit 1
  }
}

compose() {
  "${COMPOSE[@]}" "$@"
}

create_env_if_missing() {
  if [ -f "${ENV_FILE}" ]; then
    return
  fi

  local admin_password
  admin_password="$(random_password)"

  cat > "${ENV_FILE}" <<EOF
APP_BIND=127.0.0.1
APP_PORT=${APP_PORT}
APP_UID=$(id -u)
APP_GID=$(id -g)

NODE_ENV=production
TRUST_PROXY=false
PUBLIC_UPLOADS_ENABLED=true
SIGNED_UPLOADS_ENABLED=false
ALLOWED_ORIGINS=http://localhost:${APP_PORT}
API_BODY_LIMIT=10mb
MAX_FILE_SIZE=52428800
RATE_LIMIT_ENABLED=true

JWT_SECRET=$(random_secret)
CONFIG_ENCRYPTION_KEY=$(random_secret)
ADMIN_EMAIL=admin@localhost
ADMIN_PASSWORD=${admin_password}
JWT_EXPIRES_IN=7d

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="AI Designer <no-reply@localhost>"
EMAIL_DEV_LOG_CODES=true
EMAIL_SEND_INTERVAL_MS=1500
EMAIL_SEND_QUEUE_MAX=100
EMAIL_SEND_QUEUE_TIMEOUT_MS=120000
EMAIL_SMTP_MAX_CONNECTIONS=1
EMAIL_SMTP_MAX_MESSAGES=100
EMAIL_SMTP_RATE_DELTA_MS=1000
EMAIL_SMTP_RATE_LIMIT=1
VERIFICATION_CODE_TTL_MINUTES=10
VERIFICATION_CODE_COOLDOWN_SECONDS=60
VERIFICATION_CODE_HOURLY_LIMIT=5

TIME_BACKWARD_BASE_URL=https://llmapi.pro
TIME_BACKWARD_API_KEY=
CHAT_MODEL=claude-opus-4-7
ASSISTANT_MODEL=claude-opus-4-7

IMAGE_BASE_URL=https://timebackward.com/v1
IMAGE_API_KEY=
IMAGE_ASSISTANT_BASE_URL=https://timebackward.com/v1
IMAGE_ASSISTANT_API_KEY=
IMAGE_ASSISTANT_MODEL=gpt-5.5
IMAGE_MODEL=gpt-image-2
IMAGE_QUALITY=low
IMAGE_OUTPUT_FORMAT=png
IMAGE_TIMEOUT_MS=600000

TAVILY_API_KEY=
TAVILY_BASE_URL=https://api.tavily.com

PPT_GENERATE_IMAGES=true
PPT_MAX_PAGES=15
EOF

  chmod 600 "${ENV_FILE}"
  echo "已生成 .env.docker，本地管理员: admin@localhost / ${admin_password}"
}

wait_for_health() {
  local url="http://localhost:${APP_PORT}/api/health"
  for _ in $(seq 1 40); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "服务启动超时，请执行: docker compose --env-file .env.docker logs -f app"
  return 1
}

cd "${ROOT_DIR}"
detect_compose
mkdir -p runtime/data runtime/uploads
create_env_if_missing

compose --env-file "${ENV_FILE}" up -d --build
wait_for_health

echo "本地 Docker 服务已启动: http://localhost:${APP_PORT}"
echo "查看日志: ${COMPOSE[*]} --env-file .env.docker logs -f app"
