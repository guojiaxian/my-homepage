#!/usr/bin/env node
/**
 * 设置服务：首页设置面板的读写后端（零依赖）。
 *
 * 仅监听 127.0.0.1，由 nginx 将 /api/ 反代到本服务（局域网经 80 端口可达）。
 *
 * 路由：
 *   GET  /api/config   读取 scripts/apps.config.json（手工注解 + 页面文案；应用清单由统一探测生成）
 *   POST /api/config   校验并原子写入注解配置（原文件备份为 .bak），随后后台运行一次统一探测
 *                      脚本（--no-fetch）使改动尽快反映到前端；响应立即返回
 *   POST /api/appmeta  设置面板/监控设置共用的单应用「前端隐藏」开关（按目录定位注解，无则创建）
 *   POST /api/probe    「立刻同步」：后台执行完整统一探测（含 git fetch），立即返回 {ok, startedAt}
 *   GET  /api/healthz  存活检查
 *
 * 应用清单的唯一来源是 probe-apps.mjs 的目录自动发现（monitor.config.json hosts[].appRoot），
 * 本文件维护的 apps[]/remoteApps[] 只是注解（名称/简介/形式/技术栈/访问地址/隐藏等），
 * 不再存在应用中心 ⇄ 监控中心的独立探测或双向同步。
 *
 * 写入仅限配置文件本身，不执行任何 shell、不触碰 /root/applications。
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(__dirname, 'apps.config.json')
const PROBE_SCRIPT = path.join(__dirname, 'probe-apps.mjs')
const PORT = Number(process.env.SETTINGS_PORT || 8300)
const BODY_LIMIT = 1024 * 1024 // 1MB

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const tagArr = (v) =>
  Array.isArray(v) ? v.map((t) => str(t)).filter(Boolean) : str(v).split(/[,，]/).map((t) => t.trim()).filter(Boolean)
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}
const KINDS = new Set(['web', 'app', 'miniapp', 'tv', 'cli'])
const normKinds = (v, fallback) => {
  const list = (Array.isArray(v) ? v : str(v).split(/[,，]/))
    .map((k) => str(k))
    .filter((k) => KINDS.has(k))
  const uniq = [...new Set(list)]
  return uniq.length ? uniq : fallback
}

/** 校验并规范化前端提交的注解配置，只保留已知字段 */
function sanitizeConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const seen = new Set()
  const apps = (Array.isArray(body.apps) ? body.apps : []).map((a) => {
    const id = str(a?.id)
    if (!id) throw new Error('存在缺少 id 的应用条目')
    if (seen.has(id)) throw new Error(`应用 id 重复：${id}`)
    seen.add(id)
    const directory = str(a?.directory) || `/root/applications/${id}`
    const out = {
      id,
      directory,
      expectedPort: numOrNull(a?.expectedPort),
      kinds: normKinds(a?.kinds, a?.type === 'app' ? ['app'] : ['web']),
      env: a?.env === 'public' ? 'public' : 'lan',
      github: str(a?.github),
      tags: tagArr(a?.tags),
      icon: str(a?.icon) || '📦',
    }
    if (a?.https) out.https = true
    if (tagArr(a?.languages).length) out.languages = tagArr(a.languages)
    if (tagArr(a?.frontend).length) out.frontend = tagArr(a.frontend)
    if (tagArr(a?.backend).length) out.backend = tagArr(a.backend)
    // 前端隐藏：仅影响展示，后端探测与监控照常进行（hidden 为新键，exclude 为旧键兼容）
    if (a?.hidden || a?.exclude) out.hidden = true
    if (str(a?.name)) out.name = str(a?.name)
    if (str(a?.description)) out.description = str(a?.description)
    return out
  })

  const remoteApps = (Array.isArray(body.remoteApps) ? body.remoteApps : []).map((a) => {
    const id = str(a?.id)
    if (!id) throw new Error('存在缺少 id 的远程应用条目')
    if (seen.has(id)) throw new Error(`应用 id 重复：${id}`)
    seen.add(id)
    // healthUrl 不再参与探测（清单来自目录发现），作为可选字段保留兼容
    const healthUrl = str(a?.healthUrl)
    if (healthUrl) {
      let u
      try {
        u = new URL(healthUrl)
      } catch {
        throw new Error(`远程应用 ${id} 的 healthUrl 不是合法 URL`)
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`远程应用 ${id} 的 healthUrl 必须是 http/https`)
      }
    }
    const out = {
      id,
      kinds: normKinds(a?.kinds, ['web']),
      env: a?.env === 'lan' ? 'lan' : 'public',
      github: str(a?.github),
      tags: tagArr(a?.tags),
      icon: str(a?.icon) || '☁️',
      host: str(a?.host),
    }
    if (healthUrl) out.healthUrl = healthUrl
    if (tagArr(a?.languages).length) out.languages = tagArr(a.languages)
    if (tagArr(a?.frontend).length) out.frontend = tagArr(a.frontend)
    if (tagArr(a?.backend).length) out.backend = tagArr(a.backend)
    if (str(a?.url)) out.url = str(a?.url)
    if (str(a?.directory)) out.directory = str(a.directory) // 外机应用目录（注解匹配键，探测自动发现）
    if (str(a?.gitDir)) out.gitDir = str(a.gitDir) // 旧字段兼容保留
    if (str(a?.location)) out.location = str(a.location)
    if (a?.hidden || a?.exclude) out.hidden = true
    if (str(a?.name)) out.name = str(a?.name)
    if (str(a?.description)) out.description = str(a?.description)
    return out
  })

  const page = {
    siteName: str(body?.page?.siteName) || '我的应用导航',
    heroTitle: str(body?.page?.heroTitle) || '我的应用',
    heroSubtitle: str(body?.page?.heroSubtitle),
  }
  const out = { apps, remoteApps, page }
  // 全局默认顺序（可选）：显式提交了合法数组才采纳，非法则丢弃（保存时另从原文件兜底保留）
  if (Array.isArray(body.order)) {
    const order = body.order.map(str).filter(Boolean)
    if (order.length) out.order = order
  }
  return out
}

