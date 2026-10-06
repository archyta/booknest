'use strict';

/* 微信读书公开搜索接口：补充封面、简介、出版方、推荐值（评分） */

const { fetchJson, clean, cleanMultiline, similarity, DESKTOP_UA } = require('../util');

const SEARCH = 'https://weread.qq.com/web/search/global';
const HEADERS = { Referer: 'https://weread.qq.com/', 'User-Agent': DESKTOP_UA };

function priceText(price) {
  if (price === null || price === undefined || price === '') return '';
  const s = String(price).trim();
  if (!s || s === '0') return '';
  return /元|¥|￥/.test(s) ? s : `${s}元`;
}

function normalizeBook(info) {
  if (!info || !info.title) return null;
  const ratingRaw = Number(info.newRating) || 0; // 0-1000 的"推荐值"
  return {
    source: 'weread',
    sourceLabel: '微信读书',
    sourceUrl: info.deepLink || (info.bookId ? `https://weread.qq.com/web/bookDetail/${info.bookId}` : ''),
    sourceId: String(info.bookId || ''),
    title: clean(info.title || ''),
    subtitle: '',
    originalTitle: '',
    authors: info.author ? [clean(info.author)] : [],
    translators: [],
    publisher: clean(info.publisher || ''),
    pubdate: '',
    pages: 0,
    price: priceText(info.price),
    binding: '',
    isbn: '',
    series: '',
    cover: info.cover || '',
    summary: cleanMultiline(info.intro || ''),
    authorIntro: '',
    rating: ratingRaw ? ratingRaw / 100 : 0,
    ratingCount: Number(info.newRatingCount) || 0,
    ratingScale: 'weread',
    ratingLabel: ratingRaw ? '微信读书推荐值' : '',
    subjects: info.category ? [clean(info.category)] : [],
  };
}

/** 搜索候选（返回精简列表） */
async function search(keyword, { limit = 8 } = {}) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  const url = `${SEARCH}?keyword=${encodeURIComponent(q)}&maxNum=${limit * 2}&fragmentSize=60`;
  let data;
  try {
    data = await fetchJson(url, { headers: HEADERS }, 8000);
  } catch (err) {
    return [];
  }
  const books = Array.isArray(data && data.books) ? data.books : [];
  return books
    .map((b) => normalizeBook(b && b.bookInfo))
    .filter(Boolean)
    .map((r) => ({
      source: 'weread',
      sourceLabel: '微信读书',
      id: r.sourceId,
      title: r.title,
      author: r.authors[0] || '',
      publisher: r.publisher,
      year: '',
      cover: r.cover,
      url: r.sourceUrl,
      raw: r,
    }));
}

/** 按书名取最匹配的一本（含简介/评分） */
async function byTitle(title) {
  const list = await search(title, { limit: 10 });
  if (!list.length) {
    const err = new Error('微信读书没有收录');
    err.notFound = true;
    throw err;
  }
  const ranked = list
    .map((c) => ({ c, score: similarity(c.title, title) }))
    .sort((a, b) => b.score - a.score);
  if (ranked[0].score < 0.5) {
    const err = new Error('微信读书没有明显匹配的书名');
    err.notFound = true;
    throw err;
  }
  return normalizeBook({ ...ranked[0].c.raw });
}

module.exports = { byTitle, search, normalizeBook, name: 'weread' };
