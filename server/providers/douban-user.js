'use strict';

/* 豆瓣个人收藏同步（需要用户在设置里填自己的登录 Cookie）
 *   接口：m.douban.com/rexxar/api/v2/user/<uid>/interests?type=book|movie&status=...
 *   uid 从 Cookie 的 dbcl2="<uid>:<hash>" 里取
 * 注意：无 Cookie 或 Cookie 失效时，接口会返回 200 但 interests 为空（不会报错），
 *      所以调用方要把"读不到任何记录"当成需要提示的情况。
 */

const { fetchJson, clean, sleep, DESKTOP_UA } = require('../util');

const BASE = process.env.BOOKNEST_DOUBAN_USER_BASE || 'https://m.douban.com';
const PAGE = 20;
const MAX_ITEMS = Number(process.env.BOOKNEST_DOUBAN_SYNC_MAX || 200);

/** 从 Cookie 里解析豆瓣用户 id（dbcl2="1234567:xxxx"） */
function parseUserId(cookie) {
  const m = String(cookie || '').match(/dbcl2\s*=\s*"?(\d+)\s*:/);
  return m ? m[1] : '';
}

function headers(cookie) {
  return {
    'User-Agent': DESKTOP_UA,
    Referer: 'https://m.douban.com/mine/',
    Accept: 'application/json',
    Cookie: String(cookie || ''),
  };
}

const STATUS_MAP = {
  book: { collect: 'wish', doing: 'reading', done: 'finished' },
  movie: { collect: 'wish', do: 'watching', done: 'watched' },
};

const STATUS_LABEL = {
  book: { collect: '想读', doing: '在读', done: '读过' },
  movie: { collect: '想看', do: '在看', done: '看过' },
};

function splitPeople(text) {
  return String(text || '')
    .split(/[\/、,，]/)
    .map((x) => clean(x.replace(/\[[^\]]*\]|【[^】]*】/g, '')))
    .filter(Boolean);
}

/** 把一条 interest 归一化成我们的书籍/影片字段 */
function normalizeItem(raw, kind) {
  const it = raw || {};
  const subject = it.subject || it;
  const rating = subject.rating || it.rating || {};
  const pic = subject.pic || subject.cover || {};
  const id = String(subject.id || it.subject_id || it.id || '');
  if (!id || !subject.title) return null;
  const sub = clean(subject.card_subtitle || subject.subtitle || '');
  const yearMatch = sub.match(/(19|20)\d{2}/);
  const base = {
    doubanId: id,
    title: clean(subject.title),
    rating: Number(rating.value) || 0,
    ratingCount: Number(rating.count) || 0,
    myRating: Number((it.rating && it.rating.value) || it.my_rating || 0) || 0,
    note: clean(it.comment || ''),
  };
  if (kind === 'book') {
    // card_subtitle 形如 "余华 / 作家出版社 / 2012-6 / 28.00元"
    const parts = sub.split('/').map((x) => clean(x));
    return {
      ...base,
      coverRemote: pic.large || pic.normal || subject.cover_url || '',
      authors: splitPeople(parts[0] || ''),
      publisher: parts[1] || '',
      pubdate: parts[2] || '',
      price: parts[3] || '',
      year: (parts[2] || '').slice(0, 4) || (yearMatch ? yearMatch[0] : ''),
    };
  }
  return {
    ...base,
    posterRemote: pic.large || pic.normal || subject.cover_url || '',
    year: (yearMatch ? yearMatch[0] : '') || clean(subject.year || ''),
    type: subject.type === 'tv' ? 'tv' : 'movie',
    genres: Array.isArray(subject.genres) ? subject.genres.map((g) => clean(g)) : [],
  };
}

/**
 * 拉某个状态下的条目（分页，带限速）。
 * known(item) 返回 true 的条目会被跳过但仍继续翻页——这样超过单次上限的长列表
 * （例如豆瓣"想看"上千条）每同步一次都能往后推进，而不是反复读前 N 条。
 */
async function fetchStatus({ cookie, uid, kind, status, budget, known }) {
  const out = [];
  let start = 0;
  let total = null;
  let scanned = 0;
  let skippedKnown = 0;
  while (out.length < budget) {
    const url = `${BASE}/rexxar/api/v2/user/${encodeURIComponent(uid)}/interests?type=${
      kind === 'book' ? 'book' : 'movie'
    }&status=${encodeURIComponent(status)}&start=${start}&count=${PAGE}`;
    let data;
    try {
      data = await fetchJson(url, { headers: headers(cookie) }, 12000);
    } catch (err) {
      break;
    }
    if (total == null) total = Number(data.total) || 0;
    const items = Array.isArray(data.interests) ? data.interests : [];
    if (!items.length) break;
    for (const raw of items) {
      const norm = normalizeItem(raw, kind);
      if (!norm) continue;
      scanned += 1;
      const item = { ...norm, status: STATUS_MAP[kind][status] || 'wish', doubanStatus: status };
      if (known && known(item)) {
        skippedKnown += 1;
        continue;
      }
      out.push(item);
      if (out.length >= budget) break;
    }
    start += PAGE;
    if (start >= (Number(data.total) || 0)) break;
    if (out.length >= budget) break;
    await sleep(1100); // 豆瓣限速
  }
  return { items: out, total: total || 0, scanned, skippedKnown };
}

/** 拉某类（book/movie）的全部收藏状态 */
async function fetchAll({ cookie, uid, kind, known }) {
  const statuses = kind === 'book' ? ['collect', 'doing', 'done'] : ['collect', 'do', 'done'];
  const items = [];
  const summary = {};
  let total = 0;
  let scanned = 0;
  let skippedKnown = 0;
  for (const status of statuses) {
    const budget = Math.max(0, MAX_ITEMS - items.length);
    const res = budget > 0 ? await fetchStatus({ cookie, uid, kind, status, budget, known }) : { items: [], total: 0, scanned: 0, skippedKnown: 0 };
    items.push(...res.items);
    summary[STATUS_LABEL[kind][status]] = res.total;
    total += res.total;
    scanned += res.scanned || 0;
    skippedKnown += res.skippedKnown || 0;
    if (items.length >= MAX_ITEMS) break;
  }
  return { items: items.slice(0, MAX_ITEMS), summary, total, max: MAX_ITEMS, scanned, skippedKnown };
}

module.exports = { parseUserId, fetchAll, fetchStatus, normalizeItem, STATUS_MAP, STATUS_LABEL };
