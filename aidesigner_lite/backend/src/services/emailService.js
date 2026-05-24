const nodemailer = require('nodemailer');
const appConfig = require('../config/appConfig');
const RuntimeConfigService = require('./runtimeConfigService');

let transporter;
let transporterKey = '';
let sendQueueTail = Promise.resolve();
let queuedSendCount = 0;
let lastSendStartedAt = 0;

const DEFAULT_SEND_INTERVAL_MS = 1500;
const DEFAULT_SEND_QUEUE_MAX = 100;
const DEFAULT_SEND_QUEUE_TIMEOUT_MS = 120000;

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePort(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 587;
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getEmailConfig(overrides = null) {
  if (overrides && typeof overrides === 'object') return overrides;
  return RuntimeConfigService.getRuntimeConfig();
}

function isSmtpConfigured(config = getEmailConfig()) {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpPass);
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTransporter(config = getEmailConfig()) {
  if (!isSmtpConfigured(config)) return null;
  const nextKey = [
    config.smtpHost,
    config.smtpPort,
    config.smtpSecure,
    config.smtpUser,
    config.smtpPass
  ].join('|');
  if (transporter && transporterKey === nextKey) return transporter;

  transporterKey = nextKey;
  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: parsePort(config.smtpPort),
    secure: parseBool(config.smtpSecure, parsePort(config.smtpPort) === 465),
    pool: true,
    maxConnections: parsePositiveInt(process.env.EMAIL_SMTP_MAX_CONNECTIONS, 1),
    maxMessages: parsePositiveInt(process.env.EMAIL_SMTP_MAX_MESSAGES, 100),
    rateDelta: parsePositiveInt(process.env.EMAIL_SMTP_RATE_DELTA_MS, 1000),
    rateLimit: parsePositiveInt(process.env.EMAIL_SMTP_RATE_LIMIT, 1),
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass
    }
  });

  return transporter;
}

function resetTransporter() {
  if (transporter && typeof transporter.close === 'function') {
    try {
      transporter.close();
    } catch (error) {
      // Ignore close errors; the next send will create a fresh transporter.
    }
  }
  transporter = null;
  transporterKey = '';
}

function shouldLogCodes(config = getEmailConfig()) {
  return parseBool(config.emailDevLogCodes, !appConfig.isProduction);
}

function isAuthError(error) {
  const message = String(error?.message || error?.response || '').toLowerCase();
  return error?.responseCode === 535
    || error?.code === 'EAUTH'
    || message.includes('535')
    || message.includes('authentication failed')
    || message.includes('invalid login')
    || message.includes('auth failed');
}

function formatEmailError(error) {
  if (!error) return '邮件服务异常，请检查 SMTP 配置后重试';

  if (isAuthError(error)) {
    return 'SMTP 认证失败：请检查发信邮箱账号、SMTP 授权码/应用专用密码、SMTP 服务是否已开启、端口/SSL 是否匹配，并确认发件人邮箱与账号一致。注意这里通常不能填邮箱登录密码。';
  }

  const message = String(error.message || error.response || '');
  const code = String(error.code || '');
  const responseCode = Number(error.responseCode || 0);

  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET' || /timeout|connect/i.test(message)) {
    return 'SMTP 连接失败：请检查 SMTP Host、端口、防火墙/安全组、服务器出口网络，以及 465/587 对应的 SSL 设置。';
  }

  if (responseCode === 550 || responseCode === 553 || /sender|from|mailbox/i.test(message)) {
    return 'SMTP 发件人被拒绝：请确认“发件人”里的邮箱地址与 SMTP 账号一致，或该邮箱服务允许使用这个发件人。';
  }

  if (error.status === 429) {
    return error.publicMessage || error.message || '邮件发送队列繁忙，请稍后再试';
  }

  return `邮件服务异常：${message || code || '未知错误'}`;
}

function normalizeEmailError(error) {
  const normalized = error instanceof Error ? error : new Error(String(error || '邮件服务异常'));
  normalized.publicMessage = normalized.publicMessage || formatEmailError(normalized);

  if (isAuthError(normalized)) {
    resetTransporter();
  }

  return normalized;
}

