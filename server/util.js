'use strict';

/* 通用工具：带超时的抓取、HTML 清洗、ID、CSV 等（零依赖） */

// 注意：不要放移动端 UA —— 豆瓣等站点会 302 到 m.* 手机版，页面结构完全不同
const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
const DESKTOP_UA = UAS[0];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];

class TimeoutError extends Error {}

async function fetchWithTimeout(url, options = {}, timeout = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      headers: {
        'User-Agent': pickUA(),
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/json,application/xhtml+xml,image/*,*/*;q=0.8',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new TimeoutError(`请求超时(${timeout}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}, timeout = 9000) {
  const res = await fetchWithTimeout(url, options, timeout);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchJson(url, options = {}, timeout = 9000) {
  const res = await fetchWithTimeout(url, options, timeout);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', middot: '·',
  mdash: '—', ndash: '–', times: '×', laquo: '«', raquo: '»', copy: '©', reg: '®',
  deg: '°', sup2: '²', sup3: '³', frac12: '½', bull: '•', dagger: '†', sect: '§',
};

function decodeEntities(str = '') {
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, ent) ? ENTITIES[ent] : m;
  });
}

function stripTags(str = '') {
  return String(str)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '');
}

/** 单行字段清洗 */
function clean(str = '') {
  return decodeEntities(stripTags(str))
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？；：、）】》”])/g, '$1')
    .replace(/([（【《“])\s+/g, '$1')
    .trim();
}

/** 多行文本（简介）清洗 */
function cleanMultiline(str = '') {
  return decodeEntities(stripTags(str))
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function uid(prefix = '') {
  seq = (seq + 1) % 100000;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36).padStart(3, '0')}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

const nowIso = () => new Date().toISOString();

function unique(arr) {
  const out = [];
  const seen = new Set();
  for (const item of arr || []) {
    const key = typeof item === 'string' ? item.trim() : JSON.stringify(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(typeof item === 'string' ? item.trim() : item);
  }
  return out;
}

function clampText(str, max = 4000) {
  const s = String(str == null ? '' : str);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function csvCell(value) {
  const s = Array.isArray(value) ? value.join(' / ') : value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(',')).join('\r\n');
  return `\uFEFF${head}\r\n${body}\r\n`;
}

/** 简单评分：字符串相似命中程度，用于在候选结果里挑最接近的 */
function similarity(a = '', b = '') {
  const norm = (s) => String(s).toLowerCase().replace(/[\s\-_:：·,，.。()（）\[\]【】]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const g of gx) if (gy.has(g)) hit += 1;
  return (2 * hit) / (gx.size + gy.size);
}

module.exports = {
  TimeoutError,
  DESKTOP_UA,
  fetchWithTimeout,
  fetchText,
  fetchJson,
  decodeEntities,
  stripTags,
  clean,
  cleanMultiline,
  sleep,
  uid,
  nowIso,
  unique,
  clampText,
  toCsv,
  similarity,
  pickUA,
};
