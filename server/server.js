'use strict';

/* 书巢 BookNest —— 零依赖 HTTP/HTTPS 服务：静态资源 + REST API + 封面代理 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const store = require('./store');
const providers = require('./providers');
const movie = require('./providers/movie');
const doubanUser = require('./providers/douban-user');
const ocr = require('./ocr');
const auth = require('./auth');
const isbnUtil = require('./isbn');
const { toCsv, nowIso } = require('./util');

const ROOT = path.resolve(__dirname, '..');

/** 当前运行的版本与提交号（用于确认"服务器上跑的到底是哪份代码"） */
const APP_VERSION = (() => {
  try {
    return require(path.join(ROOT, 'package.json')).version || '0.0.0';
  } catch (err) {
    return '0.0.0';
  }
})();
function gitCommit() {
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const direct = path.join(ROOT, '.git', ref);
      if (fs.existsSync(direct)) return fs.readFileSync(direct, 'utf8').trim().slice(0, 7);
      const packed = path.join(ROOT, '.git', 'packed-refs');
      if (fs.existsSync(packed)) {
        const line = fs.readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(' ' + ref));
        if (line) return line.split(' ')[0].slice(0, 7);
      }
      return ref;
    }
    return head.slice(0, 7);
  } catch (err) {
    return '';
  }
}
const APP_COMMIT = gitCommit();
const PUBLIC_DIR = path.join(ROOT, 'public');
const CERT_DIR = path.join(ROOT, 'certs');
const HTTPS_PORT = Number(process.env.PORT || 8787);
const HTTP_PORT = Number(process.env.HTTP_PORT || HTTPS_PORT + 1);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/* ---------------- helpers ---------------- */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const base = {
    'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : MIME['.json'],
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  };
  res.writeHead(status, base);
  if (res.req && res.req.method === 'HEAD') res.end();
  else res.end(payload);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/** 读取原始二进制请求体（上传封面照片用） */
async function readRawBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('图片太大（超过 12MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function lanAddresses() {  const out = [];
  const nics = os.networkInterfaces();
  for (const [name, list] of Object.entries(nics)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ iface: name, address: ni.address });
    }
  }
  return out;
}

/** URL 路径里的 id 可能被百分号编码（中文/空格等），安全解码 */
function decodeId(raw) {
  try {
    return decodeURIComponent(String(raw || ''));
  } catch (err) {
    return String(raw || '');
  }
}

/** 代理状态：代理只在进程启动时生效（Node 的 fetch 通过 NODE_USE_ENV_PROXY 读取环境变量） */
function proxyInfo() {
  const url =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.BOOKNEST_PROXY ||
    '';
  const flag = String(process.env.NODE_USE_ENV_PROXY || '').toLowerCase();
  const envProxyEnabled = flag === '1' || flag === 'true' || flag === 'yes';
  const stored = (store.getDb().settings || {}).proxy || null;
  const major = Number(String(process.versions.node).split('.')[0]) || 0;
  return {
    active: envProxyEnabled && !!url,
    url,
    envProxyEnabled,
    stored,
    supported: major >= 24,
    node: process.versions.node,
  };
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  let root = PUBLIC_DIR;
  if (rel.startsWith('/covers/')) {
    root = store.COVER_DIR;
    rel = rel.slice('/covers'.length);
  } else if (rel.startsWith('/uploads/')) {
    root = store.UPLOAD_DIR;
    rel = rel.slice('/uploads'.length);
  }
  const filePath = path.join(root, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(root)) return send(res, 403, 'Forbidden');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (rel.startsWith('/covers/') || rel.startsWith('/uploads/')) return send(res, 404, 'Not found');
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      if (!rel.startsWith('/api')) {
        return fs.readFile(fallback, (e2, buf) => {
          if (e2) return send(res, 404, 'Not found');
          send(res, 200, buf, { 'Content-Type': MIME['.html'] });
        });
      }
      return send(res, 404, 'Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const immutable = rel.startsWith('/vendor/') || rel.startsWith('/icons/') || rel.startsWith('/covers/');
    fs.readFile(filePath, (e3, buf) => {
      if (e3) return send(res, 500, 'Read error');
      send(res, 200, buf, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=604800' : 'no-cache',
        'Service-Worker-Allowed': '/',
      });
    });
  });
}

/* ---------------- API ---------------- */

function bookView(book) {
  return book;
}

/* TMDb Key 优先取设置页保存的值，其次取环境变量（云端建议用环境变量，避免写进数据库） */
function tmdbKey() {
  const fromSettings = ((store.getDb().settings || {}).tmdbApiKey || '').trim();
  return fromSettings || String(process.env.BOOKNEST_TMDB_KEY || '').trim();
}

function omdbKey() {
  const fromSettings = ((store.getDb().settings || {}).omdbApiKey || '').trim();
  return fromSettings || String(process.env.BOOKNEST_OMDB_KEY || '').trim();
}

/* 豆瓣登录 Cookie（可选）：设置页填写，用于恢复被限流的电影搜索 */
function doubanCookie() {
  const fromSettings = String(((store.getDb().settings || {}).doubanCookie) || '').trim();
  return fromSettings || String(process.env.BOOKNEST_DOUBAN_COOKIE || '').trim();
}

/** 每次处理影片请求前同步给 provider（带上登录态） */
function applyDoubanCookie() {
  movie.setDoubanCookie(doubanCookie());
}

