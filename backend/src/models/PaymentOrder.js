const crypto = require('crypto');
const { db } = require('./database');
const User = require('./User');
const RuntimeConfigService = require('../services/runtimeConfigService');

class PaymentOrder {
  static normalizeAmountCents(price) {
    const text = String(price || '').trim().replace(/[￥¥,\s]/g, '');
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    return Math.round(amount * 100);
  }

  static makeOrderNo() {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `AM${stamp}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  }

  static publicFields(order) {
    if (!order) return null;
    return {
      order_no: order.order_no,
      provider: order.provider,
      package_id: order.package_id,
      package_type: order.package_type,
      package_title: order.package_title,
      credits: Number(order.credits || 0),
      vip_days: Number(order.vip_days || 0),
      amount: Number(order.amount_cents || 0) / 100,
      amount_cents: Number(order.amount_cents || 0),
      currency: order.currency,
      status: order.status,
      alipay_trade_no: order.alipay_trade_no || '',
      paid_at: order.paid_at || null,
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  static findByOrderNo(orderNo) {
    const normalized = String(orderNo || '').trim();
    if (!normalized) return null;
    return db.prepare('SELECT * FROM payment_orders WHERE order_no = ?').get(normalized);
  }

  static findUserOrder(userId, orderNo) {
    const normalizedUserId = parseInt(userId, 10);
    const normalizedOrderNo = String(orderNo || '').trim();
    if (!normalizedUserId || !normalizedOrderNo) return null;
    return db.prepare(`
      SELECT *
      FROM payment_orders
      WHERE user_id = ? AND order_no = ?
    `).get(normalizedUserId, normalizedOrderNo);
  }

  static recentForUser(userId, limit = 20) {
    return db.prepare(`
      SELECT *
      FROM payment_orders
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(userId, Math.max(1, Math.min(100, parseInt(limit, 10) || 20)));
  }

  static getPackageById(packageId, config = RuntimeConfigService.getRuntimeConfig()) {
    const normalizedId = String(packageId || '').trim();
    if (!normalizedId) return null;
    const packages = Array.isArray(config.rechargePackages) ? config.rechargePackages : [];
    return packages.find(item => String(item.id || '') === normalizedId) || null;
  }

  static create({ userId, packageId }) {
    const config = RuntimeConfigService.getRuntimeConfig();
    const pkg = this.getPackageById(packageId, config);
    if (!pkg) {
      const error = new Error('充值套餐不存在或已下架');
      error.status = 404;
      throw error;
    }

    const amountCents = this.normalizeAmountCents(pkg.price);
    if (amountCents <= 0) {
      const error = new Error('充值套餐价格未配置');
      error.status = 400;
      throw error;
    }

    const type = pkg.type === 'vip' ? 'vip' : 'credits';
    const credits = type === 'credits'
      ? Math.max(1, Math.floor(Number(pkg.credits || pkg.promoCredits || 0)))
      : 0;
    const vipDays = type === 'vip'
      ? Math.max(1, Math.floor(Number(pkg.vipDays || pkg.vip_days || pkg.days || 30)))
      : 0;

    if (type === 'credits' && credits <= 0) {
      const error = new Error('积分套餐额度未配置');
      error.status = 400;
      throw error;
    }

    let orderNo = this.makeOrderNo();
    while (this.findByOrderNo(orderNo)) {
      orderNo = this.makeOrderNo();
    }

    db.prepare(`
      INSERT INTO payment_orders (
        order_no,
        user_id,
        provider,
        package_id,
        package_type,
        package_title,
        credits,
        vip_days,
        amount_cents,
        currency,
        status
      )
      VALUES (?, ?, 'alipay', ?, ?, ?, ?, ?, ?, 'CNY', 'pending')
    `).run(
      orderNo,
      userId,
      String(pkg.id),
      type,
      String(pkg.title || (type === 'vip' ? '开通 VIP' : `${credits} 积分`)).slice(0, 128),
      credits,
      vipDays,
      amountCents
    );

    return this.findByOrderNo(orderNo);
  }

  static markPaid({ orderNo, tradeNo = '', buyerId = '', amountCents = 0, payload = {} }) {
    const order = this.findByOrderNo(orderNo);
    if (!order) {
      const error = new Error('支付订单不存在');
      error.status = 404;
      throw error;
    }

    if (order.status === 'paid') {
      return { order, changed: false };
    }

    if (Number(order.amount_cents || 0) !== Number(amountCents || 0)) {
      const error = new Error('支付宝通知金额与本地订单不一致');
      error.status = 400;
      throw error;
    }

    const tx = db.transaction(() => {
      const result = db.prepare(`
        UPDATE payment_orders
        SET status = 'paid',
            alipay_trade_no = ?,
            buyer_id = ?,
            notify_payload = ?,
            paid_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE order_no = ? AND status != 'paid'
      `).run(
        String(tradeNo || ''),
        String(buyerId || ''),
        JSON.stringify(payload || {}),
        order.order_no
      );

      if (result.changes > 0) {
        if (order.package_type === 'vip') {
          User.activateVip(order.user_id, order.vip_days || 30);
        } else {
          User.addCredits(order.user_id, order.credits, {
            source: 'alipay_recharge',
            note: `支付宝充值：${order.package_title}`
          });
        }
      }

      return this.findByOrderNo(order.order_no);
    });

    return { order: tx(), changed: true };
  }

  static markClosed(orderNo, payload = {}) {
    const order = this.findByOrderNo(orderNo);
    if (!order || order.status === 'paid') return order;
    db.prepare(`
      UPDATE payment_orders
      SET status = 'closed',
          notify_payload = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE order_no = ? AND status = 'pending'
    `).run(JSON.stringify(payload || {}), orderNo);
    return this.findByOrderNo(orderNo);
  }
}

module.exports = PaymentOrder;
