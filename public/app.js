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
    catSel.innerHTML =
      `<option value="">全部分类</option><option value="__none__">未分类</option>` +
      state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    tagSel.innerHTML =
      `<option value="">全部标签</option>` + state.tags.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    catSel.value = state.filters.category;
    tagSel.value = state.filters.tagIds[0] || '';
    $('#sortBy').value = state.filters.sort;
    $('#searchInput').value = state.filters.q;
    $('#searchClear').classList.toggle('hidden', !state.filters.q);
  }

  function renderAll() {
    renderStatusChips();
    renderFilterOptions();
    renderShelf();
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
    const rows = books
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
      .join('');

    // 排序选项：书单专有的「已在书单优先」插在加入时间后面
    const sortOptions = (() => {
      const out = [];
      for (const k of Object.keys(BOOK_SORTS)) {
        out.push([k, BOOK_SORTS[k]]);
        if (k === 'added-asc') out.push(['members-first', '已在书单优先']);
      }
      return out
        .map(([k, label]) => `<option value="${esc(k)}" ${sortKey === k ? 'selected' : ''}>${esc(label)}</option>`)
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
        已选 <b id="listPickCount">${lp.selected.size}</b> 本 · 共 ${books.length} 本可选；取消勾选即从书单中移出
      </div>
      <div style="max-height:46vh;overflow:auto;border:1px solid var(--line);border-radius:12px">
        ${rows || '<div class="center">没有匹配的书</div>'}
      </div>
      <div class="sticky-bar">
        <button class="btn ghost" data-act="pick-all">全选</button>
        <button class="btn ghost" data-act="pick-none">清空</button>
        <button class="btn" data-act="pick-save">完成</button>
      </div>`;
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
          保存后需重启服务生效（终端 Ctrl+C 后重新运行 <code>./start.sh</code>）；启动脚本会自动探测 7890 / 7897 等常见代理端口。
        </div>
        <div class="inline-form" style="margin-top:10px">
          <input type="text" id="googleKey" placeholder="Google Books API Key（可选）" value="${esc(
            state.settings.googleBooksApiKey || ''
          )}">
          <button class="btn sm" data-action="save-gkey">保存</button>
        </div>
        <div class="hint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">
          Google Books 的匿名配额常被用尽（返回 429）；填一个免费 API Key 后立即生效，可用来补齐海外书目信息。
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
      })
    );

    $('#tabbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      const tab = btn.dataset.tab;
      $$('#tabbar button').forEach((b) => b.classList.toggle('active', b === btn));
      if (tab === 'shelf') {
        window.BookScanner.stop(false);
        closeAllSheets();
        return;
      }
      closeAllSheets();
      if (tab !== 'shelf') state.draft = null;
      if (tab === 'scan') {
        openSheet('#sheetScan');
        renderSession();
        if (window.BookScanner.isRunning()) window.BookScanner.resume();
        else startCamera();
      } else if (tab === 'manage') {
        renderManage();
        openSheet('#sheetManage');
      } else if (tab === 'lists') {
        state.creatingList = false;
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

    // 书架交互
    $('#view').addEventListener('click', (e) => {
      const bookBtn = e.target.closest('[data-book]');
      if (bookBtn) {
        openBookDetail(bookBtn.dataset.book);
        return;
      }
      const action = e.target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'goto-scan') {
        $('#tabbar button[data-tab="scan"]').click();
      } else if (action.dataset.action === 'clear-filters') {
        state.filters = { status: '', category: '', tag: '', q: '', sort: 'added-desc', tagIds: [] };
        renderAll();
      }
    });

    $('#statusChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-status]');
      if (!chip) return;
      state.filters.status = chip.dataset.status;
      renderStatusChips();
      renderShelf();
    });
    $('#filterCategory').addEventListener('change', (e) => {
      state.filters.category = e.target.value;
      renderShelf();
    });
    $('#filterTag').addEventListener('change', (e) => {
      state.filters.tagIds = e.target.value ? [e.target.value] : [];
      renderShelf();
    });
    $('#sortBy').addEventListener('change', (e) => {
      state.filters.sort = e.target.value;
      renderShelf();
    });
    let searchTimer = null;
    $('#searchInput').addEventListener('input', (e) => {
      const v = e.target.value;
      $('#searchClear').classList.toggle('hidden', !v);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filters.q = v;
        renderShelf();
      }, 160);
    });
    $('#searchClear').addEventListener('click', () => {
      $('#searchInput').value = '';
      state.filters.q = '';
      $('#searchClear').classList.add('hidden');
      renderShelf();
    });
    $('#btnViewMode').addEventListener('click', () => {
      const order = ['grid', 'list', 'group'];
      state.viewMode = order[(order.indexOf(state.viewMode) + 1) % order.length];
      localStorage.setItem('bn.viewMode', state.viewMode);
      $('#btnViewMode').textContent = state.viewMode === 'grid' ? '▦' : state.viewMode === 'list' ? '☰' : '⊞';
      toast(state.viewMode === 'grid' ? '网格视图' : state.viewMode === 'list' ? '列表视图' : '按分类分组');
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
        if (action === 'check-providers') {
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
          const res = await api('/api/settings', { method: 'PATCH', body: { googleBooksApiKey: key } });
          state.settings.googleBooksApiKey = res.settings.googleBooksApiKey;
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
        toast(`导入完成：新增 ${res.added} 本，跳过 ${res.skipped} 本`);
        await refresh();
        renderSettings();
      } catch (err) {
        toast(`导入失败：${err.message}`, 'err');
      }
    });
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
    const tab = ['scan', 'manage', 'stats', 'settings', 'lists'].indexOf(h) >= 0 ? h : '';
    if (!tab) return;
    const btn = $(`#tabbar button[data-tab="${tab}"]`);
    if (btn) btn.click();
  }

  async function main() {
    $('#btnViewMode').textContent = state.viewMode === 'grid' ? '▦' : state.viewMode === 'list' ? '☰' : '⊞';
    bindEvents();
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
