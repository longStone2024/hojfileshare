const express = require('express');
const bcrypt = require('bcryptjs');
const { one, many, query, tx } = require('../db');
const { uploadFile, normalizeUploadFilename } = require('../services/oj');

const router = express.Router();

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[c]));
}

function decodeWebdavPath(rawPath) {
  const value = String(rawPath || '/');
  const decoded = decodeURIComponent(value.replace(/\\/g, '/'));
  const normalized = decoded.replace(/\/+/g, '/');
  if (normalized === '') return '/';
  if (normalized === '/') return '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function getHref(req, path) {
  const base = (req.baseUrl || '/dav').replace(/\/+$/, '');
  const clean = (path === '/' ? '' : path).replace(/^\/+/, '');
  if (!clean) return `${base}/`;
  const encoded = clean.split('/').map(part => encodeURIComponent(part)).join('/');
  return `${base}/${encoded}`;
}

function parseBasicAuth(headerValue) {
  if (!headerValue || !headerValue.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx <= 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

async function authorizeWebdav(req, res, next) {
  try {
    const authHeader = String(req.headers.authorization || '');
    const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token.trim() : '';

    const basic = parseBasicAuth(authHeader);
    if (basic) {
      const user = await one('SELECT * FROM users WHERE username=$1', [basic.username]);
      if (!user || !user.password_hash || !bcrypt.compareSync(basic.password, user.password_hash)) {
        res.setHeader('WWW-Authenticate', 'Basic realm="cloud-drive"');
        return res.status(401).json({ status: 401, msg: '用户名或密码错误' });
      }
      req.webdavUser = user;
      return next();
    }

    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearerToken || tokenFromQuery) {
      const token = bearerToken || tokenFromQuery;
      const session = await one('SELECT * FROM sessions WHERE token=$1', [token]);
      if (!session) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="cloud-drive"');
        return res.status(401).json({ status: 401, msg: '会话无效' });
      }
      if (session.expires_at < Date.now()) {
        await query('DELETE FROM sessions WHERE token=$1', [token]);
        res.setHeader('WWW-Authenticate', 'Bearer realm="cloud-drive"');
        return res.status(401).json({ status: 401, msg: '会话已过期' });
      }
      const user = await one('SELECT * FROM users WHERE id=$1', [session.user_id]);
      if (!user) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="cloud-drive"');
        return res.status(401).json({ status: 401, msg: '用户不存在' });
      }
      req.webdavUser = user;
      return next();
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="cloud-drive"');
    return res.status(401).json({ status: 401, msg: '需要 WebDAV 登录' });
  } catch (e) {
    next(e);
  }
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

async function chooseProviderForUser(user) {
  const allowedIds = getUserAllowedProviderIds(user);
  if (user.role === 'admin' || user.role === 'root') {
    return one('SELECT * FROM oj_providers WHERE enabled=TRUE ORDER BY sort_order, id LIMIT 1');
  }
  if (allowedIds && allowedIds.length) {
    return one(
      'SELECT * FROM oj_providers WHERE enabled=TRUE AND id = ANY($1::int[]) ORDER BY sort_order, id LIMIT 1',
      [allowedIds]
    );
  }
  return one('SELECT * FROM oj_providers WHERE enabled=TRUE ORDER BY sort_order, id LIMIT 1');
}

async function resolvePathForUser(userId, webdavPath) {
  const routePath = decodeWebdavPath(webdavPath);
  if (routePath === '/' || routePath === '') return { id: 0, is_dir: true, parent_id: 0, name: '/', path: '/' };
  const parts = routePath.split('/').filter(Boolean);
  if (!parts.length) return { id: 0, is_dir: true, parent_id: 0, name: '/', path: '/' };

  let parentId = 0;
  let current = null;
  for (const part of parts) {
    const row = await one(
      'SELECT * FROM files WHERE user_id=$1 AND parent_id=$2 AND name=$3 AND deleted_at IS NULL',
      [userId, parentId, part]
    );
    if (!row) return null;
    current = row;
    parentId = row.id;
  }
  return current;
}

async function getParentAndName(userId, webdavPath) {
  const routePath = decodeWebdavPath(webdavPath);
  const trimmed = routePath === '/' ? '' : routePath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    return { parentId: 0, name: '', parentDir: { id: 0, is_dir: true } };
  }
  const parts = trimmed.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) {
    return { parentId: 0, name: '', parentDir: { id: 0, is_dir: true } };
  }
  let parentId = 0;
  let parentDir = { id: 0, is_dir: true };
  for (const part of parts) {
    const current = await one('SELECT * FROM files WHERE user_id=$1 AND parent_id=$2 AND name=$3 AND deleted_at IS NULL', [userId, parentId, part]);
    if (!current || !current.is_dir) return { parentId: null, name, parentDir: null };
    parentDir = current;
    parentId = current.id;
  }
  return { parentId, name, parentDir };
}

