const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const toastEl = $('#toast');

if (!app || !toastEl) {
  throw new Error('管理后台页面缺少 app/toast 节点');
}

const state = {
  token: localStorage.getItem('token') || '',
  me: null,
  site: { siteName: '云盘', siteDescription: '', siteFooter: '' },
  tab: 'dashboard',
  providers: [],
  users: [],
  stats: {},
  notices: []
};

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

function humanSize(n) {
  if (n == null) return '-';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(1) + ' ' + units[i];
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers.authorization = state.token;
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/';
    throw new Error((data && data.msg) || '未登录');
  }
  if (!res.ok || (data && data.status !== 200)) {
    throw new Error((data && data.msg) || ('HTTP ' + res.status));
  }
  return data;
}

function renderUserbar() {
  const u = state.me || { username: '管理员', role: 'admin' };
  const userbar = $('#userbar');
  if (!userbar) return;
  userbar.innerHTML = `
    <div class="user-meta">
      <span>${esc(u.username)} <small style="opacity:.7">(${u.role})</small></span>
    </div>
    <div class="user-actions">
      <button id="noticeBtn">公告</button>
      <button id="backHome">返回云盘</button>
      <button id="logoutBtn">退出</button>
    </div>
  `;
  const noticeBtn = $('#noticeBtn');
  const backHome = $('#backHome');
  const logoutBtn = $('#logoutBtn');
  if (noticeBtn) noticeBtn.onclick = () => window.location.href = '/notice';
  if (backHome) backHome.onclick = () => window.location.href = '/';
  if (logoutBtn) logoutBtn.onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('token');
    window.location.href = '/';
  };
}

async function loadBase() {
  const [site, stats, users, providers] = await Promise.all([
    api('/api/site').catch(() => ({ data: { siteName: '云盘', siteDescription: '', siteFooter: '' } })),
    api('/api/admin/stats').catch(() => ({ data: {} })),
    api('/api/admin/users').catch(() => ({ data: { users: [] } })),
    api('/api/admin/providers').catch(() => ({ data: { providers: [] } }))
  ]);
  state.site = site.data;
  state.stats = stats.data;
  state.users = users.data.users || [];
  state.providers = providers.data.providers || [];
  try {
    const noticeRes = await api('/api/notices/manage');
    state.notices = noticeRes.data.notices || [];
  } catch {
    state.notices = [];
  }
  $('#brand').textContent = state.site.siteName || '云盘';
}

function renderDashboard() {
  return `
    <div class="card">
      <h2>仪表盘</h2>
      <div class="row">
        <div class="stat-box"><strong>${state.stats.users ?? 0}</strong><span>用户</span></div>
        <div class="stat-box"><strong>${state.stats.files ?? 0}</strong><span>文件</span></div>
        <div class="stat-box"><strong>${state.stats.shares ?? 0}</strong><span>分享</span></div>
        <div class="stat-box"><strong>${humanSize(state.stats.usedBytes ?? 0)}</strong><span>已用</span></div>
      </div>
    </div>
  `;
}

function renderUsers() {
  return `
    <div class="card">
      <h2>用户管理</h2>
      <table class="files">
        <thead><tr><th>#</th><th>用户名</th><th>角色</th><th>配额/已用</th><th>OJ</th><th>存储渠道</th><th>密码</th><th></th></tr></thead>
        <tbody>${state.users.map(u => `
          <tr>
            <td>${u.id}</td>
            <td>${esc(u.username)}</td>
            <td>${u.role}</td>
            <td>${humanSize(u.used)} / ${humanSize(u.quota)}</td>
            <td>${u.ojProviderId ? 'p' + u.ojProviderId + ' ' + esc(u.ojUsername || '') : '-'}</td>
            <td>${u.storageProviderIds && u.storageProviderIds.length ? u.storageProviderIds.join(', ') : (u.ojProviderId ? '默认:' + u.ojProviderId : '未设定')}</td>
            <td>${u.hasPassword ? '✅' : '❌'}</td>
            <td class="actions">
              <button data-quota="${u.id}">改配额</button>
              <button data-pw="${u.id}">改密码</button>
              <button data-channel="${u.id}">存储渠道</button>
              <button data-recalc-user="${u.id}">重算用量</button>
              ${state.me.role === 'root' && u.id !== state.me.id ? `<button data-del-user="${u.id}" style="color:#e5484d;">删除</button>` : ''}
            </td>
          </tr>
        `).join('')}</tbody>
      </table>
      <div class="row" style="margin-top:12px; flex-direction:column;">
        <h3 style="margin:0;">新建本地账号</h3>
        <div class="row">
          <div><label>用户名</label><input id="uName" type="text" /></div>
          <div><label>密码</label><input id="uPass" type="password" /></div>
          <div><label>配额(MB)</label><input id="uQuota" type="number" value="1024" /></div>
          <div><label>角色</label><input id="uRole" type="text" value="user" placeholder="user/admin" /></div>
        </div>
        <div>
          <label>可用存储渠道（可选）</label>
          <select id="uProviders" multiple size="6" style="width:100%;padding:8px;border-radius:8px;border:1px solid #d0d5dd;">
            ${state.providers.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">无</option>'}
          </select>
        </div>
        <div><button class="btn" id="uAdd">创建</button></div>
      </div>
    </div>
  `;
}

