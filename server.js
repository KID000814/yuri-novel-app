'use strict';

/**
 * File Portal — 公网文件分享门户 v4
 * 功能: 批量上传(txt/epub/docx) / 文件名+全文搜索 / 下载
 *       作者区 vs 大家上传区 / 作者密钥 / 删除权限 / 树形自定义分类
 *       站内账号系统(用户名+密码, scrypt 加密) / 自定义头像 / 个人主页
 *
 * 存储后端(STORAGE_BACKEND): local | s3  (生产建议 s3 存 Cloudflare R2/B2)
 * 作者密钥(ADMIN_KEY): 环境变量, 作者填它上传→进作者区, 填它可删任意文件、管理分类
 *
 * 依赖: express multer mammoth adm-zip @aws-sdk/client-s3
 */

const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const d of [DATA_DIR, TMP_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 200 * 1024 * 1024);
const AVATAR_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

const ALLOWED_EXTS = new Set(['txt', 'epub', 'docx']);
function getExt(name) {
  return path.extname(name || '').replace('.', '').toLowerCase();
}
function isAuthor(key) {
  return Boolean(ADMIN_KEY) && key === ADMIN_KEY;
}
function uid() {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

/* ============================================================
 * 存储层抽象
 * ============================================================ */
async function createStorage() {
  if (STORAGE_BACKEND === 's3') {
    const {
      S3Client, PutObjectCommand, GetObjectCommand,
      DeleteObjectCommand, ListObjectsV2Command
    } = require('@aws-sdk/client-s3');
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error('s3 后端需要设置 S3_BUCKET');
    const client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ''
      }
    });
    return {
      backend: 's3',
      async put(key, buf) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf })); },
      async get(key) {
        try { const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); } catch (_) { return null; }
      },
      async delete(key) { try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); } catch (_) {} },
      async listPrefix(prefix) {
        const keys = []; let token;
        do {
          const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
          for (const o of r.Contents || []) keys.push(o.Key);
          token = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (token);
        return keys;
      }
    };
  }
  const write = (p, buf) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };
  return {
    backend: 'local',
    async put(key, buf) { write(path.join(DATA_DIR, key), buf); },
    async get(key) { try { return fs.readFileSync(path.join(DATA_DIR, key)); } catch (_) { return null; } },
    async delete(key) { try { fs.unlinkSync(path.join(DATA_DIR, key)); } catch (_) {} },
    async listPrefix(prefix) {
      const base = path.join(DATA_DIR, prefix); const keys = [];
      const walk = (dir) => {
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else keys.push(path.relative(DATA_DIR, full).split(path.sep).join('/'));
        }
      };
      walk(base); return keys;
    }
  };
}

const metaKey = (id) => `meta/${id}.json`;
const textKey = (id) => `text/${id}.txt`;
const fileKey = (stored) => `files/${stored}`;
const avatarKey = (userId, ext) => `avatars/${userId}.${ext}`;
const coverKey = (id, ext) => `covers/${id}.${ext}`;
const USERS_KEY = 'settings/users.json';
const SESSIONS_KEY = 'settings/sessions.json';
const CATS_KEY = 'settings/categories.json';

let storage = null;
let metadata = [];
let categories = []; // [{id,name,parentId}]
let users = [];      // [{id,username,passwordHash,createdAt,avatarExt}]
let sessions = {};   // {token: userId}

/* ============================================================
 * 持久化 (元数据 / 分类 / 用户 / 会话)
 * ============================================================ */
async function loadMetadata() {
  if (!storage) return;
  try {
    const keys = await storage.listPrefix('meta/');
    const loaded = [];
    for (const k of keys) {
      const buf = await storage.get(k);
      if (buf) { try { loaded.push(JSON.parse(buf.toString('utf8'))); } catch (_) {} }
    }
    metadata = loaded;
  } catch (_) { metadata = []; }
}
async function saveMeta(rec) { await storage.put(metaKey(rec.id), Buffer.from(JSON.stringify(rec))); }
async function removeMeta(id) { await storage.delete(metaKey(id)); }

