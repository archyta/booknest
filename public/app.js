/* 书巢 BookNest 前端主程序 */
(function () {
  'use strict';

  const PALETTE = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
    '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
    '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#64748b', '#0f172a',
  ];
  const STATUS_ORDER = ['wish', 'owned', 'reading', 'finished', 'dropped'];

  const state = {
    books: [],
    categories: [],
    tags: [],
    booklists: [],
    booklistSorts: {},
    statuses: {},
    stats: {},
    settings: {},
    server: {},
    providers: [],
    filters: { status: '', category: '', tag: '', q: '', sort: 'added-desc', tagIds: [] },
    viewMode: localStorage.getItem('bn.viewMode') || 'grid',
    lastStatus: localStorage.getItem('bn.lastStatus') || 'wish',
    draft: null,
    session: [],
    cover: null,
    coverUseAsCover: true,
    creatingList: false,
    newListColor: PALETTE[10],
    listPick: null,
    related: null,
    author: null,
    lastScan: { code: '', at: 0 },
    busy: false,
    /* ---- 电影 ---- */
    mode: localStorage.getItem('bn.mode') || 'book',
    movies: [],
    movieLists: [],
    movieListSorts: {},
    movieStatuses: {},
    movieStats: {},
    movieFilters: { status: '', genre: '', collection: '', tag: '', q: '', sort: 'added-desc', kind: '' },
    movieDraft: null,
    movieRelated: null,
    movieSearch: { q: '', results: [], sources: [], sourceStatus: [], busy: false, error: '' },
    movieSources: [],
    movieCollection: null,
    person: null,
    seriesPick: null,
    movieListPick: null,
    movieCurrentListId: '',
    creatingMovieList: false,
    newMovieListColor: PALETTE[10],
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- 基础 ---------------- */

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `show${kind === 'err' ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = '';
    }, kind === 'err' ? 3600 : 2200);
  }

  async function api(path, options) {
    const opts = options || {};
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      data = { error: text };
    }
    if (!res.ok) {
      const error = new Error((data && data.error) || `请求失败 (${res.status})`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  /* 弹层层级：谁后打开谁在上面（同一个弹层被再次打开也会置顶），
     全部关闭后恢复默认，避免固定 z-index 导致"详情挡住作者列表"或反之。 */
  let sheetZ = 60;

  function openSheet(id) {
    const el = $(id);
    if (!el) return;
    sheetZ += 1;
    el.style.zIndex = String(sheetZ);
    $('#backdrop').classList.add('show');
    el.classList.add('open');
  }

  function resetSheetZ() {
    sheetZ = 60;
    $$('.sheet').forEach((s) => {
      s.style.zIndex = '';
    });
  }

  function closeSheet(id) {
    const el = $(id);
    if (el) el.classList.remove('open');
    if ($$('.sheet.open').length === 0) {
      $('#backdrop').classList.remove('show');
      resetSheetZ();
    }
  }

  function closeAllSheets() {
    $$('.sheet.open').forEach((s) => s.classList.remove('open'));
    $('#backdrop').classList.remove('show');
    resetSheetZ();
  }

  /* 封面大图 */
  function openLightbox(src) {
    if (!src) return;
    const box = $('#lightbox');
    const img = $('#lightboxImg');
    if (!box || !img) return;
    img.src = src;
    box.classList.remove('zoomed');
    box.classList.add('show');
    box.scrollTop = 0;
    box.scrollLeft = 0;
  }

  function closeLightbox() {
    const box = $('#lightbox');
    if (!box) return;
    box.classList.remove('show');
    box.classList.remove('zoomed');
  }

  function coverSrc(book) {
    if (!book) return '';
    if (book.cover) return book.cover;
    if (book.coverRemote) return `/api/cover?src=${encodeURIComponent(book.coverRemote)}`;
    return '';
  }

  function categoryOf(book) {
    if (book.categoryId) {
      const c = state.categories.find((x) => x.id === book.categoryId);
      if (c) return { id: c.id, name: c.name, color: c.color, manual: true };
    }
    return {
      id: '',
      name: book.autoCategoryName || '未分类',
      color: book.autoCategoryColor || '#94a3b8',
      manual: false,
    };
  }

  function tagsOf(book) {
    return (book.tagIds || []).map((id) => state.tags.find((t) => t.id === id)).filter(Boolean);
  }

  /* ---------------- 相似书目 ---------------- */

  /** 书名相似度（bigram 重合度，和服务端同一套算法） */
  function textSim(a, b) {
    const norm = (s) =>
      String(s || '')
        .toLowerCase()
        .replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return 0.85;
    const grams = (s) => {
      const set = new Set();
      for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
      return set;
    };
    const gx = grams(x);
    const gy = grams(y);
    let hit = 0;
    gx.forEach((g) => {
      if (gy.has(g)) hit += 1;
    });
    return (2 * hit) / (gx.size + gy.size);
  }

  function authorKey(a) {
    return String(a || '')
      .toLowerCase()
      .replace(/^[\[【][^\]】]*[\]】]\s*/, '')
      .replace(/[\s\-_:：·,，.。()（）\[\]【】《》]/g, '');
  }

  /** 任意来源的封面地址（本地路径直接用，远程图床走代理绕开防盗链） */
  function anyCoverSrc(item) {
    if (!item) return '';
    const raw = item.cover || item.coverRemote || '';
    if (!raw) return '';
    if (raw.charAt(0) === '/') return raw;
    return `/api/cover?src=${encodeURIComponent(raw)}`;
  }

  /** 书架内相似度：同类 +3 / 共同标签 ×2 / 同作者 +3 / 同丛书 +2 / 出版社 +0.5 / 书名相近 +2 */
  function similarInLibrary(book, limit) {
    const cat = categoryOf(book);
    const myTags = new Set(book.tagIds || []);
    const myAuthors = (book.authors || []).map(authorKey).filter((x) => x.length >= 2);
    const out = [];
    for (const b of state.books) {
      if (!b || b.id === book.id) continue;
      let score = 0;
      const reasons = [];
      const c2 = categoryOf(b);
      if (cat.name && cat.name !== '未分类' && c2.name === cat.name) {
        score += 3;
        reasons.push(`同类 · ${cat.name}`);
      }
      const shared = (b.tagIds || []).filter((t) => myTags.has(t));
      if (shared.length) {
        score += shared.length * 2;
        const names = shared
          .map((id) => (state.tags.find((t) => t.id === id) || {}).name)
          .filter(Boolean)
          .slice(0, 2);
        reasons.push(names.length ? `共同标签 · ${names.join('、')}` : `共同标签 ${shared.length} 个`);
      }
      const bAuthors = (b.authors || []).map(authorKey);
      const sameAuthor =
        myAuthors.length &&
        bAuthors.some((a) =>
          myAuthors.some((x) => x === a || (x.length >= 3 && a.indexOf(x) >= 0) || (a.length >= 3 && x.indexOf(a) >= 0))
        );
      if (sameAuthor) {
        score += 3;
        reasons.push('同一作者');
      }
      if (book.series && b.series && book.series === b.series) {
        score += 2;
        reasons.push(`同丛书 · ${book.series}`);
      }
      if (book.publisher && b.publisher && book.publisher === b.publisher) score += 0.5;
      const t = textSim(book.title, b.title);
      if (t >= 0.5) {
        score += t * 2;
        reasons.push('书名相近');
      }
      if (score >= 2) out.push({ book: b, score, reasons });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit || 8);
  }

  function simCardHtml(item, reason, act) {
    const cover = anyCoverSrc(item);
    if (act === 'sim-open') {
      return `<button class="sim-card" data-act="sim-open" data-id="${esc(item.id)}">
        <div class="cover">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '📖'}</div>
        <div class="t">${esc(item.title)}</div>
        <div class="r">${esc(reason || '')}</div>
      </button>`;
    }
    const payload = JSON.stringify({
      title: item.title,
      source: item.source || '',
      sourceId: item.id || '',
      cover: item.cover || '',
    });
    return `<button class="sim-card" data-act="sim-add" data-pick='${esc(payload)}'>
      <div class="cover">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '📖'}</div>
      <div class="t">${esc(item.title)}</div>
      <div class="r">${esc(reason || '')}</div>
    </button>`;
  }

  function relatedRowInner(rel) {
    if (!rel || rel.loading) {
      return '<div class="center" style="padding:12px 0;width:100%"><span class="spinner"></span> 正在找相关的书…</div>';
    }
    if (rel.error) return `<div class="hint" style="font-size:12px;color:var(--text-mute)">${esc(rel.error)}</div>`;
    if (!rel.candidates || !rel.candidates.length) {
      return '<div class="hint" style="font-size:12px;color:var(--text-mute)">没找到相关的书</div>';
    }
    return rel.candidates
      .map((c) => simCardHtml(c, [c.sourceLabel, c.reason].filter(Boolean).join(' · '), 'sim-add'))
      .join('');
  }

  function paintRelated() {
    const box = $('#relatedRow');
    if (!box) return;
    box.innerHTML = relatedRowInner(state.related);
    const hint = $('#relatedHint');
    if (hint) {
      const rel = state.related;
      hint.textContent = rel && !rel.loading ? '豆瓣 · 微信读书 · Open Library' : '';
    }
  }

  function ensureRelated(book, force) {
    if (!book || !book.id) return;
    const cur = state.related;
    if (!force && cur && cur.bookId === book.id && (cur.loading || cur.candidates || cur.error)) return;
    state.related = { bookId: book.id, loading: true, candidates: [], queries: [] };
    paintRelated();
    api(`/api/books/${book.id}/related${force ? '?force=1' : ''}`)
      .then((res) => {
        if (!state.related || state.related.bookId !== book.id) return;
        state.related = {
          bookId: book.id,
          loading: false,
          candidates: res.candidates || [],
          queries: res.queries || [],
          error: res.error || '',
        };
        paintRelated();
      })
      .catch((err) => {
        if (!state.related || state.related.bookId !== book.id) return;
        state.related = { bookId: book.id, loading: false, candidates: [], queries: [], error: err.message };
        paintRelated();
      });
  }

  function relatedSectionHtml(book) {
    const isEdit = state.draft && state.draft.mode === 'edit' && book.id;
    const local = similarInLibrary(book, 8);
    const localHtml = local.length
      ? local.map((r) => simCardHtml(r.book, r.reasons.join(' · '), 'sim-open')).join('')
      : '<div class="hint" style="font-size:12px;color:var(--text-mute)">书架里还没有相似的书（同分类 / 同标签 / 同作者会出现在这里）</div>';
    const rel = state.related && state.related.bookId === book.id ? state.related : null;
    return `
      <div class="section-head" style="margin-top:18px"><h3>相似的书目</h3><span class="hint">书架里</span></div>
      <div class="similar-row">${localHtml}</div>
      ${
        isEdit
          ? `<div class="section-head"><h3>相关推荐</h3>
               <span class="hint" id="relatedHint"></span>
               <button class="icon-btn" data-action="reload-related" title="换一批">↻</button>
             </div>
             <div class="similar-row" id="relatedRow">${relatedRowInner(rel)}</div>`
          : ''
      }`;
  }

  function starsText(rating, fiveStarScale) {    if (!rating) return '';
    const full = fiveStarScale ? Math.round(rating) : Math.round(rating / 2);
    return '★'.repeat(Math.min(5, full)) + '☆'.repeat(Math.max(0, 5 - full));
  }

  /* ---------------- 书架渲染 ---------------- */

  /** 书籍排序：书架和"书单选书列表"共用一套 */
  const BOOK_SORTS = {
    'added-desc': '最近添加',
    'added-asc': '最早添加',
    'updated-desc': '最近更新',
    'title-asc': '书名 A→Z',
    'author-asc': '作者 A→Z',
    'rating-desc': '公开评分高→低',
    'myrating-desc': '我的评分高→低',
    'pubdate-desc': '出版时间新→旧',
    'pubdate-asc': '出版时间旧→新',
    'status-asc': '按阅读状态',
  };

  function sortBooks(list, sort) {
    const year = (b) => {
      const m = String(b.pubdate || '').match(/\d{4}/);
      return m ? Number(m[0]) : 0;
    };
    const statusRank = (b) => {
      const i = STATUS_ORDER.indexOf(b.status);
      return i < 0 ? 99 : i;
    };
    const copy = list.slice();
    copy.sort((a, b) => {
      switch (sort) {
        case 'added-asc':
          return String(a.addedAt).localeCompare(String(b.addedAt));
        case 'updated-desc':
          return String(b.updatedAt).localeCompare(String(a.updatedAt));
        case 'title-asc':
          return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
        case 'author-asc':
          return String((a.authors || [])[0] || '').localeCompare(String((b.authors || [])[0] || ''), 'zh-Hans-CN');
        case 'rating-desc':
          return (b.rating || b.myRating || 0) - (a.rating || a.myRating || 0);
        case 'myrating-desc':
          return (b.myRating || 0) - (a.myRating || 0) || (b.rating || 0) - (a.rating || 0);
        case 'pubdate-desc':
          return year(b) - year(a);
        case 'pubdate-asc':
          return year(a) - year(b);
        case 'status-asc':
          return statusRank(a) - statusRank(b) || String(b.addedAt).localeCompare(String(a.addedAt));
        default:
          // added-desc：最后加进来的排最前
          return String(b.addedAt).localeCompare(String(a.addedAt));
      }
    });
    return copy;
  }

  function filteredBooks() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    let list = state.books.slice();
    if (f.status) list = list.filter((b) => b.status === f.status);
    if (f.category) {
      if (f.category === '__none__') list = list.filter((b) => !b.categoryId);
      else list = list.filter((b) => b.categoryId === f.category);
    }
    if (f.tagIds.length) list = list.filter((b) => f.tagIds.every((id) => (b.tagIds || []).includes(id)));
    if (q) {
      list = list.filter((b) => {
        const hay = [
          b.title,
          b.subtitle,
          (b.authors || []).join(' '),
          b.publisher,
          b.isbn13,
          b.isbn10,
          b.note,
          b.autoCategoryName,
          tagsOf(b).map((t) => t.name).join(' '),
        ]
          .join(' ')
          .toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }
    return sortBooks(list, f.sort);
  }

  function cardHtml(book) {
    const cat = categoryOf(book);
    const tags = tagsOf(book).slice(0, 2);
    const cover = coverSrc(book);
    const st = state.statuses[book.status] || { label: book.status, color: '#94a3b8' };
    return `<button class="card" data-book="${book.id}">
      <div class="cover">
        ${cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '<div class="ph">📖</div>'}
      </div>
      <div class="meta">
        <div class="title">${esc(book.title)}</div>
        <div class="author">${esc((book.authors || []).join(' / ') || book.publisher || '—')}</div>
        <div class="tags">
          <span class="badge" style="background:${esc(st.color)}">${esc(st.label)}</span>
          <span class="tag-pill" style="background:${esc(cat.color)}">${esc(cat.name)}</span>
        </div>
        ${
          book.rating || book.myRating
            ? `<div class="rating-line"><span class="stars">${
                book.myRating ? starsText(book.myRating, true) : starsText(book.rating)
              }</span>${book.myRating ? `我的 ${book.myRating}` : `${book.rating}`}</div>`
            : ''
        }
        ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag-pill" style="background:${esc(t.color)}">${esc(t.name)}</span>`).join('')}</div>` : ''}
      </div>
    </button>`;
  }

  function rowHtml(book) {
    const cat = categoryOf(book);
    const tags = tagsOf(book);
    const cover = coverSrc(book);
    const st = state.statuses[book.status] || { label: book.status, color: '#94a3b8' };
    return `<button class="row" data-book="${book.id}">
      <div class="cover">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '📖'}</div>
      <div class="info">
        <div class="title">${esc(book.title)}${book.subtitle ? `<span style="font-weight:400;color:var(--text-mute);font-size:12px"> · ${esc(book.subtitle)}</span>` : ''}</div>
        <div class="sub">${esc((book.authors || []).join(' / ') || '—')}${book.publisher ? ` · ${esc(book.publisher)}` : ''}${book.pubdate ? ` · ${esc(book.pubdate)}` : ''}</div>
        <div class="tags">
          <span class="badge" style="background:${esc(st.color)}">${esc(st.label)}</span>
          <span class="tag-pill" style="background:${esc(cat.color)}">${esc(cat.name)}</span>
          ${tags.map((t) => `<span class="tag-pill" style="background:${esc(t.color)}">${esc(t.name)}</span>`).join('')}
        </div>
        ${book.rating ? `<div class="rating-line"><span class="stars">${starsText(book.rating)}</span>${book.rating} <span style="color:var(--text-mute)">${esc(book.ratingLabel || '')}</span></div>` : ''}
      </div>
    </button>`;
  }

  function renderShelf() {
    if (state.mode === 'movie') return renderMovieShelf();
    if (state.viewMode === 'collgroup') {
      state.viewMode = 'group'; // 书籍没有合集，回落为按分类分组
      updateViewModeBtn();
    }
    const list = filteredBooks();
    const view = $('#view');
    $('#shelfCount').textContent = state.books.length ? `共 ${state.books.length} 本` : '';
    const summary = `<div class="shelf-summary"><span>当前显示 ${list.length} 本${
      state.filters.q ? ` · 搜索「${esc(state.filters.q)}」` : ''
    }</span><span>${esc((state.statuses[state.filters.status] || {}).label || '全部')}</span></div>`;

    if (!state.books.length) {
      view.innerHTML = `<div class="empty"><div class="big">📚</div><p><b>书架还是空的</b></p>
        <p>点下面的「扫码」，对准书背面的条形码；<br>也可以手动输入 ISBN 或书名搜索。</p>
        <div class="btn-row" style="max-width:260px;margin:16px auto 0">
          <button class="btn" data-action="goto-scan">开始扫码</button>
        </div></div>`;
      return;
    }
    if (!list.length) {
      view.innerHTML = `${summary}<div class="empty"><div class="big">🔍</div><p>没有符合条件的书</p>
        <p><button class="btn ghost sm" data-action="clear-filters">清空筛选</button></p></div>`;
      return;
    }

    if (state.viewMode === 'list') {
      view.innerHTML = `${summary}<div class="list">${list.map(rowHtml).join('')}</div>`;
      return;
    }
    if (state.viewMode === 'group') {
      const groups = new Map();
      for (const b of list) {
        const cat = categoryOf(b);
        if (!groups.has(cat.name)) groups.set(cat.name, { color: cat.color, items: [] });
        groups.get(cat.name).items.push(b);
      }
      const html = Array.from(groups.entries())
        .sort((a, b) => b[1].items.length - a[1].items.length)
        .map(
          ([name, g]) =>
            `<div class="group-title"><span class="chip" style="background:${esc(g.color)}22;color:${esc(
              g.color
            )};font-weight:700">${esc(name)}</span><span style="color:var(--text-mute);font-weight:400">${g.items.length} 本</span></div>
             <div class="grid">${g.items.map(cardHtml).join('')}</div>`
        )
        .join('');
      view.innerHTML = summary + html;
      return;
    }
    view.innerHTML = `${summary}<div class="grid">${list.map(cardHtml).join('')}</div>`;
  }

  function renderStatusChips() {
    if (state.mode === 'movie') {
      const counts = (state.movieStats && state.movieStats.byStatus) || {};
      const order = ['wish', 'watching', 'watched', 'dropped'];
      const chips = [
        `<button class="chip ${state.movieFilters.status === '' ? 'active' : ''}" data-mstatus="">全部 <span class="count">${state.movies.length}</span></button>`,
      ];
      for (const key of order) {
        const st = state.movieStatuses[key] || { label: key, color: '#94a3b8' };
        chips.push(
          `<button class="chip ${state.movieFilters.status === key ? 'active' : ''}" data-mstatus="${key}">
            <span class="dot" style="background:${esc(st.color)}"></span>${esc(st.label)} <span class="count">${counts[key] || 0}</span>
          </button>`
        );
      }
      $('#statusChips').innerHTML = chips.join('');
      return;
    }
    const counts = (state.stats && state.stats.byStatus) || {};
    const chips = [`<button class="chip ${state.filters.status === '' ? 'active' : ''}" data-status="">全部 <span class="count">${state.books.length}</span></button>`];
    for (const key of STATUS_ORDER) {
      const st = state.statuses[key];
      if (!st) continue;
      chips.push(
        `<button class="chip ${state.filters.status === key ? 'active' : ''}" data-status="${key}">
          <span class="dot" style="background:${esc(st.color)}"></span>${esc(st.label)} <span class="count">${counts[key] || 0}</span>
        </button>`
      );
    }
    $('#statusChips').innerHTML = chips.join('');
  }

  function renderFilterOptions() {
    const catSel = $('#filterCategory');
    const tagSel = $('#filterTag');
    const sortSel = $('#sortBy');
    if (state.mode === 'movie') {
      const genres = (state.movieStats.byGenre || []).map((g) => g.name);
      // 合集列表（按入库数量排序）
      const collMap = new Map();
      for (const m of state.movies) {
        const c = m.collection;
        if (!c || !c.name) continue;
        const key = c.id ? `c:${c.id}` : `m:${c.name}`;
        collMap.set(key, { key, name: c.name, manual: !c.id, n: (collMap.get(key) || { n: 0 }).n + 1 });
      }
      const colls = [...collMap.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh-Hans-CN'));
      catSel.innerHTML =
        `<option value="">全部类型 / 合集</option>` +
        `<optgroup label="类型">${genres
          .map((g) => `<option value="g:${esc(g)}">${esc(g)}</option>`)
          .join('')}</optgroup>` +
        (colls.length
          ? `<optgroup label="合集 / 系列">${colls
              .map((c) => `<option value="${esc(c.key)}">${esc(c.name)}（${c.n}）${c.manual ? ' · 手动' : ''}</option>`)
              .join('')}</optgroup>`
          : '');
      tagSel.innerHTML =
        `<option value="">全部标签</option>` + state.tags.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
      sortSel.innerHTML = [
        ['added-desc', '最近添加'],
        ['added-asc', '最早添加'],
        ['updated-desc', '最近更新'],
        ['rating-desc', '评分高→低'],
        ['myrating-desc', '我的评分高→低'],
        ['title-asc', '片名 A→Z'],
        ['director-asc', '导演 A→Z'],
        ['year-desc', '年份新→旧'],
        ['year-asc', '年份旧→新'],
        ['status-asc', '按观看状态'],
      ]
        .map(([k, label]) => `<option value="${k}">${label}</option>`)
        .join('');
      catSel.value = state.movieFilters.collection
        ? state.movieFilters.collection
        : state.movieFilters.genre
        ? `g:${state.movieFilters.genre}`
        : '';
      tagSel.value = state.movieFilters.tag;
      sortSel.value = state.movieFilters.sort;
      $('#searchInput').value = state.movieFilters.q;
      $('#searchClear').classList.toggle('hidden', !state.movieFilters.q);
      $('#searchInput').placeholder = '搜索片名 / 导演 / 演员 / 类型 / 标签';
      $('.brand').innerHTML = `🎬 片库 <small id="shelfCount"></small>`;
      return;
    }
    $('.brand').innerHTML = `📚 书巢 <small id="shelfCount"></small>`;
    $('#searchInput').placeholder = '搜索书名 / 作者 / 出版社 / ISBN / 标签';
    catSel.innerHTML =
      `<option value="">全部分类</option><option value="__none__">未分类</option>` +
      state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    tagSel.innerHTML =
      `<option value="">全部标签</option>` + state.tags.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    catSel.value = state.filters.category;
    tagSel.value = state.filters.tagIds[0] || '';
    sortSel.value = state.filters.sort;
    $('#searchInput').value = state.filters.q;
    $('#searchClear').classList.toggle('hidden', !state.filters.q);
  }

  function renderAll() {
    renderKindSwitch();
    renderStatusChips();
    renderFilterOptions();
    renderShelf();
    renderMovieListsIfOpen();
    renderMovieTabLabel();
  }

  /* ---------------- 数据 ---------------- */

  async function bootstrap() {
    const data = await api('/api/bootstrap');
    state.books = data.books || [];
    state.categories = data.categories || [];
    state.tags = data.tags || [];
    state.booklists = data.booklists || [];
    state.booklistSorts = data.booklistSorts || {};
    state.statuses = data.statuses || {};
    state.stats = data.stats || {};
    state.settings = data.settings || {};
    state.server = data.server || {};
    state.providers = data.providers || [];
    state.movies = data.movies || [];
    state.movieLists = data.movieLists || [];
    state.movieListSorts = data.movieListSorts || {};
    state.movieStatuses = data.movieStatuses || {};
    state.movieStats = data.movieStats || {};
    renderAll();
  }

  async function refresh() {
    try {
      await bootstrap();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* ---------------- 书籍详情 / 录入确认 ---------------- */

  function statusPickerHtml(current) {
    return `<div class="status-picker" id="statusPicker">${STATUS_ORDER.map((key) => {
      const st = state.statuses[key] || { label: key, color: '#94a3b8' };
      const on = current === key;
      return `<button data-status-pick="${key}" class="${on ? 'on' : ''}" style="${on ? `background:${st.color}` : ''}">${esc(st.label)}</button>`;
    }).join('')}</div>`;
  }

  function tagPickerHtml(selected) {
    return `<div class="picker" id="tagPicker">${state.tags
      .map((t) => {
        const on = selected.indexOf(t.id) >= 0;
        return `<button class="pill ${on ? 'on' : ''}" data-tag-toggle="${esc(t.id)}" style="${
          on ? `background:${esc(t.color)}` : `background:${esc(t.color)}22;color:${esc(t.color)}`
        }">${esc(t.name)}</button>`;
      })
      .join('')}<button class="pill add" data-action="new-tag">＋ 新标签</button></div>
      <div id="newTagForm" class="hidden" style="margin-top:8px">
        <div class="inline-form"><input type="text" id="newTagName" placeholder="标签名称" maxlength="16">
        <button class="btn sm" data-action="create-tag">创建</button></div>
        <div class="palette" id="newTagPalette">${PALETTE.map((c) => `<button data-color="${c}" style="background:${c}"></button>`).join('')}</div>
      </div>`;
  }

  function categorySelectHtml(selected) {
    return `<select data-field="categoryId" id="categorySelect">
      <option value="">未分类</option>
      ${state.categories.map((c) => `<option value="${esc(c.id)}" ${selected === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>
    <div class="picker" style="margin-top:8px">
      <button class="pill add" data-action="new-category">＋ 新建分类</button>
    </div>
    <div id="newCatForm" class="hidden" style="margin-top:8px">
      <div class="inline-form">
        <input type="text" id="newCatName" placeholder="分类名称" maxlength="16">
        <button class="btn sm" data-action="create-category">创建</button>
      </div>
      <div class="palette" id="newCatPalette">${PALETTE.map(
        (c) => `<button data-color="${c}" style="background:${c}"></button>`
      ).join('')}</div>
    </div>`;
  }

  function ratingPickerHtml(value) {
    return `<div class="mini-stars" id="myRatingPicker">${[1, 2, 3, 4, 5]
      .map((n) => `<span data-star="${n}" class="${value >= n ? 'on' : ''}">★</span>`)
      .join('')}<span id="myRatingText" style="font-size:12px;color:var(--text-mute);margin-left:8px">${
      value ? `${value} 星` : '未评分'
    }</span></div>`;
  }

  function fieldHtml(label, name, value, opts) {
    const o = opts || {};
    if (o.type === 'textarea') {
      return `<div class="field"><label>${esc(label)}</label><textarea data-field="${name}" rows="${o.rows || 4}" placeholder="${esc(
        o.placeholder || ''
      )}">${esc(value || '')}</textarea></div>`;
    }
    return `<div class="field"><label>${esc(label)}</label><input data-field="${name}" type="${o.type || 'text'}" value="${esc(
      value || ''
    )}" placeholder="${esc(o.placeholder || '')}" ${o.inputmode ? `inputmode="${o.inputmode}"` : ''}></div>`;
  }

  function personChips(list) {
    return (list || [])
      .filter(Boolean)
      .map((n) => `<button class="person-chip" data-act="author-books" data-name="${esc(n)}">${esc(n)}</button>`)
      .join('');
  }

  /* ---------------- 详情页：离散字段即时保存 ---------------- */

  function setSaveHint(text, kind) {
    const el = $('#autoSaveHint');
    if (!el) return;
    el.textContent = text || '';
    el.className = `auto-save-hint${kind ? ` ${kind}` : ''}`;
  }

  /** 只把本次改动的字段回填到草稿，避免覆盖用户还没保存的文字编辑 */
  function mergeServerFields(serverBook, patch) {
    const d = state.draft;
    if (!d || !serverBook) return;
    const keep = Object.keys(patch || {});
    const extra = ['updatedAt', 'startedAt', 'finishedAt', 'progress', 'autoCategoryName', 'autoCategoryColor'];
    const merged = { ...d.book };
    for (const k of keep.concat(extra)) {
      if (serverBook[k] !== undefined) merged[k] = serverBook[k];
    }
    d.book = merged;
  }

  /** 立即保存若干字段（编辑模式才有 id） */
  async function autoSave(patch) {
    const d = state.draft;
    if (!d || d.mode !== 'edit' || !d.book || !d.book.id) return false;
    const id = d.book.id;
    Object.assign(d.book, patch);
    setSaveHint('保存中…', 'saving');
    try {
      const res = await api(`/api/books/${id}`, { method: 'PATCH', body: patch });
      const serverBook = res.book;
      state.books = state.books.map((b) => (b.id === id ? { ...b, ...serverBook } : b));
      mergeServerFields(serverBook, patch);
      setSaveHint('已保存', 'ok');
      // 轻量刷新：状态计数 + 书架（不重新拉整个 bootstrap）
      api('/api/stats')
        .then((stats) => {
          if (stats) state.stats = stats;
          renderStatusChips();
          renderShelf();
        })
        .catch(() => {
          renderShelf();
        });
      return true;
    } catch (err) {
      setSaveHint('保存失败', 'error');
      toast(err.message || '保存失败', 'err');
      return false;
    }
  }

  /** 书单归属：编辑模式下点一下立即加入/移出 */
  async function toggleBookListNow(listId) {
    const d = state.draft;
    if (!d || !d.book || !d.book.id) return;
    const ids = (d.book.listIds || []).slice();
    const inList = ids.indexOf(listId) >= 0;
    // 先本地切换，界面立刻响应
    d.book.listIds = inList ? ids.filter((x) => x !== listId) : ids.concat([listId]);
    d.currentListIds = d.book.listIds.slice();
    updateListPills();
    setSaveHint('保存中…', 'saving');
    try {
      if (inList) {
        await api(`/api/booklists/${listId}/books/remove`, { method: 'POST', body: { bookIds: [d.book.id] } });
      } else {
        await api(`/api/booklists/${listId}/books`, { method: 'POST', body: { bookIds: [d.book.id] } });
      }
      const res = await api('/api/booklists');
      if (res && res.booklists) state.booklists = res.booklists;
      updateListPills();
      setSaveHint(inList ? '已移出书单' : '已加入书单', 'ok');
      api('/api/stats')
        .then((stats) => {
          if (stats) state.stats = stats;
          renderStatusChips();
          renderShelf();
        })
        .catch(() => renderShelf());
    } catch (err) {
      // 失败则回滚
      d.book.listIds = ids;
      d.currentListIds = ids.slice();
      updateListPills();
      setSaveHint('保存失败', 'error');
      toast(err.message || '书单更新失败', 'err');
    }
  }

  /* 只更新受影响的控件，不整页重绘（否则滚动位置会跳、正在输入的内容会断开） */
  function updateStatusPills() {
    const cur = state.draft.book.status;
    $$('#statusPicker [data-status-pick]').forEach((btn) => {
      const on = btn.dataset.statusPick === cur;
      const st = state.statuses[btn.dataset.statusPick] || {};
      btn.className = on ? 'on' : '';
      btn.style.background = on ? st.color || '' : '';
    });
  }

  function updateTagPills() {
    const ids = state.draft.book.tagIds || [];
    $$('#tagPicker [data-tag-toggle]').forEach((btn) => {
      const t = state.tags.find((x) => x.id === btn.dataset.tagToggle) || {};
      const on = ids.indexOf(btn.dataset.tagToggle) >= 0;
      btn.className = `pill${on ? ' on' : ''}`;
      btn.style.cssText = on ? `background:${t.color || ''}` : `background:${(t.color || '')}22;color:${t.color || ''}`;
    });
    const label = $('#tagPickerLabel');
    if (label) label.textContent = ids.length ? `标签（已选 ${ids.length} 个）` : '标签';
  }

  function updateListPills() {
    const ids = state.draft.book.listIds || [];
    $$('#listPicker [data-list-pick]').forEach((btn) => {
      const l = state.booklists.find((x) => x.id === btn.dataset.listPick) || {};
      const on = ids.indexOf(btn.dataset.listPick) >= 0;
      btn.className = `pill${on ? ' on' : ''}`;
      btn.style.cssText = on
        ? `background:${l.color || ''};border-color:${l.color || ''}`
        : `background:${(l.color || '')}1f;color:${l.color || ''};border-color:${(l.color || '')}55`;
      btn.textContent = `${on ? '✓ ' : ''}${l.name || ''}`;
    });
    const label = $('#listPickerLabel');
    if (label) label.textContent = ids.length ? `加入书单（已选 ${ids.length} 个）` : '加入书单';
  }

  function updateStarPicker() {
    const val = state.draft.book.myRating || 0;
    $$('#myRatingPicker [data-star]').forEach((el) => {
      el.className = Number(el.dataset.star) <= val ? 'on' : '';
    });
    const txt = $('#myRatingText');
    if (txt) txt.textContent = val ? `${val} 星` : '未评分';
  }

  /** 从服务端重新拉一遍这本书（自动保存失败时回滚界面） */
  async function reloadDraftFromServer() {
    const d = state.draft;
    if (!d || !d.book || !d.book.id) return;
    try {
      const res = await api(`/api/books/${d.book.id}`);
      if (res && res.book) {
        const listIds = d.book.listIds;
        d.book = { ...res.book, listIds };
        renderBookSheet();
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  function bookSheetHtml() {
    const d = state.draft;
    const b = d.book;
    const isNew = d.mode === 'new';
    const lookup = d.lookup || {};
    const cover = coverSrc(b);
    const cat = categoryOf(b);
    const sources = d.sources || lookup.sources || [];

    const head = `
      <div class="lookup-top">
        <div class="cover">${
          cover
            ? `<button class="cover-zoom" data-act="zoom-cover" data-src="${esc(cover)}" title="点击放大封面"><img src="${esc(
                cover
              )}" alt=""></button>`
            : '<div class="ph">📖</div>'
        }</div>
        <div class="head">
          <h3>${esc(b.title || '未命名')}</h3>
          <div class="person-line">
            ${b.authors && b.authors.length ? personChips(b.authors) : '<span class="person-chip" style="opacity:.6">作者未知</span>'}
            ${b.translators && b.translators.length ? `<span class="person-sep">译</span>${personChips(b.translators)}` : ''}
          </div>
          <div class="line" style="font-size:11.5px;color:var(--text-mute)">点作者/译者可以看 TA 的全部作品</div>
          <div class="line">${esc([b.publisher, b.pubdate].filter(Boolean).join(' · ') || '出版信息未知')}</div>
          ${b.rating ? `<div class="line"><span class="stars">${starsText(b.rating)}</span> ${b.rating} <span style="color:var(--text-mute)">${esc(b.ratingLabel || '')}${b.ratingCount ? ` · ${b.ratingCount} 人评价` : ''}</span></div>` : ''}
          ${b.isbn13 ? `<div class="line" style="color:var(--text-mute)">ISBN ${esc(b.isbn13)}</div>` : ''}
        </div>
      </div>`;

    const dupBanner = d.duplicate
      ? `<div class="banner warn">📕 这本《${esc(d.duplicate.title)}》已经在书架里了。
          <div class="btn-row" style="margin-top:8px">
            <button class="btn sm ghost" data-action="view-duplicate">查看已有</button>
            <button class="btn sm" data-action="force-add">仍然新增一本</button>
          </div></div>`
      : '';

    const photoRow = d.photo
      ? `<label class="check-row"><input type="checkbox" id="draftUsePhoto" ${
          d.photo.useAsCover ? 'checked' : ''
        }> 查不到官方封面时，用拍的封面照片（<a href="${esc(d.photo.url || '')}" target="_blank" rel="noreferrer">查看</a>）</label>`
      : '';

    const saveBar = isNew
      ? ''
      : `<div class="save-bar">
           <span class="auto-save-hint" id="autoSaveHint"></span>
           <span class="save-bar-hint">状态 / 分类 / 标签 / 书单 / 我的评分 改动即时生效</span>
         </div>`;

    const statusHtml = `<div class="field"><label>状态</label>${statusPickerHtml(b.status)}</div>`;

    const catHtml = `<div class="field">
      <label>分类${cat.name && !b.categoryId ? `（自动建议：${esc(cat.name)}）` : ''}</label>
      ${categorySelectHtml(b.categoryId)}
      ${
        !b.categoryId && b.autoCategoryName
          ? `<button class="btn sm ghost" style="margin-top:8px" data-action="use-auto-category">采用自动分类「${esc(
              b.autoCategoryName
            )}」</button>`
          : ''
      }
    </div>`;

    const chosenLists = (b.listIds || []).length;
    const listHtml = state.booklists.length
      ? `<div class="field"><label id="listPickerLabel">加入书单${
          chosenLists ? `（已选 ${chosenLists} 个）` : ''
        }</label>
          <div class="picker" id="listPicker">${state.booklists
            .map((l) => {
              const on = (b.listIds || []).indexOf(l.id) >= 0;
              return `<button class="pill ${on ? 'on' : ''}" data-list-pick="${esc(l.id)}" style="${
                on
                  ? `background:${esc(l.color)};border-color:${esc(l.color)}`
                  : `background:${esc(l.color)}1f;color:${esc(l.color)};border-color:${esc(l.color)}55`
              }">${on ? '✓ ' : ''}${esc(l.name)}</button>`;
            })
            .join('')}</div>
          <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">
            ${
              isNew
                ? '保存时会自动加入勾选的书单'
                : '点一下即时生效：勾选＝加入该书单，取消勾选＝从该书单移出'
            }
          </div>
        </div>`
      : '';

    const tagHtml = `<div class="field"><label id="tagPickerLabel">标签${
      (b.tagIds || []).length ? `（已选 ${b.tagIds.length} 个）` : ''
    }</label>${tagPickerHtml(b.tagIds || [])}</div>`;

    const details = `<details class="collapse" ${isNew ? '' : 'open'}>
      <summary>详细信息（可手动修改）</summary>
      <div style="padding-top:8px">
        ${fieldHtml('书名', 'title', b.title)}
        ${fieldHtml('副标题', 'subtitle', b.subtitle)}
        <div class="field-row">${fieldHtml('作者（用 / 分隔）', 'authorsText', (b.authors || []).join(' / '))}${fieldHtml(
      '译者',
      'translatorsText',
      (b.translators || []).join(' / ')
    )}</div>
        <div class="field-row">${fieldHtml('出版社', 'publisher', b.publisher)}${fieldHtml('出版时间', 'pubdate', b.pubdate, {
      placeholder: '如 2023-05',
    })}</div>
        <div class="field-row">${fieldHtml('ISBN', 'isbn13', b.isbn13, { inputmode: 'numeric' })}${fieldHtml('页数', 'pages', b.pages || '', {
      inputmode: 'numeric',
    })}</div>
        <div class="field-row">${fieldHtml('定价', 'price', b.price)}${fieldHtml('装帧', 'binding', b.binding)}</div>
        <div class="field-row">${fieldHtml('丛书', 'series', b.series)}${fieldHtml('存放位置', 'location', b.location, {
      placeholder: '如 书架A-2',
    })}</div>
        <div class="field"><label>我的评分</label>${ratingPickerHtml(b.myRating)}</div>
        ${
          b.status === 'reading'
            ? `<div class="field"><label>阅读进度：<span id="progressLabel">${b.progress || 0}</span>%</label>
               <input type="range" min="0" max="100" step="5" data-field="progress" value="${b.progress || 0}"></div>`
            : ''
        }
        ${fieldHtml('我的备注', 'note', b.note, { type: 'textarea', rows: 3, placeholder: '想法、摘抄、借给了谁…' })}
        ${fieldHtml('内容简介', 'summary', b.summary, { type: 'textarea', rows: 6 })}
      </div>
    </details>`;

    const srcHtml = sources.length
      ? `<details class="collapse"><summary>信息来源（${sources.length}）</summary><div class="src-list" style="padding-top:6px">
          ${sources
            .map(
              (s) =>
                `<div class="row"><span class="led ${s.ok ? 'ok' : 'bad'}"></span>${esc(s.label || s.key)} ${
                  s.ok ? `· ${s.ms}ms` : `· ${esc(s.error || '失败')}`
                }</div>`
            )
            .join('')}
          ${b.sourceUrl ? `<div class="row">🔗 <a href="${esc(b.sourceUrl)}" target="_blank" rel="noreferrer">打开来源页面</a></div>` : ''}
        </div></details>`
      : '';

    const buttons = isNew
      ? `<div class="btn-row">
           <button class="btn" data-action="save-book">保存到书架</button>
           <button class="btn ghost" data-action="save-and-scan">保存并继续扫</button>
         </div>
         <div class="btn-row"><button class="btn ghost" data-action="refetch">↻ 重新抓取</button>
         <button class="btn ghost" data-action="discard">不保存</button></div>`
      : `<div class="btn-row"><button class="btn" data-action="save-book">保存文字修改</button>
           <button class="btn ghost" data-action="refetch">↻ 刷新元数据</button></div>
         <div class="btn-row"><button class="btn ghost" data-action="set-photo-cover">📷 用照片当封面</button></div>
         <div class="btn-row"><button class="btn danger" data-action="delete-book">删除这本书</button></div>`;

    return `${dupBanner}
      ${d.message ? `<div class="banner ${d.messageKind || ''}">${d.message}</div>` : ''}
      ${saveBar}${photoRow}${head}${statusHtml}${catHtml}${tagHtml}${listHtml}${details}${srcHtml}
      ${relatedSectionHtml(b)}
      <div style="height:8px"></div>${buttons}`;
  }

  function renderBookSheet() {
    const box = $('#bookSheetBody');
    const scroll = box ? box.scrollTop : 0;
    $('#bookSheetTitle').textContent = state.draft.mode === 'new' ? '确认书籍信息' : '书籍详情';
    box.innerHTML = bookSheetHtml();
    if (box) box.scrollTop = scroll; // 重绘后保持滚动位置
    $$('#newTagPalette button').forEach((btn) =>
      btn.classList.toggle('on', btn.dataset.color === (state.draft.newTagColor || PALETTE[11]))
    );
    $$('#newCatPalette button').forEach((btn) =>
      btn.classList.toggle('on', btn.dataset.color === (state.draft.newCatColor || PALETTE[9]))
    );
    if (state.draft.mode === 'edit' && state.draft.book.id) ensureRelated(state.draft.book, false);
  }

  function draftFromBook(book) {
    return JSON.parse(JSON.stringify(book));
  }

  function openEntrySheet({ book, mode, sources, duplicate, message, messageKind, lookup }) {
    const currentListIds = listsOfBook(book.id);
    state.draft = {
      mode: mode || 'edit',
      book: { ...draftFromBook(book), listIds: currentListIds.slice() },
      currentListIds,
      sources: sources || [],
      duplicate: duplicate || null,
      message: message || '',
      messageKind: messageKind || '',
      lookup: lookup || null,
      newTagColor: PALETTE[11],
      newCatColor: PALETTE[9],
    };
    renderBookSheet();
    openSheet('#sheetBook');
  }

  async function openBookDetail(id) {
    let book = state.books.find((b) => b.id === id);
    if (!book) return;
    openEntrySheet({ book, mode: 'edit' });
  }

  function collectDraft(root) {
    const d = state.draft;
    if (!d) return null;
    const text = (name) => {
      const el = root.querySelector(`[data-field="${name}"]`);
      return el ? el.value.trim() : undefined;
    };
    const b = d.book;
    const num = (v) => Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')) || 0;
    const patch = {
      title: text('title') != null ? text('title') : b.title,
      subtitle: text('subtitle'),
      authors: (text('authorsText') || '').split(/\s*\/\s*|\s*,\s*/).filter(Boolean),
      translators: (text('translatorsText') || '').split(/\s*\/\s*|\s*,\s*/).filter(Boolean),
      publisher: text('publisher'),
      pubdate: text('pubdate'),
      isbn13: text('isbn13'),
      pages: num(text('pages')),
      price: text('price'),
      binding: text('binding'),
      series: text('series'),
      location: text('location'),
      note: text('note'),
      summary: text('summary'),
      status: b.status,
      categoryId: b.categoryId,
      tagIds: b.tagIds,
      myRating: b.myRating,
      progress: b.progress,
    };
    const progressEl = root.querySelector('[data-field="progress"]');
    if (progressEl) patch.progress = Number(progressEl.value) || 0;
    const catSel = root.querySelector('#categorySelect');
    if (catSel) patch.categoryId = catSel.value;
    return patch;
  }

  function syncDraftFromInputs() {
    const root = $('#bookSheetBody');
    if (!state.draft || !root) return;
    const patch = collectDraft(root);
    if (!patch) return;
    // 保留元数据字段（这些不来自表单）
    state.draft.book = {
      ...state.draft.book,
      ...patch,
      cover: state.draft.book.cover,
      coverRemote: state.draft.book.coverRemote,
      rating: state.draft.book.rating,
      ratingCount: state.draft.book.ratingCount,
      ratingLabel: state.draft.book.ratingLabel,
      ratingScale: state.draft.book.ratingScale,
      source: state.draft.book.source,
      sourceUrl: state.draft.book.sourceUrl,
      autoCategoryName: state.draft.book.autoCategoryName,
      autoCategoryColor: state.draft.book.autoCategoryColor,
      subjects: state.draft.book.subjects,
      authorIntro: state.draft.book.authorIntro,
      producer: state.draft.book.producer,
      originalTitle: state.draft.book.originalTitle,
      isbn10: state.draft.book.isbn10,
    };
    return state.draft.book;
  }

  /** 保存后应用书单归属（增删差集） */
  async function applyBookLists(bookId, desired, current) {
    if (!bookId) return { added: 0, removed: 0 };
    const want = desired || [];
    const have = current || [];
    const toAdd = want.filter((id) => have.indexOf(id) < 0);
    const toRemove = have.filter((id) => want.indexOf(id) < 0);
    for (const id of toAdd) {
      await api(`/api/booklists/${id}/books`, { method: 'POST', body: { bookIds: [bookId] } }).catch(() => {});
    }
    for (const id of toRemove) {
      await api(`/api/booklists/${id}/books/remove`, { method: 'POST', body: { bookIds: [bookId] } }).catch(() => {});
    }
    return { added: toAdd.length, removed: toRemove.length };
  }

  async function saveDraft(continueScan) {
    const book = syncDraftFromInputs();
    if (!book) return;
    if (!book.title) {
      toast('书名不能为空', 'err');
      return;
    }
    const isNew = state.draft.mode === 'new';
    const forceAdd = !!state.draft.forceAdd;
    const desiredLists = state.draft.book.listIds || [];
    const currentLists = state.draft.currentListIds || [];
    try {
      let savedId = '';
      if (isNew) {
        const payload = { ...book, cover: '', coverRemote: book.coverRemote || '', allowDuplicate: forceAdd };
        delete payload.listIds;
        if (!payload.isbn13 && !payload.isbn10) delete payload.isbn13;
        if (state.draft.photo && state.draft.photo.useAsCover && state.draft.photo.token) {
          payload.coverLocal = state.draft.photo.token;
        }
        const res = await api('/api/books', { method: 'POST', body: payload });
        savedId = res.book.id;
        toast(`已加入书架：《${res.book.title}》`);
        if (state.draft.lookup) {
          state.session.unshift({
            id: res.book.id,
            title: res.book.title,
            cover: res.book.cover || res.book.coverRemote,
            status: res.book.status,
          });
        }
        renderSession();
      } else {
        const payload = { ...book };
        delete payload.listIds;
        await api(`/api/books/${book.id}`, { method: 'PATCH', body: payload });
        savedId = book.id;
        toast('已保存');
      }
      const listResult = await applyBookLists(savedId, desiredLists, currentLists);
      if (listResult.added || listResult.removed) {
        toast(`书单已更新（加入 ${listResult.added} 个，移出 ${listResult.removed} 个）`);
      }
      localStorage.setItem('bn.lastStatus', book.status);
      state.lastStatus = book.status;
      await refresh();
      // 先把详情层收起来，再刷新作者列表（这样作者列表自然回到最上层）
      closeSheet('#sheetBook');
      if (state.author && $('#sheetAuthor') && $('#sheetAuthor').classList.contains('open')) {
        openAuthorBooks(state.author.name);
      }
      if (continueScan) {
        state.draft = null;
        if (!$('#sheetScan').classList.contains('open')) openSheet('#sheetScan');
        setTimeout(() => window.BookScanner.resume(), 350);
      } else {
        state.draft = null;
        const scanOpen = $('#sheetScan').classList.contains('open');
        if (scanOpen) setTimeout(() => window.BookScanner.resume(), 350);
      }
    } catch (err) {
      if (err.status === 409 && err.data && err.data.book) {
        state.draft.duplicate = err.data.book;
        renderBookSheet();
        return;
      }
      toast(err.message, 'err');
    }
  }

  /* ---------------- 扫码录入 ---------------- */

  function renderSession() {
    const box = $('#recentScans');
    if (!box) return;
    if (!state.session.length) {
      box.innerHTML = '<div class="center" style="padding:12px 0">还没有扫描记录</div>';
      return;
    }
    box.innerHTML = state.session
      .map(
        (item) => `<button class="search-item" data-book="${esc(item.id)}">
          ${item.cover ? `<img src="${esc(item.cover)}" alt="">` : '<div class="ph">📖</div>'}
          <div style="flex:1;min-width:0">
            <div class="t">${esc(item.title)}</div>
            <div class="s">${esc((state.statuses[item.status] || {}).label || '')}</div>
          </div>
        </button>`
      )
      .join('');
  }

  async function startCamera() {
    const hint = $('#scanHint');
    try {
      const res = await window.BookScanner.start({
        video: $('#scanVideo'),
        onStatus: (msg) => {
          hint.textContent = msg;
        },
        onDetect: (code) => handleScanned(code),
      });
      $('#btnCamStart').textContent = '⏸ 暂停';
      hint.textContent = res.usingBarcodeDetector ? '条码放进框内即可，识别很快' : '把条码放进框内（按住书，别晃动）';
    } catch (err) {
      const name = err && err.name;
      let msg = err.message || '摄像头启动失败';
      if (name === 'NotAllowedError') msg = '摄像头权限被拒绝。可在浏览器地址栏左侧的权限里重新允许，或改用「拍照识别」。';
      else if (name === 'NotFoundError') msg = '没有找到摄像头，请改用「拍照识别条码」。';
      else if (name === 'SecurityError' || /secure|https/i.test(msg)) msg = '当前不是安全上下文，需要用 https 打开才能调用摄像头，可改用「拍照识别条码」。';
      hint.textContent = msg;
      toast(msg, 'err');
    }
  }

  function stopCamera() {
    window.BookScanner.stop(false);
    $('#btnCamStart').textContent = '▶︎ 启动摄像头';
    $('#scanHint').textContent = '摄像头已关闭，可以用拍照识别或手动输入';
  }

  async function handleScanned(code) {
    const raw = String(code || '').trim();
    if (!raw) return;
    const now = Date.now();
    if (state.lastScan.code === raw && now - state.lastScan.at < 4000) {
      window.BookScanner.resume();
      return;
    }
    state.lastScan = { code: raw, at: now };
    await lookupAndOpen({ isbn: raw });
  }

  async function lookupAndOpen(query, opts) {
    const opt = opts || {};
    const photo = opt.photo || null;
    state.draft = {
      mode: 'new',
      book: { title: '', status: state.lastStatus, tagIds: [], listIds: [], myRating: 0, progress: 0, ...query },
      currentListIds: [],
      sources: [],
      message: `<span class="spinner"></span> 正在从公开资源获取书籍信息…`,
      messageKind: '',
      photo,
    };
    $('#bookSheetTitle').textContent = '确认书籍信息';
    $('#bookSheetBody').innerHTML = `${state.draft.message ? `<div class="banner">${state.draft.message}</div>` : ''}`;
    openSheet('#sheetBook');
    try {
      const res = await api('/api/lookup', { method: 'POST', body: query });
      const record = res.record || {};
      const book = {
        title: record.title || '',
        subtitle: record.subtitle || '',
        originalTitle: record.originalTitle || '',
        authors: record.authors || [],
        translators: record.translators || [],
        publisher: record.publisher || '',
        producer: record.producer || '',
        pubdate: record.pubdate || '',
        pages: record.pages || 0,
        price: record.price || '',
        binding: record.binding || '',
        series: record.series || '',
        isbn13: record.isbn13 || query.isbn || '',
        isbn10: record.isbn10 || '',
        cover: '',
        coverRemote: record.cover || '',
        summary: record.summary || '',
        authorIntro: record.authorIntro || '',
        rating: record.rating || 0,
        ratingCount: record.ratingCount || 0,
        ratingLabel: record.ratingLabel || '',
        ratingScale: record.ratingScale || '',
        subjects: record.subjects || [],
        source: record.sourcePrimary || '',
        sourceUrl: record.sourceUrl || '',
        autoCategoryName: (record.autoCategory && record.autoCategory.name) || '未分类',
        autoCategoryColor: (record.autoCategory && record.autoCategory.color) || '#94a3b8',
        status: state.lastStatus,
        categoryId: '',
        tagIds: [],
        myRating: 0,
        progress: 0,
        location: '',
        note: '',
      };
      const message =
        record.title == null
          ? '没有找到这本书的信息，请手动填写'
          : res.cached
          ? '来自本地缓存'
          : `已获取（${(res.sources || []).filter((s) => s.ok).length} 个来源）`;
      state.draft = {
        mode: 'new',
        book: { ...book, listIds: [] },
        currentListIds: [],
        sources: res.sources || [],
        duplicate: res.duplicate || null,
        message: record.title ? message : '<b>没有找到这本书的信息</b>，可以手动填写，或改用书名搜索。',
        messageKind: record.title ? 'ok' : 'warn',
        lookup: res,
        photo,
      };
      if (!book.title && query.isbn) {
        state.draft.book.title = '';
      }
      renderBookSheet();
      if (book.coverRemote) {
        // 用代理地址预取封面，避免防盗链
        const img = new Image();
        img.src = `/api/cover?src=${encodeURIComponent(book.coverRemote)}`;
      }
    } catch (err) {
      state.draft = {
        mode: 'new',
        book: {
          title: '',
          status: state.lastStatus,
          tagIds: [],
          listIds: [],
          myRating: 0,
          progress: 0,
          isbn13: query.isbn || '',
          ...query,
        },
        currentListIds: [],
        sources: [],
        message: `抓取失败：${esc(err.message)}。可以手动填写。`,
        messageKind: 'err',
        photo,
      };
      renderBookSheet();
    }
  }

  async function searchTitles(keyword) {
    const box = $('#searchResults');
    box.innerHTML = '<div class="center"><span class="spinner"></span> 搜索中…</div>';
    try {
      const res = await api(`/api/search?q=${encodeURIComponent(keyword)}`);
      const list = res.results || [];
      if (!list.length) {
        box.innerHTML = '<div class="center">没有找到候选，试试完整书名或直接输入 ISBN</div>';
        return;
      }
      box.innerHTML = list
        .map(
          (item) => `<button class="search-item" data-pick='${esc(
            JSON.stringify({ title: item.title, author: item.author, source: item.source, id: item.id })
          )}'>
            ${item.cover ? `<img src="/api/cover?src=${encodeURIComponent(item.cover)}" alt="">` : '<div class="ph">📖</div>'}
            <div style="flex:1;min-width:0">
              <div class="t">${esc(item.title)}</div>
              <div class="s">${esc([item.author, item.publisher || item.year].filter(Boolean).join(' · ') || '—')}</div>
              <div class="src">${esc(item.sourceLabel || item.source)}</div>
            </div>
          </button>`
        )
        .join('');
    } catch (err) {
      box.innerHTML = `<div class="center">搜索失败：${esc(err.message)}</div>`;
    }
  }

  /* ---------------- 扫封面识别 ---------------- */

  function candidateHtml(c) {
    const cover = c.cover ? `/api/cover?src=${encodeURIComponent(c.cover)}` : '';
    return `<button class="search-item" data-cover-pick='${esc(
      JSON.stringify({ title: c.title, author: c.author || '', source: c.source || '', id: c.id || '', cover: c.cover || '' })
    )}'>
      ${cover ? `<img src="${esc(cover)}" alt="">` : '<div class="ph">📖</div>'}
      <div style="flex:1;min-width:0">
        <div class="t">${esc(c.title)}</div>
        <div class="s">${esc([c.author, c.publisher || c.year].filter(Boolean).join(' · ') || '—')}</div>
        <div class="src">${esc(c.sourceLabel || c.source || '')}${c.score ? ` · 匹配 ${Math.round(c.score * 100)}%` : ''}</div>
      </div>
    </button>`;
  }

  function renderCoverSheet() {
    const c = state.cover || {};
    const body = $('#coverBody');
    const photo = c.url || c.photoUrl || '';
    const head = photo ? `<div class="cover-shot"><img src="${esc(photo)}" alt="封面照片"></div>` : '';
    if (c.loading) {
      body.innerHTML = `${head}<div class="center"><span class="spinner"></span> 正在识别封面上的文字…</div>`;
      return;
    }
    const lines = (c.ocr && c.ocr.lines) || [];
    const ocrHtml = lines.length
      ? `<details class="collapse"><summary>识别到的文字（${lines.length} 行 · ${esc(c.engine || '本地 OCR')}）</summary>
          <div class="ocr-lines" style="padding-top:6px">${lines
            .map((l) => `<span>${esc(l.text)}</span>`)
            .join('')}</div></details>`
      : '';
    const candidates = c.candidates || [];
    const list = candidates.length
      ? `<div class="section-head" style="margin-top:6px"><h3>可能的书目</h3><span class="hint">选一个确认录入</span></div>
         <div class="search-results">${candidates.map(candidateHtml).join('')}</div>`
      : '';
    const searchInfo =
      c.queries && c.queries.length
        ? `<div class="hint" style="font-size:11.5px;color:var(--text-mute);margin:4px 0 8px">按识别结果搜索：${c.queries
            .map((q) => `「${esc(q)}」`)
            .join('')}</div>`
        : '';
    body.innerHTML = `${head}
      ${c.error ? `<div class="banner warn">${esc(c.error)}</div>` : ''}
      ${searchInfo}
      ${list}
      <label class="check-row"><input type="checkbox" id="usePhotoCoverChk" ${
        state.coverUseAsCover ? 'checked' : ''
      }> 查不到官方封面时，用这张封面照片当封面</label>
      <div class="scan-section">
        <div class="inline-form">
          <input type="text" id="coverTitleInput" placeholder="都不是？直接输入书名搜索">
          <button class="btn sm" id="btnCoverTitleSearch">搜索</button>
        </div>
        <button class="btn ghost block" id="btnCoverRetake" style="margin-top:8px">📷 重新拍一张</button>
      </div>`;
  }

  async function handleCoverFile(file) {
    if (!file) return;
    state.cover = { loading: true, photoUrl: URL.createObjectURL(file), candidates: [], ocr: { lines: [] } };
    renderCoverSheet();
    openSheet('#sheetCover');
    try {
      const res = await fetch('/api/cover-search', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'image/jpeg' },
        body: file,
      });
      const data = await res.json();
      state.cover = {
        loading: false,
        photoUrl: state.cover.photoUrl,
        url: data.url || '',
        token: data.token || '',
        engine: data.engine || '',
        queries: data.queries || [],
        candidates: data.candidates || [],
        ocr: data.ocr || { lines: [], text: '' },
        error: [data.error, data.hint].filter(Boolean).join('　·　'),
      };
    } catch (err) {
      state.cover = {
        loading: false,
        photoUrl: state.cover.photoUrl,
        candidates: [],
        ocr: { lines: [], text: '' },
        error: `上传失败：${err.message}`,
      };
    }
    renderCoverSheet();
  }

  async function searchCoverByTitle(keyword) {
    if (!keyword) return;
    state.cover = { ...(state.cover || {}), loading: true, error: '' };
    renderCoverSheet();
    try {
      const res = await api(`/api/search?q=${encodeURIComponent(keyword)}`);
      state.cover = {
        ...state.cover,
        loading: false,
        queries: [keyword],
        candidates: res.results || [],
        error: (res.results || []).length ? '' : '没搜到候选，换个关键词试试',
      };
    } catch (err) {
      state.cover = { ...state.cover, loading: false, error: err.message };
    }
    renderCoverSheet();
  }

  /* ---------------- 书单 ---------------- */

  function listById(id) {
    return state.booklists.find((l) => l.id === id) || null;
  }

  function listsOfBook(bookId) {
    return state.booklists.filter((l) => (l.items || []).some((i) => i.bookId === bookId)).map((l) => l.id);
  }

  /** 按书单设定的排序方式排列成员 */
  function sortListItems(list) {
    const byId = new Map(state.books.map((b) => [b.id, b]));
    const rows = (list.items || [])
      .map((it) => ({ item: it, book: byId.get(it.bookId) }))
      .filter((r) => r.book);
    const year = (b) => {
      const m = String(b.pubdate || '').match(/\d{4}/);
      return m ? Number(m[0]) : 0;
    };
    const statusRank = (b) => {
      const i = STATUS_ORDER.indexOf(b.status);
      return i < 0 ? 99 : i;
    };
    const sort = list.sort || 'added-desc';
    rows.sort((a, b) => {
      switch (sort) {
        case 'added-asc':
          return String(a.item.addedAt).localeCompare(String(b.item.addedAt));
        case 'rating-desc':
          return (b.book.rating || b.book.myRating || 0) - (a.book.rating || a.book.myRating || 0);
        case 'myrating-desc':
          return (b.book.myRating || 0) - (a.book.myRating || 0) || (b.book.rating || 0) - (a.book.rating || 0);
        case 'title-asc':
          return String(a.book.title).localeCompare(String(b.book.title), 'zh-Hans-CN');
        case 'author-asc':
          return String((a.book.authors || [])[0] || '').localeCompare(String((b.book.authors || [])[0] || ''), 'zh-Hans-CN');
        case 'pubdate-desc':
          return year(b.book) - year(a.book);
        case 'pubdate-asc':
          return year(a.book) - year(b.book);
        case 'status-asc':
          return statusRank(a.book) - statusRank(b.book) || String(a.item.addedAt).localeCompare(String(b.item.addedAt));
        default:
          return String(b.item.addedAt).localeCompare(String(a.item.addedAt));
      }
    });
    return rows;
  }

  function renderLists() {
    if (state.mode === 'movie') return renderMovieLists();
    $('#listsTitle').textContent = '我的书单';
    const lists = state.booklists;
    const creating = state.creatingList
      ? `<div class="section" style="background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--radius);padding:12px">
          <div class="inline-form">
            <input type="text" id="newListName" placeholder="书单名称，例如「明朝那些事」" maxlength="24">
          </div>
          <div class="inline-form" style="margin-top:8px">
            <input type="text" id="newListDesc" placeholder="一句话说明（可选）" maxlength="60">
          </div>
          <div class="palette" id="listPalette">${PALETTE.map(
            (c) => `<button data-color="${c}" class="${state.newListColor === c ? 'on' : ''}" style="background:${c}"></button>`
          ).join('')}</div>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn" data-act="list-create">创建书单</button>
            <button class="btn ghost" data-act="list-cancel">取消</button>
          </div>
        </div><div style="height:12px"></div>`
      : `<button class="btn block" data-act="list-new">＋ 新建书单</button><div style="height:12px"></div>`;

    const cards = lists
      .map((l) => {
        const st = l.stats || { total: 0, finished: 0, progress: 0 };
        const covers = sortListItems(l).slice(0, 5);
        return `<button class="list-card" data-act="list-open" data-id="${esc(l.id)}">
          <div class="head-row">
            <span class="swatch" style="background:${esc(l.color || '#2563eb')}"></span>
            <span class="name">${esc(l.name)}</span>
            <span class="ratio">${st.finished}/${st.total}</span>
          </div>
          ${l.description ? `<div class="desc">${esc(l.description)}</div>` : ''}
          <div class="bar"><i style="width:${st.progress || 0}%;background:${esc(l.color || '#2563eb')}"></i></div>
          ${
            covers.length
              ? `<div class="covers">${covers
                  .map((r) => {
                    const c = coverSrc(r.book);
                    return c ? `<img loading="lazy" src="${esc(c)}" alt="">` : '<div class="ph">📖</div>';
                  })
                  .join('')}</div>`
              : ''
          }
          <div class="meta-line">已读 ${st.finished} / 共 ${st.total}（${st.progress || 0}%）${
          st.reading ? ` · 在读 ${st.reading}` : ''
        }${st.unread ? ` · 未读 ${st.unread}` : ''}</div>
        </button>`;
      })
      .join('');

    $('#listsBody').innerHTML = `${creating}${
      lists.length
        ? cards
        : `<div class="empty"><div class="big">🗂️</div><p>还没有书单</p><p>把同一主题的书归到一起，例如<br>「明朝那些事系列」「待读的商业书」</p></div>`
    }`;
  }

  function listItemHtml(book, listId) {
    const cover = coverSrc(book);
    const st = state.statuses[book.status] || { label: book.status, color: '#94a3b8' };
    return `<div class="list-item">
      <button class="li-main" data-act="book-open" data-id="${esc(book.id)}">
        <div class="cover">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '📖'}</div>
        <div class="info">
          <div class="t">${esc(book.title)}</div>
          <div class="s">${esc((book.authors || []).join(' / ') || '—')}${
      book.pubdate ? ` · ${esc(book.pubdate)}` : ''
    }${book.publisher ? ` · ${esc(book.publisher)}` : ''}</div>
          <div class="tags">
            <span class="badge" style="background:${esc(st.color)}">${esc(st.label)}</span>
            ${book.rating ? `<span class="stars">${starsText(book.rating)}</span><span class="s">${book.rating}</span>` : ''}
            ${
              book.myRating
                ? `<span class="stars">${starsText(book.myRating, true)}</span><span class="s">我的 ${book.myRating}</span>`
                : ''
            }
          </div>
        </div>
      </button>
      <button class="li-remove" data-act="list-remove" data-id="${esc(listId)}" data-book="${esc(book.id)}" title="移出书单">✕</button>
    </div>`;
  }

  function renderListDetail(listId) {
    const l = listById(listId);
    if (!l) {
      renderLists();
      return;
    }
    state.currentListId = listId;
    const st = l.stats || { total: 0, finished: 0, progress: 0 };
    const rows = sortListItems(l);
    const sorts = state.booklistSorts || {};
    $('#listsTitle').textContent = '书单';
    $('#listsBody').innerHTML = `
      <button class="btn ghost sm" data-act="list-back">‹ 全部书单</button>
      <div style="height:10px"></div>
      <div class="list-detail-head">
        <div class="title-row">
          <span class="swatch" style="width:12px;height:12px;border-radius:50%;background:${esc(l.color || '#2563eb')}"></span>
          <h2>${esc(l.name)}</h2>
          <button class="btn sm ghost" data-act="list-edit" data-id="${esc(l.id)}">编辑</button>
        </div>
        ${l.description ? `<p class="desc">${esc(l.description)}</p>` : ''}
        <div class="progress-row">
          <span class="ratio">${st.finished}/${st.total}<small>已读 / 共</small></span>
          <div class="bar"><i style="width:${st.progress || 0}%;background:${esc(l.color || '#2563eb')}"></i></div>
        </div>
        <div class="breakdown">
          <span class="pill">已读 ${st.finished || 0}</span>
          <span class="pill">未读 ${st.unread || 0}</span>
          <span class="pill">在读 ${st.reading || 0}</span>
          <span class="pill">想读 ${st.wish || 0}</span>
          <span class="pill">已购未读 ${st.owned || 0}</span>
          ${st.dropped ? `<span class="pill">弃读 ${st.dropped}</span>` : ''}
        </div>
      </div>
      <div class="field">
        <label>排序方式</label>
        <select id="listSort">
          ${Object.keys(sorts)
            .map((k) => `<option value="${esc(k)}" ${l.sort === k ? 'selected' : ''}>${esc(sorts[k])}</option>`)
            .join('')}
        </select>
      </div>
      <div class="btn-row" style="margin-bottom:14px">
        <button class="btn" data-act="list-add" data-id="${esc(l.id)}">＋ 添加 / 管理书籍</button>
        <button class="btn danger" data-act="list-delete" data-id="${esc(l.id)}">删除书单</button>
      </div>
      <div class="section-head"><h3>书目</h3><span class="hint">共 ${rows.length} 本</span></div>
      ${
        rows.length
          ? rows.map((r) => listItemHtml(r.book, l.id)).join('')
          : '<div class="center">书单还是空的，点上面「添加 / 管理书籍」</div>'
      }`;
  }

  function drawListPicker() {
    const lp = state.listPick;
    if (!lp) return;
    const l = listById(lp.listId);
    if (!l) return;
    const sortOptions = (() => {
      const out = [];
      for (const k of Object.keys(BOOK_SORTS)) {
        out.push([k, BOOK_SORTS[k]]);
        if (k === 'added-asc') out.push(['members-first', '已在书单优先']);
      }
      const cur = lp.sort || 'added-desc';
      return out
        .map(([k, label]) => `<option value="${esc(k)}" ${cur === k ? 'selected' : ''}>${esc(label)}</option>`)
        .join('');
    })();

    $('#listPickTitle').textContent = `${l.name} · 选择书籍`;
    $('#listPickBody').innerHTML = `
      <div class="field-row" style="margin-bottom:10px;align-items:center">
        <input id="listPickSearch" type="search" placeholder="搜索书架里的书" value="${esc(lp.query)}"
          style="flex:1;min-width:0;height:38px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);padding:0 10px;outline:none">
        <select id="listPickSort" title="排序方式"
          style="flex:0 0 138px;height:38px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);padding:0 8px;font-size:13px;color:var(--text-dim)">${sortOptions}</select>
      </div>
      <div class="hint" style="font-size:12px;color:var(--text-mute);margin-bottom:8px">
        已选 <b id="listPickCount">${lp.selected.size}</b> 本；取消勾选即从书单移出
      </div>
      <div id="listPickRows" style="max-height:46vh;overflow:auto;border:1px solid var(--line);border-radius:12px"></div>
      <div class="sticky-bar">
        <button class="btn ghost" data-act="pick-all">全选</button>
        <button class="btn ghost" data-act="pick-none">清空</button>
        <button class="btn" data-act="pick-save">完成</button>
      </div>`;
    renderListPickRows();
  }

  /** 只重画书单挑片的列表（保住输入框，避免中文输入法组字被打断） */
  function renderListPickRows() {
    const lp = state.listPick;
    const wrap = $('#listPickRows');
    if (!lp || !wrap) return;
    const l = listById(lp.listId);
    if (!l) return;
    const q = lp.query.trim().toLowerCase();
    const inList = new Set((l.items || []).map((i) => i.bookId));
    const sortKey = lp.sort || 'added-desc';
    let books = state.books.filter(
      (b) =>
        !q ||
        [b.title, (b.authors || []).join(' '), b.publisher, b.isbn13, b.autoCategoryName]
          .join(' ')
          .toLowerCase()
          .indexOf(q) >= 0
    );
    if (sortKey === 'members-first') {
      books = books
        .slice()
        .sort(
          (a, b) =>
            (inList.has(b.id) ? 1 : 0) - (inList.has(a.id) ? 1 : 0) ||
            String(b.addedAt).localeCompare(String(a.addedAt))
        );
    } else {
      books = sortBooks(books, sortKey);
    }
    const showDate = sortKey === 'added-desc' || sortKey === 'added-asc';
    wrap.innerHTML = books.length
      ? books
          .map((b) => {
            const cover = coverSrc(b);
            const search = [b.title, (b.authors || []).join(' '), b.publisher, b.isbn13, b.autoCategoryName]
              .join(' ')
              .toLowerCase();
            const sub = [
              (b.authors || []).join(' / ') || '—',
              showDate && b.addedAt ? `${String(b.addedAt).slice(0, 10)} 加入` : '',
              inList.has(b.id) ? '已在书单' : '',
            ]
              .filter(Boolean)
              .join(' · ');
            return `<label class="pick-item" data-search="${esc(search)}">
              <input type="checkbox" data-pick-id="${esc(b.id)}" ${lp.selected.has(b.id) ? 'checked' : ''}>
              <div class="cover">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '📖'}</div>
              <div class="info"><div class="t">${esc(b.title)}</div><div class="s">${esc(sub)}</div></div>
              </label>`;
          })
          .join('')
      : '<div class="center">没有匹配的书</div>';
    const c = $('#listPickCount');
    if (c) c.textContent = lp.selected.size;
  }

function openListPicker(listId) {
    const l = listById(listId);
    if (!l) return;
    state.listPick = {
      listId,
      selected: new Set((l.items || []).map((i) => i.bookId)),
      query: '',
      // 默认按"最近加入书架"排在最前，记住上次选择
      sort: localStorage.getItem('bn.listPickSort') || 'added-desc',
    };
    drawListPicker();
    openSheet('#sheetListPick');
  }

  async function applyListPick() {
    const lp = state.listPick;
    if (!lp) return;
    const l = listById(lp.listId);
    if (!l) return;
    const current = new Set((l.items || []).map((i) => i.bookId));
    const toAdd = [...lp.selected].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !lp.selected.has(id));
    try {
      if (toAdd.length) await api(`/api/booklists/${l.id}/books`, { method: 'POST', body: { bookIds: toAdd } });
      if (toRemove.length) {
        await api(`/api/booklists/${l.id}/books/remove`, { method: 'POST', body: { bookIds: toRemove } });
      }
      toast(`书单已更新：加入 ${toAdd.length} 本，移出 ${toRemove.length} 本`);
      await refresh();
      closeSheet('#sheetListPick');
      renderListDetail(l.id);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function createBooklist() {
    const name = ($('#newListName') || {}).value ? $('#newListName').value.trim() : '';
    const description = ($('#newListDesc') || {}).value ? $('#newListDesc').value.trim() : '';
    if (!name) {
      toast('请填写书单名称', 'err');
      return;
    }
    try {
      const res = await api('/api/booklists', {
        method: 'POST',
        body: { name, description, color: state.newListColor },
      });
      state.creatingList = false;
      await refresh();
      renderListDetail(res.booklist.id);
      toast(`书单「${name}」已创建，点「添加 / 管理书籍」加书`);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function editBooklistFlow(listId) {
    const l = listById(listId);
    if (!l) return;
    const name = window.prompt('书单名称', l.name);
    if (name === null) return;
    if (!name.trim()) {
      toast('书单名不能为空', 'err');
      return;
    }
    const description = window.prompt('书单说明（可留空）', l.description || '');
    if (description === null) return;
    try {
      await api(`/api/booklists/${l.id}`, { method: 'PATCH', body: { name: name.trim(), description: description.trim() } });
      await refresh();
      renderListDetail(l.id);
      toast('已保存');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* ---------------- 作者 / 译者作品 ---------------- */

  async function openAuthorBooks(name) {
    state.author = { name, loading: true, items: [], total: 0, sources: [] };
    renderAuthorSheet();
    openSheet('#sheetAuthor');
    try {
      const res = await api(`/api/author-books?name=${encodeURIComponent(name)}`);
      state.author = {
        name: res.name || name,
        loading: false,
        items: res.items || [],
        total: res.total || 0,
        sources: res.sources || [],
        error: res.error || '',
      };
    } catch (err) {
      state.author = { name, loading: false, items: [], total: 0, sources: [], error: err.message };
    }
    renderAuthorSheet();
  }

  function renderAuthorSheet() {
    const a = state.author || {};
    $('#authorTitle').textContent = a.name ? `${a.name} 的作品` : '作者作品';
    const body = $('#authorBody');
    if (a.loading) {
      body.innerHTML = '<div class="center"><span class="spinner"></span> 正在从豆瓣 / 微信读书 / Open Library 查找…</div>';
      return;
    }
    const items = a.items || [];
    if (a.error && !items.length) {
      body.innerHTML = `<div class="banner warn">查找失败：${esc(a.error)}</div>`;
      return;
    }
    const ownedCount = items.filter((x) => x.owned).length;
    const head = `<div class="author-head">
        <h3>${esc(a.name || '')}</h3>
        <div class="hint">共 ${a.total || items.length} 部作品${
      a.sources && a.sources.length ? ` · 来源：${esc(a.sources.join(' / '))}` : ''
    }${ownedCount ? ` · 书架里已有 ${ownedCount} 部` : ''}</div>
      </div>`;
    const rows = items
      .map((it) => {
        const cover = anyCoverSrc(it);
        return `<button class="author-item" data-act="author-pick" data-title="${esc(it.title)}" data-source="${esc(
          it.source || ''
        )}" data-sid="${esc(it.id || '')}" data-owned="${it.owned ? '1' : ''}" data-bookid="${esc(it.bookId || '')}">
          <div class="cover">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '📖'}</div>
          <div class="info">
            <div class="t">${esc(it.title)}</div>
            <div class="s">${esc([it.year, it.publisher].filter(Boolean).join(' · ') || '—')}</div>
            <div class="meta">
              ${it.rating ? `<span class="stars">${starsText(it.rating)}</span><span class="s">${it.rating}</span>` : ''}
              <span class="src" style="font-size:10.5px;color:var(--brand);background:var(--brand-soft);padding:1px 6px;border-radius:999px">${esc(
          it.sourceLabel || ''
        )}</span>
            </div>
          </div>
          <span class="act ${it.owned ? 'owned' : ''}">${it.owned ? '已在书架' : '＋ 加入'}</span>
        </button>`;
      })
      .join('');
    body.innerHTML = `${head}${
      items.length ? rows : '<div class="center">没有找到这位作者的书</div>'
    }`;
  }

  /* ---------------- 分类 / 标签管理 ---------------- */

  function renderManage() {
    const catCount = (id) => state.books.filter((b) => b.categoryId === id).length;
    const tagCount = (id) => state.books.filter((b) => (b.tagIds || []).indexOf(id) >= 0).length;
    const autoCount = state.books.filter((b) => !b.categoryId).length;
    $('#manageBody').innerHTML = `
      <div class="section">
        <div class="section-head"><h3>分类</h3><span class="hint">共 ${state.categories.length} 个</span></div>
        ${state.categories
          .map(
            (c) => `<div class="manage-item" data-cat="${esc(c.id)}">
              <button class="swatch" data-action="edit-cat-color" style="background:${esc(c.color)}"></button>
              <div class="name">${esc(c.name)}</div>
              <div class="count">${catCount(c.id)} 本</div>
              <button data-action="rename-cat">改名</button>
              <button class="del" data-action="del-cat">删除</button>
            </div>`
          )
          .join('')}
        <div class="inline-form" style="margin-top:10px">
          <input type="text" id="newCatInput" placeholder="新分类名称" maxlength="16">
          <button class="btn sm" data-action="add-cat">添加</button>
        </div>
        <div class="palette" id="catPalette">${PALETTE.map((c) => `<button data-color="${c}" style="background:${c}"></button>`).join('')}</div>
        ${autoCount ? `<button class="btn ghost sm" style="margin-top:10px" data-action="auto-categorize">⚡ 为 ${autoCount} 本未分类的书套用自动分类</button>` : ''}
      </div>
      <div class="section">
        <div class="section-head"><h3>标签</h3><span class="hint">名称 + 颜色，一本书可以有多个</span></div>
        ${state.tags
          .map(
            (t) => `<div class="manage-item" data-tag="${esc(t.id)}">
              <button class="swatch" data-action="edit-tag-color" style="background:${esc(t.color)}"></button>
              <div class="name">${esc(t.name)}</div>
              <div class="count">${tagCount(t.id)} 本</div>
              <button data-action="rename-tag">改名</button>
              <button class="del" data-action="del-tag">删除</button>
            </div>`
          )
          .join('')}
        <div class="inline-form" style="margin-top:10px">
          <input type="text" id="newTagInput" placeholder="新标签名称" maxlength="16">
          <button class="btn sm" data-action="add-tag">添加</button>
        </div>
        <div class="palette" id="tagPalette">${PALETTE.map((c) => `<button data-color="${c}" style="background:${c}"></button>`).join('')}</div>
      </div>`;
    $$('#catPalette button, #tagPalette button').forEach((b) => b.classList.remove('on'));
  }

  /* ---------------- 统计 ---------------- */

  function renderStats() {
    if (state.mode === 'movie') return renderMovieStats();
    const s = state.stats || {};
    const max = (arr) => Math.max(1, ...arr.map((x) => x.count));
    const byCat = s.byCategory || [];
    const byTag = s.byTag || [];
    $('#statsBody').innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="num">${s.total || 0}</div><div class="lbl">藏书总数</div></div>
        <div class="stat-card"><div class="num">${(s.byStatus || {}).finished || 0}</div><div class="lbl">读过</div></div>
        <div class="stat-card"><div class="num">${(s.byStatus || {}).reading || 0}</div><div class="lbl">在读</div></div>
        <div class="stat-card"><div class="num">${(s.byStatus || {}).wish || 0}</div><div class="lbl">想读</div></div>
        <div class="stat-card"><div class="num">${(s.byStatus || {}).owned || 0}</div><div class="lbl">已购未读</div></div>
        <div class="stat-card"><div class="num">${s.pages || 0}</div><div class="lbl">总页数</div></div>
        <div class="stat-card"><div class="num">${s.finishedPages || 0}</div><div class="lbl">已读页数</div></div>
        <div class="stat-card"><div class="num">${s.avgMyRating || 0}</div><div class="lbl">平均我的评分</div></div>
      </div>
      <div class="section"><div class="section-head"><h3>阅读状态</h3></div>
        ${STATUS_ORDER.map((key) => {
          const st = state.statuses[key] || { label: key, color: '#94a3b8' };
          const n = (s.byStatus || {})[key] || 0;
          return `<div class="bar-row"><div class="top"><span>${esc(st.label)}</span><span>${n}</span></div>
            <div class="bar"><i style="width:${s.total ? (n / s.total) * 100 : 0}%;background:${esc(st.color)}"></i></div></div>`;
        }).join('')}
      </div>
      <div class="section"><div class="section-head"><h3>分类分布</h3><span class="hint">含自动分类</span></div>
        ${byCat.length ? byCat.map((c) => `<div class="bar-row"><div class="top"><span>${esc(c.name)}</span><span>${c.count}</span></div>
          <div class="bar"><i style="width:${(c.count / max(byCat)) * 100}%;background:${esc(c.color)}"></i></div></div>`).join('') : '<div class="center">暂无数据</div>'}
      </div>
      <div class="section"><div class="section-head"><h3>标签使用</h3></div>
        <div class="picker">${byTag.length ? byTag.map((t) => `<span class="tag-pill" style="background:${esc(t.color)}">${esc(t.name)} ${t.count}</span>`).join('') : '<span class="hint">还没有使用标签</span>'}</div>
      </div>`;
  }

  /* ---------------- 设置 ---------------- */

  function renderSettings() {
    const srv = state.server || {};
    const px = srv.proxy || {};
    const storedProxyUrl = (px.stored && px.stored.url) || '';
    const urls = [];
    if (srv.lan && srv.lan.length) {
      for (const ni of srv.lan) {
        urls.push(`${srv.httpsEnabled ? 'https' : 'http'}://${ni.address}:${srv.httpsEnabled ? srv.httpsPort : srv.httpPort}`);
      }
    }
    const current = location.origin;
    $('#settingsBody').innerHTML = `
      <div class="section">
        <div class="section-head"><h3>手机访问</h3><span class="hint">同一 Wi-Fi 下扫码打开</span></div>
        <div class="qr-wrap"><div id="qrBox"></div><div class="qr-url">${esc(current)}</div></div>
        <div style="margin-top:10px">
          ${urls.map((u) => `<div class="kv"><span class="k">局域网地址</span><span class="v">${esc(u)}</span></div>`).join('')}
          <div class="kv"><span class="k">摄像头要求</span><span class="v">https 或 localhost；否则用拍照识别</span></div>
        </div>
      </div>
      <div class="section">
        <div class="section-head"><h3>网络代理</h3><span class="hint">国内访问海外数据源</span></div>
        <div class="kv"><span class="k">当前状态</span><span class="v">${
          px.active
            ? `✅ 已启用 ${esc(px.url)}`
            : storedProxyUrl
            ? `已保存 ${esc(storedProxyUrl)}，重启后生效`
            : '未启用'
        }</span></div>
        <div class="inline-form" style="margin-top:8px">
          <input type="text" id="proxyUrl" placeholder="http://127.0.0.1:7890" value="${esc(
            storedProxyUrl || px.url || 'http://127.0.0.1:7890'
          )}">
          <button class="btn sm" data-action="save-proxy">保存</button>
        </div>
        <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">
          代理只在<strong>进程启动时</strong>生效，保存后需重启服务。<br>
          用 <code>./start.sh</code> 启动时会自动读取这里保存的代理；<strong>用 systemd 部署时这里填了不生效</strong>，
          需要在 <code>booknest.service</code> 里设置 <code>NODE_USE_ENV_PROXY=1</code> 与 <code>HTTPS_PROXY</code>（详见部署文档 §9.5）。
        </div>
        <div class="inline-form" style="margin-top:10px">
          <input type="text" id="googleKey" placeholder="${
            state.settings.googleBooksApiKeySet ? '已配置（留空则不修改）' : 'Google Books API Key（可选）'
          }" value="">
          <button class="btn sm" data-action="save-gkey">保存</button>
          ${
            state.settings.googleBooksApiKeySet
              ? '<button class="btn sm ghost" data-action="clear-gkey">清除</button>'
              : ''
          }
        </div>
        <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">
          Google Books 的匿名配额常被用尽（返回 429）；填一个免费 API Key 后立即生效，可用来补齐海外书目信息。
        </div>
        <div class="inline-form" style="margin-top:10px">
          <input type="text" id="tmdbKey" placeholder="${
            state.settings.tmdbApiKeySet ? '已配置（留空则不修改）' : 'TMDb API Key（影片，可选）'
          }" value="">
          <button class="btn sm" data-action="save-tmdb">保存</button>
          ${state.settings.tmdbApiKeySet ? '<button class="btn sm ghost" data-action="clear-tmdb">清除</button>' : ''}
        </div>
        <div class="inline-form" style="margin-top:8px">
          <input type="text" id="omdbKey" placeholder="${
            state.settings.omdbApiKeySet ? '已配置（留空则不修改）' : 'OMDb API Key（IMDb 详情，可选）'
          }" value="">
          <button class="btn sm" data-action="save-omdb">保存</button>
          ${state.settings.omdbApiKeySet ? '<button class="btn sm ghost" data-action="clear-omdb">清除</button>' : ''}
        </div>
        <div class="inline-form" style="margin-top:8px">
          <input type="text" id="doubanCookie" placeholder="${
            state.settings.doubanCookieSet ? '已配置（留空则不修改）' : '豆瓣 Cookie（可选）'
          }" value="">
          <button class="btn sm" data-action="save-douban-cookie">保存</button>
          ${
            state.settings.doubanCookieSet
              ? '<button class="btn sm ghost" data-action="clear-douban-cookie">清除</button>'
              : ''
          }
        </div>
        <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">
          <b>豆瓣 Cookie（可选）</b>：豆瓣对机房/高频 IP 会软封禁电影搜索，报错原文就是"请登录再试"。
          浏览器登录豆瓣后按 F12 → Network → 点任意一个 douban.com 请求 → 复制 Request Headers 里整条
          <code>Cookie:</code> 的值粘到这里即可恢复。只在本地保存、不会回传页面。
        </div>
        <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">
          为安全起见，已保存的 Key <b>不会回传到页面</b>（只显示"已配置"）；重新填写即覆盖，点「清除」删除。<br>
          影片默认用豆瓣（中文片最全，无需 Key）+ IMDb 联想接口；填 TMDb Key 可补全海外片详情与推荐，
          填 OMDb Key 可用 IMDb 数据补全剧情与 IMDb 评分。云端部署可用环境变量
          <code>BOOKNEST_TMDB_KEY</code> / <code>BOOKNEST_OMDB_KEY</code> 注入，Key 就不会写进数据库。
        </div>
      </div>
      <div class="section">
        <div class="section-head"><h3>分类与标签</h3><button class="btn sm ghost" data-action="open-manage">打开管理</button></div>
        <div class="hint" style="font-size:11.5px;color:var(--text-mute)">
          增删改书籍分类与标签（名称 + 颜色），也能一键为未分类的书套用自动分类。
        </div>
      </div>
      <div class="section">
        <div class="section-head"><h3>豆瓣同步</h3></div>
        <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-bottom:8px">
          用上面填的豆瓣 Cookie，把你豆瓣上的<b>想读 / 在读 / 读过</b>和<b>想看 / 在看 / 看过</b>同步进来。
          按豆瓣条目 id 或片名去重，<b>只新增、不动你已有的记录</b>；勾选下面的选项才会更新已有条目的状态。
          封面先用豆瓣图床地址（经本机代理显示），不占用磁盘。
        </div>
        <label class="row" style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-dim);margin-bottom:8px">
          <input type="checkbox" id="syncUpdateExisting" ${state.settings.syncUpdateExisting ? 'checked' : ''}>
          同时更新已有条目的状态
        </label>
        <div class="btn-row">
          <button class="btn ghost sm" data-action="douban-sync-book" ${state.settings.doubanCookieSet ? '' : 'disabled'}>同步豆瓣读书</button>
          <button class="btn ghost sm" data-action="douban-sync-movie" ${state.settings.doubanCookieSet ? '' : 'disabled'}>同步豆瓣影视</button>
        </div>
        ${
          state.settings.doubanCookieSet
            ? ''
            : '<div class="hint" style="font-size:11.5px;color:#f59e0b;margin-top:6px">需要先在上面填写「豆瓣 Cookie」才能同步</div>'
        }
        <div id="doubanSyncResult" style="font-size:12px;color:var(--text-mute);margin-top:8px"></div>
      </div>
      <div class="section">
        <div class="section-head"><h3>影片数据源</h3><button class="btn sm ghost" data-action="check-movie-providers">重新检测</button></div>
        <div class="src-list">
          ${
            (state.movieSources || []).length
              ? state.movieSources
                  .map(
                    (p) => `<div class="row"><span class="led ${p.ok ? 'ok' : 'bad'}"></span>
                      <b style="color:var(--text-dim)">${esc(p.label)}</b>
                      <span>${
                        p.ok ? `可用 · 命中 ${p.count} 条${p.ms ? ` · ${p.ms}ms` : ''}` : esc(p.error || '不可用')
                      }</span>
                    </div>`
                  )
                  .join('')
              : '<div class="hint" style="font-size:12px">点「重新检测」查看豆瓣电影 / IMDb / TMDb 的可用性（TMDb 需要先填 API Key）</div>'
          }
        </div>
      </div>
      <div class="section">
        <div class="section-head"><h3>数据源</h3><button class="btn sm ghost" data-action="check-providers">重新检测</button></div>
        <div class="src-list">
          ${(state.providers || [])
            .map(
              (p) =>
                `<div class="row"><span class="led ${p.ok === false ? 'bad' : p.ok ? 'ok' : ''}"></span>
                  <b style="color:var(--text-dim)">${esc(p.label)}</b>
                  <span>${p.ok === false ? `不可用 · ${esc(p.error || '')}` : p.ok ? `${p.ms}ms` : '未检测'}${
                  p.needsKey && p.ok !== true ? '（填 API Key 可恢复）' : ''
                }</span>
                </div>`
            )
            .join('')}
          <div class="row"><span class="led ok"></span><b style="color:var(--text-dim)">豆瓣读书</b><span>网页解析（默认可用，直连）</span></div>
          <div class="row"><span class="led ok"></span><b style="color:var(--text-dim)">微信读书</b><span>公开搜索接口（直连）</span></div>
        </div>
        <div class="hint" style="margin-top:8px;font-size:11.5px;color:var(--text-mute)">
          说明：书籍信息来自上述公开资源，仅用于个人藏书管理；抓取结果会缓存在本地，同一本书不会反复请求。
        </div>
        <div class="kv" style="margin-top:10px"><span class="k">封面文字识别</span><span class="v">${
          srv.ocr && srv.ocr.ok ? esc(srv.ocr.label) : '不可用'
        }</span></div>
        ${
          srv.ocr && (!srv.ocr.ok || srv.ocr.hint)
            ? `<div class="hint" style="font-size:11.5px;color:var(--text-mute)">${esc(
                srv.ocr.hint || srv.ocr.reason || ''
              )}</div>`
            : ''
        }
        <div class="kv"><span class="k">运行环境</span><span class="v">${esc(srv.platform || '')} · Node ${esc(
      srv.node || ''
    )}</span></div>
        <div class="kv"><span class="k">访问密码</span><span class="v">${
      srv.authEnabled ? '已开启（BOOKNEST_PASSWORD）' : '未设置（本机自用可不开）'
    }</span></div>
      </div>
      <div class="section">
        <div class="section-head"><h3>数据管理</h3></div>
        <div class="btn-row"><a class="btn ghost" href="/api/export?format=json" download>导出 JSON</a>
        <a class="btn ghost" href="/api/export?format=csv" download>导出 CSV</a></div>
        <div class="btn-row"><button class="btn ghost" data-action="import-json">导入 JSON 备份</button>
        <button class="btn ghost" data-action="clear-cache">清空元数据缓存</button></div>
        <input type="file" id="importFile" accept="application/json,.json" class="hidden">
        <div class="kv"><span class="k">数据文件</span><span class="v">${esc((state.stats || {}).dataFile || '')}</span></div>
        <div class="kv"><span class="k">缓存条目</span><span class="v">${(state.stats || {}).cacheEntries || 0}</span></div>
      </div>
      <div class="section">
        <div class="section-head"><h3>录入偏好</h3></div>
        <div class="kv"><span class="k">新增时自动套用推荐分类</span>
          <button class="btn sm ${state.settings.autoCategoryOnCreate === false ? 'ghost' : ''}" data-action="toggle-autocat">
            ${state.settings.autoCategoryOnCreate === false ? '已关闭' : '已开启'}</button></div>
        <div class="kv"><span class="k">默认状态</span><span class="v">${esc((state.statuses[state.lastStatus] || {}).label || '想读')}</span></div>
      </div>
      <div class="section">
        <div class="section-head"><h3>关于</h3></div>
        <div class="kv"><span class="k">书巢 BookNest</span><span class="v">本地藏书管理 · 数据全部存在你自己电脑上</span></div>
        <div class="kv"><span class="k">危险操作</span>
          <button class="btn sm danger" data-action="wipe">清空全部数据</button></div>
      </div>`;

    const box = $('#qrBox');
    if (box && window.QRCode) {
      box.innerHTML = '';
      new window.QRCode(box, { text: current, width: 168, height: 168, correctLevel: window.QRCode.CorrectLevel.M });
    }
  }

  /* ---------------- 事件 ---------------- */

  function bindEvents() {
    $('#backdrop').addEventListener('click', () => {
      closeAllSheets();
      window.BookScanner.stop(false);
      state.draft = null;
    });
    $$('[data-close]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const sheet = btn.closest('.sheet');
        const sheetId = sheet ? sheet.id : '';
        closeSheet('#' + sheetId);
        // 只清掉"这一层"自己的状态；详情层的草稿不能被别的弹层关闭动作清掉，
        // 否则关掉作者列表后，详情页里的所有点击都会因为 state.draft 为空而失效
        if (sheetId === 'sheetScan') window.BookScanner.stop(false);
        else if (sheetId === 'sheetBook') state.draft = null;
        else if (sheetId === 'sheetAuthor') state.author = null;
        else if (sheetId === 'sheetCover') state.cover = null;
        else if (sheetId === 'sheetListPick') state.listPick = null;
        else if (sheetId === 'sheetMovie') {
          state.movieDraft = null;
          state.movieCollection = null;
        }
        else if (sheetId === 'sheetMovieSearch')
          state.movieSearch = { q: '', results: [], sources: [], sourceStatus: [], busy: false, error: '' };
        else if (sheetId === 'sheetMovieListPick') state.movieListPick = null;
        else if (sheetId === 'sheetPerson') state.person = null;
        else if (sheetId === 'sheetSeries') state.seriesPick = null;
      })
    );

    $('#tabbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      const tab = btn.dataset.tab;

      // 「书 / 影」是一级菜单：切模式并回到列表页
      if (tab === 'books' || tab === 'movies') {
        const mode = tab === 'books' ? 'book' : 'movie';
        window.BookScanner.stop(false);
        closeAllSheets();
        state.draft = null;
        state.listPick = null;
        state.movieDraft = null;
        state.movieCurrentListId = '';
        if (mode !== state.mode) {
          state.mode = mode;
          localStorage.setItem('bn.mode', mode);
        }
        setActiveTab(tab);
        renderAll();
        renderLists();
        renderStats();
        return;
      }

      $$('#tabbar button').forEach((b) => b.classList.toggle('active', b === btn));
      if (tab !== 'add') state.draft = null;
      closeAllSheets();
      if (tab === 'add') {
        if (state.mode === 'movie') {
          openMovieSearch();
          return;
        }
        openSheet('#sheetScan');
        renderSession();
        if (window.BookScanner.isRunning()) window.BookScanner.resume();
        else startCamera();
      } else if (tab === 'lists') {
        state.creatingList = false;
        state.creatingMovieList = false;
        renderLists();
        openSheet('#sheetLists');
      } else if (tab === 'stats') {
        renderStats();
        openSheet('#sheetStats');
      } else if (tab === 'settings') {
        renderSettings();
        openSheet('#sheetSettings');
      }
    });

    /** 高亮一级菜单（书 / 影 由当前模式决定） */
    function setActiveTab(tab) {
      $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    }

    // 书架交互
    $('#view').addEventListener('click', (e) => {
      const stBadge = e.target.closest('[data-mstat]');
      if (stBadge) {
        e.stopPropagation();
        const id = stBadge.dataset.mstat;
        const m = movieById(id);
        if (m) openMiniMenu(stBadge, movieStatusMenuItems(m.status), (key) => setMovieStatus(id, key), '观看状态');
        return;
      }
      const movieBtn = e.target.closest('[data-movie]');
      if (movieBtn) {
        openMovieSheet(movieBtn.dataset.movie);
        return;
      }
      const bookBtn = e.target.closest('[data-book]');
      if (bookBtn) {
        openBookDetail(bookBtn.dataset.book);
        return;
      }
      const action = e.target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'goto-scan') {
        $('#tabbar button[data-tab="add"]').click();
      } else if (action.dataset.action === 'clear-filters') {
        state.filters = { status: '', category: '', tag: '', q: '', sort: 'added-desc', tagIds: [] };
        renderAll();
      } else if (action.dataset.action === 'clear-movie-filters') {
        state.movieFilters = { status: '', genre: '', collection: '', tag: '', q: '', sort: 'added-desc', kind: '' };
        renderAll();
      } else if (action.dataset.action === 'open-movie-search') {
        openMovieSearch();
      }
    });

    $('#miniMenu').addEventListener('click', (e) => {
      const item = e.target.closest('[data-mm]');
      if (!item) return;
      e.stopPropagation();
      const fn = $('#miniMenu')._onPick;
      closeMiniMenu();
      if (fn) fn(item.dataset.mm);
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('#miniMenu')) return;
      closeMiniMenu();
    });
    window.addEventListener('resize', () => closeMiniMenu());
    document.addEventListener('scroll', () => closeMiniMenu(), true);

    $('#kindSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mkind]');
      if (!btn) return;
      state.movieFilters.kind = btn.dataset.mkind;
      renderKindSwitch();
      renderShelf();
    });

    $('#statusChips').addEventListener('click', (e) => {
      const mchip = e.target.closest('[data-mstatus]');
      if (mchip) {
        state.movieFilters.status = mchip.dataset.mstatus;
        renderStatusChips();
        renderShelf();
        return;
      }
      const chip = e.target.closest('[data-status]');
      if (!chip) return;
      state.filters.status = chip.dataset.status;
      renderStatusChips();
      renderShelf();
    });
    $('#filterCategory').addEventListener('change', (e) => {
      if (state.mode === 'movie') {
        const v = e.target.value;
        if (v.startsWith('c:') || v.startsWith('m:')) {
          state.movieFilters.collection = v;
          state.movieFilters.genre = '';
        } else if (v.startsWith('g:')) {
          state.movieFilters.genre = v.slice(2);
          state.movieFilters.collection = '';
        } else {
          state.movieFilters.genre = '';
          state.movieFilters.collection = '';
        }
        renderShelf();
        return;
      }
      state.filters.category = e.target.value;
      renderShelf();
    });
    $('#filterTag').addEventListener('change', (e) => {
      if (state.mode === 'movie') {
        state.movieFilters.tag = e.target.value;
        renderShelf();
        return;
      }
      state.filters.tagIds = e.target.value ? [e.target.value] : [];
      renderShelf();
    });
    $('#sortBy').addEventListener('change', (e) => {
      if (state.mode === 'movie') {
        state.movieFilters.sort = e.target.value;
        renderShelf();
        return;
      }
      state.filters.sort = e.target.value;
      renderShelf();
    });
    let searchTimer = null;
    $('#searchInput').addEventListener('input', (e) => {
      const v = e.target.value;
      $('#searchClear').classList.toggle('hidden', !v);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (state.mode === 'movie') state.movieFilters.q = v;
        else state.filters.q = v;
        renderShelf();
      }, 160);
    });
    $('#searchClear').addEventListener('click', () => {
      $('#searchInput').value = '';
      if (state.mode === 'movie') state.movieFilters.q = '';
      else state.filters.q = '';
      $('#searchClear').classList.add('hidden');
      renderShelf();
    });
    /* ---------------- 电影：事件 ---------------- */

    $('#movieSearchBody').addEventListener('click', async (e) => {
      const pick = e.target.closest('[data-movie-pick]');
      if (pick) {
        const [source, sourceId, title, year] = pick.dataset.moviePick.split('|');
        await pickMovieResult(source, sourceId, title, year);
        return;
      }
      const action = e.target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'movie-search-run') runMovieSearch();
      else if (action.dataset.action === 'movie-manual') {
        openMovieSheet({ title: '', source: '', sourceId: '', status: state.movieFilters.status || 'wish' }, { saved: false });
      }
    });
    $('#movieSearchBody').addEventListener('keydown', (e) => {
      if (e.target.id === 'movieSearchInput' && e.key === 'Enter') {
        e.preventDefault();
        runMovieSearch();
      }
    });
    $('#movieSearchBody').addEventListener('input', (e) => {
      if (e.target.id === 'movieSearchInput') state.movieSearch.q = e.target.value;
    });

    $('#movieSheetBody').addEventListener('click', async (e) => {
      const d = state.movieDraft;
      if (!d) return;
      const sim = e.target.closest('[data-movie]:not([data-movie-add])');
      if (sim && !e.target.closest('[data-action]')) {
        openMovieSheet(sim.dataset.movie);
        return;
      }
      const person = e.target.closest('[data-person]');
      if (person) {
        openPersonWorks(person.dataset.person, person.dataset.pid, person.dataset.role);
        return;
      }
      const cand = e.target.closest('[data-movie-add]');
      if (cand) {
        const [source, sourceId, title, year] = cand.dataset.movieAdd.split('|');
        await pickMovieResult(source, sourceId, title, year);
        return;
      }
      const colorBtn = e.target.closest('[data-mcolor]');
      if (colorBtn) {
        state.newMovieTagColor = colorBtn.dataset.mcolor;
        $$('#movieTagPalette button').forEach((b) => b.classList.toggle('on', b.dataset.mcolor === state.newMovieTagColor));
        return;
      }
      const statusBtn = e.target.closest('[data-movie-status]');
      if (statusBtn) {
        const key = statusBtn.dataset.movieStatus;
        if (d.isNew) await saveNewMovie(key);
        else {
          await autoSaveMovie({ status: key });
          renderMovieSheet();
        }
        return;
      }
      const star = e.target.closest('[data-movie-star]');
      if (star) {
        if (d.isNew) {
          d.movie.myRating = Number(star.dataset.movieStar);
          renderMovieSheet();
          return;
        }
        const n = Number(star.dataset.movieStar);
        await autoSaveMovie({ myRating: d.movie.myRating === n ? 0 : n });
        renderMovieSheet();
        return;
      }
      const tagBtn = e.target.closest('[data-movie-tag]');
      if (tagBtn) {
        if (d.isNew) {
          toast('先加入片库再打标签');
          return;
        }
        const id = tagBtn.dataset.movieTag;
        const set = new Set(d.movie.tags || []);
        if (set.has(id)) set.delete(id);
        else set.add(id);
        await autoSaveMovie({ tags: [...set] });
        renderMovieSheet();
        return;
      }
      const listBtn = e.target.closest('[data-movie-list]');
      if (listBtn) {
        await toggleMovieInList(listBtn.dataset.movieList);
        return;
      }
      const seasonCard = e.target.closest('[data-season]');
      if (seasonCard) {
        const n = Number(seasonCard.dataset.season);
        const set = new Set(d.movie.watchedSeasons || []);
        if (set.has(n)) set.delete(n);
        else set.add(n);
        const arr = [...set].sort((a, b) => a - b);
        const patch = { watchedSeasons: arr };
        const total = (d.movie.seasons || []).length;
        // 顺手调整总状态，避免"8/8 季却还是想看"
        if (total && arr.length >= total) patch.status = 'watched';
        else if (arr.length && (d.movie.status === 'wish' || d.movie.status === 'watched')) patch.status = 'watching';
        await autoSaveMovie(patch);
        renderMovieSheet();
        return;
      }
      const action = e.target.closest('[data-action]');
      if (!action) return;
      const act = action.dataset.action;
      if (act === 'movie-cancel') {
        closeSheet('#sheetMovie');
        state.movieDraft = null;
      } else if (act === 'movie-save-new') {
        await saveNewMovie();
      } else if (act === 'movie-new-tag') {
        const form = $('#movieNewTagForm');
        if (form) {
          form.classList.toggle('hidden');
          if (!form.classList.contains('hidden')) {
            const input = $('#movieTagName');
            if (input) input.focus();
          }
        }
      } else if (act === 'movie-create-tag') {
        const name = (($('#movieTagName') || {}).value || '').trim();
        if (!name) {
          toast('请填写标签名称', 'err');
          return;
        }
        try {
          const res = await api('/api/tags', {
            method: 'POST',
            body: { name, color: state.newMovieTagColor || PALETTE[11] },
          });
          await refresh();
          if (state.movieDraft && !state.movieDraft.isNew) {
            const set = new Set(state.movieDraft.movie.tags || []);
            if (res.tag) set.add(res.tag.id);
            await autoSaveMovie({ tags: [...set] });
          }
          renderMovieSheet();
          toast(`标签「${name}」已创建`);
        } catch (err) {
          toast(`创建失败：${err.message}`, 'err');
        }
      } else if (act === 'movie-save-note') {
        const note = ($('#movieNote') || {}).value || '';
        if (d.isNew) {
          d.movie.note = note;
          toast('加入片库后会一并保存');
          return;
        }
        await autoSaveMovie({ note });
        toast('备注已保存');
      } else if (act === 'toggle-movie-details') {
        d.showDetails = d.showDetails === false;
        const box = $('#movieDetails');
        if (box) box.classList.toggle('hidden', d.showDetails === false);
        const head = action.querySelector('span');
        if (head) head.textContent = `▾ 详细信息${d.showDetails === false ? '（已收起）' : '（可手动修改）'}`;
      } else if (act === 'movie-refetch') {
        action.textContent = '抓取中…';
        try {
          const res = await api('/api/movie-lookup', {
            method: 'POST',
            body: { source: d.movie.source, sourceId: d.movie.sourceId, title: d.movie.title, force: true },
          });
          const keep = { status: d.movie.status, myRating: d.movie.myRating, tags: d.movie.tags, note: d.movie.note };
          const saved = await api(`/api/movies/${encodeURIComponent(d.movie.id)}`, {
            method: 'PATCH',
            body: { ...res.record, ...keep },
          });
          const idx = state.movies.findIndex((x) => x.id === d.movie.id);
          if (idx >= 0) state.movies[idx] = saved.movie;
          d.movie = saved.movie;
          state.movieRelated = { candidates: (res.record.recommendations || []).slice(0, 12) };
          renderMovieSheet();
          toast('信息已更新');
        } catch (err) {
          toast(`更新失败：${err.message}`, 'err');
          renderMovieSheet();
        }
      } else if (act === 'movie-delete') {
        if (!window.confirm(`确定删除《${d.movie.title}》？`)) return;
        try {
          await api(`/api/movies/${encodeURIComponent(d.movie.id)}`, { method: 'DELETE' });
          state.movies = state.movies.filter((x) => x.id !== d.movie.id);
          state.movieDraft = null;
          closeSheet('#sheetMovie');
          await refresh();
          toast('已删除');
        } catch (err) {
          toast(`删除失败：${err.message}`, 'err');
        }
      } else if (act === 'movie-collection-import') {
        const cid = action.dataset.cid;
        const missing = Number(action.dataset.missing) || 0;
        // 先让用户选导入后的观看状态，再开始导入
        e.stopPropagation();
        openMiniMenu(
          action,
          movieStatusMenuItems(state.movieFilters.status || 'wish').map((x) => ({
            ...x,
            note: x.key === (state.movieFilters.status || 'wish') ? '默认' : '',
          })),
          (status) => runCollectionImport(action, cid, missing, status),
          `导入 ${missing} 部影片 · 观看状态`
        );
        return;
      } else if (act === 'season-refresh') {
        await refreshSeasons(true);
      } else if (act === 'season-all') {
        const total = (d.movie.seasons || []).length;
        const all = (d.movie.watchedSeasons || []).length >= total;
        const arr = all ? [] : (d.movie.seasons || []).map((x) => x.number);
        const patch = { watchedSeasons: arr };
        if (!all && total) patch.status = 'watched';
        else if (all) patch.status = 'watching';
        await autoSaveMovie(patch);
        renderMovieSheet();
      } else if (act === 'manual-collection-set') {
        // 已有系列先让选，没有再新建
        const names = [...new Set(state.movies.map((x) => ((x.collection || {}).manual ? (x.collection || {}).name : '')).filter(Boolean))];
        if (!names.length) {
          await assignManualSeries(d.movie);
          return;
        }
        e.stopPropagation();
        openMiniMenu(
          action,
          [
            ...names.map((n) => ({
              key: n,
              label: n,
              icon: '🎞',
              note: `${state.movies.filter((x) => (x.collection || {}).name === n).length} 部`,
            })),
            { key: '__new__', label: '＋ 新建系列…', icon: '' },
          ],
          async (key) => {
            if (key === '__new__') await assignManualSeries(d.movie, '');
            else await assignManualSeries(d.movie, key);
          },
          '归入哪个系列'
        );
      } else if (act === 'series-add') {
        openSeriesPicker(action.dataset.series || '');
      } else if (act === 'manual-collection-clear') {
        if (!window.confirm('把这个影片移出该系列？（不会删除影片本身）')) return;
        await autoSaveMovie({ collection: null });
        await refresh();
        renderMovieSheet();
      } else if (act === 'movie-collection-refresh') {
        state.movieCollection = null;
        ensureMovieCollection(true);
      } else if (act === 'movie-related-refresh') {
        state.movieRelated = null;
        ensureMovieRelated(true);
      }
    });

    /** 执行合集批量导入 */
    async function runCollectionImport(action, cid, missing, status) {
      {
        const label0 = action.textContent;
        action.disabled = true;
        action.textContent = `正在导入 0/${missing}…`;
        let done = 0;
        const tick = setInterval(() => {
          done = Math.min(missing, done + 1);
          action.textContent = `正在导入 ${done}/${missing}…`;
        }, 900);
        try {
          const res = await api('/api/movie-collection/import', {
            method: 'POST',
            body: { collectionId: cid, movieId: state.movieDraft && state.movieDraft.movie.id, status },
          });
          clearInterval(tick);
          const stLabel = (state.movieStatuses[status] || {}).label || status;
          toast(
            `合集导入完成：新增 ${res.addedCount} 部（${stLabel}）${res.already ? `，已有 ${res.already} 部` : ''}${
              res.failedCount ? `，失败 ${res.failedCount} 部` : ''
            }`
          );
          await refresh();
          state.movieCollection = null;
          renderMovieSheet();
          ensureMovieCollection(true);
        } catch (err) {
          clearInterval(tick);
          toast(`导入失败：${err.message}`, 'err');
          action.disabled = false;
          action.textContent = label0;
        }
      }
    }

    // eslint-disable-next-line no-unreachable


    $('#seriesBody').addEventListener('change', (e) => {
      const sp = state.seriesPick;
      if (!sp) return;
      if (e.target.id === 'seriesSearch') return;
      if (!e.target.dataset || !e.target.dataset.spickId) return;
      const id = e.target.dataset.spickId;
      if (e.target.checked) sp.selected.add(id);
      else sp.selected.delete(id);
      const c = $('#seriesCount');
      if (c) c.textContent = sp.selected.size;
    });
    $('#seriesBody').addEventListener('input', (e) => {
      const sp = state.seriesPick;
      if (!sp || e.target.id !== 'seriesSearch') return;
      sp.query = e.target.value;
      if (e.isComposing || e.inputType === 'insertCompositionText') return; // 输入法组字中，先别动列表
      clearTimeout(sp.timer);
      sp.timer = setTimeout(renderSeriesRows, 120);
    });
    $('#seriesBody').addEventListener('compositionend', (e) => {
      const sp = state.seriesPick;
      if (!sp || e.target.id !== 'seriesSearch') return;
      sp.query = e.target.value;
      renderSeriesRows();
    });
    $('#seriesBody').addEventListener('click', async (e) => {
      const sp = state.seriesPick;
      if (!sp) return;
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'spick-none') {
        sp.selected.clear();
        drawSeriesPicker();
      } else if (act.dataset.act === 'spick-save') {
        await applySeriesPick();
      }
    });

    $('#personBody').addEventListener('change', (e) => {
      const p = state.person;
      if (!p) return;
      if (e.target.id === 'personFilter') {
        p.filter = e.target.value;
        renderPerson();
      } else if (e.target.id === 'personSort') {
        p.sort = e.target.value;
        localStorage.setItem('bn.personSort', p.sort);
        renderPerson();
      }
    });
    $('#personBody').addEventListener('click', async (e) => {
      const p = state.person;
      if (!p) return;
      const owned = e.target.closest('[data-movie]');
      if (owned) {
        if (owned.dataset.movie) openMovieSheet(owned.dataset.movie);
        return;
      }
      const add = e.target.closest('[data-movie-add]');
      if (add) {
        const [source, sourceId, title, year] = add.dataset.movieAdd.split('|');
        await pickMovieResult(source, sourceId, title, year);
        return;
      }
      const action = e.target.closest('[data-action]');
      if (action && action.dataset.action === 'person-refresh') loadPersonWorks(true);
    });

    $('#movieListPickBody').addEventListener('change', (e) => {
      const lp = state.movieListPick;
      if (!lp) return;
      if (e.target.id === 'movieListPickSort') {
        lp.sort = e.target.value;
        localStorage.setItem('bn.movieListPickSort', e.target.value);
        drawMovieListPicker();
        return;
      }
      if (!e.target.dataset || !e.target.dataset.mpickId) return;
      const id = e.target.dataset.mpickId;
      if (e.target.checked) lp.selected.add(id);
      else lp.selected.delete(id);
      const c = $('#movieListPickCount');
      if (c) c.textContent = lp.selected.size;
    });
    $('#movieListPickBody').addEventListener('click', async (e) => {
      const lp = state.movieListPick;
      if (!lp) return;
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'mpick-all') {
        state.movies.forEach((m) => lp.selected.add(m.id));
        drawMovieListPicker();
      } else if (act.dataset.act === 'mpick-none') {
        lp.selected.clear();
        drawMovieListPicker();
      } else if (act.dataset.act === 'mpick-save') {
        const set = new Set(lp.selected);
        await applyMovieListPick(set);
        closeSheet('#sheetMovieListPick');
        state.movieListPick = null;
      }
    });
    $('#movieListPickBody').addEventListener('input', (e) => {
      const lp = state.movieListPick;
      if (!lp || e.target.id !== 'movieListPickSearch') return;
      lp.query = e.target.value;
      if (e.isComposing || e.inputType === 'insertCompositionText') return;
      clearTimeout(lp.timer);
      lp.timer = setTimeout(renderMovieListPickRows, 120);
    });
    $('#movieListPickBody').addEventListener('compositionend', (e) => {
      const lp = state.movieListPick;
      if (!lp || e.target.id !== 'movieListPickSearch') return;
      lp.query = e.target.value;
      renderMovieListPickRows();
    });

    // 片单页交互（电影模式）
    $('#listsBody').addEventListener('click', async (e) => {
      if (state.mode !== 'movie') return;
      const colorBtn = e.target.closest('[data-mlcolor]');
      if (colorBtn) {
        state.newMovieListColor = colorBtn.dataset.mlcolor;
        $$('#movieListPalette button').forEach((b) => b.classList.toggle('on', b.dataset.mlcolor === state.newMovieListColor));
        return;
      }
      const open = e.target.closest('[data-movie-list-open]');
      if (open) {
        state.movieCurrentListId = open.dataset.movieListOpen;
        state.creatingMovieList = false;
        renderMovieLists();
        return;
      }
      const action = e.target.closest('[data-action]');
      if (!action) return;
      const act = action.dataset.action;
      if (act === 'movie-list-new') {
        state.creatingMovieList = true;
        state.newMovieListColor = PALETTE[10];
        renderMovieLists();
      } else if (act === 'movie-list-create-cancel') {
        state.creatingMovieList = false;
        renderMovieLists();
      } else if (act === 'movie-list-create') {
        const name = (($('#newMovieListName') || {}).value || '').trim();
        if (!name) {
          toast('请填写片单名称', 'err');
          return;
        }
        try {
          await api('/api/movie-lists', {
            method: 'POST',
            body: {
              name,
              description: (($('#newMovieListDesc') || {}).value || '').trim(),
              color: state.newMovieListColor,
            },
          });
          state.creatingMovieList = false;
          await refresh();
          renderMovieLists();
          toast(`片单「${name}」已创建`);
        } catch (err) {
          toast(`创建失败：${err.message}`, 'err');
        }
      } else if (act === 'movie-list-back') {
        state.movieCurrentListId = '';
        renderMovieLists();
      } else if (act === 'movie-list-add') {
        if (!state.movies.length) {
          toast('片库还是空的，先加几部影片', 'err');
          return;
        }
        openMovieListPicker(state.movieCurrentListId);
      } else if (act === 'movie-list-edit') {
        const l = state.movieLists.find((x) => x.id === state.movieCurrentListId);
        if (!l) return;
        const name = window.prompt('片单名称', l.name);
        if (name == null) return;
        const desc = window.prompt('一句话说明', l.description || '');
        if (desc == null) return;
        try {
          const res = await api(`/api/movie-lists/${encodeURIComponent(l.id)}`, {
            method: 'PATCH',
            body: { name: name.trim(), description: desc.trim() },
          });
          Object.assign(l, res.movieList);
          await refresh();
          renderMovieLists();
          toast('已保存');
        } catch (err) {
          toast(`保存失败：${err.message}`, 'err');
        }
      } else if (act === 'movie-list-delete') {
        const l = state.movieLists.find((x) => x.id === state.movieCurrentListId);
        if (!l) return;
        if (!window.confirm(`确定删除片单「${l.name}」？影片本身不会被删除。`)) return;
        try {
          await api(`/api/movie-lists/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
          state.movieCurrentListId = '';
          await refresh();
          renderMovieLists();
          toast('片单已删除');
        } catch (err) {
          toast(`删除失败：${err.message}`, 'err');
        }
      }
    });
    $('#listsBody').addEventListener('change', async (e) => {
      if (state.mode !== 'movie') return;
      if (e.target.id !== 'movieListSort') return;
      const l = state.movieLists.find((x) => x.id === state.movieCurrentListId);
      if (!l) return;
      l.sort = e.target.value;
      try {
        await api(`/api/movie-lists/${encodeURIComponent(l.id)}`, { method: 'PATCH', body: { sort: l.sort } });
      } catch (err) {
        toast(`排序保存失败：${err.message}`, 'err');
      }
      renderMovieLists();
    });

    $('#btnViewMode').addEventListener('click', () => {
      const order = state.mode === 'movie' ? ['grid', 'list', 'group', 'collgroup'] : ['grid', 'list', 'group'];
      let idx = order.indexOf(state.viewMode);
      if (idx < 0) idx = 0;
      state.viewMode = order[(idx + 1) % order.length];
      localStorage.setItem('bn.viewMode', state.viewMode);
      updateViewModeBtn();
      toast(viewModeLabel());
      renderShelf();
    });

    // 扫码页
    $('#btnCamStart').addEventListener('click', () => {
      if (window.BookScanner.isRunning() && !window.BookScanner.isPaused()) {
        window.BookScanner.pause();
        $('#btnCamStart').textContent = '▶︎ 继续扫描';
      } else if (window.BookScanner.isRunning()) {
        window.BookScanner.resume();
        $('#btnCamStart').textContent = '⏸ 暂停';
      } else {
        startCamera();
      }
    });
    $('#btnTorch').addEventListener('click', async () => {
      const on = await window.BookScanner.toggleTorch();
      $('#btnTorch').style.color = on ? 'var(--brand)' : '';
    });
    $('#btnSwitchCam').addEventListener('click', async () => {
      try {
        await window.BookScanner.switchCamera();
        $('#btnCamStart').textContent = '⏸ 暂停';
      } catch (err) {
        toast(err.message || '切换镜头失败', 'err');
      }
    });
    $('#btnPhoto').addEventListener('click', () => $('#photoInput').click());
    $('#photoInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const hint = $('#scanHint');
      hint.textContent = '正在识别照片…';
      try {
        const hit = await window.BookScanner.decodeFile(file);
        if (hit && hit.text) {
          hint.textContent = `照片识别成功：${hit.text}`;
          await handleScanned(hit.text);
        } else {
          hint.textContent = '照片里没识别到条码，靠近一点重拍，或手动输入 ISBN';
          toast('没有识别到条码', 'err');
        }
      } catch (err) {
        toast(err.message || '照片识别失败', 'err');
      }
    });
    $('#btnKeyboard').addEventListener('click', () => {
      $('#manualSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#manualIsbn').focus();
    });
    // 扫封面识别（无条码的书）
    $('#btnCoverScan').addEventListener('click', () => $('#coverInput').click());
    $('#coverInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      handleCoverFile(file);
    });
    $('#coverBody').addEventListener('click', async (e) => {
      if (e.target.closest('#btnCoverRetake')) {
        $('#coverInput').click();
        return;
      }
      if (e.target.closest('#btnCoverTitleSearch')) {
        searchCoverByTitle(($('#coverTitleInput') || {}).value ? $('#coverTitleInput').value.trim() : '');
        return;
      }
      const pick = e.target.closest('[data-cover-pick]');
      if (pick) {
        const item = JSON.parse(pick.dataset.coverPick);
        const chk = $('#usePhotoCoverChk');
        state.coverUseAsCover = chk ? chk.checked : true;
        const c = state.cover || {};
        const usePhoto = state.coverUseAsCover && c.token;
        closeSheet('#sheetCover');
        state.draft = null;
        await lookupAndOpen(
          { title: item.title, source: item.source, sourceId: item.id, isbn: '' },
          usePhoto ? { photo: { token: c.token, url: c.url || c.photoUrl, useAsCover: true } } : undefined
        );
      }
    });
    $('#coverBody').addEventListener('change', (e) => {
      if (e.target.id === 'usePhotoCoverChk') state.coverUseAsCover = e.target.checked;
    });
    $('#coverBody').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'coverTitleInput') searchCoverByTitle(e.target.value.trim());
    });
    // 详情页：用照片当封面
    $('#photoCoverInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file || !state.draft || !state.draft.book || !state.draft.book.id) return;
      const bookId = state.draft.book.id;
      try {
        toast('正在上传封面照片…');
        const up = await fetch('/api/uploads', {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'image/jpeg' },
          body: file,
        }).then((r) => r.json());
        if (!up.token) throw new Error(up.error || '上传失败');
        const out = await api(`/api/books/${bookId}/photo-cover`, { method: 'POST', body: { token: up.token } });
        if (state.draft && state.draft.book && state.draft.book.id === bookId) {
          state.draft.book.cover = out.book.cover;
          renderBookSheet();
        }
        toast('封面已更新');
        await refresh();
      } catch (err) {
        toast(err.message || '设置封面失败', 'err');
      }
    });
    const manualLookup = async () => {
      const v = $('#manualIsbn').value.trim();
      if (!v) return;
      $('#manualIsbn').value = '';
      if (/^\d{10,13}$/.test(v.replace(/[^\dXx]/g, ''))) await handleScanned(v);
      else await lookupAndOpen({ title: v });
    };
    $('#btnManualIsbn').addEventListener('click', manualLookup);
    $('#manualIsbn').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') manualLookup();
    });
    $('#btnTitleSearch').addEventListener('click', () => {
      const v = $('#titleQuery').value.trim();
      if (v) searchTitles(v);
    });
    $('#titleQuery').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btnTitleSearch').click();
    });
    $('#searchResults').addEventListener('click', (e) => {
      const item = e.target.closest('[data-pick]');
      if (!item) return;
      const pick = JSON.parse(item.dataset.pick);
      window.BookScanner.pause();
      lookupAndOpen({ title: pick.title, isbn: '' });
    });
    $('#recentScans').addEventListener('click', (e) => {
      const item = e.target.closest('[data-book]');
      if (!item) return;
      closeSheet('#sheetScan');
      window.BookScanner.stop(false);
      openBookDetail(item.dataset.book);
    });

    // 书籍弹层
    $('#bookSheetBody').addEventListener('input', (e) => {
      if (e.target.dataset && e.target.dataset.field === 'progress') {
        const lbl = $('#progressLabel');
        if (lbl) lbl.textContent = e.target.value;
      }
      syncDraftFromInputs();
    });
    $('#bookSheetBody').addEventListener('change', (e) => {
      if (e.target.id === 'draftUsePhoto' && state.draft && state.draft.photo) {
        state.draft.photo.useAsCover = e.target.checked;
      }
      syncDraftFromInputs();
      const d = state.draft;
      if (!d || d.mode !== 'edit' || !d.book.id) return;
      // 分类 / 阅读进度：改完立即保存
      if (e.target.id === 'categorySelect') autoSave({ categoryId: e.target.value });
      else if (e.target.dataset && e.target.dataset.field === 'progress') {
        autoSave({ progress: Number(e.target.value) || 0 });
      }
    });
    $('#bookSheetBody').addEventListener('click', async (e) => {
      const el = e.target.closest(
        '[data-action],[data-act],[data-status-pick],[data-tag-toggle],[data-list-pick],[data-star],#tagPicker button,#listPicker button,#newTagPalette button,#newCatPalette button'
      );
      if (!el) return;
      const d = state.draft;
      if (!d) return;

      if (el.dataset.act === 'zoom-cover') {
        openLightbox(el.dataset.src);
        return;
      }
      if (el.dataset.act === 'sim-open') {
        openBookDetail(el.dataset.id);
        return;
      }
      if (el.dataset.act === 'author-books') {
        openAuthorBooks(el.dataset.name);
        return;
      }
      if (el.dataset.act === 'sim-add') {
        let item = null;
        try {
          item = JSON.parse(el.dataset.pick);
        } catch (err) {
          item = null;
        }
        if (!item) return;
        if (!window.confirm(`查看并加入《${item.title}》？`)) return;
        state.related = null;
        lookupAndOpen({ title: item.title, source: item.source, sourceId: item.sourceId, isbn: '' });
        return;
      }

      if (el.dataset.statusPick) {
        syncDraftFromInputs();
        d.book.status = el.dataset.statusPick;
        state.lastStatus = d.book.status;
        localStorage.setItem('bn.lastStatus', d.book.status);
        updateStatusPills();
        autoSave({ status: d.book.status });
        return;
      }
      if (el.dataset.tagToggle) {
        syncDraftFromInputs();
        d.book.tagIds = d.book.tagIds || [];
        const id = el.dataset.tagToggle;
        const idx = d.book.tagIds.indexOf(id);
        if (idx >= 0) d.book.tagIds.splice(idx, 1);
        else d.book.tagIds.push(id);
        updateTagPills();
        autoSave({ tagIds: d.book.tagIds });
        return;
      }
      if (el.dataset.listPick) {
        syncDraftFromInputs();
        const id = el.dataset.listPick;
        if (d.mode === 'edit' && d.book.id) {
          toggleBookListNow(id); // 立即生效
          return;
        }
        d.book.listIds = d.book.listIds || [];
        const idx = d.book.listIds.indexOf(id);
        if (idx >= 0) d.book.listIds.splice(idx, 1);
        else d.book.listIds.push(id);
        updateListPills();
        return;
      }
      if (el.dataset.star) {
        syncDraftFromInputs();
        const n = Number(el.dataset.star);
        d.book.myRating = d.book.myRating === n ? 0 : n;
        updateStarPicker();
        autoSave({ myRating: d.book.myRating });
        return;
      }
      if (el.dataset.color) {
        const isTag = !!el.closest('#newTagPalette');
        if (isTag) d.newTagColor = el.dataset.color;
        else d.newCatColor = el.dataset.color;
        const box = el.parentElement;
        $$('button', box).forEach((b) => b.classList.toggle('on', b === el));
        return;
      }

      const action = el.dataset.action;
      if (!action) return;
      if (action === 'save-book') await saveDraft(false);
      else if (action === 'save-and-scan') await saveDraft(true);
      else if (action === 'discard') {
        state.draft = null;
        closeSheet('#sheetBook');
        if ($('#sheetScan').classList.contains('open')) setTimeout(() => window.BookScanner.resume(), 300);
      } else if (action === 'use-auto-category') {
        syncDraftFromInputs();
        const name = d.book.autoCategoryName;
        let cat = state.categories.find((c) => c.name === name);
        try {
          if (!cat) {
            const res = await api('/api/categories', { method: 'POST', body: { name, color: d.book.autoCategoryColor } });
            cat = res.category;
            state.categories.push(cat);
          }
          d.book.categoryId = cat.id;
          renderBookSheet();
          if (d.mode === 'edit' && d.book.id) autoSave({ categoryId: cat.id });
          toast(`已选用分类「${name}」`);
        } catch (err) {
          toast(err.message, 'err');
        }
      } else if (action === 'refetch') {
        syncDraftFromInputs();
        d.message = '<span class="spinner"></span> 正在重新抓取…';
        d.messageKind = '';
        renderBookSheet();
        try {
          const body = d.book.isbn13 ? { isbn: d.book.isbn13, force: true } : { title: d.book.title, force: true };
          const res = await api('/api/lookup', { method: 'POST', body });
          const r = res.record;
          d.book = {
            ...d.book,
            title: r.title || d.book.title,
            subtitle: r.subtitle || d.book.subtitle,
            authors: r.authors.length ? r.authors : d.book.authors,
            translators: r.translators.length ? r.translators : d.book.translators,
            publisher: r.publisher || d.book.publisher,
            pubdate: r.pubdate || d.book.pubdate,
            pages: r.pages || d.book.pages,
            price: r.price || d.book.price,
            binding: r.binding || d.book.binding,
            series: r.series || d.book.series,
            isbn13: r.isbn13 || d.book.isbn13,
            coverRemote: r.cover || d.book.coverRemote,
            summary: r.summary || d.book.summary,
            authorIntro: r.authorIntro || d.book.authorIntro,
            rating: r.rating || d.book.rating,
            ratingCount: r.ratingCount || d.book.ratingCount,
            ratingLabel: r.ratingLabel || d.book.ratingLabel,
            ratingScale: r.ratingScale || d.book.ratingScale,
            subjects: r.subjects || [],
            source: r.sourcePrimary || d.book.source,
            sourceUrl: r.sourceUrl || d.book.sourceUrl,
            autoCategoryName: (r.autoCategory && r.autoCategory.name) || d.book.autoCategoryName,
            autoCategoryColor: (r.autoCategory && r.autoCategory.color) || d.book.autoCategoryColor,
          };
          d.sources = res.sources || [];
          d.message = '已刷新元数据';
          d.messageKind = 'ok';
          renderBookSheet();
        } catch (err) {
          d.message = `刷新失败：${esc(err.message)}`;
          d.messageKind = 'err';
          renderBookSheet();
        }
      } else if (action === 'delete-book') {
        if (!window.confirm(`确定删除《${d.book.title}》吗？`)) return;
        try {
          await api(`/api/books/${d.book.id}`, { method: 'DELETE' });
          toast('已删除');
          state.draft = null;
          closeSheet('#sheetBook');
          await refresh();
        } catch (err) {
          toast(err.message, 'err');
        }
      } else if (action === 'set-photo-cover') {
        $('#photoCoverInput').click();
      } else if (action === 'reload-related') {
        state.related = null;
        if (d.book.id) ensureRelated(d.book, true);
      } else if (action === 'view-duplicate') {        const dup = d.duplicate;
        state.draft = null;
        closeSheet('#sheetBook');
        if (dup) openBookDetail(dup.id);
      } else if (action === 'force-add') {
        d.forceAdd = true;
        d.duplicate = null;
        await saveDraft(false);
      } else if (action === 'new-tag') {
        $('#newTagForm').classList.toggle('hidden');
      } else if (action === 'new-category') {
        const form = $('#newCatForm');
        if (form) {
          form.classList.toggle('hidden');
          if (!form.classList.contains('hidden')) {
            const input = $('#newCatName');
            if (input) input.focus();
          }
        }
      } else if (action === 'create-tag') {
        const name = $('#newTagName').value.trim();
        if (!name) return;
        try {
          syncDraftFromInputs();
          const res = await api('/api/tags', { method: 'POST', body: { name, color: d.newTagColor } });
          state.tags.push(res.tag);
          d.book.tagIds.push(res.tag.id);
          renderBookSheet();
          if (d.mode === 'edit' && d.book.id) autoSave({ tagIds: d.book.tagIds });
          toast(`已创建标签「${name}」`);
        } catch (err) {
          toast(err.message, 'err');
        }
      } else if (action === 'create-category') {
        const name = $('#newCatName').value.trim();
        if (!name) return;
        try {
          syncDraftFromInputs();
          const res = await api('/api/categories', { method: 'POST', body: { name, color: d.newCatColor } });
          state.categories.push(res.category);
          d.book.categoryId = res.category.id;
          renderBookSheet();
          if (d.mode === 'edit' && d.book.id) autoSave({ categoryId: res.category.id });
          toast(`已创建分类「${name}」`);
        } catch (err) {
          toast(err.message, 'err');
        }
      }
    });

    // 书单
    $('#listsBody').addEventListener('click', async (e) => {
      const colorBtn = e.target.closest('#listPalette [data-color]');
      if (colorBtn) {
        state.newListColor = colorBtn.dataset.color;
        $$('#listPalette button').forEach((b) => b.classList.toggle('on', b === colorBtn));
        return;
      }
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      try {
        if (act === 'list-new') {
          state.creatingList = true;
          renderLists();
          const input = $('#newListName');
          if (input) input.focus();
        } else if (act === 'list-cancel') {
          state.creatingList = false;
          renderLists();
        } else if (act === 'list-create') {
          await createBooklist();
        } else if (act === 'list-open') {
          renderListDetail(el.dataset.id);
        } else if (act === 'list-back') {
          state.creatingList = false;
          renderLists();
        } else if (act === 'list-edit') {
          await editBooklistFlow(el.dataset.id);
        } else if (act === 'list-add') {
          openListPicker(el.dataset.id);
        } else if (act === 'list-delete') {
          const l = listById(el.dataset.id);
          if (!window.confirm(`删除书单「${l.name}」？书本身不会被删除。`)) return;
          await api(`/api/booklists/${l.id}`, { method: 'DELETE' });
          await refresh();
          renderLists();
          toast('书单已删除');
        } else if (act === 'list-remove') {
          await api(`/api/booklists/${el.dataset.id}/books/remove`, {
            method: 'POST',
            body: { bookIds: [el.dataset.book] },
          });
          await refresh();
          renderListDetail(el.dataset.id);
          toast('已移出书单');
        } else if (act === 'book-open') {
          openBookDetail(el.dataset.id);
        }
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    $('#listsBody').addEventListener('change', async (e) => {
      if (e.target.id !== 'listSort') return;
      const l = listById(state.currentListId);
      if (!l) return;
      try {
        await api(`/api/booklists/${l.id}`, { method: 'PATCH', body: { sort: e.target.value } });
        await refresh();
        renderListDetail(l.id);
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    // 书单选书器
    $('#listPickBody').addEventListener('click', async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || !state.listPick) return;
      const act = el.dataset.act;
      if (act === 'pick-all') {
        state.listPick.selected = new Set(state.books.map((b) => b.id));
        drawListPicker();
      } else if (act === 'pick-none') {
        state.listPick.selected = new Set();
        drawListPicker();
      } else if (act === 'pick-save') {
        await applyListPick();
      }
    });
    $('#listPickBody').addEventListener('change', (e) => {
      if (!state.listPick) return;
      if (e.target.id === 'listPickSort') {
        state.listPick.sort = e.target.value;
        localStorage.setItem('bn.listPickSort', e.target.value);
        drawListPicker();
        return;
      }
      if (!e.target.dataset || !e.target.dataset.pickId) return;
      const id = e.target.dataset.pickId;
      if (e.target.checked) state.listPick.selected.add(id);
      else state.listPick.selected.delete(id);
      const counter = $('#listPickCount');
      if (counter) counter.textContent = state.listPick.selected.size;
    });
    $('#listPickBody').addEventListener('input', (e) => {
      if (e.target.id !== 'listPickSearch' || !state.listPick) return;
      const q = e.target.value.trim().toLowerCase();
      state.listPick.query = e.target.value;
      $$('#listPickBody .pick-item').forEach((row) => {
        const hay = row.dataset.search || '';
        row.style.display = !q || hay.indexOf(q) >= 0 ? '' : 'none';
      });
    });

    // 作者/译者作品列表
    $('#authorBody').addEventListener('click', (e) => {
      const el = e.target.closest('[data-act="author-pick"]');
      if (!el) return;
      if (el.dataset.owned === '1' && el.dataset.bookid) {
        openBookDetail(el.dataset.bookid);
        return;
      }
      const item = { title: el.dataset.title, source: el.dataset.source, sourceId: el.dataset.sid, isbn: '' };
      if (item.source !== 'douban') item.sourceId = ''; // 只有豆瓣支持按条目 id 直达
      lookupAndOpen(item);
    });

    // 封面大图：点图片放大/还原，点空白处或 ✕ 关闭，Esc 也能关
    const lightbox = $('#lightbox');
    if (lightbox) {
      lightbox.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'lightboxImg') {
          lightbox.classList.toggle('zoomed');
          if (!lightbox.classList.contains('zoomed')) {
            lightbox.scrollTop = 0;
            lightbox.scrollLeft = 0;
          }
          return;
        }
        closeLightbox();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && lightbox.classList.contains('show')) closeLightbox();
      });
    }

    // 管理页
    $('#manageBody').addEventListener('click', async (e) => {
      const el = e.target.closest('[data-action],[data-color]');
      if (!el) return;
      if (el.dataset.color) {
        const box = el.parentElement;
        $$('button', box).forEach((b) => b.classList.toggle('on', b === el));
        return;
      }
      const action = el.dataset.action;
      const catItem = el.closest('[data-cat]');
      const tagItem = el.closest('[data-tag]');
      const paletteColor = (pid) => {
        const on = $(`${pid} button.on`);
        return on ? on.dataset.color : null;
      };
      try {
        if (action === 'add-cat') {
          const name = $('#newCatInput').value.trim();
          if (!name) return;
          await api('/api/categories', { method: 'POST', body: { name, color: paletteColor('#catPalette') || PALETTE[9] } });
          toast('分类已添加');
          await refresh();
          renderManage();
        } else if (action === 'add-tag') {
          const name = $('#newTagInput').value.trim();
          if (!name) return;
          await api('/api/tags', { method: 'POST', body: { name, color: paletteColor('#tagPalette') || PALETTE[11] } });
          toast('标签已添加');
          await refresh();
          renderManage();
        } else if (action === 'rename-cat') {
          const cur = state.categories.find((c) => c.id === catItem.dataset.cat);
          const name = window.prompt('修改分类名称', cur.name);
          if (!name || name === cur.name) return;
          await api(`/api/categories/${cur.id}`, { method: 'PATCH', body: { name } });
          await refresh();
          renderManage();
        } else if (action === 'del-cat') {
          const cur = state.categories.find((c) => c.id === catItem.dataset.cat);
          if (!window.confirm(`删除分类「${cur.name}」？该分类下的书会变为未分类（书不会被删）。`)) return;
          await api(`/api/categories/${cur.id}`, { method: 'DELETE' });
          await refresh();
          renderManage();
        } else if (action === 'edit-cat-color') {
          const cur = state.categories.find((c) => c.id === catItem.dataset.cat);
          const idx = PALETTE.indexOf(cur.color);
          const next = PALETTE[(idx + 1) % PALETTE.length];
          await api(`/api/categories/${cur.id}`, { method: 'PATCH', body: { color: next } });
          await refresh();
          renderManage();
        } else if (action === 'rename-tag') {
          const cur = state.tags.find((t) => t.id === tagItem.dataset.tag);
          const name = window.prompt('修改标签名称', cur.name);
          if (!name || name === cur.name) return;
          await api(`/api/tags/${cur.id}`, { method: 'PATCH', body: { name } });
          await refresh();
          renderManage();
        } else if (action === 'del-tag') {
          const cur = state.tags.find((t) => t.id === tagItem.dataset.tag);
          if (!window.confirm(`删除标签「${cur.name}」？`)) return;
          await api(`/api/tags/${cur.id}`, { method: 'DELETE' });
          await refresh();
          renderManage();
        } else if (action === 'edit-tag-color') {
          const cur = state.tags.find((t) => t.id === tagItem.dataset.tag);
          const idx = PALETTE.indexOf(cur.color);
          const next = PALETTE[(idx + 1) % PALETTE.length];
          await api(`/api/tags/${cur.id}`, { method: 'PATCH', body: { color: next } });
          await refresh();
          renderManage();
        } else if (action === 'auto-categorize') {
          const res = await api('/api/auto-categorize', { method: 'POST', body: {} });
          toast(`已为 ${res.updated} 本书套用自动分类`);
          await refresh();
          renderManage();
        }
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    // 设置页
    $('#settingsBody').addEventListener('click', async (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      try {
        if (action === 'douban-sync-book' || action === 'douban-sync-movie') {
          const kind = action === 'douban-sync-book' ? 'book' : 'movie';
          const box = $('#doubanSyncResult');
          const update = !!($('#syncUpdateExisting') || {}).checked;
          try {
            await api('/api/settings', { method: 'PATCH', body: { syncUpdateExisting: update } });
            state.settings.syncUpdateExisting = update;
          } catch (err) {
            /* 忽略 */
          }
          const label0 = action.textContent;
          action.disabled = true;
          action.textContent = '同步中…';
          if (box) box.textContent = `正在读取豆瓣${kind === 'book' ? '读书' : '影视'}记录（分页抓取，请稍候）…`;
          try {
            const res = await api('/api/douban/sync', { method: 'POST', body: { kind, updateExisting: update } });
            const parts = [
              `豆瓣侧：${Object.entries(res.summary || {})
                .map(([k, v]) => `${k} ${v}`)
                .join(' / ')}`,
              `本次读取 ${res.fetched || 0} 条新记录${res.capped ? '（达到单次上限）' : ''}`,
              res.skippedKnown ? `扫描中略过已入库 ${res.skippedKnown} 条` : '',
              `新增 ${res.added || 0}`,
              `更新 ${res.updated || 0}`,
              `已存在跳过 ${res.skipped || 0}`,
            ];
            if (res.failed) parts.push(`失败 ${res.failed}`);
            const msg = res.message || parts.join(' · ');
            if (box) box.textContent = msg;
            toast(res.message ? '没有读到记录' : `同步完成：新增 ${res.added}，更新 ${res.updated}`, res.message ? 'err' : undefined);
            await refresh();
            renderSettings();
          } catch (err) {
            if (box) box.textContent = `同步失败：${err.message}`;
            toast(`同步失败：${err.message}`, 'err');
          } finally {
            action.disabled = false;
            action.textContent = label0;
          }
        } else if (action === 'open-manage') {
          renderManage();
          openSheet('#sheetManage');
        } else if (action === 'check-movie-providers') {
          el.textContent = '检测中…';
          try {
            const res = await api('/api/movie-providers/check', { method: 'POST' });
            state.movieSources = res.sources || [];
            renderSettings();
            const bad = state.movieSources.filter((x) => !x.ok);
            toast(
              bad.length ? `${bad.map((x) => x.label).join('、')} 不可用：${bad[0].error || '未知原因'}` : '影片数据源全部可用',
              bad.length ? 'err' : undefined
            );
          } catch (err) {
            toast(`检测失败：${err.message}`, 'err');
          }
        } else if (action === 'check-providers') {
          el.textContent = '检测中…';
          const res = await api('/api/providers/check', { method: 'POST' });
          state.providers = res.providers;
          renderSettings();
          toast('检测完成');
        } else if (action === 'clear-cache') {
          if (!window.confirm('清空已缓存的书籍元数据？下次查询会重新联网获取。')) return;
          await api('/api/cache', { method: 'DELETE' });
          toast('缓存已清空');
          await refresh();
          renderSettings();
        } else if (action === 'import-json') {
          $('#importFile').click();
        } else if (action === 'toggle-autocat') {
          const next = state.settings.autoCategoryOnCreate === false;
          await api('/api/settings', { method: 'PATCH', body: { autoCategoryOnCreate: next } });
          state.settings.autoCategoryOnCreate = next;
          renderSettings();
        } else if (action === 'save-proxy') {
          const url = $('#proxyUrl').value.trim();
          const res = await api('/api/settings', { method: 'PATCH', body: { proxy: { enabled: !!url, url } } });
          state.settings.proxy = res.settings.proxy;
          toast(url ? '已保存，重启服务后生效' : '已关闭代理，重启服务后生效');
          await refresh();
          renderSettings();
        } else if (action === 'save-gkey') {
          const key = $('#googleKey').value.trim();
          if (!key && state.settings.googleBooksApiKeySet) {
            toast('留空表示不修改；要删除请点「清除」');
            return;
          }
          const res = await api('/api/settings', { method: 'PATCH', body: { googleBooksApiKey: key } });
          state.settings.googleBooksApiKeySet = res.settings.googleBooksApiKeySet;
          toast(key ? 'API Key 已保存，正在重新检测数据源…' : '已清除 API Key');
          renderSettings();
          setTimeout(async () => {
            try {
              const r = await api('/api/providers/check', { method: 'POST' });
              state.providers = r.providers;
              renderSettings();
            } catch (err) {
              /* 忽略 */
            }
          }, 1200);
        } else if (action === 'clear-gkey') {
          if (!window.confirm('删除已保存的 Google Books API Key？')) return;
          const res = await api('/api/settings', { method: 'PATCH', body: { googleBooksApiKey: '' } });
          state.settings.googleBooksApiKeySet = res.settings.googleBooksApiKeySet;
          renderSettings();
          toast('已清除 Google Books Key');
        } else if (action === 'save-tmdb') {
          const key = $('#tmdbKey').value.trim();
          if (!key && state.settings.tmdbApiKeySet) {
            toast('留空表示不修改；要删除请点「清除」');
            return;
          }
          const res = await api('/api/settings', { method: 'PATCH', body: { tmdbApiKey: key } });
          state.settings.tmdbApiKeySet = res.settings.tmdbApiKeySet;
          toast(key ? 'TMDb Key 已保存，影片搜索会带上 TMDb' : '已清除 TMDb Key');
          renderSettings();
        } else if (action === 'clear-tmdb') {
          if (!window.confirm('删除已保存的 TMDb API Key？')) return;
          const res = await api('/api/settings', { method: 'PATCH', body: { tmdbApiKey: '' } });
          state.settings.tmdbApiKeySet = res.settings.tmdbApiKeySet;
          renderSettings();
          toast('已清除 TMDb Key');
        } else if (action === 'save-omdb') {
          const key = $('#omdbKey').value.trim();
          if (!key && state.settings.omdbApiKeySet) {
            toast('留空表示不修改；要删除请点「清除」');
            return;
          }
          const res = await api('/api/settings', { method: 'PATCH', body: { omdbApiKey: key } });
          state.settings.omdbApiKeySet = res.settings.omdbApiKeySet;
          toast(key ? 'OMDb Key 已保存，IMDb 影片可补全详情' : '已清除 OMDb Key');
          renderSettings();
        } else if (action === 'clear-omdb') {
          if (!window.confirm('删除已保存的 OMDb API Key？')) return;
          const res = await api('/api/settings', { method: 'PATCH', body: { omdbApiKey: '' } });
          state.settings.omdbApiKeySet = res.settings.omdbApiKeySet;
          renderSettings();
          toast('已清除 OMDb Key');
        } else if (action === 'save-douban-cookie') {
          const v = $('#doubanCookie').value.trim();
          if (!v && state.settings.doubanCookieSet) {
            toast('留空表示不修改；要删除请点「清除」');
            return;
          }
          const res = await api('/api/settings', { method: 'PATCH', body: { doubanCookie: v } });
          state.settings.doubanCookieSet = res.settings.doubanCookieSet;
          toast(v ? '豆瓣 Cookie 已保存，影片搜索会带上登录态' : '已清除豆瓣 Cookie');
          renderSettings();
        } else if (action === 'clear-douban-cookie') {
          if (!window.confirm('删除已保存的豆瓣 Cookie？')) return;
          const res = await api('/api/settings', { method: 'PATCH', body: { doubanCookie: '' } });
          state.settings.doubanCookieSet = res.settings.doubanCookieSet;
          renderSettings();
          toast('已清除豆瓣 Cookie');
        } else if (action === 'wipe') {
          if (!window.confirm('⚠️ 将删除全部书籍、分类、标签，且不可恢复。确定继续？')) return;
          if (!window.confirm('再确认一次：真的要清空所有数据吗？')) return;
          await api('/api/wipe', { method: 'POST', body: {} });
          toast('已清空');
          await refresh();
          renderSettings();
        }
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    $('#settingsBody').addEventListener('change', async (e) => {
      if (e.target.id !== 'importFile') return;
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const res = await api('/api/import', { method: 'POST', body: data });
        const parts = [`新增 ${res.added} 本`, `跳过 ${res.skipped} 本`];
        if (res.moviesAdded || res.moviesSkipped) {
          parts.push(`影片 +${res.moviesAdded || 0}${res.moviesSkipped ? ` / 跳过 ${res.moviesSkipped}` : ''}`);
        }
        if (res.movieListsAdded) parts.push(`片单 +${res.movieListsAdded}`);
        if (res.coversLocalized) parts.push(`补齐封面 ${res.coversLocalized} 张`);
        if (res.coversFailed) parts.push(`${res.coversFailed} 张封面下载失败`);
        const rec = res.received || {};
        let warn = '';
        if (rec.hasMoviesKey === false) {
          warn = '　⚠️ 这份备份是旧版本导出的，文件里没有影片数据';
        } else if (rec.movies && !res.moviesAdded && !res.moviesSkipped) {
          warn = `　⚠️ 文件里有 ${rec.movies} 部影片但服务端没有处理（服务端代码可能还是旧的，请更新后重启）`;
        } else if (rec.movies === 0) {
          warn = '　（该备份文件里没有影片数据：0 部）';
        }
        toast(`导入完成：${parts.join('，')}${warn}`, warn.startsWith('　⚠️') || res.coversFailed ? 'err' : undefined);
        await refresh();
        renderSettings();
      } catch (err) {
        toast(`导入失败：${err.message}`, 'err');
      }
    });
  }

  /* ---------------- 电影模块 ---------------- */

  const MOVIE_STATUS_ORDER = ['wish', 'watching', 'watched', 'dropped'];

  /** 通用小菜单：anchor 旁边弹出，往上/下自适应 */
  function openMiniMenu(anchor, items, onPick, title) {
    const menu = $('#miniMenu');
    if (!menu || !anchor) return;
    menu.innerHTML =
      (title ? `<div class="mm-title">${esc(title)}</div>` : '') +
      items
        .map(
          (it) =>
            `<button data-mm="${esc(it.key || '')}" class="${it.on ? 'on' : ''}"><span>${esc(it.icon || '')}</span>${esc(
              it.label
            )}${it.note ? `<span class="n">${esc(it.note)}</span>` : ''}</button>`
        )
        .join('');
    menu.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 150;
    const mh = menu.offsetHeight || 160;
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - mw - 8));
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu._onPick = onPick;
  }

  function closeMiniMenu() {
    const menu = $('#miniMenu');
    if (menu) {
      menu.classList.add('hidden');
      menu._onPick = null;
    }
  }

  /** 观看状态菜单项 */
  function movieStatusMenuItems(current) {
    return MOVIE_STATUS_ORDER.map((key) => {
      const st = state.movieStatuses[key] || { label: key, color: '#94a3b8' };
      return { key, label: st.label, icon: '●', on: current === key };
    });
  }

  /** 只改观看状态（卡片上直接操作时用） */
  async function setMovieStatus(id, status) {
    const m = movieById(id);
    if (!m || m.status === status) return;
    const before = m.status;
    m.status = status;
    renderShelf();
    renderStatusChips();
    try {
      const res = await api(`/api/movies/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
      const idx = state.movies.findIndex((x) => x.id === id);
      if (idx >= 0) state.movies[idx] = res.movie;
      const st = state.movieStatuses[status] || {};
      toast(`已标记为「${st.label || status}」`);
      api('/api/stats')
        .then((s) => {
          state.stats = s;
          state.movieStats = s.movie || state.movieStats;
          renderStatusChips();
        })
        .catch(() => {});
    } catch (err) {
      m.status = before;
      renderShelf();
      toast(`保存失败：${err.message}`, 'err');
    }
  }

  function posterSrc(m) {
    if (!m) return '';
    if (m.poster) return m.poster;
    if (m.posterRemote) return `/api/cover?src=${encodeURIComponent(m.posterRemote)}`;
    return '';
  }

  function movieById(id) {
    return state.movies.find((m) => m.id === id) || null;
  }

  function movieStatusOf(m) {
    return state.movieStatuses[m && m.status] || { label: m && m.status, color: '#94a3b8' };
  }

  function filteredMovies() {
    const f = state.movieFilters;
    const q = f.q.trim().toLowerCase();
    let list = state.movies.slice();
    if (f.kind) list = list.filter((m) => (m.type === 'tv' ? 'tv' : 'movie') === f.kind);
    if (f.status) list = list.filter((m) => m.status === f.status);
    if (f.collection) {
      const key = String(f.collection);
      list = list.filter((m) => {
        const c = m.collection || {};
        if (!c.name) return false;
        return key.startsWith('m:') ? !c.id && c.name === key.slice(2) : String(c.id) === key.slice(2);
      });
    }
    if (f.genre) list = list.filter((m) => (m.genres || []).includes(f.genre));
    if (f.tag) list = list.filter((m) => (m.tags || []).includes(f.tag));
    if (q) {
      list = list.filter((m) =>
        [m.title, m.originalTitle, (m.aka || []).join(' '), (m.directors || []).join(' '), (m.actors || []).join(' '), (m.genres || []).join(' '), m.year, m.note]
          .join(' ')
          .toLowerCase()
          .includes(q)
      );
    }
    const year = (m) => Number(String(m.year || '').match(/\d{4}/) || 0);
    const statusRank = (m) => {
      const i = MOVIE_STATUS_ORDER.indexOf(m.status);
      return i < 0 ? 99 : i;
    };
    list.sort((a, b) => {
      switch (f.sort) {
        case 'added-asc':
          return String(a.addedAt).localeCompare(String(b.addedAt));
        case 'updated-desc':
          return String(b.updatedAt).localeCompare(String(a.updatedAt));
        case 'rating-desc':
          return (b.rating || 0) - (a.rating || 0);
        case 'myrating-desc':
          return (b.myRating || 0) - (a.myRating || 0) || (b.rating || 0) - (a.rating || 0);
        case 'title-asc':
          return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
        case 'director-asc':
          return String((a.directors || [])[0] || '').localeCompare(String((b.directors || [])[0] || ''), 'zh-Hans-CN');
        case 'year-desc':
          return year(b) - year(a);
        case 'year-asc':
          return year(a) - year(b);
        case 'status-asc':
          return statusRank(a) - statusRank(b) || String(b.addedAt).localeCompare(String(a.addedAt));
        default:
          return String(b.addedAt).localeCompare(String(a.addedAt));
      }
    });
    return list;
  }

  function movieCardHtml(m) {
    const p = posterSrc(m);
    const st = movieStatusOf(m);
    return `<button class="movie-card" data-movie="${esc(m.id)}">
      <div class="poster">
        ${p ? `<img loading="lazy" src="${esc(p)}" alt="">` : '🎬'}
        <span class="st" data-mstat="${esc(m.id)}" title="点击设置观看状态" style="background:${esc(
          st.color
        )}">${esc(st.label)}</span>
        ${m.type === 'tv' ? '<span class="kind">剧集</span>' : ''}
        ${m.rating ? `<span class="rt">★ ${m.rating}</span>` : ''}
      </div>
      <div class="t">${esc(m.title)}</div>
      <div class="s">${esc([m.year, (m.directors || [])[0]].filter(Boolean).join(' · ') || '—')}</div>
      ${m.collection && m.collection.name ? `<div class="coll">${esc(m.collection.name)}</div>` : ''}
    </button>`;
  }

  function movieRowHtml(m) {
    const p = posterSrc(m);
    const st = movieStatusOf(m);
    return `<button class="row" data-movie="${esc(m.id)}">
      <div class="cover">${p ? `<img loading="lazy" src="${esc(p)}" alt="">` : '🎬'}</div>
      <div class="meta">
        <div class="t">${esc(m.title)}</div>
        <div class="s">${esc([m.year, (m.directors || []).join(' / ')].filter(Boolean).join(' · ') || '—')}</div>
        <div class="row-chips">
          <span class="chip-mini" style="background:${esc(st.color)}22;color:${esc(st.color)}">${esc(st.label)}</span>
          ${m.rating ? `<span class="chip-mini">★ ${m.rating}</span>` : ''}
          ${(m.genres || []).slice(0, 2).map((g) => `<span class="chip-mini">${esc(g)}</span>`).join('')}
          ${(m.tags || []).slice(0, 2).map((id) => {
            const t = state.tags.find((x) => x.id === id);
            return t ? `<span class="chip-mini" style="background:${esc(t.color)}22;color:${esc(t.color)}">${esc(t.name)}</span>` : '';
          }).join('')}
        </div>
      </div>
    </button>`;
  }

  /** 片库：标题栏里平铺的 全部 / 电影 / 剧集 分段控件（带数量） */
  const VIEW_MODE_META = {
    grid: { icon: '▦', label: '网格视图' },
    list: { icon: '☰', label: '列表视图' },
    group: { icon: '⊞', label: '按类型 / 影剧分组' },
    collgroup: { icon: '⧉', label: '按合集分组' },
  };

  function viewModeLabel() {
    return (VIEW_MODE_META[state.viewMode] || VIEW_MODE_META.grid).label;
  }

  function updateViewModeBtn() {
    const btn = $('#btnViewMode');
    if (!btn) return;
    const meta = VIEW_MODE_META[state.viewMode] || VIEW_MODE_META.grid;
    btn.textContent = meta.icon;
    btn.title = meta.label + '（点击切换）';
  }

  function renderKindSwitch() {
    const box = $('#kindSeg');
    if (!box) return;
    if (state.mode !== 'movie') {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    const movies = state.movies.filter((m) => m.type !== 'tv').length;
    const tvs = state.movies.filter((m) => m.type === 'tv').length;
    const cur = state.movieFilters.kind || '';
    const opts = [
      ['', '全部', state.movies.length],
      ['movie', '电影', movies],
      ['tv', '剧集', tvs],
    ];
    box.innerHTML = opts
      .map(
        ([key, label, n]) =>
          `<button class="${cur === key ? 'on' : ''}" data-mkind="${key}">${esc(label)}<span class="n">${n}</span></button>`
      )
      .join('');
  }

  function renderMovieShelf() {
    const list = filteredMovies();
    const view = $('#view');
    const countEl = $('#shelfCount');
    if (countEl) countEl.textContent = state.movies.length ? `共 ${state.movies.length} 部` : '';
    const kindLabel = state.movieFilters.kind === 'movie' ? '电影' : state.movieFilters.kind === 'tv' ? '剧集' : '';
    const statusLabel = (state.movieStatuses[state.movieFilters.status] || {}).label || '';
    const collName = (() => {
      const key = String(state.movieFilters.collection || '');
      if (!key) return '';
      const hit = state.movies.find((m) => {
        const c = m.collection || {};
        if (!c.name) return false;
        return key.startsWith('m:') ? !c.id && c.name === key.slice(2) : String(c.id) === key.slice(2);
      });
      return (hit && hit.collection && hit.collection.name) || '';
    })();
    const rightTags = [collName, state.movieFilters.genre, kindLabel, statusLabel].filter(Boolean).join(' · ') || '全部';
    const summary = `<div class="shelf-summary"><span>当前显示 ${list.length} 部${
      kindLabel ? `（${esc(kindLabel)}）` : ''
    }${state.movieFilters.q ? ` · 搜索「${esc(state.movieFilters.q)}」` : ''}</span><span>${esc(rightTags)}</span></div>`;

    if (!state.movies.length) {
      view.innerHTML = `<div class="empty"><div class="big">🎬</div><p><b>片库还是空的</b></p>
        <p>点下面的「加片」搜索片名，<br>从豆瓣 / IMDb / TMDb 抓取信息后加入。</p>
        <div class="btn-row" style="max-width:260px;margin:16px auto 0">
          <button class="btn" data-action="open-movie-search">搜索添加影片</button>
        </div></div>`;
      return;
    }
    if (!list.length) {
      view.innerHTML = `${summary}<div class="empty"><div class="big">🔍</div><p>没有符合条件的影片</p>
        <p><button class="btn ghost sm" data-action="clear-movie-filters">清空筛选</button></p></div>`;
      return;
    }
    if (state.viewMode === 'list') {
      view.innerHTML = `${summary}<div class="list">${list.map(movieRowHtml).join('')}</div>`;
      return;
    }
    if (state.viewMode === 'collgroup') {
      // 按合集（系列）分组；不属于任何合集的归入"未归类"
      const groups = new Map();
      for (const m of list) {
        const name = (m.collection && m.collection.name) || '未归类';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(m);
      }
      const html = Array.from(groups.entries())
        .sort((a, b) => (a[0] === '未归类' ? 1 : b[0] === '未归类' ? -1 : b[1].length - a[1].length))
        .map(
          ([name, items]) =>
            `<div class="group-title"><span class="chip" style="font-weight:700">${esc(name)}</span>
             <span style="color:var(--text-mute);font-weight:400">${items.length} 部${
              name !== '未归类' && items.some((x) => x.year) ? ` · ${items.filter((x) => x.year).map((x) => x.year).sort()[0]} 起` : ''
            }</span></div>
             <div class="movie-grid">${items.map(movieCardHtml).join('')}</div>`
        )
        .join('');
      view.innerHTML = summary + html;
      return;
    }
    if (state.viewMode === 'group') {
      // 片库的分组视图把「电影 / 剧集」分开显示（每组内再按当前排序）
      const groups = new Map([
        ['电影', []],
        ['剧集', []],
      ]);
      for (const m of list) groups.get(m.type === 'tv' ? '剧集' : '电影').push(m);
      const html = Array.from(groups.entries())
        .filter(([, items]) => items.length)
        .map(
          ([name, items]) =>
            `<div class="group-title"><span class="chip" style="font-weight:700">${esc(name)}</span>
             <span style="color:var(--text-mute);font-weight:400">${items.length} 部</span></div>
             <div class="movie-grid">${items.map(movieCardHtml).join('')}</div>`
        )
        .join('');
      view.innerHTML = summary + html;
      return;
    }
    view.innerHTML = `${summary}<div class="movie-grid">${list.map(movieCardHtml).join('')}</div>`;
  }

  function renderMovieTabLabel() {
    const addBtn = $('#tabbar button[data-tab="add"] .lbl');
    if (addBtn) addBtn.textContent = state.mode === 'movie' ? '加片' : '扫码';
    const listBtn = $('#tabbar button[data-tab="lists"] .lbl');
    if (listBtn) listBtn.textContent = state.mode === 'movie' ? '片单' : '书单';
    const booksBtn = $('#tabbar button[data-tab="books"] .lbl');
    const moviesBtn = $('#tabbar button[data-tab="movies"] .lbl');
    if (booksBtn) booksBtn.textContent = '书';
    if (moviesBtn) moviesBtn.textContent = '影';
  }

  function moviePills(field, options, current) {
    return options
      .map(([key, label, color]) => {
        const on = current === key;
        return `<button class="pill ${on ? 'on' : ''}" data-movie-${field}="${esc(key)}" ${
          on && color ? `style="background:${esc(color)};border-color:${esc(color)};color:#fff"` : ''
        }>${esc(label)}</button>`;
      })
      .join('');
  }

  function openMovieSheet(input, opts = {}) {
    if (typeof input === 'string') {
      const m = movieById(input);
      if (!m) return;
      state.movieDraft = { movie: m, isNew: false, patch: {}, excluded: new Set() };
      state.movieRelated = null;
    } else {
      state.movieDraft = { movie: { ...input, status: input.status || 'wish', tags: input.tags || [] }, isNew: !opts.saved, patch: {}, excluded: new Set() };
      state.movieRelated = { candidates: input.recommendations || [] };
    }
    if (opts.saved) state.movieDraft.isNew = false;
    renderMovieSheet();
    openSheet('#sheetMovie');
    if (state.movieDraft.isNew === false) {
      ensureMovieRelated();
      ensureMovieCollection();
      refreshSeasons(false); // 进详情自动刷一次（1 小时内不重复）
    }
  }

  /** 三方链接：有哪个 id 就给哪个链接 */
  function movieLinks(m) {
    const out = [];
    const doubanId = m.doubanId || (m.source === 'douban' ? m.sourceId : '');
    const tmdbId = m.tmdbId || (m.source === 'tmdb' ? String(m.sourceId || '').split('/').pop() : '');
    if (doubanId) out.push(['豆瓣', `https://movie.douban.com/subject/${doubanId}/`]);
    if (m.imdbId) out.push(['IMDb', `https://www.imdb.com/title/${m.imdbId}/`]);
    if (tmdbId) out.push(['TMDb', `https://www.themoviedb.org/${m.type === 'tv' ? 'tv' : 'movie'}/${tmdbId}`]);
    return out;
  }

  /** 三方评分全部展示（豆瓣 > IMDb > TMDb 的顺序） */
  function movieRatingsLine(m) {
    const labels = { douban: '豆瓣', imdb: 'IMDb', tmdb: 'TMDb' };
    const ratings = m.ratings || {};
    const parts = [];
    for (const key of ['douban', 'imdb', 'tmdb']) {
      const r = ratings[key];
      if (r && r.value) parts.push(`<span class="rate-chip" data-src="${key}">${labels[key]} <b>${r.value}</b>${
        r.count ? `<i>${r.count > 10000 ? (r.count / 10000).toFixed(1) + '万' : r.count}</i>` : ''
      }</span>`);
    }
    if (!parts.length && m.rating) parts.push(`<span class="rate-chip" data-src="${m.source}"><b>${m.rating}</b></span>`);
    return parts.join('');
  }

  function movieSheetHtml() {
    const d = state.movieDraft;
    const m = d.movie;
    const p = posterSrc(m);
    const st = movieStatusOf(m);
    const tags = state.tags;
    const related = state.movieRelated;
    const inLists = state.movieLists.filter((l) => (l.movieIds || []).includes(m.id));
    const sim = d.isNew ? [] : similarMovies(m);
    const links = movieLinks(m);

    const info = (k, v) =>
      v ? `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>` : '';
    const runtime = (m.durations || []).join(' / ');
    // 把人物名字渲染成可点的（带 TMDb 人 id，没 id 时按名字兜底）
    const peopleLinks = (names, role) =>
      (names || [])
        .map((n) => {
          const hit = (m.people || []).find((x) => x.name === n && (!role || x.job === role)) || (m.people || []).find((x) => x.name === n);
          return `<button class="person-link" data-person="${esc(n)}" data-pid="${esc((hit && hit.id) || '')}" data-role="${esc(
            role || ''
          )}">${esc(n)}</button>`;
        })
        .join(' / ');

    return `
      <div class="hint" style="margin-bottom:10px">${
        d.isNew ? '确认信息后点「加入片库」，也可以直接点状态' : '状态 / 标签 / 片单 / 我的评分 改动即时生效'
      }</div>
      <div class="movie-hero">
        <div class="poster">${
          p
            ? `<button class="cover-zoom" data-act="zoom-cover" data-src="${esc(p)}" title="点击放大海报"><img src="${esc(p)}" alt=""></button>`
            : '<div class="ph" style="text-align:center;font-size:34px;padding:34px 0">🎬</div>'
        }</div>
        <div style="flex:1;min-width:0">
          <h3>${esc(m.title)}</h3>
          ${m.originalTitle && m.originalTitle !== m.title ? `<div class="line">${esc(m.originalTitle)}</div>` : ''}
          <div class="line">${esc(
            [m.year, m.type === 'tv' ? '剧集' : '电影', runtime, (m.countries || []).join(' ')].filter(Boolean).join(' · ') || '—'
          )}</div>
          ${movieRatingsLine(m) ? `<div class="rate-row">${movieRatingsLine(m)}</div>` : ''}
          <div style="margin-top:6px">${(m.genres || []).map((g) => `<span class="genre-chip">${esc(g)}</span>`).join('')}</div>
          <div class="line" style="margin-top:6px">${esc((m.directors || []).join(' / ') || '')}${
            (m.actors || []).length ? ` <span style="color:var(--text-mute)">主演 ${esc(m.actors.slice(0, 4).join(' '))}</span>` : ''
          }</div>
          ${
            links.length
              ? `<div class="link-row">${links
                  .map(
                    ([label, url]) =>
                      `<a class="link-chip" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`
                  )
                  .join('')}</div>`
              : ''
          }
        </div>
      </div>

      ${
        d.isNew
          ? `<div class="btn-row" style="margin-bottom:14px">
              <button class="btn ghost" data-action="movie-cancel">取消</button>
              <button class="btn" data-action="movie-save-new">＋ 加入片库</button>
            </div>`
          : ''
      }

      <div class="field"><label>观看状态</label>
        <div class="status-picker" id="movieStatusPicker">
          ${MOVIE_STATUS_ORDER.map((key) => {
            const s = state.movieStatuses[key] || { label: key, color: '#94a3b8' };
            const on = m.status === key;
            return `<button class="${on ? 'on' : ''}" data-movie-status="${key}" ${
              on ? `style="background:${esc(s.color)};border-color:${esc(s.color)};color:#fff"` : `style="color:${esc(s.color)}"`
            }>${esc(s.label)}</button>`;
          }).join('')}
        </div>
      </div>

      <div class="field"><label>我的评分</label>
        <div class="stars-big" id="movieStars">${[1, 2, 3, 4, 5]
          .map((i) => `<span class="${(m.myRating || 0) >= i ? 'on' : ''}" data-movie-star="${i}">★</span>`)
          .join('')}<span style="font-size:12.5px;color:var(--text-mute);align-self:center;margin-left:6px">${
          m.myRating ? `${m.myRating} 分` : '未评分'
        }</span></div>
      </div>

      <div class="field"><label>标签</label>
        <div class="picker" id="movieTagPicker">
          ${tags
            .map(
              (t) =>
                `<button class="pill ${(m.tags || []).includes(t.id) ? 'on' : ''}" data-movie-tag="${esc(t.id)}" ${
                  (m.tags || []).includes(t.id) ? `style="background:${esc(t.color)};border-color:${esc(t.color)};color:#fff"` : ''
                }>${esc(t.name)}</button>`
            )
            .join('')}
          <button class="pill add" data-action="movie-new-tag">＋ 新标签</button>
        </div>
        <div id="movieNewTagForm" class="hidden" style="margin-top:8px">
          <div class="inline-form">
            <input type="text" id="movieTagName" placeholder="标签名称" maxlength="16">
            <button class="btn sm" data-action="movie-create-tag">创建</button>
          </div>
          <div class="palette" id="movieTagPalette">${PALETTE.map(
            (c) => `<button data-mcolor="${c}" style="background:${c}"></button>`
          ).join('')}</div>
        </div>
      </div>

      <div class="field"><label>加入片单</label>
        <div class="picker" id="movieListPicker">
          ${
            state.movieLists.length
              ? state.movieLists
                  .map(
                    (l) =>
                      `<button class="pill ${inLists.some((x) => x.id === l.id) ? 'on' : ''}" data-movie-list="${esc(l.id)}" ${
                        inLists.some((x) => x.id === l.id) ? `style="background:${esc(l.color)};border-color:${esc(l.color)};color:#fff"` : ''
                      }>${inLists.some((x) => x.id === l.id) ? '✓ ' : ''}${esc(l.name)}</button>`
                  )
                  .join('')
              : '<span class="hint" style="font-size:12px">还没有片单，去「片单」页新建</span>'
          }
        </div>
        <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">点一下即时生效：勾选＝加入片单，取消勾选＝从该片单移出</div>
      </div>

      ${
        !d.isNew && (m.seasons || []).length
          ? (() => {
              const seasons = m.seasons || [];
              const watched = new Set(m.watchedSeasons || []);
              const epsTotal = seasons.reduce((a, x) => a + (x.episodes || 0), 0);
              const epsWatched = seasons.filter((x) => watched.has(x.number)).reduce((a, x) => a + (x.episodes || 0), 0);
              const allWatched = seasons.length && watched.size >= seasons.length;
              return `<div class="field"><label>季与进度
                <span class="hint" style="font-weight:400">（看过 ${watched.size}/${seasons.length} 季 · ${epsWatched}/${epsTotal} 集）</span>
                <button class="btn sm ghost" data-action="season-refresh" style="margin-left:auto;font-size:11px;padding:2px 8px">↻ 刷新季<span id="seasonRefreshHint" style="margin-left:4px;color:var(--text-mute)"></span></button></label>
                <div class="season-grid">
                  ${seasons
                    .map(
                      (x) => `<button class="season-card ${watched.has(x.number) ? 'on' : ''}" data-season="${x.number}"
                        title="${esc(x.name || `第 ${x.number} 季`)}">
                        <div class="poster">${x.poster ? `<img loading="lazy" src="${esc(x.poster)}" alt="">` : '📺'}</div>
                        <div class="sn">S${x.number}</div>
                        <div class="se">${x.episodes ? `${x.episodes} 集` : ''}${
                        x.airDate ? ` · ${String(x.airDate).slice(0, 4)}` : ''
                      }</div>
                        ${watched.has(x.number) ? '<span class="tick">✓</span>' : ''}
                      </button>`
                    )
                    .join('')}
                </div>
                <div class="btn-row" style="margin-top:8px">
                  <button class="btn ghost sm" data-action="season-all">${
                    allWatched ? '取消全部' : '全部标记看过'
                  }</button>
                  <span class="hint" style="align-self:center;font-size:11.5px">点某一季可单独标记</span>
                </div>
              </div>`;
            })()
          : ''
      }

      <div class="field"><label>备注</label>
        <textarea id="movieNote" rows="2" placeholder="在哪看的、和谁看的、想记的点…">${esc(m.note || '')}</textarea>
        <div class="inline-form" style="margin-top:8px;justify-content:flex-end">
          <span class="save-hint" id="movieSaveHint"></span>
          <button class="btn sm ghost" data-action="movie-save-note">保存备注</button>
        </div>
      </div>

      <div class="field">
        <button class="collapse-head" data-action="toggle-movie-details">
          <span>▾ 详细信息${d.showDetails === false ? '（已收起）' : '（可手动修改）'}</span>
        </button>
        <div class="${d.showDetails === false ? 'hidden' : ''}" id="movieDetails">
          ${
            (m.directors || []).length
              ? `<div class="kv"><span class="k">导演</span><span class="v">${peopleLinks(m.directors, 'director')}</span></div>`
              : ''
          }
          ${
            (m.writers || []).length
              ? `<div class="kv"><span class="k">编剧</span><span class="v">${peopleLinks(m.writers, 'writer')}</span></div>`
              : ''
          }
          ${
            (m.actors || []).length
              ? `<div class="kv"><span class="k">主演</span><span class="v">${peopleLinks((m.actors || []).slice(0, 12), 'actor')}</span></div>`
              : ''
          }
          ${info('类型', (m.genres || []).join(' / '))}
          ${info('国家/地区', (m.countries || []).join(' / '))}
          ${info('语言', (m.languages || []).join(' / '))}
          ${info('片长', runtime)}
          ${info('上映日期', (m.releaseDates || []).join(' / '))}
          ${info('别名', (m.aka || []).join(' / '))}
          ${info('豆瓣', m.doubanId ? `#${m.doubanId}` : '')}
          ${info('IMDb', m.imdbId || '')}
          ${info('TMDb', m.tmdbId || '')}
          ${
            (m.mergedFrom || []).length > 1
              ? `<div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">基本信息由 ${esc(
                  m.mergedFrom.join(' + ')
                )} 合并（冲突以豆瓣为准）</div>`
              : ''
          }
          ${
            m.summary
              ? `<div class="summary" style="margin-top:10px"><div class="summary-title">剧情简介</div><p>${esc(m.summary)}</p></div>`
              : ''
          }
          ${!d.isNew ? `<div class="btn-row" style="margin-top:12px">
            <button class="btn ghost sm" data-action="movie-refetch">↻ 重新抓取信息</button>
            <button class="btn ghost sm danger" data-action="movie-delete">删除影片</button>
          </div>` : ''}
        </div>
      </div>

      ${
        sim.length
          ? `<div class="field"><label>片库里的相似影片</label><div class="sim-row">${sim
              .map(
                (x) =>
                  `<button class="sim-card" data-movie="${esc(x.movie.id)}"><div class="cover">${
                    posterSrc(x.movie) ? `<img loading="lazy" src="${esc(posterSrc(x.movie))}" alt="">` : '🎬'
                  }</div><div class="t">${esc(x.movie.title)}</div><div class="s">${esc(x.reason)}</div></button>`
              )
              .join('')}</div></div>`
          : ''
      }

      ${
        !d.isNew && (!m.collection || !m.collection.name)
          ? `<div class="field"><label>同系列（手动归并）</label>
              <div class="picker">
                <button class="pill add" data-action="manual-collection-set">＋ 归入某个系列</button>
              </div>
              <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">
                TMDb 的剧集没有"合集"概念（例如《权力的游戏》与《龙之家族》互不关联），
                可以手动把同系列的剧集归到一起：输入系列名（如「冰与火之歌」），
                之后在片库按合集分组、或按合集筛选就能一起看。
              </div>
            </div>`
          : ''
      }

      ${
        !d.isNew && m.collection && !m.collection.id && m.collection.name
          ? `<div class="field"><label>同系列：${esc(m.collection.name)} ${
              (() => {
                const sib = state.movies.filter(
                  (x) => x.id !== m.id && (x.collection || {}).name === m.collection.name && !(x.collection || {}).id
                );
                return sib.length ? `<span class="hint" style="font-weight:400">（片库另有 ${sib.length} 部）</span>` : '';
              })()
            }</label>
              ${
                (() => {
                  const sib = state.movies.filter(
                    (x) => x.id !== m.id && (x.collection || {}).name === m.collection.name && !(x.collection || {}).id
                  );
                  const tile = `<button class="sim-card add-tile" data-action="series-add" data-series="${esc(
                    m.collection.name
                  )}"><span class="plus">＋</span><span class="lbl">添加影片</span></button>`;
                  return (
                    (sib.length
                      ? `<div class="sim-row">${sib
                          .map(
                            (x) => `<button class="sim-card" data-movie="${esc(x.id)}">
                              <div class="cover">${posterSrc(x) ? `<img loading="lazy" src="${esc(posterSrc(x))}" alt="">` : '🎬'}${
                              x.type === 'tv' ? '<span class="agree">剧集</span>' : ''
                            }</div>
                              <div class="t">${esc(x.title)}</div>
                              <div class="s">${esc(x.year || '')}</div></button>`
                          )
                          .join('')}${tile}</div>`
                      : `<div class="sim-row">${tile}</div>`)
                  );
                })()
              }
              <div class="btn-row" style="margin-top:8px">
                <button class="btn ghost sm" data-action="manual-collection-rename">重命名</button>
                <button class="btn ghost sm danger" data-action="manual-collection-clear">移出系列</button>
              </div>
            </div>`
          : ''
      }

      ${
        !d.isNew && m.collection && m.collection.id
          ? (() => {
              const c = state.movieCollection && state.movieCollection.movieId === m.id ? state.movieCollection : null;
              const parts = (c && c.parts) || [];
              const ownedN = parts.filter((x) => x.owned).length;
              return `<div class="field"><label>合集：${esc(m.collection.name || '系列影片')} ${
                parts.length ? `<span class="hint" style="font-weight:400">（共 ${parts.length} 部 · 片库已有 ${ownedN} 部）</span>` : ''
              }</label>
                ${
                  c === null || c.loading
                    ? '<div class="center"><span class="spinner"></span> 正在获取合集…</div>'
                    : c.error
                    ? `<div class="hint">${esc(c.error)}</div>`
                    : parts.length
                    ? `<div class="sim-row">${parts
                        .map((p) => {
                          const inLib = p.owned || state.movies.some((x) => String(x.tmdbId || '') === String(p.tmdbId));
                          const here = inLib && String(m.tmdbId || '') === String(p.tmdbId);
                          const inner = `<div class="cover">${
                            p.poster ? `<img loading="lazy" src="${esc(p.poster)}" alt="">` : '🎬'
                          }${here ? '<span class="agree">当前</span>' : inLib ? '<span class="agree" style="background:rgba(22,163,74,.92)">已有</span>' : ''}</div>
                          <div class="t">${esc(p.title)}</div>
                          <div class="s">${esc([p.year, p.rating ? `★${p.rating}` : ''].filter(Boolean).join(' · '))}</div>`;
                          return inLib
                            ? `<button class="sim-card" data-movie="${esc((state.movies.find((x) => String(x.tmdbId || '') === String(p.tmdbId)) || {}).id || '')}">${inner}</button>`
                            : `<button class="sim-card" data-movie-add="tmdb|${esc(p.sourceId)}|${esc(p.title)}|${esc(p.year || '')}">${inner}</button>`;
                        })
                        .join('')}</div>`
                    : '<div class="hint">这个合集暂时没有可展示的影片</div>'
                }
                <div class="btn-row" style="margin-top:8px">
                  <button class="btn ghost sm" data-action="movie-collection-refresh">↻ 刷新合集</button>
                  ${
                    parts.filter((x) => !x.owned).length
                      ? `<button class="btn sm" data-action="movie-collection-import" data-cid="${esc(
                          m.collection.id
                        )}" data-missing="${parts.filter((x) => !x.owned).length}">＋ 全部加入（${
                          parts.filter((x) => !x.owned).length
                        } 部）</button>`
                      : '<span class="hint" style="align-self:center;font-size:12px">这个系列的影片都已入库 ✓</span>'
                  }
                </div>
              </div>`;
            })()
          : ''
      }

      ${
        !d.isNew
          ? `<div class="field"><label>相似与推荐 ${
              related && related.candidates && related.candidates.length ? `<span class="hint" style="font-weight:400">（${
                related.candidates.length
              } 部 · 豆瓣 + TMDb 合并，多源共同推荐排前面）</span>` : ''
            }</label>
            <div id="movieRelated">${
              related === null
                ? '<div class="center"><span class="spinner"></span> 正在找相似影片…</div>'
                : related && related.error
                ? `<div class="hint">${esc(related.error)}</div>`
                : related && related.candidates && related.candidates.length
                ? `<div class="sim-row">${related.candidates
                    .map((c) => {
                      const ref = c.doubanId
                        ? ['douban', c.doubanId]
                        : c.imdbId
                        ? ['imdb', c.imdbId]
                        : c.tmdbId
                        ? ['tmdb', `${c.type === 'tv' ? 'tv' : 'movie'}/${c.tmdbId}`]
                        : [c.source, c.sourceId];
                      const badges = (c.sources || [c.sourceLabel]).join('+');
                      return `<button class="sim-card" data-movie-add="${esc(ref[0])}|${esc(ref[1])}|${esc(c.title)}|${esc(
                        c.year || ''
                      )}"><div class="cover">${c.poster ? `<img loading="lazy" src="${esc(c.poster)}" alt="">` : '🎬'}${
                        c.agree > 1 ? '<span class="agree">多源</span>' : ''
                      }</div>
                        <div class="t">${esc(c.title)}</div>
                        <div class="s">${esc(
                          [c.year, c.rating ? `★${c.rating}` : '', badges].filter(Boolean).join(' · ')
                        )}</div></button>`;
                    })
                    .join('')}</div>`
                : '<div class="hint">暂时没有找到相似影片</div>'
            }</div>
            <div class="btn-row" style="margin-top:8px"><button class="btn ghost sm" data-action="movie-related-refresh">↻ 换一批</button></div>
          </div>`
          : ''
      }`;
  }

  function renderMovieSheet() {
    const d = state.movieDraft;
    if (!d) return;
    const body = $('#movieSheetBody');
    const scroll = body.scrollTop;
    $('#movieSheetTitle').textContent = d.isNew ? '确认影片信息' : '影片详情';
    body.innerHTML = movieSheetHtml();
    body.scrollTop = scroll;
  }

  function similarMovies(m) {
    const norm = (s) => String(s || '').toLowerCase();
    const titleSim = (a, b) => {
      const x = norm(a);
      const y = norm(b);
      if (!x || !y) return 0;
      if (x === y) return 1;
      const setB = new Set(y.split(''));
      let hit = 0;
      for (const ch of new Set(x.split(''))) if (setB.has(ch)) hit += 1;
      return hit / Math.max(new Set(x.split('')).size, 1);
    };
    return state.movies
      .filter((x) => x.id !== m.id)
      .map((x) => {
        let score = 0;
        const reasons = [];
        const sharedG = (x.genres || []).filter((g) => (m.genres || []).includes(g));
        if (sharedG.length) {
          score += Math.min(3, sharedG.length * 1.5);
          reasons.push(`同类型 · ${sharedG.slice(0, 2).join('/')}`);
        }
        const sharedD = (x.directors || []).filter((g) => (m.directors || []).includes(g));
        if (sharedD.length) {
          score += 3;
          reasons.push(`同导演 · ${sharedD[0]}`);
        }
        const sharedA = (x.actors || []).filter((g) => (m.actors || []).includes(g));
        if (sharedA.length) {
          score += Math.min(2, sharedA.length);
          reasons.push(`同演员 · ${sharedA[0]}`);
        }
        const sharedC = (x.countries || []).filter((g) => (m.countries || []).includes(g));
        if (sharedC.length) score += 0.5;
        const ts = titleSim(x.title, m.title);
        if (ts >= 0.6 && x.title !== m.title) {
          score += 2;
          reasons.push('片名相近');
        }
        if (x.year && m.year && x.year === m.year) score += 0.3;
        return { movie: x, score, reason: reasons.slice(0, 2).join(' · ') || '相关' };
      })
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  /**
   * 刷新剧集的季信息。
   * 进详情时自动刷一次（同一条记录 1 小时内不重复刷，避免来回进出时反复请求），
   * 也可以点「↻ 刷新季」强制刷。
   */
  async function refreshSeasons(force) {
    const d = state.movieDraft;
    if (!d || d.isNew) return;
    const m = d.movie;
    if (m.type !== 'tv') return;
    const last = m.seasonsRefreshedAt ? Date.parse(m.seasonsRefreshedAt) : 0;
    if (!force && last && Date.now() - last < 60 * 60 * 1000) return; // 1 小时内已刷过
    const hint = $('#seasonRefreshHint');
    if (hint) hint.textContent = '刷新中…';
    try {
      const res = await api(`/api/movies/${encodeURIComponent(m.id)}/refresh-seasons`, { method: 'POST' });
      if (res.movie && state.movieDraft && state.movieDraft.movie.id === m.id) {
        state.movieDraft.movie = res.movie;
        const idx = state.movies.findIndex((x) => x.id === m.id);
        if (idx >= 0) state.movies[idx] = res.movie;
      }
      if (res.error) {
        if (force) toast(res.error, 'err');
      } else if (res.added > 0) {
        toast(`季信息已更新：新增 ${res.added} 季（共 ${res.seasonsAfter} 季）`);
      } else if (force) {
        toast(`季信息已是最新（共 ${res.seasonsAfter || (res.movie.seasons || []).length} 季）`);
      }
      if (state.movieDraft && state.movieDraft.movie.id === m.id) renderMovieSheet();
    } catch (err) {
      if (force) toast(`刷新失败：${err.message}`, 'err');
      const h = $('#seasonRefreshHint');
      if (h) h.textContent = '';
    }
  }

  /** 把某个影片归入手动系列（name 为空则先问名字） */
  async function assignManualSeries(movie, presetName) {
    const cur = (movie.collection && !movie.collection.id && movie.collection.name) || '';
    let name = presetName != null ? presetName : cur;
    if (!name) {
      name = window.prompt('系列名称（同系列的影片填同一个名字，例如：冰与火之歌）', cur);
      if (name == null) return;
    }
    const clean = String(name).trim();
    if (!clean) {
      toast('系列名不能为空', 'err');
      return;
    }
    const d = state.movieDraft;
    if (d && d.movie.id === movie.id) {
      await autoSaveMovie({ collection: { id: '', name: clean, manual: true } });
      await refresh();
      renderMovieSheet();
    } else {
      try {
        await api(`/api/movies/${encodeURIComponent(movie.id)}`, {
          method: 'PATCH',
          body: { collection: { id: '', name: clean, manual: true } },
        });
        await refresh();
      } catch (err) {
        toast(`保存失败：${err.message}`, 'err');
        return;
      }
    }
    toast(`已归入系列「${clean}」`);
  }

  /** 「＋ 添加影片」：勾选片库里的影片加入这个系列（也能取消勾选移出） */
  function openSeriesPicker(name) {
    const members = new Set(
      state.movies.filter((x) => (x.collection || {}).name === name && !(x.collection || {}).id).map((x) => x.id)
    );
    state.seriesPick = { name, selected: members, query: '' };
    drawSeriesPicker();
    openSheet('#sheetSeries');
  }

  function drawSeriesPicker() {
    const sp = state.seriesPick;
    if (!sp) return;
    $('#seriesTitle').textContent = `加入系列：${sp.name}`;
    $('#seriesBody').innerHTML = `
      <div class="searchbox" style="margin-bottom:10px">
        <input id="seriesSearch" type="search" placeholder="搜索片名 / 导演 / 年份" value="${esc(sp.query)}">
      </div>
      <div class="hint" style="font-size:12px;color:var(--text-mute);margin-bottom:8px">
        勾选＝加入「${esc(sp.name)}」，取消勾选＝移出；已选 <b id="seriesCount">${sp.selected.size}</b> 部
      </div>
      <div id="seriesRows" style="max-height:46vh;overflow:auto;border:1px solid var(--line);border-radius:12px"></div>
      <div class="sticky-bar">
        <button class="btn ghost" data-act="spick-none">清空</button>
        <button class="btn" data-act="spick-save">完成</button>
      </div>`;
    renderSeriesRows();
  }

  /** 只重画列表，不重建输入框（否则中文输入法组字会被打断） */
  function renderSeriesRows() {
    const sp = state.seriesPick;
    const wrap = $('#seriesRows');
    if (!sp || !wrap) return;
    const q = sp.query.trim().toLowerCase();
    const list = state.movies
      .filter((m) => !q || [m.title, (m.directors || []).join(' '), m.year].join(' ').toLowerCase().includes(q))
      .sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')));
    wrap.innerHTML = list.length
      ? list
          .map((m) => {
            const other = (m.collection || {}).name && (m.collection || {}).name !== sp.name ? (m.collection || {}).name : '';
            return `<label class="movie-pick-item">
              <input type="checkbox" data-spick-id="${esc(m.id)}" ${sp.selected.has(m.id) ? 'checked' : ''}>
              <div class="poster">${posterSrc(m) ? `<img loading="lazy" src="${esc(posterSrc(m))}" alt="">` : '🎬'}</div>
              <div class="info"><div class="t">${esc(m.title)}</div><div class="s">${esc(
              [m.year || '', m.type === 'tv' ? '剧集' : '电影', other ? `现属：${other}` : ''].filter(Boolean).join(' · ')
            )}</div></div>
            </label>`;
          })
          .join('')
      : '<div class="center">没有匹配的影片</div>';
    const c = $('#seriesCount');
    if (c) c.textContent = sp.selected.size;
  }

  async function applySeriesPick() {
    const sp = state.seriesPick;
    if (!sp) return;
    const target = sp.selected;
    const changed = [];
    for (const m of state.movies) {
      const isMember = (m.collection || {}).name === sp.name && !(m.collection || {}).id;
      const should = target.has(m.id);
      if (should && !isMember) changed.push([m, { id: '', name: sp.name, manual: true }]);
      else if (!should && isMember) changed.push([m, null]);
    }
    if (!changed.length) {
      toast('没有变化');
      return;
    }
    let ok = 0;
    for (const [m, collection] of changed) {
      try {
        await api(`/api/movies/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: { collection } });
        ok += 1;
      } catch (err) {
        /* 跳过失败的 */
      }
    }
    await refresh();
    closeSheet('#sheetSeries');
    state.seriesPick = null;
    renderMovieSheet();
    toast(`系列「${sp.name}」已更新：${ok} 部`);
  }

  /** 点导演 / 编剧 / 主演 → 列出这个人的全部作品 */
  async function openPersonWorks(name, tmdbId, role) {
    state.person = {
      name,
      tmdbId: tmdbId || '',
      role: role || '',
      filter: 'all',
      sort: localStorage.getItem('bn.personSort') || 'year-desc',
      works: [],
      counts: null,
      loading: true,
      error: '',
    };
    renderPerson();
    openSheet('#sheetPerson');
    await loadPersonWorks();
  }

  async function loadPersonWorks(force) {
    const p = state.person;
    if (!p) return;
    p.loading = true;
    p.error = '';
    renderPerson();
    try {
      const qs = new URLSearchParams({ role: p.role || '' });
      if (p.tmdbId) qs.set('tmdbId', p.tmdbId);
      else qs.set('name', p.name);
      if (force) qs.set('force', '1');
      const res = await api(`/api/person-works?${qs.toString()}`);
      p.person = res.person || { name: p.name };
      p.counts = res.counts || null;
      p.works = res.works || [];
      p.error = res.error || '';
    } catch (err) {
      p.error = err.message;
      p.works = [];
    }
    p.loading = false;
    renderPerson();
  }

  function renderPerson() {
    const p = state.person;
    const body = $('#personBody');
    if (!p || !body) return;
    const person = p.person || { name: p.name };
    const counts = p.counts || {};
    const roleNames = { director: '导演', writer: '编剧', actor: '演员' };
    const filters = [
      ['all', '全部', p.works.length],
      ['director', '导演', counts.director || 0],
      ['writer', '编剧', counts.writer || 0],
      ['actor', '演员', counts.actor || 0],
    ].filter((f) => f[0] === 'all' || f[2] > 0);

    let list = p.works.slice();
    if (p.filter !== 'all') list = list.filter((w) => w.role === p.filter);
    const year = (w) => Number(String(w.year || '').match(/\d{4}/) || 0);
    const sorters = {
      'year-desc': (a, b) => year(b) - year(a),
      'year-asc': (a, b) => (year(a) || 9999) - (year(b) || 9999),
      'rating-desc': (a, b) => (b.rating || 0) - (a.rating || 0),
      'votes-desc': (a, b) => (b.ratingCount || 0) - (a.ratingCount || 0),
      'title-asc': (a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'),
    };
    list.sort(sorters[p.sort] || sorters['year-desc']);

    $('#personTitle').textContent = `${person.name || p.name} · 全部作品`;
    body.innerHTML = `
      <div class="person-head">
        <div class="avatar">${
          person.profile ? `<img src="${esc(person.profile)}" alt="">` : '👤'
        }</div>
        <div style="min-width:0">
          <h3>${esc(person.name || p.name)}</h3>
          <div class="sub">${esc(
            [
              person.department === 'Directing' ? '导演' : person.department === 'Writing' ? '编剧' : person.department === 'Acting' ? '演员' : person.department || '',
              person.birthday ? `${person.birthday.slice(0, 4)} 年生` : '',
              person.place || '',
            ]
              .filter(Boolean)
              .join(' · ')
          )}</div>
          <div class="sub" style="margin-top:3px">共 ${counts.total || p.works.length} 部作品${
            counts.director ? ` · 导演 ${counts.director}` : ''
          }${counts.writer ? ` · 编剧 ${counts.writer}` : ''}${counts.actor ? ` · 演员 ${counts.actor}` : ''}</div>
        </div>
      </div>
      <div class="field-row" style="align-items:center;margin-bottom:10px">
        <select id="personFilter" style="flex:0 0 96px;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);padding:0 8px;font-size:12.5px">
          ${filters.map(([k, label, n]) => `<option value="${k}" ${p.filter === k ? 'selected' : ''}>${esc(label)}${n ? ` ${n}` : ''}</option>`).join('')}
        </select>
        <select id="personSort" style="flex:1;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);padding:0 8px;font-size:12.5px">
          ${[
            ['year-desc', '时间：新 → 旧'],
            ['year-asc', '时间：旧 → 新'],
            ['rating-desc', '评分：高 → 低'],
            ['votes-desc', '评价人数：多 → 少'],
            ['title-asc', '片名 A→Z'],
          ]
            .map(([k, label]) => `<option value="${k}" ${p.sort === k ? 'selected' : ''}>${esc(label)}</option>`)
            .join('')}
        </select>
      </div>
      ${
        p.loading
          ? '<div class="center"><span class="spinner"></span> 正在获取作品列表…</div>'
          : p.error
          ? `<div class="hint" style="color:#f59e0b">${esc(p.error)}</div>`
          : list.length
          ? `<div>${list
              .map(
                (w) => `<button class="person-work" ${
                  w.owned
                    ? `data-movie="${esc((state.movies.find((x) => String(x.tmdbId || '') === String(w.tmdbId)) || {}).id || '')}"`
                    : `data-movie-add="tmdb|${esc(w.sourceId)}|${esc(w.title)}|${esc(w.year || '')}"`
                }>
                  <div class="poster">${w.poster ? `<img loading="lazy" src="${esc(w.poster)}" alt="">` : '🎬'}</div>
                  <div class="info">
                    <div class="t">${esc(w.title)}</div>
                    <div class="s">${esc(
                      [
                        w.year || '',
                        w.rating ? `★ ${w.rating}` : '',
                        w.ratingCount ? `${w.ratingCount > 10000 ? (w.ratingCount / 10000).toFixed(1) + '万' : w.ratingCount} 人评` : '',
                        w.type === 'tv' ? '剧集' : '',
                        w.character ? `饰 ${w.character}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    )}</div>
                  </div>
                  <span class="badge ${w.owned ? 'owned' : ''}">${
                  w.owned ? '已在片库' : roleNames[w.role] || '加入'
                }</span>
                </button>`
              )
              .join('')}</div>`
          : '<div class="center">没有找到这个人的作品</div>'
      }
      <div class="btn-row" style="margin-top:14px">
        <button class="btn ghost sm" data-action="person-refresh">↻ 重新获取</button>
      </div>`;
  }

  /** 影片合集（007系列 / 漫威 / 哈利波特…）：TMDb belongs_to_collection */
  async function ensureMovieCollection(force) {
    const d = state.movieDraft;
    if (!d || d.isNew) return;
    const m = d.movie;
    if (!m.collection || !m.collection.id) {
      state.movieCollection = { movieId: m.id, parts: [], none: true };
      return;
    }
    if (!force && state.movieCollection && state.movieCollection.movieId === m.id) return;
    state.movieCollection = { movieId: m.id, collection: m.collection, parts: [], loading: true };
    renderMovieSheet();
    try {
      const res = await api(`/api/movies/${encodeURIComponent(m.id)}/collection${force ? '?force=1' : ''}`);
      state.movieCollection = {
        movieId: m.id,
        collection: res.collection || m.collection,
        parts: res.parts || [],
        error: res.error || '',
      };
    } catch (err) {
      state.movieCollection = { movieId: m.id, collection: m.collection, parts: [], error: err.message };
    }
    if (state.movieDraft && state.movieDraft.movie.id === m.id) renderMovieSheet();
  }

  async function ensureMovieRelated(force) {
    const d = state.movieDraft;
    if (!d || d.isNew) return;
    const m = d.movie;
    if (!force && state.movieRelated && state.movieRelated.movieId === m.id) return;
    state.movieRelated = { movieId: m.id, candidates: [] };
    const box = $('#movieRelated');
    if (box) box.innerHTML = '<div class="center"><span class="spinner"></span> 正在找相似影片…</div>';
    try {
      const res = await api(`/api/movies/${encodeURIComponent(m.id)}/related${force ? '?force=1' : ''}`);
      state.movieRelated = { movieId: m.id, candidates: res.candidates || [], error: res.error || '' };
    } catch (err) {
      state.movieRelated = { movieId: m.id, candidates: [], error: err.message };
    }
    if (state.movieDraft && state.movieDraft.movie.id === m.id) renderMovieSheet();
  }

  async function autoSaveMovie(patch) {
    const d = state.movieDraft;
    if (!d || d.isNew) return;
    const m = d.movie;
    const hint = $('#movieSaveHint');
    if (hint) {
      hint.textContent = '● 保存中…';
      hint.className = 'save-hint saving';
    }
    const before = { ...m };
    Object.assign(m, patch);
    try {
      const res = await api(`/api/movies/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: patch });
      const idx = state.movies.findIndex((x) => x.id === m.id);
      if (idx >= 0) state.movies[idx] = res.movie;
      d.movie = res.movie;
      state.movieStats = state.movieStats || {};
      api('/api/stats').then((s) => {
        state.stats = s;
        state.movieStats = s.movie || state.movieStats;
        renderStatusChips();
      }).catch(() => {});
      if (hint) {
        hint.textContent = '✓ 已保存';
        hint.className = 'save-hint saved';
      }
      return res.movie;
    } catch (err) {
      Object.assign(m, before);
      const idx = state.movies.findIndex((x) => x.id === m.id);
      if (idx >= 0) state.movies[idx] = before;
      if (hint) {
        hint.textContent = '⚠ 保存失败';
        hint.className = 'save-hint failed';
      }
      toast(`保存失败：${err.message}`, 'err');
      return null;
    }
  }

  async function saveNewMovie(status) {
    const d = state.movieDraft;
    if (!d) return;
    const m = d.movie;
    const payload = { ...m, status: status || m.status || 'wish' };
    try {
      const res = await api('/api/movies', { method: 'POST', body: payload });
      state.movies.unshift(res.movie);
      state.movieDraft = { movie: res.movie, isNew: false, patch: {}, excluded: new Set() };
      const st = state.movieStatuses[payload.status] || {};
      toast(`已加入片库 · ${st.label || ''}`);
      await refresh();
      openMovieSheet(res.movie.id);
    } catch (err) {
      if (err.status === 409 && err.data && err.data.movie) {
        toast('这部影片已经在片库里了');
        openMovieSheet(err.data.movie.id);
        return;
      }
      toast(`加入失败：${err.message}`, 'err');
    }
  }

  /* ---- 影片搜索 ---- */

  function openMovieSearch(prefill) {
    state.movieSearch = { q: prefill || '', results: [], sources: [], sourceStatus: [], busy: false, error: '' };
    renderMovieSearch();
    openSheet('#sheetMovieSearch');
    setTimeout(() => {
      const input = $('#movieSearchInput');
      if (input) input.focus();
    }, 120);
    if (prefill) runMovieSearch(prefill);
  }

  function renderMovieSearch() {
    const s = state.movieSearch;
    $('#movieSearchBody').innerHTML = `
      <div class="searchbox" style="margin-bottom:10px">
        <input id="movieSearchInput" type="search" placeholder="输入片名 / 原名 / 演员，如：星际穿越" value="${esc(s.q)}" autocomplete="off">
      </div>
      <div class="btn-row" style="margin-bottom:12px">
        <button class="btn" data-action="movie-search-run">${s.busy ? '搜索中…' : '搜索'}</button>
      </div>
      <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-bottom:8px">
        数据来自 豆瓣 + IMDb${state.settings.tmdbApiKeySet ? ' + TMDb' : ''}（在设置里可填 TMDb / OMDb Key 以获取更全的海外影片信息）；点一条即抓取详情
      </div>
      ${
        (s.sourceStatus || []).length
          ? `<div class="src-status">${s.sourceStatus
              .map(
                (x) =>
                  `<span class="src-pill ${x.ok ? 'ok' : 'bad'}" title="${esc(x.error || '')}">${
                    x.ok ? '●' : '○'
                  } ${esc(x.label)}${x.ok ? ` ${x.count}` : ''}</span>`
              )
              .join('')}</div>
            ${
              (s.sourceStatus || []).some((x) => !x.ok && x.error && x.error !== '没有匹配结果')
                ? `<div class="hint" style="font-size:11px;color:#f59e0b;margin:-4px 0 8px">${esc(
                    (s.sourceStatus || [])
                      .filter((x) => !x.ok && x.error && x.error !== '没有匹配结果')
                      .map((x) => `${x.label}：${x.error}`)
                      .join('；')
                  )}${
                    (s.sourceStatus || []).some((x) => x.key === 'douban' && !x.ok) && !state.settings.doubanCookieSet
                      ? '<br>豆瓣的<b>搜索</b>接口对机房/高频 IP 会限流（详情与推荐接口不受影响）。' +
                        '可在「设置 → 豆瓣 Cookie」填入登录态恢复；' +
                        '或直接把豆瓣链接 / 条目 id（如 1292052）粘进搜索框，走详情接口直接抓取。'
                      : ''
                  }</div>`
                : ''
            }`
          : ''
      }
      ${
        s.error
          ? `<div class="hint" style="color:#f87171">${esc(s.error)}</div>`
          : s.busy
          ? '<div class="center"><span class="spinner"></span> 正在搜索…</div>'
          : s.results.length
          ? s.results
              .map(
                (r) => `<button class="search-item" data-movie-pick="${esc(r.source)}|${esc(r.sourceId)}|${esc(r.title)}|${esc(r.year || '')}">
                  <div class="poster">${r.poster ? `<img loading="lazy" src="${esc(r.poster)}" alt="">` : '🎬'}</div>
                  <div class="info">
                    <div class="t">${esc(r.title)}</div>
                    <div class="s">${esc(
                      [r.year, r.subtitle, r.type === 'tv' ? '剧集' : '电影', r.rating ? `★ ${r.rating}` : '', (r.actors || []).slice(0, 2).join(' ')]
                        .filter(Boolean)
                        .join(' · ')
                    )}</div>
                  </div>
                  <span class="badge">${esc(r.sourceLabel)}</span>
                </button>`
              )
              .join('')
          : s.q
          ? '<div class="center">没有找到相关影片</div>'
          : '<div class="center">输入片名开始搜索</div>'
      }
      <div class="btn-row" style="margin-top:14px">
        <button class="btn ghost" data-action="movie-manual">手动录入影片</button>
      </div>`;
  }

  /** 输入的是豆瓣链接或纯数字 id 时，直接按条目抓取（跳过被限流的搜索接口） */
  function parseDoubanRef(q) {
    const s = String(q || '').trim();
    let m = s.match(/douban\.com\/subject\/(\d+)/i);
    if (m) return m[1];
    m = s.match(/^https?:\/\/m\.douban\.com\/movie\/subject\/(\d+)/i);
    if (m) return m[1];
    if (/^\d{6,10}$/.test(s)) return s;
    return '';
  }

  async function runMovieSearch(keyword) {
    const q = (keyword != null ? keyword : (($('#movieSearchInput') || {}).value || '')).trim();
    if (!q) return;
    // 直接给了豆瓣条目 id / 链接 → 走 detail 接口（不受搜索限流影响）
    const doubanId = parseDoubanRef(q);
    if (doubanId) {
      state.movieSearch.q = q;
      state.movieSearch.busy = true;
      state.movieSearch.error = '';
      state.movieSearch.results = [];
      state.movieSearch.sourceStatus = [{ key: 'douban', label: '豆瓣条目', ok: true, count: 1, error: '' }];
      renderMovieSearch();
      await pickMovieResult('douban', doubanId, '', '');
      return;
    }
    state.movieSearch.q = q;
    state.movieSearch.busy = true;
    state.movieSearch.error = '';
    renderMovieSearch();
    try {
      const res = await api(`/api/movie-search?q=${encodeURIComponent(q)}`);
      state.movieSearch.results = res.results || [];
      state.movieSearch.sources = res.sources || [];
      state.movieSearch.sourceStatus = res.sourceStatus || [];
      state.movieSearch.error = res.error || '';
    } catch (err) {
      state.movieSearch.error = err.message;
      state.movieSearch.results = [];
    }
    state.movieSearch.busy = false;
    renderMovieSearch();
  }

  async function pickMovieResult(source, sourceId, title, year) {
    const s = state.movieSearch;
    s.busy = true;
    s.error = '';
    renderMovieSearch();
    try {
      const res = await api('/api/movie-lookup', { method: 'POST', body: { source, sourceId, title, year } });
      s.busy = false;
      openMovieSheet(res.record, { saved: false });
    } catch (err) {
      s.busy = false;
      s.error = `抓取失败：${err.message}`;
      renderMovieSearch();
    }
  }

  /* ---- 片单 ---- */

  function renderMovieLists() {
    $('#listsTitle').textContent = '我的片单';
    const lists = state.movieLists;
    const creating = state.creatingMovieList
      ? `<div class="section" style="background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--radius);padding:12px">
          <div class="inline-form"><input type="text" id="newMovieListName" placeholder="片单名称，例如「诺兰合集」" maxlength="24"></div>
          <div class="inline-form" style="margin-top:8px"><input type="text" id="newMovieListDesc" placeholder="一句话说明（可选）" maxlength="60"></div>
          <div class="palette" id="movieListPalette">${PALETTE.map(
            (c) => `<button data-mlcolor="${c}" class="${state.newMovieListColor === c ? 'on' : ''}" style="background:${c}"></button>`
          ).join('')}</div>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn ghost" data-action="movie-list-create-cancel">取消</button>
            <button class="btn" data-action="movie-list-create">创建片单</button>
          </div>
        </div>`
      : '';
    if (state.movieCurrentListId) return renderMovieListDetail(state.movieCurrentListId, creating);

    $('#listsBody').innerHTML = `
      ${creating}
      <div class="btn-row" style="margin-bottom:14px">
        <button class="btn ghost" data-action="movie-list-new">＋ 新建片单</button>
      </div>
      ${
        lists.length
          ? lists
              .map((l) => {
                const st = l.stats || {};
                return `<button class="list-card" data-movie-list-open="${esc(l.id)}">
                  <div class="list-card-head">
                    <span class="dot" style="background:${esc(l.color)}"></span>
                    <b>${esc(l.name)}</b>
                    <span class="spacer"></span>
                    <span class="hint">${esc(st.label || '0/0')}</span>
                  </div>
                  ${l.description ? `<div class="hint" style="margin:4px 0 6px">${esc(l.description)}</div>` : ''}
                  <div class="bar"><i style="width:${st.progress || 0}%;background:${esc(l.color)}"></i></div>
                  <div class="chips" style="margin-top:8px">
                    <span class="chip-mini">想看 ${st.wish || 0}</span>
                    <span class="chip-mini">在看 ${st.watching || 0}</span>
                    <span class="chip-mini">看过 ${st.watched || 0}</span>
                    ${st.avgMyRating ? `<span class="chip-mini">均分 ${st.avgMyRating}</span>` : ''}
                  </div>
                </button>`;
              })
              .join('')
          : '<div class="center">还没有片单<br><span class="hint">片单可以把「诺兰合集」「宫崎骏」「待看清单」这类主题单独拎出来</span></div>'
      }`;
  }

  function renderMovieListDetail(listId, creating) {
    const l = state.movieLists.find((x) => x.id === listId);
    if (!l) {
      state.movieCurrentListId = '';
      return renderMovieLists();
    }
    const ids = l.movieIds || [];
    const movies = ids.map(movieById).filter(Boolean);
    const sortKey = l.sort || 'added-desc';
    const year = (m) => Number(String(m.year || '').match(/\d{4}/) || 0);
    const statusRank = (m) => {
      const i = MOVIE_STATUS_ORDER.indexOf(m.status);
      return i < 0 ? 99 : i;
    };
    const order = (m) => ids.indexOf(m.id);
    movies.sort((a, b) => {
      switch (sortKey) {
        case 'added-asc':
          return order(a) - order(b);
        case 'rating-desc':
          return (b.rating || 0) - (a.rating || 0);
        case 'myrating-desc':
          return (b.myRating || 0) - (a.myRating || 0);
        case 'title-asc':
          return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
        case 'director-asc':
          return String((a.directors || [])[0] || '').localeCompare(String((b.directors || [])[0] || ''), 'zh-Hans-CN');
        case 'year-desc':
          return year(b) - year(a);
        case 'year-asc':
          return year(a) - year(b);
        case 'status-asc':
          return statusRank(a) - statusRank(b) || order(b) - order(a);
        default:
          return order(b) - order(a);
      }
    });
    const st = l.stats || {};
    $('#listsBody').innerHTML = `
      <button class="btn ghost sm" data-action="movie-list-back">‹ 全部片单</button>
      <div class="section" style="margin-top:10px;background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--radius);padding:12px">
        <div class="list-card-head">
          <span class="dot" style="background:${esc(l.color)}"></span>
          <b style="font-size:15px">${esc(l.name)}</b>
          <span class="spacer"></span>
          <button class="btn ghost sm" data-action="movie-list-edit">编辑</button>
        </div>
        ${l.description ? `<div class="hint" style="margin:6px 0">${esc(l.description)}</div>` : ''}
        <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
          <b style="font-size:19px">${esc(st.label || '0/0')}</b>
          <span class="hint">看过 / 共</span>
          <div class="bar" style="flex:1"><i style="width:${st.progress || 0}%;background:${esc(l.color)}"></i></div>
        </div>
        <div class="chips" style="margin-top:10px">
          <span class="chip-mini">想看 ${st.wish || 0}</span>
          <span class="chip-mini">在看 ${st.watching || 0}</span>
          <span class="chip-mini">看过 ${st.watched || 0}</span>
          ${st.dropped ? `<span class="chip-mini">弃看 ${st.dropped}</span>` : ''}
        </div>
        <div class="inline-form" style="margin-top:12px">
          <select id="movieListSort">${Object.entries(state.movieListSorts)
            .map(([k, label]) => `<option value="${esc(k)}" ${sortKey === k ? 'selected' : ''}>${esc(label)}</option>`)
            .join('')}</select>
          <button class="btn sm" data-action="movie-list-add">＋ 添加 / 管理影片</button>
        </div>
      </div>
      ${creating || ''}
      ${
        movies.length
          ? `<div class="movie-grid">${movies.map(movieCardHtml).join('')}</div>`
          : '<div class="center">这个片单还是空的<br><span class="hint">点上面的「＋ 添加 / 管理影片」从片库里挑</span></div>'
      }
      <div class="btn-row" style="margin-top:16px">
        <button class="btn ghost danger" data-action="movie-list-delete">删除片单</button>
      </div>`;
  }

  function renderMovieListsIfOpen() {
    if (state.mode !== 'movie') return;
    const sheet = $('#sheetLists');
    if (sheet && sheet.classList.contains('open')) renderMovieLists();
  }

  function openMovieListPicker(listId) {
    const l = state.movieLists.find((x) => x.id === listId);
    if (!l) return;
    state.movieListPick = {
      listId,
      selected: new Set(l.movieIds || []),
      query: '',
      sort: localStorage.getItem('bn.movieListPickSort') || 'added-desc',
    };
    drawMovieListPicker();
    openSheet('#sheetMovieListPick');
  }

  function drawMovieListPicker() {
    const lp = state.movieListPick;
    if (!lp) return;
    const l = state.movieLists.find((x) => x.id === lp.listId);
    if (!l) return;
    const q = lp.query.trim().toLowerCase();
    const inList = new Set(l.movieIds || []);
    let movies = state.movies.filter(
      (m) =>
        !q ||
        [m.title, m.originalTitle, (m.directors || []).join(' '), (m.actors || []).join(' '), (m.genres || []).join(' '), m.year]
          .join(' ')
          .toLowerCase()
          .includes(q)
    );
    const year = (m) => Number(String(m.year || '').match(/\d{4}/) || 0);
    const sortKey = lp.sort || 'added-desc';
    movies = movies.slice().sort((a, b) => {
      switch (sortKey) {
        case 'added-asc':
          return String(a.addedAt).localeCompare(String(b.addedAt));
        case 'title-asc':
          return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
        case 'year-desc':
          return year(b) - year(a);
        case 'rating-desc':
          return (b.rating || 0) - (a.rating || 0);
        default:
          return String(b.addedAt).localeCompare(String(a.addedAt));
      }
    });
    const sortOptions = [
      ['added-desc', '最近添加'],
      ['added-asc', '最早添加'],
      ['members-first', '已在片单优先'],
      ['title-asc', '片名 A→Z'],
      ['year-desc', '年份新→旧'],
      ['rating-desc', '评分高→低'],
    ];
    const sorted =
      sortKey === 'members-first'
        ? movies
            .slice()
            .sort(
              (a, b) =>
                (inList.has(b.id) ? 1 : 0) - (inList.has(a.id) ? 1 : 0) ||
                String(b.addedAt).localeCompare(String(a.addedAt))
            )
        : movies;
    $('#movieListPickTitle').textContent = `${l.name} · 选择影片`;
    $('#movieListPickBody').innerHTML = `
      <div class="field-row" style="margin-bottom:10px;align-items:center">
        <input id="movieListPickSearch" type="search" placeholder="搜索片库里的影片" value="${esc(lp.query)}"
          style="flex:1;min-width:0;height:38px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);padding:0 10px;outline:none">
        <select id="movieListPickSort" style="flex:0 0 138px;height:38px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);padding:0 8px;font-size:13px;color:var(--text-dim)">
          ${sortOptions.map(([k, label]) => `<option value="${esc(k)}" ${sortKey === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
      </div>
      <div class="hint" style="font-size:12px;color:var(--text-mute);margin-bottom:8px">
        已选 <b id="movieListPickCount">${lp.selected.size}</b> 部 · 共 ${sorted.length} 部可选；取消勾选即从片单移出
      </div>
      <div style="max-height:46vh;overflow:auto;border:1px solid var(--line);border-radius:12px">
        ${
          sorted.length
            ? sorted
                .map(
                  (m) => `<label class="movie-pick-item">
                    <input type="checkbox" data-mpick-id="${esc(m.id)}" ${lp.selected.has(m.id) ? 'checked' : ''}>
                    <div class="poster">${posterSrc(m) ? `<img loading="lazy" src="${esc(posterSrc(m))}" alt="">` : '🎬'}</div>
                    <div class="info"><div class="t">${esc(m.title)}</div><div class="s">${esc(
                    [m.year, (m.directors || [])[0], inList.has(m.id) ? '已在片单' : ''].filter(Boolean).join(' · ')
                  )}</div></div>
                  </label>`
                )
                .join('')
            : '<div class="center">没有匹配的影片</div>'
        }
      </div>
      <div class="sticky-bar">
        <button class="btn ghost" data-act="mpick-all">全选</button>
        <button class="btn ghost" data-act="mpick-none">清空</button>
        <button class="btn" data-act="mpick-save">完成</button>
      </div>`;
  }

  /** 只重画片单挑片的列表（保住输入框，避免中文输入法被打断） */
  function renderMovieListPickRows() {
    const lp = state.movieListPick;
    const wrap = $('#movieListPickRows');
    if (!lp || !wrap) return;
    const l = state.movieLists.find((x) => x.id === lp.listId);
    if (!l) return;
    const q = lp.query.trim().toLowerCase();
    const inList = new Set(l.movieIds || []);
    let movies = state.movies.filter(
      (m) =>
        !q ||
        [m.title, m.originalTitle, (m.directors || []).join(' '), (m.actors || []).join(' '), (m.genres || []).join(' '), m.year]
          .join(' ')
          .toLowerCase()
          .includes(q)
    );
    const year = (m) => Number(String(m.year || '').match(/\d{4}/) || 0);
    const sortKey = lp.sort || 'added-desc';
    movies = movies.slice().sort((a, b) => {
      switch (sortKey) {
        case 'added-asc':
          return String(a.addedAt).localeCompare(String(b.addedAt));
        case 'title-asc':
          return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
        case 'year-desc':
          return year(b) - year(a);
        case 'rating-desc':
          return (b.rating || 0) - (a.rating || 0);
        case 'members-first':
          return (inList.has(b.id) ? 1 : 0) - (inList.has(a.id) ? 1 : 0) || String(b.addedAt).localeCompare(String(a.addedAt));
        default:
          return String(b.addedAt).localeCompare(String(a.addedAt));
      }
    });
    wrap.innerHTML = movies.length
      ? movies
          .map(
            (m) => `<label class="movie-pick-item">
              <input type="checkbox" data-mpick-id="${esc(m.id)}" ${lp.selected.has(m.id) ? 'checked' : ''}>
              <div class="poster">${posterSrc(m) ? `<img loading="lazy" src="${esc(posterSrc(m))}" alt="">` : '🎬'}</div>
              <div class="info"><div class="t">${esc(m.title)}</div><div class="s">${esc(
              [m.year, (m.directors || [])[0], inList.has(m.id) ? '已在片单' : ''].filter(Boolean).join(' · ')
            )}</div></div>
            </label>`
          )
          .join('')
      : '<div class="center">没有匹配的影片</div>';
    const c = $('#movieListPickCount');
    if (c) c.textContent = lp.selected.size;
  }

  async function applyMovieListPick(set) {
    const lp = state.movieListPick;
    if (!lp) return;
    const l = state.movieLists.find((x) => x.id === lp.listId);
    if (!l) return;
    const current = new Set(l.movieIds || []);
    const add = [...set].filter((id) => !current.has(id));
    const remove = [...current].filter((id) => !set.has(id));
    try {
      if (add.length) {
        const res = await api(`/api/movie-lists/${encodeURIComponent(l.id)}/movies`, { method: 'POST', body: { movieIds: add } });
        Object.assign(l, res.movieList);
      }
      if (remove.length) {
        const res = await api(`/api/movie-lists/${encodeURIComponent(l.id)}/movies/remove`, { method: 'POST', body: { movieIds: remove } });
        Object.assign(l, res.movieList);
      }
      if (!add.length && !remove.length) {
        /* nothing changed */
      }
      toast(`已更新片单：+${add.length} / -${remove.length}`);
      await refresh();
    } catch (err) {
      toast(`更新失败：${err.message}`, 'err');
    }
  }

  async function toggleMovieInList(listId) {
    const d = state.movieDraft;
    if (!d || d.isNew) {
      toast('先加入片库再归入片单');
      return;
    }
    const l = state.movieLists.find((x) => x.id === listId);
    if (!l) return;
    const inList = (l.movieIds || []).includes(d.movie.id);
    try {
      const res = await api(`/api/movie-lists/${encodeURIComponent(listId)}/movies${inList ? '/remove' : ''}`, {
        method: 'POST',
        body: { movieIds: [d.movie.id] },
      });
      Object.assign(l, res.movieList);
      renderMovieSheet();
      if (state.movieCurrentListId === listId) renderMovieLists();
      toast(inList ? `已从「${l.name}」移出` : `已加入「${l.name}」`);
    } catch (err) {
      toast(`操作失败：${err.message}`, 'err');
    }
  }

  function renderMovieStats() {
    const s = state.movieStats || {};
    const byStatus = s.byStatus || {};
    const max = (arr) => Math.max(1, ...arr.map((x) => x.count));
    $('#statsBody').innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="num">${s.total || 0}</div><div class="lbl">影片总数</div></div>
        <div class="stat-card"><div class="num">${byStatus.watched || 0}</div><div class="lbl">看过</div></div>
        <div class="stat-card"><div class="num">${byStatus.watching || 0}</div><div class="lbl">在看</div></div>
        <div class="stat-card"><div class="num">${byStatus.wish || 0}</div><div class="lbl">想看</div></div>
        <div class="stat-card"><div class="num">${byStatus.dropped || 0}</div><div class="lbl">弃看</div></div>
        <div class="stat-card"><div class="num">${s.avgMyRating || 0}</div><div class="lbl">平均我的评分</div></div>
      </div>
      <div class="section"><div class="section-head"><h3>类型分布</h3></div>
        ${
          (s.byGenre || []).length
            ? (s.byGenre || [])
                .slice(0, 12)
                .map(
                  (g) => `<div class="bar-row"><span class="bar-label">${esc(g.name)}</span>
                    <div class="bar"><i style="width:${Math.round((g.count / max(s.byGenre)) * 100)}%"></i></div>
                    <span class="bar-num">${g.count}</span></div>`
                )
                .join('')
            : '<div class="hint">还没有数据</div>'
        }
      </div>
      <div class="section"><div class="section-head"><h3>标签使用</h3></div>
        <div class="chips">${
          (s.byTag || [])
            .map((t) => `<span class="chip-mini" style="background:${esc(t.color)}22;color:${esc(t.color)}">${esc(t.name)} ${t.count}</span>`)
            .join('') || '<span class="hint">还没有标签</span>'
        }</div>
      </div>`;
  }

  /* ---------------- 启动 ---------------- */

  function applyHash() {
    const h = String(location.hash || '').replace(/^#\/?/, '');
    if (!h) return;
    if (h.indexOf('book/') === 0) {
      const id = h.slice(5);
      if (state.books.some((b) => b.id === id)) openBookDetail(id);
      return;
    }
    const tab = ['books', 'movies', 'add', 'stats', 'settings', 'lists'].indexOf(h) >= 0 ? h : '';
    if (!tab) return;
    const btn = $(`#tabbar button[data-tab="${tab}"]`);
    if (btn) btn.click();
  }

  async function main() {
    updateViewModeBtn();
    bindEvents();
    // 记住上次停在哪一侧：书 / 影 一级菜单高亮
    $$('#tabbar button').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === (state.mode === 'movie' ? 'movies' : 'books'))
    );
    try {
      await bootstrap();
    } catch (err) {
      $('#view').innerHTML = `<div class="empty"><div class="big">⚠️</div><p>无法连接服务：${esc(err.message)}</p>
        <p>请确认 <code>start.sh</code> 仍在运行。</p></div>`;
      return;
    }
    applyHash();
    window.addEventListener('hashchange', applyHash);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // 支持扫码枪：任意位置输入数字后回车
    let buffer = '';
    let bufferAt = 0;
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;
      const now = Date.now();
      if (now - bufferAt > 500) buffer = '';
      bufferAt = now;
      if (e.key === 'Enter' && buffer.length >= 10) {
        const code = buffer;
        buffer = '';
        handleScanned(code);
      } else if (/^[\dxX]$/.test(e.key)) {
        buffer += e.key;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', main);
  window.BookNest = { state, refresh, openEntrySheet };
})();
