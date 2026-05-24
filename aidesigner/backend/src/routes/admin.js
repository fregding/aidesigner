const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const User = require('../models/User');
const File = require('../models/File');
const RedemptionCode = require('../models/RedemptionCode');
const { db } = require('../models/database');
const { auth, requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const RuntimeConfigService = require('../services/runtimeConfigService');
const EmailService = require('../services/emailService');
const AiHealthMonitorService = require('../services/aiHealthMonitorService');
const AiRouterService = require('../services/aiRouterService');
const AiCallLogService = require('../services/aiCallLogService');
const ProjectStorageService = require('../services/projectStorageService');
const appConfig = require('../config/appConfig');
const { normalizeUploadOriginalName } = require('../utils/uploadName');

const router = express.Router();
const JWT_SECRET = appConfig.jwtSecret();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let gpuInfoCache = null;
let gpuInfoCacheAt = 0;
let networkSnapshotCache = null;

// 初始化管理员账号（如果不存在）
const initAdmin = () => {
  const adminEmail = process.env.ADMIN_EMAIL || (!appConfig.isProduction ? 'admin@localhost' : '');
  const adminPassword = process.env.ADMIN_PASSWORD || (!appConfig.isProduction ? 'AdminLocal@2026' : '');
  const fullCredits = Math.max(1000000, Number(appConfig.localFullCredits || 999999999));

  if (!adminEmail || !adminPassword) {
    if (!appConfig.isProduction) {
      console.warn('[Admin] ADMIN_EMAIL/ADMIN_PASSWORD 未配置，跳过自动创建管理员账号。');
    }
    return;
  }

  const ensureCredits = (userId) => {
    db.prepare(`
      UPDATE users
      SET role = 'admin',
          quota_ppt = ?, quota_image = ?, quota_video = ?, quota_chat = ?,
          credits_total = ?, credits_used = 0,
          vip_bonus_credits_total = 0, vip_bonus_credits_used = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fullCredits, fullCredits, fullCredits, fullCredits, fullCredits, userId);
  };

  const existing = User.findByEmail(adminEmail);
  if (!existing) {
    bcrypt.hash(adminPassword, 12).then(hash => {
      const result = db.prepare(`
        INSERT INTO users (email, username, password_hash, role, quota_ppt, quota_image, quota_video, quota_chat, credits_total)
        VALUES (?, ?, ?, 'admin', ?, ?, ?, ?, ?)
      `).run(adminEmail, '本地管理员', hash, fullCredits, fullCredits, fullCredits, fullCredits, fullCredits);
      console.log(`[Admin] 已创建本地管理员账号: ${adminEmail}，额度 ${fullCredits}`);
      return result;
    }).catch(error => console.error('[Admin] 初始化本地管理员失败:', error));
    return;
  }

  ensureCredits(existing.id);
  if (String(process.env.LOCAL_RESET_ADMIN_PASSWORD || 'true').toLowerCase() === 'true') {
    bcrypt.hash(adminPassword, 12).then(hash => {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, username = COALESCE(NULLIF(username, ''), '本地管理员'), role = 'admin', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(hash, existing.id);
      console.log(`[Admin] 已同步本地管理员账号/额度: ${adminEmail}`);
    }).catch(error => console.error('[Admin] 同步本地管理员密码失败:', error));
  }
};
initAdmin();

// 生成 Token
const generateToken = (userId, role) => {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

RuntimeConfigService.init();
AiHealthMonitorService.syncScheduler({ runImmediately: true });

// ─── 管理员登录 ───────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '请输入邮箱和密码' });
    }

    const user = User.findByEmail(email);
    if (!user || user.role !== 'admin') {
      return res.status(401).json({ error: '非管理员账号，无权访问后台' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const token = generateToken(user.id, user.role);

    res.json({
      message: '登录成功',
      token,
      admin: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error('管理员登录错误:', error);
    res.status(500).json({ error: '登录失败' });
  }
});

// ─── 获取管理员信息 ───────────────────────────────────────
router.get('/me', auth, requireAdmin, (req, res) => {
  res.json({
    admin: {
      id: req.user.id,
      email: req.user.email,
      username: req.user.username,
      role: req.user.role
    }
  });
});

// ─── 获取仪表盘统计 ───────────────────────────────────────
router.get('/stats', auth, requireAdmin, (req, res) => {
  try {
    User.expireVipMemberships();
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE role != ?').get('admin').count;
    const totalTasks = db.prepare('SELECT COUNT(*) as count FROM ai_tasks').get().count;
    const today = new Date().toISOString().split('T')[0];
    const todayTasks = db.prepare(`
      SELECT COUNT(*) as count FROM ai_tasks WHERE date(created_at) = date(?)
    `).get(today).count;

    const tasksByType = db.prepare(`
      SELECT type, COUNT(*) as count FROM ai_tasks GROUP BY type
    `).all();

    const tasksByStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM ai_tasks GROUP BY status
    `).all();

    const recentTasks = db.prepare(`
      SELECT t.id, t.type, t.status, t.prompt, t.created_at,
             u.username, u.email
      FROM ai_tasks t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
      LIMIT 10
    `).all();

    const quotaUsage = db.prepare(`
      SELECT
        SUM(COALESCE(credits_total, 0) + COALESCE(vip_bonus_credits_total, 0)) as credits_total,
        SUM(COALESCE(credits_used, 0) + COALESCE(vip_bonus_credits_used, 0)) as credits_used,
        SUM(
          MAX(0, COALESCE(credits_total, 0) - COALESCE(credits_used, 0))
          + MAX(0, COALESCE(vip_bonus_credits_total, 0) - COALESCE(vip_bonus_credits_used, 0))
        ) as credits_remaining
      FROM users WHERE role != 'admin'
    `).get();

    res.json({
      stats: {
        totalUsers,
        totalTasks,
        todayTasks,
        tasksByType: Object.fromEntries(tasksByType.map(r => [r.type, r.count])),
        tasksByStatus: Object.fromEntries(tasksByStatus.map(r => [r.status, r.count])),
        quotaUsage,
        recentTasks,
        aiHealth: AiHealthMonitorService.getSnapshot()
      }
    });
  } catch (error) {
    console.error('获取统计错误:', error);
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

router.get('/ai-health', auth, requireAdmin, (req, res) => {
  res.json({ aiHealth: AiHealthMonitorService.getSnapshot() });
});

router.post('/ai-health/check', auth, requireAdmin, async (req, res) => {
  try {
    const snapshot = await AiHealthMonitorService.refreshNow();
    res.json({ aiHealth: snapshot });
  } catch (error) {
    console.error('AI 渠道巡检错误:', error);
    res.status(500).json({ error: 'AI 渠道巡检失败: ' + error.message });
  }
});

router.get('/ai-call-logs', auth, requireAdmin, (req, res) => {
  try {
    const { limit = 80, route = '', status = '', minutes = 1440 } = req.query || {};
    res.json({
      summary: AiCallLogService.summary({ minutes }),
      logs: AiCallLogService.list({ limit, route, status })
    });
  } catch (error) {
    console.error('获取 AI 调用日志错误:', error);
    res.status(500).json({ error: '获取 AI 调用日志失败: ' + error.message });
  }
});

// ─── 获取本机运行状态 ─────────────────────────────────────
router.get('/system-status', auth, requireAdmin, async (req, res) => {
  try {
    const [cpu, disk, gpu, network] = await Promise.all([
      getCpuStatus(),
      getDiskStatus(),
      getGpuStatus(),
      getNetworkStatus()
    ]);

    const totalMemory = safeSystemNumber(() => os.totalmem(), 0);
    const freeMemory = safeSystemNumber(() => os.freemem(), 0);
    const usedMemory = Math.max(0, totalMemory - freeMemory);
    const processMemory = process.memoryUsage();

    res.json({
      system: {
        timestamp: new Date().toISOString(),
        host: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          uptimeSeconds: safeSystemNumber(() => os.uptime(), null)
        },
        process: {
          pid: process.pid,
          nodeVersion: process.version,
          uptimeSeconds: process.uptime(),
          rssBytes: processMemory.rss,
          heapUsedBytes: processMemory.heapUsed,
          heapTotalBytes: processMemory.heapTotal
        },
        cpu,
        memory: {
          totalBytes: totalMemory,
          freeBytes: freeMemory,
          usedBytes: usedMemory,
          usedPercent: totalMemory ? roundPercent((usedMemory / totalMemory) * 100) : null
        },
        disk,
        gpu,
        network
      }
    });
  } catch (error) {
    console.error('获取本机状态错误:', error);
    res.status(500).json({ error: '获取本机状态失败: ' + error.message });
  }
});

// ─── 获取所有配置 ─────────────────────────────────────────
router.get('/config', auth, requireAdmin, (req, res) => {
  try {
    const configs = RuntimeConfigService.getAdminConfigs();
    res.json({ configs });
  } catch (error) {
    console.error('获取配置错误:', error);
    res.status(500).json({ error: '获取配置失败' });
  }
});

// ─── 更新配置 ─────────────────────────────────────────────
router.put('/config', auth, requireAdmin, (req, res) => {
  try {
    const updates = req.body; // { key: value, ... }
    const configs = RuntimeConfigService.updateConfigs(updates);
    AiRouterService.clearRoutingState();
    AiHealthMonitorService.syncScheduler({ runImmediately: false });
    res.json({ message: '配置已更新', configs });
  } catch (error) {
    console.error('更新配置错误:', error);
    res.status(500).json({ error: '更新配置失败: ' + error.message });
  }
});

router.post('/config/test', auth, requireAdmin, async (req, res) => {
  try {
    const { scope, overrides } = req.body || {};

    if (!scope || typeof scope !== 'string') {
      return res.status(400).json({ error: '请指定检测类型' });
    }

    const result = await RuntimeConfigService.testScope(scope, overrides && typeof overrides === 'object' ? overrides : {});
    res.json(result);
  } catch (error) {
    console.error('配置检测错误:', error);
    res.status(500).json({ error: '配置检测失败: ' + RuntimeConfigService.safeProbeErrorMessage(error) });
  }
});

router.post('/config/models', auth, requireAdmin, async (req, res) => {
  try {
    const { providerId, provider, overrides } = req.body || {};
    const result = await RuntimeConfigService.listProviderModels({
      providerId,
      provider: provider && typeof provider === 'object' ? provider : null,
      overrides: overrides && typeof overrides === 'object' ? overrides : {}
    });
    res.json(result);
  } catch (error) {
    console.error('模型列表检测错误:', error);
    res.status(500).json({ error: '模型列表检测失败: ' + RuntimeConfigService.safeProbeErrorMessage(error) });
  }
});

router.post('/config/email/test', auth, requireAdmin, async (req, res) => {
  try {
    const { to, overrides } = req.body || {};
    const target = String(to || req.user?.email || '').trim();

    if (!target || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      return res.status(400).json({ error: '请输入有效的测试收件邮箱' });
    }

    const runtimeConfig = RuntimeConfigService.getRuntimeConfig(overrides && typeof overrides === 'object' ? overrides : {});
    await EmailService.verifySmtp(runtimeConfig);
    await EmailService.sendMail({
      to: target,
      subject: `${runtimeConfig.siteName || 'AI Designer'} 邮件配置测试`,
      text: `这是一封来自 ${runtimeConfig.siteName || 'AI Designer'} 的 SMTP 配置测试邮件。收到这封邮件说明后台邮件配置可用。`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#111827;">
          <h2 style="margin:0 0 12px;">邮件配置测试成功</h2>
          <p style="margin:0;">收到这封邮件说明后台 SMTP 配置已经可用，可以用于发送注册验证码。</p>
        </div>
      `,
      config: runtimeConfig
    });

    res.json({ message: `测试邮件已发送到 ${target}` });
  } catch (error) {
    console.error('邮件配置测试错误:', error);
    res.status(error.status === 429 ? 429 : 500).json({ error: '邮件配置测试失败: ' + EmailService.formatEmailError(error) });
  }
});

// ─── 获取所有用户 ─────────────────────────────────────────
router.get('/users', auth, requireAdmin, (req, res) => {
  try {
    User.expireVipMemberships();
    const { page = 1, limit = 20, search = '', role = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = "WHERE role != 'admin'";
    const params = [];

    if (search) {
      where += ' AND (username LIKE ? OR email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (role) {
      where += ' AND role = ?';
      params.push(role);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM users ${where}`).get(...params).count;
    const users = db.prepare(`
      SELECT id, email, username, role, vip_expires_at,
             invite_code,
             COALESCE((SELECT COUNT(*) FROM user_referrals ur WHERE ur.inviter_id = users.id), 0) as invited_count,
             COALESCE((SELECT COUNT(DISTINCT rr.invitee_id) FROM referral_rewards rr WHERE rr.inviter_id = users.id), 0) as rewarded_invitee_count,
             COALESCE((SELECT COUNT(*) FROM referral_rewards rr WHERE rr.inviter_id = users.id), 0) as referral_reward_count,
             COALESCE((SELECT SUM(rr.reward_amount) FROM referral_rewards rr WHERE rr.inviter_id = users.id), 0) as referral_reward_total,
             COALESCE((SELECT SUM(CASE WHEN rr.is_first = 1 THEN 1 ELSE 0 END) FROM referral_rewards rr WHERE rr.inviter_id = users.id), 0) as referral_first_reward_count,
             COALESCE((SELECT SUM(CASE WHEN rr.is_first = 0 THEN 1 ELSE 0 END) FROM referral_rewards rr WHERE rr.inviter_id = users.id), 0) as referral_repeat_reward_count,
             COALESCE(credits_total, 0) as credits_permanent_total,
             COALESCE(credits_used, 0) as credits_permanent_used,
             MAX(0, COALESCE(credits_total, 0) - COALESCE(credits_used, 0)) as credits_permanent_remaining,
             COALESCE(vip_bonus_credits_total, 0) as vip_bonus_credits_total,
             COALESCE(vip_bonus_credits_used, 0) as vip_bonus_credits_used,
             MAX(0, COALESCE(vip_bonus_credits_total, 0) - COALESCE(vip_bonus_credits_used, 0)) as vip_bonus_credits_remaining,
             COALESCE(credits_total, 0) + COALESCE(vip_bonus_credits_total, 0) as credits_total,
             COALESCE(credits_used, 0) + COALESCE(vip_bonus_credits_used, 0) as credits_used,
             MAX(0, COALESCE(credits_total, 0) - COALESCE(credits_used, 0))
               + MAX(0, COALESCE(vip_bonus_credits_total, 0) - COALESCE(vip_bonus_credits_used, 0)) as credits_remaining,
             created_at
      FROM users ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    console.error('获取用户列表错误:', error);
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

// ─── 更新用户角色 ─────────────────────────────────────────
router.put('/users/:id/role', auth, requireAdmin, (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin', 'vip'].includes(role)) {
      return res.status(400).json({ error: '无效的角色' });
    }
    User.setRole(req.params.id, role);
    res.json({ message: '角色更新成功' });
  } catch (error) {
    res.status(500).json({ error: '更新失败' });
  }
});

// ─── 更新用户额度 ─────────────────────────────────────────
router.put('/users/:id/quota', auth, requireAdmin, (req, res) => {
  try {
    const { quota_ppt, quota_image, quota_video, credits_total, credits } = req.body;
    const fields = [];
    const values = [];
    if (quota_ppt !== undefined) { fields.push('quota_ppt = ?'); values.push(quota_ppt); }
    if (quota_image !== undefined) { fields.push('quota_image = ?'); values.push(quota_image); }
    if (quota_video !== undefined) { fields.push('quota_video = ?'); values.push(quota_video); }
    const nextCredits = credits_total !== undefined ? credits_total : credits;
    if (nextCredits !== undefined) {
      const normalizedCredits = Math.max(0, parseInt(nextCredits, 10) || 0);
      fields.push('credits_total = ?');
      values.push(normalizedCredits);
      fields.push('credits_used = MIN(COALESCE(credits_used, 0), ?)');
      values.push(normalizedCredits);
    }
    if (!fields.length) return res.status(400).json({ error: '没有需要更新的字段' });

    values.push(req.params.id);
    db.prepare(`UPDATE users SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
    res.json({ message: '额度更新成功' });
  } catch (error) {
    res.status(500).json({ error: '更新失败' });
  }
});

// ─── 完整更新用户 ─────────────────────────────────────────
router.put('/users/:id', auth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }

    const existing = User.findById(userId);
    if (!existing) {
      return res.status(404).json({ error: '用户不存在' });
    }
    if (existing.role === 'admin' && existing.id !== req.userId) {
      return res.status(403).json({ error: '不能在这里编辑其他管理员账号' });
    }

    const updates = {};

    if (req.body.username !== undefined) {
      const username = String(req.body.username || '').trim();
      if (username.length < 2 || username.length > 40) {
        return res.status(400).json({ error: '用户名需为 2-40 个字符' });
      }
      updates.username = username;
    }

    if (req.body.email !== undefined) {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: '请输入有效的邮箱地址' });
      }
      const duplicate = User.findByEmail(email);
      if (duplicate && Number(duplicate.id) !== userId) {
        return res.status(400).json({ error: '该邮箱已被其他用户使用' });
      }
      updates.email = email;
    }

    if (req.body.role !== undefined) {
      const role = String(req.body.role || '').trim();
      if (!['user', 'vip'].includes(role)) {
        return res.status(400).json({ error: '角色只能设为普通用户或 VIP' });
      }
      updates.role = role;
      if (role !== 'vip') {
        updates.vip_expires_at = null;
      }
    }

    if (req.body.credits_total !== undefined) {
      const creditsTotal = Math.max(0, parseInt(req.body.credits_total, 10) || 0);
      updates.credits_total = creditsTotal;
      updates.credits_used = Math.min(Number(existing.credits_used || 0), creditsTotal);
    }

    if (req.body.vip_bonus_credits_total !== undefined) {
      const vipBonusTotal = Math.max(0, parseInt(req.body.vip_bonus_credits_total, 10) || 0);
      updates.vip_bonus_credits_total = vipBonusTotal;
      updates.vip_bonus_credits_used = Math.min(Number(existing.vip_bonus_credits_used || 0), vipBonusTotal);
    }

    if (req.body.vip_expires_at !== undefined) {
      const rawExpiresAt = String(req.body.vip_expires_at || '').trim();
      if (rawExpiresAt) {
        const parsed = new Date(rawExpiresAt);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({ error: 'VIP 到期时间格式不正确' });
        }
        updates.vip_expires_at = parsed.toISOString();
      } else {
        updates.vip_expires_at = null;
      }
    }

    if ((updates.role || existing.role) !== 'vip' && updates.vip_expires_at) {
      return res.status(400).json({ error: '只有 VIP 用户可以设置到期时间' });
    }

    const newPassword = String(req.body.password || '').trim();
    if (newPassword) {
      if (newPassword.length < 6 || newPassword.length > 72) {
        return res.status(400).json({ error: '新密码需为 6-72 个字符' });
      }
      updates.password_hash = await bcrypt.hash(newPassword, 12);
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: '没有需要更新的字段' });
    }

    const updated = User.update(userId, updates);
    res.json({
      message: '用户更新成功',
      user: updated
    });
  } catch (error) {
    console.error('更新用户错误:', error);
    res.status(500).json({ error: error.message || '更新用户失败' });
  }
});

