const crypto = require('crypto');
const { db } = require('./database');
const appConfig = require('../config/appConfig');

const DEFAULT_TTL_MINUTES = 10;
const DEFAULT_COOLDOWN_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_HOURLY_LIMIT = 5;

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CODE_TTL_MINUTES = parsePositiveInt(process.env.VERIFICATION_CODE_TTL_MINUTES, DEFAULT_TTL_MINUTES);
const SEND_COOLDOWN_SECONDS = parsePositiveInt(process.env.VERIFICATION_CODE_COOLDOWN_SECONDS, DEFAULT_COOLDOWN_SECONDS);
const MAX_ATTEMPTS = parsePositiveInt(process.env.VERIFICATION_CODE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
const HOURLY_LIMIT = parsePositiveInt(process.env.VERIFICATION_CODE_HOURLY_LIMIT, DEFAULT_HOURLY_LIMIT);

function createHttpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

class VerificationCode {
  static ttlMinutes() {
    return CODE_TTL_MINUTES;
  }

  static normalizeTarget(target, channel = 'email') {
    const value = String(target || '').trim();
    return channel === 'email' ? value.toLowerCase() : value;
  }

  static hashCode({ target, channel, purpose, code }) {
    const secret = process.env.VERIFICATION_CODE_SECRET || appConfig.jwtSecret();
    return crypto
      .createHmac('sha256', secret)
      .update([channel, purpose, target, String(code)].join(':'))
      .digest('hex');
  }

  static compareHash(actual, expected) {
    const actualBuffer = Buffer.from(String(actual || ''), 'hex');
    const expectedBuffer = Buffer.from(String(expected || ''), 'hex');
    if (actualBuffer.length !== expectedBuffer.length || actualBuffer.length === 0) {
      return false;
    }
    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }

  static cleanupExpired() {
    db.prepare(`
      DELETE FROM verification_codes
      WHERE consumed_at IS NOT NULL
         OR strftime('%s', expires_at) <= strftime('%s', 'now', '-1 day')
    `).run();
  }

  static invalidate(id) {
    if (!id) return;
    db.prepare(`
      UPDATE verification_codes
      SET consumed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  }

  static create({ target, channel = 'email', purpose = 'register', requestIp = '' }) {
    const normalizedTarget = this.normalizeTarget(target, channel);
    if (!normalizedTarget) {
      throw createHttpError('请填写接收验证码的账号');
    }

    this.cleanupExpired();

    const recentCode = db.prepare(`
      SELECT id
      FROM verification_codes
      WHERE target = ?
        AND channel = ?
        AND purpose = ?
        AND consumed_at IS NULL
        AND strftime('%s', created_at) >= strftime('%s', 'now', ?)
      ORDER BY id DESC
      LIMIT 1
    `).get(normalizedTarget, channel, purpose, `-${SEND_COOLDOWN_SECONDS} seconds`);

    if (recentCode) {
      throw createHttpError('验证码发送太频繁，请稍后再试', 429);
    }

    const hourlyCount = db.prepare(`
      SELECT COUNT(*) AS total
      FROM verification_codes
      WHERE target = ?
        AND channel = ?
        AND purpose = ?
        AND strftime('%s', created_at) >= strftime('%s', 'now', '-1 hour')
    `).get(normalizedTarget, channel, purpose).total;

    if (hourlyCount >= HOURLY_LIMIT) {
      throw createHttpError('验证码发送次数过多，请稍后再试', 429);
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    const codeHash = this.hashCode({ target: normalizedTarget, channel, purpose, code });

    const tx = db.transaction(() => {
      this.invalidateActive({ target: normalizedTarget, channel, purpose });

      const result = db.prepare(`
        INSERT INTO verification_codes (target, channel, purpose, code_hash, expires_at, request_ip)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(normalizedTarget, channel, purpose, codeHash, expiresAt, requestIp);

      return {
        id: result.lastInsertRowid,
        target: normalizedTarget,
        channel,
        purpose,
        code,
        expiresAt
      };
    });

    return tx();
  }

  static invalidateActive({ target, channel = 'email', purpose = 'register' }) {
    db.prepare(`
      UPDATE verification_codes
      SET consumed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE target = ?
        AND channel = ?
        AND purpose = ?
        AND consumed_at IS NULL
    `).run(target, channel, purpose);
  }

  static verify({ target, channel = 'email', purpose = 'register', code }) {
    const normalizedTarget = this.normalizeTarget(target, channel);
    const normalizedCode = String(code || '').trim();

    if (!/^\d{6}$/.test(normalizedCode)) {
      throw createHttpError('请输入6位邮箱验证码');
    }

    const row = db.prepare(`
      SELECT *
      FROM verification_codes
      WHERE target = ?
        AND channel = ?
        AND purpose = ?
        AND consumed_at IS NULL
        AND strftime('%s', expires_at) > strftime('%s', 'now')
      ORDER BY id DESC
      LIMIT 1
    `).get(normalizedTarget, channel, purpose);

    if (!row) {
      throw createHttpError('验证码已过期，请重新获取');
    }

    if (Number(row.attempts || 0) >= MAX_ATTEMPTS) {
      throw createHttpError('验证码错误次数过多，请重新获取');
    }

    db.prepare(`
      UPDATE verification_codes
      SET attempts = attempts + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(row.id);

    const expectedHash = this.hashCode({
      target: normalizedTarget,
      channel,
      purpose,
      code: normalizedCode
    });

    if (!this.compareHash(row.code_hash, expectedHash)) {
      throw createHttpError('验证码错误，请重新输入');
    }

    db.prepare(`
      UPDATE verification_codes
      SET consumed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(row.id);

    return true;
  }
}

module.exports = VerificationCode;
