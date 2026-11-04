#!/usr/bin/env node
/**
 * 端口探测器：生成前端使用的 apps.json
 *
 * 原理：
 *   1. 解析 `ss -tlnp`，得到所有 TCP LISTEN 端口及其进程 PID；
 *   2. 读取 /proc/<pid>/cwd（cmdline 兜底），进程工作目录落在 /root/applications/<目录>
 *      内即认为该端口归属对应应用；
 *   3. 未通过进程匹配到端口的应用，退回用 net.connect 探测 expectedPort 连通性；
 *   4. 监听进程位于 /root/applications/* 但未登记在 apps.config.json 的，
 *      自动生成「待补充」条目（新应用放入目录即可被自动发现）；
 *   5. 与手工维护的元数据合并，写入 public/apps.json 与线上 webroot。
 *
 * 用法：node scripts/probe-apps.mjs
 * 退出码：0 正常；1 探测失败（如 ss 不可用、配置非法）
 */
import { execFile, execFileSync } from 'node:child_process'
import {
  readFileSync,
  readlinkSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  statSync,
  readdirSync,
} from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const APPS_ROOT = '/root/applications'
const CONFIG_FILE = path.join(__dirname, 'apps.config.json')
// 生成结果同时写入仓库（下次构建的输入）与线上 webroot（免重建即时生效）
const OUTPUT_FILES = [
  path.join(REPO_ROOT, 'public/apps.json'),
  '/root/applications/my-homepage/www/apps.json',
]
const TCP_TIMEOUT_MS = 1500
const REMOTE_TIMEOUT_MS = 6000
const FETCH_CONCURRENCY = Math.max(1, Number(process.env.PROBE_FETCH_CONCURRENCY) || 6)
// 定时器可能同时触发"完整探测"和"快速探测"，用临时锁避免两个进程同时写 apps.json
const LOCK_FILE = path.join(os.tmpdir(), 'my-homepage-probe.lock')
const LOCK_STALE_MS = 5 * 60_000

// 应用形式：web / APP / 小程序 / 电视 / CLI，可多选
const APP_KINDS = new Set(['web', 'app', 'miniapp', 'tv', 'cli'])
const normKinds = (value, fallback) => {
  const list = (Array.isArray(value) ? value : []).filter((k) => APP_KINDS.has(k))
  const uniq = [...new Set(list)]
  return uniq.length ? uniq : fallback
}
const normList = (value) => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，]/) : []
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))]
}
const pickList = (configured, detected) => {
  const list = normList(configured)
  return list.length ? list : detected
}

/* ---------------- 技术栈自动识别（仅本机目录） ---------------- */

const STACK_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'data', 'logs', 'backups',
  '.venv', 'venv', '__pycache__', 'vendor',
])

function collectFiles(dir, exts, depth = 2, out = []) {
  if (depth < 0) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!STACK_SKIP_DIRS.has(entry.name)) collectFiles(full, exts, depth - 1, out)
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file))
  } catch {
    return null
  }
}

function readMany(files, limit = 30) {
  return files.slice(0, limit).map(readText).join('\n')
}

