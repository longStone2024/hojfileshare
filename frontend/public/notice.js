const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const userbar = document.getElementById('userbar');
const brand = document.getElementById('brand');

if (!app || !toastEl || !userbar || !brand) {
  throw new Error('公告页缺少必需节点');
}

function toast(msg, ms = 2200) {
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

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...opts.headers } });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || (data && data.status !== 200)) {
    throw new Error((data && data.msg) || ('HTTP ' + res.status));
  }
  return data;
}

function renderUserbar() {
  userbar.innerHTML = `
    <div class="user-actions">
      <button id="backHome">返回云盘</button>
      <button id="noticeBtn" class="active">公告</button>
    </div>
  `;
  document.getElementById('backHome').onclick = () => { window.location.href = '/'; };
}

async function loadNotices() {
  try {
    const r = await api('/api/notices');
    const notices = r.data.notices || [];
    app.innerHTML = `
      <div class="card">
        <h2>站点公告</h2>
        <p class="hint">请遵守平台规定，禁止上传政治敏感、淫秽、暴力、侵权及其他违法违规内容。</p>
        ${notices.length ? notices.map(n => `
          <div class="notice-item" style="padding:16px 0;border-bottom:1px solid #eef0f4;">
            <div class="notice-item-head" style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
              <strong>${esc(n.title)}</strong>
              <span class="hint">${new Date(Number(n.createdAt)).toLocaleString()}</span>
            </div>
            <div class="notice-body" style="margin-top:8px;white-space:pre-wrap;line-height:1.7;color:#334155;">${esc(n.content)}</div>
          </div>
        `).join('') : '<p class="hint">暂无公告</p>'}
      </div>
    `;
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="hint">公告加载失败：${esc(e.message)}</p></div>`;
  }
}

renderUserbar();
brand.textContent = '公告';
loadNotices();
