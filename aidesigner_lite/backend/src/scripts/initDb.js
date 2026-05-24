const { initDatabase } = require('../models/database');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const { db } = require('../models/database');
const appConfig = require('../config/appConfig');

const initDb = async () => {
  console.log('初始化数据库...');

  initDatabase();

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

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
      INSERT INTO users (email, username, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run(adminEmail, '管理员', passwordHash);
    console.log(`已创建管理员账户: ${adminEmail}`);
  } else {
    console.log('管理员账户已存在');
  }

  console.log('数据库初始化完成!');
  process.exit(0);
};

initDb();
