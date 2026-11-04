/* ============================================================
   我的应用导航 · 毛玻璃视图
   布局与主站一致：顶栏 / Hero+统计 / 工具栏 / 表格|卡片 / 页脚
   数据来自 /apps.json，命名空间 fg- / --fg- / fluxglass:*
   ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var narrowMql = window.matchMedia('(max-width: 760px)');

  var STORE = { theme: 'fluxglass:theme', order: 'fluxglass:appOrder' };
  var POLL_MS = 60000;

  var KIND_LABELS = { web: 'Web', app: 'APP', miniapp: '小程序', tv: '电视', cli: 'CLI' };
  var GIT_RANK = { dirty: 0, 'no-repo': 1, ahead: 2, behind: 3, untracked: 4, error: 5, 'no-upstream': 6, synced: 9 };
  var STATUS_RANK = { running: 0, down: 1 };
  var SORTS = {
    default: { dir: 1 },
    name: { dir: 1 },
    port: { dir: 1 },
    status: { dir: 1 },
    git: { dir: 1 }
  };

  var state = {
    apps: [],
    page: { siteName: '我的应用导航', heroTitle: '我的应用', heroSubtitle: '部署在这台服务器上的个人项目，端口与运行状态由服务端定时自动探测。' },
    probedAt: '',
    loading: true,
    error: '',
    sortKey: 'default',
    sortDir: 1,
    view: 'table',
    viewPicked: false,
    customOrder: loadOrder(),
    syncing: false,
    syncError: '',
    dragId: ''
  };

  /* ---------------- 小工具 ---------------- */
  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

  function node(tag, cls, text) {
    var el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function readStore(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) {}
  }

  function loadOrder() {
    var saved = readStore(STORE.order, null);
    return Array.isArray(saved) ? saved : [];
  }

  /* ---------------- 数据展示纯函数（与主站 app-utils 对齐） ---------------- */
  function isPublic(app) {
    return app.env ? app.env === 'public' : Boolean(app.remote);
  }

  function envInfo(app) {
    return isPublic(app)
      ? { cls: 'net', label: '公网' }
      : { cls: 'lan', label: '内网' };
  }

  function statusText(app) {
    if (app.appOnly) return '离线应用';
    return app.status === 'running' ? '运行中' : '未运行';
  }

  function statusClass(app) {
    if (app.appOnly) return 'offline';
    return app.status === 'running' ? 'ok' : 'down';
  }

  function formatUptime(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d) return d + ' 天 ' + h + ' 小时';
    if (h) return h + ' 小时 ' + m + ' 分';
    return m + ' 分钟';
  }

  function remoteHealthTitle(app) {
    var info = app.remoteInfo;
    if (!info) return '';
    var parts = [];
    if (info.httpStatus != null) parts.push('HTTP ' + info.httpStatus);
    if (info.responseMs != null) parts.push('延迟 ' + info.responseMs + 'ms');
    if (info.version) parts.push('版本 ' + info.version);
    if (info.dbReady != null) parts.push('数据库' + (info.dbReady ? '正常' : '未就绪'));
    var up = formatUptime(info.uptimeSec);
    if (up) parts.push('已运行 ' + up);
    if (info.rssMb != null) parts.push('内存 ' + info.rssMb + 'MB');
    return parts.join(' · ');
  }

  function statusTitle(app) {
    if (app.appOnly) return '离线应用：纯 APP / 小程序，无 Web 服务，不做端口探测';
    return remoteHealthTitle(app);
  }

  function kindList(app) {
    var kinds = Array.isArray(app.kinds) && app.kinds.length
      ? app.kinds
      : app.appOnly ? ['app'] : ['web'];
    return kinds.filter(function (k) { return KIND_LABELS[k]; }).map(function (k) {
      return { value: k, label: KIND_LABELS[k] };
    });
  }

  function stackText(app) {
    return [
      (app.languages || []).join('/'),
      (app.frontend || []).join(' + '),
      (app.backend || []).join(' + ')
    ].filter(Boolean).join(' · ');
  }

  function stackTitle(app) {
    var parts = [];
    if (app.languages && app.languages.length) parts.push('语言：' + app.languages.join('、'));
    if (app.frontend && app.frontend.length) parts.push('前端：' + app.frontend.join('、'));
    if (app.backend && app.backend.length) parts.push('后端：' + app.backend.join('、'));
    return parts.join('；');
  }

  function portText(app) {
    return app.port != null ? app.port : (app.expectedPort != null ? app.expectedPort : '—');
  }

  function buildAppUrl(app) {
    if (app.url) return app.url;
    if (!app.port) return '';
    var scheme = app.https ? 'https' : 'http';
    return scheme + '://' + (window.location.hostname || 'localhost') + ':' + app.port;
  }

  function gitSyncView(git) {
    if (!git) return null;
    var branch = git.branch || '（detached）';
    var counts = [];
    if (git.uncommitted) counts.push('未提交 ' + git.uncommitted);
    if (git.ahead) counts.push('未推送 ' + git.ahead);
    if (git.behind) counts.push('未拉取 ' + git.behind);
    if (git.untracked) counts.push('未跟踪 ' + git.untracked);
    if (git.remoteOk === false) counts.push('远端不可达，以上为上次快照');

    var map = {
      synced: { text: '已同步', cls: 'ok' },
      dirty: { text: '未提交 ' + git.uncommitted, cls: 'bad' },
      ahead: { text: '未推送 ' + git.ahead, cls: 'warn' },
      behind: { text: '未拉取 ' + git.behind, cls: 'warn' },
      untracked: { text: '未跟踪 ' + git.untracked, cls: 'warn' },
      'no-repo': { text: '无 Git 仓库', cls: 'muted' },
      'no-upstream': { text: '未关联远端', cls: 'muted' },
      error: { text: '检查失败', cls: 'muted' }
    };
    var view = map[git.status] || { text: '检查失败', cls: 'muted' };
    var detail = git.message ? git.message : counts.length ? counts.join(' · ') : '分支 ' + branch + ' 与远端一致';
    return {
      text: view.text,
      cls: view.cls,
      title: git.repo ? git.repo + '（' + branch + '）：' + detail : '分支 ' + branch + '：' + detail
    };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function makeCopyable(el, app) {
    el.title = app.directory + '（点击复制）';
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      copyText(app.directory).then(function (ok) {
        if (!ok) return;
        var original = app.directory;
        el.textContent = '✓ 已复制';
        el.title = '已复制';
        window.setTimeout(function () {
          el.textContent = original;
          el.title = original + '（点击复制）';
        }, 1500);
      });
    });
  }

  /* ---------------- 主题 ---------------- */
  var themeBtn = $('#fg-theme');
  var metaTheme = doc.querySelector('meta[name="theme-color"]');

  function currentTheme() { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    if (metaTheme) metaTheme.setAttribute('content', theme === 'dark' ? '#0b0e18' : '#eef0f9');
    if (themeBtn) {
      themeBtn.setAttribute('aria-pressed', String(theme === 'dark'));
      themeBtn.setAttribute('aria-label', theme === 'dark' ? '切换浅色' : '切换深色');
      themeBtn.title = theme === 'dark' ? '切换浅色' : '切换深色';
    }
    writeStore(STORE.theme, theme);
  }

  if (themeBtn) {
    applyTheme(currentTheme());
    themeBtn.addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
  }

  /* ---------------- 顶栏滚动阴影 ---------------- */
  var topbar = $('#fg-topbar');
  var scrollTick = false;
  function onScroll() {
    if (topbar) topbar.classList.toggle('is-scrolled', window.scrollY > 8);
    scrollTick = false;
  }
  window.addEventListener('scroll', function () {
    if (!scrollTick) {
      scrollTick = true;
      window.requestAnimationFrame(onScroll);
    }
  }, { passive: true });

  /* ---------------- 数据获取 ---------------- */
  function fetchApps(silent) {
    if (!silent) {
      state.loading = true;
      state.error = '';
      renderChrome();
      renderViews();
    }
    return fetch('../apps.json?_=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        state.apps = Array.isArray(data.apps) ? data.apps : [];
        state.probedAt = data.probedAt || '';
        if (data.page) {
          state.page = {
            siteName: data.page.siteName || state.page.siteName,
            heroTitle: data.page.heroTitle || state.page.heroTitle,
            heroSubtitle: data.page.heroSubtitle || state.page.heroSubtitle
          };
        }
        state.loading = false;
        state.error = '';
        renderAll();
        return data;
      })
      .catch(function (err) {
        state.loading = false;
        if (!silent) {
          state.error = '加载应用数据失败：' + err.message;
          renderChrome();
          renderViews();
        }
        return null;
      });
  }

  /* ---------------- 统计与页面信息 ---------------- */
  function renderChrome() {
    var page = state.page;
    document.title = (page.siteName || '我的应用导航') + ' · 毛玻璃视图';
    setText('#fg-site-name', page.siteName);
    setText('#fg-site-foot', page.siteName);
    setText('#fg-hero-title', page.heroTitle);
    setText('#fg-hero-sub', page.heroSubtitle);
    setText('#fg-year', String(new Date().getFullYear()));

    var running = state.apps.filter(function (a) { return a.status === 'running'; }).length;
    var lan = state.apps.filter(function (a) { return !isPublic(a); }).length;
    var net = state.apps.filter(isPublic).length;
    var gitUnsynced = state.apps.filter(function (a) { return a.git && a.git.status !== 'synced'; }).length;

    setText('#fg-count-apps', String(state.apps.length));
    setText('#fg-count-running', String(running));
    setText('#fg-count-lan', String(lan));
    setText('#fg-count-public', String(net));

    var runDot = $('#fg-run-dot');
    if (runDot) runDot.className = 'fg-stat-dot ' + (running ? 'is-ok' : 'is-off');
    var gitDot = $('#fg-git-dot');
    if (gitDot) gitDot.className = 'fg-stat-dot ' + (gitUnsynced ? 'is-warn' : 'is-ok');

    var gitText = $('#fg-git-text');
    if (gitText) {
      gitText.textContent = '';
      if (gitUnsynced) {
        var b = node('b', null, String(gitUnsynced));
        gitText.appendChild(b);
        gitText.appendChild(doc.createTextNode(' 个源码未同步'));
      } else {
        gitText.textContent = '源码全部已同步';
      }
    }

    renderFooterTime();
    renderToolbarState();
    updateSyncUI();
  }

  function renderFooterTime() {
    var el = $('#fg-probe-text');
    if (!el) return;
    if (!state.probedAt) { el.textContent = ''; return; }
    var time = '';
    try {
      time = new Date(state.probedAt).toLocaleTimeString('zh-CN', {
        hour12: false,
        timeZone: 'Asia/Shanghai'
      });
    } catch (e) { time = ''; }
    el.textContent = '最后探测 ' + time + '（北京时间）· 端口每 3 分钟 · git 每 5 分钟';
  }

  function setText(sel, text) {
    var el = $(sel);
    if (el) el.textContent = text || '';
  }

  /* ---------------- 排序 ---------------- */
  function compareApps(a, b) {
    switch (state.sortKey) {
      case 'name':
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      case 'port':
        return (a.port != null ? a.port : Infinity) - (b.port != null ? b.port : Infinity);
      case 'status':
        return statusRank(a) - statusRank(b) || a.name.localeCompare(b.name, 'zh-Hans-CN');
      case 'git':
        return gitRank(a) - gitRank(b) || a.name.localeCompare(b.name, 'zh-Hans-CN');
      default:
        return 0;
    }
  }

  function statusRank(a) {
    if (a.appOnly) return 2;
    return STATUS_RANK[a.status] != null ? STATUS_RANK[a.status] : 9;
  }

  function gitRank(a) {
    var st = a.git && a.git.status;
    return GIT_RANK[st] != null ? GIT_RANK[st] : 9;
  }

  function displayApps() {
    var list = state.apps.slice();
    if (state.sortKey !== 'default') {
      list.sort(function (a, b) { return compareApps(a, b) * state.sortDir; });
    } else if (state.customOrder.length) {
      var rank = {};
      state.customOrder.forEach(function (id, i) { rank[id] = i; });
      list.sort(function (a, b) {
        var ra = rank[a.id] != null ? rank[a.id] : Infinity;
        var rb = rank[b.id] != null ? rank[b.id] : Infinity;
        return ra - rb;
      });
    }
    return list;
  }

  function setSort(key) {
    if (key !== 'default' && state.sortKey === key) {
      state.sortDir = -state.sortDir;
    } else {
      state.sortKey = key;
      state.sortDir = SORTS[key] ? SORTS[key].dir : 1;
    }
    renderAll();
  }

  function renderToolbarState() {
    var select = $('#fg-sort');
    if (select) select.value = state.sortKey;
    var dir = $('#fg-sort-dir');
    if (dir) {
      dir.hidden = state.sortKey === 'default';
      dir.textContent = state.sortDir === 1 ? '↑' : '↓';
      dir.title = state.sortDir === 1 ? '正序（点击切换倒序）' : '倒序（点击切换正序）';
    }
    var reset = $('#fg-reset-order');
    if (reset) reset.hidden = !(state.sortKey === 'default' && state.customOrder.length);
    $all('.fg-segmented button').forEach(function (b) {
      var active = b.getAttribute('data-view') === state.view;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
  }

  /* ---------------- 视图渲染 ---------------- */
  function renderAll() {
    renderChrome();
    renderViews();
  }

  function renderViews() {
    var loading = $('#fg-loading');
    var error = $('#fg-error');
    var empty = $('#fg-empty');
    var table = $('#fg-table-wrap');
    var cards = $('#fg-card-grid');
    if (!table || !cards) return;

    if (state.loading) {
      if (loading) loading.hidden = false;
      if (error) error.hidden = true;
      if (empty) empty.hidden = true;
      table.hidden = true;
      cards.hidden = true;
      return;
    }
    if (loading) loading.hidden = true;

    if (state.error) {
      if (error) error.hidden = false;
      setText('#fg-error-text', state.error);
      if (empty) empty.hidden = true;
      table.hidden = true;
      cards.hidden = true;
      return;
    }
    if (error) error.hidden = true;

    if (!state.apps.length) {
      if (empty) empty.hidden = false;
      table.hidden = true;
      cards.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;

    if (state.view === 'card') {
      table.hidden = true;
      cards.hidden = false;
      renderCards();
    } else {
      cards.hidden = true;
      table.hidden = false;
      renderTable();
    }
  }

  function pickView(view) {
    state.view = view;
    state.viewPicked = true;
    renderToolbarState();
    renderViews();
  }

  function applyDefaultView() {
    if (!state.viewPicked) state.view = narrowMql.matches ? 'card' : 'table';
    renderToolbarState();
    if (!state.loading && !state.error && state.apps.length) renderViews();
  }

  /* ---------------- 表格 ---------------- */
  function renderTable() {
    var thead = $('#fg-thead');
    var tbody = $('#fg-tbody');
    if (!thead || !tbody) return;
    var reorderable = state.sortKey === 'default';
    thead.innerHTML = '';
    tbody.innerHTML = '';

    var tr = doc.createElement('tr');
    if (reorderable) {
      var handleTh = doc.createElement('th');
      handleTh.className = 'fg-col-handle';
      handleTh.title = '拖拽行调整顺序（保存在本浏览器）';
      tr.appendChild(handleTh);
    }

    [
      { key: 'status', label: '状态', cls: 'fg-col-status' },
      { key: 'name', label: '应用', cls: '' },
      { key: null, label: '简介', cls: 'fg-col-desc' },
      { key: 'port', label: '访问地址', cls: '' },
      { key: null, label: '服务器 / 目录', cls: '' },
      { key: 'git', label: '同步', cls: '' },
      { key: null, label: 'GitHub', cls: 'fg-col-github' }
    ].forEach(function (col) {
      var th = doc.createElement('th');
      if (col.cls) th.className = col.cls;
      if (col.key) {
        th.className += ' is-sortable';
        if (state.sortKey === col.key) th.className += ' is-on';
        th.title = '按' + col.label + '排序（再次点击切换方向）';
        th.addEventListener('click', function () { setSort(col.key); });
      }
      th.appendChild(doc.createTextNode(col.label));
      if (col.key && state.sortKey === col.key) {
        var arrow = node('span', 'fg-sortarrow', state.sortDir === 1 ? '▲' : '▼');
        th.appendChild(arrow);
      }
      tr.appendChild(th);
    });
    thead.appendChild(tr);

    displayApps().forEach(function (app) {
      tbody.appendChild(buildRow(app, reorderable));
    });
  }

  function buildRow(app, reorderable) {
    var env = envInfo(app);
    var row = doc.createElement('tr');
    row.className = env.cls + (state.dragId === app.id ? ' is-dragging' : '');

    if (reorderable) {
      var handleTd = doc.createElement('td');
      handleTd.className = 'fg-col-handle';
      var grip = buildGrip();
      grip.draggable = true;
      grip.addEventListener('dragstart', function (e) {
        state.dragId = app.id;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', app.id);
          e.dataTransfer.setDragImage(row, 24, 24);
        }
        row.classList.add('is-dragging');
      });
      grip.addEventListener('dragend', function () {
        state.dragId = '';
        row.classList.remove('is-dragging');
      });
      handleTd.appendChild(grip);
      row.appendChild(handleTd);

      row.addEventListener('dragover', function (e) { e.preventDefault(); });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        if (state.dragId) onDrop(state.dragId, app.id);
      });
    }

    var statusTd = doc.createElement('td');
    statusTd.className = 'fg-col-status';
    statusTd.appendChild(buildStatusBadge(app));
    row.appendChild(statusTd);

    var appTd = doc.createElement('td');
    appTd.appendChild(buildAppCell(app, env));
    row.appendChild(appTd);

    var descTd = doc.createElement('td');
    descTd.className = 'fg-col-desc';
    var desc = node('span', 'fg-desc', app.description || '');
    desc.title = app.description || '';
    descTd.appendChild(desc);
    row.appendChild(descTd);

    var accessTd = doc.createElement('td');
    buildAccess(accessTd, app);
    row.appendChild(accessTd);

    var dirTd = doc.createElement('td');
    buildDir(dirTd, app);
    row.appendChild(dirTd);

    var syncTd = doc.createElement('td');
    var git = gitSyncView(app.git);
    if (git) {
      var chip = node('span', 'fg-syncchip ' + git.cls, git.text);
      chip.title = git.title;
      syncTd.appendChild(chip);
    } else {
      syncTd.appendChild(node('span', 'fg-text-muted', '—'));
    }
    row.appendChild(syncTd);

    var ghTd = doc.createElement('td');
    ghTd.className = 'fg-col-github';
    if (app.github) {
      var gh = node('a', 'fg-ghlink', '源码 ↗');
      gh.href = app.github;
      gh.target = '_blank';
      gh.rel = 'noopener';
      gh.title = '查看源码';
      ghTd.appendChild(gh);
    } else {
      ghTd.appendChild(node('span', 'fg-text-muted', '—'));
    }
    row.appendChild(ghTd);

    return row;
  }

  function buildGrip() {
    var grip = node('span', 'fg-grip');
    grip.title = '按住拖拽调整顺序';
    grip.innerHTML = '<svg width="10" height="16" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">' +
      '<circle cx="5" cy="4" r="1.8"/><circle cx="11" cy="4" r="1.8"/>' +
      '<circle cx="5" cy="10" r="1.8"/><circle cx="11" cy="10" r="1.8"/>' +
      '<circle cx="5" cy="16" r="1.8"/><circle cx="11" cy="16" r="1.8"/></svg>';
    return grip;
  }

  function buildStatusBadge(app) {
    var badge = node('span', 'fg-badge ' + statusClass(app));
    badge.appendChild(node('span', 'fg-dot'));
    badge.appendChild(doc.createTextNode(statusText(app)));
    var title = statusTitle(app);
    if (title) badge.title = title;
    return badge;
  }

  function buildAppCell(app, env) {
    var cell = node('div', 'fg-appcell');
    var icon = node('span', 'fg-appicon' + (env.cls === 'net' ? ' is-net' : ''), app.icon || '▣');
    icon.setAttribute('aria-hidden', 'true');

    var meta = node('div', 'fg-appmeta');
    var nameLine = node('span', 'fg-appname');
    nameLine.appendChild(node('span', 'fg-envchip ' + env.cls, env.label));
    nameLine.appendChild(node('span', 'fg-name-text', app.name));
    if (app.remoteInfo && app.remoteInfo.version) {
      var version = node('span', 'fg-tag', 'v' + app.remoteInfo.version);
      version.title = remoteHealthTitle(app);
      nameLine.appendChild(version);
    }
    if (app.pending) {
      var pending = node('span', 'fg-tag fg-tag--warn', '待补充');
      pending.title = '请在 scripts/apps.config.json 中补充信息';
      nameLine.appendChild(pending);
    }

    var tags = node('span', 'fg-apptags');
    kindList(app).forEach(function (k) {
      var chip = node('span', 'fg-kindchip ' + k.value, k.label);
      chip.title = '应用形式：' + k.label;
      tags.appendChild(chip);
    });
    var stack = stackText(app);
    if (stack) {
      var stackEl = node('span', 'fg-stack', stack);
      stackEl.title = stackTitle(app);
      tags.appendChild(stackEl);
    }

    meta.appendChild(nameLine);
    meta.appendChild(tags);
    cell.appendChild(icon);
    cell.appendChild(meta);
    return cell;
  }

  function buildAccess(cell, app) {
    if (app.appOnly) {
      var dash = node('span', 'fg-text-muted', '—');
      dash.title = '该应用无 Web 服务入口';
      cell.appendChild(dash);
      return;
    }
    var url = buildAppUrl(app);
    if (url) {
      var link = node('a', 'fg-port-link', ':' + portText(app) + ' ↗');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = url;
      cell.appendChild(link);
    } else {
      var muted = node('span', 'fg-port-link is-muted', ':' + portText(app));
      muted.title = '未监听，不可访问';
      cell.appendChild(muted);
    }
    if (app.extraPorts && app.extraPorts.length) {
      cell.appendChild(node('span', 'fg-extra-ports', '+' + app.extraPorts.join(', ')));
    }
    if (app.port && !app.external) {
      var tag = node('span', 'fg-tag fg-tag--neutral', '仅本机');
      tag.title = '该服务仅监听 127.0.0.1，仅本机可访问';
      cell.appendChild(tag);
    }
  }

  function buildDir(cell, app) {
    if (app.remote) {
      var remote = node('span', 'fg-dir', (app.location || '远程') + ' · ' + (app.host || ''));
      remote.title = (app.location || '') + ' · ' + (app.host || '');
      cell.appendChild(remote);
      return;
    }
    var dir = node('span', 'fg-dir is-copyable', app.directory || '—');
    makeCopyable(dir, app);
    cell.appendChild(dir);
  }

  /* ---------------- 卡片 ---------------- */
  function renderCards() {
    var grid = $('#fg-card-grid');
    if (!grid) return;
    var reorderable = state.sortKey === 'default';
    var list = displayApps();
    grid.innerHTML = '';

    list.forEach(function (app, index) {
      grid.appendChild(buildCard(app, index, list.length, reorderable));
    });
  }

  function buildCard(app, index, total, reorderable) {
    var env = envInfo(app);
    var card = doc.createElement('article');
    card.className = 'fg-appcard ' + env.cls + (state.dragId === app.id ? ' is-dragging' : '');

    var head = node('div', 'fg-cardhead');
    if (reorderable) {
      var grip = node('span', 'fg-cardgrip');
      grip.innerHTML = '<svg width="10" height="14" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">' +
        '<circle cx="5" cy="4" r="1.8"/><circle cx="11" cy="4" r="1.8"/>' +
        '<circle cx="5" cy="10" r="1.8"/><circle cx="11" cy="10" r="1.8"/>' +
        '<circle cx="5" cy="16" r="1.8"/><circle cx="11" cy="16" r="1.8"/></svg>';
      grip.draggable = true;
      grip.title = '按住拖拽调整顺序';
      grip.addEventListener('dragstart', function (e) {
        state.dragId = app.id;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', app.id);
          e.dataTransfer.setDragImage(card, 30, 30);
        }
        card.classList.add('is-dragging');
      });
      grip.addEventListener('dragend', function () {
        state.dragId = '';
        card.classList.remove('is-dragging');
      });
      head.appendChild(grip);
    }

    var icon = node('span', 'fg-appicon' + (env.cls === 'net' ? ' is-net' : ''), app.icon || '▣');
    icon.setAttribute('aria-hidden', 'true');
    head.appendChild(icon);

    var title = node('div', 'fg-cardtitle');
    var h3 = doc.createElement('h3');
    h3.appendChild(node('span', 'fg-envchip ' + env.cls, env.label));
    h3.appendChild(doc.createTextNode(app.name));
    if (app.remoteInfo && app.remoteInfo.version) {
      var version = node('span', 'fg-tag', 'v' + app.remoteInfo.version);
      version.title = remoteHealthTitle(app);
      h3.appendChild(version);
    }
    if (app.pending) {
      var pending = node('span', 'fg-tag fg-tag--warn', '待补充');
      pending.title = '请在 scripts/apps.config.json 中补充信息';
      h3.appendChild(pending);
    }
    title.appendChild(h3);
    var badge = buildStatusBadge(app);
    badge.classList.add('fg-cardstatus');
    title.appendChild(badge);
    head.appendChild(title);

    if (reorderable) {
      var move = node('div', 'fg-cardmove');
      var up = node('button', 'fg-minibtn', '↑');
      up.type = 'button';
      up.title = '上移';
      up.disabled = index === 0;
      up.addEventListener('click', function () { moveApp(app.id, -1); });
      var down = node('button', 'fg-minibtn', '↓');
      down.type = 'button';
      down.title = '下移';
      down.disabled = index === total - 1;
      down.addEventListener('click', function () { moveApp(app.id, 1); });
      move.appendChild(up);
      move.appendChild(down);
      head.appendChild(move);
    }
    card.appendChild(head);

    var desc = node('p', 'fg-carddesc', app.description || '');
    card.appendChild(desc);

    var facts = node('div', 'fg-facts');
    facts.appendChild(buildFactAccess(app));
    facts.appendChild(buildFactDir(app));
    facts.appendChild(buildFactRow('技术栈', stackText(app) || '—', stackTitle(app)));
    facts.appendChild(buildFactSync(app));
    facts.appendChild(buildFactGithub(app));
    card.appendChild(facts);

    var kinds = kindList(app);
    if (kinds.length) {
      var tags = node('div', 'fg-cardtags');
      kinds.forEach(function (k) {
        var chip = node('span', 'fg-kindchip ' + k.value, k.label);
        chip.title = '应用形式：' + k.label;
        tags.appendChild(chip);
      });
      card.appendChild(tags);
    }

    if (reorderable) {
      card.addEventListener('dragover', function (e) { e.preventDefault(); });
      card.addEventListener('drop', function (e) {
        e.preventDefault();
        if (state.dragId) onDrop(state.dragId, app.id);
      });
    }

    return card;
  }

  function buildFact(label, content) {
    var fact = node('div', 'fg-fact');
    fact.appendChild(node('span', 'fg-factlabel', label));
    fact.appendChild(content);
    return fact;
  }

  function buildFactRow(label, text, title) {
    var value = node('span', 'fg-factvalue', text);
    if (title) value.title = title;
    return buildFact(label, value);
  }

  function buildFactAccess(app) {
    var wrap = node('span', 'fg-factvalue');
    if (app.appOnly) {
      wrap.appendChild(node('span', 'fg-text-muted', '—'));
      return buildFact('访问', wrap);
    }
    var url = buildAppUrl(app);
    if (url) {
      var link = node('a', 'fg-port-link', ':' + portText(app) + ' ↗');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      wrap.appendChild(link);
    } else {
      wrap.appendChild(node('span', 'fg-port-link is-muted', ':' + portText(app)));
    }
    if (app.extraPorts && app.extraPorts.length) {
      wrap.appendChild(node('span', 'fg-extra-ports', '+' + app.extraPorts.join(', ')));
    }
    if (app.port && !app.external) {
      wrap.appendChild(node('span', 'fg-tag fg-tag--neutral', '仅本机'));
    }
    return buildFact('访问', wrap);
  }

  function buildFactDir(app) {
    if (app.remote) {
      return buildFactRow('位置', (app.location || '远程') + ' · ' + (app.host || ''));
    }
    var dir = node('span', 'fg-factvalue fg-dir is-copyable', app.directory || '—');
    makeCopyable(dir, app);
    return buildFact('目录', dir);
  }

  function buildFactSync(app) {
    var wrap = node('span', 'fg-factvalue');
    var git = gitSyncView(app.git);
    if (git) {
      var chip = node('span', 'fg-syncchip ' + git.cls, git.text);
      chip.title = git.title;
      wrap.appendChild(chip);
    } else {
      wrap.appendChild(node('span', 'fg-text-muted', '—'));
    }
    return buildFact('同步', wrap);
  }

  function buildFactGithub(app) {
    var wrap = node('span', 'fg-factvalue');
    if (app.github) {
      var link = node('a', 'fg-ghlink', app.github.replace('https://github.com/', '') + ' ↗');
      link.href = app.github;
      link.target = '_blank';
      link.rel = 'noopener';
      wrap.appendChild(link);
    } else {
      wrap.appendChild(node('span', 'fg-text-muted', '—'));
    }
    return buildFact('源码', wrap);
  }

  /* ---------------- 手动排序 ---------------- */
  function saveOrder(ids) {
    state.customOrder = ids;
    writeStore(STORE.order, ids);
    renderAll();
  }

  function moveApp(id, delta) {
    var ids = displayApps().map(function (a) { return a.id; });
    var i = ids.indexOf(id);
    var j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    var tmp = ids[i];
    ids[i] = ids[j];
    ids[j] = tmp;
    saveOrder(ids);
  }

  function onDrop(fromId, targetId) {
    if (!fromId || fromId === targetId) return;
    var ids = displayApps().map(function (a) { return a.id; });
    var fi = ids.indexOf(fromId);
    if (fi < 0 || ids.indexOf(targetId) < 0) return;
    ids.splice(fi, 1);
    ids.splice(ids.indexOf(targetId), 0, fromId);
    saveOrder(ids);
    state.dragId = '';
  }

  function resetOrder() {
    state.customOrder = [];
    try { localStorage.removeItem(STORE.order); } catch (e) {}
    renderAll();
  }

  /* ---------------- 立刻同步 ---------------- */
  function updateSyncUI() {
    var btn = $('#fg-sync');
    var label = $('#fg-sync-label');
    var errEl = $('#fg-sync-error');
    if (btn) {
      btn.disabled = state.syncing;
      btn.classList.toggle('is-syncing', state.syncing);
    }
    if (label) label.textContent = state.syncing ? '同步中…' : '立刻同步';
    if (errEl) {
      errEl.hidden = !state.syncError;
      errEl.textContent = state.syncError || '';
    }
  }

  function waitForProbe(after) {
    return new Promise(function (resolve) {
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        fetch('../apps.json?_=' + Date.now(), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.probedAt && new Date(d.probedAt).getTime() > after) {
              clearInterval(timer);
              resolve(true);
            } else if (tries >= 90) {
              clearInterval(timer);
              resolve(false);
            }
          })
          .catch(function () {
            if (tries >= 90) {
              clearInterval(timer);
              resolve(false);
            }
          });
      }, 2000);
    });
  }

  async function syncNow() {
    if (state.syncing) return;
    state.syncing = true;
    state.syncError = '';
    updateSyncUI();
    try {
      var res = await fetch('/api/probe', { method: 'POST' });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status);
      var startedAt = data.startedAt || Date.now();
      var done = await waitForProbe(startedAt);
      await fetchApps(true);
      if (!done) state.syncError = '同步超时，请稍后刷新查看';
    } catch (err) {
      state.syncError = '同步失败：' + err.message;
    } finally {
      state.syncing = false;
      updateSyncUI();
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  var sortSelect = $('#fg-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', function () {
      state.sortKey = sortSelect.value;
      state.sortDir = SORTS[state.sortKey] ? SORTS[state.sortKey].dir : 1;
      renderAll();
    });
  }

  var dirBtn = $('#fg-sort-dir');
  if (dirBtn) {
    dirBtn.addEventListener('click', function () {
      state.sortDir = -state.sortDir;
      renderAll();
    });
  }

  var resetBtn = $('#fg-reset-order');
  if (resetBtn) resetBtn.addEventListener('click', resetOrder);

  $all('.fg-segmented button').forEach(function (btn) {
    btn.addEventListener('click', function () { pickView(btn.getAttribute('data-view')); });
  });

  var syncBtn = $('#fg-sync');
  if (syncBtn) syncBtn.addEventListener('click', syncNow);

  var retryBtn = $('#fg-retry');
  if (retryBtn) retryBtn.addEventListener('click', function () { fetchApps(); });

  if (narrowMql.addEventListener) {
    narrowMql.addEventListener('change', applyDefaultView);
  }

  /* ---------------- 启动 ---------------- */
  applyTheme(currentTheme());
  applyDefaultView();
  onScroll();
  fetchApps();
  window.setInterval(function () { fetchApps(true); }, POLL_MS);
  doc.addEventListener('visibilitychange', function () {
    if (!doc.hidden) fetchApps(true);
  });
})();
