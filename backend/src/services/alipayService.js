const crypto = require('crypto');
const RuntimeConfigService = require('./runtimeConfigService');

class AlipayService {
  static methodForClient(client = '') {
    return String(client || '').toLowerCase() === 'wap'
      ? 'alipay.trade.wap.pay'
      : 'alipay.trade.page.pay';
  }

  static ensureReady(config = RuntimeConfigService.getRuntimeConfig()) {
    const alipay = config.alipay || {};
    if (!alipay.enabled) {
      const error = new Error('支付宝充值暂未开启');
      error.status = 503;
      throw error;
    }
    if (!alipay.appId || !alipay.appPrivateKey || !alipay.publicKey) {
      const error = new Error('支付宝配置不完整，请先在后台配置 App ID、应用私钥和支付宝公钥');
      error.status = 503;
      throw error;
    }
    if (!alipay.notifyUrl) {
      const error = new Error('支付宝异步通知地址未配置，请先填写网站公网地址或通知地址');
      error.status = 503;
      throw error;
    }
    return alipay;
  }

  static normalizePrivateKey(key = '') {
    const value = String(key || '').trim();
    if (!value) return '';
    if (value.includes('BEGIN')) return value.replace(/\\n/g, '\n');
    const body = value.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') || value;
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  }

  static normalizePublicKey(key = '') {
    const value = String(key || '').trim();
    if (!value) return '';
    if (value.includes('BEGIN')) return value.replace(/\\n/g, '\n');
    const body = value.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') || value;
    return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
  }

  static formatAmount(cents) {
    const safeCents = Math.max(1, parseInt(cents, 10) || 0);
    return (safeCents / 100).toFixed(2);
  }

  static timestamp(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return [
      date.getFullYear(),
      '-',
      pad(date.getMonth() + 1),
      '-',
      pad(date.getDate()),
      ' ',
      pad(date.getHours()),
      ':',
      pad(date.getMinutes()),
      ':',
      pad(date.getSeconds())
    ].join('');
  }

  static signingContent(params = {}, { includeSignType = false } = {}) {
    return Object.entries(params)
      .filter(([key, value]) => {
        if (key === 'sign') return false;
        if (!includeSignType && key === 'sign_type') return false;
        return value !== undefined && value !== null && String(value) !== '';
      })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('&');
  }

  static sign(params, privateKey) {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(this.signingContent(params, { includeSignType: true }), 'utf8');
    return signer.sign(this.normalizePrivateKey(privateKey), 'base64');
  }

  static verify(params, publicKey) {
    const sign = params.sign;
    if (!sign) return false;
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(this.signingContent(params), 'utf8');
    return verifier.verify(this.normalizePublicKey(publicKey), sign, 'base64');
  }

  static buildPaymentParams({ order, client = 'page', config = RuntimeConfigService.getRuntimeConfig() }) {
    const alipay = this.ensureReady(config);
    const method = this.methodForClient(client);
    const bizContent = {
      out_trade_no: order.order_no,
      total_amount: this.formatAmount(order.amount_cents),
      subject: order.package_title,
      product_code: method === 'alipay.trade.wap.pay'
        ? 'QUICK_WAP_WAY'
        : 'FAST_INSTANT_TRADE_PAY'
    };
    const params = {
      app_id: alipay.appId,
      method,
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: this.timestamp(),
      version: '1.0',
      notify_url: alipay.notifyUrl,
      biz_content: JSON.stringify(bizContent)
    };

    if (alipay.returnUrl) {
      params.return_url = this.buildReturnUrl(alipay.returnUrl, order.order_no);
    }

    params.sign = this.sign(params, alipay.appPrivateKey);
    return params;
  }

  static buildPaymentUrl(options) {
    const config = options.config || RuntimeConfigService.getRuntimeConfig();
    const alipay = this.ensureReady(config);
    const params = this.buildPaymentParams({ ...options, config });
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value) !== '') {
        search.append(key, String(value));
      }
    });
    return `${alipay.gateway}?${search.toString()}`;
  }

  static buildReturnUrl(returnUrl, orderNo) {
    const raw = String(returnUrl || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      url.searchParams.set('pay_order', orderNo);
      return url.toString();
    } catch (error) {
      return raw;
    }
  }
}

module.exports = AlipayService;
