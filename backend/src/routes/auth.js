const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { one, many, query } = require('../db');
const config = require('../config');
const { auth } = require('../middleware/auth');
const { fetchHomeInfo } = require('../services/oj');

const router = express.Router();

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await query(
    'INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)',
    [token, userId, now, now + config.sessionTTL]
  );
  return token;
}

const safeUser = (u) => ({
  id: u.id, username: u.username, role: u.role,
  quota: u.quota_bytes, used: u.used_bytes,
  ojProviderId: u.oj_provider_id, ojUsername: u.oj_username,
  storageProviderIds: Array.isArray(u.storage_provider_ids)
    ? u.storage_provider_ids
    : (u.storage_provider_ids != null ? [u.storage_provider_ids] : (u.oj_provider_id != null ? [u.oj_provider_id] : null)),
  hasPassword: !!u.password_hash,
});

// ===== 密码登录 =====
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ status: 400, msg: '缺少参数' });
    const user = await one('SELECT * FROM users WHERE username=$1', [username]);
    if (!user) return res.status(401).json({ status: 401, msg: '用户名或密码错误' });
    if (!user.password_hash) {
      return res.status(403).json({
        status: 403,
        msg: '该账号尚未设置密码，请先通过 OJ 签名登录一次并设置密码',
        needOjLogin: true,
      });
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ status: 401, msg: '用户名或密码错误' });
    }
    const token = await createSession(user.id);
    res.json({ status: 200, data: { token, user: safeUser(user), needsPassword: false } });
  } catch (e) { next(e); }
});

router.get('/me', auth, (req, res) => {
  res.json({
    status: 200,
    data: {
      user: safeUser(req.user),
      needsPassword: !req.user.password_hash,
    },
  });
});

router.post('/logout', auth, async (req, res, next) => {
  try {
    await query('DELETE FROM sessions WHERE token=$1', [req.token]);
    res.json({ status: 200, msg: '已退出' });
  } catch (e) { next(e); }
});

// ===== 用户名可用性检查 =====
router.get('/check-username', async (req, res, next) => {
  try {
    const username = String(req.query.username || '').trim();
    if (!username) return res.status(400).json({ status: 400, msg: '缺少用户名' });
    if (username.length < 2 || username.length > 32) {
      return res.json({ status: 200, data: { available: false, reason: '长度需在 2-32 之间' } });
    }
    if (!/^[\w\u4e00-\u9fa5.-]+$/.test(username)) {
      return res.json({ status: 200, data: { available: false, reason: '只允许字母数字下划线中文及 .-' } });
    }
    const existing = await one('SELECT id FROM users WHERE username=$1', [username]);
    if (existing) return res.json({ status: 200, data: { available: false, reason: '已被占用' } });
    res.json({ status: 200, data: { available: true } });
  } catch (e) { next(e); }
});

// ===== OJ 列表 =====
router.get('/providers', async (_req, res, next) => {
  try {
    const rows = await many('SELECT id,name,base_url FROM oj_providers WHERE enabled=TRUE ORDER BY sort_order, id');
    res.json({ status: 200, data: { providers: rows.map(r => ({ id: r.id, name: r.name, baseUrl: r.base_url })) } });
  } catch (e) { next(e); }
});

