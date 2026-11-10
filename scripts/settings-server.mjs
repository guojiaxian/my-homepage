#!/usr/bin/env node
/**
 * 设置服务：首页设置面板的读写后端（零依赖）。
 *
 * 仅监听 127.0.0.1，由 nginx 将 /api/ 反代到本服务（局域网经 80 端口可达）。
 *
 * 路由：
 *   GET  /api/config  读取 scripts/apps.config.json（apps + remoteApps + page）
 *   POST /api/config  校验并原子写入配置（原文件备份为 .bak），随后后台运行一次
 *                     探测脚本（--no-fetch）使改动尽快反映到前端；响应立即返回
 *   GET  /api/healthz 存活检查
 *
 * 写入仅限配置文件本身，不执行任何 shell、不触碰 /root/applications。
 *
 * 方向二同步（监控中心 → 应用中心）：监听 scripts/monitor.config.json，
 * 对勾选 appSync 的主机自动在 remoteApps[] 创建/更新同 id 的远程应用；
 * 中断（读写竞态/并发冲突）时按退避间隔自动重试。
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, watch } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(__dirname, 'apps.config.json')
const MONITOR_CONFIG_FILE = path.join(__dirname, 'monitor.config.json')
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

/** 校验并规范化前端提交的配置，只保留已知字段 */
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
    if (a?.exclude) out.exclude = true
    if (str(a?.name)) out.name = str(a?.name)
    if (str(a?.description)) out.description = str(a?.description)
    return out
  })

  const remoteApps = (Array.isArray(body.remoteApps) ? body.remoteApps : []).map((a) => {
    const id = str(a?.id)
    if (!id) throw new Error('存在缺少 id 的远程应用条目')
    if (seen.has(id)) throw new Error(`应用 id 重复：${id}`)
    seen.add(id)
    const healthUrl = str(a?.healthUrl)
    let u
    try {
      u = new URL(healthUrl)
    } catch {
      throw new Error(`远程应用 ${id} 的 healthUrl 不是合法 URL`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`远程应用 ${id} 的 healthUrl 必须是 http/https`)
    }
    const out = {
      id,
      healthUrl,
      kinds: normKinds(a?.kinds, ['web']),
      env: a?.env === 'lan' ? 'lan' : 'public',
      github: str(a?.github),
      tags: tagArr(a?.tags),
      icon: str(a?.icon) || '☁️',
      location: str(a?.location) || '远程',
      host: str(a?.host) || u.hostname,
    }
    if (tagArr(a?.languages).length) out.languages = tagArr(a.languages)
    if (tagArr(a?.frontend).length) out.frontend = tagArr(a.frontend)
    if (tagArr(a?.backend).length) out.backend = tagArr(a.backend)
    if (str(a?.url)) out.url = str(a?.url)
    if (str(a?.name)) out.name = str(a?.name)
    if (str(a?.description)) out.description = str(a?.description)
    // 外机项目目录 git 检查（可选）：配置 gitDir 才对该机做远程 git 同步检测
    if (str(a?.gitDir)) out.gitDir = str(a.gitDir)
    if (str(a?.gitSsh)) out.gitSsh = str(a.gitSsh)
    if (str(a?.gitKey)) out.gitKey = str(a.gitKey)
    // 双向同步标记：monitorSync = 同步到监控中心（方向一，monitor-server 消费）；
    // syncSource = 条目来源（monitor = 方向二由监控主机创建），两者都随保存保留
    if (a?.monitorSync) out.monitorSync = true
    if (a?.syncSource === 'monitor') out.syncSource = a.syncSource
    return out
  })

  const page = {
    siteName: str(body?.page?.siteName) || '我的应用导航',
    heroTitle: str(body?.page?.heroTitle) || '我的应用',
    heroSubtitle: str(body?.page?.heroSubtitle),
  }
  return { apps, remoteApps, page }
}

