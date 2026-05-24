const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RedemptionCode = require('../models/RedemptionCode');
const VerificationCode = require('../models/VerificationCode');
const StorageLimitService = require('../services/storageLimitService');
const EmailService = require('../services/emailService');
const RuntimeConfigService = require('../services/runtimeConfigService');
const { auth } = require('../middleware/auth');
const appConfig = require('../config/appConfig');

const router = express.Router();
const JWT_SECRET = appConfig.jwtSecret();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

const getPublicBaseUrl = (req) => {
  const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
  const configuredUrl = RuntimeConfigService.normalizeBaseUrl(runtimeConfig.sitePublicBaseUrl || '', '');
  if (configuredUrl) return configuredUrl;
  if (appConfig.isProduction) return '';

  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || req.get('host') || '';
  return host ? `${proto}://${host}` : '';
};

const buildInviteLink = (req, inviteCode) => {
  const code = User.normalizeInviteCode(inviteCode);
  const baseUrl = getPublicBaseUrl(req);
  if (!code) return '';
  if (!baseUrl) return `login.html?tab=register&invite=${encodeURIComponent(code)}`;
  return `${baseUrl}/login.html?tab=register&invite=${encodeURIComponent(code)}`;
};

router.post('/send-register-code', async (req, res) => {
  let verification = null;
  try {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const email = VerificationCode.normalizeTarget(req.body?.email, 'email');

    if (!runtimeConfig.emailVerificationEnabled) {
      return res.status(400).json({ error: '邮箱验证码未启用，请联系管理员' });
    }

    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }

    if (User.findByEmail(email)) {
      return res.status(400).json({ error: '该邮箱已被注册' });
    }

    verification = VerificationCode.create({
      target: email,
      channel: 'email',
      purpose: 'register',
      requestIp: req.ip || req.socket?.remoteAddress || ''
    });

    const sendResult = await EmailService.sendRegisterCode({
      email,
      code: verification.code,
      ttlMinutes: VerificationCode.ttlMinutes(),
      config: runtimeConfig
    });

    res.json({
      message: sendResult.devOnly
        ? '验证码已生成，请查看后端控制台日志'
        : '验证码已发送，请查看邮箱',
      expires_at: verification.expiresAt,
      dev: Boolean(sendResult.devOnly)
    });
  } catch (error) {
    if (verification?.id) {
      VerificationCode.invalidate(verification.id);
    }
    console.error('发送注册验证码错误:', EmailService.formatEmailError(error), error);
    const isQueueLimit = error.status === 429;
    res.status(isQueueLimit ? 429 : 500).json({
      error: error.publicMessage || (isQueueLimit ? error.message : '验证码发送失败，请稍后重试')
    });
  }
});

