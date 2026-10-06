'use strict';

/* 元数据聚合：多源降级 + 字段合并 + 结果缓存 + 数据源可用性探测 */

const douban = require('./douban');
const weread = require('./weread');
const google = require('./google');
const { suggestCategory } = require('../autocat');
const isbnUtil = require('../isbn');
const { unique, nowIso, similarity, sleep } = require('../util');

const PRIORITY = ['douban', 'weread', 'google', 'openlibrary'];
const COMPLETE_TTL = 30 * 24 * 3600 * 1000;
const PARTIAL_TTL = 6 * 3600 * 1000;
const SOFT_DEADLINE = 4000;

const health = {
  google: { ok: null, ms: 0, checkedAt: 0, error: '' },
  openlibrary: { ok: null, ms: 0, checkedAt: 0, error: '' },
};
let healthRun = null;

function healthSnapshot() {
  const label = { google: 'Google Books', openlibrary: 'Open Library' };
  return Object.entries(health).map(([key, h]) => ({
    key,
    label: label[key],
    ok: h.ok,
    ms: h.ms,
    error: h.error,
    checkedAt: h.checkedAt ? new Date(h.checkedAt).toISOString() : '',
    overseas: true,
    needsKey: key === 'google' && !google.hasApiKey(),
  }));
}

function fresh(h) {
  return h.ok !== null && Date.now() - h.checkedAt < 30 * 60 * 1000;
}

async function checkHealth(force = false) {
  if (healthRun) return healthRun;
  const need = force || !fresh(health.google) || !fresh(health.openlibrary);
  if (!need) return healthSnapshot();
  healthRun = (async () => {
    const [g, o] = await Promise.all([google.ping('google'), google.ping('openlibrary')]);
    health.google = { ...g, checkedAt: Date.now() };
    health.openlibrary = { ...o, checkedAt: Date.now() };
    healthRun = null;
    return healthSnapshot();
  })();
  try {
    return await healthRun;
  } finally {
    healthRun = null;
  }
}

function usable(key) {
  const h = health[key];
  if (h.ok === false && Date.now() - h.checkedAt < 30 * 60 * 1000) return false;
  return true;
}

