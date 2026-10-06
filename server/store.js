'use strict';

/* 数据层：单文件 JSON 存储（原子写入 + 防抖），封面本地化缓存 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uid, nowIso, unique, fetchWithTimeout, clampText } = require('./util');
const { CATEGORY_SEEDS, UNCATEGORIZED } = require('./autocat');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.BOOKNEST_DATA || path.join(ROOT, 'data');
const COVER_DIR = path.join(DATA_DIR, 'covers');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_CACHE_ENTRIES = 800;
const IMAGE_EXTS = ['.jpg', '.png', '.webp', '.gif', '.heic'];

const STATUSES = {
  wish: { key: 'wish', label: '想读', color: '#f59e0b' },
  owned: { key: 'owned', label: '已购', color: '#6366f1' },
  reading: { key: 'reading', label: '在读', color: '#0ea5e9' },
  finished: { key: 'finished', label: '读过', color: '#16a34a' },
  dropped: { key: 'dropped', label: '弃读', color: '#94a3b8' },
};

const DEFAULT_TAGS = [
  { name: '想重读', color: '#f97316' },
  { name: '经典', color: '#b45309' },
  { name: '借来的', color: '#0ea5e9' },
  { name: '电子版', color: '#64748b' },
  { name: '待处理', color: '#ef4444' },
];

let db = null;
let saveTimer = null;
let saving = false;
let dirty = false;

function ensureDirs() {
  for (const dir of [DATA_DIR, COVER_DIR, UPLOAD_DIR]) if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function seedDb() {
  const now = nowIso();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    books: [],
    categories: CATEGORY_SEEDS.map((c) => ({
      id: uid('c_'),
      name: c.name,
      color: c.color,
      builtin: true,
      createdAt: now,
    })),
    tags: DEFAULT_TAGS.map((t) => ({ id: uid('t_'), name: t.name, color: t.color, createdAt: now })),
    booklists: [],
    cache: {},
    settings: { defaultStatus: 'wish', autoCategoryOnCreate: true },
  };
}

/** 历史版本的分类/标签 id 形如 `c_1_文学与小说`（含中文），放进 URL 会被百分号编码导致路由匹配失败。
 *  这里统一迁移成 ASCII id，并同步更新书籍上的引用。 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

function migrateIds() {
  const d = db;
  const map = new Map();
  for (const c of d.categories || []) {
    if (SAFE_ID_RE.test(c.id)) continue;
    const next = uid('c_');
    map.set(`cat:${c.id}`, next);
    c.id = next;
  }
  for (const t of d.tags || []) {
    if (SAFE_ID_RE.test(t.id)) continue;
    const next = uid('t_');
    map.set(`tag:${t.id}`, next);
    t.id = next;
  }
  if (!map.size) return 0;
  for (const b of d.books || []) {
    if (b.categoryId && map.has(`cat:${b.categoryId}`)) b.categoryId = map.get(`cat:${b.categoryId}`);
    if (Array.isArray(b.tagIds)) b.tagIds = b.tagIds.map((id) => map.get(`tag:${id}`) || id);
  }
  return map.size;
}

function load() {
  ensureDirs();
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = {
        ...seedDb(),
        ...parsed,
        books: Array.isArray(parsed.books) ? parsed.books : [],
        categories: Array.isArray(parsed.categories) && parsed.categories.length ? parsed.categories : seedDb().categories,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        booklists: Array.isArray(parsed.booklists) ? parsed.booklists.map(normalizeBooklistShape) : [],
        cache: parsed.cache && typeof parsed.cache === 'object' ? parsed.cache : {},
      };
      const migrated = migrateIds();
      if (migrated) {
        console.log(`[store] 已迁移 ${migrated} 个含中文的历史分类/标签 id → ASCII`);
        writeNow();
      }
      return db;
    } catch (err) {
      const broken = `${DB_FILE}.broken-${Date.now()}`;
      fs.copyFileSync(DB_FILE, broken);
      console.error(`[store] db.json 解析失败，已备份到 ${broken}，使用空库启动：${err.message}`);
    }
  }
  db = seedDb();
  migrateIds();
  writeNow();
  return db;
}

function writeNow() {
  ensureDirs();
  db.updatedAt = nowIso();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
  dirty = false;
}

function save(immediate = false) {
  dirty = true;
  if (immediate) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    writeNow();
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saving) return;
    saving = true;
    try {
      writeNow();
    } finally {
      saving = false;
    }
  }, 250);
}

function getDb() {
  if (!db) load();
  return db;
}

/* ---------------- 缓存（元数据查询结果） ---------------- */