async function enqueueEmailSend(operation) {
  const queueMax = parsePositiveInt(process.env.EMAIL_SEND_QUEUE_MAX, DEFAULT_SEND_QUEUE_MAX);
  const queueTimeoutMs = parsePositiveInt(process.env.EMAIL_SEND_QUEUE_TIMEOUT_MS, DEFAULT_SEND_QUEUE_TIMEOUT_MS);
  const intervalMs = parsePositiveInt(process.env.EMAIL_SEND_INTERVAL_MS, DEFAULT_SEND_INTERVAL_MS);

  if (queuedSendCount >= queueMax) {
    const error = new Error('邮件发送队列繁忙，请稍后再试');
    error.status = 429;
    error.publicMessage = error.message;
    throw error;
  }

  queuedSendCount += 1;
  const queuedAt = Date.now();

  const run = async () => {
    if (Date.now() - queuedAt > queueTimeoutMs) {
      const error = new Error('邮件发送等待超时，请稍后再试');
      error.status = 429;
      error.publicMessage = error.message;
      throw error;
    }

    const waitMs = Math.max(0, lastSendStartedAt + intervalMs - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    lastSendStartedAt = Date.now();
    return operation();
  };

  const current = sendQueueTail.then(run, run);
  sendQueueTail = current.catch(() => {});

  try {
    return await current;
  } finally {
    queuedSendCount = Math.max(0, queuedSendCount - 1);
  }
}

async function sendMail({ to, subject, text, html, config = null }) {
  const resolvedConfig = getEmailConfig(config);
  if (!isSmtpConfigured(resolvedConfig)) {
    throw new Error('邮件服务未配置，请先在后台配置 SMTP Host、邮箱账号和授权码');
  }

  const from = resolvedConfig.smtpFrom || resolvedConfig.smtpUser || 'AI Designer <no-reply@example.com>';
  try {
    await enqueueEmailSend(() => {
      const mailer = getTransporter(resolvedConfig);
      if (!mailer) {
        throw new Error('邮件服务未配置，请先在后台配置 SMTP Host、邮箱账号和授权码');
      }
      return mailer.sendMail({ from, to, subject, text, html });
    });
    return { devOnly: false };
  } catch (error) {
    throw normalizeEmailError(error);
  }
}

async function verifySmtp(config = null) {
  const resolvedConfig = getEmailConfig(config);
  if (!isSmtpConfigured(resolvedConfig)) {
    throw new Error('邮件服务未配置，请先在后台配置 SMTP Host、邮箱账号和授权码');
  }
  try {
    await enqueueEmailSend(() => {
      const mailer = getTransporter(resolvedConfig);
      if (!mailer) {
        throw new Error('邮件服务未配置，请先在后台配置 SMTP Host、邮箱账号和授权码');
      }
      return mailer.verify();
    });
    return true;
  } catch (error) {
    throw normalizeEmailError(error);
  }
}

async function sendRegisterCode({ email, code, ttlMinutes, config = null }) {
  const resolvedConfig = getEmailConfig(config);
  const siteName = resolvedConfig.siteName || process.env.SITE_NAME || 'AI Designer';
  const safeSiteName = htmlEscape(siteName);
  const safeCode = htmlEscape(code);
  const subject = `你的 ${siteName} 注册验证码`;

  if (!isSmtpConfigured(resolvedConfig)) {
    if (!shouldLogCodes(resolvedConfig)) {
      throw new Error('邮件服务未配置，请先在后台配置 SMTP Host、邮箱账号和授权码');
    }
    console.info(`[Email Dev] ${email} 的注册验证码: ${code}，${ttlMinutes} 分钟内有效`);
    return { devOnly: true };
  }

  return sendMail({
    to: email,
    subject,
    text: `你的 ${siteName} 注册验证码是 ${code}，${ttlMinutes} 分钟内有效。若非本人操作，请忽略此邮件。`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#111827;">
        <h2 style="margin:0 0 12px;">${safeSiteName} 注册验证码</h2>
        <p style="margin:0 0 16px;">你的验证码是：</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;margin:0 0 16px;">${safeCode}</div>
        <p style="margin:0;color:#6b7280;">验证码 ${ttlMinutes} 分钟内有效。若非本人操作，请忽略此邮件。</p>
      </div>
    `,
    config: resolvedConfig
  });
}

async function sendPasswordResetCode({ email, code, ttlMinutes, config = null }) {
  const resolvedConfig = getEmailConfig(config);
  const siteName = resolvedConfig.siteName || process.env.SITE_NAME || 'AI Designer';
  const safeSiteName = htmlEscape(siteName);
  const safeCode = htmlEscape(code);
  const subject = `你的 ${siteName} 重置密码验证码`;

  if (!isSmtpConfigured(resolvedConfig)) {
    if (!shouldLogCodes(resolvedConfig)) {
      throw new Error('邮件服务未配置，请先在后台配置 SMTP Host、邮箱账号和授权码');
    }
    console.info(`[Email Dev] ${email} 的重置密码验证码: ${code}，${ttlMinutes} 分钟内有效`);
    return { devOnly: true };
  }

  return sendMail({
    to: email,
    subject,
    text: `你的 ${siteName} 重置密码验证码是 ${code}，${ttlMinutes} 分钟内有效。若非本人操作，请忽略此邮件。`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#111827;">
        <h2 style="margin:0 0 12px;">${safeSiteName} 重置密码验证码</h2>
        <p style="margin:0 0 16px;">你正在重置账号密码，验证码是：</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;margin:0 0 16px;">${safeCode}</div>
        <p style="margin:0;color:#6b7280;">验证码 ${ttlMinutes} 分钟内有效。若非本人操作，请忽略此邮件，你的密码不会被修改。</p>
      </div>
    `,
    config: resolvedConfig
  });
}

module.exports = {
  isSmtpConfigured,
  formatEmailError,
  verifySmtp,
  sendMail,
  sendRegisterCode,
  sendPasswordResetCode
};
