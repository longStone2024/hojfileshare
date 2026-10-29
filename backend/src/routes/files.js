const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { Readable } = require('stream');
const { one, many, query, tx } = require('../db');
const config = require('../config');
const { auth } = require('../middleware/auth');
const { uploadFile, normalizeUploadFilename } = require('../services/oj');

const router = express.Router();
router.use(auth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

function decodeName(name) {
  try {
    const utf8 = Buffer.from(name, 'latin1').toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
  } catch {}
  return name;
}

function getUserAllowedProviderIds(user) {
  if (!user) return null;
  if (user.role === 'admin' || user.role === 'root') return null;
  if (Array.isArray(user.storage_provider_ids) && user.storage_provider_ids.length) {
    return user.storage_provider_ids.slice();
  }
  if (user.oj_provider_id != null) {
    return [user.oj_provider_id];
  }
  return null;
}

function needsProxyDownload(fileName) {
  if (!fileName || typeof fileName !== 'string') return false;
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return ['.js', '.mjs', '.cjs', '.css', '.scss', '.less'].includes(ext);
}

async function purgeExpiredTrashForUser(userId) {
  await query(
    'DELETE FROM files WHERE user_id=$1 AND deleted_at IS NOT NULL AND delete_expires_at IS NOT NULL AND delete_expires_at <= $2',
    [userId, Date.now()]
  );
}

async function recalcUserUsage(userId) {
  const row = await one(
    `SELECT COALESCE(SUM(CASE WHEN is_dir = FALSE AND deleted_at IS NULL THEN size ELSE 0 END), 0)::bigint AS total
     FROM files WHERE user_id=$1`,
    [userId]
  );
  const total = Number(row?.total || 0);
  await query('UPDATE users SET used_bytes=$1 WHERE id=$2', [total, userId]);
  return total;
}

const publicFile = (f) => ({
  id: f.id, name: f.name, isDir: !!f.is_dir, size: f.size, parentId: f.parent_id,
  mimeType: f.mime_type, createdAt: f.created_at, updatedAt: f.updated_at,
  downloadUrl: f.is_dir ? null : `/api/files/${f.id}/download`,
});

async function getParent(parentId, userId) {
  if (parentId === 0) return { id: 0, is_dir: true };
  const p = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [parentId, userId]);
  if (!p || !p.is_dir) return null;
  return p;
}

router.get('/', async (req, res, next) => {
  try {
    await purgeExpiredTrashForUser(req.user.id);
    const parentId = parseInt(req.query.parentId || '0', 10) || 0;
    const files = await many(
      'SELECT * FROM files WHERE user_id=$1 AND parent_id=$2 AND deleted_at IS NULL ORDER BY is_dir DESC, name ASC',
      [req.user.id, parentId]
    );
    const fresh = await one('SELECT quota_bytes, used_bytes FROM users WHERE id=$1', [req.user.id]);
    res.json({
      status: 200,
      data: {
        parentId,
        files: files.map(publicFile),
        quota: fresh.quota_bytes,
        used: fresh.used_bytes,
      },
    });
  } catch (e) { next(e); }
});

router.get('/trash', async (req, res, next) => {
  try {
    await purgeExpiredTrashForUser(req.user.id);
    const rows = await many(
      'SELECT * FROM files WHERE user_id=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, updated_at DESC',
      [req.user.id]
    );
    const items = rows.map((row) => ({
      id: row.id,
      name: row.name,
      isDir: !!row.is_dir,
      size: Number(row.size || 0),
      originalParentId: row.deleted_parent_id || 0,
      deletedAt: row.deleted_at,
      expiresAt: row.delete_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      mimeType: row.mime_type,
    }));
    res.json({ status: 200, data: { items } });
  } catch (e) { next(e); }
});

