const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const { Readable } = require('stream');
const { one, many, query } = require('../db');
const { auth } = require('../middleware/auth');

const privateRouter = express.Router();
privateRouter.use(auth);

async function collectFolderFiles(folderId) {
  return many(`
    WITH RECURSIVE sub AS (
      SELECT * FROM files WHERE id=$1
      UNION ALL
      SELECT f.* FROM files f JOIN sub s ON f.parent_id=s.id
    )
    SELECT * FROM sub WHERE id <> $1 ORDER BY is_dir DESC, name ASC
  `, [folderId]);
}

async function buildFolderEntries(folderId, userId, relativePath = '') {
  const rows = await many(
    'SELECT * FROM files WHERE user_id=$1 AND parent_id=$2 AND deleted_at IS NULL ORDER BY is_dir DESC, name ASC',
    [userId, folderId]
  );
  const prefix = relativePath ? `${relativePath}/` : '';
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    size: Number(row.size || 0),
    isDir: !!row.is_dir,
    mimeType: row.mime_type,
    relativePath: `${prefix}${row.name}`,
    storageUrl: row.storage_url,
  }));
}

async function resolveShareFolderByPath(share, requestedPath) {
  const path = String(requestedPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!path || path === '.') return { id: share.file_id, path: '' };
  const segments = path.split('/').filter(Boolean);
  let currentId = share.file_id;
  let currentPath = '';
  for (const seg of segments) {
    const row = await one(
      'SELECT * FROM files WHERE user_id=$1 AND parent_id=$2 AND name=$3 AND is_dir=TRUE AND deleted_at IS NULL',
      [share.user_id, currentId, seg]
    );
    if (!row) return null;
    currentId = row.id;
    currentPath = currentPath ? `${currentPath}/${seg}` : seg;
  }
  return { id: currentId, path: currentPath };
}

