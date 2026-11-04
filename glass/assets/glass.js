/* ============================================================
   我的应用导航 · 毛玻璃视图
   读取 /apps.json，展示真实应用状态；命名空间 fg- / --fg- / fluxglass:*
   ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var STORE = { theme: 'fluxglass:theme' };

  var KIND_LABELS = { web: 'Web', app: 'APP', miniapp: '小程序', tv: '电视', cli: 'CLI' };
  var GIT_MAP = {
    synced: { label: '已同步', cls: 'synced' },
    dirty: { label: '未提交', cls: 'dirty' },
    untracked: { label: '未跟踪', cls: 'warn' },
    ahead: { label: '未推送', cls: 'warn' },
    behind: { label: '未拉取', cls: 'warn' },
    'no-repo': { label: '无仓库', cls: 'muted' },
    'no-upstream': { label: '无上游', cls: 'muted' },
    error: { label: '检查失败', cls: 'dirty' }
  };
  var GIT_SEVERITY = ['dirty', 'untracked', 'ahead', 'behind', 'error', 'no-repo', 'no-upstream'];
  var GIT_ISSUES = GIT_SEVERITY.slice();

  var state = {
    data: null,
    apps: [],
    filter: 'all',
    loading: false,
    firstRender: true,
    donutSig: '',
    loadFailed: false
  };

  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  /* ---------------- 存储 ---------------- */
  function storeGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function storeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  /* ---------------- Toast ---------------- */
  var toastEl = $('#fg-toast');
  var toastTimer = null;
  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2400);
  }

  /* ---------------- 主题 ---------------- */
  var themeBtn = $('#fg-theme');
  var metaTheme = doc.querySelector('meta[name="theme-color"]');
  function currentTheme() { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function applyTheme(theme, announce) {
    root.setAttribute('data-theme', theme);
    if (metaTheme) metaTheme.setAttribute('content', theme === 'dark' ? '#0b0e18' : '#eef0f9');
    if (themeBtn) {
      themeBtn.setAttribute('aria-pressed', String(theme === 'dark'));
      themeBtn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
    }
    storeSet(STORE.theme, theme);
    if (announce) toast(theme === 'dark' ? '已切换到深色毛玻璃主题' : '已切换到浅色毛玻璃主题');
  }
  if (themeBtn) {
    applyTheme(currentTheme(), false);
    themeBtn.addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });
  }

  /* ---------------- 顶栏滚动 ---------------- */
  var topbar = $('#fg-topbar');
  var ticking = false;
  function onScroll() {
    if (topbar) topbar.classList.toggle('is-scrolled', window.scrollY > 8);
    ticking = false;
  }
  window.addEventListener('scroll', function () {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(onScroll);
    }
  }, { passive: true });

  /* ---------------- 入场动画 ---------------- */
  var revealEls = $all('[data-reveal]');
  revealEls.forEach(function (el, i) {
    el.style.transitionDelay = Math.min(i * 45, 180) + 'ms';
  });

  function activateReveal(el) {
    el.classList.add('is-in');
  }

  if ('IntersectionObserver' in window && !reduceMotion.matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          activateReveal(entry.target);
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.05, rootMargin: '0px 0px -2% 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(activateReveal);
  }

  window.addEventListener('beforeprint', function () {
    revealEls.forEach(activateReveal);
  });
  window.setTimeout(function () {
    revealEls.forEach(function (el) {
      if (!el.classList.contains('is-in')) activateReveal(el);
    });
  }, 6000);

  /* ---------------- 数据 ---------------- */
  function isOffline(app) {
    return Boolean(app.appOnly) || !(app.kinds || []).includes('web');
  }

  function statusOf(app) {
    if (isOffline(app)) return { text: '离线应用', cls: 'offline' };
    if (app.status === 'running') return { text: '运行中', cls: 'online' };
    return { text: '未运行', cls: 'down' };
  }

  function envOf(app) {
    return app.remote || app.env === 'public' ? 'public' : 'lan';
  }

  function kindText(app) {
    var kinds = app.kinds && app.kinds.length ? app.kinds : ['web'];
    return kinds.map(function (k) { return KIND_LABELS[k] || k; }).join(' · ');
  }

  function gitInfo(app) {
    if (app.remote || !app.git) return { label: '—', cls: 'none', detail: '' };
    var info = GIT_MAP[app.git.status] || { label: '未知', cls: 'muted' };
    var detail = '';
    if (app.git.status === 'dirty') detail = (app.git.uncommitted || 0) + ' 处修改';
    else if (app.git.status === 'untracked') detail = (app.git.untracked || 0) + ' 个新增文件';
    else if (app.git.status === 'ahead') detail = (app.git.ahead || 0) + ' 个提交未推送';
    else if (app.git.status === 'behind') detail = (app.git.behind || 0) + ' 个提交未拉取';
    else if (info.cls === 'synced') detail = '远端已对齐';
    return { label: info.label, cls: info.cls, detail: detail, status: app.git.status };
  }

  function appHref(app) {
    if (app.remote) return app.url || null;
    if (app.port == null) return null;
    var proto = app.https ? 'https' : 'http';
    var host = window.location.hostname || '127.0.0.1';
    var defaultPort = proto === 'https' ? 443 : 80;
    return proto + '://' + host + (app.port === defaultPort ? '' : ':' + app.port) + '/';
  }

  function accessLabel(app) {
    if (app.remote) {
      try {
        var u = new URL(app.url || app.healthUrl);
        return u.hostname;
      } catch (e) { return '远程'; }
    }
    return app.port == null ? '—' : ':' + app.port;
  }

  function fmtClock(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(new Date(iso));
    } catch (e) { return '—'; }
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    var diff = (Date.now() - new Date(iso).getTime()) / 60000;
    if (diff < 1) return '刚刚';
    if (diff < 60) return Math.round(diff) + ' 分钟前';
    if (diff < 1440) return Math.round(diff / 60) + ' 小时前';
    return Math.round(diff / 1440) + ' 天前';
  }

  function computeStats() {
    var apps = state.apps;
    var total = apps.length;
    var running = apps.filter(function (a) { return a.status === 'running'; }).length;
    var down = total - running;
    var lan = apps.filter(function (a) { return envOf(a) === 'lan'; }).length;
    var pub = apps.filter(function (a) { return envOf(a) === 'public'; }).length;
    var offline = apps.filter(isOffline).length;
    var git = apps.filter(function (a) {
      return a.git && GIT_ISSUES.indexOf(a.git.status) !== -1;
    }).length;
    var synced = apps.filter(function (a) { return a.git && a.git.status === 'synced'; }).length;
    var noGit = apps.filter(function (a) { return !a.git; }).length;
    var pct = total ? Math.round((running / total) * 100) : 0;
    return { total: total, running: running, down: down, lan: lan, pub: pub, offline: offline, git: git, synced: synced, noGit: noGit, pct: pct };
  }

  /* ---------------- 数字动画 ---------------- */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function animateNumber(el, target, suffix) {
    if (!el) return;
    suffix = suffix || '';
    if (reduceMotion.matches || state.firstRender === false) {
      el.textContent = target + suffix;
      return;
    }
    var t0 = performance.now();
    var duration = 1000;
    function frame(now) {
      var p = clamp((now - t0) / duration, 0, 1);
      el.textContent = Math.round(target * easeOutCubic(p)) + suffix;
      if (p < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  /* ---------------- 渲染：页面信息与统计 ---------------- */
  function render() {
    var data = state.data || {};
    var page = data.page || {};
    var stats = computeStats();

    var siteName = page.siteName || '我的应用导航';
    var heroTitle = page.heroTitle || '我的应用';
    doc.title = siteName + ' · 毛玻璃视图';
    var brand = $('#fg-brand-name');
    if (brand) brand.textContent = siteName;
    var h1 = $('#fg-hero-title');
    if (h1) h1.textContent = heroTitle;

    var metaRunning = $('#fg-meta-running');
    if (metaRunning) metaRunning.textContent = stats.down > 0
      ? stats.running + ' 个运行中 · ' + stats.down + ' 个未运行'
      : stats.running + ' 个应用运行中';
    var metaPublic = $('#fg-meta-public');
    if (metaPublic) metaPublic.textContent = stats.pub + ' 个公网应用';
    updateProbeLabels();

    var liveDot = $('#fg-live-dot');
    if (liveDot) liveDot.classList.toggle('is-warn', stats.down > 0);

    setCount('#fg-count-all', stats.total);
    setCount('#fg-count-running', stats.running);
    setCount('#fg-count-lan', stats.lan);
    setCount('#fg-count-public', stats.pub);

    var progress = $('#fg-progress');
    if (progress) progress.setAttribute('aria-valuenow', String(stats.pct));
    var fill = $('#fg-progress-fill');
    if (fill) fill.style.width = stats.pct + '%';
    var num = $('#fg-progress-num');
    if (num) num.textContent = stats.pct + '%';

    setCount('#fg-ov-running', stats.running);
    setCount('#fg-ov-down', stats.down);
    setCount('#fg-ov-git', stats.git);
    setCount('#fg-ov-public', stats.pub);

    setStat('total', stats.total, false);
    setStat('running', stats.running, false);
    setStat('lan', stats.lan, false);
    setStat('git', stats.git, false);

    var chip = 'data-stat-chip';
    setText('[' + chip + '="running"]', stats.pct + '%');
    setText('[' + chip + '="lan"]', stats.pub + ' 公网');
    setText('[' + chip + '="git"]', stats.git ? '待处理' : '全部同步');
    var gitChip = $('[' + chip + '="git"]');
    if (gitChip) {
      gitChip.classList.toggle('fg-delta--warn', stats.git > 0);
      gitChip.classList.toggle('fg-delta--up', stats.git === 0);
    }

    renderDonut(stats);
    renderLegend(stats);
    renderBars();
    renderAppList();
    renderSync(stats);

    state.firstRender = false;
  }

  function setCount(sel, value) {
    var el = $(sel);
    if (el) el.textContent = String(value);
  }

  function setText(sel, value) {
    var el = $(sel);
    if (el) el.textContent = value;
  }

  function setStat(key, value, animate) {
    var el = $('[data-stat="' + key + '"]');
    if (!el) return;
    if (animate) animateNumber(el, value);
    else el.textContent = String(value);
  }

  function updateProbeLabels() {
    var iso = state.data && state.data.probedAt;
    var clock = fmtClock(iso);
    var rel = fmtRelative(iso);
    var meta = $('#fg-meta-probe');
    if (meta) meta.textContent = '探测于 ' + clock + (rel ? ' · ' + rel : '');
    var ov = $('#fg-ov-probe');
    if (ov) ov.textContent = '最后探测 ' + clock;
    var sp = $('#fg-sync-probe');
    if (sp) sp.textContent = '探测于 ' + clock;
  }

  /* ---------------- 分布圆环 ---------------- */
  function renderDonut(stats) {
    var donut = $('#fg-donut');
    if (!donut) return;
    var segments = [
      { label: '本机 Web', count: stats.lan - stats.offline, from: '#8ab4ff', to: '#3763f2', dot: 'blue', text: '本机 Web' },
      { label: '离线应用', count: stats.offline, from: '#c3a8ff', to: '#8b6cf0', dot: 'lilac', text: '离线应用' },
      { label: '云服务器', count: stats.pub, from: '#ffc061', to: '#ff9430', dot: 'orange', text: '云服务器' }
    ];
    var total = stats.total || 1;
    var sig = segments.map(function (s) { return s.count; }).join('-') + '|' + stats.running;
    donut.setAttribute('aria-label', '应用在线率 ' + stats.pct + '%，本机 Web ' + segments[0].count + ' 个、离线应用 ' + stats.offline + ' 个、云服务器 ' + stats.pub + ' 个');

    if (sig === state.donutSig) return;
    state.donutSig = sig;

    var NS = 'http://www.w3.org/2000/svg';
    var size = 212;
    var c = size / 2;
    var r = 88;
    var circ = 2 * Math.PI * r;
    var gap = 15;
    var cursor = 120;
    var visible = segments.filter(function (s) { return s.count > 0; });
    var sum = visible.reduce(function (n, s) { return n + s.count; }, 0) || 1;

    donut.innerHTML = '';
    donut.classList.remove('is-ready');
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);

    var defs = doc.createElementNS(NS, 'defs');
    visible.forEach(function (seg, i) {
      var grad = doc.createElementNS(NS, 'linearGradient');
      grad.setAttribute('id', 'fg-donut-g' + i);
      grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
      grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '100%');
      var s1 = doc.createElementNS(NS, 'stop');
      s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', seg.from);
      var s2 = doc.createElementNS(NS, 'stop');
      s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', seg.to);
      grad.appendChild(s1); grad.appendChild(s2);
      defs.appendChild(grad);
    });
    svg.appendChild(defs);

    visible.forEach(function (seg, i) {
      var angle = seg.count / sum * 360;
      var len = Math.max(angle / 360 * circ - gap, 4);
      var arc = doc.createElementNS(NS, 'circle');
      arc.setAttribute('class', 'fg-donut__arc');
      arc.setAttribute('cx', c); arc.setAttribute('cy', c); arc.setAttribute('r', r);
      arc.setAttribute('fill', 'none');
      arc.setAttribute('stroke', 'url(#fg-donut-g' + i + ')');
      arc.setAttribute('stroke-width', '11');
      arc.setAttribute('stroke-linecap', 'round');
      arc.setAttribute('stroke-dasharray', len + ' ' + circ);
      arc.setAttribute('transform', 'rotate(' + cursor + ' ' + c + ' ' + c + ')');
      arc.style.filter = 'drop-shadow(0 4px 10px rgba(59,107,255,0.18))';
      arc.style.transitionDelay = (0.05 + i * 0.11) + 's';
      svg.appendChild(arc);
      cursor += angle;
    });
    donut.appendChild(svg);

    var center = doc.createElement('div');
    center.className = 'fg-donut__center';
    center.innerHTML =
      '<span class="fg-donut__label">在线率</span>' +
      '<span class="fg-donut__value">' + stats.pct + '%</span>' +
      '<span class="fg-donut__hint">' + stats.running + ' / ' + stats.total + ' 运行中</span>';
    donut.appendChild(center);

    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { donut.classList.add('is-ready'); });
    });
  }

  function renderLegend(stats) {
    var legend = $('#fg-legend');
    if (!legend) return;
    var rows = [
      { dot: 'blue', label: '本机 Web', count: Math.max(stats.lan - stats.offline, 0) },
      { dot: 'lilac', label: '离线应用', count: stats.offline },
      { dot: 'orange', label: '云服务器', count: stats.pub }
    ];
    legend.innerHTML = '';
    rows.forEach(function (row) {
      var div = doc.createElement('div');
      div.className = 'fg-legend__row';
      var name = doc.createElement('span');
      name.className = 'fg-legend__name';
      var dot = doc.createElement('i');
      dot.className = 'fg-legend__dot fg-legend__dot--' + row.dot;
      name.appendChild(dot);
      name.appendChild(doc.createTextNode(row.label));
      var count = doc.createElement('span');
      count.className = 'fg-legend__count';
      count.textContent = row.count + ' 个';
      div.appendChild(name);
      div.appendChild(count);
      legend.appendChild(div);
    });
  }

  /* ---------------- 应用状态柱 ---------------- */
  function barColor(type, app) {
    if (type === 'env') {
      return envOf(app) === 'public'
        ? 'linear-gradient(180deg,#ffc061,#ff9430)'
        : 'linear-gradient(180deg,#8ab4ff,#4670f2)';
    }
    if (type === 'status') {
      if (isOffline(app)) return 'linear-gradient(180deg,#b9bdc9,#8f94a3)';
      return app.status === 'running'
        ? 'linear-gradient(180deg,#5ff0b4,#12a565)'
        : 'linear-gradient(180deg,#ff9aa2,#e8434f)';
    }
    if (type === 'kind') {
      if (app.remote) return 'linear-gradient(180deg,#ffc061,#ff9430)';
      if (isOffline(app)) return 'linear-gradient(180deg,#c3a8ff,#8b6cf0)';
      if ((app.kinds || []).includes('tv')) return 'linear-gradient(180deg,#d2b6ff,#9b6cf0)';
      return 'linear-gradient(180deg,#8ab4ff,#4670f2)';
    }
    // git
    var g = gitInfo(app);
    if (g.cls === 'synced') return 'linear-gradient(180deg,#5ff0b4,#12a565)';
    if (g.cls === 'dirty') return 'linear-gradient(180deg,#ff9aa2,#e8434f)';
    if (g.cls === 'warn') return 'linear-gradient(180deg,#ffd97a,#f0ad2f)';
    return 'linear-gradient(180deg,#c9ccd6,#9ba0ad)';
  }

  function barTitle(type, app) {
    var status = statusOf(app).text;
    if (type === 'env') return app.name + ' · ' + (envOf(app) === 'public' ? '公网' : '内网');
    if (type === 'status') return app.name + ' · ' + status;
    if (type === 'kind') return app.name + ' · ' + kindText(app);
    return app.name + ' · 源码 ' + gitInfo(app).label;
  }

  function renderBars() {
    $all('[data-bars]').forEach(function (host) {
      var type = host.getAttribute('data-bars');
      host.innerHTML = '';
      state.apps.forEach(function (app) {
        var bar = doc.createElement('i');
        bar.style.background = barColor(type, app);
        bar.title = barTitle(type, app);
        host.appendChild(bar);
      });
    });
  }

  /* ---------------- 应用清单 ---------------- */
  function filterApps() {
    var apps = state.apps;
    if (state.filter === 'running') return apps.filter(function (a) { return a.status === 'running'; });
    if (state.filter === 'lan') return apps.filter(function (a) { return envOf(a) === 'lan'; });
    if (state.filter === 'public') return apps.filter(function (a) { return envOf(a) === 'public'; });
    return apps.filter(function (a) { return true; });
  }

  function filterLabel() {
    return { all: '全部应用', running: '运行中应用', lan: '内网应用', public: '公网应用' }[state.filter] || '全部应用';
  }

  function renderAppList() {
    var body = $('#fg-app-list-body');
    var sub = $('#fg-list-sub');
    if (!body) return;
    var apps = filterApps();

    if (sub) sub.textContent = filterLabel() + ' · ' + apps.length + ' 个';
    var foot = $('#fg-list-foot');
    if (foot) foot.textContent = apps.length > 6
      ? '共 ' + apps.length + ' 个 · 滚动列表查看全部'
      : '共 ' + apps.length + ' 个应用';
    body.innerHTML = '';

    if (!apps.length) {
      body.appendChild(emptyRow(state.loadFailed ? '无法读取应用数据' : '该筛选条件下暂无应用'));
      return;
    }

    apps.forEach(function (app) {
      var status = statusOf(app);
      var git = gitInfo(app);
      var href = status.cls === 'offline' ? null : appHref(app);
      var row;
      if (href) {
        row = doc.createElement('a');
        row.href = href;
        row.target = '_blank';
        row.rel = 'noopener';
      } else {
        row = doc.createElement('div');
        row.setAttribute('aria-disabled', 'true');
      }
      row.className = 'fg-approw' + (status.cls !== 'online' ? ' is-down' : '');
      row.title = app.description || app.name;

      var main = doc.createElement('span');
      main.className = 'fg-approw__main';
      var icon = doc.createElement('span');
      icon.className = 'fg-approw__icon';
      icon.textContent = app.icon || '▣';
      var copy = doc.createElement('span');
      copy.className = 'fg-approw__copy';
      var name = doc.createElement('strong');
      name.className = 'fg-approw__name';
      name.textContent = app.name;
      var meta = doc.createElement('small');
      meta.className = 'fg-approw__meta';
      meta.textContent = kindText(app) + ' · ' + (envOf(app) === 'public' ? '公网' : '内网');
      copy.appendChild(name);
      copy.appendChild(meta);
      main.appendChild(icon);
      main.appendChild(copy);

      var statusCell = doc.createElement('span');
      var badge = doc.createElement('span');
      badge.className = 'fg-badge fg-badge--' + status.cls;
      badge.textContent = status.text;
      statusCell.appendChild(badge);

      var url = doc.createElement('span');
      url.className = 'fg-approw__url';
      url.textContent = accessLabel(app);

      var gitCell = doc.createElement('span');
      var chip = doc.createElement('span');
      chip.className = 'fg-gitchip fg-gitchip--' + git.cls;
      chip.textContent = git.label;
      gitCell.appendChild(chip);

      row.appendChild(main);
      row.appendChild(statusCell);
      row.appendChild(url);
      row.appendChild(gitCell);
      body.appendChild(row);
    });
  }

  function emptyRow(text) {
    var div = doc.createElement('div');
    div.className = 'fg-empty';
    div.textContent = text;
    return div;
  }

  /* ---------------- 源码同步 ---------------- */
  function issueApps() {
    return state.apps
      .filter(function (a) { return a.git && GIT_ISSUES.indexOf(a.git.status) !== -1; })
      .sort(function (a, b) {
        return GIT_SEVERITY.indexOf(a.git.status) - GIT_SEVERITY.indexOf(b.git.status);
      });
  }

  function renderSync(stats) {
    var badge = $('#fg-sync-count');
    var meta = $('#fg-syncmeta');
    var bar = $('#fg-syncbar');
    var list = $('#fg-sync-list');
    if (!list) return;

    var issues = issueApps();
    var total = stats.total || 1;
    if (badge) {
      badge.textContent = issues.length ? issues.length + ' 项待处理' : '全部同步';
      badge.className = 'fg-badge ' + (issues.length ? 'fg-badge--draft' : 'fg-badge--online');
    }

    if (bar) {
      bar.innerHTML = '';
      [
        { n: stats.synced, color: 'linear-gradient(90deg,#33cf88,#17b26a)' },
        { n: issues.length, color: 'linear-gradient(90deg,#ffd97a,#f0ad2f)' },
        { n: stats.noGit, color: 'linear-gradient(90deg,#c9ccd6,#9ba0ad)' }
      ].forEach(function (seg) {
        if (!seg.n) return;
        var span = doc.createElement('span');
        span.style.width = (seg.n / total * 100) + '%';
        span.style.background = seg.color;
        bar.appendChild(span);
      });
    }

    if (meta) {
      meta.textContent = '已同步 ' + stats.synced + ' · 待处理 ' + issues.length + ' · 无 Git ' + stats.noGit;
    }

    list.innerHTML = '';
    if (!issues.length) {
      list.appendChild(emptyRow('全部仓库已同步，无需处理'));
      return;
    }
    issues.forEach(function (app) {
      var git = gitInfo(app);
      var row = doc.createElement('div');
      row.className = 'fg-syncrow';

      var main = doc.createElement('span');
      main.className = 'fg-syncrow__main';
      var dot = doc.createElement('i');
      dot.className = 'fg-syncrow__dot fg-syncrow__dot--' + git.cls;
      var copy = doc.createElement('span');
      var name = doc.createElement('strong');
      name.className = 'fg-syncrow__name';
      name.textContent = app.name;
      var detail = doc.createElement('small');
      detail.className = 'fg-syncrow__detail';
      detail.textContent = git.detail || '需要处理';
      copy.appendChild(name);
      copy.appendChild(detail);
      main.appendChild(dot);
      main.appendChild(copy);

      var chip = doc.createElement('span');
      chip.className = 'fg-gitchip fg-gitchip--' + git.cls;
      chip.textContent = git.label;

      row.appendChild(main);
      row.appendChild(chip);
      list.appendChild(row);
    });
  }

  /* ---------------- 搜索 ---------------- */
  var search = $('#fg-search');
  var searchBtn = $('#fg-search-btn');
  var searchInput = $('#fg-search-input');
  var searchList = $('#fg-search-list');
  var lastFocus = null;
  var activeIndex = 0;
  var searchItems = [];

  function buildSearchItems() {
    var items = state.apps.map(function (app) {
      var status = statusOf(app);
      var statusText = status.text;
      var envText = envOf(app) === 'public' ? '公网' : '内网';
      return {
        icon: 'grid',
        name: app.name,
        desc: statusText + ' · ' + envText + ' · ' + accessLabel(app) + ' · ' + kindText(app),
        app: app,
        keywords: [app.name, app.description, app.port, app.tags, app.languages, app.frontend, app.backend].flat().filter(Boolean).join(' ')
      };
    });
    items.push({
      icon: 'refresh',
      name: '刷新应用数据',
      desc: '重新读取 /apps.json',
      action: 'refresh',
      keywords: '刷新 同步 数据 probe'
    });
    items.push({
      icon: 'home',
      name: '打开原版主站',
      desc: '返回我的应用导航',
      action: 'home',
      keywords: '主站 主页 返回'
    });
    searchItems = items;
  }

  function renderSearch(keyword) {
    if (!searchList) return;
    var q = (keyword || '').trim().toLowerCase();
    var items = searchItems.filter(function (item) {
      return !q || (item.name + ' ' + item.desc + ' ' + (item.keywords || '')).toLowerCase().indexOf(q) !== -1;
    });
    searchList.innerHTML = '';
    activeIndex = 0;

    if (!items.length) {
      var empty = doc.createElement('li');
      empty.className = 'fg-search__empty';
      empty.textContent = '没有找到匹配的应用';
      searchList.appendChild(empty);
      return;
    }

    items.forEach(function (item, i) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'fg-search__item' + (i === 0 ? ' is-active' : '');
      btn.setAttribute('data-index', String(i));

      var icon = doc.createElement('span');
      icon.className = 'fg-search__icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" class="fg-i"><use href="#fg-i-' + item.icon + '"></use></svg>';

      var copy = doc.createElement('span');
      copy.className = 'fg-search__copy';
      var name = doc.createElement('span');
      name.className = 'fg-search__name';
      name.textContent = item.name;
      var desc = doc.createElement('span');
      desc.className = 'fg-search__desc';
      desc.textContent = item.desc;
      copy.appendChild(name);
      copy.appendChild(desc);

      btn.appendChild(icon);
      btn.appendChild(copy);
      btn.addEventListener('click', function () { runSearchItem(item); });
      searchList.appendChild(btn);
    });
  }

  function setActive(idx) {
    var items = $all('.fg-search__item', searchList);
    if (!items.length) return;
    activeIndex = (idx + items.length) % items.length;
    items.forEach(function (el, i) { el.classList.toggle('is-active', i === activeIndex); });
    items[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function runSearchItem(item) {
    closeSearch();
    if (!item) return;
    if (item.action === 'home') {
      window.location.href = '/';
      return;
    }
    if (item.action === 'refresh') {
      loadData({ manual: true });
      return;
    }
    if (item.app) {
      var href = appHref(item.app);
      if (!href || item.app.status !== 'running') {
        toast('「' + item.app.name + '」当前未运行');
        return;
      }
      window.open(href, '_blank', 'noopener');
    }
  }

  function openSearch() {
    if (!search) return;
    buildSearchItems();
    lastFocus = doc.activeElement;
    search.hidden = false;
    doc.body.style.overflow = 'hidden';
    if (searchInput) {
      searchInput.value = '';
      renderSearch('');
      window.setTimeout(function () { searchInput.focus(); }, 60);
    }
  }

  function closeSearch() {
    if (!search || search.hidden) return;
    search.hidden = true;
    doc.body.style.overflow = '';
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  if (searchBtn) searchBtn.addEventListener('click', openSearch);
  if (search) {
    $all('[data-fg-close]', search).forEach(function (el) {
      el.addEventListener('click', closeSearch);
    });
  }
  if (searchInput) {
    searchInput.addEventListener('input', function () { renderSearch(searchInput.value); });
    searchInput.addEventListener('keydown', function (e) {
      var items = $all('.fg-search__item', searchList);
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[activeIndex]) items[activeIndex].click();
      }
    });
  }

  doc.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (search && search.hidden) openSearch();
      else closeSearch();
    }
    if (e.key === 'Escape' && search && !search.hidden) closeSearch();
    if (e.key === 'Tab' && search && !search.hidden) {
      var focusables = $all('button, input, [href]', search);
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------------- 筛选 ---------------- */
  $all('[data-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.filter = btn.getAttribute('data-filter');
      $all('[data-filter]').forEach(function (b) {
        var active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      renderAppList();
    });
  });

  /* ---------------- 刷新数据 ---------------- */
  function setLoading(loading) {
    state.loading = loading;
    var btn = $('#fg-refresh');
    if (btn) btn.classList.toggle('is-spinning', loading);
  }

  function loadData(options) {
    options = options || {};
    if (state.loading) return;
    setLoading(true);
    fetch('../apps.json?_=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        state.data = data;
        state.apps = Array.isArray(data.apps) ? data.apps : [];
        state.loadFailed = false;
        state.donutSig = '';
        render();
        if (options.manual) toast('应用数据已刷新');
      })
      .catch(function (err) {
        state.loadFailed = true;
        if (!state.data) {
          var meta = $('#fg-meta-running');
          if (meta) meta.textContent = '无法读取 /apps.json';
          var sub = $('#fg-list-sub');
          if (sub) sub.textContent = '数据读取失败';
          var body = $('#fg-app-list-body');
          if (body) {
            body.innerHTML = '';
            body.appendChild(emptyRow('无法读取应用数据，请确认通过 /glass/ 访问'));
          }
        }
        toast('读取应用数据失败：' + err.message);
      })
      .finally(function () { setLoading(false); });
  }

  $all('[data-fg-refresh]').forEach(function (btn) {
    btn.addEventListener('click', function () { loadData({ manual: true }); });
  });

  /* ---------------- 自动刷新 ---------------- */
  window.setInterval(function () { loadData({ silent: true }); }, 60000);
  window.setInterval(updateProbeLabels, 30000);
  doc.addEventListener('visibilitychange', function () {
    if (!doc.hidden) loadData({ silent: true });
  });

  /* ---------------- 启动 ---------------- */
  onScroll();
  loadData({ silent: true });
})();
