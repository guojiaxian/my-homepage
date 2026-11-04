/** 应用访问地址：远程应用用配置的完整 url，本地应用以当前页面的主机名 + 探测端口拼接 */
export function buildAppUrl(app, port = app.port) {
  if (app.url) return app.url
  if (!port) return ''
  const scheme = app.https ? 'https' : 'http'
  return `${scheme}://${window.location.hostname || 'localhost'}:${port}`
}

/** 秒数 → 「N 天 N 小时」可读文本 */
export function formatUptime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${m} 分`
  return `${m} 分钟`
}

/** 远程应用健康信息 → 悬停提示文本（无信息返回 ''） */
export function remoteHealthTitle(app) {
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

/** 状态分类：运行中（绿）/ 未运行（红）/ 线下应用（灰，纯 APP / 小程序不探测） */
export function statusText(app) {
  if (app.appOnly) return '线下应用'
  return app.status === 'running' ? '运行中' : '未运行'
}

/** 状态徽标样式：ok 绿 / down 红 / offline 灰 */
export function statusClass(app) {
  if (app.appOnly) return 'offline'
  return app.status === 'running' ? 'ok' : 'down'
}

/** 状态徽标悬停提示 */
export function statusTitle(app) {
  if (app.appOnly) return '线下应用：纯 APP / 小程序，无 Web 服务，不做端口探测'
  return remoteHealthTitle(app)
}

/** 应用形式标签：web / APP / 小程序 / 电视 / CLI，可多选 */
const KIND_LABELS = { web: 'Web', app: 'APP', miniapp: '小程序', tv: '电视', cli: 'CLI' }

/** 返回应用的分类列表 [{ value, label }]；旧数据没有 kinds 时按 appOnly 推断 */
export function kindList(app) {
  const list = Array.isArray(app.kinds) && app.kinds.length
    ? app.kinds
    : app.appOnly
      ? ['app']
      : ['web']
  return list
    .filter((k) => KIND_LABELS[k])
    .map((value) => ({ value, label: KIND_LABELS[value] }))
}

/** 技术栈摘要：语言 · 前端 · 后端（用于表格/卡片的一行展示） */
export function stackText(app) {
  return [
    (app.languages ?? []).join('/'),
    (app.frontend ?? []).join(' + '),
    (app.backend ?? []).join(' + '),
  ].filter(Boolean).join(' · ')
}

/** 技术栈完整提示（用于 title 悬停） */
export function stackTitle(app) {
  const parts = []
  if (app.languages?.length) parts.push(`语言：${app.languages.join('、')}`)
  if (app.frontend?.length) parts.push(`前端：${app.frontend.join('、')}`)
  if (app.backend?.length) parts.push(`后端：${app.backend.join('、')}`)
  return parts.join('；')
}

/** 部署位置：内网蓝色，公网橙色；优先使用配置的 env，旧数据回退到 remote */
export function envInfo(app) {
  const isPublic = app.env ? app.env === 'public' : Boolean(app.remote)
  return isPublic
    ? { cls: 'net', label: '公网', color: 'var(--amber)' }
    : { cls: 'lan', label: '内网', color: 'var(--accent)' }
}

/** 显示用端口文本：优先实际探测端口，未监听时展示期望端口 */
export function portText(app) {
  return app.port ?? app.expectedPort ?? '—'
}

/** 是否有可点击的访问地址（未监听时不可点） */
export function hasUrl(app) {
  return Boolean(app.port)
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 非安全上下文（http）下 clipboard API 不可用，退回 execCommand
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

/**
 * git 同步状态 → 展示用的 { text, cls, title }；无 git 信息时返回 null。
 * cls: ok（已同步）/ warn（可同步的差异）/ bad（源码未进 git）/ muted（无法核对）
 */
export function gitSyncView(git) {
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

  const detail = git.message
    ? git.message
    : counts.length
      ? counts.join(' · ')
      : `分支 ${branch} 与远端一致`
  const title = git.repo ? `${git.repo}（${branch}）：${detail}` : `分支 ${branch}：${detail}`
  return { ...view, title }
}
