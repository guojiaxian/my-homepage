/* ============================================================
   /unslop/ 设计对比端点 · 数据与交互
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

  function statusInfo(app) {
    if (app.appOnly) {
      return {
        text: '离线应用',
        dot: 'off',
        title: '离线应用：纯 APP / 小程序，无 Web 服务，不做端口探测',
      }
    }
    if (app.status === 'running') return { text: '运行中', dot: 'ok', title: remoteHealthTitle(app) }
    return { text: '未运行', dot: 'bad', title: remoteHealthTitle(app) }
  }

  /** git 同步状态 → { text, dot, title }；无 git 信息返回 null */
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
      synced: { text: '已同步', dot: 'ok' },
      dirty: { text: `未提交 ${git.uncommitted}`, dot: 'bad' },
      ahead: { text: `未推送 ${git.ahead}`, dot: 'warn' },
      behind: { text: `未拉取 ${git.behind}`, dot: 'warn' },
      untracked: { text: `未跟踪 ${git.untracked}`, dot: 'warn' },
      'no-repo': { text: '无 Git 仓库', dot: 'gray' },
      'no-upstream': { text: '未关联远端', dot: 'gray' },
      error: { text: '检查失败', dot: 'gray' },
    }
    const view = map[git.status] ?? { text: '检查失败', dot: 'gray' }

    const detail = git.message ? git.message : counts.length ? counts.join(' · ') : `分支 ${branch} 与远端一致`
    const title = git.repo ? `${git.repo}（${branch}）：${detail}` : `分支 ${branch}：${detail}`
    return { ...view, title }
  }

  /** 名称首字字块（替代 emoji 图标） */
  const monogram = (app) => Array.from((app.name || '·').trim())[0] || '·'

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

  /* ---------- 主题 ---------- */
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
    $('#u-iconMoon').hidden = isDark()
    $('#u-iconSun').hidden = !isDark()
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

  /* ---------- 渲染：页面文案 ---------- */
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
  }

  /* ---------- 渲染：机架面板 ---------- */
  function renderRack() {
    const apps = displayApps()
    const rack = $('#u-rack')
    if (!apps.length) {
      rack.hidden = true
      return
    }
    rack.hidden = false
    $('#u-rackLabel').textContent = `rack · ${window.location.hostname || 'localhost'}`

    const running = state.apps.filter((a) => a.status === 'running').length
    const lan = state.apps.filter((a) => !isPublic(a)).length
    const net = state.apps.filter((a) => isPublic(a)).length
    const unsynced = state.apps.filter((a) => a.git && a.git.status !== 'synced').length
    $('#u-rackStats').innerHTML =
      `<b>${running}</b>/${state.apps.length} 运行中 · 内网 <b>${lan}</b> · 公网 <b>${net}</b> · 未同步 <b>${unsynced}</b>`

    $('#u-rackGrid').innerHTML = apps.map((app) => {
      const name = `<span class="u-slot-name">${esc(app.name)}</span>`
      if (app.appOnly) {
        const kindLabel = kindList(app).map((k) => k.label).join('·') || 'APP'
        return `<span class="u-slot u-slot-off"${attr('title', statusInfo(app).title)}>` +
          `<i class="u-dot off"></i><span class="u-slot-port">${esc(kindLabel)}</span>${name}</span>`
      }
      const url = buildAppUrl(app)
      const port = `<span class="u-slot-port">:${esc(portText(app))}</span>`
      if (hasUrl(app) && url) {
        return `<a class="u-slot" href="${esc(url)}" target="_blank" rel="noopener"${attr('title', url)}>` +
          `<i class="u-dot ${app.status === 'running' ? 'ok' : 'bad'}"></i>${port}${name}</a>`
      }
      return `<span class="u-slot u-slot-off" title="未监听，不可访问">` +
        `<i class="u-dot bad"></i>${port}${name}</span>`
    }).join('')
  }

  /* ---------- 渲染：表格 ---------- */
  function arrowHtml(key) {
    if (state.sortKey !== key) return ''
    return `<span class="u-arrow">${state.sortDir === 1 ? '▲' : '▼'}</span>`
  }

  function statusHtml(app) {
    const s = statusInfo(app)
    return `<span class="u-state"${attr('title', s.title)}><i class="u-dot ${s.dot}"></i>${esc(s.text)}</span>`
  }

  function appCellHtml(app) {
    const env = envInfo(app)
    const version = app.remoteInfo?.version
      ? `<span class="u-vers">v${esc(app.remoteInfo.version)}</span>`
      : ''
    const pending = app.pending ? '<span class="u-pending">待补充</span>' : ''
    const kinds = kindList(app)
      .map((k) => `<span class="u-kind" title="应用形式：${esc(k.label)}">${esc(k.label)}</span>`)
      .join('')
    const stack = stackText(app)
    return `<div class="u-appcell">
      <span class="u-avatar" aria-hidden="true">${esc(monogram(app))}</span>
      <div class="u-appmeta">
        <span class="u-appname"><span class="u-env ${env.cls}">${env.label}</span>${esc(app.name)}${version}${pending}</span>
        <span class="u-apptags">${kinds}<span class="u-stack"${attr('title', stackTitle(app))}>${esc(stack)}</span></span>
      </div>
    </div>`
  }

  function portCellHtml(app) {
    if (app.appOnly) return '<span class="u-none" title="该应用无 Web 服务入口">—</span>'
    const url = buildAppUrl(app)
    const extra = app.extraPorts?.length
      ? `<span class="u-extra">+${esc(app.extraPorts.join(', '))}</span>`
      : ''
    const local = app.port && !app.external
      ? '<span class="u-local" title="该服务仅监听 127.0.0.1，仅本机可访问">仅本机</span>'
      : ''
    if (hasUrl(app) && url) {
      return `<a class="u-key" href="${esc(url)}" target="_blank" rel="noopener"${attr('title', url)}>:${esc(portText(app))}<span class="u-ext">↗</span></a>${extra}${local}`
    }
    return `<span class="u-key u-key-muted" title="未监听，不可访问">:${esc(portText(app))}</span>${extra}${local}`
  }

  function dirCellHtml(app) {
    if (app.remote) {
      return `<span class="u-dir mono" title="${esc(`${app.location ?? ''} · ${app.host ?? ''}`)}">${esc(`${app.location ?? ''} · ${app.host ?? ''}`)}</span>`
    }
    return `<span class="u-dir mono u-copyable" data-copy="${esc(app.directory ?? '')}"` +
      `${attr('title', `${app.directory ?? ''}（点击复制）`)}>${esc(app.directory ?? '')}</span>`
  }

  function gitCellHtml(app) {
    const g = gitView(app.git)
    if (!g) return '<span class="u-none">—</span>'
    return `<span class="u-git"${attr('title', g.title)}><i class="u-dot ${g.dot}"></i>${esc(g.text)}</span>`
  }

  function ghCellHtml(app) {
    if (!app.github) return '<span class="u-none">—</span>'
    return `<a class="u-gh" href="${esc(app.github)}" target="_blank" rel="noopener" title="查看源码">源码 ↗</a>`
  }

  function renderTable(apps) {
    const reorderable = state.sortKey === 'default'
    const head = `<thead><tr>
      ${reorderable ? '<th class="u-td-handle"><span class="u-sr">拖拽调整顺序</span></th>' : ''}
      <th class="u-sortable${state.sortKey === 'status' ? ' u-on' : ''}" data-sort="status" title="按运行状态排序（再次点击切换方向）">状态${arrowHtml('status')}</th>
      <th class="u-sortable${state.sortKey === 'name' ? ' u-on' : ''}" data-sort="name" title="按名称排序（再次点击切换方向）">应用${arrowHtml('name')}</th>
      <th>简介</th>
      <th class="u-sortable${state.sortKey === 'port' ? ' u-on' : ''}" data-sort="port" title="按端口排序（再次点击切换方向）">访问地址${arrowHtml('port')}</th>
      <th>服务器 / 目录</th>
      <th class="u-sortable${state.sortKey === 'git' ? ' u-on' : ''}" data-sort="git" title="按同步状态排序（未同步的在前，再次点击切换方向）">同步${arrowHtml('git')}</th>
      <th class="u-td-gh">GitHub</th>
    </tr></thead>`

    const rows = apps.map((app) => `<tr data-id="${esc(app.id)}"${state.dragId === app.id ? ' class="u-dragging"' : ''}>
      ${reorderable
        ? `<td class="u-td-handle"><span class="u-grip" draggable="true" title="按住拖拽调整顺序" aria-label="拖拽调整顺序">
            <svg width="10" height="16" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="4" r="1.8" /><circle cx="11" cy="4" r="1.8" />
              <circle cx="5" cy="10" r="1.8" /><circle cx="11" cy="10" r="1.8" />
              <circle cx="5" cy="16" r="1.8" /><circle cx="11" cy="16" r="1.8" />
            </svg></span></td>`
        : ''}
      <td>${statusHtml(app)}</td>
      <td>${appCellHtml(app)}</td>
      <td class="u-td-desc"><span class="u-desc"${attr('title', app.description)}>${esc(app.description)}</span></td>
      <td>${portCellHtml(app)}</td>
      <td>${dirCellHtml(app)}</td>
      <td>${gitCellHtml(app)}</td>
      <td class="u-td-gh">${ghCellHtml(app)}</td>
    </tr>`).join('')

    return `<div class="u-tablewrap"><table class="u-table">${head}<tbody>${rows}</tbody></table></div>`
  }

  /* ---------- 渲染：卡片 ---------- */
  function renderCards(apps) {
    const reorderable = state.sortKey === 'default'
    const cards = apps.map((app, idx) => {
      const env = envInfo(app)
      const version = app.remoteInfo?.version
        ? `<span class="u-vers">v${esc(app.remoteInfo.version)}</span>`
        : ''
      const pending = app.pending ? '<span class="u-pending">待补充</span>' : ''
      const extra = app.extraPorts?.length
        ? `<span class="u-extra">+${esc(app.extraPorts.join(', '))}</span>`
        : ''
      const local = app.port && !app.external
        ? '<span class="u-local" title="该服务仅监听 127.0.0.1，仅本机可访问">仅本机</span>'
        : ''
      const dirTitle = app.remote ? `${app.location ?? ''} · ${app.host ?? ''}` : `${app.directory ?? ''}（点击复制）`
      const ghShort = app.github ? app.github.replace('https://github.com/', '') : ''
      const kinds = kindList(app)
        .map((k) => `<span class="u-kind" title="应用形式：${esc(k.label)}">${esc(k.label)}</span>`)
        .join('')

      return `<article class="u-card${state.dragIdx === idx ? ' u-dragging' : ''}" data-idx="${idx}">
        <header class="u-cardhead">
          ${reorderable
            ? `<span class="u-grip" draggable="true" title="按住拖拽调整顺序" aria-label="拖拽调整顺序">
                <svg width="10" height="14" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="4" r="1.8" /><circle cx="11" cy="4" r="1.8" />
                  <circle cx="5" cy="10" r="1.8" /><circle cx="11" cy="10" r="1.8" />
                  <circle cx="5" cy="16" r="1.8" /><circle cx="11" cy="16" r="1.8" />
                </svg></span>`
            : ''}
          <span class="u-avatar u-avatar-lg" aria-hidden="true">${esc(monogram(app))}</span>
          <div class="u-cardtitle">
            <h3><span class="u-env ${env.cls}">${env.label}</span>${esc(app.name)}${version}${pending}</h3>
            ${statusHtml(app)}
          </div>
          ${reorderable
            ? `<div class="u-cardmove">
                <button class="u-mini" type="button" data-move="-1" data-id="${esc(app.id)}" title="上移"${idx === 0 ? ' disabled' : ''}>↑</button>
                <button class="u-mini" type="button" data-move="1" data-id="${esc(app.id)}" title="下移"${idx === apps.length - 1 ? ' disabled' : ''}>↓</button>
              </div>`
            : ''}
        </header>

        <p class="u-carddesc">${esc(app.description)}</p>

        <dl class="u-facts">
          <div class="u-fact">
            <dt>访问</dt>
            <dd>${portCellHtml(app)}</dd>
          </div>
          <div class="u-fact">
            <dt>${app.remote ? '位置' : '目录'}</dt>
            <dd>${dirCellHtml(app)}</dd>
          </div>
          <div class="u-fact">
            <dt>技术栈</dt>
            <dd><span class="u-stack"${attr('title', stackTitle(app))}>${esc(stackText(app)) || '—'}</span></dd>
          </div>
          <div class="u-fact">
            <dt>同步</dt>
            <dd>${gitCellHtml(app)}</dd>
          </div>
          <div class="u-fact">
            <dt>源码</dt>
            <dd>${app.github
              ? `<a class="u-gh" href="${esc(app.github)}" target="_blank" rel="noopener">${esc(ghShort)} ↗</a>`
              : '<span class="u-none">—</span>'}</dd>
          </div>
        </dl>

        ${kinds ? `<footer class="u-cardtags">${kinds}</footer>` : ''}
      </article>`
    }).join('')

    return `<div class="u-cardgrid">${cards}</div>`
  }

  /* ---------- 渲染：内容区 ---------- */
  function renderContent() {
    const box = $('#u-content')

    if (state.loading) {
      box.innerHTML = `<div class="u-placeholder" aria-busy="true">
        <div class="u-skeleton"></div><div class="u-skeleton"></div><div class="u-skeleton"></div>
      </div>`
      return
    }
    if (state.loadError) {
      box.innerHTML = `<div class="u-placeholder"><p>${esc(state.loadError)}</p>
        <button class="u-retry" type="button" data-retry>重试</button></div>`
      return
    }
    const apps = displayApps()
    if (!apps.length) {
      box.innerHTML = '<p class="u-placeholder">还没有应用，请检查 apps.json</p>'
      return
    }
    box.innerHTML = state.view === 'table' ? renderTable(apps) : renderCards(apps)
  }

  function render() {
    renderRack()
    renderContent()

    // 工具栏状态
    $('#u-sort').value = state.sortKey
    $('#u-dirBtn').hidden = state.sortKey === 'default'
    $('#u-dirBtn').textContent = state.sortDir === 1 ? '↑' : '↓'
    $('#u-dirBtn').title = state.sortDir === 1 ? '正序（点击切换倒序）' : '倒序（点击切换正序）'
    $('#u-resetBtn').hidden = !(state.sortKey === 'default' && state.customOrder.length)

    document.querySelectorAll('.u-segmented button').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === state.view)
    })
  }

  /* ---------- 事件（委托在 #u-content 上） ---------- */
  const content = $('#u-content')

  content.addEventListener('click', (e) => {
    // 表头排序
    const th = e.target.closest('th.u-sortable')
    if (th) {
      setSort(th.dataset.sort)
      return
    }
    // 卡片上移 / 下移
    const mini = e.target.closest('.u-mini[data-move]')
    if (mini && !mini.disabled) {
      moveApp(mini.dataset.id, Number(mini.dataset.move))
      return
    }
    // 复制目录
    const dir = e.target.closest('.u-dir[data-copy]')
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
    const grip = e.target.closest('.u-grip')
    if (!grip) return
    const row = grip.closest('tr')
    const card = grip.closest('.u-card')
    if (row) {
      state.dragId = row.dataset.id
      row.classList.add('u-dragging')
    } else if (card) {
      state.dragIdx = Number(card.dataset.idx)
      card.classList.add('u-dragging')
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
    content.querySelectorAll('.u-dragging').forEach((el) => el.classList.remove('u-dragging'))
  })

  content.addEventListener('dragover', (e) => {
    if (state.dragId || state.dragIdx >= 0) e.preventDefault()
  })

  content.addEventListener('drop', (e) => {
    if (state.dragId) {
      const row = e.target.closest('tr[data-id]')
      const from = state.dragId
      state.dragId = ''
      content.querySelectorAll('.u-dragging').forEach((el) => el.classList.remove('u-dragging'))
      if (row && row.dataset.id !== from) onDropRow(from, row.dataset.id)
    } else if (state.dragIdx >= 0) {
      const card = e.target.closest('.u-card')
      const from = state.dragIdx
      state.dragIdx = -1
      content.querySelectorAll('.u-dragging').forEach((el) => el.classList.remove('u-dragging'))
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

  document.querySelectorAll('.u-segmented button').forEach((btn) => {
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
    btn.classList.add('u-syncing')
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
      btn.classList.remove('u-syncing')
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