function renderProviders() {
  return `
    <div class="card">
      <h2>云盘核心（OJ 列表）</h2>
      <table class="files" id="providerTable">
        <thead><tr><th>#</th><th>名称</th><th>Base</th><th>gid</th><th>启用</th><th>排序</th><th></th></tr></thead>
        <tbody>${state.providers.map((p, idx) => `
          <tr data-provider-id="${p.id}">
            <td>${p.id}</td>
            <td>${esc(p.name)}</td>
            <td>${esc(p.base_url)}</td>
            <td>${esc(p.upload_gid || '-')}</td>
            <td>${p.enabled ? '✅' : '❌'}</td>
            <td>${idx + 1}</td>
            <td class="actions">
              <button data-provider-move="${p.id}" data-direction="up">上移</button>
              <button data-provider-move="${p.id}" data-direction="down">下移</button>
              <button data-del-provider="${p.id}">删除</button>
            </td>
          </tr>
        `).join('')}</tbody>
      </table>
      <div class="row" style="margin-top:12px; flex-direction:column;">
        <h3 style="margin:0;">新增 OJ</h3>
        <div class="row">
          <div><label>名称</label><input id="pName" type="text" /></div>
          <div><label>Base URL</label><input id="pBase" type="text" placeholder="http://ssf.hdoi.cn" /></div>
        </div>
        <div class="row">
          <div><label>上传账号</label><input id="pUser" type="text" /></div>
          <div><label>上传密码</label><input id="pPass" type="password" /></div>
          <div><label>gid</label><input id="pGid" type="text" /></div>
        </div>
        <div><button class="btn" id="pAdd">创建</button></div>
      </div>
    </div>
  `;
}

function renderSite() {
  return `
    <div class="card">
      <h2>网站管理</h2>
      <div class="row" style="flex-direction:column;">
        <div><label>站点名称</label><input id="siteName" type="text" value="${esc(state.site.siteName || '云盘')}" /></div>
        <div><label>站点描述</label><textarea id="siteDescription" rows="3">${esc(state.site.siteDescription || '')}</textarea></div>
        <div><label>页脚/版权</label><textarea id="siteFooter" rows="3">${esc(state.site.siteFooter || '')}</textarea></div>
        <div><button class="btn" id="siteSave">保存网站信息</button></div>
      </div>
    </div>
  `;
}

function renderNotice() {
  return `
    <div class="card">
      <h2>公告管理</h2>
      <div class="row" style="flex-direction:column;">
        <div><label>公告标题</label><input id="noticeTitle" type="text" placeholder="例如：禁止上传政治敏感与淫秽内容" /></div>
        <div><label>公告内容</label><textarea id="noticeContent" rows="4" placeholder="请输入公告内容"></textarea></div>
        <div class="row" style="align-items:center;justify-content:space-between;">
          <label style="display:flex;align-items:center;gap:8px;margin:0;"><input id="noticeActive" type="checkbox" checked /> 立即发布</label>
          <button class="btn" id="noticeSave">发布公告</button>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>已发布公告</h3>
      <div class="notice-list">
        ${state.notices.length ? state.notices.map(n => `
          <div class="notice-item">
            <div class="notice-item-head">
              <strong>${esc(n.title)}</strong>
              <span class="hint">${n.active ? '已发布' : '已停用'}</span>
            </div>
            <div class="notice-body">${esc(n.content)}</div>
            <div class="actions" style="margin-top:8px;">
              <button data-notice-edit="${n.id}">编辑</button>
              <button data-notice-del="${n.id}" style="color:#e5484d;border-color:#e5484d;">删除</button>
            </div>
          </div>
        `).join('') : '<p class="hint">暂无公告</p>'}
      </div>
    </div>
  `;
}

