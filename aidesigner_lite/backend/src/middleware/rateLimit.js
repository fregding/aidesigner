const appConfig = require('../config/appConfig');
const jwt = require('jsonwebtoken');

const stores = new Map();

function parseLimitEnv(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function authenticatedUserId(req) {
  if (req.userId) return req.userId;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, appConfig.jwtSecret());
    return decoded?.userId || null;
  } catch (error) {
    return null;
  }
}

function clientKey(req, scope) {
  const userId = authenticatedUserId(req);
  const userPart = userId ? `u:${userId}` : `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  return `${scope}:${userPart}`;
}

function rateLimit({ windowMs = 60_000, max = 60, scope = 'default' } = {}) {
  return (req, res, next) => {
    if (process.env.RATE_LIMIT_ENABLED === 'false') {
      return next();
    }

    const now = Date.now();
    const key = clientKey(req, scope);
    const bucket = stores.get(key) || { count: 0, resetAt: now + windowMs };

    if (bucket.resetAt <= now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    stores.set(key, bucket);

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }

    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of stores.entries()) {
    if (bucket.resetAt <= now) {
      stores.delete(key);
    }
  }
}, 60_000).unref();

module.exports = {
  rateLimit,
  authRateLimit: rateLimit({ windowMs: 15 * 60_000, max: parseLimitEnv('RATE_LIMIT_AUTH_MAX', appConfig.isProduction ? 20 : 200), scope: 'auth' }),
  aiRateLimit: rateLimit({ windowMs: 60_000, max: parseLimitEnv('RATE_LIMIT_AI_MAX', appConfig.isProduction ? 120 : 120), scope: 'ai' }),
  proxyRateLimit: rateLimit({ windowMs: 60_000, max: parseLimitEnv('RATE_LIMIT_PROXY_MAX', appConfig.isProduction ? 90 : 180), scope: 'proxy' }),
  expensiveRateLimit: rateLimit({ windowMs: 60_000, max: parseLimitEnv('RATE_LIMIT_EXPENSIVE_MAX', appConfig.isProduction ? 60 : 90), scope: 'expensive' })
};
