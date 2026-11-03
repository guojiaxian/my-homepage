#!/usr/bin/env node
/**
 * 设置服务：首页设置面板的读写后端（零依赖）。
 *
 * 仅监听 127.0.0.1，由 nginx 将 /api/ 反代到本服务（局域网经 80 端口可达）。
 *
 * 路由：
 *   GET  /api/config  读取 scripts/apps.config.json（apps + remoteApps + page）
 *   POST /api/config  校验并原子写入配置（原文件备份为 .bak），随后自动运行一次
 *                     探测脚本使改动立即反映到前端；响应包含探测输出
 *   GET  /api/healthz 存活检查
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
const KINDS = new Set(['web', 'app', 'miniapp'])
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
    if (str(a?.url)) out.url = str(a?.url)
    if (str(a?.name)) out.name = str(a?.name)
    if (str(a?.description)) out.description = str(a?.description)
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[settings] listening on http://127.0.0.1:${PORT}  config=${CONFIG_FILE}`)
})