async function renderAdmin(tabName = state.tab) {
  state.tab = tabName;
  await loadBase();
  const tabs = [
    { key: 'dashboard', label: '仪表盘' },
    { key: 'users', label: '用户管理' },
    { key: 'providers', label: '云盘核心（OJ列表）' },
    { key: 'site', label: '网站管理' },
    { key: 'notice', label: '公告' },
  ];

  app.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;">
        <h2>管理后台</h2>
        <button class="btn secondary" id="back">返回云盘</button>
      </div>
      <div class="tabs" style="margin-top:12px;">
        ${tabs.map(t => `<button class="${t.key === tabName ? 'active' : ''}" data-admin-tab="${t.key}">${t.label}</button>`).join('')}
      </div>
      <p class="hint">用户 ${state.stats.users ?? 0} · 文件 ${state.stats.files ?? 0} · 分享 ${state.stats.shares ?? 0} · 已用 ${humanSize(state.stats.usedBytes ?? 0)}</p>
    </div>
    ${tabName === 'dashboard' ? renderDashboard() : ''}
    ${tabName === 'users' ? renderUsers() : ''}
    ${tabName === 'providers' ? renderProviders() : ''}
    ${tabName === 'site' ? renderSite() : ''}
    ${tabName === 'notice' ? renderNotice() : ''}
  `;

  const back = $('#back');
  if (back) back.onclick = () => window.location.href = '/';

  app.querySelectorAll('[data-admin-tab]').forEach(btn => {
    btn.onclick = () => renderAdmin(btn.dataset.adminTab);
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
          }
        });
        renderAdmin('providers');
      } catch (e) { toast(e.message); }
    };
  }

  app.querySelectorAll('button[data-del-provider]').forEach(btn => {
    btn.onclick = async () => {
      const ok = await confirmDialog('删除该 OJ 提供方？', { title: '删除 OJ 提供方' });
      if (!ok) return;
      try {
        await api('/api/admin/providers/' + btn.dataset.delProvider, { method: 'DELETE' });
        renderAdmin('providers');
      } catch (e) { toast(e.message); }
    };
  });
  app.querySelectorAll('button[data-provider-move]').forEach(btn => {
    btn.onclick = async () => {
      const currentId = Number.parseInt(btn.dataset.providerMove, 10);
      const currentIndex = state.providers.findIndex(p => p.id === currentId);
      const dir = btn.dataset.direction === 'up' ? -1 : 1;
      const targetIndex = currentIndex + dir;
      if (currentIndex < 0 || targetIndex < 0 || targetIndex >= state.providers.length) return;
      const next = [...state.providers];
      [next[currentIndex], next[targetIndex]] = [next[targetIndex], next[currentIndex]];
      try {
        await api('/api/admin/providers/reorder', { method: 'POST', body: { order: next.map(p => p.id) } });
        await renderAdmin('providers');
      } catch (e) { toast(e.message); }
    };
  });

  app.querySelectorAll('button[data-quota]').forEach(btn => {
    btn.onclick = async () => {
      const mb = await promptDialog({ title: '修改配额', label: '新的配额(MB)', value: '1024', type: 'number' });
      if (mb == null || mb === '') return;
      try {
        await api('/api/admin/users/' + btn.dataset.quota, { method: 'PATCH', body: { quotaMB: parseInt(mb, 10) } });
        toast('已更新');
        renderAdmin('users');
      } catch (e) { toast(e.message); }
    };
  });

  app.querySelectorAll('button[data-pw]').forEach(btn => {
    btn.onclick = async () => {
      const pw = await promptDialog({ title: '修改密码', label: '新密码', type: 'password' });
      if (pw == null || pw === '') return;
      try {
        await api('/api/admin/users/' + btn.dataset.pw, { method: 'PATCH', body: { password: pw } });
        toast('已更新');
      } catch (e) { toast(e.message); }
    };
  });

  app.querySelectorAll('button[data-del-user]').forEach(btn => {
    btn.onclick = async () => {
      const ok = await confirmDialog('删除该用户及其所有文件？', { title: '删除用户' });
      if (!ok) return;
      try {
        await api('/api/admin/users/' + btn.dataset.delUser, { method: 'DELETE' });
        renderAdmin('users');
      } catch (e) { toast(e.message); }
    };
  });

  app.querySelectorAll('button[data-channel]').forEach(btn => {
    btn.onclick = async () => {
      const userId = Number.parseInt(btn.dataset.channel, 10);
      const user = state.users.find(u => u.id === userId);
      const selectedSet = new Set(user && Array.isArray(user.storageProviderIds)
        ? user.storageProviderIds
        : (user && user.ojProviderId != null ? [user.ojProviderId] : []));
      const options = state.providers.map(p => `<option value="${p.id}" ${selectedSet.has(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
      const { mask, close } = modal(`
        <h3>修改存储渠道</h3>
        <p class="hint">未设定时表示允许使用所有渠道；管理员可为普通用户指定多个渠道。</p>
        <div class="row" style="flex-direction:column;">
          <label>可用存储渠道</label>
          <select id="channelSelect" multiple size="8" style="width:100%;padding:8px;border-radius:8px;border:1px solid #d0d5dd;">
            ${options || '<option value="">无</option>'}
          </select>
        </div>
        <div class="actions">
          <button class="btn secondary" id="c">取消</button>
          <button class="btn" id="ok">保存</button>
        </div>
      `);
      mask.querySelector('#c').onclick = close;
      mask.querySelector('#ok').onclick = async () => {
        try {
          const selected = [...mask.querySelectorAll('#channelSelect option:checked')].map(o => Number.parseInt(o.value, 10)).filter(v => Number.isInteger(v) && v > 0);
          await api('/api/admin/users/' + userId, { method: 'PATCH', body: { storageProviderIds: selected } });
          toast('已保存');
          close();
          renderAdmin('users');
        } catch (e) { toast(e.message); }
      };
    };
  });

  app.querySelectorAll('button[data-recalc-user]').forEach(btn => {
    btn.onclick = async () => {
      const ok = await confirmDialog('立即重算该用户的已用存储量？', { title: '重算用量' });
      if (!ok) return;
      try {
        const r = await api('/api/admin/users/' + btn.dataset.recalcUser + '/recalc-used', { method: 'POST' });
        toast(`已重算：${humanSize(r.data.used || 0)}`);
        renderAdmin('users');
      } catch (e) { toast(e.message); }
    };
  });

  const uAdd = $('#uAdd');
  if (uAdd) {
    uAdd.onclick = async () => {
      try {
        const select = $('#uProviders');
        const selected = select ? [...select.selectedOptions].map(o => Number.parseInt(o.value, 10)).filter(v => Number.isInteger(v) && v > 0) : [];
        await api('/api/admin/users', {
          method: 'POST',
          body: {
            username: $('#uName').value,
            password: $('#uPass').value,
            quotaMB: parseInt($('#uQuota').value, 10),
            role: $('#uRole').value,
            storageProviderIds: selected,
          }
        });
        renderAdmin('users');
      } catch (e) { toast(e.message); }
    };
  }

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

  const noticeSave = $('#noticeSave');
  if (noticeSave) {
    noticeSave.onclick = async () => {
      try {
        const title = $('#noticeTitle').value.trim();
        const content = $('#noticeContent').value.trim();
        const active = $('#noticeActive').checked;
        const noticeId = noticeSave.dataset.noticeId ? Number.parseInt(noticeSave.dataset.noticeId, 10) : null;
        if (!title || !content) return toast('标题和内容不能为空');
        if (noticeId) {
          await api('/api/notices/' + noticeId, { method: 'PATCH', body: { title, content, active } });
          toast('已更新');
        } else {
          await api('/api/notices', { method: 'POST', body: { title, content, active } });
          toast('公告已发布');
        }
        delete noticeSave.dataset.noticeId;
        noticeSave.textContent = '发布公告';
        renderAdmin('notice');
      } catch (e) { toast(e.message); }
    };
  }

  app.querySelectorAll('button[data-notice-del]').forEach(btn => {
    btn.onclick = async () => {
      const ok = await confirmDialog('删除该公告？', { title: '删除公告' });
      if (!ok) return;
      try {
        await api('/api/notices/' + btn.dataset.noticeDel, { method: 'DELETE' });
        toast('已删除');
        renderAdmin('notice');
      } catch (e) { toast(e.message); }
    };
  });

  app.querySelectorAll('button[data-notice-edit]').forEach(btn => {
    btn.onclick = async () => {
      const id = Number.parseInt(btn.dataset.noticeEdit, 10);
      const item = state.notices.find(n => n.id === id);
      if (!item) return;
      $('#noticeTitle').value = item.title;
      $('#noticeContent').value = item.content;
      $('#noticeActive').checked = !!item.active;
      $('#noticeSave').textContent = '更新公告';
      $('#noticeSave').dataset.noticeId = String(id);
    };
  });
}

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

(async function boot() {
  try {
    const r = await api('/api/auth/me');
    state.me = r.data.user;
    if (!['admin', 'root'].includes(state.me.role)) {
      throw new Error('需要管理员权限');
    }
    renderUserbar();
    renderAdmin(state.tab);
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="hint">${esc(e.message || '无权限')}</p></div>`;
    toast('管理后台未授权或未登录');
    setTimeout(() => {
      localStorage.removeItem('token');
      window.location.href = '/';
    }, 1200);
  }
})();
