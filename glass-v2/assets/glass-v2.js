/* ============================================================
   /glass-v2/ 毛玻璃对比版 · 应用导航 + 监控中心（同页切换）
   数据源与主站一致：apps.json（60s）+ /api/monitor/*（5s）
   会话 Cookie 与主站共享 —— 主站登录过此处自动鉴权
   ============================================================ */
;(function () {
  'use strict'

  /* ============================ 小工具 ============================ */
  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => [...document.querySelectorAll(sel)]

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }
  const attr = (name, value) => (value ? ` ${name}="${esc(value)}"` : '')

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true } catch { /* 回退 */ }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    ta.remove()
    return ok
  }
  function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 忽略 */ } }
  function load(key) {
    try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : [] } catch { return [] }
  }

  const fmtMb = (v) => (v == null || !isFinite(v) ? '-' : v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v.toFixed(0) + ' MB')
  const fmtMbs = (v) => (v == null || !isFinite(v) ? '-' : v >= 100 ? v.toFixed(0) : v.toFixed(2))
  const fmtPct = (v) => (v == null || !isFinite(v) ? '-' : v.toFixed(v >= 10 ? 0 : 1))
  const fmtUptime = (s) => {
    if (!s && s !== 0) return '-'
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
    return d ? `${d} 天 ${h} 时` : h ? `${h} 时 ${m} 分` : `${m} 分`
  }
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  function tickNum(el, to, fmt) {
    const target = Number(to)
    if (!isFinite(target)) { el.textContent = '-'; return }
    const from = parseFloat(el.dataset.v ?? target) || 0
    el.dataset.v = target
    if (reducedMotion || Math.abs(target - from) < 0.005) { el.textContent = fmt(target); return }
    cancelAnimationFrame(el._raf)
    const t0 = performance.now()
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 260), e = 1 - Math.pow(1 - k, 3)
      el.textContent = fmt(from + (target - from) * e)
      if (k < 1) el._raf = requestAnimationFrame(step)
    }
    el._raf = requestAnimationFrame(step)
  }

  /* ============================ 主题 ============================ */
  const root = document.documentElement
  const isDark = () => root.dataset.theme === 'dark'
  $('#gv-theme').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark'
    root.dataset.theme = next
    try { localStorage.setItem('gv2:theme', next) } catch { /* 忽略 */ }
    monitorModule.onThemeChange()
  })

  /* ============================ 视图切换 ============================ */
  const tabApps = $('#gv-tab-apps')
  const tabMonitor = $('#gv-tab-monitor')
  const viewApps = $('#gv-view-apps')
  const viewMonitor = $('#gv-view-monitor')

  function switchView(v) {
    const monitor = v === 'monitor'
    tabApps.classList.toggle('is-active', !monitor)
    tabMonitor.classList.toggle('is-active', monitor)
    tabApps.setAttribute('aria-selected', String(!monitor))
    tabMonitor.setAttribute('aria-selected', String(monitor))
    viewApps.hidden = monitor
    viewMonitor.hidden = !monitor
    try { localStorage.setItem('gv2:view', v) } catch { /* 忽略 */ }
    history.replaceState(null, '', monitor ? '#monitor' : location.pathname)
    if (monitor) monitorModule.activate()
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })
  }
  tabApps.addEventListener('click', () => switchView('apps'))
  tabMonitor.addEventListener('click', () => switchView('monitor'))

  /* ============================================================
     模块 A：我的应用（逻辑与主站一致，来自 /unslop/ 成熟实现）
     ============================================================ */
  const apps = (() => {
    const ORDER_KEY = 'gv2:appOrder'
    const POLL_MS = 60_000

    function buildAppUrl(app) {
      if (app.url) return app.url
      const port = app.port
      if (!port) return ''
      return `${app.https ? 'https' : 'http'}://${window.location.hostname || 'localhost'}:${port}`
    }
    const portText = (app) => app.port ?? app.expectedPort ?? '—'
    function formatUptime(sec) {
      if (!Number.isFinite(sec) || sec <= 0) return ''
      const d = Math.floor(sec / 86400), h = Math.floor((sec % 3600) / 3600), m = Math.floor((sec % 3600) / 60)
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
    function statusInfo(app) {
      if (app.appOnly) return { text: '离线应用', cls: 'offline', title: '离线应用：纯 APP / 小程序，无 Web 服务，不做端口探测' }
      if (app.status === 'running') return { text: '运行中', cls: 'ok', title: remoteHealthTitle(app) }
      return { text: '未运行', cls: 'down', title: remoteHealthTitle(app) }
    }
    const KIND_LABELS = { web: 'Web', app: 'APP', miniapp: '小程序', tv: '电视', cli: 'CLI' }
    function kindList(app) {
      const list = Array.isArray(app.kinds) && app.kinds.length ? app.kinds : app.appOnly ? ['app'] : ['web']
      return list.filter((k) => KIND_LABELS[k]).map((value) => ({ value, label: KIND_LABELS[value] }))
    }
    function stackText(app) {
      return [(app.languages ?? []).join('/'), (app.frontend ?? []).join(' + '), (app.backend ?? []).join(' + ')].filter(Boolean).join(' · ')
    }
    function stackTitle(app) {
      const parts = []
      if (app.languages?.length) parts.push(`语言：${app.languages.join('、')}`)
      if (app.frontend?.length) parts.push(`前端：${app.frontend.join('、')}`)
      if (app.backend?.length) parts.push(`后端：${app.backend.join('、')}`)
      return parts.join('；')
    }
    const isPublic = (app) => (app.env ? app.env === 'public' : Boolean(app.remote))
    function envInfo(app) { return isPublic(app) ? { cls: 'net', label: '公网' } : { cls: 'lan', label: '内网' } }
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

    const state = {
      apps: [],
      page: { siteName: '我的应用导航', heroTitle: '应用中心', heroSubtitle: '部署在这台服务器上的个人项目，端口与运行状态由服务端定时自动探测。' },
      probedAt: '', loading: true, loadError: '',
      sortKey: 'default', sortDir: 1,
      customOrder: load(ORDER_KEY),
      view: 'table', viewPicked: false,
      syncing: false, dragId: '', dragIdx: -1,
    }

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
      if (state.sortKey !== 'default') list.sort((a, b) => compareApps(a, b) * state.sortDir)
      else if (state.customOrder.length) {
        const rank = new Map(state.customOrder.map((id, i) => [id, i]))
        list.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
      }
      return list
    }
    function setSort(key) {
      if (key !== 'default' && state.sortKey === key) state.sortDir = -state.sortDir
      else { state.sortKey = key; state.sortDir = 1 }
      render()
    }
    function moveApp(id, delta) {
      const ids = displayApps().map((a) => a.id)
      const i = ids.indexOf(id), j = i + delta
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
      const list = displayApps()
      if (fromIdx < 0 || fromIdx === targetIdx || fromIdx >= list.length) return
      const ids = list.map((a) => a.id)
      const [movedId] = ids.splice(fromIdx, 1)
      ids.splice(targetIdx > fromIdx ? targetIdx - 1 : targetIdx, 0, movedId)
      state.customOrder = ids
      store(ORDER_KEY, ids)
      render()
    }

    async function fetchApps(silent = false) {
      if (!silent) { state.loading = true; state.loadError = ''; render() }
      try {
        const res = await fetch(`/apps.json?t=${Date.now()}`, { cache: 'no-store' })
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

    const narrowMql = window.matchMedia('(max-width: 760px)')
    function applyDefaultView() {
      if (!state.viewPicked) { state.view = narrowMql.matches ? 'card' : 'table'; render() }
    }
    narrowMql.addEventListener?.('change', applyDefaultView)

    function renderPageText() {
      document.title = (state.page.siteName || '我的应用导航') + ' · 毛玻璃 v2'
      $('#gv-hero-title').textContent = state.page.heroTitle
      $('#gv-hero-sub').textContent = state.page.heroSubtitle
      $('#gv-site-foot').textContent = state.page.siteName
      $('#gv-year').textContent = new Date().getFullYear()
      let probedLine = ''
      if (state.probedAt) {
        const t = new Date(state.probedAt).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
        probedLine = `最后探测 ${t}（北京时间）· 端口每 3 分钟 · git 每 5 分钟`
      }
      $('#gv-probe-text').textContent = probedLine

      const list = state.apps
      const running = list.filter((a) => a.status === 'running').length
      const lan = list.filter((a) => !isPublic(a)).length
      const net = list.filter((a) => isPublic(a)).length
      const unsynced = list.filter((a) => a.git && a.git.status !== 'synced').length
      tickNum($('#gv-count-apps'), list.length, (v) => String(Math.round(v)))
      tickNum($('#gv-count-running'), running, (v) => String(Math.round(v)))
      $('#gv-run-dot').style.background = running ? 'var(--gv-green)' : 'var(--gv-text-3)'
      $('#gv-run-dot').classList.toggle('is-live', running > 0)
      tickNum($('#gv-count-lan'), lan, (v) => String(Math.round(v)))
      tickNum($('#gv-count-public'), net, (v) => String(Math.round(v)))
      $('#gv-git-dot').style.background = unsynced ? 'var(--gv-amber)' : 'var(--gv-green)'
      $('#gv-git-dot').classList.toggle('is-live', !unsynced)
      $('#gv-git-text').textContent = unsynced ? `${unsynced} 个源码未同步` : '源码全部已同步'
    }

    const arrowHtml = (key) => (state.sortKey !== key ? '' : `<span class="gv-arrow">${state.sortDir === 1 ? '▲' : '▼'}</span>`)

    function badgeHtml(app) {
      const s = statusInfo(app)
      return `<span class="gv-status ${s.cls}"${attr('title', s.title)}><span class="gv-dot${s.cls === 'ok' ? ' is-live' : ''}" style="background:currentColor"></span>${esc(s.text)}</span>`
    }
    function appCellHtml(app) {
      const env = envInfo(app)
      const version = app.remoteInfo?.version ? `<span class="gv-kind-chip"${attr('title', remoteHealthTitle(app))}>v${esc(app.remoteInfo.version)}</span>` : ''
      const pending = app.pending ? '<span class="gv-kind-chip" style="color:var(--gv-amber)" title="请在 scripts/apps.config.json 中补充信息">待补充</span>' : ''
      const kinds = kindList(app).map((k) => `<span class="gv-kind-chip k-${k.value}" title="应用形式：${esc(k.label)}">${esc(k.label)}</span>`).join('')
      const stack = stackText(app)
      return `<div class="gv-appcell">
        <span class="gv-appicon ${env.cls === 'net' ? 'public' : 'lan'}" aria-hidden="true">${esc(app.icon || '·')}</span>
        <div>
          <div class="gv-appname"><span class="gv-env-chip ${env.cls === 'net' ? 'public' : 'lan'}">${env.label}</span>${esc(app.name)}${version}${pending}</div>
          <div class="gv-stack"${attr('title', stackTitle(app))}>${kinds}<span${kinds ? ' style="margin-left:6px"' : ''}>${esc(stack)}</span></div>
        </div>
      </div>`
    }
    function portCellHtml(app) {
      if (app.appOnly) return `<span class="gv-hint" title="该应用无 Web 服务入口">—</span>`
      const url = buildAppUrl(app)
      const extra = app.extraPorts?.length ? `<span class="gv-num gv-hint">+${esc(app.extraPorts.join(', '))}</span>` : ''
      const local = app.port && !app.external ? `<span class="gv-kind-chip" title="该服务仅监听 127.0.0.1，仅本机可访问">仅本机</span>` : ''
      if (app.port && url) return `<a class="gv-portlink" href="${esc(url)}" target="_blank" rel="noopener"${attr('title', url)}>:${esc(portText(app))} ↗</a>${extra}${local}`
      return `<span class="gv-portlink" style="color:var(--gv-text-3)" title="未监听，不可访问">:${esc(portText(app))}</span>${extra}${local}`
    }
    function dirCellHtml(app) {
      if (app.remote) {
        const text = `${app.location ?? ''} · ${app.host ?? ''}`
        return `<span class="gv-num" style="font-size:12px;color:var(--gv-text-2)"${attr('title', text)}>${esc(text)}</span>`
      }
      return `<span class="gv-dirlink" data-copy="${esc(app.directory ?? '')}"${attr('title', `${app.directory ?? ''}（点击复制）`)}>${esc(app.directory ?? '')}</span>`
    }
    function gitCellHtml(app) {
      const g = gitView(app.git)
      if (!g) return `<span class="gv-hint">—</span>`
      return `<span class="gv-git-chip ${g.cls}"${attr('title', g.title)}>${esc(g.text)}</span>`
    }
    function rowAccent(app) {
      if (app.appOnly) return 'var(--gv-text-3)'
      return isPublic(app) ? 'var(--gv-amber)' : 'var(--gv-accent)'
    }

    function renderTable(list) {
      const reorderable = state.sortKey === 'default'
      $('#gv-thead').innerHTML = `<tr>
        ${reorderable ? '<th style="width:28px" title="拖拽行调整顺序（保存在本浏览器）"></th>' : ''}
        <th class="gv-sortable${state.sortKey === 'status' ? ' is-on' : ''}" data-sort="status" title="按运行状态排序（再次点击切换方向）">状态${arrowHtml('status')}</th>
        <th class="gv-sortable${state.sortKey === 'name' ? ' is-on' : ''}" data-sort="name" title="按名称排序（再次点击切换方向）">应用${arrowHtml('name')}</th>
        <th>简介</th>
        <th class="gv-sortable${state.sortKey === 'port' ? ' is-on' : ''}" data-sort="port" title="按端口排序（再次点击切换方向）">访问地址${arrowHtml('port')}</th>
        <th>服务器 / 目录</th>
        <th class="gv-sortable${state.sortKey === 'git' ? ' is-on' : ''}" data-sort="git" title="按同步状态排序（未同步的在前，再次点击切换方向）">同步${arrowHtml('git')}</th>
        <th>GitHub</th>
      </tr>`
      $('#gv-tbody').innerHTML = list.map((app) => `<tr data-id="${esc(app.id)}" style="--row-accent:${rowAccent(app)}" class="${state.dragId === app.id ? 'gv-dragging' : ''}">
        ${reorderable ? `<td><span class="gv-drag-handle" draggable="true" title="按住拖拽调整顺序" aria-label="拖拽调整顺序">
          <svg width="10" height="16" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1.8"/><circle cx="11" cy="4" r="1.8"/><circle cx="5" cy="10" r="1.8"/><circle cx="11" cy="10" r="1.8"/><circle cx="5" cy="16" r="1.8"/><circle cx="11" cy="16" r="1.8"/></svg></span></td>` : ''}
        <td>${badgeHtml(app)}</td>
        <td>${appCellHtml(app)}</td>
        <td><span class="gv-desc"${attr('title', app.description)}>${esc(app.description)}</span></td>
        <td>${portCellHtml(app)}</td>
        <td>${dirCellHtml(app)}</td>
        <td>${gitCellHtml(app)}</td>
        <td>${app.github ? `<a href="${esc(app.github)}" target="_blank" rel="noopener" title="查看源码">源码 ↗</a>` : `<span class="gv-hint">—</span>`}</td>
      </tr>`).join('')

      if (reorderable) {
        $$('#gv-tbody .gv-drag-handle').forEach((grip) => {
          grip.addEventListener('dragstart', (e) => {
            state.dragId = grip.closest('tr').dataset.id
            grip.closest('tr').classList.add('gv-dragging')
            e.dataTransfer.effectAllowed = 'move'
            try { e.dataTransfer.setData('text/plain', state.dragId) } catch { /* 忽略 */ }
          })
          grip.addEventListener('dragend', () => { state.dragId = ''; render() })
        })
        $$('#gv-tbody tbody tr, #gv-tbody tr').forEach((tr) => {
          tr.addEventListener('dragover', (e) => e.preventDefault())
          tr.addEventListener('drop', (e) => { e.preventDefault(); onDropRow(state.dragId, tr.dataset.id) })
        })
      }
      $$('#gv-thead .gv-sortable').forEach((th) => th.addEventListener('click', () => setSort(th.dataset.sort)))
    }

    function renderCards(list) {
      const reorderable = state.sortKey === 'default'
      $('#gv-cards').innerHTML = list.map((app, idx) => {
        const env = envInfo(app)
        const version = app.remoteInfo?.version ? `<span class="gv-kind-chip"${attr('title', remoteHealthTitle(app))}>v${esc(app.remoteInfo.version)}</span>` : ''
        const pending = app.pending ? '<span class="gv-kind-chip" style="color:var(--gv-amber)">待补充</span>' : ''
        const ghShort = app.github ? app.github.replace('https://github.com/', '') : ''
        const kinds = kindList(app).map((k) => `<span class="gv-kind-chip k-${k.value}" title="应用形式：${esc(k.label)}">${esc(k.label)}</span>`).join('')
        return `<article class="gv-card gv-enter" data-idx="${idx}" style="--row-accent:${rowAccent(app)}">
          <div class="gv-card-top">
            ${reorderable ? `<span class="gv-drag-handle" draggable="true" title="按住拖拽调整顺序" aria-label="拖拽调整顺序">
              <svg width="10" height="14" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1.8"/><circle cx="11" cy="4" r="1.8"/><circle cx="5" cy="10" r="1.8"/><circle cx="11" cy="10" r="1.8"/><circle cx="5" cy="16" r="1.8"/><circle cx="11" cy="16" r="1.8"/></svg></span>` : ''}
            <span class="gv-appicon ${env.cls === 'net' ? 'public' : 'lan'}" aria-hidden="true">${esc(app.icon || '·')}</span>
            <div style="min-width:0">
              <div class="gv-card-name"><span class="gv-env-chip ${env.cls === 'net' ? 'public' : 'lan'}">${env.label}</span>${esc(app.name)}${version}${pending}</div>
              ${badgeHtml(app)}
            </div>
            ${reorderable ? `<div class="gv-updown" style="margin-left:auto">
              <button type="button" class="gv-minibtn" data-move="-1" data-id="${esc(app.id)}" title="上移"${idx === 0 ? ' disabled' : ''}>↑</button>
              <button type="button" class="gv-minibtn" data-move="1" data-id="${esc(app.id)}" title="下移"${idx === list.length - 1 ? ' disabled' : ''}>↓</button>
            </div>` : ''}
          </div>
          <p class="gv-desc" style="max-width:none;margin:0 0 10px">${esc(app.description)}</p>
          <div class="gv-facts">
            <div class="gv-fact"><span>访问</span><span>${portCellHtml(app)}</span></div>
            <div class="gv-fact"><span>${app.remote ? '位置' : '目录'}</span><span>${dirCellHtml(app)}</span></div>
            <div class="gv-fact"><span>技术栈</span><span class="gv-stack" style="-webkit-line-clamp:1"${attr('title', stackTitle(app))}>${esc(stackText(app)) || '—'}</span></div>
            <div class="gv-fact"><span>同步</span><span>${gitCellHtml(app)}</span></div>
            <div class="gv-fact"><span>源码</span><span>${app.github ? `<a href="${esc(app.github)}" target="_blank" rel="noopener">${esc(ghShort)} ↗</a>` : `<span class="gv-hint">—</span>`}</span></div>
          </div>
          ${kinds ? `<div class="gv-card-foot" style="border-top:0;padding-top:6px">${kinds}</div>` : ''}
        </article>`
      }).join('')

      if (reorderable) {
        $$('#gv-cards .gv-drag-handle').forEach((grip) => {
          grip.addEventListener('dragstart', (e) => { state.dragIdx = +grip.closest('.gv-card').dataset.idx; e.dataTransfer.effectAllowed = 'move' })
          grip.addEventListener('dragend', () => { state.dragIdx = -1; render() })
        })
        $$('#gv-cards .gv-card').forEach((card) => {
          card.addEventListener('dragover', (e) => e.preventDefault())
          card.addEventListener('drop', (e) => { e.preventDefault(); onDropCard(state.dragIdx, +card.dataset.idx) })
        })
        $$('#gv-cards [data-move]').forEach((btn) => btn.addEventListener('click', () => moveApp(btn.dataset.id, +btn.dataset.move)))
      }
      $$('#gv-cards .gv-dirlink[data-copy]').forEach((el) => el.addEventListener('click', async () => {
        const ok = await copyText(el.dataset.copy)
        const old = el.title
        el.title = ok ? '已复制 ✓' : '复制失败'
        setTimeout(() => { el.title = old }, 1200)
      }))
    }

    function render() {
      const loading = $('#gv-loading'), errBox = $('#gv-error'), empty = $('#gv-empty')
      const tableWrap = $('#gv-table-wrap'), cards = $('#gv-cards')
      if (state.loading) {
        loading.hidden = false; errBox.hidden = true; empty.hidden = true; tableWrap.hidden = true; cards.hidden = true
        return
      }
      loading.hidden = true
      if (state.loadError) { errBox.hidden = false; $('#gv-error-text').textContent = state.loadError; tableWrap.hidden = true; cards.hidden = true; return }
      errBox.hidden = true
      const list = displayApps()
      if (!list.length) { empty.hidden = false; tableWrap.hidden = true; cards.hidden = true; return }
      empty.hidden = true
      if (state.view === 'table') { tableWrap.hidden = false; cards.hidden = true; renderTable(list) }
      else { tableWrap.hidden = true; cards.hidden = false; renderCards(list) }
      $('#gv-sort').value = state.sortKey
      $('#gv-sort-dir').hidden = state.sortKey === 'default'
      $('#gv-sort-dir').textContent = state.sortDir === 1 ? '↑' : '↓'
      $('#gv-reset-order').hidden = !(state.sortKey === 'default' && state.customOrder.length)
    }

    $('#gv-sort').addEventListener('change', (e) => setSort(e.target.value))
    $('#gv-sort-dir').addEventListener('click', () => { state.sortDir = -state.sortDir; render() })
    $('#gv-reset-order').addEventListener('click', () => { state.customOrder = []; store(ORDER_KEY, []); render() })
    $$('.gv-segmented button').forEach((btn) => btn.addEventListener('click', () => {
      state.view = btn.dataset.view
      state.viewPicked = true
      $$('.gv-segmented button').forEach((b) => { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-selected', String(b === btn)) })
      render()
    }))
    $('#gv-retry').addEventListener('click', () => fetchApps())
    $('#gv-tbody').addEventListener('click', async (e) => {
      const copyEl = e.target.closest('[data-copy]')
      if (copyEl) {
        const ok = await copyText(copyEl.dataset.copy)
        const old = copyEl.title
        copyEl.title = ok ? '已复制 ✓' : '复制失败'
        setTimeout(() => { copyEl.title = old }, 1200)
      }
    })

    /* 立刻同步 */
    $('#gv-sync').addEventListener('click', async () => {
      if (state.syncing) return
      state.syncing = true
      const btn = $('#gv-sync'), label = $('#gv-sync-label'), errEl = $('#gv-sync-error')
      btn.disabled = true
      label.textContent = '同步中…'
      errEl.hidden = true
      const startedAt = new Date().toISOString()
      try {
        await fetch('/api/probe', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        let n = 0
        const timer = setInterval(async () => {
          n += 1
          try {
            const res = await fetch(`/apps.json?t=${Date.now()}`, { cache: 'no-store' })
            const data = await res.json()
            if (data.probedAt && data.probedAt > startedAt) {
              clearInterval(timer)
              state.apps = data.apps ?? []
              state.probedAt = data.probedAt ?? ''
              renderPageText()
              render()
              state.syncing = false
              btn.disabled = false
              label.textContent = '立刻同步'
              return
            }
          } catch { /* 继续等 */ }
          if (n > 90) { clearInterval(timer); state.syncing = false; btn.disabled = false; label.textContent = '立刻同步' }
        }, 2000)
      } catch (e) {
        errEl.textContent = `触发失败：${e.message}`
        errEl.hidden = false
        state.syncing = false
        btn.disabled = false
        label.textContent = '立刻同步'
      }
    })

    let pollTimer = null
    function startPoll() { if (pollTimer) return; pollTimer = setInterval(() => fetchApps(true), POLL_MS) }

    return {
      boot() { applyDefaultView(); fetchApps(); startPoll() },
      refresh() { return fetchApps(true) },
    }
  })()

  /* ============================================================
     模块 B：监控中心（API 与主站一致；会话 Cookie 共享）
     ============================================================ */
  const monitorModule = (() => {
    const state = {
      summary: null, detailHost: null, range: '1h', dirMetric: 'mem',
      dirFilter: '', compareSet: new Set(), seededDirs: new Set(),
      charts: {}, procsCache: [], procsTotal: 0, dirsList: [],
      entered: false, timer: null, histTimer: null, cfg: null,
    }

    async function api(path, opts = {}) {
      const res = await fetch(path, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: 'same-origin',
      })
      if (res.status === 401) { showLogin(); throw new Error('未登录') }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    /* ---------- 登录 ---------- */
    function showLogin() { stopPoll(); $('#gv-login').hidden = false; setTimeout(() => $('#gv-login-pw').focus(), 50) }
    $('#gv-login-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = $('#gv-login-btn')
      btn.disabled = true
      try {
        await api('/api/monitor/login', { method: 'POST', body: { password: $('#gv-login-pw').value } })
        $('#gv-login-err').textContent = ''
        $('#gv-login').hidden = true
        $('#gv-login-pw').value = ''
        boot()
      } catch (err) {
        $('#gv-login-err').textContent = err.message === '未登录' ? '密码错误' : err.message
      } finally { btn.disabled = false }
    })

    /* ---------- 轮询（仅监控视图激活时） ---------- */
    function startPoll() {
      stopPoll()
      state.timer = setInterval(refreshSummary, 5000)
    }
    function stopPoll() { if (state.timer) { clearInterval(state.timer); state.timer = null } }

    async function refreshSummary() {
      if (document.hidden || viewMonitor.hidden) return
      try {
        state.summary = await api('/api/monitor/summary')
        if (!viewMonitor.hidden) { renderOverview(); renderAlerts() }
      } catch (e) { /* 401 已处理；其余静默重试 */ }
    }

    let booted = false
    function boot() {
      if (booted) { startPoll(); refreshSummary(); return }
      booted = true
      api('/api/monitor/summary').then((s) => {
        state.summary = s
        renderOverview(); renderAlerts()
        startPoll()
        return api('/api/monitor/config')
      }).then((c) => {
        state.cfg = c
        $('#gv-m-foot-retain').textContent = (c.collect?.retentionDays ?? 7) + ' 天'
      }).catch(() => { /* 401 → 登录层已显示 */ })
    }

    /* ---------- 概览 ---------- */
    function hostName(id) { const h = state.summary?.hosts.find((x) => x.id === id); return h ? h.name : id }
    function isPublicGroup(g) { return /公网|public/i.test(g || '') }
    function dotCls(h) { return h.online ? 'ok' : (h.credReady ? 'err' : 'off') }
    function gauges(h) {
      const s = h.snap || {}
      const worst = (s.disks || []).filter((d) => d.pct != null).sort((a, b) => b.pct - a.pct)[0]
      return [
        { cap: 'CPU', v: s.cpu?.pct },
        { cap: '内存', v: s.mem?.pct },
        { cap: '磁盘', v: worst?.pct, title: worst ? `${worst.mnt} ${worst.pct}%` : '' },
      ]
    }
    const gaugeCls = (v) => { const x = Number(v); return !isFinite(x) ? '' : x >= 88 ? 'crit' : x >= 70 ? 'warn' : '' }

    function renderOverview() {
      const s = state.summary
      if (!s) return
      const hosts = s.hosts
      const online = hosts.filter((h) => h.online).length
      tickNum($('#gv-m-hosts'), online, (v) => `${Math.round(v)}/${hosts.length}`)
      $('#gv-m-host-dot').style.background = online === hosts.length && hosts.length ? 'var(--gv-green)' : 'var(--gv-amber)'
      const alerts = s.alerts || []
      $('#gv-m-alert-chip').hidden = alerts.length === 0
      tickNum($('#gv-m-alerts'), alerts.length, (v) => String(Math.round(v)))
      let dirMax = 0
      hosts.forEach((h) => { if (h.online && h.snap) dirMax = Math.max(dirMax, (h.snap.dirs || []).length) })
      $('#gv-m-dirs').textContent = dirMax || 0
      $('#gv-m-containers').textContent = hosts.reduce((a, h) => a + (h.online && h.snap ? h.snap.containersCount || 0 : 0), 0)
      $('#gv-m-updated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })
      $('#gv-m-foot-time').textContent = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })

      const groups = new Map()
      hosts.forEach((h) => { if (!groups.has(h.group)) groups.set(h.group, []); groups.get(h.group).push(h) })
      const wrap = $('#gv-m-hosts-wrap')
      if (!state.entered) {
        wrap.innerHTML = '<div class="gv-skeleton" style="max-width:760px"></div>'
        state.entered = true
        setTimeout(() => { if (state.summary) renderOverview() }, 150)
        return
      }
      wrap.innerHTML = ''
      for (const [group, list] of groups) {
        const g = document.createElement('div')
        g.className = 'gv-enter'
        g.innerHTML = `<div class="gv-group-head"><span class="gv-dot${isPublicGroup(group) ? ' pub' : ''}" style="background:currentColor"></span>${esc(group)}
          <span class="gv-sub">${list.filter((h) => h.online).length}/${list.length} 在线</span></div>
          <div class="gv-host-grid">${list.map((h) => hostCardHtml(h)).join('')}</div>`
        wrap.appendChild(g)
      }
      $$('.gv-host-card', wrap || document).forEach((card) => {
        card.addEventListener('click', (e) => { if (e.target.closest('button')) return; toggleDetail(card.dataset.host) })
        const t = card.querySelector('[data-term]')
        if (t) t.addEventListener('click', () => openTerm(card.dataset.host))
        const d = card.querySelector('[data-detail]')
        if (d) d.addEventListener('click', () => toggleDetail(card.dataset.host))
      })
      // 仪表环数值过渡（CSS 自定义属性注册见下）
      $$('.gv-gauge').forEach((el) => { el.style.setProperty('--v', el.dataset.v || 0) })
    }

    function hostCardHtml(h) {
      const pub = isPublicGroup(h.group)
      const sn = h.snap
      const online = h.online && sn && sn.online
      let body = ''
      if (!h.credReady) body = `<div class="hc-offline"><p>待配置凭据：${esc(h.note || '在监控设置中添加密钥或密码后自动开始采集')}</p></div>`
      else if (!online) body = `<div class="hc-offline"><p>采集中 / 未连通：${esc(h.error || '等待首个探测周期')}</p>
        <button type="button" class="gv-minibtn" data-term>⌨ 仍要连接</button></div>`
      else {
        body = `
          <div class="hc-main">
            <div class="hc-gauges">
              ${gauges(h).map((g) => `<div class="gv-gauge${gaugeCls(g.v)}" data-v="${isFinite(+g.v) ? +g.v : 0}"${attr('title', g.title || g.cap)}>
                <span class="gv-gval">${fmtPct(g.v)}<i>%</i></span><span class="gv-gcap">${esc(g.cap)}</span></div>`).join('')}
            </div>
            <div class="hc-stats">
              <div><span>负载</span><b>${sn.cpu?.load1 ?? '-'} <i>/ ${sn.cpu?.loadPerCore ?? '-'} 核</i></b></div>
              <div><span>网络</span><b>↑ ${fmtMbs(sn.net?.outMbs)} <i>↓ ${fmtMbs(sn.net?.inMbs)} Mbps</i></b></div>
              <div><span>运行</span><b>${fmtUptime(sn.uptimeSec)}</b></div>
            </div>
          </div>
          <div class="hc-foot">
            <span class="gv-hint">跟踪 ${(sn.dirs || []).length} 目录<template></template>${sn.containersCount ? ` · 容器 ${sn.containersCount}` : ''}</span>
            <span class="gv-grow"></span>
            <button type="button" class="gv-minibtn" data-detail>${state.detailHost === h.id ? '收起' : '详情'}</button>
            <button type="button" class="gv-minibtn" data-term>⌨ 终端</button>
          </div>`
      }
      return `<article class="gv-host-card gv-enter${pub ? ' public' : ''}${online ? '' : ' offline'}${state.detailHost === h.id ? ' selected' : ''}" data-host="${esc(h.id)}">
        <div class="hc-top">
          <span class="gv-dot ${dotCls(h)}" style="background:${h.online ? 'var(--gv-green)' : h.credReady ? 'var(--gv-red)' : 'var(--gv-text-3)'}"${h.credReady && !h.online ? ' data-live' : ''}></span>
          <span class="hc-name">${esc(h.name)}</span>
          <span class="gv-env-chip ${pub ? 'public' : 'lan'}">${esc(h.group)}</span>
          <span class="hc-addr">${esc(h.address || '')}</span>
        </div>
        <div class="hc-os">${esc((sn && sn.os) || (h.credReady ? '' : 'SSH 凭据待配置'))}</div>
        ${body}
      </article>`
    }

    /* ---------- 告警 ---------- */
    function renderAlerts() {
      const alerts = state.summary?.alerts || []
      const banner = $('#gv-m-alert-banner')
      const section = $('#gv-m-alerts-section')
      if (!alerts.length) { banner.hidden = true; section.hidden = true; return }
      section.hidden = false
      banner.hidden = false
      banner.innerHTML = alerts.map((a) => `
        <div class="gv-alert-item${a.level === 'warn' ? ' warn' : ''}">
          <span class="gv-dot gv-dot--alert" style="background:currentColor"></span>
          <b>${esc(a.label)}</b>
          <span class="gv-sub">阈值 ${esc(a.threshold)} · ${esc(hostName(a.hostId))} · 自 ${esc(new Date(a.activeTs).toLocaleTimeString('zh-CN', { hour12: false }))}</span>
        </div>`).join('')
    }

    /* ---------- 详情 ---------- */
    function toggleDetail(hostId) {
      state.detailHost = state.detailHost === hostId ? '' : hostId
      state.dirFilter = ''
      state.compareSet.clear()
      state.seededDirs.clear() // 换主机：目录集不同，重新默认全选
      const host = state.summary?.hosts.find((x) => x.id === hostId)
      const detail = $('#gv-m-detail')
      detail.hidden = !state.detailHost
      if (state.detailHost && host) {
        $('#gv-m-detail-name').textContent = host.name
        $('#gv-m-detail-bar').className = 'gv-detail-bar' + (isPublicGroup(host.group) ? ' public' : '')
        $$('#gv-m-range button').forEach((b) => b.classList.toggle('is-on', b.dataset.r === '1h'))
        state.range = '1h'
        loadDetail()
        detail.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
      }
      renderOverview()
    }
    $('#gv-m-close-detail').addEventListener('click', () => { state.detailHost = ''; $('#gv-m-detail').hidden = true; renderOverview() })
    $$('#gv-m-range button').forEach((b) => b.addEventListener('click', () => {
      $$('#gv-m-range button').forEach((x) => x.classList.toggle('is-on', x === b))
      state.range = b.dataset.r
      loadDetail()
    }))
    $('#gv-m-term2').addEventListener('click', () => { if (state.detailHost) openTerm(state.detailHost) })
    $('#gv-m-dir-metric').addEventListener('change', (e) => { state.dirMetric = e.target.value; renderDirs() })

    async function loadDetail(silent) {
      const host = state.summary?.hosts.find((x) => x.id === state.detailHost)
      if (!host) return
      const sn = host.snap
      $('#gv-m-detail-meta').textContent = sn && sn.online
        ? `${sn.os} · CPU ${fmtPct(sn.cpu?.pct)}% · 内存 ${fmtPct(sn.mem?.pct)}% · 运行 ${fmtUptime(sn.uptimeSec)}`
        : (host.error || '等待探测')
      try {
        const [hist, procs] = await Promise.all([
          api(`/api/monitor/hosts/${encodeURIComponent(state.detailHost)}/history?range=${state.range}`),
          api(`/api/monitor/hosts/${encodeURIComponent(state.detailHost)}/procs`),
        ])
        state.hist = hist.points || []
        state.procsCache = procs.procs || []
        state.procsTotal = procs.procsTotal || 0
        state.dirsList = procs.dirs || []
        /* 目录历史对比默认全选：新目录补勾，自刷/重渲不重置用户手动取消的项 */
        for (const d of state.dirsList) {
          if (!state.seededDirs.has(d.path)) { state.seededDirs.add(d.path); state.compareSet.add(d.path) }
        }
        $('#gv-m-detail-err').hidden = true
        $('#gv-ch-iface').textContent = (sn && sn.net?.iface) || '-'
        renderCharts()
        renderDirs()
        renderCompareList()
        renderProcs()
      } catch (e) {
        if (!silent) { $('#gv-m-detail-err').textContent = '加载失败：' + e.message; $('#gv-m-detail-err').hidden = false }
      }
    }

    function inst(key, el) {
      if (!state.charts[key]) state.charts[key] = echarts.init(el)
      return state.charts[key]
    }
    function axisCommon() {
      return {
        axisLine: { lineStyle: { color: 'rgba(150,175,220,0.25)' } },
        axisLabel: { color: cssVar('--gv-text-2'), fontSize: 11, hideOverlap: true },
        splitLine: { lineStyle: { color: 'rgba(150,175,220,0.12)', type: 'dashed' } },
      }
    }
    function baseOption(yFmt) {
      const a = axisCommon()
      return {
        animationDuration: reducedMotion ? 0 : 400,
        animationDurationUpdate: reducedMotion ? 0 : 300,
        animationEasingUpdate: 'cubicOut',
        backgroundColor: 'transparent',
        grid: { left: 44, right: 14, top: 24, bottom: 26 },
        tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: 'rgba(15,24,42,0.94)', borderColor: 'rgba(150,175,220,0.3)', textStyle: { color: '#e9effa', fontSize: 12 } },
        xAxis: { type: 'time', axisLine: a.axisLine, axisLabel: { ...a.axisLabel, formatter: state.range === '7d' ? '{MM}-{dd} {HH}:{mm}' : '{HH}:{mm}' } },
        yAxis: { type: 'value', scale: true, axisLabel: { ...a.axisLabel, formatter: yFmt }, splitLine: a.splitLine },
      }
    }
    function areaColor(hex) {
      return new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: hex + '40' }, { offset: 1, color: hex + '05' }])
    }
    function lineSeries(name, data, color, extra = {}) {
      return { name, type: 'line', data, smooth: 0.3, showSymbol: false, connectNulls: false,
        lineStyle: { width: 1.8, color }, itemStyle: { color }, areaStyle: extra.noArea ? undefined : { color: areaColor(color) }, ...extra }
    }
    function renderCharts() {
      const pts = state.hist || []
      const t = (p) => p.t
      const accent = cssVar('--gv-accent'), amber = cssVar('--gv-amber'), purple = cssVar('--gv-purple')
      const teal = cssVar('--gv-teal'), green = cssVar('--gv-green')
      const unit = (text) => ({ name: text, nameLocation: 'end', nameGap: 8, nameTextStyle: { color: cssVar('--gv-text-2'), fontSize: 10, align: 'left' } })
      const legend = () => ({ top: 0, left: 'center', textStyle: { color: cssVar('--gv-text-2'), fontSize: 11 }, itemWidth: 14, itemHeight: 8 })
      const cpuBase = baseOption('{value}%')
      inst('cpu', $('#gv-ch-cpu')).setOption({
        ...cpuBase,
        legend: legend(),
        grid: { ...cpuBase.grid, right: 42, top: 30 },
        yAxis: [
          { ...cpuBase.yAxis },
          { ...cpuBase.yAxis, splitLine: { show: false }, axisLabel: { ...cpuBase.yAxis.axisLabel, formatter: '{value}' } },
        ],
        series: [
          lineSeries('CPU %（左轴）', pts.map((p) => [t(p), p.cpu]), accent),
          lineSeries('负载（右轴）', pts.map((p) => [t(p), p.load]), amber, { noArea: true, yAxisIndex: 1 }),
        ],
      }, { notMerge: true })
      const memBase = baseOption('{value}%')
      inst('mem', $('#gv-ch-mem')).setOption({
        ...memBase,
        legend: legend(),
        grid: { ...memBase.grid, right: 46, top: 30 },
        yAxis: [
          { ...memBase.yAxis },
          { ...memBase.yAxis, splitLine: { show: false } },
        ],
        series: [
          lineSeries('内存 %（左轴）', pts.map((p) => [t(p), p.mem]), purple),
          lineSeries('Swap %（右轴）', pts.map((p) => [t(p), p.swap]), teal, { noArea: true, yAxisIndex: 1 }),
        ],
      }, { notMerge: true })
      const netBase = baseOption('{value}')
      inst('net', $('#gv-ch-net')).setOption({
        ...netBase,
        legend: legend(),
        grid: { ...netBase.grid, top: 30 },
        yAxis: { ...netBase.yAxis, ...unit('Mbps') },
        series: [
          lineSeries('下行 Mbps', pts.map((p) => [t(p), p.netI]), accent),
          lineSeries('上行 Mbps', pts.map((p) => [t(p), p.netO]), green),
        ],
      }, { notMerge: true })
      const dioBase = baseOption('{value}')
      inst('dio', $('#gv-ch-dio')).setOption({
        ...dioBase,
        legend: legend(),
        grid: { ...dioBase.grid, top: 30 },
        yAxis: { ...dioBase.yAxis, ...unit('MB/s') },
        series: [
          lineSeries('读 MB/s', pts.map((p) => [t(p), p.dioR]), teal),
          lineSeries('写 MB/s', pts.map((p) => [t(p), p.dioW]), amber),
        ],
      }, { notMerge: true })
    }

    const DIR_FIELD = { cpu: 'cpuPct', mem: 'memMb', ioR: 'ioReadMbs', ioW: 'ioWriteMbs', threads: 'threads', fds: 'fds' }
    function renderDirs() {
      const field = DIR_FIELD[state.dirMetric] || state.dirMetric
      const top = [...state.dirsList].sort((a, b) => (b[field] || 0) - (a[field] || 0)).slice(0, 10)
      const c = inst('dirs', $('#gv-ch-dirs'))
      c.setOption({
        animationDuration: reducedMotion ? 0 : 400, animationDurationUpdate: reducedMotion ? 0 : 300,
        backgroundColor: 'transparent',
        grid: { left: 150, right: 66, top: 8, bottom: 22 },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(15,24,42,0.94)', borderColor: 'rgba(150,175,220,0.3)', textStyle: { color: '#e9effa', fontSize: 12 } },
        xAxis: { type: 'value', axisLabel: { ...axisCommon().axisLabel }, splitLine: axisCommon().splitLine },
        yAxis: { type: 'category', inverse: true, data: top.map((d) => d.name + (d.source === 'container' ? ' ⬛' : '')), axisLabel: { ...axisCommon().axisLabel, fontSize: 11.5 } },
        series: [{ type: 'bar', barWidth: 14, data: top.map((d) => ({
          value: +(d[field] || 0).toFixed(2), dirPath: d.path,
          itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: cssVar('--gv-accent') + '99' }, { offset: 1, color: cssVar('--gv-accent') }]), borderRadius: 4 },
          label: { show: true, position: 'right', formatter: (p) => p.value, color: cssVar('--gv-text-2'), fontSize: 11 },
        })) }],
      }, { notMerge: true })
      c.off('click')
      c.on('click', (params) => {
        const dir = params.data && params.data.dirPath
        if (!dir) return
        state.dirFilter = state.dirFilter === dir ? '' : dir
        renderProcs()
      })
    }

    function renderCompareList() {
      const wrap = $('#gv-m-compare')
      const dirs = state.dirsList || []
      $('#gv-m-dirs-empty').hidden = !!dirs.length
      $('#gv-ch-dirs').hidden = !dirs.length
      $('#gv-m-cmp-box').hidden = !dirs.length
      wrap.innerHTML = dirs.length
        ? dirs.map((d) => `<label class="gv-dir-chip${state.compareSet.has(d.path) ? ' is-on' : ''}">
            <input type="checkbox" data-dir="${esc(d.path)}"${state.compareSet.has(d.path) ? ' checked' : ''} />${esc(d.name)}</label>`).join('')
        : '<span class="gv-hint">该主机暂无目录命中</span>'
      $$('input[data-dir]', wrap && document).forEach((cb) => cb.addEventListener('change', async () => {
        const d = cb.dataset.dir
        if (cb.checked) state.compareSet.add(d); else state.compareSet.delete(d)
        cb.closest('.gv-dir-chip').classList.toggle('is-on', cb.checked)
        await renderCompare()
      }))
      renderCompare()
    }
    /* 全选 / 清空（清空不动 seededDirs：静默自刷不会把勾选强行加回来） */
    function setAllCompare(on) {
      state.compareSet.clear()
      if (on) for (const d of state.dirsList || []) { state.compareSet.add(d.path); state.seededDirs.add(d.path) }
      renderCompareList()
    }
    async function renderCompare() {
      const dirs = [...state.compareSet]
      const chartEl = $('#gv-ch-cmp')
      chartEl.hidden = !dirs.length
      $('#gv-m-cmp-empty').hidden = !!dirs.length
      const c = inst('cmp', chartEl)
      if (!dirs.length) { c.setOption({ ...baseOption('{value}%'), series: [] }, { notMerge: true }); return }
      if (chartEl.clientWidth === 0) c.resize()
      try {
        const res = await api(`/api/monitor/dirs/history?host=${encodeURIComponent(state.detailHost)}&range=${state.range}&dirs=${encodeURIComponent(dirs.join('|'))}`)
        const palette = ['--gv-accent', '--gv-purple', '--gv-teal', '--gv-amber', '--gv-green', '--gv-red']
        c.setOption({
          ...baseOption('{value}%'),
          legend: { top: 0, textStyle: { color: cssVar('--gv-text-2'), fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
          series: Object.entries(res.series).map(([path, rows], i) => lineSeries(
            state.dirsList.find((d) => d.path === path)?.name || path,
            rows.map((r) => [r.t, r.cpu]), cssVar(palette[i % palette.length]), { noArea: i > 0 },
          )),
        }, { notMerge: true })
      } catch { /* 静默 */ }
    }

    function renderProcs() {
      const rows = state.procsCache
        .filter((p) => !state.dirFilter || p.dir === state.dirFilter)
        .sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0))
      $('#gv-m-procs-sub').textContent = `归属进程 ${state.procsCache.length} / 主机总进程 ${state.procsTotal}` +
        (state.dirFilter ? ` · 已过滤「${state.dirsList.find((d) => d.path === state.dirFilter)?.name || state.dirFilter}」` : '')
      $('#gv-m-clear-filter').hidden = !state.dirFilter
      $('#gv-m-procs-body').innerHTML = rows.map((p) => `<tr>
        <td class="gv-num" title="${esc(p.cmd)}">${esc(p.name)}</td>
        <td><span class="gv-dir-tag${p.dir && p.dir.startsWith('docker:') ? ' container' : ''}">${esc(p.dirName || '-')}</span></td>
        <td class="gv-num">${p.pid}</td>
        <td class="gv-num">${p.cpuPct == null ? '-' : p.cpuPct.toFixed(2)}</td>
        <td class="gv-num">${fmtMb(p.memMb)}</td>
        <td class="gv-num">${fmtMbs(p.ioReadMbs)}</td>
        <td class="gv-num">${fmtMbs(p.ioWriteMbs)}</td>
        <td class="gv-num">${p.threads}</td>
        <td class="gv-num">${p.fds || '-'}</td>
        <td>${esc(p.container || '-')}</td>
        <td class="gv-proc-cmd" title="${esc(p.cmd)}">${esc(p.cmd)}</td>
      </tr>`).join('') || '<tr><td colspan="11" class="gv-empty">无归属进程</td></tr>'
    }
    $('#gv-m-clear-filter').addEventListener('click', () => { state.dirFilter = ''; renderProcs() })
    $('#gv-cmp-all').addEventListener('click', () => setAllCompare(true))
    $('#gv-cmp-none').addEventListener('click', () => setAllCompare(false))

    /* ---------- 终端 ---------- */
    let term = null, termWs = null, termFit = null
    let termHostId = '' // 当前抽屉的目标主机 id（重连/弹窗都要用 id 而非名称）
    function termStatus(txt, cls = '') { const el = $('#gv-term-status'); el.textContent = txt; el.className = 'gv-term-status ' + (cls || '') }
    function openTerm(hostId) {
      const h = state.summary?.hosts.find((x) => x.id === hostId)
      const sameSession = termHostId === hostId && term
      termHostId = hostId
      $('#gv-term-drawer').hidden = false
      $('#gv-term-mask').hidden = false
      $('#gv-term-title').textContent = `终端 · ${h ? h.name : hostId}`
      // 同一主机再次打开：沿用原会话与输出，仅重排/聚焦
      if (sameSession) {
        setTimeout(() => { try { termFit.fit(); term.focus() } catch { /* 忽略 */ } }, 60)
        return
      }
      connectTerm(hostId)
    }
    function closeTerm() {
      // 仅隐藏抽屉，不关闭 WS / 不释放 xterm，重新打开保留之前内容
      $('#gv-term-drawer').hidden = true
      $('#gv-term-mask').hidden = true
    }
    function termState() { return term || termWs }
    function connectTerm(hostId) {
      if (termState()) { try { termWs && termWs.close() } catch { /* 已关 */ } try { term && term.dispose() } catch { /* 已释放 */ } term = termWs = termFit = null }
      $('#gv-term-container').innerHTML = ''
      termStatus('连接中…')
      term = new Terminal({
        fontFamily: "'Cascadia Code', Menlo, Consolas, monospace", fontSize: 13.5,
        theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#4d9fff', selectionBackground: '#264f78' },
        cursorBlink: !reducedMotion, scrollback: 5000,
      })
      termFit = new FitAddon.FitAddon()
      term.loadAddon(termFit)
      term.open($('#gv-term-container'))
      termFit.fit()
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      termWs = new WebSocket(`${proto}://${location.host}/api/terminal?host=${encodeURIComponent(hostId)}&cols=${term.cols}&rows=${term.rows}`)
      termWs.binaryType = 'arraybuffer'
      termWs.onopen = () => termStatus(`已连接 ${hostId}`, 'ok')
      termWs.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return }
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'error') { termStatus('错误：' + msg.message, 'bad'); term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`) }
        } catch { /* 普通输入 */ }
      }
      termWs.onclose = (ev) => { if (termWs) termStatus(ev.reason ? `已断开（${ev.reason}）` : '已断开', 'bad') }
      termWs.onerror = () => termStatus('连接失败', 'bad')
      term.onData((d) => { if (termWs && termWs.readyState === 1) termWs.send(d) })
      term.onResize(({ cols, rows }) => { if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols, rows })) })
      term.focus()
    }
    $('#gv-term-close').addEventListener('click', closeTerm)
    window.addEventListener('keydown', (e) => {
      // 捕获阶段：全屏时 ESC 还原窗口（xterm textarea 会吞冒泡阶段的 Escape）
      if (e.key === 'Escape' && e.target && $('#gv-term-drawer') && !$('#gv-term-drawer').hidden && $('#gv-term-drawer').classList.contains('is-full')) {
        e.preventDefault(); e.stopPropagation()
        $('#gv-term-full').click()
      }
    }, true)
    $('#gv-term-full').addEventListener('click', () => {
      const d = $('#gv-term-drawer')
      const full = d.classList.toggle('is-full')
      $('#gv-term-full').textContent = full ? '还原窗口' : '全屏'
      setTimeout(() => { if (termFit) { try { termFit.fit(); term && term.focus() } catch { /* 忽略 */ } } }, 60)
      setTimeout(() => { if (termFit) { try { termFit.fit(); term && term.focus() } catch { /* 忽略 */ } } }, 180)
    })
    $('#gv-term-mask').addEventListener('click', closeTerm)
    $('#gv-term-reconnect').addEventListener('click', () => { if (termHostId) connectTerm(termHostId) })
    $('#gv-term-popout').addEventListener('click', () => {
      if (!termHostId) return
      // 弹出页需要独立会话：先释放抽屉会话，避免同主机并发占用
      if (termState()) { try { termWs && termWs.close() } catch { /* 已关 */ } try { term && term.dispose() } catch { /* 已释放 */ } }
      term = termWs = termFit = null
      closeTerm()
      window.open(`/monitor/terminal.html?host=${encodeURIComponent(termHostId)}`, '_blank', 'width=980,height=640')
    })
    window.addEventListener('resize', () => { if (termFit) { try { termFit.fit() } catch { /* 忽略 */ } } Object.values(state.charts).forEach((c) => c && c.resize()) })

    /* ---------- 设置弹窗 ---------- */
    const setEdit = { hosts: [], trackedDirs: [], thresholds: {}, collect: {}, terminal: {}, webhookUrl: '' }
    function setTip(msg, cls) { const el = $('#gv-set-tip'); el.textContent = msg; el.className = 'gv-save-tip ' + (cls || 'ok') }

    $('#gv-m-open-settings').addEventListener('click', openSettings)
    $('#gv-set-close').addEventListener('click', () => { $('#gv-settings').hidden = true })
    $('#gv-set-cancel').addEventListener('click', () => { $('#gv-settings').hidden = true })
    $('#gv-settings').addEventListener('click', (e) => { if (e.target === $('#gv-settings')) $('#gv-settings').hidden = true })

    async function openSettings() {
      $('#gv-settings').hidden = false
      setTip('')
      try {
        const c = await api('/api/monitor/config')
        const data = JSON.parse(JSON.stringify(c))
        for (const h of data.hosts || []) {
          if (h.type === 'local' && !h.terminal) h.terminal = { host: '127.0.0.1', port: 22, username: 'root', authType: 'key', keyPath: '' }
        }
        Object.assign(setEdit, data)
        renderSettings()
        const a = await api('/api/monitor/audit?limit=50')
        $('#gv-set-audit').innerHTML = (a.rows || []).map((r) => `<tr>
          <td class="gv-num">${esc((r.ts || '').replace('T', ' ').slice(0, 19))}</td><td>${esc(r.event)}</td>
          <td>${esc(r.host || '-')}</td><td class="gv-num">${esc(r.ip || '-')}</td>
          <td class="gv-num">${r.durationSec != null ? r.durationSec + 's' : '-'}</td>
          <td>${esc(r.reason || (r.keys && r.keys.join(',')) || (r.commands && r.commands.slice(-3).join(' ; ')) || '')}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="gv-empty">暂无记录</td></tr>'
      } catch (e) { setTip('加载失败：' + e.message, 'bad') }
    }

    function renderSettings() {
      $('#gv-set-hosts').innerHTML = setEdit.hosts.map((h, i) => `
        <div class="gv-host-edit" data-i="${i}">
          <div class="gv-he-head"><b>${esc(h.id)}</b><span class="gv-sub">${h.type === 'local' ? '本机' : 'SSH 远程'}</span>
            <span class="gv-grow"></span>
            ${h.type === 'ssh' ? `<button type="button" class="gv-minibtn danger" data-del-host="${i}">删除</button>` : '<span class="gv-sub">不可删除</span>'}</div>
          <div class="gv-form-grid">
            <label class="gv-fitem"><span>名称</span><input type="text" data-k="name" value="${esc(h.name)}" /></label>
            <label class="gv-fitem"><span>分组（内网=蓝 / 公网=橙）</span><input type="text" data-k="group" value="${esc(h.group)}" /></label>
            ${h.type === 'ssh' ? `
              <label class="gv-fitem"><span>地址</span><input type="text" data-k="address" value="${esc(h.address)}" /></label>
              <label class="gv-fitem"><span>SSH 端口</span><input type="number" data-k="port" value="${h.port}" /></label>
              <label class="gv-fitem"><span>用户名</span><input type="text" data-k="username" value="${esc(h.username)}" /></label>
              <label class="gv-fitem"><span>认证</span><select data-k="authType"><option value="key"${h.authType === 'key' ? ' selected' : ''}>密钥</option><option value="password"${h.authType === 'password' ? ' selected' : ''}>密码</option></select></label>
              <label class="gv-fitem span2"><span>私钥路径（0600）</span><input type="text" data-k="keyPath" value="${esc(h.keyPath || '')}" /></label>
              <label class="gv-fitem span2"><span>采集方式</span>
                <select data-k="mode">
                  <option value="ssh"${h.mode !== 'agent' ? ' selected' : ''}>SSH 拉取</option>
                  <option value="agent"${h.mode === 'agent' ? ' selected' : ''}>Agent 推送</option>
                </select>
              </label>
            ` : `
              <label class="gv-fitem"><span>展示地址</span><input type="text" data-k="address" value="${esc(h.address || '')}" /></label>
              <label class="gv-fitem"><span>终端主机</span><input type="text" data-k="t_host" value="${esc(h.terminal?.host || '127.0.0.1')}" /></label>
              <label class="gv-fitem"><span>终端端口</span><input type="number" data-k="t_port" value="${h.terminal?.port || 22}" /></label>
              <label class="gv-fitem"><span>终端用户</span><input type="text" data-k="t_username" value="${esc(h.terminal?.username || 'root')}" /></label>
              <label class="gv-fitem"><span>认证</span><select data-k="t_authType"><option value="key"${h.terminal?.authType === 'key' ? ' selected' : ''}>密钥</option><option value="password"${h.terminal?.authType === 'password' ? ' selected' : ''}>密码</option></select></label>
              <label class="gv-fitem"><span>私钥路径</span><input type="text" data-k="t_keyPath" value="${esc(h.terminal?.keyPath || '')}" /></label>
            `}
          </div>
          ${h.note ? `<p class="gv-sub" style="margin:6px 0 0">${esc(h.note)}</p>` : ''}
          ${h.type === 'ssh' ? `<div class="gv-he-dirs">
            <div class="gv-sub" style="margin-bottom:4px">自动部署：输入目标机密码，中心自动 SSH 完成 免密密钥分发 → Agent 安装启动 → 切换推送模式（密码仅本次使用，另加密存档备用）</div>
            <div class="gv-dir-row">
              <input type="password" class="gv-prov-pw" data-prov="${esc(h.id)}" placeholder="目标机密码" autocomplete="new-password" style="flex:1;background:transparent;border:0;color:var(--gv-text);outline:none;font:inherit" />
              <button type="button" class="gv-minibtn" data-prov-run="${esc(h.id)}">自动安装 Agent 并配置免密</button>
            </div>
            <ol class="gv-prov-steps" id="gv-prov-steps-${esc(h.id)}" style="margin:6px 0 0;padding-left:18px;color:var(--gv-text-2);font-size:12px">${(h._provSteps || []).map((st) => `<li${st.startsWith('部署失败') ? ' style="color:var(--gv-red)"' : st.startsWith('部署完成') ? ' style="color:var(--gv-green)"' : ''}>${esc(st)}</li>`).join('')}</ol>
          </div>` : ''}
          <div class="gv-he-dirs">
            <div class="sub" style="margin-bottom:4px">该主机跟踪目录（目录级资源统计${h.type === 'local' ? '；主页登记的应用目录已自动并入' : ''}）</div>
            ${(h.trackedDirs || []).map((d, di) => `<div class="gv-dir-row"><span class="gv-d-path">${esc(d.path)}</span>
              <span class="gv-d-src">主机目录</span><button type="button" class="gv-minibtn" style="color:var(--gv-red)" data-del-hdir="${i}:${di}">移除</button></div>`).join('')}
            <button type="button" class="gv-minibtn" data-add-hdir="${i}">＋添加目录</button>
          </div>
        </div>`).join('')
      $$('#gv-set-hosts [data-del-host]').forEach((b) => b.addEventListener('click', () => {
        const i = +b.dataset.delHost
        if (confirm(`删除主机 ${setEdit.hosts[i].id}？（保存后生效）`)) { setEdit.hosts.splice(i, 1); renderSettings() }
      }))
      $$('#gv-set-hosts [data-prov-run]').forEach((b) => b.addEventListener('click', async () => {
        const hid = b.dataset.provRun
        const host = setEdit.hosts.find((x) => x.id === hid)
        const pwInput = document.querySelector(`.gv-prov-pw[data-prov="${CSS.escape(hid)}"]`)
        const pw = pwInput ? pwInput.value : ''
        const ol = document.getElementById('gv-prov-steps-' + hid)
        if (!pw) { host._provSteps = ['请输入目标机密码']; renderSettings(); return }
        b.disabled = true
        const old = b.textContent
        b.textContent = '部署中…'
        host._provSteps = ['正在连接并部署…']
        renderSettings()
        try {
          const res = await fetch('/api/monitor/hosts/provision', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ host, password: pw }),
          })
          const d = await res.json()
          if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status))
          if (d.host) Object.assign(host, d.host)
          host._provSteps = [...(d.steps || []), '部署完成 ✓（免密与 Agent 已配置，等待首个推送）']
          renderSettings()
        } catch (e) {
          host._provSteps = ['部署失败：' + e.message]
          renderSettings()
        } finally { /* 按钮随重渲染复位 */ }
      }))
      $$('#gv-set-hosts [data-del-hdir]').forEach((b) => b.addEventListener('click', () => {
        const [hi, di] = b.dataset.delHdir.split(':').map(Number)
        setEdit.hosts[hi].trackedDirs.splice(di, 1)
        renderSettings()
      }))
      $$('#gv-set-hosts [data-add-hdir]').forEach((b) => b.addEventListener('click', () => {
        const h = setEdit.hosts[+b.dataset.addHdir]
        const p = prompt(`输入 ${h.name || h.id} 上要跟踪的绝对目录路径（如 /opt/myapp）：`)
        if (!p) return
        if (!p.startsWith('/')) { alert('必须是绝对路径'); return }
        if (p === '/') { alert('不允许跟踪根目录（不越界采集）'); return }
        const clean = p.replace(/\/+$/, '')
        const list = h.trackedDirs || (h.trackedDirs = [])
        if (list.some((d) => d.path === clean)) { alert('该目录已在列表中'); return }
        list.push({ path: clean, source: 'host' })
        renderSettings()
      }))
      $$('#gv-set-hosts input, #gv-set-hosts select').forEach((inp) => inp.addEventListener('change', () => {
        const h = setEdit.hosts[+inp.closest('.gv-host-edit').dataset.i]
        const k = inp.dataset.k
        if (!k) return
        if (k.startsWith('t_')) h.terminal = { ...(h.terminal || {}), [k.slice(2)]: k === 't_port' ? +inp.value : inp.value }
        else if (k === 'port') h.port = +inp.value
        else h[k] = inp.value
      }))

      $('#gv-set-dirs').innerHTML = setEdit.trackedDirs.length
        ? setEdit.trackedDirs.map((d, i) => `<div class="gv-dir-row"><span class="gv-d-path">${esc(d.path)}</span>
            <span class="gv-d-src">自定义</span><button type="button" class="gv-minibtn danger" data-del-dir="${i}">移除</button></div>`).join('')
        : '<p class="gv-sub">暂无自定义跟踪目录</p>'
      $$('#gv-set-dirs [data-del-dir]').forEach((b) => b.addEventListener('click', () => { setEdit.trackedDirs.splice(+b.dataset.delDir, 1); renderSettings() }))

      const thFields = [['cpuPct', 'CPU %'], ['memPct', '内存 %'], ['diskPct', '磁盘 %'], ['loadPerCore', '每核负载'], ['sustainMin', '持续分钟']]
      $('#gv-set-th').innerHTML = thFields.map(([k, label]) => `<label class="gv-fitem"><span>${label}</span><input type="number" step="0.1" data-th="${k}" value="${setEdit.thresholds[k]}" /></label>`).join('')
      $$('#gv-set-th input').forEach((inp) => inp.addEventListener('change', () => { setEdit.thresholds[inp.dataset.th] = +inp.value }))

      const coFields = [['localIntervalSec', '本机采集间隔(秒)'], ['remoteIntervalSec', '远程采集间隔(秒)'], ['retentionDays', '历史保留(天)'], ['dockerRefreshSec', '容器映射刷新(秒)']]
      $('#gv-set-collect').innerHTML = coFields.map(([k, label]) => `<label class="gv-fitem"><span>${label}</span><input type="number" data-co="${k}" value="${setEdit.collect[k]}" /></label>`).join('')
      $$('#gv-set-collect input').forEach((inp) => inp.addEventListener('change', () => { setEdit.collect[inp.dataset.co] = +inp.value }))
      const teFields = [['idleTimeoutMin', '终端空闲超时(分)'], ['maxSessionMin', '单会话上限(分)'], ['maxSessionsPerHost', '每主机并发会话']]
      $('#gv-set-term').innerHTML = teFields.map(([k, label]) => `<label class="gv-fitem"><span>${label}</span><input type="number" data-te="${k}" value="${setEdit.terminal[k]}" /></label>`).join('')
        + `<label class="gv-fitem"><span>命令行审计</span><span style="display:flex;align-items:center;gap:6px;padding:6px 0"><input type="checkbox" id="gv-te-record" style="accent-color:var(--gv-accent)"${setEdit.terminal.recordCommands ? ' checked' : ''} /> 记录回车提交的命令</span></label>`
      $$('#gv-set-term input[type=number]').forEach((inp) => inp.addEventListener('change', () => { setEdit.terminal[inp.dataset.te] = +inp.value }))
      $('#gv-te-record').addEventListener('change', (e) => { setEdit.terminal.recordCommands = e.target.checked })
      $('#gv-set-webhook').value = setEdit.webhookUrl || ''
    }
    $('#gv-set-host-add').addEventListener('click', () => {
      setEdit.hosts.push({ id: 'host-' + Math.random().toString(36).slice(2, 6), name: '新主机', type: 'ssh', group: '内网', address: '', port: 22, username: 'root', authType: 'key', keyPath: '' })
      renderSettings()
    })
    $('#gv-set-dir-add').addEventListener('click', () => {
      const p = prompt('输入要跟踪的绝对目录路径（如 /opt/myapp）：')
      if (!p) return
      if (!p.startsWith('/')) { alert('必须是绝对路径'); return }
      if (p === '/') { alert('不允许跟踪根目录（不越界采集）'); return }
      if (setEdit.trackedDirs.some((d) => d.path === p)) { alert('该目录已在列表中'); return }
      setEdit.trackedDirs.push({ path: p, name: p.split('/').filter(Boolean).pop() || p, source: 'custom' })
      renderSettings()
    })
    $('#gv-set-save').addEventListener('click', async () => {
      try {
        await api('/api/monitor/config', { method: 'PUT', body: {
          hosts: setEdit.hosts, trackedDirs: setEdit.trackedDirs, thresholds: setEdit.thresholds,
          collect: setEdit.collect, terminal: setEdit.terminal, webhookUrl: $('#gv-set-webhook').value.trim(),
        } })
        setTip('已保存并热加载 ✓')
        refreshSummary()
      } catch (e) { setTip('保存失败：' + e.message, 'bad') }
    })
    $('#gv-pw-change').addEventListener('click', async () => {
      try {
        await api('/api/monitor/password', { method: 'POST', body: { oldPassword: $('#gv-pw-old').value, newPassword: $('#gv-pw-new').value } })
        $('#gv-pw-old').value = ''; $('#gv-pw-new').value = ''
        setTip('密码已修改（本浏览器保持登录）')
      } catch (e) { setTip('修改失败：' + e.message, 'bad') }
    })

    function onThemeChange() {
      Object.values(state.charts).forEach((c) => c && c.dispose())
      state.charts = {}
      if (state.detailHost) loadDetail(true)
    }


  const bt = {
    open: false, full: false, solo: null,
    panes: [], // {id,name,el,term,fit,ws,statusEl}
    picked: new Set(),
  }
  const $b = (id) => document.getElementById(id)

  function openPicker() {
    const list = $b('gv-bt-picker-list')
    bt.picked.clear()
    const hosts = (state.summary?.hosts || []).filter((h) => h.credReady)
    list.innerHTML = hosts.length
      ? hosts.map((h) => `<label class="gv-bt-picker-row" data-id="${esc(h.id)}">
          <input type="checkbox" data-id="${esc(h.id)}" />
          <span>${esc(h.name)}</span>
          <span class="gv-sub" style="margin-left:auto">${esc(h.address || '')} · ${h.online ? '在线' : '离线'}</span>
        </label>`).join('')
      : '<p class="gv-sub" style="padding:10px">没有可用主机（需已配置凭据）</p>'
    $$('input[data-id]', list).forEach((cb) => cb.addEventListener('change', () => {
      const id = cb.dataset.id
      if (cb.checked) {
        if (bt.picked.size >= 6) { cb.checked = false; return }
        bt.picked.add(id)
      } else bt.picked.delete(id)
      cb.closest('.gv-bt-picker-row').classList.toggle('on', cb.checked)
      $b('gv-bt-pick-n').textContent = `已选 ${bt.picked.size}/6`
      $b('gv-bt-pick-ok').style.opacity = bt.picked.size ? '1' : '0.5'
    }))
    $b('gv-bt-picker').hidden = false
  }

  async function openBatch() {
    const hosts = (state.summary?.hosts || []).filter((h) => bt.picked.has(h.id))
    $b('gv-bt-picker').hidden = true
    const panesEl = $b('gv-bt-panes')
    const n = hosts.length
    const cols = n >= 4 ? 3 : Math.max(1, n)
    panesEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`
    panesEl.innerHTML = hosts.map((h) => `
      <div class="gv-bt-pane" data-id="${esc(h.id)}">
        <div class="gv-bt-pane-head">
          <span class="pane-dot" style="width:8px;height:8px;border-radius:50%;background:#8b949e"></span>
          <span class="gv-bt-pane-name">${esc(h.name)}</span>
          <span class="gv-bt-pane-status">连接中…</span>
          <span class="gv-grow"></span>
          <button type="button" class="gv-minibtn" data-reconnect="${esc(h.id)}" style="font-size:11px;padding:1px 8px">重连</button>
        </div>
        <div class="gv-bt-pane-term"></div>
      </div>`).join('')
    bt.open = true
    bt.solo = null
    bt.panes = []
    $b('gv-bt').hidden = false
    updateMode()
    await new Promise((r) => setTimeout(r, 60))
    for (const h of hosts) connectPane(h)
  }

  function setStatusPane(pane, txt, cls) {
    pane.el.querySelector('.gv-bt-pane-status').textContent = txt
    pane.el.querySelector('.gv-bt-pane-status').className = 'gv-bt-pane-status ' + (cls || '')
    pane.el.querySelector('.pane-dot').style.background = cls === 'ok' ? 'var(--gv-green)' : cls === 'bad' ? 'var(--gv-red)' : '#8b949e'
  }

  function connectPane(h) {
    const el = $b('gv-bt-panes').querySelector(`.gv-bt-pane[data-id="${CSS.escape(h.id)}"]`)
    const pane = { id: h.id, name: h.name, el, term: null, fit: null, ws: null }
    bt.panes.push(pane)
    const term = new Terminal({
      fontFamily: "'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: Math.max(11, Math.floor(13.5 - (bt.panes.length >= 4 ? 2 : 0))),
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#4d9fff', selectionBackground: '#264f78' },
      cursorBlink: !reducedMotionGlobal(), scrollback: 3000,
    })
    const fit = new FitAddon.FitAddon()
    term.loadAddon(fit)
    term.open(el.querySelector('.gv-bt-pane-term'))
    fit.fit()
    pane.term = term; pane.fit = fit
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/terminal?host=${encodeURIComponent(h.id)}&cols=${term.cols}&rows=${term.rows}`)
    pane.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => setStatusPane(pane, '已连接', 'ok')
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return }
      try { const m = JSON.parse(ev.data); if (m.type === 'error') setStatusPane(pane, '错误：' + m.message, 'bad') } catch { /* 忽略 */ }
    }
    ws.onclose = (ev) => { if (pane.ws === ws) setStatusPane(pane, ev.reason ? `断开（${ev.reason}）` : '断开', 'bad') }
    ws.onerror = () => setStatusPane(pane, '连接失败', 'bad')
    term.onData((d) => { if (ws.readyState === 1) ws.send(d) })
    term.onResize(({ cols: cc, rows: rr }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: cc, rows: rr })) })
    el.querySelector('[data-reconnect]').addEventListener('click', (e) => { e.stopPropagation(); connectPane(h) })
  }

  function reducedMotionGlobal() { return matchMedia('(prefers-reduced-motion: reduce)').matches }

  function updateMode() {
    $b('gv-bt-mode').textContent = bt.solo ? `单机输入：${bt.solo.name}` : `广播：输入将下发到全部 ${bt.panes.length} 台`
    $b('gv-bt-mode').classList.toggle('solo', !!bt.solo)
    $b('gv-bt-prompt').textContent = bt.solo ? '单机 ▸' : '广播 ▸'
    $b('gv-bt-prompt').classList.toggle('solo', !!bt.solo)
  }

  function sendBar() {
    const text = $b('gv-bt-input').value
    if (!text.trim()) return
    const targets = bt.solo ? [bt.solo] : bt.panes
    let n = 0
    for (const pane of targets) if (pane.ws && pane.ws.readyState === 1) { pane.ws.send(text + '\r'); n++ }
    $b('gv-bt-input').value = ''
    $b('gv-bt-sent').textContent = bt.solo ? `已下发到 ${n} 台（单机：${bt.solo.name}）` : `已下发到 ${n} 台`
  }

  function closeBatch() {
    for (const pane of bt.panes) { try { pane.ws && pane.ws.close() } catch {} try { pane.term && pane.term.dispose() } catch {} }
    bt.panes = []; bt.open = false; bt.solo = null
    $b('gv-bt-panes').innerHTML = ''
    $b('gv-bt').hidden = true
    $b('gv-bt-sent').textContent = ''
  }

  function refitAll() { for (const pane of bt.panes) { try { pane.fit && pane.fit.fit() } catch {} } }

  $b('gv-m-open-batch').addEventListener('click', openPicker)
  $b('gv-bt-pick-cancel').addEventListener('click', () => { $b('gv-bt-picker').hidden = true })
  $b('gv-bt-pick-ok').addEventListener('click', openBatch)
  $b('gv-bt-close').addEventListener('click', closeBatch)
  $b('gv-bt-send').addEventListener('click', sendBar)
  $b('gv-bt-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBar() })
  $b('gv-bt-full').addEventListener('click', () => {
    bt.full = $b('gv-bt-box').classList.toggle('is-full')
    $b('gv-bt-full').textContent = bt.full ? '还原窗口' : '全屏'
    setTimeout(refitAll, 60); setTimeout(refitAll, 180)
  })
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !bt.open) return
    if (bt.full) { e.preventDefault(); e.stopPropagation(); $b('gv-bt-full').click() }
  }, true)
  window.addEventListener('resize', () => { if (bt.open) refitAll() })
  // 窗格点击 → 单机交互
  $b('gv-bt-panes').addEventListener('click', (e) => {
    if (e.target.closest('button')) return
    const el = e.target.closest('.gv-bt-pane')
    if (!el) return
    const pane = bt.panes.find((x) => x.id === el.dataset.id)
    if (!pane) return
    bt.solo = pane
    pane.term && pane.term.focus()
    updateMode()
  })
  $b('gv-bt-input').addEventListener('focus', () => { if (bt.solo) { bt.solo = null; updateMode() } })

    return {
      activate() { if (!booted) boot(); else { startPoll(); refreshSummary() } },
      boot, onThemeChange, showLogin,
    }
  })()

  /* ============================ 启动（全站登录门） ============================ */
  // 未鉴权时登录层覆盖整个页面（应用 + 监控）；应用为公开数据照常预载，
  // 登录成功后立即可用。网关不可达时放行，不把页面锁死。
  const startView = location.hash === '#monitor' || localStorage.getItem('gv2:view') === 'monitor' ? 'monitor' : 'apps'
  async function siteGate() {
    let authed = true
    try {
      const r = await fetch('/api/monitor/summary', { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' })
      if (r.status === 401) authed = false
    } catch { authed = true } // 网络异常放行
    apps.boot()
    if (!authed) {
      monitorModule.showLogin()
      return
    }
    if (startView === 'monitor') switchView('monitor')
  }
  siteGate()
  document.addEventListener('visibilitychange', () => { if (!document.hidden) apps.refresh() })
})()
