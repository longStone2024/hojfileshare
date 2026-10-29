const express = require('express');
const bcrypt = require('bcryptjs');
const { one, many, query } = require('../db');
const { auth, requireAdmin, requireRoot } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function normalizeStorageProviderIds(value) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const n = Number.parseInt(item, 10);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }
  return result;
}

function normalizeSiteRow(row) {
  return {
    id: row?.id ?? 1,
    siteName: row?.site_name || '云盘',
    siteDescription: row?.site_description || '',
    siteFooter: row?.site_footer || '',
    updatedAt: row?.updated_at || 0,
  };
}

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
         storageProviderIds: u.storage_provider_ids || null,
         hasPassword: !!u.password_hash,
       })),
      },
    });
  } catch (e) { next(e); }
});

router.post('/users', requireAdmin, async (req, res, next) => {
  try {
    const { username, password, role = 'user', quotaMB, storageProviderIds, storage_provider_ids } = req.body || {};
    if (!username || !password) return res.status(400).json({ status: 400, msg: '缺少参数' });
    const hash = bcrypt.hashSync(password, 10);
    const quota = (parseInt(quotaMB, 10) || 1024) * 1024 * 1024;
    const ids = normalizeStorageProviderIds(storageProviderIds ?? storage_provider_ids ?? null);
    const r = await query(
      `INSERT INTO users (username,password_hash,role,quota_bytes,used_bytes,storage_provider_ids,created_at)
       VALUES ($1,$2,$3,$4,0,$5,$6) RETURNING id`,
      [username, hash, role, quota, ids.length ? ids : null, Date.now()]
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
    const target = await one('SELECT * FROM users WHERE id=$1', [id]);
    if (!target) return res.status(404).json({ status: 404, msg: '用户不存在' });

    const { role, quotaMB, password, storageProviderIds, storage_provider_ids } = req.body || {};
    const fields = [];
    const vals = [];
    let i = 1;

    if (role) {
      fields.push(`role=$${i++}`);
      vals.push(role);
    }
    if (quotaMB != null) {
      fields.push(`quota_bytes=$${i++}`);
      vals.push(parseInt(quotaMB, 10) * 1024 * 1024);
    }
    if (password) {
      fields.push(`password_hash=$${i++}`);
      vals.push(bcrypt.hashSync(password, 10));
    }
    if (storageProviderIds !== undefined || storage_provider_ids !== undefined) {
      const ids = normalizeStorageProviderIds(storageProviderIds ?? storage_provider_ids ?? null);
      const normalized = ids.length ? ids : null;
      fields.push(`storage_provider_ids=$${i++}`);
      vals.push(normalized);
    }
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

router.post('/users/:id/recalc-used', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const user = await one('SELECT * FROM users WHERE id=$1', [id]);
    if (!user) return res.status(404).json({ status: 404, msg: '用户不存在' });
    const row = await one(
      `SELECT COALESCE(SUM(CASE WHEN is_dir = FALSE AND deleted_at IS NULL THEN size ELSE 0 END), 0)::bigint AS total
       FROM files WHERE user_id=$1`,
      [id]
    );
    const total = Number(row?.total || 0);
    await query('UPDATE users SET used_bytes=$1 WHERE id=$2', [total, id]);
    res.json({ status: 200, data: { used: total } });
  } catch (e) { next(e); }
});

// ===== OJ 提供方 =====
router.get('/providers', requireAdmin, async (_req, res, next) => {
  try {
    const rows = await many('SELECT * FROM oj_providers ORDER BY sort_order, id');
    res.json({ status: 200, data: { providers: rows } });
  } catch (e) { next(e); }
});

router.post('/providers', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.base_url) return res.status(400).json({ status: 400, msg: 'name 与 base_url 必填' });
    const nextSort = Number.isInteger(parseInt(b.sort_order, 10))
      ? parseInt(b.sort_order, 10)
      : (await one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM oj_providers')).next_sort;
    const r = await query(
      `INSERT INTO oj_providers
       (name,base_url,login_path,home_info_path,upload_path,token_json_path,
        upload_username,upload_password,upload_gid,sort_order,enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
       b.name, b.base_url,
       b.login_path || '/api/login',
       b.home_info_path || '/api/get-user-home-info',
       b.upload_path || '/api/file/upload-md-file',
       b.token_json_path || 'data.token',
       b.upload_username || null,
       b.upload_password || null,
       b.upload_gid != null ? String(b.upload_gid) : null,
       nextSort,
       b.enabled !== false,
      ]
    );
    res.json({ status: 200, data: { id: r.rows[0].id } });
  } catch (e) { next(e); }
});

router.post('/providers/reorder', requireAdmin, async (req, res, next) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    const ids = order.map(v => parseInt(v, 10)).filter(v => Number.isInteger(v) && v > 0);
    if (!ids.length) return res.status(400).json({ status: 400, msg: '缺少排序列表' });
    const rows = await many('SELECT id FROM oj_providers WHERE id = ANY($1::int[])', [ids]);
    if (rows.length !== ids.length) {
      return res.status(400).json({ status: 400, msg: '存在无效的 OJ 提供方' });
    }
    for (const [index, id] of ids.entries()) {
      await query('UPDATE oj_providers SET sort_order=$1 WHERE id=$2', [index, id]);
    }
    res.json({ status: 200, msg: '已更新顺序' });
  } catch (e) { next(e); }
});

router.patch('/providers/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['name', 'base_url', 'login_path', 'home_info_path',
      'upload_path', 'token_json_path', 'upload_username', 'upload_password',
      'upload_gid', 'enabled', 'sort_order'];
    const fields = [], vals = [];
    let i = 1;
    for (const k of allowed) {
      if (k in (req.body || {})) {
       fields.push(`${k}=$${i++}`);
       const value = req.body[k];
       vals.push(value === null ? null : (k === 'enabled' ? !!value : (k === 'sort_order' ? parseInt(value, 10) : value)));
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
    const id = parseInt(req.params.id, 10);
    await query(`UPDATE users SET storage_provider_ids = CASE
      WHEN storage_provider_ids IS NULL THEN NULL
      WHEN array_length(storage_provider_ids, 1) IS NULL THEN NULL
      ELSE (SELECT array_agg(v) FROM unnest(storage_provider_ids) AS t(v) WHERE v <> $1)
    END WHERE storage_provider_ids IS NOT NULL`, [id]);
    await query('DELETE FROM oj_providers WHERE id=$1', [id]);
    res.json({ status: 200, msg: '已删除' });
  } catch (e) { next(e); }
});

// ===== 网站信息 =====
router.get('/site', requireAdmin, async (_req, res, next) => {
  try {
    let row = await one('SELECT * FROM site_settings WHERE id=1');
    if (!row) {
      await query(`INSERT INTO site_settings (site_name, site_description, site_footer, updated_at) VALUES ($1,$2,$3,$4)`, ['云盘', '', '', Date.now()]);
      row = await one('SELECT * FROM site_settings WHERE id=1');
    }
    res.json({ status: 200, data: normalizeSiteRow(row) });
  } catch (e) { next(e); }
});

router.patch('/site', requireAdmin, async (req, res, next) => {
  try {
    const { siteName, siteDescription, siteFooter } = req.body || {};
    const row = await one('SELECT * FROM site_settings WHERE id=1');
    const payload = {
      site_name: siteName != null ? String(siteName).trim() || '云盘' : (row?.site_name || '云盘'),
      site_description: siteDescription != null ? String(siteDescription) : (row?.site_description || ''),
      site_footer: siteFooter != null ? String(siteFooter) : (row?.site_footer || ''),
      updated_at: Date.now(),
    };
    if (!row) {
      await query(
       'INSERT INTO site_settings (site_name, site_description, site_footer, updated_at) VALUES ($1,$2,$3,$4)',
       [payload.site_name, payload.site_description, payload.site_footer, payload.updated_at]
      );
    } else {
      await query(
       'UPDATE site_settings SET site_name=$1, site_description=$2, site_footer=$3, updated_at=$4 WHERE id=1',
       [payload.site_name, payload.site_description, payload.site_footer, payload.updated_at]
      );
    }
    res.json({ status: 200, msg: '已保存' });
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