router.post('/mkdir', async (req, res, next) => {
  try {
    const { parentId = 0, name } = req.body || {};
    if (!name || /[\\/]/.test(name) || name.length > 255) {
      return res.status(400).json({ status: 400, msg: '名称非法' });
    }
    const pid = parseInt(parentId, 10) || 0;
    if (pid !== 0 && !(await getParent(pid, req.user.id))) {
      return res.status(404).json({ status: 404, msg: '父目录不存在' });
    }
    const now = Date.now();
    const r = await query(
      `INSERT INTO files (user_id,parent_id,name,is_dir,size,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, pid, name, true, 0, now, now]
    );
    res.json({ status: 200, data: { file: publicFile(r.rows[0]) } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ status: 409, msg: '同名文件/文件夹已存在' });
    next(e);
  }
});

router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ status: 400, msg: '未收到文件' });
    const parentId = parseInt(req.body.parentId || '0', 10) || 0;
    if (!(await getParent(parentId, req.user.id))) {
      return res.status(404).json({ status: 404, msg: '父目录不存在' });
    }
    const fresh = await one('SELECT quota_bytes, used_bytes, storage_provider_ids, oj_provider_id, role FROM users WHERE id=$1', [req.user.id]);
    if (fresh.used_bytes + req.file.size > fresh.quota_bytes) {
      return res.status(413).json({ status: 413, msg: '存储空间不足' });
    }

    const requestedProviderId = req.body.providerId != null ? parseInt(req.body.providerId, 10) : null;
    const allowedIds = getUserAllowedProviderIds(fresh);
    let provider = null;
    if (requestedProviderId !== null && Number.isInteger(requestedProviderId) && requestedProviderId > 0) {
      provider = await one('SELECT * FROM oj_providers WHERE id=$1 AND enabled=TRUE', [requestedProviderId]);
      if (!provider) return res.status(404).json({ status: 404, msg: '存储提供方不存在或未启用' });
      if (fresh.role !== 'admin' && fresh.role !== 'root' && allowedIds && !allowedIds.includes(requestedProviderId)) {
        return res.status(403).json({ status: 403, msg: '没有权限上传到该存储渠道' });
      }
    } else {
      const queryStr = (fresh.role === 'admin' || fresh.role === 'root') || !allowedIds || !allowedIds.length
        ? 'SELECT * FROM oj_providers WHERE enabled=TRUE ORDER BY sort_order, id LIMIT 1'
        : 'SELECT * FROM oj_providers WHERE enabled=TRUE AND id = ANY($1::int[]) ORDER BY sort_order, id LIMIT 1';
      const params = (fresh.role === 'admin' || fresh.role === 'root') || !allowedIds || !allowedIds.length ? [] : [allowedIds];
      provider = await one(queryStr, params);
    }
    if (!provider) return res.status(500).json({ status: 500, msg: '未配置可用存储提供方' });

    const originalName = decodeName(req.file.originalname || 'unnamed');
    const remoteName = normalizeUploadFilename(originalName, req.file.mimetype);
    const { fullUrl } = await uploadFile(provider, req.file.buffer, remoteName, req.file.mimetype);

    let name = originalName, n = 0;
    const dot = originalName.lastIndexOf('.');
    while (await one('SELECT 1 FROM files WHERE user_id=$1 AND parent_id=$2 AND name=$3',
      [req.user.id, parentId, name])) {
      n++;
      name = dot > 0
        ? `${originalName.slice(0, dot)} (${n})${originalName.slice(dot)}`
        : `${originalName} (${n})`;
    }

    const now = Date.now();
    const r = await query(
      `INSERT INTO files
       (user_id,parent_id,name,is_dir,size,storage_url,storage_provider_id,mime_type,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, parentId, name, false, req.file.size, fullUrl, provider.id,
       req.file.mimetype || 'application/octet-stream', now, now]
    );
    await recalcUserUsage(req.user.id);

    res.json({ status: 200, data: { file: publicFile(r.rows[0]) } });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name } = req.body || {};
    if (!name || /[\\/]/.test(name) || name.length > 255) {
      return res.status(400).json({ status: 400, msg: '名称非法' });
    }
    const file = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [id, req.user.id]);
    if (!file) return res.status(404).json({ status: 404, msg: '文件不存在' });
    const r = await query(
      'UPDATE files SET name=$1, updated_at=$2 WHERE id=$3 RETURNING *',
      [name, Date.now(), id]
    );
    res.json({ status: 200, data: { file: publicFile(r.rows[0]) } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ status: 409, msg: '同名文件/文件夹已存在' });
    next(e);
  }
});

