#!/usr/bin/env node
/**
 * 统一应用探测器 —— 应用中心与监控中心共用的唯一探测结果。
 *
 * 探测方式（目录自动发现，管理员在 monitor.config.json 的 hosts[].appRoot 为每台服务器指定探测根目录）：
 *   1. 读取 hosts 注册表：type=local 本机（直读文件系统）、type=ssh 远程/公网（每台一次 SSH 执行只读脚本）；
 *   2. 扫描 appRoot：目录自身含 .git / package.json 等应用标记 → 视为单一应用；
 *      否则每个一级子目录 = 一个应用；
 *   3. 归属端口/运行状态：本机解析 ss -tlnp + /proc/<pid>/cwd；远程在 SSH 脚本里跑 ss + readlink cwd，
 *      监听端口的属主进程 cwd（或任意进程 cwd）落在应用目录内即归属；
 *   4. git 同步检测：本机逐仓 fetch+status（--no-fetch 跳过）；远程与发现脚本同一条 SSH 跑完；
 *   5. 与 apps.config.json 的手工注解（名称/简介/图标/形式/技术栈/访问地址/隐藏等）按目录合并——
 *      注解只是元数据，应用清单完全由目录发现决定；新发现的目录自动出现在应用中心与监控中心
 *      （监控中心按 hostId 跟踪其目录，无需任何手工登记或双中心同步）。
 *
 * 用法：node scripts/probe-apps.mjs [--no-fetch]
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
const CONFIG_FILE = path.join(__dirname, 'apps.config.json') // 手工注解 + 页面文案（不再是清单来源）
const MONITOR_CONFIG_FILE = path.join(__dirname, 'monitor.config.json') // 主机注册表（含各机 appRoot）
// 生成结果同时写入仓库（下次构建的输入）与线上 webroot（免重建即时生效）
const OUTPUT_FILES = [
  path.join(REPO_ROOT, 'public/apps.json'),
  '/root/applications/my-homepage/www/apps.json',
]
const TCP_TIMEOUT_MS = 1500
const FETCH_CONCURRENCY = Math.max(1, Number(process.env.PROBE_FETCH_CONCURRENCY) || 6)
// 远程主机发现：每台一次 SSH（发现 + 端口归属 + 逐目录 git 一次跑完），并发默认 3；
// 连接失败 / 超时 / 输出中断按退避自动重试，仍失败该主机本轮输出空并记录错误
const REMOTE_HOST_CONCURRENCY = Math.max(1, Number(process.env.PROBE_REMOTE_GIT_CONCURRENCY) || 3)
const REMOTE_DISCOVER_TIMEOUT_FETCH_MS = 45_000
const REMOTE_DISCOVER_TIMEOUT_STATUS_MS = 20_000
const REMOTE_RETRY_DELAYS = [4_000, 10_000]
// 定时器可能同时触发"完整探测"和"快速探测"，用临时锁避免两个进程同时写 apps.json
const LOCK_FILE = path.join(os.tmpdir(), 'my-homepage-probe.lock')
const LOCK_STALE_MS = 5 * 60_000

// 应用标记文件：appRoot 自身带这些标记时视为单一应用（而不是应用容器目录）
const APP_MARKER_FILES = [
  '.git', 'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod',
  'build.gradle', 'build.gradle.kts', 'app.json', 'project.config.json',
]

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
const normDir = (p) => String(p || '').replace(/\/+$/, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

/* ---------------- 目录发现（本机） ---------------- */

function isAppMarkerDir(dir) {
  return APP_MARKER_FILES.some((m) => existsSync(path.join(dir, m)))
}

/** appRoot 自身是应用 → [appRoot]；否则每个一级子目录（跳过点目录）= 一个应用 */
function discoverLocalDirs(appRoot) {
  if (isAppMarkerDir(appRoot)) return [appRoot]
  const out = []
  for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    out.push(path.join(appRoot, entry.name))
  }
  return out.sort()
}

/* ---------------- 本机端口归属（ss + /proc） ---------------- */

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

function cwdUnderDir(cwd, dir) {
  return cwd === dir || (cwd && cwd.startsWith(dir + '/'))
}

