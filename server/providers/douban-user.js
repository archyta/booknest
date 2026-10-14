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
// 每个状态各自的配额（原来是"两类合计 200 条"，会被"想看/想读"吃满，
// 导致看过/在看根本没被查询）
const MAX_PER_STATUS = Number(process.env.BOOKNEST_DOUBAN_SYNC_MAX || 200);

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

// 注意：电影"在看"也必须用 doing —— 实测传 do 会被豆瓣忽略，
// 返回的是"想看"列表（total 与 collect 完全相同）
const STATUS_KEYS = {
  book: ['collect', 'doing', 'done'],
  movie: ['collect', 'doing', 'done'],
};

const STATUS_MAP = {
  book: { collect: 'wish', doing: 'reading', done: 'finished' },
  movie: { collect: 'wish', doing: 'watching', done: 'watched' },
};

const STATUS_LABEL = {
  book: { collect: '想读', doing: '在读', done: '读过' },
  movie: { collect: '想看', doing: '在看', done: '看过' },
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
  // 影片的 card_subtitle 形如： "2010 / 美国 / 剧情 科幻 悬疑 / 克里斯托弗·诺兰 / 莱昂纳多·迪卡普里奥"
  const seg = sub.split('/').map((x) => clean(x));
  const countrySrc = seg[1] || '';
  const genreSrc = seg[2] || '';
  const genres = Array.isArray(subject.genres) && subject.genres.length
    ? subject.genres.map((g) => clean(g))
    : splitPeople(genreSrc.replace(/[\u4e00-\u9fa5A-Za-z]+/g, (m) => m + ' '))
        .map((x) => x.split(/\s+/))
        .flat()
        .filter((x) => x && x.length <= 6 && !/^(\d{4}|电影|剧集)$/.test(x))
        .slice(0, 6);
  const countries = countrySrc
    ? countrySrc
        .split(/[\s、,，]+/)
        .map((x) => clean(x))
        .filter((x) => x && /^[\u4e00-\u9fa5]{2,6}$/.test(x) && !/^(电影|剧集|电视剧)$/.test(x))
        .slice(0, 3)
    : [];
  return {
    ...base,
    posterRemote: pic.large || pic.normal || subject.cover_url || '',
    year: (yearMatch ? yearMatch[0] : '') || clean(subject.year || ''),
    type: subject.type === 'tv' || /剧集|电视剧/.test(sub) ? 'tv' : 'movie',
    genres,
    countries,
    directors: seg[3] ? splitPeople(seg[3]) : [],
    actors: seg[4] ? splitPeople(seg[4]).slice(0, 6) : [],
    durations: [],
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
    // 校验：条目自带 status，与请求的不一致说明豆瓣忽略了该 status 参数
    // collect（想读/想看）不做此校验：它的条目 status 与请求并不总是一致，
    // 而且键名已修正为 collect/doing/done，alias 风险只存在于 doing/done
    const knownStatuses = Object.keys(STATUS_MAP[kind] || {});
    const head = status === 'collect' ? [] : items.slice(0, 3).map((x) => x && x.status).filter(Boolean);
    const firstStatus = head[0];
    if (head.length && head.every((x) => knownStatuses.includes(x) && x !== status)) {
      // 例如请求 doing（在看）却返回 collect（想看）→ 说明该键名被忽略
      return { items: [], total: 0, scanned: 0, skippedKnown: 0, invalidKey: true, actualStatus: firstStatus };
    }
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
async function fetchAll({ cookie, uid, kind, known, maxPerStatus }) {
  const statuses = STATUS_KEYS[kind];
  const perStatus = Number(maxPerStatus) > 0 ? Number(maxPerStatus) : MAX_PER_STATUS;
  const items = [];
  const summary = {};
  const byStatus = {};
  let total = 0;
  let scanned = 0;
  let skippedKnown = 0;
  for (const status of statuses) {
    // 每个状态各自配额：想看上干条也不会挤掉看过/在看
    const res = await fetchStatus({ cookie, uid, kind, status, budget: perStatus, known });
    items.push(...res.items);
    summary[STATUS_LABEL[kind][status]] = res.total;
    byStatus[STATUS_LABEL[kind][status]] = { total: res.total, 抓取: res.items.length, 略过已入库: res.skippedKnown || 0, 键名无效: !!res.invalidKey };
    total += res.total;
    scanned += res.scanned || 0;
    skippedKnown += res.skippedKnown || 0;
  }
  return { items, summary, byStatus, total, max: perStatus, scanned, skippedKnown };
}

module.exports = { parseUserId, fetchAll, fetchStatus, normalizeItem, STATUS_MAP, STATUS_LABEL, STATUS_KEYS };
