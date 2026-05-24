const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, '..');
const DEFAULT_ENV_FILE = path.join(BACKEND_ROOT, '.env');
const ENV_FILE = process.env.ENV_FILE || DEFAULT_ENV_FILE;

require('dotenv').config({ path: ENV_FILE });

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

function envBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveAppPath(value, fallback, baseDir = BACKEND_ROOT) {
  const candidate = value || fallback;
  if (!candidate) return '';
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(baseDir, candidate);
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function assertInsideRoot(root, targetPath, label = 'path') {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside allowed directory`);
  }

  return resolvedTarget;
}

function pathToUploadUrl(filePath) {
  const resolvedFilePath = assertInsideRoot(config.uploadDir, filePath, 'upload path');
  const relative = path.relative(config.uploadDir, resolvedFilePath);
  return `/uploads/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function uploadUrlToPath(uploadUrl) {
  const rawUrl = String(uploadUrl || '').trim();
  const pathname = rawUrl.startsWith('/uploads/')
    ? rawUrl.split('?')[0]
    : rawUrl;
  const withoutPrefix = pathname.replace(/^\/uploads\//, '');
  const relative = withoutPrefix
    .split('/')
    .map(segment => decodeURIComponent(segment))
    .join(path.sep);
  return assertInsideRoot(config.uploadDir, path.join(config.uploadDir, relative), 'upload URL');
}

function uploadTokenSecret() {
  return process.env.UPLOAD_URL_SECRET || config.jwtSecret();
}

function createUploadToken(uploadUrl, expiresAt) {
  return crypto
    .createHmac('sha256', uploadTokenSecret())
    .update(`${uploadUrl}|${expiresAt}`)
    .digest('hex');
}

function signUploadUrl(uploadUrl, { ttlSeconds = 3600 } = {}) {
  const normalizedUrl = String(uploadUrl || '').split('?')[0];
  if (!normalizedUrl.startsWith('/uploads/')) return normalizedUrl;
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, parseInteger(ttlSeconds, 3600));
  const token = createUploadToken(normalizedUrl, expiresAt);
  return `${normalizedUrl}?expires=${expiresAt}&token=${token}`;
}

function verifySignedUploadUrl(uploadUrl, expires, token) {
  const normalizedUrl = String(uploadUrl || '').split('?')[0];
  const expiresAt = parseInteger(expires, 0);
  const provided = String(token || '');
  if (!normalizedUrl.startsWith('/uploads/') || !expiresAt || !provided) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = createUploadToken(normalizedUrl, expiresAt);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin;
  } catch (error) {
    return '';
  }
}

function looksLikeDefaultSecret(name, value) {
  const normalized = String(value || '').trim().toLowerCase();
  const defaults = new Set([
    'your-super-secret-key-change-in-production',
    'your-secret-key',
    'aimaster-local-development-secret',
    'change-me',
    'changeme'
  ]);
  return defaults.has(normalized) || normalized.includes(`your-${name.toLowerCase()}`);
}

function requireStrongSecret(name, minLength = 32) {
  const value = process.env[name];
  if (!value || String(value).length < minLength || looksLikeDefaultSecret(name, value)) {
    throw new Error(`${name} must be set to a unique secret of at least ${minLength} characters in production`);
  }
  return value;
}

function validateProductionEnv() {
  if (!IS_PRODUCTION) return;

  requireStrongSecret('JWT_SECRET', 32);
  requireStrongSecret('CONFIG_ENCRYPTION_KEY', 32);

  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in production');
  }
  if (String(process.env.ADMIN_PASSWORD || '').length < 12 || String(process.env.ADMIN_PASSWORD || '') === 'admin123') {
    throw new Error('ADMIN_PASSWORD must be a non-default password of at least 12 characters in production');
  }

  if (!process.env.ALLOWED_ORIGINS) {
    throw new Error('ALLOWED_ORIGINS must be set in production');
  }
}