/** 监听端口的属主进程工作目录：优先第一个可读 cwd，退回 cmdline 中提到的应用目录 */
function listenerOwnerCwd(listener, appDirs) {
  for (const pid of listener.pids) {
    const cwd = procCwd(pid)
    if (cwd) return cwd
  }
  for (const pid of listener.pids) {
    const cmd = procCmdline(pid)
    if (!cmd) continue
    const hit = appDirs.find((d) => cmd.includes(d + '/') || cmd.includes(d + ' '))
    if (hit) return hit
  }
  return null
}

/* ---------------- 端口连通性兜底（nginx 托管 / docker 等无进程归属场景） ---------------- */

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

/* ---------------- git 源码同步检测（本机） ---------------- */

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

/* ---------------- 远程主机发现（每台一次 SSH：目录 + 端口归属 + 逐目录 git） ---------------- */

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** 远程发现脚本（POSIX sh，只读；除远端机 .git 内的 FETCH_HEAD/refs 外不触碰任何文件）。
 *  输出全部用 @tag@ 行标记，Node 侧解析；输出缺 @end@ = 被中断 → 视为瞬态失败交由重试。 */
function buildRemoteDiscoverScript(appRoot, doFetch) {
  return [
    'ROOT=' + shQuote(appRoot),
    'FETCH=' + (doFetch ? 1 : 0),
    '[ -d "$ROOT" ] || { echo "@err@ 探测目录不存在"; echo "@end@"; exit 0; }',
    'echo "@root@ $ROOT"',
    'self=0',
    'for m in ' + APP_MARKER_FILES.map((m) => shQuote(m)).join(' ') + '; do',
    '  [ -e "$ROOT/$m" ] && self=1',
    'done',
    'echo "@self@ $self"',
    'APPS=""',
    'if [ "$self" = 1 ]; then',
    '  APPS="$ROOT"',
    'else',
    '  for d in "$ROOT"/*/; do',
    '    [ -d "$d" ] || continue',
    '    APPS="$APPS${d%/}\n"',
    '  done',
    'fi',
    'echo "@ports@"',
    'ss -tlnp 2>/dev/null | awk \'/^LISTEN/ { pid=""; s=$0; while (match(s,/pid=[0-9]+/)) { pid = pid (pid==""?"":",") substr(s,RSTART+4,RLENGTH-4); s=substr(s,RSTART+RLENGTH) } print "@port@ " $4 " " pid }\'',
    'for d in /proc/[0-9]*/cwd; do',
    '  pid=${d#/proc/}; pid=${pid%/cwd}',
    '  c=$(readlink "$d" 2>/dev/null) || continue',
    '  [ -n "$c" ] && echo "@cwd@ $pid $c"',
    'done',
    'printf \'%s\\n\' "$APPS" | while IFS= read -r a; do',
    '  [ -n "$a" ] || continue',
    '  echo "@appbegin@ $a"',
    '  if git -C "$a" rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
    '    b=$(git -C "$a" branch --show-current 2>/dev/null)',
    '    echo "@gitbranch@ $b"',
    '    echo "@gitrepo@ $(git -C "$a" config --get remote.origin.url 2>/dev/null)"',
    '    rn=$(git -C "$a" config --get "branch.$b.remote" 2>/dev/null)',
    '    [ -z "$rn" ] && rn=origin',
    '    if [ "$FETCH" = 0 ]; then',
    '      echo "@gitfetch@ skip"',
    '    elif [ "$rn" = "." ] || [ -z "$(git -C "$a" config --get remote.$rn.url 2>/dev/null)" ]; then',
    '      echo "@gitfetch@ none"',
    '    else',
    '      git -C "$a" --no-optional-locks -c gc.auto=0 fetch --quiet --no-tags --no-recurse-submodules "$rn" >/dev/null 2>&1',
    '      echo "@gitfetch@ $?"',
    '    fi',
    '    git -C "$a" status --porcelain=v1 2>/dev/null | sed \'s/^/@gitst@ /\'',
    '    git -C "$a" rev-list --left-right --count \'@{upstream}...HEAD\' 2>/dev/null | sed \'s/^/@gitcount@ /\'',
    '  else',
    '    echo "@gitnorepo@"',
    '  fi',
    '  echo "@append@"',
    'done',
    'echo "@end@"',
  ].join('\n')
}

