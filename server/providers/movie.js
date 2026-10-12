'use strict';

/* 影片数据源（多源合并）
 *   豆瓣电影   ：搜索联想 + 移动版 rexxar 详情 + "喜欢这部电影的人也喜欢"（中文片主力，无需 key）
 *   TMDb      ：官方 API，需在「设置」里填 API Key（海外片更全，含 recommendations/similar）
 *   IMDb      ：官方联想接口（无需 key，只有标题/年份/海报/主演），配合 OMDb Key 可补全剧情与评分
 *
 * 统一输出：{ source, sourceId, title, year, poster, summary, rating, ..., recommendations[] }
 */

const { fetchWithTimeout, fetchJson, clean, cleanMultiline, unique, similarity, sleep, DESKTOP_UA } = require('../util');

// BASE 可用环境变量覆盖，仅用于本地调试（把豆瓣请求指向一个回显服务来验证请求头）
const BASE = process.env.BOOKNEST_DOUBAN_BASE || 'https://movie.douban.com';
const HEADERS = { Referer: `${BASE}/`, 'User-Agent': DESKTOP_UA };
const MIN_INTERVAL_MS = 1100;

/* 豆瓣对机房/高频 IP 会软封禁电影搜索（返回空数组或 403 need_login），
 * 报错原文就是"请登录再试"。所以在设置里支持填自己的豆瓣 Cookie，
 * 带上登录态后 suggest / rexxar 搜索都能恢复。 */
let doubanCookie = '';
function setDoubanCookie(v) {
  doubanCookie = String(v || '').trim();
}
function headersFor(extra = {}) {
  const h = { ...HEADERS, ...extra };
  if (doubanCookie) h.Cookie = doubanCookie;
  return h;
}

let chain = Promise.resolve();
let lastAt = 0;

/** 豆瓣接口限速：所有豆瓣电影请求排队，间隔不小于 1.1 秒 */
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

/* ---------------- 豆瓣 ---------------- */

function splitCardSubtitle(text) {
  // 形如 "2017 / 中国大陆 / 剧情 历史 战争 / 冯小刚 / 黄轩 苗苗"
  const parts = String(text || '')
    .split('/')
    .map((s) => clean(s));
  return {
    year: parts[0] || '',
    countries: parts[1] ? parts[1].split(/\s+/) : [],
    genres: parts[2] ? parts[2].split(/\s+/) : [],
    directors: parts[3] ? [parts[3]] : [],
    actors: parts[4] ? parts[4].split(/\s+/) : [],
  };
}

/* 豆瓣电影搜索接口会因"异常请求"对 IP 软封禁：返回 HTTP 200 但内容恒为 []。
 * 这里做熔断：连续空结果就暂停一段时间，避免越打越封。 */
const DOUBAN_BLOCK = { until: 0, emptyStreak: 0, reason: '' };

function doubanBlocked() {
  return Date.now() < DOUBAN_BLOCK.until;
}

function noteDoubanEmpty() {
  DOUBAN_BLOCK.emptyStreak += 1;
  if (DOUBAN_BLOCK.emptyStreak >= 2) {
    DOUBAN_BLOCK.until = Date.now() + 10 * 60 * 1000; // 退避 10 分钟
    DOUBAN_BLOCK.reason = '豆瓣电影搜索接口返回空（IP 被限流，稍后自动重试）';
  }
}

function noteDoubanOk() {
  DOUBAN_BLOCK.emptyStreak = 0;
  DOUBAN_BLOCK.until = 0;
  DOUBAN_BLOCK.reason = '';
}

async function searchDouban(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  if (doubanBlocked()) return [];
  // 有登录 Cookie 时，先走更可靠的 rexxar 搜索
  if (doubanCookie) {
    const viaRexxar = await searchDoubanRexxar(q).catch(() => []);
    if (viaRexxar.length) {
      noteDoubanOk();
      return viaRexxar;
    }
  }
  const url = `${BASE}/j/subject_suggest?q=${encodeURIComponent(q)}`;
  let list;
  try {
    list = await schedule(() => fetchJson(url, { headers: headersFor() }, 8000));
  } catch (err) {
    return [];
  }
  if (!Array.isArray(list)) return [];
  if (!list.length) {
    noteDoubanEmpty();
    return [];
  }
  noteDoubanOk();
  return list
    .filter((it) => it && it.title && it.id)
    .map((it) => ({
      source: 'douban',
      sourceLabel: '豆瓣',
      sourceId: String(it.id),
      title: clean(it.title),
      subtitle: clean(it.sub_title || ''),
      year: clean(it.year || ''),
      poster: it.img || '',
      type: it.type === 'tv' ? 'tv' : 'movie',
      url: `https://movie.douban.com/subject/${it.id}/`,
      rating: 0,
      ratingCount: 0,
    }));
}

