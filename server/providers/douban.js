'use strict';

/* 豆瓣图书（公开页面解析）——中文书信息最全的来源
 * 说明：仅解析公开可见的书目页字段，带 1.2s 最小请求间隔 + 失败退避，避免给对方造成压力。
 */

const { fetchWithTimeout, clean, cleanMultiline, unique, sleep, similarity, fetchJson, DESKTOP_UA } = require('../util');

const BASE = 'https://book.douban.com';
const MIN_INTERVAL_MS = 1200;
const HEADERS = { Referer: `${BASE}/`, 'User-Agent': DESKTOP_UA };

let chain = Promise.resolve();
let lastAt = 0;

function schedule(task) {
  const run = async () => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastAt));
    if (wait) await sleep(wait);
    lastAt = Date.now();
    return task();
  };
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

/** 固定桌面 UA 请求一次；若被重定向到 m.douban.com（手机版结构不同），自动换回桌面版页面 */
async function fetchPage(url, timeout) {
  const res = await fetchWithTimeout(url, { headers: HEADERS }, timeout);
  const status = res.status;
  if (status !== 200) return { status, html: '', url: res.url || url };
  let html = await res.text();
  let finalUrl = res.url || url;
  if (/m\.douban\.com/.test(finalUrl)) {
    const id = (finalUrl.match(/subject\/(\d+)/) || [])[1];
    const desktop = id ? `${BASE}/subject/${id}/` : '';
    if (desktop && desktop !== url) {
      const res2 = await fetchWithTimeout(desktop, { headers: HEADERS }, timeout);
      if (res2.ok) {
        html = await res2.text();
        finalUrl = res2.url || desktop;
      }
    }
  }
  return { status, html, url: finalUrl };
}

async function request(url, { timeout = 9000, retries = 1 } = {}) {
  return schedule(async () => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const page = await fetchPage(url, timeout);
        if (page.status === 403 || page.status === 429) {
          const err = new Error(`豆瓣返回 ${page.status}（可能触发反爬，稍后再试）`);
          err.status = page.status;
          throw err;
        }
        if (page.status !== 200) throw new Error(`豆瓣返回 ${page.status}`);
        if (page.html.includes('检测到有异常请求') || page.html.includes('sec.douban.com')) {
          const err = new Error('豆瓣反爬拦截，请稍后重试');
          err.status = 403;
          throw err;
        }
        return page;
      } catch (err) {
        lastErr = err;
        const retriable = err.status === 403 || err.status === 429 || /超时/.test(err.message || '');
        if (attempt < retries && retriable) {
          await sleep(2500 + attempt * 3000);
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('豆瓣请求失败');
  });
}

function valuesOf(segment) {
  if (!segment) return [];
  const links = [...segment.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((m) => clean(m[1])).filter(Boolean);
  if (links.length) return unique(links);
  const text = clean(segment);
  return text ? [text] : [];
}

/** 清掉豆瓣可能带上的页面后缀 */
function cleanTitle(raw) {
  return clean(raw)
    .replace(/\s*[-–—]\s*图书\s*$/g, '')
    .replace(/\s*[-–—]\s*豆瓣(读书|阅读)?\s*$/g, '')
    .replace(/\s*[（(]豆瓣[)）]\s*$/g, '')
    .trim();
}

/** 判断一个候选 URL 是否真的是封面图（豆瓣无封面时会指向 update_image 页面/默认占位图） */
function isUsableCover(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (/update_image|book-default|default-lpic|\/pics\/|no_cover|white\.gif/i.test(u)) return false;
  if (/book\.douban\.com\/subject\//i.test(u)) return false;
  return true;
}

function pickCover(html) {
  const mainpic = (html.match(/<div id="mainpic">([\s\S]*?)<\/div>/) || [])[1] || '';
  const candidates = [];
  const big = mainpic.match(/<a class="nbg"\s+href="([^"]+)"/);
  if (big) candidates.push(big[1]);
  const img = mainpic.match(/<img[^>]+src="([^"]+)"/);
  if (img) candidates.push(img[1]);
  for (const url of candidates) if (isUsableCover(url)) return url;
  return '';
}

/** 豆瓣的 <meta name="description"> 多为"XX 介绍、书评、论坛及推荐"这类 SEO 文案，不是内容简介 */
function metaDescriptionIsUseful(text) {
  const t = String(text || '');
  if (t.length < 60) return false;
  if (/介绍、书评、论坛及推荐|暂无简介|还没有简介|图书[\s\S]{0,40}介绍/.test(t)) return false;
  return true;
}

/** 判断解析结果是否像一条真实的书目（防止把反爬/异常页面当成书） */
function looksValid(record) {
  if (!record || !record.title) return false;
  const t = record.title;
  if (t.length < 1 || t.length > 80) return false;
  if (/图书\s*$|豆瓣|登录|异常|验证/.test(t)) return false;
  const infoScore = (record.authors || []).length + (record.publisher ? 1 : 0) + (record.isbn ? 1 : 0) + (record.pages ? 1 : 0);
  return infoScore >= 1;
}