// ─── 兑换码管理 ───────────────────────────────────────────
router.get('/redemption-codes', auth, requireAdmin, (req, res) => {
  try {
    res.json(RedemptionCode.list(req.query));
  } catch (error) {
    console.error('获取兑换码错误:', error);
    res.status(500).json({ error: '获取兑换码失败' });
  }
});

router.post('/redemption-codes', auth, requireAdmin, (req, res) => {
  try {
    const codes = RedemptionCode.createBatch({
      rewardType: req.body?.reward_type,
      credits: req.body?.credits,
      vipDays: req.body?.vip_days,
      count: req.body?.count,
      maxUses: req.body?.max_uses,
      expiresAt: req.body?.expires_at,
      note: req.body?.note,
      prefix: req.body?.prefix,
      createdBy: req.userId
    });
    res.status(201).json({ message: '兑换码已生成', codes });
  } catch (error) {
    console.error('生成兑换码错误:', error);
    res.status(400).json({ error: error.message || '生成兑换码失败' });
  }
});

router.patch('/redemption-codes/:id/status', auth, requireAdmin, (req, res) => {
  try {
    const code = RedemptionCode.setStatus(req.params.id, req.body?.status);
    if (!code) return res.status(404).json({ error: '兑换码不存在' });
    res.json({ message: '兑换码状态已更新', code });
  } catch (error) {
    res.status(400).json({ error: error.message || '更新失败' });
  }
});