async function loadCategories() {
  if (!storage) return;
  const buf = await storage.get(CATS_KEY);
  try { categories = buf ? JSON.parse(buf.toString('utf8')) : []; } catch (_) { categories = []; }
  if (!Array.isArray(categories)) categories = [];
}
async function saveCategories() { await storage.put(CATS_KEY, Buffer.from(JSON.stringify(categories))); }

async function loadUsers() {
  if (!storage) return;
  const buf = await storage.get(USERS_KEY);
  try { users = buf ? JSON.parse(buf.toString('utf8')) : []; } catch (_) { users = []; }
  if (!Array.isArray(users)) users = [];
}
async function saveUsers() { await storage.put(USERS_KEY, Buffer.from(JSON.stringify(users))); }
async function loadSessions() {
  if (!storage) return;
  const buf = await storage.get(SESSIONS_KEY);
  try { sessions = buf ? JSON.parse(buf.toString('utf8')) : {}; } catch (_) { sessions = {}; }
  if (!sessions || typeof sessions !== 'object') sessions = {};
}
async function saveSessions() { await storage.put(SESSIONS_KEY, Buffer.from(JSON.stringify(sessions))); }

/* ============================================================
 * 用户 / 会话 / 鉴权
 * ============================================================ */
function userById(id) { return users.find((u) => u.id === id); }
function userByName(name) { return users.find((u) => u.username === name); }
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calc));
}
function sanitizeUsername(n) {
  return String(n || '').replace(/[\s\r\n<>"']/g, '').slice(0, 24);
}
function auth(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const userId = token && sessions[token];
  const user = userId ? userById(userId) : null;
  if (!user) return res.status(401).json({ ok: false, error: '请先登录' });
  req.user = user;
  next();
}
function tokenOf(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}
function authUser(req) {
  const token = tokenOf(req);
  const userId = token && sessions[token];
  return userId ? userById(userId) : null;
}

/* ============================================================
 * 分类工具
 * ============================================================ */
function catChildren(parentId) { return categories.filter((c) => (c.parentId || null) === (parentId || null)); }
function catById(id) { return categories.find((c) => c.id === id); }
function catDescendantIds(id) {
  const out = new Set([id]);
  const walk = (pid) => { for (const c of categories) if (c.parentId === pid) { out.add(c.id); walk(c.id); } };
  walk(id); return out;
}
function catPath(id) {
  const parts = []; let cur = catById(id);
  while (cur) { parts.unshift(cur.name); cur = cur.parentId ? catById(cur.parentId) : null; }
  return parts.join(' / ');
}
function sanitizeName(n) { return String(n || '').replace(/[\r\n\t<>"']/g, ' ').trim().slice(0, 40); }

/* 富信息元数据清洗 */
function cleanStr(v, max) { return String(v == null ? '' : v).replace(/[\r\n\t<>"']/g, ' ').trim().slice(0, max); }
function cleanTags(v) {
  const raw = Array.isArray(v) ? v.join(',') : String(v || '');
  const arr = raw.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8).map((s) => s.slice(0, 20));
  return [...new Set(arr)];
}
function cleanSummary(v) { return String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().slice(0, 2000); }
function parseWords(v) { const n = parseInt(v, 10); return (isNaN(n) || n < 0) ? null : n; }
function escapeXml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ============================================================
 * 正文提取
 * ============================================================ */
function htmlToText(html) {
  let s = html || '';
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
       .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
       .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCodePoint(Number(n)); } catch (_) { return ' '; } });
  return s.replace(/\s+/g, ' ').trim();
}
function extractEpubText(filePath) {
  try {
    const zip = new AdmZip(filePath); let out = '';
    for (const e of zip.getEntries()) {
      const name = e.entryName.toLowerCase();
      if (!e.isDirectory && /\.(x?html?|htm)$/.test(name)) out += '\n' + htmlToText(e.getData().toString('utf8'));
    }
    return out;
  } catch (_) { return ''; }
}
async function extractText(filePath, ext) {
  try {
    if (ext === 'docx') return (await mammoth.extractRawText({ path: filePath })).value || '';
    if (ext === 'epub') return extractEpubText(filePath);
    if (ext === 'txt') return fs.readFileSync(filePath).toString('utf8');
  } catch (_) {}
  return '';
}

/* ============================================================
 * 全文搜索
 * ============================================================ */
const textCache = new Map();
async function loadText(id) {
  if (textCache.has(id)) return textCache.get(id);
  const buf = await storage.get(textKey(id));
  const content = buf ? buf.toString('utf8') : '';
  if (textCache.size > 500) textCache.clear();
  textCache.set(id, content);
  return content;
}

/* ============================================================
 * multer (文件 + 头像)
 * ============================================================ */
const multerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_DIR),
  filename: (_req, _file, cb) => { const ext = path.extname(_file.originalname || '').toLowerCase().slice(0, 10); cb(null, `${uid()}${ext}`); }
});
function fileFilter(_req, file, cb) {
  const ext = getExt(file.originalname);
  if (ALLOWED_EXTS.has(ext)) cb(null, true);
  else cb(new Error(`不支持的文件类型 .${ext}，仅允许 txt / epub / docx`));
}
// 注意: 这里不挂 fileFilter。批量上传时若个别文件类型不符，
// 不应让整批失败，而是在下面的处理循环里逐个跳过并提示。
const upload = multer({ storage: multerStorage, limits: { fileSize: MAX_FILE_SIZE, files: 100 } });

const avatarStorage = multer.diskStorage({ destination: (_req, _file, cb) => cb(null, TMP_DIR), filename: (_req, _file, cb) => cb(null, `${uid()}-avatar`) });
function avatarFilter(_req, file, cb) {
  const ext = getExt(file.originalname);
  if (AVATAR_EXTS.has(ext)) cb(null, true);
  else cb(new Error('头像仅支持 jpg / png / gif / webp'));
}
const avatarUpload = multer({ storage: avatarStorage, fileFilter: avatarFilter, limits: { fileSize: 2 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0, setHeaders(res) { res.setHeader('Cache-Control', 'no-store'); } }));

/* ============================================================
 * 健康检查
 * ============================================================ */
app.get('/healthz', (_req, res) => res.json({ ok: true, backend: storage && storage.backend, categories: categories.length, users: users.length }));

/* ============================================================
 * 认证 API: 注册 / 登录 / 登出 / 当前用户 / 改头像
 * ============================================================ */
function publicUser(u) {
  return { id: u.id, username: u.username, createdAt: u.createdAt, avatar: `/avatar/${u.id}` };
}

app.post('/api/auth/register', async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '');
  if (username.length < 2) return res.status(400).json({ ok: false, error: '用户名至少 2 个字符' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: '密码至少 6 位' });
  if (userByName(username)) return res.status(409).json({ ok: false, error: '该用户名已被注册' });
  const user = { id: uid(), username, passwordHash: hashPassword(password), createdAt: new Date().toISOString(), avatarExt: null };
  users.push(user); await saveUsers();
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = user.id; await saveSessions();
  res.json({ ok: true, token, user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const user = userByName(username);
  if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ ok: false, error: '用户名或密码错误' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = user.id; await saveSessions();
  res.json({ ok: true, token, user: publicUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = tokenOf(req);
  if (token && sessions[token]) { delete sessions[token]; await saveSessions(); }
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ ok: false, error: '未登录' });
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/avatar', auth, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || '头像上传失败' });
    if (!req.file) return res.status(400).json({ ok: false, error: '请选择头像图片' });
    const ext = getExt(req.file.originalname);
    const blob = fs.readFileSync(req.file.path);
    await storage.put(avatarKey(req.user.id, ext), blob);
    // 清理旧头像
    if (req.user.avatarExt && req.user.avatarExt !== ext) await storage.delete(avatarKey(req.user.id, req.user.avatarExt));
    req.user.avatarExt = ext; await saveUsers();
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.json({ ok: true, avatar: `/avatar/${req.user.id}` });
  });
});