function parseSubject(html, url) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1] : '';
  };

  const subjectId = (String(url).match(/subject\/(\d+)/) || [])[1] || '';
  const ogTitle = pick(/<meta property="og:title" content="([^"]*)"/);
  const title = cleanTitle(
    pick(/<span property="v:itemreviewed">([\s\S]*?)<\/span>/) ||
      pick(/<title>\s*([\s\S]*?)\s*[（(]豆瓣[)）]/) ||
      ogTitle ||
      ''
  );
  const subtitle = clean(pick(/<span property="v:subtitle">([\s\S]*?)<\/span>/));
  const cover = pickCover(html);

  const infoStart = html.indexOf('id="info"');
  const infoEnd = html.indexOf('interest_sectl', infoStart);
  const info = infoStart >= 0 ? html.slice(infoStart, infoEnd > infoStart ? infoEnd : infoStart + 9000) : '';
  const fieldOf = (label) => {
    const re = new RegExp(`<span class="pl">\\s*${label}\\s*[:：]?\\s*</span>\\s*[:：]?([\\s\\S]*?)<br`);
    const m = info.match(re);
    return m ? m[1] : '';
  };

  const rating = Number(pick(/property="v:average">\s*([\d.]+)\s*</)) || 0;
  const ratingCount = Number((pick(/property="v:votes">\s*([\d,]+)\s*</) || '').replace(/,/g, '')) || 0;

  const introAt = html.indexOf('内容简介');
  const introHtml = introAt >= 0 ? html.slice(introAt, introAt + 40000) : html;
  const introBlocks = [...introHtml.matchAll(/<div class="intro">([\s\S]*?)<\/div>/g)]
    .map((m) => cleanMultiline(m[1]))
    .filter(Boolean);
  const metaDesc = cleanMultiline(pick(/<meta name="description" content="([^"]*)"/));
  const summary = introBlocks[0] || (metaDescriptionIsUseful(metaDesc) ? metaDesc : '');
  const authorIntro = introBlocks[1] || '';

  const pages = Number((valuesOf(fieldOf('页数'))[0] || '').replace(/[^\d]/g, '')) || 0;

  return {
    source: 'douban',
    sourceLabel: '豆瓣读书',
    sourceUrl: url,
    sourceId: subjectId,
    title,
    subtitle,
    originalTitle: clean(valuesOf(fieldOf('原作名'))[0] || ''),
    authors: valuesOf(fieldOf('作者')),
    translators: valuesOf(fieldOf('译者')),
    publisher: clean(valuesOf(fieldOf('出版社'))[0] || ''),
    producer: clean(valuesOf(fieldOf('出品方'))[0] || ''),
    pubdate: clean(valuesOf(fieldOf('出版年'))[0] || ''),
    pages,
    price: clean(valuesOf(fieldOf('定价'))[0] || ''),
    binding: clean(valuesOf(fieldOf('装帧'))[0] || ''),
    isbn: clean(valuesOf(fieldOf('ISBN'))[0] || '').replace(/[^\dXx]/g, ''),
    series: clean(valuesOf(fieldOf('丛书'))[0] || ''),
    cover,
    summary,
    authorIntro,
    rating,
    ratingCount,
    ratingScale: 'douban',
    subjects: [],
  };
}

/** 按 ISBN 找书：/isbn/<isbn>/ 会 301 到书目页 */
async function byIsbn(isbn, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { html, url } = await request(`${BASE}/isbn/${encodeURIComponent(isbn)}/`, opts);
    if (!/subject\/\d+/.test(url)) {
      const err = new Error('豆瓣没有收录这个 ISBN');
      err.notFound = true;
      throw err;
    }
    const record = parseSubject(html, url);
    if (looksValid(record)) return record;
    lastErr = new Error('豆瓣页面结构异常（已重试）');
    lastErr.notFound = true;
  }
  throw lastErr || new Error('豆瓣页面解析失败');
}

async function bySubjectId(id, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { html, url } = await request(`${BASE}/subject/${id}/`, opts);
    const record = parseSubject(html, url);
    if (looksValid(record)) return record;
    lastErr = new Error('豆瓣页面结构异常（已重试）');
    lastErr.notFound = true;
  }
  throw lastErr || new Error('豆瓣页面解析失败');
}