function readConfig() {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  return {
    $comment: raw.$comment ?? undefined,
    apps: raw.apps ?? [],
    remoteApps: raw.remoteApps ?? [],
    order: raw.order ?? undefined,
    page: raw.page ?? { siteName: '我的应用导航', heroTitle: '我的应用', heroSubtitle: '' },
  }
}

function writeConfig(next) {
  // 原子写入：先写临时文件再 rename；原配置备份为 .bak
  if (existsSync(CONFIG_FILE)) copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak')
  const tmp = CONFIG_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 })
  renameSync(tmp, CONFIG_FILE)
}

/**
 * 后台运行统一探测：接口立即返回。
 * - 保存注解：用 --no-fetch（约 0.3 秒 + 远程快查），保证保存后页面快速生效；
 *   远端 fetch 校准仍由 5 分钟定时探测负责。
 * - 手动「立刻同步」：完整探测（含 git fetch），并发执行。
 */
function runProbe({ noFetch = false } = {}) {
  const args = [PROBE_SCRIPT]
  if (noFetch) args.push('--no-fetch')
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', (err) => console.error('[settings] 探测进程启动失败：', err.message))
  child.unref()
}

/** 单应用「前端隐藏」开关（应用中心设置与监控设置主机弹窗共用）：
 *  按目录定位注解条目（无则创建最小注解），仅写 hidden 标记，后端探测与监控不受影响。 */
function setAppHidden(body) {
  const directory = str(body?.directory)
  if (!directory || !directory.startsWith('/')) throw new Error('缺少有效的应用目录（directory）')
  const hidden = Boolean(body?.hidden)
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  const dir = directory.replace(/\/+$/, '')
  const hostAddr = str(body?.host)
  const base = path.basename(dir)
  let list = Array.isArray(raw.apps) ? raw.apps : []
  let entry = list.find((a) => a && str(a.directory).replace(/\/+$/, '') === dir)
  if (!entry && hostAddr) {
    list = Array.isArray(raw.remoteApps) ? raw.remoteApps : (raw.remoteApps = [])
    entry = list.find((a) => a && (str(a.directory).replace(/\/+$/, '') === dir || str(a.gitDir).replace(/\/+$/, '') === dir)
      && (str(a.host) === hostAddr || !str(a.host)))
  }
  if (!entry) {
    // 新发现的应用还没有任何注解：创建最小注解（探测会继续为未注解字段使用默认值）
    if (!Array.isArray(raw.apps)) raw.apps = []
    if (hostAddr) {
      if (!Array.isArray(raw.remoteApps)) raw.remoteApps = []
      entry = { id: base, name: base, host: hostAddr, directory: dir, kinds: ['web'] }
      raw.remoteApps.push(entry)
    } else {
      entry = { id: base, name: base, directory: dir, kinds: ['web'] }
      raw.apps.push(entry)
    }
  }
  if (hidden) entry.hidden = true
  else delete entry.hidden
  // 旧的 exclude 键语义已并入 hidden，顺手清掉避免歧义
  delete entry.exclude
  writeConfig(raw)
  runProbe({ noFetch: true }) // 尽快把 hidden 反映进 apps.json（前端展示过滤依据）
  return { id: entry.id, hidden }
}