/* 对外返回的设置：把 API Key / Cookie 换成"是否已配置"的布尔值，密钥本身不回传前端 */
const SECRET_SETTING_KEYS = ['googleBooksApiKey', 'tmdbApiKey', 'omdbApiKey', 'doubanCookie'];
function publicSettings() {
  const raw = { ...(store.getDb().settings || {}) };
  for (const k of SECRET_SETTING_KEYS) {
    const v = String(raw[k] || '').trim();
    delete raw[k];
    raw[`${k}Set`] = !!v;
  }
  if (process.env.BOOKNEST_TMDB_KEY) raw.tmdbApiKeySet = true;
  if (process.env.BOOKNEST_OMDB_KEY) raw.omdbApiKeySet = true;
  return raw;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      time: nowIso(),
      pid: process.pid,
      version: APP_VERSION,
      commit: APP_COMMIT,
      uptimeSec: Math.round(process.uptime()),
      movieSupport: true, // 有影片模块的新代码才有这个字段，旧进程不会有
      authRequired: auth.enabled(), // true 时其它 /api 需要先登录，裸 curl 会拿到 401
    });
  }

  if (p === '/api/bootstrap' && req.method === 'GET') {
    const db = store.getDb();
    return sendJson(res, 200, {
      books: store.listBooks().map(bookView),
      categories: store.listCategories(),
      tags: store.listTags(),
      booklists: store.listBooklists().map((l) => store.booklistView(l, { bookIds: true })),
      booklistSorts: store.BOOKLIST_SORTS,
      movies: store.listMovies(),
      movieLists: store.listMovieLists().map((l) => store.movieListView(l, { movieIds: true })),
      movieListSorts: store.MOVIE_LIST_SORTS,
      movieStats: store.movieStats(),
      movieStatuses: store.MOVIE_STATUSES,
      stats: store.stats(),
      statuses: store.STATUSES,
      settings: publicSettings(),
      providers: providers.healthSnapshot(),
      server: {
        httpsPort: HTTPS_PORT,
        httpPort: HTTP_PORT,
        httpsEnabled: httpsEnabled(),
        lan: lanAddresses(),
        proxy: proxyInfo(),
        ocr: ocr.engineAvailable(),
        authEnabled: auth.enabled(),
        platform: `${process.platform} ${process.arch}`,
        node: process.versions.node,
        time: nowIso(),
      },
    });
  }

  if (p === '/api/providers' && req.method === 'GET') {
    return sendJson(res, 200, { providers: providers.healthSnapshot() });
  }

  if (p === '/api/providers/check' && req.method === 'POST') {
    const snapshot = await providers.checkHealth(true);
    return sendJson(res, 200, { providers: snapshot });
  }

  if (p === '/api/lookup' && (req.method === 'POST' || req.method === 'GET')) {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const rawIsbn = String(body.isbn || q.get('isbn') || '').trim();
    const title = String(body.title || q.get('title') || '').trim();
    const source = String(body.source || q.get('source') || '').trim();
    const sourceId = String(body.sourceId || q.get('sourceId') || '').trim();
    const force = body.force === true || q.get('force') === '1';
    let isbn = '';
    let isbnNote = '';
    if (rawIsbn) {
      const norm = isbnUtil.normalize(rawIsbn);
      if (!norm.ok) {
        // 允许非标准条码继续尝试按文本搜索，但要告知前端
        isbnNote = norm.reason || '条码不是有效 ISBN';
        isbn = isbnUtil.digitsOf(rawIsbn);
      } else {
        isbn = norm.isbn13;
      }
    }
    if (!isbn && !title && !sourceId) return sendJson(res, 400, { error: '请提供 isbn 或 title' });
    try {
      const result = await providers.lookup({ isbn, title, source, sourceId, force }, { cache: store.cache });
      const duplicate = result.record.isbn13 ? store.findBookByIsbn(result.record.isbn13) : null;
      return sendJson(res, 200, { ...result, rawIsbn, isbnNote, duplicate: duplicate ? bookView(duplicate) : null });
    } catch (err) {
      return sendJson(res, 502, { error: err.message || '抓取失败' });
    }
  }

  if (p === '/api/uploads' && req.method === 'POST') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    let buf;
    try {
      buf = await readRawBody(req);
    } catch (err) {
      return sendJson(res, 413, { error: err.message });
    }
    if (!buf || !buf.length) return sendJson(res, 400, { error: '没有收到图片' });
    const upload = store.saveUpload(buf, store.extFromImageType(type));
    return sendJson(res, 201, { token: upload.token, url: upload.url });
  }

  if (p === '/api/cover-search' && req.method === 'POST') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    let buf;
    try {
      buf = await readRawBody(req);
    } catch (err) {
      return sendJson(res, 413, { ok: false, error: err.message });
    }
    if (!buf || !buf.length) return sendJson(res, 400, { ok: false, error: '没有收到图片' });
    const upload = store.saveUpload(buf, store.extFromImageType(type));
    const base = { ok: false, token: upload.token, url: upload.url, ocr: { lines: [], text: '' }, queries: [], candidates: [] };
    const avail = ocr.engineAvailable();
    if (!avail.ok) return sendJson(res, 200, { ...base, error: avail.reason, hint: avail.hint || '' });
    try {
      const result = await ocr.recognize(store.uploadPath(upload.token));
      const { queries } = ocr.pickQueries(result.lines);
      const found = [];
      for (const q of queries) {
        const list = await providers.search(q).catch(() => []);
        found.push(...list);
      }
      const candidates = ocr.rankCandidates(found, result.lines, result.text).slice(0, 10);
      return sendJson(res, 200, {
        ok: candidates.length > 0,
        token: upload.token,
        url: upload.url,
        engine: result.engine,
        ocr: { lines: result.lines, text: result.text },
        queries,
        candidates,
        error: candidates.length ? '' : '没识别出可用的书名，换个角度重拍，或直接手输书名',
      });
    } catch (err) {
      return sendJson(res, 200, { ...base, error: err.message || '封面识别失败' });
    }
  }

  if (p === '/api/author-books' && req.method === 'GET') {
    const name = String(q.get('name') || '').trim();
    if (!name) return sendJson(res, 400, { error: '请提供作者名' });
    const force = q.get('force') === '1';
    const cacheKey = `author:v1:${name}`;
    const cached = store.cache.get(cacheKey);
    let raw = null;
    if (!force && cached && Date.now() - cached.ts < 3 * 24 * 3600 * 1000) {
      raw = cached.data;
    } else {
      try {
        raw = await providers.byAuthor(name, { limit: 60 });
        store.cache.set(cacheKey, { ts: Date.now(), data: raw });
      } catch (err) {
        return sendJson(res, 200, { name, total: 0, items: [], error: err.message || '查找失败' });
      }
    }
    // 「已在书架」每次重新判断（缓存可能是加书之前生成的）
    const norm = (s) =>
      String(s || '')
        .toLowerCase()
        .replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
    const ownedByTitle = new Map();
    for (const b of store.listBooks()) {
      ownedByTitle.set(norm(b.title), b.id);
      const sid = (String(b.sourceUrl || '').match(/subject\/(\d+)/) || [])[1];
      if (sid) ownedByTitle.set(`douban:${sid}`, b.id);
    }
    const items = (raw.items || []).map((it) => {
      const byId = it.source === 'douban' && it.id ? ownedByTitle.get(`douban:${it.id}`) : null;
      const byTitle = ownedByTitle.get(norm(it.title));
      const bookId = byId || byTitle || '';
      return { ...it, owned: !!bookId, bookId };
    });
    return sendJson(res, 200, {
      name: raw.name || name,
      total: raw.total || items.length,
      sources: raw.sources || [],
      cached: !!cached && !force,
      items,
    });
  }

  if (p === '/api/search' && req.method === 'GET') {
    const keyword = String(q.get('q') || '').trim();
    if (!keyword) return sendJson(res, 200, { results: [] });
    const results = await providers.search(keyword);
    return sendJson(res, 200, { results });
  }

  if (p === '/api/books' && req.method === 'POST') {
    const body = await readBody(req);
    const status = store.STATUSES[body.status] ? body.status : 'wish';
    let input = { ...body, status };
    const norm = isbnUtil.normalize(input.isbn13 || input.isbn10 || '');
    if (norm.ok) {
      input.isbn13 = norm.isbn13;
      input.isbn10 = norm.isbn10;
      const existing = store.findBookByIsbn(norm.isbn13);
      if (existing && !body.allowDuplicate) {
        return sendJson(res, 409, { error: '这本书已经在书架里了', book: existing });
      }
    }
    if (!input.categoryId && input.autoCategoryName && (store.getDb().settings || {}).autoCategoryOnCreate !== false) {
      let cat = store.findCategoryByName(input.autoCategoryName);
      if (!cat) {
        try {
          cat = store.addCategory({ name: input.autoCategoryName, color: input.autoCategoryColor });
        } catch {
          cat = store.findCategoryByName(input.autoCategoryName);
        }
      }
      if (cat) input.categoryId = cat.id;
    }
    const book = store.addBook(input);
    let saved = book;
    if (book.coverRemote && !book.cover) {
      const local = await store.localizeCover(book.coverRemote, book.id);
      if (local) saved = store.updateBook(book.id, { cover: local });
    }
    // 官方封面拿不到时，用用户拍的封面照片兜底
    if (!saved.cover && body.coverLocal) {
      const photo = store.promoteUpload(String(body.coverLocal), book.id);
      if (photo) saved = store.updateBook(book.id, { cover: photo });
    }
    return sendJson(res, 201, { book: saved });
  }

  const bookMatch = p.match(/^\/api\/books\/([^/]+)$/);
  if (bookMatch && bookMatch[1] !== 'bulk-delete') {
    const id = decodeId(bookMatch[1]);
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readBody(req);
      try {
        const book = store.updateBook(id, body);
        return sendJson(res, 200, { book });
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
    }
    if (req.method === 'DELETE') {
      const existing = store.getBook(id);
      if (!existing) return sendJson(res, 404, { error: '书籍不存在' });
      store.deleteBook(id);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const book = store.getBook(id);
      return book ? sendJson(res, 200, { book }) : sendJson(res, 404, { error: '书籍不存在' });
    }
  }

  const relatedMatch = p.match(/^\/api\/books\/([^/]+)\/related$/);
  if (relatedMatch && req.method === 'GET') {
    const book = store.getBook(decodeId(relatedMatch[1]));
    if (!book) return sendJson(res, 404, { error: '书籍不存在' });
    const force = q.get('force') === '1';
    const cacheKey = `rel:v2:${book.isbn13 || book.id}`;
    const cached = store.cache.get(cacheKey);
    let raw = null;
    if (!force && cached && Date.now() - cached.ts < 3 * 24 * 3600 * 1000) {
      raw = { candidates: cached.candidates, queries: cached.queries };
    } else {
      try {
        // 用手动分类（若有）而不是自动分类名去推"同主题"，否则用户改过分类就不生效
        const cats = store.listCategories();
        const manual = book.categoryId ? cats.find((c) => c.id === book.categoryId) : null;
        const categoryName = (manual && manual.name) || book.autoCategoryName || '';
        raw = await providers.related({ ...book, autoCategoryName: categoryName }, 14);
        store.cache.set(cacheKey, { ts: Date.now(), candidates: raw.candidates, queries: raw.queries });
      } catch (err) {
        return sendJson(res, 200, { candidates: [], queries: [], error: err.message || '查找失败' });
      }
    }
    // 「已在书架 / 就是自己」每次都重新过滤：缓存可能是加入这本书之前生成的
    const norm = (s) =>
      String(s || '')
        .toLowerCase()
        .replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
    const selfId = (String(book.sourceUrl || '').match(/subject\/(\d+)/) || [])[1] || '';
    const ownedTitles = new Set(store.listBooks().map((b) => norm(b.title)));
    const filtered = (raw.candidates || [])
      .filter((c) => {
        if (c.source === 'douban' && selfId && String(c.id) === selfId) return false;
        if (ownedTitles.has(norm(c.title))) return false;
        return true;
      })
      .slice(0, 12);
    return sendJson(res, 200, {
      candidates: filtered,
      queries: raw.queries || [],
      cached: !!cached && !force,
    });
  }

  const refetchMatch = p.match(/^\/api\/books\/([^/]+)\/refetch$/);
  if (refetchMatch && req.method === 'POST') {
    const existing = store.getBook(decodeId(refetchMatch[1]));
    if (!existing) return sendJson(res, 404, { error: '书籍不存在' });
    try {
      const result = await providers.lookup(
        { isbn: existing.isbn13 || existing.isbn10, title: existing.title, force: true },
        { cache: store.cache }
      );
      const r = result.record;
      const patch = {
        title: r.title || existing.title,
        subtitle: r.subtitle || existing.subtitle,
        originalTitle: r.originalTitle || existing.originalTitle,
        authors: r.authors.length ? r.authors : existing.authors,
        translators: r.translators.length ? r.translators : existing.translators,
        publisher: r.publisher || existing.publisher,
        producer: r.producer || existing.producer,
        pubdate: r.pubdate || existing.pubdate,
        pages: r.pages || existing.pages,
        price: r.price || existing.price,
        binding: r.binding || existing.binding,
        series: r.series || existing.series,
        isbn13: r.isbn13 || existing.isbn13,
        isbn10: r.isbn10 || existing.isbn10,
        coverRemote: r.cover || existing.coverRemote,
        summary: r.summary || existing.summary,
        authorIntro: r.authorIntro || existing.authorIntro,
        rating: r.rating || existing.rating,
        ratingCount: r.ratingCount || existing.ratingCount,
        ratingLabel: r.ratingLabel || existing.ratingLabel,
        ratingScale: r.ratingScale || existing.ratingScale,
        subjects: r.subjects.length ? r.subjects : existing.subjects,
        source: r.sourcePrimary || existing.source,
        sourceUrl: r.sourceUrl || existing.sourceUrl,
        autoCategoryName: r.autoCategory ? r.autoCategory.name : existing.autoCategoryName,
        autoCategoryColor: r.autoCategory ? r.autoCategory.color : existing.autoCategoryColor,
      };
      let updated = store.updateBook(existing.id, patch);
      if (patch.coverRemote && !r.cover.startsWith('/covers/')) {
        const local = await store.localizeCover(patch.coverRemote, existing.id);
        if (local) updated = store.updateBook(existing.id, { cover: local });
      }
      return sendJson(res, 200, { book: updated, sources: result.sources });
    } catch (err) {
      return sendJson(res, 502, { error: err.message || '刷新失败' });
    }
  }

  const photoCoverMatch = p.match(/^\/api\/books\/([^/]+)\/photo-cover$/);
  if (photoCoverMatch && req.method === 'POST') {
    const body = await readBody(req);
    const existing = store.getBook(decodeId(photoCoverMatch[1]));
    if (!existing) return sendJson(res, 404, { error: '书籍不存在' });
    const local = store.promoteUpload(String(body.token || ''), existing.id);
    if (!local) return sendJson(res, 400, { error: '照片已过期，请重新拍照' });
    return sendJson(res, 200, { book: store.updateBook(existing.id, { cover: local }) });
  }

  if (p === '/api/books/bulk-delete' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, store.bulkDeleteBooks(body.ids || []));
  }

  /* ---------------- 书单 ---------------- */

  if (p === '/api/booklists') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        booklists: store.listBooklists().map((l) => store.booklistView(l, { bookIds: true })),
        sorts: store.BOOKLIST_SORTS,
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const list = store.addBooklist(body);
        if (Array.isArray(body.bookIds) && body.bookIds.length) store.addBooksToBooklist(list.id, body.bookIds);
        return sendJson(res, 201, { booklist: store.booklistView(store.getBooklist(list.id), { bookIds: true }) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
  }

  const listMatch = p.match(/^\/api\/booklists\/([^/]+)$/);
  if (listMatch) {
    const id = decodeId(listMatch[1]);
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        store.updateBooklist(id, body);
        return sendJson(res, 200, { booklist: store.booklistView(store.getBooklist(id), { bookIds: true }) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, store.deleteBooklist(id));
    }
    if (req.method === 'GET') {
      const list = store.getBooklist(id);
      return list
        ? sendJson(res, 200, { booklist: store.booklistView(list, { bookIds: true }) })
        : sendJson(res, 404, { error: '书单不存在' });
    }
  }

  const listBooksMatch = p.match(/^\/api\/booklists\/([^/]+)\/books(?:\/(remove))?$/);
  if (listBooksMatch && req.method === 'POST') {
    const id = decodeId(listBooksMatch[1]);
    const isRemove = !!listBooksMatch[2];
    const body = await readBody(req);
    const ids = Array.isArray(body.bookIds) ? body.bookIds : body.bookId ? [body.bookId] : [];
    try {
      const result = isRemove ? store.removeBooksFromBooklist(id, ids) : store.addBooksToBooklist(id, ids);
      return sendJson(res, 200, { ...result, booklist: store.booklistView(store.getBooklist(id), { bookIds: true }) });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }

  if (p === '/api/categories') {
    if (req.method === 'GET') return sendJson(res, 200, { categories: store.listCategories() });
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        return sendJson(res, 201, { category: store.addCategory(body) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
  }
  const catMatch = p.match(/^\/api\/categories\/([^/]+)$/);
  if (catMatch) {
    const catId = decodeId(catMatch[1]);
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, { category: store.updateCategory(catId, body) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, store.deleteCategory(catId, q.get('reassignTo') || ''));
    }
  }

  if (p === '/api/tags') {
    if (req.method === 'GET') return sendJson(res, 200, { tags: store.listTags() });
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        return sendJson(res, 201, { tag: store.addTag(body) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
  }
  const tagMatch = p.match(/^\/api\/tags\/([^/]+)$/);
  if (tagMatch) {
    const tagId = decodeId(tagMatch[1]);
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, { tag: store.updateTag(tagId, body) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (req.method === 'DELETE') return sendJson(res, 200, store.deleteTag(tagId));
  }

  if (p === '/api/stats' && req.method === 'GET') {
    return sendJson(res, 200, { ...store.stats(), movie: store.movieStats() });
  }

  /* ---------------- 电影 ---------------- */

  if (p === '/api/movie-providers/check' && (req.method === 'POST' || req.method === 'GET')) {
    applyDoubanCookie();
    try {
      return sendJson(res, 200, { sources: await movie.checkSources({ tmdbKey: tmdbKey() }) });
    } catch (err) {
      return sendJson(res, 200, { sources: [], error: err.message });
    }
  }

  if (p === '/api/movie-search' && req.method === 'GET') {
    applyDoubanCookie();
    const keyword = String(q.get('q') || '').trim();
    if (!keyword) return sendJson(res, 200, { results: [], sources: [] });
    const key = `msearch:v1:${keyword.toLowerCase()}`;
    const force = q.get('force') === '1';
    const cached = store.cache.get(key);
    if (!force && cached && Date.now() - cached.ts < 7 * 24 * 3600 * 1000) {
      return sendJson(res, 200, { ...cached.data, cached: true });
    }
    try {
      const data = await movie.search(keyword, { tmdbKey: tmdbKey() });
      store.cache.set(key, { ts: Date.now(), data });
      return sendJson(res, 200, { ...data, cached: false });
    } catch (err) {
      return sendJson(res, 200, { results: [], sources: [], error: err.message || '搜索失败' });
    }
  }

  if (p === '/api/movie-lookup' && (req.method === 'POST' || req.method === 'GET')) {
    applyDoubanCookie();
    const body = req.method === 'POST' ? await readBody(req) : {};
    const source = String(body.source || q.get('source') || '').trim();
    const sourceId = String(body.sourceId || q.get('sourceId') || '').trim();
    const title = String(body.title || q.get('title') || '').trim();
    const year = String(body.year || q.get('year') || '').trim();
    const force = body.force === true || q.get('force') === '1';
    if (!sourceId && !title) return sendJson(res, 400, { error: '请提供片名或条目 id' });
    const cacheKey = `mlookup:v1:${source}:${sourceId || title.toLowerCase()}`;
    const cached = store.cache.get(cacheKey);
    if (!force && cached && Date.now() - cached.ts < 14 * 24 * 3600 * 1000) {
      const dup = cached.record.sourceId ? store.findMovieBySource(cached.record.source || 'douban', cached.record.sourceId) : null;
      return sendJson(res, 200, { ...cached, cached: true, duplicate: dup || null });
    }
    try {
      const result = await movie.lookup({
        source,
        sourceId,
        title,
        year,
        tmdbKey: tmdbKey(),
        omdbKey: omdbKey(),
      });
      store.cache.set(cacheKey, { ts: Date.now(), record: result.record, sources: result.sources });
      const dup = result.record.sourceId ? store.findMovieBySource(result.record.source, result.record.sourceId) : null;
      return sendJson(res, 200, { ...result, cached: false, duplicate: dup || null });
    } catch (err) {
      return sendJson(res, 502, { error: err.message || '抓取失败' });
    }
  }

  if (p === '/api/movies' && req.method === 'POST') {
    const body = await readBody(req);
    const input = { ...body };
    if (input.sourceId && input.source && !body.allowDuplicate) {
      const dup = store.findMovieBySource(input.source, input.sourceId);
      if (dup) return sendJson(res, 409, { error: '这部影片已经在片库里了', movie: dup });
    }
    const saved = store.addMovie(input);
    if (saved.posterRemote && !saved.poster) {
      const local = await store.localizeCover(saved.posterRemote, saved.id);
      if (local) return sendJson(res, 201, { movie: store.updateMovie(saved.id, { poster: local }) });
    }
    return sendJson(res, 201, { movie: saved });
  }

  const movieMatch = p.match(/^\/api\/movies\/([^/]+)$/);
  if (movieMatch) {
    const id = decodeId(movieMatch[1]);
    if (req.method === 'GET') {
      const m = store.getMovie(id);
      return m ? sendJson(res, 200, { movie: m }) : sendJson(res, 404, { error: '影片不存在' });
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readBody(req);
      try {
        let updated = store.updateMovie(id, body);
        if (updated.posterRemote && !updated.poster) {
          const local = await store.localizeCover(updated.posterRemote, updated.id);
          if (local) updated = store.updateMovie(updated.id, { poster: local });
        }
        return sendJson(res, 200, { movie: updated });
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
    }
    if (req.method === 'DELETE') {
      if (!store.getMovie(id)) return sendJson(res, 404, { error: '影片不存在' });
      store.deleteMovie(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  /** 豆瓣个人收藏同步（读书 / 影视） */
  if (p === '/api/douban/sync' && req.method === 'POST') {
    const body = await readBody(req);
    const cookie = doubanCookie();
    if (!cookie) return sendJson(res, 400, { error: '请先在「设置 → 影片数据源」填写豆瓣 Cookie' });
    const uid = doubanUser.parseUserId(cookie);
    if (!uid) return sendJson(res, 400, { error: 'Cookie 里没找到 dbcl2，请把浏览器里的整条 Cookie 复制过来' });
    const kind = body.kind === 'book' ? 'book' : 'movie';
    const norm0 = (s2) => String(s2 || '').toLowerCase().replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
    // 已入库的判断给到抓取层：长的收藏列表可以边翻页边跳过，多次同步能逐步推进
    const known = (item) =>
      kind === 'book'
        ? !!(store.findBookByIsbn('') && false) ||
          store.listBooks().some(
            (b) => (b.source === 'douban' && String(b.sourceId) === item.doubanId) || norm0(b.title) === norm0(item.title)
          )
        : store.listMovies().some(
            (m) =>
              (m.source === 'douban' && String(m.sourceId) === item.doubanId) ||
              (norm0(m.title) === norm0(item.title) && String(m.year || '') === String(item.year || ''))
          );
    let data;
    try {
      data = await doubanUser.fetchAll({ cookie, uid, kind, known });
    } catch (err) {
      return sendJson(res, 502, { error: err.message || '豆瓣接口请求失败' });
    }
    if (!data.items.length) {
      return sendJson(res, 200, {
        ok: true,
        kind,
        uid,
        summary: data.summary,
        scanned: data.scanned,
        skippedKnown: data.skippedKnown,
        added: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        message: '没有读到任何记录：Cookie 可能已过期，或该账号在这类目下没有收藏',
      });
    }
    const norm = (s2) => String(s2 || '').toLowerCase().replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of data.items) {
      try {
        if (kind === 'book') {
          const existing =
            store.listBooks().find((b) => b.source === 'douban' && String(b.sourceId) === item.doubanId) ||
            store.listBooks().find((b) => norm(b.title) === norm(item.title));
          if (existing) {
            if (body.updateExisting && item.status && existing.status !== item.status) {
              store.updateBook(existing.id, { status: item.status });
              updated += 1;
            } else skipped += 1;
            continue;
          }
          store.addBook({
            title: item.title,
            authors: item.authors || [],
            publisher: item.publisher || '',
            pubdate: item.pubdate || '',
            price: item.price || '',
            coverRemote: item.coverRemote || '',
            rating: item.rating || 0,
            ratingCount: item.ratingCount || 0,
            myRating: item.myRating || 0,
            note: item.note || '',
            status: item.status,
            source: 'douban',
            sourceId: item.doubanId,
            sourceUrl: `https://book.douban.com/subject/${item.doubanId}/`,
          });
          added += 1;
        } else {
          const existing =
            store.findMovieBySource('douban', item.doubanId) ||
            store.listMovies().find((m) => norm(m.title) === norm(item.title) && String(m.year || '') === String(item.year || ''));
          if (existing) {
            if (body.updateExisting && item.status && existing.status !== item.status) {
              store.updateMovie(existing.id, { status: item.status });
              updated += 1;
            } else skipped += 1;
            continue;
          }
          store.addMovie({
            title: item.title,
            year: item.year || '',
            type: item.type || 'movie',
            genres: item.genres || [],
            posterRemote: item.posterRemote || '',
            rating: item.rating || 0,
            ratingCount: item.ratingCount || 0,
            myRating: item.myRating || 0,
            note: item.note || '',
            status: item.status,
            source: 'douban',
            sourceId: item.doubanId,
            sourceUrl: `https://movie.douban.com/subject/${item.doubanId}/`,
          });
          added += 1;
        }
      } catch (err) {
        failed += 1;
      }
    }
    return sendJson(res, 200, {
      ok: true,
      kind,
      uid,
      summary: data.summary,
      total: data.total,
      scanned: data.scanned,
      skippedKnown: data.skippedKnown,
      fetched: data.items.length,
      capped: data.items.length >= data.max,
      added,
      updated,
      skipped,
      failed,
    });
  }

  /** 只刷新剧集的"季"信息（单次 TMDb 请求，不动标题/评分等其它字段） */
  if (p.match(/^\/api\/movies\/([^/]+)\/refresh-seasons$/) && req.method === 'POST') {
    const id = decodeId(p.match(/^\/api\/movies\/([^/]+)\/refresh-seasons$/)[1]);
    const m = store.getMovie(id);
    if (!m) return sendJson(res, 404, { error: '影片不存在' });
    if (m.type !== 'tv') return sendJson(res, 200, { movie: m, skipped: true });
    const key = tmdbKey();
    if (!key) return sendJson(res, 200, { movie: m, error: '需要 TMDb API Key（设置页填写）' });
    try {
      const rec = m.tmdbId
        ? await movie.tmdbDetail(`tv/${m.tmdbId}`, key)
        : await movie.tmdbFindByTitle(m.title, m.year, 'tv', key);
      if (!rec || !(rec.seasons || []).length) {
        return sendJson(res, 200, { movie: m, error: '没在 TMDb 找到这部剧集的季信息' });
      }
      const before = (m.seasons || []).length;
      const updated = store.updateMovie(id, {
        seasons: rec.seasons,
        seasonsCount: rec.seasonsCount,
        episodesCount: rec.episodesCount,
        tmdbId: rec.tmdbId || m.tmdbId,
        seasonsRefreshedAt: nowIso(),
      });
      return sendJson(res, 200, {
        movie: updated,
        seasonsBefore: before,
        seasonsAfter: (rec.seasons || []).length,
        added: Math.max(0, (rec.seasons || []).length - before),
      });
    } catch (err) {
      return sendJson(res, 200, { movie: m, error: err.message || '刷新失败' });
    }
  }

  /** 某个导演/编剧/演员的全部作品 */
  if (p === '/api/person-works' && req.method === 'GET') {
    const key = tmdbKey();
    if (!key) return sendJson(res, 200, { works: [], error: '需要 TMDb API Key（设置页填写）' });
    const name = String(q.get('name') || '').trim();
    const tmdbId = String(q.get('tmdbId') || '').trim();
    const role = String(q.get('role') || '').trim();
    if (!name && !tmdbId) return sendJson(res, 400, { error: '缺少人物信息' });
    const cacheKey = `person:v1:${tmdbId || name}:${role}`;
    const cached = store.cache.get(cacheKey);
    let data;
    if (cached && Date.now() - cached.ts < 3 * 24 * 3600 * 1000 && q.get('force') !== '1') {
      data = cached.data;
    } else {
      try {
        data = await movie.personWorks({ tmdbId, name, role }, key);
        store.cache.set(cacheKey, { ts: Date.now(), data });
      } catch (err) {
        return sendJson(res, 200, { works: [], error: err.message || '抓取失败' });
      }
    }
    const ownedIds = new Set(store.listMovies().map((x) => String(x.tmdbId || '')).filter(Boolean));
    const ownedTitles = new Set(store.listMovies().map((x) => String(x.title || '').trim()));
    const works = (data.works || []).map((w) => ({
      ...w,
      owned: ownedIds.has(String(w.tmdbId)) || ownedTitles.has(String(w.title || '').trim()),
    }));
    return sendJson(res, 200, { person: data.person, counts: data.counts, works, cached: !!cached });
  }

  const movieCollectionMatch = p.match(/^\/api\/movies\/([^/]+)\/collection$/);
  if (movieCollectionMatch && req.method === 'GET') {
    applyDoubanCookie();
    const m = store.getMovie(decodeId(movieCollectionMatch[1]));
    if (!m) return sendJson(res, 404, { error: '影片不存在' });
    const cid = (m.collection && m.collection.id) || q.get('id') || '';
    const key = tmdbKey();
    if (!cid) return sendJson(res, 200, { collection: null, parts: [], error: '这部影片不属于任何合集' });
    if (!key) return sendJson(res, 200, { collection: m.collection, parts: [], error: '合集需要 TMDb API Key（设置页填写）' });
    const cacheKey = `mcoll:v1:${cid}`;
    const cached = store.cache.get(cacheKey);
    let data;
    if (cached && Date.now() - cached.ts < 7 * 24 * 3600 * 1000 && q.get('force') !== '1') {
      data = cached.data;
    } else {
      try {
        data = await movie.tmdbCollection(cid, key);
        store.cache.set(cacheKey, { ts: Date.now(), data });
      } catch (err) {
        return sendJson(res, 200, { collection: m.collection, parts: [], error: err.message || '合集抓取失败' });
      }
    }
    // 标注哪些已经在片库里
    const owned = new Set(store.listMovies().map((x) => String(x.tmdbId || '')).filter(Boolean));
    const parts = (data.parts || []).map((x) => ({ ...x, owned: owned.has(String(x.tmdbId)) }));
    return sendJson(res, 200, { collection: { id: data.id, name: data.name, poster: data.poster, overview: data.overview }, parts });
  }

  /** 一次性把合集里还没入库的影片全部加入片库 */
  if (p === '/api/movie-collection/import' && req.method === 'POST') {
    applyDoubanCookie();
    const body = await readBody(req);
    const key = tmdbKey();
    if (!key) return sendJson(res, 400, { error: '合集导入需要 TMDb API Key（设置页填写）' });
    const movieId = String(body.movieId || '');
    let collectionId = String(body.collectionId || '');
    if (!collectionId && movieId) {
      const m = store.getMovie(movieId);
      collectionId = (m && m.collection && m.collection.id) || '';
    }
    if (!collectionId) return sendJson(res, 400, { error: '没有指定合集' });

    // 取合集（优先用缓存）
    const cacheKey = `mcoll:v1:${collectionId}`;
    const cached = store.cache.get(cacheKey);
    let data = cached && cached.data;
    if (!data || cached.ts < Date.now() - 7 * 24 * 3600 * 1000) {
      try {
        data = await movie.tmdbCollection(collectionId, key);
        store.cache.set(cacheKey, { ts: Date.now(), data });
      } catch (err) {
        return sendJson(res, 502, { error: err.message || '合集抓取失败' });
      }
    }
    const status = store.MOVIE_STATUSES[body.status] ? body.status : 'wish';
    const owned = new Set(store.listMovies().map((x) => String(x.tmdbId || '')).filter(Boolean));
    const todo = (data.parts || []).filter((x) => x.tmdbId && !owned.has(String(x.tmdbId)));
    const added = [];
    const failed = [];
    const queue = todo.slice();
    const worker = async () => {
      while (queue.length) {
        const part = queue.shift();
        try {
          const rec = await movie.tmdbDetail(part.sourceId, key);
          let saved = store.addMovie({ ...rec, status });
          if (saved.posterRemote && !saved.poster) {
            const local = await store.localizeCover(saved.posterRemote, saved.id);
            if (local) saved = store.updateMovie(saved.id, { poster: local });
          }
          added.push({ id: saved.id, title: saved.title, year: saved.year });
        } catch (err) {
          failed.push({ title: part.title, error: err.message || '抓取失败' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    return sendJson(res, 200, {
      ok: true,
      collection: { id: data.id, name: data.name },
      total: (data.parts || []).length,
      already: (data.parts || []).length - todo.length,
      addedCount: added.length,
      failedCount: failed.length,
      added,
      failed,
    });
  }

  const movieRelatedMatch = p.match(/^\/api\/movies\/([^/]+)\/related$/);
  if (movieRelatedMatch && req.method === 'GET') {
    applyDoubanCookie();
    const m = store.getMovie(decodeId(movieRelatedMatch[1]));
    if (!m) return sendJson(res, 404, { error: '影片不存在' });
    const force = q.get('force') === '1';
    const cacheKey = `mrel:v1:${m.source}:${m.sourceId || m.id}`;
    const cached = store.cache.get(cacheKey);
    let raw = null;
    if (!force && cached && Date.now() - cached.ts < 3 * 24 * 3600 * 1000) {
      raw = cached.data;
    } else {
      try {
        // 合并三方推荐：豆瓣「看过这部的人也喜欢」+ TMDb 推荐 + TMDb 相似
        const merged = await movie.related(m, { tmdbKey: tmdbKey() });
        let list = merged.candidates || [];
        if (!list.length && m.title) {
          const s = await movie.search(m.title, { tmdbKey: tmdbKey() });
          list = (s.results || []).map((r) => ({ ...r, reason: '相关影片', sources: [r.sourceLabel], agree: 1 }));
        }
        raw = { candidates: list, queries: [m.title], groups: merged.groups || [] };
        store.cache.set(cacheKey, { ts: Date.now(), data: raw });
      } catch (err) {
        return sendJson(res, 200, { candidates: [], queries: [], error: err.message });
      }
    }
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
    const ownedTitles = new Set(store.listMovies().map((x) => norm(x.title)));
    const ownedIds = new Set(store.listMovies().map((x) => `${x.source}:${x.sourceId}`));
    const candidates = (raw.candidates || [])
      .filter((c) => {
        if (c.sourceId && ownedIds.has(`${c.source}:${c.sourceId}`)) return false;
        if (ownedTitles.has(norm(c.title))) return false;
        return true;
      })
      .slice(0, 12);
    return sendJson(res, 200, { candidates, queries: raw.queries || [], groups: raw.groups || [], cached: !!cached && !force });
  }

  /* 片单 */
  if (p === '/api/movie-lists') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        movieLists: store.listMovieLists().map((l) => store.movieListView(l, { movieIds: true })),
        sorts: store.MOVIE_LIST_SORTS,
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const list = store.addMovieList(body);
        if (Array.isArray(body.movieIds) && body.movieIds.length) store.addMoviesToMovieList(list.id, body.movieIds);
        return sendJson(res, 201, { movieList: store.movieListView(store.getMovieList(list.id), { movieIds: true }) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
  }

  const movieListMatch = p.match(/^\/api\/movie-lists\/([^/]+)$/);
  if (movieListMatch) {
    const id = decodeId(movieListMatch[1]);
    if (req.method === 'GET') {
      const l = store.getMovieList(id);
      return l
        ? sendJson(res, 200, { movieList: store.movieListView(l, { movieIds: true }) })
        : sendJson(res, 404, { error: '片单不存在' });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        store.updateMovieList(id, body);
        return sendJson(res, 200, { movieList: store.movieListView(store.getMovieList(id), { movieIds: true }) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (req.method === 'DELETE') return sendJson(res, 200, store.deleteMovieList(id));
  }

  const movieListItemsMatch = p.match(/^\/api\/movie-lists\/([^/]+)\/movies(?:\/(remove))?$/);
  if (movieListItemsMatch && req.method === 'POST') {
    const id = decodeId(movieListItemsMatch[1]);
    const isRemove = !!movieListItemsMatch[2];
    const body = await readBody(req);
    const ids = Array.isArray(body.movieIds) ? body.movieIds : body.movieId ? [body.movieId] : [];
    try {
      const result = isRemove ? store.removeMoviesFromMovieList(id, ids) : store.addMoviesToMovieList(id, ids);
      return sendJson(res, 200, { ...result, movieList: store.movieListView(store.getMovieList(id), { movieIds: true }) });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }


  if (p === '/api/export' && req.method === 'GET') {
    const format = (q.get('format') || 'json').toLowerCase();
    const db = store.getDb();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (format === 'csv') {
      const catName = (id) => (store.listCategories().find((c) => c.id === id) || {}).name || '';
      const tagNames = (ids) =>
        (ids || []).map((id) => (store.listTags().find((t) => t.id === id) || {}).name || '').filter(Boolean);
      const columns = [
        { key: 'title', label: '书名' },
        { key: 'subtitle', label: '副标题' },
        { key: 'authors', label: '作者' },
        { key: 'translators', label: '译者' },
        { key: 'publisher', label: '出版社' },
        { key: 'pubdate', label: '出版时间' },
        { key: 'isbn13', label: 'ISBN' },
        { key: 'pages', label: '页数' },
        { key: 'price', label: '定价' },
        { key: 'statusLabel', label: '状态' },
        { key: 'category', label: '分类' },
        { key: 'tags', label: '标签' },
        { key: 'myRating', label: '我的评分' },
        { key: 'rating', label: '公开评分' },
        { key: 'ratingLabel', label: '评分来源' },
        { key: 'progress', label: '进度%' },
        { key: 'location', label: '存放位置' },
        { key: 'note', label: '备注' },
        { key: 'summary', label: '内容简介' },
        { key: 'source', label: '信息来源' },
        { key: 'addedAt', label: '添加时间' },
      ];
      const rows = db.books.map((b) => ({
        ...b,
        statusLabel: (store.STATUSES[b.status] || {}).label || b.status,
        category: b.categoryId ? catName(b.categoryId) : b.autoCategoryName || '',
        tags: tagNames(b.tagIds),
      }));
      return send(res, 200, toCsv(rows, columns), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="booknest-${stamp}.csv"`,
      });
    }
    return send(res, 200, JSON.stringify({ version: db.version, exportedAt: nowIso(), ...db }, null, 2), {
      'Content-Type': MIME['.json'],
      'Content-Disposition': `attachment; filename="booknest-${stamp}.json"`,
    });
  }

  if (p === '/api/import' && req.method === 'POST') {
    const body = await readBody(req);
    const db = store.getDb();
    let added = 0;
    let skipped = 0;
    let listsAdded = 0;
    let moviesAdded = 0;
    let moviesSkipped = 0;
    let movieListsAdded = 0;
    const idMap = new Map();
    const movieIdMap = new Map();
    const pendingCovers = []; // 需要按远端地址重新下载的封面/海报
    // 回执：这份备份文件里到底带了什么（便于判断"没导入"是文件里没有还是代码没处理）
    const received = {
      books: (body.books || []).length,
      movies: (body.movies || []).length,
      booklists: (body.booklists || []).length,
      movieLists: (body.movieLists || []).length,
      categories: (body.categories || []).length,
      tags: (body.tags || []).length,
      hasMoviesKey: Object.prototype.hasOwnProperty.call(body, 'movies'),
    };

    // ---- 1) 分类 / 标签：先按名称对齐到本地（跨实例 id 不同也能对上），并建 旧id→本地id 映射 ----
    const catByName = new Map(store.listCategories().map((c) => [c.name, c]));
    const tagByName = new Map(store.listTags().map((t) => [t.name, t]));
    const catIdMap = new Map();
    const tagIdMap = new Map();
    for (const c of body.categories || []) {
      if (!c || !c.name) continue;
      let local = catByName.get(c.name);
      if (!local) {
        try {
          local = store.addCategory({ name: c.name, color: c.color || '#64748b' });
        } catch (err) {
          local = store.findCategoryByName(c.name);
        }
        if (local) catByName.set(local.name, local);
      }
      if (local) {
        if (c.id) catIdMap.set(String(c.id), local.id);
        catIdMap.set(local.name, local.id);
      }
    }
    for (const t of body.tags || []) {
      if (!t || !t.name) continue;
      let local = tagByName.get(t.name);
      if (!local) {
        try {
          local = store.addTag({ name: t.name, color: t.color });
        } catch (err) {
          local = store.findTagByName(t.name);
        }
        if (local) tagByName.set(local.name, local);
      }
      if (local) {
        if (t.id) tagIdMap.set(String(t.id), local.id);
        tagIdMap.set(local.name, local.id);
      }
    }
    const mapTags = (ids) => (ids || []).map((id) => tagIdMap.get(String(id)) || (store.listTags().some((t) => t.id === id) ? id : '')).filter(Boolean);

    // ---- 2) 书籍：ISBN 已存在则跳过，否则新增并本地化封面 ----
    for (const raw of body.books || []) {
      const norm = isbnUtil.normalize(raw.isbn13 || raw.isbn10 || '');
      if (norm.ok && store.findBookByIsbn(norm.isbn13)) {
        skipped += 1;
        continue;
      }
      const input = { ...raw };
      delete input.id;
      if (norm.ok) {
        input.isbn13 = norm.isbn13;
        input.isbn10 = norm.isbn10;
      }
      input.categoryId =
        catIdMap.get(String(raw.categoryId || '')) ||
        (catByName.get(raw.categoryName) || {}).id ||
        (store.listCategories().some((c) => c.id === raw.categoryId) ? raw.categoryId : '');
      input.tagIds = mapTags(raw.tagIds);
      const book = store.addBook(input);
      if (raw.id) idMap.set(String(raw.id), book.id);
      // 导出只带封面路径不带图片：本机没有这个文件时按 coverRemote 重新下载
      if (book.coverRemote && !store.coverFileExists(book.cover)) {
        pendingCovers.push({ kind: 'book', id: book.id, remote: book.coverRemote });
      }
      added += 1;
    }

    // ---- 3) 书单：同名合并，成员 id 映射 ----
    for (const raw of body.booklists || []) {
      if (!raw || !raw.name) continue;
      let list = store.findBooklistByName(raw.name);
      if (!list) {
        try {
          list = store.addBooklist({ name: raw.name, description: raw.description, color: raw.color, sort: raw.sort });
          listsAdded += 1;
        } catch (err) {
          list = store.findBooklistByName(raw.name);
        }
      }
      if (!list) continue;
      const members = (raw.items || raw.bookIds || [])
        .map((it) => {
          const oldId = typeof it === 'string' ? it : it && it.bookId;
          return idMap.get(String(oldId)) || '';
        })
        .filter(Boolean);
      if (members.length) store.addBooksToBooklist(list.id, members);
    }

    // ---- 4) 影片：同一条目（同源 id，或同名同年）已存在则跳过 ----
    const normTitle = (s) => String(s || '').toLowerCase().replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
    for (const raw of body.movies || []) {
      if (!raw || !raw.title) continue;
      const srcId = String(raw.sourceId || '');
      const dup =
        (raw.source && srcId && store.findMovieBySource(raw.source, srcId)) ||
        store.listMovies().find(
          (m) =>
            normTitle(m.title) === normTitle(raw.title) &&
            String(m.year || '') === String(raw.year || '') &&
            (m.imdbId || '') === (raw.imdbId || '')
        );
      if (dup) {
        moviesSkipped += 1;
        if (raw.id) movieIdMap.set(String(raw.id), dup.id);
        continue;
      }
      const input = { ...raw };
      delete input.id;
      input.tags = mapTags(raw.tags);
      const movie = store.addMovie(input);
      if (raw.id) movieIdMap.set(String(raw.id), movie.id);
      if (movie.posterRemote && !store.coverFileExists(movie.poster)) {
        pendingCovers.push({ kind: 'movie', id: movie.id, remote: movie.posterRemote });
      }
      moviesAdded += 1;
    }

    // ---- 5) 片单：同名合并，成员 id 映射 ----
    for (const raw of body.movieLists || []) {
      if (!raw || !raw.name) continue;
      let list = store.findMovieListByName(raw.name);
      if (!list) {
        try {
          list = store.addMovieList({ name: raw.name, description: raw.description, color: raw.color, sort: raw.sort });
          movieListsAdded += 1;
        } catch (err) {
          list = store.findMovieListByName(raw.name);
        }
      }
      if (!list) continue;
      const members = (raw.items || raw.movieIds || [])
        .map((it) => {
          const oldId = typeof it === 'string' ? it : it && it.movieId;
          return movieIdMap.get(String(oldId)) || '';
        })
        .filter(Boolean);
      if (members.length) store.addMoviesToMovieList(list.id, members);
    }

    // ---- 6) 补齐封面/海报：并发 6，失败不影响导入结果 ----
    let coversLocalized = 0;
    let coversFailed = 0;
    if (pendingCovers.length) {
      const queue = pendingCovers.slice();
      const worker = async () => {
        while (queue.length) {
          const item = queue.shift();
          const local = await store.localizeCover(item.remote, item.id);
          if (local) {
            if (item.kind === 'book') store.updateBook(item.id, { cover: local });
            else store.updateMovie(item.id, { poster: local });
            coversLocalized += 1;
          } else {
            // 下载失败：清掉无效的本地路径，前端会退回用 coverRemote 经 /api/cover 代理显示
            if (item.kind === 'book') store.updateBook(item.id, { cover: '' });
            else store.updateMovie(item.id, { poster: '' });
            coversFailed += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    }

    return sendJson(res, 200, {
      ok: true,
      added,
      skipped,
      listsAdded,
      moviesAdded,
      moviesSkipped,
      movieListsAdded,
      coversLocalized,
      coversFailed,
      received,
      total: db.books.length,
      totalMovies: db.movies.length,
    });
  }

  if (p === '/api/settings' && req.method === 'PATCH') {
    const body = await readBody(req);
    const db = store.getDb();
    db.settings = { ...(db.settings || {}), ...body };
    store.save(true);
    let needsRestart = false;
    if (body.proxy !== undefined) {
      // 代理通过环境变量在启动时注入，改完需要重启进程
      needsRestart = JSON.stringify(proxyInfo().url) !== JSON.stringify((body.proxy || {}).url);
    }
    if (body.googleBooksApiKey !== undefined) {
      providers.checkHealth(true).catch(() => {});
    }
    return sendJson(res, 200, {
      settings: publicSettings(),
      needsRestart,
      proxy: proxyInfo(),
      providers: providers.healthSnapshot(),
    });
  }

  if (p === '/api/cache' && req.method === 'DELETE') {
    store.cache.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auto-categorize' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return sendJson(res, 200, store.autoCategorizeAll(!!body.overwrite));
  }

  if (p === '/api/wipe' && req.method === 'POST') {
    return sendJson(res, 200, store.wipe());
  }

  if (p === '/api/cover' && req.method === 'GET') {
    const src = q.get('src') || '';
    if (!src || !store.isAllowedImageUrl(src)) return send(res, 400, 'unsupported image url');
    try {
      const { file, ext } = await store.cachedImage(src);
      const buf = fs.readFileSync(file);
      return send(res, 200, buf, {
        'Content-Type': MIME[ext] || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    } catch (err) {
      return send(res, 404, 'image fetch failed');
    }
  }

  return sendJson(res, 404, { error: `未知接口 ${req.method} ${p}` });
}

/* ---------------- servers ---------------- */

function createRequestHandler() {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      // 云端部署建议开启访问密码（环境变量 BOOKNEST_PASSWORD）
      if (auth.enabled() && auth.handle(req, res, url)) return;
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error('[server]', err);
      return sendJson(res, 500, { error: err.message || '服务端错误' });
    }
  };
}

function httpsEnabled() {
  return fs.existsSync(path.join(CERT_DIR, 'server.key')) && fs.existsSync(path.join(CERT_DIR, 'server.crt'));
}

function logStartup() {
  const lines = [];
  lines.push('');
  lines.push('  📚  书巢 BookNest 已启动');
  lines.push('  ─────────────────────────────────────────');
  if (httpsEnabled()) {
    lines.push(`  手机访问（同一 Wi-Fi，推荐）: https://<本机IP>:${HTTPS_PORT}`);
  }
  lines.push(`  电脑访问: http://localhost:${HTTP_PORT}`);
  for (const ni of lanAddresses()) {
    lines.push(`    · ${ni.iface}: ${httpsEnabled() ? 'https' : 'http'}://${ni.address}:${httpsEnabled() ? HTTPS_PORT : HTTP_PORT}`);
  }
  const px = proxyInfo();
  if (px.active) lines.push(`  🌐 海外数据源代理: ${px.url}（豆瓣/微信读书仍直连）`);
  else lines.push('  🌐 海外数据源代理: 未启用（Google Books / Open Library 可能不可达）');
  if (googleApiKeyConfigured()) lines.push('  🔑 Google Books API Key: 已配置');
  const ocrStatus = ocr.engineAvailable();
  lines.push(
    ocrStatus.ok
      ? `  🔍 封面识别: ${ocrStatus.label}${ocrStatus.hint ? ` — ${ocrStatus.hint}` : ''}`
      : `  🔍 封面识别: 不可用（${ocrStatus.reason}）`
  );
  if (auth.enabled()) lines.push('  🔒 访问密码: 已开启（BOOKNEST_PASSWORD）');
  lines.push(`  运行环境: ${process.platform}/${process.arch} · Node ${process.versions.node}`);
  lines.push(`  代码版本: v${APP_VERSION}${APP_COMMIT ? ` (${APP_COMMIT})` : ''}`);
  lines.push(`  数据文件: ${store.DB_FILE}`);
  lines.push('  ─────────────────────────────────────────');
  lines.push('  手机首次打开 https 会提示"证书不受信任"，选择"继续访问"即可；');
  lines.push('  若浏览器仍拒绝摄像头，可在设置页改用「拍照识别条码」。');
  lines.push('');
  console.log(lines.join('\n'));
}

function googleApiKeyConfigured() {
  return !!((store.getDb().settings || {}).googleBooksApiKey || '').trim();
}

function start() {
  store.init();
  providers.setGoogleApiKeyProvider(() => (store.getDb().settings || {}).googleBooksApiKey || '');
  const prunedUploads = store.pruneUploads();
  if (prunedUploads) console.log(`[store] 清理了 ${prunedUploads} 个过期上传照片`);
  const handler = createRequestHandler();

  const httpServer = http.createServer(handler);
  httpServer.listen(HTTP_PORT, HOST, () => {
    logStartup();
  });
  httpServer.on('error', (err) => console.error(`[http] ${err.message}`));

  if (httpsEnabled()) {
    const options = {
      key: fs.readFileSync(path.join(CERT_DIR, 'server.key')),
      cert: fs.readFileSync(path.join(CERT_DIR, 'server.crt')),
    };
    const httpsServer = https.createServer(options, handler);
    httpsServer.listen(HTTPS_PORT, HOST, () => {});
    httpsServer.on('error', (err) => console.error(`[https] ${err.message}`));
  }

  // 后台探测海外数据源可用性，避免每次查书都等超时
  providers.checkHealth(false).catch(() => {});

  const shutdown = () => {
    try {
      store.save(true);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start();

module.exports = { start, createRequestHandler, httpsEnabled };
