const express = require('express');
const { auth, requireAdmin } = require('../middleware/auth');
const User = require('../models/User');

const router = express.Router();

router.get('/', auth, requireAdmin, (req, res) => {
  try {
    const { db } = require('../models/database');
    User.expireVipMemberships();
    const stmt = db.prepare(`
      SELECT id, email, username, role, vip_expires_at,
             COALESCE(credits_total, 0) + COALESCE(vip_bonus_credits_total, 0) as credits_total,
             COALESCE(credits_used, 0) + COALESCE(vip_bonus_credits_used, 0) as credits_used,
             MAX(0, COALESCE(credits_total, 0) - COALESCE(credits_used, 0))
               + MAX(0, COALESCE(vip_bonus_credits_total, 0) - COALESCE(vip_bonus_credits_used, 0)) as credits_remaining,
             created_at
      FROM users ORDER BY created_at DESC
    `);
    const users = stmt.all();

    res.json({ users });
  } catch (error) {
    console.error('获取用户列表错误:', error);
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

router.get('/:id', auth, requireAdmin, (req, res) => {
  try {
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const quota = User.getQuota(user.id);
    delete user.password_hash;

    res.json({ user: { ...user, ...quota } });
  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json({ error: '获取用户信息失败' });
  }
});

router.put('/:id/role', auth, requireAdmin, (req, res) => {
  try {
    const { role } = req.body;

    if (!['user', 'admin', 'vip'].includes(role)) {
      return res.status(400).json({ error: '无效的角色' });
    }

    const user = User.setRole(req.params.id, role);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({ message: '角色更新成功', user: { id: user.id, role: user.role } });
  } catch (error) {
    console.error('更新用户角色错误:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

router.put('/:id/quota', auth, requireAdmin, (req, res) => {
  try {
    const { quota_ppt, quota_image, quota_video, credits_total, credits } = req.body;
    const updates = {};

    if (quota_ppt !== undefined) updates.quota_ppt = quota_ppt;
    if (quota_image !== undefined) updates.quota_image = quota_image;
    if (quota_video !== undefined) updates.quota_video = quota_video;
    const nextCredits = credits_total !== undefined ? credits_total : credits;
    if (nextCredits !== undefined) updates.credits_total = Math.max(0, parseInt(nextCredits, 10) || 0);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '没有需要更新的额度' });
    }

    let user = User.update(req.params.id, updates);
    if (nextCredits !== undefined) {
      user = User.setCredits(req.params.id, nextCredits);
    }
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({ message: '额度更新成功', quota: User.getQuota(user.id) });
  } catch (error) {
    console.error('更新用户额度错误:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

router.delete('/:id', auth, requireAdmin, (req, res) => {
  res.status(410).json({ error: '请使用后台用户管理接口删除用户' });
});

module.exports = router;
