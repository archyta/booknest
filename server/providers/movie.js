'use strict';

/* 影片数据源（多源合并）
 *   豆瓣电影   ：搜索联想 + 移动版 rexxar 详情 + "喜欢这部电影的人也喜欢"（中文片主力，无需 key）
 *   TMDb      ：官方 API，需在「设置」里填 API Key（海外片更全，含 recommendations/similar）
 *   IMDb      ：官方联想接口（无需 key，只有标题/年份/海报/主演），配合 OMDb Key 可补全剧情与评分
 *
 * 统一输出：{ source, sourceId, title, year, poster, summary, rating, ..., recommendations[] }
 */

const { fetchWithTimeout, fetchJson, clean, cleanMultiline, unique, similarity, sleep, DESKTOP_UA } = require('../util');

const BASE = 'https://movie.douban.com';
const HEADERS = { Referer: `${BASE}/`, 'User-Agent': DESKTOP_UA };
const MIN_INTERVAL_MS = 1100;

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

async function searchDouban(keyword) {
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

async function doubanDetail(subjectId) {
  const id = String(subjectId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('豆瓣条目 id 无效');
  const url = `https://m.douban.com/rexxar/api/v2/movie/${id}`;
  const data = await schedule(() =>
    fetchJson(
      url,
      { headers: { Referer: `https://m.douban.com/movie/subject/${id}/`, 'User-Agent': DESKTOP_UA, Accept: 'application/json' } },
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
    title: clean(data.title),
    originalTitle: clean(data.original_title || ''),
    year: clean(String(data.year || '')),
    type: String(data.type || 'movie') === 'tv' ? 'tv' : 'movie',
    directors: unique((data.directors || []).map((d) => clean(d.name))),
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
        { headers: { Referer: `https://m.douban.com/movie/subject/${id}/`, 'User-Agent': DESKTOP_UA, Accept: 'application/json' } },
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
    title: clean(data.Title || ''),
    originalTitle: '',
    year: clean(String(data.Year || '')).slice(0, 4),
    type: /series/i.test(String(data.Type || '')) ? 'tv' : 'movie',
    directors: data.Director && data.Director !== 'N/A' ? data.Director.split(',').map((s) => clean(s)) : [],
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
  return {
    source: 'tmdb',
    sourceLabel: 'TMDb',
    sourceId: `${isTv ? 'tv' : 'movie'}/${data.id}`,
    sourceUrl: `https://www.themoviedb.org/${isTv ? 'tv' : 'movie'}/${data.id}`,
    title: clean(data.title || data.name || ''),
    originalTitle: clean(data.original_title || data.original_name || ''),
    year: String(data.release_date || data.first_air_date || '').slice(0, 4),
    type: isTv ? 'tv' : 'movie',
    directors: unique(
      crew.filter((c) => c.job === 'Director' || (isTv && /Creator|Director/.test(c.job || ''))).map((c) => clean(c.name))
    ).slice(0, 4),
    actors: unique(cast.map((c) => clean(c.name))).slice(0, 20),
    genres: unique((data.genres || []).map((g) => clean(g.name))),
    countries: unique(
      ((data.production_countries || []).map((c) => clean(c.name))).concat(
        (data.origin_country || []).map((c) => clean(c))
      )
    ),
    languages: unique((data.spoken_languages || []).map((l) => clean(l.name))),
    durations: data.runtime ? [`${data.runtime}分钟`] : isTv && data.episode_run_time && data.episode_run_time[0] ? [`${data.episode_run_time[0]}分钟`] : [],
    releaseDates: [data.release_date || data.first_air_date || ''].filter(Boolean),
    aka: unique((data.alternative_titles && data.alternative_titles.titles) || []).length
      ? []
      : [],
    poster: data.poster_path ? TMDB_IMG_ORIG + data.poster_path : '',
    summary: cleanMultiline(data.overview || ''),
    rating: data.vote_average ? Math.round(data.vote_average * 10) / 10 : 0,
    ratingCount: data.vote_count || 0,
    ratingLabel: data.vote_average ? 'TMDb 评分' : '',
    episodes: isTv ? Number(data.number_of_episodes) || 0 : 0,
  };
}

async function tmdbDetail(sourceId, apiKey) {
  const [mediaType, id] = String(sourceId || '').split('/');
  if (!/^\d+$/.test(String(id || ''))) throw new Error('TMDb id 无效');
  const data = await tmdbGet(`/${mediaType === 'tv' ? 'tv' : 'movie'}/${id}`, apiKey, {
    append_to_response: 'credits,recommendations,similar',
  });
  const record = fromTmdbDetail(data, mediaType);
  const recs = []
    .concat((data.recommendations && data.recommendations.results) || [])
    .concat((data.similar && data.similar.results) || []);
  record.recommendations = recs.slice(0, 12).map((it) => ({
    source: 'tmdb',
    sourceLabel: 'TMDb',
    sourceId: `${mediaType === 'tv' ? 'tv' : 'movie'}/${it.id}`,
    title: clean(it.title || it.name || ''),
    year: String(it.release_date || it.first_air_date || '').slice(0, 4),
    genres: [],
    poster: it.poster_path ? TMDB_IMG + it.poster_path : '',
    rating: it.vote_average ? Math.round(it.vote_average * 10) / 10 : 0,
    ratingCount: it.vote_count || 0,
    reason: 'TMDb 推荐',
  }));
  return record;
}

/* ---------------- 搜索与详情聚合 ---------------- */

/** 多源搜索：豆瓣 + IMDb（+ TMDb 若配置了 key） */
async function search(keyword, opts = {}) {
  const q = String(keyword || '').trim();
  if (!q) return { results: [], sources: [] };
  const tasks = [searchDouban(q), searchImdb(q)];
  if (opts.tmdbKey) tasks.push(searchTmdb(q, opts.tmdbKey).catch(() => []));
  const [db, imdb, tmdb] = await Promise.all(tasks.map((p) => Promise.resolve(p).catch(() => [])));
  const sources = [];
  if (db.length) sources.push('豆瓣');
  if (imdb.length) sources.push('IMDb');
  if (tmdb && tmdb.length) sources.push('TMDb');

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
  return { results: merged.slice(0, 20), sources };
}

/**
 * 取影片详情（多源降级）
 * @param {{source?:string, sourceId?:string, title?:string, year?:string, tmdbKey?:string, omdbKey?:string}} query
 */
async function lookup(query) {
  const { source, sourceId, title, year, tmdbKey, omdbKey } = query;
  const sources = [];
  let record = null;

  // 指定了源：直接取详情
  if (source === 'douban' && sourceId) {
    try {
      record = await doubanDetail(sourceId);
      sources.push({ key: 'douban', label: '豆瓣', ok: true });
    } catch (err) {
      sources.push({ key: 'douban', label: '豆瓣', ok: false, error: err.message });
    }
  } else if (source === 'tmdb' && sourceId && tmdbKey) {
    try {
      record = await tmdbDetail(sourceId, tmdbKey);
      sources.push({ key: 'tmdb', label: 'TMDb', ok: true });
    } catch (err) {
      sources.push({ key: 'tmdb', label: 'TMDb', ok: false, error: err.message });
    }
  } else if (source === 'imdb' && sourceId) {
    try {
      record = await omdbDetail(sourceId, omdbKey);
      if (!record) {
        const minimal = (await searchImdb(sourceId)).find((x) => x.sourceId === sourceId);
        if (minimal) record = { ...minimal, actors: minimal.actors || [], summary: '' };
      }
      if (record) sources.push({ key: 'imdb', label: 'IMDb', ok: true });
      else sources.push({ key: 'imdb', label: 'IMDb', ok: false, error: '未取到详情' });
    } catch (err) {
      sources.push({ key: 'imdb', label: 'IMDb', ok: false, error: err.message });
    }
  }

  // 没给源（或指定源失败）：用标题搜，取最匹配的一条，再抓详情
  if (!record && title) {
    const { results } = await search(title, { tmdbKey });
    const scored = results
      .map((r) => ({ r, s: similarity(r.title, title) + (year && r.year === year ? 0.15 : 0) }))
      .sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (best && best.s >= 0.5) {
      if (best.r.source === 'douban') {
        try {
          record = await doubanDetail(best.r.sourceId);
          sources.push({ key: 'douban', label: '豆瓣', ok: true });
        } catch (err) {
          record = best.r;
          sources.push({ key: 'douban', label: '豆瓣', ok: false, error: err.message });
        }
      } else if (best.r.source === 'tmdb' && tmdbKey) {
        try {
          record = await tmdbDetail(best.r.sourceId, tmdbKey);
          sources.push({ key: 'tmdb', label: 'TMDb', ok: true });
        } catch (err) {
          record = best.r;
          sources.push({ key: 'tmdb', label: 'TMDb', ok: false, error: err.message });
        }
      } else {
        const full = await omdbDetail(best.r.sourceId, omdbKey);
        record = full || best.r;
        sources.push({ key: 'imdb', label: 'IMDb', ok: true });
      }
    }
  }

  if (!record) throw new Error('没有找到这部影片');

  // 推荐列表
  let recommendations = record.recommendations || [];
  if (!recommendations.length && record.source === 'douban' && record.sourceId) {
    recommendations = await doubanRecommendations(record.sourceId, { count: 12 }).catch(() => []);
  }
  // 用豆瓣补中文简介（IMDb/TMDb 来源时）
  if (!recommendations.length && record.title && record.source !== 'douban') {
    recommendations = [];
  }
  return { record: { ...record, recommendations }, sources };
}

module.exports = {
  search,
  lookup,
  searchDouban,
  searchImdb,
  searchTmdb,
  doubanDetail,
  doubanRecommendations,
  omdbDetail,
  tmdbDetail,
  splitCardSubtitle,
};
