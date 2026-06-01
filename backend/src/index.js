const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const appConfig = require('./config/appConfig');
const RuntimeConfigService = require('./services/runtimeConfigService');
const { db, initDatabase } = require('./models/database');
const AiTask = require('./models/AiTask');
const AiService = require('./services/aiService');
const AiCallLogService = require('./services/aiCallLogService');
const StorageLimitService = require('./services/storageLimitService');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { authRateLimit, aiRateLimit, proxyRateLimit, expensiveRateLimit } = require('./middleware/rateLimit');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const aiRoutes = require('./routes/ai');
const fileRoutes = require('./routes/files');
// Lite 版禁用支付路由：保留文件但不挂载。

const app = express();
const PORT = appConfig.port;
const BODY_LIMIT = appConfig.bodyLimit;

initDatabase();
const ensureLocalAdmin = require('./scripts/ensureLocalAdmin');
ensureLocalAdmin();

const adminRoutes = require('./routes/admin');
const interruptedTaskCount = AiTask.markInterruptedProcessingTasks();
if (interruptedTaskCount > 0) {
  console.warn(`[Startup] Marked ${interruptedTaskCount} interrupted processing task(s) as failed.`);
}
const interruptedCallLogCount = AiCallLogService.markInterruptedRunningCalls();
if (interruptedCallLogCount > 0) {
  console.warn(`[Startup] Marked ${interruptedCallLogCount} interrupted AI call log(s) as failed.`);
}

if (appConfig.trustProxy) {
  app.set('trust proxy', 1);
}

const allowedOrigins = new Set(appConfig.allowedOrigins);

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch (error) {
    return '';
  }
}

function getConfiguredPublicOrigin() {
  try {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    return normalizeOrigin(runtimeConfig.sitePublicBaseUrl);
  } catch (error) {
    return '';
  }
}

function isCorsOriginAllowed(origin) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;
  if (allowedOrigins.has(normalizedOrigin)) return true;
  if (!appConfig.isProduction && normalizeOrigin(`http://localhost:${PORT}`) === normalizedOrigin) return true;

  const publicOrigin = getConfiguredPublicOrigin();
  return Boolean(publicOrigin && publicOrigin === normalizedOrigin);
}

function setUploadSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; font-src data:");
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use((req, res, next) => cors({
  origin: (origin, originCallback) => {
    if (!origin) {
      originCallback(null, true);
      return;
    }
    if (origin === 'null' && !appConfig.isProduction) {
      originCallback(null, true);
      return;
    }

    if (isCorsOriginAllowed(origin)) {
      originCallback(null, true);
    } else {
      originCallback(new Error('不允许的跨域请求: ' + origin));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
})(req, res, next));

app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

if (appConfig.signedUploadsEnabled) {
  app.use('/uploads', (req, res, next) => {
    const uploadUrl = String(req.originalUrl || '').split('?')[0];
    if (appConfig.verifySignedUploadUrl(uploadUrl, req.query.expires, req.query.token)) {
      next();
      return;
    }
    res.status(403).json({ error: '文件链接无效或已过期' });
  });
  app.use('/uploads', express.static(appConfig.uploadDir, {
    dotfiles: 'deny',
    index: false,
    setHeaders: setUploadSecurityHeaders
  }));
} else if (appConfig.publicUploadsEnabled) {
  app.use('/uploads', express.static(appConfig.uploadDir, {
    dotfiles: 'deny',
    index: false,
    setHeaders: setUploadSecurityHeaders
  }));
}

app.use('/assets', express.static(path.join(appConfig.frontendRoot, 'assets'), {
  dotfiles: 'deny',
  index: false,
  maxAge: appConfig.isProduction ? '1h' : 0
}));

app.get('/favicon.ico', (req, res, next) => {
  const faviconPath = appConfig.assertInsideFrontendRoot(path.join(appConfig.frontendRoot, 'favicon.ico'));
  if (!fs.existsSync(faviconPath)) {
    return next();
  }

  res.type('image/x-icon');
  return res.sendFile(faviconPath);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/public/stats', (req, res) => {
  try {
    const totalUsers = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role != 'admin'").get().count || 0;
    const completedTasks = db.prepare("SELECT COUNT(*) AS count FROM ai_tasks WHERE status = 'completed'").get().count || 0;

    res.json({
      stats: {
        totalUsers,
        completedTasks,
        toolCount: 1
      }
    });
  } catch (error) {
    console.error('获取公开统计错误:', error);
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

app.use(['/api/auth/login', '/api/auth/register', '/api/auth/send-register-code', '/api/admin/login'], authRateLimit);
app.use(['/api/ai/chat/assistant', '/api/ai/assistant/respond', '/api/ai/assistant/respond/jobs', '/api/ai/assistant/respond/stream'], aiRateLimit);
app.use(['/api/ai/reference-image', '/api/ai/image-download', '/api/ai/convert/url'], proxyRateLimit);
app.use([
  '/api/ai/generate/ppt',
  '/api/ai/ppt/import',
  '/api/ai/generate/image',
  '/api/ai/generate/video',
  '/api/ai/convert/document',
  '/api/ai/convert/from-path',
  '/api/ai/generate/ppt-from-doc',
  '/api/files/upload'
], expensiveRateLimit);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/ai/generate/video', (req, res) => {
  res.status(410).json({ error: 'Lite 本地调试版已禁用视频生成功能' });
});
app.use('/api/pay', (req, res) => {
  res.status(410).json({ error: 'Lite 本地调试版已禁用支付和会员功能' });
});
app.use('/api/ai', aiRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/admin', adminRoutes);

function signUploadUrlsInPublicText(value) {
  const content = String(value || '');
  if (!content || !appConfig.signedUploadsEnabled) return content;
  return content.replace(/\/uploads\/[^\s"'<>\\),\]]+/g, match => {
    try {
      return appConfig.signUploadUrl(match, { ttlSeconds: 3600 });
    } catch (error) {
      return match;
    }
  });
}

function publicSiteAnnouncement(announcement = {}) {
  return {
    ...announcement,
    content: signUploadUrlsInPublicText(announcement.content || '')
  };
}

app.get('/api/config', (req, res) => {
  const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
  res.json({
		    site: {
		      name: runtimeConfig.siteName,
	      rechargePackages: runtimeConfig.rechargePackages,
	      announcement: publicSiteAnnouncement(runtimeConfig.siteAnnouncement),
	      payment: {
	        mode: 'disabled',
	        alipayEnabled: false,
	        purchaseCardUrl: ''
	      }
	    },
    features: {
      ppt: false,
      image: true,
      video: false,
      payment: false,
      membership: false
    },
    limits: {
      maxFileSize: appConfig.maxFileSize,
      maxFileSizeFormatted: `${Math.round(appConfig.maxFileSize / 1024 / 1024)}MB`,
      ppt: {
        minPages: runtimeConfig.pptMinPages,
        maxPages: runtimeConfig.pptMaxPages
      }
    },
    pricing: runtimeConfig.pricing
  });
});

const frontendPages = new Set(
  fs.readdirSync(appConfig.frontendRoot)
    .filter(name => /^[a-zA-Z0-9_-]+\.html$/.test(name))
);

function sendFrontendPage(fileName, res, next) {
  if (!frontendPages.has(fileName)) {
    return next();
  }

  const filePath = appConfig.assertInsideFrontendRoot(path.join(appConfig.frontendRoot, fileName));
  if (!fs.existsSync(filePath)) {
    return next();
  }

  return res.sendFile(filePath);
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/assets')) {
    return next();
  }

  const requested = decodeURIComponent(req.path).replace(/^\/+/, '') || 'index';
  if (!requested.includes('/')) {
    const fileName = requested.endsWith('.html') ? requested : `${requested}.html`;
    if (/^[a-zA-Z0-9_-]+\.html$/.test(fileName)) {
      return sendFrontendPage(fileName, res, () => sendFrontendPage('index.html', res, next));
    }
  }

  return sendFrontendPage('index.html', res, next);
});

app.use(notFound);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║     🎨 AI Designer 后端服务已启动                      ║
║                                                       ║
║     地址: http://localhost:${PORT}                        ║
	║     环境: ${appConfig.nodeEnv.padEnd(42)}║
║                                                       ║
║     API 端点:                                          ║
║     - POST /api/auth/register   注册                   ║
║     - POST /api/auth/login      登录                   ║
║     - GET  /api/auth/me         用户信息                ║
║     - POST /api/ai/generate/ppt    生成PPT            ║
║     - POST /api/ai/generate/image  生成图片           ║
║     - POST /api/ai/generate/video  生成视频           ║
║     - POST /api/ai/chat           对话模型             ║
║     - POST /api/ai/chat/assistant 助手对话           ║
║     - GET  /api/files           文件列表                ║
║     - POST /api/files/upload    上传文件               ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);

  setImmediate(() => {
    AiService.backfillImagePreviewsOnStartup().catch(error => {
      console.warn('[Startup] 图片预览补转启动失败:', error.message);
    });
    try {
      StorageLimitService.startDailyCleanupScheduler();
    } catch (error) {
      console.warn('[Startup] 普通用户存储清理调度启动失败:', error.message);
    }
  });
});

module.exports = app;