/** 从 rexxar 搜索响应里容错提取条目（结构随版本变化，按"有 title 且有 id"判断） */
function extractSearchItems(data) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || depth > 4 || out.length > 40) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const id = node.id || node.target_id;
    if (node.title && id && !seen.has(String(id))) {
      seen.add(String(id));
      out.push(node);
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(data && (data.subjects || data.smart_box || data), 0);
  return out;
}

/** 豆瓣电影搜索（rexxar，需要登录态时最稳） */
async function searchDoubanRexxar(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  const url = `https://m.douban.com/rexxar/api/v2/search?q=${encodeURIComponent(q)}&type=movie&start=0&count=20`;
  let data;
  try {
    data = await schedule(() => fetchJson(url, { headers: headersFor({ Referer: 'https://m.douban.com/search/' }) }, 9000));
  } catch (err) {
    return [];
  }
  return extractSearchItems(data)
    .filter((it) => it.title && (it.id || it.target_id))
    .slice(0, 12)
    .map((it) => ({
      source: 'douban',
      sourceLabel: '豆瓣',
      sourceId: String(it.id || it.target_id),
      title: clean(it.title),
      subtitle: clean(it.card_subtitle || ''),
      year: clean(String(it.year || (String(it.card_subtitle || '').match(/(19|20)\d{2}/) || [''])[0] || '')),
      poster: (it.pic && (it.pic.large || it.pic.normal)) || it.cover_url || '',
      type: it.type === 'tv' ? 'tv' : 'movie',
      url: `https://movie.douban.com/subject/${it.id || it.target_id}/`,
      rating: Number((it.rating && it.rating.value) || 0) || 0,
      ratingCount: Number((it.rating && it.rating.count) || 0) || 0,
    }));
}