/** 解析远程发现输出：{ dirs, ports, cwds, gitByDir }；输出被截断返回 null 交由重试 */
function parseRemoteDiscoverOutput(out) {
  const lines = out.split('\n')
  if (!lines.includes('@end@')) return null
  const res = { root: '', self: 0, dirs: [], ports: [], cwds: new Map(), gitByDir: new Map(), err: '' }
  let cur = null
  for (const line of lines) {
    if (line.startsWith('@err@ ')) { res.err = line.slice(6).trim(); continue }
    if (line.startsWith('@root@ ')) { res.root = line.slice(7).trim(); continue }
    if (line.startsWith('@self@ ')) { res.self = Number(line.slice(7).trim()) || 0; continue }
    if (line.startsWith('@port@ ')) {
      // 行格式：@port@ <本地地址:端口> <pid,pid,...>（ss -tlnp 的 LISTEN 行；多进程监听全部列出）
      const rest = line.slice(7).trim()
      const sp = rest.indexOf(' ')
      if (sp > 0) {
        const local = rest.slice(0, sp)
        const port = Number(local.slice(local.lastIndexOf(':') + 1))
        const pids = rest.slice(sp + 1).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
        if (Number.isInteger(port) && port > 0) res.ports.push({ port, pids, local })
      }
      continue
    }
    if (line.startsWith('@cwd@ ')) {
      const rest = line.slice(6)
      const sp = rest.indexOf(' ')
      if (sp > 0) res.cwds.set(Number(rest.slice(0, sp)), rest.slice(sp + 1).trim())
      continue
    }
    if (line.startsWith('@appbegin@ ')) {
      cur = { path: line.slice(11).trim(), branch: '', repo: '', fetch: 'skip', st: [], count: '', noRepo: false }
      res.dirs.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('@gitbranch@ ')) cur.branch = line.slice(12).trim()
    else if (line.startsWith('@gitrepo@ ')) cur.repo = line.slice(10).trim()
    else if (line.startsWith('@gitfetch@ ')) cur.fetch = line.slice(11).trim()
    else if (line.startsWith('@gitst@ ')) cur.st.push(line.slice(8))
    else if (line.startsWith('@gitcount@ ')) cur.count = line.slice(11).trim()
    else if (line.startsWith('@gitnorepo@')) cur.noRepo = true
    else if (line.startsWith('@append@')) cur = null
  }
  return res
}

function gitInfoFromDiscover(d, now, production) {
  if (d.noRepo) {
    return { status: 'no-repo', repo: '', branch: '', uncommitted: 0, untracked: 0, ahead: 0, behind: 0, remoteOk: null, checkedAt: now, message: '', ...(production ? { production: true } : {}) }
  }
  const info = {
    status: 'error',
    repo: d.repo ? normalizeRepo(d.repo) : '',
    branch: d.branch || '',
    uncommitted: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    remoteOk: null,
    checkedAt: now,
    message: '',
  }
  // fetch 值：0 成功 / none 未配置远端（视为成功）/ skip 快速探测免 fetch（remoteOk=null）
  info.remoteOk = d.fetch === 'skip' ? null : d.fetch === '0' || d.fetch === 'none'
  for (const s of d.st) {
    if (s.startsWith('?? ')) info.untracked++
    else info.uncommitted++
  }
  if (d.count) {
    const [behind, ahead] = d.count.split(/\s+/)
    info.behind = Number(behind) || 0
    info.ahead = Number(ahead) || 0
  }
  if (info.uncommitted > 0) info.status = 'dirty'
  else if (info.ahead > 0) info.status = 'ahead'
  else if (info.behind > 0) info.status = 'behind'
  else if (info.untracked > 0) info.status = 'untracked'
  else if (!d.count) info.status = 'no-upstream'
  else info.status = 'synced'
  if (production) info.production = true
  return info
}

