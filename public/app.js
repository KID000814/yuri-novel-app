'use strict';

const $ = (s) => document.querySelector(s);
// 安全绑定：元素不存在就跳过，避免单个缺失元素拖垮整站
function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }

/* ---------- 工具 ---------- */
function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const parts = q.trim().split(/\s+/).filter(Boolean).map((t) => esc(t)).filter(Boolean);
  if (!parts.length) return safe;
  let out = safe;
  for (const p of parts) { if (!p) continue; try { out = out.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`); } catch (_) {} }
  return out;
}

/* ---------- 认证状态 ---------- */
let token = localStorage.getItem('fp_token') || '';
let currentUser = null;
let authMode = 'login';
let currentProfile = null; // null | 'self' | userId

function authHeaders() { return token ? { Authorization: 'Bearer ' + token } : {}; }
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return res.json().catch(() => ({}));
}

/* ---------- 状态 ---------- */
let categories = [];
let currentOwner = '';
let currentCategory = '';
let currentQuery = '';
let searchTimer = null;

const CLIENT_TOKEN = localStorage.getItem('fp_clientToken') || (() => { const t = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); localStorage.setItem('fp_clientToken', t); return t; })().toString();

const ADMIN_KEY_EL = $('#adminKey');
ADMIN_KEY_EL.value = localStorage.getItem('fp_adminKey') || '';
ADMIN_KEY_EL.addEventListener('input', () => { localStorage.setItem('fp_adminKey', ADMIN_KEY_EL.value.trim()); updateHint(); });
function adminKey() { return ADMIN_KEY_EL.value.trim(); }
function qs() { return { clientToken: CLIENT_TOKEN, authorKey: adminKey() }; }

const SHARER_EL = $('#sharerName');
if (SHARER_EL) {
  SHARER_EL.value = localStorage.getItem('fp_sharerName') || '';
  SHARER_EL.addEventListener('input', () => { localStorage.setItem('fp_sharerName', SHARER_EL.value.trim()); });
}
function updateHint() { $('#hint').textContent = adminKey() ? '✅ 已填写 → 上传进入「作者区」，可管理分类' : '未填写 = 进入「大家的上传」'; }

/* ---------- 分类工具 ---------- */
function catChildren(pid) { return categories.filter((c) => (c.parentId || null) === (pid || null)); }
function catById(id) { return categories.find((c) => c.id === id); }

/* ---------- 分类面板 ---------- */
function renderCatTree() {
  const ul = $('#catTree'); ul.innerHTML = '';
  const renderLevel = (pid, indent) => {
    for (const c of catChildren(pid)) {
      const li = document.createElement('li');
      li.className = 'cat-row' + (indent ? ' sub' : '');
      li.innerHTML = `<span class="cat-name">${esc(c.name)}</span>
        <button class="mini" data-act="addsub" data-id="${c.id}">＋子类</button>
        <button class="mini" data-act="rename" data-id="${c.id}">✏️改</button>
        <button class="mini" data-act="top" data-id="${c.id}">⬆️顶级</button>
        <button class="mini del" data-act="del" data-id="${c.id}">✕</button>`;
      ul.appendChild(li); renderLevel(c.id, true);
    }
  };
  renderLevel(null, false);
}
function renderCatSelect() {
  const sel = $('#uploadCat'); const keep = sel.value; const opts = [];
  const walk = (pid, depth) => { for (const c of catChildren(pid)) { opts.push(`<option value="${esc(c.id)}">${'　'.repeat(depth)}${esc(c.name)}</option>`); walk(c.id, depth + 1); } };
  walk(null, 0);
  sel.innerHTML = `<option value="">（未分类）</option>` + opts.join('');
  sel.value = keep || '';
}
function fillCatSelect(sel, selected) {
  const opts = [];
  const walk = (pid, depth) => { for (const c of catChildren(pid)) { opts.push(`<option value="${esc(c.id)}">${'　'.repeat(depth)}${esc(c.name)}</option>`); walk(c.id, depth + 1); } };
  walk(null, 0);
  sel.innerHTML = `<option value="">（未分类）</option>` + opts.join('');
  sel.value = selected || '';
}
function renderCatChips() {
  const wrap = $('#catChips'); let html = `<button class="chip ${!currentCategory ? 'active' : ''}" data-cat="">全部</button>`;
  const walk = (pid, depth) => { for (const c of catChildren(pid)) { const prefix = depth ? '└ ' : ''; html += `<button class="chip ${currentCategory === c.id ? 'active' : ''}" data-cat="${esc(c.id)}">${prefix}${esc(c.name)}</button>`; walk(c.id, depth + 1); } };
  walk(null, 0);
  wrap.innerHTML = html;
  wrap.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { currentCategory = b.dataset.cat; renderCatChips(); refreshDisplay(); }));
}
async function loadCategories() {
  try { const d = await fetchJson('/api/categories'); categories = d.categories || []; renderCatTree(); renderCatSelect(); renderCatChips(); } catch (e) { console.error(e); }
}
function catActions() {
  $('#catTree').onclick = async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const act = btn.dataset.act, id = btn.dataset.id; const key = adminKey(); const body = { authorKey: key };
    if (act === 'addsub') { const name = prompt('子分类名称：'); if (!name) return; await api('/api/categories', 'POST', { ...body, name, parentId: id }); }
    else if (act === 'rename') { const cat = catById(id); if (!cat) return; const name = prompt('重命名为：', cat.name); if (!name) return; await api('/api/categories/' + id, 'PUT', { ...body, name }); }
    else if (act === 'top') { await api('/api/categories/' + id, 'PUT', { ...body, parentId: null }); }
    else if (act === 'del') { if (!confirm('删除该分类及其子分类？已上传文件会变为「未分类」。')) return; await api('/api/categories/' + id, 'DELETE', body); }
    await loadCategories(); refreshDisplay();
  };
}

async function api(url, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...authHeaders() } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const d = await fetchJson(url, opts);
  if (!d.ok) { alert(d.error || '操作失败'); throw new Error(d.error); }
  return d;
}

/* ---------- 认证 UI ---------- */
function openAuth() { $('#auth-modal').classList.remove('hidden'); $('#auth-error').classList.add('hidden'); $('#auth-username').focus(); }
function closeAuth() { $('#auth-modal').classList.add('hidden'); $('#auth-password').value = ''; }
on('open-auth', 'click', openAuth);
on('auth-close', 'click', closeAuth);
on('auth-modal', 'click', (e) => { if (e.target.id === 'auth-modal') closeAuth(); });
on('tab-login', 'click', () => setAuthMode('login'));
on('tab-register', 'click', () => setAuthMode('register'));
function setAuthMode(m) { authMode = m; $('#tab-login').classList.toggle('active', m === 'login'); $('#tab-register').classList.toggle('active', m === 'register'); $('#auth-submit').textContent = m === 'register' ? '注册' : '登录'; $('#auth-password').placeholder = m === 'register' ? '密码（至少 6 位）' : '密码'; }
async function submitAuth() {
  const u = $('#auth-username').value.trim(), p = $('#auth-password').value; const errEl = $('#auth-error');
  errEl.classList.add('hidden');
  const url = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const d = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  if (!d.ok) { errEl.textContent = d.error || '操作失败'; errEl.classList.remove('hidden'); return; }
  token = d.token; localStorage.setItem('fp_token', token); currentUser = d.user;
  closeAuth(); $('#auth-username').value = ''; $('#auth-password').value = '';
  updateNav(); setUploadUI(); refreshDisplay();
}
on('auth-submit', 'click', submitAuth);
on('auth-modal', 'keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

async function loadMe() {
  if (!token) { currentUser = null; updateNav(); return; }
  const d = await fetchJson('/api/me', { headers: authHeaders() });
  if (d.ok) { currentUser = d.user; } else { currentUser = null; token = ''; localStorage.removeItem('fp_token'); }
  updateNav();
}
async function logout() {
  if (token) await fetchJson('/api/auth/logout', { method: 'POST', headers: authHeaders() });
  token = ''; localStorage.removeItem('fp_token'); currentUser = null;
  updateNav(); setUploadUI(); if (currentProfile) closeProfile(); refreshDisplay();
}
on('btn-logout', 'click', logout);

function updateNav() {
  const guest = $('#guest-nav'), user = $('#user-nav'), tabMy = $('#tab-my');
  if (currentUser) {
    guest.classList.add('hidden'); user.classList.remove('hidden'); tabMy.classList.remove('hidden');
    $('#nav-avatar').src = currentUser.avatar; $('#nav-username').textContent = currentUser.username;
  } else {
    user.classList.add('hidden'); guest.classList.remove('hidden'); tabMy.classList.add('hidden');
  }
}

/* ---------- 上传 ---------- */
function setUploadUI() {
  if (!currentUser) { $('#upload-hint').textContent = '（登录后即可上传）'; return; }
  $('#upload-hint').textContent = '登录中 · 将以 @' + currentUser.username + ' 显示';
  if (!SHARER_EL.value) SHARER_EL.value = currentUser.username;
}
const dropzone = $('#dropzone'), fileInput = $('#file-input');
dropzone.addEventListener('click', () => { if (currentUser) fileInput.click(); else openAuth(); });
fileInput.addEventListener('change', () => { if (fileInput.files.length) uploadFiles(fileInput.files); });
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => { const f = e.dataTransfer.files; if (f && f.length) { if (!currentUser) return openAuth(); uploadFiles(f); } });

async function uploadFiles(files) {
  if (!currentUser) return openAuth();
  const list = Array.from(files);
  const fd = new FormData();
  list.forEach((f) => fd.append('files', f));
  if (adminKey()) fd.append('authorKey', adminKey());
  if ($('#uploadCat').value) fd.append('categoryId', $('#uploadCat').value);
  if (SHARER_EL && SHARER_EL.value.trim()) fd.append('sharerName', SHARER_EL.value.trim());

  const results = $('#upload-results'), errEl = $('#upload-error');
  const wrap = $('#upload-progress'), fill = $('#progress-fill'), ptext = $('#progress-text');
  errEl.classList.add('hidden'); results.innerHTML = ''; wrap.classList.remove('hidden'); fill.style.width = '0%'; ptext.textContent = '0%';
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) { const p = Math.round(ev.loaded / ev.total * 100); fill.style.width = p + '%'; ptext.textContent = p + '%'; } };
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); } };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(fd);
    });
    wrap.classList.add('hidden');
    if (data.ok) { results.innerHTML = data.files.map((f) => `<li class="ok">已上传：${esc(f.name)}</li>`).join(''); refreshDisplay(); }
    else if (data.error) { errEl.textContent = data.error; errEl.classList.remove('hidden'); }
  } catch (e) { wrap.classList.add('hidden'); errEl.textContent = '上传失败：' + (e.message || e); errEl.classList.remove('hidden'); }
  finally { fileInput.value = ''; }
}

/* ---------- 文件列表 ---------- */
function uploaderBadge(f) {
  if (f.uploader) {
    return `<span class="owner-badge ${f.owner}"><img src="${esc(f.uploader.avatar)}" class="mini-avatar" alt=""> <a class="up-link" data-profile="${esc(f.uploader.id)}">${esc(f.uploader.username)}</a>${f.owner === 'author' ? ' 👑' : ''}</span>`;
  }
  return f.owner === 'author' ? '<span class="owner-badge author">👑 作者</span>' : '<span class="owner-badge visitor">网友</span>';
}
function fmtWords(n) { if (!n) return ''; return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万字' : n + ' 字'; }
function fileTypeIcon(f) { return { txt: '📄', epub: '📕', docx: '📖' }[f.ext] || '📄'; }
function fileItemHtml(f) {
  const title = f.title || f.name;
  const metaBits = [];
  if (f.author) metaBits.push(esc(f.author));
  if (f.status) metaBits.push(esc(f.status));
  if (f.words) metaBits.push(fmtWords(f.words));
  metaBits.push(f.ext ? esc(f.ext.toUpperCase()) : 'FILE', fmtSize(f.size));
  const tags = (f.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const snippet = f.contentMatch && f.snippet ? `<div class="file-snippet">… ${highlight(f.snippet, currentQuery)} …</div>` : '';
  const hasSummary = f.summary ? `<div class="card-summary">${esc(f.summary.slice(0, 80))}${f.summary.length > 80 ? '…' : ''}</div>` : '';
  const cover = f.coverExt
    ? `<img class="card-cover" src="/cover/${encodeURIComponent(f.id)}" alt="" loading="lazy" />`
    : `<div class="card-cover none">${fileTypeIcon(f)}</div>`;
  const delBtn = f.canDelete ? `<button class="card-del" data-del="${encodeURIComponent(f.id)}" title="一键删除">🗑</button>` : '';
  return `<div class="file-item" data-open="${encodeURIComponent(f.id)}">
      ${cover}
      <div class="file-meta">
        <div class="file-title">${highlight(title, currentQuery)}</div>
        <div class="file-sub">${metaBits.join(' · ')}</div>
        ${tags ? `<div class="file-tags">${tags}</div>` : ''}
        ${hasSummary}
        <div class="file-uploader">${uploaderBadge(f)}</div>
        ${snippet}
      </div>
      <div class="file-actions">
        <a class="btn y2k" href="/api/download/${encodeURIComponent(f.id)}" download>⬇ 下载</a>
      </div>
      ${delBtn}
    </div>`;
}
function bindList(listEl) {
  listEl.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('a[download], [data-del], [data-profile], button')) return;
    openDetail(el.dataset.open);
  }));
  listEl.querySelectorAll('[data-profile]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openProfile(a.dataset.profile); }));
  listEl.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteFile(b.dataset.del)));
}
async function refreshDisplay() {
  if (currentProfile) { await reloadProfile(); return; }
  await loadFiles();
}
async function loadFiles() {
  const list = $('#file-list');
  const params = new URLSearchParams({ ...qs() });
  if (currentOwner) params.set('owner', currentOwner);
  if (currentCategory) params.set('category', currentCategory);
  let url = '/api/files?' + params.toString();
  if (currentQuery) url = '/api/search?q=' + encodeURIComponent(currentQuery) + '&' + params.toString();
  try {
    const d = await fetchJson(url, { headers: authHeaders() });
    const files = d.files || [];
    if (!files.length) { list.innerHTML = `<p class="empty">${currentQuery ? '没搜到～换个关键词' : '这里空空如也～先上传一个吧'}</p>`; return; }
    list.innerHTML = files.map(fileItemHtml).join('');
    bindList(list);
  } catch (e) { list.innerHTML = `<p class="empty">加载失败</p>`; }
}

/* ---------- 个人主页 ---------- */
async function openProfile(id) {
  const userId = id === 'self' ? (currentUser ? currentUser.id : '') : id;
  if (!userId) return;
  const d = await fetchJson('/api/users/' + userId, { headers: authHeaders() });
  if (!d.ok) { alert(d.error || '用户不存在'); return; }
  currentProfile = id === 'self' ? 'self' : id;
  renderProfile(d.user, d.files, id === 'self');
  $('#profile-view').classList.remove('hidden');
  $('#browse-controls').classList.add('hidden');
  $('#file-list').classList.add('hidden');
}
function renderProfile(user, files, isSelf) {
  $('#profile-avatar').src = user.avatar;
  $('#profile-name').textContent = user.username;
  $('#profile-count').textContent = '共 ' + files.length + ' 个文件';
  $('#btn-change-avatar').classList.toggle('hidden', !isSelf);
  const el = $('#profile-files');
  el.innerHTML = files.length ? files.map(fileItemHtml).join('') : `<p class="empty">还没有上传文件</p>`;
  bindList(el);
}
async function reloadProfile() {
  if (currentProfile === 'self') { const id = currentUser ? currentUser.id : ''; if (!id) return; const d = await fetchJson('/api/users/' + id, { headers: authHeaders() }); if (d.ok) renderProfile(d.user, d.files, true); }
  else { const d = await fetchJson('/api/users/' + currentProfile, { headers: authHeaders() }); if (d.ok) renderProfile(d.user, d.files, false); }
}
function closeProfile() {
  currentProfile = null;
  $('#profile-view').classList.add('hidden');
  $('#browse-controls').classList.remove('hidden');
  $('#file-list').classList.remove('hidden');
  loadFiles();
}
on('profile-back', 'click', closeProfile);
on('btn-my-profile', 'click', () => { openProfile('self'); });

/* 头像上传 */
on('btn-change-avatar', 'click', () => $('#avatar-input').click());
on('avatar-input', 'change', async (e) => {
  if (!e.target.files[0]) return;
  const fd = new FormData(); fd.append('avatar', e.target.files[0]);
  const d = await fetchJson('/api/avatar', { method: 'POST', headers: authHeaders(), body: fd });
  if (d.ok) { await loadMe(); await openProfile('self'); } else alert(d.error || '头像上传失败');
  e.target.value = '';
});

/* ---------- 删除 ---------- */
async function deleteFile(id) {
  if (!id) return; if (!confirm('确定删除这个文件吗？')) return;
  const res = await fetch('/api/file/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(qs()) });
  const d = await res.json().catch(() => ({}));
  if (!d.ok) { alert(d.error || '无权删除'); return; }
  refreshDisplay();
}

/* ---------- 作品详情(弹出) ---------- */
let detailFile = null;
async function openDetail(id) {
  const d = await fetchJson('/api/file/' + id, { headers: authHeaders() });
  if (!d.ok) { alert(d.error || '加载失败'); return; }
  detailFile = d.file; renderDetail(d.file);
  $('#detail-modal').classList.remove('hidden');
}
function renderDetail(f) {
  $('#detail-cover').src = f.coverExt ? ('/cover/' + encodeURIComponent(f.id)) : '';
  $('#detail-title').textContent = f.title || f.name;
  $('#detail-uploader').innerHTML = f.uploader
    ? `分享者：<img class="mini-avatar" src="${esc(f.uploader.avatar)}"><a class="up-link" data-profile="${esc(f.uploader.id)}">${esc(f.uploader.username)}</a>${f.owner === 'author' ? ' 👑' : ''}`
    : (f.owner === 'author' ? '作者' : '网友');
  const meta = [];
  if (f.author) meta.push(`作者：${esc(f.author)}`);
  if (f.translator) meta.push(`译者：${esc(f.translator)}`);
  if (f.status) meta.push(`状态：${esc(f.status)}`);
  if (f.words) meta.push(`字数：${fmtWords(f.words)}`);
  meta.push(`大小：${fmtSize(f.size)}`, `时间：${fmtTime(f.uploadedAt)}`, `分类：${f.categoryPath ? esc(f.categoryPath) : '未分类'}`);
  $('#detail-meta').innerHTML = meta.map((m) => `<span class="dm-item">${m}</span>`).join('');
  $('#detail-tags').innerHTML = (f.tags && f.tags.length) ? f.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') : '';
  $('#detail-summary').textContent = f.summary || '（暂无作品简介，可点「编辑信息」补充）';
  $('#detail-download').href = '/api/download/' + encodeURIComponent(f.id);
  $('#btn-edit-meta').classList.toggle('hidden', !f.canEdit);
  $('#btn-change-cover').classList.toggle('hidden', !f.canEdit);
  $('#btn-remove-cover').classList.toggle('hidden', !(f.canEdit && f.coverExt));
  $('#btn-delete-file').classList.toggle('hidden', !f.canDelete);
  $('#edit-form').classList.add('hidden');
  $('#fm-title').value = f.title || ''; $('#fm-author').value = f.author || ''; $('#fm-translator').value = f.translator || '';
  $('#fm-status').value = f.status || ''; $('#fm-words').value = f.words || ''; $('#fm-tags').value = (f.tags || []).join(','); $('#fm-summary').value = f.summary || '';
  fillCatSelect($('#fm-cat'), f.categoryId || '');
  $('#detail-uploader').querySelectorAll('[data-profile]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openProfile(a.dataset.profile); }));
}
function closeDetail() { $('#detail-modal').classList.add('hidden'); detailFile = null; }
on('detail-close', 'click', closeDetail);
on('detail-modal', 'click', (e) => { if (e.target.id === 'detail-modal') closeDetail(); });
on('btn-edit-meta', 'click', () => $('#edit-form').classList.toggle('hidden'));
on('btn-cancel-meta', 'click', () => $('#edit-form').classList.add('hidden'));
on('btn-save-meta', 'click', async () => {
  if (!detailFile) return;
  const body = { title: $('#fm-title').value, author: $('#fm-author').value, translator: $('#fm-translator').value, status: $('#fm-status').value, words: $('#fm-words').value, tags: $('#fm-tags').value, summary: $('#fm-summary').value, categoryId: $('#fm-cat').value, authorKey: adminKey() };
  const d = await fetchJson('/api/file/' + detailFile.id, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) });
  if (d.ok) { detailFile = d.file; renderDetail(d.file); refreshDisplay(); alert('已保存'); } else alert(d.error || '保存失败');
});
on('btn-remove-cover', 'click', async () => {
  if (!detailFile) return; if (!confirm('确定删除这张封面吗？')) return;
  const d = await fetchJson('/api/file/' + detailFile.id + '/cover', { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ authorKey: adminKey() }) });
  if (d.ok) { detailFile.coverExt = null; $('#detail-cover').src = ''; renderDetail(detailFile); refreshDisplay(); alert('已删除封面'); } else alert(d.error || '删除失败');
});
on('btn-change-cover', 'click', () => $('#cover-input').click());
on('cover-input', 'change', async (e) => {
  if (!e.target.files[0] || !detailFile) return;
  const fd = new FormData(); fd.append('cover', e.target.files[0]); fd.append('authorKey', adminKey());
  const d = await fetchJson('/api/file/' + detailFile.id + '/cover', { method: 'POST', headers: authHeaders(), body: fd });
  if (d.ok) { detailFile.coverExt = true; $('#detail-cover').src = d.cover; refreshDisplay(); alert('封面已更新'); } else alert(d.error || '封面上传失败');
  e.target.value = '';
});
on('btn-delete-file', 'click', async () => {
  if (!detailFile) return; if (!confirm('确定删除这个文件吗？')) return;
  const res = await fetch('/api/file/' + detailFile.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(qs()) });
  const d = await res.json().catch(() => ({}));
  if (!d.ok) { alert(d.error || '无权删除'); return; }
  closeDetail(); refreshDisplay();
});

/* ---------- tabs / 检索 ---------- */
on('ownerTabs', 'click', (e) => {
  const t = e.target.closest('.tab'); if (!t) return;
  if (t.dataset.owner === 'me') { openProfile('self'); return; }
  document.querySelectorAll('#ownerTabs .tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active'); currentOwner = t.dataset.owner; closeProfile();
});
on('search-input', 'input', () => {
  clearTimeout(searchTimer);
  const q = $('#search-input').value.trim(); $('#clear-search').classList.toggle('hidden', !q);
  searchTimer = setTimeout(() => { currentQuery = q; refreshDisplay(); }, 260);
});
on('clear-search', 'click', () => { $('#search-input').value = ''; currentQuery = ''; $('#clear-search').classList.add('hidden'); refreshDisplay(); });
on('addCat', 'click', async () => {
  const name = $('#newCat').value.trim(); if (!name) return;
  await api('/api/categories', 'POST', { name, authorKey: adminKey() });
  $('#newCat').value = ''; await loadCategories(); refreshDisplay();
});

/* ---------- 排版 ---------- */
const layoutBtns = document.querySelectorAll('.layout-btn');
function applyLayout(n) {
  const el = $('#file-list'), pv = $('#profile-files');
  el.classList.remove('cols-1', 'cols-2', 'cols-3'); el.classList.add('cols-' + n);
  pv.classList.remove('cols-1', 'cols-2', 'cols-3'); pv.classList.add('cols-' + n);
  layoutBtns.forEach((b) => b.classList.toggle('active', Number(b.dataset.cols) === n));
  localStorage.setItem('fp_layout', String(n));
}
layoutBtns.forEach((b) => b.addEventListener('click', () => applyLayout(Number(b.dataset.cols))));
applyLayout(Number(localStorage.getItem('fp_layout') || '2'));

/* ---------- 星光特效 (降载: 少量粒子+弹窗打开时暂停) ---------- */
(function sparkles() {
  const c = $('#sparkles'); if (!c) return; const ctx = c.getContext('2d');
  let w, h; c.width = w = innerWidth; c.height = h = innerHeight;
  const N = (w * h) > 1.5e6 ? 18 : 26;
  const S = Array.from({ length: N }, () => ({ x: Math.random() * w, y: Math.random() * h, r: 0.6 + Math.random() * 1.4, s: .15 + Math.random() * .5, p: Math.random() * 6, t: 0 }));
  addEventListener('resize', () => { c.width = w = innerWidth; c.height = h = innerHeight; });
  const colors = ['#ff6bd6', '#8b5cf6', '#38bdf8', '#fff'];
  function loop() {
    ctx.clearRect(0, 0, w, h);
    for (const s of S) { s.y -= s.s; s.t += s.p / 12; if (s.y < -10) { s.y = h + 10; s.x = Math.random() * w; } ctx.globalAlpha = .25 + Math.abs(Math.sin(s.t)) * .4; ctx.fillStyle = colors[(s.t | 0) % colors.length]; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
    const busy = document.hidden || !document.getElementById('detail-modal').classList.contains('hidden') || !document.getElementById('auth-modal').classList.contains('hidden');
    if (!busy) requestAnimationFrame(loop); else setTimeout(loop, 250);
  }
  loop();
})();

/* ---------- init ---------- */
updateHint();
catActions();
setAuthMode('login');
setUploadUI();

async function boot() {
  await loadMe();
  await loadCategories();
  await refreshDisplay();
  // 弹窗打开时暂停自动刷新；未变数据由 sig 比对跳过重建
  setInterval(() => {
    if (document.hidden) return;
    if (!document.getElementById('detail-modal').classList.contains('hidden')) return;
    if (!document.getElementById('auth-modal').classList.contains('hidden')) return;
    refreshDisplay();
  }, 5000);
  setInterval(() => { if (!document.hidden) loadCategories(); }, 30000);
}
boot();