async function doubanDetail(subjectId) {
  const id = String(subjectId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('豆瓣条目 id 无效');
  const url = `https://m.douban.com/rexxar/api/v2/movie/${id}`;
  const data = await schedule(() =>
    fetchJson(
      url,
      { headers: headersFor({ Referer: `https://m.douban.com/movie/subject/${id}/`, Accept: 'application/json' }) },
      9000
    )
  );
  if (!data || !data.title) throw new Error('豆瓣没有收录这个条目');
  const pic = data.pic || {};
  const rating = data.rating || {};
  return {
    source: 'douban',
    sourceLabel: '豆瓣',
    sourceId: id,
    sourceUrl: `https://movie.douban.com/subject/${id}/`,
    doubanId: id,
    imdbId: '',
    tmdbId: '',
    title: clean(data.title),
    originalTitle: clean(data.original_title || ''),
    year: clean(String(data.year || '')),
    type: String(data.type || 'movie') === 'tv' ? 'tv' : 'movie',
    directors: unique((data.directors || []).map((d) => clean(d.name))),
    writers: [],
    actors: unique((data.actors || []).map((a) => clean(a.name))).slice(0, 20),
    genres: unique((data.genres || []).map((g) => clean(g))),
    countries: unique((data.countries || []).map((c) => clean(c))),
    languages: unique((data.languages || []).map((l) => clean(l))),
    durations: unique((data.durations || []).map((d) => clean(d))),
    releaseDates: unique((data.pubdate || []).map((d) => clean(d))),
    aka: unique((data.aka || []).map((a) => clean(a))).slice(0, 8),
    poster: pic.large || pic.normal || data.cover_url || '',
    summary: cleanMultiline(data.intro || ''),
    rating: Number(rating.value) || 0,
    ratingCount: Number(rating.count) || 0,
    ratingLabel: rating.value ? '豆瓣评分' : '',
    ratings: rating.value ? { douban: { value: Number(rating.value) || 0, count: Number(rating.count) || 0 } } : {},
    episodes: Number(data.episodes_count) || 0,
  };
}

async function doubanRecommendations(subjectId, { count = 12 } = {}) {
  const id = String(subjectId || '').trim();
  if (!/^\d+$/.test(id)) return [];
  const url = `https://m.douban.com/rexxar/api/v2/movie/${id}/recommendations?start=0&count=${count}`;
  let list;
  try {
    list = await schedule(() =>
      fetchJson(
        url,
        { headers: headersFor({ Referer: `https://m.douban.com/movie/subject/${id}/`, Accept: 'application/json' }) },
        9000
      )
    );
  } catch (err) {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((it) => it && it.title && it.id)
    .map((it) => {
      const meta = splitCardSubtitle(it.card_subtitle);
      const rating = it.rating || {};
      return {
        source: 'douban',
        sourceLabel: '豆瓣',
        sourceId: String(it.id),
        title: clean(it.title),
        year: meta.year,
        genres: meta.genres,
        countries: meta.countries,
        directors: meta.directors,
        actors: meta.actors,
        poster: (it.pic && (it.pic.large || it.pic.normal)) || '',
        rating: Number(rating.value) || 0,
        ratingCount: Number(rating.count) || 0,
        reason: '看过这部的人也喜欢',
      };
    });
}

/* ---------------- IMDb（官方联想接口，无需 key） ---------------- */

async function searchImdb(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  const url = `https://v2.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`;
  let data;
  try {
    data = await fetchJson(url, { headers: { 'User-Agent': DESKTOP_UA } }, 7000);
  } catch (err) {
    return [];
  }
  const list = Array.isArray(data && data.d) ? data.d : [];
  return list
    .filter((it) => it && it.id && it.l && /^(movie|tv|feature|tvSeries|video|short)$/i.test(String(it.qid || it.q || '')))
    .slice(0, 12)
    .map((it) => ({
      source: 'imdb',
      sourceLabel: 'IMDb',
      sourceId: String(it.id),
      title: clean(it.l),
      subtitle: '',
      year: it.y ? String(it.y) : '',
      poster: (it.i && it.i.imageUrl) || '',
      type: /series/i.test(String(it.qid || '')) ? 'tv' : 'movie',
      url: `https://www.imdb.com/title/${it.id}/`,
      actors: it.s ? String(it.s).split(',').map((s) => clean(s)) : [],
      rating: 0,
      ratingCount: 0,
    }));
}

/** OMDb（用 IMDb id 取详情，需要免费 key） */
async function omdbDetail(imdbId, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}&i=${encodeURIComponent(imdbId)}&plot=full&r=json`;
  const data = await fetchJson(url, {}, 8000);
  if (!data || data.Response === 'False') return null;
  return {
    source: 'imdb',
    sourceLabel: 'IMDb',
    sourceId: imdbId,
    sourceUrl: `https://www.imdb.com/title/${imdbId}/`,
    imdbId,
    doubanId: '',
    tmdbId: '',
    title: clean(data.Title || ''),
    originalTitle: '',
    year: clean(String(data.Year || '')).slice(0, 4),
    type: /series/i.test(String(data.Type || '')) ? 'tv' : 'movie',
    directors: data.Director && data.Director !== 'N/A' ? data.Director.split(',').map((s) => clean(s)) : [],
    writers: data.Writer && data.Writer !== 'N/A' ? data.Writer.split(',').map((s) => clean(s)) : [],
    actors: data.Actors && data.Actors !== 'N/A' ? data.Actors.split(',').map((s) => clean(s)) : [],
    genres: data.Genre && data.Genre !== 'N/A' ? data.Genre.split(',').map((s) => clean(s)) : [],
    countries: data.Country && data.Country !== 'N/A' ? data.Country.split(',').map((s) => clean(s)) : [],
    languages: data.Language && data.Language !== 'N/A' ? data.Language.split(',').map((s) => clean(s)) : [],
    durations: data.Runtime && data.Runtime !== 'N/A' ? [clean(data.Runtime)] : [],
    releaseDates: data.Released && data.Released !== 'N/A' ? [clean(data.Released)] : [],
    aka: [],
    poster: data.Poster && data.Poster !== 'N/A' ? data.Poster : '',
    summary: cleanMultiline(data.Plot && data.Plot !== 'N/A' ? data.Plot : ''),
    rating: Number(data.imdbRating) || 0,
    ratingCount: Number(String(data.imdbVotes || '').replace(/,/g, '')) || 0,
    ratingLabel: data.imdbRating && data.imdbRating !== 'N/A' ? 'IMDb 评分' : '',
    ratings: Number(data.imdbRating)
      ? { imdb: { value: Number(data.imdbRating) || 0, count: Number(String(data.imdbVotes || '').replace(/,/g, '')) || 0 } }
      : {},
  };
}

/* ---------------- TMDb（官方 API，需要 key） ---------------- */

const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMG_ORIG = 'https://image.tmdb.org/t/p/original';

function tmdbLang() {
  return String(process.env.BOOKNEST_TMDB_LANG || 'zh-CN');
}

async function tmdbGet(path, apiKey, params = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('未配置 TMDb API Key');
  const qs = new URLSearchParams({ api_key: key, language: tmdbLang(), ...params });
  const url = `https://api.themoviedb.org/3${path}?${qs.toString()}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 8000);
  if (res.status === 401) throw new Error('TMDb API Key 无效');
  if (res.status === 429) throw new Error('TMDb 请求过于频繁，稍后再试');
  if (!res.ok) throw new Error(`TMDb 返回 ${res.status}`);
  return res.json();
}

async function searchTmdb(keyword, apiKey) {
  const data = await tmdbGet('/search/multi', apiKey, { query: String(keyword || '') });
  return (data.results || [])
    .filter((it) => it && (it.media_type === 'movie' || it.media_type === 'tv') && it.title !== undefined || it.name !== undefined)
    .slice(0, 12)
    .map((it) => ({
      source: 'tmdb',
      sourceLabel: 'TMDb',
      sourceId: `${it.media_type}/${it.id}`,
      title: clean(it.title || it.name || ''),
      subtitle: '',
      year: String(it.release_date || it.first_air_date || '').slice(0, 4),
      poster: it.poster_path ? TMDB_IMG + it.poster_path : '',
      type: it.media_type === 'tv' ? 'tv' : 'movie',
      url: `https://www.themoviedb.org/${it.media_type}/${it.id}`,
      rating: it.vote_average ? Math.round(it.vote_average * 10) / 10 : 0,
      ratingCount: it.vote_count || 0,
    }));
}

