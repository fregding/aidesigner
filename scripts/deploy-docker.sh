#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.docker"
DIRECT_PUBLIC=false

if [ "${1:-}" = "--direct" ]; then
  DIRECT_PUBLIC=true
  shift
fi

PUBLIC_ORIGIN="${1:-${PUBLIC_ORIGIN:-}}"
ADMIN_EMAIL_INPUT="${2:-${ADMIN_EMAIL:-}}"
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
    openssl rand -base64 30 | tr -d '=+/' | cut -c1-28
  else
    node -e "console.log(require('crypto').randomBytes(21).toString('base64url'))"
  fi
}

host_from_origin() {
  node -e "console.log(new URL(process.argv[1]).hostname)" "$1"
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

set_env_var() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "${ENV_FILE}"; then
    local escaped_value
    escaped_value="$(printf '%s' "${value}" | sed 's/[\/&]/\\&/g')"
    sed -i.bak "s/^${key}=.*/${key}=${escaped_value}/" "${ENV_FILE}"
    rm -f "${ENV_FILE}.bak"
  else
    printf '\n%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

set_env_default() {
  local key="$1"
  local value="$2"

  if ! grep -q "^${key}=" "${ENV_FILE}"; then
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

create_env_if_missing() {
  if [ -f "${ENV_FILE}" ]; then
    return
  fi

  if [ -z "${PUBLIC_ORIGIN}" ]; then
    echo "首次部署需要提供公网地址，例如:"
    echo "  ./scripts/deploy-docker.sh https://example.com admin@example.com"
    exit 1
  fi

  case "${PUBLIC_ORIGIN}" in
    http://*|https://*) ;;
    *) echo "公网地址必须以 http:// 或 https:// 开头"; exit 1 ;;
  esac

  local host admin_email admin_password
  host="$(host_from_origin "${PUBLIC_ORIGIN}")"
  admin_email="${ADMIN_EMAIL_INPUT:-admin@${host}}"
  admin_password="$(random_password)"

  local app_bind app_port
  app_bind="${APP_BIND:-127.0.0.1}"
  app_port="${APP_PORT:-3000}"
  if [ "${DIRECT_PUBLIC}" = true ]; then
    app_bind="0.0.0.0"
  fi

  cat > "${ENV_FILE}" <<EOF
APP_BIND=${app_bind}
APP_PORT=${app_port}
APP_UID=$(id -u)
APP_GID=$(id -g)

NODE_ENV=production
TRUST_PROXY=true
PUBLIC_UPLOADS_ENABLED=false
SIGNED_UPLOADS_ENABLED=true
ALLOWED_ORIGINS=${PUBLIC_ORIGIN}
API_BODY_LIMIT=10mb
MAX_FILE_SIZE=52428800
RATE_LIMIT_ENABLED=true

JWT_SECRET=$(random_secret)
CONFIG_ENCRYPTION_KEY=$(random_secret)
ADMIN_EMAIL=${admin_email}
ADMIN_PASSWORD=${admin_password}
JWT_EXPIRES_IN=7d

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="AI Designer <no-reply@${host}>"
EMAIL_DEV_LOG_CODES=false
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
  echo "已生成生产 .env.docker"
  echo "首次管理员: ${admin_email} / ${admin_password}"
}

ensure_runtime_env_defaults() {
  if [ "${DIRECT_PUBLIC}" = true ]; then
    set_env_var "APP_BIND" "0.0.0.0"
  else
    set_env_var "APP_BIND" "127.0.0.1"
  fi

  set_env_default "APP_PORT" "3000"
  set_env_var "TRUST_PROXY" "true"
  set_env_default "RATE_LIMIT_ENABLED" "true"
  set_env_default "EMAIL_SEND_INTERVAL_MS" "1500"
  set_env_default "EMAIL_SEND_QUEUE_MAX" "100"
  set_env_default "EMAIL_SEND_QUEUE_TIMEOUT_MS" "120000"
  set_env_default "EMAIL_SMTP_MAX_CONNECTIONS" "1"
  set_env_default "EMAIL_SMTP_MAX_MESSAGES" "100"
  set_env_default "EMAIL_SMTP_RATE_DELTA_MS" "1000"
  set_env_default "EMAIL_SMTP_RATE_LIMIT" "1"
  chmod 600 "${ENV_FILE}"
}

backup_sqlite() {
  if [ ! -f "${ROOT_DIR}/runtime/data/aimaster.db" ]; then
    return
  fi

  mkdir -p "${ROOT_DIR}/runtime/backups"
  local stamp backup_file
  stamp="$(date +%Y%m%d_%H%M%S)"
  backup_file="${ROOT_DIR}/runtime/backups/aimaster_${stamp}.db"

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${ROOT_DIR}/runtime/data/aimaster.db" ".backup '${backup_file}'"
  else
    cp "${ROOT_DIR}/runtime/data/aimaster.db" "${backup_file}"
  fi
  echo "数据库备份: ${backup_file}"
}

wait_for_health() {
  local url="http://127.0.0.1:${APP_PORT:-3000}/api/health"
  for _ in $(seq 1 60); do
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
mkdir -p runtime/data runtime/uploads runtime/backups
create_env_if_missing
ensure_runtime_env_defaults

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

backup_sqlite
compose --env-file "${ENV_FILE}" build --pull app
compose --env-file "${ENV_FILE}" up -d --remove-orphans --force-recreate app
wait_for_health

echo "Docker 部署完成。容器监听: ${APP_BIND:-127.0.0.1}:${APP_PORT:-3000}"
echo "生产环境建议用 Nginx/Caddy 终止 HTTPS 后反代到该地址。"
