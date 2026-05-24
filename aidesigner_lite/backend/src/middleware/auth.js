const jwt = require('jsonwebtoken');
const User = require('../models/User');
const appConfig = require('../config/appConfig');

const JWT_SECRET = appConfig.jwtSecret();

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '未授权，请先登录' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = User.refreshVipStatus(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }

    req.user = user;
    req.userId = user.id;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    return res.status(401).json({ error: '无效的令牌' });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = User.refreshVipStatus(decoded.userId);
      if (user) {
        req.user = user;
        req.userId = user.id;
      }
    }
    next();
  } catch (error) {
    next();
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
};

const requireVip = (req, res, next) => {
  if (!User.hasUnlimitedStorage(req.user)) {
    return res.status(403).json({ error: '需要VIP会员权限' });
  }
  next();
};

module.exports = { auth, optionalAuth, requireAdmin, requireVip };