/** 探测日志里的 git 状态标签（本机 / 外机 / 线上机通用） */
function gitLogTag(g) {
  if (!g) return ''
  const prod = g.production === true
  const n = g.uncommitted || g.ahead || g.behind || g.untracked
  if (['dirty', 'ahead', 'behind', 'untracked'].includes(g.status)) {
    const label = prod
      ? { dirty: '线上已改', ahead: '线上提交未推送', behind: '可拉取', untracked: '未跟踪' }[g.status]
      : { dirty: '未提交', ahead: '未推送', behind: '未拉取', untracked: '未跟踪' }[g.status]
    return `  [git ${label}×${n}]`
  }
  return `  [git ${g.status === 'synced' ? (prod ? '线上已同步' : '已同步') : g.status === 'no-repo' ? '无仓库' : g.status === 'no-upstream' ? '未关联远端' : '检查失败'}]`
}

/** 远程发现失败的简短原因（避免把整条 ssh 命令行打进日志/提示） */
function remoteDiscoverErr(err, doFetch) {
  if (err?.killed) return `超时（>${Math.round((doFetch ? REMOTE_DISCOVER_TIMEOUT_FETCH_MS : REMOTE_DISCOVER_TIMEOUT_STATUS_MS) / 1000)}s）`
  const lines = String(err?.stderr || '').split('\n').map((s) => s.trim()).filter(Boolean)
  const line = lines.find((l) => !/^warning:/i.test(l)) || lines[0]
  return (line || `SSH 连接失败（exit ${err?.code ?? '?'}）`).slice(0, 120)
}

/** 组装单台远程主机的 ssh 命令参数（复用监控主机自己的连接配置；密钥认证） */
function remoteSshArgs(host) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPersist=120',
    '-o', 'ControlPath=/tmp/my-homepage-ssh-%C',
    '-p', String(host.port || 22),
  ]
  if (host.authType === 'key' && host.keyPath && existsSync(host.keyPath)) {
    args.push('-i', host.keyPath, '-o', 'IdentitiesOnly=yes')
  }
  args.push('--', `${host.username || 'root'}@${host.address}`)
  return args
}

/** 带退避重试的远程主机发现：连接失败/超时/输出中断自动重试，仍失败返回 { error } */
async function discoverRemoteHost(host, doFetch, now) {
  if (host.authType === 'password') {
    return { error: '该主机使用密码认证，自动探测需要密钥（BatchMode）；请在监控设置改为密钥认证' }
  }
  const attempts = REMOTE_RETRY_DELAYS.length + 1
  let lastErr = ''
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const delay = REMOTE_RETRY_DELAYS[Math.min(attempt - 1, REMOTE_RETRY_DELAYS.length - 1)]
      console.log(`[probe] 远程发现 ${host.id} 失败：${lastErr}，${Math.round(delay / 1000)}s 后自动重试（${attempt + 1}/${attempts}）`)
      await sleep(delay)
    }
    try {
      const args = remoteSshArgs(host)
      args.push(buildRemoteDiscoverScript(host.appRoot, doFetch))
      const { stdout } = await execFileAsync('ssh', args, {
        timeout: doFetch ? REMOTE_DISCOVER_TIMEOUT_FETCH_MS : REMOTE_DISCOVER_TIMEOUT_STATUS_MS,
        encoding: 'utf8',
      })
      const parsed = parseRemoteDiscoverOutput(stdout)
      if (parsed) {
        if (attempt > 0) console.log(`[probe] 远程发现 ${host.id} 重试成功`)
        return parsed
      }
      lastErr = '输出不完整（连接中断或超时）'
    } catch (err) {
      lastErr = remoteDiscoverErr(err, doFetch)
    }
  }
  console.log(`[probe] 远程发现 ${host.id} 重试 ${attempts} 次均失败，本轮跳过该主机（下一轮探测自动再试）`)
  return { error: lastErr }
}

/* ---------------- 手工注解（apps.config.json：元数据与隐藏标记，不再是清单来源） ---------------- */

