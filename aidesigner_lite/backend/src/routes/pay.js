const express = require('express');
const { auth } = require('../middleware/auth');
const RuntimeConfigService = require('../services/runtimeConfigService');
const AlipayService = require('../services/alipayService');
const PaymentOrder = require('../models/PaymentOrder');
const User = require('../models/User');

const router = express.Router();

function parseAlipayAmountCents(value) {
  const amount = Number(String(value || '').trim());
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100);
}

router.post('/alipay/create', auth, (req, res) => {
  try {
    const packageId = String(req.body?.package_id || req.body?.packageId || '').trim();
    const client = String(req.body?.client || '').trim() || 'page';
    if (!packageId) {
      return res.status(400).json({ error: '请选择充值套餐' });
    }

    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    AlipayService.ensureReady(runtimeConfig);
    const order = PaymentOrder.create({ userId: req.userId, packageId });
    const payUrl = AlipayService.buildPaymentUrl({
      order,
      client,
      config: runtimeConfig
    });

    res.json({
      order: PaymentOrder.publicFields(order),
      pay_url: payUrl
    });
  } catch (error) {
    console.error('创建支付宝订单错误:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : '创建支付订单失败' });
  }
});

router.get('/orders/:orderNo', auth, (req, res) => {
  try {
    const order = PaymentOrder.findUserOrder(req.userId, req.params.orderNo);
    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }
    res.json({ order: PaymentOrder.publicFields(order) });
  } catch (error) {
    console.error('获取支付订单错误:', error);
    res.status(500).json({ error: '获取支付订单失败' });
  }
});

router.get('/orders', auth, (req, res) => {
  try {
    const orders = PaymentOrder.recentForUser(req.userId, req.query.limit || 20)
      .map(order => PaymentOrder.publicFields(order));
    res.json({ orders });
  } catch (error) {
    console.error('获取支付订单列表错误:', error);
    res.status(500).json({ error: '获取支付订单列表失败' });
  }
});

router.post('/alipay/notify', (req, res) => {
  try {
    const payload = req.body || {};
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const alipay = AlipayService.ensureReady(runtimeConfig);
    const verified = AlipayService.verify(payload, alipay.publicKey);

    if (!verified) {
      console.warn('[Alipay] 异步通知验签失败:', payload.out_trade_no || '');
      return res.type('text/plain').send('failure');
    }

    const tradeStatus = String(payload.trade_status || '');
    const orderNo = String(payload.out_trade_no || '').trim();
    const tradeNo = String(payload.trade_no || '').trim();
    const buyerId = String(payload.buyer_id || payload.buyer_user_id || '').trim();
    const amountCents = parseAlipayAmountCents(payload.total_amount || payload.receipt_amount);

    if (!orderNo) {
      return res.type('text/plain').send('failure');
    }

    if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
      PaymentOrder.markPaid({
        orderNo,
        tradeNo,
        buyerId,
        amountCents,
        payload
      });
      return res.type('text/plain').send('success');
    }

    if (tradeStatus === 'TRADE_CLOSED') {
      PaymentOrder.markClosed(orderNo, payload);
      return res.type('text/plain').send('success');
    }

    return res.type('text/plain').send('success');
  } catch (error) {
    console.error('支付宝异步通知处理错误:', error);
    return res.type('text/plain').send('failure');
  }
});

router.get('/alipay/return', auth, (req, res) => {
  try {
    const order = PaymentOrder.findUserOrder(req.userId, req.query.out_trade_no || req.query.pay_order || '');
    res.json({
      order: PaymentOrder.publicFields(order),
      quota: User.getQuota(req.userId)
    });
  } catch (error) {
    console.error('支付宝返回查询错误:', error);
    res.status(500).json({ error: '查询支付结果失败' });
  }
});

module.exports = router;