/** 从依赖清单与 README 推断应用形式 / 语言 / 前端 / 后端；识别不到的部分返回「无」 */
function detectStack(dir) {
  const pkgFiles = collectFiles(dir, ['package.json'], 2)
  const deps = {}
  for (const file of pkgFiles) {
    const pkg = readJson(file)
    if (pkg) Object.assign(deps, pkg.dependencies ?? {}, pkg.devDependencies ?? {})
  }
  const req = readText(path.join(dir, 'requirements.txt'))
  const pyproject = readText(path.join(dir, 'pyproject.toml'))
  const goMod = readText(path.join(dir, 'go.mod'))
  const gradle = ['build.gradle.kts', 'build.gradle', 'app/build.gradle.kts', 'app/build.gradle']
    .map((f) => readText(path.join(dir, f)))
    .join('\n')
  const appJson = readJson(path.join(dir, 'app.json'))
  const projectCfg = readText(path.join(dir, 'project.config.json'))
  const readme = readText(path.join(dir, 'README.md')).toLowerCase()
  const htmlFiles = collectFiles(dir, ['.html'], 2)
  const html = readMany(htmlFiles, 10).toLowerCase()
  const pyFiles = collectFiles(dir, ['.py'], 2)
  const pySourceFiles = pyFiles.filter((file) => {
    const rel = path.relative(dir, file).split(path.sep)
    const base = path.basename(file)
    return !rel.includes('tests')
      && !base.startsWith('test_')
      && !/^(lextab|yacctab|parsetab)\.py$/i.test(base)
      && !rel.some((seg) => seg.startsWith('dist'))
  })
  const pyText = readMany(pyFiles, 30).toLowerCase()
  const jsFiles = collectFiles(dir, ['.js', '.mjs'], 2)
  const serverFiles = [
    'server.js', 'server.mjs', 'server.ts', 'server/index.js', 'server/server.js',
    'server/main.py', 'run.py', 'main.py', 'app/main.py', 'app/api.py',
  ]
    .map((f) => path.join(dir, f))
    .filter(existsSync)
  const serverText = readMany(serverFiles, 10).toLowerCase()
  const hasDep = (name) => Object.prototype.hasOwnProperty.call(deps, name)
  const depVer = (name) => String(deps[name] ?? '')

  const forms = []
  const isMini = Boolean(appJson?.pages?.length && projectCfg)
  if (isMini) forms.push('miniapp')
  const isCapacitor = hasDep('@capacitor/core') || collectFiles(dir, ['capacitor.config.json'], 2).length > 0
  if (isCapacitor) forms.push('app')
  const isAndroid = /com\.android\.application/.test(gradle)
  if (isAndroid && !isCapacitor) {
    if (/android tv|小米电视|miui tv|遥控|tv show|电视/.test(readme)) forms.push('tv')
    else forms.push('app')
  }
  if (/\[project\.scripts\]/.test(pyproject) && !/fastapi|flask|django|express|fastify|koa/.test((req + pyproject).toLowerCase())) {
    forms.push('cli')
  }

  const languages = []
  if (req || pyproject || pySourceFiles.length) languages.push('Python')
  if (pkgFiles.length || jsFiles.length) languages.push('JavaScript')
  if (hasDep('typescript') || collectFiles(dir, ['.ts'], 2).length) languages.push('TypeScript')
  if (goMod) languages.push('Go')
  if (isAndroid && /kotlin/i.test(gradle)) languages.push('Kotlin')
  if (isMini) languages.push('WXML/WXSS')

  const frontend = []
  if (isMini) {
    frontend.push('微信小程序原生')
  } else if (isAndroid) {
    const extras = []
    if (/viewbinding/i.test(gradle)) extras.push('ViewBinding')
    if (/webview/.test(readme)) extras.push('WebView')
    frontend.push(`Android 原生 Kotlin${extras.length ? `（${extras.join(' + ')}）` : ''}`)
  } else if (hasDep('vue') || /vue\.global/.test(html)) {
    frontend.push(depVer('vue').startsWith('^2') || depVer('vue').startsWith('2') ? 'Vue 2' : 'Vue 3')
    if (hasDep('vite')) frontend.push('Vite')
    if (hasDep('echarts') || /echarts/.test(html)) frontend.push('ECharts')
    if (hasDep('bootstrap') || /bootstrap/.test(html)) frontend.push('Bootstrap')
    if (hasDep('chart.js') || /chart\.js/.test(html)) frontend.push('Chart.js')
  } else if (hasDep('react')) {
    frontend.push('React')
    if (hasDep('vite')) frontend.push('Vite')
  } else if (hasDep('svelte')) {
    frontend.push('Svelte')
  } else if (htmlFiles.length) {
    frontend.push('原生 HTML/CSS/JS')
  }
  if (isCapacitor && !frontend.length) frontend.push('原生 HTML/CSS/JS')
  if (!frontend.length) frontend.push('无')

  const backend = []
  if (hasDep('fastify')) backend.push('Fastify')
  else if (hasDep('express')) backend.push('Express')
  else if (hasDep('koa')) backend.push('Koa')
  else if (hasDep('hono')) backend.push('Hono')
  if (/fastapi/.test(req + pyproject + pyText)) backend.push('FastAPI')
  else if (/flask/.test(req + pyproject)) backend.push('Flask')
  else if (/django/.test(req + pyproject)) backend.push('Django')
  if (goMod) {
    if (/go-chi|chi\/v5/.test(goMod)) backend.push('Go + go-chi')
    else if (/gin-gonic/.test(goMod)) backend.push('Go + Gin')
    else if (/labstack\/echo/.test(goMod)) backend.push('Go + Echo')
    else backend.push('Go')
  }
  if (!backend.length && /http\.server/.test(pyText + serverText)) backend.push('Python 标准库 http.server')
  if (!backend.length && /node:http|node:https|require\('http'\)|require\('https'\)|require\("http"\)|require\("https"\)/.test(serverText)) {
    backend.push(/https/.test(serverText) ? 'Node.js 内置 https' : 'Node.js 内置 http')
  }
  if (backend.length && /node/i.test(backend.join(' ')) && pySourceFiles.length) backend.push('Python 采集脚本')
  if (!backend.length) backend.push('无')

  return {
    forms: [...new Set(forms)],
    languages: [...new Set(languages)],
    frontend: [...new Set(frontend)],
    backend: [...new Set(backend)],
  }
}

