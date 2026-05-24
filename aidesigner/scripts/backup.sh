#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_FILE="${ROOT_DIR}/runtime/data/aimaster.db"
UPLOAD_DIR="${ROOT_DIR}/runtime/uploads"
BACKUP_DIR="${ROOT_DIR}/runtime/backups"
STAMP="$(date +%Y%m%d_%H%M%S)"

mkdir -p "${BACKUP_DIR}"

if [ -f "${DB_FILE}" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${DB_FILE}" ".backup '${BACKUP_DIR}/aimaster_${STAMP}.db'"
  else
    cp "${DB_FILE}" "${BACKUP_DIR}/aimaster_${STAMP}.db"
  fi
  echo "数据库备份完成: ${BACKUP_DIR}/aimaster_${STAMP}.db"
fi

if [ -d "${UPLOAD_DIR}" ]; then
  tar -czf "${BACKUP_DIR}/uploads_${STAMP}.tar.gz" -C "${UPLOAD_DIR}" .
  echo "上传文件备份完成: ${BACKUP_DIR}/uploads_${STAMP}.tar.gz"
fi