function fromTmdbDetail(data, mediaType) {
  const isTv = mediaType === 'tv' || !!data.first_air_date;
  const crew = (data.credits && data.credits.crew) || [];
  const cast = (data.credits && data.credits.cast) || [];
  const prodCountries = unique((data.production_countries || []).map((c) => clean(c.name)));
  const imdbId = String(data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || '');
  return {
    source: 'tmdb',
    sourceLabel: 'TMDb',
    sourceId: `${isTv ? 'tv' : 'movie'}/${data.id}`,
    sourceUrl: `https://www.themoviedb.org/${isTv ? 'tv' : 'movie'}/${data.id}`,
    tmdbId: String(data.id),
    imdbId,
    doubanId: '',
    title: clean(data.title || data.name || ''),
    originalTitle: clean(data.original_title || data.original_name || ''),
    year: String(data.release_date || data.first_air_date || '').slice(0, 4),
    type: isTv ? 'tv' : 'movie',
    directors: unique(
      crew.filter((c) => c.job === 'Director' || (isTv && /Creator|Director/.test(c.job || ''))).map((c) => clean(c.name))
    ).slice(0, 4),
    writers: unique(
      crew.filter((c) => /Writer|Screenplay|Story|Creator/i.test(c.job || '')).map((c) => clean(c.name))
    ).slice(0, 6),
    actors: unique(cast.map((c) => clean(c.name))).slice(0, 20),
    genres: unique((data.genres || []).map((g) => clean(g.name))),
    // 有制片国家就用全称，否则退回 ISO 国家码，避免「美国 / US」这种重复
    countries: prodCountries.length ? prodCountries : unique((data.origin_country || []).map((c) => clean(c))),
    languages: unique((data.spoken_languages || []).map((l) => clean(l.name))),
    durations: data.runtime ? [`${data.runtime}分钟`] : isTv && data.episode_run_time && data.episode_run_time[0] ? [`${data.episode_run_time[0]}分钟`] : [],
    releaseDates: [data.release_date || data.first_air_date || ''].filter(Boolean),
    aka: unique((data.alternative_titles && data.alternative_titles.titles) || []),
    poster: data.poster_path ? TMDB_IMG_ORIG + data.poster_path : '',
    summary: cleanMultiline(data.overview || ''),
    rating: data.vote_average ? Math.round(data.vote_average * 10) / 10 : 0,
    ratingCount: data.vote_count || 0,
    ratingLabel: data.vote_average ? 'TMDb 评分' : '',
    ratings: data.vote_average
      ? { tmdb: { value: Math.round(data.vote_average * 10) / 10, count: data.vote_count || 0 } }
      : {},
    episodes: isTv ? Number(data.number_of_episodes) || 0 : 0,
  };
}

async function tmdbDetail(sourceId, apiKey) {
  const [mediaType, id] = String(sourceId || '').split('/');
  if (!/^\d+$/.test(String(id || ''))) throw new Error('TMDb id 无效');
  const data = await tmdbGet(`/${mediaType === 'tv' ? 'tv' : 'movie'}/${id}`, apiKey, {
    append_to_response: 'credits,recommendations,similar,external_ids',
  });
  const record = fromTmdbDetail(data, mediaType);
  // TMDb 提供两路"相似"信号，分别标注来源，便于和豆瓣的推荐交叉比对
  const recs = ((data.recommendations && data.recommendations.results) || []).map((it) => ({ it, reason: 'TMDb 推荐' }));
  const sims = ((data.similar && data.similar.results) || []).map((it) => ({ it, reason: 'TMDb 相似' }));
  record.recommendations = [...recs, ...sims].slice(0, 24).map(({ it, reason }) => ({
    source: 'tmdb',
    sourceLabel: 'TMDb',
    sourceId: `${mediaType === 'tv' ? 'tv' : 'movie'}/${it.id}`,
    tmdbId: String(it.id),
    title: clean(it.title || it.name || ''),
    year: String(it.release_date || it.first_air_date || '').slice(0, 4),
    genres: [],
    poster: it.poster_path ? TMDB_IMG + it.poster_path : '',
    rating: it.vote_average ? Math.round(it.vote_average * 10) / 10 : 0,
    ratingCount: it.vote_count || 0,
    reason,
  }));
  return record;
}

/* ---------------- 多源合并（豆瓣 > IMDb > TMDb） ---------------- */

const SOURCE_RANK = { douban: 0, imdb: 1, tmdb: 2 };
const isLatin = (s) => /^[\x00-\x7F\s]+$/.test(String(s || '')) && /[A-Za-z]{3}/.test(String(s || ''));

function nonEmpty(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return !!(v && String(v).trim());
}

