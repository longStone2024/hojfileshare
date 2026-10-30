// ============== 基础工具 ==============
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const toastEl = $('#toast');

if (!app || !toastEl) {
  throw new Error('主页面缺少 app/toast 节点');
}

document.addEventListener('click', (ev) => {
  const target = ev.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.more-action')) return;
  if (target.closest('.action-menu')) return;
  document.querySelectorAll('.action-menu').forEach(m => m.hidden = true);
});

function toast(msg, ms = 2200) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function humanSize(n) {
  if (n == null) return '-';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + ' ' + u[i];
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(Number(ts)).toLocaleString();
}

const state = {
  token: localStorage.getItem('token') || '',
  me: null,
  parentId: 0,
  stack: [{ id: 0, name: '根目录' }],
  needsPassword: false,
  adminTab: 'dashboard',
  siteSettings: null,
  viewMode: localStorage.getItem('drive-view-mode') || 'list',
  iconSize: localStorage.getItem('drive-icon-size') || 'medium',
};

function setToken(t) {
  state.token = t || '';
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

function getAllowedProviderIdsForUser(user) {
  if (!user) return null;
  if (user.role === 'admin' || user.role === 'root') return null;
  if (Array.isArray(user.storageProviderIds) && user.storageProviderIds.length) {
    return user.storageProviderIds.slice();
  }
  if (user.ojProviderId != null) {
    return [user.ojProviderId];
  }
  return null;
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers['authorization'] = state.token;
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401) {
    setToken(''); state.me = null;
    renderLogin();
    throw new Error((data && data.msg) || '未登录');
  }
  if (!res.ok || (data && data.status !== 200)) {
    throw new Error((data && data.msg) || ('HTTP ' + res.status));
  }
  return data;
}

// ============== 通用 Modal ==============
function modal(html) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(mask);
  return { mask, close: () => mask.remove() };
}

async function confirmDialog(message, options = {}) {
  const { title = '确认操作', confirmText = '确认', cancelText = '取消' } = options;
  return await new Promise((resolve) => {
    const { mask, close } = modal(`
      <h3>${esc(title)}</h3>
      <p class="hint" style="margin:0;white-space:pre-wrap;">${esc(message)}</p>
      <div class="actions">
        <button class="btn secondary" id="cancelBtn">${esc(cancelText)}</button>
        <button class="btn" id="okBtn">${esc(confirmText)}</button>
      </div>
    `);
    mask.querySelector('#cancelBtn').onclick = () => { close(); resolve(false); };
    mask.querySelector('#okBtn').onclick = () => { close(); resolve(true); };
  });
}

async function promptDialog({ title = '输入内容', label = '内容', value = '', type = 'text' } = {}) {
  return await new Promise((resolve) => {
    const { mask, close } = modal(`
      <h3>${esc(title)}</h3>
      <div class="row" style="flex-direction:column;">
        <label>${esc(label)}</label>
        <input id="dialogInput" type="${type}" value="${esc(value)}" />
      </div>
      <div class="actions">
        <button class="btn secondary" id="cancelBtn">取消</button>
        <button class="btn" id="okBtn">确定</button>
      </div>
    `);
    const input = mask.querySelector('#dialogInput');
    const done = (result) => { close(); resolve(result); };
    mask.querySelector('#cancelBtn').onclick = () => done(null);
    mask.querySelector('#okBtn').onclick = () => done(input.value);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value); };
  });
}

// ============== 登录页 ==============
async function renderLogin() {
  app.innerHTML = `
    <div class="card">
      <div class="tabs">
        <button data-tab="local" class="active">账号登录</button>
        <button data-tab="oj">OJ 签名登录 / 注册</button>
      </div>
      <div id="tabPanel"></div>
    </div>`;
  const panel = $('#tabPanel');
  const tabs = app.querySelectorAll('.tabs button');
  tabs.forEach(b => b.onclick = () => {
    tabs.forEach(x => x.classList.toggle('active', x === b));
    if (b.dataset.tab === 'local') renderLocalLogin(panel);
    else renderOjLogin(panel);
  });
  renderLocalLogin(panel);
}

