const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const appConfig = require('../config/appConfig');

appConfig.validateProductionEnv();
appConfig.ensureRuntimeDirs();

const dbPath = appConfig.dbPath;
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const initDatabase = () => {
  db.exec(`
    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT,
      role TEXT DEFAULT 'user' CHECK(role IN ('user', 'admin', 'vip')),
      vip_expires_at DATETIME,
      invite_code TEXT,
      referred_by_user_id INTEGER,
      quota_ppt INTEGER DEFAULT 10,
      quota_image INTEGER DEFAULT 50,
      quota_video INTEGER DEFAULT 5,
      used_ppt INTEGER DEFAULT 0,
      used_image INTEGER DEFAULT 0,
      used_video INTEGER DEFAULT 0,
      used_chat INTEGER DEFAULT 0,
      quota_chat INTEGER DEFAULT 100,
      credits_total INTEGER DEFAULT 0,
      credits_used INTEGER DEFAULT 0,
      vip_bonus_credits_total INTEGER DEFAULT 0,
      vip_bonus_credits_used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- AI任务表
    CREATE TABLE IF NOT EXISTS ai_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('ppt', 'image', 'video')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      prompt TEXT NOT NULL,
      params TEXT,
      result_url TEXT,
      result_data TEXT,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 文件表
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task_id INTEGER,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (task_id) REFERENCES ai_tasks(id)
    );

    -- 会员套餐表
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      quota_ppt INTEGER NOT NULL,
      quota_image INTEGER NOT NULL,
      quota_video INTEGER NOT NULL,
      features TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 通用额度兑换码表
    CREATE TABLE IF NOT EXISTS redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      reward_type TEXT DEFAULT 'credits' CHECK(reward_type IN ('credits', 'vip')),
      credits INTEGER NOT NULL,
      vip_days INTEGER DEFAULT 0,
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
      note TEXT,
      expires_at DATETIME,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- 兑换记录表
    CREATE TABLE IF NOT EXISTS redemption_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reward_type TEXT DEFAULT 'credits' CHECK(reward_type IN ('credits', 'vip')),
      credits INTEGER NOT NULL,
      vip_days INTEGER DEFAULT 0,
      redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (code_id) REFERENCES redemption_codes(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(code_id, user_id)
    );

    -- 通用额度流水表
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('credit', 'debit')),
      amount INTEGER NOT NULL,
      source TEXT NOT NULL,
      note TEXT,
      balance_after INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 支付充值订单表
    CREATE TABLE IF NOT EXISTS payment_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      provider TEXT DEFAULT 'alipay',
      package_id TEXT NOT NULL,
      package_type TEXT NOT NULL CHECK(package_type IN ('credits', 'vip')),
      package_title TEXT NOT NULL,
      credits INTEGER DEFAULT 0,
      vip_days INTEGER DEFAULT 0,
      amount_cents INTEGER NOT NULL,
      currency TEXT DEFAULT 'CNY',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'closed', 'failed')),
      alipay_trade_no TEXT,
      buyer_id TEXT,
      notify_payload TEXT,
      paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 用户邀请关系表
    CREATE TABLE IF NOT EXISTS user_referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_id INTEGER NOT NULL,
      invitee_id INTEGER NOT NULL UNIQUE,
      invite_code TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inviter_id) REFERENCES users(id),
      FOREIGN KEY (invitee_id) REFERENCES users(id)
    );

    -- 邀请返利记录表
    CREATE TABLE IF NOT EXISTS referral_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_id INTEGER NOT NULL,
      invitee_id INTEGER NOT NULL,
      source_transaction_id INTEGER UNIQUE,
      base_amount INTEGER NOT NULL,
      reward_amount INTEGER NOT NULL,
      reward_rate REAL NOT NULL,
      is_first INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inviter_id) REFERENCES users(id),
      FOREIGN KEY (invitee_id) REFERENCES users(id),
      FOREIGN KEY (source_transaction_id) REFERENCES credit_transactions(id)
    );

    -- 注册/安全验证码表
    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('email', 'sms')),
      purpose TEXT NOT NULL CHECK(purpose IN ('register', 'password_reset')),
      code_hash TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      consumed_at DATETIME,
      attempts INTEGER DEFAULT 0,
      request_ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON ai_tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON ai_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON ai_tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_type_status_created ON ai_tasks(type, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON ai_tasks(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
    CREATE INDEX IF NOT EXISTS idx_redemption_codes_code ON redemption_codes(code);
    CREATE INDEX IF NOT EXISTS idx_redemption_redemptions_user ON redemption_redemptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_credit_transactions_created ON credit_transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_order_no ON payment_orders(order_no);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);
    CREATE INDEX IF NOT EXISTS idx_user_referrals_inviter ON user_referrals(inviter_id);
    CREATE INDEX IF NOT EXISTS idx_user_referrals_invitee ON user_referrals(invitee_id);
    CREATE INDEX IF NOT EXISTS idx_referral_rewards_inviter ON referral_rewards(inviter_id);
    CREATE INDEX IF NOT EXISTS idx_referral_rewards_invitee ON referral_rewards(invitee_id);
    CREATE INDEX IF NOT EXISTS idx_verification_codes_target ON verification_codes(target, channel, purpose);
    CREATE INDEX IF NOT EXISTS idx_verification_codes_expires ON verification_codes(expires_at);
  `);

  // 迁移：为已存在的 users 表添加新字段（CREATE TABLE IF NOT EXISTS 不会更新已有表）
  const migrateTable = (tableName, columnDefs) => {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map(r => r.name);
    const added = [];
    for (const [col, def] of columnDefs) {
      if (!columns.includes(col)) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${col} ${def}`);
        console.log(`[Migration] Added column ${col} to ${tableName}`);
        added.push(col);
      }
    }
    return added;
  };
  const addedUserColumns = migrateTable('users', [
    ['used_chat', 'INTEGER DEFAULT 0'],
    ['quota_chat', 'INTEGER DEFAULT 100'],
    ['used_ppt', 'INTEGER DEFAULT 0'],
    ['quota_ppt', 'INTEGER DEFAULT 10'],
    ['used_image', 'INTEGER DEFAULT 0'],
    ['quota_image', 'INTEGER DEFAULT 50'],
    ['used_video', 'INTEGER DEFAULT 0'],
    ['quota_video', 'INTEGER DEFAULT 5'],
    ['credits_total', 'INTEGER DEFAULT 0'],
    ['credits_used', 'INTEGER DEFAULT 0'],
    ['vip_bonus_credits_total', 'INTEGER DEFAULT 0'],
    ['vip_bonus_credits_used', 'INTEGER DEFAULT 0'],
    ['vip_expires_at', 'DATETIME'],
    ['invite_code', 'TEXT'],
    ['referred_by_user_id', 'INTEGER'],
  ]);

  const migrateVerificationCodePurposes = () => {
    const tableInfo = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'verification_codes'
      LIMIT 1
    `).get();
    const createSql = String(tableInfo?.sql || '');
    if (createSql.includes('password_reset')) return;

    console.log('[Migration] Rebuilding verification_codes to support password reset codes');
    db.exec(`
      ALTER TABLE verification_codes RENAME TO verification_codes_old;

      CREATE TABLE verification_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('email', 'sms')),
        purpose TEXT NOT NULL CHECK(purpose IN ('register', 'password_reset')),
        code_hash TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME,
        attempts INTEGER DEFAULT 0,
        request_ip TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO verification_codes (
        id,
        target,
        channel,
        purpose,
        code_hash,
        expires_at,
        consumed_at,
        attempts,
        request_ip,
        created_at,
        updated_at
      )
      SELECT
        id,
        target,
        channel,
        purpose,
        code_hash,
        expires_at,
        consumed_at,
        attempts,
        request_ip,
        created_at,
        updated_at
      FROM verification_codes_old
      WHERE purpose IN ('register', 'password_reset');

      DROP TABLE verification_codes_old;

      CREATE INDEX IF NOT EXISTS idx_verification_codes_target ON verification_codes(target, channel, purpose);
      CREATE INDEX IF NOT EXISTS idx_verification_codes_expires ON verification_codes(expires_at);
    `);
  };

  migrateVerificationCodePurposes();

  db.exec(`
    UPDATE verification_codes
    SET consumed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE purpose NOT IN ('register', 'password_reset');
  `);

  migrateTable('redemption_codes', [
    ['reward_type', "TEXT DEFAULT 'credits'"],
    ['vip_days', 'INTEGER DEFAULT 0']
  ]);
  migrateTable('redemption_redemptions', [
    ['reward_type', "TEXT DEFAULT 'credits'"],
    ['vip_days', 'INTEGER DEFAULT 0']
  ]);

  const makeInviteCode = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'AI';
    for (let i = 0; i < 8; i += 1) {
      code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    return code;
  };

  db.exec(`UPDATE users SET invite_code = NULL WHERE TRIM(COALESCE(invite_code, '')) = ''`);
  const usersWithoutInviteCode = db.prepare(`
    SELECT id
    FROM users
    WHERE invite_code IS NULL
  `).all();
  const codeExists = db.prepare('SELECT 1 FROM users WHERE invite_code = ? LIMIT 1');
  const setInviteCode = db.prepare('UPDATE users SET invite_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  usersWithoutInviteCode.forEach(user => {
    let code = makeInviteCode();
    while (codeExists.get(code)) {
      code = makeInviteCode();
    }
    setInviteCode.run(code, user.id);
  });

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code) WHERE invite_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_user_id);
  `);

  if (addedUserColumns.includes('credits_total') || addedUserColumns.includes('credits_used')) {
    db.exec(`
      UPDATE users
      SET credits_total =
        MAX(0, COALESCE(quota_ppt, 0) - COALESCE(used_ppt, 0)) +
        MAX(0, COALESCE(quota_image, 0) - COALESCE(used_image, 0)) +
        MAX(0, COALESCE(quota_video, 0) - COALESCE(used_video, 0))
      WHERE COALESCE(credits_total, 0) = 0
        AND COALESCE(credits_used, 0) = 0
        AND (
          COALESCE(quota_ppt, 0) > 0
          OR COALESCE(quota_image, 0) > 0
          OR COALESCE(quota_video, 0) > 0
        );
    `);
  }

  console.log('数据库初始化完成');
};

module.exports = { db, initDatabase };
