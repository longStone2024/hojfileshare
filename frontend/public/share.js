(function () {
  const $ = (sel, r = document) => r.querySelector(sel);
  const app = $('#app');

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
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

  // 从 /s/abc123 提取 code
  const m = location.pathname.match(/^\/s\/([a-z0-9]+)\/?$/i);
  if (!m) {
    app.innerHTML = `<div class="card share-card">
      <h2 style="margin-top:0;">无效的分享链接</h2>
      <p class="hint">链接格式不正确。</p>
      <a href="/" style="color:#4a7df3;text-decoration:none;">返回首页</a>
    </div>`;
    return;
  }
  const code = m[1];

  let currentPassword = '';

  function getCurrentPath() {
    const params = new URLSearchParams(location.search || '');
    return params.get('path') || '';
  }

  function buildSharePageUrl(path = '') {
    const url = new URL(location.href);
    if (currentPassword) url.searchParams.set('password', currentPassword);
    if (path) url.searchParams.set('path', path);
    else url.searchParams.delete('path');
    return url.pathname + (url.search || '');
  }

  function goToPath(path) {
    const next = buildSharePageUrl(path);
    history.pushState({}, '', next);
    boot();
  }

  async function loadInfo(password, path = getCurrentPath()) {
    const params = new URLSearchParams();
    if (password) params.set('password', password);
    if (path) params.set('path', path);
    const url = `/api/share/${encodeURIComponent(code)}` + (params.toString() ? `?${params.toString()}` : '');
    const res = await fetch(url);
    let data = null;
    try { data = await res.json(); } catch {}
    return { res, data };
  }

  function renderError(msg) {
    app.innerHTML = `
      <div class="card share-card">
        <div class="share-icon">⚠️</div>
        <h2 style="margin-top:0;">无法访问</h2>
        <p class="hint">${esc(msg)}</p>
        <a href="/" style="color:#4a7df3;text-decoration:none;display:inline-block;margin-top:16px;">返回首页</a>
      </div>`;
  }

  function renderInfo(info) {
    if (info.isDir) {
      const items = Array.isArray(info.items) ? info.items : [];
      const files = items.filter(item => !item.isDir);
      const breadcrumb = Array.isArray(info.breadcrumb) ? info.breadcrumb : [];
      const currentPath = info.currentPath || '';
      const parentPath = info.parentPath || (currentPath ? currentPath.split('/').slice(0, -1).join('/') : '');
      const pathLink = (seg, idx) => {
        const segs = breadcrumb.slice(0, idx + 1);
        const next = segs.join('/');
        const params = new URLSearchParams(location.search || '');
        params.set('path', next);
        return `${location.pathname}?${params.toString()}`;
      };
      app.innerHTML = `
        <div class="card share-card">
          <div class="share-icon">📁</div>
          <h2 class="share-file-name">${esc(info.name)}</h2>
          <div class="share-meta">
            <span>类型：<b>文件夹</b></span>
            <span>文件数：<b>${files.length}</b></span>
            <span>过期时间：<b>${info.expiresAt ? fmtTime(info.expiresAt) : '永久有效'}</b></span>
            <span>剩余下载：<b>${info.remainingDownloads == null ? '不限次数' : info.remainingDownloads + ' 次'}</b></span>
          </div>
          <div class="row" style="justify-content:flex-start;margin:10px 0 16px;gap:12px;flex-wrap:wrap;">
            ${currentPath ? `<button class="btn secondary" data-share-nav="${esc(parentPath || '')}">⬅ 返回上级</button>` : ''}
            <button class="download-btn" id="downloadAllBtn">📦 当前目录打包下载</button>
          </div>
          <div class="share-file-list" style="display:flex;flex-direction:column;gap:8px;">
            ${breadcrumb.length ? `<div class="hint" style="padding:6px 0;">路径：${breadcrumb.map((seg, idx) => `<a href="${pathLink(seg, idx)}" style="color:#4a7df3;">${esc(seg)}</a>`).join(' / ')}</div>` : ''}
            ${items.length ? items.map(item => `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px;border:1px solid #edf2f7;border-radius:8px;background:#fafbff;">
                <div style="min-width:0;flex:1;">
                  <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(item.relativePath || item.name)}</div>
                  <div class="hint" style="font-size:12px;">${item.isDir ? '文件夹' : humanSize(item.size)}</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                  ${item.isDir ? `<button class="btn secondary" data-dir-path="${esc(item.relativePath)}">打开</button>` : `<button class="btn" data-file-id="${item.id}">下载</button>`}
                </div>
              </div>
            `).join('') : '<div class="hint">此目录为空</div>'}
          </div>
          <div class="share-footer" style="margin-top:16px;">
            由 HOJ云盘提供分享服务 · <a href="/">访问主页</a>
          </div>
        </div>`;
      const allBtn = $('#downloadAllBtn');
      if (allBtn) {
        allBtn.onclick = () => {
          const params = new URLSearchParams();
          if (currentPassword) params.set('password', currentPassword);
          if (currentPath) params.set('path', currentPath);
          const u = `/api/share/${encodeURIComponent(code)}/download${params.toString() ? `?${params.toString()}` : ''}`;
          window.location.href = u;
        };
      }
      app.querySelectorAll('[data-dir-path]').forEach(btn => {
        btn.onclick = () => {
          const raw = (btn.dataset.dirPath || '').replace(/^\/+/, '');
          const nextPath = raw.includes('/') ? raw : ((currentPath ? `${currentPath}/` : '') + raw);
          goToPath(nextPath);
        };
      });
      app.querySelectorAll('[data-share-nav]').forEach(btn => {
        btn.onclick = () => {
          const nextPath = (btn.dataset.shareNav || '').trim();
          goToPath(nextPath);
        };
      });
      app.querySelectorAll('[data-file-id]').forEach(btn => {
        btn.onclick = () => {
          const fileId = encodeURIComponent(btn.dataset.fileId);
          const params = new URLSearchParams();
          params.set('fileId', fileId);
          if (currentPassword) params.set('password', currentPassword);
          if (currentPath) params.set('path', currentPath);
          const u = `/api/share/${encodeURIComponent(code)}/download?${params.toString()}`;
          window.location.href = u;
        };
      });
      return;
    }

    app.innerHTML = `
      <div class="card share-card">
        <div class="share-icon">📄</div>
        <h2 class="share-file-name">${esc(info.name)}</h2>
        <div class="share-meta">
          <span>大小：<b>${humanSize(info.size)}</b></span>
          <span>过期时间：<b>${info.expiresAt ? fmtTime(info.expiresAt) : '永久有效'}</b></span>
          <span>剩余下载：<b>${info.remainingDownloads == null ? '不限次数' : info.remainingDownloads + ' 次'}</b></span>
        </div>
        <button class="download-btn" id="downloadBtn">📥 下载文件</button>
        <div class="share-footer">
          由 HOJ云盘提供分享服务 · <a href="/">访问主页</a>
        </div>
      </div>`;
    $('#downloadBtn').onclick = () => {
      const u = `/api/share/${encodeURIComponent(code)}/download` +
        (currentPassword ? '?password=' + encodeURIComponent(currentPassword) : '');
      window.location.href = u;
    };
  }

  function renderPasswordPrompt(errorMsg) {
    app.innerHTML = `
      <div class="card share-card">
        <div class="share-icon">🔒</div>
        <h2 style="margin-top:0;">需要访问密码</h2>
        <p class="hint">此分享受密码保护，请输入分享者提供的密码：</p>
        <div class="pw-group">
          <input type="password" id="pwInput" placeholder="输入密码" autocomplete="off" />
          <button id="pwSubmit">验证</button>
        </div>
        <div class="error-msg" id="pwErr">${esc(errorMsg || '')}</div>
        <div class="share-footer">
          由 HOJ云盘提供分享服务 · <a href="/">访问主页</a>
        </div>
      </div>`;

    const input = $('#pwInput');
    const submit = async () => {
      const pw = input.value;
      if (!pw) return;
      $('#pwErr').textContent = '';
      const btn = $('#pwSubmit');
      btn.disabled = true;
      try {
        const { res, data } = await loadInfo(pw);
        if (res.ok && data && data.status === 200) {
          currentPassword = pw;
          renderInfo(data.data);
        } else {
          $('#pwErr').textContent = (data && data.msg) || '密码错误';
          btn.disabled = false;
          input.select();
        }
      } catch (e) {
        $('#pwErr').textContent = '网络错误：' + e.message;
        btn.disabled = false;
      }
    };
    $('#pwSubmit').onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    input.focus();
  }

  async function boot() {
    const curPath = getCurrentPath();
    try {
      const { res, data } = await loadInfo(currentPassword, curPath);
      if (res.ok && data && data.status === 200) {
        renderInfo(data.data);
        return;
      }
      if (res.status === 401 || (data && data.status === 401)) {
        renderPasswordPrompt('');
        return;
      }
      renderError((data && data.msg) || '分享不可用');
    } catch (e) {
      renderError('网络错误：' + e.message);
    }
  }

  boot();
  window.addEventListener('popstate', () => {
    boot();
  });
})();