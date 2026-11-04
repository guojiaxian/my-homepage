/* ============================================================
   Flux Glass — 交互脚本
   独立命名空间，仅操作 .fg-* 元素与 fluxglass:* 存储键
   ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var STORE = { theme: 'fluxglass:theme', checklist: 'fluxglass:checklist' };

  function storeGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch (e) {}
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function $(sel, ctx) {
    return (ctx || doc).querySelector(sel);
  }

  function $all(sel, ctx) {
    return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel));
  }

  /* ---------------- Toast ---------------- */
  var toastEl = $('#fg-toast');
  var toastTimer = null;

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-on');
    }, 2200);
  }

  doc.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-fg-toast]');
    if (trigger) toast(trigger.getAttribute('data-fg-toast'));
  });

  /* ---------------- 主题 ---------------- */
  var themeBtn = $('#fg-theme');
  var metaTheme = doc.querySelector('meta[name="theme-color"]');

  function currentTheme() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

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

  /* ---------------- 语言切换（演示态） ---------------- */
  var langBtn = $('#fg-lang');
  var langLabel = $('#fg-lang-label');
  if (langBtn) {
    langBtn.addEventListener('click', function () {
      var next = langLabel.textContent === '英文' ? '中文' : '英文';
      langLabel.textContent = next;
      langBtn.setAttribute('aria-pressed', String(next === '中文'));
      toast('界面语言偏好已切换为' + next);
    });
  }

  /* ---------------- 顶栏滚动阴影 ---------------- */
  var topbar = $('#fg-topbar');
  var scrollTicking = false;
  function onScroll() {
    if (!topbar) return;
    topbar.classList.toggle('is-scrolled', window.scrollY > 8);
    scrollTicking = false;
  }
  window.addEventListener('scroll', function () {
    if (!scrollTicking) {
      scrollTicking = true;
      window.requestAnimationFrame(onScroll);
    }
  }, { passive: true });

  /* ---------------- 入场与计数 ---------------- */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function formatNumber(value, decimals, format) {
    var n = decimals > 0 ? Number(value.toFixed(decimals)) : Math.round(value);
    if (format === 'group') {
      return n.toLocaleString('zh-CN');
    }
    return decimals > 0 ? n.toFixed(decimals) : String(n);
  }

  function animateCounter(el) {
    if (el.dataset.done === '1') return;
    el.dataset.done = '1';
    var target = parseFloat(el.getAttribute('data-count-to') || '0');
    var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var format = el.getAttribute('data-format') || '';
    var suffix = el.getAttribute('data-suffix') || '';
    var prefix = el.getAttribute('data-prefix') || '';

    if (reduceMotion.matches) {
      el.textContent = prefix + formatNumber(target, decimals, format) + suffix;
      return;
    }

    var start = 0;
    var duration = 1150;
    var t0 = performance.now();

    function frame(now) {
      var p = clamp((now - t0) / duration, 0, 1);
      var v = target * easeOutCubic(p);
      el.textContent = prefix + formatNumber(v, decimals, format) + suffix;
      if (p < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  var revealEls = $all('[data-reveal]');
  revealEls.forEach(function (el, i) {
    el.style.transitionDelay = Math.min(i * 45, 180) + 'ms';
  });

  function activateReveal(el) {
    el.classList.add('is-in');
    $all('[data-count-to]', el).forEach(animateCounter);
    if (el.classList.contains('fg-card--trend') && drawTrendOnce) drawTrendOnce();
    if (el.classList.contains('fg-card--gauge') && revealDonut) revealDonut();
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

  // 兜底：打印或滚动异常时也保证内容完整可见
  window.addEventListener('beforeprint', function () {
    revealEls.forEach(activateReveal);
  });
  window.setTimeout(function () {
    revealEls.forEach(function (el) {
      if (!el.classList.contains('is-in')) activateReveal(el);
    });
  }, 6000);

  /* ---------------- 入门指南 ---------------- */
  var checklist = $('#fg-checklist');
  var progressFill = $('#fg-progress-fill');
  var progressNum = $('#fg-progress-num');
  var progressBar = $('#fg-progress');
  var guideCount = $('#fg-guide-count');
  var guideNext = $('#fg-guide-next');
  var savedChecks = storeGet(STORE.checklist, {});

  function updateProgress() {
    if (!checklist) return;
    var checks = $all('.fg-check', checklist);
    var pct = 0;
    var done = 0;
    checks.forEach(function (btn) {
      var checked = btn.getAttribute('aria-checked') === 'true';
      if (checked) {
        done += 1;
        pct += parseFloat(btn.getAttribute('data-weight') || '0');
      }
    });
    pct = clamp(pct, 0, 100);
    if (progressFill) progressFill.style.width = pct + '%';
    if (progressNum) progressNum.textContent = Math.round(pct) + '%';
    if (progressBar) progressBar.setAttribute('aria-valuenow', String(Math.round(pct)));
    if (guideCount) guideCount.textContent = '已完成 ' + done + ' / ' + checks.length + ' 项';
    return { pct: pct, done: done, total: checks.length };
  }

  if (checklist) {
    var checks = $all('.fg-check', checklist);
    checks.forEach(function (btn) {
      var id = btn.getAttribute('data-id');
      if (savedChecks && Object.prototype.hasOwnProperty.call(savedChecks, id)) {
        btn.setAttribute('aria-checked', String(Boolean(savedChecks[id])));
      }
      btn.addEventListener('click', function () {
        var next = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', String(next));
        savedChecks[id] = next;
        storeSet(STORE.checklist, savedChecks);
        updateProgress();
        toast(next ? '步骤已完成，进度已更新' : '已取消该步骤');
      });
    });
    updateProgress();

    if (guideNext) {
      guideNext.addEventListener('click', function () {
        var target = $all('.fg-check', checklist).find(function (btn) {
          return btn.getAttribute('aria-checked') !== 'true';
        });
        if (!target) {
          toast('全部步骤已完成，做得很好');
          return;
        }
        target.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
        target.classList.add('is-flash');
        setTimeout(function () { target.classList.remove('is-flash'); }, 1400);
        target.focus({ preventScroll: true });
      });
    }
  }

  /* ---------------- Sparklines ---------------- */
  function seeded(seed) {
    var s = seed;
    return function () {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }

  function buildSparkline(container, index) {
    var rnd = seeded(101 + index * 37);
    var count = 42;
    var frag = doc.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      var wave = 0.5 + 0.34 * Math.sin(i / 6 + index) + 0.18 * Math.sin(i / 2.3 + index * 2);
      var h = clamp(Math.round((wave * 0.5 + rnd() * 0.62) * 100), 12, 100);
      var bar = doc.createElement('i');
      bar.style.setProperty('--h', String(h));
      bar.style.setProperty('--i', String(i));
      bar.style.opacity = String(0.55 + rnd() * 0.45);
      frag.appendChild(bar);
    }
    container.appendChild(frag);
  }

  $all('.fg-spark').forEach(function (el, i) { buildSparkline(el, i); });

  /* ---------------- 圆环 ---------------- */
  var donut = $('#fg-donut');
  var donutReadyTimer = null;

  function buildDonut() {
    if (!donut) return null;
    var size = 212;
    var c = size / 2;
    var r = 88;
    var circ = 2 * Math.PI * r;
    var gap = 15;
    var segments = [
      { pct: 40, from: '#ffc061', to: '#ff9430', glow: 'rgba(255,154,60,.45)' },
      { pct: 34, from: '#5ff0b4', to: '#12a565', glow: 'rgba(23,178,106,.45)' },
      { pct: 26, from: '#8ab4ff', to: '#3763f2', glow: 'rgba(59,107,255,.45)' }
    ];

    var NS = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);

    var defs = doc.createElementNS(NS, 'defs');
    segments.forEach(function (seg, i) {
      var grad = doc.createElementNS(NS, 'linearGradient');
      grad.setAttribute('id', 'fg-donut-g' + i);
      grad.setAttribute('x1', '0%');
      grad.setAttribute('y1', '0%');
      grad.setAttribute('x2', '100%');
      grad.setAttribute('y2', '100%');
      var s1 = doc.createElementNS(NS, 'stop');
      s1.setAttribute('offset', '0%');
      s1.setAttribute('stop-color', seg.from);
      var s2 = doc.createElementNS(NS, 'stop');
      s2.setAttribute('offset', '100%');
      s2.setAttribute('stop-color', seg.to);
      grad.appendChild(s1);
      grad.appendChild(s2);
      defs.appendChild(grad);
    });
    svg.appendChild(defs);

    var cursor = 120;
    segments.forEach(function (seg, i) {
      var len = Math.max(seg.pct / 100 * circ - gap, 4);
      var arc = doc.createElementNS(NS, 'circle');
      arc.setAttribute('class', 'fg-donut__arc');
      arc.setAttribute('cx', c);
      arc.setAttribute('cy', c);
      arc.setAttribute('r', r);
      arc.setAttribute('fill', 'none');
      arc.setAttribute('stroke', 'url(#fg-donut-g' + i + ')');
      arc.setAttribute('stroke-width', '11');
      arc.setAttribute('stroke-linecap', 'round');
      arc.setAttribute('stroke-dasharray', len + ' ' + circ);
      arc.setAttribute('transform', 'rotate(' + cursor + ' ' + c + ' ' + c + ')');
      arc.style.filter = 'drop-shadow(0 4px 10px ' + seg.glow + ')';
      arc.style.transitionDelay = (0.05 + i * 0.11) + 's';
      svg.appendChild(arc);
      cursor += (seg.pct / 100) * 360;
    });

    donut.appendChild(svg);

    var center = doc.createElement('div');
    center.className = 'fg-donut__center';
    center.innerHTML =
      '<span class="fg-donut__label">覆盖范围</span>' +
      '<span class="fg-donut__value" data-donut-value>0%</span>' +
      '<span class="fg-donut__hint">+2.1% 较上周</span>';
    donut.appendChild(center);
    return center.querySelector('[data-donut-value]');
  }

  var donutValueEl = buildDonut();

  function revealDonut() {
    if (!donut || donut.classList.contains('is-ready')) return;
    donut.classList.add('is-ready');
    var target = 94;
    if (!donutValueEl || reduceMotion.matches) {
      if (donutValueEl) donutValueEl.textContent = target + '%';
      return;
    }
    var t0 = performance.now();
    var duration = 1250;
    function frame(now) {
      var p = clamp((now - t0) / duration, 0, 1);
      donutValueEl.textContent = Math.round(target * easeOutCubic(p)) + '%';
      if (p < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  if (donut && reduceMotion.matches) revealDonut();

  /* ---------------- 30 天趋势图 ---------------- */
  var chart = $('#fg-trend-chart');
  var svgHost = $('#fg-trend-svg');
  var axisHost = $('#fg-trend-axis');
  var tip = $('#fg-trend-tip');
  var cursorLine = null;
  var trendPoints = [];
  var trendDates = [];
  var trendValues = [];
  var chartDrawn = false;
  var dotEl = null;
  var drawTrendOnce = null;

  function positionDot(p) {
    if (!chart || !dotEl || !p) return;
    var usableH = Math.max(chart.clientHeight - 18, 1);
    dotEl.style.left = ((p.x / 720) * 100) + '%';
    dotEl.style.top = ((p.y / 220) * usableH) + 'px';
  }

  window.addEventListener('resize', function () {
    if (trendPoints.length) positionDot(trendPoints[trendPoints.length - 1]);
  }, { passive: true });

  function buildTrendData() {
    var rnd = seeded(2026);
    var count = 30;
    var now = new Date();
    var values = [];
    var dates = [];
    for (var i = 0; i < count; i++) {
      var d = new Date(now.getTime() - (count - 1 - i) * 86400000);
      dates.push(d);
      var base = 2050 + i * 58;
      var wave = Math.sin(i / 3.1) * 190 + Math.sin(i / 1.7) * 90 + (rnd() - 0.5) * 260;
      values.push(Math.max(900, Math.round(base + wave)));
    }
    return { values: values, dates: dates };
  }

  function smoothPath(points) {
    if (!points.length) return '';
    var d = 'M' + points[0].x + ' ' + points[0].y;
    for (var i = 0; i < points.length - 1; i++) {
      var p0 = points[i - 1] || points[i];
      var p1 = points[i];
      var p2 = points[i + 1];
      var p3 = points[i + 2] || p2;
      var c1x = p1.x + (p2.x - p0.x) / 6;
      var c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6;
      var c2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) + ', ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2) + ', ' + p2.x.toFixed(2) + ' ' + p2.y.toFixed(2);
    }
    return d;
  }

  function buildChart() {
    if (!chart || !svgHost) return;
    var data = buildTrendData();
    trendValues = data.values;
    trendDates = data.dates;

    var W = 720;
    var H = 220;
    var top = 16;
    var bottom = 204;
    var min = Math.min.apply(null, trendValues);
    var max = Math.max.apply(null, trendValues);
    var pad = (max - min) * 0.16 || 100;
    min -= pad;
    max += pad;

    var pts = trendValues.map(function (v, i) {
      var x = (i / (trendValues.length - 1)) * W;
      var y = bottom - ((v - min) / (max - min)) * (bottom - top);
      return { x: x, y: y };
    });
    trendPoints = pts;

    var NS = 'http://www.w3.org/2000/svg';
    svgHost.innerHTML = '';

    var defs = doc.createElementNS(NS, 'defs');
    var grad = doc.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', 'fg-trend-fill');
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0');
    grad.setAttribute('y2', '1');
    var s1 = doc.createElementNS(NS, 'stop');
    s1.setAttribute('offset', '0%');
    s1.setAttribute('stop-color', 'rgba(255,180,72,0.38)');
    var s2 = doc.createElementNS(NS, 'stop');
    s2.setAttribute('offset', '62%');
    s2.setAttribute('stop-color', 'rgba(255,196,110,0.12)');
    var s3 = doc.createElementNS(NS, 'stop');
    s3.setAttribute('offset', '100%');
    s3.setAttribute('stop-color', 'rgba(255,214,140,0)');
    grad.appendChild(s1);
    grad.appendChild(s2);
    grad.appendChild(s3);
    defs.appendChild(grad);
    svgHost.appendChild(defs);

    [0.12, 0.38, 0.64, 0.9].forEach(function (ratio) {
      var line = doc.createElementNS(NS, 'line');
      line.setAttribute('x1', '0');
      line.setAttribute('x2', String(W));
      line.setAttribute('y1', String((bottom - top) * ratio + top));
      line.setAttribute('y2', String((bottom - top) * ratio + top));
      line.setAttribute('stroke', 'var(--fg-chart-grid)');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svgHost.appendChild(line);
    });

    var linePath = smoothPath(pts);
    var areaPath = linePath + ' L' + W + ' ' + bottom + ' L0 ' + bottom + ' Z';

    var area = doc.createElementNS(NS, 'path');
    area.setAttribute('class', 'fg-chart__area');
    area.setAttribute('d', areaPath);
    area.setAttribute('fill', 'url(#fg-trend-fill)');
    svgHost.appendChild(area);

    var line = doc.createElementNS(NS, 'path');
    line.setAttribute('class', 'fg-chart__line');
    line.setAttribute('d', linePath);
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svgHost.appendChild(line);

    dotEl = doc.createElement('div');
    dotEl.className = 'fg-chart__dot';
    chart.appendChild(dotEl);
    positionDot(pts[pts.length - 1]);

    if (axisHost) {
      axisHost.innerHTML = '';
      [0, 9, 19, 29].forEach(function (idx) {
        var span = doc.createElement('span');
        var d = trendDates[idx];
        span.textContent = (d.getMonth() + 1) + '/' + d.getDate();
        axisHost.appendChild(span);
      });
    }

    if (chart) {
      if (!cursorLine) {
        cursorLine = doc.createElement('div');
        cursorLine.className = 'fg-chart__cursor';
        chart.appendChild(cursorLine);
      }
      bindChartHover();
    }

    if (reduceMotion.matches) {
      dotEl.style.opacity = '1';
      chartDrawn = true;
    } else {
      var len = line.getTotalLength ? line.getTotalLength() : 2400;
      line.style.strokeDasharray = String(len);
      line.style.strokeDashoffset = String(len);
      window.setTimeout(function () {
        line.style.transition = 'stroke-dashoffset 1.5s cubic-bezier(.22,1,.36,1)';
        line.style.strokeDashoffset = '0';
        dotEl.style.opacity = '1';
      }, 260);
    }
    chartDrawn = true;
  }

  function bindChartHover() {
    if (!chart || !tip) return;
    var dateEl = tip.querySelector('.fg-tip__date');
    var valEl = tip.querySelector('.fg-tip__val');

    function move(e) {
      var rect = chart.getBoundingClientRect();
      var x = clamp(e.clientX - rect.left, 0, rect.width);
      var usableH = rect.height - 18;
      var ratio = rect.width > 0 ? x / rect.width : 0;
      var idx = Math.round(ratio * (trendValues.length - 1));
      idx = clamp(idx, 0, trendValues.length - 1);
      var p = trendPoints[idx];
      var px = rect.width * (p.x / 720);
      var py = (p.y / 220) * usableH;

      if (cursorLine) cursorLine.style.left = px + 'px';
      if (dotEl) {
        positionDot(p);
        dotEl.style.opacity = '1';
      }

      var d = trendDates[idx];
      dateEl.textContent = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
      valEl.textContent = trendValues[idx].toLocaleString('zh-CN') + ' 次';

      var tipLeft = clamp(px, 58, rect.width - 58);
      tip.style.left = tipLeft + 'px';
      tip.style.top = clamp(py - 64, 0, usableH - 54) + 'px';
      tip.hidden = false;
      chart.classList.add('is-hover');
    }

    chart.addEventListener('pointermove', move);
    chart.addEventListener('pointerleave', function () {
      chart.classList.remove('is-hover');
      tip.hidden = true;
      if (dotEl) {
        positionDot(trendPoints[trendPoints.length - 1]);
      }
    });
  }

  buildChart();
  drawTrendOnce = function () {
    // 图表已在构建时完成绘制动画，这里只确保入场后圆点可见
    if (dotEl) dotEl.style.opacity = '1';
  };

  /* ---------------- 实时运行流模拟 ---------------- */
  var liveBody = $('#fg-live-body');
  if (liveBody && !reduceMotion.matches) {
    var latencyCells = $all('[data-latency]', liveBody);
    window.setInterval(function () {
      var cell = latencyCells[Math.floor(Math.random() * latencyCells.length)];
      if (!cell) return;
      var current = parseFloat(cell.textContent) || 1;
      var next = clamp(current + (Math.random() - 0.5) * 0.6, 0.4, 5.4);
      cell.textContent = next.toFixed(1) + 's';
    }, 6000);
  }

  /* ---------------- 搜索面板 ---------------- */
  var search = $('#fg-search');
  var searchBtn = $('#fg-search-btn');
  var searchInput = $('#fg-search-input');
  var searchList = $('#fg-search-list');
  var lastFocus = null;
  var activeIndex = 0;

  var searchItems = [
    { icon: 'grid', name: '仪表盘', desc: '返回页面总览', target: '.fg-hero' },
    { icon: 'clipboard', name: '入门指南', desc: '完成初始配置步骤', target: '.fg-card--guide' },
    { icon: 'chart', name: '运营占比', desc: '查看覆盖范围与明细', target: '.fg-card--gauge' },
    { icon: 'doc', name: '30 天运营趋势', desc: '趋势曲线与预测', target: '.fg-card--trend' },
    { icon: 'calendar', name: '实时运行流', desc: '查看任务运行状态', target: '.fg-card--live' },
    { icon: 'sun', name: '切换主题', desc: '浅色 / 深色毛玻璃', action: 'theme' }
  ];

  function renderSearch(keyword) {
    if (!searchList) return;
    var q = (keyword || '').trim().toLowerCase();
    var items = searchItems.filter(function (item) {
      return !q || (item.name + item.desc).toLowerCase().indexOf(q) !== -1;
    });
    searchList.innerHTML = '';
    activeIndex = 0;

    if (!items.length) {
      var empty = doc.createElement('li');
      empty.className = 'fg-search__empty';
      empty.textContent = '没有找到匹配的内容';
      searchList.appendChild(empty);
      return;
    }

    items.forEach(function (item, i) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'fg-search__item' + (i === 0 ? ' is-active' : '');
      btn.setAttribute('data-index', String(i));
      btn.innerHTML =
        '<span class="fg-search__icon"><svg viewBox="0 0 24 24" class="fg-i"><use href="#fg-i-' + item.icon + '"></use></svg></span>' +
        '<span class="fg-search__copy"><span class="fg-search__name">' + item.name + '</span><span class="fg-search__desc">' + item.desc + '</span></span>';
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
    if (item.action === 'theme') {
      themeBtn.click();
      return;
    }
    if (item.target) {
      var el = $(item.target);
      if (!el) return;
      el.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
      el.classList.add('is-flash');
      setTimeout(function () { el.classList.remove('is-flash'); }, 1400);
      toast('已定位到：' + item.name);
    }
  }

  function openSearch() {
    if (!search) return;
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
    searchInput.addEventListener('input', function () {
      renderSearch(searchInput.value);
    });
    searchInput.addEventListener('keydown', function (e) {
      var items = $all('.fg-search__item', searchList);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(activeIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(activeIndex - 1);
      } else if (e.key === 'Enter') {
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
      if (e.shiftKey && doc.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && doc.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  /* ---------------- 初始化 ---------------- */
  onScroll();
  renderSearch('');
})();
