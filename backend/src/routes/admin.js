const express = require('express');
const bcrypt = require('bcryptjs');
const { one, many, query } = require('../db');
const { auth, requireAdmin, requireRoot } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// ===== 用户管理 =====
router.get('/users', requireAdmin, async (_req, res, next) => {
  try {
    const users = await many('SELECT * FROM users ORDER BY id');
    res.json({
      status: 200,
      data: {
        users: users.map(u => ({
          id: u.id, username: u.username, role: u.role,
          quota: u.quota_bytes, used: u.used_bytes,
          ojProviderId: u.oj_provider_id, ojUsername: u.oj_username,
          hasPassword: !!u.password_hash,
        })),
      },
    });
  } catch (e) { next(e); }
});

router.post('/users', requireAdmin, async (req, res, next) => {
  try {
    const { username, password, role = 'user', quotaMB } = req.body || {};
    if (!username || !password) return res.status(400).json({ status: 400, msg: '缺少参数' });
    const hash = bcrypt.hashSync(password, 10);
    const quota = (parseInt(quotaMB, 10) || 1024) * 1024 * 1024;
    const r = await query(
      `INSERT INTO users (username,password_hash,role,quota_bytes,used_bytes,created_at)
       VALUES ($1,$2,$3,$4,0,$5) RETURNING id`,
      [username, hash, role, quota, Date.now()]
    );
    res.json({ status: 200, data: { id: r.rows[0].id } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ status: 409, msg: '用户名已存在' });
    next(e);
  }
});

router.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { role, quotaMB, password } = req.body || {};
    const fields = [];
    const vals = [];
    let i = 1;
    if (role) { fields.push(`role=$${i++}`); vals.push(role); }
    if (quotaMB != null) { fields.push(`quota_bytes=$${i++}`); vals.push(parseInt(quotaMB, 10) * 1024 * 1024); }
    if (password) { fields.push(`password_hash=$${i++}`); vals.push(bcrypt.hashSync(password, 10)); }
    if (!fields.length) return res.status(400).json({ status: 400, msg: '无可更新字段' });
    vals.push(id);
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id=$${i}`, vals);
    res.json({ status: 200, msg: '已更新' });
  } catch (e) { next(e); }
});

router.delete('/users/:id', requireRoot, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) return res.status(400).json({ status: 400, msg: '不能删除自己' });
    await query('DELETE FROM users WHERE id=$1', [id]);
    res.json({ status: 200, msg: '已删除' });
  } catch (e) { next(e); }
});

// ===== OJ 提供方 =====
router.get('/providers', requireAdmin, async (_req, res, next) => {
  try {
    const rows = await many('SELECT * FROM oj_providers ORDER BY id');
    res.json({ status: 200, data: { providers: rows } });
  } catch (e) { next(e); }
});

router.post('/providers', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.base_url) return res.status(400).json({ status: 400, msg: 'name 与 base_url 必填' });
    const r = await query(
      `INSERT INTO oj_providers
       (name,base_url,login_path,home_info_path,upload_path,token_json_path,
        upload_username,upload_password,upload_gid,enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        b.name, b.base_url,
        b.login_path || '/api/login',
        b.home_info_path || '/api/get-user-home-info',
        b.upload_path || '/api/file/upload-md-file',
        b.token_json_path || 'data.token',
        b.upload_username || null,
        b.upload_password || null,
        b.upload_gid != null ? String(b.upload_gid) : null,
        b.enabled !== false,
      ]
    );
    res.json({ status: 200, data: { id: r.rows[0].id } });
  } catch (e) { next(e); }
});

router.patch('/providers/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['name', 'base_url', 'login_path', 'home_info_path',
      'upload_path', 'token_json_path', 'upload_username', 'upload_password',
      'upload_gid', 'enabled'];
    const fields = [], vals = [];
    let i = 1;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        fields.push(`${k}=$${i++}`);
        vals.push(req.body[k] === null ? null : (k === 'enabled' ? !!req.body[k] : req.body[k]));
      }
    }
    if (!fields.length) return res.status(400).json({ status: 400, msg: '无可更新字段' });
    vals.push(id);
    await query(`UPDATE oj_providers SET ${fields.join(', ')} WHERE id=$${i}`, vals);
    res.json({ status: 200, msg: '已更新' });
  } catch (e) { next(e); }
});

router.delete('/providers/:id', requireRoot, async (req, res, next) => {
  try {
    await query('DELETE FROM oj_providers WHERE id=$1', [parseInt(req.params.id, 10)]);
    res.json({ status: 200, msg: '已删除' });
  } catch (e) { next(e); }
});

// ===== 统计 =====
router.get('/stats', requireAdmin, async (_req, res, next) => {
  try {
    const users  = await one('SELECT COUNT(*)::int c, COALESCE(SUM(used_bytes),0)::bigint s FROM users');
    const files  = await one('SELECT COUNT(*)::int c FROM files WHERE is_dir=FALSE');
    const shares = await one('SELECT COUNT(*)::int c FROM shares');
    res.json({
      status: 200,
      data: { users: users.c, usedBytes: Number(users.s), files: files.c, shares: shares.c },
    });
  } catch (e) { next(e); }
});

module.exports = router;