/* ---------------- 远程应用健康探查（云服务器等外部主机） ---------------- */

/**
 * 请求 healthUrl 并解析健康信息。在线判定：HTTP 2xx 且（若有 status 字段）值为 ok。
 * 返回 apps.json 的条目，remoteInfo 携带版本号、延迟、运行时长等明细。
 */
async function probeRemote(meta, now) {
  let base = meta.healthUrl
  let host = ''
  let port = null
  try {
    const u = new URL(meta.healthUrl)
    host = u.hostname
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    base = `${u.protocol}//${u.host}`
  } catch {
    /* healthUrl 非法时按原样使用 */
  }

  const info = {
    online: false,
    httpStatus: null,
    responseMs: null,
    version: null,
    dbReady: null,
    rssMb: null,
    uptimeSec: null,
    error: '',
    checkedAt: now,
  }
  const started = Date.now()
  try {
    const res = await fetch(meta.healthUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    })
    info.responseMs = Date.now() - started
    info.httpStatus = res.status
    let body = null
    try {
      body = await res.json()
    } catch {
      /* 非 JSON 响应按无 body 处理 */
    }
    info.version = body?.version ?? body?.data?.version ?? null
    info.dbReady = body?.dbReady ?? null
    info.rssMb = body?.rssMb ?? null
    info.uptimeSec = body?.uptimeSec ?? null
    info.online = res.ok && (!body?.status || body.status === 'ok')
    if (!res.ok) info.error = `HTTP ${res.status}`
    else if (body?.status && body.status !== 'ok') info.error = `status=${body.status}`
  } catch (err) {
    info.responseMs = Date.now() - started
    info.error = err?.name === 'TimeoutError' ? `超时（>${REMOTE_TIMEOUT_MS / 1000}s）` : String(err?.cause?.message ?? err.message ?? err).slice(0, 120)
  }

  return {
    id: meta.id,
    name: meta.name || meta.id,
    description: meta.description || '',
    directory: null,
    port,
    expectedPort: null,
    extraPorts: [],
    external: true,
    status: info.online ? 'running' : 'down',
    kinds: normKinds(meta.kinds, ['web']),
    env: meta.env === 'lan' ? 'lan' : 'public',
    languages: normList(meta.languages),
    frontend: normList(meta.frontend),
    backend: normList(meta.backend),
    github: meta.github || '',
    tags: meta.tags || [],
    icon: meta.icon || '☁️',
    pending: false,
    remote: true,
    url: meta.url || base,
    location: meta.location || '远程',
    host: meta.host || host,
    remoteInfo: info,
  }
}

/* ---------------- git 源码同步检测 ---------------- */

