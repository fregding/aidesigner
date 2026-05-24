const crypto = require('crypto');
const { db } = require('./database');
const RuntimeConfigService = require('../services/runtimeConfigService');

const VIP_REDEEM_BONUS_CREDITS = 500;
const VIP_CREDIT_DISCOUNT_RATE = 0.8;
const LEGACY_TYPES = new Set(['ppt', 'image', 'video', 'chat']);
const REFERRAL_REWARD_SOURCES = new Set(['ppt', 'image', 'video', 'chat']);
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class User {
  static pricingConfig() {
    return RuntimeConfigService.getRuntimeConfig().pricing || {};
  }

  static creditsPerPptPage() {
    return Math.max(0, Number(this.pricingConfig().ppt?.pageCredits ?? 5));
  }

  static creditsPerPptImage() {
    return Math.max(0, Number(this.pricingConfig().ppt?.imageCredits ?? 5));
  }

  static creditsPerImage() {
    return Math.max(0, Number(this.pricingConfig().image?.creditsPerImage ?? 5));
  }

  static creditsPerAiTokenThousand() {
    return Math.max(0, Number(
      this.pricingConfig().assistant?.tokenCreditsPerThousand
      ?? this.pricingConfig().text?.tokenCreditsPerThousand
      ?? 0.1
    ));
  }

  static estimateTextTokens(value) {
    const visit = input => {
      if (input === null || input === undefined) return '';
      if (typeof input === 'string') return input;
      if (Array.isArray(input)) {
        return input.map(item => {
          if (typeof item === 'string') return item;
          if (item?.type === 'image_url' || item?.type === 'image') return ' '.repeat(512);
          return visit(item?.text ?? item?.content ?? item);
        }).join('\n');
      }
      if (typeof input === 'object') {
        if (input.role || input.content) return `${input.role || ''}\n${visit(input.content)}`;
        return Object.values(input).map(visit).join('\n');
      }
      return String(input);
    };
    const text = visit(value);
    if (!text) return 0;
    const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const otherCount = Math.max(0, text.length - cjkCount);
    return Math.max(1, Math.ceil(cjkCount * 1.2 + otherCount / 4));
  }

  static normalizeTokenUsage(usage = {}, fallback = {}) {
    usage = usage && typeof usage === 'object' ? usage : {};
    fallback = fallback && typeof fallback === 'object' ? fallback : {};

    const firstNumber = (...values) => {
      for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return Math.ceil(number);
      }
      return 0;
    };

    let promptTokens = firstNumber(
      usage.prompt_tokens,
      usage.promptTokens,
      usage.input_tokens,
      usage.inputTokens
    );
    let completionTokens = firstNumber(
      usage.completion_tokens,
      usage.completionTokens,
      usage.output_tokens,
      usage.outputTokens
    );
    let totalTokens = firstNumber(
      usage.total_tokens,
      usage.totalTokens,
      usage.total_token_count,
      usage.totalTokenCount
    );
    let estimated = false;

    if (!totalTokens && (promptTokens || completionTokens)) {
      totalTokens = promptTokens + completionTokens;
    }

    if (!totalTokens) {
      promptTokens = this.estimateTextTokens(fallback.messages || fallback.prompt || '');
      completionTokens = this.estimateTextTokens(fallback.content || fallback.completion || '');
      totalTokens = promptTokens + completionTokens;
      estimated = totalTokens > 0;
    }

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      estimated
    };
  }

  static buildTokenCreditBilling({ usage = {}, fallback = {}, idOrUser = null } = {}) {
    const tokenUsage = this.normalizeTokenUsage(usage, fallback);
    const creditsPerThousandTokens = this.creditsPerAiTokenThousand();
    const rawCredits = tokenUsage.total_tokens > 0 && creditsPerThousandTokens > 0
      ? (tokenUsage.total_tokens / 1000) * creditsPerThousandTokens
      : 0;
    const originalCredits = rawCredits >= 1
      ? Math.ceil(rawCredits)
      : 0;
    if (originalCredits <= 0) {
      return {
        originalCredits: 0,
        chargedCredits: 0,
        discountCredits: 0,
        discountRate: 1,
        discountLabel: '',
        vipDiscountApplied: false,
        creditsPerThousandTokens,
        tokenUsage
      };
    }
    return {
      ...this.buildCreditBilling(originalCredits, idOrUser),
      creditsPerThousandTokens,
      tokenUsage
    };
  }

  static tokenBillingMetadata(billing = {}) {
    const tokenUsage = billing.tokenUsage || {};
    return {
      original_credits: Math.max(0, Math.ceil(Number(billing.originalCredits) || 0)),
      charged_credits: Math.max(0, Math.ceil(Number(billing.chargedCredits) || 0)),
      discount_credits: Math.max(0, Math.ceil(Number(billing.discountCredits) || 0)),
      discount_rate: Number(billing.discountRate || 1),
      discount_label: billing.discountLabel || '',
      vip_discount_applied: Boolean(billing.vipDiscountApplied),
      token_usage: {
        prompt_tokens: Math.max(0, Math.ceil(Number(tokenUsage.prompt_tokens) || 0)),
        completion_tokens: Math.max(0, Math.ceil(Number(tokenUsage.completion_tokens) || 0)),
        total_tokens: Math.max(0, Math.ceil(Number(tokenUsage.total_tokens) || 0)),
        estimated: Boolean(tokenUsage.estimated)
      },
      credits_per_1k_tokens: Number(billing.creditsPerThousandTokens || 0)
    };
  }

  static billTokenUsage(id, usage = {}, options = {}) {
    const billing = this.buildTokenCreditBilling({
      usage,
      fallback: options.fallback || {},
      idOrUser: id
    });
    const metadata = this.tokenBillingMetadata(billing);
    if (billing.chargedCredits <= 0) {
      return {
        ...metadata,
        deducted: 0
      };
    }

    const tokenUsage = metadata.token_usage;
    const tokenLabel = `${tokenUsage.estimated ? '约' : ''}${tokenUsage.total_tokens} tokens`;
    const rateLabel = `${metadata.credits_per_1k_tokens}点/1000 tokens`;
    const notePrefix = options.notePrefix || 'AI助手 token 计费';
    const note = options.note || `${notePrefix} ${tokenLabel}（${rateLabel}）${this.creditBillingNoteSuffix(billing)}`;
    const debit = this.debitCredits(id, billing.chargedCredits, {
      source: options.source || 'chat',
      legacyType: options.legacyType || options.source || 'chat',
      note,
      capToAvailable: Boolean(options.capToAvailable)
    });
    const actualDeducted = Math.max(0, Number(debit.deducted) || 0);

    return {
      ...metadata,
      requested_charged_credits: metadata.charged_credits,
      charged_credits: options.capToAvailable ? actualDeducted : metadata.charged_credits,
      deducted: actualDeducted,
      vip_bonus_used: debit.vipBonusUsed || 0,
      permanent_used: debit.permanentUsed || 0,
      capped_to_available: Boolean(debit.cappedToAvailable)
    };
  }

  static vipRedeemBonusCredits() {
    return VIP_REDEEM_BONUS_CREDITS;
  }

  static vipCreditDiscountRate() {
    const rawRate = Number(this.pricingConfig().vipDiscountRate ?? VIP_CREDIT_DISCOUNT_RATE);
    if (!Number.isFinite(rawRate) || rawRate <= 0 || rawRate >= 1) {
      return VIP_CREDIT_DISCOUNT_RATE;
    }
    return rawRate;
  }

  static isVipDiscountEligible(user) {
    if (!user) return false;
    if (this.isVipActive(user)) return true;
    if (user.role !== 'admin' || !user.vip_expires_at) return false;
    const expiresAt = new Date(user.vip_expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  static buildCreditBilling(amount = 1, idOrUser = null) {
    const originalCredits = Math.max(1, Math.ceil(Number(amount) || 1));
    const user = idOrUser
      ? this.refreshVipStatus(idOrUser)
      : null;
    const discountRate = this.vipCreditDiscountRate();
    const vipDiscountApplied = this.isVipDiscountEligible(user);
    const chargedCredits = vipDiscountApplied
      ? Math.max(1, Math.ceil(originalCredits * discountRate))
      : originalCredits;

    return {
      originalCredits,
      chargedCredits,
      discountCredits: Math.max(0, originalCredits - chargedCredits),
      discountRate: vipDiscountApplied ? discountRate : 1,
      discountLabel: vipDiscountApplied ? 'VIP专属8折' : '',
      vipDiscountApplied
    };
  }

  static creditBillingMetadata(billing = {}) {
    return {
      original_credits: Math.max(1, Math.ceil(Number(billing.originalCredits) || Number(billing.chargedCredits) || 1)),
      charged_credits: Math.max(1, Math.ceil(Number(billing.chargedCredits) || 1)),
      discount_credits: Math.max(0, Math.ceil(Number(billing.discountCredits) || 0)),
      discount_rate: Number(billing.discountRate || 1),
      discount_label: billing.discountLabel || '',
      vip_discount_applied: Boolean(billing.vipDiscountApplied)
    };
  }

  static creditBillingNoteSuffix(billing = {}) {
    if (!billing.vipDiscountApplied) return '';
    return `（${billing.discountLabel || 'VIP专属8折'}，原价${billing.originalCredits}点，实扣${billing.chargedCredits}点）`;
  }

  static creditBillingQuotaMessage(prefix, billing = {}) {
    const chargedCredits = Math.max(1, Math.ceil(Number(billing.chargedCredits) || 1));
    if (!billing.vipDiscountApplied) {
      return `${prefix}预计需要 ${chargedCredits} 点额度`;
    }
    return `${prefix}预计需要 ${chargedCredits} 点额度（${billing.discountLabel || 'VIP专属8折'}，原价 ${billing.originalCredits} 点）`;
  }

  static estimateImageCredits(count = 1) {
    const safeCount = Math.max(1, parseInt(count, 10) || 1);
    return Math.max(1, Math.ceil(safeCount * this.creditsPerImage()));
  }

  static estimatePptCredits({ pageCount = 1, imageCount = 0 } = {}) {
    const safePages = Math.max(1, parseInt(pageCount, 10) || 1);
    const safeImages = Math.max(0, parseInt(imageCount, 10) || 0);
    return Math.max(1, Math.ceil(safePages * this.creditsPerPptPage() + safeImages * this.creditsPerPptImage()));
  }

  static findById(id) {
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id);
  }

  static findByEmail(email) {
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    return stmt.get(email);
  }

  static normalizeInviteCode(code = '') {
    return String(code || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  static generateInviteCode() {
    let code = '';
    for (let i = 0; i < 8; i += 1) {
      code += INVITE_CODE_ALPHABET[crypto.randomInt(0, INVITE_CODE_ALPHABET.length)];
    }
    return `AI${code}`;
  }

  static findByInviteCode(code) {
    const inviteCode = this.normalizeInviteCode(code);
    if (!inviteCode) return null;
    return db.prepare('SELECT * FROM users WHERE invite_code = ?').get(inviteCode);
  }

  static ensureInviteCode(id) {
    const user = this.findById(id);
    if (!user) return null;
    const existingCode = this.normalizeInviteCode(user.invite_code);
    if (existingCode) return existingCode;

    let inviteCode = this.generateInviteCode();
    while (this.findByInviteCode(inviteCode)) {
      inviteCode = this.generateInviteCode();
    }

    db.prepare(`
      UPDATE users
      SET invite_code = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(inviteCode, id);
    return inviteCode;
  }

  static registrationInitialCredits() {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    return Math.max(0, Math.floor(Number(runtimeConfig.registrationInitialCredits ?? 100) || 0));
  }

  static create({ email, username, passwordHash, initialCredits = undefined }) {
    let inviteCode = this.generateInviteCode();
    while (this.findByInviteCode(inviteCode)) {
      inviteCode = this.generateInviteCode();
    }

    const giftCredits = Math.max(
      0,
      Math.floor(Number(initialCredits === undefined ? this.registrationInitialCredits() : initialCredits) || 0)
    );
    const tx = db.transaction(() => {
      const stmt = db.prepare(`
        INSERT INTO users (email, username, password_hash, invite_code, credits_total)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = stmt.run(email, username, passwordHash, inviteCode, giftCredits);
      const user = this.findById(result.lastInsertRowid);
      if (giftCredits > 0) {
        this.recordCreditTransaction({
          userId: user.id,
          direction: 'credit',
          amount: giftCredits,
          source: 'registration_bonus',
          note: `注册赠送 ${giftCredits} 点通用额度`,
          balanceAfter: giftCredits
        });
      }
      return user;
    });

    return tx();
  }

  static update(id, data) {
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return false;

    values.push(id);
    const stmt = db.prepare(`UPDATE users SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    stmt.run(...values);
    return this.findById(id);
  }

  static isVipExpired(user, now = new Date()) {
    if (!user || user.role !== 'vip' || !user.vip_expires_at) return false;
    const expiresAt = new Date(user.vip_expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
  }

  static isVipActive(user) {
    return Boolean(user && user.role === 'vip' && !this.isVipExpired(user));
  }

  static hasUnlimitedStorage(user) {
    return Boolean(user && (user.role === 'admin' || this.isVipActive(user)));
  }

  static expireVipMembership(idOrUser) {
    const user = typeof idOrUser === 'object' && idOrUser !== null
      ? idOrUser
      : this.findById(idOrUser);
    if (!user) return null;
    if (!this.isVipExpired(user)) return user;

    const remainingVipBonus = Math.max(
      0,
      Number(user.vip_bonus_credits_total || 0) - Number(user.vip_bonus_credits_used || 0)
    );

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET role = 'user',
            vip_expires_at = NULL,
            vip_bonus_credits_total = 0,
            vip_bonus_credits_used = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(user.id);

      const updatedUser = this.findById(user.id);
      if (remainingVipBonus > 0) {
        const balanceAfter = this.buildQuotaSnapshot(updatedUser)?.credits?.remaining ?? 0;
        this.recordCreditTransaction({
          userId: user.id,
          direction: 'debit',
          amount: remainingVipBonus,
          source: 'vip_bonus_expiry',
          note: 'VIP限时额度到期清空',
          balanceAfter
        });
      }
      return updatedUser;
    });

    return tx();
  }

  static refreshVipStatus(idOrUser) {
    const user = typeof idOrUser === 'object' && idOrUser !== null
      ? idOrUser
      : this.findById(idOrUser);
    if (!user) return null;
    if (!this.isVipExpired(user)) return user;
    return this.expireVipMembership(user);
  }

  static activateVip(id, days = 0) {
    const user = this.refreshVipStatus(id);
    if (!user) return null;

    const safeDays = Math.max(0, parseInt(days, 10) || 0);
    let expiresAt = null;

    if (safeDays > 0) {
      if (user.role === 'vip' && !user.vip_expires_at) {
        expiresAt = null;
      } else {
        const now = Date.now();
        const currentExpiresAt = user.vip_expires_at ? new Date(user.vip_expires_at).getTime() : 0;
        const base = Number.isFinite(currentExpiresAt) && currentExpiresAt > now ? currentExpiresAt : now;
        expiresAt = new Date(base + safeDays * 24 * 60 * 60 * 1000).toISOString();
      }
    }

    if (user.role === 'admin') {
      return this.update(id, {
        vip_expires_at: expiresAt || '9999-12-31T23:59:59.000Z'
      });
    }

    return this.update(id, { role: 'vip', vip_expires_at: expiresAt });
  }

  static setRole(id, role) {
    if (!['user', 'admin', 'vip'].includes(role)) {
      throw new Error('无效的角色');
    }
    return this.update(id, {
      role,
      vip_expires_at: null,
      vip_bonus_credits_total: 0,
      vip_bonus_credits_used: 0
    });
  }

  static expireVipMemberships() {
    const expiredUsers = db.prepare(`
      SELECT *
      FROM users
      WHERE role = 'vip'
        AND vip_expires_at IS NOT NULL
        AND strftime('%s', vip_expires_at) <= strftime('%s', ?)
    `).all(new Date().toISOString());

    expiredUsers.forEach(user => {
      this.expireVipMembership(user);
    });
    return expiredUsers.length;
  }

  static updateQuota(id, type, increment = 1, options = {}) {
    return this.debitCredits(id, increment, {
      source: type,
      legacyType: type,
      note: options.note,
      capToAvailable: Boolean(options.capToAvailable)
    });
  }

  static isUnlimitedStorageRole(role) {
    return role === 'vip' || role === 'admin';
  }

  static buildQuotaSnapshot(user) {
    if (!user) return null;

    const permanentTotal = Math.max(0, Number(user.credits_total || 0));
    const permanentUsed = Math.max(0, Number(user.credits_used || 0));
    const permanentRemaining = Math.max(0, permanentTotal - permanentUsed);

    const vipBonusTotal = Math.max(0, Number(user.vip_bonus_credits_total || 0));
    const vipBonusUsed = Math.max(0, Number(user.vip_bonus_credits_used || 0));
    const vipBonusRemaining = Math.max(0, vipBonusTotal - vipBonusUsed);

    const total = permanentTotal + vipBonusTotal;
    const used = permanentUsed + vipBonusUsed;
    const remaining = permanentRemaining + vipBonusRemaining;

    const permanent = { total: permanentTotal, used: permanentUsed, remaining: permanentRemaining };
    const vipBonus = {
      total: vipBonusTotal,
      used: vipBonusUsed,
      remaining: vipBonusRemaining,
      expires_at: user.vip_expires_at || null,
      priority: 'first'
    };

    const universal = {
      total,
      used,
      remaining,
      permanent,
      vip_bonus: vipBonus
    };

    return {
      credits: universal,
      universal,
      ppt: universal,
      image: universal,
      video: universal,
      chat: universal,
      legacy: {
        ppt: { total: user.quota_ppt, used: user.used_ppt, remaining: user.quota_ppt - user.used_ppt },
        image: { total: user.quota_image, used: user.used_image, remaining: user.quota_image - user.used_image },
        video: { total: user.quota_video, used: user.used_video, remaining: user.quota_video - user.used_video },
        chat: { total: user.quota_chat || 1000, used: user.used_chat || 0, remaining: (user.quota_chat || 1000) - (user.used_chat || 0) }
      }
    };
  }

  static getQuota(id) {
    const user = this.refreshVipStatus(id);
    return this.buildQuotaSnapshot(user);
  }

  static checkQuota(id, type, amount = 1) {
    const user = this.refreshVipStatus(id);
    if (!user) return false;
    const quota = this.getQuota(id);
    return quota?.credits?.remaining >= Math.max(1, Math.ceil(Number(amount) || 1));
  }

  static debitCredits(id, amount, { source = 'adjustment', legacyType = source, note = '', capToAvailable = false } = {}) {
    const user = this.refreshVipStatus(id);
    if (!user) return { changes: 0, requested: 0, deducted: 0, vipBonusUsed: 0, permanentUsed: 0, cappedToAvailable: Boolean(capToAvailable) };

    const requestedCredits = Math.max(1, Math.ceil(Number(amount) || 1));
    const vipBonusRemaining = Math.max(
      0,
      Number(user.vip_bonus_credits_total || 0) - Number(user.vip_bonus_credits_used || 0)
    );
    const permanentRemaining = Math.max(
      0,
      Number(user.credits_total || 0) - Number(user.credits_used || 0)
    );
    const availableCredits = vipBonusRemaining + permanentRemaining;
    const credits = capToAvailable ? Math.min(requestedCredits, availableCredits) : requestedCredits;
    if (credits <= 0) {
      return {
        changes: 0,
        requested: requestedCredits,
        deducted: 0,
        vipBonusUsed: 0,
        permanentUsed: 0,
        cappedToAvailable: Boolean(capToAvailable)
      };
    }

    const vipBonusUsed = Math.min(credits, vipBonusRemaining);
    const permanentUsed = capToAvailable
      ? Math.min(credits - vipBonusUsed, permanentRemaining)
      : credits - vipBonusUsed;
    const fields = [];
    const values = [];

    if (vipBonusUsed > 0) {
      fields.push('vip_bonus_credits_used = COALESCE(vip_bonus_credits_used, 0) + ?');
      values.push(vipBonusUsed);
    }
    if (permanentUsed > 0) {
      fields.push('credits_used = COALESCE(credits_used, 0) + ?');
      values.push(permanentUsed);
    }
    if (LEGACY_TYPES.has(legacyType)) {
      fields.push(`used_${legacyType} = COALESCE(used_${legacyType}, 0) + ?`);
      values.push(credits);
    }

    if (!fields.length) {
      return { changes: 0, deducted: 0, vipBonusUsed: 0, permanentUsed: 0 };
    }

    values.push(id);
    const result = db.prepare(`
      UPDATE users
      SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...values);

    if (result.changes > 0) {
      const quota = this.getQuota(id);
      const transactionId = this.recordCreditTransaction({
        userId: id,
        direction: 'debit',
        amount: credits,
        source,
        note: note || this.creditSourceLabel(source),
        balanceAfter: quota?.credits?.remaining ?? 0
      });
      this.applyReferralReward({
        inviteeId: id,
        spentCredits: credits,
        source,
        sourceTransactionId: transactionId
      });
    }

    return {
      ...result,
      requested: requestedCredits,
      deducted: credits,
      vipBonusUsed,
      permanentUsed,
      cappedToAvailable: Boolean(capToAvailable) && credits < requestedCredits
    };
  }

  static addCredits(id, amount, { source = 'redemption', note = '' } = {}) {
    const credits = Math.max(1, parseInt(amount, 10) || 1);
    const result = db.prepare(`
      UPDATE users
      SET credits_total = COALESCE(credits_total, 0) + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(credits, id);
    if (result.changes > 0) {
      const quota = this.getQuota(id);
      this.recordCreditTransaction({
        userId: id,
        direction: 'credit',
        amount: credits,
        source,
        note: note || this.creditSourceLabel(source),
        balanceAfter: quota?.credits?.remaining ?? 0
      });
    }
    return this.findById(id);
  }

  static grantVipBonusCredits(id, amount = VIP_REDEEM_BONUS_CREDITS, { note = '' } = {}) {
    const credits = Math.max(1, parseInt(amount, 10) || 1);
    const result = db.prepare(`
      UPDATE users
      SET vip_bonus_credits_total = COALESCE(vip_bonus_credits_total, 0) + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(credits, id);

    if (result.changes > 0) {
      const quota = this.getQuota(id);
      this.recordCreditTransaction({
        userId: id,
        direction: 'credit',
        amount: credits,
        source: 'vip_bonus',
        note: note || this.creditSourceLabel('vip_bonus'),
        balanceAfter: quota?.credits?.remaining ?? 0
      });
    }

    return this.findById(id);
  }

  static setCredits(id, total) {
    const credits = Math.max(0, parseInt(total, 10) || 0);
    db.prepare(`
      UPDATE users
      SET credits_total = ?,
          credits_used = MIN(COALESCE(credits_used, 0), ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(credits, credits, id);
    return this.findById(id);
  }

  static upgradeToVip(id) {
    const user = this.activateVip(id, 0);
    if (user) {
      this.setCredits(id, Math.max(Number(user.credits_total || 0), 5000));
    }
    return this.findById(id);
  }

  static creditSourceLabel(source) {
    return {
      ppt: 'PPT 生成',
	      image: '图片生成',
	      video: '视频生成',
	      chat: 'AI 对话',
	      alipay_recharge: '支付宝充值到账',
	      redemption: '兑换码到账',
      registration_bonus: '注册赠送',
	      referral_reward: '邀请返利到账',
      vip_bonus: 'VIP限时额度到账',
      vip_bonus_expiry: 'VIP限时额度到期清空',
      adjustment: '额度调整'
    }[source] || '额度变动';
  }

  static recordCreditTransaction({ userId, direction, amount, source, note = '', balanceAfter = 0 }) {
    const result = db.prepare(`
      INSERT INTO credit_transactions (user_id, direction, amount, source, note, balance_after)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      direction,
      Math.max(1, Math.ceil(Number(amount) || 1)),
      source || 'adjustment',
      note || this.creditSourceLabel(source),
      Math.max(0, parseInt(balanceAfter, 10) || 0)
    );
    return result.lastInsertRowid;
  }

  static getCreditHistory(id, limit = 50) {
    return db.prepare(`
      SELECT id, direction, amount, source, note, balance_after, created_at
      FROM credit_transactions
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(id, Math.max(1, Math.min(200, parseInt(limit, 10) || 50)));
  }

  static registerReferral({ inviterId, inviteeId, inviteCode }) {
    const safeInviterId = parseInt(inviterId, 10);
    const safeInviteeId = parseInt(inviteeId, 10);
    const normalizedCode = this.normalizeInviteCode(inviteCode);
    if (!safeInviterId || !safeInviteeId || safeInviterId === safeInviteeId || !normalizedCode) {
      return null;
    }

    const existingReferral = db.prepare(`
      SELECT *
      FROM user_referrals
      WHERE invitee_id = ?
    `).get(safeInviteeId);
    if (existingReferral) return existingReferral;

    const result = db.prepare(`
      INSERT INTO user_referrals (inviter_id, invitee_id, invite_code)
      VALUES (?, ?, ?)
    `).run(safeInviterId, safeInviteeId, normalizedCode);

    db.prepare(`
      UPDATE users
      SET referred_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND referred_by_user_id IS NULL
    `).run(safeInviterId, safeInviteeId);

    return db.prepare('SELECT * FROM user_referrals WHERE id = ?').get(result.lastInsertRowid);
  }

  static applyReferralReward({ inviteeId, spentCredits, source, sourceTransactionId = null }) {
    const safeInviteeId = parseInt(inviteeId, 10);
    const baseAmount = Math.max(0, Math.ceil(Number(spentCredits) || 0));
    if (!safeInviteeId || baseAmount <= 0 || !REFERRAL_REWARD_SOURCES.has(source)) {
      return null;
    }

    const referral = db.prepare(`
      SELECT inviter_id, invitee_id
      FROM user_referrals
      WHERE invitee_id = ?
    `).get(safeInviteeId);
    if (!referral || Number(referral.inviter_id) === safeInviteeId) {
      return null;
    }

    if (sourceTransactionId) {
      const existingReward = db.prepare(`
        SELECT id
        FROM referral_rewards
        WHERE source_transaction_id = ?
      `).get(sourceTransactionId);
      if (existingReward) return null;
    }

    const rewardCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM referral_rewards
      WHERE invitee_id = ?
    `).get(safeInviteeId)?.count || 0;
    const isFirst = rewardCount === 0;
    const rewardRate = isFirst ? 0.05 : 0.02;
    const rewardAmount = Math.max(1, Math.floor(baseAmount * rewardRate));
    const invitee = this.findById(safeInviteeId);
    const rewardNote = `${invitee?.username || invitee?.email || `用户${safeInviteeId}`}消费返利 ${Math.round(rewardRate * 100)}%`;

    const tx = db.transaction(() => {
      this.addCredits(referral.inviter_id, rewardAmount, {
        source: 'referral_reward',
        note: rewardNote
      });

      const result = db.prepare(`
        INSERT INTO referral_rewards (
          inviter_id,
          invitee_id,
          source_transaction_id,
          base_amount,
          reward_amount,
          reward_rate,
          is_first
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        referral.inviter_id,
        safeInviteeId,
        sourceTransactionId || null,
        baseAmount,
        rewardAmount,
        rewardRate,
        isFirst ? 1 : 0
      );

      return db.prepare('SELECT * FROM referral_rewards WHERE id = ?').get(result.lastInsertRowid);
    });

    return tx();
  }

  static getReferralSummary(id) {
    const userId = parseInt(id, 10);
    if (!userId) {
      return {
        invite_code: '',
        invited_count: 0,
        reward_total: 0,
        first_reward_count: 0,
        repeat_reward_count: 0
      };
    }

    const inviteCode = this.ensureInviteCode(userId) || '';
    const referralStats = db.prepare(`
      SELECT COUNT(*) as invited_count
      FROM user_referrals
      WHERE inviter_id = ?
    `).get(userId) || {};
    const rewardStats = db.prepare(`
      SELECT
        COUNT(*) as reward_count,
        COALESCE(SUM(reward_amount), 0) as reward_total,
        COALESCE(SUM(CASE WHEN is_first = 1 THEN 1 ELSE 0 END), 0) as first_reward_count,
        COALESCE(SUM(CASE WHEN is_first = 0 THEN 1 ELSE 0 END), 0) as repeat_reward_count
      FROM referral_rewards
      WHERE inviter_id = ?
    `).get(userId) || {};
    const inviteeStats = db.prepare(`
      SELECT COUNT(DISTINCT invitee_id) as rewarded_invitee_count
      FROM referral_rewards
      WHERE inviter_id = ?
    `).get(userId) || {};

    return {
      invite_code: inviteCode,
      invited_count: Number(referralStats.invited_count || 0),
      rewarded_invitee_count: Number(inviteeStats.rewarded_invitee_count || 0),
      reward_count: Number(rewardStats.reward_count || 0),
      reward_total: Number(rewardStats.reward_total || 0),
      first_reward_count: Number(rewardStats.first_reward_count || 0),
      repeat_reward_count: Number(rewardStats.repeat_reward_count || 0)
    };
  }
}

module.exports = User;