/** 关键词联想（公开 JSON 接口），返回候选项，不抓详情页 */
async function suggest(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  const url = `${BASE}/j/subject_suggest?q=${encodeURIComponent(q)}`;
  let list;
  try {
    list = await schedule(() => fetchJson(url, { headers: HEADERS }, 8000));
  } catch (err) {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((it) => it && it.title && (it.type === 'b' || it.type === 'a' || it.url))
    .map((it) => ({
      source: 'douban',
      sourceLabel: '豆瓣',
      id: String(it.id || ''),
      type: it.type || '',
      title: clean(it.title || ''),
      author: clean(it.author_name || ''),
      year: clean(it.year || ''),
      cover: it.pic || '',
      url: it.url || (it.id && it.type === 'b' ? `${BASE}/subject/${it.id}/` : ''),
    }));
}

function mapWork(work) {
  const pic = work.pic || {};
  const rating = work.rating || {};
  const yearMatch = String(work.pubdate || '').match(/\d{4}/);
  return {
    source: 'douban',
    sourceLabel: '豆瓣',
    id: String(work.id || ''),
    title: clean(work.title || ''),
    author: (work.author || []).map((a) => clean(a)).filter(Boolean).join(' / '),
    year: yearMatch ? yearMatch[0] : '',
    pubdate: clean(work.pubdate || ''),
    publisher: (work.press || []).map((p) => clean(p)).filter(Boolean)[0] || '',
    cover: pic.large || pic.normal || work.cover_url || '',
    url: work.url || (work.id ? `${BASE}/subject/${work.id}/` : ''),
    rating: Number(rating.value) || 0,
    ratingCount: Number(rating.count) || 0,
    roles: Array.isArray(work.roles) ? work.roles.map((r) => clean(r)) : [],
    subtype: clean(work.subtype || ''),
  };
}

/** 某位作者/译者的作品列表（豆瓣移动版接口，带 total 可翻页） */
async function authorWorks(authorId, { start = 0, count = 60 } = {}) {
  const id = String(authorId || '').trim();
  if (!/^\d+$/.test(id)) return { total: 0, works: [] };
  const url = `https://m.douban.com/rexxar/api/v2/author/${id}/works?start=${start}&count=${count}`;
  let data;
  try {
    data = await scheduleRec(() =>
      fetchJson(
        url,
        { headers: { Referer: `https://m.douban.com/book/author/${id}/`, 'User-Agent': DESKTOP_UA, Accept: 'application/json' } },
        9000
      )
    );
  } catch (err) {
    return { total: 0, works: [] };
  }
  const works = Array.isArray(data && data.works) ? data.works.filter((w) => w && w.title).map(mapWork) : [];
  return { total: Number(data && data.total) || works.length, works };
}

/** 用名字找豆瓣上的作者实体（type=a） */
async function findAuthorEntity(name) {
  const list = await suggest(name).catch(() => []);
  const entities = list.filter((x) => x.type === 'a' && /^\d+$/.test(String(x.id || '')));
  if (!entities.length) return null;
  const exact = entities.find((x) => x.title === name);
  return exact || entities[0];
}

/** 按书名/关键词查：先联想，再抓最匹配的一条详情 */
async function byTitle(title, opts = {}) {
  const candidates = await suggest(title);
  if (!candidates.length) {
    const err = new Error('豆瓣没有找到这个词条');
    err.notFound = true;
    throw err;
  }
  const ranked = candidates
    .map((c) => ({ c, score: similarity(c.title, title) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best.score < 0.5 && !opts.allowLoose) {
    const err = new Error('豆瓣没有明显匹配的书名');
    err.notFound = true;
    err.candidates = candidates.slice(0, 5);
    throw err;
  }
  const record = await bySubjectId(best.c.id, opts);
  record.subjects = [];
  return record;
}

/** 移动版 rexxar 接口是另一个服务（m.douban.com），单独用更宽松的限速，避免和书目页请求互相排队 */
let recChain = Promise.resolve();
let recLastAt = 0;
const REC_MIN_INTERVAL = 300;

function scheduleRec(task) {
  const run = async () => {
    const wait = Math.max(0, REC_MIN_INTERVAL - (Date.now() - recLastAt));
    if (wait) await sleep(wait);
    recLastAt = Date.now();
    return task();
  };
  const p = recChain.then(run, run);
  recChain = p.then(() => {}, () => {});
  return p;
}

/** 豆瓣"喜欢这本书的人也喜欢"（移动版公开接口，最贴近"读者也喜欢"的信号） */
async function recommendations(subjectId, { count = 12 } = {}) {
  const id = String(subjectId || '').trim();
  if (!/^\d+$/.test(id)) return [];
  const url = `https://m.douban.com/rexxar/api/v2/book/${id}/recommendations?start=0&count=${count}`;
  let list;
  try {
    list = await scheduleRec(() =>
      fetchJson(
        url,
        {
          headers: {
            Referer: `https://m.douban.com/book/subject/${id}/`,
            'User-Agent': DESKTOP_UA,
            Accept: 'application/json',
          },
        },
        8000
      )
    );
  } catch (err) {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && item.title)
    .map((item) => {
      // card_subtitle 形如 "刘慈欣 / 2010 / 重庆出版社"
      const parts = String(item.card_subtitle || '')
        .split('/')
        .map((s) => clean(s))
        .filter(Boolean);
      const rating = item.rating || {};
      return {
        source: 'douban',
        sourceLabel: '豆瓣',
        id: String(item.id || ''),
        title: clean(item.title || ''),
        author: parts[0] || '',
        year: parts[1] || '',
        publisher: parts[2] || '',
        cover: (item.pic && (item.pic.large || item.pic.normal)) || '',
        url: item.url || '',
        rating: Number(rating.value) || 0,
        ratingCount: Number(rating.count) || 0,
      };
    });
}

module.exports = {
  byIsbn,
  byTitle,
  bySubjectId,
  suggest,
  recommendations,
  authorWorks,
  findAuthorEntity,
  parseSubject,
  looksValid,
  name: 'douban',
};