/* ============================================================
 * 头像展示
 * ============================================================ */
app.get('/avatar/:id', async (req, res) => {
  const user = userById(req.params.id);
  if (!user || !user.avatarExt) {
    res.setHeader('Content-Type', 'image/svg+xml');
    const initial = user ? (user.username || '?').charAt(0) : '?';
    return res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#ffb3ec"/><text x="48" y="60" font-size="44" text-anchor="middle" fill="#7a2a6b" font-family="sans-serif">${initial}</text></svg>`);
  }
  const buf = await storage.get(avatarKey(user.id, user.avatarExt));
  if (!buf) { res.status(404).json({ ok: false, error: 'no avatar' }); return; }
  res.setHeader('Content-Type', `image/${user.avatarExt === 'jpg' ? 'jpeg' : user.avatarExt}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
});

/* ============================================================
 * 个人主页 (公开): 用户名 + 头像 + 该用户上传的所有文件
 * ============================================================ */
app.get('/api/users/:id', (req, res) => {
  const user = userById(req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  const files = metadata.filter((f) => f.userId === user.id).slice().reverse().map((f) => visible(f, req));
  res.json({ ok: true, user: publicUser(user), files });
});

/* ============================================================
 * 分类 API (修改需作者密钥)
 * ============================================================ */
app.get('/api/categories', (_req, res) => res.json({ ok: true, categories }));

app.post('/api/categories', (req, res) => {
  if (!isAuthor(String(req.body.authorKey || ''))) return res.status(403).json({ ok: false, error: '仅作者可管理分类' });
  const name = sanitizeName(req.body.name);
  const parentId = req.body.parentId ? String(req.body.parentId) : null;
  if (!name) return res.status(400).json({ ok: false, error: '分类名不能为空' });
  if (parentId && !catById(parentId)) return res.status(400).json({ ok: false, error: '父分类不存在' });
  if (catChildren(parentId).some((c) => c.name === name)) return res.status(400).json({ ok: false, error: '同级已存在同名分类' });
  const cat = { id: uid(), name, parentId };
  categories.push(cat); saveCategories();
  res.json({ ok: true, category: cat });
});

app.put('/api/categories/:id', (req, res) => {
  if (!isAuthor(String(req.body.authorKey || ''))) return res.status(403).json({ ok: false, error: '仅作者可管理分类' });
  const cat = catById(req.params.id);
  if (!cat) return res.status(404).json({ ok: false, error: '分类不存在' });
  if (req.body.name !== undefined) { const name = sanitizeName(req.body.name); if (!name) return res.status(400).json({ ok: false, error: '分类名不能为空' }); cat.name = name; }
  if (req.body.parentId !== undefined) {
    const pid = req.body.parentId ? String(req.body.parentId) : null;
    if (pid === cat.id) return res.status(400).json({ ok: false, error: '不能把该分类设为自己的子分类' });
    if (pid && !catById(pid)) return res.status(400).json({ ok: false, error: '父分类不存在' });
    if (catDescendantIds(cat.id).has(pid)) return res.status(400).json({ ok: false, error: '不能移动到自己的子分类下' });
    cat.parentId = pid;
  }
  saveCategories();
  res.json({ ok: true, category: cat });
});

app.delete('/api/categories/:id', async (req, res) => {
  if (!isAuthor(String(req.query.authorKey || (req.body || {}).authorKey || ''))) return res.status(403).json({ ok: false, error: '仅作者可管理分类' });
  const cat = catById(req.params.id);
  if (!cat) return res.status(404).json({ ok: false, error: '分类不存在' });
  const ids = catDescendantIds(cat.id);
  categories = categories.filter((c) => !ids.has(c.id));
  let changed = false;
  for (const f of metadata) { if (f.categoryId && ids.has(f.categoryId)) { f.categoryId = null; changed = true; await saveMeta(f); } }
  await saveCategories();
  res.json({ ok: true, removed: ids.size, changed });
});

/* ============================================================
 * 上传 API (必须登录)
 * ============================================================ */
app.post('/api/upload', auth, (req, res) => {
  upload.array('files', 100)(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `单个文件超过大小上限（${Math.round(MAX_FILE_SIZE / 1048576)}MB）` : (err.message || '上传失败');
      return res.status(400).json({ ok: false, error: msg });
    }
    const authorKey = String(req.body.authorKey || '');
    const categoryId = req.body.categoryId ? String(req.body.categoryId) : null;
    const sharerName = String(req.body.sharerName || '').trim().slice(0, 40) || req.user.username;
    const owner = isAuthor(authorKey) ? 'author' : 'visitor';
    if (categoryId && !catById(categoryId)) return res.status(400).json({ ok: false, error: '分类不存在' });

    const uploaded = [];
    const skipped = [];   // 被跳过的文件(类型不符/出错),不拖垮整批
    for (const f of req.files || []) {
      const originalName = Buffer.from(f.originalname || '', 'latin1').toString('utf8') || f.filename;
      const ext = getExt(originalName);
      // 单个文件类型不符: 只跳过它
      if (!ALLOWED_EXTS.has(ext)) {
        skipped.push({ name: originalName, reason: `不支持的格式 .${ext}（仅支持 txt / epub / docx）` });
        continue;
      }
      try {
        const id = path.basename(f.filename, path.extname(f.filename));
        const blob = fs.readFileSync(f.path);
        const text = await extractText(f.path, ext);
        const rec = {
          id, name: originalName, stored: f.filename, size: f.size,
          mime: f.mimetype || 'application/octet-stream', ext,
          uploadedAt: new Date().toISOString(),
          owner, categoryId, sharerName: sharerName || null, userId: req.user.id,
          title: cleanStr(req.body.title, 80) || originalName,
          author: cleanStr(req.body.author, 40),
          translator: cleanStr(req.body.translator, 40),
          status: cleanStr(req.body.status, 10),
          words: parseWords(req.body.words),
          tags: cleanTags(req.body.tags),
          summary: cleanSummary(req.body.summary)
        };
        await storage.put(fileKey(f.filename), blob);
        await storage.put(textKey(id), Buffer.from(text || ''));
        await saveMeta(rec);
        metadata.push(rec); uploaded.push(rec);
        textCache.delete(id);
      } catch (e) {
        skipped.push({ name: originalName, reason: '处理失败：' + (e.message || e) });
      } finally {
        try { fs.unlinkSync(f.path); } catch (_) {}
      }
    }
    if (!uploaded.length && skipped.length) {
      return res.status(400).json({ ok: false, error: skipped.map((s) => `${s.name}：${s.reason}`).join('；'), skipped });
    }
    res.json({ ok: true, uploaded: uploaded.length, skipped, files: uploaded.map((f) => visible(f, req)) });
  });
});

/* ============================================================
 * 列表 / 搜索 (支持 按分类/按作者 过滤)
 * ============================================================ */
function visible(rec, req) {
  const authorKey = req ? String(req.query.authorKey || (req.body || {}).authorKey || '') : '';
  const clientToken = req ? String(req.query.clientToken || (req.body || {}).clientToken || '') : '';
  const { uploaderToken, ...rest } = rec;
  const viewer = req ? authUser(req) : null;
  const canDelete = Boolean(isAuthor(authorKey) || (viewer && rec.userId === viewer.id) || (rec.owner === 'visitor' && clientToken && clientToken === rec.uploaderToken));
  const canEdit = Boolean(isAuthor(authorKey) || (viewer && rec.userId === viewer.id));
  const uploader = rec.userId ? userById(rec.userId) : null;
  return {
    ...rest,
    categoryPath: rec.categoryId ? catPath(rec.categoryId) : null,
    canDelete,
    canEdit,
    uploader: uploader ? { id: uploader.id, username: uploader.username, avatar: `/avatar/${uploader.id}` } : null
  };
}

app.get('/api/files', (req, res) => {
  const catFilter = req.query.category ? String(req.query.category) : null;
  const ownerFilter = req.query.owner ? String(req.query.owner) : null;
  let list = metadata.slice().reverse();
  if (ownerFilter) list = list.filter((f) => f.owner === ownerFilter);
  if (catFilter) { const ids = catDescendantIds(catFilter); list = list.filter((f) => f.categoryId && ids.has(f.categoryId)); }
  res.json({ ok: true, files: list.map((f) => visible(f, req)) });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, files: [] });
  const ql = q.toLowerCase();
  const tokens = ql.split(/\s+/).filter(Boolean);
  const catFilter = req.query.category ? String(req.query.category) : null;
  const ownerFilter = req.query.owner ? String(req.query.owner) : null;
  const catIds = catFilter ? catDescendantIds(catFilter) : null;
  const results = [];
  for (const f of metadata) {
    if (ownerFilter && f.owner !== ownerFilter) continue;
    if (catIds && !f.categoryId) continue;
    if (catIds && !catIds.has(f.categoryId)) continue;
    const name = f.name.toLowerCase();
    const text = (await loadText(f.id)).toLowerCase();
    let score = 0, filenameMatch = false, contentMatch = false, snippet = '';
    if (name.includes(ql)) { score += 100; filenameMatch = true; }
    if (text && tokens.length && tokens.every((t) => text.includes(t))) {
      score += 50; contentMatch = true;
      const firstTok = tokens.find((t) => text.includes(t));
      if (firstTok) { const idx = text.indexOf(firstTok); snippet = (text.slice(Math.max(0, idx - 40), Math.max(0, idx - 40) + 160) || '').trim(); }
    }
    if (filenameMatch || contentMatch) results.push(visible({ ...f, score, filenameMatch, contentMatch, snippet }, req));
  }
  results.sort((a, b) => b.score - a.score);
  res.json({ ok: true, files: results });
});

app.get('/api/file/:id', (req, res) => {
  const f = metadata.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, file: visible(f, req) });
});

/* ============================================================
 * 编辑元数据 (作者密钥 或 上传者可编辑)
 * ============================================================ */
app.put('/api/file/:id', (req, res) => {
  const f = metadata.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ ok: false, error: 'not found' });
  const authorKey = String(req.body.authorKey || '');
  const viewer = authUser(req);
  if (!isAuthor(authorKey) && !(viewer && f.userId === viewer.id)) return res.status(403).json({ ok: false, error: '无权编辑该文件' });
  if (req.body.title !== undefined) f.title = cleanStr(req.body.title, 80) || f.name;
  if (req.body.author !== undefined) f.author = cleanStr(req.body.author, 40);
  if (req.body.translator !== undefined) f.translator = cleanStr(req.body.translator, 40);
  if (req.body.status !== undefined) f.status = cleanStr(req.body.status, 10);
  if (req.body.words !== undefined) f.words = parseWords(req.body.words);
  if (req.body.tags !== undefined) f.tags = cleanTags(req.body.tags);
  if (req.body.summary !== undefined) f.summary = cleanSummary(req.body.summary);
  if (req.body.categoryId !== undefined) {
    const cid = req.body.categoryId ? String(req.body.categoryId) : null;
    if (cid && !catById(cid)) return res.status(400).json({ ok: false, error: '分类不存在' });
    f.categoryId = cid;
  }
  saveMeta(f);
  res.json({ ok: true, file: visible(f, req) });
});

/* ============================================================
 * 封面 (程序生成 SVG 占位封面)
 * ============================================================ */
app.get('/cover/:id', async (req, res) => {
  const f = metadata.find((x) => x.id === req.params.id);
  if (f && f.coverExt) {
    const buf = await storage.get(coverKey(f.id, f.coverExt));
    if (buf) {
      res.setHeader('Content-Type', `image/${f.coverExt === 'jpg' ? 'jpeg' : f.coverExt}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buf);
    }
  }
  const title = f ? (f.title || f.name) : '?';
  const author = f ? (f.author || '') : '';
  let h = 0; for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 360;
  const c1 = `hsl(${h},70%,72%)`, c2 = `hsl(${(h + 45) % 360},75%,50%)`;
  const initial = escapeXml(Array.from(title)[0] || '?');
  const ttl = escapeXml(title.slice(0, 16));
  const au = escapeXml(author.slice(0, 14));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="280">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="200" height="280" fill="url(#g)"/>
    <rect x="9" y="9" width="182" height="262" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2" rx="10"/>
    <text x="100" y="150" font-size="86" text-anchor="middle" fill="rgba(255,255,255,.92)" font-family="serif">${initial}</text>
    <text x="100" y="255" font-size="16" text-anchor="middle" fill="rgba(255,255,255,.9)" font-family="sans-serif">${ttl}</text>
    ${au ? `<text x="100" y="272" font-size="12" text-anchor="middle" fill="rgba(255,255,255,.8)" font-family="sans-serif">${au}</text>` : ''}
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-store');
  res.send(svg);
});

