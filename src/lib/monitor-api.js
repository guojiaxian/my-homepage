/* 监控中心 API 与格式化工具（供 MonitorView 系列组件共用） */

export async function monApi(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  })
  if (res.status === 401) {
    const err = new Error('未登录或会话已过期')
    err.authRequired = true
    throw err
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export const fmtMb = (v) =>
  v == null || !isFinite(v) ? '-' : v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v.toFixed(0) + ' MB'
export const fmtMbs = (v) => (v == null || !isFinite(v) ? '-' : v >= 100 ? v.toFixed(0) : v.toFixed(2))
export const fmtPct = (v) => (v == null || !isFinite(v) ? '-' : v >= 10 ? v.toFixed(0) : v.toFixed(1))
export function fmtUptime(s) {
  if (!s && s !== 0) return '-'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d} 天 ${h} 时` : h ? `${h} 时 ${m} 分` : `${m} 分`
}
export function fmtTime(iso) {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
  } catch {
    return iso
  }
}
