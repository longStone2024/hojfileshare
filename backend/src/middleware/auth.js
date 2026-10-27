const { one } = require('../db');

async function auth(req, res, next) {
  try {
    let token = req.headers.authorization || '';
    token = token.replace(/^Bearer\s+/i, '').trim();
    if (!token && typeof req.query.token === 'string') token = req.query.token;
    if (!token) return res.status(401).json({ status: 401, msg: '未登录' });

    const session = await one('SELECT * FROM sessions WHERE token=$1', [token]);
    if (!session) return res.status(401).json({ status: 401, msg: '会话无效' });
    if (session.expires_at < Date.now()) {
      await one('DELETE FROM sessions WHERE token=$1 RETURNING token', [token]);
      return res.status(401).json({ status: 401, msg: '会话已过期' });
    }
    const user = await one('SELECT * FROM users WHERE id=$1', [session.user_id]);
    if (!user) return res.status(401).json({ status: 401, msg: '用户不存在' });
    req.user = user;
    req.token = token;
    next();
  } catch (e) { next(e); }
}

function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'root')) {
    return res.status(403).json({ status: 403, msg: '需要管理员权限' });
  }
  next();
}
function requireRoot(req, res, next) {
  if (!req.user || req.user.role !== 'root') {
    return res.status(403).json({ status: 403, msg: '需要 root 权限' });
  }
  next();
}

module.exports = { auth, requireAdmin, requireRoot };