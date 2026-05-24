const { initDatabase } = require('../models/database');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const { db } = require('../models/database');
const appConfig = require('../config/appConfig');

const initDb = async () => {
  console.log('初始化数据库...');

  initDatabase();

  const adminEmail = process.env.ADMIN_EMAIL || (!appConfig.isProduction ? 'admin@localhost' : '');
  const adminPassword = process.env.ADMIN_PASSWORD || (!appConfig.isProduction ? 'AdminLocal@2026' : '');
  const fullCredits = Math.max(1000000, Number(appConfig.localFullCredits || 999999999));

  if (!adminEmail || !adminPassword) {
    if (appConfig.isProduction) {
      throw new Error('生产环境必须配置 ADMIN_EMAIL 和 ADMIN_PASSWORD');
    }
    console.log('未配置 ADMIN_EMAIL/ADMIN_PASSWORD，跳过管理员账号初始化。');
    console.log('数据库初始化完成!');
    process.exit(0);
  }

  const existingAdmin = User.findByEmail(adminEmail);

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    db.prepare(`
      INSERT INTO users (email, username, password_hash, role, quota_ppt, quota_image, quota_video, quota_chat, credits_total)
      VALUES (?, ?, ?, 'admin', ?, ?, ?, ?, ?)
    `).run(adminEmail, '本地管理员', passwordHash, fullCredits, fullCredits, fullCredits, fullCredits, fullCredits);
    console.log(`已创建管理员账户: ${adminEmail}，额度 ${fullCredits}`);
  } else {
    db.prepare(`
      UPDATE users
      SET role = 'admin', quota_ppt = ?, quota_image = ?, quota_video = ?, quota_chat = ?,
          credits_total = ?, credits_used = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fullCredits, fullCredits, fullCredits, fullCredits, fullCredits, existingAdmin.id);
    console.log(`管理员账户已存在，已同步本地满额额度: ${adminEmail}`);
  }

  console.log('数据库初始化完成!');
  process.exit(0);
};

initDb();
