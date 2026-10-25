/* 영화도감 뷰어
 *
 * data/movies.json 하나만 읽어서 전체를 그린다. 원고(책-movie 저장소)의
 * tools/export_web.py 가 이 JSON을 만들어 내므로, 이 파일을 손으로 고치지 않는다. */

(function () {
  'use strict';

  var REPO = 'https://github.com/leaf-kit/book-movie';
  var BASE = location.pathname.replace(/[^/]*$/, '');

  var LS = { theme: 'moviedex.theme', stars: 'moviedex.stars', tmdb: 'moviedex.tmdb.v1' };

  /* ───────── 포스터(TMDb 실시간 연동) ─────────
   * 포스터 파일을 이 저장소에 두지 않는다. TMDb가 자기 CDN에서 서빙하는
   * 이미지를 그때그때 불러와 보여 줄 뿐이다. 찾은 결과(포스터 경로)만
   * 로컬에 잠깐 캐시해 같은 검색을 반복하지 않는다. */
  var TMDB = {
    key: window.TMDB_API_KEY || '',
    api: 'https://api.themoviedb.org/3',
    img: 'https://image.tmdb.org/t/p/'
  };
  var TMDB_TTL = 14 * 24 * 3600 * 1000;

  function tmdbCacheGet(no) {
    var c = store(LS.tmdb) || {};
    var e = c[no];
    if (!e || Date.now() - e.ts > TMDB_TTL) return undefined;
    return e.v;
  }
  function tmdbCacheSet(no, v) {
    var c = store(LS.tmdb) || {};
    c[no] = { v: v, ts: Date.now() };
    store(LS.tmdb, c);
  }

  function tmdbQuery(q, year) {
    var url = TMDB.api + '/search/movie?api_key=' + encodeURIComponent(TMDB.key) +
      '&query=' + encodeURIComponent(q) + '&language=ko-KR&include_adult=false' +
      (year ? '&year=' + year : '');
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.results && d.results.length ? d.results[0] : null; })
      .catch(function () { return null; });
  }

  /* 제목만으로 검색하면 리메이크·속편·동명 영화가 잘못 걸릴 수 있다.
     data/tmdb-ids.json 에 영화별로 확인해 둔 TMDb ID가 있으면 검색을
     건너뛰고 그 ID로 바로 조회한다. */
  function tmdbById(id) {
    var url = TMDB.api + '/movie/' + id + '?api_key=' + encodeURIComponent(TMDB.key) + '&language=ko-KR';
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function tmdbResolve(m) {
    if (!TMDB.key) return Promise.resolve(null);
    var cached = tmdbCacheGet(m.no);
    if (cached !== undefined) return Promise.resolve(cached);

    var knownId = state.tmdbIds[m.no];
    var hitPromise;
    if (knownId) {
      hitPromise = tmdbById(knownId);
    } else {
      var year = (m.year.match(/\d{4}/) || [])[0];
      var isKorean = m.country.indexOf('한국') >= 0;
      var primary = isKorean ? m.title : (m.original || m.title);
      var fallback = isKorean ? m.original : m.title;

      hitPromise = tmdbQuery(primary, year)
        .then(function (hit) { return hit || tmdbQuery(primary, null); })
        .then(function (hit) {
          return hit || (fallback && fallback !== primary ? tmdbQuery(fallback, year) : null);
        });
    }

    return hitPromise.then(function (hit) {
      var v = hit && hit.poster_path ? { poster: hit.poster_path, id: hit.id } : null;
      tmdbCacheSet(m.no, v);
      return v;
    });
  }

  /* data/pd-posters.json 에 올라 있는, 미국 내 퍼블릭도메인으로 확인된
     위키미디어 커먼즈 포스터를 우선 쓴다. 없으면 TMDb로 넘어간다. 둘 다
     이 저장소에 이미지를 저장하지 않고 원본 CDN을 그대로 가리킨다. */
  function pdThumbUrl(file, width) {
    return 'https://commons.wikimedia.org/wiki/Special:FilePath/' +
      encodeURIComponent(file) + '?width=' + width;
  }

  function resolvePoster(m) {
    var pd = state.pdPosters[m.no];
    if (pd) {
      return Promise.resolve({ type: 'pd', file: pd.file, source: pd.source, label: '퍼블릭도메인 · 위키미디어 커먼즈' });
    }
    return tmdbResolve(m).then(function (hit) {
      return hit ? { type: 'tmdb', path: hit.poster, id: hit.id, label: 'TMDb' } : null;
    });
  }

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var el = {
    toc: $('#toc'), doc: $('#doc'), main: $('#main'), sidebar: $('#sidebar'),
    q: $('#q'), qClear: $('#q-clear'), qm: $('#q-m'), qClearM: $('#q-clear-m'),
    menu: $('#menu'), scrim: $('#scrim'), totop: $('#totop')
  };

  var state = {
    data: null,
    byNo: {},
    byChapter: {},
    pdPosters: {},
    tmdbIds: {},
    q: '',
    explore: { tab: 'region', region: null, range: null }
  };

  function store(k, v) {
    try {
      if (v === undefined) { var s = localStorage.getItem(k); return s === null ? null : JSON.parse(s); }
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ───────── 데이터 ───────── */

  function partOf(key) { return state.data.parts.filter(function (p) { return p.key === key; })[0]; }
  function chapterOf(key) { return state.byChapter[key]; }

  function load() {
    var movies = fetch(BASE + 'data/movies.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
      return r.json();
    }).then(function (d) {
      state.data = d;
      d.movies.forEach(function (m) { state.byNo[m.no] = m; });
      d.chapters.forEach(function (c) { state.byChapter[c.key] = c; });
    });
    var pd = fetch(BASE + 'data/pd-posters.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.posters) return;
        d.posters.forEach(function (p) { state.pdPosters[p.no] = p; });
      })
      .catch(function () { /* 없어도 TMDb·플레이스홀더로 대체된다 */ });
    var tmdbIds = fetch(BASE + 'data/tmdb-ids.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ids) return;
        d.ids.forEach(function (e) { state.tmdbIds[e.no] = e.tmdb_id; });
      })
      .catch(function () { /* 없어도 제목 검색으로 대체된다 */ });
    return Promise.all([movies, pd, tmdbIds]);
  }

  /* ───────── 차례(왼쪽) ───────── */

  function renderToc() {
    var html = '<a class="home-link" href="#/" data-route="home">전체</a>';
    html += '<a class="home-link" href="#/explore" data-route="explore">탐색 — 제작국·시대·관계망</a>';
    state.data.parts.forEach(function (p) {
      var chs = state.data.chapters.filter(function (c) { return c.part === p.key; });
      var cnt = state.data.movies.filter(function (m) { return m.part === p.key; }).length;
      html += '<div class="part" data-open="0" data-part="' + p.key + '">';
      html += '<button class="part-h" type="button" aria-expanded="false">' +
              '<span class="sw" style="background:' + p.color + '"></span>' +
              '<span class="n">' + esc(p.roman) + '</span>' +
              '<span>' + esc(p.title.split(' — ')[0]) + '</span>' +
              '<svg class="caret" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 8l4 4 4-4"/></svg>' +
              '</button><ul>';
      html += '<li><a href="#/part/' + p.key + '" data-route="part:' + p.key + '">' +
              '<span>부 전체 보기</span><span class="cnt">' + cnt + '</span></a></li>';
      chs.forEach(function (c) {
        var n = state.data.movies.filter(function (m) { return m.chapter === c.key; }).length;
        html += '<li><a href="#/chapter/' + c.key + '" data-route="chapter:' + c.key + '">' +
                '<span>' + esc(c.title) + '</span><span class="cnt">' + n + '</span></a></li>';
      });
      html += '</ul></div>';
    });
    el.toc.innerHTML = html;

    $$('.part-h', el.toc).forEach(function (b) {
      b.addEventListener('click', function () {
        var part = b.parentNode;
        var open = part.getAttribute('data-open') === '1' ? '0' : '1';
        part.setAttribute('data-open', open);
        b.setAttribute('aria-expanded', open === '1');
      });
    });
  }

  function syncToc(route) {
    $$('#toc a[data-route]').forEach(function (a) {
      var on = a.getAttribute('data-route') === route;
      a.classList.toggle('active', on);
      if (on) {
        var part = a.closest('.part');
        if (part) part.setAttribute('data-open', '1');
      }
    });
  }

  /* ───────── 경로 ───────── */

  function route() {
    var raw = location.hash.replace(/^#/, '');
    var s = raw.charAt(0) === '/' ? raw.slice(1) : raw;
    if (!s) return { type: 'home' };
    var mm = s.match(/^movie\/(\d+)/);
    if (mm) return { type: 'movie', no: parseInt(mm[1], 10) };
    var pm = s.match(/^part\/([\w-]+)/);
    if (pm) return { type: 'part', key: pm[1] };
    var cm = s.match(/^chapter\/([\w-]+)/);
    if (cm) return { type: 'chapter', key: cm[1] };
    if (s === 'explore' || s.indexOf('explore/') === 0) return { type: 'explore' };
    return { type: 'home' };
  }

  function go(hash) { location.hash = hash; }

  /* ───────── 홈: 표지 + 그리드 ───────── */

  function heroHtml() {
    var strips = state.data.parts.map(function (p) { return '<i style="background:' + p.color + '"></i>'; }).join('');
    var legend = state.data.parts.map(function (p) { return '제' + romanToKo(p.roman) + '부 ' + p.title.split(' — ')[0]; }).join(' · ');
    return (
      '<div class="hero">' +
      '<div class="hero-strip">' + strips + '</div>' +
      '<p class="hero-eng">A field guide to world cinema</p>' +
      '<h2>영화도감</h2>' +
      '<p class="sub">한 권으로 보는 세계 영화</p>' +
      '<p class="desc">1895년부터 오늘까지, 영화사의 큰 줄기를 이루는 작품들을 한 편당 한 쪽으로 정리했다. ' +
      '글은 전부 직접 썼고, 포스터는 TMDb에서 실시간으로 불러온다. 시대와 장르, 지역을 가로질러 ' +
      '번호를 따라가거나 왼쪽에서 원하는 장르부터 바로 시작한다.</p>' +
      '<div class="hero-act">' +
      '<a class="hero-btn primary" href="#/movie/1">001번부터 보기</a>' +
      '<button class="hero-btn" id="hero-random" type="button">오늘의 한 편</button>' +
      '</div>' +
      '<p class="hero-legend">' + esc(legend) + '</p>' +
      '</div>'
    );
  }

  var ROMAN_KO = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8', IX: '9', X: '10' };
  function romanToKo(r) { return ROMAN_KO[r] || r; }

  function matchesQuery(m, q) {
    if (!q) return true;
    var hay = [m.title, m.original, m.year, m.country, m.director.join(' '),
               m.cast.join(' '), m.tags.join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function cardHtml(m) {
    var part = partOf(m.part);
    return (
      '<a class="card" data-no="' + m.no + '" href="#/movie/' + m.no + '">' +
      '<div class="card-poster" style="background:linear-gradient(160deg,' + part.color + ',' + part.color + 'cc)">' +
      '<span class="ph-no">' + String(m.no).padStart(3, '0') + '</span>' +
      '</div>' +
      '<div class="card-body" style="border-top-color:' + part.color + '">' +
      '<h4>' + esc(m.title) + '</h4>' +
      '<p class="meta">' + esc(m.year) + ' · ' + esc(m.director.join(', ')) + ' · ' + esc(m.country) + '</p>' +
      '<p class="tagline">' + esc(m.tagline) + '</p>' +
      '<div class="tags">' + m.tags.slice(0, 3).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' +
      '</div>' +
      '</a>'
    );
  }

  /* 화면에 들어온 카드만 그때그때 포스터를 찾는다. 200장을 한꺼번에
     요청하지 않는다. */
  var posterIO = null;
  function wirePosterObserver() {
    if (posterIO) posterIO.disconnect();
    var cards = $$('.card[data-no]', el.doc);
    if (!cards.length) return;
    if (!('IntersectionObserver' in window)) return;
    posterIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        posterIO.unobserve(en.target);
        var no = parseInt(en.target.getAttribute('data-no'), 10);
        var m = state.byNo[no];
        if (!m) return;
        resolvePoster(m).then(function (hit) { applyCardPoster(en.target, hit); });
      });
    }, { root: el.main, rootMargin: '500px 0px', threshold: 0.01 });
    cards.forEach(function (c) { posterIO.observe(c); });
  }

  function applyCardPoster(cardEl, hit) {
    var ph = $('.card-poster', cardEl);
    if (!ph) return;
    if (hit) {
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = hit.type === 'pd' ? pdThumbUrl(hit.file, 185) : TMDB.img + 'w154' + hit.path;
      ph.insertBefore(img, ph.firstChild);
      ph.classList.add('has-img');
    } else {
      ph.classList.add('no-img');
    }
  }

  /* ───────── 탐색(시간축 · 제작국 · 관계망) ───────── */

  function yearNum(m) { return parseInt((m.year.match(/\d{4}/) || [0])[0], 10); }

  function countriesOf(m) { return m.country.split('·').map(function (s) { return s.trim(); }); }

  function inRange(m, range) {
    if (!range) return true;
    var y = yearNum(m);
    return y >= range[0] && y <= range[1];
  }

  /* data.movies 안의 seealso 항목 중 이 책 200편에 걸리는 것만 추려 준다.
     상세 페이지의 "같이 보면 좋은 작품" 매칭과 같은 규칙을 쓴다. */
  function resolveSeealso(m) {
    return m.seealso.map(function (s) {
      return state.data.movies.filter(function (x) { return s.indexOf(x.title) === 0; })[0];
    }).filter(Boolean);
  }

  function buildGraphEdges(movies) {
    var inSet = {};
    movies.forEach(function (m) { inSet[m.no] = true; });
    var seen = {}, edges = [];
    movies.forEach(function (m) {
      resolveSeealso(m).forEach(function (t) {
        if (!inSet[t.no] || t.no === m.no) return;
        var key = m.no < t.no ? m.no + '-' + t.no : t.no + '-' + m.no;
        if (seen[key]) return;
        seen[key] = true;
        edges.push([m.no, t.no]);
      });
    });
    return edges;
  }

  /* 아주 단순한 힘-기반(force-directed) 배치. 외부 그래프 라이브러리를
     쓰지 않고, 반발력(모든 점 사이)과 인력(이어진 점 사이)만으로 자리를
     잡는다. 200개 점 기준으로도 수십 ms 안에 끝난다. */
  function forceLayout(nos, edges, w, h) {
    var pos = {}, n = nos.length;
    nos.forEach(function (no, i) {
      var a = (i / Math.max(n, 1)) * Math.PI * 2;
      pos[no] = { x: w / 2 + Math.cos(a) * w * 0.32, y: h / 2 + Math.sin(a) * h * 0.32, vx: 0, vy: 0 };
    });
    var k = Math.sqrt((w * h) / Math.max(n, 1));
    for (var it = 0; it < 160; it++) {
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var a = pos[nos[i]], b = pos[nos[j]];
          var dx = a.x - b.x, dy = a.y - b.y;
          var d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2);
          var f = (k * k / d2) * 2.2;
          var fx = dx / d * f, fy = dy / d * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      edges.forEach(function (e) {
        var a = pos[e[0]], b = pos[e[1]];
        if (!a || !b) return;
        var dx = b.x - a.x, dy = b.y - a.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var f = (d * d / k) * 0.02;
        var fx = dx / d * f, fy = dy / d * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      });
      nos.forEach(function (no) {
        var p = pos[no];
        p.vx += (w / 2 - p.x) * 0.004;
        p.vy += (h / 2 - p.y) * 0.004;
        p.vx *= 0.85; p.vy *= 0.85;
        p.x += Math.max(-12, Math.min(12, p.vx));
        p.y += Math.max(-12, Math.min(12, p.vy));
        var pad = 26;
        p.x = Math.max(pad, Math.min(w - pad, p.x));
        p.y = Math.max(pad, Math.min(h - pad, p.y));
      });
    }
    return pos;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* 노드(원 + 이름표)와 엣지(선, 호버하면 어느 두 작품을 잇는지 뜨는
     툴팁)를 실제 DOM 요소로 만들어 둔다. 매 애니메이션 프레임마다
     innerHTML을 다시 그리지 않고 좌표 속성만 갱신하기 위해서다. */
  function renderGraphInto(container, movies) {
    container.innerHTML = '';
    if (movies.length < 2) {
      container.innerHTML = '<p class="empty">이 구간에는 이어 볼 작품이 둘 미만이다. 시간축에서 범위를 넓혀 본다.</p>';
      return;
    }
    var nos = movies.map(function (m) { return m.no; });
    var edges = buildGraphEdges(movies);
    var degree = {};
    edges.forEach(function (e) {
      degree[e[0]] = (degree[e[0]] || 0) + 1;
      degree[e[1]] = (degree[e[1]] || 0) + 1;
    });
    var W = 920, H = 560;

    var pos = {};
    nos.forEach(function (no, i) {
      var a = (i / Math.max(nos.length, 1)) * Math.PI * 2;
      pos[no] = { x: W / 2 + Math.cos(a) * W * 0.32, y: H / 2 + Math.sin(a) * H * 0.32, vx: 0, vy: 0 };
    });

    var svg = svgEl('svg', { class: 'graph-svg', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '영화 관계망 그래프' });
    var gEdges = svgEl('g', { class: 'edges' });
    var gNodes = svgEl('g', { class: 'nodes' });

    var lineEls = edges.map(function (e) {
      var l = svgEl('line', { 'data-a': e[0], 'data-b': e[1] });
      var title = svgEl('title');
      title.textContent = titleOf(e[0]) + ' ↔ ' + titleOf(e[1]);
      l.appendChild(title);
      gEdges.appendChild(l);
      return l;
    });

    var nodeEls = movies.map(function (m) {
      var part = partOf(m.part);
      var r = 5 + Math.min(9, (degree[m.no] || 0) * 1.7);
      var g = svgEl('g', { class: 'node', 'data-no': m.no, tabindex: '0' });
      var c = svgEl('circle', { r: r.toFixed(1), fill: part.color });
      var t = svgEl('title'); t.textContent = m.title + ' (' + m.year + ')';
      c.appendChild(t);
      var label = svgEl('text', { class: 'n-label', 'text-anchor': 'middle' });
      label.textContent = m.title.length > 11 ? m.title.slice(0, 11) + '…' : m.title;
      g.appendChild(c); g.appendChild(label);
      gNodes.appendChild(g);
      return { g: g, c: c, label: label, no: m.no, r: r };
    });

    svg.appendChild(gEdges); svg.appendChild(gNodes);
    container.appendChild(svg);
    container.insertAdjacentHTML('beforeend',
      '<p class="graph-cap">점 크기는 "같이 보면 좋은 작품"으로 몇 번 이어졌는지를 뜻한다. ' +
      '이름 위에 올리면 그 작품과 이어진 선이 밝아지고, 선 위에 올리면 어느 두 작품을 잇는지 뜬다. 점을 누르면 그 작품으로 간다.</p>');

    wireGraphEvents(gNodes, lineEls, nodeEls);
    animateForce(pos, nos, edges, lineEls, nodeEls, W, H);
  }

  function titleOf(no) { var m = state.byNo[no]; return m ? m.title : ''; }

  function wireGraphEvents(gNodes, lineEls, nodeEls) {
    nodeEls.forEach(function (ne) {
      ne.g.addEventListener('mouseenter', function () { gNodes.appendChild(ne.g); setGraphHi(ne.no, true, lineEls, nodeEls); });
      ne.g.addEventListener('mouseleave', function () { setGraphHi(ne.no, false, lineEls, nodeEls); });
      ne.g.addEventListener('focus', function () { setGraphHi(ne.no, true, lineEls, nodeEls); });
      ne.g.addEventListener('blur', function () { setGraphHi(ne.no, false, lineEls, nodeEls); });
      ne.g.addEventListener('click', function () { go('#/movie/' + ne.no); });
      ne.g.addEventListener('keydown', function (e) { if (e.key === 'Enter') go('#/movie/' + ne.no); });
    });
  }
  function setGraphHi(no, on, lineEls, nodeEls) {
    var noStr = String(no);
    lineEls.forEach(function (l) {
      if (l.getAttribute('data-a') === noStr || l.getAttribute('data-b') === noStr) l.classList.toggle('hi', on);
    });
    nodeEls.forEach(function (ne) {
      if (String(ne.no) === noStr) ne.g.classList.toggle('hi', on);
    });
  }

  /* 힘-기반 배치를 한 번에 계산해 버리지 않고, 매 프레임 한 번씩 풀어 가며
     그대로 화면에 그린다 — 점들이 눈에 보이게 자리를 잡아 가는 연출. */
  function animateForce(pos, nos, edges, lineEls, nodeEls, w, h) {
    var n = nos.length;
    var k = Math.sqrt((w * h) / Math.max(n, 1));
    var frame = 0, maxFrames = 150;

    function tick() {
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var a = pos[nos[i]], b = pos[nos[j]];
          var dx = a.x - b.x, dy = a.y - b.y;
          var d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2);
          var f = (k * k / d2) * 2.2;
          var fx = dx / d * f, fy = dy / d * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      edges.forEach(function (e) {
        var a = pos[e[0]], b = pos[e[1]];
        if (!a || !b) return;
        var dx = b.x - a.x, dy = b.y - a.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var f = (d * d / k) * 0.02;
        var fx = dx / d * f, fy = dy / d * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      });
      nos.forEach(function (no) {
        var p = pos[no];
        p.vx += (w / 2 - p.x) * 0.004;
        p.vy += (h / 2 - p.y) * 0.004;
        p.vx *= 0.85; p.vy *= 0.85;
        p.x += Math.max(-12, Math.min(12, p.vx));
        p.y += Math.max(-12, Math.min(12, p.vy));
        var pad = 26;
        p.x = Math.max(pad, Math.min(w - pad, p.x));
        p.y = Math.max(pad, Math.min(h - pad, p.y));
      });

      lineEls.forEach(function (l, idx) {
        var e = edges[idx], a = pos[e[0]], b = pos[e[1]];
        l.setAttribute('x1', a.x.toFixed(1)); l.setAttribute('y1', a.y.toFixed(1));
        l.setAttribute('x2', b.x.toFixed(1)); l.setAttribute('y2', b.y.toFixed(1));
      });
      nodeEls.forEach(function (ne) {
        var p = pos[ne.no];
        ne.c.setAttribute('cx', p.x.toFixed(1)); ne.c.setAttribute('cy', p.y.toFixed(1));
        ne.label.setAttribute('x', p.x.toFixed(1));
        ne.label.setAttribute('y', (p.y + ne.r + 11).toFixed(1));
      });

      frame++;
      if (frame < maxFrames) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ───────── 지도 모드 ─────────
     제작국 하나당 좌표 하나(국가 중심 근사치)만 쓴다. 영화 개별 촬영 좌표가
     아니라 "탐색 — 제작국으로 보기"와 같은 국가 단위 데이터를 지도 위에
     옮겨 놓은 것뿐이다. 배경 지도는 위키미디어 커먼즈의 CC0 파일
     (data/world-map.svg)을 그대로 쓰고, 처음 지도 탭을 열 때만 가져온다. */
  var COUNTRY_GEO = {
    '미국': [39.8, -98.6], '영국': [54.0, -2.0], '한국': [36.5, 127.8], '일본': [36.2, 138.3],
    '이탈리아': [42.8, 12.6], '프랑스': [46.6, 2.5], '독일': [51.2, 10.4], '멕시코': [23.6, -102.5],
    '홍콩': [22.3, 114.2], '소련': [55.75, 37.6], '서독': [50.7, 7.1], '중국': [35.9, 104.2],
    '인도': [22.0, 79.0], '뉴질랜드': [-41.5, 173.0], '스페인': [40.0, -4.0], '오스트레일리아': [-25.0, 134.0],
    '벨기에': [50.6, 4.5], '오스트리아': [47.6, 14.1], '스웨덴': [62.0, 15.0], '이란': [32.0, 53.0],
    '브라질': [-10.0, -55.0]
  };
  var MAP_W = 1602.7142, MAP_H = 741.71301;

  function loadWorldMapBg() {
    if (state.worldMapG !== undefined) return Promise.resolve(state.worldMapG);
    return fetch(BASE + 'data/world-map.svg', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (!text) { state.worldMapG = null; return null; }
        var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        var g = doc.querySelector('g');
        var path = g && g.querySelector('path');
        if (path) { path.removeAttribute('style'); }
        state.worldMapG = g ? document.importNode(g, true) : null;
        return state.worldMapG;
      })
      .catch(function () { state.worldMapG = null; return null; });
  }

  function renderMapInto(container, movies) {
    container.innerHTML = '<p class="loading">지도를 읽는 중…</p>';
    var idx = {};
    movies.forEach(function (m) {
      countriesOf(m).forEach(function (c) { if (COUNTRY_GEO[c]) (idx[c] = idx[c] || []).push(m); });
    });

    loadWorldMapBg().then(function (bgG) {
      container.innerHTML = '';
      var svg = svgEl('svg', { class: 'map-svg', viewBox: '0 0 ' + MAP_W + ' ' + MAP_H, role: 'img', 'aria-label': '제작국 세계지도' });
      if (bgG) svg.appendChild(bgG.cloneNode(true));
      var gDots = svgEl('g', { class: 'map-dots' });

      Object.keys(idx).forEach(function (c) {
        var geo = COUNTRY_GEO[c];
        var x = (geo[1] + 180) / 360 * MAP_W;
        var y = (90 - geo[0]) / 180 * MAP_H;
        var n = idx[c].length;
        var r = 7 + Math.min(16, Math.sqrt(n) * 5.5);
        var on = state.explore.region === c;
        var g = svgEl('g', { class: 'map-dot' + (on ? ' on' : ''), 'data-region': c, tabindex: '0' });
        var dot = svgEl('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(1) });
        var t = svgEl('title'); t.textContent = c + ' — ' + n + '편';
        dot.appendChild(t);
        var label = svgEl('text', { class: 'm-label', x: x.toFixed(1), y: (y - r - 6).toFixed(1), 'text-anchor': 'middle' });
        label.textContent = c;
        g.appendChild(dot); g.appendChild(label);
        g.addEventListener('click', function () {
          state.explore.region = state.explore.region === c ? null : c;
          renderExplore();
        });
        g.addEventListener('keydown', function (e) { if (e.key === 'Enter') g.dispatchEvent(new Event('click')); });
        gDots.appendChild(g);
      });

      svg.appendChild(gDots);
      container.appendChild(svg);
      container.insertAdjacentHTML('beforeend',
        '<p class="graph-cap">점은 제작국 하나를 뜻한다(실제 촬영 좌표가 아니다). 점 크기는 그 나라에서 만든 영화 수, 점을 누르면 아래에 그 나라 영화가 나타난다. ' +
        '세계지도: <a href="https://commons.wikimedia.org/wiki/File:Simplified_blank_world_map_without_Antartica_(no_borders).svg" target="_blank" rel="noopener">Crates, Wikimedia Commons(CC0)</a>.</p>');

      var region = state.explore.region;
      if (region && idx[region]) {
        container.insertAdjacentHTML('beforeend', '<div class="grid">' + idx[region].map(cardHtml).join('') + '</div>');
        wirePosterObserver();
      } else {
        container.insertAdjacentHTML('beforeend', '<p class="empty">지도 위 점을 하나 고르면 그 나라에서 만든 영화가 여기 나타난다.</p>');
      }
    });
  }

  function timelineHtml() {
    var movies = state.data.movies;
    var years = movies.map(yearNum);
    var minY = Math.min.apply(null, years), maxY = Math.max.apply(null, years);
    var minDecade = Math.floor(minY / 10) * 10, maxDecade = Math.floor(maxY / 10) * 10;
    var span = (maxY - minY) || 1;
    var range = state.explore.range;

    var dots = movies.map(function (m) {
      var pct = ((yearNum(m) - minY) / span * 100).toFixed(2);
      return '<a class="t-dot" style="left:' + pct + '%" href="#/movie/' + m.no + '" title="' + esc(m.title) + ' (' + esc(m.year) + ')"></a>';
    }).join('');

    var decades = '<button type="button" class="decade' + (!range ? ' on' : '') + '" data-from="" data-to="">전체</button>';
    for (var d = minDecade; d <= maxDecade; d += 10) {
      var on = range && range[0] === d;
      decades += '<button type="button" class="decade' + (on ? ' on' : '') + '" data-from="' + d + '" data-to="' + (d + 9) + '">' + d + '년대</button>';
    }
    return '<div class="timeline"><div class="t-track">' + dots + '</div><div class="t-decades">' + decades + '</div></div>';
  }

  function regionBodyHtml(movies) {
    var idx = {};
    movies.forEach(function (m) {
      countriesOf(m).forEach(function (c) { (idx[c] = idx[c] || []).push(m); });
    });
    var countries = Object.keys(idx).sort(function (a, b) { return idx[b].length - idx[a].length || a.localeCompare(b, 'ko'); });
    var region = state.explore.region;

    var html = '<p class="desc" style="margin:0 0 14px;color:var(--fg-mute);font-size:13px;">제작국(자본·제작사 국적) 기준이다 — 실제 촬영 장소와 다를 수 있다(예: 『아라비아의 로렌스』는 영국 제작이지만 촬영은 요르단·모로코·스페인에서 했다).</p>';
    html += '<div class="region-chips">' + countries.map(function (c) {
      var on = region === c;
      return '<button type="button" class="chip region-chip' + (on ? ' on' : '') + '" style="' + (on ? 'background:var(--accent);border-color:var(--accent);color:var(--on-accent)' : '') + '" data-region="' + esc(c) + '">' +
        esc(c) + '<span class="cnt">' + idx[c].length + '</span></button>';
    }).join('') + '</div>';

    if (region && idx[region]) {
      html += '<div class="grid">' + idx[region].map(cardHtml).join('') + '</div>';
    } else {
      html += '<p class="empty">제작국을 하나 고르면 그 나라에서 만든 영화가 여기 나타난다.</p>';
    }
    return html;
  }

  function wireExplore() {
    $$('.etab', el.doc).forEach(function (b) {
      b.addEventListener('click', function () {
        state.explore.tab = b.getAttribute('data-tab');
        renderExplore();
      });
    });
    $$('.decade', el.doc).forEach(function (b) {
      b.addEventListener('click', function () {
        var f = b.getAttribute('data-from'), t = b.getAttribute('data-to');
        state.explore.range = f === '' ? null : [parseInt(f, 10), parseInt(t, 10)];
        renderExplore();
      });
    });
    $$('.region-chip', el.doc).forEach(function (b) {
      b.addEventListener('click', function () {
        var c = b.getAttribute('data-region');
        state.explore.region = state.explore.region === c ? null : c;
        renderExplore();
      });
    });
  }

  function renderExplore() {
    var ex = state.explore;
    var movies = state.data.movies.filter(function (m) { return inRange(m, ex.range); });

    var html = '<div class="result-head"><div><h3>탐색</h3></div><span class="n">' + movies.length + '편</span></div>';
    html += '<p class="desc" style="margin:-6px 0 20px;color:var(--fg-mute);font-size:13.5px;line-height:1.75;max-width:680px;">' +
      '제작국과 시대, 추천 관계로 영화를 둘러본다. 위 시간축에서 연대를 고르면 아래 결과도 같이 걸러진다.</p>';
    html += timelineHtml();
    html += '<div class="explore-tabs">' +
      '<button type="button" class="etab' + (ex.tab === 'region' ? ' on' : '') + '" data-tab="region">제작국으로 보기</button>' +
      '<button type="button" class="etab' + (ex.tab === 'map' ? ' on' : '') + '" data-tab="map">지도로 보기</button>' +
      '<button type="button" class="etab' + (ex.tab === 'graph' ? ' on' : '') + '" data-tab="graph">관계망 그래프</button>' +
      '</div>';
    html += '<div id="explore-body">' + (ex.tab === 'region' ? regionBodyHtml(movies) : '') + '</div>';

    el.doc.innerHTML = html;
    document.title = '탐색 — 영화도감';

    wireExplore();
    var body = $('#explore-body');
    if (ex.tab === 'region') wirePosterObserver();
    else if (ex.tab === 'map') { body.className = 'map-wrap'; renderMapInto(body, movies); }
    else { body.className = 'graph-wrap'; renderGraphInto(body, movies); }
  }

  function renderHome(r) {
    var movies = state.data.movies;
    var headTitle = '전체';
    var headSub = '';

    if (r.type === 'part') {
      var p = partOf(r.key);
      movies = movies.filter(function (m) { return m.part === r.key; });
      headTitle = '제' + romanToKo(p.roman) + '부 — ' + p.title.split(' — ')[1];
      headSub = p.desc;
    } else if (r.type === 'chapter') {
      var c = chapterOf(r.key);
      movies = movies.filter(function (m) { return m.chapter === r.key; });
      headTitle = c.title;
      headSub = c.lead;
    }

    var q = state.q.trim().toLowerCase();
    if (q) movies = movies.filter(function (m) { return matchesQuery(m, q); });

    var html = r.type === 'home' && !q ? heroHtml() : '';
    html += '<div class="result-head"><div><h3>' + esc(headTitle) + '</h3></div>' +
            '<span class="n">' + movies.length + '편</span></div>';
    if (headSub) html += '<p class="desc" style="margin:-6px 0 20px;color:var(--fg-mute);font-size:13.5px;line-height:1.75;max-width:680px;">' + esc(headSub) + '</p>';

    html += '<div class="filters">';
    html += '<a class="chip' + (r.type === 'home' ? ' on" style="background:var(--accent);color:var(--on-accent);border-color:var(--accent)"' : '"') + ' href="#/">전체</a>';
    state.data.parts.forEach(function (p2) {
      var on = r.type === 'part' && r.key === p2.key;
      html += '<a class="chip' + (on ? ' on' : '') + '" style="' + (on ? 'background:' + p2.color + ';border-color:' + p2.color : '') + '" href="#/part/' + p2.key + '">' + esc(p2.title.split(' — ')[0]) + '</a>';
    });
    html += '</div>';

    if (!movies.length) {
      html += '<p class="empty">찾는 조건에 맞는 작품이 없다. 검색어를 지우거나 다른 부를 골라 본다.</p>';
    } else {
      html += '<div class="grid">' + movies.map(cardHtml).join('') + '</div>';
    }

    el.doc.innerHTML = html;
    wirePosterObserver();

    var rb = $('#hero-random');
    if (rb) rb.addEventListener('click', function () {
      go('#/movie/' + (1 + Math.floor(Math.random() * state.data.movies.length)));
    });

    document.title = (r.type === 'home' ? '영화도감' : headTitle + ' — 영화도감');
  }

  /* ───────── 상세(한 편) ───────── */

  var posterSeq = 0;

  function renderMovie(no) {
    var m = state.byNo[no];
    if (!m) {
      el.doc.innerHTML = '<div class="err"><h2>그런 번호의 작품이 없다</h2>' +
        '<p>001부터 200까지다. <a href="#/">전체 목록으로</a> 돌아간다.</p></div>';
      document.title = '찾지 못함 — 영화도감';
      return;
    }
    var part = partOf(m.part);
    var chapter = chapterOf(m.chapter);
    var mine = ++posterSeq;

    var html = '<div class="detail">';
    html += '<p class="crumb"><a href="#/">전체</a> <span>›</span> ' +
            '<a href="#/part/' + part.key + '">' + esc(part.title.split(' — ')[0]) + '</a> <span>›</span> ' +
            '<a href="#/chapter/' + chapter.key + '">' + esc(chapter.title) + '</a></p>';

    html += '<div class="d-head"><div class="d-top">';
    html += '<div class="d-poster" id="d-poster" style="background:linear-gradient(160deg,' + part.color + ',' + part.color + 'cc)">' +
            '<span class="ph-no">' + String(m.no).padStart(3, '0') + '</span></div>';
    html += '<div class="d-top-info">';
    html += '<p class="crumb no" style="margin:0 0 10px;color:' + part.color + '">NO. ' + String(m.no).padStart(3, '0') + '</p>';
    html += '<h1>' + esc(m.title) + '</h1>';
    if (m.original && m.original !== m.title) html += '<p class="original">' + esc(m.original) + '</p>';
    html += '<div class="meta-line">' +
            '<b>' + esc(m.year) + '</b><span class="sep">·</span>' +
            '<span>' + esc(m.director.join(', ')) + '</span><span class="sep">·</span>' +
            '<span>' + esc(m.country) + '</span><span class="sep">·</span>' +
            '<span>' + esc(m.runtime) + '</span><span class="sep">·</span>' +
            '<span>' + esc(m.format) + '</span></div>';
    html += '<div class="tags">' + m.tags.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>';
    html += '</div></div></div>';

    html += '<p class="tagline">' + m.tagline.replace(/</g, '&lt;') + '</p>';

    html += '<h2>줄거리</h2><div class="synopsis">' + m.synopsis.map(function (p2) { return '<p>' + p2 + '</p>'; }).join('') + '</div>';

    html += '<h2>왜 이 영화인가</h2><p class="why">' + m.why + '</p>';

    html += '<div class="quote-block"><p>&ldquo;' + m.quote + '&rdquo;</p><cite>— ' + esc(m.quotesrc) + '</cite></div>';

    html += '<h2>알아두면 좋을 것</h2><ul class="trivia">' + m.trivia.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>';

    html += '<h2>같이 보면 좋은 작품</h2><div class="seealso">' + m.seealso.map(function (s) {
      var hit = state.data.movies.filter(function (x) { return s.indexOf(x.title) === 0; })[0];
      return hit ? '<a href="#/movie/' + hit.no + '">' + esc(s) + '</a>' : '<span>' + esc(s) + '</span>';
    }).join('') + '</div>';

    if (m.award) html += '<h2>수상·기록</h2><p class="award">' + m.award + '</p>';

    var prev = state.byNo[m.no - 1], next = state.byNo[m.no + 1];
    html += '<nav class="pager">';
    html += prev ? '<a class="pg prev" href="#/movie/' + prev.no + '"><span class="dir">← 이전</span><span class="t">' + esc(prev.title) + '</span></a>' : '<span></span>';
    html += next ? '<a class="pg next" href="#/movie/' + next.no + '"><span class="dir">다음 →</span><span class="t">' + esc(next.title) + '</span></a>' : '<span></span>';
    html += '</nav>';

    html += '</div>';
    el.doc.innerHTML = html;
    document.title = m.title + ' (' + m.year + ') — 영화도감';

    resolvePoster(m).then(function (hit) {
      if (mine !== posterSeq) return;
      var ph = $('#d-poster');
      if (!ph) return;
      if (hit && hit.type === 'pd') {
        ph.innerHTML = '<img src="' + pdThumbUrl(hit.file, 342) + '" alt="' + esc(m.title) + ' 포스터" loading="lazy">' +
          '<a class="d-poster-src" href="' + hit.source + '" target="_blank" rel="noopener">' + hit.label + '</a>';
      } else if (hit && hit.type === 'tmdb') {
        ph.innerHTML = '<img src="' + TMDB.img + 'w342' + hit.path + '" alt="' + esc(m.title) + ' 포스터" loading="lazy">' +
          '<a class="d-poster-src" href="https://www.themoviedb.org/movie/' + hit.id + '" target="_blank" rel="noopener">' + hit.label + '</a>';
      } else {
        ph.innerHTML = '<span class="ph-no">' + String(m.no).padStart(3, '0') + '</span><span class="ph-cap">포스터 없음</span>';
      }
    });
  }

  /* ───────── 렌더 ───────── */

  function render() {
    var r = route();
    el.main.scrollTop = 0;
    closeNav();
    if (r.type === 'movie') {
      syncToc('');
      renderMovie(r.no);
    } else if (r.type === 'explore') {
      syncToc('explore');
      renderExplore();
    } else {
      var rk = r.type === 'home' ? 'home' : r.type + ':' + r.key;
      syncToc(rk);
      renderHome(r);
    }
    updateTotop();
  }

  /* ───────── 서랍/스크롤/검색 ───────── */

  function openNav() { document.body.classList.add('nav-open'); el.scrim.hidden = false; el.menu.setAttribute('aria-expanded', 'true'); }
  function closeNav() { document.body.classList.remove('nav-open'); el.scrim.hidden = true; el.menu.setAttribute('aria-expanded', 'false'); }
  function narrow() { return window.matchMedia('(max-width: 860px)').matches; }

  function updateTotop() { el.totop.hidden = el.main.scrollTop < 400; }

  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); store(LS.theme, t); }

  function onSearch(v) {
    state.q = v;
    el.qClear.hidden = !v;
    el.qClearM.hidden = !v;
    if (route().type === 'movie') {
      if (v.trim()) go('#/');   // 상세 페이지에서 검색을 시작하면 결과를 볼 수 있게 홈으로 옮긴다
      return;
    }
    render();
  }

  function step(d) {
    var r = route();
    if (r.type !== 'movie') return;
    var t = state.byNo[r.no + d];
    if (t) go('#/movie/' + t.no);
  }

  function loadStars() {
    var cached = store(LS.stars);
    var now = Date.now();
    if (cached && cached.n != null && now - cached.at < 3600000) { showStars(cached.n); return; }
    fetch('https://api.github.com/repos/leaf-kit/book-movie')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
      .then(function (d) {
        if (typeof d.stargazers_count !== 'number') return;
        store(LS.stars, { n: d.stargazers_count, at: now });
        showStars(d.stargazers_count);
      })
      .catch(function () { if (cached && cached.n != null) showStars(cached.n); });
  }
  function showStars(n) {
    var e = $('#star-n');
    if (!e) return;
    e.textContent = n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
    e.title = '별 ' + n.toLocaleString('ko-KR') + '개';
    e.hidden = false;
  }

  function wire() {
    window.addEventListener('hashchange', render);

    var tick = null;
    el.main.addEventListener('scroll', function () {
      if (tick) return;
      tick = requestAnimationFrame(function () { tick = null; updateTotop(); });
    }, { passive: true });

    el.totop.addEventListener('click', function () { el.main.scrollTo({ top: 0, behavior: 'smooth' }); });
    el.menu.addEventListener('click', function () { document.body.classList.contains('nav-open') ? closeNav() : openNav(); });
    el.scrim.addEventListener('click', closeNav);
    el.toc.addEventListener('click', function (e) { if (e.target.closest('a') && narrow()) closeNav(); });

    [el.q, el.qm].forEach(function (inp) {
      inp.addEventListener('input', function () {
        [el.q, el.qm].forEach(function (o) { if (o !== inp) o.value = inp.value; });
        onSearch(inp.value);
      });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { inp.value = ''; onSearch(''); inp.blur(); } });
    });
    el.qClear.addEventListener('click', function () { el.q.value = ''; el.qm.value = ''; onSearch(''); el.q.focus(); });
    el.qClearM.addEventListener('click', function () { el.q.value = ''; el.qm.value = ''; onSearch(''); el.qm.focus(); });

    $('#theme').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        var target = narrow() ? el.qm : el.q;
        target.focus(); target.select();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 't' || e.key === 'T' || e.key === 'ㅅ') applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      else if (e.key === 'Escape') closeNav();
    });
  }

  function boot() {
    applyTheme(store(LS.theme) || 'light');
    loadStars();
    wire();
    load().then(function () {
      renderToc();
      render();
    }).catch(function (e) {
      el.toc.innerHTML = '<p class="loading">목록을 읽지 못했다.</p>';
      el.doc.innerHTML = '<div class="err"><h2>data/movies.json 을 읽지 못했다</h2>' +
        '<p>' + esc(e.message) + '</p>' +
        '<p>파일을 직접 여는 대신 로컬 서버로 띄워야 한다. 저장소 안에서 ' +
        '<code>python3 -m http.server 8000</code> 을 돌리고 ' +
        '<code>http://localhost:8000/</code> 로 들어간다.</p></div>';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