router.post('/register', async (req, res) => {
  try {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const email = VerificationCode.normalizeTarget(req.body?.email, 'email');
    const { username, password, verificationCode } = req.body;
    const inviteCode = User.normalizeInviteCode(
      req.body?.inviteCode || req.body?.referralCode || req.body?.ref || ''
    );

    if (!email || !username || !password || (runtimeConfig.emailVerificationEnabled && !verificationCode)) {
      return res.status(400).json({ error: '请填写所有必填字段' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少6位' });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }

    const existingUser = User.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: '该邮箱已被注册' });
    }

    const inviter = inviteCode ? User.findByInviteCode(inviteCode) : null;
    if (inviteCode && !inviter) {
      return res.status(400).json({ error: '邀请码无效，请确认后再注册' });
    }

    if (runtimeConfig.emailVerificationEnabled) {
      VerificationCode.verify({
        target: email,
        channel: 'email',
        purpose: 'register',
        code: verificationCode
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let user = User.create({ email, username, passwordHash });

    if (inviter && inviter.id !== user.id) {
      User.registerReferral({
        inviterId: inviter.id,
        inviteeId: user.id,
        inviteCode: inviter.invite_code
      });
      user = User.activateVip(user.id, 1) || user;
    }

    const token = generateToken(user.id);

    res.status(201).json({
      message: '注册成功',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        avatar: user.avatar,
        vip_expires_at: user.vip_expires_at || null
      }
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : '注册失败，请稍后重试' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '请输入邮箱和密码' });
    }

    let user = User.findByEmail(email);
    if (!user) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    user = User.refreshVipStatus(user.id);
    const token = generateToken(user.id);

    res.json({
      message: '登录成功',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        avatar: user.avatar,
        vip_expires_at: user.vip_expires_at || null
      }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

router.post('/send-password-reset-code', async (req, res) => {
  let verification = null;
  try {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const email = VerificationCode.normalizeTarget(req.body?.email, 'email');

    if (!runtimeConfig.emailVerificationEnabled) {
      return res.status(400).json({ error: '邮箱验证码未启用，请联系管理员' });
    }

    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }

    if (!User.findByEmail(email)) {
      return res.status(404).json({ error: '该邮箱尚未注册' });
    }

    verification = VerificationCode.create({
      target: email,
      channel: 'email',
      purpose: 'password_reset',
      requestIp: req.ip || req.socket?.remoteAddress || ''
    });

    const sendResult = await EmailService.sendPasswordResetCode({
      email,
      code: verification.code,
      ttlMinutes: VerificationCode.ttlMinutes(),
      config: runtimeConfig
    });

    res.json({
      message: sendResult.devOnly
        ? '重置验证码已生成，请查看后端控制台日志'
        : '重置验证码已发送，请查看邮箱',
      expires_at: verification.expiresAt,
      dev: Boolean(sendResult.devOnly)
    });
  } catch (error) {
    if (verification?.id) {
      VerificationCode.invalidate(verification.id);
    }
    console.error('发送重置密码验证码错误:', EmailService.formatEmailError(error), error);
    const isQueueLimit = error.status === 429;
    res.status(isQueueLimit ? 429 : 500).json({
      error: error.publicMessage || (isQueueLimit ? error.message : '重置验证码发送失败，请稍后重试')
    });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const email = VerificationCode.normalizeTarget(req.body?.email, 'email');
    const { verificationCode, newPassword } = req.body;

    if (!runtimeConfig.emailVerificationEnabled) {
      return res.status(400).json({ error: '邮箱验证码未启用，请联系管理员' });
    }

    if (!email || !verificationCode || !newPassword) {
      return res.status(400).json({ error: '请填写邮箱、验证码和新密码' });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: '新密码长度至少6位' });
    }

    let user = User.findByEmail(email);
    if (!user) {
      return res.status(404).json({ error: '该邮箱尚未注册' });
    }

    VerificationCode.verify({
      target: email,
      channel: 'email',
      purpose: 'password_reset',
      code: verificationCode
    });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    user = User.update(user.id, { password_hash: passwordHash });
    user = User.refreshVipStatus(user.id) || user;
    const token = generateToken(user.id);

    res.json({
      message: '密码已重置',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        avatar: user.avatar,
        vip_expires_at: user.vip_expires_at || null
      }
    });
  } catch (error) {
    console.error('重置密码错误:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : '重置密码失败，请稍后重试' });
  }
});

router.get('/me', auth, (req, res) => {
  const quota = User.getQuota(req.userId);
  const storage = StorageLimitService.getUserStorageSummary(req.userId);
  const user = User.refreshVipStatus(req.userId) || req.user;
  const referral = User.getReferralSummary(req.userId);
  referral.invite_link = buildInviteLink(req, referral.invite_code);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      avatar: user.avatar,
      invite_code: referral.invite_code,
      vip_expires_at: user.vip_expires_at || null,
      created_at: user.created_at
    },
    quota,
    storage,
    referral
  });
});

router.put('/me', auth, async (req, res) => {
  try {
    const { username, avatar } = req.body;
    const updates = {};

    if (username) updates.username = username;
    if (avatar !== undefined) updates.avatar = avatar;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '没有需要更新的字段' });
    }

    const user = User.update(req.userId, updates);

    res.json({
      message: '更新成功',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        avatar: user.avatar,
        vip_expires_at: user.vip_expires_at || null
      }
    });
  } catch (error) {
    console.error('更新用户信息错误:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

router.put('/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: '请填写所有字段' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码长度至少6位' });
    }

    const isValid = await bcrypt.compare(currentPassword, req.user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: '当前密码错误' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    User.update(req.userId, { password_hash: passwordHash });

    res.json({ message: '密码修改成功' });
  } catch (error) {
    console.error('修改密码错误:', error);
    res.status(500).json({ error: '修改密码失败' });
  }
});

router.get('/quota', auth, (req, res) => {
  const quota = User.getQuota(req.userId);
  const storage = StorageLimitService.getUserStorageSummary(req.userId);
  res.json({ quota, storage });
});

router.post('/redeem', auth, (req, res) => {
  try {
    const result = RedemptionCode.redeem({
      userId: req.userId,
      code: req.body?.code
    });

    const isVipReward = result.reward_type === 'vip';
    const vipSuffix = isVipReward && result.user?.vip_expires_at
      ? `，有效至 ${result.user.vip_expires_at}`
      : '';
    res.json({
      message: isVipReward
        ? `兑换成功，已开通 VIP 权益并发放 ${result.bonus_credits || 0} 点限时额度${vipSuffix}`
        : `兑换成功，已增加 ${result.credits} 点通用额度`,
      code: result.code,
      reward_type: result.reward_type,
      credits: result.credits,
      vip_days: result.vip_days,
      bonus_credits: result.bonus_credits || 0,
      quota: result.quota,
      user: result.user ? {
        id: result.user.id,
        email: result.user.email,
        username: result.user.username,
        role: result.user.role,
        avatar: result.user.avatar,
        vip_expires_at: result.user.vip_expires_at || null
      } : undefined
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '兑换失败' });
  }
});

router.get('/redeem/history', auth, (req, res) => {
  const history = RedemptionCode.historyForUser(req.userId, req.query.limit);
  res.json({ history });
});

router.get('/credits/history', auth, (req, res) => {
  const history = User.getCreditHistory(req.userId, req.query.limit);
  res.json({ history });
});

module.exports = router;
