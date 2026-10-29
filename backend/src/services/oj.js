function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// 统一清洗 token：去空白、去 Bearer 前缀
function normalizeToken(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  s = s.replace(/^Bearer\s+/i, '').trim();
  return s || null;
}

function extractToken(json, preferredPath) {
  if (preferredPath) {
    const v = normalizeToken(getPath(json, preferredPath));
    if (v) return v;
  }
  for (const c of ['data.token', 'data.access_token', 'token', 'access_token', 'data']) {
    const v = normalizeToken(getPath(json, c));
    if (v) return v;
  }
  return null;
}

const tokenCache = new Map();
const inflight = new Map();

function getRemoteExt(filename, mimeType) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'application/pdf': '.pdf', 'text/plain': '.txt', 'application/zip': '.zip',
    'application/x-zip-compressed': '.zip', 'application/x-tar': '.tar',
  };
  const raw = String(filename || 'unnamed').replace(/[\\/]+/g, '_');
  const dot = raw.lastIndexOf('.');
  const ext = dot >= 0 ? raw.slice(dot).toLowerCase() : '';
  const disallowed = new Set(['.js', '.mjs', '.cjs', '.css', '.scss', '.less', '.html', '.htm', '.svg', '.xml', '.json', '.txt']);
  if (typeof mimeType === 'string' && map[mimeType.toLowerCase()]) return map[mimeType.toLowerCase()];
  if (ext && !disallowed.has(ext) && /^\.[A-Za-z0-9]{1,8}$/.test(ext)) return ext;
  if (typeof mimeType === 'string' && mimeType.startsWith('text/')) return '.txt';
  return '.bin';
}

function normalizeUploadFilename(filename, mimeType) {
  const raw = String(filename || 'unnamed').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
  const clean = raw.split('/').pop().split('\\').pop() || 'unnamed';
  const ext = getRemoteExt(clean, mimeType);
  const stamp = Date.now().toString(36);
  const salt = (Math.random() * 0xffffffff >>> 0).toString(36);
  return `cloud-${stamp}-${salt}${ext}`;
}

async function loginProvider(p) {
  if (!p.upload_username || !p.upload_password) {
    throw new Error('OJ 提供方未配置上传账号');
  }
  const base = p.base_url.replace(/\/+$/, '');
  const res = await fetch(base + p.login_path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: p.upload_username, password: p.upload_password }),
  });
  const text = await res.text();

  // 1) 首选：HTTP 响应头里的 authorization（headers 名大小写不敏感）
  const headerAuth = normalizeToken(
    res.headers.get('authorization') ||
    res.headers.get('x-authorization') ||
    res.headers.get('token')
  );
  if (headerAuth) return headerAuth;

  // 2) 回退：JSON 里的 token 字段（兼容其他 OJ）
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      'OJ 登录失败：响应头无 Authorization，且 body 不是 JSON。片段：' + text.slice(0, 200)
    );
  }
  const token = extractToken(json, p.token_json_path);
  if (token) return token;

  throw new Error(
    'OJ 登录失败：响应头与 JSON 均未找到 token。片段：' + text.slice(0, 300)
  );
}

async function getUploadToken(p, force = false) {
  const c = tokenCache.get(p.id);
  if (!force && c && c.expiresAt > Date.now()) return c.token;
  if (inflight.has(p.id)) return inflight.get(p.id);
  const pr = loginProvider(p).then((token) => {
    tokenCache.set(p.id, { token, expiresAt: Date.now() + 30 * 60 * 1000 });
    inflight.delete(p.id);
    return token;
  }).catch((e) => { inflight.delete(p.id); throw e; });
  inflight.set(p.id, pr);
  return pr;
}

async function doUpload(p, buffer, filename, mimeType) {
  const token = await getUploadToken(p);
  const base = p.base_url.replace(/\/+$/, '');
  const fd = new FormData();
  fd.append('gid', String(p.upload_gid ?? ''));
  fd.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);

  const res = await fetch(base + p.upload_path, {
    method: 'POST',
    headers: { authorization: token },
    body: fd,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('OJ 上传返回非 JSON：' + text.slice(0, 200)); }
  if (json.status !== 200 || !json.data || !json.data.link) {
    const err = new Error('OJ 上传失败：' + text.slice(0, 300));
    err.unauthorized = res.status === 401 || res.status === 403;
    throw err;
  }
  const link = json.data.link;
  const fullUrl = /^https?:\/\//.test(link) ? link : base + link;
  return { link, fullUrl };
}

async function uploadFile(p, buffer, filename, mimeType) {
  try {
    return await doUpload(p, buffer, filename, mimeType);
  } catch (e) {
    if (e.unauthorized) {
      tokenCache.delete(p.id);
      return await doUpload(p, buffer, filename, mimeType);
    }
    throw e;
  }
}

async function fetchHomeInfo(p, username) {
  const base = p.base_url.replace(/\/+$/, '');
  const url = base + p.home_info_path + '?username=' + encodeURIComponent(username);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('获取主页信息失败 HTTP ' + res.status);
  return res.json();
}

module.exports = { uploadFile, fetchHomeInfo, normalizeUploadFilename };