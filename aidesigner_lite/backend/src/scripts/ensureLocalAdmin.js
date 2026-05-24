const bcrypt = require('bcryptjs');
const { db } = require('../models/database');

function numberEnv(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

function ensureLocalAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@localhost';
  const adminPassword = process.env.ADMIN_PASSWORD || 'AdminLocal@2026';
  const adminName = process.env.ADMIN_NAME || '本地管理员';

  const quota = numberEnv('ADMIN_QUOTA', 999999999);
  const imageQuota = numberEnv('ADMIN_IMAGE_QUOTA', quota);
  const pptQuota = numberEnv('ADMIN_PPT_QUOTA', quota);
  const videoQuota = numberEnv('ADMIN_VIDEO_QUOTA', quota);
  const credits = numberEnv('ADMIN_CREDITS', quota);

  if (!adminEmail || !adminPassword) {
    console.warn('[Admin] ADMIN_EMAIL/ADMIN_PASSWORD 未配置，跳过本地管理员初始化。');
    return;
  }

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(adminEmail);
  const passwordHash = bcrypt.hashSync(adminPassword, 12);

  if (!existing) {
    db.prepare(`
      INSERT INTO users (
        email,
        username,
        password_hash,
        role,
        quota_ppt,
        quota_image,
        quota_video,
        quota_chat,
        used_ppt,
        used_image,
        used_video,
        used_chat,
        credits_total,
        credits_used,
        vip_bonus_credits_total,
        vip_bonus_credits_used
      )
      VALUES (?, ?, ?, 'admin', ?, ?, ?, ?, 0, 0, 0, 0, ?, 0, ?, 0)
    `).run(
      adminEmail,
      adminName,
      passwordHash,
      pptQuota,
      imageQuota,
      videoQuota,
      quota,
      credits,
      credits
    );

    console.log(`[Admin] 已创建本地管理员账号: ${adminEmail}，额度 ${quota}`);
    return;
  }

  db.prepare(`
    UPDATE users
    SET
      username = ?,
      password_hash = ?,
      role = 'admin',
      quota_ppt = ?,
      quota_image = ?,
      quota_video = ?,
      quota_chat = ?,
      used_ppt = 0,
      used_image = 0,
      used_video = 0,
      used_chat = 0,
      credits_total = ?,
      credits_used = 0,
      vip_bonus_credits_total = ?,
      vip_bonus_credits_used = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE email = ?
  `).run(
    adminName,
    passwordHash,
    pptQuota,
    imageQuota,
    videoQuota,
    quota,
    credits,
    credits,
    adminEmail
  );

  db.prepare(`
    INSERT INTO credit_transactions (
      user_id,
      direction,
      amount,
      source,
      note,
      balance_after
    )
    VALUES (?, 'credit', ?, 'local_admin_bootstrap', '本地调试管理员额度初始化', ?)
  `).run(existing.id, credits, credits);

  console.log(`[Admin] 已刷新本地管理员账号: ${adminEmail}，role=admin，额度 ${quota}`);
}

module.exports = ensureLocalAdmin;
