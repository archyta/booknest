'use strict';

/* 海外公开源：Google Books API + Open Library
 *
 * 国内网络需要走代理：由 start.sh 注入
 *   NODE_USE_ENV_PROXY=1  HTTPS_PROXY=http://127.0.0.1:7890  NO_PROXY=<国内站点>
 * Node 18+ 的 fetch 只有在 NODE_USE_ENV_PROXY 打开时才会读代理环境变量（Node 24 实测可用）。
 * 若探测到不可用，启动时的健康检查会把它们标记为不可用并自动跳过，不影响豆瓣/微信读书。
 */

const { fetchWithTimeout, clean, cleanMultiline, unique } = require('../util');

const OL_FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'first_publish_year',
  'publisher',
  'number_of_pages_median',
  'subject',
  'cover_i',
  'isbn',
  'language',
  'ratings_average',
  'ratings_count',
].join(',');

let apiKeyProvider = () => '';
function setApiKeyProvider(fn) {
  apiKeyProvider = typeof fn === 'function' ? fn : () => '';
}
function apiKey() {
  try {
    return String(apiKeyProvider() || '').trim();
  } catch (err) {
    return '';
  }
}

/* ---------------- Google Books ---------------- */

async function googleJson(url, timeout = 6000) {
  const key = apiKey();
  const full = key ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : url;
  const res = await fetchWithTimeout(full, {}, timeout);
  if (res.status === 429) {
    const err = new Error(
      key ? 'Google Books 配额已用尽（该 Key 今日额度用完）' : 'Google Books 匿名配额已用尽，可在「设置」里填一个 API Key'
    );
    err.quota = true;
    throw err;
  }
  if (res.status === 403 || res.status === 400) {
    const err = new Error(
      key ? 'Google Books 拒绝请求（API Key 无效，或未启用 Books API）' : 'Google Books 拒绝访问'
    );
    err.quota = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Google Books 返回 ${res.status}`);
  return res.json();
}

async function googleByIsbn(isbn) {
  const data = await googleJson(
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&country=US&maxResults=3`
  );
  const item = (data.items || [])[0];
  if (!item || !item.volumeInfo) {
    const err = new Error('Google Books 没有收录');
    err.notFound = true;
    throw err;
  }
  return fromGoogleVolume(item);
}

async function googleByTitle(title) {
  const data = await googleJson(
    `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title)}&country=US&maxResults=3`
  );
  const item = (data.items || [])[0];
  if (!item || !item.volumeInfo) {
    const err = new Error('Google Books 没有收录');
    err.notFound = true;
    throw err;
  }
  return fromGoogleVolume(item);
}

function fromGoogleVolume(item) {
  const v = item.volumeInfo || {};
  const ids = Array.isArray(v.industryIdentifiers) ? v.industryIdentifiers : [];
  const isbn13 = (ids.find((i) => /13/.test(i.type)) || {}).identifier || '';
  const isbn10 = (ids.find((i) => /10/.test(i.type)) || {}).identifier || '';
  const links = v.imageLinks || {};
  const cover = (links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail || '').replace(
    /^http:/,
    'https:'
  );
  return {
    source: 'google',
    sourceLabel: 'Google Books',
    sourceUrl: v.infoLink || v.canonicalVolumeLink || '',
    sourceId: item.id || '',
    title: clean(v.title || ''),
    subtitle: clean(v.subtitle || ''),
    originalTitle: '',
    authors: unique((v.authors || []).map((a) => clean(a))),
    translators: [],
    publisher: clean(v.publisher || ''),
    pubdate: clean(v.publishedDate || ''),
    pages: Number(v.pageCount) || 0,
    price: '',
    binding: '',
    isbn: isbn13 || isbn10,
    series: '',
    cover,
    summary: cleanMultiline(v.description || ''),
    authorIntro: '',
    rating: v.averageRating ? Number(v.averageRating) * 2 : 0,
    ratingCount: Number(v.ratingsCount) || 0,
    ratingScale: 'google',
    ratingLabel: 'Google Books 评分',
    subjects: unique((v.categories || []).map((c) => clean(c))),
  };
}

/* ---------------- Open Library ---------------- */
/* 实测：/api/books?bibkeys=... 常返回 404，而 /search.json 稳定可用，
 * 封面走 covers.openlibrary.org/b/id/<cover_i>-L.jpg */

async function olSearchDocument(query, timeout = 7000) {
  const url = `https://openlibrary.org/search.json?${query}&limit=1&fields=${OL_FIELDS}`;
  const res = await fetchWithTimeout(url, {}, timeout);
  if (!res.ok) throw new Error(`Open Library 返回 ${res.status}`);
  const data = await res.json();
  const doc = (data.docs || [])[0];
  if (!doc) {
    const err = new Error('Open Library 没有收录');
    err.notFound = true;
    throw err;
  }
  return doc;
}