const GIT_TIMEOUT_MS = 10_000
const FETCH_TIMEOUT_MS = 20_000
// BatchMode 禁止交互输密码（无密钥时快速失败）；ConnectTimeout 限制 TCP 连接时长；
// ControlMaster 让多个仓库复用同一条 SSH 连接，省掉重复握手
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND:
    'ssh -oBatchMode=yes -oConnectTimeout=8 -oStrictHostKeyChecking=accept-new ' +
    '-oControlMaster=auto -oControlPersist=60 -oControlPath=/tmp/my-homepage-ssh-%C',
}

function git(args, dir, timeout = GIT_TIMEOUT_MS) {
  return execFileSync('git', ['-C', dir, '--no-optional-locks', ...args], {
    encoding: 'utf8',
    timeout,
    env: GIT_ENV,
  })
}

/** git@github.com:owner/repo.git → github.com/owner/repo */
function normalizeRepo(url) {
  const ssh = url.match(/^(?:git@|ssh:\/\/git@)([^:]+):(.+?)(?:\.git)?$/)
  if (ssh) return `${ssh[1]}/${ssh[2]}`
  const https = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (https) return `${https[1]}/${https[2]}`
  return url
}

/** 并发池：最多 limit 个任务同时执行，保持结果顺序 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}

async function fetchRepo(dir) {
  let remote = ''
  try {
    // 只 fetch 当前分支所属的远端（通常是 origin），不再用 --all 扫所有远端；
    // --no-tags 跳过标签，ahead/behind 不依赖标签
    const branch = git(['branch', '--show-current'], dir).trim()
    if (branch) {
      try {
        remote = git(['config', '--get', `branch.${branch}.remote`], dir).trim()
      } catch {
        remote = ''
      }
    }
    if (!remote || remote === '.') {
      try {
        git(['remote', 'get-url', 'origin'], dir)
        remote = 'origin'
      } catch {
        remote = ''
      }
    }
  } catch {
    return false
  }
  if (!remote) return true // 没有远端，无需 fetch，仍算成功

  try {
    // gc.auto=0 禁止 fetch 触发自动 GC：除远端快照 refs/FETCH_HEAD 外不产生任何仓库整理动作
    await execFileAsync(
      'git',
      ['-C', dir, '--no-optional-locks', '-c', 'gc.auto=0', 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', remote],
      { env: GIT_ENV, timeout: FETCH_TIMEOUT_MS, encoding: 'utf8' },
    )
    return true
  } catch {
    return false
  }
}

const GIT_SHORT_ERR = (err) =>
  (err.message.split('\n').find((l) => /fatal|error|失败/i.test(l)) ?? err.message)
    .trim()
    .slice(0, 120)

/**
 * 检查单个应用目录的源码同步状态。
 * status 含义：
 *   synced      工作区干净且与远端一致
 *   dirty       有未提交的已跟踪文件修改（源码未进 git）
 *   ahead       本地有未推送提交
 *   behind      落后远端（未拉取）
 *   untracked   有未跟踪文件（未加入版本控制）
 *   no-repo     目录不是 git 仓库
 *   no-upstream 当前分支未关联远端分支，推送状态无法核对
 *   error       git 命令执行失败
 */
function gitSyncInfo(dir, remoteOk, now) {
  const info = {
    status: 'error',
    repo: '',
    branch: '',
    uncommitted: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    remoteOk,
    checkedAt: now,
    message: '',
  }
  try {
    if (!existsSync(path.join(dir, '.git'))) {
      info.status = 'no-repo'
      return info
    }
  } catch {
    return info
  }

  try {
    const url = git(['config', '--get', 'remote.origin.url'], dir).trim()
    info.repo = url ? normalizeRepo(url) : ''
    info.branch = git(['branch', '--show-current'], dir).trim()
    for (const line of git(['status', '--porcelain=v1'], dir).split('\n')) {
      if (!line) continue
      if (line.startsWith('?? ')) info.untracked++
      else info.uncommitted++
    }
  } catch (err) {
    info.message = GIT_SHORT_ERR(err)
    return info
  }

  // ahead/behind：优先分支上游，退回 origin/HEAD（克隆时自动生成）
  let hasUpstream = false
  for (const ref of ['@{upstream}', 'origin/HEAD']) {
    try {
      const [behind, ahead] = git(['rev-list', '--left-right', '--count', `${ref}...HEAD`], dir)
        .trim()
        .split(/\s+/)
      info.behind = Number(behind) || 0
      info.ahead = Number(ahead) || 0
      hasUpstream = true
      break
    } catch {
      /* 尝试下一个引用 */
    }
  }

  if (info.uncommitted > 0) info.status = 'dirty'
  else if (info.ahead > 0) info.status = 'ahead'
  else if (info.behind > 0) info.status = 'behind'
  else if (info.untracked > 0) info.status = 'untracked'
  else if (!hasUpstream) info.status = 'no-upstream'
  else info.status = 'synced'
  return info
}