function buildAnnotationIndex(appsCfg) {
  const localByDir = new Map()
  for (const a of appsCfg.apps ?? []) {
    if (a?.directory) localByDir.set(normDir(a.directory), a)
  }
  const remoteList = []
  for (const a of appsCfg.remoteApps ?? []) {
    let hostAddr = String(a?.host || '')
    if (!hostAddr && a?.healthUrl) {
      try { hostAddr = new URL(a.healthUrl).hostname } catch { /* 忽略 */ }
    }
    remoteList.push({ meta: a, hostAddr: hostAddr || null })
  }
  return { localByDir, remoteList }
}

/** 为发现的应用目录匹配注解：本机按目录精确匹配；远程按 主机地址 + (gitDir/目录) 匹配 */
function matchAnnotation(index, dirPath, hostAddr) {
  const dir = normDir(dirPath)
  if (!hostAddr) return index.localByDir.get(dir) ?? null
  const base = path.basename(dir)
  let hit = index.remoteList.find(
    (r) => r.hostAddr === hostAddr && (normDir(r.meta?.gitDir) === dir || normDir(r.meta?.directory) === dir),
  )
  if (!hit) {
    hit = index.remoteList.find((r) => r.hostAddr === hostAddr && r.meta?.id === base)
  }
  return hit?.meta ?? null
}