function renderLocalLogin(panel) {
  panel.innerHTML = `
    <div class="row" style="flex-direction: column;">
      <div><label>用户名</label><input id="u" type="text" autocomplete="username"/></div>
      <div><label>密码</label><input id="p" type="password" autocomplete="current-password"/></div>
      <div><button id="loginBtn" class="btn">登录</button></div>
      <div id="loginHint" class="hint"></div>
    </div>`;
  const submit = async () => {
    $('#loginHint').textContent = '';
    try {
      const r = await api('/api/auth/login', {
        method: 'POST', body: { username: $('#u').value, password: $('#p').value }
      });
      setToken(r.data.token);
      state.me = r.data.user;
      state.needsPassword = !!r.data.needsPassword;
      renderApp();
    } catch (e) {
      if (e.message.includes('尚未设置密码') || e.message.includes('OJ 签名')) {
        $('#loginHint').textContent = '⚠️ ' + e.message;
        $('#loginHint').style.color = '#e5484d';
      } else {
        toast(e.message);
      }
    }
  };
  $('#loginBtn').onclick = submit;
  $('#p').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

async function renderOjLogin(panel) {
  panel.innerHTML = `<p class="hint">加载 OJ 提供方…</p>`;
  let providers = [];
  try {
    const r = await api('/api/auth/providers');
    providers = r.data.providers;
  } catch (e) { panel.innerHTML = `<p class="hint">加载失败：${esc(e.message)}</p>`; return; }
  if (!providers.length) {
    panel.innerHTML = `<p class="hint">管理员还没配置任何 OJ 提供方。</p>`;
    return;
  }
  panel.innerHTML = `
    <div class="row" style="flex-direction: column;">
      <div>
        <label>选择 OJ</label>
        <select id="pid">${providers.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      </div>
      <div><label>在该 OJ 的用户名</label><input id="oju" type="text"/></div>
      <div>
        <label>云盘用户名（可选，仅首次注册需要）</label>
        <input id="desired" type="text" placeholder="留空则使用 OJ 用户名"/>
        <div id="uIndicator" class="hint" style="margin-top:4px;"></div>
      </div>
      <div><button id="chBtn" class="btn">生成 UUID 并验证</button></div>
      <div id="chBox"></div>
    </div>`;

  const sel = $('#pid');
  sel.style.cssText = 'width:100%;padding:9px 12px;border:1px solid #d0d5dd;border-radius:8px;font-size:14px;background:#fff;';

  // 实时检查云盘用户名
  let checkTimer = null;
  $('#desired').oninput = () => {
    clearTimeout(checkTimer);
    const v = $('#desired').value.trim();
    const ind = $('#uIndicator');
    if (!v) { ind.textContent = ''; return; }
    ind.textContent = '检查中…';
    ind.style.color = '#888';
    checkTimer = setTimeout(async () => {
      try {
        const r = await api('/api/auth/check-username?username=' + encodeURIComponent(v));
        if (r.data.available) { ind.textContent = '✅ 可用'; ind.style.color = '#2ea043'; }
        else { ind.textContent = '❌ ' + (r.data.reason || '不可用'); ind.style.color = '#e5484d'; }
      } catch { ind.textContent = ''; }
    }, 350);
  };

  $('#chBtn').onclick = async () => {
    try {
      const body = {
        providerId: parseInt(sel.value, 10),
        username: $('#oju').value.trim(),
      };
      const desired = $('#desired').value.trim();
      if (desired) body.desiredUsername = desired;

      const r = await api('/api/auth/oj/challenge', { method: 'POST', body });
      const { uuid, expiresIn, providerName, isNew } = r.data;
      $('#chBox').innerHTML = `
        <div class="warning-banner" style="margin-top:12px;">
          <p class="hint">${isNew ? '🆕 首次注册' : '👤 登录'} · 在 <b>${esc(providerName)}</b> 的主页签名<b>最前面</b>放上这串 UUID，保存后点击下方按钮（${expiresIn} 秒内有效）：</p>
          <p class="uuid">${esc(uuid)}</p>
          <button id="verBtn" class="btn">我改好了，验证</button>
        </div>`;
      $('#verBtn').onclick = async () => {
        try {
          const v = await api('/api/auth/oj/verify', { method: 'POST', body: { uuid } });
          setToken(v.data.token);
          state.me = v.data.user;
          state.needsPassword = !!v.data.needsPassword;
          if (state.needsPassword) {
            promptSetPassword(true);
          } else {
            renderApp();
          }
        } catch (e) { toast(e.message); }
      };
    } catch (e) { toast(e.message); }
  };
}

// ============== 设置密码弹窗 ==============
function promptSetPassword(isFirstTime) {
  const { mask, close } = modal(`
    <h3>${isFirstTime ? '设置登录密码' : '修改密码'}</h3>
    ${isFirstTime ? '<p class="hint">首次通过 OJ 注册，请设置密码。之后可直接用"用户名 + 密码"登录。</p>' : ''}
    <div class="row" style="flex-direction:column;">
      <div><label>密码（至少 6 位）</label><input id="pw1" type="password"/></div>
      <div><label>确认密码</label><input id="pw2" type="password"/></div>
    </div>
    <div class="actions">
      ${isFirstTime ? '<button class="btn secondary" id="later">稍后设置</button>' : '<button class="btn secondary" id="later">取消</button>'}
      <button class="btn" id="ok">确定</button>
    </div>`);
  mask.querySelector('#later').onclick = () => {
    close();
    if (isFirstTime) {
      state.needsPassword = true;
      renderApp();
    }
  };
  mask.querySelector('#ok').onclick = async () => {
    const pw1 = mask.querySelector('#pw1').value;
    const pw2 = mask.querySelector('#pw2').value;
    if (pw1.length < 6) return toast('密码至少 6 位');
    if (pw1 !== pw2) return toast('两次密码不一致');
    try {
      await api('/api/auth/set-password', { method: 'POST', body: { password: pw1 } });
      toast('密码已设置');
      state.needsPassword = false;
      close();
      const r = await api('/api/auth/me');
      state.me = r.data.user;
      renderUserBar();
      if (isFirstTime) renderApp();
    } catch (e) { toast(e.message); }
  };
}

// ============== 用户栏 ==============
function renderUserBar() {
  const u = state.me;
  const actionButtons = `
    <div class="user-actions">
      <button id="noticeBtn">公告</button>
      ${state.needsPassword ? '<button id="pwBtn" style="color:#ffd700;border-color:#ffd700">设置密码</button>' : '<button id="pwBtn">改密码</button>'}
      ${['admin', 'root'].includes(u.role) ? '<button id="adminBtn">管理</button>' : ''}
      <button id="logoutBtn">退出</button>
    </div>
  `;
  $('#userbar').innerHTML = `
    <div class="user-meta">
      <span>${esc(u.username)} <small style="opacity:.7">(${u.role})</small></span>
    </div>
    ${actionButtons}
  `;
  $('#noticeBtn').onclick = () => window.location.href = '/notice';
  $('#pwBtn').onclick = () => promptSetPassword(false);
  $('#logoutBtn').onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    setToken(''); state.me = null;
    location.href = '/';
  };
  const ab = $('#adminBtn');
  if (ab) ab.onclick = () => { window.location.href = '/admin'; };
}

function renderBreadcrumb() {
  return `<div class="breadcrumb">${state.stack.map((s, i) =>
    `<a data-idx="${i}">${esc(s.name)}</a>`).join(' / ')}</div>`;
}

function renderViewControls() {
  return `
    <div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <div class="row" style="align-items:center;gap:8px;">
        <button class="btn secondary ${state.viewMode === 'list' ? 'active' : ''}" data-view-mode="list">列表</button>
        <button class="btn secondary ${state.viewMode === 'tile' ? 'active' : ''}" data-view-mode="tile">平铺</button>
      </div>
      <div class="row" style="align-items:center;gap:8px;">
        <label class="hint" style="margin:0;">图标大小</label>
        <select id="iconSizeSelect" style="min-width:110px;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;">
          <option value="small" ${state.iconSize === 'small' ? 'selected' : ''}>小</option>
          <option value="medium" ${state.iconSize === 'medium' ? 'selected' : ''}>中</option>
          <option value="large" ${state.iconSize === 'large' ? 'selected' : ''}>大</option>
        </select>
      </div>
    </div>
  `;
}