async function workDescription(key) {
  if (!key) return '';
  try {
    const res = await fetchWithTimeout(`https://openlibrary.org${key}.json`, {}, 2500);
    if (!res.ok) return '';
    const work = await res.json();
    const desc = work.description;
    const text = typeof desc === 'string' ? desc : (desc && desc.value) || '';
    return cleanMultiline(text);
  } catch (err) {
    return '';
  }
}

async function fromOpenLibraryDoc(doc, isbn) {
  const langs = Array.isArray(doc.language) ? doc.language : [];
  const summary = await workDescription(doc.key);
  const subjects = unique((doc.subject || []).map((s) => clean(s))).slice(0, 15);
  const pages = Number(doc.number_of_pages_median) || 0;
  return {
    source: 'openlibrary',
    sourceLabel: 'Open Library',
    sourceUrl: doc.key ? `https://openlibrary.org${doc.key}` : `https://openlibrary.org/isbn/${isbn || ''}`,
    sourceId: doc.key || '',
    title: clean(doc.title || ''),
    subtitle: clean(doc.subtitle || ''),
    originalTitle: '',
    authors: unique((doc.author_name || []).map((a) => clean(a))),
    translators: [],
    publisher: clean(((doc.publisher || [])[0] || '') + ''),
    pubdate: doc.first_publish_year ? String(doc.first_publish_year) : '',
    pages,
    price: '',
    binding: '',
    isbn: isbn || (Array.isArray(doc.isbn) ? doc.isbn[0] : '') || '',
    series: '',
    cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '',
    summary,
    authorIntro: '',
    rating: 0,
    ratingCount: 0,
    ratingScale: 'openlibrary',
    subjects,
    language: langs.join(','),
  };
}

async function openLibraryByIsbn(isbn) {
  const doc = await olSearchDocument(`isbn=${encodeURIComponent(isbn)}`);
  return fromOpenLibraryDoc(doc, isbn);
}

async function openLibraryByTitle(title) {
  const doc = await olSearchDocument(`title=${encodeURIComponent(title)}`);
  return fromOpenLibraryDoc(doc, '');
}

/** 通用检索（用于"同主题/同作者的读者也在读"）；sort=rating 拿到的是"这个主题里最受好评的书" */
async function openLibrarySearch(query, { limit = 8, timeout = 7000, sort = 'rating', minRatings = 5 } = {}) {
  const url =
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${Math.max(limit, 8)}` +
    `&fields=${OL_FIELDS}${sort ? `&sort=${encodeURIComponent(sort)}` : ''}`;
  const res = await fetchWithTimeout(url, {}, timeout);
  if (!res.ok) throw new Error(`Open Library 返回 ${res.status}`);
  const data = await res.json();
  const mapped = (data.docs || [])
    .filter((doc) => doc && doc.title)
    .map((doc) => ({
      source: 'openlibrary',
      sourceLabel: 'Open Library',
      id: doc.key || '',
      title: clean(doc.title || ''),
      author: (doc.author_name || [])[0] || '',
      year: doc.first_publish_year ? String(doc.first_publish_year) : '',
      publisher: Array.isArray(doc.publisher) ? doc.publisher[0] || '' : '',
      cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '',
      url: doc.key ? `https://openlibrary.org${doc.key}` : '',
      rating: Number(doc.ratings_average) ? Math.round(Number(doc.ratings_average) * 20) / 10 : 0,
      ratingCount: Number(doc.ratings_count) || 0,
      subjects: unique((doc.subject || []).map((s) => clean(s))).slice(0, 8),
    }));
  const popular = mapped.filter((d) => d.ratingCount >= minRatings);
  return (popular.length ? popular : mapped).slice(0, limit);
}

/* ---------------- 可用性探测 ---------------- */

async function ping(which) {
  const started = Date.now();
  try {
    if (which === 'google') {
      const key = apiKey();
      const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:9780140328721&country=US&maxResults=1${
        key ? `&key=${encodeURIComponent(key)}` : ''
      }`;
      const res = await fetchWithTimeout(url, {}, 5000);
      if (res.status === 429) {
        return {
          ok: false,
          ms: Date.now() - started,
          error: key ? '该 API Key 今日配额已用尽' : '匿名配额已用尽，需填 API Key',
        };
      }
      if (!res.ok) return { ok: false, ms: Date.now() - started, error: `HTTP ${res.status}` };
      return { ok: true, ms: Date.now() - started };
    }
    const res = await fetchWithTimeout(
      `https://openlibrary.org/search.json?isbn=9780140328721&limit=1&fields=key`,
      {},
      5000
    );
    if (!res.ok) return { ok: false, ms: Date.now() - started, error: `HTTP ${res.status}` };
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err.message || String(err) };
  }
}

module.exports = {
  googleByIsbn,
  googleByTitle,
  openLibraryByIsbn,
  openLibraryByTitle,
  openLibrarySearch,
  fromGoogleVolume,
  fromOpenLibraryDoc,
  ping,
  setApiKeyProvider,
  hasApiKey: () => !!apiKey(),
};