/* ============================================================
 * 上传/更换封面 (作者密钥 或 文件上传者可操作)
 * ============================================================ */
app.post('/api/file/:id/cover', auth, (req, res) => {
  const f = metadata.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ ok: false, error: 'not found' });
  const authorKey = String((req.body || {}).authorKey || '');
  if (!isAuthor(authorKey) && f.userId !== req.user.id) return res.status(403).json({ ok: false, error: '无权修改封面' });
  avatarUpload.single('cover')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || '封面上传失败' });
    if (!req.file) return res.status(400).json({ ok: false, error: '请选择封面图片' });
    const ext = getExt(req.file.originalname);
    const blob = fs.readFileSync(req.file.path);
    if (f.coverExt && f.coverExt !== ext) await storage.delete(coverKey(f.id, f.coverExt));
    await storage.put(coverKey(f.id, ext), blob);
    f.coverExt = ext; await saveMeta(f);
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.json({ ok: true, cover: `/cover/${f.id}` });
  });
});

/* 删除自定义封面 (回到无封面) */
app.delete('/api/file/:id/cover', auth, async (req, res) => {
  const f = metadata.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ ok: false, error: 'not found' });
  const authorKey = String((req.body || {}).authorKey || '');
  if (!isAuthor(authorKey) && f.userId !== req.user.id) return res.status(403).json({ ok: false, error: '无权删除封面' });
  if (f.coverExt) { await storage.delete(coverKey(f.id, f.coverExt)); f.coverExt = null; await saveMeta(f); }
  res.json({ ok: true });
});