function timeoutAfter(ms) {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

/** 判断已合并的记录是否"够用了"：够用就不必等慢源（海外源通常要几秒） */
function isGoodEnough(r) {
  if (!r || !r.title) return false;
  const hasPeople = (r.authors && r.authors.length > 0) || !!r.publisher;
  const hasText = !!r.summary && r.summary.length >= 60;
  return !!(hasPeople && hasText && r.cover);
}

function mergeRecords(records) {
  const ordered = [];
  for (const src of PRIORITY) {
    const hit = records.find((r) => r && r.source === src);
    if (hit) ordered.push(hit);
  }
  for (const r of records) if (r && !ordered.includes(r)) ordered.push(r);

  // 只有书名足够接近的次要来源，才允许贡献"文本类"字段，避免串书
  const primaryTitle = ordered[0] ? ordered[0].title : '';
  const textOrdered = ordered.filter(
    (r, idx) => idx === 0 || similarity(r.title || '', primaryTitle) >= 0.6 || !r.title
  );

  const str = (key) => {
    for (const r of textOrdered) if (r[key] && String(r[key]).trim()) return String(r[key]).trim();
    return '';
  };
  const arr = (key) => {
    for (const r of textOrdered) if (Array.isArray(r[key]) && r[key].length) return r[key];
    return [];
  };
  const num = (key) => {
    for (const r of textOrdered) if (Number(r[key]) > 0) return Number(r[key]);
    return 0;
  };
  const longestText = (key, minLen = 80) => {
    const first = str(key);
    if (first && first.length >= minLen) return first;
    let best = first;
    for (const r of textOrdered) {
      const v = r[key] ? String(r[key]).trim() : '';
      if (v.length > best.length) best = v;
    }
    return best;
  };
  const cover = () => {
    for (const r of ordered) if (r.cover) return r.cover;
    return '';
  };

  const ratingCarrier = ordered.find((r) => Number(r.rating) > 0) || null;
  const subjects = unique(ordered.flatMap((r) => r.subjects || [])).slice(0, 20);

  return {
    title: str('title'),
    subtitle: str('subtitle'),
    originalTitle: str('originalTitle'),
    authors: unique(ordered.flatMap((r) => r.authors || [])).slice(0, 8),
    translators: unique(ordered.flatMap((r) => r.translators || [])).slice(0, 8),
    publisher: str('publisher'),
    producer: str('producer'),
    pubdate: str('pubdate'),
    pages: num('pages'),
    price: str('price'),
    binding: str('binding'),
    series: str('series'),
    isbn: str('isbn'),
    cover: cover(),
    summary: longestText('summary'),
    authorIntro: longestText('authorIntro', 200),
    rating: ratingCarrier ? Number(ratingCarrier.rating) : 0,
    ratingCount: ratingCarrier ? Number(ratingCarrier.ratingCount) || 0 : 0,
    ratingScale: ratingCarrier ? ratingCarrier.ratingScale || '' : '',
    ratingLabel: ratingCarrier
      ? ratingCarrier.ratingLabel || (ratingCarrier.source === 'douban' ? '豆瓣评分' : '评分')
      : '',
    subjects,
    sourcePrimary: ordered[0] ? ordered[0].source : '',
    sourceUrl: ordered[0] ? ordered[0].sourceUrl || '' : '',
  };
}

function finalize(record, queryIsbn) {
  const normalized = isbnUtil.normalize(record.isbn || queryIsbn || '');
  const isbn13 = normalized.ok ? normalized.isbn13 : '';
  const isbn10 = normalized.ok ? normalized.isbn10 : '';
  const autoCategory = suggestCategory({
    title: record.title,
    subtitle: record.subtitle,
    originalTitle: record.originalTitle,
    summary: record.summary,
    subjects: record.subjects,
  });
  return {
    ...record,
    isbn13,
    isbn10,
    title: String(record.title || '').trim(),
    rating: record.rating ? Math.round(record.rating * 10) / 10 : 0,
    autoCategory,
  };
}

/**
 * 抓取一本书的元数据
 * @param {{isbn?:string,title?:string,author?:string,force?:boolean}} query
 * @param {{cache?:{get:Function,set:Function}}} deps
 */
async function lookup(query, deps = {}) {
  const cache = deps.cache || { get: () => null, set: () => {} };
  const isbn = String(query.isbn || '').trim();
  const title = String(query.title || '').trim();
  const sourceId = String(query.sourceId || '').trim();
  const fromSubject = query.source === 'douban' && /^\d+$/.test(sourceId);
  if (!isbn && !title && !fromSubject) throw new Error('请提供 ISBN 或书名');

  const key = isbn
    ? `isbn:${isbn}`
    : fromSubject
    ? `douban:${sourceId}`
    : `title:${title.toLowerCase()}`;
  const cached = cache.get(key);
  if (!query.force && cached && cached.record) {
    const ttl = cached.complete ? COMPLETE_TTL : PARTIAL_TTL;
    if (Date.now() - cached.ts < ttl) {
      return { record: cached.record, sources: cached.sources || [], cached: true, complete: !!cached.complete };
    }
  }

  const records = [];
  const sources = [];
  const started = Date.now();

  const track = async (name, label, fn) => {
    const t0 = Date.now();
    try {
      const rec = await fn();
      if (rec && rec.title) {
        records.push(rec);
        sources.push({ key: name, label, ok: true, ms: Date.now() - t0, title: rec.title, url: rec.sourceUrl || '' });
        return rec;
      }
      sources.push({ key: name, label, ok: false, ms: Date.now() - t0, error: '无结果' });
      return null;
    } catch (err) {
      sources.push({ key: name, label, ok: false, ms: Date.now() - t0, error: err.message || String(err) });
      return null;
    }
  };

  // 第一优先：豆瓣（中文书最全，且能反查书名）
  // 如果是"扫封面后用户选中的豆瓣条目"，直接用条目 id 抓，命中更准
  let primary = null;
  if (fromSubject) {
    primary = await track('douban', '豆瓣读书', () => douban.bySubjectId(sourceId));
  } else if (isbn || title) {
    primary = await track('douban', '豆瓣读书', () =>
      isbn ? douban.byIsbn(isbn) : douban.byTitle(title, { allowLoose: false })
    );
  }

  const titleGuess = (primary && primary.title) || title;
  const parallel = [];
  if (titleGuess) parallel.push(track('weread', '微信读书', () => weread.byTitle(titleGuess)));
  if (usable('google')) {
    parallel.push(
      track('google', 'Google Books', () =>
        isbn ? google.googleByIsbn(isbn) : google.googleByTitle(titleGuess)
      )
    );
  }
  if (usable('openlibrary')) {
    parallel.push(
      track('openlibrary', 'Open Library', () =>
        isbn ? google.openLibraryByIsbn(isbn) : google.openLibraryByTitle(titleGuess)
      )
    );
  }

  // 并行补充源：一旦"信息够用"就提前返回，不必等满软deadline（海外源常要 2-4s）
  let allSettled = parallel.length === 0;
  const all = Promise.allSettled(parallel).then(() => {
    allSettled = true;
  });
  const waitStart = Date.now();
  while (!allSettled && Date.now() - waitStart < SOFT_DEADLINE) {
    await sleep(120);
    if (records.length && isGoodEnough(mergeRecords(records))) break;
  }
  const complete = allSettled;
  void all;

  const record = finalize(mergeRecords(records), isbn);
  const result = { record, sources, cached: false, complete, elapsed: Date.now() - started };
  if (record.title) cache.set(key, { ts: Date.now(), record, sources, complete });
  return result;
}

/** 去掉「（第2部）」「: 修订版」这类后缀，便于搜到同系列/其他版本 */
function cleanSeriesTitle(title) {
  return String(title || '')
    .replace(/[（(【\[][^）)】\]]{0,14}(第?\s*[一二三四五六七八九十百\d]+\s*[部卷册集篇]|上|中|下|修订版|新版|典藏版|插图版|全集|套装|盒装)[）)】\]]/g, '')
    .replace(/[（(【\[][^）)】\]]{0,14}[）)】\]]\s*$/, '')
    .replace(/\s*[：:·—–-]\s*[^：:·—–-]{0,18}(版|修订|插图|典藏|全译|精装)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAuthor(author) {
  return String(author || '')
    .replace(/^[\[【][^\]】]*[\]】]\s*/, '')
    .replace(/\s*[（(][^）)]*[）)]\s*/g, '')
    .replace(/[著编译注述主编]+$/g, '')
    .trim();
}