// ===== OJ 注册第一步：发起挑战 =====
router.post('/oj/challenge', async (req, res, next) => {
  try {
    const { providerId, username, desiredUsername } = req.body || {};
    if (!username) return res.status(400).json({ status: 400, msg: '缺少 OJ 用户名' });
    const p = await one('SELECT * FROM oj_providers WHERE id=$1 AND enabled=TRUE', [providerId]);
    if (!p) return res.status(404).json({ status: 404, msg: 'OJ 提供方不存在或未启用' });

    const existingUser = await one(
      'SELECT id FROM users WHERE oj_provider_id=$1 AND oj_username=$2',
      [p.id, username]
    );
    const isNew = !existingUser;

    let cleanDesired = null;
    if (isNew && desiredUsername) {
      cleanDesired = String(desiredUsername).trim();
      if (cleanDesired.length < 2 || cleanDesired.length > 32) {
        return res.status(400).json({ status: 400, msg: '云盘用户名长度需在 2-32 之间' });
      }
      if (!/^[\w\u4e00-\u9fa5.-]+$/.test(cleanDesired)) {
        return res.status(400).json({ status: 400, msg: '云盘用户名包含非法字符' });
      }
      const conflict = await one('SELECT id FROM users WHERE username=$1', [cleanDesired]);
      if (conflict) {
        return res.status(409).json({ status: 409, msg: '该云盘用户名已被占用，请换一个' });
      }
    } else if (isNew && !desiredUsername) {
      // 未指定则默认用 OJ 用户名，这里先做冲突预检
      const conflict = await one('SELECT id FROM users WHERE username=$1', [String(username)]);
      if (conflict) {
        return res.status(409).json({
          status: 409,
          msg: `"${username}" 已被其他用户占用，请指定一个不同的云盘用户名再试`,
        });
      }
    }

    const uuid = crypto.randomUUID();
    const now = Date.now();
    await query(
      `INSERT INTO login_challenges
        (uuid, oj_provider_id, oj_username, desired_username, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid, p.id, username, cleanDesired, now, now + config.challengeTTL]
    );

    res.json({
      status: 200,
      data: {
        uuid,
        providerId: p.id,
        providerName: p.name,
        isNew,
        expiresIn: 300,
        suggestedUsername: isNew ? (cleanDesired || username) : null,
        instruction: isNew
          ? '首次登录：请在 5 分钟内把这串 UUID 放到该 OJ 主页签名最前面，验证通过后会引导你设置密码。'
          : '请在 5 分钟内把这串 UUID 放到该 OJ 主页签名最前面，然后点击验证。',
      },
    });
  } catch (e) { next(e); }
});

// ===== OJ 注册第二步：验证 =====
router.post('/oj/verify', async (req, res, next) => {
  try {
    const { uuid } = req.body || {};
    if (!uuid) return res.status(400).json({ status: 400, msg: '缺少 uuid' });

    const ch = await one('SELECT * FROM login_challenges WHERE uuid=$1', [uuid]);
    if (!ch) return res.status(404).json({ status: 404, msg: '挑战不存在' });
    if (ch.expires_at < Date.now()) {
      await query('DELETE FROM login_challenges WHERE uuid=$1', [uuid]);
      return res.status(410).json({ status: 410, msg: '挑战已过期，请重新发起' });
    }
    const p = await one('SELECT * FROM oj_providers WHERE id=$1 AND enabled=TRUE', [ch.oj_provider_id]);
    if (!p) return res.status(404).json({ status: 404, msg: 'OJ 提供方已失效' });

    const info = await fetchHomeInfo(p, ch.oj_username);
    const signature = (info && info.data && info.data.signature) || '';
    if (!signature.trimStart().startsWith(uuid)) {
      return res.status(403).json({ status: 403, msg: '签名前缀不匹配，请确认已保存' });
    }

    let user = await one(
      'SELECT * FROM users WHERE oj_provider_id=$1 AND oj_username=$2',
      [p.id, ch.oj_username]
    );
    let needsPassword = false;

    if (!user) {
      const username = ch.desired_username || String(ch.oj_username);
      const conflict = await one('SELECT id FROM users WHERE username=$1', [username]);
      if (conflict) {
        return res.status(409).json({
          status: 409,
          msg: `用户名"${username}"已被占用。请重新发起并指定一个不同的云盘用户名。`,
          retry: true,
        });
      }
      const r = await query(
        `INSERT INTO users (username, password_hash, role, quota_bytes, used_bytes, oj_provider_id, oj_username, storage_provider_ids, created_at)
         VALUES ($1, NULL, 'user', $2, 0, $3, $4, $5, $6) RETURNING *`,
        [username, config.defaultQuotaBytes, p.id, ch.oj_username, [p.id], Date.now()]
      );
      user = r.rows[0];
      needsPassword = true;
    } else {
      needsPassword = !user.password_hash;
    }

    await query('DELETE FROM login_challenges WHERE uuid=$1', [uuid]);
    const token = await createSession(user.id);
    res.json({
      status: 200,
      data: { token, user: safeUser(user), needsPassword },
    });
  } catch (e) { next(e); }
});

// ===== 设置/修改密码 =====
router.post('/set-password', auth, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || password.length < 6) {
      return res.status(400).json({ status: 400, msg: '密码至少 6 位' });
    }
    const hash = bcrypt.hashSync(password, 10);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ status: 200, msg: '密码已设置' });
  } catch (e) { next(e); }
});

module.exports = { router };