/* ============================================================
 * 下载 (公开, 无需登录)
 * ============================================================ */
app.get('/api/download/:id', async (req, res) => {
  const f = metadata.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ ok: false, error: 'not found' });
  const buf = await storage.get(fileKey(f.stored));
  if (!buf) return res.status(404).json({ ok: false, error: 'file missing' });
  const rawName = (f.name || 'download').replace(/[\r\n]/g, ' ');
  const asciiFallback = rawName.replace(/[^\x00-\x7F]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(rawName)}`);
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
});

/* ============================================================
 * 删除 (作者可删任意; 作者密钥; 登录用户删自己的)
 * ============================================================ */
app.delete('/api/file/:id', async (req, res) => {
  const idx = metadata.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'not found' });
  const f = metadata[idx];
  const authorKey = String(req.query.authorKey || (req.body || {}).authorKey || '');
  const clientToken = String(req.query.clientToken || (req.body || {}).clientToken || '');
  const viewer = authUser(req);
  let allowed = false;
  if (isAuthor(authorKey)) allowed = true;
  else if (viewer && f.userId === viewer.id) allowed = true;
  else if (f.owner === 'visitor' && clientToken && clientToken === f.uploaderToken) allowed = true;
  if (!allowed) return res.status(403).json({ ok: false, error: '无权删除该文件' });
  await storage.delete(fileKey(f.stored));
  await storage.delete(textKey(f.id));
  await removeMeta(f.id);
  metadata.splice(idx, 1);
  textCache.delete(f.id);
  res.json({ ok: true });
});

/* ============================================================
 * 启动
 * ============================================================ */
(async () => {
  try {
    storage = await createStorage();
    await Promise.all([loadMetadata(), loadCategories(), loadUsers(), loadSessions()]);
    console.log(`[file-portal] storage backend = ${storage.backend}`);
    console.log(`[file-portal] files = ${metadata.length}, categories = ${categories.length}, users = ${users.length}, sessions = ${Object.keys(sessions).length}`);
    console.log(`[file-portal] ADMIN_KEY ${ADMIN_KEY ? '已设置' : '未设置(作者上传/管理将不可用)'}`);
    app.listen(PORT, HOST, () => console.log(`[file-portal] listening on http://${HOST}:${PORT}`));
  } catch (e) {
    console.error('[file-portal] 启动失败:', e.message);
    process.exit(1);
  }
})();