/* 手动排序全局化（2026-11-12）：把浏览器里的拖拽/上下移动结果写入顶层 order，
   探测按其排序 apps.json —— 所有浏览器与静态端点看到同一顺序。
   order=[] / 缺省即清除（恢复探测默认顺序）；其余顶层键原样保留。 */
let orderProbeTimer = null
function setAppOrder(body) {
  const list = Array.isArray(body?.order) ? body.order.map(str).filter(Boolean) : null
  if (list === null) throw new Error('order 必须是应用 id 数组（空数组表示清除自定义顺序）')
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  if (list.length) raw.order = [...new Set(list)]
  else delete raw.order
  writeConfig(raw)
  // 连续拖拽会触发多次 POST：防抖后探测一次，保证读到的必然是最终顺序
  clearTimeout(orderProbeTimer)
  orderProbeTimer = setTimeout(() => runProbe({ noFetch: true }), 400)
  return { count: list.length }
}

function send(res, code, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0]
  try {
    if (req.method === 'GET' && (url === '/api/healthz' || url === '/api/health')) {
      send(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && url === '/api/config') {
      send(res, 200, readConfig())
      return
    }
    if (req.method === 'POST' && url === '/api/config') {
      const body = JSON.parse(await readBody(req))
      const next = sanitizeConfig(body)
      // 保留顶层 $comment 说明文字与未在本次请求中提交的 order（面板不感知该字段；
      // 请求体显式携带 order 键时以提交值为准——空数组即删除）
      try {
        const prev = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
        if (prev.$comment) next.$comment = prev.$comment
        if (body.order === undefined && next.order === undefined && Array.isArray(prev.order)) next.order = prev.order
      } catch {
        /* 原文件缺失/损坏时不阻塞保存 */
      }
      writeConfig(next)
      // 统一探测转后台执行：保存立即返回，前端轮询 apps.json 感知更新
      runProbe({ noFetch: true })
      // serverTime：前端保存后轮询 probedAt 用服务端时钟比较，避免浏览器时钟偏差导致白等
      send(res, 200, { ok: true, probeStarted: true, serverTime: Date.now() })
      return
    }
    if (req.method === 'POST' && url === '/api/appmeta') {
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        send(res, 403, { ok: false, error: 'missing X-Requested-With' })
        return
      }
      const body = JSON.parse(await readBody(req))
      const r = setAppHidden(body)
      send(res, 200, { ok: true, ...r })
      return
    }
    if (req.method === 'POST' && url === '/api/order') {
      // 手动排序写入全局 order（所有浏览器一致）；X-Requested-With 与 /api/appmeta 同款 CSRF 守卫
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        send(res, 403, { ok: false, error: 'missing X-Requested-With' })
        return
      }
      const body = JSON.parse(await readBody(req))
      const r = setAppOrder(body)
      send(res, 200, { ok: true, serverTime: Date.now(), ...r })
      return
    }
    if (req.method === 'POST' && url === '/api/probe') {
      // 「立刻同步」：完整统一探测（含 git fetch 与全部远程主机发现）。
      // startedAt 用服务端时钟，前端据此判断 apps.json 的 probedAt 是否已经更新。
      runProbe()
      send(res, 200, { ok: true, startedAt: Date.now() })
      return
    }
    send(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    send(res, 400, { ok: false, error: err.message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[settings] listening on http://127.0.0.1:${PORT}  config=${CONFIG_FILE}`)
})