const cacheApi = {
  get(key) {
    const c = getDb().cache[key];
    return c || null;
  },
  set(key, value) {
    const c = getDb().cache;
    c[key] = value;
    const keys = Object.keys(c);
    if (keys.length > MAX_CACHE_ENTRIES) {
      keys
        .sort((a, b) => (c[a].ts || 0) - (c[b].ts || 0))
        .slice(0, keys.length - MAX_CACHE_ENTRIES)
        .forEach((k) => delete c[k]);
    }
    save();
  },
  clear() {
    getDb().cache = {};
    save(true);
  },
  size() {
    return Object.keys(getDb().cache).length;
  },
};

/* ---------------- 分类 / 标签 ---------------- */

function listCategories() {
  return getDb()
    .categories.slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function findCategoryByName(name) {
  const target = String(name || '').trim();
  if (!target) return null;
  return getDb().categories.find((c) => c.name === target) || null;
}

function addCategory({ name, color }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('分类名不能为空');
  if (findCategoryByName(clean)) throw new Error('分类已存在');
  const item = { id: uid('c_'), name: clean, color: color || '#64748b', builtin: false, createdAt: nowIso() };
  getDb().categories.push(item);
  save(true);
  return item;
}

/** 兼容迁移前的中文 id（形如 c_1_文学与小说 / t_2_经典）：找不回时按名字再匹配一次，
 *  这样已经打开的老页面（浏览器里还缓存着旧 id）也能正常改名/删除，刷新后自然恢复。 */
function legacyLookup(kind, id) {
  const m = String(id || '').match(/^[ct]_\d+_(.+)$/);
  if (!m) return null;
  const name = m[1];
  if (kind === 'cat') return findCategoryByName(name);
  return getDb().tags.find((t) => t.name === name) || null;
}

function updateCategory(id, patch) {
  const item = getDb().categories.find((c) => c.id === id) || legacyLookup('cat', id);
  if (!item) throw new Error('分类不存在');
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('分类名不能为空');
    const dup = findCategoryByName(name);
    if (dup && dup.id !== item.id) throw new Error('分类已存在');
    item.name = name;
  }
  if (patch.color) item.color = patch.color;
  save(true);
  return item;
}

function deleteCategory(id, reassignTo = '') {
  const d = getDb();
  const target = d.categories.find((c) => c.id === id) || legacyLookup('cat', id);
  if (!target) throw new Error('分类不存在');
  d.categories = d.categories.filter((c) => c.id !== target.id);
  for (const b of d.books) if (b.categoryId === target.id) b.categoryId = reassignTo || '';
  save(true);
  return { ok: true, id: target.id };
}