/* ---------------- 互斥锁：避免完整探测与快速探测同时写 apps.json ---------------- */

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
  // 快速探测（--no-fetch）遇锁最多等 45 秒（设置面板保存触发的探测不应被一次长探测
  // 静默吞掉——等待通常足以轮到；完整探测最多等 60 秒）。仍等不到才跳过，等下轮定时器。
  const acquired = await acquireLock(NO_FETCH ? 45_000 : 60_000)
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
  const appsCfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  const monCfg = JSON.parse(readFileSync(MONITOR_CONFIG_FILE, 'utf8'))
  const hosts = (monCfg.hosts ?? []).filter((h) => h && h.id)
  const localHost = hosts.find((h) => h.type === 'local')
  const remoteHosts = hosts.filter((h) => h.type === 'ssh' && h.address)
  const index = buildAnnotationIndex(appsCfg)
  const now = new Date().toISOString()

  /** 主端口选择：expectedPort 锚定 → 最小对外端口 → 最小端口；附加端口只保留对外监听 */
  function pickPort(candidates, expectedPort) {
    if (!candidates.length) return { port: null, external: false, extraPorts: [] }
    const sorted = [...candidates].sort((a, b) => a.port - b.port)
    const expected = Number(expectedPort)
    const anchor = Number.isInteger(expected) ? sorted.find((p) => p.port === expected) : null
    const primary = anchor ?? sorted.find((p) => p.external) ?? sorted[0]
    return {
      port: primary.port,
      external: primary.external,
      extraPorts: sorted.filter((p) => p !== primary && p.external).map((p) => p.port),
    }
  }

  /** 由目录路径 + 注解 + 归属结果组装一个 apps.json 条目 */
  function buildEntry({ dirPath, host, meta, port, external, extraPorts, running, gitInfo, detected }) {
    const isRemote = host.type !== 'local'
    const hostAddr = isRemote ? host.address : ''
    const group = String(host.group || '内网')
    const env = isRemote ? (/公网|public/i.test(group) ? 'public' : 'lan') : 'lan'
    const configuredKinds = normKinds(meta?.kinds, ['web'])
    const kinds = [...new Set([...configuredKinds, ...(detected?.forms ?? []).filter((f) => f !== 'web')])]
    const hidden = Boolean(meta?.hidden || meta?.exclude)
    const appOnly = !kinds.includes('web')
    // 纯 APP / 小程序远程条目没有可访问网页：不要用端口拼出一个错误的本地链接
    const url = String(meta?.url || '').trim() || ''
    const dirName = path.basename(dirPath)
    return {
      id: meta?.id || dirName, // 全局唯一性在调用方统一处理
      hostId: host.id,
      hostName: host.name || host.id,
      hostGroup: group,
      name: String(meta?.name || '') || dirName,
      description: String(meta?.description || '') || '',
      directory: dirPath,
      port: appOnly ? null : port,
      expectedPort: meta?.expectedPort ?? null,
      extraPorts: appOnly ? [] : extraPorts,
      external: Boolean(external),
      status: running ? 'running' : 'down',
      kinds,
      env,
      https: Boolean(meta?.https),
      languages: pickList(meta?.languages, detected?.languages ?? []),
      frontend: pickList(meta?.frontend, detected?.frontend ?? []),
      backend: pickList(meta?.backend, detected?.backend ?? []),
      github: String(meta?.github || '') || '',
      tags: Array.isArray(meta?.tags) ? meta.tags : normList(meta?.tags),
      icon: String(meta?.icon || '') || (env === 'public' ? '☁️' : isRemote ? '🖥️' : '📦'),
      hidden,
      pending: !meta,
      remote: isRemote,
      ...(hostAddr ? { host: hostAddr } : {}),
      ...(isRemote ? { location: String(meta?.location || '').trim() || group } : {}),
      ...(appOnly ? { appOnly: true } : {}),
      ...(url ? { url } : {}),
      ...(gitInfo ? { git: gitInfo } : { git: null }),
    }
  }

  const results = []

  /* ---- 1) 本机主机：目录发现 + ss/proc 归属 + 技术栈识别 + 逐仓 git ---- */
  if (localHost) {
    const appRoot = normDir(localHost.appRoot) || '/root/applications'
    let dirs = []
    try {
      dirs = discoverLocalDirs(appRoot)
    } catch (err) {
      console.error(`[probe] 本机探测目录不可读（${appRoot}）：${err.message}`)
    }
    const listeners = parseSsListen()
    const listenerExternal = new Map(listeners.map((l) => [l.port, l.external]))
    // 端口 → 属主 cwd（第一个可读 cwd / cmdline 兜底）；仅当 cwd 落在某个发现的应用目录内才算真实归属
    const ownerCwd = new Map()
    for (const l of listeners) ownerCwd.set(l.port, listenerOwnerCwd(l, dirs))
    const attributed = new Map() // port -> dirPath（仅 cwd 命中应用目录的端口）
    for (const [port, cwd] of ownerCwd) {
      if (!cwd) continue
      const dir = dirs.find((d) => cwdUnderDir(cwd, d))
      if (dir) attributed.set(port, dir)
    }

    for (const dir of dirs) {
      const meta = index.localByDir.get(dir) ?? null
      const detected = (() => { try { return detectStack(dir) } catch { return null } })()
      const configuredKinds = normKinds(meta?.kinds, null)
      const kinds = [...new Set([...(configuredKinds ?? []), ...(detected?.forms ?? []).filter((f) => f !== 'web')])]
      const appOnly = configuredKinds ? !kinds.includes('web') : false // 未注解目录默认按 Web 探测

      const candidates = []
      for (const [port, d] of attributed) {
        if (d === dir) candidates.push({ port, external: listenerExternal.get(port) ?? false })
      }
      const expected = Number(meta?.expectedPort)
      // expectedPort 已被其他应用目录的进程归属时不认领，避免错误抢端口
      const expectedOwnedByOther = Number.isInteger(expected)
        && attributed.has(expected) && attributed.get(expected) !== dir
      let port = null, external = false, extraPorts = [], running = false
      if (appOnly) {
        // 离线应用（纯 APP / 小程序 / 电视 / CLI）：不做端口探测
      } else if (Number.isInteger(expected) && !expectedOwnedByOther && listenerExternal.has(expected)
        && !candidates.some((c) => c.port === expected)) {
        // expectedPort 优先锚定：目录内可能挂着附属进程（如本站的监控网关 8301，cwd 会被误命中），
        // 而真正对外服务的入口（nginx :80）往往没有可归属的进程 —— 只要 expectedPort 正在监听
        // 且不归属其他应用，就优先作为主端口（与本目录已归属端口一并计入附加端口）
        port = expected
        external = listenerExternal.get(expected) ?? false
        extraPorts = candidates.filter((c) => c.external).map((c) => c.port)
        running = true
      } else if (candidates.length) {
        const picked = pickPort(candidates, meta?.expectedPort)
        port = picked.port; external = picked.external; extraPorts = picked.extraPorts
        running = true
      } else {
        // 兜底：进程匹配不到（nginx 托管、docker 等）→ 探 expectedPort TCP 连通性
        if (Number.isInteger(expected) && !expectedOwnedByOther
          && (listenerExternal.has(expected) || (await tcpProbe(expected)))) {
          port = expected
          external = listenerExternal.get(expected) ?? false
          running = true
        }
      }

      results.push(buildEntry({
        dirPath: dir, host: localHost, meta, port, external, extraPorts, running,
        gitInfo: null, detected: appOnly ? detected : detected, // 形式识别始终运行（含离线应用）
        // git 在后文统一填充（依赖 remoteOkMap）
      }))
      results[results.length - 1]._localDir = dir
      results[results.length - 1]._localAppOnly = appOnly
    }
  }

  /* ---- 2) 远程主机（外机 / 公网）：每台一次 SSH 发现 ---- */
  const remoteDiscoveries = new Map() // host.id -> parsed | { error }
  if (remoteHosts.length) {
    const started = Date.now()
    const jobs = remoteHosts.filter((h) => normDir(h.appRoot))
    const outcomes = await mapLimit(jobs, REMOTE_HOST_CONCURRENCY, (h) => discoverRemoteHost(h, !NO_FETCH, now))
    jobs.forEach((h, i) => remoteDiscoveries.set(h.id, outcomes[i]))
    const skipped = remoteHosts.length - jobs.length
    console.log(
      `[probe] 远程发现 ${jobs.length} 台（并发 ${Math.min(REMOTE_HOST_CONCURRENCY, jobs.length)}）${skipped ? `，跳过 ${skipped} 台（未设置 appRoot）` : ''}，用时 ${Date.now() - started}ms`,
    )
  }

  for (const host of remoteHosts) {
    const disc = remoteDiscoveries.get(host.id)
    if (!disc) continue
    if (disc.error) {
      console.log(`  - ✖ ${host.id}（${host.address}）发现失败：${disc.error}`)
      continue
    }
    const production = /公网|public/i.test(String(host.group || ''))
    const cwds = disc.cwds
    // 端口 → 归属目录（任一属主进程 cwd 命中）
    const attributed = new Map() // port -> dirPath
    const portExternal = new Map()
    for (const p of disc.ports) {
      const addr = p.local.slice(0, p.local.lastIndexOf(':'))
      portExternal.set(p.port, addr === '0.0.0.0' || addr === '[::]' || addr === '*' || addr === '::')
      if (attributed.has(p.port)) continue
      const hit = disc.dirs.find((d) => p.pids.some((pid) => {
        const cwd = cwds.get(pid)
        return cwd && cwdUnderDir(cwd, d.path)
      }))
      if (hit) attributed.set(p.port, hit.path)
    }
    for (const d of disc.dirs) {
      const meta = matchAnnotation(index, d.path, host.address)
      const candidates = []
      for (const [port, dirPath] of attributed) {
        if (dirPath === d.path) candidates.push({ port, external: portExternal.get(port) ?? false })
      }
      // 远程应用把注解访问地址的端口视作期望端口锚定：对外入口常由 nginx 等托管（无进程 cwd 归属），
      // 仅按 cwd 归属会选到仅本机的后端端口（如 Flask 127.0.0.1:5000 而非 nginx :80）
      let expected = Number(meta?.expectedPort)
      if (!Number.isInteger(expected) && meta?.url) {
        try {
          const u = new URL(String(meta.url))
          expected = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
        } catch { /* 忽略 */ }
      }
      const expectedOwnedByOther = Number.isInteger(expected)
        && attributed.has(expected) && attributed.get(expected) !== d.path
      const running = [...cwds.values()].some((cwd) => cwdUnderDir(cwd, d.path)) || candidates.length > 0
      let picked
      if (Number.isInteger(expected) && !expectedOwnedByOther
        && disc.ports.some((p) => p.port === expected)
        && !candidates.some((c) => c.port === expected)) {
        picked = {
          port: expected,
          external: portExternal.get(expected) ?? true,
          extraPorts: candidates.filter((c) => c.external).map((c) => c.port),
        }
      } else {
        picked = pickPort(candidates, expected)
        // 没有归属端口也没有可锚定的期望端口时保持空（避免 ":—" 由前端兜底）
      }
      const detected = null // 远程目录不做技术栈识别（无本地文件系统），以注解为准
      results.push(buildEntry({
        dirPath: d.path, host, meta,
        port: picked.port, external: picked.external, extraPorts: picked.extraPorts,
        running, gitInfo: gitInfoFromDiscover(d, now, production), detected,
      }))
    }
  }

  /* ---- 3) id 全局唯一化（跨主机目录同名时加主机前缀） ---- */
  const seenIds = new Map()
  for (const r of results) {
    if (seenIds.has(r.id)) {
      const n = seenIds.get(r.id) + 1
      seenIds.set(r.id, n)
      r.id = `${r.hostId}-${r.id}`
    } else {
      seenIds.set(r.id, 1)
    }
  }

  /* ---- 4) 本机 git 同步检测：并发 fetch 校准（--no-fetch 跳过网络），再逐仓核对 ---- */
  const localDirs = [...new Set(results.filter((r) => r._localDir).map((r) => r._localDir))]
    .filter((d) => existsSync(path.join(d, '.git')))
  const remoteOkMap = new Map()
  if (localDirs.length) {
    if (NO_FETCH) {
      for (const d of localDirs) remoteOkMap.set(d, null) // 未知，沿用上次远端快照
    } else {
      const started = Date.now()
      const outcomes = await mapLimit(localDirs, FETCH_CONCURRENCY, fetchRepo)
      localDirs.forEach((d, i) => remoteOkMap.set(d, outcomes[i]))
      const failed = outcomes.filter((ok) => !ok).length
      console.log(
        `[probe] fetch ${localDirs.length} 个仓库，并发 ${Math.min(FETCH_CONCURRENCY, localDirs.length)}，用时 ${Date.now() - started}ms${failed ? `，失败 ${failed}` : ''}`,
      )
    }
    for (const r of results) {
      if (!r._localDir) continue
      // 离线应用同样参与 git 同步检查（有仓库时），只是不做端口探测
      r.git = gitSyncInfo(r._localDir, remoteOkMap.get(r._localDir) ?? null, now)
    }
  }

  /* ---- 5) 全局默认顺序 + github 兜底 ---- */
  if (Array.isArray(appsCfg.order) && appsCfg.order.length) {
    const rank = new Map(appsCfg.order.map((id, i) => [id, i]))
    results.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  }
  for (const r of results) {
    if (!r.github && r.git?.repo?.startsWith('github.com/')) {
      r.github = `https://${r.git.repo}`
    }
    delete r._localDir
    delete r._localAppOnly
  }

  /* ---- 6) 输出 ---- */
  // probedAt 取探测完成时刻而非开始时刻：前端「最后探测」显示的是数据真正就绪的时间
  const finishedAt = new Date().toISOString()
  const output = {
    probedAt: finishedAt,
    page: appsCfg.page ?? {},
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
    `[probe] ${finishedAt}  主机 ${hosts.length} 台，应用 ${results.length} 个（运行中 ${running}），git 同步 ${synced}/${gitCounted}，写入：${written.join(', ') || '（无，目标目录均不存在）'}`,
  )
  for (const r of results) {
    const hostTag = `[${r.hostId}]`
    if (r.appOnly) {
      console.log(`  - ○ ${hostTag} ${r.id}  [离线应用]${r.hidden ? '  [已隐藏]' : ''}${r.pending ? '  [待补充]' : ''}`)
      continue
    }
    const ports = [r.port, ...(r.extraPorts ?? [])].filter(Boolean)
    const suffix = r.status === 'running' && !r.external ? '（仅本机）' : ''
    console.log(
      `  - ${r.status === 'running' ? '●' : '○'} ${hostTag} ${r.id}  ${ports.join(', ') || '未监听'}${suffix}${gitLogTag(r.git)}${r.hidden ? '  [已隐藏]' : ''}${r.pending ? '  [待补充]' : ''}`,
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