/* ---------------- ss 解析 ---------------- */

function parseSsListen() {
  let out
  try {
    out = execFileSync('ss', ['-tlnp'], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(`无法执行 ss -tlnp：${err.message}`)
  }

  // 形如：LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1596614,fd=21))
  const listeners = []
  for (const line of out.split('\n')) {
    if (!line.startsWith('LISTEN')) continue
    const cols = line.trim().split(/\s+/)
    const local = cols[3]
    if (!local) continue
    const portStr = local.slice(local.lastIndexOf(':') + 1)
    const port = Number(portStr)
    if (!Number.isInteger(port) || port <= 0) continue

    const addr = local.slice(0, local.lastIndexOf(':'))
    // 0.0.0.0 / [::] / * 均为对外监听；127.0.0.1、::1 为仅本机
    const external = addr === '0.0.0.0' || addr === '[::]' || addr === '*' || addr === '::'

    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))
    listeners.push({ port, external, pids })
  }
  return listeners
}

/* ---------------- 进程归属 ---------------- */

function procCwd(pid) {
  try {
    // 必须用 readlink：/proc/<pid>/cwd 是 magic symlink，readFileSync 会跟随它读目录内容而失败
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, { encoding: 'utf8' }).replace(/\0/g, ' ')
  } catch {
    return ''
  }
}

/** 进程是否属于 /root/applications 下的某个应用目录，返回目录名或 null */
function procAppDir(pid) {
  const cwd = procCwd(pid)
  const candidates = [cwd]
  const cmdline = procCmdline(pid)
  if (cmdline) candidates.push(cmdline)
  for (const cand of candidates) {
    if (!cand || !cand.startsWith(APPS_ROOT + '/')) continue
    const rest = cand.slice(APPS_ROOT.length + 1)
    const seg = rest.split('/')[0]
    if (seg) return seg
  }
  return null
}

/* ---------------- 端口连通性兜底 ---------------- */

function tcpProbe(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(TCP_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/* ---------------- 互斥锁：避免完整探测与快速探测同时写 apps.json ---------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

async function acquireLock(waitMs) {
  const deadline = Date.now() + waitMs
  while (true) {
    let fd = null
    try {
      fd = openSync(LOCK_FILE, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
      closeSync(fd)
      fd = null
      return true
    } catch (err) {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
        try { unlinkSync(LOCK_FILE) } catch { /* ignore */ }
        throw err
      }
      if (err.code !== 'EEXIST') throw err

      // 锁已存在：区分"正在运行"与"上次崩溃留下的陈旧锁"
      let stale = false
      try {
        const info = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
        stale = Date.now() - info.startedAt > LOCK_STALE_MS || !pidAlive(info.pid)
      } catch {
        try {
          stale = Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS
        } catch {
          stale = true
        }
      }
      if (stale) {
        try { unlinkSync(LOCK_FILE) } catch { /* ignore */ }
        continue
      }
      if (Date.now() >= deadline) return false
      await sleep(150)
    }
  }
}

function releaseLock() {
  try {
    const info = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
    if (info.pid === process.pid) unlinkSync(LOCK_FILE)
  } catch {
    /* 锁不存在或不是自己的，忽略 */
  }
}