router.patch('/redemption-codes/status', auth, requireAdmin, (req, res) => {
  try {
    const result = RedemptionCode.setStatuses(req.body?.ids, req.body?.status);
    res.json({ message: '兑换码状态已批量更新', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || '批量更新失败' });
  }
});

// ─── 删除用户 ─────────────────────────────────────────────
router.delete('/users/:id', auth, requireAdmin, (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }

    const user = User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    if (user.role === 'admin') {
      return res.status(403).json({ error: '不能删除管理员账号' });
    }

    const storageCleanup = ProjectStorageService.deleteUserStorage(userId);

    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM referral_rewards WHERE inviter_id = ? OR invitee_id = ?').run(userId, userId);
      db.prepare('DELETE FROM user_referrals WHERE inviter_id = ? OR invitee_id = ?').run(userId, userId);
      db.prepare('UPDATE users SET referred_by_user_id = NULL WHERE referred_by_user_id = ?').run(userId);
      db.prepare('DELETE FROM redemption_redemptions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM payment_orders WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM credit_transactions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM files WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM ai_tasks WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });
    transaction();

    res.json({
      message: '用户已删除',
      removed_files: storageCleanup.cleanup.removed,
      skipped_files: storageCleanup.cleanup.skipped,
      removed_bytes: storageCleanup.cleanup.removed_bytes
    });
  } catch (error) {
    console.error('删除用户错误:', error);
    res.status(500).json({ error: '删除失败: ' + (error.message || '未知错误') });
  }
});

