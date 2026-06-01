const crypto = require('crypto');
const appConfig = require('../config/appConfig');

const PREFIX = 'enc:v1:';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey() {
  const secret = process.env.CONFIG_ENCRYPTION_KEY || (!appConfig.isProduction ? appConfig.jwtSecret() : '');
  if (!secret) {
    throw new Error('CONFIG_ENCRYPTION_KEY is required');
  }
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(value) {
  const text = String(value ?? '');
  if (!text || isEncrypted(text)) return text;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

function decrypt(value) {
  const text = String(value ?? '');
  if (!text || !isEncrypted(text)) return text;

  const payload = Buffer.from(text.slice(PREFIX.length), 'base64');
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = {
  PREFIX,
  isEncrypted,
  encrypt,
  decrypt
};