process.on('exit', releaseLock)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    releaseLock()
    process.exit(0)
  })
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const NO_FETCH = process.argv.includes('--no-fetch')
  // 快速探测（--no-fetch）遇到锁直接跳过；完整探测最多等 60 秒
  const acquired = await acquireLock(NO_FETCH ? 0 : 60_000)
  if (!acquired) {
    console.log(`[probe] 另一个探测正在运行，跳过本次${NO_FETCH ? '（--no-fetch）' : ''}`)
    return
  }

  try {
    await runProbe(NO_FETCH)
  } finally {
    releaseLock()
  }
}

async function runProbe(NO_FETCH) {
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  const metaById = new Map()
  for (const app of config.apps ?? []) {
    if (!app.id || !app.directory) {
      throw new Error(`apps.config.json 存在缺少 id/directory 的条目：${JSON.stringify(app)}`)
    }
    metaById.set(app.id, app)
  }
  // 标记 exclude 的应用不探测、不展示（如暂无可用 Web 服务的项目）
  const excludedDirs = new Set(
    (config.apps ?? []).filter((a) => a.exclude).map((a) => path.basename(a.directory)),
  )

  const listeners = parseSsListen()
  // 端口 → 是否对外监听（含无进程归属的端口，如 nginx 直接托管的本站 80）
  const listenerExternal = new Map()
  for (const l of listeners) {
    listenerExternal.set(l.port, (listenerExternal.get(l.port) ?? false) || l.external)
  }

  // 端口归属：port → { appDir, external }（同端口可能多 PID，取其一即可）
  const portOwner = new Map() // port -> { appDir, external }
  for (const l of listeners) {
    let owner = portOwner.get(l.port)
    for (const pid of l.pids) {
      const dir = procAppDir(pid)
      if (dir) {
        owner = { appDir: dir, external: owner?.external || l.external }
        break
      }
    }
    if (owner && !l.external) {
      // 全部命中进程但只有 loopback 监听时，保持 external=false
      const anyExternal = listeners.some(
        (x) => x.port === l.port && x.external,
      )
      if (!anyExternal) owner.external = false
    }
    if (owner && !portOwner.has(l.port)) portOwner.set(l.port, owner)
  }

  // 按应用聚合监听端口（保留每个端口自己的对外属性）
  const foundByApp = new Map() // appId -> { ports: [{ port, external }] }
  for (const [port, owner] of portOwner) {
    const rec = foundByApp.get(owner.appDir) ?? { ports: [] }
    rec.ports.push({ port, external: owner.external })
    foundByApp.set(owner.appDir, rec)
  }

  /**
   * 主端口选择：配置的 expectedPort 优先锚定（目录下可能有非 Web 的附属监听，
   * 如仅本机的 sshmockd）；否则优先最小的对外端口；全为仅本机时取最小值。
   */
  function pickPrimary(ports, expectedPort) {
    const sorted = [...ports].sort((a, b) => a.port - b.port)
    const expected = Number(expectedPort)
    const anchor = Number.isInteger(expected) ? sorted.find((p) => p.port === expected) : null
    const primary = anchor ?? sorted.find((p) => p.external) ?? sorted[0]
    return {
      primary,
      extraPorts: sorted.filter((p) => p !== primary).map((p) => p.port),
    }
  }

  const now = new Date().toISOString()
  const results = []
  const discovered = new Set()

  // 1) 已登记的应用
  for (const meta of config.apps ?? []) {
    if (meta.exclude) continue

    const configuredKinds = normKinds(meta.kinds, meta.type === 'app' ? ['app'] : ['web'])
    let detected = { forms: [], languages: [], frontend: [], backend: [] }
    try {
      detected = detectStack(meta.directory)
    } catch {
      /* 识别失败时保持空结果，不影响探测 */
    }
    const kinds = [...new Set([...configuredKinds, ...detected.forms.filter((f) => f !== 'web')])]
    const languages = pickList(meta.languages, detected.languages)
    const frontend = pickList(meta.frontend, detected.frontend)
    const backend = pickList(meta.backend, detected.backend)
    const env = meta.env === 'public' ? 'public' : 'lan'

    // 离线应用（纯 APP / 小程序，分类不含 web）：不做端口探测，
    // 状态显示灰色「离线应用」，不产生访问链接；分类含 web 则照常探测
    if (!kinds.includes('web')) {
      results.push({
        id: meta.id,
        name: meta.name || meta.id,
        description: meta.description || '',
        directory: meta.directory,
        port: null,
        expectedPort: meta.expectedPort ?? null,
        extraPorts: [],
        external: false,
        status: 'down',
        kinds,
        env,
        https: Boolean(meta.https),
        languages,
        frontend,
        backend,
        github: meta.github || '',
        tags: meta.tags || [],
        icon: meta.icon || '📱',
        pending: false,
        appOnly: true,
      })
      continue
    }

    const dirName = path.basename(meta.directory)
    const found = foundByApp.get(dirName)

    let port = null
    let external = false
    let status = 'down'
    let extraPorts = []

    if (found) {
      status = 'running'
      const { primary, extraPorts: rest } = pickPrimary(found.ports, meta.expectedPort)
      port = primary.port
      external = primary.external
      extraPorts = rest
    } else {
      // 兜底：进程匹配不到（如 nginx 托管的本站、docker 部署、无权限读 /proc），
      // 直接探 expectedPort；是否对外监听从 ss 端口表取，避免误标「仅本机」
      const expected = Number(meta.expectedPort)
      if (Number.isInteger(expected) && (await tcpProbe(expected))) {
        status = 'running'
        port = expected
        external = listenerExternal.get(expected) ?? false
      }
    }

    results.push({
      id: meta.id,
      name: meta.name || meta.id,
      description: meta.description || '',
      directory: meta.directory,
      port,
      expectedPort: meta.expectedPort ?? null,
      extraPorts,
      external,
      status,
      kinds,
      env,
      https: Boolean(meta.https),
      languages,
      frontend,
      backend,
      github: meta.github || '',
      tags: meta.tags || [],
      icon: meta.icon || '📦',
      pending: false,
    })
  }

  // 2) 自动发现未登记的应用
  const registeredDirs = new Set((config.apps ?? []).map((a) => path.basename(a.directory)))
  for (const [dirName, found] of foundByApp) {
    if (registeredDirs.has(dirName) || excludedDirs.has(dirName) || discovered.has(dirName)) continue
    discovered.add(dirName)
    const { primary, extraPorts: rest } = pickPrimary(found.ports, null)
    let detected = { forms: [], languages: [], frontend: [], backend: [] }
    try {
      detected = detectStack(`${APPS_ROOT}/${dirName}`)
    } catch {
      /* 识别失败时保持空结果 */
    }
    results.push({
      id: dirName,
      name: dirName,
      description: '（自动发现）该应用尚未在 scripts/apps.config.json 中登记，请补充名称、简介与 GitHub 地址。',
      directory: `${APPS_ROOT}/${dirName}`,
      port: primary.port,
      expectedPort: null,
      extraPorts: rest,
      external: primary.external,
      status: 'running',
      kinds: ['web', ...detected.forms.filter((f) => f !== 'web')],
      env: 'lan',
      https: false,
      languages: detected.languages,
      frontend: detected.frontend,
      backend: detected.backend,
      github: '',
      tags: [],
      icon: '🆕',
      pending: true,
    })
  }

  // 2.4) 远程应用（云服务器等）：HTTP 健康接口探查
  for (const meta of config.remoteApps ?? []) {
    if (!meta.id || !meta.healthUrl) {
      throw new Error(`remoteApps 存在缺少 id/healthUrl 的条目：${JSON.stringify(meta)}`)
    }
    results.push(await probeRemote(meta, now))
  }

  // 2.5) 全局默认顺序：配置 order 数组（id 列表）时按其排列，未列出的应用按原相对顺序排在后面
  if (Array.isArray(config.order) && config.order.length) {
    const rank = new Map(config.order.map((id, i) => [id, i]))
    results.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  }

  // 3) git 源码同步检测：先并发 fetch 校准远端快照（--no-fetch 跳过网络），再逐仓核对
  //    并发数可用 PROBE_FETCH_CONCURRENCY 覆盖（默认 6）；只 fetch 当前分支所属远端，不拉 tags
  const gitDirs = [...new Set(results.map((r) => r.directory).filter(Boolean))].filter((d) =>
    existsSync(path.join(d, '.git')),
  )
  const remoteOkMap = new Map()
  if (NO_FETCH) {
    for (const d of gitDirs) remoteOkMap.set(d, null) // 未知，沿用上次远端快照
  } else {
    const started = Date.now()
    const outcomes = await mapLimit(gitDirs, FETCH_CONCURRENCY, fetchRepo)
    gitDirs.forEach((d, i) => remoteOkMap.set(d, outcomes[i]))
    const failed = outcomes.filter((ok) => !ok).length
    console.log(
      `[probe] fetch ${gitDirs.length} 个仓库，并发 ${Math.min(FETCH_CONCURRENCY, gitDirs.length)}，用时 ${Date.now() - started}ms${failed ? `，失败 ${failed}` : ''}`,
    )
  }
  for (const r of results) {
    // 远程应用没有本地目录，不做 git 检查
    r.git = r.directory ? gitSyncInfo(r.directory, remoteOkMap.get(r.directory) ?? null, now) : null
    // 配置未填 github 时，用仓库远程地址兜底生成网页链接
    if (!r.github && r.git?.repo?.startsWith('github.com/')) {
      r.github = `https://${r.git.repo}`
    }
  }

  // 4) 输出（已登记在前，自动发现的在后，各自保持稳定顺序）
  // probedAt 取探测完成时刻而非开始时刻：前端「最后探测」显示的是数据真正就绪的时间
  const finishedAt = new Date().toISOString()
  const output = {
    probedAt: finishedAt,
    page: config.page ?? {},
    apps: results,
  }
  const body = JSON.stringify(output, null, 2) + '\n'
  let written = []
  for (const file of OUTPUT_FILES) {
    if (!existsSync(path.dirname(file))) continue
    writeFileSync(file, body, { encoding: 'utf8', mode: 0o644 })
    written.push(file)
  }

  const running = results.filter((a) => a.status === 'running').length
  const gitCounted = results.filter((a) => a.git).length
  const synced = results.filter((a) => a.git?.status === 'synced').length
  console.log(
    `[probe] ${finishedAt}  应用 ${results.length} 个（运行中 ${running}），git 同步 ${synced}/${gitCounted}，写入：${written.join(', ') || '（无，目标目录均不存在）'}`,
  )
  for (const r of results) {
    if (r.remote) {
      const info = r.remoteInfo ?? {}
      const ver = info.version ? ` v${info.version}` : ''
      const ms = info.responseMs != null ? ` ${info.responseMs}ms` : ''
      const err = info.error ? `（${info.error}）` : ''
      console.log(`  - ${r.status === 'running' ? '●' : '○'} ${r.id}  ${r.url}  ${r.status === 'running' ? '在线' : '离线'}${ver}${ms}${err}`)
      continue
    }
    if (r.appOnly) {
      console.log(`  - ○ ${r.id}  [离线应用]`)
      continue
    }
    const ports = [r.port, ...(r.extraPorts ?? [])].filter(Boolean)
    const suffix = r.status === 'running' && !r.external ? '（仅本机）' : ''
    let gitTag = ''
    if (r.git) {
      const g = r.git
      const n = g.uncommitted || g.ahead || g.behind || g.untracked
      gitTag = ['dirty', 'ahead', 'behind', 'untracked'].includes(g.status)
        ? `  [git 未同步·${g.status === 'dirty' ? '未提交' : g.status === 'ahead' ? '未推送' : g.status === 'behind' ? '未拉取' : '未跟踪'}×${n}]`
        : `  [git ${g.status === 'synced' ? '已同步' : g.status === 'no-repo' ? '无仓库' : g.status === 'no-upstream' ? '未关联远端' : '检查失败'}]`
    }
    console.log(
      `  - ${r.status === 'running' ? '●' : '○'} ${r.id}  ${ports.join(', ') || '未监听'}${suffix}${gitTag}${r.pending ? '  [待补充]' : ''}`,
    )
  }
  if (written.length === 0) {
    console.error('[probe] 警告：未写入任何文件（public/ 与 webroot 均不存在？）')
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[probe] 失败：', err.message)
  process.exit(1)
})