router.post('/:id/restore', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const targetParentId = parseInt(req.body?.parentId ?? '0', 10) || 0;
    const file = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL', [id, req.user.id]);
    if (!file) return res.status(404).json({ status: 404, msg: '文件不存在于回收站' });

    const restoreTo = targetParentId === 0 ? (file.deleted_parent_id || 0) : targetParentId;
    if (restoreTo !== 0) {
      const parent = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [restoreTo, req.user.id]);
      if (!parent || !parent.is_dir) {
        return res.status(404).json({ status: 404, msg: '恢复目标目录不存在' });
      }
    }

    const conflict = await one(
      'SELECT 1 FROM files WHERE user_id=$1 AND parent_id=$2 AND name=$3 AND id != $4 AND deleted_at IS NULL',
      [req.user.id, restoreTo, file.name, id]
    );
    if (conflict) {
      return res.status(409).json({ status: 409, msg: '目标目录下已存在同名文件/文件夹' });
    }

    const now = Date.now();
    const items = await many(
      `WITH RECURSIVE sub AS (
        SELECT id, parent_id, deleted_parent_id, name, is_dir FROM files WHERE id=$1 AND user_id=$2
        UNION ALL
        SELECT f.id, f.parent_id, f.deleted_parent_id, f.name, f.is_dir FROM files f JOIN sub s ON f.deleted_parent_id = s.id WHERE f.user_id=$2 AND f.deleted_at IS NOT NULL
      ) SELECT * FROM sub ORDER BY is_dir DESC, id`,
      [id, req.user.id]
    );
    const qty = items.reduce((sum, item) => sum + Number(item.size || 0), 0);
    for (const item of items) {
      const nextParent = item.id === id ? restoreTo : (item.deleted_parent_id ?? 0);
      await query(
        'UPDATE files SET parent_id=$1, deleted_at=NULL, delete_expires_at=NULL, deleted_parent_id=NULL, updated_at=$2 WHERE id=$3',
        [nextParent, now, item.id]
      );
    }
    await recalcUserUsage(req.user.id);
    res.json({ status: 200, data: { restored: items.length, recoveredBytes: qty } });
  } catch (e) { next(e); }
});