/**
 * 自家分类 → Open Library 主题词。
 * 只保留实测"窄且准"的主题：宽泛主题（fiction / art / science）在 OL 上会返回
 * 一堆高分但毫不相关的畅销书，宁可不给。
 */
const CATEGORY_SUBJECTS = {
  计算机与技术: ['computer programming'],
  科普与科学: ['popular science'],
};

/**
 * 相关推荐：合并
 *   豆瓣「喜欢这本书的人也喜欢」(rexxar 接口) + 豆瓣联想(同系列/其他版本/同一作者)
 *   微信读书搜索(同书/同作者) + Open Library(同主题/同作者)
 * 每条都带 source / reason，交给前端展示；调用方负责过滤"已在书架"。
 */
async function related(book, limit = 12) {
  const title = String(book.title || '').trim();
  const base = cleanSeriesTitle(title);
  const author = cleanAuthor((book.authors || [])[0] || '');
  const sourceSubjectId = (String(book.sourceUrl || '').match(/subject\/(\d+)/) || [])[1] || '';
  const hasSubjectId = /^\d+$/.test(sourceSubjectId);

  const tasks = [
    douban
      .suggest(title)
      .then((list) => ({ kind: 'db-title', list: list || [] }))
      .catch(() => ({ kind: 'db-title', list: [] })),
    weread
      .search(title, { limit: 8 })
      .then((list) => ({ kind: 'wr-title', list: list || [] }))
      .catch(() => ({ kind: 'wr-title', list: [] })),
  ];
  // 已知豆瓣条目 id 时，"读者也喜欢"直接并行拿，不用等联想结果
  if (hasSubjectId) {
    tasks.push(
      douban
        .recommendations(sourceSubjectId, { count: 12 })
        .then((list) => ({ kind: 'db-reader', list: list || [] }))
        .catch(() => ({ kind: 'db-reader', list: [] }))
    );
  }
  if (author && author.length >= 2) {
    tasks.push(
      weread
        .search(author, { limit: 6 })
        .then((list) => ({ kind: 'wr-author', list: list || [] }))
        .catch(() => ({ kind: 'wr-author', list: [] }))
    );
  }
  // Open Library：优先用书自身的英文主题词，其次按自家分类映射
  const ownSubjects = (book.subjects || []).map((s) => String(s)).filter((s) => /[A-Za-z]/.test(s)).slice(0, 2);
  const mapped = CATEGORY_SUBJECTS[book.autoCategoryName || ''] || [];
  const olSubject = ownSubjects[0] || mapped[0] || '';
  if (olSubject) {
    tasks.push(
      google
        .openLibrarySearch(`subject:"${olSubject}"`, { limit: 8, sort: 'rating' })
        .then((list) => ({ kind: 'ol-subject', list: list || [] }))
        .catch(() => ({ kind: 'ol-subject', list: [] }))
    );
  }
  if (author && /[A-Za-z]/.test(author)) {
    tasks.push(
      google
        .openLibrarySearch(`author:"${author}"`, { limit: 6, sort: 'rating' })
        .then((list) => ({ kind: 'ol-author', list: list || [] }))
        .catch(() => ({ kind: 'ol-author', list: [] }))
    );
  }

  const settled = await Promise.all(tasks);
  const pick = (kind) => (settled.find((s) => s.kind === kind) || { list: [] }).list;

  const dbTitle = pick('db-title');
  let readerRecs = pick('db-reader');
  // 没有书目页 id（手动录入的书）：用豆瓣联想里最像的一条反查
  if (!readerRecs.length) {
    let subjectId = sourceSubjectId;
    if (!subjectId && dbTitle.length) {
      const best = dbTitle
        .map((c) => ({ id: c.id, score: similarity(c.title, title) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.8 && /^\d+$/.test(String(best.id || ''))) subjectId = String(best.id);
    }
    if (subjectId) readerRecs = await douban.recommendations(subjectId, { count: 12 }).catch(() => []);
  }

  const groups = { reader: [], title: [], author: [], subject: [] };
  const addTo = (group, item, reason, score) => {
    if (!item || !item.title) return;
    groups[group].push({
      source: item.source,
      sourceLabel: item.sourceLabel || item.source,
      id: String(item.id || ''),
      title: item.title,
      author: item.author || '',
      publisher: item.publisher || '',
      year: item.year || '',
      cover: item.cover || '',
      url: item.url || '',
      rating: Number(item.rating) || 0,
      reason,
      group,
      score: Math.round((score || 0) * 100) / 100,
    });
  };

  // ① 豆瓣"读者也喜欢"（信号最强）
  for (const r of readerRecs) {
    addTo('reader', r, '读者也喜欢', 0.7 + Math.min(0.25, ((Number(r.rating) || 0) / 10) * 0.25));
  }
  // ② 同系列 / 其他版本 / 书名相近（豆瓣 + 微信读书）
  for (const c of [...dbTitle, ...pick('wr-title')]) {
    const t = Math.max(similarity(c.title, title), similarity(c.title, base));
    if (t < 0.5) continue;
    const knownAuthor = author && author.length >= 2;
    const authorHit = knownAuthor && c.author && similarity(cleanAuthor(c.author), author) > 0.6;
    if (knownAuthor && !authorHit && t < 0.9 && c.author) continue; // 排除同名网文/山寨书
    const mismatch = knownAuthor && c.author && !authorHit;
    addTo('title', c, t >= 0.9 ? (mismatch ? '同名书' : '同系列 / 同名') : '书名相近', t - (mismatch ? 0.25 : 0));
  }
  // ③ 同一作者（微信读书 + Open Library）
  for (const c of [...pick('wr-author'), ...pick('ol-author')]) {
    if (similarity(c.title, title) >= 0.5 || similarity(c.title, base) > 0.5) continue;
    const authorHit = c.author && similarity(cleanAuthor(c.author), author) > 0.6;
    if (!authorHit && c.source !== 'openlibrary') continue;
    addTo('author', c, '同一作者', 0.4);
  }
  // ④ 同主题读者也在读（Open Library 按主题取"最受好评"的书）
  for (const c of pick('ol-subject')) {
    if (similarity(c.title, title) >= 0.5) continue;
    addTo('subject', c, '同主题读者也喜欢', 0.3 + Math.min(0.2, (c.rating || 0) / 50));
  }

  // 每个来源给配额，保证多源都有露脸机会，再拼成一条列表
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
  const seen = new Set();
  const take = (group, max) => {
    const out = [];
    for (const c of groups[group].sort((a, b) => b.score - a.score)) {
      if (out.length >= max) break;
      const key = `${norm(c.title)}|${norm(c.author).slice(0, 4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  };
  const quotas = { reader: 5, title: 3, author: 2, subject: 2 };
  const merged = ['reader', 'title', 'author', 'subject'].reduce(
    (acc, group) => acc.concat(take(group, quotas[group])),
    []
  );
  return { candidates: merged.slice(0, limit), queries: [base || title, author].filter(Boolean) };
}

/**
 * 按作者/译者名字列出其作品（用于详情页点作者名）
 *  豆瓣作者作品接口（最全，返回 total 可翻页）
 *  微信读书搜索（作者字段里也含译者，豆瓣对译者没有作品列表）
 *  Open Library（拉丁字母名字）
 * @returns {{name:string, total:number, items:object[], sources:string[]}}
 */
async function byAuthor(name, { limit = 60 } = {}) {
  const raw = String(name || '').trim();
  const cleaned = cleanAuthor(raw) || raw;
  if (!cleaned) return { name: raw, total: 0, items: [], sources: [] };
  const sources = [];

  const [dbResult, wrList, olList] = await Promise.all([
    (async () => {
      const ent = await douban.findAuthorEntity(cleaned);
      if (!ent) return { total: 0, works: [] };
      const r = await douban.authorWorks(ent.id, { count: Math.max(limit, 40) });
      if (r.works.length) sources.push('豆瓣');
      return r;
    })().catch(() => ({ total: 0, works: [] })),
    weread
      .search(cleaned, { limit: 40 })
      .then((list) => {
        const hit = (list || []).filter((c) => {
          const a = String(c.author || '');
          return a.includes(cleaned) || (raw && a.includes(raw));
        });
        if (hit.length) sources.push('微信读书');
        return hit;
      })
      .catch(() => []),
    /^[A-Za-z]/.test(cleaned)
      ? google
          .openLibrarySearch(`author:"${cleaned}"`, { limit: 20, sort: 'rating' })
          .then((list) => {
            if ((list || []).length) sources.push('Open Library');
            return list || [];
          })
          .catch(() => [])
      : Promise.resolve([]),
  ]);

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
  const seen = new Set();
  const items = [];
  const ordered = [...(dbResult.works || []), ...wrList, ...olList];
  for (const c of ordered) {
    if (!c || !c.title) continue;
    const key = norm(c.title);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      source: c.source,
      sourceLabel: c.sourceLabel || c.source,
      id: String(c.id || ''),
      title: c.title,
      author: c.author || '',
      publisher: c.publisher || '',
      year: c.year || '',
      cover: c.cover || '',
      url: c.url || '',
      rating: Number(c.rating) || 0,
      ratingCount: Number(c.ratingCount) || 0,
    });
  }
  return {
    name: cleaned,
    total: Math.max(Number(dbResult.total) || 0, items.length),
    items: items.slice(0, limit),
    sources: [...new Set(sources)],
  };
}

/** 关键词搜索（用于没有条码时按书名挑书） */
async function search(keyword) {  const q = String(keyword || '').trim();
  if (!q) return [];
  const [d, w] = await Promise.all([
    douban.suggest(q).catch(() => []),
    weread.search(q, { limit: 8 }).catch(() => []),
  ]);
  const merged = [...d, ...w];
  const seen = new Set();
  const out = [];
  for (const item of merged.sort((a, b) => similarity(b.title, q) - similarity(a.title, q))) {
    const dedupe = `${item.title}|${item.author}`;
    if (!item.title || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ ...item, score: similarity(item.title, q) });
  }
  return out.slice(0, 12);
}

module.exports = {
  lookup,
  search,
  related,
  byAuthor,
  checkHealth,
  healthSnapshot,
  mergeRecords,
  finalize,
  PRIORITY,
  setGoogleApiKeyProvider: google.setApiKeyProvider,
};