/**
 * 合并同一部影片的多个来源记录：
 *   列表类字段（导演/主演/类型/国家/时长/年份…）按 豆瓣 > IMDb > TMDb 取第一个非空；
 *   编剧/别名等信息按同样顺序做并集（豆瓣通常没有编剧，靠 IMDb/TMDb 补）；
 *   评分按来源分别保留；id 全部保留。
 */
function mergeRecords(records) {
  const list = (records || []).filter(Boolean).slice().sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9));
  if (!list.length) return null;
  const primary = list[0];

  const prefer = (field, fallback = '') => {
    for (const r of list) if (nonEmpty(r[field])) return r[field];
    return fallback;
  };
  const union = (field) => {
    const out = [];
    for (const r of list) for (const v of r[field] || []) if (v && !out.includes(v)) out.push(v);
    return out;
  };

  const ids = {};
  for (const r of list) {
    if (r.doubanId) ids.doubanId = r.doubanId;
    if (r.imdbId) ids.imdbId = r.imdbId;
    if (r.tmdbId) ids.tmdbId = r.tmdbId;
    if (r.source === 'douban' && r.sourceId && !ids.doubanId) ids.doubanId = r.sourceId;
    if (r.source === 'imdb' && r.sourceId && !ids.imdbId) ids.imdbId = r.sourceId;
    if (r.source === 'tmdb' && r.sourceId && !ids.tmdbId) ids.tmdbId = String(r.sourceId).split('/').pop();
  }

  const ratings = {};
  for (const r of list) for (const [k, v] of Object.entries(r.ratings || {})) if (v && v.value) ratings[k] = v;

  const merged = {
    source: primary.source,
    sourceLabel: primary.sourceLabel,
    sourceId: primary.sourceId,
    ...ids,
    title: prefer('title'),
    originalTitle: prefer('originalTitle'),
    year: prefer('year'),
    type: list.some((r) => r.type === 'tv') && primary.type === 'tv' ? 'tv' : primary.type || prefer('type') || 'movie',
    directors: union('directors'),
    writers: union('writers'),
    actors: prefer('actors', []).slice(0, 20),
    genres: prefer('genres', []),
    countries: prefer('countries', []),
    languages: prefer('languages', []),
    durations: prefer('durations', []),
    releaseDates: prefer('releaseDates', []),
    aka: union('aka').slice(0, 10),
    poster: prefer('poster'),
    summary: prefer('summary'),
    rating: 0,
    ratingCount: 0,
    ratingLabel: '',
    ratings,
    episodes: Number(prefer('episodes', 0)) || 0,
  };

  // 主评分：按 豆瓣 > IMDb > TMDb 选第一个有分的
  for (const key of ['douban', 'imdb', 'tmdb']) {
    const r = ratings[key];
    if (r && r.value) {
      merged.rating = r.value;
      merged.ratingCount = r.count || 0;
      merged.ratingLabel = key === 'douban' ? '豆瓣评分' : key === 'imdb' ? 'IMDb 评分' : 'TMDb 评分';
      break;
    }
  }

  merged.sourceUrls = {};
  if (ids.doubanId) merged.sourceUrls.douban = `https://movie.douban.com/subject/${ids.doubanId}/`;
  if (ids.imdbId) merged.sourceUrls.imdb = `https://www.imdb.com/title/${ids.imdbId}/`;
  if (ids.tmdbId) merged.sourceUrls.tmdb = `https://www.themoviedb.org/${merged.type === 'tv' ? 'tv' : 'movie'}/${ids.tmdbId}`;
  merged.sourceUrl = merged.sourceUrls[primary.source] || Object.values(merged.sourceUrls)[0] || '';
  merged.mergedFrom = list.map((r) => r.sourceLabel || r.source);
  return merged;
}