// 移动（重命名之外独立接口）
router.post('/:id/move', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { parentId = 0 } = req.body || {};
    const targetPid = parseInt(parentId, 10) || 0;

    const file = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [id, req.user.id]);
    if (!file) return res.status(404).json({ status: 404, msg: '文件不存在' });

    if (targetPid === file.id) {
      return res.status(400).json({ status: 400, msg: '不能移动到自身' });
    }

    if (targetPid !== 0) {
      const target = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [targetPid, req.user.id]);
      if (!target) return res.status(404).json({ status: 404, msg: '目标目录不存在' });
      if (!target.is_dir) return res.status(400).json({ status: 400, msg: '目标不是文件夹' });

      if (file.is_dir) {
        const descendants = await many(`
          WITH RECURSIVE sub AS (
            SELECT id FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
            UNION ALL
            SELECT f.id FROM files f JOIN sub s ON f.parent_id=s.id WHERE f.user_id=$2 AND f.deleted_at IS NULL
          )
          SELECT id FROM sub
        `, [id, req.user.id]);
        if (descendants.some(d => d.id === targetPid)) {
          return res.status(400).json({ status: 400, msg: '不能移动到自身的子目录' });
        }
      }
    }

    if (targetPid === file.parent_id) {
      return res.json({ status: 200, msg: '位置未变化' });
    }

    const conflict = await one(
      'SELECT 1 FROM files WHERE user_id=$1 AND parent_id=$2 AND name=$3 AND id != $4 AND deleted_at IS NULL',
      [req.user.id, targetPid, file.name, id]
    );
    if (conflict) {
      return res.status(409).json({ status: 409, msg: '目标目录下已存在同名文件/文件夹' });
    }

    await query(
      'UPDATE files SET parent_id=$1, updated_at=$2 WHERE id=$3',
      [targetPid, Date.now(), id]
    );
    res.json({ status: 200, msg: '已移动' });
  } catch (e) { next(e); }
});
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const permanent = String(req.query.permanent || '').toLowerCase() === '1' || String(req.query.permanent || '').toLowerCase() === 'true';
    const file = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [id, req.user.id]);
    if (!file) {
      const deleted = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL', [id, req.user.id]);
      if (deleted) return res.status(409).json({ status: 409, msg: '该项目已在回收站中' });
      return res.status(404).json({ status: 404, msg: '文件不存在' });
    }

    if (permanent) {
      const freed = await tx(async (client) => {
        const res = await client.query(`
          WITH RECURSIVE sub AS (
            SELECT id, is_dir, size FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
            UNION ALL
            SELECT f.id, f.is_dir, f.size FROM files f JOIN sub s ON f.parent_id=s.id WHERE f.user_id=$2 AND f.deleted_at IS NULL
          )
          SELECT id, size FROM sub
        `, [id, req.user.id]);
        const all = res.rows;
        let freedBytes = 0;
        for (const item of all) {
          if (item.size) freedBytes += Number(item.size);
          await client.query('DELETE FROM files WHERE id=$1', [item.id]);
        }
        if (freedBytes) {
          await client.query('UPDATE users SET used_bytes = GREATEST(0, used_bytes - $1) WHERE id=$2',
            [freedBytes, req.user.id]);
        }
        return freedBytes;
      });
      await recalcUserUsage(req.user.id);
      return res.json({ status: 200, data: { freed, permanent: true } });
    }

    const now = Date.now();
    const expiresAt = now + 3 * 24 * 60 * 60 * 1000;
    const moved = await tx(async (client) => {
      const res = await client.query(`
        WITH RECURSIVE sub AS (
          SELECT id, parent_id, size FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
          UNION ALL
          SELECT f.id, f.parent_id, f.size FROM files f JOIN sub s ON f.parent_id=s.id WHERE f.user_id=$2 AND f.deleted_at IS NULL
        )
        SELECT id, parent_id, size FROM sub
      `, [id, req.user.id]);
      let freedBytes = 0;
      for (const item of res.rows) {
        if (item.size) freedBytes += Number(item.size);
        await client.query(
          'UPDATE files SET parent_id=0, deleted_parent_id=$1, deleted_at=$2, delete_expires_at=$3, updated_at=$4 WHERE id=$5',
          [item.parent_id, now, expiresAt, now, item.id]
        );
      }
      await client.query('UPDATE users SET used_bytes = GREATEST(0, used_bytes - $1) WHERE id=$2', [freedBytes, req.user.id]);
      return freedBytes;
    });

    await recalcUserUsage(req.user.id);
    res.json({ status: 200, data: { freed: moved, permanent: false } });
  } catch (e) { next(e); }
});
// ===== 文件夹打包下载（ZIP 流式） =====
const ZIP_MAX_TOTAL_BYTES = (parseInt(process.env.ZIP_MAX_TOTAL_MB || '2048', 10)) * 1024 * 1024;
const ZIP_MAX_FILES = parseInt(process.env.ZIP_MAX_FILES || '2000', 10);
const ZIP_CONCURRENCY = Math.max(1, parseInt(process.env.ZIP_CONCURRENCY || '4', 10));

