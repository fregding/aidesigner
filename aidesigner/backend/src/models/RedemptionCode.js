const crypto = require('crypto');
const { db } = require('./database');
const User = require('./User');

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function compactCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function makeCode(prefix = 'AM') {
  const safePrefix = String(prefix || 'AM')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 8) || 'AM';
  const partA = crypto.randomBytes(3).toString('hex').toUpperCase();
  const partB = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${safePrefix}-${partA}-${partB}`;
}

class RedemptionCode {
  static createBatch({
    credits,
    count = 1,
    maxUses = 1,
    expiresAt = null,
    note = '',
    createdBy = null,
    prefix = '',
    rewardType = 'credits',
    vipDays = 0
  }) {
    const prefixText = String(prefix || '').trim().toUpperCase();
    const safeRewardType = rewardType === 'vip' || prefixText.startsWith('VIP')
      ? 'vip'
      : 'credits';
    const safeCredits = safeRewardType === 'vip'
      ? 0
      : Math.max(1, parseInt(credits, 10) || 0);
    const safeVipDays = safeRewardType === 'vip' ? Math.max(0, parseInt(vipDays, 10) || 0) : 0;
    const safeCount = Math.max(1, Math.min(500, parseInt(count, 10) || 1));
    const safeMaxUses = Math.max(1, Math.min(10000, parseInt(maxUses, 10) || 1));
    const insert = db.prepare(`
      INSERT INTO redemption_codes (code, reward_type, credits, vip_days, max_uses, expires_at, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const created = [];
    const tx = db.transaction(() => {
      for (let i = 0; i < safeCount; i += 1) {
        let code = '';
        for (let attempt = 0; attempt < 8; attempt += 1) {
          code = makeCode(prefix || (safeRewardType === 'vip' ? 'VIP' : 'AM'));
          try {
            const result = insert.run(
              code,
              safeRewardType,
              safeCredits,
              safeVipDays,
              safeMaxUses,
              expiresAt || null,
              note || '',
              createdBy
            );
            created.push(this.findById(result.lastInsertRowid));
            break;
          } catch (error) {
            if (!/UNIQUE/i.test(error.message) || attempt === 7) throw error;
          }
        }
      }
    });

    tx();
    return created;
  }

  static findById(id) {
    return db.prepare('SELECT * FROM redemption_codes WHERE id = ?').get(id);
  }

  static findByCode(code) {
    return db.prepare(`
      SELECT * FROM redemption_codes
      WHERE code = ?
         OR REPLACE(code, '-', '') = ?
    `).get(normalizeCode(code), compactCode(code));
  }

  static list({ page = 1, limit = 20, search = '', status = '', reward_type: rewardType = '' } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const offset = (safePage - 1) * safeLimit;
    const where = [];
    const params = [];

    if (search) {
      where.push('(c.code LIKE ? OR c.note LIKE ? OR u.username LIKE ?)');
      params.push(`%${String(search).trim().toUpperCase()}%`, `%${String(search).trim()}%`, `%${String(search).trim()}%`);
    }
    if (status && ['active', 'disabled'].includes(status)) {
      where.push('c.status = ?');
      params.push(status);
    }
    if (rewardType && ['credits', 'vip'].includes(rewardType)) {
      where.push('c.reward_type = ?');
      params.push(rewardType);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`
      SELECT COUNT(*) as count
      FROM redemption_codes c
      LEFT JOIN users u ON c.created_by = u.id
      ${whereSql}
    `).get(...params).count;
    const codes = db.prepare(`
      SELECT c.id, c.code, c.reward_type, c.credits, c.vip_days, c.max_uses, c.used_count,
             c.status, c.note, c.expires_at, c.created_at, c.updated_at,
             c.created_by, u.username AS created_by_username
      FROM redemption_codes c
      LEFT JOIN users u ON c.created_by = u.id
      ${whereSql}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, safeLimit, offset);

    return { codes, total, page: safePage, limit: safeLimit };
  }

  static setStatus(id, status) {
    if (!['active', 'disabled'].includes(status)) {
      throw new Error('无效的兑换码状态');
    }
    db.prepare(`
      UPDATE redemption_codes
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, id);
    return this.findById(id);
  }

  static setStatuses(ids = [], status) {
    if (!['active', 'disabled'].includes(status)) {
      throw new Error('无效的兑换码状态');
    }
    const safeIds = Array.from(new Set(
      (Array.isArray(ids) ? ids : [])
        .map(id => parseInt(id, 10))
        .filter(id => Number.isInteger(id) && id > 0)
    )).slice(0, 1000);
    if (!safeIds.length) {
      throw new Error('请选择需要更新的兑换码');
    }

    const placeholders = safeIds.map(() => '?').join(',');
    const result = db.prepare(`
      UPDATE redemption_codes
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `).run(status, ...safeIds);

    const codes = db.prepare(`
      SELECT *
      FROM redemption_codes
      WHERE id IN (${placeholders})
      ORDER BY created_at DESC, id DESC
    `).all(...safeIds);

    return {
      updated: result.changes || 0,
      codes
    };
  }

  static redeem({ userId, code }) {
    const normalizedCode = normalizeCode(code);
    if (!normalizedCode) throw new Error('请输入兑换码');

    const tx = db.transaction(() => {
      const record = this.findByCode(normalizedCode);
      if (!record) throw new Error('兑换码不存在');
      if (record.status !== 'active') throw new Error('兑换码已停用');
      if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
        throw new Error('兑换码已过期');
      }
      if (Number(record.used_count || 0) >= Number(record.max_uses || 1)) {
        throw new Error('兑换码已被使用完');
      }

      const redeemed = db.prepare(`
        SELECT id FROM redemption_redemptions WHERE code_id = ? AND user_id = ?
      `).get(record.id, userId);
      if (redeemed) throw new Error('你已经兑换过这个兑换码');

      const rewardType = record.reward_type === 'vip' ? 'vip' : 'credits';
      const credits = Math.max(0, parseInt(record.credits, 10) || 0);
      const vipDays = Math.max(0, parseInt(record.vip_days, 10) || 0);

      db.prepare(`
        INSERT INTO redemption_redemptions (code_id, user_id, reward_type, credits, vip_days)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.id, userId, rewardType, credits, vipDays);

      db.prepare(`
        UPDATE redemption_codes
        SET used_count = used_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(record.id);

      const bonusCredits = rewardType === 'vip' ? User.vipRedeemBonusCredits() : 0;
      if (rewardType === 'vip') {
        User.activateVip(userId, vipDays);
        User.grantVipBonusCredits(userId, bonusCredits, {
          note: 'VIP兑换码赠送500点限时额度'
        });
      } else {
        User.addCredits(userId, credits);
      }
      return {
        code: record.code,
        reward_type: rewardType,
        credits,
        vip_days: vipDays,
        bonus_credits: bonusCredits,
        quota: User.getQuota(userId),
        user: User.findById(userId)
      };
    });

    return tx();
  }

  static historyForUser(userId, limit = 20) {
    return db.prepare(`
      SELECT r.id, r.reward_type, r.credits, r.vip_days, r.redeemed_at, c.code, c.note,
             CASE WHEN r.reward_type = 'vip' THEN ? ELSE 0 END AS bonus_credits
      FROM redemption_redemptions r
      JOIN redemption_codes c ON r.code_id = c.id
      WHERE r.user_id = ?
      ORDER BY r.redeemed_at DESC
      LIMIT ?
    `).all(User.vipRedeemBonusCredits(), userId, Math.max(1, Math.min(100, parseInt(limit, 10) || 20)));
  }
}

module.exports = RedemptionCode;