async function writeZipForFiles(rootName, files, res) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rootName + '.zip')}`);

  archive.on('warning', (err) => console.warn('[share zip warn]', err));
  archive.on('error', (err) => {
    console.error('[share zip error]', err);
    if (!res.headersSent) res.status(500).end('zip error');
    else res.end();
  });
  archive.pipe(res);

  for (const f of files) {
    if (f.is_dir) continue;
    try {
      const upstream = await fetch(f.storage_url, { headers: { 'User-Agent': 'Mozilla/5.0 cloud-drive-share' } });
      if (!upstream.ok) {
        archive.append(`下载失败：${f.storage_url}\nHTTP ${upstream.status}\n`, { name: `${rootName}/${f.name}.ERROR.txt` });
        continue;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      archive.append(buf, { name: `${rootName}/${f.name}` });
    } catch (e) {
      archive.append(`下载失败：${f.storage_url}\n${e.message}\n`, { name: `${rootName}/${f.name}.ERROR.txt` });
    }
  }

  await archive.finalize();
}

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
    const file = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [fileId, req.user.id]);
    if (!file) return res.status(404).json({ status: 404, msg: '文件不存在' });

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
    SELECT s.*, f.id AS file_row_id, f.user_id AS file_user_id, f.name, f.size, f.is_dir, f.storage_url, f.mime_type
    FROM shares s JOIN files f ON f.id=s.file_id
    WHERE s.code=$1 AND f.deleted_at IS NULL
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
    const isFolder = !!share.is_dir;
    const payload = {
      id: share.file_id,
      name: share.name,
      size: share.size,
      isDir: isFolder,
      mimeType: share.mime_type,
      expiresAt: share.expires_at,
      remainingDownloads: share.max_downloads != null ? share.max_downloads - share.download_count : null,
      downloadUrl: `/api/share/${share.code}/download`,
      hasPassword: !!share.password_hash,
    };
    if (isFolder) {
      const folderId = share.file_id;
      const requestedPath = String(req.query.path || '').trim();
      const targetFolder = requestedPath ? await resolveShareFolderByPath(share, requestedPath) : { id: folderId, path: '' };
      if (!targetFolder) {
        return res.status(404).json({ status: 404, msg: '目录不存在' });
      }
      const entries = await buildFolderEntries(targetFolder.id, share.user_id, targetFolder.path);
      const parent = targetFolder.path ? targetFolder.path.split('/').slice(0, -1).join('/') : '';
      payload.currentPath = targetFolder.path;
      payload.parentPath = parent;
      payload.items = entries;
      payload.breadcrumb = targetFolder.path ? targetFolder.path.split('/').filter(Boolean) : [];
    }
    res.json({ status: 200, data: payload });
  } catch (e) { next(e); }
});

publicRouter.get('/:code/files', async (req, res, next) => {
  try {
    const share = await loadShare(req.params.code);
    const c = checkShare(share, req.query.password);
    if (!c.ok) return res.status(c.status).json({ status: c.status, msg: c.msg });
    if (!share.is_dir) {
      return res.json({ status: 200, data: { items: [{ id: share.file_id, name: share.name, size: Number(share.size || 0), relativePath: share.name, mimeType: share.mime_type, storageUrl: share.storage_url }] } });
    }
    const targetFolder = await resolveShareFolderByPath(share, req.query.path || '');
    if (!targetFolder) return res.status(404).json({ status: 404, msg: '目录不存在' });
    const items = await buildFolderEntries(targetFolder.id, share.user_id, targetFolder.path);
    res.json({ status: 200, data: { items, currentPath: targetFolder.path, parentPath: targetFolder.path ? targetFolder.path.split('/').slice(0, -1).join('/') : '' } });
  } catch (e) { next(e); }
});

publicRouter.get('/:code/download', async (req, res, next) => {
  try {
    const share = await loadShare(req.params.code);
    const c = checkShare(share, req.query.password);
    if (!c.ok) return res.status(c.status).send(c.msg);

    if (share.is_dir) {
      const selectedFileId = req.query.fileId != null ? parseInt(req.query.fileId, 10) : null;
      const targetPath = String(req.query.path || '').trim();
      const targetFolder = targetPath ? await resolveShareFolderByPath(share, targetPath) : { id: share.file_id, path: '' };
      if (!targetFolder) return res.status(404).send('目标目录不存在');
      if (selectedFileId && Number.isInteger(selectedFileId)) {
        const entries = await buildFolderEntries(targetFolder.id, share.user_id, targetFolder.path);
        const target = entries.find(f => f.id === selectedFileId);
        if (!target || !target.storageUrl) return res.status(404).send('目标文件不存在');
        await query('UPDATE shares SET download_count = download_count + 1 WHERE id=$1', [share.id]);
        const upstream = await fetch(target.storageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 cloud-drive-share' } });
        if (!upstream.ok) return res.status(502).send('上游获取失败');
        res.setHeader('Content-Type', target.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(target.name)}`);
        if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
        return;
      }
      const files = await many(
        `WITH RECURSIVE sub AS (
          SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
          UNION ALL
          SELECT f.* FROM files f JOIN sub s ON f.parent_id = s.id WHERE f.user_id=$2 AND f.deleted_at IS NULL
        ) SELECT * FROM sub WHERE id <> $1 ORDER BY is_dir DESC, name ASC`,
        [share.file_id, share.user_id]
      );
      const selectedDirEntries = targetFolder.id === share.file_id ? files : await many(
        `WITH RECURSIVE sub AS (
          SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
          UNION ALL
          SELECT f.* FROM files f JOIN sub s ON f.parent_id = s.id WHERE f.user_id=$2 AND f.deleted_at IS NULL
        ) SELECT * FROM sub WHERE id <> $1 ORDER BY is_dir DESC, name ASC`,
        [targetFolder.id, share.user_id]
      );
      const zipFiles = selectedDirEntries.filter(f => !f.is_dir && f.storage_url);
      const rootName = String((targetFolder.path ? targetFolder.path.split('/').slice(-1)[0] : share.name) || 'shared-folder').replace(/[\\/:*?"<>|]+/g, '_');
      await writeZipForFiles(rootName, zipFiles, res);
      return;
    }

    if (!share.storage_url) return res.status(404).send('文件内容不存在');
    await query('UPDATE shares SET download_count = download_count + 1 WHERE id=$1', [share.id]);
    res.setHeader('Content-Type', share.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(share.name)}`);
    const upstream = await fetch(share.storage_url, { headers: { 'User-Agent': 'Mozilla/5.0 cloud-drive-share' } });
    if (!upstream.ok) return res.status(502).send('上游获取失败');
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
    return;
  } catch (e) { next(e); }
});

module.exports = { privateRouter, publicRouter };