function handleAdminFileUpload(req, res, next) {
  upload.single('file')(req, res, error => {
    if (!error) return next();
    res.status(400).json({ error: error.message || '文件上传失败' });
  });
}

function safeAdminFileRawUrl(file) {
  const storedUrl = String(file?.url || '').split('?')[0].trim();
  if (storedUrl.startsWith('/uploads/')) return storedUrl;
  if (file?.path) {
    try {
      return appConfig.pathToUploadUrl(file.path);
    } catch (error) {
      return storedUrl;
    }
  }
  return storedUrl;
}

function adminFileExists(file) {
  if (!file?.path) return false;
  try {
    return fs.existsSync(appConfig.assertInsideUploadDir(file.path));
  } catch (error) {
    return false;
  }
}

function inferAdminFileType(file) {
  const mimeType = String(file?.mime_type || '').toLowerCase();
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if ([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ].includes(mimeType)) return 'document';
  return 'other';
}

function formatAdminFileSize(bytes) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number < 0) return '—';
  if (number === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = number;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatAdminFile(file) {
  const rawUrl = safeAdminFileRawUrl(file);
  return {
    id: file.id,
    user_id: file.user_id,
    task_id: file.task_id,
    filename: file.filename,
    original_name: file.original_name,
    mime_type: file.mime_type,
    type: inferAdminFileType(file),
    size: file.size,
    size_formatted: formatAdminFileSize(file.size),
    raw_url: rawUrl,
    url: publicAdminResultUrl(rawUrl),
    exists: adminFileExists(file),
    created_at: file.created_at,
    owner: {
      username: file.owner_username || '',
      email: file.owner_email || '',
      role: file.owner_role || ''
    }
  };
}

// ─── 文件管理 ─────────────────────────────────────────────
router.get('/files', auth, requireAdmin, (req, res) => {
  try {
    const { page = 1, limit = 24, type = '', user_id = '', search = '' } = req.query;
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 100);
    const offset = (safePage - 1) * safeLimit;
    const trimmedSearch = String(search || '').trim().slice(0, 120);
    const safeType = ['image', 'video', 'document', 'other'].includes(String(type || '')) ? String(type) : '';
    const safeUserId = String(user_id || '').trim();

    if (safeUserId && (!Number.isFinite(Number(safeUserId)) || Number(safeUserId) <= 0)) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }

    const filters = {
      userId: safeUserId,
      type: safeType,
      search: trimmedSearch
    };
    const files = File.findAll({ ...filters, limit: safeLimit, offset }).map(formatAdminFile);
    const total = File.countAll(filters);
    const totalSize = File.getTotalSizeAll(filters);

    res.json({
      files,
      total,
      page: safePage,
      limit: safeLimit,
      summary: {
        total,
        total_size: totalSize,
        total_size_formatted: formatAdminFileSize(totalSize)
      }
    });
  } catch (error) {
    console.error('获取文件资源错误:', error);
    res.status(500).json({ error: '获取文件资源失败' });
  }
});