function listTags() {
  return getDb().tags.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function addTag({ name, color }) {
  const clean = String(name || '').trim().replace(/^#/, '');
  if (!clean) throw new Error('标签名不能为空');
  const d = getDb();
  if (d.tags.some((t) => t.name === clean)) throw new Error('标签已存在');
  const item = { id: uid('t_'), name: clean, color: color || '#6366f1', createdAt: nowIso() };
  d.tags.push(item);
  save(true);
  return item;
}

function updateTag(id, patch) {
  const d = getDb();
  const item = d.tags.find((t) => t.id === id) || legacyLookup('tag', id);
  if (!item) throw new Error('标签不存在');
  if (patch.name != null) {
    const name = String(patch.name).trim().replace(/^#/, '');
    if (!name) throw new Error('标签名不能为空');
    if (d.tags.some((t) => t.name === name && t.id !== item.id)) throw new Error('标签已存在');
    item.name = name;
  }
  if (patch.color) item.color = patch.color;
  save(true);
  return item;
}

function deleteTag(id) {
  const d = getDb();
  const target = d.tags.find((t) => t.id === id) || legacyLookup('tag', id);
  if (!target) throw new Error('标签不存在');
  d.tags = d.tags.filter((t) => t.id !== target.id);
  for (const b of d.books) b.tagIds = (b.tagIds || []).filter((t) => t !== target.id);
  save(true);
  return { ok: true, id: target.id };
}

/* ---------------- 书籍 ---------------- */

function coerceArray(v) {
  if (Array.isArray(v)) return unique(v.map((x) => String(x).trim()).filter(Boolean));
  if (typeof v === 'string') return unique(v.split(/[\/,，;；|]/).map((x) => x.trim()).filter(Boolean));
  return [];
}

function normalizeBookInput(input = {}, base = {}) {
  const status = STATUSES[input.status] ? input.status : base.status || 'wish';
  const now = nowIso();
  return {
    ...base,
    id: base.id || uid('b_'),
    title: String(input.title != null ? input.title : base.title || '').trim() || '未命名',
    subtitle: String(input.subtitle != null ? input.subtitle : base.subtitle || '').trim(),
    originalTitle: String(input.originalTitle != null ? input.originalTitle : base.originalTitle || '').trim(),
    authors: input.authors != null ? coerceArray(input.authors) : base.authors || [],
    translators: input.translators != null ? coerceArray(input.translators) : base.translators || [],
    publisher: String(input.publisher != null ? input.publisher : base.publisher || '').trim(),
    producer: String(input.producer != null ? input.producer : base.producer || '').trim(),
    pubdate: String(input.pubdate != null ? input.pubdate : base.pubdate || '').trim(),
    pages: Number(input.pages != null ? input.pages : base.pages) || 0,
    price: String(input.price != null ? input.price : base.price || '').trim(),
    binding: String(input.binding != null ? input.binding : base.binding || '').trim(),
    series: String(input.series != null ? input.series : base.series || '').trim(),
    isbn13: String((input.isbn13 != null ? input.isbn13 : base.isbn13) || '').replace(/[^\dXx]/g, ''),
    isbn10: String((input.isbn10 != null ? input.isbn10 : base.isbn10) || '').replace(/[^\dXx]/g, ''),
    cover: String(input.cover != null ? input.cover : base.cover || ''),
    coverRemote: String(input.coverRemote != null ? input.coverRemote : base.coverRemote || ''),
    summary: clampText(String(input.summary != null ? input.summary : base.summary || ''), 6000),
    authorIntro: clampText(String(input.authorIntro != null ? input.authorIntro : base.authorIntro || ''), 4000),
    rating: Number(input.rating != null ? input.rating : base.rating) || 0,
    ratingCount: Number(input.ratingCount != null ? input.ratingCount : base.ratingCount) || 0,
    ratingLabel: String(input.ratingLabel != null ? input.ratingLabel : base.ratingLabel || '').trim(),
    ratingScale: String(input.ratingScale != null ? input.ratingScale : base.ratingScale || '').trim(),
    subjects: input.subjects != null ? coerceArray(input.subjects) : base.subjects || [],
    source: String(input.source != null ? input.source : base.source || (input.manual ? 'manual' : '')).trim(),
    sourceUrl: String(input.sourceUrl != null ? input.sourceUrl : base.sourceUrl || '').trim(),
    autoCategoryName: String(
      input.autoCategoryName != null
        ? input.autoCategoryName
        : (input.autoCategory && input.autoCategory.name) || base.autoCategoryName || ''
    ).trim(),
    autoCategoryColor: String(
      input.autoCategoryColor != null
        ? input.autoCategoryColor
        : (input.autoCategory && input.autoCategory.color) || base.autoCategoryColor || UNCATEGORIZED.color
    ).trim(),
    status,
    categoryId: String(input.categoryId != null ? input.categoryId : base.categoryId || ''),
    tagIds: input.tagIds != null ? unique(input.tagIds.map(String)) : base.tagIds || [],
    note: clampText(String(input.note != null ? input.note : base.note || ''), 4000),
    myRating: Number(input.myRating != null ? input.myRating : base.myRating) || 0,
    progress: Math.max(0, Math.min(100, Number(input.progress != null ? input.progress : base.progress) || 0)),
    location: String(input.location != null ? input.location : base.location || '').trim(),
    addedAt: base.addedAt || now,
    updatedAt: now,
    startedAt:
      status === 'reading' && !base.startedAt
        ? now
        : String(input.startedAt != null ? input.startedAt : base.startedAt || ''),
    finishedAt:
      status === 'finished' && !base.finishedAt
        ? now
        : String(input.finishedAt != null ? input.finishedAt : base.finishedAt || ''),
  };
}

function listBooks() {
  return getDb().books.slice();
}

function getBook(id) {
  return getDb().books.find((b) => b.id === id) || null;
}

function findBookByIsbn(isbn13) {
  if (!isbn13) return null;
  return getDb().books.find((b) => b.isbn13 === isbn13) || null;
}

function addBook(input) {
  const book = normalizeBookInput(input);
  getDb().books.push(book);
  save(true);
  return book;
}

function updateBook(id, patch) {
  const d = getDb();
  const idx = d.books.findIndex((b) => b.id === id);
  if (idx < 0) throw new Error('书籍不存在');
  const book = normalizeBookInput(patch, d.books[idx]);
  if (patch.status && patch.status !== d.books[idx].status) {
    if (patch.status === 'reading') book.startedAt = patch.startedAt || nowIso();
    if (patch.status === 'finished') {
      book.finishedAt = patch.finishedAt || nowIso();
      book.progress = patch.progress != null ? book.progress : 100;
    }
  }
  d.books[idx] = book;
  save(true);
  return book;
}

function deleteBook(id) {
  const d = getDb();
  d.books = d.books.filter((b) => b.id !== id);
  for (const list of d.booklists) list.items = list.items.filter((i) => i.bookId !== id);
  const cover = path.join(COVER_DIR, `${id}`);
  for (const ext of ['.jpg', '.png', '.webp', '.gif']) {
    const f = cover + ext;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  save(true);
  return { ok: true };
}

function bulkDeleteBooks(ids) {
  const d = getDb();
  const set = new Set(ids || []);
  d.books = d.books.filter((b) => !set.has(b.id));
  for (const list of d.booklists) list.items = list.items.filter((i) => !set.has(i.bookId));
  save(true);
  return { ok: true, removed: set.size };
}

/** 清空全部数据（保留内置分类） */
function wipe() {
  const fresh = seedDb();
  db.books = [];
  db.categories = fresh.categories;
  db.tags = [];
  db.booklists = [];
  db.cache = {};
  save(true);
  return { ok: true };
}

/** 按推荐分类给"未分类"的书套用真实分类，返回更新数量 */
function autoCategorizeAll(overwrite = false) {
  const d = getDb();
  let updated = 0;
  for (const book of d.books) {
    if (book.categoryId && !overwrite) continue;
    const name = book.autoCategoryName || '未分类';
    let cat = d.categories.find((c) => c.name === name);
    if (!cat) {
      cat = {
        id: uid('c_'),
        name,
        color: book.autoCategoryColor || UNCATEGORIZED.color,
        builtin: false,
        createdAt: nowIso(),
      };
      d.categories.push(cat);
    }
    if (book.categoryId !== cat.id) {
      book.categoryId = cat.id;
      book.updatedAt = nowIso();
      updated += 1;
    }
  }
  save(true);
  return { ok: true, updated };
}

/* ---------------- 书单 ---------------- */

const BOOKLIST_SORTS = {
  'added-desc': '最近加入',
  'added-asc': '最早加入',
  'rating-desc': '公开评分高→低',
  'myrating-desc': '我的评分高→低',
  'title-asc': '书名 A→Z',
  'author-asc': '作者 A→Z',
  'pubdate-desc': '出版时间新→旧',
  'pubdate-asc': '出版时间旧→新',
  'status-asc': '按阅读状态',
};

/** 兼容旧数据 / 导入数据：统一成 {bookId, addedAt} 结构 */
function normalizeBooklistShape(raw) {
  const now = nowIso();
  const items = [];
  const seen = new Set();
  const push = (bookId, addedAt) => {
    if (!bookId || seen.has(bookId)) return;
    seen.add(bookId);
    items.push({ bookId: String(bookId), addedAt: addedAt || now });
  };
  if (Array.isArray(raw.items)) {
    for (const it of raw.items) {
      if (!it) continue;
      if (typeof it === 'string') push(it, now);
      else push(it.bookId, it.addedAt);
    }
  } else if (Array.isArray(raw.bookIds)) {
    for (const id of raw.bookIds) push(id, now);
  }
  return {
    id: raw.id || uid('l_'),
    name: String(raw.name || '未命名书单').trim(),
    description: String(raw.description || '').trim(),
    color: raw.color || '#2563eb',
    sort: BOOKLIST_SORTS[raw.sort] ? raw.sort : 'added-desc',
    items,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
  };
}

function listBooklists() {
  return getDb()
    .booklists.slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getBooklist(id) {
  return getDb().booklists.find((l) => l.id === id) || null;
}

function findBooklistByName(name) {
  const target = String(name || '').trim();
  if (!target) return null;
  return getDb().booklists.find((l) => l.name === target) || null;
}

function addBooklist({ name, description, color, sort }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('书单名不能为空');
  const d = getDb();
  if (d.booklists.some((l) => l.name === clean)) throw new Error('已有同名书单');
  const now = nowIso();
  const item = {
    id: uid('l_'),
    name: clean,
    description: String(description || '').trim(),
    color: color || '#2563eb',
    sort: BOOKLIST_SORTS[sort] ? sort : 'added-desc',
    items: [],
    createdAt: now,
    updatedAt: now,
  };
  d.booklists.push(item);
  save(true);
  return item;
}

function updateBooklist(id, patch) {
  const d = getDb();
  const item = d.booklists.find((l) => l.id === id);
  if (!item) throw new Error('书单不存在');
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('书单名不能为空');
    if (d.booklists.some((l) => l.name === name && l.id !== id)) throw new Error('已有同名书单');
    item.name = name;
  }
  if (patch.description != null) item.description = String(patch.description).trim();
  if (patch.color) item.color = patch.color;
  if (patch.sort && BOOKLIST_SORTS[patch.sort]) item.sort = patch.sort;
  item.updatedAt = nowIso();
  save(true);
  return item;
}

function deleteBooklist(id) {
  const d = getDb();
  d.booklists = d.booklists.filter((l) => l.id !== id);
  save(true);
  return { ok: true };
}

/** 往书单里加书（只接受书架上已有的书，重复自动跳过） */
function addBooksToBooklist(id, bookIds) {
  const list = getBooklist(id);
  if (!list) throw new Error('书单不存在');
  const have = new Set(list.items.map((i) => i.bookId));
  const now = nowIso();
  let added = 0;
  let skipped = 0;
  for (const raw of bookIds || []) {
    const bid = String(raw || '');
    if (!bid || have.has(bid)) {
      skipped += 1;
      continue;
    }
    if (!getBook(bid)) {
      skipped += 1;
      continue;
    }
    list.items.push({ bookId: bid, addedAt: now });
    have.add(bid);
    added += 1;
  }
  list.updatedAt = now;
  save(true);
  return { ok: true, added, skipped, total: list.items.length };
}

function removeBooksFromBooklist(id, bookIds) {
  const list = getBooklist(id);
  if (!list) throw new Error('书单不存在');
  const set = new Set((bookIds || []).map(String));
  const before = list.items.length;
  list.items = list.items.filter((i) => !set.has(i.bookId));
  list.updatedAt = nowIso();
  save(true);
  return { ok: true, removed: before - list.items.length, total: list.items.length };
}

/** 某本书属于哪些书单 */
function booklistsOfBook(bookId) {
  return getDb()
    .booklists.filter((l) => l.items.some((i) => i.bookId === bookId))
    .map((l) => l.id);
}

/** 书单进度：读过几本 / 共几本 */
function booklistStats(list) {
  const counts = { wish: 0, owned: 0, reading: 0, finished: 0, dropped: 0 };
  let pages = 0;
  let finishedPages = 0;
  let ratingSum = 0;
  let rated = 0;
  for (const it of (list && list.items) || []) {
    const b = getBook(it.bookId);
    if (!b) continue;
    counts[b.status] = (counts[b.status] || 0) + 1;
    pages += b.pages || 0;
    if (b.status === 'finished') finishedPages += b.pages || 0;
    if (b.myRating) {
      ratingSum += b.myRating;
      rated += 1;
    }
  }
  const total = ((list && list.items) || []).length;
  const finished = counts.finished || 0;
  return {
    total,
    finished,
    reading: counts.reading || 0,
    wish: counts.wish || 0,
    owned: counts.owned || 0,
    dropped: counts.dropped || 0,
    unread: total - finished,
    progress: total ? Math.round((finished / total) * 100) : 0,
    label: `${finished}/${total}`,
    pages,
    finishedPages,
    avgMyRating: rated ? Math.round((ratingSum / rated) * 10) / 10 : 0,
  };
}

function booklistView(list, opts = {}) {
  const out = {
    id: list.id,
    name: list.name,
    description: list.description,
    color: list.color,
    sort: list.sort,
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
    items: list.items.map((i) => ({ bookId: i.bookId, addedAt: i.addedAt })),
    stats: booklistStats(list),
  };
  if (opts.bookIds) out.bookIds = list.items.map((i) => i.bookId);
  return out;
}

/* ---------------- 封面本地化 ---------------- */

function refererFor(url) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();
  if (/doubanio\.com|douban\.com/.test(host)) return 'https://book.douban.com/';
  if (/weread\.qq\.com|qq\.com/.test(host)) return 'https://weread.qq.com/';
  return '';
}

const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

async function fetchImage(url, timeout = 8000) {
  const headers = { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' };
  const ref = refererFor(url);
  if (ref) headers.Referer = ref;
  const res = await fetchWithTimeout(url, { headers }, timeout);
  if (!res.ok) throw new Error(`封面下载失败 HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error(`不是图片（${type || '未知类型'}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('封面内容为空');
  return { buf, ext: EXT_BY_TYPE[type] || '.jpg', type };
}

/** 把远程封面存到本地，返回可访问路径 */
async function localizeCover(url, baseName) {
  if (!url) return '';
  try {
    const { buf, ext } = await fetchImage(url);
    ensureDirs();
    const file = path.join(COVER_DIR, `${baseName}${ext}`);
    fs.writeFileSync(file, buf);
    return `/covers/${baseName}${ext}`;
  } catch (err) {
    return '';
  }
}

/* ---------------- 封面照片上传（无条码的书用拍照识别） ---------------- */

const EXT_BY_UPLOAD_TYPE = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heic' };

function extFromImageType(type) {
  return EXT_BY_UPLOAD_TYPE[String(type || '').toLowerCase()] || '.jpg';
}

/** 保存前端上传的封面照片，返回 token 与可访问地址 */
function saveUpload(buf, ext) {
  ensureDirs();
  const safeExt = IMAGE_EXTS.indexOf(ext) >= 0 ? ext : '.jpg';
  const token = `up${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, `${token}${safeExt}`), buf);
  return { token, ext: safeExt, url: `/uploads/${token}${safeExt}` };
}

function uploadPath(token) {
  if (!token || !/^[\w-]{4,48}$/.test(token)) return null;
  for (const ext of IMAGE_EXTS) {
    const f = path.join(UPLOAD_DIR, `${token}${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** 把上传的照片变成某本书的封面（存到 covers/ 下，随书删除） */
function promoteUpload(token, bookId) {
  const src = uploadPath(token);
  if (!src || !bookId) return '';
  const ext = path.extname(src) || '.jpg';
  ensureDirs();
  const dest = path.join(COVER_DIR, `${bookId}${ext}`);
  fs.copyFileSync(src, dest);
  return `/covers/${bookId}${ext}`;
}

/** 清理过期上传（默认 7 天） */
function pruneUploads(maxAgeMs = 7 * 24 * 3600 * 1000) {
  if (!fs.existsSync(UPLOAD_DIR)) return 0;
  let removed = 0;
  const now = Date.now();
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    const f = path.join(UPLOAD_DIR, name);
    try {
      if (now - fs.statSync(f).mtimeMs > maxAgeMs) {
        fs.unlinkSync(f);
        removed += 1;
      }
    } catch (err) {
      /* 忽略 */
    }
  }
  return removed;
}

/** 图片代理用的磁盘缓存（按 URL 哈希） */
async function cachedImage(url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 24);
  ensureDirs();
  for (const ext of ['.jpg', '.png', '.webp', '.gif']) {
    const f = path.join(COVER_DIR, `p_${hash}${ext}`);
    if (fs.existsSync(f)) return { file: f, ext };
  }
  const { buf, ext } = await fetchImage(url);
  const f = path.join(COVER_DIR, `p_${hash}${ext}`);
  fs.writeFileSync(f, buf);
  return { file: f, ext };
}

const ALLOWED_IMAGE_HOSTS = [
  'doubanio.com',
  'douban.com',
  'weread.qq.com',
  'cdn.weread.qq.com',
  'books.google.com',
  'books.googleusercontent.com',
  'googleusercontent.com',
  'openlibrary.org',
  'covers.openlibrary.org',
  'archive.org',
  'img1.doubanio.com',
  'img2.doubanio.com',
  'img3.doubanio.com',
  'img9.doubanio.com',
];

function isAllowedImageUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    // 豆瓣"上传封面"等占位链接不是图片
    if (/update_image|\/pics\/|book-default|default-lpic/i.test(u.pathname)) return false;
    return ALLOWED_IMAGE_HOSTS.some((h) => u.host === h || u.host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/* ---------------- 统计 ---------------- */

function stats() {
  const d = getDb();
  const byStatus = {};
  for (const key of Object.keys(STATUSES)) byStatus[key] = 0;
  const byCategory = {};
  const byTag = {};
  let pages = 0;
  let ratingSum = 0;
  let ratingCount = 0;
  let finishedPages = 0;
  for (const b of d.books) {
    byStatus[b.status] = (byStatus[b.status] || 0) + 1;
    const cat = b.categoryId || `auto:${b.autoCategoryName || '未分类'}`;
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    for (const t of b.tagIds || []) byTag[t] = (byTag[t] || 0) + 1;
    pages += b.pages || 0;
    if (b.myRating) {
      ratingSum += b.myRating;
      ratingCount += 1;
    }
    if (b.status === 'finished') finishedPages += b.pages || 0;
  }
  const catName = (id) => {
    if (id.startsWith('auto:')) return id.slice(5);
    const c = d.categories.find((x) => x.id === id);
    return c ? c.name : '未分类';
  };
  const catColor = (id) => {
    if (id.startsWith('auto:')) {
      const b = d.books.find((x) => `auto:${x.autoCategoryName || '未分类'}` === id);
      return (b && b.autoCategoryColor) || UNCATEGORIZED.color;
    }
    const c = d.categories.find((x) => x.id === id);
    return c ? c.color : UNCATEGORIZED.color;
  };
  const tagName = (id) => (d.tags.find((t) => t.id === id) || {}).name || '未知标签';
  const tagColor = (id) => (d.tags.find((t) => t.id === id) || {}).color || '#94a3b8';
  return {
    total: d.books.length,
    byStatus,
    statuses: STATUSES,
    byCategory: Object.entries(byCategory)
      .map(([id, count]) => ({ id, name: catName(id), color: catColor(id), count }))
      .sort((a, b) => b.count - a.count),
    byTag: Object.entries(byTag)
      .map(([id, count]) => ({ id, name: tagName(id), color: tagColor(id), count }))
      .sort((a, b) => b.count - a.count),
    pages,
    finishedPages,
    avgMyRating: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0,
    ratedCount: ratingCount,
    cacheEntries: Object.keys(d.cache).length,
    dataFile: DB_FILE,
  };
}

module.exports = {
  STATUSES,
  DEFAULT_TAGS,
  init: load,
  getDb,
  save,
  cache: cacheApi,
  listCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  findCategoryByName,
  listTags,
  addTag,
  updateTag,
  deleteTag,
  listBooklists,
  getBooklist,
  findBooklistByName,
  addBooklist,
  updateBooklist,
  deleteBooklist,
  addBooksToBooklist,
  removeBooksFromBooklist,
  booklistsOfBook,
  booklistStats,
  booklistView,
  normalizeBooklistShape,
  BOOKLIST_SORTS,
  listBooks,
  getBook,
  findBookByIsbn,
  addBook,
  updateBook,
  deleteBook,
  bulkDeleteBooks,
  wipe,
  autoCategorizeAll,
  localizeCover,
  cachedImage,
  isAllowedImageUrl,
  saveUpload,
  uploadPath,
  promoteUpload,
  pruneUploads,
  extFromImageType,
  stats,
  DB_FILE,
  DATA_DIR,
  COVER_DIR,
  UPLOAD_DIR,
};
