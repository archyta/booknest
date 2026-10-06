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
const ocr = require('./ocr');
const auth = require('./auth');
const isbnUtil = require('./isbn');
const { toCsv, nowIso } = require('./util');

const ROOT = path.resolve(__dirname, '..');
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

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, time: nowIso(), pid: process.pid });
  }

  if (p === '/api/bootstrap' && req.method === 'GET') {
    const db = store.getDb();
    return sendJson(res, 200, {
      books: store.listBooks().map(bookView),
      categories: store.listCategories(),
      tags: store.listTags(),
      booklists: store.listBooklists().map((l) => store.booklistView(l, { bookIds: true })),
      booklistSorts: store.BOOKLIST_SORTS,
      stats: store.stats(),
      statuses: store.STATUSES,
      settings: db.settings || {},
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

  if (p === '/api/stats' && req.method === 'GET') return sendJson(res, 200, store.stats());

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
    const idMap = new Map();
    const catByName = new Map(store.listCategories().map((c) => [c.name, c]));
    const tagByName = new Map(store.listTags().map((t) => [t.name, t]));
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
      if (raw.categoryName && !input.categoryId) {
        let cat = catByName.get(raw.categoryName);
        if (!cat) {
          try {
            cat = store.addCategory({ name: raw.categoryName, color: raw.categoryColor || '#64748b' });
          } catch {
            cat = store.findCategoryByName(raw.categoryName);
          }
          if (cat) catByName.set(cat.name, cat);
        }
        if (cat) input.categoryId = cat.id;
      }
      input.tagIds = (raw.tagIds || [])
        .map((id) => (tagByName.get(id) || {}).id || id)
        .filter((id) => store.listTags().some((t) => t.id === id));
      const book = store.addBook(input);
      if (raw.id) idMap.set(String(raw.id), book.id);
      if (book.coverRemote && !book.cover) {
        const local = await store.localizeCover(book.coverRemote, book.id);
        if (local) store.updateBook(book.id, { cover: local });
      }
      added += 1;
    }
    // 书单：同名合并，成员按导入时的 id 映射到新 id
    for (const raw of body.booklists || []) {
      if (!raw || !raw.name) continue;
      let list = store.findBooklistByName(raw.name);
      if (!list) {
        try {
          list = store.addBooklist({ name: raw.name, description: raw.description, color: raw.color, sort: raw.sort });
          listsAdded += 1;
        } catch {
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
    for (const t of body.tags || []) {
      if (!t || !t.name) continue;
      if (tagByName.has(t.name)) continue;
      try {
        const tag = store.addTag({ name: t.name, color: t.color });
        tagByName.set(tag.name, tag);
      } catch {
        /* ignore */
      }
    }
    for (const c of body.categories || []) {
      if (!c || !c.name) continue;
      if (catByName.has(c.name)) continue;
      try {
        const cat = store.addCategory({ name: c.name, color: c.color });
        catByName.set(cat.name, cat);
      } catch {
        /* ignore */
      }
    }
    return sendJson(res, 200, { ok: true, added, skipped, listsAdded, total: db.books.length });
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
      settings: db.settings,
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