router.post('/files/upload', auth, requireAdmin, handleAdminFileUpload, (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    const originalName = normalizeUploadOriginalName(req.file.originalname, req.file.filename || '上传文件');
    const rawUrl = appConfig.pathToUploadUrl(req.file.path);
    const file = File.create({
      userId: req.userId,
      taskId: req.body?.taskId || null,
      filename: req.file.filename,
      originalName,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      url: rawUrl
    });

    res.json({
      message: '文件上传成功',
      file: formatAdminFile({
        ...file,
        owner_username: req.user?.username || '',
        owner_email: req.user?.email || '',
        owner_role: req.user?.role || ''
      })
    });
  } catch (error) {
    console.error('管理员上传文件错误:', error);
    if (req.file?.path) {
      try {
        const safePath = appConfig.assertInsideUploadDir(req.file.path);
        if (fs.existsSync(safePath)) fs.rmSync(safePath, { force: true });
      } catch (cleanupError) {
        console.warn('清理失败上传文件出错:', cleanupError.message);
      }
    }
    res.status(500).json({ error: '文件上传失败' });
  }
});

router.delete('/files/:id', auth, requireAdmin, (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (!Number.isFinite(fileId) || fileId <= 0) {
      return res.status(400).json({ error: '无效的文件 ID' });
    }
    const file = File.findById(fileId);
    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const plan = ProjectStorageService.buildFileCleanupPlan(file);
    const cleanup = ProjectStorageService.removeCleanupPlan(plan);
    File.delete(file.id);

    res.json({
      message: '文件已删除',
      removed_files: cleanup.removed,
      skipped_files: cleanup.skipped,
      removed_bytes: cleanup.removed_bytes
    });
  } catch (error) {
    console.error('管理员删除文件错误:', error);
    res.status(500).json({ error: '删除文件失败: ' + (error.message || '未知错误') });
  }
});

// ─── 删除记录 ─────────────────────────────────────────────
router.delete('/records/:id', auth, requireAdmin, (req, res) => {
  try {
    const recordId = parseInt(req.params.id, 10);
    if (!Number.isFinite(recordId) || recordId <= 0) {
      return res.status(400).json({ error: '无效的记录 ID' });
    }

    const record = db.prepare('SELECT * FROM ai_tasks WHERE id = ?').get(recordId);
    if (!record) {
      return res.status(404).json({ error: '记录不存在' });
    }
    if (record.status === 'processing' || record.status === 'pending') {
      return res.status(409).json({ error: '记录正在生成中，暂时不能删除' });
    }

    const deleted = ProjectStorageService.deleteAdminRecord(recordId);
    if (!deleted) {
      return res.status(404).json({ error: '记录不存在' });
    }

    res.json({
      message: '记录已删除',
      removed_files: deleted.cleanup.removed,
      skipped_files: deleted.cleanup.skipped,
      removed_bytes: deleted.cleanup.removed_bytes
    });
  } catch (error) {
    console.error('删除记录错误:', error);
    res.status(500).json({ error: '删除失败: ' + (error.message || '未知错误') });
  }
});

function safeParseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function normalizeAdminResultUrlList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(item => normalizeAdminResultUrlList(item));
  }
  if (typeof value === 'object') {
    const candidates = [
      value.download_url,
      value.pptx_url,
      value.url,
      value.result_url,
      value.video_url,
      value.videoUrl,
      value.preview_url,
      value.previewUrl,
      value.data_url,
      value.dataUrl
    ].filter(Boolean);
    return candidates.flatMap(item => normalizeAdminResultUrlList(item));
  }
  const text = String(value || '').trim();
  if (!text) return [];
  if (/^[\[{]/.test(text)) {
    const parsed = safeParseJson(text, null);
    const parsedUrls = normalizeAdminResultUrlList(parsed);
    if (parsedUrls.length) return parsedUrls;
  }
  return [text];
}

function uniqueUrls(urls) {
  const seen = new Set();
  return urls.filter(url => {
    const text = String(url || '').trim();
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function publicAdminResultUrl(url) {
  const text = String(url || '').trim();
  if (!text || !appConfig.signedUploadsEnabled || !text.startsWith('/uploads/')) return url;
  return appConfig.signUploadUrl(text, { ttlSeconds: 3600 });
}

function extractAdminRecordResultUrls(record, { includeResultData = false } = {}) {
  const urls = [];
  urls.push(...normalizeAdminResultUrlList(record.result_url));

  if (includeResultData) {
    const resultData = safeParseJson(record.result_data, {}) || {};
    if (Array.isArray(resultData.images)) {
      resultData.images.forEach(image => urls.push(...normalizeAdminResultUrlList(image)));
    }
    urls.push(...normalizeAdminResultUrlList(resultData.download_url || resultData.pptx_url));
    urls.push(...normalizeAdminResultUrlList(resultData.url || resultData.video_url || resultData.videoUrl));
  }

  return uniqueUrls(urls).map(publicAdminResultUrl);
}

function formatAdminRecordListItem(record) {
  const resultUrls = extractAdminRecordResultUrls(record);
  const { result_url: _resultUrl, ...summary } = record;
  return {
    ...summary,
    result_urls: resultUrls,
    result_count: resultUrls.length
  };
}

// ─── 获取所有记录 ─────────────────────────────────────────
router.get('/records', auth, requireAdmin, (req, res) => {
  try {
    const { page = 1, limit = 20, type = '', status = '', user_id = '', search = '' } = req.query;
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (safePage - 1) * safeLimit;

    let where = [];
    const params = [];

    if (type) { where.push('t.type = ?'); params.push(type); }
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (user_id) { where.push('t.user_id = ?'); params.push(user_id); }
    if (search) { where.push('(u.username LIKE ? OR u.email LIKE ? OR t.prompt LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countFrom = search
      ? 'ai_tasks t JOIN users u ON t.user_id = u.id'
      : 'ai_tasks t';
    const total = db.prepare(`SELECT COUNT(*) as count FROM ${countFrom} ${whereStr}`).get(...params).count;

    const records = db.prepare(`
      SELECT t.id, t.type, t.status, t.prompt, t.result_url,
             t.error_message, t.created_at, t.completed_at,
             u.id as user_id, u.username, u.email
      FROM ai_tasks t
      JOIN users u ON t.user_id = u.id
      ${whereStr}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, safeLimit, offset).map(formatAdminRecordListItem);

    res.json({ records, total, page: safePage, limit: safeLimit });
  } catch (error) {
    console.error('获取记录错误:', error);
    res.status(500).json({ error: '获取记录失败' });
  }
});

router.get('/records/:id/result', auth, requireAdmin, (req, res) => {
  try {
    const record = db.prepare(`
      SELECT id, type, status, result_url, result_data
      FROM ai_tasks
      WHERE id = ?
    `).get(req.params.id);

    if (!record) {
      return res.status(404).json({ error: '记录不存在' });
    }

    const urls = extractAdminRecordResultUrls(record, { includeResultData: true });
    res.json({ id: record.id, type: record.type, status: record.status, urls, count: urls.length });
  } catch (error) {
    console.error('获取记录结果错误:', error);
    res.status(500).json({ error: '获取记录结果失败' });
  }
});

function roundPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function safeSystemNumber(getter, fallback = null) {
  try {
    const value = getter();
    return Number.isFinite(value) ? value : fallback;
  } catch (error) {
    return fallback;
  }
}

function bytesFromMib(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1024 * 1024) : null;
}

function execFileText(command, args = [], timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 3 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || '').trim() || `${command} 执行失败`));
          return;
        }
        resolve(stdout || '');
      }
    );
  });
}

function readCpuSnapshot() {
  const cpus = os.cpus();
  return cpus.reduce((snapshot, cpu) => {
    const times = cpu.times || {};
    const idle = times.idle || 0;
    const total = Object.values(times).reduce((sum, value) => sum + (Number(value) || 0), 0);
    snapshot.idle += idle;
    snapshot.total += total;
    return snapshot;
  }, { idle: 0, total: 0 });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCpuStatus() {
  const cpus = os.cpus();
  const first = readCpuSnapshot();
  await delay(120);
  const second = readCpuSnapshot();
  const totalDiff = second.total - first.total;
  const idleDiff = second.idle - first.idle;
  const usagePercent = totalDiff > 0 ? roundPercent((1 - idleDiff / totalDiff) * 100) : null;
  const loadAverage = typeof os.loadavg === 'function'
    ? safeSystemLoadAverage()
    : [0, 0, 0];
  const coreCount = cpus.length || os.availableParallelism?.() || 1;

  return {
    usagePercent,
    loadAverage,
    loadPercent: coreCount ? roundPercent((loadAverage[0] / coreCount) * 100) : null,
    coreCount,
    model: cpus[0]?.model || '',
    speedMhz: cpus[0]?.speed || null
  };
}

function safeSystemLoadAverage() {
  try {
    const value = os.loadavg();
    return Array.isArray(value) ? value : [0, 0, 0];
  } catch (error) {
    return [0, 0, 0];
  }
}

async function getDiskStatus() {
  try {
    const stdout = await execFileText('df', ['-k', '/'], 3000);
    const line = stdout.trim().split(/\r?\n/).filter(Boolean)[1];
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    const freeKb = Number(parts[3]);
    const capacity = String(parts[4] || '').replace('%', '');

    return {
      mount: parts.slice(8).join(' ') || parts[5] || '/',
      totalBytes: Number.isFinite(totalKb) ? totalKb * 1024 : null,
      usedBytes: Number.isFinite(usedKb) ? usedKb * 1024 : null,
      freeBytes: Number.isFinite(freeKb) ? freeKb * 1024 : null,
      usedPercent: Number.isFinite(Number(capacity)) ? Number(capacity) : null
    };
  } catch (error) {
    return {
      error: error.message || '磁盘状态不可用'
    };
  }
}

async function getNetworkStatus() {
  const interfaces = getNetworkInterfaces();
  try {
    const firstSnapshot = await getNetworkCounters();
    let currentSnapshot = firstSnapshot;
    let previousSnapshot = networkSnapshotCache;

    if (!previousSnapshot && firstSnapshot) {
      await delay(180);
      currentSnapshot = await getNetworkCounters();
      previousSnapshot = {
        at: firstSnapshot.at,
        counters: firstSnapshot.counters
      };
    }

    const rates = calculateNetworkRates(previousSnapshot, currentSnapshot);
    networkSnapshotCache = currentSnapshot;
    const primary = selectPrimaryNetworkInterface(interfaces, currentSnapshot?.counters);

    return {
      available: true,
      interfaces,
      primary,
      rxBytes: currentSnapshot?.counters?.totalRxBytes ?? null,
      txBytes: currentSnapshot?.counters?.totalTxBytes ?? null,
      rxRateBytesPerSec: rates.rxRateBytesPerSec,
      txRateBytesPerSec: rates.txRateBytesPerSec,
      note: currentSnapshot?.source || '系统网卡统计'
    };
  } catch (error) {
    return {
      available: interfaces.length > 0,
      interfaces,
      primary: selectPrimaryNetworkInterface(interfaces, null),
      rxBytes: null,
      txBytes: null,
      rxRateBytesPerSec: null,
      txRateBytesPerSec: null,
      note: error.message || '网络状态不可用'
    };
  }
}

function getNetworkInterfaces() {
  const raw = os.networkInterfaces();
  return Object.entries(raw).map(([name, entries]) => {
    const addresses = (entries || [])
      .filter(item => item && !item.internal && item.address)
      .map(item => ({
        address: item.address,
        family: item.family,
        mac: item.mac || ''
      }));

    return {
      name,
      addresses,
      ipv4: addresses.find(item => item.family === 'IPv4')?.address || '',
      ipv6: addresses.find(item => item.family === 'IPv6')?.address || '',
      mac: addresses.find(item => item.mac)?.mac || ''
    };
  }).filter(item => item.addresses.length > 0);
}

async function getNetworkCounters() {
  if (process.platform === 'linux' && fs.existsSync('/proc/net/dev')) {
    return {
      at: Date.now(),
      source: '/proc/net/dev',
      counters: parseProcNetDev(fs.readFileSync('/proc/net/dev', 'utf8'))
    };
  }

  const stdout = await execFileText('netstat', ['-ibn'], 3000);
  return {
    at: Date.now(),
    source: 'netstat -ibn',
    counters: parseNetstatInterfaceBytes(stdout)
  };
}

function parseProcNetDev(text) {
  const interfaces = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    if (!line.includes(':')) return;
    const [namePart, dataPart] = line.split(':');
    const name = namePart.trim();
    if (!name || name === 'lo') return;
    const values = dataPart.trim().split(/\s+/).map(Number);
    const rxBytes = values[0];
    const txBytes = values[8];
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) return;
    interfaces.push({ name, rxBytes, txBytes });
  });
  return buildNetworkCounterSummary(interfaces);
}

function parseNetstatInterfaceBytes(text) {
  const rows = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) throw new Error('未读取到网络接口统计');
  const header = rows[0].trim().split(/\s+/);
  const nameIndex = header.findIndex(item => /^name$/i.test(item));
  const rxIndex = header.findIndex(item => /^ibytes$/i.test(item));
  const txIndex = header.findIndex(item => /^obytes$/i.test(item));
  if (nameIndex < 0 || rxIndex < 0 || txIndex < 0) {
    throw new Error('网络接口统计格式无法识别');
  }

  const byName = new Map();
  rows.slice(1).forEach(line => {
    const values = line.trim().split(/\s+/);
    const name = values[nameIndex];
    if (!name || /^lo/i.test(name)) return;
    const rxBytes = Number(values[rxIndex]);
    const txBytes = Number(values[txIndex]);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) return;
    const previous = byName.get(name) || { name, rxBytes: 0, txBytes: 0 };
    previous.rxBytes = Math.max(previous.rxBytes, rxBytes);
    previous.txBytes = Math.max(previous.txBytes, txBytes);
    byName.set(name, previous);
  });

  return buildNetworkCounterSummary(Array.from(byName.values()));
}

function buildNetworkCounterSummary(interfaces) {
  const totalRxBytes = interfaces.reduce((sum, item) => sum + item.rxBytes, 0);
  const totalTxBytes = interfaces.reduce((sum, item) => sum + item.txBytes, 0);
  return {
    interfaces,
    totalRxBytes,
    totalTxBytes
  };
}

function calculateNetworkRates(previousSnapshot, currentSnapshot) {
  if (!previousSnapshot || !currentSnapshot || !previousSnapshot.counters || !currentSnapshot.counters) {
    return { rxRateBytesPerSec: null, txRateBytesPerSec: null };
  }

  const elapsedSeconds = (currentSnapshot.at - previousSnapshot.at) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return { rxRateBytesPerSec: null, txRateBytesPerSec: null };
  }

  return {
    rxRateBytesPerSec: Math.max(0, Math.round((currentSnapshot.counters.totalRxBytes - previousSnapshot.counters.totalRxBytes) / elapsedSeconds)),
    txRateBytesPerSec: Math.max(0, Math.round((currentSnapshot.counters.totalTxBytes - previousSnapshot.counters.totalTxBytes) / elapsedSeconds))
  };
}

function selectPrimaryNetworkInterface(interfaces, counters) {
  if (!interfaces.length) return null;
  const counterMap = new Map((counters?.interfaces || []).map(item => [item.name, item]));
  const scored = interfaces.map(item => {
    const counter = counterMap.get(item.name);
    const traffic = counter ? counter.rxBytes + counter.txBytes : 0;
    const score = traffic + (item.ipv4 ? 1000 : 0);
    return {
      ...item,
      rxBytes: counter?.rxBytes ?? null,
      txBytes: counter?.txBytes ?? null,
      score
    };
  });
  scored.sort((a, b) => b.score - a.score);
  const primary = scored[0];
  return {
    name: primary.name,
    address: primary.ipv4 || primary.ipv6 || '',
    family: primary.ipv4 ? 'IPv4' : (primary.ipv6 ? 'IPv6' : ''),
    mac: primary.mac || '',
    rxBytes: primary.rxBytes,
    txBytes: primary.txBytes
  };
}

async function getGpuStatus() {
  const now = Date.now();
  if (gpuInfoCache && now - gpuInfoCacheAt < 60000) {
    return gpuInfoCache;
  }

  let info;
  if (process.platform === 'darwin') {
    info = await getMacGpuStatus();
  } else if (process.platform === 'linux') {
    info = await getLinuxGpuStatus();
  } else if (process.platform === 'win32') {
    info = await getWindowsGpuStatus();
  } else {
    info = {
      available: false,
      devices: [],
      utilizationPercent: null,
      note: '当前系统暂不支持 GPU 状态探测'
    };
  }

  gpuInfoCache = info;
  gpuInfoCacheAt = now;
  return info;
}

async function getMacGpuStatus() {
  try {
    const stdout = await execFileText('system_profiler', ['SPDisplaysDataType', '-json'], 8000);
    const parsed = JSON.parse(stdout || '{}');
    const devices = (parsed.SPDisplaysDataType || []).map(item => {
      const displays = Array.isArray(item.spdisplays_ndrvs)
        ? item.spdisplays_ndrvs.map(display => display._name || display.spdisplays_display_type || '').filter(Boolean)
        : [];
      return {
        name: item.sppci_model || item._name || item.spdisplays_chipset || '图形设备',
        vendor: item.spdisplays_vendor || item.sppci_vendor || '',
        vram: item.spdisplays_vram || item.spdisplays_vram_shared || '',
        metal: item.spdisplays_metal || '',
        displays
      };
    });

    return {
      available: devices.length > 0,
      devices,
      utilizationPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      note: devices.length
        ? 'macOS 可读取 GPU 设备信息；实时 GPU 占用通常需要系统权限，当前不采集'
        : '未读取到 GPU 设备信息'
    };
  } catch (error) {
    return {
      available: false,
      devices: [],
      utilizationPercent: null,
      note: error.message || 'GPU 状态不可用'
    };
  }
}

async function getLinuxGpuStatus() {
  try {
    const stdout = await execFileText('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu',
      '--format=csv,noheader,nounits'
    ], 4000);
    const devices = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [name, utilization, totalMemory, usedMemory, temperature] = line.split(',').map(part => part.trim());
      return {
        name,
        utilizationPercent: Number(utilization),
        memoryTotalBytes: bytesFromMib(totalMemory),
        memoryUsedBytes: bytesFromMib(usedMemory),
        temperatureC: Number(temperature)
      };
    });
    const first = devices[0] || {};
    return {
      available: devices.length > 0,
      devices,
      utilizationPercent: Number.isFinite(first.utilizationPercent) ? first.utilizationPercent : null,
      memoryUsedBytes: first.memoryUsedBytes || null,
      memoryTotalBytes: first.memoryTotalBytes || null,
      note: devices.length ? '通过 nvidia-smi 读取' : '未读取到 NVIDIA GPU'
    };
  } catch (error) {
    return getLinuxGpuDeviceFallback(error);
  }
}

async function getLinuxGpuDeviceFallback(sourceError) {
  try {
    const stdout = await execFileText('lspci', [], 3000);
    const devices = stdout
      .trim()
      .split(/\r?\n/)
      .filter(line => /(vga compatible controller|3d controller|display controller)/i.test(line))
      .map(line => ({
        name: line.replace(/^[0-9a-f:.]+\s+/i, '').trim()
      }));

    return {
      available: devices.length > 0,
      devices,
      utilizationPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      note: devices.length
        ? '未检测到 nvidia-smi，已通过 lspci 读取 GPU 设备；实时占用需安装对应厂商监控工具'
        : (sourceError?.message || 'GPU 状态不可用')
    };
  } catch (fallbackError) {
    return {
      available: false,
      devices: [],
      utilizationPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      note: sourceError?.message || fallbackError.message || 'GPU 状态不可用'
    };
  }
}

async function getWindowsGpuStatus() {
  try {
    const stdout = await execFileText('wmic', ['path', 'win32_VideoController', 'get', 'name,adapterram', '/format:csv'], 5000);
    const devices = stdout.trim().split(/\r?\n/).slice(1).map(line => {
      const parts = line.split(',').map(part => part.trim()).filter(Boolean);
      const adapterRam = Number(parts[1]);
      return {
        name: parts[2] || parts[1] || '图形设备',
        memoryTotalBytes: Number.isFinite(adapterRam) ? adapterRam : null
      };
    }).filter(item => item.name);
    return {
      available: devices.length > 0,
      devices,
      utilizationPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: devices[0]?.memoryTotalBytes || null,
      note: devices.length ? 'Windows 可读取 GPU 设备信息；实时占用暂未采集' : '未读取到 GPU 设备信息'
    };
  } catch (error) {
    return {
      available: false,
      devices: [],
      utilizationPercent: null,
      note: error.message || 'GPU 状态不可用'
    };
  }
}

module.exports = router;