const dataDir = resolveAppPath(process.env.DATA_DIR, 'data');
const uploadDir = resolveAppPath(process.env.UPLOAD_DIR, 'uploads');
const dbPath = resolveAppPath(process.env.DB_PATH, path.join(dataDir, 'aimaster.db'));
const frontendRoot = resolveAppPath(process.env.FRONTEND_ROOT, PROJECT_ROOT, PROJECT_ROOT);
const defaultPptMasterRoot = resolveAppPath(
  process.env.PPT_MASTER_ROOT,
  path.join(PROJECT_ROOT, 'external/ppt-master'),
  BACKEND_ROOT
);
const defaultPptMasterPython = resolveAppPath(
  process.env.PPT_MASTER_PYTHON,
  path.join(defaultPptMasterRoot, 'venv/bin/python'),
  BACKEND_ROOT
);

const config = {
  envFile: ENV_FILE,
  nodeEnv: NODE_ENV,
  isProduction: IS_PRODUCTION,
  projectRoot: PROJECT_ROOT,
  backendRoot: BACKEND_ROOT,
  frontendRoot,
  dataDir,
  dbPath,
  uploadDir,
  documentUploadDir: path.join(uploadDir, 'documents'),
  port: parseInteger(process.env.PORT, 3000),
  bodyLimit: process.env.API_BODY_LIMIT || (IS_PRODUCTION ? '10mb' : '30mb'),
  maxFileSize: parseInteger(process.env.MAX_FILE_SIZE, 50 * 1024 * 1024),
  publicUploadsEnabled: envBool(process.env.PUBLIC_UPLOADS_ENABLED, !IS_PRODUCTION),
  signedUploadsEnabled: envBool(process.env.SIGNED_UPLOADS_ENABLED, IS_PRODUCTION),
  trustProxy: envBool(process.env.TRUST_PROXY, IS_PRODUCTION),
  allowedOrigins: parseCsv(process.env.ALLOWED_ORIGINS || 'http://localhost:3000').map(normalizeOrigin).filter(Boolean),
  imageOnlyMode: envBool(process.env.LOCAL_IMAGE_ONLY_MODE, true),
  features: {
    image: envBool(process.env.ENABLE_IMAGE, true),
    ppt: envBool(process.env.ENABLE_PPT, false),
    video: envBool(process.env.ENABLE_VIDEO, false),
    payments: envBool(process.env.ENABLE_PAYMENTS, false),
    assistant: envBool(process.env.ENABLE_ASSISTANT, false)
  },
  localFullCredits: parseInteger(process.env.LOCAL_FULL_CREDITS, 999999999),
  localImageMaxSize: parseInteger(process.env.LOCAL_IMAGE_MAX_SIZE, 512),
  defaultPptMasterRoot,
  defaultPptMasterPython,
  officePreview: {
    autoRenderOnUpload: envBool(process.env.OFFICE_PREVIEW_AUTO_RENDER, true),
    pageLimit: parseInteger(process.env.OFFICE_PREVIEW_PAGE_LIMIT, 24),
    unoserverEnabled: envBool(process.env.UNOSERVER_ENABLED, true),
    unoconvertBin: process.env.UNOCONVERT_BIN || '',
    unopingBin: process.env.UNOPING_BIN || '',
    host: process.env.UNOSERVER_HOST || '127.0.0.1',
    port: parseInteger(process.env.UNOSERVER_PORT, 2003),
    hostLocation: process.env.UNOSERVER_HOST_LOCATION || 'local'
  },
  ensureRuntimeDirs() {
    ensureDir(path.dirname(dbPath));
    ensureDir(uploadDir);
    ensureDir(path.join(uploadDir, 'documents'));
  },
  jwtSecret() {
    if (IS_PRODUCTION) return requireStrongSecret('JWT_SECRET', 32);
    return process.env.JWT_SECRET || 'aimaster-local-development-secret';
  },
  pathToUploadUrl,
  signUploadUrl,
  verifySignedUploadUrl,
  uploadUrlToPath,
  assertInsideUploadDir(filePath) {
    return assertInsideRoot(uploadDir, filePath, 'upload path');
  },
  assertInsideFrontendRoot(filePath) {
    return assertInsideRoot(frontendRoot, filePath, 'frontend path');
  },
  validateProductionEnv
};

module.exports = config;
