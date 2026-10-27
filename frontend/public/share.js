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

  async function loadInfo(password) {
    const url = `/api/share/${encodeURIComponent(code)}` +
      (password ? '?password=' + encodeURIComponent(password) : '');
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

  (async function boot() {
    try {
      const { res, data } = await loadInfo();
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
  })();
})();