function readConfig() {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  return {
    $comment: raw.$comment ?? undefined,
    apps: raw.apps ?? [],
    remoteApps: raw.remoteApps ?? [],
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
 * 后台运行探测：接口立即返回。
 * - 保存配置：用 --no-fetch（本地核对约 0.3 秒），保证保存后页面快速生效；
 *   远端 fetch 校准仍由 5 分钟定时探测负责。
 * - 手动「立刻同步」：完整探测（含 git fetch），并发执行，通常约 6 秒。
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

/* ============================ 方向二：监控中心 → 应用中心 同步 ============================
   monitor.config.json 的 hosts[] 条目带 "appSync": true 时，自动在 remoteApps[] 创建/更新
   同 id 的远程应用（健康接口默认 http://<地址>/，env 按主机组公网/内网映射）。
   规则：
   · 勾选 appSync 的主机是共享字段（name/location/env/host）的唯一事实源，
     但应用若同时勾选了 monitorSync（应用侧为主），则跳过回写，只补建缺失条目；
   · 只创建与更新，从不删除：要移除请先在监控设置取消勾选，再在应用设置里删条目；
   · 应用地址变化时才重生成默认健康/访问地址，未变化时保留用户自定义的健康接口；
   · 无 diff 不写盘（防止与方向一互相触发形成回环）；
   · 单次同步因读写竞态/并发冲突中断时，由重试器按退避间隔自动重试。 */
function syncHostsToAppsOnce() {
  const monRaw = JSON.parse(readFileSync(MONITOR_CONFIG_FILE, 'utf8'))
  const appsRaw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  const list = Array.isArray(appsRaw.remoteApps) ? appsRaw.remoteApps : []
  let changed = false
  for (const h of (Array.isArray(monRaw.hosts) ? monRaw.hosts : [])) {
    if (!h || h.appSync !== true || h.type !== 'ssh') continue
    const id = String(h.id || '')
    const address = String(h.address || '')
    if (!id || !address) continue
    const env = /公网|public/i.test(String(h.group || '')) ? 'public' : 'lan'
    /* 配对：优先同 id；id 未见则按地址配对已有远程应用（真实场景应用 id 常与监控主机 id 不同）。
       monitorSync 应用由方向一回写（跳过防回环）；syncSource==='monitor' 的应用只认 id（不被其他主机地址抢占）。 */
    let idx = list.findIndex((a) => a && a.id === id)
    let viaAddress = false
    if (idx < 0) {
      const j = list.findIndex((a) => a && a.syncSource !== 'monitor' && a.monitorSync !== true && String(a.host || '') === address && address)
      if (j >= 0) { idx = j; viaAddress = true }
    }
    if (idx < 0) {
      list.push({
        id,
        name: String(h.name || id),
        description: '由监控中心同步创建的主机条目：健康探测默认走站点根路径，可在应用设置中修改健康接口。',
        healthUrl: `http://${address}/`,
        url: `http://${address}/`,
        location: String(h.group || (env === 'public' ? '公网' : '内网')),
        host: address,
        kinds: ['web'],
        env,
        icon: env === 'public' ? '☁️' : '🖥️',
        syncSource: 'monitor',
      })
      changed = true
      console.log('[settings] 已从监控中心同步创建远程应用:', id, '@', address)
    } else if (list[idx].monitorSync !== true) {
      const a = list[idx]
      const prevHost = String(a.host || '')
      const nextName = String(h.name || id)
      const nextLocation = String(h.group || '')
      if (a.name !== nextName || a.location !== nextLocation || a.env !== env || prevHost !== address) {
        a.name = nextName
        a.location = nextLocation
        a.env = env
        a.host = address
        if (prevHost !== address) {
          a.healthUrl = `http://${address}/`
          a.url = `http://${address}/`
        }
        changed = true
        console.log(viaAddress
          ? `[settings] 已按监控主机信息更新远程应用（按地址配对，主机 ${id} → 应用 ${a.id}）`
          : '[settings] 已按监控主机信息更新远程应用:', a.id)
      }
    }
  }
  if (changed) {
    // 展开原对象仅替换 remoteApps：保持 $comment 等顶层键的原有顺序，避免纯键序变化弄脏 diff
    writeConfig({ ...appsRaw, remoteApps: list })
    runProbe({ noFetch: true }) // 应用条目变化尽快反映到 apps.json（前端数据源）
  }
  return changed
}

/* 同步重试器：in-flight 期间的重复触发合并为一次（并发限制）；单次中断按
   10s/30s/60s/120s/120s 退避自动重试（最多 5 次）；新事件触发会重置退避立即执行。 */
function makeSyncRetryer(tag, fn) {
  const DELAYS = [10_000, 30_000, 60_000, 120_000, 120_000]
  let timer = null
  let attempt = 0
  let running = false
  let pendingAgain = false
  const run = () => {
    if (running) { pendingAgain = true; return }
    running = true
    try {
      fn()
      attempt = 0
    } catch (err) {
      if (attempt < DELAYS.length) {
        const delay = DELAYS[attempt++]
        console.error(`[settings][${tag}] 同步中断，${Math.round(delay / 1000)}s 后自动重试（${attempt}/${DELAYS.length}）：`, err.message)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { run() }, delay)
      } else {
        console.error(`[settings][${tag}] 同步连续 ${DELAYS.length} 次失败，本轮放弃（下次配置变更或重启后再试）：`, err.message)
        attempt = 0
      }
    } finally {
      running = false
      if (pendingAgain) { pendingAgain = false; run() }
    }
  }
  return () => { attempt = 0; if (timer) clearTimeout(timer); run() }
}
const syncHostsToApps = makeSyncRetryer('monitor→apps', syncHostsToAppsOnce)

/* 监听监控配置：勾选 appSync 的主机变化时同步到应用中心（600ms 防抖，与热加载节奏一致） */
try {
  const monName = path.basename(MONITOR_CONFIG_FILE)
  let monWatchTimer = null
  watch(__dirname, (ev, fn) => {
    if (fn !== monName) return
    if (monWatchTimer) clearTimeout(monWatchTimer)
    monWatchTimer = setTimeout(() => { syncHostsToApps() }, 600)
  })
} catch (err) {
  console.error('[settings] fs.watch 不可用（方向二同步退化为仅启动时执行一次）：', err.message)
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
      // 保留顶层 $comment 说明文字
      try {
        const prev = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
        if (prev.$comment) next.$comment = prev.$comment
      } catch {
        /* 原文件缺失/损坏时不阻塞保存 */
      }
      writeConfig(next)
      // 探测转后台执行：保存立即返回，前端轮询 apps.json 感知更新
      runProbe({ noFetch: true })
      syncHostsToApps() // 自愈：整表保存若覆盖掉 appSync 同步条目，立即补齐（无 diff 不写盘）
      send(res, 200, { ok: true, probeStarted: true })
      return
    }
    if (req.method === 'POST' && url === '/api/probe') {
      // 「立刻同步」：完整探测（含 git fetch）。startedAt 用服务端时钟，
      // 前端据此判断 apps.json 的 probedAt 是否已经更新。
      runProbe()
      send(res, 200, { ok: true, startedAt: Date.now() })
      return
    }
    send(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    send(res, 400, { ok: false, error: err.message })
  }
})

syncHostsToApps() // 启动时做一次方向二同步（自愈：补齐曾被整表保存覆盖掉的同步条目）

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[settings] listening on http://127.0.0.1:${PORT}  config=${CONFIG_FILE}`)
})