/** 合并三个来源的推荐：按「被几个来源共同推荐」再按评分排序 */
function mergeRecommendations(groups) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_:：·,，.。()（）\[\]【】《》!！?？'"’“”]/g, '');
  const map = new Map();
  for (const { source, label, items } of groups) {
    for (const it of items || []) {
      if (!it || !it.title) continue;
      const key = it.imdbId ? `tt:${it.imdbId}` : `${norm(it.title)}|${it.year || ''}`;
      const hit = map.get(key);
      if (hit) {
        if (!hit.sources.includes(label)) hit.sources.push(label);
        if (!hit.poster && it.poster) hit.poster = it.poster;
        if (!hit.rating && it.rating) hit.rating = it.rating;
        if (!hit.year && it.year) hit.year = it.year;
        if (!hit.reason) hit.reason = it.reason || '';
        hit.imdbId = hit.imdbId || it.imdbId || '';
        hit.tmdbId = hit.tmdbId || it.tmdbId || '';
        hit.doubanId = hit.doubanId || (it.source === 'douban' ? it.sourceId : '') || '';
        if (it.source === 'douban' && it.sourceId) hit.sourceId = it.sourceId;
      } else {
        map.set(key, {
          ...it,
          sources: [label],
          imdbId: it.imdbId || (/^tt\d+$/.test(it.sourceId || '') ? it.sourceId : ''),
          tmdbId: it.source === 'tmdb' ? String(it.sourceId || '').split('/').pop() : it.tmdbId || '',
          doubanId: it.source === 'douban' ? it.sourceId : it.doubanId || '',
        });
      }
    }
  }
  // 排序：多源共同推荐 > 来源权重（豆瓣更可信）> 评分 > 评价人数（避免「1 票 10 分」的冷门片霸榜）
  const SOURCE_WEIGHT = { 豆瓣: 2, 'TMDb 推荐': 1, 'TMDb 相似': 1 };
  return [...map.values()]
    .map((c) => {
      const w = Math.max(...c.sources.map((s) => SOURCE_WEIGHT[s] || 1));
      const popularity = Math.min(1, Math.log10((c.ratingCount || 0) + 1) / 6);
      return {
        ...c,
        agree: c.sources.length,
        score: Math.round((c.sources.length * 4 + w + (c.rating || 0) * 0.5 + popularity * 2) * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);
}

/* ---------------- 用别名反查 IMDb id（豆瓣 API 不提供） ---------------- */

async function resolveImdbId({ title, originalTitle, aka, year }) {
  const words = [originalTitle, ...(aka || []).filter(isLatin), isLatin(title) ? title : ''].filter(Boolean);
  const queries = [];
  for (const w of words) {
    const t = String(w).trim();
    if (t.length >= 3 && !queries.includes(t)) queries.push(t);
    if (queries.length >= 2) break;
  }
  for (const q of queries) {
    const list = await searchImdb(q).catch(() => []);
    const hit = list.find(
      (x) => /^tt\d+$/.test(x.sourceId) && (!year || !x.year || x.year === year) && similarity(x.title, q) >= 0.55
    );
    if (hit) return hit.sourceId;
  }
  return '';
}

async function tmdbFindByImdb(imdbId, apiKey) {
  const data = await tmdbGet(`/find/${imdbId}`, apiKey, { external_source: 'imdb_id' });
  const movie = (data.movie_results || [])[0];
  const tv = (data.tv_results || [])[0];
  if (movie) return tmdbDetail(`movie/${movie.id}`, apiKey);
  if (tv) return tmdbDetail(`tv/${tv.id}`, apiKey);
  return null;
}

/** 主来源不是豆瓣时，用片名去豆瓣找条目（限速，可能较慢） */
async function doubanByTitle(title, year) {
  const list = await searchDouban(title).catch(() => []);
  const hit = list.find((x) => similarity(x.title, title) >= 0.75 && (!year || !x.year || x.year === year)) || list[0];
  if (!hit || similarity(hit.title, title) < 0.5) return null;
  try {
    return await doubanDetail(hit.sourceId);
  } catch (err) {
    return null;
  }
}

/** 给 promise 加超时，超时返回 null（不阻塞整体合并） */
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * 已入库影片的"相似与推荐"：合并 豆瓣「看过这部的人也喜欢」+ TMDb 推荐 + TMDb 相似
 * @param {object} record 已保存的影片记录（含 doubanId / imdbId / tmdbId / type）
 */
async function related(record, { tmdbKey } = {}) {
  const groups = [];
  const doubanId = record.doubanId || (record.source === 'douban' ? record.sourceId : '');
  if (doubanId) {
    const recs = await withTimeout(doubanRecommendations(doubanId, { count: 12 }), 12000);
    if (recs && recs.length) groups.push({ source: 'douban', label: '豆瓣', items: recs });
  }
  if (tmdbKey) {
    let tmdbRecord = null;
    const tmdbId = record.tmdbId || (record.source === 'tmdb' ? String(record.sourceId || '').split('/').pop() : '');
    try {
      if (tmdbId) tmdbRecord = await tmdbDetail(`${record.type === 'tv' ? 'tv' : 'movie'}/${tmdbId}`, tmdbKey);
      else if (record.imdbId) tmdbRecord = await tmdbFindByImdb(record.imdbId, tmdbKey);
    } catch (err) {
      tmdbRecord = null;
    }
    if (tmdbRecord && tmdbRecord.recommendations && tmdbRecord.recommendations.length) {
      const byReason = new Map();
      for (const it of tmdbRecord.recommendations) {
        const key = it.reason || 'TMDb 推荐';
        if (!byReason.has(key)) byReason.set(key, []);
        byReason.get(key).push(it);
      }
      for (const [label, items] of byReason.entries()) groups.push({ source: 'tmdb', label, items });
    }
  }
  return {
    candidates: mergeRecommendations(groups),
    groups: groups.map((g) => ({ label: g.label, count: g.items.length })),
  };
}

/* ---------------- 搜索与详情聚合 ---------------- */

/** 多源搜索：豆瓣 + IMDb（+ TMDb 若配置了 key） */
async function search(keyword, opts = {}) {
  const q = String(keyword || '').trim();
  if (!q) return { results: [], sources: [], sourceStatus: [] };
  const errors = { douban: '', imdb: '', tmdb: '' };
  const tasks = [
    searchDouban(q).catch((e) => {
      errors.douban = e.message || '请求失败';
      return [];
    }),
    searchImdb(q).catch((e) => {
      errors.imdb = e.message || '请求失败';
      return [];
    }),
  ];
  if (opts.tmdbKey) {
    tasks.push(
      searchTmdb(q, opts.tmdbKey).catch((e) => {
        errors.tmdb = e.message || '请求失败';
        return [];
      })
    );
  }
  const [db, imdb, tmdb] = await Promise.all(tasks.map((p) => Promise.resolve(p).catch(() => [])));
  const sources = [];
  if (db.length) sources.push('豆瓣');
  if (imdb.length) sources.push('IMDb');
  if (tmdb && tmdb.length) sources.push('TMDb');

  // 来源状态：让前端能说明"为什么少了某个来源"，而不是静默丢弃
  const sourceStatus = [
    {
      key: 'douban',
      label: '豆瓣电影',
      ok: db.length > 0,
      count: db.length,
      error: db.length ? '' : errors.douban || DOUBAN_BLOCK.reason || '没有匹配结果',
    },
    { key: 'imdb', label: 'IMDb', ok: imdb.length > 0, count: imdb.length, error: imdb.length ? '' : errors.imdb || '没有匹配结果' },
  ];
  if (opts.tmdbKey) {
    sourceStatus.push({
      key: 'tmdb',
      label: 'TMDb',
      ok: !!(tmdb && tmdb.length),
      count: (tmdb || []).length,
      error: tmdb && tmdb.length ? '' : errors.tmdb || '没有匹配结果',
    });
  } else {
    sourceStatus.push({ key: 'tmdb', label: 'TMDb', ok: false, count: 0, error: '未配置 TMDb API Key（设置页填写后可用）' });
  }

  // 合并：优先豆瓣（中文），同名同年的 IMDb/TMDb 结果去重
  const seen = new Set();
  const merged = [];
  for (const item of [...db, ...(tmdb || []), ...imdb]) {
    const key = `${String(item.title).toLowerCase()}|${item.year || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  merged.sort((a, b) => similarity(b.title, q) - similarity(a.title, q));
  return { results: merged.slice(0, 20), sources, sourceStatus };
}

/** 供 /api/movie-providers/check 使用：探测影片数据源可用性 */
async function checkSources({ tmdbKey } = {}) {
  const probes = [
    { key: 'douban', label: '豆瓣电影', run: () => searchDouban('盗梦空间') },
    { key: 'imdb', label: 'IMDb', run: () => searchImdb('inception') },
  ];
  if (tmdbKey) probes.push({ key: 'tmdb', label: 'TMDb', run: () => searchTmdb('inception', tmdbKey) });
  const out = [];
  for (const p of probes) {
    const t0 = Date.now();
    try {
      const list = await p.run();
      out.push({
        key: p.key,
        label: p.label,
        ok: !!(list && list.length),
        count: (list || []).length,
        ms: Date.now() - t0,
        error: list && list.length ? '' : p.key === 'douban' ? DOUBAN_BLOCK.reason || '接口返回空（可能被限流）' : '没有返回结果',
      });
    } catch (err) {
      out.push({ key: p.key, label: p.label, ok: false, count: 0, ms: Date.now() - t0, error: err.message || '请求失败' });
    }
  }
  if (!tmdbKey) out.push({ key: 'tmdb', label: 'TMDb', ok: false, count: 0, ms: 0, error: '未配置 TMDb API Key' });
  return out;
}

/**
 * 取影片详情（多源降级）
 * @param {{source?:string, sourceId?:string, title?:string, year?:string, tmdbKey?:string, omdbKey?:string}} query
 */
async function lookup(query) {
  const { source, sourceId, title, year, tmdbKey, omdbKey } = query;
  const sources = [];
  const collected = [];
  const note = (key, label, ok, error) => sources.push({ key, label, ok, error: error || '' });

  async function grab(key, label, fn) {
    try {
      const r = await fn();
      if (r) {
        note(key, label, true);
        return r;
      }
      note(key, label, false, '未取到数据');
    } catch (err) {
      note(key, label, false, err.message);
    }
    return null;
  }

  /* 1) 主来源：用户点的那一条（失败则用片名搜索兜底） */
  let primary = null;
  if (source === 'douban' && sourceId) primary = await grab('douban', '豆瓣', () => doubanDetail(sourceId));
  else if (source === 'tmdb' && sourceId && tmdbKey) primary = await grab('tmdb', 'TMDb', () => tmdbDetail(sourceId, tmdbKey));
  else if (source === 'imdb' && sourceId) {
    primary = await grab('imdb', 'IMDb', async () => {
      const full = await omdbDetail(sourceId, omdbKey);
      if (full) return full;
      const minimal = (await searchImdb(sourceId)).find((x) => x.sourceId === sourceId);
      return minimal ? { ...minimal, actors: minimal.actors || [], summary: '' } : null;
    });
  }

  if (!primary && title) {
    const { results } = await search(title, { tmdbKey });
    const scored = results
      .map((r) => ({ r, s: similarity(r.title, title) + (year && r.year === year ? 0.15 : 0) }))
      .sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (best && best.s >= 0.5) {
      if (best.r.source === 'douban') primary = await grab('douban', '豆瓣', () => doubanDetail(best.r.sourceId));
      else if (best.r.source === 'tmdb' && tmdbKey) primary = await grab('tmdb', 'TMDb', () => tmdbDetail(best.r.sourceId, tmdbKey));
      else {
        const full = await omdbDetail(best.r.sourceId, omdbKey);
        primary = full || best.r;
        note('imdb', 'IMDb', true);
      }
      if (!primary) primary = best.r;
    }
  }

  if (!primary) throw new Error('没有找到这部影片');
  collected.push(primary);

  /* 2) 补齐三方 id：豆瓣 API 不给 IMDb id，用别名去 IMDb 联想接口反查 */
  let imdbId = primary.imdbId || '';
  if (!imdbId) {
    imdbId = await withTimeout(
      resolveImdbId({ title: primary.title, originalTitle: primary.originalTitle, aka: primary.aka, year: primary.year }),
      8000
    );
    if (imdbId) primary.imdbId = imdbId;
  }
  const tmdbId = primary.tmdbId || (primary.source === 'tmdb' ? String(primary.sourceId).split('/').pop() : '');
  const doubanId = primary.doubanId || (primary.source === 'douban' ? primary.sourceId : '');

  /* 3) 并行补齐其它来源（各自超时，失败不影响主来源） */
  const tasks = [];
  if (primary.source !== 'tmdb' && tmdbKey) {
    tasks.push(
      grab('tmdb', 'TMDb', () =>
        tmdbId ? tmdbDetail(`${primary.type === 'tv' ? 'tv' : 'movie'}/${tmdbId}`, tmdbKey) : imdbId ? tmdbFindByImdb(imdbId, tmdbKey) : null
      ).then((r) => r && collected.push(r))
    );
  }
  if (primary.source !== 'imdb' && omdbKey && imdbId) {
    tasks.push(grab('imdb', 'IMDb', () => omdbDetail(imdbId, omdbKey)).then((r) => r && collected.push(r)));
  }
  if (primary.source !== 'douban' && primary.title) {
    tasks.push(
      withTimeout(doubanByTitle(primary.title, primary.year), 15000).then((r) => {
        if (r) {
          note('douban', '豆瓣', true);
          collected.push(r);
        } else {
          note('douban', '豆瓣', false, '豆瓣没有找到同名条目');
        }
      })
    );
  }
  await Promise.allSettled(tasks);

  /* 4) 合并基本信息（豆瓣 > IMDb > TMDb） */
  const merged = mergeRecords(collected);

  /* 5) 合并三方推荐 */
  const groups = [];
  const doubanRecord = collected.find((r) => r.source === 'douban');
  const tmdbRecord = collected.find((r) => r.source === 'tmdb');
  if (doubanRecord && doubanRecord.sourceId) {
    const recs = await withTimeout(doubanRecommendations(doubanRecord.sourceId, { count: 12 }), 12000);
    if (recs && recs.length) groups.push({ source: 'douban', label: '豆瓣', items: recs });
  }
  if (tmdbRecord && tmdbRecord.recommendations && tmdbRecord.recommendations.length) {
    // 拆成两路信号：TMDb 推荐 / TMDb 相似
    const byReason = new Map();
    for (const it of tmdbRecord.recommendations) {
      const key = it.reason || 'TMDb 推荐';
      if (!byReason.has(key)) byReason.set(key, []);
      byReason.get(key).push(it);
    }
    for (const [label, items] of byReason.entries()) groups.push({ source: 'tmdb', label, items });
  }
  const recommendations = mergeRecommendations(groups);
  if (!recommendations.length && merged.title) {
    const s = await withTimeout(search(merged.title, { tmdbKey }), 10000);
    const fallback = ((s && s.results) || []).map((r) => ({ ...r, reason: '相关影片' }));
    fallback.forEach((f) => {
      f.sources = [f.sourceLabel];
      f.agree = 1;
    });
    return { record: { ...merged, recommendations: fallback.slice(0, 12) }, sources };
  }

  return { record: { ...merged, recommendations }, sources };
}

module.exports = {
  search,
  lookup,
  checkSources,
  setDoubanCookie,
  searchDoubanRexxar,
  related,
  mergeRecords,
  mergeRecommendations,
  resolveImdbId,
  doubanByTitle,
  tmdbFindByImdb,
  searchDouban,
  searchImdb,
  searchTmdb,
  doubanDetail,
  doubanRecommendations,
  omdbDetail,
  tmdbDetail,
  splitCardSubtitle,
};
