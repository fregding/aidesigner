/* Run from backend folder: node scripts/repairLocalSdTurboConfig.js */
const path = require('path');
const fs = require('fs');

const backendDir = path.resolve(__dirname, '..');
const envPath = path.join(backendDir, '.env.local');
process.env.ENV_FILE = process.env.ENV_FILE || envPath;

const RuntimeConfigService = require('../src/services/runtimeConfigService');

function readEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    out[key] = value;
  }
  return out;
}

const env = readEnvFile(envPath);

const updates = {
  image_base_url: env.IMAGE_BASE_URL || 'http://127.0.0.1:18081/v1',
  image_api_key: env.IMAGE_API_KEY || 'local-dev-key',
  image_model: env.IMAGE_MODEL || 'sd-turbo-openvino',
  image_quality: env.IMAGE_QUALITY || 'standard',
  image_output_format: env.IMAGE_OUTPUT_FORMAT || 'png',
  image_timeout_ms: env.IMAGE_TIMEOUT_MS || '600000',
  image_failover_enabled: env.IMAGE_FAILOVER_ENABLED || 'true',
  image_fallback_base_url: env.IMAGE_FALLBACK_BASE_URL || 'https://image.pollinations.ai',
  image_fallback_api_key: env.IMAGE_FALLBACK_API_KEY || '',
  image_fallback_model: env.IMAGE_FALLBACK_MODEL || 'flux',
  image_assistant_base_url: env.IMAGE_ASSISTANT_BASE_URL || env.TIME_BACKWARD_BASE_URL || 'http://127.0.0.1:18082/v1',
  image_assistant_api_key: env.IMAGE_ASSISTANT_API_KEY || env.TIME_BACKWARD_API_KEY || 'local-dev-key',
  image_assistant_model: env.IMAGE_ASSISTANT_MODEL || env.CHAT_MODEL || 'local-text-mock',
  provider_base_url: env.provider_base_url || env.TIME_BACKWARD_BASE_URL || 'http://127.0.0.1:18082/v1',
  provider_api_key: env.provider_api_key || env.TIME_BACKWARD_API_KEY || 'local-dev-key',
  chat_model: env.CHAT_MODEL || env.chat_model || 'local-text-mock',
  ppt_model: env.PPT_MODEL || env.ppt_model || 'local-text-mock',
  ppt_executor_model: env.PPT_EXECUTOR_MODEL || env.PPT_MODEL || 'local-text-mock',
  ppt_master_root: env.PPT_MASTER_ROOT || '../external/ppt-master',
  ppt_master_python: env.PPT_MASTER_PYTHON || '../external/ppt-master/venv/Scripts/python.exe',
  ppt_generate_images: env.PPT_GENERATE_IMAGES || 'true',
  ppt_image_concurrency: env.PPT_IMAGE_CONCURRENCY || '1',
  ppt_image_variants_per_request: env.PPT_IMAGE_VARIANTS_PER_REQUEST || '1'
};

RuntimeConfigService.updateConfigs(updates);
console.log('[repair-config] Updated admin_config through RuntimeConfigService:');
for (const [key, value] of Object.entries(updates)) {
  const masked = /api_key/i.test(key) && value ? '********' : value;
  console.log(`  ${key}=${masked}`);
}