async function mapLimit(items, limit, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

router.get('/:id/download-zip', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const root = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [id, req.user.id]);
    if (!root) return res.status(404).json({ status: 404, msg: '文件夹不存在' });
    if (!root.is_dir) return res.status(400).json({ status: 400, msg: '只支持文件夹打包下载，请单文件下载' });

    // 递归收集所有后代
    const all = await many(`
      WITH RECURSIVE sub AS (
        SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
        UNION ALL
        SELECT f.* FROM files f JOIN sub s ON f.parent_id = s.id WHERE f.user_id=$2 AND f.deleted_at IS NULL
      )
      SELECT * FROM sub
    `, [id, req.user.id]);

    const filesToZip = all.filter(f => !f.is_dir && f.storage_url);
    if (filesToZip.length > ZIP_MAX_FILES) {
      return res.status(413).json({
        status: 413,
        msg: `文件夹内文件过多（${filesToZip.length}，上限 ${ZIP_MAX_FILES}），请分批下载或联系管理员调整 ZIP_MAX_FILES`,
      });
    }
    const totalBytes = filesToZip.reduce((s, f) => s + (f.size || 0), 0);
    if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
      return res.status(413).json({
        status: 413,
        msg: `文件夹总大小超过打包上限（${humanMB(totalBytes)} > ${humanMB(ZIP_MAX_TOTAL_BYTES)}）`,
      });
    }

    // 目录结构：ZIP 内路径 = <root名>/<相对路径>
    const byId = new Map(all.map(f => [f.id, f]));
    function relPath(f) {
      const parts = [];
      let cur = f;
      while (cur) {
        parts.unshift(cur.name);
        if (cur.id === root.id) break;
        cur = byId.get(cur.parent_id);
      }
      return parts.join('/');
    }

    // 找出完全空的子目录（需要显式 append 空条目，否则 zip 解压后丢目录）
    const dirHasContent = new Set();
    for (const f of filesToZip) {
      let cur = byId.get(f.parent_id);
      while (cur) {
        dirHasContent.add(cur.id);
        if (cur.id === root.id) break;
        cur = byId.get(cur.parent_id);
      }
    }

    // 预取 provider 的 base_url 作为 Referer（部分 OJ 有防盗链）
    const providerIds = [...new Set(filesToZip.map(f => f.storage_provider_id).filter(Boolean))];
    const providers = providerIds.length
      ? await many('SELECT id,base_url FROM oj_providers WHERE id = ANY($1::int[])', [providerIds])
      : [];
    const providerMap = new Map(providers.map(p => [p.id, p]));

    // 响应头
    const zipName = root.name + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    res.setHeader('Cache-Control', 'no-store');

    const archive = archiver('zip', { zlib: { level: 6 } });
    let aborted = false;
    req.on('close', () => { aborted = true; });
    archive.on('warning', (e) => console.warn('[zip warn]', e));
    archive.on('error', (e) => {
      console.error('[zip error]', e);
      if (!res.headersSent) res.status(500).end('zip error');
      else res.end();
    });
    archive.pipe(res);

    // 空目录显式加入
    if (all.length === 1) {
      // 完全空文件夹：让 ZIP 里也有个目录条目
      archive.append('', { name: root.name + '/' });
    } else {
      for (const d of all) {
        if (d.is_dir && d.id !== root.id && !dirHasContent.has(d.id)) {
          archive.append('', { name: relPath(d) + '/' });
        }
      }
    }

    // 并发下载 + 写入
    await mapLimit(filesToZip, ZIP_CONCURRENCY, async (f) => {
      if (aborted) return;
      const provider = providerMap.get(f.storage_provider_id);
      const headers = { 'User-Agent': 'Mozilla/5.0 cloud-drive-zip' };
      if (provider && provider.base_url) {
        headers['Referer'] = provider.base_url.replace(/\/+$/, '') + '/';
      }
      try {
        const upstream = await fetch(f.storage_url, { headers });
        if (!upstream.ok) {
          console.warn('[zip] fetch fail', f.storage_url, upstream.status);
          archive.append(
            `下载失败：${f.storage_url}\nHTTP ${upstream.status}\n`,
            { name: relPath(f) + '.ERROR.txt' }
          );
          return;
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        archive.append(buf, { name: relPath(f) });
      } catch (e) {
        console.warn('[zip] fetch error', f.storage_url, e.message);
        archive.append(
          `下载失败：${f.storage_url}\n${e.message}\n`,
          { name: relPath(f) + '.ERROR.txt' }
        );
      }
    });

    if (!aborted) await archive.finalize();
  } catch (e) {
    console.error('[download-zip]', e);
    if (!res.headersSent) next(e);
    else res.end();
  }
});
router.get('/:id/download', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const file = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [id, req.user.id]);
    if (!file) return res.status(404).json({ status: 404, msg: '文件不存在' });
    if (file.is_dir) return res.status(400).json({ status: 400, msg: '不能下载文件夹' });
    if (!file.storage_url) return res.status(404).json({ status: 404, msg: '文件内容不存在' });

    const shouldProxy = true;
    if (!shouldProxy) return res.redirect(302, file.storage_url);

    const upstream = await fetch(file.storage_url, { headers: { 'User-Agent': 'Mozilla/5.0 cloud-drive-download' } });
    if (!upstream.ok) return res.status(502).send('上游获取失败');
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (e) { next(e); }
});
function humanMB(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
module.exports = router;