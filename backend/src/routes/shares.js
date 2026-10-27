const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { one, many, query } = require('../db');
const { auth } = require('../middleware/auth');

const privateRouter = express.Router();
privateRouter.use(auth);

function genCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[bytes[i] % chars.length];
  return s;
}

privateRouter.post('/', async (req, res, next) => {
  try {
    const { fileId, expiresIn, maxDownloads, password } = req.body || {};
    const file = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2', [fileId, req.user.id]);
    if (!file) return res.status(404).json({ status: 404, msg: '文件不存在' });
    if (file.is_dir) return res.status(400).json({ status: 400, msg: '暂不支持分享文件夹' });

    let code;
    for (let i = 0; i < 10; i++) {
      const c = genCode();
      if (!(await one('SELECT 1 FROM shares WHERE code=$1', [c]))) { code = c; break; }
    }
    if (!code) throw new Error('短码生成失败');

    const now = Date.now();
    const expiresAt = expiresIn ? now + parseInt(expiresIn, 10) * 1000 : null;
    const pwHash = password ? bcrypt.hashSync(String(password), 10) : null;

    await query(
      `INSERT INTO shares (code,user_id,file_id,password_hash,expires_at,max_downloads,download_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [code, req.user.id, file.id, pwHash, expiresAt,
       maxDownloads ? parseInt(maxDownloads, 10) : null, 0, now]
    );

    res.json({
      status: 200,
      data: { code, url: `/s/${code}`, expiresAt, maxDownloads: maxDownloads || null, hasPassword: !!pwHash },
    });
  } catch (e) { next(e); }
});

privateRouter.get('/', async (req, res, next) => {
  try {
    const rows = await many(`
      SELECT s.*, f.name AS file_name, f.size AS file_size
      FROM shares s JOIN files f ON f.id=s.file_id
      WHERE s.user_id=$1 ORDER BY s.created_at DESC
    `, [req.user.id]);
    res.json({
      status: 200,
      data: {
        shares: rows.map(r => ({
          code: r.code, fileId: r.file_id, fileName: r.file_name, fileSize: r.file_size,
          expiresAt: r.expires_at, maxDownloads: r.max_downloads,
          downloadCount: r.download_count, hasPassword: !!r.password_hash,
          createdAt: r.created_at, url: `/s/${r.code}`,
        })),
      },
    });
  } catch (e) { next(e); }
});

privateRouter.delete('/:code', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM shares WHERE code=$1 AND user_id=$2 RETURNING code',
      [req.params.code, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ status: 404, msg: '分享不存在' });
    res.json({ status: 200, msg: '已取消分享' });
  } catch (e) { next(e); }
});

// ===== 公开访问 =====
const publicRouter = express.Router();

async function loadShare(code) {
  return one(`
    SELECT s.*, f.name, f.size, f.is_dir, f.storage_url, f.mime_type
    FROM shares s JOIN files f ON f.id=s.file_id WHERE s.code=$1
  `, [code]);
}

function checkShare(share, password) {
  if (!share) return { ok: false, status: 404, msg: '分享不存在' };
  if (share.expires_at && share.expires_at < Date.now()) return { ok: false, status: 410, msg: '分享已过期' };
  if (share.max_downloads != null && share.download_count >= share.max_downloads) {
    return { ok: false, status: 410, msg: '下载次数已达上限' };
  }
  if (share.password_hash) {
    if (!password || !bcrypt.compareSync(String(password), share.password_hash)) {
      return { ok: false, status: 401, msg: '需要密码' };
    }
  }
  return { ok: true };
}

publicRouter.get('/:code', async (req, res, next) => {
  try {
    const share = await loadShare(req.params.code);
    const c = checkShare(share, req.query.password);
    if (!c.ok) return res.status(c.status).json({ status: c.status, msg: c.msg });
    res.json({
      status: 200,
      data: {
        name: share.name, size: share.size, mimeType: share.mime_type,
        expiresAt: share.expires_at,
        remainingDownloads: share.max_downloads != null ? share.max_downloads - share.download_count : null,
        downloadUrl: `/api/share/${share.code}/download`,
        hasPassword: !!share.password_hash,
      },
    });
  } catch (e) { next(e); }
});

publicRouter.get('/:code/download', async (req, res, next) => {
  try {
    const share = await loadShare(req.params.code);
    const c = checkShare(share, req.query.password);
    if (!c.ok) return res.status(c.status).send(c.msg);
    if (!share.storage_url) return res.status(404).send('文件内容不存在');
    await query('UPDATE shares SET download_count = download_count + 1 WHERE id=$1', [share.id]);
    res.redirect(302, share.storage_url);
  } catch (e) { next(e); }
});

module.exports = { privateRouter, publicRouter };