/* ============================================================
   /unslop/ 设计对比端点 v2 · 主站视觉 1:1 移植 + 净化级优化
   数据源与主站一致：apps.json（探测器定时生成，页面 60s 轮询）
   ============================================================ */
;(function () {
  'use strict'

  /* ---------- 小工具 ---------- */
  const $ = (sel) => document.querySelector(sel)

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }

  const attr = (name, value) => (value ? ` ${name}="${esc(value)}"` : '')

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // http 非安全上下文下 clipboard API 不可用，退回 execCommand
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      ta.remove()
      return ok
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch { /* 仅本次会话生效 */ }
  }

  function load(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key))
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }

  /* ---------- 数据加工（与主站 src/lib/app-utils.js 行为一致） ---------- */
  function buildAppUrl(app) {
    if (app.url) return app.url
    const port = app.port
    if (!port) return ''
    const scheme = app.https ? 'https' : 'http'
    return `${scheme}://${window.location.hostname || 'localhost'}:${port}`
  }

  const portText = (app) => app.port ?? app.expectedPort ?? '—'
  const hasUrl = (app) => Boolean(app.port)

  function formatUptime(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return ''
    const d = Math.floor(sec / 86400)
    const h = Math.floor((sec % 86400) / 3600)
    const m = Math.floor((sec % 3600) / 60)
    if (d) return `${d} 天 ${h} 小时`
    if (h) return `${h} 小时 ${m} 分`
    return `${m} 分钟`
  }

  function remoteHealthTitle(app) {
    const info = app.remoteInfo
    if (!info) return ''
    const parts = []
    if (info.httpStatus != null) parts.push(`HTTP ${info.httpStatus}`)
    if (info.responseMs != null) parts.push(`延迟 ${info.responseMs}ms`)
    if (info.version) parts.push(`版本 ${info.version}`)
    if (info.dbReady != null) parts.push(`数据库${info.dbReady ? '正常' : '未就绪'}`)
    const up = formatUptime(info.uptimeSec)
    if (up) parts.push(`已运行 ${up}`)
    if (info.rssMb != null) parts.push(`内存 ${info.rssMb}MB`)
    return parts.join(' · ')
  }

  /** 状态：运行中（绿）/ 未运行（红）/ 离线应用（灰，纯 APP / 小程序不探测） */
  function statusInfo(app) {
    if (app.appOnly) {
      return {
        text: '离线应用',
        cls: 'offline',
        title: '离线应用：纯 APP / 小程序，无 Web 服务，不做端口探测',
      }
    }
    if (app.status === 'running') return { text: '运行中', cls: 'ok', title: remoteHealthTitle(app) }
    return { text: '未运行', cls: 'down', title: remoteHealthTitle(app) }
  }

  const KIND_LABELS = { web: 'Web', app: 'APP', miniapp: '小程序', tv: '电视', cli: 'CLI' }

  function kindList(app) {
    const list = Array.isArray(app.kinds) && app.kinds.length
      ? app.kinds
      : app.appOnly ? ['app'] : ['web']
    return list.filter((k) => KIND_LABELS[k]).map((value) => ({ value, label: KIND_LABELS[value] }))
  }

  function stackText(app) {
    return [
      (app.languages ?? []).join('/'),
      (app.frontend ?? []).join(' + '),
      (app.backend ?? []).join(' + '),
    ].filter(Boolean).join(' · ')
  }

  function stackTitle(app) {
    const parts = []
    if (app.languages?.length) parts.push(`语言：${app.languages.join('、')}`)
    if (app.frontend?.length) parts.push(`前端：${app.frontend.join('、')}`)
    if (app.backend?.length) parts.push(`后端：${app.backend.join('、')}`)
    return parts.join('；')
  }

  const isPublic = (app) => (app.env ? app.env === 'public' : Boolean(app.remote))

  function envInfo(app) {
    return isPublic(app)
      ? { cls: 'net', label: '公网' }
      : { cls: 'lan', label: '内网' }
  }

  /** git 同步状态 → { text, cls, title }；无 git 信息返回 null */
  function gitView(git) {
    if (!git) return null
    const branch = git.branch || '（detached）'
    const counts = []
    if (git.uncommitted) counts.push(`未提交 ${git.uncommitted}`)
    if (git.ahead) counts.push(`未推送 ${git.ahead}`)
    if (git.behind) counts.push(`未拉取 ${git.behind}`)
    if (git.untracked) counts.push(`未跟踪 ${git.untracked}`)
    if (git.remoteOk === false) counts.push('远端不可达，以上为上次快照')

    const map = {
      synced: { text: '已同步', cls: 'ok' },
      dirty: { text: `未提交 ${git.uncommitted}`, cls: 'bad' },
      ahead: { text: `未推送 ${git.ahead}`, cls: 'warn' },
      behind: { text: `未拉取 ${git.behind}`, cls: 'warn' },
      untracked: { text: `未跟踪 ${git.untracked}`, cls: 'warn' },
      'no-repo': { text: '无 Git 仓库', cls: 'muted' },
      'no-upstream': { text: '未关联远端', cls: 'muted' },
      error: { text: '检查失败', cls: 'muted' },
    }
    const view = map[git.status] ?? { text: '检查失败', cls: 'muted' }

    const detail = git.message ? git.message : counts.length ? counts.join(' · ') : `分支 ${branch} 与远端一致`
    const title = git.repo ? `${git.repo}（${branch}）：${detail}` : `分支 ${branch}：${detail}`
    return { ...view, title }
  }

  /* ---------- 状态 ---------- */
  const ORDER_KEY = 'unslop:appOrder'
  const POLL_MS = 60_000

  const state = {
    apps: [],
    page: {
      siteName: '我的应用导航',
      heroTitle: '我的应用',
      heroSubtitle: '部署在这台服务器上的个人项目，端口与运行状态每 3 分钟自动探测，源码同步每 5 分钟。',
    },
    probedAt: '',
    loading: true,
    loadError: '',
    sortKey: 'default',
    sortDir: 1,
    customOrder: load(ORDER_KEY),
    view: 'table',
    viewPicked: false,
    syncing: false,
    dragId: '',
    dragIdx: -1,
  }

  /* ---------- 排序（与主站同规则） ---------- */
  const RANK_GIT = { dirty: 0, 'no-repo': 1, ahead: 2, behind: 3, untracked: 4, error: 5, 'no-upstream': 6, synced: 9 }
  const statusRank = (a) => (a.appOnly ? 2 : a.status === 'running' ? 0 : 1)
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')

  function compareApps(a, b) {
    switch (state.sortKey) {
      case 'name': return byName(a, b)
      case 'port': return (a.port ?? Infinity) - (b.port ?? Infinity)
      case 'status': return statusRank(a) - statusRank(b) || byName(a, b)
      case 'git': return (RANK_GIT[a.git?.status] ?? 9) - (RANK_GIT[b.git?.status] ?? 9) || byName(a, b)
      default: return 0
    }
  }

  function displayApps() {
    const list = [...state.apps]
    if (state.sortKey !== 'default') {
      list.sort((a, b) => compareApps(a, b) * state.sortDir)
    } else if (state.customOrder.length) {
      const rank = new Map(state.customOrder.map((id, i) => [id, i]))
      list.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
    }
    return list
  }

  function setSort(key) {
    if (key !== 'default' && state.sortKey === key) {
      state.sortDir = -state.sortDir
    } else {
      state.sortKey = key
      state.sortDir = 1
    }
    render()
  }

  function moveApp(id, delta) {
    const ids = displayApps().map((a) => a.id)
    const i = ids.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    state.customOrder = ids
    store(ORDER_KEY, ids)
    render()
  }

  function onDropRow(fromId, targetId) {
    if (!fromId || fromId === targetId) return
    const ids = displayApps().map((a) => a.id)
    const fi = ids.indexOf(fromId)
    if (fi < 0 || ids.indexOf(targetId) < 0) return
    ids.splice(fi, 1)
    ids.splice(ids.indexOf(targetId), 0, fromId)
    state.customOrder = ids
    store(ORDER_KEY, ids)
    render()
  }

  function onDropCard(fromIdx, targetIdx) {
    const apps = displayApps()
    if (fromIdx < 0 || fromIdx === targetIdx || fromIdx >= apps.length) return
    const ids = apps.map((a) => a.id)
    const [movedId] = ids.splice(fromIdx, 1)
    ids.splice(targetIdx > fromIdx ? targetIdx - 1 : targetIdx, 0, movedId)
    state.customOrder = ids
    store(ORDER_KEY, ids)
    render()
  }

  /* ---------- 数据获取 ---------- */
  async function fetchApps(silent = false) {
    if (!silent) {
      state.loading = true
      state.loadError = ''
      render()
    }
    try {
      const res = await fetch(`../apps.json?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      state.apps = data.apps ?? []
      state.probedAt = data.probedAt ?? ''
      if (data.page) state.page = { ...state.page, ...data.page }
      state.loadError = ''
    } catch (err) {
      if (!silent) state.loadError = `加载应用数据失败：${err.message}`
    } finally {
      state.loading = false
      renderPageText()
      render()
    }
  }

  /* ---------- 主题（与主站同机制：light/dark/auto） ---------- */
  const root = document.documentElement

  function isDark() {
    return root.dataset.theme === 'dark'
  }

  function toggleTheme() {
    const next = isDark() ? 'light' : 'dark'
    root.dataset.theme = next
    try {
      localStorage.setItem('unslop:theme', next)
    } catch { /* 忽略 */ }
    syncThemeBtn()
  }

  function syncThemeBtn() {
    $('#u-iconSun').hidden = !isDark()
    $('#u-iconMoon').hidden = isDark()
    $('#u-themeBtn').title = isDark() ? '切换浅色' : '切换深色'
  }

  /* ---------- 视图切换（≤760px 默认卡片，手动选择后尊重选择） ---------- */
  const narrowMql = window.matchMedia('(max-width: 760px)')

  function applyDefaultView() {
    if (!state.viewPicked) {
      state.view = narrowMql.matches ? 'card' : 'table'
      render()
    }
  }

  /* ---------- 渲染：页面文案 + hero 统计（与主站同款胶囊） ---------- */
  function renderPageText() {
    document.title = state.page.siteName || '我的应用导航'
    $('#u-siteName').textContent = state.page.siteName
    $('#u-heroTitle').textContent = state.page.heroTitle
    $('#u-heroSubtitle').textContent = state.page.heroSubtitle
    $('#u-copy').textContent = `© ${new Date().getFullYear()} ${state.page.siteName}`

    let probedLine = ''
    if (state.probedAt) {
      const d = new Date(state.probedAt)
      const t = d.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
      probedLine = `最后探测 ${t}（北京时间）· 端口每 3 分钟 · git 每 5 分钟`
    }
    $('#u-probed').textContent = probedLine

    const apps = state.apps
    const running = apps.filter((a) => a.status === 'running').length
    const lan = apps.filter((a) => !isPublic(a)).length
    const net = apps.filter((a) => isPublic(a)).length
    const unsynced = apps.filter((a) => a.git && a.git.status !== 'synced').length
    $('#u-stats').innerHTML = `
      <span class="stat-chip"><b>${apps.length}</b> 个应用</span>
      <span class="stat-chip">
        <span class="dot" style="background:${running ? 'var(--green)' : 'var(--gray)'}"></span>
        <b>${running}</b> 个运行中
      </span>
      <span class="stat-chip" title="按部署位置：内网 / 公网">
        内网 <b style="color: var(--accent)">${lan}</b>
        <span style="color: var(--gray)">·</span>
        公网 <b style="color: var(--amber)">${net}</b>
      </span>
      <span class="stat-chip" title="源码与 GitHub 仓库的同步状态">
        <span class="dot" style="background:${unsynced ? 'var(--amber)' : 'var(--green)'}"></span>
        ${unsynced ? `<b>${unsynced}</b> 个源码未同步` : '源码全部已同步'}
      </span>`
  }

  /* ---------- 渲染：表格（主站 AppTable.vue 同款结构） ---------- */
  function arrowHtml(key) {
    if (state.sortKey !== key) return ''
    return `<span class="arrow">${state.sortDir === 1 ? '▲' : '▼'}</span>`
  }

  function badgeHtml(app) {
    const s = statusInfo(app)
    return `<span class="badge ${s.cls}"${attr('title', s.title)}><span class="dot"></span>${esc(s.text)}</span>`
  }

  function appCellHtml(app) {
    const env = envInfo(app)
    const version = app.remoteInfo?.version
      ? `<span class="tag"${attr('title', remoteHealthTitle(app))}>v${esc(app.remoteInfo.version)}</span>`
      : ''
    const pending = app.pending
      ? '<span class="tag warn" title="请在 scripts/apps.config.json 中补充信息">待补充</span>'
      : ''
    const kinds = kindList(app)
      .map((k) => `<span class="kind-chip ${k.value}" title="应用形式：${esc(k.label)}">${esc(k.label)}</span>`)
      .join('')
    const stack = stackText(app)
    return `<div class="app-cell">
      <span class="app-icon${env.cls === 'net' ? ' icon-net' : ''}" aria-hidden="true">${esc(app.icon || '·')}</span>
      <div class="app-meta">
        <span class="app-name"><span class="env-chip ${env.cls}">${env.label}</span>${esc(app.name)}${version}${pending}</span>
        <span class="app-tags">${kinds}<span class="stack-text"${attr('title', stackTitle(app))}>${esc(stack)}</span></span>
      </div>
    </div>`
  }

  function portCellHtml(app) {
    if (app.appOnly) return '<span class="text-muted" title="该应用无 Web 服务入口">—</span>'
    const url = buildAppUrl(app)
    const extra = app.extraPorts?.length
      ? `<span class="extra-ports mono">+${esc(app.extraPorts.join(', '))}</span>`
      : ''
    const local = app.port && !app.external
      ? '<span class="tag neutral" title="该服务仅监听 127.0.0.1，仅本机可访问">仅本机</span>'
      : ''
    if (hasUrl(app) && url) {
      return `<a class="port-link" href="${esc(url)}" target="_blank" rel="noopener"${attr('title', url)}>:${esc(portText(app))} <span aria-hidden="true">↗</span></a>${extra}${local}`
    }
    return `<span class="port-link muted" title="未监听，不可访问">:${esc(portText(app))}</span>${extra}${local}`
  }

  function dirCellHtml(app) {
    if (app.remote) {
      const text = `${app.location ?? ''} · ${app.host ?? ''}`
      return `<span class="mono dir"${attr('title', text)}>${esc(text)}</span>`
    }
    return `<span class="mono dir copyable" data-copy="${esc(app.directory ?? '')}"` +
      `${attr('title', `${app.directory ?? ''}（点击复制）`)}>${esc(app.directory ?? '')}</span>`
  }

  function gitCellHtml(app) {
    const g = gitView(app.git)
    if (!g) return '<span class="text-muted">—</span>'
    return `<span class="sync-chip ${g.cls}"${attr('title', g.title)}>${esc(g.text)}</span>`
  }

  function renderTable(apps) {
    const reorderable = state.sortKey === 'default'
    const head = `<thead><tr>
      ${reorderable ? '<th class="col-handle" title="拖拽行调整顺序（保存在本浏览器）"></th>' : ''}
      <th class="col-status sortable${state.sortKey === 'status' ? ' on' : ''}" data-sort="status" title="按运行状态排序（再次点击切换方向）">状态${arrowHtml('status')}</th>
      <th class="sortable${state.sortKey === 'name' ? ' on' : ''}" data-sort="name" title="按名称排序（再次点击切换方向）">应用${arrowHtml('name')}</th>
      <th class="col-desc">简介</th>
      <th class="sortable${state.sortKey === 'port' ? ' on' : ''}" data-sort="port" title="按端口排序（再次点击切换方向）">访问地址${arrowHtml('port')}</th>
      <th>服务器 / 目录</th>
      <th class="sortable${state.sortKey === 'git' ? ' on' : ''}" data-sort="git" title="按同步状态排序（未同步的在前，再次点击切换方向）">同步${arrowHtml('git')}</th>
      <th class="col-github">GitHub</th>
    </tr></thead>`

    const rows = apps.map((app) => `<tr data-id="${esc(app.id)}" class="${envInfo(app).cls}${state.dragId === app.id ? ' dragging' : ''}">
      ${reorderable
        ? `<td class="col-handle"><span class="grip" draggable="true" title="按住拖拽调整顺序" aria-label="拖拽调整顺序">
            <svg width="10" height="16" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="4" r="1.8" /><circle cx="11" cy="4" r="1.8" />
              <circle cx="5" cy="10" r="1.8" /><circle cx="11" cy="10" r="1.8" />
              <circle cx="5" cy="16" r="1.8" /><circle cx="11" cy="16" r="1.8" />
            </svg></span></td>`
        : ''}
      <td class="col-status">${badgeHtml(app)}</td>
      <td>${appCellHtml(app)}</td>
      <td class="col-desc"><span class="desc"${attr('title', app.description)}>${esc(app.description)}</span></td>
      <td>${portCellHtml(app)}</td>
      <td>${dirCellHtml(app)}</td>
      <td class="col-sync">${gitCellHtml(app)}</td>
      <td class="col-github">${app.github
        ? `<a href="${esc(app.github)}" target="_blank" rel="noopener" title="查看源码">源码 ↗</a>`
        : '<span class="text-muted">—</span>'}</td>
    </tr>`).join('')

    return `<div class="table-wrap"><table class="app-table">${head}<tbody>${rows}</tbody></table></div>`
  }

  /* ---------- 渲染：卡片（主站 AppCard.vue 同款结构） ---------- */
  function renderCards(apps) {
    const reorderable = state.sortKey === 'default'
    const cards = apps.map((app, idx) => {
      const env = envInfo(app)
      const version = app.remoteInfo?.version
        ? `<span class="tag"${attr('title', remoteHealthTitle(app))}>v${esc(app.remoteInfo.version)}</span>`
        : ''
      const pending = app.pending
        ? '<span class="tag warn" title="请在 scripts/apps.config.json 中补充信息">待补充</span>'
        : ''
      const extra = app.extraPorts?.length
        ? `<span class="mono extra-ports">+${esc(app.extraPorts.join(', '))}</span>`
        : ''
      const ghShort = app.github ? app.github.replace('https://github.com/', '') : ''
      const kinds = kindList(app)
        .map((k) => `<span class="kind-chip ${k.value}" title="应用形式：${esc(k.label)}">${esc(k.label)}</span>`)
        .join('')

      return `<article class="card ${env.cls}${state.dragIdx === idx ? ' dragging' : ''}" data-idx="${idx}">
        <header class="card-head">
          ${reorderable
            ? `<span class="grip" draggable="true" title="按住拖拽调整顺序" aria-label="拖拽调整顺序">
                <svg width="10" height="14" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="4" r="1.8" /><circle cx="11" cy="4" r="1.8" />
                  <circle cx="5" cy="10" r="1.8" /><circle cx="11" cy="10" r="1.8" />
                  <circle cx="5" cy="16" r="1.8" /><circle cx="11" cy="16" r="1.8" />
                </svg></span>`
            : ''}
          <span class="app-icon${env.cls === 'net' ? ' icon-net' : ''}" aria-hidden="true">${esc(app.icon || '·')}</span>
          <div class="card-title">
            <h3><span class="env-chip ${env.cls}">${env.label}</span>${esc(app.name)}${version}${pending}</h3>
            ${badgeHtml(app)}
          </div>
          ${reorderable
            ? `<div class="card-move">
                <button class="mini-btn" type="button" data-move="-1" data-id="${esc(app.id)}" title="上移"${idx === 0 ? ' disabled' : ''}>↑</button>
                <button class="mini-btn" type="button" data-move="1" data-id="${esc(app.id)}" title="下移"${idx === apps.length - 1 ? ' disabled' : ''}>↓</button>
              </div>`
            : ''}
        </header>

        <p class="card-desc">${esc(app.description)}</p>

        <div class="card-facts">
          <div class="fact">
            <span class="fact-label">访问</span>
            <span>${portCellHtml(app)}</span>
          </div>
          <div class="fact">
            <span class="fact-label">${app.remote ? '位置' : '目录'}</span>
            <span>${dirCellHtml(app)}</span>
          </div>
          <div class="fact">
            <span class="fact-label">技术栈</span>
            <span class="stack-text"${attr('title', stackTitle(app))}>${esc(stackText(app)) || '—'}</span>
          </div>
          <div class="fact">
            <span class="fact-label">同步</span>
            <span>${gitCellHtml(app)}</span>
          </div>
          <div class="fact">
            <span class="fact-label">源码</span>
            <span>${app.github
              ? `<a href="${esc(app.github)}" target="_blank" rel="noopener">${esc(ghShort)} ↗</a>`
              : '<span class="text-muted">—</span>'}</span>
          </div>
        </div>

        ${kinds ? `<footer class="card-tags">${kinds}</footer>` : ''}
      </article>`
    }).join('')

    return `<div class="card-grid">${cards}</div>`
  }

  /* ---------- 渲染：内容区 ---------- */
  function renderContent() {
    const box = $('#u-content')

    if (state.loading) {
      box.innerHTML = `<div class="placeholder" aria-busy="true">
        <div class="skeleton-row" style="max-width: 720px; margin-left: auto; margin-right: auto"></div>
        <div class="skeleton-row" style="max-width: 720px; margin-left: auto; margin-right: auto"></div>
        <div class="skeleton-row" style="max-width: 720px; margin-left: auto; margin-right: auto"></div>
      </div>`
      return
    }
    if (state.loadError) {
      box.innerHTML = `<div class="placeholder"><p>${esc(state.loadError)}</p>
        <button class="icon-btn" style="width: auto; padding: 0 16px" data-retry>重试</button></div>`
      return
    }
    const apps = displayApps()
    if (!apps.length) {
      box.innerHTML = '<p class="placeholder">还没有应用，请检查 apps.json</p>'
      return
    }
    box.innerHTML = state.view === 'table' ? renderTable(apps) : renderCards(apps)
  }

  function render() {
    renderContent()

    // 工具栏状态
    $('#u-sort').value = state.sortKey
    $('#u-dirBtn').hidden = state.sortKey === 'default'
    $('#u-dirBtn').textContent = state.sortDir === 1 ? '↑' : '↓'
    $('#u-dirBtn').title = state.sortDir === 1 ? '正序（点击切换倒序）' : '倒序（点击切换正序）'
    $('#u-resetBtn').hidden = !(state.sortKey === 'default' && state.customOrder.length)

    document.querySelectorAll('.segmented button').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === state.view)
    })
  }

  /* ---------- 事件（委托在 #u-content 上） ---------- */
  const content = $('#u-content')

  content.addEventListener('click', (e) => {
    // 表头排序
    const th = e.target.closest('th.sortable')
    if (th) {
      setSort(th.dataset.sort)
      return
    }
    // 卡片上移 / 下移
    const mini = e.target.closest('.mini-btn[data-move]')
    if (mini && !mini.disabled) {
      moveApp(mini.dataset.id, Number(mini.dataset.move))
      return
    }
    // 复制目录
    const dir = e.target.closest('.dir[data-copy]')
    if (dir) {
      copyText(dir.dataset.copy).then((ok) => {
        if (!ok) return
        const original = dir.textContent
        dir.textContent = '✓ 已复制'
        setTimeout(() => {
          dir.textContent = original
        }, 1500)
      })
      return
    }
    // 加载失败重试
    if (e.target.closest('[data-retry]')) {
      fetchApps()
    }
  })

  content.addEventListener('dragstart', (e) => {
    const grip = e.target.closest('.grip')
    if (!grip) return
    const row = grip.closest('tr')
    const card = grip.closest('.card')
    if (row) {
      state.dragId = row.dataset.id
      row.classList.add('dragging')
    } else if (card) {
      state.dragIdx = Number(card.dataset.idx)
      card.classList.add('dragging')
    }
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', row ? row.dataset.id : String(state.dragIdx))
      const ghost = row ?? card
      if (ghost) e.dataTransfer.setDragImage(ghost, 24, 24)
    }
  })

  content.addEventListener('dragend', () => {
    state.dragId = ''
    state.dragIdx = -1
    content.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'))
  })

  content.addEventListener('dragover', (e) => {
    if (state.dragId || state.dragIdx >= 0) e.preventDefault()
  })

  content.addEventListener('drop', (e) => {
    if (state.dragId) {
      const row = e.target.closest('tr[data-id]')
      const from = state.dragId
      state.dragId = ''
      content.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'))
      if (row && row.dataset.id !== from) onDropRow(from, row.dataset.id)
    } else if (state.dragIdx >= 0) {
      const card = e.target.closest('.card')
      const from = state.dragIdx
      state.dragIdx = -1
      content.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'))
      if (card) onDropCard(from, Number(card.dataset.idx))
    }
  })

  /* ---------- 工具栏 ---------- */
  $('#u-sort').addEventListener('change', (e) => {
    state.sortKey = e.target.value
    state.sortDir = 1
    render()
  })

  $('#u-dirBtn').addEventListener('click', () => {
    state.sortDir = -state.sortDir
    render()
  })

  $('#u-resetBtn').addEventListener('click', () => {
    state.customOrder = []
    try {
      localStorage.removeItem(ORDER_KEY)
    } catch { /* 忽略 */ }
    render()
  })

  document.querySelectorAll('.segmented button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view
      state.viewPicked = true
      render()
    })
  })

  /* ---------- 立刻同步 ---------- */
  function waitForProbe(after) {
    return new Promise((resolve) => {
      let tries = 0
      const timer = setInterval(async () => {
        tries++
        try {
          const r = await fetch(`../apps.json?t=${Date.now()}`, { cache: 'no-store' })
          const d = await r.json()
          if (d.probedAt && new Date(d.probedAt).getTime() > after) {
            clearInterval(timer)
            resolve(true)
            return
          }
        } catch { /* 下一轮再试 */ }
        if (tries >= 90) {
          clearInterval(timer)
          resolve(false)
        }
      }, 2000)
    })
  }

  $('#u-sync').addEventListener('click', async () => {
    if (state.syncing) return
    state.syncing = true
    const btn = $('#u-sync')
    const errEl = $('#u-syncError')
    btn.disabled = true
    btn.classList.add('syncing')
    $('#u-syncText').textContent = '同步中…'
    errEl.hidden = true
    try {
      const res = await fetch('/api/probe', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      // 用服务端返回的 startedAt 比较，避免浏览器与服务器时钟偏差
      const startedAt = data.startedAt ?? Date.now()
      const done = await waitForProbe(startedAt)
      await fetchApps(true)
      if (!done) {
        errEl.textContent = '同步超时，请稍后刷新查看'
        errEl.hidden = false
      }
    } catch (err) {
      errEl.textContent = `同步失败：${err.message}`
      errEl.hidden = false
    } finally {
      state.syncing = false
      btn.disabled = false
      btn.classList.remove('syncing')
      $('#u-syncText').textContent = '立刻同步'
    }
  })

  /* ---------- 顶栏 ---------- */
  $('#u-themeBtn').addEventListener('click', toggleTheme)

  /* ---------- 启动 ---------- */
  syncThemeBtn()
  applyDefaultView()
  narrowMql.addEventListener('change', applyDefaultView)
  renderPageText()
  render()
  fetchApps()

  setInterval(() => fetchApps(true), POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchApps(true)
  })
})()