async function deleteNodeById(userId, id) {
  return tx(async (client) => {
    const result = await client.query(`
      WITH RECURSIVE sub AS (
      SELECT id, is_dir, size FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
        UNION ALL
      SELECT f.id, f.is_dir, f.size FROM files f JOIN sub s ON f.parent_id=s.id WHERE f.user_id=$2 AND f.deleted_at IS NULL
      )
      SELECT id, size FROM sub
    `, [id, userId]);
    const all = result.rows;
    let freedBytes = 0;
    for (const f of all) {
      if (f.size) freedBytes += Number(f.size);
      await client.query('DELETE FROM files WHERE id=$1', [f.id]);
    }
    if (freedBytes) {
      await client.query('UPDATE users SET used_bytes = GREATEST(0, used_bytes - $1) WHERE id=$2', [freedBytes, userId]);
    }
    return freedBytes;
  });
}

async function createDirectory(userId, parentId, name) {
  if (!name || /[\\/]/.test(name) || name.length > 255) {
    const error = new Error('名称非法'); error.statusCode = 400; throw error;
  }
  if (parentId !== 0) {
    const parent = await one('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [parentId, userId]);
    if (!parent || !parent.is_dir) {
      const error = new Error('父目录不存在'); error.statusCode = 409; throw error;
    }
  }
  const now = Date.now();
  const created = await query(
    `INSERT INTO files (user_id,parent_id,name,is_dir,size,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, parentId, name, true, 0, now, now]
  );
  return created.rows[0];
}

function buildMultistatusXml(req, items, targetPath) {
  const responses = items.map((item) => {
    const href = getHref(req, item.path || targetPath);
    const isCollection = !!item.is_dir;
    const properties = [
      `<d:displayname>${escapeXml(item.name)}</d:displayname>`,
      isCollection ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>',
      `<d:getlastmodified>${new Date(item.updated_at || Date.now()).toUTCString()}</d:getlastmodified>`,
      isCollection ? '' : `<d:getcontentlength>${Number(item.size || 0)}</d:getcontentlength>`,
      isCollection ? '' : `<d:getcontenttype>${escapeXml(item.mime_type || 'application/octet-stream')}</d:getcontenttype>`
    ].join('');
    return `
      <d:response>
        <d:href>${escapeXml(href)}</d:href>
        <d:propstat>
          <d:prop>${properties}</d:prop>
          <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
      </d:response>`;
  }).join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`;
}

router.all('/*', authorizeWebdav, async (req, res, next) => {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'OPTIONS, PROPFIND, MKCOL, PUT, GET, HEAD, DELETE, MOVE, COPY');
      res.setHeader('DAV', '1, 2');
      res.sendStatus(200);
      return;
    }

    const routePath = decodeWebdavPath(req.path || '/');
    const userId = req.webdavUser.id;

    if (req.method === 'PROPFIND') {
      const target = await resolvePathForUser(userId, routePath);
      if (!target) {
        return res.status(404).xml ? res.status(404).send('Not Found') : res.status(404).json({ status: 404, msg: '资源不存在' });
      }

      const depth = String(req.headers.depth || '1').toLowerCase();
      if (target.is_dir) {
        const rows = await many(
          'SELECT * FROM files WHERE user_id=$1 AND parent_id=$2 AND deleted_at IS NULL ORDER BY is_dir DESC, name ASC',
          [userId, target.id]
        );
        const items = rows.map((row) => ({
          id: row.id,
          name: row.name,
          is_dir: !!row.is_dir,
          size: Number(row.size || 0),
          mime_type: row.mime_type,
          updated_at: row.updated_at,
          path: `${routePath === '/' ? '' : routePath}/${row.name}`,
        }));
        if (depth === '0') {
          const fileSelf = {
            name: target.name === '/' ? 'root' : target.name,
            is_dir: !!target.is_dir,
            size: Number(target.size || 0),
            mime_type: target.mime_type,
            updated_at: target.updated_at,
            path: routePath,
          };
          const xml = buildMultistatusXml(req, [fileSelf], routePath);
          res.setHeader('Content-Type', 'application/xml; charset=utf-8');
          return res.status(207).send(xml);
        }
        const xml = buildMultistatusXml(req, items, routePath);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        return res.status(207).send(xml);
      }

      const xml = buildMultistatusXml(req, [{
        name: target.name,
        is_dir: false,
        size: Number(target.size || 0),
        mime_type: target.mime_type,
        updated_at: target.updated_at,
        path: routePath,
      }], routePath);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.status(207).send(xml);
    }

    if (req.method === 'MKCOL') {
      const { parentId, name, parentDir } = await getParentAndName(userId, routePath);
      if (parentId === null || !parentDir || !parentDir.is_dir) {
        return res.status(409).json({ status: 409, msg: '父目录不存在' });
      }
      try {
        const row = await createDirectory(userId, parentId, name);
        res.status(201).json({ status: 201, data: { file: row } });
      } catch (e) {
        if (e.statusCode) return res.status(e.statusCode).json({ status: e.statusCode, msg: e.message });
        throw e;
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const target = await resolvePathForUser(userId, routePath);
      if (!target || target.is_dir) {
        return res.status(404).json({ status: 404, msg: '文件不存在' });
      }
      if (!target.storage_url) {
        return res.status(404).json({ status: 404, msg: '文件内容不存在' });
      }
      const upstream = await fetch(target.storage_url);
      if (!upstream.ok) return res.status(502).send('上游获取失败');
      res.setHeader('Content-Type', target.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(target.name)}`);
      res.setHeader('Content-Length', String(target.size || 0));
      if (req.method === 'HEAD') return res.end();
      if (upstream.body) {
        const { Readable } = require('stream');
        Readable.fromWeb(upstream.body).pipe(res);
      } else {
        res.end();
      }
      return;
    }

    if (req.method === 'PUT') {
      const { parentId, name, parentDir } = await getParentAndName(userId, routePath);
      if (parentId === null || !parentDir || !parentDir.is_dir) {
        return res.status(409).json({ status: 409, msg: '父目录不存在' });
      }
      if (!name) {
        return res.status(400).json({ status: 400, msg: '文件名不能为空' });
      }

      const rawChunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => rawChunks.push(chunk));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const buffer = Buffer.concat(rawChunks);
      const freshUser = await one('SELECT quota_bytes, used_bytes FROM users WHERE id=$1', [userId]);
      const existing = await one('SELECT * FROM files WHERE user_id=$1 AND parent_id=$2 AND name=$3 AND deleted_at IS NULL', [userId, parentId, name]);
      const existingSize = existing ? Number(existing.size || 0) : 0;
      const delta = buffer.length - existingSize;
      if (freshUser.used_bytes + delta > freshUser.quota_bytes) {
        return res.status(413).json({ status: 413, msg: '存储空间不足' });
      }

      const provider = await chooseProviderForUser(req.webdavUser);
      if (!provider) {
        return res.status(500).json({ status: 500, msg: '未配置可用存储提供方' });
      }
      const remoteName = normalizeUploadFilename(name, req.headers['content-type'] || 'application/octet-stream');
      const { fullUrl } = await uploadFile(provider, buffer, remoteName, req.headers['content-type'] || 'application/octet-stream');

      if (existing) {
        await query(
          `UPDATE files SET size=$1, storage_url=$2, storage_provider_id=$3, mime_type=$4, updated_at=$5 WHERE id=$6`,
          [buffer.length, fullUrl, provider.id, req.headers['content-type'] || 'application/octet-stream', Date.now(), existing.id]
        );
        await query('UPDATE users SET used_bytes = used_bytes + $1 WHERE id=$2', [delta, userId]);
        res.status(204).end();
        return;
      }

      const r = await query(
        `INSERT INTO files (user_id,parent_id,name,is_dir,size,storage_url,storage_provider_id,mime_type,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [userId, parentId, name, false, buffer.length, fullUrl, provider.id,
          req.headers['content-type'] || 'application/octet-stream', Date.now(), Date.now()]
      );
      await query('UPDATE users SET used_bytes = used_bytes + $1 WHERE id=$2', [buffer.length, userId]);
      res.status(201).json({ status: 201, data: { file: r.rows[0] } });
      return;
    }

    if (req.method === 'DELETE') {
      const target = await resolvePathForUser(userId, routePath);
      if (!target) {
        return res.status(404).json({ status: 404, msg: '资源不存在' });
      }
      await deleteNodeById(userId, target.id);
      return res.status(204).end();
    }

    if (req.method === 'MOVE') {
      const source = await resolvePathForUser(userId, routePath);
      if (!source) {
        return res.status(404).json({ status: 404, msg: '源文件不存在' });
      }
      const destinationHeader = req.headers.destination || '';
      if (!destinationHeader) {
        return res.status(400).json({ status: 400, msg: '缺少 Destination' });
      }
      const destinationUrl = new URL(destinationHeader, 'http://localhost');
      const destinationPath = decodeWebdavPath(destinationUrl.pathname.replace(/^\/dav/i, ''));
      const { parentId, name, parentDir } = await getParentAndName(userId, destinationPath);
      if (parentId === null || !parentDir || !parentDir.is_dir) {
        return res.status(409).json({ status: 409, msg: '目标目录不存在' });
      }
      const conflict = await one(
        'SELECT 1 FROM files WHERE user_id=$1 AND parent_id=$2 AND name=$3 AND id != $4 AND deleted_at IS NULL',
        [userId, parentId, name, source.id]
      );
      if (conflict) {
        return res.status(409).json({ status: 409, msg: '目标目录下已存在同名文件/文件夹' });
      }
      await query('UPDATE files SET parent_id=$1, name=$2, updated_at=$3 WHERE id=$4', [parentId, name, Date.now(), source.id]);
      return res.status(201).end();
    }

    if (req.method === 'COPY') {
      const source = await resolvePathForUser(userId, routePath);
      if (!source) {
        return res.status(404).json({ status: 404, msg: '源文件不存在' });
      }
      if (source.is_dir) {
        return res.status(501).json({ status: 501, msg: '目录复制暂未实现' });
      }
      const destinationHeader = req.headers.destination || '';
      if (!destinationHeader) {
        return res.status(400).json({ status: 400, msg: '缺少 Destination' });
      }
      const destinationUrl = new URL(destinationHeader, 'http://localhost');
      const destinationPath = decodeWebdavPath(destinationUrl.pathname.replace(/^\/dav/i, ''));
      const { parentId, name, parentDir } = await getParentAndName(userId, destinationPath);
      if (parentId === null || !parentDir || !parentDir.is_dir) {
        return res.status(409).json({ status: 409, msg: '目标目录不存在' });
      }
      const conflict = await one(
        'SELECT 1 FROM files WHERE user_id=$1 AND parent_id=$2 AND name=$3 AND deleted_at IS NULL',
        [userId, parentId, name]
      );
      if (conflict) {
        return res.status(409).json({ status: 409, msg: '目标目录下已存在同名文件' });
      }
      const now = Date.now();
      const row = await query(
        `INSERT INTO files (user_id,parent_id,name,is_dir,size,storage_url,storage_provider_id,mime_type,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [userId, parentId, name, false, source.size || 0, source.storage_url, source.storage_provider_id,
          source.mime_type || 'application/octet-stream', now, now]
      );
      await query('UPDATE users SET used_bytes = used_bytes + $1 WHERE id=$2', [Math.max(0, Number(source.size || 0)), userId]);
      return res.status(201).json({ status: 201, data: { file: row.rows[0] } });
    }

    res.status(501).json({ status: 501, msg: 'WebDAV method not implemented: ' + req.method });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