function getPreviewType(file) {
  if (!file || file.isDir) return null;
  const name = String(file.name || '').toLowerCase();
  const mime = String(file.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  if (mime.startsWith('text/') || [
    '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.less',
    '.html', '.htm', '.xml', '.yaml', '.yml', '.ini', '.toml', '.csv', '.log', '.sh', '.bash',
    '.zsh', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.sql',
    '.php', '.vue', '.svelte', '.diff', '.patch'
  ].some(ext => name.endsWith(ext))) {
    return 'text';
  }
  return null;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

function renderMarkdownHtml(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  let html = '';
  let inCode = false;
  let codeLines = [];
  const flushCode = () => {
    if (!inCode) return;
    html += `<pre class="preview-code"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
    codeLines = [];
    inCode = false;
  };

  for (const raw of lines) {
    if (/^```/.test(raw)) {
      if (inCode) flushCode();
      else { inCode = true; }
      continue;
    }
    if (inCode) {
      codeLines.push(raw);
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      html += '<br>';
      continue;
    }
    if (/^#{1,6}\s+/.test(raw)) {
      const level = raw.match(/^#+/)[0].length;
      const text = raw.replace(/^#+\s+/, '');
      html += `<h${level}>${renderInlineMarkdown(text)}</h${level}>`;
      continue;
    }
    if (/^>\s+/.test(raw)) {
      html += `<blockquote>${renderInlineMarkdown(raw.replace(/^>\s+/, ''))}</blockquote>`;
      continue;
    }
    if (/^[-*+]\s+/.test(raw)) {
      html += `<ul><li>${renderInlineMarkdown(trimmed.replace(/^[-*+]\s+/, ''))}</li></ul>`;
      continue;
    }
    html += `<p>${renderInlineMarkdown(raw)}</p>`;
  }
  if (inCode) flushCode();
  return html;
}

function renderHighlightedCode(text) {
  let html = escapeHtml(text || '');
  html = html.replace(/(&(?:quot|#39);.*?&(?:quot|#39;)|`[^`]*`|"(?:\\.|[^\"])*"|'(?:\\.|[^'])*')/g, '<span class="hl-string">$1</span>');
  html = html.replace(/\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|from|export|default|async|await|new|try|catch|throw|class|extends|interface|implements|true|false|null|undefined|typeof|in|of)\b/g, '<span class="hl-keyword">$1</span>');
  html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="hl-number">$1</span>');
  html = html.replace(/(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/)/gm, '<span class="hl-comment">$1</span>');
  return html;
}

async function openPreviewDialog(file) {
  const previewType = getPreviewType(file);
  if (!previewType) { toast('该文件类型暂不支持预览'); return; }
  const previewUrl = `/api/files/${file.id}/preview?token=${encodeURIComponent(state.token)}`;
  const { mask, close } = modal(`
    <div class="preview-header">
      <h3 style="margin:0;">预览：${esc(file.name)}</h3>
      <button class="btn secondary" id="previewClose">关闭</button>
    </div>
    <div id="previewBody" class="preview-body"></div>
  `);

  const body = mask.querySelector('#previewBody');
  const setError = (msg) => {
    body.innerHTML = `<div class="preview-empty">${esc(msg)}</div>`;
  };

  try {
    if (previewType === 'image') {
      body.innerHTML = `<img src="${previewUrl}" alt="${esc(file.name)}" class="preview-image" />`;
      mask.querySelector('#previewClose').onclick = close;
      return;
    }
    const res = await fetch(previewUrl, { headers: { authorization: state.token } });
    if (!res.ok) throw new Error('无法读取文件内容');
    if (previewType === 'pdf') {
      body.innerHTML = `<iframe src="${previewUrl}" title="${esc(file.name)}" class="preview-iframe"></iframe>`;
      mask.querySelector('#previewClose').onclick = close;
      return;
    }
    const text = await res.text();
    if (previewType === 'markdown') {
      body.innerHTML = renderMarkdownHtml(text);
    } else {
      body.innerHTML = `<pre class="preview-code"><code>${renderHighlightedCode(text)}</code></pre>`;
    }
    mask.querySelector('#previewClose').onclick = close;
  } catch (e) {
    setError(`预览失败：${esc(e.message)}`);
    mask.querySelector('#previewClose').onclick = close;
  }
}

function renderActionMenu(f) {
  const isDir = !!f.isDir;
  return `
    <div class="file-action-wrap">
      <button class="more-action" data-more-id="${f.id}" aria-label="更多操作">⋮</button>
      <div class="action-menu" data-menu-id="${f.id}" hidden>
        ${isDir ? `<button data-act="download-zip">打包下载</button>` : `<button data-act="download">下载</button>`}
        ${!isDir ? `<button data-act="preview">预览</button>` : ''}
        <button data-act="share">分享</button>
        <button data-act="move">移动</button>
        <button data-act="rename">重命名</button>
        <button data-act="del" class="danger-action">删除</button>
      </div>
    </div>
  `;
}

function renderFilesList(files) {
  return `
    <table class="files">
      <thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th></th></tr></thead>
      <tbody>
        ${files.length ? files.map(f => `
          <tr class="${f.isDir ? 'dir' : ''}" data-id="${f.id}" data-dir="${f.isDir ? 1 : 0}" data-name="${esc(f.name)}" data-mime-type="${esc(f.mimeType || '')}">
            <td class="name">${f.isDir ? '📁' : '📄'} ${esc(f.name)}</td>
            <td>${f.isDir ? '-' : humanSize(f.size)}</td>
            <td>${fmtTime(f.updatedAt)}</td>
            <td class="actions">${renderActionMenu(f)}</td>
          </tr>`).join('') : `<tr><td colspan="4" class="hint" style="text-align:center;padding:24px;">空目录</td></tr>`}
      </tbody>
    </table>
  `;
}

function renderFilesTile(files) {
  return `
    <div class="file-grid file-grid-${state.iconSize}">
      ${files.length ? files.map(f => `
        <div class="file-tile ${f.isDir ? 'dir' : ''}" data-id="${f.id}" data-dir="${f.isDir ? 1 : 0}" data-name="${esc(f.name)}" data-mime-type="${esc(f.mimeType || '')}">
          <div class="file-tile-main">
            <div class="file-tile-icon">${f.isDir ? '📁' : '📄'}</div>
            <div class="file-tile-name">${esc(f.name)}</div>
          </div>
          <div class="file-tile-meta">
            <span>${f.isDir ? '文件夹' : humanSize(f.size)}</span>
            <span>${fmtTime(f.updatedAt)}</span>
          </div>
          <div class="file-tile-actions">${renderActionMenu(f)}</div>
        </div>
      `).join('') : `<div class="hint" style="padding:24px;">空目录</div>`}
    </div>
  `;
}

function bindBreadcrumb() {
  app.querySelectorAll('.breadcrumb a').forEach(a => {
    a.onclick = () => {
      const idx = parseInt(a.dataset.idx, 10);
      state.stack = state.stack.slice(0, idx + 1);
      state.parentId = state.stack[state.stack.length - 1].id;
      loadFiles();
    };
  });
}

// ============== 主界面 ==============
async function renderApp() {
  if (!state.me) {
    try {
      const r = await api('/api/auth/me');
      state.me = r.data.user;
      state.needsPassword = !!r.data.needsPassword;
    } catch { renderLogin(); return; }
  }
  try {
    const site = await api('/api/site');
    const brand = $('#brand');
    if (brand) brand.textContent = site.data.siteName || '云盘';
  } catch {}
  renderUserBar();
  state.parentId = 0;
  state.stack = [{ id: 0, name: '根目录' }];
  loadFiles();
}

async function loadFiles() {
  const r = await api('/api/files?parentId=' + state.parentId);
  const { files, quota, used } = r.data;
  const pct = quota ? Math.min(100, (used / quota) * 100) : 0;

  app.innerHTML = `
    ${state.needsPassword ? `
      <div class="warning-banner">
        ⚠️ 你还没有设置密码，目前只能用 OJ 签名登录。<button class="btn" style="margin-left:12px;" id="setNowBtn">立即设置</button>
      </div>` : ''}

    <div class="card">
      <div class="row" style="justify-content: space-between; align-items:center;">
        <div class="row" style="flex: 0 0 auto; gap: 8px;">
          <button class="btn" id="upBtn">上传文件</button>
          <button class="btn secondary" id="mkBtn">新建文件夹</button>
          <button class="btn secondary" id="shBtn">我的分享</button>
          <button class="btn secondary" id="trashBtn">回收站</button>
        </div>
        <div class="hint">已用 ${humanSize(used)} / ${humanSize(quota)} (${pct.toFixed(1)}%)</div>
      </div>
      <div style="height:10px;background:#eef2fb;border-radius:6px;overflow:hidden;margin-top:10px;">
        <div style="height:100%;width:${pct}%;background:${pct > 90 ? '#e5484d' : '#4a7df3'};"></div>
      </div>
      <input id="fileInput" type="file" hidden multiple />
    </div>

    <div class="card" id="uploadProgress" hidden>
      <h3 style="margin:0 0 10px 0;">上传进度</h3>
      <div id="uploadList"></div>
    </div>

    <div class="card">
      ${renderBreadcrumb()}
      ${renderViewControls()}
      ${state.viewMode === 'tile' ? renderFilesTile(files) : renderFilesList(files)}
    </div>

    <div class="card" id="sharePanel" hidden></div>`;

  const setNowBtn = $('#setNowBtn');
  if (setNowBtn) setNowBtn.onclick = () => promptSetPassword(true);

  bindBreadcrumb();

  app.querySelectorAll('[data-view-mode]').forEach(btn => {
   btn.onclick = () => {
     state.viewMode = btn.dataset.viewMode;
     localStorage.setItem('drive-view-mode', state.viewMode);
     loadFiles();
   };
  });

  const iconSizeSelect = $('#iconSizeSelect');
  if (iconSizeSelect) {
   iconSizeSelect.onchange = () => {
     state.iconSize = iconSizeSelect.value;
     localStorage.setItem('drive-icon-size', state.iconSize);
     loadFiles();
   };
  }

  app.querySelectorAll('.dir').forEach(el => {
   const item = el.querySelector('.file-tile-main') || el.querySelector('td.name');
   if (!item) return;
   item.onclick = () => {
     const id = parseInt(el.dataset.id, 10);
     state.stack.push({ id, name: el.dataset.name });
     state.parentId = id;
     loadFiles();
   };
  });

  app.querySelectorAll('[data-id]').forEach(el => {
   const id = parseInt(el.dataset.id, 10);
   const isDir = el.dataset.dir === '1';
   el.querySelectorAll('button[data-act]').forEach(btn => {
     btn.onclick = async (ev) => {
       ev.preventDefault();
       ev.stopPropagation();
       const act = btn.dataset.act;
       try {
         if (act === 'download') {
           window.location.href = `/api/files/${id}/download?token=${encodeURIComponent(state.token)}`;
         } else if (act === 'download-zip') {
           window.location.href = `/api/files/${id}/download-zip?token=${encodeURIComponent(state.token)}`;
         } else if (act === 'preview') {
           openPreviewDialog({ id, name: el.dataset.name, isDir, mimeType: el.dataset.mimeType || '' });
         } else if (act === 'rename') {
           openRenameDialog(id, el.dataset.name);
         } else if (act === 'move') {
           openMoveDialog(id, el.dataset.name, isDir);
         } else if (act === 'del') {
           const ok = await confirmDialog(`确定移到回收站？"${el.dataset.name}"会保留 3 天且不占用空间。`, { title: '删除文件' });
           if (!ok) return;
           await api('/api/files/' + id, { method: 'DELETE' });
           loadFiles();
         } else if (act === 'share') {
           openShareDialog(id);
         }
       } catch (e) { toast(e.message); }
       const menu = app.querySelector('[data-menu-id="' + id + '"]');
       if (menu) menu.hidden = true;
     };
   });
  });

  app.querySelectorAll('.more-action').forEach(btn => {
   btn.onclick = (ev) => {
     ev.preventDefault();
     ev.stopPropagation();
     const currentMenu = app.querySelector('[data-menu-id="' + btn.dataset.moreId + '"]');
     if (!currentMenu) return;
     const shouldOpen = currentMenu.hidden;
     document.querySelectorAll('.action-menu').forEach(m => { m.hidden = true; });
     currentMenu.hidden = !shouldOpen;
   };
  });

  $('#upBtn').onclick = () => openUploadDialog();

  $('#mkBtn').onclick = () => openCreateDirDialog();

  $('#shBtn').onclick = showShares;
  $('#trashBtn').onclick = renderTrash;
}

function openCreateDirDialog() {
  const { mask, close } = modal(`
    <h3>新建文件夹</h3>
    <div class="row" style="flex-direction:column;">
      <div><label>文件夹名</label><input id="dirName" type="text" /></div>
    </div>
    <div class="actions">
      <button class="btn secondary" id="cancel">取消</button>
      <button class="btn" id="ok">创建</button>
    </div>
  `);
  mask.querySelector('#cancel').onclick = close;
  mask.querySelector('#ok').onclick = async () => {
    const name = mask.querySelector('#dirName').value.trim();
    if (!name) return toast('文件夹名不能为空');
    try {
      await api('/api/files/mkdir', { method: 'POST', body: { parentId: state.parentId, name } });
      close();
      loadFiles();
    } catch (e) { toast(e.message); }
  };
}

function openRenameDialog(fileId, currentName) {
  const { mask, close } = modal(`
    <h3>重命名</h3>
    <div class="row" style="flex-direction:column;">
      <div><label>新名称</label><input id="newName" type="text" value="${esc(currentName)}" /></div>
    </div>
    <div class="actions">
      <button class="btn secondary" id="cancel">取消</button>
      <button class="btn" id="ok">保存</button>
    </div>
  `);
  mask.querySelector('#cancel').onclick = close;
  mask.querySelector('#ok').onclick = async () => {
    const name = mask.querySelector('#newName').value.trim();
    if (!name) return toast('名称不能为空');
    try {
      await api('/api/files/' + fileId, { method: 'PATCH', body: { name } });
      close();
      loadFiles();
    } catch (e) { toast(e.message); }
  };
}

// ============== 上传（带进度） ==============
async function openUploadDialog() {
  const providerList = await api('/api/auth/providers');
  const allowedIds = getAllowedProviderIdsForUser(state.me);
  const providerOptions = providerList.data.providers.filter(p => !allowedIds || allowedIds.includes(p.id));
  if (!providerOptions.length) {
    toast('当前用户没有可用上传渠道');
    return;
  }

  const { mask, close } = modal(`
    <h3>上传文件</h3>
    <div style="margin-bottom:12px;">
      <p class="hint" style="margin:0 0 8px;">上传渠道：</p>
      <select id="uploadProviderSelect" style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:8px;">
        ${providerOptions.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
      </select>
    </div>
    <div style="margin-bottom:12px;">
      <p class="hint" style="margin:0 0 8px;">将上传到：</p>
      <div id="uploadTargetBrowser"></div>
    </div>
    <div style="margin-bottom:12px;">
      <p class="hint" style="margin:0 0 8px;">待上传文件：</p>
      <div id="uploadSelectedFiles" class="hint">未选择文件</div>
      <input id="uploadDialogInput" type="file" hidden multiple />
      <div class="actions" style="justify-content:flex-start; margin-top:8px;">
        <button class="btn secondary" id="pickUploadFiles">选择文件</button>
      </div>
    </div>
    <div class="actions">
      <button class="btn secondary" id="cancel">取消</button>
      <button class="btn" id="confirmUpload">开始上传</button>
    </div>
  `);

  const providerSelect = mask.querySelector('#uploadProviderSelect');
  if (providerOptions.length === 1) {
    providerSelect.disabled = true;
  }

  let currentPid = state.parentId;
  const stack = [{ id: 0, name: '根目录' }];
  let selectedFiles = [];

  function renderSelectedFiles() {
    const el = mask.querySelector('#uploadSelectedFiles');
    if (!selectedFiles.length) {
      el.textContent = '未选择文件';
      return;
    }
    el.innerHTML = selectedFiles.map(f => `<div>${esc(f.name)} (${humanSize(f.size)})</div>`).join('');
  }

  async function renderBrowser() {
    const el = mask.querySelector('#uploadTargetBrowser');
    try {
      const r = await api('/api/files?parentId=' + currentPid);
      const dirs = r.data.files.filter(f => f.isDir);
      el.innerHTML = `
        <div class="breadcrumb">${stack.map((s, i) => `<a data-idx="${i}">${esc(s.name)}</a>`).join(' / ')}</div>
        <div class="move-list">
          ${dirs.length ? dirs.map(d => `<div class="move-dir" data-id="${d.id}" data-name="${esc(d.name)}">📁 ${esc(d.name)}</div>`).join('') : '<p class="hint" style="padding:8px;">（无子文件夹）</p>'}
        </div>
      `;
      el.querySelectorAll('.breadcrumb a').forEach(a => {
        a.onclick = () => {
          const idx = parseInt(a.dataset.idx, 10);
          stack.splice(idx + 1);
          currentPid = stack[stack.length - 1].id;
          renderBrowser();
        };
      });
      el.querySelectorAll('.move-dir').forEach(d => {
        d.onclick = () => {
          currentPid = parseInt(d.dataset.id, 10);
          stack.push({ id: currentPid, name: d.dataset.name });
          renderBrowser();
        };
      });
    } catch (e) {
      el.innerHTML = `<p class="hint">加载目标目录失败：${esc(e.message)}</p>`;
    }
  }

  const fileInput = mask.querySelector('#uploadDialogInput');
  mask.querySelector('#pickUploadFiles').onclick = () => fileInput.click();
  fileInput.onchange = () => {
    selectedFiles = Array.from(fileInput.files || []);
    renderSelectedFiles();
  };

  await renderBrowser();
  renderSelectedFiles();
  mask.querySelector('#cancel').onclick = close;
  mask.querySelector('#confirmUpload').onclick = async () => {
    try {
      if (!selectedFiles.length) return toast('请选择文件');
      const providerId = Number.parseInt(providerSelect.value, 10);
      await uploadMultiple(selectedFiles, currentPid, providerId);
      close();
      loadFiles();
    } catch (e) {
      toast(e.message);
    }
  };
}

function uploadOne(file, parentId, providerId, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload');
    xhr.setRequestHeader('authorization', state.token);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data && data.status === 200) {
        resolve(data);
      } else {
        if (xhr.status === 401) {
          setToken(''); state.me = null; renderLogin();
        }
        reject(new Error((data && data.msg) || ('HTTP ' + xhr.status)));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));

    const fd = new FormData();
    fd.append('parentId', String(parentId));
    if (providerId != null && Number.isFinite(providerId)) {
      fd.append('providerId', String(providerId));
    }
    fd.append('file', file);
    xhr.send(fd);
  });
}

async function uploadMultiple(files, parentId = state.parentId, providerId = null) {
  const panel = $('#uploadProgress');
  const list = $('#uploadList');
  panel.hidden = false;
  list.innerHTML = '';

  const items = files.map((f, idx) => {
    const id = 'upl_' + idx + '_' + Date.now();
    const div = document.createElement('div');
    div.className = 'upload-item';
    div.innerHTML = `
      <div class="upload-name">${esc(f.name)} <span class="hint">(${humanSize(f.size)})</span></div>
      <div class="upload-bar"><div class="upload-fill" style="width:0%"></div></div>
      <div class="upload-pct">排队中</div>`;
    list.appendChild(div);
    return { id, file: f, div };
  });

  for (const item of items) {
    const fill = item.div.querySelector('.upload-fill');
    const pct  = item.div.querySelector('.upload-pct');
    try {
      pct.textContent = '0%';
      await uploadOne(item.file, parentId, providerId, (loaded, total) => {
        const p = Math.min(100, (loaded / total) * 100);
        fill.style.width = p.toFixed(1) + '%';
        pct.textContent = p.toFixed(0) + '%';
      });
      fill.style.width = '100%';
      fill.style.background = '#2ea043';
      pct.textContent = '✅ 完成';
    } catch (e) {
      fill.style.width = '100%';
      fill.style.background = '#e5484d';
      pct.textContent = '❌ ' + e.message;
    }
  }

  setTimeout(() => {
    panel.hidden = true;
    list.innerHTML = '';
  }, 5000);
}

// ============== 移动对话框 ==============
async function openMoveDialog(fileId, fileName, isDir) {
  const { mask, close } = modal(`
    <h3>移动 "${esc(fileName)}" 到...</h3>
    <div id="moveBrowser"></div>
    <div class="actions">
      <button class="btn secondary" id="c">取消</button>
      <button class="btn" id="ok">移动到这里</button>
    </div>`);

  let currentPid = 0;
  const stack = [{ id: 0, name: '根目录' }];

  async function renderBrowser() {
    const r = await api('/api/files?parentId=' + currentPid);
    const dirs = r.data.files.filter(f => f.isDir);
    const el = mask.querySelector('#moveBrowser');
    el.innerHTML = `
      <div class="breadcrumb">${stack.map((s, i) =>
        `<a data-idx="${i}">${esc(s.name)}</a>`).join(' / ')}</div>
      <div class="move-list">
        ${dirs.length ? dirs.map(d => {
          // 不能移动到自己里面
          if (isDir && d.id === fileId) return '';
          return `<div class="move-dir" data-id="${d.id}" data-name="${esc(d.name)}">
            📁 ${esc(d.name)}
          </div>`;
        }).join('') : '<p class="hint" style="padding:8px;">（无子文件夹）</p>'}
      </div>`;
    el.querySelectorAll('.breadcrumb a').forEach(a => {
      a.onclick = () => {
        const idx = parseInt(a.dataset.idx, 10);
        stack.splice(idx + 1);
        currentPid = stack[stack.length - 1].id;
        renderBrowser();
      };
    });
    el.querySelectorAll('.move-dir').forEach(d => {
      d.onclick = () => {
        currentPid = parseInt(d.dataset.id, 10);
        stack.push({ id: currentPid, name: d.dataset.name });
        renderBrowser();
      };
    });
  }

  try { await renderBrowser(); } catch (e) { toast(e.message); close(); return; }

  mask.querySelector('#c').onclick = close;
  mask.querySelector('#ok').onclick = async () => {
    try {
      await api(`/api/files/${fileId}/move`, { method: 'POST', body: { parentId: currentPid } });
      close();
      toast('已移动');
      loadFiles();
    } catch (e) { toast(e.message); }
  };
}

// ============== 分享对话框 ==============
function openShareDialog(fileId) {
  const { mask, close } = modal(`
    <h3>创建分享</h3>
    <div class="row" style="flex-direction:column;">
      <div><label>有效期（秒，留空永久）</label><input id="exp" type="number" min="60" placeholder="86400"/></div>
      <div><label>最大下载次数（留空不限）</label><input id="max" type="number" min="1"/></div>
      <div><label>访问密码（可选）</label><input id="pw" type="text"/></div>
    </div>
    <div class="actions">
      <button class="btn secondary" id="c">取消</button>
      <button class="btn" id="ok">创建</button>
    </div>`);
  mask.querySelector('#c').onclick = close;
  mask.querySelector('#ok').onclick = async () => {
    try {
      const body = {
        fileId,
        expiresIn: $('#exp').value ? parseInt($('#exp').value, 10) : null,
        maxDownloads: $('#max').value ? parseInt($('#max').value, 10) : null,
        password: $('#pw').value || null,
      };
      const r = await api('/api/shares', { method: 'POST', body });
      const url = location.origin + r.data.url;
      close();
      const m2 = modal(`
        <h3>分享已创建</h3>
        <p class="hint">把链接发给对方：</p>
        <div class="share-line"><input type="text" value="${esc(url)}" readonly /><button class="btn" id="cp">复制</button></div>
        ${r.data.hasPassword ? '<p class="hint">访问密码已在创建时设置，请单独告知对方。</p>' : ''}
        <div class="actions"><button class="btn" id="done">关闭</button></div>`);
      m2.mask.querySelector('#cp').onclick = async () => {
        try { await navigator.clipboard.writeText(url); toast('已复制'); }
        catch { toast('复制失败'); }
      };
      m2.mask.querySelector('#done').onclick = m2.close;
    } catch (e) { toast(e.message); }
  };
}

async function showShares() {
  const r = await api('/api/shares');
  const panel = $('#sharePanel');
  panel.hidden = false;
  const list = r.data.shares;
  panel.innerHTML = `
    <h2>我的分享</h2>
    ${list.length ? `<table class="files">
      <thead><tr><th>文件</th><th>剩余</th><th>下载</th><th>过期</th><th>链接</th><th></th></tr></thead>
      <tbody>${list.map(s => `
        <tr>
          <td>${esc(s.fileName)}</td>
          <td>${s.maxDownloads != null ? (s.maxDownloads - s.downloadCount) : '不限'}</td>
          <td>${s.downloadCount}</td>
          <td>${s.expiresAt ? fmtTime(s.expiresAt) : '永久'}</td>
          <td><a href="${esc(location.origin + s.url)}" target="_blank">${esc(s.code)}</a>${s.hasPassword ? ' 🔒' : ''}</td>
          <td class="actions"><button data-code="${esc(s.code)}">取消</button></td>
        </tr>`).join('')}</tbody>
    </table>` : `<p class="hint">还没有分享。</p>`}`;
  panel.querySelectorAll('button[data-code]').forEach(b => {
    b.onclick = async () => {
      const ok = await confirmDialog('取消分享？', { title: '取消分享' });
      if (!ok) return;
      try {
        await api('/api/shares/' + b.dataset.code, { method: 'DELETE' });
        showShares();
      } catch (e) { toast(e.message); }
    };
  });
}

async function renderTrash() {
  try {
    const r = await api('/api/files/trash');
    const items = r.data.items || [];
    app.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <h2>回收站</h2>
          <button class="btn secondary" id="backFromTrash">返回云盘</button>
        </div>
        <p class="hint">已删除文件会保留 3 天，且不计入存储空间。</p>
      </div>
      <div class="card">
        ${items.length ? `<table class="files">
          <thead><tr><th>名称</th><th>类型</th><th>大小</th><th>删除时间</th><th>保留到</th><th></th></tr></thead>
          <tbody>${items.map(item => `
            <tr>
              <td>${esc(item.name)}</td>
              <td>${item.isDir ? '文件夹' : '文件'}</td>
              <td>${item.isDir ? '-' : humanSize(item.size)}</td>
              <td>${fmtTime(item.deletedAt)}</td>
              <td>${item.expiresAt ? fmtTime(item.expiresAt) : '—'}</td>
              <td class="actions">
                <button data-trash-restore="${item.id}">恢复</button>
                <button data-trash-delete="${item.id}" style="color:#e5484d;border-color:#e5484d;">彻底删除</button>
              </td>
            </tr>`).join('')}</tbody>
        </table>` : `<p class="hint">回收站为空。</p>`}
      </div>
    `;
    $('#backFromTrash').onclick = loadFiles;
    app.querySelectorAll('[data-trash-restore]').forEach(btn => {
      btn.onclick = async () => {
        try {
          await api('/api/files/' + btn.dataset.trashRestore + '/restore', { method: 'POST' });
          toast('已恢复');
          renderTrash();
        } catch (e) { toast(e.message); }
      };
    });
    app.querySelectorAll('[data-trash-delete]').forEach(btn => {
      btn.onclick = async () => {
        const ok = await confirmDialog('确认彻底删除？这将无法恢复。', { title: '彻底删除' });
        if (!ok) return;
        try {
          await api('/api/files/' + btn.dataset.trashDelete + '?permanent=1', { method: 'DELETE' });
          toast('已彻底删除');
          renderTrash();
        } catch (e) { toast(e.message); }
      };
    });
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="hint">加载回收站失败：${esc(e.message)}</p></div>`;
  }
}

async function renderAdmin(tabName = state.adminTab || 'dashboard') {
  if (!['admin', 'root'].includes(state.me.role)) return;
  state.adminTab = tabName;
  app.innerHTML = `<div class="card"><p class="hint">加载中…</p></div>`;
  try {
    const [providers, users, stats, site] = await Promise.all([
      api('/api/admin/providers').catch(() => ({ data: { providers: [] } })),
      api('/api/admin/users').catch(() => ({ data: { users: [] } })),
      api('/api/admin/stats').catch(() => ({ data: {} })),
      api('/api/admin/site').catch(() => ({ data: { siteName: '云盘', siteDescription: '', siteFooter: '' } })),
    ]);
    state.siteSettings = site.data;

    const tabs = [
      { key: 'dashboard', label: '仪表盘' },
      { key: 'users', label: '用户管理' },
      { key: 'providers', label: '云盘核心（OJ列表）' },
      { key: 'site', label: '网站管理' },
    ];

    const renderDashboard = () => `
      <div class="card">
        <h2>仪表盘</h2>
        <div class="row">
          <div class="stat-box"><strong>${stats.data.users ?? 0}</strong><span>用户</span></div>
          <div class="stat-box"><strong>${stats.data.files ?? 0}</strong><span>文件</span></div>
          <div class="stat-box"><strong>${stats.data.shares ?? 0}</strong><span>分享</span></div>
          <div class="stat-box"><strong>${humanSize(stats.data.usedBytes ?? 0)}</strong><span>已用</span></div>
        </div>
      </div>
    `;

    const renderUsers = () => `
      <div class="card">
        <h2>用户</h2>
        <table class="files">
          <thead><tr><th>#</th><th>用户名</th><th>角色</th><th>配额/已用</th><th>OJ</th><th>存储渠道</th><th>密码</th><th></th></tr></thead>
          <tbody>${users.data.users.map(u => `
            <tr><td>${u.id}</td><td>${esc(u.username)}</td><td>${u.role}</td>
            <td>${humanSize(u.used)} / ${humanSize(u.quota)}</td>
            <td>${u.ojProviderId ? 'p' + u.ojProviderId + ' ' + esc(u.ojUsername || '') : '-'}</td>
            <td>${u.storageProviderIds && u.storageProviderIds.length ? u.storageProviderIds.join(', ') : (u.ojProviderId ? '默认:' + u.ojProviderId : '未设定')}</td>
            <td>${u.hasPassword ? '✅' : '❌'}</td>
            <td class="actions">
              <button data-quota="${u.id}">改配额</button>
              <button data-pw="${u.id}">改密码</button>
              ${state.me.role === 'root' && u.id !== state.me.id ? `<button data-del-user="${u.id}" style="color:#e5484d;">删除</button>` : ''}
              <button data-channel="${u.id}">存储渠道</button>
            </td></tr>`).join('')}
          </tbody>
        </table>
        <div class="row" style="margin-top:12px; flex-direction:column;">
          <h3 style="margin:0;">新建本地账号</h3>
          <div class="row">
            <div><label>用户名</label><input id="uName" type="text"/></div>
            <div><label>密码</label><input id="uPass" type="text"/></div>
            <div><label>配额(MB)</label><input id="uQuota" type="number" value="1024"/></div>
            <div><label>角色</label><input id="uRole" type="text" value="user" placeholder="user/admin"/></div>
          </div>
          <div>
            <label>可用存储渠道（可选，管理员创建用户可指定）</label>
            <select id="uProviders" multiple size="6" style="width:100%;padding:8px;border-radius:8px;border:1px solid #d0d5dd;">
              ${providers.data.providers.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">无</option>'}
            </select>
          </div>
          <div><button class="btn" id="uAdd">创建</button></div>
        </div>
      </div>
    `;

    const renderProviders = () => `
      <div class="card">
        <h2>OJ 存储提供方</h2>
        <table class="files" id="providerTable">
          <thead><tr><th>#</th><th>名称</th><th>Base</th><th>gid</th><th>启用</th><th>排序</th><th></th></tr></thead>
          <tbody>${providers.data.providers.map((p, idx) => `
            <tr data-provider-id="${p.id}"><td>${p.id}</td><td>${esc(p.name)}</td>
            <td>${esc(p.base_url)}</td>
            <td>${esc(p.upload_gid || '-')}</td>
            <td>${p.enabled ? '✅' : '❌'}</td>
            <td>${idx + 1}</td>
            <td class="actions"><button data-del-provider="${p.id}">删除</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div class="row" style="margin-top:12px; flex-direction:column;">
          <h3 style="margin:0;">新增</h3>
          <div class="row">
            <div><label>名称</label><input id="pName" type="text"/></div>
            <div><label>Base URL</label><input id="pBase" type="text" placeholder="http://ssf.hdoi.cn"/></div>
          </div>
          <div class="row">
            <div><label>上传账号</label><input id="pUser" type="text"/></div>
            <div><label>上传密码</label><input id="pPass" type="password"/></div>
            <div><label>gid</label><input id="pGid" type="text"/></div>
          </div>
          <div><button class="btn" id="pAdd">创建</button></div>
        </div>
      </div>
    `;

    const renderSite = () => `
      <div class="card">
        <h2>网站管理</h2>
        <div class="row" style="flex-direction:column;">
          <div><label>站点名称</label><input id="siteName" type="text" value="${esc(state.siteSettings.siteName || '云盘')}"/></div>
          <div><label>站点描述</label><textarea id="siteDescription" rows="3" style="width:100%;padding:9px 12px;border:1px solid #d0d5dd;border-radius:8px;">${esc(state.siteSettings.siteDescription || '')}</textarea></div>
          <div><label>页脚/版权</label><textarea id="siteFooter" rows="3" style="width:100%;padding:9px 12px;border:1px solid #d0d5dd;border-radius:8px;">${esc(state.siteSettings.siteFooter || '')}</textarea></div>
          <div><button class="btn" id="siteSave">保存网站信息</button></div>
        </div>
      </div>
    `;

    app.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <h2>管理后台</h2>
          <button class="btn secondary" id="back">返回云盘</button>
        </div>
        <div class="tabs" style="margin-top:12px;">
          ${tabs.map(t => `<button class="${t.key === tabName ? 'active' : ''}" data-admin-tab="${t.key}">${t.label}</button>`).join('')}
        </div>
        <p class="hint">用户 ${stats.data.users ?? 0} · 文件 ${stats.data.files ?? 0} · 分享 ${stats.data.shares ?? 0} · 已用 ${humanSize(stats.data.usedBytes ?? 0)}</p>
      </div>
      ${tabName === 'dashboard' ? renderDashboard() : ''}
      ${tabName === 'users' ? renderUsers() : ''}
      ${tabName === 'providers' ? renderProviders() : ''}
      ${tabName === 'site' ? renderSite() : ''}
    `;

    const back = $('#back');
    if (back) back.onclick = renderApp;
    app.querySelectorAll('[data-admin-tab]').forEach(btn => {
      btn.onclick = () => renderAdmin(btn.dataset.adminTab);
    });

    if (tabName === 'providers') {
      const rows = [...app.querySelectorAll('#providerTable tbody tr')];
      rows.forEach((row) => {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', row.dataset.providerId);
        });
        row.addEventListener('dragover', (e) => e.preventDefault());
        row.addEventListener('drop', async (e) => {
          e.preventDefault();
          const fromId = Number.parseInt(e.dataTransfer.getData('text/plain'), 10);
          const toId = Number.parseInt(row.dataset.providerId, 10);
          if (!fromId || !toId || fromId === toId) return;
          const order = rows.map(r => Number.parseInt(r.dataset.providerId, 10)).filter(v => !Number.isNaN(v));
          const moving = order.splice(order.indexOf(fromId), 1)[0];
          const targetIndex = order.indexOf(toId);
          order.splice(targetIndex + 1, 0, moving);
          try {
            await api('/api/admin/providers/reorder', { method: 'POST', body: { order } });
            renderAdmin('providers');
          } catch (err) { toast(err.message); }
        });
      });
    }

    if (tabName === 'site') {
      const siteSave = $('#siteSave');
      if (siteSave) {
        siteSave.onclick = async () => {
          try {
            await api('/api/admin/site', {
              method: 'PATCH',
              body: {
                siteName: $('#siteName').value,
                siteDescription: $('#siteDescription').value,
                siteFooter: $('#siteFooter').value,
              }
            });
            toast('已保存');
          } catch (e) { toast(e.message); }
        };
      }
    }

    app.querySelectorAll('button[data-del-provider]').forEach(b => {
      b.onclick = async () => {
        const ok = await confirmDialog('删除该 OJ 提供方？', { title: '删除 OJ 提供方' });
        if (!ok) return;
        try {
          await api('/api/admin/providers/' + b.dataset.delProvider, { method: 'DELETE' });
          renderAdmin('providers');
        } catch (e) { toast(e.message); }
      };
    });
    const pAdd = $('#pAdd');
    if (pAdd) {
      pAdd.onclick = async () => {
        try {
          await api('/api/admin/providers', {
            method: 'POST',
            body: {
              name: $('#pName').value,
              base_url: $('#pBase').value,
              upload_username: $('#pUser').value,
              upload_password: $('#pPass').value,
              upload_gid: $('#pGid').value,
            },
          });
          renderAdmin('providers');
        } catch (e) { toast(e.message); }
      };
    }

    app.querySelectorAll('button[data-quota]').forEach(b => {
      b.onclick = async () => {
        const mb = await promptDialog({ title: '修改配额', label: '新的配额(MB)', type: 'number' });
        if (mb == null || mb === '') return;
        try {
          await api('/api/admin/users/' + b.dataset.quota, { method: 'PATCH', body: { quotaMB: parseInt(mb, 10) } });
          toast('已更新'); renderAdmin('users');
        } catch (e) { toast(e.message); }
      };
    });
    app.querySelectorAll('button[data-pw]').forEach(b => {
      b.onclick = async () => {
        const pw = await promptDialog({ title: '修改密码', label: '新密码', type: 'password' });
        if (pw == null || pw === '') return;
        try {
          await api('/api/admin/users/' + b.dataset.pw, { method: 'PATCH', body: { password: pw } });
          toast('已更新');
        } catch (e) { toast(e.message); }
      };
    });
    app.querySelectorAll('button[data-del-user]').forEach(b => {
      b.onclick = async () => {
        const ok = await confirmDialog('删除该用户及其所有文件？', { title: '删除用户' });
        if (!ok) return;
        try {
          await api('/api/admin/users/' + b.dataset.delUser, { method: 'DELETE' });
          renderAdmin('users');
        } catch (e) { toast(e.message); }
      };
    });
    app.querySelectorAll('button[data-channel]').forEach(b => {
      b.onclick = async () => {
        const userId = Number.parseInt(b.dataset.channel, 10);
        const user = users.data.users.find(u => u.id === userId);
        const selects = providers.data.providers.map(p => `<option value="${p.id}" ${user && user.storageProviderIds && user.storageProviderIds.includes(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
        const allowAny = user && (user.role === 'admin' || user.role === 'root' || !user.ojProviderId);
        const current = user && user.storageProviderIds ? user.storageProviderIds.join(',') : (user && user.ojProviderId ? String(user.ojProviderId) : '');
        const { mask, close } = modal(`
          <h3>修改存储渠道</h3>
          <p class="hint">${allowAny ? '管理员/未绑定 OJ 用户可选择任意一个或留空为全部默认。普通用户只能绑定注册 OJ。' : '普通用户只能使用自己注册用的 OJ。'}</p>
          <div class="row" style="flex-direction:column;">
            <label>可用存储渠道</label>
            <select id="channelSelect" multiple size="8" style="width:100%;padding:8px;border-radius:8px;border:1px solid #d0d5dd;">
              ${selects || '<option value="">无</option>'}
            </select>
          </div>
          <div class="actions">
            <button class="btn secondary" id="c">取消</button>
            <button class="btn" id="ok">保存</button>
          </div>`);
        mask.querySelector('#c').onclick = close;
        mask.querySelector('#ok').onclick = async () => {
          try {
            const selected = [...mask.querySelectorAll('#channelSelect option:checked')].map(o => Number.parseInt(o.value, 10)).filter(v => Number.isInteger(v) && v > 0);
            if (!allowAny && user && user.ojProviderId && !(selected.length === 1 && selected[0] === user.ojProviderId)) {
              throw new Error('普通用户只能使用其注册用的 OJ');
            }
            if (!allowAny && user && !user.ojProviderId && selected.length > 1) {
              throw new Error('普通用户最多只能使用 1 种存储渠道');
            }
            await api('/api/admin/users/' + userId, { method: 'PATCH', body: { storageProviderIds: selected } });
            toast('已保存');
            close();
            renderAdmin('users');
          } catch (e) { toast(e.message); }
        };
      };
    });
    const uAdd = $('#uAdd');
    if (uAdd) {
      uAdd.onclick = async () => {
        try {
          const providerSelect = $('#uProviders');
          const selected = providerSelect ? [...providerSelect.selectedOptions].map(o => Number.parseInt(o.value, 10)).filter(v => Number.isInteger(v) && v > 0) : [];
          await api('/api/admin/users', {
            method: 'POST',
            body: {
              username: $('#uName').value,
              password: $('#uPass').value,
              quotaMB: parseInt($('#uQuota').value, 10),
              role: $('#uRole').value,
              storageProviderIds: selected,
            },
          });
          renderAdmin('users');
        } catch (e) { toast(e.message); }
      };
    }
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="hint">加载失败：${esc(e.message)}</p></div>`;
  }
}

// ============== 短链页面 ==============
async function renderSharePage(code) {
  app.innerHTML = `<div class="card"><p class="hint">加载中…</p></div>`;
  try {
    let password = '';
    let info;
    while (true) {
      try {
        info = (await api(`/s/${code}${password ? '?password=' + encodeURIComponent(password) : ''}`)).data;
        break;
      } catch (e) {
        if (e.message.includes('密码') || e.message.includes('401')) {
          const p = prompt('该分享需要密码：');
          if (p === null) { app.innerHTML = `<div class="card"><p class="hint">已取消</p></div>`; return; }
          password = p;
          continue;
        }
        throw e;
      }
    }
    app.innerHTML = `
      <div class="card">
        <h2>${esc(info.name)}</h2>
        <p class="hint">大小：${humanSize(info.size)}</p>
        <p class="hint">过期时间：${info.expiresAt ? fmtTime(info.expiresAt) : '永久'}</p>
        <p class="hint">剩余下载：${info.remainingDownloads == null ? '不限' : info.remainingDownloads}</p>
        <button class="btn" id="dl">下载</button>
      </div>`;
    $('#dl').onclick = () => {
      const u = `/s/${code}/download${password ? '?password=' + encodeURIComponent(password) : ''}`;
      window.location.href = u;
    };
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="hint">${esc(e.message)}</p></div>`;
  }
}

// ============== 启动 ==============
(async function boot() {
  // const m = location.pathname.match(/^\/s\/([a-z0-9]+)\/?$/i);
  // if (m) return renderSharePage(m[1]);
  if (!state.token) return renderLogin();
  try {
    const r = await api('/api/auth/me');
    state.me = r.data.user;
    state.needsPassword = !!r.data.needsPassword;
    renderApp();
  } catch { renderLogin(); }
})();